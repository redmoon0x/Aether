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
- **Your real browser** — an optional extension drives the tabs you already have open, logins included; or connect over CDP to a browser Aether launches

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
browser {action:"launch"}
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

Thirteen tools. Variants are `action` values, not extra tools — a fifty-tool surface
costs schema tokens on every request and gives the model more ways to pick the
wrong one.

| Tool | Covers |
|---|---|
| `execute` | One script, many dependent steps (Playwright-shaped `page`, refs, handoff) |
| `snapshot` | Page facts + refs + outline; opt into screenshot, DOM, tabs, cookies, AX tree |
| `act` | One browser action: navigate, click, fill, press, wait, read, capture, emulate, tabs |
| `handoff` | Human steps (login, 2FA, passkey, payment) with a Continue card |
| `sessions` | `list`, `new`, `use`, `reset`, `delete`, `adopt`, `save_auth`, `load_auth` |
| `browser` | `status`, `launch`, `connect`, `kill`, `list`, `profiles` |
| `diagnostics` | `logs`, `network`, `performance`, redacted HAR capture (`har_start`, `har_stop`, `har_status`) |
| `get_page_text` | Clean Markdown/text extraction — token-cheap page reading |
| `captcha` | `detect`, `solve` |
| `memory` | Project-local lessons: `configure`, `remember`, `recall`, `outcome`, `compact`, `graph` |
| `skill` | Project-local procedures: `create`, `list`, `maintain` |
| `secrets` | Site secrets: `list`, `status`, `set`, `remove`, `type`, `run` — values never reach the model |
| `cdp_command` | Raw CDP escape hatch |

## One Call, Many Steps

`execute` runs a JavaScript script against the page, so a multi-step flow keeps its
transient state: an open menu stays open, a hover stays hovered, a half-filled form
stays filled between steps.

```js
const snap = await snapshot();
await ref(snap.elements.find((e) => e.text === "Sign in").ref).click();
await page.waitForURL("/dashboard");
return { url: await page.url() };
```

It exposes `page`, `context`, `snapshot()`, `ref("e12")`, `locator()`,
`getByRole/getByText/getByLabel/getByPlaceholder`, `handoff()`, `screenshot()`,
`console`, `sleep()`, plus `fs`, `path`, `os` and `require`.

`snapshot()` returns refs, and **refs fail closed**: acting on a ref whose element
was removed, relabelled or replaced by a navigation raises an error that says what
changed, instead of clicking whatever the selector matches now.

## Human Handoffs

When only a person can proceed — a password, 2FA, a passkey, a payment, an
interactive bot check — call `handoff`, and wait for the Continue card:

```js
await handoff("Complete the 2FA prompt, then click Continue", { timeoutMs: 300000 });
await page.waitForURL("/dashboard");
```

The card is rendered in an isolated JavaScript world behind a closed shadow root, so
page script can neither see its controls nor invoke its completion binding. A
completed handoff is an acknowledgment, not proof: assert the expected URL or element
afterwards. Time spent waiting is excluded from the `execute` timeout.

## Named Sessions

A session is a resumable pin to one tab. It survives tool calls and MCP restarts, and
never navigates a tab on its own.

```
sessions {action:"new", name:"checkout"}       # create and make current
sessions {action:"adopt", targetUrl:"shop"}    # pin a tab the user already has open
sessions {action:"list"}                       # ids, pinned tab, last used
sessions {action:"use", id:"checkout"}
```

Sessions live in `~/.aether/sessions.json` (override the folder with `AETHER_SESSION_DIR`).

---

## Browser Setup

**Use the browser you are already signed into** (recommended). Install the bundled
extension once, then connect:

```
browser {action:"extension"}
```

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → the
   `extension/` folder printed by the tool (inside the installed package).
2. Click the Aether toolbar button and type the **pairing code** the tool printed
   (`ABCD-1234`). Press Connect. It works once, expires in ten minutes, and the
   browser keeps its token afterwards.
3. Run `browser {action:"extension"}` again.

Agent tabs open in a **collapsed tab group**, in the background, so your own tabs stay
yours. Aether can only see tabs it opened or you lent it with **Lend this tab** in the
extension popup. Your logins, cookies and extensions are all there, because it is your
real profile.

Or launch a clean browser with its own profile:

```
browser {action:"launch"}
browser {action:"launch", browser:"chrome"}
browser {action:"launch", browser:"brave"}
```

Or attach to a browser started with a debugging port:

```bash
chrome --remote-debugging-port=9222
```

```
browser {action:"connect", port:9222}
```

Chromium has no supported way to attach to an already-running instance — that is what
the extension is for. Without it, a browser started normally, with the profile and
logins you already have open, cannot be driven.

---

## Project-Local Learning

Aether can accumulate knowledge about the sites and workflows it automates. When enabled, it stores distilled lessons and reusable skills inside your project under `.aether/` — not raw logs or screenshots, just compact, useful notes that make future automation faster.

```
memory {action:"configure", projectRoot:"<your project root>"}
```

Aether creates `.aether/` and adds it to `.gitignore` automatically. Skills and lessons stay local unless you choose to share them.

## Agent Skill and Instructions

The server sends a short usage guide in its MCP `initialize` instructions. For the
fuller playbook — the inspect/act/verify loop, refs, handoffs, sessions, debugging —
the package also ships `skills/aether/SKILL.md`. Copy it into your client's skills
folder, or point your agent at it directly.

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

Two ways in, one protocol underneath — everything above the CDP layer is shared.

```
AI Agent / MCP Client
        │
        │  stdio JSON-RPC
        ▼
  Aether MCP Server ─────────────┐
        │                        │
        │  CDP straight to a     │  127.0.0.1:8766
        │  browser we launched   │  (the relay, CDP in, extension out)
        ▼                        ▼
  Browser Target          Aether extension
   (own profile)                 │  chrome.debugger
                                 ▼
                         Your existing browser
                         (your tabs, your logins)

Agent A ─┐
Agent B ─┼─► same relay ─► one tab per agent, in a collapsed tab group
Agent C ─┘
```

The relay exposes a browser-level CDP endpoint per browser: the extension dials
out to it, and Playwright (Patchright) connects over CDP with the usual
`Target`/session routing. Each browser has its own id and tab space, so several
browsers can be connected at once; each agent session pins one browser and one
tab. Page commands are forwarded to `chrome.debugger`.

---

## Requirements

- Node.js >= 20 (the Patchright driver's engine requirement)
- Chrome, Edge, Brave, or Firefox installed locally

## Notes

- Cross-origin iframe contents are protected by browser security rules. Aether can click by viewport coordinates when an element is visible, but semantic inspection inside cross-origin frames is limited.
- Shadow DOM and same-origin iframe support is available for semantic actions and compact snapshots.
- CAPTCHA detection is exposed as a safeguard. Be careful with automation on sites where interaction is restricted by terms of service.

## License

ISC
