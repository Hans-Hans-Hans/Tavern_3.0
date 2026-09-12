# Install and operate Tavern

Use the root **compose.yaml** for the complete installation. Messaging stays in
Synapse/PostgreSQL; the Tavern account service adds secure browser sessions,
email and account administration. The initializer creates fresh configuration
and credentials in persistent Docker volumes. Calls and the verified webhook
bot are optional profiles in the same file.

Current topics: [Calls](CALLS.md), [Integrations](INTEGRATIONS.md),
[Operations](OPERATIONS.md), [NPM/Cloudflare hardening](PROXY_HARDENING.md),
[Troubleshooting](TROUBLESHOOTING.md). For this update use the
[existing V3 redeploy procedure](V3_HARDENING.md#existing-v3-redeploy).

## Requirements

- Linux Docker host with Docker Engine and Docker Compose V2; Docker Desktop
  with Linux containers is suitable for development. This is Compose deployment,
  not Docker Swarm.
- A stable public DNS hostname and a trusted HTTPS certificate. Keep an existing
  Tavern hostname and Matrix server identity unchanged.
- An HTTPS reverse proxy such as your existing Nginx Proxy Manager (NPM).
- Enough disk for message metadata, media and backups. Start with a normal
  homelab VM and monitor actual memory and storage rather than adding caches or
  worker containers that are not needed.
- SMTP for email verification, recovery and email MFA. Gmail App Passwords are
  supported.

## Fresh installation

```sh
git clone --branch V3 https://github.com/Hans-Hans-Hans/Tavern_3.0.git tavern
cd tavern
cp .env.example .env
nano .env
docker compose up -d
docker compose ps
```

Set **TAVERN_DOMAIN** to your actual lowercase hostname, for example
`tavern.hans-homelab.com`. Set the actual trusted proxy CIDRs using [proxy inspection](PROXY_HARDENING.md) before sign-in. Set SMTP variables when available. Leave
`TAVERN_DATA_DIR` empty for named volumes. `docker compose up -d` builds missing
application images; use `--build` after updating source.

The `init` container exits successfully after provisioning; this is expected.
PostgreSQL, Synapse, the API and the gateway start in dependency order. Failed
validation stops startup with an explanation in `docker compose logs init`.
Credentials are generated once and never regenerated during ordinary startup.
No generated key or database password is written to the source tree or public
client configuration.

Persistent volumes survive `docker compose down`, subsequent `up`, and image
replacement. **Do not use `down -v` to update an installation.**

## Existing Tavern installations

Do not copy `.env.example` over an existing `.env`, run the old preparation
helper again, rename the Compose project, or switch to empty volumes. Before
switching to the canonical stack, take the previous deployment guide's backup.

Keep your original settings and add the new settings:

```dotenv
TAVERN_DOMAIN=tavern.hans-homelab.com
TAVERN_DATA_DIR=/opt/tavern-data
NPM_PROXY_NETWORK=tavern_proxy
NPM_PROXY_EXTERNAL=true
```

Use the values actually in your existing deployment. `TAVERN_DATA_DIR` preserves
the existing `synapse/`, `secrets/` and `calls/` directories. The existing
`tavern_postgres_data` volume remains in use when the project stays `tavern`.
If you use the bot, also retain:

```dotenv
TAVERN_INTEGRATIONS_CONFIG=/opt/tavern-data/integrations/config
TAVERN_INTEGRATIONS_DATA=/opt/tavern-data/integrations/data
```

Stop the old application writers before the first configuration migration:

```sh
docker compose stop tavern-web synapse
docker compose up -d --build
docker compose restart synapse
```

Stop the old integrations service too if it is running. The initializer checks
that the hostname and database password still match, preserves account identity
and media, installs the permission module, and keeps a before-image of the
configuration. The explicit Synapse restart loads the new module even when an
existing container did not need recreation.

**Existing installations never enable `admin/admin`.** Sign in with your
existing Synapse administrator account. A missing Synapse configuration with an
existing PostgreSQL volume is treated as a recovery error, not a fresh install.

This migrates the existing Matrix-based Tavern stack. The older non-Matrix
FastAPI prototype has a separate data model; see [V3 migration](V3_MIGRATION.md).

## Nginx Proxy Manager and domains

The default stack creates a Docker network called `tavern_proxy`. Connect NPM:

```sh
docker network connect tavern_proxy npm
```

Retain that network in NPM's own Compose configuration so attachment survives
NPM recreation. If the network already exists, set `NPM_PROXY_EXTERNAL=true` in
Tavern's environment. If your NPM uses another network, use its actual name in
`NPM_PROXY_NETWORK`.

Create or edit the Tavern Proxy Host:

| NPM field | Value |
|---|---|
| Domain Names | Your exact `TAVERN_DOMAIN` |
| Scheme | **http** |
| Forward Hostname / IP | `tavern-web` |
| Forward Port | **8080** |
| WebSocket Support | On |
| SSL certificate | Must cover the Tavern hostname |
| Force SSL | On |

NPM handles public HTTPS; Tavern listens for **HTTP** inside Docker. Selecting
HTTPS for the upstream causes `SSL_do_handshake ... wrong version number` and a
502 error. A `*.home.example.com` certificate does not cover `chat.example.com`.

Set `TRUSTED_PROXY_CIDRS` to the actual trusted NPM/gateway Docker subnets using [these inspection commands](PROXY_HARDENING.md). Its default is empty; forwarded requests fail closed until you configure it. Do not
trust arbitrary public networks. The gateway sanitizes forwarded client
addresses before bootstrap and account rate limits use them. Bootstrap should
be completed directly on the LAN, using local DNS if public access traverses
Cloudflare.

The gateway also binds `127.0.0.1:8080` for host-local diagnostics. Change
`TAVERN_BIND_IP` only when a proxy on another machine must reach the host; use a
specific LAN address. Continue browsing via the HTTPS hostname.

Cloudflare's Tavern record points at your public WAN IPv4; TCP443 forwards to
NPM's published HTTPS listener (in Hans's installation, `10.10.30.80:443`). Use
Full (strict) after configuring the correct origin certificate. A LAN DNS
override may point the same hostname directly at NPM's LAN address. Keep that
override consistent for A and AAAA lookups. TURN must remain DNS-only.

## Administrator setup and SMTP/Gmail

On a **fresh installation**, open the HTTPS Tavern hostname from a trusted local
network. The temporary `admin` / `admin` login starts administrator setup; it is
not a Matrix account with a reusable default password. Complete your identity,
strong password, email verification and instance settings. Completed setup is
persisted, and default bootstrap login cannot be used again.

Configure your dedicated Gmail account with two-step verification and create
an App Password. Use the App Password, not the account's ordinary password:

```dotenv
SMTP_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USERNAME=your-tavern-account@gmail.com
TAVERN_SMTP_SECRET_DIR=/opt/tavern-smtp
SMTP_PASSWORD_FILE=/run/tavern-smtp/password
SMTP_PASSWORD=
SMTP_FROM_NAME=Tavern
SMTP_FROM_ADDRESS=your-tavern-account@gmail.com
```

Create `/opt/tavern-smtp` on the Docker host with owner `root:10001`, mode
`0750`, and put the App Password in `password` with owner `root:10001`, mode
`0640`. Use a private editor or secret manager, not a command containing the
password. The directory is mounted read-only. Choose your own private absolute
directory if different; the in-container path above stays the same. Ensure any
rootless/user-namespace mapping gives the API's UID/GID 10001 read access.

An explicitly configured file wins over saved settings and legacy
`SMTP_PASSWORD`, even when the file is empty. One trailing LF or CRLF is removed;
other whitespace is preserved. An unreadable/invalid file stops API startup with
a clear error. After rotating the file, restart the API. When changing mount or
environment settings, recreate it. Admin Email still reports only
`passwordConfigured`; while the file is configured its password must be changed
in that file, not the UI. Other Email settings remain editable.

Without a file, existing encrypted Admin Email settings retain their override of
the legacy environment defaults. `SMTP_PASSWORD` remains compatible but is
deprecated because container inspection exposes it. After successfully migrating
to a file, remove the password value from Dockhand's environment and recreate the
API. Back up the external secret privately alongside deployment settings.

`SMTP_SECURE=false` uses STARTTLS; TLS is still required. Port465 normally uses
`SMTP_SECURE=true`. Settings can also be managed from Tavern's administrator
Email settings, including connection and test-email checks. Saved passwords
are not redisplayed. Mail delivery requires actual SMTP credentials and outbound
access from the API; no software check can create your Gmail account for you.

## Voice, video, screen sharing and TURN

Set the following in the same `.env`:

```dotenv
COMPOSE_PROFILES=calls
CALLS_ENABLED=true
TURN_DOMAIN=turn.tavern.hans-homelab.com
PUBLIC_IP=YOUR_PUBLIC_WAN_IPV4
```

Use a real public IPv4 in place of the placeholder. Before first enabling calls,
stop Synapse so the initializer can safely add its call configuration:

```sh
docker compose stop synapse
docker compose up -d --build
docker compose restart synapse
```

TURN and LiveKit credentials are generated in the persistent calls volume and
loaded directly by RTC authorization. No copying of LiveKit secrets into stack
environment fields is needed. Existing legacy call credentials are
preserved and converted to the file interface when both config files exist.

The calls profile builds Tavern's pinned SFU from `docker/sfu`. For independent
server mute/deafen, enable `SFU_AUDIO_MODERATION_ENABLED=true`, rebuild and restart
the native policy as described in [audio moderation](SFU_AUDIO_MODERATION.md).
Image-only managers must build `tavern-sfu-audio:0.4.0` first. Audio moderation
defaults to off; clearing a mute may require the affected member to rejoin.

The account API checks current room and account permissions before issuing a
conference token and before every signaling connection or reconnect. Keep the
issuer and LiveKit HTTP services private and use the shipped gateway routes;
see [conference authorization](RTC_AUTHORIZATION.md) for removal timing and
service-outage limits. Raw issuer logs are disabled because upstream transport
errors can contain credentials; the account API records sanitized diagnostics.
The issuer uses `RTC_AUTH_LIVEKIT_URL=http://livekit:7880` internally; browsers
receive the public HTTPS host's WebSocket address. For call authorization errors,
use the [read-only call diagnostic and upgrade instructions](CALL_AUTHENTICATION.md).

| Public ports forwarded to Docker host | Purpose |
|---|---|
| TCP443 to NPM | HTTPS, Matrix signaling, LiveKit WebSockets |
| TCP/UDP3478 | TURN/STUN |
| UDP49160–49200 | TURN relayed media |
| TCP7881 | LiveKit TCP media |
| UDP7882 | LiveKit UDP media |

Create the TURN hostname as **DNS-only**. Enable WebSockets on the Tavern NPM
host. UDP ports go directly to the Docker host, not through an HTTP proxy.
Test calls between separate networks, including one mobile-data participant;
passing a local health endpoint does not prove external media routing.

## Background notifications

Signing in again in the same browser replaces its previous cookie session.
Other devices keep their sessions, and native Matrix devices and encryption keys
are retained. Delayed responses from the retired session cannot restore its cookie.

Set `WEB_PUSH_ENABLED=true` in the existing `.env`, then run
`docker compose up -d --build`. Users opt in separately from **Settings →
Notifications → Background notifications**. Tavern creates the VAPID signing
key once in the existing account data volume; preserve that volume and its
encryption key during updates and backups. No browser vendor account or manually
copied push secret is required.

Synapse must reach `https://TAVERN_DOMAIN/_matrix/push/v1/notify`, and the account
API must reach public browser push providers over HTTPS. The shipped Compose
networks provide outbound access. Keep private-address SSRF protection enabled:
a DNS override inside the Synapse container that resolves Tavern to a LAN or
Docker address will block this callback. Clients may still use local DNS while
the server resolves the public hostname through its external route.

Notices contain only generic activity text. Session expiry, browser permission,
native notification rules, DND and current room access affect delivery. Encrypted
mentions and incoming-call recognition still require an open client. See
[background notification behavior](WEB_PUSH.md) for browser restrictions,
foreground handoff and the remaining real-device acceptance.

## Webhook bot

The optional integrations profile needs an actual bot account, room invitation,
persistent encryption identity and verified participant devices. Follow the
[current integrations guide](INTEGRATIONS.md), then
set `COMPOSE_PROFILES=calls,integrations` (or `integrations` without calls) and
`INTEGRATIONS_ENABLED=true`. Recreate the API after changing these settings.
Admin integration settings write the shared bot configuration and HMAC key files;
the bot's encryption identity and message queue remain in its separate data volume.

After the bot and an encrypted channel webhook are configured, server managers
can open **Server settings → System notices** to select that destination and
enable join/leave notices. The existing integrations profile enables the native
worker; each server's route starts off. Redeploy and restart Synapse after
updating the policy modules. The account service creates the private signing
configuration on first enable. Recipient and device approvals remain required;
see [system notice setup and delivery limits](SYSTEM_MESSAGES.md).

## Installed app, calls, and offline behavior

Use Settings → About → Install Tavern to open the browser installation prompt or
the instructions for your device. Tavern includes native PNG icons for desktop
and mobile home screens. Browser notification and microphone permissions remain
under the device owner's control.

The service worker stores a versioned public app shell and its exact static
assets. It never caches account APIs, Matrix responses, uploads, call media,
runtime configuration, or credentials. A previously opened installation can
display its reconnect screen offline. Conversations already loaded in memory
stay visible when a connection drops; this static cache does not create a second
message archive. Reconnect uses Matrix's existing sync retry and the account
gateway's retry flow.

An available app update shows a reload banner. Sign out and finish calls in
every open Tavern window before applying it. All windows must confirm they can
reload; an active encrypted session or a nonresponsive window blocks activation.
No automatic service-worker reload interrupts a call or encryption operation.

Direct calls have microphone/camera selection, supported browser speaker
selection, local input testing, volume, noise suppression, echo cancellation,
automatic gain, deafen, and push to talk. Push to talk works while the Tavern
window has focus; releasing the key, losing focus, or hiding the page mutes
audio immediately. Deafen also mutes the microphone; turning deafen off leaves
the microphone muted until you choose to speak again.

Conferences stay connected while switching channels or minimizing the dock.
The embedded call app handles media devices, local participant volume, and screen
sharing. The participant list comes from real MatrixRTC memberships. Context
menus offer identity verification. Keep its crypto store across deployments.

With the canonical calls profile, channel moderators can choose **Remove from
channel and call**. Synapse authorizes the channel kick using the moderator's
own account and role hierarchy; only then does the API disconnect the matching
LiveKit devices. A confirmation explains the membership change. If the media
service fails afterward, Tavern reports that membership was removed but the
media disconnect remains unconfirmed.

This action supports the pinned `lk-jwt-service:0.6.0` legacy MatrixRTC identity
mapping used by the bundled call app. It fails before changing membership if
device identities cannot be verified. It removes current participation; it is
not a server ban or a promise to revoke previously issued LiveKit tokens. See
the [LiveKit participant API](https://docs.livekit.io/reference/other/roomservice-api/)
and [pinned authentication service](https://github.com/element-hq/lk-jwt-service/blob/v0.6.0/handler.go).

## Dockhand and Portainer

Use repository `https://github.com/Hans-Hans-Hans/Tavern_3.0.git`, branch `V3`,
project name `tavern`, and Compose path `compose.yaml` for a Git checkout build.
Enable image builds during deployment and enter `.env` values in the manager's
private stack environment. Relative paths are resolved from the checkout.

For the V3 test checkpoint, select branch `V3`. For a pasted stack without a
checkout, use `compose.github.yaml`, which is a
generated copy of the same complete stack with remote Git build contexts. Set
`TAVERN_GIT_REF` to the same branch or full commit SHA as the selected Compose
revision; it defaults to `V3`. See [GitHub deployment](DEPLOY_GITHUB.md).
`compose.github.full.yaml` is retained as an equivalent alias; profiles select
optional services in either file. `compose.dockhand*.yaml` are image-only copies
for installations that have already built or pulled every selected image.
No deployment now needs to merge multiple Compose files.

## Backups and restore

The host helper pauses application writers, creates a PostgreSQL dump, archives
all persistent Synapse/API/bot files, records integrity digests, and restarts the
previously running writers even when backup fails:

```sh
sudo python3 scripts/operations.py backup --output /opt/tavern-backups
```

Use a private destination with enough free space. The archive includes server
identity keys and other secrets required for restoration; protect it with
encrypted off-host storage. Keep the private deployment `.env` separately.
Neither HTTP downloads nor client crypto exports replace a full server backup.

To schedule the host command, put it in your operating system's scheduler during
a quiet window. It briefly stops messaging writes. Review exit status and move
completed `tavern-*.tar` archives off-host; `.partial` is never a complete backup.

Restore only into a new, isolated deployment with **empty persistent volumes**,
matching hostname and compatible image versions. Clear old bind paths from the
restore deployment's `.env` so it cannot reference production storage. Build the
init image first if needed:

```sh
docker compose build init
sudo python3 scripts/operations.py --project tavern-restore restore --archive /opt/tavern-backups/tavern-TIMESTAMP.tar
```

The helper verifies all hashes and paths before restoring. It rejects existing
PostgreSQL or application data and uses a transactional PostgreSQL restore.
It does not erase a running installation or automatically change DNS. Test
accounts, messages, uploaded files and encryption recovery before moving traffic.

## Updates and version tracking

The Admin diagnostics and updates endpoints report actual checks and GitHub
release metadata. Build metadata is exposed at `/api/system/version`. Tagged
releases run the test/build/deployment pipeline before publishing application,
API, initializer and integration images to GHCR. Tags must match package.json.

For source deployments, back up first, then:

```sh
git pull --ff-only
docker compose up -d --build
docker compose restart synapse
```

Review database/configuration changes before updating infrastructure images.
Rolling back a source ref does not undo database migrations; use the matching
backup when a schema change requires it. Preserve volumes and `.env`.

**The optional worker has host-root authority through Docker.** Read the
[operations security boundary](OPERATIONS.md) before explicitly enabling it
for backups and updates from the Admin UI:

```dotenv
COMPOSE_PROFILES=operations
OPERATIONS_ENABLED=true
ALLOW_DOCKER_SOCKET_ACCESS=true
```

Include `calls` or `integrations` in the comma-separated profile list if needed.
Redeploy with builds enabled. Only the operations worker receives the Docker
socket; its authenticated private API restricts actions to this exact Compose
project and explicitly labeled Tavern services. The account API has no socket.
The worker is a privileged host operator and must remain on the private network.

Admin operations support full manual backup, download, delete, retention and
daily UTC schedules. Backup jobs briefly pause application writes, persist
their job status and restart the previous writers. A browser may reconnect
while this happens. Restore creates **a separate stopped copy in new volumes**
after the typed confirmation `RESTORE TO ISOLATED COPY`; production is never
overwritten. Test the restored copy before choosing any traffic cutover.

Automatic updates require the web and API to use official GHCR release images.
Select stable or prerelease and a daily UTC update time. Updates are restricted
to the current major/minor version line, always create a backup first, replace
only the Tavern web/API containers and check their health. If startup fails,
the previous application containers are restarted. Synapse, PostgreSQL, TURN,
NPM and unrelated services are never automatically updated. Review other
release lines and database migrations manually. Release metadata and history
show successful, failed and interrupted operations rather than assumed status.

## Troubleshooting and validation

```sh
docker compose ps
docker compose logs --tail=100 init tavern-api synapse tavern-web
docker exec npm curl --fail http://tavern-web:8080/health
python3 docker/verify-deployment.py https://YOUR_TAVERN_HOSTNAME
```

| Symptom | Check |
|---|---|
| Initializer fails | Read its validation error; never delete identity files to force setup. |
| NPM502 with SSL upstream error | Set NPM upstream scheme to HTTP and port8080. |
| Certificate mismatch | Assign a certificate covering the exact Tavern hostname. |
| Cloudflare522 but LAN works | Verify Cloudflare origin target, public TCP443 forwarding, and firewall. |
| Mixed local/public DNS answers | Query the LAN DNS server directly for both A and AAAA records. |
| Setup unavailable on an existing server | Sign in with the existing administrator; default bootstrap is intentionally absent. |
| Email code never arrives | Test SMTP connection, sender/App Password and outbound connectivity. |
| Calls connect locally only | Check DNS-only TURN, public IPv4 and direct media port forwards. |

The local development machine may validate Compose and tests without a Docker
daemon. The CI workflow contains an actual fresh-stack startup and down/up
persistence check; external DNS, TLS, Gmail and two-network calling still require
your configured infrastructure.
