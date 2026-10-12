// Private authentication step for the observed OutSystems ID community provider.
// Passwords remain in the short-lived Credential Manager process. Token results
// are for the in-memory SSO broker only: never return them from an MCP tool.
import { CREDENTIAL, createPowerShellRunner } from './vault.mjs';
import { AuthRequired, ProtocolError } from './errors.mjs';
import { readOptions } from '../read-budget.mjs';

const PROFILE = /^SSAM\/O11\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/ServiceCenter(?:\/Profiles\/[a-f0-9]{64}\/[a-f0-9-]{36})?$/;

export const IDENTITY_CONFIG_PS = String.raw`
$metadata = [Net.HttpWebRequest]::Create('https://id.outsystems.com/community/moduleservices/auth/configs')
$metadata.Method = 'GET'; $metadata.AllowAutoRedirect = $false; $metadata.Timeout = 10000; $metadata.ReadWriteTimeout = 10000
$response = $metadata.GetResponse()
try {
 if ([int]$response.StatusCode -ne 200) { throw 'provider' }
 $config = ReadBounded $response | ConvertFrom-Json
} finally { $response.Close() }
`;

export const IDENTITY_SEND_PS = String.raw`
$web = [Net.HttpWebRequest]::Create('https://cognito-idp.us-east-1.amazonaws.com/')
$web.Method = 'POST'; $web.AllowAutoRedirect = $false; $web.KeepAlive = $false
$web.Timeout = 15000; $web.ReadWriteTimeout = 15000
$web.ContentType = 'application/x-amz-json-1.1'
$web.Headers['X-Amz-Target'] = 'AWSCognitoIdentityProviderService.InitiateAuth'
$payload = @{ AuthFlow = 'USER_PASSWORD_AUTH'; ClientId = $provider.configs.amplifyClientId; AuthParameters = @{ USERNAME = $user; PASSWORD = $secret } } | ConvertTo-Json -Compress -Depth 5
$bytes = [Text.Encoding]::UTF8.GetBytes($payload); $payload = $null
try {
 $web.ContentLength = $bytes.Length
 $stream = $web.GetRequestStream()
 try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Close() }
} finally { [Array]::Clear($bytes, 0, $bytes.Length); $secret = $null }
try { $response = $web.GetResponse() }
catch [Net.WebException] { $response = $_.Exception.Response; if ($null -eq $response) { throw } }
try {
 if ([int]$response.StatusCode -ne 200) {
  $stage = if ([int]$response.StatusCode -in @(400,401,403)) { 'rejected' } else { 'unavailable' }
  throw 'identity http failure'
 }
 $stage = 'response'
 $identity = ReadBounded $response | ConvertFrom-Json
} finally { $response.Close() }
`;

export function identityScript({ credential = CREDENTIAL, config = IDENTITY_CONFIG_PS, send = IDENTITY_SEND_PS } = {}) {
  return String.raw`
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
function ReadBounded($response) {
 $stream = $response.GetResponseStream(); $memory = New-Object IO.MemoryStream; $buffer = New-Object byte[] 4096
 try {
  while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
   if ($memory.Length + $count -gt 65536) { throw 'oversize' }
   $memory.Write($buffer, 0, $count)
  }
  [Text.Encoding]::UTF8.GetString($memory.ToArray())
 } finally { $stream.Close(); $memory.Dispose() }
}
$stage = 'provider'; $secret = $null; $user = $null
$identityClock = [Diagnostics.Stopwatch]::StartNew()
try {
 [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
<CONFIG>
 $providers = @($config.authConfigurations | Where-Object { $_.type -ceq 'cognito' })
 if ($providers.Count -ne 1) { throw 'provider' }
 $provider = $providers[0]
 if ($provider.configs.region -cne 'us-east-1' -or $provider.configs.authFlow -cne 'USER_PASSWORD_AUTH' -or $provider.kc_hint -cne 'os-builtin' -or $provider.configs.poolId -cnotmatch '^us-east-1_[A-Za-z0-9]+$' -or $provider.configs.amplifyClientId -cnotmatch '^[a-z0-9]{10,128}$') { throw 'provider' }
 if ($request.expectedClientId -and $provider.configs.amplifyClientId -cne $request.expectedClientId) { throw 'provider changed' }
 $stage = 'credential'
<SETUP>
 $target = [string]$request.target; $wantSecret = $true
<READ>
 if (-not $found -or $size -le 0 -or ($size % 2) -ne 0 -or -not $secret -or -not $user) { throw 'credential' }
 if (-not [string]::Equals($user.Trim(), ([string]$request.principal).Trim(), [StringComparison]::OrdinalIgnoreCase)) { $stage = 'principal'; throw 'principal' }
 $stage = 'authentication'
<SEND>
 if ($identity.ChallengeName) { $stage = 'challenge'; throw 'challenge' }
 $tokens = $identity.AuthenticationResult
 foreach ($key in @('AccessToken','IdToken','RefreshToken')) {
  $value = $tokens.$key
  if ($value -isnot [string] -or $value.Length -lt 10 -or $value.Length -gt 20000 -or $value -match '[\r\n]') { $stage = 'response'; throw 'response' }
 }
 # Do not confirm/register a device or grant roles. Tokens stay in the private
 # broker's memory and still need validation and a protected SC read.
 @{ ok = $true; tokens = @{ AccessToken = $tokens.AccessToken; IdToken = $tokens.IdToken; RefreshToken = $tokens.RefreshToken } } | ConvertTo-Json -Compress -Depth 4
} catch {
 $codes = @{ provider='IDENTITY_PROVIDER_UNSUPPORTED'; credential='AUTH_REQUIRED'; principal='AUTH_PRINCIPAL_MISMATCH'; authentication='IDENTITY_LOGIN_UNCERTAIN'; rejected='IDENTITY_LOGIN_REJECTED'; unavailable='IDENTITY_PROVIDER_UNAVAILABLE'; challenge='IDENTITY_CHALLENGE_REQUIRED'; response='IDENTITY_RESPONSE_INVALID' }
 $code = $codes[$stage]
 $failure = $_.Exception
 while ($failure -and $failure -isnot [Net.WebException] -and $failure.InnerException) { $failure = $failure.InnerException }
 if ($failure -is [Net.WebException]) {
  $code = if ($failure.Status -eq [Net.WebExceptionStatus]::Timeout) { 'IDENTITY_TIMEOUT' } else { 'IDENTITY_PROVIDER_UNAVAILABLE' }
 }
 @{ ok = $false; code = $code; stage = $stage; elapsedMs = $identityClock.ElapsedMilliseconds } | ConvertTo-Json -Compress
} finally { $secret = $null; $user = $null; $tokens = $null; $identity = $null }
`.replace('<CONFIG>', () => config).replace('<SETUP>', () => credential.setup).replace('<READ>', () => credential.read).replace('<SEND>', () => send);
}

const CODES = new Set(['IDENTITY_PROVIDER_UNSUPPORTED', 'AUTH_REQUIRED', 'AUTH_PRINCIPAL_MISMATCH', 'IDENTITY_LOGIN_REJECTED', 'IDENTITY_LOGIN_UNCERTAIN', 'IDENTITY_TIMEOUT', 'IDENTITY_PROVIDER_UNAVAILABLE', 'IDENTITY_CHALLENGE_REQUIRED', 'IDENTITY_RESPONSE_INVALID']);
export async function vaultIdentityLogin(target, { host, principal, expectedClientId = null }, { run = null, script = identityScript() } = {}) {
  const match = PROFILE.exec(target ?? '');
  if (!match || match[1] !== host || typeof principal !== 'string' || !principal.trim() || principal.length > 256 || /[\r\n]/.test(principal))
    throw new ProtocolError('Identity authentication requires a same-host Service Center profile and its expected principal.');
  let answer;
  const budget = readOptions('authentication');
  run ??= createPowerShellRunner({ timeoutMs: Math.min(29000, budget.timeoutMs ?? 29000) });
  try { answer = await run(script, { target, principal, ...(expectedClientId ? { expectedClientId } : {}) }); }
  catch { throw new AuthRequired('IDENTITY_LOGIN_UNCERTAIN', 'Identity authentication did not return a result; no automatic retry was attempted.'); }
  if (answer?.ok !== true) {
    const code = CODES.has(answer?.code) ? answer.code : 'IDENTITY_RESPONSE_INVALID';
    const stage = ['provider', 'credential', 'principal', 'authentication', 'rejected', 'unavailable', 'challenge', 'response'].includes(answer?.stage) ? answer.stage : undefined;
    throw new AuthRequired(code, 'Private identity authentication did not complete. No challenge, role change, or password change was performed.',
      { auth: { ...(stage ? { identityStage: stage } : {}), ...(Number.isSafeInteger(answer?.elapsedMs) && answer.elapsedMs >= 0 ? { elapsedMs: answer.elapsedMs } : {}) } });
  }
  if (!['AccessToken', 'IdToken', 'RefreshToken'].every(k => typeof answer.tokens?.[k] === 'string' && answer.tokens[k].length >= 10 && answer.tokens[k].length <= 20000 && !/[\r\n]/.test(answer.tokens[k])))
    throw new AuthRequired('IDENTITY_RESPONSE_INVALID', 'Private identity authentication returned an incomplete session.');
  return Object.fromEntries(['AccessToken', 'IdToken', 'RefreshToken'].map(k => [k, answer.tokens[k]]));
}
