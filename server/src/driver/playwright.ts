/**
 * Playwright (Patchright) driver.
 *
 * One `Browser` per browser id. Extension browsers attach to the relay's
 * browser-level CDP endpoint; launched browsers attach to their own
 * `--remote-debugging-port`. Sessions resolve to a page; they never navigate.
 */
import { chromium, type Browser, type Page } from "patchright-core";
import { getExtensionRelay, relayToken } from "../extension-relay";
import { launchedPorts } from "../browser-launch";
import type { BrowserInfo, BrowserTarget, Driver, ResolvedPage, SessionPin } from "./types";

interface CachedBrowser {
    browser: Browser;
    endpoint: string;
}

export class PlaywrightDriver implements Driver {
    private readonly browsers = new Map<string, CachedBrowser>();
    private readonly targetIds = new WeakMap<Page, string>();

    // ─── endpoint discovery ──────────────────────────────────────────

    /**
     * The relay this process serves, or the one another MCP process owns.
     * Asking `/health` lets a second server reuse the first one's browsers.
     */
    private async relayStatus(): Promise<any> {
        let local: any;
        try {
            local = getExtensionRelay().status();
        } catch {
            return { browsers: [] };
        }
        if (Array.isArray(local?.browsers) && local.browsers.length > 0) return local;
        try {
            const response = await fetch(`http://127.0.0.1:${local.port}/health`);
            if (response.ok) return await response.json();
        } catch {
            // No relay is listening (or the fetch is unavailable): use local state.
        }
        return local;
    }

    private async extensionBrowsers(): Promise<{ id: string; name: string; connected: boolean }[]> {
        const status = await this.relayStatus();
        return Array.isArray(status?.browsers) ? status.browsers : [];
    }

    private endpointFor(browserId: string): string {
        if (browserId.startsWith("launched:")) {
            const port = Number(browserId.slice("launched:".length));
            return `http://127.0.0.1:${port}`;
        }
        const relay = getExtensionRelay();
        const port = relay.status().port;
        return `ws://127.0.0.1:${port}/devtools/browser?browser=${encodeURIComponent(browserId)}&token=${encodeURIComponent(relayToken())}`;
    }

    async listBrowsers(): Promise<BrowserInfo[]> {
        const browsers: BrowserInfo[] = (await this.extensionBrowsers()).map((browser) => ({
            id: browser.id,
            name: browser.name,
            connected: browser.connected,
            kind: "extension" as const,
        }));
        for (const port of launchedPorts()) {
            browsers.push({ id: `launched:${port}`, name: `Launched Chromium :${port}`, connected: true, kind: "launched", port });
        }
        return browsers;
    }

    async defaultBrowserId(): Promise<string | null> {
        const browsers = await this.listBrowsers();
        const extension = browsers.find((browser) => browser.kind === "extension" && browser.connected);
        return extension?.id ?? browsers[0]?.id ?? null;
    }

    // ─── connection ──────────────────────────────────────────────────

    async connectBrowser(browserId: string): Promise<Browser> {
        const cached = this.browsers.get(browserId);
        if (cached) {
            try {
                // isConnected() is synchronous and cheap; catching a stale one.
                if (cached.browser.isConnected()) return cached.browser;
            } catch {
                // replace below
            }
            await cached.browser.close().catch(() => undefined);
            this.browsers.delete(browserId);
        }

        const endpoint = this.endpointFor(browserId);
        const browser = await chromium.connectOverCDP(endpoint);
        this.browsers.set(browserId, { browser, endpoint });
        return browser;
    }

    // ─── targets ─────────────────────────────────────────────────────

    /** The CDP target id of a page, via a session-scoped Target.getTargetInfo. */
    async targetIdOf(page: Page): Promise<string | null> {
        const known = this.targetIds.get(page);
        if (known) return known;
        try {
            const session = await page.context().newCDPSession(page);
            try {
                const info: any = await session.send("Target.getTargetInfo" as any);
                const targetId = info?.targetInfo?.targetId;
                if (typeof targetId === "string") {
                    this.targetIds.set(page, targetId);
                    return targetId;
                }
            } finally {
                await session.detach().catch(() => undefined);
            }
        } catch {
            // Not fatal: fall back to URL matching.
        }
        return null;
    }

    async listTargets(browserId: string): Promise<BrowserTarget[]> {
        const browser = await this.connectBrowser(browserId);
        const targets: BrowserTarget[] = [];
        for (const context of browser.contexts()) {
            for (const page of context.pages()) {
                targets.push({
                    browserId,
                    targetId: (await this.targetIdOf(page)) ?? "",
                    url: page.url(),
                    title: await page.title().catch(() => ""),
                    type: "page",
                });
            }
        }
        return targets;
    }

    async getPage(pin: SessionPin): Promise<ResolvedPage | null> {
        const browserId = pin.browserId || (await this.defaultBrowserId());
        if (!browserId) return null;
        const browser = await this.connectBrowser(browserId);

        for (const context of browser.contexts()) {
            const pages = context.pages();
            if (pin.targetId) {
                for (const page of pages) {
                    if ((await this.targetIdOf(page)) === pin.targetId) {
                        return { page, context, browser, browserId, targetId: pin.targetId };
                    }
                }
            }
            const needle = pin.urlIncludes?.toLowerCase();
            if (needle) {
                for (const page of pages) {
                    const url = page.url().toLowerCase();
                    const title = await page.title().catch(() => "");
                    if (url.includes(needle) || title.toLowerCase().includes(needle)) {
                        return { page, context, browser, browserId, targetId: await this.targetIdOf(page) };
                    }
                }
            }
            if (pin.title) {
                const wanted = pin.title.toLowerCase();
                for (const page of pages) {
                    const title = await page.title().catch(() => "");
                    if (title.toLowerCase() === wanted || title.toLowerCase().includes(wanted)) {
                        return { page, context, browser, browserId, targetId: await this.targetIdOf(page) };
                    }
                }
            }
        }

        // No pin: use the browser's first page, if any (a fresh agent tab).
        if (!pin.targetId && !pin.urlIncludes && !pin.title) {
            const context = browser.contexts()[0];
            const page = context?.pages()[0];
            if (page && context) {
                return { page, context, browser, browserId, targetId: await this.targetIdOf(page) };
            }
        }
        return null;
    }

    async ensurePage(browserId: string, url?: string): Promise<ResolvedPage | null> {
        const browser = await this.connectBrowser(browserId);
        const context = browser.contexts()[0];
        if (!context) return null;
        let page = context.pages()[0];
        if (!page) page = await context.newPage();
        if (url && page.url() === "about:blank" && url !== "about:blank") {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
        }
        return { page, context, browser, browserId, targetId: await this.targetIdOf(page) };
    }

    async disconnect(): Promise<void> {
        // Do not call browser.close(): with connectOverCDP that closes the
        // user's real browser. Dropping the connections is enough; the process
        // is shutting down and the sockets close with it.
        this.browsers.clear();
    }
}
