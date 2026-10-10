// Conduction on the normal job entry (catalog M2, 2026-09-23). When a job run fails (`ssam job`, MCP `ssam_job` /
// `o11_job`), the answer carries, from the same discovery index the catalog composes (no second source): the exact
// contract of the failing op (`api --op`), the capabilities of the element it touched with that lane's statement for
// the operation and role, the negative job that proves the same refusal, and the exact continuation as an MCP call
// ({tool:'ssam_discover', arguments:{expand, lane}}, never a shell line). Nothing is executed, retried or changed; a
// job that ran is never re-run here. Without an index (CLI not built) it says so.
import fs from 'node:fs';
import path from 'node:path';
import { anvilRoot } from './workspace.mjs';
import { buildIndex, laneSources, contractNode, levelOf, operationsOf, query } from './discovery.mjs';
import { OWNERSHIP_FILE } from './catalog.mjs';

export const GUIDANCE_SCHEMA = 'ssam-job-guidance/1';
export const GUIDANCE_BUDGET = 6144;
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
// The kernel's refusal of one op, the same text on both lanes: `op #N (<verb> <name>): <Exception>: <message>`, or the
// preflight's I2 text form `op #N (<verb>) [CODE]: <message> Fix: <fix>`.
const OP_FAILURE = /op #(\d+) \(([a-z-]+)[^)]*\)(?: \[[A-Z0-9_]+\])?:\s*(?:([A-Za-z.]+Exception):\s*)?([\s\S]*)$/;
// Which operation of a shared capability a verb exercises (discovery OP_VERBS, inverted).
const OPERATION_OF_VERB = { create: 'create', spec: 'create', set: 'set', link: 'set', rename: 'rename', replace: 'replace', move: 'move', duplicate: 'duplicate', delete: 'delete', get: 'read', dump: 'read', find: 'read', usages: 'usages',
  rest: 'create', 'rest-expose': 'create', soap: 'create' };
// The contract pointer of a verb: the verb table, or the compact language's own schema for agent/spec/logic/screen/html and
// the integration ops (rest, rest-expose, soap: `api --op <op>`, their shapes, codes and rules).
const POINTER_OF_VERB = { agent: 'agent.shapes', spec: 'spec.shapes', logic: 'logic.action', screen: 'screen', html: 'html', rest: 'rest.shapes', 'rest-expose': 'rest-expose.shapes', soap: 'soap.shapes' };
const shortType = t => String(t ?? '').split('.').at(-1).replace(/^([A-Z])(?!I?[A-Z])/, 'I$1');
const typeWords = t => shortType(t).replace(/^I(?=[A-Z])/, '').replace(/([a-z])([A-Z])/g, '$1 $2');

// The MCP continuation of a discovery expansion (never a shell line): ssam_discover {expand, lane}.
const discoverCall = (expand, lane) => ({ tool: 'ssam_discover', arguments: { expand, lane } });

// ---- 1. what failed, read from the run as the runner answered it and from the `<out>.result.json` it writes. The
// job runner (job-runner.mjs) answers JSON: {ok, error?, resultFile?}; older answers are still read: the ODC JSON
// envelope under `result`, or the text lines of run_job.py under `output`.
export function failureOf(run) {
  const lines = run?.output ?? [];
  // The receipt: the runner's resultFile (run_job.py printed `result: <out>.result.json`); the ODC delivery passes
  // its kernel-result.json.
  const resultFile = run?.resultFile ?? lines.map(l => /^\s*result:\s*(.+\.result\.json)\s*$/.exec(l)?.[1]).find(Boolean) ?? null;
  let saved = null;
  if (resultFile) { try { saved = readJson(resultFile); } catch { /* the line is enough */ } }
  const error = run?.error ?? run?.result?.error ?? saved?.error ?? lines.map(l => /^== .*?: ok=False (.+)$/.exec(l)?.[1]).find(Boolean) ?? null;
  const failure = { stage: 'unknown', resultFile };
  if (error) {
    const m = OP_FAILURE.exec(error);
    Object.assign(failure, m ? { stage: 'kernel', op: Number(m[1]), verb: m[2], exception: m[3] ?? null, message: m[4].trim() } : { stage: 'runner', message: String(error).trim() });
  }
  const v = saved?.data?.validation;
  if (v && saved?.data?.accepted === false) {
    const pick = list => (list ?? []).map(x => ({ id: x.id, type: x.type ?? null, path: x.path ?? x.element ?? null, detail: x.detail ?? x.why ?? null }));
    failure.verify = { isValid: saved.data.isValid ?? null, expectedValid: saved.data.expectedValid ?? null, unexpected: pick(v.unexpected), missingExpected: pick(v.missingExpected), ambiguous: pick(v.ambiguous) };
    if (failure.stage === 'unknown') failure.stage = 'verify';
  }
  return failure;
}

// ---- 2. the op and the element it names: the op's own type, the `Type:Name` of its target, the `$alias` created by
// an earlier op, or the type the refusal message names ("IEntityAttribute 'Email' is used by ...").
export function elementOf(failure, ops = []) {
  const op = Number.isInteger(failure.op) ? ops[failure.op] ?? null : null;
  const fromMessage = /\b(I[A-Z][A-Za-z]+) '([^']+)'/.exec(failure.message ?? '');
  const aliasType = (alias, before) => { for (let i = before - 1; i >= 0; i--) { const o = ops[i]; if (o && (o.as === alias || o.as === '$' + alias)) return o.type ?? null; } return null; };
  const refType = (ref, before) => {
    if (typeof ref !== 'string') return null;
    const typed = /^([A-Za-z][A-Za-z0-9.]*):/.exec(ref); if (typed) return typed[1];
    const alias = /^\$([A-Za-z0-9_]+)$/.exec(ref); if (alias) return aliasType(alias[1], before);
    return null;
  };
  const type = fromMessage?.[1] ?? (op ? op.type ?? refType(op.target ?? op.from ?? op.parent, failure.op) : null);
  return { op, type: type ? shortType(type) : null, name: fromMessage?.[2] ?? op?.name ?? null };
}

// ---- 3. the catalog for that element: capabilities whose role has the type on this lane first (with their
// statement for the operation), then the ones whose route or context names it, then what the intent "<verb> <type>"
// selects in the same query the discovery answers with.
function capabilitiesFor(index, verb, type, lane, { kinds = [] } = {}) {
  const operation = OPERATION_OF_VERB[verb] ?? null;
  const out = []; const seen = new Set();
  const add = (c, why, role = null) => { if (!c || seen.has(c.id)) return; seen.add(c.id); out.push({ c, why, role }); };
  // A compact language op (logic, spec, screen, html) names no element type: the capabilities whose contract is that
  // language, the action kinds the op declares first (kind "server" -> logic.server-action).
  if (POINTER_OF_VERB[verb] && !type) {
    const own = index.capabilities.filter(c => (c.contract ?? []).some(p => p === verb || p.startsWith(verb + '.')));
    for (const k of kinds) for (const c of own) if (c.id.includes(k)) add(c, `its contract is the ${verb} language and it covers kind '${k}'`);
    for (const c of own) add(c, `its contract is the ${verb} language`);
  }
  if (type) {
    for (const c of index.capabilities) {
      const role = (c.elements ?? []).find(e => shortType(e.jobType ?? e.native) === type || shortType(e.native) === type);
      if (role) add(c, `role '${role.role}' is ${type} on ${lane}`, role.role);
    }
    const word = new RegExp(`\\b${type}\\b`);
    for (const c of index.capabilities) if (word.test(c.route?.operation ?? '') || (c.context?.kinds ?? []).includes(type.replace(/^I/, ''))) add(c, `its route or context names ${type}`);
  }
  if (out.length < 2 && (type || verb)) {
    const q = query(index, { intent: [verb, type ? typeWords(type) : ''].join(' '), limit: 3 });
    for (const m of q.matches.filter(x => x.via === 'match')) add(index.capabilities.find(c => c.id === m.id), `selected by the intent "${verb} ${type ? typeWords(type) : ''}"`.trim());
  }
  // A capability that states the operation for the role comes before one that only names the type.
  const stated = x => (x.role && operation && x.c.operations?.[operation]?.roles?.[x.role] ? 0 : 1);
  out.sort((a, b) => stated(a) - stated(b));
  return out.slice(0, 3).map(({ c, why, role }) => {
    const entry = { id: c.id, title: c.title, why, level: levelOf(index, c), expand: discoverCall(`${c.id}:contract+example${c.operations ? '+operations' : ''}`, lane) };
    if (role && operation && c.operations?.[operation]) {
      const stated = operationsOf(index, c, { focus: { roles: [role], ops: [operation] } })?.[operation];
      const r = stated?.roles?.[role];
      if (stated) entry.operation = { name: operation, route: stated.route, preconditions: stated.preconditions,
        ...(r ? { role, status: r.status, evidence: r.evidence, ...(r.alternative ? { alternative: r.alternative } : {}), ...(r.note ? { note: r.note } : {}), negative: (r.negative ?? []).map(n => n.job) } : { role, status: 'undetermined', evidence: 'not stated for this role' }) };
    }
    return entry;
  });
}

// A refusal is "proven" when a negative job of the lane expects the same text: its first fragment (the verb and the
// refusal) and at least one SPECIFIC fragment (one that fewer than three negative jobs share, so not "delete: refused"
// or the force sentence) must appear in the message.
function provenRefusals(index, message) {
  const text = String(message ?? '').toLowerCase(); if (!text) return [];
  const frequency = new Map();
  for (const n of index.negatives ?? []) for (const f of new Set(n.expectError.map(x => String(x).toLowerCase()))) frequency.set(f, (frequency.get(f) ?? 0) + 1);
  return (index.negatives ?? []).map(n => { const hits = n.expectError.map(f => String(f).toLowerCase()).filter(f => text.includes(f)); return { n, hits, specific: hits.filter(f => (frequency.get(f) ?? 0) < 3).length, lead: text.includes(String(n.expectError[0] ?? '').toLowerCase()) }; })
    .filter(x => x.lead && x.specific >= 1).sort((a, b) => b.specific - a.specific || b.hits.length - a.hits.length)
    .filter((x, _, all) => x.specific === all[0].specific).slice(0, 2)
    .map(x => ({ job: x.n.name, path: x.n.path, matched: x.hits.length + '/' + x.n.expectError.length, meaning: 'the same refusal is proven by this negative job of the lane suite' }));
}

// Verify messages the job did not declare: jobs of the lane that declare the same message id (how it is declared
// when the message is intended) and the limits that name it.
function verifyKnowledge(index, messages) {
  return messages.slice(0, 4).map(m => {
    const declaredIn = index.jobs.filter(j => (j.expectedMessages ?? []).some(e => e.id === m.id)).slice(0, 2).map(j => ({ job: j.name, declared: j.expectedMessages.find(e => e.id === m.id) }));
    const limits = (index.limits ?? []).filter(l => l.title?.includes(m.id)).slice(0, 1).map(l => ({ title: l.title, type: l.type, source: l.source }));
    return { ...m, ...(declaredIn.length ? { declaredIn } : {}), ...(limits.length ? { limits } : {}) };
  });
}

// No capability of this lane covers the element: said, with the front that owns the type in the catalog
// (catalog/ownership.json), instead of an empty answer. The contract above still holds.
function gapOf(lane, type, verb) {
  let owner = null;
  try {
    const ownership = readJson(OWNERSHIP_FILE);
    const key = type ? Object.keys(ownership.types).find(k => k.startsWith(lane + ':') && k.endsWith('.' + type)) : null;
    owner = key ? { type: key, front: ownership.types[key].owner, family: ownership.types[key].family } : null;
  } catch { /* no ownership file: the gap is still stated */ }
  return { note: `no capability of the ${lane} catalog covers ${type ?? 'the ' + verb + ' op'} yet: the contract of the op is the only guidance; nothing is inherited from the other lane`, ...(owner ? { owner } : {}) };
}

// ---- 4. the guidance, within a byte budget, reduced in a fixed order with each reduction declared. job is the job
// file (absolute or relative to the kernel root) or the job itself (object or array of ops); index may be given.
export async function jobGuidance({ lane, job, run, budgetBytes = GUIDANCE_BUDGET, sources = null, index = null } = {}) {
  const failure = failureOf(run);
  if (failure.stage === 'unknown' && !failure.verify) return null;
  if (!index) {
    try { index = (await buildIndex(lane, { sources: sources ?? laneSources(lane) })).index; }
    catch (error) { return { schemaVersion: GUIDANCE_SCHEMA, available: false, lane, failure, reason: 'discovery index unavailable: ' + String(error.message).split(/\r?\n/)[0] }; }
  }
  let ops = [];
  if (job && typeof job === 'object') ops = Array.isArray(job) ? job : job.ops ?? [];
  else {
    const jobFile = job ? (path.isAbsolute(job) ? job : path.resolve(anvilRoot, job)) : null;
    if (jobFile) { try { const parsed = readJson(jobFile); ops = (Array.isArray(parsed) ? parsed : parsed.ops) ?? []; } catch { /* a composite or unreadable job: the message still names the element */ } }
  }
  const element = elementOf(failure, ops);
  // A Verify message names its element by the kinds of its path ("... / CalculaCauda (AssignNode) / Assignment"):
  // the last kind is the element the message is about.
  if (!element.type && failure.verify) {
    const first = [...failure.verify.unexpected, ...failure.verify.missingExpected][0];
    const kinds = [...String(first?.path ?? '').matchAll(/\(([A-Za-z]+)\)/g)].map(m => m[1]);
    if (kinds.length) element.type = shortType('I' + kinds.at(-1));
  }
  const actionKinds = element.op?.op === 'logic' ? [...new Set((element.op.data?.actions ?? []).map(a => a.kind ?? 'server'))] : [];
  const out = { schemaVersion: GUIDANCE_SCHEMA, lane, source: { index: index.key, builtAt: index.builtAt, note: 'the discovery index of this lane (catalog composed with the fragments); read-only' }, failure: { stage: failure.stage, ...(Number.isInteger(failure.op) ? { op: failure.op, verb: failure.verb } : {}), ...(element.type ? { element: element.type + (element.name ? `:${element.name}` : '') } : {}), ...(failure.message ? { message: failure.message.length > 600 ? failure.message.slice(0, 597) + '...' : failure.message } : {}) } };
  if (failure.stage === 'kernel') {
    const pointer = POINTER_OF_VERB[failure.verb] ?? (contractNode(index, `verbs.verbs.${failure.verb}`) !== undefined ? `verbs.verbs.${failure.verb}` : null);
    if (pointer) { const node = contractNode(index, pointer); out.contract = { pointer, ...(node !== undefined && bytes(node) <= 2048 ? { slice: node } : { keys: node && typeof node === 'object' ? Object.keys(node) : null, expand: discoverCall(`contract:${pointer}`, lane) }) }; }
    const refusals = provenRefusals(index, failure.message); if (refusals.length) out.refusal = refusals;
  }
  if (failure.verify && element.type && !out.failure.element) out.failure.element = element.type;
  const caps = capabilitiesFor(index, failure.verb ?? null, element.type, lane, { kinds: actionKinds });
  if (caps.length) out.capabilities = caps;
  else if (element.type || failure.verb) out.catalogGap = gapOf(lane, element.type, failure.verb);
  if (failure.verify) {
    out.verify = { unexpected: verifyKnowledge(index, failure.verify.unexpected), missingExpected: failure.verify.missingExpected.slice(0, 4), expectedMessageContract: { pointer: 'verbs.expectedMessage', slice: contractNode(index, 'verbs.expectedMessage') ?? null } };
  }
  const next = [];
  if (failure.stage === 'kernel') next.push(`fix op #${failure.op} of the same job file against contract ${out.contract?.pointer ?? '(api --op verbs)'}: the job failed (ok=false) and nothing was saved; rerun the same file after the fix`);
  // primeira-certa A3: the refusal already carries every problem of every phase, each with its pointer, fix and the patch
  // of a certain fix: one correction covers them all.
  if (failure.stage === 'kernel') next.push('the refusal brings every problem of every phase at once (problems[]: phase, pointer, fix, patch when certain): correct all of them in one call, patch (the patches returned plus your fixes) + basedOn {job, sha256}, never one per round');
  if (out.refusal) next.push('the refusal is a rule proven by the negative job(s) above, not a defect: satisfy the precondition (capabilities[].operation.preconditions) or take the stated alternative; never add force to make it pass');
  else if (failure.stage === 'kernel' && /refused/.test(failure.message ?? '')) next.push('no negative job proves this refusal: read the message and the capability statement; it is not a proven rule of the catalog');
  if (out.verify?.unexpected?.length) next.push('fix each unexpected message (the kernel hints in the output name the likely cause) or, when it is intended, declare it in expectedMessages with id, element (path suffix) and why');
  if (out.verify?.missingExpected?.length) next.push('an expectedMessages entry matched nothing: remove it or correct its element suffix');
  out.next = next;
  // The exact next call: the contract, a proven example and the operations of the first capability.
  if (caps[0]) out.continuation = { ...caps[0].expand, why: `contract, proven example${caps[0].operation ? ' and operations' : ''} of ${caps[0].id}, the capability of the failing element` };
  return fit(out, budgetBytes);
}

function fit(out, budgetBytes) {
  const reduced = [];
  const steps = [
    () => { for (const c of out.capabilities ?? []) if (c.operation?.preconditions?.length > 2) { c.operation.preconditions = c.operation.preconditions.slice(0, 2); reduced.push('capabilities[].operation.preconditions'); } },
    () => { if (out.verify) for (const m of out.verify.unexpected) { if (m.declaredIn) { m.declaredIn = m.declaredIn.slice(0, 1); reduced.push('verify.unexpected[].declaredIn'); } } },
    () => { if (out.contract?.slice && bytes(out.contract.slice) > 1024) { out.contract = { pointer: out.contract.pointer, keys: Object.keys(out.contract.slice), expand: discoverCall(`contract:${out.contract.pointer}`, out.lane) }; reduced.push('contract'); } },
    () => { if ((out.capabilities ?? []).length > 1) { out.capabilities = out.capabilities.slice(0, 1); reduced.push('capabilities'); } },
    () => { if (out.verify?.expectedMessageContract?.slice) { out.verify.expectedMessageContract = { pointer: 'verbs.expectedMessage', expand: discoverCall('contract:verbs.expectedMessage', out.lane) }; reduced.push('verify.expectedMessageContract'); } },
  ];
  for (const step of steps) { if (bytes(out) <= budgetBytes) break; step(); }
  out.size = { bytes: 0, budgetBytes, ...(reduced.length ? { reduced: [...new Set(reduced)] } : {}) };
  out.size.bytes = bytes(out);
  return out;
}

// The job file among `ssam job` arguments: the first positional that is not the value of an option (lanes.mjs
// jobRequest, as run_job.py: --base, --out, --producer, --capture-producer, --lane take a value; --quiet does not).
export function jobArgument(args = []) {
  const valued = new Set(['--base', '--out', '--producer', '--capture-producer', '--lane']);
  for (let i = 0; i < args.length; i++) { if (valued.has(args[i])) { i++; continue; } if (!String(args[i]).startsWith('-')) return args[i]; }
  return null;
}

// The job entry: run the lane's job as before and, only when it failed, attach the guidance. Errors of the guidance
// never change the job's own answer.
export async function withJobGuidance(laneName, job, result) {
  if (result?.ok) return result;
  try { const discovery = await jobGuidance({ lane: laneName, job, run: result }); return discovery ? { ...result, discovery } : result; }
  catch (error) { return { ...result, discovery: { schemaVersion: GUIDANCE_SCHEMA, available: false, reason: 'guidance failed: ' + error.message } }; }
}
