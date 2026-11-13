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
        name: "call.play",
        risk: "write",
        scopes: ["calls"],
        input: z
          .object({
            callId: uuid,
            audioUrl: z.url(),
            length: z.number().int().min(1).max(900).default(120),
          })
          .strict(),
        resourceKeys: ["callId"],
        stagingKeys: ["audioUrl"],
      },
      {
        name: "call.transfer",
        risk: "write",
        scopes: ["calls"],
        input: z.object({ callId: uuid, answerUrl: z.url() }).strict(),
        resourceKeys: ["callId"],
      },
      {
        name: "call.recordStart",
        risk: "destructive",
        scopes: ["calls.record"],
        input: z
          .object({
            callId: uuid,
            consent: z.literal(true),
            timeLimit: z.number().int().min(1).max(900).default(120),
          })
          .strict(),
        resourceKeys: ["callId"],
      },
      {
        name: "call.recordStop",
        risk: "write",
        scopes: ["calls.record"],
        input: z.object({ callId: uuid }).strict(),
        resourceKeys: ["callId"],
      },
      {
        name: "call.recording",
        risk: "read",
        scopes: ["calls.record"],
        input: z.object({ recordingId: uuid }).strict(),
      },
      {
        name: "call.create",
        risk: "write",
        scopes: ["calls"],
        input: z
          .object({
            recipient: phone,
            answerUrl: z.url(),
            callbackUrl: z.url().optional(),
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
    readonly audioOrigins: readonly string[] = [],
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
    await this.verifyCaller(c);
    return {
      accountId: data.auth_id,
      scopes: [
        "calls",
        ...(c.recordingEnabled === true ? ["calls.record"] : []),
      ],
    };
  }
  async verifyCaller(c: Record<string, unknown>, signal?: AbortSignal) {
    const from = phone.parse(c.from),
      { base, headers } = this.auth(c),
      number = await json(
        this.http,
        base + "Number/" + from.slice(1) + "/",
        "GET",
        undefined,
        undefined,
        signal,
        headers,
      );
    if (String(number.number ?? "").replace(/^\+/, "") !== from.slice(1))
      throw new ConnectorError("caller_number_unverified");
    return from;
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
      const prefixes = ctx.credentials.destinationPrefixes ?? ["+1"];
      if (
        !Array.isArray(prefixes) ||
        !prefixes.length ||
        !prefixes.every(
          (p) => typeof p === "string" && /^\+[1-9]\d{0,5}$/.test(p),
        ) ||
        !prefixes.some((prefix) => a.recipient.startsWith(prefix))
      )
        throw new ConnectorError("call_destination_denied");
      const url = new URL(a.answerUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !this.answerOrigins.includes(url.origin)
      )
        throw new ConnectorError("call_answer_url_denied");
      if (a.callbackUrl) {
        const callback = new URL(a.callbackUrl);
        if (
          callback.protocol !== "https:" ||
          callback.username ||
          callback.password ||
          callback.hash ||
          !this.answerOrigins.includes(callback.origin)
        )
          throw new ConnectorError("call_callback_url_denied");
      }
      const from = await this.verifyCaller(ctx.credentials, ctx.signal);
      method = "POST";
      body = {
        from,
        to: a.recipient,
        answer_url: a.answerUrl,
        answer_method: "POST",
        hangup_url: a.callbackUrl,
        hangup_method: a.callbackUrl ? "POST" : undefined,
        ring_url: a.callbackUrl,
        ring_method: a.callbackUrl ? "POST" : undefined,
        time_limit: a.timeLimit,
      };
    } else if (name === "call.recording") {
      path = "Recording/" + a.recordingId + "/";
    } else {
      path += a.callId + "/";
      if (name === "call.hangup") method = "DELETE";
      if (name === "call.play") {
        const url = new URL(a.audioUrl);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          !this.audioOrigins.includes(url.origin)
        )
          throw new ConnectorError("call_audio_url_denied");
        path += "Play/";
        method = "POST";
        body = {
          urls: a.audioUrl,
          length: a.length,
          loop: false,
          legs: "aleg",
          mix: true,
        };
      }
      if (name === "call.transfer") {
        const url = new URL(a.answerUrl);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          !this.answerOrigins.includes(url.origin)
        )
          throw new ConnectorError("call_answer_url_denied");
        method = "POST";
        body = { legs: "aleg", aleg_url: a.answerUrl };
      }
      if (name === "call.recordStart" || name === "call.recordStop") {
        if (ctx.credentials.recordingEnabled !== true)
          throw new ConnectorError("recording_not_enabled");
        path += "Record/";
        method = name === "call.recordStart" ? "POST" : "DELETE";
        body =
          name === "call.recordStart"
            ? {
                time_limit: a.timeLimit,
                file_format: "wav",
                record_channel_type: "mono",
              }
            : undefined;
      }
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
    if (
      ["call.play", "call.transfer", "call.recordStart"].includes(name) &&
      typeof data.api_id !== "string"
    )
      throw new ConnectorError("call_receipt_missing", true);
    return {
      providerId:
        (name === "call.create" ? data.request_uuid : undefined) ??
        data.call_uuid ??
        data.recording_id ??
        data.api_id ??
        a.callId,
      data: {
        ...data,
        ...(name === "call.hangup" ? { delivery: "hangup_requested" } : {}),
      },
    };
  }
}
