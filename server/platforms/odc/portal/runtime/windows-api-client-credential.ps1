param([ValidateSet('status','read','bootstrap')][string]$Mode='status', [string]$Origin='https://wrightflood.outsystems.dev', [string]$FixtureOperationUuid='')
$ErrorActionPreference = 'Stop'
# One Credential Manager entry per tenant host. The default keeps the entry created on 2026-09-15 for the
# WrightFlood tenant; other tenants use the same naming with their own host.
$tenantHost = ([uri]$Origin).Host
if ([string]::IsNullOrWhiteSpace($tenantHost) -or ([uri]$Origin).Scheme -ne 'https') { throw 'Origin must be an HTTPS origin' }
$credentialTarget = "SSAM/ODC3/$tenantHost/APIClient"
if($FixtureOperationUuid){
 if($Mode -ne 'status' -or $FixtureOperationUuid -cnotmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){throw 'Fixture destination supports only status with its canonical operation UUID'}
 $credentialTarget="SSAM/ODC3/$tenantHost/APIClientFixture/$FixtureOperationUuid"
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OdcApiClientVault {
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
function Read-ApiClientCredential {
 Add-Type -AssemblyName System.Windows.Forms
 Add-Type -AssemblyName System.Drawing
 $form = New-Object System.Windows.Forms.Form
 $form.Text = 'Configure ODC3 API Client'
 $form.StartPosition = 'CenterScreen'
 $form.ClientSize = New-Object System.Drawing.Size(560,220)
 $form.FormBorderStyle = 'FixedDialog'
 $form.MaximizeBox = $false
 $form.MinimizeBox = $false
 $form.TopMost = $true

 $message = New-Object System.Windows.Forms.Label
 $message.Location = New-Object System.Drawing.Point(20,15)
 $message.Size = New-Object System.Drawing.Size(520,42)
 $message.Text = "Enter the ODC API Client credentials for $tenantHost. The secret stays in Windows Credential Manager and must never be pasted into chat."
 $form.Controls.Add($message)

 $idLabel = New-Object System.Windows.Forms.Label
 $idLabel.Location = New-Object System.Drawing.Point(20,72)
 $idLabel.Size = New-Object System.Drawing.Size(120,22)
 $idLabel.Text = 'API Client ID'
 $form.Controls.Add($idLabel)
 $idBox = New-Object System.Windows.Forms.TextBox
 $idBox.Location = New-Object System.Drawing.Point(150,70)
 $idBox.Size = New-Object System.Drawing.Size(385,24)
 $form.Controls.Add($idBox)

 $secretLabel = New-Object System.Windows.Forms.Label
 $secretLabel.Location = New-Object System.Drawing.Point(20,112)
 $secretLabel.Size = New-Object System.Drawing.Size(120,22)
 $secretLabel.Text = 'API Client secret'
 $form.Controls.Add($secretLabel)
 $secretBox = New-Object System.Windows.Forms.TextBox
 $secretBox.Location = New-Object System.Drawing.Point(150,110)
 $secretBox.Size = New-Object System.Drawing.Size(385,24)
 $secretBox.UseSystemPasswordChar = $true
 $form.Controls.Add($secretBox)

 $save = New-Object System.Windows.Forms.Button
 $save.Location = New-Object System.Drawing.Point(350,165)
 $save.Size = New-Object System.Drawing.Size(88,30)
 $save.Text = 'Save'
 $save.DialogResult = [System.Windows.Forms.DialogResult]::OK
 $form.Controls.Add($save)
 $cancel = New-Object System.Windows.Forms.Button
 $cancel.Location = New-Object System.Drawing.Point(447,165)
 $cancel.Size = New-Object System.Drawing.Size(88,30)
 $cancel.Text = 'Cancel'
 $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
 $form.Controls.Add($cancel)
 $form.AcceptButton = $save
 $form.CancelButton = $cancel
 $form.Add_Shown({ $idBox.Focus() })

 try {
  if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
  $secure = ConvertTo-SecureString $secretBox.Text -AsPlainText -Force
  return [System.Management.Automation.PSCredential]::new($idBox.Text, $secure)
 } finally {
  $idBox.Text = ''; $secretBox.Text = ''
  $form.Dispose()
 }
}
try {
 if ($Mode -eq 'bootstrap') {
  $entered = Read-ApiClientCredential
  if ($null -eq $entered) { throw 'Cancelled' }
  $clientId = $entered.UserName
  $clientSecret = $entered.GetNetworkCredential().Password
  if ([string]::IsNullOrWhiteSpace($clientId) -or [string]::IsNullOrWhiteSpace($clientSecret)) { throw 'Incomplete API Client credential' }
  $pointer = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($clientSecret)
  try {
   $record = New-Object OdcApiClientVault+Credential
   $record.Type=1; $record.TargetName=$credentialTarget; $record.UserName=$clientId
   $record.CredentialBlob=$pointer; $record.CredentialBlobSize=[Text.Encoding]::Unicode.GetByteCount($clientSecret)
   if ($record.CredentialBlobSize -eq 0 -or $record.CredentialBlobSize -gt 2560) { throw 'Invalid credential size' }
   $record.Persist=2
   if (![OdcApiClientVault]::Write([ref]$record,0)) { throw 'Credential storage failed' }
  } finally {
   [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($pointer)
   $clientSecret=$null; $clientId=$null; $entered=$null
  }
  @{ok=$true;stored=$true;target='odc3-api-client';origin=$Origin} | ConvertTo-Json -Compress
  exit 0
 }
 $native=[IntPtr]::Zero
 $found=[OdcApiClientVault]::Read($credentialTarget,1,0,[ref]$native)
 if (!$found) {
  if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Credential manager unavailable' }
  if($FixtureOperationUuid){@{available=$false;target='odc3-api-client-fixture';fixtureOperationUuid=$FixtureOperationUuid;entry=$credentialTarget}|ConvertTo-Json -Compress}else{@{available=$false;target='odc3-api-client'} | ConvertTo-Json -Compress}
  exit 0
 }
 try {
  if ($Mode -eq 'status') { if($FixtureOperationUuid){@{available=$true;target='odc3-api-client-fixture';fixtureOperationUuid=$FixtureOperationUuid;entry=$credentialTarget}|ConvertTo-Json -Compress}else{@{available=$true;target='odc3-api-client'} | ConvertTo-Json -Compress}; exit 0 }
  # Private subprocess channel consumed only by the broker. Never invoke read as
  # a model-facing command, log this stdout, or put it into a tool result.
  $record=[Runtime.InteropServices.Marshal]::PtrToStructure($native,[type][OdcApiClientVault+Credential])
  $value=[Runtime.InteropServices.Marshal]::PtrToStringUni($record.CredentialBlob,[int]($record.CredentialBlobSize/2))
  @{available=$true;clientId=$record.UserName;clientSecret=$value} | ConvertTo-Json -Compress
  $value=$null
 } finally { [OdcApiClientVault]::CredFree($native) }
} catch {
 [Console]::Error.WriteLine('ODC3 API Client credential operation failed. No credential value was logged.')
 exit 1
}
