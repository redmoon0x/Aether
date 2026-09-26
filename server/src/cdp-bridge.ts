/**
 * CdpBridge — thin command router that delegates to focused bridge modules.
 *
 * Previously this was a 2,761-line God object. Now it's ~350 lines of routing
 * logic. All actual browser operations live in the bridge/ modules.
 */
import { getCdpClient, CdpClient } from "./cdp-client";
import { LocatorEngine } from "./locator-engine";
import { PageSnapshotCache } from "./page-snapshot-cache";
import { detectAndSolve, SolverOptions } from "./captcha-solver";
import { createLogger, Logger } from "./logger";

// Bridge modules
import * as Navigation from "./bridge/navigation";
import * as Interaction from "./bridge/interaction";
import * as Inspection from "./bridge/inspection";
import * as Session from "./bridge/session";
import * as Debugging from "./bridge/debugging";

// Eval scripts (for methods not yet fully extracted)
import { CAPTCHA_DETECTION_SCRIPT } from "./eval-scripts";

export class CdpBridge {
    private client: CdpClient;
    private locator: LocatorEngine;
    snapshotCache: PageSnapshotCache;
    private logger: Logger;

    // Screencast state (kept here until extracted to module)
    private screencastFrames: string[] = [];
    private screencastFrameListener: ((event: any) => void) | null = null;
    private mockRoutes: Array<{ pattern: string; response: string }> = [];
    private mockRouteListener: ((event: any) => void) | null = null;

    constructor() {
        this.client = getCdpClient();
        this.locator = new LocatorEngine(this.client);
        this.snapshotCache = new PageSnapshotCache(this.client, this.locator);
        this.logger = createLogger("bridge");
    }

    // ─── Speed Control ────────────────────────────────────────────────

    getSpeedMultiplier(): number {
        return this.client.getSpeedMultiplier();
    }

    setSpeed(m: number): void {
        this.client.setSpeed(m);
    }

    // ─── Main Command Router ──────────────────────────────────────────

    async sendCommand(method: string, params: any = {}): Promise<any> {
        const log = this.logger.child(method);

        try {
            switch (method) {
                // ─── Navigation ────────────────────────────────────────
                case "connect":
                    return Navigation.connect(this.client, params);
                case "navigate":
                    await this.ensureConnected();
                    return Navigation.navigate(this.client, params, this.snapshotCache);
                case "smart_navigate":
                    await this.ensureConnected();
                    return Navigation.smartNavigate(this.client, params, this.snapshotCache, log);
                case "new_tab":
                    await this.ensureConnected();
                    return Navigation.newTab(this.client, params);
                case "switch_tab":
                    await this.ensureConnected();
                    return Navigation.switchTab(this.client, params);
                case "close_tab":
                    await this.ensureConnected();
                    return Navigation.closeTab(this.client, params);
                case "get_tabs":
                    await this.ensureConnected();
                    return Navigation.getTabs(this.client, params);

                // ─── Inspection ────────────────────────────────────────
                case "browser_status":
                    return Inspection.browserStatus(this.client, params);
                case "snapshot_compact":
                    await this.ensureConnected();
                    return Inspection.snapshotCompact(this.client, this.snapshotCache, params);
                case "list_interactive_elements":
                    await this.ensureConnected();
                    return Inspection.listInteractiveElements(this.client, this.snapshotCache, this.locator, params);
                case "get_state":
                    await this.ensureConnected();
                    return Inspection.getState(this.client, this.snapshotCache, this.locator, params);
                case "page_snapshot":
                    await this.ensureConnected();
                    return Inspection.pageSnapshot(this.client, params);
                case "get_page_text":
                    await this.ensureConnected();
                    return Inspection.getPageText(this.client, params);
                case "get_tree":
                    await this.ensureConnected();
                    return Inspection.getAccessibilityTree(this.client);
                case "get_dom_tree":
                case "get_dom_snapshot":
                    await this.ensureConnected();
                    return Inspection.getDOMTree(this.client);
                case "highlight_elements":
                    await this.ensureConnected();
                    return Inspection.highlightElements(this.client);
                case "verify_ui_state":
                    await this.ensureConnected();
                    return Inspection.verifyUIState(this.client, params);
                case "get_computed_style":
                    await this.ensureConnected();
                    return Inspection.getComputedStyle(this.client, params);
                case "get_event_listeners":
                    await this.ensureConnected();
                    return Inspection.getEventListeners(this.client, params);

                // ─── Interaction ───────────────────────────────────────
                case "click_by_ref":
                    await this.ensureConnected();
                    return Interaction.clickByRef(this.client, this.locator, this.snapshotCache, params, log);
                case "click_by_selector":
                    await this.ensureConnected();
                    return Interaction.clickBySelector(this.client, this.locator, this.snapshotCache, params, log);
                case "fill_by_selector":
                    await this.ensureConnected();
                    return Interaction.fillBySelector(this.client, this.locator, this.snapshotCache, params, log);
                case "wait_for_selector":
                    await this.ensureConnected();
                    return this.waitForSelectorCompact(params);
                case "wait_for_text":
                    await this.ensureConnected();
                    return this.waitForText(params);
                case "press_key":
                case "key_combo":
                    await this.ensureConnected();
                    return Interaction.pressKey(this.client, this.locator, this.snapshotCache, params, log);
                case "click_text":
                    await this.ensureConnected();
                    return Interaction.clickText(this.client, this.locator, this.snapshotCache, params, log);
                case "click_role":
                    await this.ensureConnected();
                    return Interaction.clickRole(this.client, this.locator, this.snapshotCache, params, log);
                case "fill_label":
                    await this.ensureConnected();
                    return Interaction.fillLabel(this.client, this.locator, this.snapshotCache, params, log);
                case "click":
                    await this.ensureConnected();
                    return Interaction.click(this.client, this.locator, this.snapshotCache, params, log);
                case "click_element":
                    await this.ensureConnected();
                    return Interaction.clickElement(this.client, this.locator, this.snapshotCache, params, log);
                case "click_element_by_selector":
                    await this.ensureConnected();
                    return Interaction.clickElementBySelector(this.client, this.locator, this.snapshotCache, params, log);
                case "type":
                    await this.ensureConnected();
                    return Interaction.type(this.client, this.locator, this.snapshotCache, params, log);
                case "fill":
                    await this.ensureConnected();
                    return Interaction.fillInput(this.client, this.locator, this.snapshotCache, params, log);
                case "select":
                    await this.ensureConnected();
                    return Interaction.selectOption(this.client, this.locator, this.snapshotCache, params, log);
                case "check":
                    await this.ensureConnected();
                    return Interaction.checkElement(this.client, this.locator, this.snapshotCache, params, log);
                case "hover":
                    await this.ensureConnected();
                    return Interaction.hover(this.client, this.locator, this.snapshotCache, params, log);
                case "drag_and_drop":
                    await this.ensureConnected();
                    return Interaction.dragAndDrop(this.client, this.locator, this.snapshotCache, params, log);
                case "scroll":
                    await this.ensureConnected();
                    return Interaction.scroll(this.client, this.locator, this.snapshotCache, params, log);
                case "wait":
                    await this.ensureConnected();
                    return Interaction.wait(this.client, this.locator, this.snapshotCache, params, log);
                case "element_at_point":
                    await this.ensureConnected();
                    return Interaction.elementAtPoint(this.client, this.locator, this.snapshotCache, params, log);
                case "browser_intent":
                    await this.ensureConnected();
                    return this.browserIntent(params);
                case "screenshot":
                case "screenshot_region":
                    await this.ensureConnected();
                    return this.screenshot(params);
                case "evaluate":
                    await this.ensureConnected();
                    return Debugging.evaluate(this.client, params);

                // ─── Session ───────────────────────────────────────────
                case "save_auth_state":
                    await this.ensureConnected();
                    return Session.saveAuthState(this.client, params, this.snapshotCache);
                case "load_auth_state":
                    await this.ensureConnected();
                    return Session.loadAuthState(this.client, params, this.snapshotCache);
                case "get_cookies":
                    await this.ensureConnected();
                    return Session.getCookies(this.client);
                case "set_cookie":
                    await this.ensureConnected();
                    return Session.setCookie(this.client, params);
                case "clear_cache":
                    await this.ensureConnected();
                    return Session.clearCache(this.client);

                // ─── Debugging ──────────────────────────────────────────
                case "get_logs":
                    await this.ensureConnected();
                    return Debugging.getLogs(this.client, params);
                case "get_network_errors":
                    await this.ensureConnected();
                    return Debugging.getNetworkErrors(this.client, params);
                case "get_network_traffic":
                    await this.ensureConnected();
                    return Debugging.getNetworkTraffic(this.client);
                case "get_network_response":
                    await this.ensureConnected();
                    return Debugging.getNetworkResponse(this.client, params);
                case "get_performance_metrics":
                    await this.ensureConnected();
                    return Debugging.getPerformanceMetrics(this.client);
                case "start_tracing":
                    await this.ensureConnected();
                    return Debugging.startTracing(this.client, params);
                case "stop_tracing":
                    await this.ensureConnected();
                    return Debugging.stopTracing(this.client);
                case "cdp_command":
                    await this.ensureConnected();
                    return Debugging.cdpCommand(this.client, params);
                case "assert":
                    await this.ensureConnected();
                    return Debugging.assertCondition(this.client, params);
                case "get_dom_storage":
                    await this.ensureConnected();
                    return Debugging.getDOMStorage(this.client, params);

                // ─── CAPTCHA ───────────────────────────────────────────
                case "detect_captcha":
                    await this.ensureConnected();
                    return this.detectCaptcha();
                case "solve_captcha":
                    await this.ensureConnected();
                    return this.solveCaptchaAction(params);

                // ─── Configuration ─────────────────────────────────────
                case "configure":
                    await this.ensureConnected();
                    return this.configureBrowser(params);
                case "emulate_network":
                    await this.ensureConnected();
                    return this.emulateNetworkConditions(params);
                case "set_geolocation":
                    await this.ensureConnected();
                    return this.setGeolocation(params);
                case "set_timezone":
                    await this.ensureConnected();
                    return this.setTimezone(params);
                case "print_pdf":
                    await this.ensureConnected();
                    return this.printPDF(params);
                case "upload_file":
                    await this.ensureConnected();
                    return this.uploadFile(params);
                case "mock_network_request":
                    await this.ensureConnected();
                    return this.mockNetworkRequest(params);

                // ─── Screencast ────────────────────────────────────────
                case "start_screencast":
                    await this.ensureConnected();
                    return this.startScreencast(params);
                case "stop_screencast":
                    await this.ensureConnected();
                    return this.stopScreencast(params);
                case "record_session":
                    await this.ensureConnected();
                    return this.recordSession(params);
                case "sample_visual_frames":
                    await this.ensureConnected();
                    return this.sampleVisualFrames(params);
                case "get_screencast_frames":
                    await this.ensureConnected();
                    return this.getScreencastFrames(params);

                // ─── Agent APIs ────────────────────────────────────────
                case "agent_action":
                    await this.ensureConnected();
                    return this.agentAction(params);
                case "observe_and_act":
                    await this.ensureConnected();
                    return this.observeAndAct(params);
                case "agent_form_fill":
                    await this.ensureConnected();
                    return this.agentFormFill(params);

                default:
                    await this.ensureConnected();
                    return this.client.sendCommand(method, params);
            }
        } catch (err: any) {
            log.error("Command failed", { error: err.message, method });
            throw err;
        }
    }

    // ─── Connection helpers ───────────────────────────────────────────

    async ensureConnected(): Promise<void> {
        if (!this.client.isConnected()) {
            try {
                await this.client.connect(9222);
            } catch {
                await this.client.launch({ headless: false });
            }
        }
    }

    async launchBrowser(options?: {
        browser?: "chrome" | "edge" | "brave" | "firefox";
        headless?: boolean;
        port?: number;
        profile?: string;
        profileDirectory?: string;
        userDataDir?: string;
    }): Promise<string> {
        return Session.launchBrowser(this.client, options);
    }

    async killBrowser(): Promise<string> {
        return Session.killBrowser(this.client);
    }

    async listBrowsers(): Promise<any> {
        return Session.listBrowsers(this.client);
    }

    async listBrowserProfiles(browser?: "chrome" | "edge" | "brave"): Promise<any> {
        return Session.listBrowserProfiles(this.client, browser);
    }

    // ─── Self-healing selector resolution ─────────────────────────────

    async resolveSelector(params: any): Promise<{ selector: string; method: string; confidence: number }> {
        const { originalSelector, text, fuzzyMatch } = params;

        if (originalSelector) {
            const exists = await this.client.evaluate(
                `!!document.querySelector(${JSON.stringify(originalSelector)})`
            );
            if (exists) {
                return { selector: originalSelector, method: "exact", confidence: 1.0 };
            }
        }

        const resolved = await this.locator.resolve({
            target: text,
            timeout: params.timeout || 1500,
            includeCandidates: false,
        }).catch(() => null);

        if (resolved?.success && (resolved.selector || resolved.ref)) {
            return {
                selector:
                    resolved.candidate?.scope === "document" &&
                    resolved.candidate.framePath.length === 0 &&
                    resolved.candidate.shadowDepth === 0
                        ? resolved.selector || ""
                        : resolved.ref || "",
                method: resolved.matchedBy || "locator",
                confidence: resolved.confidence || 0.7,
            };
        }

        if (fuzzyMatch !== false && text) {
            const { makeFuzzyMatchScript } = await import("./eval-scripts");
            const result = await this.client.evaluate(makeFuzzyMatchScript(text));
            if (result) {
                return { selector: result.selector, method: "fuzzy", confidence: result.confidence };
            }
        }

        throw new Error(`Could not resolve selector. Original: ${originalSelector}, Text: ${text}`);
    }

    // ─── CAPTCHA ──────────────────────────────────────────────────────

    private async detectCaptcha(): Promise<any> {
        return await this.client.evaluate(CAPTCHA_DETECTION_SCRIPT).catch((error: any) => ({
            detected: false,
            captchaRequired: false,
            message: `CAPTCHA detection failed: ${error.message}`,
        }));
    }

    private async solveCaptchaAction(params: any): Promise<any> {
        const pageUrl: string =
            params.pageUrl || (await this.client.evaluate("window.location.href").catch(() => ""));
        const opts: SolverOptions = {
            useService: params.useService,
            service: params.service,
            apiKey: params.apiKey,
            timeout: params.timeout,
            pollInterval: params.pollInterval,
            waitAfterClick: params.waitAfterClick,
        };
        const evaluate = (script: string) => this.client.evaluate(script);
        const sendCommand = (method: string, p: any) => this.client.sendCommand(method, p);
        const mouse = this.client.getMousePosition();
        return await detectAndSolve(evaluate, sendCommand, pageUrl, mouse, opts);
    }

    // ─── Screenshot ───────────────────────────────────────────────────

    private async screenshot(params: any): Promise<string> {
        const format = params.format === "png" ? "png" : "jpeg";
        const quality = params.quality || 80;

        if (params.x !== undefined) {
            const result = await this.client.sendCommand("Page.captureScreenshot", {
                format,
                quality,
                clip: {
                    x: params.x,
                    y: params.y,
                    width: params.width || 100,
                    height: params.height || 100,
                    scale: 1,
                },
            });
            return result.data;
        }

        return await this.client.screenshot(format, quality);
    }

    // ─── Wait helpers (compact versions kept here) ────────────────────

    private async waitForSelectorCompact(params: any): Promise<any> {
        const selector = params.selector;
        if (!selector) throw new Error("selector required");
        const found = await this.client.waitForSelector(selector, params.timeout || 5000, {
            visible: params.visible === true,
            stable: params.stable === true,
        });
        return { success: found, selector };
    }

    private async waitForText(params: any): Promise<any> {
        const text = String(params.text || "");
        if (!text) throw new Error("text required");
        const timeout = params.timeout || 5000;
        const start = Date.now();

        while (Date.now() - start < timeout) {
            const found = await this.client
                .evaluate(`(document.body && document.body.innerText || '').includes(${JSON.stringify(text)})`)
                .catch(() => false);
            if (found) return { success: true, text };
            await new Promise((r) => setTimeout(r, 200 * Math.max(0.1, this.getSpeedMultiplier())));
        }

        return { success: false, text, message: "Text not found before timeout" };
    }

    // ─── Browser Intent ───────────────────────────────────────────────

    private async browserIntent(params: any): Promise<any> {
        const intent = String(params.intent || "").toLowerCase();
        const timeout = params.timeout || 7000;

        if (intent === "navigate") {
            const url = params.value || params.target;
            if (!url) throw new Error("value or target required for navigate intent");
            await Navigation.navigate(this.client, { url: String(url), timeout }, this.snapshotCache);
            return { success: true, intent, url };
        }

        if (intent === "inspect") {
            const snapshot = await Inspection.snapshotCompact(this.client, this.snapshotCache, {
                maxElements: params.maxElements ?? 30,
                includeText: true,
            });
            return { success: true, intent, ...snapshot };
        }

        if (intent === "wait_for") {
            const expected = params.value || params.target;
            if (!expected) throw new Error("value or target required for wait_for intent");
            const result = await this.waitForText({ text: expected, timeout });
            return { success: result.success, intent, ...result };
        }

        const resolved = await this.locator.resolve({
            target: params.target,
            role: params.role,
            timeout,
            includeCandidates: params.includeCandidates,
        });

        if (!resolved.success) {
            return {
                success: false,
                intent,
                message: resolved.message,
                candidates: params.includeCandidates ? resolved.candidates : undefined,
            };
        }

        const selector = resolved.selector;
        const candidate = resolved.candidate;

        // Dispatch the requested intent against a given candidate. Extracted so
        // the postcondition retry below can re-run it against a fresh locator.
        const dispatch = async (
            cand: typeof candidate,
            sel: string | undefined
        ): Promise<void> => {
            if (intent === "click") {
                await Interaction.clickResolvedLocator(
                    this.client, this.locator, this.snapshotCache, cand
                );
            } else if (intent === "fill") {
                if (
                    cand?.scope === "document" &&
                    cand.framePath.length === 0 &&
                    cand.shadowDepth === 0 &&
                    sel
                ) {
                    await Interaction.fillBySelector(
                        this.client, this.locator, this.snapshotCache, {
                            selector: sel,
                            value: params.value ?? "",
                            timeout,
                        },
                        this.logger
                    );
                } else {
                    await this.locator.focusAndClear(cand!);
                    await this.client.typeText(String(params.value ?? ""));
                }
            } else if (intent === "select") {
                await Interaction.selectOption(
                    this.client, this.locator, this.snapshotCache, {
                        selector: sel!,
                        value: params.value ?? "",
                    },
                    this.logger
                );
            } else if (intent === "check") {
                await Interaction.checkElement(
                    this.client, this.locator, this.snapshotCache, {
                        selector: sel!,
                    },
                    this.logger
                );
            } else {
                throw new Error(`Unsupported browser intent: ${intent}`);
            }
        };

        // Capture before/after page facts around the action so a click that
        // reports success but changed nothing becomes visible to the caller.
        let effectiveSelector = selector;
        let { report } = await Interaction.withPostcondition(
            this.client,
            selector,
            () => dispatch(candidate, selector)
        );

        // Narrow retry: only when the target node vanished with no other effect,
        // which means we clicked a node the page replaced mid-dispatch. Re-resolve
        // from the original query rather than reusing the now-stale selector.
        let retried = false;
        if (report.shouldRetry) {
            const retryResolved = await this.locator
                .resolve({
                    target: params.target,
                    role: params.role,
                    timeout,
                    includeCandidates: params.includeCandidates,
                })
                .catch(() => null);

            if (retryResolved?.success && retryResolved.candidate) {
                retried = true;
                effectiveSelector = retryResolved.selector;
                ({ report } = await Interaction.withPostcondition(
                    this.client,
                    effectiveSelector,
                    () => dispatch(retryResolved.candidate, retryResolved.selector)
                ));
            }
        }

        let verification: any = undefined;
        if (params.verify) {
            verification = await this.waitForText({ text: params.verify, timeout }).catch((error: any) => ({
                success: false,
                error: error.message,
            }));
        }

        return {
            success: true,
            intent,
            target: resolved.target,
            matchedBy: resolved.matchedBy,
            confidence: resolved.confidence,
            selector: effectiveSelector,
            ref: resolved.ref || (effectiveSelector ? `css:${effectiveSelector}` : undefined),
            verification,
            candidates: params.includeCandidates ? resolved.candidates : undefined,
            ambiguous: resolved.ambiguous,
            retried,
            postcondition: report,
            warning: [resolved.ambiguityWarning, report.note].filter(Boolean).join(' ') || undefined,
        };
    }

    // ─── Agent APIs ───────────────────────────────────────────────────

    private async agentAction(params: any): Promise<any> {
        const { action, target, verify, waitFor, timeout } = params;
        const timeoutMs = timeout || 10000;

        try {
            switch (action) {
                case "click":
                    if (target.id) {
                        await Interaction.clickElement(this.client, this.locator, this.snapshotCache,
                            { id: target.id, button: target.button }, this.logger);
                    } else if (target.selector) {
                        await this.client.waitForSelector(target.selector, 5000);
                        await Interaction.clickElementBySelector(this.client, this.locator, this.snapshotCache,
                            { selector: target.selector, button: target.button }, this.logger);
                    } else if (target.x !== undefined) {
                        await this.client.click(target.x, target.y, target.button);
                    }
                    break;
                case "type":
                    if (target.selector) {
                        await this.client.waitForSelector(target.selector, 5000);
                        await this.client.moveMouseToSelector(target.selector).catch(() => { });
                        await this.client.evaluate(
                            `(function(){var el=document.querySelector(${JSON.stringify(target.selector)});if(el){el.value='';el.focus();}})()`
                        );
                    }
                    await this.client.typeText(target.text || target.value || "");
                    break;
                case "scroll":
                    await this.client.sendCommand("Input.dispatchMouseWheel", {
                        x: target.x || 0, y: target.y || 0,
                        deltaX: target.deltaX || 0, deltaY: target.deltaY || target.y || 0,
                    });
                    break;
                case "key_press":
                    await this.client.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", text: target.key, key: target.key });
                    await this.client.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", text: target.key, key: target.key });
                    break;
                case "hover":
                    await this.client.moveMouse(target.x || 0, target.y || 0);
                    break;
                case "drag":
                    const sx = target.startX || target.x || 0;
                    const sy = target.startY || target.y || 0;
                    const ex = target.endX || sx + 100;
                    const ey = target.endY || sy + 100;
                    await this.client.moveMouse(sx, sy);
                    await this.client.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: sx, y: sy, button: "left", clickCount: 1 });
                    await this.client.moveMouse(ex, ey);
                    await this.client.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: ex, y: ey, button: "left", clickCount: 1 });
                    break;
            }

            if (waitFor) {
                if (waitFor.type === "network_idle") {
                    await this.client.waitForNetworkIdle(500, waitFor.timeout || 3000);
                } else if (waitFor.type === "element" && waitFor.selector) {
                    await this.client.waitForSelector(waitFor.selector, waitFor.timeout || 5000);
                } else if (waitFor.type === "navigation") {
                    await this.client.waitForNavigation(waitFor.timeout || 10000).catch(() => { });
                }
            } else {
                await new Promise((r) => setTimeout(r, 500));
            }

            let verification: any = null;
            if (verify) {
                if (verify.type === "element_exists") {
                    verification = await this.client.evaluate(
                        `(function(){var el=document.querySelector(${JSON.stringify(verify.selector)});return {success:!!el,exists:!!el,message:el?"Element exists":"Element not found"};})()`
                    );
                } else if (verify.type === "element_contains_text") {
                    verification = await this.client.evaluate(
                        `(function(){var el=document.querySelector(${JSON.stringify(verify.selector)});if(!el)return {success:false,message:"Element not found"};var t=(el.innerText||el.textContent||"").trim();var m=t.indexOf(${JSON.stringify(verify.expectedText||verify.text||"")})>=0;return {success:m,text:t,message:m?"Verified":"Text mismatch"};})()`
                    );
                } else if (verify.selector) {
                    const res = await this.client.evaluate(
                        `!!document.querySelector(${JSON.stringify(verify.selector)})`
                    );
                    verification = { success: !!res, selector: verify.selector };
                }
            }

            const screenshot = params.screenshot === true ? await this.client.screenshot("jpeg", 70).catch(() => null) : null;
            const url = await this.client.evaluate("window.location.href").catch(() => "Unknown");
            const title = await this.client.evaluate("document.title").catch(() => "Unknown");

            return { success: true, action: `${action} completed`, verification, screenshot, url, title };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    private async observeAndAct(params: any): Promise<any> {
        const { action, observe, returnScreenshot } = params;
        try {
            const [beforeFacts, beforeScreenshot] = await Promise.all([
                Interaction.captureActionFacts(this.client, action?.selector),
                returnScreenshot === true ? this.client.screenshot("jpeg", 70).catch(() => null) : Promise.resolve(null),
            ]);

            if (action.type === "click" && action.selector) {
                await this.client.waitForSelector(action.selector, 5000, { visible: true, stable: true });
                await Interaction.clickElementBySelector(this.client, this.locator, this.snapshotCache,
                    { selector: action.selector }, this.logger);
            } else if (action.type === "type" && action.text) {
                if (action.selector) {
                    await Interaction.fillBySelector(this.client, this.locator, this.snapshotCache,
                        { selector: action.selector, value: action.text, timeout: 5000 }, this.logger);
                } else {
                    await this.client.typeText(action.text);
                }
            }

            if (observe?.type === "dom_change") {
                await this.client.waitForNetworkIdle(300, 3000).catch(() => { });
            } else if (observe?.type === "network_response") {
                await this.client.waitForNetworkIdle(500, 5000).catch(() => { });
            } else {
                await new Promise((r) => setTimeout(r, 300));
            }

            const [afterFacts, afterScreenshot] = await Promise.all([
                Interaction.captureActionFacts(this.client, action?.selector),
                returnScreenshot === true ? this.client.screenshot("jpeg", 70).catch(() => null) : Promise.resolve(null),
            ]);

            const facts = Interaction.diffActionFacts(beforeFacts, afterFacts);
            const report = Interaction.assessActionOutcome(beforeFacts, afterFacts);
            const changesDetected = report.changed;

            return {
                success: true,
                before: { facts: beforeFacts, screenshot: beforeScreenshot },
                after: { facts: afterFacts, screenshot: afterScreenshot },
                changesDetected, facts, postcondition: report,
                navigationOccurred: facts.urlChanged,
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    private async agentFormFill(params: any): Promise<any> {
        const { fields, submitAfterFill, submitSelector } = params;
        const results: any[] = [];

        try {
            for (const field of fields) {
                const selector = field.selector || (field.id ? `#${field.id}` : undefined);
                if (!selector && field.type !== "file") {
                    results.push({ field: field.id || field.selector, success: false, error: "Missing selector or id" });
                    continue;
                }

                if (["text", "email", "password", "textarea"].includes(field.type) || !field.type) {
                    await Interaction.fillBySelector(this.client, this.locator, this.snapshotCache,
                        { selector, value: field.value ?? "", timeout: field.timeout || 5000 }, this.logger);
                } else if (field.type === "select") {
                    await Interaction.selectOption(this.client, this.locator, this.snapshotCache,
                        { selector, value: field.value ?? "" }, this.logger);
                } else if (field.type === "checkbox" || field.type === "radio") {
                    if (field.checked === false) {
                        await Interaction.setChecked(this.client, this.locator, this.snapshotCache,
                            { selector, checked: false }, this.logger);
                    } else {
                        await Interaction.checkElement(this.client, this.locator, this.snapshotCache,
                            { selector }, this.logger);
                    }
                } else if (field.type === "file") {
                    await this.uploadFile({ selector, files: field.files || [] });
                } else {
                    await Interaction.fillBySelector(this.client, this.locator, this.snapshotCache,
                        { selector, value: field.value ?? "", timeout: field.timeout || 5000 }, this.logger);
                }
                results.push({ field: field.id || field.selector, selector, success: true });
            }

            if (submitAfterFill && submitSelector) {
                await Interaction.clickElementBySelector(this.client, this.locator, this.snapshotCache,
                    { selector: submitSelector }, this.logger);
            }

            return { success: true, fieldsFilled: results.length, results };
        } catch (e: any) {
            return { success: false, error: e.message, results };
        }
    }

    // ─── Configuration ────────────────────────────────────────────────

    private async configureBrowser(params: any): Promise<any> {
        const { network, emulation, script } = params;
        const results: string[] = [];

        if (network) {
            if (network.blockImages) {
                await this.client.sendCommand("Network.setBlockedURLs", {
                    urls: ["*.jpg", "*.jpeg", "*.png", "*.gif", "*.webp", "*.svg"],
                });
                results.push("Blocked images");
            }
            if (network.blockCSS) {
                await this.client.sendCommand("Network.setBlockedURLs", { urls: ["*.css"] });
                results.push("Blocked CSS");
            }
            if (network.blockAds) {
                await this.client.sendCommand("Network.setBlockedURLs", {
                    urls: ["*doubleclick.net*", "*googlesyndication.com*", "*adservice.*"],
                });
                results.push("Blocked ads");
            }
        }

        if (emulation) {
            if (emulation.width && emulation.height) {
                await this.client.sendCommand("Emulation.setDeviceMetricsOverride", {
                    width: emulation.width, height: emulation.height,
                    deviceScaleFactor: emulation.scale || 1, mobile: emulation.mobile || false,
                });
                results.push(`Emulated device: ${emulation.width}x${emulation.height}`);
            }
            if (emulation.userAgent) {
                await this.client.sendCommand("Emulation.setUserAgentOverride", { userAgent: emulation.userAgent });
                results.push("Set custom user agent");
            }
        }

        if (script?.onLoad) {
            await this.client.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: script.onLoad });
            results.push("Added script to run on new documents");
        }

        return { success: true, configured: results, message: results.join(", ") || "No configuration applied" };
    }

    private async emulateNetworkConditions(params: any): Promise<string> {
        await this.client.sendCommand("Network.emulateNetworkConditions", {
            offline: params.offline || false,
            latency: params.latency || 0,
            downloadThroughput: params.downloadThroughput || 0,
            uploadThroughput: params.uploadThroughput || 0,
        });
        return "Network conditions emulated";
    }

    private async setGeolocation(params: any): Promise<string> {
        await this.client.sendCommand("Emulation.setGeolocationOverride", {
            latitude: params.latitude, longitude: params.longitude, accuracy: params.accuracy || 100,
        });
        return `Geolocation set to ${params.latitude}, ${params.longitude}`;
    }

    private async setTimezone(params: any): Promise<string> {
        await this.client.sendCommand("Emulation.setTimezoneOverride", { timezoneId: params.timezoneId });
        return `Timezone set to ${params.timezoneId}`;
    }

    private async printPDF(params: any): Promise<string> {
        const result = await this.client.sendCommand("Page.printToPDF", {
            landscape: params.landscape || false,
            printBackground: params.printBackground || false,
            ...params.options,
        });
        return result.data;
    }

    private async uploadFile(params: any): Promise<string> {
        const selector = params.selector;
        const files = params.files || [];
        if (!selector) throw new Error("Selector required for upload_file");
        if (!files.length) throw new Error("No files specified");

        const result = await this.client.evaluate(
            `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return {success:false,error:"Element not found"};if(el.type!=='file')return {success:false,error:"Element is not a file input"};el.style.display='block';el.click();return {success:true};})()`
        );
        if (!result?.success) throw new Error(result?.error || "Failed to activate file input");

        const docResult = await this.client.sendCommand("DOM.getDocument", {});
        const queryResult = await this.client.sendCommand("DOM.querySelector", {
            nodeId: docResult.root.nodeId, selector,
        });
        if (!queryResult.nodeId) throw new Error(`File input not found: ${selector}`);

        await this.client.sendCommand("DOM.setFileInputFiles", { files, nodeId: queryResult.nodeId });
        return "File upload completed";
    }

    // ─── Network Mocking ──────────────────────────────────────────────

    private async mockNetworkRequest(params: any): Promise<string> {
        const urlPattern = params.urlPattern;
        const mockResponse = params.mockResponse;
        if (!urlPattern) throw new Error("urlPattern required");

        this.mockRoutes.push({ pattern: urlPattern, response: mockResponse || "{}" });

        await this.client.sendCommand("Fetch.enable", {
            patterns: this.mockRoutes.map((route) => ({ urlPattern: route.pattern })),
        });

        if (!this.mockRouteListener) {
            this.mockRouteListener = async (event: any) => {
                const route = this.mockRoutes.find((item) => this.matchesUrlPattern(event.request.url, item.pattern));
                if (!route) {
                    await this.client.sendCommand("Fetch.continueRequest", { requestId: event.requestId }).catch(() => { });
                    return;
                }
                await this.client.sendCommand("Fetch.fulfillRequest", {
                    requestId: event.requestId,
                    responseCode: 200,
                    responseHeaders: [
                        { name: "Content-Type", value: "application/json" },
                        { name: "Access-Control-Allow-Origin", value: "*" },
                    ],
                    body: Buffer.from(route.response).toString("base64"),
                }).catch(() => { });
            };
            this.client.on("Fetch.requestPaused", this.mockRouteListener);
        }

        return `Mocking enabled for pattern: ${urlPattern}`;
    }

    private matchesUrlPattern(url: string, pattern: string): boolean {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        return new RegExp(`^${escaped}$`).test(url);
    }

    // ─── Screencast ───────────────────────────────────────────────────

    private async startScreencast(params: any): Promise<string> {
        this.screencastFrames = [];
        if (!this.screencastFrameListener) {
            this.screencastFrameListener = async (event: any) => {
                this.screencastFrames.push(event.data);
                const maxFrames = params.maxFrames || 100;
                if (this.screencastFrames.length > maxFrames) {
                    this.screencastFrames.splice(0, this.screencastFrames.length - maxFrames);
                }
                try {
                    await this.client.sendCommand("Page.screencastFrameAck", { sessionId: event.sessionId });
                } catch { }
            };
            this.client.on("Page.screencastFrame", this.screencastFrameListener);
        }
        await this.client.sendCommand("Page.startScreencast", {
            format: params.format || "jpeg",
            quality: params.quality || 80,
            everyNthFrame: params.everyNthFrame || 1,
        });
        return "Started screencast";
    }

    private async stopScreencast(params: any): Promise<string> {
        await this.client.sendCommand("Page.stopScreencast", {});
        if (this.screencastFrameListener) {
            this.client.removeEventListener("Page.screencastFrame", this.screencastFrameListener);
            this.screencastFrameListener = null;
        }
        return "Stopped screencast";
    }

    private async recordSession(params: any): Promise<any> {
        const duration = params.duration || 5000;
        const frames: string[] = [];
        const onFrame = async (event: any) => {
            frames.push(event.data);
            try { await this.client.sendCommand("Page.screencastFrameAck", { sessionId: event.sessionId }); } catch { }
        };
        this.client.on("Page.screencastFrame", onFrame);
        await this.startScreencast(params);
        await new Promise((r) => setTimeout(r, duration));
        await this.stopScreencast(params);
        this.client.removeEventListener("Page.screencastFrame", onFrame);
        return { frames, frameCount: frames.length, duration };
    }

    private async sampleVisualFrames(params: any): Promise<any> {
        const duration = Math.max(250, Math.min(Number(params.duration ?? 1500), 10000));
        const maxFrames = Math.max(1, Math.min(Number(params.maxFrames ?? 4), 12));
        const frames: string[] = [];
        const timestamps: string[] = [];

        const onFrame = async (event: any) => {
            if (frames.length < maxFrames) {
                frames.push(event.data);
                timestamps.push(new Date().toISOString());
            }
            await this.client.sendCommand("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => { });
        };

        this.client.on("Page.screencastFrame", onFrame);
        await this.client.sendCommand("Page.startScreencast", {
            format: params.format || "jpeg",
            quality: Math.max(20, Math.min(Number(params.quality ?? 45), 80)),
            maxWidth: Math.max(320, Math.min(Number(params.maxWidth ?? 800), 1280)),
            maxHeight: Math.max(240, Math.min(Number(params.maxHeight ?? 600), 900)),
            everyNthFrame: Math.max(1, Math.min(Number(params.everyNthFrame ?? 3), 10)),
        });

        try {
            await new Promise((r) => setTimeout(r, duration));
        } finally {
            await this.client.sendCommand("Page.stopScreencast", {}).catch(() => { });
            this.client.removeEventListener("Page.screencastFrame", onFrame);
        }

        return { success: true, frameCount: frames.length, duration, format: params.format || "jpeg", timestamps, frames };
    }

    private async getScreencastFrames(params: any): Promise<any> {
        const maxFrames = params.maxFrames || this.screencastFrames.length;
        const frames = this.screencastFrames.slice(-maxFrames);
        return { frameCount: frames.length, frames, message: `Retrieved ${frames.length} frames` };
    }
}

// Singleton
let bridgeInstance: CdpBridge | null = null;

export function getCdpBridge(): CdpBridge {
    if (!bridgeInstance) {
        bridgeInstance = new CdpBridge();
    }
    return bridgeInstance;
}
