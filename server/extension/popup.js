const state = document.getElementById("state");
const open = document.getElementById("open");

chrome.runtime.sendMessage({ method: "status" }, result => {
  state.textContent = result?.connected
    ? "Connected to local Aether MCP."
    : "Waiting for local Aether MCP on port 8766.";
});

open.addEventListener("click", () => {
  chrome.runtime.sendMessage({ method: "open-agent-tab" }, result => {
    state.textContent = result?.ok ? "Agent tab is ready." : (result?.error || "Could not open agent tab.");
  });
});
