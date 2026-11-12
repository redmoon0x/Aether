/**
 * Network capture → redacted HAR.
 *
 * Captures requests and responses while active and turns them into a HAR 1.2
 * log. Credential-bearing headers, query fields and body fields are replaced
 * with `[redacted]`, and any known site-secret value is scrubbed, so a HAR can
 * be read offline without leaking the user's credentials.
 */
import { promises as fs } from "fs";
import type { Page, Request } from "patchright-core";
import { SecretStore } from "./secrets";

const SENSITIVE_HEADERS = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-csrf-token",
    "x-xsrf-token",
]);

const SENSITIVE_PARAMS = new Set([
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "code",
    "password",
    "passwd",
    "secret",
    "api_key",
    "apikey",
    "key",
    "auth",
    "session",
]);

export interface HarHeader {
    name: string;
    value: string;
}

export interface HarEntry {
    startedDateTime: string;
    time: number;
    request: {
        method: string;
        url: string;
        httpVersion: string;
        headers: HarHeader[];
        queryString: Array<{ name: string; value: string }>;
        cookies: Array<{ name: string; value: string }>;
        postData?: { mimeType: string; text: string };
        headersSize: number;
        bodySize: number;
    };
    response: {
        status: number;
        statusText: string;
        httpVersion: string;
        headers: HarHeader[];
        cookies: Array<{ name: string; value: string }>;
        content: { size: number; mimeType: string; text?: string };
        redirectURL: string;
        headersSize: number;
        bodySize: number;
    };
    cache: Record<string, never>;
    timings: { send: number; wait: number; receive: number };
    _error?: string;
}

interface PendingCapture {
    entry: HarEntry;
    startedAt: number;
}

export function toHeaderList(headers: Record<string, string>): HarHeader[] {
    return Object.entries(headers).map(([name, value]) => ({
        name,
        value: SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value,
    }));
}

export function redactQuery(rawUrl: string): { url: string; queryString: Array<{ name: string; value: string }> } {
    try {
        const parsed = new URL(rawUrl);
        const queryString: Array<{ name: string; value: string }> = [];
        for (const [name, value] of parsed.searchParams.entries()) {
            const redacted = SENSITIVE_PARAMS.has(name.toLowerCase()) ? "[redacted]" : value;
            queryString.push({ name, value: redacted });
            if (redacted !== value) parsed.searchParams.set(name, redacted);
        }
        return { url: parsed.toString(), queryString };
    } catch {
        return { url: rawUrl, queryString: [] };
    }
}

export function redactBody(text: string, secrets: SecretStore): string {
    return secrets
        .redact(text)
        .replace(/("(?:password|passwd|token|secret|api_key|authorization)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
        .replace(/(password|passwd|token|secret|api_key|authorization)=([^&\s]+)/gi, "$1=[redacted]");
}

function placeholderEntry(request: Request, startedDateTime: string): HarEntry {
    const { url, queryString } = redactQuery(request.url());
    return {
        startedDateTime,
        time: 0,
        request: {
            method: request.method(),
            url,
            httpVersion: "HTTP/1.1",
            headers: [],
            queryString,
            cookies: [],
            headersSize: -1,
            bodySize: -1,
        },
        response: {
            status: 0,
            statusText: "",
            httpVersion: "HTTP/1.1",
            headers: [],
            cookies: [],
            content: { size: 0, mimeType: "" },
            redirectURL: "",
            headersSize: -1,
            bodySize: -1,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
    };
}

export class NetworkCapture {
    private readonly entries: HarEntry[] = [];
    private readonly pending = new Map<Request, PendingCapture>();
    private active = false;
    private readonly onRequest = (request: Request) => void this.captureRequest(request);
    private readonly onResponse = (response: any) => void this.captureResponse(response);
    private readonly onFailed = (request: Request) => this.finish(request, "request failed");

    constructor(private readonly page: Page, private readonly secrets: SecretStore) {}

    get isActive(): boolean {
        return this.active;
    }

    start(): void {
        if (this.active) return;
        this.active = true;
        this.page.on("request", this.onRequest);
        this.page.on("response", this.onResponse);
        this.page.on("requestfailed", this.onFailed);
    }

    async stop(outputPath?: string): Promise<{ entries: number; path?: string }> {
        if (this.active) {
            this.page.off("request", this.onRequest);
            this.page.off("response", this.onResponse);
            this.page.off("requestfailed", this.onFailed);
            this.active = false;
        }
        for (const [request] of [...this.pending]) this.finish(request, "capture stopped before a response");

        if (outputPath) {
            await fs.mkdir(require("path").dirname(outputPath), { recursive: true });
            await fs.writeFile(outputPath, JSON.stringify(this.toHar(), null, 2), "utf8");
            return { entries: this.entries.length, path: outputPath };
        }
        return { entries: this.entries.length };
    }

    status(): { active: boolean; entries: number } {
        return { active: this.active, entries: this.entries.length };
    }

    list(limit = 50): HarEntry[] {
        return this.entries.slice(-Math.max(1, limit));
    }

    toHar(): unknown {
        return {
            log: {
                version: "1.2",
                creator: { name: "Aether", version: "3.0.0" },
                entries: this.entries,
            },
        };
    }

    private async captureRequest(request: Request): Promise<void> {
        const entry = placeholderEntry(request, new Date().toISOString());
        try {
            entry.request.headers = toHeaderList(await request.allHeaders());
            const postData = request.postData();
            if (postData) {
                entry.request.postData = {
                    mimeType: (await request.allHeaders())["content-type"] ?? "application/octet-stream",
                    text: redactBody(postData, this.secrets),
                };
                entry.request.bodySize = postData.length;
            }
        } catch {
            // Headers unavailable: keep the URL and method.
        }
        this.pending.set(request, { entry, startedAt: Date.now() });
    }

    private async captureResponse(response: any): Promise<void> {
        const request = response.request() as Request;
        const pending = this.pending.get(request);
        if (!pending) return;
        try {
            pending.entry.response.status = response.status();
            pending.entry.response.statusText = response.statusText();
            pending.entry.response.redirectURL = response.headers()["location"] ?? "";
            pending.entry.response.headers = toHeaderList(await response.allHeaders());
            pending.entry.response.content.mimeType = response.headers()["content-type"] ?? "";

            const type = pending.entry.response.content.mimeType.toLowerCase();
            if (/json|text|xml|javascript|x-www-form-urlencoded/.test(type)) {
                const body = await response.text().catch(() => "");
                if (body) {
                    pending.entry.response.content.size = body.length;
                    pending.entry.response.content.text = redactBody(body.slice(0, 100_000), this.secrets);
                }
            }
        } catch {
            // Response body can be unavailable (redirect, download, aborted).
        }
        this.finish(request);
    }

    private finish(request: Request, error?: string): void {
        const pending = this.pending.get(request);
        if (!pending) return;
        this.pending.delete(request);
        pending.entry.time = Date.now() - pending.startedAt;
        if (error) pending.entry._error = error;
        this.entries.push(pending.entry);
        if (this.entries.length > 2000) this.entries.shift();
    }
}
