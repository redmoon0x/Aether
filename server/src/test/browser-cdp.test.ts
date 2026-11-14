import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserCdpConnection, type BrowserHost, type CdpTab } from "../relay/browser-cdp";

function makeHost(tabs: CdpTab[]): BrowserHost & { sentToTab: Array<{ tabId: number; method: string }> } {
    const sentToTab: Array<{ tabId: number; method: string }> = [];
    return {
        sentToTab,
        listTabs: async () => tabs,
        attach: async () => undefined,
        detach: async () => undefined,
        createTab: async (url: string) => {
            const tab = { tabId: 99, url, title: "new", active: false };
            tabs.push(tab);
            return tab;
        },
        closeTab: async (tabId: number) => {
            const index = tabs.findIndex((tab) => tab.tabId === tabId);
            if (index >= 0) tabs.splice(index, 1);
        },
        group: async () => undefined,
        send: async (tabId: number, method: string) => {
            sentToTab.push({ tabId, method });
            return { ok: true, tabId, method };
        },
        isOwned: () => true,
        frameId: async (tabId: number) => (tabId === 3 ? "FRAME-3" : null),
    };
}

test("Target.getTargets lists owned tabs with browser-qualified ids", async () => {
    const tabs: CdpTab[] = [
        { tabId: 1, url: "https://a.example", title: "A", active: true },
        { tabId: 2, url: "https://b.example", title: "B", active: false },
    ];
    const host = makeHost(tabs);
    const events: any[] = [];
    const connection = new BrowserCdpConnection("chrome-1", host, { send: (message) => events.push(message) });

    const result: any = await connection.handle({ id: 1, method: "Target.getTargets", params: {} });
    assert.deepEqual(result.targetInfos.map((info: any) => info.targetId), ["chrome-1:1", "chrome-1:2"]);
});

test("attachToTarget allocates a flattened session and routes page commands", async () => {
    const tabs: CdpTab[] = [{ tabId: 7, url: "https://example.com", title: "Example", active: true }];
    const host = makeHost(tabs);
    const events: any[] = [];
    const connection = new BrowserCdpConnection("chrome-1", host, { send: (message) => events.push(message) });

    const attached: any = await connection.handle({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: "chrome-1:7", flatten: true },
    });
    assert.equal(typeof attached.sessionId, "string");
    assert.ok(events.some((event) => event.method === "Target.attachedToTarget"));
    assert.equal(connection.sessionForTab(7), attached.sessionId);

    const result = await connection.handle({
        id: 2,
        method: "Runtime.evaluate",
        params: { expression: "1+1" },
        sessionId: attached.sessionId,
    });
    assert.deepEqual(result, { ok: true, tabId: 7, method: "Runtime.evaluate" });
    assert.deepEqual(host.sentToTab, [{ tabId: 7, method: "Runtime.evaluate" }]);
});

test("setDiscoverTargets emits targetCreated for each tab", async () => {
    const tabs: CdpTab[] = [
        { tabId: 1, url: "https://a.example", title: "A", active: true },
        { tabId: 2, url: "https://b.example", title: "B", active: false },
    ];
    const events: any[] = [];
    const connection = new BrowserCdpConnection("chrome-1", makeHost(tabs), { send: (message) => events.push(message) });

    await connection.handle({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } });
    const created = events.filter((event) => event.method === "Target.targetCreated");
    assert.equal(created.length, 2);
});

test("guardrails refuse Browser.close", async () => {
    const connection = new BrowserCdpConnection("chrome-1", makeHost([]), { send: () => undefined });
    await assert.rejects(
        () => connection.handle({ id: 1, method: "Browser.close", params: {} }),
        /refused/i
    );
});

test("only owned targets can be closed", async () => {
    const tabs: CdpTab[] = [{ tabId: 4, url: "https://example.com", title: "Example", active: true }];
    const host = { ...makeHost(tabs), isOwned: () => false };
    const connection = new BrowserCdpConnection("chrome-1", host, { send: () => undefined });
    await assert.rejects(
        () => connection.handle({ id: 1, method: "Target.closeTarget", params: { targetId: "chrome-1:4" } }),
        /only close tabs it opened/i
    );
});

test("getTargetInfo without a targetId answers for the browser, even with no tabs", async () => {
    const host = makeHost([]);
    const connection = new BrowserCdpConnection("chrome-1", host, { send: () => undefined });

    const result: any = await connection.handle({ id: 1, method: "Target.getTargetInfo", params: {} });
    assert.equal(result.targetInfo.type, "browser");
    assert.equal(result.targetInfo.targetId, "chrome-1");
});

test("attached target info carries the browser context Playwright requires", async () => {
    const tabs: CdpTab[] = [{ tabId: 3, url: "https://example.com", title: "Example", active: true }];
    const events: any[] = [];
    const connection = new BrowserCdpConnection("chrome-1", makeHost(tabs), { send: (message) => events.push(message) });

    await connection.handle({ id: 1, method: "Target.attachToTarget", params: { targetId: "chrome-1:3", flatten: true } });
    const attached = events.find((event) => event.method === "Target.attachedToTarget");
    assert.equal(attached.params.targetInfo.browserContextId, "aether-chrome-1");
});

test("attachToTarget mints its own session, so detaching it keeps the page", async () => {
    const tabs: CdpTab[] = [{ tabId: 7, url: "https://example.com", title: "Example", active: true }];
    const host = makeHost(tabs);
    const events: any[] = [];
    const connection = new BrowserCdpConnection("chrome-1", host, { send: (message) => events.push(message) });

    const first: any = await connection.handle({ id: 1, method: "Target.attachToTarget", params: { targetId: "chrome-1:7", flatten: true } });
    const second: any = await connection.handle({ id: 2, method: "Target.attachToTarget", params: { targetId: "chrome-1:7", flatten: true } });
    assert.notEqual(first.sessionId, second.sessionId);

    await connection.handle({ id: 3, method: "Target.detachFromTarget", params: { sessionId: second.sessionId } });
    assert.equal(connection.sessionForTab(7), first.sessionId);
    const result = await connection.handle({ id: 4, method: "Runtime.evaluate", params: {}, sessionId: first.sessionId });
    assert.deepEqual(result, { ok: true, tabId: 7, method: "Runtime.evaluate" });
});

test("a browser session attaches a target without disturbing the page sessions", async () => {
    const tabs: CdpTab[] = [{ tabId: 3, url: "https://example.com", title: "Example", active: true }];
    const events: any[] = [];
    const connection = new BrowserCdpConnection("chrome-1", makeHost(tabs), { send: (message) => events.push(message) });

    const browser: any = await connection.handle({ id: 1, method: "Target.attachToBrowserTarget", params: {} });
    assert.match(browser.sessionId, /^aether-browser-/);

    const attached: any = await connection.handle({
        id: 2,
        method: "Target.attachToTarget",
        params: { targetId: "FRAME-3", flatten: true },
        sessionId: browser.sessionId,
    });
    const event = events.find((entry) => entry.method === "Target.attachedToTarget");
    assert.equal(event.sessionId, browser.sessionId);
    assert.equal(event.params.targetInfo.targetId, "FRAME-3");

    const info: any = await connection.handle({ id: 3, method: "Target.getTargetInfo", params: {}, sessionId: attached.sessionId });
    assert.equal(info.targetInfo.targetId, "FRAME-3");
});
