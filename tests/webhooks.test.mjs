import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Engine } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import { WhatsAppBusinessProvider } from "@splitin/spiderman-providers";
import { WebhookIngress, createApp } from "@splitin/spiderman-server";
async function setup() {
  const store = new SqliteStore(":memory:"),
    engine = new Engine(
      store,
      new EncryptedVault(store, Buffer.alloc(32, 1)),
    ).register(
      new WhatsAppBusinessProvider("v99.0", async () =>
        Response.json({ id: "123" }),
      ),
    );
  const c = await engine.connect("alice", "whatsapp-business", {
      phoneNumberId: "123",
      accessToken: "synthetic",
    }),
    ingress = new WebhookIngress(engine, {
      origin: "https://api.example.test",
    }),
    route = await ingress.create("alice", {
      connectionId: c.id,
      secret: "s".repeat(32),
    });
  return { store, engine, c, ingress, route };
}
const payload = (id = "message-1", account = "123") =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: account },
              messages: [
                { id, from: "12125550123", text: { body: "synthetic" } },
              ],
            },
          },
        ],
      },
    ],
  });
function request(route, body, secret = "s".repeat(32)) {
  return new Request(route.url, {
    method: "POST",
    headers: {
      "x-hub-signature-256":
        "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
    },
    body,
  });
}
test("verified webhook persists once before acknowledgment and cannot select another account or owner", async () => {
  const f = await setup();
  try {
    assert.equal(
      (await f.ingress.receive(f.route.id, request(f.route, payload())))
        .accepted,
      1,
    );
    await f.ingress.receive(f.route.id, request(f.route, payload()));
    assert.equal((await f.engine.events("alice")).length, 1);
    assert.equal((await f.engine.events("bob")).length, 0);
    await assert.rejects(
      f.ingress.receive(
        f.route.id,
        request(f.route, payload("tampered"), "wrong"),
      ),
      /webhook_signature_invalid/,
    );
    await assert.rejects(
      f.ingress.receive(
        f.route.id,
        request(f.route, payload("foreign", "999")),
      ),
      /webhook_account_mismatch/,
    );
    await assert.rejects(
      f.ingress.bind("bob", f.route.id, { resourceId: "foreign" }),
      /not_found/,
    );
    await f.engine.disconnect("alice", f.c.id);
    await assert.rejects(
      f.ingress.receive(f.route.id, request(f.route, payload("later"))),
      /webhook_unavailable/,
    );
    assert.equal((await f.ingress.list("alice")).length, 0);
  } finally {
    await f.store.close();
  }
});
test("webhook storage failure prevents acknowledgment and retry remains safe", async () => {
  const f = await setup();
  try {
    const original = f.engine.ingest.bind(f.engine);
    f.engine.ingest = async () => {
      throw Error("storage_unavailable");
    };
    await assert.rejects(
      f.ingress.receive(f.route.id, request(f.route, payload())),
      /storage_unavailable/,
    );
    f.engine.ingest = original;
    await f.ingress.receive(f.route.id, request(f.route, payload()));
    assert.equal((await f.engine.events("alice")).length, 1);
  } finally {
    await f.store.close();
  }
});
test("delegated agents cannot create or change webhook controls", async () => {
  const f = await setup();
  try {
    const app = createApp(f.engine, {
      authenticate: async () => ({ owner: "alice", kind: "agent" }),
      webhookOrigin: "https://api.example.test",
    });
    const response = await app.request("/v1/webhooks", {
      method: "POST",
      headers: {
        Authorization: "Bearer synthetic",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ connectionId: f.c.id, secret: "s".repeat(32) }),
    });
    assert.equal(response.status, 403);
  } finally {
    await f.store.close();
  }
});
test("permission edits invalidate callback enrollment even when they race durable event persistence", async () => {
  const f = await setup();
  try {
    const ingest = f.engine.ingest.bind(f.engine);
    f.engine.ingest = async (...args) => {
      await f.engine.resources("alice", f.c.id, []);
      return ingest(...args);
    };
    await assert.rejects(
      f.ingress.receive(f.route.id, request(f.route, payload("revoked"))),
      /webhook_unavailable/,
    );
    assert.equal((await f.engine.events("alice")).length, 0);
    f.engine.ingest = ingest;
    await assert.rejects(
      f.ingress.receive(f.route.id, request(f.route, payload("still-revoked"))),
      /webhook_unavailable/,
    );
    await f.ingress.bind("alice", f.route.id, {});
    await f.ingress.receive(
      f.route.id,
      request(f.route, payload("re-enrolled")),
    );
    assert.equal((await f.engine.events("alice")).length, 1);
  } finally {
    await f.store.close();
  }
});
