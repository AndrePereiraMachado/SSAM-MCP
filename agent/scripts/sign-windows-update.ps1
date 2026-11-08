# Signs the update statement of a Windows build of the SSAM Agent app (app 0.2.8) with the vigia vault's manifest key, the
# Ed25519 key whose public half the build pinned (--trust-public-key). Run it in a normal Windows PowerShell terminal of the
# account that ran server/deploy/vigia/set-secrets.ps1, after `node scripts/build.mjs --platform win ...` and before copying
# dist/ to the update server:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sign-windows-update.ps1 -Dist dist -ExpectPublicKey <pinned.pem>
# The private key is decrypted here (DPAPI; only that one value of the vault, never the other secrets) and goes to
# sign-windows-update.mjs on its standard input only: never an argument, an environment variable or a file, and never
# printed. The process that receives it is the node.exe named by -Node, an absolute path (default the Node.js install in
# Program Files): never one found through PATH or the current directory. Only public facts are written (file names, version
# and the SHA-256 of the public key).
param(
    [Parameter(Mandatory = $true)][string]$Dist,
    [Parameter(Mandatory = $true)][string]$ExpectPublicKey,
    [string]$Vault = "$env:LOCALAPPDATA\SSAM\vigia\secrets.dpapi.json",
    [string]$Node = 'C:\Program Files\nodejs\node.exe'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Checked before the vault is touched.
if (-not [IO.Path]::IsPathRooted($Node) -or $Node.StartsWith('\\') -or [IO.Path]::GetFileName($Node) -ine 'node.exe') {
    throw 'Give -Node as the absolute path of node.exe (for example C:\Program Files\nodejs\node.exe); it is never looked up through PATH or the current directory.'
}
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw "There is no node.exe at $Node; give -Node <absolute path of node.exe>." }
if (-not (Test-Path -LiteralPath $ExpectPublicKey -PathType Leaf)) { throw 'The pinned public key file given by -ExpectPublicKey does not exist.' }
if (-not (Test-Path -LiteralPath (Join-Path $Dist 'latest.yml') -PathType Leaf)) { throw 'The build output has no latest.yml; run the Windows build first.' }
$app = Split-Path $PSScriptRoot -Parent
. (Join-Path $app '..\server\deploy\vigia\vault.ps1')
Assert-VigiaNormalProfile
$arguments = @((Join-Path $PSScriptRoot 'sign-windows-update.mjs'), '--dist', [IO.Path]::GetFullPath($Dist), '--expect-public-key', [IO.Path]::GetFullPath($ExpectPublicKey))
if (-not (Test-Path -LiteralPath $Vault -PathType Leaf)) { throw 'Watcher secrets are missing. Run set-secrets.ps1 as the task owner.' }
$encrypted = Get-Content -LiteralPath $Vault -Raw | ConvertFrom-Json
if ($encrypted.schema -ne 2) { throw 'Unsupported vault format; migrate secrets in a normal owner terminal.' }
$sealed = $encrypted.values.PSObject.Properties['manifestPrivateKey']
if ($null -eq $sealed) { throw 'The vigia vault has no manifestPrivateKey; run set-secrets.ps1 as its owner.' }
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $Node
$start.Arguments = ($arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.CreateNoWindow = $true
$process = [Diagnostics.Process]::Start($start)
# Both streams are drained at once, so a long error output cannot block the child while this script waits on the other.
$errorsTask = $process.StandardError.ReadToEndAsync()
$outputTask = $process.StandardOutput.ReadToEndAsync()
$key = $null
try {
    $key = Unprotect-VigiaValue $sealed.Value
    $process.StandardInput.Write($key)
} finally {
    $key = $null
    $process.StandardInput.Close()
}
$process.WaitForExit()
$output = $outputTask.Result
$errors = $errorsTask.Result
if ($process.ExitCode -ne 0) { throw "The update statement was not written: $errors" }
Write-Output $output
