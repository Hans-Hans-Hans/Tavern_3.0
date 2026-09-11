# Channel role permissions

A channel's Permissions section can open the existing server role editor scoped
to that exact channel. Choose a role or member, then use Inherited, Allow or Deny
for Join calls and conferences and the other existing channel permissions.
Separate publishing controls appear after the server owner enables conference
publication permissions in Server roles.

This view writes the existing `io.tavern.roles` policy in the selected governing
Space. It does not create a second permission policy or change assignments,
other channel overrides, category settings or native room membership. Other
canonical servers, category rules and native Matrix powers still apply. Being
assigned a role does not invite or join someone to a channel.

The existing resolution rules are unchanged: role denies win over role allows
within one scope; individual member overrides win over role overrides. A channel
allow may override an inherited category deny. The server owner retains control.
A role Allow alone does not exclude other roles that already inherit that grant.

The scoped editor requires a joined channel and joined reciprocal canonical
Space. It reads both native relationships before saving, keeps the existing
role revision/conflict checks, and retires controls when the account, device,
channel object or rendered channel changes. A rejected save retains its draft.
Native server authorization remains the final enforcement point; these reads
do not make changes across different Matrix rooms atomic.

Validation includes five tests using the actual installed Matrix SDK with a
controlled HTTP boundary, a JavaScript permission recipe regression, a native
Synapse policy callback regression, and five mounted Chromium editor cases. These prove
request paths/revisions, preservation of unrelated settings, native read denial,
channel/account retirement, retained drafts and narrow layouts. They do not
claim a live Synapse or SFU acceptance run.
