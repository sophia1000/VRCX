# VRCX Circles testing preview

This is an unofficial Windows x64 build of VRCX with the observed friends network.
It is based on the October 20, 2026 nightly, commit `e387cc5`. It is an unsigned
preview for testing, and has not been merged into the official VRCX project.

## Download and run

1. Open the [Circles preview release](https://github.com/sophia1000/VRCX/releases/tag/circles-v0.4.5-preview.1).
2. Download `VRCX-Circles-0.4.5-preview.1-windows-x64.zip` from **Assets**.
3. Close your regular VRCX and extract the entire ZIP into a separate folder.
4. Run `VRCX.exe` from that folder. The .NET runtime is included.
5. Open **Charts > Mutual Friends Network**, then select **Observed together**.

The application uses your existing local VRCX profile and recorded history by
default. Keep one VRCX instance running per profile. The first analysis can take
some time while it reads and reconstructs local history. The progress bar shows
the current stage and percentage. This cache lives in memory until VRCX closes;
it is built on the first graph visit after each launch. Settings and later visits
reuse it. **Rebuild local history** includes newly recorded history during testing.

If you prefer a separate test profile, close VRCX, copy your VRCX data folder and
start the preview with `VRCX.exe --config="C:\path\to\copied-profile"`. The argument
is a folder containing the copied `VRCX.sqlite3`, rather than the database file.

For this preview, set VRCX's automatic updates to **Off** while testing. The
updater still points to official VRCX releases, which replace the preview when
installed. To return to your regular build, close this app and start normal VRCX.
The observed network only reads through VRCX's existing JS SQL wrapper. It creates
no database tables and writes no history cache to the main database. Tables left
by the earlier C# prototype are ignored and are not removed automatically.

## Things to try

- Change history windows in settings. Selecting or saving a view preset should
  leave the selected window unchanged.
- Try Balanced overview, Regular hangout groups, Close-knit circles and the other
  built-in presets. Save personal presets and check the named delete confirmation.
- Drag a person and watch connected people respond while you hold the mouse.
  Drag a circle name, or Shift-drag a person, to move the whole circle.
- Toggle **Graph appearance > Show groups** to show or hide circle names and
  shaded backgrounds. This applies immediately and is saved in personal presets.
- Enable **Graph appearance > Color connections by strength**. Weak connections
  are blue and strong connections are red. Person and membership colors stay the same.
- Search by name or user ID. Inspect membership percentages and observed connections.
- Verify the graph and search show only the logged-in account's current friends,
  including friends without history in search. Switch accounts and confirm old
  results disappear immediately. Observations still use history from all accounts.
- Try dark/light themes and resize the window. The graph should fill its panel
  down to the normal bottom padding, including when person details are open.
- Under **Connection filters**, try **Connection backbone**. Lower thresholds
  reduce connections relative to each person's other ties. Off disables this
  filter. People without remaining connections follow **Show unconnected people**.
  Saving a personal preset keeps this choice without changing the time window.
- Leave and reopen the page. It should reuse the current session's imported history.
- Restart VRCX. Other pages should open normally; the next observed-network visit
  should load history again and show progress.

Connection evidence means that you observed people together. It does not confirm
that those people are friends with each other. Missing or incomplete logs limit
what the graph can infer.

This preview uses VRCX's existing Graphology Louvain package for grouping and
Sigma for drawing and camera interaction. Group boundaries can differ from
earlier previews. The original palette, percentage rings and D3 live pulling
remain, with a small overlay for the view's extra decorations.

## Feedback

Report issues in [this fork's issue tracker](https://github.com/sophia1000/VRCX/issues).
Include the version, relevant settings, what happened, and what you expected.
`BUILD-INFO.json` in the app folder records the exact source commit.
Remove names, user IDs and other personal information from screenshots or logs
before posting. Database uploads are not needed for ordinary feedback.

## Build from source

Use Windows x64, Node.js 24.15 or newer, and the .NET 10 SDK. From this branch:

```powershell
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
npm ci
npm test -- src/views/Charts src/services/friendsNetwork src/services/database/__tests__/friendsNetwork.test.js src/services/__tests__/sqlite.test.js
npm run typecheck:vue
npm run prod
./build-scripts/package-friends-network.ps1 -Version '0.4.5-preview.1'
```

The ZIP and SHA256 file are written to `build/releases`. Packaging requires a
fresh output directory and adds the app, runtime, license notices and build
metadata. The manual **Friends network preview** GitHub Actions workflow runs the
same checks and uploads the portable build as an artifact.

## History build confirmation

On the first visit to **Observed together** after launch, confirm the history
build to load the graph. The popup warns about slower PCs and HDDs. Choosing
**Maybe later** leaves history unbuilt, including after settings edits. Use
**Build local history** to ask again. Returning with a running or completed cache
reuses it. **Rebuild local history** also asks before starting another read.

Verify that switching to another page closes the settings sheet and any preset
deletion dialog. Returning to the graph should leave those panels closed.
