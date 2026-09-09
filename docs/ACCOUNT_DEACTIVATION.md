# Account deactivation

Open **Tavern settings → Account & security → Delete my account**. Enter the current password, any configured second factor, and the exact full Matrix user ID. The optional **Request removal of profile information** checkbox passes Synapse's `erase` option. It does not request deletion of historical messages or uploaded files. Instance administrators must use another active administrator for account deactivation; Tavern's service account is protected.

After authorization, Tavern writes a durable operation record and revokes local sessions and unfinished sign-ins before sending the native deactivation request. The browser signs out and preserves the outcome message and operation reference.

| Outcome | Meaning and recovery |
| --- | --- |
| `complete` / HTTP 200 | Synapse's account detail reports this exact user as deactivated, and Tavern's personal-data cleanup committed. |
| `pending` / HTTP 202 | The native outcome is unknown or still active. Tavern access stays locked; a timeout, invalid token, or malformed HTTP 200 is never proof of deactivation. |
| `native_confirmed` / HTTP 202 | Native deactivation was confirmed, but local cleanup needs another attempt. Cleanup is atomic, so a failed transaction does not leave a partly deleted local account. |
| `rejected` | The native authentication flow requires unsupported additional steps. No deactivation was submitted through that flow; the pending restriction is released, but the user must sign in again. |

The API checks outstanding operations at startup and every 30 seconds, with bounded retries and backoff for each operation. Recovery only reads native account state and retries local cleanup. It never repeats a destructive native request automatically and does not persist passwords, second factors, tokens, email addresses, or message content in the journal. The minimal operation reference and progress record remain for recovery and auditing; there is no automatic journal expiry.

An administrator can inspect the reference and phase in **Users → user details**. If the native account remains active, **Deactivate account** is an explicit, separately authenticated retry that preserves the original profile-erasure choice. Pending operations cannot be bypassed with Enable or profile/access edits. After completion, explicit administrator reactivation requires a new password and does not restore deleted Tavern personal data.

Cleanup removes the local account, sessions, challenges, recovery codes, social preferences, incoming/outgoing contact requests, the user's own block records, and personal invitation redemptions. It revokes and scrubs invitations created by the user and invitations addressed to their verified email. Invitation capacity is not refunded. Other people's blocks, moderation reports, warnings, audit records, historical messages, uploaded media, and existing backups remain. Media usage and uncertain upload reservations remain charged because the files are retained.

Session and invitation checks run again after asynchronous work. Delayed privacy requests, uploads, invitation redemption, and registration responses cannot recreate removed personal records or publish a stale session. Session issuance also checks the account's security and deactivation revisions, including completion followed by explicit reactivation.

Validation: 54 focused Python tests passed in the independent review, and all four original HTTP reproductions now fail closed: delayed privacy, ambiguous native success, delayed invitation authorization, and delayed registration. Account/admin/auth browser regressions also passed. The final isolated CI probe, `scripts/smoke-deactivation.mjs`, passed against real Synapse in [run 34362064249](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34362064249): Bob's settings dialog enforced exact-ID/password confirmation, native deactivation and local journal completion agreed, his former session cookie was rejected, and Alice remained signed in. Production account data was not used.
