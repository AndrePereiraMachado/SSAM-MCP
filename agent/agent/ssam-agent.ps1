# Agente SSAM nesta maquina (cliente da fase 2, docs\AGENTE-CLIENTE.md).
#   .\agent\ssam-agent.ps1 start
#   .\agent\ssam-agent.ps1 status
#   .\agent\ssam-agent.ps1 stop
# Processo node em segundo plano, sem servico do Windows e sem administrador. Antes, uma vez: setup (o guia mostra).
# O pid, o estado e o log ficam em private\ (so este usuario le). So conexao de SAIDA para o servidor; nenhuma porta
# aberta aqui. Proxy corporativo: HTTPS_PROXY (o node sobe com --use-env-proxy); CA corporativa: --use-system-ca.
param(
  [Parameter(Position = 0, Mandatory = $true)][ValidateSet('start', 'stop', 'status')][string]$Action
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$private = Join-Path $root 'private'
$pidFile = Join-Path $private 'agent.pid'
$stateFile = Join-Path $private 'agent.json'
$stopFile = Join-Path $private 'agent.stop'
$logFile = Join-Path $private 'agent.log'
$script = Join-Path $PSScriptRoot 'ssam-agent.mjs'

function Get-Node {
  # O node do pacote (-NodeExe), SSAM_NODE, ou o node do PATH.
  $candidates = @((Join-Path $PSScriptRoot 'node\node.exe'), $env:SSAM_NODE)
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'Node nao encontrado: instale o Node 24 (docs\AGENTE-CLIENTE.md) ou defina SSAM_NODE.'
}

function Read-State {
  if (-not (Test-Path $stateFile)) { return $null }
  try { return Get-Content $stateFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-AgentProcess([int]$id) {
  if ($id -le 0) { return $null }
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  # Um pid reaproveitado por outro programa nao conta como agente.
  if ($proc -and $proc.ProcessName -eq 'node') { return $proc }
  return $null
}

# The agent of this folder: the pid this script started, else the pid in the state file (an agent started by hand).
function Get-Running {
  if (Test-Path $pidFile) {
    $proc = Get-AgentProcess ([int](Get-Content $pidFile -TotalCount 1))
    if ($proc) { return $proc }
  }
  $state = Read-State
  if ($state -and $state.state -ne 'stopped' -and $state.pid) { return Get-AgentProcess ([int]$state.pid) }
  return $null
}

function Get-ExitText([int]$code) {
  switch ($code) {
    2 { return 'credencial recusada, revogada, vencida ou trocada pelo dono do servidor: peca uma nova e rode setup de novo' }
    3 { return 'outro agente com a mesma credencial assumiu esta conta' }
    4 { return 'o servidor nao aceita esta versao do agente: peca o pacote atual ao dono do servidor' }
    default { return ('veja o log {0}; para ver o erro na tela: node "{1}" run --root "{2}"' -f $logFile, $script, $root) }
  }
}

switch ($Action) {
  'start' {
    $running = Get-Running
    if ($running) { Write-Output ("Ja esta rodando: pid {0}. Log: {1}" -f $running.Id, $logFile); exit 0 }
    if (-not (Test-Path (Join-Path $private 'credential')) -or -not (Test-Path (Join-Path $private 'config.json'))) {
      Write-Output 'Agente sem configuracao: rode setup primeiro (docs\AGENTE-CLIENTE.md).'; exit 1
    }
    Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
    $node = Get-Node
    # Sem redirecionamento: Start-Process com -RedirectStandardOutput/-Error faz o node herdar os handles de quem chamou
    # e uma chamada com saida capturada nunca volta. O agente grava o proprio log (--log-file).
    $arguments = @('--use-env-proxy', '--use-system-ca', ('"{0}"' -f $script), 'run', '--root', ('"{0}"' -f $root), '--log-file', ('"{0}"' -f $logFile))
    $proc = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
    Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
    # So conta como no ar quando o estado gravado e do processo iniciado agora (pid igual) e esta conectado.
    $deadline = (Get-Date).AddSeconds(30)
    $state = $null
    while ((Get-Date) -lt $deadline) {
      $state = Read-State
      if ($state -and [int]$state.pid -eq $proc.Id -and $state.state -eq 'connected') {
        Write-Output ("Agente conectado: pid {0}, servidor {1}. Log: {2}" -f $proc.Id, $state.server, $logFile); exit 0
      }
      if ($proc.HasExited) { break }
      Start-Sleep -Milliseconds 300
    }
    if ($proc.HasExited -or -not (Get-AgentProcess $proc.Id)) {
      $code = if ($state -and [int]$state.pid -eq $proc.Id -and $null -ne $state.exitCode) { [int]$state.exitCode } else { 1 }
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
      Write-Output ("O agente parou (codigo {0}): {1}" -f $code, (Get-ExitText $code)); exit 1
    }
    Write-Output ("Agente iniciado (pid {0}), ainda sem conexao com o servidor; ele continua tentando. Veja status e o log {1}" -f $proc.Id, $logFile)
    exit 0
  }
  'status' {
    $running = Get-Running
    $state = Read-State
    if (-not $running) {
      $last = if ($state -and $null -ne $state.exitCode -and [int]$state.exitCode -ne 0) { ' Ultima parada: ' + (Get-ExitText ([int]$state.exitCode)) + '.' } else { '' }
      Write-Output ("Parado.{0}" -f $last); exit 3
    }
    $since = if ($state) { $state.at } else { '?' }
    $now = if ($state) { $state.state } else { '?' }
    Write-Output ("Rodando: pid {0}, estado {1} (desde {2}). Log: {3}" -f $running.Id, $now, $since, $logFile)
    exit 0
  }
  'stop' {
    $running = Get-Running
    if (-not $running) { Write-Output 'Ja estava parado.'; Remove-Item $pidFile, $stopFile -Force -ErrorAction SilentlyContinue; exit 0 }
    # Parada limpa: o agente ve private\agent.stop, avisa o servidor e sai; depois de 5 s, encerra a forca.
    Set-Content -Path $stopFile -Value 'stop' -Encoding ascii
    if (-not $running.WaitForExit(5000)) { Stop-Process -Id $running.Id -Force -Confirm:$false }
    Remove-Item $pidFile, $stopFile -Force -ErrorAction SilentlyContinue
    Write-Output ("Parado: pid {0}" -f $running.Id)
    exit 0
  }
}
