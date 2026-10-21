# llm-memory

Remote MCP server (Streamable HTTP, stateless) giving LLMs long-term memory: Postgres + pgvector on Railway, embeddings via any OpenAI-compatible endpoint (OpenRouter by default), OAuth for claude.ai custom connectors plus a static bearer token for Claude Code. See README.md for tools, env vars, and client setup.

## Commands

- `npm run build`: compile with `tsc` (TypeScript 7) to `dist/`
- `npm run dev`: run locally with tsx watch (needs Postgres with pgvector and the env vars in `.env.example`)
- `npm run smoke`: end-to-end test against a running server (`MCP_URL`, `MCP_AUTH_TOKEN`)
- Type-check scripts (they sit outside the tsconfig `include`): `npx tsc --ignoreConfig --noEmit --module NodeNext --moduleResolution NodeNext --target ES2023 --strict --skipLibCheck --types node scripts/*.ts`

## Branches, worktrees, and parallel agents

- `main` auto-deploys to Railway (`llm-memory` service). Merging to `main` is a production deploy.
- Every feature or fix gets its own branch, `feat/<slug>` or `fix/<slug>`, checked out in its own worktree under `.claude/worktrees/<slug>` (gitignored):
  ```sh
  git worktree add .claude/worktrees/<slug> -b feat/<slug> main
  cd .claude/worktrees/<slug> && npm install
  ```
- One subagent per worktree, so several can change code at once without touching each other's files. Subagents commit on their branch; they do not push to or merge into `main`.
- Integration (rebasing or merging branches, pushing `main`, cleanup with `git worktree remove`) happens from the main checkout.
- Run `railway` CLI commands only from the main checkout. It is the directory linked to the Railway project, and worktrees are deliberately unlinked.

## Conventions

- ESM with `.js` import suffixes, small focused modules, terse comments only where they add something.
- Schema changes go in `migrate()` in `src/db.ts`, and must be idempotent (`IF NOT EXISTS`). It runs on every startup.
- Never commit secrets. Local secrets live in `.env`, which is gitignored.
