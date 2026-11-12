/**
 * Aether Browser Bridge.
 *
 * The relay drives tabs through this worker: it asks us to attach
 * `chrome.debugger` to a tab and then forwards CDP commands, which we run with
 * `chrome.debugger.sendCommand` and stream the events back. That is what lets
 * Aether work in the browser the user is already signed into, without a
 * `--remote-debugging-port` and without a second profile.
 *
 * Rules this worker keeps:
 *  - Only tabs the relay created or the user lent are ever handed to it.
 *  - Agent tabs are put in a collapsed tab group, so they stay out of the way.
 *  - Attachments are re-established after a service-worker restart; Chrome
 *    keeps them but our memory does not.
 */
const DEFAULT_RELAY_URL = "ws://127.0.0.1:8766";
const RECONNECT_ALARM = "aether-reconnect";
const ATTACHED_KEY = "attachedTabs";
const GROUPS_KEY = "sessionGroups";
const SETTINGS_KEY = "relaySettings";

/** tabId -> the URL it had when attached, so a restart can tell a reused id from the same page. */
const attached = new Map();
/** sessionId -> tab group id. */
const sessionGroups = new Map();

let socket = null;
let pairSocket = null;
let pairRequestId = 0;
const pairWaiters = new Map();
let reconnectTimer = null;
let extensions = 0;

// ── small chrome-API helpers ────────────────────────────────────────────

const lastError = () => chrome.runtime.lastError?.message;

function getTab(tabId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.get(Number(tabId), (tab) => {
            const error = lastError();
            if (error) reject(new Error(error));
            else resolve(tab);
        });
    });
}

function queryTabs(query) {
    return new Promise((resolve) => chrome.tabs.query(query, (tabs) => resolve(tabs || [])));
}

function createTab(properties) {
    return new Promise((resolve, reject) => {
        chrome.tabs.create(properties, (tab) => {
            const error = lastError();
            if (error) reject(new Error(error));
            else resolve(tab);
        });
    });
}

function removeTab(tabId) {
    return new Promise((resolve) => chrome.tabs.remove(Number(tabId), () => resolve()));
}

function attachDebugger(tabId) {
    return new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId: Number(tabId) }, "1.3", () => {
            const error = lastError();
            if (error) reject(new Error(error));
            else resolve();
        });
    });
}

function detachDebugger(tabId) {
    return new Promise((resolve) => chrome.debugger.detach({ tabId: Number(tabId) }, () => resolve()));
}

function sendDebuggerCommand(tabId, method, params) {
    return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, params || {}, (result) => {
            const error = lastError();
            if (error) reject(new Error(error));
            else resolve(result || {});
        });
    });
}

async function setBadge(tabId, text, color) {
    await chrome.action.setBadgeText({ tabId: Number(tabId), text: text || "" }).catch(() => undefined);
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId: Number(tabId), color }).catch(() => undefined);
}

// ── browser identity ────────────────────────────────────────────────────

/** A stable id and readable name so several browsers can share one relay. */
async function getBrowserIdentity() {
    const stored = await chrome.storage.local.get("browserIdentity").catch(() => ({}));
    let identity = stored.browserIdentity;
    if (!identity?.id || typeof identity.id !== "string") {
        identity = { id: crypto.randomUUID(), name: detectBrowserName() };
        await chrome.storage.local.set({ browserIdentity: identity }).catch(() => undefined);
    }
    return identity;
}

function detectBrowserName() {
    const brands = (navigator.userAgentData?.brands || []).map((entry) => entry.brand).join(" ");
    const ua = navigator.userAgent || "";
    if (/Brave/i.test(brands) || /Brave/i.test(ua)) return "Brave";
    if (/Edge/i.test(brands) || /Edg\//.test(ua)) return "Edge";
    if (/Google Chrome/i.test(brands) || /Chrome\//.test(ua)) return "Chrome";
    if (/Chromium/i.test(brands)) return "Chromium";
    return "Chromium";
}

// ── settings ────────────────────────────────────────────────────────────

async function readSettings() {
    const stored = await chrome.storage.local.get(SETTINGS_KEY).catch(() => ({}));
    const saved = stored[SETTINGS_KEY] || {};
    let bundled = {};
    try {
        bundled = await (await fetch(chrome.runtime.getURL("config.json"))).json();
    } catch {
        bundled = {};
    }
    return {
        relayUrl: saved.relayUrl || bundled.relayUrl || DEFAULT_RELAY_URL,
        token: saved.token || bundled.token || "",
    };
}

// ── websocket ───────────────────────────────────────────────────────────

function send(message) {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
        return true;
    }
    return false;
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1000);
}

async function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    const { relayUrl, token } = await readSettings();
    const identity = await getBrowserIdentity();
    if (!token) {
        // Not paired yet: dial in as a candidate and wait for the user to type
        // the pairing code Aether printed.
        await connectForPairing(relayUrl);
        return;
    }

    let url;
    try {
        url = new URL(relayUrl);
        // "ws://127.0.0.1:8766" means the extension link; a pasted path wins.
        if (!url.pathname || url.pathname === "/") url.pathname = "/extension";
        url.searchParams.set("token", token);
        url.searchParams.set("kind", "extension");
        url.searchParams.set("browserId", identity.id);
        url.searchParams.set("name", `${identity.name} · ${identity.id.slice(0, 4)}`);
    } catch {
        return;
    }

    socket = new WebSocket(url.toString());

    socket.onopen = () => {
        send({
            method: "hello",
            params: {
                version: chrome.runtime.getManifest().version,
                userAgent: navigator.userAgent,
                browserId: identity.id,
                name: `${identity.name} · ${identity.id.slice(0, 4)}`,
            },
        });
        void restoreAttachments();
        void pushStatus();
    };

    socket.onmessage = (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        if (message.method && message.id === undefined) {
            if (message.method === "auth.rejected") {
                socket?.close();
            }
            return;
        }
        if (message.id === undefined || !message.method) return;
        void (async () => {
            try {
                const result = await handle(message.method, message.params || {});
                send({ id: message.id, result: result ?? {} });
            } catch (error) {
                send({ id: message.id, error: error instanceof Error ? error.message : String(error) });
            }
        })();
    };

    socket.onclose = () => {
        socket = null;
        scheduleReconnect();
    };
    socket.onerror = () => socket?.close();
}

/**
 * The unpaired path: dial in without a token, then send the short code the user
 * read from Aether. The relay answers with the token once; we store it and
 * reconnect normally.
 */
async function connectForPairing(relayUrl) {
    if (pairSocket && (pairSocket.readyState === WebSocket.OPEN || pairSocket.readyState === WebSocket.CONNECTING)) return;

    let url;
    try {
        url = new URL(relayUrl);
        if (!url.pathname || url.pathname === "/") url.pathname = "/extension";
        url.searchParams.set("pair", "1");
    } catch {
        return;
    }

    const ws = new WebSocket(url.toString());
    pairSocket = ws;

    ws.onmessage = (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        if (message.id !== undefined && pairWaiters.has(message.id)) {
            const waiter = pairWaiters.get(message.id);
            pairWaiters.delete(message.id);
            if (message.error) waiter.reject(new Error(message.error));
            else waiter.resolve(message.result || {});
        }
    };

    ws.onclose = () => {
        if (pairSocket === ws) pairSocket = null;
        for (const waiter of pairWaiters.values()) waiter.reject(new Error("The Aether relay connection closed."));
        pairWaiters.clear();
    };
    ws.onerror = () => ws.close();
}

/** Send one request on the pairing socket. */
function pairRequest(method, params) {
    if (!pairSocket || pairSocket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("Not connected to Aether. Is the MCP server running?"));
    }
    const id = ++pairRequestId;
    return new Promise((resolve, reject) => {
        pairWaiters.set(id, { resolve, reject });
        pairSocket.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
            if (pairWaiters.delete(id)) reject(new Error("Aether did not answer the pairing request."));
        }, 8000);
    });
}

/** Exchange the code for a token and reconnect with it. */
async function pairWithCode(code) {
    const settings = await readSettings();
    await connectForPairing(settings.relayUrl);

    for (let i = 0; i < 50; i++) {
        if (pairSocket && pairSocket.readyState === WebSocket.OPEN) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const result = await pairRequest("pair", { code });
    if (!result?.token) throw new Error("The relay did not return a token.");

    await chrome.storage.local.set({
        [SETTINGS_KEY]: { relayUrl: settings.relayUrl, token: result.token },
    });
    try {
        pairSocket?.close();
    } catch {
        // ignore
    }
    pairSocket = null;
    void connect();
    return { paired: true };
}

// ── attachments ─────────────────────────────────────────────────────────

async function persistAttachments() {
    const entries = [];
    for (const [tabId, url] of attached) entries.push({ tabId, url });
    await chrome.storage.local.set({ [ATTACHED_KEY]: entries }).catch(() => undefined);
}

/**
 * Chrome keeps a debugger attachment across a service-worker restart, but this
 * worker's map does not. Probe each recorded tab: a successful
 * Target.getTargetInfo means the attachment is ours, so keep it listed.
 */
async function restoreAttachments() {
    const stored = (await chrome.storage.local.get(ATTACHED_KEY).catch(() => ({})))[ATTACHED_KEY] || [];
    for (const entry of stored) {
        const tabId = typeof entry === "number" ? entry : entry.tabId;
        const url = typeof entry === "number" ? undefined : entry.url;
        if (attached.has(tabId)) continue;
        const tab = await getTab(tabId).catch(() => undefined);
        if (!tab) continue;
        if (url && tab.url && tab.url !== url) continue;
        try {
            await sendDebuggerCommand(tabId, "Target.getTargetInfo", {});
            attached.set(tabId, tab.url || url || "");
        } catch {
            // Not attached by us (or the tab is gone): attach fresh when asked.
        }
    }
}

async function attachTab(tabId) {
    const id = Number(tabId);
    if (attached.has(id)) return;
    const tab = await getTab(id);
    try {
        await attachDebugger(id);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already attached/i.test(message)) {
            throw new Error(`Could not attach to this tab: ${message}`);
        }
        // Another debugger owns it. Keep the failure explicit rather than
        // pretending we can drive a tab we cannot.
        throw new Error(
            "Another debugger (DevTools or another extension) is attached to this tab. Close DevTools on it and retry."
        );
    }
    attached.set(id, tab.url || "");
    await persistAttachments();
}

async function detachTab(tabId) {
    const id = Number(tabId);
    attached.delete(id);
    await persistAttachments();
    await detachDebugger(id);
}

// ── tab groups ──────────────────────────────────────────────────────────

async function groupForSession(tab, sessionId) {
    const key = sessionId || "agent";
    const saved = (await chrome.storage.local.get(GROUPS_KEY).catch(() => ({})))[GROUPS_KEY] || {};
    if (saved[key]) {
        sessionGroups.set(key, saved[key]);
    }

    const existingId = sessionGroups.get(key);
    if (existingId !== undefined) {
        const existing = await chrome.tabGroups.get(existingId).catch(() => undefined);
        if (existing && existing.windowId === tab.windowId) {
            if (tab.groupId !== existing.id) {
                await chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id }).catch(() => undefined);
            }
            return existing.id;
        }
        sessionGroups.delete(key);
    }

    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups
        .update(groupId, { title: `Aether · ${key}`, color: "blue", collapsed: true })
        .catch(() => undefined);
    sessionGroups.set(key, groupId);
    saved[key] = groupId;
    await chrome.storage.local.set({ [GROUPS_KEY]: saved }).catch(() => undefined);
    return groupId;
}

// ── relay commands ──────────────────────────────────────────────────────

function publicTab(tab) {
    return {
        tabId: tab.id,
        url: tab.url || "",
        title: tab.title || "",
        active: !!tab.active,
        windowId: tab.windowId,
        groupId: tab.groupId,
        attached: attached.has(tab.id),
    };
}

async function handle(method, params) {
    switch (method) {
        case "ping":
            return { ok: true, version: chrome.runtime.getManifest().version, attached: attached.size };

        case "tabs.list": {
            const tabs = await queryTabs({});
            return tabs.filter((tab) => tab.id !== undefined).map(publicTab);
        }

        case "tabs.create": {
            const tab = await createTab({ url: params.url || "about:blank", active: params.active === true });
            if (params.group === true || params.sessionId !== undefined) {
                await groupForSession(tab, params.sessionId).catch(() => undefined);
            }
            await attachTab(tab.id);
            await setBadge(tab.id, "ON", "#2563eb");
            return publicTab(await getTab(tab.id));
        }

        case "tabs.close":
            await removeTab(params.tabId);
            return { closed: true };

        case "tabs.group": {
            const tab = await getTab(params.tabId);
            const groupId = await groupForSession(tab, params.sessionId);
            return { groupId };
        }

        case "debugger.attach":
            await attachTab(params.tabId);
            return { attached: true };

        case "debugger.detach":
            await detachTab(params.tabId);
            await setBadge(params.tabId, "", undefined);
            return { detached: true };

        case "debugger.command":
            if (!attached.has(Number(params.tabId))) {
                throw new Error("This tab is not attached. Ask Aether to attach it again.");
            }
            return await sendDebuggerCommand(params.tabId, params.method, params.params);

        case "badge.set":
            await setBadge(params.tabId, params.text, params.color);
            return { ok: true };

        default:
            throw new Error(`Unknown bridge command: ${method}`);
    }
}

// ── events to the relay ─────────────────────────────────────────────────

chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined || !attached.has(source.tabId)) return;
    send({ method: "debugger.event", params: { tabId: source.tabId, method, params: params || {} } });
});

chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    attached.delete(source.tabId);
    void persistAttachments();
    void setBadge(source.tabId, "", undefined);
    send({ method: "debugger.detached", params: { tabId: source.tabId, reason } });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (!attached.has(tabId)) return;
    attached.delete(tabId);
    void persistAttachments();
    send({ method: "tab.closed", params: { tabId } });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!attached.has(tabId)) return;
    if (changeInfo.url) void persistAttachments();
    // The relay lists tabs for CDP clients; keep its copy current so a status
    // call reports the page the tab is on now, not the one it attached to.
    if (changeInfo.url || changeInfo.title) {
        send({ method: "tab.updated", params: { tabId, url: tab.url || "", title: tab.title || "" } });
    }
});

// ── popup ───────────────────────────────────────────────────────────────

async function pushStatus() {
    send({ method: "bridge.status", params: { version: chrome.runtime.getManifest().version, attached: [...attached.keys()] } });
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    void (async () => {
        try {
            if (message?.method === "ui.status") {
                const settings = await readSettings();
                respond({
                    ok: true,
                    connected: socket?.readyState === WebSocket.OPEN,
                    paired: !!settings.token,
                    pairing: pairSocket?.readyState === WebSocket.OPEN,
                    relayUrl: settings.relayUrl,
                    attached: [...attached.keys()],
                });
                return;
            }
            if (message?.method === "ui.pair") {
                try {
                    await pairWithCode(String(message.code || "").trim().toUpperCase());
                    respond({ ok: true });
                } catch (error) {
                    respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
                }
                return;
            }
            if (message?.method === "ui.settings") {
                await chrome.storage.local.set({
                    [SETTINGS_KEY]: { relayUrl: message.relayUrl, token: message.token },
                });
                respond({ ok: true });
                socket?.close();
                void connect();
                return;
            }
            if (message?.method === "ui.lend") {
                const [tab] = await queryTabs({ active: true, currentWindow: true });
                if (!tab) throw new Error("No active tab.");
                send({ method: "tab.lent", params: { tabId: tab.id, url: tab.url || "", title: tab.title || "" } });
                await setBadge(tab.id, "ON", "#2563eb");
                respond({ ok: true, title: tab.title || tab.url || "this tab" });
                return;
            }
            if (message?.method === "ui.openTab") {
                const tab = await handle("tabs.create", { url: "about:blank", sessionId: "agent" });
                respond({ ok: true, tab });
                return;
            }
            respond({ ok: false, error: `Unknown UI command: ${message?.method}` });
        } catch (error) {
            respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    })();
    return true;
});

// ── lifecycle ───────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
    void connect();
});
chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
    attached.clear();
    sessionGroups.clear();
    void connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== RECONNECT_ALARM) return;
    void connect();
    extensions++;
    void pushStatus();
});

chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
void connect();
