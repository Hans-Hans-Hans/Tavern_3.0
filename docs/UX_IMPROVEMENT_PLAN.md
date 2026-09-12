# Tavern improvement plan

This plan builds on the existing V3 implementation. Calls were confirmed working
after the inbound firewall rules were corrected. Known-device history recovery,
the dedicated DM section, role editing, channel types, and responsive navigation
already exist; the work below improves their clarity and reliability.

The guiding rule is familiar behavior: servers on the left, channels within a
server, DMs in their own section, predictable back navigation, and plain language
for anything requiring a decision. Keep advanced Matrix details in diagnostics.

## First: remove everyday friction

The file-size control in item 1 is implemented in this checkpoint; see
[upload settings and deployment](UPLOAD_LIMITS.md). The remaining items are
proposed work, ordered below, rather than claims of completed features.

| Priority | Improvement | User outcome | Acceptance |
| --- | --- | --- | --- |
| 1 | Administrator-controlled attachment size | Admin → Storage offers file-size presets and a custom value, separately from total storage quotas. | A file above the old 10 MiB limit sends and decrypts after an admin raises the limit. Oversized files and full quotas remain blocked. Saved values survive restart. |
| 2 | Simpler empty states and first-use guidance | A new member sees one useful next action: message someone, choose a channel, or join voice. | Remove repeated welcome cards and technical setup copy from an already active conversation. Preserve the existing onboarding flow and add a way to reopen help. |
| 3 | Consistent error messages | Errors say what failed, what the user can do, and whether their draft is safe. | Upload, invite, login and call failures have an appropriate retry/open-settings action. Technical details remain expandable and redact credentials. |
| 4 | Quiet, understandable encryption status | Existing recovery runs in the background; users only see a prompt when an action is needed. | Known-device login stays quiet. A new device explains the email verification step once. Lost historical keys are described honestly; recovery never silently replaces an existing identity. |
| 5 | Resume the last conversation | Opening a server, switching to DMs, and refreshing retain the conversation the user expects. | Remember a joined room per section/account, validate membership before restoring it, and fall back to a useful list when it is gone. Keep unread markers separate from navigation. |
| 6 | Predictable mobile behavior | Back, orientation changes, typing and opening a drawer feel consistent. | Test real Android Chrome and iOS Safari: keyboard, safe areas, attachment picker, tap targets, focus return and device rotation during a call. Expand the existing emulation coverage rather than adding a second mobile app. |

## Next: make community management understandable

| Priority | Improvement | User outcome | Acceptance |
| --- | --- | --- | --- |
| 7 | Guided server setup | The existing creation flow offers useful starting layouts for friends, gaming, study and a small team. | Preview the channels, choose what to include, and edit everything afterward. Reuse current channel types and permissions; never create duplicate rooms after a partial failure. |
| 8 | Explain channel types before creation | Text, voice, forum, announcement and media channels each show a short example. | The form reveals only relevant options first. A voice channel opens its participant view immediately; optional discussion is clearly separate. |
| 9 | Explain access and role inheritance | Owners can answer “Who can join?” and “Why can this person do that?” | Show effective role/category/channel rules alongside native Matrix membership limits. Mark uncertainty explicitly; a preview must not claim to enforce access. |
| 10 | Cleaner role assignment | Existing role colors, emoji, grouping and member selection become easier to scan. | Searchable assignment, a readable role preview, clear hierarchy restrictions and a visible unsaved-change indicator. Preserve drafts on rejected saves. |
| 11 | One useful admin overview | Admins see storage pressure, failed services, mail readiness and call setup in one place. | Each issue links to its existing settings or diagnostic action. Separate a successful local test from verified external connectivity. Keep instance administration distinct from server moderation. |
| 12 | Notification presets | “Everything,” “Mentions,” and “Quiet” explain their effect at account, server and channel levels. | Show which setting is inherited and which is overridden, and offer a clear reset-to-inherited action. Preserve existing timed mute and DND behavior. |

## Optional features worth adding

| Feature | Why it is useful | Scope and dependencies |
| --- | --- | --- |
| Temporary voice rooms | A “Join to create” lobby opens a room for a small group and cleans it up when everyone leaves. | Reuse existing encrypted calls. Requires durable lifecycle tracking, room limits, owner controls and cleanup after disconnects. Higher effort. |
| Sticker packs | Custom artwork makes a server feel personal without changing core messaging. | Reuse image processing and media storage; add pack management, picker previews and accessible text. Medium effort. |
| Find a time together | Compare members' voluntarily shared time zones and choose a meeting time without mental conversion. | Extend existing events, calendars and profile time zones. Add RSVP/reminders only where missing; do not infer private availability. Medium effort. |
| Personal home page | A useful landing page collects unread DMs, mentions, saved items and upcoming events. | Build on existing lists and read state; let users choose between Home and their last conversation. Medium effort. |
| Better upload recovery | Long uploads show progress, cancellation, retry and clearly identified server/proxy limits. | Existing progress and cancellation should be reused. Resumable encrypted uploads are a separate larger project requiring server-side chunk validation, quotas, expiry and cleanup. |
| Small opt-in personalization | A few per-server sounds or visual accents help distinguish communities. | Respect reduced motion, DND, accessibility and existing theme settings. Off by default; no autoplay media. Smaller effort. |

## Delivery order and completion rules

1. Finish file-size configuration and validate a real encrypted attachment above
   10 MiB, including quota rejection and the deployment upgrade.
2. Ship empty-state, wording, error and conversation-resume improvements together.
3. Refine the existing server/channel/role editors; test as both owner and member.
4. Complete physical-phone acceptance and repair observed issues.
5. Add one optional feature at a time, starting with scheduling or sticker packs.

For each checkpoint, record what changed, the workflows tested, and remaining
device/deployment limits. Push testing checkpoints to **V3**. A complete Discord
experience is a broad product target, not a claim attached to a single update.
The [implementation checklist](IMPLEMENTATION_CHECKLIST.md) remains the detailed
inventory; this document supplies priority and user-facing acceptance criteria.
