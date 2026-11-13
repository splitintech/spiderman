import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { PostgresStore } from "@splitin/spiderman-store-postgres";
import { Engine } from "@splitin/spiderman-core";
import { EncryptedVault } from "@splitin/spiderman-vault";
test(
  "native PostgreSQL rollback, owner isolation and concurrent durable dispatch",
  { skip: !process.env.SPIDERMAN_TEST_DATABASE_URL },
  async () => {
    const first = new PostgresStore(process.env.SPIDERMAN_TEST_DATABASE_URL),
      second = new PostgresStore(process.env.SPIDERMAN_TEST_DATABASE_URL);
    let calls = 0;
    const provider = {
      manifest: {
        provider: "pg-test",
        version: "1",
        qualification: "automated_only",
        operations: [
          {
            name: "send",
            risk: "write",
            scopes: [],
            recipientKeys: ["recipient"],
            input: z.object({ recipient: z.string() }).strict(),
          },
        ],
      },
      verify: async () => ({ accountId: "pg-test-owner", scopes: [] }),
      execute: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { providerId: "pg-test-message", data: { ok: true } };
      },
    };
    try {
      await first.migrate();
      await assert.rejects(
        first.transaction(async (tx) => {
          await tx.put("rollback", "id", "alice", { id: "id" });
          throw Error("injected");
        }),
        /injected/,
      );
      assert.equal(
        await second.transaction((tx) => tx.get("rollback", "id")),
        undefined,
      );
      const vault = new EncryptedVault(first, Buffer.alloc(32, 2)),
        engine = new Engine(first, vault).register(provider),
        worker = new Engine(
          second,
          new EncryptedVault(second, Buffer.alloc(32, 2)),
        ).register(provider);
      const c = await engine.connect("alice", "pg-test", {
          private: "not-plaintext",
        }),
        a = await engine.submit("alice", {
          connectionId: c.id,
          operation: "send",
          input: { recipient: "recipient" },
          idempotencyKey: "postgres-test-1",
        });
      await engine.approve("alice", a.id, a.inputDigest);
      await Promise.all([engine.runOnce(), worker.runOnce()]);
      assert.equal(calls, 1);
      assert.equal((await worker.action("alice", a.id)).state, "succeeded");
      await assert.rejects(worker.result("bob", a.id), /not_found/);
      assert.equal(
        (
          await first.pool.query(
            "SELECT count(*)::int n FROM spiderman_records WHERE payload::text LIKE '%not-plaintext%'",
          )
        ).rows[0].n,
        0,
      );
      await engine.deleteData("alice");
    } finally {
      await first.close();
      await second.close();
    }
  },
);
