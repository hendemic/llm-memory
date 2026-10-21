import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // A client whose ROLLBACK failed is in an unknown state; discard it instead of returning it to the pool.
    await client.query("ROLLBACK").catch((rollbackErr: Error) => {
      broken = rollbackErr;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}

// Arbitrary constant so concurrent replicas don't race on schema creation.
const MIGRATION_LOCK_ID = 727_001;

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await client.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        namespace   text NOT NULL DEFAULT 'default',
        content     text NOT NULL,
        embedding   vector(${config.embeddingDimensions}) NOT NULL,
        tags        text[] NOT NULL DEFAULT '{}',
        metadata    jsonb NOT NULL DEFAULT '{}',
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops)",
    );
    await client.query("CREATE INDEX IF NOT EXISTS memories_tags_idx ON memories USING gin (tags)");
    await client.query(
      "CREATE INDEX IF NOT EXISTS memories_namespace_created_idx ON memories (namespace, created_at DESC)",
    );
    // Core memories load into every session; topical ones (the default) are found by recall.
    await client.query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS core boolean NOT NULL DEFAULT false");
    await client.query(
      "CREATE INDEX IF NOT EXISTS memories_core_idx ON memories (namespace, created_at) WHERE core",
    );

    // The column dimension is fixed at creation; fail loudly if the configured model no longer matches.
    const { rows } = await client.query<{ dims: number }>(`
      SELECT atttypmod AS dims FROM pg_attribute
      WHERE attrelid = 'memories'::regclass AND attname = 'embedding'
    `);
    if (rows[0] && rows[0].dims !== config.embeddingDimensions) {
      throw new Error(
        `memories.embedding has ${rows[0].dims} dimensions but EMBEDDING_DIMENSIONS is ${config.embeddingDimensions}`,
      );
    }

    // OAuth state. Codes and tokens are stored only as sha256 hashes.
    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id   text PRIMARY KEY,
        info        jsonb NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash       text PRIMARY KEY,
        client_id       text NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
        redirect_uri    text NOT NULL,
        code_challenge  text NOT NULL,
        scopes          text[] NOT NULL DEFAULT '{}',
        resource        text NOT NULL,
        expires_at      timestamptz NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash  text PRIMARY KEY,
        kind        text NOT NULL CHECK (kind IN ('access', 'refresh')),
        family_id   uuid NOT NULL,
        client_id   text NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
        scopes      text[] NOT NULL DEFAULT '{}',
        resource    text NOT NULL,
        expires_at  timestamptz NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS oauth_codes_expires_idx ON oauth_codes (expires_at)");
    await client.query("CREATE INDEX IF NOT EXISTS oauth_tokens_expires_idx ON oauth_tokens (expires_at)");
    await client.query("CREATE INDEX IF NOT EXISTS oauth_tokens_family_idx ON oauth_tokens (family_id)");

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
