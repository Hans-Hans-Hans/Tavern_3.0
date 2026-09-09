# Tavern validation record

This records observed checks for the 0.4 development code and its `V3` test checkpoints. A passing stage is distinct from a completely passing workflow and from production acceptance. The [implementation checklist](IMPLEMENTATION_CHECKLIST.md) records remaining product work.

## Observed continuous integration

[Run 34372590506](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34372590506)
at development commit `c4c9688` passed the production build, 285 JavaScript
checks, 136 browser tests, 446 Python tests, offline PWA, Compose, remote Docker
builds and both gateway fixtures. The fresh stack passed bootstrap/TLS SMTP,
ordinary account authorization, encrypted messages/edits/threads/files, profile
avatar reload, native private discussions and AFK. Eligibility assertions passed
for age, email, fresh joins, native call membership and owner recovery, then the
script stopped on the first HTTP 429 while the SDK was sending the final recovery
message. It now observes the SDK's retry of the same transaction within the
existing deadline; it never clicks Send again or manually replays the message.
Profile-rule acceptance and the final restart were not reached. Independent
failed-update rollback passed.

[Run 34370886413](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34370886413)
at development commit `41abdee` passed the production build, all 272 JavaScript
and 124 browser tests, Python checks, offline PWA, Compose, both remote-context
Docker image builds, restricted gateway and the new call/push routing fixture.
The independent failed-update rollback also passed. Live native eligibility
enforced configuration authority and the account-age restriction, then the
probe failed on a rate-limited leave request before email/recovery acceptance.
The known-room leave helper now rechecks membership before a bounded retry of
`M_LIMIT_EXCEEDED`; ambiguous network errors remain failures. This run did not
complete the fresh-stack workflow or test the subsequent profile rules.

[Run 34369281708](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34369281708)
tested the `c591215` checkpoint pushed to `V3`. Its production build passed,
but one of 272 JavaScript tests exhausted a fixed 100-event-loop-turn wait before
native WebCrypto completed on the runner. Browser and Docker stages did not run.
The development-branch test now subscribes to the actual idle state with a
five-second failure deadline; all 34 affected local checks pass. This correction
changes the test, while `V3` retains the `c591215` application checkpoint.

[Run 34369895845](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34369895845)
at development commit `60d69e1` passed the build and all 272 JavaScript tests,
then passed 121 browser tests and failed three native-worker notification tests.
The pinned Chromium 153 headless shell reports notification permission as denied
in both page and worker despite the test's browser-context grant. This behavior
was reproduced locally; the same pinned full Chromium reports granted and
supports the native notification checks. The notification suite now selects full
Chromium headless explicitly and asserts both permissions before testing delivery.
Docker stages did not run in that failed workflow.

[Run 34362064249](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34362064249)
passed the complete workflow at development commit `12c5c54`: production build,
242 JavaScript tests, 116 browser tests, 317 Python checks, offline PWA, Compose,
remote Docker builds, restricted gateway and fresh-stack restart/persistence.
Live TLS SMTP/bootstrap and ordinary-account authorization passed, alongside
actual encrypted messages, edits, threads, files and avatar reload. Private
discussion creation/invitation/source exclusion, bidirectional encryption,
source-access loss, archive and stale-state enforcement all passed. Native AFK
settings enforced custom authority beyond native power, revision checks,
destination validity and redaction protection. The final account-settings probe
deactivated the isolated Bob account in Synapse, completed its durable local
journal, rejected its former session cookie and left Alice signed in. The
independent failed-update fixture restored healthy application images, data and
signing identity. This development commit does not include the later Web Push or
conference admission gateway. At the time of that run, `V3` was the separate
`923d726` checkpoint; subsequent branch updates require their own CI evidence.

[Run 34357539438](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34357539438) reached the new private-discussion acceptance at `3677751`. It passed the earlier build/browser/Python/Docker stages, real encrypted messages and files, native self-profile hydration, avatar reload and isolated update rollback. Native private creation required explicit source permission; source-owner joins/reads and privacy widening were rejected. Alice and invited Bob exchanged actual encrypted private messages and retained same-device decryption after reload. Direct encrypted sends were denied after source permission or membership loss. The overall workflow then failed because an archive state write received Synapse's HTTP 429 rate limit. The probe now respects bounded server-reported retry delays for its GET/PUT requests; room creation and ambiguous network failures are not replayed. Archive/stale-revision acceptance still needs the rerun.

[Run 34356188557](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34356188557) tested private/media checkpoint `9905f3d`. Build, 195 JavaScript tests, 91 browser tests, 283 Python tests, offline PWA, Compose, remote Docker builds and restricted gateway passed. Live HTTPS/SMTP, ordinary-account authorization, encrypted send/reload/edit/reaction/thread, native self-profile hydration, stored ciphertext, byte-for-byte recipient download and isolated failed-update rollback also passed. The overall run failed at a later reload: an invited linked room became joined during sync, leaving an empty invitation dialog open. This prevented the avatar reload assertion and new private-discussion acceptance probe from completing. A subsequent navigation fix closes that invitation dialog when the linked room or server becomes joined, with two browser regressions; its live rerun remains pending.

[GitHub run 34351342245](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34351342245) is a fully successful workflow for development commit `9f65f11`. It passed 166 JavaScript tests, 74 browser tests and 261 Python tests with no recorded skips, production build/PWA/Compose checks, clean-stack setup and restart, real TLS SMTP, account authorization, encrypted send/reload/edit/reaction/thread flows, stored attachment ciphertext verification and byte-for-byte recipient download.

Its separate failed-update fixture also passed: a deliberately broken replacement web image exited with code 78; the real operations job restored the original healthy web/API images, gateway routes, SQL row, binary file and Synapse signing identity, retaining a valid pre-update backup. The main test stack's container start times were unchanged. Release metadata and image-download adapters use pinned local fixture images for this isolated test, so this proves the Docker/job/backup/health/rollback path, not a published GitHub/GHCR release download. Subsequent development commits need their own CI evidence.

[Run 34352418468](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34352418468) passed the complete workflow again at `4dfc543`, adding actual ordinary-account avatar crop/upload, account and room profile persistence, and another user's authenticated thumbnail after reload. Native display-name hydration for a user without Tavern profile metadata is a subsequent fix and has a separate pending live assertion.

The earlier `V3` test checkpoint has a different result:

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

That run passed HTTPS setup, ordinary-account authorization, two-user encrypted send/decryption, same-device reload decryption, encrypted edits, reaction sync and thread replies. Its upload returned HTTP 200, but the smoke script could not inspect binary upload bytes through Playwright's `postDataBuffer()` and failed that assertion. The corrected script verifies stored ciphertext through authenticated media download. [Run 34348386957](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34348386957) tested that correction at `7cc5e55`: stored ciphertext verification and encrypted file delivery passed, but recipient download exposed a real SDK media-URL bug. The SDK discarded the managed `/api/matrix` prefix, sending authenticated media requests to the wrong route and receiving 401. The shared media helper now preserves the configured gateway prefix for attachments, profile thumbnails and conference downloads; 18 focused tests include the actual installed SDK conversion. The later successful 9f65f11 run above verifies byte-for-byte recipient download and failed-update rollback. Browser acceptance and the separate rollback fixture now run independently so a browser failure does not prevent rollback evidence.

Earlier failures exposed binary archive extraction, restored-database readiness, read-only proxy mounts and the runner's access to the SMTP inbox. The successful stages above validate their fixes; the failures are not counted as successful checks.

Development run [34358857688](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34358857688) at `57c7aec` passed 198 JavaScript tests, 95 browser tests, Python and production/deployment builds, restricted gateway, fresh stack, encrypted send/reload/edit/thread/file delivery and isolated failed-update rollback. It failed when a dismissed welcome tour reopened during Bob's avatar-check reload before account preferences finished syncing. The tour now waits for initial Matrix sync and reconciles completed preferences; focused browser regressions cover delayed sync, cross-device completion and manual resumption. This failed run did not reach the private-discussion archive retry and is not counted as a successful final deployment.

Development run [34360606392](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34360606392) at `a84c23e` passed 239 JavaScript and 116 browser tests, 317 Python checks, production/PWA/Docker validation, fresh stack, TLS setup, encrypted message/edit/thread/file and avatar-reload acceptance, and isolated failed-update rollback. The real three-account private-discussion probe completed: explicit creation grants, source-owner exclusion, invitation acceptance, bidirectional encryption/reload, source permission and membership loss, archive rejection and stale-state rejection all passed. AFK setup then hit `M_LIMIT_EXCEEDED` while Alice joined its explicitly created fixture rooms. A bounded retry now rechecks native membership before repeating that known-room join; network ambiguity is not automatically replayed. That failed run did not reach native AFK assertions or account deactivation.

## Subsequent local verification

The subsequent encrypted system-notice integration passed the production build,
291 JavaScript tests, 141 browser tests and 485 Python tests (eight platform
skips). Additional review reproduced and fixed public/system transaction-ID
collision, malformed send confirmations, native bot suspension and verification
changes during final state reads, worker exit on a temporary database error,
and unbounded partial-state lookup. All 88 final system, provisioning, native
eligibility and import-layout checks pass. A separate isolated process reproduces the
container's flat API imports and deployed native module tree, including retained
older module files; distinct native names fix its previously observed HTTP 503
policy-load failure. Real encrypted system-notice delivery through a live bot
remains pending.

The subsequent profile metadata rules passed 282 JavaScript tests, 446 Python
checks (eight Windows/platform skips), and the production build/typecheck.
The integrated browser run passed 135 of 136 cases; its sole failure was an
older nickname fixture missing the SDK's list form of `getStateEvents` and room
identity. After correcting that fixture, all 14 affected nickname/profile
browser checks passed using pinned full Chromium 153. Actual profile editor
coverage includes retained rejected drafts, global-to-room projection, reset
without waiting for sync, unavailable rules, account/server replacement during
requests and clearing unsubmitted image crops on scope change. The native
profile acceptance probe is mounted after eligibility; actual Synapse execution
remains pending. A separate system-message feature is still under development
and is excluded from these profile results.

The conference authorization, background Web Push and server account requirements
working tree passed the production build/typecheck, offline PWA check, 272
JavaScript tests, 124 browser tests and 428 Python checks (eight Windows/platform
skips). Call checks exercise actual API sessions, signed modern/legacy scope,
refreshed-token admission, native/custom authority, revocation retries and exact
participant removal. Seven actual HTTP cookie-lifecycle cases include a delayed
old-account response after replacement login. Eligibility regressions cover
native account fields, current verification, all canonical parents, private
source inheritance and changes to settings authority during awaited checks.

Push transport tests use real local TLS, recipient payload decryption and VAPID
signature verification, including post-DNS revocation and redirect rejection.
Browser tests include two actual tabs sharing the worker, IndexedDB and Web Locks,
with native `showNotification` calls and provider/HTTP fixtures. Independent
reviews reproduced and retested stale binding, cleanup and permission races.
These results do not prove delivery through an external provider, Safari/iOS or
physical call media. The new isolated Docker fixture exercises the built Nginx
HTTP/WebSocket routes, credential/body stripping and alternate-route denial.
That fixture and the native Synapse email/account-age probe await this
checkpoint's CI run.

The combined call-quality, AFK, durable deactivation, historical-thread and welcome-sync checkpoint passed production build/typecheck, all 239 JavaScript tests and all 116 browser tests. Python ran 317 checks successfully with eight Windows/platform or optional-dependency skips. Deactivation review independently reproduced and retested four asynchronous/native-response failure cases. Thread checks use the pinned SDK models and exercise the actual Matrix API projection, including missing decryption keys. Browser call-quality checks use canvas tracks and negotiated native WebRTC senders; they do not establish physical camera, microphone or external TURN behavior. New native AFK policy and Bob deactivation probes are integrated after private-discussion checks and await this checkpoint's Docker workflow.

The combined private-discussion, invitation-artwork, announcement-channel, self-profile and video-playback working tree passed production build/typecheck, all 195 JavaScript tests and all 91 browser tests. Python ran 283 checks successfully with eight Windows/platform or optional-dependency skips. Browser coverage includes the actual workspace routing and Composer, explicit private invitation acceptance, scoped attachment galleries, historical private message links and personal discovery after source departure. The new three-account live probe still requires its own GitHub workflow; these local fixtures do not establish live private-room authorization or encryption interoperability.

The combined channel integrations, server defaults, activity alerts, nickname moderation and call-controls working tree passed production build/typecheck, 156 JavaScript tests and 74 browser tests. Python ran 261 checks with eight Windows/platform or optional-dependency skips; those skipped cases require the Linux CI environment. These are local working-tree results, not a passing deployment workflow.

A subsequent image-cache review fixed stale account ownership, explicit object-URL disposal and streamed image size limits. The final production rebuild, 35 affected JavaScript tests and eight affected browser flows passed. Ten new regression cases cover those cleanup and response-boundary changes; focused counts overlap the earlier suites.

Later local media work passed four browser flows using an actual generated WebM file: poster/duration extraction, playback and seeking, byte-for-byte download, presentation cleanup and phone layout. Fourteen focused JavaScript checks passed for attachment transfer, gateway routing and native self-profile hydration, including account changes during download/decryption and a User created during a profile request. These working-tree checks precede their next deployment workflow.

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
- Published-release upgrades and a full server/E2EE recovery drill before production cutover; the isolated failed-update Docker rollback test passed.
- Mobile/PWA installation, keyboard/screen-reader/contrast behavior, representative load and independent security review.

Healthy services and unit tests do not establish external media connectivity or production-scale performance. No independent security audit, capacity certification or complete mature-platform parity is claimed.
