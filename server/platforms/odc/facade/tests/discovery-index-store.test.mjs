// S11: the store of the persisted discover index (discovery-index-store.mjs): identity-checked reads, atomic writes under
// .local only, one build in flight per index, and a cancel that stops a build only when every caller waiting for it left.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storeFile, readStored, writeStored, writableDir, shared, inFlightCount } from '../discovery-index-store.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-index-store-'));
const SCHEMA = 'ssam-discovery-index/3';

test('a stored piece is served only with its own identity and schema; anything else is rebuilt with a note', () => {
  const dir = temp();
  try {
    const file = storeFile(dir, 'index', 'abc');
    assert.equal(path.basename(file), 'index-abc.json');
    assert.deepEqual(readStored(file, { key: 'abc', schema: SCHEMA }), { value: null });
    assert.deepEqual(writeStored(file, JSON.stringify({ schemaVersion: SCHEMA, key: 'abc', n: 1 })), { written: true });
    assert.deepEqual(readStored(file, { key: 'abc', schema: SCHEMA }).value, { schemaVersion: SCHEMA, key: 'abc', n: 1 });
    const other = readStored(file, { key: 'def', schema: SCHEMA });
    assert.equal(other.value, null); assert.match(other.note, /holds identity abc, not def: rebuilt/);
    const schema = readStored(file, { key: 'abc', schema: 'ssam-discovery-index/4' });
    assert.equal(schema.value, null); assert.match(schema.note, /schema ssam-discovery-index\/3, not ssam-discovery-index\/4/);
    fs.writeFileSync(file, '{"schemaVersion":"ssam-discovery-index/3","key":"abc","n":');
    const torn = readStored(file, { key: 'abc', schema: SCHEMA });
    assert.equal(torn.value, null); assert.match(torn.note, /not JSON \(torn or corrupted\): rebuilt/);
    fs.writeFileSync(file, 'null');
    assert.match(readStored(file, { key: 'abc', schema: SCHEMA }).note, /not an object/);
    // No temporary file is left beside the pieces.
    assert.deepEqual(fs.readdirSync(dir), ['index-abc.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the store writes only under a .local folder or the system temporary folder', () => {
  const tmp = temp();
  try {
    assert.equal(writableDir(path.join('C:', 'repo', 'platforms', 'odc', '.local', 'discovery', 'odc'), { tmp }), true);
    assert.equal(writableDir(path.join(tmp, 'cache'), { tmp }), true);
    assert.equal(writableDir(path.join('C:', 'repo', 'platforms', 'odc', 'facade', 'catalog'), { tmp }), false);
    assert.equal(writableDir(path.join('C:', 'repo', '.localized', 'x'), { tmp }), false);
    assert.equal(writableDir('', { tmp }), false);
    // A folder outside both is never written: the build goes on without the file.
    const outside = path.join(tmp, '..', 'ssam-index-store-never-' + process.pid);
    const refused = writeStored(path.join(outside, 'index-k.json'), '{}', { tmp });
    assert.equal(refused.written, false); assert.match(refused.note, /outside \.local/);
    assert.equal(fs.existsSync(outside), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('one build per id: a second caller joins the build in flight instead of starting another', async () => {
  let runs = 0; let release;
  const produce = () => { runs++; return new Promise(resolve => { release = resolve; }); };
  const a = shared('same', produce); const b = shared('same', produce);
  assert.equal(a.joined, false); assert.equal(b.joined, true); assert.equal(inFlightCount(), 1);
  await new Promise(r => setImmediate(r));
  release('built');
  assert.deepEqual(await Promise.all([a.promise, b.promise]), ['built', 'built']);
  assert.equal(runs, 1); assert.equal(inFlightCount(), 0);
  // Once finished, the next call builds again (a later call reads the file, not the promise).
  const c = shared('same', async () => { runs++; return 'again'; });
  assert.equal(c.joined, false); assert.equal(await c.promise, 'again'); assert.equal(runs, 2);
});

test('a cancelled warm-up stops its build only when nobody else waits for it', async () => {
  // The warm-up alone: cancelling it aborts the build's own signal and it stops waiting.
  {
    const warm = new AbortController(); let seen = null;
    const run = shared('alone', signal => new Promise((resolve, reject) => { seen = signal; signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); }), { signal: warm.signal });
    await new Promise(r => setImmediate(r));
    warm.abort(new Error('server closing'));
    await assert.rejects(run.promise, /server closing/);
    assert.equal(seen.aborted, true);
  }
  // A discover joined it: the warm-up leaves, the build goes on and the discover gets the index.
  {
    const warm = new AbortController(); let seen = null; let release;
    const produce = signal => { seen = signal; return new Promise(resolve => { release = resolve; }); };
    const first = shared('joined', produce, { signal: warm.signal });
    const discover = shared('joined', produce);
    await new Promise(r => setImmediate(r));
    warm.abort(new Error('server closing'));
    await assert.rejects(first.promise, /server closing/);
    assert.equal(seen.aborted, false, 'the build must not stop while a discover waits for it');
    release('index');
    assert.equal(await discover.promise, 'index');
  }
  // A failed build every caller left never surfaces as an unhandled rejection.
  {
    const warm = new AbortController();
    const run = shared('failing', () => new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 20)), { signal: warm.signal });
    warm.abort(new Error('gone'));
    await assert.rejects(run.promise, /gone/);
    await new Promise(r => setTimeout(r, 50));
  }
});
