param([string]$Vault = "$env:LOCALAPPDATA\SSAM\vigia\secrets.dpapi.json")
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\vault.ps1"
# This output is a private child-process pipe, never a console or a log.
Read-VigiaVault $Vault | ConvertTo-Json -Compress
