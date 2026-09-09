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

The overall run failed at the messaging stage. The deep-link sync race was fixed and the later run reached the correct room. Follow-up runs showed the send button blocked by a fixed-position PWA banner: first a self-signed service-worker storage failure, then a false first-install update notice. CI now trusts only its ephemeral certificate fingerprint. The app reserves a measured status row, and update availability requires a distinct waiting replacement for an existing active worker. Local production PWA smoke passed with an explicit assertion that first installation shows no update notice. [Run 34347506287](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34347506287) validates the combined development fixes at `5cb349b`.

That run passed HTTPS setup, ordinary-account authorization, two-user encrypted send/decryption, same-device reload decryption, encrypted edits, reaction sync and thread replies. Its upload returned HTTP 200, but the smoke script could not inspect binary upload bytes through Playwright's `postDataBuffer()` and failed that assertion. The corrected script verifies stored ciphertext through authenticated media download. [Run 34348386957](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34348386957) tested that correction at `7cc5e55`: stored ciphertext verification and encrypted file delivery passed, but recipient download exposed a real SDK media-URL bug. The SDK discarded the managed `/api/matrix` prefix, sending authenticated media requests to the wrong route and receiving 401. The shared media helper now preserves the configured gateway prefix for attachments, profile thumbnails and conference downloads; 18 focused tests include the actual installed SDK conversion. Byte-for-byte recipient file download and actual failed-update rollback remain pending until recorded passing. The next workflow runs browser acceptance and the separate rollback fixture independently so a browser failure does not prevent rollback evidence.

Earlier failures exposed binary archive extraction, restored-database readiness, read-only proxy mounts and the runner's access to the SMTP inbox. The successful stages above validate their fixes; the failures are not counted as successful checks.

## Subsequent local verification

The combined channel integrations, server defaults, activity alerts, nickname moderation and call-controls working tree passed production build/typecheck, 156 JavaScript tests and 74 browser tests. Python ran 261 checks with eight Windows/platform or optional-dependency skips; those skipped cases require the Linux CI environment. These are local working-tree results, not a passing deployment workflow.

A subsequent image-cache review fixed stale account ownership, explicit object-URL disposal and streamed image size limits. The final production rebuild, 35 affected JavaScript tests and eight affected browser flows passed. Ten new regression cases cover those cleanup and response-boundary changes; focused counts overlap the earlier suites.

The working tree after account metadata, associated-email verification, delegated reports, forum history and call navigation changes passed 56 browser tests, 120 JavaScript tests and 222 Python tests (three platform/optional-dependency skips). These working-tree totals include channel-administration work later committed separately; final CI logs identify exact commit coverage.

The following channel-authority changes passed 19 focused JavaScript tests, 37 Python policy/invitation tests and five browser tests. PWA registration and worker guards passed eight JavaScript tests; the rebuilt production PWA installed, avoided a false update prompt and opened its reconnect screen offline. Desktop and phone-sized status-layout tests confirm the composer remains clickable and dismissing a banner releases its reserved space.

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
