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
| 4 — Profiles and emoji | Consolidated profile/status editing, server identity and emoji workflows | Permissions and profile limits remain enforced; artwork uses authenticated media; keyboard and mobile pickers work |
| 5 — Messaging and discovery | Composer, threads, search, command navigation and notification refinement | Preserve drafts and scroll; predictable shortcuts; real thread follow/unread state and clear inherited settings |
| 6 — Moderation and administration | Reports, audit and admin overview improvements | Human-readable events, actionable failures, server/instance authority kept distinct |
| 7 — Call resilience | Recoverable call UI and clearer device/network feedback | A failed call cannot take down messaging; reconnect and device changes preserve user control and encryption |
| 8 — Mobile, accessibility and performance | Cross-cutting refinement and measured acceptance | 320/375/430/768/desktop layouts; focus, contrast and reduced motion; real-phone checks and measured loading/scroll performance |

Phase 1 is implemented in this checkpoint. Phases 2–8 are the next work, building
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
canonical stack and verify persistence**; its channel-menu job passed. The job
logs were unavailable with the credentials in this workspace. Local frontend
checks do not establish that this separate full-stack failure has been resolved.
