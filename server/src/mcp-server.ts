import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as path from "path";
import { getDriver } from "./driver";
import type { ResolvedPage } from "./driver";
import {
    launchBrowserProcess,
    killLaunchedBrowser,
    listAvailableBrowsers,
    listBrowserProfiles,
} from "./browser-launch";
import { McpTaskMemory } from "./mcp-task-memory";
import { jsonContent, jsonToolResult, toolError, jsonWithImages } from "./mcp-responses";
import { AetherMemoryStore } from "./aether-memory-store";
import { PageHost, getOrCreatePageHost, setActivePageHost, getPageHost } from "./page";
import { runExecute, ExecuteLogEntry } from "./execute";
import { getHandoffRegistry, HandoffOutcome } from "./handoff";
import { getSessionManager, SessionRecord } from "./sessions";
import { OUTPUT_SCHEMAS, TOOL_ANNOTATIONS } from "./tool-schemas";
import { MERGED_TOOL_DEFINITIONS } from "./tool-definitions";
import { getExtensionRelay } from "./extension-relay";
import { assertCdpAllowed } from "./relay/guardrails";
import { detectAndSolve } from "./captcha-solver";
import { getSecretStore } from "./secrets";

const taskMemory = new McpTaskMemory();
const aetherMemory = new AetherMemoryStore();

/** The agent calling this tool, from MCP request metadata. */
function callerKey(request: any): string {
    const meta = request?.params?._meta;
    const id = meta?.["ai.opencode/sessionID"] ?? meta?.sessionId ?? meta?.session_id;
    return typeof id === "string" && id ? `mcp-${id}` : "shared";
}

/** Relay state, from this process or the one that owns the port. */
async function relayStatusSafe(): Promise<any> {
    const local = getExtensionRelay().status();
    if (local.browsers.length > 0 || local.extensionConnected) return local;
    try {
        const response = await fetch(`http://127.0.0.1:${local.port}/health`);
        if (response.ok) return await response.json();
    } catch {
        // No relay is listening: report local (empty) state.
    }
    return local;
}

function summarizeSession(record: SessionRecord): Record<string, unknown> {
    return {
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        ...(record.target ? { target: record.target } : {}),
    };
}

function formatLogs(logs: ExecuteLogEntry[], limit: number = 30): string {
    if (!logs.length) return "";
    const lines = logs
        .slice(-limit)
        .map((entry) => `[${entry.level}] ${entry.text.replace(/\s*\n\s*/g, " ")}`);
    return `\n\nLogs (${logs.length}):\n${lines.join("\n")}`;
}

function describeHandoff(outcome: HandoffOutcome): string {
    const seconds = Math.round(outcome.waitedMs / 100) / 10;
    if (outcome.status === "completed") {
        return (
            `The user clicked Continue after ${seconds}s.\n\n` +
            `That is not verification: assert the expected URL or element before treating the step as done.`
        );
    }
    if (outcome.status === "timeout") {
        return `Timed out after ${seconds}s waiting for the user to click Continue. Ask them whether they still want to proceed.`;
    }
    return `The handoff was cancelled after ${seconds}s (${outcome.message}).`;
}

/**
 * Resolve the caller's current session to a live Playwright page.
 *
 * Never navigates: a pin either resolves to an open tab or reports that it is
 * gone. If the session has no pin yet, it adopts the browser's first page or
 * asks the extension for an agent tab.
 */
async function resolveHost(
    caller: string,
    requestedSession?: string
): Promise<{ sessions: ReturnType<typeof getSessionManager>; sessionId: string; record: SessionRecord | null; resolved: ResolvedPage; host: PageHost }> {
    const sessions = getSessionManager();
    await sessions.load();
    const driver = getDriver();
    const sessionId = requestedSession || sessions.currentId(caller);
    const record = sessions.get(sessionId);
    const pin = record?.target ?? {};

    let resolved = await driver.getPage({ id: sessionId, ...pin });
    if (!resolved) {
        const browserId = pin.browserId ?? (await driver.defaultBrowserId()) ?? undefined;
        if (browserId) {
            const relayTab = await getExtensionRelay().ensureAgentTabFor(browserId, sessionId).catch(() => null);
            if (relayTab) {
                await sessions.bind(
                    sessionId,
                    { browserId: relayTab.browserId, targetId: `${relayTab.browserId}:${relayTab.tabId}` },
                    caller
                );
            } else {
                await driver.ensurePage(browserId).catch(() => null);
            }
            resolved = await driver.getPage({ id: sessionId, ...(sessions.get(sessionId)?.target ?? {}) });
        }
    }

    if (!resolved) {
        throw new Error(
            'No page is available. Call browser {action:"extension"} to use your own browser, or browser {action:"launch"} to start one.'
        );
    }

    const key = `${resolved.browserId}:${resolved.targetId ?? resolved.page.url()}`;
    const host = getOrCreatePageHost(
        key,
        () =>
            new PageHost(resolved!.page, resolved!.context, resolved!.browser, {
                browserId: resolved!.browserId,
                targetId: resolved!.targetId,
                targetIdOf: (page) => getDriver().targetIdOf(page),
            })
    );
    setActivePageHost(host);
    return { sessions, sessionId, record: sessions.get(sessionId), resolved, host };
}

function routeTool(name: string, args: any): { name: string; args: any } {
    const a = args ?? {};

    if (name === "sessions") {
        switch (String(a.action ?? "list")) {
            case "new":
                return { name: "session_new", args: { name: a.name, browser: a.browser, adoptCurrent: a.adoptCurrent } };
            case "use":
                return { name: "session_use", args: { id: a.id } };
            case "reset":
                return { name: "session_reset", args: { id: a.id } };
            case "delete":
                return { name: "session_delete", args: { id: a.id } };
            case "adopt":
                return { name: "session_adopt", args: { session: a.session, tabId: a.tabId, targetUrl: a.targetUrl, targetIndex: a.targetIndex } };
            case "save_auth":
                return { name: "save_auth_state", args: { path: a.path } };
            case "load_auth":
                return { name: "load_auth_state", args: { path: a.path, reload: a.reload } };
            default:
                return { name: "session_list", args: {} };
        }
    }

    if (name === "browser") {
        switch (String(a.action ?? "status")) {
            case "launch":
                return { name: "launch_browser", args: a };
            case "connect":
                return { name: "connect_browser", args: a };
            case "kill":
                return { name: "kill_browser", args: a };
            case "list":
                return { name: "list_browsers", args: {} };
            case "profiles":
                return { name: "list_browser_profiles", args: { browser: a.browser } };
            case "extension":
                return { name: "extension_connect", args: a };
            default:
                return { name: "browser_status", args: { includeTargets: a.includeTargets } };
        }
    }

    if (name === "diagnostics") {
        switch (String(a.action ?? "logs")) {
            case "network":
                return { name: "get_network_errors", args: { limit: a.limit } };
            case "performance":
                return { name: "get_performance_metrics", args: {} };
            case "har_start":
                return { name: "har_start", args: a };
            case "har_stop":
                return { name: "har_stop", args: a };
            case "har_status":
                return { name: "har_status", args: a };
            default:
                return { name: "get_logs", args: { limit: a.limit } };
        }
    }

    if (name === "secrets") {
        return { name: "secrets", args: a };
    }

    if (name === "captcha") {
        return a.action === "solve"
            ? { name: "solve_captcha", args: a }
            : { name: "detect_captcha", args: {} };
    }

    if (name === "memory") {
        switch (String(a.action ?? "recall")) {
            case "configure":
                return { name: "configure_aether_memory", args: { projectRoot: a.projectRoot } };
            case "remember":
                return { name: "remember_aether_lesson", args: a };
            case "outcome":
                return { name: "record_aether_lesson_outcome", args: { projectRoot: a.projectRoot, id: a.id, success: a.success, evidence: a.evidence } };
            case "compact":
                return { name: "compact_aether_memory", args: { projectRoot: a.projectRoot } };
            case "graph":
                return { name: "get_task_graph", args: {} };
            default:
                return { name: "recall_aether_memory", args: { projectRoot: a.projectRoot, intent: a.intent, problem: a.problem, tags: a.tags, limit: a.limit } };
        }
    }

    if (name === "skill") {
        switch (String(a.action ?? "list")) {
            case "create":
                return { name: "create_aether_skill", args: a };
            case "maintain":
                return { name: "maintain_aether_skill", args: a };
            default:
                return { name: "list_aether_skills", args: { projectRoot: a.projectRoot } };
        }
    }

    if (name === "act") {
        switch (String(a.action ?? "")) {
            case "click_by_ref":
                return { name: "click_by_ref", args: a };
            case "click_by_selector":
                return { name: "click_by_selector", args: a };
            case "fill_by_selector":
                return { name: "fill_by_selector", args: a };
            case "wait_for_selector":
                return { name: "wait_for_selector", args: a };
            case "wait_for_text":
                return { name: "wait_for_text", args: a };
            case "smart_navigate":
                return { name: "smart_navigate", args: a };
            case "intent":
                return { name: "browser_intent", args: a };
            case "agent_action":
                return { name: "agent_action", args: { ...a, action: a.agentAction } };
            case "observe_and_act":
                return { name: "observe_and_act", args: { ...a, action: a.agentAction } };
            case "form_fill":
                return { name: "agent_form_fill", args: { fields: a.fields, submitAfterFill: a.submitAfterFill, submitSelector: a.submitSelector } };
            case "sample_visual_frames":
                return { name: "sample_visual_frames", args: a };
            default:
                return { name: "act", args: a };
        }
    }

    return { name, args: a };
}

const Tools = MERGED_TOOL_DEFINITIONS.map((tool: any) => ({
    ...tool,
    annotations: TOOL_ANNOTATIONS[tool.name] ?? {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    ...(OUTPUT_SCHEMAS[tool.name] ? { outputSchema: OUTPUT_SCHEMAS[tool.name] } : {}),
}));

// ─── action implementations ─────────────────────────────────────────────

async function withCdp(host: PageHost) {
    const session = await host.rawCdp();
    return async (method: string, params: Record<string, unknown> = {}) => {
        assertCdpAllowed(method);
        return await session.send(method as any, params as any);
    };
}

async function runAct(host: PageHost, a: any, sessionId: string): Promise<any> {
    const cdp = await withCdp(host);
    const action = String(a.action ?? "");

    switch (action) {
        case "navigate":
        case "smart_navigate": {
            const url = a.url ?? a.value;
            await host.navigate(String(url));
            if (a.waitFor?.type === "selector") await host.waitForSelector(String(a.waitFor.selector));
            if (a.waitFor?.type === "text") await host.waitForText(String(a.waitFor.text));
            const result: any = { success: true, url: await host.url(), title: await host.title() };
            if (a.screenshot) result.screenshot = (await host.screenshot({ fullPage: false })).base64 ?? null;
            return result;
        }
        case "new_tab":
            return { targetId: await host.newTab(a.url ?? a.value) };
        case "switch_tab": {
            const tabs = await host.tabs();
            const tab = tabs.find((candidate) => candidate.id === String(a.tabId));
            if (!tab) throw new Error(`No tab ${a.tabId}. snapshot {tabs:true} lists them.`);
            await getSessionManager().bind(sessionId, {
                browserId: host.browserId,
                targetId: tab.id,
                urlIncludes: tab.url,
                title: tab.title,
            });
            return { success: true, switchedTo: tab };
        }
        case "close_tab":
            return { closed: await host.closeTab(a.tabId === undefined ? undefined : String(a.tabId)) };

        case "click":
        case "click_by_selector":
            return { success: true, result: await host.click(a.ref ?? a.selector ?? a.text ?? "") };
        case "click_by_ref":
            return { success: true, ref: a.ref, result: await host.click(String(a.ref)) };
        case "click_text":
            return { success: true, result: await host.getByText(String(a.text)).click() };
        case "click_role":
            return { success: true, result: await host.getByRole(String(a.role), { name: a.name }).click() };

        case "fill":
        case "fill_by_selector":
            return { success: true, result: await host.fill(a.selector ?? a.ref ?? "", a.value ?? a.text ?? "") };
        case "fill_label":
            return { success: true, result: await host.getByLabel(String(a.label)).fill(String(a.value ?? "")) };
        case "type":
            return { success: true, result: await host.type(a.selector ?? a.ref ?? a.text ?? "", a.value ?? a.text ?? "") };
        case "press_key":
        case "key_combo":
            return { success: true, result: await host.press(String(a.key), a.modifiers ?? []) };
        case "hover":
            return { success: true, result: await host.hover(a.selector ?? a.ref ?? String(a.text ?? "")) };
        case "scroll":
            return { success: true, result: await host.scroll(Number(a.deltaY ?? a.y ?? 500)) };
        case "select":
        case "select_option":
            return { success: true, result: await host.selectOption(a.selector ?? a.ref ?? "", String(a.value ?? "")) };
        case "check": {
            const { locator } = await host.resolveTarget(a.selector ?? a.ref ?? "");
            const tag = await locator.evaluate((element) => (element as HTMLInputElement).type);
            if (tag === "checkbox" || tag === "radio") await locator.check({ timeout: 15_000 });
            else await locator.click({ timeout: 15_000 });
            return { success: true };
        }
        case "drag_and_drop": {
            const source = await host.resolveTarget(a.selector ?? a.ref ?? "");
            const target = await host.resolveTarget(a.target ?? a.value ?? "");
            await source.locator.dragTo(target.locator, { timeout: 15_000 });
            return { success: true };
        }
        case "upload_file": {
            const { locator } = await host.resolveTarget(a.selector ?? a.ref ?? "");
            await locator.setInputFiles(a.files ?? [], { timeout: 15_000 });
            return { success: true };
        }

        case "wait":
            await host.waitForTimeout(Number(a.timeout ?? a.duration ?? 1000));
            return { success: true };
        case "wait_for_selector":
            return { success: await host.waitForSelector(String(a.selector), Number(a.timeout ?? 15_000)) };
        case "wait_for_text":
            return { success: await host.waitForText(String(a.text), Number(a.timeout ?? 15_000)) };
        case "assert":
        case "verify_ui_state": {
            const snapshot = await host.snapshot({ maxElements: 40 });
            return { success: true, url: snapshot.url, title: snapshot.title, elementCount: snapshot.elementCount, outline: snapshot.outline };
        }

        case "screenshot": {
            const shot = await host.screenshot({ fullPage: a.fullPage === true, format: a.format === "png" ? "png" : "jpeg", quality: a.quality });
            return shot.base64 ? { screenshot: shot.base64, mimeType: shot.mimeType } : shot;
        }
        case "screenshot_region": {
            const options = a.options ?? {};
            const buffer = await host.page.screenshot({
                clip: {
                    x: Number(options.x ?? a.x ?? 0),
                    y: Number(options.y ?? a.y ?? 0),
                    width: Number(options.width ?? 300),
                    height: Number(options.height ?? 200),
                },
                type: "jpeg",
                quality: Number(a.quality ?? 70),
            });
            return { screenshot: buffer.toString("base64"), mimeType: "image/jpeg" };
        }
        case "get_tree":
            return await cdp("Accessibility.getFullAXTree");
        case "get_dom_tree":
        case "get_dom_snapshot":
            return action === "get_dom_tree"
                ? { html: await host.content() }
                : await cdp("DOMSnapshot.captureSnapshot", { computedStyles: [] });
        case "get_logs":
            return { logs: host.consoleLogs(Number(a.limit ?? 50)) };
        case "get_network_errors":
            return { requests: host.networkErrors(Number(a.limit ?? 20)) };
        case "get_network_traffic": {
            const entries = host.networkTraffic(Number(a.limit ?? 50));
            if (entries.length) return { captured: entries.length, entries, status: host.networkCaptureStatus() };
            return {
                note: 'No HAR capture is running. Start one with diagnostics {action:"har_start"}, or read failed requests below.',
                requests: host.networkErrors(Number(a.limit ?? 50)),
            };
        }
        case "get_network_response": {
            const entries = host.networkTraffic(500);
            const needle = String(a.requestId ?? a.urlPattern ?? a.url ?? "").toLowerCase();
            const match = entries.find(
                (entry: any) =>
                    (a.requestId && entry.request?.url?.includes(String(a.requestId))) ||
                    (needle && entry.request?.url?.toLowerCase().includes(needle))
            );
            return match ? { entry: match } : { note: "No captured response matched. Start a capture with diagnostics {action:\"har_start\"} first." };
        }
        case "get_performance_metrics": {
            await cdp("Performance.enable");
            return await cdp("Performance.getMetrics");
        }
        case "get_computed_style": {
            const value = await host.evaluate((arg: any) => {
                const element = arg.selector ? document.querySelector(arg.selector) : document.body;
                if (!element) return null;
                return Object.fromEntries(Array.from(window.getComputedStyle(element)).map((key) => [key, window.getComputedStyle(element).getPropertyValue(key)]));
            }, { selector: a.selector });
            return { style: value };
        }
        case "get_event_listeners": {
            const doc = await cdp("DOM.getDocument");
            const node = await cdp("DOM.querySelector", { nodeId: (doc as any).root.nodeId, selector: String(a.selector) });
            if (!(node as any).nodeId) return { listeners: [] };
            return await cdp("DOMDebugger.getEventListeners", { objectId: (node as any).nodeId });
        }
        case "get_dom_storage": {
            const storage = await host.evaluate(() => ({
                localStorage: Object.fromEntries(Object.entries(localStorage)),
                sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
            }));
            return storage;
        }
        case "element_at_point":
            return await cdp("DOM.getNodeForLocation", { x: Number(a.x ?? 0), y: Number(a.y ?? 0) });
        case "highlight_elements": {
            await host.evaluate(() => {
                document.querySelectorAll("[data-aether-highlight]").forEach((element) => element.remove());
                const nodes = Array.from(document.querySelectorAll("a,button,input,select,textarea,[role]"));
                for (const node of nodes) {
                    const rect = node.getBoundingClientRect();
                    if (!rect.width || !rect.height) continue;
                    const marker = document.createElement("div");
                    marker.setAttribute("data-aether-highlight", "1");
                    marker.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;border:2px solid #22c55e;z-index:2147483647;pointer-events:none`;
                    document.documentElement.appendChild(marker);
                }
                return true;
            });
            return { success: true };
        }
        case "print_pdf": {
            const buffer = await host.page.pdf({ printBackground: a.printBackground === true });
            return { pdf: buffer.toString("base64"), mimeType: "application/pdf" };
        }

        case "intent": {
            const target = String(a.target ?? "");
            const intent = String(a.intent ?? "click");
            if (intent === "navigate") {
                await host.navigate(String(a.value ?? target));
                return { success: true, url: await host.url() };
            }
            const handle = a.role ? host.getByRole(String(a.role), { name: target }) : host.getByText(target);
            if (intent === "click") return { success: true, result: await handle.click() };
            if (intent === "fill") return { success: true, result: await handle.fill(String(a.value ?? "")) };
            if (intent === "select") return { success: true, result: await handle.selectOption(String(a.value ?? "")) };
            if (intent === "check") return { success: true, result: await handle.click() };
            if (intent === "wait_for") return { success: await host.waitForText(target) };
            return { success: true, snapshot: await host.snapshot({ maxElements: 40 }) };
        }
        case "agent_action":
        case "observe_and_act": {
            const inner = String(a.agentAction ?? a.action ?? "click");
            const target = String(a.target ?? "");
            if (inner === "click" || inner === "click_text") await host.click(target);
            else if (inner === "fill") await host.fill(target, a.value ?? "");
            else if (inner === "hover") await host.hover(target);
            else if (inner === "navigate") await host.navigate(target);
            const result: any = { success: true, url: await host.url() };
            if (a.returnScreenshot || a.screenshot) {
                result.screenshot = (await host.screenshot({})).base64 ?? null;
            }
            return result;
        }
        case "form_fill": {
            for (const field of a.fields ?? []) {
                const target = field.selector ?? field.label ?? field.id;
                if (!target) continue;
                if (field.type === "checkbox" || field.type === "radio") {
                    if (field.checked !== false) await host.click(target);
                } else {
                    await host.fill(target, field.value ?? "");
                }
            }
            if (a.submitAfterFill) {
                await host.click(a.submitSelector ?? 'button[type="submit"], input[type="submit"]');
            }
            return { success: true };
        }

        case "configure":
            return { note: "configure is not supported by the Playwright driver." };
        case "emulate_network":
            await cdp("Network.enable");
            return await cdp("Network.emulateNetworkConditions", {
                offline: a.offline === true,
                latency: Number(a.latency ?? 0),
                downloadThroughput: Number(a.downloadThroughput ?? -1),
                uploadThroughput: Number(a.uploadThroughput ?? -1),
            });
        case "mock_network_request": {
            const pattern = String(a.urlPattern ?? "**/*");
            const body = String(a.mockResponse ?? "{}");
            await host.context.route(pattern, (route) => route.fulfill({ status: 200, body, contentType: "application/json" }));
            return { success: true, pattern };
        }
        case "set_geolocation":
            await host.context.setGeolocation({ latitude: Number(a.latitude ?? 0), longitude: Number(a.longitude ?? 0) });
            return { success: true };
        case "set_timezone":
            return await cdp("Emulation.setTimezoneOverride", { timezoneId: String(a.timezoneId ?? "UTC") });
        case "get_cookies":
            return await cdp("Network.getCookies");
        case "set_cookie":
            await cdp("Network.enable");
            return await cdp("Network.setCookie", {
                name: String(a.cookieName ?? ""),
                value: String(a.cookieValue ?? ""),
                url: await host.url(),
            });
        case "clear_cache":
            return { success: false, error: "Refused: clearing the shared browser cache is not allowed." };

        case "start_screencast":
            return await host.startScreencast(a);
        case "stop_screencast":
            return await host.stopScreencast();
        case "get_screencast_frames":
            return { frames: host.getScreencastFrames(Number(a.maxFrames ?? 10)) };
        case "record_session":
            return await host.recordSession({ ...a, path: a.path ?? a.output });
        case "sample_visual_frames":
            return await host.sampleFrames(a);
        case "start_tracing":
            return await host.startTracing(a);
        case "stop_tracing":
            return await host.stopTracing({ path: a.path ?? a.output });

        case "detect_captcha": {
            const detected = await host.evaluate(() => {
                const selectors = [
                    'iframe[src*="challenges.cloudflare.com"]',
                    'iframe[src*="hcaptcha"]',
                    'iframe[title="reCAPTCHA"]',
                    ".cf-turnstile,.h-captcha,.g-recaptcha",
                ];
                return selectors.some((selector) => {
                    const element = document.querySelector(selector);
                    if (!element) return false;
                    const rect = element.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                });
            });
            return { detected: detected === true };
        }

        default:
            throw new Error(`Action '${action}' is not implemented by the Playwright driver yet.`);
    }
}

// ─── registration ───────────────────────────────────────────────────────

export function RegisterMcpTools(server: Server) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const requestedName = request.params.name;
        const routed = routeTool(requestedName, request.params.arguments);
        const name = routed.name;
        const a = routed.args as any;
        const caller = callerKey(request);
        const sessionArg = typeof a?.session === "string" && a.session ? a.session : undefined;

        try {
            const sessions = getSessionManager();
            const driver = getDriver();
            const secretStore = getSecretStore();
            await secretStore.load();

            // ==================== SCRIPTING ====================
            if (name === "execute") {
                const { host, sessionId, sessions: store } = await resolveHost(caller, sessionArg);
                const result = await runExecute(host, {
                    code: String(a?.code ?? ""),
                    ...(a?.timeoutMs === undefined ? {} : { timeoutMs: Number(a.timeoutMs) }),
                    sessionId,
                });
                const redacted = {
                    ...result,
                    value: secretStore.redactDeep(result.value),
                    text: secretStore.redact(result.text),
                    logs: result.logs.map((entry) => ({ ...entry, text: secretStore.redact(entry.text) })),
                };
                await store.bind(sessionId, { browserId: host.browserId, targetId: host.targetId ?? undefined }, caller);
                await store.record(
                    sessionId,
                    redacted.isError ? "execute.failed" : "execute",
                    `${redacted.durationMs}ms${redacted.timedOut ? " (timed out)" : ""}`,
                    caller
                );

                const header = redacted.isError
                    ? `execute failed after ${redacted.durationMs}ms\n\n${redacted.text}`
                    : redacted.value === undefined
                      ? `(the script returned no value after ${redacted.durationMs}ms)`
                      : redacted.text;
                return jsonToolResult(redacted, { text: `${header}${formatLogs(redacted.logs)}`, isError: redacted.isError });
            }

            if (name === "handoff") {
                const { host } = await resolveHost(caller, sessionArg);
                const outcome = await host.handoff(String(a?.message ?? ""), {
                    ...(a?.timeoutMs === undefined ? {} : { timeoutMs: Number(a.timeoutMs) }),
                    sessionId: sessionArg,
                });
                await sessions.record(sessionArg, "handoff", `${outcome.status} after ${outcome.waitedMs}ms`, caller);
                return jsonToolResult(outcome, { text: describeHandoff(outcome) });
            }

            if (name === "snapshot") {
                const { host } = await resolveHost(caller, sessionArg);
                const result = await host.snapshot({
                    maxElements: a?.elements === false ? 0 : (a?.maxElements ?? 40),
                    includeText: a?.includeText !== false,
                    frames: a?.frames !== false,
                });

                const extras: Record<string, unknown> = {};
                if (a?.screenshot) {
                    extras.screenshot = (await host.screenshot({ fullPage: a?.fullPage === true })).base64 ?? null;
                }
                if (a?.tabs) extras.tabs = await host.tabs().catch(() => []);
                if (a?.cookies) extras.cookies = await withCdp(host).then((cdp) => cdp("Network.getCookies")).catch(() => []);
                if (a?.domSnapshot) extras.domSnapshot = await withCdp(host).then((cdp) => cdp("DOMSnapshot.captureSnapshot", { computedStyles: [] })).catch(() => null);
                if (a?.accessibilityTree) extras.accessibilityTree = await withCdp(host).then((cdp) => cdp("Accessibility.getFullAXTree")).catch(() => null);

                const redactedResult = secretStore.redactDeep(result);
                if (Object.keys(extras).length > 0) {
                    return jsonWithImages({ ...redactedResult, ...secretStore.redactDeep(extras) }, true);
                }
                return jsonToolResult(redactedResult, { text: redactedResult.outline });
            }

            // ==================== SESSIONS ====================
            if (name === "session_new") {
                const record = await sessions.create(String(a?.name ?? "session"), caller);
                const browserId = (a?.browser as string | undefined) ?? (await driver.defaultBrowserId()) ?? undefined;
                if (browserId) {
                    const relayTab = await getExtensionRelay().ensureAgentTabFor(browserId, record.id).catch(() => null);
                    if (relayTab) {
                        await sessions.bind(record.id, { browserId: relayTab.browserId, targetId: `${relayTab.browserId}:${relayTab.tabId}` }, caller);
                    } else {
                        const resolved = await driver.ensurePage(browserId).catch(() => null);
                        if (resolved) {
                            await sessions.bind(record.id, { browserId, targetId: resolved.targetId ?? undefined, urlIncludes: resolved.page.url() }, caller);
                        }
                    }
                }
                const stored = sessions.get(record.id) ?? record;
                return jsonToolResult(
                    { current: sessions.currentId(caller), session: summarizeSession(stored) },
                    {
                        text: stored.target
                            ? `Session '${stored.id}' is current in ${stored.target.browserId ?? "a browser"}, pinned to ${stored.target.title || stored.target.urlIncludes || stored.target.targetId}.`
                            : `Session '${stored.id}' is current with no tab pinned; it pins the tab it first works in.`,
                    }
                );
            }

            if (name === "session_list") {
                await sessions.load();
                const records = sessions.list();
                const lines = records.map((record) => {
                    const marker = record.id === sessions.currentId(caller) ? "*" : " ";
                    const where = record.target
                        ? ` → ${record.target.browserId ?? "browser"}:${record.target.title || record.target.urlIncludes || record.target.targetId}`
                        : " (unpinned)";
                    return `${marker} ${record.id}${where} — last used ${record.lastUsedAt}`;
                });
                return jsonToolResult(
                    { current: sessions.currentId(caller), sharedSession: caller === "shared", sessions: records.map(summarizeSession) },
                    { text: lines.length ? lines.join("\n") : 'No sessions yet. Create one with sessions {action:"new"}.' }
                );
            }

            if (name === "session_use") {
                const record = await sessions.use(String(a?.id ?? ""), caller);
                const resolved = await driver.getPage({ id: record.id, ...(record.target ?? {}) }).catch(() => null);
                return jsonToolResult(
                    { current: sessions.currentId(caller), session: summarizeSession(record) },
                    {
                        text: resolved
                            ? `Session '${record.id}' is current in ${resolved.browserId}.`
                            : `Session '${record.id}' is current, but its pinned tab is not open; it will pin the tab it next works in.`,
                    }
                );
            }

            if (name === "session_reset") {
                const record = await sessions.reset(a?.id, caller);
                return jsonToolResult(
                    { current: sessions.currentId(caller), session: summarizeSession(record) },
                    { text: `Cleared the pinned tab and journal for '${record.id}'.` }
                );
            }

            if (name === "session_delete") {
                const result = await sessions.delete(a?.id, caller);
                return jsonToolResult(result, { text: `Deleted session '${result.deleted}'. Current session is '${result.current}'.` });
            }

            if (name === "session_adopt") {
                await sessions.load();
                const sessionId = sessionArg ?? sessions.currentId(caller);
                if (!sessions.get(sessionId)) {
                    throw new Error(`Session not found: ${sessionId}. Create it with sessions {action:"new"} first.`);
                }

                const browsers = await driver.listBrowsers();
                const all: Array<{ browserId: string; targetId: string; url: string; title: string }> = [];
                for (const browser of browsers) {
                    const targets = await driver.listTargets(browser.id).catch(() => []);
                    for (const target of targets) all.push(target);
                }

                let match: (typeof all)[number] | undefined;
                if (typeof a?.targetIndex === "number") match = all[Number(a.targetIndex)];
                else if (typeof a?.tabId === "string") match = all.find((candidate) => candidate.targetId === a.tabId || candidate.targetId.endsWith(`:${a.tabId}`));
                else if (typeof a?.targetUrl === "string") {
                    const needle = String(a.targetUrl).toLowerCase();
                    match = all.find((candidate) => candidate.url.toLowerCase().includes(needle) || candidate.title.toLowerCase().includes(needle));
                }

                if (!match) {
                    throw new Error('No matching open tab to adopt. Pass tabId (from snapshot {tabs:true}), targetUrl, or targetIndex.');
                }

                const record = await sessions.bind(
                    sessionId,
                    { browserId: match.browserId, targetId: match.targetId, urlIncludes: match.url, title: match.title },
                    caller
                );
                return jsonToolResult(
                    { current: sessions.currentId(caller), session: summarizeSession(record) },
                    { text: `Session '${record.id}' now works in ${match.title || match.url}.` }
                );
            }

            // ==================== MEMORY / SKILL ====================
            if (name === "get_task_graph") return jsonContent(taskMemory.graph(), true);
            if (name === "configure_aether_memory") return jsonContent(await aetherMemory.configure(a?.projectRoot), true);
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
                return jsonContent(await aetherMemory.recordLessonOutcome({ projectRoot: a?.projectRoot, id: a.id, success: a.success, evidence: a?.evidence }), true);
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
            if (name === "list_aether_skills") return jsonContent(await aetherMemory.listSkills(a?.projectRoot), true);
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
            if (name === "compact_aether_memory") return jsonContent(await aetherMemory.compact(a?.projectRoot), true);

            // ==================== BROWSER LIFECYCLE ====================
            if (name === "extension_connect") {
                const relay = getExtensionRelay();
                const { port } = await relay.start();
                const waitMs = Math.max(0, Math.min(Number(a?.waitMs ?? 3000), 30_000));
                const deadline = Date.now() + waitMs;
                while (!(await relayStatusSafe()).extensionConnected && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 150));
                }

                const status = await relayStatusSafe();
                const extensionPath = path.resolve(__dirname, "..", "extension");

                if (!status.extensionConnected) {
                    return jsonToolResult(
                        { ...status, extensionPath },
                        {
                            text:
                                `Relay is listening on 127.0.0.1:${port}. No browser is paired yet.\n\n` +
                                `1. Install once: chrome://extensions → Developer mode → Load unpacked → ${extensionPath}\n` +
                                `2. Open the Aether toolbar button. Relay: ws://127.0.0.1:${port} · Pairing code: ${status.pairingCode ?? "run this again"}\n` +
                                `3. Press Connect, then run browser {action:"extension"} again.\n\n` +
                                `The code works once and expires in 10 minutes. The browser keeps its token after that.`,
                        }
                    );
                }

                const browserId = (a?.browser as string | undefined) || status.browsers.find((browser: any) => browser.connected)?.id || status.browsers[0]?.id;
                if (!browserId) throw new Error("The extension is connected but reported no browser id.");

                let relayTab = await relay.ensureAgentTabFor(browserId, sessionArg ?? "agent").catch(() => null);
                await driver.connectBrowser(browserId);
                // A second MCP process does not own the extension link; it asks
                // the relay's browser endpoint to create a page instead.
                if (!relayTab) {
                    const ensured = await driver.ensurePage(browserId).catch(() => null);
                    if (ensured) relayTab = { browserId, tabId: Number(ensured.targetId?.split(":").pop() ?? 0) };
                }
                const tabs = await driver.listTargets(browserId).catch(() => []);

                return jsonToolResult(
                    { ...status, extensionPath, activeBrowser: browserId, agentTab: relayTab, tabs },
                    {
                        text:
                            `Connected to ${browserId} through the Aether extension on port ${port}.\n` +
                            `${tabs.length} agent tab(s) available. Agent tabs stay in a collapsed group; Aether only sees tabs it opened or you lent it.`,
                    }
                );
            }

            if (name === "launch_browser" || name === "connect_browser") {
                const port = Number(a?.port ?? 9222);
                if (name === "launch_browser") {
                    await launchBrowserProcess({
                        browser: a?.browser,
                        headless: a?.headless === true,
                        port,
                        profile: a?.profile,
                        profileDirectory: a?.profileDirectory,
                        userDataDir: a?.userDataDir,
                    });
                }
                const browserId = `launched:${port}`;
                await driver.connectBrowser(browserId);
                const resolved = await driver.ensurePage(browserId, a?.url).catch(() => null);
                return jsonToolResult(
                    { browserId, port, url: resolved?.page.url() ?? null },
                    { text: `Connected to ${browserId} over CDP on port ${port}.` }
                );
            }

            if (name === "kill_browser") {
                const port = Number(a?.port ?? 9222);
                const killed = killLaunchedBrowser(port);
                return jsonToolResult({ killed, port }, {
                    text: killed ? `Killed the launched browser on port ${port}.` : `No launched browser is tracked on port ${port}. Your extension browser is never closed by Aether.`,
                });
            }

            if (name === "list_browsers") {
                const browsers = await listAvailableBrowsers();
                return jsonToolResult({ browsers }, {
                    text: browsers.length ? browsers.map((browser) => `${browser.name}: ${browser.path}`).join("\n") : "No supported browser found. Install Chrome, Edge, Brave, or Firefox.",
                });
            }

            if (name === "list_browser_profiles") {
                const profiles = await listBrowserProfiles(a?.browser || "brave");
                return jsonToolResult({ profiles }, {
                    text: profiles.length
                        ? profiles.map((profile) => `${profile.name}: ${profile.browser}, directory=${profile.directory}`).join("\n")
                        : `No profiles found for ${a?.browser || "brave"}.`,
                });
            }

            if (name === "browser_status") {
                const status = await relayStatusSafe();
                const browsers = await driver.listBrowsers().catch(() => []);
                let activeTarget: unknown = null;
                try {
                    await sessions.load();
                    const sessionId = sessionArg || sessions.currentId(caller);
                    const record = sessions.get(sessionId);
                    if (record?.target) {
                        const targets = record.target.browserId
                            ? await driver.listTargets(record.target.browserId).catch(() => [])
                            : [];
                        const match = targets.find((target) => target.targetId === record.target?.targetId);
                        activeTarget = match
                            ? { browserId: match.browserId, targetId: match.targetId, url: match.url, title: match.title }
                            : { browserId: record.target.browserId, targetId: record.target.targetId, url: record.target.urlIncludes, stale: true };
                    }
                } catch {
                    activeTarget = null;
                }
                return jsonToolResult({ ...status, browsers: browsers.length ? browsers : status.browsers, activeTarget }, {
                    text: JSON.stringify({
                        extensionConnected: status.extensionConnected,
                        browsers: browsers.length ? browsers : status.browsers,
                        agentTabs: status.agentTabs,
                        activeTarget,
                    }, null, 2),
                });
            }

            // ==================== ACTION ====================
            if (name === "act") {
                const { host, sessionId } = await resolveHost(caller, sessionArg);
                const node = taskMemory.create(String(a.action ?? "act"), await host.url().catch(() => "unknown"), a.parentId);
                try {
                    const result = await runAct(host, a, sessionId);
                    node.status = "success";
                    return jsonWithImages(secretStore.redactDeep(result), true);
                } catch (error: any) {
                    node.status = "failure";
                    node.error = error.message;
                    throw error;
                }
            }

            if (name === "click_by_ref") {
                const { host } = await resolveHost(caller, sessionArg);
                const message = await host.click(String(a?.ref ?? ""));
                return jsonToolResult({ success: true, ref: a?.ref, result: message }, { text: `${message}` });
            }
            if (name === "click_by_selector") {
                const { host } = await resolveHost(caller, sessionArg);
                return jsonToolResult({ success: true, result: await host.click(String(a.selector)) });
            }
            if (name === "fill_by_selector") {
                const { host } = await resolveHost(caller, sessionArg);
                return jsonToolResult({ success: true, result: await host.fill(String(a.selector), a.value) });
            }
            if (name === "wait_for_selector") {
                const { host } = await resolveHost(caller, sessionArg);
                return jsonToolResult({ success: await host.waitForSelector(String(a.selector), Number(a?.timeout ?? 15_000)) });
            }
            if (name === "wait_for_text") {
                const { host } = await resolveHost(caller, sessionArg);
                return jsonToolResult({ success: await host.waitForText(String(a.text), Number(a?.timeout ?? 15_000)) });
            }
            if (name === "smart_navigate") {
                const { host } = await resolveHost(caller, sessionArg);
                await host.navigate(String(a.url));
                const result: any = { success: true, url: await host.url(), title: await host.title() };
                if (a.screenshot) result.screenshot = (await host.screenshot({})).base64 ?? null;
                return jsonWithImages(secretStore.redactDeep(result));
            }
            if (name === "browser_intent") {
                const { host, sessionId } = await resolveHost(caller, sessionArg);
                return jsonWithImages(secretStore.redactDeep(await runAct(host, { ...a, action: "intent" }, sessionId)));
            }
            if (name === "agent_action") {
                const { host, sessionId } = await resolveHost(caller, sessionArg);
                return jsonWithImages(secretStore.redactDeep(await runAct(host, { ...a, action: "agent_action", agentAction: a.action }, sessionId)));
            }
            if (name === "observe_and_act") {
                const { host, sessionId } = await resolveHost(caller, sessionArg);
                return jsonWithImages(secretStore.redactDeep(await runAct(host, { ...a, action: "observe_and_act", agentAction: a.action }, sessionId)));
            }
            if (name === "agent_form_fill") {
                const { host, sessionId } = await resolveHost(caller, sessionArg);
                return jsonWithImages(secretStore.redactDeep(await runAct(host, { ...a, action: "form_fill" }, sessionId)));
            }
            if (name === "sample_visual_frames") {
                const { host, sessionId } = await resolveHost(caller, sessionArg);
                const result = await runAct(host, { ...a, action: "sample_visual_frames" }, sessionId);
                return jsonWithImages(secretStore.redactDeep(result), true);
            }

            // ==================== DIAGNOSTICS ====================
            if (name === "get_logs") {
                const { host } = await resolveHost(caller, sessionArg);
                return jsonToolResult({ logs: host.consoleLogs(Number(a?.limit ?? 50)) });
            }
            if (name === "get_network_errors") {
                const { host } = await resolveHost(caller, sessionArg);
                return jsonToolResult({ requests: host.networkErrors(Number(a?.limit ?? 20)) });
            }
            if (name === "har_start") {
                const { host } = await resolveHost(caller, sessionArg);
                const status = await host.startNetworkCapture();
                return jsonToolResult({ ...status, path: a?.path ?? null }, {
                    text: `HAR capture started (${status.entries} entries so far). Stop it with diagnostics {action:"har_stop"}${a?.path ? ` and it will be written to ${a.path}` : ""}.`,
                });
            }
            if (name === "har_stop") {
                const { host } = await resolveHost(caller, sessionArg);
                const result = await host.stopNetworkCapture(a?.path ? String(a.path) : undefined);
                return jsonToolResult(result, {
                    text: `HAR capture stopped after ${result.entries} entries${result.path ? `; written to ${result.path}` : ""}.`,
                });
            }
            if (name === "har_status") {
                const { host } = await resolveHost(caller, sessionArg);
                return jsonToolResult({ ...host.networkCaptureStatus(), entries: host.networkTraffic(Number(a?.limit ?? 20)) });
            }

            if (name === "secrets") {
                const store = getSecretStore();
                await store.load();
                const action = String(a?.action ?? "list");

                if (action === "list") {
                    return jsonToolResult({ profiles: await store.list() });
                }
                if (action === "status") {
                    return jsonToolResult(await store.status(String(a?.name ?? "")));
                }
                if (action === "set" || action === "add") {
                    const values: Record<string, string> =
                        a?.values && typeof a.values === "object"
                            ? a.values
                            : a?.key
                              ? { [String(a.key)]: String(a.value ?? "") }
                              : {};
                    const profile = await store.set(String(a?.name ?? ""), values, Array.isArray(a?.origins) ? a.origins : []);
                    return jsonToolResult({ ...profile, stored: true }, {
                        text: `Stored secret profile '${profile.name}' with keys: ${profile.keys.join(", ")}. Values are never returned.`,
                    });
                }
                if (action === "remove" || action === "delete") {
                    const removed = await store.remove(String(a?.name ?? ""));
                    return jsonToolResult({ removed });
                }
                if (action === "type") {
                    const profile = await store.get(String(a?.name ?? ""));
                    if (!profile) throw new Error(`No secret profile named '${a?.name}'. Create it with secrets {action:"set"}.`);
                    const key = String(a?.secretKey ?? Object.keys(profile.values)[0] ?? "");
                    const value = profile.values[key];
                    if (!value) throw new Error(`Profile '${profile.name}' has no secret '${key}'.`);
                    const { host } = await resolveHost(caller, sessionArg);
                    const target = a?.selector ?? a?.label ?? a?.ref;
                    if (!target) throw new Error("secrets type needs a selector, label, or ref for the field.");
                    await host.fill(String(target), value);
                    return jsonToolResult({ typed: true, name: profile.name, key, origins: profile.origins }, {
                        text: `Typed secret '${key}' from '${profile.name}'. Its value was not returned.`,
                    });
                }
                if (action === "run") {
                    const result = await store.run(
                        String(a?.name ?? ""),
                        String(a?.command ?? ""),
                        Array.isArray(a?.args) ? a.args.map(String) : [],
                        Number(a?.timeoutMs ?? 60_000)
                    );
                    return jsonToolResult(result);
                }
                throw new Error(`Unknown secrets action: ${action}`);
            }
            if (name === "get_performance_metrics") {
                const { host } = await resolveHost(caller, sessionArg);
                const cdp = await withCdp(host);
                await cdp("Performance.enable");
                return jsonToolResult(await cdp("Performance.getMetrics"));
            }

            // ==================== PAGE TEXT ====================
            if (name === "get_page_text") {
                const { host } = await resolveHost(caller, sessionArg);
                const result = await host.evaluate((arg: any) => {
                    const root = arg.selector ? document.querySelector(arg.selector) : document.body;
                    const title = document.title;
                    const url = location.href;
                    if (!root) return { title, url, text: "" };
                    const text = (root as HTMLElement).innerText || root.textContent || "";
                    return { title, url, text };
                }, { selector: a?.selector });
                const payload = result as { title: string; url: string; text: string };
                const maxLength = Number(a?.maxLength ?? 20_000);
                const text = secretStore.redact(payload.text.slice(0, maxLength));
                const truncated = payload.text.length > maxLength;
                return jsonToolResult({ ...payload, title: secretStore.redact(payload.title), text, truncated, length: text.length }, {
                    text: `Title: ${secretStore.redact(payload.title)}\nURL: ${payload.url}\nFormat: ${a?.format ?? "text"} | ${text.length} chars${truncated ? " (truncated)" : ""}\n\n${text}`,
                });
            }

            // ==================== CAPTCHA ====================
            if (name === "detect_captcha") {
                const { host, sessionId } = await resolveHost(caller, sessionArg);
                return jsonToolResult(await runAct(host, { action: "detect_captcha" }, sessionId));
            }
            if (name === "solve_captcha") {
                const { host } = await resolveHost(caller, sessionArg);
                const evaluate = (script: string) => host.page.evaluate(script);
                const sendCommand = async (method: string, params: any) => {
                    assertCdpAllowed(method);
                    const session = await host.rawCdp();
                    return await session.send(method as any, params);
                };
                const result = await detectAndSolve(evaluate as any, sendCommand, await host.url(), { x: 200, y: 200 }, {
                    useService: a?.useService,
                    service: a?.service,
                    apiKey: a?.apiKey,
                    waitAfterClick: a?.waitAfterClick,
                    timeout: a?.timeout,
                    pollInterval: a?.pollInterval,
                });
                return jsonToolResult(result);
            }

            // ==================== CDP ====================
            if (name === "cdp_command") {
                const { host } = await resolveHost(caller, sessionArg);
                assertCdpAllowed(String(a.command));
                const session = await host.rawCdp();
                const result = await session.send(String(a.command) as any, (a.args ?? {}) as any);
                return jsonWithImages(secretStore.redactDeep(result));
            }

            throw new Error(`Unknown tool: ${name}`);
        } catch (error: any) {
            return toolError(error);
        }
    });
}
