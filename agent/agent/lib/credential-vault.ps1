param(
 [ValidateSet('status','prompt','login','request','forget','sign-out')][string]$Mode,
 [ValidatePattern('^[a-f0-9]{32}$')][string]$Scope,
 [ValidatePattern('^[a-z0-9][a-z0-9.-]*$')][string]$HostName,
 [string]$PromptStatusPath=''
)
# Only the local Agent starts this helper. Its stdin/stdout are private pipes;
# privateSession and secretValues must never cross the Agent channel.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'private-vault.ps1')
function Stop-Credential([string]$code) { @{ok=$false;code=$code}|ConvertTo-Json -Compress; exit 0 }
function Save-Credential([string]$target,[string]$user,[string]$secret) {
 $p=[Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($secret)
 try {
  $c=New-Object UsersVault+Credential
  $c.Type=1;$c.TargetName=$target;$c.UserName=$user;$c.CredentialBlob=$p
  $c.CredentialBlobSize=[Text.Encoding]::Unicode.GetByteCount($secret);$c.Persist=2
  if($c.CredentialBlobSize -eq 0 -or $c.CredentialBlobSize -gt 5120){return $false}
  return [UsersVault]::Write([ref]$c,0)
 } finally {[Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($p)}
}
function Invoke-PrivateHttp([Uri]$uri,[string]$method,$jar,[byte[]]$bytes,[string]$contentType='', [string]$token='', [string]$authorizationScheme='Bearer') {
 if($uri.Scheme -ne 'https' -or $uri.Host -ne $HostName -or $uri.Port -ne 443 -or $uri.UserInfo -or $uri.Fragment){throw 'origin'}
 [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
 $web=[Net.HttpWebRequest]::Create($uri);$web.Method=$method;$web.AllowAutoRedirect=$false
 $web.Timeout=30000;$web.ReadWriteTimeout=30000;$web.KeepAlive=$false;$web.CookieContainer=$jar
 $web.UserAgent='SSAM-Agent/1';$web.Accept='application/json,text/html'
 if($authorizationScheme -notin @('Bearer','Basic')){throw 'authorization scheme'}
 if($token){$web.Headers['Authorization']=$authorizationScheme+' '+$token}
 if($r.service -eq 'odc-portal' -and -not $token){
  . (Join-Path $PSScriptRoot 'credential-auth.ps1')
  $csrf=Get-SsamPortalCsrf $jar $uri
  if($csrf){$web.Headers['x-csrftoken']=$csrf}
  $web.Headers['Origin']="https://$HostName";$web.Headers['outsystems-client-env']='browser'
  $module=$uri.AbsolutePath.Split('/')[1];$web.Referer="https://$HostName/$module/"
 }
 if($null -ne $bytes){
  $web.ContentType=$contentType;$web.ContentLength=$bytes.Length
  $stream=$web.GetRequestStream();try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Close();[Array]::Clear($bytes,0,$bytes.Length)}
 }
 try{$response=$web.GetResponse()}catch [Net.WebException]{$response=$_.Exception.Response;if(-not $response){throw}}
 try {
  $stream=$response.GetResponseStream();$buffer=New-Object byte[] 65536;$memory=New-Object IO.MemoryStream
  try{while(($n=$stream.Read($buffer,0,$buffer.Length)) -gt 0){if($memory.Length+$n -gt 4194304){throw 'limit'};$memory.Write($buffer,0,$n)}
   $raw=$memory.ToArray();$encoding=[Text.Encoding]::UTF8
   if($response.ContentType -match 'json|text|xml|javascript|x-www-form-urlencoded'){
    $charset=[regex]::Match([string]$response.ContentType,'charset\s*=\s*["'']?([^;"''\s]+)','IgnoreCase')
    $name=if($charset.Success){$charset.Groups[1].Value}elseif($raw.Length -ge 2 -and $raw[0] -eq 255 -and $raw[1] -eq 254){'utf-16'}elseif($raw.Length -ge 2 -and $raw[0] -eq 254 -and $raw[1] -eq 255){'utf-16BE'}else{'utf-8'}
    $encoding=[Text.Encoding]::GetEncoding($name,[Text.EncoderFallback]::ExceptionFallback,[Text.DecoderFallback]::ExceptionFallback)
   }
   return @{status=[int]$response.StatusCode;bytes=$raw;body=$encoding.GetString($raw);encoding=$encoding.WebName;contentType=[string]$response.ContentType;location=[string]$response.Headers['Location']}
  }finally{$stream.Close();$memory.Dispose()}
 }finally{$response.Close()}
}
function Cookie-State($jar) {
 $found=@{}
 $paths=@('/','/ServiceCenter/')+@($r.privateSession.cookies|ForEach-Object{$_.path})
 if($r.url){$paths+=([Uri]$r.url).AbsolutePath}
 foreach($path in $paths){foreach($cookie in $jar.GetCookies([Uri]("https://$HostName"+$path))){if(-not $cookie.Expired){$found[$cookie.Name+'|'+$cookie.Path]=@{name=$cookie.Name;value=$cookie.Value;path=$cookie.Path;secure=$cookie.Secure;httpOnly=$cookie.HttpOnly;expiresAt=$(if($cookie.Expires -ne [DateTime]::MinValue){([DateTimeOffset]$cookie.Expires.ToUniversalTime()).ToUnixTimeMilliseconds()}else{$null})}}}}
 return @($found.Values)
}
function Test-CredentialSession($session,[string]$profile,[string]$principal) {
 $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 if(-not $session -or $session.profile -cne $profile -or $session.principal -cne $principal -or $session.expiresAt -le $now){return $false}
 return [bool]($session.token -or @($session.cookies|Where-Object{-not $_.expiresAt -or $_.expiresAt -gt $now}).Count)
}
try {
 $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
 if($r.service -notin @('service-center','odc-portal') -or $r.auth -notin @('credential','api-client','basic','service-token') -or ($r.service -eq 'odc-portal' -and $r.auth -notin @('credential','api-client')) -or ($r.service -eq 'service-center' -and $r.auth -eq 'api-client')){Stop-Credential 'CREDENTIAL_AUTH_UNSUPPORTED'}
 $staticAuthorization=$r.auth -in @('basic','service-token')
 $profile=if($r.profile){[string]$r.profile}else{('0'*64)}
 if($profile -cnotmatch '^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$'){throw 'profile'}
 $vaultAuth=if($r.auth -eq 'basic'){'credential'}else{[string]$r.auth}
 $prefix="SSAM/Agent/$($Scope.Substring(0,16))/$($Scope.Substring(16))/Credential/$HostName/$($r.service)/$vaultAuth/"
 if(-not $r.profile){
  $selected=ReadVault ($prefix+'selected') $true
  if($selected -and $selected.Secret -cmatch '^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$'){$profile=$selected.Secret}
 }
 $target=$prefix+$profile
 $service=if($staticAuthorization){'Service Center timer events'}elseif($r.service -eq 'service-center'){'Service Center'}elseif($r.auth -eq 'api-client'){'ODC Portal API client'}else{'ODC Portal'}
 if($Mode -eq 'status'){
  $v=if($r.privateCredential){[pscustomobject]@{UserName=[string]$r.privateCredential.username}}else{ReadVault $target $false}
  $profiles=@(Names ($prefix+'*')|ForEach-Object{$id=$_.Name.Substring($prefix.Length);$entry=ReadVault $_.Name $false;if($entry -and $id -ne 'selected'){@{profile=$id;principal=$entry.UserName}}})
  $authenticated=(-not $staticAuthorization -and $null -ne $v -and (Test-CredentialSession $r.privateSession $profile $v.UserName))
  @{ok=$true;available=($null -ne $v);authenticated=[bool]$authenticated;profile=$profile;principal=$(if($v){$v.UserName}else{$null});profiles=$profiles}|ConvertTo-Json -Compress -Depth 5;exit 0
 }
 if($Mode -eq 'sign-out'){@{ok=$true;signedOut=$true;privateSession=$null}|ConvertTo-Json -Compress;exit 0}
 if($Mode -eq 'prompt' -or $Mode -eq 'forget'){
  . (Join-Path $PSScriptRoot 'private-dialog.ps1')
  if($Mode -eq 'forget'){
   $f=New-SsamDialog 'Remove saved credential?' 'Remove the saved credential for this service from this device.' $service $HostName
   $y=$f.Tag.ContentY
   $errorLabel=Add-SsamFeedback $f $y
   $no=Add-SsamButton $f 'Cancel' 28 ($y+8) 180
   $yes=Add-SsamButton $f 'Remove credential' 220 ($y+8) 192 -primary
   $no.DialogResult='Cancel';$f.CancelButton=$no;$f.AcceptButton=$no
   $script:forgot=$false;$yes.Add_Click({
    try{if(-not $r.privateCredential -and -not [UsersVault]::Delete($target,1,0)){$errorLabel.Text='Could not remove the saved credential.';return}}
    catch{$errorLabel.Text='Could not remove the saved credential.';return}
    $script:forgot=$true;$f.Close()
   })
   $limit=New-Object Windows.Forms.Timer;$limit.Interval=120000;$limit.Add_Tick({$f.Close()});$f.Add_Shown({$limit.Start()})
   Complete-SsamDialog $f ($y+52)
   $null=$f.ShowDialog();$limit.Dispose();$f.Dispose()
   if(-not $script:forgot){Stop-Credential 'CREDENTIAL_CONFIRMATION_DECLINED'}
   @{ok=$true;forgotten=$true;privateSession=$null}|ConvertTo-Json -Compress;exit 0
  }
  if($r.mode -eq 'select-profile'){
   $profiles=@(Names ($prefix+'*')|Where-Object{$_.Name -ne ($prefix+'selected')}|ForEach-Object{$entry=ReadVault $_.Name $false;if($entry){[pscustomobject]@{Id=$_.Name.Substring($prefix.Length);Label=$entry.UserName}}})
   if(-not $profiles.Count){Stop-Credential 'CREDENTIAL_NOT_FOUND'}
   $f=New-SsamDialog 'Choose a saved profile' 'Choose the account for this request.' $service $HostName
   $y=$f.Tag.ContentY
   $selection=@{Item=$null}
   $cards=@()
   foreach($item in $profiles){
    $card=New-Object SsamRoundedPanel;$card.SetBounds(28,$y,384,54);$card.HighlightFocus=$false;$f.Controls.Add($card)
    $radio=New-Object Windows.Forms.RadioButton;$radio.Text=$item.Label;$radio.Font=New-SsamFont 13;$radio.SetBounds(13,8,358,38);$radio.Tag=$item;$card.Controls.Add($radio);$cards+=,$radio;$y+=64
    $radio.Add_CheckedChanged({if($this.Checked){$selection.Item=$this.Tag;foreach($otherRadio in $cards){if($otherRadio -ne $this){$otherRadio.Checked=$false}};$choose.Enabled=$true}})
   }
   $errorLabel=Add-SsamFeedback $f $y
   $cancel=Add-SsamButton $f 'Cancel' 28 ($y+8) 187;$cancel.DialogResult='Cancel';$f.CancelButton=$cancel
   $choose=Add-SsamButton $f 'Use profile' 225 ($y+8) 187 -primary;$choose.Enabled=$false;$f.AcceptButton=$choose
   $completion=@{ok=$true;saved=$false;remembered=$false}
   $choose.Add_Click({if($selection.Item){if(Save-Credential ($prefix+'selected') 'Selected profile' $selection.Item.Id){$completion.saved=$true;$completion.remembered=$true;$completion.profile=$selection.Item.Id;$completion.principal=$selection.Item.Label;$f.Close()}else{$errorLabel.Text='Could not select the saved account.'}}})
   $f.Add_Shown({if($PromptStatusPath -and [UsersVault]::IsWindowVisible($f.Handle)){[IO.File]::WriteAllText($PromptStatusPath,'visible')}})
   Complete-SsamDialog $f ($y+52)
   $null=$f.ShowDialog();$f.Dispose();$completion|ConvertTo-Json -Depth 5 -Compress;exit 0
  }
  $title=if($r.auth -eq 'api-client'){'Connect an API client'}elseif($r.service -eq 'odc-portal'){'Sign in to ODC Portal'}else{'Sign in to Service Center'}
  $description=if($r.auth -eq 'api-client'){'Use an API client for this ODC environment.'}else{'Connect your account to continue the requested task.'}
  $f=New-SsamDialog $title $description $service $HostName
  $y=$f.Tag.ContentY
  $first=Add-SsamField $f $(if($r.auth -eq 'api-client'){'Client ID'}elseif($r.auth -eq 'service-token'){'Account label'}else{'Email or username'}) $y
  $second=Add-SsamField $f $(if($r.auth -eq 'api-client'){'Client secret'}elseif($r.auth -eq 'service-token'){'Service token'}else{'Password'}) ($y+83) -secret
  $remember=Add-SsamRemember $f ($y+166)
  $errorLabel=Add-SsamFeedback $f ($y+202)
  $cancel=Add-SsamButton $f 'Cancel' 28 ($y+210) 187
  $save=Add-SsamButton $f $(if($r.auth -eq 'api-client'){'Connect'}else{'Sign in'}) 225 ($y+210) 187 -primary
  $cancel.DialogResult='Cancel';$f.CancelButton=$cancel;$f.AcceptButton=$save
  $completion=@{ok=$true;saved=$false;remembered=$false}
  $save.Add_Click({
   if(-not $first.Text -or -not $second.Text){$errorLabel.Text='Complete both fields.';return}
   if($remember.Checked -and -not (Save-Credential $target $first.Text $second.Text)){$errorLabel.Text='Could not store the credential.';return}
   $completion.saved=$true;$completion.remembered=[bool]$remember.Checked;$completion.profile=$profile;$completion.principal=$first.Text
   if(-not $remember.Checked){$completion.privateCredential=@{username=$first.Text;password=$second.Text}}
   $first.Clear();$second.Clear();$f.Close()
  })
  $f.Add_Shown({if($PromptStatusPath -and [UsersVault]::IsWindowVisible($f.Handle)){[IO.File]::WriteAllText($PromptStatusPath,'visible')}})
  Complete-SsamDialog $f ($y+254)
  $null=$f.ShowDialog();$f.Dispose();$completion|ConvertTo-Json -Depth 5 -Compress;exit 0
 }
 $v=if($r.privateCredential){[pscustomobject]@{UserName=[string]$r.privateCredential.username;Secret=[string]$r.privateCredential.password}}else{ReadVault $target $true}
 if(-not $v){Stop-Credential 'CREDENTIAL_NOT_FOUND'}
 if($r.privateSession -and ($r.privateSession.profile -cne $profile -or $r.privateSession.principal -cne $v.UserName)){$r.privateSession=$null}
 $jar=New-Object Net.CookieContainer
 foreach($cookie in $r.privateSession.cookies){
  if($cookie.expiresAt -and $cookie.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()){continue}
  $c=New-Object Net.Cookie([string]$cookie.name,[string]$cookie.value,[string]$cookie.path,$HostName);$c.Secure=$cookie.secure;$c.HttpOnly=$cookie.httpOnly
  if($cookie.expiresAt){$c.Expires=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$cookie.expiresAt).UtcDateTime};$jar.Add($c)
 }
 $token=[string]$r.privateSession.token
 if($Mode -eq 'login'){
  if($staticAuthorization){Stop-Credential 'CREDENTIAL_AUTH_UNSUPPORTED'}
  if($r.auth -eq 'api-client'){
   $discovery=Invoke-PrivateHttp ([Uri]"https://$HostName/identity/.well-known/openid-configuration") 'GET' $jar $null
   if($discovery.status -ne 200){Stop-Credential 'CREDENTIAL_LOGIN_FAILED'}
   $document=$discovery.body|ConvertFrom-Json
   $endpoint=[Uri]$document.token_endpoint
   if($endpoint.Scheme -ne 'https' -or $endpoint.Host -ne $HostName -or $endpoint.Port -ne 443 -or $endpoint.Query -or $endpoint.Fragment -or $endpoint.UserInfo -or ([string]$document.token_endpoint).Split('?')[0] -match '%2e|%2f|%5c|\\'){Stop-Credential 'CREDENTIAL_AUTH_UNSUPPORTED'}
   if(($document.grant_types_supported -and @($document.grant_types_supported) -cnotcontains 'client_credentials') -or ($document.token_endpoint_auth_methods_supported -and @($document.token_endpoint_auth_methods_supported) -cnotcontains 'client_secret_post')){Stop-Credential 'CREDENTIAL_AUTH_UNSUPPORTED'}
   $form='grant_type=client_credentials&client_id='+(Form $v.UserName)+'&client_secret='+(Form $v.Secret)
   $answer=Invoke-PrivateHttp $endpoint 'POST' $jar ([Text.Encoding]::UTF8.GetBytes($form)) 'application/x-www-form-urlencoded'
   $form=$null
   if($answer.status -ne 200){Stop-Credential 'CREDENTIAL_LOGIN_FAILED'}
   $result=$answer.body|ConvertFrom-Json
   if($result.token_type -ine 'Bearer' -or $result.access_token -isnot [string] -or -not $result.access_token -or $result.access_token.Length -gt 20000 -or $result.access_token -match '[\r\n]' -or $result.expires_in -isnot [ValueType] -or $result.expires_in -is [bool] -or [double]::IsNaN([double]$result.expires_in) -or [double]::IsInfinity([double]$result.expires_in) -or $result.expires_in -le 0){Stop-Credential 'CREDENTIAL_LOGIN_FAILED'}
   $token=[string]$result.access_token
   @{ok=$true;authenticated=$true;principal=$v.UserName;privateSession=@{profile=$profile;principal=$v.UserName;token=$token;expiresAt=[DateTimeOffset]::UtcNow.AddSeconds($result.expires_in).ToUnixTimeMilliseconds()};secretValues=@($v.Secret,$token)}|ConvertTo-Json -Compress -Depth 6;exit 0
  }
  . (Join-Path $PSScriptRoot 'credential-auth.ps1')
  $signed=Invoke-SsamCredentialLogin $r $v $jar
  if(-not $signed.ok -or -not $signed.authenticated){Stop-Credential $signed.code}
  @{ok=$true;authenticated=$true;principal=$v.UserName;privateSession=@{profile=$profile;principal=$v.UserName;cookies=$signed.cookies;token=$signed.token;expiresAt=$signed.expiresAt};secretValues=$signed.secretValues}|ConvertTo-Json -Compress -Depth 8;exit 0
 }
 if($Mode -ne 'request'){throw 'operation'}
 $authorizationScheme='Bearer'
 if($staticAuthorization){
  $timerUri=[Uri]$r.url
  if($r.method -cne 'GET' -or $timerUri.AbsolutePath -cne '/PerformanceProbe/rest/PerformanceMonitoringAPI/RequestEvents/'){throw 'timer route'}
  if($r.auth -eq 'basic'){$authorizationScheme='Basic';$token=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v.UserName+':'+$v.Secret))}else{$token=$v.Secret}
 }else{
  if(-not $token -and -not $r.privateSession.cookies){Stop-Credential 'CREDENTIAL_SIGN_IN_REQUIRED'}
  if(-not (Test-CredentialSession $r.privateSession $profile $v.UserName)){Stop-Credential 'CREDENTIAL_SESSION_EXPIRED'}
 }
 $bytes=if($r.body){[Convert]::FromBase64String($r.body)}else{$null}
 $page=Invoke-PrivateHttp ([Uri]$r.url) ([string]$r.method) $jar $bytes ([string]$r.contentType) $token $authorizationScheme
 $cookies=@(Cookie-State $jar)
 $secrets=@($v.Secret,$token)+@($cookies|ForEach-Object{$_.value})+@($r.privateSession.cookies|ForEach-Object{$_.value})
 if($r.service -eq 'odc-portal'){
  . (Join-Path $PSScriptRoot 'credential-auth.ps1')
  $secrets+=@(Get-SsamPortalCsrf $jar ([Uri]$r.url))
 }
 $body=$page.body;$location=$page.location
 foreach($secret in $secrets){$body=Redact $body $secret;$location=Redact $location $secret}
 $bodyBase64=if($body -ceq $page.body){[Convert]::ToBase64String($page.bytes)}else{[Convert]::ToBase64String([Text.Encoding]::GetEncoding($page.encoding).GetBytes($body))}
 if($page.contentType -notmatch 'json|text|xml|javascript|x-www-form-urlencoded'){
  $utf16=[Text.Encoding]::Unicode.GetString($page.bytes);$scrubbed16=$utf16
  foreach($secret in $secrets){$scrubbed16=Redact $scrubbed16 $secret}
  if($body -cne $page.body -or $scrubbed16 -cne $utf16){Stop-Credential 'CREDENTIAL_REQUEST_FAILED'}
  $bodyBase64=[Convert]::ToBase64String($page.bytes)
 }
 $notes=@();if($body -cne $page.body -or $location -cne $page.location){$notes=@('Sensitive authentication values were removed from the response.')}
 @{ok=$true;status=$page.status;body=$bodyBase64;contentType=$page.contentType;location=$location;url=[string]$r.url;privateSession=$(if(-not $staticAuthorization){@{profile=$profile;principal=$v.UserName;token=$token;expiresAt=$r.privateSession.expiresAt;cookies=$cookies}}else{$null});secretValues=$secrets;redacted=($notes.Count -gt 0)}|ConvertTo-Json -Compress -Depth 8
}catch{Stop-Credential 'CREDENTIAL_REQUEST_FAILED'}
