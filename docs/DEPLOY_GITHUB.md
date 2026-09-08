# Deploy V3 from GitHub with Dockhand and NPM

The Compose files fetch Tavern source from this public GitHub repository and
build images on your Docker host. Dependencies and infrastructure images are
downloaded during builds/deployment; Tavern's application and services run on
your host. No GitHub token or published Tavern registry image is needed.

| File | Services | Required preparation |
|---|---|---|
| `compose.github.yaml` | Tavern gateway/client, Synapse, PostgreSQL | Base configuration |
| `compose.github.full.yaml` | Base plus coturn, LiveKit, RTC authorization, webhook bot | Base, media configuration, and bot identity |

Both files use `TAVERN_GIT_REF=V3` by default. The web build context is
`https://github.com/Hans-Hans-Hans/Tavern_3.0.git#V3`; the bot uses
`https://github.com/Hans-Hans-Hans/Tavern_3.0.git#V3:integrations`. `pull_policy: build`
rebuilds Tavern images from source. Docker's Git contexts support a branch, tag,
or full commit SHA. See the [Docker build reference](https://docs.docker.com/reference/compose-file/build/).

## Prepare a new instance once

Use a Docker host with Docker Engine, Compose V2 with BuildKit/buildx, Git, and
Python 3. NPM must run on the same Docker host. Node.js is supplied inside the
build image. This walkthrough assumes Linux; Windows users can use Docker
Desktop with WSL2 and run these host commands inside their Linux distribution.

For an existing older Tavern deployment, first read [V3 migration](V3_MIGRATION.md).
Existing Matrix deployments should retain their generated data and skip the
preparation helper.

Clone the branch to obtain its preparation scripts and guides:

```sh
git clone --branch V3 --single-branch https://github.com/Hans-Hans-Hans/Tavern_3.0.git tavern-v3
cd tavern-v3
sudo python3 docker/prepare-npm.py \
  --domain chat.example.com \
  --synapse-image matrixdotorg/synapse:v1.160.0 \
  --data-dir /opt/tavern-data
sudo chown -R 991:991 /opt/tavern-data/synapse
```

Replace the domain before running the helper. This is the Matrix account domain
and must remain stable. Review the [official Synapse release notes](https://github.com/element-hq/synapse/releases)
when selecting/upgrading its pinned version. The example is the version against
which the call configuration was written, not a claim that it is the newest.

The helper creates a private `.env` and instance configuration. It refuses to
overwrite existing data/secrets. **Do not copy `.env.example` to `.env` first**;
the example documents fields and intentionally has no secrets. Keep
`/opt/tavern-data` outside all source checkouts and Docker build contexts. The
clone is for one-time provisioning; remote image builds do not use its path.

Connect NPM to the external `npm_proxy` network, configure the Proxy Host, and
set Cloudflare DNS using sections 2, 4, and 5 of the
[NPM guide](DEPLOY_DOCKHAND_NPM.md). Forward to `tavern-web:8080`, enable WebSocket
support, and use a valid certificate with Force SSL. Start with Cloudflare
DNS-only. Synapse and PostgreSQL have no published host ports.

## Create the Dockhand Git stack

In Dockhand, create a Git-backed stack on the Docker environment holding your
private data. Set:

| Setting | Value |
|---|---|
| Repository | `https://github.com/Hans-Hans-Hans/Tavern_3.0.git` |
| Branch | `V3` |
| Compose path | `compose.github.yaml` |
| Stack/project name | `tavern` (retain an existing Matrix stack's name) |
| Build images on deploy | **On** |

Enter these in Dockhand's private stack environment:

```dotenv
TAVERN_DOMAIN=chat.example.com
SYNAPSE_IMAGE=matrixdotorg/synapse:v1.160.0
TAVERN_DATA_DIR=/opt/tavern-data
NPM_PROXY_NETWORK=npm_proxy
TAVERN_GIT_REF=V3
```

Use your actual hostname, paths, network, and reviewed Synapse image. Host bind
paths refer to the selected Docker environment; they do not live inside the
Dockhand container. `TAVERN_SOURCE_DIR` is not used by the GitHub Compose files.
Enable **Build images on deploy**, which Dockhand leaves off by default, then
deploy. See [Dockhand's manual](https://dockhand.pro/manual/).

For a pasted stack, paste the GitHub Compose file and set the same environment;
its remote build contexts still fetch GitHub source. Git-backed stacks also
fetch changes to the Compose definition itself.

Alternatively, from the clone with its generated `.env`:

```sh
sudo docker compose -f compose.github.yaml config --quiet
sudo docker compose -f compose.github.yaml up -d --build
sudo docker compose -f compose.github.yaml exec synapse register_new_matrix_user \
  -c /data/homeserver.yaml http://localhost:8008
```

Create accounts interactively, then open your HTTPS Tavern hostname. Verify with
`python3 docker/verify-deployment.py https://chat.example.com` and the multi-user
acceptance checks in the deployment guides.

## Add calls and integrations

Start with the base stack so the Matrix bot can be provisioned against a running
homeserver. Follow the media configuration, DNS/router, and bot preparation
sections in [calls and integrations](CALLS_AND_INTEGRATIONS.md). Those sections
describe the local-image deployment; use these replacements for GitHub builds:

1. Generate media configuration with `docker/prepare-calls.py`, while Synapse is
   stopped as directed. Add the generated `LIVEKIT_KEY` and `LIVEKIT_SECRET`
   from `/opt/tavern-data/calls/jwt.env` to Dockhand's private stack environment.
   CLI users can append those two values to their private `.env` using an editor.
   Restart the base stack before provisioning the bot:
   `sudo docker compose -f compose.github.yaml up -d --build`.
2. Build the bot image directly from GitHub:

   ```sh
   docker build -t tavern-integrations:v3 \
     'https://github.com/Hans-Hans-Hans/Tavern_3.0.git#V3:integrations'
   ```

3. Create the bot directories/secrets, edit the example configuration with real
   room/user IDs and verified fingerprints, and run the guide's provisioning
   command with image **`tavern-integrations:v3`**. Use your actual Matrix stack's
   private Docker network. Never put the bot token or keys into GitHub.
4. Change Dockhand's Compose path to **`compose.github.full.yaml`** and redeploy
   with image builds enabled. Keep the same stack/project name and data paths.
   CLI equivalent: `sudo docker compose -f compose.github.full.yaml up -d --build`.

The full file requires both calls and bot provisioning; it does not silently
create a bot account or fill in missing secrets. To deploy calls without the
bot, remove only the `integrations` service from a pasted copy of the full file.
Run the guide's live call/device/recovery acceptance checks before relying on it.

If a bot room join needs retrying, stop the integration service, ensure the bot
has an invitation, and use this GitHub equivalent of the local-image command:

```sh
sudo docker compose -f compose.github.full.yaml run --rm --no-deps integrations python join-rooms.py
```

Then redeploy the full GitHub stack. Keep its existing bot store and session.

## Updates and rollback

Back up PostgreSQL and the private data directory consistently before upgrading.
In Dockhand, sync the Git stack and deploy with builds enabled. With a CLI clone,
run `git pull --ff-only`, then repeat `up -d --build` using the selected Compose
file. `docker compose pull` alone does not rebuild Tavern source.

For controlled rollouts, set `TAVERN_GIT_REF` to a reviewed full commit SHA and
use the matching Compose revision. To roll back application code, restore the
previous ref/Compose revision and rebuild. Database or configuration changes may
also require a compatible backup; changing a Git ref does not reverse them.
Preserve the Matrix hostname, project name, volume, and private data paths.
Never remove volumes to update the application. Infrastructure versions must
be reviewed separately. Build images need network access to GitHub, npm, PyPI,
and their base-image registries.
