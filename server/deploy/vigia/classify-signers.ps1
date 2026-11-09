# bridgeMode ed25519-offers: the signer class of every executable of a compiled client bridge, by VERIFICATION ONLY. Nothing here
# signs, reads the vault or a private key, imports a certificate or changes a file: the owner's files carry no Authenticode
# signature (app 0.2.8 trusts them by the Ed25519 manifest that names their size and SHA-256), and the Microsoft dependencies keep
# the signature they were restored with.
#   owner:     a TargetPath output of the build (build-evidence.json "owned"), byte for byte as recorded.
#   microsoft: any other dll/exe; it must be the exact bytes of a restored NuGet package (build-evidence.json "dependencies", the
#              package file re-hashed now), with a valid Authenticode signature whose signer organization is Microsoft
#              Corporation, with the code-signing usage, verified at its signing time to a pinned Microsoft root (publisher-pins.json
#              microsoftRoots by thumbprint and microsoftRootsSha256 by SHA-256, the agent's BRIDGE_MICROSOFT_ROOTS).
# An owner entry point (ODC3.*, Anvil.*, anything under hook/) is never classified microsoft: the agent refuses that label. Any
# other signer, an unsigned dependency or bytes that match no restored package stop the round for integrator review.
# Output: one JSON array [{path, signer}] on stdout, for the manifest (auto-runtime.mjs buildBridges).
param(
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory)][string]$BuildEvidence
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot\authenticode-chain.ps1"
$evidence = Get-Content -LiteralPath $BuildEvidence -Raw | ConvertFrom-Json
$pins = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'publisher-pins.json') -Raw | ConvertFrom-Json
$root = (Resolve-Path -LiteralPath $ArtifactDirectory).Path.TrimEnd('\')
$codeSigning = '1.3.6.1.5.5.7.3.3'
function Sha256Hex([byte[]]$Bytes) { [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($Bytes)).Replace('-', '') }
$records = @()
foreach ($file in @(Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Extension -in '.dll', '.exe' } | Sort-Object FullName)) {
    $relative = $file.FullName.Substring($root.Length).TrimStart('\').Replace('\', '/')
    $digest = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $owned = $evidence.owned.PSObject.Properties[$relative]
    if ($null -ne $owned) {
        if ($digest -ne $owned.Value) { throw "Build output changed after it was recorded: $relative" }
        $records += [ordered]@{ path = $relative; signer = 'owner' }
        continue
    }
    if ($relative -match '(^|/)(odc3\.|anvil\.)|^hook/') { throw "An owner entry point is not a recorded build output: $relative" }
    $dependency = $evidence.dependencies.PSObject.Properties[$relative]
    if ($null -eq $dependency -or $dependency.Value.sha256 -ne $digest -or
        (Get-FileHash -LiteralPath $dependency.Value.source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) {
        throw "Dependency differs from restored NuGet bytes: $relative"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($null -eq $signature.SignerCertificate -or [string]$signature.Status -eq 'NotSigned') { throw "Dependency is not signed: $relative" }
    # Exactly one O= and exactly Microsoft Corporation, as the agent requires (AuthenticodeTrust.cs): a subject with two O= values
    # is refused here too, never signed into a manifest the agent then refuses.
    if (-not [string]::Equals((Get-SingleOrganization $signature.SignerCertificate), 'Microsoft Corporation', [StringComparison]::Ordinal)) { throw "Unsupported dependency signer; report it to the integrator: $relative" }
    $usages = @($signature.SignerCertificate.Extensions | Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } |
        ForEach-Object { $_.EnhancedKeyUsages } | Where-Object { $_.Value -eq $codeSigning })
    if ($usages.Count -eq 0) { throw "Dependency signer has no code-signing usage: $relative" }
    # Valid at its signing time, revocation checked online (REVOCATION_UNAVAILABLE: the round waits).
    $chain = Get-VerifiedAuthenticodeChain $file.FullName $signature
    $top = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate
    if ($pins.microsoftRoots -notcontains $top.Thumbprint -or $pins.microsoftRootsSha256 -notcontains (Sha256Hex $top.RawData)) {
        throw "Microsoft dependency root is not pinned: $relative"
    }
    $records += [ordered]@{ path = $relative; signer = 'microsoft' }
}
ConvertTo-Json -InputObject @($records) -Compress
