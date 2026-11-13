import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleProvider } from "@splitin/spiderman-providers";
import { buildMime, MimeError } from "@splitin/spiderman-provider-kit";
const ctx = {
  connection: { accountId: "alice@example.test" },
  credentials: { accessToken: "synthetic" },
  actionId: "a".repeat(64),
  signal: AbortSignal.timeout(10000),
};
test("reused MIME builder handles Unicode, alternatives and bounded attachments without header injection", () => {
  const input = {
    from: { address: "alice@example.test" },
    to: [{ address: "bob@example.test" }],
    subject: "Hello ☀",
    text: "plain",
    html: "<b>html</b>",
    rfcMessageId: "<synthetic@spiderman.local>",
    idempotencyKey: "synthetic",
    headers: {},
    attachments: [
      {
        filename: "file.txt",
        contentType: "text/plain",
        contentBase64: "YQ==",
      },
    ],
  };
  const raw = buildMime(input, new Date(0), "synthetic-boundary");
  assert.match(raw, /multipart\/mixed/);
  assert.match(raw, /multipart\/alternative/);
  assert.match(raw, /filename="file.txt"/);
  assert.match(raw, /Subject: =\?UTF-8/);
  assert.throws(
    () =>
      buildMime(
        { ...input, subject: "bad\r\nBcc: other@example.test" },
        new Date(),
      ),
    MimeError,
  );
  assert.throws(
    () =>
      buildMime(
        {
          ...input,
          attachments: [
            {
              filename: "bad\r\nname",
              contentType: "text/plain",
              contentBase64: "YQ==",
            },
          ],
        },
        new Date(),
      ),
    MimeError,
  );
});
test("Gmail structured reply preserves thread and references; forwarded mail is attached; draft updates use PUT", async () => {
  let requests = [];
  const p = new GoogleProvider("gmail", async (url, init) => {
    requests.push({ url, init });
    if (init.method === "GET")
      return Response.json({
        id: "original",
        threadId: "thread",
        raw: Buffer.from("original").toString("base64url"),
        payload: {
          headers: [{ name: "Message-ID", value: "<original@example.test>" }],
        },
      });
    return Response.json({ id: "sent" });
  });
  const content = {
    recipients: ["bob@example.test"],
    subject: "Reply",
    text: "Synthetic",
  };
  await p.execute("mail.reply", { ...content, messageId: "original" }, ctx);
  const reply = JSON.parse(requests[1].init.body);
  assert.equal(reply.threadId, "thread");
  assert.match(
    Buffer.from(reply.raw, "base64url").toString(),
    /In-Reply-To: <original@example.test>/,
  );
  requests = [];
  await p.execute("mail.forward", { ...content, messageId: "original" }, ctx);
  assert.match(
    Buffer.from(JSON.parse(requests[1].init.body).raw, "base64url").toString(),
    /filename="forwarded.eml"/,
  );
  requests = [];
  await p.execute("mail.draftUpdate", { ...content, draftId: "draft" }, ctx);
  assert.equal(requests[0].init.method, "PUT");
  assert.match(requests[0].url, /drafts\/draft$/);
});
test("Drive upload/download and conditional move use fixed endpoints and validated receipts", async () => {
  let requests = [];
  const p = new GoogleProvider("google-drive", async (url, init) => {
    requests.push({ url, init });
    if (url.includes("alt=media"))
      return new Response("synthetic", {
        headers: { "content-type": "text/plain" },
      });
    return Response.json({ id: "file" });
  });
  assert.equal(
    (await p.execute("drive.download", { fileId: "file" }, ctx)).data
      .contentBase64,
    Buffer.from("synthetic").toString("base64"),
  );
  await p.execute(
    "drive.upload",
    { name: "file.txt", mimeType: "text/plain", contentBase64: "YQ==" },
    ctx,
  );
  assert.match(
    requests[1].url,
    /upload\/drive\/v3\/files\?uploadType=multipart/,
  );
  assert.match(requests[1].init.headers["Content-Type"], /multipart\/related/);
  await p.execute(
    "drive.move",
    { fileId: "file", parentId: "new", removeParents: ["old"], etag: '"v1"' },
    ctx,
  );
  assert.equal(requests[2].init.headers["If-Match"], '"v1"');
  assert.match(requests[2].url, /addParents=new&removeParents=old/);
});
test("Sheets compare conflicts stop writes and non-atomic updates require explicit acknowledgment", async () => {
  let writes = 0;
  const p = new GoogleProvider("google-sheets", async (_url, init) => {
    if (init.method === "GET") return Response.json({ values: [["newer"]] });
    writes++;
    return Response.json({ spreadsheetId: "sheet" });
  });
  const input = {
    spreadsheetId: "sheet",
    range: "A1",
    values: [["overwrite"]],
    expectedValues: [["old"]],
    allowNonAtomicWrite: true,
  };
  await assert.rejects(
    p.execute("sheets.update", input, ctx),
    /spreadsheet_conflict/,
  );
  assert.equal(writes, 0);
  await assert.rejects(
    p.execute(
      "sheets.update",
      { spreadsheetId: "sheet", range: "A1", values: [] },
      ctx,
    ),
  );
});
test("Calendar accepts all-day and DST-aware recurrence and rejects mixed or reversed event times", async () => {
  const p = new GoogleProvider("google-calendar", async (_url, init) =>
    Response.json({ ...JSON.parse(init.body), id: "event" }),
  );
  const allDay = {
    summary: "Synthetic",
    start: { date: "2026-11-01" },
    end: { date: "2026-11-02" },
  };
  assert.equal(
    (
      await p.execute(
        "calendar.create",
        { calendarId: "cal", event: allDay },
        ctx,
      )
    ).providerId,
    "event",
  );
  const recurrence = {
    summary: "Synthetic",
    start: {
      dateTime: "2026-11-01T01:30:00-04:00",
      timeZone: "America/New_York",
    },
    end: {
      dateTime: "2026-11-01T01:30:00-05:00",
      timeZone: "America/New_York",
    },
    recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
  };
  await p.execute(
    "calendar.create",
    { calendarId: "cal", event: recurrence },
    ctx,
  );
  await assert.rejects(
    p.execute(
      "calendar.create",
      {
        calendarId: "cal",
        event: { ...allDay, end: { dateTime: "2026-11-02T00:00:00Z" } },
      },
      ctx,
    ),
  );
  await assert.rejects(
    p.execute(
      "calendar.create",
      { calendarId: "cal", event: { ...allDay, end: { date: "2026-10-31" } } },
      ctx,
    ),
  );
});
test("ordinary update schemas cannot perform destructive trash or cancellation", () => {
  const p = new GoogleProvider("google-drive"),
    mail = new GoogleProvider("gmail"),
    calendar = new GoogleProvider("google-calendar");
  assert.throws(() =>
    p.manifest.operations
      .find((o) => o.name === "drive.update")
      .input.parse({ fileId: "file", etag: "v1", trashed: true }),
  );
  assert.throws(() =>
    mail.manifest.operations
      .find((o) => o.name === "mail.modify")
      .input.parse({ messageId: "message", addLabelIds: ["TRASH"] }),
  );
  assert.throws(() =>
    calendar.manifest.operations
      .find((o) => o.name === "calendar.update")
      .input.parse({
        calendarId: "cal",
        eventId: "event",
        etag: "v1",
        event: {
          summary: "Synthetic",
          start: { date: "2026-11-01" },
          end: { date: "2026-11-02" },
          status: "cancelled",
        },
      }),
  );
});
