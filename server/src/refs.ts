/**
 * Ref registry — stable, identity-checked element handles.
 *
 * A snapshot hands out short refs (`e12`) instead of raw selectors. Each ref
 * remembers what it pointed at (selector, frame, tag, role, visible text) and
 * the document epoch it was captured in. Acting on a ref re-resolves it and
 * compares the identity first, so a ref whose element was removed, renamed or
 * replaced by a navigation fails loudly instead of clicking whatever the
 * selector matches now.
 */
import type { Frame, Locator, Page } from "patchright-core";

export class StaleRefError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StaleRefError";
    }
}

export interface RefCandidate {
    selector: string;
    frameIndex: number;
    frameUrl?: string;
    tag: string;
    role: string;
    text: string;
    name: string;
    label?: string;
    placeholder?: string;
    type?: string;
    bounds: { x: number; y: number; width: number; height: number };
}

export interface RefRecord extends RefCandidate {
    ref: string;
    epoch: number;
    url: string;
    capturedAt: number;
}

export type RefElement = RefCandidate & { ref: string };

function normalize(value: unknown): string {
    return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export class RefRegistry {
    private epoch = 0;
    private url = "";
    private readonly refs = new Map<string, RefRecord>();
    private readonly stableIds = new Map<string, string>();
    private nextId = 1;

    constructor(private readonly page: Page) {}

    /** Invalidate every ref. Call after a main-frame navigation or tab switch. */
    bumpEpoch(): void {
        this.epoch++;
        this.stableIds.clear();
        // Records are kept: the next resolve uses them to explain *why* the ref
        // is stale instead of reporting an unknown ref.
    }

    getEpoch(): number {
        return this.epoch;
    }

    get(ref: string): RefRecord | undefined {
        return this.refs.get(ref);
    }

    list(): RefRecord[] {
        return [...this.refs.values()];
    }

    capture(candidates: RefCandidate[], url: string): RefElement[] {
        this.url = url;

        for (const [ref, record] of this.refs) {
            if (record.epoch !== this.epoch) this.refs.delete(ref);
        }

        const occurrences = new Map<string, number>();
        return candidates.map((candidate) => {
            const base = [
                candidate.frameIndex,
                candidate.selector,
                candidate.tag,
                candidate.role,
                normalize(candidate.text || candidate.name).slice(0, 60),
            ].join("|");
            const seen = (occurrences.get(base) ?? 0) + 1;
            occurrences.set(base, seen);
            const stableKey = seen > 1 ? `${base}#${seen}` : base;

            let ref = this.stableIds.get(stableKey);
            if (!ref) {
                ref = `e${this.nextId++}`;
                this.stableIds.set(stableKey, ref);
            }

            this.refs.set(ref, {
                ...candidate,
                ref,
                epoch: this.epoch,
                url,
                capturedAt: Date.now(),
            });

            return { ...candidate, ref };
        });
    }

    private describe(record: RefRecord): string {
        const label = normalize(record.text || record.name).slice(0, 40);
        return label ? `<${record.tag}> "${label}"` : `<${record.tag}>`;
    }

    private frameFor(index: number): Frame {
        return this.page.frames()[index] ?? this.page.mainFrame();
    }

    async resolve(ref: string): Promise<{ record: RefRecord; locator: Locator; frame: Frame }> {
        const record = this.refs.get(ref);
        if (!record) {
            throw new StaleRefError(
                `Ref ${ref} is not from this page's latest snapshot (refs are per-snapshot). Call snapshot() to get current refs.`
            );
        }

        if (record.epoch !== this.epoch) {
            throw new StaleRefError(
                `Ref ${ref} (${this.describe(record)}) is stale: the document changed after it was captured ` +
                    `(captured on ${record.url || "an unknown page"}). Call snapshot() again before acting.`
            );
        }

        // Prefer the frame's URL so a changed frame order does not point a ref
        // at the wrong document; fall back to the captured index.
        const frame =
            (record.frameUrl ? this.page.frames().find((candidate) => candidate.url() === record.frameUrl) : undefined) ??
            this.frameFor(record.frameIndex);
        const locator = frame.locator(record.selector).first();
        const count = await locator.count().catch(() => 0);
        if (count === 0) {
            throw new StaleRefError(
                `Ref ${ref} (${this.describe(record)}) is no longer on the page: it was removed, hidden or re-rendered. ` +
                    `Call snapshot() again.`
            );
        }

        const info = await locator
            .evaluate((element) => {
                const html = element as HTMLElement;
                return {
                    tag: element.tagName.toLowerCase(),
                    text: (html.innerText || element.textContent || "").trim().slice(0, 200),
                    role: element.getAttribute("role") || "",
                };
            })
            .catch(() => null);

        if (!info) {
            throw new StaleRefError(
                `Ref ${ref} (${this.describe(record)}) could not be inspected: it may be detached. Call snapshot() again.`
            );
        }

        if (info.tag !== record.tag) {
            throw new StaleRefError(
                `Ref ${ref} changed: it was ${this.describe(record)} but now resolves to <${info.tag}>. Call snapshot() again.`
            );
        }

        const before = normalize(record.text || record.name);
        const after = normalize(info.text);
        if (before && after && before !== after && !after.includes(before) && !before.includes(after)) {
            throw new StaleRefError(
                `Ref ${ref} no longer labels the same control: it was <${record.tag}> "${before.slice(0, 40)}" ` +
                    `but now reads "${after.slice(0, 40)}". Call snapshot() again.`
            );
        }

        record.epoch = this.epoch;
        record.url = this.url;
        if (info.text) record.text = info.text;

        return { record, locator, frame };
    }
}
