# Setup profiles

## Local

Build with `npm ci && npm run build`. Initialize with `node packages/cli/dist/index.js init`. Run `serve` and `worker` against the same `--db` path/profile. The server binds to `127.0.0.1:8787` by default. Local CLI commands retrieve the API token from the OS credential store; the developer console also accepts a token supplied by your operator. Tokens are never stored in browser storage.

`connect` reads JSON from standard input: `{ "provider": "gmail", "credentials": { ... }, "resources": [] }`. Protect credential files and remove temporary files immediately. Native Gmail/Microsoft account passwords are not supported; use OAuth access/refresh grants. The preview IMAP adapter is for explicitly allowlisted non-Google/non-Microsoft servers.

## Hosted

Use separate API and worker processes with the same PostgreSQL URL, master key and provider configuration. Set `SPIDERMAN_DATABASE_URL` and run `init` once for its idempotent records-table migration. Back up the database before upgrades. Supply encryption keys through a separately managed secret store. The CLI never automatically migrates a hosted database during normal serving.

Set `SPIDERMAN_REQUIRE_WORKER=true` on the hosted API so readiness requires a recent worker heartbeat. Configure `SPIDERMAN_WEBHOOK_ORIGIN` identically on API and worker for durable subscription lifecycle management. Set `SPIDERMAN_DELEGATION_SECRET` for short-lived JWT authentication from a trusted application. Never expose that secret to agents or browsers. Set `SPIDERMAN_ALLOWED_ORIGINS` to exact application origins and place remote serving behind TLS. `--host 0.0.0.0` is appropriate only behind authenticated TLS ingress and network policy.

For Google/Microsoft OAuth, set `SPIDERMAN_OAUTH_ORIGIN` to the public service origin and configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` as applicable. Register `/oauth/callback` at the provider. The browser must receive the start response and its HttpOnly nonce cookie on that same public origin. When the host application proxies the start call, route `/oauth/*` on the application origin to this service and forward only the OAuth nonce cookie. A state URL alone cannot authorize a different browser. Installed application authorization is available through `connect oauth PROVIDER`, including PKCE loopback handling and explicit reconnect. See the [runtime guide](runtime.md). The hosted flow uses PKCE, owner-bound state, a browser nonce and a one-use callback. Self-hosters supply their own OAuth applications. No credentials or approvals are manufactured by installation.

Operator allowlists:

- `SPIDERMAN_BRIDGE_ORIGINS`: exact HTTPS origins for Ozzy, BlueBubbles and Matrix. Loopback HTTP is allowed only locally.
- `SPIDERMAN_MAIL_HOSTS`: exact approved IMAP/SMTP hostnames. Ports are implicit TLS 993/465 in this preview.
- `SPIDERMAN_ANSWER_ORIGINS`: exact HTTPS origins for Plivo answer documents.
- `SPIDERMAN_META_VERSION`: explicit supported Meta Graph API version; the business adapter stays unregistered without it.

Device helpers, Matrix homeserver/AGPL bridge installation and provider webhook ingress are separate prerequisites. Authenticated outbound Mac/Android enrollment is pending. Keep those routes disabled until the deployment and device have been qualified.

## MCP and clients

`node packages/cli/dist/index.js mcp` starts local stdio under `SPIDERMAN_OWNER`. Its host process must be trusted. Remote MCP uses authenticated `POST /v1/mcp`; use an agent principal. Tool results are untrusted provider content. Account enrollment and human approval remain outside model tools.

The TypeScript client accepts a base URL and token callback. The Python client uses the same versioned HTTP contract and standard library. Both refuse nonlocal HTTP and credential-bearing redirects. The clients have no execution bypass or local provider engine.

## Container

Build the included Dockerfile and run `init`, `serve` and `worker` with durable volumes or PostgreSQL. Containers require an operator-supplied master key; an interactive desktop keychain is unavailable. The image runs as a non-root user and has no embedded credentials. Image build/publication and hosted qualification are separate release evidence.

Development releases may provide `spiderman-container.tar.gz`, exported only after the CI image build and non-root initialization check succeed. Verify its published SHA256, then use `docker load --input spiderman-container.tar.gz`. This distribution is a Docker image archive; it does not establish a container-registry publication or a deployed service.
