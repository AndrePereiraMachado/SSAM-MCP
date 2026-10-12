// Contract tests of ssam-quality/1 (C:\t\qual\DESIGN-QUALIDADE.md section 2), shared by both lanes:
//   node --test C:\t\qual\fixtures\quality-line.test.mjs
// SERVER copies it to platforms/odc/facade/tests/quality-line.test.mjs, CONSOLE to server/deploy/console/tests/quality-line.test.mjs,
// each with FIXTURES pointing at its own copy of this folder (tests/fixtures/quality/).
// Server lane copy: the module is ../quality-line.mjs, the fixtures tests/fixtures/quality/; the last test is the parity check (D9).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sanitizeQualityLine, fitLine, loadNativeIds, codeOf, MAX_LINE_BYTES, NATIVE_UNLISTED } from '../quality-line.mjs';

const FIXTURES = process.env.QUALITY_FIXTURES ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'quality');
const native = loadNativeIds(path.join(FIXTURES, 'catalog'), { readDir: fs.readdirSync, readFile: fs.readFileSync, join: path.join });
const lines = text => text.split('\n').filter(Boolean);

test('the fixture day is exactly the contract: sanitizing changes nothing, every line fits', () => {
  for (const raw of lines(fs.readFileSync(path.join(FIXTURES, 'server-dir', 'quality-20261012.jsonl'), 'utf8'))) {
    assert.ok(Buffer.byteLength(raw) + 1 <= MAX_LINE_BYTES);
    const value = JSON.parse(raw);
    assert.deepEqual(sanitizeQualityLine(value, { nativeIds: native }), value);
    assert.equal(fitLine(value), raw);
  }
  const gz = zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, 'server-dir', 'quality-20261011.jsonl.gz'))).toString('utf8');
  for (const raw of lines(gz)) assert.deepEqual(sanitizeQualityLine(JSON.parse(raw), { nativeIds: native }), JSON.parse(raw));
});

test('hostile lines: content never passes, frames that do not hold are dropped', () => {
  const input = lines(fs.readFileSync(path.join(FIXTURES, 'server-dir', 'quality-20261013.jsonl'), 'utf8'));
  const expected = lines(fs.readFileSync(path.join(FIXTURES, 'hostile-expected.jsonl'), 'utf8')).map(l => JSON.parse(l));
  assert.equal(input.length, expected.length);
  input.forEach((raw, i) => {
    // The reader's order: a raw line above the cap is skipped before any parse; text that is not JSON is skipped.
    let got = null;
    if (Buffer.byteLength(raw) + 1 <= MAX_LINE_BYTES) { try { got = sanitizeQualityLine(JSON.parse(raw), { nativeIds: native }); } catch { got = null; } }
    assert.deepEqual(got, expected[i], 'line ' + (i + 1));
  });
  const text = JSON.stringify(expected);
  for (const leak of ['Batidas', 'GetColaboradorAtual', 'joao', 'Abrir', 'passwd', 'texto do cliente', 'Snapshot Module', '__proto__', 'constructor'])
    assert.ok(!text.includes(leak), 'leaked: ' + leak);
});

test('native ids: only the catalog keeps a CamelCase code; no catalog fails closed', () => {
  assert.equal(codeOf('ExpressionUnknownObject', { nativeIds: native }), 'ExpressionUnknownObject');
  assert.equal(codeOf('GetColaboradorAtual', { nativeIds: native }), NATIVE_UNLISTED);
  assert.equal(codeOf('ExpressionUnknownObject'), NATIVE_UNLISTED);
  assert.equal(codeOf('PREFLIGHT_REFUSED'), 'PREFLIGHT_REFUSED');
  for (const bad of ['a', 'preflight', 'X'.repeat(65), 'A.B', 'FOO BAR', '_X', 'Foo.Bar']) assert.equal(codeOf(bad, { nativeIds: native }), null, bad);
});

test('fitLine: a line above the cap loses detail in the fixed order and keeps its frame', () => {
  const big = { schema: 'ssam-quality/1', kind: 'call', time: '2026-10-12T18:00:00.000Z', token: 'tok_0000000a1fa0', session: 'abcdef012345', call: 1,
    tool: 'o11_deliver', op: null, lane: 'o11', ms: 1, gapMs: null, inFlight: 0, ok: false, code: 'PREFLIGHT_REFUSED', class: 'refused', step: 'preflight', deliv: null,
    problems: { n: 999, err: 999, warn: 0, byCode: Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['A_VERY_LONG_PROBLEM_CODE_NAME_NUMBER_' + String(i).padStart(4, '0') + '_' + 'X'.repeat(20), 32 - i])),
      withPatch: Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['A_VERY_LONG_PROBLEM_CODE_NAME_NUMBER_' + String(i).padStart(4, '0') + '_' + 'X'.repeat(20), 1])), cut: false },
    agent: { n: 1, failed: 0, shared: false, top: [['file.get', 1, 1]] } };
  const text = fitLine(big);
  assert.ok(Buffer.byteLength(text) + 1 <= MAX_LINE_BYTES);
  const back = JSON.parse(text);
  assert.equal(back.trunc, true);
  assert.equal(back.agent.top, undefined);
  assert.equal(Object.keys(back.problems.byCode).length, 8);
  assert.ok(back.problems.byCode.OTHER_CODES > 0);
});

// D9: this lane's copy of the contract is the shared one, byte for byte (CRLF read as LF), so writer and reader never disagree.
test('parity: platforms/odc/facade/quality-line.mjs is the shared ssam-quality/1 contract', () => {
  const text = fs.readFileSync(fileURLToPath(new URL('../quality-line.mjs', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), '95d2962ad1325289e053ee3d3d8f61b5e2f67992059baf986a077e74beec557d');
});
