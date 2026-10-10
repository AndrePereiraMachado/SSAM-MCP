<#
.SYNOPSIS
  Packs the part of an INSTALLED Studio that the ssam-server image needs (a "studio bundle"), for when the official
  installer of that version cannot be obtained.

.DESCRIPTION
  Reads the installed Studio folder (never writes there), copies exactly the files of studio-<lane>.txt, and packs
    <OutDir>\<lane>-studio-<version>.tar.gz   bundle.txt (schema, lane, version, source, created, files)
                                              SHA256SUMS (sha256sum format, one line per file, paths under files/)
                                              files/<the listed paths>
    <OutDir>\<lane>-studio-<version>.tar.gz.sha256
  The version is the first word of the folder's Version.txt (else the file version of ServiceStudio.Framework.dll).
  The image build (studio-extract.sh) unpacks it with studio_bundle.py, checks every file against SHA256SUMS and the
  list, and puts it in /studio/<lane> exactly as from the installer. The bundle carries OutSystems binaries: keep it
  and the image private.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File docker\ssam-server\studio-bundle.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File docker\ssam-server\studio-bundle.ps1 -Lane o11 -OutDir C:\t\bundles
#>
param(
    [ValidateSet('odc', 'o11')][string]$Lane = 'odc',
    [string]$Studio,
    [string]$OutDir
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Studio) {
    $Studio = if ($Lane -eq 'odc') { Join-Path $env:ProgramFiles 'OutSystems\ODC Studio\ODC Studio' }
              else { Join-Path $env:ProgramFiles 'OutSystems\Service Studio 11\Service Studio' }
}
if (-not $OutDir) { $OutDir = Join-Path (Split-Path -Parent $here) 'installers' }
$marker = if ($Lane -eq 'odc') { 'OutSystems.ModelAPILoader.dll' } else { 'ServiceStudio.Framework.dll' }
if (-not (Test-Path -LiteralPath (Join-Path $Studio $marker))) { throw "not a $Lane Studio folder (no $marker): $Studio" }
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $tar)) { throw "tar.exe not found ($tar)" }

$versionFile = Join-Path $Studio 'Version.txt'
$version = if (Test-Path -LiteralPath $versionFile) { ((Get-Content -LiteralPath $versionFile -TotalCount 1) -split '\s+')[0] }
           else { (Get-Item -LiteralPath (Join-Path $Studio 'ServiceStudio.Framework.dll')).VersionInfo.FileVersion }
if ($version -notmatch '^\d+(\.\d+){1,3}$') { throw "no Studio version found in $Studio (Version.txt / ServiceStudio.Framework.dll): '$version'" }

$list = Join-Path $here "studio-$Lane.txt"
$paths = Get-Content -LiteralPath $list | Where-Object { $_.Trim() -and -not $_.TrimStart().StartsWith('#') } | ForEach-Object { $_.Trim() }
$missing = @($paths | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Studio ($_ -replace '/', '\'))) })
if ($missing.Count) { throw "$Studio lacks $($missing.Count) listed file(s): $($missing -join ', ')" }

$stage = Join-Path ([IO.Path]::GetTempPath()) ("ssam-bundle-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$files = Join-Path $stage 'files'
New-Item -ItemType Directory -Force $files | Out-Null
try {
    $sums = New-Object System.Text.StringBuilder
    $bytes = 0L
    foreach ($rel in $paths) {
        $dst = Join-Path $files ($rel -replace '/', '\')
        New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null
        Copy-Item -LiteralPath (Join-Path $Studio ($rel -replace '/', '\')) -Destination $dst
        $hash = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLowerInvariant()
        [void]$sums.Append($hash + '  files/' + $rel + "`n")
        $bytes += (Get-Item -LiteralPath $dst).Length
    }
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [IO.File]::WriteAllText((Join-Path $stage 'SHA256SUMS'), $sums.ToString(), $utf8)
    $listHash = (Get-FileHash -LiteralPath $list -Algorithm SHA256).Hash.ToLowerInvariant()
    $info = "schema ssam-studio-bundle/1`nlane $Lane`nversion $version`nsource $Studio`ncreated $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))`nfiles $($paths.Count)`nbytes $bytes`nlist studio-$Lane.txt $listHash`n"
    [IO.File]::WriteAllText((Join-Path $stage 'bundle.txt'), $info, $utf8)

    New-Item -ItemType Directory -Force $OutDir | Out-Null
    $name = "$Lane-studio-$version.tar.gz"
    $out = Join-Path $OutDir $name
    if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }
    & $tar -czf $out -C $stage bundle.txt SHA256SUMS files
    if ($LASTEXITCODE -ne 0) { throw "tar failed ($LASTEXITCODE)" }
    $sha = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$out.sha256", "$sha  $name`n", $utf8)
    Write-Host ("{0}: {1} files ({2:N0} bytes) of {3} {4}, sha256 {5}" -f $out, $paths.Count, $bytes, $Lane, $version, $sha)
}
finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
