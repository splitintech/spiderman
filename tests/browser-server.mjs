// Synthetic provider boundary; actual HTTP/SQLite/vault/SDK/console/worker are mounted.
import { serve } from "@hono/node-server";
import { z } from "zod";
import { Engine } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import { createApp } from "@splitin/spiderman-server";
const store = new SqliteStore(":memory:"),
  engine = new Engine(store, new EncryptedVault(store, Buffer.alloc(32, 6)));
engine.register({
  manifest: {
    provider: "synthetic-mail",
    version: "test",
    qualification: "automated_only",
    operations: [
      {
        name: "mail.send",
        risk: "write",
        scopes: ["send"],
        recipientKeys: ["recipient"],
        input: z.object({ recipient: z.email(), text: z.string() }).strict(),
      },
    ],
  },
  verify: async () => ({ accountId: "alice@example.test", scopes: ["send"] }),
  execute: async () => ({
    providerId: "synthetic-receipt",
    data: { submitted: true, transport: "synthetic" },
  }),
});
const connection = await engine.connect("alice", "synthetic-mail", {
  token: "synthetic",
});
const action = await engine.submit("alice", {
  connectionId: connection.id,
  operation: "mail.send",
  input: {
    recipient: "bob@example.test",
    text: "Synthetic email preview; this is not sent.",
  },
  idempotencyKey: "browser-test-1",
});
const app = createApp(engine, {
  allowedOrigins: ["http://127.0.0.1:8788"],
  authenticate: async (token) =>
    token === "synthetic-alice-token"
      ? "alice"
      : token === "synthetic-bob-token"
        ? "bob"
        : undefined,
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 8788 });
const timer = setInterval(() => {
  void engine.runOnce();
}, 100);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  server.close();
  await store.close();
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
