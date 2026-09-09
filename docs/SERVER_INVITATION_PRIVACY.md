# Invitations from server members

Open **Contacts → Privacy → Invitations from server members** to restrict new
invitations from people who share a server with you. Each joined server offers
**Use global preference**, **Accepted contacts only**, or **Block new invitations**.

The global invitation setting still applies. If two people share several servers,
every applicable restriction must allow the invitation. A permissive server cannot
override a block or the global policy. These rules cover all new Matrix room and
Space invitations, including direct and group conversations; an inviter's
`is_direct` flag or claimed parent does not confer permission. They leave existing
memberships and history intact.

## Current membership and storage

Synapse enforces these settings using the recipient's native `io.tavern.privacy`
account data. The optional `serverInvitations` map contains up to 200 actual Space
IDs mapped to `contacts` or `nobody`; omitted entries inherit the global policy.
Both legacy IDs and native room-version-12 hash IDs are supported. A valid ID
shape does not establish membership; the same native Space checks apply.
A restriction applies only while both people are actually joined to that Space.
Leaving a server does not erase its saved preference. The editor allows removing
departed-server entries; new or changed restrictions require current membership.

The native policy checks current ignored users, global preferences, actual shared
Space membership and, when required, accepted Tavern contacts. Invalid settings
or unavailable authorization data deny the invitation. Bounded state scans and
whole-operation deadlines prevent indefinite native waits. The API uses only the
recipient's session to inspect their joined Spaces and to read or write their
account data.

`GET/PUT /api/social/server-invitation-privacy` uses a revision of the saved server
map. Both global and server settings serialize managed writes for the same account
and recheck the native document before saving. Unrelated native fields are
preserved. Conflict responses retain the edited draft; **Reload server invitation
preferences** explicitly replaces it. An invalid saved map requires the explicit
replacement action. Account/session changes discard the previous owner's pending
responses and unsubmitted draft.

Native account data has no cross-device conditional-write transaction. Preference,
membership and contact checks also span separate native/API reads. The checks
detect observed changes and fail closed; they cannot guarantee atomicity against
every concurrent write by another client or retroactively recall an accepted
invitation.

## Verification

Native/API regressions cover real shared Spaces, contacts, multiple restrictions,
invalid maps, immutable global restrictions, stale writes, departed-server cleanup
and changes during awaited checks. Browser fixtures run the real editor and API
helper, including rejected draft retention, explicit reload/repair and replacement
accounts. These controlled checks do not establish live multi-device acceptance.
