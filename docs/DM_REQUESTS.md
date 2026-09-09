# Message requests

Open **Messages → Message requests** to review incoming Matrix room invitations marked as direct messages. The general invitation list and direct-invitation room links open the same inbox. Normal room, server and private-discussion invitations keep their existing flows.

The inbox shows the room name, inviter's Matrix ID, room ID, available encryption state and a warning when public joins are enabled. It does not request message history, attachments or profile images. Names and the `is_direct` marker are supplied by the inviter; the marker does not establish trust, restrict the audience or override native room permissions. A request can be a group conversation. Friend/contact requests remain separate.

## Accept, decline and block

- **Accept message request** performs a native Matrix join. After joined room state is available, Tavern adds the room to the recipient's `m.direct` account data and opens it in Messages. Existing mappings, including mappings retrieved from other devices, are preserved.
- **Decline** leaves the pending invitation without joining it or fetching its messages.
- **Block sender** requires confirmation. Tavern uses the existing account block operation, then declines the invitation. Existing shared room memberships and history remain. If blocking succeeds but declining fails, the inbox reports both outcomes and offers a decline retry.

Each action checks the current account/session generation, invitation sender and state, and current ignored-user state. Native Matrix authorization remains authoritative. A changed or withdrawn invitation cannot authorize a stale inbox action; a delayed action from a replaced account cannot update the replacement account's inbox. Blocking a sender or joining a room elsewhere during an operation can change the result, which is reported without silently leaving a joined room.

## Partial acceptance and retries

A native join response can arrive before the joined room state appears in sync. Saving the recipient's Messages list can also fail independently of joining. Tavern reports **You joined the room, but it has not been added to Messages** and offers **Retry adding to Messages**. This retries classification without performing another join. Messages are only opened automatically after the recipient's synced account data confirms classification.

The current session keeps pending classification repairs. After a reload, an unclassified joined room can also be recovered when the SDK still has its preceding direct-invitation membership state. Later membership/profile changes can replace that preceding state; Tavern does not guess the former inviter. Such a room remains joined and available through the ordinary conversation list. Native `m.direct` account data has no cross-device compare-and-swap operation, so simultaneous updates on another device can require retrying classification.

## Validation

`tests/dm-requests.test.mjs` exercises actual SDK `Room`, membership events, join/leave and account-data methods with a controlled native transport: invitation replacement/withdrawal, ignores and unblocks, native rejection, fresh mapping merges, delayed joined sync, partial retries, concurrent actions and account replacement.

`tests/browser/dm-requests.spec.ts` runs the real inbox and shared account-data mutation with SDK models. It covers explicit acceptance, decline, block confirmation, partial failure recovery, stale owner/confirmation results, and the actual Workspace's sidebar, general invitations and deep-link entry points. These fixtures do not prove a deployed Synapse or TURN connection; deployment acceptance should additionally verify two native accounts, recipient classification after reload, and encrypted messages after explicit acceptance.
