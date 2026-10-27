// T12 part 1 (access and security fidelity): a source-app access change made for a comparison (Traditional migration,
// calls 588-601: 21 screens widened to Roles=[Registered], the restore tracked by hand) is recorded with its exact
// before-state, from the kernel's apply receipt (accessChanges, accessRestore: kernel Verbs.Access.cs), so it can be
// restored. A job says "temporary":{"restore":true}; it may hold only the access writes whose before-state SSAM records.
// The entry is "pending" in ssam_doctor and in every later o11_deliver answer until each of its changes is back or the user
// closes it ("temporary":{"close":"<id>"} with their words). The correction round: a temporary change that merged but whose
// publication failed is recorded; a restore split over several deliveries settles change by change; stacked changes list
// newest first; the environment is the delivery's own and settling matches it; a hosted journal is keyed by user and tenant.
// Fakes only: no Studio, no kernel, no environment.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accessRestoreAfter, pendingAccessRestores, recordAccessRestore, restoresDir, restoreScope, settleAccessRestores, temporaryClose, temporaryRefusal } from '../o11-access.mjs';
import { WORDS_MARKER } from '../o11-cycle.mjs';
import { currentTrace } from '../correlation.mjs';
process.env.SSAM_ODC_OFFLINE = '1';
const m_ssam = await import('../ssam.mjs');

const local = () => fs.mkdtempSync(path.join(os.tmpdir(), 't12-restore-'));
let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 23, 12, 0, tick++));
const task = c => c.repeat(32);
const REGISTERED = '@RoleRegisteredKey00001';
const MANAGER = '@RoleManagerKey000001';
const change = (screen, key, from, to) => ({ screen, key, property: 'Roles', from, to, fromNames: [], toNames: [] });
const op = (key, value, ifCurrent) => ({ op: 'set', target: '@' + key, prop: 'Roles', value, ifCurrent });
// The receipt of the temporary delivery: two screens with no role widened to Registered.
const widen = {
  accessChanges: [change('OpsHome', 'ScreenOpsHome0001', [], [REGISTERED]), change('OpsLoans', 'ScreenOpsLoans001', [], [REGISTERED])],
  accessRestore: { ops: [op('ScreenOpsHome0001', [], [REGISTERED]), op('ScreenOpsLoans001', [], [REGISTERED])] },
};
const back = c => ({ ...c, from: c.to, to: c.from });
const temporaryJob = { temporary: { restore: true }, ops: [
  { op: 'set', target: '@ScreenOpsHome0001', prop: 'Roles', value: [REGISTERED] },
  { op: 'set', target: '@ScreenOpsLoans001', prop: 'Roles', value: [REGISTERED] }] };
const delivered = { ok: true, result: 'delivered' };
const deliver = (dir, { job = { ops: [] }, apply, taskId = null, environment = 'dev.example.test', value = delivered, scope } = {}) =>
  accessRestoreAfter(value, { local: dir, module: 'LoanPortal_TW', job, kernelState: { taskId, environment, apply }, scope, now });

test('a temporary job holds only the access writes SSAM can restore; anything else is refused before it is sent', () => {
  assert.equal(temporaryRefusal({ ops: [{ op: 'html', data: {} }] }), null, 'a job without temporary keeps its own contract');
  assert.equal(temporaryRefusal(temporaryJob), null);
  assert.equal(temporaryRefusal({ ...temporaryJob, ops: [{ op: 'set', target: 'IMobileScreen:Home', prop: 'AnonymousAccess', value: true }] }), null);
  assert.equal(temporaryRefusal({ ...temporaryJob, temporary: { restore: false } }).code, 'TEMPORARY_INVALID');
  const mixed = temporaryRefusal({ ...temporaryJob, ops: [...temporaryJob.ops, { op: 'html', data: { html: '<screen name="X"/>' } }, { op: 'set', target: '@W', prop: 'Label', value: 'x' }] });
  assert.equal(mixed.code, 'TEMPORARY_NOT_REVERSIBLE');
  assert.match(mixed.error, /\/ops\/2 \(html\), \/ops\/3 \(set Label\)/);
  assert.deepEqual(mixed.ops, [2, 3]);
  assert.equal(temporaryRefusal({ temporary: { restore: true }, ops: [] }).code, 'TEMPORARY_NOT_REVERSIBLE');
  // The close form: an id and no ops.
  assert.equal(temporaryRefusal({ temporary: { close: task('a') }, ops: [] }), null);
  assert.equal(temporaryRefusal({ temporary: { close: 'not-an-id' }, ops: [] }).code, 'TEMPORARY_INVALID');
  assert.equal(temporaryRefusal({ temporary: { close: task('a') }, ops: temporaryJob.ops }).code, 'TEMPORARY_INVALID');
});

test('the temporary delivery writes the journal with the exact before-state, keyed by the kernel task, with the delivery environment', () => {
  const dir = local();
  const first = deliver(dir, { job: temporaryJob, apply: widen, taskId: task('d') });
  assert.equal(first.accessRestore.state, 'pending');
  assert.equal(first.accessRestore.id, task('d'));
  // Finding 6: the environment is the delivery's own (kernelState.environment), and the restore call is bound to it.
  assert.equal(first.accessRestore.restore.arguments.expectedEnvironment, 'dev.example.test');
  assert.equal(first.accessRestore.restore.arguments.authorize, WORDS_MARKER);
  assert.deepEqual(first.accessRestore.restore.arguments.job.ops, widen.accessRestore.ops, 'the kernel ops, each with ifCurrent');
  const entry = JSON.parse(fs.readFileSync(path.join(restoresDir(dir), task('d') + '.json'), 'utf8'));
  assert.equal(entry.environment, 'dev.example.test');
  // F7 wired in: the entry carries the correlation id of the session that made the change (outside a call: this process's).
  assert.equal(entry.correlationId, currentTrace().correlationId, 'the session of the temporary change');
  assert.equal(entry.wordsSha256, undefined, 'no field nothing reads');
  assert.deepEqual(entry.changes.map(c => c.from), [[], []]);
  assert.deepEqual(fs.readdirSync(restoresDir(dir)).filter(n => n.endsWith('.tmp')), [], 'no temporary file is left');
  assert.equal(recordAccessRestore(dir, { module: 'M', taskId: task('c'), apply: { notes: [] }, now }).code, 'ACCESS_RESTORE_NOT_CAPTURED');
});

test('finding 3: a temporary change that merged but failed to publish is recorded; a refused delivery records nothing', () => {
  const dir = local();
  const publishFailed = deliver(dir, { job: temporaryJob, apply: widen, taskId: task('e'), value: { ok: false, result: 'delivered', code: 'PUBLISH_FAILED', failed: 'publish' } });
  assert.equal(publishFailed.accessRestore.state, 'pending');
  assert.deepEqual(pendingAccessRestores(dir).map(p => p.id), [task('e')]);
  // Its restore, merged and with a failed publication too, settles it.
  deliver(dir, { apply: { accessChanges: widen.accessChanges.map(back) }, value: { ok: false, result: 'delivered', code: 'PUBLISH_FAILED' } });
  assert.deepEqual(pendingAccessRestores(dir), []);
  const refused = deliver(local(), { job: temporaryJob, apply: widen, taskId: task('f'), value: { ok: false, code: 'VALIDATION_REFUSED' } });
  assert.equal(refused.accessRestore, undefined);
});

test('finding 4: a restore split over several deliveries settles change by change; a delivery in another environment settles nothing', () => {
  const dir = local();
  deliver(dir, { job: temporaryJob, apply: widen, taskId: task('1') });
  deliver(dir, { apply: { accessChanges: [back(widen.accessChanges[0])] }, environment: 'prod.example.test' });
  assert.deepEqual(pendingAccessRestores(dir)[0].screens, ['OpsHome', 'OpsLoans'], 'another environment is another screen');
  deliver(dir, { apply: { accessChanges: [back(widen.accessChanges[0])] } });
  assert.deepEqual(pendingAccessRestores(dir)[0].screens, ['OpsLoans'], 'OpsHome is back');
  const last = deliver(dir, { apply: { accessChanges: [back(widen.accessChanges[1])] } });
  assert.deepEqual(pendingAccessRestores(dir), []);
  assert.equal(last.pendingRestores, undefined);
  // A later change of a restored screen does not reopen it, and a screen changed again to another value stays pending.
  const again = local();
  deliver(again, { job: temporaryJob, apply: widen, taskId: task('2') });
  deliver(again, { apply: { accessChanges: [change('OpsHome', 'ScreenOpsHome0001', [REGISTERED], [MANAGER])] } });
  assert.deepEqual(pendingAccessRestores(again)[0].screens, ['OpsHome', 'OpsLoans']);
});

test('finding 4: the user closes a pending restore with their words; without words it is refused', () => {
  const dir = local();
  deliver(dir, { job: temporaryJob, apply: widen, taskId: task('3') });
  const pending = pendingAccessRestores(dir)[0];
  assert.deepEqual(pending.close.arguments.job, { temporary: { close: task('3') }, ops: [] });
  assert.equal(pending.close.arguments.authorize, WORDS_MARKER);
  assert.equal(temporaryClose(pending.close.arguments.job, { local: dir, words: WORDS_MARKER, now }).code, 'WORDS_REQUIRED');
  const closed = temporaryClose(pending.close.arguments.job, { local: dir, words: 'keep the screens as they are now', now });
  assert.equal(closed.state, 'closed');
  assert.deepEqual(pendingAccessRestores(dir), []);
  assert.equal(temporaryClose({ temporary: { close: task('9') }, ops: [] }, { local: dir, words: 'keep them', now }).code, 'RESTORE_NOT_FOUND');
  assert.equal(temporaryClose({ ops: [] }, { local: dir, words: 'x', now }), null);
});

test('finding 5: stacked temporary changes of one screen list newest first, the order their restores apply in', () => {
  const dir = local();
  deliver(dir, { job: temporaryJob, apply: { accessChanges: [change('A', 'KeyScreenA0001', [], [REGISTERED])], accessRestore: { ops: [op('KeyScreenA0001', [], [REGISTERED])] } }, taskId: task('4') });
  deliver(dir, { job: temporaryJob, apply: { accessChanges: [change('A', 'KeyScreenA0001', [REGISTERED], [REGISTERED, MANAGER])], accessRestore: { ops: [op('KeyScreenA0001', [REGISTERED], [REGISTERED, MANAGER])] } }, taskId: task('5') });
  const order = pendingAccessRestores(dir);
  assert.deepEqual(order.map(p => p.id), [task('5'), task('4')]);
  assert.deepEqual(order[0].restore.arguments.job.ops[0].ifCurrent, [REGISTERED, MANAGER], 'the newest restore applies only while the screen has the newest value');
  // The newest restore delivered: the newest entry is restored, the older one still pending, now first.
  deliver(dir, { apply: { accessChanges: [change('A', 'KeyScreenA0001', [REGISTERED, MANAGER], [REGISTERED])] } });
  assert.deepEqual(pendingAccessRestores(dir).map(p => p.id), [task('4')]);
});

test('finding 6: a hosted journal is keyed by user and tenant; without them a temporary change is refused', () => {
  assert.deepEqual(restoreScope({ SSAM_EXPOSURE: 'licensee', SSAM_EXPOSURE_CALLER: 'user-a' }), { hosted: true, caller: 'user-a' });
  assert.deepEqual(restoreScope({}), { hosted: false, caller: null });
  const noUser = temporaryRefusal(temporaryJob, { scope: restoreScope({ SSAM_EXPOSURE: 'licensee' }), environment: 'dev.example.test' });
  assert.equal(noUser.code, 'TEMPORARY_SCOPE_UNAVAILABLE');
  assert.match(noUser.error, /no user/);
  const noTenant = temporaryRefusal(temporaryJob, { scope: restoreScope({ SSAM_EXPOSURE: 'licensee', SSAM_EXPOSURE_CALLER: 'user-a' }), environment: null });
  assert.equal(noTenant.code, 'TEMPORARY_SCOPE_UNAVAILABLE');
  assert.equal(temporaryRefusal(temporaryJob, { scope: restoreScope({ SSAM_EXPOSURE: 'licensee', SSAM_EXPOSURE_CALLER: 'user-a' }), environment: 'dev.example.test' }), null);
  const dir = local();
  const a = { hosted: true, caller: 'user-a' }; const b = { hosted: true, caller: 'user-b' };
  deliver(dir, { job: temporaryJob, apply: widen, taskId: task('6'), scope: a });
  assert.deepEqual(pendingAccessRestores(dir, a).map(p => p.id), [task('6')]);
  assert.deepEqual(pendingAccessRestores(dir, b), [], 'another user never sees it');
  assert.deepEqual(pendingAccessRestores(dir), [], 'nor the local journal');
  assert.ok(fs.existsSync(restoresDir(dir, a, 'dev.example.test')));
  // Another user's delivery never settles it.
  deliver(dir, { apply: { accessChanges: widen.accessChanges.map(back) }, scope: b });
  assert.equal(pendingAccessRestores(dir, a).length, 1);
});

test('finding 10: a journal that cannot be written says so without a file path', () => {
  const blocked = path.join(local(), 'file');
  fs.writeFileSync(blocked, 'not a folder');
  const answer = deliver(blocked, { job: temporaryJob, apply: widen, taskId: task('7') });
  assert.equal(answer.accessRestore.code, 'ACCESS_RESTORE_JOURNAL_FAILED');
  assert.doesNotMatch(answer.accessRestore.error, /[A-Za-z]:\\|\/tmp|t12-restore/);
  assert.equal(answer.accessRestore.continuation.tool, 'ssam_doctor');
});

test('ssam_doctor lists the pending restores of the O11 lane newest first, with the calls that restore or close them', async () => {
  const pending = [{ id: task('8'), module: 'LoanPortal_TW', createdAt: now().toISOString(), screens: ['OpsHome'],
    restore: { tool: 'o11_deliver', arguments: { module: 'LoanPortal_TW', job: { ops: [] }, authorize: WORDS_MARKER } } }];
  const o11 = await m_ssam.doctorO11({ processes: async () => [], facts: async () => ({ bridge: null }), probe: async () => ({ connected: false }),
    record: () => null, cliBuilt: true, reservations: { list: () => [] }, restores: () => pending });
  assert.deepEqual(o11.pendingRestores, pending);
  assert.equal(o11.warnings[0].code, 'PENDING_RESTORE');
  assert.match(o11.warnings[0].message, /newest first/);
  const report = await m_ssam.doctor('o11', { lanes: { o11: async () => o11 } });
  assert.equal(report.warnings[0].code, 'PENDING_RESTORE');
  const clean = await m_ssam.doctorO11({ processes: async () => [], facts: async () => ({ bridge: null }), probe: async () => ({ connected: false }),
    record: () => null, cliBuilt: true, reservations: { list: () => [] }, restores: () => [] });
  assert.equal(clean.pendingRestores, undefined);
});
