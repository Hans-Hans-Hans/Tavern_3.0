# Direct call presentation and diagnostics

The call header has a fullscreen control. It uses the browser's Fullscreen API; it does not resize the panel and claim that it entered fullscreen. Leaving fullscreen or navigating to a participant profile preserves the call. Participant navigation minimizes the panel and exits fullscreen so the requested profile or conversation can be used.

Each live camera or shared-screen video offers native video Picture-in-Picture when the browser supports it. The existing video element and MediaStream are used, so entering or leaving presentation does not request another camera, microphone or display capture. Call controls remain in Tavern. Unsupported controls are disabled with an explanation, and a rejected presentation request leaves the call available in its normal panel. Closing a feed exits its Picture-in-Picture presentation without stopping tracks owned by the call lifecycle.

Speaking feedback uses the pinned Matrix SDK's existing `CallFeed` analyser and its volume/speaking events. It follows measured call audio and obeys the feed's mute state. The indicator does not open an additional microphone, and it does not classify shared system audio as a speaking participant. Analysis listeners and measurement activity are released when the feed UI is removed. Browsers that suspend audio processing may require ordinary call audio playback or user interaction before activity can be measured.

**Connection details** shows the browser's current connection, ICE and gathering states, reported local/relay/remote candidate counts, selected local candidate type, round-trip time, maximum receive-stream jitter, recent receive packet loss, and media upload/download rates where reported. Counters are sampled about every two seconds using the pinned SDK's `MatrixCall.getCurrentCallStats()`. Rates and packet loss require consecutive samples; resets, long sampling gaps, absent fields and ambiguous selected routes display unavailable values rather than invented quality scores. The projection retains only metrics and media counters; it does not log, persist, upload or expose raw candidate addresses, ports, certificates or full statistics reports.

The header uses the same observation as the details panel. Native state changes
update it immediately: failed or disconnected media no longer appears as an
established encrypted relay. The connected relay label requires connected native
transport states and an observed selected relay route. This label is separate
from participant identity verification. Replacing the call or peer retires its
previous measurements.

These controls do not change relay-only call configuration, Matrix signaling, encrypted media or verification. They do not prove that a deployment's TURN hostname and router ports are reachable.

## Direct calls that ring but do not connect

The voice/video buttons in a two-person DM use Matrix direct calls with TURN.
The conference button and voice-channel join use the separate embedded LiveKit
client. A successful conference join does not verify a direct call's relay path.

Open `/admin` with an administrator account, choose **Diagnostics**, and run
**Test TURN allocation**. A relay candidate confirms that browser can obtain an
authenticated allocation. It does not prove that two relay allocations can
exchange traffic, that the other participant can reach TURN, or that an existing
call used the refreshed credentials. End the failed call and start a new one
after deploying a client fix; both participants should refresh Tavern.

If fresh calls still fail, compare both participants' connection and ICE states
and test from independent networks. The TURN listener on TCP/UDP 3478 and relay
range UDP 49160–49200 are separate paths. Behind NAT, the configured public
address, port mappings and relay routing all matter. See the
[Synapse TURN troubleshooting guide](https://element-hq.github.io/synapse/latest/turn-howto.html#troubleshooting).
Do not infer that allocation alone validates those routes or change credentials
solely because a call failed.

## Validation

`tests/call-presentation.test.mjs` covers real-counter calculations, missing/reset data, candidate ambiguity, address omission, cancellation, feed mute state, analyser sharing and cleanup. Browser regressions use native loopback peer connections and synthetic audio/video MediaStreams. They verify that measured speech stops when the actual test signal is silenced, real browser statistics produce media rates, native fullscreen/Picture-in-Picture work where supported, participant navigation survives, and no capture request or presentation cleanup stops the existing streams. Real devices, multiple browsers and external TURN connectivity remain deployment acceptance checks.
