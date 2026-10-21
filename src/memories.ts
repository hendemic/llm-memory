import type pg from "pg";
import { config } from "./config.js";
import { checkCoreBudget, type CoreEntry } from "./core.js";
import { pool, withTransaction } from "./db.js";
import { embed, toVectorLiteral } from "./embeddings.js";

// The memory pool every request uses for now. The server, never the model, picks the namespace.
export const DEFAULT_NAMESPACE = "default";

export interface Memory {
  id: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  core: boolean;
  created_at: Date;
  updated_at: Date;
  similarity?: number;
}

const COLUMNS = "id, content, tags, metadata, core, created_at, updated_at";

// Serializes core-budget checks per namespace (two-key advisory lock, separate from the migration lock).
const CORE_LOCK_ID = 727_002;

// Held until the transaction ends, so check-then-write on the core set can't race.
async function lockCore(client: pg.PoolClient, namespace: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [CORE_LOCK_ID, namespace]);
}

// Throws CoreLimitError if `content` would not fit alongside the other core memories. Call under lockCore.
async function assertCoreRoom(
  client: pg.PoolClient,
  namespace: string,
  content: string,
  excludeId: string | null,
): Promise<void> {
  const { rows } = await client.query<CoreEntry>(
    `SELECT id, content FROM memories
     WHERE namespace = $1 AND core AND ($2::uuid IS NULL OR id <> $2::uuid)
     ORDER BY created_at`,
    [namespace, excludeId],
  );
  checkCoreBudget(rows, content, config.coreLimits);
}

export async function createMemory(input: {
  namespace: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  core: boolean;
}): Promise<Memory> {
  const embedding = toVectorLiteral(await embed(input.content));
  const insert = async (db: pg.Pool | pg.PoolClient) => {
    const { rows } = await db.query<Memory>(
      `INSERT INTO memories (namespace, content, embedding, tags, metadata, core)
       VALUES ($1, $2, $3::vector, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [input.namespace, input.content, embedding, input.tags, input.metadata, input.core],
    );
    return rows[0];
  };
  if (!input.core) return insert(pool);
  return withTransaction(async (client) => {
    await lockCore(client, input.namespace);
    await assertCoreRoom(client, input.namespace, input.content, null);
    return insert(client);
  });
}

export async function searchMemories(input: {
  namespace: string;
  query: string;
  limit: number;
  tags?: string[];
  minSimilarity: number;
}): Promise<Memory[]> {
  const embedding = await embed(input.query);
  // Cosine distance (<=>) ranges 0..2; similarity = 1 - distance.
  const { rows } = await pool.query<Memory>(
    `SELECT * FROM (
       SELECT ${COLUMNS}, 1 - (embedding <=> $1::vector) AS similarity
       FROM memories
       WHERE namespace = $2 AND ($3::text[] IS NULL OR tags && $3::text[])
       ORDER BY embedding <=> $1::vector
       LIMIT $4
     ) ranked
     WHERE similarity >= $5`,
    [toVectorLiteral(embedding), input.namespace, input.tags ?? null, input.limit, input.minSimilarity],
  );
  return rows;
}

export async function listMemories(input: {
  namespace: string;
  limit: number;
  offset: number;
  tags?: string[];
  core?: boolean;
}): Promise<Memory[]> {
  const { rows } = await pool.query<Memory>(
    `SELECT ${COLUMNS} FROM memories
     WHERE namespace = $1
       AND ($2::text[] IS NULL OR tags && $2::text[])
       AND ($3::boolean IS NULL OR core = $3::boolean)
     ORDER BY created_at DESC
     LIMIT $4 OFFSET $5`,
    [input.namespace, input.tags ?? null, input.core ?? null, input.limit, input.offset],
  );
  return rows;
}

// Oldest first, so the always-loaded set reads in a stable order.
export async function listCoreMemories(namespace: string): Promise<Memory[]> {
  const { rows } = await pool.query<Memory>(
    `SELECT ${COLUMNS} FROM memories WHERE namespace = $1 AND core ORDER BY created_at`,
    [namespace],
  );
  return rows;
}

export async function updateMemory(input: {
  namespace: string;
  id: string;
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  core?: boolean;
}): Promise<Memory | null> {
  const embedding = input.content === undefined ? null : toVectorLiteral(await embed(input.content));
  const update = async (db: pg.Pool | pg.PoolClient) => {
    const { rows } = await db.query<Memory>(
      `UPDATE memories SET
         content    = COALESCE($3, content),
         embedding  = COALESCE($4::vector, embedding),
         tags       = COALESCE($5, tags),
         metadata   = COALESCE($6, metadata),
         core       = COALESCE($7::boolean, core),
         updated_at = now()
       WHERE id = $1 AND namespace = $2
       RETURNING ${COLUMNS}`,
      [
        input.id,
        input.namespace,
        input.content ?? null,
        embedding,
        input.tags ?? null,
        input.metadata ?? null,
        input.core ?? null,
      ],
    );
    return rows[0] ?? null;
  };

  // Only promoting, or rewriting a memory that is already core, can grow the core set.
  const mayGrowCore = input.core === true || (input.core === undefined && input.content !== undefined);
  if (!mayGrowCore) return update(pool);

  return withTransaction(async (client) => {
    await lockCore(client, input.namespace);
    const { rows } = await client.query<{ core: boolean; content: string }>(
      "SELECT core, content FROM memories WHERE id = $1 AND namespace = $2 FOR UPDATE",
      [input.id, input.namespace],
    );
    const current = rows[0];
    if (!current) return null;
    if (input.core ?? current.core) {
      await assertCoreRoom(client, input.namespace, input.content ?? current.content, input.id);
    }
    return update(client);
  });
}

export async function deleteMemory(namespace: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM memories WHERE id = $1 AND namespace = $2", [id, namespace]);
  return (rowCount ?? 0) > 0;
}
