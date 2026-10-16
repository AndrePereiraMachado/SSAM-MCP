import './fixtures/isolated-profile.mjs';
// CX15 W8: the replay of the incident of 2026-10-14 with fakes and a fake clock. The SHAPE is the one of the inventory of
// 15:35 and of the child receipts: 7 applications matched by the prefix with 1, 1, 10, 1, 21, 2 and 0 modules (36), the
// engine's order (the affected applications of the server's simulations), and an application "Email <prefix>" whose
// module Email<prefix> the prefix does NOT match. Names and keys are synthetic (prefix ZZDC); the real ones are only in the
// CX15 report. The calls go through the MCP handler of o11_service_center_write and ssam_task, as the model made them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../service-center/client.mjs';
import { registerO11Operations } from '../o11-operations.mjs';
import { registerSsamTask } from '../ssam-task.mjs';
import { ANSWER_BUDGETS, answerKind, fitResult } from '../answer-size.mjs';
import { CONFIRM_MIN_AGE_MS, readOperation, storeBackup } from '../destructive-operations.mjs';
import { CATALOG, FakeBridge, files, temp } from './fixtures/sc-fake-bridge.mjs';
import { fakeClock } from './fixtures/destructive-flow.mjs';

const HOST = 'personal-0000test.outsystemscloud.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');
const REQUEST = 'ok deleta todos os apps zzdc';
// app -> module count (the inventory before), and the affected applications of each simulation (the child receipts).
const APPS = [
  ['ZZDC Field Requests', 1, []], ['ZZDC Survivors', 1, []], ['ZZDC Staff', 10, ['ZZDC Field Requests', 'ZZDC Survivors']], ['ZZDC TestData', 1, []],
  ['ZZDC Core', 21, ['ZZDC TestData', 'ZZDC Survivors', 'ZZDC Staff', 'ZZDC Field Requests']], ['ZZDC Foundation', 2, ['ZZDC Core', 'ZZDC Staff']],
  ['ZZDC_Migration_PoCZZDC_Migration_PoC', 0, []]];
const ORDER = ['ZZDC Field Requests', 'ZZDC Survivors', 'ZZDC Staff', 'ZZDC TestData', 'ZZDC Core', 'ZZDC Foundation', 'ZZDC_Migration_PoCZZDC_Migration_PoC'];
const compact = name => name.replace(/[^A-Za-z]/g, '').slice(0, 14);

function environment() {
  const s = { dir: temp(), clock: fakeClock(), events: [], linger: new Set(), controller: new AbortController(), onConfirmed: () => {} };
  s.root = path.join(s.dir, 'destructive');
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  s.apps = APPS.map(([name, n, affected], i) => ({ key: 'zzdc-app-' + i, name, affected,
    modules: Array.from({ length: n }, (_, m) => ({ key: `zzdc-mod-${i}-${m}`, name: `${compact(name)}_M${String(m + 1).padStart(2, '0')}` })) }));
  s.apps.push({ key: 'zzdc-email', name: 'Email ZZDC', affected: [], modules: [{ key: 'zzdc-mod-email', name: 'EmailZZDC' }] });
  const live = () => s.apps.filter(a => !a.gone || s.linger.has(a.key));
  s.bridge = new FakeBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => { const rows = live().map(a => ({ Key: a.key, Name: a.name })); s.onRead(rows); return rows; },
    ListEspaces: () => live().flatMap(a => a.modules.map(m => ({ Key: m.key, Name: m.name, ApplicationKey: a.key }))),
    ListExtensions: [], GetConsumers: [],
    DeleteApplication: args => {
      const app = s.apps.find(a => a.key === args.appKey);
      if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: app.affected, deletedModules: app.modules.map(m => m.name) };
      s.events.push('send ' + app.name);
      app.gone = true;
      s.onSend(app);
      return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: app.modules.map(m => m.name) };
    } } });
  s.onRead = () => {}; s.onSend = () => {};
  // The backup: one download per module (the default downloads the published OML through the CLI and the Studio).
  const backup = async (item, { operationId }) => ({ files: item.modules.map(module => {
    s.events.push('download ' + module);
    const source = path.join(s.dir, module + '.oml'); fs.writeFileSync(source, 'synthetic oml ' + module);
    return { ...storeBackup({ operationId, name: module + '.oml', source, root: s.root }), module };
  }) });
  const tools = {};
  const server = { registerTool: (name, config, handler) => { tools[name] = { config, handler }; } };
  registerO11Operations(server, schema => schema, { serviceCenter: { journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false,
    exports: s.dir, registry: REGISTRY, sleep: async () => {}, clock: s.clock, destructiveRoot: s.root, backup } });
  registerSsamTask(server, { tasksDir: path.join(s.dir, 'tasks'), destructiveRoot: s.root });
  s.call = async (input, ctx = {}) => {
    const reply = await tools.o11_service_center_write.handler({ host: HOST, ...input }, ctx);
    // What the client receives through the ssam server: the same answer after its fitter (answer-size.mjs).
    const fitted = fitResult('o11_service_center_write', { host: HOST, ...input }, reply, { root: s.dir });
    return { value: reply.structuredContent.result, bytes: Buffer.byteLength(reply.content[0].text, 'utf8'), wire: reply.structuredContent,
      fittedBytes: Buffer.byteLength(fitted.content[0].text, 'utf8'), fitted: fitted.content[0].text };
  };
  s.task = async args => (await tools.ssam_task.handler(args, {})).structuredContent;
  s.sends = () => s.bridge.calls.filter(c => c[0] === 'api' && c[4]);
  s.receipts = () => files(path.join(s.dir, 'receipts'), /\.json$/);
  return s;
}
const budgetOf = wire => ANSWER_BUDGETS[answerKind('o11_service_center_write', { action: 'delete' }, wire)];

test('replay: the identical call previews 7 applications and 36 modules by name and deletes nothing; confirmations that are not the owner\'s reply after the list are refused', async t => {
  const s = environment();
  // 1. The identical call (prefix + the request sentence as words).
  const first = await s.call({ action: 'delete', prefix: 'ZZDC', prefixKind: 'application', words: REQUEST });
  const preview = first.value;
  assert.deepEqual([preview.ok, preview.code, preview.state, preview.count], [false, 'CONFIRMATION_REQUIRED', 'previewed', 7]);
  assert.deepEqual(preview.items.map(i => i.name), ORDER, 'the 7 applications, the empty one included, in the engine order');
  const modules = preview.items.flatMap(i => i.cascade);
  assert.equal(modules.length, 36);
  assert.deepEqual(preview.items.map(i => i.cascade.length), [1, 1, 10, 1, 21, 2, 0]);
  assert.ok(!modules.includes('EmailZZDC') && !preview.items.some(i => i.name === 'Email ZZDC'), 'Email<prefix> is not matched by the prefix');
  assert.deepEqual([s.sends(), s.receipts(), s.events], [[], [], []], '0 sends simulate:false, 0 receipts, 0 downloads');
  t.diagnostic(`preview bytes=${first.bytes} budget(${answerKind('o11_service_center_write', {}, first.wire)})=${budgetOf(first.wire)}`);
  assert.ok(first.bytes <= budgetOf(first.wire), `the preview fits its budget (${first.bytes} bytes)`);
  const token = preview.confirmationToken;
  // 2. Too soon (no owner answers within 5 s), even with good words.
  s.clock.advance(1000);
  const soon = (await s.call({ action: 'delete', confirmationToken: token, words: 'sim, apaga os 7 ZZDC' })).value;
  assert.deepEqual(soon.problems.map(p => p.code), ['CONFIRMATION_TOO_SOON']);
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  // 3. The token with the request sentence: one refusal, WORDS_BEFORE_PREVIEW (it names the prefix but came before the list).
  const sentence = await s.call({ action: 'delete', confirmationToken: token, words: REQUEST });
  assert.deepEqual([sentence.value.code, sentence.value.problems.map(p => p.code).sort()], ['DELETE_REFUSED', ['CONFIRMATION_COUNT_MISMATCH', 'WORDS_BEFORE_PREVIEW']]);
  t.diagnostic(`refusal (request sentence) bytes=${sentence.bytes}`);
  // 4. "vai la deleta": names neither the prefix nor the applications, no count.
  const vague = await s.call({ action: 'delete', confirmationToken: token, words: 'vai la deleta' });
  const codes = vague.value.problems.map(p => p.code);
  assert.deepEqual([codes.filter(c => c === 'WORDS_MUST_NAME').length, codes.filter(c => c !== 'WORDS_MUST_NAME')], [7, ['CONFIRMATION_COUNT_MISMATCH']]);
  t.diagnostic(`refusal (vai la deleta) bytes=${vague.bytes} budget=${budgetOf(vague.wire)}`);
  assert.ok(vague.bytes <= budgetOf(vague.wire));
  assert.deepEqual([s.sends(), s.receipts()], [[], []], 'no refused confirmation sent or reserved anything');
});

test('replay: the owner\'s reply after the list deletes in the engine order; the cancellation when the 4th confirms stops the rest; ssam_task names every item', async t => {
  const s = environment();
  const token = (await s.call({ action: 'delete', prefix: 'ZZDC', prefixKind: 'application', words: REQUEST })).value.confirmationToken;
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  let sentAtAbort = null;
  // The client cancels when the 4th item (TestData) is read gone.
  s.onRead = rows => { if (!sentAtAbort && s.sends().length === 4 && !rows.some(r => r.Name === 'ZZDC TestData')) { s.controller.abort(); sentAtAbort = s.sends().length; } };
  const done = await s.call({ action: 'delete', confirmationToken: token, words: 'sim, apaga os 7 ZZDC' }, { mcpReq: { signal: s.controller.signal } });
  const result = done.value;
  assert.deepEqual([result.state, result.code], ['cancelled', 'CANCELLED']);
  assert.deepEqual(result.deleted.map(d => d.name), ORDER.slice(0, 4));
  assert.deepEqual(result.notStarted, ORDER.slice(4));
  assert.equal(s.sends().length, sentAtAbort, '0 sends after the abort');
  // The backup: one download per module of each deleted application, before its send.
  const sends = s.events.filter(e => e.startsWith('send')).map(e => e.slice(5));
  assert.deepEqual(sends, ORDER.slice(0, 4));
  for (const name of sends) {
    const app = s.apps.find(a => a.name === name);
    const downloads = app.modules.map(m => s.events.indexOf('download ' + m.name));
    assert.ok(downloads.every(i => i >= 0 && i < s.events.indexOf('send ' + name)), name + ': its modules downloaded before its send');
  }
  assert.equal(s.events.filter(e => e.startsWith('download')).length, 13);
  assert.deepEqual([result.backup.files, result.backup.items.map(i => i.files)], [13, [1, 1, 10, 1]]);
  const saved = readOperation(result.operationId, { root: s.root }).items.flatMap(i => i.backup?.files ?? []);
  assert.ok(saved.length === 13 && saved.every(f => f.sha256.length === 64 && fs.existsSync(f.path)), 'paths and sha256 in the record');
  t.diagnostic(`execution answer bytes=${done.bytes} fitted=${done.fittedBytes}`);
  for (const name of ORDER) assert.ok(done.fitted.includes(name), 'the fitted answer names ' + name);
  // ssam_task {} right after: the operation, 4 deleted and the 3 not started by name.
  const list = await s.task({});
  const op = list.destructive[0];
  assert.deepEqual([op.state, op.counts, op.deleted, op.notStarted], ['cancelled', { deleted: 4, notStarted: 3 }, ORDER.slice(0, 4), ORDER.slice(4)]);
  const byId = (await s.task({ id: op.operationId })).destructiveOperation;
  assert.deepEqual(byId.items.map(i => [i.name, i.state]), ORDER.map((n, i) => [n, i < 4 ? 'deleted' : 'not-started']));
  t.diagnostic(`ssam_task {} bytes=${Buffer.byteLength(JSON.stringify(list))}`);
});

test('replay variant (the real timeline): the cancellation 0.19 s after the send of the Core: the Core uncertain, the other 2 not started', async t => {
  const s = environment();
  const plain = await s.call({ action: 'delete', prefix: 'ZZDC', prefixKind: 'application' });
  const token = plain.value.confirmationToken;
  // A preview without words is ok:true (budget 'other'): what does not fit goes to the paged answer file, never cut.
  t.diagnostic(`preview without words bytes=${plain.bytes} budget=${budgetOf(plain.wire)} fitted=${plain.fittedBytes}`);
  for (const name of ORDER) assert.ok(plain.fitted.includes(name), 'the fitted preview names ' + name);
  assert.ok(plain.fitted.includes(token), 'the fitted preview keeps the token');
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  // The Core stays listed (the platform took more than 60 s) and the client cancels while its send is in flight.
  s.onSend = app => { if (app.name === 'ZZDC Core') { s.linger.add(app.key); s.controller.abort(); } };
  const run = await s.call({ action: 'delete', confirmationToken: token, words: 'pode apagar os 7 ZZDC' }, { mcpReq: { signal: s.controller.signal } });
  const result = run.value;
  t.diagnostic(`variant execution bytes=${run.bytes} fitted=${run.fittedBytes}`);
  assert.deepEqual([result.state, result.uncertain, result.notStarted], ['cancelled', ['ZZDC Core'], ['ZZDC Foundation', 'ZZDC_Migration_PoCZZDC_Migration_PoC']]);
  assert.deepEqual(result.deleted.map(d => d.name), ORDER.slice(0, 4));
  assert.deepEqual(s.events.filter(e => e.startsWith('send')).map(e => e.slice(5)), ORDER.slice(0, 5), 'the send in flight ended; nothing after it');
  assert.equal(s.events.filter(e => e.startsWith('download')).length, 34, '13 + the 21 modules of the Core, before its send');
  const op = (await s.task({})).destructive[0];
  assert.deepEqual([op.counts, op.uncertain], [{ deleted: 4, uncertain: 1, notStarted: 2 }, ['ZZDC Core']]);
  const record = readOperation(op.operationId, { root: s.root });
  assert.deepEqual([record.items[4].state, record.items[4].cancelled], ['uncertain', true]);
  // The token of the cancelled operation never sends again: continuing is a new preview of what is left.
  const again = (await s.call({ action: 'delete', confirmationToken: token, words: 'pode apagar os 7 ZZDC' })).value;
  assert.deepEqual(again.problems.map(p => p.code), ['OPERATION_CANCELLED']);
  const rest = (await s.call({ action: 'delete', prefix: 'ZZDC', prefixKind: 'application' })).value;
  assert.deepEqual(rest.items.map(i => i.name), ['ZZDC Core', 'ZZDC Foundation', 'ZZDC_Migration_PoCZZDC_Migration_PoC'], 'the new preview lists what is left (the Core uncertain, read again)');
  assert.equal(s.sends().length, 5);
});
