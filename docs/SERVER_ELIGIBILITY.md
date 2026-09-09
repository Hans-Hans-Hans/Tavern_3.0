# Server account requirements

Server owners can require a verified Tavern email address and a minimum native
account age before an account joins or participates. Age choices are off,
5 minutes, 1 hour, 1 day, or 7 days. Both settings default to off; existing servers
without this state keep their previous behavior.

Email verification comes from the current account-service record established by
the existing email verification flows. A browser assertion, profile field,
associated but unverified email address, or native third-party identifier does
not satisfy this rule. Account age comes from Synapse's native registration
timestamp, not the date an old account first signed in through Tavern.

## Enforcement and recovery

The Synapse module checks direct Matrix requests as well as Tavern requests.
Enabled requirements apply to server and channel joins, invitations and later
activity, including encrypted messages, reactions and call membership. Each
reciprocal canonical parent server contributes its requirements. A one-sided
parent claim cannot impose another server's policy. Private discussions inherit
the requirements of their immutable source channel and its servers; creation
checks run before the private room is created.

The native Space creator can repair or disable eligibility settings without
satisfying that Space's requirements. Other administrators receive no account
eligibility exemption. Configuration writes still require current membership,
native state authority, and `manage_server` in a valid managed server role
policy. A roleless Space permits only its native creator to configure this
setting. This policy adds restrictions and never grants native Matrix powers.

A member can always leave. Existing call-membership cleanup must belong to the
sender; ending a call cannot depend on email verification or the availability of
the account service. Private discussions continue to prohibit call events.

Malformed enabled settings and unavailable authority fail closed. A user's own
native error explains whether they need to verify their email, wait for the
configured account age, retry after changed state, or retry when verification is
available. An inviter receives a generic eligibility error about the recipient.
No email address appears in these errors.

Call admission uses `api.server_eligibility.require_room_eligibility` alongside
native membership, native call power, server roles, channel policy and managed
session checks. The gateway also reapplies this rule during its existing active
admission checks. Removal of an already connected participant follows the
bounded reconciliation and outage limitations in [RTC authorization](RTC_AUTHORIZATION.md);
changing a setting does not synchronously eject every active call.

This is an admission and participation policy. Enabling it does not remove
existing room memberships, erase history, revoke already downloaded data or
keys, or prevent existing members from reading history permitted by native
Matrix membership. It does not inspect encrypted messages, classify attachments,
or provide an explicit-content filter.

## State and internal protocol

The protected state event is `io.tavern.server.eligibility`, with an empty state
key and exactly these fields:

```json
{
  "version": 1,
  "requireVerifiedEmail": true,
  "minimumAccountAgeSeconds": 3600,
  "io.tavern.previous_event": null
}
```

Every edit must replace `io.tavern.previous_event` with the current event ID.
`null` is valid only for the first write. Invalid fields, unsupported ages,
non-Space/federated destinations, stale revisions and policy redactions are
rejected. Protected parent relationships must be changed in place by the owner;
redacting them cannot strip eligibility enforcement.

Synapse reads `GET /api/internal/server-eligibility?user=<MXID>` over the private
network. The existing provisioned 32-byte privacy key signs the newline-separated
payload `v1`, `server-eligibility`, Unix timestamp, and the exact Matrix ID using
HMAC-SHA256. Headers are `X-Tavern-Privacy-Timestamp` and
`X-Tavern-Privacy-Signature`. The API accepts a 30-second timestamp window and
returns only `{available, emailVerified}`, with `Cache-Control: no-store`.
The domain separator differs from invitation consent. Responses are fresh
database reads; signatures never turn a cached eligibility result into authority.
Missing companion records remain unverified without creating new personal data.
Account restrictions and pending/completed deactivation journals deny availability.
Call admission also checks native deactivation, guest, locked and suspended flags
independently of these optional server requirements.

Synapse's bridge request is bounded to five seconds and never allows on failure.
The policy rechecks native account availability, the current room's policy and
canonical parent set, and current parent state after the account lookup. It
preserves a proposed parent event that has not yet persisted, and rejects a
private discussion whose immutable source differs from the observed binding.
Private creation preflight rereads the source before a private room exists.
Settings edits also recheck the current revision, membership, native power and
custom management permission after verification awaits.
The API adapter also rechecks local account availability and
verification synchronously after its final native lookup. These checks do not
claim an atomic transaction across the account database and Matrix state.

Provisioning already installs all module files and provides the shared privacy
key; this feature needs no new public endpoint, secret, or port. The account
service registers the internal route automatically. Upgrade the account service
and restart Synapse to load the updated module before enabling requirements.

## Validation and compatibility

Focused tests cover the native callback, strict state authorization and revision
checks, direct join/post/call attempts, every canonical parent, private-source
inheritance, owner recovery, teardown, protected redactions, native age boundaries,
malformed or unavailable authority, and changes during awaited checks (including
own-Space policy changes, a newly added parent, private source changes, and
revocation of an editor's membership or native/custom authority). Actual
aiohttp tests exercise the signed internal endpoint and native-admin adapter;
they check current email records, deactivation and access restrictions, exact
native identity, and rejection of millisecond timestamps on the seconds-based
single-user endpoint. Live isolated Synapse/RTC acceptance remains to be run for
this slice; mocked native HTTP results are not media-call evidence.

The implementation is pinned to Synapse 1.160.0. Its public
[`get_userinfo_by_id` module API](https://github.com/element-hq/synapse/blob/v1.160.0/synapse/module_api/__init__.py)
returns native `UserInfo`; its `creation_ts` uses seconds. The API adapter uses
the [single-user admin endpoint](https://element-hq.github.io/synapse/latest/admin_api/user_admin_api.html#query-user-account),
whose timestamp also uses seconds. The paginated users endpoint uses milliseconds
and is deliberately not used. The pinned
[event callback dispatcher](https://github.com/element-hq/synapse/blob/v1.160.0/synapse/module_api/callbacks/third_party_event_rules_callbacks.py)
preserves `SynapseError` so the module can provide actionable native errors.
