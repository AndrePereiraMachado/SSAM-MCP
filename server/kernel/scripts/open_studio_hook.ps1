param(
    [int]$Port = 4516,
    # Omitido: o Service Studio registrado no Windows (qualquer versao, qualquer pasta), depois a pasta padrao.
    [string]$StudioDir = "",
    [switch]$NoBuild,
    [int]$WaitSeconds = 180,
    # Fora do AppData: apps empacotados (MSIX, como o app do Claude) veem uma copia privada de %LOCALAPPDATA%, e o
    # Studio aberto pelo usuario veria outra. Aqui os dois lados (ponte e controlador confiavel) enxergam o mesmo lugar.
    [string]$AuthorityDir = (Join-Path $env:USERPROFILE ".anvil\authority"),
    # So compila a ponte numa pasta nova e aponta o atalho para ela; nao abre o Studio (pode rodar com o Studio aberto,
    # porque a pasta carregada nao e tocada). O proximo "Service Studio (SSAM)" (-NoBuild) carrega a pasta nova.
    [switch]$BuildOnly
)
# Abre o Service Studio NORMAL (a instalacao que recebe o retorno do SSO) com a ponte Anvil carregada por startup hook
# do .NET (DOTNET_STARTUP_HOOKS), so neste processo. Nao altera nenhum arquivo da instalacao: confere os hashes antes e
# depois. A ponte e compilada contra ESTA instalacao em .local\bridge-hook\<versao>\ e nunca substitui a do clone.
#   .\scripts\open_studio_hook.ps1 [-NoBuild] [-Port 4516]
# Depois, faca o login SSO normalmente no Studio que abrir. Use ANVIL_LANE=ss4 nos scripts, como antes.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $StudioDir) {
    $registered = foreach ($hive in "HKLM:", "HKCU:") {
        foreach ($view in "SOFTWARE", "SOFTWARE\WOW6432Node") {
            $key = "$hive\$view\Microsoft\Windows\CurrentVersion\Uninstall\OutSystems Service Studio 11"
            $location = (Get-ItemProperty $key -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
            if ($location) { Join-Path $location "Service Studio" }
        }
    }
    $StudioDir = @($registered) + @(Join-Path $env:ProgramFiles "OutSystems\Service Studio 11\Service Studio") |
        Where-Object { $_ -and (Test-Path (Join-Path $_ "ServiceStudio.exe")) } | Select-Object -First 1
    if (-not $StudioDir) { throw "Nenhum Service Studio 11 instalado foi encontrado; informe -StudioDir <pasta do ServiceStudio.exe>." }
}
$Exe = Join-Path $StudioDir "ServiceStudio.exe"
if (-not (Test-Path $Exe)) { throw "Service Studio nao encontrado: $Exe" }
$Version = (Get-Item $Exe).VersionInfo.FileVersion
# A pasta da ponte em uso fica num ponteiro (<versao>.current): uma compilacao nova vai para uma pasta nova, porque a
# pasta que um Studio aberto carregou fica travada, e o atalho com -NoBuild segue o ponteiro.
$HookRoot = Join-Path $Root ".local\bridge-hook"
$Pointer = Join-Path $HookRoot "$Version.current"
$Out = Join-Path $HookRoot $Version
if (Test-Path $Pointer) { $Out = Join-Path $HookRoot ((Get-Content $Pointer -Raw).Trim()) }
if ($BuildOnly -or -not $NoBuild) { $Out = Join-Path $HookRoot ("$Version-" + (Get-Date -Format "yyyyMMdd-HHmmss")) }

if (-not $BuildOnly) {
    # 1) Um Studio desta instalacao ja aberto receberia este pedido (instancia unica) e o hook nao carregaria.
    $sameInstall = Get-Process ServiceStudio -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($StudioDir, [StringComparison]::OrdinalIgnoreCase) }
    if ($sameInstall) { throw "Feche o Service Studio aberto (pid $($sameInstall.Id -join ',')) e rode de novo: a ponte so entra num Studio aberto por este script." }
    $portBusy = $false
    try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect("127.0.0.1", $Port); $c.Close(); $portBusy = $true } catch { }
    if ($portBusy) { throw "A porta $Port ja esta em uso (provavelmente o clone 'Service Studio 11 - Anvil $Port'). Feche-o antes." }
}

# 2) Ponte e hook compilados contra esta instalacao (pasta propria; o clone nao e tocado)
if (-not $NoBuild -or $BuildOnly -or -not (Test-Path (Join-Path $Out "bridge\Anvil.Bridge.dll"))) {
    # Bibliotecas do .NET que esta instalacao traga em versao maior (11.55.91: DiagnosticSource, Text.Json 10) entram sozinhas
    # pelo kernel\Directory.Build.targets, para qualquer versao do Studio.
    dotnet build (Join-Path $Root "src\Anvil.Bridge\Anvil.Bridge.csproj") -c Release -nologo -v q "-p:SSDir=$StudioDir" -o (Join-Path $Out "bridge") | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "build da ponte contra $Version falhou" }
    dotnet build (Join-Path $Root "tools\Anvil.StartupHook\Anvil.StartupHook.csproj") -c Release -nologo -v q -o (Join-Path $Out "hook") | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "build do startup hook falhou" }
}
$Hook = Join-Path $Out "hook\Anvil.StartupHook.dll"
$BridgeDir = Join-Path $Out "bridge"
# Dependencias de pacote que a instalacao do Studio nao tem (o build com -o nao copia PackageReference transitiva). Pacotes,
# versoes e pasta de pacotes vem do project.assets.json da ponte, nao de caminhos fixos; o que o Studio ja traz fica o dele.
$assets = Get-Content (Join-Path $Root "src\Anvil.Bridge\obj\project.assets.json") -Raw | ConvertFrom-Json
$packageFolders = @($assets.packageFolders.PSObject.Properties.Name)
foreach ($target in $assets.targets.PSObject.Properties) {
    foreach ($library in $target.Value.PSObject.Properties) {
        if ($library.Value.type -ne "package" -or -not $library.Value.runtime) { continue }
        $libraryPath = $assets.libraries.($library.Name).path
        foreach ($asset in $library.Value.runtime.PSObject.Properties.Name) {
            if ($asset -notlike "*.dll") { continue }
            $name = Split-Path -Leaf $asset
            $dst = Join-Path $BridgeDir $name
            if ((Test-Path $dst) -or (Test-Path (Join-Path $StudioDir $name))) { continue }
            $from = $packageFolders | ForEach-Object { Join-Path (Join-Path $_ $libraryPath) $asset } | Where-Object { Test-Path $_ } | Select-Object -First 1
            if (-not $from) { throw "dependencia $name ($($library.Name)) nao encontrada em $($packageFolders -join ', ')" }
            Copy-Item $from $dst
        }
    }
}
if (-not (Test-Path $Hook) -or -not (Test-Path (Join-Path $BridgeDir "Anvil.Bridge.dll"))) { throw "ponte incompleta em $Out" }
Set-Content -Path $Pointer -Value (Split-Path -Leaf $Out) -Encoding ascii
if ($BuildOnly) {
    $sha = (Get-FileHash (Join-Path $BridgeDir "Anvil.Core.dll") -Algorithm SHA256).Hash
    Write-Host "Ponte compilada em $Out (Anvil.Core.dll sha256 $sha). O atalho 'Service Studio (SSAM)' carrega esta pasta no proximo Studio que abrir."
    return
}

# 3) Hashes da instalacao antes (prova de que nada foi alterado)
$watched = @("ServiceStudio.exe", "ServiceStudio.dll", "ServiceStudio.deps.json", "ServiceStudio.runtimeconfig.json", "ServiceStudio.WebViewImplementation.dll", "WebViewControl.Avalonia.dll")
function Hashes { $h = @{}; foreach ($f in $watched) { $p = Join-Path $StudioDir $f; if (Test-Path $p) { $h[$f] = (Get-FileHash $p -Algorithm SHA256).Hash } }; return $h }
$before = Hashes

# 4) Abrir so este processo com o hook (as variaveis nao ficam na sessao do usuario; o hook as apaga para os filhos)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Exe
$psi.WorkingDirectory = $StudioDir
$psi.UseShellExecute = $false
$psi.Environment["DOTNET_STARTUP_HOOKS"] = $Hook
$psi.Environment["ANVIL_BRIDGE_PORT"] = "$Port"
$psi.Environment["ANVIL_BRIDGE_DIR"] = $BridgeDir
$psi.Environment["ANVIL_AUTHORITY_DIR"] = $AuthorityDir
$proc = [System.Diagnostics.Process]::Start($psi)
Write-Host "Service Studio $Version aberto (pid $($proc.Id)) com a ponte na porta $Port (autorizacao em $AuthorityDir). Faca o login SSO nele normalmente."

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$ok = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect("127.0.0.1", $Port); $c.Close(); $ok = $true; break } catch { }
    if ($proc.HasExited) { break }
}
$after = Hashes
$changed = @($watched | Where-Object { $before[$_] -ne $after[$_] })
if ($changed.Count -gt 0) { Write-Warning "ARQUIVOS DA INSTALACAO MUDARAM: $($changed -join ', ')" } else { Write-Host "Instalacao intacta: $($watched.Count) arquivos com o mesmo sha256." }
$hookLog = Join-Path $env:LOCALAPPDATA "Anvil\startuphook-$Port.log"
if ($ok) { Write-Host "Ponte pronta na porta $Port (logs: $hookLog e $env:LOCALAPPDATA\Anvil\bridge-$Port.log)." }
else { Write-Warning "A ponte nao respondeu em $WaitSeconds s. Veja $hookLog." }
