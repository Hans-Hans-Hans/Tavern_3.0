# Audio-specific server moderation

Server mute and deafen remain unimplemented. Tavern's current admission gateway
already persists exact device bindings, checks signaling reconnects and retries
revocation after restart. Audio-specific controls additionally need enforcement
inside the SFU; a browser control alone cannot supply it.

## Pinned protocol findings

LiveKit 1.13.6 can stop all publishing or all subscribing through participant
permissions, including existing tracks. Those controls also affect video.
Source restrictions alone do not establish an audio-kind restriction: AddTrack
accepts the declared source and kind independently, and the receive path checks
that source again. An audio track labeled as a camera can therefore pass a
camera-source allowlist. This is a source-level finding, not a locally executed
live exploit. Relevant pinned paths are [AddTrack](https://github.com/livekit/livekit/blob/v1.13.6/pkg/rtc/participant.go#L1357),
[pending tracks](https://github.com/livekit/livekit/blob/v1.13.6/pkg/rtc/participant.go#L2937)
and [media reception](https://github.com/livekit/livekit/blob/v1.13.6/pkg/rtc/participant.go#L3292).

The pinned [participant permission schema](https://github.com/livekit/protocol/blob/17c16cf496fd/protobufs/livekit_models.proto#L108)
has no audio-specific subscribe grant. Both [ordinary](https://github.com/livekit/livekit/blob/v1.13.6/pkg/rtc/subscriptionmanager.go#L751)
and [synchronous](https://github.com/livekit/livekit/blob/v1.13.6/pkg/rtc/subscriptionmanager.go#L813)
subscription paths use the participant-wide permission. Changing current track
selection does not prevent a permitted subscriber from requesting audio again.

## Required implementation

1. Validate source/kind combinations at publication and the actual negotiated
   RTP kind before attaching receivers, including migration paths. This lets a
   source allowlist prohibit microphone and screen audio while preserving video.
2. Add a server-owned audio-subscribe permission, compatible with clients that
   omit it. Preserve it through initial/refreshed tokens and participant updates;
   enforce it for existing, new and resumed subscriptions.
3. Persist scoped Matrix restriction state with native/custom target hierarchy,
   compare-and-swap and redaction enforcement. Channel authority must not grant
   server-wide control. Applicable current server/channel restrictions intersect.
4. Project current restrictions into admission grants and every signaling
   reconnect. Reconcile all proven target identities and in-flight admissions
   after state changes and restart. Report saved, confirmed and pending outcomes
   separately. Never enable microphone capture when restoring permission.

The SFU extension would inspect transport kind and permission metadata, preserving
media E2EE. It requires a pinned, reproducible SFU/protocol build and an explicit
maintenance contract before exposing the product controls.

## Acceptance

Real SFU tests must deny mislabeled and negotiated-kind-mismatched audio, stop
existing and new audio while video continues, and reject resubscription and
reconnect attempts under current restrictions. Native tests must cover ordinary
direct state writes, hierarchy, v12 creators, stale topology and redaction.
Gateway tests must cover all devices, refreshed tokens, partial failure and
restart recovery. Browser tests must report pending enforcement accurately and
preserve the participant's capture choices.

These planned controls cover managed conferences. They do not establish control
over direct Matrix peer-to-peer media. The existing periodic-control and outage
limits in [RTC authorization](RTC_AUTHORIZATION.md) still apply.
