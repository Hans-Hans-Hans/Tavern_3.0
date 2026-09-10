# Voice channels

Choose **Voice** when creating a channel. Opening it shows the people who have
announced call membership; joining opens the existing encrypted conference in
audio-only mode. The voice page has no message composer or camera button. Existing
room history remains stored. The embedded voice frame cannot request camera or
screen capture through this page.

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
apply. Audio-only capture here does not promise that a separate Matrix client is
unable to publish another media type; enforcing role publication restrictions
requires the configured SFU capability described in
[conference publication](CONFERENCE_PUBLICATION.md).

[Telemetry implementation and limits](CONFERENCE_TELEMETRY.md) and
[validation evidence](VALIDATION.md) distinguish browser fixtures from deployed
call acceptance.
