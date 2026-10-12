// The closed registries of ssam-quality/1 (docs/QUALIDADE.md; privacy review of 2026-10-12, finding 1): CODES and RULES of
// the contract are generated from the product sources by platforms/odc/scripts/quality-registry.mjs. Drift: a constant that
// appears in the sources and is missing from the registry fails here; the fix is
//   node platforms/odc/scripts/quality-registry.mjs --write
// then the parity sha of quality-line.test.mjs and the console's copies (docs/QUALIDADE.md). Sentinels: a new constant in a
// source tree is reported missing and stays CODE_UNLISTED until the registry has it; tests and the contract itself are not
// sources; the customer words of the review are in no registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODES, RULES, STEPS, codeOf, ruleOf, CODE_UNLISTED, RULE_UNLISTED } from '../quality-line.mjs';
import { scanSources, driftOf, renderBlock, blockOf, literalsOf, rulesOf, ROOT, CONTRACTS, TOOLS_JSON } from '../../scripts/quality-registry.mjs';
import { HTML_CODES, HTML_WARNING_CODES, PROTOTYPE_CODES } from '../refusal-codes.mjs';

test('drift: every UPPER_SNAKE constant of the product sources and every JobNormalizer rule is in the registry', async () => {
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

test('sentinel: a new constant in a source, a new hosted tool or a new normalizer rule is reported missing and stays unlisted', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-quality-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  write('platforms/odc/facade/nova.mjs', "export const nova = () => ({ ok: false, code: 'QUALITY_SENTINEL_NEW_CODE', error: 'texto' });\n");
  write('agent/lib/nova.mjs', 'export const E = `QUALITY_SENTINEL_AGENT_CODE`;\n');
  write('kernel/src/Anvil.Core/Kernel/Nova.cs', 'var p = new JsonObject { ["code"] = "QUALITY_SENTINEL_KERNEL_CODE", ["severity"] = "error" };\n');
  write('kernel/src/Anvil.Core/Kernel/Preflight/JobNormalizer.cs', 'public const string SortKeysSplit = "SORT_KEYS_SPLIT";\n    public const string Nova = "QUALITY_SENTINEL_NEW_RULE";\n');
  write(TOOLS_JSON, JSON.stringify({ tools: { odc_read: {}, ssam_sentinela: {} } }));
  // not sources: tests, fixtures, node_modules and the contract itself
  write('platforms/odc/facade/tests/nova.test.mjs', "const s = 'QUALITY_SENTINEL_TEST_ONLY';\n");
  write('platforms/odc/portal/fixtures/x.mjs', "const s = 'QUALITY_SENTINEL_FIXTURE_ONLY';\n");
  write('platforms/odc/facade/node_modules/pkg/index.js', "const s = 'QUALITY_SENTINEL_DEPENDENCY';\n");
  write('platforms/odc/facade/quality-line.mjs', "const CODE_TEXT = `\nQUALITY_SENTINEL_SELF\n`; const x = 'QUALITY_SENTINEL_SELF_LITERAL';\n");
  const scan = await scanSources(dir, { steps: ['build'] });
  const d = driftOf(scan, { CODES, RULES });
  assert.deepEqual(d.missingCodes, ['QUALITY_SENTINEL_AGENT_CODE', 'QUALITY_SENTINEL_KERNEL_CODE', 'QUALITY_SENTINEL_NEW_CODE', 'QUALITY_SENTINEL_NEW_RULE', 'SSAM_SENTINELA_FAILED']);
  assert.deepEqual(d.missingRules, ['QUALITY_SENTINEL_NEW_RULE']);
  for (const word of ['QUALITY_SENTINEL_TEST_ONLY', 'QUALITY_SENTINEL_FIXTURE_ONLY', 'QUALITY_SENTINEL_DEPENDENCY', 'QUALITY_SENTINEL_SELF', 'QUALITY_SENTINEL_SELF_LITERAL'])
    assert.ok(!scan.codes.has(word), word);
  assert.ok(scan.codes.has('ODC_READ_FAILED') && scan.codes.has('BUILD_FAILED'), 'the composed families');
  // until the registry is regenerated, the contract keeps none of them
  for (const code of d.missingCodes) assert.equal(codeOf(code), CODE_UNLISTED, code);
  assert.equal(ruleOf('QUALITY_SENTINEL_NEW_RULE'), RULE_UNLISTED);
  // the generated block of that tree carries them
  const block = renderBlock(scan);
  assert.match(block, /QUALITY_SENTINEL_NEW_CODE/); assert.match(block, /'QUALITY_SENTINEL_NEW_RULE'/);
  assert.ok(block.split('\n').every(l => l.length <= 140), 'wrapped');
});

test('literals: UPPER_SNAKE between quotes only; JobNormalizer constants only', () => {
  assert.deepEqual([...literalsOf("a('AB_CD'); b(\"EF\"); c(`GH_1`); d('ij_kl'); e('A__B'); f('X'); g('_Y'); h(`T_${x}`); i('LONG TEXT')")].sort(), ['AB_CD', 'EF', 'GH_1']);
  assert.deepEqual([...rulesOf('public const string A = "SORT_KEYS_SPLIT";\nprivate const string B = "NOPE_X";\npublic const string C = "lower";')], ['SORT_KEYS_SPLIT']);
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
