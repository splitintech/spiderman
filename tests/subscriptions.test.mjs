import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Engine, SubscriptionCoordinator } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import { ConnectorError } from "@splitin/spiderman-contracts";
import { createApp, WebhookIngress } from "@splitin/spiderman-server";
import { GoogleProvider, OutlookProvider } from "@splitin/spiderman-providers";
const routeId = "00000000-0000-4000-8000-000000000001",
  topic = "projects/example/topics/inbox";
async function fixture(uncertain = false) {
  let now = Date.now(),
    sends = 0;
  const store = new SqliteStore(":memory:"),
    engine = new Engine(
      store,
      new EncryptedVault(store, Buffer.alloc(32, 1), () => now),
      () => now,
    );
  engine.register({
    manifest: {
      provider: "gmail",
      version: "1",
      qualification: "automated_only",
      operations: [
        {
          name: "mail.watch",
          risk: "write",
          scopes: [],
          policyKeys: ["topicName"],
          input: z.object({ topicName: z.string() }).strict(),
        },
      ],
    },
    verify: async () => ({ accountId: "alice@example.test", scopes: [] }),
    execute: async () => {
      sends++;
      if (uncertain) throw new ConnectorError("lost_watch", true);
      return {
        providerId: "watch",
        data: { historyId: "123", expiration: String(now + 7 * 86400000) },
      };
    },
  });
  const c = await engine.connect("alice", "gmail", {}),
    source = {
      name: "gmail.watch",
      provider: "gmail",
      request: async () => ({
        operation: "mail.watch",
        input: { topicName: topic },
      }),
      established: async (_row, data) => ({
        providerId: data.historyId,
        expiresAt: Number(data.expiration),
      }),
    },
    coordinator = new SubscriptionCoordinator(engine).register(source);
  const row = await coordinator.create("alice", {
    connectionId: c.id,
    source: "gmail.watch",
    resource: "inbox",
    routeId,
    topicName: topic,
  });
  return {
    store,
    engine,
    c,
    source,
    coordinator,
    row,
    advance: (ms = 2000) => {
      now += ms;
    },
    now: () => now,
    sends: () => sends,
  };
}
test("watch renewal waits for exact approval, survives restart and deduplicates a crash after submit", async () => {
  const f = await fixture();
  try {
    await f.coordinator.tick();
    let row = (await f.coordinator.list("alice"))[0];
    const action = await f.engine.action("alice", row.actionId);
    assert.equal(action.state, "awaiting_approval");
    assert.equal(f.sends(), 0);
    // The command commit survives a crash before its ID is recorded on the schedule.
    await f.store.transaction(async (tx) => {
      row = await tx.get("subscription", f.row.id);
      delete row.actionId;
      row.nextRunAt = 0;
      await tx.put("subscription", row.id, row.owner, row);
    });
    const restarted = new SubscriptionCoordinator(f.engine).register(f.source);
    await restarted.tick();
    assert.equal((await f.engine.actions("alice")).length, 1);
    await f.engine.approve("alice", action.id, action.inputDigest);
    await f.engine.runOnce();
    f.advance();
    await restarted.tick();
    row = (await restarted.list("alice"))[0];
    assert.equal(row.providerId, "123");
    assert.equal(row.generation, 1);
    assert.equal(f.sends(), 1);
    await f.engine.policy("alice", {
      connectionId: f.c.id,
      operations: ["mail.watch"],
      inputEquals: { topicName: topic },
      expiresAt: f.now() + 20 * 86400000,
      maxActions: 5,
    });
    f.advance(86400001);
    await restarted.tick();
    await f.engine.runOnce();
    f.advance();
    await restarted.tick();
    assert.equal(f.sends(), 2);
    assert.equal((await restarted.list("bob")).length, 0);
    await assert.rejects(restarted.pause("bob", f.row.id), /not_found/);
  } finally {
    await f.store.close();
  }
});
test("standing watch rules reject another destination and revocation fences queued renewal", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.engine.policy("alice", {
        connectionId: f.c.id,
        operations: ["mail.watch"],
        expiresAt: f.now() + 86400000,
        maxActions: 2,
      }),
      /policy_input_constraint_required/,
    );
    const rule = await f.engine.policy("alice", {
      connectionId: f.c.id,
      operations: ["mail.watch"],
      inputEquals: { topicName: topic },
      expiresAt: f.now() + 86400000,
      maxActions: 2,
    });
    const other = await f.engine.submit("alice", {
      connectionId: f.c.id,
      operation: "mail.watch",
      input: { topicName: "projects/attacker/topics/leak" },
      idempotencyKey: "different-topic",
    });
    assert.equal(other.state, "awaiting_approval");
    await f.coordinator.tick();
    await f.engine.removePolicy("alice", rule.id);
    await f.engine.runOnce();
    assert.equal(f.sends(), 0);
    f.advance();
    await f.coordinator.tick();
    const held = (await f.coordinator.list("alice"))[0];
    assert.equal(
      (await f.engine.action("alice", held.actionId)).state,
      "awaiting_approval",
    );
  } finally {
    await f.store.close();
  }
});
test("uncertain subscription creation remains held across restart and disconnect stops schedules", async () => {
  const f = await fixture(true);
  try {
    await f.coordinator.tick();
    const action = (await f.engine.actions("alice"))[0];
    await f.engine.approve("alice", action.id, action.inputDigest);
    await f.engine.runOnce();
    f.advance();
    await f.coordinator.tick();
    assert.equal(
      (await f.coordinator.list("alice"))[0].state,
      "unknown_outcome",
    );
    f.advance(10 * 86400000);
    await new SubscriptionCoordinator(f.engine).register(f.source).tick();
    assert.equal(f.sends(), 1);
    await assert.rejects(
      f.coordinator.resume("alice", f.row.id),
      /requires_reconciliation/,
    );
    await f.engine.disconnect("alice", f.c.id);
    await f.coordinator.tick();
    assert.equal(f.sends(), 1);
    assert.equal((await f.coordinator.list("alice"))[0].state, "blocked");
  } finally {
    await f.store.close();
  }
});
test("subscription controls require a human and route ownership is checked before scheduling", async () => {
  const f = await fixture();
  try {
    const app = createApp(f.engine, {
      authenticate: async () => ({ owner: "alice", kind: "agent" }),
      subscriptions: f.coordinator,
    });
    const response = await app.request("/v1/subscriptions", {
      method: "POST",
      headers: {
        Authorization: "Bearer synthetic",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 403);
    const ingress = new WebhookIngress(f.engine, {
        origin: "https://api.example.test",
      }),
      source = ingress
        .subscriptionSources()
        .find((x) => x.name === "gmail.watch");
    await assert.rejects(source.request({ ...f.row, routeId }), /not_found/);
    const route = await ingress.create("alice", {
      connectionId: f.c.id,
      audience: "https://api.example.test/pubsub",
      serviceEmail: "push@example.test",
    });
    const request = await source.request({ ...f.row, routeId: route.id });
    assert.equal(request.input.topicName, topic);
  } finally {
    await f.store.close();
  }
});
test("provider watches validate expiry, callback and operation-specific receipt identity", async () => {
  const ctx = {
    connection: { accountId: "account" },
    credentials: { accessToken: "synthetic" },
    signal: AbortSignal.timeout(1000),
    actionId: "a".repeat(64),
  };
  let calls = 0;
  const provider = new GoogleProvider("google-calendar", async () => {
    calls++;
    return Response.json({
      id: "wrong",
      resourceId: "r",
      expiration: String(Date.now() + 86400000),
    });
  });
  const input = {
    calendarId: "selected",
    channelId: routeId,
    address: "https://api.example.test/webhooks/owned",
    token: "s".repeat(32),
    expiresAt: Date.now() + 86400000,
  };
  await assert.rejects(
    provider.execute("calendar.watch", input, ctx),
    /watch_receipt_missing/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    provider.execute("calendar.watch", { ...input, expiresAt: 1 }, ctx),
    /subscription_expiry_invalid/,
  );
  assert.equal(calls, 1);
  let submitted;
  const graph = new OutlookProvider(async (_url, init) => {
    submitted = JSON.parse(init.body);
    return Response.json({
      id: "subscription",
      expirationDateTime: new Date(Date.now() + 86400000).toISOString(),
      clientState: "must-not-cache",
    });
  });
  const result = await graph.execute(
    "mail.subscribe",
    {
      notificationUrl: input.address,
      clientState: input.token,
      expiresAt: input.expiresAt,
    },
    ctx,
  );
  assert.equal(result.data.clientState, undefined);
  assert.equal(submitted.resource, "me/mailFolders('inbox')/messages");
});
test("pausing while a provider result is parsed prevents a stale callback binding commit", async () => {
  const f = await fixture();
  try {
    await f.coordinator.tick();
    const action = (await f.engine.actions("alice"))[0];
    await f.engine.approve("alice", action.id, action.inputDigest);
    await f.engine.runOnce();
    f.advance();
    let release,
      entered,
      commits = 0;
    const ready = new Promise((resolve) => {
        entered = resolve;
      }),
      gate = new Promise((resolve) => {
        release = resolve;
      });
    f.source.established = async () => {
      entered();
      await gate;
      return { providerId: "watch", expiresAt: f.now() + 86400000 };
    };
    f.source.commit = async () => {
      commits++;
    };
    const pending = f.coordinator.tick();
    await ready;
    await f.coordinator.pause("alice", f.row.id);
    release();
    await pending;
    assert.equal(commits, 0);
    assert.equal((await f.coordinator.list("alice"))[0].state, "paused");
  } finally {
    await f.store.close();
  }
});
