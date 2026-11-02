// Contract tests of ssam-quality/1 (C:\t\qual\DESIGN-QUALIDADE.md section 2), shared by both lanes:
//   node --test C:\t\qual\fixtures\quality-line.test.mjs
// SERVER copies it to platforms/odc/facade/tests/quality-line.test.mjs, CONSOLE to server/deploy/console/tests/quality-line.test.mjs,
// each with FIXTURES pointing at its own copy of this folder (tests/fixtures/quality/).
// Server lane copy: the module is ../quality-line.mjs, the fixtures tests/fixtures/quality/; the last test is the parity check (D9).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sanitizeQualityLine, fitLine, loadNativeIds, codeOf, ruleOf, opWordOf, agentLabel, agentVerbOf, AGENT_VERBS, ODC_COMMANDS, O11_METHODS, MAX_LINE_BYTES, NATIVE_UNLISTED,
  CODE_UNLISTED, RULE_UNLISTED, CODES, RULES, OPS, PLACEHOLDER_CODES } from '../quality-line.mjs';

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
  assert.deepEqual([...RULES], ['LIST_ENTITY_SEGMENT_DROPPED', 'NULL_FUNCTION_REWRITTEN', 'OP_DATA_WRAPPED', 'PROPERTY_SET_DROPPED', 'SOAP_CLIENT_RENAMED', 'SORT_KEYS_SPLIT']);
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
  for (const code of ['SET_INVALID', 'CREATE_INVALID', 'SPEC_INVALID', 'SCREEN_INVALID', 'REST_INVALID', 'REST_EXPOSE_INVALID', 'AGENT_INVALID', 'DELETE_INVALID',
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

// D9: this lane's copy of the contract is the shared one, byte for byte (CRLF read as LF), so writer and reader never disagree.
test('parity: platforms/odc/facade/quality-line.mjs is the shared ssam-quality/1 contract', () => {
  const text = fs.readFileSync(fileURLToPath(new URL('../quality-line.mjs', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), 'ce0d578702f214d63a2b9e29963966660e8314dfe45b9f900e8378933e00bdd0'); // servidor/fase4-26 a7: OPS gains tool (CX11); phase 2: REFERENCE_DAY_LIMIT, REFERENCE_NOT_SERVED; phase 3: ANSWER_ORIGIN_UNKNOWN and the server root variables; a8: DELIVERY_STILL_RUNNING; AGENT_FOLDER_UNKNOWN, PLAN_NOT_DELIVERED (ssam_code served hosted); phase 6: both merges, the agent pack's server side included, and SSAM_HOSTED_SSAM_CODE; a9: marco-a6 (CX13, X3, html edit names, data table), round 5 (TABLE_CELL_SPAN); a11: the proto-into-product merge and the friction views timeline, reports and delivery-kpi; MERGE_SECURITY_WARNING (registry --write); fase4-28/r2: the R2 packages (registry --write); r2-resolver: CALL_AMBIGUOUS and REFERENCE_CANONICAL (registry --write); fase4-28 r2-preview: ssam_render and screen.render codes, the render stages (registry --write); R2-B: CHILD_BY_NAME, PLATFORM_NAME_KEPT and CHILD_KIND_CHOICE (registry --write); R2-D: CSS_DATA_URL_IMAGE, CSS_STYLE_REPLACED, SHADOWED_FAILED (registry --write); R2-C: HTML_TEXT_ESCAPED, IMG_PATH_EXPRESSION, IMG_PATH_IMAGE, RECORD_ENTITY_MEMBER_ADDED, TYPE_SIZE_DROPPED (registry --write); R3-A: HTML_PLATFORM_*, RENDER_PLATFORM_SHEETS_MISSING, ANVIL_RUNTIME_CSS_DIR (registry --write); R3-B: ELEMENT_REQUIRES_OP, IMAGE_FACTS_*, IMAGE_FORMAT_UNKNOWN, PLATFORM_NAME_LIMIT (registry --write); R3-C: N1_ABBREVIATION, ABBREVIATION_EXPANDED, ABBREVIATION_CHOICE (registry --write); r3-gate-bridge: STUDIO_NOT_IDLE, restored with the bound on a queued job, and MERGE_NOT_IN_MODULE (registry --write); MODULE_NOT_AT_BASE, the check of the base sha after a cut merge (registry --write); CUT_RECORD_NOT_WRITTEN, CUT_RECORD_UNREADABLE (registry --write); R3-C: N1_ABBREVIATION, ABBREVIATION_EXPANDED, ABBREVIATION_CHOICE (registry --write). fase4-28 r4: OP_DATA_WRAPPED, SOAP_CLIENT_RENAMED, SOAP_PRIMITIVE_RETYPED (SOAP F7). OPS o11_users and the USERS_* codes (r4 users). OPS o11_users, kind o11.users and the USERS_* codes (r4 users). OPS o11_users, kind o11.users, USERS_* (r4 users). r4 users: final registry. r4 users after the review: the agent's codes. fase4-28 r4 P7: the codes of o11_users that the agent answers, listed. fase4-28 r4: USERS_PASSWORD_FORM_NOT_KNOWN. fase4-28 r4: USERS_RECEIPT_KEY_MISSING. ; gate of 2026-10-30: PRODUCER_SIGNATURE_UNVERIFIED. Merge of fase4-28/r3 0e071c77.; r4-proto-o11 on the line; fase4-28 r4-w2-diag B12: SC_ARGUMENT_INVALID, SC_PAGE_NOT_FOUND, SC_WRITE_*, USERS_PAGE_NOT_FOUND (registry --write).; fase4-28 r4-w2-diag B13: ENVIRONMENT_SESSION_EXPIRED (registry --write).; fase4-28 r4-w2-diag B13: VAULT_API_UNAVAILABLE, CREDENTIAL_PROMPT_* of the managed O11 window (registry --write).; r4-w2-flow: FLOW_PRODUCER_CALL_SYNTAX, ONINITIALIZE_SERVER_CALL (registry --write); r4-integracao: merge of r4-w2-flow, FLOW_PRODUCER_CALL_SYNTAX, ONINITIALIZE_SERVER_CALL (registry --write); fase4-28 r4-u2: FLOW_CALLBACK_CREATION, _NAME, _PARAMETERS, _UNKNOWN; servidor/fase4-26 a7: OPS gains tool (CX11); phase 2: REFERENCE_DAY_LIMIT, REFERENCE_NOT_SERVED; phase 3: ANSWER_ORIGIN_UNKNOWN and the server root variables; a8: DELIVERY_STILL_RUNNING; AGENT_FOLDER_UNKNOWN, PLAN_NOT_DELIVERED (ssam_code served hosted); phase 6: both merges, the agent pack's server side included, and SSAM_HOSTED_SSAM_CODE; a9: marco-a6 (CX13, X3, html edit names, data table), round 5 (TABLE_CELL_SPAN); a11: the proto-into-product merge and the friction views timeline, reports and delivery-kpi; MERGE_SECURITY_WARNING (registry --write); fase4-28/r2: the R2 packages (registry --write); r2-resolver: CALL_AMBIGUOUS and REFERENCE_CANONICAL (registry --write); fase4-28 r2-preview: ssam_render and screen.render codes, the render stages (registry --write); R2-B: CHILD_BY_NAME, PLATFORM_NAME_KEPT and CHILD_KIND_CHOICE (registry --write); R2-D: CSS_DATA_URL_IMAGE, CSS_STYLE_REPLACED, SHADOWED_FAILED (registry --write); R2-C: HTML_TEXT_ESCAPED, IMG_PATH_EXPRESSION, IMG_PATH_IMAGE, RECORD_ENTITY_MEMBER_ADDED, TYPE_SIZE_DROPPED (registry --write); R3-A: HTML_PLATFORM_*, RENDER_PLATFORM_SHEETS_MISSING, ANVIL_RUNTIME_CSS_DIR (registry --write); R3-B: ELEMENT_REQUIRES_OP, IMAGE_FACTS_*, IMAGE_FORMAT_UNKNOWN, PLATFORM_NAME_LIMIT (registry --write); R3-C: N1_ABBREVIATION, ABBREVIATION_EXPANDED, ABBREVIATION_CHOICE (registry --write); r3-gate-bridge: STUDIO_NOT_IDLE, restored with the bound on a queued job, and MERGE_NOT_IN_MODULE (registry --write); MODULE_NOT_AT_BASE, the check of the base sha after a cut merge (registry --write); CUT_RECORD_NOT_WRITTEN, CUT_RECORD_UNREADABLE (registry --write); R3-C: N1_ABBREVIATION, ABBREVIATION_EXPANDED, ABBREVIATION_CHOICE (registry --write). fase4-28 r4: OP_DATA_WRAPPED, SOAP_CLIENT_RENAMED, SOAP_PRIMITIVE_RETYPED (SOAP F7). OPS o11_users and the USERS_* codes (r4 users). OPS o11_users, kind o11.users and the USERS_* codes (r4 users). OPS o11_users, kind o11.users, USERS_* (r4 users). r4 users: final registry. r4 users after the review: the agent's codes. fase4-28 r4 P7: the codes of o11_users that the agent answers, listed. fase4-28 r4: USERS_PASSWORD_FORM_NOT_KNOWN. fase4-28 r4: USERS_RECEIPT_KEY_MISSING. ; gate of 2026-10-30: PRODUCER_SIGNATURE_UNVERIFIED. Merge of fase4-28/r3 0e071c77.; r4-proto-o11 on the line; r4-integracao: merge of r4-u2-rest-callback, FLOW_CALLBACK_* (registry --write); r4-telas-b1-fac C-01: PATCH_DESTRUCTIVE (registry --write).; r4-telas-b1-fac C-18: EDIT_TEXT_NOT_FOUND of the find edits of a read action (registry --write).; r4-telas-b1-fac C-49: STUDIO_UPDATED, CONNECTOR_BUILD_FAILED (registry --write). r4-telas-b1: merge of the facade group (registry --write). r4-telas-b1 K2 C-01 b: HTML_DATA_EDIT (registry --write). K2 C-35: HTML_EDIT_TEXT_NOT_FOUND (registry --write).; r4-integracao: merge of r4-telas-b1 5b37aaa2, + AGGREGATE_JOIN_SOURCES CONNECTOR_BUILD_FAILED CSS_IMPORT_MOVED DDL_DEFAULT_NULL_DROPPED EDIT_TEXT_NOT_FOUND FLOW_PREPARATION_DESCRIPTION HTML_ACTION_NAME_TAKEN HTML_DATA_EDIT HTML_EDIT_TEXT_NOT_FOUND HTML_EVENT_OPENS_SCREEN HTML_HREF_UNSUPPORTED HTML_INPUT_TYPE_MISMATCH HTML_SITE_PROPERTY_IN_CLIENT HTML_THEME_STYLE_LIFTED HTML_WIDGET_NAME_IS_ID LINK_HREF_REWRITTEN PATCH_DESTRUCTIVE STUDIO_UPDATED (registry --write); r4-telas-b1b2: merge of r4-telas-b2, HTML_LIST_RECORDS_LINE_COUNT, HTML_LIST_ROW (registry --write); r4-integracao: merge of r4-b1b2 0783d992 (registry --write); r4-w3-preview B14: PREVIEW_PROFILE_PREPARED, PREVIEW_INPUT_SCHEMA, PREVIEW_PREPARE_FAILED, PREVIEW_PIN (registry --write). Round 2: PREVIEW_PREPARE_BUSY of the shared prepare lock (registry --write); r4-integracao: merge of r4-w3-preview ce1645c9 (registry --write); r4-w3-css B4: CSS_TARGET_UNSERVED (registry --write). r4-w3-css B15: IMAGE_CONTENT_REPLACED (registry --write); r4-integracao: merge of r4-w3-css cf06df83 (registry --write); r4-w3-edit F8: HTML_TABLE_LIST_VIRTUALIZED, LIST_MODE_CUSTOM, TABLE_LIST_REPAIRED, TABLE_ROW_LIST_LIFTED (registry --write); F10: HTML_DECLARATIONS_FIRST, HTML_EDIT_SPLIT, HTML_EVENT_ARGUMENTS, HTML_BR_CONTAINER, HTML_DROPDOWN_ROW, HTML_TYPE_UNQUALIFIED (registry --write); r4-w3-edit round 2: HTML_DECLARATION_KEYED in, HTML_DROPDOWN_ROW out (DROPDOWN_ITEM_SCOPE) (registry --write); r4-integracao: merge of r4-w3-edit 02f271ac (registry --write); fase4-28/r4-integracao: reconcile-merge in ODC_COMMANDS (the agent contract of agent/r4-v106 A1); fase4-28 r4-f3-import: integration_import in O11_METHODS (thin bridge 1.1.0), DOCUMENT_FETCH_HOSTED_REFUSED and DOCUMENT_INLINE_INVALID (registry --write); F4 of PLANO-11H: kind o11.xif, XIF_AGENT_UPDATE_REQUIRED (registry --write); F4 review: HOSTED_FILE_TOO_LARGE, HOSTED_FILE_CHANGED (registry --write); F6: merge of fase4-28/r4-xif-agent (registry --write); rest-hosted: DOCUMENT_FETCH_HOSTED_REFUSED of rest-consume, the family code of F3 (registry --write); F6: merge of fase4-28/r4-rest-hosted (registry --write); F1b: ANVIL_STUDIO_BUSY_WAITS_MS (registry --write); F6: merge of fase4-28/r4-int-f1b (registry --write)
});
