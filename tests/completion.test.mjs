import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import {
  WhatsAppBusinessProvider,
  OzzyProvider,
  GoogleProvider,
} from "@splitin/spiderman-providers";
import { createApp } from "@splitin/spiderman-server";

test("revocation after queue claim prevents an unwrapped WhatsApp send", async () => {
  const store = new SqliteStore(":memory:"),
    base = new EncryptedVault(store, Buffer.alloc(32, 1));
  let engine,
    ref,
    policyId,
    sends = 0,
    revoke = false;
  const vault = {
    put: (...a) => base.put(...a),
    delete: (...a) => base.delete(...a),
    purge: () => base.purge(),
    get: async (owner, key) => {
      const value = await base.get(owner, key);
      if (revoke && key === ref) {
        revoke = false;
        await engine.removePolicy(owner, policyId);
      }
      return value;
    },
  };
  engine = new Engine(store, vault).register(
    new WhatsAppBusinessProvider("v99.0", async (url, init) => {
      if (init?.method === "POST") {
        sends++;
        return Response.json({ messages: [{ id: "synthetic" }] });
      }
      return Response.json({ id: "123" });
    }),
  );
  try {
    const c = await engine.connect("alice", "whatsapp-business", {
      phoneNumberId: "123",
      accessToken: "synthetic",
    });
    ref = (await engine.connection("alice", c.id)).credentialRef;
    policyId = (
      await engine.policy("alice", {
        connectionId: c.id,
        operations: ["message.send"],
        recipients: ["+12125550123"],
        resources: [],
        expiresAt: Date.now() + 60000,
        maxActions: 1,
      })
    ).id;
    await engine.submit("alice", {
      connectionId: c.id,
      operation: "message.send",
      input: { recipient: "+12125550123", text: "synthetic" },
      idempotencyKey: "revocation-regression",
    });
    revoke = true;
    const result = await engine.runOnce();
    assert.equal(result.state, "failed");
    assert.equal(result.error, "policy_revoked");
    assert.equal(sends, 0);
  } finally {
    await store.close();
  }
});
test("Ozzy HTTP 202 preserves job identity and malformed accepted jobs are uncertain", async () => {
  const context = {
    connection: { accountId: "https://voice.example.test" },
    credentials: {
      endpoint: "https://voice.example.test",
      apiKey: "synthetic",
    },
    idempotencyKey: "job-regression",
    actionId: "a".repeat(64),
    signal: AbortSignal.timeout(1000),
  };
  const p = new OzzyProvider(["https://voice.example.test"], async () =>
    Response.json(
      { id: "job-123", state: "queued", voice_id: "voice-123" },
      { status: 202 },
    ),
  );
  const result = await p.execute(
    "voice.generate",
    { voiceId: "voice-123", text: "Synthetic only" },
    context,
  );
  assert.equal(result.providerId, "job-123");
  assert.equal(result.data.state, "queued");
  const bad = new OzzyProvider(
    ["https://voice.example.test"],
    async () => new Response(null, { status: 202 }),
  );
  await assert.rejects(
    bad.execute(
      "voice.generate",
      { voiceId: "voice-123", text: "Synthetic" },
      context,
    ),
    (e) => e.code === "voice_job_receipt_missing" && e.uncertain,
  );
});
test("Gmail malformed post-submit success cannot become a successful receipt", async () => {
  const p = new GoogleProvider("gmail", async () => Response.json({}));
  const raw = Buffer.from(
    "From: alice@example.test\r\nTo: bob@example.test\r\n\r\nSynthetic",
  ).toString("base64url");
  await assert.rejects(
    p.execute(
      "mail.send",
      { raw, recipients: ["bob@example.test"] },
      {
        connection: { accountId: "alice@example.test" },
        credentials: { accessToken: "synthetic" },
        signal: AbortSignal.timeout(1000),
      },
    ),
    (e) => e.code === "provider_receipt_missing" && e.uncertain,
  );
});
test("approval expiration during Ozzy preflight prevents activation POST", async () => {
  const store = new SqliteStore(":memory:");
  let now = 1000,
    posts = 0;
  const engine = new Engine(
    store,
    new EncryptedVault(store, Buffer.alloc(32, 1), () => now),
    () => now,
  ).register(
    new OzzyProvider(["https://voice.example.test"], async (url, init) => {
      if (url.endsWith("/v1/voices")) return Response.json([]);
      if (init.method === "GET") {
        now += 2;
        return Response.json({
          id: "audition",
          state: "completed",
          voice_id: "voice",
          purpose: "audition",
        });
      }
      posts++;
      return Response.json({ id: "voice" });
    }),
  );
  try {
    const c = await engine.connect("alice", "ozzy", {
        endpoint: "https://voice.example.test",
        apiKey: "synthetic",
      }),
      a = await engine.submit("alice", {
        connectionId: c.id,
        operation: "voice.activate",
        input: { voiceId: "voice", auditionJobId: "audition", approved: true },
        idempotencyKey: "activation-regression",
      });
    await engine.approve("alice", a.id, a.inputDigest);
    now += 899999;
    const r = await engine.runOnce();
    assert.equal(r.state, "failed");
    assert.equal(r.error, "approval_expired");
    assert.equal(posts, 0);
  } finally {
    await store.close();
  }
});
test("voice reference staging expires after one hour", async () => {
  let now = 1000;
  const store = new SqliteStore(":memory:"),
    vault = new EncryptedVault(store, Buffer.alloc(32, 1), () => now),
    engine = new Engine(store, vault, () => now).register(
      new OzzyProvider(["https://voice.example.test"], async () =>
        Response.json([]),
      ),
    );
  try {
    const c = await engine.connect("alice", "ozzy", {
        endpoint: "https://voice.example.test",
        apiKey: "synthetic",
      }),
      a = await engine.submit("alice", {
        connectionId: c.id,
        operation: "voice.enroll",
        input: {
          name: "synthetic",
          audioBase64: "YQ==",
          mimeType: "audio/wav",
          authorized: true,
          start: 0,
          end: 10,
        },
        idempotencyKey: "staging-regression",
      });
    const secret = await store.transaction((tx) =>
      tx.get("secret", a.inputRef),
    );
    assert.equal(secret.expiresAt - a.createdAt, 3600000);
    now += 3600001;
    await assert.rejects(engine.preview("alice", a.id), /secret_unavailable/);
  } finally {
    await store.close();
  }
});
test("readiness detects closed storage; liveness is separate and v1 is authenticated", async () => {
  const store = new SqliteStore(":memory:"),
    engine = new Engine(store, new EncryptedVault(store, Buffer.alloc(32, 1))),
    app = createApp(engine, { authenticate: async () => "alice" });
  assert.equal((await app.request("http://localhost/health")).status, 200);
  assert.equal((await app.request("http://localhost/v1/health")).status, 401);
  await store.close();
  assert.equal((await app.request("http://localhost/health")).status, 503);
  assert.equal(
    (
      await app.request("http://localhost/v1/health", {
        headers: { Authorization: "Bearer synthetic" },
      })
    ).status,
    503,
  );
  assert.equal((await app.request("http://localhost/live")).status, 200);
});
