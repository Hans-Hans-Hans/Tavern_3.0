# Private discussions

Private discussions are separate encrypted Matrix rooms shown beside their source
conversation. Public Matrix threads continue to use native `m.thread` relations.
This feature does not make selected replies inside a public room private.

## Use

1. In an encrypted channel belonging to a Tavern server, open channel details and
   expand **Private discussions**. The same control is available in a public thread.
2. Select **Create private discussion**, enter a title and choose current source
   members. An optional source-message link is recorded without copying its body.
3. Invited members explicitly accept the invitation. Members receive messages from
   when they join. Existing messages are not automatically shared with new members.
4. Open discussion settings to view joined and invited members, invite eligible
   source members, change notification settings, or leave the discussion.
5. Authorized members can remove a lower member after typing their Matrix ID.
   Leaving also requires a typed confirmation. Titles and archive settings use
   revisions: a conflicting change preserves the draft until explicit reload.

The sidebar's **Private discussions** button lists your own joined discussions and
invitations, including those whose source channel you have left. Saved messages,
search results and message links open the same private panel. Attachments and
drafts use the existing encrypted Composer. A historical link can load its target
message; it does not automatically load all surrounding history.

The server owner can grant **Create private discussions** in server roles or
category/channel overrides. Existing roles do not silently gain the permission.
The creator must also have current native Matrix and Tavern posting permission in
the source. Invitations require native and Tavern invitation permission. Invitees
must currently belong to the source channel and all its canonical Tavern servers.
Timeouts, temporary bans and membership changes are rechecked by Synapse.

Private native room powers remain an additional ceiling. The creator has the
standard room creator authority; other members are not automatically promoted.
For example, someone with server moderation permission who has never been invited
cannot join or read the private room. A creator without the source's native and
custom removal authority cannot remove members merely because they created the
private room. There is no privileged bot or background service joining these rooms.

## Privacy and membership

Messages and attachments use the existing Matrix SDK encryption path. Private
rooms are local, non-federated, invite-only and use immutable `joined` history
visibility. The module rejects public-directory publication, guest access, room
upgrades, history widening, encryption removal and parent/child links. The source
channel receives no private-room index, member list, title or copied message.

Titles, membership, archive settings and source identifiers are ordinary room
metadata visible to invitees and the homeserver; they are not message ciphertext.
Discoverable discussion lists come from the signed-in user's own joined/invited
rooms, rather than a platform-wide catalog.

Source membership and permissions restrict new invitations and writes. They do
**not** replace native private-room membership as the reading boundary. Removing a
member from the source does not automatically kick that member from existing
private rooms. An authorized member must remove them in each private discussion
to stop future private-room access. Messages and encryption keys already received
cannot be recalled. Self-leave remains permitted even after source access is lost.

No broad per-role historical-read feature is implied. These rules also cannot
prevent an authorized recipient from copying information they can read.

## Protocol and enforcement

Room creation uses the user's native Matrix `createRoom` request. The immutable
`m.room.create` event contains:

```json
{
  "type": "io.tavern.private_thread",
  "m.federate": false,
  "io.tavern.private_thread": {
    "version": 1,
    "source_room_id": "!source:example.org",
    "source_event_id": "$optional-source-event"
  }
}
```

`source_event_id` may be empty. A supplied event must be an actual message event
in the source room. No source content is copied. Client checks improve error
messages; native Matrix authorization and the Synapse module enforce writes.

`io.tavern.private_thread.settings` has state key `""` and contains `version:1`,
`title`, `archived`, `autoArchiveSeconds`, and `io.tavern.previous_event`. The first
revision is `null`; later writes must cite the current settings event ID. Synapse
sets `updatedAt` and `activityStartedAt` using server time. Supported inactivity
intervals are never, one hour, one day, three days and one week. Authorized explicit
reopen resets inactivity. Merely editing a title does not postpone auto archive.

The module validates current source membership, reciprocal canonical parent links,
each parent's role policy and authoritative category layout. Missing or malformed
context fails closed. Native source powers and native private-room powers both
apply. The source's slow-mode ledger is shared by source and private sends, so
creating another private discussion cannot bypass its per-user cooldown.

Message ciphertext is opaque to the server. Archive restrictions apply to every
encrypted event in the private room. Native reactions and pins are additionally
checked against actual encrypted events in the same private room, bounded input,
archive state, source custom permissions and both rooms' native powers. Sensitive
state cannot be removed through redaction. Native room power changes are frozen
after creation; there is no implicit privilege escalation for server moderators.

Room creation and its invitations are separate native Matrix operations. If an
invite becomes ineligible while the room is being created, the Matrix request may
fail after creation or after another invite succeeded. Any resulting room remains
private and can be found through the creator's synced joined rooms. Inspect the
actual member list before retrying an invitation.

## Validation

- `tests/test_private_thread.py` exercises the actual TavernPolicy callback with
  native/custom membership and power fixtures, canonical parents/categories,
  immutable privacy, invitations, removal hierarchy, revisions, server-time archive,
  shared slow mode, reactions/pins and unchanged public threads.
- `tests/private-threads.test.mjs` checks current-state client gates, bounded reads,
  discovery, session changes, source-free creation payloads and draft preservation.
- `tests/browser/private-thread.spec.ts` exercises the actual React launcher/panel
  with a Matrix fixture, including create/send, invitations, archive conflicts,
  typed removal and controls disappearing after permission changes.
- `tests/browser/private-workspace.spec.ts` mounts the actual workspace and
  Composer to check private navigation, invitation acceptance, attachment scope,
  delayed sync, historical links and discovery after source departure.
- Live multi-user Matrix/E2EE acceptance is maintained separately in
  `scripts/smoke-private-discussions.mjs`, called by `scripts/smoke-live.mjs`;
  fixture tests alone do not prove live network encryption.

The implementation follows Matrix [room history visibility](https://spec.matrix.org/latest/client-server-api/#room-history-visibility)
and uses Synapse's documented [third-party rules callbacks](https://element-hq.github.io/synapse/latest/modules/third_party_rules_callbacks.html)
for creation, events, third-party invitations and directory visibility.
