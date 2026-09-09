# Server profile metadata rules

Server settings can limit the plaintext extended profiles published into that server and its channels. Rules are opt-in. A server with no rule event, or a valid disabled event, keeps the previous publication behavior.

An enabled rule can disable structured profile links, disable custom fields, and set a bio limit of 0, 160, 500, or 1000 UTF-16 code units and a status limit of 0, 40, 80, or 160 units. A zero status limit also disallows a nonempty status emoji. These are the same units used by JavaScript string lengths; many emoji use two units. Tavern's local projection avoids cutting an emoji between its surrogate pair.

## Storage and authority

The native Matrix state event is `io.tavern.server.profile_policy`, with an empty state key:

```json
{
  "version": 1,
  "enabled": true,
  "allowLinks": false,
  "allowCustomFields": true,
  "maxBioLength": 500,
  "maxStatusLength": 80,
  "io.tavern.previous_event": null
}
```

Every field is required. `io.tavern.previous_event` is `null` for the first event and the current policy event ID for an update. A stale revision is rejected. Policy events can only be written in a local, non-federated Matrix Space. The actor must currently be joined and have both native state authority and the Space's `manage_server` permission. A Space without a Tavern role policy permits its native creator to configure the setting, subject to native state power. Authority and revision are read again after asynchronous state access. Existing Matrix and Tavern authorization checks still apply.

Redaction cannot remove a policy. Disable or repair it by publishing a new valid revision. Removing a protected parent/child relationship requires the parent Space's native creator, as well as the existing room authorization. Relationship redaction cannot bypass the rule.

For publications, the module combines every directly attached canonical parent whose Space has a reciprocal child link, up to 32 parents. Each applicable restriction must pass; a less restrictive child rule cannot override a stricter parent rule. A private discussion uses the immutable source binding in its `m.room.create` event and the source channel's canonical parents. Private discussions cannot supply a different source in a member profile. Current room and policy state are read again before accepting the publication, including when the first observed policy was absent or disabled.

## Publication behavior

The Synapse module checks the `io.tavern.profile` extension on `m.room.member` events with `membership: "join"`, before Tavern's ordinary self-membership shortcut. With an enabled rule, only the account itself may publish that extension. Its owner is subject to the same publication limits as other members.

Ordinary membership joins without the extension, removing the extension, and leaving do not become profile publications. Other room membership, eligibility, and native authorization rules continue to apply. If an enabled policy is malformed or its authoritative scope cannot be loaded, extended profile publication fails with a bounded, actionable error. Basic membership operations do not depend on loading this policy.

Global profile edits preserve the complete account profile. Tavern projects a compliant copy for each affected room and preserves existing server-specific overrides. Resetting a server profile also projects the global copy for that server. A direct server profile edit that violates its rules is rejected with the editor draft retained. If a native room publication fails after the global profile was saved, the interface reports that partial result rather than claiming every room was updated.

The enabled-policy schema also bounds the extension independently of the chosen limits:

| Field | Maximum |
| --- | --- |
| Name / bio | 60 / 1000 UTF-16 units |
| Pronouns / timezone / language | 50 / 80 / 30 units |
| Status / status emoji | 160 / 16 units |
| Structured links | 5; label 60 units, URL 1000 units |
| Custom fields | 8; nonempty label 60 units, value 300 units |
| Avatar / banner | Empty or a Matrix media URI, at most 1024 units |
| Complete serialized extension | 32 KiB UTF-8 |

Unknown fields and unsupported versions are rejected. Link URLs must be absolute HTTP or HTTPS URLs without credentials, literal backslashes, whitespace, or control characters. Artwork must use a Matrix media URI. Accent colors are empty or `#RRGGBB`; status expiration is a nonnegative safe integer. A `serverOverride` marker is empty or the exact ID of the Space receiving it. Invalid control characters and lone UTF-16 surrogates are rejected. Native Rust-backed event mappings are copied into JSON primitives for comparison, without relying on Python pickling or `deepcopy`.

## Limits and verification

These rules govern the known plaintext Tavern profile extension. They do not classify encrypted messages, filter text for URL-like substrings, block native Matrix display names or avatars, or modify a user's global account data. Disabling structured links does not prohibit a URL typed in a biography. They do not establish a content moderation scanner.

Existing membership events and historical metadata are not erased when a rule becomes stricter. Tavern hides or truncates restricted values in its current profile presentation; other Matrix clients and retained room history may still expose the previously published data.

Local validation passed 18 new native-hook tests and 92 focused Python tests including roles, private discussions, AFK, eligibility, and account profile metadata. Cases cover direct self-membership publication, all-parent and private-source enforcement, malformed schema and URLs, Unicode and byte bounds, role/native-power/membership/revision changes during a state read, policy activation and new parents during publication, protected redaction, owner repair, native Mapping compatibility, sanitized denial messages, and emoji-only status rejection when status is disabled. The frontend has separate model/publisher and browser coverage.

`scripts/smoke-profile-policy.mjs` adds an isolated actual-Synapse acceptance probe after the AFK and eligibility fixtures. It verifies fixture identity before mutation, exercises direct native configuration and membership writes, confirms that denied writes preserve accepted data, checks profileless join/leave, and restores original memberships and admission rules with profile rules disabled. Syntax and shared retry-helper checks passed locally; the Docker/Synapse probe itself has not yet been run.
