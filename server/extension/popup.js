const $ = (id) => document.getElementById(id);

function log(text) {
    $("log").textContent = text || "";
}

async function send(message) {
    return await chrome.runtime.sendMessage(message);
}

async function refresh() {
    const status = await send({ method: "ui.status" });
    const connected = !!status?.connected;

    $("dot").className = `dot${connected ? " on" : ""}`;
    $("state").textContent = connected
        ? `connected · ${status.attached.length} tab(s) attached`
        : status?.paired
          ? "paired — start Aether to connect"
          : "not paired";

    $("connect").textContent = connected ? "Reconnect" : "Connect";
    if (status?.relayUrl) $("relayUrl").value = status.relayUrl;
}

$("connect").addEventListener("click", async () => {
    const relayUrl = $("relayUrl").value.trim() || "ws://127.0.0.1:8766";
    const code = $("code").value.trim();

    if (!code) {
        const saved = await send({ method: "ui.settings", relayUrl, token: "" });
        log(saved?.ok ? "Relay address saved. Enter the pairing code Aether printed." : saved?.error || "Could not save.");
        return;
    }

    log("Pairing…");
    const saved = await send({ method: "ui.settings", relayUrl, token: "" });
    if (!saved?.ok) {
        log(saved?.error || "Could not save the relay address.");
        return;
    }

    const result = await send({ method: "ui.pair", code });
    log(result?.ok ? "Paired. Aether can connect now." : result?.error || "Could not pair.");
    if (result?.ok) $("code").value = "";
    setTimeout(refresh, 800);
});

$("lend").addEventListener("click", async () => {
    const result = await send({ method: "ui.lend" });
    log(result?.ok ? `Lent “${result.title}” to Aether.` : result?.error || "Could not lend this tab.");
    setTimeout(refresh, 500);
});

$("open").addEventListener("click", async () => {
    const result = await send({ method: "ui.openTab" });
    log(result?.ok ? "Opened an agent tab." : result?.error || "Could not open a tab.");
    setTimeout(refresh, 500);
});

void refresh();
setInterval(refresh, 1500);
