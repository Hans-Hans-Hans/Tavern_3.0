# V3 hardening update

This pass preserves the Matrix architecture and the existing user experience.
It does not change the hostname, signing keys, database credentials, encryption
history, room state or working media/firewall configuration.

## Changes and compatibility

| Change | Security/performance effect | Upgrade implication |
|---|---|---|
| Retired call helper | Nonzero, no-write wrapper prevents creating incompatible legacy call state. | Use root Compose `init`; historical complete call configs still migrate without credential rotation. |
| Private issuer URL retained | rtc-auth uses private LiveKit CreateRoom; validated browser responses use public WSS. Unexpected URLs and public Twirp remain denied. | Keep `RTC_AUTH_LIVEKIT_URL` unset or `http://livekit:7880`. |
| Empty proxy-trust default | Untrusted peers cannot assert forwarded client addresses. Existing right-to-left checks remain. | Set actual gateway/NPM CIDRs before upgrading; replace any inherited blanket Docker-range trust. |
| Hashed static caching | Successful hashed `/assets/*` responses cache for one year with `immutable`; HTML/config/API stay `no-store`, workers revalidate. | Remove edge rules overriding origin cache headers. No site-data clearing needed. |
| SMTP file secret | Avoids keeping the SMTP password in container environment inspection; invalid explicit files fail clearly. | Optional migration; legacy env and encrypted admin settings remain supported. File passwords override both and are not copied into admin persistence. |
| Shared-group secret permissions | Call runtime files use `root:10002`, operations token `root:10003`; directories `0750`, files `0640`. | Run init and recreate consumers together. Existing secret bytes stay unchanged. |
| Operations opt-in gate | Direct Docker access is refused unless explicitly acknowledged. | Existing operations users must set `ALLOW_DOCKER_SOCKET_ACCESS=true`; the worker still has host-root authority. |
| Internal account audit | Existing server-side authorization remains; credentials stay private. | Full Synapse admin authority remains necessary for documented native operations; see [audit](SERVICE_ACCOUNT_SECURITY.md). |
| Password-free TOTP challenge | A consumed, ten-minute grant binds enrollment to user/session/device/credential epoch; native UIA still runs while the password is in the start request. | Other devices sign out when setup begins and again on completion. Existing configured authenticators remain; pending old setup challenges must be restarted once. |
| Canonical deployment docs | Old recipes are explicitly archived under `docs/legacy/`. Current guides cover calls, integrations, operations, proxy and troubleshooting separately. | Follow [Installation](INSTALLATION.md); no legacy helper, image-tag or merged old-stack recipes. |

Secure/HttpOnly/SameSite=Strict cookies, same-origin/CSRF/Sec-Fetch-Site checks,
server-held Matrix tokens, managed credential-route blocking, private
Synapse/Postgres, federation/admin restrictions, OpenID and RTC room/device/session
authorization, TURN peer ACLs and existing container hardening are retained.

## Dockhand environment changes

| Variable | Set it to |
|---|---|
| `TRUSTED_PROXY_CIDRS` | Actual dedicated gateway/NPM subnets or stable address CIDRs, obtained with the [read-only inspection commands](PROXY_HARDENING.md). No universal safe value can be inferred from your LAN IP. |
| `ALLOW_DOCKER_SOCKET_ACCESS` | `true` only if the operations profile is intentionally enabled and you accept host-root Docker access; otherwise leave false. |
| `SMTP_PASSWORD_FILE` | Optional preferred container path, e.g. `/run/tavern-smtp/password`. |
| `TAVERN_SMTP_SECRET_DIR` | With that example, the existing Docker-host secret directory, e.g. `/opt/tavern-smtp`. See [permissions and precedence](INSTALLATION.md#administrator-setup-and-smtpgmail). |
| `SMTP_PASSWORD` | Clear its value after a successful file migration and recreate the API. Retaining the legacy setting remains supported if you are not migrating now. |
| `RTC_AUTH_LIVEKIT_URL` | Retain `http://livekit:7880`, with no surrounding whitespace, or leave unset for the same default. |

Keep existing `COMPOSE_PROFILES`, `CALLS_ENABLED`, `INTEGRATIONS_ENABLED`,
`OPERATIONS_ENABLED`, `TAVERN_DOMAIN`, `PUBLIC_IP`, `TURN_DOMAIN`, volume/bind
paths, project/network names and image/source selections. Hans's TURN hostname
remains `turn.tavern.hans-homelab.com`. Do not copy a new `.env.example` over your
private environment. For GitHub contexts keep `TAVERN_GIT_REF=V3` and the Compose
revision aligned, or pin both to the same tested full commit SHA.

## Existing V3 redeploy

This introduces a brief outage. Build first and arrange a private verified backup.
Run each command only after the previous command succeeds. Do not use `down -v`,
delete volumes, remove browser encryption stores or regenerate any identity/secret.

For a local checkout **that actually controls the running stack**, from its
directory (for example `cd ~/tavern`), keep the existing Compose file, project,
profiles, `.env` and data paths. The commands below use root `compose.yaml` with
the existing default project; retain your normal `-f`/`-p` choices if different.

1. Confirm the checkout is on V3 and keep any local operator changes:

   ```sh
   git status --short --branch
   git pull --ff-only origin V3
   ```

2. Inspect proxy networks using [this guide](PROXY_HARDENING.md) and edit only the
   settings listed above. If opting into SMTP files, install the file with the
   documented API read permissions first. Do not alter existing credentials.

3. Back up the existing stack and privately retain `.env`, manager configuration
   and any external SMTP file. Use the helper's `--compose-file`/`--project` options
   before `backup` when your running stack uses different values:

   ```sh
   sudo python3 scripts/operations.py backup --output /opt/tavern-backups
   sudo docker compose config --quiet
   sudo docker compose build
   ```

4. Stop the selected stack's services, apply idempotent permission/config repairs,
   and recreate every enabled consumer with its updated environment and groups:

   ```sh
   sudo docker compose stop
   sudo docker compose run --rm --no-deps init
   sudo docker compose up -d --force-recreate
   sudo docker compose ps
   ```

   PostgreSQL volumes stay attached. Recreating Synapse loads the current module;
   another restart is not needed. Recreating LiveKit, rtc-auth and the API applies
   their supplemental groups. If init fails, read its specific error and correct
   the deployment setting or restore a missing original file from backup; do not
   delete identity files or proceed with a partially repaired configuration.

5. Check the origin and public paths, then sign in using your existing browser:

   ```sh
   sudo docker exec npm curl --fail http://tavern-web:8080/health
   curl --fail https://tavern.hans-homelab.com/health
   sudo docker compose exec -T tavern-api python /app/call_diagnostics.py --public
   ```

   Substitute your hostname if different. Reload the page without clearing site
   storage. Test a direct and conference call across LAN/external devices, a file
   upload, email delivery, an existing authenticator login and new TOTP setup.
   Test operations only if explicitly enabled. Do not paste successful token
   responses, cookies, secret files or full environment inspection into reports.

For **Dockhand**, perform the same sequence in the existing Git stack: sync V3,
retain project/storage/source settings, update private variables, back up, build
all selected services, stop that stack, run its new `init`, then deploy/recreate
all selected services. Use that stack's real Compose context for one-off commands;
an unrelated `~/tavern` checkout cannot update Dockhand's internal checkout.
Keep the temporary bot-provisioning override out of normal deployment.

## Verification and remaining limits

Executed locally on Windows with Node 22.22.0, Python 3.12.10 and Nginx 1.28.3:

| Check | Actual result |
|---|---|
| `npm test` | 701 passed, zero failed/skipped. |
| `npm run build` | Passed, including TypeScript checking and production Vite output. |
| Python discovery (`test_*.py`) with `NGINX_BINARY` | 801 run successfully: 786 passed, 15 skipped for unavailable Linux/native dependencies. |
| Final account/security/SMTP/operations/provisioning/RTC/cache regression rerun | 90 run successfully: 87 passed, 3 POSIX permission checks skipped. |
| CI call derivation and permissions after preserving source mode/ownership | 9 run successfully: 5 passed, 4 platform checks skipped. |
| Actual Nginx static image and managed gateway fixture | Both passed: hashed JS/CSS/WASM/admin assets, 304 revalidation, missing assets, HTML/config, API/auth, service workers and denied admin/Twirp paths. Included in the Python counts. |
| `scripts/smoke-pwa.mjs` | Passed: production worker caches static resources only and opens the reconnect screen offline. |
| Docker Compose 2.39.4 `config --quiet` | All five supported files passed with every profile selected; both isolated CI overlays also passed. No daemon used. |
| `scripts/sync-compose-aliases.py --check` | Passed. |
| Python `compileall` | Passed for API, operations, initializer, Synapse modules, scripts and tests. |
| Current documentation links/anchors | Passed across 13 guides. |

The full Playwright browser suite passed **469/469** with `--workers=2`, the
configured local Chromium override and the loopback test harness (4.4 minutes).
Two earlier eight-worker runs each passed 468 and failed the synthetic camera
fixture; its isolated run passed. The fixture now respects the same browser
override as the suite. Use two workers for reproducible verification on this
Windows host; no media assertion was removed or replaced with a mocked track.

The repository-index check passed for **976 tracked files**: no ignored private
state or selected credential patterns. `git diff --check` also passed. Vite's
existing bundle-size/plugin-timing advisories did not fail the production build.

The local environment has no Docker daemon or access to the live homelab; local
Compose model validation and Nginx tests do not establish Linux container UID,
real SMTP delivery or external media success. The existing GitHub workflows retain
native Linux/container, TURN/media, recovery and rollback checks for this commit.

Remaining risks are explicit: operations still has host-root Docker control when
enabled, the account API still holds a Synapse admin credential, configured trusted
proxy subnets must not contain untrusted workloads, and legacy SMTP env secrets
remain visible until migrated. Historical messages with lost encryption keys
cannot be recovered by this update.

## Files changed

- `.env.example`
- `.github/workflows/check.yml`
- `Dockerfile`
- `README.md`
- `api/secret_files.py`
- `api/server.py`
- `app/account-settings.tsx`
- `app/admin-integrations.tsx`
- `compose.dockhand.full.yaml`
- `compose.dockhand.yaml`
- `compose.github.full.yaml`
- `compose.github.yaml`
- `compose.yaml`
- `docker/cache-control.conf`
- `docker/init/provision.py`
- `docker/nginx.conf`
- `docker/npm/headers.conf`
- `docker/npm/nginx.conf`
- `docker/prepare-calls.py`
- `docs/CALLS.md`
- `docs/CALLS_AND_INTEGRATIONS.md`
- `docs/DEPLOY_DOCKHAND_NPM.md`
- `docs/DEPLOY_GITHUB.md`
- `docs/INSTALLATION.md`
- `docs/INTEGRATIONS.md`
- `docs/OPERATIONS.md`
- `docs/PROXY_HARDENING.md`
- `docs/SERVICE_ACCOUNT_SECURITY.md`
- `docs/TROUBLESHOOTING.md`
- `docs/UX_UPDATE.md`
- `docs/V3_HARDENING.md`
- `docs/legacy/CALLS_AND_INTEGRATIONS.md`
- `docs/legacy/DEPLOY_DOCKHAND_NPM.md`
- `ops/server.py`
- `scripts/ci-call-config.py`
- `scripts/ci-gateway.py`
- `scripts/ci-live-compose.yaml`
- `scripts/ci-rollback-compose.yaml`
- `scripts/ci-rollback.py`
- `tests/browser/conference-synthetic-devices.spec.ts`
- `tests/fixtures/legacy_call_state.py`
- `tests/test_api.py`
- `tests/test_api_security.py`
- `tests/test_call_config_permissions.py`
- `tests/test_compose_provision.py`
- `tests/test_deployment.py`
- `tests/test_operations_worker.py`
- `tests/test_secret_files.py`
- `tests/test_static_cache.py`
