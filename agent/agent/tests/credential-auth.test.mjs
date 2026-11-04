import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const library = fileURLToPath(new URL('../lib/', import.meta.url));
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const expected = new Map([
  ['service-center/direct', null], ['service-center/sso', null], ['odc-portal/sso', null],
  ['service-center/bad-nonce', 'CREDENTIAL_IDENTITY_TOKEN_INVALID'],
  ...['bad-issuer', 'bad-audience', 'future-iat', 'boolean-iat', 'null-nbf', 'bad-subject', 'bad-azp'].map(name => ['service-center/' + name, 'CREDENTIAL_IDENTITY_TOKEN_INVALID']),
  ['service-center/expired', 'CREDENTIAL_IDENTITY_TOKEN_INVALID'],
  ['service-center/bad-signature', 'CREDENTIAL_IDENTITY_TOKEN_INVALID'],
  ['service-center/wrong-principal', 'CREDENTIAL_AUTH_PRINCIPAL_MISMATCH'],
  ['service-center/missing-role', 'CREDENTIAL_AUTH_ROLE_REQUIRED'],
  ['service-center/terms', 'CREDENTIAL_AUTH_INTERACTIVE_REQUIRED'],
  ['service-center/challenge', 'CREDENTIAL_AUTH_INTERACTIVE_REQUIRED'],
  ['service-center/bad-callback-state', 'CREDENTIAL_AUTH_STATE_INVALID'],
  ['service-center/no-protected-read', 'CREDENTIAL_LOGIN_FAILED'],
]);
let results;
if (process.platform === 'win32') {
  const out = execFileSync(ps, ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./fixtures/credential-auth-flow.ps1', import.meta.url)), '-Library', library], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  for (const secret of ['Fixture-password', 'Fixture-cookie', 'Fixture-portal-cookie', 'Fixture-refresh-token', 'Fixture-cognito-access']) assert.ok(!out.includes(secret), 'fixture reports metadata only');
  results = new Map(JSON.parse(out.trim()).map(result => [result.case, result]));
}
for (const [name, code] of expected) test('private authentication: ' + name, { skip: process.platform !== 'win32' }, () => {
  const result = results.get(name); assert.ok(result);
  assert.equal(result.ok, code === null); assert.equal(result.code, code); assert.equal(result.secretsPrivate, true);
  if (code === null) { assert.equal(result.authenticated, true); assert.equal(result.cookieCount, 1); }
  else { assert.equal(result.authenticated, false); assert.equal(result.cookieCount, 0); }
  if (name === 'service-center/sso' || name === 'service-center/direct') { assert.equal(result.protectedRead, true); assert.equal(result.cookiePath, '/ServiceCenter/'); }
  if (name === 'service-center/challenge') assert.equal(result.steps, 5, 'challenge stops before token exchange or callback');
  if (name === 'service-center/terms') assert.equal(result.steps, 17, 'terms are not accepted');
});

test('private authentication rejects foreign origins and malformed callbacks; query encoding stays intact', { skip: process.platform !== 'win32' }, () => {
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';. '${path.join(library, 'credential-auth.ps1')}'
$context=@{Host='tenant.example.test'}
$cases=@('https://foreign.example.test/','http://tenant.example.test/','https://user@tenant.example.test/','https://tenant.example.test/a#fragment','https://tenant.example.test/a%2fsecret','https://tenant.example.test/a?callback=https%3A%2F%2Fid.outsystems.com%2Fidentity')
$result=@(foreach($value in $cases){try{$null=Resolve-SsamAuthUri $context $value;$true}catch{$false}})
$addresses=@('127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','::1','::ffff:127.0.0.1','64:ff9b::7f00:1','2002:7f00:1::','93.184.216.34')
@{origins=$result;addresses=@(foreach($value in $addresses){Test-SsamPublicAddress ([Net.IPAddress]::Parse($value))})}|ConvertTo-Json -Compress`;
  const out = execFileSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const result = JSON.parse(out.trim()); assert.deepEqual(result.origins, [false, false, false, false, false, true]);
  assert.deepEqual(result.addresses, [false, false, false, false, false, false, false, false, true]);
});
