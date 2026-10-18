// Lane E of the 2026-10-05 package (C12): the deliver answer keeps the shared fields of section 3.2 (what was published,
// the last publication, the leftovers the job declared to pass the gate, the roles of the screens it touched, the
// standing grant used) on success and the preflight problems on a refusal; and once the change is delivered nothing
// suggests delivering it again, whatever the publish of the same call said. Pure: no Studio, no CLI.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDelivery, shapeToolResult, DELIVERY_FIELDS } from '../responses.mjs';
import { addNextSteps, refusalContinuation, WORDS_MARKER } from '../next-steps.mjs';

const TASK = 'a'.repeat(32);
const SHA = 'b'.repeat(64);
const shared = {
  publish: { requested: true, outcome: 'published', version: 12, at: '2026-10-05T12:00:00Z' },
  lastPublication: { at: '2026-10-05T12:00:00Z', status: 'succeeded', version: 12, author: 'andre', by: 'ssam', source: 'publish-result' },
  leftovers: [{ id: 'UnusedElement', element: 'Estilo', why: 'kept for the next screen', source: 'expectedMessages' }], leftoversTotal: 1,
  screenRoles: [{ screen: 'Home', mode: 'create', roles: ['Registered'], anonymous: false }], screenRolesTotal: 1,
  authorization: { source: 'standing-grant', grantId: 'g-1' },
};

test('compactDelivery keeps exactly the shared fields on a delivered change, published or not', () => {
  // + integration (contract I7 of docs/INTEGRACOES-GITSSAM.md, lane restsoap); + warnings (I9 of docs/PACOTE-ATRITOS-2.md, A03);
  // + queue (A08: a delivery that waited in the Studio write queue); + highWarnings (data-access rules, 2026-10-09).
  assert.deepEqual(DELIVERY_FIELDS, ['publish', 'lastPublication', 'leftovers', 'leftoversTotal', 'screenRoles', 'screenRolesTotal', 'authorization', 'integration', 'integrationTotal',
    'entityActions', // op entity-actions (2026-10-13): the generated standard actions by entity, unchanged, kept, notes
    'highWarnings', 'warnings', 'warningsTotal', 'queue', 'equivalence', 'normalized', 'normalizedTotal', // I8 of the atritos 3 package
    'phases', // lane wp of the atritos 3 package: a delivery built outside the Studio lock
    'preview', // C04 (servidor/fase4): the structural preview of the delivered html (preview/fragment.mjs)
    'removed', 'removedTotal', // ssam_code (2026-10-12): what an action text or a screen edit removed
    'producerNotes', 'available', 'availableTotal']); // fix/system-reference (2026-10-15): a producer's Studio name, the producers offered
  const queue = { position: 1, waitedMs: 1200, holder: { tool: 'studio_deliver', pid: 4242, startedAt: '2026-10-06T13:38:00Z' } };
  assert.deepEqual(compactDelivery('studio_deliver', {}, { ok: true, merged: true, strictlyEqual: true, manifest: 'm.json', queue, steps: [1] }),
    { ok: true, result: 'delivered', queue, manifest: 'm.json' });
  const answer = { ok: true, result: 'delivered and published', merged: true, strictlyEqual: true, steps: [{ name: 'merge' }], totalSeconds: 9, evidence: 'lab/7', manifest: 'm.json', ...shared };
  // The manifest stays (atritos-a-publish.test.mjs); a published delivery names no further publication.
  assert.deepEqual(compactDelivery('studio_deliver', {}, answer), { ok: true, result: 'delivered and published', ...shared, manifest: 'm.json' });
  // Without publish:true there is no publish field and the result stays "delivered".
  const plain = compactDelivery('studio_deliver', {}, { ok: true, merge: { merged: true, strictlyEqual: true }, lastPublication: shared.lastPublication, screenRoles: shared.screenRoles, screenRolesTotal: 1 });
  assert.deepEqual(plain, { ok: true, result: 'delivered', lastPublication: shared.lastPublication, screenRoles: shared.screenRoles, screenRolesTotal: 1 });
  // Through the MCP shaper the text carries the same fields.
  const shaped = shapeToolResult('studio_deliver', {}, { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer });
  assert.deepEqual(JSON.parse(shaped.content[0].text), { ok: true, result: 'delivered and published', ...shared, manifest: 'm.json' });
});

test('a preflight refusal keeps every problem; a failed publish of a delivered change keeps that it was delivered', () => {
  const problems = [
    { op: 0, pointer: '/ops/0/data/actions/0/steps/1/assign/N', code: 'ODC_COUNT_IS_LONG', severity: 'error', message: 'Count is Long Integer', fix: 'LongIntegerToInteger(GetX.Count)', patch: null },
    { op: 2, pointer: '/ops/2/value', code: 'ODC_SERVICE_ACTION_SAME_APP', severity: 'error', message: 'same app', fix: 'kind:"server"', patch: null },
    { op: 3, pointer: null, code: 'ODC_FUNCTION_UNAVAILABLE', severity: 'error', message: 'GenerateGuid', fix: 'derive from the Id', patch: null },
  ];
  const refused = compactDelivery('studio_deliver', {}, { ok: false, code: 'PREFLIGHT_REFUSED', failed: 'preflight', error: '3 problems', problems, job: 'j.json', jobSha256: SHA, steps: [] });
  assert.deepEqual(refused.problems, problems);
  assert.equal(refused.code, 'PREFLIGHT_REFUSED'); assert.equal(refused.failed, 'preflight'); assert.equal(refused.steps, undefined);
  // The problems may come inside the raw refusal.
  assert.deepEqual(compactDelivery('studio_deliver', {}, { ok: false, error: 'x', refusal: { problems } }).problems, problems);
  const publishFailed = { ok: false, result: 'delivered', code: 'PUBLISH_FAILED', error: 'cloud build failed', publish: { requested: true, outcome: 'failed', code: 'PUBLISH_FAILED', messages: [{ type: 'Error', text: 'SQL' }] },
    continuation: { tool: 'studio_publish', arguments: { manifest: 'm.json', wait: true } }, steps: [] };
  const kept = compactDelivery('studio_deliver', {}, publishFailed);
  assert.equal(kept.result, 'delivered'); assert.deepEqual(kept.publish, publishFailed.publish); assert.deepEqual(kept.continuation, publishFailed.continuation);
  // The relay's refusal (lane C) keeps its stage next to code and outcome: friction records the step (I9).
  const relay = compactDelivery('studio_deliver', {}, { ok: false, code: 'TIMEOUT', stage: 'relay', tool: 'studio_deliver', outcome: 'uncertain', error: 'no answer',
    continuation: { tool: 'studio_status', arguments: {} } });
  assert.deepEqual([relay.code, relay.stage, relay.outcome, relay.continuation.tool], ['TIMEOUT', 'relay', 'uncertain', 'studio_status']);
});

test('once delivered, no answer suggests delivering again: only the publish goes on', () => {
  const input = { module: 'OfficePet_CS', job: 'j.json', authorize: 'pode entregar e publicar o OfficePet', publish: true };
  // The refusal code a redelivery used to follow, now with the delivery done and the publish refused.
  for (const value of [
    { ok: false, result: 'delivered', code: 'VALIDATION_REFUSED', taskId: TASK, publish: { requested: true, outcome: 'refused' } },
    { ok: false, code: 'VALIDATION_REFUSED', taskId: TASK, publish: { requested: true, outcome: 'failed' } },
  ]) {
    const call = refusalContinuation('o11_deliver', input, value);
    assert.ok(!call || call.tool !== 'o11_deliver', JSON.stringify(call));
  }
  // `skipped`: the merge was not clean, nothing was delivered; the corrected delivery stays the continuation.
  const skipped = refusalContinuation('o11_deliver', input, { ok: false, code: 'VALIDATION_REFUSED', taskId: TASK, publish: { requested: true, outcome: 'skipped' } });
  assert.equal(skipped.tool, 'o11_deliver'); assert.equal(skipped.arguments.closePrevious, TASK);
  const failed = addNextSteps('o11_deliver', input, { ok: false, result: 'delivered', code: 'PUBLISH_FAILED', error: 'publish failed', publish: { requested: true, outcome: 'failed' } });
  assert.deepEqual(failed.continuation.tool, 'o11_publish');
  assert.deepEqual(failed.continuation.arguments, { module: 'OfficePet_CS', authorize: WORDS_MARKER });
  assert.ok(!JSON.stringify(failed.continuation).includes(input.authorize), 'the user words never travel');
  const uncertain = addNextSteps('o11_deliver', input, { ok: false, result: 'delivered', code: 'PUBLISH_UNCERTAIN', error: 'publish running', publish: { requested: true, outcome: 'uncertain' } });
  assert.deepEqual(uncertain.continuation.arguments, { command: 'publish-log', args: { module: 'OfficePet_CS' } });
  const odc = addNextSteps('studio_deliver', { module: 'QuizLiveWeb', pid: 42 }, { ok: false, result: 'delivered', code: 'PUBLISH_FAILED', manifest: 'm.json', error: 'x' });
  assert.deepEqual(odc.continuation, { tool: 'studio_publish', arguments: { manifest: 'm.json', wait: true, pid: 42 }, why: odc.continuation.why });
  // A continuation the producer gave is kept; an exact success passes untouched.
  const given = { ok: false, result: 'delivered', code: 'PUBLISH_FAILED', continuation: { tool: 'o11_publish', arguments: { module: 'X' } } };
  assert.equal(addNextSteps('o11_deliver', input, given), given);
  const done = { ok: true, result: 'delivered and published', publish: { requested: true, outcome: 'published' } };
  assert.equal(addNextSteps('o11_deliver', input, done), done);
});
