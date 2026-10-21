function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

const port = Number(process.env.PORT ?? 3000);

// Origin only: the OAuth issuer and endpoints live at the root of this host.
function publicUrl(): string {
  const raw =
    process.env.PUBLIC_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`);
  return new URL(raw).origin;
}

export const config = {
  port,
  databaseUrl: required("DATABASE_URL"),
  authToken: required("MCP_AUTH_TOKEN"),
  ownerPassword: required("OWNER_PASSWORD"),
  publicUrl: publicUrl(),
  embeddingApiKey: required("EMBEDDING_API_KEY"),
  // Any OpenAI-compatible embeddings endpoint; OpenRouter by default.
  embeddingBaseUrl: process.env.EMBEDDING_BASE_URL ?? "https://openrouter.ai/api/v1",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small",
  embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
  // Core memories load into every session, so their total size is capped.
  coreLimits: {
    maxCount: positiveInt("CORE_MEMORY_MAX_COUNT", 20),
    maxChars: positiveInt("CORE_MEMORY_MAX_CHARS", 4000),
  },
};
