// Aether Browser Bridge. The extension deliberately exposes only tabs that it
// created itself; normal browsing tabs never become MCP targets.
const SERVER_URL = "ws://127.0.0.1:8766";
let socket = null;
let reconnectTimer = null;
let attachedTabId = null;
const managedTabIds = new Set();

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function status() {
  return {
    connected: socket?.readyState === WebSocket.OPEN,
    attachedTabId,
    managedTabIds: [...managedTabIds],
  };
}

function connect() {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  socket = new WebSocket(SERVER_URL);
  socket.onopen = () => send({ method: "ping", params: { ...status(), ready: true } });
  socket.onmessage = async (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id === undefined || !message.method) return;
    try {
      const result = await handle(message.method, message.params || {});
      send({ id: message.id, result });
    } catch (error) {
      send({ id: message.id, error: error?.message || String(error) });
    }
  };
  socket.onclose = () => {
    socket = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1000);
  };
  socket.onerror = () => socket?.close();
}

// Manifest V3 service workers are allowed to sleep while the MCP is offline.
// An alarm wakes this bridge periodically so starting the MCP later does not
// require opening the extension popup first.
function scheduleReconnectAlarm() {
  chrome.alarms.create("aether-reconnect", { periodInMinutes: 0.5 });
}

function getTab(id) {
  return new Promise((resolve, reject) => chrome.tabs.get(Number(id), tab => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve(tab);
  }));
}

function createTab(url = "about:blank") {
  return new Promise((resolve, reject) => chrome.tabs.create({ url, active: true }, tab => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else { managedTabIds.add(tab.id); resolve(tab); }
  }));
}

function attach(tabId) {
  return new Promise((resolve, reject) => chrome.debugger.attach({ tabId }, "1.3", () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve();
  }));
}

function detach(tabId) {
  return new Promise(resolve => chrome.debugger.detach({ tabId }, () => resolve()));
}

async function selectTab(targetId) {
  const tabId = Number(targetId);
  if (!managedTabIds.has(tabId)) throw new Error("That tab is not managed by Aether.");
  if (attachedTabId === tabId) return getTab(tabId);
  if (attachedTabId !== null) await detach(attachedTabId);
  await attach(tabId);
  attachedTabId = tabId;
  const tab = await getTab(tabId);
  return tab;
}

async function ensureAgentTab() {
  if (attachedTabId !== null && managedTabIds.has(attachedTabId)) {
    try { return await getTab(attachedTabId); } catch { managedTabIds.delete(attachedTabId); attachedTabId = null; }
  }
  const tab = await createTab();
  await selectTab(tab.id);
  return tab;
}

function publicTab(tab) {
  return { id: String(tab.id), url: tab.url || "about:blank", title: tab.title || "Aether agent tab" };
}

async function handle(method, params) {
  switch (method) {
    case "status": return status();
    case "session.attach": return publicTab(await ensureAgentTab());
    case "session.detach":
      if (attachedTabId !== null) await detach(attachedTabId);
      attachedTabId = null;
      return { detached: true };
    case "tabs.list": {
      const tabs = [];
      for (const tabId of [...managedTabIds]) {
        try { tabs.push(publicTab(await getTab(tabId))); } catch { managedTabIds.delete(tabId); }
      }
      return tabs;
    }
    case "tabs.create": return publicTab(await createTab(params.url));
    case "tabs.select": return publicTab(await selectTab(params.targetId));
    case "tabs.close": {
      const tabId = Number(params.targetId);
      if (!managedTabIds.has(tabId)) throw new Error("That tab is not managed by Aether.");
      if (attachedTabId === tabId) { await detach(tabId); attachedTabId = null; }
      await chrome.tabs.remove(tabId);
      managedTabIds.delete(tabId);
      return { closed: true };
    }
    case "cdp": {
      if (attachedTabId === null) throw new Error("No Aether agent tab is attached.");
      return new Promise((resolve, reject) => chrome.debugger.sendCommand(
        { tabId: attachedTabId }, params.method, params.params || {}, result => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message)); else resolve(result || {});
        }
      ));
    }
    default: throw new Error(`Unknown extension command: ${method}`);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === attachedTabId) send({ method: "event", params: { method, params } });
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTabId) attachedTabId = null;
});

chrome.tabs.onRemoved.addListener(tabId => {
  managedTabIds.delete(tabId);
  if (attachedTabId === tabId) attachedTabId = null;
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.method === "open-agent-tab") {
    ensureAgentTab().then(tab => respond({ ok: true, tab: publicTab(tab) }))
      .catch(error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.method === "status") { respond(status()); return; }
});

chrome.runtime.onInstalled.addListener(scheduleReconnectAlarm);
chrome.runtime.onStartup.addListener(scheduleReconnectAlarm);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "aether-reconnect") connect();
});
scheduleReconnectAlarm();
connect();
