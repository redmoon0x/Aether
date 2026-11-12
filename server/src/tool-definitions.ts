/**
 * The exposed MCP tool surface.
 *
 * Thirteen tools, not fifty-four. The old surface had five generations of the same
 * action tool (`act`, `browser_intent`, `agent_action`, `observe_and_act`,
 * `agent_form_fill`, `smart_navigate`, the `click_*`/`fill_*` family) and four
 * snapshot tools, because each was added as a new tool rather than an action.
 * Every tool costs schema tokens on every request and adds a way to pick the
 * wrong one.
 *
 * The rule here: one tool per *kind of thing you do*, an `action` when the thing
 * has obvious variants. Anything that is a browser action belongs to `act`;
 * anything that needs several dependent steps belongs to `execute`.
 */
const sessionProperty = { type: "string", description: "Optional session id. Defaults to the current session." } as const;
const timeoutProperty = { type: "number", description: "Timeout in ms." } as const;

const ACTION_VALUES = [
    // navigation and tabs
    "navigate", "smart_navigate", "new_tab", "switch_tab", "close_tab",
    // pointer and keyboard
    "click", "click_text", "click_role", "click_by_ref", "click_by_selector",
    "fill", "fill_label", "fill_by_selector", "type", "press_key", "key_combo",
    "hover", "scroll", "drag_and_drop", "select", "check", "upload_file",
    // waiting and assertions
    "wait", "wait_for_selector", "wait_for_text", "assert", "verify_ui_state",
    // reading
    "screenshot", "screenshot_region", "get_tree", "get_dom_tree", "get_dom_snapshot",
    "get_logs", "get_network_traffic", "get_network_response", "get_performance_metrics",
    "get_computed_style", "get_event_listeners", "get_dom_storage", "element_at_point",
    "highlight_elements", "print_pdf",
    // high-level helpers
    "intent", "agent_action", "observe_and_act", "form_fill",
    // capture and instrumentation
    "start_screencast", "stop_screencast", "get_screencast_frames", "record_session",
    "sample_visual_frames", "start_tracing", "stop_tracing",
    // emulation and network shaping
    "configure", "emulate_network", "mock_network_request", "set_geolocation",
    "set_timezone", "get_cookies", "set_cookie", "clear_cache",
    // safety
    "detect_captcha"
];

export const MERGED_TOOL_DEFINITIONS: any[] = [
    {
        name: "execute",
        description:
            "Run JavaScript against the page in one call. Use this for anything with more than one dependent step — Playwright keeps the page's real state, so an open menu, a hover or a half-filled form stays alive between steps. " +
            "Globals: page (a real Playwright Page: goto, url, title, content, click, fill, press, hover, selectOption, screenshot, evaluate, locator, getByRole/getByText/getByLabel/getByPlaceholder, waitForURL, …; plus cdp(method, params)), context (BrowserContext), browser, snapshot(), ref('e12'), handoff(), screenshot(), sleep(), console (captured), state (persists between calls), files (read/write inside a fixed root). " +
            "Return a value to send it back; a single-line script without `return` is evaluated as an expression. Time spent in a human handoff does not count against timeoutMs. Runs in a restricted realm: no fs, require, process or import().",
        inputSchema: {
            type: "object",
            properties: {
                code: { type: "string", description: "JavaScript to run. Use `return` to send a value back." },
                timeoutMs: { type: "number", description: "Total budget in ms. Default 60000; 0 disables." },
                session: sessionProperty
            },
            required: ["code"]
        }
    },
    {
        name: "snapshot",
        description:
            "Inspect the page before acting: title, URL, readyState, interactive elements with refs (e12), and a compact outline. Prefer refs over CSS selectors. " +
            "Refs fail closed — acting on one whose element was removed, relabelled or replaced by a navigation raises an error saying what changed; take a new snapshot instead of retrying. " +
            "Opt into a screenshot, DOM snapshot, tabs, cookies or the accessibility tree when you need more than the outline.",
        inputSchema: {
            type: "object",
            properties: {
                maxElements: { type: "number", description: "Maximum interactive elements. Default 40, capped at 200." },
                includeText: { type: "boolean", description: "Include short visible text per element. Default true." },
                screenshot: { type: "boolean", description: "Also capture a screenshot (returned as an image). Default false." },
                fullPage: { type: "boolean", description: "Full-page screenshot when screenshot=true. Default false." },
                domSnapshot: { type: "boolean", description: "Include the CDP DOMSnapshot. Default false." },
                elements: { type: "boolean", description: "Include interactive elements. Default true." },
                som: { type: "boolean", description: "Inject the Set-of-Marks overlay. Default false." },
                tabs: { type: "boolean", description: "Include open tabs. Default false." },
                cookies: { type: "boolean", description: "Include cookies for the current page. Default false." },
                accessibilityTree: { type: "boolean", description: "Include the accessibility tree. Default false." },
                frames: { type: "boolean", description: "Collect controls inside same-origin frames too. Default true." },
                session: sessionProperty
            }
        }
    },
    {
        name: "act",
        description:
            "Do one browser action. Covers navigation, clicking, typing, waiting, reading, capture, emulation and tab management; `execute` is better when several steps depend on each other. " +
            "Prefer refs from snapshot() (`click_by_ref` with ref='e12') over CSS selectors. Atomic and verified where the action type allows it.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ACTION_VALUES, description: "The action to perform." },
                selector: { type: "string", description: "CSS selector for selector-based actions." },
                text: { type: "string", description: "Text to click, type or match." },
                ref: { type: "string", description: "Ref from snapshot() (e12) for click_by_ref." },
                key: { type: "string", description: "Key for press_key/key_combo." },
                role: { type: "string", description: "ARIA/native role hint for semantic actions." },
                name: { type: "string", description: "Accessible name for click_role." },
                label: { type: "string", description: "Visible or accessible label for fill_label." },
                elementId: { type: "string", description: "Set-of-Marks element id ('1' or '@1')." },
                value: { type: "string", description: "Value to type, option to select, or URL to navigate to." },
                url: { type: "string", description: "URL for navigate/smart_navigate." },
                intent: { type: "string", enum: ["click", "fill", "select", "check", "wait_for", "inspect", "navigate"], description: "High-level intent for action=intent." },
                target: { type: "string", description: "Natural target for action=intent (resolved semantically); for agent_action a string is resolved to a selector too." },
                agentAction: { type: "string", description: "Inner action for action=agent_action/observe_and_act." },
                observe: { type: "object", description: "Observe spec for action=observe_and_act." },
                fields: { type: "array", items: { type: "object" }, description: "Fields for action=form_fill." },
                submitAfterFill: { type: "boolean", description: "Submit after form_fill. Default false." },
                verify: { type: "string", description: "Text to wait for after the action." },
                waitFor: { type: "object", description: "Wait spec for smart_navigate." },
                dismissPopups: { type: "boolean", description: "Dismiss popups after smart_navigate." },
                returnScreenshot: { type: "boolean", description: "Return a screenshot with observe_and_act." },
                assertionType: { type: "string", description: "Assertion type for action=assert." },
                options: { type: "object", description: "Action options, e.g. {x,y,width,height} for screenshot_region." },
                coordinate: { type: "string", description: "X,Y coordinates, e.g. '100,200'." },
                x: { type: "number" },
                y: { type: "number" },
                tabId: { type: "number", description: "Tab id for switch_tab/close_tab." },
                files: { type: "array", items: { type: "string" }, description: "Files for upload_file." },
                modifiers: { type: "array", items: { type: "string" }, description: "Key modifiers (Ctrl, Alt, Shift, Meta)." },
                format: { type: "string", description: "Image format (jpeg/png). Default jpeg." },
                quality: { type: "number", description: "Compression quality 0-100. Default 50." },
                maxWidth: { type: "number" },
                maxHeight: { type: "number" },
                everyNthFrame: { type: "number" },
                maxFrames: { type: "number" },
                duration: { type: "number", description: "Capture duration in ms." },
                cookieName: { type: "string" },
                cookieValue: { type: "string" },
                latitude: { type: "number" },
                longitude: { type: "number" },
                timezoneId: { type: "string" },
                urlPattern: { type: "string", description: "URL pattern to mock." },
                mockResponse: { type: "string", description: "Stringified JSON response for mock_network_request." },
                requestId: { type: "string", description: "Request id for get_network_response." },
                offline: { type: "boolean" },
                latency: { type: "number" },
                downloadThroughput: { type: "number" },
                uploadThroughput: { type: "number" },
                landscape: { type: "boolean" },
                printBackground: { type: "boolean" },
                network: { type: "object", description: "Network shaping, e.g. {blockImages, blockAds, blockCSS}." },
                emulation: { type: "object", description: "Device emulation, e.g. {width, height, mobile, userAgent}." },
                visible: { type: "boolean", description: "Require visible element when waiting." },
                stable: { type: "boolean", description: "Require stable bounds when waiting." },
                submitSelector: { type: "string", description: "Submit button for form_fill." },
                parentId: { type: "string", description: "Parent task id for hierarchical tracking." },
                projectRoot: { type: "string", description: "Project root, so a recovered failure can be recorded as a lesson." },
                markdownSummary: { type: "string", description: "Summary text for a captured artifact." },
                domain: { type: "string", description: "CDP domain for configure." },
                script: { type: "object", properties: { onLoad: { type: "string" } }, description: "Script to run on load, for configure." },
                timeout: timeoutProperty,
                session: sessionProperty
            },
            required: ["action"]
        }
    },
    {
        name: "handoff",
        description:
            "HUMAN STEP. Ask the user to do what only a person can — a password, 2FA, a passkey, a payment confirmation, an interactive bot check — and wait for them to click Continue in the page. " +
            "Returns status 'completed', 'timeout' or 'cancelled'. Completion is not verification: assert the expected URL or element afterwards. Never solve a bot challenge yourself or reload-loop a blocked site.",
        inputSchema: {
            type: "object",
            properties: {
                message: { type: "string", description: "What the user should do." },
                timeoutMs: { type: "number", description: "How long to wait in ms. Default 600000." },
                session: sessionProperty
            },
            required: ["message"]
        }
    },
    {
        name: "sessions",
        description:
            "Named, resumable tab pins. A session survives tool calls and MCP restarts and never navigates a tab by itself. " +
            "When the MCP client names the agent, each agent has its own current session; otherwise agents on one server share one. " +
            "`new` creates and makes current (optionally in a named `browser`); `adopt` pins a tab the user already has open (keeps their login); `save_auth`/`load_auth` persist cookies and storage.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["list", "new", "use", "reset", "delete", "adopt", "save_auth", "load_auth"],
                    description: "What to do. Default list."
                },
                id: { type: "string", description: "Session id for use/reset/delete." },
                name: { type: "string", description: "Human name for new; the id is derived from it." },
                browser: { type: "string", description: "Browser id for new, from browser status. Default: the first connected browser." },
                adoptCurrent: { type: "boolean", description: "Pin the active tab on new. Default true." },
                tabId: { type: "string", description: "Target id for adopt (from snapshot tabs=true)." },
                targetUrl: { type: "string", description: "URL or title substring selecting a tab to adopt." },
                targetIndex: { type: "number", description: "Zero-based page index for adopt." },
                path: { type: "string", description: "Auth-state file for save_auth/load_auth." },
                reload: { type: "boolean", description: "Reload after load_auth. Default true." },
                session: sessionProperty
            }
        }
    },
    {
        name: "browser",
        description:
            "Browser lifecycle and status. `extension` starts the local relay and connects to the browser you are already signed into (install the bundled extension once; no second profile); `launch` starts a clean browser; `connect` attaches to a browser started with --remote-debugging-port; `status` reports every connected browser (each has an id) and the active tab; `kill`; `list`; `profiles`. Several browsers can share one relay.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["status", "extension", "launch", "connect", "kill", "list", "profiles"], description: "What to do. Default status." },
                browser: { type: "string", description: "chrome, edge, brave or firefox." },
                headless: { type: "boolean", description: "Launch headless." },
                port: { type: "number", description: "Remote debugging port. Default 9222 (extension relay: 8766)." },
                profile: { type: "string", description: "Profile name to launch." },
                profileDirectory: { type: "string", description: "Profile directory to launch." },
                userDataDir: { type: "string", description: "Dedicated user-data directory." },
                includeTargets: { type: "boolean", description: "Include tabs with status. Default false." },
                waitMs: { type: "number", description: "How long action=extension waits for the extension to dial in. Default 3000." }
            }
        }
    },
    {
        name: "diagnostics",
        description: "Runtime evidence from the live page: `logs` (console, exceptions, dialogs), `network` (failed requests), `performance` (metrics), and HAR capture (`har_start`, `har_stop`, `har_status`). Captures are redacted before they are returned or written.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["logs", "network", "performance", "har_start", "har_stop", "har_status"], description: "What to read or capture. Default logs." },
                limit: { type: "number", description: "Maximum entries. Default 50 for logs, 20 for network." },
                path: { type: "string", description: "For har_stop: write the redacted HAR here." },
                session: sessionProperty
            }
        }
    },
    {
        name: "get_page_text",
        description: "Read the page as clean Markdown or text — token-cheap way to see what the user sees, without a DOM dump.",
        inputSchema: {
            type: "object",
            properties: {
                format: { type: "string", enum: ["markdown", "text"], description: "Default markdown." },
                selector: { type: "string", description: "Restrict to a selector." },
                includeLinks: { type: "boolean", description: "Include link targets. Default true." },
                maxLength: { type: "number", description: "Truncate at this many characters. Default 20000." },
                session: sessionProperty
            }
        }
    },
    {
        name: "captcha",
        description: "Detect human-verification widgets (`detect`), or attempt to solve one (`solve`: human-like click first, third-party service if useService=true). Solving is a last resort — prefer handoff for interactive challenges.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["detect", "solve"], description: "Default detect." },
                useService: { type: "boolean", description: "Use a third-party service instead of a simulated click." },
                service: { type: "string", enum: ["2captcha", "capsolver"], description: "Service when useService=true." },
                apiKey: { type: "string", description: "Service API key. Defaults to CAPTCHA_API_KEY." },
                pageUrl: { type: "string", description: "Page URL passed to the service." },
                waitAfterClick: { type: "number", description: "Ms to wait after the human click. Default 8000." },
                timeout: { type: "number", description: "Max wait for a service solution. Default 120000." },
                pollInterval: { type: "number", description: "Service poll interval. Default 5000." },
                session: sessionProperty
            }
        }
    },
    {
        name: "memory",
        description:
            "Project-local learning in <project>/.aether: `configure` enables it, `recall` before a workflow you have run here, `remember` after a recovered failure or non-trivial discovery, `outcome` adjusts a lesson's confidence, `compact` prunes, `graph` shows recent task nodes.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["configure", "remember", "recall", "outcome", "compact", "graph"], description: "What to do." },
                projectRoot: { type: "string", description: "Absolute project root. Defaults to AETHER_PROJECT_ROOT or cwd." },
                title: { type: "string" },
                trigger: { type: "string", description: "When this lesson should be considered again." },
                problemPattern: { type: "string", description: "Reusable failure pattern." },
                symptoms: { type: "array", items: { type: "string" } },
                failedApproach: { type: "string" },
                betterApproach: { type: "string", description: "The reusable better way." },
                createdBecause: {
                    type: "string",
                    enum: ["complex_task_succeeded", "errors_overcome", "user_corrected_approach_worked", "non_trivial_workflow_discovered", "user_asked_to_remember"]
                },
                evidence: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                confidence: { type: "number" },
                intent: { type: "string", description: "Recall: what you are trying to do." },
                problem: { type: "string", description: "Recall: the problem you hit." },
                id: { type: "string", description: "Lesson id for outcome." },
                success: { type: "boolean", description: "Did the lesson work? For outcome." },
                limit: { type: "number", description: "Maximum lessons to return." }
            }
        }
    },
    {
        name: "skill",
        description: "Project-local procedures in <project>/.aether/skills: `create` a SKILL.md, `list` them with maintenance state, `maintain` to keep, patch, consolidate or prune one.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["create", "list", "maintain"], description: "What to do." },
                projectRoot: { type: "string" },
                name: { type: "string", description: "Lowercase hyphenated skill name; used for list/maintain too." },
                description: { type: "string", description: "Frontmatter description: what it does and when to use it." },
                trigger: { type: "string", description: "When to apply the procedure." },
                procedure: { type: "array", items: { type: "string" } },
                examples: { type: "array", items: { type: "string" } },
                edgeCases: { type: "array", items: { type: "string" } },
                verification: { type: "array", items: { type: "string" } },
                reason: { type: "string", description: "Why, for maintain." },
                patchBody: { type: "string", description: "Full replacement SKILL.md when maintain action=patch." },
                consolidateInto: { type: "string", description: "Target skill name when maintain action=consolidate." }
            }
        }
    },
    {
        name: "secrets",
        description:
            "Site secrets the user stores, used without being exposed to the model. `list`/`status` show names, origins and keys (never values); `set` stores values (0600 on disk); `remove` deletes a profile; `type` fills a field with a stored value without returning it; `run` runs a command with BC_SECRET_1..N in an allowlisted environment. Known values are scrubbed from execute output, HARs and diagnostics.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["list", "status", "set", "remove", "type", "run"], description: "What to do." },
                name: { type: "string", description: "Profile name." },
                key: { type: "string", description: "For set: a single value's key." },
                value: { type: "string", description: "For set: a single value. It is stored, not echoed." },
                values: { type: "object", additionalProperties: { type: "string" }, description: "For set: the whole key/value map." },
                origins: { type: "array", items: { type: "string" }, description: "Origins the secret may be typed into." },
                selector: { type: "string", description: "For type: the field selector." },
                label: { type: "string", description: "For type: the field label." },
                ref: { type: "string", description: "For type: a snapshot ref." },
                secretKey: { type: "string", description: "For type: which stored key to use. Default: the first." },
                command: { type: "string", description: "For run: executable." },
                args: { type: "array", items: { type: "string" }, description: "For run: arguments." },
                timeoutMs: { type: "number", description: "For run: timeout. Default 60000." },
                session: sessionProperty
            },
            required: ["action"]
        }
    },
    {
        name: "cdp_command",
        description: "Escape hatch: send one raw Chrome DevTools Protocol command (method + args) and get the raw result. Relay guardrails still refuse commands that would close the browser or wipe shared state. Use `execute` when you need several.",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "CDP method, e.g. 'Page.captureScreenshot'." },
                args: { type: "object", description: "CDP parameters." },
                session: sessionProperty
            },
            required: ["command"]
        }
    }
];
