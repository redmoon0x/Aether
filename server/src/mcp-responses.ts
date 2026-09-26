export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; data: string; mimeType: string };
export type ContentPart = TextPart | ImagePart;

export function textContent(text: string): { content: TextPart[] } {
    return { content: [{ type: "text", text }] };
}

export function jsonContent(value: unknown, pretty: boolean = false): { content: TextPart[] } {
    return textContent(JSON.stringify(value, null, pretty ? 2 : 0));
}

export function toolError(error: any): { content: TextPart[]; isError: true } {
    if (error?.captcha) {
        return { content: [{ type: "text", text: JSON.stringify(error.captcha) }], isError: true };
    }
    if (error?.message?.includes("not connected") || error?.message?.includes("No active extension")) {
        return { content: [{ type: "text", text: "Browser not connected. Use 'connect_browser' tool first to connect or launch Chrome." }], isError: true };
    }
    return { content: [{ type: "text", text: `Error: ${error?.message || String(error)}` }], isError: true };
}

// ==================== Image content ====================
//
// A base64 payload inside a *text* content block is not an image to the model —
// it is an unreadable wall of characters. Screenshots have to go out as
// dedicated `image` content parts, which is what the MCP content model defines
// and what clients actually render.
//
// Several tool results carry base64 nested at varying depths (a bare string, a
// `screenshot` field, `before`/`after` pairs, an array of screencast frames).
// Rather than hand-rolling a special case per tool, detect image payloads by
// their decoded magic bytes and lift them out generically.

/** Minimum plausible length of a base64 image payload, to avoid scanning noise. */
const MIN_IMAGE_B64_CHARS = 64;

const MIME_BY_MAGIC: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
    {
        mime: "image/jpeg",
        test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    },
    {
        mime: "image/png",
        test: (b) =>
            b.length >= 8 &&
            b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
            b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
    },
    {
        mime: "image/gif",
        test: (b) => b.length >= 3 && b.toString("latin1", 0, 3) === "GIF",
    },
    {
        mime: "image/webp",
        test: (b) =>
            b.length >= 12 &&
            b.toString("latin1", 0, 4) === "RIFF" &&
            b.toString("latin1", 8, 12) === "WEBP",
    },
    {
        mime: "application/pdf",
        test: (b) => b.length >= 4 && b.toString("latin1", 0, 4) === "%PDF",
    },
];

/**
 * Identify an image/pdf payload by decoding its leading bytes.
 *
 * Deliberately magic-byte based rather than key-name based: key names like
 * `data` or `value` are far too common, and a base64-looking cookie or auth
 * token must never be mistaken for an image and stripped out of the payload.
 *
 * Handles both raw base64 and `data:<mime>;base64,` URLs, the latter being what
 * `canvas.toDataURL()` returns from `execute_script`.
 */
export function detectBinaryMime(data: unknown): string | null {
    if (typeof data !== "string") return null;

    let compact = data.replace(/\s+/g, "");

    const dataUrl = /^data:([a-z0-9.+/-]+);base64,/i.exec(compact);
    if (dataUrl) {
        compact = compact.slice(dataUrl[0].length);
        const declared = dataUrl[1].toLowerCase();
        if (MIME_BY_MAGIC.some((m) => m.mime === declared)) return declared;
    }

    if (compact.length < MIN_IMAGE_B64_CHARS) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;

    let head: Buffer;
    try {
        head = Buffer.from(compact.slice(0, 32), "base64");
    } catch {
        return null;
    }
    if (head.length < 4) return null;

    for (const entry of MIME_BY_MAGIC) {
        if (entry.test(head)) return entry.mime;
    }
    return null;
}

/** Strip a `data:...;base64,` prefix if present, leaving raw base64. */
function stripDataUrlPrefix(data: string): string {
    const m = /^data:[a-z0-9.+/-]+;base64,/i.exec(data.replace(/\s+/g, ""));
    return m ? data.replace(/\s+/g, "").slice(m[0].length) : data.replace(/\s+/g, "");
}

export function imageContent(data: string, mimeType: string = "image/jpeg"): ImagePart {
    return { type: "image", data: stripDataUrlPrefix(data), mimeType };
}

export interface SplitResult {
    /** Deep copy of the input with image payloads replaced by short placeholders. */
    value: any;
    images: ImagePart[];
    /** Images dropped because {@link maxImages} was reached. */
    truncated: number;
}

/**
 * Recursively lift image payloads out of an arbitrary result object.
 *
 * Produces a serialisable copy safe to `JSON.stringify` into a text block,
 * plus the image parts to append as proper content blocks. Each placeholder
 * records which image block it corresponds to, in order, so the text stays
 * meaningful ("before" / "after" / "frame 3") instead of silently vanishing.
 */
export function splitImages(input: unknown, maxImages: number = 12): SplitResult {
    const images: ImagePart[] = [];
    let truncated = 0;

    const walk = (node: any): any => {
        if (typeof node === "string") {
            const mime = detectBinaryMime(node);
            if (!mime) return node;
            if (images.length >= maxImages) {
                truncated++;
                return `[image omitted: ${mime} payload, limit of ${maxImages} images reached]`;
            }
            images.push(imageContent(node, mime));
            return `[image ${images.length}: ${mime}, delivered as an image content block]`;
        }

        if (Array.isArray(node)) return node.map(walk);

        if (node && typeof node === "object") {
            const out: Record<string, any> = {};
            for (const [k, v] of Object.entries(node)) out[k] = walk(v);
            return out;
        }

        return node;
    };

    const value = walk(input);
    return { value, images, truncated };
}

/**
 * Serialize a tool result to text, lifting any embedded images out into real
 * image content blocks. Use this instead of `JSON.stringify(result)` for any
 * result that may contain a screenshot, PDF, or screencast frame.
 */
export function jsonWithImages(input: unknown, pretty: boolean = true, maxImages: number = 12) {
    const { value, images, truncated } = splitImages(input, maxImages);

    let text = JSON.stringify(value, null, pretty ? 2 : 0);
    if (text === undefined) text = String(value);
    if (truncated > 0) {
        text += `\n\n(${truncated} additional image(s) omitted: max ${maxImages} images per response. ` +
            `Use sample_visual_frames with a lower maxFrames to see them.)`;
    }

    const content: ContentPart[] = [{ type: "text", text }];
    for (const img of images) content.push(img);
    return { content };
}

/**
 * Serialize a result that may be a bare base64 string (screenshot, print_pdf)
 * or a structured object.
 */
export function resultWithImages(result: unknown, pretty: boolean = true, maxImages: number = 12) {
    if (typeof result === "string") {
        const mime = detectBinaryMime(result);
        if (mime) {
            return {
                content: [
                    { type: "text", text: `Returned a ${mime} image as an image content block.` },
                    imageContent(result, mime),
                ] as ContentPart[],
            };
        }
    }
    return jsonWithImages(result, pretty, maxImages);
}
