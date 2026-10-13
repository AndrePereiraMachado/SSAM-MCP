<#
.SYNOPSIS
  Windows proof of the Studio extraction of the ssam-server image, with 7-Zip AND with nsis_extract.py.

.DESCRIPTION
  For each lane (o11 = Service Studio 11, odc = ODC Studio):
    1. 7z x of the official installer (only read; the installer never runs) into <Out>\<lane>-7z;
    2. the Studio folder of that output = the folder of the marker (ServiceStudio.Framework.dll / OutSystems.ModelAPILoader.dll);
    3. every path of studio-<lane>.txt must be there (the needed list of the image);
    4. nsis_extract.py extract --only studio-<lane>.txt into <Out>\<lane>-nsis (what the image build runs by default);
    5. the two readers must give the same bytes (sha256) for every listed file;
    6. when the installed Studio has the same version as the installer, the listed files must equal it too.
  Writes only under -Out. Exit code 0 when every check passed, 1 otherwise.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File docker\ssam-server\prova-extracao.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File docker\ssam-server\prova-extracao.ps1 -OdcInstaller ODCStudio-1.7.23.10682.exe
#>
param(
    [string]$SevenZip = 'C:\t\tools\7zip\7z.exe',
    [string]$Installers = (Join-Path $env:USERPROFILE 'Downloads'),
    [string]$O11Installer = 'ServiceStudio-11.55.91.65258.exe',
    [string]$OdcInstaller = 'ODCStudio-1.7.28.10850.exe',
    [string]$Out = 'C:\t\dist-b\extract',
    [string]$Python = (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'),
    [string]$O11Installed = (Join-Path $env:ProgramFiles 'OutSystems\Service Studio 11\Service Studio'),
    [string]$OdcInstalled = (Join-Path $env:ProgramFiles 'OutSystems\ODC Studio\ODC Studio')
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path -LiteralPath $SevenZip)) { Write-Host "7-Zip not found at $SevenZip (pass -SevenZip)."; exit 1 }
if (-not (Test-Path -LiteralPath $Python)) { Write-Host "Python not found at $Python (pass -Python)."; exit 1 }
New-Item -ItemType Directory -Force $Out | Out-Null
$env:TEMP = Join-Path $Out 'tmp'; $env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null

function Hash([string]$file) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
function Version([string]$file) { if (Test-Path -LiteralPath $file) { (Get-Item -LiteralPath $file).VersionInfo.FileVersion } else { $null } }

$lanes = @(
    @{ Lane = 'o11'; Installer = $O11Installer; Marker = 'ServiceStudio.Framework.dll'; Installed = $O11Installed },
    @{ Lane = 'odc'; Installer = $OdcInstaller; Marker = 'OutSystems.ModelAPILoader.dll'; Installed = $OdcInstalled }
)
$failed = $false
foreach ($l in $lanes) {
    $lane = $l.Lane
    Write-Host "== $lane ($($l.Installer))"
    $installer = Join-Path $Installers $l.Installer
    if (-not (Test-Path -LiteralPath $installer)) { Write-Host "  MISSING installer $installer"; $failed = $true; continue }
    $list = Join-Path $here "studio-$lane.txt"
    $needed = Get-Content -LiteralPath $list | Where-Object { $_.Trim() -and -not $_.TrimStart().StartsWith('#') } | ForEach-Object { $_.Trim() }
    Write-Host ("  installer sha256 {0}" -f (Hash $installer))

    # 1-2. 7-Zip
    $x7 = Join-Path $Out "$lane-7z"
    if (Test-Path -LiteralPath $x7) { Remove-Item -LiteralPath $x7 -Recurse -Force }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $SevenZip x -y -bd ("-o" + $x7) $installer | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "  7z failed (exit $LASTEXITCODE)"; $failed = $true; continue }
    $marker = Get-ChildItem -LiteralPath $x7 -Recurse -File -Filter $l.Marker | Sort-Object { $_.FullName.Length } | Select-Object -First 1
    if (-not $marker) { Write-Host "  7z output has no $($l.Marker)"; $failed = $true; continue }
    $root7 = $marker.DirectoryName
    Write-Host ("  7z: {0:N1}s, {1} files, Studio folder {2}" -f $sw.Elapsed.TotalSeconds, (Get-ChildItem -LiteralPath $x7 -Recurse -File).Count, $root7.Substring($x7.Length))

    # 3. the needed list against the 7z output
    $missing = @($needed | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root7 ($_ -replace '/', '\'))) })
    $bytes = ($needed | Where-Object { $missing -notcontains $_ } | ForEach-Object { (Get-Item -LiteralPath (Join-Path $root7 ($_ -replace '/', '\'))).Length } | Measure-Object -Sum).Sum
    Write-Host ("  needed: {0} listed, {1} missing in the 7z output, {2:N0} bytes" -f $needed.Count, $missing.Count, $bytes)
    foreach ($m in $missing) { Write-Host "    missing $m" }
    if ($missing.Count) { $failed = $true }

    # 4. nsis_extract.py (the default reader of the image build)
    $xn = Join-Path $Out "$lane-nsis"
    if (Test-Path -LiteralPath $xn) { Remove-Item -LiteralPath $xn -Recurse -Force }
    $sw.Restart()
    & $Python (Join-Path $here 'nsis_extract.py') extract $installer $xn --marker $l.Marker --only $list
    if ($LASTEXITCODE -ne 0) { Write-Host "  nsis_extract.py failed (exit $LASTEXITCODE)"; $failed = $true; continue }
    Write-Host ("  nsis_extract.py: {0:N1}s" -f $sw.Elapsed.TotalSeconds)

    # 5-6. same bytes from both readers, and from the installed Studio of the same version
    $installedSame = (Version (Join-Path $l.Installed $l.Marker)) -and ((Version (Join-Path $l.Installed $l.Marker)) -eq (Version (Join-Path $root7 $l.Marker)))
    $diff7 = 0; $diffInstalled = 0
    foreach ($rel in $needed) {
        $win = $rel -replace '/', '\'
        $a = Join-Path $xn $win
        if (-not (Test-Path -LiteralPath $a)) { $diff7++; Write-Host "    nsis missing $rel"; continue }
        $h = Hash $a
        $b = Join-Path $root7 $win
        if ((Test-Path -LiteralPath $b) -and (Hash $b) -ne $h) { $diff7++; Write-Host "    7z and nsis differ: $rel" }
        if ($installedSame -and (Hash (Join-Path $l.Installed $win)) -ne $h) { $diffInstalled++; Write-Host "    installed differs: $rel" }
    }
    Write-Host ("  7z vs nsis_extract.py: {0} difference(s)" -f $diff7)
    if ($installedSame) { Write-Host ("  installed Studio (same version): {0} difference(s)" -f $diffInstalled) }
    else { Write-Host ("  installed Studio not compared (installed {0}, installer {1})" -f (Version (Join-Path $l.Installed $l.Marker)), (Version (Join-Path $root7 $l.Marker))) }
    if ($diff7 -or $diffInstalled) { $failed = $true }
}
if ($failed) { Write-Host 'RESULT: FAILED'; exit 1 }
Write-Host 'RESULT: OK'
exit 0
