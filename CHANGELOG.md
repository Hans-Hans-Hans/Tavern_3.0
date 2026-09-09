# Changelog

## 0.4.0 — Unreleased

This version is under development on `codex/tavern-completion`. These entries describe implemented changes; acceptance is tracked in [VALIDATION](docs/VALIDATION.md). No 0.4 images or release have been published.

### Added

- Single Compose stack with persistent initialization, account service, and optional calls, integrations, and operations profiles.
- One-time private administrator setup, verified email, password recovery, email/TOTP MFA, recovery codes, persistent sessions, device revocation, and administrator account controls.
- Account/server profiles, optimized image editing, contacts and invitation privacy, independent server roles, category/channel permission inheritance, custom emojis, and onboarding.
- Virtualized conversations and threads, encrypted device search, forwarding with destination encryption, consent-based text link previews, and an encrypted local outbox for retries, scheduled sends, and reminders.
- Administrative email, user, room, report, audit, quota, integration, maintenance, announcement, backup, and update workflows.
- Installable app shell, offline/reconnect behavior, guarded app updates, and automated browser/API/deployment coverage.

### Changed

- Managed browser authentication uses secure HttpOnly cookies; the account service holds Matrix access tokens.
- Calls retain Matrix/Element Call with device controls, push to talk, persistent conference docking, and authorized participant removal.
- Production configuration is generated once and retained across restarts. Migration preserves existing Matrix server identity and data.

### Fixed

- Nginx startup configuration and gateway routing regressions.
- Session/device races, sensitive-action reauthentication, role inheritance boundaries, and stale administration edits covered by regression tests.
- Binary backup transfer and PostgreSQL readiness during isolated restore.

### Security

- Server-side account, role, channel, and invitation authorization, scoped operations, origin/CSRF defenses, bounded uploads, and persistent revocation.
- Encrypted stored credentials, secrets shown only at creation, authenticated media access, and opt-in previews with DNS-pinned SSRF defenses.
- E2EE is preserved. Search and queued plaintext remain on the owning device; administrators cannot inspect arbitrary encrypted messages or enforce hidden content subtypes.

### Deprecated

- Separate manual dependency preparation for fresh installations; use canonical `compose.yaml`. Existing data paths remain supported.

### Removed

- Reusable default administrator authentication after bootstrap.
