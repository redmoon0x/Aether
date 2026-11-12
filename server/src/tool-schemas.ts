/**
 * Tool metadata: behavior hints and output schemas.
 *
 * Annotations let a client gate a tool call without guessing from prose:
 * `readOnlyHint` on the inspection tools, `destructiveHint` on anything that
 * changes the page or the browser, `openWorldHint` on anything that reaches the
 * network. Output schemas are declared only for tools whose result shape is
 * fixed, so `structuredContent` actually validates.
 */
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

const read = (openWorld = true): ToolAnnotations => ({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: openWorld,
});

const write = (options: { idempotent?: boolean; openWorld?: boolean } = {}): ToolAnnotations => ({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: options.idempotent ?? false,
    openWorldHint: options.openWorld ?? true,
});

const local = (idempotent = true): ToolAnnotations => ({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: idempotent,
    openWorldHint: false,
});

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
    execute: write(),
    snapshot: read(),
    act: write(),
    handoff: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    sessions: local(),
    // Includes `kill`, but the default action only reads status; the destructive
    // variant is named explicitly in the description.
    browser: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    diagnostics: read(),
    get_page_text: read(),
    captcha: write(),
    memory: local(),
    skill: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    secrets: local(false),
    cdp_command: write(),
};

const bounds = {
    type: "object",
    properties: {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
    },
    required: ["x", "y", "width", "height"],
} as const;

const snapshotElement = {
    type: "object",
    properties: {
        ref: { type: "string" },
        tag: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        text: { type: "string" },
        selector: { type: "string" },
        type: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        bounds,
    },
    required: ["ref", "tag", "role", "name", "text", "selector", "bounds"],
} as const;

export const OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
    snapshot: {
        type: "object",
        properties: {
            title: { type: "string" },
            url: { type: "string" },
            readyState: { type: "string" },
            elementCount: { type: "number" },
            elements: { type: "array", items: snapshotElement },
            outline: { type: "string" },
            cache: {
                type: "object",
                properties: {
                    hit: { type: "boolean" },
                    version: { type: "number" },
                    ageMs: { type: "number" },
                },
                required: ["hit", "version", "ageMs"],
            },
        },
        required: ["title", "url", "readyState", "elementCount", "elements", "outline", "cache"],
    },
    handoff: {
        type: "object",
        properties: {
            status: { type: "string", enum: ["completed", "timeout", "cancelled"] },
            id: { type: "string" },
            message: { type: "string" },
            waitedMs: { type: "number" },
            rearmed: { type: "number" },
        },
        required: ["status", "id", "message", "waitedMs", "rearmed"],
    },
};
