import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Engine } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import { PlivoProvider } from "@splitin/spiderman-providers";
import { WebhookIngress } from "@splitin/spiderman-server";
const callId = "11111111-1111-4111-8111-111111111111";
test("phone connection verifies owned caller identity and call actions constrain audio, destinations and recording", async () => {
  let writes = 0;
  const p = new PlivoProvider(
    ["https://calls.example.test"],
    async (url, init = {}) => {
      if (init.method === "POST") {
        writes++;
        return Response.json({ api_id: "request", request_uuid: callId });
      }
      return Response.json(
        url.includes("/Number/")
          ? { number: "12125550100" }
          : { auth_id: "account" },
      );
    },
    ["https://audio.example.test"],
  );
  await p.verify({
    authId: "account",
    authToken: "synthetic",
    from: "+12125550100",
  });
  const ctx = {
    connection: { accountId: "account" },
    credentials: {
      authId: "account",
      authToken: "synthetic",
      from: "+12125550100",
    },
    signal: AbortSignal.timeout(1000),
    actionId: "a".repeat(64),
  };
  await assert.rejects(
    p.execute(
      "call.create",
      {
        recipient: "+442012345678",
        answerUrl: "https://calls.example.test/answer",
      },
      ctx,
    ),
    /call_destination_denied/,
  );
  await assert.rejects(
    p.execute(
      "call.play",
      { callId, audioUrl: "https://attacker.invalid/file.wav" },
      ctx,
    ),
    /call_audio_url_denied/,
  );
  await assert.rejects(
    p.execute("call.recordStart", { callId, consent: true }, ctx),
    /recording_not_enabled/,
  );
  assert.equal(writes, 0);
  assert.equal(
    (
      await p.execute(
        "call.play",
        { callId, audioUrl: "https://audio.example.test/synthetic.wav" },
        ctx,
      )
    ).providerId,
    "request",
  );
  assert.equal(writes, 1);
});
test("Plivo V3 callbacks use the configured public URL and persist before bounded inbound XML without exposing provider secrets", async () => {
  const store = new SqliteStore(":memory:"),
    engine = new Engine(
      store,
      new EncryptedVault(store, Buffer.alloc(32, 1)),
    ).register(
      new PlivoProvider([], async (url) =>
        Response.json(
          url.includes("/Number/")
            ? { number: "12125550100" }
            : { auth_id: "account" },
        ),
      ),
    );
  try {
    const secret = "p".repeat(32),
      c = await engine.connect("alice", "plivo", {
        authId: "account",
        authToken: secret,
        from: "+12125550100",
      }),
      ingress = new WebhookIngress(engine, {
        origin: "https://calls.example.test",
      }),
      route = await ingress.create("alice", {
        connectionId: c.id,
        inboundWaitSeconds: 15,
      });
    assert.equal(route.verificationSecret, undefined);
    const values = {
        CallStatus: "ringing",
        CallUUID: callId,
        Direction: "inbound",
        From: "+12125550123",
        To: "+12125550100",
      },
      nonce = "synthetic-nonce";
    const canonical =
        route.url +
        "?" +
        Object.keys(values)
          .sort()
          .map((k) => k + values[k])
          .join("") +
        "." +
        nonce,
      signature = createHmac("sha256", secret)
        .update(canonical)
        .digest("base64");
    const request = () =>
      new Request("http://internal-proxy/webhooks/" + route.id, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-plivo-signature-v3-nonce": nonce,
          "x-plivo-signature-v3": signature,
        },
        body: new URLSearchParams(values),
      });
    assert.equal(
      (await ingress.receive(route.id, request())).xml,
      '<Response><Wait length="15"/><Hangup/></Response>',
    );
    await ingress.receive(route.id, request());
    assert.equal((await engine.events("alice")).length, 1);
    const forged = request();
    forged.headers.set("x-plivo-signature-v3", "forged");
    await assert.rejects(
      ingress.receive(route.id, forged),
      /webhook_signature_invalid/,
    );
    assert.equal((await engine.events("bob")).length, 0);
  } finally {
    await store.close();
  }
});
