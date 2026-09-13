# Voice channels

Choose **Voice** when creating a channel. Clicking its row in the channel list
joins the encrypted conference directly, with the camera off and no second
lobby confirmation. Browser microphone permission may still be requested.
Restoring the page, opening a deep link, or restoring a remembered conversation
does not start capture automatically; those views retain **Join voice**.
An existing direct call or a conference in another channel must be left first.

Voice is the starting mode. Use the camera button to enable a facecam, or
**Open screen sharing controls** to choose a screen/window through the embedded
call controls. Sharing starts only after the user's selection. When a participant
enables video or shares a screen, the existing call frame becomes visible; when
visual media stops it returns to the voice roster. The frame is retained during
these changes. The voice page has no message composer; existing room history
remains stored.

After the call connects, the participant cards use Matrix-attested LiveKit
participants and their current speaking state. Avatars and names come from the
room's member profiles. A green ring indicates voice activity; the microphone
control reflects the embedded client's confirmed device state. **Call controls
and devices** opens that same iframe for device selection. Navigation minimizes
the call, and returning to the channel restores it without starting a second
media session.

Ping is measured media round-trip time, not an invented server-health value.
Connection details show observed jitter, packet loss and sample coverage.
The observer samples at most eight current microphone tracks and reports the
highest available measurement; unsupported or missing measurements remain
unavailable. Encryption status requires complete participant observations and
known encryption flags. Unknown state is not displayed as successful encryption.

The voice UI does not replace server permissions. Room membership, conference
admission, timeouts, archiving, and configured role publication restrictions still
apply. Camera and screen controls do not grant additional authority. Enforcing
role publication restrictions requires the configured SFU capability described in
[conference publication](CONFERENCE_PUBLICATION.md).

**Microphone audio** exposes the shared Speech/Music presets, advanced processing
controls and the browser's actual processing report. See [microphone processing](MICROPHONE_AUDIO.md).

[Telemetry implementation and limits](CONFERENCE_TELEMETRY.md) and
[validation evidence](VALIDATION.md) distinguish browser fixtures from deployed
call acceptance.
