# Role management

Open **Server settings → Roles** to find and select a role. The selected role has **Display**, **Permissions**, and **Manage members** tabs. The role list shows assignment counts and marks roles at or above your authority as read only. Search and keyboard-operable tabs work on narrow screens; the full permission list is divided into conversation, voice/video, moderation, and server-management groups.

Appearance includes a name, emoji or short symbol, suggested icons, color palette, custom color, and a preview. Clearing the icon or choosing the default color removes that override. Roles can be displayed separately in the member list or made mentionable. Duplicate role copies its appearance and explicit permissions but starts unassigned and not mentionable. The default Member role cannot be removed. Order can be changed by dragging or with the higher/lower buttons.

**Assign member roles** filters joined members below your current native and server-role authority. The member profile's separate role dialog offers searchable checkboxes and a preview of selected badges. Searching never removes hidden selections. You cannot grant a permission you lack or promote a member to your own authority. The native Synapse policy validates every write independently.

Channel overrides are available in the server role editor and directly under **Edit channel → Permissions → Channel role permissions**. The channel view locks the destination and reuses the same policy and save path. See [channel role permissions](CHANNEL_ROLE_PERMISSIONS.md) for inheritance and restriction examples. Category permissions remain in the category editor. Category rules apply before explicit channel rules; role denies win over other role allows at each level, and an individual member override wins over role rules at that level. Room membership still controls history access. Separate conference publishing controls require the explicit [publication migration](CONFERENCE_PUBLICATION.md).

Role changes are drafts until saved. New roles, duplication, removals, appearance changes, order, and assignments use the same save. Reload saved roles deliberately discards the local draft. Saving a stale full-role draft refuses to overwrite newer roles or member assignments and leaves the draft visible. Independent category updates are preserved. The member dialog merges only the selected assignment changes into current native state.

Editors and queued writes belong to the captured API account generation, Matrix client/user/device, server membership, and mounted target. Navigation, account replacement, lost membership, or authority changes suppress stale completion and prevent a subsequent write for another account. A native write already accepted before a change cannot be undone by a local cancellation; the UI does not report its delayed acknowledgement as a new account's success.

## How roles appear

Chat, member lists and profiles share the same display rules. A member's name
uses their highest role that has a color. One icon appears beside it, from the
highest role that has an icon. These choices are independent: clearing a higher
role's color or icon lets a lower role supply it. Role edits and removals update
the displayed identity from current synced settings. Direct messages without a
server context keep their normal names.

Click a chat name or a member to open their profile. Profiles show the complete
assigned role list in hierarchy order, with icons and colored dots. Right-click
a chat name for member actions, including **Assign roles** when authorized.
The automatic
Member role is omitted from that badge list; ownership has its own marker.
Online/away members appear under their highest role marked for separate display.
Other online members and all offline members have their own groups. A member
appears once, even when several roles are marked for separate display.

These presentation choices follow Discord's documented
[role display and hierarchy](https://support.discord.com/hc/en-us/articles/214836687-Discord-Roles-and-Permissions)
and [single-icon fallback](https://support.discord.com/hc/en-us/articles/4409571023639-Custom-Role-Icons-FAQ).

## Review and apply assignments

In **Manage members**, search names or account IDs and filter assigned or
unassigned members. Choose Add or Remove, select up to 50 eligible members,
then review their names. Searches and filter changes retain selections.
**Update role draft** stages the changes; **Save roles and permissions** applies
them together. Other roles remain assigned. The list initially shows 50 results;
Show more and Load remaining members are explicit actions.

Removing a role asks for confirmation and counts affected assignments and
channel/category overrides. A role used by a private-channel audience must first
be removed through that channel's audience editor. Saves recheck current native
membership, authority and the saved event revision. Rejected saves retain the
draft for review.

## Preview access

Expand **Explain a member's access** to inspect a member or choose **Preview
roles**. Select one or several roles, a channel, and an action. The preview uses
the same server/category/channel calculation as real role decisions, without
owner authority or member-specific exceptions. It does not impersonate a user,
join a room or reveal inaccessible messages. The member view includes personal
exceptions and reports native membership and authority separately.

## Compatibility and follow-through

This phase implements familiar role display and management on Tavern's current
permission system. It does not claim every Discord permission or integration.
In particular, Tavern retains deny-first role overrides and native Matrix
membership/power ceilings; a role cannot grant missing decryption keys or create
an Administrator bypass. [Role mentions](ROLE_MENTIONS.md) retain their current
audience and encryption rules.

The [roadmap](COMMUNITY_UX_ROADMAP.md) carries forward uploaded role artwork and
enhanced display styles with profiles/emoji, plus an explicit audit of remaining
Discord permission, mention and integration differences. Current role icons are
emoji/short symbols. External-account linked roles and Discord subscription or
boost features are not provided by this checkpoint.
