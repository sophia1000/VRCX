# Friends network coding style map

This map records useful conventions found in VRCX. Maintainability comes first:
use clear names, keep responsibilities explicit, and remove unnecessary paths.
The examples are references rather than a template for the feature's design.
The repository's formatter and lint configuration remain authoritative.

## Formatting and names

| Convention                                                                    | Upstream reference                                                                                                                                      | Application to this feature                                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Four spaces, LF endings, 120-column target                                    | [`.editorconfig`](../.editorconfig)                                                                                                                     | Run the existing formatter; do not hand-align code or introduce another formatter.                                                               |
| Semicolons, single quotes, no trailing commas, parenthesized arrow parameters | [`oxfmt.config.mts`](../oxfmt.config.mts)                                                                                                               | Use the same JavaScript and Vue formatting as VRCX.                                                                                              |
| PascalCase Vue component names and template-first single-file components      | [`HotWorlds.vue`](../src/views/Charts/components/HotWorlds.vue)                                                                                         | Keep `FriendsNetwork*.vue` components and the existing indented `<script setup>` format.                                                         |
| camelCase functions and state, with descriptive action names                  | [`MutualFriends.vue`](../src/views/Charts/components/MutualFriends.vue), [`useDateNavigation.js`](../src/views/Charts/composables/useDateNavigation.js) | Prefer names that identify the operation or state, such as `loadGraph`, `friendContext` and `pendingLayoutFrame`.                                |
| Uppercase names for fixed bounds and lookup constants                         | [`graphLayoutWorker.js`](../src/views/Charts/graphLayoutWorker.js)                                                                                      | Keep fixed limits and palette constants distinct from per-request state.                                                                         |
| Database names can differ from JavaScript names                               | [`userProfile.js`](../src/services/database/userProfile.js)                                                                                             | Preserve SQL column names, stored preference keys and existing worker payload fields. Naming cleanup must not migrate data or change a contract. |

Short mathematical coordinates and conventional comparator parameters are useful
where their meaning is immediate. Lifecycle state and worker coordination need
more descriptive names because readers must follow them across several methods.
Public exports and established renderer methods remain stable.

Utility and service filenames use camelCase, such as
[`activityWorkerRunner.js`](../src/workers/activityWorkerRunner.js). Vue
composables use the `use` prefix, such as `useDateNavigation` and
`useFriendsNetwork`; Vue component filenames use PascalCase. Existing feature
filenames already follow these patterns and do not need renaming.

## Module and Vue structure

VRCX uses several module shapes. Pure helpers have named exports, database modules
often export an object, and services can expose a class and singleton. Examples
include [`overlapCalculator.js`](../src/shared/utils/overlapCalculator.js),
[`mutualGraph.js`](../src/services/database/mutualGraph.js) and
[`config.js`](../src/services/config.js). The friends network keeps its existing
factories, named helpers and service singleton rather than changing architecture
for visual consistency.

Vue and composable files group related imports and keep state, derived values,
handlers and lifecycle effects understandable. Their exact ordering varies:
[`HotWorlds.vue`](../src/views/Charts/components/HotWorlds.vue) places hooks after
handlers, while other components place watchers earlier. This cleanup labels
those sections without moving effect registration or asynchronous work.

The existing `ChartsMutual` component name is part of the chart's KeepAlive
behavior. Component names, emitted events, props, template bindings and CSS
classes are contracts as well as presentation details.

## Comments and function documentation

Upstream uses short stage comments in
[`graphLayoutWorker.js`](../src/views/Charts/graphLayoutWorker.js) and section
comments such as configuration persistence, dialog lifecycle and handlers in
[`useNewInstanceBuilder.js`](../src/components/dialogs/NewInstanceDialog/useNewInstanceBuilder.js).
Public services also use focused JSDoc, as in
[`request.js`](../src/services/request.js) and [`config.js`](../src/services/config.js).

Use that approach here:

- Introduce logical sections with a short purpose comment.
- Describe public entry points and non-obvious helper contracts with JSDoc.
- Explain constraints that are easy to break, especially ordering, units,
  cancellation, identity ambiguity and resource ownership.
- Keep comments beside the relevant code rather than repeating a complete
  algorithm in a separate header.
- Avoid comments that merely repeat an assignment, loop or function name.
- Keep comments and authored code free of em dashes.

Expanded guards and loop bodies make this feature easier to scan. Upstream has
both expanded and compact forms, so this is a readability choice for the feature
rather than a claim that all VRCX code requires braces.

## Responsibilities to keep visible

| Area                          | What its comments should explain                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Database reader               | Allowed source tables and columns, bounded keyset reads, the fixed upper key, cancellation and the shared SQL wrapper. |
| History reconstruction        | Identity resolution, event ordering, visit boundaries, merged presence and inferred endings.                           |
| Analysis and grouping         | Current-friend scope, time clipping, crowd evidence, pair scoring, pruning, grouping and cache reuse.                  |
| Service and worker controller | Lazy initialization, request ownership, shared import, progress, stale results and disposal.                           |
| View and composable           | Live roster ownership, preference persistence, derived search/graph data, watchers and renderer lifetime.              |
| Controls and presets          | Settings descriptors, independent history window, protected built-ins and saved-view deletion.                         |
| Renderer and appearance       | Sigma ownership, coordinate conversion, batched frames, picking, membership rings and camera behavior.                 |
| Layout and interaction        | Initial placement, force stages, held nodes, worker messages, release and cleanup.                                     |

## Behavior-preserving maintenance

Style changes must preserve values, formulas, SQL, public names, message shapes,
settings keys, iteration order and asynchronous boundaries. In particular, keep
friend-scope watchers synchronous, retain stale-result checks, and preserve the
per-draw update batching that makes dragging responsive.

Use the existing behavior tests instead of rewriting assertions to match a new
implementation. Upstream's
[`graphLayoutWorker.test.js`](../src/views/Charts/__tests__/graphLayoutWorker.test.js)
illustrates named test harnesses and descriptions of observable behavior. The
feature's validation commands and architecture are documented in
[`friends-network.md`](friends-network.md).
