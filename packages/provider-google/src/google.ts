import { z } from "zod";
import {
  ConnectorError,
  type Operation,
  type ProviderResult,
} from "@splitin/spiderman-contracts";
import type { Provider, ProviderContext } from "@splitin/spiderman-core";
import {
  json,
  binary,
  buildMime,
  MimeError,
  required,
  type Http,
} from "@splitin/spiderman-provider-kit";
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
const channel = z
  .object({
    channelId: z.string().uuid(),
    address: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        !url.search
      );
    }),
    token: z.string().min(32).max(256),
    expiresAt: z.number().int().positive(),
  })
  .strict();
const mailContent = z
  .object({
    recipients: z.array(z.email()).min(1).max(20),
    subject: z.string().max(1000),
    text: z.string().max(100000),
    html: z.string().max(100000).optional(),
    attachments: z
      .array(
        z
          .object({
            filename: z.string().regex(/^[A-Za-z0-9_. -]{1,120}$/),
            contentType: z.string().regex(/^[-\w.+]+\/[-\w.+]+$/),
            contentBase64: z.string().max(7_000_000),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();
const rawDraft = z
  .object({ raw: z.string().min(1).max(8_000_000), threadId: id.optional() })
  .strict();
const mailbox = [
  op(
    "mail.reconcile",
    "read",
    "mail.read",
    z.object({ actionId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ),
  op("mail.profile", "read", "mail.read", empty),
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
    z.union([rawDraft, mailContent.extend({ threadId: id.optional() })]),
  ),
  op(
    "mail.send",
    "write",
    "mail.send",
    z.union([
      rawDraft.extend({ recipients: z.array(z.email()).min(1).max(20) }),
      mailContent.extend({ threadId: id.optional() }),
    ]),
    undefined,
    ["recipients"],
  ),
  op(
    "mail.reply",
    "write",
    "mail.send",
    mailContent.extend({ messageId: id }),
    undefined,
    ["recipients"],
  ),
  op(
    "mail.forward",
    "write",
    "mail.send",
    mailContent.extend({ messageId: id }),
    undefined,
    ["recipients"],
  ),
  op(
    "mail.draftUpdate",
    "draft",
    "mail.write",
    z.union([
      rawDraft.extend({ draftId: id }),
      mailContent.extend({ draftId: id, threadId: id.optional() }),
    ]),
  ),
  op("mail.drafts", "read", "mail.write", z.object(page).strict()),
  op("mail.draftGet", "read", "mail.write", z.object({ draftId: id }).strict()),
  op("mail.labels", "read", "mail.read", empty),
  op(
    "mail.modify",
    "write",
    "mail.write",
    z
      .object({
        messageId: id,
        addLabelIds: z
          .array(
            id.refine(
              (value) => value.toUpperCase() !== "TRASH",
              "use_mail_trash",
            ),
          )
          .default([]),
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
  {
    ...op(
      "mail.watch",
      "write",
      "mail.read",
      z
        .object({
          topicName: z
            .string()
            .regex(/^projects\/[A-Za-z0-9_.:-]+\/topics\/[A-Za-z0-9_.~-]+$/),
        })
        .strict(),
    ),
    policyKeys: ["topicName"],
  },
  op("mail.stopWatch", "write", "mail.read", empty),
];
const drive = [
  {
    ...op(
      "drive.watch",
      "write",
      "files.read",
      channel.extend({ pageToken: s }),
    ),
    policyKeys: ["address"],
  },
  op(
    "drive.trash",
    "destructive",
    "files.write",
    z.object({ fileId: id, etag: s }).strict(),
    ["fileId"],
  ),
  {
    ...op(
      "drive.download",
      "read",
      "files.read",
      z.object({ fileId: id }).strict(),
      ["fileId"],
    ),
    stagedResult: true,
  },
  {
    ...op(
      "drive.export",
      "read",
      "files.read",
      z
        .object({
          fileId: id,
          mimeType: z.enum([
            "application/pdf",
            "text/plain",
            "text/csv",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ]),
        })
        .strict(),
      ["fileId"],
    ),
    stagedResult: true,
  },
  {
    ...op(
      "drive.upload",
      "write",
      "files.write",
      z
        .object({
          name: z.string().min(1).max(255),
          mimeType: z.string().regex(/^[-\w.+]+\/[-\w.+]+$/),
          parentId: id.optional(),
          contentBase64: z.string().min(1).max(7_000_000),
        })
        .strict(),
      ["parentId"],
    ),
    stagingKeys: ["contentBase64"],
  },
  op(
    "drive.move",
    "write",
    "files.write",
    z
      .object({
        fileId: id,
        parentId: id,
        removeParents: z.array(id).min(1).max(10),
        etag: s,
      })
      .strict(),
    ["fileId", "parentId", "removeParents"],
  ),
  op(
    "drive.folderChildren",
    "read",
    "files.read",
    z.object({ parentId: id, ...page }).strict(),
    ["parentId"],
  ),
  op("drive.startCursor", "read", "files.read", empty),
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
        trashed: z.literal(false).optional(),
        etag: s,
      })
      .strict(),
    ["fileId"],
  ),
  op(
    "drive.changes",
    "read",
    "files.read",
    z.object({ pageToken: z.string().min(1).max(16000) }).strict(),
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
  op("sheets.discover", "read", "files.read", z.object(page).strict()),
  op(
    "sheets.addSheet",
    "write",
    "sheets.write",
    z.object({ spreadsheetId: id, title: z.string().min(1).max(100) }).strict(),
    ["spreadsheetId"],
  ),
  op(
    "sheets.batch",
    "write",
    "sheets.write",
    z
      .object({
        spreadsheetId: id,
        requests: z
          .array(
            z.union([
              z
                .object({
                  addSheet: z
                    .object({
                      properties: z
                        .object({ title: z.string().min(1).max(100) })
                        .strict(),
                    })
                    .strict(),
                })
                .strict(),
              z
                .object({
                  appendDimension: z
                    .object({
                      sheetId: z.number().int().nonnegative(),
                      dimension: z.enum(["ROWS", "COLUMNS"]),
                      length: z.number().int().min(1).max(1000),
                    })
                    .strict(),
                })
                .strict(),
            ]),
          )
          .min(1)
          .max(50),
      })
      .strict(),
    ["spreadsheetId"],
  ),
  {
    ...op(
      "sheets.export",
      "read",
      "files.read",
      z
        .object({
          spreadsheetId: id,
          mimeType: z.enum([
            "application/pdf",
            "text/csv",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ]),
        })
        .strict(),
      ["spreadsheetId"],
    ),
    stagedResult: true,
  },
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
        expectedValues: z
          .array(
            z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
          )
          .max(1000),
        allowNonAtomicWrite: z.literal(true),
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
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString().startsWith(value),
    "invalid_date",
  );
const zone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "invalid_time_zone");
const eventTime = z.union([
  z.object({ date }).strict(),
  z
    .object({
      dateTime: z.iso.datetime({ offset: true }),
      timeZone: zone.optional(),
    })
    .strict(),
]);
const event = z
  .object({
    summary: s,
    start: eventTime,
    end: eventTime,
    description: s.optional(),
    location: s.optional(),
    recurrence: z
      .array(z.string().regex(/^(?:RRULE|RDATE|EXDATE|EXRULE):[^\r\n]+$/))
      .max(50)
      .optional(),
    attendees: z
      .array(
        z
          .object({
            email: z.email(),
            responseStatus: z
              .enum(["needsAction", "declined", "tentative", "accepted"])
              .optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    status: z.enum(["confirmed", "tentative"]).optional(),
    extendedProperties: z
      .object({ private: z.record(z.string(), z.string().max(1024)) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ("date" in value.start !== "date" in value.end) {
      ctx.addIssue({ code: "custom", message: "event_time_kind_mismatch" });
      return;
    }
    const start =
        "date" in value.start ? value.start.date : value.start.dateTime,
      end = "date" in value.end ? value.end.date : value.end.dateTime;
    if (Date.parse(end) <= Date.parse(start))
      ctx.addIssue({ code: "custom", message: "event_end_must_follow_start" });
    if (
      value.recurrence?.length &&
      "dateTime" in value.start &&
      (!value.start.timeZone ||
        !("timeZone" in value.end) ||
        !value.end.timeZone)
    )
      ctx.addIssue({
        code: "custom",
        message: "recurrence_time_zones_required",
      });
  });
const calendar = [
  {
    ...op(
      "calendar.watch",
      "write",
      "calendar.read",
      channel.extend({ calendarId: id }),
      ["calendarId"],
    ),
    policyKeys: ["address"],
  },
  op(
    "calendar.instances",
    "read",
    "calendar.read",
    z.object({ calendarId: id, eventId: id, ...page }).strict(),
    ["calendarId"],
  ),
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
    for (const operation of this.manifest.operations) {
      if (["calendar.watch", "drive.watch"].includes(operation.name))
        operation.secretKeys = ["token"];
      if (["mail.reply", "mail.forward"].includes(operation.name))
        operation.scopes = ["mail.send", "mail.read"];
      if (operation.name.startsWith("mail.") && operation.risk !== "read")
        operation.stagingKeys = ["raw", "attachments"];
      if (operation.name === "mail.attachment") operation.stagedResult = true;
    }
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
    if (
      ["drive.download", "drive.export", "sheets.export"].includes(operation)
    ) {
      const fileId = a.fileId ?? a.spreadsheetId,
        url =
          files +
          "/" +
          e(fileId) +
          (operation === "drive.download"
            ? "?alt=media"
            : "/export?mimeType=" + e(a.mimeType));
      const content = await binary(this.http, url, {
        headers: { Authorization: "Bearer " + token },
        signal: ctx.signal,
      });
      return {
        providerId: fileId,
        data: {
          contentBase64: content.bytes.toString("base64"),
          contentType: content.contentType,
          filename: fileId + (a.mimeType === "text/csv" ? ".csv" : ".bin"),
        },
      };
    }
    if (operation === "drive.upload") {
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          a.contentBase64,
        )
      )
        throw new ConnectorError("attachment_invalid");
      const content = Buffer.from(a.contentBase64, "base64");
      if (content.length > 5_000_000)
        throw new ConnectorError("attachment_too_large");
      const boundary = "spiderman_" + ctx.actionId;
      if (content.includes(Buffer.from("--" + boundary)))
        throw new ConnectorError("attachment_boundary_conflict");
      const metadata = JSON.stringify({
        name: a.name,
        mimeType: a.mimeType,
        parents: a.parentId ? [a.parentId] : undefined,
      });
      const payload = Buffer.concat([
        Buffer.from(
          "--" +
            boundary +
            "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
            metadata +
            "\r\n--" +
            boundary +
            "\r\nContent-Type: " +
            a.mimeType +
            "\r\n\r\n",
        ),
        content,
        Buffer.from("\r\n--" + boundary + "--\r\n"),
      ]);
      const result = await binary(
        this.http,
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "multipart/related; boundary=" + boundary,
          },
          body: payload,
          signal: ctx.signal,
          maxBytes: 1_000_000,
        },
      );
      let data;
      try {
        data = JSON.parse(result.bytes.toString());
      } catch {
        throw new ConnectorError("provider_response_invalid", true);
      }
      if (typeof data.id !== "string")
        throw new ConnectorError("provider_receipt_missing", true);
      return { providerId: data.id, data };
    }
    if (operation === "sheets.update") {
      const existing = await json(
        this.http,
        sheet + "/" + e(a.spreadsheetId) + "/values/" + e(a.range),
        "GET",
        token,
        undefined,
        ctx.signal,
      );
      if (
        JSON.stringify(existing.values ?? []) !==
        JSON.stringify(a.expectedValues)
      )
        throw new ConnectorError("spreadsheet_conflict");
    }
    if (operation === "mail.reconcile") {
      const messageId = "<" + a.actionId + "@spiderman.local>",
        matches = await json(
          this.http,
          gmail +
            "/messages?q=" +
            e("in:sent rfc822msgid:" + messageId) +
            "&maxResults=10",
          "GET",
          token,
          undefined,
          ctx.signal,
        );
      for (const hit of matches.messages ?? []) {
        if (typeof hit.id !== "string") continue;
        const message = await json(
          this.http,
          gmail +
            "/messages/" +
            e(hit.id) +
            "?format=metadata&metadataHeaders=Message-ID",
          "GET",
          token,
          undefined,
          ctx.signal,
        );
        if (
          message.labelIds?.includes("SENT") &&
          message.payload?.headers?.some(
            (h: any) =>
              h.name?.toLowerCase() === "message-id" && h.value === messageId,
          )
        )
          return {
            data: {
              matchedActionId: a.actionId,
              providerId: message.id,
              delivery: "sent_message_verified",
            },
          };
      }
      return {
        data: {
          matchedActionId: a.actionId,
          found: false,
          delivery: "unknown",
        },
      };
    }
    const mimeRaw = () => {
      try {
        return Buffer.from(
          buildMime(
            {
              from: { address: ctx.connection.accountId },
              to: a.recipients.map((address: string) => ({ address })),
              subject: a.subject,
              text: a.text,
              html: a.html,
              attachments: a.attachments,
              rfcMessageId: "<" + ctx.actionId + "@spiderman.local>",
              idempotencyKey: ctx.actionId,
              headers: {},
              inReplyTo: a.inReplyTo,
              references: a.references,
            },
            new Date(),
          ),
          "utf8",
        ).toString("base64url");
      } catch (error) {
        if (error instanceof MimeError)
          throw new ConnectorError("mime_invalid");
        throw error;
      }
    };
    if (
      ["mail.draft", "mail.draftUpdate", "mail.send"].includes(operation) &&
      !a.raw
    )
      a.raw = mimeRaw();
    if (operation === "mail.reply" || operation === "mail.forward") {
      const original = await json(
        this.http,
        gmail +
          "/messages/" +
          e(a.messageId) +
          "?format=" +
          (operation === "mail.forward" ? "raw" : "metadata"),
        "GET",
        token,
        undefined,
        ctx.signal,
      );
      if (typeof original.id !== "string")
        throw new ConnectorError("message_not_found");
      if (operation === "mail.reply") {
        const headers = original.payload?.headers ?? [],
          value = (name: string) =>
            headers.find(
              (h: any) => h.name?.toLowerCase() === name.toLowerCase(),
            )?.value;
        const reference = value("Message-ID");
        if (typeof reference !== "string" || !/^<[^<>\s]+>$/.test(reference))
          throw new ConnectorError("reply_reference_missing");
        a.inReplyTo = reference;
        a.references = [
          ...(value("References")?.match(/<[^<>\s]+>/g) ?? []).slice(-20),
          reference,
        ];
        a.threadId = original.threadId;
      } else {
        if (typeof original.raw !== "string")
          throw new ConnectorError("forward_content_missing");
        a.attachments = [
          ...(a.attachments ?? []),
          {
            filename: "forwarded.eml",
            contentType: "message/rfc822",
            contentBase64: Buffer.from(original.raw, "base64url").toString(
              "base64",
            ),
          },
        ];
      }
      a.raw = mimeRaw();
    }
    switch (operation) {
      case "mail.profile":
        url = gmail + "/profile";
        break;
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
      case "mail.labels":
        url = gmail + "/labels";
        break;
      case "mail.drafts":
        url =
          gmail +
          "/drafts?maxResults=" +
          a.pageSize +
          (a.pageToken ? "&pageToken=" + e(a.pageToken) : "");
        break;
      case "mail.draftGet":
        url = gmail + "/drafts/" + e(a.draftId) + "?format=full";
        break;
      case "mail.draft":
      case "mail.draftUpdate":
        url = gmail + "/drafts" + (a.draftId ? "/" + e(a.draftId) : "");
        method = a.draftId ? "PUT" : "POST";
        body = { message: { raw: a.raw, threadId: a.threadId } };
        break;
      case "mail.reply":
      case "mail.forward":
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
        // Stable transport identity supports read-only Sent reconciliation.
        const divider = /\r?\n\r?\n/.exec(mime);
        if (!divider) throw new ConnectorError("mime_invalid");
        const stableHead = mime
          .slice(0, divider.index)
          .replace(
            /^(?:Message-ID|X-Spiderman-Key):[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*(?:\r?\n|$)/gim,
            "",
          );
        a.raw = Buffer.from(
          "Message-ID: <" +
            ctx.actionId +
            "@spiderman.local>\r\nX-Spiderman-Key: " +
            ctx.actionId +
            "\r\n" +
            stableHead +
            "\r\n\r\n" +
            mime.slice(divider.index + divider[0].length),
        ).toString("base64url");
        const from = [...head.matchAll(/^From:(.+)$/gim)].map((m) =>
          m[1]!.trim().toLowerCase(),
        );
        if (
          from.length !== 1 ||
          from[0] !== ctx.connection.accountId.toLowerCase() ||
          /^Resent-|^Return-Path:|^Sender:/im.test(head)
        )
          throw new ConnectorError("mime_sender_mismatch");
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
      case "mail.stopWatch":
        url = gmail + "/stop";
        method = "POST";
        break;
      case "drive.watch":
      case "calendar.watch":
        if (
          a.expiresAt <= Date.now() + 300000 ||
          a.expiresAt > Date.now() + 7 * 86400000
        )
          throw new ConnectorError("subscription_expiry_invalid");
        url =
          operation === "drive.watch"
            ? "https://www.googleapis.com/drive/v3/changes/watch?pageToken=" +
              e(a.pageToken)
            : cal + "/calendars/" + e(a.calendarId) + "/events/watch";
        method = "POST";
        body = {
          id: a.channelId,
          type: "web_hook",
          address: a.address,
          token: a.token,
          expiration: String(a.expiresAt),
        };
        break;
      case "drive.startCursor":
        url = "https://www.googleapis.com/drive/v3/changes/startPageToken";
        break;
      case "drive.folderChildren":
        url =
          files +
          "?pageSize=" +
          a.pageSize +
          "&fields=nextPageToken,files(id,name,mimeType,modifiedTime,parents)&q=" +
          e(
            "'" +
              a.parentId.replace(/['\\]/g, "\\$&") +
              "' in parents and trashed = false",
          ) +
          (a.pageToken ? "&pageToken=" + e(a.pageToken) : "");
        break;
      case "sheets.discover":
        url =
          files +
          "?pageSize=" +
          a.pageSize +
          "&q=" +
          e(
            "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
          ) +
          "&fields=nextPageToken,files(id,name,mimeType,modifiedTime)" +
          (a.pageToken ? "&pageToken=" + e(a.pageToken) : "");
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
      case "drive.move":
        url =
          files +
          "/" +
          e(a.fileId) +
          "?addParents=" +
          e(a.parentId) +
          "&removeParents=" +
          e(a.removeParents.join(","));
        method = "PATCH";
        headers["If-Match"] = a.etag;
        body = {};
        break;
      case "drive.trash":
        url = files + "/" + e(a.fileId);
        method = "PATCH";
        headers["If-Match"] = a.etag;
        body = { trashed: true };
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
          e(a.pageToken) +
          "&pageSize=100&fields=nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,modifiedTime,version))";
        break;
      case "drive.share":
        url = files + "/" + e(a.fileId) + "/permissions";
        method = "POST";
        body = { type: "user", emailAddress: a.emailAddress, role: a.role };
        break;
      case "sheets.addSheet":
        url = sheet + "/" + e(a.spreadsheetId) + ":batchUpdate";
        method = "POST";
        body = { requests: [{ addSheet: { properties: { title: a.title } } }] };
        break;
      case "sheets.batch":
        url = sheet + "/" + e(a.spreadsheetId) + ":batchUpdate";
        method = "POST";
        body = { requests: a.requests };
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
          "/events?showDeleted=true&maxResults=" +
          a.pageSize +
          (a.syncToken ? "&syncToken=" + e(a.syncToken) : "") +
          (a.pageToken ? "&pageToken=" + e(a.pageToken) : "");
        break;
      case "calendar.instances":
        url =
          cal +
          "/calendars/" +
          e(a.calendarId) +
          "/events/" +
          e(a.eventId) +
          "/instances?maxResults=" +
          a.pageSize +
          (a.pageToken ? "&pageToken=" + e(a.pageToken) : "");
        break;
      case "calendar.get":
        url = cal + "/calendars/" + e(a.calendarId) + "/events/" + e(a.eventId);
        break;
      case "calendar.create":
        url = cal + "/calendars/" + e(a.calendarId) + "/events";
        method = "POST";
        body = {
          ...a.event,
          id: ctx.actionId.slice(0, 32),
          extendedProperties: {
            private: {
              ...a.event.extendedProperties?.private,
              spidermanAction: ctx.actionId,
            },
          },
        };
        break;
      case "calendar.update":
        url = cal + "/calendars/" + e(a.calendarId) + "/events/" + e(a.eventId);
        method = "PUT";
        body = {
          ...a.event,
          extendedProperties: {
            private: {
              ...a.event.extendedProperties?.private,
              spidermanAction: ctx.actionId,
            },
          },
        };
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
    if (
      [
        "mail.send",
        "mail.reply",
        "mail.forward",
        "mail.draftUpdate",
        "mail.draft",
        "mail.modify",
        "mail.trash",
        "drive.create",
        "drive.move",
        "drive.trash",
        "drive.update",
        "drive.share",
        "calendar.create",
        "calendar.update",
      ].includes(operation) &&
      (!data.id || typeof data.id !== "string")
    )
      throw new ConnectorError("provider_receipt_missing", true);
    if (operation === "sheets.create" && typeof data.spreadsheetId !== "string")
      throw new ConnectorError("provider_receipt_missing", true);
    if (operation === "mail.watch" && (!data.historyId || !data.expiration))
      throw new ConnectorError("watch_receipt_missing", true);
    if (
      ["drive.watch", "calendar.watch"].includes(operation) &&
      (data.id !== a.channelId ||
        typeof data.resourceId !== "string" ||
        !Number.isSafeInteger(Number(data.expiration)) ||
        Number(data.expiration) <= Date.now())
    )
      throw new ConnectorError("watch_receipt_missing", true);
    if (["drive.watch", "calendar.watch"].includes(operation))
      delete data.token;
    if (
      [
        "sheets.update",
        "sheets.append",
        "sheets.batch",
        "sheets.addSheet",
      ].includes(operation) &&
      typeof data.spreadsheetId !== "string"
    )
      throw new ConnectorError("provider_receipt_missing", true);
    if (operation === "sheets.update")
      data.concurrency = "preflight_compare_not_atomic";
    if (operation === "mail.attachment") {
      if (typeof data.data !== "string")
        throw new ConnectorError("attachment_response_invalid");
      const bytes = Buffer.from(data.data, "base64url");
      if (bytes.length > 6_000_000)
        throw new ConnectorError("attachment_too_large");
      const original = await json(
        this.http,
        gmail + "/messages/" + e(a.messageId) + "?format=full",
        "GET",
        token,
        undefined,
        ctx.signal,
      );
      let part: any;
      const find = (node: any) => {
        if (node?.body?.attachmentId === a.attachmentId) part = node;
        for (const child of node?.parts ?? []) find(child);
      };
      find(original.payload);
      return {
        providerId: a.attachmentId,
        data: {
          contentBase64: bytes.toString("base64"),
          contentType: part?.mimeType ?? "application/octet-stream",
          filename: part?.filename ?? "attachment.bin",
          size: bytes.length,
        },
      };
    }
    if (
      [
        "mail.get",
        "mail.thread",
        "mail.draftGet",
        "drive.get",
        "calendar.get",
      ].includes(operation) &&
      typeof data.id !== "string"
    )
      throw new ConnectorError("provider_response_invalid");
    return {
      providerId:
        data.id ??
        data.spreadsheetId ??
        (operation === "mail.watch" ? data.historyId : undefined),
      data,
    };
  }
}
