# Conference publication permissions

Server owners can enable separate **Speak**, **Camera video**, and **Screen sharing** permissions under **Server roles → Permissions**. These permissions are available for server roles, categories, and individual channel role/member overrides. Joining a conference remains a separate permission.

Existing servers retain their previous publishing rights. Enabling the controls is an explicit, one-time owner action: it preserves the saved role policy, assignments, overrides, and additional native fields, and adds all three rights to the default Member role. Save or reload local role edits first. Removing a right from another role does not cancel a right still supplied by Member; use a category/channel deny or remove the default grant before assigning it selectively.

The native `io.tavern.roles` policy records `callPublicationVersion: 1`. Initial role creation remains unmarked. Migration must match the current state event and perform only the prescribed rights-preserving transformation. Once enabled, the marker cannot be removed or downgraded, even by the owner. Future writes require `io.tavern.previous_event` to match the current event; old clients cannot silently replace the marked policy.

## What is enforced

| Permission | Allowed publication |
| --- | --- |
| Speak | Microphone audio; screen audio also needs Screen sharing |
| Camera video | The camera video source |
| Screen sharing | Screen video; its audio additionally needs Speak |

A Speak denial removes every audio source, including screen audio and legacy `UNKNOWN` sources. If any publishing right is restricted, `UNKNOWN` is excluded because it does not identify the media source. Compatible clients identify camera and screen sources explicitly. The pinned Tavern SFU verifies declared source, declared media kind, and negotiated RTP kind. It cannot prove which device or application produced video pixels. These controls do not classify encrypted media or establish whether a user captured their screen rather than a camera.

Restrictions intersect every reciprocal canonical governing parent path, including category/channel overrides, within the existing bounded scope resolver (32 scopes, depth 8). An intermediate Space with its own policy cannot hide an ancestor's restriction. A lower channel owner cannot unlink a governing marked policy; the joined native owner of each governing scope retains explicit detachment authority. Protected policy/link redactions cannot remove enforcement. Invalid policies or unresolved governing scopes fail closed. Existing private-discussion conference restrictions remain unchanged.

## Runtime requirements and restoration

Restricted publishing requires the configured Tavern SFU extension and `SFU_AUDIO_MODERATION_ENABLED=true`. The internal capability check must succeed. Legacy unmarked or unrestricted rooms continue to work without this option. If a saved restriction cannot be enforced by the configured service, the gateway refuses new constrained admissions; it does not pretend the UI alone can enforce media permissions. See [SFU configuration](SFU_AUDIO_MODERATION.md).

The API intersects the current native policy with the verified issuer grant and, for a connected participant, the actual observed SFU permission ceiling. An empty allowed-source intersection sets `canPublish=false`; an empty LiveKit source list alone means unrestricted and is never used to represent a denial. Existing data-publication permission is preserved explicitly.

The gateway checks new tokens and signaling reconnects and periodically reconciles its registered device identities. Revocation is bounded by the shared control worker and service availability, not instantaneous across all devices. It never broadens an observed source restriction or an observed global publishing denial in place. A restored role can therefore require leaving and rejoining through a fresh managed admission. This also preserves unrelated restrictions an external SFU administrator may have set, including indistinguishable same-value changes. No action starts a microphone, camera, screen capture, or rejoin automatically. [Admission and outage limits](RTC_AUTHORIZATION.md).

## Validation

Sixteen focused native/API tests cover explicit migration, monotonic markers, exact revisions, current authority, all-parent inheritance, category/channel precedence, protected unlink/redaction, signed token attenuation, old-token rejection, active participant updates, observed permission ceilings, restoration (including an all-publishing denial), and incompatible/disabled runtime behavior. Frontend semantic and mounted browser tests cover native revision preservation, malformed markers, concurrent assignments, account changes, migration with unsaved drafts, and the actual role editor.

The existing pinned SFU test suite separately exercises real RTP source/kind enforcement and active media revocation. These HTTP fixtures and independent RTP tests are not a claim that the new role workflow has passed a full multi-device browser conference over the operator's public deployment. That acceptance remains to be run. Priority speaker, a separate stream grant, and automatic member movement are not implemented by this slice.
