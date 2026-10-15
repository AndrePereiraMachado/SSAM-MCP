// A prototype given as a .zip (docs/PROTOTIPO-NATIVO.md 1.2, prototype/archive.mjs): extracted once and safely into
// <lane .local>/prototype/sources/<sha256>, resolved as a folder (its single top-level folder when it has one), recorded in
// the IR as source.archive {path, sha256} (the path outside the hash), and refused whole when an entry would leave the folder.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { resolveSource, expandPrototypeOps, captureCurrent, canonicalSha256, inferPrefix } from '../prototype-op.mjs';
import { readArchive, extractArchive, unsafeName, allowedSource, ARCHIVE_MARKER } from '../prototype/archive.mjs';
import { irHash } from '../prototype/ir.mjs';

function tmp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-zip-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

// A zip writer for the tests: entries [{name, data?, method?, mode?, external?}] (stored or deflate, UTF-8 names).
function zip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.method ?? (entry.name.endsWith('/') ? 0 : 8);
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x5b4c, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(((entry.unix ? 3 : 0) << 8) | 20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x800, 8); head.writeUInt16LE(method, 10);
    head.writeUInt16LE(0, 12); head.writeUInt16LE(0x5b4c, 14); head.writeUInt32LE(crc, 16); head.writeUInt32LE(body.length, 20); head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28); head.writeUInt16LE(0, 30); head.writeUInt16LE(0, 32); head.writeUInt16LE(0, 34); head.writeUInt16LE(0, 36);
    head.writeUInt32LE(entry.external ?? 0, 38); head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += 30 + name.length + body.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
const PAGE = '<!doctype html><html><head><title>Folha de Ponto · V1</title></head><body><main>oi</main></body></html>';

test('zip: an .html at the root of the archive is the entry; the archive is extracted once into sources/<sha256> and named in the answer', t => {
  const dir = tmp(t); const file = path.join(dir, 'Folha de ponto.zip'); const sources = path.join(dir, 'local', 'prototype', 'sources');
  fs.writeFileSync(file, zip([{ name: 'Folha de Ponto.html', data: PAGE }, { name: 'app.jsx', data: 'const x = 1;' }, { name: 'img/', data: '' }, { name: 'img/a.svg', data: '<svg/>' }]));
  const first = resolveSource({ source: file }, { sourcesDir: sources });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.entry, 'Folha de Ponto.html');
  assert.equal(path.dirname(first.root), sources);
  assert.equal(first.archive.path, file);
  assert.equal(first.archive.sha256, path.basename(first.root));
  assert.equal(fs.readFileSync(path.join(first.root, 'img', 'a.svg'), 'utf8'), '<svg/>');
  assert.ok(fs.existsSync(path.join(first.root, ARCHIVE_MARKER)));
  // the second resolution reuses the folder (extracted once)
  const before = fs.statSync(path.join(first.root, 'app.jsx')).mtimeMs;
  const again = extractArchive(file, { sourcesDir: sources });
  assert.equal(again.reused, true); assert.equal(fs.statSync(path.join(first.root, 'app.jsx')).mtimeMs, before);
  // the entry time is the archive's (the capture clock never depends on when it was extracted)
  assert.equal(new Date(before).getUTCFullYear(), 2025);
  // the prefix comes from the title (the middle dot is a separator)
  assert.deepEqual(inferPrefix({ source: file }, first), { prefix: 'FolhaDePonto', from: 'title' });
});

test('zip: a single top-level folder is the root; the entry rules are the folder\'s', t => {
  const dir = tmp(t); const file = path.join(dir, 'proto.zip'); const sources = path.join(dir, 'sources');
  fs.writeFileSync(file, zip([{ name: 'farma/', data: '' }, { name: 'farma/index.html', data: PAGE }, { name: 'farma/app.js', data: '1' }]));
  const resolved = resolveSource({ source: file }, { sourcesDir: sources });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(path.basename(resolved.root), 'farma');
  assert.equal(resolved.entry, 'index.html');
});

test('zip: an entry outside the folder (zip-slip), an absolute path or a link refuses the whole archive; nothing is extracted', t => {
  const dir = tmp(t); const sources = path.join(dir, 'sources');
  const cases = [
    ['slip.zip', [{ name: 'index.html', data: PAGE }, { name: '../evil.txt', data: 'x' }], /"\.\." segment/],
    ['deep.zip', [{ name: 'index.html', data: PAGE }, { name: 'a/../../evil.txt', data: 'x' }], /"\.\." segment/],
    ['abs.zip', [{ name: 'index.html', data: PAGE }, { name: '/etc/evil.txt', data: 'x' }], /absolute path/],
    ['drive.zip', [{ name: 'index.html', data: PAGE }, { name: 'C:/evil.txt', data: 'x' }], /absolute path/],
    ['back.zip', [{ name: 'index.html', data: PAGE }, { name: '..\\evil.txt', data: 'x' }], /backslash/],
    ['ads.zip', [{ name: 'index.html', data: PAGE }, { name: 'a.txt:secret', data: 'x' }], /alternate data stream/],
    ['link.zip', [{ name: 'index.html', data: PAGE }, { name: 'up', data: '../../', unix: true, external: (0o120777 << 16) >>> 0 }], /is a link/],
  ];
  for (const [name, entries, why] of cases) {
    const file = path.join(dir, name); fs.writeFileSync(file, zip(entries));
    const resolved = resolveSource({ source: file }, { sourcesDir: sources });
    assert.equal(resolved.ok, false, name);
    assert.equal(resolved.problem.code, 'PROTOTYPE_SOURCE_INVALID', name);
    assert.match(resolved.problem.message, why, name);
    assert.match(resolved.problem.message, /nothing was extracted/, name);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')) && !fs.existsSync(path.join(dir, '..', 'evil.txt')));
  assert.deepEqual(fs.existsSync(sources) ? fs.readdirSync(sources) : [], [], 'no folder was left behind');
  assert.equal(unsafeName('ok/dir/file.js'), null);
});

test('zip: caps on entries and bytes, a declared size the data does not match, a damaged CRC; never half written', t => {
  const dir = tmp(t); const sources = path.join(dir, 'sources');
  const many = path.join(dir, 'many.zip'); fs.writeFileSync(many, zip([{ name: 'index.html', data: PAGE }, { name: 'a.js', data: 'a' }, { name: 'b.js', data: 'b' }]));
  const capped = readArchive(many, { limits: { entries: 2, fileBytes: 1e6, totalBytes: 1e6, archiveBytes: 1e6 } });
  assert.equal(capped.ok, false); assert.match(capped.problems[0].message, /3 entries; the limit is 2/);
  const big = readArchive(many, { limits: { entries: 10, fileBytes: 10, totalBytes: 1e6, archiveBytes: 1e6 } });
  assert.equal(big.ok, false); assert.match(big.problems.map(p => p.message).join(), /index\.html has \d+ bytes; the limit per file is 10/);
  const bomb = zip([{ name: 'index.html', data: PAGE }]);
  // the central directory says 5 bytes; the data inflates to more: refused, nothing extracted
  const at = bomb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(5, at + 24);
  const lying = path.join(dir, 'lying.zip'); fs.writeFileSync(lying, bomb);
  const refused = extractArchive(lying, { sourcesDir: sources });
  assert.equal(refused.ok, false); assert.match(refused.problems[0].message, /declared 5 bytes/);
  const crc = zip([{ name: 'index.html', data: PAGE }]);
  crc.writeUInt32LE(1, crc.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16);
  const damaged = path.join(dir, 'crc.zip'); fs.writeFileSync(damaged, crc);
  const bad = extractArchive(damaged, { sourcesDir: sources });
  assert.equal(bad.ok, false); assert.match(bad.problems[0].message, /CRC/);
  assert.deepEqual(fs.readdirSync(sources), [], 'a refused archive leaves no folder');
  const notZip = path.join(dir, 'x.zip'); fs.writeFileSync(notZip, 'hello world, not a zip at all, sorry');
  assert.equal(resolveSource({ source: notZip }, { sourcesDir: sources }).ok, false);
});

test('zip: two .html pages and no index.html give the entry patch, verified against the extracted folder', t => {
  const dir = tmp(t); const file = path.join(dir, 'two.zip'); const sources = path.join(dir, 'sources');
  fs.writeFileSync(file, zip([{ name: 'v1.html', data: PAGE }, { name: 'v2.html', data: PAGE }]));
  const resolved = resolveSource({ source: file }, { sourcesDir: sources });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.problem.at, '/entry');
  assert.deepEqual(resolved.problem.patch, [{ op: 'add', path: '/entry', value: 'v1.html' }]);
  assert.deepEqual(resolved.problem.alternatives, ['v2.html']);
  const patched = resolveSource({ source: file, entry: 'v1.html' }, { sourcesDir: sources });
  assert.equal(patched.ok, true); assert.equal(patched.entry, 'v1.html'); assert.equal(patched.archive.path, file);
});

test('zip: the expansion extracts into <work>/../sources, the capture gets the archive, and a changed zip is captured again', async t => {
  const dir = tmp(t); const file = path.join(dir, 'p.zip'); fs.writeFileSync(file, zip([{ name: 'index.html', data: PAGE }]));
  const local = path.join(dir, 'local');
  const calls = [];
  const capture = async args => {
    calls.push(args);
    fs.mkdirSync(args.out, { recursive: true });
    const ir = { schema: 'ssam-prototype-capture/1', source: { root: args.source, entry: args.entry, files: [{ path: 'index.html', sha256: 'x' }], ...(args.archive ? { archive: args.archive } : {}) }, views: [], stats: { views: 0 } };
    const capturePath = path.join(args.out, 'capture.json'); fs.writeFileSync(capturePath, JSON.stringify(ir));
    return { ok: true, capturePath, sha256: canonicalSha256(ir), summary: {} };
  };
  const expanded = await expandPrototypeOps({ ops: [{ op: 'prototype', data: { source: file } }] }, { work: path.join(local, 'prototype', 'w1'), capture });
  assert.equal(expanded.refusal, undefined, JSON.stringify(expanded.refusal));
  assert.equal(calls[0].archive.path, file);
  assert.equal(path.dirname(calls[0].source), path.join(local, 'prototype', 'sources'));
  assert.deepEqual(expanded.captures[0].archive, calls[0].archive);
  const ir = JSON.parse(fs.readFileSync(expanded.job.ops[0].data.capture, 'utf8'));
  // the archive path is outside the hash, as the root is: the same zip elsewhere has the same capture hash
  const moved = structuredClone(ir); moved.source.archive.path = 'D:\\elsewhere\\p.zip'; moved.source.root = 'D:\\x';
  assert.equal(canonicalSha256(moved), canonicalSha256(ir)); assert.equal(irHash(moved), irHash(ir));
  const data = expanded.job.ops[0].data;
  // the same archive: current; a changed archive (another sha256): captured again
  const same = await captureCurrent({ ...data, captureSha256: canonicalSha256(ir) }, calls[0].source, { archive: calls[0].archive });
  assert.equal(same.why, 'the prototype file index.html changed', 'the fake IR lists a fake sha: past the archive check');
  const changed = await captureCurrent({ ...data, captureSha256: canonicalSha256(ir) }, calls[0].source, { archive: { path: file, sha256: 'f'.repeat(64) } });
  assert.equal(changed.current, false); assert.match(changed.why, /the archive p\.zip changed/);
  const folder = await captureCurrent({ ...data, captureSha256: canonicalSha256(ir) }, calls[0].source, { archive: null });
  assert.match(folder.why, /the capture is of an archive/);
});

test('zip: hosted mode reads the source only from the agent folders (agent:inbox/<name>)', t => {
  const dir = tmp(t); const agentRoot = path.join(dir, 'agent'); fs.mkdirSync(path.join(agentRoot, 'inbox'), { recursive: true });
  const file = path.join(agentRoot, 'inbox', 'p.zip'); fs.writeFileSync(file, zip([{ name: 'index.html', data: PAGE }]));
  assert.equal(allowedSource('agent:inbox/p.zip', { agentRoot }).path, path.win32.join(agentRoot, 'inbox', 'p.zip'));
  const ok = resolveSource({ source: 'agent:inbox/p.zip' }, { agentRoot, sourcesDir: path.join(dir, 'sources') });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const outside = path.join(dir, 'Downloads', 'p.zip'); fs.mkdirSync(path.dirname(outside)); fs.copyFileSync(file, outside);
  const refused = resolveSource({ source: outside }, { agentRoot, sourcesDir: path.join(dir, 'sources') });
  assert.equal(refused.ok, false); assert.match(refused.problem.message, /only from the folders of the agent/); assert.match(refused.problem.fix, /agent:inbox/);
  // locally (no agent root) any absolute path is read
  assert.equal(resolveSource({ source: outside }, { sourcesDir: path.join(dir, 'sources') }).ok, true);
});
