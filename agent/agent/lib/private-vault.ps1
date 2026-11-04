# Shared Windows Credential Manager and secret redaction primitives for private Agent sessions.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UsersVault {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Credential { public uint Flags,Type; public string TargetName,Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist,AttributeCount; public IntPtr Attributes; public string TargetAlias,UserName; }
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target,uint type,uint flags,out IntPtr value);
 [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Write(ref Credential value,uint flags);
 [DllImport("advapi32.dll", EntryPoint="CredEnumerateW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Enumerate(string filter,uint flags,out int count,out IntPtr list);
 [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Delete(string target,uint type,uint flags);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr value);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle,int command);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
}
'@
function ReadVault([string]$target,[bool]$secret) {
 $p=[IntPtr]::Zero
 if (-not [UsersVault]::Read($target,1,0,[ref]$p)) { return $null }
 try {
  $c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][UsersVault+Credential])
  if ($c.CredentialBlobSize -eq 0 -or $c.CredentialBlobSize % 2 -ne 0) { return $null }
  $value=if($secret){[Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob,[int]($c.CredentialBlobSize/2))}else{$null}
  return @{UserName=$c.UserName;Secret=$value}
 } finally { [UsersVault]::CredFree($p) }
}
# FILETIME uses signed Int32 fields in the Win32 interop structure, but both halves are unsigned bits.
# Reinterpret those bits with a 64-bit mask; casting a negative half to UInt32 throws.
function Convert-VaultFileTime($fileTime) {
 $low=([int64]$fileTime.dwLowDateTime -band 4294967295L)
 $high=([int64]$fileTime.dwHighDateTime -band 4294967295L)
 return [DateTime]::FromFileTimeUtc(($high -shl 32) -bor $low)
}
# The names of this scope's entries, never their secrets.
function Names([string]$filter) {
 $count=0;$list=[IntPtr]::Zero;$names=@()
 if ([UsersVault]::Enumerate($filter,0,[ref]$count,[ref]$list)) {
  try { for($i=0;$i -lt $count;$i++){ $p=[Runtime.InteropServices.Marshal]::ReadIntPtr($list,$i*[IntPtr]::Size); $c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][UsersVault+Credential]); $names+=[pscustomobject]@{Name=$c.TargetName;Written=(Convert-VaultFileTime $c.LastWritten)} } }
  finally { [UsersVault]::CredFree($list) }
 }
 return $names
}

function Form([string]$s) { [Net.WebUtility]::UrlEncode($s) }
function B64([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }
function Redact([string]$text,[string]$secret) {
 if(-not $secret){return $text}
 $html=[Net.WebUtility]::HtmlEncode($secret)
 $forms=@($secret,$html,$html.Replace('&#39;','&apos;'),(Form $secret),[Uri]::EscapeDataString($secret),$secret.Replace('\','\\').Replace('"','\"').Replace("'","\'"),$secret.Replace('<','\u003c').Replace('>','\u003e').Replace('&','\u0026'),[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($secret)),[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($secret)))
 foreach($echo in ($forms|Select-Object -Unique)){ $text=[regex]::Replace($text,[regex]::Escape($echo),'[redacted]','IgnoreCase') }
 return $text
}
