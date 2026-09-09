# Recovering encrypted history

Tavern keeps message encryption keys in the browser and can back them up to
Matrix in encrypted form. Signing in establishes an account session; the account
password alone does not unlock another device's message keys.

## If messages became unreadable after signing in again

Keep the browser's site data. Open the updated Tavern on the same hostname and
browser profile that previously displayed the messages. After syncing, Tavern
checks encryption stores retained from earlier sign-ins and copies available
message keys into the current device. Messages retry decryption automatically.
The original stores, device identities and backup versions are preserved.

Open **History recovery** above the conversation for the result. Use **Check this
browser for history keys** to retry after closing other Tavern tabs. A browser
profile or hostname change uses different local storage: repeat this check in
each original browser. Private browsing data and cleared site data cannot be
reconstructed by this check.

## On a new browser or device

Open **History recovery**, enter the recovery key saved when encryption recovery
was configured, and select **Unlock & enable automatic recovery**. Restoring all
available history keys is selected by default. Tavern keeps the existing signing
identity and backup; an incorrect key does not reset either.

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
UI tests separately cover wrong keys, full-history restoration by default, and
clearing entered secrets after a session change. See [VALIDATION.md](VALIDATION.md)
for native server test results.
