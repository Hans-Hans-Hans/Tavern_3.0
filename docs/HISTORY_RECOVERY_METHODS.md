# Account-wide history recovery

In **Account security**, set up an authenticator with its QR code or setup key.
It uses six-digit, 30-second TOTP codes ([RFC 6238](https://www.rfc-editor.org/rfc/rfc6238)).
The authenticator generates codes offline; Tavern still needs a connection to
verify a code and retrieve history on a new device. Email sign-in verification
remains available alongside the authenticator. Neither replaces the sign-in password.

In **Privacy > Message history recovery**, select any combination of:

- History passphrase: a separate secret that unlocks the client-encrypted key.
- Authenticator app: a fresh authenticator code unlocks the saved history key.
- Email code: a code sent to the verified address unlocks the saved history key.

These are alternatives, not a requirement to supply all selected methods.
Enable each from a device that can already read its history backup. Adding a
method asks for the current account password and proof of the selected factor.
On another device, sign in normally, then use any enabled recovery method.
An OTP used for sign-in cannot be reused for recovery: wait for the next code.
After unlocking with any method, a forgotten history passphrase can be replaced
from this device without changing the other recovery methods.

Selections and recovery packages belong to the account, not the browser.
Unchecking one method blocks its recovery endpoint while retaining its package;
other selected methods continue working. Unchecking all stops automatic recovery
prompts. It does not erase keys already cached by a device or lock an already
unlocked browser. Disabling sign-in MFA is a separate Account security setting.

## Storage and compatibility

Matrix message encryption and native backup formats remain intact. This change
does not convert messages to plaintext or a custom obfuscation format. Existing
encrypted messages still require their original keys; no setting can recreate
keys that all devices and backups have lost.

Authenticator and new email recovery deliberately trust the Tavern server with
recoverable history keys. The client wraps the native backup private key using a
random 256-bit wrapping secret; the API seals both with the existing server
storage key. After a valid, one-time verification it releases that package and
secret to the signed-in device. This is server-assisted recovery, not a promise
that the server operator cannot read history. No plaintext messages are added to
the API database. Passphrase packages remain client-encrypted, but enabling any
server-assisted method also makes the same history server-recoverable.

Existing password-based email packages continue to work until a new email-code
package is explicitly enabled. They cannot be automatically converted without a
device that has recovered the native backup key. Existing passphrase packages
and saved mode preferences are migrated on read without deleting anything.

Factor challenges expire after ten minutes and allow at most five code attempts.
They bind user, session, device, method, purpose, factor identity, credential
epoch and package revision. Enrollment requires the current account password.
TOTP verification shares sign-in's replay counter. Email and authenticator
changes, revocation, disabled recovery methods, changed native backups and stale
revisions prevent release. Each account's mutation requests use the existing
per-user lock; ownership is rechecked after asynchronous upstream requests.

## Validation

Tests cover restoring the exact native key independently with passphrase,
authenticator and email; coexistence and individual removal; fresh-browser UI;
invalid, replayed and expired codes; cross-device, account, origin and revoked
session requests; and changed backup, email, credentials and revisions.

Validation passed: 760 JavaScript unit tests, 29 targeted Python API/security
tests, 21 browser tests, TypeScript checking and the production Vite build.
An initial module-wide Python invocation also collected the existing storage
inventory test, which fails on Windows because it lists `secrets.key`; that
unrelated storage code is unchanged by this feature.
