import { z } from "zod";
import { ConnectorError, type Operation } from "@splitin/spiderman-contracts";
import type { Provider, ProviderContext } from "@splitin/spiderman-core";
import { json, required, type Http } from "@splitin/spiderman-provider-kit";
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/),
  uuid = z.string().uuid();
export class PlivoProvider implements Provider {
  readonly manifest = {
    provider: "plivo",
    version: "1",
    transport: "phone",
    qualification: "automated_only" as const,
    operations: [
      {
        name: "call.create",
        risk: "write",
        scopes: ["calls"],
        input: z
          .object({
            recipient: phone,
            answerUrl: z.url(),
            timeLimit: z.number().int().min(1).max(900).default(120),
          })
          .strict(),
        recipientKeys: ["recipient"],
      },
      {
        name: "call.get",
        risk: "read",
        scopes: ["calls"],
        input: z.object({ callId: uuid }).strict(),
      },
      {
        name: "call.hangup",
        risk: "write",
        scopes: ["calls"],
        input: z.object({ callId: uuid }).strict(),
        resourceKeys: ["callId"],
      },
    ] satisfies Operation[],
  };
  constructor(
    readonly answerOrigins: readonly string[],
    readonly http: Http = fetch,
  ) {}
  auth(c: Record<string, unknown>) {
    const account = required(c, "authId");
    if (!/^[A-Za-z0-9]+$/.test(account))
      throw new ConnectorError("plivo_account_invalid");
    return {
      base: "https://api.plivo.com/v1/Account/" + account + "/",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(account + ":" + required(c, "authToken")).toString(
            "base64",
          ),
      },
    };
  }
  async verify(c: Record<string, unknown>) {
    const { base, headers } = this.auth(c);
    const data = await json(
      this.http,
      base,
      "GET",
      undefined,
      undefined,
      undefined,
      headers,
    );
    if (!data.auth_id) throw new ConnectorError("plivo_account_unverified");
    phone.parse(c.from);
    return { accountId: data.auth_id, scopes: ["calls"] };
  }
  async execute(
    name: string,
    raw: Record<string, unknown>,
    ctx: ProviderContext,
  ) {
    const spec = this.manifest.operations.find((o) => o.name === name);
    if (!spec) throw new ConnectorError("operation_unavailable");
    const a = spec.input.parse(raw) as any,
      { base, headers } = this.auth(ctx.credentials);
    let path = "Call/",
      method = "GET",
      body: unknown;
    if (name === "call.create") {
      const url = new URL(a.answerUrl);
      if (url.protocol !== "https:" || !this.answerOrigins.includes(url.origin))
        throw new ConnectorError("call_answer_url_denied");
      method = "POST";
      body = {
        from: phone.parse(ctx.credentials.from),
        to: a.recipient,
        answer_url: a.answerUrl,
        answer_method: "POST",
        time_limit: a.timeLimit,
      };
    } else {
      path += a.callId + "/";
      if (name === "call.hangup") method = "DELETE";
    }
    const data = await json(
      this.http,
      base + path,
      method,
      undefined,
      body,
      ctx.signal,
      headers,
    );
    if (name === "call.create" && !data.request_uuid)
      throw new ConnectorError("call_receipt_missing", true);
    return { providerId: data.request_uuid ?? data.call_uuid, data };
  }
}
