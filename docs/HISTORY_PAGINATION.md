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

## Opening a message's surrounding conversation

Search results, message links, reminders, and the source buttons on saved or
mentioned messages open **Message context** at the selected event. A reply in a
public thread opens its thread instead; private discussions keep their separate
encrypted discussion panel. **Reply in thread** still starts or opens a thread.

The context uses the owning Matrix SDK's joined-room timeline and this device's
existing encryption keys. The initial request can fetch the selected event and
one 25-event page on each side. **Load earlier** and **Load later** each make at
most one additional 50-event request, first using cached events when available.
Empty pages with advancing cursors remain pageable. The view holds at most 500
raw events; paging can trim the opposite end. The controls report empty pages,
the window limit, and whether the currently synced timeline has been reached.
**Return to selected message** recenters the view; **Back to latest** returns to
the normal conversation. Neither action changes encryption keys.

Each operation has a 20-second deadline. The helper rejects cycles, invalid
cursors, more than 32 connected segments, and more than 200 requested pages in
one direction. Closing the panel removes only its own SDK listener. Changes to
the client, account generation, device, homeserver, room, or joined membership
discard pending results and clear the displayed context. Its attachment gallery
contains only the displayed history window and closes/revokes its object URLs
when that context loses access. The Matrix client's own caches remain governed
by the existing session lifecycle; these checks do not make native requests
atomic with membership changes or recover missing keys.

Context validation adds eight browser checks for actual SDK context/pagination,
empty pages and deliberate retry, listener cleanup, delayed-result cancellation,
account replacement, membership loss, StrictMode, phone/keyboard controls, the
mounted Workspace navigation, and the real attachment viewer. The 11 SDK Node
checks also cover timeline merging, reset detection, window bounds and deadlines.
These local fixtures use the real pinned SDK but control the HTTP and crypto
boundaries; they do not establish live homeserver recovery or delivery evidence.
