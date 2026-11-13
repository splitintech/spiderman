import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Engine } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import { createApp, installOAuth } from "@splitin/spiderman-server";
test("OAuth binds owner, browser, PKCE and one-use state before creating a verified connection", async () => {
  const store = new SqliteStore(":memory:"),
    engine = new Engine(store, new EncryptedVault(store, Buffer.alloc(32, 4)));
  let exchanged;
  engine.register({
    manifest: {
      provider: "gmail",
      version: "1",
      qualification: "automated_only",
      operations: [],
    },
    verify: async (c) => {
      assert.equal(c.accessToken, "fixture-access");
      return { accountId: "verified@example.test", scopes: ["read"] };
    },
    execute: async () => ({ data: {} }),
  });
  const app = createApp(engine, {
    authenticate: async (token) => (token === "alice" ? "alice" : undefined),
  });
  installOAuth(app, engine, {
    origin: "http://localhost",
    google: { clientId: "fixture-client", clientSecret: "fixture-secret" },
    http: async (_url, init) => {
      exchanged = new URLSearchParams(init.body);
      return Response.json({
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        expires_in: 3600,
      });
    },
  });
  try {
    const start = await app.request("http://localhost/v1/oauth/gmail/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer alice",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(start.status, 200);
    const { authorizationUrl } = await start.json();
    const cookie = start.headers.get("set-cookie").split(";")[0];
    assert.equal((await app.request(authorizationUrl)).status, 400);
    const authorization = await app.request(authorizationUrl, {
      headers: { Cookie: cookie },
    });
    assert.equal(authorization.status, 302);
    const remote = new URL(authorization.headers.get("location"));
    assert.equal(remote.origin, "https://accounts.google.com");
    assert.equal(remote.searchParams.get("code_challenge_method"), "S256");
    const state = remote.searchParams.get("state");
    const withoutCookie = await app.request(
      "http://localhost/oauth/callback?state=" + state + "&code=fixture",
    );
    assert.equal(withoutCookie.status, 400);
    assert.equal(exchanged, undefined);
    const callback = await app.request(
      "http://localhost/oauth/callback?state=" + state + "&code=fixture",
      { headers: { Cookie: cookie } },
    );
    assert.equal(callback.status, 200);
    assert.ok(exchanged.get("code_verifier"));
    assert.equal(
      exchanged.get("redirect_uri"),
      "http://localhost/oauth/callback",
    );
    const owned = await engine.connections("alice");
    assert.equal(owned.length, 1);
    assert.equal(owned[0].accountId, "verified@example.test");
    assert.equal((await engine.connections("mallory")).length, 0);
    const replay = await app.request(
      "http://localhost/oauth/callback?state=" + state + "&code=fixture",
      { headers: { Cookie: cookie } },
    );
    assert.equal(replay.status, 400);
  } finally {
    await store.close();
  }
});
