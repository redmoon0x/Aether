import { CdpClient, CDP_POLL_TIMEOUT_MS } from "./cdp-client";

/**
 * Relative score margin below which two candidates are considered a tie.
 * Scoring is heuristic and unbounded, so this is expressed as a ratio of the
 * leading candidate's score rather than an absolute delta.
 */
const AMBIGUITY_MARGIN_RATIO = 0.15;

export interface LocatorCandidate {
    ref: string;
    selector: string;
    xpath: string;
    scope: "document" | "shadow" | "frame";
    framePath: number[];
    shadowDepth: number;
    tag: string;
    role: string;
    type: string;
    name: string;
    text: string;
    label: string;
    placeholder: string;
    title: string;
    value: string;
    score: number;
    matchedBy: string;
    bounds: { x: number; y: number; width: number; height: number };
}

export interface LocatorQuery {
    target?: string;
    text?: string;
    role?: string;
    selector?: string;
    timeout?: number;
    visible?: boolean;
    includeCandidates?: boolean;
    maxCandidates?: number;
}

export interface LocatorResult {
    success: boolean;
    target?: string;
    selector?: string;
    ref?: string;
    matchedBy?: string;
    confidence?: number;
    candidate?: LocatorCandidate;
    candidates?: LocatorCandidate[];
    message?: string;
    /**
     * True when the runner-up scored within {@link AMBIGUITY_MARGIN_RATIO} of
     * the winner. The best candidate is still returned, but the caller should
     * tell the model the match was a near-tie so it can disambiguate rather
     * than silently clicking the wrong one of two similar elements.
     */
    ambiguous?: boolean;
    /** Human-readable description of the near-tie, present when `ambiguous`. */
    ambiguityWarning?: string;
}

const DEFAULT_TIMEOUT = 7000;

export class LocatorEngine {
    constructor(private readonly client: CdpClient) {}

    async list(maxElements: number = 50, includeText: boolean = true, withOverlay: boolean = false): Promise<LocatorCandidate[]> {
        const capped = Math.max(0, Math.min(Number(maxElements || 50), 200));
        const result = await this.client.evaluate(
            `window.__aetherLocate(${JSON.stringify(JSON.stringify({
                target: "", role: "", selector: "",
                maxCandidates: capped, includeText, mode: "list",
            }))})`
        );
        const parsed = safeJsonParse(result);
        const candidates = normalizeCandidates(parsed?.candidates).slice(0, capped);
        if (withOverlay && candidates.length > 0) {
            await this.client.getInteractiveElements(true).catch(() => ({ elements: [], somInjected: false }));
        }
        return candidates;
    }

    async resolve(query: LocatorQuery): Promise<LocatorResult> {
        const target = String(query.target ?? query.text ?? "").trim();
        const role = query.role ? String(query.role).toLowerCase() : "";
        const selector = query.selector ? String(query.selector).trim() : "";
        const timeout = query.timeout ?? DEFAULT_TIMEOUT;
        const maxCandidates = Math.max(1, Math.min(Number(query.maxCandidates ?? 20), 50));
        const started = Date.now();

        if (!target && !role && !selector) {
            return { success: false, message: "target, role, or selector required" };
        }

        while (Date.now() - started < timeout) {
            // Bounded per-poll timeout: a hung Runtime.evaluate must not stall
            // the loop for the full 30s default on every iteration.
            const remaining = Math.max(1, timeout - (Date.now() - started));
            const resultJson = await this.client.evaluate(
                `window.__aetherLocate(${JSON.stringify(JSON.stringify({
                    target, role, selector: selector,
                    maxCandidates, includeText: true, mode: "resolve",
                }))})`,
                Math.min(CDP_POLL_TIMEOUT_MS, remaining)
            ).catch((error: any) => ({ error: error.message }));
            const result = safeJsonParse(resultJson);

            const candidates = normalizeCandidates(result?.candidates);
            const best = candidates[0];
            if (best && (selector || best.score > 0 || role)) {
                const { ambiguous, ambiguityWarning } = describeAmbiguity(best, candidates[1]);
                return {
                    success: true,
                    target,
                    selector: best.selector,
                    ref: best.ref,
                    matchedBy: best.matchedBy,
                    confidence: Math.min(1, Math.max(0.1, best.score / 18)),
                    candidate: best,
                    candidates: query.includeCandidates ? candidates.slice(0, maxCandidates) : undefined,
                    ambiguous,
                    ambiguityWarning,
                };
            }

            await sleep(150);
        }

        return { success: false, target, message: "No matching visible element found" };
    }

    async click(candidate: LocatorCandidate, button?: "left" | "middle" | "right"): Promise<void> {
        const x = candidate.bounds.x + candidate.bounds.width / 2;
        const y = candidate.bounds.y + candidate.bounds.height / 2;
        await this.client.click(x, y, button, candidate.bounds.width);
    }

    async focusAndClear(candidate: LocatorCandidate): Promise<boolean> {
        await this.click(candidate);
        await this.client.pressKey("a", ["Ctrl"]).catch(() => {});
        await this.client.pressKey("Backspace").catch(() => {});
        return true;
    }
}

function normalizeCandidates(value: unknown): LocatorCandidate[] {
    if (!Array.isArray(value)) return [];
    return value.filter(Boolean) as LocatorCandidate[];
}

/**
 * Detect a near-tie between the winning candidate and the runner-up.
 *
 * Scoring in the injected collector is heuristic, so an exact tie is rare but a
 * near-tie is common and is where silent wrong-clicks come from (two "Reply"
 * buttons on a comment thread, a "Submit" in both a modal and the page behind
 * it). Rather than block on an elicitation round-trip, flag it and let the
 * caller disambiguate with more context.
 */
function describeAmbiguity(
    best?: LocatorCandidate,
    runnerUp?: LocatorCandidate
): { ambiguous?: boolean; ambiguityWarning?: string } {
    if (!best || !runnerUp) return {};
    if (best.score <= 0) return {};

    const ratio = runnerUp.score / best.score;
    // ratio near 1 means the two scored almost identically, which is the
    // ambiguous case. An exact tie (ratio === 1) is the most ambiguous of all.
    if (ratio < 1 - AMBIGUITY_MARGIN_RATIO) return {};

    const label = (c: LocatorCandidate) => {
        const text = (c.text || c.name || "").trim().replace(/\s+/g, " ").slice(0, 40);
        return `<${c.tag}> "${text}" score ${c.score}`;
    };

    return {
        ambiguous: true,
        ambiguityWarning:
            `Ambiguous match: the top two candidates scored within ` +
            `${Math.round((1 - ratio) * 100)}% of each other (${label(best)} vs ${label(runnerUp)}). ` +
            `Proceeding with the highest-scoring one, but verify you meant this element ` +
            `before relying on the result.`,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(value: unknown): any {
    if (typeof value === "string") {
        try { return JSON.parse(value); } catch { return null; }
    }
    return value;
}
