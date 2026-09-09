# Message drafts

Tavern keeps a separate text draft for each conversation and each thread while
the page remains open. Moving between channels, direct messages and threads
preserves that text, including whitespace. Drafts are held in memory; reloading,
closing the page or changing the signed-in identity retires them. Optional
cross-session draft persistence is not implemented. Explicit queued or scheduled
sends use the separate encrypted outbox.

A small **Draft** indicator appears beside a channel or direct message, including
its favorite entry, when its main composer contains non-whitespace text. Reply
drafts appear in the thread heading, on the source message's thread link, and on
forum cards. An unsent first reply creates a visible thread link so it can be
reopened before any reply has been posted. Main-conversation and thread drafts
remain independent. Indicators subscribe to their own draft state; typing does
not request another room inventory or rerender the whole workspace.

The store binds drafts to the exact Matrix client, user, native device and managed
account generation. Every read or mutation rechecks that identity. A retired
owner cannot publish text into a replacement session or clear its drafts. Send
failures retain the draft. An acknowledged send or successful outbox transfer
clears only the exact submitted revision, so a delayed acknowledgement cannot
erase text written after navigating away and returning. Clearing one reply does
not clear the channel or another thread.

Focused store tests cover separate keys, stable notifications, identity changes
and delayed acknowledgements. Mounted browser tests use the actual Workspace,
Composer, navigation and forum cards with controlled Matrix transport responses;
they cover immediate indicators, placement, navigation, failed sends, first-reply
reopening and account changes. These are UI/store checks, not new live Matrix
delivery acceptance. Attachment recovery is tracked separately from text drafts.
