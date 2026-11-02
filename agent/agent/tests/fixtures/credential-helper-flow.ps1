param([string]$Library,[string]$Case='status',[string]$Render='' )
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$tokens=$null;$errors=$null
$helper=[Management.Automation.Language.Parser]::ParseFile((Join-Path $Library 'credential-vault.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Helper parse failed'}
$private=[Management.Automation.Language.Parser]::ParseFile((Join-Path $Library 'private-vault.ps1'),[ref]$tokens,[ref]$errors)
foreach($fn in $private.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){if($fn.Name -in @('B64','Form','Redact')){. ([scriptblock]::Create($fn.Extent.Text))}}
. (Join-Path $Library 'credential-auth.ps1')
foreach($fn in $helper.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){
 $code=$fn.Extent.Text
 if($fn.Name -eq 'Invoke-PrivateHttp'){$code=$code.Replace('[Net.HttpWebRequest]::Create($uri)','(New-FixtureRequest $uri)').Replace('. (Join-Path $PSScriptRoot ''credential-auth.ps1'')','')}
 . ([scriptblock]::Create($code))
}
Add-Type -TypeDefinition 'public static class UsersVault { public static bool FailDelete=false; public static bool Delete(string target,int a,int b){ return !FailDelete; } public static bool IsWindowVisible(System.IntPtr handle){return true;} }'
$Scope='a'*32;$HostName='tenant.example.test';$Mode='status'
$default='0'*64;$other='b'*64
function ReadVault([string]$target,[bool]$secret){
 if($target.EndsWith('/selected')){if($Case -eq 'selected-other'){return @{UserName='Selected profile';Secret=$other}};return $null}
 if($Case -eq 'missing'){return $null}
 return @{UserName=$(if($target.EndsWith('/'+$other)){'second@example.test'}else{'owner@example.test'});Secret=$(if($secret){'Fixture-password'}else{$null})}
}
function Names([string]$filter){$prefix=$filter.TrimEnd('*');return @(@{Name=($prefix+$default)},@{Name=($prefix+$other)},@{Name=($prefix+'selected')})}
function Save-Credential([string]$target,[string]$user,[string]$secret){if($Case -in @('ui-login-save-failed','ui-profile-error')){return $false};$script:SavedTarget=$target;$script:SavedUser=$user;$script:SavedSecret=$secret;return $true}
function New-FixtureRequest([Uri]$uri){
 if($Case -in @('status','missing','status-expired','status-other-principal','selected-other','profile-changed','status-basic')){throw 'Status must not perform HTTP'}
 $w=[pscustomobject]@{Uri=$uri;Method='';AllowAutoRedirect=$false;Timeout=0;ReadWriteTimeout=0;KeepAlive=$false;CookieContainer=$null;UserAgent='';Accept='';Headers=(New-Object Collections.Specialized.NameValueCollection);ContentType='';ContentLength=0;Referer='';RequestStream=(New-Object IO.MemoryStream)}
 $w | Add-Member ScriptMethod GetRequestStream { return $this.RequestStream }
 $w | Add-Member ScriptMethod GetResponse {
  $uri=$this.Uri
  if($this.AllowAutoRedirect){throw 'Redirects must remain manual'}
  if($Case -eq 'csrf' -and ($this.Headers['x-csrftoken'] -cne 'Fixture-csrf' -or $this.Headers['Origin'] -cne 'https://tenant.example.test' -or $this.Headers['outsystems-client-env'] -cne 'browser' -or $this.Referer -cne 'https://tenant.example.test/connections/')){throw 'Missing CSRF headers'}
  if($Case -eq 'timer-basic' -and $this.Headers['Authorization'] -cne ('Basic '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('owner@example.test:Fixture-password')))){throw 'Missing Basic header'}
  if($Case -eq 'timer-token' -and $this.Headers['Authorization'] -cne 'Bearer Fixture-password'){throw 'Missing Bearer header'}
  $ct='text/plain';$bytes=[Text.Encoding]::UTF8.GetBytes('safe response')
  if($Case -eq 'charset'){$ct='text/plain; charset=windows-1252';$bytes=[byte[]]@(99,97,102,233)}
  if($Case -eq 'binary'){$ct='application/octet-stream';$bytes=[byte[]]@(0,255,128,65,13,10,0,250)}
  if($Case -eq 'binary-secret'){$ct='application/octet-stream';$bytes=[Text.Encoding]::UTF8.GetBytes('prefix Fixture-password suffix')}
  if($Case -eq 'echo'){$bytes=[Text.Encoding]::UTF8.GetBytes('Fixture-password Fixture-cookie')}
  if($Case -eq 'csrf'){$bytes=[Text.Encoding]::UTF8.GetBytes('Fixture-csrf')}
  if($uri.AbsolutePath -eq '/identity/.well-known/openid-configuration'){
   $endpoint=switch($Case){'oauth-foreign'{'https://foreign.example.test/token'} 'oauth-port'{'https://tenant.example.test:8443/token'} default{'https://tenant.example.test/token'}}
   $doc=@{token_endpoint=$endpoint;grant_types_supported=@('client_credentials');token_endpoint_auth_methods_supported=@('client_secret_post')}
   if($Case -eq 'oauth-grant'){$doc.grant_types_supported=@('password')}
   $ct='application/json';$bytes=[Text.Encoding]::UTF8.GetBytes(($doc|ConvertTo-Json -Compress))
  }
  if($uri.AbsolutePath -eq '/token'){
   $body=[Text.Encoding]::UTF8.GetString($this.RequestStream.ToArray());$fields=[Web.HttpUtility]::ParseQueryString($body)
   if($fields['client_secret'] -cne 'Fixture-password' -or $fields['client_id'] -cne 'owner@example.test' -or $fields['grant_type'] -cne 'client_credentials'){throw 'Wrong private token request'}
   $doc=@{token_type='Bearer';access_token='Fixture-access-token';expires_in=3600}
   if($Case -eq 'oauth-expiry'){$doc.expires_in='3600'}
   if($Case -eq 'oauth-crlf'){$doc.access_token="Fixture-access-token`r`nInjected"}
   $ct='application/json';$bytes=[Text.Encoding]::UTF8.GetBytes(($doc|ConvertTo-Json -Compress))
  }
  $response=[pscustomobject]@{StatusCode=200;ContentType=$ct;Headers=(New-Object Collections.Specialized.NameValueCollection);ResponseBytes=$bytes}
  $response|Add-Member ScriptMethod GetResponseStream {return (New-Object IO.MemoryStream(,$this.ResponseBytes))}
  $response|Add-Member ScriptMethod Close {}
  return $response
 }
 return $w
}
$request=@{service='service-center';auth='credential';privateSession=@{profile=$default;principal='owner@example.test';cookies=@(@{name='sc';value='Fixture-cookie';path='/ServiceCenter/';secure=$true;httpOnly=$true});expiresAt=[DateTimeOffset]::UtcNow.AddHours(1).ToUnixTimeMilliseconds()}}
if($Case -eq 'status-temporary'){$request.privateCredential=@{username='temporary@example.test';password='Fixture-temporary'};$request.privateSession.principal='temporary@example.test'}
if($Case -eq 'status-cookie-expired'){$request.privateSession.cookies[0].expiresAt=1}
if($Case -eq 'status-expired'){$request.privateSession.expiresAt=1}
if($Case -eq 'status-other-principal'){$request.privateSession.principal='other@example.test'}
if($Case -eq 'profile-changed'){$Mode='request';$request.profile=$other;$request.url='https://tenant.example.test/ServiceCenter/Error_Logs.aspx';$request.method='GET'}
if($Case -in @('binary','binary-secret','echo','csrf','timer-basic','timer-token','charset')){$Mode='request';$request.url='https://tenant.example.test/ServiceCenter/Error_Logs.aspx';$request.method='GET'}
if($Case -eq 'csrf'){$request.service='odc-portal';$request.url='https://tenant.example.test/connections/moduleservices/info';$request.privateSession.cookies=@(@{name='nr2auth';value='x%3D1%3Bcrf%3DFixture-csrf';path='/';secure=$true;httpOnly=$true})}
if($Case -in @('timer-basic','timer-token','status-basic')){$request.auth=if($Case -eq 'timer-token'){'service-token'}else{'basic'};$request.privateSession=$null;$request.url='https://tenant.example.test/PerformanceProbe/rest/PerformanceMonitoringAPI/RequestEvents/?EventNames=TimerExecuted&NumberOfResults=10'}
if($Case.StartsWith('oauth-')){$Mode='login';$request.service='odc-portal';$request.auth='api-client';$request.privateSession=$null}

if($Case.StartsWith('ui-')){
 . (Join-Path $Library 'private-dialog.ps1')
 $script:OriginalDialog=(Get-Command New-SsamDialog).ScriptBlock
 function All-FixtureControls($parent){foreach($child in $parent.Controls){$child;All-FixtureControls $child}}
 function New-SsamDialog([string]$title,[string]$description,[string]$service,[string]$hostName,[int]$width=440){
  $f=& $script:OriginalDialog $title $description $service $hostName $width
  $f.Opacity=0;$f.ShowInTaskbar=$false
  $f.Add_Shown({
   try {
    $controls=@(All-FixtureControls $this);$textboxes=@($controls|Where-Object{$_ -is [Windows.Forms.TextBox]})
    if($Case -match '^ui-(login|api|portal)-error$'){($controls|Where-Object{$_.Text -in @('Sign in','Connect')}).PerformClick()}
    if($Case -match '^ui-login-(save|temporary)'){
     $textboxes[0].Text='owner@example.test';$textboxes[1].Text='Fixture-private-entry';($controls|Where-Object{$_ -is [SsamRememberBox]}).Checked=($Case -notmatch 'temporary')
     ($controls|Where-Object{$_.Text -in @('Sign in','Connect')}).PerformClick()
     [Console]::WriteLine((@{vaultWritten=[bool]$script:SavedTarget;fieldCount=$textboxes.Count;fieldsCleared=($textboxes[0].Text -eq '' -and $textboxes[1].Text -eq '');storageFailureVisible=(@($controls|Where-Object{$_.Text -eq 'Could not store the credential.'}).Count -eq 1)}|ConvertTo-Json -Compress))
    }
    if($Case -in @('ui-profile-use','ui-profile-error')){
     @($controls|Where-Object{$_ -is [Windows.Forms.RadioButton]})[1].Checked=$true
     ($controls|Where-Object{$_.Text -eq 'Use profile'}).PerformClick()
     [Console]::WriteLine((@{selectionStored=($script:SavedTarget -like '*/selected');correctProfile=($script:SavedSecret -ceq ('b'*64))}|ConvertTo-Json -Compress))
    }
    if($Case -eq 'ui-forget-temporary'){[UsersVault]::FailDelete=$true}
    if($Case -eq 'ui-forget-error'){[UsersVault]::FailDelete=$true}
    if($Case -in @('ui-forget-confirm','ui-forget-error','ui-forget-temporary')){($controls|Where-Object{$_.Text -eq 'Remove credential'}).PerformClick()}
    if($Render){$bitmap=New-Object Drawing.Bitmap($this.Width,$this.Height);try{$this.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$this.Width,$this.Height)));$bitmap.Save($Render)}finally{$bitmap.Dispose()}}
    if($Case -match '-initial$|-error$'){[Console]::WriteLine((@{rendered=[bool]$Render;errorVisible=(@($controls|Where-Object{$_.Text -in @('Complete both fields.','Could not select the saved account.','Could not remove the saved credential.')}).Count -eq 1);title=$this.Text}|ConvertTo-Json -Compress))}
   }catch{[Console]::WriteLine('{"fixtureError":true}')}finally{$this.Close()}
  })
  return $f
 }
 $Mode=if($Case.StartsWith('ui-forget')){'forget'}else{'prompt'}
 if($Case -eq 'ui-forget-temporary'){$request.privateCredential=@{username='temporary@example.test';password='Fixture-temporary'}}
 if($Case.StartsWith('ui-profile')){$request.mode='select-profile'}
 if($Case.StartsWith('ui-api')){$request.service='odc-portal';$request.auth='api-client'}
 if($Case.StartsWith('ui-portal')){$request.service='odc-portal'}
}
$payload=$request|ConvertTo-Json -Compress -Depth 8
[Console]::SetIn((New-Object IO.StringReader($payload)))
$main=@($helper.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.TryStatementAst]})[-1].Extent.Text
$main=$main.Replace('. (Join-Path $PSScriptRoot ''credential-auth.ps1'')','')
$main=$main.Replace('. (Join-Path $PSScriptRoot ''private-dialog.ps1'')','')
. ([scriptblock]::Create($main))