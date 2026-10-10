param(
 [ValidateSet('status','bootstrap')][string]$Mode='status',
 [ValidateSet('ServiceCenter','LifeTime','DatabaseConnection','SiteProperty')][string]$Kind='ServiceCenter',
 [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$')][string]$HostName,
 [ValidatePattern('^[A-Za-z0-9_.-]{1,100}$')][string]$Name
)
# Private O11 credential prompt, opened by the Service Center tools in its own window when the vault has no entry (or
# the sign-in rejected the stored ServiceCenter login). The user types here; the value goes straight to Windows Credential Manager
# and is never written to the console, a file or the caller. Nothing is read back in any mode.
$ErrorActionPreference = 'Stop'
$HostName = $HostName.ToLowerInvariant()
if ($Kind -eq 'DatabaseConnection') {
 if (-not $Name) { throw 'DatabaseConnection needs -Name' }
 $credentialTarget = "SSAM/O11/$HostName/DatabaseConnection/$Name"
 $message = "External database login for the Service Center connection '$Name' on $HostName. Type it here, never in chat. Stored only in Windows Credential Manager; the Studio fills it into the form inside its own process."
} elseif ($Kind -eq 'SiteProperty') {
 if (-not $Name) { throw 'SiteProperty needs -Name' }
 $credentialTarget = "SSAM/O11/$HostName/SiteProperty/$Name"
 $message = "Secret value of the site property '$Name' on ${HostName}, typed as the password (the user name is ignored). Type it here, never in chat. Stored only in Windows Credential Manager; the Studio fills it into the form inside its own process."
} elseif ($Kind -eq 'LifeTime') {
 $credentialTarget = "SSAM/O11/$HostName/LifeTime"
 $message = "LifeTime service account for $HostName. User name: the service account; password: its token. Type it here, never in chat. Stored only in Windows Credential Manager."
} else {
 $credentialTarget = "SSAM/O11/$HostName/ServiceCenter"
 $message = "Service Center login for $HostName (an OutSystems account: its e-mail and password). Type it here, never in chat. Stored only in Windows Credential Manager; the Studio signs its hidden Service Center window in with it, inside its own process."
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class O11Vault {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Credential {
  public uint Flags, Type; public string TargetName, Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist, AttributeCount; public IntPtr Attributes; public string TargetAlias, UserName;
 }
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target,uint type,uint flags,out IntPtr value);
 [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Write(ref Credential value,uint flags);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr value);
}
'@
try {
 if ($Mode -eq 'bootstrap') {
  $ask = @{ Message = $message }
  if ($Kind -eq 'LifeTime') { $ask.UserName = 'service-account' }
  if ($Kind -eq 'SiteProperty') { $ask.UserName = 'site-property' }
  $entered = Get-Credential @ask
  if ($null -eq $entered) { throw 'Cancelled' }
  $plain = $entered.GetNetworkCredential().Password
  $pointer = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($plain)
  try {
   $record = New-Object O11Vault+Credential
   $record.Type=1; $record.TargetName=$credentialTarget; $record.UserName=$entered.UserName
   $record.CredentialBlob=$pointer; $record.CredentialBlobSize=[Text.Encoding]::Unicode.GetByteCount($plain)
   if ($record.CredentialBlobSize -eq 0 -or $record.CredentialBlobSize -gt 5120 -or -not $entered.UserName) { throw 'Invalid credential size' }
   $record.Persist=2
   if (![O11Vault]::Write([ref]$record,0)) { throw 'Credential storage failed' }
  } finally { [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($pointer); $plain=$null; $entered=$null }
  @{ok=$true;stored=$true;target=$credentialTarget} | ConvertTo-Json -Compress
  Write-Host 'Stored. You can close this window and repeat the request in the agent.'
  exit 0
 }
 $native=[IntPtr]::Zero
 $found=[O11Vault]::Read($credentialTarget,1,0,[ref]$native)
 if ($found) { [O11Vault]::CredFree($native) }
 elseif ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Credential manager unavailable' }
 @{available=[bool]$found;target=$credentialTarget} | ConvertTo-Json -Compress
} catch {
 [Console]::Error.WriteLine('O11 credential operation failed. No credential value was logged.')
 exit 1
}
