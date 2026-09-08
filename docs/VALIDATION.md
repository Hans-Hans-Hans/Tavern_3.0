# Tavern 0.3 validation record

Development checks run on 2026-09-08:

| Check | Result | Scope |
|---|---|---|
| TypeScript type checking | Passed | Application and installed SDK API usage |
| Vite production build | Passed | Static client plus locally bundled conference assets |
| JavaScript tests | 17 passed | Encryption primitives, recovery failure handling, non-deleting backup creation, uncertain POST recovery, authored collaboration and poll projection |
| Python tests with pinned nio dependencies | 8 passed | Deployment configuration, calls config, signed webhook validation, encrypted outbox persistence and real SQLite crypto identity reopening |
| Python compilation | Passed | Integration, deployment, and test scripts |
| Compose YAML parsing | Passed | Base, calls, integrations, Dockhand base/full syntax; not container startup |
| npm production dependency advisory check | 0 reported advisories | Installed production npm dependency tree at check time; not a complete security review |
| Docker image startup and full stack | Not run | No Docker executable/daemon in this environment |
| Live Matrix multi-device interoperability | Not run | Requires configured homeserver and independent browser sessions |
| Live TURN/LiveKit media | Not run | Requires reachable media ports and independent networks |
| Independent security audit/load test | Not performed | Required before assurance or scale claims |

The production output is approximately 53 MiB on disk, including the optional bundled conference client and Rust crypto assets. The main JavaScript bundle is approximately 410 KiB gzip. Conference assets load when the iframe opens. These build sizes are not a measured runtime memory or server capacity claim.

CI includes Docker builds, restricted gateway startup, and blocked-route checks. The CI workflow is provided but was not executed by this development session. A source build passing does not certify that the deployment is production-ready or that the product has complete Discord/Teams/Slack parity.
