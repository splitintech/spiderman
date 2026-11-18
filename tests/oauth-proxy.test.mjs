import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
import { createApp, installOAuth } from "@splitin/spiderman-server";

function fixture(provider = "gmail", exchange) {
  const store = new SqliteStore(":memory:"),
    engine = new Engine(store, new EncryptedVault(store, Buffer.alloc(32, 4)));
  let exchanges = 0;
  engine.register({
    manifest: {
      provider,
      version: "1",
      qualification: "automated_only",
      operations: [],
    },
    verify: async () => ({ accountId: "verified-account", scopes: [] }),
    execute: async () => ({ data: {} }),
  });
  const app = createApp(engine, {
    authenticate: async (token) =>
      token === "agent"
        ? { owner: "alice", kind: "agent" }
        : ["alice", "bob"].includes(token)
          ? token
          : undefined,
  });
  installOAuth(app, engine, {
    origin: "http://localhost",
    google: { clientId: "fixture-client", clientSecret: "synthetic-secret" },
    microsoft: { clientId: "fixture-client", clientSecret: "synthetic-secret" },
    http: async (...args) => {
      exchanges++;
      return exchange
        ? exchange(...args)
        : Response.json({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          });
    },
  });
  const request = (path, body, owner = "alice", cookie) =>
    app.request("http://localhost" + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + owner,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  return {
    store,
    engine,
    app,
    request,
    exchanges: () => exchanges,
    start: async (input) => {
      const response = await request(
        "/v1/oauth/" + provider + "/start",
        input ?? {},
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      return {
        state: new URL(body.authorizationUrl).pathname.split("/").at(-1),
        cookie: response.headers.get("set-cookie").split(";")[0],
      };
    },
  };
}

for (const provider of ["gmail", "outlook"])
  test(
    "application OAuth requires the current owner, nonce and human principal: " +
      provider,
    async () => {
      const f = fixture(provider);
      try {
        const s = await f.start();
        assert.equal(
          (
            await f.request(
              "/v1/oauth/authorize",
              { state: s.state },
              "bob",
              s.cookie,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await f.request(
              "/v1/oauth/complete",
              { state: s.state, code: "fixture" },
              "bob",
              s.cookie,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await f.request(
              "/v1/oauth/complete",
              { state: s.state, code: "fixture" },
              "agent",
              s.cookie,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await f.request("/v1/oauth/complete", {
              state: s.state,
              code: "fixture",
            })
          ).status,
          400,
        );
        assert.equal(f.exchanges(), 0);
        const authorization = await f.request(
          "/v1/oauth/authorize",
          { state: s.state },
          "alice",
          s.cookie,
        );
        const remote = new URL((await authorization.json()).authorizationUrl);
        assert.equal(
          remote.hostname,
          provider === "gmail"
            ? "accounts.google.com"
            : "login.microsoftonline.com",
        );
        const response = await f.request(
          "/v1/oauth/complete",
          { state: s.state, code: "fixture" },
          "alice",
          s.cookie,
        );
        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, "connected");
        assert.equal(f.exchanges(), 1);
        assert.equal((await f.engine.connections("alice")).length, 1);
        assert.deepEqual(await f.engine.connections("bob"), []);
        assert.equal(
          (
            await f.request(
              "/v1/oauth/complete",
              { state: s.state, code: "fixture" },
              "alice",
              s.cookie,
            )
          ).status,
          400,
        );
        assert.equal(f.exchanges(), 1);
      } finally {
        await f.store.close();
      }
    },
  );

test("an OAuth reconnect cannot restore resources withdrawn after authorization started", async () => {
  const f = fixture();
  try {
    const connection = await f.engine.connect(
      "alice",
      "gmail",
      {
        accessToken: "old",
        refreshToken: "old-refresh",
        clientId: "fixture-client",
      },
      ["old-resource"],
    );
    const s = await f.start({ connectionId: connection.id });
    await f.engine.resources("alice", connection.id, ["new-resource"]);
    assert.equal(
      (
        await f.request(
          "/v1/oauth/complete",
          { state: s.state, code: "fixture" },
          "alice",
          s.cookie,
        )
      ).status,
      409,
    );
    assert.equal(f.exchanges(), 0);
    assert.deepEqual(
      (await f.engine.connection("alice", connection.id)).resources,
      ["new-resource"],
    );
  } finally {
    await f.store.close();
  }
});

test("a resource edit during token exchange is rechecked before reconnection commits", async () => {
  let entered, release;
  const ready = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  const f = fixture("gmail", async () => {
    entered();
    await gate;
    return Response.json({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
  });
  try {
    const connection = await f.engine.connect(
        "alice",
        "gmail",
        { accessToken: "old", refreshToken: "old-refresh" },
        ["old-resource"],
      ),
      s = await f.start({ connectionId: connection.id });
    const pending = f.request(
      "/v1/oauth/complete",
      { state: s.state, code: "fixture" },
      "alice",
      s.cookie,
    );
    await ready;
    await f.engine.resources("alice", connection.id, ["new-resource"]);
    release();
    assert.equal((await pending).status, 409);
    const current = await f.engine.connection("alice", connection.id);
    assert.deepEqual(current.resources, ["new-resource"]);
    assert.equal(
      (await f.engine.vault.get("alice", current.credentialRef)).accessToken,
      "old",
    );
  } finally {
    release();
    await f.store.close();
  }
});

test("cancelling an exchanging OAuth flow prevents a late connection and cleans credentials", async () => {
  let entered, release;
  const ready = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  const f = fixture("gmail", async () => {
    entered();
    await gate;
    return Response.json({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
  });
  try {
    const s = await f.start(),
      pending = f.request(
        "/v1/oauth/complete",
        { state: s.state, code: "fixture" },
        "alice",
        s.cookie,
      );
    await ready;
    const cancellation = await f.app.request(
      "http://localhost/v1/oauth/" + s.state,
      { method: "DELETE", headers: { Authorization: "Bearer alice" } },
    );
    assert.equal(cancellation.status, 200);
    release();
    assert.equal((await pending).status, 409);
    assert.deepEqual(await f.engine.connections("alice"), []);
    assert.deepEqual(
      await f.store.transaction((tx) => tx.list("secret", "alice")),
      [],
    );
  } finally {
    release();
    await f.store.close();
  }
});

test("fresh consent reconnects a disconnected account and rejects another active owner binding", async () => {
  const f = fixture();
  try {
    const connection = await f.engine.connect(
      "alice",
      "gmail",
      { accessToken: "old" },
      [],
    );
    await f.engine.disconnect("alice", connection.id);
    const s = await f.start({ connectionId: connection.id });
    assert.equal(
      (
        await f.request(
          "/v1/oauth/complete",
          { state: s.state, code: "fixture" },
          "alice",
          s.cookie,
        )
      ).status,
      200,
    );
    await f.engine.disconnect("alice", connection.id);
    await f.engine.connect("bob", "gmail", { accessToken: "bob" }, []);
    await assert.rejects(
      f.engine.reconnect("alice", connection.id, { accessToken: "new" }),
      /account_already_bound/,
    );
    assert.equal(
      (await f.engine.connection("alice", connection.id)).status,
      "disconnected",
    );
    assert.equal((await f.engine.connections("bob")).length, 1);
  } finally {
    await f.store.close();
  }
});

test("denied and malformed grants consume state and remove PKCE secrets without connecting", async () => {
  for (const denied of [true, false]) {
    const f = fixture("gmail", async () =>
      Response.json({ access_token: "incomplete" }),
    );
    try {
      const s = await f.start();
      const response = await f.request(
        "/v1/oauth/complete",
        {
          state: s.state,
          ...(denied ? { error: "access_denied" } : { code: "fixture" }),
        },
        "alice",
        s.cookie,
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await f.engine.connections("alice"), []);
      assert.deepEqual(
        await f.store.transaction((tx) => tx.list("secret", "alice")),
        [],
      );
      assert.equal(f.exchanges(), denied ? 0 : 1);
    } finally {
      await f.store.close();
    }
  }
});
