# Channels and categories

The server sidebar uses the existing `io.tavern.server.layout` category and channel arrays as its saved order. Renaming categories never sorts them alphabetically. Members see only channels supplied by the current joined-room inventory; category organization does not grant room access.

Server folders and personal server ordering keep the existing version-1
`io.tavern.server_folders` account-data format. Updates read and merge fresh native
data, retain pending local moves after a rejected save, and confirm persistence.
The mobile sidebar's **Servers and folders** dialog exposes the same saved order
and Move actions. Existing IDs, category assignments, room memberships and keys
remain intact; no database migration or new API endpoint is required.

Members with native layout authority and the applicable `manage_channels` permission can create, rename and delete categories. Deleting a category moves its channels to Uncategorized, retaining the rooms and messages. Category permission boundaries still use the existing owner checks. The category menu opens the specific editor instead of embedding another copy of all server settings.

Drag a full channel row before or after another row, onto a category, or onto Uncategorized. Categories can be moved before or after each other. Drop indicators show the position, collapsed categories expand temporarily while a channel hovers, and the scroll container moves near its edges. Dragging suppresses navigation clicks. The row action menu and Move dialog provide the same exact positioning for keyboard and touch users.

Changes appear optimistically, then the writer fetches native state and checks current membership, power, role authority and the captured layout baseline. It sends the native previous-event revision. Rejection restores the current layout and retains the dialog draft. A changed account, device, homeserver, server object or concurrent layout retires obsolete work; unrelated sync activity does not close an editor. An already submitted native request can still complete, so the UI never retries an ambiguous layout write automatically.

The updated Synapse module rejects a new writer's stale
`io.tavern.previous_event` layout revision. Category placement during channel
creation uses the same revision field. Legacy writers without that optional field
remain compatible; this is not a universal compare-and-swap guarantee. Personal
Matrix account data also remains last-write-wins for precisely concurrent device
writes. Recreate/restart Synapse with the updated module to enforce the new check.

Collapsed headings aggregate unread and highlight counts from visible, unmuted channels; highlights overlap unread counts. Category read/mute/all actions remain personal controls. Channel icons follow actual channel kinds, with custom appearance icons taking precedence. Existing parent callbacks own channel creation, edit and invitation flows. Voice channels accept the separate participant roster component without creating another media connection.

Validation: four pure ordering tests and mounted browser coverage exercise saved order/reload, full-row before/after/root moves, category dialogs and retained channels, rollback, account-generation changes, permission revocation, hover expansion and personal unread aggregation. The browser fixtures use real components and layout helpers with an explicit SDK transport boundary; they do not claim native deployment or media acceptance.


## Remaining sidebar requirements

Channel and server management now include a reviewed, resumable permanent
[deletion workflow](ROOM_DELETION.md), with recovery from partial native removal
and metadata cleanup. The ordinary-owner deletion gate passed against actual
Synapse/PostgreSQL in [run 34677837699](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34677837699). The
pinned conference widget's self-deafen limitation is recorded in
[voice sidebar](VOICE_SIDEBAR.md).

The full two-user Games-category acceptance sequence, including a role-restricted
voice join and cross-client ordering after refresh, remains a deployed acceptance
gate in `scripts/smoke-games-workflow.mjs`. Component, native write-boundary and policy tests are recorded separately
from that gate in [validation](VALIDATION.md).

## Role-managed private channels

Owners can select allowed roles and individual server members during channel
creation or under channel settings → Permissions → Private channel access.
Members use **Browse private channels** to discover eligible channels and join
one explicitly. Listing channels never joins a room or fetches message history.
The server owner retains access; selecting nobody makes the channel owner-only.
Private discussions still require their separate invitation.

The existing `io.tavern.roles` state has optional `channelAdmissionVersion: 1`
and `channelAdmissions`, keyed by existing native room IDs. Each audience holds
stable `roleIds` and full Matrix `userIds`. Role assignments stay in the existing
member map. No existing room is opted in automatically. Native room IDs, keys,
category assignments and downloaded history are preserved.

The owner first saves the selected audience against the native role-event
revision, then changes the channel to a native restricted join rule referring
to its reciprocal canonical server. Synapse checks the actual audience on both
ordinary joins and invited joins; an invitation cannot bypass it. Multiple
governing private audiences must all allow the member. Changing role assignments
denies new events and SFU admission immediately. A durable Synapse worker removes
ineligible native memberships and bound private-discussion memberships, while
the existing RTC lease worker ends ineligible SFU sessions. Previously downloaded
history cannot be erased from another device.

Partial saves retain the same room and expose a retry. Removing audience-based
access first restores invite-only joins. New native policy writes reject stale
revisions and retain the version marker. Existing clients can read rooms; clients
that omit the required revision cannot overwrite an opted-in policy.

The provisioner enables the worker additively and preserves existing deployment
secrets and signing identity. It adds four durable reconciliation tables in the
Synapse database, rebuilt/reconciled from native state on startup. Update/recreate
init, Synapse, API and web together. The UI requires the running Synapse worker's
readiness, exposed internally at `/_tavern/channel-admission` and checked through
authenticated `GET /api/channels/admission/capability`. Authenticated
`GET /api/servers/{server}/channels/available` checks current server membership
and returns at most 25 eligible channel entries per page without history.

Validation includes native policy and durable SQLite worker tests, real API HTTP
tests, role/creation writer tests and mounted browser creation/edit/retry/join
tests at a 320px width. `scripts/smoke-channel-admission.mjs` adds the actual
Synapse/PostgreSQL/LiveKit admission and membership-removal acceptance gate;
it passed against actual Synapse/PostgreSQL/LiveKit in
[run 34674781269](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34674781269)
and repeated in run 34677837699. The checks include denied invited joins, actual
role removal, worker reconciliation, regrant and SFU admission. Target-host
acceptance remains separate.

## Direct messages

Direct messages have a dedicated speech-bubble button in the server rail and a Direct messages choice in the mobile server switcher. The section contains individual and group DMs, their favorites, drafts and unread counts. Server and All channels views contain channels only. Opening a DM from a profile, search, message request or room link selects Direct messages; selecting a room updates the URL so refresh can reopen it. An empty DM section offers New message and Notes to self. This changes navigation only; native rooms, membership and encrypted history are preserved.
