# Conference admission and removal

Tavern's managed account API authorizes both conference token issuance and every
LiveKit signaling connection, including reconnects. This applies to the embedded
Element Call conference service. Direct Matrix one-to-one calls use a different
transport and do not gain SFU moderation from this gateway.

## Deployment contract

Use the generated call configuration, managed browser authentication, and the
shipped Nginx/Compose configuration. `CALLS_ENABLED=true` and the supported
`ghcr.io/element-hq/lk-jwt-service:0.6.0` image are required. The account API reads
the existing LiveKit key and secret from its read-only call configuration mount.
No extra browser secret or account setup is required.

The public token paths are exactly `POST /livekit/jwt/get_token` and
`POST /livekit/jwt/sfu/get`. Nginx forwards them to the account API, which delegates
to the private issuer only after authorization. Both return the compatible
`{url,jwt}` response. Deprecated delayed-leave fields used by the bundled client
remain supported. The separate newer delegation endpoint is not exposed because
this bundled client does not use it. The pinned request structures are documented
in [the issuer's request definitions](https://github.com/element-hq/lk-jwt-service/blob/v0.6.0/requests.go).

Nginx uses `auth_request` for `/livekit/sfu/rtc`, `/livekit/sfu/rtc/validate`,
`/livekit/sfu/rtc/v1`, and `/livekit/sfu/rtc/v1/validate`. The internal check sends
the original URI/method, Origin, session cookie and optional Authorization header
to `GET /api/calls/sfu-authorize`; only an empty 204 permits forwarding. Browser
cookies and request bodies are removed before forwarding to LiveKit. Other public issuer, signaling
and Twirp paths are closed. LiveKit's HTTP port 7880 and the issuer port 8080 must
remain private; publishing either service independently bypasses this boundary.
The external media ports 7881/TCP and 7882/UDP still carry media normally.
The internal authorization endpoint validates cookies without rotating them;
ordinary API responses continue normal rotation so an Nginx subrequest cannot
silently leave the browser holding an obsolete cookie.

## Current authority

The API verifies the managed cookie session, account restrictions, native Matrix
`whoami` user/device, and OpenID subject from the configured internal homeserver.
Caller-provided OpenID discovery servers and arbitrary callback URLs are rejected.
The requested device must be the browser's managed device. Sessions are checked
again after asynchronous work before granting access.

Admission requires current joined membership in an encrypted, non-federated room,
native conference state-event permission, and `join_calls` under every applicable
managed server policy. Current reciprocal canonical parents, parent membership,
channel/category overrides, timeouts, temporary bans and archival restrictions
use the deployed Synapse policy model. Spaces, tombstoned rooms and private
discussion companion rooms are excluded.

Enabled [server verification requirements](SERVER_ELIGIBILITY.md) also apply:
current verified email and native account age are checked for each applicable
server during admission, reconnects and active-call reconciliation.

The returned JWT must have a verified signature, issuer, lifetime, exact room
alias and exact participant identity. Modern hashed identities use the pinned
issuer's user/device/member mapping; legacy identities use its compatibility
mapping. The database records only room, identity, account, device, member and
managed-session scope. It contains no JWT, OpenID token or delegated-leave token.
The registry allows at most 128 scopes overall and eight per browser session.

Every signaling request validates the JWT against that durable scope and checks
current authority again. It accepts a correctly signed SFU-refreshed JWT for the
same scope, while rejecting another session, room or participant. This matters
because self-hosted LiveKit does not invalidate cached tokens after participant
removal and refreshes tokens for connected participants. See
[LiveKit token revocation](https://docs.livekit.io/frontends/reference/tokens-grants/).
The legacy `publish` query mode is rejected because it changes the participant
identity after JWT verification; it is unused by the embedded client. See the
[pinned SFU identity transformation](https://github.com/livekit/livekit/blob/v1.13.6/pkg/service/utils.go#L351).

## Existing calls and recovery

A background worker rechecks known scopes, removes the exact participant on lost
session/native/custom authority, and confirms absence through LiveKit inventory.
Native authorization outages fail closed. A locally revoked session triggers a
direct scoped removal attempt without first requiring an inventory read.
Unconfirmed removals retain their durable scope for retry after API restarts.
They produce `call.access_check_pending`, at most once per scope per hour;
confirmed removals produce `call.access_revoked`. Idle scopes disappear after
confirmed absence and a short connection grace period.

This is periodic enforcement, not instantaneous removal. Passes run after a
15-second delay with eight concurrent workers; each scope has a maximum
12-second lock wait followed by a 38-second check budget. At full capacity and
repeated timeouts, a pass can take roughly 13 minutes. Contention or unavailable
services can postpone confirmation further. Fresh connections are still denied
when their checks fail, but a disconnected control service cannot promise that
already-established media has stopped.

The existing **Remove from channel and call** action uses the same exact modern
identity bindings, with a verified legacy state fallback. Unknown identities
prevent the native kick. Synapse authorizes the actual kick and role hierarchy;
then Tavern removes all known target devices, including admissions already in
flight, and rechecks inventory. Failed confirmation returns an explicit partial
result. Other participants are never selected by a guessed identity prefix.

Upstream issuer logs are not collected by the shipped Compose configuration:
even its error-level transport messages can contain credential-bearing URLs.
Tavern's API provides sanitized diagnostics without reflecting tokens. The
issuer's [logging configuration](https://github.com/element-hq/lk-jwt-service/blob/v0.6.0/main.go)
and [OpenID error path](https://github.com/element-hq/lk-jwt-service/blob/v0.6.0/helper.go)
explain why setting a log level alone is insufficient.

## Validation and limits

Focused Python tests cover actual API HTTP
sessions, modern/legacy requests, OpenID and native device mismatches, refreshed
tokens, streamed-body sign-out, upstream races, custom/native policy denial,
bounded concurrency, durable retry, server eligibility, native account suspension,
and modern/legacy moderation. HTTP fixtures
exercise protocol behavior; they do not prove a live camera/microphone session.
The isolated Docker Nginx routing fixture and real embedded conference acceptance
must also pass in CI before claiming production media validation.

Server mute/deafen and moving a participant into another conference are not
implemented by these admission controls. A user-facing mute button must have
actual SFU enforcement and reconnect-safe grants before it can claim that effect.
The [pinned audio-moderation analysis](SFU_AUDIO_MODERATION.md) records the
source/kind validation and audio-subscribe permission extensions required to
preserve video while enforcing those controls.
