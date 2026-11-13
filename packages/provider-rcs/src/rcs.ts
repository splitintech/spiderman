import { z } from "zod";
import { ConnectorError, type Operation } from "@splitin/spiderman-contracts";
import type { Provider, ProviderContext } from "@splitin/spiderman-core";
import { json, required, type Http } from "@splitin/spiderman-provider-kit";
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
/** Google RCS for Business. OAuth service-account tokens are supplied by a credential broker. */
export class RcsBusinessProvider implements Provider {
  readonly manifest = {
    provider: "rcs-business",
    version: "1",
    transport: "rcs-business",
    qualification: "automated_only" as const,
    operations: [
      {
        name: "message.capability",
        risk: "read",
        scopes: ["rcs"],
        input: z.object({ recipient: phone }).strict(),
      },
      {
        name: "message.send",
        risk: "write",
        scopes: ["rcs"],
        input: z
          .object({ recipient: phone, text: z.string().min(1).max(3072) })
          .strict(),
        recipientKeys: ["recipient"],
      },
    ] satisfies Operation[],
  };
  constructor(readonly http: Http = fetch) {}
  async verify(c: Record<string, unknown>) {
    const agent = required(c, "agentId");
    if (!/^[A-Za-z0-9_-]+$/.test(agent))
      throw new ConnectorError("rcs_agent_invalid");
    const data = await json(
      this.http,
      "https://businesscommunications.googleapis.com/v1/brands/" +
        encodeURIComponent(required(c, "brandId")) +
        "/agents/" +
        agent,
      "GET",
      required(c, "accessToken"),
    );
    if (!data.name) throw new ConnectorError("rcs_agent_unverified");
    return { accountId: data.name, scopes: ["rcs"] };
  }
  async execute(
    name: string,
    raw: Record<string, unknown>,
    ctx: ProviderContext,
  ) {
    const spec = this.manifest.operations.find((o) => o.name === name);
    if (!spec) throw new ConnectorError("operation_unavailable");
    const a = spec.input.parse(raw) as any,
      agent = encodeURIComponent(required(ctx.credentials, "agentId")),
      base =
        "https://rcsbusinessmessaging.googleapis.com/v1/phones/" +
        encodeURIComponent(a.recipient),
      token = required(ctx.credentials, "accessToken");
    if (name === "message.capability")
      return {
        data: await json(
          this.http,
          base + "/capabilities?agentId=" + agent,
          "GET",
          token,
          undefined,
          ctx.signal,
        ),
      };
    const data = await json(
      this.http,
      base + "/agentMessages?agentId=" + agent + "&messageId=" + ctx.actionId,
      "POST",
      token,
      { contentMessage: { text: a.text } },
      ctx.signal,
    );
    if (!data.name) throw new ConnectorError("rcs_receipt_missing", true);
    return {
      providerId: data.name,
      data: {
        providerId: data.name,
        transport: "rcs-business",
        delivery: "submitted",
      },
    };
  }
}
