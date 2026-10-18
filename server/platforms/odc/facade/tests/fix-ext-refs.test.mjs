// fix-ext-refs (2026-10-16, owner: this must never happen): a delivery that needs NEW elements of a
// producer (eSpace module, Extension .xif, system) adds them through the Studio's own Manage Dependencies, never through
// the person. o11_studio refresh-references takes the elements to add (add) and the published signature (published) and
// passes them to the bridge only when the loaded bridge offers it (refresh_references:add); an older bridge is refused
// with the exact continuation, nothing done silently. o11_deliver answers a rollback of an Extension signature without
// ever sending it to an OML, and a Manage Dependencies the Studio refused as one refusal with every problem.
// Fake bridges, pure deliverOutcome: no Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { o11Studio } from '../o11-studio.mjs';
import { deliverOutcome } from '../o11-cycle.mjs';
import { BridgeError } from '../o11-bridge.mjs';

function bridge(table) {
  const calls = [];
  return { calls, async ok(method, params = {}, options) {
    calls.push({ method, params });
    const entry = table[method];
    if (entry === undefined) throw new BridgeError('Unknown method: ' + method, { code: 'BRIDGE_ERROR', method, reply: { success: false } });
    return typeof entry === 'function' ? entry(params, options) : entry;
  } };
}

const ADD = [{ producer: 'ZZ_Report_Ext', elements: ['IServerActionSignature:GenerateTemplatePowerPoint', 'IStructureSignature:TemplateSection'] }];

test('refresh-references with add and published runs the Studio\'s own Manage Dependencies through the bridge', async () => {
  const fake = bridge({ open_module: { name: 'ZZ_Report_CS', opened: true, selected: true }, get_active_module: { name: 'ZZ_Report_CS', key: 'kc', environment: 'h.example' },
    bridge_manifest: { capabilities: ['refresh_references', 'refresh_references:add'] },
    refresh_references: () => ({ module: 'ZZ_Report_CS', changed: true, committed: true, command: 'Manage Dependencies', refreshed: ['ZZ_Report_Ext'],
      added: [{ producer: 'ZZ_Report_Ext', element: 'GenerateTemplatePowerPoint' }, { producer: 'ZZ_Report_Ext', element: 'TemplateSection' }],
      references: [{ producer: 'ZZ_Report_Ext', key: 'kx', kind: 'Extension', hashBefore: '1111', hashAfter: '2222' }], newErrors: 0, undo: 'Ctrl+Z in the Studio undoes the Manage Dependencies' }) });
  const run = o11Studio({ bridge: fake, assertSelected: async () => {}, inventory: async () => null });
  const value = await run({ command: 'refresh-references', args: { module: 'ZZ_Report_CS', add: ADD, published: true } });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.added.length, 2);
  assert.equal(value.references[0].hashAfter, '2222');
  const sent = fake.calls.find(c => c.method === 'refresh_references').params;
  assert.deepEqual(sent.add, ADD);
  assert.equal(sent.published, true);
  assert.deepEqual(sent.producers, ['ZZ_Report_Ext']);
});

test('refresh-references with add on a bridge without Manage Dependencies is refused with the exact continuation, nothing refreshed', async () => {
  const fake = bridge({ open_module: { name: 'ZZ_Report_CS', opened: true, selected: true }, get_active_module: { name: 'ZZ_Report_CS', key: 'kc', environment: 'h.example' },
    bridge_manifest: { capabilities: ['refresh_references'] }, refresh_references: () => ({ module: 'ZZ_Report_CS', changed: false, refreshed: [], upToDate: ['ZZ_Report_Ext'] }) });
  const run = o11Studio({ bridge: fake, assertSelected: async () => {}, inventory: async () => null });
  const value = await run({ command: 'refresh-references', args: { module: 'ZZ_Report_CS', add: ADD, published: true } });
  assert.equal(value.ok, false);
  assert.equal(value.code, 'BRIDGE_OUTDATED');
  assert.equal(value.continuation.tool, 'ssam_doctor');
  assert.equal(fake.calls.filter(c => c.method === 'refresh_references').length, 0, 'an older bridge would refresh without adding: never sent');
  assert.match(value.error, /refresh_references:add/);
  assert.doesNotMatch(JSON.stringify(value), /by hand|à mão|manualmente|no Manage Dependencies do Studio/i);
});

const TASK = '7a8b9c0d1e2f30415263748596a7b8c9';
const ctx = { trackId: 't', work: '.', job: 'C:/jobs/report.json', input: { module: 'ZZ_Report_CS' } };
const rolledBack = alignment => ({ envelope: { ok: false, command: 'deliver', data: { taskId: TASK, delivered: false, writeState: 'not-applied', stage: 'merge',
  code: 'MERGE_ROLLED_BACK', closed: true, sameJobAgain: false,
  error: 'The Studio rolled the merge back. Producer signatures the merge had to select: ZZ_Report_Ext 11111111 -> 22222222 (named by the job). Failed at stage structural-merge.',
  merge: { merged: false, rolledBack: true, stage: 'structural-merge' },
  referenceSignatureChanges: [{ producer: 'ZZ_Report_Ext', key: 'kx', baseHash: '11111111', candidateHash: '22222222', namedByJob: true, owner: false }],
  alignment } } });

test('a rollback of an Extension signature on a bridge without Manage Dependencies points to the bridge, then the same job; never to an OML', () => {
  const answer = deliverOutcome(rolledBack({ requires: 'refresh_references:add', bridgeOffers: false,
    add: [{ producer: 'ZZ_Report_Ext', key: 'kx', kind: 'Extension', elements: ADD[0].elements }] }), ctx);
  assert.equal(answer.code, 'MERGE_ROLLED_BACK');
  assert.equal(answer.continuation.tool, 'ssam_doctor');
  assert.match(answer.continuation.why, /refresh_references:add/);
  assert.match(answer.continuation.why, /same job again/);
  assert.doesNotMatch(JSON.stringify(answer.continuation), /OML|by hand/i);
  assert.equal(answer.alignment.add[0].producer, 'ZZ_Report_Ext');
});

test('a rollback the kernel could not align on a bridge with Manage Dependencies continues with that exact Studio command', () => {
  const answer = deliverOutcome(rolledBack({ requires: 'refresh_references:add', bridgeOffers: true,
    add: [{ producer: 'ZZ_Report_Ext', key: 'kx', kind: 'Extension', elements: ADD[0].elements }] }), ctx);
  assert.equal(answer.continuation.tool, 'o11_studio');
  assert.equal(answer.continuation.arguments.command, 'refresh-references');
  assert.deepEqual(answer.continuation.arguments.args, { module: 'ZZ_Report_CS', producers: ['ZZ_Report_Ext'], add: ADD, published: true });
  // The why says where an Extension's signature comes from; nothing proposes an OML.
  assert.doesNotMatch(JSON.stringify(answer.continuation.arguments), /OML/i);
  assert.match(answer.continuation.why, /never from an OML/);
});

test('a Manage Dependencies the Studio refused is one refusal with every problem and its fix, before any merge', () => {
  const answer = deliverOutcome({ envelope: { ok: false, command: 'deliver', data: { taskId: TASK, delivered: false, writeState: 'not-sent', stage: 'add-references',
    code: 'REFERENCES_NOT_ADDED', error: 'The Studio\'s Manage Dependencies did not add the elements this delivery needs; nothing was merged: ...',
    problems: [
      { code: 'REFERENCES_NOT_ADDED', severity: 'error', cause: 'not-in-signature', producer: 'ZZ_Report_Ext', element: 'IServerActionSignature:GenerateTemplatePowerPoint',
        message: 'GenerateTemplatePowerPoint is not in the published signature of ZZ_Report_Ext.', fix: 'publish ZZ_Report_Ext with GenerateTemplatePowerPoint public, then deliver the same job again', patch: null },
      { code: 'REFERENCES_NOT_ADDED', severity: 'error', cause: 'not-in-signature', producer: 'ZZ_Report_Ext', element: 'IStructureSignature:TemplateSection',
        message: 'TemplateSection is not in the published signature of ZZ_Report_Ext.', fix: 'publish ZZ_Report_Ext with TemplateSection public, then deliver the same job again', patch: null }] } } }, ctx);
  assert.equal(answer.code, 'REFERENCES_NOT_ADDED');
  assert.equal(answer.outcome, 'refused');
  const text = JSON.stringify(answer);
  assert.ok(text.includes('GenerateTemplatePowerPoint') && text.includes('TemplateSection'), text);
});

// Review A1 (fix-ext-refs round 2, shape of round 3): the Studio's Manage Dependencies wrote the delivered module before the
// merge. Every answer of o11_deliver from that stage on declares it (studioWrites, from the kernel's record: command, stage,
// elements, signature before and after, the undo), the continuation never says nothing was applied, and every text it writes
// is in English.
const ADDED = { command: 'Manage Dependencies', module: 'ZZ_Report_CS', stage: 'before-merge', outcome: 'changed',
  added: [{ producer: 'ZZ_Report_Ext', element: 'GenerateTemplatePowerPoint', type: 'ReferenceAction' }, { producer: 'ZZ_Report_Ext', element: 'TemplateSection', type: 'ReferenceStructure' }],
  requested: [{ producer: 'ZZ_Report_Ext', elements: ['IServerActionSignature:GenerateTemplatePowerPoint', 'IStructureSignature:TemplateSection'] }],
  producers: ['ZZ_Report_Ext'], refreshed: [], moved: [{ producer: 'ZZ_Report_Ext', before: '11111111', after: '22222222' }],
  undo: 'Ctrl+Z in Service Studio undoes it (its own Studio command, "Manage Dependencies"); nothing was published',
  text: 'Before the merge, the Studio\'s Manage Dependencies changed ZZ_Report_CS in its own Studio command: it added GenerateTemplatePowerPoint and TemplateSection of ZZ_Report_Ext and brought ZZ_Report_Ext (11111111 -> 22222222) to the published signature. Ctrl+Z in Service Studio undoes it; nothing was published.' };
const PT = /\b(nada|foi|aplicado|gravado|módulo|palavras|usuário|não|já)\b/i;
const declares = (answer, stage = 'before-merge') => {
  const declared = (answer.studioWrites ?? []).find(w => w.stage === stage);
  assert.ok(declared, 'studioWrites ' + stage + ' missing: ' + JSON.stringify(answer));
  assert.equal(declared.command, 'Manage Dependencies');
  assert.equal(declared.outcome, 'changed');
  assert.deepEqual(declared.elements, ['GenerateTemplatePowerPoint', 'TemplateSection']);
  assert.deepEqual(declared.producers, ['ZZ_Report_Ext 11111111 -> 22222222']);
  assert.match(declared.undo, /Ctrl\+Z/);
};
const englishAndTrue = answer => {
  for (const text of [answer.error, answer.continuation?.why].filter(t => typeof t === 'string')) {
    assert.doesNotMatch(text, PT, 'pt-BR text: ' + text);
    assert.doesNotMatch(text, /nothing was applied|nothing was written/i, 'false claim: ' + text);
  }
};
const deliverState = data => ({ envelope: { ok: data.delivered === true, command: 'deliver', data: { taskId: TASK, studioWrites: [ADDED], ...data } } });

test('a delivered answer declares what the Studio\'s Manage Dependencies added before the merge (A1, D4)', () => {
  const answer = deliverOutcome(deliverState({ delivered: true, writeState: 'applied', stage: 'complete' }), ctx);
  assert.equal(answer.ok, true);
  declares(answer);
  assert.equal(answer.studioWrites[0].added, 2);
});

test('a job refused after the Manage Dependencies declares the write (A1, D1)', () => {
  const answer = deliverOutcome(deliverState({ delivered: false, writeState: 'not-sent', stage: 'apply',
    error: 'job rejected by validation contract (the Verify of the candidate: 1 error); merge was not attempted. ' + ADDED.text,
    apply: { isValid: false, accepted: false, validation: { errors: 1 } } }), ctx);
  assert.equal(answer.ok, false);
  declares(answer);
  englishAndTrue(answer);
});

test('a merge rolled back after the Manage Dependencies never says nothing was applied, in English (A1, D2)', () => {
  const answer = deliverOutcome(deliverState({ delivered: false, writeState: 'not-applied', stage: 'merge', code: 'MERGE_ROLLED_BACK', closed: true, sameJobAgain: false,
    error: 'The Studio rolled the merge back (rolled back): the live module equals this task\'s base, sha256 aa11. Nothing was merged, the task is closed and the module is free. ' + ADDED.text,
    merge: { merged: false, rolledBack: true, stage: 'structural-merge' } }), ctx);
  assert.equal(answer.code, 'MERGE_ROLLED_BACK');
  declares(answer);
  englishAndTrue(answer);
  assert.match(answer.continuation.why, /Manage Dependencies/);
  assert.match(answer.continuation.why, /Ctrl\+Z/);
  assert.match(answer.continuation.why, /user's words in place of the marker/);
});

test('the same job again after the alignment names the Manage Dependencies that ran after the rollback (A1, D3)', () => {
  const after = { ...ADDED, stage: 'after-rollback', text: ADDED.text.replace('Before the merge', 'After the rollback') };
  const answer = deliverOutcome(deliverState({ delivered: false, writeState: 'not-applied', stage: 'merge', code: 'MERGE_ROLLED_BACK', closed: true, sameJobAgain: true,
    studioWrites: [{ ...ADDED, outcome: 'unchanged', added: [], moved: [], text: 'Before the merge, the Studio\'s Manage Dependencies changed nothing in ZZ_Report_CS.' }, after],
    afterRollback: { aligned: true, command: 'Manage Dependencies' },
    error: 'The Studio rolled the merge back. Nothing was merged, the task is closed and the module is free. ' + after.text,
    merge: { merged: false, rolledBack: true, stage: 'structural-merge' },
    referenceSignatureChanges: [{ producer: 'ZZ_Report_Ext', key: 'kx', baseHash: '11111111', candidateHash: '22222222', namedByJob: true }] }), ctx);
  declares(answer, 'after-rollback');
  englishAndTrue(answer);
  assert.match(answer.continuation.why, /Manage Dependencies/);
  assert.doesNotMatch(answer.continuation.why, /Refresh References/);
});

test('a producer that changed before the merge, after the Manage Dependencies: declared, never "nothing was written" (A1)', () => {
  const answer = deliverOutcome(deliverState({ delivered: false, writeState: 'not-sent', stage: 'producer-attestation', code: 'PRODUCER_CHANGED',
    error: 'ZZ_Report_Ext was republished since its capture; nothing was merged. ' + ADDED.text }), ctx);
  assert.equal(answer.code, 'PRODUCER_CHANGED');
  declares(answer);
  englishAndTrue(answer);
  assert.match(answer.continuation.why, /Manage Dependencies/);
});

test('a Refresh References that changed the module before a rolled-back merge is declared too, never "nothing was applied" (A1, C26)', () => {
  const refreshed = { command: 'Refresh References', module: 'ZZ_Report_CS', stage: 'before-merge', outcome: 'changed', producers: ['ZZ_Report_Ext'], refreshed: ['ZZ_Report_Ext'], added: [], moved: [],
    undo: 'Ctrl+Z in Service Studio undoes it (its own Studio command, "Refresh References"); nothing was published',
    text: 'Before the merge, the Studio\'s Refresh References changed ZZ_Report_CS in its own Studio command: it refreshed ZZ_Report_Ext to their published signatures. Ctrl+Z in Service Studio undoes it; nothing was published.' };
  const answer = deliverOutcome({ envelope: { ok: false, command: 'deliver', data: { taskId: TASK, delivered: false, writeState: 'not-applied', stage: 'merge',
    code: 'MERGE_ROLLED_BACK', closed: true, sameJobAgain: false, studioWrites: [refreshed],
    error: 'The Studio rolled the merge back. Nothing was merged, the task is closed and the module is free. ' + refreshed.text,
    merge: { merged: false, rolledBack: true, stage: 'structural-merge' } } } }, ctx);
  assert.equal(answer.studioWrites[0].command, 'Refresh References');
  assert.equal(answer.studioWrites[0].outcome, 'changed');
  assert.deepEqual(answer.studioWrites[0].producers, ['ZZ_Report_Ext']);
  englishAndTrue(answer);
  assert.match(answer.continuation.why, /Refresh References/);
  assert.match(answer.continuation.why, /Ctrl\+Z/);
});

test('every other answer after the Manage Dependencies carries the declaration (preflight, dialog, uncertain, outdated bridge, kept merge)', () => {
  for (const data of [
    { delivered: false, writeState: 'not-sent', stage: 'preflight', code: 'PREFLIGHT_REFUSED', error: 'Job refused by the preflight; nothing was merged.', problems: [] },
    { delivered: false, writeState: 'intent', stage: 'merge', code: 'STUDIO_DIALOG_PENDING', blockedBy: { title: 'Sign in', question: 'Sign in?' }, error: 'The Studio opened a dialog.' },
    { delivered: false, writeState: 'unknown', stage: 'reconcile', error: 'Merge outcome is unknown.' },
    { delivered: false, writeState: 'not-sent', stage: 'merge-order', code: 'BRIDGE_OUTDATED', error: 'The Service Studio runs a bridge without the merge order. Nothing was merged.' },
    { delivered: false, writeState: 'applied', stage: 'verify', error: 'merge kept for review: new TrueChange errors', failures: [{ stage: 'verify', error: 'merge kept for review: new TrueChange errors' }] },
  ]) declares(deliverOutcome(deliverState(data), ctx));
});
