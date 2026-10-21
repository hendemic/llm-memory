import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { checkCoreBudget, CoreLimitError } from "../src/core.js";

const MCP_URL = process.env.MCP_URL;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!MCP_URL || !MCP_AUTH_TOKEN) {
  console.error("Usage: MCP_URL=https://host/mcp MCP_AUTH_TOKEN=... npm run smoke");
  process.exit(2);
}

const EXPECTED_TOOLS = [
  "load_core_memories",
  "list_topics",
  "remember",
  "recall",
  "list_memories",
  "update_memory",
  "forget",
];
// remember/update_memory reject content longer than this, so a cap above it can't be hit by one memory.
const MAX_CONTENT = 20_000;

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
  core: boolean;
  namespace?: string;
  similarity?: number;
}

interface CoreState {
  core_memories: MemoryRow[];
  usage: { count: number; chars: number };
  limits: { max_count: number; max_chars: number };
  topics: { tag: string; count: number }[];
  topical_total: number;
}

interface TopicList {
  topics: { tag: string; count: number; last_updated: string }[];
  untagged: number;
  total: number;
}

// The cap logic as a pure function: no server, no data.
function checkCapLogic(): string {
  const limits = { maxCount: 2, maxChars: 10 };
  const fits = (others: { id: string; content: string }[], content: string) => {
    try {
      checkCoreBudget(others, content, limits);
      return true;
    } catch (err) {
      assert(err instanceof CoreLimitError, `unexpected error type: ${err}`);
      return false;
    }
  };
  const a = { id: "a", content: "12345" };
  assert(fits([], "1234567890"), "exactly maxChars should fit");
  assert(!fits([], "12345678901"), "maxChars + 1 should not fit");
  assert(fits([a], "12345"), "count and chars at the limits should fit");
  assert(!fits([a], "123456"), "chars over the limit should not fit");
  assert(!fits([a, { id: "b", content: "1" }], "1"), "count over the limit should not fit");
  assert(fits([], "😀😀😀😀😀😀😀😀😀😀"), "characters are counted as code points");
  try {
    checkCoreBudget([a, { id: "b", content: "x" }], "y", limits);
    throw new Error("expected CoreLimitError");
  } catch (err) {
    assert(err instanceof CoreLimitError, `unexpected error: ${err}`);
    assert(err.message.includes('"id":"a"') && err.message.includes('"id":"b"'), "message should list core memories");
    assert(err.message.includes("core=false"), "message should say how to demote");
  }
  return "boundaries, code points, error message";
}

async function main(): Promise<void> {
  const url = MCP_URL as string;
  const authHeader = `Bearer ${MCP_AUTH_TOKEN}`;

  await step("core cap logic (local, pure function)", async () => checkCapLogic());

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

  // Every memory this run creates carries this tag, so cleanup can find them even if an id was lost.
  const tag = `smoke-${randomUUID()}`;
  const created = new Set<string>();
  const track = (memory: MemoryRow) => {
    created.add(memory.id);
    return memory;
  };

  try {
    await step("server instructions mention load_core_memories", async () => {
      const instructions = client.getInstructions() ?? "";
      assert(instructions.includes("load_core_memories"), `instructions: ${JSON.stringify(instructions)}`);
      assert(instructions.length <= 2048, `instructions are ${instructions.length} chars (Claude Code cuts at 2,048)`);
      return `${instructions.length} chars`;
    });

    await step(`listTools has all ${EXPECTED_TOOLS.length} tools and no namespace param`, async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
      assert(missing.length === 0, `missing tools: ${missing.join(", ")} (got: ${names.join(", ")})`);
      const leaky = tools.filter((t) => "namespace" in (t.inputSchema.properties ?? {})).map((t) => t.name);
      assert(leaky.length === 0, `namespace still exposed on: ${leaky.join(", ")}`);
      const load = tools.find((t) => t.name === "load_core_memories");
      assert(load?.annotations?.readOnlyHint === true, "load_core_memories should be readOnlyHint");
      assert(load?._meta?.["anthropic/alwaysLoad"] === true, "load_core_memories should set anthropic/alwaysLoad");
      const topics = tools.find((t) => t.name === "list_topics");
      assert(topics?.annotations?.readOnlyHint === true, "list_topics should be readOnlyHint");
      for (const name of ["remember", "update_memory"]) {
        const props = tools.find((t) => t.name === name)?.inputSchema.properties ?? {};
        assert("core" in props, `${name} has no core param`);
      }
      return names.join(", ");
    });

    let topicalId: string | undefined;
    await step("remember (topical by default)", async () => {
      const memory = track(
        await callOk<MemoryRow>(client, "remember", {
          content: "The user's favourite pet is a grey cat named Whiskers who sleeps on the windowsill.",
          tags: [tag],
        }),
      );
      assert(typeof memory.id === "string" && memory.id.length > 0, "no id in response");
      assert(memory.core === false, `expected core false, got ${memory.core}`);
      assert(!("namespace" in memory), "record should not expose namespace");
      topicalId = memory.id;
      return `id ${memory.id}`;
    });

    if (topicalId) {
      const id = topicalId;

      await step("recall finds it with a paraphrased query", async () => {
        const results = await callOk<MemoryRow[]>(client, "recall", {
          query: "what animal does the user keep at home",
          tags: [tag],
          limit: 10,
          min_similarity: 0,
        });
        const hit = results.find((r) => r.id === id);
        assert(hit !== undefined, `id not in ${results.length} result(s)`);
        assert(hit.core === false, "recall record should include core=false");
        return `similarity ${hit.similarity?.toFixed(3)}`;
      });

      await step("list_memories filtered by tag and core", async () => {
        const all = await callOk<MemoryRow[]>(client, "list_memories", { tags: [tag] });
        assert(all.length === 1 && all[0].id === id, `tag only: expected exactly [${id}], got ${all.length} row(s)`);
        const topical = await callOk<MemoryRow[]>(client, "list_memories", { tags: [tag], core: false });
        assert(topical.length === 1 && topical[0].id === id, `core=false: got ${topical.length} row(s)`);
        const core = await callOk<MemoryRow[]>(client, "list_memories", { tags: [tag], core: true });
        assert(core.length === 0, `core=true: expected none, got ${core.length}`);
      });

      await step("list_topics and load_core_memories count the topical tag, without content", async () => {
        const topical = await callOk<TopicList>(client, "list_topics", { core: false });
        const hit = topical.topics.find((t) => t.tag === tag);
        assert(hit?.count === 1, `expected ${tag} with count 1, got ${JSON.stringify(hit)}`);
        assert(!JSON.stringify(topical).includes("Whiskers"), "list_topics leaked memory content");
        const core = await callOk<TopicList>(client, "list_topics", { core: true });
        assert(!core.topics.some((t) => t.tag === tag), "topical tag listed under core=true");
        const loaded = await callOk<CoreState>(client, "load_core_memories", {});
        assert(
          loaded.topics.some((t) => t.tag === tag && t.count === 1),
          "load_core_memories topics missing the tag",
        );
        assert(loaded.topical_total >= 1, `topical_total ${loaded.topical_total}`);
        return `${topical.topics.length} topical tag(s), ${topical.total} topical memories`;
      });

      await step("update_memory changes content", async () => {
        const updated = await callOk<MemoryRow>(client, "update_memory", {
          id,
          content: "The user's favourite pet is a black dog named Rex.",
        });
        assert(updated.id === id, "returned a different id");
        assert(updated.content.includes("Rex"), `content not updated: ${updated.content}`);
        assert(updated.core === false, "update should not change core");
      });
    }

    let state: CoreState | undefined;
    await step("load_core_memories returns memories, usage and limits", async () => {
      state = await callOk<CoreState>(client, "load_core_memories", {});
      assert(Array.isArray(state.core_memories), "core_memories is not an array");
      assert(state.core_memories.every((m) => m.core === true), "non-core memory in core_memories");
      assert(state.usage.count === state.core_memories.length, "usage.count mismatch");
      assert(state.limits.max_count > 0 && state.limits.max_chars > 0, `bad limits ${JSON.stringify(state.limits)}`);
      return `${state.usage.count}/${state.limits.max_count} memories, ${state.usage.chars}/${state.limits.max_chars} chars`;
    });

    const coreContent = `Smoke test core memory ${tag}; safe to delete.`;
    const roomForCore =
      state !== undefined &&
      state.usage.count < state.limits.max_count &&
      state.usage.chars + coreContent.length <= state.limits.max_chars;

    if (state && !roomForCore) {
      console.log("SKIP  core lifecycle: the live core set is already at its cap (not touching real memories)");
    } else if (state) {
      let coreId: string | undefined;
      await step("remember with core=true", async () => {
        const memory = track(await callOk<MemoryRow>(client, "remember", { content: coreContent, tags: [tag], core: true }));
        assert(memory.core === true, `expected core true, got ${memory.core}`);
        coreId = memory.id;
        return `id ${memory.id}`;
      });

      if (coreId) {
        const id = coreId;
        await step("core memory appears in load_core_memories and list_memories core=true", async () => {
          const loaded = await callOk<CoreState>(client, "load_core_memories", {});
          assert(loaded.core_memories.some((m) => m.id === id), "not in load_core_memories");
          const listed = await callOk<MemoryRow[]>(client, "list_memories", { tags: [tag], core: true });
          assert(listed.length === 1 && listed[0].id === id, `list core=true: got ${listed.length} row(s)`);
        });

        await step("update_memory core=false demotes it", async () => {
          const demoted = await callOk<MemoryRow>(client, "update_memory", { id, core: false });
          assert(demoted.core === false, `expected core false, got ${demoted.core}`);
          const loaded = await callOk<CoreState>(client, "load_core_memories", {});
          assert(!loaded.core_memories.some((m) => m.id === id), "still in load_core_memories after demotion");
        });

        await step("update_memory core=true promotes it again", async () => {
          const promoted = await callOk<MemoryRow>(client, "update_memory", { id, core: true });
          assert(promoted.core === true, `expected core true, got ${promoted.core}`);
          // Demote right away so a failure later in the run can't leave it in every session.
          const demoted = await callOk<MemoryRow>(client, "update_memory", { id, core: false });
          assert(demoted.core === false, "re-demotion failed");
        });
      }
    }

    // One memory longer than max_chars exceeds the cap on its own, whatever the live core set holds,
    // so these checks never need to fill the real core set.
    const overSize = state ? state.limits.max_chars + 1 : 0;
    if (state && overSize > MAX_CONTENT) {
      console.log(`SKIP  cap errors: max_chars ${state.limits.max_chars} is above the ${MAX_CONTENT}-char content limit`);
    } else if (state) {
      const oversized = `Smoke test oversized core memory ${tag}. `.padEnd(overSize, "x");

      await step("remember core=true over the cap returns isError and saves nothing", async () => {
        const result = await call(client, "remember", { content: oversized, tags: [tag], core: true });
        const listed = await callOk<MemoryRow[]>(client, "list_memories", { tags: [tag], limit: 200 });
        listed.forEach(track);
        assert(result.isError === true, `expected isError, got: ${textOf(result).slice(0, 200)}`);
        const text = textOf(result);
        assert(text.includes("Core memory limit"), `unexpected error text: ${text.slice(0, 200)}`);
        assert(text.includes("Current core memories"), "error does not list the current core memories");
        assert(!listed.some((m) => m.content === oversized), "the rejected memory was saved anyway");
      });

      if (topicalId) {
        const id = topicalId;
        await step("update_memory promotion over the cap returns isError and changes nothing", async () => {
          const result = await call(client, "update_memory", { id, content: oversized, core: true });
          assert(result.isError === true, `expected isError, got: ${textOf(result).slice(0, 200)}`);
          const topical = await callOk<MemoryRow[]>(client, "list_memories", { tags: [tag], core: false, limit: 200 });
          const after = topical.find((m) => m.id === id);
          assert(after !== undefined, "memory is no longer topical after a rejected promotion");
          assert(after.content.includes("Rex"), "content changed despite the rejected update");
        });
      }
    }

    if (topicalId) {
      const id = topicalId;
      await step("forget deletes it", async () => {
        const result = await call(client, "forget", { id });
        assert(!result.isError, `isError: ${textOf(result)}`);
        created.delete(id);
      });

      await step("second forget returns isError", async () => {
        const result = await call(client, "forget", { id });
        assert(result.isError === true, "expected isError on second forget");
      });
    }
  } finally {
    await cleanup(client, tag, created);
    await client.close().catch(() => {});
  }
}

// Deletes everything this run created: tracked ids plus anything carrying the run tag.
async function cleanup(client: Client, tag: string, created: Set<string>): Promise<void> {
  try {
    const listed = await callOk<MemoryRow[]>(client, "list_memories", { tags: [tag], limit: 200 });
    listed.forEach((m) => created.add(m.id));
  } catch (err) {
    console.log(`WARN  cleanup could not list tag ${tag}: ${err instanceof Error ? err.message : err}`);
  }
  for (const id of created) {
    try {
      const result = await call(client, "forget", { id });
      console.log(result.isError ? `WARN  cleanup forget ${id}: ${textOf(result)}` : `INFO  cleanup: forgot ${id}`);
    } catch (err) {
      console.log(`WARN  cleanup forget failed for ${id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  // A leaked core memory would load into every real session, so check explicitly.
  await step("cleanup left no smoke memories behind", async () => {
    const left = await callOk<MemoryRow[]>(client, "list_memories", { tags: [tag], limit: 200 });
    const core = await callOk<CoreState>(client, "load_core_memories", {});
    const leakedCore = core.core_memories.filter((m) => m.tags.includes(tag) || m.content.includes(tag));
    assert(
      left.length === 0 && leakedCore.length === 0,
      `left behind: ${[...left, ...leakedCore].map((m) => m.id).join(", ")} (delete them by hand)`,
    );
  });
}

try {
  await main();
} catch (err) {
  fail("unexpected error", err instanceof Error ? err.message : String(err));
}

console.log(failures === 0 ? "\nALL STEPS PASSED" : `\n${failures} STEP(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
