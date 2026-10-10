<#
.SYNOPSIS
    Prepara um checkout de desenvolvimento do SSAM Hybrid nesta maquina Windows.

.DESCRIPTION
    Passos, nesta ordem. Cada passo pode ser repetido: o que ja esta certo fica como esta.
      1. Confere git, .NET SDK 10, Node 22 ou mais novo, Python 3.11 ou mais novo e os Studios instalados
         (Service Studio 11 e ODC Studio, pelo registro do Windows). Oferece instalar com winget o que faltar,
         perguntando antes de cada ferramenta (salvo -Yes). Cada Studio e opcional: sem ele, a faixa dele fica de fora.
      2. Grava variaveis de ambiente do USUARIO (HKCU, nunca HKLM): SSAM_ROOT, SSAM_NODE, SSAM_PYTHON,
         ANVIL_AUTHORITY_DIR e, so quando preciso, ANVIL_STUDIO_DIR e ANVIL_ODC_STUDIO_DIR. Cria a pasta da autoridade.
      3. Instala as dependencias JavaScript com pnpm e lockfile congelado (raiz e platforms\odc).
      4. Compila contra os Studios INSTALADOS: CLI O11, CLI ODC, builder, bridge e cliente ODC. Com Service Studio,
         compila tambem o motor XIF (kernel\.local\xif-engine, net472 x86) das extensoes .NET O11; falha dele e aviso.
         Nao roda build.py, nao inicia worker (ANVIL_WORKER=0, ANVIL_ODC_NO_WORKER=1).
      5. Grava o tenant ODC e o host O11 desta pessoa em .ssam-local.json (fora do Git) e confere o MCP do Claude Code.
      6. Roda o doctor e mostra os proximos passos.
    O script nunca abre, fecha ou altera um Studio. O doctor do passo 6 so consulta (le processos e responde ao ping
    da bridge, se houver uma carregada).

.PARAMETER DryRun
    So mostra o que faria. Nao instala, nao grava variaveis, nao compila, nao escreve arquivos.
.PARAMETER Yes
    Nao pergunta nada: aceita instalar o que faltar e trocar variaveis. Nunca substitui uma entrada "ssam" ja
    registrada no Claude Code.
.PARAMETER SkipInstall
    Nao instala ferramentas com winget; so confere e avisa.
.PARAMETER SkipBuild
    Nao compila.
.PARAMETER SkipMcp
    Pula o passo 5 (tenant, host e MCP).
.PARAMETER NoUserEnv
    Nao grava variaveis de usuario; usa os valores so durante esta execucao.
.PARAMETER SkipDoctor
    Nao roda o doctor no fim.
.PARAMETER OdcTenant
    Tenant ODC desta pessoa (ex.: minhaempresa.outsystems.dev). Sem valor padrao.
.PARAMETER O11Host
    Host do ambiente O11 desta pessoa (ex.: minhaempresa.outsystemscloud.com). Sem valor padrao.
.PARAMETER PnpmVersion
    Versao do pnpm usada pelo corepack ou pelo npx (a mesma que gerou os node_modules do checkout original).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-dev.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$SkipInstall,
    [switch]$SkipBuild,
    [switch]$SkipMcp,
    [switch]$NoUserEnv,
    [switch]$SkipDoctor,
    [string]$OdcTenant,
    [string]$O11Host,
    [string]$PnpmVersion = '11.19.0'
)
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$WorkspaceFile = Join-Path $Root '.ssam-workspace.json'
if (-not (Test-Path -LiteralPath $WorkspaceFile)) { throw "Nao achei $WorkspaceFile. Rode o script de dentro de um clone do SSAM Hybrid." }
$Layout = Get-Content -LiteralPath $WorkspaceFile -Raw | ConvertFrom-Json
$OdcRoot = Join-Path $Root ($Layout.odc -replace '/', '\')
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Results = New-Object System.Collections.ArrayList
$LogFile = $null
if (-not $DryRun) {
    $logDir = Join-Path $Root '.local\setup'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $LogFile = Join-Path $logDir ('setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
}
# Isolamento durante a execucao: nenhum worker sobe por causa deste script (vale so para este processo e seus filhos).
$env:ANVIL_WORKER = '0'
$env:ANVIL_ODC_NO_WORKER = '1'
$env:DOTNET_NOLOGO = '1'

# ---------------------------------------------------------------- mensagens
function Write-Title([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Info([string]$Text) { Write-Host "   $Text" }
function Write-Good([string]$Text) { Write-Host "   OK     $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "   AVISO  $Text" -ForegroundColor Yellow }
function Write-Bad([string]$Text) { Write-Host "   FALHA  $Text" -ForegroundColor Red }
function Write-Plan([string]$Text) { Write-Host "   (simulacao) $Text" -ForegroundColor DarkGray }
function Add-Result([string]$Step, [string]$Status, [string]$Detail, [double]$Seconds = -1) {
    [void]$Results.Add([pscustomobject]@{ Passo = $Step; Resultado = $Status; Tempo = $(if ($Seconds -ge 0) { Format-Duration $Seconds } else { '' }); Detalhe = $Detail })
}
function Format-Duration([double]$Seconds) {
    if ($Seconds -ge 60) { return ('{0}m{1:00}s' -f [int][math]::Floor($Seconds / 60), [int][math]::Floor($Seconds % 60)) }
    return ('{0:N1}s' -f $Seconds)
}
function Write-Log([string]$Text) { if ($LogFile) { [IO.File]::AppendAllText($LogFile, $Text + [Environment]::NewLine, $Utf8) } }

# Pergunta sim/nao. Com -Yes devolve $AutoAnswer sem perguntar. Sem terminal interativo, a resposta e "nao".
function Confirm-Step([string]$Question, [bool]$AutoAnswer = $true) {
    if ($Yes) {
        Write-Info ("$Question -> " + $(if ($AutoAnswer) { 'sim' } else { 'nao' }) + ' (-Yes)')
        return $AutoAnswer
    }
    try { $answer = Read-Host "   $Question [s/N]" }
    catch { Write-Note 'Sem terminal interativo para perguntar; considerei "nao". Use -Yes para aceitar.'; return $false }
    return ($answer -match '^\s*(s|sim|y|yes)\s*$')
}

# ---------------------------------------------------------------- processos externos
# Aspas no padrao do Windows (CommandLineToArgvW), para caminhos com espacos chegarem inteiros.
function ConvertTo-Argument([string]$Value) {
    if ($Value -eq '') { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}
# Roda um programa sem janela, captura stdout e stderr (sem o NativeCommandError do PowerShell 5.1) e mede o tempo.
function Invoke-Tool {
    param([string]$File, [string[]]$Arguments = @(), [string]$WorkingDirectory = $Root, [int]$TimeoutSeconds = 0)
    $line = (@($Arguments) | ForEach-Object { ConvertTo-Argument $_ }) -join ' '
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    if ($File -match '\.(cmd|bat)$') {
        $psi.FileName = $env:ComSpec
        $psi.Arguments = '/d /s /c "' + (ConvertTo-Argument $File) + ' ' + $line + '"'
    } else {
        $psi.FileName = $File
        $psi.Arguments = $line
    }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $WorkingDirectory
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try { $process = [Diagnostics.Process]::Start($psi) }
    catch { return [pscustomobject]@{ ExitCode = -1; StdOut = ''; StdErr = $_.Exception.Message; Seconds = 0; TimedOut = $false } }
    $out = $process.StandardOutput.ReadToEndAsync()
    $err = $process.StandardError.ReadToEndAsync()
    $timedOut = $false
    if ($TimeoutSeconds -gt 0) {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { $timedOut = $true; try { $process.Kill() } catch { } }
    }
    $process.WaitForExit()
    $watch.Stop()
    $result = [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $out.Result; StdErr = $err.Result; Seconds = $watch.Elapsed.TotalSeconds; TimedOut = $timedOut }
    Write-Log ("### $File $line" + [Environment]::NewLine + "### saida $($result.ExitCode) em $(Format-Duration $result.Seconds)" + [Environment]::NewLine + $result.StdOut + $result.StdErr)
    return $result
}

# PATH desta sessao com o que o instalador acabou de acrescentar (Maquina e Usuario), sem perder o que ja havia.
function Update-SessionPath {
    $current = @($env:Path -split ';' | Where-Object { $_ })
    foreach ($scope in 'Machine', 'User') {
        $value = [Environment]::GetEnvironmentVariable('Path', $scope)
        if (-not $value) { continue }
        foreach ($entry in ($value -split ';' | Where-Object { $_ })) {
            $expanded = [Environment]::ExpandEnvironmentVariables($entry)
            if ($current -notcontains $expanded) { $current += $expanded }
        }
    }
    $env:Path = $current -join ';'
}

function Install-WithWinget([string]$Id, [string]$Label, [string]$Url) {
    if ($SkipInstall) { Write-Note "$Label nao sera instalado (-SkipInstall). Instale manualmente: $Url"; return $false }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $winget) { Write-Note "winget nao encontrado. Instale $Label manualmente: $Url"; return $false }
    if ($DryRun) { Write-Plan "instalaria $Label com: winget install --id $Id -e --source winget"; return $false }
    if (-not (Confirm-Step "Instalar $Label com winget ($Id)?")) { Write-Note "$Label nao foi instalado. Instale manualmente: $Url"; return $false }
    $wingetArgs = @('install', '--id', $Id, '-e', '--source', 'winget')
    if ($Yes) { $wingetArgs += @('--accept-package-agreements', '--accept-source-agreements') }
    & $winget.Source @wingetArgs
    $code = $LASTEXITCODE
    Update-SessionPath
    if ($code -ne 0) { Write-Note "winget terminou com codigo $code para $Label (pode ja estar instalado). Vou conferir de novo." }
    return $true
}

# ---------------------------------------------------------------- deteccao
function Find-Git {
    $candidates = @()
    $onPath = Get-Command git.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { $candidates += $onPath.Source }
    $candidates += (Join-Path $env:ProgramFiles 'Git\cmd\git.exe')
    $vs = Join-Path $env:ProgramFiles 'Microsoft Visual Studio\*\*\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\Git\cmd\git.exe'
    $candidates += @(Get-ChildItem -Path $vs -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    foreach ($candidate in $candidates) {
        if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { continue }
        $probe = Invoke-Tool $candidate @('--version') -TimeoutSeconds 30
        if ($probe.ExitCode -eq 0) { return [pscustomobject]@{ Path = $candidate; Version = $probe.StdOut.Trim() } }
    }
    return $null
}

function Find-DotNet {
    $exe = $null
    $onPath = Get-Command dotnet.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { $exe = $onPath.Source }
    if (-not $exe) {
        $default = Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'
        if (Test-Path -LiteralPath $default) { $exe = $default }
    }
    if (-not $exe) { return $null }
    $probe = Invoke-Tool $exe @('--list-sdks') -TimeoutSeconds 60
    $sdks = @($probe.StdOut -split "`r?`n" | Where-Object { $_ -match '^(\d+)\.(\d+)\.(\d+)' } | ForEach-Object { ($_ -split ' ')[0] })
    $major = 0
    foreach ($sdk in $sdks) { $m = [int]($sdk -split '\.')[0]; if ($m -gt $major) { $major = $m } }
    return [pscustomobject]@{ Path = $exe; Sdks = $sdks; Major = $major; Ok = ($major -ge 10) }
}

$CodexDependencies = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
function Find-Node {
    $candidates = @()
    if ($env:SSAM_NODE) { $candidates += [pscustomobject]@{ Path = $env:SSAM_NODE; From = 'SSAM_NODE' } }
    $candidates += [pscustomobject]@{ Path = (Join-Path $CodexDependencies 'node\bin\node.exe'); From = 'runtime Codex' }
    foreach ($command in @(Get-Command node.exe -All -ErrorAction SilentlyContinue)) { $candidates += [pscustomobject]@{ Path = $command.Source; From = 'PATH' } }
    $tooOld = $null
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate.Path)) { continue }
        $probe = Invoke-Tool $candidate.Path @('--version') -TimeoutSeconds 30
        if ($probe.ExitCode -ne 0 -or $probe.StdOut.Trim() -notmatch '^v(\d+)\.') { continue }
        $version = $probe.StdOut.Trim()
        if ([int]$Matches[1] -lt 22) { $tooOld = "$version em $($candidate.Path)"; continue }
        $dir = Split-Path -Parent $candidate.Path
        $corepack = Join-Path $dir 'node_modules\corepack\dist\corepack.js'
        return [pscustomobject]@{ Path = (Resolve-Path -LiteralPath $candidate.Path).Path; Version = $version; From = $candidate.From
            Corepack = $(if (Test-Path -LiteralPath $corepack) { $corepack } else { $null }); TooOld = $tooOld }
    }
    if ($tooOld) { Write-Note "Node antigo demais: $tooOld (precisa 22 ou mais novo)." }
    return $null
}

function Find-Python {
    $code = "import sys; print('%d.%d.%d' % sys.version_info[:3]); print(sys.executable)"
    $candidates = @()
    if ($env:SSAM_PYTHON) { $candidates += [pscustomobject]@{ Path = $env:SSAM_PYTHON; Prefix = @(); From = 'SSAM_PYTHON' } }
    $candidates += [pscustomobject]@{ Path = (Join-Path $CodexDependencies 'python\python.exe'); Prefix = @(); From = 'runtime Codex' }
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($launcher) { $candidates += [pscustomobject]@{ Path = $launcher.Source; Prefix = @('-3'); From = 'py -3' } }
    foreach ($name in 'python.exe', 'python3.exe') {
        foreach ($command in @(Get-Command $name -All -ErrorAction SilentlyContinue)) { $candidates += [pscustomobject]@{ Path = $command.Source; Prefix = @(); From = 'PATH' } }
    }
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate.Path)) { continue }
        $probe = Invoke-Tool $candidate.Path (@($candidate.Prefix) + @('-c', $code)) -TimeoutSeconds 30
        $lines = @($probe.StdOut -split "`r?`n" | Where-Object { $_ })
        if ($probe.ExitCode -ne 0 -or $lines.Count -lt 2 -or $lines[0] -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
            if ($candidate.Path -like '*\WindowsApps\*') { Write-Info "Ignorado: $($candidate.Path) e o atalho da Microsoft Store, nao um Python instalado." }
            continue
        }
        $major = [int]$Matches[1]; $minor = [int]$Matches[2]
        if ($major -lt 3 -or ($major -eq 3 -and $minor -lt 11)) { Write-Note "Python antigo demais: $($lines[0]) em $($candidate.Path) (precisa 3.11 ou mais novo)."; continue }
        return [pscustomobject]@{ Path = $lines[1].Trim(); Version = $lines[0]; From = $candidate.From }
    }
    return $null
}

# A instalacao registrada no Windows (Uninstall\<nome>, InstallLocation), a mesma regra dos Directory.Build.targets.
function Find-Studio([string]$Name, [string]$SubFolder, [string]$Marker, [string]$Exe) {
    foreach ($hive in 'HKLM:', 'HKCU:') {
        foreach ($view in 'SOFTWARE', 'SOFTWARE\WOW6432Node') {
            $key = "$hive\$view\Microsoft\Windows\CurrentVersion\Uninstall\$Name"
            if (-not (Test-Path -LiteralPath $key)) { continue }
            $location = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).InstallLocation
            if (-not $location) { continue }
            $dir = Join-Path $location.Trim().Trim('"') $SubFolder
            if (-not (Test-Path -LiteralPath (Join-Path $dir $Marker))) { continue }
            $version = $null
            $exePath = Join-Path $dir $Exe
            if (Test-Path -LiteralPath $exePath) { $version = (Get-Item -LiteralPath $exePath).VersionInfo.FileVersion }
            return [pscustomobject]@{ Dir = $dir; Version = $version; Key = $key }
        }
    }
    return $null
}

function ConvertTo-HostName([string]$Value) {
    if (-not $Value) { return $null }
    $text = ($Value.Trim().ToLowerInvariant() -replace '^https?://', '') -replace '/.*$', ''
    if ($text -notmatch '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$') { return $null }
    return $text
}

# ================================================================ inicio
$total = [Diagnostics.Stopwatch]::StartNew()
Write-Host 'SSAM Hybrid: preparacao do ambiente de desenvolvimento' -ForegroundColor Cyan
Write-Info "Pasta do repositorio: $Root"
$modes = @()
foreach ($flag in 'DryRun', 'Yes', 'SkipInstall', 'SkipBuild', 'SkipMcp', 'NoUserEnv', 'SkipDoctor') { if ((Get-Variable $flag -ValueOnly).IsPresent) { $modes += "-$flag" } }
if ($modes.Count) { Write-Info ('Opcoes: ' + ($modes -join ' ')) }
if ($LogFile) { Write-Info "Registro detalhado: $LogFile" }

# Um checkout com selecao de pacote ativa e o operacional de alguem: nada de rodar tudo sem perguntar ali.
if (Test-Path -LiteralPath (Join-Path $Root '.local\releases\active-readonly.json')) {
    Write-Note 'Esta pasta tem .local\releases\active-readonly.json: parece um checkout operacional, nao um clone novo.'
    if (-not $DryRun) {
        if ($Yes) { Write-Bad 'Com -Yes eu nao sigo numa pasta assim. Rode sem -Yes para confirmar cada passo, ou use um clone novo.'; exit 1 }
        if (-not (Confirm-Step 'Continuar mesmo assim nesta pasta?')) { exit 1 }
    }
}

# ---------------------------------------------------------------- 1. pre-requisitos
Write-Title '1/6 Pre-requisitos'
$stepWatch = [Diagnostics.Stopwatch]::StartNew()

$git = Find-Git
if (-not $git -and (Install-WithWinget 'Git.Git' 'Git' 'https://git-scm.com/download/win')) { $git = Find-Git }
if ($git) { Write-Good "git: $($git.Version) ($($git.Path))" } else { Write-Note 'git nao encontrado. O setup segue, mas voce vai precisar dele para atualizar o repositorio.' }

$dotnet = Find-DotNet
if ((-not $dotnet -or -not $dotnet.Ok) -and (Install-WithWinget 'Microsoft.DotNet.SDK.10' '.NET SDK 10' 'https://dotnet.microsoft.com/download/dotnet/10.0')) { $dotnet = Find-DotNet }
if ($dotnet -and $dotnet.Ok) { Write-Good ".NET SDK: $($dotnet.Sdks -join ', ') ($($dotnet.Path)). Os projetos sao net8.0 e net10.0; o SDK 10 compila os dois." }
elseif ($dotnet) { Write-Bad ".NET SDK 10 ausente (achei: $($dotnet.Sdks -join ', ')). Instale: https://dotnet.microsoft.com/download/dotnet/10.0" }
else { Write-Bad '.NET SDK nao encontrado. Instale o SDK 10: https://dotnet.microsoft.com/download/dotnet/10.0' }

$node = Find-Node
if (-not $node -and (Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS' 'https://nodejs.org/')) { $node = Find-Node }
if ($node) {
    $corepackNote = $(if ($node.Corepack) { 'com corepack' } else { 'sem corepack (uso outro pnpm, veja o passo 3)' })
    Write-Good "Node: $($node.Version) ($($node.Path), origem: $($node.From), $corepackNote)"
} else { Write-Bad 'Node 22 ou mais novo nao encontrado. Instale: https://nodejs.org/' }

$python = Find-Python
if (-not $python -and (Install-WithWinget 'Python.Python.3.12' 'Python 3.12' 'https://www.python.org/downloads/windows/')) { $python = Find-Python }
if ($python) { Write-Good "Python: $($python.Version) ($($python.Path), origem: $($python.From))" }
else { Write-Note 'Python 3.11 ou mais novo nao encontrado. A faixa O11 (doctor, jobs, connect) precisa dele: https://www.python.org/downloads/windows/' }

$ss = Find-Studio 'OutSystems Service Studio 11' 'Service Studio' 'ServiceStudio.Framework.dll' 'ServiceStudio.exe'
if ($ss) { Write-Good "Service Studio 11: $($ss.Version) em $($ss.Dir)" }
else { Write-Note 'Service Studio 11 nao esta instalado: a faixa O11 fica de fora (CLI O11 nao sera compilada).' }
$odc = Find-Studio 'OutSystems ODC Studio' 'ODC Studio' 'OutSystems.Model.dll' 'ODCStudio.exe'
if ($odc) { Write-Good "ODC Studio: $($odc.Version) em $($odc.Dir)" }
else { Write-Note 'ODC Studio nao esta instalado: a faixa ODC fica de fora (CLI ODC, builder e bridge nao serao compilados).' }

$sac = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState
if ($sac -eq 1) { Write-Note 'Smart App Control esta LIGADO: o Windows pode bloquear as DLLs que este build gera (erro 0x800711C7 no attach). Veja COMECE-AQUI.md.' }
elseif ($sac -eq 2) { Write-Info 'Smart App Control em avaliacao: se o attach falhar com 0x800711C7, veja COMECE-AQUI.md.' }

$missing = @()
if (-not $node) { $missing += 'Node 22+' }
if (-not $SkipBuild -and -not ($dotnet -and $dotnet.Ok)) { $missing += '.NET SDK 10' }
$stepWatch.Stop()
if ($missing.Count -gt 0) {
    Add-Result 'Pre-requisitos' 'falha' ('faltam: ' + ($missing -join ', ')) $stepWatch.Elapsed.TotalSeconds
    if (-not $DryRun) { Write-Bad ('Faltam ferramentas obrigatorias: ' + ($missing -join ', ') + '. Instale e rode de novo.'); exit 1 }
} else {
    $studios = @(); if ($ss) { $studios += 'O11' }; if ($odc) { $studios += 'ODC' }
    Add-Result 'Pre-requisitos' $(if ($python) { 'ok' } else { 'aviso' }) ('faixas com Studio: ' + $(if ($studios.Count) { $studios -join ', ' } else { 'nenhuma' })) $stepWatch.Elapsed.TotalSeconds
}

# ---------------------------------------------------------------- 2. variaveis de ambiente
Write-Title '2/6 Variaveis de ambiente do usuario'
$authority = Join-Path $env:USERPROFILE '.anvil\authority'
$plan = [ordered]@{ SSAM_ROOT = $Root }
if ($node) { $plan['SSAM_NODE'] = $node.Path }
if ($python) { $plan['SSAM_PYTHON'] = $python.Path }
$plan['ANVIL_AUTHORITY_DIR'] = $authority
# O padrao do kernel para o Service Studio e uma copia "Anvil 4516" do checkout original; sem ela, o instalado.
$clone = Join-Path $env:USERPROFILE 'OutSystems\Service Studio 11 - Anvil 4516\Service Studio'
if ($ss -and -not (Test-Path -LiteralPath (Join-Path $clone 'ServiceStudio.Framework.dll'))) { $plan['ANVIL_STUDIO_DIR'] = $ss.Dir }
# O padrao do ODC Studio e a pasta de Program Files; so grava quando a instalacao esta noutro lugar.
$odcDefault = Join-Path $env:ProgramFiles 'OutSystems\ODC Studio\ODC Studio'
if ($odc -and ($odc.Dir.TrimEnd('\') -ne $odcDefault.TrimEnd('\'))) { $plan['ANVIL_ODC_STUDIO_DIR'] = $odc.Dir }

$envStatus = 'ok'
foreach ($name in @($plan.Keys)) {
    $value = $plan[$name]
    if ($DryRun) {
        $current = [Environment]::GetEnvironmentVariable($name, 'User')
        if ($NoUserEnv) { Write-Plan "usaria $name=$value so nesta execucao" }
        elseif ($current -eq $value) { Write-Plan "$name ja vale $value" }
        elseif ($current) { Write-Plan "trocaria $name de '$current' para '$value' (variavel de usuario)" }
        else { Write-Plan "gravaria $name=$value (variavel de usuario)" }
        continue
    }
    if ($NoUserEnv) { Set-Item -Path "env:$name" -Value $value; Write-Info "$name=$value (so nesta execucao, -NoUserEnv)"; continue }
    $current = [Environment]::GetEnvironmentVariable($name, 'User')
    if ($current -eq $value) { Set-Item -Path "env:$name" -Value $value; Write-Good "$name ja vale $value"; continue }
    if ($current -and -not (Confirm-Step "$name ja vale '$current'. Trocar por '$value'?")) {
        Set-Item -Path "env:$name" -Value $current; Write-Note "$name mantido em '$current'"; $envStatus = 'aviso'; continue
    }
    [Environment]::SetEnvironmentVariable($name, $value, 'User')
    Set-Item -Path "env:$name" -Value $value
    Write-Good "$name=$value"
}
if (-not $NoUserEnv) {
    if (Test-Path -LiteralPath $authority) { Write-Good "pasta da autoridade existe: $authority" }
    elseif ($DryRun) { Write-Plan "criaria a pasta $authority" }
    else { New-Item -ItemType Directory -Force -Path $authority | Out-Null; Write-Good "pasta da autoridade criada: $authority" }
}
if ($DryRun) { Add-Result 'Variaveis' 'simulado' (($plan.Keys) -join ', ') }
elseif ($NoUserEnv) { Add-Result 'Variaveis' 'pulado' '-NoUserEnv: valores so nesta execucao' }
else { Add-Result 'Variaveis' $envStatus (($plan.Keys) -join ', ') }

# ---------------------------------------------------------------- 3. dependencias JS
Write-Title '3/6 Dependencias JavaScript (pnpm, lockfile congelado)'
# Quem roda o pnpm, em ordem: corepack do Node escolhido, pnpm do PATH, pnpm que acompanha o Node (runtime Codex),
# npx pnpm@versao. Se um falhar, o proximo tenta.
function Get-PnpmRunners($NodeInfo) {
    $nodeDir = Split-Path -Parent $NodeInfo.Path
    $runners = @()
    if ($NodeInfo.Corepack) { $runners += [pscustomobject]@{ File = $NodeInfo.Path; Prefix = @($NodeInfo.Corepack, "pnpm@$PnpmVersion"); Label = "corepack (pnpm $PnpmVersion)" } }
    $onPath = Get-Command pnpm.cmd, pnpm.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { $runners += [pscustomobject]@{ File = $onPath.Source; Prefix = @(); Label = "pnpm do PATH ($($onPath.Source))" } }
    $bundled = Join-Path (Split-Path -Parent $nodeDir) 'node_modules\pnpm\bin\pnpm.cjs'
    if (Test-Path -LiteralPath $bundled) { $runners += [pscustomobject]@{ File = $NodeInfo.Path; Prefix = @($bundled); Label = "pnpm que acompanha este Node ($bundled)" } }
    $npx = Join-Path $nodeDir 'node_modules\npm\bin\npx-cli.js'
    if (Test-Path -LiteralPath $npx) { $runners += [pscustomobject]@{ File = $NodeInfo.Path; Prefix = @($npx, '--yes', "pnpm@$PnpmVersion"); Label = "npx pnpm@$PnpmVersion" } }
    return $runners
}
$jsFolders = @(@($Root, $OdcRoot) | Where-Object { (Test-Path -LiteralPath (Join-Path $_ 'package.json')) -and (Test-Path -LiteralPath (Join-Path $_ 'pnpm-lock.yaml')) })
if (-not $node) { Write-Bad 'Sem Node, sem dependencias JS.'; Add-Result 'Dependencias JS' 'falha' 'sem Node' }
else {
    $runners = @(Get-PnpmRunners $node)
    if ($runners.Count -eq 0) { Write-Bad 'Nao achei corepack, pnpm nem npx junto deste Node.'; Add-Result 'Dependencias JS' 'falha' 'sem pnpm' }
    elseif ($DryRun) {
        foreach ($folder in $jsFolders) { Write-Plan "rodaria pnpm install --frozen-lockfile em $folder, com $($runners[0].Label)" }
        Add-Result 'Dependencias JS' 'simulado' $runners[0].Label
    } else {
        # Corepack sem perguntas e sem gravar "packageManager" no package.json; o Node escolhido na frente do PATH.
        $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
        $env:COREPACK_ENABLE_AUTO_PIN = '0'
        $nodeDir = Split-Path -Parent $node.Path
        if (@($env:Path -split ';') -notcontains $nodeDir) { $env:Path = $nodeDir + ';' + $env:Path }
        $jsStatus = 'ok'; $jsSeconds = 0; $jsDetail = @(); $used = 0
        foreach ($folder in $jsFolders) {
            $relative = $folder.Substring($Root.Length).TrimStart('\'); if (-not $relative) { $relative = '(raiz)' }
            $done = $false
            for ($i = $used; $i -lt $runners.Count -and -not $done; $i++) {
                Write-Info "pnpm install --frozen-lockfile em $relative, com $($runners[$i].Label) ..."
                $run = Invoke-Tool $runners[$i].File (@($runners[$i].Prefix) + @('install', '--frozen-lockfile')) -WorkingDirectory $folder -TimeoutSeconds 900
                $jsSeconds += $run.Seconds
                if ($run.ExitCode -eq 0) { Write-Good "$relative em $(Format-Duration $run.Seconds)"; $jsDetail += $relative; $done = $true; $used = $i }
                else {
                    Write-Note "$relative falhou com $($runners[$i].Label) (codigo $($run.ExitCode))"
                    (($run.StdOut + $run.StdErr) -split "`r?`n" | Where-Object { $_ -match 'ERR|error|Error' } | Select-Object -Last 4) | ForEach-Object { Write-Info "  $_" }
                }
            }
            if (-not $done) { $jsStatus = 'falha'; Write-Bad "Nao consegui instalar as dependencias de $relative." }
        }
        if (-not (Test-Path -LiteralPath (Join-Path $OdcRoot 'node_modules\@modelcontextprotocol\server'))) { $jsStatus = 'falha'; Write-Bad 'platforms\odc\node_modules ficou incompleto.' }
        Add-Result 'Dependencias JS' $jsStatus ($runners[$used].Label + '; ' + ($jsDetail -join ', ')) $jsSeconds
    }
}

# ---------------------------------------------------------------- 4. build
Write-Title '4/6 Build contra os Studios instalados'
if ($SkipBuild) { Write-Info 'Pulado (-SkipBuild).'; Add-Result 'Build' 'pulado' '-SkipBuild' }
elseif (-not ($dotnet -and $dotnet.Ok)) { Write-Bad 'Sem .NET SDK 10, sem build.'; Add-Result 'Build' 'falha' 'sem .NET SDK 10' }
else {
    $lane = $Layout.o11Lane
    if ($env:ANVIL_LANE) { $lane = $env:ANVIL_LANE.Trim().ToLowerInvariant() }
    $o11Out = $(if ($lane -eq 'ss5') { Join-Path $Root 'kernel\.local\lane-ss5\cli' } else { Join-Path $Root 'kernel\.local\cli' })
    $odcStudio = Join-Path $OdcRoot 'studio'
    $common = @('-c', 'Release', '-nologo', '-v', 'q', '-nodeReuse:false')
    $builds = @()
    if ($ss) {
        $builds += [pscustomobject]@{ Name = "CLI O11 ($lane)"; Args = @('build', (Join-Path $Root 'kernel\src\Anvil.Cli')) + $common + @('-o', $o11Out, "-p:SSDir=$($ss.Dir)"); Output = (Join-Path $o11Out 'anvil.dll') }
        # Motor das extensoes .NET O11 (o11_extension): net472 x86, por reflexao sobre o Integration Studio instalado.
        # Compila sem o Integration Studio; sem ele, a ferramenta responde XIF_ENGINE_UNAVAILABLE. Falha aqui e so aviso.
        $engineOut = Join-Path $Root 'kernel\.local\xif-engine'
        $builds += [pscustomobject]@{ Name = 'motor XIF (Integration Studio)'; Args = @('build', (Join-Path $Root 'kernel\src\Anvil.Xif.Engine')) + $common + @('-o', $engineOut); Output = (Join-Path $engineOut 'Anvil.Xif.Engine.exe'); Optional = $true }
    }
    if ($odc) {
        $odcProperty = "-p:OdcInstall=$($odc.Dir)"
        $builds += [pscustomobject]@{ Name = 'CLI ODC'; Args = @('build', (Join-Path $Root 'kernel\src\Anvil.Cli.Odc')) + $common + @('-o', (Join-Path $Root 'kernel\.local\lane-odc\cli'), $odcProperty); Output = (Join-Path $Root 'kernel\.local\lane-odc\cli\anvil-odc.dll') }
        $builds += [pscustomobject]@{ Name = 'builder ODC'; Args = @('build', (Join-Path $odcStudio 'builder\Builder.csproj')) + $common + @($odcProperty); Output = (Join-Path $odcStudio 'builder\bin\Release\net10.0\ODC3.Builder.dll') }
        $builds += [pscustomobject]@{ Name = 'bridge ODC'; Args = @('build', (Join-Path $odcStudio 'bridge\Bridge.csproj')) + $common + @($odcProperty); Output = (Join-Path $odcStudio 'bridge\bin\Release\net8.0\ODC3.Bridge.v*.dll') }
        $builds += [pscustomobject]@{ Name = 'cliente da bridge ODC'; Args = @('build', (Join-Path $odcStudio 'bridge\client\Client.csproj')) + $common; Output = (Join-Path $odcStudio 'bridge\client\bin\Release\net10.0\ODC3.Bridge.Client.dll') }
    }
    if ($builds.Count -eq 0) { Write-Note 'Nenhum Studio instalado: nada para compilar.'; Add-Result 'Build' 'aviso' 'nenhum Studio instalado' }
    $buildFailed = $false; $buildSeconds = 0
    foreach ($build in $builds) {
        if ($DryRun) { Write-Plan ("dotnet " + ((@($build.Args) | ForEach-Object { ConvertTo-Argument $_ }) -join ' ')); continue }
        Write-Info "$($build.Name): compilando..."
        $run = Invoke-Tool $dotnet.Path $build.Args -TimeoutSeconds 1800
        $buildSeconds += $run.Seconds
        $text = $run.StdOut + $run.StdErr
        $produced = @(Get-ChildItem -Path $build.Output -ErrorAction SilentlyContinue).Count -gt 0
        if ($run.ExitCode -eq 0 -and $produced) { Write-Good "$($build.Name) em $(Format-Duration $run.Seconds)"; Add-Result "Build: $($build.Name)" 'ok' $build.Output $run.Seconds; continue }
        if ($build.PSObject.Properties['Optional'] -and $build.Optional) {
            Write-Note "$($build.Name) nao compilou (codigo $($run.ExitCode)); o11_extension responde XIF_ENGINE_UNAVAILABLE ate compilar. Veja $LogFile."
            Add-Result "Build: $($build.Name)" 'aviso' ('veja ' + $LogFile) $run.Seconds
            continue
        }
        $buildFailed = $true
        Write-Bad "$($build.Name) (codigo $($run.ExitCode), $(Format-Duration $run.Seconds))"
        $errors = @($text -split "`r?`n" | Where-Object { $_ -match '\berror\b|\berro\b' } | Select-Object -Unique | Select-Object -First 6)
        foreach ($line in $errors) { Write-Info "  $($line.Trim())" }
        if ($text -match 'CS1705') { Write-Note 'CS1705: o Studio traz uma biblioteca do .NET mais nova que a do SDK. A correcao fica em kernel\Directory.Build.targets e platforms\odc\studio\Directory.Build.targets; confira se esses arquivos existem neste checkout.' }
        if ($text -match 'MSB3027|MSB3021|being used by another process|sendo usado por outro processo') { Write-Note 'Uma DLL de saida esta em uso. Pare os workers deste checkout (python kernel\scripts\anvil_worker.py stop; python kernel\scripts\odc_worker.py stop) e rode de novo.' }
        if ($text -match 'NU1301|NU1101|Unable to load the service index') { Write-Note 'Sem acesso ao NuGet (rede ou proxy). O primeiro build baixa pacotes de nuget.org.' }
        Add-Result "Build: $($build.Name)" 'falha' ('veja ' + $LogFile) $run.Seconds
    }
    if ($DryRun -and $builds.Count) { Add-Result 'Build' 'simulado' (($builds | ForEach-Object { $_.Name }) -join ', ') }
    elseif ($builds.Count) { Write-Info "Tempo total de build: $(Format-Duration $buildSeconds)" }
}

# ---------------------------------------------------------------- 5. tenant, host e MCP
Write-Title '5/6 Tenant ODC, host O11 e MCP do Claude Code'
function Read-HostValue([string]$Label, [string]$Given, [string]$Existing, [string]$Example) {
    if ($Given) {
        $host_ = ConvertTo-HostName $Given
        if (-not $host_) { Write-Bad "$Label invalido: '$Given' (exemplo: $Example)."; return $Existing }
        return $host_
    }
    if ($Yes -or $DryRun) { return $Existing }
    for ($i = 0; $i -lt 3; $i++) {
        $keep = $(if ($Existing) { "Enter mantem $Existing" } else { 'Enter deixa sem valor' })
        try { $answer = Read-Host "   $Label (exemplo: $Example; $keep)" }
        catch { Write-Note 'Sem terminal interativo; passe -OdcTenant e -O11Host.'; return $Existing }
        if (-not $answer.Trim()) { return $Existing }
        $host_ = ConvertTo-HostName $answer
        if ($host_) { return $host_ }
        Write-Note "Isto nao parece um host: '$answer'."
    }
    return $Existing
}
if ($SkipMcp) { Write-Info 'Pulado (-SkipMcp).'; Add-Result 'Tenant/host e MCP' 'pulado' '-SkipMcp' }
else {
    # 5a. .ssam-local.json: lido pelo SSAM antes do tenants.json; fica fora do Git (.gitignore).
    $localFile = Join-Path $Root '.ssam-local.json'
    $existing = $null
    if (Test-Path -LiteralPath $localFile) {
        try { $existing = Get-Content -LiteralPath $localFile -Raw | ConvertFrom-Json } catch { Write-Note "$localFile esta invalido; vou reescreve-lo." }
    }
    $oldTenant = $(if ($existing) { $existing.odcTenant } else { $null })
    $oldHost = $(if ($existing) { $existing.o11Host } else { $null })
    $tenant = Read-HostValue 'Tenant ODC (o seu, sem valor padrao)' $OdcTenant $oldTenant 'minhaempresa.outsystems.dev'
    $o11 = Read-HostValue 'Host do ambiente O11 (o seu, sem valor padrao)' $O11Host $oldHost 'minhaempresa.outsystemscloud.com'
    $localStatus = 'ok'
    if (-not $tenant -and -not $o11 -and $DryRun) {
        Write-Plan 'perguntaria o tenant ODC e o host O11 desta pessoa (sem valor padrao) e gravaria .ssam-local.json'
    } elseif (-not $tenant -and -not $o11) {
        Write-Note 'Sem tenant ODC nem host O11: o SSAM usa o tenant padrao do repositorio (platforms\odc\tenants.json), que nao e o seu. Rode de novo com -OdcTenant e -O11Host.'
        $localStatus = 'aviso'
    } elseif ($tenant -eq $oldTenant -and $o11 -eq $oldHost -and $existing) {
        Write-Good "$localFile ja tem tenant ODC '$tenant' e host O11 '$o11'"
    } else {
        $content = [ordered]@{ schema = 'ssam-local/1'
            note = 'Valores desta maquina, fora do Git, escritos por scripts/setup-dev.ps1. O tenant ODC vira o padrao do SSAM neste checkout.'
            odcTenant = $tenant; o11Host = $o11 }
        if ($DryRun) { Write-Plan "gravaria $localFile com odcTenant=$tenant e o11Host=$o11" }
        else {
            [IO.File]::WriteAllText($localFile, ($content | ConvertTo-Json) + "`n", $Utf8)
            Write-Good "$localFile gravado (odcTenant=$tenant, o11Host=$o11)"
        }
    }

    # 5b. O .mcp.json versionado usa ${SSAM_NODE:-...} e ${SSAM_ROOT:-...}; o Claude Code expande essas variaveis.
    $mcpFile = Join-Path $Root '.mcp.json'
    $portable = $false
    $mcpStatus = $localStatus
    try {
        $mcp = Get-Content -LiteralPath $mcpFile -Raw | ConvertFrom-Json
        $server = $mcp.mcpServers.ssam
        $portable = ($server -and ($server.command -like '*${SSAM_NODE*') -and (@($server.args)[0] -like '*${SSAM_ROOT*'))
    } catch { Write-Note "Nao consegui ler $mcpFile." }
    function Expand-McpValue([string]$Text) {
        $result = ''; $last = 0
        foreach ($match in [regex]::Matches($Text, '\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}')) {
            $name = $match.Groups[1].Value
            # O que o Claude Code vai ver depois de reiniciado: variavel de usuario (ou o plano do passo 2, na simulacao).
            $value = $null
            if ($DryRun -and -not $NoUserEnv -and $plan.Contains($name)) { $value = $plan[$name] }
            if (-not $value) { $value = [Environment]::GetEnvironmentVariable($name, 'User') }
            if (-not $value) { $value = [Environment]::GetEnvironmentVariable($name, 'Machine') }
            if (-not $value) { $value = $(if ($match.Groups[2].Success) { $match.Groups[2].Value } else { $match.Value }) }
            $result += $Text.Substring($last, $match.Index - $last) + $value
            $last = $match.Index + $match.Length
        }
        return $result + $Text.Substring($last)
    }
    if ($portable) {
        $command = Expand-McpValue $server.command
        $entry = Expand-McpValue (@($server.args)[0])
        Write-Info "O .mcp.json do repositorio abre o servidor 'ssam' com: $command $entry mcp"
        if ($NoUserEnv) { Write-Note 'Com -NoUserEnv o Claude Code nao enxerga SSAM_NODE/SSAM_ROOT e usaria os caminhos padrao do arquivo.' ; $mcpStatus = 'aviso' }
        elseif ($DryRun) { Write-Plan 'depois do passo 2, o Claude Code passa a ler SSAM_NODE e SSAM_ROOT desta maquina' }
        elseif ((Test-Path -LiteralPath $command) -and (Test-Path -LiteralPath $entry)) { Write-Good 'Caminhos do MCP existem nesta maquina. Abra o Claude Code nesta pasta e aprove o servidor ssam.' }
        else { Write-Note 'Algum caminho do MCP nao existe. Confira SSAM_NODE e SSAM_ROOT (passo 2).'; $mcpStatus = 'aviso' }
        Write-Info "Os servidores 'ssam-headless-selected' e 'ssam-functional' do mesmo arquivo so funcionam no checkout operacional original; recuse-os."
    } else { Write-Note "$mcpFile nao usa SSAM_NODE/SSAM_ROOT (foi regenerado?). Ofereco registrar o ssam no escopo de usuario." }

    # 5c. Registro no escopo de usuario do Claude Code: opcional se o .mcp.json e portavel; nunca troca uma entrada existente sem perguntar.
    $claude = Get-Command claude.exe, claude.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    $userLane = $(if ($env:ANVIL_LANE) { $env:ANVIL_LANE } else { $Layout.o11Lane })
    $manual = "claude mcp add --env ANVIL_LANE=$userLane --scope user ssam -- `"$($env:SSAM_NODE)`" `"$Root\facade\ssam.mjs`" mcp"
    if ($node) { $manual = "claude mcp add --env ANVIL_LANE=$userLane --scope user ssam -- `"$($node.Path)`" `"$Root\facade\ssam.mjs`" mcp" }
    if (-not $claude) {
        Write-Info 'Claude Code (claude) nao esta no PATH. Para usar o ssam fora desta pasta, registre depois com:'
        Write-Info "  $manual"
    } elseif ($DryRun) {
        Write-Plan $(if ($portable) { "perguntaria se registra o ssam tambem no escopo de usuario: $manual" } else { "registraria: $manual" })
    } elseif (-not $node) {
        Write-Note 'Sem Node nao ha o que registrar.'
    } elseif (Confirm-Step $(if ($portable) { 'Registrar o ssam TAMBEM no escopo de usuario (disponivel em qualquer pasta)?' } else { 'Registrar o ssam no escopo de usuario do Claude Code?' }) (-not $portable)) {
        $get = Invoke-Tool $claude.Source @('mcp', 'get', 'ssam') -WorkingDirectory $env:USERPROFILE -TimeoutSeconds 120
        $add = @('mcp', 'add', '--env', "ANVIL_LANE=$userLane", '--scope', 'user', 'ssam', '--', $node.Path, (Join-Path $Root 'facade\ssam.mjs'), 'mcp')
        $doAdd = $true
        if ($get.ExitCode -eq 0) {
            Write-Info 'Ja existe um servidor ssam no Claude Code:'
            ($get.StdOut -split "`r?`n" | Where-Object { $_ } | Select-Object -First 8) | ForEach-Object { Write-Info "  $_" }
            if ($Yes) { Write-Note 'Com -Yes eu nao troco uma entrada ssam existente.'; $doAdd = $false }
            elseif (Confirm-Step 'Substituir a entrada ssam do escopo de usuario por esta pasta?' $false) {
                & $claude.Source mcp remove ssam --scope user
            } else { $doAdd = $false }
        }
        if ($doAdd) {
            & $claude.Source @add
            if ($LASTEXITCODE -eq 0) { Write-Good 'ssam registrado no escopo de usuario.' } else { Write-Note "claude mcp add terminou com codigo $LASTEXITCODE. Comando manual: $manual"; $mcpStatus = 'aviso' }
        }
    }
    Add-Result 'Tenant/host e MCP' $(if ($DryRun) { 'simulado' } else { $mcpStatus }) ("odcTenant=$tenant; o11Host=$o11; .mcp.json " + $(if ($portable) { 'portavel' } else { 'nao portavel' }))
}

# ---------------------------------------------------------------- 6. doctor
Write-Title '6/6 Doctor'
if ($SkipDoctor) { Write-Info 'Pulado (-SkipDoctor).'; Add-Result 'Doctor' 'pulado' '-SkipDoctor' }
elseif (-not $node) { Write-Note 'Sem Node, sem doctor.'; Add-Result 'Doctor' 'pulado' 'sem Node' }
elseif ($DryRun) { Write-Plan "rodaria: `"$($node.Path)`" `"$Root\facade\ssam.mjs`" doctor"; Add-Result 'Doctor' 'simulado' '' }
else {
    $run = Invoke-Tool $node.Path @((Join-Path $Root 'facade\ssam.mjs'), 'doctor') -TimeoutSeconds 600
    $report = $null
    $start = $run.StdOut.IndexOf('{')
    if ($start -ge 0) { try { $report = $run.StdOut.Substring($start) | ConvertFrom-Json } catch { $report = $null } }
    if (-not $report) {
        Write-Bad "O doctor nao respondeu JSON (codigo $($run.ExitCode))."
        (($run.StdOut + $run.StdErr) -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 8) | ForEach-Object { Write-Info "  $_" }
        Add-Result 'Doctor' 'falha' 'sem resposta JSON' $run.Seconds
    } else {
        $o11Lane = $report.lanes.o11
        if ($o11Lane) {
            $state = $(if ($o11Lane.studio.connected) { 'conectado' } elseif ($o11Lane.studio.open) { 'aberto, nao conectado' } else { 'fechado' })
            Write-Info ("O11: CLI " + $(if ($o11Lane.cli.built) { 'compilada' } else { 'NAO compilada' }) + "; Service Studio $state")
            if ($o11Lane.hint) { Write-Info "     dica: $($o11Lane.hint)" }
        }
        $odcLane = $report.lanes.odc
        if ($odcLane) {
            $checks = @($odcLane.doctor.checks)
            $failing = @($checks | Where-Object { $_.ok -eq $false })
            Write-Info ("ODC: " + ($checks.Count - $failing.Count) + " de " + $checks.Count + " verificacoes ok")
            foreach ($check in $failing) { Write-Info ("     falta: " + $check.name + $(if ($check.hint) { " (" + $check.hint + ")" } else { '' })) }
        }
        if ($report.local) { Write-Info "Local: tenant ODC $($report.local.odcTenant), host O11 $($report.local.o11Host)" }
        Write-Info 'Antes de abrir e conectar um Studio, o doctor nao fica 100% verde; isso e esperado.'
        Add-Result 'Doctor' $(if ($report.ok) { 'ok' } else { 'aviso' }) ('ok=' + $report.ok + ' (esperado false antes do connect)') $run.Seconds
    }
}

# ---------------------------------------------------------------- resumo
$total.Stop()
Write-Title 'Resumo'
$Results | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host
Write-Info "Tempo total: $(Format-Duration $total.Elapsed.TotalSeconds)"
if ($LogFile) { Write-Info "Registro detalhado: $LogFile" }
Write-Host ''
Write-Host 'Proximos passos' -ForegroundColor Cyan
Write-Info '1. Abra um terminal NOVO (para ler as variaveis gravadas) e reinicie o Claude Code, se ele estiver aberto.'
Write-Info '2. Abra o Service Studio e/ou o ODC Studio normalmente, pelo atalho de sempre, e faca login.'
Write-Info "3. Na pasta $Root, conecte cada Studio aberto:"
Write-Info '     .\ssam connect --lane o11      (Service Studio)'
Write-Info '     .\ssam connect --lane odc      (ODC Studio)'
Write-Info '4. Confira com .\ssam doctor. Leia COMECE-AQUI.md se algo falhar.'
$failed = @($Results | Where-Object { $_.Resultado -eq 'falha' }).Count
if ($failed -gt 0) { exit 1 }
exit 0
