// The quality record ssam-quality/1 of the hosted server (docs/QUALIDADE.md): what one tool call or one MCP session
// becomes as a line of codes, counts and times. Pure: no I/O, no clock, no state. The recorder (quality-recorder.mjs)
// feeds it and writes what it builds through sanitizeQualityLine and fitLine (quality-line.mjs, the shared contract).
//   - summarizeAnswer reads a fixed list of keys of ONE answer object (2.6 of the design): codes, counts, the queue time.
//     It never walks the object, never reads a text field, never runs a regular expression over an answer text and never
//     keeps the answer. normalizations.items, problem messages, fixes, pointers, paths and elements are never read.
//   - argsSummary reads the request arguments with typeof checks only (the form of the job, never the job).
//   - timesFromSpans splits the call's time over the spans the meter attributed to it (2.7).
//   - buildCallLine / buildSessionLine assemble the frame; the contract decides what of it stays.
import { createHash } from 'node:crypto';
import { SCHEMA, LANES, STEPS, CLIENTS, REASONS, UNTIL, MAX_TOP, RULE_UNLISTED, codeOf, ruleOf, verbOf, agentLabel } from './quality-line.mjs';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = v => (Number.isInteger(v) && v >= 0 ? v : null);
export const MAX_PROBLEMS_READ = 2000;
export const MAX_VALIDATION_READ = 500;
export const MAX_TEXT_PARSE = 262144;

// The verb of each multi-verb tool (2.4): the field, its default and the tool's own enum (the module constants:
// module-map.mjs VIEWS, ssam-reference.mjs REFERENCE_KINDS, o11-environment.mjs ENVIRONMENT_READS + ENVIRONMENT_WRITES,
// o11-studio.mjs COMMANDS, o11-access.mjs ACTIONS, studio-create-app.mjs CREATE_APP_ACTIONS, the friction tool's view).
// Kept here as values so this module stays pure; quality-record.test.mjs checks them against tools/list and the constants.
export const VERB_FIELDS = Object.freeze({
  ssam_map: Object.freeze({ field: 'view', default: 'map', values: Object.freeze(['map', 'digest', 'ddl', 'flow', 'search', 'uses', 'html', 'logic']) }),
  ssam_reference: Object.freeze({ field: 'kind', default: null, values: Object.freeze(['api', 'functions', 'ui-block', 'types', 'where-can', 'recipe', 'check-job', 'check-delivery', 'verify-message', 'example', 'rules']) }),
  o11_environment: Object.freeze({ field: 'action', default: null, values: Object.freeze(['inventory', 'download', 'download-app', 'templates', 'references', 'referenceable',
    'create-app', 'add-modules', 'create-module', 'update-app', 'refresh-refs', 'set-user-provider', 'delete-app']) }),
  o11_studio: Object.freeze({ field: 'command', default: null, values: Object.freeze(['status', 'wait', 'open-module', 'close-module', 'snapshot', 'errors', 'publish-log', 'windows', 'dismiss-dialog', 'login', 'refresh-references']) }),
  o11_access: Object.freeze({ field: 'action', default: null, values: Object.freeze(['plan', 'apply', 'verify', 'users']) }),
  studio_create_app: Object.freeze({ field: 'action', default: 'create', values: Object.freeze(['templates', 'create']) }),
  ssam_friction: Object.freeze({ field: 'view', default: 'issues', values: Object.freeze(['issues', 'task', 'report']) }),
});
// The calls whose ok answer is a creation (deliv "criado"): any op of studio_create, these ops of the others.
export const CREATE_OPS = Object.freeze({ studio_create: null, studio_create_app: Object.freeze(['create']),
  o11_environment: Object.freeze(['create-app', 'add-modules', 'create-module']) });
// Where an agent call's time goes (2.7): the category of a kind, or of a kind and its protocol verb.
export const SPAN_CATEGORIES = Object.freeze({
  'o11.bridge': Object.freeze({ snapshot_module: 'capture', export_modules: 'capture', environment_session: 'environment', get_errors: 'verify',
    publish: 'publish', publish_log: 'publish', '*': 'studio' }),
  'odc.pipe': Object.freeze({ snapshot: 'capture', latest: 'capture', 'reference-producers': 'capture', publish: 'publish', 'publish-status': 'publish', '*': 'studio' }),
  'odc.attach': 'studio', 'o11.connect': 'studio', 'o11.selected': 'studio', 'studio.processes': 'studio',
  'file.get': 'transfer', 'file.put': 'transfer', 'file.list': 'transfer', 'file.sync': 'transfer', 'net.probe': 'network', kernel: 'kernel',
});
export function categoryOf(kind, verb = null) {
  const entry = SPAN_CATEGORIES[kind];
  if (typeof entry === 'string') return entry;
  if (isObj(entry)) return (typeof verb === 'string' && Object.hasOwn(entry, verb) ? entry[verb] : entry['*']);
  return null;
}
const AGENT_CATEGORIES = ['capture', 'studio', 'verify', 'publish', 'environment', 'transfer', 'network'];

// ---- request side
// The op of a call (2.4): the tool's own enum value, else null. o11_deliver: close or resume when that argument is set.
export function opOf(tool, args) {
  const a = isObj(args) ? args : {};
  if (tool === 'o11_deliver') return a.close != null && a.close !== false ? 'close' : a.resume != null && a.resume !== false ? 'resume' : null;
  const spec = Object.hasOwn(VERB_FIELDS, tool) ? VERB_FIELDS[tool] : null;
  if (!spec) return null;
  const value = a[spec.field] === undefined ? spec.default : a[spec.field];
  return typeof value === 'string' && spec.values.includes(value) ? verbOf(value) : null;
}
// The lane of a call: the lane argument when it is o11/odc; else the catalog lane (hosted/tools.json) when it is o11/odc;
// for arg:<x> the default <x>; else null.
export function laneOf(args, catalogLane) {
  if (isObj(args) && LANES.includes(args.lane)) return args.lane;
  if (LANES.includes(catalogLane)) return catalogLane;
  if (typeof catalogLane === 'string' && catalogLane.startsWith('arg:')) { const d = catalogLane.slice(4); return LANES.includes(d) ? d : null; }
  return null;
}
// The first character of a string that is not white space (looks at most 64 characters, never copies the string).
function firstChar(text) {
  for (let i = 0; i < text.length && i < 64; i++) { const c = text[i]; if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') return c; }
  return '';
}
// The form of the request (2.6), from the arguments with typeof checks only: the job's form, never the job.
export function argsSummary(args, { bytes = null } = {}) {
  const a = isObj(args) ? args : {};
  const out = {};
  const job = a.job;
  if (job !== null && typeof job === 'object') out.job = 'inline';
  else if (typeof job === 'string') {
    const c = firstChar(job);
    out.job = c === '{' || c === '[' ? 'inline-text' : job.startsWith('ws:') ? 'ws' : job.startsWith('agent:') ? 'agent' : 'other';
  }
  if (isObj(a.basedOn)) out.basedOn = true;
  if (a.partial === true) out.partial = true;
  if (a.closePrevious != null && a.closePrevious !== false) out.closePrevious = true;
  if (a.publish === true) out.publish = true;
  if (Array.isArray(a.patch)) out.patch = a.patch.length;
  if (typeof a.until === 'string' && UNTIL.includes(a.until)) out.until = a.until;
  if (Number.isInteger(bytes) && bytes > 0) out.bytes = bytes;
  return out;
}

// ---- session side
export const sessionHash = sessionId => createHash('sha256').update('ssam-quality/1\n' + String(sessionId), 'utf8').digest('hex').slice(0, 12);
// The family of the MCP client from initialize.clientInfo.name (2.3); never the version, never the name itself.
export function clientFamily(name) {
  if (typeof name !== 'string') return 'unknown';
  const n = name.slice(0, 200).toLowerCase().trim();
  if (!n) return 'unknown';
  if (n.includes('claude-code') || n.includes('claude code')) return 'claude-code';
  if (n.includes('claude.ai') || n.includes('claude-ai')) return 'claude-ai';
  if (n.includes('claude')) return 'claude-desktop';
  if (n.includes('codex')) return 'codex';
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('visual studio code') || n.includes('vscode')) return 'vscode';
  if (n.includes('windsurf')) return 'windsurf';
  return 'other';
}
export const closeReason = reason => (typeof reason === 'string' && REASONS.includes(reason) ? reason : 'other');

// ---- answer side
const RESULTS = { entregue: 'entregue', 'entregue e publicado': 'entregue-publicado' };
// The outcomes the class reads (2.4); any other is not kept.
const OUTCOMES = ['refused', 'not-sent', 'uncertain', 'incomplete'];
// The one object an answer is read from: its structuredContent, else its first text when that is a JSON object of at most
// MAX_TEXT_PARSE characters. null otherwise.
function sourceOf(result) {
  if (!isObj(result)) return null;
  if (isObj(result.structuredContent)) return result.structuredContent;
  const first = Array.isArray(result.content) ? result.content[0] : null;
  const text = first?.type === 'text' && typeof first.text === 'string' ? first.text : null;
  if (text === null || text.length > MAX_TEXT_PARSE || text[0] !== '{') return null;
  try { const value = JSON.parse(text); return isObj(value) ? value : null; } catch { return null; }
}
// The problems of a refusal (2.6), counted per code, phase and patch; validation errors as verify problems.
function problemsSummary(s, nativeIds) {
  const list = Array.isArray(s.problems) ? s.problems : Array.isArray(s.refusal?.problems) && s.problems === undefined ? s.refusal.problems : null;
  const validation = Array.isArray(s.validationErrors) ? s.validationErrors : null;
  const total = count(s.problemsTotal);
  if (!list?.length && !validation?.length) return total ? { n: total, err: 0, warn: 0, cut: true } : null;
  const byCode = Object.create(null), withPatch = Object.create(null), byPhase = Object.create(null);
  const add = (map, key, n) => { map[key] = (map[key] ?? 0) + n; };
  let sum = 0, err = 0, warn = 0;
  const entries = list ?? [];
  const read = Math.min(entries.length, MAX_PROBLEMS_READ);
  for (let i = 0; i < read; i++) {
    const p = entries[i];
    const o = isObj(p) ? p : null;
    const code = codeOf(o?.code, { nativeIds }) ?? 'PROBLEM_UNCODED';
    const n = Number.isInteger(o?.count) && o.count >= 1 ? o.count : 1;
    sum += n;
    add(byCode, code, n);
    if (o?.severity === 'warning') warn += n; else err += n;
    add(byPhase, ['preflight', 'base', 'apply', 'verify'].includes(o?.phase) ? o.phase : 'other', n);
    if ((Array.isArray(o?.patch) && o.patch.length > 0) || o?.patchOmitted === true) add(withPatch, code, n);
  }
  let checked = 0;
  for (let i = 0; validation && i < validation.length && i < MAX_VALIDATION_READ; i++) {
    const e = validation[i];
    const o = isObj(e) ? e : null;
    add(byCode, codeOf(o?.id ?? o?.code, { nativeIds }) ?? 'VALIDATION_UNCODED', 1);
    add(byPhase, 'verify', 1);
    err++; checked++;
  }
  const kept = (name, map) => (Object.keys(map).length ? { [name]: { ...map } } : {});
  return { n: Math.max(sum, total ?? 0) + checked, err, warn, ...kept('byCode', byCode), ...kept('withPatch', withPatch), ...kept('byPhase', byPhase),
    cut: (total ?? 0) > sum || entries.length > MAX_PROBLEMS_READ || (validation?.length ?? 0) > MAX_VALIDATION_READ };
}
// The normalizations (n = how many expressions or properties the kernel rewrote). byRule counts each rule that acted: the
// kernel joins the rules of one expression with "+" (JobNormalizer: LIST_ENTITY_SEGMENT_DROPPED+NULL_FUNCTION_REWRITTEN),
// and that entry counts under each of them, so the sum of byRule may exceed n. A rule outside the registry is RULE_UNLISTED.
function normSummary(s) {
  const norm = s.normalizations;
  if (!isObj(norm)) return null;
  const n = count(norm.total);
  if (!n) return null;
  const byRule = Object.create(null);
  if (isObj(norm.byRule)) for (const [rules, v] of Object.entries(norm.byRule)) {
    if (!Number.isInteger(v) || v <= 0) continue;
    for (const rule of new Set(rules.split('+'))) { const key = ruleOf(rule) ?? RULE_UNLISTED; byRule[key] = (byRule[key] ?? 0) + v; }
  }
  return { n, byRule: { ...byRule } };
}
function warnSummary(s) {
  const n = count(s.warningsTotal) ?? (Array.isArray(s.warnings) ? s.warnings.length : 0);
  const high = Array.isArray(s.highWarnings) ? s.highWarnings.length : 0;
  return n || high ? { n: Math.max(n, high), high } : null;
}
const queueOf = s => (isObj(s.phases) ? count(s.phases.queuedMs) : isObj(s.queue) ? count(s.queue.waitedMs) : null);

// summarizeAnswer(tool, args, result, {scan, nativeIds}) -> the summary of one MCP result (2.6). scan: 'full' for the
// shaped answer before paging, 'wire' for the message that left. Throws nothing (an unexpected shape gives scan 'error').
export function summarizeAnswer(tool, args, result, { scan = 'wire', nativeIds = null } = {}) {
  try {
    const s = sourceOf(result);
    if (!s) return { scan: 'skipped' };
    const str = v => (typeof v === 'string' ? v : null);
    const stepText = str(s.failed) ?? str(s.stage) ?? str(s.gate);
    const problems = problemsSummary(s, nativeIds);
    return { scan,
      result: typeof s.result === 'string' && Object.hasOwn(RESULTS, s.result) ? RESULTS[s.result] : null,
      outcome: OUTCOMES.includes(s.outcome) ? s.outcome : null,
      stepText: stepText !== null, step: stepText !== null && STEPS.includes(stepText) ? stepText : null,
      problems, norm: normSummary(s), warn: warnSummary(s), queue: queueOf(s), paged: isObj(s.paged) };
  } catch { return { scan: 'error' }; }
}
// The characters the client reads: the texts of the wire message (the structuredContent copy is not counted).
export function answerChars(message) {
  const content = message?.result?.content;
  let chars = 0;
  if (Array.isArray(content)) for (const c of content) if (typeof c?.text === 'string') chars += c.text.length;
  return chars;
}

// The answer part of a call line from the JSON-RPC message that left (2.6, D5): the summary noted before paging when there
// is one (scan full), else the wire message's own (scan wire); a JSON-RPC error is a protocol error with nothing to read.
// -> {protocol, summary, chars, paged}.
export function summarizeMessage(tool, args, message, { noted = null, nativeIds = null } = {}) {
  const protocol = isObj(message) && message.error != null && !('result' in message);
  const summary = protocol ? { scan: 'skipped' } : noted ?? summarizeAnswer(tool, args, message?.result, { scan: 'wire', nativeIds });
  const wire = message?.result;
  return { protocol, summary, chars: answerChars(message), paged: isObj(wire?.structuredContent?.paged) || summary.paged === true };
}

// deliv (2.4): entregue / entregue-publicado from the answer's result; criado for an ok creation; else null.
export function delivOf(tool, op, ok, summary) {
  if (summary?.result) return summary.result;
  if (ok && Object.hasOwn(CREATE_OPS, tool) && (CREATE_OPS[tool] === null || CREATE_OPS[tool].includes(op))) return 'criado';
  return null;
}
// class (2.4): the first rule that holds.
export function classify({ protocol = false, deliv = null, ok, code = null, summary = null }) {
  if (protocol) return 'protocol';
  if (deliv) return 'delivered';
  if (ok) return 'ok';
  if (summary?.outcome === 'uncertain' || summary?.outcome === 'incomplete' || (typeof code === 'string' && code.endsWith('_UNCERTAIN'))) return 'uncertain';
  if (summary?.outcome === 'refused' || summary?.outcome === 'not-sent' || (summary?.problems?.n ?? 0) > 0 || summary?.stepText === true) return 'refused';
  return 'failed';
}

// ---- spans -> where the time went (2.7)
function merged(intervals) {
  const list = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of list) { const last = out[out.length - 1]; if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]); }
  return out;
}
const lengthOf = list => merged(list).reduce((s, [a, b]) => s + (b - a), 0);
// spans: [{cat, label, startMs, ms, ok, bytes?, via?}] of one call (an aggregated entry of the meter's overflow also has n and
// failed: how many spans it stands for); ms: the call's duration; queue: the answer's queue time; window: [beginMs, endMs]
// (epoch) the unions are clipped to; approx: more spans than the meter keeps (sums only).
// -> {t, agent|null, kernel|null}.
export function timesFromSpans(spans, { ms = 0, queue = null, window = null, approx = false, shared = false } = {}) {
  const list = Array.isArray(spans) ? spans.filter(isObj) : [];
  const many = s => (Number.isInteger(s.n) && s.n >= 0 ? s.n : 1);
  const failures = s => (Number.isInteger(s.failed) && s.failed >= 0 ? s.failed : s.ok === false ? 1 : 0);
  const total = (spansOf, fn) => spansOf.reduce((a, s) => a + fn(s), 0);
  const agentSpans = list.filter(s => s.cat !== 'kernel');
  const kernelSpans = list.filter(s => s.cat === 'kernel');
  const t = {};
  for (const cat of AGENT_CATEGORIES) {
    const sum = agentSpans.filter(s => s.cat === cat).reduce((a, s) => a + Math.max(0, Math.round(s.ms) || 0), 0);
    if (sum) t[cat] = sum;
  }
  const clip = s => {
    let a = Number(s.startMs) || 0, b = a + Math.max(0, Number(s.ms) || 0);
    if (window) { a = Math.max(a, window[0]); b = Math.min(b, window[1]); }
    return [a, b];
  };
  let kernelMs, ownMs, covered;
  if (approx) {
    kernelMs = kernelSpans.reduce((a, s) => a + Math.max(0, Math.round(s.ms) || 0), 0);
    ownMs = kernelMs;
    covered = list.reduce((a, s) => a + Math.max(0, Math.round(s.ms) || 0), 0);
  } else {
    const k = kernelSpans.map(clip), g = agentSpans.map(clip);
    kernelMs = Math.round(lengthOf(k));
    covered = Math.round(lengthOf([...k, ...g]));
    ownMs = Math.max(0, covered - Math.round(lengthOf(g)));
  }
  if (Number.isFinite(queue) && queue > 0) t.queue = Math.round(queue);
  if (kernelMs) { t.kernel = kernelMs; if (ownMs) t.kernelOwn = ownMs; }
  const rest = Math.max(0, Math.round(ms) - (t.queue ?? 0) - covered);
  if (rest) t.rest = rest;
  let agent = null;
  if (agentSpans.length || shared) {
    const byLabel = new Map();
    let failed = 0, bytes = 0;
    for (const s of agentSpans) {
      failed += failures(s);
      if (Number.isFinite(s.bytes) && s.bytes > 0) bytes += s.bytes;
      const label = agentLabel(s.label) ?? null;
      if (!label) continue;
      const e = byLabel.get(label) ?? [label, 0, 0];
      e[1] += many(s); e[2] += Math.max(0, Math.round(s.ms) || 0);
      byLabel.set(label, e);
    }
    const top = [...byLabel.values()].sort((x, y) => y[2] - x[2] || y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, MAX_TOP);
    agent = { n: total(agentSpans, many), failed, ...(bytes ? { bytes } : {}), shared: shared === true, ...(approx ? { approx: true } : {}), ...(top.length ? { top } : {}) };
  }
  const kernel = kernelSpans.length ? { runs: total(kernelSpans, many), cold: total(kernelSpans.filter(s => s.via === 'cold'), many),
    worker: total(kernelSpans.filter(s => s.via === 'worker' || s.via === 'resident'), many), ms: kernelMs } : null;
  return { t, agent, kernel };
}

// ---- lines
// The frame of every line (2.2). time: a Date or epoch ms.
export function frameOf({ kind, time, tokenId, customer, sessionId }) {
  return { schema: SCHEMA, kind, time: new Date(time).toISOString(), token: tokenId, ...(typeof customer === 'string' && customer ? { customer } : {}),
    session: sessionHash(sessionId) };
}
export function buildSessionLine({ event, time, tokenId, customer, sessionId, client = null, reason = null, calls = 0, openMs = 0 }) {
  return { ...frameOf({ kind: 'session', time, tokenId, customer, sessionId }), event, client: CLIENTS.includes(client) ? client : 'unknown',
    ...(event === 'closed' ? { reason: closeReason(reason), calls, openMs: Math.max(0, Math.round(openMs)) } : {}) };
}
// One call (2.4). summary: summarizeAnswer's object (or {scan}); spans: {t, agent, kernel} of timesFromSpans.
export function buildCallLine({ time, tokenId, customer, sessionId, call, tool, op = null, lane = null, ms, gapMs = null, inFlight = 0,
  ok, code = null, protocol = false, summary = {}, times = null, args = null, chars = 0, paged = false }) {
  const deliv = delivOf(tool, op, ok, summary);
  const line = { ...frameOf({ kind: 'call', time, tokenId, customer, sessionId }), call, tool, op, lane, ms: Math.max(0, Math.round(ms)),
    gapMs: gapMs === null ? null : Math.max(0, Math.round(gapMs)), inFlight, ok, code: ok ? null : code,
    class: classify({ protocol, deliv, ok, code, summary }), step: summary?.step ?? null, deliv };
  if (summary?.problems?.n) line.problems = summary.problems;
  if (summary?.norm?.n) line.norm = summary.norm;
  if (summary?.warn?.n) line.warn = summary.warn;
  if (times) {
    if (Object.keys(times.t ?? {}).length) line.t = times.t;
    if (times.agent) line.agent = times.agent;
    if (times.kernel) line.kernel = times.kernel;
  }
  if (args && Object.keys(args).length) line.args = args;
  line.answer = { chars, paged: paged === true, scan: summary?.scan ?? 'skipped' };
  return line;
}
