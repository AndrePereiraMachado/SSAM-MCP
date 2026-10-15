// fam-deps (2026-10-12, VisitaCerta_UI "conecte nas telas"): what o11_deliver answers for the two families of that night.
// Family D: a dialog the Studio opened during the merge that only the person answers comes back as one question with the
// exact text (STUDIO_DIALOG_PENDING, outcome blocked), never "outcome unknown"; the Studio's crash report is classified by
// its title and closed by it. Family E: a merge rolled back names the producer signatures it had to select and the failed
// stage, and, when the job named none of them, says the job is right. Pure: deliverOutcome over kernel task results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverOutcome } from '../o11-cycle.mjs';
import { classifyWindow, dialogsFromWindows } from '../o11-studio.mjs';

const TASK = '7a8b9c0d1e2f30415263748596a7b8c9';
const ctx = { trackId: 't', work: '.', job: 'C:/jobs/ui.json', input: { module: 'VisitaCerta_UI' } };

test('a dialog only the person answers comes back as one question, blocked, with the resume of the same task', () => {
  const question = 'O Studio abriu "Recover module" durante a entrega: Recover unsaved changes? Open | Discard. Escolha Open ou Discard no Studio.';
  const answer = deliverOutcome({ envelope: { ok: false, command: 'deliver', data: { taskId: TASK, delivered: false, writeState: 'unknown', stage: 'merge',
    code: 'STUDIO_DIALOG_PENDING', question, error: 'The Studio opened "Recover module" during the merge and only the person can answer it.',
    blockedBy: { kind: 'Recovery', title: 'Recover module', text: 'Recover unsaved changes? Open | Discard', buttons: ['Open', 'Discard'], question } } } }, ctx);
  assert.equal(answer.code, 'STUDIO_DIALOG_PENDING');
  assert.equal(answer.outcome, 'blocked');
  assert.equal(answer.question, question);
  assert.equal(answer.dialog.title, 'Recover module');
  assert.deepEqual(answer.dialog.buttons, ['Open', 'Discard']);
  assert.deepEqual(answer.continuation.arguments, { resume: TASK });
  assert.match(answer.continuation.why, /nada é repetido/);
});

test('a merge rolled back names the producer signatures it had to select, the stage, and the same job once the kernel aligned the module', () => {
  const answer = deliverOutcome({ envelope: { ok: false, command: 'deliver', data: { taskId: TASK, delivered: false, writeState: 'not-applied', stage: 'merge',
    code: 'MERGE_ROLLED_BACK', closed: true, sameJobAgain: true,
    error: 'The Studio rolled the merge back (rolled back): the live module equals this task\'s base. Producer signatures the merge had to select: (System) 25c9070b -> eee5a39e (owner of foreign types, not named by the job). Failed at stage reference-merge.',
    merge: { merged: false, rolledBack: true, stage: 'reference-merge' },
    referenceSignatureChanges: [{ producer: '(System)', key: 'uXCIR2Atc0+es3zYuZSnNw', baseHash: '25c9070b', candidateHash: 'eee5a39e', namedByJob: false, owner: true }] } } }, ctx);
  assert.equal(answer.code, 'MERGE_ROLLED_BACK');
  assert.match(answer.error, /\(System\) 25c9070b -> eee5a39e/);
  assert.equal(answer.failedStage, 'reference-merge');
  assert.deepEqual(answer.signatureChanges.map(c => [c.producer, c.namedByJob]), [['(System)', false]]);
  assert.equal(answer.continuation.tool, 'o11_deliver');
  assert.equal(answer.sameJobAgain, true);
  assert.match(answer.continuation.why, /mesmo job de novo/);
});

// Review finding 2: a producer the job does not name is not enough to say "the same job": only the kernel's proof is.
test('a merge rolled back without the kernel proof never sends the same job again', () => {
  const answer = deliverOutcome({ envelope: { ok: false, command: 'deliver', data: { taskId: TASK, delivered: false, writeState: 'not-applied', stage: 'merge',
    code: 'MERGE_ROLLED_BACK', closed: true, sameJobAgain: false,
    error: 'The Studio rolled the merge back. The same job would roll back the same way (this bridge has no refresh_references): deliver it with (System) as OML.',
    merge: { merged: false, rolledBack: true, stage: 'reference-merge' },
    referenceSignatureChanges: [{ producer: '(System)', key: 'uXCIR2Atc0+es3zYuZSnNw', baseHash: '25c9070b', candidateHash: 'eee5a39e', namedByJob: false, owner: true }] } } }, ctx);
  assert.equal(answer.sameJobAgain, false);
  assert.doesNotMatch(answer.continuation.why, /mesmo job de novo|O job está certo/);
  assert.match(answer.continuation.why, /OML/);
});

// Review finding 1: a closed Studio error is in every answer, delivered or refused, never only in the receipt.
test('the dialogs the bridge closed reach the answer, delivered or refused, with the Studio error the kernel proved', () => {
  const crash = { kind: 'UnexpectedError', title: 'Unexpected Error', text: 'An unexpected error occurred. NullReferenceException', answer: 'close', closed: true };
  const delivered = deliverOutcome({ envelope: { ok: true, command: 'deliver', data: { taskId: TASK, delivered: true, writeState: 'applied', stage: 'done',
    merge: { merged: true, dialogs: [{ kind: 'DependenciesDialog', title: '', text: 'Incompatible or missing dependencies found.', answer: 'close', closed: true }] } } } }, ctx);
  assert.equal(delivered.result, 'entregue');
  assert.equal(delivered.dialogs[0].kind, 'DependenciesDialog');
  const refused = deliverOutcome({ envelope: { ok: false, command: 'deliver', data: { taskId: TASK, delivered: false, writeState: 'not-applied', stage: 'studio-error',
    code: 'STUDIO_ERROR_DURING_MERGE', closed: true, error: 'The Studio reported an error while the merge ran ("Unexpected Error": NullReferenceException), closed by the bridge.',
    merge: { merged: true, dialogs: [crash] }, studioError: { stage: 'merge', title: 'Unexpected Error', text: crash.text, proof: 'rolled-back' } } } }, ctx);
  assert.equal(refused.code, 'STUDIO_ERROR_DURING_MERGE');
  assert.equal(refused.studioError.proof, 'rolled-back');
  assert.equal(refused.dialogs[0].kind, 'UnexpectedError');
  assert.equal(refused.dialogs[0].when, 'merge');
});

test('a refusal of the reference closure keeps its code and every problem with the exact reference', () => {
  const answer = deliverOutcome({ envelope: { ok: false, command: 'deliver', data: { taskId: TASK, delivered: false, writeState: 'not-sent', stage: 'reference-closure',
    code: 'REFERENCE_CLOSURE_REFUSED', error: 'The candidate\'s producer references do not match what this delivery may merge; nothing was merged.',
    problems: [{ code: 'REFERENCE_CLOSURE_REFUSED', severity: 'error', cause: 'collateral', producer: '(System)', key: 'uXCIR2Atc0+es3zYuZSnNw',
      message: 'The candidate changes the signature of (System) (25c9070b -> eee5a39e), which the job does not name.', fix: 'SSAM defect, the job is right.', patch: null }] } } }, ctx);
  assert.equal(answer.code, 'REFERENCE_CLOSURE_REFUSED');
  assert.equal(answer.outcome, 'refused');
  assert.ok(JSON.stringify(answer).includes('(System)'), JSON.stringify(answer));
});

test('the Studio crash report is classified by its title and offered to dismiss by that title, even without an owner', () => {
  assert.equal(classifyWindow('Unexpected Error', ['[Button] Viewbox', 'Unexpected Error']), 'UnexpectedError');
  const [dialog] = dialogsFromWindows([{ title: 'Unexpected Error', type: 'DialogWindow', isVisible: true, isModal: false, texts: ['[Button] Viewbox', 'Unexpected Error'] }]);
  assert.equal(dialog.kind, 'UnexpectedError');
});
