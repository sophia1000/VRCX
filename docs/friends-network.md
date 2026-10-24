# Observed friends network

The friends network screen offers **Mutual friends** and **Observed together**.
The original mutual graph remains unchanged. Observed together weights links by
recorded overlapping presence and groups people using those weighted links.
Controls and backgrounds use VRCX's components and theme. The graph keeps the
Circles palette, percentage rings, force layout and live dragging.

## Loading and cache lifetime

Nothing scans history at application startup or while using another page. The
first visit to Observed together asks before building the local history cache.
The themed confirmation warns about lag on slower PCs and long reads on HDDs.
Only approval starts a bounded read through VRCX's existing `sqliteService`.
The popup stays open with the current stage, percentage and progress bar until
the graph is ready. **Hide** returns to the page while the approved build
continues, with progress shown above the graph. Build errors stay in the popup
and allow another attempt. A progress bar reports reading, reconstructing presence, scoring
and grouping. Reconstruction and analysis run in a Web Worker.

The reconstructed history and reusable analysis are kept only in that worker's
memory. Returning to the page, changing presets, changing time windows and
logging into another account reuse this data. Closing VRCX discards it. The next
launch asks again on the first visit. Declining leaves the history unbuilt;
changing settings does not ask again or start a read. **Build local history** lets
the user retry. An existing or running cache is reused without another prompt.
**Rebuild local history** asks before reading a fresh copy during the current
session, including newly recorded or edited history.

The history loader issues only SELECT queries through the shared SQL wrapper.
It uses fixed column lists for the tables created by `database/index.js`, with
strictly validated account prefixes and bound cursor values. It does not create
or update tables, change pragmas, or store a
connection cache in VRCX's database. The C# feature service and its custom bridge
have been removed. Tables left by the earlier prototype are ignored; this version
does not try to remove them. Settings and saved presets continue to use VRCX's
existing configuration repository.

Reads use keyset pagination in batches of up to 10,000 rows. At most two batches
are awaiting worker acknowledgement, allowing the next sequential database read
to overlap processing of the previous batch. Every batch carries its column
order and compact array rows. The importer reads those arrays directly instead
of allocating a temporary object for every row. The SQL wrapper opts into VRCX's existing
serialized result transport for these large reads, avoiding per-cell Cef binding.
No additional timer runs between batches.
Each table has a fixed upper key during its scan. There is no long-running read
transaction. Existing logging can continue between batches. These reads do not
form a single database-wide snapshot: a live duration or friend snapshot can
change while loading. Restarting or explicitly rebuilding refreshes the result.

The reader follows VRCX's own rowid tables. It does not infer arbitrary schemas
or support foreign `WITHOUT ROWID` exports. Existing optional account tables are
discovered by name; absent account tables are skipped.

## Settings and interaction

The settings sheet and its preset deletion dialog close when leaving the graph
page, including navigation from a cached view. The initial build prompt belongs
to the graph view and closes with it.

Settings apply automatically. Scoring edits settle for 100 ms before analysis;
display-only edits stay in the renderer. New requests cancel obsolete analysis
without discarding imported history. Leaving the page cancels its requested graph
and closes its layout simulation. The shared history worker remains available.

The graph and search contain only the current account's live friend list. Account
selection and the friends-only toggle have been removed. Login and friend-list
changes clear the previous graph and directory immediately; incomplete login or
friend loading never falls back to historical accounts. Current account mutual
snapshots provide mutual flags, while shared observations from every account
remain available. Old account and friends-only preset fields are ignored.

The time window stays in settings and is independent of presets. Built-in and
saved presets do not change it. Seven built-in presets are protected from deletion.
User presets have their own dropdown group and a named deletion confirmation.

Scoring supports encounter frequency, time, distinct days, recency, crowd
correction, minimum evidence, per-visit overlap and time caps, hub damping,
relative closeness, neighbor similarity and consistency. Filters include
confirmed mutuals, worlds, strongest connections, node limits and isolated friends.
Separate layout controls adjust spacing and attraction.

The optional **Connection backbone** filter uses Graphology's disparity metric.
It keeps edges whose weight is significant relative to either endpoint's other
edges. Lower thresholds keep fewer edges; Off preserves the existing filters.
This is a relative measure, so even an isolated two-person connection can be
removed at stricter thresholds. People with no remaining edges follow the
**Show unconnected people** setting. Presets save this choice independently of
the history window.

Graphology's existing weighted Louvain library finds communities, using sorted
insertion and non-random traversal for repeatable results. Community labels are
then ordered by group size and member ID. This replaces the custom Louvain
implementation; group boundaries can differ from older previews.

Search covers only current friends visible on the graph, by name or user ID.
It follows the unconnected-people setting, graph filters and selected group.
Hidden friends and non-friends are excluded from the dropdown. Person details show
observed joins, visible connections and circle membership percentages. A person
can be dragged while neighbors respond live. Dragging a circle label or
Shift-dragging a person moves the whole circle. Background dragging pans.
Optional strength colors run from blue for weak links to red for strong links.

## Source boundaries

The [coding style map](friends-network-style.md) records useful upstream
examples. Clear names, simple control flow and explicit responsibilities take
priority when maintaining the feature.

| File or directory                                                      | Responsibility                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/services/database/friendsNetwork.js`                              | Fixed source projections and bounded, parameterized reads through the shared SQL wrapper |
| `src/services/friendsNetwork/history.js`                               | Identity resolution, visit boundaries and merged presence intervals                      |
| `src/services/friendsNetwork/service.js`                               | Lazy session lifetime, shared import, worker transport and progress                      |
| `src/services/friendsNetwork/controller.js`, `worker.js`               | Worker message handling and ownership of in-memory data                                  |
| `src/services/friendsNetwork/analysis.js`, `scoring.js`, `grouping.js` | Current-friend and time filters, overlap evidence, scoring and communities               |
| `src/views/Charts/composables/useFriendsNetwork.js`                    | View preferences, debounced edits and stale-result rejection                             |
| `FriendsNetwork.vue`, `FriendsNetworkControls.vue`                     | Native themed controls, progress, search and selection                                   |
| `friendsNetworkLayout.js`, `friendsNetworkLayoutWorker.js`             | Layout and live physics in a separate worker                                             |
| `friendsNetworkRenderer.js`, `friendsNetworkAppearance.js`             | Sigma rendering and camera; palette, membership overlay and group handles                |

Worker requests use plain JavaScript objects and structured-clone messages.
Progress contains only a stage and fraction. The view owns its busy/error state
and reads the service's progress snapshot synchronously. Concurrent requests
share the entire import promise, including failure cleanup before a retry.
JSON serialization uses saved preferences, stable cache keys and the existing
SQL transport; there is no feature-specific native JSON protocol. The normal SQLite wrapper handles
Cef and Electron's existing transport differences.

Sigma 3, already used by the mutual network, owns WebGL nodes/edges, label
placement, picking and the camera. A transparent Canvas overlay draws only the
view-specific membership arcs, group fields, friend outlines and group handles.
It projects through Sigma's public coordinate APIs. D3 Force continues to run the
live simulation in its worker. Camera normalization bounds stay fixed during
pulling so a moved person cannot rescale the graph under the pointer. Sigma's
camera gestures are suppressed during worker-driven pulls and resume on release.
Coordinate updates are collected until the next draw and sent to Sigma in one
partial refresh with indexation enabled. This preserves current picking and label
placement without re-running every edge reducer for every moved node. Worker
frames and outgoing drag moves keep only their latest pending values. Pointer
coordinates take precedence over a queued older frame, including on release.
The graph uses the panel's available height rather than fixed viewport offsets.

## Reconstruction limits

Explicit user IDs take precedence over names. Name-only events are resolved only
when the collected identity evidence identifies one person. Duplicate joins do
not count as independent visits. A missing leave is bounded by the observed visit
and a four-hour inference cap. Recorded offline/private/traveling boundaries stop
inference across gaps. Quality counters report unresolved or inferred evidence.

Presence is clipped to the selected window before pair overlaps are scored.
Only current friends get detailed analysis intervals. With crowd correction off,
non-friend intervals are skipped; visit correction retains only distinct crowd
IDs, while concurrent correction temporarily retains timing needed for counts.
The initial shared import still reads non-friend logs for historical identity
ambiguity, visit boundaries, crowd accuracy and later account/friend changes. Pair
intervals are consumed per visit rather than retained for the entire history.
The worker keeps the canonical history, one filtered window, one aggregate and
the last completed graph. Relative dates and decay use the import's clock until
a rebuild, so reopening the same view can reuse the completed result.
Large histories still require memory and take longer to reconstruct.

Observed co-presence is evidence of shared presence, not proof of friendship.
Missing logs, name collisions and inferred endings limit what can be concluded.

## Validation

Use the repository's supported Node version and .NET SDK:

```powershell
npm ci
npm test -- src/views/Charts src/services/friendsNetwork src/services/database/__tests__/friendsNetwork.test.js src/services/__tests__/sqlite.test.js
npm run typecheck:vue
npm run prod
dotnet build Dotnet/VRCX-Cef.csproj -p:Platform=x64
dotnet build Dotnet/VRCX-Electron.csproj -p:Platform=x64 -r win-x64
```

The focused tests cover read-only database access, batching, identity and visit
reconstruction, true overlaps, settings, weighted grouping, worker cancellation,
cache lifetime, presets and progress. Native-window checks use an isolated copied
profile. Test data and screenshots containing personal history stay under ignored
build outputs.

Performance checks separate reading/reconstruction, scoring, layout and warm
navigation. Memory checks distinguish retained JS heaps after garbage collection
from native host, Chromium and GPU process memory. Profiling hooks and private
copied-history fixtures stay in ignored build outputs and are not distributed.

This branch is based on nightly commit `e387cc5`. An upstream contribution still
needs the feature discussion requested by `.github/CONTRIBUTING.md`. English
strings use VRCX's existing localization fallback until translations are added.

## Layout and preference maintenance

Analysis owns community detection. The layout worker accepts analysis nodes and
links directly, retaining their group labels and membership scores. It does not
recompute communities or accept legacy serialized graph formats. Unused nested
subgroup calculations are omitted.

The layout client releases failed workers and creates a replacement on the next
layout request. Replies from an earlier worker cannot update the current view.
The renderer draws all filtered connections used by the simulation and details
panel; it does not silently truncate them. Use the existing connection filters
and node limit to reduce dense graphs.

Controls update the view immediately. Preference writes are combined by key after
300 milliseconds without an edit, remain ordered, and flush when the view closes.

Defaults, numeric bounds and the view-to-worker field mapping live in
`src/services/friendsNetwork/settings.js`. Preference restoration, worker
validation and layout controls share these definitions. Worker numeric controls
now use the same supported ranges as saved preferences.

History reconstruction has separate functions for visit boundaries, join/leave
spans and interval merging. Its retained account records contain only IDs and
mutual pairs; historical friendship flags and account display metadata are not
needed because the current friend store owns the scope.

The simulation owns initial circle and isolate placement. The layout adapter
restores valid previous positions and leaves new positions for the simulation;
it no longer computes random or neighbor-based positions that would be replaced.
