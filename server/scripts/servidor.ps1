# SSAM servido por HTTP nesta maquina (docs\SERVIDOR-LOCAL.md, docs\FASE2-AGENTE.md).
#   .\scripts\servidor.ps1 start [-Port 7300] [-RatePerMinute 240]
#   .\scripts\servidor.ps1 status
#   .\scripts\servidor.ps1 stop
# Sobe o servidor HOSPEDADO (ssam serve sem --local-studios): as ferramentas falam com o agente de cada cliente, nunca
# com os Studios desta maquina. Processo node em segundo plano, sem servico do Windows e sem direitos de administrador.
# O pid, o estado e o log (server.log, gravado pelo proprio servidor com --log-file) ficam em .local\server (fora do
# git). So escuta em 127.0.0.1. Tokens: .\ssam server-token issue|agent-rotate|revoke|list.
param(
  [Parameter(Position = 0, Mandatory = $true)][ValidateSet('start', 'stop', 'status')][string]$Action,
  [int]$Port = 7300,
  [int]$RatePerMinute = 0
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = if ($env:SSAM_SERVER_DIR) { $env:SSAM_SERVER_DIR } else { Join-Path $root '.local\server' }
$pidFile = Join-Path $dir 'server.pid'
$stateFile = Join-Path $dir 'server.json'
$logFile = Join-Path $dir 'server.log'

function Get-Node {
  # Mesma ordem do ssam.cmd: SSAM_NODE, o Node do runtime Codex, o node do PATH.
  $candidates = @($env:SSAM_NODE, (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'Node nao encontrado: defina SSAM_NODE ou rode scripts\setup-dev.ps1.'
}

function Get-Running {
  if (-not (Test-Path $pidFile)) { return $null }
  $id = [int](Get-Content $pidFile -TotalCount 1)
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  # Um pid reaproveitado por outro programa (inclusive outro node) nao conta como servidor: so o node cuja linha de
  # comando e o ssam serve com o --log-file desta pasta. Senao o arquivo de pid e velho: apagado, e nada e parado.
  if ($proc -and $proc.ProcessName -eq 'node') {
    $line = (Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $id) -ErrorAction SilentlyContinue).CommandLine
    if ($line -and $line.IndexOf('ssam.mjs', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $line.IndexOf($logFile, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $proc }
  }
  Remove-Item $pidFile, $stateFile -Force -ErrorAction SilentlyContinue
  return $null
}

# O /health da porta: $null quando ninguem responde; senao o objeto {ok, pid} (pid nulo num servidor antigo).
function Get-Health([int]$p) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ("http://127.0.0.1:{0}/health" -f $p)
    if ($r.StatusCode -ne 200) { return $null }
    try { $body = $r.Content | ConvertFrom-Json } catch { $body = $null }
    $healthPid = $null
    if ($body -and $body.pid) { $healthPid = [int]$body.pid }
    return [pscustomobject]@{ pid = $healthPid }
  } catch { return $null }
}

function Get-StatePort {
  if (Test-Path $stateFile) { try { return [int]((Get-Content $stateFile -Raw | ConvertFrom-Json).port) } catch { } }
  return $Port
}

function Format-Pid($value) { if ($value) { return [string]$value } else { return 'desconhecido' } }

function Stop-Started($proc) {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -Confirm:$false -ErrorAction SilentlyContinue }
  Remove-Item $pidFile, $stateFile -Force -ErrorAction SilentlyContinue
}

switch ($Action) {
  'start' {
    $running = Get-Running
    if ($running) { Write-Output ("Ja esta rodando: pid {0}, http://127.0.0.1:{1}/mcp" -f $running.Id, (Get-StatePort)); exit 0 }
    # Sem pid proprio vivo, uma porta que ja responde /health e de outro processo: nunca conta como sucesso.
    $other = Get-Health $Port
    if ($other) { Write-Output ("Porta {0} ocupada por outro processo (pid {1}). Pare esse processo ou use -Port." -f $Port, (Format-Pid $other.pid)); exit 1 }
    New-Item -ItemType Directory -Force $dir | Out-Null
    $node = Get-Node
    $arguments = @(('"{0}"' -f (Join-Path $root 'facade\ssam.mjs')), 'serve', '--port', $Port, '--log-file', ('"{0}"' -f $logFile))
    if ($RatePerMinute -gt 0) { $arguments += @('--rate-per-minute', $RatePerMinute) }
    # Sem redirecionamento: Start-Process do Windows PowerShell usa ShellExecute e o node nao herda os handles de quem
    # chamou (com -RedirectStandardOutput, uma chamada com a saida capturada nunca voltava). O log vem do --log-file.
    $proc = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
    Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
    Set-Content -Path $stateFile -Value (@{ pid = $proc.Id; port = $Port; startedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress) -Encoding ascii
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
      if ($proc.HasExited) { break }
      $health = Get-Health $Port
      # So conta como no ar o /health com o pid do processo iniciado; outro pid e outro processo na mesma porta.
      if ($health -and $health.pid -eq $proc.Id) { Write-Output ("Servidor no ar: pid {0}, http://127.0.0.1:{1}/mcp. Log: {2}" -f $proc.Id, $Port, $logFile); exit 0 }
      if ($health) {
        Stop-Started $proc
        Write-Output ("Porta {0} ocupada por outro processo (pid {1}); o servidor iniciado foi parado." -f $Port, (Format-Pid $health.pid))
        exit 1
      }
      Start-Sleep -Milliseconds 300
    }
    Stop-Started $proc
    Write-Output ("O servidor nao respondeu em 30 s. Veja {0} ou rode .\ssam serve --port {1} em primeiro plano para ver o erro." -f $logFile, $Port)
    exit 1
  }
  'status' {
    $running = Get-Running
    if (-not $running) { Write-Output 'Parado.'; exit 3 }
    $p = Get-StatePort
    $health = Get-Health $p
    $answer = if (-not $health) { 'NAO responde' } elseif ($health.pid -eq $running.Id) { 'responde' } else { 'a porta responde com outro pid: ' + (Format-Pid $health.pid) }
    Write-Output ("Rodando: pid {0}, http://127.0.0.1:{1}/mcp ({2}). Log: {3}" -f $running.Id, $p, $answer, $logFile)
    exit 0
  }
  'stop' {
    $running = Get-Running
    if ($running) { Stop-Process -Id $running.Id -Force -Confirm:$false; Write-Output ("Parado: pid {0}" -f $running.Id) }
    else { Write-Output 'Ja estava parado.' }
    Remove-Item $pidFile, $stateFile -Force -ErrorAction SilentlyContinue
    exit 0
  }
}
