# Tavern

Tavern is a self-hosted messaging and community application built on Matrix. Encrypted conversations, communities, account security, calls, and administration run in one Docker Compose stack.

The **0.4 development test checkpoints** and further updates are on `V3`. It is undergoing integration testing; no 0.4 release or container image has been published. See the [features](docs/FEATURES.md), [implementation checklist](docs/IMPLEMENTATION_CHECKLIST.md), and [validation record](docs/VALIDATION.md) for implemented behavior and remaining acceptance checks.

## Requirements

- A Linux Docker host with Docker Compose V2 and persistent storage.
- A stable hostname, HTTPS certificate, and reverse proxy such as Nginx Proxy Manager.
- An SMTP account for email verification, recovery, and email MFA.
- Public TURN/media routing when enabling voice and video.

## Docker deployment

For a **fresh test installation** of the development version:

```sh
git clone --branch V3 https://github.com/Hans-Hans-Hans/Tavern_3.0.git tavern
cd tavern
cp .env.example .env
nano .env
docker compose up -d --build
docker compose ps
```

Set `TAVERN_DOMAIN` and SMTP settings before setup. The initializer generates and preserves credentials in private Docker volumes. PostgreSQL, Synapse, the account API, and the web gateway start from the same Compose file. The successful initializer exits; this is expected.

**Existing installations:** follow [the migration procedure](docs/INSTALLATION.md#existing-tavern-installations) before switching. Preserve your hostname, Compose project, database volume, `.env`, and data directory. Do not run `docker compose down -v` during an update.

## Environment

[.env.example](.env.example) documents configuration. Calls, integrations, and operations are optional profiles. Generated database, TURN, LiveKit, and account-service secrets stay outside the repository. Application images build from source until a release is published.

## Domains and Nginx Proxy Manager

Connect NPM to `tavern_proxy` and forward the Tavern hostname to **`http://tavern-web:8080`**, with WebSocket support enabled. Select a certificate covering the actual hostname and enable public HTTPS. An HTTPS upstream on port 8080 causes a 502.

Cloudflare's public record must point to your WAN address; TCP 443 must reach NPM. A LAN DNS override can point the same hostname to NPM's LAN address. Configure trusted proxy subnets to match your installation. Complete first setup through the trusted LAN path.

## SMTP/Gmail and first account

Use a dedicated Gmail account with two-step verification and an App Password. Set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false` (required STARTTLS), username, App Password, and sender address. After setup, **Admin → Email** can update settings, test the connection, and send test mail. Saved passwords are never redisplayed.

On a fresh instance, `admin` / `admin` opens the one-time administrator setup from a trusted private network. Create your real identity, choose a strong password, and verify your email. The temporary login is then permanently invalidated. Existing instances use their existing administrator account. Users manage passwords, email, MFA, and sessions in **Settings → Account & security**.

## TURN and firewall ports

Set `COMPOSE_PROFILES=calls`, `CALLS_ENABLED=true`, `TURN_DOMAIN`, and `PUBLIC_IP`. The initializer generates TURN and LiveKit credentials. The TURN hostname must be **DNS-only**.

| Public forwarding | Destination |
|---|---|
| TCP 443 | NPM HTTPS listener |
| TCP/UDP 3478 | Docker host, TURN/STUN |
| UDP 49160–49200 | Docker host, TURN relay |
| TCP 7881 | Docker host, LiveKit media |
| UDP 7882 | Docker host, LiveKit media |

See [installation](docs/INSTALLATION.md#voice-video-screen-sharing-and-turn) for enabling calls on an existing server, and [calls and integrations](docs/CALLS_AND_INTEGRATIONS.md) for bot account/device setup. Test media between separate networks.

## Backups, restore, and updates

Enable the `operations` profile and `OPERATIONS_ENABLED=true` for **Admin → Operations**. It supports backup schedules, retention, downloads, isolated restore copies, version checks, and opt-in compatible Tavern web/API patch updates. Only the scoped operations worker receives Docker access.

Backups include database, configuration, media, and secrets; keep downloaded archives private. A browser restore creates an isolated copy. Production recovery and upgrades use the documented [operations procedure](docs/INSTALLATION.md#backups-and-restore), including health checks and rollback. Source deployments update with `git pull` and `docker compose up -d --build` after reviewing migrations and taking a backup.

## Troubleshooting

```sh
docker compose ps
docker compose logs --tail=100 init tavern-api tavern-web synapse
docker exec npm curl --fail http://tavern-web:8080/health
```

A healthy local gateway does not establish external routing or TURN reachability. Check DNS, NPM's upstream scheme, certificate, and WAN forwarding separately. See [installation](docs/INSTALLATION.md) and [validation](docs/VALIDATION.md) for operational checks.

## Development

Use Node 22.13 or later. Run `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`. Python and browser checks are defined in the [CI workflow](.github/workflows/check.yml). The workflow also builds real containers and tests fresh initialization, backup recovery, and HTTPS messaging. Release changes are recorded in [CHANGELOG.md](CHANGELOG.md).
