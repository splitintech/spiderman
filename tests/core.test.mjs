import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Engine } from "@splitin/spiderman-core";
import { ConnectorError } from "@splitin/spiderman-contracts";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import { createApp } from "@splitin/spiderman-server";
import { SpidermanClient } from "@splitin/spiderman-sdk";
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), "spiderman-"));
  const path = join(dir, "test.db"),
    store = new SqliteStore(path);
  let time = 1000000,
    calls = 0,
    behavior = "success";
  const vault = new EncryptedVault(store, Buffer.alloc(32, 1), () => time);
  const provider = {
    manifest: {
      provider: "fixture",
      version: "1",
      qualification: "automated_only",
      operations: [
        {
          name: "read",
          risk: "read",
          scopes: ["read"],
          input: z.object({}).strict(),
        },
        {
          name: "send",
          risk: "write",
          scopes: ["write"],
          input: z.object({ recipient: z.email(), text: z.string() }).strict(),
          recipientKeys: ["recipient"],
        },
      ],
    },
    verify: async () => ({
      accountId: "owned@example.test",
      scopes: ["read", "write"],
    }),
    execute: async (_op, input) => {
      calls++;
      if (behavior === "uncertain")
        throw new ConnectorError("transport_lost", true);
      return {
        providerId: "fixture-" + calls,
        data: { text: input.text ?? "read result" },
      };
    },
  };
  const engine = new Engine(store, vault, () => time).register(provider);
  try {
    await run({
      engine,
      store,
      vault,
      path,
      setTime: (value) => {
        time = value;
      },
      calls: () => calls,
      setBehavior: (value) => {
        behavior = value;
      },
    });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const connect = (e) =>
  e.connect("alice", "fixture", { token: "secret-provider-token" });
const request = (c, key = "request-key-1") => ({
  connectionId: c.id,
  operation: "send",
  input: { recipient: "bob@example.test", text: "private action content" },
  idempotencyKey: key,
});
test("connection identity is provider verified and credentials never returned", () =>
  fixture(async ({ engine, path }) => {
    const c = await connect(engine);
    assert.equal(c.accountId, "owned@example.test");
    assert.equal(c.credentialRef, "[protected]");
    const raw = await readFile(path);
    assert.equal(raw.includes(Buffer.from("secret-provider-token")), false);
    assert.equal((await engine.connections("bob")).length, 0);
    await assert.rejects(engine.capabilities("bob", c.id), /not_found/);
  }));
test("write requires exact approval; rejected approval does not dispatch", () =>
  fixture(async ({ engine, calls }) => {
    const c = await connect(engine),
      a = await engine.submit("alice", request(c));
    assert.equal(a.state, "awaiting_approval");
    assert.equal(await engine.runOnce(), undefined);
    await assert.rejects(
      engine.approve("bob", a.id, a.inputDigest),
      /not_found/,
    );
    await assert.rejects(
      engine.approve("alice", a.id, "changed"),
      /approval_digest_mismatch/,
    );
    assert.equal(calls(), 0);
    await engine.approve("alice", a.id, a.inputDigest);
    const done = await engine.runOnce();
    assert.equal(done.state, "succeeded");
    assert.deepEqual(await engine.result("alice", a.id), {
      text: "private action content",
    });
    assert.equal(calls(), 1);
    await assert.rejects(engine.result("bob", a.id), /not_found/);
  }));
test("idempotency conflict cannot overwrite approved content", () =>
  fixture(async ({ engine }) => {
    const c = await connect(engine),
      a = await engine.submit("alice", request(c));
    await engine.approve("alice", a.id, a.inputDigest);
    await assert.rejects(
      engine.submit("alice", {
        ...request(c),
        input: { recipient: "mallory@example.test", text: "changed" },
      }),
      /idempotency_conflict/,
    );
    await engine.runOnce();
    assert.deepEqual(await engine.result("alice", a.id), {
      text: "private action content",
    });
    assert.equal((await engine.submit("alice", request(c))).id, a.id);
  }));
test("disconnect cancels durable queued and awaiting work and deletes credentials", () =>
  fixture(async ({ engine, vault, calls }) => {
    const c = await connect(engine),
      actual = await engine.connection("alice", c.id);
    const a = await engine.submit("alice", request(c));
    await engine.approve("alice", a.id, a.inputDigest);
    await engine.disconnect("alice", c.id);
    assert.equal((await engine.action("alice", a.id)).state, "cancelled");
    await assert.rejects(
      vault.get("alice", actual.credentialRef),
      /secret_unavailable/,
    );
    assert.equal(await engine.runOnce(), undefined);
    assert.equal(calls(), 0);
  }));
test("expired approval must be renewed", () =>
  fixture(async ({ engine, setTime, calls }) => {
    const c = await connect(engine),
      a = await engine.submit("alice", request(c));
    await engine.approve("alice", a.id, a.inputDigest);
    setTime(2000000);
    await engine.runOnce();
    assert.equal(
      (await engine.action("alice", a.id)).state,
      "awaiting_approval",
    );
    assert.equal(calls(), 0);
  }));
test("bounded standing rule binds recipient and usage and is revocable", () =>
  fixture(async ({ engine }) => {
    const c = await connect(engine),
      p = await engine.policy("alice", {
        connectionId: c.id,
        operations: ["send"],
        recipients: ["bob@example.test"],
        resources: [],
        expiresAt: 1500000,
        maxActions: 1,
      });
    const first = await engine.submit("alice", request(c)),
      second = await engine.submit("alice", request(c, "request-key-2"));
    assert.equal(first.state, "queued");
    assert.equal(second.state, "awaiting_approval");
    await engine.removePolicy("alice", p.id);
    await engine.runOnce();
    assert.equal(
      (await engine.action("alice", first.id)).state,
      "awaiting_approval",
    );
  }));
test("uncertain send is held and never blindly retried", () =>
  fixture(async ({ engine, setBehavior, calls }) => {
    const c = await connect(engine),
      a = await engine.submit("alice", request(c));
    await engine.approve("alice", a.id, a.inputDigest);
    setBehavior("uncertain");
    assert.equal((await engine.runOnce()).state, "unknown_outcome");
    assert.equal(await engine.runOnce(), undefined);
    assert.equal(calls(), 1);
  }));
test("two engines sharing sqlite cannot claim the same action", () =>
  fixture(async ({ engine, store, vault, path, calls }) => {
    const c = await connect(engine),
      a = await engine.submit("alice", request(c));
    await engine.approve("alice", a.id, a.inputDigest);
    const secondStore = new SqliteStore(path),
      second = new Engine(secondStore, vault, engine.now).register(
        engine.provider("fixture"),
      );
    try {
      await Promise.all([engine.runOnce(), second.runOnce()]);
      assert.equal(calls(), 1);
    } finally {
      await secondStore.close();
    }
  }));
test("expired worker lease becomes uncertain without another send", () =>
  fixture(async ({ engine, store, setTime, calls }) => {
    const c = await connect(engine),
      a = await engine.submit("alice", request(c));
    await store.transaction(async (tx) => {
      const row = await tx.get("action", a.id);
      await tx.put("action", a.id, "alice", {
        ...row,
        state: "running",
        leaseToken: "dead-worker",
        leaseUntil: 1000001,
      });
    });
    setTime(1000002);
    await engine.runOnce();
    assert.equal((await engine.action("alice", a.id)).state, "unknown_outcome");
    assert.equal(calls(), 0);
  }));
test("vault is authenticated to owner and expiry, and purges expired content", () =>
  fixture(async ({ vault, setTime }) => {
    const ref = await vault.put(
      "alice",
      "content",
      { private: "text" },
      1000001,
    );
    await assert.rejects(vault.get("bob", ref), /secret_unavailable/);
    setTime(1000002);
    await assert.rejects(vault.get("alice", ref), /secret_unavailable/);
    assert.equal(await vault.purge(), 1);
  }));
test("HTTP + SDK use the same owner and approval path", () =>
  fixture(async ({ engine }) => {
    const app = createApp(engine, {
      authenticate: async (token) =>
        token === "alice-token"
          ? "alice"
          : token === "bob-token"
            ? "bob"
            : undefined,
    });
    const http = async (url, init) => app.request(String(url), init);
    const alice = new SpidermanClient(
        "http://localhost",
        () => "alice-token",
        http,
      ),
      bob = new SpidermanClient("http://localhost", () => "bob-token", http);
    const c = await alice.connect("fixture", { token: "hidden" }),
      a = await alice.submit(request(c));
    assert.equal(a.state, "awaiting_approval");
    assert.equal((await bob.connections()).length, 0);
    await assert.rejects(bob.action(a.id), /not_found/);
    await alice.approve(a.id, a.inputDigest);
    await engine.runOnce();
    assert.equal((await alice.action(a.id)).state, "succeeded");
    const denied = await app.request("http://localhost/v1/connections");
    assert.equal(denied.status, 401);
    const origin = await app.request("http://localhost/v1/connections", {
      headers: {
        Authorization: "Bearer alice-token",
        Origin: "https://attacker.invalid",
      },
    });
    assert.equal(origin.status, 403);
  }));
test("1000 queued reads survive durable submission and execute once", () =>
  fixture(async ({ engine, calls }) => {
    const c = await connect(engine);
    await engine.limits("alice", c.id, {
      maxActionsPerMinute: 1000,
      maxQueued: 1000,
      maxCallSecondsPerDay: 0,
      unitCostMicros: {},
    });
    for (let i = 0; i < 1000; i++)
      await engine.submit("alice", {
        connectionId: c.id,
        operation: "read",
        input: {},
        idempotencyKey: "backlog-" + i,
      });
    for (let i = 0; i < 1000; i++)
      assert.equal((await engine.runOnce()).state, "succeeded");
    assert.equal(await engine.runOnce(), undefined);
    assert.equal(calls(), 1000);
  }));
