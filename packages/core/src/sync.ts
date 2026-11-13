import { randomUUID } from "node:crypto";
import {
  ConnectorError,
  type ActionReceipt,
} from "@splitin/spiderman-contracts";
import { owned, type Engine } from "./index.js";

export interface SourceCursor {
  [key: string]: string | number | boolean | null;
}
export interface SyncSource {
  name: string;
  provider: string;
  request(
    resource: string,
    cursor: SourceCursor | undefined,
  ): { operation: string; input: Record<string, unknown> };
  parse(
    data: unknown,
    resource: string,
    cursor: SourceCursor | undefined,
  ): {
    cursor: SourceCursor;
    events: { sourceId: string; type: string; content: unknown }[];
    more?: boolean;
  };
  /** A provider-expired cursor must emit a gap before a controlled bootstrap. */
  expiredCursorErrors?: string[];
}
export type { SyncSchedule } from "@splitin/spiderman-contracts";
import type { SyncSchedule } from "@splitin/spiderman-contracts";
/** Polling only submits authorized reads; all provider I/O remains in Engine.runOnce. */
export class SyncCoordinator {
  readonly sources = new Map<string, SyncSource>();
  constructor(readonly engine: Engine) {}
  register(source: SyncSource) {
    if (this.sources.has(source.name))
      throw new ConnectorError("duplicate_sync_source");
    this.sources.set(source.name, source);
    return this;
  }
  async create(
    owner: string,
    input: {
      connectionId: string;
      source: string;
      resource: string;
      intervalSeconds?: number;
      maxBootstrapPages?: number;
    },
  ) {
    const connection = await this.engine.connection(owner, input.connectionId),
      source = this.sources.get(input.source);
    if (!source || source.provider !== connection.provider)
      throw new ConnectorError("sync_source_unavailable");
    const interval = input.intervalSeconds ?? 60,
      pages = input.maxBootstrapPages ?? 20;
    if (
      !input.resource ||
      input.resource.length > 1000 ||
      !Number.isInteger(interval) ||
      interval < 30 ||
      interval > 86400 ||
      !Number.isInteger(pages) ||
      pages < 1 ||
      pages > 100
    )
      throw new ConnectorError("sync_configuration_invalid");
    const request = source.request(input.resource, undefined),
      operation = this.engine.authorize(
        connection,
        request.operation,
        request.input,
      );
    if (operation.risk !== "read")
      throw new ConnectorError("sync_requires_read_operation");
    const schedule: SyncSchedule = {
      id: randomUUID(),
      owner,
      connectionId: connection.id,
      source: source.name,
      resource: input.resource,
      intervalSeconds: interval,
      state: "active",
      generation: 0,
      nextRunAt: this.engine.now(),
      createdAt: this.engine.now(),
      failures: 0,
      bootstrapPages: 0,
      maxBootstrapPages: pages,
    };
    await this.engine.store.transaction(async (tx) => {
      if (
        (await tx.list<SyncSchedule>("sync", owner)).some(
          (s) =>
            s.connectionId === connection.id &&
            s.source === source.name &&
            s.resource === input.resource &&
            s.state !== "paused",
        )
      )
        throw new ConnectorError("sync_already_configured");
      await tx.put("sync", schedule.id, owner, schedule);
    });
    return schedule;
  }
  async wake(owner: string, connectionId: string) {
    await this.engine.connection(owner, connectionId);
    await this.engine.store.transaction(async (tx) => {
      for (const row of await tx.list<SyncSchedule>("sync", owner))
        if (row.connectionId === connectionId && row.state === "active") {
          row.nextRunAt = Math.min(row.nextRunAt, this.engine.now());
          await tx.put("sync", row.id, owner, row);
        }
    });
  }
  list(owner: string) {
    return this.engine.store.transaction((tx) =>
      tx.list<SyncSchedule>("sync", owner),
    );
  }
  async pause(owner: string, id: string) {
    return this.engine.store.transaction(async (tx) => {
      const row = owned(await tx.get<SyncSchedule>("sync", id), owner);
      row.state = "paused";
      delete row.leaseToken;
      delete row.leaseUntil;
      await tx.put("sync", id, owner, row);
      return row;
    });
  }
  async resume(owner: string, id: string) {
    return this.engine.store.transaction(async (tx) => {
      const row = owned(await tx.get<SyncSchedule>("sync", id), owner);
      if (row.state === "active") return row;
      row.state = "active";
      row.failures = 0;
      row.nextRunAt = this.engine.now();
      delete row.error;
      await tx.put("sync", id, owner, row);
      return row;
    });
  }
  async tick() {
    const row = await this.engine.store.transaction(async (tx) => {
      for (const s of (await tx.list<SyncSchedule>("sync")).sort(
        (a, b) => a.nextRunAt - b.nextRunAt,
      )) {
        if (
          s.state !== "active" ||
          s.nextRunAt > this.engine.now() ||
          (s.leaseUntil ?? 0) > this.engine.now()
        )
          continue;
        s.leaseToken = randomUUID();
        s.leaseUntil = this.engine.now() + 120000;
        await tx.put("sync", s.id, s.owner, s);
        return s;
      }
    });
    if (!row) return;
    const source = this.sources.get(row.source);
    let action: ActionReceipt | undefined;
    try {
      if (!source) throw new ConnectorError("sync_source_unavailable");
      const connection = await this.engine.connection(
        row.owner,
        row.connectionId,
      );
      if (connection.status !== "ready")
        throw new ConnectorError("connection_not_ready");
      if (!row.actionId) {
        const request = source.request(row.resource, row.cursor),
          op = this.engine.authorize(
            connection,
            request.operation,
            request.input,
          );
        if (op.risk !== "read")
          throw new ConnectorError("sync_requires_read_operation");
        action = await this.engine.submit(row.owner, {
          connectionId: row.connectionId,
          ...request,
          idempotencyKey: "sync:" + row.id + ":" + row.generation,
        } as Parameters<Engine["submit"]>[1]);
        row.actionId = action.id;
      } else action = await this.engine.action(row.owner, row.actionId);
      if (["queued", "running", "awaiting_approval"].includes(action.state)) {
        row.nextRunAt = this.engine.now() + 1000;
        return await this.finish(row);
      }
      if (action.state !== "succeeded") {
        if (
          action.error &&
          source.expiredCursorErrors?.includes(action.error)
        ) {
          await this.engine.ingest(
            row.owner,
            row.connectionId,
            "sync-gap:" + row.id + ":" + row.generation,
            "sync.cursor_expired",
            { source: row.source, resource: row.resource },
          );
          delete row.cursor;
          row.bootstrapPages = 0;
          row.failures = 0;
          row.generation++;
          delete row.actionId;
          row.nextRunAt = this.engine.now() + 1000;
          return await this.finish(row);
        }
        throw new ConnectorError(action.error ?? "sync_read_failed");
      }
      const parsed = source.parse(
        await this.engine.result(row.owner, action.id),
        row.resource,
        row.cursor,
      );
      for (const event of parsed.events)
        await this.engine.ingest(
          row.owner,
          row.connectionId,
          event.sourceId,
          event.type,
          event.content,
          async (tx) => {
            const current = await tx.get<SyncSchedule>("sync", row.id);
            if (
              current?.state !== "active" ||
              current.leaseToken !== row.leaseToken ||
              current.generation !== row.generation ||
              (current.leaseUntil ?? 0) <= this.engine.now()
            )
              throw new ConnectorError("sync_state_changed");
          },
        );
      // Cursor advancement is after durable event persistence; restart replays deduplicated events.
      row.cursor = parsed.cursor;
      row.failures = 0;
      delete row.error;
      row.generation++;
      delete row.actionId;
      if (parsed.more) {
        row.bootstrapPages++;
        if (row.bootstrapPages > row.maxBootstrapPages)
          throw new ConnectorError("sync_page_budget_exceeded");
        row.nextRunAt = this.engine.now() + 1000;
      } else {
        row.bootstrapPages = 0;
        row.nextRunAt = this.engine.now() + row.intervalSeconds * 1000;
      }
      return await this.finish(row);
    } catch (error) {
      row.error =
        error instanceof ConnectorError ? error.code : "sync_processing_failed";
      row.failures++;
      if (
        [
          "connection_not_ready",
          "scope_missing",
          "resource_denied",
          "sync_page_budget_exceeded",
          "sync_source_unavailable",
        ].includes(row.error) ||
        row.failures >= 5
      )
        row.state = "blocked";
      else {
        row.generation++;
        delete row.actionId;
        row.nextRunAt =
          this.engine.now() + Math.min(3600000, 1000 * 2 ** row.failures);
      }
      return this.finish(row);
    }
  }
  private async finish(row: SyncSchedule) {
    return this.engine.store.transaction(async (tx) => {
      const current = owned(
        await tx.get<SyncSchedule>("sync", row.id),
        row.owner,
      );
      if (
        current.state !== "active" ||
        current.leaseToken !== row.leaseToken ||
        (current.leaseUntil ?? 0) <= this.engine.now()
      )
        return current;
      delete row.leaseToken;
      delete row.leaseUntil;
      await tx.put("sync", row.id, row.owner, row);
      return row;
    });
  }
}
