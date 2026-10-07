import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getCdpBridge } from "./cdp-bridge";
import { McpTaskMemory } from "./mcp-task-memory";
import { jsonContent, toolError, jsonWithImages, resultWithImages, imageContent } from "./mcp-responses";
import { AetherMemoryStore } from "./aether-memory-store";

const taskMemory = new McpTaskMemory();
const aetherMemory = new AetherMemoryStore();

const Tools = [
    {
        name: "get_task_graph",
        description: "Retrieve the hierarchical task graph for the current session (Aether v2 Task Orbit).",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "configure_aether_memory",
        description: "Initialize project-local Aether learning in <project>/.aether and add .aether/ to .gitignore. Use before storing or recalling repo-specific lessons and SKILL.md skills.",
        inputSchema: {
            type: "object",
            properties: {
                projectRoot: { type: "string", description: "Absolute path to the project/repo root. Defaults to AETHER_PROJECT_ROOT or the MCP process cwd." }
            }
        }
    },
    {
        name: "remember_aether_lesson",
        description: "Store a compact reusable lesson after a complex success, recovered error, user correction, or non-trivial workflow discovery. Stores only distilled issue/solution learning in project-local .aether.",
        inputSchema: {
            type: "object",
            properties: {
                projectRoot: { type: "string" },
                title: { type: "string" },
                trigger: { type: "string", description: "When this lesson should be considered again." },
                problemPattern: { type: "string", description: "Reusable failure pattern or friction that appeared." },
                symptoms: { type: "array", items: { type: "string" } },
                failedApproach: { type: "string" },
                betterApproach: { type: "string", description: "The reusable better way Aether learned." },
                createdBecause: {
                    type: "string",
                    enum: [
                        "complex_task_succeeded",
                        "errors_overcome",
                        "user_corrected_approach_worked",
                        "non_trivial_workflow_discovered",
                        "user_asked_to_remember"
                    ]
                },
                evidence: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                confidence: { type: "number" }
            },
            required: ["title", "trigger", "problemPattern", "betterApproach", "createdBecause"]
        }
    },
    {
        name: "recall_aether_memory",
        description: "Recall relevant project-local Aether lessons by intent, problem, or tags. Returns compact issue/solution records from .aether only.",
        inputSchema: {
            type: "object",
            properties: {
                projectRoot: { type: "string" },
                intent: { type: "string" },
                problem: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                limit: { type: "number" }
            }
        }
    },
    {
        name: "record_aether_lesson_outcome",
        description: "Update confidence for a stored Aether lesson after it succeeds or fails later.",
        inputSchema: {
            type: "object",
            properties: {
                projectRoot: { type: "string" },
                id: { type: "string" },
                success: { type: "boolean" },
                evidence: { type: "string" }
            },
            required: ["id", "success"]
        }
    },
    {
        name: "create_aether_skill",
        description: "Create or replace a project-local Claude-style skill at .aether/skills/<name>/SKILL.md for reusable procedures Aether should apply in this repo.",
        inputSchema: {
            type: "object",
            properties: {
                projectRoot: { type: "string" },
                name: { type: "string", description: "Lowercase hyphenated skill name; normalized if needed." },
                description: { type: "string", description: "Frontmatter description with what the skill does and when to use it." },
                trigger: { type: "string", description: "Concise body text explaining when to apply the procedure." },
                procedure: { type: "array", items: { type: "string" } },
                examples: { type: "array", items: { type: "string" } },
                edgeCases: { type: "array", items: { type: "string" } },
                verification: { type: "array", items: { type: "string" } }
            },
            required: ["name", "description", "trigger", "procedure"]
        }
    },
    {
        name: "list_aether_skills",
        description: "List project-local Aether SKILL.md procedures and their maintenance state.",
        inputSchema: {
            type: "object",
            properties: {
                projectRoot: { type: "string" }
            }
        }
    },
    {
        name: "maintain_aether_skill",
        description: "Maintain a project-local Aether skill: keep valuable skills, patch outdated instructions, consolidate near-duplicates, or prune stale skills.",
        inputSchema: {
            type: "object",
            properties: {
                projectRoot: { type: "string" },
                name: { type: "string" },
                action: { type: "string", enum: ["keep", "patch", "consolidate", "prune"] },
                reason: { type: "string" },
                patchBody: { type: "string", description: "Full replacement SKILL.md content when action=patch." },
                consolidateInto: { type: "string", description: "Target skill name when action=consolidate." }
            },
            required: ["name", "action", "reason"]
        }
    },
    {
        name: "compact_aether_memory",
        description: "Prune and compact project-local Aether memory according to caps, then refresh .aether/memory/learned.json.",
        inputSchema: {
            type: "object",
            properties: {
                projectRoot: { type: "string" }
            }
        }
    },
    {
        name: "act",
        description: "PRIMARY ACTION TOOL. Perform precise, high-speed actions in the browser. Uses native events which correctly trigger React/SPA state (unlike raw JS `value=` assignments). Supports navigation, clicking, typing, scrolling, and tab management with atomic verification.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: [
                        "navigate", "click", "type", "fill", "select", "check",
                        "hover", "scroll", "wait", "screenshot",
                        "new_tab", "switch_tab", "close_tab", "drag_and_drop", "upload_file",
                        "get_tree", "get_dom_tree", "configure", "print_pdf", "emulate_network",
                        "get_cookies", "set_cookie", "clear_cache", "set_geolocation", "set_timezone", "get_performance_metrics",
                        "start_screencast", "stop_screencast", "record_session", "sample_visual_frames",
                        "mock_network_request", "highlight_elements",
                        "assert", "start_tracing", "stop_tracing",
                        "screenshot_region", "verify_ui_state", "get_dom_snapshot", "get_event_listeners",
                        "get_computed_style", "get_network_traffic", "get_network_response",
                        "get_screencast_frames", "get_dom_storage", "get_logs", "press_key", "key_combo",
                        "click_text", "click_role", "fill_label", "element_at_point", "detect_captcha"
                    ],
                    description: "The action to perform."
                },
                selector: { type: "string", description: "CSS selector or text content to interact with." },
                text: { type: "string", description: "Text to click, type, or match." },
                key: { type: "string", description: "Keyboard key for press_key/key_combo." },
                role: { type: "string", description: "ARIA/native role hint for semantic actions." },
                name: { type: "string", description: "Accessible name for click_role." },
                label: { type: "string", description: "Visible or accessible label for fill_label." },
                elementId: { type: "string", description: "Element ID from `get_state` (e.g., '1' or '@1'). Preferred over selector. Both formats are accepted." },
                value: { type: "string", description: "Value to type, option to select, or URL to navigate to." },
                assertionType: { type: "string", description: "Assertion type for 'assert' action (e.g., 'element_exists', 'element_not_exists', 'element_contains_text', 'url_contains')." },
                options: { type: "object", description: "Options for the action (e.g., {x, y, width, height} for screenshot_region)." },
                domain: { type: "string", description: "CDP domain to enable (for enable_domain action)." },
                coordinate: { type: "string", description: "X,Y coordinates (e.g., '100,200')." },
                x: { type: "number", description: "X coordinate." },
                y: { type: "number", description: "Y coordinate." },
                visible: { type: "boolean", description: "Require visible selector when waiting. Default varies by action." },
                stable: { type: "boolean", description: "Require stable element bounds when waiting. Default varies by action." },
                parentId: { type: "string", description: "Parent task ID for hierarchical tracking (UFO3)." },
                projectRoot: { type: "string", description: "Optional project root for recording distilled Aether lessons when recovery succeeds." },
                tabId: { type: "number", description: "Tab ID for switching/closing." },
                files: { type: "array", items: { type: "string" }, description: "Files for upload_file action" },
                modifiers: { type: "array", items: { type: "string" }, description: "Key modifiers (Ctrl, Alt, etc.)" },

                // Screencast / Record params
                format: { type: "string", description: "Image format (jpeg/png). Default: jpeg" },
                quality: { type: "number", description: "Compression quality (0-100). Default: 50" },
                maxWidth: { type: "number", description: "Max width of the frame. Default: 1024" },
                maxHeight: { type: "number", description: "Max height of the frame. Default: 768" },
                everyNthFrame: { type: "number", description: "Frequency of captured frames. Default: 10" },
                maxFrames: { type: "number", description: "Maximum number of frames to return. Default: all" },
                duration: { type: "number", description: "Duration in ms to record (only for record_session). Default: 5000" },

                // CDP specific params
                cookieName: { type: "string", description: "Name of the cookie to set." },
                cookieValue: { type: "string", description: "Value of the cookie to set." },
                latitude: { type: "number", description: "Latitude for geolocation override." },
                longitude: { type: "number", description: "Longitude for geolocation override." },
                timezoneId: { type: "string", description: "Timezone ID (e.g., 'America/New_York')." },

                // Mocking & Artifact params
                urlPattern: { type: "string", description: "URL pattern to mock (e.g., '*api.example.com*')" },
                mockResponse: { type: "string", description: "Stringified JSON to return as mocked response" },
                markdownSummary: { type: "string", description: "Summary text for the artifact" },
                requestId: { type: "string", description: "Request ID for get_network_response" },

                // Network Emulation params
                offline: { type: "boolean" },
                latency: { type: "number" },
                downloadThroughput: { type: "number" },
                uploadThroughput: { type: "number" },

                // PDF params (subset)
                landscape: { type: "boolean" },
                printBackground: { type: "boolean" },

                // Configuration params
                network: {
                    type: "object",
                    properties: { blockImages: { type: "boolean" }, blockAds: { type: "boolean" }, blockCSS: { type: "boolean" } }
                },
                emulation: {
                    type: "object",
                    properties: { width: { type: "number" }, height: { type: "number" }, mobile: { type: "boolean" }, userAgent: { type: "string" } }
                },
                script: {
                    type: "object",
                    properties: { onLoad: { type: "string" } }
                }
            },
            required: ["action"],
        },
    },
    {
        name: "get_state",
        description: "Capture the current browser state (v2). Lightweight by default; opt into screenshots, DOM snapshot, SoM overlay, or tabs when needed.",
        inputSchema: {
            type: "object",
            properties: {
                screenshot: { type: "boolean", description: "Include screenshot. Default false." },
                domSnapshot: { type: "boolean", description: "Include full DOMSnapshot. Default false." },
                elements: { type: "boolean", description: "Include interactive elements. Default true." },
                som: { type: "boolean", description: "Inject Set-of-Marks overlay. Default false." },
                tabs: { type: "boolean", description: "Include browser tabs. Default false." }
            }
        },
    },
    {
        name: "browser_status",
        description: "FAST IDE TOOL. Return compact browser connection and active target status without launching a browser.",
        inputSchema: {
            type: "object",
            properties: {
                includeTargets: { type: "boolean", description: "Include known CDP targets/tabs when already connected." }
            }
        }
    },
    {
        name: "snapshot_compact",
        description: "FAST IDE TOOL. Capture a small text-only page snapshot: title, URL, readyState, and a limited interactive element list. No screenshot or DOM snapshot by default.",
        inputSchema: {
            type: "object",
            properties: {
                maxElements: { type: "number", description: "Maximum interactive elements to return. Default 30." },
                includeText: { type: "boolean", description: "Include short visible text for elements. Default true." }
            }
        }
    },
    {
        name: "list_interactive_elements",
        description: "FAST IDE TOOL. Return compact clickable/typable element references that can be passed to click_by_ref. Does not inject visual overlays unless requested.",
        inputSchema: {
            type: "object",
            properties: {
                maxElements: { type: "number", description: "Maximum elements to return. Default 50." },
                withOverlay: { type: "boolean", description: "Inject Set-of-Marks overlay. Default false." }
            }
        }
    },
    {
        name: "click_by_ref",
        description: "FAST IDE TOOL. Click an element reference returned by snapshot_compact or list_interactive_elements.",
        inputSchema: {
            type: "object",
            properties: {
                ref: { type: "string", description: "Element reference, usually css:<selector>." }
            },
            required: ["ref"]
        }
    },
    {
        name: "click_by_selector",
        description: "FAST IDE TOOL. Click a CSS selector with a compact response.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string" },
                timeout: { type: "number", description: "Timeout in ms. Default 5000." }
            },
            required: ["selector"]
        }
    },
    {
        name: "fill_by_selector",
        description: "FAST IDE TOOL. Focus, clear, and type text into a CSS selector with a compact response.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string" },
                value: { type: "string" },
                timeout: { type: "number", description: "Timeout in ms. Default 5000." }
            },
            required: ["selector", "value"]
        }
    },
    {
        name: "wait_for_selector",
        description: "FAST IDE TOOL. Wait for a selector and return a compact boolean result.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string" },
                timeout: { type: "number", description: "Timeout in ms. Default 5000." }
            },
            required: ["selector"]
        }
    },
    {
        name: "wait_for_text",
        description: "FAST IDE TOOL. Wait until visible page text contains the expected string.",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string" },
                timeout: { type: "number", description: "Timeout in ms. Default 5000." }
            },
            required: ["text"]
        }
    },
    {
        name: "get_network_errors",
        description: "FAST IDE TOOL. Return recent failed network entries only, keeping debugging payloads small.",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "number", description: "Maximum errors to return. Default 20." }
            }
        }
    },
    {
        name: "browser_intent",
        description: "NATURAL IDE TOOL. Perform a high-level browser intent such as click, fill, select, check, wait_for, inspect, or navigate. Resolves targets by selector, role, text, aria-label, label, placeholder, name, and visibility before acting.",
        inputSchema: {
            type: "object",
            properties: {
                intent: { type: "string", enum: ["click", "fill", "select", "check", "wait_for", "inspect", "navigate"] },
                target: { type: "string", description: "Natural target such as 'login', 'Email', 'Submit', or a CSS selector." },
                value: { type: "string", description: "Value for fill/select/navigate or expected text for wait_for." },
                role: { type: "string", description: "Optional role hint such as button, link, textbox, checkbox, combobox." },
                timeout: { type: "number", description: "Timeout in ms. Default 7000." },
                verify: { type: "string", description: "Optional text to wait for after the action." },
                includeCandidates: { type: "boolean", description: "Include resolver candidates for debugging. Default false." }
            },
            required: ["intent"]
        }
    },
    {
        name: "get_logs",
        description: "FAST DEBUG TOOL. Return recent console logs, runtime exceptions, browser log entries, and JavaScript dialogs.",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "number", description: "Maximum log entries to return. Default 50." }
            }
        }
    },
    {
        name: "detect_captcha",
        description: "SAFE GUARD TOOL. Detect common CAPTCHA/human-verification widgets and report manual-solve requirement without interacting with them.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "solve_captcha",
        description: "AUTO-SOLVE TOOL. Solves the CAPTCHA on the current page by simulating human mouse movement and clicking the widget (no API key needed). Works for Cloudflare Turnstile, reCAPTCHA v2 checkbox, hCaptcha. Set useService=true to fall back to a third-party solving service for image challenges.",
        inputSchema: {
            type: "object",
            properties: {
                useService:     { type: "boolean", description: "Use third-party service instead of human simulation. Default false." },
                service:        { type: "string", enum: ["2captcha", "capsolver"], description: "Service to use when useService=true. Default '2captcha'." },
                apiKey:         { type: "string", description: "API key for the service. Defaults to env CAPTCHA_API_KEY." },
                pageUrl:        { type: "string", description: "Page URL passed to the service. Defaults to current browser URL." },
                waitAfterClick: { type: "number", description: "Ms to wait for captcha to clear after human click. Default 8000." },
                timeout:        { type: "number", description: "Max wait for service solution in ms. Default 120000." },
                pollInterval:   { type: "number", description: "Service poll interval in ms. Default 5000." }
            }
        }
    },
    {
        name: "press_key",
        description: "FAST IDE TOOL. Press a keyboard key or shortcut using native CDP key events.",
        inputSchema: {
            type: "object",
            properties: {
                key: { type: "string", description: "Key such as Enter, Tab, Escape, Backspace, ArrowDown, or a single letter." },
                modifiers: { type: "array", items: { type: "string" }, description: "Optional modifiers such as Ctrl, Shift, Alt, Meta." }
            },
            required: ["key"]
        }
    },
    {
        name: "click_text",
        description: "FAST IDE TOOL. Click a visible element by text with optional role hint and compact post-action facts.",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string" },
                role: { type: "string" },
                timeout: { type: "number" }
            },
            required: ["text"]
        }
    },
    {
        name: "click_role",
        description: "FAST IDE TOOL. Click a visible element by role and accessible name.",
        inputSchema: {
            type: "object",
            properties: {
                role: { type: "string" },
                name: { type: "string" },
                timeout: { type: "number" }
            },
            required: ["role"]
        }
    },
    {
        name: "fill_label",
        description: "FAST IDE TOOL. Fill a textbox-like field by visible/accessibility label with compact post-action facts.",
        inputSchema: {
            type: "object",
            properties: {
                label: { type: "string" },
                value: { type: "string" },
                role: { type: "string" },
                timeout: { type: "number" }
            },
            required: ["label", "value"]
        }
    },
    {
        name: "element_at_point",
        description: "FAST DEBUG TOOL. Inspect the element that would receive a coordinate click.",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "number" },
                y: { type: "number" },
                coordinate: { type: "string", description: "Alternative X,Y coordinate string." }
            }
        }
    },
    {
        name: "execute_script",
        description: "Execute arbitrary JavaScript in the browser context. Tip: wrap your code in a block `{}` or IIFE to avoid `SyntaxError: Identifier has already been declared` when reusing variable names across multiple calls.",
        inputSchema: {
            type: "object",
            properties: { script: { type: "string" } },
            required: ["script"],
        },
    },
    {
        name: "cdp_command",
        description: "Execute a raw Chrome DevTools Protocol (CDP) command on the active tab.",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "The CDP command method (e.g., 'Network.getCookies')." },
                args: { type: "object", description: "The JSON arguments required by the CDP command." }
            },
            required: ["command"],
        }
    },
    {
        name: "connect_browser",
        description: "Connect to a browser. Use mode=extension to control a dedicated Aether tab in an already-running browser through the Aether Browser Bridge extension.",
        inputSchema: {
            type: "object",
            properties: {
                mode: { type: "string", enum: ["connect", "launch", "auto", "ask", "extension"], description: "Connect to a CDP port, launch a browser, return choices, or attach to the extension-managed tab." },
                port: { type: "number", description: "Browser debugging port (default: 9222)." },
                headless: { type: "boolean", description: "Run in headless mode (only for launch mode)." },
                browser: { type: "string", enum: ["chrome", "edge", "brave", "firefox"], description: "Browser to use (default: auto-detect, or brave when profile is set)." },
                profile: { type: "string", description: "Named browser profile to launch, e.g. Personal or Work. Defaults browser to brave when set." },
                profileDirectory: { type: "string", description: "Exact Chromium profile directory, e.g. Default or Profile 1." },
                userDataDir: { type: "string", description: "Chromium user data root to use with profileDirectory." }
            }
        }
    },
    {
        name: "launch_browser",
        description: "Launch a browser (auto-detects available browsers if not specified).",
        inputSchema: {
            type: "object",
            properties: {
                browser: { type: "string", enum: ["chrome", "edge", "brave", "firefox"], description: "Browser to launch (default: auto-detect first available)." },
                headless: { type: "boolean", description: "Run in headless mode." },
                port: { type: "number", description: "Debugging port (default: 9222)." },
                profile: { type: "string", description: "Named browser profile to launch, e.g. Personal or Work. Defaults browser to brave when set." },
                profileDirectory: { type: "string", description: "Exact Chromium profile directory, e.g. Default or Profile 1." },
                userDataDir: { type: "string", description: "Chromium user data root to use with profileDirectory." }
            }
        }
    },
    {
        name: "kill_browser",
        description: "Kill the launched browser process when done.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "list_browsers",
        description: "List all available browsers on the system.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "list_browser_profiles",
        description: "List Chromium profiles that can be launched with browser control. Defaults to Brave.",
        inputSchema: {
            type: "object",
            properties: {
                browser: { type: "string", enum: ["chrome", "edge", "brave"], description: "Browser profile store to inspect. Default: brave." }
            }
        }
    },
    {
        name: "sample_visual_frames",
        description: "VISION TOOL. Capture a few compressed screencast frames so the agent can inspect animation/video/dynamic UI without recording a large session.",
        inputSchema: {
            type: "object",
            properties: {
                duration: { type: "number", description: "Sampling duration in ms. Default 1500, max 10000." },
                maxFrames: { type: "number", description: "Maximum frames to return. Default 4, max 12." },
                quality: { type: "number", description: "JPEG quality. Default 45." },
                maxWidth: { type: "number", description: "Max frame width. Default 800." },
                maxHeight: { type: "number", description: "Max frame height. Default 600." },
                everyNthFrame: { type: "number", description: "CDP frame sampling interval. Default 3." }
            }
        }
    },
    // ==================== AGENT-CENTRIC APIs ====================
    {
        name: "agent_action",
        description: "WARNING: Can return massive payloads (>100KB) with full DOM state and logs. Prefer using `act` for routine operations. Execute an action and optionally verify UI state. Unified action API that combines action + wait + verify in one call. Returns screenshot after action.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["click", "type", "scroll", "hover", "drag", "key_press"],
                    description: "Action to perform."
                },
                target: {
                    type: "object",
                    properties: {
                        id: { type: "string", description: "Element ID from page_snapshot" },
                        selector: { type: "string", description: "CSS selector" },
                        text: { type: "string", description: "Text to match" },
                        x: { type: "number", description: "X coordinate" },
                        y: { type: "number", description: "Y coordinate" },
                        button: { type: "string", enum: ["left", "middle", "right"] },
                        clickCount: { type: "number" },
                        key: { type: "string", description: "Key to press" },
                        modifiers: { type: "array", items: { type: "string" } }
                    }
                },
                verify: {
                    type: "object",
                    properties: {
                        selector: { type: "string" },
                        expectedText: { type: "string" },
                        type: { type: "string", enum: ["element_exists", "element_contains_text", "text_match", "element_visible"] }
                    }
                },
                waitFor: {
                    type: "object",
                    properties: {
                        type: { type: "string", enum: ["network_idle", "element", "navigation"] },
                        selector: { type: "string" },
                        timeout: { type: "number" }
                    }
                },
                screenshot: { type: "boolean", description: "Return screenshot after action. Default false." },
                timeout: { type: "number", description: "Timeout in ms (default: 10000)" }
            },
            required: ["action", "target"]
        }
    },
    {
        name: "smart_navigate",
        description: "Navigate to URL with built-in waiting for page stability. Auto-dismisses popups. Returns screenshot of loaded page.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "URL to navigate to." },
                waitFor: {
                    type: "object",
                    properties: {
                        type: { type: "string", enum: ["element", "network_idle"] },
                        selector: { type: "string" },
                        timeout: { type: "number" }
                    }
                },
                dismissPopups: { type: "boolean", description: "Auto-dismiss popups (default: true)" },
                screenshot: { type: "boolean", description: "Return screenshot (default: true)" },
                timeout: { type: "number", description: "Navigation timeout in ms (default: 30000)" }
            },
            required: ["url"]
        }
    },
    {
        name: "observe_and_act",
        description: "Execute an action and observe page state changes. Returns before/after snapshots to detect what changed.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "object",
                    properties: {
                        type: { type: "string", enum: ["click", "type"] },
                        selector: { type: "string" },
                        text: { type: "string" }
                    }
                },
                observe: {
                    type: "object",
                    properties: {
                        type: { type: "string", enum: ["dom_change", "network_response"] }
                    }
                },
                returnScreenshot: { type: "boolean", description: "Return screenshots (default: true)" }
            },
            required: ["action"]
        }
    },
    {
        name: "agent_form_fill",
        description: "Intelligently fill form fields. Auto-detects field types (text, select, checkbox, radio, file).",
        inputSchema: {
            type: "object",
            properties: {
                fields: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            selector: { type: "string" },
                            type: { type: "string", enum: ["text", "email", "password", "select", "checkbox", "radio", "file", "textarea"] },
                            value: { type: "string" },
                            checked: { type: "boolean" },
                            files: { type: "array", items: { type: "string" } }
                        }
                    },
                    description: "Form fields to fill."
                },
                submitAfterFill: { type: "boolean", description: "Submit form after filling (default: false)" },
                submitSelector: { type: "string", description: "Selector for submit button" }
            },
            required: ["fields"]
        }
    },
    {
        name: "get_page_text",
        description: "READ TOOL. Extract clean, readable page content as Markdown (or plain text). Token-cheap alternative to screenshots or full DOM dumps for reading/understanding a page. Scopes to a CSS selector when given, otherwise auto-detects the main content region.",
        inputSchema: {
            type: "object",
            properties: {
                format: { type: "string", enum: ["markdown", "text"], description: "Output format. Default markdown." },
                selector: { type: "string", description: "Optional CSS selector to scope extraction to a region." },
                includeLinks: { type: "boolean", description: "Render anchors as [text](href) in markdown. Default true." },
                maxLength: { type: "number", description: "Max characters returned before truncation. Default 20000." }
            }
        }
    },
    {
        name: "save_auth_state",
        description: "SESSION TOOL. Export the current browser session (cookies + localStorage + sessionStorage) to a JSON file so a logged-in session can be reused later with load_auth_state. Avoids repeating logins.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path to write the auth state JSON. Defaults to <cwd>/.aether/auth-state.json." },
                origins: { type: "array", items: { type: "string" }, description: "Optional list of origins to capture storage for. Defaults to the current origin." }
            }
        }
    },
    {
        name: "load_auth_state",
        description: "SESSION TOOL. Restore a previously saved session (cookies + localStorage + sessionStorage) from a JSON file written by save_auth_state. Navigate to the target site first, then load, then reload.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path to read the auth state JSON. Defaults to <cwd>/.aether/auth-state.json." },
                reload: { type: "boolean", description: "Reload the active tab after restoring so storage takes effect. Default true." }
            }
        }
    },
    {
        name: "page_snapshot",
        description: "Capture page context optimized for LLM consumption. Lightweight by default; opt into screenshots, cookies, accessibility tree, or full DOM snapshot when needed.",
        inputSchema: {
            type: "object",
            properties: {
                fullPage: { type: "boolean", description: "Full page screenshot (default: false)" },
                includeDOMSnapshot: { type: "boolean", description: "Include full DOM snapshot (default: false)" },
                screenshot: { type: "boolean", description: "Include screenshot. Default false." },
                cookies: { type: "boolean", description: "Include cookies. Default false." },
                accessibilityTree: { type: "boolean", description: "Include simplified accessibility tree. Default false." }
            }
        }
    }
];

export function RegisterMcpTools(server: Server, wsServer?: any) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const a = args as any;
        const bridge = getCdpBridge();

        try {
            if (name === "get_task_graph") {
                return jsonContent(taskMemory.graph(), true);
            }

            if (name === "configure_aether_memory") {
                return jsonContent(await aetherMemory.configure(a?.projectRoot), true);
            }

            if (name === "remember_aether_lesson") {
                return jsonContent(await aetherMemory.rememberLesson({
                    projectRoot: a?.projectRoot,
                    title: a.title,
                    trigger: a.trigger,
                    problemPattern: a.problemPattern,
                    symptoms: a?.symptoms,
                    failedApproach: a?.failedApproach,
                    betterApproach: a.betterApproach,
                    createdBecause: a.createdBecause,
                    evidence: a?.evidence,
                    tags: a?.tags,
                    confidence: a?.confidence,
                }), true);
            }

            if (name === "recall_aether_memory") {
                return jsonContent(await aetherMemory.recallLessons({
                    projectRoot: a?.projectRoot,
                    intent: a?.intent,
                    problem: a?.problem,
                    tags: a?.tags,
                    limit: a?.limit,
                }), true);
            }

            if (name === "record_aether_lesson_outcome") {
                return jsonContent(await aetherMemory.recordLessonOutcome({
                    projectRoot: a?.projectRoot,
                    id: a.id,
                    success: a.success,
                    evidence: a?.evidence,
                }), true);
            }

            if (name === "create_aether_skill") {
                return jsonContent(await aetherMemory.createSkill({
                    projectRoot: a?.projectRoot,
                    name: a.name,
                    description: a.description,
                    trigger: a.trigger,
                    procedure: a.procedure,
                    examples: a?.examples,
                    edgeCases: a?.edgeCases,
                    verification: a?.verification,
                }), true);
            }

            if (name === "list_aether_skills") {
                return jsonContent(await aetherMemory.listSkills(a?.projectRoot), true);
            }

            if (name === "maintain_aether_skill") {
                return jsonContent(await aetherMemory.maintainSkill({
                    projectRoot: a?.projectRoot,
                    name: a.name,
                    action: a.action,
                    reason: a.reason,
                    patchBody: a?.patchBody,
                    consolidateInto: a?.consolidateInto,
                }), true);
            }

            if (name === "compact_aether_memory") {
                return jsonContent(await aetherMemory.compact(a?.projectRoot), true);
            }

            if (name === "connect_browser") {
                // In extension deployments the safe default is the dedicated
                // extension-owned tab, even when an agent omits a mode.
                const mode = a?.mode || (process.env.AETHER_MODE === "extension" ? "extension" : "auto");
                const port = a?.port || 9222;
                const browser = a?.browser || ((a?.profile || a?.profileDirectory) ? "brave" : undefined);

                if (mode === "extension") {
                    const result = await bridge.connectExtension();
                    return { content: [{ type: "text", text: result }] };
                }

                if (mode === "ask") {
                    const profiles = await bridge.listBrowserProfiles("brave");
                    const choices = [
                        { id: "clean", label: "Aether clean browser" },
                        ...profiles.map((p: any) => ({ id: `${p.browser}:${p.directory}`, label: `${p.name} (${p.browser})` }))
                    ];

                    const clientCapabilities = (server as any).getClientCapabilities?.();
                    if (clientCapabilities?.elicitation) {
                        try {
                            const response = await (server as any).request({
                                method: "elicitation/create",
                                params: {
                                    message: "Which browser should Aether control?",
                                    requestedSchema: {
                                        type: "object",
                                        properties: {
                                            choice: {
                                                type: "string",
                                                enum: choices.map((choice) => choice.id),
                                                description: choices.map((choice) => `${choice.id} = ${choice.label}`).join("; ")
                                            }
                                        },
                                        required: ["choice"]
                                    }
                                }
                            }, z.object({
                                action: z.string(),
                                content: z.any().optional()
                            }).passthrough());

                            if (response.action !== "accept") {
                                return { content: [{ type: "text", text: "Browser launch cancelled." }] };
                            }

                            const choice = response.content?.choice;
                            if (choice === "clean") {
                                const result = await bridge.launchBrowser({ port, headless: a?.headless });
                                return { content: [{ type: "text", text: result }] };
                            }

                            const selected = profiles.find((p: any) => `${p.browser}:${p.directory}` === choice);
                            if (!selected) {
                                throw new Error(`Unknown browser choice: ${choice}`);
                            }

                            const result = await bridge.launchBrowser({
                                browser: selected.browser,
                                profileDirectory: selected.directory,
                                userDataDir: selected.userDataDir,
                                port,
                                headless: a?.headless,
                            });
                            return { content: [{ type: "text", text: result }] };
                        } catch (error) {
                            console.error("[MCP] Elicitation failed; falling back to text choices:", error);
                        }
                    }

                    const fallbackChoices = [
                        `Aether clean browser: call launch_browser({ "port": ${port} })`,
                        ...profiles.map((p: any) =>
                            `${p.name}: call launch_browser({ "browser": "${p.browser}", "profile": "${p.name}", "port": ${port} })`
                        )
                    ].join("\n");
                    return { content: [{ type: "text", text: `Available controlled browser choices:\n${fallbackChoices}` }] };
                }
                
                if (mode === "connect") {
                    await bridge.sendCommand("connect", { port });
                    return { content: [{ type: "text", text: "Connected to browser successfully" }] };
                } else if (mode === "launch") {
                    const result = await bridge.launchBrowser({ 
                        browser,
                        headless: a?.headless, 
                        port,
                        profile: a?.profile,
                        profileDirectory: a?.profileDirectory,
                        userDataDir: a?.userDataDir,
                    });
                    return { content: [{ type: "text", text: result }] };
                } else {
                    // auto mode - detect and launch
                    const result = await bridge.launchBrowser({ 
                        browser,
                        headless: a?.headless, 
                        port,
                        profile: a?.profile,
                        profileDirectory: a?.profileDirectory,
                        userDataDir: a?.userDataDir,
                    });
                    return { content: [{ type: "text", text: result }] };
                }
            }

            if (name === "launch_browser") {
                if (process.env.AETHER_MODE === "extension") {
                    const result = await bridge.connectExtension();
                    return { content: [{ type: "text", text: result }] };
                }
                const browser = a?.browser || ((a?.profile || a?.profileDirectory) ? "brave" : undefined);
                const result = await bridge.launchBrowser({ 
                    browser,
                    headless: a?.headless,
                    port: a?.port,
                    profile: a?.profile,
                    profileDirectory: a?.profileDirectory,
                    userDataDir: a?.userDataDir,
                });
                return { content: [{ type: "text", text: result }] };
            }

            if (name === "kill_browser") {
                const result = await bridge.killBrowser();
                return { content: [{ type: "text", text: result }] };
            }

            if (name === "list_browsers") {
                const browsers = await bridge.listBrowsers();
                if (browsers.length === 0) {
                    return { content: [{ type: "text", text: "No supported browsers found. Please install Chrome, Edge, Brave, or Firefox." }] };
                }
                const list = browsers.map((b: any) => `${b.name}: ${b.path}`).join("\n");
                return { content: [{ type: "text", text: `Available browsers:\n${list}` }] };
            }

            if (name === "list_browser_profiles") {
                const profiles = await bridge.listBrowserProfiles(a?.browser || "brave");
                if (profiles.length === 0) {
                    return { content: [{ type: "text", text: `No profiles found for ${a?.browser || "brave"}.` }] };
                }
                const list = profiles
                    .map((p: any) => `${p.name}: ${p.browser}, directory=${p.directory}, userDataDir=${p.userDataDir}`)
                    .join("\n");
                return { content: [{ type: "text", text: `Available browser profiles:\n${list}` }] };
            }

            if (name === "sample_visual_frames") {
                const result = await bridge.sendCommand("sample_visual_frames", {
                    duration: a?.duration,
                    maxFrames: a?.maxFrames,
                    quality: a?.quality,
                    maxWidth: a?.maxWidth,
                    maxHeight: a?.maxHeight,
                    everyNthFrame: a?.everyNthFrame
                });
                const content: any[] = [{
                    type: "text",
                    text: JSON.stringify({
                        success: result.success,
                        frameCount: result.frameCount,
                        duration: result.duration,
                        timestamps: result.timestamps
                    })
                }];
                for (const frame of result.frames || []) {
                    content.push(imageContent(frame, "image/jpeg"));
                }
                return { content };
            }

            if (name === "get_state") {
                const result = await bridge.sendCommand("get_state", {
                    screenshot: a?.screenshot === true,
                    domSnapshot: a?.domSnapshot === true || a?.includeDOMSnapshot === true,
                    som: a?.som === true || a?.withOverlay === true,
                    tabs: a?.tabs === true,
                    elements: a?.elements !== false,
                });
                if (!result) throw new Error("Received empty state");

                taskMemory.recordSession({ title: result.title, url: result.url });

                const content: any[] = [
                    { type: "text", text: `Title: ${result.title}\nURL: ${result.url}` },
                ];
                if (result.screenshot) {
                    content.push(imageContent(result.screenshot, "image/jpeg"));
                }

                return { content };
            }

            if (name === "browser_status") {
                const result = await bridge.sendCommand("browser_status", { includeTargets: a?.includeTargets });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "snapshot_compact") {
                const result = await bridge.sendCommand("snapshot_compact", {
                    maxElements: a?.maxElements,
                    includeText: a?.includeText
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "list_interactive_elements") {
                const result = await bridge.sendCommand("list_interactive_elements", {
                    maxElements: a?.maxElements,
                    withOverlay: a?.withOverlay
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "click_by_ref") {
                const result = await bridge.sendCommand("click_by_ref", { ref: a.ref });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "click_by_selector") {
                const result = await bridge.sendCommand("click_by_selector", {
                    selector: a.selector,
                    timeout: a?.timeout
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "fill_by_selector") {
                const result = await bridge.sendCommand("fill_by_selector", {
                    selector: a.selector,
                    value: a.value,
                    timeout: a?.timeout
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "wait_for_selector") {
                const result = await bridge.sendCommand("wait_for_selector", {
                    selector: a.selector,
                    timeout: a?.timeout
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "wait_for_text") {
                const result = await bridge.sendCommand("wait_for_text", {
                    text: a.text,
                    timeout: a?.timeout
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "get_network_errors") {
                const result = await bridge.sendCommand("get_network_errors", { limit: a?.limit });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "browser_intent") {
                const result = await bridge.sendCommand("browser_intent", {
                    intent: a.intent,
                    target: a?.target,
                    value: a?.value,
                    role: a?.role,
                    timeout: a?.timeout,
                    verify: a?.verify,
                    includeCandidates: a?.includeCandidates
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "get_logs") {
                const result = await bridge.sendCommand("get_logs", { limit: a?.limit });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "detect_captcha") {
                const result = await bridge.sendCommand("detect_captcha", {});
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "solve_captcha") {
                const result = await bridge.sendCommand("solve_captcha", {
                    useService:     a?.useService,
                    service:        a?.service,
                    apiKey:         a?.apiKey,
                    pageUrl:        a?.pageUrl,
                    waitAfterClick: a?.waitAfterClick,
                    timeout:        a?.timeout,
                    pollInterval:   a?.pollInterval,
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "press_key") {
                const result = await bridge.sendCommand("press_key", { key: a.key, modifiers: a?.modifiers });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "click_text") {
                const result = await bridge.sendCommand("click_text", {
                    text: a.text,
                    role: a?.role,
                    timeout: a?.timeout
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "click_role") {
                const result = await bridge.sendCommand("click_role", {
                    role: a.role,
                    name: a?.name,
                    timeout: a?.timeout
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "fill_label") {
                const result = await bridge.sendCommand("fill_label", {
                    label: a.label,
                    value: a.value,
                    role: a?.role,
                    timeout: a?.timeout
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "element_at_point") {
                const result = await bridge.sendCommand("element_at_point", {
                    x: a?.x,
                    y: a?.y,
                    coordinate: a?.coordinate
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "execute_script") {
                const result = await bridge.sendCommand("evaluate", { script: String(a?.script) });
                // Scripts can return binary payloads (e.g. canvas.toDataURL()).
                return resultWithImages(result, false);
            }

            if (name === "cdp_command") {
                const result = await bridge.sendCommand("cdp_command", { command: a.command, args: a.args || {} });
                // e.g. Page.captureScreenshot returns { data: "<base64>" }.
                return jsonWithImages(result);
            }

            if (name === "act") {
                const action = a.action;
                let currentState = { url: "unknown" };
                try {
                    currentState = await bridge.sendCommand("get_state", {
                        screenshot: false,
                        domSnapshot: false,
                        elements: false,
                        som: false,
                        tabs: false,
                    });
                } catch {}

                const node = taskMemory.create(action, currentState.url, a.parentId);

                let resultMsg = "";
                const eid = a.elementId ? String(a.elementId).replace(/@/g, '') : undefined;
                
                try {
                    if (action === "click") {
                        try {
                            if (eid) resultMsg = await bridge.sendCommand("click_element", { id: eid, text: a.value });
                            else if (a.selector) resultMsg = await bridge.sendCommand("click_element_by_selector", { selector: a.selector });
                            else if (a.coordinate) {
                                const [x, y] = String(a.coordinate).split(',').map(Number);
                                resultMsg = await bridge.sendCommand("click", { x, y });
                            } else {
                                resultMsg = await bridge.sendCommand(action, a);
                            }
                        } catch (err) {
                            // SELF-HEALING: Try fuzzy match if exact failed
                            console.error(`[Aether] Action failed, attempting self-healing...`);
                            const resolved = await bridge.resolveSelector({ 
                                originalSelector: a.selector, 
                                text: a.value || a.text 
                            }).catch(() => null);
                            
                            if (resolved) {
                                console.error(`[Aether] Self-healing resolved to: ${resolved.selector} (${resolved.method})`);
                                resultMsg = await bridge.sendCommand("click_element_by_selector", { selector: resolved.selector });
                                if (aetherMemory.canWrite(a?.projectRoot)) {
                                    await aetherMemory.rememberLesson({
                                        projectRoot: a?.projectRoot,
                                        title: "Recover from brittle click selector",
                                        trigger: "When a click fails because the exact selector or text no longer matches, but a nearby semantic element can be resolved.",
                                        problemPattern: "A brittle click selector failed during browser automation.",
                                        symptoms: ["click_element_by_selector threw", "selector self-healing found a replacement"],
                                        failedApproach: a.selector || a.value || a.text || "original click target",
                                        betterApproach: `Use resolved selector "${resolved.selector}" from ${resolved.method} after checking visible interactive candidates.`,
                                        createdBecause: "errors_overcome",
                                        evidence: `Recovered ${action} on ${currentState.url}. Confidence: ${resolved.confidence}.`,
                                        tags: ["selector", "click", "self-healing"],
                                        confidence: resolved.confidence || 0.72,
                                    }).catch((memoryError) => console.error("[Aether] Failed to remember click recovery:", memoryError));
                                }
                            } else {
                                throw err;
                            }
                        }
                    } else if (action === "type") {
                        try {
                            if (eid || a.selector) await bridge.sendCommand(eid ? "click_element" : "click_element_by_selector", { id: eid, selector: a.selector });
                            resultMsg = await bridge.sendCommand("type", { text: a.value || a.text });
                        } catch (err) {
                            // SELF-HEALING
                            const resolved = await bridge.resolveSelector({ 
                                originalSelector: a.selector, 
                                text: a.value || a.text 
                            }).catch(() => null);
                            
                            if (resolved) {
                                await bridge.sendCommand("click_element_by_selector", { selector: resolved.selector });
                                resultMsg = await bridge.sendCommand("type", { text: a.value || a.text });
                                if (aetherMemory.canWrite(a?.projectRoot)) {
                                    await aetherMemory.rememberLesson({
                                        projectRoot: a?.projectRoot,
                                        title: "Recover from brittle typing target",
                                        trigger: "When typing fails because the original input selector no longer resolves, but a semantic replacement can be found.",
                                        problemPattern: "A brittle typing selector failed during browser automation.",
                                        symptoms: ["typing target could not be focused", "selector self-healing found a replacement"],
                                        failedApproach: a.selector || "original typing target",
                                        betterApproach: `Focus resolved selector "${resolved.selector}" from ${resolved.method}, then type with native input events.`,
                                        createdBecause: "errors_overcome",
                                        evidence: `Recovered ${action} on ${currentState.url}. Confidence: ${resolved.confidence}.`,
                                        tags: ["selector", "typing", "self-healing"],
                                        confidence: resolved.confidence || 0.72,
                                    }).catch((memoryError) => console.error("[Aether] Failed to remember typing recovery:", memoryError));
                                }
                            } else {
                                throw err;
                            }
                        }
                    } else if (action === "navigate") {
                        resultMsg = await bridge.sendCommand("navigate", { url: a.value });
                    } else {
                        resultMsg = await bridge.sendCommand(action, a);
                    }
                    node.status = 'success';
                } catch (err: any) {
                    node.status = 'failure';
                    node.error = err.message;
                    throw err;
                }

                // May be a bare base64 screenshot/PDF string or a structured
                // payload; resultWithImages lifts binary payloads out of text.
                return resultWithImages(resultMsg, false);
            }

            // ==================== AGENT-CENTRIC APIs ====================
            if (name === "agent_action") {
                const result = await bridge.sendCommand("agent_action", {
                    action: a.action,
                    target: a.target,
                    verify: a.verify,
                    waitFor: a.waitFor,
                    timeout: a.timeout,
                    screenshot: a.screenshot === true
                });
                return jsonWithImages(result);
            }

            if (name === "smart_navigate") {
                const result = await bridge.sendCommand("smart_navigate", {
                    url: a.url,
                    waitFor: a.waitFor,
                    dismissPopups: a.dismissPopups,
                    screenshot: a.screenshot,
                    timeout: a.timeout
                });
                return jsonWithImages(result);
            }

            if (name === "observe_and_act") {
                const result = await bridge.sendCommand("observe_and_act", {
                    action: a.action,
                    observe: a.observe,
                    returnScreenshot: a.returnScreenshot
                });
                return jsonWithImages(result);
            }

            if (name === "agent_form_fill") {
                const result = await bridge.sendCommand("agent_form_fill", {
                    fields: a.fields,
                    submitAfterFill: a.submitAfterFill,
                    submitSelector: a.submitSelector
                });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }

            if (name === "page_snapshot") {
                const result = await bridge.sendCommand("page_snapshot", {
                    fullPage: a.fullPage,
                    includeDOMSnapshot: a.includeDOMSnapshot,
                    screenshot: a.screenshot === true,
                    cookies: a.cookies === true,
                    accessibilityTree: a.accessibilityTree === true
                });
                
                const content: any[] = [
                    { type: "text", text: `Title: ${result.title}\nURL: ${result.url}` }
                ];
                if (result.screenshot) {
                    content.push(imageContent(result.screenshot, "image/jpeg"));
                }
                if (result.elements) {
                    content.push({ type: "text", text: `\nInteractive Elements: ${JSON.stringify(result.elements, null, 2)}` });
                }
                return { content };
            }

            if (name === "get_page_text") {
                const result = await bridge.sendCommand("get_page_text", {
                    format: a?.format,
                    selector: a?.selector,
                    includeLinks: a?.includeLinks,
                    maxLength: a?.maxLength,
                });
                const header = `Title: ${result.title}\nURL: ${result.url}\nFormat: ${result.format} | ${result.length} chars${result.truncated ? " (truncated)" : ""}`;
                return { content: [{ type: "text", text: `${header}\n\n${result.text}` }] };
            }

            if (name === "save_auth_state") {
                const result = await bridge.sendCommand("save_auth_state", {
                    path: a?.path,
                    origins: a?.origins,
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            if (name === "load_auth_state") {
                const result = await bridge.sendCommand("load_auth_state", {
                    path: a?.path,
                    reload: a?.reload,
                });
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }

            throw new Error(`Unknown tool: ${name}`);
        } catch (error: any) {
            if (error.captcha) {
                return toolError(error);
            }
            if (error.message?.includes("not connected") || error.message?.includes("No active extension")) {
                return toolError(error);
            }
            return toolError(error);
        }
    });
}

