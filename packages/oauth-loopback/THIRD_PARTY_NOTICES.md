# Third-party notices and reuse

Spiderman's own code is MIT, copyright (c) 2026 SplitInTech. Dependencies retain their own licenses; `npm run licenses` writes a complete installed dependency inventory.

`packages/oauth-loopback/src/index.ts` adapts the public MIT loopback authorization helper from [Carl Allen](https://github.com/splitintech/carl-allen), commit `9e1ff74f2f96240392f49bb0e25d7e2bdf9335e9`. Copyright (c) 2026 SplitInTech; the MIT text in [LICENSE](LICENSE) applies. Changes add Spiderman branding and retain the live authorization listener after a wrong-state callback. No campaign engine code is imported. Compatible thin consumer adapters have been validated in a separate Carl Allen checkout. Package publication and merging that consumer change remain separate gates.

Ozzy is consumed over its HTTP API. Its models, datasets and deployment code are not copied. The current adapter follows the public versioned API; multi-user hosted isolation remains unqualified.

BlueBubbles and Plivo adapters implement public HTTP contracts. Existing application transport code remains in its original repository; this preview has not completed extraction/migration of its durable device spool.

[mautrix/gmessages](https://github.com/mautrix/gmessages) is an independently installed AGPL service. No AGPL bridge implementation is vendored, linked or relicensed here. Personal Google Messages requires a compatible Matrix homeserver, that bridge and device pairing. This client uses the Matrix HTTP interface and has no blanket upstream compatibility claim.

The personal WhatsApp session interface currently requires a supplied paired-session implementation. Baileys is not vendored or silently installed. A pinned, tested Baileys helper and device qualification are pending.

`packages/mail-mime/src/index.ts` also adapts the MIT MIME builder from the same public Carl Allen commit. Copyright (c) 2026 SplitInTech. Changes introduce a generic transport-only input contract, the X-Spiderman-Key header and bounded attachments. Campaign behavior is not imported. A compatible thin adapter in Carl Allen preserves its MIME boundary and legacy idempotency header. Consumer tests pass locally; publishing the dependency and merging the consumer change remain pending.

Plivo V3 callback canonicalization follows the official public SDK's documented POST format, with queryless callback URLs and duplicate form keys rejected. See https://github.com/plivo/plivo-python/blob/master/plivo/utils/signature_v3.py. No SDK implementation is vendored.
