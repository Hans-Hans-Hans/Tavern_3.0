# UI refinement audit

## Before implementation

The application is a Vite/React SPA. `app/auth-gateway.tsx` opens the managed
account session; `app/tavern.tsx` owns workspace, channel, global-view, tab and
dialog state. Hash links, `conversation-memory.ts`, generation guards and the
command palette handle navigation. `lib/matrix.ts` supplies live room data,
message operations and account preferences. No router replacement is needed.

| Area | Existing implementation and behavior | Refinement |
| --- | --- | --- |
| Server/global navigation | `server-navigation.tsx`, `mobile-server-navigation.tsx`, Tavern's rail; server folders, favorites and Move dialogs already support drag and keyboard alternatives. The workspace menu and rail repeat personal settings. | Label global destinations, retain server selection and folders, put personal settings/admin in a profile menu. |
| Channel navigation | `channel-navigation.tsx` has a Categories toolbar inside Tavern's Channels heading; root channels can get an unnecessary Uncategorized heading. Category collapse, edits, permissions and drag/drop already persist via Matrix. | One Channels heading and contextual creation menu; keep actual category actions and authorization. |
| Header/tabs | Tavern header, Messages/Files/Pinned/Work tabs, member/mute controls. Encryption appears in global header, tab caption, composer footer and overview. | One room security control with a factual SDK-driven popover; retain prominent channel tabs. |
| Information | Always-rendered `.channel-overview` desktop panel duplicates description; separate `detail-sheet` holds management. Existing `detail` boolean opens the sheet only. | Account-persisted collapsible overview with a drawer at narrower widths; keep management in the existing sheet. |
| Timeline | `message-list.tsx` uses TanStack virtualization, stable event keys, measured heights, end anchoring/follow-on-append. Tavern sets near-bottom state, opens latest messages and preserves height on pagination. Short lists sit at the top and new arrivals lack a persistent jump control. | Bottom alignment for short lists using normal layout; respect reading position and add a jump-to-latest affordance. |
| Composer | Tavern's `Composer` owns draft-store integration, uploads/retry, mentions, formatting, emoji, threads, scheduled/outbox delivery, IME-aware configurable Enter handling. Fixed textarea minimums grow at large widths. | Compact autosizing textarea without altering send/upload/draft code. |
| Secondary navigation | Mentions, Threads, Saved, Message requests and Private discussions are flat siblings; Files/Work/Pinned are channel tabs. | Separate global activity from contextual conversations; retain all routes, unread counts and Work. |
| Preferences/styles | `io.harbor.preferences` is read/written through `safePrefs` in Matrix; design tokens and global/product CSS define the current palette. `responsive-navigation.css` and Sidebar/Sheet provide mobile/keyboard behavior. | Reuse the existing io.tavern.appearance memberList preference for info-panel visibility; scoped CSS using existing tokens. |

Reusable Radix menus, dialogs, sheets, tooltips and tabs already manage keyboard
interaction and focus. `IconButton` supplies accessible tooltip labels. The
mobile interface uses a visual-viewport-aware shell and drawer navigation;
styles also distinguish 767px, 1100px, 1250px and 1600px. Touch targets need
consistent sizing without enlarging the composer. Reduced motion is already
honored globally.

All message mutations, pagination, categories, permission predicates, deep links,
encryption key management and room membership checks must remain in their
existing owners. The security popover will read room encryption and SDK device
verification status; preview/disconnected/unknown states will be explicit.

## Implementation

1. The rail keeps Home, All channels, DMs, servers and folders. Server selection
   exposes its current state; global/server controls have named tooltips and
   keyboard focus styling. Redundant personal gears and the duplicate mobile
   server-picker entry were removed; the mobile navigation drawer retains the
   actual server rail, folders, contextual actions and keyboard Move controls.
2. `ChannelNavigation` owns one **Channels** heading. **Channel actions** opens
   channel/category creation. Categories keep collapse, drag/drop, exact Move,
   notifications, permissions, rename and deletion. Uncategorized appears when
   actual categories and root channels coexist; an empty list has an empty state.
3. `ChannelInfoPanel` is controlled by **Show/Hide channel information**. It uses
   the existing `io.tavern.appearance.memberList` account preference through
   `useChannelInformation`; explicit saved true/false values are honored. Missing
   preferences now default false. The same choice is editable in Appearance.
   Desktop shows a collapsible aside; widths at or below 1100px use a dismissible
   Sheet with focus returned to the header. The panel keeps members, files,
   pinned messages, room-scoped search and channel management. Its duplicate
   channel description and promotional/privacy copy were removed.
4. Short lists use a normal flex column and automatic space above the measured
   virtual list. Message order is unchanged. The existing virtualizer retains
   event keys, end anchoring, pagination and measured attachment heights. It now
   also observes its own measured height when positioning a short list.
   New arrivals while reading older messages show **Jump to latest**. Delayed
   follow-to-bottom callbacks check both their request generation and the
   current viewport so a late response cannot override navigation or reading.
5. `useComposerAutosize` measures wrapped text and restored drafts. It starts
   around one line and is bounded by 180px or 28% of the visual viewport, then
   scrolls internally. Toolbar, send controls, attachments, IME-aware shortcuts,
   typing, drafts, outbox and encrypted send paths retain their existing owners.
   The footer's shortcut hint now follows the configured Enter behavior.
6. `ChannelSecurity` is the primary room indicator. It reads the SDK's actual
   room encryption state and this device's verification status separately,
   observes security changes, and discards results for replaced accounts/devices.
   Its popover explains unencrypted, unavailable and incomplete-verification
   states without inferring participant trust. Repeated header/tab/composer/
   overview encryption claims were removed. No algorithm or trust decision changed.
7. **Activity across channels** groups Mentions, Threads and Saved. Requests and
   private discussions have a separate Conversations group. Files, Pinned and
   Work stay in the channel tabs. Existing hashes, counts and command-palette
   destinations are retained.
8. `ProfileMenu` groups My profile, Personal settings, Privacy/devices, About and
   Administration. The server menu keeps Server settings and existing management
   actions. Admin visibility is based on the account API's session result and
   retires on account replacement. Existing backend authorization is unchanged.

`ui-refinement.css` scopes spacing, focus, touch targets and responsive styles to
the existing shell and palette. Existing reduced-motion, theme, zoom, density and
mobile visual-viewport mechanisms are reused. No dependencies, APIs or database
schemas were added or changed.

## Validation and screenshots

The commands were executed with the isolated Node 22 runtime under `work/`:

```sh
npm run build
node --test 'tests/*.test.mjs'
npx playwright test tests/browser/channel-navigation.spec.ts tests/browser/composer-outbox.spec.ts tests/browser/message-drafts.spec.ts tests/browser/message-list.spec.ts tests/browser/dm-requests.spec.ts tests/browser/mobile-server-navigation.spec.ts tests/browser/server-navigation.spec.ts tests/browser/private-workspace.spec.ts tests/browser/ui-refinement.spec.ts tests/browser/appearance-controls.spec.ts tests/browser/appearance.spec.ts tests/browser/keyboard-shortcuts.spec.ts --workers=1
git diff --check
```

The build includes `tsc --noEmit`. There is no lint script in package.json.
Build and all 757 client unit tests passed. The final combined browser run passed
all 95 tests in two minutes; individual suites cover navigation/deep links,
role ceilings, category creation/editing/deletion/reordering, drafts, send retry,
attachment/outbox paths, private discussions, virtualization/pagination,
changing attachment heights, security state, keyboards and responsive layouts.

Initial browser checks found outdated selectors for moved category, channel
details and search controls. These tests now use the contextual menus/panel;
their original message, permission and persistence assertions are retained.

Captures use the SDK-backed workspace fixture, not production accounts. The
fixture's crypto is initially unavailable, and the security control reports that
instead of presenting a verified/encrypted assurance. Screenshots include the
375, 430, 768, 1024, 1440 and 1920px layouts, plus dark mode and short history.
Captures use reduced motion to avoid recording an in-progress theme transition.

- [Before, desktop](../work/ui-refinement/before-1440.png)
- [After, desktop](../work/ui-refinement/after-1440.png)
- [Before, phone](../work/ui-refinement/before-375.png)
- [After, phone](../work/ui-refinement/after-375.png)
- [After, dark](../work/ui-refinement/after-dark-1440.png)
- [After, short history](../work/ui-refinement/after-short-history-1440.png)

Artifacts and test logs are in the ignored `work/ui-refinement/` directory.

## Target-host verification and remaining improvements

Browser tests run real components/SDK models with mocked network services. They
do not establish delivery against your production Matrix, SMTP or media servers.
No production service was deployed or account modified by this refinement.

Before release, use two test accounts on the actual deployment:

1. Switch servers, collapse categories, create/move/delete a category, create a
   channel, and reopen saved room/event links. Repeat as a member without channel
   management rights; confirm native/API authorization rejects unauthorized writes.
2. Send and receive text, IME text and encrypted media from both devices; add a
   reaction, edit/redact a message, reply in a thread and open a private discussion.
3. Read older messages while another account sends; verify the latest indicator,
   earlier-history pagination, attachment-height changes and message-link focus.
4. Toggle channel information, switch rooms, sign in on another device and check
   the saved preference. Check drawer Escape/close focus, members, Files, Pinned,
   Work and contextual search at phone, tablet and desktop sizes.
5. Compare the security popover on encrypted and unencrypted rooms and verified
   and unverified devices. Confirm that reading the popover changes no trust/key
   settings. Verify personal/server/admin menus as each role.
6. Check light/dark/system themes, preferred font/scale/density, reduced motion,
   hardware keyboard navigation, mobile zoom and the real on-screen keyboard.

A dedicated screen-reader and contrast audit of all existing dialogs/metadata,
plus live browser/device coverage for voice/video, remains a separate validation
effort. These changes improve accessibility but do not claim WCAG certification.
