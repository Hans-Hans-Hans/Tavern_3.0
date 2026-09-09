# Native moderation state keys

Stable Matrix room versions reserve a state key beginning with `@` for that
account's own event. A moderator's power level does not grant permission to use
another member's `@user:server` state key for a custom event. The pinned Synapse
1.160.0 check is in
[`event_auth.py`, `_can_send_event`](https://github.com/element-hq/synapse/blob/v1.160.0/synapse/event_auth.py#L894).
Native `m.room.member` events have separate membership authorization; this
change does not replace or weaken it. Stable room version 12 retains this
reservation in its
[room-version definition](https://github.com/element-hq/synapse/blob/v1.160.0/rust/src/room_versions.rs#L300).

Tavern writes `io.tavern.timeout`, `io.tavern.tempban`, and
`io.tavern.server.nickname` using `_user:server`. Only the first sigil changes,
so distinct full Matrix IDs remain distinct and the native 255-byte UTF-8 limit
does not grow. Native hierarchy and current custom-role checks always use the
decoded full `@user:server` identity. State paths are URL encoded normally.

Existing deployments do not need a privileged rewrite or membership migration:

- If only a legacy `@user:server` event exists, readers keep its current effect.
- If a canonical `_user:server` event exists, its presence wins, including an
  explicit clear. Old state cannot reappear because its timestamp is newer.
- Malformed canonical restrictions do not fall back to permissive legacy state.
- A first canonical write must name the observed legacy event in
  `io.tavern.previous_event`; subsequent writes must name the canonical event.
  Missing and stale revisions are rejected. This now applies to timeout writes
  as well as temporary bans and nickname edits.
- New legacy-key moderation writes are rejected. Old clients must reload the
  updated application. Legacy events remain available in history and audit.

Deploy the web application, account API, and provisioned native policy modules
together. The provisioner copies the new `member_state.py` with the other policy
modules. A rollback to an old reader would ignore newly canonical restrictions;
do not roll back only the native module or API while retaining this schema.
This migration changes moderation state publication, not past content access,
room membership, encryption, or active media connection behavior.

`tests/test_member_state.py` covers identity bounds, legacy/canonical precedence,
revision conflicts, hierarchy, and actual module filtered-parent reads. The
temporary-ban HTTP tests, client tests and nickname browser test cover real
publisher/reader migration. `scripts/smoke-member-moderation.mjs` is a standalone
native CI probe for ordinary moderator writes, role and hierarchy denials,
inherited child restrictions, stale revisions, and redaction protection. It
requires the exact isolated CI origin and supplied admin/Alice/Bob owning
sessions; it creates fresh marked fixtures and restores invitation preferences.
It does not require calls enabled. Local portable tests validate its guards;
native acceptance requires running it against the built Synapse stack.
