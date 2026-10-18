// Atritos 3, lane wp (the OML writer pool): studio_deliver split in build and apply (odc-build-phase.mjs). The capture is
// a short Studio moment (the ODC bridge serves one command at a time), the kernel apply and the builder run in the build
// pool without the Studio lock, the merge takes the Studio; a merge that finds the module changed after the capture
// (BASE_DRIFT, nothing merged) is rebuilt once on the module as it is now, in the same call. Fakes only; no Studio.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withStudioWriteLock, phaseOfCall, QUEUE_TIMEOUT_CODE } from '../studio-write-lock.mjs';
import { createBuildPool } from '../build-pool.mjs';
import { phasedStudio, phasedDeliveryDeps, phasedDeliver } from '../odc-build-phase.mjs';
import { deliverKernel } from '../kernel-delivery.mjs';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { PHASES_META } from '../studio-write-lock.mjs';

const tmp = () => fs.mkdtempSync(path.join(isolatedProfile, 'pa3-wp-odc-'));
const depsFor = root => ({ o11Root: path.join(root, 'kernel'), odcRoot: path.join(root, 'odc'), o11Lane: 'ss4' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const overlap = (a, b) => a.start < b.end && b.start < a.end;
const phased = (deps, module, fn, extra = {}) => withStudioWriteLock({ tool: 'studio_deliver', args: { module, feature: 'f', pid: 7 }, lane: 'odc', deps: { ...deps, ...extra }, phased: true }, fn);

test('wp odc: the capture is a Studio moment, the merge takes the Studio; a merge whose turn does not come is its refusal', async () => {
  const deps = depsFor(tmp());
  const seen = [];
  const studio = phasedStudio(async args => { seen.push([args[0], phaseOfCall()?.promoted ?? null]); return { ok: true, command: args[0] }; });
  const answer = await phased(deps, 'App', async () => {
    await studio(['snapshot', 'App'], 7);
    assert.equal(phaseOfCall().promoted, false, 'the moment gave the Studio back');
    await studio(['merge', 'manifest.json'], 7);
    return { ok: true, phase: phaseOfCall() };
  });
  assert.deepEqual(seen, [['snapshot', false], ['merge', true]]);
  assert.equal(answer.phase.promoted, true);
  // Another write holds the Studio: the merge answers the queue's refusal as its value (nothing merged).
  const gate = deferred(); const holding = deferred();
  const holder = withStudioWriteLock({ tool: 'studio_publish', args: { pid: 7 }, lane: 'odc', deps }, async () => { holding.resolve(); await gate.promise; });
  await holding.promise;
  let merged = false;
  const refused = phasedStudio(async args => { if (args[0] === 'merge') merged = true; return { ok: true }; });
  const value = await phased(deps, 'App', async () => ({ ok: true, merge: await refused(['merge', 'm.json'], 7) }), { queueMs: 50 });
  assert.equal(merged, false);
  assert.equal(value.code, QUEUE_TIMEOUT_CODE, JSON.stringify(value));
  gate.resolve(); await holder;
});

test('wp odc: a capture that finds the bridge busy (nothing sent) is asked again within the queue limit', async () => {
  const deps = depsFor(tmp());
  let calls = 0;
  const studio = phasedStudio(async () => { if (++calls === 1) throw Object.assign(new Error('busy'), { code: 'BRIDGE_BUSY', sent: false }); return { ok: true, path: 'x.oml' }; });
  const value = await phased(deps, 'App', async () => studio(['snapshot', 'App'], 7));
  assert.deepEqual([value.ok, calls], [true, 2]);
});

test('wp odc: the kernel apply runs in a pool slot with its TEMP (deps.exec) and its worker; check comes from the kernel when it has one', async () => {
  const root = tmp();
  const pool = createBuildPool({ dir: path.join(root, 'pool'), size: 1, queueMs: 5000 });
  const calls = [];
  const kernel = { applyKernel: async (args, deps) => { calls.push({ args, deps, start: Date.now() }); await sleep(40); calls.at(-1).end = Date.now(); return { ok: true }; } };
  const d = phasedDeliveryDeps({ root, studio: async () => ({ ok: true }), prepareManifest: async () => ({ ok: true }), pool, kernel });
  assert.equal(d.kernel.check, undefined, 'no check in a kernel without checkJobKernel');
  await Promise.all([d.kernel.apply({ job: 'a' }), d.kernel.apply({ job: 'b' })]);
  assert.ok(!overlap(calls[0], calls[1]), 'one slot: the two applies took turns');
  for (const c of calls) { assert.equal(typeof c.deps.exec, 'function'); assert.equal(c.deps.worker, null, 'ANVIL_ODC_NO_WORKER: cold, in the slot'); }
  const withCheck = phasedDeliveryDeps({ root, studio: async () => ({}), prepareManifest: async () => ({}), pool, kernel: { ...kernel, checkJobKernel: async () => ({ ok: true }) } });
  assert.equal(typeof withCheck.kernel.check, 'function');
});

test('wp odc: BASE_DRIFT before any merge rebuilds once on the module as it is now, in the same call; other refusals do not', async () => {
  const root = tmp(); const deps = depsFor(root);
  const evidence = name => { const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'deliver-result.json'), '{}'); return dir; };
  const first = evidence('lab-1'); const second = evidence('lab-2');
  const asked = [];
  const answers = [{ ok: false, code: 'BASE_DRIFT', failed: 'merge', merged: false, evidence: first, steps: [{ step: 'build' }, { step: 'merge' }] },
    { ok: true, result: 'delivered', merged: true, strictlyEqual: true, evidence: second, steps: [{ step: 'build' }, { step: 'merge' }] }];
  const deliver = async args => { asked.push(args); return answers[asked.length - 1]; };
  const value = await phased(deps, 'App', () => phasedDeliver({ module: 'App', feature: 'f', job: 'j.json', output: 'lab-1' }, {}, { deliver }));
  assert.equal(asked.length, 2);
  assert.equal(asked[1].output, undefined, 'the rebuild takes a new evidence folder');
  assert.equal(value.result, 'delivered');
  assert.deepEqual(value.phases.rebased, { reason: 'BASE_DRIFT', from: first });
  for (const dir of [first, second]) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'deliver-result.json'), 'utf8')).phases, value.phases);
  const once = [];
  const conflict = await phased(deps, 'App', () => phasedDeliver({ module: 'App' }, {}, { deliver: async args => { once.push(args); return { ok: false, code: 'MERGE_CONFLICT', failed: 'merge' }; } }));
  assert.deepEqual([once.length, conflict.code], [1, 'MERGE_CONFLICT']);
});

// Two whole kernel deliveries (kernel-delivery.mjs deliverKernel) to two modules of one ODC Studio: the builds overlap,
// the merges do not.
test('wp odc: two studio_deliver to different modules of one Studio overlap their builds while their merges serialize', async () => {
  const root = tmp(); const deps = depsFor(root);
  const log = { builds: [], merges: [] };
  const job = path.join(root, 'job.json'); fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'set', target: 'x', prop: 'Label', value: '"y"' }] }));
  const studio = async (args) => {
    if (args[0] === 'snapshot') {
      const file = path.join(root, 'snap-' + args[1] + '-' + Date.now() + Math.random() + '.oml'); fs.writeFileSync(file, 'base ' + args[1]);
      return { ok: true, module: args[1], path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), host: 'h.test', developerId: 'dev', moduleKey: 'K-' + args[1], kind: 'library' };
    }
    if (args[0] === 'merge') { const m = { start: Date.now() }; await sleep(50); m.end = Date.now(); log.merges.push(m); return { ok: true, merged: true, strictlyEqual: true }; }
    if (args[0] === 'status') return { ok: true, value: [] };
    throw new Error('unexpected ' + args[0]);
  };
  const kernel = { applyKernel: async ({ output }) => { const b = { start: Date.now() }; await sleep(150); b.end = Date.now(); log.builds.push(b);
    fs.writeFileSync(path.join(output, 'kernel-candidate.oml'), 'candidate'); return { ok: true, candidate: path.join(output, 'kernel-candidate.oml'), receipt: null }; } };
  const pool = createBuildPool({ dir: path.join(root, 'pool'), size: 2, queueMs: 5000 });
  const one = module => phased(deps, module, () => {
    const d = phasedDeliveryDeps({ root, studio, pool, kernel, prepareManifest: async ({ output }) => { fs.mkdirSync(output, { recursive: true }); return { ok: true, manifest: path.join(output, 'manifest.json') }; } });
    return phasedDeliver({ module, feature: 'f-' + module, job, owners: ['o'], changes: ['c'] }, d, { deliver: (args, x) =>
      deliverKernel({ ...args, output: path.join(root, 'lab', module) }, { root, studio: x.studio, ...x.kernel, nextLabDir: () => null, journal: () => {}, cache: null, prefetch: () => {}, guide: null, grants: null }) });
  });
  const [a, b] = await Promise.all([one('Shop'), one('Admin')]);
  for (const r of [a, b]) assert.equal(r.result, 'delivered', JSON.stringify(r));
  assert.ok(overlap(log.builds[0], log.builds[1]), 'builds overlapped: ' + JSON.stringify(log.builds));
  assert.ok(!overlap(log.merges[0], log.merges[1]), 'merges serialized: ' + JSON.stringify(log.merges));
  for (const r of [a, b]) assert.ok(r.phases?.buildMs >= 100, JSON.stringify(r.phases));
});

// Through the ssam server's ODC proxy: a studio_deliver whose lane declares its phases (_meta) runs its build without the
// Studio lock (the call's phase reaches the lane's handler across the in-process MCP proxy); one that does not declare
// them holds the Studio for the whole call, as before.
test('wp odc: the phase declaration travels through the ssam proxy; an undeclared studio_deliver keeps the whole-call lock', async t => {
  for (const declared of [true, false]) {
    const root = tmp();
    const seen = [];
    const odcFacade = async () => {
      const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
      fake.registerTool('studio_deliver', { inputSchema: z.object({ feature: z.string(), module: z.string().optional() }).strict(),
        ...(declared ? { _meta: { [PHASES_META]: true } } : {}) }, async () => {
        seen.push(phaseOfCall());
        const value = { ok: true, merged: true, strictlyEqual: true };
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      });
      return fake;
    };
    const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot: root, lock: { o11Root: root, odcRoot: root, connection: () => null } } });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pa3-wp-odc', version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    t.after(async () => { await client.close(); await server.close(); });
    const answer = await client.callTool({ name: 'studio_deliver', arguments: { feature: 'F', module: 'Shop' } });
    assert.notEqual(answer.isError, true, JSON.stringify(answer));
    assert.deepEqual(seen, [declared ? { promoted: false, tool: 'studio_deliver' } : null], declared ? 'built without the Studio lock' : 'not a phased call');
  }
});