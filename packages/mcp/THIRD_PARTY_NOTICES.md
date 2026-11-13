# Third-party notices and reuse

Spiderman's own code is MIT, copyright (c) 2026 SplitInTech. Dependencies retain their own licenses; `npm run licenses` writes a complete installed dependency inventory.

`packages/provider-kit/src/loopback-oauth.ts` adapts the public MIT loopback authorization helper from [Carl Allen](https://github.com/splitintech/carl-allen), commit `9e1ff74f2f96240392f49bb0e25d7e2bdf9335e9`. Copyright (c) 2026 SplitInTech; the MIT text in [LICENSE](LICENSE) applies. Changes add Spiderman branding and retain the live authorization listener after a wrong-state callback. No campaign engine code is imported. The compatible Carl Allen package migration is pending; this preview does not claim a completed cross-repository extraction.

Ozzy is consumed over its HTTP API. Its models, datasets and deployment code are not copied. The current adapter follows the public versioned API; multi-user hosted isolation remains unqualified.

BlueBubbles and Plivo adapters implement public HTTP contracts. Existing application transport code remains in its original repository; this preview has not completed extraction/migration of its durable device spool.

[mautrix/gmessages](https://github.com/mautrix/gmessages) is an independently installed AGPL service. No AGPL bridge implementation is vendored, linked or relicensed here. Personal Google Messages requires a compatible Matrix homeserver, that bridge and device pairing. This client uses the Matrix HTTP interface and has no blanket upstream compatibility claim.

The personal WhatsApp session interface currently requires a supplied paired-session implementation. Baileys is not vendored or silently installed. A pinned, tested Baileys helper and device qualification are pending.
