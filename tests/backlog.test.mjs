import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Engine } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
test("100 synthetic owners and 1000 commands remain isolated under eight workers with zero duplicate dispatches", async () => {
  const store = new SqliteStore(":memory:"),
    seen = new Map(),
    engine = new Engine(
      store,
      new EncryptedVault(store, Buffer.alloc(32, 1)),
    ).register({
      manifest: {
        provider: "backlog",
        version: "1",
        qualification: "automated_only",
        operations: [
          {
            name: "read",
            risk: "read",
            scopes: [],
            input: z.object({}).strict(),
          },
        ],
      },
      verify: async (c) => ({ accountId: c.account, scopes: [] }),
      execute: async (_op, _input, ctx) => {
        seen.set(ctx.actionId, (seen.get(ctx.actionId) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 1));
        return {
          providerId: ctx.actionId,
          data: { account: ctx.connection.accountId },
        };
      },
    });
  try {
    for (let n = 0; n < 100; n++) {
      const owner = "owner-" + n,
        c = await engine.connect(owner, "backlog", { account: owner });
      for (let i = 0; i < 10; i++)
        await engine.submit(owner, {
          connectionId: c.id,
          operation: "read",
          input: {},
          idempotencyKey: "backlog-" + i,
        });
    }
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (await engine.runOnce()) {}
      }),
    );
    assert.equal(seen.size, 1000);
    assert.ok([...seen.values()].every((count) => count === 1));
    for (let n = 0; n < 100; n++) {
      const actions = await engine.actions("owner-" + n);
      assert.equal(actions.length, 10);
      assert.ok(actions.every((a) => a.state === "succeeded"));
      for (const a of actions)
        assert.equal(
          (await engine.result("owner-" + n, a.id)).account,
          "owner-" + n,
        );
    }
    const other = (await engine.actions("owner-1"))[0];
    await assert.rejects(engine.result("owner-0", other.id), /not_found/);
  } finally {
    await store.close();
  }
});
