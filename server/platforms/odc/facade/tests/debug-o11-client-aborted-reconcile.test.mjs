import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { reconcileO11ClientAborted, clientAbortedReceipt } from '../debug-o11-client-aborted-reconcile.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// 'uncertain' mirrors 3cd50342/e4e5e76e and 6f01d2b6/6418f105 (terminal session carrying runResult);
// 'ending' mirrors ca6ecb62/ddeea880 (expired pause, after the store-rule private reconcile).
function fixture(t, { state = 'uncertain', mutate = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-client-aborted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const operationId = randomUUID(), sessionId = randomUUID(), nativeId = randomUUID().replaceAll('-', '');
  const target = { host: 'app.example.test', module: 'App', moduleKey: 'H'.repeat(22), runtimeUrl: 'https://app.example.test/App/' };
  const directory = path.join(root, '.local/debugger/native-runs/o11', target.host, operationId);
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  const source = path.join(directory, 'native-entry-source.json'); write(source, { fixture: true });
  const sourceContract = { path: source, sha256: sha(fs.readFileSync(source)) };
  const published = { versionId: 1, sourceSha256: 'b'.repeat(64) };
  const run = { schema: 'ssam-o11-native-run/1', operationId, lane: 'o11', execution: 'native-entry', op: 'run', state: 'invoking', target,
    receiptPath: path.join(directory, 'receipt.json'), trace: 'none', results: [], sourceContract, published,
    entryAbi: { kind: 'client-action', endpoints: [] }, scenarios: [{ name: 'a' }, { name: 'b' }],
    tracePlan: { mode: 'none', client: false, server: null }, needs: { serverTrace: null }, appUserAuthenticated: true };
  if (state === 'uncertain') Object.assign(run, { state: 'answered', scenarios: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    results: [{ name: 'a', ok: true, outputs: {}, requests: { submitted: 0, answered: 0 }, uncertain: false },
      { name: 'b', ok: false, uncertain: true, error: 'debug_o11_native_worker_unavailable' }],
    notSent: ['c'], worker: { memoryCleared: false, requestUncertain: false, loginUncertain: false, submitted: 0, answered: 0 },
    credentialsReleased: true, uncertain: true, ok: false, lockRetained: true });
  const worker = { schema: 'ssam-o11-native-entry-receipt/1', ok: true, prepared: true, phase: 'authenticated', sessionId: nativeId,
    target: { lane: 'o11', ...target, publishedVersionId: 1, sourceSha256: published.sourceSha256 }, sourceContract,
    entry: { kind: 'client-action', endpoint: null }, loginSubmitted: true, loginAnswered: true, loginSubmittedCount: 1, loginAnsweredCount: 1,
    loginUncertain: false, requestSubmittedCount: 0, requestAnsweredCount: 0, requestUncertain: false,
    scenarios: state === 'uncertain' ? [{ name: 'a', ok: true, submitted: 0, answered: 0, uncertain: false }] : [] };
  const sessionFile = path.join(root, '.local/debugger/client-sessions', sessionId + '.json');
  const session = { ok: true, sessionId, lane: 'o11', runtime: 'client', state, metadataEvidence: [], receiptPath: sessionFile };
  if (state === 'uncertain') Object.assign(session, { stopEvidence: { command: 'stop', privateInspectionCleanup: { completed: true, pending: 0 } }, runResult: run });
  else session.pause = { sessionId: 'd'.repeat(48), expiresAt: new Date(Date.now() - 1000).toISOString(), frame: 0, frames: [{ elementKey: target.moduleKey + ':' + 'F'.repeat(22) + ':' }] };
  const facts = { run, worker, session, directory, root, nativeId, write };
  mutate(facts);
  write(run.receiptPath, run); write(path.join(directory, 'native-entry-receipt.json'), worker);
  write(path.join(directory, nativeId + '.login-attempt.json'), { sessionId: nativeId, kind: 'login', sourceContractSha256: sourceContract.sha256 });
  if (state === 'uncertain') session.runResult = JSON.parse(fs.readFileSync(run.receiptPath));
  write(sessionFile, session);
  const lock = path.join(path.dirname(directory), target.moduleKey + '.lock'); write(lock, { operationId, pid: 123456789 });
  const legacy = (area, origin) => path.join(root, 'legacy', origin, 'SSAM', area);
  const mk = dir => { fs.mkdirSync(dir, { recursive: true }); return dir; };
  const vaultRoot = mk(path.join(root, 'state', 'app-user')), invokeRoot = mk(path.join(root, 'state', 'invoke'));
  const legacyRoots = [{ origin: 'current', path: mk(legacy('DebugAppUser', 'current')), writable: true, anchor: root },
    { origin: 'package:OpenAI.Codex_2p2nqsd0c76g0', path: mk(legacy('DebugAppUser', 'codex')), writable: false, anchor: root }];
  const invokeLegacyRoots = [{ origin: 'current', path: mk(legacy('DebugInvoke', 'current')), writable: true, anchor: root },
    { origin: 'package:OpenAI.Codex_2p2nqsd0c76g0', path: mk(legacy('DebugInvoke', 'codex')), writable: false, anchor: root }];
  const observeProcesses = async ownerPid => ({ observedAt: new Date().toISOString(), ownerPid, ownerPresent: false, workerCount: 0,
    unreadableNodeCount: 0, workerStopped: true, source: 'windows-cim-process-inventory', nativeDisposalConfirmed: false });
  const options = { isProcessAlive: () => false, observeProcesses, vaultRoot, legacyRoots, invokeRoot, invokeLegacyRoots };
  if (state === 'ending') {
    const file = path.join(root, '.local/debugger/client-reconciliations', sessionId + '.' + operationId + '.json');
    const privateCleanup = { schema: 'ssam-private-inspection-recovery/1', completed: true, pending: 0, pendingStores: [],
      stateRoot: invokeRoot, legacyInventory: [{ origin: 'current', entries: 0, readable: true }] };
    const stored = { ok: true, schema: 'ssam-client-private-reconciliation/1', sessionId, operationId, state: 'requires-reconciliation',
      privateCleanup, pins: [], receiptPath: file, executionComplete: false, mutexReleased: false, replayed: false,
      pending: ['worker-termination-evidence', 'execution-outcome', 'app-user-credential-release'] };
    write(file, stored);
    options.privateReceipt = { ...stored, workerStopped: true, credentialsReleased: true, pending: ['execution-outcome'] };
  }
  return { ...facts, sessionFile, lock, options, operationId, sessionId, target };
}
const tree = dir => fs.readdirSync(dir, { recursive: true }).sort();
test('uncertain session with runResult and zero submissions archives the mutex by rename without claiming execution', async t => {
  const f = fixture(t), lock = fs.readFileSync(f.lock), run = fs.readFileSync(f.run.receiptPath), session = fs.readFileSync(f.sessionFile);
  const result = await reconcileO11ClientAborted(f.root, f.session, f.operationId, f.options);
  assert.equal(result.ok, true); assert.equal(result.schema, 'ssam-o11-client-aborted-reconciliation/1');
  assert.equal(result.state, 'reconciled-client-aborted'); assert.equal(result.executionOutcome, 'aborted-unconfirmed');
  assert.equal(result.businessRequestsSubmitted, 0); assert.equal(result.replayed, false); assert.equal(result.valuesComplete, false);
  assert.equal(result.lifecycleProved, false); assert.equal(result.executionComplete, false); assert.equal(result.mutexArchived, true);
  assert.equal(result.loginAnswered, true); assert.equal(result.nativeDebuggerStarted, false);
  assert.deepEqual(result.answeredScenarios.map(s => s.name), ['a']); assert.deepEqual(result.interruptedScenarios, ['b']);
  assert.deepEqual(result.notSentScenarios, ['c']);
  assert.equal(result.archive, path.join(f.directory, 'reconciled-client-aborted.lock'));
  assert.equal(result.receiptPath, path.join(f.directory, 'client-aborted-reconciliation.json'));
  assert.equal(fs.existsSync(f.lock), false); assert.deepEqual(fs.readFileSync(result.archive), lock);
  assert.equal(result.lockSha256, sha(lock)); assert.deepEqual(fs.readFileSync(f.run.receiptPath), run);
  assert.deepEqual(fs.readFileSync(f.sessionFile), session);
  assert.equal(result.privateCleanup.source, 'store-inventory-empty'); assert.equal(result.credentialsReleased, true);
  assert.deepEqual(clientAbortedReceipt(f.root, f.operationId), result);
  // Idempotent: the same receipt; a newer lock of another operation is never touched.
  f.write(f.lock, { operationId: randomUUID(), pid: process.pid }); const newer = fs.readFileSync(f.lock);
  assert.deepEqual(await reconcileO11ClientAborted(f.root, f.session, f.operationId,
    { ...f.options, observeProcesses: () => assert.fail('completed receipt is reused') }), result);
  assert.deepEqual(fs.readFileSync(f.lock), newer);
});
test('ending session after the store-rule private reconcile is accepted (ca6ecb62 shape)', async t => {
  const f = fixture(t, { state: 'ending' });
  const result = await reconcileO11ClientAborted(f.root, f.session, f.operationId, f.options);
  assert.equal(result.ok, true); assert.equal(result.sessionState, 'ending'); assert.deepEqual(result.answeredScenarios, []);
  assert.deepEqual(result.interruptedScenarios, ['a', 'b']); assert.equal(result.privateCleanup.source, 'private-reconciliation');
  assert.ok(result.pins.some(p => p.path === f.options.privateReceipt.receiptPath));
  assert.deepEqual(await reconcileO11ClientAborted(f.root, f.session, f.operationId, f.options), result);
});
test('ending session without a store-rule private reconcile is refused', async t => {
  const f = fixture(t, { state: 'ending' });
  await assert.rejects(() => reconcileO11ClientAborted(f.root, f.session, f.operationId, { ...f.options, privateReceipt: undefined }), /private_cleanup_unconfirmed/);
  const pre = { ...f.options.privateReceipt, privateCleanup: { completed: true, pending: 0 } };
  await assert.rejects(() => reconcileO11ClientAborted(f.root, f.session, f.operationId, { ...f.options, privateReceipt: pre }), /private_cleanup_unconfirmed/);
  await assert.rejects(() => reconcileO11ClientAborted(f.root, f.session, f.operationId,
    { ...f.options, privateReceipt: { ...f.options.privateReceipt, pending: ['execution-outcome', 'legacy-store:X'] } }), /private_cleanup_unconfirmed/);
  assert.ok(fs.existsSync(f.lock));
});
test('submissions, markers, debugger evidence, endpoints, live owners or changed pins are refused and keep the lock', async t => {
  const cases = [
    [{ mutate: x => { x.worker.requestSubmittedCount = 1; x.worker.requestAnsweredCount = 1; } }, /request_evidence_invalid/],
    [{ mutate: x => { x.run.worker.submitted = 1; } }, /run_evidence_invalid/],
    [{ mutate: x => { x.run.results[0].requests.submitted = 1; } }, /scenario_outcome_invalid/],
    [{ mutate: x => x.write(path.join(x.directory, x.nativeId + '.post-1.json'), { seq: 1 }) }, /submission_observed/],
    [{ mutate: x => x.write(path.join(x.root, '.local/debugger', x.nativeId, 'receipt.json'), { state: 'stopped' }) }, /native_debugger_observed/],
    [{ mutate: x => { x.run.serverTrace = { sessionId: x.nativeId }; } }, /run_evidence_invalid/],
    [{ mutate: x => { x.worker.entry.endpoint = 'https://app.example.test/App/screenservices/x'; } }, /request_evidence_invalid/],
    [{ mutate: x => { x.run.entryAbi.endpoints = ['screenservices/x']; } }, /run_evidence_invalid/],
    [{ mutate: x => { x.worker.loginUncertain = true; } }, /request_evidence_invalid/],
  ];
  for (const [options, pattern] of cases) {
    const f = fixture(t, options);
    await assert.rejects(() => reconcileO11ClientAborted(f.root, f.session, f.operationId, f.options), pattern);
    assert.ok(fs.existsSync(f.lock)); assert.equal(fs.existsSync(path.join(f.directory, 'client-aborted-reconciliation.json')), false);
  }
  const live = fixture(t);
  await assert.rejects(() => reconcileO11ClientAborted(live.root, live.session, live.operationId, { ...live.options, isProcessAlive: () => true }), /owner_not_stopped/);
  const other = fixture(t); other.write(other.lock, { operationId: randomUUID(), pid: 123456789 });
  await assert.rejects(() => reconcileO11ClientAborted(other.root, other.session, other.operationId, other.options), /mutex_owner_changed/);
  const changed = fixture(t);
  await assert.rejects(() => reconcileO11ClientAborted(changed.root, { ...changed.session, revision: 99 }, changed.operationId, changed.options), /session_changed/);
  const drift = fixture(t); drift.run.results = []; drift.write(drift.run.receiptPath, drift.run);
  await assert.rejects(() => reconcileO11ClientAborted(drift.root, JSON.parse(fs.readFileSync(drift.sessionFile)), drift.operationId, drift.options), /run_result_changed/);
  const midway = fixture(t);
  await assert.rejects(() => reconcileO11ClientAborted(midway.root, midway.session, midway.operationId, { ...midway.options,
    observeProcesses: async pid => { fs.appendFileSync(midway.run.receiptPath, ' '); return midway.options.observeProcesses(pid); } }), /evidence_changed/);
  assert.ok(fs.existsSync(midway.lock));
  const completed = fixture(t);
  await assert.rejects(() => reconcileO11ClientAborted(completed.root, { ...completed.session, state: 'completed' }, completed.operationId, completed.options), /not_eligible/);
});
test('a lease in a package store, a live worker, a stale observation or unproved private cleanup blocks additively', async t => {
  const cases = [
    [f => { fs.writeFileSync(path.join(f.options.legacyRoots[1].path, randomUUID() + '.dpapi'), 'opaque'); }, 'legacy-store:OpenAI.Codex_2p2nqsd0c76g0'],
    [f => { f.options.observeProcesses = async pid => ({ observedAt: new Date().toISOString(), ownerPid: pid, ownerPresent: false, workerCount: 1, unreadableNodeCount: 0, workerStopped: false }); }, 'worker-termination-evidence'],
    [f => { f.options.observeProcesses = async pid => ({ observedAt: '2000-01-01T00:00:00Z', ownerPid: pid, ownerPresent: false, workerCount: 0, unreadableNodeCount: 0, workerStopped: true }); }, 'worker-termination-evidence'],
    [f => { f.options.observeProcesses = async () => { throw new Error('unavailable'); }; }, 'worker-termination-evidence'],
    [f => { fs.writeFileSync(path.join(f.options.invokeLegacyRoots[1].path, randomUUID() + '.dpapi'), 'opaque'); }, 'private-inspection:legacy-store:OpenAI.Codex_2p2nqsd0c76g0'],
  ];
  for (const [arrange, pending] of cases) {
    const f = fixture(t); arrange(f); const before = fs.readFileSync(f.lock);
    const result = await reconcileO11ClientAborted(f.root, f.session, f.operationId, f.options);
    assert.equal(result.ok, false); assert.equal(result.mutexArchived, false); assert.ok(result.pending.includes(pending), JSON.stringify(result.pending));
    assert.deepEqual(fs.readFileSync(f.lock), before); assert.ok(fs.existsSync(result.receiptPath));
    assert.match(path.basename(result.receiptPath), /^client-aborted-reconciliation\.blocked-\d+\.json$/);
  }
  // A store-rule cleanup recorded at stop is enough even when another store holds unrelated records.
  const ruled = fixture(t, { mutate: x => { x.session.stopEvidence.privateInspectionCleanup = { completed: true, pending: 0, pendingStores: [], stateRoot: 'C:\\x', legacyInventory: [] }; } });
  fs.writeFileSync(path.join(ruled.options.invokeLegacyRoots[1].path, randomUUID() + '.dpapi'), 'opaque');
  const accepted = await reconcileO11ClientAborted(ruled.root, ruled.session, ruled.operationId, ruled.options);
  assert.equal(accepted.ok, true); assert.equal(accepted.privateCleanup.source, 'stop-evidence');
});
test('the public client reconcile chains the real aborted reconcile after the private cleanup and repeats idempotently', async t => {
  const { reconcileClientPrivateValues } = await import('../debug-client-private-reconcile.mjs');
  const f = fixture(t, { state: 'ending', mutate: x => {
    const scope = path.join(x.root, '.local/debugger/client-sessions', x.session.sessionId, 'scope-0.json');
    x.write(scope, { data: { moduleKey: x.run.target.moduleKey, functionKey: 'F'.repeat(22), sourceSha256: x.run.published.sourceSha256 } });
    x.session.metadataEvidence = [scope];
  } });
  fs.rmSync(f.options.privateReceipt.receiptPath);
  const { privateReceipt, ...options } = f.options, lock = fs.readFileSync(f.lock);
  const services = { recover: async () => ({ completed: true, pending: 0, pendingStores: [], stateRoot: f.options.invokeRoot, legacyInventory: [] }),
    observeOrphan: async (root, receipt) => ({ workerStopped: true, credentialsReleased: true, pending: [], receiptPath: receipt.receiptPath,
      processEvidence: await options.observeProcesses(123456789) }),
    reconcileAborted: (root, session, operationId, extra) => reconcileO11ClientAborted(root, session, operationId, { ...options, ...extra }) };
  const r = await reconcileClientPrivateValues(f.root, f.session, f.operationId, services);
  assert.equal(r.clientAbortedReconciliation.ok, true, JSON.stringify(r.clientAbortedReconciliation)); assert.deepEqual(r.pending, []);
  assert.equal(r.mutexReleased, true); assert.equal(r.executionComplete, false); assert.equal(r.executionOutcome, 'aborted-unconfirmed');
  assert.equal(fs.existsSync(f.lock), false); assert.deepEqual(fs.readFileSync(r.clientAbortedReconciliation.archive), lock);
  const again = await reconcileClientPrivateValues(f.root, f.session, f.operationId, { ...services, recover: () => assert.fail('reused'),
    observeOrphan: () => assert.fail('archived run is not observed again') });
  assert.deepEqual(again, r);
});
test('dry run evaluates every criterion and writes nothing', async t => {
  const f = fixture(t), before = tree(f.root);
  const result = await reconcileO11ClientAborted(f.root, f.session, f.operationId, { ...f.options, dryRun: true });
  assert.equal(result.ok, true); assert.equal(result.dryRun, true); assert.equal(result.wouldArchive, true); assert.equal(result.mutexArchived, false);
  assert.deepEqual(tree(f.root), before); assert.ok(fs.existsSync(f.lock));
  fs.writeFileSync(path.join(f.options.legacyRoots[1].path, randomUUID() + '.dpapi'), 'opaque'); const blocked = tree(f.root);
  const refused = await reconcileO11ClientAborted(f.root, f.session, f.operationId, { ...f.options, dryRun: true });
  assert.equal(refused.wouldArchive, false); assert.deepEqual(tree(f.root), blocked);
});
