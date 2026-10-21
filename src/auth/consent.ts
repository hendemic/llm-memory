import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

// Per-process key: a redeploy only invalidates consent forms that are open at that moment.
const NONCE_KEY = randomBytes(32);
const NONCE_TTL_MS = 10 * 60 * 1000;

// The nonce binds the form to this exact authorization request and expires.
function nonceMac(expires: number, clientId: string, params: AuthorizationParams): Buffer {
  const bound = JSON.stringify([expires, clientId, params.redirectUri, params.codeChallenge, params.state ?? ""]);
  return createHmac("sha256", NONCE_KEY).update(bound).digest();
}

export function createNonce(clientId: string, params: AuthorizationParams): string {
  const expires = Date.now() + NONCE_TTL_MS;
  return `${expires}.${nonceMac(expires, clientId, params).toString("base64url")}`;
}

export function verifyNonce(nonce: unknown, clientId: string, params: AuthorizationParams): boolean {
  if (typeof nonce !== "string") return false;
  const [expiresText, mac] = nonce.split(".");
  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || expires < Date.now() || !mac) return false;
  const expected = nonceMac(expires, clientId, params);
  const provided = Buffer.from(mac, "base64url");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const CLAUDE_CALLBACK_HOSTS = new Set(["claude.ai", "claude.com"]);

export interface ConsentPage {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  nonce: string;
  error?: string;
}

export function renderConsent(res: Response, status: number, page: ConsentPage): void {
  const { client, params } = page;
  const redirect = new URL(params.redirectUri);
  const hidden: Record<string, string | undefined> = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    state: params.state,
    scope: params.scopes?.length ? params.scopes.join(" ") : undefined,
    resource: params.resource?.href,
    nonce: page.nonce,
  };
  const hiddenInputs = Object.entries(hidden)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("\n      ");

  const clientName = client.client_name?.trim() || "An unnamed client";
  const warning = CLAUDE_CALLBACK_HOSTS.has(redirect.hostname)
    ? ""
    : `<p class="warn">This client does not redirect to claude.ai. Only continue if you started this sign-in yourself.</p>`;
  const scopes = params.scopes?.length
    ? `<dt>Scopes</dt><dd>${escapeHtml(params.scopes.join(" "))}</dd>`
    : "";
  const error = page.error ? `<p class="error" role="alert">${escapeHtml(page.error)}</p>` : "";

  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    })
    .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize access · llm-memory</title>
  <style>
    :root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --fg: #1d1d1b; --muted: #6b6b66; --line: #e2e2dd; --accent: #1d1d1b; --accent-fg: #fff; --err: #b3261e; --warn-bg: #fff4d6; }
    @media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #1f1f1d; --fg: #ececea; --muted: #a0a09a; --line: #34342f; --accent: #ececea; --accent-fg: #161615; --err: #f2867d; --warn-bg: #3a3220; } }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
    h1 { font-size: 19px; margin: 0 0 4px; }
    .sub { margin: 0 0 20px; color: var(--muted); }
    dl { margin: 0 0 20px; display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; font-size: 14px; }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    label { display: block; font-weight: 600; margin-bottom: 6px; }
    input[type=password] { width: 100%; padding: 10px 12px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 8px; }
    .actions { display: flex; flex-direction: row-reverse; gap: 10px; margin-top: 18px; }
    button { flex: 1; padding: 10px; font: inherit; font-weight: 600; border-radius: 8px; border: 1px solid var(--accent); cursor: pointer; }
    .approve { background: var(--accent); color: var(--accent-fg); }
    .deny { background: transparent; color: var(--fg); border-color: var(--line); }
    .error { color: var(--err); margin: 0 0 14px; }
    .warn { background: var(--warn-bg); padding: 10px 12px; border-radius: 8px; font-size: 14px; margin: 0 0 18px; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize access to llm-memory</h1>
    <p class="sub"><strong>${escapeHtml(clientName)}</strong> wants to read and write your memories.</p>
    <dl>
      <dt>Redirects to</dt><dd><strong>${escapeHtml(redirect.host)}</strong></dd>
      <dt>Callback</dt><dd>${escapeHtml(params.redirectUri)}</dd>
      <dt>Client ID</dt><dd>${escapeHtml(client.client_id)}</dd>
      ${scopes}
    </dl>
    ${warning}
    ${error}
    <form method="post" action="/authorize">
      ${hiddenInputs}
      <label for="passphrase">Owner passphrase</label>
      <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
      <div class="actions">
        <button class="approve" type="submit" name="action" value="approve">Approve</button>
        <button class="deny" type="submit" name="action" value="deny" formnovalidate>Deny</button>
      </div>
    </form>
  </main>
</body>
</html>`);
}
