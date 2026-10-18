// The closed registries of ssam-quality/1 (docs/QUALIDADE.md; privacy review of 2026-10-12, finding 1, and its re-check):
// CODES and RULES of the contract are generated from the product sources by platforms/odc/scripts/quality-registry.mjs.
// Drift: a code that appears in the sources (a literal, or a code the product composes from a word of its sources) and is
// missing from the registry fails here, and so does a source of the hosted path outside the scanned roots; the fix is
//   node platforms/odc/scripts/quality-registry.mjs --write
// then the parity sha of quality-line.test.mjs and the console's copies (docs/QUALIDADE.md). Sentinels: a new constant, a
// new verb, integration op, stage or gate in a source tree is reported missing and stays CODE_UNLISTED until the registry
// has it; tests and the contract itself are not sources; the customer words of the review are in no registry.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODES, RULES, STEPS, codeOf, ruleOf, CODE_UNLISTED, RULE_UNLISTED } from '../quality-line.mjs';
import { scanSources, driftOf, renderBlock, blockOf, literalsOf, rulesOf, verbsOf, operationsOf, composedWordsOf, invalidCodeOf, refusedCodeOf,
  publishGateCodeOf, coverageOf, compiledSources, hostedHandlers, isScanned, ROOT, ROOTS, CONTRACTS, TOOLS_JSON, BRIDGES, VERB_SURFACE,
  COMMAND_SURFACE } from '../../scripts/quality-registry.mjs';
import { HTML_CODES, HTML_WARNING_CODES, PROTOTYPE_CODES, refusalCode } from '../refusal-codes.mjs';
import { publishOutcomeOf } from '../kernel-delivery.mjs';

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));
const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-quality-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  return { dir, write };
};

test('drift: every code of the product sources (literal or composed) and every JobNormalizer rule is in the registry', async () => {
  const scan = await scanSources(ROOT);
  const d = driftOf(scan, { CODES, RULES });
  const fix = ' (node platforms/odc/scripts/quality-registry.mjs --write, then the parity sha and the console copies)';
  assert.deepEqual(d.missingCodes, [], 'codes of the sources missing from the registry' + fix);
  assert.deepEqual(d.missingRules, [], 'rules of JobNormalizer missing from the registry' + fix);
  // A box without every source root (the server box of SSAM-MCP has no agent/) checks only what it has.
  if (scan.absent.length) return;
  assert.deepEqual(d.staleCodes, [], 'registry codes no source declares any more' + fix);
  assert.deepEqual(d.staleRules, [], 'registry rules JobNormalizer no longer declares' + fix);
  for (const rel of CONTRACTS) assert.equal(blockOf(fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')), renderBlock(scan), rel + ': the generated block');
});

// Re-check finding 1: the codes the product builds at runtime, each family recomputed here from its own source and, for the
// facade's composers, through the composer itself.
test('the composed families: <VERB>_INVALID, <OP>_REFUSED, the shaper\'s step and gate codes and PUBLISH_<GATE> are listed', async () => {
  const codes = new Set(CODES);
  const scan = await scanSources(ROOT);
  // JobPreflight.cs composes <VERB>_INVALID from the op of a job; SoapPlan.cs <OP>_REFUSED from the integration op. The
  // generator mirrors these two lines: a change of either rule fails here until the generator follows it.
  const preflight = read('kernel/src/Anvil.Core/Kernel/JobPreflight.cs');
  assert.ok(preflight.includes('var code = (kind.Length == 0 ? "OP" : Regex.Replace(kind, "[^A-Za-z0-9]", "_").ToUpperInvariant()) + "_INVALID";'), 'JobPreflight.cs: the <VERB>_INVALID rule');
  assert.ok(read('kernel/src/Anvil.Core/Kernel/SoapPlan.cs').includes('op.ToUpperInvariant().Replace(\'-\', \'_\') + "_REFUSED"'), 'SoapPlan.cs: the <OP>_REFUSED rule');
  const verbs = verbsOf(read(VERB_SURFACE)), operations = operationsOf(read(COMMAND_SURFACE));
  assert.ok(verbs.size >= 20 && verbs.has('set') && verbs.has('create') && verbs.has('usages'), 'VerbSurface.Verbs read');
  assert.ok(operations.has('logic') && operations.has('html-visual') && operations.has('soap'), 'CommandSurface.OperationNames read');
  assert.deepEqual(scan.families.verbs, [...verbs].sort()); assert.deepEqual(scan.families.operations, [...operations].sort());
  for (const kind of ['', ...verbs, ...operations]) assert.ok(codes.has(invalidCodeOf(kind)), invalidCodeOf(kind));
  for (const code of ['SET_INVALID', 'CREATE_INVALID', 'SPEC_INVALID', 'SCREEN_INVALID', 'REST_INVALID', 'REST_EXPOSE_INVALID', 'HTML_VISUAL_INVALID', 'OP_INVALID'])
    assert.ok(codes.has(code), code);
  assert.deepEqual(scan.families.integrationOps, ['rest', 'rest-expose', 'soap']);
  for (const op of scan.families.integrationOps) assert.ok(codes.has(refusedCodeOf(op)), refusedCodeOf(op));
  // The shaper (refusal-codes.mjs refusalCode, through stepCode) on an answer that names only its stage or its gate, and
  // publishOutcomeOf on a refused publication: every code they give for a word of the sources is listed.
  assert.ok(scan.families.steps.length > 30 && scan.families.gates.length > 10);
  for (const word of scan.families.steps) {
    const code = refusalCode({ value: { ok: false, stage: word } });
    if (code) assert.ok(codes.has(code), 'stage ' + word + ' -> ' + code);
  }
  for (const gate of scan.families.gates) {
    const code = refusalCode({ value: { ok: false, gate } });
    if (code) assert.ok(codes.has(code), 'gate ' + gate + ' -> ' + code);
    const published = publishOutcomeOf({ ok: false, outcome: 'gate_refused', gate }).code;
    assert.equal(published, publishGateCodeOf(gate) ?? 'PUBLISH_REFUSED', gate);
    if (/^[A-Z][A-Z0-9_]*$/.test(published)) assert.ok(codes.has(published), 'publish gate ' + gate + ' -> ' + published);
  }
  for (const code of ['KERNEL_FAILED', 'RUNNER_FAILED', 'PUBLISH_WAIT_FAILED', 'UPLOAD_REQUEST_FAILED', 'CREATE_REVISION_FAILED', 'SRP_SIGNIN_FAILED', 'FINAL_FAILED',
    'PUBLISH_VAULT_UNAVAILABLE', 'PUBLISH_SECRET_NOT_FOUND', 'PUBLISH_AUTHORSHIP', 'PUBLISH_BASE_DRIFT', 'BASE_DRIFT', 'STUDIO_BUSY', 'KNOWN_LOSSES', 'EQUIVALENCE_FAILED'])
    assert.ok(codes.has(code), code);
  // The ODC bridge's gate vocabulary (Journal.Gate), the gate arguments of PortalCore's refusals and ScSecrets' Gate helper.
  for (const gate of ['base_drift', 'equivalence', 'authorship', 'provider_state', 'pending_match', 'studio_busy', 'key_not_found', 'scope', 'candidate_validation',
    'retry_refused', 'upload_redirect', 'tenant_read_only', 'secret_refs_write_only', 'vault_unavailable', 'secret_not_found', 'known_losses'])
    assert.ok(scan.families.gates.includes(gate), gate);
  // no word of a message, a call or an outer tuple is read as a step or a gate
  for (const word of ['failed', 'rejected', 'refused', 'string', 'function']) assert.ok(!scan.families.steps.includes(word) && !scan.families.gates.includes(word), word);
});

test('the step and gate words: slots, conditional arms and defaults, gate helpers and arguments, the Gate method; never a call or a message', () => {
  const js = composedWordsOf([
    "return { ok: false, failed: 'merge', stage: \"kernel\" };",
    "const answer = { stage: same ? 'open' : 'close', gate: entry.gate ?? 'none' };",
    "stage = 'link'; if (stage === 'nope') x(); const s = { stage: fn('notaslot'), failed: { type: 'string' }, gate: [ 'arr' ] };",
    "throw Object.assign(new Error('x'), { stage: error.stage });",
  ].join('\n'));
  assert.deepEqual([...js.steps].sort(), ['close', 'kernel', 'link', 'merge', 'open']);
  assert.deepEqual([...js.gates], ['none']);
  const cs = composedWordsOf([
    'details: new JsonObject { ["target"] = t, ["gate"] = "vault_unavailable" });',
    'var check = new { ok = x, gate = x ? "none" : "base_drift", note = "Open module; differs" };',
    'c.GateName = "known_losses"; result["stage"] = "model";',
    'throw new Refusal("NOT_ALLOWED", "sent by this bridge (" + path + "); a write is never sent twice.", "retry_refused");',
    'return (Fail("STUDIO_NOT_SIGNED_IN", "renewal failed (" + host + ")"), write ? "rejected" : "failed");',
    'return Done(PortalCore.Fail("UPLOAD_REJECTED", "a redirect (" + status + "); never followed", "upload_redirect"), "refused");',
    'private static JsonObject Gate(string gate) => new() { ["gate"] = gate }; var d = Gate("secret_target_host");',
    'public static string Gate(string? message) { var t = message ?? ""; if (t.Contains("{")) return "base_drift"; return "none"; }',
    'throw new IntegrationRefusalException("rest-expose", problems);',
  ].join('\n'));
  assert.deepEqual([...cs.steps], ['model']);
  assert.deepEqual([...cs.gates].sort(), ['base_drift', 'known_losses', 'none', 'retry_refused', 'secret_target_host', 'upload_redirect', 'vault_unavailable']);
  assert.deepEqual([...cs.integrationOps], ['rest-expose']);
  assert.deepEqual([...verbsOf('new("set", "write", ["target"], []), new("get", "read", [], []), new("X", "write"), new("nope", "other")')], ['set', 'get']);
  assert.deepEqual([...operationsOf('public static readonly IReadOnlyList<string> OperationNames = ["logic", "html-visual"];')], ['logic', 'html-visual']);
  assert.equal(invalidCodeOf('rest-expose'), 'REST_EXPOSE_INVALID'); assert.equal(invalidCodeOf(''), 'OP_INVALID');
  assert.equal(refusedCodeOf('rest-expose'), 'REST_EXPOSE_REFUSED');
  assert.equal(publishGateCodeOf('none'), null); assert.equal(publishGateCodeOf('authorship'), 'PUBLISH_AUTHORSHIP');
});

test('sentinel: a new constant, verb, operation, integration op, stage, gate, hosted tool or normalizer rule is reported missing and stays unlisted', async t => {
  const { dir, write } = temp(t);
  write('platforms/odc/facade/nova.mjs', "export const nova = () => ({ ok: false, code: 'QUALITY_SENTINEL_NEW_CODE', stage: 'sentinel-stage', error: 'texto' });\n");
  write('agent/lib/nova.mjs', 'export const E = `QUALITY_SENTINEL_AGENT_CODE`;\n');
  write('kernel/src/Anvil.Core/Kernel/Nova.cs', 'var p = new JsonObject { ["code"] = "QUALITY_SENTINEL_KERNEL_CODE", ["severity"] = "error", ["gate"] = "sentinel_gate" };\n' +
    'throw new IntegrationRefusalException("sentinel-op", problems);\n');
  write('kernel/query-test/Nova.cs', 'return Fail("QUALITY_SENTINEL_QUERY_TEST_CODE", "texto");\n');
  write(VERB_SURFACE, 'public static readonly IReadOnlyList<VerbShape> Verbs = [ new("set", "write", [], [], ""), new("sentinel-verb", "write", ["data"], [], "") ];\n');
  write(COMMAND_SURFACE, 'public static readonly IReadOnlyList<string> OperationNames = ["logic", "sentinel-operation"];\n');
  write('kernel/src/Anvil.Core/Kernel/Preflight/JobNormalizer.cs', 'public const string SortKeysSplit = "SORT_KEYS_SPLIT";\n    public const string Nova = "QUALITY_SENTINEL_NEW_RULE";\n');
  write(TOOLS_JSON, JSON.stringify({ tools: { odc_read: {}, ssam_sentinela: {} } }));
  // not sources: tests, fixtures, node_modules and the contract itself
  write('platforms/odc/facade/tests/nova.test.mjs', "const s = 'QUALITY_SENTINEL_TEST_ONLY'; const v = { stage: 'test-only-stage' };\n");
  write('platforms/odc/portal/fixtures/x.mjs', "const s = 'QUALITY_SENTINEL_FIXTURE_ONLY';\n");
  write('platforms/odc/facade/node_modules/pkg/index.js', "const s = 'QUALITY_SENTINEL_DEPENDENCY';\n");
  write('kernel/query-test/tests/Nova.cs', 'var s = "QUALITY_SENTINEL_QUERY_TEST_TEST";\n');
  write('platforms/odc/facade/quality-line.mjs', "const CODE_TEXT = `\nQUALITY_SENTINEL_SELF\n`; const x = 'QUALITY_SENTINEL_SELF_LITERAL';\n");
  const scan = await scanSources(dir, { steps: ['build'] });
  const d = driftOf(scan, { CODES, RULES });
  assert.deepEqual(d.missingCodes, ['PUBLISH_SENTINEL_GATE', 'QUALITY_SENTINEL_AGENT_CODE', 'QUALITY_SENTINEL_KERNEL_CODE', 'QUALITY_SENTINEL_NEW_CODE',
    'QUALITY_SENTINEL_NEW_RULE', 'QUALITY_SENTINEL_QUERY_TEST_CODE', 'SENTINEL_GATE', 'SENTINEL_OPERATION_INVALID', 'SENTINEL_OP_REFUSED', 'SENTINEL_STAGE_FAILED',
    'SENTINEL_VERB_INVALID', 'SSAM_SENTINELA_FAILED']);
  assert.deepEqual(d.missingRules, ['QUALITY_SENTINEL_NEW_RULE']);
  for (const word of ['QUALITY_SENTINEL_TEST_ONLY', 'QUALITY_SENTINEL_FIXTURE_ONLY', 'QUALITY_SENTINEL_DEPENDENCY', 'QUALITY_SENTINEL_SELF', 'QUALITY_SENTINEL_SELF_LITERAL',
    'QUALITY_SENTINEL_QUERY_TEST_TEST', 'TEST_ONLY_STAGE_FAILED'])
    assert.ok(!scan.codes.has(word), word);
  assert.ok(scan.codes.has('ODC_READ_FAILED') && scan.codes.has('BUILD_FAILED') && scan.codes.has('SET_INVALID') && scan.codes.has('LOGIC_INVALID') && scan.codes.has('OP_INVALID'),
    'the composed families');
  // until the registry is regenerated, the contract keeps none of them
  for (const code of d.missingCodes) assert.equal(codeOf(code), CODE_UNLISTED, code);
  assert.equal(ruleOf('QUALITY_SENTINEL_NEW_RULE'), RULE_UNLISTED);
  // the generated block of that tree carries them
  const block = renderBlock(scan);
  assert.match(block, /QUALITY_SENTINEL_NEW_CODE/); assert.match(block, /SENTINEL_VERB_INVALID/); assert.match(block, /'QUALITY_SENTINEL_NEW_RULE'/);
  assert.ok(block.split('\n').every(l => l.length <= 140), 'wrapped');
});

test('literals: UPPER_SNAKE between quotes only; JobNormalizer constants only', () => {
  assert.deepEqual([...literalsOf("a('AB_CD'); b(\"EF\"); c(`GH_1`); d('ij_kl'); e('A__B'); f('X'); g('_Y'); h(`T_${x}`); i('LONG TEXT')")].sort(), ['AB_CD', 'EF', 'GH_1']);
  assert.deepEqual([...rulesOf('public const string A = "SORT_KEYS_SPLIT";\nprivate const string B = "NOPE_X";\npublic const string C = "lower";')], ['SORT_KEYS_SPLIT']);
});

// Re-check finding 2: kernel/query-test (the ssam_query_test codes) is compiled into both bridges and was not scanned. Every
// C# source compiled into a project of the scanned C# roots, and the file that registers every hosted tool, must be scanned.
test('coverage: every source compiled into the bridges and the kernel, and every hosted tool\'s handler, is under a scanned root', t => {
  const cover = coverageOf(ROOT);
  const present = BRIDGES.filter(exists);
  if (!present.length) { t.skip('no bridge project here'); return; }
  for (const project of present) assert.ok(cover.projects.includes(project), project);
  assert.deepEqual(cover.missingProjects, [], 'a ProjectReference that does not resolve');
  assert.deepEqual(cover.outside, [], 'compiled sources outside the scanned roots (add their folder to ROOTS in quality-registry.mjs)');
  assert.ok(cover.compiled > 100);
  // the query-test sources, compiled into both bridges through a glob, are compiled and scanned
  for (const project of present) {
    const { files } = compiledSources(ROOT, [project]);
    const queryTest = [...files.keys()].filter(f => /[\\/]kernel[\\/]query-test[\\/]QueryTest\w*\.cs$/.test(f));
    assert.ok(queryTest.length >= 3, project + ' compiles kernel/query-test');
    for (const f of queryTest) assert.ok(isScanned(ROOT, f), f);
  }
  assert.ok(ROOTS.some(r => r.dir === 'kernel/query-test'));
  if (!exists(TOOLS_JSON)) return;
  const tools = JSON.parse(read(TOOLS_JSON)).tools;
  const served = Object.entries(tools).filter(([, def]) => def.class !== 'unavailable').map(([name]) => name);
  assert.deepEqual(Object.keys(cover.handlers).sort(), served.sort());
  assert.deepEqual(cover.unhandled, [], 'hosted tools without a registering file');
  assert.deepEqual(cover.handlersOutside, [], 'hosted tools registered outside the scanned roots');
  assert.ok(cover.handlers.ssam_query_test.includes('platforms/odc/facade/query-test.mjs'));
  assert.ok(cover.handlers.o11_publish.includes('platforms/odc/facade/o11-publish.mjs'), 'registerTool(TOOL) with const TOOL');
  assert.ok(cover.handlers.ssam_friction.length >= 1, 'a { name } tool definition');
});

test('coverage sentinel: a bridge that compiles an unscanned folder and a hosted tool registered outside the roots are reported', t => {
  const { dir, write } = temp(t);
  write('platforms/odc/studio/bridge/Bridge.csproj', '<Project><PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup>' +
    '<Compile Include="StartupHook.cs" /><Compile Include="../../../../kernel/query-test/*.cs" Link="QueryTest/%(Filename)%(Extension)" />' +
    '<Compile Include="..\\..\\..\\..\\kernel\\elsewhere\\**\\*.cs" /></ItemGroup></Project>');
  write('platforms/odc/studio/bridge/StartupHook.cs', 'class A {}');
  write('platforms/odc/studio/bridge/NotCompiled.cs', 'class B {}');
  write('kernel/query-test/QueryTestOutput.cs', 'class C {}');
  write('kernel/elsewhere/deep/Hidden.cs', 'var c = "HIDDEN_CODE";');
  write('kernel/src/Anvil.Bridge/Anvil.Bridge.csproj', '<Project><ItemGroup><ProjectReference Include="..\\Anvil.Core\\Anvil.Core.csproj" /></ItemGroup></Project>');
  write('kernel/src/Anvil.Bridge/Server.cs', 'class D {}');
  write('kernel/src/Anvil.Bridge/tests/Compiled.cs', 'class E {}');
  write('kernel/src/Anvil.Core/Anvil.Core.csproj', '<Project><ItemGroup><Compile Include="../../tools/Shared.cs" /></ItemGroup></Project>');
  write('kernel/src/Anvil.Core/Core.cs', 'class F {}');
  write('kernel/tools/Shared.cs', 'class G {}');
  write(TOOLS_JSON, JSON.stringify({ tools: { odc_read: { class: 'agent' }, ssam_sentinela: { class: 'server' }, ssam_sem_registro: { class: 'server' }, context: { class: 'unavailable' } } }));
  write('platforms/odc/facade/odc-read.mjs', "server.registerTool('odc_read', {}, run);\n");
  write('scripts/outro/sentinela.mjs', "server.registerTool('ssam_sentinela', {}, run);\n");
  write('platforms/odc/facade/tests/sem-registro.test.mjs', "server.registerTool('ssam_sem_registro', {}, run);\n");
  const cover = coverageOf(dir);
  assert.deepEqual(cover.projects, ['kernel/src/Anvil.Bridge/Anvil.Bridge.csproj', 'kernel/src/Anvil.Core/Anvil.Core.csproj', 'platforms/odc/studio/bridge/Bridge.csproj']);
  assert.deepEqual(cover.outside.map(o => o.file).sort(), ['kernel/elsewhere/deep/Hidden.cs', 'kernel/src/Anvil.Bridge/tests/Compiled.cs', 'kernel/tools/Shared.cs']);
  assert.ok(!cover.outside.some(o => /NotCompiled|QueryTestOutput|StartupHook|Server\.cs|Core\.cs/.test(o.file)));
  assert.deepEqual(cover.handlers, { odc_read: ['platforms/odc/facade/odc-read.mjs'], ssam_sentinela: ['scripts/outro/sentinela.mjs'], ssam_sem_registro: [] });
  assert.deepEqual(cover.unhandled, ['ssam_sem_registro']);
  assert.deepEqual(cover.handlersOutside, [{ tool: 'ssam_sentinela', file: 'scripts/outro/sentinela.mjs' }]);
  assert.equal(hostedHandlers(dir).context, undefined, 'an unavailable tool has no handler to find');
});

test('the registry holds the shaper\'s own families and none of the review\'s customer words', () => {
  const codes = new Set(CODES);
  for (const c of [...HTML_CODES, ...HTML_WARNING_CODES, ...PROTOTYPE_CODES, 'DOCTOR_LANE_UNUSABLE', 'INPUT_INVALID', 'PREFLIGHT_REFUSED', 'AGENT_NOT_CONNECTED',
    'COMMAND_NOT_ALLOWED', 'BRIDGE_NOT_ATTACHED', 'TIMEOUT', 'OPERATION_FAILED'])
    assert.ok(codes.has(c), c);
  const tools = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, TOOLS_JSON), 'utf8')).tools);
  for (const tool of tools) assert.ok(codes.has(tool.toUpperCase() + '_FAILED'), tool);
  for (const step of STEPS) assert.ok(codes.has(step.toUpperCase().replaceAll('-', '_') + '_FAILED'), step);
  for (const word of ['OSUSR_K3X_FOLHA_SNTL', 'DEBUG_FOLHA_PAGAMENTO_SNTL', 'CLIENTE_ACME_SNTL']) assert.ok(!codes.has(word) && !RULES.includes(word), word);
  assert.ok(![...codes].some(c => /DEBUG_[A-Z0-9_]*SNTL/.test(c)));
});
