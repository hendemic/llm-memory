# llm-memory

A remote MCP server that gives LLMs long-term memory. Memories are stored in Postgres with pgvector, embedded through any OpenAI-compatible embeddings API (OpenRouter by default), and exposed over Streamable HTTP (stateless). Clients authenticate with OAuth 2.1 (for claude.ai custom connectors) or a static bearer token (for Claude Code and scripts).

## Architecture

```
MCP client --HTTPS--> Node service (Express, /mcp) --> Postgres + pgvector
 (claude.ai,           OAuth 2.1 or static token          memories, HNSW index,
  Claude Code, ...)    + built-in authorization server    OAuth clients/codes/tokens
                              |
                              +--> embeddings API (OpenRouter by default)
```

Each `POST /mcp` request creates a fresh MCP server and transport; there are no sessions. The schema (extension, tables, indexes) is created on startup. `GET /health` checks database connectivity and needs no auth.

The service is its own OAuth authorization server, built on the MCP SDK's auth router. It serves discovery metadata (RFC 9728 at `/.well-known/oauth-protected-resource[/mcp]`, RFC 8414 at `/.well-known/oauth-authorization-server`), dynamic client registration (`/register`), `/authorize` (a passphrase page for the single owner), `/token` (authorization code with PKCE S256, refresh token) and `/revoke`. Authorization codes, access tokens and refresh tokens are stored in Postgres as sha256 hashes, so redeploys don't sign you out.

## Tools

| Tool | Params | Description |
| --- | --- | --- |
| `load_core_memories` | none | Return every core memory, plus current usage and the limits. Meant to be called at the start of every conversation. Read-only. |
| `remember` | `content` (string, required), `tags` (string[], default `[]`), `metadata` (object, default `{}`), `core` (boolean, default `false`) | Store a new memory. `core: true` fails with a tool error if it would exceed the core limits. |
| `recall` | `query` (string, required), `limit` (1-50, default 5), `tags` (string[], optional; match any), `min_similarity` (0-1, default 0.2) | Semantic search over all memories, core and topical; returns matches with a `similarity` score. |
| `list_memories` | `limit` (1-200, default 20), `offset` (default 0), `tags` (optional; match any), `core` (boolean, optional) | List memories, newest first. `core` filters to core-only or topical-only. |
| `update_memory` | `id` (uuid, required), `content`, `tags`, `metadata`, `core` (all optional) | Change only the provided fields; new content is re-embedded. Tags and metadata replace existing values. `core` promotes or demotes, subject to the core limits. |
| `forget` | `id` (uuid, required) | Permanently delete a memory. Returns an error if the id does not exist. |

Every record includes `core`. The server also sends MCP `instructions` covering when to recall, what to remember, tags, updating rather than duplicating, and the core rule below (see `src/instructions.ts`).

**Namespaces are chosen by the server, not the model.** The `namespace` column still partitions memories and every query is scoped to it, but no tool exposes it. Each request uses the `default` pool, set in one place (`createServer({ namespace })` in `src/app.ts`), so separate pools per connector (say, work and personal) can be added later without touching the tools.

## Core and topical memories

Memories are **topical** by default: Claude finds them with `recall` when they are relevant. **Core** memories (`core = true`) are the small set Claude loads at the start of every conversation, such as who you are, standing preferences and ongoing priorities.

Claude suggests, you confirm. The tool descriptions and server instructions tell Claude to set `core: true` only when you explicitly ask for something to always be remembered or loaded every session, or after it has asked and you agreed. It may suggest promoting a lasting, broadly relevant fact.

The core set is capped, since it costs context in every conversation. The defaults are 20 memories and 4,000 characters in total (`CORE_MEMORY_MAX_COUNT`, `CORE_MEMORY_MAX_CHARS`). 4,000 characters is roughly 1,000 tokens per conversation, and 20 entries of about 200 characters each is plenty for standing facts. Anything more specific belongs in topical memory. A `remember` or `update_memory` call that would exceed either limit changes nothing and returns a tool error that lists the current core memories, so Claude can ask you which one to demote (`update_memory` with `core: false`) or shorten. The check runs in a transaction under an advisory lock, so concurrent promotions can't overshoot.

### How core memories load in each client

- **claude.ai (web, desktop, mobile)**: claude.ai doesn't pass MCP server `instructions` to the model, and it shows custom connector tools to the model by name only, until Claude searches for them. Nothing makes Claude call `load_core_memories` on its own, so tell it to in your settings. Add this to your personal preferences in claude.ai settings (or to a project's instructions):

  > At the start of every conversation, before replying, call the `load_core_memories` tool from my memory connector and use what it returns as background. Use `recall` when my past context might help.

  The connector must be turned on for the chat (**+ > Connectors**). Set `load_core_memories` to **Always allow** under the connector's tool permissions, so it runs without an approval prompt.
- **Claude Code**: Claude Code puts the server instructions in context at session start, and they tell Claude to call `load_core_memories` first. The tool also sets `_meta["anthropic/alwaysLoad"]`, so Claude Code loads it upfront rather than behind tool search.

Core memories are fetched by a tool call, not embedded in the instructions. claude.ai ignores instructions, Claude Code may serve them from a cached earlier session, and older Claude Code versions cut them at 2,048 characters.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | | Postgres connection string. |
| `MCP_AUTH_TOKEN` | yes | | Static bearer token, accepted on `/mcp` alongside OAuth access tokens. |
| `OWNER_PASSWORD` | yes | | Passphrase entered on the OAuth sign-in page. Use a long one. |
| `PUBLIC_URL` | no | `https://$RAILWAY_PUBLIC_DOMAIN`, else `http://localhost:$PORT` | Public origin, used as the OAuth issuer and to build `/mcp`. Set it when using a custom domain. |
| `EMBEDDING_API_KEY` | yes | | API key for the embeddings endpoint (an OpenRouter key by default). |
| `EMBEDDING_BASE_URL` | no | `https://openrouter.ai/api/v1` | Any OpenAI-compatible embeddings endpoint. Set `https://api.openai.com/v1` to use OpenAI directly. |
| `EMBEDDING_MODEL` | no | `openai/text-embedding-3-small` | Embedding model, as the endpoint names it (OpenAI directly calls it `text-embedding-3-small`). |
| `EMBEDDING_DIMENSIONS` | no | `1536` | Vector size; fixed when the table is created. |
| `CORE_MEMORY_MAX_COUNT` | no | `20` | Maximum number of core memories. |
| `CORE_MEMORY_MAX_CHARS` | no | `4000` | Maximum total characters across all core memories. |
| `PORT` | no | `3000` | HTTP port. |

See `.env.example`.

## Local development

Requires Node 22+ and a Postgres with the pgvector extension available (for example the `pgvector/pgvector:pg17` Docker image).

```sh
docker run -d --name pgvector -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg17
npm install
cp .env.example .env   # fill in values, then export them (the app does not load .env itself)
set -a; source .env; set +a
npm run dev
```

Other scripts: `npm run build`, `npm start`, `npm run typecheck`.

## Deploying on Railway

1. Create a project and add a pgvector Postgres service (Railway's pgvector template). Note its service name.
2. Add a service from your private GitHub repo. `railway.json` configures the build (`npm run build`), start command, and `/health` healthcheck.
3. Set variables on the Node service:
   - `DATABASE_URL` = `${{pgvector.DATABASE_URL}}` as a reference variable (replace `pgvector` with your Postgres service's actual name). This uses Railway private networking.
   - `MCP_AUTH_TOKEN` = output of `openssl rand -hex 32`
   - `OWNER_PASSWORD` = a long passphrase you will type when connecting from claude.ai
   - `EMBEDDING_API_KEY`
   - Optionally `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS`.
4. Generate a public domain: `railway domain` (or in the service's Networking settings). Railway injects it as `RAILWAY_PUBLIC_DOMAIN`, which becomes the OAuth issuer. If you add a custom domain, set `PUBLIC_URL=https://<custom-domain>` and connect clients through that domain.
5. Check it: `curl https://<domain>/health` should return `{"status":"ok"}`.

## Connect from claude.ai

claude.ai custom connectors use OAuth: Claude registers itself through dynamic client registration and you approve it with the owner passphrase.

1. In claude.ai, open **Customize > Connectors** (on Team/Enterprise, an Owner uses **Organization settings > Connectors > Add > Custom**).
2. Click **Add custom connector**, give it a name, and enter the URL `https://<domain>/mcp` exactly, without a trailing slash.
3. Leave the OAuth client ID and secret empty. They sit under **Advanced settings**, or in the dialog's **OAuth client** step if yours has two steps. If the dialog asks how Claude should identify itself, choose **Register automatically** (dynamic client registration). This server doesn't support Client ID Metadata Documents; Claude falls back to registration if you pick its published identity anyway.
4. Click **Add**, then **Connect**. A sign-in page from your server opens and shows the requesting client and where it redirects (`claude.ai`). Enter the `OWNER_PASSWORD` passphrase and click **Approve**.

Claude refreshes the hour-long access token on its own. Refresh tokens last 90 days and rotate on every use, so you only sign in again after 90 days without use, or if you remove the connector. Authentication settings can't be edited once a connector is added; remove the connector and add it again to change them.

## Connecting other clients

Claude Code:

```sh
claude mcp add --transport http memory https://<domain>/mcp \
  --header "Authorization: Bearer <token>"
```

Generic JSON config (clients supporting remote HTTP MCP servers with custom headers):

```json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "https://<domain>/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

## Smoke test

Runs end to end against a deployed (or local) server. It checks the core cap logic as a pure function, then 401 without auth, the server instructions, and the tool list (no `namespace` parameter anywhere). Then it remembers, recalls, lists, updates and forgets a topical memory. For core memories, it creates one, checks it appears in `load_core_memories`, then demotes and re-promotes it. It also checks that over-cap `remember` and `update_memory` calls return a tool error and change nothing.

It creates at most two real memories, each tagged with a unique `smoke-<uuid>` tag. The cap checks use one memory longer than `CORE_MEMORY_MAX_CHARS`, which can never fit, so they never fill or disturb your real core set. If the live core set is already full, it skips the core lifecycle steps. Cleanup runs in `finally`. It deletes every memory carrying the run's tag, then fails the run if any are left, especially in `load_core_memories`.

```sh
MCP_URL=https://<domain>/mcp MCP_AUTH_TOKEN=<token> npm run smoke
```

It prints PASS/FAIL per step and exits non-zero on any failure. It calls the real embeddings API, so it incurs a few embedding calls.

The OAuth smoke test runs the claude.ai flow without a browser. It checks the `401` challenge, fetches the protected resource and authorization server metadata, registers a client, completes `/authorize` with the passphrase and PKCE, and exchanges the code. It also checks that a wrong PKCE verifier and code replay fail, calls `list_memories` with the access token, refreshes, and checks that the old refresh token is rejected. Finally it checks that a wrong passphrase is refused and that revocation works. It makes no embedding calls.

```sh
MCP_URL=https://<domain>/mcp OWNER_PASSWORD=<passphrase> npm run smoke:oauth
```

Each run registers one client, and its wrong-passphrase step counts toward the sign-in lockout (5 failures per IP per 15 minutes).

## Notes

- **Changing the embedding model requires re-embedding existing memories.** Vectors from different models are not comparable, even at the same dimensions, so re-embed every row after switching. The `embedding` column dimension is fixed at table creation, so a model with different dimensions also needs a column change (`ALTER TABLE memories ALTER COLUMN embedding TYPE vector(<n>)`, then recreate the HNSW index). Until then, startup fails because `EMBEDDING_DIMENSIONS` doesn't match.
- **HNSW with filters can under-return.** `recall` filters by namespace and tags alongside an HNSW index scan. On large datasets, the index may return its candidate set (default `hnsw.ef_search` 40) before filtering, yielding fewer results than `limit`. Raise `hnsw.ef_search` and/or enable pgvector 0.8+ iterative scans (`hnsw.iterative_scan`).
- **Auth is single-owner.** `/mcp` accepts either the static `MCP_AUTH_TOKEN` or an OAuth access token issued by this server for `https://<domain>/mcp`. Anyone can register an OAuth client, but codes are issued only after the owner passphrase is entered. Failed passphrases are delayed and limited to 5 per IP and 30 overall per 15 minutes. These counters are in memory, which is fine for one replica. Hitting the global cap locks out the owner too until the window passes, but existing tokens keep working.
- **Revoking access.** To sign out every OAuth client, run `DELETE FROM oauth_tokens;`. To also forget registered clients, run `DELETE FROM oauth_clients;`, which cascades. Rotating `MCP_AUTH_TOKEN` doesn't affect OAuth tokens. Changing `OWNER_PASSWORD` affects only future sign-ins.
