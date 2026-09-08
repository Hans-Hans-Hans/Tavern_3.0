# Tavern 3.0 repository and existing deployments

This package is a standalone source snapshot for `Hans-Hans-Hans/Tavern_3.0`,
branch `V3`. It contains the Matrix implementation, application version `0.3.0`.
The repository name does not change the application version or imply a new
feature release. The ZIP contains no Git history or configured Git credentials.

The older FastAPI Tavern is a different architecture. No automated migration
of its accounts, database, roles, OAuth settings, or message history is included.
Test this Matrix stack separately with a distinct project name, data directory,
and hostname. Keep backups of the old application and its data. Choose the
permanent Matrix account domain before creating accounts.

For an existing Tavern 0.3 Matrix deployment, preserve its hostname, Compose
project name, Postgres volume, and private data paths. Switch the source/build
reference to this repository and rebuild. Do not regenerate instance secrets,
rerun preparation helpers over existing data, or remove volumes during upgrades.

Use a reviewed full commit SHA in `TAVERN_GIT_REF` for controlled deployments.
Retain the matching Compose revision and compatible data backups for rollback.
