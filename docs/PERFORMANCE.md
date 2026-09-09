# Performance evidence

Seventeen optional workspace panels load on demand: account, appearance,
notifications, text/media, devices, export, server audit, collaboration, room
permissions, channel administration, friends/privacy, members, reports, temporary
bans, bulk moderation, group messages and search. Each panel has its own loading
and error boundary. Loading or retrying a panel keeps the surrounding conversation
and dialog mounted; closing the dialog during loading does not reopen it later.

## Bundle comparison

A local production comparison on 2026-09-09 used the same in-memory snapshot of
application sources and dependencies for both builds. Only `app/tavern.tsx` changed:
the eager imports from `9905f3d` versus the deferred imports. The following figures
sum each chunk once, following static imports from the workspace entry. Gzip sizes
are summed per file; they are not an end-to-end browser timing measurement.

| JavaScript | Eager panels | Deferred panels |
|---|---:|---:|
| Workspace file | 563,553 bytes | 381,696 bytes |
| Workspace and static dependencies | 1,930,431 bytes | 1,849,477 bytes |
| Gzipped workspace and static dependencies | 557,043 bytes | 543,988 bytes |

Some code becomes shared dependencies, so the workspace file reduction is larger
than the overall reduction. The existing Matrix SDK and encryption remain major
dependencies. The installed PWA still caches static application files for offline
use, including optional panels; this change reduces eager evaluation rather than
claiming those files are never downloaded.

## Browser checks and remaining work

`tests/browser/private-workspace.spec.ts` checks that a closed search panel makes
no module request, a delayed import does not discard the real Composer's draft,
closing during loading stays closed and reopening uses the loaded module.
`tests/browser/deferred-panel.spec.ts` verifies a failed panel loader and successful
retry preserve the conversation's state.

Production startup, navigation latency, CPU, memory and network behavior still
need representative device and homelab measurements. Bundle sizes and fixture
tests do not establish those outcomes or a supported server capacity.
