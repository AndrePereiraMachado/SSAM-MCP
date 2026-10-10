# Varredura de propriedade intelectual do pacote do agente (docs\O11-BRIDGE-FINA.md 6.4).
#   .\scripts\pack-ip-scan.ps1 -Zip <ssam-agent.zip>
# Le cada entrada do ZIP e escreve {ok, findings:[{entry, rule, detail}], allowed:[{entry, rule, detail, why}]} em JSON;
# sai com 0 (sem achados) ou 1. scripts\agent-pack.ps1 a chama sobre o ZIP que acabou de escrever. Regras:
#   forbidden-name    .dll/.exe/.pdb chamado anvil, anvil-odc ou Esprima, ou que comeca com Anvil.Core, Anvil.Cli,
#                     Anvil.Authoring, Anvil.CSharp, SSAM.License ou SSAM.Runtime (qualquer pasta, sem diferenciar caixa).
#   kernel-text       os bytes da entrada contem, em UTF-8 e comparacao exata, um nome de namespace ou assembly do kernel
#                     (os nomes do metadado .NET ficam em UTF-8; textos literais em UTF-16 nao casam). So a tabela
#                     $knownKernelText vira 'allowed': o gancho de release h1 confere o manifesto assinado (Ssam.Lic) e le
#                     o contrato de runtime (Ssam.Runtime) por desenho.
#   bridge-folder     a bridge O11 fina vai num lugar so: bin/o11/bridge/ (gancho de desenvolvimento) ou
#                     studio/o11/bridge/b<N>/ (gancho de release h1), com exatamente Anvil.Bridge.dll e, opcional,
#                     Anvil.Bridge.deps.json; studio/o11/hook/ tem exatamente Anvil.Hook.h1.dll (+ .deps.json); o layout
#                     h1 exige release.json e release.sig.jws na raiz.
#   client-content    um padrao forbidden[].pattern de scripts\release\client-content.json (so leitura), sem diferenciar
#                     caixa, nos bytes lidos como Latin-1 e como UTF-16LE nos dois alinhamentos (o metodo de
#                     scripts\release\scan-client-content.mjs). A tabela $knownClientContent esta vazia desde
#                     servidor/fase3: todo texto de cliente recusa o pacote.
#   customer-pattern  as mesmas leituras, com padroes genericos: host de ambiente de cliente (<nome>.outsystems.dev,
#                     .outsystems.app, .outsystemscloud.com, .outsystemsenterprise.com) e endereco de e-mail. Dominios
#                     reservados para exemplo (example.com/.org/.net, .example, .test, .invalid, .localhost, .local) passam.
# agent/node/node.exe e agent/node/LICENSE (terceiros) ficam fora de kernel-text, client-content e customer-pattern.
param([Parameter(Mandatory = $true)][string]$Zip)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot

$thirdParty = @('agent/node/node.exe', 'agent/node/LICENSE')
$deniedStem = '^(anvil|anvil-odc|esprima)$|^(anvil\.core|anvil\.cli|anvil\.authoring|anvil\.csharp|ssam\.license|ssam\.runtime)'
$kernelTokens = @('Anvil.Core', 'Anvil.Cli', 'Anvil.Authoring', 'Anvil.CSharp', 'Ssam.Runtime', 'Ssam.Lic', 'Esprima')
# Kernel-text exceptions: entry (-like pattern over the ZIP entry) and the tokens it may carry. Any other token there,
# or these tokens anywhere else, is a finding.
$knownKernelText = @(
  @{ entry = 'studio/o11/hook/Anvil.Hook.h1.dll'; tokens = @('Ssam.Lic', 'Ssam.Runtime'); why = 'the release hook h1 checks the signed release manifest (Ssam.Lic.Release) and reads the runtime contract (Ssam.Runtime) before loading the thin bridge (docs\DISTRIBUICAO.md 7.1)' }
)
$bridgeFiles = @('Anvil.Bridge.dll', 'Anvil.Bridge.deps.json')
$devBridge = 'bin/o11/bridge/'
$hookPrefix = 'studio/o11/hook/'
$hookFiles = @('Anvil.Hook.h1.dll', 'Anvil.Hook.h1.deps.json')
$releaseBridge = '^studio/o11/bridge/(b[1-9][0-9]{0,3})/(.+)$'
# Client text the pack may carry knowingly: none since servidor/fase3 (ScProtocol.cs reads corporateHosts, Manifest.cs
# has no default tenant or author). The format stays for an exception the owner accepts knowingly: entry is a -like
# pattern over the ZIP entry; pattern repeats one forbidden pattern exactly; text and occurrences pin what it may match.
$knownClientContent = @()
$tenantHost = '(?<![a-z0-9.-])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:outsystems\.dev|outsystems\.app|outsystemscloud\.com|outsystemsenterprise\.com)(?![a-z0-9-])'
$email = '(?<![a-z0-9._%+-])[a-z0-9][a-z0-9._%+-]{1,63}@[a-z0-9][a-z0-9-]{1,62}(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,24}(?![a-z])'
$reserved = '(^|[.@])(example\.(com|org|net)|[a-z0-9-]+\.(example|test|invalid|localhost|local))$'

$content = Get-Content -LiteralPath (Join-Path $root 'scripts\release\client-content.json') -Raw | ConvertFrom-Json
$options = [Text.RegularExpressions.RegexOptions]'IgnoreCase, CultureInvariant'
$patterns = @($content.forbidden | ForEach-Object { [pscustomobject]@{ pattern = [string]$_.pattern; regex = [regex]::new([string]$_.pattern, $options) } })
if ($patterns.Count -eq 0) { throw 'scripts\release\client-content.json sem forbidden[].pattern' }
$generic = @(
  [pscustomobject]@{ name = 'tenant host'; regex = [regex]::new($tenantHost, $options) },
  [pscustomobject]@{ name = 'e-mail'; regex = [regex]::new($email, $options) }
)
$reservedRegex = [regex]::new($reserved, $options)
$latin1 = [Text.Encoding]::GetEncoding(28591)
$utf16 = [Text.Encoding]::Unicode

$findings = New-Object Collections.Generic.List[object]
$allowed = New-Object Collections.Generic.List[object]
function Add-Finding([string]$entry, [string]$rule, [string]$detail) { $findings.Add([ordered]@{ entry = $entry; rule = $rule; detail = $detail }) }

function Read-Entry($item) {
  $stream = $item.Open()
  try { $memory = New-Object IO.MemoryStream; $stream.CopyTo($memory); return , $memory.ToArray() } finally { $stream.Dispose() }
}

$names = New-Object Collections.Generic.List[string]
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Zip).Path)
try {
  foreach ($item in $archive.Entries) {
    $name = $item.FullName -replace '\\', '/'
    if ($name.EndsWith('/')) { continue }
    $names.Add($name)
    $file = $name.Substring($name.LastIndexOf('/') + 1)
    if ($file -match '\.(dll|exe|pdb)$' -and [IO.Path]::GetFileNameWithoutExtension($file) -match $deniedStem) { Add-Finding $name 'forbidden-name' $file }
    if ($thirdParty -contains $name) { continue }

    $bytes = Read-Entry $item
    $text = $latin1.GetString($bytes)
    $knownTokens = @($knownKernelText | Where-Object { $name -like $_.entry }) | Select-Object -First 1
    foreach ($token in $kernelTokens) {
      if ($text.IndexOf($token, [StringComparison]::Ordinal) -lt 0) { continue }
      if ($knownTokens -and $knownTokens.tokens -ccontains $token) { $allowed.Add([ordered]@{ entry = $name; rule = 'kernel-text'; detail = "$token (UTF-8)"; why = $knownTokens.why }) }
      else { Add-Finding $name 'kernel-text' "$token (UTF-8)" }
    }
    # The UTF-16LE views always decode an even number of bytes, from byte 0 and from byte 1.
    $views = @(@{ encoding = 'latin1'; text = $text }, @{ encoding = 'utf16le'; text = $utf16.GetString($bytes, 0, $bytes.Length -band -2) })
    if ($bytes.Length -gt 1) { $views += @{ encoding = 'utf16le+1'; text = $utf16.GetString($bytes, 1, ($bytes.Length - 1) -band -2) } }
    foreach ($p in $patterns) {
      $found = New-Object Collections.Generic.List[string]
      $encodings = New-Object Collections.Generic.List[string]
      foreach ($view in $views) {
        foreach ($match in $p.regex.Matches($view.text)) { $found.Add($match.Value); if (-not $encodings.Contains($view.encoding)) { $encodings.Add($view.encoding) } }
      }
      if ($found.Count -eq 0) { continue }
      $detail = "$($p.pattern) ($($encodings -join ', '))"
      $known = @($knownClientContent | Where-Object { $name -like $_.entry -and $_.pattern -ceq $p.pattern }) | Select-Object -First 1
      $exact = $known -and $found.Count -eq $known.occurrences -and @($found | Where-Object { $_ -cne $known.text }).Count -eq 0
      if ($exact) { $allowed.Add([ordered]@{ entry = $name; rule = 'client-content'; detail = $detail; why = $known.why }) }
      elseif ($known) { Add-Finding $name 'client-content' ("$detail; expected only '$($known.text)' x$($known.occurrences), found " + ((@($found) | Select-Object -Unique) -join ', ') + " x$($found.Count)") }
      else { Add-Finding $name 'client-content' $detail }
    }
    foreach ($g in $generic) {
      $hits = New-Object Collections.Generic.List[string]
      foreach ($view in $views) {
        foreach ($match in $g.regex.Matches($view.text)) {
          if ($g.name -eq 'e-mail' -and $reservedRegex.IsMatch($match.Value.Substring($match.Value.IndexOf('@')))) { continue }
          if (-not $hits.Contains($match.Value.ToLowerInvariant())) { $hits.Add($match.Value.ToLowerInvariant()) }
        }
      }
      if ($hits.Count -gt 0) { Add-Finding $name 'customer-pattern' ("$($g.name): " + (@($hits | Select-Object -First 5) -join ', ')) }
    }
  }
} finally { $archive.Dispose() }

function Test-Exactly([string[]]$files, [string[]]$allowedNames, [string]$prefix, [string]$what) {
  foreach ($name in $files) {
    $rest = $name.Substring($prefix.Length)
    if (-not @($allowedNames | Where-Object { $_ -ieq $rest })) { Add-Finding $name 'bridge-folder' $what }
  }
}

$inDev = @($names | Where-Object { $_.StartsWith($devBridge, [StringComparison]::OrdinalIgnoreCase) })
Test-Exactly $inDev $bridgeFiles $devBridge 'bin/o11/bridge holds only Anvil.Bridge.dll and Anvil.Bridge.deps.json'
$inHook = @($names | Where-Object { $_.StartsWith($hookPrefix, [StringComparison]::OrdinalIgnoreCase) })
Test-Exactly $inHook $hookFiles $hookPrefix 'studio/o11/hook holds only Anvil.Hook.h1.dll and Anvil.Hook.h1.deps.json'
$releaseIds = New-Object Collections.Generic.List[string]
foreach ($name in @($names | Where-Object { $_.StartsWith('studio/o11/bridge/', [StringComparison]::OrdinalIgnoreCase) })) {
  $m = [regex]::Match($name, $releaseBridge, 'IgnoreCase')
  if (-not $m.Success) { Add-Finding $name 'bridge-folder' 'a release bridge lives in studio/o11/bridge/b<N>/'; continue }
  if (-not $releaseIds.Contains($m.Groups[1].Value)) { $releaseIds.Add($m.Groups[1].Value) }
  if (-not @($bridgeFiles | Where-Object { $_ -ieq $m.Groups[2].Value })) { Add-Finding $name 'bridge-folder' "studio/o11/bridge/$($m.Groups[1].Value) holds only Anvil.Bridge.dll and Anvil.Bridge.deps.json" }
}
foreach ($id in $releaseIds) {
  if (-not @($names | Where-Object { $_ -ieq "studio/o11/bridge/$id/Anvil.Bridge.dll" })) { Add-Finding "studio/o11/bridge/$id/Anvil.Bridge.dll" 'bridge-folder' 'missing' }
}
$hasDev = @($inDev | Where-Object { $_ -ieq ($devBridge + 'Anvil.Bridge.dll') }).Count -gt 0
$hasRelease = $releaseIds.Count -gt 0 -or $inHook.Count -gt 0
if ($releaseIds.Count -gt 1) { Add-Finding 'studio/o11/bridge/' 'bridge-folder' ('one release bridge per pack, found ' + ($releaseIds -join ', ')) }
if ($hasDev -and $hasRelease) { Add-Finding 'studio/o11/' 'bridge-folder' 'the thin bridge goes in one place: bin/o11/bridge (development hook) or studio/o11 (release hook h1), not both' }
if ($hasRelease) {
  if (-not @($inHook | Where-Object { $_ -ieq ($hookPrefix + 'Anvil.Hook.h1.dll') })) { Add-Finding ($hookPrefix + 'Anvil.Hook.h1.dll') 'bridge-folder' 'missing (release layout)' }
  if ($releaseIds.Count -eq 0) { Add-Finding 'studio/o11/bridge/b1/Anvil.Bridge.dll' 'bridge-folder' 'missing (release layout)' }
  foreach ($required in @('release.json', 'release.sig.jws')) { if (-not ($names -contains $required)) { Add-Finding $required 'bridge-folder' 'missing (the release hook checks the bridge against the signed manifest)' } }
}
$hasO11 = @($names | Where-Object { $_.StartsWith('bin/o11/', [StringComparison]::OrdinalIgnoreCase) -or $_.StartsWith('studio/o11/', [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
if ($hasO11 -and -not $hasDev -and -not $hasRelease) { Add-Finding ($devBridge + 'Anvil.Bridge.dll') 'bridge-folder' 'missing' }

$report = [ordered]@{ ok = ($findings.Count -eq 0); findings = $findings.ToArray(); allowed = $allowed.ToArray() }
Write-Output ($report | ConvertTo-Json -Depth 5)
if ($report.ok) { exit 0 } else { exit 1 }
