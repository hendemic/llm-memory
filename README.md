# llm-memory

A remote MCP server that gives LLMs long-term memory. Memories are stored in Postgres with pgvector, embedded with OpenAI, and exposed over Streamable HTTP (stateless) behind a shared bearer token.

## Architecture

```
MCP client --HTTPS--> Node service (Express, /mcp) --> Postgres + pgvector
 (Claude Code, etc.)   bearer-token auth                 memories table, HNSW index
                              |
                              +--> OpenAI embeddings API
```

Each `POST /mcp` request creates a fresh MCP server and transport; there are no sessions. The schema (extension, table, indexes) is created on startup. `GET /health` checks database connectivity.

## Tools

| Tool | Params | Description |
| --- | --- | --- |
| `remember` | `content` (string, required), `tags` (string[], default `[]`), `metadata` (object, default `{}`), `namespace` (default `"default"`) | Store a new memory. |
| `recall` | `query` (string, required), `limit` (1-50, default 5), `tags` (string[], optional; match any), `min_similarity` (0-1, default 0.2), `namespace` | Semantic search; returns matches with a `similarity` score. |
| `list_memories` | `limit` (1-200, default 20), `offset` (default 0), `tags` (optional; match any), `namespace` | List memories, newest first. |
| `update_memory` | `id` (uuid, required), `content`, `tags`, `metadata` (all optional) | Change only the provided fields; new content is re-embedded. Tags and metadata replace existing values. |
| `forget` | `id` (uuid, required) | Permanently delete a memory. Returns an error if the id does not exist. |

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | | Postgres connection string. |
| `MCP_AUTH_TOKEN` | yes | | Bearer token clients must send. |
| `OPENAI_API_KEY` | yes | | Used to create embeddings. |
| `EMBEDDING_MODEL` | no | `text-embedding-3-small` | OpenAI embedding model. |
| `EMBEDDING_DIMENSIONS` | no | `1536` | Vector size; fixed when the table is created. |
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
   - `OPENAI_API_KEY`
   - Optionally `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS`.
4. Generate a public domain: `railway domain` (or in the service's Networking settings).
5. Check it: `curl https://<domain>/health` should return `{"status":"ok"}`.

## Connecting clients

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

Runs end to end against a deployed (or local) server: checks 401 without auth, lists tools, then remembers, recalls, lists, updates, and forgets a memory in the `smoke-test` namespace.

```sh
MCP_URL=https://<domain>/mcp MCP_AUTH_TOKEN=<token> npm run smoke
```

It prints PASS/FAIL per step and exits non-zero on any failure. It uses the real OpenAI API, so it incurs a few embedding calls.

## Notes

- **Changing embedding model or dimensions requires re-embedding.** The `embedding` column dimension is fixed at table creation. If `EMBEDDING_DIMENSIONS` no longer matches, startup fails with an error. Switching models with the same dimensions starts, but old and new vectors are not comparable, so re-embed all rows.
- **HNSW with filters can under-return.** `recall` filters by namespace and tags alongside an HNSW index scan. On large datasets, the index may return its candidate set (default `hnsw.ef_search` 40) before filtering, yielding fewer results than `limit`. Raise `hnsw.ef_search` and/or enable pgvector 0.8+ iterative scans (`hnsw.iterative_scan`).
- **Auth is a single shared bearer token.** There is no per-user auth. claude.ai custom connectors require OAuth, which is not supported yet.
