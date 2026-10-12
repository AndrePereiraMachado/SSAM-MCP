import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createOdcNativeEvidence, reconcileOdcNativeCleanup, cleanupRecordStatus, CLEANUP_STAGES } from '../debug-odc-native-evidence.mjs';
import { privateRequest } from '../debug-invoke-http.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const now = Date.now(), sessionId = 'a'.repeat(32), probeId = 'scenario-1-1';
const binding = { lane: 'odc', sessionId, tenant: 'dev.example.test', app: 'Store', module: 'Store', moduleKey: 'B'.repeat(22), runtimeUrl: 'https://dev.example.test/Store/', revision: 1 };
const data = { path: '/Store/screenservices/Store/F/Page/ActionCompute', hub: '/Store/moduleservices/debugger/requestshub',
  requestSha256: hash('synthetic body'), nativeCallContextId: 'synthetic-private-ccid', connectionToken: 'synthetic-private-channel', connectionId: 'synthetic-private-id',
  nativeUserAgent: 'Microsoft SignalR/7.0 (7.0.12; Browser; Unknown; Unknown Version)', leaseExpiresAt: now + 600000, startedAt: now, deadline: now + 30000,
  appUserKeySha256: hash('synthetic-user'), executeRequestSubmissions: 0, responseCompleted: false, cleanupAttempted: false, cleanupAccepted: false,
  cleanupStatus: null, transport: 'long-polling' };
const descriptor = { binding, credentialRef: randomUUID(), expiresAt: new Date(now + 600000).toISOString() };
const session = { binding, userKey: 'synthetic-user', accessToken: 'SYNTHETIC_BEARER_NEVER_PERSISTED.' + 'a'.repeat(1500), expiresAt: descriptor.expiresAt };
function memoryVault() {
  const saved = new Map();
  return { saved, vault: async (mode, id, value) => {
    if (mode === 'Seal') { if (saved.has(id)) throw new Error('CreateNew refused'); saved.set(id, structuredClone(value)); return { ok: true }; }
    if (mode === 'Open') { if (!saved.has(id)) throw new Error('missing'); return structuredClone(saved.get(id)); }
    throw new Error('unexpected mode');
  } };
}

test('private evidence preserves exact correlation values while public proof contains only hashes', async () => {
  const f = memoryVault(), operationId = randomUUID(), evidence = createOdcNativeEvidence({ operationId, binding, sessionId, vault: f.vault });
  const proof = await evidence.write('channel-opened', probeId, data);
  assert.equal(proof.sealed, true); assert.match(proof.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(proof).includes('synthetic-private'), false);
  assert.equal([...f.saved.values()][0].data.nativeCallContextId, data.nativeCallContextId);
  assert.equal([...f.saved.values()][0].data.connectionToken, data.connectionToken);
  assert.equal(JSON.stringify([...f.saved.values()]).includes(session.accessToken), false);
  await assert.rejects(evidence.write('channel-opened', probeId, data), /evidence_not_saved/);
  await assert.rejects(evidence.write('finished', probeId, { ...data, authorization: 'forbidden' }), /record_invalid/);
});

test('cleanup reconciliation sends exactly one native DELETE under the same unexpired app session', async () => {
  const f = memoryVault(), operationId = randomUUID(), evidence = createOdcNativeEvidence({ operationId, binding, sessionId, vault: f.vault });
  await evidence.write('channel-opened', probeId, data);
  const calls = [], options = { vault: f.vault, clock: () => now, openSession: async () => session, fetchImpl: async (url, request) => {
    calls.push({ url, request }); return new Response(null, { status: 204 });
  } };
  const result = await reconcileOdcNativeCleanup({ operationId, probeId, descriptor }, options);
  assert.equal(result.completed, true); assert.equal(result.businessRequestSent, false); assert.equal(result.lockRetained, true);
  assert.equal(result.executionOutcomeProved, false); assert.equal(calls.length, 1); assert.equal(calls[0].request.method, 'DELETE');
  assert.equal(calls[0].url.searchParams.get('id'), data.connectionToken); assert.equal(calls[0].request.headers.authorization, 'Bearer ' + session.accessToken);
  assert.equal(JSON.stringify(result).includes('synthetic-private'), false);
  await assert.rejects(reconcileOdcNativeCleanup({ operationId, probeId, descriptor }, options), /evidence_not_saved/);
  assert.equal(calls.length, 1);
});

test('lost DELETE answer stays uncertain and its reservation blocks all repeat sends', async () => {
  const f = memoryVault(), operationId = randomUUID();
  await createOdcNativeEvidence({ operationId, binding, sessionId, vault: f.vault }).write('channel-opened', probeId, data);
  let calls = 0; const options = { vault: f.vault, clock: () => now, openSession: async () => session, fetchImpl: async () => { calls++; throw new Error('lost'); } };
  const result = await reconcileOdcNativeCleanup({ operationId, probeId, descriptor }, options);
  assert.equal(result.completed, false); assert.equal(result.uncertain, true); assert.equal(result.lockRetained, true);
  await assert.rejects(reconcileOdcNativeCleanup({ operationId, probeId, descriptor }, options), /evidence_not_saved/);
  assert.equal(calls, 1);
});

test('private cleanup timeout cannot outlast the shortest original credential lease', async t => {
  const f = memoryVault(), operationId = randomUUID(), budgets = [];
  await createOdcNativeEvidence({ operationId, binding, sessionId, vault: f.vault }).write('channel-opened', probeId, data);
  t.mock.method(AbortSignal, 'timeout', ms => { budgets.push(ms); return new AbortController().signal; });
  const shorter = { ...descriptor, expiresAt: new Date(now + 750).toISOString() };
  const result = await reconcileOdcNativeCleanup({ operationId, probeId, descriptor: shorter }, {
    vault: f.vault, clock: () => now, openSession: async () => session,
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  assert.equal(result.completed, true); assert.deepEqual(budgets, [750]);
});

test('cleanup refuses another app, expired lease or another app user without network', async () => {
  const f = memoryVault(), operationId = randomUUID();
  await createOdcNativeEvidence({ operationId, binding, sessionId, vault: f.vault }).write('channel-opened', probeId, data);
  let calls = 0; const options = { vault: f.vault, clock: () => now, openSession: async () => session, fetchImpl: async () => { calls++; } };
  await assert.rejects(reconcileOdcNativeCleanup({ operationId, probeId, descriptor: { ...descriptor, binding: { ...binding, module: 'Other' } } }, options), /scope_invalid/);
  await assert.rejects(reconcileOdcNativeCleanup({ operationId, probeId, descriptor }, { ...options, clock: () => now + 700000 }), /scope_invalid/);
  await assert.rejects(reconcileOdcNativeCleanup({ operationId, probeId, descriptor }, { ...options, openSession: async () => ({ ...session, userKey: 'other' }) }), /scope_invalid/);
  assert.equal(calls, 0);
});

function runDir(probes, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-cleanup-status-')), operationId = randomUUID();
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ schema: 'ssam-odc-native-run/1', operationId, state: 'uncertain',
    cleanup: { completed: false, receipt: { cleanupConfirmed: false, transport: { executeRequestSubmissions: 1, deadlineExpired: true,
      inspectionExpiresAt: '2000-01-01T00:00:00.000Z', probes } } }, ...extra }));
  return { dir, operationId };
}
const sealed = names => Object.fromEntries(names.map(name => [name, { sealed: true, sha256: hash('record ' + name) }]));
const probeWith = (names, response = { executeRequestSubmissions: 1, finished: true, uncertain: false }) =>
  ({ probeId: 'scenario-1-1', ...response, correlation: { evidence: sealed(names), requestOwnershipProved: false } });

test('reserved cleanup record stages are reported in order: response completed, attempt reserved and unconfirmed, retry forbidden', t => {
  assert.deepEqual([...CLEANUP_STAGES], ['prepared', 'negotiated', 'channel-opened', 'cleanup-attempt', 'cleanup-accepted', 'finished']);
  const run = runDir([probeWith(['finished', 'cleanup-attempt', 'channel-opened', 'negotiated', 'prepared'])]);
  const before = fs.readFileSync(path.join(run.dir, 'receipt.json'));
  let network = 0; t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('no network'); });
  for (const name of ['writeFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'mkdirSync']) t.mock.method(fs, name, () => assert.fail('forbidden fs.' + name));
  try {
    const status = cleanupRecordStatus(run.dir);
    assert.equal(status.ok, true); assert.equal(status.operationId, run.operationId);
    assert.equal(status.summary, 'response completed, cleanup attempt reserved and unconfirmed, retry forbidden');
    assert.deepEqual(status.probes[0].stages.map(s => s.stage), ['prepared', 'negotiated', 'channel-opened', 'cleanup-attempt', 'finished']);
    assert.deepEqual(status.probes[0].record, { stage: 'cleanup-attempt', sha256: hash('record cleanup-attempt') });
    assert.equal(status.retryForbidden, true); assert.equal(status.cleanupConfirmed, false);
    // Native lease expiry (deadlineExpired / an old inspectionExpiresAt) is never proof of channel cleanup.
    assert.equal(status.leaseExpiryIsProof, false); assert.equal(status.networkActions, 0); assert.equal(status.deleteResent, false);
    assert.equal(status.receipt.sha256, hash(before)); assert.equal(network, 0);
    assert.equal(cleanupRecordStatus(run.dir).summary, status.summary, 'repeatable without side effects');
  } finally { t.mock.restoreAll(); fs.rmSync(run.dir, { recursive: true, force: true }); }
});

test('cleanup status distinguishes accepted, not attempted, no channel and unconfirmed responses', () => {
  const cases = [
    [[probeWith(['prepared', 'negotiated', 'channel-opened', 'cleanup-attempt', 'cleanup-accepted', 'finished'])], 'response completed, cleanup accepted', true, true],
    [[probeWith(['prepared', 'negotiated', 'channel-opened', 'finished'])], 'response completed, channel opened without a reserved cleanup attempt', false, false],
    [[probeWith(['prepared'], { executeRequestSubmissions: 0, finished: true, uncertain: false })], 'no submission, no channel cleanup record', true, false],
    [[probeWith(['prepared', 'negotiated', 'channel-opened', 'cleanup-attempt'], { executeRequestSubmissions: 1, finished: true, uncertain: true })],
      'response unconfirmed, cleanup attempt reserved and unconfirmed, retry forbidden', false, true],
    // A public attempt flag without a sealed acceptance stays unconfirmed and forbids a retry.
    [[{ ...probeWith(['prepared', 'channel-opened']), cleanup: { attempted: true, accepted: true, status: 204 } }],
      'response completed, cleanup attempt reserved and unconfirmed, retry forbidden', false, true],
    [[], 'no channel cleanup record', true, false],
  ];
  for (const [probes, summary, confirmed, forbidden] of cases) {
    const run = runDir(probes);
    try {
      const status = cleanupRecordStatus(run.dir);
      assert.equal(status.summary, summary); assert.equal(status.cleanupConfirmed, confirmed, summary); assert.equal(status.retryForbidden, forbidden, summary);
    } finally { fs.rmSync(run.dir, { recursive: true, force: true }); }
  }
  const two = runDir([probeWith(['channel-opened', 'cleanup-attempt']), { ...probeWith(['channel-opened', 'cleanup-attempt', 'cleanup-accepted']), probeId: 'scenario-2-1' }]);
  try { assert.equal(cleanupRecordStatus(two.dir).summary, 'scenario-1-1: response completed, cleanup attempt reserved and unconfirmed, retry forbidden; scenario-2-1: response completed, cleanup accepted'); }
  finally { fs.rmSync(two.dir, { recursive: true, force: true }); }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-cleanup-status-'));
  try { const status = cleanupRecordStatus(empty); assert.equal(status.ok, false); assert.equal(status.error, 'debug_odc_native_evidence_receipt_unavailable'); }
  finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('existing Windows CurrentUser DPAPI vault seals the exact private channel evidence without plaintext files', { skip: process.platform !== 'win32' }, async () => {
  const refs = [], operationId = randomUUID();
  const vault = async (mode, ref, value) => { if (mode === 'Seal') refs.push(ref); return privateRequest(mode, ref, value); };
  try {
    const proof = await createOdcNativeEvidence({ operationId, binding, sessionId, vault }).write('channel-opened', probeId, data);
    assert.equal(proof.sealed, true);
    const opened = await privateRequest('Open', refs[0]);
    assert.equal(opened.operationId, operationId); assert.deepEqual(opened.data, data);
    assert.equal(JSON.stringify(opened).includes(session.accessToken), false);
  } finally { for (const ref of refs) await privateRequest('Forget', ref); }
});
