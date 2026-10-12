// Private continuation state for a prepared solution export. Only the owning
// process receives clear text over its child pipe; no form state goes to args,
// evidence files or tool results. This does not read the Studio's cookie store.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProtocolError } from './errors.mjs';
import { hostName } from './http.mjs';
import { createPowerShellRunner } from './vault.mjs';
import { hostedContext, workspacePath } from '../executor.mjs';

const MAX_CONTEXT = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailable = () => new ProtocolError('Private solution download context is unavailable; do not repeat preparation', 'SC_DOWNLOAD_CONTEXT_UNAVAILABLE');

// The records live outside %LOCALAPPDATA%: each packaged (MSIX) app, such as the Codex and Claude desktop apps, sees a
// private copy of it, so a record kept there is invisible to the other app and its UUID would look new. Copies kept by
// older versions are read in place (never moved, changed or deleted); the first state change copies the record here,
// marked with its origin. Same journal rule as the receipts (index.mjs journalDefault). .ssam-hybrid, never .ssam.
// servidor/fase4-24 (R3 of PLANO-24-PRODUCAO): hosted, the records are the customer's: <ws>/o11/service-center/downloads
// (ws:o11/service-center/downloads), never the profile, SSAM_SC_DOWNLOADS or a %LOCALAPPDATA% copy of the server.
export function downloadRoots(env = process.env) {
  if (hostedContext()) return { root: workspacePath('o11', 'service-center', 'downloads'), legacy: [] };
  const root = path.resolve(env.SSAM_SC_DOWNLOADS || path.join(env.USERPROFILE || os.homedir(), '.ssam-hybrid', 'o11', 'service-center', 'downloads'));
  const legacy = [];
  if (env.LOCALAPPDATA) {
    legacy.push(path.join(env.LOCALAPPDATA, 'SSAM', 'ServiceCenterDownloads'));
    const packages = path.join(env.LOCALAPPDATA, 'Packages');
    try {
      for (const family of fs.readdirSync(packages, { withFileTypes: true }))
        if (family.isDirectory()) legacy.push(path.join(packages, family.name, 'LocalCache', 'Local', 'SSAM', 'ServiceCenterDownloads'));
    } catch { /* no packaged apps */ }
  }
  const key = dir => process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
  return { root, legacy: legacy.filter(dir => key(dir) !== key(root) && fs.existsSync(dir)) };
}

// A separate namespace from login credentials and debugger state. The per-ID
// lock is an OS handle (released on process death), never an age-based lock.
// Revision comparison and atomic replacement happen while that handle is held.
// Legacy copies are only read: the same ID with different content is ambiguous.
export const CONTEXT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$lock = $null
$temp = $null
try {
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
  if ($request.id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
      $request.binding -cnotmatch '^[0-9a-f]{64}$' -or $request.mode -notin @('read','find','create','replace') -or
      -not [IO.Path]::IsPathRooted([string]$request.root)) { throw 'invalid request' }
  Add-Type -AssemblyName System.Security
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $root = [IO.Path]::GetFullPath([string]$request.root)
  $null = [IO.Directory]::CreateDirectory($root)
  if (([IO.File]::GetAttributes($root) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'invalid directory' }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
  [IO.Directory]::SetAccessControl($root,$acl)
  $file = Join-Path $root ($request.id + '.dpapi')
  $lockFile = Join-Path $root ($request.id + '.lock')
  foreach ($candidate in @($file,$lockFile)) {
    if ([IO.File]::Exists($candidate) -and (([IO.File]::GetAttributes($candidate) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'invalid file' }
  }
  $lock = [IO.File]::Open($lockFile,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.ServiceCenterDownloads.v1|' + $request.id + '|' + $request.binding)
  $open = {
    param($path)
    if ((([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or (Get-Item -LiteralPath $path).Length -gt 25165824) { throw 'invalid file' }
    $cipher = [IO.File]::ReadAllBytes($path)
    $clear = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser))
    $record = $clear | ConvertFrom-Json
    if ($record.binding -cne $request.binding -or $record.id -cne $request.id -or $record.schema -ne 1) { throw 'binding mismatch' }
    @{record=$record;clear=$clear;sha256=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($cipher)) -replace '-','').ToLowerInvariant()}
  }
  $found = @(foreach ($dir in @($request.legacy | Where-Object { $_ })) {
    $candidate = Join-Path ([IO.Path]::GetFullPath([string]$dir)) ($request.id + '.dpapi')
    if ([IO.File]::Exists($candidate)) { $copy = & $open $candidate; $copy.path = $candidate; $copy }
  })
  $exists = [IO.File]::Exists($file)
  $current = $null
  $origin = $null
  if ($exists) {
    $current = (& $open $file).record
    # The migrated record wins over the copy it came from, as long as that copy is unchanged.
    if ($null -ne $current.origin) {
      $source = @($found | Where-Object { $_.path -eq $current.origin.path })
      if ($source.Count -eq 1 -and $source[0].sha256 -cne $current.origin.sha256) { throw 'ambiguous' }
      $origin = $current.origin
    }
  } elseif ($found.Count -gt 0) {
    $contents = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($copy in $found) { $null = $contents.Add($copy.clear) }
    if ($contents.Count -gt 1) { throw 'ambiguous' }
    $current = $found[0].record
    $origin = @{path=$found[0].path;sha256=$found[0].sha256;revision=[int]$current.revision}
  }
  if ($request.mode -in @('read','find')) {
    if ($null -eq $current) {
      if ($request.mode -ne 'find') { throw 'missing' }
      @{ok=$true;missing=$true} | ConvertTo-Json -Compress
    } else { @{ok=$true;revision=$current.revision;payload=$current.payload;origin=$origin} | ConvertTo-Json -Depth 64 -Compress }
  } else {
    if ($request.mode -eq 'create' -and $null -ne $current) { throw 'already reserved' }
    if ($request.mode -eq 'replace' -and ($null -eq $current -or $request.expectedRevision -ne $current.revision)) { throw 'stale revision' }
    if ($request.payload.Length -gt 8388608 -or $request.payload.Length -eq 0) { throw 'invalid payload' }
    $revision = if ($null -ne $current) { [int]$current.revision + 1 } else { 0 }
    if ($revision -lt 0) { throw 'revision overflow' }
    $envelope = @{schema=1;id=$request.id;binding=$request.binding;revision=$revision;payload=$request.payload}
    if ($null -ne $origin) { $envelope.origin = $origin }
    $envelope = $envelope | ConvertTo-Json -Depth 64 -Compress
    $clear = [Text.Encoding]::UTF8.GetBytes($envelope)
    $cipher = [Security.Cryptography.ProtectedData]::Protect($clear,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $temp = Join-Path $root ($request.id + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $stream = [IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($cipher,0,$cipher.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if ($exists) { [IO.File]::Replace($temp,$file,[NullString]::Value) } else { [IO.File]::Move($temp,$file) }
    $temp = $null
    @{ok=$true;revision=$revision;origin=$origin} | ConvertTo-Json -Depth 8 -Compress
  }
} catch {
  $code = if ($_.Exception.Message -eq 'ambiguous') { 'SC_DOWNLOAD_CONTEXT_AMBIGUOUS' } else { 'SC_DOWNLOAD_CONTEXT_UNAVAILABLE' }
  [Console]::Out.Write('{"ok":false,"code":"' + $code + '"}')
}
finally {
  if ($null -ne $lock) { $lock.Dispose() }
  # Failed encrypted temporary files are retained, never mistaken for committed state.
}
`;

export function downloadBinding({ host, principal, solution, version = 'current-running' }) {
  host = hostName(host);
  if (typeof principal !== 'string' || !principal.trim() || principal !== principal.trim() || principal.length > 320
      || typeof solution !== 'string' || !solution || solution.length > 250 || version !== 'current-running') throw unavailable();
  // Do not lowercase arbitrary usernames or solution names: identity matching
  // belongs to the authenticated resolver, not a lossy continuation comparison.
  return crypto.createHash('sha256').update(JSON.stringify({ host, principal, solution, version })).digest('hex');
}

// servidor/fase4-24 (R3): the hosted store. The same contract as CONTEXT_SCRIPT (read, find, create, replace with the
// expected revision; the binding checked on every read; one exchange per UUID at a time) without PowerShell or DPAPI:
// the Linux image has neither, and DPAPI would bind the record to the server's account, not to the customer. One record
// per UUID, <root>/<id>.context, written atomically in the customer's folder (not .json: ssam_evidence never reads it).
const hostedQueues = new Map();
async function exclusive(key, fn) {
  const prior = hostedQueues.get(key) ?? Promise.resolve();
  let done; const mine = new Promise(resolve => { done = resolve; });
  const chained = prior.then(() => mine);
  hostedQueues.set(key, chained);
  await prior;
  try { return await fn(); } finally { done(); if (hostedQueues.get(key) === chained) hostedQueues.delete(key); }
}
export async function hostedContextRun(_script, request) {
  const { mode, id, binding, root, payload, expectedRevision } = request ?? {};
  const refused = { ok: false, code: 'SC_DOWNLOAD_CONTEXT_UNAVAILABLE' };
  if (!UUID.test(id ?? '') || !/^[0-9a-f]{64}$/.test(binding ?? '') || !['read', 'find', 'create', 'replace'].includes(mode)
    || typeof root !== 'string' || !path.isAbsolute(root)) return refused;
  const file = path.join(root, id + '.context');
  return exclusive(file, async () => {
    try {
      fs.mkdirSync(root, { recursive: true });
      let current = null;
      if (fs.existsSync(file)) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 25165824) return refused;
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (record?.schema !== 1 || record.id !== id || record.binding !== binding || !Number.isInteger(record.revision)) return refused;
        current = record;
      }
      if (mode === 'read' || mode === 'find') {
        if (!current) return mode === 'find' ? { ok: true, missing: true } : refused;
        return { ok: true, revision: current.revision, payload: current.payload, origin: null };
      }
      if (mode === 'create' && current) return refused;
      if (mode === 'replace' && (!current || expectedRevision !== current.revision)) return refused;
      if (typeof payload !== 'string' || !payload.length || payload.length > MAX_CONTEXT) return refused;
      const revision = current ? current.revision + 1 : 0;
      const temp = path.join(root, id + '.' + crypto.randomUUID() + '.tmp');
      fs.writeFileSync(temp, JSON.stringify({ schema: 1, id, binding, revision, payload }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
      return { ok: true, revision, origin: null };
    } catch { return refused; }
  });
}

export class DownloadContextStore {
  // roots: {root, legacy}; by default read from the environment on every call (downloadRoots). run: by default the
  // PowerShell DPAPI store of this machine, and hosted the customer's store (hostedContextRun), chosen on every call.
  constructor({ run = null, roots = null } = {}) { this.run = run; this.roots = roots; this.local = null; }
  runner() { return this.run ?? (hostedContext() ? hostedContextRun : (this.local ??= createPowerShellRunner({ timeoutMs: 10000 }))); }

  async exchange(mode, id, identity, payload, expectedRevision) {
    if (!UUID.test(id ?? '')) throw unavailable();
    const binding = downloadBinding(identity);
    if (mode === 'replace' && (!Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= 2147483647)) throw unavailable();
    const { root, legacy } = this.roots ?? downloadRoots();
    let serialized, ambiguous = false;
    try {
      if (!['read','find'].includes(mode)) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw unavailable();
        serialized = JSON.stringify(payload);
        if (Buffer.byteLength(serialized) > MAX_CONTEXT) throw unavailable();
      }
      const answer = await this.runner()(CONTEXT_SCRIPT, { mode, id, binding, root, legacy, payload: serialized, expectedRevision });
      ambiguous = answer?.code === 'SC_DOWNLOAD_CONTEXT_AMBIGUOUS';
      if (mode === 'find' && answer?.ok === true && answer.missing === true) return null;
      if (answer?.ok !== true || !Number.isInteger(answer.revision) || answer.revision < 0) throw unavailable();
      const origin = answer.origin && typeof answer.origin.path === 'string' && /^[0-9a-f]{64}$/.test(answer.origin.sha256 ?? '')
        ? { origin: { path: answer.origin.path, sha256: answer.origin.sha256, revision: answer.origin.revision } } : {};
      if (mode === 'read' || mode === 'find') {
        if (typeof answer.payload !== 'string' || Buffer.byteLength(answer.payload) > MAX_CONTEXT) throw unavailable();
        const context = JSON.parse(answer.payload);
        if (!context || typeof context !== 'object' || Array.isArray(context)) throw unavailable();
        return { revision: answer.revision, context, ...origin };
      }
      return { revision: answer.revision, ...origin };
    } catch {
      if (ambiguous) throw new ProtocolError('The same download UUID has different records in more than one store; nothing was sent. Reconcile the copies by hand.', 'SC_DOWNLOAD_CONTEXT_AMBIGUOUS');
      throw unavailable();
    }
  }

  read(id, identity) { return this.exchange('read', id, identity); }
  find(id, identity) { return this.exchange('find', id, identity); }
  create(id, identity, context) { return this.exchange('create', id, identity, context); }
  replace(id, identity, revision, context) { return this.exchange('replace', id, identity, context, revision); }
}
