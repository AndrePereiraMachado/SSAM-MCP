// Atritos 3, lane wp (the OML writer pool): a small offline load test. 8 o11_deliver calls over 4 modules of ONE Service
// Studio, through the ssam server, with a fake bridge and a fake Anvil CLI (a build of 300 ms, a merge of 60 ms): first one
// after the other (serial), then all at once (4 build workers). The parallel wall time must stay well under the serial
// one, the merges of the Studio never overlap, and the two deliveries of each module never build at once. The numbers go
// to the test output (diagnostic). No Studio, bridge, port or worker.
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

const BUILD_MS = 300, MERGE_MS = 60;
const MODULES = ['Orders', 'Customers', 'Catalog', 'Billing'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const option = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const overlap = (a, b) => a.start < b.end && b.start < a.end;

async function bench(t) {
  const root = fs.mkdtempSync(path.join(isolatedProfile, 'pa3-wp-load-'));
  const log = { builds: [], merges: [] };
  const bridge = { ok: async (method, params = {}) => {
    if (method === 'list_open_modules') return { modules: MODULES.map(name => ({ name, key: 'K-' + name })) };
    if (method === 'snapshot_module' && params.module_key) { fs.mkdirSync(path.dirname(params.path), { recursive: true }); fs.writeFileSync(params.path, params.module_key); return { key: params.module_key, path: params.path }; }
    throw Object.assign(new Error('not in this test: ' + method), { code: 'BRIDGE_NOT_LISTENING' });
  } };
  let tasks = 0;
  const runAnvil = fakeAnvil({
    apply: async args => {
      const b = { module: path.basename(option(args, '--base')).split('-')[1], start: Date.now() };
      await sleep(BUILD_MS);
      const out = option(args, '--out'); fs.writeFileSync(out, 'c'); fs.writeFileSync(out.replace(/\.oml$/, '.result.json'), '{"isValid":true,"accepted":true}');
      b.end = Date.now(); log.builds.push(b);
      return { ok: true, data: { isValid: true, accepted: true } };
    },
    deliver: async args => {
      const m = { module: option(args, '--module'), start: Date.now() }; await sleep(MERGE_MS); m.end = Date.now(); log.merges.push(m);
      const taskId = String(++tasks).padStart(32, '0');
      return { ok: true, data: { delivered: true, taskId, writeState: 'applied', apply: { isValid: true, accepted: true, prebuilt: { reused: true } } } };
    },
  });
  const server = await createSsamServer({ odc: false, deps: { cycle: { root, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil, assertSelected: async () => {},
    tasksDir: path.join(root, 'tasks'), bridge, lastPublication: async () => null, lock: { connection: () => null },
    buildPool: createBuildPool({ dir: path.join(root, 'pool'), size: 4, queueMs: 60000 }), buildRunner: () => runAnvil },
    lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa3-wp-load', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const deliver = module => client.callTool({ name: 'o11_deliver', arguments: { module, job: { ops: [{ op: 'rename', from: 'A', to: 'B' }] }, authorize: 'pode entregar, Ana 0912' } });
  return { log, deliver };
}

test('wp load: 8 deliveries over 4 modules of one Studio, parallel against serial', { timeout: 60000 }, async t => {
  const calls = [...MODULES, ...MODULES];
  const serial = await bench(t);
  let started = Date.now();
  for (const module of calls) assert.equal((await serial.deliver(module)).content[0].text, 'entregue');
  const serialMs = Date.now() - started;

  const parallel = await bench(t);
  started = Date.now();
  const answers = await Promise.all(calls.map(module => parallel.deliver(module)));
  const parallelMs = Date.now() - started;
  for (const answer of answers) assert.equal(answer.content[0].text, 'entregue', JSON.stringify(answer));

  const merges = parallel.log.merges;
  for (let i = 0; i < merges.length; i++) for (let j = i + 1; j < merges.length; j++)
    assert.ok(!overlap(merges[i], merges[j]), 'two merges of one Studio overlapped: ' + JSON.stringify([merges[i], merges[j]]));
  for (const module of MODULES) {
    const own = parallel.log.builds.filter(b => b.module === module);
    assert.equal(own.length, 2, module + ': two builds');
    assert.ok(!overlap(own[0], own[1]), module + ': two builds of one module at once');
  }
  const report = { deliveries: calls.length, modules: MODULES.length, workers: 4, buildMs: BUILD_MS, mergeMs: MERGE_MS, serialMs, parallelMs, speedup: Math.round(serialMs / parallelMs * 100) / 100 };
  t.diagnostic('pa3-wp load: ' + JSON.stringify(report));
  console.log('pa3-wp load: ' + JSON.stringify(report));
  assert.ok(parallelMs < serialMs * 0.6, JSON.stringify(report));
});
