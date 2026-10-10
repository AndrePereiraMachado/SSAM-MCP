param(
    [string]$Lane = "ss4",
    [switch]$NoBuild,
    [switch]$ForceRestart,
    [int]$WaitSeconds = 120
)
# Abre o Service Studio de uma FAIXA (scripts/lanes.py): clona a instalacao base uma vez (copia local, nunca sai da maquina),
# constroi o bridge, injeta a porta da bridge e do CDP, regista as DLLs no deps.json e abre. Nunca toca noutra faixa.
#   .\scripts\open_studio.ps1 -Lane ss5 [-NoBuild] [-ForceRestart]
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$laneJson = python (Join-Path $Root "scripts\lanes.py") $Lane --json
if ($LASTEXITCODE -ne 0) { throw "faixa desconhecida: $Lane" }
$L = $laneJson | ConvertFrom-Json
$Port = [int]$L.bridge
$CdpPort = [int]$L.cdp
$StudioDir = $L.studioDir
$Exe = Join-Path $StudioDir "ServiceStudio.exe"
$Tag = $Lane.ToUpper()

# 0) clonar a instalacao base se a faixa ainda nao tem Studio
if (-not (Test-Path $Exe)) {
    $Base = $L.baseStudio
    if (-not (Test-Path (Join-Path $Base "ServiceStudio.exe"))) { throw "instalacao base do Studio nao encontrada: $Base" }
    Write-Host "${Tag}: a clonar o Studio de '$Base' para '$StudioDir' (uma vez, ~830 MB)..."
    New-Item -ItemType Directory -Force -Path $StudioDir | Out-Null
    robocopy $Base $StudioDir /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy falhou ($LASTEXITCODE)" }
    if (-not (Test-Path $Exe)) { throw "clone incompleto: $Exe nao existe" }
    Write-Host "${Tag}: clone pronto."
}

$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*Anvil $Port*" }
if ($running -and -not $ForceRestart) { Write-Host "${Tag} ja esta aberto (pid $($running.Id -join ','))."; exit 0 }
if ($running) { $running | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 4 }

if (-not $NoBuild) {
    dotnet build (Join-Path $Root "src\Anvil.Bridge\Anvil.Bridge.csproj") -c Release -nologo -v q | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "build do bridge falhou" }
    dotnet build (Join-Path $Root "tools\Anvil.Inject\Anvil.Inject.csproj") -c Release -nologo -v q | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "build do injetor falhou" }
}
$BridgeBin = Join-Path $Root "src\Anvil.Bridge\bin\Release\net8.0"
$InjectDll = Join-Path $Root "tools\Anvil.Inject\bin\Release\net8.0\Anvil.Inject.dll"

# 1) copiar as DLLs do bridge (so as nossas; nunca binarios da OutSystems)
foreach ($name in @("Anvil.Bridge.dll", "Anvil.Core.dll")) {
    Copy-Item (Join-Path $BridgeBin $name) (Join-Path $StudioDir $name) -Force
}

# 2) injetar o Start(port) e a porta CDP
dotnet $InjectDll inject --studio $StudioDir --bridge (Join-Path $StudioDir "Anvil.Bridge.dll") --port $Port | Out-Host
if ($LASTEXITCODE -ne 0) { throw "injecao falhou" }
dotnet $InjectDll cdp --studio $StudioDir --cdp-port $CdpPort | Out-Host
if ($LASTEXITCODE -ne 0) { throw "patch CDP falhou" }

# 3) registrar as DLLs no ServiceStudio.deps.json (TPA do host .NET)
$deps = Join-Path $StudioDir "ServiceStudio.deps.json"
$patch = @'
import json, sys
p = sys.argv[1]
d = json.loads(open(p, encoding="utf-8-sig").read())
changed = False
for tk, t in d.get("targets", {}).items():
    if not any(k.startswith("ServiceStudio.WebViewImplementation/") for k in t): continue
    wvi = next(k for k in t if k.startswith("ServiceStudio.WebViewImplementation/"))
    entry = t.setdefault("Anvil.Bridge/1.0.0", {"runtime": {}})
    rt = entry.setdefault("runtime", {})
    for dll in ("Anvil.Bridge.dll", "Anvil.Core.dll"):
        if dll not in rt: rt[dll] = {}; changed = True
    deps = t[wvi].setdefault("dependencies", {})
    if deps.get("Anvil.Bridge") != "1.0.0": deps["Anvil.Bridge"] = "1.0.0"; changed = True
libs = d.setdefault("libraries", {})
if libs.get("Anvil.Bridge/1.0.0") != {"type": "project", "serviceable": False, "sha512": ""}:
    libs["Anvil.Bridge/1.0.0"] = {"type": "project", "serviceable": False, "sha512": ""}; changed = True
if changed: open(p, "w", encoding="utf-8").write(json.dumps(d, indent=2))
print("deps.json", "atualizado" if changed else "ja ok")
'@
$patch | python - $deps
if ($LASTEXITCODE -ne 0) { throw "patch do deps.json falhou" }

# 4) abrir e esperar o bridge
Start-Process -FilePath $Exe -ArgumentList "-debug" -WorkingDirectory $StudioDir | Out-Null   # -debug: sem a trava de instancia unica
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$ok = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect("127.0.0.1", $Port); $c.Close(); $ok = $true; break
    } catch { }
}
if ($ok) { Write-Host "${Tag} pronto: bridge Anvil na porta $Port, CDP $CdpPort (log: $($L.bridgeLog)). Use ANVIL_LANE=$Lane nos scripts." } else { Write-Warning "${Tag} abriu mas o bridge nao respondeu em $WaitSeconds s; ver $($L.bridgeLog)" }
