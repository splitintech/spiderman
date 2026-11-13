# Adapter implementation and qualification

Every adapter in this preview is marked `automated_only`. Capability discovery describes implemented operations filtered by granted scopes; it is not evidence of live provider acceptance. Missing operations are not advertised.

| Adapter | Implemented source | Remaining release work |
|---|---|---|
| Gmail/Workspace | Verified OAuth account/scopes, search/get/thread/attachment, raw draft/send with approved recipient matching, labels/read/archive through modify, trash, history/watch calls | MIME hardening, explicit reply/forward/draft editing, alias verification, incoming scheduler/renewal and sent reconciliation |
| IMAP/SMTP | Allowlisted TLS servers, authenticated setup, search/get/send, deterministic Message-ID, acceptance/rejection response | OAuth configurations for applicable servers, folder/draft operations, IDLE/polling, sent-folder reconciliation and provider conformance |
| Outlook mail | Graph account/scopes, search/get/attachments/draft/send/reply/move/read state/trash/delta | Forward/edit drafts, sender aliases, subscriptions, pagination/recovery qualification; Outlook Calendar excluded |
| Drive | Search/get/create/conditional metadata update/trash/share/change-page request | Upload/download/content/export/move, selected folder descendants, picker integration, incoming cursor/watch recovery |
| Sheets | Metadata/range read, workbook create, value/formula update and append | Sheet create/bounded batch/export, concurrency conflict strategy and picker |
| Google Calendar | Calendar/event reads, free/busy, deterministic event create, conditional event update/delete | Watch/subscription worker, sync-token recovery, recurrence/time-zone qualification and linked host-application two-way synchronization |
| WhatsApp business | Verified phone number ID, text/template submissions with provider receipt | Media/replies, signed inbound and delivery webhooks, sender/template qualification |
| WhatsApp personal | Injectable paired-session adapter interface | Pinned Baileys helper, pairing/encrypted session lifecycle, incoming/media/recovery and real device qualification; not registered in default CLI |
| iMessage | Allowlisted BlueBubbles server/version probe, text send and history, uncertain receipt handling | Strong owner/device enrollment, outbound helper, attachment delivery, durable spool extraction and cutover; account ID currently identifies the relay endpoint |
| Android Messages | Matrix identity, room history and idempotent room send; explicit configured RCS/SMS/MMS binding | Upstream homeserver/bridge install and version pin, verified device/room binding, incoming/carrier receipts and transport qualification |
| RCS for Business | Agent probe, recipient capability query and deterministic text message ID | Brand/agent approval, media, signed incoming/delivery webhooks and supported carrier tests |
| Plivo | Account probe, approved outbound request, get and hangup, bounded duration, allowlisted answer URL | Verified caller number, inbound routing, signed callbacks, audio playback, optional recording/transcription/handoff and acceptance |
| Ozzy | Isolated endpoint credentials, voice list/enroll/audition/activation/job/generation/delete, exact voice/audition validation | End-to-end workflow persistence, artifact retrieval and authenticated origin-channel delivery, concurrency/recovery qualification and audio quality acceptance |

## Resource and provider constraints

Selected resources are application policy in addition to provider scopes. A selected Drive folder does not create a folder-only OAuth scope. This preview enforces exact file/workbook/calendar IDs; descendants are not inferred. Broad search requires an explicit `*` policy. OAuth `drive.file` also requires files to be made available to the app through an appropriate provider selection/creation flow. Entering an ID alone does not grant provider permission. See [Google's scope guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

Gmail restricted scopes may require [verification and assessment](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification). The app operator must complete the applicable process before a public restricted-scope service.

Calendar authorization is distinct from synchronization. Implementations must retain and advance cursors, recover expired tokens and prevent duplicates/conflicts; see [the provider synchronization guide](https://developers.google.com/workspace/calendar/api/guides/sync). No linked booking synchronization is claimed by this preview.

Personal Android requires [mautrix/gmessages](https://github.com/mautrix/gmessages), a Matrix homeserver and paired Google Messages device. Configure only correctly identified room bindings. A Matrix receipt currently proves bridge acceptance, not carrier delivery or independently verified RCS. There is no silent SMS fallback and no email-to-SMS production transport.

Every paid provider account, number, messaging allowance and voice compute resource is bring-your-own. No adapter grants access to another user's workspace.
