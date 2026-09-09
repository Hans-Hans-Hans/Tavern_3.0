# Moderated server nicknames

Members can already customize their own server profile. **Manage server nickname** adds an override for another current member when the operator has the server role permission `manage_nicknames` and sufficient native Matrix state power. Both the target's custom role and native power must be strictly below the operator's. The server owner also respects the native hierarchy, including room version 12 creators.

The override changes the visible name in Tavern's server profile and linked channel context. The member's Matrix ID, avatar, biography, own server profile and global account remain unchanged. Removing the override restores the member's chosen name. The own-profile editor explains when a moderator override is active. Other Matrix clients that do not understand this Tavern event continue to show the underlying membership profile.

The event is `io.tavern.server.nickname`, stored only in the managed, non-federated Space with the target's Matrix ID as its state key:

```json
{
  "version": 1,
  "name": "Server nickname",
  "io.tavern.previous_event": "$previous_event_id"
}
```

The first write uses a null previous event ID. An explicit null `name` removes the override. Names contain 1–60 trimmed characters and no control characters. The Synapse policy validates the complete shape, current joined memberships, state power, role permission and both target hierarchies. Active temporary bans and timeouts prevent an operator from changing nicknames. Every set and clear requires the current event ID; redaction cannot remove an override. Channel and category overrides cannot grant this server-wide permission.

The editor fetches fresh server state before saving. A conflict preserves the draft and offers an explicit reload. It never sends an `m.room.member` update on another person's behalf or changes their global profile. Server members and the homeserver can read the nickname state and its actual sender; the server audit view includes nickname changes and removals.

Validation covers the actual Synapse policy callback, native and custom hierarchy, room version 12 creators, revoked memberships and permissions, malformed input, restrictions, revision conflicts and protected redactions. Browser tests exercise setting, clearing, profile preservation, concurrent edits and target promotion during the fresh check.
