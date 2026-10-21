# Add observed co-presence weighting to the friends network

Mutual links can produce a dense graph when many friends know the same people.
Add an optional **Observed together** view to the existing friends network route,
using overlapping instance history to weight connections and detect communities.
The original mutual-friends graph is preserved.

The feature uses VRCX's Vue components and existing JS SQL wrapper. Read-only,
bounded queries feed a worker that reconstructs presence, scores connections and
finds groups. There is no feature-specific C# bridge and no cache written to the
main database. History loads on the first visit after launch, with visible progress,
and is reused in memory until VRCX closes. A manual rebuild refreshes live history.

Settings apply automatically. Time windows remain independent of presets. Search,
seven built-in presets, grouped user presets, account selection and detailed
scoring controls are included. The graph retains the Circles palette, membership
percentage rings and live drag physics. Backgrounds and controls follow VRCX's
theme. Optional strength coloring runs from blue to red.

Focused tests cover read-only SQL access and schema preservation, reconstruction,
weighted evidence, pruning, grouping, lazy session caching, cancellation, progress
and frontend behavior. Native-window testing uses an isolated copied profile.
Large histories still require worker memory. Bounded reads allow logging between
batches but do not represent one database-wide transaction snapshot.

See [implementation notes](friends-network.md) for ownership, reconstruction limits,
settings and validation commands. This draft is for the upstream feature discussion
required by the contribution guide; it has not been submitted as a pull request.
