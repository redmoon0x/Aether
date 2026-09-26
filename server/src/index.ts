import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { RegisterMcpTools } from "./mcp-server";
import { getCdpClient } from "./cdp-client";
import { createLogger } from "./logger";
import { SimpleOAuthProvider } from "./simple-oauth-provider";

const log = createLogger("index");

// ── Transport mode ────────────────────────────────────────────────────
const TRANSPORT: "stdio" | "http" =
    (process.env.MCP_TRANSPORT as "stdio" | "http") ??
    (process.argv.includes("--transport=http") ? "http" : "stdio");

const HTTP_PORT = parseInt(process.env.MCP_HTTP_PORT || "3456", 10);

// ── Graceful shutdown ─────────────────────────────────────────────────
async function shutdown() {
    log.info("Shutting down...");
    const client = getCdpClient();
    if (client.isConnected()) {
        log.info("Killing browser...");
        await client.killBrowser();
    }
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
    log.error("Uncaught Exception", { error: String(err) });
    shutdown();
});
process.on("unhandledRejection", (reason, promise) => {
    log.error("Unhandled Rejection", { reason: String(reason) });
    shutdown();
});
process.on("exit", () => {
    const client = getCdpClient();
    if (client.isConnected()) {
        client.disconnect();
    }
});

// ── Create MCP Server (shared by both transports) ─────────────────────
function createMcpServer(): Server {
    const server = new Server(
        {
            name: "aether-mcp-server",
            version: "2.1.0",
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );
    RegisterMcpTools(server);
    return server;
}

// ── Streamable HTTP + OAuth (Express-based) ───────────────────────────
async function runStreamableHttp(mcpServer: Server): Promise<void> {
    // Express app with DNS rebinding protection for tunneled access
    const app = createMcpExpressApp({ host: "0.0.0.0" });

    // OAuth 2.1 provider — allows Claude Desktop to register & authenticate
    const oauthProvider = new SimpleOAuthProvider();
    const publicUrl = process.env.MCP_PUBLIC_URL || `http://localhost:${HTTP_PORT}`;

    // Mount full OAuth authorization server
    // This handles: /.well-known/oauth-authorization-server,
    // /register, /authorize, /token, /revoke
    app.use(
        mcpAuthRouter({
            provider: oauthProvider,
            issuerUrl: new URL(publicUrl),
            baseUrl: new URL(publicUrl),
            serviceDocumentationUrl: new URL("https://github.com/user/aether-mcp"),
            scopesSupported: ["mcp"],
            resourceName: "Aether MCP",
            resourceServerUrl: new URL(publicUrl),
        })
    );

    // MCP transport — one instance handles all authenticated clients
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
    });

    await mcpServer.connect(transport);

    // Mount MCP endpoint with Bearer token auth
    // Claude uses OAuth access token in Authorization header
    app.all(
        "/mcp",
        requireBearerAuth({
            verifier: oauthProvider,
            requiredScopes: ["mcp"],
            resourceMetadataUrl: `${publicUrl}/.well-known/oauth-protected-resource`,
        }),
        async (req, res) => {
            // Pass auth info to transport so it knows who's connected
            const body = req.method === "POST" ? req.body : undefined;
            await transport.handleRequest(req, res, body);
        }
    );

    // Health check (no auth)
    app.get("/health", (_req, res) => {
        res.json({ status: "ok", transport: "streamable-http", oauth: true });
    });

    app.listen(HTTP_PORT, () => {
        log.info(`MCP Server (Streamable HTTP + OAuth) on http://localhost:${HTTP_PORT}`);
        log.info(`  MCP endpoint:    http://localhost:${HTTP_PORT}/mcp`);
        log.info(`  OAuth metadata:  http://localhost:${HTTP_PORT}/.well-known/oauth-authorization-server`);
        log.info(`  Register client: http://localhost:${HTTP_PORT}/register`);
    });
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
    log.info("Starting Aether MCP Browser Server (CDP mode)");
    log.info(`Transport: ${TRANSPORT.toUpperCase()}`);

    const server = createMcpServer();

    if (TRANSPORT === "http") {
        await runStreamableHttp(server);
    } else {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        log.info("MCP Server connected via Stdio. Ready.");
    }
}

main().catch((err) => {
    log.error("Fatal Error", { error: String(err) });
    process.exit(1);
});
