# Community experience roadmap for V3

This roadmap follows the September 12, 2026 product request. It extends the
current client and its Matrix-backed features. Familiar server, channel and DM
navigation should coexist with Tavern's own visual identity.

## Audit and decisions

| Area | Current implementation | Improvement needed |
| --- | --- | --- |
| Navigation and mobile | Dedicated Home/DM/server rail, favorites, folders, account-scoped conversation restoration, back/forward navigation, responsive drawers and device/viewport detection | Refine density, discoverability, touch interactions and physical-phone acceptance |
| Server creation | Existing private Matrix Space creation, starter templates and channel receipts that support partial retries | Replace the flat form with guided creation and an editable category preview |
| Channels and categories | Text, voice, video, forum, announcement, rules, media and read-only types; private audiences, ordering, archives, slow mode and category permissions | Surface relevant controls earlier; organize management into clear sections |
| Roles and members | Multiple roles, hierarchy, colors, icons, assignments, native enforcement and effective-access explanations | Improve bulk workflows, hierarchy feedback and searchable assignment |
| Profiles and expression | Global/server profiles, artwork, status, profile limits, emoji, stickers and server personalization | Consolidate editing and improve picker/onboarding discovery |
| Messaging | Encrypted messages/files, drafts, replies, threads, mentions, search, bookmarks, unread navigation and notification presets | Improve composer flow, thread follow-up and understandable notification inheritance |
| Administration | Upload-size settings, quotas, reports, audit events, diagnostics and gated operations | Prioritize actionable issues and separate instance administration from community moderation |
| Calls and recovery | Existing direct/conference calls, device controls, participant telemetry and known/new-device history recovery | Preserve working transport; refine fault recovery and messages without recurring recovery prompts |
| Shared UI | Radix dialogs, context menus, reusable errors, theme tokens and responsive modal containment | Expand consistent management layouts and measured accessibility/performance coverage |

Preserve these systems. Do not create alternate permission stores, a second
mobile application, another recovery identity, or a separate calling stack.
The main implementation debt is dense management UI and asynchronous work that
must remain tied to the initiating account. Unsupported server capabilities
must be visibly unavailable; client-side explanations do not grant permissions.

## Phased implementation

| Phase | Cohesive deliverable | Acceptance |
| --- | --- | --- |
| 1 — Guided creation | Identity, optional icon, eight layouts, editable categories/channels and review | Real private rooms, accurate category placement, no duplicate retry, account fencing, keyboard/mobile checks |
| 2 — Server management | Unified settings navigation and optional owner setup checklist | Existing settings open from real actions; explicit save/cancel and draft preservation; checklist reflects saved state |
| 3 — Roles and members | Clear role hierarchy, searchable/bulk assignments and access inspector polish | Native authorization remains authoritative; destructive actions require confirmation; rejected saves preserve drafts |
| 4 — Profiles and emoji | Consolidated profile/status editing, server identity, emoji and role artwork/display workflows | Permissions and profile limits remain enforced; artwork uses authenticated media; keyboard and mobile pickers work |
| 5 — Messaging and discovery | Composer, threads, search, command navigation and notification refinement | Preserve drafts and scroll; predictable shortcuts; real thread follow/unread state and clear inherited settings |
| 6 — Moderation and administration | Reports, audit and admin overview improvements | Human-readable events, actionable failures, server/instance authority kept distinct |
| 7 — Call resilience | Recoverable call UI and clearer device/network feedback | A failed call cannot take down messaging; reconnect and device changes preserve user control and encryption |
| 8 — Mobile, accessibility and performance | Cross-cutting refinement and measured acceptance | 320/375/430/768/desktop layouts; focus, contrast and reduced motion; real-phone checks and measured loading/scroll performance |

Phases 1–3 are implemented in these checkpoints. Phases 4–8 are the next work, building
on their already implemented foundations. No placeholder controls were added
for those future phases. Mobile and accessibility checks apply to each phase,
not only to the final phase.

## Phase 1: delivered behavior

The creation dialog now moves through **Your space → Channels → Review**. It
provides Blank, Friends, Gaming, Community, Work / Team, Development, Study group
and Custom layouts. Layout drafts are retained while switching templates within
the open dialog. Closing the dialog discards an unsubmitted draft.

Owners can upload/crop an optional icon, edit up to eight starting categories,
reorder categories, and add, rename, reorder or remove up to 24 starting channels.
Each channel has a type, category and description; inclusion is explicit.
Removing a category preserves its channels as Ungrouped. Additional channels and
categories can still be created afterward with the existing management controls.
These starting limits do not lower existing server layout limits.

The final preview shows the chosen channel types and category placement. Welcome
text and notification defaults remain available. The creator retains the existing
owner authority. Channels remain invite-only and use the existing encrypted
channel creation path. Names, descriptions and server artwork remain metadata,
not encrypted conversation contents. A voice/video channel does not acquire a
microphone or camera merely because it was created.

Unavailable typed-channel support is shown explicitly. Creation progress and
completed-channel receipts remain visible on partial failure. Retrying finishes
acknowledged rooms; it does not recreate completed rooms. An unconfirmed creation
response pauses automatic creation retries and points the owner to their existing
server/channel list. A created server can be opened even if optional setup failed.

### State, backend and permissions

- Existing `io.tavern.server.layout` version 1 categories are included in the
  Space's initial state. Channel creation places each room into the reviewed
  category through the existing checked layout update path.
- The optional icon uses `m.room.avatar`. Existing branding, notification,
  onboarding and role-policy events keep their current formats.
- No new backend endpoint, permission, database migration or deployment variable
  is required. Existing Synapse validation, native membership/power levels and
  server role enforcement remain authoritative.
- Initial-state validation rejects malformed categories/artwork before creating
  the Space. Configuration loading, image preparation and creation callbacks
  remain tied to the initiating account; room receipts are retained for retries.

### Validation and practical limits

Final local checks (September 12, 2026):

| Check | Result |
| --- | --- |
| `npm test` | 707 passed |
| Full Playwright suite, two workers | 482 passed |
| `python -m unittest tests.test_roles tests.test_channel_policy` | 32 passed |
| `npm run build` | Passed TypeScript checking and the production Vite build |
| Changed documentation links and `git diff --check` | Passed |

The new browser coverage exercises 320, 375, 430, 768 and 1280px widths,
keyboard step focus, category/channel editing and order, retained template drafts,
unavailable channel types, uncertain acknowledgements, retry receipts, actual
shared image-editor callbacks and account changes during upload/creation/opening.
Crop and upload transport are controlled test doubles in the image race tests;
they do not claim a live media upload to the deployment.

Coverage includes actual Matrix request construction, model bounds, partial
retries, unknown acknowledgements, unavailable channel types, icon upload/account
changes, keyboard focus and viewport containment. The dialog keeps its heading
and close control visible while the form scrolls. Starting-layout choices use
native radio controls; primary actions and the close control have 44px targets.

The flow adds no dependencies and reuses the existing dialog, image editor,
error display, channel creation and theme tokens. Its editable list is bounded
at 24 starting channels; server timelines and navigation retain their existing
loading behavior. This is not a performance benchmark or a complete WCAG audit.

No live homelab server creation or physical Android/iOS device acceptance was
performed from this Windows workspace. Existing CI/container limitations are
documented in [V3 hardening](V3_HARDENING.md). Follow the existing
[installation guide](INSTALLATION.md) for deployment.

The preceding hardening checkpoint (`5424493`) failed GitHub CI at **Start clean
canonical stack and verify persistence**; its channel-menu job passed. Follow-up
access to the job logs identified an obsolete attachment-button selector. The
`f8c63c2` rerun passed real encrypted uploads/downloads, authenticated avatar
thumbnails, fresh-device email recovery, DM persistence and invitation privacy.
It next exposed a moderation probe that submitted an identical native join
update. That probe now exercises a changed event and a fresh invited join across
ban/lift transitions. Full-stack acceptance still requires a passing complete
workflow on the updated revision; see [validation](VALIDATION.md).

## Phase 2: server management and friends

Server settings open on **Overview**. The optional owner setup guide derives
progress from synced artwork/description, linked channels, welcome settings,
custom roles and other joined/invited members. Actions open the existing editors;
opening a step never marks it complete. Hiding the guide lasts within that open
settings window. It does not create a new permission or configuration store.

Authorized integrations, report review, audit and warnings are available beside
organization, welcome, roles, emoji, stickers, notifications and invitations.
The shared settings navigation mounts editors when visited and retains their
drafts when changing sections. Account/server replacement retires that scope;
hidden panels cannot take focus. Existing direct menu entry points remain.

The creation wizard now keeps Back/Continue/Create visible while its body
scrolls. Channel-type cards use consistent spacing, explicit selection and
44px controls. Both flows retain native authorization and partial-creation
receipts. The wizard is checked at 320/375/430/768/1280px.

**Direct messages → Friends** provides copyable, revocable friend codes,
received/sent requests, search and existing remove/block/privacy controls.
The view survives reload and browser navigation. An optional server address
defaults to this instance; federation and cross-instance discovery remain
disabled. See [Friends](FRIENDS.md) for workflow, API, privacy and the additive
database change. Friendships do not grant community membership or decrypt keys.

Coverage includes code persistence after database reopen, code collisions,
recipient authority, privacy/block checks, replacement during profile lookup,
same-origin protection, audit redaction, deactivation cleanup, account changes,
late replies, mobile layout and settings-draft retention. The real-stack smoke
also exercises the production Friends screen and API; fixture-based browser
tests are not presented as deployed acceptance.

## Phase 3: roles and member management

**Server settings → Roles** now explains the administrator's highest role and
protected positions. Dragging inserts a role at its destination; Move higher
and Move lower provide keyboard and touch alternatives. Display, grouped
permissions and existing single-member assignment remain in the same editor.
Read-only assignments explain automatic roles, hierarchy and missing grants.

The **Manage members** section searches loaded members by name or account ID and
filters assigned/unassigned members. Select up to 50 eligible members, choose
Add or Remove, and review the exact selection. Search and filter changes retain
selection. **Update role draft** stages all assignments together; **Save roles
and permissions** applies the complete draft. Other roles stay assigned. The
list initially shows 50 results, with explicit controls for showing more and
loading remaining native members. Assigning a role does not invite or join a
member to any channel.

Removing a role requires confirmation showing affected member assignments and
channel/category overrides. Roles used by private-channel audiences must first
be removed from those audiences through channel settings. Failed saves preserve
the draft. A changed account or server retires its editor and pending reviews.

**Explain a member's access** searches members and actions, filters allowed or
blocked decisions, and explains server, category and channel precedence. It uses
synced settings, explicitly excludes unsaved drafts, and separately reports
native channel membership and authority. Other governing servers and deployment
capabilities can still restrict an action.

The follow-up Discord reference adds highest-role name colors and a single
hierarchy-selected icon in chat, member lists and profiles. Profiles retain the
full assigned role list. Online members use their highest separately displayed
role group; offline members remain together. **Preview roles** compares combined
role rules without impersonating anyone or including member-specific exceptions.
See [role management](ROLE_MANAGEMENT.md) for current behavior and compatibility
limits. Remaining Discord role artwork, display, permission and integration
differences remain explicit follow-through work; this is not a claim of exact
feature parity.

### State and authorization

This phase uses the existing `io.tavern.roles` event and Synapse module. There
are no new endpoints, permissions, database migrations or environment variables.
Every saved role policy, including older policies without call/audience version
markers, now carries its current native revision. Save preflight reads fresh
membership and power levels for changed assignments; a stale revision, departed
target or native peer rejects the whole save. Existing native authorization
remains authoritative. Role deletion only removes obsolete assignments and
overrides; it does not rewrite private-channel audiences.

The interface adds no dependencies. Member results and reviewed selections are
bounded, editors retain their drafts when switching tabs, and hidden controls
cannot take focus. Browser coverage checks 320/375/768/1280px layouts, native
checkbox and keyboard controls, stale saves, promotion during review and account
replacement. The isolated stack smoke additionally exercises styled-role
creation, a two-member bulk save, native rejection of unauthorized elevation
and reviewed removal through the real UI. See the [validation record](VALIDATION.md)
for observed results; physical-phone acceptance and performance measurements
remain release work. Phase 4 is profiles, status and emoji workflows.

### Phase 4 first checkpoint: server emoji editing

The existing emoji collection now has a square preview, image-name suggestion,
slot count, explicit file/GIF handling, current/previous-name search and clear
empty results. Rename and removal show the selected image and retain rejected
drafts. Removal refuses an image replaced since the confirmation was opened.
Recent aliases continue to resolve historical shortcodes.

The implementation reuses authenticated image upload/cropping and the existing
mounted editor ownership guard. It checks the original account, device, client,
server and native state permission after asynchronous work and inside each
queued change. Closing an editor stops work that has not been sent; a state write
already acknowledged by the server stays acknowledged. Uploads already sent may
remain in media storage if the subsequent emoji state write fails.

Same-client changes are queued per server and reread native state. This is not
a new cross-device transaction protocol; simultaneous writes from separate
clients still follow native Matrix state resolution. No permission or state
format migration is introduced. Native Synapse authorization remains final.

The shared chat-avatar context menu now forwards its trigger to a DOM element,
preserving profile clicks and right-click role actions. Profile/status editing,
uploaded role artwork and broader role display styles remain next phase work.
