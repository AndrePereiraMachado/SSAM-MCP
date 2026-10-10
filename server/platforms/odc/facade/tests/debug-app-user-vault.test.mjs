import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { privateAppUserVault } from '../debug-app-user.mjs';

const helper = fileURLToPath(new URL('../debug-app-user-vault.ps1', import.meta.url));
const source = fs.readFileSync(helper, 'utf8');
const isWindows = process.platform === 'win32';
const powershell = isWindows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
const sessionId = '0123456789abcdef0123456789abcdef';
const binding = { lane: 'odc', runtimeUrl: 'https://fixture-dev.outsystems.app/Fixture/', app: 'Fixture', sessionId, module: 'Producer', moduleKey: 'A'.repeat(22) };

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
  $localData = [IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData))
  $parent = Join-Path $localData 'SSAM'
  $root = [IO.Path]::GetFullPath((Join-Path $parent 'DebugAppUser'))
  if (-not $root.StartsWith($localData.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)) { Fail 'scope_mismatch' }
  foreach ($candidate in @($localData,$parent,$root)) { Assert-NoReparse $candidate }
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
      input: JSON.stringify({ helper, binding: target, credentialRef, verify }), encoding: 'utf8', windowsHide: true, timeout: 15000,
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
