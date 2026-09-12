# Optional operations worker

[Installation](INSTALLATION.md) is the canonical deployment guide.

**The operations worker has host-root authority through the Docker socket.**
Its application-level project/label checks reduce mistakes; they do not contain
an attacker who compromises this container. Read-only mounting of a Unix socket
does not make Docker API requests read-only. Keep its API private.

The worker remains opt-in. All three settings are required:

```dotenv
COMPOSE_PROFILES=operations
OPERATIONS_ENABLED=true
ALLOW_DOCKER_SOCKET_ACCESS=true
```

Merge `operations` into your existing comma-separated profiles instead of
removing `calls` or `integrations`. Without explicit acknowledgement the real
worker fails before opening Docker access. If you do not need browser-operated
backups/updates, leave operations disabled and use the host backup command below.
Existing enabled deployments must add the acknowledgement before recreation.

A safely restricted socket proxy is deferred: the existing backup/restore and
update operations create helper containers, mount persistent volumes, execute
commands and replace containers. A generic endpoint allowlist would still allow
host mounts/container creation and would not provide a useful security boundary.
The worker's injected `Operator` engine is the integration point for a future
broker that validates individual resources and complete request bodies. Root,
Docker access and release-download egress remain explicit risks in this version.

## Backups and updates

Admin → Operations supports schedules, retention, downloads, isolated restore
copies and compatible web/API release updates. Production restore is never an
automatic in-place overwrite. Source builds still use the existing deployment
manager or Git checkout to upgrade.

From the checkout that controls the running stack, a host-operated backup does
not require enabling the worker:

```sh
sudo python3 scripts/operations.py backup --output /opt/tavern-backups
```

Use `--compose-file` and `--project` before `backup` if your existing deployment
uses nondefault values. A backup briefly pauses writers and preserves their prior
running state. Keep `.env`, the SMTP secret mount (bind directory or named volume) and manager settings
in a separate private backup; those are not automatically included in the
application-state archive. Downloaded archives contain identity keys and other
secrets. Store them encrypted off-host and test an isolated restore.

Follow [backup/restore details](INSTALLATION.md#backups-and-restore) and the
[existing V3 hardening redeploy](V3_HARDENING.md#existing-v3-redeploy). Never delete
volumes or replace identity files to make an update start.

The worker token directory is `root:10003` mode `0750`; the token is `0640`.
The API receives supplemental group `10003` for its private worker requests.
Root operations can read the token. Init repairs permissions without replacing
existing token bytes. Do not publish port 8091 or share the token with clients.
