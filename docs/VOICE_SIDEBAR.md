# Voice participants and status dock

Voice channel rows show current native MatrixRTC participants underneath the
channel. Membership is grouped by account and exact device IDs. Selecting a
channel never creates a call or captures media. Empty lists collapse; native
membership removal, expiry, kick/ban, room departure and account replacement
remove obsolete rows. Names and avatars use the existing room profile reader.

Only the current embedded call supplies live speaking, microphone, camera and
screen-sharing observations. Those observations must match a device still in
the native call membership. Other channels retain their native participant rows
without inventing device states. Partial observations can establish a positive
activity indicator, but cannot establish that every device is muted or inactive.
The existing five-second widget telemetry expiry clears old indicators.

The bottom dock follows the active conference across navigation. Its connection
label uses real widget telemetry; native room membership or a selected channel
alone never means connected. Microphone controls use the widget's existing
acknowledged device API. Disconnect uses the existing call cleanup path. Settings
opens the same mounted widget's controls, preserving the conference and any
voice-only camera/screen restrictions.

Self-deafen uses the existing acknowledged microphone API, followed by an
explicit, acknowledged playback command to the same widget document. Its local
adapter disables the existing remote audio receiver tracks, including screen-share
audio. It does not open a microphone, replace a connection, change subscriptions,
or alter another participant's sending state. Newly subscribed tracks are gated
immediately, and the gate survives reconnects and view-model replacement in the
same call. Leaving does not briefly restore sound before native teardown.
Undeafen restores each receiver's previous state and leaves the microphone muted.

The local participant's deafen indicator is shown only for its exact observed
device. The pinned widget has no remote deafen observation; another participant
or another device of the same account remains unknown. Server moderation remains
in the existing authorized call moderation interface.

The shared observation bridge is bound to the exact conference generation and
native account/room owner. Late telemetry, disposal and control completions
cannot replace a newer binding. Participant snapshots remain stable for unrelated
metric updates; room subscriptions and memoized rows keep speaking changes out
of the surrounding channel/sidebar render.

Focused model and mounted browser tests cover native join/removal/expiry, exact
device replacement, partial and missing telemetry, microphone acknowledgements,
navigation without remounting, stale account completions and a 320px sidebar.
The browser fixtures use real Matrix Room/profile components and the actual
panel/bridge; their widget network boundary is controlled. They do not replace
the separate real embedded-conference CI acceptance test. A real browser WebRTC
receiver test measures sound before deafen, silence during it, and sound afterward
without replacing the connection. The native Games voice acceptance also requires
the shipped widget's receiver tracks and acknowledged dock controls to change.

That native self-deafen/undeafen sequence passed at `46b6a04` with two users,
followed by moving a channel during the same call and clean native leave. The
overall workflow subsequently failed a sidebar layout check after reload; this
voice result is not an overall acceptance pass or a deployed-host audio test.
