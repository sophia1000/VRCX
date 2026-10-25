# Observed friends network: fresh implementation brief

## Purpose and scope

Use locally recorded time together to separate friends into more useful groups.
Two people seen together repeatedly should have a stronger connection than two
people observed together once. This describes the desired behavior and the
calculations needed, rather than a request to reuse the prototype's files,
workers, table catalogue, or settings framework.

Start from upstream `master`. Keep the existing mutual-friends graph intact and
add an optional **Observed together** mode. Implement the numbered stages below
as separate, reviewable changes. The advanced controls at the end can wait.

Co-presence means "recorded together while the user was there." It does not prove
friendship, conversation, or what happened while VRCX was not recording.

## 1. Establish the smallest data path

The visible people are the currently logged-in account's **current friends**,
using VRCX's existing friend store for IDs and display names. Historical friend
tables must not decide who is currently a friend. Wait until login and friend
loading finish, and clear the previous account's graph immediately on a switch.

Use recorded observations across all accounts. VRCX's shared game-log tables
already contain recorded visits; do not scan the same shared rows once per
account. A friend added later can use earlier observations that were recorded.

| Source | Needed facts | When needed |
| --- | --- | --- |
| `gamelog_location` | Visit ID, start, instance location, duration; world name for filtering | Core |
| `gamelog_join_leave` | Event ID, timestamp, join/leave type, user ID, location, stored duration | Core |
| Existing user/friend stores | Current friend IDs, names, current account and known observer-account IDs | Core |
| `friend_log_history` | User ID and old/new display names | Optional recovery of old name-only logs |
| Current account's existing mutual snapshot | Confirmed mutual pairs and opt-out handling through existing VRCX behavior | Only if the mutual filter is implemented |

The first version can skip rows without a usable user ID. Historical name recovery
is a later, isolated improvement. Do not scan status/bio/avatar/GPS feeds, notes,
moderation, profiles, video logs, or portal logs just to build a bigger identity
index. They are not necessary to calculate the core graph.

Read through VRCX's existing database wrapper. Select only required columns and
use bounded reads; do not hold a long transaction that interferes with logging.
Use known schema identifiers and bound SQL values. Do not add a generic schema
reader, native C# analysis bridge, database migration, or persistent connection
cache. Read progress is enough; exact row totals need not require another scan.

**Review result:** a small read-only path with a fixture containing two visits.
No graph UI or scoring controls are needed yet.

## 2. Convert events into presence intervals

Use one consistent time unit internally. VRCX's stored duration columns used here
are milliseconds; convert them once. Interpret stored timestamps using VRCX's
existing date conventions. Distinguish a visit to an instance from the world ID:
returning to the same instance later is a separate observed visit.

For each visit and person, process events in timestamp order:

1. A join starts a presence interval.
2. A leave closes it. If the join is missing but the leave has a usable stored
   duration, infer the start from `leaveTime - duration`.
3. Clamp intervals to their visit. A known visit duration is bounded by the next
   recorded location change as well.
4. Reject zero-length, backwards, invalid, or mismatched-location intervals.
5. Merge overlapping intervals for the same person in the same visit. Preserve
   real gaps between leaving and rejoining. Duplicate joins must not reset a
   valid start or create extra encounters.

Use half-open intervals `[start, end)`: someone leaving exactly when another
person joins has no overlap with them.

For incomplete logs, prefer conservative inference. An unmatched join can close
at a justified visit end, with a bounded tail; the prototype used a four-hour cap.
For a visit with no reliable duration, use the last relevant recorded activity
within that visit and the next location boundary. Skip intervals that cannot be
bounded. Never assume someone stayed until the next app launch. Recorded
offline/traveling/unknown-location markers break continuity; valid private
instance locations are not themselves grounds for exclusion.

Observer-account identities should not accidentally become ordinary participants
in their own recorded sessions. Use known account identities rather than reading
every account table to discover them. Decide explicitly how a friended alt should
appear; the prototype excluded observer accounts from co-presence evidence.

Optional name-only recovery: trust explicit IDs first. Resolve an old display name
only when the available ID/name evidence gives one unambiguous person. Do not
assume a name is unique merely because it matches one current friend; a non-friend
may have used the same name. Ambiguous or unresolved rows remain unassigned.

**Review result:** explainable `(visit, userId, start, end, inferred)` intervals.
Check duplicate joins, rejoins with gaps, missing joins/leaves and offline gaps.

## 3. Aggregate actual overlap between friends

Apply the selected date window and world filters to visits and intervals first.
Clip each interval to the window before calculating durations. Use a consistent
day/week boundary for statistics; UTC days and Monday-start weeks are a simple
choice. A date-only end selection should include that entire date.

Only generate pairs whose endpoints are both current friends. For intervals
belonging to different people in the same visit:

```text
overlapStart = max(a.start, b.start)
overlapEnd   = min(a.end, b.end)
sharedTime  = max(0, overlapEnd - overlapStart)
```

Sum the pair's shared intervals within that visit. Count **one encounter per
qualifying visit**, regardless of how many times either person rejoins. Canonical
pair ordering prevents A/B and B/A from becoming separate connections.

Example: A is present 20:00-20:30 and 20:40-21:00; B is present 20:20-20:50.
They share 10 + 10 = **20 minutes and one encounter**, not 30 minutes or two
encounters. Two people who visit the same world at different times share nothing.

Keep pair totals for encounters, shared minutes, distinct shared days and weeks.
If recency is added later, these raw totals should remain available for tooltips.
Label a person's join count separately: it is not the number of qualifying pair
encounters and is not necessarily limited to the current time window.

A straightforward per-visit loop is enough to establish correctness. For busy
visits, sweep sorted interval starts and compare only currently overlapping
participants. Do not allocate a full friends-by-friends matrix or retain every
pair interval for the entire history. Never score non-friend/non-friend pairs.

**Review result:** pair totals that match hand-calculated examples. Start with
encounter count or shared minutes as the edge weight.

## 4. Add weighted groups to the existing graph

Reuse VRCX's Graphology and weighted Louvain support. Feed it the observed graph
and edge weights, not unweighted mutual connections. Keep stable insertion/tie
ordering where practical so unchanged data does not jump into different groups.
Group numbers are temporary labels, not persistent group identities.

Reuse the existing Sigma renderer and layout infrastructure where it fits.
Stronger weights should produce stronger attraction. Compress or normalize force
weights if needed so one very large connection does not collapse the layout;
retain the original evidence weight for details and filtering. Layout distances
are visual aids, not a direct scale of hours together.

Keep the prototype's colored communities and membership rings. A simple ring
calculation is sufficient: for person A, sum incident edge weights by each
neighbor's community, then divide each sum by A's total incident weight.
For example, weights 60, 30 and 10 into three communities produce 60%, 30%, 10%.
These are **shares of observed connection strength**, not percentages of time or
probabilities of belonging. Louvain's primary community and the largest ring
segment need not be identical. Handle isolates without division by zero.

Preserve smooth node pulling with live movement of neighbors. Whole-group pulling
can follow later. Retain settled positions on updates where possible, keep camera
bounds stable while dragging, coalesce pointer updates to animation frames, and
release held nodes on pointer-up, cancellation or focus loss. Use one coordinate
conversion for nodes, rings, labels and picking. Do not run two drag controllers
on the same pointer interaction.

**Review result:** a useful weighted graph with the original mutual mode unchanged.
Confirm that 100 shared visits attract more than two comparable shared visits.

## 5. Add the page lifetime and basic controls

Build history only after the user first visits this mode and approves a themed
prompt. Explain that large histories/HDDs can be slow and slower PCs may lag.
Show stage/progress in that prompt. Hiding progress should not cancel an approved
build. A failed build must offer retry. Declining must not be undone by changing
a setting. No history scan should start at application startup.

Keep reconstructed history in memory for the app session. Reuse it on page
re-entry, preset changes and account changes; apply the current friend scope
again. Provide an explicit rebuild for newly recorded history. A restart clears
the cache. A persistent disk cache is not required.

Apply settings automatically. Briefly debounce analysis changes; appearance-only
changes should not reread history or run analysis. A generation number and checks
at sensible boundaries are enough to reject stale work. Account switches and
navigation must not display late results from an earlier request. Close the
settings sheet and its dialogs when leaving the page.

Use existing VRCX workers and messaging conventions. Move expensive reconstruction
and aggregation off the UI thread, with bounded batches and coarse stage progress.
Avoid a new RPC framework, exact progress on every row, or multiple caches before
measurement shows they are needed. One retained history representation plus the
latest graph is a reasonable starting point.

Basic controls: time range (last 90 days, last year, all history, or custom),
encounter/time weighting, minimum evidence, strongest connections per person,
show unconnected friends, group selection and name/ID search. Populate search from the **currently visible graph nodes**, including
group and isolate filters. Details should explain the observed pair counts/time.
Use VRCX's normal components, localization, theme and available page height.

**Review result:** the basic feature works end to end without the advanced options.

## Optional scoring and filtering reference

These describe prototype behavior for adaptation, not a requirement to restore
every control. Add one understandable option per change, with a small fixture.

### Evidence weighting

Without correction, encounter weight is the number of qualifying visits, time
weight is shared minutes, and day weight is distinct shared days. The prototype's
balanced weight was `sqrt(effectiveEncounters * effectiveMinutes)`; its scale is
arbitrary and should not be presented as a probability.

For optional recency/crowd correction, split overlap into segments where the
correction is constant and calculate:

```text
decay = 2 ^ (-max(0, now - segmentMidpoint) / halfLife)
crowd = max(1, participantCount - 1) ^ (-crowdExponent)
factor = decay * crowd
```

Disable a correction by using factor 1. Half-life and age must use the same unit.
The prototype accumulated segment minutes times `factor`, the maximum factor
within a visit as that visit's effective encounter, and the maximum factor per
shared day as its effective day contribution. Capture `now` consistently for a
calculation and account for it when caching date windows or decay results.

Crowd count can be distinct participants over the visit or people actually
concurrent with the segment. The latter needs a presence-count timeline. Count
non-friends only for this correction, without creating graph nodes/pairs for them.
Do not interpret a generic activity event as proof of another person's presence.

Minimum overlap per visit is applied to the pair's **summed raw overlap** in that
visit. A time cap limits a visit's contribution to effective minutes; it does not
truncate the raw tooltip total. The prototype multiplied the effective visit
minutes by `min(1, capMinutes / rawVisitMinutes)` when a cap was enabled. Pair
minimum encounters/minutes are applied after per-visit qualification.

### Network adjustments

Compute adjustments from one fixed pre-adjustment graph so edge iteration order
does not change the result. Zero-strength sliders disable these optional factors.

| Option | Prototype calculation |
| --- | --- |
| Consistency | Multiply by `1 + c * log2(max(1, distinctSharedWeeks))` |
| Hub damping | With positive-node median degree `m`, multiply by `(max(1, degreeA/m) * max(1, degreeB/m)) ^ (-h/2)` |
| Relative closeness | Multiply by `min(1, sharedMinutes / sqrt(personMinutesA * personMinutesB)) ^ r`; zero available person-time gives factor 0 when enabled |
| Neighbor similarity | Multiply by `1 + s * cosineSimilarity` between weighted neighbor vectors, excluding the direct A/B contribution; zero norm gives similarity 0 |

The prototype applied consistency first, then measured the remaining adjustments
against that fixed weighted graph. These heuristics need not be included in an
initial implementation. Shared-time weighting and top-K filtering may be enough.

### Filters and grouping controls

Apply raw evidence minimums, then optional score adjustments. If a node limit is
enabled, retain the strongest people and their mutual retained edges. The
prototype ranked people by incident weight, then encounters, name and ID.

Top-K means each person selects their K strongest incident edges. **Union** keeps
an edge selected by either endpoint; **bilateral** requires both endpoints to
select it. This is different from requiring a confirmed VRChat mutual link.
Keep stable tie handling. Zero K can mean unlimited.

An optional disparity backbone filter can use Graphology's library metric instead
of a custom algorithm. Threshold 1 means off; smaller thresholds remove more
edges, including potentially a two-person connection. Run it before top-K if
matching the prototype. After edge filtering, remove isolates unless shown, then
run grouping and calculate rings using the remaining edges.

Other optional controls are minimum encounters/minutes, include/exclude worlds,
confirmed mutuals only, node limit, Louvain resolution, group spacing, group
tightness, between-group attraction, labels and line opacity. **Show groups**
controls group fields/labels/handles separately from membership rings. Optional
line colors run from blue for weak to red for strong, using the same weight as
the displayed graph. These visual controls should not rebuild history.

### Presets

Treat presets as named values for existing settings, not another execution path.
Keep the selected time window outside presets, including when loading older saved
ones. Separate built-ins from user saves in the dropdown. Built-ins cannot be
deleted. Put save/delete together in a collapsible section; delete uses a red
button and confirmation naming the selected user preset.

Prototype preset intentions: **Balanced**, **Regulars** (repeat days), **Close
circles** (relative time and stricter links), **Recent** (faster decay), **Small
groups** (concurrent crowd correction), **History** (no decay), and **Bridges**
(more cross-group connections). Names and exact values can be adapted.

## Review and performance checklist

- Two visits with known overlaps produce hand-calculated counts and minutes.
- Duplicate joins, rejoin gaps, simultaneous leave/join, missing endpoints,
  invalid IDs and ambiguous old names do not manufacture strong connections.
- Date clipping and separate visits to the same world do not merge unrelated time.
- Changing account or removing a friend clears stale people, links and search.
- All recorded-account history is eligible, but only current friends become nodes.
- Declining a build reads nothing; approval starts it; progress/retry work.
- Rapid edits and leaving the page do not publish an obsolete graph.
- Presets preserve the time window; group visibility does not rerun analysis.
- Name search contains exactly the people currently on the graph.
- Database access is read-only apart from ordinary saved preferences.

Use small synthetic fixtures for correctness. For performance, make one simple
measurement of initial read/reconstruction, graph calculation, and a warm settings
edit. Report retained history/graph memory separately from host, Chromium and GPU
memory. Respect VRCX's documented scale of 1,000-4,000 friends and databases up to
8 GB. Those are targets to measure against, not a claim that the prototype met
them. Do not infer an 8 GB test result from a small fixture.

Review each stage independently. A simple weighted graph is useful before all
of the interaction and optional controls are added. Agree on conservative
incomplete-log behavior and review the data path before adding advanced scoring,
extra caches or a large settings panel.
