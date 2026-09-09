# Changelog

## 0.4.0 — Unreleased

This version is under development on `codex/tavern-completion`; a test checkpoint is available on `V3`. These entries describe implemented changes; acceptance is tracked in [VALIDATION](docs/VALIDATION.md). No 0.4 images or release have been published.

### Added

- Single Compose stack with persistent initialization, account service, and optional calls, integrations, and operations profiles.
- One-time private administrator setup, verified email, password recovery, email/TOTP MFA, recovery codes, persistent sessions, device revocation, and administrator account controls.
- Durable account-deactivation tracking, confirmed native cleanup, recovery of interrupted requests, explicit staff completion and immediate session revocation.
- Account/server profiles, optimized image editing, contacts and invitation privacy, independent server roles, category/channel permission inheritance, custom emojis, and onboarding.
- Virtualized conversations and threads, encrypted device search, forwarding with destination encryption, consent-based text link previews, and an encrypted local outbox for retries, scheduled sends, and reminders.
- Administrative email, user, room, report, audit, quota, integration, maintenance, announcement, backup, and update workflows.
- Validated instance artwork and security policy editors, invitation email/default roles, private warning inboxes, temporary bans, bulk message moderation, server audit and measured service logs/performance.
- Optimistic reaction member popovers, configurable message entry, encrypted image thumbnails and streaming historical message export.
- Authoritative account creation dates, staff-triggered verification of an already associated email, and room-moderator review of explicitly shared reports.
- Forum pagination, history loading from empty results, separate discussion-status filters, reactions and retry-safe discussion creation; participant profile/message navigation in calls.
- Server/channel notification defaults, creation-time welcome choices, designated welcome/rules links and privacy-aware friend-request/incoming-call alerts.
- Webhook name/avatar/enabled/creator management and delegated channel access, with disabled queue cancellation and immutable destination bindings.
- Server nickname moderation with protected native/custom hierarchy and preserved member-selected profiles.
- Direct-call fullscreen/Picture-in-Picture, measured speaking and browser connection statistics with no extra capture.
- Independent direct-call camera/screen quality choices with native capture/send measurements, scoped ownership and restoration of previous limits.
- Protected AFK destination/timeout settings and opt-in per-call interaction-idle warnings, cleanup and a user-clicked destination link.
- Tavern video playback/seek/volume/speed controls, local video posters and metadata, and downloads that reuse an already decrypted preview.
- Designated announcement-channel navigation and optimized invitation artwork shared through scoped invitation metadata.
- Private discussions in separate encrypted rooms, with explicit invitations, source permission checks, shared slow mode, archive controls and private-room navigation.
- Seventeen optional panels load on demand with local loading/retry feedback, preserving the surrounding conversation and drafts.
- Installable app shell, offline/reconnect behavior, guarded app updates, and automated browser/API/deployment coverage.
- Opt-in background Web Push with persistent signing keys, encrypted provider subscriptions, generic notices, current access checks and account-scoped worker cleanup.
- Conference token and reconnect authorization with durable modern participant identities, revocation retries and exact-device channel-plus-call removal.
- Protected per-server verified-email and account-age requirements, with native join/post/call enforcement, source inheritance for private discussions, owner recovery and revision-safe settings.
- Optional native server profile metadata rules for structured links, custom fields, bio and status, with inherited limits, revision-safe settings, compliant room copies and preserved rejected editor drafts.
- Optional encrypted server join/leave notices through existing verified webhook destinations, with protected settings, durable bounded queues, current recipient checks and delivery status.
- Explicit direct-message request review, acceptance and decline, with native recipient classification and recovery after partially completed acceptance.
- Per-server invitation restrictions that intersect with global privacy and actual shared Space membership, including direct native Matrix invitations.
- Separate unread mention/highlight badges and global mark-all-read with Alt+Shift+R, using private native receipts through the events already loaded when the action starts.
- Durable generic background contact-request notifications with current consent and access checks.
- Parsed Markdown headings, lists, quotes and tables, nested formatting, exact code copying and accessible spoilers; link previews exclude hidden spoiler and code URLs.
- Stable server-role mention selection with bounded current membership expansion into encrypted native mention metadata.

### Changed

- Managed browser authentication uses secure HttpOnly cookies; the account service holds Matrix access tokens.
- Calls retain Matrix/Element Call with device controls, push to talk, persistent conference docking, and authorized participant removal.
- Production configuration is generated once and retained across restarts. Migration preserves existing Matrix server identity and data.

### Fixed

- Search indexing and history exports continue through empty filtered pages, retain the requested room during older-event decryption, and reject stale identity/membership results before output or storage.
- Native eligibility and system-message module names remain distinct from the flat API modules, so deployed permission checks load correctly.

- Nginx startup configuration and gateway routing regressions.
- Session/device races, sensitive-action reauthentication, role inheritance boundaries, and stale administration edits covered by regression tests.
- Binary backup transfer and PostgreSQL readiness during isolated restore.
- Authenticated Matrix media URLs retain the account gateway path for attachment, profile and conference downloads; webhook artwork uses the same device-bound gateway authentication.
- Account changes dispose cached image URLs and reject stale uploads/downloads; streamed profile artwork stops at its byte limit.
- Native profile hydration preserves names and avatars after reload when presence has not populated the browser's user cache.
- Message links validate cached/native event identity and room membership through fetching and decryption, including account changes.
- Historical threads now follow the SDK encrypted relation timeline, share initial/page requests and reject late results after account or room access changes.
- Welcome tours wait for initial preference sync and stay dismissed on reload; completed invitation navigation closes when membership sync confirms joining.
- Room deep links requested before Matrix sync, status banners overlapping the composer, and false app-update prompts during first installation.
- Native channel/member administration now checks fresh Matrix and Tavern role authority, including native equal/higher members in manual role assignments.
- Call authorization subrequests preserve browser cookie rotation; uninspected SFU form bodies and identity-changing publish-only requests are blocked.
- A replacement sign-in retires the previous browser cookie session, and delayed responses cannot restore its expired cookie. Other devices and encryption keys are preserved.
- Contact confirmations and updates stay bound to their originating account and session; late responses cannot restore old dialogs or overwrite newer contact state.
- Managed uploads reject legacy native upload aliases while preserving authenticated media downloads.

### Security

- Server-side account, role, channel, and invitation authorization, scoped operations, origin/CSRF defenses, bounded uploads, and persistent revocation.
- Encrypted stored credentials, secrets shown only at creation, authenticated media access, and opt-in previews with DNS-pinned SSRF defenses.
- E2EE is preserved. Search and queued plaintext remain on the owning device; administrators cannot inspect arbitrary encrypted messages or enforce hidden content subtypes.

### Deprecated

- Separate manual dependency preparation for fresh installations; use canonical `compose.yaml`. Existing data paths remain supported.

### Removed

- Reusable default administrator authentication after bootstrap.
