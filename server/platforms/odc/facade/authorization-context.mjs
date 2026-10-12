// Contextual approval of a concrete proposal, recorded after the caller verified
// the actual human message. This is evidence, not an independent source of consent.
// Keep the literal words separate from the proposal and exact operation scope.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hostedContext } from './executor.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
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
      || record.words !== words || record.source?.kind !== 'human-conversation'
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
