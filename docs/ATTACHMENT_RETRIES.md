# Attachment delivery and retries

When you send attachments, Tavern first saves an encrypted pending message on
this device, then attempts delivery. An incomplete send remains in **Settings →
Outbox & reminders**, including the original caption, files, and their individual
delivery states. Closing the composer or moving to another conversation does
not discard that saved item. A failed manual attempt stays unsent until you
choose **Retry delivery**. That action enables bounded retries while this
device's Tavern session is open and connected.

If an upload fails before you press Send, Tavern tries to save the original file
as an encrypted, unsent **file-only** draft. Its caption stays in the composer;
the notice explains this separation. Retry the file from Outbox. An unsuccessful
local save reports that limitation and keeps the original file available in the
current composer for retry. If local storage is full or unavailable, ordinary
direct sending remains available; keep the view and original files open when
there is no saved retry copy.

The outbox shows each filename as one of:

- Saved on this device; upload pending.
- Uploaded; message not acknowledged.
- Acknowledged by the homeserver.

An acknowledgement confirms the homeserver accepted that event. It does not
mean a recipient downloaded, decrypted, or read the file. A later failure does
not change an earlier file's acknowledgement. Cancelling deletes only the local
pending item and its remaining file copies. It does not delete uploaded media,
acknowledged messages, recipients' copies, or backups.
A delivery already in progress must settle before its local entry can be
cancelled; cancellation cannot retract an in-flight request.

The local queue permits 100 items, five files per message, files up to 10 MiB,
and 100 MiB of pending original-file copies in total. Uploaded descriptors are
small and replace the local file copy after a successful checkpoint. These are
local retry limits, separate from the server's upload/storage limits. Scheduling
still applies to text messages; ordinary attachment Send and explicit retries
use the current delivery path. Pending items remain on this browser profile and
native Matrix device. Clearing browser site data loses them; there is no
cross-device outbox or closed-browser delivery worker.

## Ownership and delivery checkpoints

The implementation in [outbox.ts](../lib/outbox.ts),
[outbox-store.ts](../lib/outbox-store.ts), and
[outbox-attachments.ts](../lib/outbox-attachments.ts) encrypts message metadata
and original file bytes using the existing device's nonextractable AES-GCM key.
Filenames, message text, uploaded MXC descriptors and attachment encryption keys
are inside authenticated ciphertext. Opaque local IDs, scheduling times and
stored byte counts remain outside it. The authenticated data binds each record
to its account, native device, homeserver, item and file. Existing version-one
encrypted text records stay readable; their first upgrade records the previously
implicit homeserver binding.

Every asynchronous storage, upload and send operation checks its captured
client/account generation, native identity, room membership and encryption
context. Replacement account A → B → A does not reactivate an old operation.
The Matrix session already owns an exclusive crypto-store Web Lock. Abandoned
IndexedDB upgrades close late connections, and session teardown cancels pending
drain timers and listeners. Saved records remain for the original device's next
session.

Before any queued upload, the sender validates current role mentions and freezes
the original native message content. Retries reuse that content, uploaded media
descriptor and transaction IDs. Unrelated display-name or emoji changes do not
rewrite the message. A changed role audience or encryption context stops the
retry with an explanation instead of selecting different recipients. Native
room permissions continue to apply at each actual send.

Each uploaded descriptor and each acknowledged attachment is checkpointed before
advancing to the next file. The failure handler preserves the latest checkpoint,
including when the first local acknowledgement write failed. A file whose ACK
is known is skipped. Attempt counts and immutable content survive explicit
Retry; only the automatic retry cycle resets. An item cannot be edited after an
attempt. Failed direct text sends also retain their original in-memory content
and attempt lineage when explicitly moved to Outbox. At most 100 distinct
unconfirmed attempts are retained in one live Matrix client; reaching that cap
keeps existing attempts and rejects a new send before uploads begin. Completion
or explicit outbox cancellation releases its slot.

[send-matrix-transaction.ts](../lib/send-matrix-transaction.ts) uses the pinned
Matrix SDK's existing local echo and `resendEvent` for an unconfirmed transaction;
calling `sendMessage` again with its registered transaction would fail. For an
already encrypted local echo, the SDK keeps its original clear content and wire
ciphertext. After a page restart, the saved original native content can be
encrypted again using the same native transaction ID. Transaction deduplication
depends on the homeserver's Matrix behavior. An upload that reached the server
without returning its MXC URL may leave an orphan; an event whose acknowledgement
never returned may already exist remotely. Inspect the conversation before
replacing or retrying an old ambiguous send. Tavern does not claim indefinite
exactly-once delivery or recover unknown upload IDs.
Malformed success responses are not accepted as acknowledgements, even if the
SDK has already marked their local echo as sent.

## Validation

Focused tests exercise actual Chromium IndexedDB/WebCrypto, per-item quota and
cancellation, partial ACK → next-file failure → restart → retry, interrupted
checkpoint writes, owner/membership changes across awaits, and abandoned
database upgrades. Mounted Workspace/Composer/Outbox tests cover durable
handoff, failed raw uploads, navigation, explicit retry and stale confirmations.
The real pinned SDK tests cover encrypted local-echo transformation, reuse of
the same transaction and ciphertext, known-ACK skipping and rejection of
conflicting/in-flight requests. These tests use controlled transport responses;
they do not claim new live homeserver or external delivery validation.
