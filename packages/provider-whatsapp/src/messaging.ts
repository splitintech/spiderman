import { z } from "zod";
import { ConnectorError, type Operation } from "@splitin/spiderman-contracts";
import type { Provider, ProviderContext } from "@splitin/spiderman-core";
import {
  json,
  required,
  localEndpoint,
  type Http,
} from "@splitin/spiderman-provider-kit";
const address = z.string().min(1).max(300),
  text = z.string().min(1).max(10000),
  phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const sendSchema = z.object({ recipient: address, text }).strict();
const send: Operation = {
  name: "message.send",
  risk: "write",
  scopes: ["messages"],
  input: sendSchema,
  recipientKeys: ["recipient"],
};
export class WhatsAppBusinessProvider implements Provider {
  readonly manifest = {
    provider: "whatsapp-business",
    version: "1",
    transport: "whatsapp-business",
    qualification: "automated_only" as const,
    operations: [
      send,
      {
        name: "message.template",
        risk: "write" as const,
        scopes: ["messages"],
        input: z
          .object({ recipient: phone, name: address, language: address })
          .strict(),
        recipientKeys: ["recipient"],
      },
    ],
  };
  constructor(
    readonly graphVersion: string,
    readonly http: Http = fetch,
  ) {
    if (!/^v\d+\.\d+$/.test(graphVersion))
      throw new Error("meta_api_version_required");
  }
  async verify(c: Record<string, unknown>) {
    const phoneId = required(c, "phoneNumberId");
    if (!/^\d+$/.test(phoneId))
      throw new ConnectorError("phone_number_id_invalid");
    const data = await json(
      this.http,
      `https://graph.facebook.com/${this.graphVersion}/${phoneId}?fields=id,display_phone_number,verified_name`,
      "GET",
      required(c, "accessToken"),
    );
    if (data.id !== phoneId)
      throw new ConnectorError("sender_identity_unverified");
    return { accountId: data.id, scopes: ["messages"] };
  }
  async execute(
    name: string,
    raw: Record<string, unknown>,
    ctx: ProviderContext,
  ) {
    const spec = this.manifest.operations.find((o) => o.name === name);
    if (!spec) throw new ConnectorError("operation_unavailable");
    const a = spec.input.parse(raw) as any;
    // Meta enforces the service window and approved templates; rejected sends stay failures.
    const body =
      name === "message.send"
        ? {
            messaging_product: "whatsapp",
            to: a.recipient,
            type: "text",
            text: { body: a.text },
          }
        : {
            messaging_product: "whatsapp",
            to: a.recipient,
            type: "template",
            template: { name: a.name, language: { code: a.language } },
          };
    const data = await json(
      this.http,
      `https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(required(ctx.credentials, "phoneNumberId"))}/messages`,
      "POST",
      required(ctx.credentials, "accessToken"),
      body,
      ctx.signal,
    );
    const providerId = data.messages?.[0]?.id;
    if (!providerId) throw new ConnectorError("send_receipt_missing", true);
    return { providerId, data: { providerId, delivery: "submitted" } };
  }
}
/** Connects to an independently installed mautrix bridge through Matrix Client-Server. */
export class MatrixMessagesProvider implements Provider {
  readonly manifest = {
    provider: "android-messages",
    version: "1",
    transport: "bridge-reported",
    qualification: "automated_only" as const,
    operations: [
      {
        ...send,
        name: "message.send",
        input: z
          .object({
            recipient: address,
            text,
            transport: z.enum(["rcs", "sms", "mms"]),
          })
          .strict(),
      },
      {
        name: "message.history",
        risk: "read" as const,
        scopes: ["messages"],
        input: z.object({ roomId: address, from: address.optional() }).strict(),
        resourceKeys: ["roomId"],
      },
    ],
  };
  constructor(
    readonly origins: readonly string[],
    readonly http: Http = fetch,
  ) {}
  async verify(c: Record<string, unknown>) {
    const origin = localEndpoint(c, this.origins),
      who = await json(
        this.http,
        origin + "/_matrix/client/v3/account/whoami",
        "GET",
        required(c, "accessToken"),
      );
    if (!who.user_id) throw new ConnectorError("matrix_identity_unverified");
    return { accountId: who.user_id, scopes: ["messages"] };
  }
  async execute(
    name: string,
    raw: Record<string, unknown>,
    ctx: ProviderContext,
  ) {
    const spec = this.manifest.operations.find((o) => o.name === name);
    if (!spec) throw new ConnectorError("operation_unavailable");
    const a = spec.input.parse(raw) as any,
      origin = localEndpoint(ctx.credentials, this.origins);
    if (name === "message.history") {
      const data = await json(
        this.http,
        origin +
          "/_matrix/client/v3/rooms/" +
          encodeURIComponent(a.roomId) +
          "/messages?dir=b&limit=50" +
          (a.from ? "&from=" + encodeURIComponent(a.from) : ""),
        "GET",
        required(ctx.credentials, "accessToken"),
        undefined,
        ctx.signal,
      );
      return { data };
    }
    // Room membership is not sufficient to prove a Google Messages transport. A
    // bridge-maintained room binding must be configured, and no SMS fallback occurs.
    const bindings = ctx.credentials.rooms as
        Record<string, { transport: string; owner: string }> | undefined,
      binding = bindings?.[a.recipient];
    if (
      !binding ||
      binding.owner !== ctx.connection.accountId ||
      binding.transport !== a.transport
    )
      throw new ConnectorError("bridge_transport_unverified");
    const data = await json(
      this.http,
      origin +
        "/_matrix/client/v3/rooms/" +
        encodeURIComponent(a.recipient) +
        "/send/m.room.message/" +
        ctx.actionId,
      "PUT",
      required(ctx.credentials, "accessToken"),
      { msgtype: "m.text", body: a.text },
      ctx.signal,
    );
    if (!data.event_id)
      throw new ConnectorError("bridge_receipt_missing", true);
    return {
      providerId: data.event_id,
      data: {
        matrixEventId: data.event_id,
        transport: a.transport,
        delivery: "bridge_accepted_not_carrier_verified",
      },
    };
  }
}
export interface PersonalWhatsAppSession {
  accountId: string;
  ready(): boolean;
  send(recipient: string, text: string): Promise<{ id: string }>;
}
/** The session is supplied by a paired Baileys device helper, never a cloud credential impersonation. */
export class WhatsAppPersonalProvider implements Provider {
  readonly manifest = {
    provider: "whatsapp-personal",
    version: "1",
    transport: "whatsapp-web",
    qualification: "automated_only" as const,
    operations: [send],
  };
  constructor(
    readonly sessionFor: (sessionId: string) => PersonalWhatsAppSession,
  ) {}
  async verify(c: Record<string, unknown>) {
    const session = this.sessionFor(required(c, "sessionId"));
    if (!session.ready()) throw new ConnectorError("paired_device_offline");
    return { accountId: session.accountId, scopes: ["messages"] };
  }
  async execute(
    _name: string,
    a: Record<string, unknown>,
    ctx: ProviderContext,
  ) {
    const input = sendSchema.parse(a),
      session = this.sessionFor(required(ctx.credentials, "sessionId"));
    if (!session.ready() || session.accountId !== ctx.connection.accountId)
      throw new ConnectorError("paired_device_unavailable");
    try {
      const data = await session.send(input.recipient, input.text);
      if (!data.id) throw new ConnectorError("send_receipt_missing", true);
      return {
        providerId: data.id,
        data: { providerId: data.id, delivery: "submitted" },
      };
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      throw new ConnectorError("personal_send_uncertain", true);
    }
  }
}
