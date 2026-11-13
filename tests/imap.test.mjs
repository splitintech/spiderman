import { test } from "node:test";
import assert from "node:assert/strict";
import { ImapSmtpProvider } from "@splitin/spiderman-providers";
import { ConnectorError } from "@splitin/spiderman-contracts";
import { imapReconciliationStrategy } from "@splitin/spiderman-provider-email";
const ctx = {
  connection: { accountId: "alice@example.test" },
  credentials: {},
  actionId: "a".repeat(64),
  signal: AbortSignal.timeout(1000),
};
function fixture() {
  const p = new ImapSmtpProvider(["mail.example.test"]),
    calls = [];
  let released = 0;
  const imap = {
    mailbox: { uidValidity: 44n, uidNext: 101 },
    capabilities: new Map([["IDLE", true]]),
    connect: async () => {},
    logout: async () => {},
    getMailboxLock: async () => ({ release: () => released++ }),
    search: async () => [100, 101, 102],
    list: async () => [
      { path: "Drafts", name: "Drafts", specialUse: "\\Drafts" },
      { path: "Trash", name: "Trash", specialUse: "\\Trash" },
    ],
    append: async () => ({ uid: 102 }),
    messageMove: async () => ({ uidMap: new Map([[100, 202]]) }),
    messageFlagsAdd: async () => calls.push("flags"),
    fetchOne: async () => ({ flags: new Set(["\\Seen"]) }),
  };
  p.imap = () => imap;
  return { p, imap, calls, released: () => released };
}
test("IMAP post-lock authorization releases the lock and does not mutate after revocation", async () => {
  const f = fixture();
  let checks = 0;
  await assert.rejects(
    f.p.execute(
      "mail.flags",
      { folder: "INBOX", uid: 100, uidValidity: "44", add: ["\\Seen"] },
      {
        ...ctx,
        beforeDispatch: async () => {
          if (++checks === 2) throw new ConnectorError("policy_revoked");
        },
      },
    ),
    /policy_revoked/,
  );
  assert.equal(f.released(), 1);
  assert.deepEqual(f.calls, []);
});
test("IMAP UID validity protects mutations and polling establishes then advances a bounded cursor", async () => {
  const f = fixture();
  await assert.rejects(
    f.p.execute(
      "mail.move",
      { folder: "INBOX", uid: 100, uidValidity: "old", destination: "Archive" },
      ctx,
    ),
    /imap_cursor_invalid/,
  );
  const initial = await f.p.execute("mail.changes", { folder: "INBOX" }, ctx);
  assert.deepEqual(initial.data, {
    uidValidity: "44",
    lastUid: 100,
    messages: [],
  });
  const next = await f.p.execute(
    "mail.changes",
    { folder: "INBOX", uidValidity: "44", afterUid: 100 },
    ctx,
  );
  assert.deepEqual(next.data.messages, [{ uid: 101 }, { uid: 102 }]);
  assert.equal(next.data.lastUid, 102);
  assert.equal(f.released(), 3);
});
test("known Google and Microsoft mail hosts require native OAuth connectors", () => {
  for (const host of ["imap.gmail.com", "outlook.office365.com"]) {
    const p = new ImapSmtpProvider([host]);
    assert.throws(
      () =>
        p.config(
          {
            imapHost: host,
            username: "alice@example.test",
            password: "synthetic",
          },
          "imap",
        ),
      /native_oauth_connector_required/,
    );
  }
});
test("custom mail OAuth uses protocol-specific token auth and rejects expired credentials", () => {
  const p = new ImapSmtpProvider(["mail.example.test"]),
    credentials = {
      imapHost: "mail.example.test",
      smtpHost: "mail.example.test",
      username: "alice@example.test",
      authType: "oauth2",
      accessToken: "synthetic",
    };
  assert.deepEqual(p.config(credentials, "imap").auth, {
    user: credentials.username,
    accessToken: "synthetic",
  });
  assert.deepEqual(p.config(credentials, "smtp").auth, {
    type: "OAuth2",
    user: credentials.username,
    accessToken: "synthetic",
  });
  assert.throws(
    () => p.config({ ...credentials, expiresAt: 1 }, "imap"),
    /mail_oauth_token_expired/,
  );
  assert.throws(
    () => p.config({ ...credentials, authType: "other" }, "imap"),
    /mail_auth_type_invalid/,
  );
});
test("IMAP reconciliation requires a verified Sent folder and exact action, sender and recipient evidence", async () => {
  const f = fixture(),
    actionId = "b".repeat(64),
    messageId = "<" + actionId + "@spiderman.local>";
  f.imap.list = async () => [{ path: "Sent", specialUse: "\\Sent" }];
  f.imap.search = async () => [7];
  f.imap.fetchOne = async () => ({
    envelope: {
      messageId,
      from: [{ address: "alice@example.test" }],
      to: [{ address: "bob@example.test" }],
    },
  });
  const result = await f.p.execute(
      "mail.reconcile",
      { folder: "Sent", actionId },
      ctx,
    ),
    strategy = imapReconciliationStrategy();
  assert.equal(
    strategy.resolve(
      result.data,
      { id: actionId },
      { recipients: ["bob@example.test"] },
    ).providerId,
    messageId,
  );
  assert.equal(
    strategy.resolve(
      result.data,
      { id: actionId },
      { recipients: ["other@example.test"] },
    ),
    undefined,
  );
  await assert.rejects(
    f.p.execute("mail.reconcile", { folder: "INBOX", actionId }, ctx),
    /sent_folder_unverified/,
  );
  f.imap.fetchOne = async () => ({
    envelope: {
      messageId,
      from: [{ address: "attacker@example.test" }],
      to: [{ address: "bob@example.test" }],
    },
  });
  assert.deepEqual(
    (await f.p.execute("mail.reconcile", { folder: "Sent", actionId }, ctx))
      .data.messages,
    [],
  );
});
