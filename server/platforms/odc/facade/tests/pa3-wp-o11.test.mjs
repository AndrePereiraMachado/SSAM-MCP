// Atritos 3, lane wp (the OML writer pool): o11_deliver through the ssam server, with a fake bridge and a fake Anvil CLI.
// The build phase captures the module by its key without selecting it and runs `anvil apply` in the build pool without
// the Studio lock; `anvil deliver --prebuilt` then runs under the lock. Two deliveries to different modules of one Studio
// overlap their builds while their delivers serialize; a candidate the kernel rebuilt on a changed module answers
// phases.rebased; a job the kernel refuses on the live module is answered from the build, without the Studio. No Studio,
// bridge, port or worker.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { createBuildPool } from '../build-pool.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const tmp = () => fs.mkdtempSync(path.join(isolatedProfile, 'pa3-wp-o11-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const overlap = (a, b) => a.start < b.end && b.start < a.end;
const words = 'pode entregar, Ana 0912';
const job = { ops: [{ op: 'rename', from: 'A', to: 'B' }] };
const option = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

// The fake lane: open tabs, captures by key, a CLI whose apply builds a candidate and whose deliver reports the task.
function lane(root, { open = ['Orders', 'Customers'], buildMs = 150, deliverMs = 60, applyData = { isValid: true, accepted: true }, prebuilt = { reused: true } } = {}) {
  const log = { builds: [], delivers: [], bridge: [], slots: [] };
  const bridge = { ok: async (method, params = {}) => {
    log.bridge.push(method + (params.module_key ? ':' + params.module_key : ''));
    if (method === 'list_open_modules') return { modules: open.map(name => ({ name, key: 'K-' + name, hasESpace: true })) };
    if (method === 'snapshot_module' && params.module_key) { fs.mkdirSync(path.dirname(params.path), { recursive: true }); fs.writeFileSync(params.path, 'OML capture of ' + params.module_key); return { key: params.module_key, path: params.path }; }
    throw Object.assign(new Error('not in this test: ' + method), { code: 'BRIDGE_NOT_LISTENING' });
  } };
  let tasks = 0;
  const runAnvil = fakeAnvil({
    apply: async args => {
      const build = { module: option(args, '--base'), start: Date.now() };
      await sleep(buildMs);
      const out = option(args, '--out');
      fs.writeFileSync(out, 'candidate'); fs.writeFileSync(out.replace(/\.oml$/, '.result.json'), JSON.stringify(applyData));
      build.end = Date.now(); log.builds.push(build);
      return { ok: true, command: 'apply', data: applyData };
    },
    deliver: async args => {
      const deliver = { module: option(args, '--module'), prebuilt: option(args, '--prebuilt'), start: Date.now() };
      await sleep(deliverMs);
      deliver.end = Date.now(); log.delivers.push(deliver);
      const taskId = String(++tasks).padStart(32, '0');
      const work = path.join(option(args, '--work'), 'deliver', taskId);
      fs.mkdirSync(work, { recursive: true });
      return { ok: true, command: 'deliver', data: { delivered: true, taskId, work, writeState: 'applied', module: deliver.module, apply: { isValid: true, accepted: true, ...(deliver.prebuilt ? { prebuilt } : {}) } } };
    },
  });
  const buildRunner = slot => { log.slots.push(slot); return runAnvil; };
  return { log, bridge, runAnvil, buildRunner };
}

async function serve(t, root, fake, pool = createBuildPool({ dir: path.join(root, 'pool'), size: 4, queueMs: 10000 })) {
  const server = await createSsamServer({ odc: false, deps: { cycle: { root, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil: fake.runAnvil, assertSelected: async () => {},
    tasksDir: path.join(root, 'tasks'), bridge: fake.bridge, lastPublication: async () => null, lock: { connection: () => null },
    buildPool: pool, buildRunner: fake.buildRunner },
    lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa3-wp-o11', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
const phasesOf = answer => answer.structuredContent?.phases ?? answer.content.map(c => { try { return JSON.parse(c.text); } catch { return null; } }).find(v => v?.phases)?.phases;

test('wp o11: two deliveries to different modules of one Studio build at once; their delivers (merge, verify) never overlap', async t => {
  const root = tmp();
  const fake = lane(root);
  const client = await serve(t, root, fake);
  const [a, b] = await Promise.all(['Orders', 'Customers'].map(module => client.callTool({ name: 'o11_deliver', arguments: { module, job, authorize: words } })));
  for (const answer of [a, b]) { assert.notEqual(answer.isError, true, JSON.stringify(answer)); assert.equal(JSON.parse(answer.content[0].text).result, 'entregue'); }
  assert.equal(fake.log.builds.length, 2);
  assert.ok(overlap(fake.log.builds[0], fake.log.builds[1]), 'the builds overlapped: ' + JSON.stringify(fake.log.builds));
  assert.ok(!overlap(fake.log.delivers[0], fake.log.delivers[1]), 'the delivers ran one after the other: ' + JSON.stringify(fake.log.delivers));
  // The capture of the build is by key, without selecting a tab (no open_module, no get_active_module).
  assert.deepEqual([...new Set(fake.log.bridge)].sort(), ['list_open_modules', 'snapshot_module:K-Customers', 'snapshot_module:K-Orders']);
  // The deliver takes the prebuilt candidate of its own module.
  for (const d of fake.log.delivers) {
    const manifest = JSON.parse(fs.readFileSync(d.prebuilt, 'utf8'));
    assert.equal(manifest.schema, 'ssam-prebuilt/1');
    assert.equal(manifest.module, d.module);
    assert.ok(fs.existsSync(manifest.candidate) && fs.existsSync(manifest.result) && fs.existsSync(manifest.base));
  }
  // Each build ran in a slot with its own TEMP.
  assert.equal(new Set(fake.log.slots.map(s => s.tmp)).size, 2);
  for (const answer of [a, b]) {
    const phases = phasesOf(answer);
    assert.ok(phases && phases.buildMs >= 100 && phases.applyMs >= 50, JSON.stringify(answer));
    assert.equal(phases.rebased, undefined);
  }
});

test('wp o11: the kernel rebuilt the candidate on a changed module: the answer says rebased and the task folder keeps the phases', async t => {
  const root = tmp();
  const fake = lane(root, { prebuilt: { reused: false, reason: 'base-changed' } });
  const client = await serve(t, root, fake);
  const answer = await client.callTool({ name: 'o11_deliver', arguments: { module: 'Orders', job, authorize: words } });
  assert.equal(JSON.parse(answer.content[0].text).result, 'entregue');
  const phases = phasesOf(answer);
  assert.deepEqual(phases.rebased, { reason: 'base-changed' });
  const receipt = path.join(root, '.local', 'work', 'deliver', '1'.padStart(32, '0'), 'phases.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')).phases, phases);
});

test('wp o11: a job the kernel refuses on the live module is answered from the build; the Studio is never taken', async t => {
  const root = tmp();
  const fake = lane(root, { applyData: { isValid: false, accepted: false, validation: { new: [{ type: 'Error', id: 'X1', detail: 'Unknown attribute Foo' }] } } });
  const client = await serve(t, root, fake);
  const answer = await client.callTool({ name: 'o11_deliver', arguments: { module: 'Orders', job, authorize: words } });
  assert.equal(answer.isError, true);
  const value = answer.structuredContent ?? JSON.parse(answer.content[0].text);
  assert.equal(value.code, 'VALIDATION_REFUSED', JSON.stringify(value));
  assert.match(JSON.stringify(value.messages), /Unknown attribute Foo/);
  assert.ok(value.job && value.jobSha256, 'the refusal names its job for the correction');
  assert.equal(fake.log.delivers.length, 0, 'nothing was sent to the Studio');
  assert.ok(phasesOf(answer)?.applyMs === 0, JSON.stringify(answer));
});

test('wp o11: a module that is not open in a tab skips the build phase and delivers as before, without --prebuilt', async t => {
  const root = tmp();
  const fake = lane(root, { open: [] });
  const client = await serve(t, root, fake);
  const answer = await client.callTool({ name: 'o11_deliver', arguments: { module: 'Orders', job, authorize: words } });
  assert.equal(JSON.parse(answer.content[0].text).result, 'entregue');
  assert.equal(fake.log.builds.length, 0);
  assert.equal(fake.log.delivers[0].prebuilt, null);
  assert.equal(phasesOf(answer), undefined, 'no build phase ran: the answer is as before');
});

test('wp o11: a busy build pool answers BUILD_QUEUE_TIMEOUT after its limit, naming the job; nothing reached the Studio', async t => {
  const root = tmp();
  const fake = lane(root);
  const pool = createBuildPool({ dir: path.join(root, 'pool'), size: 1, queueMs: 80 });
  let release; const held = new Promise(resolve => { release = resolve; });
  let occupied; const busy = new Promise(resolve => { occupied = resolve; });
  const other = pool.run({ customer: 'another' }, async () => { occupied(); await held; });
  await busy;
  const client = await serve(t, root, fake, pool);
  const answer = await client.callTool({ name: 'o11_deliver', arguments: { module: 'Orders', job, authorize: words } });
  release(); await other;
  const value = answer.structuredContent ?? JSON.parse(answer.content[0].text);
  assert.deepEqual([value.ok, value.code, value.outcome, value.waitedFor, value.position, value.queueMs], [false, 'BUILD_QUEUE_TIMEOUT', 'not-sent', 'pool', 1, 80], JSON.stringify(value));
  assert.ok(value.job && value.jobSha256);
  assert.equal(value.continuation.tool, 'ssam_doctor');
  assert.equal(fake.log.delivers.length, 0);
});