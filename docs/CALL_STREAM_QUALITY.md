# Direct-call video quality

In an active direct call, open **Call device settings** and use **Camera quality** or **Screen share quality**. Each source has its own choice:

| Choice | Requested maximum capture | Total video send limit |
| --- | --- | --- |
| Call defaults | Restore the call's previous constraints | Restore its previous limits |
| Lower bandwidth | 640 × 360 at 15 fps | 0.5 Mbps |
| Balanced | 1280 × 720 at 30 fps | 1.5 Mbps |
| More detail | 1920 × 1080 at 30 fps | 3 Mbps |
| Screen text (screen only) | 1920 × 1080 at 15 fps | 2.5 Mbps |

These are requests and maximum send limits, not guaranteed resolution or network throughput. The panel separately shows the browser's measured capture size/frame rate and retained send limits, checked after quality and source changes. A browser may apply only capture settings or only send limits; partial changes and unsupported controls are reported explicitly. Restoring call defaults removes Tavern's quality caps and restores the previous constraints; the browser can keep its current capture size until it needs to change it. Existing tighter limits set by the call are respected. No quality value changes audio.

Choosing a preset does not open a camera, microphone or screen picker. If that source is absent, the choice waits for the user to enable it through the ordinary call controls. It then applies to that call's newly owned video track. Camera and screen choices stay independent. Closing or minimizing the panel preserves the streams and the call's choices; starting a different call uses its own defaults. Disabling a video track stays disabled when its quality changes.

## Ownership and privacy

The controller uses the pinned Matrix SDK's existing local usermedia/screensharing streams and `MatrixCall.peerConn`. It changes only width, height and frame-rate constraints on the exact live local video track, and maximum bitrate/frame rate on senders whose `track` is that same object. Multiple encodings/senders share the requested total budget. Audio, remote tracks, device selection, encoding topology, sender active flags, codecs, relay policy, encryption and verification remain under the existing call lifecycle.

Requests are serialized per call. Every asynchronous boundary rechecks the active call, source, peer and sender identities; stale completions cannot publish results or start subsequent writes on a replacement. An operation already submitted to the browser cannot be cancelled, so the controller records its completed changes internally before allowing the next request to restore defaults. Fresh `getParameters()` transactions are used immediately before `setParameters()`. Original controlled fields are kept in per-call weak maps, including across panel remounts; intervening SDK changes are preserved. Cleanup only removes observers and never stops, clones, replaces or unmutes a track. No video measurements or device identifiers are stored or sent to the server.

The implementation follows the browser APIs for [media track constraints and settings](https://www.w3.org/TR/mediacapture-streams/) and [WebRTC sender parameters](https://www.w3.org/TR/webrtc/). Browser and capture-source support varies. Embedded group calls continue to use the pinned Element Call controls; these direct-call controls do not modify the embedded app.

In the embedded Element Call 0.25.0 app, existing advanced quality controls are
under **Settings → Preferences → Developer mode**, then **Developer**. They expose
camera and screen-share resolution, frame rate, bitrate and codec choices. Camera
changes apply on the next join; screen-share changes apply on the next share.

## Validation

`tests/call-stream-quality.test.mjs` covers ownership, preservation of unrelated constraints/RTP fields, native parameter transactions, total budgets, rapid-request serialization, late call/track/peer/sender replacement, unavailable sources, unsupported/ignored changes, field reordering by browsers, restoration and cleanup. `tests/browser/call-stream-quality.spec.ts` runs the actual call panel with native canvas tracks and a negotiated pair of browser WebRTC connections. It verifies actual transmitted bytes, retained camera/screen caps, displayed real measurements, restoration, unchanged audio/disabled state, panel remounts and zero extra capture requests. Existing call presentation regressions cover participant navigation, speech, fullscreen and Picture-in-Picture alongside the new controls.

Synthetic loopback coverage does not prove physical-device constraints, performance on every browser, or external TURN connectivity. Those remain deployment checks with actual devices and remote participants.
