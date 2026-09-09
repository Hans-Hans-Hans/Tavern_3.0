# Webhook identity and lifecycle

Each configured webhook has a stable ID and encrypted destination room, an approved membership list, and its own signing secret file. Optional metadata in `bot.json` is:

```json
{
  "name": "Build notifications",
  "avatar_url": "mxc://chat.example.com/approved_media_id",
  "enabled": true,
  "created_by": "@owner:chat.example.com",
  "created_at": 1789000000000
}
```

Names are trimmed, contain 1–80 characters and no control characters. Avatars are empty or a bounded Matrix media URI; the bot does not fetch external image URLs. Creation metadata is optional for existing manually configured hooks. Legacy hooks without these fields keep their ID as their display name, have no custom avatar and remain enabled.

The HMAC protocol remains unchanged: the body is exactly `{"text":"message"}` and the signature authenticates the version, hook ID, timestamp, delivery UUID and raw body. Callers cannot choose a destination, sender, display name or avatar in a signed payload. Rotating a signing secret does not replace the dedicated Matrix account, its device identity or its crypto store.

The bot adds `io.tavern.webhook: {id, name, avatar_url}` to the **encrypted** `m.room.message` content. The actual Matrix sender remains the dedicated bot account. It never changes that account's global or room profile to impersonate another user. Labels use the currently applied hook configuration when a queued delivery is sent; existing encrypted queue entries remain compatible. A client must keep the actual sender visible: the metadata namespace alone is not proof of a trusted bot because any Matrix sender can include custom content fields.

## Disable, enable and remove

The runtime checks the configuration on synchronization, ingress and delivery. The administration API's applied-configuration indicator distinguishes a saved configuration from one the bot has applied.

Once a disabled configuration is applied:

- New requests to that hook return `404`, matching an unavailable hook.
- Pending deliveries become `cancelled`, and their encrypted payload, nonce and authentication tag are cleared from the active queue records.
- Delivery UUID records remain so retries cannot recreate a cancelled message.
- Re-enabling permits new delivery UUIDs. It does not restore cancelled messages.

A delivery already in flight when the change is saved can finish before the bot applies the update. Disabling does not delete messages already sent. Removing a hook has the same pending-queue cancellation behavior; retired IDs must not be reused.

An existing ID's room destination is immutable, including across bot restarts. To move a webhook, create a new hook for the desired encrypted room, approve its membership and verified devices, update the sender's URL and secret, and retire the old hook. This prevents old queued messages from being redirected into a different room.

Every actual delivery still refreshes membership, requires an encrypted joined room, checks the approved users and independently verified device fingerprints, rotates the outbound session, and requires the approved devices to receive the encryption keys. Display metadata and enabled state grant no additional access and do not provide a plaintext fallback.

## Management and permissions

Instance administrators manage all hooks and global recipient-device approvals from Admin → Integrations. Channel managers use Channel information → Manage webhooks, or the server context menu → Manage integrations. Delegation requires current channel and canonical-parent membership, the native room state authority and the explicit `manage_webhooks` role permission in every governing server/category/channel policy. Temporary bans prevent delegated management. Ordinary channel managers never receive another channel's hook inventory, global device approvals, stored secrets or the bot's Matrix credentials.

Create and rotate return the signing secret once. Editing name/avatar/approved members/enabled preserves the secret and original creator/date. Avatar uploads use the authenticated account media gateway and existing quotas; the client crops/optimizes artwork, shares bounded thumbnail fetches within a session and displays safe blob URLs. Matrix account identity stays visible beside sender-supplied webhook labels. A label is not a verified-integration badge.

Every mutation checks the configuration revision and current authorization; concurrent session revocation is serialized with writes. Inventory authorization is repeated after the bot health request. Re-enabling or changing approved members validates the current encrypted destination and its joined recipients. Legacy hooks without creation metadata display an unknown creator/date.

## Validation

Configuration and signature tests run without a Matrix server. `tests/test_bot_runtime.py` exercises the actual Bridge ingress, configuration reload, AES-GCM queue and delivery code with an isolated Matrix transport; it covers cancellation while waiting for a lock, stale selected rows, stable signatures, metadata, destination binding, membership, device fingerprints, plaintext rooms and incomplete key sharing. The separate durable-store test covers the real pinned Matrix encryption store. These runtime tests run in Linux CI with the integration dependencies; they are explicitly skipped on Windows because the production runtime requires `fcntl`. A live deployment still needs the dedicated bot account, approved room membership and verified recipient devices.

Fourteen API regressions cover metadata, delegation, native/custom/category membership boundaries, concurrent revisions and revocation while waiting for configuration or health. Six integration browser flows include optimized avatar upload, scoped management, typed confirmation and preserving a one-time secret when inventory refresh fails.
