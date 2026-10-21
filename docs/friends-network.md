# Observed friends network

The existing friends network screen now offers **Mutual friends** and
**Observed together**. The mutual graph implementation is unchanged. The new view
uses locally observed overlap in instance history to weight connections and find
friend groups. It uses VRCX's components, themes, native bridge and SQLite provider.

This checkout started from the published nightly
[`2026-10-20T12.01-e387cc5`](https://github.com/Natsumi-sama/VRCX/releases/tag/2026-10-20T12.01-e387cc5),
commit `e387cc548caa84fb0dcba79ef36ab8a00e11b9b3`. The local working branch is
`codex/friends-network-circles`.

## Using the view

Open Charts > Mutual Friends Network and choose **Observed together**. The first
open reconstructs and caches recorded presence. Later opens reuse that cache.
**Rebuild local history** forces a fresh reconstruction, including manually edited
or restored history. Source signatures are also checked during analysis, at most
once every 30 seconds while the native service is warm.

Settings apply automatically. Scoring edits settle for 100 ms before calculation;
display changes stay in the renderer. All accounts is the default. An individual
account selects its current friend and mutual snapshots; VRCX's shared game logs
cannot be attributed reliably to a particular login account. Account owners are
excluded from the network.

The Time window control in settings selects recent history or custom dates. Presets never change
that window, including older saved views that contain date fields. New saved views
exclude the window. The original Circles presets retain their scoring and layout
choices; Long-term connections disables decay within the selected window.

The settings include frequency/time/day/balanced
weighting, minimum encounters and duration, per-visit overlap and duration caps,
recency, whole-visit or concurrent crowd correction, hub damping, relative closeness, neighbor similarity,
consistency, mutual filtering, strongest connections, node limits, community
resolution, world filters and independent layout controls. Seven built-in presets
and separately grouped saved views are available. Built-in views cannot be
deleted. Deletion names the saved view and requires confirmation.

Search covers the historical directory by name or user ID, including people
outside the current graph filters. Selecting a person shows their observed joins
and visible connections, sortable by strength or name. Circles' original pastel
palette, colored weighted links, soft group fields and observation-sized nodes
are retained. Membership rings show up to three circle shares of at least 10%;
the tooltip and person details show the percentages. Backgrounds and controls
follow VRCX's theme while graph colors stay consistent. The group selector focuses
the display on one detected community.

Dragging a person reactivates physics in the worker: the grabbed person follows
while connected people respond live, then the layout settles after release.
Drag a circle name or Shift-drag a person to move the whole circle. Background
dragging pans. Group anchors follow group moves. Capture loss, new analysis and
unmount release pins and stop the old simulation. Live position buffers transfer
from the worker; the resting graph has no repeating simulation timer.

Graph appearance also offers **Color connections by strength**, off by default.
It colors the final weighted connection score from blue (weak) to red (strong),
with a matching legend. It applies without requerying history and saves with
personal presets. Person and membership colors retain the Circles palette.

## Code boundaries

| Area                                                                | Responsibility                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Dotnet/FriendsNetwork/NetworkSource.cs`                            | Snapshot reads, identity resolution, presence reconstruction, cache publication                   |
| `NetworkWindow.cs`                                                  | Date/world/account eligibility, temporary overlap index, bounded raw cache, parallel pair scoring |
| `NetworkScoring.cs`, `GraphPresentation.cs`, `CommunityDetector.cs` | Scoring, pruning, deterministic weighted communities and memberships                              |
| `FriendsNetworkService.cs`                                          | Background lifetime, cancellation, progress and warm caches                                       |
| `Dotnet/AppApi/Common/FriendsNetworkApi.cs`                         | Shared Cef/Electron bridge                                                                        |
| `src/views/Charts/components/FriendsNetworkChart.vue`               | Source selector for the existing chart route                                                      |
| `FriendsNetwork.vue`, `FriendsNetworkControls.vue`                  | Native themed chart, independent history window and settings UI                                   |
| `friendsNetworkLayout.js`, `friendsNetworkLayoutWorker.js`          | Original Circles D3 forces in small cancellable worker batches                                    |
| `friendsNetworkRenderer.js`                                         | Canvas lifecycle, original appearance, membership rings, focus and camera preservation            |

The only existing native service adjustment exposes SQLite's resolved database
path and disposes the feature during shutdown. One optional `ariaLabel` prop on
VirtualCombobox gives the two new searchable pickers accessible names. Existing
callers retain their current behavior. The chart route changes to the wrapper;
the original mutual-friends component and layout worker remain unchanged.

`friendsNetworkAppearance.js` owns the original palette and canvas painting.
`friendsNetworkInteraction.js` owns live drag simulation and frame transfer.
`friendsNetworkSimulation.js` contains the original Circles forces; only
`d3-force` and its three small ISC-licensed dependencies are added to the frontend
build. Existing Electron production dependencies are unchanged.

Cold reconstruction uses an ordinary read snapshot for WAL databases. For older
rollback-journal databases, a chunked SQLite online backup creates a private,
consistent import copy first. Long reconstruction reads then stay off the live
file, so existing logging writes can continue. The private copy is removed after
success or cancellation; the database journal mode is unchanged.

## Cache and rollback compatibility

Persistent feature data lives only in these new tables and their own indexes:

- `mutual_network_users`
- `mutual_network_visits`
- `mutual_network_presence`
- `mutual_network_mutuals`
- `mutual_network_meta`

No existing table definitions, log rows, indexes, triggers or `PRAGMA user_version`
are changed. Cache versioning belongs to `mutual_network_meta`, independent of
VRCX's database migrations. Reverting the code leaves additive tables that older
VRCX versions can ignore. They are disposable derived data; removing these five
tables while VRCX is closed causes this view to rebuild them next time.

Reconstruction reads a consistent snapshot on an independent read-only connection.
A private staging file is prepared beside the database, then copied into the five
feature tables in one transaction. Cancellation or failure rolls back publication
and cleans up the staging file. The shared VRCX SQLite connection never performs
the history scan. Preferences use only new `VRCX_FriendsNetwork*` config keys.

Pair intervals are temporary data, kept on a private SQLite connection with
file-backed temporary storage. Up to one million raw intervals are retained in
managed memory. A larger history streams through batches of 2,048 independent
pairs, using at most eight scoring threads. One history window and one scored
result are reused. Display pruning and community resolution can reuse scored
evidence. Native requests and the layout worker both discard obsolete results.

The source signature detects appended/pruned records, changed duration totals,
and friend/mutual snapshot changes. Arbitrary in-place edits to old event content
that preserve these totals require **Rebuild local history**. A graph describes
recorded co-presence, not confirmed friendship or a complete record of meetings.
Missing IDs are resolved only through unambiguous names, and inferred tails are
capped at four hours. Overlaps use UTC; date-only end bounds include that day.

## Validation

Use the repository's Node requirement and .NET 10:

```powershell
npm ci
npm test -- src/views/Charts
npm run typecheck:vue
npm run lint
npm run prod
dotnet test tests/FriendsNetwork/FriendsNetwork.Tests.csproj
dotnet test tests/FriendsNetwork/FriendsNetwork.Tests.csproj -p:NetworkSqliteVersion=1.0.119
dotnet build Dotnet/VRCX-Cef.csproj -p:Platform=x64
dotnet build Dotnet/VRCX-Electron.csproj -p:Platform=x64 -r win-x64
```

The focused native tests cover real interval boundaries, duplicate joins, rejoins,
all-account union, owner exclusion, individual account selection, date clipping,
world filters, opt-out mutual flags, cancelled publication, stale revisions, and
unchanged existing records/database version. The frontend tests cover presets,
instant scheduling, display-only edits, worker cancellation and renderer refresh.

Native Cef UI checks use an isolated profile and copied history, with no login
credentials copied. A representative copy containing 752,598 join/leave records,
26,356 location rows and nine accounts took about 20 seconds for its first
all-history import/graph. Three subsequent top-K updates took 428-480 ms in C#.
These timings exclude worker layout and are measurements on the development
machine, not a guarantee for every history. The first cache requires temporary
disk space as well as space for the new feature tables.

The full upstream Vitest run also reports existing failures: 32 suites fail to
collect because their utility mocks omit `debounce`, and four assertions fail in
query policy, notification defaults, user text conversion and reporting commands.
The same 36 files and the same four assertions fail on an untouched archive of
the pinned nightly, with the same installed dependencies. These unrelated files
are unchanged. The focused chart tests pass independently.

Before an upstream PR, discuss the feature and UI approach as requested by
`.github/CONTRIBUTING.md`, rebase onto the agreed upstream base, and repeat checks.
Only English strings are added; VRCX's existing English fallback handles other
languages pending translation. No remote issue, push or pull request has been
created by this implementation.
