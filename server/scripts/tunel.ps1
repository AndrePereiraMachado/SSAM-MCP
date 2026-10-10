# Tunel rapido na frente do servidor HOSPEDADO (docs\FASE2-AGENTE.md 9.1; docs\PROVAS-AO-VIVO.md). So o dono roda.
#   .\scripts\tunel.ps1 start  [--port 7300] [--cloudflared <cloudflared.exe>]
#   .\scripts\tunel.ps1 status
#   .\scripts\tunel.ps1 stop   [--server]
#   .\scripts\tunel.ps1 config [--url https://<host>]
#   .\scripts\tunel.ps1 plan   [--port 7300]          mostra os comandos do start sem rodar nada
# Repassa tudo para scripts\tunel.mjs com o Node desta maquina (mesma ordem do servidor.ps1: SSAM_NODE, o runtime Codex,
# o node do PATH). O servidor escuta so em 127.0.0.1; o cloudflared abre uma conexao de SAIDA e mostra a URL publica
# https://<aleatorio>.trycloudflare.com, que muda a cada start.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$candidates = @($env:SSAM_NODE, (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
$node = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $node) { $cmd = Get-Command node -ErrorAction SilentlyContinue; if ($cmd) { $node = $cmd.Source } }
if (-not $node) { throw 'Node nao encontrado: defina SSAM_NODE ou rode scripts\setup-dev.ps1.' }
& $node (Join-Path $root 'scripts\tunel.mjs') @args
exit $LASTEXITCODE
