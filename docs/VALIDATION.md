# Tavern validation record

This records observed checks for the 0.4 development branch. It distinguishes successful stages from a successful complete workflow and from production acceptance. See the [implementation checklist](IMPLEMENTATION_CHECKLIST.md) for the full requested feature inventory.

## Observed continuous integration

[GitHub run 34303667300](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/runs/34303667300) tested commit `16ad9c274acecd1482d215e45f2d9fa766589b7f`. The following stages were observed passing:

| Check | Result and scope |
|---|---|
| Frontend build and type checking | Passed for the tested commit; static app and bundled conference assets compiled |
| JavaScript and browser tests | Passed for the tested commit; model/crypto/projection tests and actual headless-browser fixtures |
| Production PWA offline smoke | Passed using built production assets; verifies safe static caching and offline UI |
| Python tests | Passed for the tested commit; account/API/policy/deployment/operations cases |
| Remote-context Docker builds | Passed for web and integration images |
| Restricted gateway startup | Passed with read-only filesystem, dropped capabilities, blocked federation/admin routes and runtime config assertions |
| Fresh canonical Compose stack | Containers became healthy; actual API, database, Synapse and gateway startup observed |
| Backup archive integrity | Passed; the archive included recoverable database and persistent configuration/media contents |
| Clone PostgreSQL restoration | Failed in this run at temporary-database readiness; a TCP-readiness fix is implemented and awaits observed rerun |

The overall run was not green because clone restoration failed. Earlier run 34302882380 exposed binary corruption when a Docker log stream was used to extract an archive; the binary exec-stream fix passed the archive-integrity stage above. These failed cases remain visible as evidence of defects found, not successful restore claims.

## Subsequent local verification

Focused tests have also passed for category role inheritance and permission-boundary moves, invitation privacy, rich account administration, emoji customization/preferences, profile metadata, encrypted IndexedDB search, notifications/appearance, command navigation and 2,000-row variable-height message virtualization. The richer administrator UI has browser checks for empty filtered pages with continued pagination, MFA email-code state retention and retry, self-account guards, and privilege-safe profile edits.

These tests extend the tested source beyond the CI commit above. They do not retroactively certify that commit or establish a green run for the latest working tree. Exact totals change as implementation continues; use the final CI logs as the authoritative test count.

A real TLS SMTP test sink was independently exercised with SMTP_SSL, MIME parsing, and code retrieval. The new full-stack HTTPS smoke is implemented to exercise one-time bootstrap, two users sending encrypted Matrix messages, absence of plaintext in the server event, and same-device decryption after reload. That full-stack browser stage has not yet been observed passing in this record.

The Windows development environment has no local Docker daemon. Container results above came from the GitHub runner, not local YAML parsing.

## Remaining acceptance

- Observe a completely green workflow for the final commit, including restored PostgreSQL fixture data, API-volume binary hashes and Synapse signing-key equality.
- Run the real HTTPS/two-user encrypted-message smoke and interrupted-login/verification/recovery paths against the pinned Synapse image.
- Validate Gmail App Password delivery, external NPM/Cloudflare cookie behavior and required public routing.
- Exercise role/category/thread/invitation policies with independent ordinary and moderator accounts against deployed Synapse.
- Test TURN/LiveKit voice/video/screen sharing from independent networks and supported devices.
- Perform preserved-data upgrades, failed-update rollback and an actual backup recovery/E2EE drill before production cutover.
- Review mobile/PWA installation, keyboard/screen-reader/contrast behavior, realistic load and independent security findings.

Passing unit tests, configured health checks, a complete source build, or a healthy container do not prove external media connectivity or production-scale performance. No independent security audit, load-capacity certification, or complete mature-platform parity is claimed.
