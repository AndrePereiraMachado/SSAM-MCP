param([string]$Library)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. (Join-Path $Library 'credential-auth.ps1')
function Form([string]$v){[Net.WebUtility]::UrlEncode($v)}
$rsa=New-Object Security.Cryptography.RSACryptoServiceProvider(2048);$rsa.PersistKeyInCsp=$false
$key=$rsa.ExportParameters($false)
$jwks=@{keys=@(@{kid='fixture';kty='RSA';alg='RS256';use='sig';n=(ConvertTo-SsamBase64Url $key.Modulus);e=(ConvertTo-SsamBase64Url $key.Exponent)})}
$id='https://id.outsystems.com';$realm='/auth/realms/11111111-1111-1111-1111-111111111111';$issuer=$id+$realm
$tenant='tenant.example.test';$origin='https://'+$tenant
function Token($claims){
 $head=ConvertTo-SsamBase64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"RS256","kid":"fixture"}'))
 $body=ConvertTo-SsamBase64Url ([Text.Encoding]::UTF8.GetBytes(($claims|ConvertTo-Json -Compress -Depth 10)))
 $signature=$rsa.SignData([Text.Encoding]::ASCII.GetBytes($head+'.'+$body),[Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'))
 return $head+'.'+$body+'.'+(ConvertTo-SsamBase64Url $signature)
}
function Reply($value,[int]$status=200,[string]$location=''){return @{status=$status;text=$(if($value -is [string]){$value}else{ConvertTo-Json -InputObject $value -Compress -Depth 30});location=$location}}
function LoginUrl([string]$callback){(Set-SsamQuery ([Uri]"$id/community/login") @{response_type='code';client_id='tenant-client';scope='openid';code_challenge=('x'*43);code_challenge_method='S256';redirect_uri=$callback;state='tenant-state';nonce='tenant-nonce';login_hint=''}).AbsoluteUri}
function Invoke-SsamAuthHttp($context,[string]$value,[string]$method='GET',$body=$null,[hashtable]$headers=@{},[string]$contentType='application/json'){
 $u=Resolve-SsamAuthUri $context $value;$p=$u.AbsolutePath;$q=Get-SsamQuery $u;$context.Visited[$u.AbsoluteUri]=$u
 $script:paths.Add($u.Host+$p)
 if($script:mode -eq 'direct'){
  if($p -eq '/ServiceCenter/Login.aspx' -and $method -eq 'GET'){return Reply '<form method="post" action="Login.aspx"><div class="login-form"><input name="u" type="text"><input name="p" type="password"><input type="hidden" name="state" value="s"><input type="submit" name="go" value="Log in"></div></form>'}
  if($p -eq '/ServiceCenter/Login.aspx' -and $method -eq 'POST'){
   $f=[Web.HttpUtility]::ParseQueryString($body);if($f['p'] -cne 'Fixture-password' -or $f['u'] -cne 'owner@example.test'){throw 'wrong form'}
   $context.Jar.Add([Uri]($origin+'/ServiceCenter/'),(New-Object Net.Cookie('sc','Fixture-cookie','/ServiceCenter/')));return Reply '' 302 '/ServiceCenter/Error_Logs.aspx'
  }
 }
 if($u.Host -eq $tenant -and $p -eq '/ServiceCenter/Login.aspx'){return Reply '' 302 (LoginUrl "$origin/ServiceCenter/CentralizedLogin_AuthCodeFlow_TokenPart.aspx")}
 if($p -eq '/identity/.well-known/openid-configuration'){return Reply @{issuer=$issuer;authorization_endpoint="$issuer/protocol/openid-connect/auth";token_endpoint="$issuer/protocol/openid-connect/token";jwks_uri="$issuer/protocol/openid-connect/certs"}}
 if($p -eq "$realm/protocol/openid-connect/auth"){
  if($q['prompt'] -eq 'none'){
   $callback=if($script:service -eq 'service-center'){"$origin/ServiceCenter/CentralizedLogin_AuthCodeFlow_TokenPart.aspx"}else{"$origin/authentication/redirect"}
   $state=if($script:mode -eq 'bad-callback-state'){'wrong'}else{'tenant-state'}
   return Reply '' 302 ($callback+'?code=Fixture-code&state='+$state)
  }
  $script:nonce=$q['nonce'];$script:state=$q['state']
  return Reply '' 302 ('https://os-community-id.outsystems.app/identity?state=broker-state&redirect_uri='+(Form "$issuer/broker/os-builtin/endpoint"))
 }
 if($p -eq '/community/moduleservices/auth/configs'){return Reply @{authConfigurations=@(@{type='cognito';kc_hint='os-builtin';configs=@{authFlow='USER_PASSWORD_AUTH';region='us-east-1';poolId='us-east-1_pool';amplifyClientId='abcdefghijklmnop'}})}}
 if($u.Host -eq 'cognito-idp.us-east-1.amazonaws.com'){
  if($body.AuthParameters.PASSWORD -cne 'Fixture-password'){throw 'wrong password'}
  if($script:mode -eq 'challenge'){return Reply @{ChallengeName='SMS_MFA'}}
  return Reply @{AuthenticationResult=@{IdToken='Fixture-cognito-id';AccessToken='Fixture-cognito-access';RefreshToken='Fixture-cognito-refresh'}}
 }
 if($p -eq '/identityapi/v1alpha1/oidc/store-token'){return Reply @{authCode='Fixture-store-code'}}
 if($p -eq "$realm/broker/os-builtin/endpoint"){return Reply '' 302 ("$id/identity?code=Fixture-identity-code&state="+$script:state)}
 if($p -eq "$realm/protocol/openid-connect/token"){
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();$nonce=if($script:mode -eq 'bad-nonce'){'wrong'}else{$script:nonce};$exp=if($script:mode -eq 'expired'){$now-5}else{$now+3600}
  $identityClaims=@{iss=$issuer;sub='owner';aud='client_runtime';nonce=$nonce;iat=$now;exp=$exp}
  if($script:mode -eq 'bad-issuer'){$identityClaims.iss='https://wrong.example.test'}
  if($script:mode -eq 'bad-audience'){$identityClaims.aud='other-client'}
  if($script:mode -eq 'future-iat'){$identityClaims.iat=$now+600}
  if($script:mode -eq 'boolean-iat'){$identityClaims.iat=$true}
  if($script:mode -eq 'null-nbf'){$identityClaims.nbf=$null}
  $jwt=Token $identityClaims
  if($script:mode -eq 'bad-signature'){$jwt=$jwt.Substring(0,$jwt.Length-4)+'xxxx'}
  return Reply @{token_type='Bearer';id_token=$jwt;access_token=(Token @{iss=$issuer;sub=$(if($script:mode -eq 'bad-subject'){'other'}else{'owner'});azp=$(if($script:mode -eq 'bad-azp'){'other-client'}else{'client_runtime'});iat=$now;exp=$exp});refresh_token='Fixture-refresh-token'}
 }
 if($p -eq "$realm/protocol/openid-connect/certs"){return Reply $jwks}
 if($p -eq '/api/user-information/v1/profiles/me'){return Reply @{id='owner';email=$(if($script:mode -eq 'wrong-principal'){'another@example.test'}else{'owner@example.test'})}}
 if($p -eq '/api/user-information/v1/claims'){return Reply @{claims=$(if($script:mode -eq 'missing-role'){@('other')}else{@('c089d722-19c8-4ed6-a329-cf2e78c54b56.ab2a6b39-1f30-4f20-a069-cf5d18b076f4')})}}
 if($p -eq '/community/moduleservices/users/userinfosync'){return Reply '' 204}
 if($p -match '/moduleservices/moduleversioninfo$'){return Reply @{versionToken='fixture-version'}}
 if($p -match '^/(community|authentication|connections)/$'){$module=$matches[1];return Reply ('<script src="/'+$module+'/scripts/_osbundle-fixture.index.js"></script>')}
 if($p -match '^/(community|authentication|connections)/scripts/_osbundle-fixture.index.js$'){return Reply 'screenName:"Auth.login",load:import("./view.js");screenName:"UnifiedAuthentication.login",load:import("./view.js");screenName:"UnifiedAuthentication.redirect",load:import("./view.js");screenName:"Connections.connections",load:import("./view.js")'}
 if($p -match '/scripts/view.js$'){return Reply '"screenservices/community/Auth/login/DataActionGetSessionData","fixture-api";"screenservices/authentication/UnifiedAuthentication/login/DataActionGetProviders","fixture-api";"screenservices/authentication/UnifiedAuthentication/redirect/ActionProcessCodeRedirect","fixture-api";"screenservices/connections/Connections/connections/DataActionGetProviders","fixture-api"'}
 if($p -eq '/community/screenservices/community/Auth/login/DataActionGetSessionData'){
  return Reply @{data=@{HasSession=$true;IsAuthorizedRedirect_Uri=$true;NeedsToAcceptTerms=($script:mode -eq 'terms');AuthEndpointKC="$issuer/protocol/openid-connect/auth";AuthRedirectUriKC="$id/community/rest/redirect/login"}}
 }
 if($p -eq '/authentication/screenservices/authentication/UnifiedAuthentication/login/DataActionGetProviders'){return Reply @{data=@{CognitoEnabled=$false;RedirectNowUrl=(LoginUrl "$origin/authentication/redirect")}}}
 if($p -eq '/authentication/screenservices/authentication/UnifiedAuthentication/redirect/ActionProcessCodeRedirect'){
  $context.Jar.Add([Uri]$origin,(New-Object Net.Cookie('portal','Fixture-portal-cookie','/')));return Reply @{data=@{}}
 }
 if($p -eq '/connections/screenservices/connections/Connections/connections/DataActionGetProviders'){return Reply @{data=@{Providers=@()}}}
 if($p -eq '/ServiceCenter/CentralizedLogin_AuthCodeFlow_TokenPart.aspx'){$context.Jar.Add([Uri]($origin+'/ServiceCenter/'),(New-Object Net.Cookie('sc','Fixture-cookie','/ServiceCenter/')));return Reply '' 302 '/ServiceCenter/Error_Logs.aspx'}
 if($p -eq '/ServiceCenter/Error_Logs.aspx'){if($script:mode -eq 'no-protected-read'){return Reply '<form action="Login.aspx"></form>'};return Reply '<form action="Error_Logs.aspx"><a href="Logout.aspx">Logout</a></form>'}
 throw ('unmapped fixture path '+$p)
}
$results=@()
foreach($case in @(@('service-center','direct'),@('service-center','sso'),@('odc-portal','sso'),@('service-center','bad-nonce'),@('service-center','bad-issuer'),@('service-center','bad-audience'),@('service-center','future-iat'),@('service-center','boolean-iat'),@('service-center','null-nbf'),@('service-center','bad-subject'),@('service-center','bad-azp'),@('service-center','expired'),@('service-center','bad-signature'),@('service-center','wrong-principal'),@('service-center','missing-role'),@('service-center','terms'),@('service-center','challenge'),@('service-center','bad-callback-state'),@('service-center','no-protected-read'))){
 $script:service=$case[0];$script:mode=$case[1];$script:paths=New-Object 'Collections.Generic.List[string]'
 $answer=Invoke-SsamCredentialLogin @{host=$tenant;service=$script:service} @{UserName='owner@example.test';Secret='Fixture-password'} (New-Object Net.CookieContainer)
 $results+=@{case=($case -join '/');ok=$answer.ok;code=$answer.code;authenticated=$answer.authenticated;cookieCount=$(if($answer.cookies){@($answer.cookies).Count}else{0});cookiePath=$(if($answer.cookies){$answer.cookies[0].path}else{$null});secretsPrivate=($answer.ok -ne $true -or (@($answer.secretValues) -contains 'Fixture-password' -and @($answer.secretValues) -contains $answer.cookies[0].value));protectedRead=($script:paths -contains "$tenant/ServiceCenter/Error_Logs.aspx");steps=$script:paths.Count}
}
$rsa.Dispose();ConvertTo-Json -InputObject $results -Compress -Depth 5
