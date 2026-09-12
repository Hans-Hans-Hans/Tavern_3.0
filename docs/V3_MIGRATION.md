# V3 and existing Tavern deployments

`V3` contains the 0.4 development checkpoints for testing. Further pushes continue
on `V3`. The repository name `Tavern_3.0` and branch `V3`
are separate from the application version; neither is a published 0.4 release.

## Existing Matrix-based Tavern

For unreadable messages after signing in again or on a new device, follow
[History recovery](HISTORY_RECOVERY.md). Keep existing browser site data so
retained encryption stores can be checked by the updated client.

Use the existing-install procedure in [Installation and operations](INSTALLATION.md).
Before changing the deployment, back up the database and private data together.
Preserve:

- The public hostname and Synapse server identity.
- The Compose project name and PostgreSQL volume.
- Existing Synapse, secrets and calls bind paths through `TAVERN_DATA_DIR`.
- The bot's configuration, encryption store and queue paths, when enabled.
- The private environment values and NPM network attachment.

The complete stack adds persistent account/API storage and an initializer. It
validates the existing identity and database credentials, retains configuration
before changing it, and installs Tavern's Synapse permission module. Stop the
old application writers for the first migration and restart Synapse afterward
even if Compose kept its existing container. Existing installations keep their
administrator accounts and never enable the fresh-install `admin/admin` bootstrap.

Do not copy `.env.example` over an existing `.env`, regenerate secrets, rerun old
preparation helpers over private data, change to empty volumes or use `down -v`.
Keep the existing Dockhand stack instead of creating a second stack that points
at the same live storage.

For GitHub builds, use a reviewed full commit SHA in `TAVERN_GIT_REF` and the
matching Compose revision when a fixed checkpoint is needed. A source rollback
does not reverse database or configuration changes; retain compatible backups
and validate recovery in isolated storage before production cutover.

## Current calls, recovery and channel-management changes

Update the existing stack's V3 source and recreate the affected services using
that stack's actual Compose configuration. A separate old clone in `~/tavern`
may not be the deployment managed by Dockhand. Preserve the existing project,
data paths, volumes and environment when redeploying.

- Rebuild web and API for email-code history recovery and the separate DM section.
  The history package table is additive; ordinary known browsers reuse their
  retained keys. Existing cookie sessions can enable email recovery by entering
  the account password once under Settings / Privacy.
- Recreate `coturn` for the direct-call relay startup correction. Restarting its
  existing container alone does not apply a changed startup command. Keep the
  existing TURN hostname, shared secret and port forwards.
- Run the updated initializer and recreate Synapse, API and web together for
  role-managed private-channel admission, its durable membership worker, and
  reviewed channel/server deletion. Worker tables and deletion journals are
  additive. Existing room IDs, categories, keys and permissions are preserved;
  no existing room is automatically made private or deleted.

See [channel navigation](CHANNEL_NAVIGATION.md), [room deletion](ROOM_DELETION.md)
and [validation](VALIDATION.md) for the supported scope and observed checks.

## Older FastAPI prototype

The older non-Matrix Tavern has a different architecture. No automated migration
of its accounts, database, roles, OAuth settings or message history is included.
Test this Matrix stack with a distinct project name, data directory and hostname.
Keep the prototype's backups and choose the permanent Matrix account domain
before creating accounts.
