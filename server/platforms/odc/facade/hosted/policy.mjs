// The hosted gate (docs/FASE2-AGENTE.md 5, 6.3, 6.4, 7 and 8): every tool of a hosted session passes here before its
// handler. In this order: unavailable tools, a lane outside the token, the agent (connected, credential, Studio and
// package versions), the customer's O11 connection and the workspace quota; then each path argument of tools.json is
// resolved inside the visible area of the customer's workspace (ws:<rel>, agent:<rel>, relative or absolute), an
// ssam_job {lane:"odc"} without base gets the neutral fixture as base (docs/O11-BRIDGE-FINA.md 7.2), the handler runs
// inside run(context, fn), and the answer loses the evidence of third-party jobs (evidence.mjs; an ssam_discover answer
// also loses the client names of the owner's catalogs, not those of the customer's own module: scrubDiscover) and is
// presented: workspace paths become ws:<rel>, other paths
// of this server become <server> (SERVER_MARK). Nothing here touches a Studio or the agent by itself, except bringing an
// agent:<rel> the LLM named (executor.pullFile).
// A-M1 + E2 (C:\t\multiver\minimo\PROPOSTA.md; studio-identity.mjs): a Studio the server does not serve is ONE refusal by
// direction (incompatible); every answer of a lane whose Studio is another build served with a warning carries
// studioWarning studioBuildDiffers, and a server-only tool (or a state report) that ran while the lane's Studio is not
// served carries studioWarning studioNotServed (studioNotice, withStudioWarning).
// servidor/fase4-24 (R1 of PLANO-24-PRODUCAO): every rule here reads the arguments the tool RUNS, not the ones sent. The
// input layer of the 24th release (tool-input.mjs) runs a renamed field under the tool's own name ({targt} runs as
// target); ssam.mjs hands its argsOf to the gate, which resolves the path pointers on argsOf(raw) ?? raw and gives the
// handler those arguments, normalized and resolved (normalizing them again changes nothing).
// D2 (G4 of the plan): a job with the prototype op is refused here in hosted mode, before any capture, by one switch
// (HOSTED_PROTOTYPE_OP).
// Item 1 of the 24th rehearsal: the paths INSIDE a job (base, composite parts, a reference's producer, an html file, the
// prototype's source and capture, the WSDL/OpenAPI documents) are confined too, in the inline job, its JSON text, a job
// file, every part and job:<name> it reaches and the job a patch produces over basedOn (job-paths.mjs confineJobs); the
// JSON text of a job is the job itself only on a job pointer, where it is parsed first (parseJobTexts).
// T2 of the CX15 review (C:\t\revisoes\cx15\REVISAO.md): deleting is off on a hosted server until the two-step
// destructive protocol is ported. A call that deletes or may delete (destructive.mjs hostedDestructive, on the arguments the
// tool runs and on the ones sent) is refused right after the unavailable tools, before the lane, the agent, any path, read
// or send, by one switch (HOSTED_DESTRUCTIVE): HOSTED_UNAVAILABLE, cause DESTRUCTIVE_HOSTED_OFF, no continuation. What a
// call names by file (the revokes of an o11_access apply manifest, hostedDestructiveFiles) is read once its path is
// resolved in the workspace, still before the handler and any kind of the agent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anvilRoot, workspaceRoot } from '../workspace.mjs';
import { scrubDiscover, scrubEvidence, thirdPartyJobs } from './evidence.mjs';
import { agentReadable, agentSegments, insideVisible } from './mirror.mjs';
import { agentPath, outsideWorkspaceRefusal, isAgentMachinePath } from '../agent-paths.mjs';
import { CODE_TOOL, JOB_TOOLS, JobTextError, PathRefusal, confineJobs, jobTextPointers, namesGenerator, namesPrototype, namesVerifiedPatch, outside, parseJobTexts } from './job-paths.mjs';
import { generatorApproval, offered } from '../generators.mjs';
import { holdPointers, pointersOf, scrubText } from '../exposure.mjs';
import { hostedCatalog } from './served.mjs';
import { causeOf, studioIdentity, studioRefusal, studioWarningOf } from '../studio-identity.mjs';
import { destructiveUnavailable, hostedDestructive, hostedDestructiveFiles } from './destructive.mjs';
import { withStudioScope } from './studio-scope.mjs';
import { withoutWordEchoes } from '../destructive-operations.mjs';

// The catalog is hosted/served.mjs's, the one switch the session texts read too (a8 review, M1).
export { TOOLS_FILE } from './served.mjs';
export const hostedTools = () => hostedCatalog();

const STUDIO = { odc: 'ODC Studio', o11: 'Service Studio' };
const LANED = new Set(['odc', 'o11']);
// The base of a hosted ssam_job {lane:"odc"} that names none: a blank CrossDevice app created offline (anvil-odc
// create-blank), never the base the job declares (the suite's own fixture is a customer capture).
export const NEUTRAL_ODC_BASE = path.join(anvilRoot, 'tests', 'fixtures', 'odc', 'blank-crossdevice.oml');
const doctor = why => ({ tool: 'ssam_doctor', arguments: {}, why });
// Round 2 of the a9 follow-ups (review a9-followups-line, B): every answer the gate gives by itself leaves before the hub's
// exit, so it passes here the hub's one rule of the owner's words (destructive-operations.mjs withoutWordEchoes, CX15 r5 N-1 /
// r6 M-2): a step {tool, arguments} that repeats the call (PATH_OUTSIDE_WORKSPACE at any pointer, AGENT_RECONNECTING, patch
// "verified") carries the words marker and askOwner, never the user's words; replayed as it is, it is WORDS_REQUIRED.
// Review a9-followups-2 (N1): every words field of that one rule, studio_authorize's text included; a corrected of the
// answer is masked by the rule of the tool called (tool).
const gateRefusal = (raw, tool) => { const value = withoutWordEchoes(raw, { tool }); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true }; };

// 6.3 rule 3: what looks like a path. In arguments that take a module OR a path, anything else is a module name.
export const looksLikePath = value => typeof value === 'string'
  && (/^(ws|agent):/.test(value) || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /\.(oml|json|jsonl|avsig)$/i.test(value));

// When a tool needs the agent for these arguments: 'always', 'never' or 'report' (answers without the agent).
// servidor/fase4-26 a8 (ssam_code): {when:"by", arg, values:{<value>: rule}, else: rule} takes the rule of the argument's
// value (an action); module-target takes {args:[...]}, the first of them the call gives (read: target, else module).
export function agentNeed(rule, args = {}) {
  if (rule === 'always' || rule === 'report') return rule;
  if (rule === 'never' || rule == null) return 'never';
  if (rule.when === 'by') {
    const chosen = args?.[rule.arg];
    const values = rule.values && typeof rule.values === 'object' ? rule.values : {};
    return agentNeed(typeof chosen === 'string' && Object.hasOwn(values, chosen) ? values[chosen] : rule.else ?? 'never', args);
  }
  const value = rule.when === 'module-target' && Array.isArray(rule.args) ? rule.args.map(name => args?.[name]).find(v => v !== undefined && v !== null) : args?.[rule.arg];
  const empty = v => v === undefined || v === null || v === '';
  let needs;
  switch (rule.when) {
    // servidor/fase4-23: ssam_map views search and uses take a list of targets; one module name in it needs the agent.
    case 'module-target': needs = (Array.isArray(value) ? value : [value]).some(v => typeof v === 'string' && v !== '' && !looksLikePath(v)); break;
    case 'present': needs = !empty(value); break;
    case 'non-empty': needs = Array.isArray(value) ? value.length > 0 : value && typeof value === 'object' ? Object.keys(value).length > 0 : !empty(value); break;
    case 'in': needs = rule.values.includes(value); break;
    case 'not-in': needs = !rule.values.includes(value); break;
    case 'absent-all': needs = rule.args.every(name => empty(args?.[name])); break;
    default: needs = true; // an unknown rule fails closed
  }
  return needs ? 'always' : 'never';
}
export const laneOf = (entry, args = {}) => String(entry?.lane ?? 'none').startsWith('arg:') ? (args?.lane ?? entry.lane.slice(4)) : entry?.lane ?? 'none';

// ---- the refusals of the gate, all {ok:false, code, error, continuation}
// C03 (servidor/fase4): an agent seen within RECONNECT_WINDOW_MS is reconnecting by itself (it does, with backoff up to
// 30 s): the answer is AGENT_RECONNECTING with retryAfterSeconds and the same call to repeat, never "start the agent". Only
// after RESTART_AFTER_MS without contact does the answer ask the user to look at the agent, and only an agent never seen
// (or gone longer than the window, or stopped cleanly) is AGENT_NOT_CONNECTED. The gate first waits up to
// RECONNECT_WAIT_MS for the Hello of a reconnecting agent.
export const RECONNECT_WINDOW_MS = 5 * 60000;
export const RESTART_AFTER_MS = 150000;
export const RECONNECT_WAIT_MS = 45000;
export const RETRY_AFTER_SECONDS = 15;
const sinceSeen = (info, now) => { const at = Date.parse(info?.lastSeenAt ?? ''); return info?.instance && Number.isFinite(at) ? Math.max(0, now - at) : Infinity; };
export const reconnecting = (info, now = Date.now()) => info?.credential !== false && sinceSeen(info, now) < RECONNECT_WINDOW_MS;
// The launcher the user runs, by the system the agent reported (fase4-26/a8-mac: agent.platform 'darwin' is a Mac;
// anything else, or an agent never seen, keeps the Windows words).
const launcherOf = info => (info?.agentPlatform === 'darwin'
  ? { status: 'agent/ssam-agent.sh status', start: '~/SSAM-Agent/agent/ssam-agent.sh start, see docs/AGENTE-MAC.md' }
  : { status: 'agent\\ssam-agent.ps1 status', start: 'agent\\ssam-agent.ps1 start, see docs/AGENTE-CLIENTE.md' });
export function agentNotConnected(info, { now = Date.now(), tool = null, args = null } = {}) {
  const launcher = launcherOf(info);
  if (reconnecting(info, now)) {
    const age = sinceSeen(info, now);
    const seconds = Math.round(age / 1000);
    const why = age < RESTART_AFTER_MS
      ? 'the SSAM agent reconnects by itself (it lost the connection ' + seconds + ' s ago): repeat the same call in ' + RETRY_AFTER_SECONDS + ' s; do not ask the user to restart anything'
      : 'the agent has been out of contact for ' + seconds + ' s: repeat in ' + RETRY_AFTER_SECONDS + ' s and, if it goes on, ask the user to check the agent window (' + launcher.status + ') and to start it only if it has stopped';
    return { ok: false, code: 'AGENT_RECONNECTING', retryAfterSeconds: RETRY_AFTER_SECONDS, lastSeenSecondsAgo: seconds,
      error: 'The SSAM agent of this account lost its connection ' + seconds + ' s ago and is reconnecting by itself; nothing ran on the user\'s machine.',
      continuation: tool ? { tool, arguments: args ?? {}, why } : doctor(why) };
  }
  const why = info?.credential === false
    ? 'The server owner must issue an agent credential for this token (ssam server-token agent-rotate); then the user starts the SSAM agent and calls this tool again.'
    : 'Ask the user to start the SSAM agent on their machine (' + launcher.start + '), then call this tool again. ssam_doctor shows when the agent is connected.';
  return { ok: false, code: 'AGENT_NOT_CONNECTED', error: 'The SSAM agent of this account is not connected, so nothing ran on the user\'s machine.', continuation: doctor(why) };
}
export const o11NotConnected = () => ({ ok: false, code: 'O11_NOT_CONNECTED',
  error: 'No Service Studio of this account is connected to SSAM, so nothing ran on the O11 lane. The server never falls back to another Studio.',
  continuation: { tool: 'ssam_connect', arguments: { lane: 'o11' }, why: 'Ask the user to open Service Studio (the version ssam_doctor shows), then connect it and call this tool again.' } });
// A-M1 (C:\t\multiver\minimo\PROPOSTA.md): the user's Studio as the hub judged it (compat.studio), or, from an answer
// without it, judged here by the same rule from the versions the link reports (studio-identity.mjs studioIdentity).
export function studioOf(lane, compat, info) {
  if (compat?.studio) return compat.studio;
  if (compat?.code !== 'STUDIO_VERSION_MISMATCH') return null;
  return studioIdentity(lane, info?.studios?.[lane]?.installed ?? null, info?.kernel ?? {});
}
// What still works when the lane's Studio is not served: the server-only tools of the hosted catalog for that lane.
export const serverOnlyTools = (lane, tools = hostedTools()) => Object.entries(tools)
  .filter(([, entry]) => entry?.class === 'server' && (entry.lane === lane || entry.lane === 'none' || String(entry.lane ?? '').startsWith('arg:')))
  .map(([name]) => name);
export function incompatible(lane, compat, info) {
  const serverKernel = info?.kernel?.[lane] ?? null;
  const agentStudio = info?.studios?.[lane]?.installed?.version ?? null;
  const studio = STUDIO[lane];
  // A-M1: a Studio this server does not serve (another version, or another build under studioBuildPolicy "refuse"): ONE
  // refusal with the direction (cause), both builds, what still works and "nothing ran", in English for the user (userMessage)
  // and for the model (error; B3 of round 3, owner rule of 2026-10-15: every SSAM text in English, no bilingual line). It
  // replaces the old continuation "install the Studio at the server's version", impossible for the ODC Studio.
  if (compat.code === 'STUDIO_VERSION_MISMATCH' && studioOf(lane, compat, info)?.ok) return null;
  const notServed = compat.code === 'STUDIO_VERSION_MISMATCH' ? studioRefusal(studioOf(lane, compat, info), { stillWorks: serverOnlyTools(lane) }) : null;
  if (notServed) return { ...notServed, serverKernel, agentStudio };
  if (compat.cause === 'KERNEL_VERSION_MISSING') return { ok: false, code: compat.code, cause: compat.cause, lane, serverKernel, agentStudio,
    error: compat.message ?? `This SSAM server's kernel.json does not name the ${studio} version of its image; the ${lane} lane is off and nothing ran.`,
    continuation: doctor('Shows the state of each lane. Ask the server owner to write the kernel.json of this server image.') };
  if (compat.code === 'AGENT_PACK_MISMATCH') return { ok: false, code: compat.code, lane, serverKernel, agentStudio,
    error: compat.message ?? `The agent package of this account does not match the ${studio} kernel of this server.`,
    continuation: doctor('Shows both versions. Ask the server owner for the current agent package.') };
  return { ok: false, code: compat.code ?? 'STUDIO_VERSION_MISMATCH', lane, serverKernel, agentStudio,
    error: compat.message ?? `The ${studio} lane of this account cannot run on this server (${compat.code}).`,
    continuation: doctor('Shows the state of each lane: the agent, the installed Studios and the server kernel.') };
}
// An entry may name the cause (a stable code, e.g. XIF_ENGINE_WINDOWS_ONLY) and its own continuation; otherwise the
// discover of the same request. a8 review (M1): a served entry switched off (its class set to unavailable) refuses with its
// off state ({cause, reason, continuation}: ssam_code's is the refusal it had before it was served); and the reason and the
// why pass the no-internals rule (exposure.mjs scrubText, the rule of SSAM's documentation prose): the gate answers before
// the rule of the answers, so a release, a line or a project document named in the catalog never reaches the licensee.
const unavailable = (name, entry, config) => {
  const shown = entry?.class === 'unavailable' && entry.off && typeof entry.off === 'object' ? { ...entry, ...entry.off } : entry;
  const continuation = shown?.continuation
    ?? { tool: 'ssam_discover', arguments: { intent: config?.title ?? name }, why: 'Lists the tools this server offers for the same request.' };
  const why = typeof continuation.why === 'string' ? scrubText(continuation.why) : continuation.why;
  return { ok: false, code: 'HOSTED_UNAVAILABLE', ...(shown?.cause ? { cause: shown.cause } : {}),
    error: `${name} is not available on a hosted SSAM server: ${scrubText(shown?.reason ?? 'it is not classified for hosted use.')}`,
    continuation: { ...continuation, ...(why !== undefined ? { why } : {}) } };
};
const laneDisabled = lane => ({ ok: false, code: 'HOSTED_LANE_DISABLED', lane,
  error: `This account has no ${lane} lane on this SSAM server; nothing ran.`, continuation: doctor('Shows the lanes of this account. Ask the server owner when the lane is needed.') });
// Multi-version design O.6.1 (kernel-image.mjs kernelPair): a lane this server image refused at start, because its
// kernel.json names another Studio version than the image carries, is off for every tool, the server-only ones included
// (ssam_job, ssam_map, ssam_discover, ssam_reference, o11_job, odc_search_operations...): the image's kernel never runs
// for it and no index of that lane is read or built. Only the state reports (agent "report": ssam_doctor, studio_doctor)
// still answer.
export function kernelLaneOff(lane, refused) {
  const studio = STUDIO[lane];
  const pinned = refused?.kernel ?? null;
  return { ok: false, code: 'KERNEL_UNAVAILABLE', cause: 'KERNEL_VERSION_MISSING', lane, serverKernel: null, image: refused?.image ?? null, pinned,
    error: `This SSAM server image carries the kernel for ${studio} ${refused?.image ?? '?'}, but its kernel.json names ${pinned ? studio + ' ' + pinned : 'no ' + studio + ' version'}: the ${lane} lane is off on this server, server-only tools included, and nothing ran.`,
    continuation: doctor('Shows the state of each lane. Ask the server owner to write the kernel.json of this server image.') };
}
const workspaceFull = () => ({ ok: false, code: 'WORKSPACE_FULL',
  error: 'The workspace of this account on the SSAM server is over its quota; nothing ran.', continuation: doctor('Shows the workspace usage. Ask the server owner to free space.') });
const pathRefused = (code, error) => ({ ok: false, code, error,
  continuation: doctor('Pass paths as SSAM tools return them (ws:odc/..., ws:o11/..., ws:inbox/...), or agent:inbox/<file> for a file the user put in the agent inbox folder.') });
// Item 1: a path inside the job (base, a part, a producer, an html file, a document...) outside the workspace, named by its
// job pointer (/job/ops/2/file; /job/jobs/0 > /ops/1/file inside a part file); the fix says where to put that file.
// (a9 follow-up, review vps-a9 L1: shown is the workspace's presenter, so a message that names a path of the workspace, the
// destination of a copy from the agent, reads ws:<rel>, never the real folder)
function jobPathRefused(error, agentRoot, shown = text => text) {
  const pointer = error.pointer ?? null;
  if (error.code !== 'PATH_OUTSIDE_WORKSPACE') return { ...pathRefused(error.code, shown(error.message)), ...(pointer ? { pointer } : {}), ...(error.fields ?? {}), ...(error.fix ? { fix: error.fix } : {}) };
  // a9: generic, as outsideWorkspaceRefusal: the path is never said back (the gate answers before any presenter).
  return { ok: false, ...outsideWorkspaceRefusal(error.value, { agentRoot }), pointer,
    error: 'The job names, at ' + pointer + ', a path outside your own workspace. Files a job names (base, composite parts, a reference producer, an html file, '
      + 'a WSDL/OpenAPI document, a prototype folder) must be ws:<rel> or agent:inbox/<file>; nothing was read there and nothing ran.' };
}
const jobTextInvalid = error => ({ ok: false, code: 'JOB_INVALID', pointer: error.pointer, error: error.message + '; nothing ran.',
  fix: 'send the job itself (an object, or its compact JSON text), or the path of a job file (ws:<rel>, agent:inbox/<file>)' });

// ---- R1: the arguments the tool runs
// argsOf (tool-input.mjs relaxTool, through ssam.mjs) gives the arguments the handler runs for the ones sent: a renamed,
// aliased or coerced field under the name the tool knows, or null when the layer refuses them (the handler then refuses
// too, with INPUT_INVALID, and runs nothing). Without argsOf, or when it fails, the arguments are the ones sent.
export function effectiveArgs(argsOf, raw) {
  if (typeof argsOf !== 'function') return raw;
  try {
    const value = argsOf(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : raw;
  } catch { return raw; }
}

// ---- D2: the prototype op (docs/PROTOTIPO-NATIVO.md, PLANO-24-PRODUCAO G4 and R2)
// THE switch. 'refuse' (24.0): a hosted job, delivery or proof that carries an op "prototype" is refused at the gate,
// before any capture: its capture runs the prototype's JavaScript on the server machine. 'allow': the gate lets it
// through (for a 24.x with the folder brought by agent:inbox and a capture pool per customer); its data.source and
// data.capture are then confined to the workspace like every other path of a job (item 1, job-paths.mjs).
export const HOSTED_PROTOTYPE_OP = 'refuse';
export const PROTOTYPE_TOOLS = JOB_TOOLS;
// namesPrototype (the structural scan of an inline job, a partial job or a patch) lives in job-paths.mjs with the walk that
// follows the job FILES a call reaches (the job, the job of basedOn, every composite part and job:<name> target, read
// strictly inside the customer's workspace; one it cannot read whole fails closed): confineJobs below.
export { namesPrototype };
export function prototypeUnavailable(name, lane) {
  return { ok: false, code: 'HOSTED_UNAVAILABLE', cause: 'PROTOTYPE_SOURCE_LOCAL', policy: 'HOSTED_PROTOTYPE_OP', tool: name, outcome: 'not-sent',
    error: 'The prototype import (op "prototype") is available only in local use for now: on a hosted server its source folder and the capture '
      + 'of its JavaScript would run on the server machine. Nothing ran.',
    continuation: { tool: 'ssam_discover', arguments: { intent: 'port an approved prototype screen 1:1 with the html op and its style in the theme', lane: lane === 'odc' ? 'odc' : 'o11' },
      why: 'Builds the same screens with the ops this server runs (html op plus its <style>), without the prototype op; or import the prototype with an SSAM installed on the user\'s own machine.' } };
}

// ---- servidor/fase4-25 (D2 of C:\t\vps-a5\PLANO.md, 3.2-E): the generator ops pending their blind test
// THE switch. 'refuse': a hosted job, delivery or proof that carries a generator op whose approval (generators.mjs
// GENERATOR_APPROVAL) is not 'approved' is refused at the gate, before the agent and any capture (an op called by name runs
// locally; hosted, nothing the owner has not approved runs, and rest-consume would read its samples from the server).
// 'allow': the gate lets them through. A generator the owner approves runs like any op.
export const HOSTED_GENERATOR_OPS = 'refuse';
export const GENERATOR_TOOLS = JOB_TOOLS;
export { namesGenerator };
// Whether the gate refuses this generator id ('unreadable': a part it could not read whole, fails closed).
export const pendingGenerator = id => id === 'unreadable' || (typeof id === 'string' && !offered(id));
export function generatorUnavailable(name, lane, generator) {
  const approval = generatorApproval(generator);
  return { ok: false, code: 'HOSTED_UNAVAILABLE', cause: 'GENERATOR_PENDING', policy: 'HOSTED_GENERATOR_OPS', tool: name, generator, outcome: 'not-sent',
    // a7 (no-internals list item 16): the state a licensee reads is the exposure rule's seal (not offered), and the text
    // names no internal reason; the approval itself stays in generators.mjs.
    ...(approval ? { state: approval.state === 'approved' ? 'approved' : 'not offered' } : {}),
    error: 'The generator op ' + JSON.stringify(generator) + ' is not offered on a hosted SSAM server yet, so this server never runs it. Nothing ran.',
    continuation: { tool: 'ssam_discover', arguments: { intent: generator === 'rest-consume' ? 'consume a REST API' : generator === 'gen-screen' ? 'create list and detail screens' : 'create the CRUD actions of an entity', lane: lane === 'odc' ? 'odc' : 'o11' },
      why: 'Lists the ops this server runs for the same request, written in the job by hand, without the pending generator.' } };
}

// ---- servidor/fase4-25 (finding A1 of C:\t\vps-a5\conf-rapida\RELATORIO.md): patch "verified"
// THE choice (refuse, not check): patch "verified" applies the operations a refusal kept in <job>.verified-patch.json beside
// the job of basedOn, a file the client can write (agent:inbox brings it to <ws>/inbox); the gate would have to read that file
// as the handler does and check the job it makes. Today it is refused at the gate, in the four job tools and in ssam_reference
// check-job: the same call with the JSON Patch operations themselves is checked like every patch (confineJobs).
export function verifiedPatchUnavailable(name, lane, args, at = '/patch') {
  const holder = at === '/query/patch' ? args?.query : args;
  const { patch: _patch, ...rest } = holder ?? {};
  const callArgs = at === '/query/patch' ? { ...args, query: rest } : rest;
  return { ok: false, code: 'HOSTED_UNAVAILABLE', cause: 'VERIFIED_PATCH_LOCAL', policy: 'HOSTED_VERIFIED_PATCH', tool: name, pointer: at, outcome: 'not-sent',
    error: 'patch "verified" is available only in local use for now: on a hosted server the gate does not read the verified patches kept beside '
      + 'the job of basedOn, so it cannot check the job they make. Nothing ran.',
    continuation: { tool: name, arguments: callArgs, add: { [at === '/query/patch' ? 'query.patch' : 'patch']: 'the JSON Patch operations themselves: the patch of each problem of that refusal (at most 50), or a partial job as job' },
      why: 'The same call with the explicit patch: the gate checks the job it makes over basedOn, and the handler applies it.' } };
}

// ---- T2 (CX15 review): deleting
// THE switch. 'refuse' (until the CX15 port): every hosted call that deletes, or may delete, something of the licensee's
// environment or tenant is refused at the gate. 'allow' only with the two-step protocol of CX15 ported to this line.
export const HOSTED_DESTRUCTIVE = 'refuse';
export { hostedDestructive };
// A classification that throws reads nothing of the call: destructive (fail closed).
const deletes = (name, args) => { try { return hostedDestructive(name, args); } catch { return true; } };

// ---- paths (6.3, 6.4)
// The concrete locations of a pointer in an argument object: '*' is every key of an object or item of an array.
function locations(node, segments) {
  if (!segments.length || node === null || typeof node !== 'object') return [];
  const [head, ...rest] = segments;
  const keys = head === '*' ? (Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node)) : Object.hasOwn(node, head) ? [head] : [];
  return keys.flatMap(key => rest.length ? locations(node[key], rest) : [{ parent: node, key, value: node[key] }]);
}
const segmentsOf = pointer => pointer.split('/').slice(1).map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'));
// Arguments that take a module or a path (one, or a list of them: ssam_map search/uses); studio_command passes only what
// looks like a path; ssam_reference /query is a file only for the job checks.
// servidor/fase4-23: ssam_reference check-job {basedOn, patch?, job?} (patch by name, partial job) reads the job of
// basedOn and a partial job given as a file: both are the customer's files. A partial job given as its JSON text is no
// path, and an inline job (no basedOn, no patch) is the job itself: its own paths are confined by confineJobs.
const isJsonText = value => /^\s*[[{]/.test(value);
const patchedQuery = args => args?.kind === 'check-job' && args?.query !== null && typeof args?.query === 'object' && !Array.isArray(args.query)
  && (args.query.basedOn !== undefined || args.query.patch !== undefined);
const pathOnlyWhen = (name, entry, pointer, args, value) => {
  // fase4-24: a hosted job travels inline, and the JSON text of a job ("{...}" or "[...]") is the job itself, but only on a
  // job pointer (jobTextPointers: /job, the check-job query): the gate parses it there first (parseJobTexts) and scans it
  // like an object (confineJobs). Anywhere else a value starting with "{" or "[" is a path like any other (it was exempt
  // in every pointer, so e.g. ssam_evidence {file:"[x]/../../<server file>"} reached the handler unresolved).
  if (isJsonText(value) && jobTextPointers(name, args).includes(pointer)) return false;
  if (entry.agent?.when === 'module-target' && (pointer === '/' + entry.agent.arg || pointer === '/' + entry.agent.arg + '/*')) return looksLikePath(value);
  // servidor/fase4-26 a8: an argument that takes a module OR a path, declared by the entry (ssam_code target and module).
  if (Array.isArray(entry.moduleOrPath) && entry.moduleOrPath.includes(pointer)) return looksLikePath(value);
  if (name === 'studio_command' && pointer === '/args/*') return looksLikePath(value);
  // servidor/fase4-26 a7: a producer binding is the path of a capture or OML, or the word "published" (the producer's published
  // signature, captured from the user's session), which is no path (o11_deliver, ssam_job/o11_job and, since the a7 merge,
  // studio_deliver).
  if (pointer === '/producers/*' && value === 'published') return false;
  if (name === 'ssam_reference' && pointer === '/query') return ['check-job', 'check-delivery'].includes(args?.kind);
  if (name === 'ssam_reference' && pointer === '/query/basedOn/job') return patchedQuery(args);
  if (name === 'ssam_reference' && pointer === '/query/job') return patchedQuery(args);
  return true;
};

async function resolveValue(value, role, lane, context, agentRoot = null) {
  const workspace = path.resolve(context.workspace);
  // C26: an absolute path of the user's machine under the agent's own folders (the root the agent reports in its Hello) is
  // that agent: path, e.g. C:\SSAM-Agent\inbox\job.json -> agent:inbox/job.json; on a Mac (a POSIX agent folder,
  // fase4-26/a8-mac) /Users/ana/SSAM-Agent/inbox/job.json -> agent:inbox/job.json.
  const mapped = isAgentMachinePath(value, agentRoot) ? agentPath(value, { agentRoot }) : null;
  if (mapped) value = mapped;
  if (value.startsWith('ws:') || value.startsWith('agent:')) {
    const agent = value.startsWith('agent:');
    const parsed = agentSegments('agent:' + value.slice(agent ? 6 : 3));
    // agent: names only the agent's own folders (the mirror would take any other agent path as a protocol violation).
    if (parsed.error || (agent && !agentReadable(parsed.segments))) throw outside(value);
    const abs = path.join(workspace, ...parsed.segments);
    if (!insideVisible(workspace, abs)) throw outside(value);
    // 6.3 rule 1: agent:inbox/<rel> is brought with file.get; agent:odc|o11/<rel> when the mirror lacks it.
    if (agent && role === 'in') {
      try { await context.executor.pullFile(value, { ifMissing: parsed.segments[0] !== 'inbox' }); }
      catch (error) {
        throw new PathRefusal(error?.code === 'FILE_NOT_FOUND' ? 'PATH_NOT_FOUND' : error?.code ?? 'AGENT_ERROR',
          'Could not bring ' + value + ' from the agent: ' + (error?.message ?? error));
      }
    }
    // C14: a ws: input the mirror left on the agent (the evidence of a successful merge) is brought when a tool names it.
    if (!agent && role === 'in' && parsed.segments[0] !== 'inbox' && agentReadable(parsed.segments) && !fs.existsSync(abs)
      && typeof context.executor?.pullFile === 'function' && context.agent?.connected?.() === true) {
      try { await context.executor.pullFile('agent:' + parsed.rel, { ifMissing: true }); } catch { /* the tool itself reports the missing file */ }
    }
    return abs;
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^[\\/]/.test(value)) {
    const abs = path.resolve(value);
    if (!insideVisible(workspace, abs)) throw outside(value);
    return abs;
  }
  // Relative: inputs under ws:<lane>/, outputs under ws:odc/lab/ (ODC) or ws:o11/ (O11). A tool without a lane takes
  // ws:<rel> as given (it must start with odc/, o11/ or inbox/).
  const base = role === 'out' ? (lane === 'o11' ? ['o11'] : ['odc', 'lab']) : LANED.has(lane) ? [lane] : [];
  const abs = path.resolve(workspace, ...base, value);
  if (!insideVisible(workspace, abs)) throw outside(value);
  return abs;
}

// a9 follow-up (review vps-a9 M2): whether the gate refuses a value as outside the workspace, by resolveValue's own rule,
// with nothing brought from the agent: the refusal names every such path of the same pointer at once.
function outsideValue(value, role, lane, context, agentRoot = null) {
  if (typeof value !== 'string' || value === '') return false;
  const workspace = path.resolve(context.workspace);
  const mapped = isAgentMachinePath(value, agentRoot) ? agentPath(value, { agentRoot }) : null;
  if (mapped) value = mapped;
  if (value.startsWith('ws:') || value.startsWith('agent:')) {
    const agent = value.startsWith('agent:');
    const parsed = agentSegments('agent:' + value.slice(agent ? 6 : 3));
    if (parsed.error || (agent && !agentReadable(parsed.segments))) return true;
    return !insideVisible(workspace, path.join(workspace, ...parsed.segments));
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^[\\/]/.test(value)) return !insideVisible(workspace, path.resolve(value));
  const base = role === 'out' ? (lane === 'o11' ? ['o11'] : ['odc', 'lab']) : LANED.has(lane) ? [lane] : [];
  return !insideVisible(workspace, path.resolve(workspace, ...base, value));
}

// The arguments with every path pointer of tools.json resolved to an absolute workspace path (a fresh copy).
export async function resolvePaths(name, entry, args, lane, context, { agentRoot = null } = {}) {
  const resolved = structuredClone(args ?? {});
  for (const role of ['in', 'out']) {
    for (const pointer of entry.paths?.[role] ?? []) {
      for (const { parent, key, value } of locations(resolved, segmentsOf(pointer))) {
        if (typeof value !== 'string' || value === '' || !pathOnlyWhen(name, entry, pointer, args, value)) continue;
        try { parent[key] = await resolveValue(value, role, lane, context, agentRoot); }
        catch (error) { if (error instanceof PathRefusal) error.pointer = pointer; throw error; }
      }
    }
  }
  return resolved;
}

// ---- the call deadline's inputs (servidor/fase4-26 a8: fix/delivery-no-deadline rounds 3c and 3d on the hosted line)
// The call deadline wraps this gate (ssam.mjs): it joins a live run-to-end call (a delivery, a creation) only on the same
// content and refuses the same arguments with other content (DELIVERY_STILL_RUNNING), on the print of what the call names
// (replay-store.mjs). It sees the arguments as sent (ws:, agent:, relative, a path of the agent's machine), which no print
// can read. replayInputs reads them as this gate reads them (the pointers of tools.json, the rules of resolveValue), but
// brings and writes nothing: ws: and a relative path are the workspace path the gate hands the tool; an agent: input (also a
// path of the agent's machine under its root, C26) that the gate brings is named by the sha256 the agent lists for that one
// file (executor.agentFileSha256: file.list of the file, hashed on the user's machine), so a call the deadline then joins or
// refuses never replaces the workspace copy a running delivery reads and never waits for a transfer. The strings of an
// inline job are read the same way. A value the gate would refuse, or an agent file the agent does not list, stays as it
// came: that call has no print (no join, no replay), and the gate answers it. A tool unavailable hosted is never read.
const AGENT_CONTENT = 'agent-content:sha256:';
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fileExists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
async function agentContent(context, agentPathValue) {
  try { const sha = await context.executor?.agentFileSha256?.(agentPathValue); return typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha) ? AGENT_CONTENT + sha : null; }
  catch { return null; }
}
async function inputValue(value, role, lane, context, agentRoot) {
  const workspace = path.resolve(context.workspace);
  const mapped = isAgentMachinePath(value, agentRoot) ? agentPath(value, { agentRoot }) : null;
  if (mapped) value = mapped;
  if (value.startsWith('ws:') || value.startsWith('agent:')) {
    const agent = value.startsWith('agent:');
    const parsed = agentSegments('agent:' + value.slice(agent ? 6 : 3));
    if (parsed.error || (agent && !agentReadable(parsed.segments))) return null;
    const abs = path.join(workspace, ...parsed.segments);
    if (!insideVisible(workspace, abs)) return null;
    if (role !== 'in') return abs;
    // What the tool will read: the agent's file when the gate brings it (agent:inbox always; agent:odc|o11 and a ws: input
    // of the mirror's folders when the workspace lacks it, C14), else the workspace copy.
    const brought = agent ? parsed.segments[0] === 'inbox' || !fileExists(abs)
      : parsed.segments[0] !== 'inbox' && agentReadable(parsed.segments) && !fileExists(abs) && context.agent?.connected?.() === true;
    return brought ? agentContent(context, 'agent:' + parsed.rel) : abs;
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^[\\/]/.test(value)) {
    const abs = path.resolve(value);
    return insideVisible(workspace, abs) ? abs : null;
  }
  const base = role === 'out' ? (lane === 'o11' ? ['o11'] : ['odc', 'lab']) : LANED.has(lane) ? [lane] : [];
  const abs = path.resolve(workspace, ...base, value);
  return insideVisible(workspace, abs) ? abs : null;
}
// The ws: and agent: strings inside an inline job (or the path of the agent's machine), read as inputs; a fresh copy.
async function jobInputs(value, lane, context, agentRoot, budget, depth = 0) {
  if (depth > 64 || budget.left <= 0) return value;
  if (typeof value === 'string') {
    budget.left--;
    if (value.length > 1024 || !(/^(?:ws|agent):/.test(value) || isAgentMachinePath(value, agentRoot) && agentPath(value, { agentRoot }))) return value;
    return (await inputValue(value, 'in', lane, context, agentRoot)) ?? value;
  }
  if (Array.isArray(value)) { const out = []; for (const item of value) out.push(await jobInputs(item, lane, context, agentRoot, budget, depth + 1)); return out; }
  if (isPlainObject(value)) { const out = {}; for (const [key, item] of Object.entries(value)) out[key] = await jobInputs(item, lane, context, agentRoot, budget, depth + 1); return out; }
  return value;
}
// The checks of the gate that come before the agent and any path, in their order: an unavailable tool, T2 deleting (on the
// arguments it runs and on the ones sent), an invalid job text, the prototype op, a pending generator, patch "verified" (the
// job tools' and ssam_code write's), a lane outside the token, a lane the image refused. -> {refusal} | {args, lane, need}
// (args: the job texts parsed). a8 phase 6: ONE function, which wrapHostedTool answers with and the call deadline's inputs
// read (refusedBeforePaths): a check the gate gains is never missing from the deadline. The ssam_code merge proved the copy
// of these checks fell behind (its prototype, generator and patch "verified" checks: the deadline listed the agent's files of
// a call the gate then refused).
export function refusalBeforeAgent(name, args, { entry, config = null, raw = args, hasArgs = true, lanes = [], kernelRefused = null,
  prototypeOp = HOSTED_PROTOTYPE_OP, generatorOps = HOSTED_GENERATOR_OPS, destructive = HOSTED_DESTRUCTIVE } = {}) {
  if (!entry || entry.class === 'unavailable') return { refusal: unavailable(name, entry, config) };
  // T2: a call that deletes, read on the arguments it runs and on the ones sent, before anything else of the call.
  if (destructive !== 'allow' && (deletes(name, args) || (hasArgs && deletes(name, raw)))) return { refusal: destructiveUnavailable(name) };
  // Item 1: the JSON text of a job is the job itself only on a job pointer; parsed here, every rule below (and the
  // handler) reads the object. A text there that looks like JSON and does not parse is refused: it is no path either.
  if (hasArgs) {
    try { args = parseJobTexts(name, args); }
    catch (error) { if (!(error instanceof JobTextError)) throw error; return { refusal: jobTextInvalid(error) }; }
  }
  const lane = laneOf(entry, args);
  // D2: an inline job, partial job or patch with the prototype op, before the agent, the lane checks and any capture.
  // servidor/fase4-26 a8: ssam_code makes the job a check runs and a write delivers (job-paths.mjs confineJobs): the same
  // two switches as the job tools.
  if (prototypeOp !== 'allow' && (PROTOTYPE_TOOLS.includes(name) || name === CODE_TOOL) && hasArgs && namesPrototype(args)) return { refusal: prototypeUnavailable(name, lane) };
  // servidor/fase4-25: a pending generator op in the inline job, partial job or patch, at the same place.
  if (generatorOps !== 'allow' && (GENERATOR_TOOLS.includes(name) || name === CODE_TOOL) && hasArgs) {
    const generator = namesGenerator(args, pendingGenerator);
    if (generator) return { refusal: generatorUnavailable(name, lane, generator) };
  }
  // servidor/fase4-25 (finding A1): patch "verified" reads its operations from a file the gate never reads; refused here,
  // before the agent, any file brought from it and any capture (the explicit patch is checked: confineJobs).
  if (hasArgs) { const at = namesVerifiedPatch(name, args); if (at) return { refusal: verifiedPatchUnavailable(name, lane, args, at) }; }
  // a8: ssam_code write {patch:"verified", basedOn} hands that patch to the delivery; refused here, with its own continuation.
  if (hasArgs && name === CODE_TOOL && typeof args.patch === 'string' && args.patch.trim().toLowerCase() === 'verified') return { refusal: verifiedPatchUnavailable(name, lane, args, '/patch') };
  if (LANED.has(lane) && !lanes.includes(lane)) return { refusal: laneDisabled(lane) };
  const need = agentNeed(entry.agent, args);
  // O.6.1: a lane the image refused at start is off for every tool but the state reports, before the agent and any path.
  if (LANED.has(lane) && need !== 'report' && kernelRefused?.[lane]) return { refusal: kernelLaneOff(lane, kernelRefused[lane]) };
  return { args, lane, need };
}
// Whether the gate refuses this call before the agent and any path (refusalBeforeAgent). The deadline's inputs never ask the
// agent anything for such a call: the gate answers it, nothing pulled and no kind (hosted-destructive NEW-1). A call whose
// checks throw is read as refused too (no print: the gate answers it).
export function refusedBeforePaths(name, args, { tools = hostedTools(), lanes = [], kernelRefused = null, raw = args, prototypeOp = HOSTED_PROTOTYPE_OP,
  generatorOps = HOSTED_GENERATOR_OPS, destructive = HOSTED_DESTRUCTIVE } = {}) {
  try { return Boolean(refusalBeforeAgent(name, args, { entry: tools?.[name], raw, lanes, kernelRefused, prototypeOp, generatorOps, destructive }).refusal); }
  catch { return true; }
}
export async function replayInputs(name, args, context, { agentRoot = null, tools = hostedTools(), lanes = context?.lanes ?? [], kernelRefused = null, raw = args } = {}) {
  const entry = tools?.[name];
  if (!entry || !isPlainObject(args) || !context?.workspace || refusedBeforePaths(name, args, { tools, lanes, kernelRefused, raw })) return args;
  let value;
  try { value = structuredClone(parseJobTexts(name, args)); } catch { return args; }
  const lane = laneOf(entry, value);
  for (const role of ['in', 'out']) {
    for (const pointer of entry.paths?.[role] ?? []) {
      for (const { parent, key, value: given } of locations(value, segmentsOf(pointer))) {
        if (typeof given !== 'string' || given === '' || !pathOnlyWhen(name, entry, pointer, args, given)) continue;
        const read = await inputValue(given, role, lane, context, agentRoot);
        if (read !== null) parent[key] = read;
      }
    }
  }
  const budget = { left: 20000 };
  for (const pointer of jobTextPointers(name, value)) {
    for (const { parent, key, value: job } of locations(value, segmentsOf(pointer))) {
      if (job !== null && typeof job === 'object') parent[key] = await jobInputs(job, lane, context, agentRoot, budget);
    }
  }
  return value;
}

// ---- presentation (6.3 rule 4)
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '[\\\\/]+';
// A folder whose absolute path starts with a separator (POSIX, and Windows UNC) keeps that separator in its pattern, and
// its match must start a path, not continue another one. Without both, on Linux (server/Dockerfile) /data/server/... lost
// its leading "/": the workspace came out as "/ws:odc/..." (a path no tool takes back) and a short server root such as
// HOME=/tmp turned any ".../tmp/..." into "<server>". A Windows drive path (C:\...) keeps its pattern as before.
const PATH_START = `(?<![^\\s"'<>|*?,;:=()[\\]{}])`;
const prefixSource = (dir, api = path) => {
  const abs = api.resolve(dir);
  const parts = abs.split(/[\\/]+/).filter(Boolean).map(escapeRe);
  return /^[\\/]/.test(abs) ? PATH_START + SEP + parts.join(SEP) : parts.join(SEP);
};
// a7 phase 4 (review no-internals-7, item 6, the same rule as exposure.mjs POSIX_PATH): a root ends its segment (END: a
// separator, a quote, a closing mark, a colon, or a period that ends a sentence; never a letter, so /applicationKey or /apps
// is no path under /app), and a path at the end of a sentence leaves its period (TAIL never ends with one).
const TAIL = `(?:${SEP}[^\\\\/\\s"'<>|*?]+)*(?<!\\.)`;
const END = `(?=$|[\\\\/\\s"'<>|*?,;:)\\]}]|\\.(?:\\s|$))`;

// The server's own data roots that may live outside the checkout and the profile (servidor/fase4-22): the module index
// store, where the 22nd release also keeps the module digest (ssam_map index.file and store.file), and the readers' copy.
// a7 phase 3 (review vps-a7-2 B4, the family "a folder of the server's layout"): every folder the server's environment
// names, so the layout of the Linux image never leaves in any field (docker/ssam-server/Dockerfile and the SSAM-MCP image:
// /data/server with the customers' workspaces, tokens and logs, /data/friction, /data/odc-features, /data/cache, the Studio
// folders /studio/o11 and /studio/odc). The presenter resolves each one with its own path flavor.
export const SERVER_ROOT_VARIABLES = Object.freeze(['SSAM_MODULE_INDEX_ROOT', 'SSAM_READER_CACHE_ROOT', 'SSAM_SERVER_DIR', 'SSAM_FRICTION_DIR',
  'ANVIL_STUDIO_DIR', 'ANVIL_ODC_STUDIO_DIR', 'ANVIL_ODC_FEATURES_DIR']);
export const serverDataRoots = (env = process.env) => SERVER_ROOT_VARIABLES.map(name => env[name])
  .filter(root => typeof root === 'string' && root.trim()).map(root => root.trim());
// Every root of this server: the code (workspaceRoot: /app in the image), the home and the temp folder of the process (HOME
// and os.tmpdir(): /tmp in the image) and the folders of its environment. The customer's workspace, which lives under
// SSAM_SERVER_DIR, is matched first (presenter) and stays ws:<rel>.
export const serverRoots = ({ env = process.env, code = workspaceRoot, home = os.homedir(), tmp = os.tmpdir() } = {}) =>
  [...new Set([code, home, tmp, ...serverDataRoots(env)].filter(root => typeof root === 'string' && root.trim()))];
// The marker of a value of the server a hosted answer withholds (owner rule of 15/10: every text SSAM emits is English; the
// exposure rule writes the same marker, exposure.mjs MARK). Before phase 3 of the a7 line it was a Portuguese word: nothing reads
// either marker as input (tests and documents only).
export const SERVER_MARK = '<server>';
// pathApi: the path flavor of this server (path.posix in a test of the Linux image's paths).
export function presenter({ workspace, serverRoots: given = serverRoots(), pathApi = path }) {
  const ws = pathApi.resolve(workspace);
  const wsSource = prefixSource(ws, pathApi);
  const roots = [...new Set(given.filter(Boolean).map(r => pathApi.resolve(r)))].sort((a, b) => b.length - a.length);
  const rootSources = roots.map(root => prefixSource(root, pathApi));
  const asWs = rest => {
    const segments = rest.split(/[\\/]+/).filter(Boolean);
    return segments.length && ['odc', 'o11', 'inbox'].includes(segments[0].toLowerCase()) ? 'ws:' + segments.join('/') : SERVER_MARK;
  };
  const wholeWs = new RegExp(`^${wsSource}${END}(.*)$`, 'is');
  const wholeServer = rootSources.map(source => new RegExp(`^${source}${END}`, 'i'));
  const embeddedWs = new RegExp(`${wsSource}${END}(${TAIL})`, 'gi');
  const embeddedServer = rootSources.map(source => new RegExp(`${source}${END}${TAIL}`, 'gi'));
  // a7 phase 4 (review no-internals-7, item 6): a JSON pointer the answer itself names in violations[].path is the name of
  // an argument, even when it is exactly a root of this server (/app and /tmp in the Linux image): as a whole value it stays,
  // and inside a text it is held aside while the paths are withheld (exposure.mjs holdPointers, the rule's own).
  const string = (text, pointers = []) => {
    if (!Array.isArray(pointers)) pointers = [];
    if (pointers.includes(text)) return text;
    const held = holdPointers(text, pointers);
    const whole = wholeWs.exec(held.text);
    if (whole) return held.restore(asWs(whole[1]));
    if (wholeServer.some(re => re.test(held.text))) return SERVER_MARK;
    let out = held.text.replace(embeddedWs, (match, rest) => asWs(rest));
    for (const re of embeddedServer) out = out.replace(re, SERVER_MARK);
    return held.restore(out);
  };
  // The pointers an object names in violations[] reach every text below it (as in the rule, exposure.mjs scrub).
  const value = (node, pointers = []) => {
    if (!Array.isArray(pointers)) pointers = [];
    if (typeof node === 'string') return string(node, pointers);
    if (Array.isArray(node)) return node.map(item => value(item, pointers));
    if (!node || typeof node !== 'object') return node;
    const named = pointersOf(node);
    const below = named.length ? [...pointers, ...named] : pointers;
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, value(v, below)]));
  };
  const result = answer => {
    if (!answer || typeof answer !== 'object') return answer;
    const out = { ...answer };
    const original = answer.structuredContent;
    if (original !== undefined) out.structuredContent = value(original);
    if (Array.isArray(answer.content)) out.content = answer.content.map(item => {
      if (item?.type !== 'text' || typeof item.text !== 'string') return item;
      if (original !== undefined && item.text === JSON.stringify(original)) return { ...item, text: JSON.stringify(out.structuredContent) };
      let parsed;
      try { parsed = JSON.parse(item.text); } catch { return { ...item, text: string(item.text) }; }
      return { ...item, text: JSON.stringify(value(parsed)) };
    });
    return out;
  };
  return { string, value, result };
}

// ---- E2 and A-M1: the warning about the lane's Studio in the answer of a tool that ran
// studioBuildDiffers: the server serves another build of the user's Studio (kernel.json studioBuildPolicy "warn"), in every
// answer of the lane. studioNotServed: a server-only tool or a state report ran with the server's kernel while the user's
// Studio is not served (the Studio tools are refused). Both from studio-identity.mjs studioWarningOf.
// Round 2 of the review (C:\t\revisoes\studio-build-id\REVISAO.md):
//   - A2: a tool of the lane "none" touches the lanes HIDDEN_LANES names (ssam_task: its tasks are the O11 work folder,
//     and close runs the O11 kernel against the Service Studio), or every lane of the token (ssam_connect without lane
//     attaches them all; ssam_doctor reports them all). Each touched lane is judged; the warnings of all of them come back
//     (studioWarning the first, studioWarnings all when more than one).
//   - A1: a lane's identity is the worse of the hub's (the Studio installed on disk) and the one of the process that runs:
//     the connected Service Studio record (o11.connect/o11.selected studioVersion) for O11; for ODC the AgentExecutor
//     judges each call's pid and records it in the call's scope (studio-scope.mjs).
const HIDDEN_LANES = Object.freeze({ ssam_task: Object.freeze(['o11']) });
export const touchedLanes = (name, lane, lanes = []) => (LANED.has(lane) ? [lane] : (HIDDEN_LANES[name] ?? ['odc', 'o11']).filter(l => lanes.includes(l)));
const rank = identity => (!identity ? 0 : causeOf(identity) ? 2 : identity.warn ? 1 : 0);
const worse = (hub, running) => (running && rank(running) >= rank(hub) ? running : hub ?? running);
// ssam_connect makes the connection, so before its handler the record of the previous one is not judged for it (the hub's
// verdict is, and the executor judges the process it attaches). B1 (round 3): after its handler (after: true) the record
// is the connection it made, judged like the record of any other O11 call.
function laneStudio(name, lane, info, context, { after = false } = {}) {
  const compat = info?.compatible?.[lane];
  const hub = compat ? studioOf(lane, compat, info) : null;
  let record = null;
  if (lane === 'o11' && (after || name !== 'ssam_connect')) { try { record = context?.executor?.o11Connection?.() ?? null; } catch { record = null; } }
  return worse(hub, record?.studioVersion ? studioIdentity('o11', { version: record.studioVersion }, info?.kernel ?? {}) : null);
}
const refusalBody = (identity, info) => {
  const body = studioRefusal(identity, { stillWorks: serverOnlyTools(identity?.lane) });
  return body ? { ...body, serverKernel: info?.kernel?.[identity.lane] ?? null, agentStudio: info?.studios?.[identity.lane]?.installed?.version ?? null } : null;
};
const oneRefusal = bodies => (bodies.length > 1 ? { ...bodies[0], lanes: bodies } : bodies[0]);
// Before the handler of a tool that needs the agent: the refusals of the lanes it touches (each named once in the log).
// ssam_connect without lane runs with the lanes that are served and says which it skipped (studioSkipped); with none
// served it is one refusal with every lane (lanes). -> {refusal} | {args, skipped} | {}.
export function studioGate({ name, lane, args, info, context, lanes, link }) {
  const touched = touchedLanes(name, lane, lanes);
  const bodies = [];
  for (const l of touched) {
    const identity = laneStudio(name, l, info, context);
    const body = refusalBody(identity, info);
    if (!body) continue;
    try { link?.studioUnserved?.(l, identity, body.cause); } catch { /* the refusal stands without its log line */ }
    bodies.push(body);
  }
  if (!bodies.length) return {};
  const served = touched.filter(l => !bodies.some(b => b.lane === l));
  if (name === 'ssam_connect' && !LANED.has(lane) && served.length === 1) return { args: { ...args, lane: served[0] }, skipped: bodies };
  return { refusal: oneRefusal(bodies) };
}
// After the handler: the warnings of the lanes the tool touched (the process's verdict wins for its lane), the lanes
// skipped before it, and the Studio calls the executor refused during it. A tool that needs the agent (need always) whose
// every Studio call was refused (none went out) answers with that refusal itself; otherwise (a state report, or a call
// that sent other Studio calls) the refused ones come back in studioSkipped.
export function studioVerdict({ name, lane, need = 'always', info, context, lanes, scope, skipped = [], link = null }) {
  const byLane = new Map();
  // B1: the Service Studio ssam_connect has just connected, when the server does not serve it (the executor refuses the
  // attach itself; this is the record of a bridge the call found already loaded), comes back as the lane's refusal.
  const connected = [];
  for (const l of touchedLanes(name, lane, lanes)) {
    if (skipped.some(b => b.lane === l)) continue;
    const identity = laneStudio(name, l, info, context, { after: true });
    if (name === 'ssam_connect' && causeOf(identity)) {
      connected.push(identity);
      try { link?.studioUnserved?.(l, identity, causeOf(identity)); } catch { /* the refusal stands without its log line */ }
      continue;
    }
    const warning = studioWarningOf(identity);
    if (warning) byLane.set(l, warning);
  }
  for (const identity of scope?.warned ?? []) byLane.set(identity.lane, studioWarningOf(identity));
  const refusedNow = [...new Map([...(scope?.refused ?? []), ...connected].map(identity => [identity.lane + ':' + identity.installed, identity])).values()]
    .map(identity => refusalBody(identity, info)).filter(Boolean);
  for (const body of refusedNow) byLane.delete(body.lane);
  if (need === 'always' && refusedNow.length && !scope.sent && !skipped.length) return { refusal: oneRefusal(refusedNow) };
  const warnings = [...byLane.values()];
  const all = [...skipped, ...refusedNow];
  return { fields: { ...(warnings.length ? { studioWarning: warnings[0] } : {}), ...(warnings.length > 1 ? { studioWarnings: warnings } : {}),
    ...(all.length ? { studioSkipped: all } : {}) } };
}
// Kept for its callers: the lane's warning of the hub alone.
export function studioNotice(lane, info) {
  if (!LANED.has(lane)) return null;
  const compat = info?.compatible?.[lane];
  return compat ? studioWarningOf(studioOf(lane, compat, info)) : null;
}
// The answer with the Studio fields (studioWarning, studioWarnings, studioSkipped): in structuredContent and in the text
// that mirrors it; an answer without structured content (or whose text is another rendering) gets one more text item. The
// tool's own fields, warnings included, stay.
export function withStudioFields(answer, fields) {
  if (!fields || !Object.keys(fields).length || !answer || typeof answer !== 'object') return answer;
  const original = answer.structuredContent;
  const content = Array.isArray(answer.content) ? answer.content : [];
  if (original && typeof original === 'object' && !Array.isArray(original)) {
    const structuredContent = { ...original, ...fields };
    const mirror = JSON.stringify(original);
    let mirrored = false;
    const items = content.map(item => {
      if (item?.type !== 'text' || item.text !== mirror) return item;
      mirrored = true;
      return { ...item, text: JSON.stringify(structuredContent) };
    });
    return { ...answer, structuredContent, content: mirrored ? items : [...items, { type: 'text', text: JSON.stringify(fields) }] };
  }
  return { ...answer, content: [...content, { type: 'text', text: JSON.stringify(fields) }] };
}
export const withStudioWarning = (answer, warning) => withStudioFields(answer, warning ? { studioWarning: warning } : null);

// ---- the gate
// wrapHostedTool(name, config, handler, {context, link, lanes, run, argsOf}) -> the handler to register. run(context, fn)
// puts the hosted context around the handler (runWithExecutor in ssam.mjs; tests pass (ctx, fn) => fn()). argsOf: the
// input layer's arguments for the ones sent (R1); every rule below and the handler read them. prototypeOp: the D2 switch
// (HOSTED_PROTOTYPE_OP by default; tests pass the other value). kernelRefused: the lanes the server image refused at start
// (ssam.mjs startupKernel), each off for every tool but the state reports (kernelLaneOff). destructive: the T2 switch
// (HOSTED_DESTRUCTIVE by default; tests pass the other value).
export function wrapHostedTool(name, config, handler, { context, link = context?.agent, lanes = context?.lanes ?? [], run = (ctx, fn) => fn(),
  tools = hostedTools(), serverRoots, waitMs = RECONNECT_WAIT_MS, argsOf = null, prototypeOp = HOSTED_PROTOTYPE_OP, generatorOps = HOSTED_GENERATOR_OPS,
  kernelRefused = null, destructive = HOSTED_DESTRUCTIVE, presentation = null } = {}) {
  const entry = tools[name];
  // presentation (a7 phase 4, tests): {workspace, serverRoots, pathApi} of the presenter only (the Linux image's layout with
  // path.posix on another machine); the call itself keeps the context's workspace.
  const present = presenter({ workspace: context.workspace, ...(serverRoots ? { serverRoots } : {}), ...(presentation ?? {}) });
  // The switches the walk of the job files reads after the paths (confineJobs, the files T2 reads); the checks before the
  // agent read the same switches in refusalBeforeAgent.
  const refusesPrototype = prototypeOp !== 'allow' && (PROTOTYPE_TOOLS.includes(name) || name === CODE_TOOL);
  const refusesGenerators = generatorOps !== 'allow' && (GENERATOR_TOOLS.includes(name) || name === CODE_TOOL);
  const refusesDestructive = destructive !== 'allow';
  const refusal = raw => gateRefusal(raw, name);
  return async (...params) => {
    const hasArgs = config?.inputSchema != null && params.length > 1;
    // R1: the arguments the tool runs (a field the input layer renames is confined under its own name).
    let args = hasArgs ? effectiveArgs(argsOf, params[0] ?? {}) : {};
    // a8 phase 6: the checks before the agent and any path are ONE function (refusalBeforeAgent), the one the call deadline's
    // inputs read too (refusedBeforePaths).
    const early = refusalBeforeAgent(name, args, { entry, config, raw: params[0], hasArgs, lanes, kernelRefused, prototypeOp, generatorOps, destructive });
    if (early.refusal) return refusal(early.refusal);
    args = early.args;
    const { lane, need } = early;
    let info = null, skipped = [];
    try { info = link?.info?.() ?? null; } catch { info = null; }
    if (need === 'always') {
      let connected = false;
      try { connected = link?.connected?.() === true; } catch { connected = false; }
      // C03: a recently seen agent is reconnecting by itself; the call waits for its Hello before any refusal.
      if (!connected && reconnecting(info) && typeof link?.waitConnected === 'function') {
        connected = await link.waitConnected(waitMs).catch(() => false) === true;
        try { info = link.info?.() ?? info; } catch { /* the info read before */ }
      }
      if (!connected || info?.credential === false) return refusal(agentNotConnected(info, { tool: name, args }));
      const compat = LANED.has(lane) ? info?.compatible?.[lane] : null;
      if (compat && compat.ok === false) {
        const problem = incompatible(lane, compat, info);
        if (problem) return refusal(problem);
      }
      if (lane === 'o11' && name !== 'ssam_connect' && !context.executor?.o11Connection?.()) return refusal(o11NotConnected());
      // A1 + A2 (review round 2): the process each touched lane runs (O11 record) and the lanes a tool without a lane touches.
      const studio = studioGate({ name, lane, args, info, context, lanes, link });
      if (studio.refusal) return refusal(studio.refusal);
      if (studio.args) ({ args, skipped } = studio);
    }
    // (a8: an entry that writes in the workspace by itself, writesWorkspace: ssam_code's check jobs and plans)
    if ((need === 'always' || (entry.paths?.out ?? []).length || entry.writesWorkspace === true) && context.executor?.quota?.full?.()) return refusal(workspaceFull());
    let resolved = args;
    if (hasArgs) {
      try { resolved = await resolvePaths(name, entry, args, lane, context, { agentRoot: info?.agentRoot ?? null }); }
      catch (error) {
        if (!(error instanceof PathRefusal)) throw error;
        // C26: a path outside the workspace names the exact place to copy it into (the agent's inbox) and the same call to
        // repeat. a9 follow-up (review vps-a9 M2): at any pointer of the call (a list too: /request/files/*, /files/*), with
        // every path of that pointer the gate refuses (outsideValue, its own rule, nothing brought) as agent:inbox/<name>.
        if (error.code === 'PATH_OUTSIDE_WORKSPACE') {
          const role = (entry.paths?.out ?? []).includes(error.pointer) ? 'out' : 'in';
          const agentRoot = info?.agentRoot ?? null;
          return refusal({ ok: false, ...outsideWorkspaceRefusal(error.value, { agentRoot, role, ...(error.pointer ? { tool: name, args, pointer: error.pointer,
            refused: value => pathOnlyWhen(name, entry, error.pointer, args, value) && outsideValue(value, role, lane, context, agentRoot) } : {}) }) });
        }
        // (a9 follow-up, review vps-a9 L1: a copy from the agent that failed names its destination in the workspace)
        return refusal(pathRefused(error.code, present.string(String(error.message ?? ''))));
      }
      // D2 and item 1: the jobs of the call (inline, a job file, the job of basedOn and the job a patch makes of it) with
      // every composite part and job:<name> target they reach, read strictly inside the workspace: first the prototype op
      // (directly, or a part the gate cannot read whole), then every path inside them confined and, inline, rewritten to
      // the absolute workspace path the kernel reads (job-paths.mjs). Before the handler and any capture.
      const jobs = await confineJobs(name, resolved, { workspace: context.workspace, prototype: refusesPrototype,
        generator: refusesGenerators ? pendingGenerator : null, resolve: value => resolveValue(value, 'in', lane, context, info?.agentRoot ?? null) });
      if (jobs.prototype) return refusal(prototypeUnavailable(name, lane));
      if (jobs.refusal) return refusal(jobPathRefused(jobs.refusal, info?.agentRoot ?? null, text => present.string(String(text ?? ''))));
      // servidor/fase4-25: after the paths (a part the gate refused is named by its own refusal, never as 'unreadable').
      if (jobs.generator) return refusal(generatorUnavailable(name, lane, jobs.generator));
      resolved = jobs.resolved;
      if (name === 'ssam_job' && lane === 'odc' && (resolved.base === undefined || resolved.base === null || resolved.base === ''))
        resolved = { ...resolved, base: NEUTRAL_ODC_BASE };
      // T2, F1 of its review: what the call names by file (an o11_access apply manifest with revokes), read once its path is
      // resolved in the workspace, before the handler and any kind of the agent. A read that throws refuses (fail closed).
      if (refusesDestructive) {
        let files;
        try { files = hostedDestructiveFiles(name, resolved); }
        catch { files = { revokes: null, detail: 'The gate could not read what this call names by file, so it was refused as one that may delete.' }; }
        if (files) return refusal(destructiveUnavailable(name, files));
      }
    }
    const { scope, result } = await withStudioScope(() => run(context, () => handler(...(hasArgs ? [resolved, ...params.slice(1)] : params))));
    if (result?.resultType === 'input_required') return result;
    // A-M1 + E2, round 2 (A1, A2): the Studio of every lane the call touched, never silent when it is not the server's build.
    const verdict = studioVerdict({ name, lane, need, info, context, lanes, scope, skipped, link });
    if (verdict.refusal) return refusal(verdict.refusal);
    return withStudioFields(present.result(name === 'ssam_discover' ? scrubDiscover(result, thirdPartyJobs()) : scrubEvidence(result, thirdPartyJobs())),
      verdict.fields);
  };
}
