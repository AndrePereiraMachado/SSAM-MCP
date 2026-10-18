import './fixtures/isolated-profile.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generate, checkMatrix, debugMatrix, parseMatrixCli, runMatrixCli, registerMatrixTool, validateSource, validateLimits,
  docPointer, odcProfile, fileVersion, REQUIRED_LIMITS, DEFAULT_SOURCE, DEFAULT_LIMITS } from '../debug-final-matrix.mjs';
import { workspaceRoot } from '../workspace.mjs';
import { COVERAGE_TYPES as TYPES } from '../debug-type-coverage.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const facade = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LANES = ['o11', 'odc'];
const STAGE = 'c25f532e-de28-430d-b864-79f830ce6cb7';
const COUNTERS = { networkRequests: 8, executeRequestSubmissions: 1, negotiations: 1, socketConnections: 0, longPollingConnections: 1, longPollingSendRequests: 2 };
// Evidence files record their own surface; the matrix only trusts a transport the file attests.
const M = { ok: true, transport: 'public-mcp' }, C = { ok: true, transport: 'root-cli-json-lines' };
const roots = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'final-matrix-')), base = path.join(root, '.local', 'debugger');
  roots.push(root);
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); fs.writeFileSync(file, bytes); return sha(bytes); };
  const put = (rel, value) => write(path.join(base, rel), value);
  write(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/claude/x\n');
  write(path.join(root, '.git', 'refs', 'heads', 'claude', 'x'), 'a'.repeat(40) + '\n');
  write(path.join(root, 'platforms', 'odc', 'facade', 'debug-alpha.mjs'), 'export const a = 1;\n');
  write(path.join(root, 'platforms', 'odc', 'facade', 'other.mjs'), 'not in the tree\n');
  write(path.join(root, 'kernel', 'debug', 'shared', 'A.cs'), 'class A {}\n');
  write(path.join(root, 'kernel', 'debug', 'o11', 'bin', 'x.dll'), 'build output, not in the tree\n');
  const pe = Buffer.concat([Buffer.alloc(64, 7), Buffer.from('FileVersion\0', 'utf16le'), Buffer.alloc(2), Buffer.from('1.7.27.10846\0', 'utf16le'), Buffer.alloc(16)]);
  const dll = write(path.join(root, 'studio-odc', 'OutSystems.ServiceStudio.PluginAPI.dll'), pe);
  write(path.join(root, 'studio-odc', 'ODCStudio.exe'), pe);
  const report = path.join(base, 'test-reports', 'node', 'run.txt');
  put('test-reports/node/run.txt', '✔ one (1ms)\n✔ two (1ms)\n✖ three (1ms)\nℹ tests 3\nℹ pass 2\nℹ fail 1\n');
  const old = new Date('2026-01-01T00:00:00Z'); fs.utimesSync(report, old, old);
  put('builds/o11/0011223344556677/ready.json', { built: true }); put('builds/o11/0011223344556677/SSAM.Debugger.dll', 'worker');
  return { root, base, put, write, dll, studioDirs: { o11: path.join(root, 'studio-o11'), odc: path.join(root, 'studio-odc') } };
}
const pin = (rel, hash, transport, extra = {}) => ({ path: rel, sha256: hash, transport, operationId: 'op-' + transport, sessionId: 'sess-' + transport, predicates: ['/ok==true'], live: true, ...extra });
const sub = (id, extra = {}) => ({ id, text: 'criterion ' + id, kind: 'proof', pins: [], nativeLimits: [], ...extra });
function source(overrides = {}, extra = {}) {
  const requirements = Array.from({ length: 19 }, (_, i) => ({ id: i + 1, title: 'Requirement ' + (i + 1),
    lanes: Object.fromEntries(LANES.map(lane => [lane, { subCriteria: overrides[(i + 1) + '.' + lane] ?? [sub((i + 1) + '.' + lane + '.a')] }])) }));
  return { schema: 'ssam-debugger-matrix-source/1', root: '.local/debugger', fingerprint: { installed: [], odc: null }, typeAudits: [], typeLimits: [], requirements, ...extra };
}
const limitsFile = (limits = []) => ({ schema: 'ssam-debugger-native-limits/1', limits });
function files(f, src, limits = limitsFile()) {
  const sourcePath = path.join(f.root, 'manifest', 'matrix-source.json'), limitsPath = path.join(f.root, 'manifest', 'native-limits.json');
  f.write(sourcePath, JSON.stringify(src, null, 1)); f.write(limitsPath, JSON.stringify(limits, null, 1));
  return { root: f.root, sourcePath, limitsPath, studioDirs: f.studioDirs, seedEvidence: {}, inventory: () => inventory() };
}
const inventory = (locks = []) => ({ ok: true, schema: 'ssam-debugger-lock-inventory/1', readOnly: true, root: '.local/debugger', locks, blockedBindings: [],
  counts: { total: locks.length, byLane: {}, byClass: {} }, classes: { 'inert-synthetic': 'placeholder' } });
const find = (matrix, req, lane) => matrix.requirements.find(r => r.id === req).lanes[lane];

test('shipped matrix-source.json and native-limits.json are valid and cover 19 requirements on both lanes', () => {
  const src = JSON.parse(fs.readFileSync(DEFAULT_SOURCE, 'utf8')), limits = JSON.parse(fs.readFileSync(DEFAULT_LIMITS, 'utf8'));
  assert.deepEqual(validateSource(src).errors, []);
  assert.deepEqual(validateLimits(limits).errors, []);
  assert.deepEqual(src.requirements.map(r => r.id), Array.from({ length: 19 }, (_, i) => i + 1));
  const ids = new Set(limits.limits.map(l => l.id));
  for (const id of REQUIRED_LIMITS) assert.ok(ids.has(id), 'missing native limit ' + id);
  for (const r of src.requirements) for (const lane of LANES) {
    assert.ok(r.lanes[lane].subCriteria.length > 0, r.id + lane);
    for (const s of r.lanes[lane].subCriteria) {
      for (const id of s.nativeLimits) assert.ok(ids.has(id), s.id + ' -> ' + id);
      for (const p of s.pins) for (const key of ['path', 'sha256', 'transport', 'operationId', 'sessionId']) assert.ok(key in p, s.id + ' pin ' + key);
    }
  }
  for (const l of limits.limits.filter(l => l.kind === 'installed-assembly'))
    assert.ok(l.assembly.sha256 && l.assembly.fileVersion && l.type && l.member && l.evidence.length, l.id);
  // Validation catches the shapes it must refuse.
  assert.ok(validateSource({ ...src, requirements: src.requirements.slice(1) }).errors.length);
  assert.ok(validateLimits(limitsFile([{ id: 'x', lane: 'o11', title: 't', kind: 'installed-assembly', evidence: [] }])).errors.length);
});

test('shipped pins and native-limit evidence match the local evidence files when present', t => {
  const src = JSON.parse(fs.readFileSync(DEFAULT_SOURCE, 'utf8')), limits = JSON.parse(fs.readFileSync(DEFAULT_LIMITS, 'utf8'));
  const base = path.join(workspaceRoot, '.local', 'debugger');
  const pins = [...src.requirements.flatMap(r => LANES.flatMap(l => r.lanes[l].subCriteria.flatMap(s => s.pins))), ...src.typeAudits,
    ...limits.limits.flatMap(l => l.evidence ?? [])];
  const present = pins.filter(p => fs.existsSync(path.join(base, p.path)));
  if (!present.length) return t.skip('no local debugger evidence');
  for (const p of present) assert.equal(sha(fs.readFileSync(path.join(base, p.path))), p.sha256, p.path);
});

test('hash mismatch opens the cell, MCP-only stays partial, MCP+CLI with predicates closes', async () => {
  const f = fixture();
  const mcp = f.put('a/mcp.json', M), cli = f.put('a/cli.json', C), changed = f.put('a/changed.json', C);
  f.put('a/changed.json', { ...C, edited: 1 });
  const src = source({
    '3.o11': [sub('3.o11.a', { pins: [pin('a/mcp.json', mcp, 'mcp'), pin('a/cli.json', cli, 'cli')] })],
    '3.odc': [sub('3.odc.a', { pins: [pin('a/mcp.json', mcp, 'mcp')] })],
    '4.o11': [sub('4.o11.a', { pins: [pin('a/mcp.json', mcp, 'mcp'), pin('a/changed.json', changed, 'cli')] })],
    '4.odc': [sub('4.odc.a', { pins: [pin('a/mcp.json', mcp, 'mcp', { predicates: ['/ok==false'] }), pin('a/cli.json', cli, 'cli')] })],
    '5.o11': [sub('5.o11.a', { pins: [pin('a/missing.json', mcp, 'mcp'), pin('a/cli.json', cli, 'cli')] })],
  });
  const result = generate({ ...files(f, src), write: false });
  assert.equal(result.ok, true);
  const m = result.matrix;
  assert.equal(find(m, 3, 'o11').status, 'closed');
  assert.equal(find(m, 3, 'odc').status, 'partial');
  const mismatch = find(m, 4, 'o11');
  assert.equal(mismatch.status, 'open');
  assert.ok(mismatch.subCriteria[0].reasons.some(r => r.includes('a/changed.json') && r.includes('hash-mismatch')));
  assert.equal(find(m, 4, 'odc').status, 'open');
  assert.ok(find(m, 4, 'odc').subCriteria[0].pins[0].failed.includes('/ok==false'));
  assert.equal(find(m, 5, 'o11').status, 'open');
  assert.equal(find(m, 1, 'o11').status, 'open', 'no evidence is open, never assumed');
  assert.ok(find(m, 1, 'o11').subCriteria[0].reasons.includes('no-evidence'));
});

test('a transport counts only when the evidence file attests it; a contradicting file opens the cell; pins are live only when marked', () => {
  const f = fixture();
  const mcp = f.put('t/mcp.json', M), cli = f.put('t/cli.json', C), bare = f.put('t/bare.json', { ok: true }), flagged = f.put('t/public.json', { ok: true, publicMcp: true });
  const { live, ...historical } = pin('t/cli.json', cli, 'cli');
  const src = source({
    '7.o11': [sub('7.o11.a', { pins: [pin('t/mcp.json', mcp, 'mcp'), pin('t/bare.json', bare, 'cli')] })],
    '7.odc': [sub('7.odc.a', { pins: [pin('t/cli.json', cli, 'mcp'), pin('t/cli.json', cli, 'cli')] })],
    '8.o11': [sub('8.o11.a', { pins: [pin('t/mcp.json', mcp, 'mcp'), historical] })],
    '8.odc': [sub('8.odc.a', { pins: [pin('t/mcp.json', mcp, 'mcp', { live: false }), historical] })],
    '9.odc': [sub('9.odc.a', { pins: [pin('t/bare.json', bare, 'mcp'), pin('t/bare.json', bare, 'cli')] })],
    '10.odc': [sub('10.odc.a', { pins: [pin('t/public.json', flagged, 'mcp'), pin('t/cli.json', cli, 'cli')] })],
  });
  const m = generate({ ...files(f, src), write: false }).matrix;
  const unattested = find(m, 7, 'o11').subCriteria[0];
  assert.equal(unattested.status, 'partial');
  assert.ok(unattested.reasons.includes('transport-unattested:cli:t/bare.json'), unattested.reasons.join(' '));
  assert.deepEqual(unattested.pins.map(p => p.transportAttested), [true, false]);
  const contradicted = find(m, 7, 'odc').subCriteria[0];
  assert.equal(contradicted.status, 'open');
  assert.equal(contradicted.pins[0].reason, 'transport-mismatch'); assert.equal(contradicted.pins[0].recordedTransport, 'cli');
  assert.equal(find(m, 8, 'o11').status, 'partial', 'a pin without live:true never counts as live');
  assert.equal(find(m, 8, 'odc').status, 'open'); assert.ok(find(m, 8, 'odc').subCriteria[0].reasons.includes('no-live-proof'));
  assert.equal(find(m, 9, 'odc').status, 'partial', 'manifest-only attribution can never close a cell');
  assert.equal(find(m, 10, 'odc').status, 'closed', 'publicMcp:true attests the MCP surface');
});

test('synthetic d{64}/e{64} hashes are rejected', () => {
  const f = fixture();
  f.put('a/x.json', { ok: true });
  for (const fake of ['d'.repeat(64), 'e'.repeat(64)]) {
    const src = source({ '6.o11': [sub('6.o11.a', { pins: [pin('a/x.json', fake, 'mcp'), pin('a/x.json', fake, 'cli')] })] });
    const cell = find(generate({ ...files(f, src), write: false }).matrix, 6, 'o11');
    assert.equal(cell.status, 'open');
    assert.ok(cell.subCriteria[0].pins.every(p => p.reason === 'synthetic-pin'));
  }
});

test('a native limit without evidence is open; with verified evidence and matching installed DLL it is documented', () => {
  const f = fixture();
  const receipt = f.put('limits/decompilation.cs', 'class DebuggerAdapterV3 { void SuspendAllThreads() => throw new InvalidOperationException(); }');
  const assembly = { name: 'OutSystems.ServiceStudio.PluginAPI.dll', fileVersion: '1.7.27.10846', sha256: f.dll };
  const limits = limitsFile([
    { id: 'odc-client-suspend-all-threads', lane: 'odc', title: 'SuspendAllThreads', kind: 'installed-assembly', assembly, type: 'T', member: 'M',
      evidence: [{ path: 'limits/decompilation.cs', sha256: receipt }] },
    { id: 'odc-no-evidence', lane: 'odc', title: 'claimed', kind: 'installed-assembly', assembly, type: 'T', member: 'M', evidence: [] },
    { id: 'odc-stale', lane: 'odc', title: 'stale', kind: 'installed-assembly', assembly: { ...assembly, sha256: 'b'.repeat(64) }, type: 'T', member: 'M',
      evidence: [{ path: 'limits/decompilation.cs', sha256: receipt }] },
    { id: 'o11-doc', lane: 'o11', title: 'doc', kind: 'official-doc', url: 'https://success.outsystems.com/documentation/11/debugging_apps/debugging_producer_modules/', evidence: [] }]);
  const src = source({
    '16.odc': [sub('16.odc.a', { kind: 'native-limit', nativeLimits: ['odc-client-suspend-all-threads'] })],
    '16.o11': [sub('16.o11.a', { kind: 'native-limit', nativeLimits: ['o11-doc'] })],
    '11.odc': [sub('11.odc.a', { kind: 'native-limit', nativeLimits: ['odc-no-evidence'] })],
    '11.o11': [sub('11.o11.a', { kind: 'native-limit', nativeLimits: ['odc-stale'] })],
    '7.o11': [sub('7.o11.a', { kind: 'native-limit', nativeLimits: ['not-registered'] })],
  });
  // validateLimits refuses the evidence-less installed-assembly entry; generate must still not trust it.
  assert.ok(validateLimits(limits).errors.some(e => e.includes('odc-no-evidence')));
  const result = generate({ ...files(f, src, limits), write: false, validateLimitsStrict: false });
  const m = result.matrix;
  assert.equal(find(m, 16, 'odc').status, 'closed');
  assert.equal(find(m, 16, 'odc').subCriteria[0].status, 'native-limit');
  assert.equal(find(m, 16, 'o11').subCriteria[0].status, 'native-limit');
  assert.equal(find(m, 11, 'odc').status, 'open');
  assert.equal(find(m, 11, 'o11').status, 'open');
  assert.equal(find(m, 7, 'o11').status, 'open');
  const documented = m.nativeLimits.find(l => l.id === 'odc-client-suspend-all-threads');
  assert.equal(documented.status, 'documented');
  assert.deepEqual(documented.installed, { found: true, sha256: f.dll, fileVersion: '1.7.27.10846', matches: true });
  assert.equal(m.nativeLimits.find(l => l.id === 'odc-stale').status, 'stale-installed-assembly');
  assert.equal(m.nativeLimits.find(l => l.id === 'odc-no-evidence').status, 'open');
  assert.equal(fileVersion(fs.readFileSync(path.join(f.studioDirs.odc, 'ODCStudio.exe'))), '1.7.27.10846');
});

test('BPT is excluded only with evidence (registry row), never by assertion', () => {
  const f = fixture();
  const claimed = source({ '9.o11': [sub('9.o11.b', { kind: 'excluded', reason: 'claimed without evidence' })] });
  assert.ok(validateSource(claimed).errors.some(e => e.includes('excluded needs reason and evidence')));
  assert.equal(generate({ ...files(f, claimed), write: false }).error, 'debug_matrix_source_invalid');
  const src = source({ '9.o11': [sub('9.o11.a', { kind: 'excluded', reason: 'BPT outside the registered goal', registry: 'o11/bpt-original-launch' }),
    sub('9.o11.c', { kind: 'excluded', reason: 'wrong row', registry: 'o11/client-action' })] });
  const cell = find(generate({ ...files(f, src), write: false }).matrix, 9, 'o11');
  assert.deepEqual(cell.subCriteria.map(s => s.status), ['excluded', 'open']);
  assert.ok(cell.subCriteria[1].reasons.includes('registry-row-not-excluded:o11/client-action'));
});

test('ODC native-run profile checks cleanupConfirmed, every transport counter, credentials, lock and uncertainty', () => {
  const receipt = (patch = {}) => ({ schema: 'ssam-odc-native-run/1', operationId: 'op', credentialsReleased: true, lockRetained: false, uncertain: false,
    cleanup: { completed: true, receipt: { cleanupConfirmed: true, transport: { ...COUNTERS, uncertain: false, deadlineExpired: false,
      longPollingCleanupConfirmed: true, longPollingCleanupUncertain: false, probes: [{ probeId: 'p', executeRequestSubmissions: 1, finished: true, uncertain: false }] } } }, ...patch });
  const ok = odcProfile('odc-native-run', receipt());
  assert.equal(ok.ok, true); assert.deepEqual(ok.counters, { ...COUNTERS });
  const bad = r => odcProfile('odc-native-run', r).ok;
  assert.equal(bad(receipt({ credentialsReleased: false })), false);
  assert.equal(bad(receipt({ lockRetained: true })), false);
  assert.equal(bad(receipt({ uncertain: true })), false);
  const r1 = receipt(); r1.cleanup.receipt.cleanupConfirmed = false; assert.equal(bad(r1), false);
  const r2 = receipt(); delete r2.cleanup.receipt.transport.negotiations; assert.equal(bad(r2), false);
  const r3 = receipt(); r3.cleanup.receipt.transport.probes[0].finished = false; assert.equal(bad(r3), false);
  const r4 = receipt(); r4.cleanup.receipt.transport.longPollingCleanupConfirmed = false; assert.equal(bad(r4), false);
  assert.equal(bad({ ...receipt(), schema: 'other/1' }), false);
});

test('ODC mount profile: authorization words hash, single submission/result, staticEffectsQualified:false carried, limits flagged', () => {
  const f = fixture();
  const dir = 'native-runs/odc/11111111-2222-4333-8444-555555555555';
  const authorization = f.put(dir + '/authorization.json', { schema: 'ssam-odc-mount-authorization/1', operationId: 'op', words: 'Development mount authorized' });
  f.put(dir + '/mount-submission.json', { operationId: 'op', metadata: { authorizationSha256: authorization } });
  f.put(dir + '/mount-result.json', { operationId: 'op', metadata: { invoked: true, callbackReturned: true } });
  const report = { schema: 'ssam-odc-native-run/1', operationId: 'op', lifecycle: 'mounted', mountPolicy: 'authorized-development-native-mount',
    staticEffectsQualified: false, authorizationSha256: authorization, mountSubmitted: true, mountOutcome: { invoked: true, callbackReturned: true },
    lifecycleComplete: false, renderVerified: false, appRequestIdentityProved: false, userRequestIsolationProved: false,
    credentialsReleased: true, lockRetained: false, uncertain: false, cleanup: { completed: true } };
  const receipt = f.put(dir + '/receipt.json', report);
  const src = source({ '4.odc': [sub('4.odc.a', { pins: [pin(dir + '/receipt.json', receipt, 'mcp', { predicates: [], profile: { name: 'odc-mount' } })] })] });
  const result = generate({ ...files(f, src), write: false });
  const p = find(result.matrix, 4, 'odc').subCriteria[0].pins[0];
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.profile.name, 'odc-mount');
  assert.equal(p.profile.staticEffectsQualified, false);
  assert.equal(p.profile.authorization.sha256, authorization);
  assert.equal(p.profile.authorization.wordsSha256, sha('Development mount authorized'));
  assert.ok(!JSON.stringify(result.matrix).includes('Development mount authorized'), 'words never copied');
  assert.deepEqual(p.profile.limits, ['lifecycleComplete', 'renderVerified', 'appRequestIdentityProved', 'userRequestIsolationProved']);
  assert.equal(find(result.matrix, 4, 'odc').status, 'partial');
  // staticEffectsQualified:true, a second submission or a changed authorization fail the profile.
  for (const [mutate, reason] of [[r => ({ ...r, staticEffectsQualified: true }), 'staticEffectsQualified'], [r => ({ ...r, authorizationSha256: 'c'.repeat(64) }), 'authorization']]) {
    const g = fixture(), d = dir;
    g.put(d + '/authorization.json', { schema: 'ssam-odc-mount-authorization/1', operationId: 'op', words: 'Development mount authorized' });
    g.put(d + '/mount-submission.json', { operationId: 'op', metadata: {} }); g.put(d + '/mount-result.json', { operationId: 'op', metadata: report.mountOutcome });
    const h = g.put(d + '/receipt.json', mutate(report));
    const s = source({ '4.odc': [sub('4.odc.a', { pins: [pin(d + '/receipt.json', h, 'mcp', { predicates: [], profile: { name: 'odc-mount' } })] })] });
    const q = find(generate({ ...files(g, s), write: false }).matrix, 4, 'odc').subCriteria[0].pins[0];
    assert.equal(q.ok, false, reason); assert.ok(q.profile.failed.some(x => x.includes(reason)), reason + ' ' + JSON.stringify(q.profile.failed));
  }
  const g = fixture();
  const a2 = g.put(dir + '/authorization.json', { schema: 'ssam-odc-mount-authorization/1', operationId: 'op', words: 'w words words' });
  g.put(dir + '/mount-submission.json', { operationId: 'op', metadata: {} }); g.put(dir + '/mount-submission-2.json', { operationId: 'op', metadata: {} });
  g.put(dir + '/mount-result.json', { operationId: 'op', metadata: report.mountOutcome });
  const h2 = g.put(dir + '/receipt.json', { ...report, authorizationSha256: a2 });
  const s2 = source({ '4.odc': [sub('4.odc.a', { pins: [pin(dir + '/receipt.json', h2, 'mcp', { predicates: [], profile: { name: 'odc-mount' } })] })] });
  const q2 = find(generate({ ...files(g, s2), write: false }).matrix, 4, 'odc').subCriteria[0].pins[0];
  assert.equal(q2.ok, false); assert.ok(q2.profile.failed.some(x => x.includes('single')));
});

test('ODC role cycle: permission-set hash before == after; a mismatch opens the cell', () => {
  const f = fixture();
  const cycle = { beforeSha256: 'a'.repeat(64), afterSha256: 'a'.repeat(64), roleRemoved: true };
  const same = f.put('roles/same.json', { ...cycle, transport: 'public-mcp' }), sameCli = f.put('roles/same-cli.json', { ...cycle, transport: 'root-cli-json-lines' });
  const changed = f.put('roles/changed.json', { roleCycle: { beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64) } });
  const src = source({ '1.odc': [sub('1.odc.a', { pins: [pin('roles/same.json', same, 'mcp', { predicates: [], profile: { name: 'odc-role-cycle' } }),
    pin('roles/same-cli.json', sameCli, 'cli', { predicates: [], profile: { name: 'odc-role-cycle' } })] })],
  '2.odc': [sub('2.odc.a', { pins: [pin('roles/changed.json', changed, 'mcp', { predicates: [], profile: { name: 'odc-role-cycle', at: '/roleCycle' } })] })] });
  const m = generate({ ...files(f, src), write: false }).matrix;
  assert.equal(find(m, 1, 'odc').status, 'closed');
  assert.equal(find(m, 2, 'odc').status, 'open');
  assert.ok(find(m, 2, 'odc').subCriteria[0].pins[0].profile.failed.includes('role-set-changed'));
  // Role-key lists are hashed with the roleSetSha256 rule (sorted, unique, lower case); only hashes are emitted.
  const listed = { before: ['B', 'a'], afterRestore: ['a', 'b', 'a'], afterGrant: ['a', 'b', 'temp'] };
  const lists = (after) => odcProfile('odc-role-cycle', listed, { profile: { name: 'odc-role-cycle', beforeList: '/before', afterList: after } });
  const restored = lists('/afterRestore');
  assert.equal(restored.ok, true); assert.equal(restored.beforeSha256, sha(JSON.stringify(['a', 'b'])));
  assert.deepEqual(lists('/afterGrant').failed, ['role-set-changed']);
  assert.ok(!JSON.stringify(restored).includes('temp'));
});

test('ODC settings restore compares value and origin; ApplicationLevelDefault -> ApplicationLevelOverride is flagged, not identical', () => {
  const f = fixture();
  const audit = { cases: [{}, {}, { configurationBefore: { value: '17', valueOrigin: 'ApplicationLevelDefault' },
    configurationAfterRestoration: { value: '17', valueOrigin: 'ApplicationLevelOverride' } },
  { configurationBefore: { value: '17', valueOrigin: 'ApplicationLevelOverride' }, configurationAfterRestoration: { value: '17', valueOrigin: 'ApplicationLevelOverride' } }] };
  const h = f.put('item13/audit.json', audit);
  const profile = i => ({ name: 'odc-settings-restore', before: `/cases/${i}/configurationBefore`, after: `/cases/${i}/configurationAfterRestoration` });
  const src = source({ '13.odc': [sub('13.odc.a', { pins: [pin('item13/audit.json', h, 'mcp', { predicates: [], profile: profile(2) })] })],
    '14.odc': [sub('14.odc.a', { pins: [pin('item13/audit.json', h, 'mcp', { predicates: [], profile: profile(3) })] })] });
  const m = generate({ ...files(f, src), write: false }).matrix;
  const flagged = find(m, 13, 'odc').subCriteria[0].pins[0].profile;
  assert.equal(flagged.valueRestored, true);
  assert.equal(flagged.originRestored, false);
  assert.deepEqual(flagged.flags, ['origin-changed:ApplicationLevelDefault->ApplicationLevelOverride']);
  assert.equal(find(m, 13, 'odc').status, 'open');
  assert.equal(find(m, 14, 'odc').subCriteria[0].pins[0].profile.ok, true);
  assert.ok(!JSON.stringify(flagged).includes('"17"'), 'setting values are compared, not copied');
});

test('fingerprint: git HEAD, tree hash of facade debug*.mjs and kernel/debug/**, worker builds, installed DLLs, ODC stage/fixture, stale test report', () => {
  const f = fixture();
  const receipt = f.put('native-runs/odc/r/receipt.json', { binding: { environmentKey: STAGE, revision: 3, module: 'Fixture' } });
  const submission = f.put('native-runs/odc/r/mount-submission.json', { metadata: { sourceSha256: 'f'.repeat(64) } });
  const src = source({}, { fingerprint: { installed: [{ lane: 'odc', name: 'ODCStudio.exe' }, { lane: 'o11', name: 'ServiceStudio.exe' }],
    odc: { stageKey: STAGE, fixture: { pin: { path: 'native-runs/odc/r/receipt.json', sha256: receipt }, environmentKey: '/binding/environmentKey', revision: '/binding/revision', module: '/binding/module' },
      snapshot: { pin: { path: 'native-runs/odc/r/mount-submission.json', sha256: submission }, sourceSha256: '/metadata/sourceSha256' } } } });
  const opts = files(f, src);
  const run = generate({ ...opts, write: false }), first = run.matrix.fingerprint;
  // git HEAD is reported beside the matrix, never hashed into it: committing the matrix must not invalidate it.
  assert.deepEqual(run.git, { ref: 'refs/heads/claude/x', head: 'a'.repeat(40) });
  assert.equal(first.git, undefined); assert.ok(!run.json.includes('a'.repeat(40)) && !run.markdown.includes('a'.repeat(40)));
  assert.deepEqual(first.tree.files, ['kernel/debug/shared/A.cs', 'platforms/odc/facade/debug-alpha.mjs']);
  assert.deepEqual(first.installed.map(i => [i.lane, i.name, i.found, i.fileVersion]), [['odc', 'ODCStudio.exe', true, '1.7.27.10846'], ['o11', 'ServiceStudio.exe', false, null]]);
  assert.deepEqual(first.odc, { stageKey: STAGE, studioVersion: '1.7.27.10846', fixture: { ok: true, module: 'Fixture', revision: 3, environmentKey: STAGE, stageMatches: true,
    path: 'native-runs/odc/r/receipt.json', sha256: receipt }, snapshot: { ok: true, sourceSha256: 'f'.repeat(64), path: 'native-runs/odc/r/mount-submission.json', sha256: submission } });
  assert.equal(first.workerBuilds.o11.key, '0011223344556677'); assert.equal(first.workerBuilds.o11.dllSha256, sha('worker'));
  assert.equal(first.workerBuilds.odc, null);
  assert.equal(first.testReports.node.stale, true); assert.deepEqual([first.testReports.node.passed, first.testReports.node.failed], [2, 1]);
  assert.equal(first.testReports.dotnet, null);
  f.write(path.join(f.root, 'kernel', 'debug', 'shared', 'A.cs'), 'class A { int x; }\n');
  assert.notEqual(generate({ ...opts, write: false }).matrix.fingerprint.tree.sha256, first.tree.sha256);
  f.write(path.join(f.root, 'platforms', 'odc', 'facade', 'other.mjs'), 'changed but outside the tree\n');
  const third = generate({ ...opts, write: false }).matrix.fingerprint.tree.sha256;
  f.write(path.join(f.base, 'test-reports', 'node', 'fresh.txt'), '✔ ok (1ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0\n');
  const fresh = generate({ ...opts, write: false }).matrix.fingerprint;
  assert.equal(fresh.tree.sha256, third); assert.equal(fresh.testReports.node.path, 'test-reports/node/fresh.txt'); assert.equal(fresh.testReports.node.stale, false);
  // Unrelated or summary-less logs never become the pinned report; a newer full-suite run does.
  f.put('suite-runs/w/related-nondebug-tests.txt', 'ℹ tests 52\nℹ pass 52\nℹ fail 0\n'); f.put('suite-runs/w/notes.log', '✔ looks fine\n');
  f.put('test-reports/node/partial.txt', '✔ only check marks, no summary\n');
  assert.equal(generate({ ...opts, write: false }).matrix.fingerprint.testReports.node.path, 'test-reports/node/fresh.txt');
  f.put('suite-runs/w/full-suite-final.txt', '✖ broken (1ms)\nℹ tests 3\nℹ pass 2\nℹ fail 1\n');
  const suite = generate({ ...opts, write: false }).matrix.fingerprint.testReports.node;
  assert.deepEqual([suite.path, suite.passed, suite.failed], ['suite-runs/w/full-suite-final.txt', 2, 1]);
});

test('matrix integrity (req 19) stays open while the pinned test report has failures', () => {
  const f = fixture();
  f.put('test-reports/node/run.txt', 'ℹ tests 5\nℹ pass 4\nℹ fail 1\n');
  f.put('test-reports/dotnet/run.trx', '<TestRun><ResultSummary><Counters total="3" passed="3" failed="0" /></ResultSummary></TestRun>');
  const src = source({ '19.o11': [sub('19.o11.a', { kind: 'matrix-integrity' })] });
  const m = generate({ ...files(f, src), write: false }).matrix;
  assert.deepEqual([m.fingerprint.testReports.node.failed, m.fingerprint.testReports.dotnet.passed], [1, 3]);
  const reasons = find(m, 19, 'o11').subCriteria[0].reasons;
  assert.ok(reasons.includes('test-report-failed:node=1'), reasons.join(' '));
  assert.ok(!reasons.some(r => r.includes(':dotnet')), reasons.join(' '));
  assert.ok(!reasons.some(r => r.startsWith('git-')), 'HEAD is not a closure input');
});

test('type coverage: Object cells close only with verified refusal evidence, never by being skipped', () => {
  const f = fixture();
  const others = rt => ['input', 'local', 'output', 'return'].flatMap(role => TYPES.filter(t => t !== 'Object').map(type => ({ type, role, runtime: rt })));
  const audits = [];
  for (const rt of ['client', 'server']) for (const [transport, body] of [['mcp', M], ['cli', C]]) {
    const rel = `types/${rt}-${transport}.json`, hash = f.put(rel, { ...body, scenarios: 1, pauses: 1 });
    audits.push({ path: rel, sha256: hash, transport, live: true, lane: 'o11', runtime: rt, operationId: null, sessionId: null, predicates: ['/ok==true'], cells: others(rt) });
  }
  const refusal = f.put('types/object-refusal.json', { refused: true, error: 'debug_type_unsupported:Object' });
  const objectCells = ['client', 'server'].flatMap(rt => ['input', 'local', 'output', 'return'].map(role => ({ type: 'Object', role, runtime: rt })));
  const refusalSpec = hash => ({ path: 'types/object-refusal.json', sha256: hash, lane: 'o11', runtime: 'server', predicates: ['/refused==true'], cells: objectCells });
  const reqs = { '2.o11': [sub('2.o11.t', { kind: 'type-coverage' })] };
  const without = find(generate({ ...files(f, source(reqs, { typeAudits: audits })), write: false }).matrix, 2, 'o11').subCriteria[0];
  assert.equal(without.status, 'open'); assert.equal(without.cells.open, 8, JSON.stringify(without.cells));
  const withRefusal = generate({ ...files(f, source(reqs, { typeAudits: audits, typeRefusals: [refusalSpec(refusal)] })), write: false }).matrix;
  const sub2 = find(withRefusal, 2, 'o11').subCriteria[0];
  assert.equal(sub2.status, 'closed', JSON.stringify(sub2)); assert.equal(sub2.cells.refused, 8);
  assert.ok(withRefusal.typeCoverage.cells.find(c => c.lane === 'o11' && c.type === 'Object' && c.role === 'input' && c.runtime === 'client').refusal.evidencePath === 'types/object-refusal.json');
  const forged = find(generate({ ...files(f, source(reqs, { typeAudits: audits, typeRefusals: [refusalSpec('9'.repeat(64))] })), write: false }).matrix, 2, 'o11').subCriteria[0];
  assert.equal(forged.status, 'open');
  assert.ok(validateSource(source({}, { typeRefusals: [{ ...refusalSpec(refusal), predicates: [] }] })).errors.some(e => e.includes('typeRefusal')));
});

test('adapter coverage derives from the registry and the lock inventory is embedded with classes and blockedBindings', () => {
  const f = fixture();
  const src = source({ '17.o11': [sub('17.o11.a', { kind: 'adapter-coverage' })], '18.odc': [sub('18.odc.a', { kind: 'lock-inventory' })],
    '18.o11': [sub('18.o11.a', { kind: 'lock-inventory' })] });
  const locks = [{ path: 'native-runs/x.lock', sha256: 'a'.repeat(64), lane: 'odc', class: 'retained-named-historical', reason: 'r' },
    { path: 'synthetic-a/y.lock', sha256: 'b'.repeat(64), lane: 'o11', class: 'inert-synthetic', reason: 'r' }];
  const m = generate({ ...files(f, src), write: false, inventory: () => ({ ...inventory(locks), blockedBindings: [{ lane: 'odc', bindingHash: 'c'.repeat(64) }] }) }).matrix;
  assert.ok(m.adapters.o11.some(r => r.adapter === 'client-action') && m.adapters.odc.some(r => r.adapter === 'exposed-soap'));
  assert.ok(m.adapters.o11.every(r => typeof r.status === 'string'));
  assert.equal(find(m, 17, 'o11').status, 'open', 'no verified evidence: interactive adapters are pending');
  assert.equal(m.lockInventory.locks.length, 2); assert.equal(m.lockInventory.blockedBindings.length, 1);
  assert.ok(m.lockInventory.classes['inert-synthetic']);
  assert.equal(find(m, 18, 'odc').status, 'open'); assert.equal(find(m, 18, 'o11').status, 'closed');
  assert.equal(find(m, 19, 'o11').status, 'open');
});

test('deterministic output with its own sha256; MCP handler and CLI produce byte-identical files and answers', async () => {
  const f = fixture();
  const mcp = f.put('a/mcp.json', { ok: true });
  const src = source({ '3.o11': [sub('3.o11.a', { pins: [pin('a/mcp.json', mcp, 'mcp')] })] });
  const opts = files(f, src), outDir = path.join(f.base, 'final-matrix');
  const a = generate({ ...opts, write: false }), b = generate({ ...opts, write: false });
  assert.equal(a.json, b.json); assert.equal(a.markdown, b.markdown);
  const body = JSON.parse(a.json); const { sha256, markdownSha256, ...rest } = body;
  assert.equal(sha256, sha(JSON.stringify(rest))); assert.equal(markdownSha256, sha(a.markdown));
  assert.ok(a.markdown.includes(sha256));
  const tools = {}, wrap = fn => async args => { const value = await fn(args); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; };
  registerMatrixTool({ registerTool: (name, spec, handler) => { tools[name] = { spec, handler }; } }, input => debugMatrix(input, { ...opts, outDir }), wrap);
  assert.equal(tools.ssam_debug_matrix.spec.annotations.readOnlyHint, true);
  const viaMcp = await tools.ssam_debug_matrix.handler({ op: 'generate' });
  const mcpFile = fs.readFileSync(path.join(outDir, 'matrix.json')), mcpMd = fs.readFileSync(path.join(outDir, 'matrix.md'));
  fs.rmSync(outDir, { recursive: true });
  const out = []; const viaCli = await runMatrixCli(['matrix'], { ...opts, outDir, stdout: text => out.push(text) });
  assert.equal(viaCli.exitCode, 0);
  assert.equal(viaMcp.content[0].text, out.join(''));
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'matrix.json')), mcpFile);
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'matrix.md')), mcpMd);
  assert.equal(String(mcpFile), a.json);
  assert.deepEqual(parseMatrixCli(['matrix']), { op: 'generate' });
  assert.deepEqual(parseMatrixCli(['matrix', '--check']), { op: 'check' });
  assert.throws(() => parseMatrixCli(['matrix', '--force']), /Usage/);
});

test('generate writes only matrix.json and matrix.md in the output directory and never opens DPAPI or vault records', () => {
  const f = fixture();
  const vault = f.put('x/app-user-vault.json', { ok: true }), dpapi = f.put('x/record.dpapi', 'opaque'), ok = f.put('a/ok.json', { ok: true });
  const src = source({ '12.odc': [sub('12.odc.a', { pins: [pin('x/app-user-vault.json', vault, 'mcp'), pin('x/record.dpapi', dpapi, 'cli'), pin('a/ok.json', ok, 'mcp')] })] });
  const opts = files(f, src), outDir = path.join(f.base, 'final-matrix');
  const snapshot = () => { const out = {};
    for (const e of fs.readdirSync(f.root, { recursive: true, withFileTypes: true }).filter(e => e.isFile())) {
      const file = path.join(e.parentPath ?? e.path, e.name); if (file.startsWith(outDir)) continue;
      const st = fs.statSync(file); out[file] = sha(fs.readFileSync(file)) + ':' + st.mtimeMs; }
    return out; };
  const before = snapshot(), opened = [];
  const result = generate({ ...opts, outDir, readFile: file => { opened.push(path.resolve(file)); return fs.readFileSync(file); } });
  assert.equal(result.ok, true);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['matrix.json', 'matrix.md']);
  assert.ok(!opened.some(file => /\.dpapi$|vault/i.test(path.basename(file))), opened.join('\n'));
  const cell = find(result.matrix, 12, 'odc');
  assert.deepEqual(cell.subCriteria[0].pins.map(p => p.reason ?? 'ok'), ['private-store-refused', 'private-store-refused', 'ok']);
  assert.throws(() => generate({ ...opts, outDir: path.join(os.tmpdir(), 'elsewhere-matrix') }), /out_dir/);
  // Inside the workspace but outside .local/debugger (e.g. the hashed kernel/debug tree) is refused too.
  assert.throws(() => generate({ ...opts, outDir: path.join(f.root, 'kernel', 'debug', 'matrix') }), /out_dir/);
  assert.equal(fs.existsSync(path.join(f.root, 'kernel', 'debug', 'matrix')), false);
});

test('--check exits non-zero on drift and the doc pointer carries the generated Markdown sha256', async () => {
  const f = fixture();
  const mcp = f.put('a/mcp.json', { ok: true });
  const src = source({ '3.o11': [sub('3.o11.a', { pins: [pin('a/mcp.json', mcp, 'mcp')] })] });
  const opts = files(f, src), outDir = path.join(f.base, 'final-matrix');
  const generated = await debugMatrix({ op: 'generate' }, { ...opts, outDir });
  assert.equal(generated.markdownSha256, sha(fs.readFileSync(path.join(outDir, 'matrix.md'))));
  const pointer = docPointer(generated);
  assert.ok(pointer.includes(generated.markdownSha256) && pointer.includes('DEBUGGER-MATRIZ-FINAL.md'));
  f.write(path.join(f.root, 'docs', 'DEBUGGER-PLANO-FINAL.md'), '# Plano\n\n' + pointer + '\n');
  f.write(path.join(f.root, 'docs', 'DEBUGGER-MATRIZ-FINAL.md'), fs.readFileSync(path.join(outDir, 'matrix.md')));
  assert.deepEqual((await debugMatrix({ op: 'check' }, { ...opts, outDir })).drift, []);
  assert.equal((await runMatrixCli(['matrix', '--check'], { ...opts, outDir, stdout: () => {} })).exitCode, 0);
  // Landing the doc and pointers moves HEAD (commit); with no evidence or tree change, check stays clean.
  f.write(path.join(f.root, '.git', 'refs', 'heads', 'claude', 'x'), 'b'.repeat(40) + '\n');
  const afterCommit = await debugMatrix({ op: 'check' }, { ...opts, outDir });
  assert.deepEqual(afterCommit.drift, []); assert.equal(afterCommit.git.head, 'b'.repeat(40));
  // A pointer doc present without its marker (wiring forgotten) is drift; so is a missing generated doc.
  f.write(path.join(f.root, 'docs', 'DEBUGGER-HEADLESS.md'), '# Headless\n\nno pointer here\n');
  assert.deepEqual((await debugMatrix({ op: 'check' }, { ...opts, outDir })).drift, [{ file: 'docs/DEBUGGER-HEADLESS.md', reason: 'pointer-missing' }]);
  f.write(path.join(f.root, 'docs', 'DEBUGGER-HEADLESS.md'), '# Headless\n\n' + pointer + '\n');
  fs.renameSync(path.join(f.root, 'docs', 'DEBUGGER-MATRIZ-FINAL.md'), path.join(f.root, 'docs', 'moved.md'));
  assert.deepEqual((await debugMatrix({ op: 'check' }, { ...opts, outDir })).drift, [{ file: 'docs/DEBUGGER-MATRIZ-FINAL.md', reason: 'missing' }]);
  fs.renameSync(path.join(f.root, 'docs', 'moved.md'), path.join(f.root, 'docs', 'DEBUGGER-MATRIZ-FINAL.md'));
  f.put('a/mcp.json', { ok: true, changed: true });
  const written = fs.readFileSync(path.join(outDir, 'matrix.json'), 'utf8');
  const drift = await debugMatrix({ op: 'check' }, { ...opts, outDir });
  assert.equal(drift.ok, false);
  assert.deepEqual(drift.drift.map(d => [d.file, d.reason]), [['.local/debugger/final-matrix/matrix.json', 'changed'], ['.local/debugger/final-matrix/matrix.md', 'changed'],
    ['docs/DEBUGGER-MATRIZ-FINAL.md', 'changed'], ['docs/DEBUGGER-PLANO-FINAL.md', 'stale-pointer'], ['docs/DEBUGGER-HEADLESS.md', 'stale-pointer']]);
  assert.equal((await runMatrixCli(['matrix', '--check'], { ...opts, outDir, stdout: () => {} })).exitCode, 1);
  // check never writes.
  assert.equal(fs.readFileSync(path.join(outDir, 'matrix.json'), 'utf8'), written);
  assert.equal(checkMatrix({ ...opts, outDir: path.join(f.base, 'absent-matrix') }).drift[0].reason, 'missing');
});
