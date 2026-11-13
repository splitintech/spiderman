import { z } from "zod";
import { ConnectorError, type Operation } from "@splitin/spiderman-contracts";
import type { Provider, ProviderContext } from "@splitin/spiderman-core";
import {
  json,
  required,
  localEndpoint,
  type Http,
} from "@splitin/spiderman-provider-kit";
const guid = z.string().regex(/^iMessage;-;.{1,250}$/);
export class IMessageProvider implements Provider {
  readonly manifest = {
    provider: "imessage",
    version: "bluebubbles-1.9.12",
    transport: "imessage",
    qualification: "automated_only" as const,
    operations: [
      {
        name: "message.send",
        risk: "write",
        scopes: ["messages"],
        input: z
          .object({ recipient: guid, text: z.string().min(1).max(10000) })
          .strict(),
        recipientKeys: ["recipient"],
      },
      {
        name: "message.history",
        risk: "read",
        scopes: ["messages"],
        input: z
          .object({
            chatGuid: guid,
            after: z.number().int().optional(),
            offset: z.number().int().min(0).default(0),
          })
          .strict(),
        resourceKeys: ["chatGuid"],
      },
    ] satisfies Operation[],
  };
  constructor(
    readonly origins: readonly string[],
    readonly http: Http = fetch,
  ) {}
  url(c: Record<string, unknown>, path: string) {
    return (
      localEndpoint(c, this.origins) +
      path +
      "?password=" +
      encodeURIComponent(required(c, "password"))
    );
  }
  async verify(c: Record<string, unknown>) {
    const response = await json(this.http, this.url(c, "/api/v1/server/info"));
    if (!response.data) throw new ConnectorError("relay_unavailable");
    const account =
      String(response.data.os_version ?? "") +
      ":" +
      String(response.data.server_version ?? "");
    if (account === ":") throw new ConnectorError("relay_version_unverified");
    return { accountId: localEndpoint(c, this.origins), scopes: ["messages"] };
  }
  async execute(
    name: string,
    raw: Record<string, unknown>,
    ctx: ProviderContext,
  ) {
    const spec = this.manifest.operations.find((o) => o.name === name);
    if (!spec) throw new ConnectorError("operation_unavailable");
    const a = spec.input.parse(raw) as any;
    const body =
      name === "message.send"
        ? {
            chatGuid: a.recipient,
            tempGuid: ctx.actionId,
            message: a.text,
            method: "apple-script",
          }
        : {
            chatGuid: a.chatGuid,
            after: a.after,
            offset: a.offset,
            limit: 100,
            sort: "ASC",
            with: ["handle"],
          };
    const data = await json(
      this.http,
      this.url(
        ctx.credentials,
        name === "message.send"
          ? "/api/v1/message/text"
          : "/api/v1/message/query",
      ),
      "POST",
      undefined,
      body,
      ctx.signal,
    );
    if (name === "message.send" && !data.data?.guid)
      throw new ConnectorError("send_receipt_missing", true);
    return { providerId: data.data?.guid, data };
  }
}
