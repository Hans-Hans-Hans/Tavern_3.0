# Server mute and deafen

Tavern provides independent moderator controls for sending and hearing audio in
managed conferences. Open a participant's menu and choose **Server mute** or
**Server deafen**, then select the channel or an applicable server scope. Each
action changes only its own flag. Members see their own active restrictions in
the conference panel. Direct Matrix peer-to-peer calls are outside these controls.

## Enable on the Docker host

Keep the existing project name, domain, volumes and `.env`. With calls already
configured, add:

```dotenv
COMPOSE_PROFILES=calls
CALLS_ENABLED=true
SFU_AUDIO_MODERATION_ENABLED=true
TURN_DOMAIN=turn.hans-homelab.com
PUBLIC_IP=YOUR_PUBLIC_WAN_IPV4
```

Retain other enabled profiles as a comma-separated list. Replace the WAN IP
placeholder with the same actual address used by the existing media configuration.
The flag defaults to `false`; it requires the `calls` profile and call settings.
Back up the instance, stop Synapse while its configuration is updated, and rebuild:

```sh
git switch V3
git pull --ff-only origin V3
docker compose stop synapse
docker compose up -d --build
docker compose restart synapse
```

The initializer updates the native policy flag without replacing credentials or
Matrix identity. Compose builds `tavern-sfu-audio:0.4.0` from the pinned
[SFU recipe](../docker/sfu/README.md); this build also executes the media tests.
Git-backed managers build the matching `docker/sfu` context from V3. Image-only
managers need that image built beforehand. A local tag is not a published release.

NPM, DNS and media ports are the same as [ordinary call setup](INSTALLATION.md).
The SFU and RTC issuer HTTP ports remain private. The account service checks an
exact internal capability response before relying on the audio extension; stock
LiveKit does not qualify. Recreate the initializer, Synapse and API after changing
the feature flag. An existing `LIVEKIT_IMAGE` override must select this compatible
build when audio moderation is enabled.

## Authority and state

Server roles expose separate permissions to mute or deafen lower members.
They are not added to default roles. The owner has implicit custom authority;
the current native event/kick power threshold and strictly higher target rank
still apply. The moderator must be joined to each applicable scope. A channel
grant does not confer server-wide authority, and a mute grant cannot clear deafen.

The native `io.tavern.call.audio` state contains version 1, two booleans and the
previous-event revision. Its state key replaces the target Matrix ID's initial
`@` with `_`, retaining the native 255-byte limit. Synapse reserves another user's
`@` state key, so writing that form is rejected. The account API accepts full
Matrix IDs and performs this encoding itself.

Restrictions combine across the channel and all reciprocal canonical Space
ancestors, separately for each flag. A child clear cannot cancel a server's
restriction. Traversal is bounded to eight levels and 32 scopes; cycles, malformed
authority, stale revisions and changed topology fail closed. Direct native writes
use the same policy. Flags cannot be removed by redaction or by a child moderator
detaching an inherited restriction. These checks do not make multiple rooms an
atomic transaction.

New restrictions require the target to be joined. Authorized members can clear
restrictions after the target leaves, or while the deployment feature is disabled.
Turning the flag off does not discard or unprotect existing native state.

## Saved settings and actual enforcement

The API records native intent, then reconciles the target's exact managed SFU
device identities. It attenuates signed admission grants, rechecks signaling
reconnects and retries durable work after interruption. The SFU validates declared
source, declared kind and negotiated RTP kind, and independently enforces audio
subscription permission. Compatible enforcement stops audio while normal camera
and screen video can continue. Media remains encrypted; no payload inspection or
microphone capture is performed by the moderation controls.

The dialog distinguishes **saved**, **confirmed**, **pending**, and **rejoin
required**. Channel confirmation requires a current native revision and observed
SFU permissions for its known devices, with unknown participants kept pending.
Server-wide settings remain pending at the aggregate level: the registry enforces
its known devices and future admissions, but does not prove a complete census of
every pre-existing descendant call. This is not a claim of instantaneous delivery
to every device.

Clearing a mute never widens an observed publication source list or global
publishing permission in place. An external administrator can set the same mask
without a distinguishable update, so a previous Tavern mute cannot establish
exclusive ownership of that mask. Devices needing restored publishing grants
remain pending and must leave and rejoin through a fresh managed admission. The
UI explains this. Clearing deafen restores the Tavern audio-subscribe flag while
preserving the participant's ordinary permission to subscribe. Neither action
turns on the member's microphone.

The worker checks on a 15-second cadence, with bounded concurrency, 128 total
admissions and eight per account session; authority and control requests also
have deadlines. A service outage can delay enforcement. If the extension is off
or incompatible while restrictions exist, fresh admission is refused and an
existing mapped SFU participant is removed from the call; Matrix room membership
is preserved. That fallback ends video too. See [RTC authorization](RTC_AUTHORIZATION.md)
for the shared periodic-control and outage limits.

## Verification scope

The pinned Linux Docker build passed protocol-auth, eight RTC and three real
Pion/RTP tests, plus execution as UID 10001 with a read-only filesystem and no
network. Actual traffic tests cover existing and new audio, source/kind bypasses,
resubscription and refreshed-token reconnect while video continues. The later
fixture-only loopback correction passed those three tests locally with no public
STUN attempts. [Build evidence and pins](../docker/sfu/README.md).

Python tests exercise independent grants, native/custom hierarchy, inheritance,
direct policy writes, stale state/topology, target departure, redaction, exact
multi-device bindings, real HTTP session revocation, actual SFU JSON casing,
unrelated permission preservation and conservative restoration. Browser tests
mount the real conference panel and dialogs, including scope selection, account
and call replacement, delayed responses, narrow layouts and truthful status.

The isolated native smoke uses ordinary accounts and actual Synapse state/API
requests. Its CI harness and result are recorded in [validation](VALIDATION.md).
Native-state acceptance and independent RTP tests do not establish browser media
interoperability over the user's TURN/NPM/Cloudflare deployment. That external
network/device acceptance, ARM64 and multi-node migration remain to be run.
