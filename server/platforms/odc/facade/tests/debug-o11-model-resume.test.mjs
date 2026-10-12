import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureO11NativeModel } from '../debug-o11-native-run.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-model-resume-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('ssam-o11-model-resume-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const keys = ['A'.repeat(22), 'B'.repeat(22)], calls = [];
  let generation = 'reader-1', source = '1'.repeat(64), failSecond = true;
  const services = {
    selectReader: () => ({ generation }),
    lifecycle: {
      snapshot: async () => ({ file: path.join(root, 'source.oml'), sha256: source, versionId: 1, proof: {} }),
      readTree: async (_base, selector) => {
        calls.push(selector);
        if (failSecond && selector === '@' + keys[1]) throw Error('interrupted');
        return { key: selector.slice(1), kind: 'ServerAction', name: 'Diagnostic' };
      },
    },
    modelRead: async args => ({ ok: true, data: { searchComplete: true, nextOffset: null,
      entries: args[args.indexOf('--kind') + 1] === 'ServerAction' ? keys.map(key => ({ key })) : [] } }),
  };
  return { root, keys, calls, services,
    cache: () => path.join(root, '.local/debugger/native-runs/o11/model-cache', source + '.json'),
    resume: () => { failSecond = false; },
    generation: value => { generation = value; }, source: value => { source = value; },
    run: () => captureO11NativeModel(root, { module: 'Diagnostic', moduleKey: 'C'.repeat(22) }, path.join(root, 'capture'), services),
  };
}

test('interrupted producer capture resumes completed projections and publishes only a complete graph', async t => {
  const f = fixture(t);
  await assert.rejects(f.run(), /interrupted/);
  assert.equal(fs.existsSync(f.cache()), false);
  f.resume();
  const result = await f.run();
  assert.deepEqual(result.readings.map(r => r.key), f.keys);
  assert.equal(f.calls.filter(k => k === '@' + f.keys[0]).length, 1);
  assert.equal(f.calls.filter(k => k === '@' + f.keys[1]).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(f.cache())).readings.length, 2);
  await f.run();
  assert.equal(f.calls.length, 3);
});

for (const change of ['generation', 'source']) test(`partial projections cannot cross ${change} boundaries`, async t => {
  const f = fixture(t);
  await assert.rejects(f.run(), /interrupted/);
  f[change](change === 'source' ? '2'.repeat(64) : 'reader-2');
  f.resume();
  await f.run();
  assert.equal(f.calls.filter(k => k === '@' + f.keys[0]).length, 2);
});

test('a mismatched action projection never becomes a checkpoint or complete graph', async t => {
  const f = fixture(t);
  f.services.lifecycle.readTree = async () => ({ key: 'Z'.repeat(22), kind: 'ServerAction' });
  await assert.rejects(f.run(), /debug_o11_native_model_read_identity_mismatch/);
  assert.equal(fs.existsSync(f.cache()), false);
});

test('cancellation stops before the next action read and retains only completed projections', async t => {
  const f = fixture(t); f.resume();
  let cancelled = false;
  const read = f.services.lifecycle.readTree;
  f.services.checkActive = () => { if (cancelled) throw Error('debug_server_session_cancelled'); };
  f.services.lifecycle.readTree = async (...args) => { const tree = await read(...args); cancelled = true; return tree; };
  await assert.rejects(f.run(), /debug_server_session_cancelled/);
  assert.deepEqual(f.calls, ['@' + f.keys[0]]);
  assert.equal(fs.existsSync(f.cache()), false);
  cancelled = false; f.services.lifecycle.readTree = read;
  await f.run();
  assert.deepEqual(f.calls, f.keys.map(k => '@' + k));
});

test('already cancelled capture never snapshots a published module', async t => {
  const f = fixture(t);
  let snapshots = 0;
  f.services.lifecycle.snapshot = async () => { snapshots++; };
  f.services.checkActive = () => { throw Error('debug_server_session_cancelled'); };
  await assert.rejects(f.run(), /debug_server_session_cancelled/);
  assert.equal(snapshots, 0);
});

// Completeness of each per-entry projection (product: verified depth/max/budget, never a silently truncated read).
const leaf = (key, extra = {}) => ({ key, kind: 'Assign', properties: {}, children: [], ...extra });
test('a truncated or foreign action projection refuses the capture before any checkpoint or complete graph', async t => {
  const deep = (n, key) => n ? { ...leaf(key + n), children: [deep(n - 1, key)] } : leaf(key + 0);
  for (const truncate of [
    tree => ({ ...tree, childrenOmitted: 2 }),
    tree => ({ ...tree, childrenTotal: 3, children: [leaf('x')] }),
    tree => ({ ...tree, children: [leaf('x', { propertiesOmitted: { Value: true } })] }),
    tree => ({ ...tree, children: [leaf('x', { propertiesMissing: ['Action'] })] }),
    tree => ({ ...tree, propertyErrors: { Action: 'failed' } }),
    tree => ({ ...tree, children: [leaf('x', { children: 'omitted' })] }),
    tree => ({ ...tree, children: [deep(40, 'd')] }),
    tree => ({ schema: 'ssam-reading/1', sourceSha256: '9'.repeat(64), tree }),
  ]) {
    const f = fixture(t); f.resume();
    const read = f.services.lifecycle.readTree;
    f.services.lifecycle.readTree = async (base, selector) => { const tree = await read(base, selector); return selector === '@' + f.keys[0] ? truncate(tree) : tree; };
    await assert.rejects(f.run(), /^Error: debug_o11_native_model_read_incomplete$/);
    assert.equal(fs.existsSync(f.cache()), false);
    assert.equal(fs.existsSync(f.cache() + '.parts'), false);
  }
});

test('the native unimplemented ScreenAction.OutputParameters getter and a matching hash-bound reading are complete', async t => {
  const f = fixture(t); f.resume();
  f.services.lifecycle.readTree = async (base, selector) => selector === '@' + f.keys[0]
    ? { schema: 'ssam-reading/1', sourceSha256: base.sha256.toUpperCase(), tree: { key: f.keys[0], kind: 'ScreenAction', childrenOmitted: 0, childrenTotal: 1,
      propertyErrors: { OutputParameters: 'The method or operation is not implemented.' }, children: [leaf('p')] } }
    : { key: selector.slice(1), kind: 'ServerAction', children: [] };
  const result = await f.run();
  assert.equal(result.readings.length, 2);
});

test('cached checkpoints and complete-graph caches are re-verified: a truncated one is never reused', async t => {
  const f = fixture(t);
  await assert.rejects(f.run(), /interrupted/);
  const parts = fs.readdirSync(f.cache() + '.parts').map(d => path.join(f.cache() + '.parts', d));
  const part = path.join(parts[0], fs.readdirSync(parts[0])[0]);
  const value = JSON.parse(fs.readFileSync(part, 'utf8')); value.tree.childrenOmitted = 1; fs.writeFileSync(part, JSON.stringify(value));
  f.resume();
  const result = await f.run();
  assert.equal(f.calls.filter(k => k === '@' + f.keys[0]).length, 2); // re-read, not trusted
  assert.ok(result.readings.every(r => !r.childrenOmitted));
  const cache = JSON.parse(fs.readFileSync(f.cache(), 'utf8')); cache.readings[1].propertiesOmitted = { Value: true };
  fs.writeFileSync(f.cache(), JSON.stringify(cache));
  const again = await f.run();
  assert.ok(again.readings.every(r => !r.propertiesOmitted));
  assert.ok(JSON.parse(fs.readFileSync(f.cache(), 'utf8')).readings.every(r => !r.propertiesOmitted));
});
