param([Parameter(Mandatory=$true)][ValidateSet('prompt','prompt-endpoint','read','forget','seal-session','import-profile','remember-profile','resolve-profile','remember-environment-profile','resolve-environment-profile','remember-endpoint-profile','resolve-endpoint-profile','forget-endpoint-profile')][string]$Mode,
  [string]$StateRoot)

# Application credentials are unrelated to Studio/debugger credentials.
# The parent launches this helper hidden, with redirected stdin/stdout. Only the
# credential dialog is visible. Never invoke read from a model-facing tool.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$phase = 'input'
$clearBytes = $null
$clear = $null
$password = $null
$secret = $null
$form = $null
$passwordBox = $null
$usernameBox = $null
$vaultFile = $null
$createdFile = $false
$completed = $false
$temporaryFile = $null
$createdTemporaryFile = $false
$endpointBoxes = $null
$endpointHeaders = $null
$endpointOutput = $null
$endpointPayload = $null
$savedEndpointProfile = $null
$endpointProfileRecord = $null

function Fail([string]$Code) { throw [InvalidOperationException]::new($Code) }

function Get-RequiredProperty($Object, [string]$Name) {
  if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) { Fail 'invalid_input' }
  return $Object.$Name
}

function ConvertTo-CredentialReference($Value) {
  $reference = [string]$Value
  if ($reference -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') { Fail 'invalid_reference' }
  return $reference
}

function ConvertTo-Binding($Value) {
  $lane = [string](Get-RequiredProperty $Value 'lane')
  if ($lane -cnotin @('odc','o11')) { Fail 'invalid_binding' }
  $app = [string](Get-RequiredProperty $Value 'app')
  if ($app -cnotmatch '^[A-Za-z_][A-Za-z0-9_]{0,198}$') { Fail 'invalid_binding' }
  $sessionId = [string](Get-RequiredProperty $Value 'sessionId')
  if ($sessionId -cnotmatch '^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$') { Fail 'invalid_binding' }
  $sessionId = $sessionId.Replace('-','')
  $rawUrl = [string](Get-RequiredProperty $Value 'runtimeUrl')
  $runtime = $null
  if ($rawUrl.Length -gt 2048 -or -not [Uri]::TryCreate($rawUrl,[UriKind]::Absolute,[ref]$runtime)) { Fail 'invalid_binding' }
  if ($runtime.Scheme -cne 'https' -or $runtime.UserInfo.Length -gt 0 -or $runtime.Query.Length -gt 0 -or $runtime.Fragment.Length -gt 0) { Fail 'invalid_binding' }
  $appPath = '/' + $app
  if ($runtime.Host.Length -eq 0 -or ($runtime.AbsolutePath -cne $appPath -and $runtime.AbsolutePath -cne ($appPath + '/'))) { Fail 'invalid_binding' }
  $canonicalUrl = $runtime.GetLeftPart([UriPartial]::Authority).ToLowerInvariant() + $runtime.AbsolutePath.TrimEnd('/') + '/'
  $module = [string](Get-RequiredProperty $Value 'module')
  $moduleKey = [string](Get-RequiredProperty $Value 'moduleKey')
  if ($module -cnotmatch '^[A-Za-z_][A-Za-z0-9_]{0,198}$' -or $moduleKey -cnotmatch '^[A-Za-z0-9_+]{22}$') { Fail 'invalid_binding' }
  return [ordered]@{lane=$lane;runtimeUrl=$canonicalUrl;app=$app;sessionId=$sessionId;module=$module;moduleKey=$moduleKey}
}

# Endpoint credential (Custom REST OnAuthentication): the app binding plus the published
# revision, service key and exact header names. Header values never belong to a binding.
# scheme 'basic' (RFC 7617) binds exactly the Authorization header; the header scheme has no scheme field.
function ConvertTo-EndpointBinding($Value) {
  $canonical = ConvertTo-Binding $Value
  if ($null -ne $Value.PSObject.Properties['use']) { Fail 'invalid_binding' }
  $scheme = $null
  if ($null -ne $Value.PSObject.Properties['scheme']) {
    $scheme = $Value.PSObject.Properties['scheme'].Value
    if ($scheme -isnot [string] -or $scheme -cne 'basic') { Fail 'invalid_binding' }
  }
  $revision = Get-RequiredProperty $Value 'revision'
  if (($revision -isnot [int] -and $revision -isnot [long]) -or $revision -lt 1) { Fail 'invalid_binding' }
  $serviceKey = [string](Get-RequiredProperty $Value 'serviceKey')
  if ($serviceKey -cnotmatch '^[A-Za-z0-9_+]{22}$') { Fail 'invalid_binding' }
  if ($null -eq $Value.PSObject.Properties['headers']) { Fail 'invalid_binding' }
  $names = $Value.PSObject.Properties['headers'].Value
  if ($names -isnot [array] -or $names.Count -lt 1 -or $names.Count -gt 8) { Fail 'invalid_binding' }
  $seen = @{}
  foreach ($name in $names) {
    if ($name -isnot [string] -or $name -cnotmatch '^[A-Za-z][A-Za-z0-9-]{0,63}$' -or $seen.ContainsKey($name.ToLowerInvariant())) { Fail 'invalid_binding' }
    $seen[$name.ToLowerInvariant()] = $true
  }
  if ($null -ne $scheme -and ($names.Count -ne 1 -or $names[0] -cne 'Authorization')) { Fail 'invalid_binding' }
  $canonical['revision'] = [long]$revision
  $canonical['serviceKey'] = $serviceKey
  $canonical['headers'] = [string[]]$names
  if ($null -ne $scheme) { $canonical['scheme'] = $scheme }
  return $canonical
}

# Redaction-only record (use 'redact-only'): the app binding plus the revision and the declared role
# names. It has no service key or header: no endpoint request can be built from it.
function ConvertTo-RedactionBinding($Value) {
  $canonical = ConvertTo-Binding $Value
  $use = Get-RequiredProperty $Value 'use'
  if ($use -isnot [string] -or $use -cne 'redact-only') { Fail 'invalid_binding' }
  foreach ($name in @('serviceKey','headers','scheme')) { if ($null -ne $Value.PSObject.Properties[$name]) { Fail 'invalid_binding' } }
  $revision = Get-RequiredProperty $Value 'revision'
  if (($revision -isnot [int] -and $revision -isnot [long]) -or $revision -lt 1) { Fail 'invalid_binding' }
  if ($null -eq $Value.PSObject.Properties['roles']) { Fail 'invalid_binding' }
  $roles = $Value.PSObject.Properties['roles'].Value
  if ($roles -isnot [array] -or $roles.Count -lt 1 -or $roles.Count -gt 8) { Fail 'invalid_binding' }
  $seen = @{}
  foreach ($role in $roles) {
    if ($role -isnot [string] -or $role -cnotmatch '^[A-Za-z][A-Za-z0-9_]{0,63}$' -or $seen.ContainsKey($role.ToLowerInvariant())) { Fail 'invalid_binding' }
    $seen[$role.ToLowerInvariant()] = $true
  }
  $canonical['revision'] = [long]$revision
  $canonical['use'] = 'redact-only'
  $canonical['roles'] = [string[]]$roles
  return $canonical
}

function Assert-Binding($Stored, $Expected) {
  # An app-user record never opens as an endpoint credential or a redaction record, nor the reverse.
  $endpoint = $Expected.Contains('serviceKey')
  $redaction = $Expected.Contains('use')
  if ($endpoint -ne ($null -ne $Stored.PSObject.Properties['serviceKey'])) { Fail 'binding_mismatch' }
  if ($redaction -ne ($null -ne $Stored.PSObject.Properties['use'])) { Fail 'binding_mismatch' }
  if ($redaction) { $canonical = ConvertTo-RedactionBinding $Stored } elseif ($endpoint) { $canonical = ConvertTo-EndpointBinding $Stored } else { $canonical = ConvertTo-Binding $Stored }
  foreach ($name in @('lane','runtimeUrl','app','sessionId','module','moduleKey')) {
    if ($canonical[$name] -cne $Expected[$name]) { Fail 'binding_mismatch' }
  }
  if ($endpoint -and ($canonical.revision -ne $Expected.revision -or $canonical.serviceKey -cne $Expected.serviceKey -or
      ($canonical.headers -join "`n") -cne ($Expected.headers -join "`n") -or $canonical.Contains('scheme') -ne $Expected.Contains('scheme') -or
      [string]$canonical['scheme'] -cne [string]$Expected['scheme'])) { Fail 'binding_mismatch' }
  if ($redaction -and ($canonical.revision -ne $Expected.revision -or ($canonical.roles -join "`n") -cne ($Expected.roles -join "`n"))) { Fail 'binding_mismatch' }
}

# Dialog/record input rule. Basic (RFC 7617): a non-blank username without ':' or control characters and a
# non-empty password without control characters. Header values and redaction values: non-empty, single line.
function Test-EndpointDialogInput([bool]$Basic, [string]$Username, [string[]]$Values) {
  if ($Basic -and ([string]::IsNullOrWhiteSpace($Username) -or $Username.Length -gt 512 -or $Username -match '[:\x00-\x1f\x7f]')) {
    return 'Enter a username without '':'' or control characters.'
  }
  if ($null -eq $Values -or $Values.Count -lt 1) { return 'Enter a value for every field.' }
  foreach ($value in $Values) {
    if ($null -eq $value -or $value.Length -eq 0 -or $value.Length -gt 4096 -or $value -match '[\x00-\x1f\x7f]') {
      if ($Basic) { return 'Enter the password.' } else { return 'Enter a value for every field.' }
    }
  }
  return $null
}

# The private payload of an endpoint-family record, exactly as bound: header values in order, a Basic
# pair or the declared redaction roles. Any other shape is unavailable.
function Get-EndpointCredentialPayload($Secret, $Binding) {
  $payload = [ordered]@{}
  if ($Binding.Contains('use')) {
    if ($null -ne $Secret.PSObject.Properties['scheme'] -or $null -ne $Secret.PSObject.Properties['headers'] -or $null -eq $Secret.PSObject.Properties['use'] -or
        [string]$Secret.PSObject.Properties['use'].Value -cne 'redact-only' -or $null -eq $Secret.PSObject.Properties['secrets']) { Fail 'credentials_unavailable' }
    $storedSecrets = @($Secret.PSObject.Properties['secrets'].Value)
    if ($storedSecrets.Count -ne $Binding.roles.Count) { Fail 'credentials_unavailable' }
    $items = New-Object 'Collections.Generic.List[object]'
    for ($index = 0; $index -lt $storedSecrets.Count; $index++) {
      $role = [string](Get-RequiredProperty $storedSecrets[$index] 'role')
      $value = [string](Get-RequiredProperty $storedSecrets[$index] 'value')
      if ($role -cne $Binding.roles[$index] -or $null -ne (Test-EndpointDialogInput $false '' @($value))) { Fail 'credentials_unavailable' }
      $items.Add([ordered]@{role=$role;value=$value})
    }
    $payload['use'] = 'redact-only'
    $payload['secrets'] = $items.ToArray()
  } elseif ($Binding.Contains('scheme')) {
    if ($null -ne $Secret.PSObject.Properties['use'] -or $null -ne $Secret.PSObject.Properties['headers'] -or $null -eq $Secret.PSObject.Properties['scheme'] -or
        [string]$Secret.PSObject.Properties['scheme'].Value -cne 'basic') { Fail 'credentials_unavailable' }
    $basicUsername = [string](Get-RequiredProperty $Secret 'username')
    $basicPassword = [string](Get-RequiredProperty $Secret 'password')
    if ($null -ne (Test-EndpointDialogInput $true $basicUsername @($basicPassword))) { Fail 'credentials_unavailable' }
    $payload['scheme'] = 'basic'
    $payload['username'] = $basicUsername
    $payload['password'] = $basicPassword
  } else {
    # Exactly the bound header names, in order; each value is non-empty and single-line.
    if ($null -ne $Secret.PSObject.Properties['scheme'] -or $null -ne $Secret.PSObject.Properties['use'] -or $null -eq $Secret.PSObject.Properties['headers']) { Fail 'credentials_unavailable' }
    $storedHeaders = @($Secret.PSObject.Properties['headers'].Value)
    if ($storedHeaders.Count -ne $Binding.headers.Count) { Fail 'credentials_unavailable' }
    $items = New-Object 'Collections.Generic.List[object]'
    for ($index = 0; $index -lt $storedHeaders.Count; $index++) {
      $headerName = [string](Get-RequiredProperty $storedHeaders[$index] 'name')
      $headerValue = [string](Get-RequiredProperty $storedHeaders[$index] 'value')
      if ($headerName -cne $Binding.headers[$index] -or $null -ne (Test-EndpointDialogInput $false '' @($headerValue))) { Fail 'credentials_unavailable' }
      $items.Add([ordered]@{name=$headerName;value=$headerValue})
    }
    $payload['headers'] = $items.ToArray()
  }
  return $payload
}

function Assert-NoReparse([string]$Path) {
  if ([IO.File]::Exists($Path) -or [IO.Directory]::Exists($Path)) {
    if (([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'private_storage_unavailable' }
  }
}

function Set-PrivateDirectory([string]$Path, $Sid) {
  Assert-NoReparse $Path
  if (-not [IO.Directory]::Exists($Path)) { $null = [IO.Directory]::CreateDirectory($Path) }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($Sid)
  $acl.SetAccessRuleProtection($true,$false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($Sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
  [IO.Directory]::SetAccessControl($Path,$acl)
}

function Assert-PrivateFile([string]$Path, $Sid) {
  Assert-NoReparse $Path
  if (-not [IO.File]::Exists($Path)) { Fail 'credentials_unavailable' }
  $acl = [IO.File]::GetAccessControl($Path)
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Sid.Value) { Fail 'private_storage_unavailable' }
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -cne $Sid.Value) { Fail 'private_storage_unavailable' }
  }
  if ((New-Object IO.FileInfo($Path)).Length -gt 65536) { Fail 'credentials_unavailable' }
}

function Assert-PrivateDirectory([string]$Path, $Sid) {
  Assert-NoReparse $Path
  if (-not [IO.Directory]::Exists($Path)) { Fail 'credentials_unavailable' }
  $acl = [IO.Directory]::GetAccessControl($Path)
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Sid.Value) { Fail 'private_storage_unavailable' }
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -cne $Sid.Value) { Fail 'private_storage_unavailable' }
  }
}

# Debugger state root: %USERPROFILE%\.ssam-hybrid\debugger, or SSAM_DEBUG_STATE_ROOT (debug-state-root.mjs). It lies
# outside the per-app MSIX copy of %LOCALAPPDATA%; a normalized local path, never inside a package store.
function Resolve-DebugStateRoot([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { $Value = $env:SSAM_DEBUG_STATE_ROOT }
  if ([string]::IsNullOrWhiteSpace($Value)) {
    $profileRoot = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($profileRoot)) { $profileRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile) }
    $Value = Join-Path (Join-Path $profileRoot '.ssam-hybrid') 'debugger'
  }
  $Value = $Value.TrimEnd('\')
  if ($Value.StartsWith('\\') -or -not [IO.Path]::IsPathRooted($Value)) { Fail 'private_storage_unavailable' }
  $full = [IO.Path]::GetFullPath($Value).TrimEnd('\')
  if ($full -cne $Value -or $full -match '\\Packages\\[^\\]+\\LocalCache(\\|$)') { Fail 'private_storage_unavailable' }
  return $full
}

# Legacy copies (<...>\SSAM\<Leaf>, tagged current|real|package:<PFN>) are only ever read.
function ConvertTo-LegacyRoots($Value, [string]$Leaf) {
  $roots = @()
  if ($null -eq $Value) { return ,$roots }
  $items = @($Value)
  if ($items.Count -gt 64) { Fail 'invalid_input' }
  foreach ($item in $items) {
    $origin = [string](Get-RequiredProperty $item 'origin')
    $path = [string](Get-RequiredProperty $item 'path')
    if ($origin -cnotmatch '^(current|real|package:[A-Za-z0-9][A-Za-z0-9._-]{0,127})$') { Fail 'invalid_input' }
    if ($path.StartsWith('\\') -or -not [IO.Path]::IsPathRooted($path) -or [IO.Path]::GetFullPath($path).TrimEnd('\') -cne $path) { Fail 'invalid_input' }
    if ((Split-Path $path -Leaf) -cne $Leaf -or (Split-Path (Split-Path $path -Parent) -Leaf) -cne 'SSAM') { Fail 'invalid_input' }
    $roots += @{origin=$origin;root=$path}
  }
  return ,$roots
}

function Read-PrivateCiphertext([string]$Path) { return ,([IO.File]::ReadAllBytes($Path)) }
function Unprotect-AppUserRecord([byte[]]$Bytes, [byte[]]$Entropy) {
  return ,([Security.Cryptography.ProtectedData]::Unprotect($Bytes,$Entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser))
}

function Get-ScopedForgetCandidate([string]$Path, $Sid, [byte[]]$Entropy, $ExpectedBinding) {
  # ACL/reparse/owner validation precedes the corrupt-ciphertext exception. A
  # read failure is never mistaken for corrupt ciphertext and cannot authorize deletion.
  Assert-PrivateFile $Path $Sid
  $ciphertext = Read-PrivateCiphertext $Path
  $decrypted = $null
  try {
    try { $decrypted = Unprotect-AppUserRecord $ciphertext $Entropy }
    catch {
      # An interrupted write cannot prove its payload binding. The preallocated
      # exact reference and its private CurrentUser ACL authorize this cleanup.
      return @{path=$Path;corrupt=$true}
    }
    $record = [Text.Encoding]::UTF8.GetString($decrypted) | ConvertFrom-Json
    if ((Get-RequiredProperty $record 'version') -ne 1) { Fail 'credentials_unavailable' }
    Assert-Binding (Get-RequiredProperty $record 'binding') $ExpectedBinding
    return @{path=$Path;corrupt=$false}
  } finally {
    if ($null -ne $decrypted) { [Array]::Clear($decrypted,0,$decrypted.Length) }
    $record = $null
  }
}

try {
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  if (-not [Console]::IsInputRedirected -or -not [Console]::IsOutputRedirected) { Fail 'private_pipe_required' }
  $inputJson = [Console]::In.ReadToEnd()
  if ($inputJson.Length -eq 0 -or $inputJson.Length -gt 16384) { Fail 'invalid_input' }
  $request = $inputJson | ConvertFrom-Json
  $inputJson = $null
  $requestBinding = Get-RequiredProperty $request 'binding'
  $endpointProfileModes = @('remember-endpoint-profile','resolve-endpoint-profile','forget-endpoint-profile')
  if ($null -ne $requestBinding.PSObject.Properties['use']) {
    # Redaction-only records are only prompted, read and forgotten; never imported, sealed or profiled.
    if ($Mode -cnotin @('prompt-endpoint','read','forget')) { Fail 'invalid_binding' }
    $binding = ConvertTo-RedactionBinding $requestBinding
  } elseif ($Mode -ceq 'prompt-endpoint' -or $Mode -cin $endpointProfileModes -or $null -ne $requestBinding.PSObject.Properties['serviceKey']) {
    # Endpoint credentials are only prompted, read and forgotten; never imported or sealed. A profile is
    # written or read only by the explicit endpoint profile modes.
    if ($Mode -cnotin (@('prompt-endpoint','read','forget') + $endpointProfileModes)) { Fail 'invalid_binding' }
    $binding = ConvertTo-EndpointBinding $requestBinding
  } else { $binding = ConvertTo-Binding $requestBinding }
  $requestBinding = $null
  # The controller allocates this opaque reference before opening the dialog, so
  # an interrupted/uncertain prompt can still be cleaned up by exact scope.
  $credentialRef = ConvertTo-CredentialReference (Get-RequiredProperty $request 'credentialRef')

  $phase = 'storage'
  Add-Type -AssemblyName System.Security
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  # Every new record goes to the debugger state root. This process's own %LOCALAPPDATA%\SSAM view is a
  # legacy copy: read falls back to it and forget clears it; nothing new is ever written there.
  $stateRoot = Resolve-DebugStateRoot $StateRoot
  $vaultRoot = Join-Path $stateRoot 'app-user'
  $profileRoot = Join-Path $stateRoot 'app-user-profiles'
  $endpointProfileRoot = Join-Path $stateRoot 'endpoint-profiles'
  Assert-NoReparse $stateRoot
  Assert-NoReparse $vaultRoot
  $localData = [IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData))
  if ([string]::IsNullOrWhiteSpace($localData)) { Fail 'private_storage_unavailable' }
  $ssamDirectory = Join-Path $localData 'SSAM'
  $legacyVaultRoot = [IO.Path]::GetFullPath((Join-Path $ssamDirectory 'DebugAppUser'))
  Assert-NoReparse $localData
  Assert-NoReparse $ssamDirectory
  Assert-NoReparse $legacyVaultRoot

  if ($Mode -in @('remember-profile','resolve-profile','remember-environment-profile','resolve-environment-profile')) {
    $profileBinding = [ordered]@{}
    if ($Mode -in @('remember-environment-profile','resolve-environment-profile')) {
      if ($binding.lane -cnotin @('o11','odc')) { Fail 'invalid_profile' }
      $profileBinding['lane']=$binding.lane
      $profileBinding['environmentHost']=([Uri]$binding.runtimeUrl).Host
    } else {
      foreach ($field in @('lane','runtimeUrl','app','module','moduleKey')) { $profileBinding[$field]=$binding[$field] }
    }
    $profileJson = $profileBinding | ConvertTo-Json -Compress
    $hashProvider = [Security.Cryptography.SHA256]::Create()
    try { $profileHash = ([BitConverter]::ToString($hashProvider.ComputeHash([Text.Encoding]::UTF8.GetBytes($profileJson)))).Replace('-','').ToLowerInvariant() } finally { $hashProvider.Dispose() }
    Assert-NoReparse $profileRoot
    $profileFile = Join-Path $profileRoot ($profileHash + '.dpapi')
    $profileEntropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUserProfile.v1|' + $profileHash)
    if ($Mode -in @('resolve-profile','resolve-environment-profile')) {
      # The new root first, then each legacy copy read only (DPAPI CurrentUser opens it from any package).
      $profileSources = @(@{origin='state';root=$profileRoot})
      if ($null -ne $request.PSObject.Properties['legacyProfileRoots']) { $profileSources += ConvertTo-LegacyRoots $request.legacyProfileRoots 'DebugAppUserProfiles' }
      else { $profileSources += @{origin='current';root=(Join-Path $ssamDirectory 'DebugAppUserProfiles')} }
      $profileSource = $null
      foreach ($candidate in $profileSources) {
        $candidateFile = Join-Path $candidate.root ($profileHash + '.dpapi')
        Assert-NoReparse (Split-Path $candidate.root -Parent)
        Assert-NoReparse $candidate.root
        Assert-NoReparse $candidateFile
        if ([IO.File]::Exists($candidateFile)) { $profileSource = $candidate; break }
      }
      if ($null -eq $profileSource) { [Console]::Out.Write('{"ok":true,"found":false}') }
      else {
        $profileFile = Join-Path $profileSource.root ($profileHash + '.dpapi')
        Assert-PrivateDirectory $profileSource.root $currentSid
        Assert-PrivateFile $profileFile $currentSid
        $clearBytes = Unprotect-AppUserRecord (Read-PrivateCiphertext $profileFile) $profileEntropy
        $savedProfile = [Text.Encoding]::UTF8.GetString($clearBytes) | ConvertFrom-Json
        if ($savedProfile.version -ne 1) { Fail 'invalid_profile' }
        foreach ($field in $profileBinding.Keys) { if ($savedProfile.binding.$field -cne $profileBinding[$field]) { Fail 'invalid_profile' } }
        [Console]::Out.Write(([ordered]@{ok=$true;found=$true;profileHost=$savedProfile.profileHost;profileTarget=$savedProfile.profileTarget;profileOrigin=$profileSource.origin} | ConvertTo-Json -Compress))
      }
    } else {
      $profileHost = [string](Get-RequiredProperty $request 'profileHost')
      $profileTarget = [string](Get-RequiredProperty $request 'profileTarget')
      if ($profileHost -cnotmatch '^[a-z0-9][a-z0-9.-]*[a-z0-9]$') { Fail 'invalid_profile' }
      $profileBase = if ($binding.lane -eq 'o11') { 'SSAM/O11/' + $profileHost + '/ServiceCenter' } else { 'SSAM/ODC3/' + $profileHost + '/Portal' }
      if ($binding.lane -eq 'o11' -and ([Uri]$binding.runtimeUrl).Host -cne $profileHost) { Fail 'invalid_profile' }
      if ($profileTarget -cne $profileBase -and $profileTarget -cnotmatch ('^' + [regex]::Escape($profileBase) + '/Profiles/[a-f0-9]{64}/[a-f0-9-]{36}$')) { Fail 'invalid_profile' }
      $clearBytes = [Text.Encoding]::UTF8.GetBytes((@{version=1;binding=$profileBinding;profileHost=$profileHost;profileTarget=$profileTarget} | ConvertTo-Json -Depth 5 -Compress))
      $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,$profileEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      Set-PrivateDirectory $profileRoot $currentSid
      Assert-NoReparse $profileFile
      if ([IO.File]::Exists($profileFile)) { Assert-PrivateFile $profileFile $currentSid }
      [IO.File]::WriteAllBytes($profileFile,$encrypted)
      Assert-PrivateFile $profileFile $currentSid
      [Console]::Out.Write('{"ok":true,"remembered":true}')
    }
    $completed=$true
  } elseif ($Mode -cin $endpointProfileModes) {
    # Explicit endpoint profile, keyed by lane|runtimeUrl|module|serviceKey|scheme. Remember copies an entered
    # session record privately; resolve imports it into a new short-lived record bound to this exact run.
    $endpointScheme = 'header'
    if ($binding.Contains('scheme')) { $endpointScheme = [string]$binding['scheme'] }
    $endpointProfileBinding = [ordered]@{lane=$binding.lane;runtimeUrl=$binding.runtimeUrl;module=$binding.module;serviceKey=$binding.serviceKey;scheme=$endpointScheme}
    $hashProvider = [Security.Cryptography.SHA256]::Create()
    try { $endpointProfileHash = ([BitConverter]::ToString($hashProvider.ComputeHash([Text.Encoding]::UTF8.GetBytes(($endpointProfileBinding | ConvertTo-Json -Compress))))).Replace('-','').ToLowerInvariant() } finally { $hashProvider.Dispose() }
    Assert-NoReparse $endpointProfileRoot
    $endpointProfileFile = Join-Path $endpointProfileRoot ($endpointProfileHash + '.dpapi')
    Assert-NoReparse $endpointProfileFile
    $endpointProfileEntropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugEndpointProfile.v1|' + $endpointProfileHash)
    if ($Mode -ceq 'forget-endpoint-profile') {
      $profileForgotten = $false
      if ([IO.File]::Exists($endpointProfileFile)) {
        Assert-PrivateDirectory $endpointProfileRoot $currentSid
        Assert-PrivateFile $endpointProfileFile $currentSid
        [IO.File]::Delete($endpointProfileFile)
        $profileForgotten = $true
      }
      [Console]::Out.Write((@{ok=$true;forgotten=$profileForgotten} | ConvertTo-Json -Compress))
    } elseif ($Mode -ceq 'remember-endpoint-profile') {
      $phase = 'profile-read'
      $vaultFile = Join-Path $vaultRoot ($credentialRef + '.dpapi')
      Assert-PrivateDirectory $vaultRoot $currentSid
      Assert-PrivateFile $vaultFile $currentSid
      $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $credentialRef)
      $clearBytes = Unprotect-AppUserRecord (Read-PrivateCiphertext $vaultFile) $entropy
      $secret = [Text.Encoding]::UTF8.GetString($clearBytes) | ConvertFrom-Json
      [Array]::Clear($clearBytes,0,$clearBytes.Length)
      if ((Get-RequiredProperty $secret 'version') -ne 1 -or [string](Get-RequiredProperty $secret 'kind') -cne 'endpoint-credential') { Fail 'credentials_unavailable' }
      Assert-Binding (Get-RequiredProperty $secret 'binding') $binding
      if ([DateTimeOffset]::Parse([string](Get-RequiredProperty $secret 'expiresAt')) -le [DateTimeOffset]::UtcNow) { Fail 'credentials_expired' }
      $endpointPayload = Get-EndpointCredentialPayload $secret $binding
      $endpointProfileRecord = [ordered]@{version=1;binding=$endpointProfileBinding;headers=$binding.headers;credential=$endpointPayload}
      $phase = 'profile-protect'
      $clearBytes = [Text.Encoding]::UTF8.GetBytes(($endpointProfileRecord | ConvertTo-Json -Depth 8 -Compress))
      $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,$endpointProfileEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      Set-PrivateDirectory $endpointProfileRoot $currentSid
      if ([IO.File]::Exists($endpointProfileFile)) { Assert-PrivateFile $endpointProfileFile $currentSid }
      [IO.File]::WriteAllBytes($endpointProfileFile,$encrypted)
      Assert-PrivateFile $endpointProfileFile $currentSid
      [Console]::Out.Write('{"ok":true,"remembered":true}')
    } elseif (-not [IO.File]::Exists($endpointProfileFile)) {
      [Console]::Out.Write('{"ok":true,"found":false}')
    } else {
      $phase = 'profile-resolve'
      $ttl = 600
      if ($null -ne $request.PSObject.Properties['ttlSeconds']) {
        $profileTtl = $request.ttlSeconds
        if (($profileTtl -isnot [int] -and $profileTtl -isnot [long]) -or $profileTtl -lt 30 -or $profileTtl -gt 3600) { Fail 'invalid_ttl' }
        $ttl = [int]$profileTtl
      }
      Assert-PrivateDirectory $endpointProfileRoot $currentSid
      Assert-PrivateFile $endpointProfileFile $currentSid
      $clearBytes = Unprotect-AppUserRecord (Read-PrivateCiphertext $endpointProfileFile) $endpointProfileEntropy
      $savedEndpointProfile = [Text.Encoding]::UTF8.GetString($clearBytes) | ConvertFrom-Json
      [Array]::Clear($clearBytes,0,$clearBytes.Length)
      if ((Get-RequiredProperty $savedEndpointProfile 'version') -ne 1) { Fail 'invalid_profile' }
      $savedBinding = Get-RequiredProperty $savedEndpointProfile 'binding'
      foreach ($field in $endpointProfileBinding.Keys) { if ([string](Get-RequiredProperty $savedBinding $field) -cne $endpointProfileBinding[$field]) { Fail 'invalid_profile' } }
      if ((@(Get-RequiredProperty $savedEndpointProfile 'headers') -join "`n") -cne ($binding.headers -join "`n")) {
        # The published contract changed its header names since the profile was remembered.
        [Console]::Out.Write('{"ok":true,"found":false}')
      } else {
        $endpointPayload = Get-EndpointCredentialPayload (Get-RequiredProperty $savedEndpointProfile 'credential') $binding
        $now = [DateTimeOffset]::UtcNow
        $expiresAt = $now.AddSeconds($ttl).ToString('o')
        $secret = [ordered]@{version=1;kind='endpoint-credential';binding=$binding;createdAt=$now.ToString('o');expiresAt=$expiresAt}
        foreach ($field in $endpointPayload.Keys) { $secret[$field] = $endpointPayload[$field] }
        $clearBytes = [Text.Encoding]::UTF8.GetBytes(($secret | ConvertTo-Json -Depth 8 -Compress))
        $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $credentialRef)
        $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        Set-PrivateDirectory $vaultRoot $currentSid
        $vaultFile = Join-Path $vaultRoot ($credentialRef + '.dpapi')
        $stream = [IO.File]::Open($vaultFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $createdFile = $true
        try { $stream.Write($encrypted,0,$encrypted.Length) } finally { $stream.Dispose() }
        Assert-PrivateFile $vaultFile $currentSid
        # No credential value or private storage path belongs in public output.
        [Console]::Out.Write(([ordered]@{ok=$true;found=$true;kind='endpoint-credential';credentialRef=$credentialRef;expiresAt=$expiresAt;binding=$binding;source='endpoint-profile'} | ConvertTo-Json -Depth 8 -Compress))
      }
    }
    $completed=$true
  } elseif ($Mode -eq 'import-profile') {
    # Exact profile selected by the user for this app. It is copied privately into
    # the existing short-lived debugger vault, never returned as clear text.
    $profileHost = [string](Get-RequiredProperty $request 'profileHost')
    $profileTarget = [string](Get-RequiredProperty $request 'profileTarget')
    if ($profileHost -cnotmatch '^[a-z0-9][a-z0-9.-]*[a-z0-9]$') { Fail 'invalid_profile' }
    if ($binding.lane -eq 'o11') {
      if (([Uri]$binding.runtimeUrl).Host -cne $profileHost) { Fail 'invalid_profile' }
      $profileBase = 'SSAM/O11/' + $profileHost + '/ServiceCenter'
    } else { $profileBase = 'SSAM/ODC3/' + $profileHost + '/Portal' }
    if ($profileTarget -cne $profileBase -and $profileTarget -cnotmatch ('^' + [regex]::Escape($profileBase) + '/Profiles/[a-f0-9]{64}/[a-f0-9-]{36}$')) { Fail 'invalid_profile' }
    $ttl = Get-RequiredProperty $request 'ttlSeconds'
    if (($ttl -isnot [int] -and $ttl -isnot [long]) -or $ttl -lt 30 -or $ttl -gt 600) { Fail 'invalid_ttl' }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SsamDebugSelectedProfile {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Credential {
  public uint Flags, Type; public string TargetName, Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint BlobSize; public IntPtr Blob; public uint Persist, AttributeCount; public IntPtr Attributes; public string TargetAlias, UserName;
 }
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target,uint type,uint flags,out IntPtr value);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr value);
}
'@
    $native = [IntPtr]::Zero
    if (-not [SsamDebugSelectedProfile]::Read($profileTarget,1,0,[ref]$native)) { Fail 'profile_unavailable' }
    try {
      $profile = [Runtime.InteropServices.Marshal]::PtrToStructure($native,[type][SsamDebugSelectedProfile+Credential])
      if ($profile.TargetName -cne $profileTarget -or $profile.Type -ne 1 -or $profile.BlobSize -lt 2 -or $profile.BlobSize -gt 8192 -or $profile.BlobSize % 2 -ne 0 -or [string]::IsNullOrWhiteSpace($profile.UserName)) { Fail 'profile_unavailable' }
      $password = [Runtime.InteropServices.Marshal]::PtrToStringUni($profile.Blob,[int]($profile.BlobSize / 2))
      $now = [DateTimeOffset]::UtcNow
      $expiresAt = $now.AddSeconds($ttl).ToString('o')
      $secret = [ordered]@{version=1;kind='credentials';binding=$binding;createdAt=$now.ToString('o');expiresAt=$expiresAt;username=$profile.UserName;password=$password}
      $clearBytes = [Text.Encoding]::UTF8.GetBytes(($secret | ConvertTo-Json -Depth 8 -Compress))
      $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $credentialRef)
      $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    } finally { [SsamDebugSelectedProfile]::CredFree($native); $profile=$null; $password=$null; $secret=$null }
    $phase = 'storage'
    Set-PrivateDirectory $vaultRoot $currentSid
    $vaultFile = Join-Path $vaultRoot ($credentialRef + '.dpapi')
    $stream = [IO.File]::Open($vaultFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $createdFile = $true
    try { $stream.Write($encrypted,0,$encrypted.Length) } finally { $stream.Dispose() }
    Assert-PrivateFile $vaultFile $currentSid
    [Console]::Out.Write(([ordered]@{ok=$true;credentialRef=$credentialRef;expiresAt=$expiresAt;binding=$binding;source='selected-profile'} | ConvertTo-Json -Depth 8 -Compress))
    $completed=$true
  } elseif ($Mode -eq 'prompt') {
    $ttl = 600
    if ($null -ne $request.PSObject.Properties['ttlSeconds']) {
      $ttlInput = $request.ttlSeconds
      if ($ttlInput -isnot [int] -and $ttlInput -isnot [long]) { Fail 'invalid_ttl' }
      if ($ttlInput -lt 30 -or $ttlInput -gt 3600) { Fail 'invalid_ttl' }
      $ttl = [int]$ttlInput
    }
    $phase = 'dialog'
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $form = New-Object Windows.Forms.Form
    $form.Text = 'SSAM Debug ' + [char]0x2014 + ' ' + $binding.lane.ToUpperInvariant() + ' ' + [char]0x2014 + ' ' + $binding.app + ' ' + [char]0x2014 + ' App User Sign In'
    $form.ClientSize = New-Object Drawing.Size(560,344)
    $form.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.ShowInTaskbar = $true
    $form.TopMost = $true
    $form.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
    $form.Font = New-Object Drawing.Font('Segoe UI',9)

    $intro = New-Object Windows.Forms.Label
    $intro.Location = New-Object Drawing.Point(24,18)
    $intro.Size = New-Object Drawing.Size(512,40)
    $intro.Text = 'Use the same application login as in the browser for the environment below. This is separate from your Studio account.'
    $form.Controls.Add($intro)
    $contextLabel = New-Object Windows.Forms.Label
    $contextLabel.Location = New-Object Drawing.Point(24,65)
    $contextLabel.Size = New-Object Drawing.Size(512,62)
    $contextLabel.Text = 'Platform: ' + $binding.lane.ToUpperInvariant() + "`r`nApplication: " + $binding.app + "`r`nEnvironment: " + $binding.runtimeUrl
    $contextLabel.AutoEllipsis = $true
    $form.Controls.Add($contextLabel)

    $usernameLabel = New-Object Windows.Forms.Label
    $usernameLabel.Location = New-Object Drawing.Point(24,139)
    $usernameLabel.Size = New-Object Drawing.Size(100,24)
    $usernameLabel.Text = if ($binding.lane -eq 'odc') { 'Email / login' } else { 'Username' }
    $form.Controls.Add($usernameLabel)
    $usernameBox = New-Object Windows.Forms.TextBox
    $usernameBox.Location = New-Object Drawing.Point(130,135)
    $usernameBox.Size = New-Object Drawing.Size(406,28)
    $usernameBox.MaxLength = 512
    $usernameBox.TabIndex = 0
    $form.Controls.Add($usernameBox)
    $passwordLabel = New-Object Windows.Forms.Label
    $passwordLabel.Location = New-Object Drawing.Point(24,178)
    $passwordLabel.Size = New-Object Drawing.Size(100,24)
    $passwordLabel.Text = 'Password'
    $form.Controls.Add($passwordLabel)
    $passwordBox = New-Object Windows.Forms.TextBox
    $passwordBox.Location = New-Object Drawing.Point(130,174)
    $passwordBox.Size = New-Object Drawing.Size(320,28)
    $passwordBox.UseSystemPasswordChar = $true
    $passwordBox.MaxLength = 4096
    $passwordBox.TabIndex = 1
    $form.Controls.Add($passwordBox)
    $showPassword = New-Object Windows.Forms.CheckBox
    $showPassword.Location = New-Object Drawing.Point(460,177)
    $showPassword.Size = New-Object Drawing.Size(76,24)
    $showPassword.Text = 'Show'
    $showPassword.Checked = $false
    $showPassword.TabIndex = 2
    $showPassword.Add_CheckedChanged({ $passwordBox.UseSystemPasswordChar = -not $showPassword.Checked })
    $form.Controls.Add($showPassword)

    $hint = New-Object Windows.Forms.Label
    $hint.Location = New-Object Drawing.Point(24,216)
    $hint.Size = New-Object Drawing.Size(512,40)
    $hint.Text = 'Credentials are encrypted for your Windows account and expire with this debug session. Never enter them in chat.'
    $form.Controls.Add($hint)
    $validationLabel = New-Object Windows.Forms.Label
    $validationLabel.Location = New-Object Drawing.Point(24,263)
    $validationLabel.Size = New-Object Drawing.Size(512,24)
    $validationLabel.ForeColor = [Drawing.Color]::DarkRed
    $form.Controls.Add($validationLabel)
    $signIn = New-Object Windows.Forms.Button
    $signIn.Text = 'Sign In'
    $signIn.Location = New-Object Drawing.Point(332,298)
    $signIn.Size = New-Object Drawing.Size(98,30)
    $signIn.TabIndex = 3
    $signIn.Add_Click({
      if ([string]::IsNullOrWhiteSpace($usernameBox.Text) -or $passwordBox.Text.Length -eq 0) {
        $validationLabel.Text = 'Enter your username and password.'
        return
      }
      $form.DialogResult = [Windows.Forms.DialogResult]::OK
    })
    $form.Controls.Add($signIn)
    $cancel = New-Object Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.Location = New-Object Drawing.Point(438,298)
    $cancel.Size = New-Object Drawing.Size(98,30)
    $cancel.TabIndex = 4
    $cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
    $form.Controls.Add($cancel)
    $form.AcceptButton = $signIn
    $form.CancelButton = $cancel
    $form.Add_Shown({ $form.Activate(); $form.BringToFront(); $usernameBox.Focus() | Out-Null })
    $dialogResult = $form.ShowDialog()
    if ($dialogResult -ne [Windows.Forms.DialogResult]::OK) {
      [Console]::Out.Write('{"ok":false,"cancelled":true}')
      $completed = $true
    } else {
      $phase = 'encrypt'
      $vaultFile = Join-Path $vaultRoot ($credentialRef + '.dpapi')
      $now = [DateTimeOffset]::UtcNow
      $expiresAt = $now.AddSeconds($ttl).ToString('o')
      $secret = [ordered]@{version=1;kind='credentials';binding=$binding;createdAt=$now.ToString('o');expiresAt=$expiresAt;username=$usernameBox.Text;password=$passwordBox.Text}
      $clear = $secret | ConvertTo-Json -Depth 8 -Compress
      $clearBytes = [Text.Encoding]::UTF8.GetBytes($clear)
      $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $credentialRef)
      $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      $usernameBox.Clear()
      $passwordBox.Clear()
      $form.Dispose()
      $form = $null
      $phase = 'storage'
      Set-PrivateDirectory $vaultRoot $currentSid
      $stream = [IO.File]::Open($vaultFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      $createdFile = $true
      try { $stream.Write($encrypted,0,$encrypted.Length) } finally { $stream.Dispose() }
      Assert-PrivateFile $vaultFile $currentSid
      # No username, password or private storage path belongs in public output.
      [Console]::Out.Write(([ordered]@{ok=$true;credentialRef=$credentialRef;expiresAt=$expiresAt;binding=$binding} | ConvertTo-Json -Depth 8 -Compress))
      $completed = $true
    }
  } elseif ($Mode -eq 'prompt-endpoint') {
    $ttl = 600
    if ($null -ne $request.PSObject.Properties['ttlSeconds']) {
      $endpointTtl = $request.ttlSeconds
      if (($endpointTtl -isnot [int] -and $endpointTtl -isnot [long]) -or $endpointTtl -lt 30 -or $endpointTtl -gt 3600) { Fail 'invalid_ttl' }
      $ttl = [int]$endpointTtl
    }
    $phase = 'dialog'
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    # Header scheme: one masked field per declared header. Basic (RFC 7617): a username box and one masked
    # password box. Redact-only: one masked field per declared role; that record is never sent by any worker.
    $basicScheme = $binding.Contains('scheme')
    $redactOnly = $binding.Contains('use')
    if ($basicScheme) {
      $headerNames = @('Password')
      $titleSuffix = ' Endpoint Credential (Basic)'
      $introText = 'Enter the Basic credentials that this endpoint''s OnAuthentication validates. They are sent only to the endpoint below.'
    } elseif ($redactOnly) {
      $headerNames = $binding.roles
      $titleSuffix = ' Redaction Secret'
      $introText = 'Enter the secret values the platform sends by itself. SSAM never sends them; they only hide copies in debugger frames and prove receipts are clean.'
    } else {
      $headerNames = $binding.headers
      $titleSuffix = ' Endpoint Credential'
      $introText = 'Enter the request header values that this endpoint''s OnAuthentication reads. They are sent only to the endpoint below.'
    }
    $extraRows = 0
    if ($basicScheme) { $extraRows = 1 }
    $form = New-Object Windows.Forms.Form
    $form.Text = 'SSAM Debug ' + [char]0x2014 + ' ' + $binding.lane.ToUpperInvariant() + ' ' + [char]0x2014 + ' ' + $binding.app + ' ' + [char]0x2014 + $titleSuffix
    $form.ClientSize = New-Object Drawing.Size(560,(250 + 39 * ($headerNames.Count + $extraRows)))
    $form.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.ShowInTaskbar = $true
    $form.TopMost = $true
    $form.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
    $form.Font = New-Object Drawing.Font('Segoe UI',9)

    $intro = New-Object Windows.Forms.Label
    $intro.Location = New-Object Drawing.Point(24,18)
    $intro.Size = New-Object Drawing.Size(512,40)
    $intro.Text = $introText
    $form.Controls.Add($intro)
    $contextLabel = New-Object Windows.Forms.Label
    $contextLabel.Location = New-Object Drawing.Point(24,65)
    $contextLabel.Size = New-Object Drawing.Size(512,62)
    $contextLabel.Text = 'Platform: ' + $binding.lane.ToUpperInvariant() + "`r`nApplication: " + $binding.app + ' (module ' + $binding.module + ', version ' + $binding.revision + ")`r`nEnvironment: " + $binding.runtimeUrl
    $contextLabel.AutoEllipsis = $true
    $form.Controls.Add($contextLabel)

    $endpointBoxes = New-Object 'Collections.Generic.List[Windows.Forms.TextBox]'
    $top = 139
    if ($basicScheme) {
      $usernameLabel = New-Object Windows.Forms.Label
      $usernameLabel.Location = New-Object Drawing.Point(24,($top + 4))
      $usernameLabel.Size = New-Object Drawing.Size(150,24)
      $usernameLabel.Text = 'Username'
      $form.Controls.Add($usernameLabel)
      $usernameBox = New-Object Windows.Forms.TextBox
      $usernameBox.Location = New-Object Drawing.Point(180,$top)
      $usernameBox.Size = New-Object Drawing.Size(356,28)
      $usernameBox.MaxLength = 512
      $usernameBox.TabIndex = 0
      $form.Controls.Add($usernameBox)
      $top += 39
    }
    foreach ($headerName in $headerNames) {
      $headerLabel = New-Object Windows.Forms.Label
      $headerLabel.Location = New-Object Drawing.Point(24,($top + 4))
      $headerLabel.Size = New-Object Drawing.Size(150,24)
      $headerLabel.Text = $headerName
      $headerLabel.AutoEllipsis = $true
      $form.Controls.Add($headerLabel)
      $headerBox = New-Object Windows.Forms.TextBox
      $headerBox.Location = New-Object Drawing.Point(180,$top)
      $headerBox.Size = New-Object Drawing.Size(356,28)
      $headerBox.UseSystemPasswordChar = $true
      $headerBox.MaxLength = 4096
      $headerBox.TabIndex = $endpointBoxes.Count + $extraRows
      $form.Controls.Add($headerBox)
      $endpointBoxes.Add($headerBox)
      $top += 39
    }
    $hint = New-Object Windows.Forms.Label
    $hint.Location = New-Object Drawing.Point(24,($top + 4))
    $hint.Size = New-Object Drawing.Size(512,40)
    $hint.Text = 'Values are encrypted for your Windows account and expire with this debug session. Never enter them in chat.'
    $form.Controls.Add($hint)
    $validationLabel = New-Object Windows.Forms.Label
    $validationLabel.Location = New-Object Drawing.Point(24,($top + 50))
    $validationLabel.Size = New-Object Drawing.Size(512,24)
    $validationLabel.ForeColor = [Drawing.Color]::DarkRed
    $form.Controls.Add($validationLabel)
    $useCredential = New-Object Windows.Forms.Button
    $useCredential.Text = 'Use Credential'
    $useCredential.Location = New-Object Drawing.Point(312,($top + 82))
    $useCredential.Size = New-Object Drawing.Size(118,30)
    $useCredential.TabIndex = $endpointBoxes.Count + $extraRows
    $useCredential.Add_Click({
      $dialogUsername = ''
      if ($basicScheme) { $dialogUsername = $usernameBox.Text }
      $problem = Test-EndpointDialogInput $basicScheme $dialogUsername ([string[]]@($endpointBoxes | ForEach-Object { $_.Text }))
      if ($null -ne $problem) {
        $validationLabel.Text = $problem
        return
      }
      $form.DialogResult = [Windows.Forms.DialogResult]::OK
    })
    $form.Controls.Add($useCredential)
    $cancel = New-Object Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.Location = New-Object Drawing.Point(438,($top + 82))
    $cancel.Size = New-Object Drawing.Size(98,30)
    $cancel.TabIndex = $endpointBoxes.Count + $extraRows + 1
    $cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
    $form.Controls.Add($cancel)
    $form.AcceptButton = $useCredential
    $form.CancelButton = $cancel
    $form.Add_Shown({ $form.Activate(); $form.BringToFront(); if ($basicScheme) { $usernameBox.Focus() | Out-Null } else { $endpointBoxes[0].Focus() | Out-Null } })
    $endpointResult = $form.ShowDialog()
    if ($endpointResult -ne [Windows.Forms.DialogResult]::OK) {
      [Console]::Out.Write('{"ok":false,"cancelled":true}')
      $completed = $true
    } else {
      $phase = 'encrypt'
      $vaultFile = Join-Path $vaultRoot ($credentialRef + '.dpapi')
      $now = [DateTimeOffset]::UtcNow
      $expiresAt = $now.AddSeconds($ttl).ToString('o')
      $dialogUsername = ''
      if ($basicScheme) { $dialogUsername = $usernameBox.Text }
      # The dialog rule is enforced again on the stored values: nothing invalid reaches the vault.
      if ($null -ne (Test-EndpointDialogInput $basicScheme $dialogUsername ([string[]]@($endpointBoxes | ForEach-Object { $_.Text })))) { Fail 'invalid_input' }
      $endpointHeaders = New-Object 'Collections.Generic.List[object]'
      if ($basicScheme) {
        $secret = [ordered]@{version=1;kind='endpoint-credential';scheme='basic';binding=$binding;createdAt=$now.ToString('o');expiresAt=$expiresAt;username=$usernameBox.Text;password=$endpointBoxes[0].Text}
      } elseif ($redactOnly) {
        for ($index = 0; $index -lt $headerNames.Count; $index++) { $endpointHeaders.Add([ordered]@{role=$headerNames[$index];value=$endpointBoxes[$index].Text}) }
        $secret = [ordered]@{version=1;kind='endpoint-credential';use='redact-only';binding=$binding;createdAt=$now.ToString('o');expiresAt=$expiresAt;secrets=$endpointHeaders.ToArray()}
      } else {
        for ($index = 0; $index -lt $headerNames.Count; $index++) { $endpointHeaders.Add([ordered]@{name=$headerNames[$index];value=$endpointBoxes[$index].Text}) }
        $secret = [ordered]@{version=1;kind='endpoint-credential';binding=$binding;createdAt=$now.ToString('o');expiresAt=$expiresAt;headers=$endpointHeaders.ToArray()}
      }
      $dialogUsername = $null
      $clear = $secret | ConvertTo-Json -Depth 8 -Compress
      $clearBytes = [Text.Encoding]::UTF8.GetBytes($clear)
      $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $credentialRef)
      $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      foreach ($box in $endpointBoxes) { $box.Clear() }
      if ($basicScheme) { $usernameBox.Clear() }
      $form.Dispose()
      $form = $null
      $phase = 'storage'
      Set-PrivateDirectory $vaultRoot $currentSid
      $stream = [IO.File]::Open($vaultFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      $createdFile = $true
      try { $stream.Write($encrypted,0,$encrypted.Length) } finally { $stream.Dispose() }
      Assert-PrivateFile $vaultFile $currentSid
      # No header value or private storage path belongs in public output.
      [Console]::Out.Write(([ordered]@{ok=$true;kind='endpoint-credential';credentialRef=$credentialRef;expiresAt=$expiresAt;binding=$binding} | ConvertTo-Json -Depth 8 -Compress))
      $completed = $true
    }
  } else {
    $vaultFile = Join-Path $vaultRoot ($credentialRef + '.dpapi')
    if ($Mode -eq 'forget') {
      $phase = 'cleanup'
      $pendingFile = Join-Path $vaultRoot ($credentialRef + '.tmp')
      # The new root and this process's own legacy view only; another package's copy is never deleted.
      $legacyFile = Join-Path $legacyVaultRoot ($credentialRef + '.dpapi')
      $legacyPendingFile = Join-Path $legacyVaultRoot ($credentialRef + '.tmp')
      $forgetPaths = @($vaultFile,$pendingFile,$legacyFile,$legacyPendingFile) | Where-Object { [IO.File]::Exists($_) }
      $candidates = @()
      if (@($forgetPaths).Count -gt 0) {
        foreach ($forgetRoot in @($vaultRoot,$legacyVaultRoot)) {
          if (@($forgetPaths | Where-Object { [IO.Path]::GetDirectoryName($_) -ieq $forgetRoot }).Count -gt 0) { Assert-PrivateDirectory $forgetRoot $currentSid }
        }
        $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $credentialRef)
        foreach ($pendingPath in $forgetPaths) {
          $candidates += Get-ScopedForgetCandidate $pendingPath $currentSid $entropy $binding
        }
        # Validate every existing record before deleting either exact file. A
        # complete record belonging to another binding prevents all cleanup.
        foreach ($candidate in $candidates) { [IO.File]::Delete($candidate.path) }
      }
      [Console]::Out.Write((@{ok=$true;forgotten=(@($candidates).Count -gt 0)} | ConvertTo-Json -Compress))
      $completed = $true
    } else {
      # A lease created before the state root existed is still readable from this process's own legacy
      # view; seal-session rewrites a record and therefore accepts only the new root.
      $readRoot = $vaultRoot
      $readFile = $vaultFile
      if ($Mode -eq 'read' -and -not [IO.File]::Exists($vaultFile)) {
        $readRoot = $legacyVaultRoot
        $readFile = Join-Path $legacyVaultRoot ($credentialRef + '.dpapi')
      }
      Assert-PrivateDirectory $readRoot $currentSid
      Assert-PrivateFile $readFile $currentSid
      $phase = 'decrypt'
      $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $credentialRef)
      $clearBytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($readFile),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      $clear = [Text.Encoding]::UTF8.GetString($clearBytes)
      $secret = $clear | ConvertFrom-Json
      if ((Get-RequiredProperty $secret 'version') -ne 1) { Fail 'credentials_unavailable' }
      $phase = 'binding'
      Assert-Binding (Get-RequiredProperty $secret 'binding') $binding
      $createdAt = [DateTimeOffset]::Parse([string](Get-RequiredProperty $secret 'createdAt'))
      $expiresAt = [DateTimeOffset]::Parse([string](Get-RequiredProperty $secret 'expiresAt'))
      $duration = ($expiresAt - $createdAt).TotalSeconds
      if ($duration -lt 30 -or $duration -gt 3600 -or $createdAt -gt [DateTimeOffset]::UtcNow.AddSeconds(30)) { Fail 'credentials_unavailable' }
        $phase = 'expiration'
        if ($expiresAt -le [DateTimeOffset]::UtcNow) { Fail 'credentials_expired' }
        if ($Mode -eq 'seal-session') {
          $phase = 'encrypt'
          $authenticatedSession = Get-RequiredProperty $request 'session'
          if ($null -eq $authenticatedSession -or $authenticatedSession -isnot [PSCustomObject]) { Fail 'invalid_session' }
          # Replace the credential payload entirely after native authentication;
          # no username/password are retained in the authenticated session record.
          $sealed = [ordered]@{version=1;kind='session';binding=$binding;createdAt=$createdAt.ToString('o');expiresAt=$expiresAt.ToString('o');session=$authenticatedSession}
          if ($null -ne $clearBytes) { [Array]::Clear($clearBytes,0,$clearBytes.Length) }
          $clear = $sealed | ConvertTo-Json -Depth 32 -Compress
          $clearBytes = [Text.Encoding]::UTF8.GetBytes($clear)
          if ($clearBytes.Length -gt 61440) { Fail 'invalid_session' }
          $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
          $phase = 'storage'
          $temporaryFile = Join-Path $vaultRoot ($credentialRef + '.tmp')
          $stream = [IO.File]::Open($temporaryFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
          $createdTemporaryFile = $true
          try { $stream.Write($encrypted,0,$encrypted.Length) } finally { $stream.Dispose() }
          Assert-PrivateFile $temporaryFile $currentSid
          # File.Replace avoids a period where the reference is missing or partial.
          [IO.File]::Replace($temporaryFile,$vaultFile,[NullString]::Value)
          $temporaryFile = $null
          [Console]::Out.Write(([ordered]@{ok=$true;credentialRef=$credentialRef;kind='session';expiresAt=$expiresAt.ToString('o');binding=$binding} | ConvertTo-Json -Depth 8 -Compress))
        } else {
          $kind = [string](Get-RequiredProperty $secret 'kind')
          if ($kind -eq 'credentials') {
            $username = [string](Get-RequiredProperty $secret 'username')
            $password = [string](Get-RequiredProperty $secret 'password')
            if ([string]::IsNullOrWhiteSpace($username) -or $username.Length -gt 512 -or $password.Length -eq 0 -or $password.Length -gt 4096) { Fail 'credentials_unavailable' }
            $privateOutput = [ordered]@{ok=$true;kind='credentials';username=$username;password=$password;expiresAt=$expiresAt.ToString('o');binding=$binding}
          } elseif ($kind -eq 'session') {
            $privateOutput = [ordered]@{ok=$true;kind='session';session=(Get-RequiredProperty $secret 'session');expiresAt=$expiresAt.ToString('o');binding=$binding}
          } elseif ($kind -eq 'endpoint-credential') {
            # Exactly the bound payload: header values in order, a Basic pair or the declared redaction roles.
            if (-not $binding.Contains('serviceKey') -and -not $binding.Contains('use')) { Fail 'credentials_unavailable' }
            $endpointOutput = Get-EndpointCredentialPayload $secret $binding
            $privateOutput = [ordered]@{ok=$true;kind='endpoint-credential'}
            foreach ($field in $endpointOutput.Keys) { $privateOutput[$field] = $endpointOutput[$field] }
            $privateOutput['expiresAt'] = $expiresAt.ToString('o')
            $privateOutput['binding'] = $binding
          } else { Fail 'credentials_unavailable' }
          # Private worker pipe only. Caller must never log or forward this output.
          [Console]::Out.Write(($privateOutput | ConvertTo-Json -Depth 32 -Compress))
        }
      $completed = $true
    }
  }
} catch {
  # Exception text can include data supplied by the user. Emit only fixed text.
  [Console]::Out.Write(([ordered]@{ok=$false;error='debug_app_user_credentials_unavailable';phase=$phase;message='The application sign-in could not be completed. No credential value was logged.'} | ConvertTo-Json -Compress))
} finally {
  if ($null -ne $passwordBox -and -not $passwordBox.IsDisposed) { $passwordBox.Clear() }
  if ($null -ne $usernameBox -and -not $usernameBox.IsDisposed) { $usernameBox.Clear() }
  if ($null -ne $endpointBoxes) { foreach ($box in $endpointBoxes) { if (-not $box.IsDisposed) { $box.Clear() } } }
  if ($null -ne $form) { $form.Dispose() }
  if ($null -ne $clearBytes) { [Array]::Clear($clearBytes,0,$clearBytes.Length) }
  if ($createdFile -and -not $completed -and $null -ne $vaultFile) {
    try { [IO.File]::Delete($vaultFile) } catch { }
  }
  if ($createdTemporaryFile -and $null -ne $temporaryFile) { try { [IO.File]::Delete($temporaryFile) } catch { } }
  $clear = $null
  $username = $null
  $password = $null
  $secret = $null
  $request = $null
  $privateOutput = $null
  $sealed = $null
  $authenticatedSession = $null
  $endpointHeaders = $null
  $endpointOutput = $null
  $storedHeaders = $null
  $headerValue = $null
  $endpointPayload = $null
  $savedEndpointProfile = $null
  $endpointProfileRecord = $null
  $dialogUsername = $null
}
if (-not $completed) { exit 1 }
