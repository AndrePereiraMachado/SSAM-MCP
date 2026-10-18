// Atritos 3, lane fa, C15: the capture of an unchanged module keeps its identity. The ODC Studio writes Studio state into
// the OML header (the nodes its eSpace tree shows and a 20-byte field, record 15), so two captures of the same module
// differ there and nowhere else; contentSha256 masks those two fields (contract I1), and ssam_map reads a capture through
// the first intact capture of the same content, so its module index and its keys serve again. Synthetic headers only (the
// shape of the friend's captures, no customer bytes).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { contentSha256, canonicalCapture, volatileRanges, CONTENT_RULE } from '../oml-content-sha.mjs';
import { moduleMap, indexFile } from '../module-map.mjs';
import { writeIndex } from './fixtures/module-index.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const KEY = 'K'.repeat(22);
// The header of an ODC capture: "OML", a 32-bit little-endian length and that many printable bytes of records separated by
// '|'; record 10 holds the tree state, record 15 the 28-character base64 field; the binary model follows.
function oml({ nodes = ['N'.repeat(22)], state = 'S'.repeat(27) + '=', body = 'compressed model bytes', tree = true, description = 'Some_Thing_Here' } = {}) {
  const records = ['11.0.000.000', '11.1234.5.67890', '123', KEY, KEY, 'Text', description, '', '2026-10-06 21:51:27', KEY,
    tree ? '/ShownNodes.' + KEY + '/NodesShownInESpaceTree.' + nodes.join('.') : '/Selected.' + KEY,
    'Q'.repeat(300), KEY, '12', 'abcde', state, '12', 'x', 'y'];
  const header = Buffer.from(records.join('|'), 'utf8');
  const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
  return Buffer.concat([Buffer.from('OML', 'latin1'), length, header, Buffer.from([0x01, 0x8f, 0x00]), Buffer.from(body, 'latin1')]);
}
test('C15, I1: two captures that differ only in the volatile header fields have the same contentSha256; a body byte changes it', () => {
  const a = oml(), b = oml({ nodes: ['M'.repeat(22), 'P'.repeat(22)], state: 'T'.repeat(27) + '=' });
  assert.notEqual(sha(a), sha(b));
  const ca = contentSha256(a), cb = contentSha256(b);
  assert.equal(ca.rule, CONTENT_RULE); assert.equal(cb.rule, CONTENT_RULE);
  assert.equal(ca.rawSha256, sha(a));
  assert.equal(ca.sha256, cb.sha256, 'same model, other Studio state');
  assert.notEqual(contentSha256(oml({ body: 'compressed model bytez' })).sha256, ca.sha256, 'one byte of the body');
  assert.notEqual(contentSha256(oml({ tree: false })).sha256, ca.sha256, 'another header record is content');
  // The tree record may be absent: the 20-byte field is still masked.
  assert.equal(contentSha256(oml({ tree: false })).sha256, contentSha256(oml({ tree: false, state: 'U'.repeat(27) + '=' })).sha256);
  // Each field by its place in the records, never by offset; the length field (bytes 3-6) follows the header and is left out.
  assert.deepEqual(volatileRanges(a)[0], [3, 7]); assert.equal(volatileRanges(a).length, 3);
});

// The battery of 2026-10-08: the header is UTF-8 text (the module description, "Aplicação ..." in the friend's later
// modules); 29 of 86 real captures fell to the raw rule while a byte above 126 ended the header.
test('C15, I1: a header with UTF-8 text (an accented description) keeps the content rule', () => {
  const a = oml({ description: 'Aplicação de exames' }), b = oml({ description: 'Aplicação de exames', nodes: ['M'.repeat(22)], state: 'T'.repeat(27) + '=' });
  assert.notEqual(sha(a), sha(b));
  assert.equal(contentSha256(a).rule, CONTENT_RULE);
  assert.equal(contentSha256(a).sha256, contentSha256(b).sha256);
  assert.notEqual(contentSha256(oml({ description: 'Aplicação de exame' })).sha256, contentSha256(a).sha256, 'the description is content');
});

test('C15, I1: a header that is not the expected one is the raw rule (never an exception)', () => {
  const unprintable = oml(); unprintable[20] = 0x01;
  const notUtf8 = oml(); notUtf8[20] = 0xff;
  for (const bytes of [Buffer.from('not an oml at all'), oml({ state: 'short' }), oml({ nodes: ['bad chars!'] }), Buffer.from('OML\\' + 'a|'.repeat(5) + 'b'), unprintable, notUtf8]) {
    const value = contentSha256(bytes);
    assert.equal(value.rule, 'raw'); assert.equal(value.sha256, value.rawSha256); assert.equal(value.rawSha256, sha(bytes));
  }
});

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa3-content-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'store');
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  const write = (name, bytes) => { const file = path.join(dir, name); fs.writeFileSync(file, bytes); return { file, sha256: sha(bytes) }; };
  return { dir, store, env, write };
}
const noReader = async () => { throw new Error('the reader must not be called: the index of the same content serves'); };

test('C15: two captures of the same content serve one module index; keys and expectedSourceSha256 keep working', async t => {
  const c = setup(t);
  const first = c.write('Shop-1.oml', oml());
  writeIndex(c.store, 'odc', first.sha256);
  const one = await moduleMap({ lane: 'odc', target: first.file }, { env: c.env, read: noReader, prepare: noReader });
  assert.equal(one.ok, true, one.error); assert.equal(one.capture, undefined);
  const second = c.write('Shop-2.oml', oml({ nodes: ['Z'.repeat(22)], state: 'W'.repeat(27) + '=' }));
  assert.notEqual(second.sha256, first.sha256);
  const two = await moduleMap({ lane: 'odc', target: second.file }, { env: c.env, read: noReader, prepare: noReader });
  assert.equal(two.ok, true, two.error);
  assert.equal(two.cache.index, 'hit', 'one index for both captures');
  assert.equal(two.file, first.file); assert.equal(two.sourceSha256, first.sha256);
  assert.equal(two.contentSha256, one.contentSha256);
  assert.deepEqual([two.capture.file, two.capture.reused], [second.file, true]);
  assert.equal(two.continuations.inspect.arguments.target, first.file, 'the keys belong to the capture that answers');
  assert.equal(fs.readdirSync(path.dirname(indexFile('odc', first.sha256, c.env))).filter(n => n.endsWith('.json')).length, 1);
  // expectedSourceSha256: the raw sha of either capture or the content sha.
  for (const expected of [first.sha256, second.sha256, one.contentSha256])
    assert.equal((await moduleMap({ lane: 'odc', target: second.file, expectedSourceSha256: expected }, { env: c.env, read: noReader })).ok, true, expected);
  assert.match((await moduleMap({ lane: 'odc', target: second.file, expectedSourceSha256: 'f'.repeat(64) }, { env: c.env, read: noReader })).error, /content changed/);
});

test('C15: a canonical capture that changed on disk is not reused; a capture of other content is its own', async t => {
  const c = setup(t);
  const dir = path.join(c.dir, 'registry');
  const first = c.write('A-1.oml', oml());
  assert.equal(canonicalCapture({ file: first.file, module: 'A', dir }).reused, false);
  const second = c.write('A-2.oml', oml({ state: 'V'.repeat(27) + '=' }));
  const reused = canonicalCapture({ file: second.file, module: 'A', dir });
  assert.deepEqual([reused.reused, reused.file, reused.rawSha256], [true, first.file, first.sha256]);
  // Another module name never shares a capture.
  assert.equal(canonicalCapture({ file: second.file, module: 'B', dir }).reused, false);
  // The first capture touched: not intact, so the next capture answers for itself and becomes canonical.
  const later = new Date(Date.now() + 5000); fs.utimesSync(first.file, later, later);
  const third = c.write('A-3.oml', oml({ state: 'X'.repeat(27) + '=' }));
  const own = canonicalCapture({ file: third.file, module: 'A', dir });
  assert.deepEqual([own.reused, own.file], [false, third.file]);
  assert.equal(canonicalCapture({ file: c.write('A-4.oml', oml({ body: 'other model' })).file, module: 'A', dir }).reused, false);
});
