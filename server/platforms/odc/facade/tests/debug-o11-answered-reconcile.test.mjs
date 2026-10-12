import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { reconcileO11Answered } from '../debug-o11-answered-reconcile.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, mutate = () => {}, ids = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-answered-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const operationId = ids.operationId ?? randomUUID(), sessionId = randomUUID(), nativeId = randomUUID().replaceAll('-', '');
  const target = { host: ids.host ?? 'app.example.test', moduleKey: ids.moduleKey ?? 'A'.repeat(22), module: 'App' };
  const directory = path.join(root, '.local/debugger/native-runs/o11', target.host, operationId);
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  const source = path.join(directory, 'native-entry-source.json'); write(source, { fixture: true });
  const sourceContract = { path: source, sha256: sha(fs.readFileSync(source)) };
  const published = { versionId: 1, sourceSha256: 'b'.repeat(64) };
  const report = { schema: 'ssam-o11-native-run/1', operationId, op: 'run', state: 'invoking', target,
    published, sourceContract, results: [], appUserAuthenticated: true, serverTrace: { sessionId: nativeId },
    scenarios: [{ name: 'one' }], receiptPath: path.join(directory, 'receipt.json') };
  const worker = { schema: 'ssam-o11-native-entry-receipt/1', sessionId: nativeId, prepared: true, phase: 'disposed', ok: true,
    authenticated: true, nativeScreenPermissionsPassed: true, loginSubmittedCount: 1, loginAnsweredCount: 1, loginUncertain: false,
    requestSubmittedCount: 1, requestAnsweredCount: 1, requestUncertain: false, requestEnvelopeVerified: true,
    memoryCleared: true, nativeContextReferencesReleased: true, privateInspectionCleanup: { completed: true, pending: 0 },
    sourceContract, target: { ...target, publishedVersionId: 1, sourceSha256: published.sourceSha256 },
    scenarios: [{ name: 'one', ok: true, submitted: 1, answered: 1, uncertain: false }],
    lastEntryResponse: { status: 200, nativeEnvelopeAccepted: true } };
  const native = { ok: true, sessionId: nativeId, lane: 'o11', module: 'App', state: 'stopped', processId: 123456788,
    transport: { tokenObtained: true, stopPhase: 'stopped' }, events: [{ kind: 'stopped' }], pauses: [] };
  const session = { lane: 'o11', sessionId, nativeSessionId: nativeId, state: 'ending', pauses: [] };
  mutate({ report, worker, native, session });
  write(report.receiptPath, report); write(path.join(directory, 'native-entry-receipt.json'), worker);
  write(path.join(directory, nativeId + '.post-1.json'), { sessionId: nativeId, seq: 1, scenario: 'one' });
  write(path.join(root, '.local/debugger', nativeId, 'receipt.json'), native);
  write(path.join(root, '.local/debugger/server-sessions', sessionId + '.json'), session);
  const lock = path.join(path.dirname(directory), target.moduleKey + '.lock'); write(lock, { operationId, pid: 123456789 });
  const vaultRoot = path.join(root, 'private-vault'); fs.mkdirSync(vaultRoot);
  // Fake read-only legacy copies: the process view (writable by its own process) and another package store.
  const legacy = origin => path.join(root, 'legacy', origin.replace(/[^A-Za-z0-9._-]/g, '_'), 'SSAM', 'DebugAppUser');
  const legacyRoots = [{ origin: 'current', path: legacy('current'), writable: true, anchor: root },
    { origin: 'package:OpenAI.Codex_2p2nqsd0c76g0', path: legacy('codex'), writable: false, anchor: root }];
  for (const r of legacyRoots) fs.mkdirSync(r.path, { recursive: true });
  return { root, directory, lock, report, source, session, native, write, legacyRoots, options: { isProcessAlive: () => false, vaultRoot, legacyRoots } };
}
test('reconciles answered/disposed/stopped evidence without changing originals or claiming complete inspection', t => {
  const f = fixture(t), original = fs.readFileSync(f.report.receiptPath), lock = fs.readFileSync(f.lock);
  fs.mkdirSync(path.join(f.options.vaultRoot, 'Accounts'));
  fs.writeFileSync(path.join(f.options.vaultRoot, 'Accounts', 'untouched'), 'saved account');
  const result = reconcileO11Answered(f.root, f.session, f.options);
  assert.equal(result.state, 'reconciled-answered'); assert.equal(result.answered, 1);
  assert.equal(result.replayed, false); assert.equal(result.valuesComplete, false); assert.equal(result.traceComplete, false);
  assert.deepEqual(fs.readFileSync(result.archive), lock); assert.deepEqual(fs.readFileSync(f.report.receiptPath), original);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(result.credentialsReleased, true); assert.equal(result.stateRoot, f.options.vaultRoot);
  assert.deepEqual(result.legacyInventory, [{ origin: 'current', entries: 0, readable: true },
    { origin: 'package:OpenAI.Codex_2p2nqsd0c76g0', entries: 0, readable: true }]);
  f.write(f.lock, { operationId: randomUUID(), pid: process.pid }); const newer = fs.readFileSync(f.lock);
  assert.deepEqual(reconcileO11Answered(f.root, f.session, f.options), result);
  assert.deepEqual(fs.readFileSync(f.lock), newer);
});
test('refuses incomplete or mismatched response, native stop, source, cleanup and scenario evidence', t => {
  for (const mutate of [
    x => x.worker.requestAnsweredCount = 0, x => x.worker.requestUncertain = true,
    x => x.worker.memoryCleared = false, x => x.worker.privateInspectionCleanup.pending = 1,
    x => x.worker.target.sourceSha256 = 'c'.repeat(64), x => x.worker.scenarios[0].name = 'other',
    x => x.worker.scenarios[0].answered = 0, x => x.worker.lastEntryResponse.nativeEnvelopeAccepted = false,
    x => x.native.state = 'stop-uncertain', x => x.native.transport.tokenObtained = false,
    x => x.native.events = [], x => x.report.results.push({ ok: true }),
    x => x.report.serverTrace.sessionId = '0'.repeat(32), x => x.session.pauses.push({}),
  ]) {
    const f = fixture(t, mutate), before = fs.readFileSync(f.lock);
    assert.throws(() => reconcileO11Answered(f.root, f.session, f.options), /debug_o11_answered_reconcile_/);
    assert.deepEqual(fs.readFileSync(f.lock), before);
  }
});
test('a lease in any store (new root, process view or another package store) blocks the archive with credentialsReleased:false', t => {
  for (const [place, pending] of [[f => f.options.vaultRoot, 'store:state'], [f => f.legacyRoots[0].path, 'store:current'],
    [f => f.legacyRoots[1].path, 'legacy-store:OpenAI.Codex_2p2nqsd0c76g0']]) {
    const f = fixture(t), lease = path.join(place(f), randomUUID() + '.dpapi'); fs.writeFileSync(lease, 'opaque');
    const before = fs.readFileSync(f.lock), original = fs.readFileSync(f.report.receiptPath);
    const result = reconcileO11Answered(f.root, f.session, f.options);
    assert.equal(result.ok, false); assert.equal(result.credentialsReleased, false); assert.equal(result.mutexArchived, false);
    assert.deepEqual(result.pending, [pending]); assert.equal(result.stateRoot, f.options.vaultRoot);
    assert.equal(result.legacyInventory.reduce((n, r) => n + r.entries, 0), pending === 'store:state' ? 0 : 1);
    assert.deepEqual(fs.readFileSync(f.lock), before); assert.equal(fs.existsSync(path.join(f.directory, 'reconciled-answered.lock')), false);
    assert.deepEqual(fs.readFileSync(f.report.receiptPath), original); assert.equal(fs.readFileSync(lease, 'utf8'), 'opaque');
    assert.equal(fs.existsSync(path.join(f.directory, 'answered-reconciliation.json')), false);
    assert.ok(fs.existsSync(result.receiptPath) && path.dirname(result.receiptPath) === f.directory, 'the blocked attempt is an additive receipt');
    fs.unlinkSync(lease);
    const done = reconcileO11Answered(f.root, f.session, f.options);
    assert.equal(done.state, 'reconciled-answered'); assert.equal(done.credentialsReleased, true);
  }
});
test('an unreadable or reparse lease store fails closed', t => {
  const f = fixture(t), before = fs.readFileSync(f.lock);
  const result = reconcileO11Answered(f.root, f.session, { ...f.options, legacyRoots: [...f.legacyRoots,
    { origin: 'packages', path: path.join(f.root, 'Packages'), writable: false, unreadable: true, anchor: f.root }] });
  assert.equal(result.credentialsReleased, false); assert.deepEqual(result.pending, ['legacy-store:packages']);
  assert.deepEqual(fs.readFileSync(f.lock), before);
});
test('refuses live owner/native process, changed source or submission marker', t => {
  for (const modify of [
    f => f.options.isProcessAlive = pid => pid === 123456789,
    f => f.options.isProcessAlive = pid => pid === f.native.processId,
    f => fs.appendFileSync(f.source, ' '),
    f => f.write(path.join(f.directory, f.session.nativeSessionId + '.post-1.json'), { seq: 1, sessionId: 'other' }),
  ]) {
    const f = fixture(t); modify(f); const before = fs.readFileSync(f.lock);
    assert.throws(() => reconcileO11Answered(f.root, f.session, f.options), /debug_o11_answered_reconcile_/);
    assert.deepEqual(fs.readFileSync(f.lock), before);
  }
});
test('the retained 60aa32e5 Timer wake lock is refused with debug_lock_retained_by_decision before any write, even with answered evidence', t => {
  const retained = { operationId: '60aa32e5-1100-4e1f-9d5a-7d74e5bc5ce2', host: 'personal-2qqw9srv.outsystemscloud.com', moduleKey: 'bf7WCuRy7keTqvquautTGg' };
  for (const ids of [retained, { ...retained, operationId: undefined }, { operationId: retained.operationId }]) {
    const f = fixture(t, () => {}, ids), before = fs.readFileSync(f.lock), files = fs.readdirSync(f.directory).sort();
    assert.throws(() => reconcileO11Answered(f.root, f.session, f.options), { message: 'debug_lock_retained_by_decision' });
    assert.deepEqual(fs.readFileSync(f.lock), before); assert.deepEqual(fs.readdirSync(f.directory).sort(), files);
  }
});
