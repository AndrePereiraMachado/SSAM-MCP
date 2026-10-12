param(
  [ValidateSet('Seal','Open','Forget','Import')][string]$Mode,
  [ValidatePattern('^[a-f0-9-]{36}$')][string]$PlanId,
  [string]$InputFile,
  [string]$StateRoot,
  [string]$SourceRoot
)
$ErrorActionPreference = 'Stop'
# Native application request authentication belongs to the current Windows user, never the repository.
# Clear text travels only over private parent/child pipes. Nothing is printed on an error.
# Records live under <debugger state root>\invoke (%USERPROFILE%\.ssam-hybrid\debugger, or SSAM_DEBUG_STATE_ROOT),
# outside the per-app MSIX copy of %LOCALAPPDATA%. %LOCALAPPDATA%\SSAM\DebugInvoke is a legacy copy: Open falls
# back to it and Forget clears it; another package's copy is only opened read only through -SourceRoot.
function Assert-NoReparse([string]$Path) {
  if ([IO.File]::Exists($Path) -or [IO.Directory]::Exists($Path)) {
    if (([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private storage is a reparse point' }
  }
}
function Resolve-DebugStateRoot([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { $Value = $env:SSAM_DEBUG_STATE_ROOT }
  if ([string]::IsNullOrWhiteSpace($Value)) {
    $profileRoot = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($profileRoot)) { $profileRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile) }
    $Value = Join-Path (Join-Path $profileRoot '.ssam-hybrid') 'debugger'
  }
  $Value = $Value.TrimEnd('\')
  if ($Value.StartsWith('\\') -or -not [IO.Path]::IsPathRooted($Value)) { throw 'Invalid state root' }
  $full = [IO.Path]::GetFullPath($Value).TrimEnd('\')
  if ($full -cne $Value -or $full -match '\\Packages\\[^\\]+\\LocalCache(\\|$)') { throw 'Invalid state root' }
  return $full
}
try {
  $phase = 'encoding'
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  $phase = 'identity'
  Add-Type -AssemblyName System.Security
  $stateRoot = Resolve-DebugStateRoot $StateRoot
  $vaultRoot = Join-Path $stateRoot 'invoke'
  $vaultFile = Join-Path $vaultRoot ($PlanId + '.dpapi')
  $legacyRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'SSAM\DebugInvoke'))
  $legacyFile = Join-Path $legacyRoot ($PlanId + '.dpapi')
  foreach ($candidate in @($stateRoot,$vaultRoot,$vaultFile)) { Assert-NoReparse $candidate }
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugInvoke.v1|' + $PlanId)
  if ($Mode -eq 'Seal' -or $Mode -eq 'Import') {
    $phase = 'input'
    if ($Mode -eq 'Import') {
      $resolvedInput = [IO.Path]::GetFullPath($InputFile)
      $inputAcl = [IO.File]::GetAccessControl($resolvedInput)
      if ($inputAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { throw 'Private input must be owned by current user' }
      foreach ($rule in $inputAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($currentSid.Value,'S-1-5-18','S-1-5-32-544')) { throw 'Input must not grant other users access' }
      }
      $clear = [IO.File]::ReadAllText($resolvedInput)
    } else { $clear = [Console]::In.ReadToEnd() }
    if ($clear.Length -gt 4194304 -or $clear.Length -eq 0) { throw 'Invalid private request size' }
    $null = $clear | ConvertFrom-Json
    $phase = 'directory'
    if (-not [IO.Directory]::Exists($vaultRoot)) { $null = [IO.Directory]::CreateDirectory($vaultRoot) }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($currentSid)
    $acl.SetAccessRuleProtection($true,$false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($currentSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
    $phase = 'acl'
    [IO.Directory]::SetAccessControl($vaultRoot,$acl)
    $phase = 'encrypt'
    $bytes = [Text.Encoding]::UTF8.GetBytes($clear)
    $protected = [Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $phase = 'write'
    $stream = [IO.File]::Open($vaultFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($protected,0,$protected.Length) } finally { $stream.Dispose() }
    [Console]::Out.Write('{"ok":true}')
  } elseif ($Mode -eq 'Open') {
    $phase = 'source'
    if (-not [string]::IsNullOrWhiteSpace($SourceRoot)) {
      # Read only: the new root itself or a legacy <...>\SSAM\DebugInvoke copy (any package store of this user).
      $source = $SourceRoot.TrimEnd('\')
      if ($source.StartsWith('\\') -or -not [IO.Path]::IsPathRooted($source) -or [IO.Path]::GetFullPath($source).TrimEnd('\') -cne $source) { throw 'Invalid source root' }
      if ($source -ine $vaultRoot -and ((Split-Path $source -Leaf) -cne 'DebugInvoke' -or (Split-Path (Split-Path $source -Parent) -Leaf) -cne 'SSAM')) { throw 'Invalid source root' }
      $openFile = Join-Path $source ($PlanId + '.dpapi')
      foreach ($candidate in @((Split-Path $source -Parent),$source,$openFile)) { Assert-NoReparse $candidate }
    } elseif ([IO.File]::Exists($vaultFile)) { $openFile = $vaultFile }
    else { foreach ($candidate in @($legacyRoot,$legacyFile)) { Assert-NoReparse $candidate }; $openFile = $legacyFile }
    $phase = 'decrypt'
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($openFile),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
  } else {
    $phase = 'forget'
    # Only the new root and this process's own legacy view; other package stores are never written.
    foreach ($candidate in @($legacyRoot,$legacyFile)) { Assert-NoReparse $candidate }
    foreach ($file in @($vaultFile,$legacyFile)) { if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) } }
    [Console]::Out.Write('{"ok":true}')
  }
} catch { [Console]::Out.Write((@{ok=$false;error='invoke_private_request_unavailable';phase=$phase;failureType=$_.Exception.GetType().Name} | ConvertTo-Json -Compress)); exit 1 }
