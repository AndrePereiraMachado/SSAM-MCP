param([Parameter(Mandatory)][string]$Vault)
$ErrorActionPreference='Stop'
. "$PSScriptRoot\vault.ps1"
Assert-VigiaNormalProfile
. "$PSScriptRoot\execution-trust.ps1" -PrivatePaths $Vault
$data=Get-Content -LiteralPath $Vault -Raw | ConvertFrom-Json
if($data.schema -ne 2){throw 'Unsupported vault schema.'}
if($data.values.PSObject.Properties['journalKey']){throw 'Journal key already exists; it must not be rotated implicitly.'}
$bytes=New-Object byte[] 32
$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
$data.values | Add-Member NoteProperty journalKey (Protect-VigiaValue ([Convert]::ToBase64String($bytes)))
# Existing encrypted values remain encrypted and unchanged, including the manifest key.
[IO.File]::WriteAllText(($Vault+'.next'),($data | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
Move-Item -LiteralPath ($Vault+'.next') -Destination $Vault -Force
Write-Output 'Journal authentication initialized. Existing unsigned journals require owner review; they are not migrated automatically.'
