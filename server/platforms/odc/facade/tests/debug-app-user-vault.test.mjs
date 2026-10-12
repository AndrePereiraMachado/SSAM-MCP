import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { privateAppUserVault, prepareEndpointCredential, releaseEndpointCredential, endpointCredentialBinding, sameEndpointCredentialTarget,
  endpointProfileKey, forgetEndpointProfile, redactionSecretBinding } from '../debug-app-user.mjs';
import { validateEndpointCredentialDescriptor, privateEndpointCredentialValues, endpointCredentialRecordHeaders, basicAuthorizationForms,
  validateRedactionSecretDescriptor } from '../debug-app-user-worker.mjs';
import { releaseRedactionSecret } from '../debug-redaction-secret.mjs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const helper = fileURLToPath(new URL('../debug-app-user-vault.ps1', import.meta.url));
const source = fs.readFileSync(helper, 'utf8');
const isWindows = process.platform === 'win32';
const powershell = isWindows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
const sessionId = '0123456789abcdef0123456789abcdef';
const binding = { lane: 'odc', runtimeUrl: 'https://fixture-dev.outsystems.app/Fixture/', app: 'Fixture', sessionId, module: 'Producer', moduleKey: 'A'.repeat(22) };
// Every real-helper test in this file uses a private temporary debugger state root (SSAM_DEBUG_STATE_ROOT); the
// user's %USERPROFILE%\.ssam-hybrid\debugger and the legacy %LOCALAPPDATA%\SSAM copies are never written.
const stateBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-debug-state-'));
process.env.SSAM_DEBUG_STATE_ROOT = stateBase;
process.on('exit', () => { try { fs.rmSync(stateBase, { recursive: true, force: true }); } catch { } });

// Parse the real helper and load only its function definitions. No top-level
// dialog, native vault access, authentication, write or network call runs here.
const probeScript = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$probe = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tokens = $null
$errors = $null
$tree = [System.Management.Automation.Language.Parser]::ParseFile($probe.helper,[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { [Console]::Out.Write('{"ok":false,"syntax":false}'); exit 1 }
foreach ($definition in $tree.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}
$script:forgetFixture = $null
function Assert-PrivateFile($Path, $Sid) {
  if ($script:forgetFixture.aclFailure) { throw 'Fixture ACL rejected' }
}
function Read-PrivateCiphertext($Path) {
  if ($script:forgetFixture.readFailure) { throw 'Fixture read rejected' }
  return ,([byte[]]@(1,2,3))
}
function Unprotect-AppUserRecord($Bytes, $Entropy) {
  if ($script:forgetFixture.corrupt) { throw 'Fixture ciphertext is incomplete' }
  return ,([Text.Encoding]::UTF8.GetBytes(($script:forgetFixture.record | ConvertTo-Json -Depth 8 -Compress)))
}
$results = @()
foreach ($value in $probe.cases) {
  try {
    if ($null -ne $value.PSObject.Properties['forget']) {
      $script:forgetFixture = $value.forget
      $canonical = ConvertTo-Binding $value.binding
      $candidate = Get-ScopedForgetCandidate 'fixture-private-reference.tmp' 'fixture-sid' ([byte[]]@()) $canonical
      $results += @{ok=$true;corrupt=$candidate.corrupt;path=$candidate.path}
    } elseif ($null -ne $value.PSObject.Properties['reference']) {
      $reference = ConvertTo-CredentialReference $value.reference
      $results += @{ok=$true;credentialRef=$reference}
    } else {
      $canonical = ConvertTo-Binding $value.binding
      if ($null -ne $value.PSObject.Properties['stored']) { Assert-Binding $value.stored $canonical }
      $results += @{ok=$true;binding=$canonical}
    }
  } catch { $results += @{ok=$false;error='scope_rejected'} }
}
[Console]::Out.Write((@{results=$results} | ConvertTo-Json -Depth 8 -Compress))
`;

function probes(values) {
  const child = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', probeScript], {
    input: JSON.stringify({ helper, cases: values }), encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout).results;
}

test('app user sign-in has English labels, masked password and private redirected channels', () => {
  for (const text of ['App User Sign In', "'Username'", "'Password'", "'Sign In'", "'Cancel'", 'Enter your username and password.']) assert.ok(source.includes(text));
  assert.match(source, /UseSystemPasswordChar = \$true/);
  assert.match(source, /IsInputRedirected/);
  assert.match(source, /IsOutputRedirected/);
  assert.match(source, /\[char\]0x2014/); // Exact title, portable to Windows PowerShell's source encoding.
});

test('credential lifecycle encrypts per Windows user, enforces TTL and performs scoped cleanup', () => {
  assert.match(source, /DataProtectionScope\]::CurrentUser/);
  assert.match(source, /SetAccessRuleProtection\(\$true,\$false\)/);
  assert.match(source, /SSAM\.DebugAppUser\.v1\|/);
  assert.match(source, /\$credentialRef = ConvertTo-CredentialReference \(Get-RequiredProperty \$request 'credentialRef'\)/);
  assert.doesNotMatch(source, /\$credentialRef = \[Guid\]::NewGuid/);
  assert.match(source, /GetFolderPath\(\[Environment\+SpecialFolder\]::LocalApplicationData\)/);
  assert.match(source, /\$ttl = 600/);
  assert.match(source, /\$ttlInput -lt 30 -or \$ttlInput -gt 3600/);
  assert.match(source, /\$expiresAt -le \[DateTimeOffset\]::UtcNow/);
  assert.match(source, /\[IO\.File\]::Replace\(\$temporaryFile,\$vaultFile,\[NullString\]::Value\)/);
  assert.match(source, /\$temporaryFile = Join-Path \$vaultRoot \(\$credentialRef \+ '\.tmp'\)/);
  assert.match(source, /\$pendingFile = Join-Path \$vaultRoot \(\$credentialRef \+ '\.tmp'\)/);
  assert.match(source, /\$createdTemporaryFile -and \$null -ne \$temporaryFile/);
  assert.ok(source.indexOf('$candidates += Get-ScopedForgetCandidate') < source.indexOf('foreach ($candidate in $candidates) { [IO.File]::Delete'));
  assert.doesNotMatch(source, /Remove-Item|Delete\([^)]*,\s*\$true\)|WriteAllText|Set-Content|Out-File|Write-Host|Write-Verbose|Write-Debug|Exception\.Message/);
  assert.match(source, /Assert-Binding \(Get-RequiredProperty \$secret 'binding'\) \$binding/);
  assert.ok(source.indexOf("if ($Mode -eq 'forget')") < source.indexOf("$phase = 'expiration'")); // Expired scoped records can still be erased.
});

test('cancel does not store credentials and public responses have no credential fields', () => {
  const cancellation = source.slice(source.indexOf('if ($dialogResult -ne'), source.indexOf("$phase = 'encrypt'"));
  assert.match(cancellation, /\{"ok":false,"cancelled":true\}/);
  assert.doesNotMatch(cancellation, /File\]::Open|Protect\(/);
  const publicResponse = source.match(/No username, password or private storage path belongs in public output\.\s*([^\n]+)/)?.[1];
  assert.ok(publicResponse);
  assert.doesNotMatch(publicResponse, /username=|password=|vaultFile=|vaultRoot=/);
  assert.match(source, /\[Array\]::Clear\(\$clearBytes,0,\$clearBytes.Length\)/);
  const catchResponse = source.match(/Exception text can include data supplied by the user\. Emit only fixed text\.\s*([^\n]+)/)?.[1];
  assert.ok(catchResponse);
  assert.doesNotMatch(catchResponse, /\$_|username|password|request|secret|clearBytes/);
});

test('PowerShell parser and pure binding functions accept ODC and O11 without opening a dialog', { skip: !isWindows }, () => {
  const alternate = { ...binding, lane: 'o11', runtimeUrl: 'https://FIXTURE.DEV/Fixture', sessionId: '01234567-89ab-cdef-0123-456789abcdef' };
  const results = probes([{ binding }, { binding: alternate }]);
  assert.deepEqual(results[0].binding, binding);
  assert.deepEqual(results[1].binding, { ...alternate, runtimeUrl: 'https://fixture.dev/Fixture/', sessionId });
});

test('pure binding rejects credentials in URL, invalid sessions and unsecured remote sign-in', { skip: !isWindows }, () => {
  const invalids = [
    { lane: 'studio' }, { sessionId: '../another-session' }, { sessionId: '' }, { app: 'Fixture\nOther' },
    { runtimeUrl: 'https://account:fixture-password@fixture.dev/Fixture/' },
    { runtimeUrl: 'https://fixture.dev/Fixture/?token=fixture-token' },
    { runtimeUrl: 'https://fixture.dev/Fixture/#private' }, { runtimeUrl: 'https://fixture.dev/' },
    { runtimeUrl: 'http://fixture.dev/Fixture/' }, { runtimeUrl: 'http://localhost:1234/Fixture/' }, { runtimeUrl: 'file:///Fixture' },
    { app: 'AnotherApp' }, { module: undefined }, { moduleKey: undefined }, { moduleKey: 'not-a-module-key' },
    { runtimeUrl: 'https://fixture.dev/Fixture/screenservices/' }, { app: 'A'.repeat(200) }, { module: 'A'.repeat(200) },
  ];
  const results = probes([...invalids.map(invalid => ({ binding: { ...binding, ...invalid } })), { binding: { ...binding, runtimeUrl: 'https://localhost:1234/Fixture/' } }]);
  for (const result of results.slice(0, -1)) assert.equal(result.ok, false);
  assert.equal(results.at(-1).ok, true);
});

test('binding name limits match the controller and app path is independent of producer module', { skip: !isWindows }, () => {
  const longName = 'A'.repeat(199);
  const extended = { ...binding, app: longName, runtimeUrl: `https://fixture.dev/${longName}/`, module: longName };
  const results = probes([{ binding: extended }, { binding }]);
  assert.deepEqual(results[0].binding, extended);
  assert.deepEqual(results[1].binding, binding);
});

test('protected binding prevents reference reuse for another app, environment, session or producer', { skip: !isWindows }, () => {
  const mismatches = [
    { lane: 'o11' }, { runtimeUrl: 'https://other.dev/Fixture/' }, { runtimeUrl: 'https://fixture-dev.outsystems.app/Other/' },
    { app: 'Other' }, { sessionId: 'f'.repeat(32) }, { module: 'OtherProducer' }, { moduleKey: 'other-producer-key' },
    { module: undefined, moduleKey: undefined },
  ];
  const results = probes([{ binding, stored: binding }, ...mismatches.map(mismatch => ({ binding, stored: { ...binding, ...mismatch } }))]);
  assert.equal(results[0].ok, true);
  for (const result of results.slice(1)) assert.equal(result.ok, false);
});

test('preallocated reference is preserved exactly and cannot address another path', { skip: !isWindows }, () => {
  const valid = '01234567-89ab-4def-8123-456789abcdef';
  const invalid = ['', '../' + valid, valid + '.dpapi', valid.toUpperCase(), valid.replaceAll('-', ''), 'C:\\another\\record.dpapi'];
  const results = probes([{ reference: valid }, ...invalid.map(reference => ({ reference }))]);
  assert.deepEqual(results[0], { ok: true, credentialRef: valid });
  for (const result of results.slice(1)) assert.equal(result.ok, false);
});

test('interrupted ciphertext can be cleaned by exact private reference but complete cross-scope records are rejected', { skip: !isWindows }, () => {
  const fixture = override => ({ corrupt: false, aclFailure: false, readFailure: false, record: { version: 1, binding }, ...override });
  const cases = [
    fixture(), fixture({ corrupt: true }),
    fixture({ record: { version: 1, binding: { ...binding, module: 'AnotherProducer' } } }),
    fixture({ record: { version: 1, binding: { ...binding, sessionId: 'f'.repeat(32) } } }),
    fixture({ corrupt: true, aclFailure: true }), fixture({ corrupt: true, readFailure: true }),
    fixture({ record: { version: 2, binding } }),
  ];
  const results = probes(cases.map(forget => ({ binding, forget })));
  assert.deepEqual(results[0], { ok: true, corrupt: false, path: 'fixture-private-reference.tmp' });
  assert.deepEqual(results[1], { ok: true, corrupt: true, path: 'fixture-private-reference.tmp' });
  for (const result of results.slice(2)) assert.equal(result.ok, false);
});

test('CurrentUser DPAPI roundtrip and scoped interrupted-write cleanup use synthetic data in a private temp directory', { skip: !isWindows }, () => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tokens = $null
$errors = $null
$tree = [System.Management.Automation.Language.Parser]::ParseFile($fixture.helper,[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { exit 1 }
foreach ($definition in $tree.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}
Add-Type -AssemblyName System.Security
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$root = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('ssam-debug-app-user-fixture-' + [Guid]::NewGuid().ToString('D'))))
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $root.StartsWith($tempBase,[StringComparison]::OrdinalIgnoreCase)) { exit 1 }
$reference = [Guid]::NewGuid().ToString('D')
$file = Join-Path $root ($reference + '.dpapi')
$pending = Join-Path $root ($reference + '.tmp')
$clearBytes = $null
$opened = $null
$phase = 'temporary-directory-create'
try {
  $null = [IO.Directory]::CreateDirectory($root)
  $phase = 'private-directory-acl'
  Set-PrivateDirectory $root $sid
  $phase = 'directory-acl'
  Assert-PrivateDirectory $root $sid
  $phase = 'binding'
  $canonical = ConvertTo-Binding $fixture.binding
  $record = @{version=1;binding=$canonical;kind='credentials';username='synthetic-fixture';password='synthetic-not-a-user-secret'}
  $clearBytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 8 -Compress))
  $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $reference)
  $phase = 'dpapi-protect'
  $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $phase = 'ciphertext-write'
  [IO.File]::WriteAllBytes($file,$encrypted)
  $phase = 'dpapi-unprotect'
  $opened = Unprotect-AppUserRecord (Read-PrivateCiphertext $file) $entropy
  $phase = 'roundtrip'
  $roundtrip = [Text.Encoding]::UTF8.GetString($opened) -ceq [Text.Encoding]::UTF8.GetString($clearBytes)
  $phase = 'correct-scope'
  $candidate = Get-ScopedForgetCandidate $file $sid $entropy $canonical
  $correctScope = -not $candidate.corrupt -and $candidate.path -ceq $file
  $other = ConvertTo-Binding $fixture.binding
  $other.module = 'AnotherProducer'
  $crossScopeRejected = $false
  $phase = 'cross-scope'
  try { $null = Get-ScopedForgetCandidate $file $sid $entropy $other } catch { $crossScopeRejected = $true }
  $phase = 'truncated-ciphertext-write'
  [IO.File]::WriteAllBytes($pending,[byte[]]@($encrypted[0..7]))
  $phase = 'truncated-scope'
  $incomplete = Get-ScopedForgetCandidate $pending $sid $entropy $canonical
  if (-not $incomplete.corrupt) { throw 'Fixture corrupt cleanup failed' }
  $phase = 'exact-cleanup'
  [IO.File]::Delete($incomplete.path)
  [IO.File]::Delete($candidate.path)
  $cleanup = -not [IO.File]::Exists($file) -and -not [IO.File]::Exists($pending)
  [Console]::Out.Write((@{roundtrip=$roundtrip;correctScope=$correctScope;crossScopeRejected=$crossScopeRejected;cleanup=$cleanup} | ConvertTo-Json -Compress))
} catch {
  $exception = $_.Exception
  $types = @()
  while ($null -ne $exception -and $types.Count -lt 3) {
    $types += @{type=$exception.GetType().Name;hresult=$exception.HResult}
    $exception = $exception.InnerException
  }
  [Console]::Out.Write((@{ok=$false;error='synthetic_fixture_failed';phase=$phase;failures=$types} | ConvertTo-Json -Depth 5 -Compress))
  exit 1
}
finally {
  if ($null -ne $clearBytes) { [Array]::Clear($clearBytes,0,$clearBytes.Length) }
  if ($null -ne $opened) { [Array]::Clear($opened,0,$opened.Length) }
  if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) }
  if ([IO.File]::Exists($pending)) { [IO.File]::Delete($pending) }
  if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root) }
}
`;
  const child = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify({ helper, binding }), encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.deepEqual(JSON.parse(child.stdout), { roundtrip: true, correctScope: true, crossScopeRejected: true, cleanup: true });
});

test('the original private helper atomically seals a synthetic CurrentUser session and removes credentials before exact cleanup', { skip: !isWindows }, async () => {
  // A fresh reference is the only native vault record touched. No dialog,
  // network, existing-record enumeration, ACL relaxation or real credential is used.
  const credentialRef = randomUUID(), target = { ...binding, sessionId: randomUUID().replaceAll('-', '') };
  const descriptor = { credentialRef, binding: target, expiresAt: new Date(Date.now() + 600000).toISOString() };
  const seedScript = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tokens = $null
$errors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile($fixture.helper,[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { exit 1 }
foreach ($definition in $tree.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}
$clearBytes = $null
try {
  Add-Type -AssemblyName System.Security
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $parent = Resolve-DebugStateRoot $fixture.stateBase
  $root = [IO.Path]::GetFullPath((Join-Path $parent 'app-user'))
  foreach ($candidate in @($parent,$root)) { Assert-NoReparse $candidate }
  $reference = ConvertTo-CredentialReference $fixture.credentialRef
  $canonical = ConvertTo-Binding $fixture.binding
  $file = Join-Path $root ($reference + '.dpapi')
  $pending = Join-Path $root ($reference + '.tmp')
  if ([IO.File]::Exists($file) -or [IO.File]::Exists($pending)) { Fail 'synthetic_reference_collision' }
  if ($fixture.verify) {
    [Console]::Out.Write('{"ok":true,"cleanup":true}')
  } else {
    if (-not [IO.Directory]::Exists($root)) { Set-PrivateDirectory $root $sid }
    Assert-PrivateDirectory $root $sid
    $now = [DateTimeOffset]::UtcNow
    $record = @{version=1;kind='credentials';binding=$canonical;createdAt=$now.ToString('o');expiresAt=$now.AddSeconds(600).ToString('o');username='synthetic-fixture';password='synthetic-not-a-user-secret'}
    $clearBytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 8 -Compress))
    $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $reference)
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $stream = [IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($encrypted,0,$encrypted.Length) } finally { $stream.Dispose() }
    Assert-PrivateFile $file $sid
    [Console]::Out.Write('{"ok":true}')
  }
} catch {
  [Console]::Out.Write('{"ok":false,"error":"synthetic_fixture_failed"}')
  exit 1
} finally {
  if ($null -ne $clearBytes) { [Array]::Clear($clearBytes,0,$clearBytes.Length) }
  $fixture = $null
  $record = $null
}
`;
  const fixture = verify => {
    const child = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', seedScript], {
      input: JSON.stringify({ helper, binding: target, credentialRef, verify, stateBase }), encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.equal(child.status, 0, 'The isolated synthetic vault fixture must complete.');
    const result = JSON.parse(child.stdout);
    assert.equal(result.ok, true); return result;
  };
  const syntheticSession = { binding: target, userKey: randomUUID(), roles: ['synthetic-role'],
    authenticatedAt: new Date().toISOString(), expiresAt: descriptor.expiresAt,
    accessToken: 'SYNTHETIC_ACCESS_TOKEN', idToken: 'SYNTHETIC_ID_TOKEN', refreshToken: 'SYNTHETIC_REFRESH_TOKEN' };
  try {
    fixture(false);
    let record = await privateAppUserVault('read', descriptor);
    assert.equal(record.kind, 'credentials'); assert.ok(record.username === 'synthetic-fixture' && record.password === 'synthetic-not-a-user-secret');
    record = null;
    const sealed = await privateAppUserVault('seal-session', { ...descriptor, session: syntheticSession });
    assert.equal(sealed.ok, true); assert.equal(sealed.kind, 'session'); assert.deepEqual(sealed.binding, target);
    record = await privateAppUserVault('read', descriptor);
    assert.equal(record.ok, true); assert.equal(record.kind, 'session'); assert.deepEqual(record.binding, target);
    assert.deepEqual(record.session, syntheticSession);
    assert.equal(Object.hasOwn(record, 'username'), false); assert.equal(Object.hasOwn(record, 'password'), false);
    record = null;
  } finally {
    for (const key of ['accessToken', 'idToken', 'refreshToken']) syntheticSession[key] = '';
    const forgotten = await privateAppUserVault('forget', descriptor);
    assert.equal(forgotten.ok, true); assert.equal(fixture(true).cleanup, true);
  }
});

// ---- endpoint-credential records (Custom REST OnAuthentication headers) ----
const endpointBinding = { lane: 'o11', runtimeUrl: 'https://fixture.dev/Fixture/', app: 'Fixture', sessionId, module: 'Fixture',
  moduleKey: 'A'.repeat(22), revision: 7, serviceKey: 'B'.repeat(22), headers: ['X-Api-Key'] };

test('endpoint credential dialog has one masked field per declared header and public output has no header value', () => {
  const begin = source.indexOf("} elseif ($Mode -eq 'prompt-endpoint') {");
  const dialog = source.slice(begin, source.indexOf('No header value or private storage path belongs in public output.'));
  assert.ok(begin > source.indexOf("} elseif ($Mode -eq 'prompt') {") && dialog.length > 0);
  assert.match(dialog, /' Endpoint Credential'/); assert.match(dialog, /\[char\]0x2014/);
  assert.match(dialog, /foreach \(\$headerName in \$headerNames\)/); assert.match(dialog, /\$headerBox\.UseSystemPasswordChar = \$true/);
  assert.match(dialog, /DataProtectionScope\]::CurrentUser/);
  const publicResponse = source.match(/No header value or private storage path belongs in public output\.\s*([^\n]+)/)?.[1];
  assert.ok(publicResponse); assert.doesNotMatch(publicResponse, /value|Text|endpointHeaders|vaultFile|vaultRoot/);
  const cancellation = dialog.slice(dialog.indexOf('if ($endpointResult -ne'), dialog.indexOf("$phase = 'encrypt'"));
  assert.match(cancellation, /\{"ok":false,"cancelled":true\}/); assert.doesNotMatch(cancellation, /File\]::Open|Protect\(/);
  assert.match(source, /'prompt-endpoint'/);
});

test('the endpoint dialog branch builds its masked fields and stores only a bound synthetic record, without showing a window', { skip: !isWindows }, () => {
  // ShowDialog is replaced by synthetic text and OK; the vault root is a fresh private temp directory.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
$source = [IO.File]::ReadAllText($fixture.helper)
$tokens = $null
$errors = $null
$tree = [Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { exit 1 }
foreach ($definition in $tree.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}
$marker = '} elseif ($Mode -eq ''prompt-endpoint'') {'
$begin = $source.IndexOf($marker)
$end = $source.LastIndexOf('} else {', $source.IndexOf('$vaultFile = Join-Path $vaultRoot ($credentialRef + ''.dpapi'')', $source.IndexOf('No header value or private storage path')))
if ($begin -lt 0 -or $end -le $begin) { exit 1 }
$branch = $source.Substring($begin + $marker.Length, $end - $begin - $marker.Length)
$branch = $branch.Replace('$endpointResult = $form.ShowDialog()', 'foreach ($b in $endpointBoxes) { if (-not $b.UseSystemPasswordChar) { throw ''unmasked'' }; $b.Text = ''synthetic-'' + $b.TabIndex }; $endpointResult = [Windows.Forms.DialogResult]::OK')
Add-Type -AssemblyName System.Security
$request = $fixture
$binding = ConvertTo-EndpointBinding $fixture.binding
$credentialRef = [Guid]::NewGuid().ToString('D')
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$vaultRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('ssam-endpoint-dialog-fixture-' + [Guid]::NewGuid().ToString('D'))))
$phase = 'input'; $completed = $false; $createdFile = $false; $form = $null; $clearBytes = $null; $clear = $null; $secret = $null
$endpointBoxes = $null; $endpointHeaders = $null; $vaultFile = $null
$captured = New-Object IO.StringWriter
$original = [Console]::Out
$file = Join-Path $vaultRoot ($credentialRef + '.dpapi')
try {
  try { [Console]::SetOut($captured); . ([scriptblock]::Create($branch)) } finally { [Console]::SetOut($original) }
  $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $credentialRef)
  $clearBytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $record = [Text.Encoding]::UTF8.GetString($clearBytes) | ConvertFrom-Json
  $bound = $false
  try { Assert-Binding $record.binding $binding; $bound = $true } catch { }
  [Console]::Out.Write((@{completed=$completed;publicOutput=$captured.ToString();kind=$record.kind;bound=$bound;
    names=@($record.headers | ForEach-Object { $_.name });synthetic=@($record.headers | ForEach-Object { $_.value -like 'synthetic-*' })} | ConvertTo-Json -Compress))
} finally {
  if ($null -ne $clearBytes) { [Array]::Clear($clearBytes,0,$clearBytes.Length) }
  if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) }
  if ([IO.Directory]::Exists($vaultRoot)) { [IO.Directory]::Delete($vaultRoot) }
}
`;
  for (const headers of [['X-Api-Key'], ['X-Api-Key', 'X-Tenant']]) {
    const child = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-STA', '-NonInteractive', '-Command', script], {
      input: JSON.stringify({ helper, ttlSeconds: 120, binding: { ...endpointBinding, headers } }), encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    const result = JSON.parse(child.stdout), published = JSON.parse(result.publicOutput);
    assert.equal(result.completed, true); assert.equal(result.kind, 'endpoint-credential'); assert.equal(result.bound, true);
    assert.deepEqual(result.names, headers); assert.deepEqual(result.synthetic, headers.map(() => true));
    assert.deepEqual(Object.keys(published).sort(), ['binding', 'credentialRef', 'expiresAt', 'kind', 'ok']);
    assert.deepEqual(published.binding, { ...endpointBinding, headers }); assert.ok(!result.publicOutput.includes('synthetic-'));
  }
});

const endpointProbeScript = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$probe = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tokens = $null
$errors = $null
$tree = [System.Management.Automation.Language.Parser]::ParseFile($probe.helper,[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { [Console]::Out.Write('{"ok":false,"syntax":false}'); exit 1 }
foreach ($definition in $tree.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}
$results = @()
foreach ($value in $probe.cases) {
  try {
    if ($null -ne $value.PSObject.Properties['plain']) { $canonical = ConvertTo-Binding $value.binding } else { $canonical = ConvertTo-EndpointBinding $value.binding }
    if ($null -ne $value.PSObject.Properties['stored']) { Assert-Binding $value.stored $canonical }
    $results += @{ok=$true;binding=$canonical}
  } catch { $results += @{ok=$false;error='scope_rejected'} }
}
[Console]::Out.Write((@{results=$results} | ConvertTo-Json -Depth 8 -Compress))
`;
function endpointProbes(values) {
  const child = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', endpointProbeScript], {
    input: JSON.stringify({ helper, cases: values }), encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  return JSON.parse(child.stdout).results;
}

test('endpoint binding covers revision, service key, exact header names and session, and never matches an app-user record', { skip: !isWindows }, () => {
  const two = { ...endpointBinding, headers: ['X-Api-Key', 'X-Tenant'] };
  const invalid = [{ headers: [] }, { headers: 'X-Api-Key' }, { headers: ['X-Api-Key', 'x-api-key'] }, { headers: ['Bad Header'] },
    { headers: [{ name: 'X-Api-Key', value: 'synthetic' }] }, { headers: Array.from({ length: 9 }, (_, i) => 'X-H' + i) },
    { revision: 0 }, { revision: '7' }, { serviceKey: 'short' }, { serviceKey: undefined }, { revision: undefined }, { headers: undefined }];
  const mismatches = [{ revision: 8 }, { serviceKey: 'C'.repeat(22) }, { headers: ['X-Tenant'] }, { headers: ['X-Api-Key', 'X-Tenant'] },
    { sessionId: 'f'.repeat(32) }, { moduleKey: 'D'.repeat(22) }];
  const { revision: _r, serviceKey: _s, headers: _h, ...plain } = endpointBinding;
  const results = endpointProbes([{ binding: endpointBinding }, { binding: two }, { binding: endpointBinding, stored: endpointBinding },
    ...invalid.map(patch => ({ binding: { ...endpointBinding, ...patch } })),
    ...mismatches.map(patch => ({ binding: endpointBinding, stored: { ...endpointBinding, ...patch } })),
    { binding: endpointBinding, stored: plain }, { plain: true, binding: plain, stored: endpointBinding }, { plain: true, binding: plain, stored: plain }]);
  assert.deepEqual(results[0].binding, endpointBinding); assert.deepEqual(results[1].binding, two); assert.equal(results[2].ok, true);
  for (const result of results.slice(3, -1)) assert.equal(result.ok, false);
  assert.equal(results.at(-1).ok, true);
});

const endpointSeedScript = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tokens = $null
$errors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile($fixture.helper,[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { exit 1 }
foreach ($definition in $tree.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}
$clearBytes = $null
try {
  Add-Type -AssemblyName System.Security
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $parent = Resolve-DebugStateRoot $fixture.stateBase
  $root = [IO.Path]::GetFullPath((Join-Path $parent 'app-user'))
  foreach ($candidate in @($parent,$root)) { Assert-NoReparse $candidate }
  $reference = ConvertTo-CredentialReference $fixture.credentialRef
  $canonical = ConvertTo-EndpointBinding $fixture.binding
  $file = Join-Path $root ($reference + '.dpapi')
  $exists = [IO.File]::Exists($file) -or [IO.File]::Exists((Join-Path $root ($reference + '.tmp')))
  if ($fixture.mode -eq 'exists') { [Console]::Out.Write((@{ok=$true;exists=$exists} | ConvertTo-Json -Compress)) }
  else {
    if ($exists) { Fail 'synthetic_reference_collision' }
    if (-not [IO.Directory]::Exists($root)) { Set-PrivateDirectory $root $sid }
    Assert-PrivateDirectory $root $sid
    $now = [DateTimeOffset]::UtcNow
    if ($fixture.mode -eq 'expired') { $created = $now.AddSeconds(-700) } else { $created = $now }
    $headers = New-Object 'Collections.Generic.List[object]'
    foreach ($item in @($fixture.headers)) { $headers.Add([ordered]@{name=[string]$item.name;value=[string]$item.value}) }
    $record = [ordered]@{version=1;kind='endpoint-credential';binding=$canonical;createdAt=$created.ToString('o');expiresAt=$created.AddSeconds(600).ToString('o');headers=$headers.ToArray()}
    $clearBytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 8 -Compress))
    $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $reference)
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $stream = [IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($encrypted,0,$encrypted.Length) } finally { $stream.Dispose() }
    Assert-PrivateFile $file $sid
    [Console]::Out.Write('{"ok":true}')
  }
} catch {
  [Console]::Out.Write('{"ok":false,"error":"synthetic_fixture_failed"}')
  exit 1
} finally {
  if ($null -ne $clearBytes) { [Array]::Clear($clearBytes,0,$clearBytes.Length) }
  $fixture = $null
  $record = $null
  $headers = $null
}
`;

test('the original private helper round-trips a synthetic endpoint credential, refuses another binding or an expired record, and releases it', { skip: !isWindows }, async () => {
  // Fresh references only; no dialog, network, enumeration or real secret is used.
  const target = { ...endpointBinding, sessionId: randomUUID().replaceAll('-', '') }, twoHeaders = { ...target, headers: ['X-Api-Key', 'X-Tenant'] };
  const records = [
    { credentialRef: randomUUID(), binding: target, headers: [{ name: 'X-Api-Key', value: 'synthetic-endpoint-value-1' }], mode: 'seed' },
    { credentialRef: randomUUID(), binding: twoHeaders, headers: [{ name: 'X-Api-Key', value: 'synthetic-endpoint-value-2' }, { name: 'X-Tenant', value: 'synthetic-tenant' }], mode: 'seed' },
    { credentialRef: randomUUID(), binding: target, headers: [{ name: 'X-Api-Key', value: 'synthetic-endpoint-value-3' }], mode: 'expired' },
  ];
  const seed = (record, mode = record.mode) => {
    const child = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', endpointSeedScript], {
      input: JSON.stringify({ helper, ...record, mode, stateBase }), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(child.status, 0, 'The isolated synthetic endpoint vault fixture must complete.');
    const result = JSON.parse(child.stdout); assert.equal(result.ok, true); return result;
  };
  const descriptor = record => ({ credentialRef: record.credentialRef, binding: record.binding, expiresAt: new Date(Date.now() + 600000).toISOString() });
  try {
    for (const record of records) seed(record);
    let opened = await privateAppUserVault('read', descriptor(records[0]));
    assert.equal(opened.kind, 'endpoint-credential'); assert.deepEqual(opened.binding, target);
    assert.deepEqual(opened.headers, records[0].headers); assert.equal(Object.hasOwn(opened, 'password'), false);
    opened = await privateAppUserVault('read', descriptor(records[1]));
    assert.deepEqual(opened.headers, records[1].headers); assert.deepEqual(opened.binding, twoHeaders);
    opened = null;
    const { revision: _r, serviceKey: _s, headers: _h, ...plain } = target;
    for (const binding of [{ ...target, revision: 8 }, { ...target, serviceKey: 'C'.repeat(22) }, { ...target, headers: ['X-Other'] },
      { ...target, headers: ['X-Api-Key', 'X-Tenant'] }, { ...target, sessionId: 'f'.repeat(32) }, plain])
      await assert.rejects(privateAppUserVault('read', { ...descriptor(records[0]), binding }), /debug_app_user_credentials_unavailable/);
    await assert.rejects(privateAppUserVault('read', descriptor(records[2])), /debug_app_user_credentials_unavailable/);
    await assert.rejects(privateAppUserVault('forget', { ...descriptor(records[0]), binding: { ...target, serviceKey: 'C'.repeat(22) } }), /debug_app_user_credentials_unavailable/);
    assert.equal(seed(records[0], 'exists').exists, true);
    const released = await releaseEndpointCredential({ ...descriptor(records[0]), kind: 'endpoint-credential' });
    assert.deepEqual(released, { ok: true, forgotten: true }); assert.equal(seed(records[0], 'exists').exists, false);
  } finally {
    for (const record of records) await privateAppUserVault('forget', descriptor(record)).catch(() => {});
    for (const record of records) assert.equal(seed(record, 'exists').exists, false);
  }
});

test('endpoint credential prepare sends only header names to the private dialog and releases the exact reference', async () => {
  const calls = [], input = { lane: 'o11', runtimeUrl: 'https://fixture.dev/Fixture/', module: 'Fixture', moduleKey: 'A'.repeat(22),
    revision: 7, serviceKey: 'B'.repeat(22), headers: ['X-Api-Key'], seconds: 120 };
  const vault = async (mode, request) => { calls.push([mode, structuredClone(request)]);
    return mode === 'prompt-endpoint' ? { ok: true, kind: 'endpoint-credential', credentialRef: request.credentialRef, binding: request.binding,
      expiresAt: new Date(Date.now() + 120000).toISOString() } : { ok: true, forgotten: true }; };
  let armed;
  const prepared = await prepareEndpointCredential(input, { vault, expire: async value => { armed = value; }, sessionId });
  assert.equal(prepared.ok, true); assert.equal(prepared.credentialSource, 'private-dialog');
  assert.deepEqual(prepared.descriptor.binding, endpointBinding); assert.equal(prepared.descriptor.kind, 'endpoint-credential');
  assert.deepEqual(armed, prepared.descriptor); assert.deepEqual(validateEndpointCredentialDescriptor(prepared.descriptor).binding, endpointBinding);
  assert.deepEqual(calls.map(([mode]) => mode), ['prompt-endpoint']);
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ['binding', 'credentialRef', 'ttlSeconds']);
  assert.deepEqual(await releaseEndpointCredential(prepared.descriptor, { vault }), { ok: true, forgotten: true });
  assert.equal(calls.at(-1)[0], 'forget'); assert.deepEqual(calls.at(-1)[1].binding, endpointBinding);
  assert.equal(calls.at(-1)[1].credentialRef, prepared.descriptor.credentialRef);
  // Values never travel as request JSON; header entries are names from the published contract.
  for (const patch of [{ headers: [{ name: 'X-Api-Key', value: 'synthetic' }] }, { headers: [] }, { headers: ['Bad Header'] },
    { headers: ['X-A', 'x-a'] }, { values: { 'X-Api-Key': 'synthetic' } }, { credentials: 'synthetic' }, { revision: 0 }, { serviceKey: 'short' }])
    await assert.rejects(prepareEndpointCredential({ ...input, ...patch }, { vault, expire: async () => {}, sessionId }), /debug_app_user_endpoint_credential_invalid_target/);
  assert.equal(calls.filter(([mode]) => mode === 'prompt-endpoint').length, 1);
  const cancelled = await prepareEndpointCredential(input, { sessionId, expire: async () => assert.fail('cancelled prompt arms no expiry'),
    vault: async (mode, request) => { calls.push([mode, request]); return mode === 'prompt-endpoint' ? { ok: false, cancelled: true } : { ok: true }; } });
  assert.equal(cancelled.state, 'cancelled'); assert.equal(calls.at(-1)[0], 'forget');
  await assert.rejects(prepareEndpointCredential(input, { sessionId, expire: async () => {}, vault: async (mode, request) => { calls.push([mode, request]);
    return mode === 'prompt-endpoint' ? { ok: true, kind: 'endpoint-credential', credentialRef: request.credentialRef,
      binding: { ...request.binding, serviceKey: 'C'.repeat(22) }, expiresAt: new Date(Date.now() + 60000).toISOString() } : { ok: true }; } }), /debug_app_user_scope_mismatch/);
  assert.equal(calls.at(-1)[0], 'forget');
});

test('private prompt-endpoint helper keeps the request on stdin and hides only the console', async () => {
  let argv, options, sent;
  const result = await privateAppUserVault('prompt-endpoint', { credentialRef: randomUUID(), binding: endpointBinding, ttlSeconds: 120 }, {
    spawnImpl: (_command, args, opts) => {
      argv = args; options = opts;
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
      const chunks = []; child.stdin.on('data', bytes => chunks.push(bytes)); child.stdin.on('finish', () => {
        sent = Buffer.concat(chunks).toString('utf8'); child.stdout.end('{"ok":true}'); queueMicrotask(() => child.emit('close', 0));
      });
      return child;
    } });
  assert.equal(result.ok, true); assert.equal(argv[argv.indexOf('-Mode') + 1], 'prompt-endpoint');
  assert.equal(argv[argv.indexOf('-WindowStyle') + 1], 'Hidden'); assert.equal(options.windowsHide, false);
  assert.ok(sent.includes('X-Api-Key')); assert.ok(!argv.join(' ').includes('X-Api-Key'));
});

test('endpoint credential redaction values come only from the exact bound record and are zeroed', async () => {
  const descriptor = { credentialRef: randomUUID(), binding: endpointBinding, expiresAt: new Date(Date.now() + 60000).toISOString(), kind: 'endpoint-credential' };
  const record = { ok: true, kind: 'endpoint-credential', binding: endpointBinding, expiresAt: descriptor.expiresAt, headers: [{ name: 'X-Api-Key', value: 'synthetic-redaction' }] };
  let opened;
  const vault = async mode => { assert.equal(mode, 'read'); opened = structuredClone(record); return opened; };
  assert.deepEqual(await privateEndpointCredentialValues(descriptor, { vault }), ['synthetic-redaction']); assert.equal(opened.headers[0].value, '');
  for (const patch of [{ kind: 'credentials' }, { binding: { ...endpointBinding, revision: 8 } }, { headers: [{ name: 'X-Other', value: 'synthetic' }] },
    { expiresAt: new Date(Date.now() - 1000).toISOString() }]) {
    Object.assign(record, patch);
    await assert.rejects(privateEndpointCredentialValues(descriptor, { vault }), /debug_app_user_credentials_unavailable/);
    Object.assign(record, { kind: 'endpoint-credential', binding: endpointBinding, expiresAt: descriptor.expiresAt, headers: [{ name: 'X-Api-Key', value: 'synthetic-redaction' }] });
  }
});

// ---- debugger state root (P13): %USERPROFILE%\.ssam-hybrid\debugger\<area>, legacy %LOCALAPPDATA%\SSAM copies read only ----
test('vault state lives under the debugger state root; DPAPI scope and entropy are unchanged; no write targets a legacy copy', () => {
  assert.match(source, /\[string\]\$StateRoot/);
  assert.match(source, /\$stateRoot = Resolve-DebugStateRoot \$StateRoot/);
  assert.match(source, /\$vaultRoot = Join-Path \$stateRoot 'app-user'/);
  assert.match(source, /\$profileRoot = Join-Path \$stateRoot 'app-user-profiles'/);
  assert.match(source, /'SSAM\.DebugAppUserProfile\.v1\|' \+ \$profileHash/);
  // prompt, import-profile, prompt-endpoint, forget, read, and the explicit endpoint profile's remember (read) and resolve (write).
  assert.equal((source.match(/'SSAM\.DebugAppUser\.v1\|' \+ \$credentialRef/g) ?? []).length, 7);
  assert.doesNotMatch(source, /DataProtectionScope\]::LocalMachine/);
  assert.match(source, /Assert-PrivateDirectory/); assert.match(source, /Assert-NoReparse \$stateRoot/);
  assert.doesNotMatch(source, /\.ssam\\|'\.ssam'/);
  for (const line of source.split('\n').filter(l => /Set-PrivateDirectory |WriteAllBytes|\[IO\.File\]::Open\(|::Replace\(|CreateDirectory/.test(l)))
    assert.doesNotMatch(line, /legacy/i, line.trim());
  // Forget reaches the new root and only this process's own legacy view; a read may fall back to that view.
  assert.match(source, /\$forgetPaths = @\(\$vaultFile,\$pendingFile,\$legacyFile,\$legacyPendingFile\)/);
  assert.match(source, /\$legacyVaultRoot = \[IO\.Path\]::GetFullPath\(\(Join-Path \$ssamDirectory 'DebugAppUser'\)\)/);
});

const rootProbeScript = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$probe = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tokens = $null
$errors = $null
$tree = [System.Management.Automation.Language.Parser]::ParseFile($probe.helper,[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { exit 1 }
foreach ($definition in $tree.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}
$results = @()
foreach ($value in $probe.roots) { try { $results += @{ok=$true;root=(Resolve-DebugStateRoot $value)} } catch { $results += @{ok=$false} } }
foreach ($value in $probe.legacy) { try { $results += @{ok=$true;count=(ConvertTo-LegacyRoots $value 'DebugAppUserProfiles').Count} } catch { $results += @{ok=$false} } }
[Console]::Out.Write((@{results=$results} | ConvertTo-Json -Depth 5 -Compress))
`;

test('the state root parameter and the legacy profile roots are validated before any storage access', { skip: !isWindows }, () => {
  const valid = path.join(os.tmpdir(), 'ssam-root-probe'), store = path.join(os.tmpdir(), 'x', 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Local', 'SSAM', 'DebugAppUserProfiles');
  const roots = [valid, '', 'relative\\root', 'C:\\x\\..\\y', '\\\\server\\share\\root', 'C:\\Users\\x\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Local\\root'];
  const legacy = [[{ origin: 'package:OpenAI.Codex_2p2nqsd0c76g0', path: store }, { origin: 'current', path: store }],
    [{ origin: 'package:../x', path: store }], [{ origin: 'real', path: path.dirname(store) }], [{ origin: 'real', path: 'relative\\SSAM\\DebugAppUserProfiles' }]];
  const child = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', rootProbeScript], {
    input: JSON.stringify({ helper, roots, legacy }), encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  const results = JSON.parse(child.stdout).results;
  assert.deepEqual(results[0], { ok: true, root: valid }); assert.deepEqual(results[1], { ok: true, root: stateBase });
  for (const result of results.slice(2, roots.length)) assert.equal(result.ok, false);
  assert.deepEqual(results[roots.length], { ok: true, count: 2 });
  for (const result of results.slice(roots.length + 1)) assert.equal(result.ok, false);
});

const profileSeedScript = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tokens = $null
$errors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile($fixture.helper,[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { exit 1 }
foreach ($definition in $tree.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}
Add-Type -AssemblyName System.Security
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$canonical = ConvertTo-Binding $fixture.binding
$profileBinding = [ordered]@{}
foreach ($field in @('lane','runtimeUrl','app','module','moduleKey')) { $profileBinding[$field]=$canonical[$field] }
$hashProvider = [Security.Cryptography.SHA256]::Create()
try { $profileHash = ([BitConverter]::ToString($hashProvider.ComputeHash([Text.Encoding]::UTF8.GetBytes(($profileBinding | ConvertTo-Json -Compress))))).Replace('-','').ToLowerInvariant() } finally { $hashProvider.Dispose() }
$clearBytes = [Text.Encoding]::UTF8.GetBytes((@{version=1;binding=$profileBinding;profileHost=$fixture.profileHost;profileTarget=$fixture.profileTarget} | ConvertTo-Json -Depth 5 -Compress))
$encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,[Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUserProfile.v1|' + $profileHash),[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Array]::Clear($clearBytes,0,$clearBytes.Length)
Set-PrivateDirectory $fixture.root $sid
[IO.File]::WriteAllBytes((Join-Path $fixture.root ($profileHash + '.dpapi')),$encrypted)
[Console]::Out.Write('{"ok":true}')
`;

test('saved profiles are remembered only under the new root and resolve read only from a legacy package copy', { skip: !isWindows }, async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-profile-legacy-'));
  const legacy = path.join(top, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Local', 'SSAM', 'DebugAppUserProfiles');
  const legacyProfileRoots = [{ origin: 'package:OpenAI.Codex_2p2nqsd0c76g0', path: legacy }];
  const target = { ...binding, sessionId: randomUUID().replaceAll('-', '') }, profileHost = 'fixture-tenant.outsystems.dev';
  const profileTarget = 'SSAM/ODC3/' + profileHost + '/Portal', profiles = path.join(stateBase, 'app-user-profiles');
  const other = { ...target, app: 'Other', runtimeUrl: 'https://fixture-dev.outsystems.app/Other/' };
  const listing = dir => { const out = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), s = fs.statSync(p); out.push(p + '|' + s.size + '|' + s.mtimeMs); if (e.isDirectory()) walk(p); } }; walk(dir); return out.sort(); };
  try {
    const seeded = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', profileSeedScript], {
      input: JSON.stringify({ helper, binding: target, root: legacy, profileHost, profileTarget }), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(seeded.status, 0, seeded.stderr + seeded.stdout);
    const before = listing(top);
    const found = await privateAppUserVault('resolve-profile', { binding: target, credentialRef: randomUUID() }, { legacyProfileRoots });
    assert.deepEqual(found, { ok: true, found: true, profileHost, profileTarget, profileOrigin: 'package:OpenAI.Codex_2p2nqsd0c76g0' });
    assert.equal(fs.existsSync(profiles), false, 'a legacy read copies nothing into the new root');
    assert.deepEqual(await privateAppUserVault('resolve-profile', { binding: other, credentialRef: randomUUID() }, { legacyProfileRoots }), { ok: true, found: false });
    const remembered = await privateAppUserVault('remember-profile', { binding: target, credentialRef: randomUUID(), profileHost, profileTarget }, { legacyProfileRoots });
    assert.deepEqual(remembered, { ok: true, remembered: true });
    assert.equal(fs.readdirSync(profiles).length, 1); assert.deepEqual(listing(top), before, 'the legacy copy is never written');
    const current = await privateAppUserVault('resolve-profile', { binding: target, credentialRef: randomUUID() }, { legacyProfileRoots });
    assert.equal(current.profileOrigin, 'state');
    await assert.rejects(privateAppUserVault('resolve-profile', { binding: other, credentialRef: randomUUID() },
      { legacyProfileRoots: [{ origin: 'real', path: top }] }), /debug_app_user_credentials_unavailable/);
  } finally {
    fs.rmSync(top, { recursive: true, force: true }); fs.rmSync(profiles, { recursive: true, force: true });
  }
});

test('the helper receives the validated state root as a parameter, never on stdin', async () => {
  let argv, sent;
  await privateAppUserVault('forget', { credentialRef: randomUUID(), binding }, {
    spawnImpl: (_command, args) => {
      argv = args;
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
      const chunks = []; child.stdin.on('data', bytes => chunks.push(bytes)); child.stdin.on('finish', () => {
        sent = Buffer.concat(chunks).toString('utf8'); child.stdout.end('{"ok":true,"forgotten":false}'); queueMicrotask(() => child.emit('close', 0));
      });
      return child;
    } });
  assert.equal(argv[argv.indexOf('-StateRoot') + 1], stateBase); assert.ok(!sent.includes(stateBase));
  assert.ok(!Object.hasOwn(JSON.parse(sent), 'legacyProfileRoots'), 'only profile resolution receives legacy roots');
});

// ---- PX03: Basic endpoint credential (RFC 7617), explicit endpoint profile and redaction-only record ----
const basicBinding = { lane: 'odc', runtimeUrl: 'https://fixture-dev.outsystems.app/Fixture/', app: 'Fixture', sessionId, module: 'Fixture',
  moduleKey: 'A'.repeat(22), revision: 7, serviceKey: 'B'.repeat(22), headers: ['Authorization'], scheme: 'basic' };
const redactBinding = { lane: 'odc', runtimeUrl: 'https://fixture-dev.outsystems.app/Fixture/', app: 'Fixture', sessionId, module: 'Fixture',
  moduleKey: 'A'.repeat(22), revision: 7, use: 'redact-only', roles: ['WsSecurityPassword', 'FormClientSecret'] };
const loadFunctions = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
$source = [IO.File]::ReadAllText($fixture.helper)
$tokens = $null
$errors = $null
$tree = [Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { [Console]::Out.Write('{"ok":false,"syntax":false}'); exit 1 }
foreach ($definition in $tree.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}
`;
const runPs = (script, input, timeout = 30000) => {
  const child = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-STA', '-NonInteractive', '-Command', script], {
    input: JSON.stringify({ helper, ...input }), encoding: 'utf8', windowsHide: true, timeout });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  return JSON.parse(child.stdout);
};

test('basic and redaction dialogs: titles, a plain username box, one masked password box, masked role fields and the RFC 7617 username rule', () => {
  const begin = source.indexOf("} elseif ($Mode -eq 'prompt-endpoint') {");
  const dialog = source.slice(begin, source.indexOf('No header value or private storage path belongs in public output.'));
  assert.match(dialog, /' Endpoint Credential \(Basic\)'/); assert.match(dialog, /' Redaction Secret'/); assert.match(dialog, /' Endpoint Credential'/);
  assert.match(dialog, /\$usernameBox = New-Object Windows\.Forms\.TextBox/); assert.match(dialog, /\$headerNames = @\('Password'\)/);
  assert.match(dialog, /\$headerNames = \$binding\.roles/); assert.match(dialog, /Test-EndpointDialogInput/);
  assert.match(source, /function Test-EndpointDialogInput/); assert.ok(source.includes("'[:\\x00-\\x1f\\x7f]'"));
  assert.match(dialog, /kind='endpoint-credential';scheme='basic'/); assert.match(dialog, /kind='endpoint-credential';use='redact-only'/);
  // The endpoint profile is explicit: only its own modes reach it; neither the dialog nor the read path names it.
  assert.doesNotMatch(dialog, /endpoint-profile|endpointProfile/);
  const read = source.slice(source.indexOf("$Mode -eq 'read' -and -not [IO.File]::Exists($vaultFile)"), source.indexOf('Exception text can include data supplied by the user.'));
  assert.ok(read.length > 0); assert.doesNotMatch(read, /endpoint-profile|endpointProfile/);
});

const familyProbeScript = loadFunctions + String.raw`
$results = @()
foreach ($value in $fixture.cases) {
  try {
    if ($null -ne $value.PSObject.Properties['dialog']) {
      $problem = Test-EndpointDialogInput ([bool]$value.dialog.basic) ([string]$value.dialog.username) ([string[]]@($value.dialog.values))
      $results += @{ok=$true;accepted=($null -eq $problem)}
    } else {
      $kind = ''
      if ($null -ne $value.PSObject.Properties['kind']) { $kind = $value.kind }
      if ($kind -eq 'redaction') { $canonical = ConvertTo-RedactionBinding $value.binding } elseif ($kind -eq 'plain') { $canonical = ConvertTo-Binding $value.binding } else { $canonical = ConvertTo-EndpointBinding $value.binding }
      if ($null -ne $value.PSObject.Properties['stored']) { Assert-Binding $value.stored $canonical }
      $results += @{ok=$true;binding=$canonical}
    }
  } catch { $results += @{ok=$false} }
}
[Console]::Out.Write((@{results=$results} | ConvertTo-Json -Depth 8 -Compress))
`;

test('Basic usernames refuse ":" and control characters; basic and redaction bindings never open another record family', { skip: !isWindows }, () => {
  const dialog = [['synthetic-user', ['synthetic:pass'], true], ['a:b', ['p'], false], ['a\tb', ['p'], false], ['a\u0000b', ['p'], false], ['a\u007fb', ['p'], false],
    [' ', ['p'], false], ['', ['p'], false], ['user', [''], false], ['user', ['p\nq'], false]].map(([username, values, accepted]) => ({ dialog: { basic: true, username, values }, accepted }));
  const header = [{ dialog: { basic: false, username: '', values: ['x', 'y'] }, accepted: true }, { dialog: { basic: false, username: '', values: ['x', ''] }, accepted: false }];
  const { headers: _h, scheme: _s, ...base } = basicBinding, { revision: _r, serviceKey: _k, ...plain } = base;
  const header1 = { ...base, headers: ['X-Api-Key'] };
  const basicInvalid = [{ scheme: 'digest' }, { scheme: 'header' }, { headers: ['X-Api-Key'] }, { headers: ['Authorization', 'X-Other'] }, { headers: ['authorization'] }, { use: 'redact-only' }];
  const { use: _u, roles: _ro, ...redactBase } = redactBinding;
  const redactInvalid = [{ roles: [] }, { roles: ['bad role'] }, { roles: ['A', 'a'] }, { roles: Array.from({ length: 9 }, (_, i) => 'R' + i) }, { serviceKey: 'B'.repeat(22) },
    { headers: ['X'] }, { scheme: 'basic' }, { use: 'other' }, { revision: 0 }, { roles: undefined }, { roles: [{ role: 'R', value: 'synthetic' }] }];
  const cases = [...dialog, ...header,
    { binding: basicBinding }, ...basicInvalid.map(patch => ({ binding: { ...basicBinding, ...patch } })),
    { binding: basicBinding, stored: basicBinding }, { binding: basicBinding, stored: header1 }, { binding: header1, stored: basicBinding },
    { binding: redactBinding, kind: 'redaction' }, ...redactInvalid.map(patch => ({ binding: { ...redactBinding, ...patch }, kind: 'redaction' })),
    { binding: redactBinding, kind: 'redaction', stored: redactBinding },
    ...[{ revision: 8 }, { roles: ['FormClientSecret', 'WsSecurityPassword'] }, { roles: ['WsSecurityPassword'] }, { sessionId: 'f'.repeat(32) }, { moduleKey: 'D'.repeat(22) }]
      .map(patch => ({ binding: redactBinding, kind: 'redaction', stored: { ...redactBinding, ...patch } })),
    { binding: redactBinding, kind: 'redaction', stored: { ...redactBase, serviceKey: 'B'.repeat(22), headers: ['X'] } }, { binding: redactBinding, kind: 'redaction', stored: plain },
    { binding: plain, kind: 'plain', stored: redactBinding }, { binding: header1, stored: { ...redactBinding, serviceKey: 'B'.repeat(22), headers: ['X-Api-Key'] } }];
  const results = runPs(familyProbeScript, { cases }).results;
  let i = 0;
  for (const item of [...dialog, ...header]) assert.equal(results[i++].accepted, item.accepted, JSON.stringify(item.dialog));
  assert.deepEqual(results[i++].binding, basicBinding);
  for (const _ of basicInvalid) assert.equal(results[i++].ok, false);
  assert.equal(results[i++].ok, true); assert.equal(results[i++].ok, false); assert.equal(results[i++].ok, false);
  assert.deepEqual(results[i++].binding, redactBinding);
  for (const _ of redactInvalid) assert.equal(results[i++].ok, false);
  assert.equal(results[i++].ok, true);
  for (; i < results.length; i++) assert.equal(results[i].ok, false, JSON.stringify(cases[i]));
});

const familyDialogScript = loadFunctions + String.raw`
$marker = '} elseif ($Mode -eq ''prompt-endpoint'') {'
$begin = $source.IndexOf($marker)
$end = $source.LastIndexOf('} else {', $source.IndexOf('$vaultFile = Join-Path $vaultRoot ($credentialRef + ''.dpapi'')', $source.IndexOf('No header value or private storage path')))
if ($begin -lt 0 -or $end -le $begin) { exit 1 }
$branch = $source.Substring($begin + $marker.Length, $end - $begin - $marker.Length)
$fill = 'if ($null -ne $usernameBox) { if ($usernameBox.UseSystemPasswordChar) { throw ''masked username'' }; $usernameBox.Text = $fixture.username }; ' +
  '$maskedCount = @($endpointBoxes | Where-Object { $_.UseSystemPasswordChar }).Count; $boxCount = $endpointBoxes.Count; $formTitle = $form.Text; ' +
  'foreach ($b in $endpointBoxes) { $b.Text = ''synthetic-'' + $b.TabIndex }; $endpointResult = [Windows.Forms.DialogResult]::OK'
$branch = $branch.Replace('$endpointResult = $form.ShowDialog()', $fill)
Add-Type -AssemblyName System.Security
$request = $fixture
if ($null -ne $fixture.binding.PSObject.Properties['use']) { $binding = ConvertTo-RedactionBinding $fixture.binding } else { $binding = ConvertTo-EndpointBinding $fixture.binding }
$credentialRef = [Guid]::NewGuid().ToString('D')
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$vaultRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('ssam-endpoint-family-fixture-' + [Guid]::NewGuid().ToString('D'))))
$phase = 'input'; $completed = $false; $createdFile = $false; $form = $null; $clearBytes = $null; $clear = $null; $secret = $null
$endpointBoxes = $null; $endpointHeaders = $null; $vaultFile = $null; $usernameBox = $null; $maskedCount = -1; $boxCount = -1; $formTitle = ''
$captured = New-Object IO.StringWriter
$original = [Console]::Out
$file = Join-Path $vaultRoot ($credentialRef + '.dpapi')
$threw = $false
try {
  try { [Console]::SetOut($captured); . ([scriptblock]::Create($branch)) } catch { $threw = $true } finally { [Console]::SetOut($original) }
  $out = @{threw=$threw;completed=$completed;exists=[IO.File]::Exists($file);maskedCount=$maskedCount;boxCount=$boxCount;title=$formTitle}
  if ($out.exists) {
    $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $credentialRef)
    $clearBytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $record = [Text.Encoding]::UTF8.GetString($clearBytes) | ConvertFrom-Json
    $bound = $false
    try { Assert-Binding $record.binding $binding; $bound = $true } catch { }
    $out.publicOutput = $captured.ToString(); $out.kind = $record.kind; $out.bound = $bound
    $out.fields = @($record.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
    if ($null -ne $record.PSObject.Properties['scheme']) { $out.scheme = $record.scheme; $out.usernameMatches = ($record.username -ceq $fixture.username); $out.passwordSynthetic = ($record.password -like 'synthetic-*') }
    if ($null -ne $record.PSObject.Properties['use']) { $out.use = $record.use; $out.roles = @($record.secrets | ForEach-Object { $_.role }); $out.synthetic = @($record.secrets | ForEach-Object { $_.value -like 'synthetic-*' }) }
  }
  [Console]::Out.Write(($out | ConvertTo-Json -Compress))
} finally {
  if ($null -ne $clearBytes) { [Array]::Clear($clearBytes,0,$clearBytes.Length) }
  if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) }
  if ([IO.Directory]::Exists($vaultRoot)) { [IO.Directory]::Delete($vaultRoot) }
}
`;

test('the basic and redaction dialog branches store only bound synthetic records, without showing a window; a ":" username stores nothing', { skip: !isWindows }, () => {
  const basic = runPs(familyDialogScript, { ttlSeconds: 120, binding: basicBinding, username: 'synthetic-user' });
  assert.equal(basic.threw, false); assert.equal(basic.completed, true); assert.equal(basic.kind, 'endpoint-credential'); assert.equal(basic.bound, true);
  assert.equal(basic.boxCount, 1); assert.equal(basic.maskedCount, 1); assert.match(basic.title, /Fixture — Endpoint Credential \(Basic\)$/);
  assert.equal(basic.scheme, 'basic'); assert.equal(basic.usernameMatches, true); assert.equal(basic.passwordSynthetic, true);
  assert.deepEqual(basic.fields, ['binding', 'createdAt', 'expiresAt', 'kind', 'password', 'scheme', 'username', 'version']);
  const published = JSON.parse(basic.publicOutput);
  assert.deepEqual(Object.keys(published).sort(), ['binding', 'credentialRef', 'expiresAt', 'kind', 'ok']); assert.deepEqual(published.binding, basicBinding);
  assert.ok(!basic.publicOutput.includes('synthetic-'));
  for (const username of ['synthetic:user', 'synthetic\u0001user']) {
    const refused = runPs(familyDialogScript, { ttlSeconds: 120, binding: basicBinding, username });
    assert.equal(refused.threw, true); assert.equal(refused.completed, false); assert.equal(refused.exists, false);
  }
  const redact = runPs(familyDialogScript, { ttlSeconds: 120, binding: redactBinding, username: '' });
  assert.equal(redact.completed, true); assert.equal(redact.bound, true); assert.equal(redact.use, 'redact-only');
  assert.equal(redact.boxCount, 2); assert.equal(redact.maskedCount, 2); assert.match(redact.title, /Fixture — Redaction Secret$/);
  assert.deepEqual(redact.roles, redactBinding.roles); assert.deepEqual(redact.synthetic, [true, true]);
  assert.deepEqual(redact.fields, ['binding', 'createdAt', 'expiresAt', 'kind', 'secrets', 'use', 'version']);
  assert.deepEqual(JSON.parse(redact.publicOutput).binding, redactBinding); assert.ok(!redact.publicOutput.includes('synthetic-'));
});

const familySeedScript = loadFunctions + String.raw`
$clearBytes = $null
try {
  Add-Type -AssemblyName System.Security
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $parent = Resolve-DebugStateRoot $fixture.stateBase
  $root = [IO.Path]::GetFullPath((Join-Path $parent 'app-user'))
  foreach ($candidate in @($parent,$root)) { Assert-NoReparse $candidate }
  $reference = ConvertTo-CredentialReference $fixture.credentialRef
  if ($null -ne $fixture.binding.PSObject.Properties['use']) { $canonical = ConvertTo-RedactionBinding $fixture.binding } else { $canonical = ConvertTo-EndpointBinding $fixture.binding }
  $file = Join-Path $root ($reference + '.dpapi')
  $exists = [IO.File]::Exists($file) -or [IO.File]::Exists((Join-Path $root ($reference + '.tmp')))
  if ($fixture.mode -eq 'exists') { [Console]::Out.Write((@{ok=$true;exists=$exists} | ConvertTo-Json -Compress)) }
  else {
    if ($exists) { Fail 'synthetic_reference_collision' }
    if (-not [IO.Directory]::Exists($root)) { Set-PrivateDirectory $root $sid }
    Assert-PrivateDirectory $root $sid
    $now = [DateTimeOffset]::UtcNow
    if ($fixture.mode -eq 'expired') { $created = $now.AddSeconds(-700) } else { $created = $now }
    $record = [ordered]@{version=1;kind='endpoint-credential';binding=$canonical;createdAt=$created.ToString('o');expiresAt=$created.AddSeconds(600).ToString('o')}
    foreach ($property in $fixture.payload.PSObject.Properties) { $record[$property.Name] = $property.Value }
    $clearBytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 8 -Compress))
    $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $reference)
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $stream = [IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($encrypted,0,$encrypted.Length) } finally { $stream.Dispose() }
    Assert-PrivateFile $file $sid
    [Console]::Out.Write('{"ok":true}')
  }
} catch {
  [Console]::Out.Write('{"ok":false,"error":"synthetic_fixture_failed"}')
  exit 1
} finally {
  if ($null -ne $clearBytes) { [Array]::Clear($clearBytes,0,$clearBytes.Length) }
  $fixture = $null
  $record = $null
}
`;
const familySeed = (record, mode = record.mode) => runPs(familySeedScript, { ...record, mode, stateBase }, 15000);
const familyDescriptor = (record, extra = {}) => ({ credentialRef: record.credentialRef, binding: record.binding, expiresAt: new Date(Date.now() + 600000).toISOString(), kind: 'endpoint-credential', ...extra });
const basicPair = { username: 'synthetic-basic-user', password: 'synthetic basic:passé' };
const basicB64 = Buffer.from(basicPair.username + ':' + basicPair.password, 'utf8').toString('base64');

test('the original private helper round-trips a synthetic Basic endpoint credential, refuses a ":" username or another binding, and releases it', { skip: !isWindows }, async () => {
  const target = { ...basicBinding, sessionId: randomUUID().replaceAll('-', '') };
  const records = [
    { credentialRef: randomUUID(), binding: target, payload: { scheme: 'basic', ...basicPair }, mode: 'seed' },
    { credentialRef: randomUUID(), binding: target, payload: { scheme: 'basic', username: 'synthetic:user', password: 'synthetic' }, mode: 'seed' },
    { credentialRef: randomUUID(), binding: target, payload: { scheme: 'basic', ...basicPair }, mode: 'expired' },
    { credentialRef: randomUUID(), binding: target, payload: { headers: [{ name: 'Authorization', value: 'synthetic-header' }] }, mode: 'seed' },
  ];
  try {
    for (const record of records) familySeed(record);
    let opened = await privateAppUserVault('read', familyDescriptor(records[0]));
    assert.deepEqual(Object.keys(opened).sort(), ['binding', 'expiresAt', 'kind', 'ok', 'password', 'scheme', 'username']);
    assert.equal(opened.kind, 'endpoint-credential'); assert.equal(opened.scheme, 'basic'); assert.deepEqual(opened.binding, target);
    assert.equal(opened.username, basicPair.username); assert.equal(opened.password, basicPair.password); opened = null;
    const values = await privateEndpointCredentialValues(familyDescriptor(records[0]));
    assert.deepEqual(values, [basicPair.username, basicPair.password, basicB64, 'Basic ' + basicB64]);
    for (const record of records.slice(1)) await assert.rejects(privateAppUserVault('read', familyDescriptor(record)), /debug_app_user_credentials_unavailable/);
    const { scheme: _s, ...header } = target;
    for (const binding of [header, { ...target, revision: 8 }, { ...target, serviceKey: 'C'.repeat(22) }, { ...target, sessionId: 'f'.repeat(32) }])
      await assert.rejects(privateAppUserVault('read', { ...familyDescriptor(records[0]), binding }), /debug_app_user_credentials_unavailable/);
    assert.equal(familySeed(records[0], 'exists').exists, true);
    assert.deepEqual(await releaseEndpointCredential(familyDescriptor(records[0])), { ok: true, forgotten: true });
    assert.equal(familySeed(records[0], 'exists').exists, false);
  } finally {
    for (const record of records) await privateAppUserVault('forget', familyDescriptor(record)).catch(() => {});
    for (const record of records) assert.equal(familySeed(record, 'exists').exists, false);
  }
});

test('basic binding, prepare and private values: Authorization only, no value in request JSON or argv, all four forms zeroed after use', async () => {
  const input = { lane: 'odc', runtimeUrl: 'https://fixture-dev.outsystems.app/Fixture/', module: 'Fixture', moduleKey: 'A'.repeat(22), revision: 7, serviceKey: 'B'.repeat(22), scheme: 'basic' };
  assert.deepEqual(endpointCredentialBinding(input, sessionId), basicBinding);
  assert.deepEqual(endpointCredentialBinding({ ...input, headers: ['Authorization'] }, sessionId), basicBinding);
  const { scheme: _s, ...headerInput } = input;
  assert.equal(Object.hasOwn(endpointCredentialBinding({ ...headerInput, scheme: 'header', headers: ['X-Api-Key'] }, sessionId), 'scheme'), false);
  for (const patch of [{ scheme: 'digest' }, { headers: ['X-Api-Key'] }, { headers: ['Authorization', 'X-Other'] }, { headers: ['authorization'] }, { use: 'redact-only' }])
    assert.throws(() => endpointCredentialBinding({ ...input, ...patch }, sessionId), /debug_app_user_endpoint_credential_invalid_target/);
  const { scheme: _x, ...headerOnly } = basicBinding;
  assert.equal(sameEndpointCredentialTarget(basicBinding, basicBinding), true); assert.equal(sameEndpointCredentialTarget(basicBinding, headerOnly), false);
  const calls = [];
  const vault = async (mode, request) => { calls.push([mode, JSON.stringify(request)]);
    return mode === 'prompt-endpoint' ? { ok: true, kind: 'endpoint-credential', credentialRef: request.credentialRef, binding: request.binding, expiresAt: new Date(Date.now() + 120000).toISOString() } : { ok: true, forgotten: true }; };
  const prepared = await prepareEndpointCredential({ ...input, seconds: 120 }, { vault, expire: async () => {}, sessionId });
  assert.equal(prepared.ok, true); assert.deepEqual(prepared.descriptor.binding, basicBinding);
  assert.deepEqual(Object.keys(JSON.parse(calls[0][1])).sort(), ['binding', 'credentialRef', 'ttlSeconds']);
  for (const key of ['username', 'password', 'credentials', 'values', 'token'])
    await assert.rejects(prepareEndpointCredential({ ...input, [key]: 'synthetic' }, { vault, expire: async () => {}, sessionId }), /debug_app_user_endpoint_credential_invalid_target/);
  assert.equal(calls.length, 1);
  // Private values: username, password, b64 and 'Basic '+b64, from the exact bound basic record only.
  const descriptor = { credentialRef: randomUUID(), binding: basicBinding, expiresAt: new Date(Date.now() + 60000).toISOString(), kind: 'endpoint-credential' };
  const good = () => ({ ok: true, kind: 'endpoint-credential', scheme: 'basic', binding: basicBinding, expiresAt: descriptor.expiresAt, ...basicPair });
  let opened;
  const reader = patch => async mode => { assert.equal(mode, 'read'); opened = { ...good(), ...patch }; return opened; };
  assert.deepEqual(await privateEndpointCredentialValues(descriptor, { vault: reader({}) }), [basicPair.username, basicPair.password, basicB64, 'Basic ' + basicB64]);
  assert.equal(opened.username, ''); assert.equal(opened.password, '');
  for (const patch of [{ username: 'a:b' }, { username: 'a\nb' }, { password: '' }, { password: 'a\rb' }, { scheme: undefined }, { kind: 'credentials' },
    { binding: headerOnly }, { binding: { ...basicBinding, revision: 8 } }, { expiresAt: new Date(Date.now() - 1000).toISOString() }, { headers: [{ name: 'Authorization', value: 'x' }], scheme: undefined }])
    await assert.rejects(privateEndpointCredentialValues(descriptor, { vault: reader(patch) }), /debug_app_user_credentials_unavailable/, JSON.stringify(patch));
  // The worker composes Authorization once from the record; the composed header lives on record.headers so the caller's finally zeroes it.
  const record = good(), headers = endpointCredentialRecordHeaders(record, validateEndpointCredentialDescriptor(descriptor));
  assert.deepEqual(headers, [{ name: 'Authorization', value: 'Basic ' + basicB64 }]); assert.equal(record.headers, headers);
  assert.throws(() => endpointCredentialRecordHeaders({ ...good(), username: 'a:b' }, validateEndpointCredentialDescriptor(descriptor)), /debug_app_user_credentials_unavailable/);
  assert.throws(() => endpointCredentialRecordHeaders({ ok: true, kind: 'endpoint-credential', binding: basicBinding, expiresAt: descriptor.expiresAt, headers: [{ name: 'Authorization', value: 'x' }] },
    validateEndpointCredentialDescriptor(descriptor)), /debug_app_user_credentials_unavailable/);
  assert.deepEqual(basicAuthorizationForms(basicPair.username, basicPair.password), { username: basicPair.username, password: basicPair.password, b64: basicB64, authorization: 'Basic ' + basicB64 });
  for (const [u, p] of [['a:b', 'p'], ['', 'p'], ['u', ''], ['u', 'p\n'], [1, 'p']]) assert.throws(() => basicAuthorizationForms(u, p), /debug_app_user_credentials_unavailable/);
});

test('endpoint profile is explicit: remember/resolve are keyed by lane|runtimeUrl|module|serviceKey|scheme and never run implicitly', async () => {
  assert.equal(endpointProfileKey(basicBinding), 'odc|https://fixture-dev.outsystems.app/Fixture/|Fixture|' + 'B'.repeat(22) + '|basic');
  assert.equal(endpointProfileKey(endpointBinding), 'o11|https://fixture.dev/Fixture/|Fixture|' + 'B'.repeat(22) + '|header');
  assert.throws(() => endpointProfileKey(redactBinding), /debug_app_user_endpoint_credential_invalid_target/);
  const input = { lane: 'odc', runtimeUrl: 'https://fixture-dev.outsystems.app/Fixture/', module: 'Fixture', moduleKey: 'A'.repeat(22), revision: 7, serviceKey: 'B'.repeat(22), scheme: 'basic', seconds: 120 };
  const run = async (profile, found) => {
    const calls = [];
    const vault = async (mode, request) => { calls.push([mode, structuredClone(request)]);
      const entered = { ok: true, kind: 'endpoint-credential', credentialRef: request.credentialRef, binding: request.binding, expiresAt: new Date(Date.now() + 120000).toISOString() };
      if (mode === 'resolve-endpoint-profile') return found ? { ...entered, found: true, source: 'endpoint-profile' } : { ok: true, found: false };
      if (mode === 'remember-endpoint-profile') return { ok: true, remembered: true };
      return mode === 'prompt-endpoint' ? entered : { ok: true, forgotten: true }; };
    let armed = 0;
    const result = await prepareEndpointCredential(input, { vault, expire: async () => { armed++; }, sessionId, ...(profile ? { profile } : {}) });
    return { result, calls, armed };
  };
  let { result, calls } = await run(undefined, true);
  assert.deepEqual(calls.map(([mode]) => mode), ['prompt-endpoint']); assert.equal(result.credentialSource, 'private-dialog');
  ({ result, calls } = await run('resolve', true));
  assert.deepEqual(calls.map(([mode]) => mode), ['resolve-endpoint-profile']); assert.equal(result.credentialSource, 'endpoint-profile');
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ['binding', 'credentialRef', 'ttlSeconds']); assert.deepEqual(result.descriptor.binding, basicBinding);
  ({ result, calls } = await run('resolve', false));
  assert.deepEqual(calls.map(([mode]) => mode), ['resolve-endpoint-profile', 'prompt-endpoint']); assert.equal(result.credentialSource, 'private-dialog');
  assert.equal(calls[0][1].credentialRef, calls[1][1].credentialRef);
  let armed; ({ result, calls, armed } = await run('remember', false));
  assert.deepEqual(calls.map(([mode]) => mode), ['prompt-endpoint', 'remember-endpoint-profile']); assert.equal(result.profileRemembered, true); assert.equal(armed, 1);
  assert.deepEqual(Object.keys(calls[1][1]).sort(), ['binding', 'credentialRef']); assert.equal(calls[1][1].credentialRef, result.descriptor.credentialRef);
  await assert.rejects(prepareEndpointCredential(input, { profile: 'implicit', vault: async () => assert.fail('no vault call'), sessionId }), /debug_app_user_endpoint_credential_invalid_target/);
  let argv;
  await privateAppUserVault('resolve-endpoint-profile', { credentialRef: randomUUID(), binding: basicBinding, ttlSeconds: 120 }, { spawnImpl: (_c, args, opts) => {
    argv = args; assert.equal(opts.windowsHide, true);
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
    child.stdin.resume(); child.stdin.on('finish', () => { child.stdout.end('{"ok":true,"found":false}'); queueMicrotask(() => child.emit('close', 0)); });
    return child; } });
  assert.equal(argv[argv.indexOf('-Mode') + 1], 'resolve-endpoint-profile'); assert.ok(!argv.join(' ').includes('B'.repeat(22)));
});

test('the original private helper remembers an endpoint profile only on request, resolves it for a new run of the exact key and refuses any other key', { skip: !isWindows }, async () => {
  const profiles = path.join(stateBase, 'endpoint-profiles');
  const first = { ...basicBinding, sessionId: randomUUID().replaceAll('-', '') }, second = { ...first, sessionId: randomUUID().replaceAll('-', ''), revision: 9 };
  const seeded = { credentialRef: randomUUID(), binding: first, payload: { scheme: 'basic', ...basicPair }, mode: 'seed' };
  const resolvedRef = randomUUID(), refs = [seeded.credentialRef, resolvedRef];
  const hashOf = b => createHash('sha256').update(JSON.stringify({ lane: b.lane, runtimeUrl: b.runtimeUrl, module: b.module, serviceKey: b.serviceKey, scheme: b.scheme ?? 'header' })).digest('hex');
  const resolve = (binding, credentialRef = randomUUID()) => privateAppUserVault('resolve-endpoint-profile', { binding, credentialRef, ttlSeconds: 120 });
  try {
    familySeed(seeded);
    assert.deepEqual(await resolve(first), { ok: true, found: false }); assert.equal(fs.existsSync(profiles), false, 'resolve never writes a profile');
    await privateAppUserVault('read', familyDescriptor(seeded));
    assert.equal(fs.existsSync(profiles), false, 'a read never remembers a profile');
    assert.deepEqual(await privateAppUserVault('remember-endpoint-profile', { binding: first, credentialRef: seeded.credentialRef }), { ok: true, remembered: true });
    const files = fs.readdirSync(profiles); assert.deepEqual(files, [hashOf(first) + '.dpapi']);
    const bytes = fs.readFileSync(path.join(profiles, files[0]));
    for (const secret of [basicPair.username, basicPair.password]) { assert.ok(!bytes.includes(Buffer.from(secret, 'utf8'))); assert.ok(!bytes.includes(Buffer.from(secret, 'utf16le'))); }
    const resolved = await resolve(second, resolvedRef);
    assert.deepEqual(Object.keys(resolved).sort(), ['binding', 'credentialRef', 'expiresAt', 'found', 'kind', 'ok', 'source']);
    assert.equal(resolved.found, true); assert.equal(resolved.source, 'endpoint-profile'); assert.deepEqual(resolved.binding, second); assert.equal(resolved.credentialRef, resolvedRef);
    const opened = await privateAppUserVault('read', familyDescriptor({ credentialRef: resolvedRef, binding: second }));
    assert.deepEqual(opened.binding, second); assert.equal(opened.username, basicPair.username); assert.equal(opened.password, basicPair.password);
    const { scheme: _s, ...header } = second;
    const others = [{ ...second, serviceKey: 'C'.repeat(22) }, { ...header, headers: ['Authorization'] }, { ...second, module: 'Other' },
      { ...second, runtimeUrl: 'https://other-dev.outsystems.app/Fixture/' }, { ...second, lane: 'o11' }];
    for (const binding of others) assert.deepEqual(await resolve(binding), { ok: true, found: false }, JSON.stringify(binding));
    // A profile copied under another key's name does not open: its DPAPI entropy carries its own key.
    fs.copyFileSync(path.join(profiles, files[0]), path.join(profiles, hashOf(others[0]) + '.dpapi'));
    await assert.rejects(resolve(others[0]), /debug_app_user_credentials_unavailable/);
    fs.rmSync(path.join(profiles, hashOf(others[0]) + '.dpapi'));
    for (const mode of ['remember-endpoint-profile', 'resolve-endpoint-profile', 'forget-endpoint-profile'])
      await assert.rejects(privateAppUserVault(mode, { binding: redactBinding, credentialRef: randomUUID(), ttlSeconds: 120 }), /debug_app_user_credentials_unavailable/);
    assert.deepEqual(await forgetEndpointProfile(second), { ok: true, forgotten: true }); assert.deepEqual(fs.readdirSync(profiles), []);
    assert.deepEqual(await resolve(second), { ok: true, found: false });
  } finally {
    for (const [credentialRef, binding] of [[seeded.credentialRef, first], [resolvedRef, second]]) await privateAppUserVault('forget', familyDescriptor({ credentialRef, binding })).catch(() => {});
    fs.rmSync(profiles, { recursive: true, force: true });
    for (const credentialRef of refs) assert.equal(familySeed({ credentialRef, binding: first }, 'exists').exists, false);
  }
});

test('redact-only binding and descriptor: names only, never an endpoint credential', () => {
  const input = { lane: 'odc', runtimeUrl: 'https://fixture-dev.outsystems.app/Fixture/', module: 'Fixture', moduleKey: 'A'.repeat(22), revision: 7, roles: redactBinding.roles };
  assert.deepEqual(redactionSecretBinding(input, sessionId), redactBinding); assert.deepEqual(redactionSecretBinding(redactBinding, sessionId), redactBinding);
  for (const patch of [{ roles: [] }, { roles: ['bad role'] }, { roles: ['A', 'a'] }, { roles: [{ role: 'R', value: 'synthetic' }] }, { serviceKey: 'B'.repeat(22) },
    { headers: ['X'] }, { scheme: 'basic' }, { use: 'other' }, { revision: 0 }, { runtimeUrl: 'http://fixture.dev/Fixture/' }])
    assert.throws(() => redactionSecretBinding({ ...input, ...patch }, sessionId), /debug_app_user_redaction_secret_invalid_target/);
  const descriptor = { credentialRef: randomUUID(), binding: redactBinding, expiresAt: new Date(Date.now() + 60000).toISOString(), kind: 'endpoint-credential', use: 'redact-only' };
  assert.deepEqual(validateRedactionSecretDescriptor(descriptor).binding, redactBinding);
  // Endpoint workers validate their context with validateEndpointCredentialDescriptor: a redact-only descriptor never passes it.
  for (const candidate of [descriptor, { ...descriptor, binding: { ...redactBinding, serviceKey: 'B'.repeat(22), headers: ['X-Api-Key'] } },
    { ...descriptor, binding: { ...endpointBinding }, use: 'redact-only' }])
    assert.throws(() => validateEndpointCredentialDescriptor(candidate), /debug_app_user_scope_mismatch/);
  assert.throws(() => validateRedactionSecretDescriptor({ ...descriptor, binding: endpointBinding }), /debug_app_user_scope_mismatch/);
  // A sendable endpoint descriptor carries no use; an explicit use:'send' means the same.
  const sendable = { credentialRef: randomUUID(), binding: basicBinding, expiresAt: descriptor.expiresAt, kind: 'endpoint-credential' };
  for (const use of [undefined, 'send']) assert.deepEqual(validateEndpointCredentialDescriptor({ ...sendable, use }).binding, basicBinding);
  assert.throws(() => validateEndpointCredentialDescriptor({ ...sendable, use: 'other' }), /debug_app_user_scope_mismatch/);
});

test('the original private helper round-trips a synthetic redact-only record, refuses another binding or an expired record, and release or expiry forgets it', { skip: !isWindows }, async () => {
  const target = { ...redactBinding, sessionId: randomUUID().replaceAll('-', '') };
  const secrets = [{ role: 'WsSecurityPassword', value: 'synthetic-ws-secret' }, { role: 'FormClientSecret', value: 'synthetic form&secret' }];
  const records = [
    { credentialRef: randomUUID(), binding: target, payload: { use: 'redact-only', secrets }, mode: 'seed' },
    { credentialRef: randomUUID(), binding: target, payload: { use: 'redact-only', secrets }, mode: 'expired' },
    { credentialRef: randomUUID(), binding: target, payload: { use: 'redact-only', secrets: [secrets[1], secrets[0]] }, mode: 'seed' },
    { credentialRef: randomUUID(), binding: target, payload: { use: 'redact-only', secrets }, mode: 'seed' },
  ];
  const descriptor = record => familyDescriptor(record, { use: 'redact-only' });
  try {
    for (const record of records) familySeed(record);
    let opened = await privateAppUserVault('read', descriptor(records[0]));
    assert.deepEqual(Object.keys(opened).sort(), ['binding', 'expiresAt', 'kind', 'ok', 'secrets', 'use']);
    assert.equal(opened.use, 'redact-only'); assert.deepEqual(opened.secrets, secrets); assert.deepEqual(opened.binding, target); opened = null;
    assert.deepEqual(await privateEndpointCredentialValues(descriptor(records[0])), secrets.map(s => s.value));
    for (const record of records.slice(1, 3)) await assert.rejects(privateAppUserVault('read', descriptor(record)), /debug_app_user_credentials_unavailable/);
    const { use: _u, roles: _r, ...plain } = target;
    for (const binding of [{ ...target, revision: 8 }, { ...target, roles: ['FormClientSecret', 'WsSecurityPassword'] }, { ...target, roles: ['WsSecurityPassword'] },
      { ...target, sessionId: 'f'.repeat(32) }, { ...target, module: 'Other' }, plain, { ...plain, serviceKey: 'B'.repeat(22), headers: ['X-Api-Key'] }])
      await assert.rejects(privateAppUserVault('read', { ...descriptor(records[0]), binding }), /debug_app_user_credentials_unavailable/);
    assert.deepEqual(await releaseRedactionSecret(descriptor(records[0])), { ok: true, forgotten: true });
    assert.equal(familySeed(records[0], 'exists').exists, false);
    // The detached expiry worker forgets a redact-only record with its full binding.
    const worker = fileURLToPath(new URL('../debug-app-user-worker.mjs', import.meta.url));
    const expired = spawnSync(process.execPath, [worker, 'expire'], { input: JSON.stringify({ ...descriptor(records[3]), expiresAt: new Date(Date.now() - 1000).toISOString() }),
      encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, SSAM_DEBUG_STATE_ROOT: stateBase } });
    assert.equal(expired.status, 0); assert.equal(expired.stdout, ''); assert.equal(familySeed(records[3], 'exists').exists, false);
  } finally {
    for (const record of records) await privateAppUserVault('forget', descriptor(record)).catch(() => {});
    for (const record of records) assert.equal(familySeed(record, 'exists').exists, false);
  }
});
