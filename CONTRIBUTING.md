# Contributing

Use Node 24 and `npm ci`. Run `npm run check`, the PostgreSQL suite and browser tests before submitting changes. New adapters need strict schemas, account verification, actual granted-scope detection, owner/resource policies, exact approval coverage and uncertain-send handling. Add no network action to tests unless it is explicitly opt-in and uses authorized test accounts.

Keep provider adapters independent of business workflows and model vendors. Do not import campaign orchestration into a transport module. Never contribute private context, customer data, credentials or captured provider responses containing personal content.

Include an operation matrix and test evidence. Distinguish unit/provider-wire tests, interface integration, package installation, deployment and physical-device qualification. Package/API changes require contract regeneration and an upgrade note. Run `npm run format` before review.

Your contributions are licensed under the repository's MIT license. Retain upstream notices. Independently installed upstream services retain their original licenses.
