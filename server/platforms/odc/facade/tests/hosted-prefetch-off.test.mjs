// a11-b (hosted-e2e hang): the detached index warm-up (module-map.mjs prefetchIndex, `node module-map.mjs --prefetch`) never
// starts on the hosted server. It is a process of the server outside the customer's context: it read a customer's capture
// through the server's shared reader cache (<readers>-prefetch, whose prefetch.jsonl named the workspace file), left a
// resident ODC reader that outlived the request, the customer and the server (the EPERM and the hang of hosted-e2e on
// Windows once the builder was built), and started one more process per new capture with no bound per customer. Hosted, a
// customer's call and the served process outside any context both refuse it; a local session (stdio, --local-studios)
// keeps it.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prefetchIndex } from '../module-map.mjs';
import { DenyExecutor, setDefaultExecutor, runWithExecutor, hostedContext, servedWithoutContext } from '../executor.mjs';
import { writeCapture } from './fixtures/module-index.mjs';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-prefetch-hosted-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: path.join(dir, 'store'), SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  const workspace = path.join(dir, 'customers', 'tok_test');
  fs.mkdirSync(workspace, { recursive: true });
  return { dir, env, workspace, ...writeCapture(dir) };
}
const spy = () => {
  const spawned = [];
  const spawnProcess = (exe, args, options) => { spawned.push({ exe, args, options }); return { on() {}, unref() {} }; };
  return { spawned, spawnProcess };
};
const hostedOf = workspace => ({ id: randomUUID(), hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace, agent: null,
  executor: { id: 'fake', hosted: true, async call() { return {}; }, o11Connection() { return null; }, async close() {} }, close: async () => {} });

test('a customer call on the hosted server starts no detached index warm-up, in either lane', async t => {
  const c = setup(t);
  const { spawned, spawnProcess } = spy();
  await runWithExecutor(hostedOf(c.workspace), async () => {
    assert.ok(hostedContext());
    for (const lane of ['odc', 'o11']) assert.deepEqual(prefetchIndex(c.file, lane, { env: c.env, spawnProcess }), { started: false, reason: 'hosted' });
    // as the callers reach it (lib.mjs / lanes.mjs / kernel-delivery.mjs warmIndex): after an import, in a later turn
    await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal((await import('../module-map.mjs')).prefetchIndex(c.file, 'odc', { env: c.env, spawnProcess }).reason, 'hosted');
  });
  assert.deepEqual(spawned, []);
  assert.equal(fs.existsSync(path.join(c.dir, 'readers-prefetch')), false, 'no prefetch reader cache');
  assert.equal(fs.existsSync(path.join(c.workspace, 'state')), false, 'nothing written in the workspace either');
});

test('the served process outside any customer context (DenyExecutor default) starts none either', async t => {
  const c = setup(t);
  const { spawned, spawnProcess } = spy();
  const previous = setDefaultExecutor(new DenyExecutor());
  try {
    assert.equal(servedWithoutContext(), true);
    assert.deepEqual(prefetchIndex(c.file, 'odc', { env: c.env, spawnProcess }), { started: false, reason: 'hosted' });
  } finally { setDefaultExecutor(previous); }
  assert.deepEqual(spawned, []);
});

test('a local session keeps the warm-up (control)', async t => {
  const c = setup(t);
  const { spawned, spawnProcess } = spy();
  const result = prefetchIndex(c.file, 'odc', { env: c.env, spawnProcess });
  assert.equal(result.started, true, JSON.stringify(result));
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.detached, true);
});
