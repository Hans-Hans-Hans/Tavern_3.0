# Tavern validation record

This records observed checks for the 0.4 development code, including the `923d726` test checkpoint pushed to `V3` on 2026-09-09. A passing stage is distinct from a completely passing workflow and from production acceptance. The [implementation checklist](IMPLEMENTATION_CHECKLIST.md) records remaining product work.

## Observed continuous integration

[GitHub run 34343989783](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34343989783) tested `923d726`. These stages passed:

| Check | Result and scope |
|---|---|
| Frontend build and type checking | Production frontend and bundled conference assets compiled |
| JavaScript and browser tests | Model/crypto/projection tests and headless-browser fixtures passed |
| Production PWA offline smoke | Built production assets opened safely offline |
| Python and Compose validation | API/policy/operations tests and deployment definitions passed |
| Remote-context Docker builds | Web and integration images built from the committed GitHub source |
| Restricted gateway | Read-only filesystem, dropped capabilities, health, blocked federation/admin routes and runtime configuration passed |
| Fresh canonical stack | Actual gateway, API, Synapse, PostgreSQL and supporting services became healthy |
| Backup and isolated clone restore | Binary API-volume contents, PostgreSQL fixture row and Synapse signing identity survived backup/restoration |
| TLS SMTP and HTTPS setup | Real SMTP delivery, administrator email verification and a secure HttpOnly session succeeded |
| Ordinary account authorization | Two ordinary accounts signed in, administrator APIs rejected their sessions, and native encrypted-room creation/join succeeded |
| Encrypted send/decryption | Did not complete: the test timed out waiting for the first send response |

The overall run failed at the messaging stage. Investigation found that a room deep link could be requested before joined-room state arrived in Matrix sync. The later sync refresh updated the room list without resolving the pending link. This routing defect has been fixed in subsequent source; a rerun must establish whether it resolves the observed failure. The smoke script now captures failures reliably and additionally checks real encrypted edits, reactions, thread replies and byte-for-byte file download. Those additional checks are not recorded as passing yet.

Earlier failures exposed binary archive extraction, restored-database readiness, read-only proxy mounts and the runner's access to the SMTP inbox. The successful stages above validate their fixes; the failures are not counted as successful checks.

## Subsequent local verification

Current focused verification includes 21 invitation/community API tests covering hierarchy, native authority, stale writes, suspension, capacity retries, email failure and temporary-token cleanup. Temporary-ban work passed 43 combined Python policy/API cases, six channel-policy JavaScript cases and two browser flows. Three warning browser flows cover typed confirmation, rejected-draft retention, withdrawal history, inbox read state and losing moderator authority. These sets overlap and must not be added to produce a suite total.

Prior browser/API checks also cover category authorization, privacy, account administration, required password/MFA gates, branding, service log filtering, roles, reactions, encrypted image previews, streaming exports, onboarding, search, notifications, keyboard navigation and 2,000-row message virtualization. Production build and typecheck passed after mounting the new moderation/admin panels. Exact totals continue to change; final CI logs are authoritative for their tested commit.

The Windows development workspace has no local Docker daemon. Container and real SMTP/HTTPS results came from the GitHub runner, not local YAML parsing.

## Remaining acceptance

- Complete green CI for the final commit, including the real two-user encrypted message/edit/thread/media workflows.
- Gmail App Password delivery and external NPM/Cloudflare cookie/routing validation.
- Independent ordinary/moderator account tests for role/category/thread/invitation policies against deployed Synapse.
- TURN/LiveKit voice, video and screen sharing from independent networks and supported devices.
- Preserved-data upgrades, failed-update rollback and a full server/E2EE recovery drill before production cutover.
- Mobile/PWA installation, keyboard/screen-reader/contrast behavior, representative load and independent security review.

Healthy services and unit tests do not establish external media connectivity or production-scale performance. No independent security audit, capacity certification or complete mature-platform parity is claimed.
