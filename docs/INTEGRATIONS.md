# Optional verified webhook bot

Use [Installation](INSTALLATION.md) and its root Compose stack. Existing bot
identities, crypto stores, queues, keys and configuration must be retained during
an upgrade. The steps below are **first provisioning only**, never a repair for
a missing existing identity.

Enable `INTEGRATIONS_ENABLED=true` and include `integrations` in the existing
`COMPOSE_PROFILES` list. Run the current initializer, restart Synapse and recreate
the API as described in [V3 redeploy](V3_HARDENING.md#existing-v3-redeploy).
The initializer prepares persistent configuration/data volumes and native policy;
it does not create the bot account or replace an encryption identity.

Create a dedicated ordinary Matrix bot account in Admin → Users. Invite it to
the encrypted destination room. In Admin → Integrations create the webhook,
enter the exact room ID and approve its participants, including the bot. Pin each
recipient's device fingerprint only after independently verifying it. Creating
a webhook saves `bot.json` and its HMAC key; it does not provision the bot device.

For a new bot only, create its local encryption/queue keys in the shared config
mount. This command refuses existing key files and prints no secret values:

```sh
sudo docker compose stop integrations
sudo docker compose run --rm --no-deps -T --entrypoint python tavern-api - <<'PY'
from pathlib import Path
import os, secrets
root = Path('/integrations-config')
names = ('pickle.key', 'queue.key')
if any((root / name).exists() for name in (*names, 'session.json')):
    raise SystemExit('Existing bot keys/session found. Preserve them; do not provision again.')
if not (root / 'bot.json').is_file():
    raise SystemExit('Create the webhook in Admin > Integrations first.')
os.umask(0o077)
for name in names:
    with (root / name).open('x') as stream:
        stream.write((secrets.token_hex(32) if name == 'queue.key' else secrets.token_urlsafe(48)) + '\n')
print('New bot local keys created; values omitted.')
PY
```

Provisioning must write its session to `/config`; the running bot deliberately
mounts that directory read-only. Create this **temporary first-setup override**
as `compose.bot-setup.yaml` beside the canonical file, using the same environment:

```yaml
services:
  integrations:
    volumes:
      - ${TAVERN_INTEGRATIONS_CONFIG:-integrations_config}:/config
```

Then run:

```sh
sudo docker compose -f compose.yaml -f compose.bot-setup.yaml run --rm --no-deps integrations python provision.py
sudo docker compose up -d integrations
```

Use your existing base Compose path/project if different. Do not configure the
temporary writable override in Dockhand or use it for normal startup. The
provisioner prompts privately for the bot credentials, saves the durable device
and prints its public fingerprint. It refuses to replace an existing session or
crypto store. If initial room joining failed after identity creation, keep the
identity, correct its invitation, and run `sudo docker compose run --rm --no-deps
integrations python join-rooms.py` while the normal bot is stopped.

Use Admin → Integrations for subsequent webhook configuration and device pins.
Unknown devices pause encrypted delivery. Back up configuration and data together,
including SQLite sidecars, session, identity manifest, pickle/queue keys and HMAC
keys. Preserve the bot's trust list when changing recipient devices. Matrix user
key backup does not replace this bot's local crypto backup.

The management UI provides a signed-request example. Webhooks accept bounded
text for their fixed configured room, validate HMAC/replay state and queue encrypted
delivery. A successful response is not proof that every recipient has read it.
