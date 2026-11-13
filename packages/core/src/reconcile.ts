import { randomUUID } from "node:crypto";
import {
  ConnectorError,
  type ActionReceipt,
  type ProviderResult,
  type Reconciliation,
} from "@splitin/spiderman-contracts";
import { owned, type Engine } from "./index.js";
export type { Reconciliation } from "@splitin/spiderman-contracts";
export interface ReconciliationStrategy {
  provider: string;
  operations: string[];
  request(
    action: ActionReceipt,
    input: Record<string, unknown>,
    resource?: string,
  ): { operation: string; input: Record<string, unknown> };
  resolve(
    data: unknown,
    action: ActionReceipt,
    input: Record<string, unknown>,
  ): ProviderResult | undefined;
}
/** Read-only evidence collection never repeats the uncertain external mutation. */
export class ReconciliationCoordinator {
  readonly strategies: ReconciliationStrategy[] = [];
  constructor(readonly engine: Engine) {}
  register(strategy: ReconciliationStrategy) {
    this.strategies.push(strategy);
    return this;
  }
  list(owner: string) {
    return this.engine.store.transaction((tx) =>
      tx.list<Reconciliation>("reconciliation", owner),
    );
  }
  async create(owner: string, actionId: string, resource?: string) {
    const original = await this.engine.action(owner, actionId);
    if (original.state !== "unknown_outcome")
      throw new ConnectorError("reconciliation_requires_unknown_outcome");
    const c = await this.engine.connection(owner, original.connectionId),
      strategy = this.strategies.find(
        (s) =>
          s.provider === c.provider &&
          s.operations.includes(original.operation),
      );
    if (!strategy) throw new ConnectorError("reconciliation_unavailable");
    const input = await this.engine.vault.get<Record<string, unknown>>(
        owner,
        original.inputRef,
      ),
      request = strategy.request(original, input, resource),
      operation = this.engine.authorize(c, request.operation, request.input);
    if (operation.risk !== "read")
      throw new ConnectorError("reconciliation_requires_read");
    const id = randomUUID(),
      evidence = await this.engine.submit(owner, {
        connectionId: c.id,
        ...request,
        idempotencyKey: "reconcile:" + id,
      } as Parameters<Engine["submit"]>[1]);
    const row: Reconciliation = {
      id,
      owner,
      actionId,
      evidenceActionId: evidence.id,
      state: "checking",
      createdAt: this.engine.now(),
      updatedAt: this.engine.now(),
    };
    await this.engine.store.transaction((tx) =>
      tx.put("reconciliation", id, owner, row),
    );
    return row;
  }
  async tick() {
    for (const row of await this.engine.store.transaction((tx) =>
      tx.list<Reconciliation>("reconciliation"),
    )) {
      if (row.state !== "checking") continue;
      try {
        const original = await this.engine.action(row.owner, row.actionId),
          evidence = await this.engine.action(row.owner, row.evidenceActionId);
        if (["queued", "running", "awaiting_approval"].includes(evidence.state))
          continue;
        if (original.state !== "unknown_outcome")
          throw new ConnectorError("original_action_changed");
        if (evidence.state !== "succeeded")
          throw new ConnectorError(
            evidence.error ?? "reconciliation_read_failed",
          );
        const c = await this.engine.connection(
          row.owner,
          original.connectionId,
        );
        if (c.status !== "ready" || c.revision !== original.connectionRevision)
          throw new ConnectorError("connection_changed");
        const strategy = this.strategies.find(
          (s) =>
            s.provider === c.provider &&
            s.operations.includes(original.operation),
        );
        if (!strategy) throw new ConnectorError("reconciliation_unavailable");
        const input = await this.engine.vault.get<Record<string, unknown>>(
            row.owner,
            original.inputRef,
          ),
          result = strategy.resolve(
            await this.engine.result(row.owner, evidence.id),
            original,
            input,
          );
        if (!result?.providerId) {
          row.state = "inconclusive";
          await this.save(row);
          continue;
        }
        const outputRef = await this.engine.vault.put(
          row.owner,
          "reconciled:" + original.id,
          result.data,
          this.engine.now() + 86400000,
        );
        await this.engine.store.transaction(async (tx) => {
          const action = owned(
              await tx.get<ActionReceipt>("action", original.id),
              row.owner,
            ),
            connection = await tx.get<{
              owner: string;
              status: string;
              revision: number;
            }>("connection", original.connectionId);
          if (
            action.state !== "unknown_outcome" ||
            connection?.owner !== row.owner ||
            connection.status !== "ready" ||
            connection.revision !== original.connectionRevision
          )
            throw new ConnectorError("original_action_changed");
          action.state = "succeeded";
          action.providerId = result.providerId;
          action.outputRef = outputRef;
          action.updatedAt = this.engine.now();
          delete action.error;
          await tx.put("action", action.id, row.owner, action);
          row.state = "matched";
          row.updatedAt = this.engine.now();
          await tx.put("reconciliation", row.id, row.owner, row);
        });
      } catch (error) {
        row.state = "failed";
        row.error =
          error instanceof ConnectorError
            ? error.code
            : "reconciliation_failed";
        await this.save(row);
      }
    }
  }
  private save(row: Reconciliation) {
    row.updatedAt = this.engine.now();
    return this.engine.store.transaction(async (tx) => {
      const current = owned(
        await tx.get<Reconciliation>("reconciliation", row.id),
        row.owner,
      );
      if (current.state === "checking")
        await tx.put("reconciliation", row.id, row.owner, row);
    });
  }
}
