# Deploy Tavern from GitHub with Dockhand and NPM

`V3` contains the 0.4 development checkpoints. Further test updates are pushed
to `V3`; no 0.4 release images have been published yet.
Use [Installation and operations](INSTALLATION.md) for the complete setup and
[V3 migration](V3_MIGRATION.md) before upgrading an existing deployment.
For `OPEN_ID_ERROR` or HTTP 503 when joining a conference, see
[call authentication repair and diagnostics](CALL_AUTHENTICATION.md).

## Choose the source and Compose file

| Deployment | Compose path | Source selection |
|---|---|---|
| Git checkout with local builds | `compose.yaml` | The checked-out branch or commit |
| GitHub builds, including a pasted stack | `compose.github.yaml` | `TAVERN_GIT_REF`, default `V3` |

Both files provide the complete stack: initializer, PostgreSQL, Synapse, account
API and gateway/client, with optional calls, integrations and operations profiles.
`compose.github.full.yaml` is an equivalent compatibility alias. It does not
require enabling every optional service. The image-only `compose.dockhand*.yaml`
files require all selected images to be available already.

Remote build contexts fetch source from this public repository. Builds need
outbound access to GitHub, npm, PyPI and base-image registries. Runtime services
and persistent data remain on your Docker host; a GitHub token is not required.

## Dockhand settings

| Setting | Value |
|---|---|
| Repository | `https://github.com/Hans-Hans-Hans/Tavern_3.0.git` |
| Branch | `V3` for the test checkpoint |
| Compose path | `compose.github.yaml` |
| Stack/project name | `tavern`, retaining the existing name during upgrades |
| Build images on deploy | On |

Set private stack environment values from `.env.example`. For Hans's existing
installation, retain the original values, including:

```dotenv
TAVERN_DOMAIN=tavern.hans-homelab.com
TAVERN_DATA_DIR=/opt/tavern-data
NPM_PROXY_NETWORK=tavern_proxy
NPM_PROXY_EXTERNAL=true
TAVERN_GIT_REF=V3
```

Use the actual existing data path and network. A fresh installation can leave
`TAVERN_DATA_DIR` empty to use named volumes. Copy `.env.example` only for a fresh
installation; never overwrite an existing private environment file.

For ongoing testing, select `V3` as both the Dockhand
branch and `TAVERN_GIT_REF`. For a fixed checkpoint, use its full commit SHA for
both. Keep the Compose definition and remote build source at the same revision.
The initializer generates and preserves configuration and credentials; fresh
deployments do not need `prepare-npm.py` or `prepare-calls.py`.

Sync the Git stack and deploy with builds enabled. Follow the existing-install
procedure before the first 0.4 configuration migration, including stopping old
writers and restarting Synapse afterward to load its permission module. Keep
the same stack name, hostname, PostgreSQL volume and private data directories.

## HTTPS, accounts and calls

NPM must share the configured Docker network with Tavern. Its proxy host uses
**http**, hostname **tavern-web**, port **8080**, WebSocket support and a valid
certificate for the exact Tavern hostname. Public HTTPS terminates at NPM.

Open your HTTPS hostname. On a fresh installation, the temporary `admin` /
`admin` bootstrap requires a trusted local network and walks through real
administrator identity, a new password and email verification. Existing
installations use their existing Synapse administrator account. Configure SMTP
through the private environment or the administrator Email settings. Account
creation then follows the instance registration policy or administrator workflow.

After rebuilding, reload Tavern on its existing HTTPS hostname. For older
messages that cannot decrypt, open **History recovery** and follow
[these recovery steps](HISTORY_RECOVERY.md). Keep the original browser site data;
it may contain message keys from previous sign-ins.

To enable calls, add these values using your real public WAN IPv4:

```dotenv
COMPOSE_PROFILES=calls
CALLS_ENABLED=true
TURN_DOMAIN=turn.hans-homelab.com
PUBLIC_IP=YOUR_PUBLIC_WAN_IPV4
```

TURN/LiveKit configuration and credentials are generated in persistent storage.
Keep TURN DNS-only. Forward TCP/UDP3478, UDP49160–49200, TCP7881 and UDP7882 to
the Docker host; HTTPS TCP443 goes to NPM. Stop Synapse before first enabling
calls, deploy, then restart Synapse as described in the installation guide.
No LiveKit secret needs to be copied into Dockhand environment fields.

The calls profile builds the pinned Tavern SFU from the same V3 ref. Add
`SFU_AUDIO_MODERATION_ENABLED=true` for server mute/deafen, then rebuild and
restart as described in [audio moderation](SFU_AUDIO_MODERATION.md). The flag
defaults to off. Image-only deployments must build the SFU image beforehand.

The optional webhook bot still requires its own account, configured rooms and
verified devices. Follow the bot provisioning procedure in
[Calls and integrations](CALLS_AND_INTEGRATIONS.md), then enable the
`integrations` profile and `INTEGRATIONS_ENABLED=true`. Combine enabled profiles
with commas; keep the bot's existing encryption identity and data paths.

## CLI deployment and updates

For a fresh checkout:

```sh
git clone --branch V3 --single-branch https://github.com/Hans-Hans-Hans/Tavern_3.0.git tavern
cd tavern
cp .env.example .env
nano .env
sudo docker compose -f compose.github.yaml config --quiet
sudo docker compose -f compose.github.yaml up -d --build
sudo docker compose -f compose.github.yaml ps
```

After completing an existing-install migration, routine source updates are:

```sh
git pull --ff-only
sudo docker compose -f compose.github.yaml up -d --build
sudo docker compose -f compose.github.yaml restart synapse
```

Back up first and retain the previous source revision and compatible backup.
`docker compose pull` alone does not rebuild Git source. Changing a Git ref does
not undo database or configuration changes. Never remove volumes to update.
Use the [validation record](VALIDATION.md) for observed acceptance and remaining
checks; a healthy container alone does not prove external media connectivity.
