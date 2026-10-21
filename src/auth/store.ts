import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { pool } from "../db.js";

export interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expiresAt: Date;
}

export type TokenKind = "access" | "refresh";

export interface TokenRecord {
  kind: TokenKind;
  familyId: string;
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: Date;
}

// Keys are sha256 hashes; the store never sees a raw code or token.
export interface AuthStore {
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  saveClient(client: OAuthClientInformationFull): Promise<void>;
  saveCode(hash: string, code: CodeRecord): Promise<void>;
  getCode(hash: string): Promise<CodeRecord | undefined>;
  /** Deletes and returns the code, so it can be redeemed only once. */
  takeCode(hash: string): Promise<CodeRecord | undefined>;
  saveTokens(tokens: Array<TokenRecord & { hash: string }>): Promise<void>;
  getToken(hash: string, kind: TokenKind): Promise<TokenRecord | undefined>;
  /** Deletes and returns the token, so a refresh token can be rotated only once. */
  takeToken(hash: string, kind: TokenKind): Promise<TokenRecord | undefined>;
  deleteToken(hash: string): Promise<void>;
  deleteFamily(familyId: string): Promise<void>;
  deleteExpired(): Promise<void>;
}

interface CodeRow {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  resource: string;
  expires_at: Date;
}

interface TokenRow {
  kind: TokenKind;
  family_id: string;
  client_id: string;
  scopes: string[];
  resource: string;
  expires_at: Date;
}

const CODE_COLUMNS = "client_id, redirect_uri, code_challenge, scopes, resource, expires_at";
const TOKEN_COLUMNS = "kind, family_id, client_id, scopes, resource, expires_at";

function toCode(row: CodeRow | undefined): CodeRecord | undefined {
  return (
    row && {
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      scopes: row.scopes,
      resource: row.resource,
      expiresAt: row.expires_at,
    }
  );
}

function toToken(row: TokenRow | undefined): TokenRecord | undefined {
  return (
    row && {
      kind: row.kind,
      familyId: row.family_id,
      clientId: row.client_id,
      scopes: row.scopes,
      resource: row.resource,
      expiresAt: row.expires_at,
    }
  );
}

export const pgAuthStore: AuthStore = {
  async getClient(clientId) {
    const { rows } = await pool.query<{ info: OAuthClientInformationFull }>(
      "SELECT info FROM oauth_clients WHERE client_id = $1",
      [clientId],
    );
    return rows[0]?.info;
  },

  async saveClient(client) {
    await pool.query("INSERT INTO oauth_clients (client_id, info) VALUES ($1, $2)", [client.client_id, client]);
  },

  async saveCode(hash, code) {
    await pool.query(
      `INSERT INTO oauth_codes (code_hash, ${CODE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [hash, code.clientId, code.redirectUri, code.codeChallenge, code.scopes, code.resource, code.expiresAt],
    );
  },

  async getCode(hash) {
    const { rows } = await pool.query<CodeRow>(`SELECT ${CODE_COLUMNS} FROM oauth_codes WHERE code_hash = $1`, [hash]);
    return toCode(rows[0]);
  },

  async takeCode(hash) {
    const { rows } = await pool.query<CodeRow>(
      `DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING ${CODE_COLUMNS}`,
      [hash],
    );
    return toCode(rows[0]);
  },

  async saveTokens(tokens) {
    const values: unknown[] = [];
    const tuples = tokens.map((t, i) => {
      values.push(t.hash, t.kind, t.familyId, t.clientId, t.scopes, t.resource, t.expiresAt);
      const n = i * 7;
      return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7})`;
    });
    await pool.query(`INSERT INTO oauth_tokens (token_hash, ${TOKEN_COLUMNS}) VALUES ${tuples.join(", ")}`, values);
  },

  async getToken(hash, kind) {
    const { rows } = await pool.query<TokenRow>(
      `SELECT ${TOKEN_COLUMNS} FROM oauth_tokens WHERE token_hash = $1 AND kind = $2`,
      [hash, kind],
    );
    return toToken(rows[0]);
  },

  async takeToken(hash, kind) {
    const { rows } = await pool.query<TokenRow>(
      `DELETE FROM oauth_tokens WHERE token_hash = $1 AND kind = $2 RETURNING ${TOKEN_COLUMNS}`,
      [hash, kind],
    );
    return toToken(rows[0]);
  },

  async deleteToken(hash) {
    await pool.query("DELETE FROM oauth_tokens WHERE token_hash = $1", [hash]);
  },

  async deleteFamily(familyId) {
    await pool.query("DELETE FROM oauth_tokens WHERE family_id = $1", [familyId]);
  },

  async deleteExpired() {
    await pool.query("DELETE FROM oauth_codes WHERE expires_at < now()");
    await pool.query("DELETE FROM oauth_tokens WHERE expires_at < now()");
  },
};
