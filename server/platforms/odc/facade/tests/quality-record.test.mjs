// quality-record.mjs (docs/QUALIDADE.md; design ssam-quality/1 sections 2.4-2.7) over REAL answer shapes, built by the
// product's own functions: the O11 preflight refusal of deliverOutcome (o11-cycle.mjs), compactDelivery refused and
// entregue (responses.mjs), interpretKernelResult (kernel-delivery.mjs), a pageAnswer page (ssam.mjs), a gate refusal
// (hosted/policy.mjs), a JSON-RPC error, normalizations with items, phases as object and as array, grouped problems
// (fitProblems: count, patchOmitted), native ids in and out of the catalog. Every line is checked against the contract
// (sanitize changes nothing, <= 4096 bytes) and no sentinel of the answers (names, paths, expressions, URLs, texts)
// reaches it. Plus: VERB_FIELDS against tools/list and the module constants, and the 5 ms soft bound of 2.6. Privacy review of
// 2026-10-12: codes and rules only from the registries (CODE_UNLISTED / RULE_UNLISTED), joined rules counted under each.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { sanitizeQualityLine, fitLine, loadNativeIds, MAX_LINE_BYTES, NATIVE_UNLISTED, CODE_UNLISTED, RULE_UNLISTED, OPS, O11_METHODS } from '../quality-line.mjs';
import { summarizeAnswer, summarizeMessage, buildCallLine, buildSessionLine, argsSummary, opOf, laneOf, clientFamily, closeReason, classify,
  timesFromSpans, categoryOf, sessionHash, VERB_FIELDS, CREATE_OPS } from '../quality-record.mjs';
import { outcomeOf } from '../http-server.mjs';
import { deliverOutcome } from '../o11-cycle.mjs';
import { compactDelivery, shapeToolResult } from '../responses.mjs';
import { interpretKernelResult, requiredFlowLayoutEngine } from '../kernel-delivery.mjs';
import { refusalFields, normalizationsOf } from '../refusal-problems.mjs';
import { agentNotConnected } from '../hosted/policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'quality');
const nativeIds = loadNativeIds(path.join(FIXTURES, 'catalog'), { readDir: fs.readdirSync, readFile: fs.readFileSync, join: path.join });
const tools = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(here, '..', 'hosted', 'tools.json'), 'utf8')).tools));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-quality-record-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Sentinels: what a customer's answer carries (names, paths, expressions, URLs, keys, free text). Every one has "sntl".
export const S = { module: 'SntlModuloQx7', screen: 'SntlTelaQx7', action: 'GetSntlColaboradorQx7', entity: 'SntlEntidadeQx7', attr: 'sntlAtributoQx7',
  expr: 'sntl_expr_qx7 + SntlFn(1)', path: 'C:\\sntl\\cliente\\Qx7.oml', url: 'https://sntl-tenant-qx7.outsystemscloud.com/app', key: 'sntlkey-qx7-deadbeef',
  msg: 'sntl texto do cliente Qx7', job: 'ws:odc/jobs/sntl-job-qx7.json' };
const noSentinel = (text, what) => assert.ok(!/sntl/i.test(text), what + ' carries a sentinel: ' + text.slice(0, 400));

const mcp = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value?.ok === false ? { isError: true } : {}) });
const FRAME = { time: Date.parse('2026-10-12T18:23:50.245Z'), tokenId: 'tok_0000000a1fa0', customer: 'Cliente Alfa', sessionId: 'mcp-session-' + S.key };
// What the recorder writes for one answered call (the same steps, without the I/O).
function lineOf(tool, args, message, { noted = null, ms = 1000, call = 1, gapMs = null, inFlight = 0, times = null, catalogLane = 'arg:odc', bytes = null } = {}) {
  const outcome = outcomeOf(message);
  const { protocol, summary, chars, paged } = summarizeMessage(tool, args, message, { noted, nativeIds });
  const line = buildCallLine({ ...FRAME, call, tool: tools.has(tool) ? tool : '?', op: opOf(tool, args), lane: laneOf(args, catalogLane), ms, gapMs, inFlight,
    ok: outcome.ok, code: outcome.ok ? null : outcome.error, protocol, summary, times, args: argsSummary(args, { bytes }), chars, paged });
  const clean = sanitizeQualityLine(line, { nativeIds, tools });
  assert.deepEqual(clean, line, 'the builder already writes only what the contract allows');
  const text = fitLine(clean);
  assert.ok(Buffer.byteLength(text) + 1 <= MAX_LINE_BYTES);
  assert.equal(text.includes('"trunc"'), false);
  noSentinel(text, tool + ' line');
  return JSON.parse(text);
}
const result = value => ({ jsonrpc: '2.0', id: 7, result: value });

// The O11 refusal of the production test (refusal 2 of 2026-10-11): 19 problems, 13 with a certain patch.
function o11Envelope() {
  const problem = (code, phase, i, patch) => ({ phase, op: i, pointer: '/ops/' + i + '/' + S.attr, code, severity: 'error',
    message: S.msg + ' ' + S.expr, fix: 'use ' + S.expr + ' in ' + S.path, ...(patch ? { patch: [{ op: 'replace', path: '/ops/' + i + '/value', value: S.expr }] } : {}),
    element: S.module + '.' + S.action, key: S.key });
  return { ok: false, code: 'PREFLIGHT_REFUSED', error: S.msg + ' at ' + S.path,
    problems: [...Array.from({ length: 12 }, (_, i) => problem('EXPR_UNKNOWN_IDENTIFIER', 'preflight', i, true)),
      ...Array.from({ length: 3 }, (_, i) => problem('EXPRESSION_SYNTAX', 'preflight', 12 + i, false)),
      problem('ExpressionUnknownObject', 'verify', 15, false), problem('ExpressionUnknownObject', 'verify', 16, false),
      problem('FUNCTION_UNKNOWN', 'preflight', 17, true), problem('FUNCTION_UNKNOWN', 'preflight', 18, false)],
    verifyRan: true, phases: ['preflight', 'verify'],
    normalizations: [{ rule: 'SORT_KEYS_SPLIT', path: '/ops/3/' + S.entity, from: S.expr, to: S.attr }, { rule: 'SORT_KEYS_SPLIT', path: S.path, from: S.url, to: S.msg }] };
}

test('the O11 preflight refusal (deliverOutcome): problems by code, phase and patch; normalizations by rule; nothing of the job', () => {
  const args = { module: S.module, job: 'agent:inbox/' + S.job, authorize: S.msg };
  const value = deliverOutcome({ envelope: o11Envelope() }, { trackId: 'x', work: tmp, job: S.path, taskId: null, since: 0, input: { module: S.module } });
  assert.equal(value.code, 'PREFLIGHT_REFUSED');
  const shaped = shapeToolResult('o11_deliver', args, mcp(value), { lane: 'o11' });
  const noted = summarizeAnswer('o11_deliver', args, shaped, { scan: 'full', nativeIds });
  const line = lineOf('o11_deliver', args, result(shaped), { noted, catalogLane: 'o11', bytes: 600 });
  assert.equal(line.ok, false); assert.equal(line.code, 'PREFLIGHT_REFUSED'); assert.equal(line.class, 'refused'); assert.equal(line.step, 'preflight');
  assert.equal(line.lane, 'o11'); assert.equal(line.op, null); assert.equal(line.deliv, null);
  assert.deepEqual(line.problems, { n: 19, err: 19, warn: 0, byCode: { EXPR_UNKNOWN_IDENTIFIER: 12, EXPRESSION_SYNTAX: 3, ExpressionUnknownObject: 2, FUNCTION_UNKNOWN: 2 },
    withPatch: { EXPR_UNKNOWN_IDENTIFIER: 12, FUNCTION_UNKNOWN: 1 }, byPhase: { preflight: 17, verify: 2 }, cut: false });
  assert.deepEqual(line.norm, { n: 2, byRule: { SORT_KEYS_SPLIT: 2 } });
  assert.deepEqual(line.args, { job: 'agent', bytes: 600 });
  assert.equal(line.answer.scan, 'full'); assert.equal(line.answer.paged, false);
  assert.equal(line.answer.chars, shaped.content[0].text.length);
  // The same answer read from the wire gives the same counts.
  const wire = lineOf('o11_deliver', args, result(shaped), { catalogLane: 'o11' });
  assert.deepEqual(wire.problems, line.problems); assert.equal(wire.answer.scan, 'wire');
});

test('a native id outside the catalog is NATIVE_UNLISTED; without the catalog every CamelCase code is', () => {
  const value = { ok: false, outcome: 'refused', code: 'VALIDATION_REFUSED', failed: 'build',
    problems: [{ code: 'ExpressionUnknownObject', phase: 'verify' }, { code: S.action, phase: 'verify' }, { code: S.msg }, { code: 'sntl_lower' }, 'just ' + S.msg] };
  const line = lineOf('studio_deliver', { module: S.module }, result(mcp(value)));
  assert.deepEqual(line.problems.byCode, { PROBLEM_UNCODED: 3, ExpressionUnknownObject: 1, [NATIVE_UNLISTED]: 1 });
  const none = summarizeAnswer('studio_deliver', {}, mcp(value), { nativeIds: null });
  assert.deepEqual(none.problems.byCode, { [NATIVE_UNLISTED]: 2, PROBLEM_UNCODED: 3 });
});

test('compactDelivery: an ODC refusal with validation errors, grouped problems and normalization items; then entregue', () => {
  const problems = Array.from({ length: 60 }, (_, i) => ({ phase: i < 50 ? 'apply' : 'base', op: i, pointer: '/ops/' + i + '/' + S.screen, code: i < 50 ? 'LIST_CURRENT_UNGUARDED' : 'BASE_NOT_FOUND',
    severity: i % 10 === 9 ? 'warning' : 'error', message: S.msg.repeat(8), fix: 'replace ' + S.expr + ' by ' + S.attr, patch: [{ op: 'replace', path: '/ops/' + i + '/' + S.attr, value: S.expr.repeat(20) }] }));
  const fitted = refusalFields(problems, {}, { budget: 3000 });
  assert.equal(fitted.grouped, true);
  assert.ok(fitted.problems.some(p => p.count > 1), 'grouped entries carry count');
  assert.ok(fitted.problems.some(p => p.patchOmitted === true) || fitted.problemsTotal, 'the biggest group lost its patch (or the list was cut)');
  const raw = { ok: false, failed: 'build', code: 'VALIDATION_REFUSED', error: S.msg, job: { ops: [{ op: 'set', target: S.entity, value: S.expr }] }, jobSha256: 'ab'.repeat(32),
    ...fitted, validation: { errors: [{ id: 'ExpressionRequiredExpression', message: S.msg, path: S.path }, { id: S.action, message: S.msg }, S.msg] },
    normalizations: { total: 5, byRule: { SORT_KEYS_SPLIT: 3, NULL_FUNCTION_REWRITTEN: 1, [S.action]: 1 }, items: [{ rule: 'SORT_KEYS_SPLIT', path: S.path, from: S.expr, to: S.attr }] },
    warnings: [{ id: 'UnusedElement', detail: S.msg }], warningsTotal: 3, highWarnings: [{ id: 'QUERY_IN_LOOP', detail: S.msg }], phases: { buildMs: 900, queuedMs: 2500, applyMs: 0 } };
  const compact = compactDelivery('studio_deliver', { module: S.module }, raw);
  assert.ok(Array.isArray(compact.validationErrors));
  const args = { module: S.module, job: { ops: [] }, basedOn: { job: S.job, sha256: 'ab'.repeat(32) }, patch: [{}, {}], partial: true, until: 'merge' };
  const line = lineOf('studio_deliver', args, result(mcp(compact)), { noted: summarizeAnswer('studio_deliver', args, mcp(compact), { scan: 'full', nativeIds }) });
  assert.equal(line.class, 'refused'); assert.equal(line.step, 'build'); assert.equal(line.code, 'VALIDATION_REFUSED');
  const counted = fitted.problems.reduce((s, p) => s + (p.count ?? 1), 0);
  assert.equal(line.problems.n, Math.max(counted, fitted.problemsTotal ?? 0) + 3);
  assert.equal(line.problems.byCode.ExpressionRequiredExpression, 1);
  assert.equal(line.problems.byCode[NATIVE_UNLISTED], 1);
  assert.equal(line.problems.byCode.VALIDATION_UNCODED, 1);
  assert.equal(line.problems.byPhase.verify, 3);
  assert.ok(line.problems.warn > 0 || fitted.problemsTotal, 'warning problems counted apart');
  assert.deepEqual(line.norm, { n: 5, byRule: { SORT_KEYS_SPLIT: 3, NULL_FUNCTION_REWRITTEN: 1, [RULE_UNLISTED]: 1 } });
  assert.deepEqual(line.warn, { n: 3, high: 1 });
  assert.deepEqual(line.args, { job: 'inline', basedOn: true, partial: true, patch: 2, until: 'merge' });

  const delivered = compactDelivery('studio_deliver', { module: S.module }, { ok: true, merged: true, strictlyEqual: true, result: 'entregue', module: S.module, manifest: S.path,
    normalizations: { total: 4, byRule: { SORT_KEYS_SPLIT: 3, PROPERTY_SET_DROPPED: 1 }, items: [{ rule: 'PROPERTY_SET_DROPPED', path: S.path, from: S.expr, to: S.url }] },
    summary: { actions: [{ name: S.action, inputs: [S.attr] }] }, phases: { buildMs: 1000, queuedMs: 2500, applyMs: 3000 } });
  assert.equal(delivered.result, 'entregue');
  const ok = lineOf('studio_deliver', { module: S.module, job: S.job }, result(mcp(delivered)),
    { times: timesFromSpans([], { ms: 9000, queue: 2500 }), ms: 9000 });
  assert.equal(ok.class, 'delivered'); assert.equal(ok.deliv, 'entregue'); assert.equal(ok.ok, true); assert.equal(ok.code, null);
  assert.deepEqual(ok.norm, { n: 4, byRule: { SORT_KEYS_SPLIT: 3, PROPERTY_SET_DROPPED: 1 } });
  assert.deepEqual(ok.t, { queue: 2500, rest: 6500 });
  assert.deepEqual(ok.args, { job: 'ws' });
  assert.equal(ok.lane, 'odc');
  // Delivered, then the publish of the same call failed: ok:false, its code, deliv kept.
  const published = lineOf('studio_deliver', { module: S.module, publish: true }, result(mcp({ ok: false, code: 'PUBLISH_FAILED', result: 'entregue', error: S.msg, publish: { outcome: 'failed' } })));
  assert.deepEqual([published.ok, published.code, published.deliv, published.class], [false, 'PUBLISH_FAILED', 'entregue', 'delivered']);
  const both = lineOf('o11_deliver', { module: S.module }, result(mcp({ ok: true, result: 'entregue e publicado' })), { catalogLane: 'o11' });
  assert.equal(both.deliv, 'entregue-publicado');
});

test('interpretKernelResult: a kernel refusal with data problems and an accepted candidate with normalizations', () => {
  const output = path.join(tmp, 'kernel-' + S.module);
  const refused = interpretKernelResult({ ok: false, code: 'PREFLIGHT_REFUSED', error: S.msg + '\n   at Sntl.Stack()', data: { problems: [
    { phase: 'apply', code: 'DELETE_HAS_CONSUMERS', message: S.msg, element: S.entity, patch: [] }, { phase: 'base', code: 'BASE_NOT_FOUND', message: S.url }], verifyRan: false, verifyReason: S.msg } },
  { output, exitCode: 1 });
  assert.equal(refused.ok, false);
  const line = lineOf('studio_deliver', { module: S.module }, result(mcp({ ...refused, failed: 'build' })));
  assert.deepEqual(line.problems.byCode, { BASE_NOT_FOUND: 1, DELETE_HAS_CONSUMERS: 1 });
  assert.deepEqual(line.problems.byPhase, { apply: 1, base: 1 });
  assert.equal(line.problems.withPatch, undefined, 'an empty patch is no patch');
  const accepted = interpretKernelResult({ ok: true, data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine,
    normalizations: [{ rule: 'NULL_FUNCTION_REWRITTEN', path: S.path, from: 'NullDate()', to: S.expr }, { rule: 'LIST_ENTITY_SEGMENT_DROPPED', path: S.screen, from: S.attr, to: S.entity }] } }, { output, exitCode: 0 });
  assert.equal(accepted.ok, true);
  assert.ok(/sntl/i.test(JSON.stringify(accepted.normalizations.items)), 'the answer itself carries the items');
  const ok = lineOf('studio_deliver', { module: S.module }, result(mcp(accepted)));
  assert.deepEqual(ok.norm, { n: 2, byRule: { LIST_ENTITY_SEGMENT_DROPPED: 1, NULL_FUNCTION_REWRITTEN: 1 } });
  assert.equal(ok.class, 'ok');
});

// Privacy review of 2026-10-12 (findings 1 and 3). A customer's UPPER_SNAKE word in a code field (a table name, the debug_
// object name of an error text) is CODE_UNLISTED / RULE_UNLISTED, counted, never the text; the shaper names an odc_read
// failure by its tool, not by a word of its text. An expression two rules changed counts under each rule.
test('codes and rules only from the registries; an expression two rules changed counts under each rule', () => {
  const norm = normalizationsOf({ normalizations: [
    { rule: 'LIST_ENTITY_SEGMENT_DROPPED+NULL_FUNCTION_REWRITTEN', path: S.path, from: S.expr, to: S.attr },
    { rule: 'LIST_ENTITY_SEGMENT_DROPPED+NULL_FUNCTION_REWRITTEN', path: S.path, from: S.expr, to: S.attr },
    { rule: 'SORT_KEYS_SPLIT', path: S.path, from: S.expr, to: S.attr }] }).normalizations;
  assert.deepEqual(norm.byRule, { 'LIST_ENTITY_SEGMENT_DROPPED+NULL_FUNCTION_REWRITTEN': 2, SORT_KEYS_SPLIT: 1 }, 'the answer keeps the joined key of the kernel');
  const joined = lineOf('studio_deliver', { module: S.module }, result(mcp({ ok: true, result: 'entregue', normalizations: norm })));
  assert.deepEqual(joined.norm, { n: 3, byRule: { LIST_ENTITY_SEGMENT_DROPPED: 2, NULL_FUNCTION_REWRITTEN: 2, SORT_KEYS_SPLIT: 1 } });
  // a rule repeated inside one joined key counts once; a rule of the customer and a text are RULE_UNLISTED
  const odd = summarizeAnswer('studio_deliver', {}, mcp({ ok: true, normalizations: { total: 4, byRule: { 'SORT_KEYS_SPLIT+SORT_KEYS_SPLIT': 1, CLIENTE_ACME_SNTL: 1, [S.msg]: 2 } } }));
  assert.deepEqual(odd.norm, { n: 4, byRule: { SORT_KEYS_SPLIT: 1, [RULE_UNLISTED]: 3 } });
  // a table name of the customer as the refusal's code and as problem codes
  const value = { ok: false, code: 'OSUSR_K3X_FOLHA_SNTL', failed: 'build', problems: [{ code: 'OSUSR_K3X_FOLHA_SNTL', phase: 'apply' }, { code: 'DEBUG_FOLHA_PAGAMENTO_SNTL', patch: [{}] },
    { code: 'EXPRESSION_SYNTAX' }], normalizations: { total: 1, byRule: { CLIENTE_ACME_SNTL: 1 } } };
  const line = lineOf('studio_deliver', { module: S.module }, result(mcp(value)));
  assert.equal(line.code, CODE_UNLISTED);
  assert.deepEqual(line.problems.byCode, { [CODE_UNLISTED]: 2, EXPRESSION_SYNTAX: 1 });
  assert.deepEqual(line.problems.withPatch, { [CODE_UNLISTED]: 1 });
  assert.deepEqual(line.norm, { n: 1, byRule: { [RULE_UNLISTED]: 1 } });
  assert.deepEqual(outcomeOf(result(mcp({ ok: false, reason: 'CLIENTE_ACME_SNTL' }))), { ok: false, error: CODE_UNLISTED }, 'the audit too');
  // the shaper: a debug_-shaped word in an odc_read error text is the customer's object, never a code
  const shaped = shapeToolResult('odc_read', {}, mcp({ ok: false, error: "Invalid object name 'debug_folha_pagamento_sntl'." }), { lane: 'odc' });
  assert.equal(shaped.structuredContent.code, 'ODC_READ_FAILED');
  assert.equal(lineOf('odc_read', {}, result(shaped), { catalogLane: 'odc' }).code, 'ODC_READ_FAILED');
});

// Re-check of 2026-10-12: the codes the product composes at runtime (JobPreflight <VERB>_INVALID, IntegrationRefusalException
// <OP>_REFUSED, the shaper's <STAGE>_FAILED, publishOutcomeOf PUBLISH_<GATE>) and the codes of ssam_query_test
// (kernel/query-test) are in the registry: a real refusal keeps each of them, never CODE_UNLISTED.
test('composed codes and the query-test codes stay distinguishable: a preflight refusal keeps SET_INVALID and REST_REFUSED', async () => {
  const problem = (code, i) => ({ phase: 'preflight', op: i, pointer: '/ops/' + i + '/' + S.attr, code, severity: 'error', message: S.msg + ' ' + S.expr,
    fix: 'use ' + S.expr, element: S.module + '.' + S.action });
  const envelope = { ok: false, code: 'PREFLIGHT_REFUSED', error: S.msg + ' at ' + S.path, verifyRan: false, phases: ['preflight'],
    problems: [problem('SET_INVALID', 0), problem('SPEC_INVALID', 1), problem('REST_REFUSED', 2), problem('REST_EXPOSE_REFUSED', 3), problem('SOAP_REFUSED', 4),
      problem('OP_INVALID', 5), problem('EXPR_UNKNOWN_IDENTIFIER', 6)] };
  const value = deliverOutcome({ envelope }, { trackId: 'x', work: tmp, job: S.path, taskId: null, since: 0, input: { module: S.module } });
  const shaped = shapeToolResult('o11_deliver', {}, mcp(value), { lane: 'o11' });
  const noted = summarizeAnswer('o11_deliver', {}, shaped, { scan: 'full', nativeIds });
  const line = lineOf('o11_deliver', {}, result(shaped), { noted, catalogLane: 'o11' });
  assert.equal(line.code, 'PREFLIGHT_REFUSED');
  assert.deepEqual(line.problems.byCode, { SET_INVALID: 1, SPEC_INVALID: 1, REST_REFUSED: 1, REST_EXPOSE_REFUSED: 1, SOAP_REFUSED: 1, OP_INVALID: 1, EXPR_UNKNOWN_IDENTIFIER: 1 });
  // the integration op's own refusal as the code of an ODC kernel answer
  const soap = interpretKernelResult({ ok: false, code: 'SOAP_REFUSED', error: S.msg, data: { problems: [{ phase: 'preflight', code: 'SOAP_LANE_UNSUPPORTED', message: S.msg }] } },
    { output: path.join(tmp, 'kernel-soap'), exitCode: 1 });
  const odc = lineOf('studio_deliver', { module: S.module }, result(mcp({ ...soap, failed: 'build' })));
  assert.equal(odc.code, 'SOAP_REFUSED'); assert.deepEqual(odc.problems.byCode, { SOAP_LANE_UNSUPPORTED: 1 });
  // the shaper's <STAGE>_FAILED of a stage word, and publishOutcomeOf's PUBLISH_<GATE>
  for (const [stage, code] of [['kernel', 'KERNEL_FAILED'], ['publish-wait', 'PUBLISH_WAIT_FAILED'], ['upload-request', 'UPLOAD_REQUEST_FAILED'], ['runner', 'RUNNER_FAILED']]) {
    const staged = shapeToolResult('studio_deliver', {}, mcp({ ok: false, stage, error: S.msg }), { lane: 'odc' });
    assert.equal(staged.structuredContent.code, code, stage);
    assert.equal(lineOf('studio_deliver', {}, result(staged)).code, code, stage);
  }
  const { publishOutcomeOf } = await import('../kernel-delivery.mjs');
  for (const [gate, code] of [['authorship', 'PUBLISH_AUTHORSHIP'], ['vault_unavailable', 'PUBLISH_VAULT_UNAVAILABLE'], ['secret_not_found', 'PUBLISH_SECRET_NOT_FOUND']]) {
    const publish = publishOutcomeOf({ ok: false, outcome: 'gate_refused', gate, error: S.msg });
    assert.equal(publish.code, code, gate);
    assert.equal(lineOf('studio_deliver', { module: S.module, publish: true }, result(mcp({ ok: false, code: publish.code, result: 'entregue', publish }))).code, code, gate);
  }
  // the hosted ssam_query_test (kernel/query-test, compiled into both bridges)
  for (const code of ['QUERY_TEST_DATABASE_ERROR', 'QUERY_TEST_LOGIN_REQUIRED', 'QUERY_TEST_SOURCE_CHANGED', 'QUERY_TEST_NOT_QUERY', 'QUERY_TEST_MODULE_MISMATCH',
    'QUERY_TEST_NATIVE_ERROR', 'QUERY_TEST_PENDING'])
    assert.equal(lineOf('ssam_query_test', {}, result(mcp({ ok: false, code, execution: 'native-query', error: S.msg + ' ' + S.expr }))).code, code, code);
  // a code of the customer in the same slots is still CODE_UNLISTED
  assert.equal(lineOf('ssam_query_test', {}, result(mcp({ ok: false, code: 'OSUSR_K3X_FOLHA_SNTL', error: S.msg }))).code, CODE_UNLISTED);
});

test('a paged refusal: the wire keeps only its small fields; the summary noted before paging keeps every problem (scan full)', async () => {
  const { pageAnswer } = await import('../ssam.mjs');
  const value = deliverOutcome({ envelope: o11Envelope() }, { trackId: 'x', work: tmp, job: S.path, taskId: null, since: 0, input: {} });
  const shaped = shapeToolResult('o11_deliver', {}, mcp(value), { lane: 'o11' });
  const paged = pageAnswer(shaped, { directory: path.join(tmp, 'answers'), maxBytes: 2000 });
  assert.ok(paged.structuredContent.paged, 'paged');
  assert.equal(paged.structuredContent.problems, undefined, 'the problems left the wire');
  const noted = summarizeAnswer('o11_deliver', {}, shaped, { scan: 'full', nativeIds });
  const full = lineOf('o11_deliver', {}, result(paged), { noted, catalogLane: 'o11' });
  assert.equal(full.problems.n, 19); assert.equal(full.answer.scan, 'full'); assert.equal(full.answer.paged, true);
  assert.equal(full.answer.chars, paged.content[0].text.length);
  const wire = lineOf('o11_deliver', {}, result(paged), { catalogLane: 'o11' });
  assert.equal(wire.problems, undefined); assert.equal(wire.answer.scan, 'wire'); assert.equal(wire.answer.paged, true);
  assert.equal(wire.class, 'refused', 'the outcome and the step stay inline');
});

test('a gate refusal, a JSON-RPC error, a text-only answer and an answer that is not JSON', () => {
  const gate = { content: [{ type: 'text', text: JSON.stringify(agentNotConnected(null, { tool: 'o11_deliver' })) }], structuredContent: agentNotConnected(null, { tool: 'o11_deliver' }), isError: true };
  const refused = lineOf('o11_deliver', { module: S.module }, result(gate), { catalogLane: 'o11' });
  assert.deepEqual([refused.ok, refused.code, refused.class, refused.answer.scan], [false, 'AGENT_NOT_CONNECTED', 'failed', 'wire']);
  const rpc = lineOf('ssam_map', { target: S.path, view: 'search', text: S.expr }, { jsonrpc: '2.0', id: 3, error: { code: -32602, message: S.msg + ' ' + S.path } });
  assert.deepEqual([rpc.ok, rpc.code, rpc.class, rpc.op, rpc.answer.scan, rpc.answer.chars], [false, 'RPC_32602', 'protocol', 'search', 'skipped', 0]);
  const text = lineOf('ssam_discover', { intent: S.msg, lane: 'o11' }, result({ content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'DISCOVER_FAILED', stage: S.msg }) }], isError: true }));
  // The audit reads codes from structuredContent only: a text-only refusal is TOOL_ERROR there and here.
  assert.deepEqual([text.code, text.class, text.step, text.answer.scan, text.lane], ['TOOL_ERROR', 'refused', null, 'wire', 'o11']);
  const plain = lineOf('ssam_doctor', {}, result({ content: [{ type: 'text', text: S.msg }] }), { catalogLane: 'none' });
  assert.deepEqual([plain.ok, plain.class, plain.answer.scan, plain.lane], [true, 'ok', 'skipped', null]);
});

test('phases as an object give the queue; phases as an array (kernel phase names) and queue.waitedMs', () => {
  assert.equal(summarizeAnswer('t', {}, mcp({ ok: true, phases: { buildMs: 1, queuedMs: 4321, applyMs: 2 } })).queue, 4321);
  assert.equal(summarizeAnswer('t', {}, mcp({ ok: false, phases: ['preflight', 'verify'] })).queue, null);
  assert.equal(summarizeAnswer('t', {}, mcp({ ok: false, phases: ['preflight', 'verify'], queue: { waitedMs: 99 } })).queue, 99);
  assert.equal(summarizeAnswer('t', {}, mcp({ ok: false, queue: { position: 2, waitedMs: 1500, holder: { tool: S.action } } })).queue, 1500);
});

test('classify, deliv, op, lane, args and the client family follow the closed rules', () => {
  assert.equal(classify({ ok: false, code: 'DELIVERY_UNCERTAIN', summary: { outcome: 'refused' } }), 'uncertain');
  assert.equal(classify({ ok: false, summary: { outcome: 'incomplete' } }), 'uncertain');
  assert.equal(classify({ ok: false, summary: { stepText: true } }), 'refused');
  assert.equal(classify({ ok: false, summary: { outcome: 'not-sent' } }), 'refused');
  assert.equal(classify({ ok: false, summary: {} }), 'failed');
  assert.equal(classify({ ok: true, protocol: true }), 'protocol');
  const created = lineOf('o11_environment', { action: 'create-app', name: S.module }, result(mcp({ ok: true, app: S.module })), { catalogLane: 'o11' });
  assert.deepEqual([created.op, created.deliv, created.class], ['create-app', 'criado', 'delivered']);
  assert.equal(lineOf('studio_create_app', {}, result(mcp({ ok: true })), { catalogLane: 'odc' }).deliv, 'criado');
  assert.equal(lineOf('studio_create_app', { action: 'templates' }, result(mcp({ ok: true })), { catalogLane: 'odc' }).deliv, null);
  assert.equal(lineOf('studio_create', { name: S.module }, result(mcp({ ok: true })), { catalogLane: 'odc' }).deliv, 'criado');
  assert.equal(lineOf('o11_environment', { action: 'create-app' }, result(mcp({ ok: false, code: 'CREATE_APP_FAILED' })), { catalogLane: 'o11' }).deliv, null);
  assert.deepEqual(Object.keys(CREATE_OPS).sort(), ['o11_environment', 'studio_create', 'studio_create_app']);
  assert.equal(opOf('o11_deliver', { close: { taskId: 'a'.repeat(32), reason: S.msg } }), 'close');
  assert.equal(opOf('o11_deliver', { resume: 'a'.repeat(32) }), 'resume');
  assert.equal(opOf('ssam_map', {}), 'map');
  assert.equal(opOf('ssam_map', { view: S.msg }), null);
  assert.equal(opOf('ssam_friction', {}), 'issues');
  assert.equal(opOf('studio_deliver', { until: 'merge' }), null);
  assert.equal(laneOf({ lane: 'odc' }, 'o11'), 'odc');
  assert.equal(laneOf({ lane: S.msg }, 'arg:o11'), 'o11');
  assert.equal(laneOf({}, 'none'), null);
  assert.equal(laneOf({}, 'arg:none'), null);
  assert.deepEqual(argsSummary({ job: '  [1]' }), { job: 'inline-text' });
  assert.deepEqual(argsSummary({ job: S.path, closePrevious: 'a'.repeat(32), publish: true, until: S.msg }), { job: 'other', closePrevious: true, publish: true });
  for (const [name, family] of [['claude-code', 'claude-code'], ['Claude Code', 'claude-code'], ['claude-ai', 'claude-ai'], ['Claude Desktop', 'claude-desktop'], ['codex-mcp-client', 'codex'],
    ['Cursor', 'cursor'], ['Visual Studio Code', 'vscode'], ['windsurf', 'windsurf'], ['', 'unknown'], [undefined, 'unknown'], ['Sntl Private Client', 'other']])
    assert.equal(clientFamily(name), family, String(name));
  assert.equal(closeReason('token-revoked'), 'token-revoked'); assert.equal(closeReason('token-' + S.msg), 'other');
  assert.match(sessionHash('x'), /^[0-9a-f]{12}$/);
  const opened = buildSessionLine({ event: 'opened', ...FRAME, client: 'codex' });
  assert.deepEqual(sanitizeQualityLine(opened), opened);
  const closed = buildSessionLine({ event: 'closed', ...FRAME, client: 'codex', reason: 'idle', calls: 3, openMs: 1234.4 });
  assert.deepEqual(sanitizeQualityLine(closed), closed);
  noSentinel(JSON.stringify([opened, closed]), 'session lines');
});

test('spans: category per kind and verb, unions, kernelOwn, rest, top and approx', () => {
  assert.equal(categoryOf('o11.bridge', 'snapshot_module'), 'capture');
  assert.equal(categoryOf('o11.bridge', 'open_module'), 'studio');
  assert.equal(categoryOf('o11.bridge', 'get_errors'), 'verify');
  assert.equal(categoryOf('odc.pipe', 'publish-status'), 'publish');
  assert.equal(categoryOf('odc.pipe', 'merge'), 'studio');
  assert.equal(categoryOf('file.get'), 'transfer'); assert.equal(categoryOf('net.probe'), 'network'); assert.equal(categoryOf('nope'), null);
  const at = 1_000_000;
  const spans = [
    { cat: 'transfer', label: 'file.get', startMs: at, ms: 75000, ok: true, bytes: 100000 },
    { cat: 'transfer', label: 'file.get', startMs: at + 75000, ms: 300, ok: true, bytes: 35852 },
    { cat: 'kernel', label: 'kernel', startMs: at + 75300, ms: 6000, ok: true, via: 'cold' },
    { cat: 'studio', label: 'o11.bridge:list_open_modules', startMs: at + 81300, ms: 400, ok: true },
    { cat: 'capture', label: 'o11.bridge:snapshot_module', startMs: at + 81700, ms: 300, ok: false },
  ];
  const { t, agent, kernel } = timesFromSpans(spans, { ms: 82245, window: [at, at + 82245] });
  assert.deepEqual(t, { capture: 300, studio: 400, transfer: 75300, kernel: 6000, kernelOwn: 6000, rest: 245 });
  assert.deepEqual(agent, { n: 4, failed: 1, bytes: 135852, shared: false, top: [['file.get', 2, 75300], ['o11.bridge:list_open_modules', 1, 400], ['o11.bridge:snapshot_module', 1, 300]] });
  assert.deepEqual(kernel, { runs: 1, cold: 1, worker: 0, ms: 6000 });
  // The kernel waiting on the relay is Studio time: the bridge call inside the kernel run is taken out of kernelOwn.
  const inside = timesFromSpans([{ cat: 'kernel', label: 'kernel', startMs: 0, ms: 10000, via: 'worker' }, { cat: 'studio', label: 'o11.bridge:merge_from_oml', startMs: 2000, ms: 3000 }], { ms: 11000 });
  assert.deepEqual(inside.t, { studio: 3000, kernel: 10000, kernelOwn: 7000, rest: 1000 });
  assert.deepEqual(inside.kernel, { runs: 1, cold: 0, worker: 1, ms: 10000 });
  const approx = timesFromSpans([{ cat: 'kernel', label: 'kernel', startMs: 0, ms: 10000 }, { cat: 'studio', label: 'o11.bridge', startMs: 2000, ms: 3000 }], { ms: 14000, approx: true });
  assert.deepEqual(approx.t, { studio: 3000, kernel: 10000, kernelOwn: 10000, rest: 1000 });
  assert.equal(approx.agent.approx, true);
  assert.deepEqual(timesFromSpans([], { ms: 5, shared: true }).agent, { n: 0, failed: 0, shared: true });
  const many = Array.from({ length: 9 }, (_, i) => ({ cat: 'studio', label: 'o11.bridge:' + O11_METHODS[i], startMs: i * 10, ms: 10 - i }));
  assert.equal(timesFromSpans(many, { ms: 100 }).agent.top.length, 6);
  // A verb-shaped word outside the agent's lists (the model's text as a studio_command command) never becomes a label; its
  // time stays in its category and its count in n.
  const free = timesFromSpans([{ cat: 'studio', label: 'odc.pipe:acme-folha-sntl', startMs: 0, ms: 50 }, { cat: 'studio', label: 'o11.bridge:sntl_method', startMs: 50, ms: 20 },
    { cat: 'transfer', label: 'file.put:sntl', startMs: 70, ms: 5 }, { cat: 'studio', label: 'odc.pipe:module-info', startMs: 75, ms: 7 }], { ms: 100 });
  assert.deepEqual(free.t, { studio: 77, transfer: 5, rest: 18 });
  assert.deepEqual(free.agent, { n: 4, failed: 0, shared: false, top: [['odc.pipe:module-info', 1, 7]] });
  assert.ok(!JSON.stringify(free).includes('sntl'));
});

test('VERB_FIELDS are the enums of tools/list and the module constants', { timeout: 120000 }, async () => {
  process.env.SSAM_APP_HOOK_TOOLS = '1';
  const { createSsamServer } = await import('../ssam.mjs');
  const { frictionTool } = await import('../../../../facade/friction-boundary.mjs');
  const server = await createSsamServer();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'quality-record-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  let listed;
  try { listed = new Map([...(await client.listTools()).tools, frictionTool].map(t => [t.name, t])); }
  finally { await client.close(); await server.close(); }
  for (const [tool, spec] of Object.entries(VERB_FIELDS)) {
    assert.ok(tools.has(tool), tool + ' is in the hosted catalog');
    const field = listed.get(tool)?.inputSchema?.properties?.[spec.field];
    assert.ok(field, tool + '.' + spec.field + ' is listed');
    assert.deepEqual([...field.enum].sort(), [...spec.values].sort(), tool + '.' + spec.field + ' enum');
    if (spec.default !== null) assert.ok(field.default === undefined || field.default === spec.default, tool + ' default');
  }
  assert.ok(listed.get('o11_deliver').inputSchema.properties.close && listed.get('o11_deliver').inputSchema.properties.resume, 'o11_deliver close and resume');
  const [{ VIEWS }, { REFERENCE_KINDS }, { ENVIRONMENT_READS, ENVIRONMENT_WRITES }, { COMMANDS }, { CREATE_APP_ACTIONS }] = await Promise.all([
    import('../module-map.mjs'), import('../ssam-reference.mjs'), import('../o11-environment.mjs'), import('../o11-studio.mjs'), import('../studio-create-app.mjs')]);
  assert.deepEqual(VERB_FIELDS.ssam_map.values, VIEWS);
  assert.deepEqual(VERB_FIELDS.ssam_reference.values, REFERENCE_KINDS);
  assert.deepEqual(VERB_FIELDS.o11_environment.values, [...ENVIRONMENT_READS, ...ENVIRONMENT_WRITES]);
  assert.deepEqual(VERB_FIELDS.o11_studio.values, COMMANDS);
  assert.deepEqual(VERB_FIELDS.studio_create_app.values, CREATE_APP_ACTIONS);
  // the contract's OPS (what a reader keeps as op) are exactly these enums and o11_deliver's close and resume
  assert.deepEqual([...OPS].sort(), [...new Set([...Object.values(VERB_FIELDS).flatMap(s => s.values), 'close', 'resume'])].sort());
});

test('cost: summarizing a 40 KB refusal with 2000 problems stays under 5 ms (soft bound, reported)', t => {
  const problems = Array.from({ length: 2000 }, (_, i) => (i % 3 === 0 ? { code: 'ExpressionUnknownObject' } : { code: 'P_' + (i % 30), ...(i % 4 ? {} : { patchOmitted: true }) }));
  const value = { ok: false, outcome: 'refused', code: 'PREFLIGHT_REFUSED', stage: 'preflight', problems, problemsTotal: 2400,
    normalizations: { total: 3, byRule: { SORT_KEYS_SPLIT: 3 }, items: [] } };
  const answer = mcp(value);
  assert.ok(answer.content[0].text.length > 36000 && answer.content[0].text.length < 60000, 'about 40 KB: ' + answer.content[0].text.length);
  for (let i = 0; i < 20; i++) summarizeAnswer('o11_deliver', {}, answer, { scan: 'full', nativeIds });
  const runs = 50;
  const started = process.hrtime.bigint();
  let summary;
  for (let i = 0; i < runs; i++) summary = summarizeAnswer('o11_deliver', {}, answer, { scan: 'full', nativeIds });
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / runs;
  t.diagnostic('summarizeAnswer on ' + answer.content[0].text.length + ' bytes, 2000 problems: ' + ms.toFixed(3) + ' ms per call');
  assert.equal(summary.problems.n, 2400); assert.equal(summary.problems.cut, true);
  if (ms >= 5) t.diagnostic('SOFT BOUND EXCEEDED: ' + ms.toFixed(3) + ' ms >= 5 ms');
  assert.ok(ms < 50, 'far above the soft bound: ' + ms);
});
