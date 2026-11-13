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
  })
  .strict();
export class OutlookProvider implements Provider {
  readonly manifest = {
    provider: "outlook",
    version: "1",
    qualification: "automated_only" as const,
    operations: [
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
        z.object({ messageId: id, comment: content }).strict(),
        undefined,
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
  constructor(readonly http: Http = fetch) {}
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
      throw new ConnectorError("graph_scope_unverified");
    }
    if (!profile.id || typeof claims.scp !== "string")
      throw new ConnectorError("graph_identity_unverified");
    return { accountId: profile.id, scopes: claims.scp.split(" ") };
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
      subject: a.subject,
      body: { contentType: "Text", content: a.body },
      toRecipients: a.recipients?.map((address: string) => ({
        emailAddress: { address },
      })),
    };
    switch (name) {
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
        url = a.cursor ?? base + "/mailFolders/inbox/messages/delta";
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
    );
    return { providerId: data.id, data };
  }
}
