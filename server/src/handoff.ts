/**
 * Human-in-the-loop handoff.
 *
 * Some steps can only be done by a person: a password, a 2FA code, a passkey
 * prompt, a payment confirmation, an interactive bot check. Instead of guessing
 * (or trying to solve the challenge), the agent registers a handoff, the page
 * shows a small "Continue" card, and the call resumes when the user clicks it.
 *
 * The card and its binding live in an isolated JavaScript world, and the
 * binding is restricted to that world's name. Page script cannot see the card's
 * controls (closed shadow root) and cannot invoke the completion binding, so a
 * prompt-injected page cannot fake a human click.
 */
import { randomUUID } from "crypto";

/**
 * The small slice of a CDP connection the handoff card needs. A Playwright
 * CDPSession satisfies it via the adapter in page.ts.
 */
export interface HandoffCdp {
    sendCommand(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
    on(event: string, listener: (params: any) => void): void;
    removeEventListener(event: string, listener: (params: any) => void): void;
    isConnected(): boolean;
}

export type HandoffStatus = "completed" | "timeout" | "cancelled";

export interface HandoffOutcome {
    status: HandoffStatus;
    id: string;
    message: string;
    waitedMs: number;
    /** How many times the card was re-armed after the page navigated. */
    rearmed: number;
}

export interface HandoffOptions {
    /** How long to wait for the user. Default 10 minutes. */
    timeoutMs?: number;
    /** Session id, recorded on the outcome only. */
    sessionId?: string;
    /** Internal: lets a caller pause its own timeout budget while the user decides. */
    __hooks?: HandoffHooks;
}

export interface HandoffHooks {
    start?: () => void;
    end?: () => void;
}

const BINDING = "__aetherHandoffComplete";
const WORLD = "__aether_handoff";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_REARMS = 3;

interface PendingHandoff {
    id: string;
    message: string;
    startedAt: number;
    rearmed: number;
    client: HandoffCdp;
    resolve: (outcome: HandoffOutcome) => void;
    timer: NodeJS.Timeout | null;
    bindingListener: (params: any) => void;
    navigationListener: (params: any) => void;
    hooks: HandoffHooks;
}

/**
 * The card. Rendered inside a closed shadow root so the page's own CSS and
 * script cannot reach or restyle it. `AETHER_HANDOFF` is substituted with the
 * id + message payload, and `AETHER_BINDING` with the binding name.
 */
function cardScript(id: string, message: string): string {
    const payload = JSON.stringify({ id, message });
    return `(function () {
    const HOST_ID = "__aether-handoff-" + ${JSON.stringify(id)};
    const payload = ${payload};
    const existing = document.getElementById(HOST_ID);
    if (existing) return { reused: true, id: payload.id };

    const host = document.createElement("div");
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: "closed" });

    const wrap = document.createElement("div");
    wrap.setAttribute("style", [
        "position:fixed", "left:50%", "bottom:24px", "transform:translateX(-50%)",
        "z-index:2147483647", "max-width:min(520px,calc(100vw - 32px))",
        "font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif",
        "background:#111827", "color:#f9fafb", "border:1px solid #374151",
        "border-radius:12px", "padding:14px 16px",
        "box-shadow:0 12px 32px rgba(0,0,0,.35)", "display:flex",
        "align-items:center", "gap:14px", "pointer-events:auto"
    ].join(";"));

    const text = document.createElement("div");
    text.textContent = payload.message;
    text.setAttribute("style", "flex:1 1 auto;white-space:pre-wrap");

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Continue";
    button.setAttribute("style", [
        "flex:0 0 auto", "appearance:none", "border:0", "border-radius:8px",
        "background:#22c55e", "color:#052e16", "font:600 13px system-ui,sans-serif",
        "padding:8px 14px", "cursor:pointer"
    ].join(";"));
    button.addEventListener("click", function () {
        try {
            const binding = globalThis[${JSON.stringify(BINDING)}];
            if (typeof binding === "function") binding(JSON.stringify({ id: payload.id }));
        } catch (e) { /* the wait will time out instead */ }
        host.remove();
    });

    wrap.appendChild(text);
    wrap.appendChild(button);
    root.appendChild(wrap);
    document.documentElement.appendChild(host);
    return { reused: false, id: payload.id };
})()`;
}

function removeCardScript(id: string): string {
    return `(function () {
    const el = document.getElementById("__aether-handoff-" + ${JSON.stringify(id)});
    if (el) el.remove();
    return true;
})()`;
}

export class HandoffRegistry {
    private pending: PendingHandoff | null = null;

    /** The handoff currently waiting on a human, if any. */
    active(): { id: string; message: string; waitingMs: number } | null {
        if (!this.pending) return null;
        return {
            id: this.pending.id,
            message: this.pending.message,
            waitingMs: Date.now() - this.pending.startedAt,
        };
    }

    /**
     * Ask the user to do something in the page and wait for them.
     *
     * The page shows a card with the message and a Continue button. Resolves
     * `completed` when the user clicks it, `timeout` after `timeoutMs`, or
     * `cancelled` when the browser detaches.
     *
     * A `completed` outcome is not proof the task finished: assert the expected
     * URL or element afterwards.
     */
    async request(client: HandoffCdp, message: string, options: HandoffOptions = {}): Promise<HandoffOutcome> {
        if (!message || !message.trim()) throw new Error("handoff requires a message describing what the user should do");
        if (!client.isConnected()) throw new Error("Cannot hand off: the browser is not connected.");

        const hooks = options.__hooks ?? {};
        // One handoff at a time: a second request supersedes the first, whose
        // waiter is told it was cancelled rather than left hanging.
        if (this.pending) this.finish("cancelled", "superseded by a newer handoff");

        const id = randomUUID();
        // A caller may want a short probe of whether anyone is there; only a
        // floor of one second keeps the card from flashing past unread.
        const timeoutMs = Math.max(1_000, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
        const startedAt = Date.now();

        return await new Promise<HandoffOutcome>((resolve) => {
            const pending: PendingHandoff = {
                id,
                message,
                startedAt,
                rearmed: 0,
                client,
                resolve,
                timer: null,
                bindingListener: () => {},
                navigationListener: () => {},
                hooks,
            };

            pending.bindingListener = (params: any) => {
                if (params?.name !== BINDING) return;
                let payload: any = null;
                try {
                    payload = JSON.parse(String(params.payload ?? "{}"));
                } catch {
                    return;
                }
                if (payload?.id !== pending.id) return;
                this.finish("completed");
            };

            pending.navigationListener = (params: any) => {
                if (params?.frame?.parentId) return;
                if (this.pending !== pending || pending.rearmed >= MAX_REARMS) return;
                pending.rearmed++;
                // The document (and its isolated world) was replaced; rebuild it
                // so the user still has something to click on the new page.
                void this.arm(pending).catch(() => {});
            };

            client.on("Runtime.bindingCalled", pending.bindingListener);
            client.on("Page.frameNavigated", pending.navigationListener);

            pending.timer = setTimeout(() => this.finish("timeout"), timeoutMs);
            this.pending = pending;
            hooks.start?.();

            void this.arm(pending).catch((error: any) => {
                this.finish("cancelled", `could not show the handoff card: ${error?.message ?? error}`);
            });
        });
    }

    /** Create the isolated world, restricted binding and card for a pending handoff. */
    private async arm(pending: PendingHandoff): Promise<void> {
        const { client } = pending;
        await client.sendCommand("Page.enable").catch(() => {});
        await client.sendCommand("Runtime.enable").catch(() => {});

        const tree = await client.sendCommand("Page.getFrameTree", {});
        const frameId = tree?.frameTree?.frame?.id;
        if (!frameId) throw new Error("no main frame to show the card in");

        const world = await client.sendCommand("Page.createIsolatedWorld", {
            frameId,
            worldName: WORLD,
            grantUniveralAccess: true,
        });
        const contextId = world?.executionContextId;

        // Restricting the binding to the isolated world means page script has no
        // handle to call it, even if it finds the name.
        await client
            .sendCommand("Runtime.addBinding", { name: BINDING, executionContextName: WORLD })
            .catch(() => {});

        await client.sendCommand(
            "Runtime.evaluate",
            {
                expression: cardScript(pending.id, pending.message),
                ...(contextId ? { contextId } : {}),
                returnByValue: true,
            },
            Math.min(10_000, Math.max(2_000, Date.now() - pending.startedAt))
        );
    }

    /** Resolve the pending handoff and tear down everything it created. */
    private finish(status: HandoffStatus, note?: string): void {
        const pending = this.pending;
        if (!pending) return;
        this.pending = null;

        if (pending.timer) clearTimeout(pending.timer);
        pending.client.removeEventListener("Runtime.bindingCalled", pending.bindingListener);
        pending.client.removeEventListener("Page.frameNavigated", pending.navigationListener);

        const client = pending.client;
        void client
            .sendCommand("Runtime.evaluate", {
                expression: removeCardScript(pending.id),
                returnByValue: true,
            })
            .catch(() => {})
            .then(() => {
                // A newer handoff may have started in the meantime and already
                // installed its own binding; removing it here would strand it.
                if (this.pending) return;
                return client.sendCommand("Runtime.removeBinding", { name: BINDING });
            })
            .catch(() => {});

        pending.hooks.end?.();

        pending.resolve({
            status,
            id: pending.id,
            message: note ? `${pending.message} (${note})` : pending.message,
            waitedMs: Date.now() - pending.startedAt,
            rearmed: pending.rearmed,
        });
    }

    /** Drop any pending handoff, e.g. on shutdown. */
    cancelAll(reason: string = "shutdown"): void {
        if (!this.pending) return;
        this.finish("cancelled", reason);
    }
}

let registry: HandoffRegistry | null = null;

export function getHandoffRegistry(): HandoffRegistry {
    if (!registry) registry = new HandoffRegistry();
    return registry;
}
