# Internal Synapse account boundary

The Tavern API retains its existing internal Synapse administrator account.
The supported Synapse admin API requires an administrator access token for the
operations below; its documented account model does not provide a practical
per-operation scoped token for this existing stack. Splitting it into multiple
administrator accounts would not reduce each credential's authority. No
speculative authentication mechanism or account rotation is introduced.
See [Synapse admin authentication](https://element-hq.github.io/synapse/latest/usage/administration/admin_api/)
and [user administration](https://element-hq.github.io/synapse/latest/admin_api/user_admin_api.html).

The reviewed call sites are:

| Server-side use | Modules and boundary |
|---|---|
| Bootstrap inventory; verified account recovery | `server.py`: inventory stays private; password recovery requires its verified, expiring challenge and existing factor policy. |
| Finish TOTP enrollment | `server.py`: consumed grant bound to user, initiating session, device, credential epoch and ten-minute reauthentication window; native device deletion targets only that user. |
| Account/media availability and quota checks | `admin_resources.py`, `associated_email.py`, `profile_metadata.py`, `server_eligibility.py`, `rtc_authority.py`, `community_api.py`: bounded native reads; client results expose only the intended metadata. |
| Confirm interrupted account deactivation | `account_deactivation.py`: native status reconciliation for an existing server-side operation. |
| Validate live room authority and calls | `room_authority.py`, `call_moderation.py`: current native state checked against the acting user and room; the client cannot choose an arbitrary admin request. |
| Apply invitation authority | `community_api.py`, `invitation_roles.py`: short-lived creator impersonation for validated invitations, checked against current inviter/room permissions. |
| Authorized room removal | `room_removals.py`: recorded operation, owning session and current authority checks before mutations; private deletion/status APIs. |
| Notification and system-bot eligibility | `push_policy.py`, `push_social_policy.py`, `system_messages.py`: native availability and permission checks before delivery. |

Ordinary instance-admin management uses the authenticated administrator's token
where already supported (`require_admin`), rather than substituting the internal
service credential. Matrix proxy traffic uses only the requesting session's token.

Credentials are encrypted in the API's persistent store; its encryption key and
database need private filesystem/backup access. The internal account is created
only if missing by the existing provisioning routine, normally during setup or
admin sign-in, now also when a reauthenticated user begins their first TOTP setup.
An existing account and its credentials are reused. Credentials are not returned
by session/settings APIs or included in audit events. Upstream errors are sanitized.

The gateway denies `/_synapse/*`; the managed Matrix proxy rejects admin and
managed-credential routes. There is no endpoint for clients to submit an arbitrary
service-account request or retrieve its token. Synapse and PostgreSQL have no
published host ports. Keep that architecture and do not add a public admin proxy.
Tests verify that both ordinary and administrator browser sessions cannot forward
admin-device deletion through the managed Matrix proxy.

An API compromise remains capable of using the stored administrator credential.
Encryption at rest does not contain a running compromised API process. Keep host,
backup and API access restricted; this pass preserves functional compatibility
and explicit server-side authorization rather than claiming token-level scoping.

TOTP start authorizes native device deletion even for an empty device list, so a
later device created while scanning the QR cannot bypass an additional native UIA
stage. The pinned homeserver supports that empty-list request and runs UIA before
deletion; see [Synapse v1.160.0 device handling](https://github.com/element-hq/synapse/blob/v1.160.0/synapse/rest/client/devices.py).
