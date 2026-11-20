import { createHash } from "node:crypto";
import { z } from "zod";
import { ConnectorError, type Operation } from "@splitin/spiderman-contracts";
import type { Provider, ProviderContext } from "@splitin/spiderman-core";
import {
  json,
  binary,
  required,
  localEndpoint,
  type Http,
} from "@splitin/spiderman-provider-kit";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  text = z.string().min(1).max(2000);
const op = (
  name: string,
  risk: Operation["risk"],
  input: z.ZodType<Record<string, unknown>>,
): Operation => ({ name, risk, scopes: ["voice"], input });
export class OzzyProvider implements Provider {
  readonly manifest = {
    provider: "ozzy",
    version: "1",
    qualification: "automated_only" as const,
    operations: [
      op("voice.list", "read", z.object({}).strict()),
      op(
        "voice.enroll",
        "destructive",
        z
          .object({
            name: text,
            audioBase64: z.string().max(8_000_000),
            mimeType: z.enum(["audio/wav", "audio/mpeg", "audio/mp4"]),
            authorized: z.literal(true),
            start: z.number().min(0),
            end: z.number().min(5),
          })
          .strict(),
      ),
      op("voice.audition", "write", z.object({ voiceId: id }).strict()),
      op(
        "voice.activate",
        "destructive",
        z
          .object({ voiceId: id, auditionJobId: id, approved: z.literal(true) })
          .strict(),
      ),
      op("voice.generate", "write", z.object({ voiceId: id, text }).strict()),
      {
        ...op(
          "voice.artifact",
          "read",
          z
            .object({
              artifactId: id,
              checksum: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .optional(),
              size: z.number().int().positive().max(6_000_000).optional(),
            })
            .strict(),
        ),
        stagedResult: true,
      },
      op("voice.job", "read", z.object({ jobId: id }).strict()),
      op("voice.delete", "destructive", z.object({ voiceId: id }).strict()),
    ].map((operation) =>
      operation.name === "voice.enroll"
        ? { ...operation, stagingKeys: ["audioBase64"] }
        : operation,
    ),
  };
  constructor(
    readonly origins: readonly string[],
    readonly http: Http = fetch,
  ) {}
  async verify(c: Record<string, unknown>) {
    const endpoint = localEndpoint(c, this.origins);
    await json(
      this.http,
      endpoint + "/v1/voices",
      "GET",
      required(c, "apiKey"),
    );
    return { accountId: endpoint, scopes: ["voice"] };
  }
  async execute(
    name: string,
    raw: Record<string, unknown>,
    ctx: ProviderContext,
  ) {
    const spec = this.manifest.operations.find((o) => o.name === name);
    if (!spec) throw new ConnectorError("operation_unavailable");
    const a = spec.input.parse(raw) as any,
      origin = localEndpoint(ctx.credentials, this.origins),
      token = required(ctx.credentials, "apiKey");
    if (name === "voice.artifact") {
      const data = await binary(
        this.http,
        origin + "/v1/artifacts/" + a.artifactId,
        { headers: { Authorization: "Bearer " + token }, signal: ctx.signal },
      );
      if (
        a.checksum &&
        createHash("sha256").update(data.bytes).digest("hex") !== a.checksum
      )
        throw new ConnectorError("artifact_checksum_mismatch");
      if (a.size !== undefined && data.bytes.length !== a.size)
        throw new ConnectorError("artifact_size_mismatch");
      if (
        ![
          "audio/wav",
          "audio/mpeg",
          "audio/mp4",
          "audio/ogg",
          "audio/webm",
        ].includes(data.contentType)
      )
        throw new ConnectorError("artifact_type_unsupported");
      return {
        providerId: a.artifactId,
        data: {
          contentBase64: data.bytes.toString("base64"),
          contentType: data.contentType,
          filename:
            a.artifactId +
            (data.contentType === "audio/mpeg" ? ".mp3" : ".wav"),
        },
      };
    }
    let path = "",
      method = "GET",
      body: unknown;
    switch (name) {
      case "voice.list":
        path = "/v1/voices";
        break;
      case "voice.enroll": {
        if (a.end - a.start <= 5 || a.end - a.start > 30)
          throw new ConnectorError("voice_excerpt_invalid");
        const form = new FormData();
        form.append("name", a.name);
        form.append("authorized", "true");
        form.append("start", String(a.start));
        form.append("end", String(a.end));
        form.append(
          "file",
          new Blob([Buffer.from(a.audioBase64, "base64")], {
            type: a.mimeType,
          }),
          "reference",
        );
        await ctx.beforeDispatch?.();
        let response;
        try {
          response = await this.http(origin + "/v1/voices", {
            method: "POST",
            redirect: "error",
            signal: ctx.signal,
            headers: {
              Authorization: "Bearer " + token,
              "Idempotency-Key": ctx.idempotencyKey,
            },
            body: form,
          });
        } catch {
          throw new ConnectorError("voice_enrollment_uncertain", true);
        }
        if (!response.ok)
          throw new ConnectorError(
            "voice_enrollment_rejected",
            response.status >= 500,
          );
        const data: any = await response.json();
        if (typeof data.id !== "string" || !data.id)
          throw new ConnectorError("voice_enrollment_receipt_missing", true);
        return { providerId: data.id, data };
      }
      case "voice.audition":
      case "voice.generate":
        path = "/v1/generations";
        method = "POST";
        body = {
          voice_id: a.voiceId,
          purpose: name === "voice.audition" ? "audition" : "message",
          text: a.text ?? "ignored",
          options: {
            model: "original",
            exaggeration: 0.5,
            cfg_weight: 0.5,
            temperature: 0.8,
            seed: 42,
          },
        };
        break;
      case "voice.activate":
        {
          const audition = await json(
            this.http,
            origin + "/v1/generations/" + a.auditionJobId,
            "GET",
            token,
            undefined,
            ctx.signal,
          );
          if (
            audition.state !== "completed" ||
            audition.voice_id !== a.voiceId ||
            audition.purpose !== "audition"
          )
            throw new ConnectorError("audition_not_ready_or_wrong_voice");
        }
        path = "/v1/voices/" + a.voiceId + "/activate";
        method = "POST";
        body = { audition_job_id: a.auditionJobId, approved: true };
        break;
      case "voice.job":
        path = "/v1/generations/" + a.jobId;
        break;
      case "voice.delete":
        path = "/v1/voices/" + a.voiceId;
        method = "DELETE";
        break;
      default:
        throw new ConnectorError("operation_unavailable");
    }
    const data = await json(
      this.http,
      origin + path,
      method,
      token,
      body,
      ctx.signal,
      { "Idempotency-Key": ctx.idempotencyKey },
    );
    if (
      ["voice.audition", "voice.generate"].includes(name) &&
      (!data.id || typeof data.id !== "string")
    )
      throw new ConnectorError("voice_job_receipt_missing", true);
    if (
      name === "voice.activate" &&
      (data.id !== a.voiceId || data.active !== true)
    )
      throw new ConnectorError("voice_activation_receipt_invalid", true);
    return {
      providerId: data.id ?? (name === "voice.delete" ? a.voiceId : undefined),
      data,
    };
  }
}
