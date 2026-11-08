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
    @('authenticodeThumbprint','Authenticode signing certificate thumbprint (Enter for none: bridgeMode server-only signs no client bridge)'),
    @('webhookUrl','Optional webhook URL (Enter to disable)')
)) {
    $secure = Read-Host $item[1] -AsSecureString
    if ($secure.Length -eq 0) {
        # Optional: the webhook, and the thumbprint (empty = none; only bridgeMode signed-offers requires one).
        if ($item[0] -notin @('webhookUrl','authenticodeThumbprint')) { throw 'A required secret is empty.' }
        continue
    }
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        if ($item[0] -eq 'authenticodeThumbprint' -and $plain -notmatch '^[a-fA-F0-9]{40}$') { throw 'The Authenticode thumbprint must be 40 hexadecimal characters (or empty for none).' }
        $values[$item[0]] = Protect-VigiaValue $plain
    }
    finally { $plain = $null; [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
$pair = & $Node (Join-Path $PSScriptRoot 'key-pair.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Cannot generate the Ed25519 signing key.' }
$keys = $pair | ConvertFrom-Json
$random = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($random); $rng.Dispose()
$values.journalKey = Protect-VigiaValue ([Convert]::ToBase64String($random))
$values.manifestPrivateKey = Protect-VigiaValue $keys.privateKey
[IO.File]::WriteAllText($Vault, (@{schema=2;values=$values} | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
# Only the public key is displayed. Pin it in the agent before enabling updates.
Write-Output $keys.publicKey
$keys = $null; $pair = $null; $values = $null
