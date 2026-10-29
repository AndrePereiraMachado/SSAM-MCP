param(
    [string]$Vault = "$env:LOCALAPPDATA\SSAM\vigia\secrets.dpapi.json",
    [string]$Node = 'C:\Users\andre\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\vault.ps1"
Assert-VigiaNormalProfile
$parent = Split-Path -Parent ([IO.Path]::GetFullPath($Vault))
if (Test-Path -LiteralPath $Vault) { throw 'A vault already exists. Preserve its signing key; move it privately before intentional rotation.' }
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $parent /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict the vault directory.' }
$values = @{}
foreach ($item in @(
    @('coolifyToken','Coolify API token'),
    @('sshPrivateKey','SSH private key as base64 of the complete key file'),
    @('authenticodeThumbprint','Authenticode signing certificate thumbprint'),
    @('webhookUrl','Optional webhook URL (Enter to disable)')
)) {
    $secure = Read-Host $item[1] -AsSecureString
    if ($secure.Length -eq 0) {
        if ($item[0] -ne 'webhookUrl') { throw 'A required secret is empty.' }
        continue
    }
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $values[$item[0]] = Protect-VigiaValue ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
$pair = & $Node (Join-Path $PSScriptRoot 'key-pair.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Cannot generate the Ed25519 signing key.' }
$keys = $pair | ConvertFrom-Json
$values.manifestPrivateKey = Protect-VigiaValue $keys.privateKey
[IO.File]::WriteAllText($Vault, (@{schema=2;values=$values} | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
# Only the public key is displayed. Pin it in the agent before enabling updates.
Write-Output $keys.publicKey
$keys = $null; $pair = $null; $values = $null
