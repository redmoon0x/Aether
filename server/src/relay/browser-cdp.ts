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
    private readonly byTab = new Map<number, string>();
    private nextSession = 1;
    private discover = false;
    private autoAttach = false;

    constructor(
        private readonly browserId: string,
        private readonly host: BrowserHost,
        private readonly sink: BrowserCdpSink
    ) {}

    private targetId(tabId: number): string {
        return `${this.browserId}:${tabId}`;
    }

    private tabIdFromTarget(targetId: string): number | null {
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
        const sessionId = this.byTab.get(tabId);
        if (sessionId) {
            this.sessions.delete(sessionId);
            this.byTab.delete(tabId);
            this.sink.send({ method: "Target.detachedFromTarget", params: { sessionId, targetId: this.targetId(tabId) } });
        }
        if (this.discover) this.sink.send({ method: "Target.targetDestroyed", params: { targetId: this.targetId(tabId) } });
    }

    onTabUpdated(tab: CdpTab): void {
        if (this.discover) this.sink.send({ method: "Target.targetInfoChanged", params: { targetInfo: this.targetInfo(tab) } });
    }

    /** Forward a page event to the session that owns the tab. */
    onEvent(tabId: number, method: string, params: any): void {
        const sessionId = this.byTab.get(tabId);
        if (!sessionId) return;
        this.sink.send({ method, params, sessionId });
    }

    private async attachInternal(tabId: number): Promise<string> {
        const existing = this.byTab.get(tabId);
        if (existing) return existing;

        await this.host.attach(tabId);
        const tabs = await this.host.listTabs();
        const tab = tabs.find((candidate) => candidate.tabId === tabId);
        if (!tab) throw new Error(`Tab ${tabId} is no longer open.`);

        const sessionId = `aether-${this.nextSession++}`;
        const record = { sessionId, tabId, targetId: this.targetId(tabId) };
        this.sessions.set(sessionId, record);
        this.byTab.set(tabId, sessionId);

        this.sink.send({
            method: "Target.attachedToTarget",
            params: {
                sessionId,
                targetInfo: { ...this.targetInfo(tab), attached: true },
                waitingForDebugger: false,
            },
        });
        return sessionId;
    }

    private async detachInternal(sessionId: string): Promise<void> {
        const record = this.sessions.get(sessionId);
        if (!record) return;
        this.sessions.delete(sessionId);
        if (this.byTab.get(record.tabId) === sessionId) this.byTab.delete(record.tabId);
        // Keep the chrome.debugger attachment: another CDP session (or a
        // reconnect) may still drive this tab. Only the logical session ends.
        this.sink.send({
            method: "Target.detachedFromTarget",
            params: { sessionId, targetId: record.targetId },
        });
    }

    async handle(message: { id: number; method: string; params?: any; sessionId?: string }): Promise<any> {
        const params = message.params ?? {};

        if (message.sessionId) {
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
                const tabId = this.tabIdFromTarget(String(params.targetId ?? ""));
                if (tabId === null) throw new Error(`Unknown target: ${params.targetId}`);
                const sessionId = await this.attachInternal(tabId);
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

            case "Target.createTarget": {
                const tab = await this.host.createTab(String(params.url ?? "about:blank"), "agent");
                if (this.discover) {
                    this.sink.send({ method: "Target.targetCreated", params: { targetInfo: this.targetInfo(tab) } });
                }
                if (this.autoAttach) await this.attachInternal(tab.tabId);
                return { targetId: this.targetId(tab.tabId) };
            }

            case "Target.closeTarget": {
                const tabId = this.tabIdFromTarget(String(params.targetId ?? ""));
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

    /** Session id currently attached to a tab, if any. */
    sessionForTab(tabId: number): string | undefined {
        return this.byTab.get(tabId);
    }
}
