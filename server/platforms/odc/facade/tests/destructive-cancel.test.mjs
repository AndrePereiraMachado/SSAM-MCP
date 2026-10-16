import './fixtures/isolated-profile.mjs';
// CX15 W3: the client's cancellation reaches the delete engine (ctx.mcpReq.signal through the three tools); the execution
// stops before its next item (the send in flight is never cut, the wait for the real state stops at once), every item has
// its durable record, the parent receipt shows the children after each one, and a cancelled token never sends again.
// Offline: the fake bridge, fake sleep and clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../service-center/client.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { CONFIRM_MIN_AGE_MS, readOperation } from '../destructive-operations.mjs';
import { registerO11Operations } from '../o11-operations.mjs';
import { registerO11Environment } from '../o11-environment.mjs';
import { registerO11Extension } from '../o11-extension.mjs';
import { CATALOG, FakeBridge, temp } from './fixtures/sc-fake-bridge.mjs';
import { fakeClock, noBackup } from './fixtures/destructive-flow.mjs';

const PERSONAL = 'personal-0000test.outsystemscloud.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');
const WORDS = 'sim, apaga os 4 ZZC';

// Four applications ZZC A..D; hooks: onSend(key) inside the DeleteApplication send, linger: keys that stay listed.
function environment() {
  const s = { apps: ['A', 'B', 'C', 'D'].map(x => ({ key: 'k-' + x.toLowerCase(), name: 'ZZC ' + x })), dir: temp(), clock: fakeClock(), sleeps: [], linger: new Set(),
    controller: new AbortController(), onSend: () => {}, onSleep: () => {} };
  s.root = path.join(s.dir, 'destructive');
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  s.bridge = new FakeBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => s.apps.filter(a => !a.gone || s.linger.has(a.key)).map(a => ({ Key: a.key, Name: a.name })),
    ListEspaces: [], ListExtensions: [], GetConsumers: [],
    DeleteApplication: args => {
      if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: [] };
      for (const a of s.apps) if (a.key === args.appKey) a.gone = true;
      s.onSend(args.appKey);
      return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: [] };
    } } });
  s.deps = (extra = {}) => ({ journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false, exports: s.dir, registry: REGISTRY,
    sleep: async ms => { s.sleeps.push(ms); s.onSleep(ms); }, clock: s.clock, destructiveRoot: s.root, backup: noBackup, ...extra });
  s.run = (argv, extra) => runServiceCenter([...argv, '--host=' + PERSONAL], s.deps(extra));
  s.sends = () => s.bridge.calls.filter(c => c[0] === 'api' && c[4]).map(c => c[3].appKey);
  s.preview = async () => { const p = await s.run(['delete', '--prefix=ZZC']); s.clock.advance(CONFIRM_MIN_AGE_MS); return p; };
  s.execute = (token, extra = { signal: s.controller.signal }) => s.run(['delete', '--confirmation-token=' + token, '--words=' + WORDS], extra);
  return s;
}

test('aborted after the 2nd of 4 items: the 3rd and 4th are not-started, nothing is sent after the abort, the operation is cancelled', async () => {
  const s = environment();
  const preview = await s.preview();
  let sentAtAbort = null;
  // The client cancels once the 2nd target is gone (its delete confirmed by the read).
  const list = s.bridge.replies.ListApplications;
  s.bridge.replies.ListApplications = () => { const rows = list(); if (!sentAtAbort && s.sends().length === 2 && !rows.some(r => r.Key === 'k-b')) { s.controller.abort(); sentAtAbort = s.sends().length; } return rows; };
  const result = await s.execute(preview.confirmationToken);
  assert.deepEqual([result.ok, result.state, result.code], [false, 'cancelled', 'CANCELLED']);
  assert.deepEqual(s.sends(), ['k-a', 'k-b']);
  assert.equal(s.sends().length, sentAtAbort, 'no send after the abort');
  assert.deepEqual([result.deleted.map(d => d.name), result.notStarted], [['ZZC A', 'ZZC B'], ['ZZC C', 'ZZC D']]);
  const record = readOperation(preview.operationId, { root: s.root });
  assert.deepEqual([record.state, Boolean(record.cancelledAt), record.items.map(i => [i.name, i.state])],
    ['cancelled', true, [['ZZC A', 'deleted'], ['ZZC B', 'deleted'], ['ZZC C', 'not-started'], ['ZZC D', 'not-started']]]);
  assert.deepEqual([result.operation.counts, result.operation.notStarted], [{ deleted: 2, notStarted: 2 }, ['ZZC C', 'ZZC D']]);
  assert.equal(s.journal.lookup(preview.operationId).state, 'cancelled');
});

test('aborted during the wait of the 2nd: the wait stops at once (no pause after the abort); the item is accepted-unverified with cancelled:true', async () => {
  const s = environment();
  const preview = await s.preview();
  s.linger.add('k-b');
  s.onSleep = () => { if (s.sends().length === 2 && !s.controller.signal.aborted) s.controller.abort(); };
  const result = await s.execute(preview.confirmationToken);
  assert.deepEqual(s.sends(), ['k-a', 'k-b']);
  assert.equal(s.sleeps.length, 1, 'the pause during which the abort came, then none');
  // Stopped by the cancellation: the operation is cancelled, its 2nd item uncertain (DELETE_UNCONFIRMED), the rest not started.
  assert.deepEqual([result.state, result.code, result.uncertain, result.notStarted], ['cancelled', 'DELETE_UNCONFIRMED', ['ZZC B'], ['ZZC C', 'ZZC D']]);
  const child = s.journal.lookup(s.journal.lookup(preview.operationId).children[1].operationId);
  assert.deepEqual([child.state, child.cancelled], ['accepted-unverified', true]);
  const record = readOperation(preview.operationId, { root: s.root });
  assert.deepEqual([record.state, record.items[1].state, record.items[1].cancelled], ['cancelled', 'uncertain', true]);
  assert.match(result.next, /ssam_task/);
});

test('aborted during the send of the 2nd: the send ends, nothing more is sent; the parent receipt shows the children after each item', async () => {
  const s = environment();
  const preview = await s.preview();
  const parentFile = path.join(s.dir, 'receipts', preview.operationId + '.json');
  const seen = [];
  s.linger.add('k-b');
  s.onSend = key => { seen.push(JSON.parse(fs.readFileSync(parentFile, 'utf8')).children?.length ?? 0); if (key === 'k-b') s.controller.abort(); };
  const result = await s.execute(preview.confirmationToken);
  assert.deepEqual(s.sends(), ['k-a', 'k-b'], 'the 2nd send was in flight and ended; no 3rd');
  assert.deepEqual(seen, [0, 1], 'the parent receipt had the 1st child when the 2nd was sent');
  assert.deepEqual([result.state, result.uncertain, result.notStarted], ['cancelled', ['ZZC B'], ['ZZC C', 'ZZC D']]);
  assert.deepEqual(s.sleeps, [], 'no wait after the abort');
});

test('the token of a cancelled operation never sends again: only its state', async () => {
  const s = environment();
  const preview = await s.preview();
  s.onSend = key => { if (key === 'k-a') s.controller.abort(); };
  await s.execute(preview.confirmationToken);
  assert.deepEqual(s.sends(), ['k-a']);
  const again = await s.execute(preview.confirmationToken, {});
  assert.deepEqual([again.ok, again.code, again.problems.map(p => p.code), again.operation.state], [false, 'DELETE_REFUSED', ['OPERATION_CANCELLED'], 'cancelled']);
  assert.deepEqual(s.sends(), ['k-a'], 'nothing sent again');
});

test('the signal reaches the engine through o11_service_center_write, o11_environment and o11_extension (ctx.mcpReq.signal)', async () => {
  const handlers = {};
  const server = { registerTool: (name, config, handler) => { handlers[name] = { config, handler }; } };
  const ctx = () => { const controller = new AbortController(); controller.abort(); return { mcpReq: { signal: controller.signal } }; };
  // o11_service_center_write
  const a = environment();
  registerO11Operations(server, schema => schema, { serviceCenter: a.deps() });
  const pa = await a.preview();
  const ra = (await handlers.o11_service_center_write.handler({ action: 'delete', host: PERSONAL, confirmationToken: pa.confirmationToken, words: WORDS }, ctx())).structuredContent.result;
  assert.deepEqual([ra.state, a.sends()], ['cancelled', []]);
  // o11_environment delete-app
  const b = environment();
  registerO11Environment(server, { serviceCenterDeps: b.deps(), studioHosts: async () => [PERSONAL], destructiveRoot: b.root });
  const pb = (await handlers.o11_environment.handler({ action: 'delete-app', app: 'ZZC A', host: PERSONAL })).structuredContent;
  b.clock.advance(CONFIRM_MIN_AGE_MS);
  const rb = (await handlers.o11_environment.handler({ action: 'delete-app', host: PERSONAL, confirmationToken: pb.confirmationToken, authorize: 'sim, apaga o 1, ZZC A' }, ctx())).structuredContent;
  assert.deepEqual([rb.state, b.sends()], ['cancelled', []]);
  // o11_extension delete (an extension through the same engine)
  const c = environment();
  c.bridge.replies.ListExtensions = () => [{ Key: 'x-1', Name: 'ZZCExt' }];
  c.bridge.replies.DeleteModule = () => assert.fail('never sent');
  registerO11Extension(server, { serviceCenter: (argv, extra) => runServiceCenter(argv, c.deps(extra)), destructiveRoot: c.root });
  const pc = (await handlers.o11_extension.handler({ action: 'delete', host: PERSONAL, extension: 'ZZCExt' })).structuredContent;
  c.clock.advance(CONFIRM_MIN_AGE_MS);
  const rc = (await handlers.o11_extension.handler({ action: 'delete', host: PERSONAL, confirmationToken: pc.confirmationToken, words: 'sim, apaga a 1, ZZCExt' }, ctx())).structuredContent;
  assert.equal(rc.state, 'cancelled');
});
