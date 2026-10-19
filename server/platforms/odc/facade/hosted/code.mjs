// servidor/fase4-26 a8 (owner request 18/10): the ssam_code of a hosted session. The product's ssam_code takes, per call,
// the deps of a server that keeps each session apart (ssam.mjs deps.code: code-check.mjs roots, code-plan.mjs place, the
// read an edit of logic expands). Here they are this customer's:
//   roots        <ws>/o11 (captures, producer cache, check jobs, plans), <ws>/odc (captures, producer captures) and
//                <ws>/odc/lab (the ODC check jobs and plans): folders the agent's mirror shares where the plan needs it
//   place        a plan's files as the session sees them: on the server ws:<rel>; the files its subagents write, in the agent
//                inbox of the user's machine (<agent folder>\inbox\<rel>: the gate maps that path back and brings the file
//                at each call); its prompts and plan.json, copied to the user's machine (<agent folder>\<rel>) before the
//                answer; SSAM's documentation in a prompt passes the licensee rule, as a work packet's does
//   readReading  the read of an action an edit of logic expands: only one this customer was served (record), kept by its
//                textSha in <ws>/state/code-readings/<lane>/ (state/: the agent never writes there, ssam_evidence never reads
//                it). The module index is shared by every customer and addressed by hashes; this is the customer's own
//                list of what it read
//   record       notes the textSha of every action an answer of this customer's reads carries (ssam_code read, ssam_map)
import fs from 'node:fs';
import path from 'node:path';
import { classify } from './mirror.mjs';
import { exposedValue } from '../exposure.mjs';
import { loadFlowReading } from '../flow-edits.mjs';

export const READINGS_FOLDER = Object.freeze(['state', 'code-readings']);
const TEXT_SHA = /^[a-f0-9]{16}$/;
const LANES = new Set(['o11', 'odc']);
const coded = (code, message) => Object.assign(new Error(message), { code });

// The textShas an answer carries (any depth, bounded).
function textShas(value, out = new Set(), budget = { left: 200000 }, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 32 || --budget.left < 0) return out;
  if (Array.isArray(value)) { for (const item of value) textShas(item, out, budget, depth + 1); return out; }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'textSha' && typeof item === 'string' && TEXT_SHA.test(item.toLowerCase())) out.add(item.toLowerCase());
    else if (item && typeof item === 'object') textShas(item, out, budget, depth + 1);
  }
  return out;
}

export function hostedCode(context) {
  const workspace = path.resolve(context.workspace);
  let agentRoot = null;
  try { agentRoot = context.agent?.info?.()?.agentRoot ?? null; } catch { agentRoot = null; }
  if (typeof agentRoot !== 'string' || !path.win32.isAbsolute(agentRoot)) agentRoot = null;
  const where = file => { const at = typeof file === 'string' ? classify(workspace, file) : { visible: false }; return at.visible ? at : null; };
  const onMachine = rel => (agentRoot ? path.win32.join(agentRoot, ...rel.split('/')) : 'agent:' + rel);
  const place = {
    shown: file => { const at = where(file); return at ? 'ws:' + at.rel : file; },
    output: file => { const at = where(file); return at ? onMachine('inbox/' + at.rel) : file; },
    input: file => { const at = where(file); return at ? onMachine(at.rel) : file; },
    document: (section, value) => exposedValue(value, { exposure: 'licensee', handleRoots: [workspace], tool: 'ssam_discover', args: {} }),
    publish: async files => {
      if (!agentRoot) throw coded('AGENT_FOLDER_UNKNOWN', 'The SSAM agent of this account does not report its folder, so a plan cannot name where its subagents read and write. Ask the server owner for the current agent package; ssam_code check and write still work here.');
      const mirror = context.executor?.mirror;
      if (typeof mirror?.putMany !== 'function') throw coded('AGENT_NOT_CONNECTED', 'The SSAM agent of this account is not connected, so the prompts of the plan could not reach the user\'s machine.');
      const entries = files.map(file => {
        const at = classify(workspace, file);
        if (!at.visible || !at.writable) throw coded('PATH_NOT_STAGEABLE', 'A file of the plan is outside the folders the agent may write.');
        return { source: file, target: mirror.agentOf(at.rel) };
      });
      await mirror.putMany(entries);
    },
  };
  const folder = lane => path.join(workspace, ...READINGS_FOLDER, lane);
  const record = (lane, value) => {
    if (!LANES.has(lane)) return 0;
    let kept = 0;
    for (const sha of textShas(value)) {
      const file = path.join(folder(lane), sha);
      try { if (!fs.existsSync(file)) { fs.mkdirSync(folder(lane), { recursive: true }); fs.writeFileSync(file, ''); } kept++; } catch { /* a read not kept is only an edit refused later */ }
    }
    return kept;
  };
  const readReading = (lane, sha, { load = loadFlowReading } = {}) => {
    const id = typeof sha === 'string' ? sha.toLowerCase() : '';
    if (!LANES.has(lane) || !TEXT_SHA.test(id) || !fs.existsSync(path.join(folder(lane), id))) return null;
    return load(lane, id);
  };
  return { roots: { o11: path.join(workspace, 'o11'), odc: path.join(workspace, 'odc'), odcWork: path.join(workspace, 'odc', 'lab') }, place, readReading, record };
}
