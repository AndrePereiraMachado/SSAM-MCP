import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { reconcileO11Prestart, verifyO11PrestartArchive, classifyO11ServerReconcile, reconcileO11ServerByEvidence } from '../debug-o11-prestart-reconcile.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Mirrors 36886778: anonymous REST run whose server-trace start threw before any worker, login or request.
function fixture(t, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-prestart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '.local/debugger'), operationId = randomUUID(), sessionId = randomUUID(), nativeId = randomUUID().replaceAll('-', '');
  const target = { host: 'app.example.test', module: 'Probe', moduleKey: 'B'.repeat(22), runtimeUrl: 'https://app.example.test/Probe/' };
  const directory = path.join(base, 'native-runs/o11', target.host, operationId);
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  const source = path.join(directory, 'native-rest-source.json'); write(source, { fixture: true });
  const nodeKeys = ['N'.repeat(22)];
  const report = { schema: 'ssam-o11-native-run/1', operationId, lane: 'o11', execution: 'native-entry', op: 'run', state: 'refused', target,
    receiptPath: path.join(directory, 'receipt.json'), trace: 'full', results: [],
    sourceContract: { path: source, sha256: sha(fs.readFileSync(source)) }, published: { versionId: 1, sourceSha256: 'c'.repeat(64) },
    tracePlan: { mode: 'full', client: false, server: { module: target.module, moduleKey: target.moduleKey, runtimeUrl: target.runtimeUrl, nodeKeys, allowed: true } },
    entryAbi: { kind: 'rest-method', endpoint: target.runtimeUrl + 'rest/Probe/Echo' }, scenarios: [{ name: 'one' }],
    needs: { loginWindow: false, contextMode: 'anonymous', appUser: null, serverTrace: { module: target.module, allowed: true, reason: null } },
    error: 'debug_o11_native_server_trace_start_uncertain', uncertain: true, ok: false, lockRetained: true };
  const session = { ok: true, sessionId, lane: 'o11', runtime: 'server', state: 'uncertain', revision: 3,
    createdAt: new Date(Date.now() - 2000).toISOString(), scopeComplete: false, metadataEvidence: [], pauses: [], runResult: report,
    receiptPath: path.join(base, 'server-sessions', sessionId + '.json') };
  const manifest = { sessionId: nativeId, lane: 'o11', tenant: target.host, module: target.module, moduleKey: target.moduleKey,
    runtimeUrl: target.runtimeUrl, nodeKeys, lock: path.join(base, 'f'.repeat(64) + '.lock'), receiptPath: path.join(base, nativeId, 'receipt.json'), contextMode: 'anonymous' };
  const native = { ok: false, state: 'not-started', sessionId: nativeId };
  const facts = { report, session, manifest, native, directory, base, nativeId, write, root };
  mutate(facts);
  write(path.join(base, nativeId, 'manifest.json'), manifest); write(path.join(base, nativeId, 'receipt.json'), native);
  write(report.receiptPath, report); session.runResult = JSON.parse(fs.readFileSync(report.receiptPath));
  write(session.receiptPath, session);
  const lock = path.join(path.dirname(directory), target.moduleKey + '.lock'); write(lock, { operationId, pid: 123456789 });
  const vaultRoot = path.join(root, 'state', 'app-user'); fs.mkdirSync(vaultRoot, { recursive: true });
  const legacyRoots = [{ origin: 'package:OpenAI.Codex_2p2nqsd0c76g0', path: path.join(root, 'legacy', 'codex'), writable: false, anchor: root }];
  fs.mkdirSync(legacyRoots[0].path, { recursive: true });
  const observeProcesses = async ownerPid => ({ observedAt: new Date().toISOString(), ownerPid, ownerPresent: false, workerCount: 0,
    unreadableNodeCount: 0, workerStopped: true, source: 'windows-cim-process-inventory', nativeDisposalConfirmed: false });
  return { ...facts, lock, operationId, target, options: { isProcessAlive: () => false, observeProcesses, vaultRoot, legacyRoots } };
}
const tree = dir => fs.readdirSync(dir, { recursive: true }).sort();
test('confirmed-not-started (no worker, no native token, zero remote calls, no credential) archives the mutex by rename', async t => {
  const f = fixture(t), lock = fs.readFileSync(f.lock), run = fs.readFileSync(f.report.receiptPath);
  const result = await reconcileO11Prestart(f.root, f.session, f.options);
  assert.equal(result.ok, true); assert.equal(result.schema, 'ssam-o11-prestart-reconciliation/1');
  assert.equal(result.evidenceClass, 'confirmed-not-started'); assert.equal(result.state, 'reconciled-not-started');
  assert.equal(result.allCriteriaPassed, true); assert.ok(result.criteria.length >= 8 && result.criteria.every(c => c.passed));
  assert.equal(result.remoteCalls, 0); assert.equal(result.businessRequestsSubmitted, 0); assert.equal(result.nativeWorkerStarted, false);
  assert.equal(result.nativeSessionTokenObtained, false); assert.equal(result.appUserCredentialsAcquired, false);
  assert.equal(result.replayed, false); assert.equal(result.executionComplete, false); assert.deepEqual(result.nativeCandidates, [f.nativeId]);
  assert.equal(result.archive, path.join(f.directory, 'reconciled-prestart.lock')); assert.equal(fs.existsSync(f.lock), false);
  assert.deepEqual(fs.readFileSync(result.archive), lock); assert.deepEqual(fs.readFileSync(f.report.receiptPath), run);
  f.write(f.lock, { operationId: randomUUID(), pid: process.pid }); const newer = fs.readFileSync(f.lock);
  assert.deepEqual(await reconcileO11Prestart(f.root, f.session, { ...f.options, observeProcesses: () => assert.fail('reused') }), result);
  assert.deepEqual(fs.readFileSync(f.lock), newer);
  // The public archive is itself verifiable read-only.
  const before = tree(f.root), verified = await verifyO11PrestartArchive(f.root, { host: f.target.host, operationId: f.operationId }, f.options);
  assert.equal(verified.allCriteriaPassed, true, JSON.stringify(verified.criteria.filter(c => !c.passed))); assert.deepEqual(tree(f.root), before);
});
test('a worker, a login, a native token, an app user, a live owner or a private archive is not confirmed-not-started', async t => {
  const cases = [
    [x => x.write(path.join(x.directory, 'native-entry-receipt.json'), { sessionId: 'x' }), /worker_observed/],
    [x => x.write(path.join(x.directory, x.nativeId + '.login-attempt.json'), { kind: 'login' }), /worker_observed/],
    [x => x.write(path.join(x.directory, x.nativeId + '.post-1.json'), { seq: 1 }), /worker_observed/],
    [x => { x.native.transport = { tokenObtained: true }; }, /native_session_token/],
    [x => { x.native.state = 'connected'; }, /native_session_token/],
    [x => { x.report.needs.contextMode = 'app-user'; x.report.needs.appUser = 'Probe app user'; }, /credential_acquired/],
    [x => { x.report.appUserAuthenticated = true; }, /credential_acquired/],
    [x => { x.report.serverTrace = { sessionId: x.nativeId, state: 'connected' }; }, /run_evidence_invalid/],
    [x => { x.report.results = [{ name: 'one', ok: true }]; }, /run_evidence_invalid/],
  ];
  for (const [mutate, pattern] of cases) {
    const f = fixture(t, mutate);
    await assert.rejects(() => reconcileO11Prestart(f.root, f.session, f.options), pattern); assert.ok(fs.existsSync(f.lock));
  }
  const live = fixture(t);
  await assert.rejects(() => reconcileO11Prestart(live.root, live.session, { ...live.options, isProcessAlive: () => true }), /owner_not_stopped/);
  const held = fixture(t); held.write(path.join(held.base, path.basename(held.manifest.lock)), { pid: 1 });
  await assert.rejects(() => reconcileO11Prestart(held.root, held.session, held.options), /native_session_token/);
  const prior = fixture(t); prior.write(path.join(prior.directory, 'local-prestart-reconciliation.json'), { schema: 'ssam-o11-local-prestart-reconciliation/1' });
  await assert.rejects(() => reconcileO11Prestart(prior.root, prior.session, prior.options), /archived_privately_use_verify/);
  const changed = fixture(t);
  await assert.rejects(() => reconcileO11Prestart(changed.root, { ...changed.session, revision: 9 }, changed.options), /session_changed/);
});
test('a live worker or a remaining lease blocks additively and keeps the lock', async t => {
  for (const arrange of [f => { f.options.observeProcesses = async pid => ({ observedAt: new Date().toISOString(), ownerPid: pid, ownerPresent: false, workerCount: 1, unreadableNodeCount: 0, workerStopped: false }); },
    f => { fs.writeFileSync(path.join(f.options.legacyRoots[0].path, randomUUID() + '.dpapi'), 'opaque'); }]) {
    const f = fixture(t); arrange(f);
    const result = await reconcileO11Prestart(f.root, f.session, f.options);
    assert.equal(result.ok, false); assert.equal(result.allCriteriaPassed, false); assert.equal(result.mutexArchived, false);
    assert.ok(fs.existsSync(f.lock)); assert.match(path.basename(result.receiptPath), /^prestart-reconciliation\.blocked-\d+\.json$/);
  }
});
test('server reconcile dispatches by evidence class: answered, confirmed-not-started, login-refusal', async t => {
  const f = fixture(t);
  assert.equal(classifyO11ServerReconcile(f.root, f.session), 'confirmed-not-started');
  assert.equal(classifyO11ServerReconcile(f.root, { ...f.session, nativeSessionId: 'a'.repeat(32) }), 'answered');
  const login = fixture(t, x => x.write(path.join(x.directory, 'native-entry-receipt.json'), { sessionId: x.nativeId }));
  assert.equal(classifyO11ServerReconcile(login.root, login.session), 'login-refusal');
  const seen = [];
  const deps = { answered: async () => (seen.push('answered'), 'A'), loginRefusal: async () => (seen.push('login'), 'L'), prestart: async () => (seen.push('prestart'), 'P') };
  assert.equal(await reconcileO11ServerByEvidence(f.root, f.session, deps), 'P');
  assert.equal(await reconcileO11ServerByEvidence(f.root, { ...f.session, nativeSessionId: 'a'.repeat(32) }, deps), 'A');
  assert.equal(await reconcileO11ServerByEvidence(login.root, login.session, deps), 'L');
  assert.deepEqual(seen, ['prestart', 'answered', 'login']);
});
// The private 36886778 archive: ssam-o11-local-prestart-reconciliation/1 with relative originalEvidence pins.
function privateArchive(t, mutate = () => {}) {
  const f = fixture(t), archive = path.join(f.directory, 'reconciled-local-prestart.lock'), lockBytes = fs.readFileSync(f.lock);
  fs.renameSync(f.lock, archive);
  const rel = file => path.relative(f.base, file).split(path.sep).join('/');
  const pin = file => [rel(file), sha(fs.readFileSync(file))];
  const receipt = { schema: 'ssam-o11-local-prestart-reconciliation/1', operationId: f.operationId, nativeSessionId: f.nativeId, at: new Date().toISOString(),
    originalEvidence: { public: pin(f.session.receiptPath), runner: pin(f.report.receiptPath),
      native: pin(path.join(f.base, f.nativeId, 'receipt.json')), manifest: pin(path.join(f.base, f.nativeId, 'manifest.json')) },
    lockSha256: sha(lockBytes), originalLock: f.lock, archive, remoteCalls: 0, businessRequestsSubmitted: 0, nativeWorkerStarted: false,
    nativeDebuggerStarted: false, appUserCredentialsAcquired: false, classification: 'confirmed-not-started', originalReceiptsPreserved: true,
    allCriteriaPassed: false, state: 'reconciled-not-started', mutexArchived: true };
  mutate({ ...f, receipt, archive });
  f.write(path.join(f.directory, 'local-prestart-reconciliation.json'), receipt);
  return { ...f, archive, receipt };
}
test('verify mode re-checks the private archive read-only and reports allCriteriaPassed honestly', async t => {
  const f = privateArchive(t), before = tree(f.root), bytes = fs.readFileSync(path.join(f.directory, 'local-prestart-reconciliation.json'));
  const result = await verifyO11PrestartArchive(f.root, { host: f.target.host, operationId: f.operationId }, f.options);
  assert.equal(result.schema, 'ssam-o11-prestart-archive-verification/1'); assert.equal(result.readOnly, true); assert.equal(result.wrote, false);
  assert.equal(result.allCriteriaPassed, true, JSON.stringify(result.criteria.filter(c => !c.passed)));
  assert.equal(result.archiveClaimedAllCriteriaPassed, false); assert.equal(result.evidenceClass, 'confirmed-not-started');
  assert.ok(result.criteria.some(c => c.id === 'native-session-candidate-consistent' && c.inferred === true));
  assert.deepEqual(tree(f.root), before); assert.deepEqual(fs.readFileSync(path.join(f.directory, 'local-prestart-reconciliation.json')), bytes);
  const failed = (r, id) => r.criteria.find(c => c.id === id)?.passed === false;
  const tampered = privateArchive(t); fs.appendFileSync(tampered.archive, ' ');
  const r1 = await verifyO11PrestartArchive(tampered.root, { host: tampered.target.host, operationId: tampered.operationId }, tampered.options);
  assert.equal(r1.allCriteriaPassed, false); assert.ok(failed(r1, 'archive-lock-intact'));
  const edited = privateArchive(t); fs.appendFileSync(edited.report.receiptPath, ' ');
  const r2 = await verifyO11PrestartArchive(edited.root, { host: edited.target.host, operationId: edited.operationId }, edited.options);
  assert.equal(r2.allCriteriaPassed, false); assert.ok(failed(r2, 'original-evidence-unchanged'));
  const relocked = privateArchive(t); relocked.write(relocked.lock, { operationId: relocked.operationId, pid: 1 });
  const r3 = await verifyO11PrestartArchive(relocked.root, { host: relocked.target.host, operationId: relocked.operationId }, relocked.options);
  assert.equal(r3.allCriteriaPassed, false); assert.ok(failed(r3, 'original-lock-released'));
  const busy = privateArchive(t);
  const r4 = await verifyO11PrestartArchive(busy.root, { host: busy.target.host, operationId: busy.operationId }, { ...busy.options,
    observeProcesses: async () => { throw new Error('unavailable'); } });
  assert.equal(r4.allCriteriaPassed, false); assert.ok(failed(r4, 'worker-absent-now'));
  const wrongNative = privateArchive(t, x => { x.receipt.nativeSessionId = 'e'.repeat(32); });
  const r5 = await verifyO11PrestartArchive(wrongNative.root, { host: wrongNative.target.host, operationId: wrongNative.operationId }, wrongNative.options);
  assert.equal(r5.allCriteriaPassed, false); assert.ok(failed(r5, 'native-session-candidate-consistent'));
  await assert.rejects(() => verifyO11PrestartArchive(f.root, { host: f.target.host, operationId: randomUUID() }, f.options), /archive_not_found/);
});
