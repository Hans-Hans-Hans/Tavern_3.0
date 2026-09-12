# Friends and friend codes

Open **Direct messages → Friends**. Share your code with someone who has an
account on the same Tavern, or paste their code into **Friend code**. A code
looks like `TAV-XXXX-XXXX-XXXX`; spaces, dashes and letter case are ignored.
The recipient chooses **Pending → Received → Accept**. Sent requests can be
cancelled. Friends can message, remove or block one another from this screen.

The server field is optional and defaults to this installation. Full Matrix
account addresses continue to work. This deployment does not enable federation:
a different installation's address is rejected with an explanation. Codes do
not provide global account discovery or bypass that boundary.

**Copy code** shares a contact identifier, not a password or recovery key.
**Replace code** requires confirmation and invalidates the old code for new
requests. Existing friends and requests remain. Knowing an account's full
address still permits a request subject to that account's privacy settings.

Privacy settings apply equally to codes and full addresses. Blocking updates the
native Matrix ignore list. Adding or removing a friend does not grant access to
servers, join conversations, erase history or change encryption keys.

## Deployment and storage

Rebuild both `tavern-api` and `tavern-web` from the same V3 revision using your
existing Compose files/profiles. Keep the API data volume: codes survive reloads,
logins and container replacement because they are stored in that database.
No new environment variable, external discovery service or secret is required.

Startup adds the `social_friend_codes` table if absent. One indexed unique code
is allocated per account on first access. The additive schema keeps existing
relationships and supports reopening an existing database. Account deactivation
removes the account's code. Codes are shareable identifiers stored in the API
database; normal database backup and access protections apply.

`GET /api/social` includes only the requesting account's `friendCode` alongside
its existing relationship snapshot. `POST /api/social/requests` accepts a code
or full account address in `target` and an optional `server` address.
`POST /api/social/friend-code` replaces the owner's code only when `previousCode`
matches the current code. Session/device and origin checks apply; replacements
are limited to five per hour, requests to ten per five minutes. Requests also
retain existing capacity, privacy, block and resend limits.

Codes use 12 cryptographically random base-32 characters. A database uniqueness
constraint prevents reassignment on collisions. Rotation is checked again after
awaited profile lookup so an in-flight request cannot use a revoked code.
Audit events record replacement without recording the old or new code.

The client retires drafts, pending confirmations and late responses when its
account/device changes. It also preserves a new draft typed while a previous
request is being delivered. Code replacement never changes history recovery.
