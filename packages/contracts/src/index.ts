import { z } from "zod";
export const schemaVersion = "1" as const;
export const stateSchema = z.enum([
  "awaiting_approval",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown_outcome",
]);
export type ActionState = z.infer<typeof stateSchema>;
export const actionRequestSchema = z
  .object({
    connectionId: z.string().uuid(),
    operation: z.string().min(1).max(100),
    input: z.record(z.string(), z.json()),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export const limitsSchema = z
  .object({
    maxActionsPerMinute: z.number().int().min(1).max(1000).default(60),
    maxQueued: z.number().int().min(1).max(10000).default(1000),
    maxCallSecondsPerDay: z.number().int().min(0).max(86400).default(3600),
    maxSpendMicrosPerDay: z.number().int().min(0).max(1000000000000).optional(),
    unitCostMicros: z
      .record(z.string(), z.number().int().min(0).max(1000000000))
      .default({}),
  })
  .strict();
export type ConnectionLimits = z.infer<typeof limitsSchema>;
export const connectionSchema = z
  .object({
    id: z.string().uuid(),
    owner: z.string(),
    provider: z.string(),
    accountId: z.string(),
    scopes: z.array(z.string()),
    resources: z.array(z.string()),
    credentialRef: z.string(),
    status: z.enum(["ready", "disconnected", "unavailable"]),
    revision: z.number().int().positive(),
    createdAt: z.number(),
    limits: limitsSchema.optional(),
  })
  .strict();
export type Connection = z.infer<typeof connectionSchema>;
export interface Operation {
  name: string;
  risk: "read" | "draft" | "write" | "destructive";
  scopes: string[];
  input: z.ZodType<Record<string, unknown>>;
  resourceKeys?: string[];
  recipientKeys?: string[];
  policyKeys?: string[];
  secretKeys?: string[];
  /** Inputs containing staged binary content expire after one hour. */
  stagingKeys?: string[];
  stagedResult?: boolean;
}
export interface CapabilityManifest {
  provider: string;
  version: string;
  operations: Operation[];
  transport?: string;
  qualification: "automated_only" | "provider_qualified";
}
export const actionReceiptSchema = z
  .object({
    id: z.string(),
    owner: z.string(),
    connectionId: z.string().uuid(),
    connectionRevision: z.number().int(),
    operation: z.string(),
    inputDigest: z.string(),
    inputRef: z.string(),
    idempotencyKey: z.string(),
    state: stateSchema,
    createdAt: z.number(),
    updatedAt: z.number(),
    attempts: z.number().int(),
    leaseToken: z.string().optional(),
    leaseUntil: z.number().optional(),
    policyId: z.string().optional(),
    approval: z
      .object({ digest: z.string(), expiresAt: z.number() })
      .strict()
      .optional(),
    providerId: z.string().optional(),
    outputRef: z.string().optional(),
    error: z.string().optional(),
    providerState: z.record(z.string(), z.string()).optional(),
    nextAttemptAt: z.number().optional(),
    callSeconds: z.number().int().optional(),
    reservedCostMicros: z.number().int().optional(),
  })
  .strict();
export type ActionReceipt = z.infer<typeof actionReceiptSchema>;
export const policySchema = z
  .object({
    id: z.string(),
    owner: z.string(),
    connectionId: z.string().uuid(),
    operations: z.array(z.string()),
    recipients: z.array(z.string()),
    resources: z.array(z.string()),
    inputEquals: z
      .record(
        z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/),
        z.union([z.string().max(2000), z.number().finite(), z.boolean()]),
      )
      .optional(),
    expiresAt: z.number(),
    maxActions: z.number().int(),
    used: z.number().int(),
  })
  .strict();
export type Policy = z.infer<typeof policySchema>;
export const eventEnvelopeSchema = z
  .object({
    version: z.literal(1),
    provider: z.string(),
    cursor: z.string().optional(),
    id: z.string(),
    owner: z.string(),
    connectionId: z.string().uuid(),
    sourceId: z.string(),
    type: z.string(),
    createdAt: z.number(),
    contentRef: z.string(),
  })
  .strict();
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export const syncScheduleSchema = z
  .object({
    id: z.string(),
    owner: z.string(),
    connectionId: z.string().uuid(),
    source: z.string(),
    resource: z.string(),
    intervalSeconds: z.number().int(),
    state: z.enum(["active", "paused", "blocked"]),
    generation: z.number().int(),
    nextRunAt: z.number(),
    createdAt: z.number(),
    cursor: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      )
      .optional(),
    actionId: z.string().optional(),
    leaseToken: z.string().optional(),
    leaseUntil: z.number().optional(),
    failures: z.number().int(),
    error: z.string().optional(),
    bootstrapPages: z.number().int(),
    maxBootstrapPages: z.number().int(),
  })
  .strict();
export type SyncSchedule = z.infer<typeof syncScheduleSchema>;
export const voiceWorkflowSchema = z
  .object({
    id: z.string(),
    owner: z.string(),
    connectionId: z.string().uuid(),
    requestDigest: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    state: z.enum([
      "enrolling",
      "auditioning",
      "reviewing",
      "activating",
      "generating",
      "fetching",
      "delivering",
      "ready",
      "failed",
      "unknown_outcome",
      "cancelled",
    ]),
    actionId: z.string(),
    voiceId: z.string().optional(),
    jobId: z.string().optional(),
    artifactActionId: z.string().optional(),
    auditionArtifactActionId: z.string().optional(),
    deliveryActionId: z.string().optional(),
    artifactLink: z.string().optional(),
    deliveryState: z
      .enum(["attachment", "authenticated_link", "manual"])
      .optional(),
    deliveryError: z.string().optional(),
    scriptRef: z.string().optional(),
    origin: z
      .object({
        connectionId: z.string().uuid(),
        recipient: z.string(),
        transport: z.enum(["rcs", "sms", "mms"]).optional(),
      })
      .strict()
      .optional(),
    error: z.string().optional(),
    leaseToken: z.string().optional(),
    leaseUntil: z.number().optional(),
    nextRunAt: z.number(),
    poll: z.number().int(),
  })
  .strict();
export type VoiceWorkflow = z.infer<typeof voiceWorkflowSchema>;
export const reconciliationSchema = z
  .object({
    id: z.string(),
    owner: z.string(),
    actionId: z.string(),
    evidenceActionId: z.string(),
    state: z.enum(["checking", "matched", "inconclusive", "failed"]),
    createdAt: z.number(),
    updatedAt: z.number(),
    error: z.string().optional(),
  })
  .strict();
export type Reconciliation = z.infer<typeof reconciliationSchema>;
export const subscriptionSchema = z
  .object({
    id: z.string().uuid(),
    owner: z.string(),
    connectionId: z.string().uuid(),
    connectionRevision: z.number().int(),
    source: z.string(),
    resource: z.string(),
    routeId: z.string().uuid(),
    topicName: z.string().optional(),
    state: z.enum(["active", "paused", "blocked", "unknown_outcome"]),
    generation: z.number().int(),
    createdAt: z.number(),
    nextRunAt: z.number(),
    expiresAt: z.number().optional(),
    providerId: z.string().optional(),
    actionId: z.string().optional(),
    error: z.string().optional(),
    failures: z.number().int(),
    leaseToken: z.string().optional(),
    leaseUntil: z.number().optional(),
    requestedAt: z.number().optional(),
    requestRef: z.string().optional(),
  })
  .strict();
export type Subscription = z.infer<typeof subscriptionSchema>;
export const subscriptionInputSchema = z
  .object({
    connectionId: z.string().uuid(),
    source: z.string().min(1).max(100),
    resource: z.string().min(1).max(1000),
    routeId: z.string().uuid(),
    topicName: z
      .string()
      .regex(/^projects\/[A-Za-z0-9_.:-]+\/topics\/[A-Za-z0-9_.~-]+$/)
      .optional(),
  })
  .strict();
export const capabilitiesSchema = z
  .object({
    provider: z.string(),
    version: z.string(),
    transport: z.string().optional(),
    qualification: z.enum(["automated_only", "provider_qualified"]),
    status: z.enum(["ready", "disconnected", "unavailable"]),
    operations: z.array(
      z
        .object({
          name: z.string(),
          risk: z.enum(["read", "draft", "write", "destructive"]),
          scopes: z.array(z.string()),
          resourceKeys: z.array(z.string()).optional(),
          recipientKeys: z.array(z.string()).optional(),
          policyKeys: z.array(z.string()).optional(),
          secretKeys: z.array(z.string()).optional(),
          stagingKeys: z.array(z.string()).optional(),
          stagedResult: z.boolean().optional(),
          inputSchema: z.record(z.string(), z.json()),
        })
        .strict(),
    ),
  })
  .strict();
export interface ProviderResult {
  providerId?: string;
  data: unknown;
}
const connectorErrorBrand = Symbol.for(
  "net.splitin.spiderman.connector-error.v1",
);
export class ConnectorError extends Error {
  readonly [connectorErrorBrand] = true;
  static [Symbol.hasInstance](value: unknown) {
    return (
      !!value &&
      typeof value === "object" &&
      (value as ConnectorError)[connectorErrorBrand] === true &&
      typeof (value as ConnectorError).code === "string" &&
      typeof (value as ConnectorError).uncertain === "boolean"
    );
  }
  constructor(
    public code: string,
    public uncertain = false,
  ) {
    super(code);
    this.name = "ConnectorError";
  }
}
export const connectionInputSchema = z
  .object({
    provider: z.string().min(1),
    credentials: z.record(z.string(), z.unknown()),
    resources: z.array(z.string()).max(1000).default([]),
  })
  .strict();
export const policyInputSchema = z
  .object({
    connectionId: z.string().uuid(),
    operations: z.array(z.string()).min(1),
    recipients: z.array(z.string()).default([]),
    resources: z.array(z.string()).default([]),
    inputEquals: z
      .record(
        z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/),
        z.union([z.string().max(2000), z.number().finite(), z.boolean()]),
      )
      .optional(),
    expiresAt: z.number().int().positive(),
    maxActions: z.number().int().min(1).max(1000),
  })
  .strict();
export const resourcesInputSchema = z
  .object({ resources: z.array(z.string().min(1).max(1000)).max(1000) })
  .strict();
export const reconnectInputSchema = z
  .object({
    credentials: z.record(z.string(), z.unknown()),
    resources: resourcesInputSchema.shape.resources.optional(),
  })
  .strict();
export const syncInputSchema = z
  .object({
    connectionId: z.string().uuid(),
    source: z.string().min(1).max(100),
    resource: z.string().min(1).max(1000),
    intervalSeconds: z.number().int().min(30).max(86400).optional(),
    maxBootstrapPages: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export const voiceInputSchema = z
  .object({
    connectionId: z.string().uuid(),
    idempotencyKey: z.string().min(8).max(128),
    reference: z.record(z.string(), z.json()),
    script: z.string().min(1).max(2000).optional(),
    origin: z
      .object({
        connectionId: z.string().uuid(),
        recipient: z.string().min(1).max(300),
        transport: z.enum(["rcs", "sms", "mms"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const approvalInputSchema = z
  .object({ digest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const oauthInputSchema = z
  .object({
    resources: resourcesInputSchema.shape.resources.default([]),
    scopes: z.array(z.string().min(1).max(1000)).max(100).optional(),
    connectionId: z.string().uuid().optional(),
  })
  .strict();
export const reconcileInputSchema = z
  .object({ resource: z.string().min(1).max(1000).optional() })
  .strict();
export const webhookInputSchema = z
  .object({
    connectionId: z.string().uuid(),
    secret: z.string().min(32).max(1000).optional(),
    expiresAt: z.number().int().positive().optional(),
    audience: z.string().min(1).max(1000).optional(),
    serviceEmail: z.email().optional(),
    subscriptionId: z.string().min(1).max(1000).optional(),
    resourceId: z.string().min(1).max(1000).optional(),
    inboundWaitSeconds: z.number().int().min(0).max(30).optional(),
  })
  .strict();
export const webhookBindingSchema = webhookInputSchema.pick({
  subscriptionId: true,
  resourceId: true,
  expiresAt: true,
});
export const describeOperation = ({ input, ...operation }: Operation) => ({
  ...operation,
  inputSchema: z.toJSONSchema(input),
});
export const jsonSchemas = () => ({
  WebhookInput: z.toJSONSchema(webhookInputSchema, { io: "input" }),
  WebhookBinding: z.toJSONSchema(webhookBindingSchema, { io: "input" }),
  ReconcileInput: z.toJSONSchema(reconcileInputSchema, { io: "input" }),
  ConnectionLimits: z.toJSONSchema(limitsSchema, { io: "input" }),
  Policy: z.toJSONSchema(policySchema),
  EventEnvelope: z.toJSONSchema(eventEnvelopeSchema),
  SyncSchedule: z.toJSONSchema(syncScheduleSchema),
  VoiceWorkflow: z.toJSONSchema(voiceWorkflowSchema),
  Reconciliation: z.toJSONSchema(reconciliationSchema),
  Subscription: z.toJSONSchema(subscriptionSchema),
  SubscriptionInput: z.toJSONSchema(subscriptionInputSchema, { io: "input" }),
  Capabilities: z.toJSONSchema(capabilitiesSchema),
  Connection: z.toJSONSchema(connectionSchema),
  ActionReceipt: z.toJSONSchema(actionReceiptSchema),
  JsonValue: z.toJSONSchema(z.json()),
  ActionRequest: z.toJSONSchema(actionRequestSchema, { io: "input" }),
  ConnectionInput: z.toJSONSchema(connectionInputSchema, { io: "input" }),
  PolicyInput: z.toJSONSchema(policyInputSchema, { io: "input" }),
  ActionState: z.toJSONSchema(stateSchema),
  ResourcesInput: z.toJSONSchema(resourcesInputSchema, { io: "input" }),
  ReconnectInput: z.toJSONSchema(reconnectInputSchema, { io: "input" }),
  SyncInput: z.toJSONSchema(syncInputSchema, { io: "input" }),
  VoiceInput: z.toJSONSchema(voiceInputSchema, { io: "input" }),
  ApprovalInput: z.toJSONSchema(approvalInputSchema, { io: "input" }),
  OAuthInput: z.toJSONSchema(oauthInputSchema, { io: "input" }),
});

export * from "./api.js";

export * from "./oauth.js";
