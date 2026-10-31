param(
 [ValidateSet('status','prompt','request','forget')][string]$Mode='status',
 [ValidatePattern('^[a-z0-9][a-z0-9.-]*$')][string]$HostName,
 [ValidateSet('login','password')][string]$Kind='login',
 [ValidatePattern('^[a-f0-9]{64}$')][string]$Entry,
 [string]$Subject='',
 [string]$PromptStatusPath='',
 [ValidatePattern('^[a-f0-9]{16}$')][string]$Scope
)
# Secrets live only in this short-lived process and Windows Credential Manager.
# Neither CLI arguments nor returned JSON contain a password.
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UsersVault {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Credential { public uint Flags,Type; public string TargetName,Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist,AttributeCount; public IntPtr Attributes; public string TargetAlias,UserName; }
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target,uint type,uint flags,out IntPtr value);
 [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Write(ref Credential value,uint flags);
 [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Delete(string target,uint type,uint flags);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr value);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle,int command);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
}
'@
function Target([string]$kind,[string]$entry) {
 if (-not $HostName -or $HostName.Contains('..')) { throw 'Invalid host' }
 # -Scope: the SSAM agent's own entries, one set per agent installation, apart from an SSAM installed on the same account.
 $prefix=if($Scope){"SSAM/Agent/$Scope/O11/$HostName"}else{"SSAM/O11/$HostName"}
 if ($kind -eq 'login') { return "$prefix/Users" }
 if ($entry -notmatch '^[a-f0-9]{64}$') { throw 'Invalid password reference' }
 return "$prefix/UsersPassword/$entry"
}
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
function B64([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }
function Form([string]$s) { [Uri]::EscapeDataString($s).Replace('%20','+') }
try {
 if ($Mode -eq 'status') {
  $found=ReadVault (Target $Kind $Entry) $false
  @{ok=$true;available=($null -ne $found);principal=if($Kind -eq 'login' -and $found){$found.UserName}else{$null}}|ConvertTo-Json -Compress
  exit 0
 }
 if ($Mode -eq 'forget') {
  if ($Kind -ne 'password') { throw 'Only a new password is forgotten' }
  [void][UsersVault]::Delete((Target $Kind $Entry),1,0)
  @{ok=$true}|ConvertTo-Json -Compress
  exit 0
 }
 if ($Mode -eq 'prompt') {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $f=New-Object Windows.Forms.Form
  $f.Add_Shown({
   [void][UsersVault]::ShowWindow($f.Handle,5)
   [void][UsersVault]::SetForegroundWindow($f.Handle)
   $f.Activate()
   if($PromptStatusPath -and [UsersVault]::IsWindowVisible($f.Handle)){[IO.File]::WriteAllText($PromptStatusPath,'visible')}
  })
  $f.Text=if($Kind -eq 'login'){'SSAM - Users administrator'}else{'SSAM - User password'}
  $f.ClientSize=New-Object Drawing.Size(490,300);$f.StartPosition='CenterScreen';$f.FormBorderStyle='FixedDialog';$f.MaximizeBox=$false;$f.MinimizeBox=$false;$f.TopMost=$true
  $intro=New-Object Windows.Forms.Label;$intro.SetBounds(18,15,452,60);$intro.Text=if($Kind -eq 'login'){"Users administrator for $HostName. Stored only in Windows Credential Manager."}else{"New password for $Subject on $HostName. Enter and confirm here; never in chat."};$f.Controls.Add($intro)
  $label=New-Object Windows.Forms.Label;$label.SetBounds(18,80,145,25);$label.Text=if($Kind -eq 'login'){'Username'}else{'New password'};$f.Controls.Add($label)
  $first=New-Object Windows.Forms.TextBox;$first.SetBounds(165,80,300,25);$first.UseSystemPasswordChar=($Kind -eq 'password');$f.Controls.Add($first)
  $label2=New-Object Windows.Forms.Label;$label2.SetBounds(18,120,145,25);$label2.Text=if($Kind -eq 'login'){'Password'}else{'Confirm password'};$f.Controls.Add($label2)
  $second=New-Object Windows.Forms.TextBox;$second.SetBounds(165,120,300,25);$second.UseSystemPasswordChar=$true;$f.Controls.Add($second)
  $errorLabel=New-Object Windows.Forms.Label;$errorLabel.SetBounds(18,165,450,45);$errorLabel.ForeColor=[Drawing.Color]::DarkRed;$f.Controls.Add($errorLabel)
  $save=New-Object Windows.Forms.Button;$save.Text='Save securely';$save.SetBounds(210,240,130,35);$f.Controls.Add($save)
  $cancel=New-Object Windows.Forms.Button;$cancel.Text='Cancel';$cancel.SetBounds(350,240,110,35);$cancel.DialogResult='Cancel';$f.Controls.Add($cancel);$f.CancelButton=$cancel;$f.AcceptButton=$save
  $save.Add_Click({
   $secret=if($Kind -eq 'login'){$second.Text}else{$first.Text}
   if(-not $first.Text -or -not $second.Text){$errorLabel.Text='Complete both fields.';return}
   if($Kind -eq 'password' -and $first.Text -cne $second.Text){$errorLabel.Text='The passwords do not match.';return}
   $p=[Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($secret)
   try {
    $c=New-Object UsersVault+Credential;$c.Type=1;$c.TargetName=Target $Kind $Entry;$c.UserName=if($Kind -eq 'login'){$first.Text}else{$Subject};$c.CredentialBlob=$p;$c.CredentialBlobSize=[Text.Encoding]::Unicode.GetByteCount($secret);$c.Persist=2
    if($c.CredentialBlobSize -gt 5120){$errorLabel.Text='Password exceeds the secure storage limit.';return}
    if(-not [UsersVault]::Write([ref]$c,0)){$errorLabel.Text='Could not store the credential.';return}
    if($PromptStatusPath){[IO.File]::WriteAllText($PromptStatusPath,'saved')}
    $first.Clear();$second.Clear();$f.DialogResult='OK';$f.Close()
   } finally {[Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($p);$secret=$null}
  })
  $null=$f.ShowDialog();$f.Dispose();exit 0
 }
 $r=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))|ConvertFrom-Json
 $uri=[Uri]$r.url
 if($uri.Scheme -ne 'https' -or $uri.Host -ne $HostName -or $uri.Port -ne 443 -or $uri.UserInfo -or $uri.Fragment -or $uri.AbsolutePath -notmatch '^/Users/(?:(?:Login|User_List|Inactive_Users|User_Show|User_Edit|Group_List|Group_Show|Group_Edit|Application_List|Application_Show|Role_Show|MyInfo)\.aspx)?$'){throw 'Invalid Users route'}
 if($r.method -notin @('GET','POST')){throw 'Invalid method'}
 # HTTP goes only to the environment the person signed in to in this vault.
 if(-not (ReadVault (Target 'login' '') $false)){@{ok=$false;code='USERS_HOST_NOT_AUTHENTICATED'}|ConvertTo-Json -Compress;exit 1}
 $pairs=New-Object Collections.Generic.List[string]
 foreach($pair in $r.fields){$pairs.Add((Form ([string]$pair[0]))+'='+(Form ([string]$pair[1])))}
 $secrets=New-Object Collections.Generic.List[string]
 foreach($ref in $r.secretRefs){
  $expected=Target ([string]$ref.kind) ([string]$ref.entry)
  if($ref.field -notmatch '^[A-Za-z0-9_$]+$' -or $ref.part -notin @('username','password')){throw 'Invalid secret field'}
  if($ref.kind -ne 'login' -and $ref.part -ne 'password'){throw 'Invalid secret part'}
  if($ref.kind -eq 'login' -and $uri.AbsolutePath -ne '/Users/Login.aspx'){throw 'Login credential outside login route'}
  $v=ReadVault $expected $true;if(-not $v){throw 'Credential missing'}
  $s=if($ref.part -eq 'username'){$v.UserName}else{$v.Secret};$secrets.Add($s)
  $pairs.Add((Form ([string]$ref.field))+'='+(Form $s));$v=$null;$s=$null
 }
 [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
 $web=[Net.HttpWebRequest]::Create($uri);$web.Method=$r.method;$web.AllowAutoRedirect=$false;$web.KeepAlive=$false;$web.Timeout=30000;$web.ReadWriteTimeout=30000;$web.UserAgent='SSAM-Users/1';$web.Accept='text/html,application/json,text/javascript'
 $jar=New-Object Net.CookieContainer
 if($r.cookie){$jar.SetCookies($uri,([string]$r.cookie).Replace('; ', ', '))};$web.CookieContainer=$jar
 if($r.method -eq 'POST'){
  $bytes=[Text.Encoding]::UTF8.GetBytes(($pairs -join '&'));$web.ContentType='application/x-www-form-urlencoded';$web.ContentLength=$bytes.Length
  $stream=$web.GetRequestStream();$stream.Write($bytes,0,$bytes.Length);$stream.Close();[Array]::Clear($bytes,0,$bytes.Length)
 }
 try{$response=$web.GetResponse()}catch [Net.WebException] {$response=$_.Exception.Response;if(-not $response){throw}}
 $inputStream=$response.GetResponseStream();$buffer=New-Object byte[] 65536;$memory=New-Object IO.MemoryStream
 while($memory.Length -lt 8388609){$n=$inputStream.Read($buffer,0,$buffer.Length);if($n -le 0){break};$memory.Write($buffer,0,$n)};$inputStream.Close()
 if($memory.Length -gt 8388608){throw 'Response too large'}
 $body=[Text.Encoding]::UTF8.GetString($memory.ToArray())
 foreach($s in $secrets){if($s){foreach($echo in @($s,[Net.WebUtility]::HtmlEncode($s),(Form $s))){$body=$body.Replace($echo,'[redacted]')}}};$secrets.Clear();$pairs.Clear()
 $cookies=@($response.Cookies|ForEach-Object{B64 ('{0}={1}; path={2}' -f $_.Name,$_.Value,$_.Path)})
 @{ok=$true;status=[int]$response.StatusCode;location=(B64 $response.Headers['Location']);contentType=(B64 $response.ContentType);setCookie=$cookies;body=(B64 $body)}|ConvertTo-Json -Compress
 $response.Close()
}catch{
 @{ok=$false;code='USERS_PRIVATE_REQUEST_FAILED'}|ConvertTo-Json -Compress
 exit 1
}
