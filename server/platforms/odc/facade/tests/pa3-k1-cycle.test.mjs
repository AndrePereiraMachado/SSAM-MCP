// Atritos 3, lane K1 (docs/PACOTE-ATRITOS-3.md), in o11_deliver: producers "published" (K1-d), the tab the delivery opened
// closed after the publication (K1-g) and the publish code passed through (I8). A real McpServer over InMemoryTransport with
// a fake Anvil CLI, a fake bridge and a fake publication runner; temporary folders only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Cycle, producerArgs, deliverArguments, themeReferenced, closeOpenedTab, PUBLISHED } from '../o11-cycle.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import envelopes from './fixtures/o11-cycle-envelopes.json' with { type: 'json' };

const WORDS = 'sim, pode entregar e publicar o Orders';
const MODULE_KEY = 'aGVsbG8td29ybGQta2V5AA';

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pa3-k1-cycle-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home'), auth = path.join(base, 'authority');
  for (const dir of [root, home, auth]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'TESTKEY');
  const env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  fs.mkdirSync(path.join(root, '.local', 'connections'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242, port: 45998,
    studioDir: path.join(base, 'Studio'), authorityDir: auth }));
  const job = (name, document) => { const file = path.join(base, 'jobs', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(document)); return file; };
  let clock = Date.parse('2026-10-07T10:00:00.000Z');
  return { base, root, env, job, now: () => new Date(clock += 1000) };
}

async function serve(t, deps) {
  const server = new McpServer({ name: 'pa3-k1-cycle', version: '1.0.0' });
  registerO11Cycle(server, deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa3-k1-cycle-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return args => client.callTool({ name: 'o11_deliver', arguments: args })
    .then(reply => reply.structuredContent ?? JSON.parse(reply.content[0].text === 'delivered' ? '{"ok":true,"result":"delivered"}' : reply.content[0].text));
}

// The fake bridge: answers close_module and records it.
function fakeBridge() {
  const calls = [];
  return { calls, ok: async (method, params) => { calls.push({ method, params }); if (method === 'close_module') return { name: params.name, closed: true }; return {}; } };
}

function setup(t, { state = {}, publish, extra = {} } = {}) {
  const box = sandbox(t);
  const delivered = { ...envelopes.delivered, data: { ...envelopes.delivered.data, moduleKey: MODULE_KEY, environment: 'lab.example', ...state } };
  const runAnvil = fakeAnvil({ deliver: () => delivered });
  const bridge = fakeBridge();
  const published = [];
  const downloads = [];
  const deps = { root: box.root, env: box.env, lane: 'ss4', now: box.now, runAnvil, assertSelected: async () => {}, bridge,
    lastPublication: async () => null, publish: async input => { published.push(input); return publish ?? { ok: true, result: 'published' }; },
    downloadPublished: async module => { downloads.push(module); const file = path.join(box.root, '.local', 'environment', 'download', 'x', module + '.oml'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'oml'); return { ok: true, file, cached: true }; },
    ...extra };
  return { ...box, runAnvil, bridge, published, downloads, deps };
}

const deliverArgs = s => s.runAnvil.calls.find(c => c.args[0] === 'deliver').args;
const pairs = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

test('K1-d: a "published" binding is captured by the kernel; producers "published" alone binds nothing by hand', () => {
  const avsig = path.resolve('Lib.avsig');
  assert.deepEqual(producerArgs({ Case: PUBLISHED, System: PUBLISHED, Lib: avsig }),
    ['--capture-producer', 'Case', '--capture-producer', 'System=(System)', '--producer', 'Lib=' + avsig]);
  assert.deepEqual(producerArgs(PUBLISHED), []);
  assert.deepEqual(producerArgs(PUBLISHED, ['Case']), ['--capture-producer', 'Case']);
  assert.throws(() => producerArgs({ Case: PUBLISHED }, ['Case']), /both bound and captured/);
  assert.throws(() => producerArgs({ Case: 'relative.avsig' }), /absolute path or "published"/);
});

test('K1-d: o11_deliver accepts producers {X:"published"} and producers "published", and binds a referenced theme by its published OML', async t => {
  const s = setup(t);
  const call = await serve(t, s.deps);
  const job = s.job('k1d.json', { ops: [{ op: 'reference', producer: 'Case', elements: ['IEntitySignature:Casualty'] },
    { op: 'reference', producer: 'OutSystemsUI', elements: ['IWebTheme:OutSystemsUI'] }, { op: 'reference', producer: 'System', elements: ['IServerActionSignature:ListFilter'] }] });
  const map = await call({ module: 'Orders', job, producers: { Case: PUBLISHED, OutSystemsUI: PUBLISHED }, authorize: WORDS });
  assert.equal(map.ok, true, JSON.stringify(map));
  let args = deliverArgs(s);
  // The theme comes from the published OML (one download per version, K1-c); the other bindings are captured.
  assert.deepEqual(s.downloads, ['OutSystemsUI']);
  assert.deepEqual(pairs(args, '--producer'), ['OutSystemsUI=' + path.join(s.root, '.local', 'environment', 'download', 'x', 'OutSystemsUI.oml')]);
  assert.deepEqual(pairs(args, '--capture-producer').sort(), ['Case', 'System=(System)']);

  const t2 = setup(t);
  const call2 = await serve(t, t2.deps);
  const all = await call2({ module: 'Orders', job, producers: PUBLISHED, authorize: WORDS });
  assert.equal(all.ok, true, JSON.stringify(all));
  args = deliverArgs(t2);
  // Every referenced producer is "published": the theme by its published OML, the others captured ((System) included).
  assert.deepEqual(t2.downloads, ['OutSystemsUI']);
  assert.deepEqual(pairs(args, '--producer'), ['OutSystemsUI=' + path.join(t2.root, '.local', 'environment', 'download', 'x', 'OutSystemsUI.oml')]);
  assert.deepEqual(pairs(args, '--capture-producer').sort(), ['Case', 'System=(System)']);
  assert.equal(themeReferenced(job, 'outsystemsui'), true); assert.equal(themeReferenced(job, 'Case'), false);
});

test('K1-d: until=apply cannot capture a "published" producer and says so before anything runs', async t => {
  const s = setup(t);
  const call = await serve(t, s.deps);
  const job = s.job('apply.json', { ops: [{ op: 'reference', producer: 'Case', elements: ['IEntitySignature:Casualty'] }] });
  const value = await call({ module: 'Orders', job, producers: { Case: PUBLISHED }, until: 'apply', authorize: WORDS });
  assert.equal(value.code, 'CAPTURE_NEEDS_DELIVER');
  assert.deepEqual(value.continuation.arguments, { action: 'capture', producer: 'Case' });
  assert.equal(s.runAnvil.calls.length, 0);
});

test('K1-g: without a publication the kernel closes the tab (--close-opened-tab) and the answer says closedTab', async t => {
  assert.ok(deliverArguments({ module: 'M', job: 'j.json' }, { work: 'W', port: 1 }).includes('--close-opened-tab'));
  assert.ok(!deliverArguments({ module: 'M', job: 'j.json', publish: true }, { work: 'W', port: 1 }).includes('--close-opened-tab'));
  assert.ok(deliverArguments({ resume: '0f1e2d3c4b5a69788796a5b4c3d2e1f0' }, { work: 'W', port: 1 }).includes('--close-opened-tab'));
  const s = setup(t, { state: { open: { opened: true, alreadyOpen: false }, closedTab: true } });
  const value = await (await serve(t, s.deps))({ module: 'Orders', job: s.job('g.json', { ops: [{ op: 'get', target: 'X:Y' }] }), authorize: WORDS });
  assert.equal(value.closedTab, true);
  assert.ok(deliverArgs(s).includes('--close-opened-tab'));
  assert.equal(s.bridge.calls.filter(c => c.method === 'close_module').length, 0, 'the kernel closed it, not the facade');
});

test('K1-g: with publish:true the tab the delivery opened is closed once after the publication; an already open tab never', async t => {
  const opened = setup(t, { state: { open: { opened: true, alreadyOpen: false } } });
  const value = await (await serve(t, opened.deps))({ module: 'Orders', job: opened.job('p.json', { ops: [{ op: 'get', target: 'X:Y' }] }), publish: true, authorize: WORDS });
  assert.equal(value.ok, true); assert.equal(value.result, 'delivered and published');
  assert.equal(value.closedTab, true);
  const closes = opened.bridge.calls.filter(c => c.method === 'close_module');
  assert.equal(closes.length, 1);
  assert.deepEqual(closes[0].params, { name: 'Orders', module_key: MODULE_KEY, environment: 'lab.example' });
  assert.ok(!deliverArgs(opened).includes('--close-opened-tab'));

  const already = setup(t, { state: { open: { opened: true, alreadyOpen: true } } });
  const kept = await (await serve(t, already.deps))({ module: 'Orders', job: already.job('q.json', { ops: [{ op: 'get', target: 'X:Y' }] }), publish: true, authorize: WORDS });
  assert.equal(kept.ok, true); assert.equal(kept.closedTab, undefined);
  assert.equal(already.bridge.calls.filter(c => c.method === 'close_module').length, 0);

  // A tab the bridge's guard keeps: the reason, never a failure of the delivery.
  const guarded = await closeOpenedTab('Orders', { open: { alreadyOpen: false } }, { bridge: () => ({ ok: async () => { throw new Error('close_module: tab has unsaved changes'); } }) });
  assert.deepEqual(guarded, { closed: false, reason: 'close_module: tab has unsaved changes' });
  assert.equal(await closeOpenedTab('Orders', { open: { alreadyOpen: true } }, {}), undefined);
});

test('I8: the publication\'s own code reaches the answer (PUBLISH_BLOCKED_BY_DIALOG), the outcome code otherwise', async t => {
  const blocked = setup(t, { publish: { ok: false, outcome: 'failed', code: 'PUBLISH_BLOCKED_BY_DIALOG', error: 'Manage Dependencies is open in the Studio.' } });
  const value = await (await serve(t, blocked.deps))({ module: 'Orders', job: blocked.job('b.json', { ops: [{ op: 'get', target: 'X:Y' }] }), publish: true, authorize: WORDS });
  assert.equal(value.result, 'delivered'); assert.equal(value.code, 'PUBLISH_BLOCKED_BY_DIALOG');
  assert.equal(blocked.bridge.calls.filter(c => c.method === 'close_module').length, 0, 'the tab stays when the publication did not end');
});
