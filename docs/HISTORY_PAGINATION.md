# History pagination and local search

Search indexing and message-history export follow each advancing `/messages`
continuation token even when the returned page contains no visible events.
An empty filtered page does not establish that older readable history is absent.
This follows the [Matrix history endpoint](https://spec.matrix.org/v1.13/client-server-api/#get_matrixclientv3roomsroomidmessages).

Only an omitted continuation token completes the request scan. Repeated or
invalid tokens, malformed pages and events that declare a different room stop
the operation with an error. They do not produce a successful completion record.
An event without `room_id` is bound to the requested room before SDK mapping and
decryption, so older encrypted messages have the context needed to use this
device's keys.

History work remains bound to its original client, actor, device and room.
Membership or identity changes discard pending page/decryption results. Search
also checks the operation before its final IndexedDB write. Already indexed
messages remain on the owning device after cancellation; exported plaintext
already written to a selected file cannot be recalled. These checks use current
client state and do not establish an atomic snapshot with the homeserver.

Search covers decrypted messages indexed on this device. Finishing a history
scan does not make missing encryption keys available, recover unavailable room
history, or provide a server plaintext index. Export records unreadable encrypted
events separately. A failed export has no `complete` record.

Validation includes 11 search/export Node checks and seven browser checks using
real IndexedDB and WebCrypto. Browser history tests control the SDK request and
decryption boundary to exercise empty pages, cycles, omitted room IDs and changes
during page loading, decryption and the final storage callback. They do not claim
live homeserver decryption acceptance for this change.
