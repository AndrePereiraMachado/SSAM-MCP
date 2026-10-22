// Reconciliation of a merge that ran but whose native equivalence stayed unproven (2026-10-21, friction
// ef7de23f-58ea-4880-97c2-07ee184593d0: a customer delivery). The bridge compares the open module with the
// candidate through the Studio's MatchTree right after the merge (StartupHook.cs VerifyMerged). When a difference it
// cannot classify remains (there: a "Screen Content" marker over [Not Visible] DisplayOrder and EffectiveMarginLeft
// values), it writes no receipt.json and the delivery ends MERGE_UNCERTAIN; studio_publish {module} then refused with
// LAST_DELIVERY_NOT_CLEAN and no call of the MCP could ever lift it.
//
// The rule (one per family, never per case): a merge whose content the SSAM proves is clean.
//   - Clean already: the bridge's receipt is strict, or normalized (the Studio's own rewrites, proven element by element).
//   - Reconciled: a capture of the open module (bridge `snapshot`, the same hash the bridge checks before publishing) and
//     the kernel's content proof (anvil-odc content-proof, MergeContentProof: the comparison the disposable merge preview
//     runs before every merge) of that capture against the delivery's candidate, accepted with no difference and bound to
//     the sha256 of both files. The proof goes to evidence/reconciliation.json and, when the bridge wrote no receipt,
//     to a receipt.json in the bridge's shape (ok, merged, sha256 of the capture), so the bridge's own dispatch check
//     still refuses a module changed after it.
//   - Never: a merge with known losses (incomplete-receipt.json: its repair job continues), a publication already
//     requested, a capture refused (a merge still pending), a proof of other files or with any difference. Nothing here
//     merges, publishes or rewrites a receipt the bridge wrote; every refusal names the exact next call.
import fs from 'node:fs';
import path from 'node:path';

export const PROOF_SCHEMA = 'ssam-merge-content-proof/1';
export const RECONCILIATION_SCHEMA = 'ssam-merge-reconciliation/1';
export const RECONCILIATION_FILE = 'reconciliation.json';
export const RULE = 'A merge that ran is clean when the SSAM content proof of a capture of the open module equals the delivery candidate (no difference, both sha256 bound); never by a second merge.';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJsonOrNull = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase();
const withPid = (args, pid) => ({ ...args, ...(Number.isInteger(pid) ? { pid } : {}) });

// The state of a merge from its evidence directory: {clean, outcome, receipt, reconciliation}. outcome: strict |
// normalized | reconciled (clean), not-strict | incomplete | uncertain (not clean).
export function mergeState(evidence) {
  const receipt = readJsonOrNull(path.join(evidence, 'receipt.json'));
  if (receipt?.ok === true && receipt.merged === true) {
    if (receipt.strictlyEqual === true) return { clean: true, outcome: 'strict', receipt };
    if (receipt.equivalence === 'normalized') return { clean: true, outcome: 'normalized', receipt };
    const file = typeof receipt.reconciliation === 'string' && receipt.reconciliation ? path.resolve(evidence, receipt.reconciliation) : path.join(evidence, RECONCILIATION_FILE);
    const reconciliation = readJsonOrNull(file);
    if (reconciliation?.schema === RECONCILIATION_SCHEMA && reconciliation.accepted === true && same(reconciliation.capture?.sha256, receipt.sha256))
      return { clean: true, outcome: 'reconciled', receipt, reconciliation, reconciliationFile: file };
    return { clean: false, outcome: 'not-strict', receipt };
  }
  if (fs.existsSync(path.join(evidence, 'incomplete-receipt.json'))) return { clean: false, outcome: 'incomplete', receipt };
  return { clean: false, outcome: 'uncertain', receipt };
}

// Whether the SSAM may try to prove a merge that is not clean: never one with known losses (its repair continues).
export const reconcilable = state => !!state && state.clean !== true && state.outcome !== 'incomplete';

// The one explicit operation (MCP): studio_publish {module, reconcile:true}. It captures, proves and records; it never
// publishes. studio_publish {module} runs the same reconciliation by itself before publishing.
export const reconcileCall = (module, pid, why) => ({ tool: 'studio_publish', arguments: withPid({ module, reconcile: true }, pid),
  why: why ?? 'The merge ran but its equivalence was not proven: this captures the open module and proves its content against the delivery candidate (nothing is merged or published); a clean proof records the receipt, then studio_publish {module} publishes.' });

const refusal = (code, error, continuation, extra = {}) => ({ ok: false, code, executed: false, error, ...extra, continuation });

// The differing elements of a content proof in words, for the text of a refusal: "<element> <property>[,...]" per element
// (MergeContentProof names each difference's element; an older proof only its address), the first `max` of them.
export function differenceNames(differences, max = 5) {
  const byElement = new Map();
  for (const d of Array.isArray(differences) ? differences : []) {
    const element = String(d?.element || d?.address || d?.objectKey || 'unknown element');
    const properties = byElement.get(element) ?? []; if (d?.property && !properties.includes(d.property)) properties.push(String(d.property));
    byElement.set(element, properties);
  }
  const named = [...byElement].slice(0, max).map(([element, properties]) => element + (properties.length ? ' ' + properties.slice(0, 3).join(',') + (properties.length > 3 ? ',...' : '') : ''));
  return named.join('; ') + (byElement.size > max ? '; and ' + (byElement.size - max) + ' more element(s)' : '');
}
const stamp = now => now.toISOString().replace(/[:.]/g, '-');
// A new evidence file, never over an existing one.
function writeNew(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx' }); return file; }

// The divergences the bridge named for this merge (deliver-result.json of its lab folder), for the record only.
function divergencesOf(dir) {
  const result = readJsonOrNull(path.join(dir, 'deliver-result.json'));
  const list = Array.isArray(result?.divergences) ? result.divergences : Array.isArray(result?.refusal?.divergences) ? result.refusal.divergences : [];
  return list.slice(0, 20);
}

// merge: {dir, manifest, document, evidence, started} (studio-publish-log.mjs deliveryMerges, or the delivery in flight).
// deps.studio: the bridge call; deps.prove({expected, actual}) -> {ok:true, proof} | {ok:false, error} (kernel-delivery.mjs
// contentProofKernel); deps.next(why): the call that delivers a correction (the delivery again over the module as it is).
// -> {ok:true, reconciled:true|false, outcome, receipt, reconciliation} | a refusal with code and continuation.
export async function reconcileMerge({ merge, module, pid } = {}, { studio, prove, next = null, now = () => new Date() } = {}) {
  if (!isObject(merge) || !merge.evidence || !isObject(merge.document))
    return refusal('RECONCILE_NOT_APPLICABLE', 'No SSAM merge evidence to reconcile.', { tool: 'studio_status', arguments: withPid({ view: 'brief' }, pid), why: 'which modules are open in this Studio' });
  const state = mergeState(merge.evidence);
  if (state.clean) return { ok: true, reconciled: false, outcome: state.outcome, receipt: path.join(merge.evidence, 'receipt.json'), ...(state.reconciliationFile ? { reconciliation: { file: state.reconciliationFile } } : {}) };
  const correction = why => (typeof next === 'function' ? next(why) : null) ?? { tool: 'studio_status', arguments: withPid({ view: 'brief' }, pid), why };
  if (state.outcome === 'incomplete')
    return refusal('RECONCILE_NOT_APPLICABLE', 'The merge of ' + module + ' kept known losses (incomplete-receipt.json); its repair job is the next delivery, never a reconciliation.',
      { tool: 'ssam_evidence', arguments: { file: path.join(merge.evidence, 'incomplete-receipt.json') }, why: 'the losses and the repair job of this merge' });
  if (fs.existsSync(path.join(merge.evidence, 'publish-started.json')))
    return refusal('PUBLISH_ALREADY_REQUESTED', 'A publication of this merge was already requested; it is never reconciled or requested again.',
      { tool: 'studio_command', arguments: withPid({ command: 'publish-log', args: [module] }, pid), why: 'how that publication ended' });
  const candidate = typeof merge.document.candidatePath === 'string' && merge.document.candidatePath ? path.resolve(path.dirname(merge.manifest), merge.document.candidatePath) : null;
  const candidateSha256 = typeof merge.document.candidateSha256 === 'string' ? merge.document.candidateSha256 : null;
  if (!candidate || !fs.existsSync(candidate) || !candidateSha256)
    return refusal('RECONCILE_CANDIDATE_MISSING', 'The candidate of this merge (manifest candidatePath and candidateSha256) is not on disk; its content cannot be proven.',
      correction('without the candidate the merge cannot be proven: a new delivery over the module as it is now merges and proves it again'));
  if (typeof prove !== 'function')
    return refusal('RECONCILE_PROOF_UNAVAILABLE', 'This SSAM has no content proof (anvil-odc content-proof); the merge of ' + module + ' stays unproven.',
      { tool: 'ssam_doctor', arguments: {}, why: 'the ODC kernel CLI of this SSAM lacks content-proof: build the ODC lane again, then studio_publish {module, reconcile:true}' });
  // 1. The open module as it is now: the bridge refuses the capture while a merge is pending.
  let capture;
  try { capture = await studio(['snapshot', module], pid); } catch (error) { capture = { ok: false, error: error.message }; }
  if (capture?.ok !== true || typeof capture.path !== 'string' || typeof capture.sha256 !== 'string')
    return refusal('RECONCILE_CAPTURE_FAILED', 'The open module ' + module + ' could not be captured (' + (capture?.error ?? 'no answer') + '); nothing was reconciled.',
      { tool: 'studio_status', arguments: withPid({ view: 'brief' }, pid), why: 'a merge pending or a dialog in the Studio blocks the capture: read the status, then studio_publish {module, reconcile:true}' });
  if (merge.document.moduleKey && capture.moduleKey && merge.document.moduleKey !== capture.moduleKey)
    return refusal('RECONCILE_NOT_APPLICABLE', 'The open module ' + module + ' is another module (key ' + capture.moduleKey + ') than the merge (' + merge.document.moduleKey + ').',
      { tool: 'studio_status', arguments: withPid({ view: 'brief' }, pid), why: 'which modules are open in this Studio' });
  // A receipt the bridge wrote keeps its hash: a capture of another model is a change after the merge.
  if (state.receipt?.ok === true && typeof state.receipt.sha256 === 'string' && !same(state.receipt.sha256, capture.sha256))
    return refusal('MODULE_CHANGED_SINCE_DELIVERY', 'The module ' + module + ' open in the Studio changed after the merge (receipt ' + state.receipt.sha256 + ', open ' + capture.sha256 + '); SSAM reconciles only what it merged.',
      correction('the open module changed after the merge: a new delivery captures it as it is now and proves its own merge'));
  // 2. The SSAM content proof of the capture against the candidate.
  let proved;
  try { proved = await prove({ expected: candidate, actual: capture.path }); } catch (error) { proved = { ok: false, error: error.message }; }
  if (proved?.ok !== true || !isObject(proved.proof))
    return refusal('RECONCILE_PROOF_UNAVAILABLE', 'The content proof of ' + module + ' did not run (' + (proved?.error ?? 'no answer') + '); the merge stays unproven.',
      { tool: 'ssam_doctor', arguments: {}, why: 'the ODC kernel (anvil-odc content-proof) must run: check the ODC lane, then studio_publish {module, reconcile:true}' });
  const proof = proved.proof;
  const differences = Array.isArray(proof.differences) ? proof.differences : null;
  const problems = [
    proof.schema !== PROOF_SCHEMA ? 'the proof is not ' + PROOF_SCHEMA : null,
    !same(proof.inputs?.expected?.sha256, candidateSha256) ? 'the proof is not of this candidate (sha256 ' + (proof.inputs?.expected?.sha256 ?? 'none') + ', manifest ' + candidateSha256 + ')' : null,
    !same(proof.inputs?.actual?.sha256, capture.sha256) ? 'the proof is not of this capture (sha256 ' + (proof.inputs?.actual?.sha256 ?? 'none') + ', capture ' + capture.sha256 + ')' : null,
    differences === null ? 'the proof lists no differences array' : differences.length ? differences.length + ' difference(s) between the open module and the candidate (' + differenceNames(differences) + ')' : null,
    proof.accepted !== true ? 'the proof was not accepted' : null,
  ].filter(Boolean);
  const at = now();
  const record = { schema: RECONCILIATION_SCHEMA, accepted: problems.length === 0, rule: RULE, module, moduleKey: merge.document.moduleKey ?? capture.moduleKey ?? null, at: at.toISOString(),
    manifest: merge.manifest, mergeStartedAt: merge.started?.at ?? null, mergePid: merge.started?.pid ?? null,
    candidate: { path: candidate, sha256: candidateSha256 }, capture: { path: capture.path, sha256: capture.sha256, capturedAt: capture.capturedAt ?? null },
    proof: { schema: proof.schema ?? null, accepted: proof.accepted === true, checked: proof.checked ?? null, differences: (differences ?? []).slice(0, 50), differencesTotal: differences?.length ?? null,
      inputs: proof.inputs ?? null, coverage: isObject(proof.coverage) ? { complete: proof.coverage.complete ?? null, boundary: proof.coverage.boundary ?? null } : null },
    nativeDivergences: divergencesOf(merge.dir), problems, publishInvoked: false };
  if (problems.length) {
    const file = writeNew(path.join(merge.evidence, 'reconciliation-refused-' + stamp(at) + '.json'), record);
    return refusal(differences?.length ? 'MERGE_CONTENT_MISMATCH' : 'RECONCILE_PROOF_REFUSED', 'The content of ' + module + ' open in the Studio is not proven equal to the delivery candidate: ' + problems.join('; ') + '. Nothing was published or merged.',
      { tool: 'ssam_evidence', arguments: { file, pointer: '/proof/differences' }, why: 'each element and property that differs; then the correction is a new delivery over the module as it is now (never this delivery again)' },
      { reconciliation: { file, accepted: false, problems, differences: record.proof.differences.slice(0, 10) }, then: correction('deliver the correction of those differences over the module as it is now') });
  }
  // 3. The record, then the receipt the bridge's dispatch reads (only when it wrote none).
  const recordFile = path.join(merge.evidence, RECONCILIATION_FILE);
  try { writeNew(recordFile, record); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const earlier = readJsonOrNull(recordFile);
    if (!(earlier?.accepted === true && same(earlier.capture?.sha256, capture.sha256)))
      return refusal('RECONCILE_CONFLICT', 'An earlier reconciliation of this merge proved another capture; nothing was recorded.',
        { tool: 'ssam_evidence', arguments: { file: recordFile }, why: 'the earlier reconciliation; a module changed since is a new delivery' });
  }
  const receiptFile = path.join(merge.evidence, 'receipt.json');
  if (!state.receipt) {
    try {
      writeNew(receiptFile, { ok: true, merged: true, module, outcome: 'reconciled', equivalence: 'content-proof', strictlyEqual: false, sha256: capture.sha256, afterSnapshot: capture.path,
        reconciliation: RECONCILIATION_FILE, checked: proof.checked ?? null, by: 'ssam reconcile', publishInvoked: false, completedAt: at.toISOString() });
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const after = mergeState(merge.evidence);
    if (!after.clean) return refusal('RECONCILE_CONFLICT', 'A receipt of this merge appeared during the reconciliation and does not match the capture; nothing else was written.',
      { tool: 'ssam_evidence', arguments: { file: receiptFile }, why: 'the receipt now in the evidence directory' });
  }
  return { ok: true, reconciled: true, outcome: 'reconciled', receipt: receiptFile,
    reconciliation: { file: recordFile, accepted: true, checked: proof.checked ?? null, captureSha256: capture.sha256, candidateSha256, nativeDivergences: record.nativeDivergences.length } };
}
