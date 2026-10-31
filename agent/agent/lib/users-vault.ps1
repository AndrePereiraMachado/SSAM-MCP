param(
 [ValidateSet('status','prompt','request','forget','hosts','login','confirm')][string]$Mode='status',
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
 [DllImport("advapi32.dll", EntryPoint="CredEnumerateW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Enumerate(string filter,uint flags,out int count,out IntPtr list);
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
# The names of this scope's entries, never their secrets.
function Names([string]$filter) {
 $count=0;$list=[IntPtr]::Zero;$names=@()
 if ([UsersVault]::Enumerate($filter,0,[ref]$count,[ref]$list)) {
  try { for($i=0;$i -lt $count;$i++){ $p=[Runtime.InteropServices.Marshal]::ReadIntPtr($list,$i*[IntPtr]::Size); $c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][UsersVault+Credential]); $names+=[pscustomobject]@{Name=$c.TargetName;Written=[DateTime]::FromFileTimeUtc(([int64][uint32]$c.LastWritten.dwHighDateTime -shl 32) -bor [int64][uint32]$c.LastWritten.dwLowDateTime)} } }
  finally { [UsersVault]::CredFree($list) }
 }
 return $names
}
function Prefix { if($Scope){"SSAM/Agent/$Scope/O11"}else{'SSAM/O11'} }
function B64([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }
# WebUtility: no limit on a long hidden field, which Uri.EscapeDataString has.
function Form([string]$s) { [Net.WebUtility]::UrlEncode($s) }
function Fail([string]$code) { @{ok=$false;code=$code}|ConvertTo-Json -Compress; exit 1 }
# One request, never redirected. A page larger than this is refused: a Users page never is, and it would stop a server that reads it.
$MaxPage=262144
function Http([Uri]$uri,[string]$method,$jar,[byte[]]$bytes) {
 [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
 $web=[Net.HttpWebRequest]::Create($uri);$web.Method=$method;$web.AllowAutoRedirect=$false;$web.KeepAlive=$false;$web.Timeout=30000;$web.ReadWriteTimeout=30000;$web.UserAgent='SSAM-Users/1';$web.Accept='text/html,application/json,text/javascript';$web.CookieContainer=$jar
 if($method -eq 'POST'){
  $web.ContentType='application/x-www-form-urlencoded';$web.ContentLength=$bytes.Length
  $stream=$web.GetRequestStream();$stream.Write($bytes,0,$bytes.Length);$stream.Close();[Array]::Clear($bytes,0,$bytes.Length)
 }
 try{$response=$web.GetResponse()}catch [Net.WebException] {$response=$_.Exception.Response;if(-not $response){throw}}
 $inputStream=$response.GetResponseStream();$buffer=New-Object byte[] 65536;$memory=New-Object IO.MemoryStream
 while($memory.Length -le $MaxPage){$n=$inputStream.Read($buffer,0,$buffer.Length);if($n -le 0){break};$memory.Write($buffer,0,$n)};$inputStream.Close()
 if($memory.Length -gt $MaxPage){$response.Close();Fail 'USERS_PAGE_TOO_LARGE'}
 $answer=[pscustomobject]@{Status=[int]$response.StatusCode;Location=[string]$response.Headers['Location'];ContentType=[string]$response.ContentType;Body=[Text.Encoding]::UTF8.GetString($memory.ToArray());Cookies=@($response.Cookies|ForEach-Object{B64 ('{0}={1}; path={2}' -f $_.Name,$_.Value,$_.Path)})}
 $response.Close()
 return $answer
}
function Attr([string]$tag,[string]$name) { $m=[regex]::Match($tag,"\b$name\s*=\s*(?:`"([^`"]*)`"|'([^']*)'|([^\s>]+))",'IgnoreCase'); if(-not $m.Success){return $null}; [Net.WebUtility]::HtmlDecode(($m.Groups[1].Value+$m.Groups[2].Value+$m.Groups[3].Value)) }
# Every form a page can show a value in: as it is, HTML, URL, JavaScript, base64; in any case.
function Redact([string]$text,[string]$secret) {
 if(-not $secret){return $text}
 $html=[Net.WebUtility]::HtmlEncode($secret)
 $forms=@($secret,$html,$html.Replace('&#39;','&apos;'),(Form $secret),[Uri]::EscapeDataString($secret),$secret.Replace('\','\\').Replace('"','\"').Replace("'","\'"),$secret.Replace('<','\u003c').Replace('>','\u003e').Replace('&','\u0026'),[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($secret)),[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($secret)))
 foreach($echo in ($forms|Select-Object -Unique)){ $text=[regex]::Replace($text,[regex]::Escape($echo),'[redacted]','IgnoreCase') }
 return $text
}
try {
 if ($Mode -eq 'status') {
  $found=ReadVault (Target $Kind $Entry) $false
  @{ok=$true;available=($null -ne $found);principal=if($Kind -eq 'login' -and $found){$found.UserName}else{$null}}|ConvertTo-Json -Compress
  exit 0
 }
 if ($Mode -eq 'hosts') {
  $prefix=Prefix
  $hosts=@(Names "$prefix/*" | ForEach-Object { $_.Name } | Where-Object { $_ -like '*/Users' } | ForEach-Object { $_.Substring($prefix.Length+1).Replace('/Users','') })
  @{ok=$true;hosts=$hosts}|ConvertTo-Json -Compress
  exit 0
 }
 if ($Mode -eq 'forget') {
  if ($Kind -ne 'password') { throw 'Only a new password is forgotten' }
  [void][UsersVault]::Delete((Target $Kind $Entry),1,0)
  @{ok=$true}|ConvertTo-Json -Compress
  exit 0
 }
 if ($Mode -eq 'confirm') {
  # The person's yes. Fixed words and the agent's checked rows; a row from a page says so. No answer in time is no. Decline is the default.
  $spec=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))|ConvertFrom-Json
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $f=New-Object Windows.Forms.Form
  $f.Text='SSAM - Confirm this change';$f.StartPosition='CenterScreen';$f.FormBorderStyle='FixedDialog';$f.MaximizeBox=$false;$f.MinimizeBox=$false;$f.TopMost=$true
  $y=15
  $intro=New-Object Windows.Forms.Label;$intro.SetBounds(18,$y,500,40);$intro.UseMnemonic=$false;$intro.Text='An AI assistant asks to do this through the SSAM agent on this machine. Nothing happens unless you approve it.';$f.Controls.Add($intro);$y+=48
  foreach($row in $spec.rows){
   $name=New-Object Windows.Forms.Label;$name.SetBounds(18,$y,170,38);$name.UseMnemonic=$false;$name.Text=[string]$row.label;$f.Controls.Add($name)
   $value=New-Object Windows.Forms.TextBox;$value.SetBounds(190,$y,330,24);$value.ReadOnly=$true;$value.TabStop=$false;$value.Text=[string]$row.value;$f.Controls.Add($value)
   if($row.data){$name.ForeColor=[Drawing.Color]::DarkRed;$name.Text=[string]$row.label+' (from the page, not verified)'}
   $y+=42
  }
  $approved=$false;$timedOut=$false
  $yes=New-Object Windows.Forms.Button;$yes.Text='Approve';$yes.SetBounds(290,$y+10,110,35);$yes.Enabled=$false;$yes.Add_Click({$script:approved=$true;$f.Close()});$f.Controls.Add($yes)
  $no=New-Object Windows.Forms.Button;$no.Text='Decline';$no.SetBounds(410,$y+10,110,35);$no.DialogResult='Cancel';$f.Controls.Add($no);$f.CancelButton=$no;$f.AcceptButton=$no
  $f.ClientSize=New-Object Drawing.Size(540,($y+60))
  $arm=New-Object Windows.Forms.Timer;$arm.Interval=1500;$arm.Add_Tick({$yes.Enabled=$true;$arm.Stop()})
  $end=New-Object Windows.Forms.Timer;$end.Interval=120000;$end.Add_Tick({$script:timedOut=$true;$f.Close()})
  $f.Add_Shown({[void][UsersVault]::ShowWindow($f.Handle,5);[void][UsersVault]::SetForegroundWindow($f.Handle);$no.Focus();$arm.Start();$end.Start()})
  $null=$f.ShowDialog();$arm.Dispose();$end.Dispose();$f.Dispose()
  @{ok=$true;approved=[bool]$approved;timedOut=[bool]$timedOut}|ConvertTo-Json -Compress
  exit 0
 }
 if ($Mode -eq 'login') {
  # The helper signs in by itself: the server chooses no field, sees no login page and gets no answer but yes or no.
  $v=ReadVault (Target 'login' '') $true
  if(-not $v){Fail 'USERS_HOST_NOT_AUTHENTICATED'}
  $uri=[Uri]"https://$HostName/Users/Login.aspx"
  $jar=New-Object Net.CookieContainer
  $page=Http $uri 'GET' $jar $null
  $tags=@([regex]::Matches($page.Body,'<input\b[^>]*>','IgnoreCase')|ForEach-Object{$_.Value})
  $typeOf={param($t) $x=Attr $t 'type'; if($x){$x.ToLowerInvariant()}else{'text'}}
  $users=@($tags|Where-Object{(& $typeOf $_) -eq 'text' -and (Attr $_ 'name')});$passwords=@($tags|Where-Object{(& $typeOf $_) -eq 'password'});$submits=@($tags|Where-Object{(& $typeOf $_) -eq 'submit' -and (Attr $_ 'value') -eq 'Log In'})
  if($users.Count -ne 1 -or $passwords.Count -ne 1 -or $submits.Count -ne 1){Fail 'USERS_LOGIN_LAYOUT_CHANGED'}
  $pairs=New-Object Collections.Generic.List[string]
  foreach($t in ($tags|Where-Object{(& $typeOf $_) -eq 'hidden' -and (Attr $_ 'name')})){$pairs.Add((Form (Attr $t 'name'))+'='+(Form ([string](Attr $t 'value'))))}
  $pairs.Add((Form (Attr $submits[0] 'name'))+'='+(Form 'Log In'))
  $pairs.Add((Form (Attr $users[0] 'name'))+'='+(Form $v.UserName));$pairs.Add((Form (Attr $passwords[0] 'name'))+'='+(Form $v.Secret));$v=$null
  $bytes=[Text.Encoding]::UTF8.GetBytes(($pairs -join '&'));$pairs.Clear()
  $after=Http $uri 'POST' $jar $bytes
  $redirected=$after.Status -ge 300 -and $after.Status -lt 400
  $away=$redirected -and $after.Location -and ($after.Location -notmatch 'Login\.aspx')
  $signed=$away -or ($after.Status -eq 200 -and $after.Body -notmatch 'type\s*=\s*["'']?password')
  $cookies=@($jar.GetCookies($uri)|ForEach-Object{B64 ('{0}={1}; path={2}' -f $_.Name,$_.Value,$_.Path)})
  @{ok=$true;authenticated=[bool]$signed;setCookie=$cookies}|ConvertTo-Json -Compress
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
  # The first time, the person sees this exact host and types it again: nothing else can add an environment to the vault.
  $approving=($Kind -eq 'login') -and ($null -eq (ReadVault (Target 'login' '') $false))
  $f.ClientSize=New-Object Drawing.Size(490,340);$f.StartPosition='CenterScreen';$f.FormBorderStyle='FixedDialog';$f.MaximizeBox=$false;$f.MinimizeBox=$false;$f.TopMost=$true
  $intro=New-Object Windows.Forms.Label;$intro.SetBounds(18,15,452,60);$intro.Text=if($Kind -eq 'login'){"Users administrator for this exact environment: $HostName. Stored only in Windows Credential Manager, and sent only to this host, over HTTPS."}else{"New password for $Subject on $HostName. Enter and confirm here; never in chat."};$f.Controls.Add($intro)
  $label=New-Object Windows.Forms.Label;$label.SetBounds(18,80,145,25);$label.Text=if($Kind -eq 'login'){'Username'}else{'New password'};$f.Controls.Add($label)
  $first=New-Object Windows.Forms.TextBox;$first.SetBounds(165,80,300,25);$first.UseSystemPasswordChar=($Kind -eq 'password');$f.Controls.Add($first)
  $label2=New-Object Windows.Forms.Label;$label2.SetBounds(18,120,145,25);$label2.Text=if($Kind -eq 'login'){'Password'}else{'Confirm password'};$f.Controls.Add($label2)
  $second=New-Object Windows.Forms.TextBox;$second.SetBounds(165,120,300,25);$second.UseSystemPasswordChar=$true;$f.Controls.Add($second)
  $again=New-Object Windows.Forms.TextBox
  if($approving){
   $label3=New-Object Windows.Forms.Label;$label3.SetBounds(18,160,145,40);$label3.Text='New environment: type its name again';$f.Controls.Add($label3)
   $again.SetBounds(165,160,300,25);$f.Controls.Add($again)
  }
  $errorLabel=New-Object Windows.Forms.Label;$errorLabel.SetBounds(18,205,450,30);$errorLabel.ForeColor=[Drawing.Color]::DarkRed;$f.Controls.Add($errorLabel)
  $save=New-Object Windows.Forms.Button;$save.Text='Save securely';$save.SetBounds(210,280,130,35);$f.Controls.Add($save)
  $cancel=New-Object Windows.Forms.Button;$cancel.Text='Cancel';$cancel.SetBounds(350,280,110,35);$cancel.DialogResult='Cancel';$f.Controls.Add($cancel);$f.CancelButton=$cancel;$f.AcceptButton=$save
  $save.Add_Click({
   $secret=if($Kind -eq 'login'){$second.Text}else{$first.Text}
   if(-not $first.Text -or -not $second.Text){$errorLabel.Text='Complete both fields.';return}
   if($approving -and $again.Text.Trim() -cne $HostName){$errorLabel.Text='The environment name does not match. Check it before going on.';return}
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
  # A new password, into the password fields of the two forms that have them. The administrator's goes only through -Mode login.
  $expected=Target ([string]$ref.kind) ([string]$ref.entry)
  if($ref.kind -ne 'password' -or $ref.part -ne 'password' -or $r.method -ne 'POST' -or $ref.field -notmatch '(?:^|[$_])wt(?:Password|ConfirmPassword|NewPassword)Input$' -or $uri.AbsolutePath -notmatch '^/Users/(?:User_Edit|User_Show)\.aspx$'){throw 'Invalid secret field'}
  $v=ReadVault $expected $true;if(-not $v){throw 'Credential missing'}
  $secrets.Add($v.Secret);$pairs.Add((Form ([string]$ref.field))+'='+(Form $v.Secret));$v=$null
 }
 $jar=New-Object Net.CookieContainer
 if($r.cookie){$jar.SetCookies($uri,([string]$r.cookie).Replace('; ', ', '))}
 $bytes=if($r.method -eq 'POST'){[Text.Encoding]::UTF8.GetBytes(($pairs -join '&'))}else{$null};$pairs.Clear()
 $page=Http $uri $r.method $jar $bytes
 $body=$page.Body;$location=$page.Location
 foreach($s in $secrets){$body=Redact $body $s;$location=Redact $location $s};$secrets.Clear()
 @{ok=$true;status=$page.Status;location=(B64 $location);contentType=(B64 $page.ContentType);setCookie=$page.Cookies;body=(B64 $body)}|ConvertTo-Json -Compress
}catch{
 @{ok=$false;code='USERS_PRIVATE_REQUEST_FAILED'}|ConvertTo-Json -Compress
 exit 1
}
