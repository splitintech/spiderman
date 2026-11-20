import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Engine, SyncCoordinator } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import { googleSyncSources } from "@splitin/spiderman-provider-google";
import { ConnectorError } from "@splitin/spiderman-contracts";
function fixture() {
  let now = 1000,
    calls = 0;
  const store = new SqliteStore(":memory:"),
    engine = new Engine(
      store,
      new EncryptedVault(store, Buffer.alloc(32, 3), () => now),
      () => now,
    );
  engine.register({
    manifest: {
      provider: "source",
      version: "1",
      qualification: "automated_only",
      operations: [
        {
          name: "read",
          risk: "read",
          scopes: [],
          input: z.object({ cursor: z.string().optional() }).strict(),
        },
      ],
    },
    verify: async () => ({ accountId: "account", scopes: [] }),
    execute: async () => {
      calls++;
      return {
        data: {
          next: "cursor-" + calls,
          items: [{ id: "event-same", text: "synthetic" }],
        },
      };
    },
  });
  const source = {
    name: "source.changes",
    provider: "source",
    request: (_r, c) => ({
      operation: "read",
      input: c ? { cursor: c.value } : {},
    }),
    parse: (data) => ({
      cursor: { value: data.next },
      events: data.items.map((item) => ({
        sourceId: item.id,
        type: "synthetic.incoming",
        content: item,
      })),
    }),
  };
  const sync = new SyncCoordinator(engine).register(source);
  return {
    store,
    engine,
    sync,
    source,
    time: () => {
      now += 2000;
    },
    calls: () => calls,
  };
}
test("sync restarts between durable command creation and cursor commit without duplicating events", async () => {
  const f = fixture();
  try {
    const c = await f.engine.connect("alice", "source", {}),
      s = await f.sync.create("alice", {
        connectionId: c.id,
        source: "source.changes",
        resource: "inbox",
        intervalSeconds: 30,
      });
    await f.sync.tick();
    assert.equal((await f.engine.actions("alice")).length, 1);
    await f.engine.runOnce();
    f.time();
    const restarted = new SyncCoordinator(f.engine).register(f.source);
    await restarted.tick();
    const row = (await restarted.list("alice"))[0];
    assert.equal(row.cursor.value, "cursor-1");
    assert.equal((await f.engine.events("alice")).length, 1);
    await assert.rejects(restarted.pause("bob", s.id), /not_found/);
    await f.engine.disconnect("alice", c.id);
    assert.equal((await restarted.list("alice"))[0].state, "blocked");
    assert.equal(f.calls(), 1);
  } finally {
    await f.store.close();
  }
});
test("event replay is deduplicated when processing restarts before cursor advancement", async () => {
  const f = fixture();
  try {
    const c = await f.engine.connect("alice", "source", {}),
      s = await f.sync.create("alice", {
        connectionId: c.id,
        source: "source.changes",
        resource: "inbox",
      });
    await f.sync.tick();
    await f.engine.runOnce();
    f.time();
    await f.engine.ingest("alice", c.id, "event-same", "synthetic.incoming", {
      id: "event-same",
    });
    await f.sync.tick();
    assert.equal((await f.engine.events("alice")).length, 1);
    assert.equal((await f.sync.list("alice"))[0].generation, 1);
  } finally {
    await f.store.close();
  }
});
test("poll failures back off with a bounded blocked state instead of hot retrying", async () => {
  const f = fixture();
  f.engine.provider("source").execute = async () => {
    throw new ConnectorError("provider_rate_limited");
  };
  try {
    const c = await f.engine.connect("alice", "source", {});
    await f.sync.create("alice", {
      connectionId: c.id,
      source: "source.changes",
      resource: "inbox",
    });
    await f.sync.tick();
    await f.engine.runOnce();
    f.time();
    const row = await f.sync.tick();
    assert.equal(row.failures, 1);
    assert.equal(row.error, "provider_rate_limited");
    assert.ok(row.nextRunAt > f.engine.now());
    assert.equal((await f.engine.actions("alice")).length, 1);
  } finally {
    await f.store.close();
  }
});
test("calendar bootstrap does not mirror personal events; changes preserve cancellation and cursor", () => {
  const source = googleSyncSources().find(
    (s) => s.provider === "google-calendar",
  );
  const first = source.parse(
    { items: [{ id: "personal", etag: "v1" }], nextSyncToken: "baseline" },
    "cal",
  );
  assert.deepEqual(first.events, []);
  const next = source.parse(
    {
      items: [{ id: "linked", etag: "v2", status: "cancelled" }],
      nextSyncToken: "new",
    },
    "cal",
    first.cursor,
  );
  assert.equal(next.events[0].type, "calendar.event_cancelled");
  assert.equal(next.cursor.syncToken, "new");
});
