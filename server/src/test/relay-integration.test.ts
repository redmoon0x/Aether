import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { ExtensionRelay } from "../extension-relay";

const PORT = Number(process.env.AETHER_TEST_RELAY_PORT || 18766);
const TOKEN = "test-token";

interface RelayMessage {
    id?: number;
    method?: string;
    params?: any;
    result?: any;
    error?: any;
    sessionId?: string;
}

/** A fake extension that answers the relay's tab/debugger protocol. */
async function startFakeExtension(browserId: string): Promise<{ commands: string[]; terminate: () => void }> {
    const commands: string[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/extension?token=${TOKEN}&browserId=${browserId}&name=Test%20Browser`);
    await new Promise<void>((resolve, reject) => {
        socket.on("open", () => resolve());
        socket.on("error", reject);
    });
    socket.send(JSON.stringify({ method: "hello", params: { browserId, name: "Test Browser" } }));
    // Lend the tab to the agent, so the relay exposes it over CDP.
    socket.send(JSON.stringify({ method: "tab.lent", params: { tabId: 1, url: "https://example.com", title: "Example" } }));

    socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as RelayMessage;
        if (message.id === undefined || !message.method) return;
        const reply = (result: unknown) => socket.send(JSON.stringify({ id: message.id, result }));
        switch (message.method) {
            case "tabs.list":
                reply([{ tabId: 1, url: "https://example.com", title: "Example", active: true, windowId: 1 }]);
                return;
            case "tabs.create":
                reply({ tabId: 2, url: message.params?.url ?? "about:blank", title: "New", active: false, windowId: 1 });
                return;
            case "debugger.attach":
            case "debugger.detach":
            case "tabs.group":
            case "tabs.close":
                reply({ ok: true });
                return;
            case "debugger.command":
                commands.push(message.params?.method);
                reply({ ok: true, method: message.params?.method });
                return;
            default:
                reply({ ok: true });
        }
    });

    return { commands, terminate: () => socket.terminate() };
}

function openCdpClient(browserId: string): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/devtools/browser?browser=${browserId}&token=${TOKEN}`);
    return new Promise((resolve, reject) => {
        socket.on("open", () => resolve(socket));
        socket.on("error", reject);
    });
}

test("relay exposes a browser-level CDP endpoint over a fake extension", async () => {
    const relay = new ExtensionRelay({ port: PORT, token: TOKEN });
    await relay.start();
    const extension = await startFakeExtension("test-browser");
    let cdp: WebSocket | null = null;

    try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        cdp = await openCdpClient("test-browser");
        const socket = cdp;
        const messages: RelayMessage[] = [];
        socket.on("message", (data) => messages.push(JSON.parse(data.toString())));

        const send = (payload: RelayMessage) => socket.send(JSON.stringify(payload));
        const waitForId = async (id: number): Promise<RelayMessage> => {
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
                const found = messages.find((message) => message.id === id && (message.result !== undefined || message.error));
                if (found) return found;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error(`timed out waiting for message ${id}`);
        };

        send({ id: 1, method: "Target.getTargets", params: {} });
        const targets = await waitForId(1);
        assert.equal(targets.result.targetInfos[0].targetId, "test-browser:1");

        send({ id: 2, method: "Target.attachToTarget", params: { targetId: "test-browser:1", flatten: true } });
        const attached = await waitForId(2);
        const sessionId = attached.result.sessionId as string;
        assert.equal(typeof sessionId, "string");
        assert.ok(messages.some((message) => message.method === "Target.attachedToTarget"));

        send({ id: 3, method: "Runtime.evaluate", params: { expression: "1+1" }, sessionId });
        const evaluated = await waitForId(3);
        assert.deepEqual(evaluated.result, { ok: true, method: "Runtime.evaluate" });
        assert.ok(extension.commands.includes("Runtime.evaluate"));

        send({ id: 4, method: "Browser.close", params: {} });
        const refused = await waitForId(4);
        assert.match(refused.error?.message ?? "", /refused/i);

        socket.terminate();
        cdp = null;
    } finally {
        cdp?.terminate();
        extension.terminate();
        await relay.stop();
    }
});
