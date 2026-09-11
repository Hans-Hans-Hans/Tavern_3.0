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
