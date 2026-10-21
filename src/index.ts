import { createApp } from "./app.js";
import { OwnerAuthProvider, pgAuthStore } from "./auth/index.js";
import { config } from "./config.js";
import { migrate, pool } from "./db.js";

await migrate();
const app = createApp(new OwnerAuthProvider(pgAuthStore));
const httpServer = app.listen(config.port, "::", () => {
  console.log(`llm-memory MCP server listening on :${config.port} (public URL ${config.publicUrl})`);
});

async function shutdown() {
  httpServer.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
