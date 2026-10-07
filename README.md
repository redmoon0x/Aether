# Aether — Give Your AI Agent a Real Browser

Your AI coding agent can read files, write code, and call APIs. Now it can open a browser, click things, fill forms, take screenshots, and debug live pages — all through one MCP server, with no extension required.

```bash
npx -y aether-mcp-server
```

That's it. Add it to your MCP client and your agent gets full browser control.

---

## Why Aether

Most browser automation tools are built for scripts, not agents. They break on dynamic pages, choke on shadow DOM, and require brittle selectors that rot the moment the UI changes.

Aether is designed for AI agents:

- **Semantic targeting** — click by text, role, label, or placeholder instead of fragile CSS selectors
- **Native CDP input** — real keyboard and mouse events, not simulated DOM tricks
- **Smart snapshots** — compact page state that auto-invalidates on DOM changes, so your agent always works with fresh data
- **Set-of-Marks** — visual element references for screenshot-based workflows
- **No extension** — connects directly to Chrome, Edge, Brave, or Firefox via CDP

---

## Get Started in 30 Seconds

**1. Add to your MCP client** (Claude Code, Cursor, Kilo Code, Codex, etc.):

```json
{
  "mcpServers": {
    "aether": {
      "command": "npx",
      "args": ["-y", "aether-mcp-server"]
    }
  }
}
```

Some clients ask for command and args separately:

| Field | Value |
|---|---|
| **Command** | `npx` |
| **Args** | `-y aether-mcp-server` |

**2. Launch a browser from your agent:**

```
launch_browser()
```

**3. Start automating:**

```
navigate to https://example.com
click_text("Sign in")
fill_label("Email", "user@example.com")
```

No cloning. No building. No absolute paths.

---

## What Your Agent Can Do

| Category | Tools |
|---|---|
| **Navigation** | `navigate`, `go_back`, `go_forward`, `reload` |
| **Interaction** | `click_text`, `click_role`, `click_by_ref`, `fill_label`, `fill_by_selector`, `press_key` |
| **Inspection** | `snapshot_compact`, `list_interactive_elements`, `get_state`, `page_snapshot` |
| **Reading** | `get_page_text` (clean Markdown/text extraction — token-cheap page reading) |
| **Sessions** | `save_auth_state`, `load_auth_state` (reuse a logged-in session, skip repeat logins) |
| **Debugging** | `get_logs`, `get_network_errors`, `get_performance_metrics` |
| **Tabs & Windows** | `new_tab`, `list_tabs`, `switch_tab`, `close_tab` |
| **Advanced** | `screenshot`, `print_pdf`, `mock_network_request`, `set_geolocation`, `emulate_device` |

---

## Browser Setup

Launch a clean browser automatically:

```
launch_browser()
launch_browser(browser="chrome")
launch_browser(browser="edge")
launch_browser(browser="brave")
```

Or connect to an existing browser with remote debugging enabled:

```bash
chrome --remote-debugging-port=9222
```

```
connect_browser(mode="connect", port=9222)
```

### Use your already-open Brave/Chrome (extension mode)

If you want Aether to reuse the browser profile you are currently using, install
the included `server/extension/` folder as an unpacked Chromium extension. It creates a
separate **Aether agent tab** in that same browser; the MCP cannot enumerate or
control your ordinary tabs.

1. In Brave/Chrome, open `brave://extensions` or `chrome://extensions`, enable
   **Developer mode**, then choose **Load unpacked** and select this repository's
   `server/extension` folder.
2. Start Aether with `AETHER_MODE=extension` (and optionally
   `AETHER_EXTENSION_PORT=8766`). The extension popup should say it is connected.
3. Call `connect_browser(mode="extension")`. Aether opens or reuses its own tab,
   while the rest of your browsing session remains available to you.

The extension stays installed when the MCP is stopped. It automatically retries
its loopback connection about every 30 seconds after the MCP starts again; using
the extension popup reconnects it immediately.

The bridge only listens on `127.0.0.1:8766`. Keep the extension installed only
in profiles you trust, because the browser debugger permission grants it full
access to its agent tabs.

---

## Project-Local Learning

Aether can accumulate knowledge about the sites and workflows it automates. When enabled, it stores distilled lessons and reusable skills inside your project under `.aether/` — not raw logs or screenshots, just compact, useful notes that make future automation faster.

```
configure_aether_memory("<your project root>")
```

Aether creates `.aether/` and adds it to `.gitignore` automatically. Skills and lessons stay local unless you choose to share them.

---

## Install Globally

```bash
npm install -g aether-mcp-server
aether-mcp-server
```

Then configure with:

```json
{
  "mcpServers": {
    "aether": {
      "command": "aether-mcp-server",
      "args": []
    }
  }
}
```

---

## Install from Source

```bash
git clone https://github.com/deviprasadshetty-dev/Aether.git
cd Aether/server
npm install
npm run build
node dist/index.js
```

Configure your MCP client with the absolute path to `dist/index.js`.

---

## Architecture

```
AI Agent / MCP Client
        │
        │  stdio JSON-RPC
        ▼
  Aether MCP Server
        │
        │  Chrome DevTools Protocol
        ▼
    Browser Target
```

---

## Requirements

- Node.js >= 18
- Chrome, Edge, Brave, or Firefox installed locally

## Notes

- Cross-origin iframe contents are protected by browser security rules. Aether can click by viewport coordinates when an element is visible, but semantic inspection inside cross-origin frames is limited.
- Shadow DOM and same-origin iframe support is available for semantic actions and compact snapshots.
- CAPTCHA detection is exposed as a safeguard. Be careful with automation on sites where interaction is restricted by terms of service.

## License

ISC
