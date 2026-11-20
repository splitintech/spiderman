import { randomUUID } from "node:crypto";
import {
  ConnectorError,
  voiceInputSchema,
  type ActionReceipt,
} from "@splitin/spiderman-contracts";
import { owned, digest, type Engine } from "./index.js";
export type { VoiceWorkflow } from "@splitin/spiderman-contracts";
import type { VoiceWorkflow } from "@splitin/spiderman-contracts";
/** Durable orchestration of existing provider operations, with no model/runtime. */
export class VoiceCoordinator {
  constructor(
    readonly engine: Engine,
    readonly options: { artifactBaseUrl?: string } = {},
  ) {
    if (options.artifactBaseUrl) {
      const url = new URL(options.artifactBaseUrl);
      if (
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            ["127.0.0.1", "localhost"].includes(url.hostname)
          )) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !url.pathname.endsWith("/")
      )
        throw new ConnectorError("artifact_base_url_invalid");
    }
  }
  list(owner: string) {
    return this.engine.store.transaction((tx) =>
      tx.list<VoiceWorkflow>("voice", owner),
    );
  }
  get(owner: string, id: string) {
    return this.engine.store.transaction(async (tx) =>
      owned(await tx.get<VoiceWorkflow>("voice", id), owner),
    );
  }
  async create(
    owner: string,
    input: {
      connectionId: string;
      idempotencyKey: string;
      reference: Record<string, unknown>;
      script?: string;
      origin?: {
        connectionId: string;
        recipient: string;
        transport?: "rcs" | "sms" | "mms";
      };
    },
  ) {
    input = voiceInputSchema.parse(input);
    const connection = await this.engine.connection(owner, input.connectionId);
    if (connection.provider !== "ozzy")
      throw new ConnectorError("voice_connection_required");
    if (
      input.script !== undefined &&
      (typeof input.script !== "string" ||
        !input.script.trim() ||
        input.script.length > 2000)
    )
      throw new ConnectorError("voice_script_invalid");
    if (input.origin) {
      await this.engine.connection(owner, input.origin.connectionId);
      if (
        typeof input.origin.recipient !== "string" ||
        !input.origin.recipient ||
        input.origin.recipient.length > 300
      )
        throw new ConnectorError("voice_origin_invalid");
    }
    if (
      input.idempotencyKey !== undefined &&
      (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128)
    )
      throw new ConnectorError("idempotency_key_invalid");
    const id = input.idempotencyKey
        ? digest({
            owner,
            connectionId: connection.id,
            key: input.idempotencyKey,
          })
        : randomUUID(),
      requestDigest = digest(input);
    const existing = await this.engine.store.transaction((tx) =>
      tx.get<VoiceWorkflow>("voice", id),
    );
    if (existing) {
      if (existing.owner !== owner || existing.requestDigest !== requestDigest)
        throw new ConnectorError("idempotency_conflict");
      return existing;
    }
    const enrollment = await this.engine.submit(owner, {
      connectionId: connection.id,
      operation: "voice.enroll",
      input: input.reference,
      idempotencyKey: "voice:" + id + ":enroll",
    } as Parameters<Engine["submit"]>[1]);
    const row: VoiceWorkflow = {
      id,
      owner,
      requestDigest,
      connectionId: connection.id,
      state: "enrolling",
      actionId: enrollment.id,
      createdAt: this.engine.now(),
      updatedAt: this.engine.now(),
      nextRunAt: this.engine.now(),
      poll: 0,
      origin: input.origin,
    };
    if (input.script)
      row.scriptRef = await this.engine.vault.put(
        owner,
        "voice-script:" + id,
        { text: input.script },
        this.engine.now() + 86400000,
      );
    return this.engine.store.transaction(async (tx) => {
      const existing = await tx.get<VoiceWorkflow>("voice", id);
      if (existing) {
        if (
          existing.owner !== owner ||
          existing.requestDigest !== requestDigest
        )
          throw new ConnectorError("idempotency_conflict");
        return existing;
      }
      await tx.put("voice", id, owner, row);
      return row;
    });
  }
  async cancel(owner: string, id: string) {
    const row = await this.get(owner, id);
    if (row.state === "cancelled") return row;
    if (["ready", "failed", "unknown_outcome"].includes(row.state))
      throw new ConnectorError("voice_workflow_terminal");
    const action = await this.engine.action(owner, row.actionId);
    if (["queued", "awaiting_approval"].includes(action.state))
      await this.engine.cancel(owner, action.id);
    return this.engine.store.transaction(async (tx) => {
      const current = owned(await tx.get<VoiceWorkflow>("voice", id), owner);
      current.state = "cancelled";
      current.updatedAt = this.engine.now();
      delete current.leaseToken;
      delete current.leaseUntil;
      await tx.put("voice", id, owner, current);
      return current;
    });
  }
  private async submit(
    row: VoiceWorkflow,
    operation: string,
    input: Record<string, unknown>,
    key: string,
  ) {
    return this.engine.submit(row.owner, {
      connectionId: row.connectionId,
      operation,
      input,
      idempotencyKey: "voice:" + row.id + ":" + key,
    } as Parameters<Engine["submit"]>[1]);
  }
  private async artifact(
    row: VoiceWorkflow,
    data: Record<string, any>,
    key: string,
  ) {
    if (data.voice_id !== row.voiceId || data.state !== "completed")
      throw new ConnectorError("voice_job_identity_mismatch");
    const artifact = Array.isArray(data.artifacts)
      ? data.artifacts.find((a: any) => ["wav", "mp3"].includes(a.kind))
      : undefined;
    if (!artifact || typeof artifact.id !== "string")
      throw new ConnectorError("voice_artifact_missing");
    return this.submit(
      row,
      "voice.artifact",
      {
        artifactId: artifact.id,
        ...(artifact.checksum ? { checksum: artifact.checksum } : {}),
        ...(artifact.size ? { size: artifact.size } : {}),
      },
      key,
    );
  }
  async tick() {
    const row = await this.engine.store.transaction(async (tx) => {
      for (const r of await tx.list<VoiceWorkflow>("voice")) {
        if (
          ["ready", "failed", "unknown_outcome", "cancelled"].includes(
            r.state,
          ) ||
          r.nextRunAt > this.engine.now() ||
          (r.leaseUntil ?? 0) > this.engine.now()
        )
          continue;
        r.leaseToken = randomUUID();
        r.leaseUntil = this.engine.now() + 120000;
        await tx.put("voice", r.id, r.owner, r);
        return r;
      }
    });
    if (!row) return;
    try {
      const c = await this.engine.connection(row.owner, row.connectionId);
      if (c.status !== "ready")
        throw new ConnectorError("connection_not_ready");
      const a = await this.engine.action(row.owner, row.actionId);
      if (["queued", "running", "awaiting_approval"].includes(a.state)) {
        row.nextRunAt = this.engine.now() + 1000;
        return this.finish(row);
      }
      if (a.state === "unknown_outcome") {
        row.state = "unknown_outcome";
        row.error = a.error;
        return this.finish(row);
      }
      if (a.state !== "succeeded")
        throw new ConnectorError(a.error ?? "voice_step_failed");
      const data = (await this.engine.result(row.owner, a.id)) as Record<
        string,
        any
      >;
      if (row.state === "enrolling") {
        if (typeof data.id !== "string")
          throw new ConnectorError("voice_identity_missing");
        row.voiceId = data.id;
        row.actionId = (
          await this.submit(
            row,
            "voice.audition",
            { voiceId: row.voiceId },
            "audition",
          )
        ).id;
        row.state = "auditioning";
        row.poll = 0;
      } else if (row.state === "auditioning" || row.state === "generating") {
        if (a.operation !== "voice.job") {
          if (typeof data.id !== "string")
            throw new ConnectorError("voice_job_identity_missing");
          row.jobId = data.id;
          row.actionId = (
            await this.submit(
              row,
              "voice.job",
              { jobId: row.jobId },
              row.state + ":poll:" + row.poll++,
            )
          ).id;
        } else if (data.id !== row.jobId || data.voice_id !== row.voiceId)
          throw new ConnectorError("voice_job_identity_mismatch");
        else if (data.state === "completed") {
          const artifact = await this.artifact(
            row,
            data,
            row.state + ":artifact",
          );
          if (row.state === "auditioning") {
            row.auditionArtifactActionId = artifact.id;
            row.state = "reviewing";
            row.actionId = artifact.id;
          } else {
            row.artifactActionId = artifact.id;
            row.actionId = artifact.id;
            row.state = "fetching";
          }
        } else if (["failed", "cancelled"].includes(data.state))
          throw new ConnectorError("voice_generation_failed");
        else {
          if (row.poll >= 360) throw new ConnectorError("voice_job_poll_limit");
          row.actionId = (
            await this.submit(
              row,
              "voice.job",
              { jobId: row.jobId },
              row.state + ":poll:" + row.poll++,
            )
          ).id;
          row.nextRunAt = this.engine.now() + 10000;
        }
      } else if (row.state === "fetching") {
        const artifact = await this.engine.artifact(row.owner, a.id);
        row.artifactLink = this.options.artifactBaseUrl
          ? new URL(a.id, this.options.artifactBaseUrl).href
          : "/v1/artifacts/" + a.id;
        if (row.origin) {
          const origin = await this.engine.connection(
            row.owner,
            row.origin.connectionId,
          );
          const supports = this.engine
            .provider(origin.provider)
            .manifest.operations.some((op) => op.name === "message.attachment");
          const canLink =
            !!this.options.artifactBaseUrl &&
            this.engine
              .provider(origin.provider)
              .manifest.operations.some((op) => op.name === "message.send");
          if (!supports && !canLink) {
            row.deliveryState = "manual";
            row.deliveryError = "origin_attachment_or_link_unavailable";
            row.state = "ready";
            return this.finish(row);
          }
          const delivery = await this.engine.submit(row.owner, {
            connectionId: origin.id,
            operation: supports ? "message.attachment" : "message.send",
            input: supports
              ? {
                  recipient: row.origin.recipient,
                  contentBase64: artifact.bytes.toString("base64"),
                  contentType: artifact.contentType,
                  filename: artifact.filename,
                }
              : {
                  recipient: row.origin.recipient,
                  text:
                    "Your speech is ready. Sign in to retrieve the audio: " +
                    row.artifactLink,
                  ...(row.origin.transport
                    ? { transport: row.origin.transport }
                    : {}),
                },
            idempotencyKey: "voice:" + row.id + ":deliver",
          });
          row.deliveryState = supports ? "attachment" : "authenticated_link";
          row.deliveryActionId = delivery.id;
          row.actionId = delivery.id;
          row.state = "delivering";
        } else row.state = "ready";
      } else if (row.state === "delivering") {
        if (!a.providerId)
          throw new ConnectorError("voice_delivery_unverified");
        row.state = "ready";
      } else if (row.state === "reviewing") {
        // The artifact read must have completed before asking a human to activate.
        if (a.operation !== "voice.artifact")
          throw new ConnectorError("audition_artifact_required");
        row.actionId = (
          await this.submit(
            row,
            "voice.activate",
            { voiceId: row.voiceId, auditionJobId: row.jobId, approved: true },
            "activate",
          )
        ).id;
        row.state = "activating";
      } else if (row.state === "activating") {
        if (data.id !== row.voiceId || data.active !== true)
          throw new ConnectorError("voice_activation_unverified");
        if (!row.scriptRef) {
          row.state = "ready";
        } else {
          const script = await this.engine.vault.get<{ text: string }>(
            row.owner,
            row.scriptRef,
          );
          row.actionId = (
            await this.submit(
              row,
              "voice.generate",
              { voiceId: row.voiceId, text: script.text },
              "generate",
            )
          ).id;
          row.state = "generating";
          row.poll = 0;
        }
      }
      row.nextRunAt = Math.max(row.nextRunAt, this.engine.now() + 1000);
      return this.finish(row);
    } catch (error) {
      row.state = "failed";
      row.error =
        error instanceof ConnectorError ? error.code : "voice_workflow_failed";
      return this.finish(row);
    }
  }
  private finish(row: VoiceWorkflow) {
    return this.engine.store.transaction(async (tx) => {
      const current = owned(
        await tx.get<VoiceWorkflow>("voice", row.id),
        row.owner,
      );
      if (
        current.state === "cancelled" ||
        current.leaseToken !== row.leaseToken ||
        (current.leaseUntil ?? 0) <= this.engine.now()
      )
        return current;
      row.updatedAt = this.engine.now();
      delete row.leaseToken;
      delete row.leaseUntil;
      await tx.put("voice", row.id, row.owner, row);
      return row;
    });
  }
}
