import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { categorizeScope, withScopeCategories, odcSessionVariableEvidence } from '../debug-scope-categories.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const zero = { input: 0, output: 0, local: 0, client: 0, session: 0, site: 0, setting: 0, timer: 0 };
const bound = counts => ({ modelScopeEnumerated: true, runtimeFrameBound: true, variableCounts: { ...zero, ...counts } });

test('client runtime: session/site/setting/timer are not applicable; zero counts are empty; unbound categories are not enumerated', () => {
  const vars = [{ category: 'input' }, { category: 'client' }, { category: 'client' }];
  const c = categorizeScope('o11', 'client', bound({ input: 1, client: 2 }), vars);
  assert.deepEqual(c.notApplicableToRuntime, ['session', 'site', 'setting', 'timer']);
  assert.equal(c.notApplicableReasons.session.reason, 'client-runtime-has-no-session-variables');
  assert.equal(c.notApplicableReasons.session.evidence, undefined);
  assert.deepEqual(c.emptyInModel, ['output', 'local']);
  assert.deepEqual(c.notEnumerated, []);
  assert.deepEqual(c.enumeratedCategories, ['input', 'client']);
  assert.equal(c.categoryCountsBound, true);
  const unbound = categorizeScope('o11', 'client', null, vars);
  assert.deepEqual(unbound.emptyInModel, []); assert.deepEqual(unbound.notEnumerated, ['output', 'local']);
  assert.equal(unbound.categoryCountsBound, false);
  // A model count without an enumerated address is not empty: it stays not enumerated.
  assert.deepEqual(categorizeScope('o11', 'client', bound({ local: 3 }), []).notEnumerated, ['local']);
  // Counts that are not native integers bind nothing.
  assert.deepEqual(categorizeScope('o11', 'client', { modelScopeEnumerated: true, variableCounts: { output: '0' } }, []).emptyInModel, []);
  // The native return address is reported apart from model categories.
  assert.equal(categorizeScope('o11', 'client', null, [{ category: 'return' }]).nativeReturnEnumerated, true);
});

test('server runtime: client is not applicable and zero-count setting is empty, never not-enumerated', () => {
  const c = categorizeScope('o11', 'server', bound({ input: 1 }), [{ category: 'input' }]);
  assert.deepEqual(c.notApplicableToRuntime, ['client']);
  assert.equal(c.notApplicableReasons.client.reason, 'server-runtime-has-no-client-variables');
  assert.deepEqual(c.emptyInModel, ['output', 'local', 'session', 'site', 'setting', 'timer']);
  assert.equal(c.notEnumerated.includes('setting'), false);
});

test('ODC session is not applicable with the factory-refusal reason and its pinned evidence, in both runtimes', () => {
  assert.equal(odcSessionVariableEvidence, 'kernel/tests/jobs-odc-negative/session-variable-not-in-odc.json');
  const evidence = JSON.parse(fs.readFileSync(path.join(repo, odcSessionVariableEvidence), 'utf8'));
  assert.ok(evidence.expectError.some(e => /Session Variable objects can't be children of App objects/.test(e)));
  for (const runtime of ['client', 'server']) {
    const c = categorizeScope('odc', runtime, bound({}), []);
    assert.ok(c.notApplicableToRuntime.includes('session'));
    assert.deepEqual(c.notApplicableReasons.session, { reason: 'odc-model-refuses-session-variables', evidence: odcSessionVariableEvidence });
    assert.equal(c.emptyInModel.includes('session'), false); assert.equal(c.notEnumerated.includes('session'), false);
  }
  assert.deepEqual(categorizeScope('odc', 'server', bound({}), []).notApplicableToRuntime, ['client', 'session']);
  assert.ok(categorizeScope('o11', 'server', bound({}), []).emptyInModel.includes('session'), 'o11 unaffected');
  assert.throws(() => categorizeScope('o12', 'client', null, []), /debug_scope_categories_input_invalid/);
  assert.throws(() => categorizeScope('odc', 'browser', null, []), /debug_scope_categories_input_invalid/);
});

test('server scope post-processing replaces native category lists from the bound metadataCoverage', () => {
  const native = { ok: true, metadataBound: true, context: { threadId: 'T', eventId: '1', generation: 1, frame: 0 },
    unavailableCategories: ['client'], categoriesNotEnumerated: ['output', 'local', 'return', 'session', 'site', 'setting', 'timer'],
    variables: [{ reference: 'r'.repeat(32), category: 'input' }], metadataCoverage: bound({ input: 1 }) };
  const o11 = withScopeCategories(native, 'o11', 'server');
  assert.deepEqual(o11.notApplicableToRuntime, ['client']);
  assert.deepEqual(o11.emptyInModel, ['output', 'local', 'session', 'site', 'setting', 'timer']);
  assert.deepEqual(o11.categoriesNotEnumerated, []); assert.deepEqual(o11.unavailableCategories, []);
  assert.equal(o11.variables, native.variables); assert.equal(o11.metadataCoverage, native.metadataCoverage);
  const odc = withScopeCategories(native, 'odc', 'server');
  assert.deepEqual(odc.notApplicableToRuntime, ['client', 'session']);
  assert.equal(odc.notApplicableReasons.session.evidence, odcSessionVariableEvidence);
  // Without frame-bound counts nothing is claimed empty.
  const { metadataCoverage, ...unbound } = native;
  const plain = withScopeCategories(unbound, 'o11', 'server');
  assert.deepEqual(plain.emptyInModel, []); assert.deepEqual(plain.categoriesNotEnumerated, ['output', 'local', 'session', 'site', 'setting', 'timer']);
  const refused = { ok: false, error: 'debug_stale_reference' };
  assert.equal(withScopeCategories(refused, 'o11', 'server'), refused);
});

test('client scope keeps the core categories without coverage and recomputes them from bound coverage', () => {
  const core = { ok: true, runtime: 'client', variables: [{ ref: 'a'.repeat(48), category: 'input' }],
    notApplicableToRuntime: ['session', 'site', 'setting', 'timer'], emptyInModel: ['output'], notEnumerated: ['local', 'client'], unavailableCategories: ['local', 'client'] };
  assert.equal(withScopeCategories(core, 'o11', 'client'), core);
  const covered = withScopeCategories({ ...core, metadataCoverage: bound({ input: 1 }) }, 'o11', 'client');
  assert.deepEqual(covered.emptyInModel, ['output', 'local', 'client']); assert.deepEqual(covered.unavailableCategories, []);
  assert.equal('categoriesNotEnumerated' in covered, false);
});
