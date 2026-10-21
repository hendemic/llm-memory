import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config } from "./config.js";
import { charLength, CoreLimitError } from "./core.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import {
  createMemory,
  deleteMemory,
  listCoreMemories,
  listMemories,
  searchMemories,
  updateMemory,
} from "./memories.js";

const tags = z.array(z.string().min(1).max(100)).max(50);
const metadata = z.record(z.string(), z.unknown());
const CORE_RULE =
  "Set core=true only if the user explicitly asked for this to always be remembered or loaded every session, " +
  "or you asked and they agreed; you may suggest it for lasting, broadly relevant facts.";

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function error(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Turns a core cap violation into a tool error Claude can act on; anything else propagates.
async function coreLimited(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CoreLimitError) return error(err.message);
    throw err;
  }
}

export interface ServerOptions {
  // The memory pool for this request. Chosen by the server (later per connector), never by the model.
  namespace: string;
}

export function createServer({ namespace }: ServerOptions): McpServer {
  const server = new McpServer({ name: "llm-memory", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "load_core_memories",
    {
      title: "Load core memories",
      description:
        "Load the user's core memories: the small set of standing facts and preferences meant to be known in every conversation. " +
        "Call once at the start of every conversation, before replying to the first message, and use the result as background. " +
        "Returns the memories plus current usage and limits.",
      annotations: { readOnlyHint: true },
      // Claude Code loads this tool upfront instead of behind tool search.
      _meta: { "anthropic/alwaysLoad": true },
    },
    async () => {
      const memories = await listCoreMemories(namespace);
      return json({
        core_memories: memories,
        usage: { count: memories.length, chars: memories.reduce((sum, m) => sum + charLength(m.content), 0) },
        limits: { max_count: config.coreLimits.maxCount, max_chars: config.coreLimits.maxChars },
      });
    },
  );

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Store a new long-term memory: a durable fact, preference, decision or piece of project context, written as a " +
        "self-contained statement (e.g. \"User prefers TypeScript over Python for new projects\"). Not for ephemeral " +
        "details or secrets. If the fact is already stored, use update_memory instead.",
      inputSchema: {
        content: z.string().min(1).max(20_000).describe("The memory to store."),
        tags: tags.default([]).describe("A few short category labels, e.g. ['preference', 'project:foo']."),
        metadata: metadata.default({}).describe("Optional arbitrary JSON metadata."),
        core: z
          .boolean()
          .default(false)
          .describe(`Load this memory in every session instead of only via recall. ${CORE_RULE}`),
      },
    },
    async (args) => coreLimited(async () => json(await createMemory({ ...args, namespace }))),
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description:
        "Semantically search stored memories. Use when past context about the user, their projects or preferences " +
        "could matter, and before asking something they may already have said. Returns the closest matches with a " +
        "similarity score (0-1, higher is closer).",
      inputSchema: {
        query: z.string().min(1).max(8_000).describe("What to search for, in natural language."),
        limit: z.number().int().min(1).max(50).default(5),
        tags: tags.optional().describe("If given, only return memories having at least one of these tags."),
        min_similarity: z.number().min(0).max(1).default(0.2).describe("Drop results below this similarity."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ min_similarity, ...args }) =>
      json(await searchMemories({ ...args, namespace, minSimilarity: min_similarity })),
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
        core: z.boolean().optional().describe("If given, only core (true) or only topical (false) memories."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => json(await listMemories({ ...args, namespace })),
  );

  server.registerTool(
    "update_memory",
    {
      title: "Update memory",
      description:
        "Change an existing memory by id, e.g. when a stored fact changes, instead of saving a duplicate. Only the " +
        "fields provided change; new content is re-embedded. Also promotes a memory to core or demotes it to topical.",
      inputSchema: {
        id: z.uuid(),
        content: z.string().min(1).max(20_000).optional(),
        tags: tags.optional().describe("Replaces the existing tags."),
        metadata: metadata.optional().describe("Replaces the existing metadata."),
        core: z
          .boolean()
          .optional()
          .describe(`true promotes to core (loaded every session), false demotes to topical. ${CORE_RULE}`),
      },
      annotations: { idempotentHint: true },
    },
    async (args) =>
      coreLimited(async () => {
        const memory = await updateMemory({ ...args, namespace });
        return memory ? json(memory) : error(`No memory with id ${args.id}`);
      }),
  );

  server.registerTool(
    "forget",
    {
      title: "Forget",
      description: "Permanently delete a memory by id. Use only when the user wants it deleted.",
      inputSchema: { id: z.uuid() },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) => ((await deleteMemory(namespace, id)) ? json({ deleted: id }) : error(`No memory with id ${id}`)),
  );

  return server;
}
