# Server and channel implementation report

This report covers the 27-section server/category/channel plan and the subsequent
email-recovery and DM navigation request on V3. It describes implemented behavior
and the remaining acceptance gates. The broader 130-section product brief still
has separate gaps in [the implementation checklist](IMPLEMENTATION_CHECKLIST.md).

## Architecture and main files

Tavern keeps Matrix Spaces as servers and encrypted Matrix rooms as channels.
Categories remain ordered server metadata. The implementation extends the
existing role model, account API, Synapse modules and MatrixRTC/LiveKit session;
it does not create a second membership or call service.

| Area | Main implementation files | Behavior |
| --- | --- | --- |
| Server rail and mobile navigation | [server navigation model](../lib/server-navigation.ts), [rail](../app/server-navigation.tsx), [mobile switcher](../app/mobile-server-navigation.tsx), [workspace](../app/tavern.tsx) | Personal server/folder order, context actions and a separate DM selection. |
| Channels and categories | [navigation model](../lib/channel-navigation.ts), [sidebar](../app/channel-navigation.tsx), [native layout writer](../lib/community.ts) | Ordered categories/channels, full-row drag/drop, exact-position Move actions and saved collapse preferences. |
| Creation and settings | [creation model](../lib/channel-creation.ts), [form](../app/channel-creation.tsx), [native management](../app/channel-admin.tsx), [roles](../app/server-roles.tsx) | Typed encrypted rooms, explicit invitations, same-room partial setup repair and scoped settings sections. |
| Private audiences | [audience writer](../lib/channel-admission.ts), [editor](../app/channel-audience.tsx), [discovery](../app/available-channels.tsx), [catalog API](../api/channel_catalog.py), [native enforcement](../synapse_modules/channel_admission.py) | Selected roles/members govern discovery, native joining and continued membership. |
| Deletion | [UI](../app/room-removal.tsx), [scope review](../api/room_removal_scope.py), [durable workflow](../api/room_removals.py) | Exact-scope, name-confirmed native purge/block with resumable metadata cleanup. |
| Voice sidebar | [membership model](../lib/voice-sidebar.ts), [participant rows and dock](../app/voice-sidebar.tsx), [conference host](../app/conference-panel.tsx) | Native account/device membership plus current call telemetry, without another media connection. |
| Direct calls | [call lifecycle](../lib/calls.ts), [relay configuration](../lib/call-relay.ts), [quality projection](../lib/call-quality.ts), [Compose](../compose.yaml) | Fresh relay credentials, exact peer ownership, corrected coturn self-relay mapping and measured setup/media diagnostics. |
| History recovery | [email coordinator](../lib/email-history.ts), [email UI](../app/email-history-recovery.tsx), [local recovery](../lib/local-history-recovery.ts) | Automatic known-browser key reuse and password-protected history recovery using a verified email code on a new browser. |

## State, persistence and migrations

Personal server order and folders retain version 1 of
`io.tavern.server_folders` account data. Shared category and channel order retain
`io.tavern.server.layout`. Category deletion moves its channels to the root;
it does not delete or recreate their native rooms. Existing room IDs, categories,
keys and memberships stay intact on upgrade.

Layout changes render optimistically, check fresh native/custom authority and
submit the captured previous-event revision. Rejection restores current state
and retains a useful draft. Remote Matrix state updates update connected clients.
New revision-aware layout writers reject stale writes in Synapse; older writers
without that optional field remain compatible. Personal account data still has
last-write-wins semantics for exactly concurrent device writes.

Channel types use existing `io.tavern.channel` state. Private audiences extend
`io.tavern.roles` with `channelAdmissionVersion: 1` and `channelAdmissions`, keyed
by existing room IDs and containing stable `roleIds` and Matrix `userIds`.
The native restricted join rule refers to the reciprocal canonical server.
Invitations cannot bypass an opted-in audience, and multiple governing audiences
must all allow the member. Existing rooms are not opted in automatically.

The provisioner additively enables the durable Synapse membership worker and its
reconciliation tables. The account API adds sealed deletion/progress journals
and an encrypted email-history package table. No migration regenerates deployment
secrets, native signing identities or existing backup versions. See
[V3 migration](V3_MIGRATION.md) for updating the actual deployed stack.

## API additions

The private-channel UI uses the production API client's relative paths. Browser
requests reach these authenticated endpoints with exactly one `/api` prefix:

- `GET /api/channels/admission/capability` checks the running worker's readiness.
- `GET /api/servers/{server}/channels/available` returns a bounded eligible page;
  it does not join rooms or read history.
- The deletion review, confirm, status and continue endpoints are listed in
  [room deletion](ROOM_DELETION.md). A status read never starts a deletion.

Native Matrix state endpoints remain authoritative for role, layout and join-rule
writes. Server/member checks and normal session, device and CSRF checks still
apply. Email recovery uses the existing verified account email and SMTP service;
[history recovery](HISTORY_RECOVERY.md) records its challenge and key boundaries.

## Settings and voice behavior

Channel Overview contains name/topic and appearance, Behavior contains type and
policy, Permissions contains private audiences and role/native permissions, and
Moderation contains member actions. Notifications contains the existing per-room
notification editor, and the channel context action opens that section directly.
Invitations, integrations and reviewed deletion have their own applicable sections.
The owner-only Delete channel context action opens that existing review section;
it does not perform a deletion. Edit visibility uses the same native/custom
permission helper as the editor. The server menu links to existing invitation
privacy controls. All use the existing management helpers.

Selecting a voice channel opens its contextual view. Joining is explicit. Native
MatrixRTC membership supplies the sidebar roster; the current embedded conference
supplies speaking/mic/camera/share observations bound to the same native devices.
Missing telemetry is not represented as muted, inactive or connected. The voice
dock follows that existing session across navigation and disconnects through its
native cleanup path. Empty/expired/departed memberships remove obsolete rows.

The dock now supports self-deafen through an acknowledged local adapter for the
existing receiver tracks and the native microphone API. Restoring playback leaves
the microphone muted. Remote deafen remains unknown when it cannot be observed.
See [voice sidebar](VOICE_SIDEBAR.md) for the exact control and observation scope.

## Verification and remaining gates

Focused model, HTTP and mounted browser coverage includes order/reload, before/
after/root moves, category deletion without room deletion, permission denial,
concurrent revision rejection, account retirement, touch/keyboard Move controls,
narrow dialogs, selected audience creation/edit/retry/discovery and voice lifecycle.
Recent focused checks passed eleven creation/audience/discovery browser cases
through the real API wrapper, three existing native administration browser cases,
eight audience model/writer cases and TypeScript checking. Full-workspace browser
coverage also exercises the channel notification action and three owner settings
open/save/reopen cycles with real SDK room models and controlled native HTTP. There is no separate
lint script in package.json; the production build includes TypeScript checking.

The mounted sidebar also passes a 125-channel, 26-category case: an exact-position
move persists after reload, and thirty unrelated sync updates produce zero React
commits after the initial observation. Its fixture controls the SDK boundary;
this establishes local rendering and ordering behavior, not network latency or
hundreds of live voice participants. All thirteen channel-navigation browser
regressions pass, including mobile Move controls and stale-permission rejection.

The actual isolated Synapse/PostgreSQL/LiveKit gates have passed private audience
admission, invited-join rejection, durable membership removal/regrant and native
SFU authorization. Native ordinary-owner channel/server deletion also passed,
including purge/block, metadata cleanup and saved status access. Actual TLS SMTP
email-code history restoration and subsequent known-browser login passed, as did
DM request acceptance, encrypted replies and recipient classification after reload.

The exact two-user Games workflow is encoded in
[the native acceptance probe](../scripts/smoke-games-workflow.mjs): real UI creation,
drag/drop across two clients, role-restricted voice, live sidebar participants,
movement during the call, clean leave and reload persistence. The complete
workflow passed at `3cc6b62`, after the API-prefix and management-section fixes.
The Linux menu trace identified an opening right-button release landing on an
animated item and triggering an unintended Radix click. Context menus now consume
that release; deliberate primary clicks, touch taps and keyboard selection retain
their normal paths. The exact event sequence failed before the fix and passes
with it, along with the full-workspace editing cases. At `ad5b7e7`, all 449 browser
cases and the complete native Games workflow passed with this fix.

[Direct audio acceptance](../scripts/smoke-direct-audio.mjs) requires three calls,
actual relay media rates and synthetic audio samples in both existing remote
playback streams. It retains failures even when confirmed cleanup permits other
checks to continue. All three consecutive calls passed at `371b91c` and `3cc6b62`, including
actual received audio and owned cleanup on each call. The final complete green
workflow and audible phone/PC media on the deployed host remain open gates. No
synthetic test can prove an unobserved physical microphone or speaker.

At `3cc6b62`, native avatar persistence, encrypted messages/files, email-code
history recovery and known-browser login also passed. The overall run stopped
when a fresh encrypted system-bot notice was unreadable by its recipients.
Offline exact-version matrix-nio to Rust crypto interoperability passes. At
`679bd78`, the full native bot proof also passed on fresh ordinary devices: both
recipients decrypted notices, independent pins blocked unapproved delivery,
queue/store restart produced one confirmed notice, and disabling the route or
adding an outsider stopped further sends. This establishes fresh-device delivery;
it does not explain the earlier failure after the combined media/history workload.

The native repeated-call probe then identified an old incoming invitation replayed
after reload. `c0670f9` retains bounded, short-lived handled call IDs in this tab,
scoped to the native account/device/homeserver, and closes a replayed peer without
sending another hangup. New call IDs remain usable; 28 focused call checks passed.
At `c0670f9`, all three consecutive native calls passed with bidirectional
received audio and cleanup/reload. The same run passed fresh-device encrypted
bot delivery, private audience admission/revocation, native deletion and
conference connection/leave, then stopped at the Games drag/category stage.
The complete native workflow with that fix remains required.

The selected conversation now reads at most three earlier SDK history pages
when its initial sync contains only control events. It keeps undecryptable rows,
coalesces concurrent reads and checks the exact current account, device, room
and timeline before returning results. This avoids an empty conversation after
call activity pushes messages outside the first sync window. Manual pagination
remains available; no background scan of all conversations is introduced.

Email recovery requires a previously enrolled matching backup key; it cannot
recreate older keys lost everywhere. Previously downloaded history cannot be
removed from another device by changing an audience or deleting a server.
Precisely concurrent Matrix account-data writes remain last-write-wins, and
cross-room creation/deletion steps are resumable operations, not one atomic
transaction. [Validation](VALIDATION.md) records exact tested checkpoints and
separates passed stages from failed overall workflows.
