import { randomUUID } from "node:crypto";
import {
  ConnectorError,
  subscriptionInputSchema,
  actionRequestSchema,
  type Subscription,
  type ActionReceipt,
} from "@splitin/spiderman-contracts";
import { owned, type Engine, type Transaction } from "./index.js";
export type { Subscription } from "@splitin/spiderman-contracts";

export interface SubscriptionSource {
  name: string;
  provider: string;
  request(
    row: Subscription,
  ): Promise<{ operation: string; input: Record<string, unknown> }>;
  established(
    row: Subscription,
    data: unknown,
  ): Promise<{ providerId: string; expiresAt: number }>;
  commit?(row: Subscription, data: unknown, tx: Transaction): Promise<void>;
}
/** Renewable watches are durable approved commands, never a separate provider dispatch path. */
export class SubscriptionCoordinator {
  readonly sources = new Map<string, SubscriptionSource>();
  constructor(readonly engine: Engine) {}
  register(source: SubscriptionSource) {
    if (this.sources.has(source.name))
      throw new ConnectorError("duplicate_subscription_source");
    this.sources.set(source.name, source);
    return this;
  }
  async create(owner: string, raw: unknown) {
    const input = subscriptionInputSchema.parse(raw),
      c = await this.engine.connection(owner, input.connectionId),
      source = this.sources.get(input.source);
    if (!source || source.provider !== c.provider || c.status !== "ready")
      throw new ConnectorError("subscription_source_unavailable");
    const row: Subscription = {
      ...input,
      id: randomUUID(),
      owner,
      connectionRevision: c.revision,
      state: "active",
      generation: 0,
      createdAt: this.engine.now(),
      nextRunAt: this.engine.now(),
      failures: 0,
    };
    const request = await source.request(row);
    this.engine.authorize(c, request.operation, request.input);
    await this.engine.store.transaction(async (tx) => {
      if (
        (await tx.list<Subscription>("subscription", owner)).some(
          (s) =>
            s.connectionId === c.id &&
            s.source === row.source &&
            s.resource === row.resource &&
            s.state !== "paused",
        )
      )
        throw new ConnectorError("subscription_already_configured");
      await tx.put("subscription", row.id, owner, row);
    });
    return row;
  }
  list(owner: string) {
    return this.engine.store.transaction((tx) =>
      tx.list<Subscription>("subscription", owner),
    );
  }
  async pause(owner: string, id: string) {
    return this.engine.store.transaction(async (tx) => {
      const row = owned(await tx.get<Subscription>("subscription", id), owner);
      if (row.state === "unknown_outcome")
        throw new ConnectorError("subscription_requires_reconciliation");
      row.state = "paused";
      delete row.leaseToken;
      delete row.leaseUntil;
      if (row.actionId) {
        const action = await tx.get<ActionReceipt>("action", row.actionId);
        if (action && ["queued", "awaiting_approval"].includes(action.state)) {
          action.state = "cancelled";
          action.updatedAt = this.engine.now();
          await tx.put("action", action.id, owner, action);
          delete row.actionId;
          delete row.requestedAt;
          delete row.requestRef;
          row.generation++;
        }
      }
      await tx.put("subscription", row.id, owner, row);
      return row;
    });
  }
  async resume(owner: string, id: string) {
    const row = owned(
        await this.engine.store.transaction((tx) =>
          tx.get<Subscription>("subscription", id),
        ),
        owner,
      ),
      c = await this.engine.connection(owner, row.connectionId);
    if (c.status !== "ready") throw new ConnectorError("connection_not_ready");
    if (row.state === "unknown_outcome")
      throw new ConnectorError("subscription_requires_reconciliation");
    const source = this.sources.get(row.source);
    if (!source) throw new ConnectorError("subscription_source_unavailable");
    await source.request({ ...row, connectionRevision: c.revision });
    return this.engine.store.transaction(async (tx) => {
      const latest = owned(
        await tx.get<Subscription>("subscription", id),
        owner,
      );
      if (latest.state === "unknown_outcome")
        throw new ConnectorError("subscription_requires_reconciliation");
      latest.state = "active";
      latest.connectionRevision = c.revision;
      latest.failures = 0;
      latest.nextRunAt = this.engine.now();
      delete latest.error;
      await tx.put("subscription", id, owner, latest);
      return latest;
    });
  }
  async tick() {
    const row = await this.engine.store.transaction(async (tx) => {
      for (const row of (await tx.list<Subscription>("subscription")).sort(
        (a, b) => a.nextRunAt - b.nextRunAt,
      )) {
        if (
          row.state !== "active" ||
          row.nextRunAt > this.engine.now() ||
          (row.leaseUntil ?? 0) > this.engine.now()
        )
          continue;
        row.leaseToken = randomUUID();
        row.leaseUntil = this.engine.now() + 120000;
        row.requestedAt ??= this.engine.now();
        await tx.put("subscription", row.id, row.owner, row);
        return row;
      }
    });
    if (!row) return;
    let commitData: unknown,
      completed = false;
    try {
      const source = this.sources.get(row.source),
        c = await this.engine.connection(row.owner, row.connectionId);
      if (
        !source ||
        c.status !== "ready" ||
        c.revision !== row.connectionRevision
      )
        throw new ConnectorError("subscription_connection_changed");
      if (!row.actionId) {
        if (!row.requestRef) {
          const request = await source.request(row);
          row.requestRef = await this.engine.vault.put(
            row.owner,
            "subscription-request:" + row.id + ":" + row.generation,
            request,
            this.engine.now() + 86400000,
          );
          await this.engine.store.transaction(async (tx) => {
            const current = await tx.get<Subscription>("subscription", row.id);
            if (
              !current ||
              current.state !== "active" ||
              current.leaseToken !== row.leaseToken
            )
              throw new ConnectorError("subscription_lease_lost");
            current.requestRef = row.requestRef;
            await tx.put("subscription", current.id, current.owner, current);
          });
        }
        const request = await this.engine.vault.get<{
            operation: string;
            input: Record<string, unknown>;
          }>(row.owner, row.requestRef),
          action = await this.engine.submit(
            row.owner,
            actionRequestSchema.parse({
              connectionId: row.connectionId,
              ...request,
              idempotencyKey: "subscription:" + row.id + ":" + row.generation,
            }),
          );
        row.actionId = action.id;
      }
      const action = await this.engine.action(row.owner, row.actionId);
      if (["queued", "running", "awaiting_approval"].includes(action.state)) {
        row.nextRunAt = this.engine.now() + 1000;
      } else if (action.state === "succeeded") {
        commitData = await this.engine.result(row.owner, action.id);
        const established = await source.established(row, commitData);
        if (
          !established.providerId ||
          !Number.isSafeInteger(established.expiresAt) ||
          established.expiresAt <= this.engine.now()
        )
          throw new ConnectorError("subscription_expiry_invalid");
        Object.assign(row, established);
        completed = true;
        row.generation++;
        delete row.actionId;
        delete row.requestedAt;
        delete row.requestRef;
        delete row.error;
        row.failures = 0;
        row.nextRunAt =
          this.engine.now() +
          Math.min(
            86400000,
            Math.max(1000, (row.expiresAt! - this.engine.now()) * 0.7),
          );
      } else if (action.state === "unknown_outcome") {
        row.state = "unknown_outcome";
        row.error = "subscription_outcome_uncertain";
      } else {
        row.failures++;
        row.error = action.error ?? "subscription_action_failed";
        if (
          action.state === "cancelled" ||
          [
            "provider_auth_expired",
            "provider_permission_denied",
            "connection_changed",
            "policy_revoked",
            "approval_expired",
            "scope_missing",
            "resource_denied",
          ].includes(row.error) ||
          row.failures >= 5
        )
          row.state = "blocked";
        else {
          delete row.actionId;
          delete row.requestedAt;
          delete row.requestRef;
          row.generation++;
          if (action.error === "provider_http_404") delete row.providerId;
          row.nextRunAt =
            this.engine.now() + Math.min(3600000, 30000 * 2 ** row.failures);
        }
      }
    } catch (error) {
      row.state = "blocked";
      row.error =
        error instanceof ConnectorError ? error.code : "subscription_failed";
    }
    await this.engine.store.transaction(async (tx) => {
      const current = await tx.get<Subscription>("subscription", row.id);
      if (
        !current ||
        current.state !== "active" ||
        current.leaseToken !== row.leaseToken
      )
        return;
      const connection = await tx.get<
        import("@splitin/spiderman-contracts").Connection
      >("connection", row.connectionId);
      if (
        connection?.status !== "ready" ||
        connection.revision !== row.connectionRevision
      ) {
        row.state = "blocked";
        row.error = "subscription_connection_changed";
        completed = false;
      }
      delete row.leaseToken;
      delete row.leaseUntil;
      if (completed)
        await this.sources.get(row.source)?.commit?.(row, commitData, tx);
      await tx.put("subscription", row.id, row.owner, row);
    });
    return row;
  }
}
