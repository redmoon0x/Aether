/**
 * `execute` — one tool call that runs a script against the page.
 *
 * The individual tools each cost a round trip, and every round trip can lose
 * transient state: an open menu, a hover, a half-filled form. This runs the
 * steps in one process, against the same Playwright page the tools use.
 *
 * The script gets real Playwright objects (`page`, `context`, `browser`) plus
 * agent helpers (`snapshot`, `ref`, `handoff`, `files`, `state`). It runs in a
 * restricted `vm` realm: no `process`, `require`, `import()`, `fs` or `os`.
 * That is isolation for globals, not a security boundary — page code is
 * untrusted, and scripts should treat it that way.
 */
import * as vm from "vm";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { PageHost, ScreenshotParams, SnapshotParams, SnapshotResult } from "./page";

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export interface ExecuteLogEntry {
    level: ConsoleLevel;
    text: string;
    at: number;
}

export interface ExecuteOptions {
    code: string;
    /** Total budget for the script. Default 60000; 0 disables. Handoff time is excluded. */
    timeoutMs?: number;
    sessionId?: string;
}

export interface ExecuteResult {
    session: string;
    value?: unknown;
    text: string;
    isError: boolean;
    logs: ExecuteLogEntry[];
    warnings: string[];
    durationMs: number;
    timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** Longest a single synchronous burst may run before it is stopped. */
const SYNC_SLICE_MS = 2_000;
const MAX_LOGS = 200;
const MAX_LOG_CHARS = 400;
const MAX_RESULT_CHARS = 120_000;

/** Values an agent keeps between execute calls, per session. */
const sessionState = new Map<string, Record<string, unknown>>();

function preview(value: unknown, limit: number = MAX_LOG_CHARS): string {
    if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…` : value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
        const text = JSON.stringify(value);
        if (text === undefined) return String(value);
        return text.length > limit ? `${text.slice(0, limit)}…` : text;
    } catch {
        return String(value);
    }
}

function makeConsole(logs: ExecuteLogEntry[]): Record<ConsoleLevel, (...args: unknown[]) => void> {
    const record = (level: ConsoleLevel) => (...args: unknown[]) => {
        if (logs.length >= MAX_LOGS) return;
        logs.push({ level, text: args.map((arg) => preview(arg)).join(" "), at: Date.now() });
    };
    return { log: record("log"), info: record("info"), warn: record("warn"), error: record("error"), debug: record("debug") };
}

function jsonSafe(value: unknown, warnings: string[]): unknown {
    const seen = new WeakSet<object>();
    const walk = (node: unknown): unknown => {
        if (node === null || typeof node === "string" || typeof node === "number" || typeof node === "boolean") return node;
        if (typeof node === "undefined") return null;
        if (typeof node === "bigint") return node.toString();
        if (typeof node === "function") return "[function]";
        if (typeof node === "symbol") return node.toString();
        if (node instanceof Error) return { name: node.name, message: node.message };
        if (typeof node === "object") {
            if (seen.has(node as object)) {
                warnings.push("The returned value contains a cycle; the repeated part was replaced with [circular].");
                return "[circular]";
            }
            seen.add(node as object);
            if (Array.isArray(node)) return node.map(walk);
            const out: Record<string, unknown> = {};
            for (const [key, entry] of Object.entries(node as Record<string, unknown>)) out[key] = walk(entry);
            return out;
        }
        return String(node);
    };
    return walk(value);
}

function renderResult(value: unknown, warnings: string[]): { value?: unknown; text: string; truncated: boolean } {
    if (value === undefined) return { text: "", truncated: false };
    let text: string;
    if (typeof value === "string") text = value;
    else text = JSON.stringify(jsonSafe(value, warnings), null, 2) ?? String(value);

    let truncated = false;
    if (text.length > MAX_RESULT_CHARS) {
        const cut = text.length - MAX_RESULT_CHARS;
        text = `${text.slice(0, MAX_RESULT_CHARS)}\n…[${cut} characters truncated]`;
        truncated = true;
    }
    return { value: typeof value === "string" ? value : jsonSafe(value, warnings), text, truncated };
}

function wrapCode(code: string): string {
    const trimmed = code.trim();
    const hasReturn = /\breturn\b/.test(trimmed);
    const body = !hasReturn && !trimmed.includes("\n") ? `return (${trimmed});` : trimmed;
    return `(async () => {\n${body}\n})()`;
}

/** A file helper rooted in one directory; paths cannot escape it. */
function makeFiles(root: string) {
    const resolve = (name: string) => {
        const absolute = path.resolve(root, name);
        if (absolute !== root && !absolute.startsWith(root + path.sep)) {
            throw new Error(`files: "${name}" is outside ${root}`);
        }
        return absolute;
    };
    return {
        dir: root,
        path: (name: string) => resolve(name),
        read: async (name: string, encoding?: "utf8") => {
            const absolute = resolve(name);
            return encoding ? await fs.readFile(absolute, encoding) : await fs.readFile(absolute);
        },
        write: async (name: string, data: string | Buffer) => {
            const absolute = resolve(name);
            await fs.mkdir(path.dirname(absolute), { recursive: true });
            await fs.writeFile(absolute, data);
            return absolute;
        },
        list: async () => {
            await fs.mkdir(root, { recursive: true });
            return await fs.readdir(root);
        },
    };
}

export async function runExecute(host: PageHost, options: ExecuteOptions): Promise<ExecuteResult> {
    const started = Date.now();
    const logs: ExecuteLogEntry[] = [];
    const warnings: string[] = [];
    const sessionId = options.sessionId ?? "default";
    const budgetMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Math.max(0, Number(options.timeoutMs));

    let deadline = budgetMs > 0 ? Date.now() + budgetMs : 0;
    let timer: NodeJS.Timeout | null = null;
    let pausedAt = 0;
    let timedOut = false;
    let rejectTimeout: ((error: Error) => void) | null = null;
    const expired = new Promise<never>((_, reject) => {
        rejectTimeout = reject;
    });

    const arm = () => {
        if (!deadline) return;
        const remaining = Math.max(1, deadline - Date.now());
        timer = setTimeout(() => {
            timedOut = true;
            rejectTimeout?.(
                new Error(
                    `execute timed out after ${budgetMs}ms. Time spent waiting for a human handoff is not counted. ` +
                        `Pass a larger timeoutMs, or split the work into smaller scripts.`
                )
            );
        }, remaining);
    };

    host.setHandoffHooks({
        start: () => {
            pausedAt = Date.now();
            if (timer) clearTimeout(timer);
            timer = null;
        },
        end: () => {
            if (deadline && pausedAt) {
                deadline += Date.now() - pausedAt;
                pausedAt = 0;
            }
            arm();
        },
    });

    const state = sessionState.get(sessionId) ?? {};
    sessionState.set(sessionId, state);

    const filesRoot =
        process.env.AETHER_FILE_ROOT || path.join(os.tmpdir(), "aether-files");

    const sandbox: Record<string, unknown> = {
        console: makeConsole(logs),
        page: host.pageApi(),
        context: host.contextApi(),
        browser: host.browserApi(),
        snapshot: (params?: SnapshotParams): Promise<SnapshotResult> => host.snapshot(params),
        ref: (id: string) => host.ref(id),
        locator: (selector: string) => host.locator(selector),
        getByRole: (role: string, opts?: { name?: string }) => host.getByRole(role, opts),
        getByText: (text: string) => host.getByText(text),
        getByLabel: (label: string) => host.getByLabel(label),
        getByPlaceholder: (placeholder: string) => host.getByPlaceholder(placeholder),
        handoff: (message: string, handoffOptions?: { timeoutMs?: number }) =>
            host.handoff(message, { ...handoffOptions, sessionId }),
        sleep: (ms: number) => host.waitForTimeout(ms),
        screenshot: (params?: ScreenshotParams) => host.screenshot(params),
        state,
        files: makeFiles(filesRoot),
        // Safe globals, so common scripts do not need Node.
        Buffer,
        URL,
        TextEncoder,
        TextDecoder,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
    };

    const context = vm.createContext(sandbox, { name: "aether-execute" });
    arm();

    try {
        const script = new vm.Script(wrapCode(options.code), { filename: "aether-execute.js" });
        const run = async (): Promise<unknown> => {
            const pending = script.runInContext(context, { timeout: SYNC_SLICE_MS });
            return await (pending as Promise<unknown>);
        };

        const value = await Promise.race([run(), expired]);
        const rendered = renderResult(value, warnings);

        return {
            session: sessionId,
            ...(rendered.value === undefined ? {} : { value: rendered.value }),
            text: rendered.text,
            isError: false,
            logs,
            warnings,
            durationMs: Date.now() - started,
            timedOut: false,
        };
    } catch (error: any) {
        const rawMessage = timedOut
            ? String(error?.message ?? error)
            : error?.stack
              ? String(error.stack).split("\n").slice(0, 8).join("\n")
              : String(error?.message ?? error);

        const message = /\b(document|window|location|navigator)\b is not defined/.test(rawMessage)
            ? `${rawMessage}\n\nHint: the script runs outside the page, so document/window/location are not globals here. ` +
              `Use page.evaluate(() => ...) for page-context JavaScript, or page.locator()/page.getByRole() to inspect and act.`
            : rawMessage;

        return {
            session: sessionId,
            text: message,
            isError: true,
            logs,
            warnings,
            durationMs: Date.now() - started,
            timedOut,
        };
    } finally {
        if (timer) clearTimeout(timer);
        host.setHandoffHooks(null);
    }
}
