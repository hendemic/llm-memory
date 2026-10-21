import { timingSafeEqual } from "node:crypto";
import express, { type RequestHandler, type Router } from "express";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { config } from "../config.js";
import { issuerUrl, mcpUrl, type OwnerAuthProvider } from "./provider.js";

export { OwnerAuthProvider } from "./provider.js";
export { pgAuthStore } from "./store.js";

const RESOURCE_NAME = "llm-memory";

/**
 * Discovery (RFC 9728 + RFC 8414), /authorize, /token, /register and /revoke.
 * The SDK handlers bring their own body parsing, CORS and rate limits.
 */
export function authRouter(provider: OwnerAuthProvider): Router {
  const router = express.Router();
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl: mcpUrl,
      resourceName: RESOURCE_NAME,
      // DCR clients are kept indefinitely; an expiring secret would silently break refresh for confidential clients.
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );
  // The SDK serves /.well-known/oauth-protected-resource/mcp; also answer the root form some clients probe.
  router.use(
    "/.well-known/oauth-protected-resource",
    metadataHandler({ resource: mcpUrl.href, authorization_servers: [issuerUrl.href], resource_name: RESOURCE_NAME }),
  );
  return router;
}

/** Accepts the static MCP_AUTH_TOKEN or an OAuth access token issued for /mcp. */
export function requireMcpAuth(provider: OwnerAuthProvider): RequestHandler {
  const staticAuth = Buffer.from(`Bearer ${config.authToken}`);
  const oauth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });
  return (req, res, next) => {
    const provided = Buffer.from(req.header("authorization") ?? "");
    if (provided.length === staticAuth.length && timingSafeEqual(provided, staticAuth)) return next();
    return oauth(req, res, next);
  };
}
