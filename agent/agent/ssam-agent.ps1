# The SSAM agent on this machine (the customer side of phase 2, docs\AGENTE-CLIENTE.md).
#   .\agent\ssam-agent.ps1 start
#   .\agent\ssam-agent.ps1 status
#   .\agent\ssam-agent.ps1 stop
# A node process in the background, with no Windows service and no administrator. Once, before: setup (the guide shows
# it). The pid, the state and the log stay in private\ (only this user reads it). Only an OUTBOUND connection to the
# server; no port is opened here. Corporate proxy: HTTPS_PROXY (node starts with --use-env-proxy); corporate CA:
# --use-system-ca.
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
  # The node of the pack (-NodeExe), SSAM_NODE, or the node on the PATH.
  $candidates = @((Join-Path $PSScriptRoot 'node\node.exe'), $env:SSAM_NODE)
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'Node not found: install Node 24 (docs\AGENTE-CLIENTE.md) or set SSAM_NODE.'
}

function Read-State {
  if (-not (Test-Path $stateFile)) { return $null }
  try { return Get-Content $stateFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-AgentProcess([int]$id) {
  if ($id -le 0) { return $null }
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  # A pid reused by another program does not count as the agent.
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
    2 { return 'credential refused, revoked, expired or replaced by the server owner: ask for a new one and run setup again' }
    3 { return 'another agent with the same credential took over this account' }
    4 { return 'the server does not accept this agent version: ask the server owner for the current pack' }
    default { return ('see the log {0}; to see the error on screen: node "{1}" run --root "{2}"' -f $logFile, $script, $root) }
  }
}

switch ($Action) {
  'start' {
    $running = Get-Running
    if ($running) { Write-Output ("Already running: pid {0}. Log: {1}" -f $running.Id, $logFile); exit 0 }
    if (-not (Test-Path (Join-Path $private 'credential')) -or -not (Test-Path (Join-Path $private 'config.json'))) {
      Write-Output 'The agent is not set up: run setup first (docs\AGENTE-CLIENTE.md).'; exit 1
    }
    Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
    $node = Get-Node
    # No redirection: Start-Process with -RedirectStandardOutput/-Error makes node inherit the handles of the caller, and
    # a call with captured output never returns. The agent writes its own log (--log-file).
    $arguments = @('--use-env-proxy', '--use-system-ca', ('"{0}"' -f $script), 'run', '--root', ('"{0}"' -f $root), '--log-file', ('"{0}"' -f $logFile))
    $proc = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
    Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
    # It counts as up only when the saved state is of the process started now (same pid) and says connected.
    $deadline = (Get-Date).AddSeconds(30)
    $state = $null
    while ((Get-Date) -lt $deadline) {
      $state = Read-State
      if ($state -and [int]$state.pid -eq $proc.Id -and $state.state -eq 'connected') {
        Write-Output ("Agent connected: pid {0}, server {1}. Log: {2}" -f $proc.Id, $state.server, $logFile); exit 0
      }
      if ($proc.HasExited) { break }
      Start-Sleep -Milliseconds 300
    }
    if ($proc.HasExited -or -not (Get-AgentProcess $proc.Id)) {
      $code = if ($state -and [int]$state.pid -eq $proc.Id -and $null -ne $state.exitCode) { [int]$state.exitCode } else { 1 }
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
      Write-Output ("The agent stopped (code {0}): {1}" -f $code, (Get-ExitText $code)); exit 1
    }
    Write-Output ("Agent started (pid {0}), not connected to the server yet; it keeps trying. See status and the log {1}" -f $proc.Id, $logFile)
    exit 0
  }
  'status' {
    $running = Get-Running
    $state = Read-State
    if (-not $running) {
      $last = if ($state -and $null -ne $state.exitCode -and [int]$state.exitCode -ne 0) { ' Last stop: ' + (Get-ExitText ([int]$state.exitCode)) + '.' } else { '' }
      Write-Output ("Stopped.{0}" -f $last); exit 3
    }
    $since = if ($state) { $state.at } else { '?' }
    $now = if ($state) { $state.state } else { '?' }
    Write-Output ("Running: pid {0}, state {1} (since {2}). Log: {3}" -f $running.Id, $now, $since, $logFile)
    exit 0
  }
  'stop' {
    $running = Get-Running
    if (-not $running) { Write-Output 'Already stopped.'; Remove-Item $pidFile, $stopFile -Force -ErrorAction SilentlyContinue; exit 0 }
    # Clean stop: the agent sees private\agent.stop, tells the server and exits; after 5 s it is ended by force.
    Set-Content -Path $stopFile -Value 'stop' -Encoding ascii
    if (-not $running.WaitForExit(5000)) { Stop-Process -Id $running.Id -Force -Confirm:$false }
    Remove-Item $pidFile, $stopFile -Force -ErrorAction SilentlyContinue
    Write-Output ("Stopped: pid {0}" -f $running.Id)
    exit 0
  }
}
