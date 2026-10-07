import WebSocket from "ws";
import http from "http";
import { spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

import { STEALTH_SCRIPT } from "./stealth";
import { SHARED_DOM_HELPERS } from "./element-collector";
import { LOCATOR_BOOTSTRAP_SCRIPT } from "./eval-scripts";
import { isExtensionConnected, onExtensionEvent, sendCommandToExtension } from "./ws-server";

interface CdpTarget {
    id: string;
    webSocketDebuggerUrl: string;
    url: string;
    title: string;
    type: string;
}

interface PendingRequest {
    resolve: (val: any) => void;
    reject: (err: any) => void;
    timeout: NodeJS.Timeout;
}

interface WaitForSelectorOptions {
    visible?: boolean;
    stable?: boolean;
}

type BrowserName = 'chrome' | 'edge' | 'brave' | 'firefox';

/** Default per-command CDP timeout. Generous: navigation and CAPTCHA waits need it. */
export const CDP_COMMAND_TIMEOUT_MS = 30000;

/**
 * Timeout for commands issued from a polling loop. Polls re-issue every ~150ms,
 * so a hung command must fail fast or it stalls the whole loop for 30s.
 */
export const CDP_POLL_TIMEOUT_MS = 8000;

const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 6;

export interface BrowserProfile {
    browser: BrowserName;
    id: string;
    name: string;
    directory: string;
    userDataDir: string;
    lastActive?: number;
}

export class CdpClient {
    private ws: WebSocket | null = null;
    private messageId = 0;
    private pending = new Map<number, PendingRequest>();
    private chromeProcess: ChildProcess | null = null;
    private targets: CdpTarget[] = [];
    private activeTarget: CdpTarget | null = null;
    private eventListeners = new Map<string, ((params: any) => void)[]>();
    private connected = false;
    /** When true, CDP commands are forwarded through the installed Chromium extension. */
    private extensionMode = false;
    private removeExtensionEventListener: (() => void) | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0;
    private reconnectGaveUp = false;
    private intentionalClose = false;
    private networkTraffic: any[] = [];
    private consoleLogs: any[] = [];
    private readonly MAX_TRAFFIC_LOGS = 100;
    private readonly MAX_CONSOLE_LOGS = 100;
    private mousePosition: { x: number; y: number } | null = null;
    private networkLoggingAttached = false;
    private diagnosticsLoggingAttached = false;
    private speedMultiplier = 1.0;
    private documentNodeId: number | null = null;

    constructor() {}

    /**
     * Attach to an Aether-owned tab in an already-running Chromium browser.
     * The extension creates the tab when necessary and never exposes ordinary
     * user tabs to the MCP server.
     */
    async connectExtension(): Promise<void> {
        if (!isExtensionConnected()) {
            throw new Error("No active extension connection. Load the Aether Browser Bridge extension and keep it enabled.");
        }

        this.extensionMode = true;
        const target = await sendCommandToExtension("session.attach", {});
        this.connected = true;
        this.activeTarget = {
            id: String(target.id),
            webSocketDebuggerUrl: "extension://aether",
            url: target.url || "about:blank",
            title: target.title || "Aether agent tab",
            type: "page",
        };
        this.documentNodeId = null;

        // Forward browser events so the existing navigation, logging, and
        // polling helpers continue to behave the same as native CDP mode.
        if (!this.removeExtensionEventListener) {
            this.removeExtensionEventListener = onExtensionEvent((method, params) => this.emitEvent(method, params));
        }

        await this.sendCommand("Runtime.enable").catch(() => {});
        await this.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
            source: LOCATOR_BOOTSTRAP_SCRIPT,
        }).catch(() => {});
        await this.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
            source: STEALTH_SCRIPT,
        }).catch(() => {});
        this.attachNetworkLogging();
        this.attachDiagnosticsLogging();
        console.error(`[CDP] Connected through extension to Aether tab ${target.id}`);
    }

    /** Set speed multiplier. 0 = instant, 1 = normal, 2 = slow (2x delays). */
    setSpeed(m: number): void {
        this.speedMultiplier = Math.max(0, m);
    }

    /** Get current speed multiplier. */
    getSpeedMultiplier(): number {
        return this.speedMultiplier;
    }

    // ─── CDP DOM-level utilities (3-5x faster than Runtime.evaluate) ───

    /** Invalidate cached document node ID. Call after navigation or tab switch. */
    invalidateDocumentNodeId(): void {
        this.documentNodeId = null;
    }

    /** Get the document root nodeId (cached per page). */
    async getDocumentNodeId(): Promise<number> {
        try {
            if (this.documentNodeId !== null) return this.documentNodeId;
            const result = await this.sendCommand("DOM.getDocument", { depth: -1, pierce: true });
            const nodeId = result.root.nodeId as number;
            this.documentNodeId = nodeId;
            return nodeId;
        } catch {
            return 0; // sentinel — caller should handle
        }
    }

    /** Run DOM.querySelector via CDP (no JS injection). Returns nodeId or null. */
    async querySelectorNodeId(selector: string): Promise<number | null> {
        try {
            const docId = await this.getDocumentNodeId();
            if (!docId) return null;
            const result = await this.sendCommand("DOM.querySelector", { nodeId: docId, selector });
            return result.nodeId ?? null;
        } catch {
            return null;
        }
    }

    /** Get bounding box from the layout engine (no JS injection). Returns null if hidden. */
    async getBoxModel(nodeId: number): Promise<{ x: number; y: number; width: number; height: number } | null> {
        try {
            const result = await this.sendCommand("DOM.getBoxModel", { nodeId });
            if (!result || !result.model) return null;
            // quad[0..7] = x1,y1, x2,y2, x3,y3, x4,y4 (corners of content box)
            // top-left = [quad[0], quad[1]], bottom-right = [quad[4], quad[5]]
            const q = result.model.content;
            return {
                x: q[0],
                y: q[1],
                width: q[4] - q[0],
                height: q[5] - q[1],
            };
        } catch {
            return null;
        }
    }

    /** Focus an element via CDP DOM.focus. */
    async focusNode(nodeId: number): Promise<void> {
        try {
            await this.sendCommand("DOM.focus", { nodeId });
        } catch {
            // ignore
        }
    }

    /** Get the center coordinates of an element matched by selector. */
    async getElementCenter(selector: string): Promise<{ x: number; y: number; width: number } | null> {
        try {
            const nodeId = await this.querySelectorNodeId(selector);
            if (!nodeId) return null;
            const box = await this.getBoxModel(nodeId);
            if (!box) return null;
            return {
                x: box.x + box.width / 2,
                y: box.y + box.height / 2,
                width: box.width,
            };
        } catch {
            return null;
        }
    }

    /**
     * Connect to existing Chrome instance on given port
     */
    async connect(port: number = 9222): Promise<void> {
        const targets = await this.listTargets(port);
        if (targets.length === 0) {
            throw new Error(`No targets found on port ${port}. Is Chrome running with --remote-debugging-port=${port}?`);
        }

        // Prefer first page target
        const page = targets.find(t => t.type === "page") || targets[0];
        await this.attachToTarget(page);
    }

    /**
     * Launch a new Chrome instance with remote debugging
     */
    async launch(options?: {
        headless?: boolean;
        userDataDir?: string;
        profileDirectory?: string;
        port?: number;
        extraArgs?: string[];
    }): Promise<void> {
        // Delegate to launchAuto without specifying browser (will auto-detect)
        await this.launchAuto(options);
    }

    /**
     * List available CDP targets (tabs/pages)
     */
    async listTargets(port: number = 9222): Promise<CdpTarget[]> {
        if (this.extensionMode) {
            const tabs = await sendCommandToExtension("tabs.list", {});
            this.targets = (tabs || []).map((tab: any) => ({
                id: String(tab.id),
                webSocketDebuggerUrl: "extension://aether",
                url: tab.url || "about:blank",
                title: tab.title || "Aether agent tab",
                type: "page",
            }));
            return this.targets;
        }
        return new Promise((resolve, reject) => {
            const req = http.get(`http://localhost:${port}/json`, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        const targets = JSON.parse(data);
                        this.targets = targets;
                        resolve(targets);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on("error", reject);
            req.setTimeout(3000, () => {
                req.destroy();
                reject(new Error(`Cannot connect to Chrome on port ${port}`));
            });
        });
    }

    /**
     * Attach to a specific target/tab
     */
    async attachToTarget(target: CdpTarget): Promise<void> {
        if (this.extensionMode) {
            const selected = await sendCommandToExtension("tabs.select", { targetId: target.id });
            this.connected = true;
            this.activeTarget = {
                ...target,
                url: selected.url || target.url,
                title: selected.title || target.title,
            };
            this.documentNodeId = null;
            return;
        }
        if (this.ws) {
            this.intentionalClose = true;
            this.ws.close();
            this.ws = null;
        }

        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(target.webSocketDebuggerUrl);

            this.ws.on("open", async () => {
                this.connected = true;
                this.activeTarget = target;
                this.documentNodeId = null;
                if (this.reconnectAttempts > 0) {
                    console.error(`[CDP] Reconnected after ${this.reconnectAttempts} attempt(s).`);
                }
                this.reconnectAttempts = 0;
                this.reconnectGaveUp = false;
                console.error(`[CDP] Connected to target: ${target.title} (${target.url})`);
                try {
                    // Enable minimal CDP domains on connect. Everything else is
                    // lazily enabled by the caller when needed.
                    await this.sendCommand("Runtime.enable").catch(() => {});

                    // Inject locator bootstrap once so element resolution works.
                    await this.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
                        source: LOCATOR_BOOTSTRAP_SCRIPT
                    });

                    // Stealth script — makes the browser harder to detect as automated.
                    await this.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
                        source: STEALTH_SCRIPT
                    }).catch(() => {});

                    this.attachNetworkLogging();
                    this.attachDiagnosticsLogging();
                } catch (e) {
                    console.error("[CDP] Failed to enable core domains:", e);
                }
                resolve();
            });

            this.ws.on("message", (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    if (message.id !== undefined && this.pending.has(message.id)) {
                        const { resolve, reject, timeout } = this.pending.get(message.id)!;
                        clearTimeout(timeout);
                        this.pending.delete(message.id);
                        if (message.error) {
                            reject(new Error(message.error.message || JSON.stringify(message.error)));
                        } else {
                            resolve(message.result);
                        }
                    } else if (message.method) {
                        this.emitEvent(message.method, message.params);
                    }
                } catch (e) {
                    console.error("[CDP] Parse error:", e);
                }
            });

            this.ws.on("close", () => {
                this.connected = false;
                console.error("[CDP] Connection closed");
                if (this.intentionalClose) {
                    this.intentionalClose = false;
                    return;
                }
                this.scheduleReconnect();
            });

            this.ws.on("error", (err) => {
                console.error("[CDP] Error:", err.message);
                if (!this.connected) reject(err);
            });
        });
    }

    /**
     * Send a CDP command.
     *
     * @param timeoutMs Per-call override. Pass {@link CDP_POLL_TIMEOUT_MS} from
     *   polling loops so a hung command cannot stall the loop for the full
     *   default. Defaults to {@link CDP_COMMAND_TIMEOUT_MS}.
     */
    async sendCommand(method: string, params: any = {}, timeoutMs: number = CDP_COMMAND_TIMEOUT_MS): Promise<any> {
        if (this.extensionMode) {
            if (!isExtensionConnected()) {
                this.connected = false;
                throw new Error("Browser extension disconnected. Reopen the Aether Browser Bridge popup and reconnect.");
            }
            return this.sendExtensionCommand(method, params);
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            if (this.reconnectGaveUp) {
                throw new Error(
                    `CDP not connected: browser disconnected and could not be re-attached after ` +
                    `${RECONNECT_MAX_ATTEMPTS} attempts. Call connect_browser or launch_browser to reattach.`
                );
            }
            throw new Error("CDP not connected. Call connect() or launch() first.");
        }

        const id = ++this.messageId;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP command '${method}' timed out after ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timeout });

            this.ws!.send(JSON.stringify({ id, method, params }));
        });
    }

    /** Route target lifecycle commands to the extension's managed-tab boundary. */
    private async sendExtensionCommand(method: string, params: any): Promise<any> {
        if (method === "Target.getTargets") {
            const tabs = await sendCommandToExtension("tabs.list", {});
            return {
                targetInfos: (tabs || []).map((tab: any) => ({
                    targetId: String(tab.id), type: "page", title: tab.title || "",
                    url: tab.url || "about:blank", attached: String(tab.id) === this.activeTarget?.id,
                })),
            };
        }
        if (method === "Target.createTarget") {
            const tab = await sendCommandToExtension("tabs.create", { url: params.url || "about:blank" });
            return { targetId: String(tab.id) };
        }
        if (method === "Target.activateTarget") {
            const tab = await sendCommandToExtension("tabs.select", { targetId: String(params.targetId) });
            this.activeTarget = {
                id: String(tab.id), webSocketDebuggerUrl: "extension://aether", type: "page",
                url: tab.url || "about:blank", title: tab.title || "Aether agent tab",
            };
            this.documentNodeId = null;
            return {};
        }
        if (method === "Target.closeTarget") {
            await sendCommandToExtension("tabs.close", { targetId: String(params.targetId) });
            return { success: true };
        }
        return sendCommandToExtension("cdp", { method, params });
    }

    /**
     * Navigate to URL
     */
    async navigate(url: string): Promise<void> {
        this.documentNodeId = null;
        await this.sendCommand("Page.navigate", { url });
    }

    async navigateAndWait(url: string, timeout: number = 10000): Promise<void> {
        const navPromise = this.waitForNavigation(Math.min(timeout, 10000)).catch(() => undefined);
        await this.navigate(url);
        const completed = await Promise.race([
            navPromise.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.min(timeout, 1500))),
        ]);

        if (!completed) {
            await this.waitForNetworkIdle(300, Math.min(timeout, 2500)).catch(() => {});
        }
    }

    /**
     * Take screenshot
     */
    async screenshot(format: "jpeg" | "png" = "jpeg", quality: number = 80): Promise<string> {
        const result = await this.sendCommand("Page.captureScreenshot", {
            format,
            quality,
            captureBeyondViewport: false,
        });
        return result.data; // base64 encoded
    }

    /**
     * Get interactive elements with Set-of-Marks (SoM) overlay
     * Returns element map with IDs and injects visual markers
     */
    async getInteractiveElements(withSoM: boolean = true): Promise<{
        elements: Array<{
            id: number;
            tag: string;
            text: string;
            selector: string;
            bounds: { x: number; y: number; width: number; height: number };
            attributes: Record<string, string>;
        }>;
        somInjected: boolean;
    }> {
        const result = await this.sendCommand("Runtime.evaluate", {
            expression: `
                (function() {
                    const withSoM = ${JSON.stringify(withSoM)};
                    ${SHARED_DOM_HELPERS}

                    // Remove existing overlays
                    const oldContainer = document.getElementById('aether-som-container');
                    if (oldContainer) oldContainer.remove();
                    document.querySelectorAll('.aether-som-marker').forEach(el => el.remove());

                    let container = null;
                    if (withSoM) {
                        container = document.createElement('div');
                        container.id = 'aether-som-container';
                        container.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 2147483647; pointer-events: none;';
                        document.documentElement.appendChild(container);
                    }

                    const selectors = [
                        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
                        '[onclick]', '[role="button"]', '[role="link"]', '[role="checkbox"]',
                        '[tabindex]:not([tabindex="-1"])', 'label', 'summary'
                    ].join(', ');
                    
                    const elements = Array.from(document.querySelectorAll(selectors));
                    const docRect = document.documentElement.getBoundingClientRect();
                    
                    let validIndex = 0;
                    const items = elements.map((el) => {
                        const r = el.getBoundingClientRect();
                        const computed = window.getComputedStyle(el);
                        if (computed.display === 'none' || computed.visibility === 'hidden' || r.width === 0 || r.height === 0) {
                            return null;
                        }
                        
                        validIndex++;
                        
                        // Get text content
                        let text = el.innerText || el.textContent || '';
                        text = text.trim().substring(0, 100);
                        
                        // Get a stable selector (shared with the locator engine)
                        const selector = aetherStableSelector(el);
                        
                        if (withSoM && container) {
                            const id = String(validIndex);
                            const w = Math.max(20, id.length * 8 + 14);
                            const marker = document.createElement('div');
                            marker.className = 'aether-som-marker';
                            marker.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="20" style="display:block">'
                                + '<rect width="' + w + '" height="20" rx="10" fill="#1e40af"/>'
                                + '<text x="' + (w / 2) + '" y="10" dominant-baseline="central" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" font-weight="700" fill="white">' + id + '</text>'
                                + '</svg>';
                            marker.style.cssText = \`
                                position: absolute;
                                left: \${r.left}px;
                                top: \${r.top}px;
                                pointer-events: none;
                                filter: drop-shadow(0 1px 4px rgba(0,0,0,0.35));
                                transform: translate(-4px, -4px);
                            \`;
                            container.appendChild(marker);
                        }

                        return {
                            id: validIndex,
                            tag: el.tagName.toLowerCase(),
                            text: text,
                            selector: selector,
                            bounds: { 
                                x: Math.max(0, r.left - docRect.left), 
                                y: Math.max(0, r.top - docRect.top), 
                                width: r.width, 
                                height: r.height 
                            },
                            attributes: {
                                type: el.getAttribute('type') || '',
                                href: el.getAttribute('href') || '',
                                role: aetherImplicitRole(el),
                                'aria-label': el.getAttribute('aria-label') || ''
                            }
                        };
                    }).filter(x => x !== null);
                    
                    return { items, somInjected: !!(withSoM && container) };
                })()
            `,
            returnByValue: true,
            awaitPromise: true,
        });

        const val = result.result?.value || { items: [], somInjected: false };
        return { elements: val.items, somInjected: val.somInjected };
    }

    /**
     * Remove Set-of-Marks overlay
     */
    async removeSoMOverlay(): Promise<void> {
        await this.sendCommand("Runtime.evaluate", {
            expression: `
                const container = document.getElementById('aether-som-container');
                if (container) container.remove();
                document.querySelectorAll('.aether-som-marker').forEach(el => el.remove());
            `,
        });
    }

    /**
     * Wait for a selector to appear in DOM — fast CDP polling.
     */
    async waitForSelector(selector: string, timeout: number = 10000, options: WaitForSelectorOptions = {}): Promise<boolean> {
        const startTime = Date.now();
        let lastBox: string | null = null;
        let stableSince = 0;

        while (Date.now() - startTime < timeout) {
            const nodeId = await this.querySelectorNodeId(selector).catch(() => null);
            if (!nodeId) {
                await new Promise(r => setTimeout(r, 30));
                continue;
            }

            if (!options.visible && !options.stable) return true;

            const box = await this.getBoxModel(nodeId);
            if (!box || box.width === 0 || box.height === 0) {
                await new Promise(r => setTimeout(r, 30));
                continue;
            }

            if (options.stable) {
                const boxKey = `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`;
                if (lastBox === boxKey) {
                    if (!stableSince) stableSince = Date.now();
                    if (Date.now() - stableSince >= 120) return true;
                } else {
                    stableSince = 0;
                    lastBox = boxKey;
                }
            } else {
                return true;
            }

            await new Promise(r => setTimeout(r, 30));
        }

        return false;
    }

    /**
     * Wait for navigation to complete
     */
    async waitForNavigation(timeout: number = 10000): Promise<void> {
        await this.sendCommand("Page.enable", {});
        
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.removeEventListener("Page.loadEventFired", listener);
                reject(new Error("Navigation timeout"));
            }, timeout);
            
            const listener = () => {
                clearTimeout(timeoutId);
                this.removeEventListener("Page.loadEventFired", listener);
                resolve();
            };
            
            this.on("Page.loadEventFired", listener);
        });
    }

    /**
     * Wait for network idle (no requests for specified duration)
     */
    async waitForNetworkIdle(idleTimeout: number = 500, timeout: number = 10000): Promise<void> {
        await this.sendCommand("Network.enable", {});
        
        return new Promise((resolve, reject) => {
            let lastRequestTime = Date.now();
            let idleCheckInterval: NodeJS.Timeout;
            let timeoutId: NodeJS.Timeout;
            
            const resetIdle = () => {
                lastRequestTime = Date.now();
            };
            
            const checkIdle = () => {
                if (Date.now() - lastRequestTime >= idleTimeout) {
                    clearInterval(idleCheckInterval);
                    clearTimeout(timeoutId);
                    this.removeEventListener("Network.requestWillBeSent", resetIdle);
                    this.removeEventListener("Network.responseReceived", resetIdle);
                    resolve();
                }
            };
            
            timeoutId = setTimeout(() => {
                clearInterval(idleCheckInterval);
                this.removeEventListener("Network.requestWillBeSent", resetIdle);
                this.removeEventListener("Network.responseReceived", resetIdle);
                resolve(); // Resolve anyway after timeout
            }, timeout);
            
            idleCheckInterval = setInterval(checkIdle, Math.max(1, 100 * this.speedMultiplier));
            
            this.on("Network.requestWillBeSent", resetIdle);
            this.on("Network.responseReceived", resetIdle);
        });
    }

    private attachNetworkLogging(): void {
        if (this.networkLoggingAttached) return;
        this.networkLoggingAttached = true;

        this.on("Network.requestWillBeSent", (params) => {
            this.networkTraffic.push({
                type: "request",
                requestId: params.requestId,
                url: params.request.url,
                method: params.request.method,
                timestamp: new Date().toISOString(),
            });
            if (this.networkTraffic.length > this.MAX_TRAFFIC_LOGS) this.networkTraffic.shift();
        });

        this.on("Network.responseReceived", (params) => {
            this.networkTraffic.push({
                type: "response",
                requestId: params.requestId,
                url: params.response.url,
                status: params.response.status,
                mimeType: params.response.mimeType,
                timestamp: new Date().toISOString(),
            });
            if (this.networkTraffic.length > this.MAX_TRAFFIC_LOGS) this.networkTraffic.shift();
        });

        this.on("Network.loadingFailed", (params) => {
            this.networkTraffic.push({
                type: "error",
                requestId: params.requestId,
                errorText: params.errorText,
                timestamp: new Date().toISOString(),
            });
            if (this.networkTraffic.length > this.MAX_TRAFFIC_LOGS) this.networkTraffic.shift();
        });
    }

    private attachDiagnosticsLogging(): void {
        if (this.diagnosticsLoggingAttached) return;
        this.diagnosticsLoggingAttached = true;

        const pushLog = (entry: any) => {
            this.consoleLogs.push({ timestamp: new Date().toISOString(), ...entry });
            if (this.consoleLogs.length > this.MAX_CONSOLE_LOGS) this.consoleLogs.shift();
        };

        this.on("Runtime.consoleAPICalled", (params) => {
            pushLog({
                source: "console",
                level: params.type,
                text: (params.args || []).map((arg: any) => arg.value ?? arg.description ?? arg.type).join(" "),
                url: params.stackTrace?.callFrames?.[0]?.url,
                lineNumber: params.stackTrace?.callFrames?.[0]?.lineNumber,
            });
        });

        this.on("Runtime.exceptionThrown", (params) => {
            pushLog({
                source: "exception",
                level: "error",
                text: params.exceptionDetails?.text || params.exceptionDetails?.exception?.description || "Runtime exception",
                url: params.exceptionDetails?.url,
                lineNumber: params.exceptionDetails?.lineNumber,
            });
        });

        this.on("Log.entryAdded", (params) => {
            const entry = params.entry || {};
            pushLog({
                source: entry.source || "log",
                level: entry.level,
                text: entry.text,
                url: entry.url,
                lineNumber: entry.lineNumber,
            });
        });

        this.on("Page.javascriptDialogOpening", (params) => {
            pushLog({
                source: "dialog",
                level: "warning",
                text: `${params.type}: ${params.message}`,
                url: params.url,
            });
        });
    }

    removeEventListener(event: string, listener: (params: any) => void): void {
        const listeners = this.eventListeners.get(event) || [];
        const idx = listeners.indexOf(listener);
        if (idx !== -1) {
            listeners.splice(idx, 1);
        }
    }

    async getTabs(): Promise<CdpTarget[]> {
        return await this.listTargets();
    }

    async switchToTarget(targetId: string, port: number = 9222): Promise<void> {
        const targets = await this.listTargets(port);
        const target = targets.find(t => t.id === targetId);
        if (!target) {
            throw new Error(`Target not found: ${targetId}`);
        }
        this.documentNodeId = null;
        await this.attachToTarget(target);
    }

    /**
     * Get a rich Accessibility Tree preserving tree structure, node IDs, and selectors.
     * AI agents can use this instead of screenshots for most decisions.
     */
    async getRichAXTree(): Promise<any> {
        await this.sendCommand("Accessibility.enable");
        const result = await this.sendCommand("Accessibility.getFullAXTree", {});
        
        if (!result || !result.nodes) return { tree: null, nodeCount: 0 };
        
        const nodes = result.nodes;
        const nodeMap = new Map<number, any>();
        
        // First pass: build lookup
        nodes.forEach((node: any) => {
            const name = node.name?.value || '';
            const role = node.role?.value || 'unknown';
            const properties: Record<string, any> = {};
            if (node.properties) {
                node.properties.forEach((p: any) => {
                    properties[p.name] = p.value?.value ?? p.value;
                });
            }
            
            nodeMap.set(node.nodeId, {
                axId: node.nodeId,
                backendDOMNodeId: node.backendDOMNodeId,
                role,
                name,
                description: node.description?.value || '',
                value: node.value?.value || '',
                disabled: !!properties.disabled,
                focused: !!properties.focused,
                checked: properties.checked,
                selected: !!properties.selected,
                expanded: !!properties.expanded,
                pressed: !!properties.pressed,
                children: [] as any[],
            });
        });
        
        // Second pass: build tree by following parentIds
        const roots: any[] = [];
        nodes.forEach((node: any) => {
            const enriched = nodeMap.get(node.nodeId);
            if (!enriched) return;
            
            if (node.parentId && nodeMap.has(node.parentId)) {
                nodeMap.get(node.parentId).children.push(enriched);
            } else {
                roots.push(enriched);
            }
        });
        
        // Prune: remove nodes with no name AND no meaningful role AND no children
        function prune(node: any): boolean {
            node.children = node.children.filter(prune);
            const hasContent = node.name || node.value || 
                ['button','link','textbox','checkbox','radio','combobox','listbox','heading','alert','dialog','navigation','main','banner','contentinfo','complementary','form','search','table','list','listitem','menu','menuitem','tab','tablist','tabpanel','tree','treeitem','slider','switch','progressbar','img','image'].includes(node.role);
            return hasContent || node.children.length > 0;
        }
        roots.forEach(prune);
        
        // Count total nodes after pruning
        let totalNodes = 0;
        function count(n: any) { totalNodes++; n.children.forEach(count); }
        roots.forEach(count);
        
        return { tree: roots, nodeCount: totalNodes };
    }

    /**
     * Backward-compat: flat list of accessible nodes.
     * Calls getRichAXTree() and flattens the tree structure.
     */
    async getSimplifiedAccessibilityTree(): Promise<any[]> {
        const result = await this.getRichAXTree();
        // Flatten for backward compat
        const flat: any[] = [];
        function flatten(n: any) { flat.push(n); n.children.forEach(flatten); }
        (result.tree || []).forEach(flatten);
        return flat;
    }

    async getNetworkTraffic(): Promise<any[]> {
        return this.networkTraffic;
    }

    async getConsoleLogs(limit: number = 50): Promise<any[]> {
        return this.consoleLogs.slice(-limit);
    }

    /**
     * Get page DOM snapshot
     */
    async getDOMSnapshot(): Promise<any> {
        const result = await this.sendCommand("DOMSnapshot.captureSnapshot", {
            computedStyles: [],
        });
        return result;
    }

    /**
     * Evaluate JavaScript in page context
     */
    async evaluate(expression: string, timeoutMs: number = CDP_COMMAND_TIMEOUT_MS): Promise<any> {
        const result = await this.sendCommand("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        }, timeoutMs);
        return result.result?.value !== undefined ? result.result.value : result.result;
    }

// ==================== Runtime Methods ====================
async callFunctionOn(functionDeclaration: string, objectId?: string, returnByValue: boolean = true, awaitPromise: boolean = false): Promise<any> {
    const result = await this.sendCommand("Runtime.callFunctionOn", {
        functionDeclaration, objectId, returnByValue, awaitPromise
    });
    return result.result;
}

async awaitPromise(promiseObjectId: string): Promise<any> {
    const result = await this.sendCommand("Runtime.awaitPromise", { promiseObjectId, returnByValue: true });
    return result.result;
}

async getProperties(objectId: string, ownProperties?: boolean, accessorPropertiesOnly?: boolean, generatePreview?: boolean): Promise<any> {
    return await this.sendCommand("Runtime.getProperties", { objectId, ownProperties, accessorPropertiesOnly, generatePreview });
}

async releaseObject(objectId: string): Promise<void> {
    await this.sendCommand("Runtime.releaseObject", { objectId });
}

// ==================== DOM Methods ====================
async getOuterHTML(nodeId: number): Promise<string> {
    const result = await this.sendCommand("DOM.getOuterHTML", { nodeId });
    return result.outerHTML;
}

async setOuterHTML(nodeId: number, outerHTML: string): Promise<void> {
    await this.sendCommand("DOM.setOuterHTML", { nodeId, outerHTML });
}

async performSearch(query: string, includeUserAgentShadowDOM?: boolean): Promise<{ searchId: string; resultCount: number }> {
    return await this.sendCommand("DOM.performSearch", { query, includeUserAgentShadowDOM });
}

async getSearchResults(searchId: string, fromIndex: number, toIndex: number): Promise<number[]> {
    const result = await this.sendCommand("DOM.getSearchResults", { searchId, fromIndex, toIndex });
    return result.nodeIds;
}

async setAttributeValue(nodeId: number, name: string, value: string): Promise<void> {
    await this.sendCommand("DOM.setAttributeValue", { nodeId, name, value });
}

async removeAttribute(nodeId: number, name: string): Promise<void> {
    await this.sendCommand("DOM.removeAttribute", { nodeId, name });
}

async resolveNode(nodeId: number, objectGroup?: string): Promise<any> {
    const result = await this.sendCommand("DOM.resolveNode", { nodeId, objectGroup });
    return result.object;
}

async requestChildNodes(nodeId: number, depth?: number, pierce?: boolean): Promise<void> {
    await this.sendCommand("DOM.requestChildNodes", { nodeId, depth, pierce });
}

// ==================== Network Methods ====================
async getResponseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    return await this.sendCommand("Network.getResponseBody", { requestId });
}

async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    await this.sendCommand("Network.setExtraHTTPHeaders", { headers });
}

async setUserAgentOverride(userAgent: string, acceptLanguage?: string, platform?: string, userAgentMetadata?: any): Promise<void> {
    await this.sendCommand("Network.setUserAgentOverride", { userAgent, acceptLanguage, platform, userAgentMetadata });
}

async setCacheDisabled(cacheDisabled: boolean): Promise<void> {
    await this.sendCommand("Network.setCacheDisabled", { cacheDisabled });
}

async getRequestPostData(requestId: string): Promise<{ postData: string; base64Encoded: boolean }> {
    return await this.sendCommand("Network.getRequestPostData", { requestId });
}

async searchInResponseBody(requestId: string, query: string, caseSensitive?: boolean, isRegex?: boolean): Promise<any> {
    return await this.sendCommand("Network.searchInResponseBody", { requestId, query, caseSensitive, isRegex });
}

async deleteCookies(name: string, url?: string, domain?: string, path?: string, partitionKey?: any): Promise<void> {
    await this.sendCommand("Network.deleteCookies", { name, url, domain, path, partitionKey });
}

async setCookies(cookies: Array<{
    name: string; value: string; url?: string; domain?: string; path?: string;
    secure?: boolean; httpOnly?: boolean; sameSite?: 'Strict' | 'Lax' | 'None';
    expires?: number; priority?: 'Low' | 'Medium' | 'High'; sourceScheme?: 'Unset' | 'NonSecure' | 'Secure';
    sourcePort?: number; partitionKey?: any;
}>): Promise<void> {
    await this.sendCommand("Network.setCookies", { cookies });
}

// ==================== Page Methods ====================
async getFrameTree(): Promise<any> {
    const result = await this.sendCommand("Page.getFrameTree", {});
    return result.frameTree;
}

async printToPDF(options?: any): Promise<string> {
    const result = await this.sendCommand("Page.printToPDF", options || {});
    return result.data;
}

async reload(ignoreCache?: boolean, scriptToEvaluateOnLoad?: string, loaderId?: string): Promise<void> {
    await this.sendCommand("Page.reload", { ignoreCache, scriptToEvaluateOnLoad, loaderId });
}

async bringToFront(): Promise<void> {
    await this.sendCommand("Page.bringToFront", {});
}

async closePage(): Promise<void> {
    await this.sendCommand("Page.close", {});
}

// ==================== DOMStorage Methods ====================
async enableDOMStorage(): Promise<void> {
    await this.sendCommand("DOMStorage.enable", {});
}

async getDOMStorageItems(storageId: { securityOrigin: string; isLocalStorage: boolean }): Promise<Array<[string, string]>> {
    const result = await this.sendCommand("DOMStorage.getDOMStorageItems", { storageId });
    return result.entries;
}

async setDOMStorageItem(storageId: { securityOrigin: string; isLocalStorage: boolean }, key: string, value: string): Promise<void> {
    await this.sendCommand("DOMStorage.setDOMStorageItem", { storageId, key, value });
}

async removeDOMStorageItem(storageId: { securityOrigin: string; isLocalStorage: boolean }, key: string): Promise<void> {
    await this.sendCommand("DOMStorage.removeDOMStorageItem", { storageId, key });
}

async clearDOMStorage(storageId: { securityOrigin: string; isLocalStorage: boolean }): Promise<void> {
    await this.sendCommand("DOMStorage.clear", { storageId });
}

// ==================== CacheStorage Methods ====================
async enableCacheStorage(): Promise<void> {
    await this.sendCommand("CacheStorage.enable", {});
}

async requestCacheNames(securityOrigin?: string): Promise<any> {
    return await this.sendCommand("CacheStorage.requestCacheNames", { securityOrigin });
}

async deleteCache(cacheId: string): Promise<void> {
    await this.sendCommand("CacheStorage.deleteCache", { cacheId });
}

async deleteEntry(cacheId: string, request: string, method?: string): Promise<void> {
    await this.sendCommand("CacheStorage.deleteEntry", { cacheId, request, method });
}

async requestEntries(cacheId: string, skipCount?: number, pageSize?: number): Promise<any> {
    return await this.sendCommand("CacheStorage.requestEntries", { cacheId, skipCount, pageSize });
}

// ==================== Browser Methods ====================
async getBrowserVersion(): Promise<any> {
    return await this.sendCommand("Browser.getVersion", {});
}

async setPermission(permission: string, setting: 'granted' | 'denied' | 'prompt', origin?: string): Promise<void> {
    await this.sendCommand("Browser.setPermission", { permission: { name: permission }, setting, origin });
}

async grantPermissions(permissions: string[], origin?: string): Promise<void> {
    await this.sendCommand("Browser.grantPermissions", { permissions: permissions.map(p => ({ name: p })), origin });
}

async resetPermissions(): Promise<void> {
    await this.sendCommand("Browser.resetPermissions", {});
}

async setDownloadBehavior(behavior: 'deny' | 'allow' | 'default', downloadPath?: string): Promise<void> {
    await this.sendCommand("Browser.setDownloadBehavior", { behavior, downloadPath });
}

// ==================== Emulation Methods ====================
async setDeviceMetricsOverride(options: {
    width: number; height: number; deviceScaleFactor: number; mobile: boolean;
    scale?: number; screenWidth?: number; screenHeight?: number; positionX?: number; positionY?: number;
    dontSetVisibleSize?: boolean; screenOrientation?: { type: string; angle: number };
    viewport?: { x: number; y: number; width: number; height: number; scale: number };
}): Promise<void> {
    await this.sendCommand("Emulation.setDeviceMetricsOverride", options);
}

async emulateUserAgent(userAgent: string, acceptLanguage?: string, platform?: string, userAgentMetadata?: any): Promise<void> {
    await this.sendCommand("Emulation.setUserAgentOverride", { userAgent, acceptLanguage, platform, userAgentMetadata });
}

// ==================== IO Methods ====================
async ioRead(stream: string, offset?: number, size?: number): Promise<{ data: string; base64Encoded: boolean; eof: boolean }> {
    return await this.sendCommand("IO.read", { handle: stream, offset, size });
}

async ioClose(stream: string): Promise<void> {
    await this.sendCommand("IO.close", { handle: stream });
}

// ==================== Security Methods ====================
async enableSecurity(): Promise<void> {
    await this.sendCommand("Security.enable", {});
}

async getSecurityState(): Promise<any> {
    return await this.sendCommand("Security.getSecurityState", {});
}

// ==================== SystemInfo Methods ====================
async getSystemInfo(): Promise<any> {
    return await this.sendCommand("SystemInfo.getInfo", {});
}

async getProcessInfo(): Promise<any> {
    return await this.sendCommand("SystemInfo.getProcessInfo", {});
}

// ==================== Debugger Methods ====================
async enableDebugger(): Promise<void> {
    await this.sendCommand("Debugger.enable", {});
}

async disableDebugger(): Promise<void> {
    await this.sendCommand("Debugger.disable", {});
}

async pauseDebugger(): Promise<void> {
    await this.sendCommand("Debugger.pause", {});
}

async resumeDebugger(): Promise<void> {
    await this.sendCommand("Debugger.resume", {});
}

async stepOver(): Promise<void> {
    await this.sendCommand("Debugger.stepOver", {});
}

async stepInto(): Promise<void> {
    await this.sendCommand("Debugger.stepInto", {});
}

async stepOut(): Promise<void> {
    await this.sendCommand("Debugger.stepOut", {});
}

async setBreakpointByUrl(url: string, lineNumber: number, columnNumber?: number, condition?: string): Promise<{ breakpointId: string }> {
    return await this.sendCommand("Debugger.setBreakpointByUrl", { url, lineNumber, columnNumber, condition });
}

async removeBreakpoint(breakpointId: string): Promise<void> {
    await this.sendCommand("Debugger.removeBreakpoint", { breakpointId });
}

async getScriptSource(scriptId: string): Promise<{ scriptSource: string; bytecode: string }> {
    return await this.sendCommand("Debugger.getScriptSource", { scriptId });
}

// ==================== IndexedDB Methods ====================
async enableIndexedDB(): Promise<void> {
    await this.sendCommand("IndexedDB.enable", {});
}

async disableIndexedDB(): Promise<void> {
    await this.sendCommand("IndexedDB.disable", {});
}

async requestDatabaseNames(securityOrigin: string): Promise<{ databaseNames: string[] }> {
    return await this.sendCommand("IndexedDB.requestDatabaseNames", { securityOrigin });
}

async requestDatabase(securityOrigin: string, databaseName: string): Promise<any> {
    return await this.sendCommand("IndexedDB.requestDatabase", { securityOrigin, databaseName });
}

async requestData(securityOrigin: string, databaseName: string, objectStoreName: string, indexName?: string, idbKeyRange?: any, skipCount?: number, pageSize?: number): Promise<any> {
    return await this.sendCommand("IndexedDB.requestData", {
        securityOrigin, databaseName, objectStoreName, indexName, idbKeyRange, skipCount, pageSize
    });
}

async clearObjectStore(securityOrigin: string, databaseName: string, objectStoreName: string): Promise<void> {
    await this.sendCommand("IndexedDB.clearObjectStore", { securityOrigin, databaseName, objectStoreName });
}

async deleteDatabase(securityOrigin: string, databaseName: string): Promise<void> {
    await this.sendCommand("IndexedDB.deleteDatabase", { securityOrigin, databaseName });
}

// ==================== Memory Methods ====================
async enableMemory(): Promise<void> {
    await this.sendCommand("Memory.enable", {});
}

async getDOMCounters(): Promise<any> {
    return await this.sendCommand("Memory.getDOMCounters", {});
}

async forceGarbageCollection(): Promise<void> {
    await this.sendCommand("Memory.forciblyPurgeJavaScriptMemory", {});
}

async startMemorySampling(samplingInterval?: number, suppressRandomness?: boolean): Promise<void> {
    await this.sendCommand("Memory.startSampling", { samplingInterval, suppressRandomness });
}

async stopMemorySampling(): Promise<{ profile: any }> {
    return await this.sendCommand("Memory.stopSampling", {});
}

// ==================== ServiceWorker Methods ====================
async enableServiceWorker(): Promise<void> {
    await this.sendCommand("ServiceWorker.enable", {});
}

async setForceUpdateOnPageLoad(forceUpdateOnPageLoad: boolean): Promise<void> {
    await this.sendCommand("ServiceWorker.setForceUpdateOnPageLoad", { forceUpdateOnPageLoad });
}

async skipWaiting(activationId?: string): Promise<void> {
    await this.sendCommand("ServiceWorker.skipWaiting", { activationId });
}

// ==================== WebAuthn Methods ====================
async enableWebAuthn(): Promise<void> {
    await this.sendCommand("WebAuthn.enable", {});
}

async addVirtualAuthenticator(options: {
    protocol: string; transport: string; hasResidentKey?: boolean;
    hasUserVerification?: boolean; isUserConsenting?: boolean; isUserVerified?: boolean;
}): Promise<{ authenticatorId: string }> {
    return await this.sendCommand("WebAuthn.addVirtualAuthenticator", options);
}

async removeVirtualAuthenticator(authenticatorId: string): Promise<void> {
    await this.sendCommand("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
}

// ==================== Profiler Methods ====================
async enableProfiler(): Promise<void> {
    await this.sendCommand("Profiler.enable", {});
}

async disableProfiler(): Promise<void> {
    await this.sendCommand("Profiler.disable", {});
}

async startProfiler(): Promise<void> {
    await this.sendCommand("Profiler.start", {});
}

async stopProfiler(): Promise<{ profile: any }> {
    return await this.sendCommand("Profiler.stop", {});
}

async getBestEffortCoverage(): Promise<{ result: any[] }> {
    return await this.sendCommand("Profiler.getBestEffortCoverage", {});
}

async startPreciseCoverage(callCount?: boolean, detailed?: boolean, allowFuntionLocations?: boolean): Promise<void> {
    await this.sendCommand("Profiler.startPreciseCoverage", { callCount, detailed, allowFuntionLocations });
}

async stopPreciseCoverage(): Promise<void> {
    await this.sendCommand("Profiler.stopPreciseCoverage", {});
}

async takePreciseCoverage(): Promise<{ result: any[] }> {
    return await this.sendCommand("Profiler.takePreciseCoverage", {});
}

// ==================== HeapProfiler Methods ====================
async enableHeapProfiler(): Promise<void> {
    await this.sendCommand("HeapProfiler.enable", {});
}

async disableHeapProfiler(): Promise<void> {
    await this.sendCommand("HeapProfiler.disable", {});
}

async heapProfilerCollectGarbage(): Promise<void> {
    await this.sendCommand("HeapProfiler.collectGarbage", {});
}

async getHeapObjectId(objectId: string): Promise<{ heapSnapshotObjectId: string }> {
    return await this.sendCommand("HeapProfiler.getHeapObjectId", { objectId });
}

async getObjectByHeapObjectId(heapSnapshotObjectId: string, objectGroup?: string): Promise<any> {
    return await this.sendCommand("HeapProfiler.getObjectByHeapObjectId", { heapSnapshotObjectId, objectGroup });
}

async getHeapSamplingProfile(): Promise<{ profile: any }> {
    return await this.sendCommand("HeapProfiler.getSamplingProfile", {});
}

async startHeapSampling(samplingInterval?: number, suppressRandomness?: boolean): Promise<void> {
    await this.sendCommand("HeapProfiler.startSampling", { samplingInterval, suppressRandomness });
}

async stopHeapSampling(): Promise<{ profile: any }> {
    return await this.sendCommand("HeapProfiler.stopSampling", {});
}

async takeHeapSnapshot(reportProgress?: boolean, treatGlobalObjectsAsRoots?: boolean, captureNumericValue?: boolean): Promise<void> {
    await this.sendCommand("HeapProfiler.takeHeapSnapshot", { reportProgress, treatGlobalObjectsAsRoots, captureNumericValue });
}

    /**
     * Click at coordinates — fast path. Direct CDP dispatch, no Bezier/tremor/jitter.
     */
    async click(x: number, y: number, button: "left" | "middle" | "right" = "left", _targetWidth?: number): Promise<void> {
        const rx = Math.round(Number(x));
        const ry = Math.round(Number(y));
        this.mousePosition = { x: rx, y: ry };
        await this.sendCommand("Input.dispatchMouseEvent", {
            type: "mousePressed", x: rx, y: ry, button, clickCount: 1, pointerType: "mouse",
        });
        await this.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseReleased", x: rx, y: ry, button, clickCount: 1, pointerType: "mouse",
        });
    }

    /**
     * Move mouse to coordinates — fast path. Single CDP dispatch, no Bezier/tremor interpolation.
     */
    async moveMouse(x: number, y: number, _targetWidth?: number): Promise<void> {
        const rx = Math.round(Number(x));
        const ry = Math.round(Number(y));
        this.mousePosition = { x: rx, y: ry };
        await this.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseMoved", x: rx, y: ry, button: "none", pointerType: "mouse",
        });
    }

    getMousePosition(): { x: number; y: number } {
        return this.mousePosition ?? { x: 300, y: 300 };
    }

    async moveMouseToSelector(selector: string): Promise<boolean> {
        try {
            const center = await this.getElementCenter(selector);
            if (!center) return false;
            await this.moveMouse(center.x, center.y);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Scroll from the current or supplied pointer location — fast path. Single wheel event.
     */
    async wheel(deltaX: number, deltaY: number, x?: number, y?: number): Promise<void> {
        const ox = Math.round(Number(x ?? this.mousePosition?.x ?? 0));
        const oy = Math.round(Number(y ?? this.mousePosition?.y ?? 0));
        this.mousePosition = { x: ox, y: oy };
        await this.sendCommand("Input.dispatchMouseWheel", {
            x: ox, y: oy, deltaX: Math.round(Number(deltaX)), deltaY: Math.round(Number(deltaY)),
        });
    }

    async typeText(text: string): Promise<void> {
        // Fast path — insert entire text in one CDP call, no per-character delays or typo simulation.
        if (text) {
            await this.sendCommand("Input.insertText", { text });
        }
    }

    async pressKey(key: string, modifiers: string[] = []): Promise<void> {
        const modifierMask = this.modifierMask(modifiers);
        const keyDef = this.keyDefinition(key);
        await this.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: keyDef.key,
            code: keyDef.code,
            windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
            nativeVirtualKeyCode: keyDef.windowsVirtualKeyCode,
            modifiers: modifierMask,
        });
        await this.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: keyDef.key,
            code: keyDef.code,
            windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
            nativeVirtualKeyCode: keyDef.windowsVirtualKeyCode,
            modifiers: modifierMask,
        });
    }

    private modifierMask(modifiers: string[]): number {
        return modifiers.reduce((mask, modifier) => {
            const key = modifier.toLowerCase();
            if (key === "alt") return mask | 1;
            if (key === "ctrl" || key === "control") return mask | 2;
            if (key === "meta" || key === "cmd" || key === "command") return mask | 4;
            if (key === "shift") return mask | 8;
            return mask;
        }, 0);
    }

    private keyDefinition(key: string): { key: string; code: string; windowsVirtualKeyCode: number } {
        const normalized = key.length === 1 ? key : key.toLowerCase();
        const special: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
            enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
            tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
            escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
            esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
            backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
            delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
            arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
            arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
            arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
            arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
            home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
            end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
            pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
            pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
        };
        if (special[normalized]) return special[normalized];
        const upper = key.toUpperCase();
        const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(key) ? `Digit${key}` : key;
        return { key, code, windowsVirtualKeyCode: upper.charCodeAt(0) };
    }

    /**
     * Enable events
     */
    async enableEvents(events: string[]): Promise<void> {
        for (const event of events) {
            try {
                await this.sendCommand(event, {});
            } catch {
                // Some enable commands have different params
            }
        }
    }

    on(event: string, listener: (params: any) => void): void {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event)!.push(listener);
    }

    private emitEvent(method: string, params: any): void {
        const listeners = this.eventListeners.get(method) || [];
        for (const listener of listeners) {
            try {
                listener(params);
            } catch (e) {
                console.error(`[CDP] Event listener error for ${method}:`, e);
            }
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;

        if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            if (!this.reconnectGaveUp) {
                this.reconnectGaveUp = true;
                console.error(
                    `[CDP] Giving up: could not re-attach after ${RECONNECT_MAX_ATTEMPTS} attempts ` +
                    `(last target: ${this.activeTarget?.url ?? "unknown"}). ` +
                    `Call connect_browser or launch_browser to reattach.`
                );
            }
            return;
        }

        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            RECONNECT_MAX_DELAY_MS
        );
        this.reconnectAttempts++;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.activeTarget) return;
            console.error(
                `[CDP] Reconnect attempt ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS} ` +
                `in ${Math.round(delay / 1000)}s...`
            );
            this.attachToTarget(this.activeTarget).catch(() => {});
        }, delay);
    }

    private async waitForChrome(port: number, timeoutMs: number = 10000): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                await this.listTargets(port);
                return;
            } catch {
                await new Promise((r) => setTimeout(r, 500));
            }
        }
        throw new Error(`Chrome did not start on port ${port} within ${timeoutMs}ms`);
    }

    private getBrowserPaths(): { name: string; paths: string[] }[] {
        const platform = os.platform();
        
        const chromePaths: string[] = [];
        const edgePaths: string[] = [];
        const bravePaths: string[] = [];
        const firefoxPaths: string[] = [];

        if (platform === "win32") {
            chromePaths.push(
                "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
            );
            edgePaths.push(
                "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
                "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
            );
            bravePaths.push(
                "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
                "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
            );
            firefoxPaths.push(
                "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
                "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"
            );
        } else if (platform === "darwin") {
            chromePaths.push(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Chromium.app/Contents/MacOS/Chromium"
            );
            edgePaths.push(
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
            );
            bravePaths.push(
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
            );
            firefoxPaths.push(
                "/Applications/Firefox.app/Contents/MacOS/firefox"
            );
        } else {
            chromePaths.push(
                "/usr/bin/google-chrome",
                "/usr/bin/chromium",
                "/usr/bin/chromium-browser",
                "/snap/bin/chromium"
            );
            edgePaths.push(
                "/usr/bin/microsoft-edge",
                "/snap/bin/microsoft-edge"
            );
            bravePaths.push(
                "/usr/bin/brave-browser",
                "/snap/bin/brave"
            );
            firefoxPaths.push(
                "/usr/bin/firefox",
                "/snap/bin/firefox"
            );
        }

        return [
            { name: "chrome", paths: chromePaths },
            { name: "edge", paths: edgePaths },
            { name: "brave", paths: bravePaths },
            { name: "firefox", paths: firefoxPaths },
        ];
    }

    /**
     * Find first available browser from installed browsers
     */
    async findAvailableBrowser(): Promise<{ name: BrowserName; path: string } | null> {
        const browsers = this.getBrowserPaths();
        
        for (const browser of browsers) {
            for (const p of browser.paths) {
                try {
                    await fs.access(p);
                    return { name: browser.name as BrowserName, path: p };
                } catch {}
            }
        }
        return null;
    }

    private getDefaultUserDataDir(browser: BrowserName): string | null {
        const platform = os.platform();
        if (platform === "win32") {
            const local = process.env.LOCALAPPDATA;
            if (!local) return null;
            if (browser === "brave") return path.join(local, "BraveSoftware", "Brave-Browser", "User Data");
            if (browser === "chrome") return path.join(local, "Google", "Chrome", "User Data");
            if (browser === "edge") return path.join(local, "Microsoft", "Edge", "User Data");
            return null;
        }
        if (platform === "darwin") {
            const home = os.homedir();
            if (browser === "brave") return path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser");
            if (browser === "chrome") return path.join(home, "Library", "Application Support", "Google", "Chrome");
            if (browser === "edge") return path.join(home, "Library", "Application Support", "Microsoft Edge");
            return null;
        }

        const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
        if (browser === "brave") return path.join(config, "BraveSoftware", "Brave-Browser");
        if (browser === "chrome") return path.join(config, "google-chrome");
        if (browser === "edge") return path.join(config, "microsoft-edge");
        return null;
    }

    async listBrowserProfiles(browser: BrowserName = "brave"): Promise<BrowserProfile[]> {
        const userDataDir = this.getDefaultUserDataDir(browser);
        if (!userDataDir) return [];

        const localStatePath = path.join(userDataDir, "Local State");
        let localState: any;
        try {
            localState = JSON.parse(await fs.readFile(localStatePath, "utf8"));
        } catch {
            return [];
        }

        const infoCache = localState?.profile?.info_cache || {};
        const ordered = localState?.profile?.profiles_order || Object.keys(infoCache);
        const profiles: BrowserProfile[] = [];

        for (const directory of ordered) {
            const cache = infoCache[directory] || {};
            const profilePath = path.join(userDataDir, directory);
            try {
                const stat = await fs.stat(profilePath);
                if (!stat.isDirectory()) continue;
            } catch {
                continue;
            }

            const name = cache.name || cache.shortcut_name || directory;
            profiles.push({
                browser,
                id: `${browser}:${directory}`,
                name,
                directory,
                userDataDir,
                lastActive: typeof cache.active_time === "number" ? cache.active_time : undefined,
            });
        }

        return profiles;
    }

    private async resolveBrowserProfile(options?: {
        browser?: BrowserName;
        profile?: string;
        profileDirectory?: string;
        userDataDir?: string;
    }): Promise<{ userDataDir?: string; profileDirectory?: string; profileName?: string }> {
        if (options?.profileDirectory) {
            return {
                userDataDir: options.userDataDir,
                profileDirectory: options.profileDirectory,
                profileName: options.profileDirectory,
            };
        }

        const profile = options?.profile?.trim();
        if (!profile) {
            return { userDataDir: options?.userDataDir };
        }

        const browser = options?.browser || "brave";
        const profiles = await this.listBrowserProfiles(browser);
        const normalized = profile.toLowerCase();
        const match = profiles.find((p) =>
            p.directory.toLowerCase() === normalized ||
            p.name.toLowerCase() === normalized ||
            p.id.toLowerCase() === `${browser}:${normalized}`
        );

        if (!match) {
            const available = profiles.map((p) => `${p.name} (${p.directory})`).join(", ") || "none found";
            throw new Error(`Profile "${profile}" not found for ${browser}. Available profiles: ${available}`);
        }

        return {
            userDataDir: options?.userDataDir || match.userDataDir,
            profileDirectory: match.directory,
            profileName: match.name,
        };
    }

    /**
     * Launch browser with auto-detection
     */
    async launchAuto(options?: {
        headless?: boolean;
        userDataDir?: string;
        profile?: string;
        profileDirectory?: string;
        port?: number;
        browser?: BrowserName;
        extraArgs?: string[];
    }): Promise<void> {
        const port = options?.port ?? 9222;
        let browserPath: string | null = null;
        let browserName = options?.browser;

        if (browserName) {
            // User specified a browser - find its path
            const browsers = this.getBrowserPaths();
            const browser = browsers.find(b => b.name === browserName);
            if (browser) {
                for (const p of browser.paths) {
                    try {
                        await fs.access(p);
                        browserPath = p;
                        break;
                    } catch {}
                }
            }
            if (!browserPath) {
                throw new Error(`${browserName} not found. Please install it or choose a different browser.`);
            }
        } else {
            // Auto-detect first available browser
            const found = await this.findAvailableBrowser();
            if (!found) {
                throw new Error(
                    "No supported browser found. Please install Chrome, Edge, Brave, or Firefox.\n" +
                    "Or specify a browser path manually."
                );
            }
            browserPath = found.path;
            browserName = found.name;
            console.error(`[CDP] Auto-detected browser: ${browserName}`);
        }

        const profile = await this.resolveBrowserProfile({
            browser: browserName,
            profile: options?.profile,
            profileDirectory: options?.profileDirectory,
            userDataDir: options?.userDataDir,
        });
        const userDataDir = profile.userDataDir ?? path.join(os.tmpdir(), `aether-${browserName}-profile`);
        const headless = options?.headless ?? false;

        const args: string[] = [];
        
        // Firefox doesn't support CDP the same way - use remote debugging
        if (browserName === "firefox") {
            args.push(
                "--remote-debugging-port", port.toString(),
                "--profile", userDataDir,
                ...(headless ? ["--headless"] : []),
                ...(options?.extraArgs || []),
                "about:blank"
            );
        } else {
            // Chromium-based browsers (Chrome, Edge, Brave)
            args.push(
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${userDataDir}`,
                ...(profile.profileDirectory ? [`--profile-directory=${profile.profileDirectory}`] : []),
                "--disable-infobars",
                ...(headless ? ["--headless", "--disable-gpu"] : []),
                ...(options?.extraArgs || []),
                "about:blank"
            );
        }

        this.chromeProcess = spawn(browserPath, args, {
            detached: false,
            stdio: "ignore",
        });

        this.chromeProcess.on("exit", () => {
            this.chromeProcess = null;
            this.connected = false;
        });

        // Wait for browser to start
        await this.waitForChrome(port);
        await this.connect(port);
    }

    /**
     * Kill the browser process
     */
    async killBrowser(): Promise<void> {
        if (this.chromeProcess) {
            console.error("[CDP] Killing browser process...");
            try {
                if (os.platform() === "win32") {
                    spawn("taskkill", ["/pid", this.chromeProcess.pid!.toString(), "/f", "/t"]);
                } else {
                    this.chromeProcess.kill("SIGKILL");
                }
            } catch (e) {
                console.error("[CDP] Error killing browser:", e);
            }
            this.chromeProcess = null;
        }
        await this.disconnect();
    }

    /**
     * List all available browsers on the system
     */
    async listAvailableBrowsers(): Promise<{ name: string; path: string }[]> {
        const browsers = this.getBrowserPaths();
        const available: { name: string; path: string }[] = [];
        
        for (const browser of browsers) {
            for (const p of browser.paths) {
                try {
                    await fs.access(p);
                    available.push({ name: browser.name, path: p });
                    break; // Found one path for this browser
                } catch {}
            }
        }
        return available;
    }

    /**
     * Disconnect and cleanup
     */
    async disconnect(): Promise<void> {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts = 0;
        this.reconnectGaveUp = false;
        if (this.extensionMode) {
            await sendCommandToExtension("session.detach", {}).catch(() => {});
            this.extensionMode = false;
        }
        this.removeExtensionEventListener?.();
        this.removeExtensionEventListener = null;
        if (this.ws) {
            this.intentionalClose = true;
            this.ws.close();
            this.ws = null;
        }
        if (this.chromeProcess) {
            this.chromeProcess.kill();
            this.chromeProcess = null;
        }
        this.connected = false;
        this.activeTarget = null;
    }

    isConnected(): boolean {
        return this.extensionMode
            ? this.connected && isExtensionConnected()
            : this.connected && this.ws?.readyState === WebSocket.OPEN;
    }

    getActiveTarget(): CdpTarget | null {
        return this.activeTarget;
    }
}

// Singleton instance
let cdpClient: CdpClient | null = null;

export function getCdpClient(): CdpClient {
    if (!cdpClient) {
        cdpClient = new CdpClient();
    }
    return cdpClient;
}

export async function ensureCdpConnected(port?: number): Promise<CdpClient> {
    const client = getCdpClient();
    if (!client.isConnected()) {
        await client.connect(port);
    }
    return client;
}
