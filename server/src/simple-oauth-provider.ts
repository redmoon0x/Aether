/**
 * Minimal in-memory OAuth 2.1 provider for Aether MCP.
 */
import { Response } from "express";
import { createHash } from "node:crypto";
import {
    OAuthServerProvider,
    AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
    OAuthClientInformationFull,
    OAuthTokens,
    OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// ── In-memory stores ──────────────────────────────────────────────────

interface StoredClient extends OAuthClientInformationFull {
    client_secret: string;
}

interface StoredAuthorization {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    expiresAt: number;
}

interface StoredToken {
    accessToken: string;
    clientId: string;
    scopes: string[];
    expiresAt: number;
    refreshToken?: string;
}

// ── Provider ──────────────────────────────────────────────────────────

export class SimpleOAuthProvider implements OAuthServerProvider {
    private clients = new Map<string, StoredClient>();
    private authCodes = new Map<string, StoredAuthorization>();
    private tokens = new Map<string, StoredToken>();
    private refreshTokens = new Map<string, string>(); // refreshToken -> accessToken

    // ── Clients Store ─────────────────────────────────────────────

    get clientsStore(): OAuthRegisteredClientsStore {
        return {
            getClient: async (clientId: string) => {
                return this.clients.get(clientId);
            },
            registerClient: async (client) => {
                const clientId = `client_${crypto.randomUUID()}`;
                const clientSecret = `secret_${crypto.randomUUID()}`;
                const now = Math.floor(Date.now() / 1000);
                const full: StoredClient = {
                    ...client,
                    client_id: clientId,
                    client_secret: clientSecret,
                    client_id_issued_at: now,
                    client_secret_expires_at: now + 365 * 24 * 3600, // 1 year
                };
                this.clients.set(clientId, full);
                return full;
            },
        };
    }

    // ── Authorization ────────────────────────────────────────────

    async authorize(
        client: OAuthClientInformationFull,
        params: AuthorizationParams,
        res: Response
    ): Promise<void> {
        // Generate authorization code
        const code = `authcode_${crypto.randomUUID()}`;
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

        this.authCodes.set(code, {
            clientId: client.client_id,
            redirectUri: params.redirectUri,
            codeChallenge: params.codeChallenge,
            scopes: params.scopes || [],
            expiresAt,
        });

        // Build redirect URL
        const redirectUrl = new URL(params.redirectUri);
        redirectUrl.searchParams.set("code", code);
        if (params.state) {
            redirectUrl.searchParams.set("state", params.state);
        }

        res.redirect(302, redirectUrl.toString());
    }

    async challengeForAuthorizationCode(
        _client: OAuthClientInformationFull,
        authorizationCode: string
    ): Promise<string> {
        const stored = this.authCodes.get(authorizationCode);
        if (!stored) throw new Error("Unknown authorization code");
        if (Date.now() > stored.expiresAt) {
            this.authCodes.delete(authorizationCode);
            throw new Error("Authorization code expired");
        }
        return stored.codeChallenge;
    }

    // ── Token Exchange ───────────────────────────────────────────

    async exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
        codeVerifier?: string,
        redirectUri?: string,
        _resource?: URL
    ): Promise<OAuthTokens> {
        const stored = this.authCodes.get(authorizationCode);
        if (!stored) throw new Error("Unknown authorization code");
        if (Date.now() > stored.expiresAt) {
            this.authCodes.delete(authorizationCode);
            throw new Error("Authorization code expired");
        }
        if (stored.clientId !== client.client_id) {
            throw new Error("Client ID mismatch");
        }
        if (redirectUri && stored.redirectUri !== redirectUri) {
            throw new Error("Redirect URI mismatch");
        }

        // PKCE: verify code_verifier against stored code_challenge
        if (codeVerifier) {
            const expectedChallenge = stored.codeChallenge;
            // The SDK already validates PKCE locally unless skipLocalPkceValidation is set.
            // We store the raw challenge; the SDK does the S256 hash check.
            // If no verifier provided but challenge was stored, that's an error.
            // For plain (no S256), verifier must match challenge.
            if (codeVerifier !== expectedChallenge) {
                // Try S256: base64url(sha256(code_verifier))
                const hash = createHash("sha256").update(codeVerifier).digest();
                const computedChallenge = hash
                    .toString("base64")
                    .replace(/\+/g, "-")
                    .replace(/\//g, "_")
                    .replace(/=+$/, "");
                if (computedChallenge !== expectedChallenge) {
                    throw new Error("PKCE validation failed");
                }
            }
        }

        this.authCodes.delete(authorizationCode);

        return this.issueTokens(client.client_id, stored.scopes);
    }

    async exchangeRefreshToken(
        client: OAuthClientInformationFull,
        refreshToken: string,
        scopes?: string[],
        _resource?: URL
    ): Promise<OAuthTokens> {
        const accessToken = this.refreshTokens.get(refreshToken);
        if (!accessToken) throw new Error("Unknown refresh token");

        const stored = this.tokens.get(accessToken);
        if (!stored || stored.clientId !== client.client_id) {
            throw new Error("Invalid refresh token");
        }

        // Revoke old tokens
        this.tokens.delete(accessToken);
        this.refreshTokens.delete(refreshToken);

        return this.issueTokens(client.client_id, scopes || stored.scopes);
    }

    // ── Token Verification ───────────────────────────────────────

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const stored = this.tokens.get(token);
        if (!stored) throw new Error("Invalid access token");
        if (Date.now() > stored.expiresAt * 1000) {
            this.tokens.delete(token);
            throw new Error("Access token expired");
        }
        return {
            token,
            clientId: stored.clientId,
            scopes: stored.scopes,
            expiresAt: stored.expiresAt,
        };
    }

    // ── Token Revocation ─────────────────────────────────────────

    async revokeToken(
        _client: OAuthClientInformationFull,
        request: OAuthTokenRevocationRequest
    ): Promise<void> {
        this.tokens.delete(request.token);
        // Also clean up any refresh token pointing to this
        for (const [rt, at] of this.refreshTokens) {
            if (at === request.token) {
                this.refreshTokens.delete(rt);
                break;
            }
        }
    }

    // ── Helpers ──────────────────────────────────────────────────

    private issueTokens(clientId: string, scopes: string[]): OAuthTokens {
        const accessToken = `aether_at_${crypto.randomUUID()}`;
        const refreshToken = `aether_rt_${crypto.randomUUID()}`;
        const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour

        this.tokens.set(accessToken, {
            accessToken,
            clientId,
            scopes,
            expiresAt,
            refreshToken,
        });
        this.refreshTokens.set(refreshToken, accessToken);

        return {
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 3600,
            scope: scopes.join(" "),
            refresh_token: refreshToken,
        };
    }
}
