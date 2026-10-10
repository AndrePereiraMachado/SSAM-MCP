// ODC bridge commands through the agent (docs/FASE2-AGENTE.md 4.5, table "Comando da bridge"): which argument of each
// command is a file, its role (input or output), what goes to the agent before and what comes back after. The bridge
// on the customer machine only ever sees agent:<rel> paths under its own root; the server only ever keeps workspace
// paths. Out of band: only the strings the agent reports it rewrote (value.paths) and the fields the server reads as
// files pass through fromAgent, before anything is written; any other text, even one that starts with agent:, is data.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MirrorError, violation } from './mirror.mjs';

export const MANIFEST_COMMANDS = Object.freeze(['check-base', 'preview', 'merge', 'publish', 'publish-status', 'create', 'authorize', 'create-app']);
// The manifest fields the bridge reads as paths (studio/shared/Manifest.cs), the only ones json:"agent-paths" rewrites.
export const MANIFEST_FIELDS = Object.freeze(['basePath', 'candidatePath', 'producerPath', 'builderReceipt', 'evidenceDir']);
const INPUT_FIELDS = ['basePath', 'candidatePath', 'producerPath', 'builderReceipt'];
const DATA_REQUESTS = 'agent:odc/journal/data/requests/';
const PORTAL_REQUESTS = 'agent:odc/journal/portal/requests/';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const key = file => path.resolve(file).toLowerCase();
const within = (base, target) => { const rel = path.relative(base, target); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const ignorable = error => error?.code === 'FILE_NOT_FOUND' || error?.code === 'PATH_NOT_FOUND';
const requestTarget = (folder, file) => folder + path.basename(String(file));
// C14: what a successful merge leaves in its evidence that nothing on the server reads (the module after the merge, 2.8 MB,
// and the match trees, up to 600 KB): it stays on the agent; a failed merge brings everything. A later tool call that names
// one of them brings it on demand (hosted/policy.mjs).
export const SUCCESS_ONLY_EVIDENCE = /(^|[\\/])(after-merge\.oml|match-tree\.txt|second-pass-match-tree\.txt)$/i;

// The agent paths of a reply, out of band: `paths` (what the agent reports it rewrote, [key|index, ...] each) plus
// `required` (the fields the server reads as files, which must be agent: strings whether reported or not). Returns the
// reply (parsed JSON, changed in place) with each of those strings replaced by fn(value, parent, key). A malformed key
// path, or one that names anything but an agent: string, is a protocol violation; nothing else of the reply is looked at.
const KEY = key => (typeof key === 'string' && key.length <= 1024) || (Number.isSafeInteger(key) && key >= 0);
export function mapAgentPaths(reply, paths, fn, { link, required = [] } = {}) {
  if (paths === undefined || paths === null) paths = [];
  if (!Array.isArray(paths) || !paths.every(keys => Array.isArray(keys) && keys.length <= 64 && keys.every(KEY)))
    throw violation(link, 'malformed paths', JSON.stringify(paths).slice(0, 200));
  const seen = new Set();
  let root = reply;
  for (const keys of [...paths, ...required]) {
    const id = JSON.stringify(keys);
    if (seen.has(id)) continue;
    seen.add(id);
    let parent = null, key = null, node = root;
    for (const k of keys) {
      if (node === null || typeof node !== 'object' || Array.isArray(node) !== (typeof k === 'number') || !Object.hasOwn(node, k)) { node = undefined; break; }
      parent = node; key = k; node = node[k];
    }
    if (typeof node !== 'string' || !node.startsWith('agent:')) throw violation(link, 'a reported path that is not an agent: text', id);
    const mapped = fn(node, parent, key);
    if (parent === null) root = mapped;
    else Object.defineProperty(parent, key, { value: mapped, writable: true, enumerable: true, configurable: true });
  }
  return root;
}
// The key path of a field when the reply has it (a string), else nothing: a field the server reads must be agent:.
export const requiredIf = (reply, keys) => {
  let node = reply;
  for (const k of keys) { if (node === null || typeof node !== 'object' || !Object.hasOwn(node, k)) return []; node = node[k]; }
  return typeof node === 'string' ? [keys] : [];
};

// The manifest of a manifest command: its inputs by sha256, the rewritten manifest (five fields as agent:, json:
// "agent-paths"), and from its folder only what the agent lacks; afterwards the folder and evidenceDir come back.
async function stageManifest(manifestAbs, mirror) {
  if (typeof manifestAbs !== 'string' || !path.isAbsolute(manifestAbs))
    throw new MirrorError('PATH_OUTSIDE_WORKSPACE', 'The manifest path is not a workspace path: ' + JSON.stringify(String(manifestAbs)));
  const manifestDir = path.dirname(manifestAbs);
  const agentManifest = mirror.output(manifestAbs);
  const agentDir = mirror.output(manifestDir);
  let manifest;
  try { manifest = readJson(manifestAbs); }
  catch { throw new MirrorError('FILE_NOT_FOUND', 'Manifest not readable in the workspace: ' + agentManifest.replace(/^agent:/, 'ws:')); }
  const rewritten = { ...manifest };
  let evidenceAbs = null, agentEvidence = null;
  if (typeof manifest.evidenceDir === 'string' && manifest.evidenceDir) {
    evidenceAbs = manifest.evidenceDir;
    agentEvidence = mirror.output(evidenceAbs);
    rewritten.evidenceDir = agentEvidence;
  }
  // C14: the inputs, the rewritten manifest and the files of its folder the agent lacks go in ONE file.sync call (an agent
  // before 0.2.0: one file.put each and a listing of the folder, as before).
  const sent = new Set([key(manifestAbs)]);
  const puts = [];
  for (const field of INPUT_FIELDS) {
    const value = manifest[field];
    if (typeof value !== 'string' || !value) continue;
    const plan = await mirror.inputPlan(value, 'odc');
    rewritten[field] = plan.target;
    puts.push(...plan.puts);
    sent.add(key(value));
  }
  const temp = path.join(mirror.workspace, 'odc', 'tmp', 'manifest-' + randomUUID() + '.json');
  fs.mkdirSync(path.dirname(temp), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(rewritten, null, 2));
  const sync = mirror.link?.supports?.('file.sync') === true;
  puts.push({ source: temp, target: agentManifest, json: 'agent-paths' });
  if (sync) puts.push(...mirror.missingPlan(manifestDir, sent));
  try { await mirror.putMany(puts); }
  finally { fs.rmSync(temp, { force: true }); }
  if (!sync) await mirror.pushMissing(manifestDir, sent);

  // The manifest as the agent has it (authorize changes it): the five fields come back as agent: and become workspace
  // paths again; an unchanged manifest leaves the server copy untouched.
  const manifestBack = async (temp, dest) => {
    const back = readJson(temp);
    for (const field of MANIFEST_FIELDS) {
      const value = back[field];
      if (value === undefined || value === null || value === '') continue;
      back[field] = mirror.fromAgent(value);
    }
    let current = null;
    try { current = readJson(dest); } catch { /* no server copy */ }
    if (current && isDeepStrictEqual(current, back)) return false;
    fs.writeFileSync(temp, JSON.stringify(back, null, 2));
    return true;
  };
  // Returns the agent paths now in sync, so a reply naming them does not bring them again (never the raw manifest).
  return {
    agentManifest,
    async after({ skip = () => false } = {}) {
      const synced = new Set([agentManifest]);
      const folder = await mirror.pullDir(agentDir, entry => key(entry.abs) === key(manifestAbs) ? { json: 'agent-paths', transform: manifestBack } : {}, { skip });
      for (const agentPath of [...folder.listed, ...folder.skipped]) synced.add(agentPath);
      if (agentEvidence && !within(manifestDir, evidenceAbs)) {
        const evidence = await mirror.pullDir(agentEvidence, () => ({}), { skip });
        for (const agentPath of [...evidence.listed, ...evidence.skipped]) synced.add(agentPath);
      }
      return synced;
    },
  };
}

// One odc.pipe call: { params } to send and after(value) for the reply. Errors before the send are MirrorErrors with
// sent:false (nothing reached the agent for this command).
export async function stageOdcPipe(params, mirror) {
  const args = (params?.args ?? []).map(String);
  const command = args[0];
  const out = [...args];
  const outputs = [];
  let manifest = null;
  const valueAfter = flag => { const index = args.indexOf(flag); return index > 0 && index + 1 < args.length ? index + 1 : -1; };

  if (MANIFEST_COMMANDS.includes(command) && args.length > 1) {
    manifest = await stageManifest(args[1], mirror);
    out[1] = manifest.agentManifest;
  } else if (command === 'open' && args.length > 2) {
    out[2] = await mirror.input(args[2], 'odc');
  } else if (command === 'data-insert' || command === 'data-update') {
    const at = valueAfter('--records-file');
    if (at > 0) out[at] = await mirror.input(args[at], 'odc', { to: requestTarget(DATA_REQUESTS, args[at]) });
  } else if (command === 'data') {
    const at = valueAfter('--out');
    if (at > 0) { out[at] = mirror.output(args[at]); outputs.push(out[at]); }
  } else if (command === 'portal-call' && args.length > 1) {
    out[1] = await mirror.input(args[1], 'odc', { to: requestTarget(PORTAL_REQUESTS, args[1]) });
  } else if (command === 'portal-session' && args[1] === 'fetch' && args.length > 2) {
    out[2] = await mirror.input(args[2], 'odc', { to: requestTarget(PORTAL_REQUESTS, args[2]) });
  } else if (command === 'query-test' && args.length > 1) {
    // The native query test reads its capture by path (request.source): the capture goes to the agent by sha256 first.
    let request = null;
    try { request = JSON.parse(args[1]); } catch { /* not a request object: nothing to stage */ }
    if (request && typeof request.source === 'string' && request.source) out[1] = JSON.stringify({ ...request, source: await mirror.input(request.source, 'odc') });
  } else if (command === 'reference-snapshot' && args.length > 1) {
    let request = null;
    try { request = JSON.parse(args[1]); } catch { /* not a request object: nothing to stage */ }
    if (request && typeof request.output === 'string') {
      const agentOutput = mirror.output(request.output);
      out[1] = JSON.stringify({ ...request, output: agentOutput });
      outputs.push(agentOutput);
    }
  }

  return {
    params: { ...params, args: out },
    async after(value) {
      const { paths, ...rest } = value ?? {};
      let reply, parsed = true;
      try { reply = JSON.parse(String(value?.line ?? '')); } catch { parsed = false; }
      if (!parsed && Array.isArray(paths) && paths.length) throw violation(mirror.link, 'paths in a reply that is not JSON', String(value?.line ?? ''));
      // 1. The agent paths (what the agent rewrote, and the capture a snapshot or latest names, which the server reads)
      //    are confined first: a violation writes nothing.
      const named = [];
      const required = (command === 'snapshot' || command === 'latest') && reply?.ok === true ? requiredIf(reply, ['path']) : [];
      const mapped = !parsed ? null : mapAgentPaths(reply, paths, (text, parent, name) => {
        const abs = mirror.fromAgent(text);
        const sha = name === 'path' && typeof parent?.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(parent.sha256) ? parent.sha256 : null;
        named.push({ agentPath: text, sha256: sha });
        return abs;
      }, { link: mirror.link, required });
      // 2. What the bridge wrote comes back: the manifest folder and evidence, the outputs, the files the reply names
      //    (with the .json sibling of each .oml) and, for assets, the catalog it rewrote.
      const seen = new Set();
      const same = agentPath => agentPath.replaceAll('\\', '/');
      const bring = async (agentPath, options = {}) => {
        if (seen.has(same(agentPath))) return;
        seen.add(same(agentPath));
        try { await mirror.pull(agentPath, options); }
        catch (error) { if (!ignorable(error)) throw error; }
      };
      // C14: after a successful merge its heavy evidence stays on the agent (SUCCESS_ONLY_EVIDENCE).
      const merged = command === 'merge' && reply?.ok === true;
      const skip = entry => merged && SUCCESS_ONLY_EVIDENCE.test(String(entry?.agentPath ?? entry ?? ''));
      if (manifest) for (const agentPath of await manifest.after({ skip })) seen.add(same(agentPath));
      for (const agentPath of outputs) await bring(agentPath);
      for (const { agentPath, sha256 } of named) {
        if (!path.extname(agentPath)) continue; // a folder: its files come with the manifest or not at all
        if (skip(agentPath)) continue;
        await bring(agentPath, sha256 ? { sha256 } : {});
        if (/\.oml$/i.test(agentPath)) await bring(agentPath + '.json');
      }
      if (command === 'assets') await bring('agent:odc/snapshots/modules.json');
      return parsed ? { ...rest, line: JSON.stringify(mapped) } : rest;
    },
  };
}
