param([ValidateSet('status','read','bootstrap')][string]$Mode='status', [Parameter(Mandatory=$true)][string]$Origin, [string]$Database='', [string]$Setting='', [string]$ProfileTarget='', [string]$Principal='')
$ErrorActionPreference = 'Stop'
# One entry per tenant host: SSAM/ODC3/<host>/Portal for the Portal account, SSAM/ODC3/<host>/DB/<name> for the
# account of an external database connection, SSAM/ODC3/<host>/Setting/<name> for a secret setting value (the
# password; the user name is ignored). The caller must supply the target origin. DB and Setting
# entries are never read here: only the bridge reads them, inside the ODC Studio, right before the send (secretRefs).
$tenantHost = ([uri]$Origin).Host
if ([string]::IsNullOrWhiteSpace($tenantHost) -or ([uri]$Origin).Scheme -ne 'https') { throw 'Origin must be an HTTPS origin' }
if ($Database -and $Database -notmatch '^[A-Za-z0-9_.-]{1,64}$') { throw 'Invalid database entry name' }
if ($Setting -and $Setting -notmatch '^[A-Za-z0-9_.-]{1,64}$') { throw 'Invalid setting entry name' }
if ($Database -and $Setting) { throw 'Choose -Database or -Setting' }
if ($Mode -eq 'read' -and ($Database -or $Setting)) { throw 'Database accounts and setting values are read only inside the ODC Studio' }
$credentialTarget = if ($Setting) { "SSAM/ODC3/$tenantHost/Setting/$Setting" } elseif ($Database) { "SSAM/ODC3/$tenantHost/DB/$Database" } else { "SSAM/ODC3/$tenantHost/Portal" }
if ($ProfileTarget) {
 if($Database -or $Setting -or $Mode -eq 'bootstrap'){throw 'Profiles apply only to Portal authentication'}
 if($ProfileTarget -ne $credentialTarget -and $ProfileTarget -notmatch ('^'+[regex]::Escape($credentialTarget)+'/Profiles/[a-f0-9]{64}/[a-f0-9-]{36}$')){throw 'Profile belongs to another context'}
 $credentialTarget=$ProfileTarget
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OdcPortalVault {
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
  $purpose = if ($Setting) { "the secret value of the ODC setting '$Setting' of $tenantHost, typed as the password (the user name is ignored)" } elseif ($Database) { "the external database connection '$Database' of $tenantHost (database user and password)" } else { "ODC3 Portal access for $tenantHost (your Portal account)" }
  $ask = @{ Message = "$purpose. Enter the credentials here, never in chat. Stored only in Windows Credential Manager." }
  if ($Setting) { $ask.UserName = 'setting' }
  $entered = Get-Credential @ask
  if ($null -eq $entered) { throw 'Cancelled' }
  $plain = $entered.GetNetworkCredential().Password
  $pointer = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($plain)
  try {
   $record = New-Object OdcPortalVault+Credential
   $record.Type=1; $record.TargetName=$credentialTarget; $record.UserName=$entered.UserName
   $record.CredentialBlob=$pointer; $record.CredentialBlobSize=[Text.Encoding]::Unicode.GetByteCount($plain)
   if ($record.CredentialBlobSize -eq 0 -or $record.CredentialBlobSize -gt 2560) { throw 'Invalid credential size' }
   $record.Persist=2
   if (![OdcPortalVault]::Write([ref]$record,0)) { throw 'Credential storage failed' }
  } finally { [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($pointer); $plain=$null; $entered=$null }
  @{ok=$true;stored=$true;target='odc3';origin="https://$tenantHost";entry=$credentialTarget} | ConvertTo-Json -Compress
  exit 0
 }
 $native=[IntPtr]::Zero
 $found=[OdcPortalVault]::Read($credentialTarget,1,0,[ref]$native)
 if (!$found) {
  if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Credential manager unavailable' }
  @{available=$false;target='odc3'} | ConvertTo-Json -Compress
  exit 0
 }
 try {
  if ($Mode -eq 'status') { @{available=$true;target='odc3'} | ConvertTo-Json -Compress; exit 0 }
  # Private subprocess channel consumed only by the broker. Never invoke read as
  # a model-facing command, log this stdout, or put it into a tool result.
  $record=[Runtime.InteropServices.Marshal]::PtrToStructure($native,[type][OdcPortalVault+Credential])
  if($Principal -and $record.UserName.Trim().ToLowerInvariant() -ne $Principal.Trim().ToLowerInvariant()){throw 'Profile principal changed'}
  $value=[Runtime.InteropServices.Marshal]::PtrToStringUni($record.CredentialBlob,[int]($record.CredentialBlobSize/2))
  @{available=$true;username=$record.UserName;password=$value} | ConvertTo-Json -Compress
  $value=$null
 } finally { [OdcPortalVault]::CredFree($native) }
} catch {
 [Console]::Error.WriteLine('ODC3 managed credential operation failed. No credential value was logged.')
 exit 1
}
