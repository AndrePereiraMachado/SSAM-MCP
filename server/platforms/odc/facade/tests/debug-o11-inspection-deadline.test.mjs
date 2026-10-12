import test from 'node:test';
import assert from 'node:assert/strict';
import { o11InspectionDeadline, o11InvocationBudget, o11NativeInspectionTimeout, o11NativeDeadlineAt, o11RequestHoldBudget } from '../debug-o11-inspection-deadline.mjs';
test('O11 interactive budget uses a fixed authenticated lease across requests and scenarios', () => {
  let now = Date.now();
  const state = { now: () => now, input: { timeoutSeconds: 5 }, descriptor: { expiresAt: new Date(now + 600000).toISOString() },
    report: { authenticated: true, requestSubmittedCount: 0 } };
  assert.equal(o11InvocationBudget(state), 5000);
  const expiresAt = new Date(now + 300000).toISOString();
  assert.deepEqual(o11InspectionDeadline(state, { expiresAt }), { configured: true, expiresAt });
  assert.equal(o11InvocationBudget(state), 300000);
  now += 125000; assert.equal(o11InvocationBudget(state), 175000);
  assert.throws(() => o11InspectionDeadline(state, { expiresAt: state.descriptor.expiresAt }), /deadline_invalid/);
  assert.equal(o11InvocationBudget(state), 175000);
  now += 175000; assert.throws(() => o11InvocationBudget(state), /expired/);
});
test('O11 rejects unauthenticated, running, mixed-client, submitted and over-lease configurations', () => {
  const now = Date.now(), valid = new Date(now + 90000).toISOString();
  const base = () => ({ now: () => now, descriptor: { expiresAt: new Date(now + 100000).toISOString() }, report: { authenticated: true, requestSubmittedCount: 0 } });
  for (const patch of [{ armed: true }, { scenario: {} }, { inspection: {} }, { report: { authenticated: false } },
    { report: { authenticated: true, requestSubmittedCount: 1 } }, { report: { authenticated: true, requestSubmittedCount: 0, scenarios: [{}] } }])
    assert.throws(() => o11InspectionDeadline({ ...base(), ...patch }, { expiresAt: valid }), /deadline_invalid/);
  for (const expiresAt of ['bad', new Date(now).toISOString(), new Date(now + 100001).toISOString()])
    assert.throws(() => o11InspectionDeadline(base(), { expiresAt }), /deadline_invalid/);
});

test('native Data Action timeout uses only the remaining lease and restores the original SDK setting', () => {
  let now = 100000, configured = 10;
  const state = { now: () => now, serverInspectionDeadline: now + 299500,
    descriptor: { expiresAt: new Date(now + 600000).toISOString() }, report: { serverInspection: {} },
    os: { Internal: { ApplicationInfo: {
      getApplicationDefaultTimeout: () => configured, setApplicationDefaultTimeout: value => { configured = value; }
    } } } };
  const restore = o11NativeInspectionTimeout(state);
  assert.equal(configured, 299); assert.equal(state.report.serverInspection.nativeTimeoutConfigured, true);
  restore(); assert.equal(configured, 10);
  now += 280000;
  const restoreNext = o11NativeInspectionTimeout(state); assert.equal(configured, 19); restoreNext();
  assert.equal(configured, 10);
  now += 19500; assert.throws(() => o11NativeInspectionTimeout(state), /expired/); assert.equal(configured, 10);
  assert.throws(() => o11NativeInspectionTimeout({ ...state, os: {} }), /native_timeout_unavailable/);
  assert.doesNotThrow(() => o11NativeInspectionTimeout({})());
});

test('public request hold budget never exceeds the fixed native deadline', () => {
  let now = 100000;
  const cloud = 'personal-2qqw9srv.outsystemscloud.com';
  const state = { now: () => now, input: { timeoutSeconds: 5 }, serverInspectionDeadline: now + 193000,
    descriptor: { expiresAt: new Date(now + 20000).toISOString() } };
  // The credential lease is shorter than the inspection deadline: it wins.
  assert.equal(o11NativeDeadlineAt(state), now + 20000);
  const short = o11RequestHoldBudget(state, { host: cloud });
  assert.deepEqual([short.budgetMs, short.source], [20000, 'native-deadline']);
  assert.ok(short.budgetMs <= o11InvocationBudget(state));
  state.descriptor.expiresAt = new Date(now + 600000).toISOString();
  const gateway = o11RequestHoldBudget(state, { host: cloud });
  assert.deepEqual([gateway.budgetMs, gateway.source], [50000, 'host-gateway']);
  for (const host of [cloud, 'o11.example.internal']) for (const at of [0, 60000, 150000, 192999]) {
    now = 100000 + at;
    const hold = o11RequestHoldBudget(state, { host });
    assert.ok(hold.budgetMs <= o11InvocationBudget(state), host + '@' + at);
    assert.ok(hold.deadlineAt <= o11NativeDeadlineAt(state));
  }
  assert.throws(() => o11RequestHoldBudget(state, { host: cloud, overrideMs: 60000 }), /override_invalid/);
  now = 100000 + 193000; assert.throws(() => o11RequestHoldBudget(state, { host: cloud }), /expired/);
  assert.equal(o11NativeDeadlineAt({}), undefined);
  assert.equal(o11RequestHoldBudget({ now: () => 0 }, { host: cloud }), null);
});
