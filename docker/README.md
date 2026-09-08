> For the current Dockhand + NPM deployment, use [the dedicated guide](../docs/DEPLOY_DOCKHAND_NPM.md) and the Compose files at the project root. This file describes the older optional Caddy deployment.

# Private Docker deployment

This runs the entire Tavern stack on your own host. Prerequisites: Docker Engine with Compose, Python 3, two DNS names pointing at the host, and inbound 80/443 for Caddy certificates. For a VPN-only deployment, use trusted HTTPS certificates appropriate to your VPN/DNS setup; the client deliberately requires HTTPS.

## Configure

Choose a current, supported release from the [official Synapse releases](https://github.com/element-hq/synapse/releases), then supply its exact image tag. The helper refuses `latest`, generates fresh secrets locally, and never overwrites an existing server identity. The Matrix server name becomes part of every account ID and must remain stable.

From this directory:

```sh
python3 configure.py \
  --server-name matrix.example.com \
  --web-domain chat.example.com \
  --synapse-image matrixdotorg/synapse:vX.Y.Z
sudo chown -R 991:991 synapse
docker compose up -d --build
docker compose ps
```

Replace `vX.Y.Z` with the release you selected; it is not a literal image tag. The configuration creates `.env` and `synapse/` with private permissions. Do not commit or share them. The `chown` grants the Synapse container access to its private config, signing key, and media directory.

The official image creates the server signing key at first startup if missing. Its path and the whole Synapse data directory must be preserved. Inspect startup logs if the homeserver remains unhealthy:

```sh
docker compose logs --tail=100 synapse
```

## Create accounts

Registration is closed. Create the first account interactively (the password will be prompted rather than placed in command history):

```sh
docker compose exec synapse register_new_matrix_user \
  -c /data/homeserver.yaml http://localhost:8008
```

Repeat for teammates. Create an admin account only when necessary. The registration shared secret stays in the private configuration; Synapse's admin API is not routed through Caddy. The server and database are accessible only on the internal Compose network.

Open your Tavern domain, choose **Connect homeserver**, confirm the prefilled `https://matrix.example.com` address, then enter your local Matrix ID and password. Create an encrypted Guild and invite the other local account using its full `@name:matrix.example.com` ID.

## Network policy

- Caddy is the sole published service. Matrix client/media/SSO client paths are routed; federation and admin routes return 404.
- Synapse is on an `internal: true` network without an outbound route. It cannot federate or reach third-party services. Caddy is also attached to the edge network for TLS issuance.
- Postgres is not published. Tavern's nginx runs as UID 101 with a read-only filesystem and a temporary `/tmp` mount.
- Public room discovery, open registration, guests, previews, statistics reporting, external key servers, and federation are disabled.
- New Guilds created in Tavern additionally set `m.federate: false`. Existing rooms on an externally supplied homeserver retain that server's policies.
- If you later enable mail, external SSO, federation, or media services, design explicit egress rules. Do not simply remove the private-network boundary without reviewing the effect.

## Backup and restore

Take consistent backups by pausing Synapse writes. Store backups securely; they include server secrets and metadata even when message content is encrypted.

```sh
mkdir -p backups
chmod 700 backups
docker compose stop synapse
docker compose exec -T postgres pg_dump -U synapse -Fc synapse > backups/synapse.dump
sudo tar -czf backups/synapse-files.tar.gz synapse .env
docker compose start synapse
```

Use dated destinations in your backup scheduler to avoid overwriting previous copies. If a backup command fails, restart Synapse after resolving it; do not treat the failed files as a complete backup.

To restore, use an isolated new host with the same server name, compatible pinned Synapse/Postgres versions, and no running Synapse. Restore `synapse/` and `.env` from your selected backup, maintain UID 991 ownership, start only Postgres, then restore into the new empty database:

```sh
docker compose up -d postgres
cat backups/synapse.dump | docker compose exec -T postgres pg_restore -U synapse -d synapse --no-owner
docker compose up -d
```

Do not run the restore over a populated database. Validate restored accounts, rooms, encryption/key recovery, and media before moving DNS. Client encryption key exports/backups are separate from the server backup.

## Status

The static client build and crypto-library checks are run during development. This environment has no Docker daemon or supplied homeserver, so this Compose deployment and live two-account workflows still require acceptance testing on your host. See the root README for limitations and the verification checklist.
