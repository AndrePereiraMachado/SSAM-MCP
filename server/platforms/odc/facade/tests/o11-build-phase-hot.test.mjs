// R3 (módulo quente): the capture of the build phase, the copy the kernel applies to and the kernel's hot module share one
// identity, the model hash of o11-capture-store.mjs; the prebuilt manifest records it with the kernel's hot receipt and
// stays what PrebuiltCandidate reads. Fake bridges and a fake kernel runner only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildBeforeApply, captureByKey, hotOfBuild, PREBUILT_SCHEMA } from '../o11-build-phase.mjs';
import { modelSha256, rememberDelivery } from '../o11-capture-store.mjs';
import { createBuildPool } from '../build-pool.mjs';
import { withStudioWriteLock } from '../studio-write-lock.mjs';

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-build-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const oml = (header, model) => { const head = Buffer.from(header); const length = Buffer.alloc(4); length.writeUInt32LE(head.length); return Buffer.concat([Buffer.from('OML'), length, head, Buffer.from(model)]); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const tab = model => ({ modules: [{ name: 'App', key: 'K', hasESpace: true, hasOpenedActiveESpace: true, serverSilentMode: false, ...(model ? { modelSha256: model } : {}) }] });
const bridge = table => ({ calls: [], async ok(method, params = {}) {
  this.calls.push(method);
  if (!(method in table)) throw new Error('a Studio write: ' + method);
  return typeof table[method] === 'function' ? table[method](params) : table[method];
} });

test('a capture and its reused copy carry the model hash the capture store and the kernel key the hot module by', async t => {
  const local = tmp(t);
  const snapshot = params => { fs.writeFileSync(params.path, oml('{window:1}', 'MODEL')); return { path: params.path, key: 'K' }; };
  const fresh = await captureByKey('App', { bridge: () => bridge({ list_open_modules: tab(null), snapshot_module: snapshot }), local });
  assert.equal(fresh.modelSha256, sha(Buffer.from('MODEL')));
  assert.equal(fresh.modelSha256, modelSha256(fresh.path));
  const copy = await captureByKey('App', { bridge: () => bridge({ list_open_modules: tab(sha(Buffer.from('MODEL'))) }), local });
  assert.ok(copy.reused, 'the second build copies the capture');
  assert.notEqual(path.resolve(copy.path), path.resolve(fresh.path), 'into a file of its own');
  assert.equal(copy.modelSha256, fresh.modelSha256, 'and it is the same module for the kernel');
});

test('hotOfBuild names the kernel identity next to the capture identity, and a mismatch is said, never hidden', () => {
  const model = 'a'.repeat(64);
  assert.equal(hotOfBuild({}, model), null);
  assert.deepEqual(hotOfBuild({ hot: { reused: true, reason: 'spare', savedMs: 2444, modelSha256: model } }, model),
    { reused: true, reason: 'spare', savedMs: 2444, identity: { capture: model, kernel: model, same: true } });
  const other = hotOfBuild({ hot: { reused: false, reason: 'first apply', savedMs: 0, modelSha256: 'b'.repeat(64) } }, model);
  assert.equal(other.identity.same, false);
  assert.equal(hotOfBuild({ hot: { reused: false, reason: 'cold process', savedMs: 0 } }, model).identity.kernel, null);
});

test('the prebuilt manifest keeps what PrebuiltCandidate reads, with the model the build applied to and the kernel hot', async t => {
  const root = tmp(t);
  const job = path.join(root, 'job.json'); fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'logic', data: { flow: ['server action A\n  end\n'] } }] }));
  const lane = { local: path.join(root, 'local'), work: path.join(root, 'work'), name: 'ss4' };
  // The module was delivered before: the build copies that capture (nothing captured), the kernel finds its spare.
  const held = path.join(lane.local, 'held.oml'); fs.mkdirSync(lane.local, { recursive: true }); fs.writeFileSync(held, oml('{after merge}', 'MODEL-1'));
  rememberDelivery(lane.local, { moduleKey: 'K', deliveredSnapshot: { path: held, key: 'K', name: 'App' } });
  const model = sha(Buffer.from('MODEL-1'));
  const studio = bridge({ list_open_modules: tab(model) });
  const argvs = [];
  const runner = () => async argv => {
    argvs.push(argv);
    const out = argv[argv.indexOf('--out') + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, oml('{candidate}', 'MODEL-1+job'));
    fs.writeFileSync(out.replace(/\.oml$/i, '.result.json'), '{}');
    return { envelope: { ok: true, data: { isValid: true, accepted: true,
      hot: { reused: true, reason: 'a spare of the same model, loaded and walked while the worker was idle', savedMs: 2444, modelSha256: model },
      timings: { loadMs: 13 } } }, wallMs: 3600 };
  };
  const ctx = { root, env: {}, now: () => new Date(), bridge: () => studio, buildPool: createBuildPool({ dir: path.join(root, 'pool'), size: 1 }), buildRunner: runner };
  const deps = { o11Root: path.join(root, 'kernel'), odcRoot: path.join(root, 'odc'), o11Lane: 'ss4', connection: () => null };
  const built = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'App', job }, lane: 'o11', deps, phased: true },
    () => buildBeforeApply({ input: { module: 'App' }, job, ctx, lane, task: { id: 'T1' } }));
  assert.deepEqual(studio.calls, ['list_open_modules'], 'nothing was captured: the copy of the held capture');
  assert.deepEqual(built.args, ['--prebuilt', built.manifest], '--prebuilt as before');
  const manifest = JSON.parse(fs.readFileSync(built.manifest, 'utf8'));
  for (const field of ['schema', 'job', 'base', 'baseSha256', 'candidate', 'candidateSha256', 'result', 'producers']) assert.ok(field in manifest, field);
  assert.equal(manifest.schema, PREBUILT_SCHEMA);
  assert.equal(argvs[0][argvs[0].indexOf('--base') + 1], manifest.base, 'the kernel applied to the base the manifest names');
  assert.equal(manifest.baseModelSha256, model);
  assert.equal(manifest.baseModelSha256, modelSha256(manifest.base));
  assert.equal(manifest.captureReused.modelSha256, model);
  assert.deepEqual(manifest.hot.identity, { capture: model, kernel: model, same: true });
  assert.equal(manifest.hot.reused, true);
  assert.equal(built.hot.savedMs, 2444);
});
