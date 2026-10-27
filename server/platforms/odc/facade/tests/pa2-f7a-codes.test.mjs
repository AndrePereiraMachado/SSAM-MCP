// A20 (package of 2026-10-06, lane F7a): every refusal without a code gets a specific one, and the friction store classifies
// the same texts alike. The texts are the friction report's real ones (match-other of the store): the SDK's input
// validation, the debugger's debug_* reasons, the discovery index mismatch, a lost ODC bridge pipe, the doctor's ok:false,
// a CLI exception line. I9: warnings/warningsTotal travel in the delivery answers. Pure functions, no Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeToolResult, withRefusalCode, compactDelivery, DELIVERY_FIELDS } from '../responses.mjs';
import { codeFromText, refusalCode, isCode, isDebugTool } from '../refusal-codes.mjs';
import { wrap } from '../mcp.mjs';
import { outcomeOf, operationName } from '../../../../facade/friction-store.mjs';

const CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]{3,}$/; // UPPER_SNAKE, or one upper word (TIMEOUT)
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });
const textError = text => ({ content: [{ type: 'text', text }], isError: true });

// [tool, the refusal text of a real session, the code]
const REAL = [
  ['ssam_discover', 'Input validation error: Invalid arguments for tool ssam_discover: data/budgetBytes must be >= 4096', 'INPUT_INVALID'],
  ['ssam_task', 'Input validation error: Invalid arguments for tool ssam_task: close.reason: Too big: expected string to have <=500 characters', 'INPUT_INVALID'],
  ['ssam_evidence', 'Input validation error: Invalid arguments for tool ssam_evidence: budgetBytes: Too big: expected number to be <=65536', 'INPUT_INVALID'],
  ['ssam_debug_run', '[\n  {\n    "code": "custom",\n    "path": [\n      "action"\n    ],\n    "message": "Invalid input"\n  }\n]', 'INPUT_INVALID'],
  ['o11_studio', 'name: Invalid input: expected string, received undefined; Unrecognized key: "module"', 'INPUT_INVALID'],
  ['ssam_debug_run', 'debug_o11_native_execution_failed', 'DEBUG_O11_NATIVE_EXECUTION_FAILED'],
  ['ssam_debug_run', 'debug_odc_native_action_not_found:@eHXClc1vEk2367GDJ9efDw', 'DEBUG_ODC_NATIVE_ACTION_NOT_FOUND'],
  ['ssam_debug_run', 'debug_odc_native_development_not_at_latest: latest 81, Development runs null', 'DEBUG_ODC_NATIVE_DEVELOPMENT_NOT_AT_LATEST'],
  ['ssam_debug_run', 'dead code: no public entry reaches GetQuoteOptions', 'DEBUG_NO_PUBLIC_ENTRY'],
  ['ssam_map', 'discovery descriptor does not match the extracted sources:\nintegration.rest-import: contract pointer does not resolve: rest.shapes', 'DISCOVERY_INDEX_INVALID'],
  ['studio_status', 'The ODC bridge v39 is not attached to ODC Studio 73700 (no pipe for 10 s); call studio_attach', 'BRIDGE_NOT_ATTACHED'],
  ['ssam_app_url', 'No runtime origin for personal-qhdhnui7.outsystems.dev / Development. Pass environment (the runtime origin), or configure the exact stage domain.', 'RUNTIME_ORIGIN_MISSING'],
  ['studio_doctor', 'Unhandled exception. System.TimeoutException: The operation has timed out.', 'TIMEOUT'],
  ['o11_dependencies', 'ArgumentException: missing --out', 'ARGUMENT_INVALID'],
  ['o11_dependencies', 'SharpZipBaseException: Illegal rep length code', 'FILE_UNREADABLE'],
  ['o11_data', 'InvalidOperationException: Users and roles are out of reach of Edit Data here', 'OPERATION_INVALID'],
  // Goal list of 2026-10-20, item 2: the texts behind 184 SSAM_MAP_FAILED (11..20/10/2026).
  ['ssam_map', "No screen or block named 'Ordres'. MobileScreen:Orders @S1; MobileBlock:Card @B1", 'ELEMENT_NOT_FOUND'],
  ['ssam_map', "Ambiguous screen or block 'Card'. MobileBlock:Card @B1; WebBlock:Card @B2", 'AMBIGUOUS_ELEMENT'],
  ['ssam_map', 'Snapshot content changed: expectedSourceSha256 does not match the source bytes', 'CAPTURE_CHANGED'],
];

test('every real code-less refusal of the report gets its specific code, as JSON and as plain text', () => {
  for (const [tool, text, code] of REAL) {
    assert.equal(codeFromText(text, { tool }), code, text);
    const lane = /^(studio_|odc_)/.test(tool) ? 'odc' : 'o11';
    const structured = shapeToolResult(tool, {}, reply({ ok: false, error: text }), { lane });
    assert.equal(structured.structuredContent.code, code, tool + ': ' + text);
    assert.equal(JSON.parse(structured.content[0].text).code, code);
    assert.equal(structured.isError, true);
    // the SDK answers a plain text before the handler; relayed through the shaper it becomes {ok:false, code, error}
    const plain = shapeToolResult(tool, {}, textError(text), { lane });
    const value = JSON.parse(plain.content[0].text);
    assert.equal(plain.content.length, 1);
    assert.deepEqual([value.ok, value.code], [false, code], text);
    assert.equal(value.error, text, 'the text itself is kept');
  }
});

test('the store classifies the same texts with the same code, before OPERATION_FAILED', () => {
  for (const [tool, text, code] of REAL) {
    const operation = { tool: operationName(tool) };
    if (code === 'TIMEOUT') { assert.equal(outcomeOf({ ok: false, error: text }, {}, operation).code, 'TIMEOUT'); continue; }
    assert.equal(outcomeOf({ ok: false, error: text }, {}, operation).code, code, text);
    assert.equal(outcomeOf(textError(text), {}, operation).code, code, 'plain SDK text: ' + text);
  }
  // nothing known: the store keeps its generic code and an explicit code always wins
  assert.equal(outcomeOf({ ok: false, error: 'something nobody wrote down' }).code, 'OPERATION_FAILED');
  assert.equal(outcomeOf({ ok: false, code: 'PREFLIGHT_REFUSED', error: 'debug_o11_x_y' }).code, 'PREFLIGHT_REFUSED');
  assert.equal(outcomeOf(textError('Input validation error: x')).outcome, 'failure');
});

test('without a known text: the step the answer names, then the tool; uncertain stays uncertain; a code given is never replaced', () => {
  assert.equal(withRefusalCode('studio_deliver', { ok: false, failed: 'build', error: 'op 3 refused' }).code, 'BUILD_FAILED');
  assert.equal(withRefusalCode('studio_merge', { ok: false, gate: 'base_drift', error: 'the module changed' }).code, 'BASE_DRIFT');
  assert.equal(withRefusalCode('o11_studio', { ok: false, error: 'a refusal nobody coded' }).code, 'O11_STUDIO_FAILED');
  assert.equal(withRefusalCode('ssam_doctor', { ok: false, lanes: {} }).code, 'DOCTOR_LANE_UNUSABLE');
  assert.equal(withRefusalCode('studio_merge', { ok: false, outcome: 'uncertain', gate: 'equivalence' }).code, 'EQUIVALENCE_UNCERTAIN');
  assert.equal(withRefusalCode('o11_publish', { ok: false, outcome: 'uncertain' }).code, 'OUTCOME_UNCERTAIN');
  const coded = { ok: false, code: 'PREFLIGHT_REFUSED', error: 'debug_x_y' };
  assert.equal(withRefusalCode('o11_deliver', coded), coded);
  const jsonRpc = { ok: false, error: { code: 'BRIDGE_TIMEOUT', message: 'x' } };
  assert.equal(withRefusalCode('o11_inspect', jsonRpc), jsonRpc);
  const success = { ok: true, result: 'delivered' };
  assert.equal(withRefusalCode('o11_deliver', success), success);
  assert.equal(refusalCode({ value: { ok: false, error: 'nothing known' } }), null, 'without a tool (the store): no invented code');
  for (const [tool, text] of REAL) assert.ok(CODE.test(refusalCode({ tool, value: { error: text } })), text);
  assert.ok(isCode('INPUT_INVALID')); assert.ok(!isCode('OK')); assert.ok(!isCode('custom'));
});

test('the codes of A20 continue: the doctor of the index, the connect of an unusable lane, the attach of a lost pipe', () => {
  const index = shapeToolResult('ssam_map', { lane: 'odc', target: 'X' }, reply({ ok: false, error: 'discovery descriptor does not match the extracted sources:\nx' }), { lane: 'odc' });
  assert.deepEqual([index.structuredContent.continuation.tool, index.structuredContent.continuation.arguments], ['ssam_doctor', {}]);
  const doctor = shapeToolResult('ssam_doctor', { lane: 'o11' }, reply({ ok: false, lanes: { o11: { ok: false } } }), { lane: 'o11' });
  assert.deepEqual([doctor.structuredContent.code, doctor.structuredContent.continuation.tool, doctor.structuredContent.continuation.arguments], ['DOCTOR_LANE_UNUSABLE', 'ssam_connect', { lane: 'o11' }]);
  const pipe = shapeToolResult('studio_status', { pid: 73700 }, textError('The ODC bridge v39 is not attached to ODC Studio 73700 (no pipe for 10 s); call studio_attach'), { lane: 'odc' });
  assert.deepEqual(JSON.parse(pipe.content[0].text).continuation, { tool: 'studio_attach', arguments: { pid: 73700 }, why: JSON.parse(pipe.content[0].text).continuation.why });
});

test('a thrown error of the ODC server keeps its own code (PipeError), else the code of its text', async () => {
  const lost = await wrap(async () => { throw Object.assign(new Error('The ODC bridge v39 is not attached to ODC Studio 1 (no pipe for 10 s); call studio_attach'), { code: 'BRIDGE_NOT_ATTACHED' }); })({}, {});
  assert.equal(lost.structuredContent.code, 'BRIDGE_NOT_ATTACHED'); assert.equal(lost.isError, true);
  const zod = await wrap(async () => { throw new Error('[{"code":"custom","path":["action"],"message":"Invalid input"}]'); })({}, {});
  assert.equal(zod.structuredContent.code, 'INPUT_INVALID');
  const unknown = await wrap(async () => { throw new Error('a new failure'); })({}, {});
  assert.equal(unknown.structuredContent.code, undefined, 'the ssam shaper names it by its tool');
});

// Privacy review of 2026-10-12 (finding 1): the debugger's debug_<x> reasons become a code only in the debugger's own answers
// (not served by the hosted server). In any other answer a debug_-shaped word is the customer's (an object name quoted by a
// database error), never a code: the shaper names the failure by its tool, the friction store keeps OPERATION_FAILED.
test('debug_<x> becomes a code only in the answer of a debugger tool; elsewhere it is a word of the customer', async () => {
  const text = "Invalid object name 'debug_folha_pagamento_sntl'.";
  assert.equal(codeFromText(text), null);
  assert.equal(codeFromText(text, { tool: 'odc_read' }), null);
  assert.equal(codeFromText('debug_o11_native_execution_failed', { tool: 'ssam_debug_run' }), 'DEBUG_O11_NATIVE_EXECUTION_FAILED');
  assert.equal(codeFromText('debug_o11_native_execution_failed'), null, 'without the tool the rule does not apply');
  for (const tool of ['odc_read', 'o11_data', 'studio_command', 'ssam_discover', 'odc_portal_read']) {
    assert.equal(withRefusalCode(tool, { ok: false, error: text }).code, tool.toUpperCase() + '_FAILED', tool);
    const shaped = shapeToolResult(tool, {}, textError(text), { lane: 'odc' });
    assert.equal(JSON.parse(shaped.content[0].text).code, tool.toUpperCase() + '_FAILED', tool + ' (plain text)');
    assert.doesNotMatch(String(JSON.parse(shaped.content[0].text).code), /DEBUG|FOLHA|SNTL/);
  }
  assert.equal(outcomeOf({ ok: false, error: text }).code, 'OPERATION_FAILED');
  assert.equal(outcomeOf({ ok: false, error: text }, {}, { tool: operationName('odc_read') }).code, 'OPERATION_FAILED');
  assert.equal((await wrap(async () => { throw new Error(text); })({}, {})).structuredContent.code, undefined);
  for (const tool of ['ssam_debug', 'ssam_debug_run', 'ssam_debug_matrix', 'debug', 'debug-run', 'debug-invoke']) assert.equal(isDebugTool(tool), true, tool);
  for (const tool of ['odc_read', 'ssam_debugx', 'debugger', 'studio_debug', '', null]) assert.equal(isDebugTool(tool), false, String(tool));
});

test('warnings and warningsTotal travel in the delivery answer (I9), on "delivered" and on a refusal', () => {
  assert.ok(DELIVERY_FIELDS.includes('warnings') && DELIVERY_FIELDS.includes('warningsTotal'));
  const warnings = Array.from({ length: 20 }, (_, i) => ({ id: 'UnusedVariable', path: 'Screen' + i + '/Var', detail: 'unused', fix: 'remova o elemento ou use-o' }));
  const merged = compactDelivery('studio_deliver', { module: 'Quiz' }, { ok: true, merged: true, strictlyEqual: true, result: 'delivered', warnings, warningsTotal: 25, steps: [1] });
  assert.equal(merged.result, 'delivered'); assert.equal(merged.warnings.length, 20); assert.equal(merged.warningsTotal, 25);
  const refused = compactDelivery('studio_deliver', {}, { ok: false, code: 'PREFLIGHT_REFUSED', error: 'x', warnings: warnings.slice(0, 2) });
  assert.equal(refused.warnings.length, 2);
});
