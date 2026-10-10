// The hosted gate (docs/FASE2-AGENTE.md 5, 6.3, 6.4, 7 and 8): every tool of a hosted session passes here before its
// handler. In this order: unavailable tools, a lane outside the token, the agent (connected, credential, Studio and
// package versions), the customer's O11 connection and the workspace quota; then each path argument of tools.json is
// resolved inside the visible area of the customer's workspace (ws:<rel>, agent:<rel>, relative or absolute), an
// ssam_job {lane:"odc"} without base gets the neutral fixture as base (docs/O11-BRIDGE-FINA.md 7.2), the handler runs
// inside run(context, fn), and the answer loses the evidence of third-party jobs (evidence.mjs; an ssam_discover answer
// also loses the client names of the owner's catalogs) and is presented: workspace paths become ws:<rel>, other paths
// of this server become <servidor>. Nothing here touches a Studio or the agent by itself, except bringing an
// agent:<rel> the LLM named (executor.pullFile).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anvilRoot, workspaceRoot } from '../workspace.mjs';
import { scrubEvidence, thirdPartyJobs } from './evidence.mjs';
import { agentReadable, agentSegments, insideVisible } from './mirror.mjs';
import { agentPath, outsideWorkspaceRefusal } from '../agent-paths.mjs';

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
    case 'module-target': needs = typeof value === 'string' && value !== '' && !looksLikePath(value); break;
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
export function incompatible(lane, compat, info) {
  const serverKernel = info?.kernel?.[lane] ?? null;
  const agentStudio = info?.studios?.[lane]?.installed?.version ?? null;
  const studio = STUDIO[lane];
  if (compat.code === 'STUDIO_VERSION_MISMATCH') return { ok: false, code: compat.code, lane, serverKernel, agentStudio,
    error: `This SSAM server has the kernel for ${studio} ${serverKernel}; the agent reports ${studio} ${agentStudio}. Tools that touch the ${studio} are unavailable until the versions match. Server-only tools (ssam_discover, ssam_reference, odc_search_operations, ...) still work.`,
    continuation: doctor(`Shows both versions. Ask the user to install ${studio} ${serverKernel}, or to wait until the server owner updates the kernel.`) };
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
const workspaceFull = () => ({ ok: false, code: 'WORKSPACE_FULL',
  error: 'The workspace of this account on the SSAM server is over its quota; nothing ran.', continuation: doctor('Shows the workspace usage. Ask the server owner to free space.') });
const pathRefused = (code, error) => ({ ok: false, code, error,
  continuation: doctor('Pass paths as SSAM tools return them (ws:odc/..., ws:o11/..., ws:inbox/...), or agent:inbox/<file> for a file the user put in the agent inbox folder.') });

// ---- paths (6.3, 6.4)
// The concrete locations of a pointer in an argument object: '*' is every key of an object or item of an array.
function locations(node, segments) {
  if (!segments.length || node === null || typeof node !== 'object') return [];
  const [head, ...rest] = segments;
  const keys = head === '*' ? (Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node)) : Object.hasOwn(node, head) ? [head] : [];
  return keys.flatMap(key => rest.length ? locations(node[key], rest) : [{ parent: node, key, value: node[key] }]);
}
const segmentsOf = pointer => pointer.split('/').slice(1).map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'));
// Arguments that take a module or a path; studio_command passes only what looks like a path; ssam_reference /query is a
// file only for the job checks.
const pathOnlyWhen = (name, entry, pointer, args, value) => {
  if (entry.agent?.when === 'module-target' && pointer === '/' + entry.agent.arg) return looksLikePath(value);
  if (name === 'studio_command' && pointer === '/args/*') return looksLikePath(value);
  if (name === 'ssam_reference' && pointer === '/query') return ['check-job', 'check-delivery'].includes(args?.kind);
  return true;
};

class PathRefusal extends Error { constructor(code, message, value) { super(message); this.code = code; this.value = value; } }
const outside = value => new PathRefusal('PATH_OUTSIDE_WORKSPACE', 'Path outside the workspace of this account: ' + JSON.stringify(String(value).slice(0, 300)), value);

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
const prefixSource = dir => path.resolve(dir).split(/[\\/]+/).filter(Boolean).map(escapeRe).join(SEP);
const TAIL = `(?:${SEP}[^\\\\/\\s"'<>|*?]+)*`;
const END = `(?=$|[\\\\/\\s"'<>|*?,;)\\]}])`;

export function presenter({ workspace, serverRoots = [workspaceRoot, os.homedir()] }) {
  const ws = path.resolve(workspace);
  const wsSource = prefixSource(ws);
  const roots = [...new Set(serverRoots.filter(Boolean).map(r => path.resolve(r)))].sort((a, b) => b.length - a.length);
  const rootSources = roots.map(prefixSource);
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

// ---- the gate
// wrapHostedTool(name, config, handler, {context, link, lanes, run}) -> the handler to register. run(context, fn) puts
// the hosted context around the handler (runWithExecutor in ssam.mjs; tests pass (ctx, fn) => fn()).
export function wrapHostedTool(name, config, handler, { context, link = context?.agent, lanes = context?.lanes ?? [], run = (ctx, fn) => fn(),
  tools = hostedTools(), serverRoots, waitMs = RECONNECT_WAIT_MS } = {}) {
  const entry = tools[name];
  const present = presenter({ workspace: context.workspace, ...(serverRoots ? { serverRoots } : {}) });
  return async (...params) => {
    const hasArgs = config?.inputSchema != null && params.length > 1;
    const args = hasArgs ? (params[0] ?? {}) : {};
    if (!entry || entry.class === 'unavailable') return refusal(unavailable(name, entry, config));
    const lane = laneOf(entry, args);
    if (LANED.has(lane) && !lanes.includes(lane)) return refusal(laneDisabled(lane));
    const need = agentNeed(entry.agent, args);
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
      if (name === 'ssam_job' && lane === 'odc' && (resolved.base === undefined || resolved.base === null || resolved.base === ''))
        resolved = { ...resolved, base: NEUTRAL_ODC_BASE };
    }
    const result = await run(context, () => handler(...(hasArgs ? [resolved, ...params.slice(1)] : params)));
    return result?.resultType === 'input_required' ? result : present.result(scrubEvidence(result, thirdPartyJobs(), { clientText: name === 'ssam_discover' }));
  };
}
