# Versioned DPAPI with application-specific entropy and purpose separation.
Add-Type -AssemblyName System.Security
function Get-VigiaEntropy([string]$Purpose) { return [Text.Encoding]::UTF8.GetBytes('SSAM.Vigia.v2|' + $Purpose) }
function Protect-VigiaValue([string]$Value, [string]$Purpose = 'vault') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    return [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,(Get-VigiaEntropy $Purpose),[Security.Cryptography.DataProtectionScope]::CurrentUser))
}
function Unprotect-VigiaValue([string]$Value, [string]$Purpose = 'vault') {
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($Value),(Get-VigiaEntropy $Purpose),[Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [Text.Encoding]::UTF8.GetString($bytes)
}
function Assert-VigiaNormalProfile {
    if ($env:LOCALAPPDATA -match '(?i)[\\/]Packages[\\/]' -or $env:APPX_PACKAGE_FAMILY_NAME) {
        throw 'Open a normal Windows PowerShell terminal outside the MSIX app to configure watcher secrets.'
    }
}
function Read-VigiaVault([string]$Vault) {
    if (-not (Test-Path -LiteralPath $Vault -PathType Leaf)) { throw 'Watcher secrets are missing. Run set-secrets.ps1 as the task owner.' }
    $encrypted = Get-Content -LiteralPath $Vault -Raw | ConvertFrom-Json
    if ($encrypted.schema -ne 2) { throw 'Unsupported vault format; migrate secrets in a normal owner terminal.' }
    $values = @{}
    foreach ($property in $encrypted.values.PSObject.Properties) { $values[$property.Name] = Unprotect-VigiaValue $property.Value }
    return $values
}
