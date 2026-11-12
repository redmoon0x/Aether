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

Use your existing browser through the bundled extension (recommended):

```
browser {action:"extension"}
```

The tool starts a local relay and prints a one-time **pairing code** (`ABCD-1234`). Load
the `extension/` folder once at `chrome://extensions` → Developer mode → Load unpacked,
open the Aether popup, paste the code, press Connect. The browser keeps its token, so
this happens once. Agent tabs open in a collapsed tab group; Aether only sees tabs it
opened or you lent it from the popup.

Or launch a clean browser with its own profile:

```
browser {action:"launch"}
browser {action:"launch", browser:"chrome"}
browser {action:"launch", browser:"edge"}
browser {action:"launch", browser:"brave"}
```

Or attach to a browser started with a debugging port:

```bash
chrome --remote-debugging-port=9222
```

```
browser {action:"connect", port:9222}
```

## How the extension bridge works

- `extension/` is a Manifest V3 worker. It holds a `chrome.debugger` attachment per
  tab and runs the CDP commands the relay forwards. Each instance reports a stable
  `browserId`, so several browsers can share one relay.
- `src/extension-relay.ts` exposes a **browser-level** CDP endpoint per browser
  (`/devtools/browser?browser=<id>`) plus `/json`, `/json/list`, and the page-level
  `/devtools/page/<browser>:<tab>` for compatibility. Playwright (Patchright)
  connects over the browser endpoint; `src/relay/browser-cdp.ts` implements the
  `Target`/session routing.
- A browser pairs once with a short code and keeps the token it receives; the relay
  stores it in `~/.aether/relay-token` (or `AETHER_EXTENSION_TOKEN`).
- Several agents and several browsers can connect to one relay. A session pins one
  browser and one tab; a second client on the same tab is refused.
- Only tabs an agent created, or the user lent, are listed or closable. The relay
  refuses `Browser.close`, cookie/cache clearing, permission changes and
  `Page.bringToFront`.
- Agent tabs are grouped per session (`chrome.tabs.group` + `tabGroups.update`,
  collapsed). Attachments are restored after a service-worker restart.

## Driver

`execute`, `snapshot`, `act`, `handoff` and `diagnostics` run on **Patchright**
(`patchright-core`), Playwright's patched fork, so you get auto-waiting,
strictness, frame handling, actionability checks and full input semantics. The
driver connects to a launched browser over CDP, or to the relay's browser endpoint
for your existing browser.

## Key Tools

Thirteen tools; variants are `action` values.

| Tool | What it does |
|---|---|
| `execute` | One JavaScript script against the page — many steps, one round trip |
| `snapshot` | Page facts, refs (`e12`) and an outline; opt into screenshot/DOM/tabs/cookies/AX |
| `act` | One browser action: navigate, click, fill, press, wait, read, capture, emulate, tabs |
| `handoff` | Ask the user to do a human step and wait for Continue |
| `sessions` | `list`, `new`, `use`, `reset`, `delete`, `adopt`, `save_auth`, `load_auth` |
| `browser` | `status`, `launch`, `connect`, `kill`, `list`, `profiles` |
| `diagnostics` | `logs`, `network`, `performance`, redacted HAR capture (`har_start`, `har_stop`, `har_status`) |
| `get_page_text` | Clean Markdown/text extraction |
| `captcha` | `detect`, `solve` |
| `memory` | Project-local lessons |
| `skill` | Project-local procedures |
| `secrets` | Stored site secrets used without exposing values |
| `cdp_command` | Raw CDP escape hatch |

Refs fail closed: acting on a ref whose element was removed, relabelled or replaced
by a navigation fails with a message saying what changed. Production code should
re-snapshot rather than fall back to a bare selector.

## Sessions

A session pins a tab and survives tool calls and MCP restarts (state in
`~/.aether/sessions.json`, or `$AETHER_SESSION_DIR`). `sessions {action:"adopt"}`
attaches to a tab the user already has open, keeping their login. Sessions never
navigate on their own; an unpinned session adopts the tab it first works in.

## Agent guidance

The server sends a short usage guide in its `initialize` instructions. A longer
playbook ships at `skills/aether/SKILL.md`.

## Project-Local Learning

Aether stores learned lessons and reusable skills inside your project under `.aether/` — lightweight automation notes that make future runs faster. Call `memory {action:"configure", projectRoot:"..."}` to enable it.

## Environment Variables

| Variable | Purpose |
|---|---|
| `AETHER_PROJECT_ROOT` | Fallback project root for aether memory |
| `AETHER_SESSION_DIR` | Where sessions and the relay token live. Default `~/.aether` |
| `AETHER_EXTENSION_PORT` | Extension relay port. Default `8766` |
| `AETHER_EXTENSION_TOKEN` | Token the extension must present. Default: the generated `~/.aether/relay-token` |

## Requirements

- Node.js >= 20
- Chrome, Edge, Brave, or Firefox

## License

ISC
