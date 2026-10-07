import { WebSocketServer, WebSocket } from "ws";
import http from "http";

export let activeConnection: WebSocket | null = null;
let messageIdCounter = 0;
const pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
const eventListeners = new Set<(method: string, params: any) => void>();

/** True when the local browser extension has an open WebSocket connection. */
export function isExtensionConnected(): boolean {
    return activeConnection?.readyState === WebSocket.OPEN;
}

/** Subscribe to Chrome DevTools events forwarded by the extension. */
export function onExtensionEvent(listener: (method: string, params: any) => void): () => void {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
}

/**
 * Ensure port is available by killing any stale server
 */
export async function ensurePortAvailable(port: number): Promise<void> {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/shutdown`, (res) => {
            console.error(`[WS] Sent shutdown to existing server on port ${port}`);
            setTimeout(resolve, 1500);
        });
        req.on("error", () => {
            resolve();
        });
        req.setTimeout(2000, () => {
            req.destroy();
            resolve();
        });
    });
}

export function StartWebSocketServer(port: number) {
    let retryCount = 0;
    const MAX_RETRIES = 3;

    const server = http.createServer((req, res) => {
        if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                status: "ok",
                connected: activeConnection !== null,
                pid: process.pid,
            }));
        } else if (req.url === "/shutdown") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("shutting down");
            console.error("[WS] Received shutdown request. Exiting...");
            setTimeout(() => process.exit(0), 500);
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    const wss = new WebSocketServer({ server });

    server.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
            if (retryCount >= MAX_RETRIES) {
                console.error(`[WS] Port ${port} in use. Max retries reached. Exiting.`);
                process.exit(1);
            }
            retryCount++;
            console.error(`[WS] Port ${port} in use. Retry ${retryCount}/${MAX_RETRIES} after 2s...`);
            setTimeout(() => {
                server.close();
                StartWebSocketServer(port);
            }, 2000);
        } else {
            console.error("[WS] Server error:", err.message);
        }
    });

    server.listen(port, () => {
        console.error(`[WS] HTTP/WebSocket Server listening on port ${port}`);
        retryCount = 0; // Reset on success
    });

    wss.on("connection", (ws) => {
        console.error("[WS] Extension connected");
        activeConnection = ws;

        ws.on("message", (data) => {
            try {
                const message = JSON.parse(data.toString());
                if (message.id !== undefined && pendingRequests.has(message.id)) {
                    const { resolve, reject } = pendingRequests.get(message.id)!;
                    if (message.error) {
                        reject(new Error(message.error));
                    } else {
                        resolve(message.result);
                    }
                    pendingRequests.delete(message.id);
                } else if (message.method === "event" && message.params?.method) {
                    for (const listener of eventListeners) {
                        try {
                            listener(message.params.method, message.params.params ?? {});
                        } catch (err) {
                            console.error("[WS] Extension event listener error:", err);
                        }
                    }
                } else if (message.method === "ping") {
                    // Heartbeat — ignore
                }
            } catch (err) {
                console.error("[WS] Parse error:", err);
            }
        });

        ws.on("close", () => {
            console.error("[WS] Extension disconnected");
            if (activeConnection === ws) {
                activeConnection = null;
            }
            for (const [id, { reject }] of pendingRequests) {
                reject(new Error("Extension disconnected"));
            }
            pendingRequests.clear();
        });

        ws.on("error", (err) => {
            console.error("[WS] Connection error:", err.message);
        });
    });

    return wss;
}

export function sendCommandToExtension(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!activeConnection || activeConnection.readyState !== WebSocket.OPEN) {
            return reject(new Error("No active extension connection"));
        }

        const id = ++messageIdCounter;
        const timeout = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`Command '${method}' timed out after 30s`));
        }, 30000);

        pendingRequests.set(id, {
            resolve: (val) => { clearTimeout(timeout); resolve(val); },
            reject: (err) => { clearTimeout(timeout); reject(err); },
        });

        activeConnection.send(JSON.stringify({ id, method, params }));
    });
}
