// Contextual approval of a concrete proposal, recorded after the caller verified
// the actual human message. This is evidence, not an independent source of consent.
// Keep the words (their sha256, CX15 r4) separate from the proposal and exact operation scope.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hostedContext } from './executor.mjs';
import { appendJsonLine } from './correlation.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
// CX15 r4 (W-3): the record binds the human words by wordsSha256 (the sha256, 64 hex of the UTF-8 bytes, of the words the
// call carries in authorize: for an own-fixture cleanup, the owner's reply the guard validated), so the approval file never
// keeps the words. words (the literal reply) is still accepted, PROVISIONALLY until the owner decides; a record with both
// must match on both, and a record with neither binds no words (refused).
function wordsMatch(record, words) {
  const hashed = record.wordsSha256, literal = record.words;
  if (hashed === undefined && literal === undefined) return false;
  if (hashed !== undefined && (typeof hashed !== 'string' || hashed.toLowerCase() !== sha(words))) return false;
  return literal === undefined || literal === words;
}
const bad = () => { throw Object.assign(new Error('The authorization context is missing, altered or does not cover this exact operation and target. Nothing was sent.'), { code: 'AUTHORIZATION_CONTEXT_INVALID' }); };
// servidor/fase4-24 (R1/R3 of PLANO-24-PRODUCAO): hosted, both files (the context, which the gate already resolves through
// hosted/tools.json, and the proposal it names) must be files of the customer's visible workspace (odc/, o11/, inbox/):
// a ws:<rel> name or an absolute path inside it, real path included. Anything else is refused as a bad context; no file
// of the server or of another customer is ever read or hashed.
const VISIBLE = ['odc', 'o11', 'inbox'];
function inWorkspace(file) {
  const context = hostedContext();
  if (!context) return path.isAbsolute(file) ? file : null;
  const workspace = path.resolve(context.workspace);
  const abs = file.startsWith('ws:') ? path.resolve(workspace, ...file.slice(3).split(/[\\/]+/).filter(Boolean))
    : path.isAbsolute(file) ? path.resolve(file) : null;
  const inside = candidate => { const rel = path.relative(workspace, candidate); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && VISIBLE.includes(rel.split(/[\\/]/)[0].toLowerCase()); };
  if (!abs || !inside(abs)) return null;
  try { if (!inside(fs.realpathSync(abs))) return null; } catch { /* a missing file is refused by the read */ }
  return abs;
}

export function authorizationContext(file, words, { lane, host, operation, targets = [], environmentKey, constraints }) {
  if (file === undefined || file === null) return null;
  if (!text(file) || !text(words) || !['odc', 'o11'].includes(lane) || !text(host) || !text(operation)) bad();
  file = inWorkspace(file);
  if (!file) bad();
  let bytes, record, proposal;
  try {
    if (fs.statSync(file).size > 32768) bad();
    bytes = fs.readFileSync(file); record = JSON.parse(bytes);
    if (record.schema !== 'ssam-authorization-context/1' || record.decision !== 'approved'
      || !wordsMatch(record, words) || record.source?.kind !== 'human-conversation'
      || !uuid(record.source.threadId) || !uuid(record.source.messageId)
      || !text(record.source.question) || !text(record.proposal?.file)
      || !inWorkspace(record.proposal.file) || !/^[a-f0-9]{64}$/.test(record.proposal.sha256 ?? '')
      || !Array.isArray(record.scope) || !record.scope.length || record.scope.length > 20) bad();
    const proposalFile = inWorkspace(record.proposal.file);
    if (fs.statSync(proposalFile).size > 131072) bad();
    proposal = fs.readFileSync(proposalFile);
  } catch { bad(); }
  if (sha(proposal) !== record.proposal.sha256) bad();
  if (constraints && Object.entries(constraints).some(([key, value]) => record.constraints?.[key] !== value)) bad();
  // No wildcard, prefix, external consumer or inferred target expansion.
  const matches = record.scope.filter(s => s.lane === lane && s.host === host && s.operation === operation
    && (environmentKey === undefined || s.environmentKey === environmentKey));
  const allowed = matches.flatMap(s => Array.isArray(s.targets) ? s.targets : []);
  if (!matches.length || allowed.some(t => !text(t) || t.includes('*')) || !targets.length
    || targets.some(t => !text(t) || !allowed.includes(t))) bad();
  return { file, sha256: sha(bytes), wordsSha256: sha(words), proposalSha256: record.proposal.sha256,
    source: { threadId: record.source.threadId, messageId: record.source.messageId }, lane, host, operation,
    targets: [...targets], ...(environmentKey === undefined ? {} : { environmentKey }), ...(constraints ? { constraints: { ...constraints } } : {}) };
}

// ---- R1 (plan of 2026-10-24, "the correction loop has no friction of its own"): the correction chain of a write.
// A write that ran with the user's words (or a standing grant) and was refused, or left uncertain, leaves one line in
// <journal>/correction-chain.jsonl: the job it ran (path, sha256), its kernel taskId, module and lane, the sha256 of the
// words (never the words) and where they came from (words, standing-grant, inherited), and its problems by code and
// pointer (problemSignature). A correction of that write on the same module and lane (patch, partial job, fix:"apply" or
// resume, whose basedOn {job}/{taskId} names it) takes its authorization: chainOrigin finds the line, which survives a
// restart. Publishing never inherits; a write that names no refused write of the chain needs the words again.
export const CHAIN_FILE = 'correction-chain.jsonl';
const SHA = /^[a-f0-9]{64}$/i;
const TASK = /^[0-9a-f]{32}$/i;
// The module as people name it: letters and digits, without case (as o11-cycle.mjs compares delivered jobs).
export const chainModuleId = module => String(module ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const lower = value => String(value ?? '').toLowerCase();
const CHAIN_READ_MAX = 4 * 1024 * 1024;

// The problems of a refusal as a multiset of code|pointer (a grouped problem counts once per pointer), sorted.
export function problemSignature(problems) {
  const out = [];
  for (const p of Array.isArray(problems) ? problems : []) {
    if (!p || typeof p !== 'object') continue;
    const pointers = Array.isArray(p.pointers) && p.pointers.length ? p.pointers
      : Array.isArray(p.items) && p.items.length ? p.items.map(i => i?.pointer ?? null)
        : [p.pointer ?? p.at ?? null];
    for (const at of pointers) out.push(String(p.code ?? p.error ?? '') + '|' + String(at ?? ''));
  }
  return out.sort();
}
export const sameSignature = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);

// entry: {lane, tool, module, job, jobSha256, taskId?, outcome, authorization: {source, wordsSha256, from?}, problems?}.
// A line that cannot be written never changes the answer of the write.
export function recordChainWrite(journalDir, entry, { now = () => new Date() } = {}) {
  if (!text(journalDir) || !entry || !SHA.test(String(entry.jobSha256 ?? '')) || !chainModuleId(entry.module)
    || !SHA.test(String(entry.authorization?.wordsSha256 ?? ''))) return false;
  const line = { at: now().toISOString(), lane: entry.lane ?? null, tool: entry.tool ?? null, module: entry.module, moduleId: chainModuleId(entry.module),
    job: entry.job ?? null, jobSha256: lower(entry.jobSha256), ...(TASK.test(String(entry.taskId ?? '')) ? { taskId: lower(entry.taskId) } : {}),
    outcome: entry.outcome ?? 'refused',
    authorization: { source: entry.authorization.source, wordsSha256: lower(entry.authorization.wordsSha256), ...(entry.authorization.from ? { from: entry.authorization.from } : {}) },
    ...(Array.isArray(entry.problems) ? { problems: entry.problems } : {}) };
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    appendJsonLine(path.join(journalDir, CHAIN_FILE), line);   // F7: the one traced writer of a record line
    return true;
  } catch { return false; }
}

function chainLines(journalDir) {
  let body;
  try {
    const file = path.join(journalDir, CHAIN_FILE);
    const size = fs.statSync(file).size;
    if (size > CHAIN_READ_MAX) { const fd = fs.openSync(file, 'r'); try { const buffer = Buffer.alloc(CHAIN_READ_MAX); fs.readSync(fd, buffer, 0, CHAIN_READ_MAX, size - CHAIN_READ_MAX); body = buffer.toString('utf8'); } finally { fs.closeSync(fd); } }
    else body = fs.readFileSync(file, 'utf8');
  } catch { return []; }
  const out = [];
  for (const raw of body.split('\n')) { if (!raw.trim()) continue; try { const v = JSON.parse(raw); if (v && typeof v === 'object') out.push(v); } catch { /* a torn line */ } }
  return out;
}

// The newest write of the chain a correction names, on the same module (any module when none is named: the write's own) and lane: by its kernel taskId, else by the job it
// ran (sha256s, then each ancestor ancestorsOf(sha) gives, the nearest first). outcomes: the outcomes that pass ('refused'
// for a correction; a resume also takes 'uncertain'). -> the line, or null.
export function chainOrigin(journalDir, { sha256s = [], taskId = null, module, lane = null, outcomes = ['refused'], ancestorsOf = null } = {}) {
  const id = chainModuleId(module);
  if (!text(journalDir)) return null;
  const lines = chainLines(journalDir).filter(l => (!id || l.moduleId === id) && (lane == null || l.lane == null || l.lane === lane) && outcomes.includes(l.outcome)
    && SHA.test(String(l.authorization?.wordsSha256 ?? '')));
  if (!lines.length) return null;
  const newest = list => list.length ? list[list.length - 1] : null;
  if (TASK.test(String(taskId ?? ''))) { const hit = newest(lines.filter(l => l.taskId === lower(taskId))); if (hit) return hit; }
  const wanted = [...new Set(sha256s.filter(h => SHA.test(String(h ?? ''))).map(lower))];
  for (const hash of wanted) { const hit = newest(lines.filter(l => l.jobSha256 === hash)); if (hit) return hit; }
  if (typeof ancestorsOf === 'function') for (const hash of wanted) {
    let ancestors = [];
    try { ancestors = ancestorsOf(hash) ?? []; } catch { ancestors = []; }
    for (const each of ancestors) { const hit = newest(lines.filter(l => l.jobSha256 === lower(each))); if (hit) return hit; }
  }
  return null;
}

// A correction of a refused write, as the hub (ssam.mjs) sees a call before its handler: o11_deliver, studio_deliver or
// ssam_code write with fix, resume or basedOn {job}/{taskId}, that does not publish. The words marker of an earlier
// continuation in its authorize is dropped there and the handler decides by the chain (o11: the words of the refused
// write; odc: a delivery needs none); publishing still needs the words.
export function chainCorrection(tool, args) {
  if (!args || typeof args !== 'object' || args.publish === true) return false;
  if (!['o11_deliver', 'studio_deliver'].includes(tool) && !(tool === 'ssam_code' && args.action === 'write')) return false;
  const base = args.basedOn;
  return args.fix != null || (tool === 'o11_deliver' && typeof args.resume === 'string')
    || (!!base && typeof base === 'object' && !Array.isArray(base) && (text(base.job) || text(base.taskId)));
}
