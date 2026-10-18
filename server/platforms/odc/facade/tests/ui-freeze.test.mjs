// UI freeze of 2026-10-08 (DCIPS, lane o11, personal-2qqw9srv; 4-5 Studio restarts). The facade side of the fix:
// - pattern 1: close-module of a tab still finishing a publication answers MODULE_BUSY (bridge close_module:idle_gate), and
//   the delivery that closes its tab after publishing keeps the tab and says why, instead of a 120 s timeout;
// - pattern 4: a bridge call that outlives its client timeout stays in flight and blocks the next write of that Studio
//   until the late answer; the queue of one Studio is shared by every root attached to it; wait idle|no-dialogs take
//   their turn in the queue and never count themselves; status never refreshes references beside another write;
//   concurrent fake deliveries of one Studio never overlap.
// Fake bridges on loopback ports and temporary folders only: no Studio, no process is touched.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { o11Studio } from '../o11-studio.mjs';
import { closeOpenedTab } from '../o11-cycle.mjs';
import { o11Bridge, bridgeRequest, flightOf } from '../o11-bridge.mjs';
import { withStudioWriteLock, studioWriteHolder, studioWriteTarget, isWrite, queueLimitOf, QUEUE_TIMEOUT_CODE } from '../studio-write-lock.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';

const ok = data => ({ success: true, data, error: null });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-freeze-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sub = name => { const p = path.join(dir, name); fs.mkdirSync(p, { recursive: true }); return p; };
  return { dir, sub };
}
// A connection record of one Studio (pid 4242, port 45999) whose authority folder is shared by every root attached to it.
const recordOf = authorityDir => ({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242, port: 45999, startedUtc: '2026-10-08T13:41:31Z', studioDir: 'C:\\Studio', authorityDir });
const depsOf = (root, record, extra = {}) => ({ o11Root: root, o11Lane: 'ss4', connection: () => record, ...extra });

test('pattern 1: close-module of a tab still finishing a publication answers MODULE_BUSY with wait idle next, nothing closed', async t => {
  const fake = await fakeBridge(request => request.method === 'close_module'
    ? { success: false, code: 'MODULE_BUSY', executed: false, error: "close_module: 'DCIPS_Documents_CS' was not closed: the tab is still finishing work (the end of a publication, a refresh or a validation); nothing was closed",
      data: { code: 'MODULE_BUSY', name: 'DCIPS_Documents_CS', busy: 'not-idle', waitedMs: 30000 } }
    : ok({}));
  t.after(() => fake.close());
  const { sub } = sandbox(t);
  const run = o11Studio({ bridge: () => o11Bridge({ port: fake.port, authorization: 'K' }), assertSelected: async () => {}, lane: 'ss4', root: sub('root'), writeHolder: () => null });
  const value = await run({ command: 'close-module', args: { name: 'DCIPS_Documents_CS' } });
  assert.equal(value.ok, false);
  assert.equal(value.code, 'MODULE_BUSY');
  assert.equal(value.busy, 'not-idle');
  assert.equal(value.outcome, 'not-sent');
  assert.deepEqual(value.continuation.arguments, { command: 'wait', args: { condition: 'idle', timeoutSeconds: 120 } });
});

test('pattern 1: the delivery that published keeps a busy tab and says why, in seconds (was a 120 s close_module timeout)', async t => {
  const fake = await fakeBridge(() => ({ success: false, code: 'MODULE_BUSY', executed: false, error: "close_module: 'M' was not closed: a publish or upload of this module is still running in the Studio; nothing was closed" }));
  t.after(() => fake.close());
  const started = Date.now();
  const closed = await closeOpenedTab('M', { open: { alreadyOpen: false }, moduleKey: 'k' }, { bridge: () => o11Bridge({ port: fake.port, authorization: 'K' }) });
  assert.equal(closed.closed, false);
  assert.equal(closed.code, 'MODULE_BUSY');
  assert.equal(closed.next.arguments.command, 'close-module');
  assert.ok(Date.now() - started < 5000);
});

test('UI_BUSY from the bridge (ui:bounded) is a coded answer: not-sent when withdrawn, the next call reads the state', async t => {
  const fake = await fakeBridge(() => ({ success: false, code: 'UI_BUSY', executed: false, error: 'list_open_modules: the Studio UI thread did not run this step in 30 s (withdrawn from the UI queue; nothing of it ran)',
    data: { code: 'UI_BUSY', what: 'close_module: read the tab', outcome: 'not-executed', withdrawn: true } }));
  t.after(() => fake.close());
  const { sub } = sandbox(t);
  const run = o11Studio({ bridge: () => o11Bridge({ port: fake.port, authorization: 'K' }), assertSelected: async () => {}, lane: 'ss4', root: sub('root'), writeHolder: () => null });
  const value = await run({ command: 'close-module', args: { name: 'M' } });
  assert.equal(value.code, 'UI_BUSY'); assert.equal(value.outcome, 'not-sent'); assert.equal(value.executed, false);
  assert.equal(value.continuation.arguments.command, 'status');
});

test('pattern 4: a bridge call that timed out stays in flight and blocks the next write of that Studio until its late answer', async t => {
  const { sub } = sandbox(t);
  const root = sub('root'); const record = recordOf(sub('authority'));
  let answer;
  const fake = await fakeBridge(request => (request.method === 'open_module' ? new Promise(resolve => { answer = resolve; }) : ok({})));
  t.after(() => fake.close());
  // The client gives up at 100 ms (BRIDGE_TIMEOUT, outcome unknown); the Studio is still opening.
  const target = { port: fake.port, authorization: 'K', flight: flightOf({ lane: 'ss4', root, record }) };
  await assert.rejects(bridgeRequest(target, 'open_module', { name: 'DCIPS_SurvivorPortal' }, { timeoutMs: 100 }), e => e.code === 'BRIDGE_TIMEOUT');
  assert.equal(studioWriteHolder({ deps: depsOf(root, record) })?.tool, 'bridge:open_module');
  // Another agent's refresh-refs + publish of the same module: it must not enter the Studio while the open runs there.
  const short = await withStudioWriteLock({ tool: 'o11_environment', args: { action: 'refresh-refs', module: 'DCIPS_SurvivorPortal' }, deps: depsOf(root, record, { queueMs: 150 }) },
    async () => assert.fail('ran beside the open still running in the Studio'));
  assert.equal(short.code, QUEUE_TIMEOUT_CODE);
  assert.equal(short.holder.tool, 'bridge:open_module');
  // Once the late answer arrives, the next write runs.
  let ranAt = 0; const answeredAt = Date.now() + 200;
  setTimeout(() => answer({ success: true, data: { opened: true } }), 200);
  const value = await withStudioWriteLock({ tool: 'o11_environment', args: { action: 'refresh-refs', module: 'DCIPS_SurvivorPortal' }, deps: depsOf(root, record, { queueMs: 5000 }) },
    async () => { ranAt = Date.now(); return { ok: true }; });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.ok(ranAt >= answeredAt - 20, 'ran only after the bridge answered');
  assert.equal(studioWriteHolder({ deps: depsOf(root, record) }), null);
});

test('pattern 4: a Studio that closes the connection ends the flight (no stuck lock)', async t => {
  const { sub } = sandbox(t);
  const root = sub('root'); const record = recordOf(sub('authority'));
  const fake = await fakeBridge(() => undefined); // never answers
  const target = { port: fake.port, authorization: 'K', flight: flightOf({ lane: 'ss4', root, record }) };
  await assert.rejects(bridgeRequest(target, 'list_open_modules', {}, { timeoutMs: 80 }), e => e.code === 'BRIDGE_TIMEOUT');
  assert.equal(studioWriteHolder({ deps: depsOf(root, record) })?.tool, 'bridge:list_open_modules');
  await fake.close();
  for (let i = 0; i < 50 && studioWriteHolder({ deps: depsOf(root, record) }); i++) await sleep(20);
  assert.equal(studioWriteHolder({ deps: depsOf(root, record) }), null);
});

test('pattern 4: the queue of one Studio is shared by every SSAM root attached to it (authorityDir), not per root', async t => {
  const { sub } = sandbox(t);
  const record = recordOf(sub('authority'));
  const rootA = sub('operational'); const rootB = sub('novo');
  assert.equal(studioWriteTarget({ tool: 'o11_publish', deps: depsOf(rootA, record) }).dir, studioWriteTarget({ tool: 'o11_publish', deps: depsOf(rootB, record) }).dir);
  let release;
  const holding = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Haiku_Core' }, deps: depsOf(rootA, record) }, () => new Promise(resolve => { release = resolve; }));
  await sleep(20);
  const other = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Haiku_Core' }, deps: depsOf(rootB, record, { queueMs: 100 }) }, async () => assert.fail('two roots wrote the same Studio at once'));
  assert.equal(other.code, QUEUE_TIMEOUT_CODE);
  release({ ok: true });
  assert.equal((await holding).ok, true);
});

test('pattern 4: wait idle|no-dialogs are writes that wait their turn for up to their own timeout and never count themselves', async t => {
  const { sub } = sandbox(t);
  const root = sub('root'); const record = recordOf(sub('authority'));
  assert.equal(isWrite('o11_studio', { command: 'wait', args: { condition: 'idle' } }), true);
  assert.equal(isWrite('o11_studio', { command: 'wait', args: { condition: 'no-dialogs' } }), true);
  assert.equal(isWrite('o11_studio', { command: 'wait', args: { condition: 'signed-in', host: 'h' } }), false);
  assert.equal(queueLimitOf('o11_studio', { command: 'wait', args: { condition: 'idle', timeoutSeconds: 900 } }), 900000);
  assert.equal(queueLimitOf('o11_studio', { command: 'status' }), null);
  // A delivery holds the Studio; the wait queues behind it and, holding the Studio itself, sees no other write.
  let release; const order = [];
  const delivery = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A' }, deps: depsOf(root, record) },
    () => new Promise(resolve => { release = () => { order.push('delivery end'); resolve({ ok: true }); }; }));
  await sleep(20);
  const waiting = withStudioWriteLock({ tool: 'o11_studio', args: { command: 'wait', args: { condition: 'idle', timeoutSeconds: 30 } }, deps: depsOf(root, record) },
    async () => { order.push('wait runs'); return { ok: true, holder: studioWriteHolder({ deps: depsOf(root, record) }) }; });
  await sleep(100);
  assert.deepEqual(order, []);
  release();
  const waited = await waiting;
  await delivery;
  assert.deepEqual(order, ['delivery end', 'wait runs']);
  assert.equal(waited.holder, null, 'the wait never counts its own lock as a running write');
});

test('pattern 4: status lists the dependencies dialog for later while another write holds the Studio (no refresh beside a merge)', async t => {
  const DIALOG = { kind: 'WebDialog', type: 'DialogWindow', title: '', source: 'window', contentKind: 'web', texts: [], hint: 'a web dialog is open in the Studio' };
  const methods = [];
  const fake = await fakeBridge(request => {
    methods.push(request.method);
    switch (request.method) {
      case 'ping': return ok({ pid: 1, bridge: 'anvil', version: '9' });
      case 'bridge_manifest': return ok({ bridge: 'anvil', protocolVersion: 2, capabilities: ['dialogs:dependencies_auto'] });
      case 'get_active_module': return ok({ name: 'Consumer', key: 'kc', environment: 'h', pendingDialogs: [DIALOG] });
      case 'list_open_modules': return ok({ count: 1, modules: [{ name: 'Consumer', key: 'kc', hasESpace: true, hasOpenedActiveESpace: true }], environments: ['h'], dialogs: [DIALOG] });
      case 'ui_alive': return ok({ alive: true });
      default: return ok({});
    }
  });
  t.after(() => fake.close());
  const { sub } = sandbox(t);
  const run = o11Studio({ bridge: () => o11Bridge({ port: fake.port, authorization: 'K' }), assertSelected: async () => {}, lane: 'ss4', root: sub('root'),
    writeHolder: () => null, exclusive: async () => ({ ok: false, code: QUEUE_TIMEOUT_CODE, holder: { tool: 'o11_deliver', pid: 1, startedAt: null } }) });
  const value = await run({ command: 'status' });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.dependenciesDialog.pending, true);
  assert.equal(value.dependenciesDialog.holder.tool, 'o11_deliver');
  assert.ok(!methods.includes('answer_dependencies_dialog') && !methods.includes('refresh_references'), methods.join(','));
});

test('pattern 4: concurrent fake deliveries, publishes, opens, closes, refreshes and waits of one Studio never overlap', async t => {
  const { sub } = sandbox(t);
  const record = recordOf(sub('authority'));
  const roots = [sub('r1'), sub('r2'), sub('r3')]; // three agents of different roots on one Studio
  const calls = [
    ['o11_deliver', { module: 'DCIPS_SurvivorPortal' }], ['o11_environment', { action: 'refresh-refs', module: 'DCIPS_SurvivorPortal', publish: true }],
    ['o11_studio', { command: 'open-module', args: { name: 'DCIPS_SurvivorPortal' } }], ['o11_publish', { module: 'DCIPS_Documents_CS' }],
    ['o11_studio', { command: 'close-module', args: { name: 'DCIPS_Documents_CS' } }], ['o11_studio', { command: 'wait', args: { condition: 'idle', timeoutSeconds: 60 } }],
    ['o11_deliver', { module: 'Haiku_Core' }], ['o11_studio', { command: 'wait', args: { condition: 'no-dialogs', timeoutSeconds: 60 } }],
    ['o11_studio', { command: 'refresh-references', args: { module: 'Haiku_Core' } }], ['o11_deliver', { module: 'DCIPS_Documents_CS' }],
  ];
  const intervals = []; let running = 0; let maxRunning = 0;
  await Promise.all(calls.map(([tool, args], i) => withStudioWriteLock({ tool, args, deps: depsOf(roots[i % roots.length], record, { queueMs: 20000 }) }, async () => {
    running++; maxRunning = Math.max(maxRunning, running);
    const start = performance.now(); await sleep(5 + ((i * 7) % 20)); const end = performance.now();
    running--; intervals.push({ tool, start, end }); return { ok: true };
  })));
  assert.equal(intervals.length, calls.length);
  assert.equal(maxRunning, 1, 'never two Studio writes at once');
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end, sorted[i - 1].tool + ' overlapped ' + sorted[i].tool);
});
