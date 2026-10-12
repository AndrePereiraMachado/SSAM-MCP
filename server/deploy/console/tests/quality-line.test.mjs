// Contract tests of ssam-quality/1 (DESIGN-QUALIDADE.md section 2), the CONSOLE lane's copy of the shared
// fixtures/quality-line.test.mjs: the same four tests, pointed at this lane's copy of the contract (../quality-line.mjs)
// and of the fixtures (fixtures/quality/, QUALITY_FIXTURES overrides it), plus the parity test of D9: the sha256 of the
// contract module, CRLF read as LF, is the one both lanes share.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sanitizeQualityLine, fitLine, loadNativeIds, codeOf, agentLabel, agentVerbOf, AGENT_VERBS, ODC_COMMANDS, O11_METHODS, MAX_LINE_BYTES, NATIVE_UNLISTED } from '../quality-line.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = process.env.QUALITY_FIXTURES ?? path.join(HERE, 'fixtures', 'quality');
const native = loadNativeIds(path.join(FIXTURES, 'catalog'), { readDir: fs.readdirSync, readFile: fs.readFileSync, join: path.join });
const lines = text => text.split('\n').filter(Boolean);
export const CONTRACT_SHA256 = '200f74cee29c257354d0635931940b7bc0cb561f0a58df4784ca1741b67ec6c8';
const lfSha = file => createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');

test('parity (D9): the console copy of quality-line.mjs is the shared contract, byte for byte (CRLF read as LF)', () => {
  assert.equal(lfSha(path.join(HERE, '..', 'quality-line.mjs')), CONTRACT_SHA256);
  assert.equal(lfSha(path.join(FIXTURES, 'quality-line.mjs')), CONTRACT_SHA256, 'the fixtures folder carries the same contract');
});

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
  for (const leak of ['Batidas', 'GetColaboradorAtual', 'joao', 'Abrir', 'passwd', 'texto do cliente', 'Snapshot Module', '__proto__', 'constructor', 'sntl'])
    assert.ok(!text.includes(leak), 'leaked: ' + leak);
});

test('native ids: only the catalog keeps a CamelCase code; no catalog fails closed', () => {
  assert.equal(codeOf('ExpressionUnknownObject', { nativeIds: native }), 'ExpressionUnknownObject');
  assert.equal(codeOf('GetColaboradorAtual', { nativeIds: native }), NATIVE_UNLISTED);
  assert.equal(codeOf('ExpressionUnknownObject'), NATIVE_UNLISTED);
  assert.equal(codeOf('PREFLIGHT_REFUSED'), 'PREFLIGHT_REFUSED');
  for (const bad of ['a', 'preflight', 'X'.repeat(65), 'A.B', 'FOO BAR', '_X', 'Foo.Bar']) assert.equal(codeOf(bad, { nativeIds: native }), null, bad);
});

// The verb of an agent label comes only from its kind's closed list, the one the customer's agent enforces: a word that only
// looks like a verb (the model's own text as a studio_command command) never passes, in the writer or in the reader.
test('agent labels: a verb only from the closed list of its kind, never a verb-shaped word of the customer', () => {
  for (const ok of ['odc.pipe', 'odc.pipe:snapshot', 'odc.pipe:module-info', 'odc.pipe:reference-producers', 'o11.bridge:environment_session',
    'o11.bridge:open_module', 'o11.bridge', 'file.get', 'kernel'])
    assert.equal(agentLabel(ok), ok, ok);
  for (const bad of ['odc.pipe:acme-folha-sntl', 'odc.pipe:attach', 'odc.pipe:snapshot_module', 'o11.bridge:sntl_method', 'o11.bridge:export_modules',
    'o11.bridge:snapshot', 'file.put:sntl', 'kernel:run', 'net.probe:x', 'odc.pipe:Snapshot', 'odc.pipe:snapshot:x', 'outro.kind', 'odc.pipe:__proto__',
    'odc.pipe:constructor', 'constructor', '__proto__:snapshot', ''])
    assert.equal(agentLabel(bad), null, bad);
  assert.equal(agentVerbOf('odc.pipe', 'publish-status'), 'publish-status');
  assert.equal(agentVerbOf('o11.bridge', 'publish-status'), null);
  assert.equal(agentVerbOf('file.get', 'snapshot'), null);
  assert.equal(agentVerbOf('constructor', 'snapshot'), null);
  assert.deepEqual(Object.keys(AGENT_VERBS), ['odc.pipe', 'o11.bridge']);
  assert.ok(Object.isFrozen(ODC_COMMANDS) && Object.isFrozen(O11_METHODS) && Object.isFrozen(AGENT_VERBS));
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
