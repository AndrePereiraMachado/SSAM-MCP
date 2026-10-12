// The Windows vault path of the Service Center tools, isolated: the only place that touches Credential Manager.
// Node has no FFI, and the credential must not enter this process. So both operations run in a short-lived Windows
// PowerShell (powershell.exe -EncodedCommand, the request on stdin, a JSON answer on stdout):
//   present(target)  CredReadW status only: whether the entry exists with a nonempty blob (never decoded);
//   login(form)      CredReadW of SSAM/O11/<host>/ServiceCenter (or ServiceStudio), then the login POST itself: the
//                    page's form state comes from here, PowerShell appends the user and password fields, sends the
//                    request without following redirects and answers status, Location, Set-Cookie and the body with
//                    every echo of the password replaced. The password never exists in a Node string.
// The Studio path (no secret at all) stays the first and main one; this runs only without a connected Studio.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { ProtocolError } from './errors.mjs';
import { hostName } from './http.mjs';

const TARGET = /^SSAM\/O11\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/(?:ServiceCenter(?:\/Profiles\/[a-f0-9]{64}\/[a-f0-9-]{36})?|ServiceStudio|LifeTime|(?:DatabaseConnection|SiteProperty)\/[A-Za-z0-9_.-]{1,100})$/;
const LOGIN_TARGET = /^SSAM\/O11\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/(?:ServiceCenter(?:\/Profiles\/[a-f0-9]{64}\/[a-f0-9-]{36})?|ServiceStudio)$/;

export const powershellPath = (env = process.env) => path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// The credential fragments: SETUP declares CredReadW once per process; READ reads $target into $found/$size/$user and,
// only when $wantSecret, $secret. Tests replace both (no Credential Manager is ever read by a test).
export const CREDENTIAL_SETUP_PS = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SsamO11VaultRead {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Credential {
  public uint Flags, Type; public string TargetName, Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist, AttributeCount; public IntPtr Attributes; public string TargetAlias, UserName;
 }
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target, uint type, uint flags, out IntPtr value);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr value);
}
'@
`;
export const CREDENTIAL_READ_PS = String.raw`
$found = $false; $size = 0; $user = $null; $secret = $null
$native = [IntPtr]::Zero
if ([SsamO11VaultRead]::Read([string]$target, 1, 0, [ref]$native)) {
 try {
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($native, [type][SsamO11VaultRead+Credential])
  $found = $true; $size = [int]$c.CredentialBlobSize; $user = $c.UserName
  if ($wantSecret -and $size -gt 0 -and ($size % 2) -eq 0) { $secret = [Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, [int]($size / 2)) }
 } finally { [SsamO11VaultRead]::CredFree($native) }
}
`;

const PROLOGUE = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
function B64([string]$text) { if ($null -eq $text) { return '' } [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) }
`;

const PRESENT_PS = String.raw`
$wantSecret = $false
<SETUP>
$answers = @(foreach ($target in @($request.targets)) {
<READ>
 [bool]($found -and $size -gt 0)
})
@{ ok = $true; available = $answers } | ConvertTo-Json -Compress
`;

const LOGIN_PS = String.raw`
$wantSecret = $true
<SETUP>
$target = [string]$request.target
<READ>
if (-not $found) { @{ ok = $false; code = 'VAULT_UNAVAILABLE' } | ConvertTo-Json -Compress; exit 0 }
if ($size -eq 0 -or ($size % 2) -ne 0 -or -not $user -or $null -eq $secret) { @{ ok = $false; code = 'VAULT_INCOMPLETE' } | ConvertTo-Json -Compress; exit 0 }
function Form([string]$text) {
 # urllib.parse.quote_plus, as the Python adapter posted: UTF-8 bytes, A-Z a-z 0-9 _ . - ~ kept, space as +.
 $out = New-Object Text.StringBuilder
 foreach ($b in [Text.Encoding]::UTF8.GetBytes($text)) {
  if (($b -ge 48 -and $b -le 57) -or ($b -ge 65 -and $b -le 90) -or ($b -ge 97 -and $b -le 122) -or $b -eq 45 -or $b -eq 46 -or $b -eq 95 -or $b -eq 126) { [void]$out.Append([char]$b) }
  elseif ($b -eq 32) { [void]$out.Append('+') } else { [void]$out.Append('%' + $b.ToString('X2')) }
 }
 $out.ToString()
}
try {
 $body = [string]$request.body
 if ($body) { $body += '&' }
 $body += (Form $request.userField) + '=' + (Form $user) + '&' + (Form $request.passwordField) + '=' + (Form $secret)
 [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
 $web = [Net.HttpWebRequest]::Create([string]$request.url)
 $web.Method = 'POST'; $web.AllowAutoRedirect = $false; $web.KeepAlive = $false
 $web.UserAgent = 'SSAM-Hybrid-O11/1'; $web.Accept = 'text/html'; $web.ContentType = 'application/x-www-form-urlencoded'
 $web.Timeout = [int]$request.timeoutMs; $web.ReadWriteTimeout = [int]$request.timeoutMs
 # A cookie container both sends this host's cookies and parses the answer's Set-Cookie (Headers.GetValues would split
 # an Expires date at its comma).
 $jar = New-Object Net.CookieContainer
 if ($request.cookie) { $jar.SetCookies([Uri][string]$request.url, ([string]$request.cookie).Replace('; ', ', ')) }
 $web.CookieContainer = $jar
 $bytes = [Text.Encoding]::UTF8.GetBytes($body)
 $body = $null
 $web.ContentLength = $bytes.Length
 $stream = $web.GetRequestStream(); $stream.Write($bytes, 0, $bytes.Length); $stream.Close()
 [Array]::Clear($bytes, 0, $bytes.Length)
 try { $response = $web.GetResponse() } catch [Net.WebException] { $response = $_.Exception.Response; if ($null -eq $response) { throw } }
 $limit = [int]$request.limit + 1
 $reader = $response.GetResponseStream(); $buffer = New-Object byte[] 65536; $memory = New-Object IO.MemoryStream
 while ($memory.Length -lt $limit) { $read = $reader.Read($buffer, 0, $buffer.Length); if ($read -le 0) { break }; $memory.Write($buffer, 0, $read) }
 $reader.Close()
 $encoding = [Text.Encoding]::UTF8
 if ($response.CharacterSet) { try { $encoding = [Text.Encoding]::GetEncoding($response.CharacterSet) } catch { } }
 $text = $encoding.GetString($memory.ToArray())
 if ($secret.Length -ge 4) {
  $plus = Form $secret
  foreach ($echo in @($secret, [Net.WebUtility]::HtmlEncode($secret), [Uri]::EscapeDataString($secret), $plus, $plus.Replace('+', '%20'))) { if ($echo) { $text = $text.Replace($echo, '<redacted>') } }
 }
 $cookies = @($response.Cookies | ForEach-Object {
  $expires = if ($_.Expires -ne [DateTime]::MinValue) { '; expires=' + $_.Expires.ToUniversalTime().ToString('R') } else { '' }
  B64 ('{0}={1}; path={2}{3}' -f $_.Name, $_.Value, $_.Path, $expires) })
 @{ ok = $true; status = [int]$response.StatusCode; location = (B64 $response.Headers['Location']); contentType = (B64 $response.ContentType);
    setCookie = $cookies; body = (B64 $text) } | ConvertTo-Json -Compress
 $response.Close()
} catch {
 @{ ok = $false; code = 'VAULT_LOGIN_FAILED' } | ConvertTo-Json -Compress
} finally { $secret = $null; $user = $null }
`;

// One PowerShell run: the script as -EncodedCommand, the request as base64 JSON on stdin, one JSON line back.
export function createPowerShellRunner({ env = process.env, execFileFn = execFile, timeoutMs = 120000 } = {}) {
  return (script, request) => new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = execFileFn(powershellPath(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, env }, (error, stdout) => {
        const line = String(stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1);
        try { if (!line) throw error ?? new Error('no answer'); resolve(JSON.parse(line)); }
        catch { reject(new ProtocolError('The Windows vault could not be read; no credential was used')); }
      });
    child.stdin?.end(Buffer.from(JSON.stringify(request), 'utf8').toString('base64'));
  });
}

const fromB64 = text => Buffer.from(String(text ?? ''), 'base64').toString('utf8');
export const CREDENTIAL = { setup: CREDENTIAL_SETUP_PS, read: CREDENTIAL_READ_PS };
export const SCRIPTS = { present: PRESENT_PS, login: LOGIN_PS };
const script = (body, credential) => PROLOGUE + body.replace('<SETUP>', () => credential.setup).replace('<READ>', () => credential.read);

// Status only: the blob is never decoded. A list of targets is answered by one PowerShell run, in order.
export async function vaultPresent(targets, { run = createPowerShellRunner(), credential = CREDENTIAL } = {}) {
  const list = Array.isArray(targets) ? targets : [targets];
  if (!list.length || list.some(t => !TARGET.test(t))) throw new ProtocolError('Unknown vault entry name');
  const answer = await run(script(PRESENT_PS, credential), { targets: list });
  const available = list.map((t, i) => answer?.ok === true && [answer.available].flat()[i] === true);
  return Array.isArray(targets) ? available : available[0];
}

// The login POST of the vault path. Returns what Transport.fetch reads from one exchange: {status, location,
// contentType, setCookie[], body (UTF-8, password echoes replaced), charset}.
export async function vaultLogin(target, { url, body, userField, passwordField, cookie, timeoutMs = 30000, limit },
  { run = createPowerShellRunner(), credential = CREDENTIAL } = {}) {
  if (!LOGIN_TARGET.test(target)) throw new ProtocolError('Credential target must match this O11 host and ServiceCenter or ServiceStudio');
  const answer = await run(script(LOGIN_PS, credential), { target, url, body: body ?? '', userField, passwordField, cookie: cookie || '', timeoutMs, limit });
  if (answer?.code === 'VAULT_UNAVAILABLE') throw new ProtocolError('Credential unavailable in Windows Credential Manager');
  if (answer?.code === 'VAULT_INCOMPLETE') throw new ProtocolError('Stored credential is incomplete');
  if (answer?.ok !== true || !Number.isInteger(answer.status)) throw new ProtocolError('Service Center connection failed; no automatic retry');
  return { status: answer.status, location: fromB64(answer.location), contentType: fromB64(answer.contentType),
    setCookie: (answer.setCookie ?? []).map(fromB64), body: Buffer.from(fromB64(answer.body), 'utf8'), charset: 'utf-8' };
}

// The vault of one O11 host (http.py Vault): its Service Center login target, status of any same-host entry, and the
// login that posts the credential without handing it over.
export function createVault(host, target = null, { present = t => vaultPresent(t), run = null, credential = CREDENTIAL } = {}) {
  const name = hostName(host);
  const login = target || `SSAM/O11/${name}/ServiceCenter`;
  if (!LOGIN_TARGET.test(login) || !login.startsWith(`SSAM/O11/${name}/`))
    throw new ProtocolError('Credential target must match this O11 host and ServiceCenter or ServiceStudio');
  return {
    host: name, target: login,
    present: t => present(t),
    exists() { return present(login); },
    // Database connection logins and secret site property values are never read here: only their target names
    // travel, as sc_web secretRefs, and the Studio reads them inside its own process right before the send.
    secretTarget(kind, entry) {
      if (!['DatabaseConnection', 'SiteProperty'].includes(kind) || !/^[A-Za-z0-9_.-]{1,100}$/.test(entry ?? ''))
        throw new ProtocolError(`${kind} vault entries are named by a plain identifier`);
      return `SSAM/O11/${name}/${kind}/${entry}`;
    },
    login: form => vaultLogin(login, form, { ...(run ? { run } : {}), credential }),
  };
}
