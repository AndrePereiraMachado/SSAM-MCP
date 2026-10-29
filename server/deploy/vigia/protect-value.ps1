param([ValidateSet('Protect','Unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\vault.ps1"
$value = [Console]::In.ReadToEnd()
if ($Mode -eq 'Protect') { [Console]::Write((Protect-VigiaValue $value 'snapshot')) }
else { [Console]::Write((Unprotect-VigiaValue $value 'snapshot')) }
