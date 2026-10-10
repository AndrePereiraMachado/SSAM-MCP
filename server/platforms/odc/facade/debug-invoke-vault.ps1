param(
  [ValidateSet('Seal','Open','Forget','Import')][string]$Mode,
  [ValidatePattern('^[a-f0-9-]{36}$')][string]$PlanId,
  [string]$InputFile
)
$ErrorActionPreference = 'Stop'
# Native application request authentication belongs to the current Windows user, never the repository.
# Clear text travels only over private parent/child pipes. Nothing is printed on an error.
try {
  $phase = 'encoding'
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  $phase = 'identity'
  Add-Type -AssemblyName System.Security
  $vaultRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'SSAM\DebugInvoke'))
  $vaultFile = Join-Path $vaultRoot ($PlanId + '.dpapi')
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
    $phase = 'decrypt'
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($vaultFile),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
  } else {
    $phase = 'forget'
    if ([IO.File]::Exists($vaultFile)) { [IO.File]::Delete($vaultFile) }
    [Console]::Out.Write('{"ok":true}')
  }
} catch { [Console]::Out.Write((@{ok=$false;error='invoke_private_request_unavailable';phase=$phase;failureType=$_.Exception.GetType().Name} | ConvertTo-Json -Compress)); exit 1 }
