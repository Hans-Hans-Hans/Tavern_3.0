# Recovering encrypted history

Tavern keeps message encryption keys in the browser and can back them up to
Matrix in encrypted form. Signing in establishes an account session; the account
password alone does not unlock another device's message keys.

## Account-wide recovery choices

Open **Settings > Privacy > Message history recovery**. Choose **Off**,
**Passphrase**, or **Email code and account password**. The choice is saved with
your account on the server, not in a browser preference. New accounts default to
Off. Existing configured email recovery stays selected until explicitly changed;
logging in no longer silently enrolls an account in email recovery.

Passphrase setup encrypts your native Matrix history-backup key in the browser
and stores the encrypted package against your account. Choose and confirm a
separate history passphrase of at least 12 characters. The passphrase is never
sent to the API, saved in browser storage, or replaced by your sign-in password.
On another browser or device, sign in and enter that same history passphrase.
Tavern downloads your account's package and restores available keys from Matrix's
encrypted backup. This works with SMTP disabled and without a verified email.
Known devices can reuse saved keys; each device does not need a new recovery setup.

The package uses the same PBKDF2/AES-GCM protection and account/origin/backup
binding as email packages. A forgotten history passphrase cannot be reset by
email or by resetting the account password. Update it from a device that still
has the matching backup key, or use an existing recovery key or encrypted export.
Email and passphrase packages remain separate, so switching methods does not
overwrite the other method's encrypted package.

Off disables automatic recovery prompts and package release for that account,
across browsers. It does not disable Matrix end-to-end encryption, erase keys,
or delete existing backups/packages. It also does not make encrypted history
readable on a new device without keys. Re-enable a saved method in Privacy or
use an offline recovery key/export when you need that history.

Setup on a device missing the current backup key requires explicit confirmation
that only available and future keys can be protected. Preserve the original
device if it can still read older messages: no recovery setting can recreate
keys missing from every device, backup and export. Backups must finish uploading
for those keys to be available elsewhere. Membership and original room history
visibility still control what messages a new device can retrieve.

## Optional outgoing email

In **Admin > Email**, uncheck **Enable email** and save. SMTP credentials are
retained for later use. Email history recovery, email verification and password
reset emails stop. Passphrase history recovery and ordinary password sign-in
remain available. Existing email MFA requirements are **not** silently bypassed;
use a configured authenticator or recovery code, or the existing explicit admin
account-security process. This option is not an email-MFA bypass.

## Schedule passphrase setup for hans

After rebuilding/deploying both Web and API, run on the Docker host with the
existing stack's usual Compose/project/environment options:

```sh
docker compose exec -T tavern-api python /app/configure_history.py --user hans --prompt-passphrase
```

This explicit operator command locates exactly one existing managed account,
turns its history recovery mode Off immediately, cancels pending history-email
challenges, and schedules a passphrase setup prompt for sessions created after
the command. The next normal Tavern login offers setup; an existing session is
not forced out. Saving the new passphrase clears the pending setup. Users can
continue without setup or explicitly turn prompts off. No account named hans is
hardcoded into application startup and other accounts are not changed.

To also disable outgoing email for the **whole instance**, append
`--disable-email`. This preserves SMTP settings and leaves MFA requirements
unchanged. Omit that flag if you want other accounts to keep using working mail.
Use `--user @hans:your.domain` if the short account name is ambiguous. The command
requires the existing account database and secrets.key and refuses to create an
empty account store. It is included in the API image and audited as a local
operator action. No production account is changed by merely deploying this code.

## If messages became unreadable after signing in again

Keep the browser's site data. Open the updated Tavern on the same hostname and
browser profile that previously displayed the messages. After syncing, Tavern
checks encryption stores retained from earlier sign-ins and copies available
message keys into the current device. Messages retry decryption automatically.
The original stores, device identities and backup versions are preserved.

When an earlier local store also contains the key for the current encrypted
backup, Tavern reuses it automatically. The backup version, algorithm and public
key must match the server, and a key already present on the current device is
preserved. This lets ordinary sign-ins in the same browser regain backup access
without entering the recovery key again. It does not transfer signing keys or
automatically verify a new device.

Open **Settings → Privacy → History recovery** for the result. Use **Check this
browser for history keys** to retry after closing other Tavern tabs. A browser
profile or hostname change uses different local storage: repeat this check in
each original browser. Private browsing data and cleared site data cannot be
reconstructed by this check.

The history reminder waits for the automatic browser check. It stays hidden when
backup recovery is available, even if device identity verification remains
unfinished. You can dismiss it; that preference is remembered for this account
and homeserver until its backup configuration changes. The recovery controls
remain available in Settings.

## On a new browser or device

For an account with email history recovery enabled, sign in normally. After
checking local keys, Tavern opens **Unlock your message history** and sends an
email code. Enter it to restore the available encrypted history. A browser
that already holds the matching keys skips this prompt. Email setup uses the
existing verified account email and administrator-configured SMTP service.

If email recovery is not configured, open **History recovery**, enter the recovery
key saved when encryption recovery was configured, and select **Unlock & enable
automatic recovery**. Restoring all available history keys is selected by default.
Tavern keeps the existing signing identity and backup; an incorrect key does not
reset either.

The same dialog also offers signed-in device verification and **Recover from an
encrypted key file** for an export from Tavern or Element. The key-file passphrase
is the one chosen when exporting it, which may differ from the account password.

If no recovery configuration exists, use **Set up a recovery key**, save or
download the key, confirm that it is saved, and enable the identity and backup.
This protects message keys that are available on the device. It does not recreate
older keys missing from all devices, backups and key files. If an existing
identity or backup prevents new setup, recover or verify that identity; Tavern
does not replace it automatically.

## Validation scope

Local browser tests use the installed Matrix SDK and its real Rust/WASM crypto
store: an event fails decryption on a new device, then decrypts after importing
the old device's saved keys. They also check account isolation, old-store
preservation, busy-tab handling and cancellation after a session change. Recovery
tests also use real cached backup keys to check version/public-key matching,
backup rotation and concurrent key arrival without replacing existing keys. Recovery
UI tests separately cover wrong keys, full-history restoration by default, and
clearing entered secrets after a session change. See [VALIDATION.md](VALIDATION.md)
for native server test results.

The live CI probe has also passed managed logout/relogin recovery using retained
browser keys and recovery in a separate fresh browser from the native encrypted
backup. It verifies an incorrect recovery key leaves the existing backup and
signing identity intact. This proves those paths on the isolated test server;
availability of your older history still depends on the keys your devices or
backup retained.

## Email recovery and known browsers

Managed accounts with a verified email can enable password-protected email history recovery in Settings / Privacy. Enrollment is explicit: select Email recovery and enable its package from a device that holds the matching history key. An existing cookie session can enable it by entering the current password once. Known browsers recover from their existing Rust key stores without an email prompt. On a new device, a configured package opens the email-code dialog after native sync/local recovery finishes. The normal login password supplies the local decryption key; a refreshed tab may need that password again. Users can defer older history and continue messaging.

If no usable backup key remains, **Protect messages on this device** explicitly creates a new native backup for available and future room keys. It preserves existing backup versions and signing identities. It cannot reconstruct missing older message keys. The candidate is cached in the native Rust store before the POST; a nonsecret journal supports a retry after an uncertain outcome, and another cached backup key is never overwritten. Old-device recovery accepts the reserved pending version only when its public key matches the current native backup.

The API stores an encrypted package containing only the history-backup private key. WebCrypto uses PBKDF2-HMAC-SHA-256 (600,000 iterations, random 16-byte salt) and AES-256-GCM (random 12-byte IV); authenticated metadata binds the key to the account, origin, native backup version and public key. The password is not saved by this flow. A non-exportable derivation key is retained in memory for at most five minutes after successful login and cannot be reused after an account change; sign-out clears it. The service's existing database encryption additionally protects the stored ciphertext.

The six-digit email code expires in ten minutes, permits at most five attempts, and is limited to three sends per five minutes per account. Release requires the same authenticated session/device, current verified email, credential epoch, package revision and matching native backup. Codes are consumed once. Native ownership is rechecked after asynchronous operations, and key imports serialize with other encryption operations. Client key bytes are cleared after use. SMTP uses the existing administrator-configured mail service. Rebuild both `tavern-api` and `tavern-web` for this feature. The new SQLite table is additive; no deployment secret or existing Matrix key needs replacing.

When email recovery is selected, a normal password change rewraps its package if this browser has the matching history key. Passphrase recovery is independent of the account password and is not rewrapped by that change. A forgotten-password reset cannot decrypt a package protected with the old password. Use the previous password, a known browser, or a saved message-key export; then update email recovery with the new password. Email recovery restores history keys, not signing identity secrets or participant identity verification. A pre-existing Matrix recovery key continues to protect the backup/identity it originally covered; a separately created email backup does not rewrite that secret-storage entry.

Validation: actual WebCrypto encryption/tampering/account-binding tests; real Rust old-device key recovery including interrupted candidates; API cookie/CSRF/OTP/session-revocation/credential-and-backup-change tests; mounted known-device, new-device, wrong-code and defer flows. The native TLS SMTP/code/restore/known-browser flow passed in isolated CI at `f958030`, `f6190e8` and `0dd7afe`; target-host mail delivery and older-history availability remain separate acceptance checks.

Account-wide recovery change validation: 25 focused Python tests, 26 client
encryption/security tests, and 11 browser UI tests passed, including passphrase
setup in one browser and the recovery prompt in a separate browser context.
TypeScript checking and the production frontend build passed. These checks
exercise real envelope/WASM key validation with mocked Matrix network responses;
the new passphrase flow has not yet been exercised on the production homeserver.
An initial broader Python run also encountered the existing unrelated storage
inventory assertion about the secrets.key filename; no storage implementation
was changed for this feature.
