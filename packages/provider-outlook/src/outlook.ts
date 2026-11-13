import { z } from "zod";
import { ConnectorError, type Operation } from "@splitin/spiderman-contracts";
import type { Provider, ProviderContext } from "@splitin/spiderman-core";
import { json, required, type Http } from "@splitin/spiderman-provider-kit";
const id = z.string().min(1).max(1000),
  content = z.string().max(100000),
  base = "https://graph.microsoft.com/v1.0/me";
const make = (
  name: string,
  risk: Operation["risk"],
  scope: string,
  input: z.ZodType<Record<string, unknown>>,
  recipientKeys?: string[],
  resourceKeys?: string[],
): Operation => ({
  name,
  risk,
  scopes: [scope],
  input,
  recipientKeys,
  resourceKeys,
});
const draft = z
  .object({
    subject: content,
    body: content,
    recipients: z.array(z.email()).min(1).max(20),
    sender: z.email().optional(),
    attachments: z
      .array(
        z
          .object({
            filename: z.string().regex(/^[A-Za-z0-9_. -]{1,120}$/),
            contentType: z.string().regex(/^[-\w.+]+\/[-\w.+]+$/),
            contentBase64: z.string().max(4_000_000),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();
export class OutlookProvider implements Provider {
  readonly manifest = {
    provider: "outlook",
    version: "1",
    qualification: "automated_only" as const,
    operations: [
      {
        ...make(
          "mail.subscribe",
          "write",
          "Mail.Read",
          z
            .object({
              notificationUrl: z.url().refine((v) => {
                const u = new URL(v);
                return (
                  u.protocol === "https:" &&
                  !u.username &&
                  !u.password &&
                  !u.search &&
                  !u.hash
                );
              }),
              clientState: z.string().min(32).max(128),
              expiresAt: z.number().int().positive(),
            })
            .strict(),
        ),
        policyKeys: ["notificationUrl"],
      },
      {
        ...make(
          "mail.renewSubscription",
          "write",
          "Mail.Read",
          z
            .object({
              subscriptionId: id,
              expiresAt: z.number().int().positive(),
            })
            .strict(),
        ),
        policyKeys: ["subscriptionId"],
      },
      make(
        "mail.subscription",
        "read",
        "Mail.Read",
        z.object({ subscriptionId: id }).strict(),
      ),
      make(
        "mail.draftUpdate",
        "draft",
        "Mail.ReadWrite",
        draft.extend({ draftId: id, etag: z.string().min(1) }),
      ),
      make(
        "mail.forward",
        "write",
        "Mail.Send",
        z
          .object({
            messageId: id,
            comment: content,
            recipients: z.array(z.email()).min(1).max(20),
          })
          .strict(),
        ["recipients"],
      ),
      make(
        "mail.reconcile",
        "read",
        "Mail.Read",
        z.object({ draftId: id }).strict(),
      ),
      make("mail.folders", "read", "Mail.Read", z.object({}).strict()),
      make(
        "mail.attachment",
        "read",
        "Mail.Read",
        z.object({ messageId: id, attachmentId: id }).strict(),
      ),
      make(
        "mail.search",
        "read",
        "Mail.Read",
        z.object({ query: id.optional(), nextLink: id.optional() }).strict(),
      ),
      make(
        "mail.get",
        "read",
        "Mail.Read",
        z.object({ messageId: id }).strict(),
      ),
      make(
        "mail.attachments",
        "read",
        "Mail.Read",
        z.object({ messageId: id }).strict(),
      ),
      make("mail.draft", "draft", "Mail.ReadWrite", draft),
      make("mail.send", "write", "Mail.Send", draft, ["recipients"]),
      make(
        "mail.reply",
        "write",
        "Mail.Send",
        z
          .object({
            messageId: id,
            comment: content,
            recipients: z.array(z.email()).min(1).max(20),
          })
          .strict(),
        ["recipients"],
        ["messageId"],
      ),
      make(
        "mail.move",
        "write",
        "Mail.ReadWrite",
        z.object({ messageId: id, destinationId: id }).strict(),
        undefined,
        ["messageId"],
      ),
      make(
        "mail.readState",
        "write",
        "Mail.ReadWrite",
        z.object({ messageId: id, isRead: z.boolean() }).strict(),
        undefined,
        ["messageId"],
      ),
      make(
        "mail.trash",
        "destructive",
        "Mail.ReadWrite",
        z.object({ messageId: id }).strict(),
      ),
      make(
        "mail.delta",
        "read",
        "Mail.Read",
        z.object({ cursor: id.optional() }).strict(),
      ),
    ],
  };
  constructor(readonly http: Http = fetch) {
    for (const operation of this.manifest.operations) {
      if (operation.name === "mail.subscribe")
        operation.secretKeys = ["clientState"];
      if (["mail.send", "mail.reply", "mail.forward"].includes(operation.name))
        operation.scopes = ["Mail.Send", "Mail.ReadWrite"];
      if (operation.name === "mail.attachment") operation.stagedResult = true;
      if (operation.name.startsWith("mail.") && operation.risk !== "read")
        operation.stagingKeys = ["attachments"];
    }
  }

  async verify(c: Record<string, unknown>) {
    const token = required(c, "accessToken"),
      profile = await json(
        this.http,
        base + "?$select=id,mail,userPrincipalName",
        "GET",
        token,
      );
    let claims: any;
    try {
      claims = JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
      );
    } catch {
      if (
        Array.isArray(c.grantedScopes) &&
        c.grantedScopes.every((scope) => typeof scope === "string")
      )
        claims = { scp: c.grantedScopes.join(" ") };
      else throw new ConnectorError("graph_scope_unverified");
    }
    if (
      typeof claims?.scp !== "string" &&
      Array.isArray(c.grantedScopes) &&
      c.grantedScopes.every((scope) => typeof scope === "string")
    )
      claims = { scp: c.grantedScopes.join(" ") };
    if (!profile.id || typeof claims.scp !== "string")
      throw new ConnectorError("graph_identity_unverified");
    const scopes: string[] = claims.scp.split(" ");
    if (scopes.includes("Mail.ReadWrite") && !scopes.includes("Mail.Read"))
      scopes.push("Mail.Read");
    return { accountId: profile.id, scopes };
  }
  async execute(
    name: string,
    input: Record<string, unknown>,
    ctx: ProviderContext,
  ) {
    const spec = this.manifest.operations.find((o) => o.name === name);
    if (!spec) throw new ConnectorError("operation_unavailable");
    const a = spec.input.parse(input) as any,
      e = encodeURIComponent;
    let url = "",
      method = "GET",
      body: unknown;
    const message = {
      ...(a.sender ? { from: { emailAddress: { address: a.sender } } } : {}),
      attachments: a.attachments?.map((attachment: any) => {
        if (Buffer.from(attachment.contentBase64, "base64").length > 3_000_000)
          throw new ConnectorError("attachment_too_large");
        return {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: attachment.filename,
          contentType: attachment.contentType,
          contentBytes: attachment.contentBase64,
        };
      }),
      subject: a.subject,
      body: { contentType: "Text", content: a.body },
      toRecipients: a.recipients?.map((address: string) => ({
        emailAddress: { address },
      })),
    };
    const token = required(ctx.credentials, "accessToken"),
      headers = { Prefer: 'IdType="ImmutableId"' };
    if (
      [
        "mail.subscribe",
        "mail.renewSubscription",
        "mail.subscription",
      ].includes(name)
    ) {
      if (
        name !== "mail.subscription" &&
        (a.expiresAt <= Date.now() + 300000 ||
          a.expiresAt > Date.now() + 6 * 86400000)
      )
        throw new ConnectorError("subscription_expiry_invalid");
      const data = await json(
        this.http,
        "https://graph.microsoft.com/v1.0/subscriptions" +
          (a.subscriptionId ? "/" + e(a.subscriptionId) : ""),
        name === "mail.subscribe"
          ? "POST"
          : name === "mail.renewSubscription"
            ? "PATCH"
            : "GET",
        token,
        name === "mail.subscribe"
          ? {
              changeType: "created,updated,deleted",
              resource: "me/mailFolders('inbox')/messages",
              notificationUrl: a.notificationUrl,
              lifecycleNotificationUrl: a.notificationUrl,
              clientState: a.clientState,
              expirationDateTime: new Date(a.expiresAt).toISOString(),
            }
          : name === "mail.renewSubscription"
            ? { expirationDateTime: new Date(a.expiresAt).toISOString() }
            : undefined,
        ctx.signal,
      );
      if (
        typeof data.id !== "string" ||
        (a.subscriptionId && data.id !== a.subscriptionId) ||
        !Number.isFinite(Date.parse(data.expirationDateTime))
      )
        throw new ConnectorError(
          "subscription_receipt_missing",
          name !== "mail.subscription",
        );
      // Never cache the callback verification secret from an echoed provider response.
      return {
        providerId: data.id,
        data: {
          id: data.id,
          expirationDateTime: data.expirationDateTime,
          resource: data.resource,
        },
      };
    }
    if (["mail.send", "mail.reply", "mail.forward"].includes(name)) {
      const path =
        name === "mail.send"
          ? "/messages"
          : "/messages/" +
            e(a.messageId) +
            (name === "mail.reply" ? "/createReply" : "/createForward");
      const prepared = await json(
        this.http,
        base + path,
        "POST",
        token,
        name === "mail.send"
          ? message
          : {
              comment: a.comment,
              ...(name === "mail.forward"
                ? { toRecipients: message.toRecipients }
                : {}),
            },
        ctx.signal,
        headers,
      );
      if (typeof prepared.id !== "string" || !prepared.id)
        throw new ConnectorError("graph_draft_receipt_missing", true);
      await ctx.checkpoint?.({ draftId: prepared.id });
      if (name !== "mail.send")
        await json(
          this.http,
          base + "/messages/" + e(prepared.id),
          "PATCH",
          token,
          {
            toRecipients: message.toRecipients,
            ccRecipients: [],
            bccRecipients: [],
          },
          ctx.signal,
          headers,
        );
      await json(
        this.http,
        base + "/messages/" + e(prepared.id) + "/send",
        "POST",
        token,
        undefined,
        ctx.signal,
        headers,
      );
      try {
        const sent = await json(
          this.http,
          base +
            "/messages/" +
            e(prepared.id) +
            "?$select=id,isDraft,internetMessageId",
          "GET",
          token,
          undefined,
          ctx.signal,
          headers,
        );
        if (
          sent.id !== prepared.id ||
          sent.isDraft !== false ||
          typeof sent.internetMessageId !== "string"
        )
          throw Error("pending");
        return {
          providerId: sent.id,
          data: { ...sent, delivery: "sent_message_verified" },
        };
      } catch {
        throw new ConnectorError("graph_send_pending_reconciliation", true);
      }
    }
    if (name === "mail.move") {
      const trash = await json(
        this.http,
        base + "/mailFolders/deleteditems?$select=id",
        "GET",
        token,
        undefined,
        ctx.signal,
        headers,
      );
      if (typeof trash.id !== "string")
        throw new ConnectorError("trash_folder_unverified");
      if (
        a.destinationId.toLowerCase() === "deleteditems" ||
        a.destinationId === trash.id
      )
        throw new ConnectorError("use_explicit_trash_operation");
    }
    switch (name) {
      case "mail.reconcile":
        url =
          base +
          "/messages/" +
          e(a.draftId) +
          "?$select=id,isDraft,internetMessageId";
        break;
      case "mail.folders":
        url = base + "/mailFolders?$top=100";
        break;
      case "mail.attachment":
        url =
          base +
          "/messages/" +
          e(a.messageId) +
          "/attachments/" +
          e(a.attachmentId);
        break;
      case "mail.draftUpdate":
        url = base + "/messages/" + e(a.draftId);
        method = "PATCH";
        body = message;
        break;
      case "mail.search":
        url =
          a.nextLink ??
          base +
            "/messages?$top=50" +
            (a.query ? "&$search=" + e('"' + a.query + '"') : "");
        break;
      case "mail.get":
        url = base + "/messages/" + e(a.messageId);
        break;
      case "mail.attachments":
        url = base + "/messages/" + e(a.messageId) + "/attachments";
        break;
      case "mail.draft":
        url = base + "/messages";
        method = "POST";
        body = message;
        break;
      case "mail.send":
        url = base + "/sendMail";
        method = "POST";
        body = { message, saveToSentItems: true };
        break;
      case "mail.reply":
        url = base + "/messages/" + e(a.messageId) + "/reply";
        method = "POST";
        body = { comment: a.comment };
        break;
      case "mail.move":
        url = base + "/messages/" + e(a.messageId) + "/move";
        method = "POST";
        body = { destinationId: a.destinationId };
        break;
      case "mail.readState":
        url = base + "/messages/" + e(a.messageId);
        method = "PATCH";
        body = { isRead: a.isRead };
        break;
      case "mail.trash":
        url = base + "/messages/" + e(a.messageId) + "/move";
        method = "POST";
        body = { destinationId: "deleteditems" };
        break;
      case "mail.delta":
        url =
          a.cursor ??
          base +
            "/mailFolders/inbox/messages/delta?$select=id,changeKey,internetMessageId,lastModifiedDateTime";
        break;
      default:
        throw new ConnectorError("operation_unavailable");
    }
    const u = new URL(url);
    if (
      u.origin !== "https://graph.microsoft.com" ||
      !u.pathname.startsWith("/v1.0/me/")
    )
      throw new ConnectorError("graph_cursor_invalid");
    const data = await json(
      this.http,
      url,
      method,
      required(ctx.credentials, "accessToken"),
      body,
      ctx.signal,
      { ...headers, ...(a.etag ? { "If-Match": a.etag } : {}) },
    );
    if (
      [
        "mail.draft",
        "mail.draftUpdate",
        "mail.move",
        "mail.readState",
        "mail.trash",
      ].includes(name) &&
      typeof data.id !== "string"
    )
      throw new ConnectorError("graph_receipt_missing", true);
    if (name === "mail.attachment")
      return {
        providerId: data.id,
        data: {
          contentBase64: data.contentBytes,
          contentType: data.contentType,
          filename: data.name,
        },
      };
    return { providerId: data.id, data };
  }
}
