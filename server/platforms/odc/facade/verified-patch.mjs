// The verified patches of a refusal, whole, beside the job they patch (integration 24-1 familias, 2026-10-13).
// The session's first refusal had two patches of a whole screen text (20 KB each): the fit of the answer kept one problem of
// five. Now the fit may leave a patch out of the answer (patchOmitted), never a problem, and the union of every verified patch
// is written here: <job>.verified-patch.json {schema, job, jobSha256, patch}; the answer says verifiedPatch {ops, call}, and
// the call (basedOn + patch "verified", job-patch.mjs resolvePatchedJob) applies them all, any size, for that job only.
//   patchUnion(problems, {all?})      -> [patch ops] of the certain patches (all: every patch), each once, in order
//   writeVerifiedPatch(jobFile, ops)  -> {verifiedPatch} | {} (nothing without a readable job file or a patch)
//   readVerifiedPatch(jobFile, sha)   -> {ok, patch} | {ok:false, error}
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hostedContext } from './executor.mjs';
import { namedPatch } from './job-patch.mjs';

export const VERIFIED_PATCH_SCHEMA = 'ssam-verified-patch/1';
export const verifiedPatchFile = file => path.resolve(file) + '.verified-patch.json';
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// T16 (review of e10ecacc): "patch": "verified" applies them for the author, so only the certain patches are in the union
// (patchCertain true: no choice of the author's); a choice (CREATE_USES_EXISTING, DELETE_RECONNECTS, a nearest name) is offered on
// its problem, never applied with the others. { all: true } takes every patch (the conflicts between offered patches).
export function patchUnion(problems, { all = false } = {}) {
  const seen = new Set(); const out = [];
  for (const p of Array.isArray(problems) ? problems : []) for (const op of (isObject(p) && Array.isArray(p.patch) && (all || p.patchCertain === true) ? p.patch : [])) {
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
    const bytes = fs.readFileSync(job);
    const jobSha256 = createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(verifiedPatchFile(job), JSON.stringify({ schema: VERIFIED_PATCH_SCHEMA, job, jobSha256, patch: ops }), 'utf8');
    // servidor/fase4-27 a12: hosted, the call is the explicit patch, by name (the gate refuses patch "verified" there: it
    // cannot read this file); every problem keeps its own patch there too (answer-size.mjs, refusal-problems.mjs fitProblems).
    if (hostedContext()) {
      let named = null;
      try { named = namedPatch(JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')), ops); } catch { named = null; }
      return { verifiedPatch: { ops: ops.length, call: { basedOn: { job, sha256: jobSha256 }, patch: named ?? ops },
        note: 'every verified patch of this refusal, whole: send this basedOn with this patch to apply them all' } };
    }
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
