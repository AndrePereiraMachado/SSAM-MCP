// Package 3, lane mb, C02 item 2: the resident builder. prepareManifest asks the resident process when it serves and the
// cold builder otherwise; residentManifest finds the server of its generation by its state file and ping and maps its answers.
// Fakes only: no process is started, no key file is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareManifest } from '../lib.mjs';
import { residentManifest } from '../builder-resident.mjs';
import { readerGeneration } from '../reader-client.mjs';

const input = { base: 'C:\\w\\base.oml', candidate: 'C:\\w\\candidate.oml', output: 'C:\\w\\delivery', feature: 'f', owners: ['Screen'], changes: ['Change'] };

test('prepareManifest takes the resident builder\'s answer, and the cold builder when it does not serve', async () => {
  const seen = [];
  const resident = async args => { seen.push(args); return { used: true, value: { ok: true, manifest: 'm.json', output: ['m.json'], resident: true } }; };
  const cold = async () => { throw new Error('the cold builder must not run'); };
  const served = await prepareManifest(input, { resident, builder: cold });
  assert.deepEqual(served, { ok: true, manifest: 'm.json', output: ['m.json'], resident: true });
  assert.deepEqual(seen[0].slice(0, 2), ['--base', path.resolve('C:\\w\\base.oml')]);
  let coldArgs = null;
  const fallback = await prepareManifest(input, { resident: async () => ({ used: false, note: 'disabled' }), builder: async args => { coldArgs = args; return { ok: true, manifest: 'c.json', output: [] }; } });
  assert.equal(fallback.manifest, 'c.json');
  assert.equal(coldArgs[0], 'manifest');
});

function serverFolders(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa3-mb-builder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'ODC3.Builder.dll'), 'builder');
  const runtime = path.join(dir, 'odc'); fs.mkdirSync(runtime); fs.writeFileSync(path.join(runtime, 'OutSystems.Model.dll'), 'model');
  const dll = path.join(bin, 'ODC3.Builder.dll');
  const generation = readerGeneration(dll, runtime);
  const cacheRoot = path.join(dir, 'cache');
  const folder = path.join(cacheRoot, 'odc-manifest', generation);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'worker.json'), JSON.stringify({ port: 1, pid: 7, instanceId: 'i1', generation }));
  return { dll, runtime, cacheRoot, generation };
}

test('residentManifest asks the running server of its generation and maps its answers', async t => {
  const f = serverFolders(t);
  const requests = [];
  const answer = { manifest: { ok: true, data: { manifest: 'C:\\w\\delivery\\manifest.json', resident: true } } };
  const rpc = async (state, args, key) => {
    requests.push({ args, key });
    if (args[0] === 'ping') return { ok: true, data: { manifestGeneration: f.generation, instanceId: 'i1', recycling: false } };
    return answer.manifest;
  };
  const spawnFn = () => { throw new Error('a running server is never started again'); };
  const options = { dll: f.dll, runtimeDir: f.runtime, cacheRoot: f.cacheRoot, root: 'C:\\odc', rpc, spawnFn, authorization: 'test-key' };
  const served = await residentManifest(['--base', 'b.oml'], options);
  assert.deepEqual(served, { used: true, value: { ok: true, manifest: 'C:\\w\\delivery\\manifest.json', output: ['C:\\w\\delivery\\manifest.json'], resident: true } });
  const request = requests.find(r => r.args[0] === 'manifest');
  assert.deepEqual(JSON.parse(request.args[1]), { root: 'C:\\odc', args: ['--base', 'b.oml'] });
  assert.equal(request.key, 'test-key');
  // A refusal of the builder comes back as the cold builder answers it.
  answer.manifest = { ok: false, error: 'Candidate equals the live module X (snapshot 0123): no element added, removed or changed.' };
  const refused = await residentManifest(['--base', 'b.oml'], options);
  assert.equal(refused.used, true); assert.equal(refused.value.ok, false); assert.match(refused.value.error, /Candidate equals the live module/);
  // A request the server did not run goes to the cold builder.
  answer.manifest = { ok: false, executed: false, error: 'Worker operation requires the trusted Hybrid controller' };
  assert.equal((await residentManifest(['--base', 'b.oml'], options)).used, false);
});
