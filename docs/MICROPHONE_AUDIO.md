# Microphone processing

Direct calls expose **Microphone mode** in their audio/video settings. Voice
channels and conferences expose it under **Microphone audio**. Preferences are
saved on the current browser and shared between the direct-call client and its
embedded conference frame.

- **Speech** requests noise suppression, echo cancellation and automatic gain.
- **Music** retains echo cancellation while disabling noise suppression and gain
  adjustment, preserving more microphone detail.
- **Advanced microphone processing** lets each setting be changed independently.

These use browser processing. They do not install a separate denoising model or
send microphone audio to an external filtering service. Noise reduction quality
depends on the browser, microphone and room acoustics.

Tavern requests the chosen processing before direct-call capture and reapplies it
to replacement microphones. Conferences observe the existing, locally owned
microphone publication. They first try changing its constraints in place. If the
browser retains different settings, the pinned LiveKit SDK replaces capture on
the same microphone device, stops the old track first and preserves native mute.
Changing processing may therefore cause a brief audio interruption. An ended,
replaced or unowned conference cannot initiate another processing operation.
Screen-share audio and remote tracks are excluded from microphone processing.

The UI reports **confirmed** only when `getSettings()` reports all requested
booleans. Unsupported, unreported, mismatched and failed settings remain visible
as unconfirmed or failed. Device IDs, labels and raw track settings never enter
the conference telemetry report. Constraint requests and observed settings are
distinct in the [Media Capture and Streams standard](https://www.w3.org/TR/mediacapture-streams/).

Automated acceptance includes Chromium synthetic microphone capture and the
actual LiveKit 2.22.0 code bundled with Element Call 0.25.0. It verifies Speech to
Music replacement, applied browser settings, retained mute and ended old capture.
This verifies capture behavior, not acoustic noise/echo reduction on a physical
microphone. Check speaker echo, keyboard/fan noise and speech clarity on actual
phones/headsets as part of deployment acceptance.
