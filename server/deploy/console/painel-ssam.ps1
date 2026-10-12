<#
.SYNOPSIS
  Opens the SSAM owner console ("Painel do dono") of the VPS through an SSH tunnel (deploy/DEPLOY.md section 15).

.DESCRIPTION
  The console listens only on 127.0.0.1:7320 of the VPS (systemd ssam-console-proxy.socket -> the console's unix
  socket). This script, on the owner's Windows PC:
    1. reads the console's current access key over SSH (/var/lib/ssam-console/state/access.key) into a variable;
    2. opens the tunnel: ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote> (ExitOnForwardFailure, ServerAlive);
    3. waits for http://127.0.0.1:<local>/healthz;
    4. rotates the key for this session (POST /api/key/rotate): a key left in the browser history by an earlier run is
       dead from now on;
    5. opens http://localhost:<local>/#k=<new key> in the default browser (the page drops the fragment at once);
    6. waits for Enter or q (or for the tunnel to drop), then rotates the key again (the session key dies with the
       tunnel) and stops ssh.
  One session at a time: a second run rotates the key and the first browser tab shows "chave invalida".
  The key is never printed. -DryRun prints the two ssh command lines (key path, no secret) and runs nothing.
  Exit codes: 0 ok, 1 bad arguments or no ssh, 2 console not running (no key), 3 SSH or tunnel failed, 4 console
  answered with an error.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File server\deploy\console\painel-ssam.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File server\deploy\console\painel-ssam.ps1 -DryRun
#>
param(
    [string]$VpsHost = $(if ($env:SSAM_VPS_HOST) { $env:SSAM_VPS_HOST } else { '187.127.8.241' }),
    [string]$User = 'root',
    [string]$Key = (Join-Path $env:USERPROFILE '.ssh\ssam_vps'),
    [int]$LocalPort = 7320,
    [int]$RemotePort = 7320,
    [switch]$NoBrowser,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$KeyFile = '/var/lib/ssam-console/state/access.key'
$KeyPattern = '^[A-Za-z0-9_-]{43}$'
$LastLocalPort = 7339

function Fail([int]$Code, [string]$Message) {
    [Console]::Error.WriteLine($Message)
    exit $Code
}

# Windows command-line quoting (CommandLineToArgvW rules), for ProcessStartInfo.Arguments and Start-Process.
function ConvertTo-ArgumentString([string[]]$Items) {
    $parts = foreach ($item in $Items) {
        if ($item -ne '' -and $item -notmatch '[\s"]') { $item; continue }
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append('"')
        $slashes = 0
        foreach ($ch in $item.ToCharArray()) {
            if ($ch -eq '\') { $slashes++; continue }
            if ($ch -eq '"') { [void]$sb.Append('\' * ($slashes * 2 + 1)); [void]$sb.Append('"') }
            else { if ($slashes) { [void]$sb.Append('\' * $slashes) }; [void]$sb.Append($ch) }
            $slashes = 0
        }
        if ($slashes) { [void]$sb.Append('\' * ($slashes * 2)) }
        [void]$sb.Append('"')
        $sb.ToString()
    }
    return ($parts -join ' ')
}

function Test-LocalPortFree([int]$Port) {
    $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, $Port)
    try { $listener.Start(); return $true } catch { return $false } finally { try { $listener.Stop() } catch { } }
}

# Runs a program, captures stdout and stderr (nothing reaches the console).
function Invoke-Captured([string]$Exe, [string[]]$Arguments) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = ConvertTo-ArgumentString $Arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.StandardInput.Close()
    $errTask = $proc.StandardError.ReadToEndAsync()
    $out = $proc.StandardOutput.ReadToEnd()
    $proc.WaitForExit()
    return [pscustomobject]@{ Code = $proc.ExitCode; Out = $out; Err = $errTask.Result }
}

# One request to the console through the tunnel (no proxy). Returns status code and body; never throws for HTTP errors.
function Invoke-Console([int]$Port, [string]$Method, [string]$Path, [string]$AccessKey, [int]$TimeoutMs = 5000) {
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port$Path")
    $request.Method = $Method
    $request.Proxy = $null
    $request.Timeout = $TimeoutMs
    $request.ReadWriteTimeout = $TimeoutMs
    $request.KeepAlive = $false
    if ($AccessKey) { $request.Headers.Add('X-SSAM-Console-Key', $AccessKey) }
    $response = $null
    try {
        if ($Method -eq 'POST') {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes('{}')
            $request.ContentType = 'application/json'
            $request.ContentLength = $bytes.Length
            $stream = $request.GetRequestStream()
            try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Close() }
        }
        $response = $request.GetResponse()
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) { $response = $_.Exception.Response } else { return [pscustomobject]@{ Status = 0; Body = '' } }
    } catch {
        return [pscustomobject]@{ Status = 0; Body = '' }
    }
    try {
        $reader = New-Object System.IO.StreamReader ($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd()
        return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $body }
    } finally {
        $response.Close()
    }
}

# POST /api/key/rotate with the current key -> the new key (validated), or $null.
function Invoke-KeyRotate([int]$Port, [string]$AccessKey) {
    $answer = Invoke-Console -Port $Port -Method 'POST' -Path '/api/key/rotate' -AccessKey $AccessKey
    if ($answer.Status -ne 200) { return [pscustomobject]@{ Key = $null; Status = $answer.Status } }
    try { $json = $answer.Body | ConvertFrom-Json } catch { return [pscustomobject]@{ Key = $null; Status = $answer.Status } }
    $newKey = $null
    if ($json -and ($json.PSObject.Properties.Name -contains 'key')) { $newKey = [string]$json.key }
    if (-not $newKey -or $newKey -notmatch $KeyPattern) { return [pscustomobject]@{ Key = $null; Status = $answer.Status } }
    return [pscustomobject]@{ Key = $newKey; Status = 200 }
}

# ---------------------------------------------------------------------------------------------------------- arguments
if ($VpsHost -notmatch '^[A-Za-z0-9.:_-]{1,253}$') { Fail 1 "Endereco da VPS invalido: $VpsHost" }
if ($User -notmatch '^[A-Za-z0-9._-]{1,32}$') { Fail 1 "Usuario SSH invalido: $User" }
if ($LocalPort -lt 1024 -or $LocalPort -gt 65535 -or $RemotePort -lt 1 -or $RemotePort -gt 65535) { Fail 1 'Porta invalida.' }
if ($LocalPort -le $LastLocalPort) { $lastPort = $LastLocalPort } else { $lastPort = $LocalPort }

$ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path -LiteralPath $ssh)) {
    $found = Get-Command ssh.exe -ErrorAction SilentlyContinue
    if ($found) { $ssh = $found.Source } elseif (-not $DryRun) { Fail 1 'ssh.exe nao encontrado (instale o cliente OpenSSH do Windows).' }
}
if (-not $DryRun -and -not (Test-Path -LiteralPath $Key)) { Fail 1 "Chave SSH nao encontrada: $Key" }

$local = $null
for ($p = $LocalPort; $p -le $lastPort; $p++) {
    if (Test-LocalPortFree $p) { $local = $p; break }
}
if (-not $local) { Fail 1 "Nenhuma porta livre entre $LocalPort e $lastPort em 127.0.0.1." }

$target = "$User@$VpsHost"
$readArgs = @('-i', $Key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', $target, "cat $KeyFile")
$tunnelArgs = @('-N', '-T', '-n', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', $Key, '-L', "127.0.0.1:${local}:127.0.0.1:$RemotePort", $target)

if ($DryRun) {
    Write-Host 'Painel SSAM - simulacao (-DryRun): nada sera executado.'
    Write-Host ("1. ler a chave atual: {0} {1}" -f $ssh, (ConvertTo-ArgumentString $readArgs))
    Write-Host ("2. abrir o tunel:     {0} {1}" -f $ssh, (ConvertTo-ArgumentString $tunnelArgs))
    Write-Host ("3. esperar http://127.0.0.1:{0}/healthz, trocar a chave (POST /api/key/rotate) e abrir http://localhost:{0}/#k=<chave nova>" -f $local)
    Write-Host '4. Enter ou q: trocar a chave de novo e fechar o tunel.'
    exit 0
}

# ------------------------------------------------------------------------------------------------------- access key
$read = Invoke-Captured $ssh $readArgs
if ($read.Code -ne 0) {
    if ($read.Err -match 'No such file') { Fail 2 'O painel nao esta rodando na VPS (chave ausente). Veja DEPLOY.md secao 15.' }
    $detail = (($read.Err -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -Last 1)
    Fail 3 ("Falha no SSH para {0} (codigo {1}): {2}" -f $target, $read.Code, $detail)
}
$currentKey = $read.Out.Trim()
$read = $null
if ($currentKey -notmatch $KeyPattern) {
    $currentKey = $null
    Fail 4 'A chave de acesso do painel na VPS esta em formato inesperado. Veja DEPLOY.md secao 15.'
}

# ----------------------------------------------------------------------------------------------------------- tunnel
$tunnel = $null
$exitCode = 0
try { do {
    $tunnel = Start-Process -FilePath $ssh -ArgumentList (ConvertTo-ArgumentString $tunnelArgs) -PassThru -NoNewWindow
    $null = $tunnel.Handle  # keeps the handle, so ExitCode is readable after ssh exits
    $healthy = $false
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        if ($tunnel.HasExited) { break }
        $probe = Invoke-Console -Port $local -Method 'GET' -Path '/healthz' -AccessKey $null -TimeoutMs 2000
        if ($probe.Status -eq 200) { $healthy = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $healthy) {
        if ($tunnel.HasExited) {
            [Console]::Error.WriteLine(("O tunel SSH nao abriu (ssh saiu com codigo {0}). A porta {1} desta maquina ou a {2} da VPS esta ocupada?" -f $tunnel.ExitCode, $local, $RemotePort))
        } else {
            [Console]::Error.WriteLine("O painel nao respondeu em 15 s pelo tunel (/healthz). Na VPS: systemctl status ssam-console-proxy.socket e docker compose -f compose.prod.yml ps ssam-console.")
        }
        $exitCode = 3
        break
    }

    $rotated = Invoke-KeyRotate -Port $local -AccessKey $currentKey
    if (-not $rotated.Key) {
        if ($rotated.Status -eq 401) {
            [Console]::Error.WriteLine('O painel recusou a chave lida da VPS (401). Ele reiniciou agora? Rode de novo.')
        } else {
            [Console]::Error.WriteLine(("Nao foi possivel trocar a chave do painel (HTTP {0})." -f $rotated.Status))
        }
        $exitCode = 4
        break
    }
    $currentKey = $rotated.Key
    $rotated = $null

    if ($NoBrowser) {
        Write-Host ("Painel em http://localhost:{0} (sem a chave). Rode sem -NoBrowser para abrir o navegador com a chave desta sessao." -f $local)
    } else {
        Start-Process ("http://localhost:{0}/#k={1}" -f $local, $currentKey)
    }
    Write-Host ("Painel aberto em http://localhost:{0}. Enter fecha o tunel." -f $local)

    $interactive = $true
    try { [void][Console]::KeyAvailable } catch { $interactive = $false }
    while ($true) {
        if ($tunnel.HasExited) {
            Write-Host ("O tunel SSH caiu (ssh saiu com codigo {0})." -f $tunnel.ExitCode)
            $exitCode = 3
            break
        }
        if ($interactive) {
            if ([Console]::KeyAvailable) {
                $pressed = [Console]::ReadKey($true)
                if ($pressed.Key -eq [ConsoleKey]::Enter -or $pressed.KeyChar -eq 'q' -or $pressed.KeyChar -eq 'Q') { break }
            }
            Start-Sleep -Milliseconds 200
        } else {
            [void][Console]::In.ReadLine()
            break
        }
    }
} while ($false) } finally {
    if ($tunnel -and -not $tunnel.HasExited) {
        if ($currentKey) {
            # The session key dies with the tunnel (best effort; the answer, with a new key, is discarded).
            try { [void](Invoke-KeyRotate -Port $local -AccessKey $currentKey) } catch { }
        }
        try { Stop-Process -Id $tunnel.Id -Force -ErrorAction Stop } catch { }
    }
    $currentKey = $null
    if ($tunnel) { Write-Host 'Tunel fechado.' }
}
exit $exitCode
