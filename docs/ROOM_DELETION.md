# Permanent channel and server deletion

The native server owner can open **Server settings → Delete server**, or
**Channel details → Delete channel**. The review lists every affected room and
the joined/invited membership count. Typing the exact name confirms the scope.
A server deletion removes its listed local channels first and the Space last.
Direct messages, nested servers, federated rooms and channels shared with a
different server are excluded from a server cascade. Delete or detach them
separately before reviewing again.

The account API proves ownership from the immutable native Space creator,
current membership and current role policy. Each review records the relevant
native state revisions and expires after ten minutes. Confirmation rechecks
the whole scope, then claims exactly those room IDs. A second overlapping
deletion cannot start. Each later destructive step checks ownership and parent
links again; adding another channel never silently expands a confirmed scope.

Synapse's durable v2 shutdown-and-purge task blocks the room, removes its
memberships and purges local room history without force-purging remaining local
users. Tavern creates no replacement rooms. A successful task acknowledgement
is not completion: the API requires native room absence and a native block,
then removes the stale audience, overrides, layout row and parent link. Other
channels, category definitions and role assignments stay intact. Confirmed
deletions deny new RTC grants and the existing RTC lease checks remove access.
Downloaded device history and separately retained backups cannot be erased by
deleting a room on the server.

Keep the panel open to advance the approved steps. Closing it stops further
browser requests; a native task already submitted continues. Reopen the panel
or **Account & security → Server and channel deletions** to resume. Status
refreshes alone do not submit deletions. A lost acknowledgement is reconciled
by exact native room ID before a retry. Ownership changes, added children,
failed native tasks or incomplete metadata cleanup remain visibly paused. If
native shutdown removes the owner's Space membership but a purge then fails,
an instance administrator may need to finish the native task before the owner
can confirm completion.

The additive account database tables `room_removals` and
`room_removal_claims` retain the sealed review/progress journal and overlapping
request claims. No existing rooms are migrated or deleted on upgrade. Update
the API, web and provisioned Synapse modules together.

Routes require the current account session; mutations retain normal origin,
CSRF and device checks:

- `POST /api/rooms/{room}/removal-review`: read-only native scope review.
- `GET /api/rooms/{room}/removal`: latest owned request for the room.
- `GET /api/room-removals`: up to 100 owned confirmed requests, unfinished first.
- `GET /api/room-removals/{id}`: saved progress, accessible after native removal.
- `POST /api/room-removals/{id}/confirm`: exact name and current scope confirmation.
- `POST /api/room-removals/{id}/continue`: advance that approved request;
  explicit `retry: true` resumes a paused request after reconciliation.

HTTP tests cover ownership, scope changes, overlapping claims, lost replies,
service recreation, incomplete native results, logout during authorization,
metadata failures and child-first ordering. Mounted browser tests cover name
confirmation, close/account changes, honest progress, saved status and narrow
screens. `smoke-room-removal.mjs` uses only three fresh immutable-marked rooms
and the ordinary CI owner on the exact isolated native stack; its actual native
result must pass before claiming end-to-end deletion acceptance.
