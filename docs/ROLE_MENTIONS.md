# Server role mentions

In **Server settings → Roles**, a member who can edit a role can enable **Allow members to mention this role** and save the policy. New roles start with this option off. The message composer's mention menu then includes eligible roles, labeled with their server and stable role ID so roles with identical names can be distinguished.

Selecting a role inserts a Markdown label backed by its actual Space ID and role ID. For example, `[@Helpers](tavern-role:%21server%3Atest/mod)` identifies the `mod` role in `!server:test`. Renaming a role does not redirect an existing draft to another role with its old name. Tavern displays a valid token as an inert label; it is not a navigable link.

## Delivery and audience

When sending, Tavern resolves the role from the conversation's currently joined canonical Space, verifies the reciprocal child link, loads the needed joined membership, and adds explicit Matrix `m.mentions.user_ids` to the encrypted message. It does not trust a caller-supplied server ID. Members must currently be joined to both the destination conversation and the selected Space. An invitation alone does not qualify.

Private discussions use their validated encrypted source conversation and additionally intersect recipients with joined discussion members and joined source members. Selecting a source role cannot notify people outside the private discussion. No directory lookup or membership request for an unjoined Space is used.

Role selection uses the same bounded Markdown interpretation as the message renderer. Code, blockquotes, hidden spoilers, escaped examples and malformed role destinations do not expand a role. Labels of role links, including reference links and role examples in code or quotes, are removed from ordinary person/`@everyone` matching so a role called “everyone” does not also create a room-wide mention. Ordinary mentions outside role labels retain Tavern's existing behavior.

If reserved role syntax remains ambiguous after parsing, Tavern stops the send and keeps the draft instead of interpreting its label as a person or room-wide mention. To show a literal example, wrap the normal complete token in inline backticks or a fenced code block; do not add a backslash before its opening bracket. The example is displayed as code and does not expand its role.

Forwarded messages suppress mentions, including role expansion. Scheduled/outbox messages keep the stable token and resolve the current audience at delivery. A role removed or made unavailable before delivery produces an error instead of silently changing the intended role.

The sender's room/account and role audience are checked again after membership loading and before each send. These are checks against the client's current synced/native membership data, not an atomic server-side snapshot: a remote change that has not reached the client cannot be detected in advance. Matrix delivery, the recipient's notification preferences, muted rooms and do-not-disturb settings still determine whether a recipient receives an alert. Inclusion in `m.mentions` is not a delivery or read receipt.

## Bounds and errors

A message containing role syntax is limited to 8,000 characters and 20 visible role selections. Expansion requires complete joined membership for each needed room, with at most 10,000 joined members per room and a 20-second loading deadline. The resulting combined role/person mention list is limited to 1,000 IDs and 16 KiB of encoded `m.mentions`; the outgoing message content is limited to 32 KiB for this preflight. Tavern reports incomplete or excessive audiences and retains the draft instead of truncating recipients.

The size and initial authority checks run before sending attachments or text. An attachment that was already acknowledged can remain delivered if the role audience changes while its send is awaiting confirmation; Tavern then stops before sending text to the stale audience and retains the draft and pending attachments for recovery. This follows the existing separate attachment/message transaction pipeline and is not an atomic multi-event send.

The role's mentionable setting is a Tavern composer preference. Encrypted message contents and explicit mentions are authored by clients; a different client can name people directly. This option does not impose a native ban on mentioning role members and does not weaken encryption or grant posting permissions.

## Validation

Focused model tests cover stable identity, reciprocal/private audience bounds, incomplete membership, changes during loading and encoded-size limits. Tests of the actual Matrix send branch cover native mention content, forwarding suppression, outbox revalidation and partial attachment delivery. Browser tests exercise the actual role editor, composer picker, draft retention and an account change during loading. These controlled SDK-boundary checks do not claim a live homeserver notification delivery or operating-system alert test.
