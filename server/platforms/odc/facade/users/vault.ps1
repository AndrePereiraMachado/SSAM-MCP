param(
 [ValidateSet('status','prompt','request','forget','hosts','login','confirm','sign-out','sweep')][string]$Mode='status',
 [ValidatePattern('^[a-z0-9][a-z0-9.-]*$')][string]$HostName,
 [ValidateSet('login','password')][string]$Kind='login',
 [ValidatePattern('^[a-f0-9]{64}$')][string]$Entry,
 [string]$Subject='',
 [string]$PromptStatusPath='',
 [ValidatePattern('^[a-f0-9]{32}$')][string]$Scope,
 [ValidatePattern('^[A-Za-z0-9+/=]*$')][string]$Rows=''
)
# Secrets live only in this short-lived process and Windows Credential Manager.
# CLI arguments and public channel responses never contain a password. Private pipe completion may carry a temporary credential.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'private-vault.ps1')
function Target([string]$kind,[string]$entry) {
 if (-not $HostName -or $HostName.Contains('..')) { throw 'Invalid host' }
 # -Scope: the SSAM agent's own entries, per installation and per account of the server, apart from an SSAM installed on the same Windows account.
 $prefix="$(Prefix)/$HostName"
 if ($kind -eq 'login') { return "$prefix/Users" }
 if ($entry -notmatch '^[a-f0-9]{64}$') { throw 'Invalid password reference' }
 return "$prefix/UsersPassword/$entry"
}
function Prefix { if($Scope){"SSAM/Agent/$($Scope.Substring(0,16))/$($Scope.Substring(16))/O11"}else{'SSAM/O11'} }
# What no longer belongs: entries of another account of this installation (a token replaced or revoked). Never of another installation.
function Sweep {
 if(-not $Scope){return}
 $install="SSAM/Agent/$($Scope.Substring(0,16))"
 $mine="$install/$($Scope.Substring(16))/"
 foreach($item in (Names "$install/*")){ if(-not $item.Name.StartsWith($mine)){ [void][UsersVault]::Delete($item.Name,1,0) } }
}
# A new password nobody used in a quarter of an hour goes: it was typed for one operation.
function SweepPasswords {
 $limit=[DateTime]::UtcNow.AddMinutes(-15)
 foreach($item in (Names "$(Prefix)/*/UsersPassword/*")){ if($item.Written -lt $limit){ [void][UsersVault]::Delete($item.Name,1,0) } }
}
# An agent that starts holds no permit, so every new password of this account in the vault is left over.
function SweepAllPasswords {
 foreach($item in (Names "$(Prefix)/*/UsersPassword/*")){ [void][UsersVault]::Delete($item.Name,1,0) }
}
function Fail([string]$code) { @{ok=$false;code=$code}|ConvertTo-Json -Compress; exit 1 }
# One request, never redirected. A page larger than this is refused: a Users page never is, and it would stop a server that reads it.
$MaxPage=262144
function ReadCapped($stream,[int]$limit) {
 $buffer=New-Object byte[] 65536;$memory=New-Object IO.MemoryStream
 while($memory.Length -le $limit){$n=$stream.Read($buffer,0,$buffer.Length);if($n -le 0){break};$memory.Write($buffer,0,$n)};$stream.Close()
 if($memory.Length -gt $limit){return $null}
 return $memory
}
function Http([Uri]$uri,[string]$method,$jar,[byte[]]$bytes) {
 [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
 $web=[Net.HttpWebRequest]::Create($uri);$web.Method=$method;$web.AllowAutoRedirect=$false;$web.KeepAlive=$false;$web.Timeout=30000;$web.ReadWriteTimeout=30000;$web.UserAgent='SSAM-Users/1';$web.Accept='text/html,application/json,text/javascript';$web.CookieContainer=$jar
 if($method -eq 'POST'){
  $web.ContentType='application/x-www-form-urlencoded';$web.ContentLength=$bytes.Length
  $stream=$web.GetRequestStream();$stream.Write($bytes,0,$bytes.Length);$stream.Close();[Array]::Clear($bytes,0,$bytes.Length)
 }
 try{$response=$web.GetResponse()}catch [Net.WebException] {$response=$_.Exception.Response;if(-not $response){throw}}
 $memory=ReadCapped $response.GetResponseStream() $MaxPage
 if($null -eq $memory){$response.Close();Fail 'USERS_PAGE_TOO_LARGE'}
 $answer=[pscustomobject]@{Status=[int]$response.StatusCode;Location=[string]$response.Headers['Location'];ContentType=[string]$response.ContentType;Body=[Text.Encoding]::UTF8.GetString($memory.ToArray());Cookies=@($response.Cookies|ForEach-Object{B64 ('{0}={1}; path={2}' -f $_.Name,$_.Value,$_.Path)})}
 $response.Close()
 return $answer
}
function Attr([string]$tag,[string]$name) { $m=[regex]::Match($tag,"\b$name\s*=\s*(?:`"([^`"]*)`"|'([^']*)'|([^\s>]+))",'IgnoreCase'); if(-not $m.Success){return $null}; [Net.WebUtility]::HtmlDecode(($m.Groups[1].Value+$m.Groups[2].Value+$m.Groups[3].Value)) }
# The sign-in form of a page, or nothing: exactly one user box, one password box and one Log In, outside comments and scripts. The fields to send.
function LoginPlan([string]$html) {
 $clean=[regex]::Replace($html,'<!--[\s\S]*?-->|<script\b[\s\S]*?</script\s*>','','IgnoreCase')
 $tags=@([regex]::Matches($clean,'<input\b(?:"[^"]*"|''[^'']*''|[^''">])*>','IgnoreCase')|ForEach-Object{$_.Value})
 $typeOf={param($t) $x=Attr $t 'type'; if($x){$x.ToLowerInvariant()}else{'text'}}
 $users=@($tags|Where-Object{(& $typeOf $_) -eq 'text' -and (Attr $_ 'name')});$passwords=@($tags|Where-Object{(& $typeOf $_) -eq 'password'});$submits=@($tags|Where-Object{(& $typeOf $_) -eq 'submit' -and (Attr $_ 'value') -eq 'Log In'})
 if($users.Count -ne 1 -or $passwords.Count -ne 1 -or $submits.Count -ne 1 -or -not (Attr $passwords[0] 'name') -or -not (Attr $submits[0] 'name')){return $null}
 $hidden=New-Object Collections.Generic.List[object]
 foreach($t in ($tags|Where-Object{(& $typeOf $_) -eq 'hidden' -and (Attr $_ 'name')})){$hidden.Add(@((Attr $t 'name'),[string](Attr $t 'value')))}
 return [pscustomobject]@{User=(Attr $users[0] 'name');Password=(Attr $passwords[0] 'name');Submit=(Attr $submits[0] 'name');Hidden=$hidden}
}
# Signed in means a session cookie, and an answer that left the login page on this host. Anything else is a failed try.
function LoginResult([int]$status,[string]$location,[string]$body,[int]$cookies,[string]$hostName) {
 if($cookies -lt 1){return $false}
 if($status -ge 300 -and $status -lt 400){
  if(-not $location -or $location -match 'Login\.aspx'){return $false}
  if($location -match '^[a-zA-Z][a-zA-Z0-9+.-]*://'){ if(([Uri]$location).Host -ne $hostName){return $false} }
  return $true
 }
 return ($status -eq 200 -and $body -notmatch 'type\s*=\s*["'']?password')
}
function LoginAnswer($after,$cookies,[string]$hostName) {
 @{ok=$true;authenticated=[bool](LoginResult $after.Status $after.Location $after.Body @($cookies).Count $hostName);setCookie=@($cookies)}|ConvertTo-Json -Compress
}
# The window of a yes, not yet shown. Decline is the default, Enter included; Approve wakes up after a moment; no answer in two minutes closes it as no.
function ConfirmForm($spec) {
 $f=New-SsamDialog 'Confirm this change' 'An AI assistant asks to do this through the SSAM agent on this machine. Nothing happens unless you approve it.' 'Users' $HostName 540
 $y=$f.Tag.ContentY
 foreach($row in $spec.rows){
  $caption=[string]$row.label+$(if($row.data){' (from the page, not verified)'}else{''})
  $name=Add-SsamLabel $f $caption 28 $y 484 24 12 -bold
  if($row.data){$name.ForeColor=$script:SsamDialogColors.Error}
  $text=[string]$row.value
  $measured=[Windows.Forms.TextRenderer]::MeasureText($text,(New-SsamFont 14),(New-Object Drawing.Size(456,100000)),[Windows.Forms.TextFormatFlags]::WordBreak)
  # TextRenderer does not wrap a long unbroken value. Reserve enough rows for
  # that case as well; the whole confirmation remains scrollable on small screens.
  $rows=0;foreach($line in ($text -split "`r?`n")){$rows+=[Math]::Max(1,[Math]::Ceiling($line.Length/32))}
  $height=[Math]::Max(44,[Math]::Max($measured.Height+20,$rows*18+20))
  $value=New-Object Windows.Forms.TextBox;$value.Multiline=$true;$value.WordWrap=$true;$value.SetBounds(28,($y+26),484,$height)
  $value.ReadOnly=$true;$value.TabStop=$false;$value.Text=$text;$value.Font=New-SsamFont 14;$value.BackColor=[Drawing.Color]::White;$value.ScrollBars='Vertical';$f.Controls.Add($value)
  $y+=($height+44)
 }
 $no=Add-SsamButton $f 'Decline' 28 ($y+10) 237;$no.DialogResult='Cancel'
 $yes=Add-SsamButton $f 'Approve' 275 ($y+10) 237 -primary;$yes.Enabled=$false
 $f.CancelButton=$no;$f.AcceptButton=$no
 Complete-SsamDialog $f ($y+54) 'Only the change shown above will be sent.'
 $arm=New-Object Windows.Forms.Timer;$arm.Interval=1500
 $end=New-Object Windows.Forms.Timer;$end.Interval=120000
 return [pscustomobject]@{Form=$f;Yes=$yes;No=$no;Arm=$arm;End=$end}
}
# Every form a page can show a value in: as it is, HTML, URL, JavaScript, base64; in any case.
# What leaves this process about a page: with every value it put in the request taken out, in the body and in the address.
function PageAnswer($page,$secrets) {
 $body=$page.Body;$location=$page.Location
 foreach($s in $secrets){$body=Redact $body $s;$location=Redact $location $s}
 @{ok=$true;status=$page.Status;location=(B64 $location);contentType=(B64 $page.ContentType);setCookie=$page.Cookies;body=(B64 $body)}|ConvertTo-Json -Compress
}
try {
 if($Mode -eq 'prompt' -or $Mode -eq 'confirm'){
  $dialogHelper=Join-Path $PSScriptRoot 'private-dialog.ps1'
  if(-not (Test-Path -LiteralPath $dialogHelper -PathType Leaf)){Fail 'USERS_PRIVATE_REQUEST_FAILED'}
  . $dialogHelper
 }
 $r=$null
 if($Mode -in @('status','login','request','sign-out')){
  $inputText=[Console]::In.ReadToEnd().Trim()
  if($inputText){$r=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($inputText))|ConvertFrom-Json}
 }
 if ($Mode -ne 'prompt' -and $Mode -ne 'confirm') { Sweep; SweepPasswords }
 if ($Mode -eq 'sign-out') {
  if(-not $r.privateCredential){[void][UsersVault]::Delete((Target 'login' ''),1,0)}
  foreach($item in (Names "$(Prefix)/$HostName/UsersPassword/*")){ [void][UsersVault]::Delete($item.Name,1,0) }
  @{ok=$true}|ConvertTo-Json -Compress
  exit 0
 }
 if ($Mode -eq 'sweep') {
  SweepAllPasswords
  @{ok=$true}|ConvertTo-Json -Compress
  exit 0
 }
 if ($Mode -eq 'status') {
  $found=if($Kind -eq 'login' -and $r.privateCredential){[pscustomobject]@{UserName=[string]$r.privateCredential.username}}else{ReadVault (Target $Kind $Entry) $false}
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
  $w=ConfirmForm $spec;$f=$w.Form;$yes=$w.Yes;$no=$w.No;$arm=$w.Arm;$end=$w.End
  $approved=$false;$timedOut=$false
  $yes.Add_Click({$script:approved=$true;$f.Close()})
  $arm.Add_Tick({$yes.Enabled=$true;$arm.Stop()})
  $end.Add_Tick({$script:timedOut=$true;$f.Close()})
  $f.Add_Shown({[void][UsersVault]::ShowWindow($f.Handle,5);[void][UsersVault]::SetForegroundWindow($f.Handle);$no.Focus();$arm.Start();$end.Start()})
  $null=$f.ShowDialog();$arm.Dispose();$end.Dispose();$f.Dispose()
  @{ok=$true;approved=[bool]$approved;timedOut=[bool]$timedOut}|ConvertTo-Json -Compress
  exit 0
 }
 if ($Mode -eq 'login') {
  # The helper signs in by itself: the server chooses no field, sees no login page and gets no answer but yes or no.
  $v=if($r.privateCredential){[pscustomobject]@{UserName=[string]$r.privateCredential.username;Secret=[string]$r.privateCredential.password}}else{ReadVault (Target 'login' '') $true}
  if(-not $v){Fail 'USERS_HOST_NOT_AUTHENTICATED'}
  $uri=[Uri]"https://$HostName/Users/Login.aspx"
  $jar=New-Object Net.CookieContainer
  $page=Http $uri 'GET' $jar $null
  $plan=LoginPlan $page.Body
  if(-not $plan){Fail 'USERS_LOGIN_LAYOUT_CHANGED'}
  $pairs=New-Object Collections.Generic.List[string]
  foreach($pair in $plan.Hidden){$pairs.Add((Form $pair[0])+'='+(Form $pair[1]))}
  $pairs.Add((Form $plan.Submit)+'='+(Form 'Log In'))
  $pairs.Add((Form $plan.User)+'='+(Form $v.UserName));$pairs.Add((Form $plan.Password)+'='+(Form $v.Secret));$v=$null
  $bytes=[Text.Encoding]::UTF8.GetBytes(($pairs -join '&'));$pairs.Clear()
  $after=Http $uri 'POST' $jar $bytes
  $cookies=@($jar.GetCookies($uri)|ForEach-Object{B64 ('{0}={1}; path={2}' -f $_.Name,$_.Value,$_.Path)})
  LoginAnswer $after $cookies $HostName
  exit 0
 }
 if ($Mode -eq 'prompt') {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $title=if($Kind -eq 'login'){'Sign in to Users'}else{'Set a user password'}
  $description=if($Kind -eq 'login'){'Connect your account to continue the requested task.'}else{'Enter and confirm the new password here, never in chat.'}
  $f=New-SsamDialog $title $description 'Users' $HostName
  $f.Add_Shown({
   [void][UsersVault]::ShowWindow($f.Handle,5)
   [void][UsersVault]::SetForegroundWindow($f.Handle)
   $f.Activate()
   if($PromptStatusPath -and [UsersVault]::IsWindowVisible($f.Handle)){[IO.File]::WriteAllText($PromptStatusPath,'visible')}
  })
  $y=$f.Tag.ContentY
  $firstLabel=if($Kind -eq 'login'){'Username'}else{'New password'}
  $secondLabel=if($Kind -eq 'login'){'Password'}else{'Confirm password'}
  $first=Add-SsamField $f $firstLabel $y -secret:($Kind -eq 'password');$y+=84
  $second=Add-SsamField $f $secondLabel $y -secret;$y+=84
  # The same complete subject is kept in a scrollable, read-only control.
  if($Rows){
   $lines=@([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Rows))|ConvertFrom-Json|ForEach-Object{$_}|ForEach-Object{[string]$_.label+$(if($_.data){' (from the page, not verified)'}else{''})+': '+[string]$_.value})
   $box=New-Object Windows.Forms.TextBox;$box.Multiline=$true;$box.WordWrap=$true;$box.ReadOnly=$true;$box.TabStop=$false;$box.ScrollBars='Vertical';$box.SetBounds(28,$y,384,110);$box.Text=($lines -join [Environment]::NewLine);$f.Controls.Add($box);$y+=124
  }
  $remember=$null
  if($Kind -eq 'login'){$remember=Add-SsamRemember $f $y;$y+=36}
  $errorLabel=Add-SsamFeedback $f $y;$y+=8
  $completion=@{ok=$true;saved=$false;remembered=$false}
  $cancel=Add-SsamButton $f 'Cancel' 28 $y 187;$cancel.DialogResult='Cancel'
  $save=Add-SsamButton $f $(if($Kind -eq 'login'){'Sign in'}else{'Save securely'}) 225 $y 187 -primary
  $f.CancelButton=$cancel;$f.AcceptButton=$save
  Complete-SsamDialog $f ($y+44)
  $save.Add_Click({
   $secret=if($Kind -eq 'login'){$second.Text}else{$first.Text}
   if(-not $first.Text -or -not $second.Text){$errorLabel.Text='Complete both fields.';return}
   if($Kind -eq 'password' -and $first.Text -cne $second.Text){$errorLabel.Text='The passwords do not match.';return}
   if($Kind -eq 'login' -and -not $remember.Checked){
    $completion.saved=$true;$completion.remembered=$false;$completion.principal=$first.Text
    $completion.privateCredential=@{username=$first.Text;password=$second.Text}
    $first.Clear();$second.Clear();$f.Close();return
   }
   $p=[Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($secret)
   try {
    $c=New-Object UsersVault+Credential;$c.Type=1;$c.TargetName=Target $Kind $Entry;$c.UserName=if($Kind -eq 'login'){$first.Text}else{$Subject};$c.CredentialBlob=$p;$c.CredentialBlobSize=[Text.Encoding]::Unicode.GetByteCount($secret);$c.Persist=2
    if($c.CredentialBlobSize -gt 5120){$errorLabel.Text='Password exceeds the secure storage limit.';return}
    if(-not [UsersVault]::Write([ref]$c,0)){$errorLabel.Text='Could not store the credential.';return}
    if($Kind -eq 'login'){$completion.saved=$true;$completion.remembered=$true;$completion.principal=$first.Text}elseif($PromptStatusPath){[IO.File]::WriteAllText($PromptStatusPath,'saved')}
    $first.Clear();$second.Clear();$f.DialogResult='OK';$f.Close()
   } finally {[Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($p);$secret=$null}
  })
  $null=$f.ShowDialog();$f.Dispose();if($Kind -eq 'login'){$completion|ConvertTo-Json -Depth 5 -Compress};exit 0
 }
 $uri=[Uri]$r.url
 if($uri.Scheme -ne 'https' -or $uri.Host -ne $HostName -or $uri.Port -ne 443 -or $uri.UserInfo -or $uri.Fragment -or $uri.AbsolutePath -notmatch '^/Users/(?:(?:Login|User_List|Inactive_Users|User_Show|User_Edit|Group_List|Group_Show|Group_Edit|Application_List|Application_Show|Role_Show|MyInfo)\.aspx)?$'){throw 'Invalid Users route'}
 if($r.method -notin @('GET','POST')){throw 'Invalid method'}
 # HTTP goes only to the environment the person signed in to in this vault.
 if(-not $r.privateCredential -and -not (ReadVault (Target 'login' '') $false)){@{ok=$false;code='USERS_HOST_NOT_AUTHENTICATED'}|ConvertTo-Json -Compress;exit 1}
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
 PageAnswer $page $secrets
 $secrets.Clear()
}catch{
 @{ok=$false;code='USERS_PRIVATE_REQUEST_FAILED'}|ConvertTo-Json -Compress
 exit 1
}
