function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
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
};
