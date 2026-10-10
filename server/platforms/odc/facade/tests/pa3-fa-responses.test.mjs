// Atritos 3, lane fa, interface I8 (C16 of lane mb lands in this shaper): a studio_deliver merge equal but for the
// normalizations the Studio applies itself is "entregue" with normalized; a refusal that says the merge was already
// integrated (merged:true) keeps merged and evidence and reads it, never the same delivery. Section 5.3: the new refusal
// codes have their continuations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDelivery, DELIVERY_FIELDS } from '../responses.mjs';
import { continuationFor, PACKAGE_3_CODES, CONTINUATIONS } from '../continuations.mjs';
import { codeFromText } from '../refusal-codes.mjs';

test('I8: merged with equivalence "normalized" is entregue, with normalized and normalizedTotal', () => {
  for (const field of ['equivalence', 'normalized', 'normalizedTotal']) assert.ok(DELIVERY_FIELDS.includes(field), field);
  const normalized = [{ element: 'Block1', rule: 'CustomNameTrio', local: '', candidate: 'Block1' }];
  const value = compactDelivery('studio_deliver', { module: 'Shop' }, { ok: true, merged: true, strictlyEqual: false, equivalence: 'normalized', normalized, normalizedTotal: 1, steps: [1] });
  assert.equal(value.result, 'entregue');
  assert.deepEqual(value.normalized, normalized); assert.equal(value.normalizedTotal, 1); assert.equal(value.equivalence, 'normalized');
  // Not normalized and not strictly equal: unchanged (the gate refuses it upstream).
  assert.equal(compactDelivery('studio_deliver', {}, { ok: true, merged: true, strictlyEqual: false, equivalence: 'uncertain' }).result, undefined);
});

test('I8: a refusal with merged:true keeps merged and evidence and reads the receipt; never the same delivery', () => {
  const evidence = 'C:\\ws\\odc\\lab\\20-x';
  const value = compactDelivery('studio_deliver', { module: 'Shop', pid: 9 }, { ok: false, code: 'MERGE_UNCERTAIN', outcome: 'uncertain', merged: true, evidence,
    error: 'uncertain', continuation: { tool: 'studio_deliver', arguments: { module: 'Shop' }, why: 'again' } });
  assert.equal(value.merged, true); assert.equal(value.evidence, evidence);
  assert.deepEqual(value.continuation.arguments, { file: evidence + '\\deliver-result.json' });
  assert.equal(value.continuation.tool, 'ssam_evidence');
  const bare = compactDelivery('studio_deliver', { pid: 9 }, { ok: false, code: 'MERGE_UNCERTAIN', merged: true, error: 'uncertain' });
  assert.deepEqual([bare.continuation.tool, bare.continuation.arguments], ['studio_status', { pid: 9 }]);
});

test('5.3: the refusal codes of the package carry the continuation the contract names', () => {
  assert.deepEqual([...PACKAGE_3_CODES].sort(), ['DUPLICATE_MCP_ENTRY', 'EVIDENCE_FILTER_INVALID', 'PATH_OUTSIDE_WORKSPACE', 'PUBLISH_BLOCKED_BY_DIALOG', 'STUDIO_WINDOWLESS']);
  for (const code of PACKAGE_3_CODES) assert.ok(CONTINUATIONS[code], code);
  assert.deepEqual(continuationFor('PUBLISH_BLOCKED_BY_DIALOG', { module: 'Orders' }).arguments, { command: 'refresh-references', args: { module: 'Orders' } });
  assert.deepEqual(continuationFor('STUDIO_WINDOWLESS'), { tool: 'ssam_connect', arguments: { lane: 'o11' }, why: CONTINUATIONS.STUDIO_WINDOWLESS.why });
  assert.equal(continuationFor('DUPLICATE_MCP_ENTRY').tool, 'ssam_doctor');
  assert.equal(continuationFor('EVIDENCE_FILTER_INVALID').tool, 'ssam_evidence');
  assert.deepEqual(continuationFor('PATH_OUTSIDE_WORKSPACE', { tool: 'studio_deliver', arguments: { job: 'agent:inbox/job.json' } }).arguments, { job: 'agent:inbox/job.json' });
  // An older bridge's text and the hosted refusal text are classified when they come without a code.
  assert.equal(codeFromText('studio_login: the Studio has no window'), 'STUDIO_WINDOWLESS');
  assert.equal(codeFromText('The path C:\\x is outside the folders the agent reads (inbox/, odc/, o11/ of its root).'), 'PATH_OUTSIDE_WORKSPACE');
});
