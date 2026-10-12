import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { o11GatewayEvidence, o11GatewayBudgetMs, o11RequestHoldLowMs, verifyO11GatewayEvidence, o11GatewayBudget, o11HoldBudget,
  requestHold, classifyInspectionOp, classifyGatewayResponse, classifyEntryResponse, createO11RequestHold } from '../debug-o11-request-hold.mjs';

const root = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const cloud = 'personal-2qqw9srv.outsystemscloud.com';

test('gateway budget is pinned to the item13 504 evidence and stays below every observed cut', t => {
  assert.equal(o11GatewayEvidence.path, '.local/debugger/item13-o11-site-live/live/audit.json');
  assert.equal(o11GatewayBudgetMs, 50000); assert.equal(o11RequestHoldLowMs, 8000);
  assert.ok(o11GatewayBudgetMs < 60107 && o11GatewayBudgetMs < o11GatewayEvidence.responseDurationMs);
  const file = path.join(root, ...o11GatewayEvidence.path.split('/'));
  if (!fs.existsSync(file)) { t.skip('item13 evidence not present in this checkout'); return; }
  const verified = verifyO11GatewayEvidence(root);
  assert.equal(verified.sha256, o11GatewayEvidence.sha256); assert.equal(verified.httpStatus, 504);
  assert.equal(verified.responseDurationMs, 60279); assert.equal(verified.nativeTimeoutSeconds, 193);
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-p04-hold-')), 'root');
  t.after(() => fs.rmSync(path.dirname(copy), { recursive: true, force: true }));
  const target = path.join(copy, ...o11GatewayEvidence.path.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fs.readFileSync(file, 'utf8').replace('60279', '70279'));
  assert.throws(() => verifyO11GatewayEvidence(copy), /debug_o11_request_hold_gateway_evidence_changed/);
});

test('budget = min(native deadline, host gateway, downward-only override)', () => {
  const submittedAt = 1_000_000;
  assert.deepEqual(o11HoldBudget({ host: cloud, nativeDeadlineAt: submittedAt + 193000, submittedAt }),
    { budgetMs: 50000, source: 'host-gateway', submittedAt, deadlineAt: submittedAt + 50000 });
  assert.equal(o11HoldBudget({ host: cloud, nativeDeadlineAt: submittedAt + 30000, submittedAt }).source, 'native-deadline');
  assert.equal(o11HoldBudget({ host: cloud, nativeDeadlineAt: submittedAt + 30000, submittedAt }).budgetMs, 30000);
  assert.deepEqual(o11HoldBudget({ host: cloud, nativeDeadlineAt: submittedAt + 193000, submittedAt, overrideMs: 40000 }).source, 'override');
  assert.equal(o11HoldBudget({ host: cloud, nativeDeadlineAt: submittedAt + 193000, submittedAt, overrideMs: 40000 }).budgetMs, 40000);
  for (const overrideMs of [50001, 70000, 0, -1, 1.5, '40000'])
    assert.throws(() => o11HoldBudget({ host: cloud, nativeDeadlineAt: submittedAt + 193000, submittedAt, overrideMs }), /override_invalid/);
  // Self-managed hosts have no gateway evidence: only the native deadline bounds the hold.
  assert.deepEqual(o11HoldBudget({ host: 'o11.example.internal', nativeDeadlineAt: submittedAt + 193000, submittedAt }),
    { budgetMs: 193000, source: 'native-deadline', submittedAt, deadlineAt: submittedAt + 193000 });
  assert.equal(o11HoldBudget({ host: 'o11.example.internal', nativeDeadlineAt: submittedAt + 193000, submittedAt, overrideMs: 100000 }).budgetMs, 100000);
  assert.throws(() => o11HoldBudget({ host: 'o11.example.internal', nativeDeadlineAt: submittedAt + 193000, submittedAt, overrideMs: 193001 }), /override_invalid/);
  assert.equal(o11GatewayBudget(cloud), 50000); assert.equal(o11GatewayBudget('OUTSYSTEMSCLOUD.COM'), null);
  assert.equal(o11GatewayBudget('x.outsystemscloud.com.evil.test'), null);
  assert.throws(() => o11GatewayBudget(''), /host_invalid/);
  assert.throws(() => o11HoldBudget({ host: cloud, nativeDeadlineAt: submittedAt, submittedAt }), /expired/);
  assert.throws(() => o11HoldBudget({ host: cloud, nativeDeadlineAt: undefined, submittedAt }), /native_deadline_required/);
});

test('remaining is measured from submission and low budget refuses inspection only', () => {
  const budget = o11HoldBudget({ host: cloud, nativeDeadlineAt: 193000, submittedAt: 0 });
  assert.deepEqual(requestHold(budget, 12345), { elapsedMs: 12345, budgetMs: 50000, remainingMs: 37655, source: 'host-gateway' });
  assert.deepEqual(requestHold(budget, 61000), { elapsedMs: 61000, budgetMs: 50000, remainingMs: 0, source: 'host-gateway' });
  assert.throws(() => requestHold(budget, -1), /clock_invalid/);
  for (const op of ['read', 'read-many', 'refresh', 'expand', 'scope', 'frame', 'private-read', 'read-scope']) {
    assert.deepEqual(classifyInspectionOp(op, 7999), { allowed: false, error: 'debug_server_session_request_hold_budget_low', remainingMs: 7999 });
    assert.deepEqual(classifyInspectionOp(op, 8000), { allowed: true });
  }
  for (const op of ['step-into', 'step-over', 'step-out', 'continue', 'stop', 'status'])
    assert.deepEqual(classifyInspectionOp(op, 0), { allowed: true });
  assert.deepEqual(classifyInspectionOp('read', null), { allowed: true });
  assert.throws(() => classifyInspectionOp('', 1), /op_invalid/);
});

test('a non-JSON 504 is gateway-limit transport evidence, never an answer', () => {
  assert.deepEqual(classifyGatewayResponse(504, '<html><body>504 Gateway Time-out</body></html>'),
    { kind: 'gateway-limit', status: 504, transportEvidence: true, answer: false });
  assert.equal(classifyGatewayResponse(504, Buffer.from('upstream timeout')).kind, 'gateway-limit');
  assert.equal(classifyGatewayResponse(504, '').kind, 'gateway-limit');
  assert.equal(classifyGatewayResponse(504, null).answer, false);
  assert.deepEqual(classifyGatewayResponse(504, '{"exception":{"name":"X"}}'), { kind: 'http-response', status: 504, transportEvidence: false, answer: null });
  assert.equal(classifyGatewayResponse(200, '{"data":{}}').kind, 'http-response');
  assert.equal(classifyGatewayResponse(500, '{"exception":{}}').answer, null);
  assert.throws(() => classifyGatewayResponse('504', ''), /status_invalid/);
  const transport = { status: 504, durationMs: 60279, bytes: 1033, sha256: 'a'.repeat(64), nativeEnvelopeAccepted: false };
  assert.deepEqual(classifyEntryResponse(transport), { kind: 'gateway-limit', status: 504, transportEvidence: true, answer: false, bodyJson: null });
  assert.equal(classifyEntryResponse({ ...transport, bodyJson: false }).bodyJson, false);
  assert.equal(classifyEntryResponse({ ...transport, bodyJson: true }).kind, 'http-response');
  assert.equal(classifyEntryResponse({ ...transport, status: 200, nativeEnvelopeAccepted: true }).kind, 'http-response');
  assert.equal(classifyEntryResponse({ status: 'private' }), null);
});

test('tracker holds one request at a time, keeps the earliest submission and never resends', () => {
  let now = 0;
  const hold = createO11RequestHold({ host: cloud, now: () => now });
  assert.equal(hold.snapshot(), null); assert.deepEqual(hold.classify('read'), { allowed: true });
  now = 1000; hold.submitted({ requestId: 'scenario-0', nativeDeadlineAt: 194000 });
  now = 1500; hold.submitted({ requestId: 'scenario-0', at: 900, nativeDeadlineAt: 194000 }); // worker receipt
  hold.submitted({ requestId: 'scenario-0', at: 1400, nativeDeadlineAt: 194000 });
  now = 43000;
  assert.deepEqual(hold.snapshot(), { elapsedMs: 42100, budgetMs: 50000, remainingMs: 7900, source: 'host-gateway' });
  assert.equal(hold.classify('read-many').allowed, false); assert.equal(hold.classify('continue').allowed, true);
  assert.throws(() => hold.submitted({ requestId: 'scenario-1', nativeDeadlineAt: 194000 }), /previous_request_open/);
  hold.closed('scenario-0'); assert.equal(hold.snapshot(), null);
  assert.throws(() => hold.closed('scenario-0'), /request_not_open/);
  now = 50000; hold.submitted({ requestId: 'scenario-1', nativeDeadlineAt: 194000 });
  assert.equal(hold.snapshot().elapsedMs, 0);
  assert.equal(typeof hold.resend, 'undefined'); assert.equal(typeof hold.continue, 'undefined');
});
