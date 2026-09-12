# Testing the current V3 changes

Use two ordinary accounts for calls and conversations, plus a server owner for
management. Keep the browser data on the device holding your message keys.

## Update the existing deployment

In Dockhand, update the existing Tavern stack to `V3` and rebuild/redeploy from
its saved Compose source and environment. For remote Git builds, set
`TAVERN_GIT_REF=V3`. A separate `~/tavern` checkout may be an older installation.

The update needs rebuilt web, API and initializer images; recreated TURN and
call services; and a Synapse restart after initialization. The initializer applies
the role worker and sync-cache correction while preserving existing identity,
credentials and room data. Follow [V3 migration](V3_MIGRATION.md) for the service
details. Reopen Tavern after the deployment completes.

## History and email recovery

1. Open **Tavern settings → Privacy → Email history recovery** on the browser
   holding your readable history. A verified account email and working SMTP
   delivery are required. Enable recovery once if it is not already enabled.
2. If all previous history keys are unavailable, use **Protect messages on this
   device** to protect available and future messages. This cannot decrypt older
   messages whose keys were lost everywhere.
3. Send a test message. Sign out and back in using the same browser without
   clearing its site data. The message should decrypt without a recovery code.
4. Sign in on another device or a fresh private browser window. Enter the emailed
   code in **Unlock your message history**. The test message should decrypt.
5. Refresh that device after successful recovery. It should retain its keys and
   skip the recovery dialog. Check a message sent after recovery as well.

An email package protects the history-backup key. Device/participant identity
verification remains separate. See [History recovery](HISTORY_RECOVERY.md) for
password changes, old backups and other recovery methods.

## Direct messages and calls

1. Select **Direct messages**, the speech-bubble option in the left server rail
   (or the mobile server switcher). Create or open a DM, exchange messages and
   refresh. Its selection and available history should remain.
2. Call the other account. For the original network problem, put the phone on
   cellular with Wi-Fi off and use the PC on the home network.
3. Speak in each direction for at least ten seconds. Both users must hear audio;
   a connected label alone is insufficient. Connection details should report
   media traffic and available browser measurements after several samples.
4. Test mute/unmute, hang up, then call again. Refresh after hanging up; the ended
   call should not ring again.

**Test TURN allocation** in Admin → Diagnostics checks relay allocation only.
It is useful when a direct call fails, but does not prove audio delivery.

## Server, channels and voice

1. Create **Games** and **Other games** categories. Create text channels
   **tarkov**, **minecraft**, and a voice channel **Gaming Voice**.
2. Drag all three into Games. Move Gaming Voice above minecraft. The row's Move
   action provides the same positioning without dragging.
3. Right-click Gaming Voice → **Edit channel & permissions → Permissions**.
   Select the intended Gaming role/members under private channel access. Confirm
   an included member can join and an excluded member cannot discover/join it.
4. Select Gaming Voice and join explicitly with two included accounts. Both
   participants should appear under the voice channel. Check speaking indicators,
   microphone mute, self-deafen, settings and disconnect.
5. While the call stays open, move tarkov to Other games. Both browsers should
   update. Leave the call and refresh both browsers; the channel order should
   remain and departed voice participants should disappear.

The isolated automated results and their limits are recorded in
[Validation](VALIDATION.md) and the [implementation report](SERVER_CHANNEL_IMPLEMENTATION.md).
They do not substitute for the phone-to-PC test on the deployed network.
