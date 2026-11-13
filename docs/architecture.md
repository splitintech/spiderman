# Execution architecture

All public interfaces call the same Engine. Owner identity is supplied by trusted host authentication. The core does not implement an agent/model runtime, product roles, booking policy or campaign orchestration.

1. Verify credentials against the provider and store them encrypted.
2. Validate an operation against its strict schema, granted scopes and selected-resource policy.
3. Hash exact inputs and persist an idempotent command. Reads/drafts queue; other operations await approval unless a bounded rule applies.
4. Claim one command per connection with a durable, fenced lease. Recheck account revision, approval/policy expiry and permissions.
5. Dispatch outside the metadata transaction. Persist the operation response separately from its redacted receipt.
6. Treat a crashed/expired in-flight lease or uncertain mutation as `unknown_outcome`. Do not blindly repeat it.

SQLite uses WAL, private files and a shared in-process path lock plus database transactions. PostgreSQL uses parameterized queries and a transaction advisory lock for short metadata operations. This conservative implementation serializes metadata transactions; hosted throughput for 100 users remains to be measured. No provider network request holds the metadata lock.

Content and credentials use AES-256-GCM with per-write random IV and owner/record AAD. The key lives outside the database. Default content expiry is 24 hours; metadata cleanup is 90 days. Disconnect cancels queued/approval work, increments its connection revision, removes credentials, policies and referenced content. Unknown outcomes retain metadata for reconciliation.

The current generic event ingress is an embedded `Engine.ingest` method with durable source-ID deduplication and encrypted content. Public provider signature verification, subscription scheduling, cursor recovery and event delivery are not yet complete. Do not expose this embedded method as an unauthenticated webhook.

## Decisions

- **ADR 001:** Node 24 executes providers. Python is a service client; it does not duplicate execution.
- **ADR 002:** Business authorization remains in the host application and cannot be replaced by a connection grant.
- **ADR 003:** Agent principals propose and inspect; human controls manage accounts, approval and policies.
- **ADR 004:** External bridge services retain their own licenses and deployment requirements. The Android bridge communicates over Matrix.
- **ADR 005:** Mutating uncertainty is held for reconciliation. Manual automatic retry applies only to failed reads, with a five-attempt ceiling.

The OpenAPI document and Python models are generated from shared request schemas. Response model generation and full forward/backward compatibility enforcement remain release work; the current API is an alpha contract.
