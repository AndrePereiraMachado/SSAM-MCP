param([ValidateSet('Protect','Unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
$value = [Console]::In.ReadToEnd()
if ($Mode -eq 'Protect') {
    ConvertFrom-SecureString (ConvertTo-SecureString $value -AsPlainText -Force)
} else {
    $secure = ConvertTo-SecureString $value
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
