// The ssam-quality/1 line contract (C:\t\qual\DESIGN-QUALIDADE.md, section 2). One module, copied verbatim by both lanes:
//   SERVER  -> platforms/odc/facade/quality-line.mjs   (the writer builds every line through fitLine, tests use sanitize)
//   CONSOLE -> server/deploy/console/quality-line.mjs  (the reader passes every line through sanitizeQualityLine)
// A parity test in each lane checks that its copy has the same sha256 as the other (the integrator compares them).
// Pure: no I/O, no Date.now, node built-ins only. Every value that leaves here is a code, an enum word, a count, a
// duration, a timestamp, the token id or the customer label. Anything else is dropped, never repaired into content.

export const SCHEMA = 'ssam-quality/1';
export const MAX_LINE_BYTES = 4096;          // hard cap per line, UTF-8, newline included
export const MAX_MS = 86_400_000;            // 24 h: any duration above is clamped
export const MAX_COUNT = 1_000_000;          // any count above is clamped
export const MAX_BYTES = 1_099_511_627_776;  // 1 TiB: byte counters above are clamped
export const MAX_CODES = 32;                 // distinct problem codes per line (the rest folds into OTHER_CODES)
export const MAX_RULES = 16;                 // distinct normalization rules per line (the rest folds into OTHER_RULES)
export const MAX_TOP = 6;                    // agent.top entries
export const OTHER_CODES = 'OTHER_CODES';
export const OTHER_RULES = 'OTHER_RULES';
export const NATIVE_UNLISTED = 'NATIVE_UNLISTED';

// ---- identifier patterns (the allowlist of the owner's decision of 2026-10-12)
export const TOKEN = /^tok_[0-9a-f]{12}$/;
export const SESSION = /^[0-9a-f]{12}$/;
export const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
// Product codes: UPPER_SNAKE, 2..64 characters (PREFLIGHT_REFUSED, EXPR_UNKNOWN_IDENTIFIER, SORT_KEYS_SPLIT, RPC_32603).
export const SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
// Native verification ids of the Studios (ExpressionUnknownObject, UnusedElement, InvalidResourceURL_Offline). They look
// like element names (GetColaboradorAtual has the same shape), so a writer AND a reader keep one only when it is in the
// kernel's verify catalogs (opts.nativeIds, loadNativeIds below); any other, or any at all without the catalogs, becomes
// NATIVE_UNLISTED (fail closed).
export const NATIVE = /^[A-Z][a-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;
// Verbs: the op of a multi-verb tool (closed per tool, see VERB_FIELDS in the design) and the bridge method / pipe command
// of an agent call.
export const VERB = /^[a-z][a-z0-9_-]{0,47}$/;
export const AGENT_KINDS = ['studio.processes', 'odc.pipe', 'odc.attach', 'o11.bridge', 'o11.connect', 'o11.selected',
  'file.put', 'file.get', 'file.list', 'file.sync', 'net.probe', 'kernel'];
// The protocol verbs an agent label may name, closed per kind: the lists the customer's agent enforces (agent/lib/kinds.mjs
// ODC_COMMANDS and O11_METHODS; the server lane's drift test compares them). The shape (VERB) is not enough: the command of
// studio_command is the model's own text, and a lowercase app or module name is a verb by shape. Any other kind has no verb.
export const ODC_COMMANDS = Object.freeze(['status', 'wait', 'authorize', 'open', 'snapshot', 'latest', 'check-base', 'preview', 'merge',
  'publish', 'publish-status', 'publish-log', 'dismiss-dialog', 'close', 'module-info', 'assets', 'consumers', 'create', 'create-app',
  'templates', 'template-download', 'refresh-references', 'reference-snapshot', 'reference-producers', 'data', 'data-insert', 'data-update',
  'data-delete', 'portal-call', 'portal-session', 'auth-status', 'stop', 'query-test']);
export const O11_METHODS = Object.freeze(['ping', 'bridge_manifest', 'get_active_module', 'list_open_modules', 'get_errors', 'open_module',
  'close_module', 'publish', 'windows', 'ui_alive', 'close_dialog', 'snapshot_module', 'merge_from_oml', 'merge_status',
  'environment_session', 'sc_api', 'sc_web', 'sc_http', 'studio_login', 'sc_session', 'publish_log', 'refresh_references',
  'answer_dependencies_dialog']);
export const AGENT_VERBS = Object.freeze({ 'odc.pipe': ODC_COMMANDS, 'o11.bridge': O11_METHODS });

// ---- closed word lists
export const KINDS = ['call', 'session'];
export const LANES = ['o11', 'odc'];
export const CLASSES = ['ok', 'delivered', 'refused', 'uncertain', 'failed', 'protocol'];
export const DELIV = ['entregue', 'entregue-publicado', 'criado'];
// The steps the friction store knows (facade/friction-store.mjs STEPS) plus start.
export const STEPS = ['snapshot', 'build', 'manifest', 'check-base', 'preview', 'merge', 'publish', 'validation', 'equivalence', 'preflight',
  'apply', 'verify', 'reconcile', 'refresh-references', 'relay', 'connect', 'data', 'debug', 'service-center', 'authentication', 'start'];
export const PHASES = ['preflight', 'base', 'apply', 'verify', 'other'];
// Where the time of a call went (ms). Sum of every key but kernel = ms (agent categories may overlap a little).
export const T_KEYS = ['queue', 'capture', 'kernel', 'kernelOwn', 'studio', 'verify', 'publish', 'environment', 'transfer', 'network', 'rest'];
export const CLIENTS = ['claude-code', 'claude-ai', 'claude-desktop', 'codex', 'cursor', 'vscode', 'windsurf', 'other', 'unknown'];
export const EVENTS = ['opened', 'closed'];
export const REASONS = ['client-delete', 'idle', 'transport-closed', 'replaced', 'token-revoked', 'token-expired', 'token-unknown', 'server-stop', 'other'];
export const JOB_FORMS = ['inline', 'inline-text', 'ws', 'agent', 'other'];
export const UNTIL = ['snapshot', 'build', 'check-base', 'preview', 'apply', 'merge'];
export const SCANS = ['full', 'wire', 'skipped', 'error'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const int = (v, max) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : null);
const iso = v => typeof v === 'string' && v.length <= 30 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
const word = (v, list) => (typeof v === 'string' && list.includes(v) ? v : null);
const bool = v => (typeof v === 'boolean' ? v : null);
// The customer label (the owner's name for the license): control characters become spaces, at most 64 characters.
const label = v => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) || null : null);

// A code as the line keeps it: SNAKE; a native id only when nativeIds has it (else NATIVE_UNLISTED); anything else null.
export function codeOf(value, { nativeIds = null } = {}) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 64) return null;
  if (SNAKE.test(value)) return value;
  if (NATIVE.test(value)) return nativeIds?.has(value) ? value : NATIVE_UNLISTED;
  return null;
}
// The native ids of the kernel's verify catalogs: every `id` of <catalogDir>/verify-messages-*.json,
// <catalogDir>/verify-hints-*.json and <catalogDir>/odc/verify-messages-*.json (arrays of {id, ...}). readDir and readFile
// are injected (node:fs in both lanes) so this module stays pure. An empty Set when nothing is readable (fail closed).
export function loadNativeIds(catalogDir, { readDir, readFile, join = (...p) => p.join('/') }) {
  const ids = new Set();
  for (const sub of ['', 'odc']) {
    let names = [];
    try { names = readDir(sub ? join(catalogDir, sub) : catalogDir); } catch { continue; }
    for (const name of names) {
      if (!/^verify-(messages|hints)-[\d.]+\.json$/.test(name)) continue;
      try {
        const list = JSON.parse(String(readFile(sub ? join(catalogDir, sub, name) : join(catalogDir, name))).replace(/^﻿/, ''));
        for (const e of Array.isArray(list) ? list : []) if (typeof e?.id === 'string' && NATIVE.test(e.id) && e.id.length <= 64) ids.add(e.id);
      } catch { /* an unreadable catalog adds nothing */ }
    }
  }
  return ids;
}
export const verbOf = value => (typeof value === 'string' && VERB.test(value) ? value : null);
// The verb of an agent call when its kind's closed list (AGENT_VERBS) has it, else null.
export const agentVerbOf = (kind, value) => (typeof value === 'string' && Object.hasOwn(AGENT_VERBS, kind) && AGENT_VERBS[kind].includes(value) ? value : null);
// "kind" or "kind:verb" (the verb from AGENT_VERBS only); anything else null.
export function agentLabel(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const [kind, verb, extra] = value.split(':');
  if (extra !== undefined || !AGENT_KINDS.includes(kind)) return null;
  return verb === undefined ? kind : agentVerbOf(kind, verb) ? kind + ':' + verb : null;
}

// A {code: count} map: valid codes only, counts clamped, at most max keys (the biggest stay; the rest folds into other).
export function countMap(value, { max, other, key = codeOf, nativeIds = null } = {}) {
  if (!isObj(value)) return null;
  const entries = [];
  for (const [k, v] of Object.entries(value)) {
    const name = key === codeOf ? codeOf(k, { nativeIds }) : key(k);
    const n = int(v, MAX_COUNT);
    if (name && n) entries.push([name, n]);
  }
  const merged = new Map();
  for (const [k, n] of entries) merged.set(k, Math.min(MAX_COUNT, (merged.get(k) ?? 0) + n));
  const sorted = [...merged].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const out = {};
  if (max && sorted.length > max) {
    for (const [k, n] of sorted.slice(0, max - 1)) out[k] = n;
    out[other] = Math.min(MAX_COUNT, sorted.slice(max - 1).reduce((s, [, n]) => s + n, 0) + (out[other] ?? 0));
  } else for (const [k, n] of sorted) out[k] = n;
  return Object.keys(out).length ? out : null;
}

function problemsOf(p, opts) {
  if (!isObj(p)) return null;
  const byCode = countMap(p.byCode, { max: MAX_CODES, other: OTHER_CODES, nativeIds: opts.nativeIds });
  // withPatch: per code, how many of its problems came with a certain patch (the engine already knew the fix).
  const withPatch = countMap(p.withPatch, { max: MAX_CODES, other: OTHER_CODES, nativeIds: opts.nativeIds });
  const byPhase = countMap(p.byPhase, { key: k => word(k, PHASES) });
  const n = int(p.n, MAX_COUNT);
  if (n === null) return null;
  return { n, err: int(p.err, MAX_COUNT) ?? 0, warn: int(p.warn, MAX_COUNT) ?? 0, ...(byCode ? { byCode } : {}), ...(withPatch ? { withPatch } : {}),
    ...(byPhase ? { byPhase } : {}), cut: p.cut === true };
}
function normOf(v, opts) {
  if (!isObj(v)) return null;
  const n = int(v.n, MAX_COUNT);
  const byRule = countMap(v.byRule, { max: MAX_RULES, other: OTHER_RULES, nativeIds: opts.nativeIds });
  return n === null ? null : { n, ...(byRule ? { byRule } : {}) };
}
function timesOf(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of T_KEYS) { const n = int(v[k], MAX_MS); if (n) out[k] = n; }
  return Object.keys(out).length ? out : null;
}
function agentOf(v) {
  if (!isObj(v)) return null;
  const n = int(v.n, MAX_COUNT);
  if (n === null) return null;
  const top = (Array.isArray(v.top) ? v.top : []).slice(0, MAX_TOP).map(e => (Array.isArray(e) && e.length === 3 ? [agentLabel(e[0]), int(e[1], MAX_COUNT), int(e[2], MAX_MS)] : null))
    .filter(e => e && e[0] && e[1] !== null && e[2] !== null);
  return { n, failed: int(v.failed, MAX_COUNT) ?? 0, ...(int(v.bytes, MAX_BYTES) ? { bytes: int(v.bytes, MAX_BYTES) } : {}),
    shared: v.shared === true, ...(v.approx === true ? { approx: true } : {}), ...(top.length ? { top } : {}) };
}
function kernelOf(v) {
  if (!isObj(v)) return null;
  const runs = int(v.runs, MAX_COUNT);
  return runs ? { runs, cold: int(v.cold, MAX_COUNT) ?? 0, worker: int(v.worker, MAX_COUNT) ?? 0, ms: int(v.ms, MAX_MS) ?? 0 } : null;
}
function argsOf(v) {
  if (!isObj(v)) return null;
  const out = {};
  if (word(v.job, JOB_FORMS)) out.job = v.job;
  for (const k of ['basedOn', 'partial', 'closePrevious', 'publish']) if (v[k] === true) out[k] = true;
  if (int(v.patch, MAX_COUNT) !== null) out.patch = int(v.patch, MAX_COUNT);
  if (word(v.until, UNTIL)) out.until = v.until;
  if (int(v.bytes, MAX_BYTES)) out.bytes = int(v.bytes, MAX_BYTES);
  return Object.keys(out).length ? out : null;
}
function answerOf(v) {
  if (!isObj(v)) return null;
  return { chars: int(v.chars, MAX_BYTES) ?? 0, paged: v.paged === true, scan: word(v.scan, SCANS) ?? 'wire' };
}

// The line as the contract allows it, or null when its frame is invalid (schema, kind, time, token, session). opts:
//   nativeIds: Set of native verification ids (the writer always passes it; a reader may), tools: Set of tool names
//   (the writer passes the hosted catalog; null = shape only).
export function sanitizeQualityLine(value, opts = {}) {
  if (!isObj(value) || value.schema !== SCHEMA) return null;
  const kind = word(value.kind, KINDS);
  const time = iso(value.time);
  const token = typeof value.token === 'string' && TOKEN.test(value.token) ? value.token : null;
  const session = typeof value.session === 'string' && SESSION.test(value.session) ? value.session : null;
  if (!kind || !time || !token || !session) return null;
  const head = { schema: SCHEMA, kind, time, token, ...(label(value.customer) ? { customer: label(value.customer) } : {}), session };
  if (kind === 'session') {
    const event = word(value.event, EVENTS);
    if (!event) return null;
    return { ...head, event, client: word(value.client, CLIENTS) ?? 'unknown',
      ...(event === 'closed' ? { reason: word(value.reason, REASONS) ?? 'other', calls: int(value.calls, MAX_COUNT) ?? 0, openMs: int(value.openMs, MAX_MS * 30) ?? 0 } : {}) };
  }
  const call = int(value.call, MAX_COUNT);
  const ms = int(value.ms, MAX_MS);
  const ok = bool(value.ok);
  const toolName = typeof value.tool === 'string' && TOOL.test(value.tool) && (!opts.tools || opts.tools.has(value.tool)) ? value.tool : '?';
  if (!call || ms === null || ok === null) return null;
  const line = { ...head, call, tool: toolName, op: verbOf(value.op), lane: word(value.lane, LANES), ms,
    gapMs: value.gapMs === null ? null : int(value.gapMs, MAX_MS), inFlight: int(value.inFlight, 64) ?? 0,
    ok, code: ok ? null : (codeOf(value.code, opts) ?? 'TOOL_ERROR'), class: word(value.class, CLASSES) ?? (ok ? 'ok' : 'failed'),
    step: word(value.step, STEPS), deliv: word(value.deliv, DELIV) };
  const parts = { problems: problemsOf(value.problems, opts), norm: normOf(value.norm, opts),
    warn: isObj(value.warn) && int(value.warn.n, MAX_COUNT) ? { n: int(value.warn.n, MAX_COUNT), high: int(value.warn.high, MAX_COUNT) ?? 0 } : null,
    t: timesOf(value.t), agent: agentOf(value.agent), kernel: kernelOf(value.kernel), args: argsOf(value.args), answer: answerOf(value.answer) };
  for (const [k, v] of Object.entries(parts)) if (v) line[k] = v;
  if (value.trunc === true) line.trunc = true;
  return line;
}

// The writer's last step: the JSON text of a sanitized line within MAX_LINE_BYTES (newline excluded from the text,
// included in the budget). Reductions, in order, each only while the text is still too big: agent.top; problems.byCode
// and norm.byRule to their 8 biggest (the rest folded); args; t; agent; kernel; then the frame only, with trunc.
export function fitLine(line) {
  const size = v => Buffer.byteLength(JSON.stringify(v), 'utf8') + 1;
  let v = structuredClone(line);
  if (size(v) <= MAX_LINE_BYTES) return JSON.stringify(v);
  v.trunc = true;
  const steps = [
    x => { if (x.agent) delete x.agent.top; },
    x => { if (x.problems?.byCode) x.problems.byCode = countMap(x.problems.byCode, { max: 8, other: OTHER_CODES }) ?? undefined;
      if (x.problems?.withPatch) x.problems.withPatch = countMap(x.problems.withPatch, { max: 8, other: OTHER_CODES }) ?? undefined; },
    x => { if (x.norm?.byRule) x.norm.byRule = countMap(x.norm.byRule, { max: 8, other: OTHER_RULES }) ?? undefined; },
    x => { delete x.args; }, x => { delete x.t; }, x => { delete x.agent; }, x => { delete x.kernel; },
  ];
  for (const step of steps) { step(v); if (size(v) <= MAX_LINE_BYTES) return JSON.stringify(v); }
  const frame = Object.fromEntries(['schema', 'kind', 'time', 'token', 'customer', 'session', 'call', 'tool', 'op', 'lane', 'ms', 'gapMs',
    'inFlight', 'ok', 'code', 'class', 'step', 'deliv'].filter(k => k in v).map(k => [k, v[k]]));
  frame.trunc = true;
  return JSON.stringify(frame);
}
