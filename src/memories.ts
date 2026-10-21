import { pool } from "./db.js";
import { embed, toVectorLiteral } from "./embeddings.js";

export interface Memory {
  id: string;
  namespace: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  similarity?: number;
}

const COLUMNS = "id, namespace, content, tags, metadata, created_at, updated_at";

export async function createMemory(input: {
  namespace: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
}): Promise<Memory> {
  const embedding = await embed(input.content);
  const { rows } = await pool.query<Memory>(
    `INSERT INTO memories (namespace, content, embedding, tags, metadata)
     VALUES ($1, $2, $3::vector, $4, $5)
     RETURNING ${COLUMNS}`,
    [input.namespace, input.content, toVectorLiteral(embedding), input.tags, input.metadata],
  );
  return rows[0];
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
}): Promise<Memory[]> {
  const { rows } = await pool.query<Memory>(
    `SELECT ${COLUMNS} FROM memories
     WHERE namespace = $1 AND ($2::text[] IS NULL OR tags && $2::text[])
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [input.namespace, input.tags ?? null, input.limit, input.offset],
  );
  return rows;
}

export async function updateMemory(input: {
  id: string;
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): Promise<Memory | null> {
  const embedding = input.content === undefined ? null : toVectorLiteral(await embed(input.content));
  const { rows } = await pool.query<Memory>(
    `UPDATE memories SET
       content    = COALESCE($2, content),
       embedding  = COALESCE($3::vector, embedding),
       tags       = COALESCE($4, tags),
       metadata   = COALESCE($5, metadata),
       updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [input.id, input.content ?? null, embedding, input.tags ?? null, input.metadata ?? null],
  );
  return rows[0] ?? null;
}

export async function deleteMemory(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM memories WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}
