# Tavern V3

**Downloaded this ZIP? Start with [START_HERE.md](START_HERE.md) for VS Code and GitHub push commands.**

[![Tavern checks](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/workflows/check.yml/badge.svg?branch=V3)](https://github.com/Hans-Hans-Hans/Tavern_3.0/actions/workflows/check.yml?query=branch%3AV3)

**Matrix implementation · application version 0.3.0 · development branch `V3`**

Tavern is a browser-based, self-hosted Matrix messaging and collaboration platform. The Tavern name, parchment/gold identity, and dark navigation remain. Navigation defaults to **servers and channels**, with optional **Taverns and Guilds** terminology.

This release adds implementation for the previously missing verification, recovery, calls, conferencing, and webhook areas. **It is not full Discord/Teams/Slack parity and has not passed live multi-device deployment acceptance or an independent security audit.** See [exact feature coverage](docs/FEATURES.md) and [security status](SECURITY.md).

## What this source implements

- Private servers using Matrix Spaces; encrypted channels and DMs; invitations and membership enforced by the homeserver.
- Messaging, native Matrix threads, reactions, edits, redactions, pins, bookmarks, loaded-history search, encrypted attachments and authenticated downloads.
- Emoji device/participant verification, cross-signing, random recovery keys, encrypted secret storage, automatic key backup/recovery, optional full-history restore, and encrypted offline key exports.
- Direct voice/video calls and screen sharing through self-hosted TURN. A bundled Element Call widget connects to self-hosted MatrixRTC/LiveKit for group conferences and meeting controls. The bridge restricts capabilities to its room and own call-membership state.
- Encrypted tasks, authored notes with revisions, calendar event exports, and visible-vote polls. These use Tavern-specific encrypted Matrix messages with readable text fallbacks. They are not shared-document CRDT editing or native Matrix MSC3381 polls.
- Room notification rules and generic desktop alerts while a background tab is open; opt-in typing; focus mode; in-memory drafts; standard/legacy naming and appearance preferences.
- Room name/topic changes, kick/ban/unban, numeric member/moderator roles, and permission controls for messages, invitations, pins, and conference participation.
- A separately deployed signed-webhook bot with persistent crypto identity, fingerprint allowlists, encrypted durable outbox, replay protection, and per-message key rotation. No external integration marketplace or outbound forwarding is included.
- Dockerfile, GitHub-based base/full Compose builds, local/image-only alternatives, NPM routing, and Cloudflare/DNS instructions. There is no required hosted Tavern account or cloud application backend.

## Deploy

Start with **[Deploy from GitHub with Dockhand and NPM](docs/DEPLOY_GITHUB.md)**.
Use repository `https://github.com/Hans-Hans-Hans/Tavern_3.0.git`, branch **`V3`**,
Compose path **`compose.github.yaml`**, and enable **Build images on deploy**.
After preparing calls and the bot, use `compose.github.full.yaml` for the full
stack. Both build directly from GitHub; instance keys and data stay on your host.

Coming from the older FastAPI Tavern? Read
[V3 migration](docs/V3_MIGRATION.md) first. No automatic database/account migration
is included. This standalone package does not modify the previous repository.

The [local-image NPM guide](docs/DEPLOY_DOCKHAND_NPM.md) and
[calls/integrations guide](docs/CALLS_AND_INTEGRATIONS.md) cover configuration and
live acceptance. Complete those checks before relying on the deployment.

The base stack has Tavern's gateway/client, Synapse, and Postgres. Calls add coturn, LiveKit, and RTC authorization. Webhooks add a separately provisioned Matrix bot. GitHub Compose builds use local tags `tavern:v3` and `tavern-integrations:v3`; local-source recipes use `0.3.0` tags. These are not published registry images.

Use the `npm` Docker target for the complete deployment. The older Caddy recipe remains a basic messaging alternative and does not configure the new call routes/services.

## Develop and verify

```sh
npm ci
npm run dev
npm run build
npm test
python3 scripts/check-repository.py
python3 -m venv /tmp/tavern-checks
/tmp/tavern-checks/bin/pip install -r integrations/requirements.txt -c integrations/requirements.lock
/tmp/tavern-checks/bin/python -m unittest discover -s tests -p 'test_*.py'
```

The production build copies pinned Element Call assets locally, externalizes its inline bootstrap scripts for CSP, and creates `dist/`. Conference assets are loaded only when the call iframe opens. The core Matrix SDK is currently in the main application bundle; Rust crypto and conference assets are separate. No third-party call UI is fetched at runtime.

Tests cover official Matrix attachment/key-file encryption, recovery failure paths and buffer ownership, non-deleting backup creation and uncertain-response recovery, collaboration authorization/conflicts, webhook authentication, configuration generation, and durable bot identity/encrypted outbox reopening. They do not establish browser interoperability, media performance, or production security. CI includes Docker image builds and restricted gateway startup; that container workflow was not executed in the development environment.

## Data and trust

Matrix is the authoritative message store. The browser decrypts messages locally. Device keys persist in IndexedDB; tab credentials use sessionStorage; a Web Lock prevents concurrent use of the same crypto store. Signing out revokes the Matrix session. A closed tab is not a server-side logout. New-device recovery uses the saved recovery key or another trusted device.

Names, membership, timing, preferences, and bookmark IDs remain visible to the homeserver. Tasks/notes/poll content is encrypted, but currently projected only from decrypted history loaded in this session. Desktop notifications contain generic text. The integration bot is a deliberately trusted endpoint for webhook plaintext. Self-hosting and E2EE do not secure a compromised browser, delivered JavaScript, host, or administrator account.

Prototype storage namespaces are retained to preserve existing encrypted sessions and keys. They are migration identifiers, not branding or service dependencies. Preserve the application origin when upgrading.

## References and notices

- [Matrix specification](https://spec.matrix.org/latest/client-server-api/) and [Matrix SDK](https://github.com/matrix-org/matrix-js-sdk)
- [Element Call](https://github.com/element-hq/element-call), pinned embedded source revision `efde51b8c1e136fca17d38ec408b0a7dbb2f17e9`
- [Matrix nio](https://github.com/matrix-nio/matrix-nio)
- [Synapse](https://github.com/element-hq/synapse)

Bundled Element Call retains its upstream license notices, source reference, and reproducible asset modification script. The Tavern shell owns its branding; conferencing uses the packaged upstream call interface.

## Repository maintenance

See [contributing](CONTRIBUTING.md), [third-party notices](THIRD_PARTY_NOTICES.md),
and [branch transition notes](docs/V3_MIGRATION.md). Private instance files,
databases, dependencies, and generated bundles are excluded from Git. CI checks
the tracked snapshot, tests the application, validates Compose, and builds both
images. Docker contexts have separate allowlists. No project-wide license has
been selected; existing upstream notices are preserved.
