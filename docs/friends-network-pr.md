# Add observed co-presence weighting to the friends network

Mutual links can produce a dense graph when many friends know the same people.
Add an optional **Observed together** view to the existing friends network route,
using overlapping instance history to weight connections and detect communities.
For example, two people observed together on 100 visits attract more strongly
than a pair observed together twice, with controls for duration, recency, crowd
size and the influence of broadly connected people.

The existing mutual-friends graph is preserved. The new view uses VRCX's Vue
components and theme, the common Cef/Electron AppApi bridge, and C# analysis with
the existing SQLite provider. Settings apply automatically, layout runs in a
cancellable worker, and search includes the historical directory. The view
includes seven built-in presets, grouped saved views and named deletion
confirmation. The time window is independent of presets. The graph retains Circles'
pastel palette, membership percentage rings and force layout, while controls and
backgrounds follow VRCX's theme. `d3-force` supplies the original simulation in the
worker. Direct dragging pulls connected people live, and circle names or
Shift-drag move whole groups. An optional blue-to-red connection scale shows
weighted strength. All accounts is the default, with individual selection available.

Cache data uses five new `mutual_network_*` tables and feature-specific metadata.
Existing tables, source records and `user_version` are unchanged. Reconstruction
uses an independent read-only snapshot, private staging and atomic publication;
an interrupted rebuild preserves the prior cache. Rollback-journal imports use a
chunked online backup so the long scan does not block existing logging writes. Older VRCX versions can ignore
the additive tables. Temporary pair data does not become a permanent multi-GB
index in the shared database.

Validation includes focused Vue/worker/lifetime tests, native history and
compatibility tests against both SQLite provider versions used by the desktop
hosts, Vue typechecking, production UI compilation and both native builds.
Windows Cef interaction checks used an isolated profile with copied history.
A copy with about 753,000 join/leave records took about 20 seconds initially;
subsequent top-K updates took 428-480 ms in C#, excluding worker layout.

The full upstream Vitest run has the same 36 failing files and four failing
assertions as an untouched checkout of the pinned nightly. Those unrelated tests
and runtime files are unchanged. Linux/macOS desktop interaction has not been
tested locally. English localization keys use the existing fallback mechanism.

See [implementation and compatibility notes](friends-network.md) for cache
ownership, reconstruction limits, settings and reproducible validation commands.
This draft is for the upstream feature discussion required by the contribution
guide; it has not been submitted.
