# Tavern validation record

This records observed checks for the 0.4 development code and its `V3` test checkpoints. A passing stage is distinct from a completely passing workflow and from production acceptance. The [implementation checklist](IMPLEMENTATION_CHECKLIST.md) records remaining product work.

## Responsive modals and encrypted history recovery

Checkpoint `fb17f5d`, workflow
[34397617476](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34397617476),
passed the real Linux policy-directory repair checks, including the API process
identity, and both native history-recovery proofs again. Its mounted system-notice
settings GET now returned 200. The workflow stopped at an exact accessible-name
lookup for the destination selector, before saving the route. That selector and
the later export conversation selector now have explicit accessible names; all
five system-notice browser checks pass with the exact destination lookup. Native
encrypted system-notice delivery remains pending the next workflow.

The subsequent historical participant-discovery changes pass the production
build, all 422 JavaScript checks, and 23 focused thread/private-workspace browser
checks. Actual SDK timeline fixtures cover connected older segments, cursor
continuation, sender discovery without decryption keys, cancellation and
reset/relink/account changes during pagination or decryption. Mounted Workspace
checks cover reversed reply responses, close/reopen and account/access changes.
These local results do not establish a new passing deployed-stack workflow.

The production build and all 404 JavaScript checks pass. The complete browser
suite passes all 210 checks. Nine new modal checks cover 320–1280px viewports,
short windows, live resizing, wrapped settings tabs, reachable controls and
confirmation dialogs without horizontal overflow. Three new tests use real
IndexedDB and the installed Matrix Rust/WASM SDK to recover an undecryptable
event from a previous device store, retain the source keys and fingerprint,
reject another account's keys, skip locked stores and stop after ownership
changes. Two recovery UI tests cover a visible new-device recovery flow,
full-history restore selected by default, wrong-key retry and clearing secrets
when the session changes. Node checks also distinguish a usable backup key
from an unrelated cached key and stop stale recovery operations.

The live recovery probe passed in `V3` checkpoint `344e8c8`, workflow
[34395227904](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34395227904).
A managed logout/relogin created a new device that decrypted history from the
retained browser store. A separate fresh browser initially lacked those keys,
rejected a wrong recovery key without changing the native backup or signing
identity, and restored the real encrypted message using the saved recovery key.
The probe verified that the exact message session reached the encrypted native
backup before logout. It preserved the old browser store and used an isolated
ordinary account without changing the other live messaging fixtures.

That workflow also passed its 404 JavaScript, 210 browser and 572 Python checks,
production PWA, Docker/gateway, binary backup/restore, failed-update rollback,
and native messaging/private-discussion/AFK/eligibility/profile checks. The full
workflow failed later: system-notice settings returned 500, with the targeted
diagnostic identifying `initial_authority (PermissionError)`. The failure does
not negate the completed recovery proofs or establish passing system notices.

The previous `V3` checkpoint `e6d294b` passed build, JavaScript, browser, Python,
PWA, Docker/gateway and native messaging stages through profile-policy checks.
Its workflow failed when the mounted system-notice settings editor received a
server error. A targeted diagnostic now records a code-owned stage and exception
class without request contents or credentials, and the live probe checks that
GET directly. The 33 affected Python and eight browser checks pass locally;
the underlying production-only settings failure is not yet claimed fixed.

The permission failure was traced to initialization under `umask(077)`:
`mkdir(mode=0750)` produced a policy directory with mode `0700`, preventing the
API's supplementary Synapse group from traversing it. The initializer now
explicitly applies `0750`, also repairing previously initialized directories.
Policy loader preflight errors become a sanitized 503. Focused provisioning/API
tests pass locally with the POSIX-specific cases explicitly skipped on Windows.
The next CI run includes a read-only, network-isolated test container whose
reader drops to API UID/GID 10001 with supplementary group 991, proving denial
before repair and actual policy loading/authorization afterward. That exact
Linux identity proof and the repaired live system-notice path remain pending.

User-facing recovery instructions are in [HISTORY_RECOVERY.md](HISTORY_RECOVERY.md).

## Local history, read-state and invitation checkpoint

The combined development changes passed the production build and all 381
JavaScript checks. The full Python suite completed 559 checks with eight
platform-dependent skips and no failures. The full browser run passed 189 of 193 checks; the four
failures were fixture integration issues (a missing account-data adapter export
in the forum fixture and an invalid restricted-invitation token). All four
passed after fixture corrections. Three additional real-Radix checks reproduce
the closing-menu race, verify the live helper's corrected sequence and preserve
ordinary-member denial. This covers 196 browser checks across the full run and
focused reruns, without claiming a new fully passing live workflow.

History tests use real encrypted IndexedDB storage and reject delayed writes
after account or membership changes. Read-state tests exercise the installed
SDK's private unthreaded receipts and current notification counts. Named-link
HTTP tests cover permanent reservations, shared limits, native version-12 IDs
and creator authority, and current verified-email checks after remote waits.
The new isolated role-mention probe has nine local guard tests; actual
multi-device encrypted role-mention delivery still requires live CI.

## Earlier local formatting and role-mention checkpoint

The combined changes passed the production build and all 354 JavaScript tests.
The full browser run passed 169 checks; three activity-notification fixtures
failed to load because their API stub lacked the newly required session-owner
export. After correcting that stub, all three passed in a focused rerun. The
final role suite also passed all five cases, including two added regressions
for stale picker selection and escaped examples. This covers all 174 browser
checks, including Markdown rendering/preview consent,
actual Composer role selection, ordinary/role mention separation, and contact
session transitions. Role expansion rejects stale or incompletely loaded
audiences before sending; forwarding suppresses mentions. These browser
fixtures do not establish live encrypted multi-device role-mention delivery.

## Observed continuous integration

[Run 34385471233](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34385471233)
at development commit `5b718fd` passed build and all 384 JavaScript tests, then
failed on the same Google apt package-index checksum mismatch. The workflow now
disables only the runner's unrelated Google Chrome apt source before installing
Playwright's pinned Chromium and Ubuntu dependencies. Normal package signature
and checksum checks remain enabled. This follows the runner-image build's own
[Chrome repository cleanup](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/install-google-chrome.sh).
The revised installation and subsequent stages still require a fresh CI run.

[Run 34384936096](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34384936096)
at development commit `c370b3b` passed the repository check, build and all 381
JavaScript tests. Browser dependency installation then failed because Google's
Chrome apt package index did not match its advertised checksum. Browser,
Python, Docker and live-stack stages were not reached. The GitHub connector
could not rerun the job because its integration lacks Actions write permission;
a subsequent development push is needed for another run. This does not
establish acceptance or a product regression for the unexecuted stages.

[Run 34381965768](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34381965768)
at development commit `ea3d52f` passed build, all 354 JavaScript tests, all 174
browser tests, 538 Python checks, PWA/Compose/Docker and the gateway fixture.
The live stack passed the preceding SMTP/bootstrap, encrypted messaging,
private-discussion, AFK, eligibility and profile probes. Restricted room creation
and invitations succeeded, and the actual isolated bot was provisioned and
became ready in both fixture rooms. The browser then timed out opening the
server-settings menu; no notice-delivery assertions were reached. DM inbox,
native invitation-privacy acceptance and the final restart remain pending.
Independent failed-update rollback passed. This is a failed workflow despite
its passing build and test stages; `V3` remains the separate `c591215` checkpoint.

The menu failure was reproduced with Tavern's actual header, Radix controls and
SDK permissions. The live helper now waits for the closing menu layer to be
removed before reopening it through the normal trigger. Its three local browser
checks pass; notice delivery and later acceptance still need the live rerun.

[Run 34378243058](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34378243058)
at development commit `0a7c68b` passed build, 310 JavaScript tests, 154 browser
tests, 538 Python checks, PWA/Compose/Docker and the expanded gateway fixture.
The actual built gateway blocked all tested legacy/native upload aliases while
preserving media reads. The live stack passed the preceding encrypted messaging,
private-discussion, AFK, eligibility and profile probes, then room creation for
the bot fixture returned HTTP 429. Both owning device fingerprints were read,
but bot delivery, DM inbox and final restart acceptance were not reached.
Independent failed-update rollback passed.

The fixture now creates its empty private rooms separately from invitations.
Only that restricted configuration retries confirmed rate limits, using the
pre-persistence limits in pinned Synapse 1.160.0; known-target invitations check
native membership before any retry. Ambiguous failures are never replayed.
Fourteen local request-helper checks and six isolated DM/invitation guard checks
pass. The revised creation/invitation steps subsequently succeeded in run
34381965768 above; later live assertions remain pending.

[Run 34376809528](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34376809528)
at development commit `58a129c` passed build, 291 JavaScript tests, 141 browser
tests, 497 Python checks, PWA/Compose/Docker/gateway validation and all preceding
native messaging, private-discussion, AFK, eligibility and profile probes.
The isolated bot helper became healthy, but its first device-verification step
could not open Bob's settings because the earlier private-discussion modal was
still open. The fixture now navigates each same-session browser back to its
workspace and rechecks identity before reading its own fingerprint. No bot
credentials were provisioned or notices sent in that failed run. Independent
failed-update rollback passed; live bot delivery and final restart need the rerun.

[Run 34375353644](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34375353644)
passed the complete workflow at development commit `42edb43`: production build,
291 JavaScript tests, 141 browser tests, 491 Python tests, offline PWA, Compose,
remote Docker builds, restricted HTTP/WebSocket gateways and fresh-stack restart.
Real TLS SMTP/bootstrap, ordinary-account authorization, encrypted messaging,
edits, threads, files, avatar reload, private discussions and AFK passed.
Native account requirements denied ineligible existing sends, fresh joins and
call membership and restored encrypted posting after disable. Native profile
limits enforced custom authority, revisions, protected configuration, UTF16
lengths, forbidden links/fields/status, and profileless joins/leaves. Durable
account deactivation and isolated failed-update rollback also passed. This run
does not establish live encrypted bot notices, DM request inbox acceptance,
external push delivery or physical media. `V3` remains the separate `c591215`
test checkpoint; this evidence applies to the development commit above.

The next isolated live probe adds a dormant CI-only controller for the actual
integration image, dedicated fixture accounts and a real persistent nio device.
It pins each recipient's independently read current-device fingerprint, then
checks native ciphertext and both browsers' decrypted join/leave notices,
restart recovery, missing-pin retry, disabled routing and audience changes.
Its six local helper guard/HTTP checks pass; actual Docker execution is pending.

[Run 34374301063](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34374301063)
at development commit `a73a362` passed the production build, 291 JavaScript
tests, 141 browser tests and offline PWA. One of 491 Python checks errored because
an API signature test imported Synapse's `canonicaljson`, which the separate API
test environment does not install. The fixture now signs its exact standard-JSON
bytes using the native signature helper; the runtime transport is unchanged.
Docker and live acceptance stages were not reached in that run.

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

The next DM request, per-server invitation privacy and contact-push checkpoint
passed the production build, 307 JavaScript tests and all 154 browser tests.
Full Python discovery initially exposed four older native fixtures without the
reactor required by strict invitation deadlines. Supplying an explicit portable
cancellable Deferred adapter preserved the native assertions; all 538 Python
tests then passed, with eight Windows/platform skips. Invitation regressions
cover changed native documents, membership drift, malformed empty documents,
stalled native reads, streamed bodies and lock acquisition timeouts. DM checks
exercise actual SDK room/account-data models, inbox navigation, partial joins,
fresh mapping merges and queued account A-to-B-to-A changes. Three additional
guard tests validate the new isolated native DM smoke's scope; its real
join/classification/reload/decryption/decline probe is mounted before deactivation
and still requires CI execution.

A subsequent isolated invitation probe adds a fresh owning sender with no prior
shared Spaces. Native invite POSTs and direct membership state writes exercise
global consent, pending versus accepted contacts, actual shared membership,
intersecting server restrictions, source departure and ignored users. It restores
the recipient's preferences and removes only the new contact relationship.
Three guard checks and syntax validation pass; live execution is pending. The
workflow's overall limit is 45 minutes to accommodate the additional bounded
bot, inbox and invitation probes while retaining production rate limits.

Contact push's 57 focused Python checks include an actual local TLS provider,
encrypted payload decryption after worker restart, final shared-membership
revocation, strict preferences, transaction rollback and ticket revocation.
The gateway also closes Synapse's legacy `media/v1/upload` quota bypass. Its
three portable tests pass; 28 POST/PUT raw and normalized URI checks are added
to the built-Nginx CI fixture. Local configuration checks do not establish
actual Nginx normalization or external browser push delivery.

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
