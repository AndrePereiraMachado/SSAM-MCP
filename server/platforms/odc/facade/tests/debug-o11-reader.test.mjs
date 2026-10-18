import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { selectedO11DebugReader } from '../debug-o11-reader.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-debug-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pin = relative => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative);
    return { path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  };
  const runtime = pin('runtime/OutSystems.Model.V1.dll');
  const selection = { schema: 'ssam-o11-debug-reader-selection/1', lane: 'ss4',
    capability: 'native-process-children-and-reference-collections/1', runtimeDir: path.dirname(runtime.path),
    sources: ['KernelModelReader.cs', 'ModelReading.cs'].map(name => pin('kernel/src/Anvil.Core/Kernel/' + name)),
    binaries: ['anvil.dll', 'Anvil.Core.dll', 'anvil.runtimeconfig.json'].map(name => pin('isolated/' + name)) };
  const file = path.join(root, '.local/debugger/o11-reader-selection.json');
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(selection)); };
  const entry = { lane: 'ss4', cli: path.join(root, 'existing/anvil.dll') };
  return { root, entry, selection, save, read: () => selectedO11DebugReader({ root, entry }) };
}

test('isolated reader keeps the operational fallback and selects a separate generation/index only when pinned', t => {
  const f = fixture(t);
  assert.equal(f.read().entry, f.entry);
  f.save(); const result = f.read();
  assert.equal(result.entry.cli, f.selection.binaries[0].path);
  assert.notEqual(result.generation, 'operational');
  assert.equal(result.environment.SSAM_MODULE_INDEX_ROOT, result.indexRoot);
  assert.ok(result.indexRoot.startsWith(path.join(f.root, '.local/debugger/reader-index')));
});

test('changed source or binaries cannot silently fall back to an older projection', t => {
  const f = fixture(t); f.save();
  const source = f.selection.sources[0].path, original = fs.readFileSync(source);
  fs.appendFileSync(source, 'changed');
  assert.throws(f.read, /debug_o11_reader_selection_invalid/);
  fs.writeFileSync(source, original);
  fs.appendFileSync(f.selection.binaries[1].path, 'changed');
  assert.throws(f.read, /debug_o11_reader_selection_invalid/);
});

test('cross-lane selections and unpinned dependencies are refused', t => {
  const f = fixture(t); f.selection.lane = 'ss5'; f.save();
  assert.throws(f.read, /debug_o11_reader_selection_invalid/);
  f.selection.lane = 'ss4'; f.save();
  fs.writeFileSync(path.join(path.dirname(f.selection.binaries[0].path), 'unqualified.dll'), 'not in build');
  assert.throws(f.read, /debug_o11_reader_selection_invalid/);
});

test('runtime changes invalidate model and index generations even with identical selection and file metadata', t => {
  const f = fixture(t); f.save();
  const runtime = path.join(f.selection.runtimeDir, 'OutSystems.Model.V1.dll');
  const stableTime = new Date('2020-01-01T00:00:00.000Z'); fs.utimesSync(runtime, stableTime, stableTime);
  const before = f.read();
  assert.equal(f.read().generation, before.generation);
  const stat = fs.statSync(runtime), bytes = fs.readFileSync(runtime);
  bytes[0] ^= 1; fs.writeFileSync(runtime, bytes); fs.utimesSync(runtime, stat.atime, stat.mtime);
  assert.equal(fs.statSync(runtime).size, stat.size); assert.equal(fs.statSync(runtime).mtimeMs, stat.mtimeMs);
  const after = f.read();
  assert.notEqual(after.generation, before.generation);
  assert.notEqual(after.indexRoot, before.indexRoot);
  assert.equal(after.environment.SSAM_MODULE_INDEX_ROOT, after.indexRoot);
  assert.equal(after.entry.cli, before.entry.cli);
});
