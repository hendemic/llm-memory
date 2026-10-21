import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_URL;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!MCP_URL || !MCP_AUTH_TOKEN) {
  console.error("Usage: MCP_URL=https://host/mcp MCP_AUTH_TOKEN=... npm run smoke");
  process.exit(2);
}

const NAMESPACE = "smoke-test";
const EXPECTED_TOOLS = ["remember", "recall", "list_memories", "update_memory", "forget"];

let failures = 0;

function pass(step: string, detail = ""): void {
  console.log(`PASS  ${step}${detail ? ` (${detail})` : ""}`);
}

function fail(step: string, detail: string): void {
  failures++;
  console.log(`FAIL  ${step}: ${detail}`);
}

async function step(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await fn();
    pass(name, detail ?? "");
    return true;
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
    return false;
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface ToolResult {
  isError?: boolean;
  content?: unknown;
}

function textOf(result: ToolResult): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((c: unknown) => {
      const part = c as { type?: string; text?: string };
      return part.type === "text" ? (part.text ?? "") : "";
    })
    .join("");
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function callOk<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await call(client, name, args);
  assert(!result.isError, `${name} returned isError: ${textOf(result)}`);
  return JSON.parse(textOf(result)) as T;
}

interface MemoryRow {
  id: string;
  content: string;
  tags: string[];
  similarity?: number;
}

async function main(): Promise<void> {
  const url = MCP_URL as string;
  const authHeader = `Bearer ${MCP_AUTH_TOKEN}`;

  await step("unauthenticated POST returns 401", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert(res.status === 401, `expected 401, got ${res.status}`);
    return `status ${res.status}`;
  });

  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: authHeader } },
  });

  const connected = await step("connect with bearer token", async () => {
    await client.connect(transport);
  });
  if (!connected) return;

  const tag = `smoke-${randomUUID()}`;
  let memoryId: string | undefined;
  let forgotten = false;

  try {
    await step("listTools includes all 5 tools", async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
      assert(missing.length === 0, `missing tools: ${missing.join(", ")} (got: ${names.join(", ")})`);
      return names.join(", ");
    });

    await step("remember", async () => {
      const memory = await callOk<MemoryRow>(client, "remember", {
        content: "The user's favourite pet is a grey cat named Whiskers who sleeps on the windowsill.",
        tags: [tag],
        namespace: NAMESPACE,
      });
      assert(typeof memory.id === "string" && memory.id.length > 0, "no id in response");
      memoryId = memory.id;
      return `id ${memory.id}`;
    });

    if (!memoryId) return;
    const id = memoryId;

    await step("recall finds it with a paraphrased query", async () => {
      const results = await callOk<MemoryRow[]>(client, "recall", {
        query: "what animal does the user keep at home",
        namespace: NAMESPACE,
        tags: [tag],
        limit: 10,
        min_similarity: 0,
      });
      const hit = results.find((r) => r.id === id);
      assert(hit !== undefined, `id not in ${results.length} result(s)`);
      return `similarity ${hit.similarity?.toFixed(3)}`;
    });

    await step("list_memories filtered by tag", async () => {
      const results = await callOk<MemoryRow[]>(client, "list_memories", {
        namespace: NAMESPACE,
        tags: [tag],
      });
      assert(results.length === 1 && results[0].id === id, `expected exactly [${id}], got ${results.length} row(s)`);
    });

    await step("update_memory changes content", async () => {
      const updated = await callOk<MemoryRow>(client, "update_memory", {
        id,
        content: "The user's favourite pet is a black dog named Rex.",
      });
      assert(updated.id === id, "returned a different id");
      assert(updated.content.includes("Rex"), `content not updated: ${updated.content}`);
    });

    await step("forget deletes it", async () => {
      const result = await call(client, "forget", { id });
      assert(!result.isError, `isError: ${textOf(result)}`);
      forgotten = true;
    });

    await step("second forget returns isError", async () => {
      const result = await call(client, "forget", { id });
      assert(result.isError === true, "expected isError on second forget");
    });
  } finally {
    if (memoryId && !forgotten) {
      try {
        const result = await call(client, "forget", { id: memoryId });
        console.log(
          result.isError
            ? `WARN  cleanup forget returned isError for ${memoryId}: ${textOf(result)}`
            : `INFO  cleanup: forgot ${memoryId}`,
        );
      } catch (err) {
        console.log(`WARN  cleanup forget failed for ${memoryId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    await client.close().catch(() => {});
  }
}

try {
  await main();
} catch (err) {
  fail("unexpected error", err instanceof Error ? err.message : String(err));
}

console.log(failures === 0 ? "\nALL STEPS PASSED" : `\n${failures} STEP(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
