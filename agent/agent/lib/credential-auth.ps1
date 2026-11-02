# Private, bounded authentication protocols used only by the Agent helper.
# Based on the verified SC community-identity/sso and Portal broker protocols.
# No remote JavaScript is executed. Passwords, tokens and cookies remain local.
Add-Type -AssemblyName System.Web
function Stop-SsamAuth([string]$code) { $e=New-Object InvalidOperationException('Private authentication did not complete.');$e.Data['code']=$code;throw $e }
function ConvertTo-SsamBase64Url([byte[]]$bytes) { [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_') }
function ConvertFrom-SsamBase64Url([string]$value) {
 if($value -cnotmatch '^[A-Za-z0-9_-]+$'){Stop-SsamAuth 'CREDENTIAL_IDENTITY_TOKEN_INVALID'}
 $v=$value.Replace('-','+').Replace('_','/');$v+='='*((4-$v.Length%4)%4);return ,([Convert]::FromBase64String($v))
}
function New-SsamNonce([int]$size=24) { $bytes=New-Object byte[] $size;$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$rng.GetBytes($bytes);ConvertTo-SsamBase64Url $bytes}finally{$rng.Dispose()} }
function Test-SsamPublicAddress([Net.IPAddress]$address) {
 if($address.IsIPv4MappedToIPv6){$address=$address.MapToIPv4()};$b=$address.GetAddressBytes()
 if($b.Length -eq 4){return -not ($b[0] -in @(0,10,127) -or $b[0] -ge 224 -or ($b[0] -eq 100 -and $b[1] -ge 64 -and $b[1] -le 127) -or ($b[0] -eq 169 -and $b[1] -eq 254) -or ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or ($b[0] -eq 192 -and ($b[1] -eq 168 -or ($b[1] -eq 0 -and $b[2] -eq 0))) -or ($b[0] -eq 198 -and $b[1] -in @(18,19)))}
 # Reject unspecified, loopback, all transition forms, ULA, link-local and multicast.
 return ($b[0] -ge 0x20 -and $b[0] -le 0x3f -and -not ($b[0] -eq 0x20 -and $b[1] -eq 0x02))
}
function Resolve-SsamAuthUri($context,[string]$value,[string]$base='') {
 try{$u=if($base){New-Object Uri([Uri]$base,$value)}else{[Uri]$value}}catch{Stop-SsamAuth 'CREDENTIAL_AUTH_ORIGIN_REFUSED'}
 if(-not $u.IsAbsoluteUri -or $u.Scheme -cne 'https' -or $u.Port -ne 443 -or $u.UserInfo -or $u.Fragment -or ($value.Split('?')[0] -match '%2e|%2f|%5c|\\') -or $u.Host -notin @($context.Host,'id.outsystems.com','cognito-idp.us-east-1.amazonaws.com')){Stop-SsamAuth 'CREDENTIAL_AUTH_ORIGIN_REFUSED'}
 return $u
}
function Invoke-SsamAuthHttp($context,[string]$value,[string]$method='GET',$body=$null,[hashtable]$headers=@{},[string]$contentType='application/json') {
 $u=Resolve-SsamAuthUri $context $value
 $left=85000-$context.Clock.ElapsedMilliseconds;if($left -le 0){Stop-SsamAuth 'CREDENTIAL_AUTH_TIMEOUT'}
 $addresses=@([Net.Dns]::GetHostAddresses($u.Host));if(-not $addresses.Count){Stop-SsamAuth 'CREDENTIAL_AUTH_ORIGIN_REFUSED'}
 foreach($address in $addresses){if(-not (Test-SsamPublicAddress $address)){Stop-SsamAuth 'CREDENTIAL_AUTH_ORIGIN_REFUSED'}}
 [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
 $web=[Net.HttpWebRequest]::Create($u);$web.Method=$method;$web.AllowAutoRedirect=$false;$web.KeepAlive=$false;$web.CookieContainer=$context.Jar
 $web.Timeout=[int][Math]::Min(45000,$left);$web.ReadWriteTimeout=$web.Timeout;$web.Accept='application/json,text/html';$web.UserAgent='SSAM-Agent/1'
 foreach($key in $headers.Keys){if($key -eq 'Referer'){$web.Referer=$headers[$key]}else{$web.Headers[$key]=$headers[$key]}}
 if($null -ne $body){$text=if($body -is [string]){$body}else{ConvertTo-Json -InputObject $body -Compress -Depth 30};$bytes=[Text.Encoding]::UTF8.GetBytes($text);$text=$null;$web.ContentType=$contentType;$web.ContentLength=$bytes.Length
  try{$stream=$web.GetRequestStream();try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Close()}}finally{[Array]::Clear($bytes,0,$bytes.Length)}
 }
 try{$response=$web.GetResponse()}catch [Net.WebException]{$response=$_.Exception.Response;if(-not $response){Stop-SsamAuth 'CREDENTIAL_AUTH_TRANSPORT_FAILED'}}
 try{
  $context.Visited[$u.AbsoluteUri]=$u
  foreach($cookie in $context.Jar.GetCookies($u)){if($cookie.Value){$context.Secrets.Add($cookie.Value)}}
  $memory=New-Object IO.MemoryStream;$stream=$response.GetResponseStream();$buffer=New-Object byte[] 65536
  try{while(($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0){if($context.Clock.ElapsedMilliseconds -ge 85000){Stop-SsamAuth 'CREDENTIAL_AUTH_TIMEOUT'};if($memory.Length+$count -gt 4194304){Stop-SsamAuth 'CREDENTIAL_AUTH_RESPONSE_TOO_LARGE'};$memory.Write($buffer,0,$count)}
   return @{status=[int]$response.StatusCode;text=[Text.Encoding]::UTF8.GetString($memory.ToArray());location=[string]$response.Headers['Location']}
  }finally{$stream.Close();$memory.Dispose()}
 }finally{$response.Close()}
}
function Invoke-SsamAuthJson($context,[string]$url,[string]$method='GET',$body=$null,[hashtable]$headers=@{},[string]$contentType='application/json') {
 $r=Invoke-SsamAuthHttp $context $url $method $body $headers $contentType
 if($r.status -lt 200 -or $r.status -ge 300){Stop-SsamAuth 'CREDENTIAL_LOGIN_FAILED'}
 try{return ($r.text|ConvertFrom-Json)}catch{Stop-SsamAuth 'CREDENTIAL_AUTH_RESPONSE_INVALID'}
}
function ConvertTo-SsamForm($fields) { (@(foreach($key in $fields.Keys){(Form ([string]$key))+'='+(Form ([string]$fields[$key]))}) -join '&') }
function Set-SsamQuery([Uri]$uri,$fields) {$builder=New-Object UriBuilder($uri);$builder.Query=ConvertTo-SsamForm $fields;return $builder.Uri}
function Get-SsamQuery([Uri]$uri) { return ,([Web.HttpUtility]::ParseQueryString($uri.Query)) }
function Read-SsamIdentityJwt([string]$token,$jwks,[string]$issuer,[string]$audience='',[string]$nonce='',[string]$subject='') {
 try{
  if($token.Length -gt 20000){throw 'token'};$p=$token.Split('.');if($p.Length -ne 3){throw 'token'}
  $header=[Text.Encoding]::UTF8.GetString((ConvertFrom-SsamBase64Url $p[0]))|ConvertFrom-Json
  $claims=[Text.Encoding]::UTF8.GetString((ConvertFrom-SsamBase64Url $p[1]))|ConvertFrom-Json
  if($header.alg -cne 'RS256' -or $header.kid -isnot [string] -or @($header.PSObject.Properties.Name | Where-Object {$_ -cin @('crit','jku','x5u')}).Count){throw 'algorithm'}
  $keys=@($jwks.keys|Where-Object{$_.kid -ceq $header.kid -and $_.kty -ceq 'RSA' -and (-not $_.alg -or $_.alg -ceq 'RS256') -and (-not $_.use -or $_.use -ceq 'sig')});if($keys.Count -ne 1){throw 'key'}
  $parameters=New-Object Security.Cryptography.RSAParameters;$parameters.Modulus=ConvertFrom-SsamBase64Url $keys[0].n;$parameters.Exponent=ConvertFrom-SsamBase64Url $keys[0].e
  if($parameters.Modulus.Length -lt 256){throw 'keysize'}
  $rsa=New-Object Security.Cryptography.RSACryptoServiceProvider;$rsa.PersistKeyInCsp=$false
  try{$rsa.ImportParameters($parameters);$valid=$rsa.VerifyData([Text.Encoding]::ASCII.GetBytes($p[0]+'.'+$p[1]),[Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'),(ConvertFrom-SsamBase64Url $p[2]));if(-not $valid){throw 'signature'}}finally{$rsa.Dispose()}
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  foreach($claim in @('exp','iat','nbf')){if(@($claims.PSObject.Properties.Name) -ccontains $claim){if($claims.$claim -isnot [ValueType] -or $claims.$claim -is [bool] -or [double]::IsNaN([double]$claims.$claim) -or [double]::IsInfinity([double]$claims.$claim)){throw 'numeric claim'}}}
  if($claims.iss -cne $issuer -or $claims.sub -isnot [string] -or -not $claims.sub -or $claims.exp -isnot [ValueType] -or $claims.iat -isnot [ValueType] -or $claims.exp -le $now -or $claims.iat -gt $now+30 -or ($null -ne $claims.nbf -and ($claims.nbf -isnot [ValueType] -or $claims.nbf -gt $now+30))){throw 'claims'}
  if($audience -and (@($claims.aud) -cnotcontains $audience -or ($claims.azp -and $claims.azp -cne $audience) -or (@($claims.aud).Count -gt 1 -and $claims.azp -cne $audience))){throw 'audience'}
  if($nonce -and $claims.nonce -cne $nonce){throw 'nonce'};if($subject -and $claims.sub -cne $subject){throw 'subject'}
  return $claims
 }catch{Stop-SsamAuth 'CREDENTIAL_IDENTITY_TOKEN_INVALID'}
}
function Invoke-SsamScreenAction($context,[string]$origin,[string]$module,[string]$view,[string]$action,$inputParameters=@{},$variables=@{},[string]$token='') {
 $version=Invoke-SsamAuthJson $context "$origin/$module/moduleservices/moduleversioninfo"
 if($version.versionToken -isnot [string] -or -not $version.versionToken){Stop-SsamAuth 'CREDENTIAL_AUTH_CONTRACT_CHANGED'}
 $page=Invoke-SsamAuthHttp $context "$origin/$module/"
 $bundle=$null
 foreach($m in [regex]::Matches($page.text,'<script[^>]+src=["'']([^"'']+)["'']')){$candidate=Resolve-SsamAuthUri $context $m.Groups[1].Value "$origin/$module/";if($candidate.AbsolutePath -match '_osbundle-' -and $candidate.AbsolutePath -match '\.index'){$bundle=$candidate;break}}
 if(-not $bundle -or $bundle.GetLeftPart([UriPartial]::Authority) -cne $origin){Stop-SsamAuth 'CREDENTIAL_AUTH_CONTRACT_CHANGED'}
 $entry=Invoke-SsamAuthHttp $context $bundle.AbsoluteUri
 $actual=$view;if(-not [regex]::IsMatch($entry.text,'screenName:["'']'+[regex]::Escape($view)+'["'']')){$actual=$view -creplace ('^'+[regex]::Escape($module)+'\.'),''}
 $lazy=[regex]::Match($entry.text,'screenName:["'']'+[regex]::Escape($actual)+'["''][\s\S]{0,400}?import\(["'']([^"'']+)["'']')
 if(-not $lazy.Success){Stop-SsamAuth 'CREDENTIAL_AUTH_CONTRACT_CHANGED'}
 $queue=New-Object 'Collections.Generic.Queue[Uri]';$queue.Enqueue((Resolve-SsamAuthUri $context $lazy.Groups[1].Value $bundle.AbsoluteUri));$visited=@{};$apiVersion=$null;$bytes=0
 while($queue.Count -and $visited.Count -lt 48){$u=$queue.Dequeue();if($visited[$u.AbsoluteUri]){continue}
  if($u.GetLeftPart([UriPartial]::Authority) -cne $origin -or -not $u.AbsolutePath.StartsWith("/$module/scripts/") -or -not $u.AbsolutePath.EndsWith('.js')){continue}
  $visited[$u.AbsoluteUri]=$true;$code=Invoke-SsamAuthHttp $context $u.AbsoluteUri;$bytes+=[Text.Encoding]::UTF8.GetByteCount($code.text)
  if($bytes -gt 16000000){Stop-SsamAuth 'CREDENTIAL_AUTH_CONTRACT_CHANGED'}
  $match=[regex]::Match($code.text,'["'']screenservices/'+[regex]::Escape($action)+'["'']\s*,\s*["'']([^"'']+)["'']')
  if($match.Success){$apiVersion=$match.Groups[1].Value;break}
  foreach($m in [regex]::Matches($code.text,'(?:from\s*|import\s*\()["''](\./[^"'']+\.js)["'']')){$queue.Enqueue((Resolve-SsamAuthUri $context $m.Groups[1].Value $u.AbsoluteUri))}
 }
 if(-not $apiVersion){Stop-SsamAuth 'CREDENTIAL_AUTH_CONTRACT_CHANGED'}
 $headers=@{Origin=$origin;Referer="$origin/$module/";'outsystems-client-env'='browser'}
 if($token){$headers.Authorization='Bearer '+$token}
 $csrf=Get-SsamPortalCsrf $context.Jar ([Uri]"$origin/$module/")
 if($csrf){$headers['x-csrftoken']=$csrf;$context.Secrets.Add($csrf)}
 $body=@{versionInfo=@{moduleVersion=$version.versionToken;apiVersion=$apiVersion};viewName=$view;inputParameters=$inputParameters;screenData=@{variables=$variables};clientVariables=@{}}
 $answer=Invoke-SsamAuthJson $context "$origin/$module/screenservices/$action" 'POST' $body $headers
 if($answer.exception -or $answer.error -or $answer.versionInfo.hasApiVersionChanged -or $answer.versionInfo.hasModuleVersionChanged){Stop-SsamAuth 'CREDENTIAL_AUTH_CONTRACT_CHANGED'}
 return $answer
}
function Read-SsamLoginHtml([string]$html) {
 $clean=[regex]::Replace($html,'<!--[\s\S]*?-->|<script\b[\s\S]*?</script\s*>','','IgnoreCase')
 $nodes=New-Object 'Collections.Generic.List[object]';$stack=New-Object 'Collections.Generic.List[object]'
 foreach($m in [regex]::Matches($clean,'<(/?)([A-Za-z][A-Za-z0-9:-]*)\b((?:"[^"]*"|''[^'']*''|[^''">])*)>')){
  $tag=$m.Groups[2].Value.ToLowerInvariant()
  if($m.Groups[1].Value){for($i=$stack.Count-1;$i -ge 0;$i--){$n=$stack[$i];$n.End=$m.Index;$stack.RemoveAt($i);if($n.Tag -eq $tag){break}};continue}
  $attrs=@{}
  foreach($a in [regex]::Matches($m.Groups[3].Value,'([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|''([^'']*)''|([^\s>]+)))?')){
   $key=$a.Groups[1].Value.ToLowerInvariant();if($attrs.ContainsKey($key)){Stop-SsamAuth 'CREDENTIAL_LOGIN_LAYOUT_CHANGED'}
   $attrs[$key]=[Net.WebUtility]::HtmlDecode($a.Groups[2].Value+$a.Groups[3].Value+$a.Groups[4].Value)
  }
  $node=@{Tag=$tag;Attrs=$attrs;Parent=$(if($stack.Count){$stack[$stack.Count-1]}else{$null});Start=($m.Index+$m.Length);End=$clean.Length;Source=$clean}
  $nodes.Add($node)
  if($tag -notin @('input','br','hr','meta','link','img','area','base','col','embed','param','source','track','wbr') -and -not $m.Groups[3].Value.TrimEnd().EndsWith('/')){$stack.Add($node)}
 }
 return ,$nodes
}
function Test-SsamDescendant($node,$parent){$n=$node;while($n){if([object]::ReferenceEquals($n,$parent)){return $true};$n=$n.Parent};return $false}
function Get-SsamCaption($node){if($node.Tag -eq 'input'){return [string]$node.Attrs.value};$body=$node.Source.Substring($node.Start,[Math]::Max(0,$node.End-$node.Start));return [Net.WebUtility]::HtmlDecode(([regex]::Replace($body,'<[^>]+>',''))).Trim()}
function Get-SsamLoginPlan([string]$html,[Uri]$uri,[switch]$sso){
 $nodes=Read-SsamLoginHtml $html;$passwords=@($nodes|Where-Object{$_.Tag -eq 'input' -and $_.Attrs.type -eq 'password'})
 $pattern=if($sso){'log ?in with|single sign'}else{'^(?:Log in|Login|Sign in)$'}
 $buttons=@($nodes|Where-Object{$_.Tag -in @('input','button') -and -not $_.Attrs.ContainsKey('disabled') -and (($_.Tag -eq 'button' -and -not $_.Attrs.type) -or $_.Attrs.type -eq 'submit') -and (Get-SsamCaption $_) -match $pattern})
 if($buttons.Count -ne 1 -or (-not $sso -and $passwords.Count -ne 1)){Stop-SsamAuth 'CREDENTIAL_LOGIN_LAYOUT_CHANGED'}
 $button=$buttons[0];$form=$button.Parent;while($form -and $form.Tag -ne 'form'){$form=$form.Parent}
 if(-not $form -or $form.Attrs.method -ine 'post' -or $button.Attrs.formaction -or $button.Attrs.form -or $button.Attrs.onclick -match 'OsAjax|__doPostBack|\.submit\('){Stop-SsamAuth 'CREDENTIAL_LOGIN_LAYOUT_CHANGED'}
 $action=New-Object Uri($uri,[string]$form.Attrs.action)
 if($action.GetLeftPart([UriPartial]::Authority) -cne $uri.GetLeftPart([UriPartial]::Authority) -or $action.AbsolutePath -cne '/ServiceCenter/Login.aspx' -or $action.UserInfo -or $action.Fragment -or $form.Attrs.action -match '%2e|%2f|%5c|\\'){Stop-SsamAuth 'CREDENTIAL_AUTH_ORIGIN_REFUSED'}
 $user=$null
 if(-not $sso){
  $scopes=@($nodes|Where-Object{(Test-SsamDescendant $_ $form) -and $_.Attrs.class -match '(?:^|\s)login-form(?:\s|$)'})
  if($scopes.Count -gt 1){Stop-SsamAuth 'CREDENTIAL_LOGIN_LAYOUT_CHANGED'};$scope=if($scopes.Count){$scopes[0]}else{$form}
  $users=@($nodes|Where-Object{$_.Tag -eq 'input' -and (-not $_.Attrs.type -or $_.Attrs.type -in @('text','email')) -and (Test-SsamDescendant $_ $scope)})
  if($users.Count -ne 1 -or -not (Test-SsamDescendant $passwords[0] $scope) -or -not (Test-SsamDescendant $button $scope)){Stop-SsamAuth 'CREDENTIAL_LOGIN_LAYOUT_CHANGED'}
  $user=$users[0];if(-not $user.Attrs.name -or -not $passwords[0].Attrs.name -or $user.Attrs.name -eq $passwords[0].Attrs.name){Stop-SsamAuth 'CREDENTIAL_LOGIN_LAYOUT_CHANGED'}
 }
 $fields=@{}
 foreach($n in $nodes){if(-not (Test-SsamDescendant $n $form) -or $n.Tag -notin @('input','button','select','textarea') -or -not $n.Attrs.name -or $n.Attrs.ContainsKey('disabled')){continue}
  if($n.Attrs.form -or $n.Tag -in @('select','textarea')){Stop-SsamAuth 'CREDENTIAL_LOGIN_LAYOUT_CHANGED'}
  if($n.Attrs.type -in @('reset','button','file','image')){continue}
  if($n.Attrs.type -in @('checkbox','radio') -and -not $n.Attrs.ContainsKey('checked')){continue}
  if(($n.Tag -eq 'button' -or $n.Attrs.type -eq 'submit') -and -not [object]::ReferenceEquals($n,$button)){continue}
  if($fields.ContainsKey($n.Attrs.name)){Stop-SsamAuth 'CREDENTIAL_LOGIN_LAYOUT_CHANGED'}
  $fields[$n.Attrs.name]=[string]$n.Attrs.value
 }
 return @{url=$action;fields=$fields;user=$(if($user){$user.Attrs.name});password=$(if(-not $sso){$passwords[0].Attrs.name})}
}
function Test-SsamProtectedSc([string]$html){
 $nodes=Read-SsamLoginHtml $html
 if(@($nodes|Where-Object{($_.Tag -eq 'form' -and $_.Attrs.action -match '(?:^|/)_?login(?:sso)?\.aspx(?:\?|$)') -or $_.Attrs.class -match '(?:^|\s)sc-layout-login(?:\s|$)'}).Count){return $false}
 return @($nodes|Where-Object{$_.Tag -in @('a','button','input') -and (([string]$_.Attrs.href+' '+[string]$_.Attrs.onclick) -match 'logout' -or (Get-SsamCaption $_) -match '^log ?out$')}).Count -gt 0
}
function Invoke-SsamIdentityRedirects($context,[Uri]$start,[scriptblock]$stop){
 $next=$start
 for($hop=0;$hop -lt 8;$hop++){
  if(& $stop $next){return $next}
  $next=Resolve-SsamAuthUri $context $next.AbsoluteUri
  if($next.Host -cne 'id.outsystems.com'){Stop-SsamAuth 'CREDENTIAL_AUTH_ORIGIN_REFUSED'}
  $response=Invoke-SsamAuthHttp $context $next.AbsoluteUri
  if($response.status -notin @(302,303,307,308) -or -not $response.location){Stop-SsamAuth 'CREDENTIAL_AUTH_REDIRECT_INCOMPLETE'}
  $next=New-Object Uri($next,$response.location)
 }
 Stop-SsamAuth 'CREDENTIAL_AUTH_REDIRECT_LIMIT'
}
function Invoke-SsamCommunityIdentity($context,$credential){
 $id='https://id.outsystems.com';$client='client_runtime'
 $d=Invoke-SsamAuthJson $context "$id/identity/.well-known/openid-configuration"
 $issuer=Resolve-SsamAuthUri $context $d.issuer
 if($issuer.Host -cne 'id.outsystems.com' -or $issuer.AbsolutePath -cnotmatch '^/auth/realms/[a-f0-9-]{36}$' -or $issuer.Query){Stop-SsamAuth 'CREDENTIAL_AUTH_UNSUPPORTED'}
 foreach($pair in @(@('authorization_endpoint','auth'),@('token_endpoint','token'),@('jwks_uri','certs'))){$u=Resolve-SsamAuthUri $context $d.($pair[0]);if($u.Host -cne 'id.outsystems.com' -or $u.AbsolutePath -cne ($issuer.AbsolutePath+'/protocol/openid-connect/'+$pair[1]) -or $u.Query){Stop-SsamAuth 'CREDENTIAL_AUTH_UNSUPPORTED'}}
 $verifier=New-SsamNonce 32;$state=New-SsamNonce;$nonce=New-SsamNonce
 $sha=[Security.Cryptography.SHA256]::Create();try{$challenge=ConvertTo-SsamBase64Url ($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($verifier)))}finally{$sha.Dispose()}
 $start=Set-SsamQuery ([Uri]$d.authorization_endpoint) @{client_id=$client;scope='openid';redirect_uri="$id/identity";response_type='code';kc_idp_hint='os-builtin';code_challenge=$challenge;code_challenge_method='S256';state=$state;nonce=$nonce}
 $landing=Invoke-SsamIdentityRedirects $context $start {param($u) $u.GetLeftPart([UriPartial]::Authority) -ceq 'https://os-community-id.outsystems.app' -and $u.AbsolutePath -ceq '/identity' -and (Get-SsamQuery $u)['redirect_uri']}
 $landingQuery=Get-SsamQuery $landing;$resume=Resolve-SsamAuthUri $context $landingQuery['redirect_uri']
 if($resume.Host -cne 'id.outsystems.com' -or $resume.AbsolutePath -cne ($issuer.AbsolutePath+'/broker/os-builtin/endpoint') -or -not $landingQuery['state']){Stop-SsamAuth 'CREDENTIAL_AUTH_STATE_INVALID'}
 $config=Invoke-SsamAuthJson $context "$id/community/moduleservices/auth/configs"
 $providers=@($config.authConfigurations|Where-Object{$_.type -ceq 'cognito' -and $_.kc_hint -ceq 'os-builtin'})
 if($providers.Count -ne 1){Stop-SsamAuth 'CREDENTIAL_AUTH_UNSUPPORTED'};$provider=$providers[0].configs
 if($provider.authFlow -cne 'USER_PASSWORD_AUTH' -or $provider.region -cne 'us-east-1' -or $provider.poolId -cnotmatch '^us-east-1_[A-Za-z0-9]+$' -or $provider.amplifyClientId -cnotmatch '^[a-z0-9]{10,128}$'){Stop-SsamAuth 'CREDENTIAL_AUTH_UNSUPPORTED'}
 $cognito=Invoke-SsamAuthJson $context 'https://cognito-idp.us-east-1.amazonaws.com/' 'POST' @{AuthFlow='USER_PASSWORD_AUTH';ClientId=$provider.amplifyClientId;AuthParameters=@{USERNAME=$credential.UserName;PASSWORD=$credential.Secret}} @{'X-Amz-Target'='AWSCognitoIdentityProviderService.InitiateAuth'} 'application/x-amz-json-1.1'
 if($cognito.ChallengeName){Stop-SsamAuth 'CREDENTIAL_AUTH_INTERACTIVE_REQUIRED'};$ct=$cognito.AuthenticationResult
 foreach($name in @('AccessToken','IdToken','RefreshToken')){if($ct.$name -isnot [string] -or $ct.$name.Length -lt 10 -or $ct.$name.Length -gt 20000 -or $ct.$name -match '[\r\n]'){Stop-SsamAuth 'CREDENTIAL_IDENTITY_TOKEN_INVALID'};$context.Secrets.Add($ct.$name)}
 $stored=Invoke-SsamAuthJson $context "$id/identityapi/v1alpha1/oidc/store-token" 'POST' @{clientId=$provider.amplifyClientId;idToken=$ct.IdToken;accessToken=$ct.AccessToken;refreshToken=$ct.RefreshToken}
 if($stored.authCode -isnot [string] -or -not $stored.authCode){Stop-SsamAuth 'CREDENTIAL_AUTH_RESPONSE_INVALID'};$context.Secrets.Add($stored.authCode)
 $resumeQuery=Get-SsamQuery $resume;$resumeFields=@{};foreach($key in $resumeQuery.AllKeys){$resumeFields[$key]=$resumeQuery[$key]};$resumeFields.code=$stored.authCode;$resumeFields.state=$landingQuery['state'];$resume=Set-SsamQuery $resume $resumeFields
 $callback=Invoke-SsamIdentityRedirects $context $resume {param($u) $u.GetLeftPart([UriPartial]::Authority) -ceq 'https://id.outsystems.com' -and $u.AbsolutePath -ceq '/identity' -and ((Get-SsamQuery $u)['code'] -or (Get-SsamQuery $u)['error'])}
 $query=Get-SsamQuery $callback
 if($query['state'] -cne $state -or $query['error'] -or -not $query['code'] -or ($query['iss'] -and $query['iss'] -cne $d.issuer)){Stop-SsamAuth 'CREDENTIAL_AUTH_STATE_INVALID'};$context.Secrets.Add($query['code'])
 $tokens=Invoke-SsamAuthJson $context $d.token_endpoint 'POST' (ConvertTo-SsamForm @{grant_type='authorization_code';code=$query['code'];client_id=$client;redirect_uri="$id/identity";code_verifier=$verifier}) @{} 'application/x-www-form-urlencoded'
 if($tokens.token_type -ine 'bearer' -or $tokens.refresh_token -isnot [string] -or -not $tokens.refresh_token){Stop-SsamAuth 'CREDENTIAL_IDENTITY_TOKEN_INVALID'}
 foreach($name in @('access_token','id_token','refresh_token')){$context.Secrets.Add($tokens.$name)}
 $jwks=Invoke-SsamAuthJson $context $d.jwks_uri
 $identity=Read-SsamIdentityJwt $tokens.id_token $jwks $d.issuer $client $nonce
 $access=Read-SsamIdentityJwt $tokens.access_token $jwks $d.issuer '' '' $identity.sub
 if($access.azp -cne $client){Stop-SsamAuth 'CREDENTIAL_IDENTITY_TOKEN_INVALID'}
 $headers=@{Authorization=('Bearer '+$tokens.access_token)}
 $profile=Invoke-SsamAuthJson $context "$id/api/user-information/v1/profiles/me?embed=UserIdentityProviders" 'GET' $null $headers
 if(-not $profile.id -or -not [string]::Equals(([string]$profile.email).Trim(),$credential.UserName.Trim(),[StringComparison]::OrdinalIgnoreCase)){Stop-SsamAuth 'CREDENTIAL_AUTH_PRINCIPAL_MISMATCH'}
 $claims=Invoke-SsamAuthJson $context "$id/api/user-information/v1/claims" 'GET' $null $headers
 if(@($claims.claims) -cnotcontains 'c089d722-19c8-4ed6-a329-cf2e78c54b56.ab2a6b39-1f30-4f20-a069-cf5d18b076f4'){Stop-SsamAuth 'CREDENTIAL_AUTH_ROLE_REQUIRED'}
 $sync=Invoke-SsamAuthHttp $context "$id/community/moduleservices/users/userinfosync" 'POST' $null $headers
 if($sync.status -notin @(200,204)){Stop-SsamAuth 'CREDENTIAL_LOGIN_FAILED'}
 return @{tokens=$tokens;endpoints=$d}
}
function Get-SsamCommunityCallback($context,[Uri]$login,$credential,[switch]$serviceCenter){
 $id='https://id.outsystems.com';$login=Resolve-SsamAuthUri $context $login.AbsoluteUri
 if($login.Host -cne 'id.outsystems.com' -or $login.AbsolutePath -cne '/community/login'){Stop-SsamAuth 'CREDENTIAL_AUTH_UNSUPPORTED'}
 $query=Get-SsamQuery $login;$vars=@{}
 foreach($key in @('response_type','client_id','scope','code_challenge','code_challenge_method','redirect_uri','state','nonce','login_hint')){$vars[$key]=[string]$query[$key]}
 $callback=Resolve-SsamAuthUri $context $vars.redirect_uri
 if($callback.Host -cne $context.Host -or $callback.Query -or $vars.response_type -cne 'code' -or $vars.code_challenge_method -cne 'S256' -or $vars.code_challenge -cnotmatch '^[A-Za-z0-9_-]{43}$' -or -not $vars.state -or -not $vars.client_id -or @($vars.scope.Split(' ')) -cnotcontains 'openid'){Stop-SsamAuth 'CREDENTIAL_AUTH_STATE_INVALID'}
 if($serviceCenter -and $callback.AbsolutePath -cne '/ServiceCenter/CentralizedLogin_AuthCodeFlow_TokenPart.aspx'){Stop-SsamAuth 'CREDENTIAL_AUTH_STATE_INVALID'}
 $identity=Invoke-SsamCommunityIdentity $context $credential
 $answer=Invoke-SsamScreenAction $context $id 'community' 'Auth.login' 'community/Auth/login/DataActionGetSessionData' @{} $vars $identity.tokens.access_token
 $session=$answer.data
 if($session.HasSession -ne $true -or $session.IsAuthorizedRedirect_Uri -ne $true){Stop-SsamAuth 'CREDENTIAL_LOGIN_FAILED'}
 if($session.NeedsToAcceptTerms -ne $false){Stop-SsamAuth 'CREDENTIAL_AUTH_INTERACTIVE_REQUIRED'}
 if($session.AuthEndpointKC -cne $identity.endpoints.authorization_endpoint -or $session.AuthRedirectUriKC -cne "$id/community/rest/redirect/login"){Stop-SsamAuth 'CREDENTIAL_AUTH_CONTRACT_CHANGED'}
 $fields=@{};foreach($key in $vars.Keys){$fields[$key]=$vars[$key]};$fields.redirect_uri=$session.AuthRedirectUriKC;$fields.prompt='none'
 $next=Set-SsamQuery ([Uri]$session.AuthEndpointKC) $fields
 for($hop=0;$hop -lt 8;$hop++){
  $next=Resolve-SsamAuthUri $context $next.AbsoluteUri
  if($next.Host -ceq $context.Host){
   $q=Get-SsamQuery $next
   if($next.AbsolutePath -cne $callback.AbsolutePath -or $q['state'] -cne $vars.state -or -not $q['code'] -or $q['error']){Stop-SsamAuth 'CREDENTIAL_AUTH_STATE_INVALID'}
   $context.Secrets.Add($q['code']);return $next
  }
  if($next.Host -cne 'id.outsystems.com' -or $next.AbsolutePath -cnotin @(([Uri]$identity.endpoints.authorization_endpoint).AbsolutePath,'/community/rest/redirect/login')){Stop-SsamAuth 'CREDENTIAL_AUTH_INTERACTIVE_REQUIRED'}
  $r=Invoke-SsamAuthHttp $context $next.AbsoluteUri
  if($r.status -notin @(302,303) -or -not $r.location){Stop-SsamAuth 'CREDENTIAL_AUTH_INTERACTIVE_REQUIRED'}
  $next=New-Object Uri($next,$r.location)
 }
 Stop-SsamAuth 'CREDENTIAL_AUTH_REDIRECT_LIMIT'
}
function Invoke-SsamServiceCenterLogin($context,$credential){
 $start=[Uri]("https://"+$context.Host+'/ServiceCenter/Login.aspx');$r=Invoke-SsamAuthHttp $context $start.AbsoluteUri
 $usedPassword=$false
 if($r.status -eq 200 -and -not (Test-SsamProtectedSc $r.text)){
  $nodes=Read-SsamLoginHtml $r.text;$hasPassword=@($nodes|Where-Object{$_.Tag -eq 'input' -and $_.Attrs.type -eq 'password'}).Count -gt 0
  $plan=Get-SsamLoginPlan $r.text $start -sso:(-not $hasPassword)
  if($hasPassword){$plan.fields[$plan.user]=$credential.UserName;$plan.fields[$plan.password]=$credential.Secret;$usedPassword=$true}
  $r=Invoke-SsamAuthHttp $context $plan.url.AbsoluteUri 'POST' (ConvertTo-SsamForm $plan.fields) @{} 'application/x-www-form-urlencoded'
  $plan=$null
 }
 if($r.status -in @(302,303) -and $r.location){
  $next=Resolve-SsamAuthUri $context $r.location $start.AbsoluteUri
  if($next.Host -ceq 'id.outsystems.com'){
   # No automatic retry of a submitted password through a second provider.
   if($usedPassword){Stop-SsamAuth 'CREDENTIAL_AUTH_UNSUPPORTED'}
   $next=Get-SsamCommunityCallback $context $next $credential -serviceCenter
  }
  for($hop=0;$hop -lt 8;$hop++){
   $next=Resolve-SsamAuthUri $context $next.AbsoluteUri
   if($next.Host -cne $context.Host -or -not $next.AbsolutePath.StartsWith('/ServiceCenter/')){Stop-SsamAuth 'CREDENTIAL_AUTH_ORIGIN_REFUSED'}
   $r=Invoke-SsamAuthHttp $context $next.AbsoluteUri
   if($r.status -notin @(302,303) -or -not $r.location){break};$next=New-Object Uri($next,$r.location)
  }
 }
 $proof=Invoke-SsamAuthHttp $context ("https://"+$context.Host+'/ServiceCenter/Error_Logs.aspx')
 if($proof.status -ne 200 -or -not (Test-SsamProtectedSc $proof.text)){Stop-SsamAuth 'CREDENTIAL_LOGIN_FAILED'}
 return $true
}
function Invoke-SsamPortalLogin($context,$credential){
 $origin='https://'+$context.Host
 $providers=Invoke-SsamScreenAction $context $origin 'authentication' 'UnifiedAuthentication.login' 'authentication/UnifiedAuthentication/login/DataActionGetProviders'
 # SRP and legacy id.outsystems.dev require their own proven adapters. Never
 # downgrade SRP to USER_PASSWORD_AUTH or send a credential to a guessed host.
 if($providers.data.CognitoEnabled -eq $true -and $providers.data.CognitoConfig.AuthFlow -ceq 'USER_SRP_AUTH'){Stop-SsamAuth 'CREDENTIAL_AUTH_UNSUPPORTED'}
 $redirect=if($providers.data.RedirectNowUrl){$providers.data.RedirectNowUrl}else{$providers.data.AuthUrlExternalProvider}
 if(-not $redirect){Stop-SsamAuth 'CREDENTIAL_AUTH_UNSUPPORTED'}
 $next=Resolve-SsamAuthUri $context $redirect $origin
 $login=$null
 for($hop=0;$hop -lt 10;$hop++){
  $next=Resolve-SsamAuthUri $context $next.AbsoluteUri
  if($next.Host -ceq 'id.outsystems.com' -and $next.AbsolutePath -ceq '/community/login'){$login=$next;break}
  $r=Invoke-SsamAuthHttp $context $next.AbsoluteUri
  if($r.status -notin @(302,303,307,308) -or -not $r.location){Stop-SsamAuth 'CREDENTIAL_AUTH_UNSUPPORTED'}
  $next=New-Object Uri($next,$r.location)
 }
 if(-not $login){Stop-SsamAuth 'CREDENTIAL_AUTH_REDIRECT_LIMIT'}
 $next=Get-SsamCommunityCallback $context $login $credential
 $complete=$null
 for($hop=0;$hop -lt 10;$hop++){
  $next=Resolve-SsamAuthUri $context $next.AbsoluteUri
  if($next.Host -cne $context.Host){Stop-SsamAuth 'CREDENTIAL_AUTH_ORIGIN_REFUSED'}
  $q=Get-SsamQuery $next
  if($next.AbsolutePath.StartsWith('/authentication/redirect') -and $q['code']){$complete=$next;break}
  $r=Invoke-SsamAuthHttp $context $next.AbsoluteUri
  if($r.status -notin @(302,303,307,308) -or -not $r.location){Stop-SsamAuth 'CREDENTIAL_LOGIN_FAILED'}
  $next=New-Object Uri($next,$r.location)
 }
 if(-not $complete){Stop-SsamAuth 'CREDENTIAL_AUTH_REDIRECT_LIMIT'}
 $q=Get-SsamQuery $complete;$context.Secrets.Add($q['code'])
 $null=Invoke-SsamScreenAction $context $origin 'authentication' 'UnifiedAuthentication.redirect' 'authentication/UnifiedAuthentication/redirect/ActionProcessCodeRedirect' @{Code=$q['code'];State=[string]$q['state'];IsFirstLogin=$false;IsRest=$false;BId=''}
 $proof=Invoke-SsamScreenAction $context $origin 'connections' 'Connections.connections' 'connections/Connections/connections/DataActionGetProviders'
 if($proof.data.Providers -isnot [array] -and $proof.data.Providers.List -isnot [array]){Stop-SsamAuth 'CREDENTIAL_AUTH_CONTRACT_CHANGED'}
 return $true
}
function Invoke-SsamCredentialLogin($request,$credential,$jar){
 $context=@{Host=[string]$request.host;Jar=$jar;Visited=@{};Secrets=(New-Object 'Collections.Generic.List[string]');Clock=[Diagnostics.Stopwatch]::StartNew()}
 if(-not $context.Host){$context.Host=$HostName}
 try{
  if(-not $credential.UserName -or -not $credential.Secret){Stop-SsamAuth 'CREDENTIAL_NOT_FOUND'}
  $context.Secrets.Add($credential.Secret)
  if($request.service -ceq 'service-center'){$null=Invoke-SsamServiceCenterLogin $context $credential}
  elseif($request.service -ceq 'odc-portal'){$null=Invoke-SsamPortalLogin $context $credential}
  else{Stop-SsamAuth 'CREDENTIAL_AUTH_UNSUPPORTED'}
  $cookies=@{}
  foreach($uri in $context.Visited.Values){if($uri.Host -cne $context.Host){continue};foreach($cookie in $jar.GetCookies($uri)){
   if($cookie.Expired){continue};$context.Secrets.Add($cookie.Value);$key=$cookie.Name+'|'+$cookie.Path;$cookies[$key]=@{name=$cookie.Name;value=$cookie.Value;path=$cookie.Path;secure=$cookie.Secure;httpOnly=$cookie.HttpOnly;expiresAt=$(if($cookie.Expires -ne [DateTime]::MinValue){([DateTimeOffset]$cookie.Expires.ToUniversalTime()).ToUnixTimeMilliseconds()}else{$null})}
  }}
  if(-not $cookies.Count){Stop-SsamAuth 'CREDENTIAL_LOGIN_FAILED'}
  return @{ok=$true;authenticated=$true;cookies=@($cookies.Values);token=$null;expiresAt=[DateTimeOffset]::UtcNow.AddHours(8).ToUnixTimeMilliseconds();secretValues=@($context.Secrets)}
 }catch{
  $e=$_.Exception;while($e -and -not $e.Data['code'] -and $e.InnerException){$e=$e.InnerException}
  $code=if($e.Data['code']){[string]$e.Data['code']}else{'CREDENTIAL_LOGIN_FAILED'}
  return @{ok=$false;authenticated=$false;code=$code}
 }finally{$context.Clock.Stop()}
}
function Get-SsamPortalCsrf($jar,[Uri]$uri){
 $cookies=@($jar.GetCookies($uri))
 $direct=@($cookies|Where-Object{$_.Name -ceq 'crf'})
 if($direct.Count -eq 1 -and $direct[0].Value -and $direct[0].Value.Length -le 4096 -and $direct[0].Value -notmatch '[\x00-\x20\x7f;]'){return $direct[0].Value}
 foreach($cookie in $cookies){
  if($cookie.Name -cnotmatch '^nr2[^=]*$'){continue}
  $m=[regex]::Match([Uri]::UnescapeDataString($cookie.Value),'(?:^|;)crf=([^;]*)')
  if($m.Success -and $m.Groups[1].Value.Length -gt 0 -and $m.Groups[1].Value.Length -le 4096 -and $m.Groups[1].Value -notmatch '[\x00-\x20\x7f;]'){return $m.Groups[1].Value}
 }
 return ''
}
