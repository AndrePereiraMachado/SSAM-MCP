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
import { sanitizeQualityLine, fitLine, loadNativeIds, codeOf, ruleOf, opWordOf, agentLabel, agentVerbOf, AGENT_VERBS, ODC_COMMANDS, O11_METHODS, MAX_LINE_BYTES, NATIVE_UNLISTED,
  CODE_UNLISTED, RULE_UNLISTED, CODES, RULES, OPS, PLACEHOLDER_CODES } from '../quality-line.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = process.env.QUALITY_FIXTURES ?? path.join(HERE, 'fixtures', 'quality');
const native = loadNativeIds(path.join(FIXTURES, 'catalog'), { readDir: fs.readdirSync, readFile: fs.readFileSync, join: path.join });
const lines = text => text.split('\n').filter(Boolean);
export const CONTRACT_SHA256 = '8625d52c4c5ef965980197f5cc267f84b3801ebba7c7d8928c4b53325864a015';
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
  for (const leak of ['Batidas', 'GetColaboradorAtual', 'joao', 'Abrir', 'passwd', 'texto do cliente', 'Snapshot Module', '__proto__', 'constructor', 'sntl', 'SNTL', 'ACME', 'acme', 'FOLHA', 'folha'])
    assert.ok(!text.includes(leak), 'leaked: ' + leak);
});

test('native ids: only the catalog keeps a CamelCase code; no catalog fails closed', () => {
  assert.equal(codeOf('ExpressionUnknownObject', { nativeIds: native }), 'ExpressionUnknownObject');
  assert.equal(codeOf('GetColaboradorAtual', { nativeIds: native }), NATIVE_UNLISTED);
  assert.equal(codeOf('ExpressionUnknownObject'), NATIVE_UNLISTED);
  assert.equal(codeOf('PREFLIGHT_REFUSED'), 'PREFLIGHT_REFUSED');
  for (const bad of ['a', 'preflight', 'X'.repeat(65), 'A.B', 'FOO BAR', '_X', 'Foo.Bar']) assert.equal(codeOf(bad, { nativeIds: native }), null, bad);
});

// Privacy review of 2026-10-12: the UPPER_SNAKE shape is not a code. A customer's table or app name in a code field, a
// problem code or a rule key is CODE_UNLISTED / RULE_UNLISTED, counted, never the text: only the registries generated from
// the product sources (CODES, RULES) and the placeholders pass, in the writer and in the reader.
test('codes and rules: only the registries pass; an UPPER_SNAKE word of the customer is CODE_UNLISTED / RULE_UNLISTED', () => {
  for (const code of ['PREFLIGHT_REFUSED', 'EXPR_UNKNOWN_IDENTIFIER', 'AGENT_NOT_CONNECTED', 'DOCTOR_LANE_UNUSABLE', 'O11_STUDIO_FAILED', 'BUILD_FAILED', 'RPC_32602', ...PLACEHOLDER_CODES])
    assert.equal(codeOf(code), code, code);
  for (const word of ['OSUSR_K3X_FOLHA_SNTL', 'DEBUG_FOLHA_PAGAMENTO_SNTL', 'CLIENTE_ACME_SNTL', 'ACME', 'RPC_X1', 'CODE_00', 'OK_CODE'])
    assert.equal(codeOf(word, { nativeIds: native }), CODE_UNLISTED, word);
  for (const rule of [...RULES, 'OTHER_RULES', RULE_UNLISTED]) assert.equal(ruleOf(rule), rule, rule);
  for (const word of ['CLIENTE_ACME_SNTL', 'PREFLIGHT_REFUSED', 'OSUSR_K3X_FOLHA_SNTL']) assert.equal(ruleOf(word), RULE_UNLISTED, word);
  for (const bad of ['LIST_ENTITY_SEGMENT_DROPPED+NULL_FUNCTION_REWRITTEN', 'sort_keys_split', 'ExpressionUnknownObject', '__proto__', '', 'X'.repeat(65)])
    assert.equal(ruleOf(bad), null, bad);
  assert.deepEqual([...RULES], ['LIST_ENTITY_SEGMENT_DROPPED', 'NULL_FUNCTION_REWRITTEN', 'PROPERTY_SET_DROPPED', 'SORT_KEYS_SPLIT']);
  assert.ok(CODES.length > 1000 && CODES.every(c => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(c) && c.length <= 64));
  assert.ok(!CODES.some(c => /SNTL|ACME|FOLHA/.test(c)));
  assert.ok(Object.isFrozen(CODES) && Object.isFrozen(RULES) && Object.isFrozen(OPS) && Object.isFrozen(PLACEHOLDER_CODES));
  // the op of a call: only the tools' own enum values, whatever the shape
  assert.equal(opWordOf('digest'), 'digest');
  for (const bad of ['acme-folha-sntl', 'folha', 'Digest', 'constructor']) assert.equal(opWordOf(bad), null, bad);
  // the line of the review's probe: nothing of the customer survives the contract
  const probe = { schema: 'ssam-quality/1', kind: 'call', time: '2026-10-12T16:03:07.794Z', token: 'tok_0123456789ab', session: '0123456789ab', call: 1, tool: 'o11_deliver',
    op: 'folha-pagamento', ms: 1, gapMs: null, ok: false, code: 'OSUSR_K3X_FOLHA_SNTL', problems: { n: 3, byCode: { OSUSR_K3X_FOLHA_SNTL: 1, DEBUG_FOLHA_PAGAMENTO_SNTL: 1, PREFLIGHT_REFUSED: 1 },
      withPatch: { OSUSR_K3X_FOLHA_SNTL: 1 } }, norm: { n: 2, byRule: { CLIENTE_ACME_SNTL: 1, SORT_KEYS_SPLIT: 1 } } };
  const kept = sanitizeQualityLine(probe, { nativeIds: native });
  assert.equal(kept.code, CODE_UNLISTED);
  assert.equal(kept.op, null);
  assert.deepEqual(kept.problems.byCode, { CODE_UNLISTED: 2, PREFLIGHT_REFUSED: 1 });
  assert.deepEqual(kept.problems.withPatch, { CODE_UNLISTED: 1 });
  assert.deepEqual(kept.norm, { n: 2, byRule: { RULE_UNLISTED: 1, SORT_KEYS_SPLIT: 1 } });
  assert.doesNotMatch(JSON.stringify(kept), /SNTL|ACME|FOLHA|folha/);
});

// Re-check of the review (2026-10-12): the codes the product composes at runtime (<VERB>_INVALID of the kernel's preflight,
// <OP>_REFUSED of the integration ops, <STAGE>_FAILED and the gates of the shaper, PUBLISH_<GATE>) and the codes of
// ssam_query_test are in the registry, so a refusal keeps them apart instead of folding them into CODE_UNLISTED.
test('composed codes and the query-test codes are listed: a refusal keeps SET_INVALID and REST_REFUSED apart', () => {
  for (const code of ['SET_INVALID', 'CREATE_INVALID', 'SPEC_INVALID', 'SCREEN_INVALID', 'REST_INVALID', 'PROTOTYPE_INVALID', 'AGENT_INVALID', 'DELETE_INVALID',
    'HTML_VISUAL_INVALID', 'OP_INVALID', 'REST_REFUSED', 'REST_EXPOSE_REFUSED', 'SOAP_REFUSED', 'KERNEL_FAILED', 'RUNNER_FAILED', 'PUBLISH_WAIT_FAILED',
    'UPLOAD_REQUEST_FAILED', 'CREATE_REVISION_FAILED', 'PUBLISH_VAULT_UNAVAILABLE', 'PUBLISH_SECRET_NOT_FOUND', 'PUBLISH_AUTHORSHIP', 'QUERY_TEST_DATABASE_ERROR',
    'QUERY_TEST_LOGIN_REQUIRED', 'QUERY_TEST_SOURCE_CHANGED', 'QUERY_TEST_NOT_QUERY', 'QUERY_TEST_MODULE_MISMATCH', 'QUERY_TEST_NATIVE_ERROR', 'QUERY_TEST_PENDING'])
    assert.equal(codeOf(code), code, code);
  const line = { schema: 'ssam-quality/1', kind: 'call', time: '2026-10-12T20:00:00.000Z', token: 'tok_0123456789ab', session: '0123456789ab', call: 1, tool: 'o11_deliver',
    ms: 5, gapMs: null, ok: false, code: 'PREFLIGHT_REFUSED', class: 'refused', problems: { n: 3, byCode: { SET_INVALID: 1, SPEC_INVALID: 1, REST_REFUSED: 1 } } };
  assert.deepEqual(sanitizeQualityLine(line, { nativeIds: native }).problems.byCode, { SET_INVALID: 1, SPEC_INVALID: 1, REST_REFUSED: 1 });
  const query = sanitizeQualityLine({ ...line, tool: 'ssam_query_test', code: 'QUERY_TEST_DATABASE_ERROR', problems: undefined }, { nativeIds: native });
  assert.equal(query.code, 'QUERY_TEST_DATABASE_ERROR');
  for (const word of ['FOLHA_SNTL_INVALID', 'OSUSR_K3X_FOLHA_REFUSED', 'PUBLISH_ACME_SNTL', 'QUERY_TEST_SNTL']) assert.equal(codeOf(word), CODE_UNLISTED, word);
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
  // 64 listed codes, the longest of the registry (a writer never leaves more than 32: this checks the fold alone)
  const long = [...CODES].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, 64);
  const big = { schema: 'ssam-quality/1', kind: 'call', time: '2026-10-12T18:00:00.000Z', token: 'tok_0000000a1fa0', session: 'abcdef012345', call: 1,
    tool: 'o11_deliver', op: null, lane: 'o11', ms: 1, gapMs: null, inFlight: 0, ok: false, code: 'PREFLIGHT_REFUSED', class: 'refused', step: 'preflight', deliv: null,
    problems: { n: 999, err: 999, warn: 0, byCode: Object.fromEntries(long.map((c, i) => [c, 64 - i])),
      withPatch: Object.fromEntries(long.map(c => [c, 1])), cut: false },
    norm: { n: 3, byRule: { SORT_KEYS_SPLIT: 2, NULL_FUNCTION_REWRITTEN: 1 } },
    agent: { n: 1, failed: 0, shared: false, top: [['file.get', 1, 1]] } };
  const text = fitLine(big);
  assert.ok(Buffer.byteLength(text) + 1 <= MAX_LINE_BYTES);
  const back = JSON.parse(text);
  assert.equal(back.trunc, true);
  assert.equal(back.agent.top, undefined);
  assert.equal(Object.keys(back.problems.byCode).length, 8);
  assert.ok(back.problems.byCode.OTHER_CODES > 0);
  assert.deepEqual(Object.keys(back.problems.byCode).filter(k => k !== 'OTHER_CODES'), long.slice(0, 7), 'the biggest stay, by name');
  assert.deepEqual(back.norm.byRule, { SORT_KEYS_SPLIT: 2, NULL_FUNCTION_REWRITTEN: 1 });
});
