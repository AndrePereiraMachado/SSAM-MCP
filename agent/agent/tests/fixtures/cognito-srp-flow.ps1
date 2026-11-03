param([string]$Library)
$ErrorActionPreference='Stop'
. (Join-Path $Library 'credential-auth.ps1')
$rsa=New-Object Security.Cryptography.RSACryptoServiceProvider(2048);$rsa.PersistKeyInCsp=$false
$public=$rsa.ExportParameters($false)
$jwks=@{keys=@(@{kid='test';kty='RSA';alg='RS256';n=(ConvertTo-SsamBase64Url $public.Modulus);e=(ConvertTo-SsamBase64Url $public.Exponent)})}
$origin='https://tenant.example.test';$realm='/auth/realms/11111111-1111-1111-1111-111111111111';$client='abcdefghij123456'
function Form([string]$v){[Net.WebUtility]::UrlEncode($v)}
function Token([bool]$access){
 $claims=@{iss='https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Pool';sub='subject';iat=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();exp=[DateTimeOffset]::UtcNow.AddMinutes(5).ToUnixTimeSeconds();token_use=$(if($access){'access'}else{'id'})}
 if($access){$claims.client_id=$client;$claims.username='canonical'}else{$claims.aud=$client;$claims.'cognito:username'='canonical'}
 if($script:case -eq 'bad-audience' -and -not $access){$claims.aud='wrong'}
 $data=(ConvertTo-SsamBase64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"RS256","kid":"test"}')))+'.'+(ConvertTo-SsamBase64Url ([Text.Encoding]::UTF8.GetBytes(($claims|ConvertTo-Json -Compress))))
 $data+'.'+(ConvertTo-SsamBase64Url ($rsa.SignData([Text.Encoding]::ASCII.GetBytes($data),[Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'))))
}
function Invoke-SsamScreenAction($context,$origin,$module,$view,$action,$inputParameters=@{},$variables=@{},$token=''){
 if($action -eq 'authentication/UnifiedAuthentication/login/DataActionGetProviders'){return @{data=@{CognitoEnabled=$true;CognitoConfig=@{Region='us-east-1';PoolKey='us-east-1_Pool';AmplifyClientKey=$client;AuthFlow='USER_SRP_AUTH'}}}}
 if($action -like '*/DataActionGetRedirect'){return @{data=@{Url=$origin+$realm+'/protocol/openid-connect/auth?response_type=code&client_id=unified&redirect_uri='+[Uri]::EscapeDataString($origin+'/authentication/redirect')+'&state=initial'}}}
 if($action -like '*/ActionProcessCognitoToken'){$script:processed++;if($inputParameters.ClientId -cne 'broker'){throw 'wrong client'};return @{AuthCode='broker-code'}}
 if($action -like '*/ActionProcessCodeRedirect'){$context.Jar.Add([Uri]$origin,(New-Object Net.Cookie('session','synthetic-cookie','/')));$context.Visited[$origin]=[Uri]$origin;return @{}}
 if($action -eq 'connections/Connections/connections/DataActionGetProviders'){if($script:case -eq 'no-proof'){return @{}};return @{data=@{Providers=@()}}}
 throw 'Unexpected screen action'
}
function Invoke-SsamAuthHttp($context,[string]$value,[string]$method='GET',$body=$null,[hashtable]$headers=@{},[string]$contentType='application/json'){
 $u=Resolve-SsamAuthUri $context $value
 if($u.AbsolutePath -like '*/protocol/openid-connect/auth'){return @{status=302;location=$origin+'/authentication/login?response_type=code&client_id=broker&state=broker-state&redirect_uri='+[Uri]::EscapeDataString($origin+$realm+'/broker/os-builtin/endpoint')}}
 if($u.AbsolutePath -like '*/broker/os-builtin/endpoint'){return @{status=302;location=$origin+'/authentication/redirect?code=final-code&state='+$(if($script:case -eq 'bad-state'){'wrong'}else{'initial'})}}
 if($u.AbsolutePath -like '*/jwks.json'){return @{status=200;text=($jwks|ConvertTo-Json -Depth 8 -Compress)}}
 if($u.Host -eq 'cognito-idp.us-east-1.amazonaws.com'){
  if(($body|ConvertTo-Json -Depth 8 -Compress).Contains('synthetic-password')){throw 'password leaked into SRP wire'}
  if($headers['X-Amz-Target'] -like '*.InitiateAuth'){
   $script:initiated++;if($body.AuthFlow -cne 'USER_SRP_AUTH' -or -not $body.AuthParameters.SRP_A){throw 'wrong SRP request'}
   $answer=@{ChallengeName='PASSWORD_VERIFIER';ChallengeParameters=@{USER_ID_FOR_SRP='canonical';SRP_B=$(if($script:case -eq 'bad-b'){'0'}else{'5'});SALT='80';SECRET_BLOCK='c2VjcmV0'}}
  }else{
   $script:responded++;if(-not $body.ChallengeResponses.PASSWORD_CLAIM_SIGNATURE){throw 'missing proof'}
   $answer=if($script:case -eq 'mfa'){@{ChallengeName='SMS_MFA'}}else{@{AuthenticationResult=@{TokenType='Bearer';IdToken=(Token $false);AccessToken=(Token $true);RefreshToken='synthetic-refresh-token'}}}
  }
  return @{status=200;text=($answer|ConvertTo-Json -Depth 8 -Compress)}
 }
 throw 'Unexpected HTTP route'
}
$results=@()
foreach($item in @(@('ok',''),@('bad-b','CREDENTIAL_AUTH_RESPONSE_INVALID'),@('bad-audience','CREDENTIAL_IDENTITY_TOKEN_INVALID'),@('bad-state','CREDENTIAL_AUTH_STATE_INVALID'),@('mfa','CREDENTIAL_AUTH_INTERACTIVE_REQUIRED'),@('no-proof','CREDENTIAL_AUTH_CONTRACT_CHANGED'))){
 $script:case=$item[0];$script:initiated=0;$script:responded=0;$script:processed=0
 $result=Invoke-SsamCredentialLogin @{host='tenant.example.test';service='odc-portal'} @{UserName='user@example.test';Secret='synthetic-password'} (New-Object Net.CookieContainer)
 if([string]$result.code -cne $item[1] -or [bool]$result.authenticated -ne ($item[0] -eq 'ok') -or $script:initiated -gt 1 -or $script:responded -gt 1){throw ('Failed case '+$item[0]+': '+$result.code)}
 if($item[0] -in @('bad-b','bad-audience','mfa') -and $script:processed -ne 0){throw 'Unverified token was forwarded'}
 $results+=@{case=$item[0];passed=$true}
}
$rsa.Dispose()
ConvertTo-Json -InputObject $results -Compress
