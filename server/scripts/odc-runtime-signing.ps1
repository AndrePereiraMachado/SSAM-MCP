[CmdletBinding()]
param(
    [ValidateSet('Prepare', 'Sign', 'Verify', 'Activate', 'Artifacts')][string]$Mode = 'Prepare',
    [string]$BundleId,
    [string]$CertificateThumbprint,
    [ValidateSet('CurrentUser', 'LocalMachine')][string]$CertificateStore = 'CurrentUser',
    [string]$TimestampServer,
    [string]$ArtifactDirectory,
    [string]$BuildEvidence,
    [string]$ConfigPath,
    [string]$Vault = "$env:LOCALAPPDATA\SSAM\vigia\secrets.dpapi.json"
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Mode -eq 'Artifacts') {
    $executionRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . "$PSScriptRoot\..\deploy\vigia\execution-trust.ps1"
    Assert-ExecutionClone $executionRoot
    $git = 'C:\Program Files\Git\cmd\git.exe'
    Assert-Executable $git
    . "$PSScriptRoot\..\deploy\vigia\authenticode-chain.ps1"
    $safe = @('-c','core.hooksPath=','-c','core.fsmonitor=false','-c','core.pager=cat','-c','credential.helper=','-c','protocol.ext.allow=never','-c','protocol.file.allow=never','-c','core.attributesFile=NUL')
    Get-ChildItem Env:GIT_* | Remove-Item
    $env:GIT_CONFIG_NOSYSTEM='1'; $env:GIT_CONFIG_GLOBAL='NUL'
    $env:GIT_CONFIG_COUNT=$null; $env:GIT_CONFIG_PARAMETERS=$null
    if ((Split-Path $executionRoot -Leaf) -ne 'vigia-run' -or (& $git @safe -C $executionRoot branch --show-current).Trim() -ne 'server/vigia-run' -or (& $git @safe -C $executionRoot rev-parse HEAD).Trim() -ne (& $git @safe -C $executionRoot rev-parse main).Trim() -or (& $git @safe -C $executionRoot status --porcelain)) {
        throw 'Signing requires the clean trusted vigia-run checkout at reviewed main.'
    }
    if(-not $ConfigPath){throw 'Private signing configuration is required.'}
    . "$PSScriptRoot\..\deploy\vigia\execution-trust.ps1" -PrivatePaths $ConfigPath
    $config=Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if($config.PSObject.Properties['ownerSigningPublicKey'] -and $config.ownerSigningPublicKey){
        $allowed=Join-Path $config.tempRoot 'allowed-signers'
        [IO.File]::WriteAllText($allowed,('owner '+$config.ownerSigningPublicKey+"`n"))
        & $git @safe -C $executionRoot -c gpg.format=ssh -c gpg.ssh.program=C:/Windows/System32/OpenSSH/ssh-keygen.exe -c "gpg.ssh.allowedSignersFile=$allowed" verify-commit HEAD
        if($LASTEXITCODE -ne 0){throw 'Owner commit signature is invalid.'}
    }elseif(-not ($config.PSObject.Properties['acceptUnsignedMain'] -and $config.acceptUnsignedMain -eq $true)){throw 'Owner signing public key or explicit acceptUnsignedMain:true is required.'}
    . "$PSScriptRoot\..\deploy\vigia\vault.ps1"

    $secrets = Read-VigiaVault $Vault
    $thumb = $secrets.authenticodeThumbprint
    $cert = Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumb"
    if (-not $cert.HasPrivateKey -or -not $cert.Verify() -or $cert.Subject -eq $cert.Issuer) { throw 'A valid provider-issued signing certificate is required.' }
    if (@($cert.EnhancedKeyUsageList | Where-Object { $_.ObjectId.Value -eq '1.3.6.1.5.5.7.3.3' }).Count -eq 0) { throw 'Certificate does not allow code signing.' }
    $evidence=Get-Content -LiteralPath $BuildEvidence -Raw | ConvertFrom-Json
    $pins=Get-Content -LiteralPath "$PSScriptRoot\..\deploy\vigia\publisher-pins.json" -Raw | ConvertFrom-Json
    $records = @()
    foreach ($file in Get-ChildItem -LiteralPath $ArtifactDirectory -Recurse -File | Where-Object { $_.Extension -in '.dll','.exe' }) {
        $relative=$file.FullName.Substring($ArtifactDirectory.Length).TrimStart('\').Replace('\','/')
        $digest=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $ownerRecord=$evidence.owned.PSObject.Properties[$relative]
        $own = $null -ne $ownerRecord
        if($own -and $digest -ne $ownerRecord.Value){throw 'Build output changed before signing.'}
        $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
        if ($own) {
            $signature = Set-AuthenticodeSignature -LiteralPath $file.FullName -Certificate $cert -HashAlgorithm SHA256 -IncludeChain NotRoot -TimestampServer $TimestampServer
            if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate -or $signature.SignerCertificate.Thumbprint -ne $thumb) { throw 'Bridge signature verification failed.' }
        } else {
            $dep=$evidence.dependencies.PSObject.Properties[$relative]
            if($null -eq $dep -or $dep.Value.sha256 -ne $digest -or (Get-FileHash -LiteralPath $dep.Value.source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest){throw 'Dependency differs from restored NuGet bytes.'}
            if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)'){throw 'Unsupported dependency signer; report it to the integrator.'}
            $chain=Get-VerifiedAuthenticodeChain $file.FullName $signature
            if($pins.microsoftRoots -notcontains $chain.ChainElements[$chain.ChainElements.Count-1].Certificate.Thumbprint){throw 'Microsoft dependency root is not pinned.'}
        }
        $records += @{ path=$relative; signer=$(if($own){'owner'}else{'microsoft'}); thumbprint=$signature.SignerCertificate.Thumbprint }
    }
    [IO.File]::WriteAllText((Join-Path $ArtifactDirectory 'authenticode.json'), ($records | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    Write-Output 'Bridge signatures verified; dependency signatures preserved.'
    return
}
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
    # The bridge's runtime folder: OdcBridgeRuntime of Bridge.csproj (v100: net10.0; the bridges before it: net8.0).
    $bridgeRuntime = if ((Get-Content -LiteralPath (Join-Path $odcRoot 'studio\bridge\Bridge.csproj') -Raw) -match '<OdcBridgeRuntime>(net\d+\.\d+)</OdcBridgeRuntime>') { $Matches[1] } else { 'net8.0' }
    $bridgeFile = Join-Path $odcRoot "studio\bridge\bin\Release\$bridgeRuntime\ODC3.Bridge.$version.dll"
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
