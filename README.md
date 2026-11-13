# Spiderman

Personal account connectors for agents, with durable actions and human approval.

**Development preview source: `0.1.0-alpha.2`.** Automated tests cover local execution and simulated provider responses. Real accounts, physical devices, hosted capacity and provider approvals are unqualified. Do not treat a listed adapter as a production-ready connection. See [adapter status](docs/adapters.md).

Spiderman provides a TypeScript execution engine, SQLite and PostgreSQL stores, encrypted credentials, an HTTP service, TypeScript/Python clients, CLI and MCP. Agent and human requests share the same owner and policy checks. A connection never grants another organization member access.

## Develop

Requires Node.js 24.13 or later within the Node 24 release line and npm. Python client requires Python 3.10 or later.

```sh
npm ci
npm run check
npm run test:browser
npm run test:postgres  # needs local PostgreSQL binaries
npm run pack:all
```

Browser tests require `npx playwright install chromium webkit`. Tests use synthetic accounts and do not send real email, messages or calls. PostgreSQL tests create and remove a temporary cluster with a private Unix socket.

## Local service

```sh
node packages/cli/dist/index.js init
export SPIDERMAN_OWNER=your-local-owner-id
node packages/cli/dist/index.js serve
# In another terminal, using the same profile and database:
node packages/cli/dist/index.js worker
node packages/cli/dist/index.js connections
```

`init` keeps the master encryption key and local API token in the OS credential store. Headless hosts instead supply `SPIDERMAN_MASTER_KEY` (64 hex characters) and `SPIDERMAN_TOKEN` (at least 32 characters) through a secret manager. Keep the encryption key separate from database backups. Never put credentials in command arguments, source control or URLs.

Use `connect` with a provider credential JSON object on standard input; it verifies the account remotely. Hosted Google/Microsoft browser OAuth is available when operator applications are configured. There is no production approval application bundled with this repository. See [setup](docs/setup.md).

## Embedding

```ts
import { Engine } from "@splitin/spiderman-core";
import { SqliteStore } from "@splitin/spiderman-store-sqlite";
import { EncryptedVault, masterKey } from "@splitin/spiderman-vault";
import { GoogleProvider, refreshing } from "@splitin/spiderman-providers";

const store = new SqliteStore("./spiderman.db");
const engine = new Engine(store, new EncryptedVault(store, masterKey()));
engine.register(refreshing(new GoogleProvider("gmail")));
// Bind owner from trusted host authentication; never from model arguments.
const connections = await engine.connections(authenticatedOwnerId);
```

Modules are separately installable after publication. Build from this checkout or install an individual generated tarball; internal Spiderman dependencies are bundled, while public external dependencies install from npm. An embedded host is responsible for authenticating callers before invoking the core. The HTTP service additionally distinguishes human controls from agent calls.

## Commands and receipts

Reads and draft preparation queue automatically. Sends and provider changes require an exact-input approval or a bounded standing policy. Destructive operations always require explicit approval. MCP exposes proposals and inspection, never a human-approval tool.

`awaiting_approval → queued → running → succeeded | failed | unknown_outcome`

Queued means a durable record exists. Succeeded means the adapter obtained its operation-specific response; an accepted SMTP/message submission is not recipient delivery. Graph sends use an immutable draft identity and require Sent confirmation or remain uncertain. Unknown outcomes are held instead of being sent again. Failed reads have bounded manual retry support. Read-only Gmail, IMAP Sent, Graph and Calendar reconciliation can resolve uncertain actions without repeating a mutation.

See [durable runtime and workflow setup](docs/runtime.md), [architecture](docs/architecture.md), [API schema](contracts/openapi.json), [security](SECURITY.md), [releases](docs/releases.md) and [provenance](THIRD_PARTY_NOTICES.md).
