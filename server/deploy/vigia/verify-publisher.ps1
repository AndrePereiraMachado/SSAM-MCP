param([Parameter(Mandatory)][string]$File)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\authenticode-chain.ps1"
$signature = Get-AuthenticodeSignature -LiteralPath $File
$pins = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'publisher-pins.json') -Raw | ConvertFrom-Json
$chain = Get-VerifiedAuthenticodeChain $File $signature
$ca = $chain.ChainElements[1].Certificate.Thumbprint
$matches = @($pins.outsystems | Where-Object { $_.subject -ceq $signature.SignerCertificate.Subject -and $_.ca -eq $ca })
if ($matches.Count -ne 1) {
    throw 'Installer does not match the reviewed OutSystems subject and CA pins.'
}
@{status='Valid';subject=$signature.SignerCertificate.Subject;ca=$ca;thumbprint=$signature.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress
