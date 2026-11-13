import { z } from "zod";
import {
  ConnectorError,
  type Operation,
  type ProviderResult,
} from "@splitin/spiderman-contracts";
import type { Provider, ProviderContext } from "@splitin/spiderman-core";
import { json, required, type Http } from "@splitin/spiderman-provider-kit";
const s = z.string().min(1).max(10000),
  id = z.string().min(1).max(300),
  empty = z.object({}).strict(),
  page = {
    pageToken: z.string().optional(),
    pageSize: z.number().int().min(1).max(100).default(50),
  };
const op = (
  name: string,
  risk: Operation["risk"],
  scope: string,
  input: z.ZodType<Record<string, unknown>>,
  resourceKeys?: string[],
  recipientKeys?: string[],
): Operation => ({
  name,
  risk,
  scopes: [scope],
  input,
  resourceKeys,
  recipientKeys,
});
const mailbox = [
  op(
    "mail.search",
    "read",
    "mail.read",
    z.object({ query: s, ...page }).strict(),
  ),
  op("mail.get", "read", "mail.read", z.object({ messageId: id }).strict()),
  op("mail.thread", "read", "mail.read", z.object({ threadId: id }).strict()),
  op(
    "mail.attachment",
    "read",
    "mail.read",
    z.object({ messageId: id, attachmentId: id }).strict(),
  ),
  op(
    "mail.draft",
    "draft",
    "mail.write",
    z.object({ raw: s, threadId: id.optional() }).strict(),
  ),
  op(
    "mail.send",
    "write",
    "mail.send",
    z
      .object({
        raw: s,
        recipients: z.array(z.email()).min(1).max(20),
        threadId: id.optional(),
      })
      .strict(),
    undefined,
    ["recipients"],
  ),
  op(
    "mail.modify",
    "write",
    "mail.write",
    z
      .object({
        messageId: id,
        addLabelIds: z.array(id).default([]),
        removeLabelIds: z.array(id).default([]),
      })
      .strict(),
    ["messageId"],
  ),
  op(
    "mail.trash",
    "destructive",
    "mail.write",
    z.object({ messageId: id }).strict(),
  ),
  op(
    "mail.history",
    "read",
    "mail.read",
    z.object({ startHistoryId: id, ...page }).strict(),
  ),
  op("mail.watch", "write", "mail.read", z.object({ topicName: s }).strict()),
];
const drive = [
  op(
    "drive.search",
    "read",
    "files.read",
    z.object({ query: s.optional(), ...page }).strict(),
  ),
  op("drive.get", "read", "files.read", z.object({ fileId: id }).strict(), [
    "fileId",
  ]),
  op(
    "drive.create",
    "write",
    "files.write",
    z
      .object({ name: s, mimeType: s.optional(), parentId: id.optional() })
      .strict(),
    ["parentId"],
  ),
  op(
    "drive.update",
    "write",
    "files.write",
    z
      .object({
        fileId: id,
        name: s.optional(),
        trashed: z.boolean().optional(),
        etag: s,
      })
      .strict(),
    ["fileId"],
  ),
  op(
    "drive.changes",
    "read",
    "files.read",
    z.object({ pageToken: id }).strict(),
  ),
  op(
    "drive.share",
    "destructive",
    "files.write",
    z
      .object({
        fileId: id,
        emailAddress: z.email(),
        role: z.enum(["reader", "commenter", "writer"]),
      })
      .strict(),
    ["fileId"],
  ),
];
const sheets = [
  op(
    "sheets.get",
    "read",
    "sheets.read",
    z.object({ spreadsheetId: id }).strict(),
    ["spreadsheetId"],
  ),
  op(
    "sheets.read",
    "read",
    "sheets.read",
    z.object({ spreadsheetId: id, range: s }).strict(),
    ["spreadsheetId"],
  ),
  op("sheets.create", "write", "sheets.write", z.object({ title: s }).strict()),
  op(
    "sheets.update",
    "write",
    "sheets.write",
    z
      .object({
        spreadsheetId: id,
        range: s,
        values: z
          .array(
            z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
          )
          .max(1000),
      })
      .strict(),
    ["spreadsheetId"],
  ),
  op(
    "sheets.append",
    "write",
    "sheets.write",
    z
      .object({
        spreadsheetId: id,
        range: s,
        values: z
          .array(
            z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
          )
          .max(1000),
      })
      .strict(),
    ["spreadsheetId"],
  ),
];
const event = z
  .object({
    summary: s,
    start: z.object({ dateTime: s, timeZone: s.optional() }).strict(),
    end: z.object({ dateTime: s, timeZone: s.optional() }).strict(),
    description: s.optional(),
    recurrence: z.array(s).optional(),
    attendees: z
      .array(z.object({ email: z.email() }).strict())
      .max(100)
      .optional(),
  })
  .strict();
const calendar = [
  op("calendar.list", "read", "calendar.read", z.object(page).strict()),
  op(
    "calendar.events",
    "read",
    "calendar.read",
    z.object({ calendarId: id, syncToken: s.optional(), ...page }).strict(),
    ["calendarId"],
  ),
  op(
    "calendar.get",
    "read",
    "calendar.read",
    z.object({ calendarId: id, eventId: id }).strict(),
    ["calendarId"],
  ),
  op(
    "calendar.create",
    "write",
    "calendar.write",
    z.object({ calendarId: id, event }).strict(),
    ["calendarId"],
  ),
  op(
    "calendar.update",
    "write",
    "calendar.write",
    z.object({ calendarId: id, eventId: id, etag: s, event }).strict(),
    ["calendarId"],
  ),
  op(
    "calendar.delete",
    "destructive",
    "calendar.write",
    z.object({ calendarId: id, eventId: id, etag: s }).strict(),
    ["calendarId"],
  ),
  op(
    "calendar.freebusy",
    "read",
    "calendar.read",
    z
      .object({ calendarIds: z.array(id).max(50), timeMin: s, timeMax: s })
      .strict(),
    ["calendarIds"],
  ),
];
const scopeMap: Record<string, string[]> = {
  "https://mail.google.com/": ["mail.read", "mail.write", "mail.send"],
  "https://www.googleapis.com/auth/gmail.modify": [
    "mail.read",
    "mail.write",
    "mail.send",
  ],
  "https://www.googleapis.com/auth/gmail.readonly": ["mail.read"],
  "https://www.googleapis.com/auth/gmail.send": ["mail.send"],
  "https://www.googleapis.com/auth/gmail.compose": ["mail.write", "mail.send"],
  "https://www.googleapis.com/auth/drive": ["files.read", "files.write"],
  "https://www.googleapis.com/auth/drive.file": ["files.read", "files.write"],
  "https://www.googleapis.com/auth/drive.readonly": ["files.read"],
  "https://www.googleapis.com/auth/spreadsheets": [
    "sheets.read",
    "sheets.write",
  ],
  "https://www.googleapis.com/auth/spreadsheets.readonly": ["sheets.read"],
  "https://www.googleapis.com/auth/calendar": [
    "calendar.read",
    "calendar.write",
  ],
  "https://www.googleapis.com/auth/calendar.events": [
    "calendar.read",
    "calendar.write",
  ],
  "https://www.googleapis.com/auth/calendar.readonly": ["calendar.read"],
  "https://www.googleapis.com/auth/calendar.events.readonly": ["calendar.read"],
};
export class GoogleProvider implements Provider {
  readonly manifest;
  constructor(
    readonly kind:
      "gmail" | "google-drive" | "google-sheets" | "google-calendar",
    readonly http: Http = fetch,
  ) {
    this.manifest = {
      provider: kind,
      version: "1",
      qualification: "automated_only" as const,
      operations:
        kind === "gmail"
          ? mailbox
          : kind === "google-drive"
            ? drive
            : kind === "google-sheets"
              ? sheets
              : calendar,
    };
  }
  async verify(credentials: Record<string, unknown>) {
    const token = required(credentials, "accessToken");
    const info = await json(
      this.http,
      "https://oauth2.googleapis.com/tokeninfo?access_token=" +
        encodeURIComponent(token),
    );
    if (typeof info.email !== "string" || typeof info.scope !== "string")
      throw new ConnectorError("google_identity_unverified");
    return {
      accountId: info.email,
      scopes: [
        ...new Set(
          info.scope.split(" ").flatMap((v: string) => scopeMap[v] ?? []),
        ),
      ] as string[],
    };
  }
  async execute(
    operation: string,
    raw: Record<string, unknown>,
    ctx: ProviderContext,
  ): Promise<ProviderResult> {
    const spec = this.manifest.operations.find((o) => o.name === operation);
    if (!spec) throw new ConnectorError("operation_unavailable");
    const a = spec.input.parse(raw) as any,
      token = required(ctx.credentials, "accessToken"),
      e = encodeURIComponent;
    let url = "",
      method = "GET",
      body: unknown;
    const headers: Record<string, string> = {};
    const gmail = "https://gmail.googleapis.com/gmail/v1/users/me",
      files = "https://www.googleapis.com/drive/v3/files",
      sheet = "https://sheets.googleapis.com/v4/spreadsheets",
      cal = "https://www.googleapis.com/calendar/v3";
    switch (operation) {
      case "mail.search":
        url =
          gmail +
          "/messages?q=" +
          e(a.query) +
          "&maxResults=" +
          a.pageSize +
          (a.pageToken ? "&pageToken=" + e(a.pageToken) : "");
        break;
      case "mail.get":
        url = gmail + "/messages/" + e(a.messageId) + "?format=full";
        break;
      case "mail.thread":
        url = gmail + "/threads/" + e(a.threadId) + "?format=full";
        break;
      case "mail.attachment":
        url =
          gmail +
          "/messages/" +
          e(a.messageId) +
          "/attachments/" +
          e(a.attachmentId);
        break;
      case "mail.draft":
        url = gmail + "/drafts";
        method = "POST";
        body = { message: { raw: a.raw, threadId: a.threadId } };
        break;
      case "mail.send": {
        // Raw MIME recipients must match the approved envelope, including cc/bcc.
        const mime = Buffer.from(a.raw, "base64url").toString("utf8");
        const head = mime.split(/\r?\n\r?\n/, 1)[0] ?? "";
        const actual = [
          ...head
            .replace(/\r?\n[ \t]+/g, " ")
            .matchAll(/^(?:To|Cc|Bcc):(.+)$/gim),
        ]
          .flatMap(
            (m) =>
              m[1]!.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi) ?? [],
          )
          .map((x) => x.toLowerCase())
          .sort();
        if (
          JSON.stringify(actual) !==
          JSON.stringify(
            [...a.recipients].map((x: string) => x.toLowerCase()).sort(),
          )
        )
          throw new ConnectorError("mime_recipient_mismatch");
        url = gmail + "/messages/send";
        method = "POST";
        body = { raw: a.raw, threadId: a.threadId };
        break;
      }
      case "mail.modify":
        url = gmail + "/messages/" + e(a.messageId) + "/modify";
        method = "POST";
        body = { addLabelIds: a.addLabelIds, removeLabelIds: a.removeLabelIds };
        break;
      case "mail.trash":
        url = gmail + "/messages/" + e(a.messageId) + "/trash";
        method = "POST";
        break;
      case "mail.history":
        url =
          gmail +
          "/history?startHistoryId=" +
          e(a.startHistoryId) +
          "&maxResults=" +
          a.pageSize +
          (a.pageToken ? "&pageToken=" + e(a.pageToken) : "");
        break;
      case "mail.watch":
        url = gmail + "/watch";
        method = "POST";
        body = { topicName: a.topicName };
        break;
      case "drive.search":
        url =
          files +
          "?pageSize=" +
          a.pageSize +
          "&fields=nextPageToken,files(id,name,mimeType,modifiedTime,parents)" +
          (a.query ? "&q=" + e(a.query) : "") +
          (a.pageToken ? "&pageToken=" + e(a.pageToken) : "");
        break;
      case "drive.get":
        url =
          files +
          "/" +
          e(a.fileId) +
          "?fields=id,name,mimeType,modifiedTime,parents,version,webViewLink";
        break;
      case "drive.create":
        url = files;
        method = "POST";
        body = {
          name: a.name,
          mimeType: a.mimeType,
          parents: a.parentId ? [a.parentId] : undefined,
        };
        break;
      case "drive.update":
        url = files + "/" + e(a.fileId);
        method = "PATCH";
        body = { name: a.name, trashed: a.trashed };
        headers["If-Match"] = a.etag;
        break;
      case "drive.changes":
        url =
          "https://www.googleapis.com/drive/v3/changes?pageToken=" +
          e(a.pageToken);
        break;
      case "drive.share":
        url = files + "/" + e(a.fileId) + "/permissions";
        method = "POST";
        body = { type: "user", emailAddress: a.emailAddress, role: a.role };
        break;
      case "sheets.get":
        url = sheet + "/" + e(a.spreadsheetId);
        break;
      case "sheets.read":
        url = sheet + "/" + e(a.spreadsheetId) + "/values/" + e(a.range);
        break;
      case "sheets.create":
        url = sheet;
        method = "POST";
        body = { properties: { title: a.title } };
        break;
      case "sheets.update":
        url =
          sheet +
          "/" +
          e(a.spreadsheetId) +
          "/values/" +
          e(a.range) +
          "?valueInputOption=USER_ENTERED";
        method = "PUT";
        body = { range: a.range, values: a.values };
        break;
      case "sheets.append":
        url =
          sheet +
          "/" +
          e(a.spreadsheetId) +
          "/values/" +
          e(a.range) +
          ":append?valueInputOption=USER_ENTERED";
        method = "POST";
        body = { range: a.range, values: a.values };
        break;
      case "calendar.list":
        url =
          cal +
          "/users/me/calendarList?maxResults=" +
          a.pageSize +
          (a.pageToken ? "&pageToken=" + e(a.pageToken) : "");
        break;
      case "calendar.events":
        url =
          cal +
          "/calendars/" +
          e(a.calendarId) +
          "/events?maxResults=" +
          a.pageSize +
          (a.syncToken ? "&syncToken=" + e(a.syncToken) : "") +
          (a.pageToken ? "&pageToken=" + e(a.pageToken) : "");
        break;
      case "calendar.get":
        url = cal + "/calendars/" + e(a.calendarId) + "/events/" + e(a.eventId);
        break;
      case "calendar.create":
        url = cal + "/calendars/" + e(a.calendarId) + "/events";
        method = "POST";
        body = { ...a.event, id: ctx.actionId.slice(0, 32) };
        break;
      case "calendar.update":
        url = cal + "/calendars/" + e(a.calendarId) + "/events/" + e(a.eventId);
        method = "PUT";
        body = a.event;
        headers["If-Match"] = a.etag;
        break;
      case "calendar.delete":
        url = cal + "/calendars/" + e(a.calendarId) + "/events/" + e(a.eventId);
        method = "DELETE";
        headers["If-Match"] = a.etag;
        break;
      case "calendar.freebusy":
        url = cal + "/freeBusy";
        method = "POST";
        body = {
          timeMin: a.timeMin,
          timeMax: a.timeMax,
          items: a.calendarIds.map((id: string) => ({ id })),
        };
        break;
      default:
        throw new ConnectorError("operation_unavailable");
    }
    const data = await json(
      this.http,
      url,
      method,
      token,
      body,
      ctx.signal,
      headers,
    );
    return { providerId: data.id ?? data.spreadsheetId, data };
  }
}
