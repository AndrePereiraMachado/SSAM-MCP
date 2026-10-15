// The verified patches of a refusal, whole, beside the job they patch (integration 24-1 familias, 2026-10-13).
// The session's first refusal had two patches of a whole screen text (20 KB each): the fit of the answer kept one problem of
// five. Now the fit may leave a patch out of the answer (patchOmitted), never a problem, and the union of every verified patch
// is written here: <job>.verified-patch.json {schema, job, jobSha256, patch}; the answer says verifiedPatch {ops, call}, and
// the call (basedOn + patch "verified", job-patch.mjs resolvePatchedJob) applies them all, any size, for that job only.
//   patchUnion(problems)              -> [patch ops], each once, in the order of the problems
//   writeVerifiedPatch(jobFile, ops)  -> {verifiedPatch} | {} (nothing without a readable job file or a patch)
//   readVerifiedPatch(jobFile, sha)   -> {ok, patch} | {ok:false, error}
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const VERIFIED_PATCH_SCHEMA = 'ssam-verified-patch/1';
export const verifiedPatchFile = file => path.resolve(file) + '.verified-patch.json';
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function patchUnion(problems) {
  const seen = new Set(); const out = [];
  for (const p of Array.isArray(problems) ? problems : []) for (const op of (isObject(p) && Array.isArray(p.patch) ? p.patch : [])) {
    const key = JSON.stringify(op); if (!seen.has(key)) { seen.add(key); out.push(op); }
  }
  return out;
}

// Integration 24-1 familias (review): the union is no patch when two of its operations write different values at the same
// path (two replace or add of one html, the last would win and undo the other's correction). The kernel composes every
// correction of one document into one patch (JobRunner.Diagnosis, DocumentPatches); what still collides here is never
// written as "verified": each such path, with the problems that patch it, is returned.
export function patchConflicts(ops) {
  const byPath = new Map();
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!isObject(op) || !['replace', 'add'].includes(op.op) || typeof op.path !== 'string') continue;
    if (!byPath.has(op.path)) byPath.set(op.path, new Set());
    byPath.get(op.path).add(JSON.stringify(op.value ?? null));
  }
  return [...byPath.entries()].filter(([, values]) => values.size > 1).map(([path, values]) => ({ path, values: values.size }));
}
export const CONFLICT_NOTE = 'two patches of this refusal write different values at the same path (the last would undo the other): no patch, and no verified patch call; fix both problems in one text';

export function writeVerifiedPatch(jobFile, ops) {
  if (typeof jobFile !== 'string' || !jobFile || !Array.isArray(ops) || !ops.length) return {};
  const conflicts = patchConflicts(ops);
  if (conflicts.length) return { verifiedPatchRefused: { conflicts, why: CONFLICT_NOTE } };
  try {
    const job = path.resolve(jobFile);
    const jobSha256 = createHash('sha256').update(fs.readFileSync(job)).digest('hex');
    fs.writeFileSync(verifiedPatchFile(job), JSON.stringify({ schema: VERIFIED_PATCH_SCHEMA, job, jobSha256, patch: ops }), 'utf8');
    return { verifiedPatch: { ops: ops.length, call: { basedOn: { job, sha256: jobSha256 }, patch: 'verified' },
      note: 'every verified patch of this refusal, whole (a problem may say patchOmitted): send this basedOn with patch "verified" to apply them all' } };
  } catch { return {}; }
}

export function readVerifiedPatch(jobFile, sha256) {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(verifiedPatchFile(jobFile), 'utf8')); } catch { saved = null; }
  if (!saved || saved.schema !== VERIFIED_PATCH_SCHEMA || !Array.isArray(saved.patch) || !saved.patch.length)
    return { ok: false, error: 'patch "verified" applies the verified patches of a refusal of this job; none is kept beside ' + jobFile + ' (send the patch itself)' };
  if (String(saved.jobSha256).toLowerCase() !== String(sha256 ?? '').toLowerCase())
    return { ok: false, error: 'the verified patches kept beside ' + jobFile + ' were written for another version of that job' };
  if (patchConflicts(saved.patch).length)
    return { ok: false, error: 'the patches kept beside ' + jobFile + ' write different values at the same path: ' + CONFLICT_NOTE };
  return { ok: true, patch: saved.patch };
}
