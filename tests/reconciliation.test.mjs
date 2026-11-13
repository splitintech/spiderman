import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, ReconciliationCoordinator } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import {
  GoogleProvider,
  googleReconciliationStrategies,
} from "@splitin/spiderman-providers";
async function fixture(found = true) {
  const store = new SqliteStore(":memory:");
  let sends = 0,
    actionId,
    storedMime;
  const engine = new Engine(
    store,
    new EncryptedVault(store, Buffer.alloc(32, 1)),
  ).register(
    new GoogleProvider("gmail", async (url, init = {}) => {
      if (url.includes("tokeninfo"))
        return Response.json({
          email: "alice@example.test",
          scope: "https://www.googleapis.com/auth/gmail.modify",
        });
      if (url.endsWith("/messages/send")) {
        sends++;
        storedMime = Buffer.from(
          JSON.parse(init.body).raw,
          "base64url",
        ).toString();
        throw Error("lost_receipt");
      }
      if (url.includes("/messages?"))
        return Response.json({ messages: found ? [{ id: "sent" }] : [] });
      return Response.json({
        id: "sent",
        labelIds: ["SENT"],
        payload: {
          headers: [
            { name: "Message-ID", value: "<" + actionId + "@spiderman.local>" },
          ],
        },
      });
    }),
  );
  const coordinator = new ReconciliationCoordinator(engine);
  for (const strategy of googleReconciliationStrategies())
    coordinator.register(strategy);
  const c = await engine.connect("alice", "gmail", {
      accessToken: "synthetic",
    }),
    a = await engine.submit("alice", {
      connectionId: c.id,
      operation: "mail.send",
      input: {
        recipients: ["bob@example.test"],
        subject: "synthetic",
        text: "Message-ID: body text must stay",
      },
      idempotencyKey: "reconcile-test",
    });
  actionId = a.id;
  await engine.approve("alice", a.id, a.inputDigest);
  await engine.runOnce();
  return {
    store,
    engine,
    coordinator,
    a,
    c,
    sends: () => sends,
    mime: () => storedMime,
  };
}
test("uncertain Gmail send is reconciled from Sent evidence without repeating provider dispatch", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.engine.action("alice", f.a.id)).state,
      "unknown_outcome",
    );
    assert.match(f.mime(), new RegExp("Message-ID: <" + f.a.id));
    const row = await f.coordinator.create("alice", f.a.id);
    await f.engine.runOnce();
    await f.coordinator.tick();
    assert.equal((await f.engine.action("alice", f.a.id)).state, "succeeded");
    assert.equal((await f.engine.action("alice", f.a.id)).providerId, "sent");
    assert.equal((await f.coordinator.list("alice"))[0].state, "matched");
    assert.equal(f.sends(), 1);
    await assert.rejects(f.coordinator.create("bob", f.a.id), /not_found/);
  } finally {
    await f.store.close();
  }
});
test("an inconclusive reconciliation holds uncertainty rather than resending", async () => {
  const f = await fixture(false);
  try {
    await f.coordinator.create("alice", f.a.id);
    await f.engine.runOnce();
    await f.coordinator.tick();
    assert.equal(
      (await f.engine.action("alice", f.a.id)).state,
      "unknown_outcome",
    );
    assert.equal((await f.coordinator.list("alice"))[0].state, "inconclusive");
    assert.equal(f.sends(), 1);
  } finally {
    await f.store.close();
  }
});
