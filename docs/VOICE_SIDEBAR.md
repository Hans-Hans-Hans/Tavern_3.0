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

The pinned widget API does not expose a supported self-deafen control or a
participant deafened-state observation. The sidebar therefore exposes call
settings rather than a simulated deafen toggle. Server moderation remains in
the existing authorized call moderation interface.

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
the separate real embedded-conference CI acceptance test.
