# Durable runtime and workflow setup

This development source is not a qualified hosted service. All providers remain `automated_only`. Package installation, source tests, deployment and real provider acceptance are separate gates.

## Execution and account controls

All mutations use the command engine. Provider HTTP calls and non-HTTP mail/session adapters recheck the active grant before dispatch. A prior queue claim does not authorize work after revocation. Requests already handed to a provider cannot be recalled.

Operation defaults are resolved before input hashing. Human approval covers the displayed inputs, connection and revision. Reconnection verifies the same provider account, rotates credentials, removes standing rules and cancels pending work. Resource and limit edits invalidate pending commands. Created Drive files and workbooks become explicitly selected resources; a selected Drive folder permits creation only inside an authorized parent. Ordinary updates cannot trash files or cancel events.

`PATCH /v1/connections/{id}/resources` requires an explicit `resources` array. Omitting resources from reconnect preserves the existing selection. Connection limits include maximum queued commands, commands per minute, reserved call seconds per UTC day and optional configured cost estimates in micro-units. Reservations are conservative dispatch budgets, not provider billing statements. Set provider-side billing limits as appropriate for the account.

`GET /v1/doctor` checks owned credential availability and stored state. `doctor --probe` also verifies provider identity/scopes. A device that has not been probed is reported that way. `/live` reports process liveness; `/health` probes storage. `SPIDERMAN_REQUIRE_WORKER=true` additionally requires a recent worker heartbeat. `/v1/health` requires authentication.

## OAuth

Hosted browser authorization supports owner-bound, one-use browser state, PKCE, requested scope allowlists and incremental Google consent. An optional owned `connectionId` reconnects that identity. Provider identity is verified after token exchange.

For a BYO installed application:

```sh
spiderman connect oauth gmail --resources file-id
spiderman connect oauth outlook
spiderman connect oauth gmail --reconnect CONNECTION_ID
```

Supply the applicable `GOOGLE_CLIENT_ID` / `MICROSOFT_CLIENT_ID` and client secret, when required, through protected environment configuration. The CLI prints an authorization URL, listens on loopback, validates state/PKCE and submits credentials directly to the authenticated service. It does not ask for a Google or Microsoft account password.

## Incoming synchronization

Configure one schedule per account/source/resource using `sync create` and JSON on stdin:

```json
{
  "connectionId": "00000000-0000-4000-8000-000000000001",
  "source": "calendar.changes",
  "resource": "selected-calendar-id",
  "intervalSeconds": 60
}
```

Sources are `gmail.incoming`, `outlook.incoming`, `imap.incoming` `calendar.changes` and broad-authorized `drive.changes`. Gmail/Graph resource `inbox` selects the current connected mailbox. IMAP uses the actual folder path. Calendar uses an authorized calendar ID.

The worker persists each read command, cursor and event. Replayed events deduplicate by provider identity. Initial snapshots establish a cursor without copying personal history. Expired cursors produce an explicit gap event before a controlled bootstrap. Page budgets, backoff, pause/resume and blocked states bound recovery. A disconnected account cannot continue syncing.

These are provider change feeds. They do not implement a SplitIn booking mirror. Canonical linked booking mappings, conflict resolution and domain approval integration are still pending.

## Verified webhook ingress

Set `SPIDERMAN_WEBHOOK_ORIGIN` to the exact public HTTPS origin and create a route through the human-only `/v1/webhooks` API. Callback ownership comes from the stored route, never callback fields.

- WhatsApp business verifies Meta's raw-body HMAC, account phone-number ID and setup challenge token.
- Gmail verifies Google-signed push OIDC audience, service email and mailbox identity.
- Calendar verifies channel token, ID and bound resource ID.
- Outlook verifies the configured subscription ID and client state. Rich encrypted notifications are not supported.
- Device-helper callbacks use a separate HMAC and bounded timestamp window.
- Plivo verifies V3 form signatures against the configured public callback URL, rejects duplicate form keys/query parameters, and persists call events. Default inbound XML hangs up; an explicitly configured wait is bounded to 30 seconds. Provider auth tokens are not returned by route setup.

Bind subscription/resource IDs using `PATCH /v1/webhooks/{id}`. Persisted ingress wakes matching polling schedules. Acknowledgment follows durable writes. Provider subscriptions are managed through durable commands as described below. Cloud Pub/Sub topics, Google publisher permissions and push delivery OIDC configuration remain operator infrastructure prerequisites; this toolkit does not create a cloud project. Polling remains independently available.

## Provider subscriptions

Create a verified webhook route first, then use `subscriptions create` with JSON on stdin. `routeId` must belong to the same owner and connection. Sources are `gmail.watch`, `calendar.watch`, `drive.watch` and `outlook.mail`. Gmail/Outlook resource is `inbox`; Calendar uses a selected calendar ID. Drive requires explicit broad access (`*`) and an active change-feed schedule with a saved cursor.

```json
{"connectionId":"00000000-0000-4000-8000-000000000001","source":"gmail.watch","resource":"inbox","routeId":"00000000-0000-4000-8000-000000000002","topicName":"projects/your-project/topics/your-topic"}
```

The worker submits initial provisioning and renewals through the same action engine. Human approval is required unless an unexpired, usage-bounded standing rule covers the exact topic or callback destination. `mail.watch` rules require `inputEquals.topicName`; channel rules require `inputEquals.address` and the selected Calendar resource; Graph creation requires `inputEquals.notificationUrl`. Graph renewal rules pin the provider's exact `subscriptionId`. Secrets cannot become policy constraints and are hidden from previews. Account ownership, scopes and revocation are rechecked at dispatch.

Renewals run daily or earlier for short expirations. Exact request inputs are encrypted and persisted before command submission, so a restart cannot generate a different expiry under the same idempotency key. Unknown submissions are held and never repeated. Authentication failures block the schedule. `subscriptions pause` stops future work and cancels pending commands; already-dispatched requests cannot be recalled. Existing provider channels expire naturally; pause is not a provider-side unsubscribe. Disconnect immediately stops local processing and removes credentials and callback secrets. Reconnect/resource/limit edits also invalidate the enrolled callback revision; an owner must explicitly rebind or replace that route before processing resumes.

Gmail renewal follows [Google's daily watch guidance](https://developers.google.com/workspace/gmail/api/guides/push). Calendar/Drive create a new channel identity per renewal. Google channel overlap is handled by durable polling and event deduplication; the ingress accepts the current bound channel. Graph uses [subscription renewal](https://learn.microsoft.com/en-us/graph/api/subscription-update?view=graph-rest-1.0). Provider approval, public HTTPS delivery and real-account lifecycle acceptance remain unqualified.

## Uncertain outcomes

```sh
spiderman actions dead-letter
spiderman actions reconcile ACTION_ID
spiderman actions inspect ACTION_ID
```

Reconciliation submits a read command. Gmail matches stable Message-ID evidence in Sent; IMAP additionally requires an explicit Sent-folder resource and exact sender/recipient evidence. Graph uses the immutable draft checkpoint and verifies the sent message. Calendar requires its exact action marker on the linked provider event. Inconclusive evidence leaves the mutation uncertain; it never causes another send. Receipt recovery can be unavailable after cached evidence inputs expire.

## Voice Studio

`voice create` accepts an owned Ozzy connection, reference fields, optional script, required idempotency key and optional originating connection/recipient. The durable coordinator follows enrollment, audition submission, job completion, artifact retrieval, human activation approval, speech generation and owned delivery.

Enrollment, audition, activation and generation are separate approved commands unless a permitted bounded rule applies. Activation always needs explicit approval. Audition artifacts are retrievable before activation is proposed. Job/voice identity and artifact checksum/size are checked when supplied by Ozzy. Interrupted workflows resume from stored action/job identities. Unknown outcomes are held.

`GET /v1/artifacts/{actionId}` requires the artifact owner's authentication. Binary staging expires after one hour. An originating iMessage connection can receive a supported audio attachment through its own approved command. For channels supporting text but not attachment delivery, `SPIDERMAN_ARTIFACT_BASE_URL` may point to an owner-authenticated artifact gateway; the resulting link contains no credential. Without a supported channel/link, the artifact is available for manual retrieval and delivery is explicitly marked manual.

Cancellation stops future workflow steps and pending commands; it does not erase already-created provider voices or undo delivered audio. No live conversational voice agent is included.

## Provider details

Gmail structured composition uses the reusable MIT MIME module, with Unicode headers, text/HTML alternatives, bounded attachments, replies, forwards and editable drafts. Raw MIME sends must match the approved recipient list and primary account sender. Gmail sender-alias discovery remains pending.

IMAP exposes folders/capabilities, bounded attachments, cursor polling, drafts, flags and moves. UID validity is required for UID-based mutations. Known Google/Microsoft hosts require the native OAuth connector. Custom servers may use `authType: "oauth2"`, `username` and a broker-supplied `accessToken`; optional `expiresAt` is an epoch-millisecond expiry. Tokens are not refreshed by an arbitrary endpoint supplied in credentials. Rotate through owner-authorized reconnect or a trusted credential broker. Native Google/Microsoft hosts still require their direct OAuth connectors. The TLS/authentication mapping follows [ImapFlow](https://imapflow.com/docs/api/imapflow-client/) and [Nodemailer](https://nodemailer.com/smtp/oauth2). Sent reconciliation requires an identified Sent folder and exact action Message-ID, sender and recipient evidence. It never repeats SMTP and proves a recorded Sent copy, not recipient delivery. Servers which do not store sent mail can leave the outcome inconclusive. Broader server qualification remains open.

Graph sends require `Mail.Send` and `Mail.ReadWrite`: a draft is created under an immutable ID, sent and confirmed. Missing confirmation leaves an uncertain outcome. Forward/reply recipients are explicit. Draft edits use a precondition. Graph `Mail.ReadWrite` also enables read capabilities. Alias compatibility remains subject to provider authorization and qualification.

Drive supports bounded binary download, supported exports, multipart upload, folder listing and conditional moves. Exact resource policies do not infer arbitrary folder descendants or replace provider authorization.

Sheets supports discovery, workbook/sheet creation, bounded structural batches, range reads/writes, append and supported export. Overwrites require expected values and explicit acknowledgment that the preflight comparison is not an atomic compare-and-swap. A detected mismatch blocks the write. Strong concurrency guarantees are not claimed.

Calendar validates all-day dates, offset timestamps, IANA zones and recurrence requirements. Event updates/deletion use provider preconditions. Recurrence instance reads and cancellation change events are distinct.

Plivo verifies a configured caller number under the account and defaults destination prefixes to North American Numbering Plan `+1`. Explicitly configured prefixes, call duration and per-account budgets constrain dispatch. Playback and transfer URLs require operator allowlists. Recording capabilities are absent unless the connection explicitly enables them; recording start requires consent and destructive-action approval. Automatic transcription is not implemented.

Personal WhatsApp still requires a supplied session: there is no pinned Baileys helper or automatic pairing in this source. Mac/Android outbound device helpers, strong enrollment and migration of the legacy spool remain pending. SMS/MMS are not relabeled as RCS.

## Contracts and installation

OpenAPI and the Python API/model modules are generated from the contracts package. A compatibility check retains the prior v1 request shapes/routes and verifies every local OpenAPI reference. Provider operation changes within this alpha include stronger explicit send/trash/concurrency requirements; inspect current capability input schemas before calling.

Each generated npm archive bundles its internal MIT Spiderman module closure and declares public external dependencies. Install smoke tests use fresh projects for each archive. A separate cross-package install test verifies that authorization and error identity survive multiple installed module copies. Archive inspection checks allowed contents, notices, digests and private-file/secret signatures. Registry publication and hosted/device qualification remain separate release gates.
