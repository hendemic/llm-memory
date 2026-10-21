// Exercises the full OAuth flow against a running server, without a browser.
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_URL;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;
if (!MCP_URL || !OWNER_PASSWORD) {
  console.error("Usage: MCP_URL=https://host/mcp OWNER_PASSWORD=... npm run smoke:oauth");
  process.exit(2);
}

// Never followed: the script reads the code from the Location header.
const REDIRECT_URI = "http://127.0.0.1:9/callback";

let failures = 0;

async function step<T>(name: string, fn: () => Promise<T>, detail?: (value: T) => string): Promise<T> {
  try {
    const value = await fn();
    const extra = detail ? detail(value) : "";
    console.log(`PASS  ${name}${extra ? ` (${extra})` : ""}`);
    return value;
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
    throw new StopError();
  }
}

class StopError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const base64url = (buf: Buffer) => buf.toString("base64url");

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`expected JSON, got ${res.status}: ${text.slice(0, 200)}`);
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[decodeEntities(m[1])] = decodeEntities(m[2]);
  }
  return fields;
}

interface Tokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
}

interface OAuthErrorBody {
  error?: string;
}

async function main(): Promise<void> {
  const mcpUrl = MCP_URL as string;
  const mcpPost = (headers: Record<string, string> = {}) =>
    fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  const resourceMetadataUrl = await step(
    "unauthenticated /mcp returns 401 with resource_metadata",
    async () => {
      const res = await mcpPost();
      assert(res.status === 401, `expected 401, got ${res.status}`);
      const header = res.headers.get("www-authenticate") ?? "";
      const match = /resource_metadata="([^"]+)"/.exec(header);
      assert(match, `WWW-Authenticate lacks resource_metadata: ${header || "(missing)"}`);
      return match[1];
    },
    (url) => url,
  );

  await step("bogus bearer token returns 401", async () => {
    const res = await mcpPost({ Authorization: "Bearer not-a-real-token" });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  const prm = await step(
    "protected resource metadata",
    async () => {
      const doc = await json<{ resource: string; authorization_servers?: string[] }>(await fetch(resourceMetadataUrl));
      assert(doc.resource === mcpUrl, `resource ${doc.resource} != ${mcpUrl}`);
      assert(doc.authorization_servers?.length, "no authorization_servers");
      return doc;
    },
    (doc) => `issuer ${doc.authorization_servers?.[0]}`,
  );

  const issuer = (prm.authorization_servers as string[])[0];
  interface AsMetadata {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    revocation_endpoint?: string;
    code_challenge_methods_supported?: string[];
  }
  const as = await step("authorization server metadata", async () => {
    // RFC 8414: insert the well-known segment before any issuer path.
    const u = new URL(issuer);
    const path = u.pathname === "/" ? "" : u.pathname;
    const doc = await json<AsMetadata>(await fetch(new URL(`/.well-known/oauth-authorization-server${path}`, u)));
    assert(doc.issuer === issuer, `issuer ${doc.issuer} != ${issuer}`);
    assert(doc.code_challenge_methods_supported?.includes("S256"), "S256 not advertised");
    assert(doc.registration_endpoint, "no registration_endpoint");
    return doc;
  });

  const client = await step(
    "dynamic client registration",
    async () => {
      const res = await fetch(as.registration_endpoint as string, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "oauth-smoke",
          redirect_uris: [REDIRECT_URI],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      const body = await json<{ client_id: string }>(res);
      assert(res.status === 201 && body.client_id, `expected 201, got ${res.status}: ${JSON.stringify(body)}`);
      return body;
    },
    (c) => `client_id ${c.client_id}`,
  );

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  async function consentForm(state: string): Promise<Record<string, string>> {
    const url = new URL(as.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: mcpUrl,
    }).toString();
    const res = await fetch(url, { redirect: "manual" });
    const html = await res.text();
    assert(res.status === 200, `GET /authorize returned ${res.status}: ${html.slice(0, 200)}`);
    assert(html.includes("oauth-smoke"), "consent page does not name the client");
    const fields = hiddenFields(html);
    assert(fields.nonce && fields.client_id === client.client_id, "consent form lacks nonce/client_id");
    return fields;
  }

  const submit = (fields: Record<string, string>, passphrase: string) =>
    fetch(as.authorization_endpoint, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...fields, passphrase, action: "approve" }),
    });

  const state = base64url(randomBytes(16));
  const code = await step("authorize with owner passphrase", async () => {
    const res = await submit(await consentForm(state), OWNER_PASSWORD as string);
    const location = res.headers.get("location");
    assert(res.status === 302 && location, `expected 302 redirect, got ${res.status}`);
    const redirect = new URL(location);
    assert(location.startsWith(REDIRECT_URI), `redirected to ${location}`);
    assert(redirect.searchParams.get("state") === state, "state mismatch");
    const value = redirect.searchParams.get("code");
    assert(value, `no code in redirect: ${location}`);
    return value;
  });

  const tokenRequest = (params: Record<string, string>) =>
    fetch(as.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, ...params }),
    });
  const codeGrant = (codeVerifier: string) =>
    tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
      resource: mcpUrl,
    });

  await step("wrong PKCE verifier is rejected", async () => {
    const res = await codeGrant(base64url(randomBytes(32)));
    const body = await json<OAuthErrorBody>(res);
    assert(res.status === 400 && body.error === "invalid_grant", `got ${res.status} ${JSON.stringify(body)}`);
  });

  const tokens = await step(
    "exchange code for tokens",
    async () => {
      const res = await codeGrant(verifier);
      const body = await json<Tokens>(res);
      assert(res.status === 200, `got ${res.status} ${JSON.stringify(body)}`);
      assert(body.access_token && body.refresh_token, "missing access_token or refresh_token");
      return body;
    },
    (t) => `expires_in ${t.expires_in}`,
  );

  await step("authorization code is single use", async () => {
    const res = await codeGrant(verifier);
    const body = await json<OAuthErrorBody>(res);
    assert(res.status === 400 && body.error === "invalid_grant", `got ${res.status} ${JSON.stringify(body)}`);
  });

  async function callTool(accessToken: string): Promise<string> {
    const mcp = new Client({ name: "oauth-smoke", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    await mcp.connect(transport);
    try {
      // list_memories needs no embedding call, so this costs nothing.
      const result = await mcp.callTool({ name: "list_memories", arguments: { namespace: "smoke-test", limit: 1 } });
      assert(!result.isError, `list_memories returned isError: ${JSON.stringify(result.content)}`);
      return "list_memories ok";
    } finally {
      await mcp.close().catch(() => {});
    }
  }

  await step("call an MCP tool with the access token", () => callTool(tokens.access_token), (d) => d);

  const refreshed = await step("refresh rotates the tokens", async () => {
    const res = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token as string,
      resource: mcpUrl,
    });
    const body = await json<Tokens>(res);
    assert(res.status === 200, `got ${res.status} ${JSON.stringify(body)}`);
    assert(body.refresh_token && body.refresh_token !== tokens.refresh_token, "refresh token was not rotated");
    return body;
  });

  await step("old refresh token is rejected", async () => {
    const res = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token as string });
    const body = await json<OAuthErrorBody>(res);
    assert(res.status === 400 && body.error === "invalid_grant", `got ${res.status} ${JSON.stringify(body)}`);
  });

  await step("refreshed access token works", () => callTool(refreshed.access_token), (d) => d);

  await step("wrong passphrase does not issue a code", async () => {
    const res = await submit(await consentForm(base64url(randomBytes(16))), `${OWNER_PASSWORD}-wrong`);
    assert(res.status === 401, `expected 401, got ${res.status}`);
    assert(!res.headers.get("location"), "unexpected redirect");
  });

  if (as.revocation_endpoint) {
    await step("revoking the refresh token revokes its access token", async () => {
      const res = await fetch(as.revocation_endpoint as string, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: client.client_id, token: refreshed.refresh_token as string }),
      });
      assert(res.status === 200, `revoke returned ${res.status}`);
      const after = await mcpPost({ Authorization: `Bearer ${refreshed.access_token}` });
      assert(after.status === 401, `access token still accepted (${after.status})`);
    });
  }
}

try {
  await main();
} catch (err) {
  if (!(err instanceof StopError)) {
    failures++;
    console.log(`FAIL  unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(failures === 0 ? "\nALL STEPS PASSED" : `\n${failures} STEP(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
