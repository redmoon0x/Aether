/**
 * Page host — the Playwright-backed surface tools and `execute` drive.
 *
 * It wraps one real Playwright `Page` and adds the agent-facing helpers:
 * compact snapshots with refs, semantic targeting, refs that fail closed, and
 * human handoffs. Playwright supplies the actionability checks, auto-waiting,
 * strictness, frames and input; this file does not reimplement them.
 */
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import type { Browser, BrowserContext, CDPSession, Locator, Page } from "patchright-core";
import { RefCandidate, RefRecord, RefRegistry, StaleRefError } from "./refs";
import { HandoffHooks, HandoffOutcome, HandoffRegistry, getHandoffRegistry, type HandoffCdp } from "./handoff";
import { NetworkCapture } from "./har";
import { getSecretStore } from "./secrets";

export interface SemanticTarget {
    selector?: string;
    text?: string;
    name?: string;
    role?: string;
    label?: string;
    placeholder?: string;
}

export interface RefTarget {
    ref: string;
}

export type TargetSpec = string | LocatorHandle | SemanticTarget | RefTarget;

export interface ResolvedTarget {
    locator: Locator;
    selector?: string;
    record?: RefRecord;
}

export interface SnapshotParams {
    /** Maximum interactive elements to return. Default 40, capped at 200. */
    maxElements?: number;
    /** Include short visible text for each element. Default true. */
    includeText?: boolean;
    /** Collect inside same-origin frames too. Default true. */
    frames?: boolean;
}

export interface SnapshotElement {
    ref: string;
    tag: string;
    role: string;
    name: string;
    text: string;
    selector: string;
    type: string;
    label: string;
    placeholder: string;
    bounds: { x: number; y: number; width: number; height: number };
    frameIndex: number;
}

export interface SnapshotResult {
    title: string;
    url: string;
    readyState: string;
    elementCount: number;
    elements: SnapshotElement[];
    outline: string;
    cache: { hit: boolean; version: number; ageMs: number };
}

export interface ScreenshotParams {
    path?: string;
    format?: "jpeg" | "png";
    quality?: number;
    fullPage?: boolean;
}

export interface TabSummary {
    id: string;
    title: string;
    url: string;
    type: string;
    active: boolean;
}

export interface PageHostOptions {
    browserId: string;
    targetId?: string | null;
    targetIdOf?: (page: Page) => Promise<string | null>;
    handoffs?: HandoffRegistry;
}

export interface ConsoleEntry {
    level: string;
    text: string;
    at: number;
}

export interface NetworkFailure {
    url: string;
    method: string;
    failure: string;
    at: number;
}

let ffmpegAvailable: boolean | null = null;

/** Whether `ffmpeg` is installed, checked once. Recording falls back to frames. */
function hasFfmpeg(): boolean {
    if (ffmpegAvailable !== null) return ffmpegAvailable;
    try {
        const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
        ffmpegAvailable = result.status === 0;
    } catch {
        ffmpegAvailable = false;
    }
    return ffmpegAvailable;
}

function describeSemantic(spec: SemanticTarget): string {
    const parts: string[] = [];
    if (spec.role) parts.push(`role=${spec.role}`);
    const label = spec.text ?? spec.name ?? spec.label ?? spec.placeholder;
    if (label) parts.push(`"${label}"`);
    if (spec.selector) parts.push(`selector=${spec.selector}`);
    return parts.length ? parts.join(" ") : "the target";
}

/** In-page collector. Runs inside one frame via frame.evaluate. */
function collectInFrame(arg: { maxElements: number; includeText: boolean }): Array<Omit<RefCandidate, "frameIndex">> {
    const escape = (value: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value);

    function stableSelector(element: Element): string {
        if (element.id && /^[A-Za-z][\w-]*$/.test(element.id)) return `#${escape(element.id)}`;
        const parts: string[] = [];
        let node: Element | null = element;
        while (node && node.nodeType === 1 && parts.length < 5) {
            let part = node.tagName.toLowerCase();
            const parent: Element | null = node.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter((child) => child.tagName === node!.tagName);
                if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
            }
            parts.unshift(part);
            if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
                parts[0] = `#${escape(node.id)}`;
                break;
            }
            node = parent;
        }
        return parts.join(" > ");
    }

    function roleOf(element: Element): string {
        const explicit = element.getAttribute("role");
        if (explicit) return explicit;
        const tag = element.tagName.toLowerCase();
        if (tag === "a") return "link";
        if (tag === "button") return "button";
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "input") {
            const type = (element as HTMLInputElement).type;
            if (type === "checkbox") return "checkbox";
            if (type === "radio") return "radio";
            if (type === "submit" || type === "button") return "button";
            return "textbox";
        }
        return tag;
    }

    function labelOf(element: Element): string {
        const aria = element.getAttribute("aria-label");
        if (aria) return aria;
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
            const text = labelledBy
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent?.trim() || "")
                .filter(Boolean)
                .join(" ");
            if (text) return text;
        }
        if (element.id) {
            const label = document.querySelector(`label[for="${escape(element.id)}"]`);
            if (label?.textContent) return label.textContent.trim();
        }
        const wrapping = element.closest("label");
        if (wrapping?.textContent) return wrapping.textContent.trim();
        return "";
    }

    const selector = [
        "a[href]",
        "button",
        "input:not([type=\"hidden\"])",
        "select",
        "textarea",
        "[role=\"button\"]",
        "[role=\"link\"]",
        "[role=\"checkbox\"]",
        "[role=\"radio\"]",
        "[role=\"switch\"]",
        "[role=\"tab\"]",
        "[role=\"menuitem\"]",
        "[contenteditable=\"true\"]",
        "[tabindex]:not([tabindex=\"-1\"])",
    ].join(",");

    const nodes = Array.from(document.querySelectorAll(selector));
    const out: Array<Omit<RefCandidate, "frameIndex">> = [];

    for (const element of nodes) {
        if (out.length >= arg.maxElements) break;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) continue;

        const text = arg.includeText ? (element as HTMLElement).innerText || element.textContent || "" : "";
        out.push({
            selector: stableSelector(element),
            tag: element.tagName.toLowerCase(),
            role: roleOf(element),
            text: text.trim().replace(/\s+/g, " ").slice(0, 120),
            name: (element.getAttribute("aria-label") || element.getAttribute("name") || "").slice(0, 120),
            label: labelOf(element).slice(0, 120),
            placeholder: (element as HTMLInputElement).placeholder || "",
            type: element.tagName.toLowerCase() === "input" ? (element as HTMLInputElement).type : "",
            bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        });
    }
    return out;
}

let hostInstance: PageHost | null = null;

export class LocatorHandle {
    constructor(private readonly host: PageHost, private readonly spec: TargetSpec) {}

    async click(options?: { button?: "left" | "middle" | "right" }): Promise<string> {
        return await this.host.click(this.spec, options);
    }
    async fill(value: string): Promise<string> {
        return await this.host.fill(this.spec, value);
    }
    async type(text: string): Promise<string> {
        return await this.host.type(this.spec, text);
    }
    async hover(): Promise<string> {
        return await this.host.hover(this.spec);
    }
    async press(key: string, modifiers: string[] = []): Promise<string> {
        return await this.host.pressOn(this.spec, key, modifiers);
    }
    async selectOption(value: string): Promise<string> {
        return await this.host.selectOption(this.spec, value);
    }
    async text(): Promise<string> {
        return await this.host.textOf(this.spec);
    }
    async isVisible(): Promise<boolean> {
        return await this.host.isVisible(this.spec);
    }
    async count(): Promise<number> {
        return await this.host.countOf(this.spec);
    }
    async getAttribute(name: string): Promise<string | null> {
        return await this.host.attributeOf(this.spec, name);
    }
    async selector(): Promise<string> {
        return (await this.host.resolveTarget(this.spec)).selector ?? "";
    }
    async resolve(): Promise<ResolvedTarget> {
        return await this.host.resolveTarget(this.spec);
    }
}

export class PageHost {
    readonly page: Page;
    readonly context: BrowserContext;
    readonly browser: Browser;
    readonly browserId: string;
    targetId: string | null;
    private readonly refs: RefRegistry;
    private readonly handoffs: HandoffRegistry;
    private readonly targetIdOf?: (page: Page) => Promise<string | null>;
    private handoffHooks: HandoffHooks | null = null;
    private version = 0;
    private lastInvalidate = Date.now();
    private readonly consoleEntries: ConsoleEntry[] = [];
    private readonly networkFailures: NetworkFailure[] = [];
    private castSession: CDPSession | null = null;
    private castFrames: string[] = [];
    private castListener: ((params: any) => void) | null = null;
    private traceSession: CDPSession | null = null;
    private traceEvents: any[] = [];
    private traceListener: ((params: any) => void) | null = null;
    private capture: NetworkCapture | null = null;

    constructor(page: Page, context: BrowserContext, browser: Browser, options: PageHostOptions) {
        this.page = page;
        this.context = context;
        this.browser = browser;
        this.browserId = options.browserId;
        this.targetId = options.targetId ?? null;
        this.targetIdOf = options.targetIdOf;
        this.handoffs = options.handoffs ?? getHandoffRegistry();
        this.refs = new RefRegistry(page);
        this.page.on("framenavigated", (frame) => {
            if (frame === this.page.mainFrame()) this.refs.bumpEpoch();
        });
        this.page.on("console", (message) => {
            if (this.consoleEntries.length >= 200) this.consoleEntries.shift();
            this.consoleEntries.push({ level: message.type(), text: message.text(), at: Date.now() });
        });
        this.page.on("pageerror", (error) => {
            if (this.consoleEntries.length >= 200) this.consoleEntries.shift();
            this.consoleEntries.push({ level: "error", text: String(error?.message ?? error), at: Date.now() });
        });
        this.page.on("requestfailed", (request) => {
            if (this.networkFailures.length >= 200) this.networkFailures.shift();
            this.networkFailures.push({
                url: request.url(),
                method: request.method(),
                failure: request.failure()?.errorText ?? "request failed",
                at: Date.now(),
            });
        });
    }

    consoleLogs(limit = 50): ConsoleEntry[] {
        return this.consoleEntries.slice(-limit);
    }

    networkErrors(limit = 20): NetworkFailure[] {
        return this.networkFailures.slice(-limit);
    }

    // ─── Cache / identity ─────────────────────────────────────────────

    invalidate(_reason: string): void {
        this.version++;
        this.lastInvalidate = Date.now();
    }

    invalidateDocument(reason: string): void {
        this.invalidate(reason);
        this.refs.bumpEpoch();
    }

    setHandoffHooks(hooks: HandoffHooks | null): void {
        this.handoffHooks = hooks;
    }

    // ─── Snapshot ─────────────────────────────────────────────────────

    async snapshot(params: SnapshotParams = {}): Promise<SnapshotResult> {
        const maxElements = Math.max(0, Math.min(Number(params.maxElements ?? 40), 200));
        const includeText = params.includeText !== false;
        const frames = params.frames === false ? [this.page.mainFrame()] : this.page.frames();

        const candidates: RefCandidate[] = [];
        for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
            const collected = await frames[frameIndex]
                .evaluate(collectInFrame, { maxElements, includeText })
                .catch(() => [] as Array<Omit<RefCandidate, "frameIndex">>);
            for (const item of collected) candidates.push({ ...item, frameIndex, frameUrl: frames[frameIndex].url() });
            if (candidates.length >= maxElements) break;
        }

        const url = this.page.url();
        const withRefs = this.refs.capture(candidates.slice(0, maxElements), url);
        const elements: SnapshotElement[] = withRefs.map((element) => ({
            ref: element.ref,
            tag: element.tag,
            role: element.role,
            name: element.name ?? "",
            text: element.text ?? "",
            selector: element.selector,
            type: element.type || (element.tag === "input" ? "text" : ""),
            label: element.label ?? "",
            placeholder: element.placeholder ?? "",
            bounds: element.bounds,
            frameIndex: element.frameIndex,
        }));

        const title = await this.page.title().catch(() => "");
        const readyState = String(await this.page.evaluate(() => document.readyState).catch(() => "unknown"));
        const hit = Date.now() - this.lastInvalidate < 400;

        return {
            title,
            url,
            readyState,
            elementCount: elements.length,
            elements,
            outline: this.renderOutline(title, url, readyState, elements),
            cache: { hit, version: this.version, ageMs: Date.now() - this.lastInvalidate },
        };
    }

    private renderOutline(title: string, url: string, readyState: string, elements: SnapshotElement[]): string {
        const lines = [`# ${title || "(untitled)"}`, `${url} [${readyState}]`];
        let lastFrame = -1;
        for (const element of elements) {
            if (element.frameIndex !== lastFrame) {
                if (element.frameIndex > 0) {
                    const frame = this.page.frames()[element.frameIndex];
                    lines.push(`  ── frame ${element.frameIndex}: ${frame?.url() ?? "unknown"}`);
                }
                lastFrame = element.frameIndex;
            }
            const indent = element.frameIndex > 0 ? "  " : "";
            const label = (element.text || element.name || element.placeholder || element.label || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 80);
            const role = element.role || element.tag;
            const tag = element.tag && element.tag !== role ? ` <${element.tag}>` : "";
            const kind = element.type && !["text", ""].includes(element.type) ? ` [${element.type}]` : "";
            lines.push(`${indent}${element.ref} ${role}${label ? ` "${label}"` : ""}${tag}${kind}`);
        }
        return lines.join("\n");
    }

    ref(id: string): LocatorHandle {
        return new LocatorHandle(this, { ref: id });
    }

    locator(selector: string): LocatorHandle {
        return new LocatorHandle(this, selector);
    }

    getByRole(role: string, options: { name?: string } = {}): LocatorHandle {
        return new LocatorHandle(this, { role, name: options.name });
    }

    getByText(text: string): LocatorHandle {
        return new LocatorHandle(this, { text });
    }

    getByLabel(label: string): LocatorHandle {
        return new LocatorHandle(this, { label });
    }

    getByPlaceholder(placeholder: string): LocatorHandle {
        return new LocatorHandle(this, { placeholder });
    }

    // ─── Target resolution ────────────────────────────────────────────

    async resolveTarget(spec: TargetSpec): Promise<ResolvedTarget> {
        if (spec instanceof LocatorHandle) return await spec.resolve();

        if (typeof spec === "string") {
            if (/^e\d+$/.test(spec)) {
                const { record, locator } = await this.refs.resolve(spec);
                return { locator, selector: record.selector, record };
            }
            if (await this.looksLikeSelector(spec)) {
                return { locator: this.page.locator(spec).first(), selector: spec };
            }
            return { locator: this.page.getByText(spec).first() };
        }

        if ("ref" in spec && typeof spec.ref === "string") {
            const { record, locator } = await this.refs.resolve(spec.ref);
            return { locator, selector: record.selector, record };
        }

        const semantic = spec as SemanticTarget;
        if (semantic.role) {
            const options = semantic.name ? { name: semantic.name } : undefined;
            return { locator: this.page.getByRole(semantic.role as any, options).first() };
        }
        if (semantic.label) return { locator: this.page.getByLabel(semantic.label).first() };
        if (semantic.placeholder) return { locator: this.page.getByPlaceholder(semantic.placeholder).first() };
        if (semantic.text) return { locator: this.page.getByText(semantic.text).first() };
        if (semantic.selector) return { locator: this.page.locator(semantic.selector).first(), selector: semantic.selector };

        throw new Error(`No target matched ${describeSemantic(semantic)}. Call snapshot() to see what is on the page.`);
    }

    private async looksLikeSelector(value: string): Promise<boolean> {
        if (!value.trim()) return false;
        try {
            return (await this.page.locator(value).count()) > 0;
        } catch {
            return false;
        }
    }

    // ─── Actions ──────────────────────────────────────────────────────

    async click(spec: TargetSpec, options?: { button?: "left" | "middle" | "right" }): Promise<string> {
        const { locator, selector } = await this.resolveTarget(spec);
        await locator.click({ button: options?.button, timeout: 15_000 });
        this.invalidate("click");
        return `clicked ${selector ?? "target"}`;
    }

    async fill(spec: TargetSpec, value: unknown): Promise<string> {
        const { locator, selector } = await this.resolveTarget(spec);
        await locator.fill(String(value ?? ""), { timeout: 15_000 });
        this.invalidate("fill");
        return `filled ${selector ?? "target"}`;
    }

    async type(spec: TargetSpec, text: unknown): Promise<string> {
        const { locator, selector } = await this.resolveTarget(spec);
        await locator.click({ timeout: 15_000 });
        await locator.pressSequentially(String(text ?? ""), { timeout: 15_000 });
        this.invalidate("type");
        return `typed into ${selector ?? "target"}`;
    }

    async hover(spec: TargetSpec): Promise<string> {
        const { locator, selector } = await this.resolveTarget(spec);
        await locator.hover({ timeout: 15_000 });
        this.invalidate("hover");
        return `hovered ${selector ?? "target"}`;
    }

    async press(key: string, modifiers: string[] = []): Promise<string> {
        const combo = [...modifiers, key].join("+");
        await this.page.keyboard.press(combo);
        this.invalidate("press");
        return `pressed ${combo}`;
    }

    async pressOn(spec: TargetSpec, key: string, modifiers: string[] = []): Promise<string> {
        const { locator } = await this.resolveTarget(spec);
        await locator.press([...modifiers, key].join("+"), { timeout: 15_000 });
        this.invalidate("press");
        return `pressed ${[...modifiers, key].join("+")}`;
    }

    async selectOption(spec: TargetSpec, value: string): Promise<string> {
        const { locator, selector } = await this.resolveTarget(spec);
        await locator.selectOption(value, { timeout: 15_000 });
        return `selected ${value} in ${selector ?? "target"}`;
    }

    async scroll(deltaY: number): Promise<string> {
        await this.page.mouse.wheel(0, Number(deltaY) || 0);
        this.invalidate("scroll");
        return `scrolled ${deltaY}`;
    }

    async textOf(spec: TargetSpec): Promise<string> {
        const { locator } = await this.resolveTarget(spec);
        return (await locator.innerText({ timeout: 5_000 }).catch(() => "")) || "";
    }

    async isVisible(spec: TargetSpec): Promise<boolean> {
        const { locator } = await this.resolveTarget(spec);
        return await locator.isVisible().catch(() => false);
    }

    async countOf(spec: TargetSpec): Promise<number> {
        const { locator } = await this.resolveTarget(spec);
        return await locator.count().catch(() => 0);
    }

    async attributeOf(spec: TargetSpec, name: string): Promise<string | null> {
        const { locator } = await this.resolveTarget(spec);
        return await locator.getAttribute(name, { timeout: 5_000 }).catch(() => null);
    }

    // ─── Navigation / page facts ──────────────────────────────────────

    async navigate(url: string, options: { waitUntil?: "load" | "domcontentloaded" | "networkidle" } = {}): Promise<string> {
        await this.page.goto(url, { waitUntil: options.waitUntil ?? "domcontentloaded", timeout: 45_000 });
        this.invalidateDocument("navigate");
        return url;
    }

    async reload(): Promise<string> {
        await this.page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
        this.invalidateDocument("reload");
        return this.page.url();
    }

    async goBack(): Promise<string> {
        await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
        this.invalidateDocument("goBack");
        return this.page.url();
    }

    async goForward(): Promise<string> {
        await this.page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 });
        this.invalidateDocument("goForward");
        return this.page.url();
    }

    async url(): Promise<string> {
        return this.page.url();
    }

    async title(): Promise<string> {
        return await this.page.title().catch(() => "");
    }

    async readyState(): Promise<string> {
        return String(await this.page.evaluate(() => document.readyState).catch(() => "unknown"));
    }

    async content(): Promise<string> {
        return await this.page.content().catch(() => "");
    }

    async evaluate(fnOrExpression: unknown, arg?: unknown): Promise<unknown> {
        if (typeof fnOrExpression === "function") {
            return await this.page.evaluate(fnOrExpression as any, arg as any);
        }
        return await this.page.evaluate(String(fnOrExpression));
    }

    async screenshot(params: ScreenshotParams = {}): Promise<{ base64?: string; mimeType?: string; path?: string; bytes?: number }> {
        const format = params.format === "png" ? "png" : "jpeg";
        const buffer = await this.page.screenshot({
            type: format,
            ...(format === "jpeg" ? { quality: params.quality ?? 70 } : {}),
            fullPage: params.fullPage === true,
            ...(params.path ? { path: params.path } : {}),
        });
        if (params.path) {
            const stat = await fs.stat(params.path);
            return { path: params.path, bytes: stat.size, mimeType: `image/${format}` };
        }
        return { base64: buffer.toString("base64"), mimeType: `image/${format}` };
    }

    async tabs(): Promise<TabSummary[]> {
        const pages = this.context.pages();
        const tabs: TabSummary[] = [];
        for (let index = 0; index < pages.length; index++) {
            const page = pages[index];
            tabs.push({
                id: (this.targetIdOf ? await this.targetIdOf(page) : null) ?? String(index),
                title: await page.title().catch(() => ""),
                url: page.url(),
                type: "page",
                active: page === this.page,
            });
        }
        return tabs;
    }

    async newTab(url?: string): Promise<string> {
        const page = await this.context.newPage();
        if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
        this.invalidateDocument("new tab");
        return (this.targetIdOf ? await this.targetIdOf(page) : null) ?? "";
    }

    async closeTab(targetId?: string): Promise<string> {
        const pages = this.context.pages();
        let page: Page | undefined;
        if (targetId) {
            for (const candidate of pages) {
                if ((this.targetIdOf ? await this.targetIdOf(candidate) : null) === targetId) {
                    page = candidate;
                    break;
                }
            }
        }
        if (!page) page = this.page;
        await page.close();
        this.invalidateDocument("closed tab");
        return targetId ?? "";
    }

    async waitForSelector(selector: string, timeout = 15_000): Promise<boolean> {
        await this.page.locator(selector).first().waitFor({ state: "visible", timeout });
        return true;
    }

    async waitForText(text: string, timeout = 15_000): Promise<boolean> {
        await this.page.getByText(text).first().waitFor({ state: "visible", timeout });
        return true;
    }

    async waitForUrl(fragment: string, timeout = 15_000): Promise<string> {
        await this.page.waitForURL((url) => url.href.includes(fragment), { timeout });
        return this.page.url();
    }

    waitForTimeout(ms: number): Promise<void> {
        return this.page.waitForTimeout(Math.min(Math.max(0, Number(ms) || 0), 60_000));
    }

    // ─── Human handoff ────────────────────────────────────────────────

    async handoff(message: string, options: { timeoutMs?: number; sessionId?: string } = {}): Promise<HandoffOutcome> {
        const session = await this.context.newCDPSession(this.page);
        const cdp: HandoffCdp = {
            sendCommand: (method, params) => session.send(method as any, params) as Promise<any>,
            on: (event, listener) => session.on(event as any, listener),
            removeEventListener: (event, listener) => session.off(event as any, listener),
            isConnected: () => true,
        };
        return await this.handoffs.request(cdp, message, {
            timeoutMs: options.timeoutMs,
            sessionId: options.sessionId,
            __hooks: this.handoffHooks ?? undefined,
        });
    }

    // ─── Screencast / recording ──────────────────────────────────────

    async startScreencast(options: any = {}): Promise<{ started: boolean; already?: boolean }> {
        if (this.castSession) return { started: true, already: true };
        const session = await this.rawCdp();
        this.castSession = session;
        this.castFrames = [];
        const listener = (params: any) => {
            this.castFrames.push(String(params.data ?? ""));
            if (this.castFrames.length > 1200) this.castFrames.shift();
            void session.send("Page.screencastFrameAck" as any, { sessionId: params.sessionId } as any).catch(() => undefined);
        };
        this.castListener = listener;
        session.on("Page.screencastFrame" as any, listener);
        await session.send(
            "Page.startScreencast" as any,
            {
                format: options.format ?? "jpeg",
                quality: Math.max(10, Math.min(Number(options.quality ?? 50), 90)),
                maxWidth: Number(options.maxWidth ?? 1280),
                maxHeight: Number(options.maxHeight ?? 800),
                everyNthFrame: Math.max(1, Number(options.everyNthFrame ?? 1)),
            } as any
        );
        return { started: true };
    }

    async stopScreencast(): Promise<{ stopped: boolean; frames: number }> {
        const session = this.castSession;
        if (!session) return { stopped: false, frames: 0 };
        if (this.castListener) session.off("Page.screencastFrame" as any, this.castListener);
        await session.send("Page.stopScreencast" as any, {} as any).catch(() => undefined);
        this.castSession = null;
        this.castListener = null;
        return { stopped: true, frames: this.castFrames.length };
    }

    getScreencastFrames(maxFrames = 10): string[] {
        return this.castFrames.slice(-Math.max(1, maxFrames));
    }

    async sampleFrames(options: any = {}): Promise<{ frameCount: number; duration: number; timestamps: string[]; frames: string[] }> {
        const duration = Math.max(250, Math.min(Number(options.duration ?? 1500), 30_000));
        const maxFrames = Math.max(1, Math.min(Number(options.maxFrames ?? 4), 24));
        const wasRunning = !!this.castSession;
        if (!wasRunning) await this.startScreencast(options);
        const started = Date.now();
        await this.waitForTimeout(duration);
        if (!wasRunning) await this.stopScreencast();
        const frames = this.getScreencastFrames(maxFrames);
        return {
            frameCount: frames.length,
            duration: Date.now() - started,
            timestamps: frames.map(() => new Date().toISOString()),
            frames,
        };
    }

    async recordSession(options: any = {}): Promise<{
        frameCount: number;
        duration: number;
        path?: string;
        encoded: boolean;
        frames: string[];
    }> {
        const duration = Math.max(250, Math.min(Number(options.duration ?? 5000), 10 * 60_000));
        const wasRunning = !!this.castSession;
        if (!wasRunning) await this.startScreencast(options);
        const started = Date.now();
        await this.waitForTimeout(duration);
        if (!wasRunning) await this.stopScreencast();

        const frames = this.castFrames.slice();
        let encoded = false;
        if (options.path) {
            const fps = Math.max(1, Math.min(Number(options.fps ?? Math.round(frames.length / Math.max(1, duration / 1000))), 60));
            encoded = await this.encodeJpegFrames(frames, String(options.path), fps);
        }
        return { frameCount: frames.length, duration: Date.now() - started, path: options.path, encoded, frames };
    }

    private async encodeJpegFrames(frames: string[], outputPath: string, fps: number): Promise<boolean> {
        if (!frames.length || !hasFfmpeg()) return false;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aether-cast-"));
        try {
            for (let index = 0; index < frames.length; index++) {
                const file = path.join(directory, `frame-${String(index).padStart(5, "0")}.jpg`);
                await fs.writeFile(file, Buffer.from(frames[index], "base64"));
            }
            await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
            const codec = path.extname(outputPath).toLowerCase() === ".webm"
                ? ["-c:v", "libvpx-vp9", "-b:v", "1M"]
                : ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
            return await new Promise<boolean>((resolve) => {
                const child = spawn(
                    "ffmpeg",
                    ["-y", "-framerate", String(fps), "-i", path.join(directory, "frame-%05d.jpg"), ...codec, outputPath],
                    { stdio: "ignore" }
                );
                child.on("close", (code) => resolve(code === 0));
                child.on("error", () => resolve(false));
            });
        } finally {
            await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    // ─── Tracing ─────────────────────────────────────────────────────

    async startTracing(options: any = {}): Promise<{ started: boolean; already?: boolean }> {
        if (this.traceSession) return { started: true, already: true };
        const session = await this.rawCdp();
        this.traceSession = session;
        this.traceEvents = [];
        const listener = (params: any) => {
            if (Array.isArray(params?.value)) this.traceEvents.push(...params.value);
        };
        this.traceListener = listener;
        session.on("Tracing.dataCollected" as any, listener);
        await session.send(
            "Tracing.start" as any,
            { categories: options.categories ?? "-*", transferMode: "ReportEvents" } as any
        );
        return { started: true };
    }

    async stopTracing(options: any = {}): Promise<{ events: number; path?: string }> {
        const session = this.traceSession;
        if (!session) throw new Error("No trace is running. Call start_tracing first.");
        const complete = new Promise<void>((resolve) => {
            session.on("Tracing.tracingComplete" as any, () => resolve());
        });
        await session.send("Tracing.end" as any, {} as any);
        await Promise.race([complete, this.waitForTimeout(30_000)]);
        if (this.traceListener) session.off("Tracing.dataCollected" as any, this.traceListener);
        this.traceSession = null;
        this.traceListener = null;

        if (options.path) {
            const resolved = path.resolve(String(options.path));
            await fs.mkdir(path.dirname(resolved), { recursive: true });
            await fs.writeFile(resolved, JSON.stringify({ traceEvents: this.traceEvents }, null, 2), "utf8");
            return { events: this.traceEvents.length, path: resolved };
        }
        return { events: this.traceEvents.length };
    }

    // ─── HAR capture ─────────────────────────────────────────────────

    async startNetworkCapture(): Promise<{ active: boolean; entries: number }> {
        if (!this.capture) this.capture = new NetworkCapture(this.page, getSecretStore());
        await getSecretStore().load();
        this.capture.start();
        return this.capture.status();
    }

    async stopNetworkCapture(outputPath?: string): Promise<{ entries: number; path?: string }> {
        if (!this.capture) return { entries: 0 };
        return await this.capture.stop(outputPath);
    }

    networkCaptureStatus(): { active: boolean; entries: number } {
        return this.capture?.status() ?? { active: false, entries: 0 };
    }

    networkTraffic(limit = 50): any[] {
        return this.capture?.list(limit) ?? [];
    }

    // ─── Playwright objects for execute ───────────────────────────────

    pageApi(): Record<string, unknown> {
        const page = this.page;
        return new Proxy(page as any, {
            get: (target, property) => {
                if (property === "cdp") {
                    return async (method: string, params?: Record<string, unknown>) => {
                        const session = await this.context.newCDPSession(page);
                        return await session.send(method as any, params ?? {});
                    };
                }
                const value = (target as any)[property];
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as unknown as Record<string, unknown>;
    }

    contextApi(): Record<string, unknown> {
        return this.context as unknown as Record<string, unknown>;
    }

    browserApi(): Record<string, unknown> {
        return this.browser as unknown as Record<string, unknown>;
    }

    rawCdp(): Promise<import("patchright-core").CDPSession> {
        return this.context.newCDPSession(this.page);
    }
}

const hostCache = new Map<string, PageHost>();

/** Reuse one host per browser + target, so console/network history survives calls. */
export function getOrCreatePageHost(key: string, create: () => PageHost): PageHost {
    const existing = hostCache.get(key);
    if (existing) return existing;
    const host = create();
    hostCache.set(key, host);
    return host;
}

export function clearPageHosts(): void {
    hostCache.clear();
    hostInstance = null;
}

/** The page host for the call in progress. */
export function setActivePageHost(host: PageHost | null): void {
    hostInstance = host;
}

export function getPageHost(): PageHost {
    if (!hostInstance) {
        throw new Error('No page is active. Call browser {action:"extension"} or browser {action:"launch"} first.');
    }
    return hostInstance;
}
