import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Engine } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import { createApp } from "@splitin/spiderman-server";
function fixture() {
  let now = 1000,
    calls = 0;
  const store = new SqliteStore(":memory:"),
    engine = new Engine(
      store,
      new EncryptedVault(store, Buffer.alloc(32, 1), () => now),
      () => now,
    ).register({
      manifest: {
        provider: "limit-fixture",
        version: "1",
        qualification: "automated_only",
        operations: [
          {
            name: "read",
            risk: "read",
            scopes: [],
            input: z.object({ count: z.number().default(1) }).strict(),
          },
        ],
      },
      verify: async () => ({ accountId: "account", scopes: [] }),
      execute: async () => {
        calls++;
        return { data: { read: true } };
      },
    });
  return { engine, store, advance: () => (now += 60001), calls: () => calls };
}
test("rate limiting durably delays commands without losing them or bypassing the owner budget", async () => {
  const f = fixture();
  try {
    const c = await f.engine.connect("alice", "limit-fixture", {});
    await f.engine.limits("alice", c.id, {
      maxActionsPerMinute: 1,
      maxQueued: 2,
      maxCallSecondsPerDay: 0,
      maxSpendMicrosPerDay: 3,
      unitCostMicros: { read: 2 },
    });
    const a = await f.engine.submit("alice", {
        connectionId: c.id,
        operation: "read",
        input: {},
        idempotencyKey: "rate-first",
      }),
      b = await f.engine.submit("alice", {
        connectionId: c.id,
        operation: "read",
        input: {},
        idempotencyKey: "rate-second",
      });
    assert.deepEqual((await f.engine.preview("alice", a.id)).input, {
      count: 1,
    });
    await assert.rejects(
      f.engine.submit("alice", {
        connectionId: c.id,
        operation: "read",
        input: {},
        idempotencyKey: "rate-third",
      }),
      /connection_queue_limit/,
    );
    const first=await f.engine.runOnce();assert.equal(first.state,'succeeded');
    const waiting=first.id===a.id?b:a;
    assert.equal(await f.engine.runOnce(), undefined);
    assert.equal((await f.engine.action("alice", waiting.id)).state, "queued");
    f.advance();
    await f.engine.runOnce();
    assert.equal(
      (await f.engine.action("alice", waiting.id)).error,
      "connection_daily_budget_exceeded",
    );
    assert.equal(f.calls(), 1);
    await assert.rejects(
      f.engine.limits("bob", c.id, {
        maxActionsPerMinute: 1,
        maxQueued: 1,
        maxCallSecondsPerDay: 0,
        unitCostMicros: {},
      }),
      /not_found/,
    );
  } finally {
    await f.store.close();
  }
});
test("hosted readiness requires a recent worker heartbeat when configured", async () => {
  const f = fixture();
  try {
    const app = createApp(f.engine, {
      authenticate: async () => "alice",
      requireWorker: true,
    });
    assert.equal((await app.request("/health")).status, 503);
    await f.engine.heartbeat("synthetic-worker");
    assert.equal((await app.request("/health")).status, 200);
    f.advance();
    assert.equal((await app.request("/health")).status, 503);
    assert.equal((await app.request("/live")).status, 200);
  } finally {
    await f.store.close();
  }
});
