# Tavern validation record

This records observed checks for the 0.4 development code and its `V3` test checkpoints. A passing stage is distinct from a completely passing workflow and from production acceptance. The [implementation checklist](IMPLEMENTATION_CHECKLIST.md) records remaining product work.

## September 12 recovery and channel-management checkpoint

The actual TLS SMTP/native history recovery gate passed at `f958030` and again
at `f6190e8` and `0dd7afe`: enrollment, automatic new-device email prompt,
wrong-code rejection, correct-code restoration of an encrypted message, and
known-browser sign-in without another recovery prompt. These checks preserve
the existing native backup and signing identity. Missing historical keys still
cannot be regenerated. The native DM request/accept/reply/reload and decline
flows also passed; DMs now have their own server-rail section.

At `f46ae02`, [run 34674781269](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34674781269)
passed actual private-channel admission, invited-join rejection, durable native
membership removal and regrant, and LiveKit authorization. These stages passed
again at `27d163a` in [run 34677837699](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34677837699),
which also passed ordinary-owner native channel/server deletion, native purge
and block verification, metadata cleanup and durable status access.

The latter run reached real UI creation of Games, tarkov, minecraft and Gaming
Voice, and both clients received the expected drag/drop order. A nested test
selector failed to find the correctly displayed category. Checkpoint `a554f45`
corrects that selector and uses the actual channel context-menu editor. Full
role-restricted voice/sidebar/reload acceptance is still pending its native run.
The following native run reached the actual private-voice editor and exposed
an erroneous doubled `/api` prefix in its capability request. The same defect
affected private-channel discovery. Both callers now pass API-relative paths;
eleven mounted creation/editor/discovery checks run through the production
`requestApi` wrapper and mocked HTTP responses, and eight policy/writer checks
pass. This fixes the real client request boundary; the full native workflow
still needs its next run.

Repeated direct audio remains under investigation. Several native runs passed
both relay rates and actual synthetic samples in each existing remote playback
stream; others stalled before media flow. The gate now requires three calls,
retains each failure even when cleanup allows independent checks to continue,
and captures finite signaling/description states, gathered relay counts and
numeric ICE errors. Empty browser statistics alone do not establish failed TURN
allocation. An independent allocation control runs after a failed call without
opening a microphone. No SDP, addresses, credentials or audio samples are logged.
Deployed phone/PC audibility and a complete final green workflow remain open.

## Earlier sidebar checkpoint (`a5efbee`)

Final local verification passed the production build, all 629 Node cases and
all 416 browser cases in the complete suite. Eight subsequently added relay
traffic browser cases also passed, as did focused reruns after the final scoped
role-save fix. The Python suite passed 695 cases with 15 platform/environment
skips; the additional category-to-channel voice permission recipe passed its
actual native policy callback test. Compose aliases and diff checks passed.

Checkpoint `a5efbee` passed the GitHub production build, 629 Node cases, all
424 browser cases, the Python suite, GitHub-source Docker image builds, gateway
checks and the independent failed-update rollback proof. The [complete Linux
workflow](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34546152509)
failed: the isolated TURN fixture reached relay byte exchange and failed there;
its subsequent production traffic-helper phase was not reached. The native
embedded conference reported a fatal observation while waiting for connected,
encrypted participants. The workflow intentionally continues after the independent
TURN failure, then restores that failure in its final result guard; its green
intermediate step summary is not a relay pass.

Both native call checks and the user's redeployed phone/PC audio test remain
open. Local browser fixtures do not establish production call success.
See [channel navigation](CHANNEL_NAVIGATION.md),
[channel roles](CHANNEL_ROLE_PERMISSIONS.md), [voice sidebar](VOICE_SIDEBAR.md)
and [TURN diagnostics](TURN_DIAGNOSTICS.md).

## Returning sign-ins and direct-message persistence

The sidebar integration build failure at `d9f76e9` was a missing
`createCategoryRequest` component prop. Checkpoint `2ec42b2` repairs it and passed
the production build locally; its GitHub build and Node stages also passed.
The current local Node suite passed 611 cases. Server organization passed 14
model and nine mounted SDK browser cases; voice sidebar changes passed five model
and 33 related browser cases, with independent lifecycle review. Layout writes
passed four new Node cases and 22 Python role checks including fresh native
revision rejection. These are implementation checks, not deployment acceptance.

The current recovery change passed 14 browser cases using the real Matrix SDK
and Rust/WASM store, 18 security/backup Node cases, and five reminder UI cases.
It reuses only a locally retained key matching the current native backup and
preserves existing target keys and signing identities. Reminder dismissal survives
reload and changes when backup configuration changes. This does not recreate lost
keys or prove recovery of a production account with no remaining keys.

The DM account-data change passed 31 focused account/DM/read-state Node cases.
New DM classification reads the native account-data endpoint, merges and confirms
the saved mapping instead of overwriting it from the SDK's stale cache. Existing
rooms and history are preserved. Matrix account data has no cross-device compare
and swap; precisely concurrent writes can still use last-write-wins semantics.

## Voice channels, roles and current call investigation

Voice channels now have an audio-only entry screen and a persistent call panel with
native membership, avatars, speaking rings and measured media statistics. The
embedded observer reads existing attested participants and tracks; it does not
start another capture or connection. Unknown encryption or missing statistics are
shown explicitly. The role editor now separates appearance, permissions and
assignments, and typed channel creation retains partial setup for retry.
See [voice telemetry](CONFERENCE_TELEMETRY.md), [roles](ROLE_MANAGEMENT.md) and
[channel creation](CHANNEL_CREATION.md) for their implementation limits.

Checkpoint `40b8e17` passed 313 browser tests and the actual isolated
Chromium/coturn allocation, invalid-credential rejection and cleanup. Its native
stack also passed fresh OpenID exchange through both token formats for two ordinary
users and actual public SFU grant validation. The [workflow](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34537124466)
was cancelled by the next push before the complete acceptance sequence finished;
these observed stages are not a full workflow pass or an actual browser call.

Checkpoint `2362894` passed its build and Node tests; its browser stage reported
322 passes and 11 failures in outdated conference fixtures and the initial
telemetry fixture. The updated fixtures exercise current native membership,
iframe document replacement and the mounted voice panel. The follow-up passed
its production build, all 363 browser tests and 556 Node tests. The additional
actual-bundle return regression passed separately after it was added. The full
backend suite passed 691 tests, with 15 platform-specific skips.

The deployed crash was identified as `ReferenceError: return__tavernCallTelemetry
is not defined`. Inserting the telemetry wrapper at the pinned bundle's
`return{` boundary joined the helper name to the JavaScript keyword. The fix
preserves the keyword separator. Its regression examines the actual transformed
AST and executes the returned view expression; it also rejects the former broken
output even though that output is syntactically valid JavaScript.

The fix is on V3 at `c3d4f3d` (functional change in `446728f`). After rebuilding
`tavern-web` and refreshing, the user confirmed the call stays connected for at
least thirty seconds. Earlier token requests returned 200, signaling returned
101, and the embedded client reported encryption enabled. This is confirmed
recovery from the reported crash; two-user audible media and external-network
acceptance remain separate from that confirmation.

A subsequent report came from the separate direct-message call panel:
`connecting` in its header, but native connection `failed`, ICE `disconnected`,
no selected route and zero upload. The administrator's browser TURN test then
obtained a UDP relay candidate. That proves allocation and authentication from
that browser, not delivery between two participants. Direct-call acceptance is
still open; the successful embedded-conference join does not close it.

The updated direct-call panel subsequently reported two local relay candidates
and zero remote candidates. The user later reported a cellular-to-PC direct call
remaining connected without audible audio, while conference calls work normally.
Direct-call media delivery/playback still requires deployed verification.

Two separate defects have regression coverage. The pinned Matrix SDK captures
an incoming call's old TURN array before refreshing the client; the application
now applies fresh credentials through the public peer configuration API before
negotiation. It also checks current account/room ownership and credential expiry.
The header shares native connection observations with the details panel rather
than asserting an established relay while media has failed.

Coturn maps a public relay peer back to its private Docker address before checking
peer permissions. The canonical Compose entrypoint now allows only that exact
current container address while retaining the existing configuration and private
network restrictions. The entrypoint's actual POSIX-shell tests pass. Its Linux
fixture now requires bytes through two relay allocations; the `a5efbee` Linux
execution failed at that exchange phase, so the transport repair remains unconfirmed. The direct-call checkpoint passed its production build, 41 focused
Node tests and the three runtime-shell tests; adjacent presentation browser tests
passed. These checks do not establish audible media on the user's deployment.

The advertised `set_always_on_screen` action now receives the host's response.
Safe active fatal-error details can be copied without raw console logs or tokens.
A new Linux smoke joins both ordinary accounts through the actual embedded UI,
requires complete encrypted participant observations for twenty seconds, and
checks cleanup. It uses synthetic browser devices and an isolated internal SFU
bridge. The [c3d4f3d workflow](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34540840500)
passed 557 Node tests, 363 browser tests, the 691-test Python suite, actual TURN
allocation, the PWA and gateway checks, native startup, administrator setup,
ordinary login, both RTC token formats and grant validation. The isolated failed
update rollback also passed. The new embedded smoke stopped at
`stage=synthetic-devices`, before opening either widget. This is not an observed
two-user conference pass; the synthetic-device fixture is being corrected.

## Drafts, attachment retries, search, appearance and TURN diagnostics

Checkpoint `42aee72` passed its build, JavaScript and browser stages, but
[the complete workflow failed](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34469150619)
before native acceptance: the isolated TURN fixture failed at `port-binding`,
and five invitation tests lacked the fresh-state method now required by the
native role module. The TURN fixture now verifies its owned internal Docker
bridge endpoint directly; invitation fixtures supply the actual state contract
and regressions for concurrent publication migration. Neither fix weakens
production authorization or the required allocation result.

The call-authentication repair uses a private issuer-to-SFU URL and rewrites
only validated responses to the public WebSocket URL. Actual local HTTP tests
cover both token formats, rejected foreign/malformed URLs and separate safe
OpenID/room-creation diagnostics. The new operator diagnostic also tests actual
HTTP and TLS failure, bounded responses, read-only credential validation and
suppression of secret-bearing data. After the additive OpenID migration, the
combined local checkpoint passed 690 Python tests (15 platform-specific skips),
509 JavaScript tests and the production build. Migration checks preserve exact
before-image bytes, call credentials, signing identity and concurrent operator
edits; repeated initialization leaves the repaired configuration unchanged.
The subsequent `40b8e17` Linux run confirmed native token exchange and the
Docker TURN repair as recorded above. Deployed call/media acceptance remains open.

Checkpoint `7ed3da3` passed its production build, all 492 JavaScript tests and all
297 browser tests in [Linux CI](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34410554799).
Its first isolated TURN allocation fixture failed after four seconds; the original
sanitized catch did not identify the stage. The fixture now uses quiet image
pulling to avoid a locally reproduced 64 KiB child-output overflow and reports only
allowlisted stage/status/exit information. That mechanism is not confirmed as the
cause of this run. Allocation remains required; its result is checked after the
independent native stages so those stages can still collect evidence.

The next admin hierarchy slice passed 22 actual HTTP hierarchy/resource tests,
eight mounted hierarchy browser tests and four existing administrator browser
tests, with independent review. Regressions reproduce reciprocal parent/child
path expansion exceeding the view budget, and a streamed room-block request
resuming after logout. Direction-aware paths now remain bounded and the retired
request is denied before native mutation. [Hierarchy scope](ADMIN_HIERARCHY.md)
distinguishes bounded new state reads from the existing native unpaginated member
list and from unavailable storage/activity metrics.

The combined frontend checkpoint passed the production build, 492 JavaScript
tests and all 293 browser tests. Four additional browser tests cover the native
smoke's optional-onboarding dismissal, including a control that disappears during
click stability checks and a persistent unusable control that must still fail.

The checks cover account-owned conversation/thread drafts; encrypted original-file
storage, partial acknowledgements, restart/retry and SDK transaction reuse;
unified encrypted message/file search, bounded loaded people/room inventory and
explicit history indexing; independent appearance density/spacing and responsive
modals; and the mounted admin TURN diagnostic with real SDK credential transport.
Malformed message acknowledgements, stale replacement-session initializers,
foreign homeserver clients and missing TURN credential lifetimes have regressions.
See [drafts](DRAFTS.md), [attachment retries](ATTACHMENT_RETRIES.md),
[search](SEARCH.md), [appearance](APPEARANCE.md) and [TURN diagnostics](TURN_DIAGNOSTICS.md)
for the measured scope and remaining limits.

Controlled transports and RTC boundaries in these local tests do not establish
new native delivery or external TURN connectivity. The workflow invokes a
separate disposable real-Chromium/coturn allocation and invalid-credential check;
successful allocation after the Docker bridge repair was observed in `40b8e17`.

## Responsive modals and encrypted history recovery

Checkpoint `a964dca` [started the complete calls-enabled stack successfully](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34408368894),
including healthy coturn, token issuer and SFU services. All six actual Linux
UID/group policy and call-configuration permission checks passed. The run also
passed isolated backup restoration and failed-update rollback, ordinary account
authorization, encrypted two-user messages/edit/thread/reaction synchronization,
same-device reload decryption, and byte-for-byte recipient attachment decryption.
It then stopped before the later native probes because stored onboarding state
removed **Finish later** while the smoke was waiting to click it. The helper now
bounds that click and requires both hidden onboarding and an accessible workspace
before proceeding. Full native acceptance still requires a passing rerun.

Checkpoint `081fd00` passed the separate SFU Linux workflow and started coturn
successfully in [the assembled-stack run](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34406714380).
That run passed 443 JavaScript and 241 browser tests, then stopped before native
acceptance because the pinned token issuer's health probe interprets its bind
address as a port. Compose now leaves `LIVEKIT_JWT_BIND` unset, allowing the
server and probe to use their compatible defaults. Their assembled-stack startup
subsequently passed at `a964dca`; later native stages remain pending as above.

Checkpoint `8c87c52` passed the complete
[SFU Linux workflow](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34404769133),
including the explicit loopback test configuration and nonroot runtime image.
The separate [assembled application/native stack workflow](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34404769140)
passed its application and browser checks, then stopped before the native probes:
the pinned coturn executable requires a file capability excluded by the service's
empty capability bounding set. Compose now grants only `NET_BIND_SERVICE` to
coturn while retaining `cap_drop: ALL`, `no-new-privileges` and its read-only
filesystem. Corrected calls-enabled startup subsequently passed at `a964dca`.

The combined audio/member-state working tree passed the production build,
443 JavaScript tests, all 240 browser tests and 634 Python checks (12 platform
skips). Native member-state migration covers timeout, temporary ban and server
nickname writers/readers, inherited restrictions, legacy-state precedence and
revision checks. These are local results before the subsequent legacy SFU file
permission repair and native-stack execution.

Checkpoint `5e28eba`, workflow
[34403383712](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34403383712),
stopped in an idle-warning browser test before the native stack started. Moving
the pointer toward **Stay in conference** is itself activity and can dismiss the
warning before the click completes. The test now uses real keyboard activation;
all five affected idle checks pass. No production idle behavior was changed.

Checkpoint `98518af`, workflow
[34401460989](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34401460989),
passed both native history-recovery paths, encrypted system-notice delivery,
recipient-pin refusal, queue/store restart without duplicate sends, and both
SDK history exports. It then stopped at a cancellation-count comparison: the
grouped API omits zero-count statuses, and the test compared against `undefined`.
Checkpoint `5e28eba` uses a zero baseline. Subsequent native stages await that run.

The separate [SFU Linux workflow](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34401461309)
passed at `98518af`: pinned Docker source/patch/hash verification, protocol auth,
eight focused RTC tests, three actual Pion/RTP tests and final binary execution
as UID10001 with a read-only filesystem, no capabilities and no network. A later
test-only correction prevents upstream default STUN attempts; all three RTP
tests passed locally with the explicit loopback configuration. See
[SFU build provenance](../docker/sfu/README.md).

The audio-control working tree passed the production build and 19 focused browser
checks covering the real conference panel, scope and permission controls, account
and call replacement, narrow layout, delayed responses and pending/rejoin status.
The API/native slice passed 91 focused Python checks, with independent regression
review of source-permission preservation, unknown descendant inventory and
authority changes during a request. These sets overlap existing tests and are
not a new full-suite total. The [calls-enabled native CI harness](CI_CALL_AUDIO.md)
requires its next actual Docker/Synapse run; external browser media is separate.

Checkpoint `7f27be3`, workflow
[34399512564](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34399512564),
again passed both real recovery paths and now saved the mounted system-notice
route. A native Space join reached the actual encrypted bot and both owning
browser decryptors. The subsequent history assertion included the bot's own
native membership join as an extra notice. The corrected helper excludes that
state event while retaining encrypted and plaintext messages, with a focused
regression. Independent sender checks confirmed that removing a fingerprint pin
invalidates cached trust before key sharing or sending. Queue restart and the
remaining native workflow stages still need the next run.

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

Email history recovery checks: production build passed; seven new focused HTTP security cases plus eighteen existing account API cases passed; seven WebCrypto/coordinator cases passed; twenty-one focused browser cases passed, including real Rust cached-key migration and new-device recovery UI. These checks do not claim a live SMTP delivery or deployed native email-restore acceptance.

Native calls follow-up: real Chromium/coturn relay transport and the production relay-traffic helper passed in Linux runs at `3da60f6`, `0e11b82` and `051fea8`. The conference fixture needed HTTP WebSocket upgrade forwarding and a dynamic IP range excluding its fixed SFU address; both repairs are now on V3. A subsequent run was interrupted by Docker Hub authentication-connection reset; another exposed five manual-recovery fixture import failures, corrected and locally verified at `21674bd`. These runs do not establish completed native conference or deployed direct-audio acceptance.

The `21674bd` native run reached two real ordinary-account conference connections and held complete encrypted participant observations for twenty seconds, then failed its clean-leave check. Pinned Element Call source confirms that the hangup command is acknowledged before native membership removal. The host now keeps the driver alive for the bounded native leave operation and serializes final membership clearing after pending writes. This connection result does not claim microphone-to-speaker audio delivery; the complete native leave and email-recovery acceptance run must still pass.

At `f379eb2`, the native conference check passed both connection and UI/native leave. The same run passed real same-browser history recovery and fresh-browser native backup restoration with a recovery key. Email verification and package enrollment completed, but the email-device stage stopped before code entry. The shared workspace readiness helper required navigation that an open recovery dialog aria-hides; a browser regression now covers that readiness case without dismissing the prompt. Email-code restoration itself remains pending the next native run. Direct microphone-to-speaker audio on the deployed phone/PC pair remains a separate user acceptance check.

The native stack now also includes a direct-audio acceptance probe. It uses the existing ordinary CI accounts, their actual short-lived Synapse TURN credentials, and the production SDK/call UI. Separate generated runtime files point only to the owned internal TURN bridge and preserve the original production configuration and secrets. The probe requires relay upload/download measurements and actual synthetic audio samples in both existing remote playback streams, then removes its temporary DM mapping and ends the calls. Endpoint/ownership and actual provisioning/restart checks pass locally; the real Docker/audio result is pending CI. No real microphone is used, and no credentials, candidate addresses, or audio samples are printed.

At `f958030`, [native run 34671049568](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34671049568) passed the full email history flow: TLS SMTP verification for the ordinary account, password-protected enrollment, automatic new-device prompt, wrong-code rejection, correct-code restoration of an actual encrypted message, and automatic decryption after the now-known browser signs in again. The native backup and signing identity remained unchanged. Conference connection and UI/native leave also passed again. The overall run later stopped at an empty DM request inbox; a recipient initial-sync assertion now distinguishes persisted sender state from the stripped invitation the recipient actually receives. Deployed phone/PC direct audio remains unconfirmed.

At `f6190e8`, [native run 34671476979](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34671476979) passed actual bidirectional direct audio: both ordinary browser accounts reported TURN relay media rates and both existing remote playback streams contained synthetic audio. Call and temporary DM mapping cleanup passed. Conference connection/native leave, email-code recovery, known-browser recovery, direct invitation review without history/media reads, DM acceptance, recipient mapping after reload, encrypted replies, and decline after reload also passed. The full run later hit the recipient invitation throttle during the separate policy matrix. The derived CI-only Synapse runtime now retains the pinned 0.003/second invitation refill rate with a finite burst of 50 to cover that repeated disposable-recipient matrix; all other throttles and the original production configuration remain unchanged. This run does not establish audible media on the deployed phone/PC pair.

Repeated native direct audio is still an acceptance concern: `f16cc63` timed out
waiting for relay media rates, while the unchanged call implementation passed
again at `0dd7afe` in [run 34674554442](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34674554442).
That latter run also passed conference leave, email/known-browser recovery, DM
persistence and the complete invitation-privacy matrix. It stopped at workspace
readiness before role-mention checks. The probes now capture bounded layout and
transport state on failure and require three consecutive direct calls. Addresses,
credentials and audio samples remain excluded. A crowded full-rail browser test
and the existing readiness/navigation regressions pass; this is separate from
the pending native rerun and deployed phone/PC acceptance.

At `823dc05`, [run 34679476679](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34679476679)
passed native conference connection/leave and two consecutive actual direct
calls with relay media rates and received synthetic audio on both sides. The
third probe failed an ordinary-device prerequisite before placing a call. Its
preflight is now separated into native-room/device proof, synthetic capture,
existing media and TURN credential checks, with finite observations only. The
run subsequently hit the private-editor API prefix defect corrected at `d878de5`.
This is two passed calls, not the required three-call pass or a green workflow.
