import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { reconcileO11LoginRefusal } from '../debug-o11-login-reconcile.mjs';
import { createServerSessionManager } from '../debug-server-session.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-login-reconcile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const operationId = randomUUID(), sessionId = randomUUID(), nativeId = randomUUID().replaceAll('-', '');
  const target = { host: 'app.example.test', moduleKey: 'A'.repeat(22), module: 'App' };
  const directory = path.join(root, '.local/debugger/native-runs/o11', target.host, operationId);
  fs.mkdirSync(directory, { recursive: true });
  const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
  const contract = path.join(directory, 'native-entry-source.json'); write(contract, { synthetic: true });
  const sourceContract = { path: contract, sha256: sha(fs.readFileSync(contract)) };
  const published = { versionId: 1, sourceSha256: 'b'.repeat(64) };
  const report = { schema: 'ssam-o11-native-run/1', operationId, op: 'run', target, published, sourceContract,
    receiptPath: path.join(directory, 'receipt.json'), state: 'failed-or-uncertain', results: [],
    uncertain: true, lockRetained: true, credentialsReleased: true,
    worker: { memoryCleared: true, loginUncertain: false, requestUncertain: false, submitted: 0, answered: 0 } };
  const worker = { schema: 'ssam-o11-native-entry-receipt/1', sessionId: nativeId, sourceContract,
    target: { ...target, publishedVersionId: published.versionId, sourceSha256: published.sourceSha256 },
    prepared: true, phase: 'disposed', ok: false, diagnostics: { phase: 'original-login', errorType: 'InvalidLoginException' },
    authenticated: false, nativeCheckRegisteredPassed: false, rolesLoadedFromServer: false,
    loginSubmitted: true, loginAnswered: true, loginSubmittedCount: 1, loginAnsweredCount: 1,
    loginUncertain: false, requestUncertain: false, requestSubmittedCount: 0, requestAnsweredCount: 0,
    memoryCleared: true, nativeContextReferencesReleased: true, privateInspectionCleanup: { completed: true, pending: 0 } };
  const session = { sessionId, lane: 'o11', state: 'uncertain', pauses: [], runResult: report };
  mutate({ report, worker, session });
  write(report.receiptPath, report); write(path.join(directory, 'native-entry-receipt.json'), worker);
  write(path.join(directory, nativeId + '.login-attempt.json'), { sessionId: nativeId, kind: 'login', sourceContractSha256: sourceContract.sha256 });
  const lock = path.join(path.dirname(directory), target.moduleKey + '.lock'); write(lock, { operationId, pid: 123456789 });
  const sessions = path.join(root, '.local/debugger/server-sessions'); fs.mkdirSync(sessions, { recursive: true });
  write(path.join(sessions, sessionId + '.json'), session);
  return { root, directory, report, worker, session, lock, nativeId, contract, write };
}
const stopped = { isProcessAlive: () => false };
test('archives only the refused login mutex, preserves receipts and never touches a later mutex', t => {
  const f = fixture(t), original = fs.readFileSync(f.report.receiptPath), lock = fs.readFileSync(f.lock);
  const r = reconcileO11LoginRefusal(f.root, f.session, stopped);
  assert.equal(r.state, 'reconciled-login-refused'); assert.equal(r.authenticated, false);
  assert.equal(r.businessRequestsSubmitted, 0); assert.equal(r.replayed, false);
  assert.deepEqual(fs.readFileSync(r.archive), lock); assert.deepEqual(fs.readFileSync(f.report.receiptPath), original);
  assert.equal(fs.existsSync(f.lock), false);
  f.write(f.lock, { operationId: randomUUID(), pid: process.pid }); const newer = fs.readFileSync(f.lock);
  assert.deepEqual(reconcileO11LoginRefusal(f.root, f.session, stopped), r);
  assert.deepEqual(fs.readFileSync(f.lock), newer);
});
test('rejects missing response, business submissions, uncertain cleanup, or authenticated users', t => {
  const changes = [
    ({ worker }) => { worker.loginAnsweredCount = 0; },
    ({ worker }) => { worker.requestSubmittedCount = 1; },
    ({ worker }) => { worker.loginUncertain = true; },
    ({ worker }) => { worker.authenticated = true; },
    ({ worker }) => { worker.nativeContextReferencesReleased = false; },
    ({ worker }) => { worker.privateInspectionCleanup.pending = 1; },
    ({ worker }) => { worker.diagnostics.errorType = 'CommunicationException'; },
    ({ report }) => { report.serverTrace = { state: 'start-outcome-unknown' }; },
    ({ report }) => { report.results.push({ ok: false }); },
    ({ report }) => { report.credentialsReleased = false; },
    ({ report }) => { report.worker.requestUncertain = true; },
    ({ session }) => { session.nativeSessionId = 'c'.repeat(32); },
  ];
  for (const change of changes) {
    const f = fixture(t, change), bytes = fs.readFileSync(f.lock);
    assert.throws(() => reconcileO11LoginRefusal(f.root, f.session, stopped), /debug_o11_login_reconcile_/);
    assert.deepEqual(fs.readFileSync(f.lock), bytes);
    assert.equal(fs.existsSync(path.join(f.directory, 'login-refusal-reconciliation.json')), false);
  }
});
test('rejects a live owner, changed contract/owner, native session directory or post marker', t => {
  const live = fixture(t);
  assert.throws(() => reconcileO11LoginRefusal(live.root, live.session, { isProcessAlive: () => true }), /owner_still_running/);
  for (const change of [
    f => fs.appendFileSync(f.contract, 'changed'),
    f => f.write(f.lock, { operationId: randomUUID(), pid: 123456789 }),
    f => fs.mkdirSync(path.join(f.root, '.local/debugger', f.nativeId)),
    f => f.write(path.join(f.directory, f.nativeId + '.post-1.json'), {}),
  ]) {
    const f = fixture(t); change(f);
    assert.throws(() => reconcileO11LoginRefusal(f.root, f.session, stopped), /debug_o11_login_reconcile_/);
    assert.equal(fs.existsSync(f.lock), true);
  }
});
test('public coordinator reconciles stored O11 evidence without running or attaching a debugger', async t => {
  const f = fixture(t);
  const manager = createServerSessionManager({ root: f.root, run: () => assert.fail('must not run'), debug: () => assert.fail('must not attach') });
  const r = await manager({ op: 'reconcile', sessionId: f.session.sessionId });
  assert.equal(r.state, 'reconciled-login-refused'); assert.equal(r.originalEvidencePreserved, true);
});
test('archive mismatch refuses a later reconciliation', t => {
  const f = fixture(t), r = reconcileO11LoginRefusal(f.root, f.session, stopped);
  fs.appendFileSync(r.archive, 'changed');
  assert.throws(() => reconcileO11LoginRefusal(f.root, f.session, stopped), /archive_changed/);
});
