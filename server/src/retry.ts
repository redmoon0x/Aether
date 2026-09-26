/**
 * Bounded retry helpers for the action layer.
 *
 * Most single-shot action failures on a React-heavy page are timing, not dead
 * ends: a lazy image finishes loading and shifts layout, a hydration pass
 * replaces the node, a virtualized feed recycles rows. Retrying a small number
 * of times with jittered backoff recovers those without changing the semantics
 * of the action itself.
 *
 * The rule this module enforces: only *transient* errors are retried. Hard
 * errors (CDP disconnected, command timeout, bad arguments) fail immediately,
 * because retrying them just multiplies the latency of a failure the caller is
 * going to see anyway.
 */

/**
 * An element-level failure that is worth retrying: the target was not in a
 * clickable state this time round (missing from layout, hidden, offscreen, or
 * covered by an overlay).
 */
export class ActionabilityError extends Error {
    readonly reason: string;

    constructor(message: string, reason: string = "actionability") {
        super(message);
        this.name = "ActionabilityError";
        this.reason = reason;
    }
}

/** Hard failures that retrying cannot fix. */
const NON_RETRYABLE = [
    /CDP not connected/i,
    /timed out after/i,
    /CDP command/i,
    /not connected\. Call connect\(\)/i,
    /Selector required/i,
    /required for /i,
];

/**
 * Transient failure signatures, matched against the error message. Kept
 * deliberately narrow: a false positive here turns a real error into three
 * times the latency plus a confusing final message.
 */
const RETRYABLE = [
    /not found or not visible/i,
    /element not found/i,
    /element with text not found/i,
    /no matching visible element/i,
    /not_visible|not_visible|obscured|offscreen/i,
    /does not belong to the document/i,
    /execution context was destroyed/i,
    /cannot find context/i,
    /target closed/i,
    /node with given id/i,
    /stale element/i,
];

/**
 * Default retry predicate. Returns false for hard errors, true for
 * {@link ActionabilityError}, and otherwise falls back to message matching.
 */
export function isRetryableError(error: unknown): boolean {
    if (error instanceof ActionabilityError) return true;

    const message =
        error instanceof Error ? error.message : String((error as any)?.message ?? error ?? "");
    if (!message) return false;

    if (NON_RETRYABLE.some((pattern) => pattern.test(message))) return false;
    return RETRYABLE.some((pattern) => pattern.test(message));
}

export interface RetryOptions {
    /** Total attempts including the first. Default 3. */
    attempts?: number;
    /** Delay before the first retry. Default 150ms. */
    baseDelayMs?: number;
    /** Upper bound on any single delay. Default 400ms. */
    maxDelayMs?: number;
    /** Random extra delay added per attempt, to avoid lockstep retries. Default 100ms. */
    jitterMs?: number;
    /** Label used in retry log lines. */
    label?: string;
    /** Override the retry decision entirely. */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    /** Observer invoked before each retry. */
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
    /** Injected for tests. */
    sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient failures with jittered backoff.
 *
 * Resolves with the first successful result. If every attempt fails, the error
 * from the *last* attempt is thrown, annotated with the attempt count so the
 * caller can tell a retried-then-failed action from an immediate one.
 */
export async function retryAsync<T>(
    fn: (attempt: number) => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const {
        attempts = 3,
        baseDelayMs = 150,
        maxDelayMs = 400,
        jitterMs = 100,
        label,
        shouldRetry = isRetryableError,
        onRetry,
        sleep = defaultSleep,
    } = options;

    const total = Math.max(1, Math.floor(attempts));
    let lastError: unknown;

    for (let attempt = 1; attempt <= total; attempt++) {
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;

            const isLast = attempt === total;
            if (isLast || !shouldRetry(error, attempt)) break;

            // Jittered backoff, capped. Grows slowly so a re-render gets a few
            // chances without the action becoming slow in the common case.
            const backoff = Math.min(maxDelayMs, baseDelayMs * attempt);
            const delay = backoff + Math.floor(Math.random() * Math.max(1, jitterMs));

            onRetry?.(error, attempt, delay);
            if (label) {
                console.error(
                    `[Retry] ${label}: attempt ${attempt}/${total} failed ` +
                    `(${(error as Error)?.message ?? String(error)}), retrying in ${delay}ms`
                );
            }
            await sleep(delay);
        }
    }

    if (lastError instanceof Error && total > 1) {
        lastError.message = `${lastError.message} (after ${total} attempts)`;
    }
    throw lastError;
}
