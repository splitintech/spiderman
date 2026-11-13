import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GoogleProvider,
  OutlookProvider,
  OzzyProvider,
  WhatsAppBusinessProvider,
  PlivoProvider,
  RcsBusinessProvider,
  MatrixMessagesProvider,
  refreshing,
} from "@splitin/spiderman-providers";
import { Engine } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault } from "@splitin/spiderman-vault";
const context = (credentials = {}) => ({
  connection: { accountId: "alice@example.test" },
  credentials,
  actionId: "abc123abc123abc123abc123abc123ab",
  idempotencyKey: "fixture-key-0001",
  signal: AbortSignal.timeout(1000),
});
test("Gmail verifies identity/scopes from provider token info, not caller claims", async () => {
  const p = new GoogleProvider("gmail", async () =>
    Response.json({
      email: "actual@example.test",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    }),
  );
  assert.deepEqual(
    await p.verify({ accessToken: "fixture", scopes: ["mail.send"] }),
    { accountId: "actual@example.test", scopes: ["mail.read"] },
  );
});
test("Gmail recipient mismatch prevents an external submission", async () => {
  let calls = 0;
  const p = new GoogleProvider("gmail", async () => {
    calls++;
    return Response.json({ id: "sent" });
  });
  await assert.rejects(
    p.execute(
      "mail.send",
      {
        raw: Buffer.from("To: hidden@example.test\r\n\r\ntext").toString(
          "base64url",
        ),
        recipients: ["approved@example.test"],
      },
      context({ accessToken: "fixture" }),
    ),
    /mime_recipient_mismatch/,
  );
  assert.equal(calls, 0);
});
test("Calendar sends an actual conditional provider update, not an OAuth sync request", async () => {
  let request;
  const p = new GoogleProvider("google-calendar", async (url, init) => {
    request = { url, init };
    return Response.json({ id: "event-id", etag: "new" });
  });
  const event = {
    summary: "Tour",
    start: {
      dateTime: "2026-11-13T10:00:00-05:00",
      timeZone: "America/New_York",
    },
    end: { dateTime: "2026-11-13T11:00:00-05:00" },
  };
  const result = await p.execute(
    "calendar.update",
    {
      calendarId: "calendar@example.test",
      eventId: "event-id",
      etag: "original",
      event,
    },
    context({ accessToken: "fixture" }),
  );
  assert.equal(result.providerId, "event-id");
  assert.equal(request.init.headers["If-Match"], "original");
  assert.equal(request.init.method, "PUT");
  assert.equal(JSON.parse(request.init.body).summary, "Tour");
  assert.match(request.url, /calendar\/v3\/calendars\//);
});
test("selected-resource policy blocks other Drive files and broad search", async () => {
  const store = new SqliteStore(":memory:"),
    vault = new EncryptedVault(store, Buffer.alloc(32, 2)),
    engine = new Engine(store, vault);
  let fetched = 0;
  engine.register(
    new GoogleProvider("google-drive", async (url) => {
      fetched++;
      return Response.json(
        url.includes("tokeninfo")
          ? {
              email: "alice@example.test",
              scope: "https://www.googleapis.com/auth/drive.file",
            }
          : { id: "selected" },
      );
    }),
  );
  try {
    const c = await engine.connect(
      "alice",
      "google-drive",
      { accessToken: "fixture" },
      ["selected"],
    );
    await assert.rejects(
      engine.submit("alice", {
        connectionId: c.id,
        operation: "drive.get",
        input: { fileId: "other" },
        idempotencyKey: "request-key-1",
      }),
      /resource_denied/,
    );
    await assert.rejects(
      engine.submit("alice", {
        connectionId: c.id,
        operation: "drive.search",
        input: {},
        idempotencyKey: "request-key-2",
      }),
      /broad_resource_grant_required/,
    );
    assert.equal(fetched, 1);
    const action = await engine.submit("alice", {
      connectionId: c.id,
      operation: "drive.get",
      input: { fileId: "selected" },
      idempotencyKey: "request-key-3",
    });
    await engine.runOnce();
    assert.equal((await engine.action("alice", action.id)).state, "succeeded");
  } finally {
    await store.close();
  }
});
test("Graph pagination refuses credential exfiltration through an arbitrary nextLink", async () => {
  let calls = 0;
  const p = new OutlookProvider(async () => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(
    p.execute(
      "mail.search",
      { nextLink: "https://attacker.invalid/collect" },
      context({ accessToken: "fixture" }),
    ),
    /graph_cursor_invalid/,
  );
  assert.equal(calls, 0);
});
test("Graph accepted response without draft identity is uncertain", async () => {
  const p = new OutlookProvider(
    async () => new Response(null, { status: 202 }),
  );
  await assert.rejects(
    p.execute(
      "mail.send",
      { recipients: ["bob@example.test"], subject: "Fixture", body: "Fixture" },
      context({ accessToken: "fixture" }),
    ),
    (error) => error.code === "graph_draft_receipt_missing" && error.uncertain,
  );
});
test("transport loss during a mutation is uncertain, not successful or safely retryable", async () => {
  const p = new GoogleProvider("google-calendar", async () => {
    throw Error("socket lost after write");
  });
  await assert.rejects(
    p.execute(
      "calendar.create",
      {
        calendarId: "primary",
        event: {
          summary: "Fixture",
          start: { dateTime: "2026-11-13T10:00:00Z" },
          end: { dateTime: "2026-11-13T11:00:00Z" },
        },
      },
      context({ accessToken: "fixture" }),
    ),
    (error) => error.uncertain === true,
  );
});
test("Ozzy cannot activate an audition belonging to another voice", async () => {
  let calls = 0;
  const p = new OzzyProvider(["http://127.0.0.1:8000"], async () => {
    calls++;
    return Response.json({ state: "completed", voice_id: "different" });
  });
  await assert.rejects(
    p.execute(
      "voice.activate",
      { voiceId: "owned", auditionJobId: "audition", approved: true },
      context({ endpoint: "http://127.0.0.1:8000", apiKey: "fixture" }),
    ),
    /audition_not_ready_or_wrong_voice/,
  );
  assert.equal(calls, 1);
});
test("Ozzy supplied endpoint is operator allowlisted before attaching credentials", async () => {
  const p = new OzzyProvider([]);
  await assert.rejects(
    p.verify({ endpoint: "https://attacker.invalid", apiKey: "fixture" }),
    /endpoint_not_allowlisted/,
  );
});
test("WhatsApp missing receipt is uncertain and business sender is bound", async () => {
  let body;
  const p = new WhatsAppBusinessProvider("v27.0", async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({});
  });
  await assert.rejects(
    p.execute(
      "message.send",
      { recipient: "+12125550123", text: "Fixture" },
      context({ phoneNumberId: "123", accessToken: "fixture" }),
    ),
    (error) => error.code === "send_receipt_missing" && error.uncertain,
  );
  assert.equal(body.messaging_product, "whatsapp");
});
test("Plivo rejects an unapproved answer URL before calling a provider", async () => {
  let calls = 0;
  const p = new PlivoProvider([], async () => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(
    p.execute(
      "call.create",
      { recipient: "+12125550123", answerUrl: "https://attacker.invalid/xml" },
      context({ authId: "id", authToken: "fixture", from: "+12125550124" }),
    ),
    /call_answer_url_denied/,
  );
  assert.equal(calls, 0);
});
test("Matrix bridge never silently changes a requested transport", async () => {
  let calls = 0;
  const p = new MatrixMessagesProvider(
    ["https://matrix.example.test"],
    async () => {
      calls++;
      return Response.json({});
    },
  );
  await assert.rejects(
    p.execute(
      "message.send",
      { recipient: "!room:example.test", text: "Fixture", transport: "rcs" },
      context({
        endpoint: "https://matrix.example.test",
        accessToken: "fixture",
        rooms: {
          "!room:example.test": {
            owner: "alice@example.test",
            transport: "sms",
          },
        },
      }),
    ),
    /bridge_transport_unverified/,
  );
  assert.equal(calls, 0);
});
test("RCS business receipt is explicitly RCS; no SMS adapter fallback is used", async () => {
  let url;
  const p = new RcsBusinessProvider(async (value) => {
    url = value;
    return Response.json({ name: "phones/123/agentMessages/fixture" });
  });
  const result = await p.execute(
    "message.send",
    { recipient: "+12125550123", text: "Fixture" },
    context({ agentId: "agent", accessToken: "fixture" }),
  );
  assert.equal(result.data.transport, "rcs-business");
  assert.match(url, /rcsbusinessmessaging.googleapis.com/);
});
test("rotating OAuth refresh token is saved before executing provider work", async () => {
  const order = [],
    provider = {
      manifest: { operations: [{ name: "read", scopes: [] }] },
      verify: async () => ({ accountId: "alice@example.test", scopes: [] }),
      execute: async (_op, _input, ctx) => {
        order.push("execute");
        assert.equal(ctx.credentials.accessToken, "new");
        return { data: {} };
      },
    };
  const p = refreshing(provider, async () =>
    Response.json({
      access_token: "new",
      refresh_token: "rotated",
      expires_in: 3600,
    }),
  );
  await p.execute(
    "read",
    {},
    {
      ...context({
        accessToken: "old",
        refreshToken: "refresh",
        clientId: "id",
        clientSecret: "fixture",
        expiresAt: 0,
        tokenEndpoint: "https://oauth2.googleapis.com/token",
      }),
      updateCredentials: async (next) => {
        order.push("save");
        assert.equal(next.refreshToken, "rotated");
      },
    },
  );
  assert.deepEqual(order, ["save", "execute"]);
});
