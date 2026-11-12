/**
 * Extension relay — a local Chrome DevTools endpoint backed by browser extensions.
 *
 * Each browser runs one extension instance. Every instance dials in with its own
 * `browserId` and gets its own link, tab space and browser-level CDP endpoint
 * (`/devtools/browser?browser=<id>`). That is what lets several browsers be
 * connected at once while each agent session stays in the one it pinned.
 *
 * The relay also keeps the page-level endpoint (`/devtools/page/<browser>:<tab>`)
 * for compatibility, and forwards every command to `chrome.debugger`.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { WebSocket, WebSocketServer } from "ws";
import { createLogger } from "./logger";
import { BrowserCdpConnection, type BrowserHost, type CdpTab } from "./relay/browser-cdp";
import { assertCdpAllowed } from "./relay/guardrails";

const log = createLogger("relay");

export interface RelayTab {
    tabId: number;
    url: string;
    title: string;
    active: boolean;
    windowId?: number;
    groupId?: number;
    attached?: boolean;
}

export interface RelayBrowser {
    id: string;
    name: string;
    connected: boolean;
    agentTabs: number;
}

export interface RelayOptions {
    port?: number;
    token?: string;
    /** Called when the extension lends the user's tab. */
    onLent?: (tab: { tabId: number; url: string; title: string; browserId: string }) => void;
}

export interface RelayStatus {
    running: boolean;
    port: number;
    url: string;
    extensionConnected: boolean;
    /** Tabs agents may use right now, across every browser. */
    agentTabs: number;
    /** How many of those are in an Aether tab group. */
    groupedTabs: number;
    browsers: RelayBrowser[];
    /** Where the user approves a new browser. Present only while pairing is pending. */
    pairingCode?: string;
}

interface ExtensionMessage {
    id?: number;
    method?: string;
    params?: any;
    result?: any;
    error?: string;
}

interface PendingCall {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

interface ExtensionLink {
    id: string;
    name: string;
    ws: WebSocket;
    /** Every tab the extension reports. */
    tabs: Map<number, RelayTab>;
    /** Tabs the agent opened or the user lent. Only these are exposed over CDP. */
    owned: Map<number, { sessionId: string }>;
    pending: Map<number, PendingCall>;
    nextId: number;
    cdpConnections: Set<BrowserCdpConnection>;
}

const EXTENSION_CALL_TIMEOUT_MS = 30_000;

export function defaultRelayPort(): number {
    return Number(process.env.AETHER_EXTENSION_PORT || 8766);
}

/** The token the extension must present. Stored beside sessions, mode 0600. */
export function relayToken(): string {
    if (process.env.AETHER_EXTENSION_TOKEN) return process.env.AETHER_EXTENSION_TOKEN;
    const directory = process.env.AETHER_SESSION_DIR || path.join(os.homedir(), ".aether");
    const file = path.join(directory, "relay-token");
    try {
        const existing = fs.readFileSync(file, "utf8").trim();
        if (existing) return existing;
    } catch {
        // Not created yet.
    }
    const token = crypto.randomBytes(24).toString("hex");
    try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
    } catch (error: any) {
        log.warn("could not persist the relay token", { error: String(error?.message ?? error) });
    }
    return token;
}

function safeEqual(left: string, right: string): boolean {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class ExtensionRelay {
    private server: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    private readonly links = new Map<string, ExtensionLink>();
    private readonly clientsByTarget = new Map<string, WebSocket>();
    private readonly detachTimers = new Map<string, NodeJS.Timeout>();
    private token: string;
    private pairingCode: string | null = null;
    private pairingExpiresAt = 0;
    private pairingAttempts = 0;
    private pairedOnce = false;
    private readonly unpaired = new Set<WebSocket>();
    private readonly port: number;
    private readonly onLent?: RelayOptions["onLent"];
    private linkCounter = 0;

    constructor(options: RelayOptions = {}) {
        this.port = options.port ?? defaultRelayPort();
        this.token = options.token ?? "";
        this.onLent = options.onLent;
    }

    get running(): boolean {
        return this.server !== null;
    }

    status(): RelayStatus {
        const browsers: RelayBrowser[] = [...this.links.values()].map((link) => ({
            id: link.id,
            name: link.name,
            connected: link.ws.readyState === WebSocket.OPEN,
            agentTabs: link.owned.size,
        }));
        const agentTabs = browsers.reduce((sum, browser) => sum + browser.agentTabs, 0);
        const groupedTabs = [...this.links.values()].reduce(
            (sum, link) =>
                sum +
                [...link.owned.keys()].filter((tabId) => {
                    const group = link.tabs.get(tabId)?.groupId;
                    return typeof group === "number" && group >= 0;
                }).length,
            0
        );
        return {
            running: this.running,
            port: this.port,
            url: `ws://127.0.0.1:${this.port}`,
            extensionConnected: browsers.some((browser) => browser.connected),
            agentTabs,
            groupedTabs,
            browsers,
            ...(this.pairedOnce ? {} : { pairingCode: this.currentPairingCode() ?? undefined }),
        };
    }

    private currentPairingCode(): string | null {
        if (this.pairedOnce) return null;
        if (this.pairingCode && Date.now() < this.pairingExpiresAt) return this.pairingCode;
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let code = "";
        for (let i = 0; i < 8; i++) code += alphabet[crypto.randomInt(alphabet.length)];
        this.pairingCode = `${code.slice(0, 4)}-${code.slice(4)}`;
        this.pairingExpiresAt = Date.now() + 10 * 60_000;
        this.pairingAttempts = 0;
        return this.pairingCode;
    }

    // ─── start / stop ──────────────────────────────────────────────────

    async start(): Promise<{ started: boolean; port: number; token: string }> {
        if (!this.token) this.token = relayToken();
        if (this.server) return { started: true, port: this.port, token: this.token };

        const server = http.createServer((request, response) => void this.handleHttp(request, response));
        const wss = new WebSocketServer({ noServer: true });

        server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url || "/", `http://127.0.0.1:${this.port}`);

            if (url.pathname === "/extension") {
                const authorized = url.searchParams.get("token") !== "" && safeEqual(url.searchParams.get("token") || "", this.token);
                const wantsPairing = url.searchParams.get("pair") === "1" || !authorized;
                if (!authorized && !wantsPairing) {
                    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                    socket.destroy();
                    return;
                }
                const browserId = url.searchParams.get("browserId") || "";
                const name = url.searchParams.get("name") || "";
                wss.handleUpgrade(request, socket, head, (ws) =>
                    authorized ? this.attachExtension(ws, browserId, name) : this.attachPairingSocket(ws)
                );
                return;
            }

            if (url.pathname === "/devtools/browser") {
                if (!safeEqual(url.searchParams.get("token") || "", this.token)) {
                    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                    socket.destroy();
                    return;
                }
                const browserId = url.searchParams.get("browser") || "";
                const link = this.resolveLink(browserId);
                if (!link) {
                    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                    socket.destroy();
                    return;
                }
                wss.handleUpgrade(request, socket, head, (ws) => this.attachBrowserCdp(link, ws));
                return;
            }

            if (url.pathname.startsWith("/devtools/page/")) {
                if (!safeEqual(url.searchParams.get("token") || "", this.token)) {
                    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                    socket.destroy();
                    return;
                }
                const targetId = decodeURIComponent(url.pathname.slice("/devtools/page/".length));
                const resolved = this.parseTargetId(targetId);
                if (!resolved || !resolved.link.owned.has(resolved.tabId)) {
                    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                    socket.destroy();
                    return;
                }
                wss.handleUpgrade(request, socket, head, (ws) =>
                    this.attachClient(resolved.link, resolved.tabId, ws)
                );
                return;
            }

            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
        });

        this.server = server;
        this.wss = wss;

        const bound = await new Promise<boolean>((resolve) => {
            const onError = (error: any) => {
                server.removeListener("listening", onListening);
                if (error?.code !== "EADDRINUSE") {
                    log.error("relay failed to listen", { error: String(error?.message ?? error) });
                }
                resolve(false);
            };
            const onListening = () => {
                server.removeListener("error", onError);
                resolve(true);
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(this.port, "127.0.0.1");
        });

        if (!bound) {
            this.server = null;
            this.wss = null;
            log.info("relay port already in use; using the running relay", { port: this.port });
            return { started: false, port: this.port, token: this.token };
        }

        log.info(`relay listening on 127.0.0.1:${this.port}`);
        return { started: true, port: this.port, token: this.token };
    }

    async stop(): Promise<void> {
        for (const socket of this.unpaired) socket.close(1000, "relay shutting down");
        this.unpaired.clear();
        for (const timer of this.detachTimers.values()) clearTimeout(timer);
        this.detachTimers.clear();
        for (const link of this.links.values()) {
            for (const pending of link.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(new Error("The relay is shutting down."));
            }
            link.pending.clear();
            link.ws.terminate();
        }
        this.links.clear();
        for (const client of this.clientsByTarget.values()) client.terminate();
        this.clientsByTarget.clear();
        this.wss?.close();
        this.wss = null;
        await new Promise<void>((resolve) => {
            if (!this.server) return resolve();
            // Upgraded WebSockets are not closed by server.close(); drop them so
            // shutdown and tests do not hang.
            (this.server as any).closeAllConnections?.();
            this.server.close(() => resolve());
            this.server = null;
        });
    }

    // ─── HTTP (CDP discovery) ───────────────────────────────────────────

    private async handleHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        const url = new URL(request.url || "/", `http://127.0.0.1:${this.port}`);
        const json = (value: unknown) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(value));
        };

        if (url.pathname === "/health") {
            json(this.status());
            return;
        }
        if (url.pathname === "/json/version") {
            json({
                Browser: "Aether-Extension/1.0",
                "Protocol-Version": "1.3",
                "User-Agent": "Aether extension relay",
                webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/browser?token=${this.token}`,
            });
            return;
        }
        if (url.pathname === "/json" || url.pathname === "/json/list") {
            await this.refreshAll();
            const browser = url.searchParams.get("browser") || "";
            json(this.targetList(browser || undefined));
            return;
        }
        if (url.pathname === "/agent-tab") {
            if (!safeEqual(url.searchParams.get("token") || "", this.token)) {
                response.writeHead(401, { "content-type": "text/plain" });
                response.end("unauthorized");
                return;
            }
            const link = this.resolveLink(url.searchParams.get("browser") || "");
            if (!link) {
                response.writeHead(503, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: "No browser is paired with the relay yet." }));
                return;
            }
            try {
                await this.refreshTabs(link);
                const tabId = await this.ensureAgentTab(link, url.searchParams.get("session") || "agent");
                json({ tabId, browserId: link.id });
            } catch (error: any) {
                response.writeHead(503, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: String(error?.message ?? error) }));
            }
            return;
        }
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
    }

    private targetList(browserId?: string): any[] {
        const links = browserId ? [...this.links.values()].filter((link) => link.id === browserId) : [...this.links.values()];
        const targets: any[] = [];
        for (const link of links) {
            for (const tabId of link.owned.keys()) {
                const tab = link.tabs.get(tabId);
                if (!tab) continue;
                const targetId = `${link.id}:${tabId}`;
                targets.push({
                    id: targetId,
                    type: "page",
                    title: tab.title || tab.url || "Aether tab",
                    url: tab.url || "about:blank",
                    browserId: link.id,
                    webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/page/${encodeURIComponent(targetId)}?token=${this.token}`,
                });
            }
        }
        return targets;
    }

    private parseTargetId(targetId: string): { link: ExtensionLink; tabId: number } | null {
        const index = targetId.lastIndexOf(":");
        if (index <= 0) return null;
        const browserId = targetId.slice(0, index);
        const tabId = Number(targetId.slice(index + 1));
        const link = this.links.get(browserId);
        if (!link || !Number.isFinite(tabId)) return null;
        return { link, tabId };
    }

    private resolveLink(browserId?: string): ExtensionLink | null {
        if (browserId) return this.links.get(browserId) ?? null;
        return [...this.links.values()].find((link) => link.ws.readyState === WebSocket.OPEN) ?? [...this.links.values()][0] ?? null;
    }

    // ─── extension link ─────────────────────────────────────────────────

    private attachPairingSocket(ws: WebSocket): void {
        this.unpaired.add(ws);
        const send = (message: unknown) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
        };

        send({ method: "pair.required", params: { codeLength: 9 } });

        ws.on("message", (data) => {
            let message: any;
            try {
                message = JSON.parse(data.toString());
            } catch {
                return;
            }
            if (message.method === "hello") {
                send({ method: "pair.required", params: { codeLength: 9 } });
                return;
            }
            if (message.method !== "pair" || typeof message.id !== "number") return;

            const offered = String(message.params?.code ?? "").trim().toUpperCase();
            const expected = this.currentPairingCode();
            if (!expected || offered !== expected) {
                this.pairingAttempts++;
                send({ id: message.id, error: "That pairing code is wrong or expired. Use the code Aether printed." });
                if (this.pairingAttempts >= 5) {
                    this.pairingCode = null;
                    ws.close(4403, "too many pairing attempts");
                }
                return;
            }

            this.pairingCode = null;
            this.pairingAttempts = 0;
            this.pairedOnce = true;
            log.info("extension paired");
            send({ id: message.id, result: { token: this.token } });
        });

        ws.on("close", () => this.unpaired.delete(ws));
        ws.on("error", () => ws.close());
    }

    private attachExtension(ws: WebSocket, browserId: string, name: string): void {
        const id = browserId || `browser-${++this.linkCounter}`;
        const existing = this.links.get(id);
        if (existing && existing.ws !== ws) existing.ws.close(1000, "superseded");

        const link: ExtensionLink = {
            id,
            name: name || id,
            ws,
            tabs: new Map(),
            owned: new Map(),
            pending: new Map(),
            nextId: 1,
            cdpConnections: new Set(),
        };
        this.links.set(id, link);
        log.info("extension connected", { browserId: id, name: link.name });

        ws.on("message", (data) => {
            let message: ExtensionMessage;
            try {
                message = JSON.parse(data.toString());
            } catch {
                return;
            }
            this.onExtensionMessage(link, message);
        });
        ws.on("close", () => {
            if (this.links.get(id) === link) this.links.delete(id);
            for (const pending of link.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(new Error("The Aether extension disconnected."));
            }
            link.pending.clear();
            log.warn("extension disconnected", { browserId: id });
        });
        ws.on("error", () => ws.close());
    }

    private onExtensionMessage(link: ExtensionLink, message: ExtensionMessage): void {
        if (message.id !== undefined && link.pending.has(message.id)) {
            const pending = link.pending.get(message.id)!;
            link.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(message.error));
            else pending.resolve(message.result ?? {});
            return;
        }

        switch (message.method) {
            case "hello": {
                const hello = message.params || {};
                if (typeof hello.browserId === "string" && hello.browserId && hello.browserId !== link.id) {
                    this.links.delete(link.id);
                    link.id = hello.browserId;
                    this.links.set(link.id, link);
                }
                if (typeof hello.name === "string" && hello.name) link.name = hello.name;
                void this.refreshTabs(link).then(() => this.claimAttached(link, message.params?.attached));
                return;
            }
            case "debugger.event": {
                const { tabId, method, params } = message.params || {};
                const id = Number(tabId);
                const targetId = `${link.id}:${id}`;
                const client = this.clientsByTarget.get(targetId);
                if (client?.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ method, params: params ?? {} }));
                }
                for (const cdp of link.cdpConnections) cdp.onEvent(id, method, params ?? {});
                return;
            }
            case "debugger.detached": {
                const id = Number(message.params?.tabId);
                const targetId = `${link.id}:${id}`;
                const client = this.clientsByTarget.get(targetId);
                if (client) client.close(1011, "the debugger detached from this tab");
                this.clientsByTarget.delete(targetId);
                return;
            }
            case "tab.closed": {
                const id = Number(message.params?.tabId);
                link.owned.delete(id);
                link.tabs.delete(id);
                const targetId = `${link.id}:${id}`;
                const client = this.clientsByTarget.get(targetId);
                if (client) client.close(1011, "the tab was closed");
                this.clientsByTarget.delete(targetId);
                for (const cdp of link.cdpConnections) cdp.onTabClosed(id);
                return;
            }
            case "tab.updated": {
                const id = Number(message.params?.tabId);
                const existing = link.tabs.get(id);
                if (!existing) return;
                const updated = {
                    ...existing,
                    url: message.params?.url ?? existing.url,
                    title: message.params?.title ?? existing.title,
                };
                link.tabs.set(id, updated);
                for (const cdp of link.cdpConnections) cdp.onTabUpdated(updated);
                return;
            }
            case "tab.lent": {
                const { tabId, url, title } = message.params || {};
                const id = Number(tabId);
                const tab: RelayTab = { tabId: id, url, title, active: false };
                link.owned.set(id, { sessionId: "lent" });
                link.tabs.set(id, tab);
                this.onLent?.({ tabId: id, url, title, browserId: link.id });
                for (const cdp of link.cdpConnections) void cdp.onTabCreated(tab);
                log.info("tab lent by the user", { browserId: link.id, tabId: id });
                return;
            }
            case "bridge.status":
                void this.refreshTabs(link).then(() => this.claimAttached(link, message.params?.attached));
                return;
            default:
                return;
        }
    }

    private callExtension(link: ExtensionLink, method: string, params: any, timeoutMs = EXTENSION_CALL_TIMEOUT_MS): Promise<any> {
        if (!link.ws || link.ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("The Aether extension is not connected. Open the paired browser and retry."));
        }
        const id = link.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                link.pending.delete(id);
                reject(new Error(`The extension did not answer '${method}' in ${Math.round(timeoutMs / 1000)}s.`));
            }, timeoutMs);
            link.pending.set(id, { resolve, reject, timer });
            link.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    private async refreshTabs(link: ExtensionLink): Promise<void> {
        try {
            const tabs = (await this.callExtension(link, "tabs.list", {})) as RelayTab[];
            const live = new Set<number>();
            for (const tab of tabs) {
                const id = Number(tab.tabId);
                live.add(id);
                link.tabs.set(id, { ...tab, tabId: id });
            }
            for (const tabId of [...link.owned.keys()]) {
                if (!live.has(tabId)) link.owned.delete(tabId);
            }
        } catch {
            // The extension will push its tabs again on the next hello.
        }
    }

    /**
     * The extension still holds chrome.debugger attachments for these tabs
     * after a service-worker restart. Re-mark them as agent tabs so Playwright
     * can see them again instead of losing every previous tab.
     */
    private claimAttached(link: ExtensionLink, attached: unknown): void {
        if (!Array.isArray(attached)) return;
        for (const value of attached) {
            const tabId = Number(value);
            if (Number.isFinite(tabId) && link.tabs.has(tabId) && !link.owned.has(tabId)) {
                link.owned.set(tabId, { sessionId: "restored" });
            }
        }
    }

    private async refreshAll(): Promise<void> {
        await Promise.all([...this.links.values()].map((link) => this.refreshTabs(link)));
    }

    private ownedTabs(link: ExtensionLink): CdpTab[] {
        return [...link.owned.keys()]
            .map((tabId) => link.tabs.get(tabId))
            .filter((tab): tab is RelayTab => !!tab);
    }

    // ─── agent tabs ─────────────────────────────────────────────────────

    /** Make sure this browser has a tab for the given session. */
    async ensureAgentTab(link: ExtensionLink, sessionId: string = "agent"): Promise<number> {
        const existing = [...link.owned.entries()].find(([, owner]) => owner.sessionId === sessionId)?.[0];
        if (existing !== undefined && link.tabs.has(existing)) return existing;

        const created = (await this.callExtension(link, "tabs.create", {
            url: "about:blank",
            active: false,
            sessionId,
        })) as RelayTab;
        const tabId = Number(created.tabId);
        link.owned.set(tabId, { sessionId });
        link.tabs.set(tabId, { ...created, tabId });
        return tabId;
    }

    /** Ensure an agent tab for a browser id (or the default browser). */
    async ensureAgentTabFor(browserId: string | undefined, sessionId: string): Promise<{ browserId: string; tabId: number } | null> {
        const link = this.resolveLink(browserId);
        if (!link) return null;
        await this.refreshTabs(link);
        const tabId = await this.ensureAgentTab(link, sessionId);
        return { browserId: link.id, tabId };
    }

    private async attachTab(link: ExtensionLink, tabId: number): Promise<void> {
        if (!link.tabs.has(tabId)) await this.refreshTabs(link);
        await this.callExtension(link, "debugger.attach", { tabId });
        if (!link.owned.has(tabId)) link.owned.set(tabId, { sessionId: "browser" });
    }

    private async detachTab(link: ExtensionLink, tabId: number): Promise<void> {
        link.owned.delete(tabId);
        await this.callExtension(link, "debugger.detach", { tabId }).catch(() => undefined);
    }

    private async createTab(link: ExtensionLink, url: string, sessionId: string): Promise<RelayTab> {
        const created = (await this.callExtension(link, "tabs.create", { url, active: false, sessionId })) as RelayTab;
        const tabId = Number(created.tabId);
        const tab: RelayTab = { ...created, tabId };
        link.owned.set(tabId, { sessionId });
        link.tabs.set(tabId, tab);
        return tab;
    }

    private async closeTab(link: ExtensionLink, tabId: number): Promise<void> {
        if (!link.owned.has(tabId)) throw new Error("Aether can only close tabs it opened.");
        await this.callExtension(link, "tabs.close", { tabId });
        link.owned.delete(tabId);
        link.tabs.delete(tabId);
        for (const cdp of link.cdpConnections) cdp.onTabClosed(tabId);
    }

    // ─── browser-level CDP clients ──────────────────────────────────────

    private attachBrowserCdp(link: ExtensionLink, ws: WebSocket): void {
        const host: BrowserHost = {
            listTabs: async () => {
                await this.refreshTabs(link);
                return this.ownedTabs(link);
            },
            attach: (tabId) => this.attachTab(link, tabId),
            detach: (tabId) => this.detachTab(link, tabId),
            createTab: (url, sessionId) => this.createTab(link, url, sessionId ?? "agent"),
            closeTab: (tabId) => this.closeTab(link, tabId),
            group: (tabId, sessionId) => this.callExtension(link, "tabs.group", { tabId, sessionId }).then(() => undefined),
            send: async (tabId, method, params) => {
                assertCdpAllowed(method);
                return await this.callExtension(link, "debugger.command", { tabId, method, params });
            },
            isOwned: (tabId) => link.owned.has(tabId),
        };

        const connection = new BrowserCdpConnection(link.id, host, {
            send: (message) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
            },
        });
        link.cdpConnections.add(connection);

        ws.on("message", (data) => {
            let message: any;
            try {
                message = JSON.parse(data.toString());
            } catch {
                return;
            }
            if (typeof message?.id !== "number" || typeof message?.method !== "string") return;
            void (async () => {
                try {
                    const result = await connection.handle(message);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ id: message.id, result: result ?? {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
                    }
                } catch (error: any) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            id: message.id,
                            error: { code: -32000, message: String(error?.message ?? error) },
                            ...(message.sessionId ? { sessionId: message.sessionId } : {}),
                        }));
                    }
                }
            })();
        });
        ws.on("close", () => link.cdpConnections.delete(connection));
        ws.on("error", () => ws.close());
    }

    // ─── page-level CDP clients (compatibility) ─────────────────────────

    private attachClient(link: ExtensionLink, tabId: number, ws: WebSocket): void {
        const targetId = `${link.id}:${tabId}`;
        const existing = this.clientsByTarget.get(targetId);
        if (existing && existing.readyState === WebSocket.OPEN) {
            ws.close(1008, "This tab is already in use by another Aether client.");
            return;
        }

        const timer = this.detachTimers.get(targetId);
        if (timer) {
            clearTimeout(timer);
            this.detachTimers.delete(targetId);
        }

        this.clientsByTarget.set(targetId, ws);
        const sessionId = `${link.id}-${tabId}`;

        let ready = false;
        const queued: Array<{ id: number; method: string; params: any }> = [];

        const flush = (error?: string) => {
            ready = true;
            for (const message of queued.splice(0)) {
                if (error) ws.send(JSON.stringify({ id: message.id, error: { code: -32000, message: error } }));
                else void this.forward(link, tabId, sessionId, ws, message);
            }
        };

        ws.on("message", (data) => {
            let message: any;
            try {
                message = JSON.parse(data.toString());
            } catch {
                return;
            }
            if (typeof message?.id !== "number" || typeof message?.method !== "string") return;
            if (!ready) {
                queued.push({ id: message.id, method: message.method, params: message.params || {} });
                return;
            }
            void this.forward(link, tabId, sessionId, ws, {
                id: message.id,
                method: message.method,
                params: message.params || {},
            });
        });

        ws.on("close", () => {
            if (this.clientsByTarget.get(targetId) === ws) this.clientsByTarget.delete(targetId);
            const detachTimer = setTimeout(() => {
                this.detachTimers.delete(targetId);
                if (this.clientsByTarget.has(targetId)) return;
                void this.callExtension(link, "debugger.detach", { tabId }).catch(() => undefined);
            }, 2_000);
            this.detachTimers.set(targetId, detachTimer);
        });
        ws.on("error", () => ws.close());

        void (async () => {
            try {
                await this.refreshTabs(link);
                await this.callExtension(link, "debugger.attach", { tabId });
                const tab = link.tabs.get(tabId);
                if (tab) await this.callExtension(link, "tabs.group", { tabId, sessionId }).catch(() => undefined);
                flush();
            } catch (error: any) {
                flush(String(error?.message ?? error));
            }
        })();
    }

    private async forward(
        link: ExtensionLink,
        tabId: number,
        sessionId: string,
        ws: WebSocket,
        message: { id: number; method: string; params: any }
    ): Promise<void> {
        try {
            assertCdpAllowed(message.method);
            const local = await this.handleLocal(message, link, tabId, sessionId);
            if (local !== undefined) {
                ws.send(JSON.stringify({ id: message.id, result: local }));
                return;
            }
            const result = await this.callExtension(link, "debugger.command", {
                tabId,
                method: message.method,
                params: message.params,
            });
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: message.id, result: result ?? {} }));
        } catch (error: any) {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(
                JSON.stringify({
                    id: message.id,
                    error: { code: -32000, message: String(error?.message ?? error) },
                })
            );
        }
    }

    private async handleLocal(
        message: { method: string; params: any },
        link: ExtensionLink,
        tabId: number,
        sessionId: string
    ): Promise<unknown | undefined> {
        switch (message.method) {
            case "Browser.getVersion":
                return { protocolVersion: "1.3", product: "Aether-Extension/1.0", revision: "", userAgent: "Aether extension relay", jsVersion: "" };
            case "Target.setDiscoverTargets":
            case "Target.setAutoAttach":
                return {};
            case "Target.getTargets":
                await this.refreshTabs(link);
                return {
                    targetInfos: this.ownedTabs(link).map((tab) => ({
                        targetId: `${link.id}:${tab.tabId}`,
                        type: "page",
                        title: tab.title || tab.url,
                        url: tab.url || "about:blank",
                        attached: this.clientsByTarget.has(`${link.id}:${tab.tabId}`),
                    })),
                };
            case "Target.getTargetInfo": {
                const tab = link.tabs.get(tabId);
                if (!tab) throw new Error(`Unknown tab ${tabId}`);
                return {
                    targetInfo: {
                        targetId: `${link.id}:${tabId}`,
                        type: "page",
                        title: tab.title || tab.url,
                        url: tab.url || "about:blank",
                        attached: true,
                    },
                };
            }
            case "Target.createTarget": {
                const tab = await this.createTab(link, message.params?.url || "about:blank", sessionId);
                return { targetId: `${link.id}:${tab.tabId}` };
            }
            case "Target.closeTarget": {
                const targetId = String(message.params?.targetId ?? "");
                const resolved = this.parseTargetId(targetId);
                if (!resolved || resolved.link !== link || !link.owned.has(resolved.tabId)) {
                    throw new Error("Aether can only close tabs it opened.");
                }
                await this.closeTab(link, resolved.tabId);
                return { success: true };
            }
            case "Target.attachToTarget":
                throw new Error("Connect to the tab's own devtools/page WebSocket instead.");
            default:
                return undefined;
        }
    }
}

let relay: ExtensionRelay | null = null;

export function getExtensionRelay(options?: RelayOptions): ExtensionRelay {
    if (!relay) relay = new ExtensionRelay(options);
    return relay;
}
