# Pacote do agente SSAM para a maquina do cliente (fase 2: docs\FASE2-AGENTE.md 9.4; fase 3: docs\O11-BRIDGE-FINA.md 6;
# guia docs\AGENTE-CLIENTE.md).
#   .\scripts\agent-pack.ps1 -Out C:\caminho\ssam-agent.zip [-Lanes odc,o11] [-NodeExe <node.exe>] [-NodeLicense <arquivo>]
#                            [-NoNode] [-NoBuild -Prebuilt <pasta>] [-OdcRuntime net8.0|net10.0]
# Monta a arvore da secao 6.2 numa pasta temporaria, escreve pack.json (id, faixas, versoes e sha256 de cada arquivo),
# compacta e passa o ZIP pela varredura de propriedade intelectual (scripts\pack-ip-scan.ps1): com achado, apaga o ZIP e
# para. Nunca leva fontes (.cs, .csproj), outros .mjs alem de agent\, .local\server, chaves, credenciais nem DLLs da
# OutSystems.
#   ODC: a bridge e o cliente da selecao assinada (platforms\odc\.local\signed-runtime) quando existe; senao os de
#        platforms\odc\studio\bridge\...\bin\Release (compilados antes, por scripts\setup-dev.ps1).
#   O11 (so com o11 em -Lanes): compila a bridge FINA (kernel\src\Anvil.Bridge.Thin, assembly Anvil.Bridge, sem o kernel)
#        contra o Service Studio do kernel do servidor (SSDir), o Anvil.RuntimeHook como Anvil.RuntimeHook.Agent e o
#        Anvil.Connect. bin\o11\bridge leva so Anvil.Bridge.dll (+ .deps.json).
#   Node: por padrao copia o node.exe de Get-Node (ou de -NodeExe) para agent\node\node.exe, SEMPRE com a licenca dele
#        em agent\node\LICENSE (-NodeLicense; senao LICENSE na pasta do node.exe ou na pasta acima; sem nenhum, recusa).
#        -NoNode deixa os dois de fora (o cliente precisa entao do Node 24).
#   -NoBuild -Prebuilt <pasta>: binarios ja prontos, nada compilado (modo dos testes), no layout
#        <pasta>\odc\bridge\ODC3.Bridge.v<N>.dll (+ .deps.json)   <pasta>\odc\client\ODC3.Bridge.Client.dll (+ deps)
#        <pasta>\o11\connect\   <pasta>\o11\hook\   <pasta>\o11\bridge\ (a fina)   <pasta>\o11\built-for.txt (ex.: 11.55.91)
#   -O11Studios <pasta>,<pasta>,... (agente 0.3.7 / 0.4.4-native): uma fina POR versao do Service Studio, cada uma compilada
#        contra a pasta daquela versao (a pasta do Service Studio instalado, ou files\ de um bundle de C:\t\studio-bundles); a
#        versao vem do ServiceStudio.exe (ou do ServiceStudio.Common.dll) e o runtime do runtimeconfig (ou do System.Runtime que
#        o ServiceStudio.Common.dll referencia). A mais nova vai em bin\o11\bridge (o padrao: o11BuiltFor e o11Bridge, o que o
#        agente antigo le); as outras em bin\o11\bridges\<x.y.z>. pack.json o11Builds lista todas; o agente escolhe a do Service
#        Studio que o cliente tem. Com -Prebuilt, o mesmo vem de <pasta>\o11\builds\<x.y.z>\Anvil.Bridge.dll (+ .deps.json).
#        So com o gancho dev.
#   -NoBridgeOffer: pack.json bridgeOffer false, o pacote do app de teste sem as ancoras (o agente nunca pede oferta de bridge).
#   -ExpectO11 <x.y.z> (imagem interina, desenho multiversao O.6.1): a fina sai compilada contra a pasta do Service Studio
#        daquela versao (ANVIL_STUDIO_DIR, nunca a copia de faixa 'Service Studio 11 - Anvil ...'), ou o script para. O
#        servidor so aceita o pacote cujo o11BuiltFor e a versao do kernel dele (AGENT_PACK_MISMATCH).
#   Gancho O11 (-Hook, docs\O11-BRIDGE-FINA.md 13):
#     dev (padrao)  o gancho de desenvolvimento compilado do fonte: bin\o11\hook\Anvil.RuntimeHook.Agent.dll e a fina em
#                   bin\o11\bridge\.
#     h1            o gancho de release Anvil.Hook.h1 (-HookH1 <pasta>, compilado pela linha de release numa staging
#                   tecida; este script nunca o compila) e a fina em studio\o11\bridge\b1\, com release.json na raiz. O
#                   gancho so carrega a fina se release.sig.jws (assinado pelo intermediario "release" do publicador)
#                   listar cada arquivo dela com tamanho e sha256. Por isso o pacote h1 sai em dois passos:
#                     1. -Hook h1 -HookH1 <pasta> -Stage <pasta nova>: monta a arvore sem assinatura e para;
#                     2. o dono assina essa pasta (servidor MCP do publicador: release_sign {releaseDir:<pasta>});
#                     3. -FromStage <pasta> -Out <zip>: confere que release.sig.jws cobre cada arquivo da arvore (tamanho e
#                        sha256; a assinatura e conferida pelo gancho, com as raizes compiladas nele), compacta e varre.
#   -Platform mac (docs\AGENTE-MAC.md): o pacote do macOS, ssam-agent-mac.tar.gz, com os MESMOS binarios (bridge ODC, gancho
#        e fina O11) e sem nenhum .exe: sem node.exe (o install.sh acha ou baixa o Node 24 de nodejs.org e confere o sha256
#        de scripts\node-darwin.json, copiado no pack.json como node), sem o cliente ODC e sem o Anvil.Connect (no macOS o
#        agente fala o IPC de diagnostico do .NET), com agent\ssam-agent.sh no lugar do .ps1, install.sh na raiz e
#        docs\AGENTE-MAC.md. O pack.json diz platform darwin e nao tem valores nulos (o install.sh le com plutil). O tar.gz
#        sai de scripts\tar-gz.mjs (modo 0755 nos .sh), e lido de volta e conferido, e a arvore lida de volta passa pela
#        mesma varredura de PI (num ZIP temporario, pack-ip-scan.ps1 -Zip sem mudanca). So -Hook dev; -Out termina em .tar.gz.
param(
  [string]$Out,
  [string]$Lanes = 'odc,o11',
  [string]$NodeExe,
  [string]$NodeLicense,
  [switch]$NoNode,
  [switch]$NoBuild,
  [string]$Prebuilt,
  [ValidateSet('dev', 'h1')][string]$Hook = 'dev',
  [string]$HookH1,
  [string]$ReleaseVersion,
  [string]$Stage,
  [string]$FromStage,
  [string]$ExpectO11,
  [ValidateSet('windows', 'mac')][string]$Platform = 'windows',
  # The ODC Studio runtime of the pack's one ODC bridge (agent/r4-v106): net8.0 (default) takes the bridge the client names
  # EarlierVersion (v107, which also loads in a net10 Studio) from bin\Release\net8.0; net10.0 takes Version (v106) from
  # bin\Release\net10.0. With -Prebuilt the runtime is the one of the bridge's .deps.json, and a different -OdcRuntime refuses.
  [ValidateSet('net8.0', 'net10.0')][string]$OdcRuntime,
  # One thin bridge per Service Studio version (see the header): the Studio folders to compile against.
  [string[]]$O11Studios,
  [switch]$NoBridgeOffer,
  # F4 of PLANO-11H (kind o11.xif): the built Integration Studio engine host of the server line (kernel\src\Anvil.Xif.Engine, net472
  # x86, Authenticode-signed for a release), copied to xif-engine\Anvil.Xif.Engine.exe with its .config; pack.json names it in
  # xifEngine {path, sha256}. Without it the agent does not list o11.xif in its hello. Windows only; no OutSystems binary.
  [string]$XifEngine
)
$ErrorActionPreference = 'Stop'
$mac = $Platform -eq 'mac'
if ($mac) {
  if ($Hook -ne 'dev' -or $HookH1 -or $ReleaseVersion -or $Stage -or $FromStage) { throw '-Platform mac so monta o pacote com o gancho dev (sem -Hook h1, -Stage nem -FromStage).' }
  if ($NodeExe -or $NodeLicense) { throw '-Platform mac nao leva node.exe: o install.sh acha ou baixa o Node 24 (scripts\node-darwin.json).' }
  if ($Out -and $Out -notmatch '\.tar\.gz$') { throw '-Platform mac escreve um .tar.gz: use -Out <pasta>\ssam-agent-mac.tar.gz' }
  $NoNode = [switch]$true
}
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$laneList = @($Lanes -split '[,\s]+' | Where-Object { $_ })
if ($laneList.Count -eq 0) { throw 'Nenhuma faixa: use -Lanes odc,o11.' }
foreach ($lane in $laneList) { if (@('odc', 'o11') -notcontains $lane) { throw "Faixa desconhecida: $lane (use odc e/ou o11)." } }
if ($FromStage) {
  if ($Stage -or $Prebuilt -or $NoBuild -or $NodeExe -or $NodeLicense -or $NoNode -or $HookH1 -or $Hook -ne 'dev' -or $ReleaseVersion -or $PSBoundParameters.ContainsKey('Lanes')) { throw '-FromStage so combina com -Out: a arvore assinada ja esta pronta.' }
  if (-not (Test-Path -LiteralPath $FromStage -PathType Container)) { throw "A pasta -FromStage nao existe: $FromStage" }
}
if (-not $Out -and -not $Stage) { throw 'Use -Out <zip> (ou -Stage <pasta> com -Hook h1).' }
if ($Stage -and $Out) { throw '-Stage para antes do ZIP: nao combina com -Out (o ZIP sai depois, com -FromStage).' }
if ($Stage -and $Hook -ne 'h1') { throw '-Stage e o primeiro passo do pacote com -Hook h1.' }
if ($Hook -eq 'h1') {
  if ($laneList -notcontains 'o11') { throw '-Hook h1 e o gancho da faixa o11: inclua o11 em -Lanes.' }
  if (-not $HookH1) { throw '-Hook h1 exige -HookH1 <pasta com Anvil.Hook.h1.dll> (gancho de release compilado numa staging tecida).' }
  if (-not (Test-Path -LiteralPath (Join-Path $HookH1 'Anvil.Hook.h1.dll') -PathType Leaf)) { throw "Falta Anvil.Hook.h1.dll em $HookH1" }
  if (-not $Stage) { throw "O pacote com o gancho h1 precisa da assinatura do publicador: use -Stage <pasta>, assine-a com release_sign {releaseDir:<pasta>} e depois rode -FromStage <pasta> -Out <zip>." }
  if ((Test-Path -LiteralPath $Stage) -and @(Get-ChildItem -LiteralPath $Stage -Force).Count -gt 0) { throw "A pasta -Stage tem de ser nova ou vazia: $Stage" }
  if (-not $ReleaseVersion) { $ReleaseVersion = (Get-Date).ToUniversalTime().ToString('yyyy.M.d') + '-pack.' + (Get-Date).ToUniversalTime().ToString('HHmmss') }
  if ($ReleaseVersion -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$') { throw "-ReleaseVersion tem de ser A.M.N ou A.M.N-<rotulo>: $ReleaseVersion" }
} elseif ($HookH1 -or $ReleaseVersion) { throw '-HookH1 e -ReleaseVersion so valem com -Hook h1.' }
if ($NoBuild -and -not $Prebuilt) { throw '-NoBuild exige -Prebuilt <pasta>.' }
if ($O11Studios) {
  if ($laneList -notcontains 'o11') { throw '-O11Studios e da faixa o11: inclua o11 em -Lanes.' }
  if ($Hook -ne 'dev' -or $mac) { throw '-O11Studios so vale com o gancho dev no Windows.' }
  if ($Prebuilt) { throw '-O11Studios compila as finas; com -Prebuilt use <pasta>\o11\builds\<x.y.z>.' }
  if ($ExpectO11) { throw '-O11Studios ja diz as versoes: nao combina com -ExpectO11.' }
}
if ($Prebuilt -and -not (Test-Path -LiteralPath $Prebuilt)) { throw "A pasta -Prebuilt nao existe: $Prebuilt" }
if ($NodeExe -and -not (Test-Path -LiteralPath $NodeExe)) { throw "-NodeExe nao existe: $NodeExe" }
if ($NodeLicense -and -not (Test-Path -LiteralPath $NodeLicense -PathType Leaf)) { throw "-NodeLicense nao existe: $NodeLicense" }
if ($NoNode -and ($NodeExe -or $NodeLicense)) { throw '-NoNode nao combina com -NodeExe nem com -NodeLicense.' }

$utf8 = New-Object Text.UTF8Encoding $false
$work = Join-Path ([IO.Path]::GetTempPath()) ('ssam-agent-pack-' + [guid]::NewGuid().ToString('N'))
$tree = Join-Path $work 'tree'

# What never goes into a pack, whatever a source folder holds.
function Test-Forbidden([string]$relative) {
  $r = $relative -replace '/', '\'
  if ($r -match '\.(cs|csproj|sln|pdb|key|pfx|snk)$') { return $true }
  if ($r -match '(^|\\)\.local(\\|$)') { return $true }
  if ($r -match '(^|\\)(credential[^\\]*|tokens\.json|[^\\]*\.credentials\.json|config\.json)$') { return $true }
  if ($r -match '(^|\\)(OutSystems\.[^\\]*|ServiceStudio[^\\]*)\.(dll|exe)$') { return $true }
  return $false
}

function Copy-Folder([string]$from, [string]$to) {
  if (-not (Test-Path -LiteralPath $from)) { throw "Falta a pasta $from" }
  New-Item -ItemType Directory -Force $to | Out-Null
  $base = (Resolve-Path -LiteralPath $from).Path.TrimEnd('\')
  foreach ($file in Get-ChildItem -LiteralPath $base -Recurse -File -Force) {
    $rel = $file.FullName.Substring($base.Length + 1)
    if (Test-Forbidden $rel) { Write-Warning "Fora do pacote: $rel"; continue }
    $dest = Join-Path $to $rel
    New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $dest
  }
}

function Get-Sha256([string]$file) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }

# The Service Studio version (x.y.z) and .NET runtime of a Studio folder, read from its files only (install-agnostic: an
# installed Studio or the files\ of a pinned bundle). Version: ServiceStudio.exe, else ServiceStudio.Common.dll. Runtime: the
# tfm of ServiceStudio.runtimeconfig.json, else the System.Runtime version that ServiceStudio.Common.dll references.
function Get-StudioBuild([string]$dir) {
  $common = Join-Path $dir 'ServiceStudio.Common.dll'
  if (-not (Test-Path -LiteralPath $common)) { throw "Nao e uma pasta do Service Studio (falta ServiceStudio.Common.dll): $dir" }
  $exe = Join-Path $dir 'ServiceStudio.exe'
  $info = $(if (Test-Path -LiteralPath $exe) { (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion } else { (Get-Item -LiteralPath $common).VersionInfo.ProductVersion })
  $version = [regex]::Match([string]$info, '^\d+\.\d+\.\d+').Value
  if (-not $version) { throw "Versao do Service Studio ilegivel em $dir" }
  $runtime = $null
  $config = Join-Path $dir 'ServiceStudio.runtimeconfig.json'
  if (Test-Path -LiteralPath $config) { $runtime = [string](Get-Content -LiteralPath $config -Raw | ConvertFrom-Json).runtimeOptions.tfm }
  if ($runtime -notmatch '^net\d+\.\d+$') {
    $script = "`$a = [Reflection.Assembly]::ReflectionOnlyLoadFrom('$($common -replace "'", "''")'); (`$a.GetReferencedAssemblies() | Where-Object Name -eq 'System.Runtime' | Select-Object -First 1).Version.Major"
    $major = & powershell -NoProfile -NonInteractive -Command $script
    if ([string]$major -notmatch '^\d+$') { throw "Runtime do Service Studio ilegivel em $dir" }
    $runtime = "net$major.0"
  }
  return [pscustomobject]@{ Version = $version; Runtime = $runtime; Dir = $dir }
}

# The runtime of a built bridge, from its .deps.json (net8.0 when it has none).
function Get-BridgeRuntime([string]$folder) {
  $deps = Join-Path $folder 'Anvil.Bridge.deps.json'
  if (-not (Test-Path -LiteralPath $deps)) { return 'net8.0' }
  $m = [regex]::Match([string](Get-Content -LiteralPath $deps -Raw | ConvertFrom-Json).runtimeTarget.name, 'Version=v(\d+\.\d+)')
  if ($m.Success) { return 'net' + $m.Groups[1].Value } else { return 'net8.0' }
}

function Get-Node {
  $candidates = @($env:SSAM_NODE, (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'Node nao encontrado: defina SSAM_NODE ou rode scripts\setup-dev.ps1.'
}

# The Service Studio of the server's O11 kernel (o11LaneOf().studioDir): the bridge must be built against it.
function Get-KernelStudio {
  if ($env:ANVIL_STUDIO_DIR) { return $env:ANVIL_STUDIO_DIR }
  $lane = (Join-Path $root 'platforms\odc\facade\o11-lane.mjs') -replace '\\', '/'
  $workspace = (Join-Path $root 'platforms\odc\facade\workspace.mjs') -replace '\\', '/'
  $js = "const { pathToFileURL } = await import('node:url'); const l = await import(pathToFileURL('$lane').href); const w = await import(pathToFileURL('$workspace').href); console.log(l.o11LaneOf(w.o11Lane.lane).studioDir);"
  $dir = & (Get-Node) --input-type=module -e $js
  if ($LASTEXITCODE -ne 0 -or -not $dir) { throw 'Nao consegui calcular o Service Studio do kernel; defina ANVIL_STUDIO_DIR.' }
  return ($dir | Select-Object -Last 1).Trim()
}

function Invoke-Build([string]$project, [string]$out, [string[]]$extra, [string]$name) {
  $arguments = @('build', (Join-Path $root $project), '-c', 'Release', '--nologo', '-v', 'minimal', '--artifacts-path', (Join-Path $work ('artifacts\' + $name)), '-o', $out) + $extra
  & dotnet @arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "dotnet build falhou: $project" }
}


# Zips a finished tree (entries one by one with '/' separators: ZipFile.CreateFromDirectory of Windows PowerShell writes
# '\'), then the intellectual property scan of the ZIP (docs\O11-BRIDGE-FINA.md 6.4): any finding deletes the ZIP.
function Write-PackZip([string]$base, [string]$out, [string]$id, [string[]]$lanes) {
  $target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($out)
  New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  $count = 0
  $zip = [IO.Compression.ZipFile]::Open($target, 'Create')
  try {
    foreach ($file in Get-ChildItem -LiteralPath $base -Recurse -File -Force | Sort-Object FullName) {
      $name = $file.FullName.Substring($base.Length + 1) -replace '\\', '/'
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $name, 'Optimal')
      $count++
    }
  } finally { $zip.Dispose() }
  try { $report = ((& (Join-Path $PSScriptRoot 'pack-ip-scan.ps1') -Zip $target) -join "`n") | ConvertFrom-Json }
  catch { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue; throw "Varredura de PI falhou: $($_.Exception.Message)" }
  foreach ($item in @($report.allowed | Where-Object { $_ })) {
    Write-Warning ("Excecao conhecida no pacote: {0} ({1}: {2}; {3})" -f $item.entry, $item.rule, $item.detail, $item.why)
  }
  if ($report.ok -ne $true) {
    Remove-Item -LiteralPath $target -Force
    $failed = @($report.findings | Where-Object { $_ } | ForEach-Object { '{0} ({1})' -f $_.entry, $_.rule } | Select-Object -Unique)
    throw ('Varredura de PI falhou: ' + ($failed -join '; '))
  }
  Write-Output ("Pacote {0}: {1} ({2} arquivos, faixas {3})" -f $id, $target, $count, ($lanes -join ','))
}

# -Platform mac: the tar.gz of scripts\tar-gz.mjs (Unix modes: 0755 for the .sh), read back and compared with the tree,
# then the tree READ BACK from the tar.gz goes through the same intellectual property scan (a temporary ZIP of it and
# pack-ip-scan.ps1 -Zip, unchanged): any finding deletes the tar.gz.
function Write-PackTar([string]$base, [string]$out, [string]$id, [string[]]$lanes) {
  $target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($out)
  New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  $node = Get-Node
  $tarScript = Join-Path $PSScriptRoot 'tar-gz.mjs'
  $mtime = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
  & $node $tarScript write $base $target $mtime
  if ($LASTEXITCODE -ne 0) { throw "tar-gz.mjs write falhou: $target" }
  $verified = (& $node $tarScript verify $target $base) -join "`n"
  if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue; throw "O tar.gz lido de volta nao confere com a arvore: $verified" }
  $back = Join-Path $work 'read-back'
  & $node $tarScript extract $target $back
  if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue; throw "tar-gz.mjs extract falhou: $target" }
  $scanZip = Join-Path $work 'scan.zip'
  $count = 0
  $zip = [IO.Compression.ZipFile]::Open($scanZip, 'Create')
  try {
    foreach ($file in Get-ChildItem -LiteralPath $back -Recurse -File -Force | Sort-Object FullName) {
      $name = $file.FullName.Substring($back.Length + 1) -replace '\\', '/'
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $name, 'Optimal')
      $count++
    }
  } finally { $zip.Dispose() }
  try { $report = ((& (Join-Path $PSScriptRoot 'pack-ip-scan.ps1') -Zip $scanZip) -join "`n") | ConvertFrom-Json }
  catch { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue; throw "Varredura de PI falhou: $($_.Exception.Message)" }
  foreach ($item in @($report.allowed | Where-Object { $_ })) {
    Write-Warning ("Excecao conhecida no pacote: {0} ({1}: {2}; {3})" -f $item.entry, $item.rule, $item.detail, $item.why)
  }
  if ($report.ok -ne $true) {
    Remove-Item -LiteralPath $target -Force
    $failed = @($report.findings | Where-Object { $_ } | ForEach-Object { '{0} ({1})' -f $_.entry, $_.rule } | Select-Object -Unique)
    throw ('Varredura de PI falhou: ' + ($failed -join '; '))
  }
  Write-Output ("Pacote {0}: {1} ({2} arquivos, faixas {3}, macOS)" -f $id, $target, $count, ($lanes -join ','))
}

function ConvertFrom-Base64Url([string]$text) {
  $b64 = $text.Replace('-', '+').Replace('_', '/')
  switch ($b64.Length % 4) { 2 { $b64 += '==' } 3 { $b64 += '=' } 1 { throw 'base64url invalido' } }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
}

# The signed tree of an h1 pack (-FromStage): pack.json says o11Hook h1, release.json has the version, and
# release.sig.jws is a compact JWS whose payload {typ:"ssam-release/1", version, files:[{path, size, sha256}]} lists
# exactly the files of the tree (release.sig.jws apart) with their size and sha256. The signature itself is checked by
# the hook h1 before it loads the bridge (Ssam.Lic.Release, with the roots compiled into it); here a tree changed after
# signing, or signed before it was complete, is refused before any ZIP exists. Returns pack.json.
function Test-SignedTree([string]$base) {
  $packFile = Join-Path $base 'pack.json'
  if (-not (Test-Path -LiteralPath $packFile)) { throw "Falta pack.json em $base (a arvore vem de -Hook h1 -Stage)." }
  $packInfo = Get-Content -LiteralPath $packFile -Raw | ConvertFrom-Json
  if ($packInfo.o11Hook -ne 'h1') { throw "pack.json de $base nao e de um pacote com o gancho h1." }
  $releaseInfo = Get-Content -LiteralPath (Join-Path $base 'release.json') -Raw | ConvertFrom-Json
  $signature = Join-Path $base 'release.sig.jws'
  if (-not (Test-Path -LiteralPath $signature)) { throw "Falta release.sig.jws em ${base}: assine a pasta com release_sign {releaseDir:'$base'} (servidor MCP do publicador)." }
  $parts = (Get-Content -LiteralPath $signature -Raw).Trim().Split('.')
  if ($parts.Count -ne 3) { throw 'release.sig.jws nao e um JWS compacto.' }
  try { $header = ConvertFrom-Base64Url $parts[0] | ConvertFrom-Json; $payload = ConvertFrom-Base64Url $parts[1] | ConvertFrom-Json }
  catch { throw "release.sig.jws ilegivel: $($_.Exception.Message)" }
  if ($header.typ -ne 'ssam-release/1' -or $payload.typ -ne 'ssam-release/1') { throw 'release.sig.jws nao e um manifesto ssam-release/1.' }
  if ($payload.version -ne $releaseInfo.version) { throw "release.sig.jws assina a versao $($payload.version); release.json diz $($releaseInfo.version)." }
  $listed = @{}
  foreach ($entry in @($payload.files)) { $listed[[string]$entry.path] = $entry }
  $onDisk = @{}
  foreach ($file in Get-ChildItem -LiteralPath $base -Recurse -File -Force) {
    $rel = $file.FullName.Substring($base.Length + 1)
    if ($rel -ieq 'release.sig.jws') { continue }
    if ((Test-Forbidden $rel) -or ($rel -match '\.(mjs|js)$' -and $rel -notmatch '^agent\\')) { throw "Arquivo proibido no pacote: $rel" }
    $key = $rel -replace '\\', '/'
    $onDisk[$key] = $true
    $entry = $listed[$key]
    if (-not $entry) { throw "release.sig.jws nao lista $key (arquivo acrescentado depois da assinatura?)." }
    if ([int64]$entry.size -ne $file.Length -or [string]$entry.sha256 -ne (Get-Sha256 $file.FullName)) { throw "release.sig.jws nao confere com $key (alterado depois da assinatura)." }
  }
  foreach ($key in $listed.Keys) { if (-not $onDisk.ContainsKey($key)) { throw "release.sig.jws lista $key, que nao esta na arvore." } }
  return $packInfo
}

if ($FromStage) {
  $signedBase = (Resolve-Path -LiteralPath $FromStage).Path.TrimEnd('\')
  $signedPack = Test-SignedTree $signedBase
  Write-PackZip $signedBase $Out $signedPack.id @($signedPack.lanes)
  return
}
# node.exe goes only with its license (MIT asks for the notice beside the binary): -NodeLicense, else LICENSE in the
# node.exe folder or the folder above. Decided before anything is built or written.
$nodeSource = $null
$nodeLicenseSource = $null
if (-not $NoNode) {
  $nodeSource = $(if ($NodeExe) { (Resolve-Path -LiteralPath $NodeExe).Path } else { Get-Node })
  $nodeDir = Split-Path -Parent $nodeSource
  $nodeLicenseSource = $(if ($NodeLicense) { (Resolve-Path -LiteralPath $NodeLicense).Path } else {
      @((Join-Path $nodeDir 'LICENSE'), (Join-Path (Split-Path -Parent $nodeDir) 'LICENSE')) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1 })
  if (-not $nodeLicenseSource) { throw "Falta a licen$([char]0xE7)a do Node (LICENSE) para ${nodeSource}: use -NodeLicense <arquivo> ou -NoNode" }
}

try {
  New-Item -ItemType Directory -Force $tree | Out-Null

  # Agent code: ssam-agent.mjs, ssam-agent.ps1, lib\*.mjs and the data they read, lib\*.json (never the tests).
  $agentOut = Join-Path $tree 'agent'
  New-Item -ItemType Directory -Force (Join-Path $agentOut 'lib') | Out-Null
  # macOS: ssam-agent.sh in place of the .ps1, and install.sh at the root of the pack.
  $launcher = $(if ($mac) { 'agent\ssam-agent.sh' } else { 'agent\ssam-agent.ps1' })
  Copy-Item -LiteralPath (Join-Path $root 'agent\ssam-agent.mjs'), (Join-Path $root $launcher) -Destination $agentOut
  Copy-Item -Path (Join-Path $root 'agent\lib\*.mjs') -Destination (Join-Path $agentOut 'lib')
  Copy-Item -Path (Join-Path $root 'agent\lib\*.json') -Destination (Join-Path $agentOut 'lib')
  # The vault helper of o11.users is Windows only: a macOS pack carries no .ps1, and its agent answers USERS_PLATFORM_UNAVAILABLE.
  if (-not $mac) { Copy-Item -LiteralPath (Join-Path $root 'agent\lib\users-vault.ps1') -Destination (Join-Path $agentOut 'lib') }
  $xifEngineEntry = $null
  if ($XifEngine) {
    if ($mac) { throw '-XifEngine is Windows only (Integration Studio runs only on Windows).' }
    if ((Split-Path -Leaf $XifEngine) -ne 'Anvil.Xif.Engine.exe' -or -not (Test-Path -LiteralPath $XifEngine -PathType Leaf)) { throw "-XifEngine must be an existing Anvil.Xif.Engine.exe: $XifEngine" }
    $engineDir = Join-Path $tree 'xif-engine'
    New-Item -ItemType Directory -Force $engineDir | Out-Null
    Copy-Item -LiteralPath $XifEngine -Destination $engineDir
    if (Test-Path -LiteralPath ($XifEngine + '.config')) { Copy-Item -LiteralPath ($XifEngine + '.config') -Destination $engineDir }
    $xifEngineEntry = [ordered]@{ path = 'xif-engine/Anvil.Xif.Engine.exe'; sha256 = (Get-Sha256 (Join-Path $engineDir 'Anvil.Xif.Engine.exe')) }
  }
  if ($mac) {
    Copy-Item -LiteralPath (Join-Path $root 'agent\install.sh') -Destination (Join-Path $tree 'install.sh')
    # bash on macOS stops at a CR: the scripts go with LF only (the box's .gitattributes says eol=lf).
    foreach ($sh in (Join-Path $tree 'install.sh'), (Join-Path $agentOut 'ssam-agent.sh')) {
      if ([IO.File]::ReadAllText($sh).Contains("`r")) { throw "Fim de linha CR em ${sh}: o bash do macOS nao roda o script." }
    }
  }
  # The customer guide (English), which the agent, its script and the server hints cite as docs\AGENTE-CLIENTE.md.
  New-Item -ItemType Directory -Force (Join-Path $tree 'docs') | Out-Null
  Copy-Item -LiteralPath (Join-Path $root 'docs\AGENTE-CLIENTE.md') -Destination (Join-Path $tree 'docs\AGENTE-CLIENTE.md')
  if ($mac) { Copy-Item -LiteralPath (Join-Path $root 'docs\AGENTE-MAC.md') -Destination (Join-Path $tree 'docs\AGENTE-MAC.md') }
  if ($nodeSource) {
    New-Item -ItemType Directory -Force (Join-Path $agentOut 'node') | Out-Null
    Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $agentOut 'node\node.exe')
    Copy-Item -LiteralPath $nodeLicenseSource -Destination (Join-Path $agentOut 'node\LICENSE')
  }

  $odcBridge = $null
  $odcRuntimeOfPack = $null
  $signedRuntime = $null
  $o11Bridge = $null
  $o11BuiltFor = $null
  $o11Builds = $null
  if ($laneList -contains 'odc') {
    $odcRoot = Join-Path $root 'platforms\odc'
    if ($Prebuilt) {
      $bridgeFrom = Join-Path $Prebuilt 'odc\bridge'
      $clientFrom = Join-Path $Prebuilt 'odc\client'
    } else {
      $selected = Join-Path $odcRoot '.local\signed-runtime\selected.json'
      if (Test-Path -LiteralPath $selected) {
        # The verified, signed copy: every listed file must still have its hash (as signed-runtime.mjs checks).
        $selection = Get-Content -LiteralPath $selected -Raw | ConvertFrom-Json
        $signed = Join-Path (Split-Path -Parent $selected) $selection.id
        $verified = Get-Content -LiteralPath (Join-Path $signed 'verified.json') -Raw | ConvertFrom-Json
        foreach ($entry in $verified.files) {
          if ((Get-Sha256 (Join-Path $signed $entry.path)) -ne $entry.sha256) { throw "Selecao assinada alterada: $($entry.path)" }
        }
        $bridgeFrom = Join-Path $signed 'bridge'
        $clientFrom = Join-Path $signed 'client'
        # The runtime the bundle was prepared for (odc-runtime-signing.ps1 -Runtime; none before agent/r4-v106).
        $prepared = Get-Content -LiteralPath (Join-Path $signed 'prepared.json') -Raw | ConvertFrom-Json
        $signedRuntime = $(if ($prepared.PSObject.Properties['runtime']) { [string]$prepared.runtime } else { $null })
        if ($OdcRuntime -and $signedRuntime -and $OdcRuntime -ne $signedRuntime) { throw "A selecao assinada e da bridge $signedRuntime, nao de -OdcRuntime $OdcRuntime." }
      } else {
        $bridgeFrom = Join-Path $odcRoot ('studio\bridge\bin\Release\' + $(if ($OdcRuntime) { $OdcRuntime } else { 'net8.0' }))
        $clientFrom = Join-Path $odcRoot 'studio\bridge\client\bin\Release\net10.0'
      }
    }
    if (-not $Prebuilt -and -not (Test-Path -LiteralPath (Join-Path $odcRoot '.local\signed-runtime\selected.json'))) {
      # Build outputs may hold older bridges: only the version the client declares for the runtime goes. A client that names two
      # (Version for net10, EarlierVersion for net8: v106/v107) gives the net8 pack EarlierVersion; one with a single Version
      # names the bridge of every runtime.
      $source = Get-Content -LiteralPath (Join-Path $odcRoot 'studio\bridge\client\Program.cs') -Raw
      $odcBridge = [regex]::Match($source, 'const string Version = "(v\d+)"').Groups[1].Value
      $earlier = [regex]::Match($source, 'const string EarlierVersion = "(v\d+)"').Groups[1].Value
      if (-not $OdcRuntime) { $OdcRuntime = 'net8.0' }
      if ($OdcRuntime -eq 'net8.0' -and $earlier) { $odcBridge = $earlier }
    } else {
      $dlls = @(Get-ChildItem -LiteralPath $bridgeFrom -Filter 'ODC3.Bridge.v*.dll' -File)
      if ($dlls.Count -ne 1) { throw "Esperava uma bridge ODC3.Bridge.v<N>.dll em $bridgeFrom; achei $($dlls.Count)." }
      $odcBridge = [regex]::Match($dlls[0].Name, '^ODC3\.Bridge\.(v\d+)\.dll$').Groups[1].Value
    }
    if ($odcBridge -notmatch '^v\d+$') { throw "Versao da bridge ODC desconhecida em $bridgeFrom" }
    $bridgeDll = Join-Path $bridgeFrom "ODC3.Bridge.$odcBridge.dll"
    if (-not (Test-Path -LiteralPath $bridgeDll)) { throw "Falta $bridgeDll (compile o runtime ODC: scripts\setup-dev.ps1)." }
    $bridgeOut = Join-Path $tree 'odc\studio\bridge\bin\Release\net8.0'
    New-Item -ItemType Directory -Force $bridgeOut | Out-Null
    Copy-Item -LiteralPath $bridgeDll -Destination $bridgeOut
    $deps = Join-Path $bridgeFrom "ODC3.Bridge.$odcBridge.deps.json"
    if (Test-Path -LiteralPath $deps) { Copy-Item -LiteralPath $deps -Destination $bridgeOut }
    # The runtime the bridge was built for (its .deps.json runtimeTarget), written to pack.json as odcRuntime: the agent then
    # knows which ODC Studios its pack bridge serves (studio-runtime.mjs bundledBridgeSupports), whatever the folder is named.
    $built = $null
    if (Test-Path -LiteralPath $deps) {
      try { $built = [regex]::Match([string](Get-Content -LiteralPath $deps -Raw | ConvertFrom-Json).runtimeTarget.name, 'Version=v(\d+\.\d+)').Groups[1].Value } catch { $built = $null }
      if ($built) { $built = 'net' + $built }
    }
    if ($OdcRuntime -and $built -and $built -ne $OdcRuntime) { throw "ODC3.Bridge.$odcBridge foi compilada para $built, nao para -OdcRuntime $OdcRuntime." }
    $odcRuntimeOfPack = $(if ($built) { $built } elseif ($signedRuntime) { $signedRuntime } elseif ($OdcRuntime -and -not $Prebuilt) { $OdcRuntime } else { $null })
    # macOS: no attach client (the agent speaks the diagnostic IPC itself).
    if (-not $mac) {
      Copy-Folder $clientFrom (Join-Path $tree 'odc\studio\bridge\client\bin\Release\net10.0')
      if (-not (Test-Path -LiteralPath (Join-Path $tree 'odc\studio\bridge\client\bin\Release\net10.0\ODC3.Bridge.Client.dll'))) { throw "Falta ODC3.Bridge.Client.dll em $clientFrom" }
    }
    # The ODC bridge finds its root by walking up from its DLL to a folder with studio\ and README.md.
    if ($mac) { [IO.File]::WriteAllText((Join-Path $tree 'odc\README.md'), "Root of the ODC bridge of the SSAM agent (do not delete or move it). Data in snapshots/, journal/ and lab/.`n", $utf8) }
    else { [IO.File]::WriteAllText((Join-Path $tree 'odc\README.md'), "Root of the ODC bridge of the SSAM agent (do not delete or move it). Data in snapshots\, journal\ and lab\.`r`n", $utf8) }
  }

  if ($laneList -contains 'o11') {
    $o11Out = Join-Path $tree 'bin\o11'
    # dev: bin\o11\hook (development hook) and bin\o11\bridge; h1: studio\o11\hook\Anvil.Hook.h1.dll and
    # studio\o11\bridge\b1 (the release layout the hook h1 checks: <release>\studio\o11\bridge\<bridgeId>).
    $bridgeOut = $(if ($Hook -eq 'h1') { Join-Path $tree 'studio\o11\bridge\b1' } else { Join-Path $o11Out 'bridge' })
    # macOS: no Anvil.Connect (the agent describes and attaches the Studio through the diagnostic IPC).
    $parts = $(if ($Hook -eq 'h1') { @('connect', 'bridge') } elseif ($mac) { @('hook', 'bridge') } else { @('connect', 'hook', 'bridge') })
    if ($Prebuilt) {
      foreach ($part in $parts) { Copy-Folder (Join-Path $Prebuilt "o11\$part") $(if ($part -eq 'bridge') { $bridgeOut } else { Join-Path $o11Out $part }) }
      $builtFor = Join-Path $Prebuilt 'o11\built-for.txt'
      if (-not (Test-Path -LiteralPath $builtFor)) { throw "Falta $builtFor (a versao do Service Studio para a qual a bridge foi compilada)." }
      $o11BuiltFor = (Get-Content -LiteralPath $builtFor -TotalCount 1).Trim()
    } elseif ($O11Studios) {
      # One thin bridge per Service Studio version, each against its own Studio folder and runtime (restore with the runtime
      # first: a build that only overrides TargetFramework finds no assets for it).
      $staging = Join-Path $work 'o11'
      $studios = @($O11Studios | ForEach-Object { $_ -split ',' } | Where-Object { $_ } | ForEach-Object { Get-StudioBuild $_ } | Sort-Object { [version]$_.Version } -Descending)
      if (@($studios.Version | Select-Object -Unique).Count -ne $studios.Count) { throw '-O11Studios repete uma versao do Service Studio.' }
      $thin = Join-Path $root 'kernel\src\Anvil.Bridge.Thin\Anvil.Bridge.Thin.csproj'
      foreach ($s in $studios) {
        $artifacts = Join-Path $work ('artifacts\bridge-' + $s.Version)
        & dotnet restore $thin --artifacts-path $artifacts "-p:TargetFramework=$($s.Runtime)" | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "dotnet restore falhou: fina $($s.Version)" }
        & dotnet build $thin -c Release --nologo -v minimal --no-restore --artifacts-path $artifacts -o (Join-Path $staging ('builds\' + $s.Version)) "-p:SSDir=$($s.Dir)" "-p:TargetFramework=$($s.Runtime)" | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "dotnet build falhou: fina $($s.Version)" }
      }
      Copy-Folder (Join-Path $staging ('builds\' + $studios[0].Version)) (Join-Path $staging 'bridge')
      $o11BuiltFor = $studios[0].Version
      if ($Hook -eq 'dev') { Invoke-Build 'kernel\tools\Anvil.RuntimeHook\Anvil.RuntimeHook.csproj' (Join-Path $staging 'hook') @('-p:AssemblyName=Anvil.RuntimeHook.Agent') 'hook' }
      Invoke-Build 'kernel\tools\Anvil.Connect\Anvil.Connect.csproj' (Join-Path $staging 'connect') @() 'connect'
      foreach ($part in $parts) { Copy-Folder (Join-Path $staging $part) $(if ($part -eq 'bridge') { $bridgeOut } else { Join-Path $o11Out $part }) }
    } else {
      $ssDir = Get-KernelStudio
      $exe = Join-Path $ssDir 'ServiceStudio.exe'
      if (-not (Test-Path -LiteralPath $exe)) { throw "Service Studio do kernel nao encontrado em $ssDir (defina ANVIL_STUDIO_DIR)." }
      $o11BuiltFor = [regex]::Match((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion, '^\d+\.\d+\.\d+').Value
      $staging = Join-Path $work 'o11'
      # The thin bridge: assembly Anvil.Bridge with no reference to the kernel (docs\O11-BRIDGE-FINA.md 2.1).
      Invoke-Build 'kernel\src\Anvil.Bridge.Thin\Anvil.Bridge.Thin.csproj' (Join-Path $staging 'bridge') @("-p:SSDir=$ssDir") 'bridge'
      if ($Hook -eq 'dev') { Invoke-Build 'kernel\tools\Anvil.RuntimeHook\Anvil.RuntimeHook.csproj' (Join-Path $staging 'hook') @('-p:AssemblyName=Anvil.RuntimeHook.Agent') 'hook' }
      Invoke-Build 'kernel\tools\Anvil.Connect\Anvil.Connect.csproj' (Join-Path $staging 'connect') @() 'connect'
      foreach ($part in $parts) { Copy-Folder (Join-Path $staging $part) $(if ($part -eq 'bridge') { $bridgeOut } else { Join-Path $o11Out $part }) }
    }
    if ($o11BuiltFor -notmatch '^\d+\.\d+\.\d+$') { throw "Versao do Service Studio invalida: '$o11BuiltFor'" }
    if ($ExpectO11 -and $o11BuiltFor -ne $ExpectO11) { throw "A fina foi compilada para o Service Studio $o11BuiltFor; -ExpectO11 pede $ExpectO11." }
    if ($ExpectO11 -and -not $Prebuilt -and $ssDir -match 'Service Studio 11 - Anvil') { throw "-ExpectO11 compila a fina contra a pasta do Service Studio daquela versao, nunca contra a copia de faixa ($ssDir)." }
    if ($Hook -eq 'h1') {
      # The release hook as the release line built it: only the hook and its deps.json, never sources or other DLLs.
      $hookOut = Join-Path $tree 'studio\o11\hook'
      New-Item -ItemType Directory -Force $hookOut | Out-Null
      Copy-Item -LiteralPath (Join-Path $HookH1 'Anvil.Hook.h1.dll') -Destination $hookOut
      $hookDeps = Join-Path $HookH1 'Anvil.Hook.h1.deps.json'
      if (Test-Path -LiteralPath $hookDeps) { Copy-Item -LiteralPath $hookDeps -Destination $hookOut }
    }
    $required = $(if ($Hook -eq 'h1') { @('bin\o11\connect\Anvil.Connect.dll', 'studio\o11\hook\Anvil.Hook.h1.dll', 'studio\o11\bridge\b1\Anvil.Bridge.dll') }
      elseif ($mac) { @('bin\o11\hook\Anvil.RuntimeHook.Agent.dll', 'bin\o11\bridge\Anvil.Bridge.dll') }
      else { @('bin\o11\connect\Anvil.Connect.dll', 'bin\o11\hook\Anvil.RuntimeHook.Agent.dll', 'bin\o11\bridge\Anvil.Bridge.dll') })
    foreach ($file in $required) { if (-not (Test-Path -LiteralPath (Join-Path $tree $file))) { throw "Falta $file" } }
    $bridgeRel = $(if ($Hook -eq 'h1') { 'studio/o11/bridge/b1/Anvil.Bridge.dll' } else { 'bin/o11/bridge/Anvil.Bridge.dll' })
    $o11Bridge = [ordered]@{ id = $(if ($Hook -eq 'h1') { 'b1' } else { $null }); hookAbi = $(if ($Hook -eq 'h1') { 'h1' } else { $null }); path = $bridgeRel
      sha256 = (Get-Sha256 (Join-Path $tree ($bridgeRel -replace '/', '\'))) }
    # o11Builds: the default bridge first, then one folder per other Service Studio version (bin\o11\bridges\<x.y.z>).
    $buildsFrom = $(if ($O11Studios) { Join-Path $work 'o11\builds' } elseif ($Prebuilt -and (Test-Path -LiteralPath (Join-Path $Prebuilt 'o11\builds'))) { Join-Path $Prebuilt 'o11\builds' } else { $null })
    if ($buildsFrom) {
      if ($Hook -ne 'dev' -or $mac) { throw 'Uma fina por versao (o11\builds) so vale com o gancho dev no Windows.' }
      $versions = @(Get-ChildItem -LiteralPath $buildsFrom -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending)
      if ($versions.Count -eq 0) { throw "Nenhuma fina por versao em $buildsFrom" }
      if ($Prebuilt) {
        # The default bridge of a prebuilt pack is the newest build, as when it is compiled here.
        Remove-Item -LiteralPath $bridgeOut -Recurse -Force
        Copy-Folder $versions[0].FullName $bridgeOut
        $o11BuiltFor = $versions[0].Name
        $o11Bridge.sha256 = Get-Sha256 (Join-Path $tree ($bridgeRel -replace '/', '\'))
      }
      if ($versions[0].Name -ne $o11BuiltFor) { throw "A fina padrao ($o11BuiltFor) nao e a mais nova ($($versions[0].Name))." }
      $o11Builds = @([ordered]@{ version = $o11BuiltFor; runtime = (Get-BridgeRuntime $bridgeOut); path = $bridgeRel; sha256 = $o11Bridge.sha256 })
      foreach ($v in ($versions | Select-Object -Skip 1)) {
        $target = Join-Path $o11Out ('bridges\' + $v.Name)
        Copy-Folder $v.FullName $target
        $rel = 'bin/o11/bridges/' + $v.Name + '/Anvil.Bridge.dll'
        if (-not (Test-Path -LiteralPath (Join-Path $tree ($rel -replace '/', '\')))) { throw "Falta $rel" }
        $o11Builds += [ordered]@{ version = $v.Name; runtime = (Get-BridgeRuntime $target); path = $rel; sha256 = (Get-Sha256 (Join-Path $tree ($rel -replace '/', '\'))) }
      }
    }
  }

  if ($Hook -eq 'h1') {
    # The folder of the pack is the "release" of the hook h1: release.json above the bridge (RuntimeContract.FindReleaseRoot)
    # and, after the owner signs it, release.sig.jws next to it. version is what release_sign signs.
    $release = [ordered]@{ schema = 'ssam-agent-release/1'; version = $ReleaseVersion; kind = 'agent-pack'
      bridges = [ordered]@{ o11 = [ordered]@{ id = 'b1'; hook = 'h1'; protocolVersion = 2; flavor = 'thin' } } }
    [IO.File]::WriteAllText((Join-Path $tree 'release.json'), ($release | ConvertTo-Json -Depth 5), $utf8)
  }

  # Last check over the whole tree, then pack.json with the sha256 of every file.
  $base = (Resolve-Path -LiteralPath $tree).Path.TrimEnd('\')
  if ($mac) {
    # macOS: the guides, the scripts and the agent code with LF only, whatever line ends the checkout gave them (docs\ has
    # no eol attribute, so a core.autocrlf checkout writes the guides with CRLF): the same bytes from any checkout. The
    # binaries and their .deps.json stay the bytes of the prebuilt.
    foreach ($file in Get-ChildItem -LiteralPath $base -Recurse -File -Force | Where-Object { $_.Extension -in '.md', '.mjs', '.sh' }) {
      $bytes = [IO.File]::ReadAllBytes($file.FullName)
      if ([Array]::IndexOf($bytes, [byte]13) -ge 0) {
        [IO.File]::WriteAllText($file.FullName, [Text.Encoding]::UTF8.GetString($bytes).Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))
      }
    }
  }
  $files = @()
  foreach ($file in Get-ChildItem -LiteralPath $base -Recurse -File -Force | Sort-Object FullName) {
    $rel = $file.FullName.Substring($base.Length + 1)
    if ((Test-Forbidden $rel) -or ($rel -match '\.(mjs|js)$' -and $rel -notmatch '^agent\\')) { throw "Arquivo proibido no pacote: $rel" }
    if ($mac -and ($rel -match '\.(exe|ps1)$')) { throw "Arquivo proibido no pacote do macOS: $rel" }
    $files += [ordered]@{ path = ($rel -replace '\\', '/'); sha256 = (Get-Sha256 $file.FullName); size = $file.Length }
  }
  if ($mac) {
    # pack.json of macOS: no null value (install.sh reads it with plutil), the platform and the pinned Node.
    $pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'node-darwin.json') -Raw | ConvertFrom-Json
    if ($pin.version -notmatch '^\d+\.\d+\.\d+$') { throw "scripts\node-darwin.json sem version" }
    $node = [ordered]@{ version = [string]$pin.version; source = [string]$pin.source }
    foreach ($arch in 'arm64', 'x64') {
      $entry = $pin.$arch
      if ($entry.file -ne "node-v$($pin.version)-darwin-$arch.tar.gz" -or $entry.sha256 -notmatch '^[0-9a-f]{64}$') { throw "scripts\node-darwin.json: $arch invalido" }
      $node[$arch] = [ordered]@{ file = [string]$entry.file; sha256 = [string]$entry.sha256 }
    }
    $pack = [ordered]@{ id = 'pack-' + (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss'); platform = 'darwin'; lanes = @($laneList) }
    if ($odcBridge) { $pack.odcBridge = $odcBridge }
    if ($odcRuntimeOfPack) { $pack.odcRuntime = $odcRuntimeOfPack }
    if ($o11BuiltFor) { $pack.o11BuiltFor = $o11BuiltFor; $pack.o11Hook = $Hook; $pack.o11Bridge = [ordered]@{ path = $o11Bridge.path; sha256 = $o11Bridge.sha256 } }
    $pack.node = $node
    $pack.files = $files
    [IO.File]::WriteAllText((Join-Path $tree 'pack.json'), ($pack | ConvertTo-Json -Depth 5).Replace("`r`n", "`n"), $utf8)
    Write-PackTar $base $Out $pack.id $laneList
    return
  }
  $pack = [ordered]@{
    id = 'pack-' + (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
    lanes = @($laneList)
    odcBridge = $odcBridge
    o11BuiltFor = $o11BuiltFor
    o11Hook = $(if ($laneList -contains 'o11') { $Hook } else { $null })
    o11Bridge = $o11Bridge
    files = $files
  }
  if ($odcRuntimeOfPack) { $pack.Insert(3, 'odcRuntime', $odcRuntimeOfPack) }
  if ($o11Builds) { $pack.Insert($pack.Count - 1, 'o11Builds', @($o11Builds)) }
  if ($NoBridgeOffer) { $pack.Insert($pack.Count - 1, 'bridgeOffer', $false) }
  if ($xifEngineEntry) { $pack.xifEngine = $xifEngineEntry }
  [IO.File]::WriteAllText((Join-Path $tree 'pack.json'), ($pack | ConvertTo-Json -Depth 5), $utf8)

  if ($Stage) {
    $stageDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Stage)
    New-Item -ItemType Directory -Force $stageDir | Out-Null
    Copy-Item -Path (Join-Path $base '*') -Destination $stageDir -Recurse -Force
    Write-Output ("Arvore do pacote {0} em {1} (gancho h1, release {2}), sem assinatura. Proximo passo do dono: release_sign {{releaseDir:'{1}'}} no servidor MCP do publicador; depois .\scripts\agent-pack.ps1 -FromStage {1} -Out <zip>." -f $pack.id, $stageDir, $ReleaseVersion)
    return
  }
  Write-PackZip $base $Out $pack.id $laneList
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
