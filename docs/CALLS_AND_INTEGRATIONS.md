> For Tavern 0.4 and the complete single Compose stack, use [Installation and operations](INSTALLATION.md). The manual recipes below describe earlier deployments; retain existing identity/data during migration.

# Tavern 0.3: deploy calls and integrations

Using GitHub `V3` builds? Apply the image-tag and Compose substitutions in [the GitHub guide](DEPLOY_GITHUB.md#add-calls-and-integrations) while following the configuration and acceptance steps here.

This extends the [base Dockhand/NPM setup](DEPLOY_DOCKHAND_NPM.md). Build the `npm` Docker target; the older Caddy recipe does not configure the new services. Keep the same Tavern hostname and data directory when upgrading. No cloud Tavern service is required.

## 1. Update the client

On the Docker host, extract the source into the existing source directory, preserve its private `.env`, and build:

```sh
docker build --target npm -t tavern:0.3.0 .
docker build -t tavern-integrations:0.3.0 integrations
```

The client build downloads the pinned Element Call package through `npm ci` and bundles its assets. Conference assets load only when opening a conference. It does not load a public Element Call site or send an access token in an iframe URL. The package includes upstream license notices and the corresponding-source reference.

Use a supported pinned Synapse release. The call configuration uses Synapse **1.160.0**, LiveKit **1.13.6**, RTC authorization **0.6.0**, and Element Call embedded **0.25.0**. Update the `SYNAPSE_IMAGE` stack setting to `matrixdotorg/synapse:v1.160.0` after following the Synapse upgrade notes and backing up the database/configuration. These versions have run together in isolated native CI; [Validation](VALIDATION.md) records the passed stages and remaining acceptance gates.

## 2. Generate private media configuration

Replace the example TURN hostname and public IPv4 with your own:

```sh
sudo python3 docker/prepare-calls.py \
  --data-dir /opt/tavern-data \
  --turn-domain turn.example.com \
  --public-ip YOUR_PUBLIC_IPV4
```

The script adds TURN, OpenID, delayed events, and MatrixRTC discovery to the existing Synapse configuration. It saves the previous config under `calls/homeserver.before-calls.json`, generates shared secrets, and refuses to overwrite an existing `calls` directory. This directory must remain outside the source/build context. Stop the stack before editing configuration and restart Synapse afterward. Back up Postgres separately; the config snapshot is not a database backup.

The generated files are private. TURN and LiveKit receive read-only configuration mounts. The authorization service needs outbound DNS/HTTPS to validate Matrix OpenID tokens at your Tavern hostname. Your network must support this route through NPM, using working NAT hairpin or split DNS with a valid certificate. Do not disable TLS certificate validation to work around routing.

## 3. DNS and router ports

| Host or port | Destination | Purpose |
|---|---|---|
| Tavern hostname, HTTPS 443 | Existing NPM → `tavern-web:8080` | Client, Matrix API, conference authorization and WebSocket signaling |
| `turn.example.com` | Your public IPv4, **Cloudflare DNS-only** | TURN/STUN discovery |
| TCP and UDP 3478 | Docker host 3478 | Authenticated TURN listener |
| UDP 49160–49200 | Same range on Docker host | TURN relay allocations |
| TCP 7881 | Docker host 7881 | LiveKit media fallback |
| UDP 7882 | Docker host 7882 | LiveKit media |

NPM's HTTP Proxy Hosts do not carry TURN or UDP media. Forward the media ports directly through your router/firewall. CGNAT or a network without inbound ports requires a reachable relay/SFU host that you control. The default relay range is deliberately bounded and needs capacity testing before expanding a deployment.

Enable WebSocket support on the existing Tavern NPM Proxy Host. The Tavern gateway handles `/livekit/jwt/` and `/livekit/sfu/` internally; no second public HTTP hostname is required. Keep caching, script rewriting, and browser challenges disabled for this host. The call iframe permits only same-origin embedding.

General federation remains blocked. The one externally reachable federation-namespaced endpoint is `/_matrix/federation/v1/openid/userinfo`, needed for RTC identity validation. `/.well-known/matrix/server` directs that validation to your existing HTTPS port. Neither route opens the federation send/join APIs or Synapse administration.

## 4. Start the services

For command-line Compose:

```sh
sudo docker compose -f compose.yaml -f compose.calls.yaml up -d
```

For Dockhand, use **`compose.dockhand.full.yaml`** after building both local Tavern images. Set the same base variables from `.env`, plus `LIVEKIT_KEY` and `LIVEKIT_SECRET` from the private `calls/jwt.env` file in Dockhand's stack environment. The Dockhand file uses direct environment substitutions for these two values, avoiding a Compose `env_file` that would need to exist inside Dockhand itself. Do not post those secrets in tickets or source control. Bind-mounted paths refer to the Docker host.

The full Dockhand file includes the integration service. Remove that service until section 6 has been completed, or use the base Dockhand file and add just the three media services and `media` network from the full file. Existing Postgres volumes and private Synapse data must be preserved.

## 5. Enable room calls and recoverable encryption

New Tavern channels allow members to publish conference membership. For an existing room, an administrator opens **Channel details → Channel permissions → Join conferences → Members**. This permission changes only that room; a server Space does not automatically grant channel access.

Use the conference button for encrypted group calls. Its bundled call UI provides microphone/camera controls, screen sharing, participant layout, and device selection. Selecting another channel preserves the active conference in the sidebar voice dock. Use Disconnect to leave; selecting a voice channel alone does not join it. [Voice participants and controls](VOICE_SIDEBAR.md) describes the supported observations and controls. Direct voice/video buttons are available in DMs with exactly two joined members. Direct calls require self-hosted TURN and use relay-only connections. The participant-verification control is separate from media encryption.

Known browsers automatically reuse their saved message keys. Managed accounts with a verified email can enroll **Email history recovery** in **Settings → Privacy**; ordinary password login also enrolls a matching backup key already available on the browser. A new browser then prompts for an email code after login to restore the enrolled history backup. Email recovery requires a previously saved matching key and cannot recreate keys lost on every device. See [History recovery](HISTORY_RECOVERY.md) for first-time protection and interrupted setup.

Recovery-key entry, encrypted key-file import and comparison with another device remain available. Device identity verification is separate from restoring message history. Tavern preserves existing backup versions instead of using the SDK's destructive backup reset operation.

Backup keys are created with official Matrix Rust primitives, and trusted through the matching private key recovered from encrypted secret storage. An encrypted pending secret preserves a candidate after an uncertain server response. Retry on the same device after such an interruption. Simultaneous setup from different clients is not transactional; inspect account backup state before further changes if Tavern reports a conflict. Never reset identity just to make an error disappear.

## 6. Provision the optional integration bot

The integration service receives signed text webhooks and sends them as an explicitly invited Matrix bot. It has no outbound forwarding. It is a trusted encryption endpoint: the webhook provider and this bot can see the incoming text, while Matrix receives an encrypted message.

Create a dedicated local Matrix bot account through the administrator procedure in the base guide, then invite it to the intended encrypted room. Do not use your personal account as the bot.

Prepare its private directories on the Docker host:

```sh
sudo mkdir -p /opt/tavern-data/integrations/config /opt/tavern-data/integrations/data/crypto
sudo cp integrations/config.example.json /opt/tavern-data/integrations/config/bot.json
sudo python3 - <<'PY'
from pathlib import Path
import os, secrets
os.umask(0o077)
root=Path('/opt/tavern-data/integrations/config')
for name,value in [('pickle.key',secrets.token_urlsafe(48)),('queue.key',secrets.token_hex(32)),('builds.hmac',secrets.token_urlsafe(48))]:
    with (root/name).open('x') as file: file.write(value+'\n')
PY
sudo chown -R 10001:10001 /opt/tavern-data/integrations
sudo chmod -R go-rwx /opt/tavern-data/integrations
```

Edit `bot.json` with the exact room ID, allowed user IDs, and independently verified device fingerprints. A device's own Ed25519 fingerprint is available in Tavern's Privacy → Signed-in devices. Verify each person/device through a trusted channel before pinning it. The bot refuses unapproved devices and participants; it does not accept every key returned by the homeserver.

Run provisioning once, with the base stack running. The default Compose network is `tavern_private`; adjust it if you changed the project name.

```sh
docker run --rm -it --network tavern_private \
  -v /opt/tavern-data/integrations/config:/config \
  -v /opt/tavern-data/integrations/data:/data \
  tavern-integrations:0.3.0 python provision.py
```

Provisioning asks for the dedicated bot credentials and saves its device identity. Do not rerun provisioning to replace a missing store. An interrupted key upload can be retried by starting the service with its saved identity. If joining a configured room failed, invite the bot and use the documented recovery command below with the existing session.

If a join needs retrying, run this once while the service is stopped:

```sh
sudo docker compose -f compose.yaml -f compose.integrations.yaml run --rm integrations python join-rooms.py
```

Then start the integration service:

```sh
sudo docker compose -f compose.yaml -f compose.calls.yaml -f compose.integrations.yaml up -d
```

Restart integrations after changing allowed users or device pins. Unknown devices block queued deliveries; the service keeps retrying with capped backoff. Check sanitized service logs and the signed-delivery response. A `sent` status means the homeserver accepted the encrypted event and all approved known devices received session keys, not that every recipient read the message. There is no integration-management web UI yet.

Back up the bot's config and data together while the service is stopped, including `crypto.db`, SQLite sidecar files, identity manifest, token, pickle key, queue key, and HMAC secrets. Matrix account key backup does not back up this bot: nio currently uses an independently pinned device without cross-signing or server-side Secure Backup support.

## 7. Send a signed webhook

`POST https://YOUR_TAVERN_DOMAIN/hooks/builds` accepts only `{"text":"..."}`. Maximum request size is 16 KiB. Authenticate these exact bytes:

```text
v1\nHOOK_ID\nUNIX_TIMESTAMP\nDELIVERY_UUID\nRAW_JSON_BYTES
```

Set `X-Tavern-Timestamp`, `X-Tavern-Delivery`, and `X-Tavern-Signature: sha256=HEX_HMAC_SHA256`. Timestamps must be within five minutes. Use the same delivery UUID for retries; generate a fresh timestamp/signature if needed. The hook ID is covered by the signature, and the room comes only from server configuration. The response is 202 after the encrypted outbox commits, or 200 for a previously accepted delivery. Replay IDs remain as tombstones.

The executable example `integrations/send-hook.py` reads the shared secret from a local file, signs a message, and submits it over HTTPS. Keep the secret on the sending system private.

## 8. Acceptance before relying on the deployment

- Two independent browser profiles: compare matching emoji and reject mismatching emoji. Confirm actual device status changes only after protocol completion.
- New recovery setup, wrong-password interruption, reload, repair, new-device recovery, incorrect recovery key, and full-history restore. Confirm older backup versions remain available.
- Two different networks: voice, video, mute, camera switching, screen sharing, remote hangup, relay-only fallback, and group conference with a third participant. Confirm no public SFU/STUN service is contacted and LiveKit cannot decrypt media.
- Uninvited users cannot read messages or join private calls. Members cannot elevate themselves through the permissions UI or direct Matrix requests.
- Signed webhook success, replay, changed body, stale timestamp, unknown device, departed member, bot restart, and recovery of a queued event. Confirm only ciphertext is stored in Matrix media/events and the bot outbox.
- Check health, route isolation, HTTPS, database backups, restoration onto a clean host, and restricted container startup.

The available tests cover application logic, official encryption primitives, and durable bot storage. Docker and live multi-browser media tests were not run in the development environment.

## Upstream references

- [Element Call deployment](https://github.com/element-hq/element-call/blob/main/docs/self_hosting.md) and [embedded client](https://github.com/element-hq/element-call/blob/main/docs/embedded_standalone.md)
- [LiveKit network ports](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
- [Synapse TURN setup](https://element-hq.github.io/synapse/latest/turn-howto.html)
- [Matrix encrypted backups](https://spec.matrix.org/latest/client-server-api/#server-side-key-backups)
- [Matrix nio](https://github.com/matrix-nio/matrix-nio)
