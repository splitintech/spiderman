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
export interface Connection {
  id: string;
  owner: string;
  provider: string;
  accountId: string;
  scopes: string[];
  resources: string[];
  credentialRef: string;
  status: "ready" | "disconnected" | "unavailable";
  revision: number;
  createdAt: number;
}
export interface Operation {
  name: string;
  risk: "read" | "draft" | "write" | "destructive";
  scopes: string[];
  input: z.ZodType<Record<string, unknown>>;
  resourceKeys?: string[];
  recipientKeys?: string[];
}
export interface CapabilityManifest {
  provider: string;
  version: string;
  operations: Operation[];
  transport?: string;
  qualification: "automated_only" | "provider_qualified";
}
export interface ActionReceipt {
  id: string;
  owner: string;
  connectionId: string;
  connectionRevision: number;
  operation: string;
  inputDigest: string;
  inputRef: string;
  idempotencyKey: string;
  state: ActionState;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  leaseToken?: string;
  leaseUntil?: number;
  policyId?: string;
  approval?: { digest: string; expiresAt: number };
  providerId?: string;
  outputRef?: string;
  error?: string;
}
export interface Policy {
  id: string;
  owner: string;
  connectionId: string;
  operations: string[];
  recipients: string[];
  resources: string[];
  expiresAt: number;
  maxActions: number;
  used: number;
}
export interface EventEnvelope {
  id: string;
  owner: string;
  connectionId: string;
  sourceId: string;
  type: string;
  createdAt: number;
  contentRef: string;
}
export interface ProviderResult {
  providerId?: string;
  data: unknown;
}
export class ConnectorError extends Error {
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
    expiresAt: z.number().int().positive(),
    maxActions: z.number().int().min(1).max(1000),
  })
  .strict();
export const describeOperation = ({ input, ...operation }: Operation) => ({
  ...operation,
  inputSchema: z.toJSONSchema(input),
});
export const jsonSchemas = () => ({
  ActionRequest: z.toJSONSchema(actionRequestSchema),
  ConnectionInput: z.toJSONSchema(connectionInputSchema),
  PolicyInput: z.toJSONSchema(policyInputSchema),
  ActionState: z.toJSONSchema(stateSchema),
});
