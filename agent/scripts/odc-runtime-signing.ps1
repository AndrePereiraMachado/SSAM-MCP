[CmdletBinding()]
param(
    [ValidateSet('Prepare', 'Sign', 'Verify', 'Activate')][string]$Mode = 'Prepare',
    [string]$BundleId,
    [string]$CertificateThumbprint,
    [ValidateSet('CurrentUser', 'LocalMachine')][string]$CertificateStore = 'CurrentUser',
    [string]$TimestampServer
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$workspace = Split-Path $PSScriptRoot -Parent
$odcRoot = Join-Path $workspace 'platforms\odc'
$bundleRoot = Join-Path $odcRoot '.local\signed-runtime'
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-Json($File, $Value) {
    [IO.File]::WriteAllText($File, ($Value | ConvertTo-Json -Depth 12), $utf8)
}
function Hash($File) { (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
function Version {
    $source = [IO.File]::ReadAllText((Join-Path $odcRoot 'studio\bridge\client\Program.cs'))
    if ($source -notmatch 'const string Version = "(v\d+)"') { throw 'Cannot identify the current ODC protocol.' }
    $Matches[1]
}
function Bundle-File($Relative) {
    if ($Relative -notmatch '^(client|bridge)/[A-Za-z0-9._-]+$') { throw 'Invalid bundle path.' }
    Join-Path $bundleDir $Relative
}

if ($Mode -eq 'Prepare') {
    if ($BundleId) { throw 'Prepare generates a new bundle ID; do not reuse a directory.' }
    $version = Version
    $clientDir = Join-Path $odcRoot 'studio\bridge\client\bin\Release\net10.0'
    $bridgeFile = Join-Path $odcRoot "studio\bridge\bin\Release\net8.0\ODC3.Bridge.$version.dll"
    $sourceFiles = @((Get-ChildItem -LiteralPath $clientDir -File | Where-Object { $_.Extension -in '.dll', '.json' } | ForEach-Object {
        @{ source = $_.FullName; path = 'client/' + $_.Name }
    })) + @(@{ source = $bridgeFile; path = "bridge/ODC3.Bridge.$version.dll" })
    foreach ($item in $sourceFiles) {
        if (-not (Test-Path -LiteralPath $item.source -PathType Leaf)) { throw "Missing built runtime: $($item.source)" }
    }
    $BundleId = [Guid]::NewGuid().ToString('N')
    $bundleDir = Join-Path $bundleRoot $BundleId
    New-Item -ItemType Directory -Path (Join-Path $bundleDir 'client'), (Join-Path $bundleDir 'bridge') | Out-Null
    $files = @(foreach ($item in $sourceFiles) {
        $target = Bundle-File $item.path
        Copy-Item -LiteralPath $item.source -Destination $target
        $digest = Hash $target
        if ($digest -ne (Hash $item.source)) { throw 'Source changed during preparation; preserve this bundle and prepare again.' }
        @{ path = $item.path; sourceSha256 = $digest }
    })
    Write-Json (Join-Path $bundleDir 'prepared.json') @{
        schema = 1; id = $BundleId; version = $version; files = $files
        createdAt = [DateTime]::UtcNow.ToString('o'); purpose = 'Signing only; not activated or loaded'
    }
    @{ ok = $true; state = 'awaiting_signature'; bundleId = $BundleId; directory = $bundleDir; version = $version } | ConvertTo-Json
    exit 0
}

if ($BundleId -notmatch '^[a-f0-9]{32}$') { throw 'Pass the exact -BundleId returned by Prepare.' }
$bundleDir = Join-Path $bundleRoot $BundleId
$plan = Get-Content -LiteralPath (Join-Path $bundleDir 'prepared.json') -Raw | ConvertFrom-Json
if ($plan.schema -ne 1 -or $plan.id -ne $BundleId -or $plan.version -ne (Version)) { throw 'Bundle identity/protocol differs from the current runtime.' }
$verifiedFile = Join-Path $bundleDir 'verified.json'
$expectedPaths = @($plan.files | ForEach-Object { $_.path })
if (($expectedPaths | Select-Object -Unique).Count -ne $expectedPaths.Count) { throw 'Duplicate bundle paths.' }
$required = @('client/ODC3.Bridge.Client.dll', 'client/ODC3.Bridge.Client.deps.json',
    'client/ODC3.Bridge.Client.runtimeconfig.json', 'client/Microsoft.Diagnostics.NETCore.Client.dll',
    "bridge/ODC3.Bridge.$($plan.version).dll")
foreach ($name in $required) { if ($expectedPaths -notcontains $name) { throw "Incomplete bundle: $name" } }
foreach ($folder in 'client', 'bridge') {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $bundleDir $folder) -Force) {
        if ($file.PSIsContainer -or $expectedPaths -notcontains ($folder + '/' + $file.Name)) { throw 'Unexpected file in the runtime bundle.' }
    }
}

if ($Mode -eq 'Sign') {
    if (Test-Path -LiteralPath $verifiedFile) { throw 'A verified bundle is immutable. Prepare another bundle for any change.' }
    if ($CertificateThumbprint -notmatch '^[a-fA-F0-9]{40}$') { throw 'A code-signing certificate thumbprint is required; no private key or password is accepted as an argument.' }
    if ($TimestampServer -notmatch '^http://[^\s]+$') { throw 'Pass the Authenticode HTTP timestamp URL supplied by your certificate provider.' }
    $cert = Get-Item -LiteralPath "Cert:\$CertificateStore\My\$CertificateThumbprint"
    if (-not $cert.HasPrivateKey -or $cert.Subject -eq $cert.Issuer -or -not $cert.Verify()) { throw 'A valid provider-issued code-signing certificate with a private key is required.' }
    if (@($cert.EnhancedKeyUsageList | Where-Object { $_.ObjectId.Value -eq '1.3.6.1.5.5.7.3.3' }).Count -eq 0) { throw 'Certificate does not allow code signing.' }
    foreach ($item in $plan.files) {
        $file = Bundle-File $item.path
        if ((Hash $file) -ne $item.sourceSha256) { throw 'Bundle changed since Prepare. Inspect existing signing results; prepare a new bundle instead of overwriting it.' }
    }
    foreach ($item in $plan.files) {
        if ($item.path -notlike '*.dll') { continue }
        $file = Bundle-File $item.path
        $signature = Get-AuthenticodeSignature -LiteralPath $file
        if ($signature.Status -eq 'Valid') { continue } # Preserve Microsoft signatures.
        if ($item.path -notmatch '^client/ODC3\.Bridge\.Client\.dll$|^bridge/ODC3\.Bridge\.v\d+\.dll$') { throw "Dependency requires its original publisher's valid signature: $($item.path)" }
        $result = Set-AuthenticodeSignature -LiteralPath $file -Certificate $cert -HashAlgorithm SHA256 -IncludeChain NotRoot -TimestampServer $TimestampServer
        if ($result.Status -ne 'Valid' -or $null -eq $result.TimeStamperCertificate) { throw "Signing or timestamp failed: $($item.path). Preserve this bundle for inspection." }
    }
    @{ ok = $true; state = 'signed_requires_verification'; bundleId = $BundleId } | ConvertTo-Json
    exit 0
}

# Read signature metadata, never load or execute a DLL for verification.
$files = @(foreach ($item in $plan.files) {
    $file = Bundle-File $item.path
    $digest = Hash $file
    if ($item.path -like '*.dll') {
        $signature = Get-AuthenticodeSignature -LiteralPath $file
        if ($signature.Status -ne 'Valid') { throw "Signature not valid: $($item.path) [$($signature.Status)]. Bundle remains unselected." }
        if ($signature.SignerCertificate.Subject -eq $signature.SignerCertificate.Issuer) { throw 'Self-signed leaf certificates are not accepted.' }
        @{ path = $item.path; sha256 = $digest; signature = 'Valid'; signer = $signature.SignerCertificate.Thumbprint }
    } else {
        if ($digest -ne $item.sourceSha256) { throw "Configuration changed after Prepare: $($item.path)" }
        @{ path = $item.path; sha256 = $digest }
    }
})
if (Test-Path -LiteralPath $verifiedFile) {
    $previous = Get-Content -LiteralPath $verifiedFile -Raw | ConvertFrom-Json
    if ($previous.files.Count -ne $files.Count) { throw 'Verified bundle changed.' }
    foreach ($file in $files) {
        $before = @($previous.files | Where-Object { $_.path -eq $file.path })
        if ($before.Count -ne 1 -or $before[0].sha256 -ne $file.sha256) { throw 'Verified bundle changed; it will not be reselected.' }
    }
} else {
    Write-Json $verifiedFile @{ schema = 1; version = $plan.version; verifiedAt = [DateTime]::UtcNow.ToString('o'); files = $files }
}
if ($Mode -eq 'Activate') {
    $pointer = Join-Path $bundleRoot 'selected.json'
    if (Test-Path -LiteralPath $pointer) {
        Copy-Item -LiteralPath $pointer -Destination (Join-Path $bundleRoot ('previous-' + [Guid]::NewGuid().ToString('N') + '.json'))
    }
    $next = Join-Path $bundleRoot ('selection-' + [Guid]::NewGuid().ToString('N') + '.json')
    Write-Json $next @{ schema = 1; id = $BundleId; sha256 = (Hash $verifiedFile) }
    Move-Item -LiteralPath $next -Destination $pointer -Force
}
@{ ok = $true; state = $(if ($Mode -eq 'Activate') { 'selected_not_attached' } else { 'verified_not_selected' }); bundleId = $BundleId } | ConvertTo-Json
