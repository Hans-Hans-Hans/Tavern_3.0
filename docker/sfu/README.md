# Pinned SFU audio-permission prototype build

This directory contains a reviewed, opt-in build recipe and source patches.
Tavern Compose and release workflows continue to use stock LiveKit. These assets
do not implement Matrix moderation state or user controls, and no image or
release has been published.

## Pins and local artifacts

- LiveKit: `3cfbd1242618a61178f7a05b126d6c0c4cac3731`
- Protocol: `17c16cf496fd20697ff862daf9768f9830ebe6fd`
- Go: `1.26.6`; `CGO_ENABLED=0`; `GOTOOLCHAIN=local`
- protoc: GitHub protobuf `v35.1` (generated header `v7.35.1`)
- protoc-gen-go: `v1.36.12`
- Container builder pinned in the recipe, not executed locally:
  `golang:1.26.6-alpine3.24@sha256:af8d6740070b8906d12eae1c3e3ea0957fb63f492051ea05e354c38ef9fe88df`

`protocol-audio.patch` and `livekit-audio.patch` are reviewable patches against
those pins. Apply each from its respective source root. Keep the two checkouts
adjacent as `protocol/` and `livekit/`; the LiveKit patch adds only a local
protocol replacement and preserves the upstream Pion replacements. Patches,
changed-file lists, archive checksums and build-image digests are recorded in
`provenance.json`. `patched-files.sha256` checks every modified source file after
patch application. The generated protocol file is included in the patch; the
container build does not bootstrap generators.

Both source archives came directly from GitHub codeload at those commits.
The Windows Go archive was verified against go.dev's release SHA-256
`5b6c5b556525810463b5c897b50dc7a82d6a3dc0bfaf55d990a7e9f31d6b2318`.
The Windows protoc archive was verified against the GitHub release asset digest
`5d3ff218d7d91eea95f7569bcb5a98f3030f8996d44151279d9772edcff76082`.

## Wire and permission behavior

The protocol extension is namespaced to distinguish it from upstream fields:

```proto
optional bool tavern_can_subscribe_audio = 10001;
```

Its signed video grant is `tavernCanSubscribeAudio`, represented by `*bool`.
An omitted initial grant retains upstream behavior. An omitted field in an
unrelated `UpdateParticipant` permission update preserves the existing value.
Explicit `true` restores audio subscription. Ordinary `canSubscribe=false`
continues to deny every media kind. An audio restriction does not itself change
video, data or metadata permissions. Clone, protobuf/JSON presence, participant
inventory and signed refresh-token paths preserve an explicit false value.
Only trusted token issuers and authenticated room-admin RPCs control this field;
client metadata and subscription-selection requests cannot grant permission.

The exact internal `GET /tavern/sfu/audio-permissions` endpoint returns
`{"version":1}` as `application/json` with `Cache-Control: no-store`; other
methods return 405. The gateway can require this explicit response before
relying on the extension, so stock LiveKit's catch-all health response cannot
silently qualify. This is capability evidence from the configured trusted SFU,
not cryptographic attestation. Do not add a public proxy route for this endpoint.

Both ordinary and synchronous subscriptions check the actual published track
kind. The final subscriber-attachment path shares a lock with the permission
update and current-subscription census, so a concurrently admitted audio track
cannot fall between an old grant check and the revocation census. Delayed bind
and local transport paths check permission too. Revocation removes existing
audio subscribers using the existing SFU close path. A delayed denied bind closes
its captured downtrack, preserving user intent without resolving a replacement
subscription by participant ID. Permission restoration reconciles normal
subscriptions; one-shot synchronous subscriptions may require an explicit new
subscription after closure. This is not a claim that
already transmitted packets or remote decoder buffers can be recalled.

Publication validates declared source and kind together. AUDIO permits
MICROPHONE, SCREEN_SHARE_AUDIO or UNKNOWN; VIDEO permits CAMERA, SCREEN_SHARE or
UNKNOWN. UNKNOWN preserves unrestricted old-client compatibility but cannot pass a camera
and screen-video source allowlist; this also rejects legacy UNKNOWN-source video
while that allowlist is applied. The pinned Element Call 0.25.0 embeds
livekit-client 2.22.0, whose normal and additional-codec publications include the
track kind and source. Invalid enum values are rejected. Adding a
secondary codec cannot change the existing track's source/kind. Exact-CID and
secondary-codec pending lookups compare the negotiated kind, migration
construction validates the source/kind and current publish grant, and receiver
attachment compares declared kind, negotiated RTP kind and codec MIME kind.
Already constructed migrated/simulcast tracks pass the same final check.

This checks transport metadata without decoding E2EE content. It cannot classify
semantic content intentionally encoded into video/data, nor claim to inspect
encrypted audio payloads. Future Tavern server mute can use a video-only source
allowlist only with these SFU checks present.

## Reproduce and validate

From the Tavern repository root, with BuildKit supporting Dockerfile v1.6:

```sh
docker buildx build --platform linux/amd64 --target verified \
  --progress plain docker/sfu
docker buildx build --platform linux/amd64 --load \
  -t tavern-sfu-audio:prototype --progress plain docker/sfu
```

The final image depends on the verified stage, so it cannot bypass the focused
protocol, SFU and real loopback traffic tests. These commands only build a local
prototype; they do not start it or change the deployment. The narrowly scoped
build context excludes the application and secrets. BuildKit checks both remote
archive SHA-256 values before extraction; the build checks patch and final
source hashes and uses the pinned Go module manifests with `-mod=readonly`.
There is no floating package upgrade or generator install in the recipe.

The pinned Alpine BusyBox does not provide `patch`. The build therefore runs
the included standard-library-only Go applier, which requires exact hunk
positions/context, rejects unsafe paths, symlinks and unsupported patch forms,
and validates every hunk before writing files. Its tests include malformed
counts, traversal, partial-write prevention and a Linux symlink regression.
The final source checksums independently verify the resulting patch output.

The Docker recipe has not run in this Windows workspace because Docker is not
available. Its equivalent source patches, native Windows tests and full Linux
cross-build were checked locally. The pinned runtime base intentionally does not
run `apk upgrade`; refresh its digest through review before a deployment release.
Only Linux amd64 was cross-built locally; arm64 acceptance remains pending.


Use the exact Go/protoc tools, not upstream mage's generator bootstrap. After
applying both patches, the checked-in generated Go file is ready. To regenerate
it from the proto (run from the parent of the extracted adjacent source trees):

```sh
protoc -I protocol/protobufs -I "$PROTOC_INCLUDE" \
  --go_out=protocol/livekit --go_opt=paths=source_relative \
  protocol/protobufs/livekit_models.proto
export CGO_ENABLED=0 GOTOOLCHAIN=local
go -C protocol test ./auth
go -C livekit test ./pkg/rtc -run TestTavern -count=1
go -C livekit test ./test -run TestTavernReal -count=1 -timeout=90s
GOOS=linux GOARCH=amd64 go -C livekit build \
  -o ../livekit-tavern-audio-linux-amd64 ./cmd/server
```

The initial local validation used isolated source checkouts and verified tools
under `work/sfu-audio`, with separate Go module/build caches. That work directory
is not included in Git or the Docker build context.

Observed on Windows with Go 1.26.6:

- Full protocol auth suite passes, including three new tests for omission,
  copy/presence and signed token refresh.
- Eight focused SFU tests pass: source/kind combinations, actual AddTrack and
  exact-CID/migration rejection, the real receiver's rejection boundary,
  ordinary/synchronous/local-transport denial, existing audio-only revocation,
  concurrent admission versus permission update, delayed permission-denied bind
  restoration without changing user intent, and immediately bound reused tracks.
- Three real loopback integration tests pass (`real-audio.log`, 17.340 seconds).
  Independent review reran all three successfully in 17.330 seconds.
  The final capability endpoint addition reran all three in 17.337 seconds,
  including actual GET/body/header, POST rejection and wrong-path checks.
  Actual Pion Opus/VP8 clients, native authenticated RoomService JSON RPC and
  received RTP byte counters prove audio stops while video continues; explicit
  resubscription, new audio, omitted updates and refreshed-token reconnect stay
  restricted; explicit restoration allows audio again. A second test rejects
  audio/CAMERA signaling and negotiated Opus announced as VIDEO/CAMERA while
  genuine VP8 from the same constrained publisher still forwards. A third test
  revokes an already active microphone and proves the same publisher's video
  continues, while a new microphone publication is refused.
- `CGO_ENABLED=0 GOOS=linux GOARCH=amd64` builds the full server successfully.
- The final broader RTC suite has 73 passing top-level tests and one failure:
  `TestUpdateSubscriptionPermission/update_versions`, an immediate timestamp
  ordering assertion. The same failure reproduces in the separately fetched
  pristine `livekit-baseline/` checkout with the original protocol dependency
  (`baseline-version-test.log`). It was not changed or weakened.

The three network tests bind server HTTP and media to loopback only, on port17980
and UDP17982. Test clients use loopback ICE and no STUN. They use generated
in-memory server/room state and test credentials, with no Redis, Docker, real
Matrix accounts or production configuration. They stop clients and the server
on completion. Do not run the upstream multi-node suite here: its helper calls
Redis FLUSHALL and is outside this isolated test scope.

## Remaining before product integration

This does not implement durable Matrix moderation state, moderator hierarchy,
cross-room inheritance, gateway projection, stale initial-JWT rejection,
multi-node migration acceptance, browser controls or deployment/publishing.
The existing Tavern gateway must validate the extension in freshly signed and
refreshed grants and reconcile all authoritative device mappings. A reconnect
using an old unrestricted initial token still needs that external admission
authority; the tested SFU refresh preserves the restriction it actually knows.
Actual Linux/container execution, deployment image publication/provenance, a
complete binary dependency license/SBOM review and maintenance ownership also
remain before replacing stock LiveKit. The current production
documentation correctly continues to call server mute/deafen unimplemented.

## Primary source and license provenance

The source repositories, commits, archive hashes, patch hashes, compiler pins and
builder/runtime image digests are listed in [provenance.json](provenance.json).
The image pins match the [pinned upstream Dockerfile](https://github.com/livekit/livekit/blob/3cfbd1242618a61178f7a05b126d6c0c4cac3731/Dockerfile).
The source archives are fetched from the exact GitHub codeload URLs recorded in
that manifest. Source archives use fixed checksums, so a changed archive fails
closed instead of silently accepting changed input. The fetch mechanism uses
[Docker ADD --checksum](https://docs.docker.com/reference/dockerfile/#add---checksum).

Both upstream projects use Apache-2.0. Original licenses and notices are copied
verbatim into `licenses/`, including the existing SFU ion-sfu/MIT attribution.
The patches retain original copyright headers and mark Tavern modifications;
new Tavern test/helper files carry Apache-2.0 SPDX identifiers. `NOTICE` describes
the changes, and the prototype image includes these notices plus the build
manifest and source checksums. Other Go dependencies retain their upstream module
versions/checksums; this is not a claim that a release SBOM has been completed.
