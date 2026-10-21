[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')]
    [string]$Version,
    [string]$OutputRoot,
    [string]$DotnetExecutable = 'dotnet'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $repositoryRoot 'build/releases'
}
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$packageName = "VRCX-Circles-$Version-windows-x64"
$packageDirectory = Join-Path $OutputRoot $packageName
$archivePath = Join-Path $OutputRoot "$packageName.zip"

# A fresh directory prevents an old installation's profile or logs entering a release.
if ((Test-Path -LiteralPath $packageDirectory) -or (Test-Path -LiteralPath $archivePath)) {
    throw 'Release output already exists. Choose a new version or output directory.'
}
$htmlDirectory = Join-Path $repositoryRoot 'build/html'
foreach ($relativePath in @('index.html', 'licenses/third-party-licenses.json', 'licenses/THIRD_PARTY_NOTICES.txt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $htmlDirectory $relativePath))) {
        throw 'Build the frontend and its license manifest with npm run prod before packaging.'
    }
}
$sourceCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[a-f0-9]{40}$') {
    throw 'The source commit could not be determined.'
}
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null

& $DotnetExecutable publish (Join-Path $repositoryRoot 'Dotnet/VRCX-Cef.csproj') `
    -c Release -p:Platform=x64 -r win-x64 --self-contained true `
    -p:DebugType=None -p:DebugSymbols=false -p:ContinuousIntegrationBuild=true `
    -o $packageDirectory
if ($LASTEXITCODE -ne 0) {
    throw 'The Windows application could not be published.'
}

$packagedHtml = Join-Path $packageDirectory 'html'
New-Item -ItemType Directory -Path $packagedHtml -Force | Out-Null
Copy-Item -Path (Join-Path $htmlDirectory '*') -Destination $packagedHtml -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'LICENSE') -Destination $packageDirectory
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'docs/friends-network-testing.md') `
    -Destination (Join-Path $packageDirectory 'READ-ME-FIRST.md')
Set-Content -LiteralPath (Join-Path $packageDirectory 'Version') -Value "Circles $Version" -Encoding utf8

$manifest = [ordered]@{
    product = 'VRCX Circles'
    version = $Version
    source_commit = $sourceCommit
    source_repository = 'https://github.com/sophia1000/VRCX'
    upstream_commit = 'e387cc548caa84fb0dcba79ef36ab8a00e11b9b3'
    runtime = 'win-x64'
    self_contained = $true
    preview = $true
    built_at_utc = [DateTime]::UtcNow.ToString('O')
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageDirectory 'BUILD-INFO.json') -Encoding utf8

# Symbols are useful to developers, but are not needed in the portable download.
$packagePrefix = $packageDirectory + [System.IO.Path]::DirectorySeparatorChar
foreach ($symbol in Get-ChildItem -LiteralPath $packageDirectory -Recurse -File -Filter '*.pdb') {
    if (-not $symbol.FullName.StartsWith($packagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A symbol path resolved outside the release directory.'
    }
    Remove-Item -LiteralPath $symbol.FullName
}
$runtimeData = Get-ChildItem -LiteralPath $packageDirectory -Recurse -File | Where-Object {
    $_.Name -match '(?i)\.(?:sqlite3?|db)(?:-wal|-shm|-journal)?$|\.log$|^cookies(?:-journal)?$|^\.env'
}
if ($runtimeData) {
    throw 'Unexpected runtime data was found in the fresh application output.'
}
foreach ($relativePath in @('VRCX.exe', 'VRCX.dll', 'libcef.dll', 'coreclr.dll', 'html/index.html', 'LICENSE')) {
    if (-not (Test-Path -LiteralPath (Join-Path $packageDirectory $relativePath))) {
        throw "The portable application is missing $relativePath."
    }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $packageDirectory, $archivePath, [System.IO.Compression.CompressionLevel]::Optimal, $false
)
$checksum = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$archivePath.sha256" -Value "$checksum  $packageName.zip" -Encoding ascii
Write-Output "Portable application: $archivePath"
Write-Output "SHA256: $checksum"
