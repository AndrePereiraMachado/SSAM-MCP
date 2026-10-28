# Dot-source only. DPAPI CurrentUser binds every value to the task owner.
function Read-VigiaVault([string]$Vault) {
    if (-not (Test-Path -LiteralPath $Vault -PathType Leaf)) { throw 'Watcher secrets are missing. Run set-secrets.ps1 as the task owner.' }
    $encrypted = Get-Content -LiteralPath $Vault -Raw | ConvertFrom-Json
    $values = @{}
    foreach ($property in $encrypted.PSObject.Properties) {
        $secure = ConvertTo-SecureString $property.Value
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $values[$property.Name] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    }
    return $values
}
