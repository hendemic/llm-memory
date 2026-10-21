import OpenAI from "openai";
import { config } from "./config.js";

const client = new OpenAI({ apiKey: config.embeddingApiKey, baseURL: config.embeddingBaseUrl });

export async function embed(text: string): Promise<number[]> {
  const response = await client.embeddings.create({
    model: config.embeddingModel,
    input: text,
    dimensions: config.embeddingDimensions,
  });
  return response.data[0].embedding;
}

// pgvector accepts the same "[1,2,3]" literal that JSON produces.
export function toVectorLiteral(embedding: number[]): string {
  return JSON.stringify(embedding);
}
