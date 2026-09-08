# Tavern feature coverage — 0.3

The target remains a self-hosted alternative spanning Discord communities, Slack collaboration, and Teams meetings. Full parity is not complete. “Implemented” below describes code paths in this release; call/deployment behavior still requires live acceptance.

| Area | Implemented | Remaining |
|---|---|---|
| Organization | Servers/Spaces, encrypted channels/DMs, invitations, standard or legacy terminology | Nested categories, reordering, discovery, expiring invitations, multiple accounts |
| Messaging | Threads, edits, reactions, redaction, pins, bookmarks, text formatting, loaded-history search | Rich composer, durable offline sends, full encrypted search index, scheduled sends, controlled link previews |
| Files | Encrypted attachments, authenticated downloads, integrity checks | Inline galleries/previews, resumable upload, quotas, shared document editing |
| Identity and recovery | SAS emoji verification, cross-signing, authenticated recovery keys, encrypted secret storage, non-deleting backup creation, automatic backup/key recovery, full restore option | QR verification UX, seamless secret transfer after every SAS flow, automatic recovery of every interrupted cross-device setup, live interoperability/security assessment |
| Calls | Direct voice/video, screen sharing, relay-only TURN, incoming/answer/decline/hangup controls | Proven browser/device/network compatibility, persistent voice channels, call-history UI |
| Conferences | Bundled Element Call, room-scoped widget bridge, MatrixRTC encryption, LiveKit/authorization/TURN deployment, native call UI controls | Persistent cross-channel dock, guest meeting links, lobby/breakouts, recording/transcription, organizational meeting policy, scale proof |
| Work | Encrypted tasks with assignees/progress, authored notes/revisions, calendar .ics exports, polls with editable visible votes | Full historical projection/index, concurrent shared-document editing, recurring meetings, calendar sync, native Matrix polls, project automation |
| Notifications | Matrix all/mention/mute rules; generic desktop alerts with an open background tab; focus mode | Closed-browser/mobile push, notification center, presence/status schedules |
| Permissions | Kick/ban/unban, member/moderator roles, invitation/message/pin/conference thresholds | Arbitrary Discord role bitsets, role inheritance, complete audit/admin/reporting UI |
| Integrations | Signed inbound text hooks; durable E2EE bot; explicit room/user/device allowlists; encrypted outbox and replay protection | OAuth app catalog, turnkey Slack/Teams connectors, outbound automation, arbitrary bot/plugin management UI, controlled bridges |
| Account access | Local Matrix login, session listing and revocation, closed registration and login throttles | SSO/OIDC, MFA interface, account recovery administration, multi-account UX |
| Customization | Tavern branding, colors/themes, density, focus, legacy terminology | Instance branding editor, extension SDK, comprehensive accessibility assessment |
| Operations | Docker source builds, Compose/Dockhand files, NPM/Cloudflare guides, private DB/server networks, call services | Published signed multi-architecture images, tested upgrades/disaster recovery, load testing, monitoring/admin console |

## Distinctive behavior

- Recovery uses official Matrix crypto and preserves old backup versions. Tavern does not silently replace an existing signing identity to clear an error.
- Typing is off by default. Focus hides activity. Desktop alerts do not expose decrypted content or sender names.
- Integration delivery stops when a participant or device is outside the configured trust policy. The bot never falls back to plaintext Matrix messages.
- Tasks, notes, events, and polls live in encrypted conversation history, with plaintext-compatible message fallbacks only after the receiving Matrix client decrypts them.
- Accounts, database, signaling, media relays, and integration processing can all run on infrastructure controlled by the operator.

## Validation status

Application type checking, production compilation, focused JS/Python tests, and a real nio SQLite identity/outbox reopen test were run. No live Synapse deployment, two-browser verification, group-media session, router/NPM configuration, load test, or independent audit was completed in this environment. The deployment guide provides explicit acceptance cases for those remaining gates.
