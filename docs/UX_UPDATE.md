# V3 usability update

This update implements the everyday usability and community-management work in
[the improvement plan](UX_IMPROVEMENT_PLAN.md), plus Home, sticker packs, event
planning and personal server colors. It builds on the already implemented upload
limit control and working calls.

## What to try

- **Home:** select the Tavern logo. See unread DMs, recent mentions, saved items
  and upcoming events. Choose Home as this browser's landing page, or return to
  the last conversation. Navigation remembers a joined conversation separately
  for each account and server/DM section. Browser Back and Forward follow the
  conversations and views you opened. Opening Home does not mark messages read.
- **Getting started:** empty conversations offer a useful next action and a
  button to reopen help. Active conversations no longer repeat the large welcome
  card. Existing onboarding progress is retained.
- **History recovery:** known-device recovery stays in the background. The
  email status check finishes before showing an attention banner; an unconfigured
  new device opens its recovery prompt once per account session. Changing
  screens does not repeatedly reopen it. Recovery still requires retained or
  backed-up keys; this update does not replace an existing encryption identity.
- **Create server:** preview a Friends, Gaming, Study or Team layout and choose
  which channels to create. Welcome and notification choices are under an
  expandable section. A partial setup offers **Finish remaining setup**, which
  resumes the known rooms rather than creating them again. If creation has an
  uncertain outcome, inspect the server before attempting another creation.
- **Channel types and permissions:** type cards explain what each channel does.
  Voice opens its participant view with discussion separate. In role settings,
  expand **Explain a member's access** to compare saved role, category and channel
  rules with native membership and permission limits. This is an explanation,
  not a grant of access. Assignment forms show unsaved changes and keep rejected
  drafts.
- **Notifications:** Everything, Mentions and Quiet presets explain their effect.
  Server/channel settings identify inheritance and offer **Reset to inherited
  setting**. Resetting a message mode keeps active timed mutes and DND behavior.
- **Admin overview:** storage pressure, email readiness and service status link
  to their existing settings and diagnostics. A local check does not claim that
  a call works across external networks.
- **Stickers:** Server settings → Stickers lets authorized managers create,
  rename and remove empty packs, and add/remove artwork. Each server supports
  20 packs of 50 stickers. Uploaded images become optimized static squares.
  The composer picker sends a sticker immediately and keeps your text draft;
  retry uses the same pending transaction. Thread stickers stay in their thread.
  Artwork is a community asset, not a private encrypted attachment; the message
  using it follows the conversation's encryption. Descriptions support readers
  who cannot see the image.
- **Event planning:** Channel → Work → Calendar → New event includes **Find a
  time together**. It compares only time zones participants voluntarily shared.
  It does not infer working hours or calendar availability. Events have Going,
  Maybe and Cannot go responses, plus the existing personal reminder and calendar
  export actions. Responses are visible in that conversation.
- **Personal color:** a server's menu offers **Personal server color**. The
  optional navigation marker belongs to your account and follows interface
  saturation. It does not change the server's branding or play media.
- **Errors and uploads:** login and invitation errors offer expandable safe
  details. Failed invitation previews can retry. Oversized files stay available
  to retry after the limit is corrected; they are not automatically queued for
  repeated rejected uploads. Message drafts, upload progress, cancellation and
  the encrypted outbox remain available.

Home events and mentions use history available on the device. Navigation and
Home landing choices stay in this browser; personal colors and notification
preferences use the account. Personal preference writes merge fresh data but
simultaneous edits from different devices do not have native compare-and-swap.

## Upgrade the existing installation

Back up your existing database and private data first. Use the checkout/Compose
file that actually controls the running stack, retaining its project name,
environment, volumes, NPM network and working call settings. A separate old
`~/tavern` checkout cannot update a Dockhand-managed Git checkout.
See [deployment source selection](DEPLOY_GITHUB.md#choose-the-source-and-compose-file).

For current V3, follow the [hardening redeploy procedure](V3_HARDENING.md#existing-v3-redeploy).
It includes the required proxy trust settings, permission repair, Synapse restart
and recreation of consumers. Keep browser site data and encryption stores.

For file sizes, see [Admin → Storage and upload limits](UPLOAD_LIMITS.md).
Raising the application setting cannot raise an external proxy's limit.

## Acceptance after deployment

1. Sign in with an existing browser and then a new browser; check that recovery
   prompts appear only where action is needed. Verify readable historical
   messages with an account that has backed-up or retained keys.
2. Switch between two servers and DMs, refresh, then use Back and Forward. Test
   Home without clearing unread counts. Test a room you have left is not restored.
3. Create a template server, send a sticker from another member and reply with
   one in a thread. Check denied pack management and permission explanations.
4. Create an event, compare shared/unshared time zones, RSVP from another account
   and set a reminder. Reset a notification override while muted.
5. Raise Admin → Storage's limit and send/download an encrypted attachment above
   10 MiB from another device through the public hostname.
6. On physical Android Chrome and iOS Safari, test the keyboard, attachment
   picker, navigation drawers, safe areas, focus return and rotation during a
   call. Repeat a LAN-to-external call to confirm the retained deployment setup.

Browser emulation and local tests cannot replace physical-phone or live-stack
acceptance. Temporary voice-room lifecycle automation and resumable encrypted
chunk uploads remain separately scoped future features; neither is claimed as
implemented by this update.
