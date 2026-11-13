import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, VoiceCoordinator } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import { OzzyProvider, IMessageProvider } from "@splitin/spiderman-providers";
import { createApp } from "@splitin/spiderman-server";
function setup() {
  let now = 1000,
    posts = [];
  const store = new SqliteStore(":memory:"),
    engine = new Engine(
      store,
      new EncryptedVault(store, Buffer.alloc(32, 9), () => now),
      () => now,
    );
  const http = async (url, init = {}) => {
    if (url.endsWith("/v1/voices") && init.method !== "POST")
      return Response.json([]);
    if (url.endsWith("/v1/voices")) {
      posts.push("enroll");
      return Response.json({ id: "voice" });
    }
    if (url.endsWith("/activate")) {
      posts.push("activate");
      return Response.json({ id: "voice", active: true });
    }
    if (url.endsWith("/v1/generations")) {
      const body = JSON.parse(init.body);
      posts.push(body.purpose);
      return Response.json(
        { id: body.purpose, voice_id: "voice", state: "queued" },
        { status: 202 },
      );
    }
    if (url.includes("/v1/generations/")) {
      const id = url.split("/").pop();
      return Response.json({
        id,
        voice_id: "voice",
        purpose: id,
        state: "completed",
        artifacts: [{ id: id + "-audio", kind: "wav" }],
      });
    }
    if (url.includes("/v1/artifacts/"))
      return new Response(Buffer.from("synthetic audio"), {
        headers: { "Content-Type": "audio/wav" },
      });
    throw Error("unexpected_url");
  };
  engine.register(new OzzyProvider(["https://voice.example.test"], http));
  return {
    store,
    engine,
    posts,
    advance: () => {
      now += 2000;
    },
    voice: new VoiceCoordinator(engine),
  };
}
test("voice workflow survives coordinator restart and requires exact enrollment, audition, activation and generation approvals", async () => {
  const f = setup();
  try {
    const c = await f.engine.connect("alice", "ozzy", {
      endpoint: "https://voice.example.test",
      apiKey: "synthetic",
    });
    let row = await f.voice.create("alice", {
      connectionId: c.id,
      idempotencyKey: "voice-workflow-test",
      reference: {
        name: "Synthetic",
        audioBase64: "YQ==",
        mimeType: "audio/wav",
        authorized: true,
        start: 0,
        end: 10,
      },
      script: "Synthetic script",
    });
    await f.voice.tick();
    assert.deepEqual(f.posts, []);
    assert.equal(
      (await f.engine.action("alice", row.actionId)).state,
      "awaiting_approval",
    );
    const approvals = [];
    for (let i = 0; i < 30; i++) {
      for (const a of await f.engine.actions("alice"))
        if (a.state === "awaiting_approval") {
          approvals.push(a.operation);
          await f.engine.approve("alice", a.id, a.inputDigest);
        }
      await f.engine.runOnce();
      f.advance();
      await new VoiceCoordinator(f.engine).tick();
      row = await f.voice.get("alice", row.id);
      if (row.state === "ready" || row.state === "failed") break;
    }
    assert.equal(row.state, "ready", row.error);
    assert.deepEqual(approvals, [
      "voice.enroll",
      "voice.audition",
      "voice.activate",
      "voice.generate",
    ]);
    assert.deepEqual(f.posts, ["enroll", "audition", "activate", "message"]);
    assert.equal(
      (await f.engine.artifact("alice", row.artifactActionId)).bytes.toString(),
      "synthetic audio",
    );
    await assert.rejects(
      f.engine.artifact("bob", row.artifactActionId),
      /not_found/,
    );
    await assert.rejects(f.voice.get("bob", row.id), /not_found/);
    const app = createApp(f.engine, {
      voice: f.voice,
      authenticate: async (t) => (t === "alice" ? "alice" : "bob"),
    });
    assert.equal(
      (
        await app.request("/v1/artifacts/" + row.artifactActionId, {
          headers: { Authorization: "Bearer bob" },
        })
      ).status,
      404,
    );
    const res = await app.request("/v1/artifacts/" + row.artifactActionId, {
      headers: { Authorization: "Bearer alice" },
    });
    assert.equal(res.headers.get("Content-Type"), "audio/wav");
    assert.equal(await res.text(), "synthetic audio");
  } finally {
    await f.store.close();
  }
});
test("voice workflow cancellation stops pending enrollment and never activates a voice", async () => {
  const f = setup();
  try {
    const c = await f.engine.connect("alice", "ozzy", {
        endpoint: "https://voice.example.test",
        apiKey: "synthetic",
      }),
      row = await f.voice.create("alice", {
        connectionId: c.id,
        idempotencyKey: "voice-workflow-test",
        reference: {
          name: "Synthetic",
          audioBase64: "YQ==",
          mimeType: "audio/wav",
          authorized: true,
          start: 0,
          end: 10,
        },
      });
    await f.voice.cancel("alice", row.id);
    await f.voice.tick();
    await f.engine.runOnce();
    assert.equal((await f.voice.get("alice", row.id)).state, "cancelled");
    assert.deepEqual(f.posts, []);
  } finally {
    await f.store.close();
  }
});
test("new control routes reject malformed payloads and keep omitted reconnect resources", async () => {
  const f = setup();
  try {
    const c = await f.engine.connect(
      "alice",
      "ozzy",
      { endpoint: "https://voice.example.test", apiKey: "synthetic" },
      ["voice-resource"],
    );
    const app = createApp(f.engine, {
        voice: f.voice,
        authenticate: async () => "alice",
      }),
      headers = {
        Authorization: "Bearer synthetic",
        "Content-Type": "application/json",
      };
    for (const body of [
      {},
      { connectionId: c.id, reference: null },
      { connectionId: c.id, reference: {}, origin: "invalid" },
    ])
      assert.equal(
        (
          await app.request("/v1/voice", {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          })
        ).status,
        400,
      );
    const response = await app.request(
      "/v1/connections/" + c.id + "/reconnect",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          credentials: {
            endpoint: "https://voice.example.test",
            apiKey: "rotated",
          },
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).resources, ["voice-resource"]);
  } finally {
    await f.store.close();
  }
});
test("voice workflow idempotency survives retries and rejects changed reference inputs", async () => {
  const f = setup();
  try {
    const c = await f.engine.connect("alice", "ozzy", {
        endpoint: "https://voice.example.test",
        apiKey: "synthetic",
      }),
      input = {
        connectionId: c.id,
        idempotencyKey: "voice-workflow-repeat",
        reference: {
          name: "Synthetic",
          audioBase64: "YQ==",
          mimeType: "audio/wav",
          authorized: true,
          start: 0,
          end: 10,
        },
      };
    const first = await f.voice.create("alice", input),
      same = await f.voice.create("alice", input);
    assert.equal(first.id, same.id);
    assert.equal((await f.engine.actions("alice")).length, 1);
    await assert.rejects(
      f.voice.create("alice", { ...input, script: "changed" }),
      /idempotency_conflict/,
    );
  } finally {
    await f.store.close();
  }
});
