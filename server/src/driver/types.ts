import type { Browser, BrowserContext, Page } from "patchright-core";

/** A session's pin: which browser and page it works in. Never navigates on resolve. */
export interface SessionPin {
    id: string;
    browserId?: string;
    targetId?: string;
    urlIncludes?: string;
    title?: string;
}

export interface BrowserTarget {
    browserId: string;
    targetId: string;
    url: string;
    title: string;
    type: string;
}

export interface BrowserInfo {
    id: string;
    name: string;
    connected: boolean;
    kind: "extension" | "launched";
    port?: number;
}

export interface ResolvedPage {
    page: Page;
    context: BrowserContext;
    browser: Browser;
    browserId: string;
    targetId: string | null;
}

export interface Driver {
    listBrowsers(): Promise<BrowserInfo[]>;
    /** Connect (or reuse) the browser for this id and return it. */
    connectBrowser(browserId: string): Promise<Browser>;
    /** The default browser for a new session: first connected extension browser, else a launched one. */
    defaultBrowserId(): Promise<string | null>;
    listTargets(browserId: string): Promise<BrowserTarget[]>;
    /** Resolve a session's pinned page. Returns null when the pin is no longer open. */
    getPage(pin: SessionPin): Promise<ResolvedPage | null>;
    /** Make sure the browser has a page to work in, creating one if needed. */
    ensurePage(browserId: string, url?: string): Promise<ResolvedPage | null>;
    /** The CDP target id of a Playwright page. */
    targetIdOf(page: Page): Promise<string | null>;
    disconnect(): Promise<void>;
}
