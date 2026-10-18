// Tool responses that keep the model inside the MCP. Pure (no I/O, no clock, no state): the ssam server passes every
// tool answer through `shapeToolResult` (or `rewriteHints` + `compactDelivery`) before it reaches the model.
//
// rewriteHints: texts written for a terminal (the kernel's DialogPolicy/MergeHandler hints, `see anvil api --name X`,
// `.\ssam inspect --lane o11 ...`, `dotnet build ...`, `pwsh -File ...credential.ps1 -Mode bootstrap`) send the model
// out of the MCP, to a shell, and cost several steps each (measured: p90 of 43 steps per request). Each recognized
// command becomes the MCP call that does the same thing, written in the text (`tool {arg:"value"}`) and returned as a
// continuation {tool, arguments, why}. A command with no MCP equivalent (building a component) becomes ssam_doctor,
// with the reason: the integrator or the user builds it, never the session.
// compactDelivery: a merged, strictly equal studio_deliver answers `entregue`; a refusal keeps only what the model
// needs to act (the user's product rule: no report of what changed and where).
// addNextSteps (next-steps.mjs): a success gets `next`, the obvious follow-up reads with arguments from the answer; a
// refusal without continuation gets the one its code implies. Never a write as `next`, never the user's words.
// withRefusalCode (refusal-codes.mjs, A20 of the 2026-10-06 package): a refusal without a code gets a specific one
// (INPUT_INVALID, DEBUG_<X>, DISCOVERY_INDEX_INVALID, BRIDGE_NOT_ATTACHED, <STEP>_FAILED, <TOOL>_FAILED...); a plain-text
// refusal becomes {ok:false, code, error:<the text>}. The friction store classifies with the same table.
//
// Speed: one literal prefilter per string; strings without a trigger are returned as they are, objects without a
// changed string keep their identity. The command regex has no nested quantifiers; argument scanning is linear.

import { addNextSteps } from './next-steps.mjs';
import { isCode, refusalCode } from './refusal-codes.mjs';
import { RESULT, resultIs, resultValue } from './result-values.mjs';

export const NOT_BUILT_WHY ='component not built: the integrator/user builds it';
const DIALOG_WHY = 'closes only a window with an owner, by its title; a web dialog (recovery, Manage Dependencies): ask the person to answer it in the Studio and repeat';
const PROMPT_WHY = 'the tool opens the private Windows prompt by itself when nothing is stored; the person types there, never in the chat; then repeat the call';

// `tool {key:"value", n:1}`: the notation the tool descriptions already use.
export function formatCall(tool, args = {}) {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  return tool + ' {' + entries.map(([k, v]) => k + ':' + (v !== null && typeof v === 'object' && !Array.isArray(v) ? '{' + Object.entries(v).map(([a, b]) => a + (b === true ? '' : ':' + JSON.stringify(b))).join(', ') + '}' : JSON.stringify(v))).join(', ') + '}';
}

const dialogCall = { tool: 'o11_studio', arguments: { command: 'dismiss-dialog', args: { title: '<dialog title>' } }, why: DIALOG_WHY };
const notBuilt = lane => ({ tool: 'ssam_doctor', arguments: { lane }, why: NOT_BUILT_WHY });
const notBuiltText = lane => formatCall('ssam_doctor', { lane }) + ' (component not built: the integrator or the user builds it)';

// The kernel's dialog hints (DialogPolicy.Hint, MergeHandler) are stamped: whole sentences read better than a
// token-by-token rewrite. Exact text; anything else falls to the generic pass.
const KNOWN = [
  ['`python scripts/cdp_pages.py --click Discard` (or Open) and retry', 'ask the person to click Discard (or Open) in the Studio, then retry'],
  ['`python scripts/cdp_pages.py` shows its buttons; `--click "Manage Dependencies"` then Apply updates the references, `--click Cancel` opens without updating; then retry',
    'ask the person to choose in the Studio: Manage Dependencies then Apply updates the references, Cancel opens without updating; then retry'],
  ['`python scripts/cdp_pages.py` lists its text and buttons; `--click <Button>` answers it', 'ask the person to read and answer it in the Studio'],
  ['read it with `windows` or `python scripts/cdp_pages.py`, answer it, and retry',
    'read it with o11_studio {command:"windows"}; close an owned window with o11_studio {command:"dismiss-dialog", args:{title}} or ask the person to answer it in the Studio, then retry'],
  ['(see `windows` / `python scripts/cdp_pages.py`)', '(o11_studio {command:"windows"} lists it; a web dialog is answered by the person in the Studio)'],
];

// Literal triggers: a string without any of them is never scanned further.
const PREFILTER = /cdp_pages|anvil|api --|ssam(?:\.cmd)? |odc(?:\.cmd)? |dotnet build|build\.py|build_odc|anvil_worker|run_job\.py|credential\.ps1/;
const HEAD = new RegExp([
  String.raw`(?<cdp>(?:(?:python3?|py)\s+)?(?:\.[\\/]{1,2})?(?:kernel[\\/]{1,2})?scripts[\\/]{1,2}cdp_pages\.py)`,
  String.raw`(?<script>(?:(?:python3?|py)\s+)?(?:\.[\\/]{1,2})?(?:kernel[\\/]{1,2})?scripts[\\/]{1,2}(?:build|build_odc|anvil_worker)\.py|\bbuild_odc\.py)`,
  String.raw`(?<runjob>(?:(?:python3?|py)\s+)?(?:\.[\\/]{1,2})?(?:kernel[\\/]{1,2})?scripts[\\/]{1,2}run_job\.py)`,
  String.raw`(?<anvil>\banvil(?:\.dll)?\s+(?:functions|api|signature)\b)`,
  String.raw`(?<api>(?<![\w-])api(?=\s+--(?:name|op)\b))`,
  String.raw`(?<ssam>(?:\.[\\/]{1,2})?\bssam(?:\.cmd)?\s+(?:inspect|deliver|connect|discover|app|job|map|prototype)\b)`,
  String.raw`(?<odc>(?:\.[\\/]{1,2})?\bodc(?:\.cmd)?\s+(?:attach|deliver|inspect|discover|app|build|studio\s+[a-z][a-z-]{1,40}|portal\s+internal-routes)\b)`,
  String.raw`(?<dotnet>\bdotnet\s+build\b)`,
  String.raw`(?<cred>windows-(?:api-client|o11)-credential\.ps1)`,
].join('|'), 'g');

const STOP = new Set(['and', 'or', 'then', 'to', 'in', 'into', 'before', 'after', 'first', 'again', 'the', 'a', 'an', 'for', 'with', 'if',
  'when', 'on', 'of', 'is', 'are', 'it', 'its', 'that', 'which', 'shows', 'lists', 'answers', 'opens', 'updates', 'see', 'run', 'retry', 'from',
  'e', 'ou', 'depois', 'antes', 'para', 'com', 'no', 'na', 'em', 'do', 'da', 'de', 'o', 'os', 'as', 'um', 'uma']);
const DELIM = new Set([';', '`', ')', '(', '\n', '\r']);
// Script heads whose folder and interpreter come before the name.
const SCRIPTS = new Set(['cred', 'script', 'runjob', 'cdp']);
const PS_BEFORE = /(?:&\s*)?(?:"[^"\r\n]{0,260}"|[^\s`'"()]{0,260}?(?:pwsh|powershell)(?:\.exe)?)\s+(?:-NoProfile\s+)?(?:-ExecutionPolicy\s+\S{1,20}\s+)?-File\s+$/i;
const PY_BEFORE = /(?:&\s*)?(?:"[^"\r\n]{0,260}?python3?(?:\.exe)?"|[^\s`'"()]{0,260}?\bpython3?(?:\.exe)?|\bpy)\s+$/i;
const SPACE = new Set([' ', '\t']);
const NUMERIC = new Set(['offset', 'max', 'depth', 'budget', 'budgetBytes', 'limit', 'pid', 'minutes', 'timeoutSeconds']);

// One token at j: a quoted value, a <placeholder> (it may hold `|`), an [optional group] of a usage line, or a run of
// characters up to whitespace or a delimiter. Trailing sentence punctuation is not part of the token.
function readToken(s, j) {
  const c = s[j];
  if (c === '"' || c === "'") {
    const k = s.indexOf(c, j + 1);
    if (k < 0 || k - j > 600 || /[\r\n]/.test(s.slice(j + 1, k))) return null;
    return { text: s.slice(j + 1, k), next: k + 1, end: k + 1, quoted: true };
  }
  if (c === '[') {
    const k = s.indexOf(']', j + 1);
    if (k < 0 || k - j > 300 || /[\r\n]/.test(s.slice(j + 1, k))) return null;
    return { text: s.slice(j, k + 1), next: k + 1, end: k + 1, optional: true };
  }
  let k = j;
  while (k < s.length && !SPACE.has(s[k]) && !DELIM.has(s[k])) {
    if (s[k] === '<') { const close = s.indexOf('>', k + 1); if (close > k && close - k <= 200 && !/[\s`]/.test(s.slice(k + 1, close).replace(/ /g, ''))) { k = close + 1; continue; } }
    k++;
  }
  if (k === j) return null;
  let end = k; let sentenceEnd = false;
  while (end > j + 1 && /[.,:;!?]/.test(s[end - 1]) && (k === s.length || SPACE.has(s[k]) || DELIM.has(s[k]))) { end--; sentenceEnd = true; }
  return { text: s.slice(j, end), next: k, end, sentenceEnd };
}

// The arguments after a command head: flags (with their values), positionals up to the command's count, optional
// groups (consumed, ignored). Scanning stops at a delimiter, at a word that is not an argument (a stop word, a
// positional beyond the count) or at the end of a sentence. `end` is where the command text ends.
function scanArgs(s, from, spec = {}) {
  const flags = {}; const positionals = []; let i = from, end = from, pending = null;
  const set = (name, value) => { (flags[name] ??= []).push(value); };
  for (;;) {
    let j = i;
    while (j < s.length && (SPACE.has(s[j]) || (s[j] === '\\' && (s[j + 1] === '\n' || s[j + 1] === '\r')))) j += s[j] === '\\' ? (s[j + 1] === '\r' && s[j + 2] === '\n' ? 3 : 2) : 1;
    if (j === i || j >= s.length || DELIM.has(s[j])) break;
    const t = readToken(s, j);
    if (!t) break;
    let accepted = true;
    if (t.optional) { /* usage synopsis: [--kind K] */ }
    else if (!t.quoted && /^--?[A-Za-z]/.test(t.text)) {
      if (pending) set(pending, true);
      let name = t.text.replace(/^-+/, ''); let value;
      const eq = name.indexOf('='); if (eq > 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
      if (name.includes('|')) { for (const alt of name.split('|')) { const n = alt.replace(/^-+/, ''); if (n) set(n, '<' + n + '>'); } pending = null; }
      else if (value !== undefined) { set(name, value); pending = null; }
      else if (spec.bool?.has(name)) { set(name, true); pending = null; }
      else pending = name;
    } else if (pending) {
      if (!t.quoted && STOP.has(t.text.toLowerCase())) accepted = false;
      else { set(pending, t.text); pending = null; }
    } else if (positionals.length < (spec.positional ?? 0) && (t.quoted || (!STOP.has(t.text.toLowerCase()) && /[A-Za-z0-9<]/.test(t.text)))
      && (!spec.posTest || spec.posTest(t.text))) positionals.push(t.text);
    else accepted = false;
    if (!accepted) break;
    i = t.next; end = t.end;
    if (t.sentenceEnd) break;
  }
  if (pending) set(pending, true);
  return { flags, positionals, end };
}

const one = (flags, ...names) => { for (const n of names) { const v = flags[n]; if (v?.length) return v[v.length - 1]; } return undefined; };
const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const value = (key, v) => (NUMERIC.has(key) && typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
// Flags as arguments: kebab-case to camelCase, numbers for numeric keys, repeated flags (select) as arrays.
function argsFrom(flags, { skip = [], rename = {}, arrays = [] } = {}) {
  const out = {};
  for (const [name, values] of Object.entries(flags)) {
    if (skip.includes(name)) continue;
    const key = rename[name] ?? camel(name);
    out[key] = arrays.includes(name) ? values.filter(v => v !== true) : value(key, values[values.length - 1]);
  }
  return out;
}
const INSPECT_BOOL = new Set(['usages', 'all', 'full', 'cold', 'include-internal']);
const inspectArgs = flags => argsFrom(flags, { skip: ['lane', 'oml', 'ss-dir'], arrays: ['select'] });
const hostOf = origin => (typeof origin === 'string' ? origin.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') : undefined);

// head text -> { spec, build(args, ctx) -> {tool, arguments, text?, why?} | null }
function commandFor(group, head, opts) {
  const lane = opts.lane ?? 'o11';
  if (group === 'cdp') return { spec: {}, build: a => {
    const click = one(a.flags, 'click');
    return { ...dialogCall, text: typeof click === 'string' ? 'ask the person to click "' + click + '" in the Studio' : 'ask the person to answer the dialog in the Studio, or close an owned window with o11_studio {command:"dismiss-dialog", args:{title}}' };
  } };
  if (group === 'script') {
    const which = /build_odc/.test(head) ? 'odc' : /anvil_worker/.test(head) ? 'worker' : 'build';
    return { spec: { positional: which === 'worker' ? 1 : 0, posTest: t => /^(restart|start|stop|status)$/.test(t) }, build: () => {
      const l = which === 'odc' ? 'odc' : lane; return { ...notBuilt(l), text: notBuiltText(l) };
    } };
  }
  if (group === 'runjob') return { spec: { positional: 1 }, build: a => ({ tool: 'ssam_job', arguments: { lane: one(a.flags, 'lane') ?? lane,
    job: a.positionals[0] ?? '<job.json>', ...(typeof one(a.flags, 'base') === 'string' ? { base: one(a.flags, 'base') } : {}), ...(typeof one(a.flags, 'out') === 'string' ? { out: one(a.flags, 'out') } : {}) } }) };
  if (group === 'dotnet') return { spec: { positional: 1, posTest: t => /[\\/.]/.test(t) }, build: (a, span) => {
    const l = /odc|studio[\\/]/i.test(span) ? 'odc' : lane; return { ...notBuilt(l), text: notBuiltText(l) };
  } };
  if (group === 'cred') return { spec: {}, build: a => /o11/.test(head)
    ? { tool: 'o11_service_center_session', arguments: { action: 'sign-in', ...(one(a.flags, 'Host', 'host') ? { host: one(a.flags, 'Host', 'host') } : {}) }, why: PROMPT_WHY,
        textSuffix: ' (opens the private Windows prompt when nothing is stored; the person types there, never in chat)' }
    : { tool: 'odc_read', arguments: { tenant: hostOf(one(a.flags, 'Origin', 'origin')) ?? '<tenant>', auth: 'api-client' }, why: PROMPT_WHY,
        textSuffix: ' (opens the private Windows prompt itself when no credential is stored; the person types there, never in chat)' } };
  if (group === 'anvil' || group === 'api') {
    const verb = group === 'api' ? 'api' : head.split(/\s+/).pop();
    if (verb === 'signature') return { spec: { positional: 1 }, build: a => ({ tool: 'o11_job',
      arguments: { job: '<job.json>', captureProducers: [one(a.flags, 'producer', 'module', 'name') ?? a.positionals[0] ?? '<Producer>'].map(String) },
      why: 'the producer signature is captured by o11_job (captureProducers), read-only, through the signed-in Studio' }) };
    if (verb === 'functions') return { spec: { positional: 1 }, build: a => ({ tool: 'ssam_reference',
      arguments: { lane, kind: 'functions', query: one(a.flags, 'find', 'name') ?? a.positionals[0] ?? '<name>' }, why: 'built-in function catalog of the lane' }) };
    return { spec: {}, build: a => {
      const name = one(a.flags, 'name'); const op = one(a.flags, 'op');
      if (group === 'api' && name === undefined && typeof op !== 'string') return null; // `api --op` named as a source, not a call
      return { tool: 'ssam_reference', arguments: { lane, kind: 'api', query: typeof name === 'string' ? name : typeof op === 'string' ? { op } : '<Interface>' },
        why: 'contract of the Model API / of the kernel ops of the lane' };
    } };
  }
  const [, verbRaw] = /^(?:\.[\\/]{1,2})?(?:ssam|odc)(?:\.cmd)?\s+(.+)$/.exec(head) ?? [];
  const verb = (verbRaw ?? '').replace(/\s+/g, ' ');
  if (group === 'ssam') {
    switch (verb) {
      case 'inspect': return { spec: { positional: 2, bool: INSPECT_BOOL }, build: a => inspectCall(one(a.flags, 'lane') ?? lane, a) };
      case 'deliver': return { spec: { positional: 1 }, build: a => {
        const l = one(a.flags, 'lane') ?? lane;
        if (l === 'odc') return { tool: 'studio_deliver', arguments: { feature: a.positionals[0] ?? one(a.flags, 'feature') ?? '<feature>', ...argsFrom(a.flags, { skip: ['lane', 'feature'] }) } };
        const checks = one(a.flags, 'checks');
        return { tool: 'o11_deliver', arguments: { module: one(a.flags, 'module') ?? '<module>', job: one(a.flags, 'job') ?? '<job.json>',
          ...(typeof checks === 'string' ? { checks: checks.split(',').map(x => x.trim()).filter(Boolean) } : {}), authorize: "<the user's own words>" } };
      } };
      case 'connect': return { spec: {}, build: a => ({ tool: 'ssam_connect', arguments: { lane: one(a.flags, 'lane') ?? lane } }) };
      case 'discover': return { spec: { positional: 12, bool: new Set(['rebuild']) }, build: a => ({ tool: 'ssam_discover', arguments: discoverArgs(a, lane) }) };
      case 'app': return { spec: { positional: 2 }, build: a => ({ tool: 'ssam_app_url', arguments: appArgs(a) }) };
      case 'job': return { spec: { positional: 1 }, build: a => ({ tool: 'ssam_job', arguments: { lane: one(a.flags, 'lane') ?? lane, job: a.positionals[0] ?? '<job.json>' } }) };
      case 'map': return { spec: { positional: 1, bool: new Set(['detail']) }, build: a => ({ tool: 'ssam_map', arguments: { lane: one(a.flags, 'lane') ?? lane,
        target: a.positionals[0] ?? '<capture.oml>', ...argsFrom(a.flags, { skip: ['lane'], rename: { budget: 'budgetBytes', detail: 'includeDetail' } }) } }) };
      // The CLI rehearsal of the prototype import: the model makes the one MCP call of the import (docs/PROTOTIPO-NATIVO.md 1.1).
      case 'prototype': return { spec: { positional: 1, bool: new Set(['dry']) }, build: a => {
        const l = one(a.flags, 'lane') ?? lane;
        const job = { ops: [{ op: 'prototype', data: { source: a.positionals[0] ?? '<prototype folder>' } }] };
        const module = typeof one(a.flags, 'module') === 'string' ? one(a.flags, 'module') : '<open module>';
        return l === 'odc' ? { tool: 'studio_deliver', arguments: { module, job, publish: true, authorize: "<the user's own words>" } }
          : { tool: 'o11_deliver', arguments: { module, job, publish: true, authorize: "<the user's own words>" } };
      } };
      default: return null;
    }
  }
  if (group === 'odc') {
    if (verb === 'attach') return { spec: { positional: 1, posTest: t => /^\d+$/.test(t) }, build: a => ({ tool: 'studio_attach', arguments: a.positionals[0] ? { pid: Number(a.positionals[0]) } : {} }) };
    if (verb === 'inspect') return { spec: { positional: 2, bool: INSPECT_BOOL }, build: a => inspectCall('odc', a) };
    if (verb === 'deliver') return { spec: { positional: 1 }, build: a => ({ tool: 'studio_deliver', arguments: { feature: a.positionals[0] ?? '<feature>', ...argsFrom(a.flags) } }) };
    if (verb === 'discover') return { spec: { positional: 12, bool: new Set(['rebuild']) }, build: a => ({ tool: 'ssam_discover', arguments: discoverArgs(a, 'odc') }) };
    if (verb === 'app') return { spec: { positional: 2 }, build: a => ({ tool: 'ssam_app_url', arguments: appArgs(a) }) };
    if (verb === 'build') return { spec: { positional: 4 }, build: a => {
      const [first, ...rest] = a.positionals;
      if (!first || first === 'list') return { tool: 'studio_build', arguments: {} };
      if (first === 'new') return { tool: 'studio_build', arguments: { newModule: true, feature: rest[0] ?? '<feature>', output: rest[1] ?? '<output dir>' } };
      return { tool: 'studio_build', arguments: { feature: first, base: rest[0] ?? '<base.oml>', sha: rest[1] ?? '<sha256>', output: rest[2] ?? '<output dir>' } };
    } };
    if (verb === 'portal internal-routes') return { spec: { positional: 1 }, build: a => ({ tool: 'odc_portal_routes',
      arguments: { ...(one(a.flags, 'tenant') ? { tenant: one(a.flags, 'tenant') } : {}), module: a.positionals[0] ?? '<module>' } }) };
    if (verb.startsWith('studio ')) return { spec: { positional: 3 }, build: () => ({ tool: 'studio_' + verb.slice(7).replace(/-/g, '_'), arguments: {} }) };
  }
  return null;
}
function inspectCall(lane, a) {
  const [first, second] = a.positionals;
  if (lane === 'odc') return { tool: 'studio_inspect', arguments: { target: one(a.flags, 'oml') ?? first ?? '<capture.oml>', ...(second ? { path: second } : {}), ...inspectArgs(a.flags) } };
  return { tool: 'o11_inspect', arguments: { oml: one(a.flags, 'oml') ?? first ?? '<capture.oml>', ...(second ? { path: second } : {}), ...inspectArgs(a.flags) } };
}
const discoverArgs = (a, lane) => ({ ...(a.positionals.length ? { intent: a.positionals.join(' ') } : {}), lane: one(a.flags, 'lane') ?? lane,
  ...argsFrom(a.flags, { skip: ['lane'], rename: { budget: 'budgetBytes' } }) });
const appArgs = a => ({ app: a.positionals[0] ?? '<App>', ...(a.positionals[1] ? { screen: a.positionals[1] } : {}),
  ...argsFrom(a.flags, { skip: ['lane', 'pid'] }) });

// One string: known sentences, then every command head with its arguments. Continuations are collected in `out`.
export function rewriteText(s, opts = {}, out = []) {
  if (typeof s !== 'string' || s.length < 6 || !PREFILTER.test(s)) return s;
  let text = s;
  if (text.includes('cdp_pages')) for (const [from, to] of KNOWN) if (text.includes(from)) { text = text.split(from).join(to); out.push(dialogCall); }
  if (!PREFILTER.test(text)) return text;
  let result = ''; let last = 0; let clicked = false;
  HEAD.lastIndex = 0;
  for (let m = HEAD.exec(text); m; m = HEAD.exec(text)) {
    const group = Object.keys(m.groups).find(k => m.groups[k] !== undefined);
    const head = m[0].trim();
    const command = commandFor(group, head, opts);
    if (!command) continue;
    let args = scanArgs(text, m.index + m[0].length, command.spec);
    let start = m.index; let end = args.end > m.index + m[0].length ? args.end : m.index + m[0].length;
    if (SCRIPTS.has(group)) {
      // The script's own folder before its name (absolute or relative), quoted or not, and the interpreter that runs
      // it (`python`, `"...\python.exe"`, `pwsh -File`, `& "...\pwsh.exe" -NoProfile -File`). Bounded look-behind.
      while (start > last && !/[\s`'"()]/.test(text[start - 1])) start--;
      if (start > last && text[start - 1] === '"' && text[end] === '"') { start--; end++; args = scanArgs(text, end, command.spec); if (args.end > end) end = args.end; }
      const before = (group === 'cred' ? PS_BEFORE : PY_BEFORE).exec(text.slice(Math.max(last, start - 320), start));
      if (before) start -= before[0].length;
    }
    if (start < last) continue;
    if (start > last && end < text.length && /[`'"]/.test(text[start - 1]) && text[end] === text[start - 1]) { start--; end++; }
    if (group === 'cdp') { const w = /`?windows`?\s+(?:\/|or)\s+$/.exec(text.slice(Math.max(last, start - 24), start)); if (w) start -= w[0].length; clicked = true; }
    const span = text.slice(start, end);
    const call = command.build(args, span);
    if (!call) continue;
    let prefix = text.slice(last, start);
    prefix = prefix.replace(/\b([Rr])un:?\s+$/, (_, r) => (r === 'R' ? 'Call ' : 'call '));
    result += prefix + (call.text ?? formatCall(call.tool, call.arguments) + (call.textSuffix ?? ''));
    last = end;
    out.push({ tool: call.tool, arguments: call.arguments, ...(call.why ? { why: call.why } : {}) });
    HEAD.lastIndex = Math.max(HEAD.lastIndex, end);
  }
  text = result + text.slice(last);
  // A dialog line names its buttons as separate `--click X` fragments.
  if (clicked || s.includes('cdp_pages')) text = text.replace(/`--click\s+(?:"([^"`\r\n]{1,80})"|([^\s`]{1,80}))`/g, (_, q, w) => 'click "' + (q ?? w) + '" in the Studio');
  return text;
}

// Every string inside the value (objects, arrays), copied only where something changed. Keys are not rewritten.
export function rewriteHints(value, opts = {}) {
  const found = [];
  const done = new Map(); // an object reached twice (or a cycle) is shaped once
  const walk = v => {
    if (typeof v === 'string') return rewriteText(v, opts, found);
    if (!v || typeof v !== 'object') return v;
    if (done.has(v)) return done.get(v);
    done.set(v, v);
    let copy = null;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = walk(v[i]); if (r !== v[i]) (copy ??= v.slice())[i] = r; } }
    else for (const k of Object.keys(v)) { const r = walk(v[k]); if (r !== v[k]) (copy ??= { ...v })[k] = r; }
    if (copy) done.set(v, copy);
    return copy ?? v;
  };
  const rewritten = walk(value);
  const keys = new Set(); const continuations = [];
  for (const c of found) { const key = c.tool + JSON.stringify(c.arguments); if (!keys.has(key)) { keys.add(key); continuations.push(c); } }
  return { value: rewritten, continuations };
}

// ---- studio_deliver: `entregue` when merged and strictly equal; a refusal keeps what the model acts on.
const TIMING = ['steps', 'totalSeconds', 'elapsedMs', 'timings'];
const withoutTiming = v => { const out = { ...v }; for (const k of TIMING) delete out[k]; return out; };
function validationErrors(v) {
  const from = x => (Array.isArray(x) ? x : x && typeof x === 'object' ? x.errors ?? x.addedErrors ?? x.newErrors ?? null : null);
  for (const candidate of [v.validationErrors, from(v.validation), from(v.refusal?.validation), v.receipt?.addedErrors, v.refusal?.addedErrors])
    if (Array.isArray(candidate) && candidate.length) return candidate;
  return null;
}
// What a refused job delivery is corrected from (the job, its hash, the op that failed, the job it was patched from, the
// basedOn of the next call, what a partial job merged): kept as given, top level first, else from the raw refusal.
const CORRECTION = ['job', 'jobSha256', 'jobShape', 'failedOp', 'basedOn', 'nextBasedOn', 'partial', 'patchByNameOmitted', 'verifiedPatch'];
// What a delivered job keeps for the next call (lane "patch por nome"): the basedOn of the job it used and what a partial
// job merged.
// summary (job-summary.mjs, 2026-10-12): what the delivered job created or changed, so no map of the module follows it;
// normalizations (kernel JobNormalizer, 2026-10-12): what the kernel rewrote in the job instead of refusing it, never silent.
const NEXT = ['nextBasedOn', 'partial', 'summary', 'normalizations'];
// The shared fields of a deliver/publish answer (contract of the 2026-10-05 package, section 3.2): kept exactly on a
// success. `result` "entregue e publicado" says the publish ran in the same call; `publish` carries its outcome;
// `lastPublication`, `leftovers` (what the job declared to pass the gate) and `screenRoles` (who can open each screen the
// job touched) are what the person is told; `authorization` says a standing grant was used. Each is small (~1 KB in all).
// `integration` (contract I7 of docs/INTEGRACOES-GITSSAM.md): what each rest/rest-expose/soap op of the job imported,
// skipped, updated, removed and broke, at most 10 reports plus integrationTotal.
// `warnings` (interface I9 of the 2026-10-06 package, A03): the new Verify warnings that did not block the delivery, each
// {id, path, key?, detail, fix, count?}, at most 20 entries; kept on "entregue" and on a refusal alike. In o11_deliver
// (delivery-warnings.mjs warningFields) equal ones, the same id on the same element (its ownerKey, else its path), come
// once with `count` (only when more than one; a HIGH one never merges), and `warningsTotal`, the number of every warning,
// comes only when the entries shown, their counts summed, do not count them all.
// `queue` (A08, studio-write-lock.mjs): a delivery that waited its turn in the Studio write queue, {position, waitedMs,
// holder: {tool, pid, startedAt}}.
// `equivalence`, `normalized`, `normalizedTotal` (interface I8 of the atritos 3 package, C16 of lane mb): a merge whose
// only differences are normalizations the Studio applies itself (CustomNameTrio, RefreshMaxRecordsRemoved, IconConversion,
// ForcedDeleteRule) is delivered, with each normalized element (at most 20).
// `phases` (lane wp of the atritos 3 package, studio-write-lock.mjs): a delivery that built outside the Studio lock,
// {buildMs, queuedMs, applyMs, buildQueue?, moduleQueue?, rebased?}.
// `highWarnings` (data-access rules of 2026-10-09: QUERY_IN_LOOP legacy/allowed, AGGREGATES_MERGEABLE): complete HIGH warnings;
// the source also puts them first in `warnings`; the output policy removes that duplication. They never block (A03).
// `removed` (ssam_code, 2026-10-12): what an action text or a screen edit of the job removed (the lines and elements it left
// out), at most 20 plus removedTotal; a deletion is never silent.
// `entityActions` (op entity-actions, entity-actions.mjs): the generated standard actions by entity, the unchanged count, the
// kept ones with why, and the notes.
// `preview` (C04, servidor/fase4): the structural preview of the delivered html (preview/fragment.mjs).
export const DELIVERY_FIELDS = ['publish', 'lastPublication', 'leftovers', 'leftoversTotal', 'screenRoles', 'screenRolesTotal', 'authorization', 'integration', 'integrationTotal', 'entityActions',
  'highWarnings', 'warnings', 'warningsTotal', 'queue', 'equivalence', 'normalized', 'normalizedTotal', 'phases', 'preview', 'removed', 'removedTotal',
  // fix/system-reference: a producer taken under the name the Studio lists it by ("System" -> "(System)") says so; a name the
  // consumer session does not offer answers the producers it offers.
  'producerNotes', 'available', 'availableTotal'];
// I8: a refusal that says the merge already reached the Studio (merged:true, uncertain) is read, never delivered again.
const mergedReading = (value, args) => (typeof value.evidence === 'string' && value.evidence
  ? { tool: 'ssam_evidence', arguments: { file: value.evidence.replace(/[\\/]+$/, '') + (/\\/.test(value.evidence) || !/\//.test(value.evidence) ? '\\' : '/') + 'deliver-result.json' }, why: 'the merge is already integrated; read its receipt and do not repeat the delivery' }
  : { tool: 'studio_status', arguments: Number.isInteger(args?.pid) ? { pid: args.pid } : {}, why: 'the merge is already integrated; read the Studio state and do not repeat the delivery' });
const RESULTS = { has: value => resultIs(value, 'delivered', 'deliveredAndPublished') };
const sharedFields = value => Object.fromEntries(DELIVERY_FIELDS.filter(key => value[key] != null).map(key => [key, value[key]]));
// The prototype importer (docs/PROTOTIPO-NATIVO.md 1.4): the receipt (report.prototype as `prototype`) on a success and on
// a refusal after the build; a refusal of the prototype keeps its combined patch, the corrected call, ssamDefect and the
// degraded items. Kept apart from DELIVERY_FIELDS (the shared contract of the 2026-10-05 package).
export const PROTOTYPE_FIELDS = ['prototype', 'patch', 'correctedJob', 'ssamDefect', 'degraded'];
const prototypeFields = value => Object.fromEntries(PROTOTYPE_FIELDS.filter(key => value[key] != null).map(key => [key, value[key]]));
// normalizations (call-shapes.mjs and the job op shapes of ssam-code.mjs normalizeCodeOps): what the call and its job were
// taken to mean, on a delivery and on a refusal alike.
const inputFields = value => Object.fromEntries(['inputAdjusted', 'normalizations', ...(value.code === 'INPUT_INVALID' ? ['violations', 'corrected'] : [])]
  .filter(key => value[key] != null).map(key => [key, value[key]]));
export function compactDelivery(tool, args, value) {
  if (tool !== 'studio_deliver' || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const until = args?.until ?? value.until ?? 'merge';
  if (value.ok === false) {
    const diagnostics = value.diagnostics ?? value.refusal?.diagnostics;
    const errors = validationErrors(value);
    const correction = {};
    for (const key of CORRECTION) { const v = value[key] ?? value.refusal?.[key]; if (v != null) correction[key] = v; }
    const problems = value.problems ?? value.refusal?.problems;
    // The step of the refusal (failed, or the stage of a relay refusal) stays: the friction boundary records it (I9).
    return { ok: false, ...(value.failed ? { failed: value.failed } : typeof value.stage === 'string' ? { stage: value.stage } : {}), error: value.error ?? value.refusal?.error ?? 'delivery refused',
      ...(value.code ? { code: value.code } : {}), ...(value.outcome ? { outcome: value.outcome } : {}), ...(value.gate ? { gate: value.gate } : {}),
      // Delivered but the publish of the same call failed or is uncertain: the delivery is never repeated, so the answer
      // keeps that it was delivered and what the publish said.
      ...(RESULTS.has(value.result) ? { result: resultValue(value.result) } : {}), ...sharedFields(value),
      // The refusal of a job (I2, primeira-certa A3): every problem of every phase over the capture with its phase, op,
      // pointer, code, fix and patch, the whole list in one answer (grouped only to fit it), whether the Verify ran and
      // the phases; the patches go back with patch + basedOn.
      ...(Array.isArray(problems) && problems.length ? { problems } : {}),
      ...Object.fromEntries(['problemsTotal', 'grouped', 'verifyRan', 'verifyReason', 'phases', 'normalizations'].filter(key => value[key] != null).map(key => [key, value[key]])),
      ...correction, ...prototypeFields(value),
      // A module name that reached no open module (or several): the open modules are the fix.
      ...(Array.isArray(value.openModules) ? { openModules: value.openModules } : {}), ...(Array.isArray(value.candidates) ? { candidates: value.candidates } : {}),
      // fix/unpublished-library: what each producer's published revision lacks, what its open model says, and the sequence.
      ...(Array.isArray(value.unpublished) ? { unpublished: value.unpublished } : {}), ...(Array.isArray(value.sequence) ? { sequence: value.sequence } : {}),
      // Round 2 (A5): whether the job-alone check ran on that refusal and what it said.
      ...(value.jobCheck && typeof value.jobCheck === 'object' ? { jobCheck: value.jobCheck } : {}),
      ...(Array.isArray(diagnostics) && diagnostics.length ? { diagnostics } : {}), ...(errors ? { validationErrors: errors } : {}),
      ...(value.discovery ? { discovery: value.discovery } : {}),
      // I8: merged:true on a refusal (an uncertain merge the bridge or the evidence says was integrated) keeps merged and
      // reads it (ssam_evidence of its receipt, else studio_status); the same delivery is never the next call.
      ...(value.merged === true && value.outcome !== 'incomplete' ? { merged: true, continuation: value.continuation && value.continuation.tool !== 'studio_deliver' ? value.continuation : mergedReading(value, args) }
        : value.continuation ? { continuation: value.continuation } : {}),
      // A write whose turn in the Studio write queue did not come (A08): who holds the Studio and where it waited.
      ...(value.code === 'STUDIO_WRITE_QUEUE_TIMEOUT' || value.code === 'BUILD_QUEUE_TIMEOUT' ? Object.fromEntries(['holder', 'position', 'waitedMs', 'queueMs', 'waitedFor']
        .filter(key => value[key] !== undefined).map(key => [key, value[key]])) : {}),
      // The input layer (I1, tool-input.mjs): what it adjusted, and an INPUT_INVALID's violations and corrected arguments.
      ...inputFields(value),
      // A merge proven equal but for known losses (outcome incomplete): each lost element and its exact repair job.
      ...(value.outcome === 'incomplete' ? Object.fromEntries(['merged', 'missing', 'repair', 'forcedDeleteRules', 'declare']
        .filter(key => value[key] != null).map(key => [key, value[key]])) : {}),
      // An uncertain or incomplete merge is settled from its receipts: the folder that holds them stays.
      ...((value.outcome === 'uncertain' || value.outcome === 'incomplete' || value.merged === true) && value.evidence ? { evidence: value.evidence } : {}) };
  }
  if (until === 'merge' && value.ok === true) {
    const merged = value.merged ?? value.merge?.merged; const strictlyEqual = value.strictlyEqual ?? value.merge?.strictlyEqual;
    // I8: a merge equal but for the normalizations the Studio applies itself (equivalence "normalized") is delivered too.
    if (merged === true && (strictlyEqual === true || value.equivalence === 'normalized')) {
      // The manifest stays, and a delivery that did not publish names its publication (2026-10-06: a session asked later to
      // publish had to list the lab folders for the manifest). studio_publish {module} finds this merge by itself.
      const published = resultIs(value.result, 'deliveredAndPublished') || value.publish?.outcome === 'published';
      const module = typeof value.module === 'string' && value.module ? value.module : args?.module;
      return { ok: true, result: RESULTS.has(value.result) ? resultValue(value.result) : RESULT.delivered, ...sharedFields(value), ...prototypeFields(value), ...inputFields(value),
        ...Object.fromEntries(NEXT.filter(key => value[key] != null).map(key => [key, value[key]])),
        ...(typeof value.manifest === 'string' && value.manifest ? { manifest: value.manifest } : {}),
        ...(!published && typeof module === 'string' && module ? { continuation: { tool: 'studio_publish', arguments: { module, ...(Number.isInteger(args?.pid) ? { pid: args.pid } : {}) },
          why: 'only when the person asks to publish: with the user\'s own words in authorize, or the standing grant of the app' } } : {}) };
    }
  }
  return withoutTiming(value);
}

// ---- the whole MCP result: what the integrator wraps around every tool answer of the ssam server.
// structuredContent is shaped (compactDelivery, rewriteHints, then addNextSteps) and the text is its JSON again; a
// text-only answer has its text rewritten. Continuations found in texts go to `continuation` on a refusal without one,
// the rest to `nextCalls`; a refusal still without one gets the continuation its code implies, a success its `next`
// reads. An answer with nothing to change is returned as the same object (so "entregue", "publicado" and "fechada"
// stay the whole text).
// VERBATIM: tools whose answer is the content of a file (ssam_evidence). It passes untouched: a rewritten hint would make
// the evidence say what the file does not, text of the file would come back as suggested calls (a write among them),
// and an added nextCalls would break the budgetBytes the reader already kept. The tool's own refusals carry their
// continuation.
export const VERBATIM = new Set(['ssam_evidence', 'ssam_query_test']); // Query rows/SQL/errors are native data, never command hints.

// A refusal (ok:false, or an isError answer without ok:true) that carries no code, neither as code nor as an UPPER_SNAKE
// error.code, gets the specific one of refusal-codes.mjs. A code already given is never replaced. Any other value is
// returned as it is (same object).
export function withRefusalCode(tool, value, { isError = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const refused = value.ok === false || (isError && value.ok !== true);
  if (!refused || value.code != null || isCode(value.error?.code)) return value;
  const code = refusalCode({ tool, value });
  return code ? { ...value, code } : value;
}

// A plain-text refusal (the SDK's own "Input validation error", a relayed text error, a ZodError's JSON issue list): the
// same text as `error`, with its code, as one JSON text. Anything else: null.
function plainRefusal(tool, result) {
  if (result.isError !== true) return null;
  const texts = result.content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text);
  if (!texts.length || texts.length !== result.content.length) return null;
  const value = withRefusalCode(tool, { ok: false, error: texts.join('\n') }, { isError: true });
  return { content: [{ type: 'text', text: JSON.stringify(value) }], value };
}

export function shapeToolResult(tool, args, result, opts = {}) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return result;
  // The evidence reader's answer is the content of a file: never rewritten. Only a refusal without a code gets one.
  if (VERBATIM.has(tool)) {
    if (result.structuredContent && typeof result.structuredContent === 'object') {
      const coded = withRefusalCode(tool, result.structuredContent, { isError: result.isError === true });
      return coded === result.structuredContent ? result : { ...result, structuredContent: coded, content: [{ type: 'text', text: JSON.stringify(coded) }] };
    }
    const refusal = plainRefusal(tool, result);
    return refusal ? { ...result, content: refusal.content } : result;
  }
  let structured = result.structuredContent;
  let fromText = false;
  if (structured === undefined && result.content.length === 1 && result.content[0]?.type === 'text' && /^\s*[{[]/.test(result.content[0].text ?? '')) {
    try { structured = JSON.parse(result.content[0].text); fromText = true; } catch { structured = undefined; }
    if (fromText && (!structured || typeof structured !== 'object' || Array.isArray(structured)) && result.isError === true) { structured = undefined; fromText = false; }
  }
  // A plain-text refusal: written back as JSON text with its code. A plain-text success stays text.
  let plain = false;
  if (structured === undefined) {
    const refusal = plainRefusal(tool, result);
    if (refusal) { structured = refusal.value; fromText = true; plain = true; }
  }
  if (structured !== undefined) {
    const compact = withRefusalCode(tool, compactDelivery(tool, args, structured), { isError: result.isError === true });
    const { value, continuations } = rewriteHints(compact, opts);
    let shaped = value;
    if (continuations.length && shaped && typeof shaped === 'object' && !Array.isArray(shaped)) {
      shaped = { ...shaped }; let rest = continuations;
      if (shaped.ok === false && shaped.continuation == null) { shaped.continuation = continuations[0]; rest = continuations.slice(1); }
      if (rest.length) shaped.nextCalls = [...(Array.isArray(shaped.nextCalls) ? shaped.nextCalls : []), ...rest];
    }
    shaped = addNextSteps(tool, args, shaped, opts);
    if (shaped === structured && !plain) return result;
    const content = plain ? [{ type: 'text', text: JSON.stringify(shaped) }]
      : result.content.map((c, i) => (i === 0 && c?.type === 'text' ? { ...c, text: JSON.stringify(shaped) } : c));
    const { isError: _isError, ...base } = result;
    const error = shaped && typeof shaped === 'object' && shaped.ok === false ? true : result.isError;
    return { ...base, content, ...(fromText ? {} : { structuredContent: shaped }), ...(error ? { isError: true } : {}) };
  }
  let changed = false;
  const content = result.content.map(c => {
    if (c?.type !== 'text') return c;
    const text = rewriteText(c.text, opts, []);
    if (text === c.text) return c;
    changed = true; return { ...c, text };
  });
  return changed ? { ...result, content } : result;
}
