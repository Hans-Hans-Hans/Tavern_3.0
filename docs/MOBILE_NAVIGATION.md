# Responsive navigation

Tavern selects its interface automatically. Narrow windows use compact
navigation. Phone browser hints and touch/viewport measurements keep that
interface when a phone rotates to landscape. A roomy tablet or touch laptop
keeps the full server and channel columns. No server setting is required and
device detection is neither stored nor sent to the server.

The phone interface provides:

- A bottom bar for profile, servers, direct messages, mentions and settings.
- The same server rail inside the navigation drawer, including folders,
  favorites, unread badges and server management actions.
- Server selection followed by channel selection. Choosing a server keeps
  the drawer open; choosing a channel opens the conversation and closes it.
- A dedicated DM section and a shortcut back to the last browsed server.
- Larger navigation and composer targets, horizontally scrollable composer
  tools, bounded drawers, and a compact layout for short landscape screens.
- Visual viewport handling to keep the composer above the phone keyboard.
  The bottom bar hides while the keyboard consumes the viewport; pinch zoom
  does not reflow the app into a different device layout.

The desktop DM icon is centered inside its button. Server and DM headings use
the interface font and truncate long names instead of wrapping across controls.

These changes use familiar Discord navigation patterns within Tavern's existing
Matrix rooms, profiles and permissions. They do not represent complete Discord
feature or visual parity. Native iOS/Android keyboard, safe-area and gesture
acceptance still requires physical-device testing; Chromium phone/tablet
emulation covers the automated layout and navigation regressions.

Implementation: [device layout](../lib/device-layout.ts),
[viewport handling](../hooks/use-mobile-viewport.ts),
[phone shortcuts](../app/mobile-navigation.tsx),
[responsive styles](../app/responsive-navigation.css), and
[workspace browser checks](../tests/browser/dm-requests.spec.ts).
