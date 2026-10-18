param(
 [ValidateSet('ensure','status','focus','dialog')][string]$Mode='status',
 [ValidateSet('portal','api-client','database','setting')][string]$Kind,
 [ValidatePattern('^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$')][string]$HostName,
 [ValidatePattern('^[a-f0-9]{64}$')][string]$ContextKey,
 [Parameter(Mandatory=$true)][string]$StateDirectory,
 [string]$EntryName='', [string]$Nonce=''
)
# Manages only this SSAM form. No keystrokes, other windows, or secret IPC.
$ErrorActionPreference='Stop'
$utf8=New-Object System.Text.UTF8Encoding($false)
$stateFile=Join-Path $StateDirectory 'window.json'
$focusFile=Join-Path $StateDirectory 'focus.json'
if(($Kind -in @('database','setting')) -and $EntryName -notmatch '^[A-Za-z0-9_.-]{1,64}$'){throw 'Invalid entry name'}
if(($Kind -in @('portal','api-client')) -and $EntryName){throw 'Unexpected entry name'}
[IO.Directory]::CreateDirectory($StateDirectory)|Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SsamCredentialWindow {
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int cmd);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Credential {
  public uint Flags,Type; public string TargetName,Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist,AttributeCount; public IntPtr Attributes; public string TargetAlias,UserName;
 }
 [DllImport("advapi32.dll",EntryPoint="CredWriteW",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool Write(ref Credential value,uint flags);
}
'@
function Write-WindowState($value){
 $temp=$stateFile+'.'+$PID+'.tmp'
 [IO.File]::WriteAllText($temp,($value|ConvertTo-Json -Compress),$utf8)
 Move-Item -LiteralPath $temp -Destination $stateFile -Force
}
function Read-WindowState {
 try {
  $s=Get-Content -LiteralPath $stateFile -Raw|ConvertFrom-Json
  if($s.contextKey -ne $ContextKey){return $null}
  return $s
 }catch{return $null}
}
function Observe-Window {
 $s=Read-WindowState
 if(!$s){return @{state='absent';visible=$false}}
 if($s.state -in @('cancelled','stored','failed')){return @{state=$s.state;visible=$false;code=$s.code}}
 try {$p=Get-Process -Id $s.pid -ErrorAction Stop;if($p.StartTime.ToUniversalTime().Ticks.ToString() -ne $s.startTicks){return @{state='absent';visible=$false}}}
 catch{return @{state='absent';visible=$false}}
 if($s.state -eq 'starting'){return @{state='starting';visible=$false;pid=$s.pid}}
 $h=[IntPtr]([long]$s.hwnd);$owner=[uint32]0
 [void][SsamCredentialWindow]::GetWindowThreadProcessId($h,[ref]$owner)
 if($owner -ne $s.pid -or ![SsamCredentialWindow]::IsWindow($h)){return @{state='absent';visible=$false}}
 return @{state='visible';visible=([SsamCredentialWindow]::IsWindowVisible($h) -and ![SsamCredentialWindow]::IsIconic($h));foreground=([SsamCredentialWindow]::GetForegroundWindow() -eq $h);pid=$s.pid;focusId=$s.focusId}
}
if($Mode -ne 'dialog'){
 $gate=New-Object Threading.Mutex($false,('Local\SSAMCredentialLaunch-'+$ContextKey));$owned=$false
 try {
  try{$owned=$gate.WaitOne(10000)}catch [Threading.AbandonedMutexException]{$owned=$true}
  if(!$owned){@{state='failed';visible=$false;code='CREDENTIAL_PROMPT_BUSY'}|ConvertTo-Json -Compress;exit 0}
  $current=Observe-Window
  if($Mode -eq 'status'){$current|ConvertTo-Json -Compress;exit 0}
  if($current.state -eq 'cancelled' -and $Mode -eq 'ensure'){$current|ConvertTo-Json -Compress;exit 0}
  $opened=$false;$recovered=($current.state -eq 'absent' -and (Test-Path -LiteralPath $stateFile))
  if($current.state -notin @('visible','starting')){
   $Nonce=[Guid]::NewGuid().ToString()
   $argsList=@('-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-Mode','dialog','-Kind',$Kind,'-HostName',$HostName,'-ContextKey',$ContextKey,'-StateDirectory',$StateDirectory,'-Nonce',$Nonce)
   if($EntryName){$argsList+=@('-EntryName',$EntryName)}
   $quoted=($argsList|ForEach-Object{'"'+($_ -replace '(\\*)"','$1$1\"' -replace '(\\+)$','$1$1')+'"'}) -join ' '
   # No DETACHED_PROCESS: it can exit PowerShell before its script runs.
   $child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $quoted -WindowStyle Hidden -PassThru
   $opened=$true
  }
  $deadline=[DateTime]::UtcNow.AddSeconds(7)
  do {
   $current=Observe-Window
   if($current.state -eq 'visible'){break}
   if($opened -and $child.HasExited){break}
   Start-Sleep -Milliseconds 100
  }while([DateTime]::UtcNow -lt $deadline)
  if($current.state -ne 'visible'){@{state='failed';visible=$false;code='CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE'}|ConvertTo-Json -Compress;exit 0}
  $s=Read-WindowState;$focusId=[Guid]::NewGuid().ToString()
  [IO.File]::WriteAllText($focusFile,(@{nonce=$s.nonce;id=$focusId}|ConvertTo-Json -Compress),$utf8)
  $deadline=[DateTime]::UtcNow.AddSeconds(2)
  do {$current=Observe-Window;if($current.focusId -eq $focusId){break};Start-Sleep -Milliseconds 75}while([DateTime]::UtcNow -lt $deadline)
  $current.opened=$opened;$current.recovered=$recovered
  if(!$current.visible){$current.code='CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE'}
  elseif($Mode -eq 'focus' -and !$current.foreground){$current.code='CREDENTIAL_FOCUS_DENIED'}
  $current|ConvertTo-Json -Compress
 }catch{@{state='failed';visible=$false;code='CREDENTIAL_PROMPT_UNAVAILABLE'}|ConvertTo-Json -Compress}
 finally{if($owned){$gate.ReleaseMutex()};$gate.Dispose()}
 exit 0
}
$windowGate=New-Object Threading.Mutex($false,('Local\SSAMCredentialWindow-'+$ContextKey));$ownsWindow=$false;$form=$null;$timer=$null
try {
 try{$ownsWindow=$windowGate.WaitOne(0)}catch [Threading.AbandonedMutexException]{$ownsWindow=$true}
 if(!$ownsWindow){exit 0}
 $script:metadata=@{contextKey=$ContextKey;nonce=$Nonce;pid=$PID;startTicks=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString();state='starting';hwnd='0';focusId=''}
 Write-WindowState $script:metadata
 Add-Type -AssemblyName System.Windows.Forms
 Add-Type -AssemblyName System.Drawing
 $form=New-Object Windows.Forms.Form;$form.Text="SSAM - $HostName - $Kind";$form.ClientSize=New-Object Drawing.Size(580,235)
 $form.StartPosition='CenterScreen';$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false;$form.MinimizeBox=$true;$form.TopMost=$true
 $label=New-Object Windows.Forms.Label;$label.Location=New-Object Drawing.Point(16,14);$label.Size=New-Object Drawing.Size(548,48)
 $label.Text="ODC: $HostName`r`n$Kind $EntryName - values stored only in the Windows Vault; never in the chat.";$form.Controls.Add($label)
 $userLabel=New-Object Windows.Forms.Label;$userLabel.Location=New-Object Drawing.Point(16,78);$userLabel.Text=$(if($Kind -eq 'api-client'){'Client ID'}else{'User'});$form.Controls.Add($userLabel)
 $user=New-Object Windows.Forms.TextBox;$user.Location=New-Object Drawing.Point(140,74);$user.Size=New-Object Drawing.Size(422,24);$form.Controls.Add($user)
 $secretLabel=New-Object Windows.Forms.Label;$secretLabel.Location=New-Object Drawing.Point(16,119);$secretLabel.Text=$(if($Kind -eq 'api-client'){'Client secret'}elseif($Kind -eq 'setting'){'Secret value'}else{'Password'});$form.Controls.Add($secretLabel)
 $secret=New-Object Windows.Forms.TextBox;$secret.Location=New-Object Drawing.Point(140,115);$secret.Size=New-Object Drawing.Size(422,24);$secret.UseSystemPasswordChar=$true;$form.Controls.Add($secret)
 if($Kind -eq 'setting'){$user.Text='setting';$user.ReadOnly=$true}
 $save=New-Object Windows.Forms.Button;$save.Text='Save';$save.Location=New-Object Drawing.Point(360,177);$save.Size=New-Object Drawing.Size(96,32);$form.Controls.Add($save);$form.AcceptButton=$save
 $cancel=New-Object Windows.Forms.Button;$cancel.Text='Cancel';$cancel.DialogResult='Cancel';$cancel.Location=New-Object Drawing.Point(466,177);$cancel.Size=New-Object Drawing.Size(96,32);$form.Controls.Add($cancel);$form.CancelButton=$cancel
 $script:stored=$false
 $save.Add_Click({
  $pointer=[IntPtr]::Zero
  try {
   if([string]::IsNullOrWhiteSpace($user.Text) -or !$secret.Text){throw 'Incomplete'}
   $target=switch($Kind){'portal'{"SSAM/ODC3/$HostName/Portal"}'api-client'{"SSAM/ODC3/$HostName/APIClient"}'database'{"SSAM/ODC3/$HostName/DB/$EntryName"}'setting'{"SSAM/ODC3/$HostName/Setting/$EntryName"}}
   $pointer=[Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($secret.Text)
   $record=New-Object SsamCredentialWindow+Credential;$record.Type=1;$record.TargetName=$target;$record.UserName=$user.Text.Trim();$record.Persist=2
   $record.CredentialBlob=$pointer;$record.CredentialBlobSize=[Text.Encoding]::Unicode.GetByteCount($secret.Text)
   if($record.CredentialBlobSize -gt 2560 -or ![SsamCredentialWindow]::Write([ref]$record,0)){throw 'Storage failed'}
   $script:stored=$true;$secret.Clear();$form.DialogResult='OK';$form.Close()
  }catch{[void][Windows.Forms.MessageBox]::Show($form,'Check the fields. The credential could not be saved.','SSAM')}
  finally{if($pointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($pointer)}}
 })
 function Focus-OwnForm {
  $form.WindowState='Normal';[void][SsamCredentialWindow]::ShowWindow($form.Handle,5)
  $form.TopMost=$true;$form.BringToFront();$form.Activate();[void][SsamCredentialWindow]::SetForegroundWindow($form.Handle)
 }
 $form.Add_Shown({Focus-OwnForm;$user.Focus();$script:metadata.state='visible';$script:metadata.hwnd=$form.Handle.ToInt64().ToString();Write-WindowState $script:metadata})
 $timer=New-Object Windows.Forms.Timer;$timer.Interval=100
 $timer.Add_Tick({
  try {$request=Get-Content -LiteralPath $focusFile -Raw|ConvertFrom-Json
   if($request.nonce -eq $Nonce -and $request.id -ne $script:metadata.focusId){Focus-OwnForm;$script:metadata.focusId=$request.id;Write-WindowState $script:metadata}
  }catch{}
 });$timer.Start()
 [void]$form.ShowDialog()
 $script:metadata.state=$(if($script:stored){'stored'}else{'cancelled'});$script:metadata.hwnd='0';Write-WindowState $script:metadata
}catch{if($ownsWindow){Write-WindowState @{contextKey=$ContextKey;state='failed';code='CREDENTIAL_PROMPT_UNAVAILABLE'}}}
finally{if($timer){$timer.Stop();$timer.Dispose()};if($form){$secret.Clear();$user.Clear();$form.Dispose()};if($ownsWindow){$windowGate.ReleaseMutex()};$windowGate.Dispose()}
