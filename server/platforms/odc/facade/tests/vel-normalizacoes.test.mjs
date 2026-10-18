// lentidao 2026-10-12 (integration of the speed lanes): what the kernel rewrites in a job instead of refusing it
// (kernel/src/Anvil.Core/Kernel/Preflight/JobNormalizer.cs) reaches the model in every answer that runs a job: delivered and
// refused o11_deliver, ssam_job/o11_job, and studio_deliver; short (count per rule, first entries), never silent.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizationsOf, diagnosisOf, NORMALIZATIONS_SHOWN } from '../refusal-problems.mjs';
import { deliveryFields } from '../o11-cycle.mjs';
import { summarize } from '../job-runner.mjs';
import { compactDelivery } from '../responses.mjs';
import { interpretKernelResult, requiredFlowLayoutEngine } from '../kernel-delivery.mjs';

// The shapes the kernel writes (synthetic names; same fields as the replay of a real 7-action job).
const sort = i => ({ rule: 'SORT_KEYS_SPLIT', path: `/ops/0/data/actions/${i}/steps/3/sort`, from: 'Pedido.Data, Pedido.Id',
  to: '["Pedido.Data","Pedido.Id"]', message: 'comma-separated sort = 2 keys in order, tie-breaks kept' });
const nullTime = { rule: 'NULL_FUNCTION_REWRITTEN', path: '/ops/0/data/actions/2/steps/1/assign/Resumo.Hora', from: 'NullTime()',
  to: 'NewTime(0, 0, 0)', message: 'no NullTime() in this Studio: the null Time is NewTime(0, 0, 0)' };
const dropped = { rule: 'PROPERTY_SET_DROPPED', path: '/ops/1/prop', from: 'set Description on $erro', to: null,
  message: 'IUserException has no way to write Description (a documentation property): the set is dropped' };
const many = [...Array.from({ length: 12 }, (_, i) => sort(i)), nullTime, dropped];

test('normalizationsOf: count per rule, the first entries and how many were left', () => {
  const { normalizations } = normalizationsOf({ normalizations: many });
  assert.equal(normalizations.total, 14);
  assert.deepEqual(normalizations.byRule, { SORT_KEYS_SPLIT: 12, NULL_FUNCTION_REWRITTEN: 1, PROPERTY_SET_DROPPED: 1 });
  assert.equal(normalizations.items.length, NORMALIZATIONS_SHOWN);
  assert.equal(normalizations.itemsLeft, 14 - NORMALIZATIONS_SHOWN);
  assert.deepEqual(normalizations.items[0], { rule: 'SORT_KEYS_SPLIT', path: '/ops/0/data/actions/0/steps/3/sort', from: 'Pedido.Data, Pedido.Id', to: '["Pedido.Data","Pedido.Id"]' });
  assert.deepEqual(normalizationsOf({ normalizations: [dropped] }).normalizations.items, [{ rule: 'PROPERTY_SET_DROPPED', path: '/ops/1/prop', from: 'set Description on $erro' }]);
  assert.deepEqual(normalizationsOf({}), {});
  assert.deepEqual(normalizationsOf({ normalizations: [] }), {});
  assert.deepEqual(normalizationsOf(null), {});
  assert.ok(Buffer.byteLength(JSON.stringify(normalizationsOf({ normalizations: many }))) < 2500, 'short enough for every answer');
});

test('o11_deliver delivered: the apply receipt normalizations come with "delivered"', () => {
  const fields = deliveryFields({ apply: { isValid: true, accepted: true, normalizations: [nullTime] } });
  assert.deepEqual(fields.normalizations, { total: 1, byRule: { NULL_FUNCTION_REWRITTEN: 1 }, items: [{ rule: 'NULL_FUNCTION_REWRITTEN',
    path: '/ops/0/data/actions/2/steps/1/assign/Resumo.Hora', from: 'NullTime()', to: 'NewTime(0, 0, 0)' }] });
  assert.equal(deliveryFields({ apply: { isValid: true, accepted: true } }).normalizations, undefined);
});

test('a refusal keeps what the kernel normalized before refusing what stayed', () => {
  const envelope = { ok: false, code: 'PREFLIGHT_REFUSED', verifyRan: false, problems: [{ op: 0, code: 'EXPRESSION_SYNTAX' }], normalizations: [sort(0), nullTime] };
  const d = diagnosisOf(envelope);
  assert.equal(d.verifyRan, false);
  assert.equal(d.normalizations.total, 2);
  assert.deepEqual(d.normalizations.byRule, { SORT_KEYS_SPLIT: 1, NULL_FUNCTION_REWRITTEN: 1 });
});

test('ssam_job/o11_job success: normalizations outside the 1 KB budget, like the HIGH warnings', () => {
  const saved = { ok: true, via: 'process', wallMs: 10, data: { accepted: true, isValid: true, ops: 1, objects: 9, normalizations: many } };
  const value = summarize({ lane: 'o11', job: 'j.json', out: 'o.oml', resultFile: 'o.result.json', saved });
  assert.equal(value.ok, true);
  assert.equal(value.normalizations.total, 14);
  const { normalizations: _n, ...budgeted } = value;
  assert.ok(Buffer.byteLength(JSON.stringify(budgeted)) <= 1024 - 120);
});

test('studio_deliver: the accepted candidate names its normalizations and compactDelivery keeps them, delivered or refused', () => {
  const built = interpretKernelResult({ ok: true, data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, normalizations: [sort(1)] } }, { output: 'o' });
  assert.equal(built.ok, true);
  assert.equal(built.normalizations.total, 1);
  const delivered = compactDelivery('studio_deliver', { module: 'M' }, { ok: true, merged: true, strictlyEqual: true, result: 'delivered', module: 'M', normalizations: built.normalizations });
  assert.equal(delivered.result, 'delivered');
  assert.deepEqual(delivered.normalizations, built.normalizations);
  const refused = compactDelivery('studio_deliver', { module: 'M' }, { ok: false, failed: 'build', code: 'PREFLIGHT_REFUSED', error: 'x',
    problems: [{ op: 0, code: 'FUNCTION_UNKNOWN' }], ...diagnosisOf({ normalizations: [nullTime] }) });
  assert.equal(refused.normalizations.total, 1);
});
