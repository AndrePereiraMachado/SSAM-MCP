// fix-ext-refs, review round 3 (F1, F2, F3, L5): every Studio write outside the merge (the kernel's studioWrites: the Manage
// Dependencies, the Refresh References before the merge, the Refresh References after the dependencies dialog, the alignment
// after a rollback) is declared in the answer the person sees, through the real path of an o11_deliver answer:
// deliverOutcome -> shapeToolResult -> fitResult (answer-size.mjs budgets). One short protected field (studioWrites: command,
// stage, outcome, elements, signatures before and after, undo) that the size policy never drops; the long detail never pushes
// the A03 warnings out. A command that waits for the person is pending, never "added nothing". Synthetic states, no Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverOutcome } from '../o11-cycle.mjs';
import { shapeToolResult } from '../responses.mjs';
import { fitResult } from '../answer-size.mjs';

const TASK = '7a8b9c0d1e2f30415263748596a7b8c9';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-ext-refs-writes-'));
const JOB = path.join(ROOT, 'report-job.json');
const input = { module: 'ZZ_Report_CS', job: JOB };
const names = n => Array.from({ length: n }, (_, k) => k < 2 ? ['GenerateTemplatePowerPoint', 'TemplateSection'][k] : 'GenerateSlideSection' + String(k).padStart(2, '0'));

// The kernel's record of a Manage Dependencies before the merge (Delivery.RecordStudioWrite).
const manage = (n, outcome = 'changed') => ({ command: 'Manage Dependencies', stage: 'before-merge', module: 'ZZ_Report_CS', outcome,
  added: outcome === 'changed' ? names(n).map(e => ({ producer: 'ZZ_Report_Ext', element: e, type: 'ReferenceAction' })) : [],
  requested: [{ producer: 'ZZ_Report_Ext', elements: names(n).map(e => 'IServerActionSignature:' + e) }],
  moved: outcome === 'changed' ? [{ producer: 'ZZ_Report_Ext', before: '11111111-aaaa-4bbb-8ccc-000000000001', after: '22222222-aaaa-4bbb-8ccc-000000000002' }] : [],
  ...(outcome === 'pending' ? { blockedBy: { title: 'Sign in', question: 'Sign in to lab.example to continue?' } } : {}),
  undo: 'Ctrl+Z in Service Studio undoes it (its own Studio command, "Manage Dependencies"); nothing was published',
  text: 'Before the merge, the Studio\'s Manage Dependencies changed ZZ_Report_CS in its own Studio command: it added ' + names(n).join(', ')
    + ' of ZZ_Report_Ext and brought ZZ_Report_Ext (11111111 -> 22222222) to the published signature. Ctrl+Z in Service Studio undoes it; nothing was published.' });
// The long detail of the same write (Delivery.DeclareReferencesAdded), as the kernel keeps it in the task.
const detail = n => ({ command: 'Manage Dependencies', module: 'ZZ_Report_CS', when: 'before-merge', committed: true, changed: true,
  added: names(n).map(e => ({ producer: 'ZZ_Report_Ext', key: 'kx', element: e, type: 'ReferenceAction', spec: 'IServerActionSignature:' + e })), alreadyReferenced: [],
  references: [{ producer: 'ZZ_Report_Ext', key: 'kx', kind: 'Extension', hashBefore: '11111111-aaaa-4bbb-8ccc-000000000001', hashAfter: '22222222-aaaa-4bbb-8ccc-000000000002',
    published: '22222222-aaaa-4bbb-8ccc-000000000002', atPublished: true }], undo: manage(n).undo, text: manage(n).text });

function seen(data, extra = {}) {
  const value = { ...deliverOutcome({ envelope: { ok: data.delivered === true, command: 'deliver', data: { taskId: TASK, ...data } } },
    { trackId: 't', work: ROOT, job: JOB, taskId: null, since: 0, input }), ...extra };
  const shaped = shapeToolResult('o11_deliver', input, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value,
    ...(value.ok === false ? { isError: true } : {}) }, { lane: 'o11' });
  const fitted = fitResult('o11_deliver', input, shaped, { root: ROOT });
  return fitted.structuredContent ?? JSON.parse(fitted.content[0].text);
}
const declared = (answer, n, stage = 'before-merge') => {
  const write = (answer.studioWrites ?? []).find(w => w.stage === stage);
  assert.ok(write, 'studioWrites missing from the answer seen: ' + JSON.stringify(answer));
  assert.equal(write.command, 'Manage Dependencies');
  assert.equal(write.outcome, 'changed');
  assert.equal(write.added, n);
  assert.deepEqual(write.elements.slice(0, 2), ['GenerateTemplatePowerPoint', 'TemplateSection']);
  assert.match(write.producers.join(' '), /ZZ_Report_Ext 11111111 -> 22222222/);
  assert.match(write.undo, /Ctrl\+Z/);
};
const REAL = { nextBasedOn: { job: path.join(ROOT, 'inline', 'a'.repeat(32) + '.json'), sha256: 'b'.repeat(64) },
  lastPublication: { module: 'ZZ_Report_CS', version: 41, publishedAt: '2026-10-15T18:00:00Z', by: 'synthetic.user' } };

test('F1: a delivered answer with 12 elements added, nextBasedOn and lastPublication still declares the write', () => {
  const answer = seen({ delivered: true, writeState: 'applied', stage: 'complete', studioWrites: [manage(12)], referencesAdded: detail(12) }, REAL);
  assert.equal(answer.ok, true);
  declared(answer, 12);
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= 2048);
});

test('F1 + L5: a delivered answer with 4 elements and 4 warnings keeps the declaration and every warning', () => {
  const warnings = Array.from({ length: 4 }, (_, k) => ({ id: 'UnusedVariableWarning', path: 'ZZ_Report_CS/Logic/GenerateDeck/Local' + k, key: 'k' + k,
    detail: 'Local variable Local' + k + ' of GenerateDeck is never used (synthetic warning ' + k + ').', fix: 'Remove Local' + k + ' or use it in the flow.' }));
  const answer = seen({ delivered: true, writeState: 'applied', stage: 'complete', warnings, studioWrites: [manage(4)], referencesAdded: detail(4) }, REAL);
  declared(answer, 4);
  assert.equal(answer.warnings?.length, 4, JSON.stringify(answer));
});

test('F1: VALIDATION_REFUSED with 20 distinct Verify problems still declares the write', () => {
  const problems = Array.from({ length: 20 }, (_, k) => ({ phase: 'verify', op: k % 5, pointer: '/ops/' + (k % 5) + '/actions/0/steps/' + k, code: 'VERIFY_ERROR_' + k, severity: 'error',
    message: 'Synthetic Verify error ' + k + ': the expression of assign step ' + k + ' of GenerateDeck names an attribute that the structure TemplateSection does not declare in its published signature; check the element and its type.',
    fix: 'Use an attribute of TemplateSection that its published signature declares, or add it to the producer first and capture it again (synthetic fix ' + k + ').', element: 'GenerateDeck/Assign' + k, key: 'key' + k }));
  const answer = seen({ delivered: false, writeState: 'not-sent', stage: 'apply', problems, studioWrites: [manage(4)], referencesAdded: detail(4),
    error: 'job rejected by validation contract (the Verify of the candidate: 20 errors); merge was not attempted. ' + manage(4).text,
    apply: { isValid: false, accepted: false, validation: { errors: 20 } } });
  assert.equal(answer.ok, false);
  declared(answer, 4);
});

test('F2: the Refresh References after the dependencies dialog is declared in a rolled-back answer, never "nothing was applied"', () => {
  const open = { command: 'Refresh References', stage: 'open', module: 'ZZ_Report_CS', outcome: 'changed', refreshed: ['ZZ_Report_Ext'], added: [], moved: [],
    undo: 'Ctrl+Z in Service Studio undoes it (its own Studio command, "Refresh References"); nothing was published',
    text: 'When the module opened, the Studio\'s Refresh References changed ZZ_Report_CS in its own Studio command: it refreshed ZZ_Report_Ext to their published signatures. Ctrl+Z in Service Studio undoes it; nothing was published.' };
  const answer = seen({ delivered: false, writeState: 'not-applied', stage: 'merge', code: 'MERGE_ROLLED_BACK', closed: true, sameJobAgain: false, studioWrites: [open],
    error: 'The Studio rolled the merge back (rolled back): the live module equals this task\'s base, sha256 aa11. Nothing was merged, the task is closed and the module is free. ' + open.text,
    merge: { merged: false, rolledBack: true, stage: 'structural-merge' } });
  const write = answer.studioWrites?.find(w => w.stage === 'open');
  assert.ok(write, JSON.stringify(answer));
  assert.equal(write.command, 'Refresh References');
  assert.deepEqual(write.producers, ['ZZ_Report_Ext']);
  assert.match(answer.continuation.why, /Refresh References/);
  assert.doesNotMatch(JSON.stringify(answer), /nothing was applied/i);
});

test('F3: a Manage Dependencies that waits for the person is pending in the answer, in English, never "added nothing"', () => {
  const answer = seen({ delivered: false, writeState: 'not-sent', stage: 'add-references', code: 'STUDIO_DIALOG_PENDING', studioWrites: [manage(2, 'pending')],
    blockedBy: { title: 'Sign in', question: 'Sign in to lab.example to continue?', kind: 'Question' }, question: 'Sign in to lab.example to continue?',
    error: 'The Studio opened "Sign in" during the Manage Dependencies (add-references) and only the person can answer it. Sign in to lab.example to continue? Nothing was merged; after the answer, resume this task.' });
  assert.equal(answer.code, 'STUDIO_DIALOG_PENDING');
  const write = answer.studioWrites?.[0];
  assert.ok(write, JSON.stringify(answer));
  assert.equal(write.outcome, 'pending');
  assert.equal(write.waitsFor, 'Sign in');
  assert.deepEqual(write.elements, ['GenerateTemplatePowerPoint', 'TemplateSection']);
  assert.doesNotMatch(JSON.stringify(answer), /added nothing|rolled back/i);
  assert.doesNotMatch(answer.continuation.why, /\b(nada|depois|retoma|repetido|diálogo)\b/i);
  assert.match(answer.continuation.why, /Manage Dependencies/);
});

// Review round 4 (N1, N2): a record says only what a run observed. An unknown outcome (no answer that says what the command
// did) is declared as unknown, with its error and the undo, in the answer seen; the continuation resumes, which proves the
// Studio idle before anything else; and no text says the module was changed for sure, or that a pending command ended.
const unknown = { command: 'Manage Dependencies', stage: 'before-merge', module: 'ZZ_Report_CS', outcome: 'unknown', added: [], moved: [],
  requested: [{ producer: 'ZZ_Report_Ext', elements: ['IServerActionSignature:GenerateTemplatePowerPoint', 'IStructureSignature:TemplateSection'] }], producers: ['ZZ_Report_Ext'],
  error: 'BridgeCallException: refresh_references: the Manage Dependencies of \'ZZ_Report_CS\' did not end within 600 s; its outcome is unknown.',
  undo: 'Ctrl+Z in Service Studio undoes it (its own Studio command, "Manage Dependencies"); nothing was published' };

test('N2: a Manage Dependencies with an unknown outcome is declared as unknown, with its error, and the continuation resumes behind the idle proof', () => {
  const answer = seen({ delivered: false, writeState: 'not-sent', stage: 'add-references', studioWrites: [unknown],
    pendingBridgeOperation: { method: 'refresh_references', command: 'Manage Dependencies', outcomeUnknown: unknown.error },
    error: unknown.error + ' Before the merge, the Studio\'s Manage Dependencies got no answer that says what it did: whether it changed ZZ_Report_CS is unknown.' });
  const write = answer.studioWrites?.[0];
  assert.ok(write, JSON.stringify(answer));
  assert.equal(write.outcome, 'unknown');
  assert.match(write.error, /its outcome is unknown/);
  assert.match(write.undo, /Ctrl\+Z/);
  assert.deepEqual(write.elements, ['GenerateTemplatePowerPoint', 'TemplateSection']);
  assert.equal(answer.continuation?.arguments?.resume, TASK, JSON.stringify(answer.continuation));
  assert.match(answer.continuation.why, /idle/);
  assert.match(answer.continuation.why, /may still change it/);
  assert.doesNotMatch(answer.continuation.why, /changed the module outside the merge \(/);
});

test('N2: the delivered answer of the resume still declares the unknown write (ended by the idle proof, what it wrote unknown)', () => {
  const answer = seen({ delivered: true, writeState: 'applied', stage: 'complete',
    studioWrites: [{ ...unknown, endedBy: 'idle', observed: { referenced: [{ producer: 'ZZ_Report_Ext', element: 'GenerateTemplatePowerPoint' }], at: [{ producer: 'ZZ_Report_Ext', hash: '22222222-aaaa' }] } },
      { ...manage(2), outcome: 'unchanged', added: [], moved: [] }] });
  const write = answer.studioWrites?.find(w => w.outcome === 'unknown');
  assert.ok(write, JSON.stringify(answer));
  assert.equal(write.endedBy, 'idle');
  assert.match(write.error, /its outcome is unknown/);
  assert.match(write.undo, /Ctrl\+Z/);
  assert.deepEqual(write.producers, ['ZZ_Report_Ext now at 22222222']);
});

test('N6: the deduplication of repeated prose never edits inside the protected studioWrites', () => {
  const failed = { command: 'Manage Dependencies', stage: 'before-merge', module: 'ZZ_Report_CS', outcome: 'failed', producers: ['ZZ_Report_Ext'], added: [], moved: [],
    error: 'InvalidOperationException: synthetic failure inside the Studio, long enough to be prose' };
  const answer = seen({ delivered: false, writeState: 'not-applied', stage: 'merge', code: 'MERGE_ROLLED_BACK', closed: true, sameJobAgain: false,
    studioWrites: [failed, { ...failed, stage: 'after-rollback' }], error: 'The Studio rolled the merge back. Nothing was merged.', merge: { merged: false, rolledBack: true } });
  assert.equal(answer.studioWrites?.length, 2, JSON.stringify(answer));
  assert.ok(answer.studioWrites.every(w => /synthetic failure/.test(w.error ?? '')), JSON.stringify(answer.studioWrites));
});
