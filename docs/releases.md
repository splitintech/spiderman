# Releases and qualification

The current version is a developer alpha. Source, tests, tarball builds, registry publication, container publication, deployment and real provider/device acceptance are separate gates. No stable release or 100-user pilot is established by this preview.

Before a development release:

1. Use a clean locked installation on Node 24.
2. Build and run unit/provider-wire, interface E2E, native PostgreSQL and Chromium/WebKit tests.
3. Regenerate contracts; inspect package contents, dependency notices and secret checks.
4. Pack all npm modules together, build a Python wheel and verify clean installation.
5. Verify npm `@splitin` and Python publication authority before publishing. Use npm tag `alpha`, never `latest`.
6. Record source commit, package checksums, test logs, registry versions and container digest independently.

Stable release requires all promised adapter operations, approved provider applications, subscription renewal and cursor recovery, uncertain-send reconciliation, linked Calendar behavior and owner-isolated voice delivery. A route with missing functionality stays visibly unavailable/unqualified.

Live acceptance uses dedicated authorized accounts/devices. Demonstrate connect/read/approved write/incoming/revoke/recovery; physical iMessage Mac and recipient, separately identified Android RCS/SMS/MMS, official business senders, inbound/outbound Plivo audio and voice enrollment/audition/owned delivery. Advance pilot cohorts 10 → 25 → 100 only with the appropriate evidence. Never use customer recipients for an automated test.

For upgrade/rollback, stop the worker, drain or inspect in-flight commands, back up the database and preserve its encryption key separately. Unknown outcomes must be reconciled before any resend. The records schema is version 1; this alpha has only the initial additive table/index migration. Restore matching source/packages/schema/key together. Do not switch between SQLite and PostgreSQL by copying record files or enabling a second dispatch owner.

The CLI's `doctor` currently reports configuration and runtime basics. It does not yet certify provider webhooks, devices or production readiness.
