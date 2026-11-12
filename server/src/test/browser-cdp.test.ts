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
