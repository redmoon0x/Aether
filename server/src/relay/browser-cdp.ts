/**
 * Browser-level CDP dispatcher.
 *
 * Playwright's `connectOverCDP` needs a browser endpoint that speaks the
 * `Target` domain and multiplexes page commands over flattened sessions. The
 * extension only exposes one `chrome.debugger` per tab, so this class maps
 * browser-level targets/sessions onto extension tabs and forwards the rest.
 *
 * One instance per connected browser.
 */
import { assertCdpAllowed } from "./guardrails";

export interface CdpTab {
    tabId: number;
    url: string;
    title: string;
    active: boolean;
    windowId?: number;
    groupId?: number;
    attached?: boolean;
}

export interface BrowserHost {
    listTabs(): Promise<CdpTab[]>;
    attach(tabId: number): Promise<void>;
    detach(tabId: number): Promise<void>;
    createTab(url: string, sessionId?: string): Promise<CdpTab>;
    closeTab(tabId: number): Promise<void>;
    group(tabId: number, sessionId: string): Promise<void>;
    send(tabId: number, method: string, params: any): Promise<any>;
    isOwned(tabId: number): boolean;
    /**
     * The tab's main frame id. Chrome uses it as the page target id, and
     * Playwright maps frames back to sessions through that id.
     */
    frameId(tabId: number): Promise<string | null>;
}

export interface BrowserCdpSink {
    send(message: unknown): void;
}

interface SessionRecord {
    sessionId: string;
    tabId: number;
    targetId: string;
}

export class BrowserCdpConnection {
    private readonly sessions = new Map<string, SessionRecord>();
    /** Every session attached to a tab; Chrome allows more than one. */
    private readonly byTab = new Map<number, Set<string>>();
    private readonly primaryByTab = new Map<number, string>();
    private readonly frameIds = new Map<number, string>();
    private readonly tabsByFrame = new Map<string, number>();
    private readonly browserSessions = new Set<string>();
    private nextSession = 1;
    private discover = false;
    private autoAttach = false;

    constructor(
        private readonly browserId: string,
        private readonly host: BrowserHost,
        private readonly sink: BrowserCdpSink
    ) {}

    private targetId(tabId: number): string {
        return this.frameIds.get(tabId) ?? `${this.browserId}:${tabId}`;
    }

    /** Learn the tab's main frame id, which is the id Chrome reports as its target. */
    private async identify(tabId: number): Promise<string | null> {
        const known = this.frameIds.get(tabId);
        if (known) return known;
        const frameId = await this.host.frameId(tabId).catch(() => null);
        if (!frameId) return null;
        this.frameIds.set(tabId, frameId);
        this.tabsByFrame.set(frameId, tabId);
        return frameId;
    }

    /** Resolve a target id, learning frame ids of owned tabs if needed. */
    private async resolveTarget(targetId: string): Promise<number | null> {
        const known = this.tabIdFromTarget(targetId);
        if (known !== null) return known;
        for (const tab of await this.host.listTabs()) {
            if (this.frameIds.has(tab.tabId)) continue;
            await this.identify(tab.tabId);
            const mapped = this.tabsByFrame.get(targetId);
            if (mapped !== undefined) return mapped;
        }
        return this.tabIdFromTarget(targetId);
    }

    private tabIdFromTarget(targetId: string): number | null {
        const known = this.tabsByFrame.get(targetId);
        if (known !== undefined) return known;
        if (!targetId.startsWith(`${this.browserId}:`)) return null;
        const id = Number(targetId.slice(this.browserId.length + 1));
        return Number.isFinite(id) ? id : null;
    }

    private targetInfo(tab: CdpTab) {
        const targetId = this.targetId(tab.tabId);
        return {
            targetId,
            type: "page",
            title: tab.title || tab.url || "Aether tab",
            url: tab.url || "about:blank",
            attached: this.byTab.has(tab.tabId),
            canAccessOpener: false,
            // Playwright asserts on this while handling attachedToTarget; every
            // extension tab belongs to the single context of its browser.
            browserContextId: `aether-${this.browserId}`,
        };
    }

    /** Emit events for extension-side tab lifecycle. */
    async onTabCreated(tab: CdpTab): Promise<void> {
        if (this.discover) this.sink.send({ method: "Target.targetCreated", params: { targetInfo: this.targetInfo(tab) } });
        if (this.autoAttach) await this.attachInternal(tab.tabId);
    }

    onTabClosed(tabId: number): void {
        const targetId = this.targetId(tabId);
        for (const sessionId of this.byTab.get(tabId) ?? []) {
            this.sessions.delete(sessionId);
            this.sink.send({ method: "Target.detachedFromTarget", params: { sessionId, targetId } });
        }
        this.byTab.delete(tabId);
        this.primaryByTab.delete(tabId);
        if (this.discover) this.sink.send({ method: "Target.targetDestroyed", params: { targetId } });
        const frameId = this.frameIds.get(tabId);
        if (frameId) this.tabsByFrame.delete(frameId);
        this.frameIds.delete(tabId);
    }

    onTabUpdated(tab: CdpTab): void {
        if (this.discover) this.sink.send({ method: "Target.targetInfoChanged", params: { targetInfo: this.targetInfo(tab) } });
    }

    private sessionsOf(tabId: number): Set<string> {
        const existing = this.byTab.get(tabId);
        if (existing) return existing;
        const created = new Set<string>();
        this.byTab.set(tabId, created);
        return created;
    }

    /** Forward a page event to every session attached to the tab. */
    onEvent(tabId: number, method: string, params: any): void {
        for (const sessionId of this.byTab.get(tabId) ?? []) {
            this.sink.send({ method, params, sessionId });
        }
    }

    /**
     * Attach a tab and return the new session id.
     *
     * `fresh` mints a session even when the tab is already attached: Chrome
     * allows several sessions per target and Playwright's `newCDPSession`
     * relies on getting its own. Collapsing them made detaching that extra
     * session tear the page down. A session-scoped attach reports
     * `attachedToTarget` inside the requesting session, not at the root.
     */
    private async attachInternal(tabId: number, options: { fresh?: boolean; notify?: string } = {}): Promise<string> {
        const sessions = this.sessionsOf(tabId);
        const primary = this.primaryByTab.get(tabId);
        if (!options.fresh && primary && sessions.has(primary)) return primary;

        await this.host.attach(tabId);
        const tabs = await this.host.listTabs();
        const tab = tabs.find((candidate) => candidate.tabId === tabId);
        if (!tab) throw new Error(`Tab ${tabId} is no longer open.`);
        // Chrome reports the page target as its main frame; Playwright needs
        // that to map the frame it gets from Page.getFrameTree back to us.
        await this.identify(tabId);

        const sessionId = `aether-${this.nextSession++}`;
        this.sessions.set(sessionId, { sessionId, tabId, targetId: this.targetId(tabId) });
        sessions.add(sessionId);
        if (!primary) this.primaryByTab.set(tabId, sessionId);

        const payload = {
            method: "Target.attachedToTarget",
            params: {
                sessionId,
                targetInfo: { ...this.targetInfo(tab), attached: true },
                waitingForDebugger: false,
            },
        };
        this.sink.send(options.notify ? { ...payload, sessionId: options.notify } : payload);
        return sessionId;
    }

    private async detachInternal(sessionId: string, notify?: string): Promise<void> {
        const record = this.sessions.get(sessionId);
        if (!record) return;
        this.sessions.delete(sessionId);
        const sessions = this.byTab.get(record.tabId);
        if (sessions) {
            sessions.delete(sessionId);
            if (this.primaryByTab.get(record.tabId) === sessionId) {
                const next = sessions.values().next();
                if (next.done) this.primaryByTab.delete(record.tabId);
                else this.primaryByTab.set(record.tabId, next.value);
            }
        }
        // Keep the chrome.debugger attachment: another CDP session (or a
        // reconnect) may still drive this tab. Only the logical session ends.
        const payload = { method: "Target.detachedFromTarget", params: { sessionId, targetId: record.targetId } };
        this.sink.send(notify ? { ...payload, sessionId: notify } : payload);
    }

    async handle(message: { id: number; method: string; params?: any; sessionId?: string }): Promise<any> {
        const params = message.params ?? {};

        if (message.sessionId) {
            if (this.browserSessions.has(message.sessionId)) {
                // A browser-level session carries Target commands; everything
                // else belongs to a page, which has its own session.
                if (message.method === "Target.detachFromTarget") {
                    if (params.sessionId === message.sessionId) {
                        this.browserSessions.delete(message.sessionId);
                        return {};
                    }
                    if (typeof params.sessionId === "string") {
                        // Report the detach inside the session that asked for it,
                        // the way Chrome does, so the root page map is untouched.
                        await this.detachInternal(params.sessionId, message.sessionId);
                    }
                    return {};
                }
                if (message.method === "Target.attachToTarget") {
                    if (params.flatten === false) throw new Error("Aether only supports flattened CDP sessions.");
                    const sessionTab = await this.resolveTarget(String(params.targetId ?? ""));
                    if (sessionTab === null) throw new Error(`Unknown target: ${params.targetId}`);
                    const attached = await this.attachInternal(sessionTab, { fresh: true, notify: message.sessionId });
                    return { sessionId: attached };
                }
                return await this.handle({ id: message.id, method: message.method, params });
            }
            return await this.handleSessionCommand(message.sessionId, message.method, params);
        }

        assertCdpAllowed(message.method);

        switch (message.method) {
            case "Browser.getVersion":
                return {
                    protocolVersion: "1.3",
                    // Playwright expects a Chrome-like product string.
                    product: "Chrome/130.0.0.0",
                    revision: "",
                    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                    jsVersion: "",
                };

            case "Target.setDiscoverTargets": {
                this.discover = params.discover !== false;
                if (this.discover) {
                    for (const tab of await this.host.listTabs()) {
                        this.sink.send({ method: "Target.targetCreated", params: { targetInfo: this.targetInfo(tab) } });
                    }
                }
                return {};
            }

            case "Target.setAutoAttach": {
                if (params.flatten === false) throw new Error("Aether only supports flattened CDP sessions.");
                this.autoAttach = params.autoAttach !== false;
                if (this.autoAttach) {
                    for (const tab of await this.host.listTabs()) await this.attachInternal(tab.tabId);
                }
                return {};
            }

            case "Target.attachToTarget": {
                if (params.flatten === false) throw new Error("Aether only supports flattened CDP sessions.");
                const tabId = await this.resolveTarget(String(params.targetId ?? ""));
                if (tabId === null) throw new Error(`Unknown target: ${params.targetId}`);
                const sessionId = await this.attachInternal(tabId, { fresh: true });
                return { sessionId };
            }

            case "Target.detachFromTarget": {
                const tabId = params.targetId ? this.tabIdFromTarget(String(params.targetId)) : null;
                const sessionId = params.sessionId ?? (tabId === null ? undefined : this.byTab.get(tabId));
                if (sessionId) await this.detachInternal(String(sessionId));
                return {};
            }

            case "Target.getTargets": {
                const tabs = await this.host.listTabs();
                return { targetInfos: tabs.map((tab) => this.targetInfo(tab)) };
            }

            case "Target.getTargetInfo": {
                // No targetId asks for the browser target itself. Playwright
                // sends this on connect — including to a browser that has no
                // page yet — so it must never fail on an empty target list.
                if (!params.targetId) {
                    return {
                        targetInfo: {
                            targetId: this.browserId,
                            type: "browser",
                            title: "",
                            url: "",
                            attached: true,
                        },
                    };
                }
                const tabId = this.tabIdFromTarget(String(params.targetId));
                const tabs = await this.host.listTabs();
                const tab = tabId === null ? undefined : tabs.find((candidate) => candidate.tabId === tabId);
                if (!tab) throw new Error(`Unknown target: ${params.targetId}`);
                return { targetInfo: this.targetInfo(tab) };
            }

            case "Target.getBrowserContexts":
                return { browserContextIds: [] };

            // Playwright's `newCDPSession` routes through a browser session.
            case "Target.attachToBrowserTarget": {
                const sessionId = `aether-browser-${this.nextSession++}`;
                this.browserSessions.add(sessionId);
                return { sessionId };
            }

            case "Target.createTarget": {
                const tab = await this.host.createTab(String(params.url ?? "about:blank"), "agent");
                await this.identify(tab.tabId);
                if (this.discover) {
                    this.sink.send({ method: "Target.targetCreated", params: { targetInfo: this.targetInfo(tab) } });
                }
                if (this.autoAttach) await this.attachInternal(tab.tabId);
                return { targetId: this.targetId(tab.tabId) };
            }

            case "Target.closeTarget": {
                const tabId = await this.resolveTarget(String(params.targetId ?? ""));
                if (tabId === null || !this.host.isOwned(tabId)) {
                    throw new Error("Aether can only close tabs it opened.");
                }
                await this.host.closeTab(tabId);
                return { success: true };
            }

            case "Target.activateTarget":
                // Refused in guardrails; never raise a window over the user's work.
                return {};

            // Playwright may touch these; they are either harmless to accept or
            // belong to window management Aether deliberately does not expose.
            case "Browser.setDownloadBehavior":
            case "Browser.setWindowBounds":
            case "Target.setRemoteLocations":
                return {};

            case "Browser.getWindowBounds": {
                const tabs = await this.host.listTabs();
                return { bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: "normal" }, windowId: tabs[0]?.windowId ?? 1 };
            }

            case "Browser.getWindowForTarget": {
                const tabId = params.targetId ? this.tabIdFromTarget(String(params.targetId)) : null;
                const tabs = await this.host.listTabs();
                const tab = tabId === null ? tabs[0] : tabs.find((candidate) => candidate.tabId === tabId);
                return { windowId: tab?.windowId ?? 1, bounds: { left: 0, top: 0, width: 1280, height: 800 } };
            }

            case "Target.sendMessageToTarget":
                throw new Error("Aether only supports flattened CDP sessions (sessionId on each command).");

            default:
                throw new Error(`Unsupported browser-level CDP command: ${message.method}`);
        }
    }

    private async handleSessionCommand(sessionId: string, method: string, params: any): Promise<any> {
        const record = this.sessions.get(sessionId);
        if (!record) throw new Error(`Unknown CDP session: ${sessionId}`);

        assertCdpAllowed(method);

        if (method === "Runtime.runIfWaitingForDebugger") return {};
        if (method === "Target.getTargetInfo") {
            const tabs = await this.host.listTabs();
            const tab = tabs.find((candidate) => candidate.tabId === record.tabId);
            if (!tab) throw new Error(`Tab ${record.tabId} is no longer open.`);
            return { targetInfo: this.targetInfo(tab) };
        }
        if (method === "Target.setAutoAttach") {
            // OOPIF auto-attach is not represented as separate targets by chrome.debugger.
            return {};
        }
        if (method === "Target.detachFromTarget") {
            await this.detachInternal(sessionId);
            return {};
        }

        return await this.host.send(record.tabId, method, params);
    }

    /** The primary session id attached to a tab, if any. */
    sessionForTab(tabId: number): string | undefined {
        return this.primaryByTab.get(tabId);
    }
}
