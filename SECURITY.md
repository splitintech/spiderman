# Security

Report vulnerabilities privately through the repository's GitHub security advisory interface. Avoid including customer content or active credentials in reports. This preview has no production support SLA.

The hosted application must authenticate the owner. A signed delegation has a subject, issuer `splitin`, audience `spiderman`, `actor_kind` of `human` or `agent`, and at most two minutes of validity. Keep the delegation key in a secret manager shared only by trusted services. Agents cannot enroll accounts, grant policies, approve actions or delete data through HTTP.

Treat all provider messages, documents, attachments and MCP results as untrusted content. They cannot establish account ownership or authorize an action. Never expose the embedded Engine or an MCP server with a caller-supplied owner ID.

Credentials and bounded content are encrypted with AES-256-GCM, authenticated to owner and record identity. The local master key belongs in the OS credential store. Hosted keys are separately supplied. SQLite paths are private; database access itself is privileged. PostgreSQL isolation is enforced in the service and store predicates, not per-user database logins.

Custom mail/bridge/voice/answer origins require operator allowlists. Redirects are refused when attaching credentials. Operators must use trusted TLS endpoints, protect DNS/network egress and keep bridge admin endpoints private. The direct BlueBubbles preview requires an existing secure network path; the outbound pairing helper is not delivered yet. Do not expose a Mac service publicly to satisfy setup.

Default content TTL is 24 hours; redacted receipt metadata lasts 90 days. Disconnect removes credentials and referenced cached content and stops pending commands. In-flight external operations can still finish. `delete --confirm` refuses while a worker holds an active dispatch; inspect that outcome before repeating deletion. Database backups have separate operator retention and key management obligations.

Stable release gates include provider/device acceptance, verified OAuth applications where required, subscription renewal/recovery, transport reconciliation, resource selection, account revocation and failure injection. Missing gates are documented, never converted into successful capabilities.
