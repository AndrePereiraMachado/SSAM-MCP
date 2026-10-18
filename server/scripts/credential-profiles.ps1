param(
 [ValidateSet('list','choose','launch')][string]$Mode='list',
 [Parameter(Mandatory=$true)][ValidateSet('o11','odc')][string]$Lane,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$')][string]$HostName,
 [string]$Principal='', [string]$SelectionFile='', [string]$ContextKey='', [string]$PendingFile=''
)
# Metadata enumeration never decodes a blob. Only the private dialog writes a new credential.
# No passwords on stdout, command arguments, selection files, logs or the model channel.
$ErrorActionPreference='Stop'
if($Mode -eq 'launch') {
 if(!$SelectionFile -or !$PendingFile -or $ContextKey -notmatch '^[a-f0-9]{64}$'){throw 'Invalid selection context'}
 $argsList=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-Mode','choose','-Lane',$Lane,'-HostName',$HostName,'-SelectionFile',$SelectionFile,'-ContextKey',$ContextKey,'-PendingFile',$PendingFile)
 if($Principal){$argsList+=@('-Principal',$Principal)}
 $quoted=($argsList | ForEach-Object { '"'+($_ -replace '(\\*)"','$1$1\"' -replace '(\\+)$','$1$1')+'"' }) -join ' '
 $child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $quoted -WindowStyle Hidden -PassThru
 @{pid=$child.Id}|ConvertTo-Json -Compress
 exit 0
}
$baseTarget=if($Lane -eq 'o11'){"SSAM/O11/$HostName/ServiceCenter"}else{"SSAM/ODC3/$HostName/Portal"}
$Principal=$Principal.Trim().ToLowerInvariant()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SsamProfileVault {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Credential {
  public uint Flags, Type; public string TargetName, Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist, AttributeCount; public IntPtr Attributes; public string TargetAlias, UserName;
 }
 [DllImport("advapi32.dll", EntryPoint="CredEnumerateW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Enumerate(string filter,uint flags,out uint count,out IntPtr values);
 [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Write(ref Credential value,uint flags);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr value);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
function Get-Profiles {
 $count=[uint32]0; $values=[IntPtr]::Zero; $result=@()
 if([SsamProfileVault]::Enumerate($baseTarget+'*',0,[ref]$count,[ref]$values)) {
  try { for($i=0;$i -lt $count;$i++) {
   $ptr=[Runtime.InteropServices.Marshal]::ReadIntPtr($values,$i*[IntPtr]::Size)
   $c=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[type][SsamProfileVault+Credential])
   $user=([string]$c.UserName).Trim().ToLowerInvariant()
   $valid=($c.TargetName -eq $baseTarget -or $c.TargetName -match ('^'+[regex]::Escape($baseTarget)+'/Profiles/[a-f0-9]{64}/[a-f0-9-]{36}$'))
   if($valid -and $c.Type -eq 1 -and $c.CredentialBlobSize -gt 0 -and $user -and (!$Principal -or $Principal -eq $user)) {
    $result+=@{target=$c.TargetName;principal=$user}
   }
  }} finally {[SsamProfileVault]::CredFree($values)}
 } elseif([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168){throw 'Credential metadata unavailable'}
 return $result
}
$dialogMutex=$null; $ownsDialog=$false
try {
 if($Mode -eq 'choose') {
  if(!$SelectionFile -or !$PendingFile -or $ContextKey -notmatch '^[a-f0-9]{64}$'){throw 'Invalid selection context'}
  $dialogMutex=New-Object System.Threading.Mutex($false,('Local\SSAMProfile-'+$ContextKey))
  try{$ownsDialog=$dialogMutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$ownsDialog=$true}
  if(!$ownsDialog){exit 0}
  [IO.File]::WriteAllText($PendingFile,(@{state='starting';pid=$PID}|ConvertTo-Json -Compress))
 }
 $profiles=@(Get-Profiles)
 if($Mode -eq 'list') { @{profiles=$profiles}|ConvertTo-Json -Depth 4 -Compress; exit 0 }
 if(!$SelectionFile -or !$PendingFile -or $ContextKey -notmatch '^[a-f0-9]{64}$'){throw 'Invalid selection context'}
 Add-Type -AssemblyName System.Windows.Forms
 Add-Type -AssemblyName System.Drawing
 $form=New-Object System.Windows.Forms.Form
 $form.Text='SSAM — credentials'; $form.Size=New-Object System.Drawing.Size(550,300)
 $form.StartPosition='CenterScreen';$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false;$form.MinimizeBox=$false
 $label=New-Object System.Windows.Forms.Label
 $label.Text="$Lane — $HostName`r`nChoose a profile or add a credential. The values stay in the Windows Vault."
 $label.Location=New-Object System.Drawing.Point(15,15);$label.Size=New-Object System.Drawing.Size(510,45);$form.Controls.Add($label)
 $choice=New-Object System.Windows.Forms.ComboBox
 $choice.DropDownStyle='DropDownList';$choice.Location=New-Object System.Drawing.Point(15,65);$choice.Width=505
 foreach($p in $profiles){[void]$choice.Items.Add($p.principal+' — '+$p.target.Split('/')[-1])}
 [void]$choice.Items.Add('Add a new credential');$choice.SelectedIndex=$profiles.Count;$form.Controls.Add($choice)
 $user=New-Object System.Windows.Forms.TextBox;$user.Location=New-Object System.Drawing.Point(15,105);$user.Width=505;$user.Text=$Principal;$user.ReadOnly=[bool]$Principal;$form.Controls.Add($user)
 $password=New-Object System.Windows.Forms.TextBox;$password.Location=New-Object System.Drawing.Point(15,145);$password.Width=505;$password.UseSystemPasswordChar=$true;$form.Controls.Add($password)
 $hint=New-Object System.Windows.Forms.Label;$hint.Text='User above; password below. Nothing is sent to the chat.';$hint.Location=New-Object System.Drawing.Point(15,178);$hint.Size=New-Object System.Drawing.Size(500,22);$form.Controls.Add($hint)
 $ok=New-Object System.Windows.Forms.Button;$ok.Text='Use / Save';$ok.Location=New-Object System.Drawing.Point(285,215);$ok.Width=120;$form.Controls.Add($ok)
 $cancel=New-Object System.Windows.Forms.Button;$cancel.Text='Cancel';$cancel.Location=New-Object System.Drawing.Point(410,215);$cancel.DialogResult='Cancel';$form.Controls.Add($cancel);$form.CancelButton=$cancel
 $choice.Add_SelectedIndexChanged({$adding=$choice.SelectedIndex -eq $profiles.Count;$user.Enabled=$adding;$password.Enabled=$adding})
 $script:chosen=$null
 $ok.Add_Click({
  try {
   if($choice.SelectedIndex -lt $profiles.Count){$script:chosen=$profiles[$choice.SelectedIndex]}
   else {
    $login=$user.Text.Trim().ToLowerInvariant()
    if(!$login -or !$password.Text -or ($Principal -and $login -ne $Principal)){throw 'Enter the user and password of the context shown.'}
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($login)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    $target=$baseTarget+'/Profiles/'+$hash+'/'+[Guid]::NewGuid().ToString()
    $pointer=[Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($password.Text)
    try {
     $record=New-Object SsamProfileVault+Credential;$record.Type=1;$record.TargetName=$target;$record.UserName=$login;$record.Persist=2
     $record.CredentialBlob=$pointer;$record.CredentialBlobSize=[Text.Encoding]::Unicode.GetByteCount($password.Text)
     if($record.CredentialBlobSize -gt 2560){throw 'The credential exceeds the allowed size.'}
     if(![SsamProfileVault]::Write([ref]$record,0)){throw 'The credential could not be saved.'}
    }finally{[Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($pointer);$password.Clear()}
    $script:chosen=@{target=$target;principal=$login}
   }
   $form.DialogResult='OK';$form.Close()
  }catch{[void][System.Windows.Forms.MessageBox]::Show('This profile could not be used. Check the fields.','SSAM')}
 })
 $form.Add_Shown({
  # Start-Process hides the console; its STARTUPINFO can also hide the first form.
  # Explicitly show our dialog and confirm the native visibility before acknowledging.
  [void][SsamProfileVault]::ShowWindow($form.Handle,5)
  $form.Activate()
  if([SsamProfileVault]::IsWindowVisible($form.Handle)){[IO.File]::WriteAllText($PendingFile,(@{state='visible';pid=$PID}|ConvertTo-Json -Compress))}
 })
 [void]$form.ShowDialog()
 $answer=@{contextKey=$ContextKey;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();cancelled=($null -eq $script:chosen)}
 if($script:chosen){$answer.target=$script:chosen.target;$answer.principal=$script:chosen.principal}
 $utf8=New-Object System.Text.UTF8Encoding($false)
 [IO.File]::WriteAllText($SelectionFile,($answer|ConvertTo-Json -Compress),$utf8)
 $password.Clear();$form.Dispose()
}catch{[Console]::Error.WriteLine('Private credential selection failed. No secret was logged.');exit 1}
finally{
 if($ownsDialog -and $PendingFile -and [IO.File]::Exists($PendingFile)){[IO.File]::Delete($PendingFile)}
 if($ownsDialog){$dialogMutex.ReleaseMutex()}
 if($dialogMutex){$dialogMutex.Dispose()}
}
