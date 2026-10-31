// A delivery after a cut merge is safe by construction, not by reading the state of the cut. A cut that may have left something in the
// module leaves one record per module: each job that was cut, with the identity of the base it was built on. That job goes again only
// while the open module is that base, checked twice: here, on a fresh capture, before anything is built, by the content sha256 of the
// capture (oml-content-sha.mjs: the Studio writes its own state into the header of every save, so the raw sha256 of an unchanged
// module differs across a restart); and in the bridge (StartupHook.cs Run, Manifest.ExpectedBaseSha256), on the open module, in the
// merge's own job, right before the hand-off to CompareAndMerge, by the raw sha256 of that fresh capture. So a late merge, another
// Studio, a restart and a partial merge all end in one refusal, MODULE_NOT_AT_BASE, with nothing merged, and nothing has to guess.
// Only a real cut, in an uncertain state, leaves a record: a known ending has nothing to refuse. The refusal is for the same job. A new
// job is a correction, and a correction needs a reading: over a module that is not the base, it goes after anything has read this module
// (studio_publish {module}, with or without reconcile, whatever it finds) or a delivery ended clean. The repair a cut computed is known by its hash.
// An answer to a cut never builds a call that delivers: it says what is known and what to read.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase();
const fileOf = (root, { moduleKey, host }) => path.join(root, 'journal', 'merge-cuts', createHash('sha256').update(String(moduleKey) + '|' + String(host ?? '').toLowerCase()).digest('hex').slice(0, 32) + '.json');
// Whole or not at all: a reader never finds half a record.
const write = (root, identity, value) => {
  const file = fileOf(root, identity);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2)); fs.renameSync(temporary, file); }
  finally { try { fs.rmSync(temporary, { force: true }); } catch { /* it was renamed, or the error above says why */ } }
};

// The job as the session wrote it: the same call, however it reached this server.
export const cutJobSha = document => createHash('sha256').update(JSON.stringify(document ?? null)).digest('hex');

// null: no record. {unreadable:true, file, error}: there is one and it says nothing, which is not the same: it fails closed.
export function readCut(root, identity) {
  if (!root || !identity?.moduleKey) return null;
  const file = fileOf(root, identity);
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (record === null || typeof record !== 'object' || record.jobs === null || typeof record.jobs !== 'object') return { unreadable: true, file, error: 'it is not a record of a cut' };
    return record;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    return { unreadable: true, file, error: error.code ?? 'its content is not JSON' };
  }
}
// A cut of this job over this base (baseSha256: the content identity; rawBaseSha256: what a manifest names). A job already on record
// keeps its first base: that is the module it was built for.
export function recordCut(root, identity, { jobSha256, baseSha256, rawBaseSha256 = null, pid = null, lab = null, module = null, repairs = [], read = false }) {
  if (!identity?.moduleKey) return;
  const earlier = readCut(root, identity);
  if (earlier?.unreadable) throw new Error('the record cannot be read');
  {
    write(root, identity, { moduleKey: identity.moduleKey, host: identity.host ?? null, module, pid, lab, at: new Date().toISOString(), read,
      jobs: { ...(earlier?.jobs ?? {}), ...(earlier?.jobs?.[jobSha256] ? {} : { [jobSha256]: baseSha256 }) },
      repairs: [...new Set([...(earlier?.repairs ?? []), ...repairs])],
      rawBases: [...new Set([...(earlier?.rawBases ?? []), ...(rawBaseSha256 ? [rawBaseSha256] : [])])] });
  }
}
// Before the hand-off, always: a server that dies during the merge, or a record that cannot be written, must not leave the job free to go
// again. -> {ok:true, earlier} | {ok:false, error}: then nothing is delivered.
export function beginCut(root, identity, cut) {
  if (!identity?.moduleKey) return { ok: true, earlier: null, none: true };
  const earlier = readCut(root, identity);
  try { recordCut(root, identity, cut); return { ok: true, earlier }; }
  catch (error) { return { ok: false, error: error.message }; }
}
// How the merge ended. uncertain: a real cut, the record stays and new jobs need a reading. Known: what was written before the hand-off is
// taken back, as if never written, and a job already on record stays bound; a delivery that ended clean settles the record.
export function settleCut(root, identity, begun, { uncertain, delivered = false, cut }) {
  if (!identity?.moduleKey || !begun?.ok || begun.none) return;
  try {
    if (uncertain) { recordCut(root, identity, { ...cut, read: delivered }); return; }
    if (!begun.earlier) { fs.rmSync(fileOf(root, identity), { force: true }); return; }
    write(root, identity, { ...begun.earlier, ...(delivered ? { read: true, readAt: new Date().toISOString() } : {}) });
  } catch { /* the record written before the hand-off stays: it errs on the side of a reading */ }
}
// Someone read this module since the cut, or a delivery ended clean over it: a different job may go. The jobs on record stay bound to their base.
export function markCutRead(root, identity) {
  const cut = readCut(root, identity);
  if (!cut || cut.read === true) return;
  // Unreadable: set aside beside it, never deleted, and said so in the refusal that sent the session here.
  if (cut.unreadable) {
    try {
      fs.renameSync(cut.file, cut.file.replace(/\.json$/, '') + '.unreadable-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
      write(root, identity, { moduleKey: identity.moduleKey, host: identity.host ?? null, at: new Date().toISOString(), read: true, jobs: {}, repairs: [], rawBases: [], setAside: true });
    } catch { /* it stays unreadable, and the refusal stands */ }
    return;
  }
  try { write(root, identity, { ...cut, read: true, readAt: new Date().toISOString() }); } catch { /* it stays unread: the refusal names the reading */ }
}

// What a new delivery may do over a record. alive: the pids of the Studios listed now, or null when nobody could say.
// -> {refuse:true, reason:'not-at-base'|'other-studio'|'not-read'} | {refuse:false}.
export function cutVerdict(cut, { openSha256, jobSha256, pid = null, alive = null }) {
  const base = cut.jobs?.[jobSha256];
  const known = typeof base === 'string';
  const repair = (cut.repairs ?? []).includes(jobSha256);
  const atSomeBase = Object.values(cut.jobs ?? {}).some(sha => same(sha, openSha256));
  // A merge of another Studio process that is still there: its module is not this one, and it may hold the job. A bridge may name no pid,
  // and then the list of Studios decides: with one open it can only be that one; with more, or none known, it may be another.
  const named = Number.isInteger(cut.pid) && Number.isInteger(pid);
  const elsewhere = named ? cut.pid !== pid && (alive === null || alive.includes(cut.pid)) : alive === null || alive.length > 1;
  if ((known || cut.read !== true) && !repair && elsewhere) return { refuse: true, reason: 'other-studio' };
  if (known && !same(openSha256, base)) return { refuse: true, reason: 'not-at-base' };
  if (!known && !repair && cut.read !== true && !atSomeBase) return { refuse: true, reason: 'not-read' };
  return { refuse: false };
}

export function notAtBaseRefusal(cut, { reason, jobSha256 = null, openSha256, module, pid = null }) {
  const baseSha256 = cut.jobs?.[jobSha256] ?? Object.values(cut.jobs ?? {}).at(-1) ?? null;
  const why = reason === 'other-studio'
    ? (Number.isInteger(cut.pid) && Number.isInteger(pid)
      ? 'A delivery to this module was cut at ' + cut.at + ' in the ODC Studio process ' + cut.pid + ', which is still open, and this call reaches process ' + pid + ': it may be in that module, whole or in part.'
      : 'A delivery to this module was cut at ' + cut.at + ' and more than one ODC Studio is open, or that could not be read: which one has it is not known, and it may be in that module, whole or in part.')
    : reason === 'not-read'
      ? 'A delivery to this module was cut at ' + cut.at + ' and may be in it, whole or in part: the open module (content sha256 ' + openSha256 + ') is not the base of that delivery (content sha256 ' + baseSha256 + '), and nothing read it since.'
      : 'This same job was cut at ' + cut.at + ' and may be in the module, whole or in part: the open module (content sha256 ' + openSha256 + ') is not the base it was built on (content sha256 ' + baseSha256 + ').';
  return { code: 'MODULE_NOT_AT_BASE', outcome: 'not-sent', merged: null, baseSha256, openSha256, cut: { at: cut.at, pid: cut.pid ?? null },
    error: why + ' Nothing was built or merged. A job that was cut goes again only over its own base; a different job, of what is really missing, goes once the module was read.',
    continuation: reason === 'other-studio'
      ? { tool: 'studio_status', arguments: { view: 'brief', ...(Number.isInteger(pid) ? { pid } : {}) }, why: 'which modules each Studio has open; the process of that delivery holds its answer. studio_publish {module, reconcile:true} reads the module of this one' }
      : { tool: 'studio_publish', arguments: { module, reconcile: true, ...(Number.isInteger(pid) ? { pid } : {}) }, why: 'compares the open module with that delivery (nothing is merged or published): what differs, or that it is all there' } };
}

// The check of a new delivery, for both roads (kernel-delivery.mjs; lib.mjs deliver with a C# feature, whose job is its name).
// -> {} no record | {refusal} | {afterCut}: it goes, and its manifest carries the sha for the bridge.
export async function checkCut(root, identity, { jobSha256, openSha256, pid = null, module, otherPids = null }) {
  const cut = readCut(root, identity);
  if (!cut) return {};
  if (cut.unreadable) return { refusal: unreadableRefusal(cut, { module, pid }) };
  let alive = null;
  try { alive = typeof otherPids === 'function' ? await otherPids() : null; } catch { alive = null; }
  const verdict = cutVerdict(cut, { openSha256, jobSha256, pid, alive });
  if (verdict.refuse) return { refusal: notAtBaseRefusal(cut, { reason: verdict.reason, jobSha256, openSha256, module, pid }) };
  return { afterCut: { at: cut.at } };
}

export function unreadableRefusal(cut, { module, pid = null }) {
  return { code: 'CUT_RECORD_UNREADABLE', outcome: 'not-sent', merged: null,
    error: 'The record of an earlier cut of this module (' + path.basename(cut.file) + ') cannot be read (' + cut.error + '), so which job was cut, and over which base, is not known. Nothing was built or merged.',
    continuation: { tool: 'studio_publish', arguments: { module, reconcile: true, ...(Number.isInteger(pid) ? { pid } : {}) },
      why: 'compares the open module with its last delivery (nothing is merged or published), and sets the file aside, kept beside it. From then on nothing compares a job with that base: send only what the module lacks' } };
}
export function notWrittenRefusal({ error }) {
  return { code: 'CUT_RECORD_NOT_WRITTEN', outcome: 'not-sent', merged: false,
    error: 'The record that protects this merge against a second one could not be written (' + error + '). The merge was not sent, and nothing was merged.' };
}

// A merge reached by another road (studio_merge, a manifest built earlier): the same rule, on its manifest. A delivery that passed the
// check marks its manifest (afterCut); a manifest over a base on record, or a module already read, goes to the bridge, which compares
// its base with the open module.
export function mergeManifestRefusal(root, document) {
  const cut = readCut(root, { moduleKey: document?.moduleKey, host: document?.tenant });
  if (!cut || document.afterCut === true) return null;
  if (cut.unreadable) return { ok: false, ...unreadableRefusal(cut, { module: document.module }) };
  if (cut.read === true || (cut.rawBases ?? []).some(sha => same(sha, document.baseSha256))) return null;
  return { ok: false, ...notAtBaseRefusal(cut, { reason: 'not-read', openSha256: document.baseSha256 ?? null, module: document.module }) };
}
