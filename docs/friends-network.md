# Observed friends network

The friends network screen offers **Mutual friends** and **Observed together**.
The original mutual graph remains unchanged. Observed together weights links by
recorded overlapping presence and groups people using those weighted links.
Controls and backgrounds use VRCX's components and theme. The graph keeps the
Circles palette, percentage rings, force layout and live dragging.

## Loading and cache lifetime

Nothing scans history at application startup or while using another page. The
first visit to Observed together starts a bounded read through VRCX's existing
`sqliteService`. A progress bar reports reading, reconstructing presence, scoring
and grouping. Reconstruction and analysis run in a Web Worker.

The reconstructed history and reusable analysis are kept only in that worker's
memory. Returning to the page, changing presets, changing time windows and
selecting another account reuse this data. Closing VRCX discards it. The next
launch builds it again on the first visit. **Rebuild local history** reads a fresh
copy during the current session, including newly recorded or edited history.

The history loader issues only SELECT and schema-inspection queries through the
shared SQL wrapper. It does not create or update tables, change pragmas, or store a
connection cache in VRCX's database. The C# feature service and its custom bridge
have been removed. Tables left by the earlier prototype are ignored; this version
does not try to remove them. Settings and saved presets continue to use VRCX's
existing configuration repository.

Reads use keyset pagination and acknowledge each batch before reading another.
Each table has a fixed upper key during its scan. There is no long-running read
transaction. Existing logging can continue between batches. These reads do not
form a single database-wide snapshot: a live duration or friend snapshot can
change while loading. Restarting or explicitly rebuilding refreshes the result.

## Settings and interaction

Settings apply automatically. Scoring edits settle for 100 ms before analysis;
display-only edits stay in the renderer. New requests cancel obsolete analysis
without discarding imported history. Leaving the page cancels its requested graph
and closes its layout simulation. The shared history worker remains available.

All accounts is the default. An individual account selects its current friend and
mutual snapshots. VRCX's game logs are shared across accounts, so recorded visits
cannot reliably be assigned to a login. Every discovered account owner is
excluded from the observed network.

The time window stays in settings and is independent of presets. Built-in and
saved presets do not change it. Seven built-in presets are protected from deletion.
User presets have their own dropdown group and a named deletion confirmation.

Scoring supports encounter frequency, time, distinct days, recency, crowd
correction, minimum evidence, per-visit overlap and time caps, hub damping,
relative closeness, neighbor similarity and consistency. Filters include friends,
confirmed mutuals, worlds, strongest connections, node limits and isolated people.
Separate layout controls adjust spacing and attraction.

Search covers the imported directory by name or user ID. Person details show
observed joins, visible connections and circle membership percentages. A person
can be dragged while neighbors respond live. Dragging a circle label or
Shift-dragging a person moves the whole circle. Background dragging pans.
Optional strength colors run from blue for weak links to red for strong links.

## Source boundaries

| File or directory                                                      | Responsibility                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/services/database/friendsNetwork.js`                              | Read-only schema discovery and bounded reads through the shared SQL wrapper |
| `src/services/friendsNetwork/history.js`                               | Identity resolution, visit boundaries and merged presence intervals         |
| `src/services/friendsNetwork/service.js`                               | Lazy session lifetime, shared import, worker transport and progress         |
| `src/services/friendsNetwork/controller.js`, `worker.js`               | Worker message handling and ownership of in-memory data                     |
| `src/services/friendsNetwork/analysis.js`, `scoring.js`, `grouping.js` | Time/account filters, overlap evidence, scoring, pruning and communities    |
| `src/views/Charts/composables/useFriendsNetwork.js`                    | View preferences, debounced edits and stale-result rejection                |
| `FriendsNetwork.vue`, `FriendsNetworkControls.vue`                     | Native themed controls, progress, search and selection                      |
| `friendsNetworkLayout.js`, `friendsNetworkLayoutWorker.js`             | Layout and live physics in a separate worker                                |
| `friendsNetworkRenderer.js`, `friendsNetworkAppearance.js`             | Canvas painting, palette, rings, labels and camera                          |

Worker requests use plain JavaScript objects and structured-clone messages.
JSON serialization is limited to saved preferences and stable cache keys; there
is no feature-specific native JSON protocol. The normal SQLite wrapper handles
Cef and Electron's existing transport differences.

## Reconstruction limits

Explicit user IDs take precedence over names. Name-only events are resolved only
when the collected identity evidence identifies one person. Duplicate joins do
not count as independent visits. A missing leave is bounded by the observed visit
and a four-hour inference cap. Recorded offline/private/traveling boundaries stop
inference across gaps. Quality counters report unresolved or inferred evidence.

Presence is clipped to the selected window before pair overlaps are scored.
Non-friends still contribute to crowd size when only friends are drawn. Pair
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
npm test -- src/views/Charts src/services/friendsNetwork src/services/database/__tests__/friendsNetwork.test.js
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

This branch is based on nightly commit `e387cc5`. An upstream contribution still
needs the feature discussion requested by `.github/CONTRIBUTING.md`. English
strings use VRCX's existing localization fallback until translations are added.
