# Aether — AI Browser Controller

Give your AI agent a real browser. Aether is an MCP server that lets Claude, Cursor, Kilo Code, Codex, and other AI coding agents inspect and control a live browser through the Chrome DevTools Protocol — no extension needed.

## Install

```bash
npx -y aether-mcp-server
```

Or globally:

```bash
npm install -g aether-mcp-server
```

## MCP Client Config

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

If installed globally:

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

No cloning. No building. No absolute paths.

## What It Does

- Launches or connects to Chrome, Edge, Brave, or Firefox with remote debugging
- Click by text, role, label, or placeholder — not fragile CSS selectors
- Native CDP keyboard and mouse events, not DOM simulation
- Smart page snapshots that auto-invalidate on DOM changes
- Set-of-Marks visual element references for screenshot-based workflows
- Shadow DOM and same-origin iframe support built in

## Browser Setup

```
launch_browser()
launch_browser(browser="chrome")
launch_browser(browser="edge")
launch_browser(browser="brave")
```

Connect to an existing browser:

```bash
chrome --remote-debugging-port=9222
```

```
connect_browser(mode="connect", port=9222)
```

## Existing browser via extension

To keep Brave/Chrome open and share its signed-in profile, load the repository's
`extension/` folder from the browser's Extensions page (turn on Developer mode,
then choose **Load unpacked**). Start the MCP with `AETHER_MODE=extension`, open
the extension popup, and call:

```
connect_browser(mode="extension")
```

The extension opens an Aether-owned tab and only that tab (and any tabs it opens)
is exposed to the MCP. Your existing tabs are deliberately not controllable.

## Key Tools

| Tool | What it does |
|---|---|
| `browser_status` | Connection and active tab status |
| `snapshot_compact` | Fast title, URL, and interactive element list |
| `list_interactive_elements` | Element refs for click/fill flows |
| `click_text`, `click_role`, `fill_label` | Semantic actions |
| `click_by_ref`, `fill_by_selector` | Direct element targeting |
| `get_state` | Screenshot, tabs, DOM snapshot |
| `get_logs`, `get_network_errors` | Live debugging output |
| `act` | Broad compatibility action tool |

## Project-Local Learning

Aether stores learned lessons and reusable skills inside your project under `.aether/` — lightweight automation notes that make future runs faster. Call `configure_aether_memory` with your project root to enable it.

## Environment Variables

| Variable | Purpose |
|---|---|
| `AETHER_MODE` | `"cdp"` (default) or `"extension"` |
| `AETHER_EXTENSION_PORT` | Loopback bridge port for extension mode (default `8766`) |
| `AETHER_PROJECT_ROOT` | Fallback project root for aether memory |

## Requirements

- Node.js >= 18
- Chrome, Edge, Brave, or Firefox

## License

ISC
