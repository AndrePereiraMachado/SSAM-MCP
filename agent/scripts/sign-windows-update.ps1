# Signs the update statement of a Windows build of the SSAM Agent app (app 0.2.8) with the vigia vault's manifest key, the
# Ed25519 key whose public half the build pinned (--trust-public-key). Run it in a normal Windows PowerShell terminal of the
# account that ran server/deploy/vigia/set-secrets.ps1, after `node scripts/build.mjs --platform win ...` and before copying
# dist/ to the update server:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sign-windows-update.ps1 -Dist dist -ExpectPublicKey <pinned.pem>
# The private key is decrypted here (DPAPI) and goes to sign-windows-update.mjs on its standard input only: never an
# argument, an environment variable or a file, and never printed. Only public facts are written (file names, version and the
# SHA-256 of the public key).
param(
    [Parameter(Mandatory = $true)][string]$Dist,
    [string]$ExpectPublicKey,
    [string]$Vault = "$env:LOCALAPPDATA\SSAM\vigia\secrets.dpapi.json",
    [string]$Node = 'node'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$app = Split-Path $PSScriptRoot -Parent
. (Join-Path $app '..\server\deploy\vigia\vault.ps1')
Assert-VigiaNormalProfile
if (-not (Test-Path -LiteralPath (Join-Path $Dist 'latest.yml') -PathType Leaf)) { throw 'The build output has no latest.yml; run the Windows build first.' }
$arguments = @((Join-Path $PSScriptRoot 'sign-windows-update.mjs'), '--dist', [IO.Path]::GetFullPath($Dist))
if ($ExpectPublicKey) { $arguments += @('--expect-public-key', [IO.Path]::GetFullPath($ExpectPublicKey)) }
$secrets = Read-VigiaVault $Vault
if (-not $secrets.ContainsKey('manifestPrivateKey')) { $secrets = $null; throw 'The vigia vault has no manifestPrivateKey; run set-secrets.ps1 as its owner.' }
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $Node
$start.Arguments = ($arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.CreateNoWindow = $true
$process = [Diagnostics.Process]::Start($start)
try {
    $process.StandardInput.Write($secrets.manifestPrivateKey)
    $process.StandardInput.Close()
} finally { $secrets = $null }
$output = $process.StandardOutput.ReadToEnd()
$errors = $process.StandardError.ReadToEnd()
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw "The update statement was not written: $errors" }
Write-Output $output
