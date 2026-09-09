# V3 and existing Tavern deployments

`V3` now contains a 0.4 development checkpoint for testing. Further work continues
on `codex/tavern-completion`. The repository name `Tavern_3.0` and branch `V3`
are separate from the application version; neither is a published 0.4 release.

## Existing Matrix-based Tavern

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

## Older FastAPI prototype

The older non-Matrix Tavern has a different architecture. No automated migration
of its accounts, database, roles, OAuth settings or message history is included.
Test this Matrix stack with a distinct project name, data directory and hostname.
Keep the prototype's backups and choose the permanent Matrix account domain
before creating accounts.
