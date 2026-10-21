import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { config } from "../config.js";
import { createNonce, renderConsent, verifyNonce } from "./consent.js";
import { lockedFor, recordFailure, recordSuccess } from "./limiter.js";
import type { AuthStore, TokenRecord } from "./store.js";

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const issuerUrl = new URL(config.publicUrl);
export const mcpUrl = new URL("/mcp", config.publicUrl);

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const hashToken = (value: string) => sha256(value).toString("hex");
const newSecret = () => randomBytes(32).toString("base64url");

const ownerHash = sha256(config.ownerPassword);
// Hashing first gives equal-length buffers, so the comparison is constant time whatever the input length.
function isOwnerPassphrase(input: unknown): boolean {
  return typeof input === "string" && timingSafeEqual(sha256(input), ownerHash);
}

// RFC 8707 canonical form: lowercase scheme and host, no default port, fragment, or trailing slash.
function canonical(url: URL | string): string {
  const u = new URL(url);
  u.hash = "";
  return u.href.replace(/\/$/, "");
}

const RESOURCE = canonical(mcpUrl);
const ACCEPTED_RESOURCES = new Set([RESOURCE, canonical(issuerUrl)]);

function checkResource(resource: URL | undefined): void {
  if (resource && !ACCEPTED_RESOURCES.has(canonical(resource))) {
    throw new InvalidTargetError(`This server only issues tokens for ${RESOURCE}`);
  }
}

// MCP spec: redirect URIs must be HTTPS or loopback.
function isAllowedRedirect(uri: string): boolean {
  const u = new URL(uri);
  return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
}

function isLive(record: { clientId: string; expiresAt: Date }, clientId: string): boolean {
  return record.clientId === clientId && record.expiresAt.getTime() > Date.now();
}

export class OwnerAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(private readonly store: AuthStore) {
    this.clientsStore = {
      getClient: (clientId) => store.getClient(clientId),
      registerClient: async (client) => {
        if (!client.redirect_uris.every(isAllowedRedirect)) {
          throw new InvalidClientMetadataError("redirect_uris must use https, or http on a loopback host");
        }
        // The SDK's registration handler has already assigned client_id.
        const full = client as OAuthClientInformationFull;
        await store.saveClient(full);
        return full;
      },
    };
  }

  // The SDK has already validated client_id, redirect_uri and the PKCE parameters, for GET and POST alike.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    checkResource(params.resource);
    const req = res.req;
    const page = (status: number, error?: string) =>
      renderConsent(res, status, { client, params, nonce: createNonce(client.client_id, params), error });

    if (req.method !== "POST") return page(200);

    const form = (req.body ?? {}) as Record<string, unknown>;
    if (!verifyNonce(form.nonce, client.client_id, params)) {
      return page(400, "This form expired or was not valid. Please enter the passphrase again.");
    }

    const redirect = new URL(params.redirectUri);
    if (params.state !== undefined) redirect.searchParams.set("state", params.state);

    if (form.action === "deny") {
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("error_description", "The owner denied access");
      return res.redirect(302, redirect.href);
    }

    // Check, compare and record synchronously so parallel guesses can't slip past the limit.
    const ip = req.ip ?? "unknown";
    const wait = lockedFor(ip);
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60_000);
      res.set("Retry-After", String(Math.ceil(wait / 1000)));
      return page(429, `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    }
    if (!isOwnerPassphrase(form.passphrase)) {
      await recordFailure(ip);
      return page(401, "Incorrect passphrase.");
    }
    recordSuccess(ip);

    const code = newSecret();
    await this.store.saveCode(hashToken(code), {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      resource: RESOURCE,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    redirect.searchParams.set("code", code);
    res.redirect(302, redirect.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const record = await this.store.getCode(hashToken(code));
    if (!record || !isLive(record, client.client_id)) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string, // PKCE is verified by the SDK's token handler before this is called.
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    checkResource(resource);
    const record = await this.store.takeCode(hashToken(code));
    if (!record || !isLive(record, client.client_id)) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return this.issueTokens(client.client_id, record.scopes, randomUUID());
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    checkResource(resource);
    const hash = hashToken(refreshToken);
    const record = await this.store.getToken(hash, "refresh");
    if (!record || !isLive(record, client.client_id)) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (scopes?.some((scope) => !record.scopes.includes(scope))) {
      throw new InvalidScopeError("Requested scopes exceed the original grant");
    }
    // Rotation: deleting the old token is the atomic step, so a concurrent reuse loses.
    if (!(await this.store.takeToken(hash, "refresh"))) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    return this.issueTokens(client.client_id, scopes ?? record.scopes, record.familyId);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.store.getToken(hashToken(token), "access");
    if (!record || record.expiresAt.getTime() <= Date.now()) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt.getTime() / 1000),
      resource: new URL(record.resource),
    };
  }

  // Revoking a refresh token also revokes every token issued from the same grant.
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = hashToken(request.token);
    const record = (await this.store.getToken(hash, "refresh")) ?? (await this.store.getToken(hash, "access"));
    if (!record || record.clientId !== client.client_id) return;
    if (record.kind === "refresh") await this.store.deleteFamily(record.familyId);
    else await this.store.deleteToken(hash);
  }

  private async issueTokens(clientId: string, scopes: string[], familyId: string): Promise<OAuthTokens> {
    const accessToken = newSecret();
    const refreshToken = newSecret();
    const now = Date.now();
    const base: Omit<TokenRecord, "kind" | "expiresAt"> = { familyId, clientId, scopes, resource: RESOURCE };
    await this.store.saveTokens([
      { ...base, hash: hashToken(accessToken), kind: "access", expiresAt: new Date(now + ACCESS_TTL_S * 1000) },
      { ...base, hash: hashToken(refreshToken), kind: "refresh", expiresAt: new Date(now + REFRESH_TTL_MS) },
    ]);
    this.store.deleteExpired().catch((err) => console.error("Failed to prune expired OAuth rows:", err));
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refreshToken,
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    };
  }
}
