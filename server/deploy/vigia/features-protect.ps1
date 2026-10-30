param([Parameter(Mandatory)][string]$Plain,[Parameter(Mandatory)][string]$OutDir)
# The inverse of ../odc-features-export.ps1: turns a Features.plain.xml (the store keeps one per ODC version) into the
# Features.xml a Windows ODC Studio keeps (DPAPI, current Windows user, no entropy, base64), in a private folder the
# kernel tests read through ANVIL_ODC_FEATURES_DIR. Run as the same Windows user as the tests. Prints nothing secret.
$ErrorActionPreference='Stop'
if(-not (Test-Path -LiteralPath $Plain)){throw "no Features.plain.xml at $Plain"}
Add-Type -AssemblyName System.Security
$bytes=[IO.File]::ReadAllBytes($Plain)
$xml=[xml][Text.Encoding]::UTF8.GetString($bytes)
if($xml.DocumentElement.Name -ne 'Features'){throw "$Plain is not a <Features> document"}
$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
New-Item -ItemType Directory -Force $OutDir | Out-Null
[IO.File]::WriteAllText((Join-Path $OutDir 'Features.xml'),[Convert]::ToBase64String($protected),(New-Object Text.UTF8Encoding $false))
Write-Host ("Features.xml written for this Windows user: {0} features" -f @($xml.DocumentElement.SelectNodes('Feature')).Count)
