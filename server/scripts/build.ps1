param([switch]$NoStart, [ValidateSet('ss4', 'ss5')][string]$Lane)
# The build never starts a worker: --no-start always (the next command starts the lane's worker for the Studio it
# selects). -NoStart stays accepted for the scripts and docs that pass it. At the end, `ssam warm` builds (or finds
# cached) the discover index of each lane, so the first ssam_discover of a session never builds it; a warm failure is
# reported and never fails the build.
$ErrorActionPreference = 'Stop'
$ssamWorkspace = Split-Path -Parent $PSScriptRoot
# Python: SSAM_PYTHON (scripts\setup-dev.ps1), then the Codex runtime's, then python on PATH.
$ssamPython = $env:SSAM_PYTHON
if (-not $ssamPython) {
    $ssamPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    if (-not (Test-Path -LiteralPath $ssamPython)) { $ssamPython = 'python' }
}
# Node: SSAM_NODE (scripts\setup-dev.ps1), then the Codex runtime's, then node on PATH (as ssam.cmd).
$ssamNode = $env:SSAM_NODE
if (-not $ssamNode -or -not (Test-Path -LiteralPath $ssamNode)) {
    $ssamNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (-not (Test-Path -LiteralPath $ssamNode)) { $ssamNode = 'node' }
}
$ssamLayout = Get-Content -LiteralPath (Join-Path $ssamWorkspace '.ssam-workspace.json') -Raw | ConvertFrom-Json
if (-not $Lane) { $Lane = $ssamLayout.o11Lane }
$env:ANVIL_LANE = $Lane
$env:ANVIL_ROOT = Join-Path $ssamWorkspace $ssamLayout.kernel
$env:SSAM_WORKSPACE_ROOT = $ssamWorkspace
$env:SSAM_HYBRID_ODC_ROOT = Join-Path $ssamWorkspace $ssamLayout.odc
$env:ANVIL_ODC_ROOT = $env:SSAM_HYBRID_ODC_ROOT
$env:ODC3_ROOT = $env:SSAM_HYBRID_ODC_ROOT
$env:ANVIL_WORKER_PORT = [string]$ssamLayout.workers."o11$Lane"
$env:ANVIL_ODC_PORT = [string]$ssamLayout.workers.odc
Push-Location (Join-Path $ssamWorkspace 'kernel')
try {
    $ssamBuildOptions = @('--no-start')
    # Sequential: both CLIs compile shared projects and must not write the same obj directory concurrently.
    & $ssamPython scripts\build.py @ssamBuildOptions
    if ($LASTEXITCODE -ne 0) { throw 'O11 build failed' }
    & $ssamPython scripts\build_odc.py @ssamBuildOptions
    if ($LASTEXITCODE -ne 0) { throw 'ODC kernel build failed' }
} finally { Pop-Location }
foreach ($ssamProject in @('builder\Builder.csproj', 'bridge\Bridge.csproj', 'bridge\client\Client.csproj')) {
    & dotnet build (Join-Path $ssamWorkspace "platforms\odc\studio\$ssamProject") -c Release --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $ssamProject" }
}
& $ssamNode (Join-Path $ssamWorkspace 'facade\ssam.mjs') warm
if ($LASTEXITCODE -ne 0) { Write-Warning 'ssam warm did not build every discover index; the first ssam_discover of that lane builds it and reports the same error.' }
