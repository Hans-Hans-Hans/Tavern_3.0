# Isolated call-audio acceptance

The canonical-stack job enables the existing `calls` profile and native audio
policy at startup. It builds the pinned SFU recipe as `tavern-sfu-audio:check`;
that build includes the protocol, SFU and real loopback RTP tests. The account
probe then uses the same three isolated browser sessions as the other native
acceptance checks, before Bob's final deactivation.

`scripts/ci-call-config.py` runs the real production provisioner after checking
the exact CI environment, project, state root and `chat.example.test` identity.
The validation-only `PUBLIC_IP=1.1.1.1` seed is preserved in the generated
`livekit.yaml`, together with its original credentials. It is not a CI media
destination. The wrapper derives a separate `livekit.ci.yaml` with an explicit
loopback node address, loopback ICE filtering, disabled TCP media, and empty
STUN/TURN lists. Only the test overlay selects that file. A second init run still
validates the original generated configuration and keeps the credentials.

The overlay removes published TURN/SFU ports and makes the media network
internal. The SFU HTTP endpoint remains reachable by the API inside Docker.
Startup checks its exact audio-capability response before browser probes begin.
The TURN service retains `cap_drop: ALL`, `no-new-privileges` and a read-only
filesystem, with only `NET_BIND_SERVICE` added. The pinned
[coturn image](https://github.com/coturn/coturn/blob/docker/4.17.2-r0/docker/coturn/debian/Dockerfile)
sets that file capability on `turnserver`; excluding it from the container's
capability bounding set caused Linux to reject execution with `Operation not
permitted`, even though the configured listening port is above 1024. The same
service settings apply to production and this isolated test stack.
The independent rollback project explicitly disables both call flags and uses
the production init entrypoint. This setup adds no production validation exception.

`scripts/smoke-call-audio.mjs` proves actual Synapse authorization: independent
mute/deafen role grants, native and custom hierarchy, all canonical ancestors,
current membership, stale revisions, protected redaction and departed-member
clearing. Its read-only API checks inherited native flags after a child clear.
Every mutable room has a fresh immutable CI marker and verified creator, name,
non-federation and membership. Cleanup reads current revisions, clears flags,
leaves only those fixtures and restores temporary invitation preferences.

This probe never captures media or joins a call. Its result is native-state and
API-projection evidence. The separate SFU tests prove Opus/VP8 transport behavior;
neither result alone proves a complete Matrix/Element Call browser media session.
The startup-wrapper regressions exercise real provisioning and restart locally;
the assembled calls-enabled Docker/native probe must pass the next CI run.
