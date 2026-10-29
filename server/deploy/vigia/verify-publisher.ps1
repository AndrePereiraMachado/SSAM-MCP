param([Parameter(Mandatory)][string]$File)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $File
# Observed on the installed, signed ODCStudio.exe; renewal requires review.
$pinnedPublisher = 'B3980F207C99E04BE91F80D498A9C5C7E317B31B'
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $pinnedPublisher -or $signature.SignerCertificate.Subject -notmatch 'O="?OutSystems, Inc\.') {
    throw 'Studio input does not have the pinned valid OutSystems Authenticode signature.'
}
Write-Output 'OutSystems publisher verified.'
