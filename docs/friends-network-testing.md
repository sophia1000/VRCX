# VRCX Circles testing preview

This is an unofficial Windows x64 build of VRCX with the observed friends network.
It is based on the October 20, 2026 nightly, commit `e387cc5`. It is an unsigned
preview for testing, and has not been merged into the official VRCX project.

## Download and run

1. Open the [Circles preview release](https://github.com/sophia1000/VRCX/releases/tag/circles-v0.1.0-preview.1).
2. Download `VRCX-Circles-0.1.0-preview.1-windows-x64.zip` from **Assets**.
3. Close your regular VRCX and extract the entire ZIP into a separate folder.
4. Run `VRCX.exe` from that folder. The .NET runtime is included.
5. Open **Charts > Mutual Friends Network**, then select **Observed together**.

The application uses your existing local VRCX profile and recorded history by
default. Keep one VRCX instance running per profile. The first analysis can take
some time while it builds the local connections cache.

If you prefer a separate test profile, close VRCX, copy your VRCX data folder and
start the preview with `VRCX.exe --config="C:\path\to\copied-profile"`. The argument
is a folder containing the copied `VRCX.sqlite3`, rather than the database file.

For this preview, set VRCX's automatic updates to **Off** while testing. The
updater still points to official VRCX releases, which replace the preview when
installed. To return to your regular build, close this app and start normal VRCX.
The added `mutual_network_*` cache tables can be ignored by older builds.

## Things to try

- Change history windows in settings. Selecting or saving a view preset should
  leave the selected window unchanged.
- Try Balanced overview, Regular hangout groups, Close-knit circles and the other
  built-in presets. Save personal presets and check the named delete confirmation.
- Drag a person and watch connected people respond while you hold the mouse.
  Drag a circle name, or Shift-drag a person, to move the whole circle.
- Enable **Graph appearance > Color connections by strength**. Weak connections
  are blue and strong connections are red. Person and membership colors stay the same.
- Search by name or user ID. Inspect membership percentages and observed connections.
- Try all accounts or one account, dark and light themes, and different group filters.

Connection evidence means that you observed people together. It does not confirm
that those people are friends with each other. Missing or incomplete logs limit
what the graph can infer.

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
npm test -- src/views/Charts
npm run typecheck:vue
dotnet test tests/FriendsNetwork/FriendsNetwork.Tests.csproj
npm run prod
./build-scripts/package-friends-network.ps1 -Version '0.1.0-preview.1'
```

The ZIP and SHA256 file are written to `build/releases`. Packaging requires a
fresh output directory and adds the app, runtime, license notices and build
metadata. The manual **Friends network preview** GitHub Actions workflow runs the
same checks and uploads the portable build as an artifact.
