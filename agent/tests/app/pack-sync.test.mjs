// pack-sync: a bundled pack synced into a root is the same as extracting the ZIP over it (files copied by sha256,
// stale files of the previous pack removed, data folders untouched, pack.json last), and verifyPack sees a changed or
// missing file as the agent's doctor does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { planSync, applySync, syncPack, verifyPack, readPackJson, DATA_FOLDERS, safeRelative } from '../../src/main/core/pack-sync.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const fresh = name => fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-app-' + name + '-'));
const remove = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

// A pack folder with pack.json over `files` ({rel: text}).
export function makePack(dir, id, files, extra = {}) {
  const list = [];
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    list.push({ path: rel, sha256: sha(text), size: Buffer.byteLength(text) });
  }
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, lanes: ['odc'], odcBridge: 'v97', o11BuiltFor: null, ...extra, files: list }, null, 2));
  return dir;
}

test('a fresh root gets every file of the pack and pack.json; a second sync does nothing', () => {
  const pack = makePack(fresh('pack'), 'pack-1', { 'agent/ssam-agent.mjs': 'a', 'agent/lib/agent.mjs': 'b', 'odc/README.md': 'root marker', 'agent/ssam-agent.sh': '#!/bin/sh' });
  const root = path.join(fresh('root'), 'SSAM-Agent');
  try {
    const plan = planSync(pack, root);
    assert.equal(plan.upToDate, false);
    assert.deepEqual(plan.copy.sort(), ['agent/lib/agent.mjs', 'agent/ssam-agent.mjs', 'agent/ssam-agent.sh', 'odc/README.md']);
    assert.deepEqual(plan.remove, []);
    const result = applySync(plan, pack, root, { platform: 'linux' });
    assert.equal(result.copied.length, 4);
    assert.deepEqual(result.failed, []);
    assert.equal(fs.readFileSync(path.join(root, 'odc', 'README.md'), 'utf8'), 'root marker');
    assert.equal(readPackJson(root).id, 'pack-1');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'agent', 'ssam-agent.sh')).mode & 0o777, 0o755);
    assert.equal(verifyPack(root).ok, true);
    const again = syncPack(pack, root);
    assert.equal(again.synced, false);
    assert.equal(again.pack, 'pack-1');
  } finally { remove(pack); remove(path.dirname(root)); }
});

test('a new pack replaces changed files, removes the files that went away, keeps data folders and a file the person added', () => {
  const pack1 = makePack(fresh('pack1'), 'pack-1', { 'agent/ssam-agent.mjs': 'v1', 'agent/lib/old.mjs': 'old', 'odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v96.dll': 'dll96' });
  const pack2 = makePack(fresh('pack2'), 'pack-2', { 'agent/ssam-agent.mjs': 'v2', 'agent/lib/new.mjs': 'new', 'odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v97.dll': 'dll97' });
  const root = path.join(fresh('root'), 'SSAM-Agent');
  try {
    syncPack(pack1, root);
    for (const folder of DATA_FOLDERS) fs.mkdirSync(path.join(root, ...folder.split('/')), { recursive: true });
    fs.writeFileSync(path.join(root, 'private', 'credential'), 'secret');
    fs.writeFileSync(path.join(root, 'inbox', 'Quotes.oml'), 'oml');
    fs.writeFileSync(path.join(root, 'odc', 'snapshots', 'x.json'), '{}');
    fs.writeFileSync(path.join(root, 'agent', 'notes.txt'), 'mine');
    const plan = planSync(pack2, root);
    assert.deepEqual(plan.copy.sort(), ['agent/lib/new.mjs', 'agent/ssam-agent.mjs', 'odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v97.dll']);
    assert.deepEqual(plan.remove.sort(), ['agent/lib/old.mjs', 'odc/studio/bridge/bin/Release/net8.0/ODC3.Bridge.v96.dll']);
    const result = applySync(plan, pack2, root);
    assert.deepEqual(result.failed, []);
    assert.equal(fs.readFileSync(path.join(root, 'agent', 'ssam-agent.mjs'), 'utf8'), 'v2');
    assert.equal(fs.existsSync(path.join(root, 'agent', 'lib', 'old.mjs')), false);
    assert.equal(fs.existsSync(path.join(root, 'odc', 'studio', 'bridge', 'bin', 'Release', 'net8.0', 'ODC3.Bridge.v96.dll')), false);
    assert.equal(fs.readFileSync(path.join(root, 'private', 'credential'), 'utf8'), 'secret');
    assert.equal(fs.readFileSync(path.join(root, 'inbox', 'Quotes.oml'), 'utf8'), 'oml');
    assert.equal(fs.readFileSync(path.join(root, 'odc', 'snapshots', 'x.json'), 'utf8'), '{}');
    assert.equal(fs.readFileSync(path.join(root, 'agent', 'notes.txt'), 'utf8'), 'mine');
    assert.equal(readPackJson(root).id, 'pack-2');
    assert.equal(verifyPack(root).ok, true);
    // The same pack id with a file changed in the root (a damaged file): the file is copied again.
    fs.writeFileSync(path.join(root, 'agent', 'ssam-agent.mjs'), 'damaged');
    assert.equal(verifyPack(root).ok, false);
    assert.match(verifyPack(root).detail, /agent\/ssam-agent\.mjs \(changed\)/);
    const repair = syncPack(pack2, root);
    assert.equal(repair.synced, true);
    assert.deepEqual(repair.copied, ['agent/ssam-agent.mjs']);
    assert.equal(verifyPack(root).ok, true);
  } finally { remove(pack1); remove(pack2); remove(path.dirname(root)); }
});

test('a bundled pack that names a data folder, an absolute path or a .. segment is refused before anything is written', () => {
  const root = path.join(fresh('root'), 'SSAM-Agent');
  const bad = [];
  try {
    for (const rel of ['private/credential', 'inbox/x', '../escape', 'C:/x', '/x', 'agent//x']) {
      const pack = makePack(fresh('bad'), 'pack-bad', { 'agent/ok.mjs': 'ok' });
      bad.push(pack);
      const json = readPackJson(pack); json.files.push({ path: rel, sha256: sha('x'), size: 1 }); fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify(json));
      assert.throws(() => planSync(pack, root), /refuses/, rel);
      assert.equal(fs.existsSync(root), false);
    }
    assert.equal(safeRelative('agent/x.mjs'), true);
    assert.equal(safeRelative('agent/./x'), false);
    assert.equal(verifyPack(fresh('empty')).ok, false);
  } finally { for (const dir of bad) remove(dir); remove(path.dirname(root)); }
});
