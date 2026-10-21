import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createMemory, deleteMemory, listMemories, searchMemories, updateMemory } from "./memories.js";

const namespace = z
  .string()
  .min(1)
  .max(100)
  .default("default")
  .describe("Memory partition, e.g. a project or agent name. Defaults to 'default'.");
const tags = z.array(z.string().min(1).max(100)).max(50);
const metadata = z.record(z.string(), z.unknown());

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function error(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "llm-memory", version: "1.0.0" });

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Store a new long-term memory. Write it as a self-contained statement (e.g. \"User prefers TypeScript over Python for new projects\") so it is understandable when recalled later without surrounding context.",
      inputSchema: {
        content: z.string().min(1).max(20_000).describe("The memory to store."),
        tags: tags.default([]).describe("Optional labels for filtering, e.g. ['preference', 'project:foo']."),
        metadata: metadata.default({}).describe("Optional arbitrary JSON metadata."),
        namespace,
      },
    },
    async (args) => json(await createMemory(args)),
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description:
        "Semantically search stored memories. Returns the closest matches with a similarity score (0-1, higher is closer).",
      inputSchema: {
        query: z.string().min(1).max(8_000).describe("What to search for, in natural language."),
        limit: z.number().int().min(1).max(50).default(5),
        tags: tags.optional().describe("If given, only return memories having at least one of these tags."),
        min_similarity: z.number().min(0).max(1).default(0.2).describe("Drop results below this similarity."),
        namespace,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ min_similarity, ...args }) => json(await searchMemories({ ...args, minSimilarity: min_similarity })),
  );

  server.registerTool(
    "list_memories",
    {
      title: "List memories",
      description: "List stored memories, newest first. Use for browsing rather than searching.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(20),
        offset: z.number().int().min(0).default(0),
        tags: tags.optional().describe("If given, only return memories having at least one of these tags."),
        namespace,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => json(await listMemories(args)),
  );

  server.registerTool(
    "update_memory",
    {
      title: "Update memory",
      description:
        "Correct or refine an existing memory by id. Only the fields provided are changed; changing content re-embeds it.",
      inputSchema: {
        id: z.uuid(),
        content: z.string().min(1).max(20_000).optional(),
        tags: tags.optional().describe("Replaces the existing tags."),
        metadata: metadata.optional().describe("Replaces the existing metadata."),
      },
      annotations: { idempotentHint: true },
    },
    async (args) => {
      const memory = await updateMemory(args);
      return memory ? json(memory) : error(`No memory with id ${args.id}`);
    },
  );

  server.registerTool(
    "forget",
    {
      title: "Forget",
      description: "Permanently delete a memory by id.",
      inputSchema: { id: z.uuid() },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) => ((await deleteMemory(id)) ? json({ deleted: id }) : error(`No memory with id ${id}`)),
  );

  return server;
}
