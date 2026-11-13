import { createHash, randomUUID } from "node:crypto";
import {
  actionRequestSchema,
  policyInputSchema,
  describeOperation,
  ConnectorError,
  type Connection,
  type ActionRequest,
  type ActionReceipt,
  type CapabilityManifest,
  type ProviderResult,
  type Policy,
  type EventEnvelope,
} from "@splitin/spiderman-contracts";
export interface Transaction {
  get<T>(kind: string, id: string): Promise<T | undefined>;
  list<T>(kind: string, owner?: string): Promise<T[]>;
  put(kind: string, id: string, owner: string, value: unknown): Promise<void>;
  remove(kind: string, id: string): Promise<void>;
}
export interface Store {
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface Vault {
  put(
    owner: string,
    key: string,
    value: unknown,
    expiresAt?: number,
  ): Promise<string>;
  get<T>(owner: string, ref: string): Promise<T>;
  delete(owner: string, ref: string): Promise<void>;
  purge(): Promise<number>;
}
export interface ProviderContext {
  connection: Connection;
  credentials: Record<string, unknown>;
  actionId: string;
  idempotencyKey: string;
  signal: AbortSignal;
  updateCredentials?: (credentials: Record<string, unknown>) => Promise<void>;
  beforeDispatch?: () => Promise<void>;
}
export interface Provider {
  manifest: CapabilityManifest;
  verify(
    credentials: Record<string, unknown>,
  ): Promise<{ accountId: string; scopes: string[] }>;
  execute(
    operation: string,
    input: Record<string, unknown>,
    context: ProviderContext,
  ): Promise<ProviderResult>;
}
export interface AgentAdapter {
  ownerForEvent(event: EventEnvelope): Promise<string | undefined>;
  onEvent(owner: string, event: EventEnvelope): Promise<void>;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",") +
    "}"
  );
}
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function owned<T extends { owner: string }>(
  value: T | undefined,
  owner: string,
): T {
  if (!value || value.owner !== owner) throw new ConnectorError("not_found");
  return value;
}
const must = (ok: unknown, code: string): void => {
  if (!ok) throw new ConnectorError(code);
};
export class Engine {
  readonly providers = new Map<string, Provider>();
  constructor(
    readonly store: Store,
    readonly vault: Vault,
    readonly now = () => Date.now(),
  ) {}
  register(provider: Provider) {
    must(!this.providers.has(provider.manifest.provider), "duplicate_provider");
    this.providers.set(provider.manifest.provider, provider);
    return this;
  }
  provider(name: string) {
    const p = this.providers.get(name);
    if (!p) throw new ConnectorError("provider_unavailable");
    return p;
  }
  async connect(
    owner: string,
    provider: string,
    credentials: Record<string, unknown>,
    resources: string[] = [],
  ): Promise<Connection> {
    must(owner.length > 0, "owner_required");
    const identity = await this.provider(provider).verify(credentials);
    must(identity.accountId, "provider_identity_missing");
    const id = randomUUID(),
      credentialRef = await this.vault.put(
        owner,
        "connection:" + id,
        credentials,
      );
    const connection: Connection = {
      id,
      owner,
      provider,
      accountId: identity.accountId,
      scopes: identity.scopes,
      resources,
      credentialRef,
      status: "ready",
      revision: 1,
      createdAt: this.now(),
    };
    try {
      await this.store.transaction(async (tx) => {
        for (const prior of await tx.list<Connection>("connection"))
          if (
            prior.provider === provider &&
            prior.accountId === identity.accountId &&
            prior.status === "ready"
          )
            throw new ConnectorError(
              prior.owner === owner
                ? "account_already_connected"
                : "account_already_bound",
            );
        await tx.put("connection", id, owner, connection);
      });
    } catch (error) {
      await this.vault.delete(owner, credentialRef);
      throw error;
    }
    return this.publicConnection(connection);
  }
  publicConnection(c: Connection): Connection {
    return { ...c, credentialRef: "[protected]" };
  }
  async connections(owner: string) {
    return this.store.transaction(async (tx) =>
      (await tx.list<Connection>("connection", owner)).map((c) =>
        this.publicConnection(c),
      ),
    );
  }
  async connection(owner: string, id: string) {
    return this.store.transaction(async (tx) =>
      owned(await tx.get<Connection>("connection", id), owner),
    );
  }
  operation(connection: Connection, name: string) {
    const operation = this.provider(
      connection.provider,
    ).manifest.operations.find((o) => o.name === name);
    if (!operation) throw new ConnectorError("operation_unavailable");
    return operation;
  }
  authorize(c: Connection, operation: string, input: Record<string, unknown>) {
    must(c.status === "ready", "connection_not_ready");
    const op = this.operation(c, operation);
    op.input.parse(input);
    must(
      op.scopes.every((s) => c.scopes.includes(s)),
      "scope_missing",
    );
    const selectedProvider = [
      "google-drive",
      "google-sheets",
      "google-calendar",
    ].includes(c.provider);
    if (selectedProvider && !c.resources.includes("*")) {
      if (
        ["drive.search", "drive.changes", "calendar.list"].includes(operation)
      )
        throw new ConnectorError("broad_resource_grant_required");
      for (const key of op.resourceKeys ?? []) {
        const value = input[key];
        if (value !== undefined)
          must(
            (Array.isArray(value) ? value : [value]).every(
              (v) => typeof v === "string" && c.resources.includes(v),
            ),
            "resource_denied",
          );
      }
    } else
      for (const key of op.resourceKeys ?? []) {
        const value = input[key];
        if (
          value !== undefined &&
          c.resources.length &&
          !c.resources.includes("*")
        )
          must(
            (Array.isArray(value) ? value : [value]).every(
              (v) => typeof v === "string" && c.resources.includes(v),
            ),
            "resource_denied",
          );
      }
    return op;
  }
  async capabilities(owner: string, id: string) {
    const c = await this.connection(owner, id);
    const p = this.provider(c.provider);
    return {
      provider: p.manifest.provider,
      version: p.manifest.version,
      transport: p.manifest.transport,
      qualification: p.manifest.qualification,
      status: c.status,
      operations:
        c.status === "ready"
          ? p.manifest.operations
              .filter(
                (o) =>
                  o.scopes.every((s) => c.scopes.includes(s)) &&
                  (c.resources.includes("*") ||
                    !["google-drive", "google-calendar"].includes(c.provider) ||
                    ![
                      "drive.search",
                      "drive.changes",
                      "calendar.list",
                    ].includes(o.name)),
              )
              .map(describeOperation)
          : [],
    };
  }
  async submit(owner: string, raw: ActionRequest): Promise<ActionReceipt> {
    const request = actionRequestSchema.parse(raw),
      c = await this.connection(owner, request.connectionId),
      op = this.authorize(c, request.operation, request.input);
    const inputDigest = digest({
      connectionId: c.id,
      operation: request.operation,
      input: request.input,
    });
    const id = digest({ owner, connection: c.id, key: request.idempotencyKey }),
      inputRef = await this.vault.put(
        owner,
        "action:" + id + ":" + inputDigest,
        request.input,
        this.now() + 86400000,
      );
    return this.store.transaction(async (tx) => {
      const current = owned(
        await tx.get<Connection>("connection", c.id),
        owner,
      );
      this.authorize(current, request.operation, request.input);
      must(current.revision === c.revision, "connection_changed");
      const existing = await tx.get<ActionReceipt>("action", id);
      if (existing) {
        must(existing.inputDigest === inputDigest, "idempotency_conflict");
        return existing;
      }
      let policyId: string | undefined;
      let allowed = op.risk === "read" || op.risk === "draft";
      if (op.risk === "write")
        for (const policy of await tx.list<Policy>("policy", owner)) {
          if (
            policy.connectionId !== c.id ||
            policy.expiresAt <= this.now() ||
            policy.used >= policy.maxActions ||
            !policy.operations.includes(request.operation)
          )
            continue;
          const recipientKeys = op.recipientKeys ?? [],
            resourceKeys = op.resourceKeys ?? [];
          const values = (keys: string[]) =>
            keys.flatMap((k) =>
              Array.isArray(request.input[k])
                ? (request.input[k] as unknown[])
                : [request.input[k]],
            );
          if (!recipientKeys.length && !resourceKeys.length) continue;
          if (
            recipientKeys.length &&
            (!policy.recipients.length ||
              !values(recipientKeys).every(
                (v) => typeof v === "string" && policy.recipients.includes(v),
              ))
          )
            continue;
          if (
            resourceKeys.length &&
            (!policy.resources.length ||
              !values(resourceKeys).every(
                (v) => typeof v === "string" && policy.resources.includes(v),
              ))
          )
            continue;
          policyId = policy.id;
          policy.used++;
          await tx.put("policy", policy.id, owner, policy);
          allowed = true;
          break;
        }
      const action: ActionReceipt = {
        id,
        owner,
        connectionId: c.id,
        connectionRevision: c.revision,
        operation: request.operation,
        inputDigest,
        inputRef,
        policyId,
        idempotencyKey: request.idempotencyKey,
        state: allowed ? "queued" : "awaiting_approval",
        createdAt: this.now(),
        updatedAt: this.now(),
        attempts: 0,
      };
      await tx.put("action", id, owner, action);
      return action;
    });
  }
  async approve(owner: string, id: string, expectedDigest: string) {
    return this.store.transaction(async (tx) => {
      const a = owned(await tx.get<ActionReceipt>("action", id), owner);
      must(a.state === "awaiting_approval", "not_awaiting_approval");
      must(a.inputDigest === expectedDigest, "approval_digest_mismatch");
      const c = owned(
        await tx.get<Connection>("connection", a.connectionId),
        owner,
      );
      must(
        c.status === "ready" && c.revision === a.connectionRevision,
        "connection_changed",
      );
      a.approval = { digest: expectedDigest, expiresAt: this.now() + 900000 };
      a.state = "queued";
      a.updatedAt = this.now();
      await tx.put("action", id, owner, a);
      return a;
    });
  }
  async policy(owner: string, raw: unknown) {
    const parsed = policyInputSchema.parse(raw);
    const c = await this.connection(owner, parsed.connectionId);
    must(
      parsed.expiresAt > this.now() &&
        parsed.expiresAt <= this.now() + 30 * 86400000,
      "policy_expiry_invalid",
    );
    for (const n of parsed.operations) {
      must(this.operation(c, n).risk === "write", "policy_operation_invalid");
    }
    const policy: Policy = { ...parsed, id: randomUUID(), owner, used: 0 };
    await this.store.transaction((tx) =>
      tx.put("policy", policy.id, owner, policy),
    );
    return policy;
  }
  async policies(owner: string) {
    return this.store.transaction((tx) => tx.list<Policy>("policy", owner));
  }
  async eventContent(owner: string, id: string) {
    const event = await this.store.transaction(async (tx) =>
      owned(await tx.get<EventEnvelope>("event", id), owner),
    );
    await this.connection(owner, event.connectionId);
    return this.vault.get(owner, event.contentRef);
  }
  async export(owner: string) {
    return {
      schemaVersion: "1",
      connections: await this.connections(owner),
      actions: await this.actions(owner),
      policies: await this.policies(owner),
      events: await this.events(owner),
    };
  }
  async deleteData(owner: string) {
    for (const c of await this.connections(owner))
      if (c.status !== "disconnected") await this.disconnect(owner, c.id);
    await this.store.transaction(async (tx) => {
      must(
        !(await tx.list<ActionReceipt>("action", owner)).some(
          (a) => a.state === "running",
        ),
        "dispatch_in_progress",
      );
      for (const kind of [
        "connection",
        "action",
        "event",
        "policy",
        "cursor",
        "oauth",
        "secret",
      ])
        for (const row of await tx.list<{ id: string }>(kind, owner))
          await tx.remove(kind, row.id);
    });
    return { deleted: true };
  }
  async retry(owner: string, id: string) {
    const a = await this.action(owner, id),
      c = await this.connection(owner, a.connectionId);
    must(
      this.operation(c, a.operation).risk === "read",
      "automatic_retry_requires_read",
    );
    must(a.state === "failed", "retry_requires_failed_read");
    const input = await this.vault.get<Record<string, unknown>>(
      owner,
      a.inputRef,
    );
    this.authorize(c, a.operation, input);
    return this.store.transaction(async (tx) => {
      const current = owned(await tx.get<ActionReceipt>("action", id), owner);
      must(current.state === "failed", "action_state_changed");
      must(current.attempts < 5, "retry_limit_reached");
      current.state = "queued";
      current.connectionRevision = c.revision;
      current.updatedAt = this.now();
      delete current.error;
      await tx.put("action", id, owner, current);
      return current;
    });
  }
  async removePolicy(owner: string, id: string) {
    await this.store.transaction(async (tx) => {
      owned(await tx.get<Policy>("policy", id), owner);
      await tx.remove("policy", id);
    });
  }
  async disconnect(owner: string, id: string) {
    const ref = await this.store.transaction(async (tx) => {
      const c = owned(await tx.get<Connection>("connection", id), owner);
      c.status = "disconnected";
      c.revision++;
      await tx.put("connection", id, owner, c);
      for (const a of await tx.list<ActionReceipt>("action", owner))
        if (
          a.connectionId === id &&
          ["queued", "awaiting_approval"].includes(a.state)
        ) {
          a.state = "cancelled";
          a.updatedAt = this.now();
          await tx.put("action", a.id, owner, a);
        }
      return c.credentialRef;
    });
    await this.vault.delete(owner, ref);
    const content = await this.store.transaction(async (tx) => {
      const refs: string[] = [];
      for (const a of await tx.list<ActionReceipt>("action", owner))
        if (a.connectionId === id) {
          refs.push(a.inputRef);
          if (a.outputRef) refs.push(a.outputRef);
        }
      for (const e of await tx.list<EventEnvelope>("event", owner))
        if (e.connectionId === id) refs.push(e.contentRef);
      for (const p of await tx.list<Policy>("policy", owner))
        if (p.connectionId === id) await tx.remove("policy", p.id);
      return refs;
    });
    for (const ref of content) await this.vault.delete(owner, ref);
  }
  async action(owner: string, id: string) {
    return this.store.transaction(async (tx) =>
      owned(await tx.get<ActionReceipt>("action", id), owner),
    );
  }
  async result(owner: string, id: string) {
    const a = await this.action(owner, id);
    must(a.state === "succeeded" && a.outputRef, "result_not_ready");
    return this.vault.get(owner, a.outputRef!);
  }
  async preview(owner: string, id: string) {
    const a = await this.action(owner, id);
    return { action: a, input: await this.vault.get(owner, a.inputRef) };
  }
  async actions(owner: string) {
    return this.store.transaction((tx) =>
      tx.list<ActionReceipt>("action", owner),
    );
  }
  async cancel(owner: string, id: string) {
    return this.store.transaction(async (tx) => {
      const a = owned(await tx.get<ActionReceipt>("action", id), owner);
      must(
        ["queued", "awaiting_approval"].includes(a.state),
        "cannot_cancel_dispatched",
      );
      a.state = "cancelled";
      a.updatedAt = this.now();
      await tx.put("action", id, owner, a);
      return a;
    });
  }
  async ingest(
    owner: string,
    connectionId: string,
    sourceId: string,
    type: string,
    content: unknown,
  ) {
    const c = await this.connection(owner, connectionId);
    must(c.status === "ready", "connection_not_ready");
    const id = digest({ connectionId, sourceId }),
      contentRef = await this.vault.put(
        owner,
        "event:" + id + ":" + digest(content),
        content,
        this.now() + 86400000,
      );
    return this.store.transaction(async (tx) => {
      const current = owned(
        await tx.get<Connection>("connection", connectionId),
        owner,
      );
      must(current.status === "ready", "connection_not_ready");
      const old = await tx.get<EventEnvelope>("event", id);
      if (old) return old;
      const event: EventEnvelope = {
        id,
        owner,
        connectionId,
        sourceId,
        type,
        createdAt: this.now(),
        contentRef,
      };
      await tx.put("event", id, owner, event);
      return event;
    });
  }
  async events(owner: string) {
    return this.store.transaction((tx) =>
      tx.list<EventEnvelope>("event", owner),
    );
  }
  async maintenance() {
    const expired = await this.vault.purge();
    const removed = await this.store.transaction(async (tx) => {
      let count = 0;
      for (const a of await tx.list<ActionReceipt>("action"))
        if (
          ["succeeded", "failed", "cancelled"].includes(a.state) &&
          a.updatedAt < this.now() - 90 * 86400000
        ) {
          await tx.remove("action", a.id);
          count++;
        }
      for (const event of await tx.list<EventEnvelope>("event"))
        if (event.createdAt < this.now() - 90 * 86400000)
          await tx.remove("event", event.id);
      return count;
    });
    return { expiredContent: expired, removedReceipts: removed };
  }
  async runOnce(): Promise<ActionReceipt | undefined> {
    const claimed = await this.store.transaction(async (tx) => {
      const all = await tx.list<ActionReceipt>("action");
      for (const a of all.sort((a, b) => a.createdAt - b.createdAt)) {
        if (a.state === "running" && (a.leaseUntil ?? 0) <= this.now()) {
          a.state = "unknown_outcome";
          a.error = "worker_lease_expired";
          a.updatedAt = this.now();
          await tx.put("action", a.id, a.owner, a);
          continue;
        }
        if (
          a.state !== "queued" ||
          all.some(
            (other) =>
              other.id !== a.id &&
              other.connectionId === a.connectionId &&
              other.state === "running" &&
              (other.leaseUntil ?? 0) > this.now(),
          )
        )
          continue;
        const c = await tx.get<Connection>("connection", a.connectionId);
        if (!c || c.status !== "ready" || c.revision !== a.connectionRevision) {
          a.state = "cancelled";
          a.error = "connection_changed";
          await tx.put("action", a.id, a.owner, a);
          continue;
        }
        if (a.policyId) {
          const p = await tx.get<Policy>("policy", a.policyId);
          if (!p || p.owner !== a.owner || p.expiresAt <= this.now()) {
            a.state = "awaiting_approval";
            delete a.policyId;
            await tx.put("action", a.id, a.owner, a);
            continue;
          }
        }
        if (a.approval && a.approval.expiresAt <= this.now()) {
          a.state = "awaiting_approval";
          delete a.approval;
          await tx.put("action", a.id, a.owner, a);
          continue;
        }
        a.state = "running";
        a.attempts++;
        a.leaseToken = randomUUID();
        a.leaseUntil = this.now() + 120000;
        a.updatedAt = this.now();
        await tx.put("action", a.id, a.owner, a);
        return a;
      }
    });
    if (!claimed) return;
    let result: ProviderResult | undefined,
      error: string | undefined,
      unknown = false,
      dispatched = false;
    try {
      const c = await this.connection(claimed.owner, claimed.connectionId),
        input = await this.vault.get<Record<string, unknown>>(
          claimed.owner,
          claimed.inputRef,
        );
      this.authorize(c, claimed.operation, input);
      must(c.revision === claimed.connectionRevision, "connection_changed");
      must(
        digest({ connectionId: c.id, operation: claimed.operation, input }) ===
          claimed.inputDigest,
        "input_changed",
      );
      const credentials = await this.vault.get<Record<string, unknown>>(
        claimed.owner,
        c.credentialRef,
      );
      dispatched = true;
      result = await this.provider(c.provider).execute(
        claimed.operation,
        input,
        {
          connection: c,
          credentials,
          actionId: claimed.id,
          idempotencyKey: claimed.idempotencyKey,
          signal: AbortSignal.timeout(60000),
          beforeDispatch: async () => {
            await this.store.transaction(async (tx) => {
              const current = owned(
                await tx.get<Connection>("connection", c.id),
                claimed.owner,
              );
              must(
                current.status === "ready" &&
                  current.revision === claimed.connectionRevision,
                "connection_changed",
              );
              this.authorize(current, claimed.operation, input);
              const action = owned(
                await tx.get<ActionReceipt>("action", claimed.id),
                claimed.owner,
              );
              must(
                action.state === "running" &&
                  action.leaseToken === claimed.leaseToken &&
                  (action.leaseUntil ?? 0) > this.now(),
                "dispatch_lease_lost",
              );
              if (action.approval)
                must(
                  action.approval.digest === action.inputDigest &&
                    action.approval.expiresAt > this.now(),
                  "approval_expired",
                );
              if (action.policyId) {
                const policy = await tx.get<Policy>("policy", action.policyId);
                must(
                  policy?.owner === claimed.owner &&
                    policy.expiresAt > this.now(),
                  "policy_revoked",
                );
              }
            });
          },
          updateCredentials: async (next) => {
            const latest = await this.connection(claimed.owner, c.id);
            must(
              latest.status === "ready" && latest.revision === c.revision,
              "connection_changed",
            );
            await this.vault.put(claimed.owner, "connection:" + c.id, next);
            const after = await this.connection(claimed.owner, c.id);
            if (after.status !== "ready" || after.revision !== c.revision) {
              await this.vault.delete(claimed.owner, c.credentialRef);
              throw new ConnectorError("connection_changed");
            }
          },
        },
      );
    } catch (e) {
      const op = this.operation(
        await this.connection(claimed.owner, claimed.connectionId),
        claimed.operation,
      );
      unknown =
        dispatched &&
        (e instanceof ConnectorError ? e.uncertain : op.risk !== "read");
      error =
        e instanceof ConnectorError ? e.code : "provider_execution_failed";
    }
    const outputRef = result
      ? await this.vault.put(
          claimed.owner,
          "result:" + claimed.id,
          result.data,
          this.now() + 86400000,
        )
      : undefined;
    let retainOutput = false;
    const receipt = await this.store.transaction(async (tx) => {
      const a = owned(
        await tx.get<ActionReceipt>("action", claimed.id),
        claimed.owner,
      );
      if (
        a.state !== "running" ||
        a.leaseToken !== claimed.leaseToken ||
        (a.leaseUntil ?? 0) <= this.now()
      )
        return a;
      a.state = result ? "succeeded" : unknown ? "unknown_outcome" : "failed";
      a.updatedAt = this.now();
      a.error = error;
      const current = await tx.get<Connection>("connection", a.connectionId);
      retainOutput =
        !!current &&
        current.status === "ready" &&
        current.revision === claimed.connectionRevision;
      if (outputRef && retainOutput) a.outputRef = outputRef;
      if (result?.providerId) a.providerId = result.providerId;
      delete a.leaseToken;
      delete a.leaseUntil;
      await tx.put("action", a.id, a.owner, a);
      return a;
    });
    if (outputRef && !retainOutput)
      await this.vault.delete(claimed.owner, outputRef);
    return receipt;
  }
}
