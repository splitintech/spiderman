import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Engine } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import { ConnectorError } from "@splitin/spiderman-contracts";
test("disconnect purges owned cached input, output and event content, preserving redacted receipts", async () => {
  const store = new SqliteStore(":memory:"),
    vault = new EncryptedVault(store, Buffer.alloc(32, 1)),
    engine = new Engine(store, vault);
  engine.register({
    manifest: {
      provider: "lifecycle",
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
    verify: async () => ({ accountId: "account", scopes: [] }),
    execute: async () => ({ data: { private: "content" } }),
  });
  try {
    const c = await engine.connect("alice", "lifecycle", {
        token: "synthetic",
      }),
      a = await engine.submit("alice", {
        connectionId: c.id,
        operation: "read",
        input: {},
        idempotencyKey: "lifecycle-read-1",
      });
    await engine.runOnce();
    const event = await engine.ingest("alice", c.id, "source", "message", {
      private: "text",
    });
    await engine.disconnect("alice", c.id);
    await assert.rejects(engine.preview("alice", a.id), /secret_unavailable/);
    await assert.rejects(engine.result("alice", a.id), /secret_unavailable/);
    await assert.rejects(
      engine.eventContent("alice", event.id),
      /secret_unavailable/,
    );
    assert.equal((await engine.action("alice", a.id)).state, "succeeded");
    await engine.deleteData("alice");
    assert.deepEqual(await engine.connections("alice"), []);
    assert.equal(
      (await store.transaction((tx) => tx.list("secret", "alice"))).length,
      0,
    );
  } finally {
    await store.close();
  }
});
test("manual retry is bounded to failed reads; uncertain writes remain held", async () => {
  const store = new SqliteStore(":memory:"),
    engine = new Engine(store, new EncryptedVault(store, Buffer.alloc(32, 1)));
  engine.register({
    manifest: {
      provider: "retry",
      version: "1",
      qualification: "automated_only",
      operations: [
        {
          name: "read",
          risk: "read",
          scopes: [],
          input: z.object({}).strict(),
        },
        {
          name: "send",
          risk: "write",
          scopes: [],
          input: z.object({}).strict(),
        },
      ],
    },
    verify: async () => ({ accountId: "account", scopes: [] }),
    execute: async (name) => {
      throw new ConnectorError("injected", name === "send");
    },
  });
  try {
    const c = await engine.connect("alice", "retry", {}),
      read = await engine.submit("alice", {
        connectionId: c.id,
        operation: "read",
        input: {},
        idempotencyKey: "retry-read-1",
      });
    await engine.runOnce();
    assert.equal((await engine.retry("alice", read.id)).state, "queued");
    await engine.runOnce();
    const write = await engine.submit("alice", {
      connectionId: c.id,
      operation: "send",
      input: {},
      idempotencyKey: "retry-write-1",
    });
    await engine.approve("alice", write.id, write.inputDigest);
    await engine.runOnce();
    await assert.rejects(
      engine.retry("alice", write.id),
      /automatic_retry_requires_read/,
    );
    assert.equal(
      (await engine.action("alice", write.id)).state,
      "unknown_outcome",
    );
  } finally {
    await store.close();
  }
});

test("disconnect during an in-flight response does not retain newly returned content", async () => {
  const store = new SqliteStore(":memory:"),
    vault = new EncryptedVault(store, Buffer.alloc(32, 1)),
    engine = new Engine(store, vault);
  let entered, finish;
  const running = new Promise((r) => (entered = r)),
    completed = new Promise((r) => (finish = r));
  engine.register({
    manifest: {
      provider: "inflight",
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
    verify: async () => ({ accountId: "account", scopes: [] }),
    execute: async () => {
      entered();
      await completed;
      return { data: { private: "late-response" } };
    },
  });
  try {
    const c = await engine.connect("alice", "inflight", { token: "synthetic" }),
      a = await engine.submit("alice", {
        connectionId: c.id,
        operation: "read",
        input: {},
        idempotencyKey: "inflight-read-1",
      });
    const dispatch = engine.runOnce();
    await running;
    await engine.disconnect("alice", c.id);
    finish();
    await dispatch;
    await assert.rejects(engine.result("alice", a.id), /result_not_ready/);
    assert.equal(
      (await store.transaction((tx) => tx.list("secret", "alice"))).length,
      0,
    );
  } finally {
    await store.close();
  }
});
