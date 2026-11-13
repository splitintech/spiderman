import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Hono } from "hono";
import {
  ConnectorError,
  webhookInputSchema,
  webhookBindingSchema,
} from "@splitin/spiderman-contracts";
import {
  owned,
  type Engine,
  type SyncCoordinator,
  type SubscriptionSource,
  type Subscription,
} from "@splitin/spiderman-core";
interface Route {
  id: string;
  owner: string;
  connectionId: string;
  connectionRevision: number;
  provider: string;
  secretRef: string;
  createdAt: number;
  expiresAt?: number;
  audience?: string;
  serviceEmail?: string;
  subscriptionId?: string;
  resourceId?: string;
  inboundWaitSeconds?: number;
}
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const subscriptionChannelId = (row: Subscription) => {
  const value = createHash("sha256")
    .update(row.id + ":" + row.generation)
    .digest("hex")
    .slice(0, 32);
  return (
    value.slice(0, 8) +
    "-" +
    value.slice(8, 12) +
    "-4" +
    value.slice(13, 16) +
    "-8" +
    value.slice(17, 20) +
    "-" +
    value.slice(20)
  );
};
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
export interface WebhookOptions {
  origin: string;
  sync?: SyncCoordinator;
  verifyGoogle?: (
    token: string,
    audience: string,
    email: string,
  ) => Promise<void>;
}
/** Credentials are never accepted from a callback; its stored route determines owner and account. */
export class WebhookIngress {
  readonly origin: string;
  constructor(
    readonly engine: Engine,
    readonly options: WebhookOptions,
  ) {
    const u = new URL(options.origin);
    if (
      u.protocol !== "https:" ||
      u.pathname !== "/" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw new ConnectorError("webhook_https_origin_required");
    this.origin = u.origin;
  }
  async list(owner: string) {
    return this.engine.store.transaction(async (tx) =>
      (await tx.list<Route>("webhook-route", owner)).map(
        ({ secretRef, ...route }) => route,
      ),
    );
  }
  async create(
    owner: string,
    input: {
      connectionId: string;
      secret?: string;
      expiresAt?: number;
      audience?: string;
      serviceEmail?: string;
      subscriptionId?: string;
      resourceId?: string;
      inboundWaitSeconds?: number;
    },
  ) {
    if (
      typeof input.connectionId !== "string" ||
      Object.keys(input).some(
        (k) =>
          ![
            "connectionId",
            "secret",
            "expiresAt",
            "audience",
            "serviceEmail",
            "subscriptionId",
            "resourceId",
            "inboundWaitSeconds",
          ].includes(k),
      )
    )
      throw new ConnectorError("webhook_configuration_invalid");
    const c = await this.engine.connection(owner, input.connectionId);
    if (
      c.status !== "ready" ||
      ![
        "whatsapp-business",
        "gmail",
        "google-calendar",
        "google-drive",
        "outlook",
        "imessage",
        "android-messages",
        "whatsapp-personal",
        "plivo",
      ].includes(c.provider)
    )
      throw new ConnectorError("webhook_provider_unavailable");
    if (
      input.expiresAt !== undefined &&
      (!Number.isSafeInteger(input.expiresAt) ||
        input.expiresAt <= this.engine.now())
    )
      throw new ConnectorError("webhook_configuration_invalid");
    for (const value of [
      input.audience,
      input.serviceEmail,
      input.subscriptionId,
      input.resourceId,
    ])
      if (
        value !== undefined &&
        (typeof value !== "string" || !value.length || value.length > 1000)
      )
        throw new ConnectorError("webhook_configuration_invalid");
    if (c.provider === "gmail" && (!input.audience || !input.serviceEmail))
      throw new ConnectorError("pubsub_identity_required");
    if (
      c.provider === "whatsapp-business" &&
      (!input.secret ||
        typeof input.secret !== "string" ||
        input.secret.length < 32)
    )
      throw new ConnectorError("meta_app_secret_required");
    if (
      input.secret !== undefined &&
      (typeof input.secret !== "string" ||
        input.secret.length < 32 ||
        input.secret.length > 1000)
    )
      throw new ConnectorError("webhook_secret_invalid");
    if (
      input.inboundWaitSeconds !== undefined &&
      (!Number.isInteger(input.inboundWaitSeconds) ||
        input.inboundWaitSeconds < 0 ||
        input.inboundWaitSeconds > 30)
    )
      throw new ConnectorError("inbound_wait_invalid");
    const credentials =
      c.provider === "plivo"
        ? await this.engine.vault.get<Record<string, unknown>>(
            owner,
            c.credentialRef,
          )
        : undefined;
    const id = randomUUID(),
      secret =
        c.provider === "plivo"
          ? String(credentials?.authToken ?? "")
          : (input.secret ?? randomBytes(32).toString("hex")),
      verifyToken = randomBytes(32).toString("hex");
    const row: Route = {
      id,
      owner,
      connectionId: c.id,
      connectionRevision: c.revision,
      provider: c.provider,
      createdAt: this.engine.now(),
      secretRef: await this.engine.vault.put(owner, "webhook:" + id, {
        secret,
        verifyToken,
      }),
      expiresAt: input.expiresAt,
      audience: input.audience,
      serviceEmail: input.serviceEmail,
      subscriptionId: input.subscriptionId,
      resourceId: input.resourceId,
      inboundWaitSeconds: input.inboundWaitSeconds,
    };
    await this.engine.store.transaction((tx) =>
      tx.put("webhook-route", id, owner, row),
    );
    return {
      id,
      url: this.origin + "/webhooks/" + id,
      verificationSecret: c.provider === "plivo" ? undefined : secret,
      verifyToken,
    };
  }
  async bind(
    owner: string,
    id: string,
    input: { subscriptionId?: string; resourceId?: string; expiresAt?: number },
  ) {
    if (
      !input ||
      Object.keys(input).some(
        (k) => !["subscriptionId", "resourceId", "expiresAt"].includes(k),
      ) ||
      [input.subscriptionId, input.resourceId].some(
        (v) =>
          v !== undefined && (typeof v !== "string" || !v || v.length > 1000),
      ) ||
      (input.expiresAt !== undefined &&
        (!Number.isSafeInteger(input.expiresAt) ||
          input.expiresAt <= this.engine.now()))
    )
      throw new ConnectorError("webhook_configuration_invalid");
    return this.engine.store.transaction(async (tx) => {
      const row = owned(await tx.get<Route>("webhook-route", id), owner);
      const connection = owned(
        await tx.get<import("@splitin/spiderman-contracts").Connection>(
          "connection",
          row.connectionId,
        ),
        owner,
      );
      if (connection.status !== "ready")
        throw new ConnectorError("connection_not_ready");
      Object.assign(row, input);
      row.connectionRevision = connection.revision;
      await tx.put("webhook-route", id, owner, row);
      const { secretRef, ...safe } = row;
      return safe;
    });
  }
  async remove(owner: string, id: string) {
    const row = await this.engine.store.transaction(async (tx) => {
      const row = owned(await tx.get<Route>("webhook-route", id), owner);
      await tx.remove("webhook-route", id);
      return row;
    });
    await this.engine.vault.delete(owner, row.secretRef);
  }
  subscriptionSources(): SubscriptionSource[] {
    return [
      ["gmail.watch", "gmail"],
      ["calendar.watch", "google-calendar"],
      ["drive.watch", "google-drive"],
      ["outlook.mail", "outlook"],
    ].map(([name, provider]) => ({
      name: name!,
      provider: provider!,
      request: async (row: Subscription) => {
        const route = owned(
          await this.engine.store.transaction((tx) =>
            tx.get<Route>("webhook-route", row.routeId),
          ),
          row.owner,
        );
        if (
          route.connectionId !== row.connectionId ||
          route.provider !== provider ||
          route.connectionRevision !== row.connectionRevision
        )
          throw new ConnectorError("subscription_route_mismatch");
        const { secret } = await this.engine.vault.get<{ secret: string }>(
            row.owner,
            route.secretRef,
          ),
          address = this.origin + "/webhooks/" + route.id,
          expiresAt = (row.requestedAt ?? row.createdAt) + 2 * 86400000;
        if (provider === "gmail") {
          if (!row.topicName || row.resource !== "inbox")
            throw new ConnectorError("subscription_topic_required");
          return {
            operation: "mail.watch",
            input: { topicName: row.topicName },
          };
        }
        if (provider === "outlook") {
          if (row.resource !== "inbox")
            throw new ConnectorError("subscription_resource_invalid");
          return row.providerId && (row.expiresAt ?? 0) > this.engine.now()
            ? {
                operation: "mail.renewSubscription",
                input: { subscriptionId: row.providerId, expiresAt },
              }
            : {
                operation: "mail.subscribe",
                input: {
                  notificationUrl: address,
                  clientState: secret,
                  expiresAt,
                },
              };
        }
        const channelId = subscriptionChannelId(row),
          input: Record<string, unknown> = {
            channelId,
            address,
            token: secret,
            expiresAt,
          };
        if (provider === "google-calendar") input.calendarId = row.resource;
        else {
          if (row.resource !== "*")
            throw new ConnectorError("broad_resource_grant_required");
          const schedules = await this.options.sync?.list(row.owner),
            cursor = schedules?.find(
              (s) =>
                s.connectionId === row.connectionId &&
                s.source === "drive.changes" &&
                s.state === "active",
            )?.cursor;
          if (typeof cursor?.pageToken !== "string")
            throw new ConnectorError("subscription_sync_cursor_required");
          input.pageToken = cursor.pageToken;
        }
        return {
          operation:
            provider === "google-calendar" ? "calendar.watch" : "drive.watch",
          input,
        };
      },
      established: async (row: Subscription, raw: unknown) => {
        const data = raw as Record<string, any>,
          expiresAt =
            provider === "outlook"
              ? Date.parse(data?.expirationDateTime)
              : Number(data?.expiration),
          providerId = provider === "gmail" ? data?.historyId : data?.id;
        if (
          typeof providerId !== "string" ||
          !Number.isSafeInteger(expiresAt) ||
          expiresAt <= this.engine.now()
        )
          throw new ConnectorError("subscription_receipt_invalid");
        if (provider === "google-calendar" || provider === "google-drive") {
          if (
            data.id !== subscriptionChannelId(row) ||
            typeof data.resourceId !== "string"
          )
            throw new ConnectorError("subscription_receipt_invalid");
        }
        return { providerId, expiresAt };
      },
      commit: async (row, raw, tx) => {
        const route = owned(
            await tx.get<Route>("webhook-route", row.routeId),
            row.owner,
          ),
          data = raw as Record<string, any>;
        if (
          route.connectionId !== row.connectionId ||
          route.provider !== provider
        )
          throw new ConnectorError("subscription_route_mismatch");
        route.subscriptionId = row.providerId;
        route.expiresAt = row.expiresAt;
        if (provider === "google-calendar" || provider === "google-drive")
          route.resourceId = data.resourceId;
        await tx.put("webhook-route", route.id, route.owner, route);
      },
    }));
  }
  private async route(id: string, allowExpired = false) {
    const row = await this.engine.store.transaction((tx) =>
      tx.get<Route>("webhook-route", id),
    );
    if (
      !row ||
      (!allowExpired && (row.expiresAt ?? Infinity) <= this.engine.now())
    )
      throw new ConnectorError("webhook_unavailable");
    const c = await this.engine.connection(row.owner, row.connectionId);
    if (c.status !== "ready" || c.revision !== row.connectionRevision)
      throw new ConnectorError("webhook_unavailable");
    const secret = await this.engine.vault.get<{
      secret: string;
      verifyToken: string;
    }>(row.owner, row.secretRef);
    return { row, c, ...secret };
  }
  async challenge(id: string, params: URLSearchParams) {
    const { row, verifyToken } = await this.route(id);
    if (
      row.provider !== "whatsapp-business" ||
      params.get("hub.mode") !== "subscribe" ||
      !equal(params.get("hub.verify_token") ?? "", verifyToken)
    )
      throw new ConnectorError("webhook_signature_invalid");
    const challenge = params.get("hub.challenge");
    if (!challenge || challenge.length > 1000)
      throw new ConnectorError("webhook_challenge_invalid");
    return challenge;
  }
  async receive(id: string, request: Request) {
    const validation = new URL(request.url).searchParams.has("validationToken");
    const { row, c, secret } = await this.route(id, validation),
      raw = await request.text();
    if (Buffer.byteLength(raw) > 3_000_000)
      throw new ConnectorError("webhook_payload_too_large");
    const url = new URL(request.url);
    if (row.provider === "outlook" && url.searchParams.has("validationToken"))
      return {
        challenge: url.searchParams.get("validationToken")!.slice(0, 1000),
      };
    if ((row.expiresAt ?? Infinity) <= this.engine.now())
      throw new ConnectorError("webhook_unavailable");
    const events: { sourceId: string; type: string; content: unknown }[] = [];
    const persist = (sourceId: string, type: string, content: unknown) =>
      this.engine.ingest(
        row.owner,
        c.id,
        sourceId,
        type,
        content,
        async (tx) => {
          const connection = await tx.get<
              import("@splitin/spiderman-contracts").Connection
            >("connection", c.id),
            current = await tx.get<Route>("webhook-route", id);
          if (
            connection?.revision !== row.connectionRevision ||
            !current ||
            current.connectionRevision !== row.connectionRevision ||
            current.secretRef !== row.secretRef
          )
            throw new ConnectorError("webhook_unavailable");
        },
      );
    if (row.provider === "plivo") {
      if (
        url.search ||
        !request.headers
          .get("content-type")
          ?.startsWith("application/x-www-form-urlencoded")
      )
        throw new ConnectorError("webhook_payload_invalid");
      const params = new URLSearchParams(raw),
        keys = [...params.keys()];
      if (new Set(keys).size !== keys.length || keys.length > 100)
        throw new ConnectorError("webhook_payload_invalid");
      const nonce = request.headers.get("x-plivo-signature-v3-nonce") ?? "";
      if (!/^[\x20-\x7e]{1,256}$/.test(nonce))
        throw new ConnectorError("webhook_signature_invalid");
      // Plivo V3 canonicalization for a POST callback without URL query parameters.
      const canonical =
        this.origin +
        "/webhooks/" +
        id +
        (keys.length
          ? "?" +
            keys
              .sort()
              .map((key) => key + params.get(key))
              .join("")
          : "") +
        "." +
        nonce;
      const signature = createHmac("sha256", secret)
        .update(canonical)
        .digest("base64");
      if (
        !(request.headers.get("x-plivo-signature-v3") ?? "")
          .split(",")
          .some((value) => equal(value.trim(), signature))
      )
        throw new ConnectorError("webhook_signature_invalid");
      const callId = params.get("CallUUID"),
        status = params.get("CallStatus") ?? params.get("Event");
      if (
        !callId ||
        !/^[a-f0-9-]{36}$/i.test(callId) ||
        !status ||
        status.length > 100
      )
        throw new ConnectorError("webhook_payload_invalid");
      if (params.get("AuthID") && params.get("AuthID") !== c.accountId)
        throw new ConnectorError("webhook_account_mismatch");
      await persist(
        "plivo:" + callId + ":" + status + ":" + (params.get("Event") ?? ""),
        "call." + status,
        Object.fromEntries(params),
      );
      return params.get("Direction") === "inbound"
        ? {
            xml:
              "<Response>" +
              (row.inboundWaitSeconds
                ? '<Wait length="' + row.inboundWaitSeconds + '"/>'
                : "") +
              "<Hangup/></Response>",
          }
        : { accepted: 1 };
    }

    if (row.provider === "google-calendar" || row.provider === "google-drive") {
      if (
        !equal(request.headers.get("x-goog-channel-token") ?? "", secret) ||
        request.headers.get("x-goog-channel-id") !==
          (row.subscriptionId ?? id) ||
        !row.resourceId ||
        request.headers.get("x-goog-resource-id") !== row.resourceId
      )
        throw new ConnectorError("webhook_signature_invalid");
      const number = request.headers.get("x-goog-message-number");
      if (!number || !/^\d+$/.test(number))
        throw new ConnectorError("webhook_payload_invalid");
      events.push({
        sourceId: "calendar-channel:" + id + ":" + number,
        type:
          row.provider === "google-calendar"
            ? "calendar.sync_requested"
            : "drive.sync_requested",
        content: {
          resourceId: row.resourceId,
          state: request.headers.get("x-goog-resource-state"),
        },
      });
    } else {
      let body: any;
      try {
        body = JSON.parse(raw);
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw Error("invalid");
      } catch {
        throw new ConnectorError("webhook_payload_invalid");
      }
      if (row.provider === "whatsapp-business") {
        const expected =
          "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
        if (!equal(request.headers.get("x-hub-signature-256") ?? "", expected))
          throw new ConnectorError("webhook_signature_invalid");
        if (
          body.object !== "whatsapp_business_account" ||
          !Array.isArray(body.entry)
        )
          throw new ConnectorError("webhook_payload_invalid");
        for (const entry of body.entry)
          for (const change of entry.changes ?? []) {
            const value = change.value;
            if (value?.metadata?.phone_number_id !== c.accountId)
              throw new ConnectorError("webhook_account_mismatch");
            for (const message of value.messages ?? []) {
              if (typeof message.id !== "string")
                throw new ConnectorError("webhook_payload_invalid");
              events.push({
                sourceId: message.id,
                type: "message.received",
                content: { ...message, contacts: value.contacts },
              });
            }
            for (const status of value.statuses ?? []) {
              if (
                typeof status.id !== "string" ||
                typeof status.status !== "string"
              )
                throw new ConnectorError("webhook_payload_invalid");
              events.push({
                sourceId:
                  status.id + ":" + status.status + ":" + status.timestamp,
                type: "message.delivery",
                content: status,
              });
            }
          }
      } else if (row.provider === "gmail") {
        const auth = request.headers.get("authorization") ?? "";
        if (!auth.startsWith("Bearer "))
          throw new ConnectorError("webhook_signature_invalid");
        try {
          if (this.options.verifyGoogle)
            await this.options.verifyGoogle(
              auth.slice(7),
              row.audience!,
              row.serviceEmail!,
            );
          else {
            const { payload } = await jwtVerify(auth.slice(7), googleKeys, {
              issuer: ["https://accounts.google.com", "accounts.google.com"],
              audience: row.audience,
              algorithms: ["RS256"],
            });
            if (
              payload.email !== row.serviceEmail ||
              payload.email_verified !== true
            )
              throw Error("identity_mismatch");
          }
        } catch {
          throw new ConnectorError("webhook_signature_invalid");
        }
        let data;
        try {
          data = JSON.parse(
            Buffer.from(body.message.data, "base64").toString(),
          );
        } catch {
          throw new ConnectorError("webhook_payload_invalid");
        }
        if (
          data.emailAddress?.toLowerCase() !== c.accountId.toLowerCase() ||
          typeof data.historyId !== "string" ||
          typeof body.message.messageId !== "string"
        )
          throw new ConnectorError("webhook_account_mismatch");
        events.push({
          sourceId: "pubsub:" + body.message.messageId,
          type: "mail.sync_requested",
          content: { historyId: data.historyId },
        });
      } else if (row.provider === "outlook") {
        if (!Array.isArray(body.value) || body.value.length > 100)
          throw new ConnectorError("webhook_payload_invalid");
        for (const notice of body.value) {
          if (
            !equal(notice.clientState ?? "", secret) ||
            !row.subscriptionId ||
            notice.subscriptionId !== row.subscriptionId ||
            notice.encryptedContent
          )
            throw new ConnectorError("webhook_signature_invalid");
          events.push({
            sourceId:
              "graph:" +
              createHash("sha256").update(JSON.stringify(notice)).digest("hex"),
            type: notice.lifecycleEvent
              ? "mail.subscription_changed"
              : "mail.sync_requested",
            content: {
              subscriptionId: notice.subscriptionId,
              resource: notice.resource,
              changeType: notice.changeType,
              lifecycleEvent: notice.lifecycleEvent,
            },
          });
        }
      } else {
        const timestamp = request.headers.get("x-spiderman-timestamp") ?? "",
          signature = request.headers.get("x-spiderman-signature") ?? "";
        if (
          !/^\d{13}$/.test(timestamp) ||
          Math.abs(this.engine.now() - Number(timestamp)) > 300000 ||
          !equal(
            signature,
            createHmac("sha256", secret)
              .update(timestamp + "." + raw)
              .digest("hex"),
          )
        )
          throw new ConnectorError("webhook_signature_invalid");
        if (
          body.accountId !== c.accountId ||
          typeof body.id !== "string" ||
          body.id.length > 1000 ||
          !["message.received", "message.delivery", "device.status"].includes(
            body.type,
          )
        )
          throw new ConnectorError("webhook_account_mismatch");
        events.push({
          sourceId: body.id,
          type: body.type,
          content: body.content,
        });
      }
    }
    if (events.length > 100) throw new ConnectorError("webhook_event_limit");
    // Await every durable write before acknowledging. Replays use provider/source IDs.
    for (const event of events)
      await persist(event.sourceId, event.type, event.content);
    if (this.options.sync) await this.options.sync.wake(row.owner, c.id);
    return { accepted: events.length };
  }
}
export function installWebhooks(
  app: Hono<{ Variables: { owner: string; actorKind: "human" | "agent" } }>,
  ingress: WebhookIngress,
) {
  app.get("/v1/webhooks", async (c) =>
    c.json(await ingress.list(c.get("owner"))),
  );
  app.post("/v1/webhooks", async (c) =>
    c.json(
      await ingress.create(
        c.get("owner"),
        webhookInputSchema.parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.patch("/v1/webhooks/:id", async (c) =>
    c.json(
      await ingress.bind(
        c.get("owner"),
        c.req.param("id"),
        webhookBindingSchema.parse(await c.req.json()),
      ),
    ),
  );
  app.delete("/v1/webhooks/:id", async (c) => {
    await ingress.remove(c.get("owner"), c.req.param("id"));
    return c.json({ deleted: true });
  });
  app.get("/webhooks/:id", async (c) =>
    c.text(
      await ingress.challenge(
        c.req.param("id"),
        new URL(c.req.url).searchParams,
      ),
    ),
  );
  app.post("/webhooks/:id", async (c) => {
    const result = await ingress.receive(c.req.param("id"), c.req.raw);
    return "xml" in result
      ? c.body(result.xml!, 200, { "Content-Type": "application/xml" })
      : "challenge" in result
        ? c.text(result.challenge!)
        : c.json(result, 202);
  });
}
