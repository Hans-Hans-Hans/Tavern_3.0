# Encrypted server system notices

Server settings can route future server joins and departures to an existing encrypted child channel. These are real Matrix `m.notice` messages sent by the dedicated integration bot. The sender remains that bot; the notice names the member by their authoritative Matrix ID. Channel joins, private-discussion membership, profile changes and bans do not generate these notices. A native leave transition after a join includes self-departure or removal, without copying moderation reasons.

## Setup

1. Enable `INTEGRATIONS_ENABLED=true` and include `integrations` in `COMPOSE_PROFILES`, then provision the optional integration service using [Calls and integrations](CALLS_AND_INTEGRATIONS.md#6-provision-the-optional-integration-bot). Preserve its existing account, native device identity and encryption store.
2. Explicitly join that bot to the server Space and the destination channel. The channel must be local, encrypted, an actual reciprocal canonical child of this server, and contain only approved server members. Private discussions and Spaces cannot be destinations.
3. Configure an enabled webhook for that channel through the existing integration administration. Approve every recipient account and independently verify/pin its recipient devices. System notices reuse those approvals; they do not create a public webhook secret, join rooms or trust new devices automatically.
4. In server settings, open **System notices**, select the configured destination, choose joins/departures and type the exact server ID to save. The current server owner or a joined member with `manage_server` and native state authority can configure this. A Space without custom roles permits its native creator. Saving uses the current native configuration event as a compare-and-swap guard.

The first enable generates the private `system-messages.hmac` key inside the existing bot configuration directory and adds a fixed internal callback configuration to `bot.json`. This is separate from public webhook signing keys. A missing bot identity shows **Unconfigured**; the saved route can still be disabled. Readiness describes provisioned configuration, not proof that the bot is currently connected or that every recipient device is approved.

The API reads the provisioned native policy through its supplementary Synapse group. The initializer sets `synapse/tavern_modules` to `0750` and policy files to `0640`, owned by `991:991`. If an older initializer left this directory at `0700`, rerun the matching updated initializer with `docker compose run --rm init`, then reload the settings panel. This repairs directory access while preserving existing credentials and their file permissions. An unreadable deployed policy returns a service-unavailable response and does not grant configuration access.

The bot needs ordinary current native send authority and all governing custom send permissions. The destination's own policy and every reciprocal canonical ancestor apply additional restrictions. Timeouts, temporary bans, archived channels and server account requirements can block delivery. Read-only, rules and announcement channels additionally require message-management permission and native redact authority. Native Synapse authorization remains the final gate.

## Audience and delivery behavior

Each notice is bound to the source event, its configuration revision and the server membership at that event. Current destination recipients must be a subset of that original audience, still belong to the source server, and remain explicitly approved for the existing hook. A new destination member can therefore cancel an older notice. A departure notice is cancelled if the departed account still belongs to the destination channel; it can only be delivered after that account leaves the destination and the other checks still pass. This restriction prevents source membership information crossing audiences.

The bot rechecks current authorization before sharing keys and again before sending. It checks the bot identity, configuration revision, native destination membership and independently verified device fingerprints. There is no plaintext Matrix fallback. Device approvals grant no server membership or native powers.

The settings panel reports queued, sent and cancelled delivery records. **Sent** means a valid homeserver event ID was confirmed; it does not mean anyone read the notice. **Cancelled** means further retry was stopped. If a previous native response was lost, cancellation does not prove that no notice reached the homeserver. Deterministic transaction IDs use a namespace separate from public webhooks so retry can reconcile an ambiguous native send.

Disabling or changing the route prevents later retries under the old configuration. Already delivered messages remain in encrypted history. A native request already in flight can complete after a setting changes; the checks cannot form an atomic transaction across Synapse and the bot.

## Recovery bounds and private data

The native `on_new_event` callback records event IDs after persistence. A durable cursor repairs missed callbacks using Synapse's fully committed stream prefix. First installation starts at the current prefix and does not broadcast historical membership. Catch-up examines at most 100 accepted events per batch, retains only a 20,000-stream-position window, and expires notices after 30 minutes. Each queue allows at most 2,000 pending entries. Recovery is bounded best effort, not a lossless or unlimited history scan.

The native queue contains event IDs and retry metadata. API and bot queues encrypt membership envelopes at rest and clear their payload fields on completion/cancellation. Deduplication tombstones and native room event IDs remain. The new queue inherits the existing service/backup trust boundary; clearing an active row is not secure erasure from SQLite pages, WAL files or backups.

Native ingestion and bot authorization use different HMAC purposes, fixed private service routes, strict schemas, body limits and short timestamp windows. They accept no browser identity or client-selected plaintext. Public Nginx rejects `/api/internal/` paths. Each native event lookup/delivery attempt has a 15-second deadline; its ingestion request has a five-second timeout and bounded response. This prevents unrelated partial-state synchronization from stalling catch-up. API authorization and bot requests are separately bounded. Persistent retry does not retain account passwords or MFA codes.

Back up the native database, account database, bot configuration and bot data together using the existing stopped-service procedure. Include `system-messages.hmac`, `queue.key`, the bot session, identity manifest and crypto store. Do not regenerate the device or encryption store to recover a blocked queue.

## Validation and pinned native interfaces

Focused tests exercise actual API sessions and HTTP signatures, strict native CAS/authority, suspension, changed audiences, streamed logout races, separate encrypted bot queues, restart deduplication and ambiguous native confirmations. Portable runtime-method tests isolate the Matrix transport; they do not establish live matrix-nio encryption or homeserver interoperability. A deployed acceptance run must still demonstrate an actual encrypted notice decrypted by approved independent clients, restart recovery, configuration revocation and a rejected cross-audience delivery.

The native adapter targets Synapse 1.160.0. Its private datastore/controller assumptions were checked against the pinned source: [post-persist callback dispatch](https://github.com/element-hq/synapse/blob/v1.160.0/synapse/module_api/callbacks/third_party_event_rules_callbacks.py), [event state lookup](https://github.com/element-hq/synapse/blob/v1.160.0/synapse/storage/controllers/state.py), [safe stream prefix](https://github.com/element-hq/synapse/blob/v1.160.0/synapse/storage/databases/main/stream.py), [persisted prefix semantics](https://github.com/element-hq/synapse/blob/v1.160.0/synapse/storage/util/id_generators.py), [native event columns](https://github.com/element-hq/synapse/blob/v1.160.0/synapse/storage/databases/main/events.py), and [bounded HTTP body reader](https://github.com/element-hq/synapse/blob/v1.160.0/synapse/http/client.py). Review these adapters before upgrading the Synapse pin.
