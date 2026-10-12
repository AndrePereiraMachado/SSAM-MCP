import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lockInventory, debugLocks, parseLocksCli, NAMED_HISTORICAL } from '../debug-lock-inventory.mjs';
import { bindingHash } from '../debug-o11-native-run.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const HOST = 'o11.fixture.test', ODC = 'odc.fixture.test', ORIGIN = 'https://odc-dev.fixture.test';
const key = c => c.repeat(22);
const stages = names => Object.fromEntries(names.map((name, i) => [name, { sealed: true, sha256: sha('stage-' + name + i) }]));
const COUNTERS = { networkRequests: 0, executeRequestSubmissions: 0, negotiations: 0, socketConnections: 0, longPollingConnections: 0, longPollingSendRequests: 0, probes: [] };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-inventory-')), base = path.join(root, '.local', 'debugger');
  const put = (rel, value) => { const file = path.join(base, rel); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const o11 = (moduleKey, operationId, module, receipt, worker, extra = {}) => {
    put(`native-runs/o11/${HOST}/${moduleKey}.lock`, { operationId, pid: 999999 });
    put(`native-runs/o11/${HOST}/${operationId}/receipt.json`, { schema: 'ssam-o11-native-run/1', op: 'run', operationId,
      target: { host: HOST, module, moduleKey }, ...receipt });
    if (worker) put(`native-runs/o11/${HOST}/${operationId}/native-entry-receipt.json`, { schema: 'ssam-o11-native-entry-receipt/1', ...worker });
    for (const [name, value] of Object.entries(extra)) put(`native-runs/o11/${HOST}/${operationId}/${name}`, value);
  };
  const odc = (moduleKey, module, operationId, sessionId, receipt, suffix = '') => {
    const runtimeUrl = `${ORIGIN}/${module}/`, hash = sha('odc|' + runtimeUrl + '|' + moduleKey);
    put(`native-runs/${hash}${suffix}.lock`, { operationId, sessionId });
    if (receipt) put(`native-runs/odc/${operationId}/receipt.json`, { schema: 'ssam-odc-native-run/1', operationId, sessionId,
      binding: { tenant: ODC, app: module, module, moduleKey, runtimeUrl }, ...receipt });
    return { hash, runtimeUrl };
  };
  const ids = { answered: randomUUID(), unanswered: randomUUID(), aborted: randomUUID(), login: randomUUID(), zero: randomUUID(),
    client: randomUUID(), missing: randomUUID(), synthetic: randomUUID(), named: '62cd7677-a469-407b-a65f-480d9e5832c5', namedZero: '10f00e0f-fc94-488d-9a04-e0f4eb00e374' };
  // archived-reconciled
  put(`native-runs/o11/${HOST}/${ids.answered}/reconciled-answered.lock`, { operationId: ids.answered, pid: 1 });
  put(`native-runs/o11/${HOST}/${ids.answered}/answered-reconciliation.json`, { schema: 'ssam-o11-answered-reconciliation/1', ok: true });
  put(`native-runs/odc/${randomUUID()}/consumer-request-lock.reconciled.lock`, { operationId: randomUUID(), sessionId: 'f'.repeat(32) });
  // retained-unanswered-submission
  const nid = 'a'.repeat(32);
  o11(key('U'), ids.unanswered, 'UnansweredUI', { state: 'answered', uncertain: true, lockRetained: true, results: [{ ok: false, uncertain: true }],
    appUserAuthenticated: true, credentialsReleased: true, serverTrace: { sessionId: nid, state: 'connected' }, worker: { submitted: 1, answered: 0, memoryCleared: true } },
  { sessionId: nid, phase: 'disposed', requestSubmittedCount: 1, requestAnsweredCount: 0, requestUncertain: true, memoryCleared: true },
  { [nid + '.post-1.json']: { sessionId: nid, seq: 1 } });
  // candidate-o11-client-aborted (zero business submissions, client-only entry)
  o11(key('C'), ids.aborted, 'AbortedUI', { state: 'invoking', results: [], appUserAuthenticated: true, entryAbi: { kind: 'client-action', endpoints: [] } },
    { sessionId: 'b'.repeat(32), phase: 'authenticated', requestSubmittedCount: 0, requestAnsweredCount: 0, requestUncertain: false, memoryCleared: false },
    { ['b'.repeat(32) + '.login-attempt.json']: { kind: 'login' } });
  // candidate-o11-login-refusal
  o11(key('L'), ids.login, 'LoginUI', { state: 'failed-or-uncertain', results: [], uncertain: true, lockRetained: true, credentialsReleased: true,
    worker: { memoryCleared: true, submitted: 0, answered: 0, loginUncertain: false, requestUncertain: false } },
  { sessionId: 'c'.repeat(32), phase: 'disposed', ok: false, diagnostics: { phase: 'original-login', errorType: 'InvalidLoginException' },
    loginSubmittedCount: 1, loginAnsweredCount: 1, requestSubmittedCount: 0, requestAnsweredCount: 0, requestUncertain: false, memoryCleared: true });
  // retained-named-historical with a reserved, unconfirmed channel cleanup
  const evidence = stages(['prepared', 'negotiated', 'channel-opened', 'cleanup-attempt', 'finished']);
  odc(key('F'), 'Store', ids.named, 'd'.repeat(31) + '1', { state: 'uncertain', results: [{ ok: true, uncertain: false }], requestEvidence: [{}], pendingRequests: 0,
    credentialsReleased: true, uncertain: true, lockRetained: true, cleanup: { completed: false, receipt: { cleanupConfirmed: false, transport: { ...COUNTERS,
      executeRequestSubmissions: 1, longPollingCleanupUncertain: true, probes: [{ probeId: 'scenario-1-1', executeRequestSubmissions: 1, finished: true, uncertain: false,
        correlation: { evidence, requestOwnershipProved: false } }] } } } }, '.static-read');
  // A named operation is never a candidate, even with zero-request evidence.
  const zeroReceipt = sid => ({ state: 'uncertain', entry: { kind: 'ScreenAction', entryKind: 'client-action' }, results: [], credentialsReleased: true,
    cleanup: { completed: true, receipt: { cleanupConfirmed: true, transport: { ...COUNTERS } } }, uncertain: true, lockRetained: true,
    serverTrace: { sessionId: sid, state: 'stop-uncertain', transport: { startPhase: 'rest-start', stopPhase: 'no-session-token', tokenObtained: false } } });
  odc(key('N'), 'Named', ids.namedZero, '9'.repeat(32), zeroReceipt('9'.repeat(32)));
  // candidate-odc-zero-request-start-uncertain plus its debugger target lock
  const sz = 'e'.repeat(31) + '2';
  const probe = odc(key('Z'), 'Probe', ids.zero, sz, zeroReceipt(sz));
  put(sha('odc|' + ORIGIN.toLowerCase() + '|' + key('Z')) + '.lock', { sessionId: sz });
  put(sz + '/manifest.json', { sessionId: sz, lane: 'odc', tenant: ODC, module: 'Probe', moduleKey: key('Z'), runtimeUrl: probe.runtimeUrl });
  put(sz + '/receipt.json', { ok: false, state: 'stop-uncertain', sessionId: sz, lane: 'odc', transport: { startPhase: 'rest-start', stopPhase: 'no-session-token', tokenObtained: false } });
  // candidate-odc-client-aborted
  odc(key('A'), 'Binary', ids.client, '1'.repeat(32), { state: 'uncertain', error: 'debug_odc_native_worker_lost', entry: { kind: 'ScreenAction', entryKind: 'client-action' },
    results: [], credentialsReleased: true, cleanup: { completed: false }, uncertain: true, lockRetained: true });
  // retained-insufficient-evidence: lock whose run receipt is absent
  const missing = odc(key('M'), 'Missing', ids.missing, '2'.repeat(32), null);
  // inert-delivery-lease and a non-terminal delivery
  put('item1-o11-x/delivery/deliver/0001/run.lock', '');
  put('item1-o11-x/delivery/deliver/0001/result.json', { stage: 'complete', writeState: 'applied' });
  put('item1-o11-x/delivery/deliver/0002/run.lock', '');
  put('item1-o11-x/delivery/deliver/0002/result.json', { stage: 'apply', writeState: 'sent' });
  // inert-synthetic, and two look-alikes that are not synthetic
  put(`proofs/o11-chain/synthetic-operators/${ids.synthetic}/synthetic-operator.lock`, { operationId: ids.synthetic, phase: 'uncertain', sourceContractSha256: 'd'.repeat(64) });
  put(`proofs/o11-chain/synthetic-operators/${randomUUID()}/real.lock`, { operationId: randomUUID(), phase: 'uncertain', sourceContractSha256: 'a'.repeat(64) });
  put(`proofs/o11-chain/live-operator.lock`, { operationId: randomUUID(), phase: 'uncertain', sourceContractSha256: 'e'.repeat(64) });
  // inert-legacy-harness: actionSubmitted:false and a terminal receipt
  put('proofs/odc-client-server-host/live-location-guard.lock', { runId: '3'.repeat(32), phase: 'failed-before-completion', actionSubmitted: false, retryAllowed: false });
  const harness = put('proofs/odc-client-server-host/runs/4444/receipt.json', { phase: 'completed', ok: true, actionSubmitted: true, actionUncertain: false });
  put('proofs/odc-client-server-host/read/4444/location-1.operator.lock', { operationId: '4'.repeat(32), phase: 'reserved', receiptPath: harness });
  // registry-blocked binding without a lock; a private record that must never be opened
  put(`blocked-bindings/${bindingHash(HOST, key('R'))}.json`, { schema: 'ssam-debugger-blocked-binding/1', host: HOST, moduleKey: key('R'), module: 'RegistryCore', operationId: randomUUID() });
  put(`native-runs/o11/${HOST}/secret.dpapi`, 'NOT-A-REAL-RECORD');
  return { root, base, ids, missing };
}
function snapshot(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    out[path.relative(dir, file)] = entry.isFile() ? sha(fs.readFileSync(file)) + ':' + fs.statSync(file).mtimeMs : 'dir';
  }
  return out;
}

test('one fixture per class: archived, retained, candidate and inert locks with hashes, owners and receipts', () => {
  const f = fixture();
  try {
    const inventory = lockInventory({ root: f.root });
    assert.equal(inventory.ok, true); assert.equal(inventory.readOnly, true);
    const at = suffix => { const hit = inventory.locks.filter(l => l.path.endsWith(suffix)); assert.equal(hit.length, 1, suffix); return hit[0]; };
    for (const lock of inventory.locks) {
      assert.equal(lock.sha256, sha(fs.readFileSync(path.join(f.base, lock.path))), lock.path);
      assert.ok(!lock.path.includes('\\') && !path.isAbsolute(lock.path));
      for (const r of lock.receipts) assert.equal(r.sha256, sha(fs.readFileSync(path.join(f.base, r.path))), r.path);
    }
    const archived = at('reconciled-answered.lock');
    assert.equal(archived.class, 'archived-reconciled'); assert.equal(archived.reconciler, 'o11-answered'); assert.equal(archived.lane, 'o11');
    assert.ok(archived.receipts.some(r => r.path.endsWith('answered-reconciliation.json')));
    assert.equal(at('consumer-request-lock.reconciled.lock').class, 'archived-reconciled');
    const unanswered = at(key('U') + '.lock');
    assert.equal(unanswered.class, 'retained-unanswered-submission'); assert.equal(unanswered.operationId, f.ids.unanswered);
    assert.ok(unanswered.missingEvidence.includes('response of the submitted business request'));
    assert.ok(unanswered.receipts.some(r => r.path.endsWith(f.ids.unanswered + '/receipt.json')));
    assert.deepEqual(unanswered.owner, { operationId: f.ids.unanswered, pid: 999999 });
    const aborted = at(key('C') + '.lock');
    assert.equal(aborted.class, 'candidate-o11-client-aborted'); assert.equal(aborted.reconciler, 'o11-client-aborted');
    assert.equal(at(key('L') + '.lock').class, 'candidate-o11-login-refusal');
    const named = at('.static-read.lock');
    assert.equal(named.class, 'retained-named-historical'); assert.equal(named.reconciler, null); assert.equal(named.lane, 'odc');
    assert.match(named.reason, /response completed, cleanup attempt reserved and unconfirmed, retry forbidden/);
    assert.equal(named.cleanupStatus.record.stage, 'cleanup-attempt'); assert.equal(named.cleanupStatus.retryForbidden, true);
    assert.ok(named.missingEvidence.some(m => /channel cleanup acceptance/.test(m)));
    const namedZero = inventory.locks.find(l => l.operationId === f.ids.namedZero);
    assert.equal(namedZero.class, 'retained-named-historical');
    const zero = inventory.locks.filter(l => l.class === 'candidate-odc-zero-request-start-uncertain');
    assert.deepEqual(zero.map(l => l.kind).sort(), ['odc-binding', 'session-target']);
    assert.ok(zero.every(l => l.reconciler === 'odc-zero-request-start-uncertain' && l.lane === 'odc'));
    assert.equal(inventory.locks.find(l => l.operationId === f.ids.client).class, 'candidate-odc-client-aborted');
    const missing = inventory.locks.find(l => l.operationId === f.ids.missing);
    assert.equal(missing.class, 'retained-insufficient-evidence'); assert.deepEqual(missing.missingEvidence, ['run receipt']);
    assert.equal(at('0001/run.lock').class, 'inert-delivery-lease');
    assert.equal(at('0002/run.lock').class, 'retained-insufficient-evidence');
    assert.ok(at('0002/run.lock').missingEvidence.includes('terminal delivery result'));
    assert.equal(at('synthetic-operator.lock').class, 'inert-synthetic');
    assert.notEqual(at('real.lock').class, 'inert-synthetic');
    assert.notEqual(at('o11-chain/live-operator.lock').class, 'inert-synthetic');
    assert.equal(at('live-location-guard.lock').class, 'inert-legacy-harness');
    assert.equal(at('location-1.operator.lock').class, 'inert-legacy-harness');
    assert.equal(inventory.counts.total, inventory.locks.length);
    assert.equal(inventory.counts.byLane.o11 + inventory.counts.byLane.odc + (inventory.counts.byLane.unknown ?? 0), inventory.locks.length);
    assert.deepEqual(inventory.locks.map(l => l.path), inventory.locks.map(l => l.path).sort());
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('blockedBindings lists every refused binding once, from locks, registry and code', () => {
  const f = fixture();
  try {
    const { blockedBindings } = lockInventory({ root: f.root });
    const of = (lane, moduleKey) => blockedBindings.filter(b => b.lane === lane && b.moduleKey === moduleKey);
    assert.deepEqual(of('o11', key('U')).map(b => [b.host, b.module, b.operationId]), [[HOST, 'UnansweredUI', f.ids.unanswered]]);
    assert.equal(of('o11', key('C')).length, 1);
    assert.equal(of('o11', key('R'))[0].module, 'RegistryCore'); assert.ok(of('o11', key('R'))[0].sources[0].startsWith('registry:'));
    assert.ok(blockedBindings.some(b => b.lane === 'o11' && b.module === 'Headless_UI' && b.sources.includes('code')));
    const probe = of('odc', key('Z'));
    assert.equal(probe.length, 1); assert.equal(probe[0].host, ODC); assert.equal(probe[0].sources.length, 2);
    assert.deepEqual(of('odc', key('F'))[0].operationIds, [f.ids.named]);
    assert.ok(blockedBindings.some(b => b.lane === 'odc' && b.moduleKey === null && b.bindingHash === f.missing.hash && b.operationId === f.ids.missing));
    for (const b of blockedBindings) assert.deepEqual(Object.keys(b).slice(0, 5), ['lane', 'host', 'moduleKey', 'module', 'operationId']);
    assert.ok(!blockedBindings.some(b => b.moduleKey === key('Q')), 'inert and archived locks never block');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('read-only guarantee: no write, rename, delete, lock open or DPAPI read', t => {
  const f = fixture();
  try {
    const before = snapshot(f.root), reads = [];
    for (const name of ['writeFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'mkdirSync', 'copyFileSync', 'appendFileSync', 'cpSync', 'symlinkSync', 'truncateSync', 'writeSync'])
      t.mock.method(fs, name, () => assert.fail('forbidden fs.' + name));
    const open = fs.openSync; // readFileSync may open read-only; any other flag would be a lock/write attempt.
    t.mock.method(fs, 'openSync', (file, flags = 'r', ...rest) => { if (![undefined, 'r', fs.constants.O_RDONLY].includes(flags)) assert.fail('open ' + flags); return open.call(fs, file, flags, ...rest); });
    const original = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...rest) => { reads.push(String(file)); return original.call(fs, file, ...rest); });
    t.mock.method(globalThis, 'fetch', () => assert.fail('network'));
    const inventory = lockInventory({ root: f.root });
    assert.ok(inventory.locks.length >= 18);
    assert.ok(!reads.some(file => /\.dpapi$/i.test(file)), 'DPAPI record read');
    assert.ok(reads.every(file => path.resolve(file).startsWith(path.resolve(f.root)) || !file.includes('.local')), 'read outside root');
    t.mock.restoreAll();
    assert.deepEqual(snapshot(f.root), before);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('named target and operator locks list their operation and missing evidence; unknown fields refused', () => {
  const f = fixture();
  try {
    const sid = '7c8e6cea' + '0'.repeat(24), op = randomUUID(), origin = 'https://named.fixture.test', mk = key('T');
    const write = (rel, value) => { const file = path.join(f.base, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file; };
    write(sha('odc|' + origin + '|' + mk) + '.lock', { sessionId: sid });
    write(sid + '/manifest.json', { sessionId: sid, lane: 'odc', tenant: ODC, module: 'Named', moduleKey: mk, runtimeUrl: origin + '/Named/' });
    write(sid + '/receipt.json', { ok: false, state: 'stop-uncertain', sessionId: sid, lane: 'odc' });
    write(`native-runs/odc/${op}/consumer-request-lock.reconciled.lock`, { operationId: op, sessionId: sid });
    const receipt = write('proofs/o11-chain/live-runs/d16668ff/live-service-receipt.json', { phase: 'service-response-uncertain', ok: false });
    write('proofs/o11-chain/d16668ff-live-operator.lock', { operationId: 'd16668ff-0187-403a-81d2-22610ffa72f1', receiptPath: receipt, phase: 'uncertain' });
    const { locks, blockedBindings } = lockInventory({ root: f.root });
    const target = locks.find(l => l.sessionId === sid && l.kind === 'session-target');
    assert.equal(target.class, 'retained-named-historical'); assert.equal(target.operationId, op); assert.equal(target.moduleKey, mk);
    assert.deepEqual(target.missingEvidence, ['confirmed native debugger stop (session state stop-uncertain)', 'run receipt referencing this debugger session']);
    assert.equal(blockedBindings.filter(b => b.moduleKey === mk).length, 1);
    const operator = locks.find(l => l.path.endsWith('d16668ff-live-operator.lock'));
    assert.equal(operator.class, 'retained-named-historical'); assert.equal(operator.lane, 'o11');
    assert.deepEqual(operator.missingEvidence, ['outcome of receipt phase service-response-uncertain']);
    assert.ok(operator.receipts[0].path.endsWith('live-service-receipt.json') && !('receiptPath' in operator.owner));
    assert.throws(() => debugLocks({ op: 'locks', tenant: 'x' }, { root: f.root }), /field_invalid:tenant/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('named list is fixed; lane filter and CLI parsing', () => {
  assert.deepEqual([...NAMED_HISTORICAL], ['7c8e6cea', '40448a18', '9efecfdc', '4c7016f0', '4a7ce9f9', '34631630', '62cd7677', '10f00e0f',
    'a67c19f1', '60aa32e5', '49d23354', 'dabb6842', '49954464', 'd16668ff']);
  const f = fixture();
  try {
    const odc = debugLocks({ op: 'locks', lane: 'odc' }, { root: f.root });
    assert.ok(odc.locks.length > 0 && odc.locks.every(l => l.lane === 'odc') && odc.blockedBindings.every(b => b.lane === 'odc'));
    assert.throws(() => debugLocks({ op: 'run' }, { root: f.root }), /op_invalid/);
    assert.throws(() => debugLocks({ op: 'locks', lane: 'x' }, { root: f.root }), /lane_invalid/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  assert.deepEqual(parseLocksCli(['locks'], 'o11'), { op: 'locks', lane: 'o11' });
  assert.deepEqual(parseLocksCli(['locks']), { op: 'locks' });
  assert.throws(() => parseLocksCli(['locks', '--extra']), /Usage: ssam debug locks/);
});

test('background locks are classified by receipt.background.kind/schema, never by the error prefix; the retained lock is retained-by-decision', () => {
  const f = fixture();
  try {
    const write = (rel, value) => { const file = path.join(f.base, rel); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
    const RH = 'personal-2qqw9srv.outsystemscloud.com', RK = 'bf7WCuRy7keTqvquautTGg', ROP = '60aa32e5-1100-4e1f-9d5a-7d74e5bc5ce2';
    write(`native-runs/o11/${RH}/${RK}.lock`, { operationId: ROP, pid: 69248 });
    write(`native-runs/o11/${RH}/${ROP}/receipt.json`, fs.readFileSync(new URL('./fixtures/debug-retained-60aa32e5-receipt.json', import.meta.url), 'utf8'));
    // A BPT receipt whose error happens to carry the Timer prefix stays a BPT; a Timer receipt with the old prefix reads as Timer.
    const bptOp = randomUUID(), timerOp = randomUUID();
    write(`native-runs/o11/${HOST}/${key('B')}.lock`, { operationId: bptOp, pid: 999999 });
    write(`native-runs/o11/${HOST}/${bptOp}/receipt.json`, { schema: 'ssam-o11-native-run/1', op: 'run', operationId: bptOp, state: 'failed-or-uncertain',
      target: { host: HOST, module: 'Bpt', moduleKey: key('B') }, results: [], background: { schema: 'ssam-o11-bpt-observation/1', kind: 'process-original-launch' },
      error: 'debug_native_background_timer_launch_outcome_uncertain' });
    write(`native-runs/o11/${HOST}/${key('W')}.lock`, { operationId: timerOp, pid: 999999 });
    write(`native-runs/o11/${HOST}/${timerOp}/receipt.json`, { schema: 'ssam-o11-native-run/1', op: 'run', operationId: timerOp, state: 'failed-or-uncertain',
      target: { host: HOST, module: 'Wake', moduleKey: key('W') }, results: [], background: { schema: 'ssam-o11-timer-observation/1' },
      error: 'debug_native_background_bpt_watch_not_connected' });
    const { locks, classes } = lockInventory({ root: f.root });
    assert.ok('retained-by-decision' in classes);
    const retained = locks.find(l => l.moduleKey === RK);
    assert.equal(retained.class, 'retained-by-decision'); assert.equal(retained.reconciler, null); assert.equal(retained.operationId, ROP);
    assert.deepEqual(retained.retainedDecision, { operationId: ROP, host: RH, moduleKey: RK, reason: 'retained by user decision' });
    assert.equal(retained.background.kind, 'timer-original-wake'); assert.equal(retained.background.namespace, 'timer');
    assert.ok(retained.missingEvidence.includes('outcome of debug_native_background_timer_launch_outcome_uncertain'), retained.missingEvidence.join('|'));
    const bpt = locks.find(l => l.moduleKey === key('B')), timer = locks.find(l => l.moduleKey === key('W'));
    assert.equal(bpt.background.kind, 'process-original-launch'); assert.equal(bpt.background.namespace, 'bpt');
    assert.equal(timer.background.kind, 'timer-original-wake'); assert.equal(timer.background.canonicalError, 'debug_native_background_timer_watch_not_connected');
    assert.equal(locks.find(l => l.moduleKey === key('U')).background, undefined, 'non-background runs carry no background classification');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
