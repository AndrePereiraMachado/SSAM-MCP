// The hosted gate (docs/FASE2-AGENTE.md 5, 6.3, 6.4, 7 and 8): every tool of a hosted session passes here before its
// handler. In this order: unavailable tools, a lane outside the token, the agent (connected, credential, Studio and
// package versions), the customer's O11 connection and the workspace quota; then each path argument of tools.json is
// resolved inside the visible area of the customer's workspace (ws:<rel>, agent:<rel>, relative or absolute), an
// ssam_job {lane:"odc"} without base gets the neutral fixture as base (docs/O11-BRIDGE-FINA.md 7.2), the handler runs
// inside run(context, fn), and the answer loses the evidence of third-party jobs (evidence.mjs; an ssam_discover answer
// also loses the client names of the owner's catalogs, not those of the customer's own module: scrubDiscover) and is
// presented: workspace paths become ws:<rel>, other paths
// of this server become <servidor>. Nothing here touches a Studio or the agent by itself, except bringing an
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
// or send, by one switch (HOSTED_DESTRUCTIVE): HOSTED_UNAVAILABLE, cause DESTRUCTIVE_HOSTED_OFF, no continuation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anvilRoot, workspaceRoot } from '../workspace.mjs';
import { scrubDiscover, scrubEvidence, thirdPartyJobs } from './evidence.mjs';
import { agentReadable, agentSegments, insideVisible } from './mirror.mjs';
import { agentPath, outsideWorkspaceRefusal } from '../agent-paths.mjs';
import { JOB_TOOLS, JobTextError, PathRefusal, confineJobs, jobTextPointers, namesPrototype, outside, parseJobTexts } from './job-paths.mjs';
import { studioIdentity, studioRefusal, studioWarningOf } from '../studio-identity.mjs';
import { destructiveUnavailable, hostedDestructive } from './destructive.mjs';

export const TOOLS_FILE = fileURLToPath(new URL('./tools.json', import.meta.url));
let loaded = null;
export const hostedTools = () => (loaded ??= JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8')).tools);

const STUDIO = { odc: 'ODC Studio', o11: 'Service Studio' };
const LANED = new Set(['odc', 'o11']);
// The base of a hosted ssam_job {lane:"odc"} that names none: a blank CrossDevice app created offline (anvil-odc
// create-blank), never the base the job declares (the suite's own fixture is a customer capture).
export const NEUTRAL_ODC_BASE = path.join(anvilRoot, 'tests', 'fixtures', 'odc', 'blank-crossdevice.oml');
const doctor = why => ({ tool: 'ssam_doctor', arguments: {}, why });
const refusal = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true });

// 6.3 rule 3: what looks like a path. In arguments that take a module OR a path, anything else is a module name.
export const looksLikePath = value => typeof value === 'string'
  && (/^(ws|agent):/.test(value) || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /\.(oml|json|jsonl|avsig)$/i.test(value));

// When a tool needs the agent for these arguments: 'always', 'never' or 'report' (answers without the agent).
export function agentNeed(rule, args = {}) {
  if (rule === 'always' || rule === 'report') return rule;
  if (rule === 'never' || rule == null) return 'never';
  const value = args?.[rule.arg];
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
export function agentNotConnected(info, { now = Date.now(), tool = null, args = null } = {}) {
  if (reconnecting(info, now)) {
    const age = sinceSeen(info, now);
    const seconds = Math.round(age / 1000);
    const why = age < RESTART_AFTER_MS
      ? 'o agente SSAM reconecta sozinho (perdeu a conexão há ' + seconds + ' s): repita a mesma chamada em ' + RETRY_AFTER_SECONDS + ' s; não peça ao usuário para reiniciar nada'
      : 'o agente está sem contato há ' + seconds + ' s: repita em ' + RETRY_AFTER_SECONDS + ' s e, se continuar, peça ao usuário para conferir a janela do agente (agent\\ssam-agent.ps1 status) e iniciá-lo só se ele tiver parado';
    return { ok: false, code: 'AGENT_RECONNECTING', retryAfterSeconds: RETRY_AFTER_SECONDS, lastSeenSecondsAgo: seconds,
      error: 'The SSAM agent of this account lost its connection ' + seconds + ' s ago and is reconnecting by itself; nothing ran on the user\'s machine.',
      continuation: tool ? { tool, arguments: args ?? {}, why } : doctor(why) };
  }
  const why = info?.credential === false
    ? 'The server owner must issue an agent credential for this token (ssam server-token agent-rotate); then the user starts the SSAM agent and calls this tool again.'
    : 'Ask the user to start the SSAM agent on their machine (agent\\ssam-agent.ps1 start, see docs/AGENTE-CLIENTE.md), then call this tool again. ssam_doctor shows when the agent is connected.';
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
  // refusal with the direction (cause), both builds, what still works and "nothing ran", in pt-BR (userMessage) and English
  // (error). It replaces the old continuation "install the Studio at the server's version", impossible for the ODC Studio.
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
// discover of the same request.
const unavailable = (name, entry, config) => ({ ok: false, code: 'HOSTED_UNAVAILABLE', ...(entry?.cause ? { cause: entry.cause } : {}),
  error: `${name} is not available on a hosted SSAM server: ${entry?.reason ?? 'it is not classified for hosted use.'}`,
  continuation: entry?.continuation
    ?? { tool: 'ssam_discover', arguments: { intent: config?.title ?? name }, why: 'Lists the tools this server offers for the same request.' } });
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
function jobPathRefused(error, agentRoot) {
  const pointer = error.pointer ?? null;
  if (error.code !== 'PATH_OUTSIDE_WORKSPACE') return { ...pathRefused(error.code, error.message), ...(pointer ? { pointer } : {}), ...(error.fix ? { fix: error.fix } : {}) };
  return { ok: false, ...outsideWorkspaceRefusal(error.value, { agentRoot }), pointer,
    error: 'The job names, at ' + pointer + ', a path outside the workspace of this account: ' + JSON.stringify(String(error.value ?? '').slice(0, 300))
      + '. Files a job names (base, composite parts, a reference producer, an html file, a WSDL/OpenAPI document, a prototype folder) must be ws:<rel> or agent:inbox/<file>; nothing was read there and nothing ran.' };
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
      + 'of its JavaScript would run on the server machine. Nothing ran. / O importador de protótipo (op "prototype") por enquanto só funciona '
      + 'no uso local: no servidor hospedado a pasta dele e a captura do seu JavaScript rodariam na máquina do servidor. Nada rodou.',
    continuation: { tool: 'ssam_discover', arguments: { intent: 'port an approved prototype screen 1:1 with the html op and its style in the theme', lane: lane === 'odc' ? 'odc' : 'o11' },
      why: 'Builds the same screens with the ops this server runs (html op plus its <style>), without the prototype op; or import the prototype with an SSAM installed on the user\'s own machine.' } };
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
  if (name === 'studio_command' && pointer === '/args/*') return looksLikePath(value);
  if (name === 'ssam_reference' && pointer === '/query') return ['check-job', 'check-delivery'].includes(args?.kind);
  if (name === 'ssam_reference' && pointer === '/query/basedOn/job') return patchedQuery(args);
  if (name === 'ssam_reference' && pointer === '/query/job') return patchedQuery(args);
  return true;
};

async function resolveValue(value, role, lane, context, agentRoot = null) {
  const workspace = path.resolve(context.workspace);
  // C26: an absolute path of the user's machine under the agent's own folders (the root the agent reports in its Hello) is
  // that agent: path, e.g. C:\SSAM-Agent\inbox\job.json -> agent:inbox/job.json.
  const mapped = /^[A-Za-z]:[\\/]/.test(value) ? agentPath(value, { agentRoot }) : null;
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

// ---- presentation (6.3 rule 4)
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '[\\\\/]+';
// A folder whose absolute path starts with a separator (POSIX, and Windows UNC) keeps that separator in its pattern, and
// its match must start a path, not continue another one. Without both, on Linux (server/Dockerfile) /data/server/... lost
// its leading "/": the workspace came out as "/ws:odc/..." (a path no tool takes back) and a short server root such as
// HOME=/tmp turned any ".../tmp/..." into "<servidor>". A Windows drive path (C:\...) keeps its pattern as before.
const PATH_START = `(?<![^\\s"'<>|*?,;:=()[\\]{}])`;
const prefixSource = (dir, api = path) => {
  const abs = api.resolve(dir);
  const parts = abs.split(/[\\/]+/).filter(Boolean).map(escapeRe);
  return /^[\\/]/.test(abs) ? PATH_START + SEP + parts.join(SEP) : parts.join(SEP);
};
const TAIL = `(?:${SEP}[^\\\\/\\s"'<>|*?]+)*`;
const END = `(?=$|[\\\\/\\s"'<>|*?,;)\\]}])`;

// The server's own data roots that may live outside the checkout and the profile (servidor/fase4-22): the module index
// store, where the 22nd release also keeps the module digest (ssam_map index.file and store.file), and the readers' copy.
export const serverDataRoots = (env = process.env) => [env.SSAM_MODULE_INDEX_ROOT, env.SSAM_READER_CACHE_ROOT]
  .filter(root => typeof root === 'string' && root.trim()).map(root => path.resolve(root));
// pathApi: the path flavor of this server (path.posix in a test of the Linux image's paths).
export function presenter({ workspace, serverRoots = [workspaceRoot, os.homedir(), ...serverDataRoots()], pathApi = path }) {
  const ws = pathApi.resolve(workspace);
  const wsSource = prefixSource(ws, pathApi);
  const roots = [...new Set(serverRoots.filter(Boolean).map(r => pathApi.resolve(r)))].sort((a, b) => b.length - a.length);
  const rootSources = roots.map(root => prefixSource(root, pathApi));
  const asWs = rest => {
    const segments = rest.split(/[\\/]+/).filter(Boolean);
    return segments.length && ['odc', 'o11', 'inbox'].includes(segments[0].toLowerCase()) ? 'ws:' + segments.join('/') : '<servidor>';
  };
  const wholeWs = new RegExp(`^${wsSource}${END}(.*)$`, 'is');
  const wholeServer = rootSources.map(source => new RegExp(`^${source}${END}`, 'i'));
  const embeddedWs = new RegExp(`${wsSource}${END}(${TAIL})`, 'gi');
  const embeddedServer = rootSources.map(source => new RegExp(`${source}${END}${TAIL}`, 'gi'));
  const string = text => {
    const whole = wholeWs.exec(text);
    if (whole) return asWs(whole[1]);
    if (wholeServer.some(re => re.test(text))) return '<servidor>';
    let out = text.replace(embeddedWs, (match, rest) => asWs(rest));
    for (const re of embeddedServer) out = out.replace(re, '<servidor>');
    return out;
  };
  const value = node => typeof node === 'string' ? string(node)
    : Array.isArray(node) ? node.map(value)
    : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, value(v)])) : node;
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
export function studioNotice(lane, info) {
  if (!LANED.has(lane)) return null;
  const compat = info?.compatible?.[lane];
  return compat ? studioWarningOf(studioOf(lane, compat, info)) : null;
}
// The answer with studioWarning: in structuredContent and in the text that mirrors it; an answer without structured
// content (or whose text is another rendering) gets one more text item. The tool's own fields, warnings included, stay.
export function withStudioWarning(answer, warning) {
  if (!warning || !answer || typeof answer !== 'object') return answer;
  const original = answer.structuredContent;
  const content = Array.isArray(answer.content) ? answer.content : [];
  if (original && typeof original === 'object' && !Array.isArray(original)) {
    const structuredContent = { ...original, studioWarning: warning };
    const mirror = JSON.stringify(original);
    let mirrored = false;
    const items = content.map(item => {
      if (item?.type !== 'text' || item.text !== mirror) return item;
      mirrored = true;
      return { ...item, text: JSON.stringify(structuredContent) };
    });
    return { ...answer, structuredContent, content: mirrored ? items : [...items, { type: 'text', text: JSON.stringify({ studioWarning: warning }) }] };
  }
  return { ...answer, content: [...content, { type: 'text', text: JSON.stringify({ studioWarning: warning }) }] };
}

// ---- the gate
// wrapHostedTool(name, config, handler, {context, link, lanes, run, argsOf}) -> the handler to register. run(context, fn)
// puts the hosted context around the handler (runWithExecutor in ssam.mjs; tests pass (ctx, fn) => fn()). argsOf: the
// input layer's arguments for the ones sent (R1); every rule below and the handler read them. prototypeOp: the D2 switch
// (HOSTED_PROTOTYPE_OP by default; tests pass the other value). kernelRefused: the lanes the server image refused at start
// (ssam.mjs startupKernel), each off for every tool but the state reports (kernelLaneOff). destructive: the T2 switch
// (HOSTED_DESTRUCTIVE by default; tests pass the other value).
export function wrapHostedTool(name, config, handler, { context, link = context?.agent, lanes = context?.lanes ?? [], run = (ctx, fn) => fn(),
  tools = hostedTools(), serverRoots, waitMs = RECONNECT_WAIT_MS, argsOf = null, prototypeOp = HOSTED_PROTOTYPE_OP, kernelRefused = null,
  destructive = HOSTED_DESTRUCTIVE } = {}) {
  const entry = tools[name];
  const present = presenter({ workspace: context.workspace, ...(serverRoots ? { serverRoots } : {}) });
  const refusesPrototype = prototypeOp !== 'allow' && PROTOTYPE_TOOLS.includes(name);
  const refusesDestructive = destructive !== 'allow';
  return async (...params) => {
    const hasArgs = config?.inputSchema != null && params.length > 1;
    // R1: the arguments the tool runs (a field the input layer renames is confined under its own name).
    let args = hasArgs ? effectiveArgs(argsOf, params[0] ?? {}) : {};
    if (!entry || entry.class === 'unavailable') return refusal(unavailable(name, entry, config));
    // T2: a call that deletes, read on the arguments it runs and on the ones sent, before anything else of the call.
    if (refusesDestructive && (deletes(name, args) || (hasArgs && deletes(name, params[0])))) return refusal(destructiveUnavailable(name));
    // Item 1: the JSON text of a job is the job itself only on a job pointer; parsed here, every rule below (and the
    // handler) reads the object. A text there that looks like JSON and does not parse is refused: it is no path either.
    if (hasArgs) {
      try { args = parseJobTexts(name, args); }
      catch (error) { if (!(error instanceof JobTextError)) throw error; return refusal(jobTextInvalid(error)); }
    }
    const lane = laneOf(entry, args);
    // D2: an inline job, partial job or patch with the prototype op, before the agent, the lane checks and any capture.
    if (refusesPrototype && hasArgs && namesPrototype(args)) return refusal(prototypeUnavailable(name, lane));
    if (LANED.has(lane) && !lanes.includes(lane)) return refusal(laneDisabled(lane));
    const need = agentNeed(entry.agent, args);
    // O.6.1: a lane the image refused at start is off for every tool but the state reports, before the agent and any path.
    if (LANED.has(lane) && need !== 'report' && kernelRefused?.[lane]) return refusal(kernelLaneOff(lane, kernelRefused[lane]));
    let info = null;
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
      if (compat && compat.ok === false) return refusal(incompatible(lane, compat, info));
      if (lane === 'o11' && name !== 'ssam_connect' && !context.executor?.o11Connection?.()) return refusal(o11NotConnected());
    }
    if ((need === 'always' || (entry.paths?.out ?? []).length) && context.executor?.quota?.full?.()) return refusal(workspaceFull());
    let resolved = args;
    if (hasArgs) {
      try { resolved = await resolvePaths(name, entry, args, lane, context, { agentRoot: info?.agentRoot ?? null }); }
      catch (error) {
        if (!(error instanceof PathRefusal)) throw error;
        // C26: a path outside the workspace names the exact place to write it (the agent's inbox) and the same call to repeat.
        if (error.code === 'PATH_OUTSIDE_WORKSPACE') {
          const field = /^\/[^/*]+$/.test(error.pointer ?? '') ? error.pointer.slice(1).replaceAll('~1', '/').replaceAll('~0', '~') : null;
          return refusal({ ok: false, ...outsideWorkspaceRefusal(error.value, { agentRoot: info?.agentRoot ?? null, ...(field ? { tool: name, args, field } : {}) }) });
        }
        return refusal(pathRefused(error.code, error.message));
      }
      // D2 and item 1: the jobs of the call (inline, a job file, the job of basedOn and the job a patch makes of it) with
      // every composite part and job:<name> target they reach, read strictly inside the workspace: first the prototype op
      // (directly, or a part the gate cannot read whole), then every path inside them confined and, inline, rewritten to
      // the absolute workspace path the kernel reads (job-paths.mjs). Before the handler and any capture.
      const jobs = await confineJobs(name, resolved, { workspace: context.workspace, prototype: refusesPrototype,
        resolve: value => resolveValue(value, 'in', lane, context, info?.agentRoot ?? null) });
      if (jobs.prototype) return refusal(prototypeUnavailable(name, lane));
      if (jobs.refusal) return refusal(jobPathRefused(jobs.refusal, info?.agentRoot ?? null));
      resolved = jobs.resolved;
      if (name === 'ssam_job' && lane === 'odc' && (resolved.base === undefined || resolved.base === null || resolved.base === ''))
        resolved = { ...resolved, base: NEUTRAL_ODC_BASE };
    }
    const result = await run(context, () => handler(...(hasArgs ? [resolved, ...params.slice(1)] : params)));
    if (result?.resultType === 'input_required') return result;
    // A-M1 + E2: the lane's Studio as the hub judged it before the call (info), never silent when it is not the server's build.
    return withStudioWarning(present.result(name === 'ssam_discover' ? scrubDiscover(result, thirdPartyJobs()) : scrubEvidence(result, thirdPartyJobs())),
      studioNotice(lane, info));
  };
}
