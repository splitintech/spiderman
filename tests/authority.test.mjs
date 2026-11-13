import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { Engine } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import { createApp, delegatedAuthenticator } from "@splitin/spiderman-server";
test("agent principals cannot create connections, approve actions or grant policies", async () => {
  const store = new SqliteStore(":memory:"),
    engine = new Engine(store, new EncryptedVault(store, Buffer.alloc(32, 1))),
    app = createApp(engine, {
      authenticate: async () => ({ owner: "alice", kind: "agent" }),
    });
  try {
    for (const path of [
      "/v1/connections",
      "/v1/actions/action/approve",
      "/v1/policies",
      "/v1/oauth/gmail/start",
    ]) {
      const response = await app.request("http://localhost" + path, {
        method: "POST",
        headers: {
          Authorization: "Bearer fixture",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assert.equal(response.status, 403, path);
      assert.deepEqual(await response.json(), {
        error: "human_control_required",
      });
    }
  } finally {
    await store.close();
  }
});
test("Cura delegation requires issuer, audience, subject, short lifetime and signed actor kind", async () => {
  const secret = "synthetic-delegation-secret-32-bytes-long",
    authenticate = delegatedAuthenticator(secret),
    key = new TextEncoder().encode(secret);
  const token = await new SignJWT({ actor_kind: "agent" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("alice")
    .setIssuer("splitin")
    .setAudience("spiderman")
    .setIssuedAt()
    .setExpirationTime("90s")
    .sign(key);
  assert.deepEqual(await authenticate(token), {
    owner: "alice",
    kind: "agent",
  });
  assert.equal(await authenticate(token.slice(0, -8) + "tampered"), undefined);
  const other = await new SignJWT({ actor_kind: "human" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("mallory")
    .setIssuer("other")
    .setAudience("spiderman")
    .setIssuedAt()
    .setExpirationTime("90s")
    .sign(key);
  assert.equal(await authenticate(other), undefined);
  const noExpiry = await new SignJWT({ actor_kind: "human" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("alice")
    .setIssuer("splitin")
    .setAudience("spiderman")
    .setIssuedAt()
    .sign(key);
  assert.equal(await authenticate(noExpiry), undefined);
  const longExpiry = await new SignJWT({ actor_kind: "human" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("alice")
    .setIssuer("splitin")
    .setAudience("spiderman")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
  assert.equal(await authenticate(longExpiry), undefined);
});
