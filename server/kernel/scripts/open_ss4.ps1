param(
    [switch]$NoBuild,
    [switch]$ForceRestart,
    [int]$WaitSeconds = 120
)
# Compatibilidade: SS4 = faixa ss4. O lancador generico e scripts/open_studio.ps1 -Lane <ss4|ss5>.
& (Join-Path $PSScriptRoot "open_studio.ps1") -Lane ss4 -NoBuild:$NoBuild -ForceRestart:$ForceRestart -WaitSeconds $WaitSeconds
exit $LASTEXITCODE
