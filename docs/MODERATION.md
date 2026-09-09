# Moderation

Tavern checks native Matrix permissions and the current server role hierarchy. An instance administrator does not automatically gain moderation authority or encrypted history in a room. Moderation actions use the signed-in moderator's Matrix session; the account gateway's service account only reads room state to check authority.

## Temporary bans

Open a member's profile in the relevant conversation or server, then use **Temporary bans**. Review the current restriction, choose a duration, enter a reason and type the full member ID to confirm. The interface offers one hour, 24 hours, seven days and 28 days. The API accepts whole seconds from one minute to 28 days.

The deployed Synapse module enforces an `io.tavern.tempban` state event keyed by the affected member. Each write or admission attempt is checked against the deadline using server time. A restricted member cannot send messages, reactions, new call participation or state changes, and cannot be invited, knock or join before expiry. Self-leave and teardown of their existing call remain possible. These checks apply to direct Matrix clients as well as Tavern. Redacting the restriction cannot lift it; a moderator must explicitly update it.

Tavern first writes the restriction using the moderator's own session, then attempts a native kick. These are separate operations. If removal fails or the homeserver does not confirm it, Tavern displays that the restriction is active but the member may still read the room. No privileged moderator token is retained for a future unban job.

A temporary ban in a managed server is inherited by its reciprocal, canonical child channels. It prevents writes and admission there, but does not remove existing child-channel memberships or revoke already readable history. Remove the member from those channels separately where necessary. Existing media connections require the call moderation controls; the temporary restriction is not a forced SFU disconnect.

After expiry, normal room admission rules apply. Expiry or lifting does not automatically invite or rejoin the member and never removes a permanent Matrix ban. If another moderator changed the restriction since it was reviewed, Tavern requires a fresh review before submitting again.

Temporary-ban reasons are room state and are visible to people who can read that state. Use the private warning inbox for sensitive details. The private instance audit records actor, target, scope, expiry and an unconfirmed-removal outcome without duplicating the reason. The server audit also displays the native restriction events.

## Warnings and timeouts

Private warnings appear in the member's warning inbox, with read and withdrawal status. Warning reasons are encrypted at rest in the account gateway and accessible only to the recipient and currently authorized moderators. A warning does not change access by itself.

Timeouts prevent posting and new call participation until expiry while retaining membership. Permanent bans use native Matrix ban membership and require an explicit unban. Neither action can undo content that a member already received.

## Verification

`tests/test_temporary_bans.py` exercises server-clock expiry, hierarchy, canonical parent inheritance, direct-client admission and state-write restrictions, protected redaction, stale revisions, ordinary moderator token use and partial membership failure. Browser regressions cover typed confirmation, partial result display, lifting and stale-review recovery. Composer tests cover room and inherited restriction hints.
