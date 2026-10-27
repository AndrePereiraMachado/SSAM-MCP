// o11_studio: the O11 Service Studio counterpart of the ODC studio_status / studio_wait / studio_open /
// studio_dismiss_dialog tools, over the lane's bridge (o11-bridge.mjs, kernel\src\Anvil.Bridge). One MCP call instead
// of cdp_pages.py, studio_env.py, a credential file or a sleep loop on the model side. Every refusal carries a code and
// an MCP continuation {tool, arguments, why}; never a shell command.
//
// Waiting: the O11 bridge has no event stream (Server.cs answers one request per line; Dispatch.cs has no subscribe
// verb), and this front does not change the kernel. So `wait` and `login` read the state (ui_alive,
// get_active_module.pendingDialogs, windows, list_open_modules, sc_session) with a backoff of 250 ms doubling to 2 s,
// inside one deadline, and answer on the first read where the condition holds. `wait open` is one open_module, which
// already blocks inside the Studio until the module is active or a dialog blocks it.
//
// The Studio is never driven by synthesized input: close_dialog closes an owned window as its X does (Cancel); a web
// dialog without owner, or a choice only the person can make, is handed back to the person.
//
// Module names (C41): open-module resolves the name before the bridge is asked. A module open in the Studio, or one of
// the environment inventory (the newest o11_environment inventory of that host, read from its file and cached per host,
// well under a second), is opened by its exact name, with the tolerance of o11_deliver (same letters and digits: the
// label "GameStore CS" is GameStore_CS). A name the inventory does not have is refused at once with MODULE_NOT_FOUND
// and suggestions, never a 78-120 s open that times out. Without an inventory the bridge's open_module answers as
// before.
//
// Cancellation (contract I7): wait and refresh-references honor the call's AbortSignal and answer at once with
// {ok:false, code:"CANCELLED", outcome:"uncertain"}; the write lock of the call is then released by its wrapper.
//
// System modules (A29, 2026-10-06): Users, OutSystemsUI and System are never opened (open-module, snapshot {module},
// wait {open}, refresh-references {module}): SYSTEM_MODULE_NOT_OPENABLE before the Studio is asked, with ssam_map, which
// reads their published OML without a tab. Argument shapes (A24): open-module takes `module` as its `name` (and the
// commands with `module` take `name`), errors {module} reads that open module by its key, and every BAD_ARGS carries the
// corrected call as its continuation.
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import { bridgeTarget, o11Bridge } from './o11-bridge.mjs';
import { classifyWindow, isErrorReportTitle, withoutTypedText, cleanStall } from './bridge-stall.mjs';
import { stallRecovery } from './studio-recovery.mjs';
export { classifyWindow } from './bridge-stall.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { hostedContext } from './executor.mjs';
import { renderManageProblems } from './manage-dependencies-text.mjs';
import { assertSelectedO11 } from './studio-connect.mjs';
import { resolveOpenModule, systemModuleName } from './studio-module.mjs';
import { studioWriteHolder, withStudioWriteLock } from './studio-write-lock.mjs';
import { anvilRoot, o11Lane } from './workspace.mjs';
import { rememberCapture } from './o11-capture-store.mjs';
import { lastModuleCreation, refreshInventory } from './o11-environment.mjs';

export const COMMANDS = ['status', 'wait', 'open-module', 'close-module', 'snapshot', 'errors', 'publish-log', 'windows', 'dismiss-dialog', 'login', 'refresh-references'];
export const ASK_PERSON = 'ask the person to answer the dialog in the Studio';

const TRANSPORT = new Set(['BRIDGE_NOT_LISTENING', 'BRIDGE_TRANSPORT', 'BRIDGE_PROTOCOL', 'BRIDGE_NO_REPLY']);
const UNTRUSTED = /trusted Hybrid controller/i;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/; // ScGuard.Host of the bridge
const call = (command, args) => ({ tool: 'o11_studio', arguments: { command, ...(args ? { args } : {}) } });
const CONNECT = { tool: 'ssam_connect', arguments: { lane: 'o11' }, why: 'connect the Service Studio open on this lane' };
const WAIT_NO_DIALOGS = { ...call('wait', { condition: 'no-dialogs' }), why: ASK_PERSON };
const STATUS = why => ({ ...call('status'), why });
const dismissCall = title => ({ ...call('dismiss-dialog', { title }),
  why: 'closes the window like the X (Cancel), only if the person agrees; otherwise ' + ASK_PERSON });
const mcp = (command, args) => 'o11_studio ' + JSON.stringify({ command, ...(args ? { args } : {}) });

// ---- Arguments: one strict schema per command; unknown keys are refused before anything runs.
const name = z.string().trim().min(1).max(200);
const host = z.string().trim().toLowerCase().max(253).regex(HOST, 'host must be the bare DNS name of the environment (no scheme, port or path)');
const int = (min, max, fallback) => z.number().int().min(min).max(max).default(fallback);
// The title travels exactly as given (the bridge compares whole titles); blank is refused: close_dialog without a
// title closes every owned window.
const title = z.string({ error: 'title is required: without it every dialog would close' })
  .refine(t => t.trim().length > 0, 'title is required: without it every dialog would close');
const SHAPES = {
  status: {},
  wait: { condition: z.enum(['idle', 'no-dialogs', 'open', 'signed-in']), module: name.optional(), host: host.optional(), timeoutSeconds: int(1, 1800, 600) },
  'open-module': { name, app: name.optional(), environment: host.optional(), moduleKey: name.optional(), timeoutSeconds: int(0, 300, 120) },
  snapshot: { module: name.optional(), path: z.string().min(1).refine(p => path.isAbsolute(p), 'path must be absolute').optional() },
  // module: an open module read by its key (the active one when absent).
  errors: { max: int(1, 500, 60), since: name.optional(), module: name.optional() },
  'publish-log': { module: name.optional(), max: int(1, 500, 60) },
  windows: { maxTexts: z.number().int().min(0).max(400).optional() },
  'dismiss-dialog': { title, type: name.optional() },
  login: { host, timeoutSeconds: int(1, 1800, 300) },
  // module: the consumer (the active module when absent); producers: reference names or producer keys (all when absent).
  // fix-ext-refs: add (the elements to add, by producer, as a job's reference op names them) and published (bring each named
  // producer to its published signature) run the Studio's own Manage Dependencies (bridge capability refresh_references:add).
  'refresh-references': { module: name.optional(), environment: host.optional(), producers: z.array(name).min(1).max(64).optional(), timeoutSeconds: int(10, 1800, 600),
    add: z.array(z.object({ producer: name, elements: z.array(name).max(200).default([]) }).strict()).min(1).max(64).optional(), published: z.boolean().optional() },
  // C22: the tab of a module, by name (module is the alias) and, when two tabs share it, by key.
  'close-module': { name, moduleKey: name.optional() },
};
const ARGS = Object.fromEntries(Object.entries(SHAPES).map(([command, shape]) => [command, z.object(shape).strict()]));
ARGS.wait = ARGS.wait
  .refine(a => (a.condition === 'open') === Boolean(a.module), { message: "module goes with condition 'open' only (and it needs one)", path: ['module'] })
  .refine(a => a.condition !== 'signed-in' || a.host, { message: "condition 'signed-in' needs host", path: ['host'] })
  .refine(a => !a.host || ['open', 'signed-in'].includes(a.condition), { message: "host goes with 'open' or 'signed-in' only", path: ['host'] });

// Aliases (A24): the other tools name a module `module`, so open-module takes `module` for its `name`, and the commands
// that take `module` take `name` for it. Given both with one value, the canonical key stays; two values are refused by
// the strict schema (the alias is then an unknown key) with the corrected call.
const ALIASES = { 'open-module': { module: 'name' }, 'close-module': { module: 'name' }, wait: { name: 'module' }, snapshot: { name: 'module' }, errors: { name: 'module' },
  'publish-log': { name: 'module' }, 'refresh-references': { name: 'module' } };
export function canonicalArgs(command, args) {
  const aliases = ALIASES[command];
  if (!aliases || !args || typeof args !== 'object' || Array.isArray(args)) return args;
  let out = args;
  for (const [alias, key] of Object.entries(aliases)) {
    if (!Object.hasOwn(out, alias) || (Object.hasOwn(out, key) && out[key] !== out[alias])) continue;
    const { [alias]: value, ...rest } = out;
    out = { ...rest, [key]: value };
  }
  return out;
}

// The corrected call of a refused args object (pure): keys mapped (exact, alias, other case) or dropped, numbers brought
// into their range, a host stripped to its DNS name, an invalid optional value dropped, and a required value that cannot
// be derived given as a <placeholder>. The values of dropped keys never come back (a password stays out of the answer).
const PLACEHOLDERS = { name: '<Module>', module: '<Module>', title: '<exact title of the dialog>', host: '<environment host>',
  condition: '<idle | no-dialogs | open | signed-in>' };
const bareHost = text => { try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text).hostname.toLowerCase(); } catch { return null; } };
function fixedValue(field, schema, value) {
  const inner = typeof schema.unwrap === 'function' ? schema.unwrap() : schema;
  const type = inner?.def?.type;
  if (type === 'number') {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (!Number.isFinite(n)) return undefined;
    let v = Math.round(n);
    if (Number.isFinite(inner.minValue)) v = Math.max(v, inner.minValue);
    if (Number.isFinite(inner.maxValue)) v = Math.min(v, inner.maxValue);
    return schema.safeParse(v).success ? v : undefined;
  }
  if (type === 'enum' && typeof value === 'string') return inner.options.find(o => o.toLowerCase() === value.trim().toLowerCase());
  if (type === 'array' && typeof value === 'string') return schema.safeParse([value]).success ? [value] : undefined;
  if (field === 'host' && typeof value === 'string') { const bare = bareHost(value.trim()); if (bare && schema.safeParse(bare).success) return bare; }
  if (typeof value === 'string' && schema.safeParse(value.trim()).success) return value.trim();
  return undefined;
}
export function correctedArgs(command, args) {
  const shape = SHAPES[command];
  if (!shape) return {};
  const aliases = ALIASES[command] ?? {};
  const given = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const out = {};
  for (const [key, value] of Object.entries(given)) {
    const known = Object.hasOwn(shape, key) ? key : Object.hasOwn(aliases, key) ? aliases[key]
      : Object.keys(shape).find(k => k.toLowerCase() === key.toLowerCase());
    if (known && !Object.hasOwn(out, known) && !(known !== key && Object.hasOwn(given, known))) out[known] = value;
  }
  for (const [field, schema] of Object.entries(shape)) {
    const optional = schema.safeParse(undefined).success;
    if (!Object.hasOwn(out, field)) { if (!optional) out[field] = PLACEHOLDERS[field] ?? '<' + field + '>'; continue; }
    if (schema.safeParse(out[field]).success) continue;
    const fixed = fixedValue(field, schema, out[field]);
    if (fixed !== undefined) out[field] = fixed;
    else if (optional) delete out[field];
    else out[field] = PLACEHOLDERS[field] ?? '<' + field + '>';
  }
  if (command === 'wait') { // the pairs of the wait refinements
    if (out.condition === 'open') out.module ??= PLACEHOLDERS.module; else delete out.module;
    if (out.condition === 'signed-in') out.host ??= PLACEHOLDERS.host; else if (out.condition !== 'open') delete out.host;
  }
  return out;
}
const correctedCall = (command, args) => {
  const fixed = correctedArgs(command, args);
  const guess = Object.values(fixed).some(v => typeof v === 'string' && /^<.*>$/.test(v));
  return { ...call(command, Object.keys(fixed).length ? fixed : undefined),
    why: guess ? 'the same call with the arguments this command accepts; replace each <value> with the real one' : 'the same call with the arguments this command accepts' };
};
const badArgs = (command, error, args) => ({ ok: false, code: 'BAD_ARGS', command,
  error: error.issues.map(i => (i.path.length ? i.path.join('.') + ': ' : '') + i.message).join('; '), allowed: Object.keys(SHAPES[command]),
  continuation: correctedCall(command, args) });

// ---- System modules (A29): refused before the Studio is asked.
export function systemModuleRefusal(requested) {
  const module = systemModuleName(requested) ?? String(requested);
  return { ok: false, code: 'SYSTEM_MODULE_NOT_OPENABLE', name: requested, module, outcome: 'not-sent',
    error: module + ' is a system module: it is never opened in the Studio; its published OML is read without a tab. Nothing was opened.',
    continuation: { tool: 'ssam_map', arguments: { lane: 'o11', target: module }, why: 'reads the published OML of ' + module + ' without opening a tab, with the @key of each element' } };
}
// The module a command would open, when it is a system one (open-module, snapshot, wait open, refresh-references).
const systemOpen = (command, args) => {
  const target = command === 'open-module' ? args.name : ['snapshot', 'refresh-references'].includes(command) || (command === 'wait' && args.condition === 'open') ? args.module : null;
  return typeof target === 'string' && systemModuleName(target) ? target : null;
};

// Commands that change the Studio (open or select a tab, register a snapshot base, close a window, open the sign-in)
// check first that the lane still talks to the Studio the person selected.
const mutates = (command, args) => ['open-module', 'close-module', 'snapshot', 'dismiss-dialog', 'login', 'refresh-references'].includes(command)
  || (command === 'wait' && args.condition === 'open');

// ---- Dialog hints: the kernel's DialogPolicy.Hint and a few bridge refusals name `python scripts/cdp_pages.py` and the
// raw bridge verbs; here they become the MCP form (o11_studio dismiss-dialog by title, or the person in the Studio).
const WAIT_TEXT = 'then ' + mcp('wait', { condition: 'no-dialogs' }) + ' and retry';
const KNOWN_HINTS = [
  ['the Studio recovery dialog (Open | Discard) is open: `python scripts/cdp_pages.py --click Discard` (or Open) and retry',
    () => 'the Studio recovery dialog (Open | Discard) is open: ask the person to choose Discard or Open in the Studio, ' + WAIT_TEXT],
  ['the references dialog is open (a producer was republished with incompatible changes): `python scripts/cdp_pages.py` shows its buttons; `--click "Manage Dependencies"` then Apply updates the references, `--click Cancel` opens without updating; then retry; never restart the Studio for this',
    () => 'the references dialog is open (a producer was republished with incompatible changes): ask the person to choose in the Studio (Manage Dependencies then Apply updates the references; Cancel opens without updating), ' + WAIT_TEXT + '; never restart the Studio for this'],
  ['a web dialog is open in the Studio (its text is not visible to the bridge): `python scripts/cdp_pages.py` lists its text and buttons; `--click <Button>` answers it (recovery after a kill: Discard or Open); then retry',
    () => 'a web dialog is open in the Studio (its text is not visible to the bridge): ask the person to answer it in the Studio (recovery after a kill: Discard or Open), ' + WAIT_TEXT],
  ['a dialog is open in the Studio: read it with `windows` or `python scripts/cdp_pages.py`, answer it, and retry',
    ({ title, closable }) => 'a dialog is open in the Studio: read it with ' + mcp('windows') + '; '
      + (title && closable !== false ? mcp('dismiss-dialog', { title }) + ' closes it like its X (Cancel), or ' : '')
      + 'ask the person to answer it in the Studio; then retry'],
];
const BUTTON = String.raw`(?:"([^"]+)"|'([^']+)'|<([^>]+)>|([^\s\`,;)]+))`;
const CDP = String.raw`python(?:\.exe)?\s+scripts[\\/]cdp_pages\.py`;
const pick = groups => groups.find(g => g !== undefined);
const clickText = (button, { title, closable }) => /^(cancel|close|x)$/i.test(button) && title && closable !== false
  ? mcp('dismiss-dialog', { title }) : 'ask the person to click ' + button + ' in the Studio';

// Pure. context {title?, closable?}: the dialog the text is about, when the caller knows it (closable:false for a web
// dialog without owner or a presenter, which close_dialog cannot close).
export function translateDialogHint(text, context = {}) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [hint, mcpHint] of KNOWN_HINTS) out = out.split(hint).join(mcpHint(context));
  return out
    .replace(new RegExp('`?' + CDP + String.raw`\s+--click\s+` + BUTTON + '`?', 'gi'), (m, ...g) => clickText(pick(g.slice(0, 4)), context))
    .replace(new RegExp(String.raw`\`--click\s+` + BUTTON + '`', 'gi'), (m, ...g) => clickText(pick(g.slice(0, 4)), context))
    .replace(new RegExp(String.raw`\`windows\`\s*(?:/|or)\s*\`?` + CDP + '`?', 'gi'), mcp('windows'))
    .replace(new RegExp('`?' + CDP + String.raw`(?:\s+--[\w-]+)*\`?`, 'gi'), mcp('windows'))
    .replace(/scripts[\\/]cdp_pages\.py/gi, mcp('windows'))
    .replace(/`windows`/g, mcp('windows'))
    .replace(/\bcall open_module again\b/g, 'call ' + mcp('open-module') + ' again');
}

// ---- Dialog projection. Dialogs.BlockedBy (get_active_module.pendingDialogs, open_module.blockedBy) when a module is
// active; otherwise the same rule over `windows` (DialogPolicy.ClassifyWindow ported: it is pure).
export function dialogsFromWindows(windows = []) {
  const found = [];
  for (const w of windows) {
    const web = String(w.type ?? '').includes('DialogWindow');
    if (!w.isVisible || !(w.isModal || web)) continue; // never the main window
    const texts = withoutTypedText(w.texts).slice(0, 12);
    let kind = classifyWindow(w.title, texts);
    if (kind === 'Progress') continue; // opening/loading: transient
    if (web && kind === 'Modal') kind = 'WebDialog';
    found.push({ kind, type: w.type, title: w.title, source: 'window', contentKind: web ? 'web' : 'native', texts, owned: w.isModal === true });
  }
  return found;
}
// A window close_dialog can close: titled and owned. A native window in BlockedBy is owned; a web one may not be. The
// Studio's crash report (UnexpectedError) is closed by its exact title even without an owner (fam-deps, WindowsHandler).
const closable = d => Boolean(d.title?.trim()) && d.source === 'window' && (d.kind === 'UnexpectedError' || (d.owned ?? d.contentKind === 'native'));
function projectDialog(d) {
  const title = typeof d.title === 'string' && d.title.trim() ? d.title : null;
  const canClose = closable(d);
  return { kind: d.kind, ...(title ? { title } : {}), type: d.type, source: d.source, ...(d.module ? { module: d.module } : {}), ...(d.contentKind ? { contentKind: d.contentKind } : {}),
    ...(d.texts?.length ? { texts: d.texts.slice(0, 8) } : {}),
    ...(d.hint ? { hint: translateDialogHint(d.hint, { title, closable: canClose }) } : {}),
    next: canClose ? dismissCall(title) : WAIT_NO_DIALOGS };
}

// ---- Failures.
const notConnected = () => ({ ok: false, code: 'O11_NOT_CONNECTED', error: 'no O11 Studio bridge answers on this lane', continuation: CONNECT });
const abortsWait = error => TRANSPORT.has(error?.code) || UNTRUSTED.test(error?.message ?? '');
// UI_BUSY (bridge capability ui:bounded, UiGate.cs): the Studio's UI thread did not run the step in time. withdrawn: the
// step left the UI queue, nothing of it ran (not-sent); else it started and its outcome is unknown. Never repeated blind:
// the next call reads the state.
function uiBusy(error, module) {
  const data = error?.reply?.data ?? {};
  const notSent = error?.executed === false || data.outcome === 'not-executed';
  return { ok: false, code: 'UI_BUSY', ...(module ? { module } : {}), method: error?.method ?? null, what: data.what ?? null,
    outcome: notSent ? 'not-sent' : 'unknown', ...(notSent ? { executed: false } : {}),
    error: 'The Service Studio UI thread is busy or blocked: ' + String(error?.message ?? '').replace(/^[^:]+:\s*/, ''),
    continuation: STATUS('the Studio interface did not answer in time; read the state (uiResponsive) before any new write') };
}
function failure(error, originalCall) {
  if (TRANSPORT.has(error?.code)) return notConnected();
  if (UNTRUSTED.test(error?.message ?? ''))
    return { ok: false, code: 'O11_NOT_AUTHORIZED', error: 'the bridge does not trust this controller key', continuation: { ...CONNECT, why: 'select the Studio again to renew the bridge key' } };
  if (error?.code === 'BRIDGE_STALLED' || error?.code === 'STUDIO_ERROR_DIALOG_OPEN') {
    const stalled = cleanStall(error.stall ?? error.reply?.data?.stall);
    const notSent = error.executed === false;
    const next = notSent && originalCall ? { ...originalCall, why: 'repeat the same call after closing the report; nothing was sent' }
      : STATUS('reconcile the state of the operation before any new write; nothing was repeated');
    const recovery = stallRecovery(stalled, next);
    return { ok: false, code: error.code, method: error.method, outcome: notSent ? 'not-sent' : 'unknown',
      ...(notSent ? { executed: false } : {}), stalled, recovery, continuation: recovery[0], error: error.message };
  }
  if (error?.code === 'BRIDGE_TIMEOUT')
    return { ok: false, code: 'BRIDGE_TIMEOUT', method: error.method, outcome: error.executed === false ? 'not-sent' : 'unknown',
      continuation: STATUS('the Studio may be busy; read the state before repeating') };
  if (error?.code === 'UI_BUSY') return uiBusy(error);
  return { ok: false, ...(error?.code ? { code: error.code } : {}), ...(error?.method ? { method: error.method } : {}),
    ...(error?.executed === false ? { executed: false } : {}), error: translateDialogHint(error?.message ?? String(error)) };
}
// The default check of studio-connect.mjs speaks of a shell command; the refusal names the MCP call instead.
const notSelected = error => ({ ok: false, code: 'O11_NOT_SELECTED',
  error: String(error?.message ?? error).split(/(?<=\.)\s+/).filter(s => !/ssam connect|connect again/i.test(s)).join(' ') || 'the selected Studio changed',
  continuation: { ...CONNECT, why: 'the selected Studio session changed; connect again' } });
// The same refusals for the readers of a live O11 module (module-map.mjs captureO11Module).
export { failure as studioFailure, notSelected as notSelectedRefusal };
// A read used while waiting: transport loss and a refused key end the wait; anything else is "not yet".
async function soft(promise) {
  try { return { value: await promise }; }
  catch (error) { if (abortsWait(error)) throw error; return { error: translateDialogHint(error?.message ?? String(error)) }; }
}

// ---- Polling with backoff (see the header: the bridge has no event to wait on). A cancelled call (ctx.signal) stops
// at once: the delay ends on abort and the outcome says cancelled.
const BACKOFF_START = 250, BACKOFF_MAX = 2000;
async function poll(check, timeoutMs, { now, delay, signal }) {
  const started = now(); const deadline = started + timeoutMs; let step = BACKOFF_START; let reads = 0;
  for (;;) {
    if (signal?.aborted) return { reads, waitedMs: now() - started, cancelled: true };
    const state = await check(Math.max(0, deadline - now())); reads++;
    if (state.done || state.stop) return { ...state, reads, waitedMs: now() - started };
    if (signal?.aborted) return { ...state, reads, waitedMs: now() - started, cancelled: true };
    const left = deadline - now();
    if (left <= 0) return { ...state, reads, waitedMs: now() - started, timedOut: true };
    await abortable(delay(Math.min(step, left)), signal); step = Math.min(step * 2, BACKOFF_MAX);
  }
}
// A promise that also settles when the signal aborts (the caller then reads signal.aborted).
const abortable = (promise, signal) => !signal ? promise : new Promise(resolve => {
  if (signal.aborted) return resolve();
  const done = () => { signal.removeEventListener('abort', done); resolve(); };
  signal.addEventListener('abort', done, { once: true });
  Promise.resolve(promise).then(done, done);
});
export const CANCELLED = Object.freeze({ code: 'CANCELLED', outcome: 'uncertain' });
const cancelled = (extra = {}) => ({ ok: false, ...CANCELLED, error: 'The call was cancelled; it stopped waiting. Read the Studio state before repeating it.',
  ...extra, continuation: STATUS('the call was cancelled; see the Studio state before repeating') });
const readTimeout = remaining => ({ timeoutMs: Math.max(1500, Math.min(remaining, 10000)) });
const openingOf = modules => (modules ?? []).filter(m => m.serverSilentMode === true || m.hasOpenedActiveESpace === false).map(m => m.name ?? null);
// A server operation (publish, upload) running for a module: list_open_modules/get_active_module serverOperation
// (bridge capability list_open_modules:server_operation); an older bridge does not report it.
const runningOf = modules => (modules ?? []).filter(m => m?.serverOperation?.running === true)
  .map(m => ({ module: m.name ?? null, verb: m.serverOperation.verb ?? null }));

async function windowDialogs(bridge, remaining = 10000) {
  const listing = await soft(bridge.ok('windows', { max_texts: 12 }, readTimeout(remaining)));
  return { raw: listing.value ? dialogsFromWindows(listing.value.windows) : null, error: listing.error };
}
// C10: one detector for wait, status and o11_publish. The active tab's pendingDialogs and otherDialogs, every open module's
// pendingDialogs (bridge capability list_open_modules:dialogs: a Manage Dependencies presenter of another tab or window has
// no window of its own) and, without an active module, the windows; each dialog once. An older bridge answers only the
// active tab's, as before.
export function allDialogs(active, listed) {
  const out = []; const seen = new Set();
  const add = (d, module) => {
    if (!d || typeof d !== 'object') return;
    const owner = d.source === 'window' ? null : d.module ?? module ?? null;
    const key = [d.source, d.kind, d.type, d.title ?? '', owner ?? ''].join('|');
    if (seen.has(key)) return;
    seen.add(key); out.push(owner && !d.module ? { ...d, module: owner } : d);
  };
  for (const d of active?.pendingDialogs ?? []) add(d, active?.name);
  for (const d of active?.otherDialogs ?? []) add(d);
  for (const m of listed?.modules ?? []) for (const d of m?.pendingDialogs ?? []) add(d, m.name);
  for (const d of listed?.dialogs ?? []) add(d);
  return out;
}
// ---- MB2 (owner rule 2026-10-07): the Studio's dialog "Incompatible or missing dependencies found" never stops a call.
// A bridge with dialogs:dependencies_auto closes it as Cancel (answer_dependencies_dialog: only that dialog, read by its
// web text; never Manage Dependencies), then the Studio's own Refresh References runs for every producer of the module
// (refresh_references {module_key}, no UI) and the call goes on, listing the dialog and referencesRefreshed. The
// capability is read (bridge_manifest) only when a dialog that may be it was seen; an older bridge keeps the dialog for
// the person, as before. A refresh that fails answers REFERENCES_REFRESH_FAILED with the module and the next call.
export const DEPENDENCIES_CAPABILITY = 'dialogs:dependencies_auto';
// fix-ext-refs: refresh_references with add/published runs the Studio's own Manage Dependencies (RefreshReferencesHandler.Manage).
export const MANAGE_DEPENDENCIES_CAPABILITY = 'refresh_references:add';
// servidor/fase4-26 (a7, E1): hosted, the customer's Service Studio runs the O11 bridge of the SSAM agent package; reopening
// the Studio loads the same bridge, so the hosted refusal names the agent package (nothing is sent), never the local shortcut.
// a8 (the next agent pack): the thin bridge of the current package runs the Studio's Manage Dependencies (capability
// refresh_references:add) and the call is sent; a bridge without it is an older package's, and the refusal says the exact step.
export const MANAGE_DEPENDENCIES_HOSTED_PENDING = 'MANAGE_DEPENDENCIES_HOSTED_PENDING';
export function manageDependenciesHostedPending(module) {
  return { ok: false, code: 'HOSTED_UNAVAILABLE', cause: MANAGE_DEPENDENCIES_HOSTED_PENDING, module, executed: false, outcome: 'not-sent',
    error: 'Hosted: install the current agent package and restart Service Studio, then repeat this call. The O11 bridge this Studio loaded is an older package\'s,'
      + ' without the Studio\'s own Manage Dependencies (capability ' + MANAGE_DEPENDENCIES_CAPABILITY + '); nothing was sent, added or refreshed.',
    continuation: { tool: 'ssam_doctor', arguments: { lane: 'o11' },
      why: 'Shows the agent package and the O11 bridge of this account. Without add and published, refresh-references runs the Studio\'s own Refresh References (it adds no element).' } };
}
export const MODULE_KEY_CAPABILITY = 'merge_from_oml:module_key';
const manifests = new WeakMap();
// Whether the bridge offers a capability; a bridge that cannot answer bridge_manifest offers none. One read per client.
// CX14 follow-up: a client of o11-bridge.mjs shares ONE read per Studio (pid + start) with the pre-probe and status.
export async function bridgeOffers(bridge, capability) {
  if (!bridge || typeof bridge !== 'object') return false;
  if (typeof bridge.manifest === 'function') {
    const read = await bridge.manifest({ timeoutMs: 5000 });
    if (read?.ok) return read.capabilities.includes(capability);
    if (abortsWait(read?.error)) throw read.error;
    return false;
  }
  if (!manifests.has(bridge)) manifests.set(bridge, Promise.resolve(bridge.ok('bridge_manifest', {}, { timeoutMs: 5000 }))
    .then(m => new Set(Array.isArray(m?.capabilities) ? m.capabilities : []), error => { if (abortsWait(error)) throw error; return new Set(); }));
  return (await manifests.get(bridge)).has(capability);
}
// A dialog read that may be the dependencies dialog: a web window (its text is not in the visual tree) the bridge classified
// as the references dialog (by its title) or as a web dialog. The bridge decides by the text; anything else stays.
export const dependenciesCandidate = dialogs => (Array.isArray(dialogs) ? dialogs : []).some(d => d && d.source === 'window'
  && (d.contentKind === 'web' || String(d.type ?? '').includes('DialogWindow')) && ['ManageDependencies', 'WebDialog'].includes(d.kind));
// Closes the dependencies dialog (Cancel) when the bridge offers it: {answered:[...], module?, moduleKey?}, or null.
export async function closeDependenciesDialog(bridge) {
  if (!(await bridgeOffers(bridge, DEPENDENCIES_CAPABILITY))) return null;
  const data = await bridge.ok('answer_dependencies_dialog', {}, { timeoutMs: 30000 });
  const answered = (Array.isArray(data?.answered) ? data.answered : []).map(a => ({ kind: a?.kind ?? 'DependenciesDialog', ...(a?.title ? { title: a.title } : {}),
    answer: a?.answer ?? 'Cancel', ...(a?.text ? { text: a.text } : {}) }));
  return answered.length ? { answered, module: data?.module ?? null, moduleKey: data?.moduleKey ?? null } : null;
}
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
// Refresh References of every producer of one open module, by its key: {ok:true, referencesRefreshed} or the refusal.
export async function refreshAllReferences(bridge, { module, key, environment, answered = [], signal } = {}) {
  const dialogs = answered.length ? { dependenciesDialog: { answered } } : {};
  try {
    const data = await bridge.ok('refresh_references', { module_key: key, ...(environment ? { environment } : {}), timeout: 600, answer_dependencies: true },
      { ...(signal ? { signal } : {}), timeoutMs: 660000 });
    return { ok: true, ...dialogs, referencesRefreshed: { module: data?.module ?? module ?? null, changed: data?.changed === true, refreshed: data?.refreshed ?? [],
      ...(data?.upToDate?.length ? { upToDate: data.upToDate } : {}), ...(Number.isInteger(data?.newErrors) ? { newErrors: data.newErrors } : {}) } };
  } catch (error) {
    if (abortsWait(error)) throw error;
    return { ok: false, code: 'REFERENCES_REFRESH_FAILED', module: module ?? null, outcome: error?.executed === false ? 'not-sent' : 'uncertain', ...dialogs,
      error: 'The Studio showed the dependencies dialog for ' + (module ?? 'the module') + ' (answered: Cancel) and the Refresh References of its producers failed: '
        + translateDialogHint(String(error?.message ?? error).replace(/^\w+Exception:\s*/, '')),
      continuation: { ...call('refresh-references', module ? { module } : undefined), why: 'the Studio\'s own Refresh References for the producers of the module; then repeat the call' } };
  }
}
// The open tab of a module in ANY Studio window (list_open_modules), for a call whose module is not the selected tab: with
// about ten tabs the Studio moves some into a second window and the bridge's active module is the selected tab of the
// FIRST window (2026-10-07, a client session: o11_publish answered MODULE_NOT_ACTIVE right after open-module said alreadyOpen). A bridge
// whose calls target module_key (merge_from_oml:module_key, C41) goes on by key. {tab, listed} | {ambiguous} | {} (none).
export async function moduleTab(bridge, module, { listed, environment } = {}) {
  let listing = listed;
  // A bridge that cannot list its tabs has no tab to address by key: the caller answers as before.
  if (!listing) try { listing = await bridge.ok('list_open_modules', {}, { timeoutMs: 10000 }); } catch (error) { if (abortsWait(error)) throw error; return {}; }
  const tabs = (listing?.modules ?? []).filter(m => m && m.hasESpace !== false && m.hasOpenedActiveESpace !== false
    && typeof m.key === 'string' && m.key && sameName(m.name, module)
    && (!environment || sameName(m.environment, environment)));
  if (tabs.length > 1) return { ambiguous: tabs.map(m => ({ name: m.name, key: m.key, ...(Number.isInteger(m.window) ? { window: m.window } : {}) })) };
  if (tabs.length === 1 && await bridgeOffers(bridge, MODULE_KEY_CAPABILITY)) return { tab: { ...tabs[0], byKey: true }, listed: listing };
  return {};
}
export const tabAmbiguous = (module, tabs, why) => ({ ok: false, code: 'MODULE_TAB_AMBIGUOUS', module, tabs, outcome: 'not-sent',
  error: 'More than one Studio tab is named ' + module + '; nothing was done.', continuation: STATUS(why ?? 'shows the open tabs; close the duplicate in the Studio') });
// The dependencies dialog seen in a read: closed, then the module's references refreshed. module/key/environment name the
// module of the call; without them, the dialog's own tab (its owner window) or the active one. null when nothing was answered.
async function answerDependencies(bridge, options = {}) {
  const closed = await closeDependenciesDialog(bridge);
  return closed ? refreshAfterDialog(bridge, closed, options) : null;
}
export async function refreshAfterDialog(bridge, closed, { module, key, environment, signal } = {}) {
  let target = { name: module ?? closed.module ?? null, key: key ?? (module ? null : closed.moduleKey), environment: environment ?? null };
  if (!target.key && target.name) {
    const found = await moduleTab(bridge, target.name).catch(error => { if (abortsWait(error)) throw error; return {}; });
    if (found.ambiguous) return { ...tabAmbiguous(target.name, found.ambiguous), dependenciesDialog: { answered: closed.answered } };
    if (found.tab) target = { name: found.tab.name, key: found.tab.key, environment: target.environment ?? found.tab.environment ?? null };
  }
  if (!target.key) {
    const active = await bridge.ok('get_active_module').catch(error => { if (abortsWait(error)) throw error; return null; });
    if (active?.key && (!target.name || sameName(active.name, target.name))) target = { name: active.name, key: active.key, environment: target.environment ?? active.environment ?? null };
  }
  if (!target.key) return { ok: false, code: 'REFERENCES_REFRESH_FAILED', module: target.name, dependenciesDialog: { answered: closed.answered }, outcome: 'not-sent',
    error: 'The dependencies dialog was answered (Cancel), but its module is not open in any Studio tab; nothing was refreshed.',
    continuation: STATUS('see the open modules; then refresh-references {module}') };
  return refreshAllReferences(bridge, { module: target.name, key: target.key, environment: target.environment, answered: closed.answered, signal });
}
export { answerDependencies as answerDependenciesDialog };
// The dialogs answered in one call and the refreshes that followed, as the answer lists them (one refresh: an object).
export const dependenciesFields = done => (done?.length ? { dependenciesDialog: { answered: done.flatMap(d => d.dependenciesDialog?.answered ?? []) },
  referencesRefreshed: done.length === 1 ? done[0].referencesRefreshed : done.map(d => d.referencesRefreshed) } : {});

async function readDialogs(bridge, remaining = 10000) {
  const [active, listed] = await Promise.all([soft(bridge.ok('get_active_module', {}, readTimeout(remaining))), soft(bridge.ok('list_open_modules', {}, readTimeout(remaining)))]);
  if (active.value) return { raw: allDialogs(active.value, listed.value) };
  const windows = await windowDialogs(bridge, remaining);
  return windows.raw ? { raw: allDialogs({ pendingDialogs: windows.raw }, listed.value) } : listed.value ? { raw: allDialogs(null, listed.value), error: windows.error } : windows;
}

const CHECKS = {
  // Idle: the UI answers, no module is opening, no server operation runs (C31) and no SSAM write holds the Studio's
  // write lock (studio-write-lock.mjs): a publish in flight is never "idle".
  async idle(bridge, args, remaining, ctx) {
    const [alive, list] = await Promise.all([soft(bridge.ok('ui_alive', { timeout_ms: 1000 }, readTimeout(remaining))),
      soft(bridge.ok('list_open_modules', {}, readTimeout(remaining)))]);
    const uiResponsive = alive.value?.alive === true; const opening = list.value ? openingOf(list.value.modules) : null;
    const serverOperations = list.value ? runningOf(list.value.modules) : [];
    let writeLock = null;
    try { writeLock = ctx?.writeHolder ? ctx.writeHolder() : null; } catch { writeLock = null; }
    return { done: uiResponsive && opening?.length === 0 && serverOperations.length === 0 && !writeLock,
      view: { uiResponsive, opening: opening ?? 'unknown', ...(serverOperations.length ? { serverOperations } : {}), ...(writeLock ? { writeLock } : {}) } };
  },
  async 'no-dialogs'(bridge, args, remaining, ctx) {
    let { raw, error } = await readDialogs(bridge, remaining);
    // MB2: the dependencies dialog is SSAM's to answer (Cancel, then Refresh References); the wait goes on for the others.
    if (ctx?.dependencies && dependenciesCandidate(raw)) {
      const answered = await answerDependencies(bridge, { signal: ctx.signal });
      if (answered?.ok === false) return { stop: true, refusal: answered, view: { dialogs: raw.map(projectDialog) } };
      if (answered) { ctx.dependencies.push(answered); ({ raw, error } = await readDialogs(bridge, remaining)); }
    }
    return { done: raw?.length === 0, view: { dialogs: raw ? raw.map(projectDialog) : 'unknown', ...(error && !raw ? { error } : {}) } };
  },
  async 'signed-in'(bridge, args, remaining) {
    const session = await soft(bridge.ok('sc_session', { host: args.host }, readTimeout(remaining)));
    const studio = session.value?.studio;
    if (studio?.signedIn === true) return { done: true, view: { host: args.host, signedIn: true, user: studio.user ?? null, loginType: studio.loginType ?? null } };
    return { done: false, view: { host: args.host, signedIn: false, loginPending: studio?.loginPending === true, ...(session.error ? { error: session.error } : {}) } };
  },
};

// ---- Commands.
// status is a read: it never waits for the Studio write lock. It answers the dependencies dialog (MB2, a Cancel and then
// the Studio's Refresh References, a model change) only when that lock is free at that moment (ctx.exclusive, queue 0);
// otherwise the dialog is listed with its next call and the write that holds the Studio answers it (UI freeze of
// 2026-10-08, pattern 4: a status refreshing references beside another agent's merge).
// The hosts the Studio is signed in to (sc_session.signedInHosts), and, when no open module has an environment and no host
// is signed in, the fact that explains it: every environment read (deliveries, publish, ssam_app_url) needs the sign-in,
// which the person does in the Studio (login opens its own sign-in dialog).
function signedInFields(session, modules) {
  if (session?.status !== 'fulfilled') return {};
  const value = session.value?.result ?? session.value;
  const hosts = Array.isArray(value?.signedInHosts) ? [...new Set(value.signedInHosts.filter(h => typeof h === 'string' && h).map(h => h.toLowerCase()))] : null;
  if (!hosts) return {};
  const out = { signedInHosts: hosts };
  const open = Array.isArray(modules) ? modules.filter(m => m && m.hasESpace !== false) : [];
  if (!hosts.length && open.length && open.every(m => !m.environment)) {
    out.signedIn = false;
    out.environmentUnknown = { why: 'the Studio is not signed in to any environment: its open modules report no environment, and environment reads, deliveries, publications and ssam_app_url need the sign-in',
      next: { tool: 'o11_studio', arguments: { command: 'login', args: { host: '<environment host>' } }, why: 'opens the Studio own sign-in; the person types the password or completes SSO there' } };
  }
  return out;
}

async function status(bridge, args, ctx) {
  // CX14 follow-up: the manifest shared with the pre-probe and bridgeOffers (one read per Studio) when the client has it.
  const manifestRead = typeof bridge?.manifest === 'function'
    ? bridge.manifest({ timeoutMs: 5000 }).then(read => { if (read?.ok) return read.data; throw read?.error; }) : bridge.ok('bridge_manifest');
  // Meta de 20/10/2026 (ssam_app_url live): the Studio had lost its environment sign-in overnight and status showed only
  // environment:null on every module; sc_session (an older bridge has none) says which hosts the Studio is signed in to.
  const [ping, manifest, list, active, alive, session] = await Promise.allSettled([bridge.ok('ping'), manifestRead,
    bridge.ok('list_open_modules'), bridge.ok('get_active_module'), bridge.ok('ui_alive', { timeout_ms: 1000 }), bridge.ok('sc_session', {})]);
  if (ping.status === 'rejected') throw ping.reason;
  if (ping.value?.bridge !== 'anvil') return notConnected();
  for (const r of [list, active, alive]) if (r.status === 'rejected' && abortsWait(r.reason)) throw r.reason;
  const pid = ping.value.pid;
  if (Number.isInteger(bridge.target?.pid) && bridge.target.pid !== pid)
    return { ok: false, code: 'O11_STUDIO_CHANGED', pid, selectedPid: bridge.target.pid, continuation: { ...CONNECT, why: 'another Studio answers on the port of the lane; connect again' } };
  const a = active.status === 'fulfilled' ? active.value : null;
  const listed = list.status === 'fulfilled' ? list.value : null;
  if (manifest.status === 'fulfilled' && bridge && typeof bridge === 'object' && typeof bridge.manifest !== 'function' && !manifests.has(bridge))
    manifests.set(bridge, Promise.resolve(new Set(Array.isArray(manifest.value?.capabilities) ? manifest.value.capabilities : [])));
  const windowRead = a ? null : await windowDialogs(bridge);
  let dialogs = a ? { raw: allDialogs(a, listed) } : windowRead.raw ? { raw: allDialogs({ pendingDialogs: windowRead.raw }, listed) } : windowRead;
  // MB2: the dependencies dialog is answered here too (Cancel, then Refresh References), and the dialogs read again.
  let answered = null; let deferred = null;
  if (dependenciesCandidate(dialogs.raw)) {
    const exclusive = ctx?.exclusive ?? (fn => fn());
    let ran = false;
    const outcome = await exclusive(async () => { ran = true; return answerDependencies(bridge); });
    if (!ran) deferred = { pending: true, holder: outcome?.holder ?? null, why: 'a write holds this Studio: it answers the dialog; or repeat the status when it ends' };
    else if ((answered = outcome)) {
      if (answered.ok === false) return answered;
      dialogs = await readDialogs(bridge);
    }
  }
  const modules = list.status === 'fulfilled' ? list.value.modules ?? [] : null;
  const opening = modules ? openingOf(modules) : [];
  const serverOperations = modules ? runningOf(modules) : [];
  const uiResponsive = alive.status === 'fulfilled' && alive.value?.alive === true;
  const unavailable = [[list, 'list_open_modules'], [alive, 'ui_alive']].filter(([r]) => r.status === 'rejected').map(([r, m]) => m + ': ' + translateDialogHint(r.reason?.message));
  return { ok: true, pid, version: ping.value.version ?? null, protocol: manifest.status === 'fulfilled' ? manifest.value?.protocolVersion ?? null : null,
    uiResponsive, busy: !uiResponsive || opening.length > 0 || serverOperations.length > 0, ...(opening.length ? { opening } : {}),
    ...(serverOperations.length ? { serverOperations } : {}),
    activeModule: a ? { name: a.name, key: a.key, environment: a.environment ?? null, modified: a.isModified === true } : null,
    openModules: modules ? modules.filter(m => m.hasESpace !== false).map(m => ({ name: m.name, modified: m.isModified === true, environment: m.environment ?? null,
      ...(Number.isInteger(m.window) ? { window: m.window } : {}) })) : null,
    environments: list.status === 'fulfilled' ? list.value.environments ?? [] : null,
    ...signedInFields(session, modules),
    // C22 (bridge capability list_open_modules:window): each Studio window and the tabs it holds; a second window is visible here.
    ...(Array.isArray(listed?.windows) ? { windows: listed.windows.map(w => ({ index: w.index, ...(w.title ? { title: w.title } : {}), ...(w.environment ? { environment: w.environment } : {}),
      modules: Array.isArray(w.modules) ? w.modules : [] })) } : {}),
    pendingDialogs: dialogs.raw ? dialogs.raw.map(projectDialog) : 'unknown', ...(unavailable.length ? { unavailable } : {}),
    ...dependenciesFields(answered ? [answered] : []), ...(deferred ? { dependenciesDialog: deferred } : {}) };
}

async function wait(bridge, args, ctx) {
  if (args.condition === 'open')
    return openModule(bridge, { name: args.module, environment: args.host, timeoutSeconds: Math.min(args.timeoutSeconds, 300) }, ctx);
  const dependencies = [];
  const outcome = await poll(remaining => CHECKS[args.condition](bridge, args, remaining, { ...ctx, dependencies }), args.timeoutSeconds * 1000, ctx);
  if (outcome.refusal) return outcome.refusal;
  if (outcome.done) return { ok: true, condition: args.condition, waitedMs: outcome.waitedMs, ...outcome.view, ...dependenciesFields(dependencies) };
  if (outcome.cancelled) return cancelled({ condition: args.condition, waitedMs: outcome.waitedMs, ...(outcome.view ? { last: outcome.view } : {}) });
  return { ok: false, code: 'WAIT_TIMEOUT', condition: args.condition, waitedMs: outcome.waitedMs, last: outcome.view, ...dependenciesFields(dependencies),
    continuation: args.condition === 'no-dialogs' ? WAIT_NO_DIALOGS
      : args.condition === 'signed-in' ? { ...call('wait', { condition: 'signed-in', host: args.host }), why: 'the person still has to finish the sign-in in the Studio' }
        : STATUS('the Studio is still busy; see the state') };
}

function openFailure(error, args) {
  const message = error?.message ?? '';
  if (!error?.reply || TRANSPORT.has(error?.code)) return failure(error, call('open-module', args));
  const login = args.environment ? { ...call('login', { host: args.environment }), why: 'opens the Studio\'s own sign-in; the person signs in there (password or SSO)' }
    : STATUS('see environments and call login with the host of the environment');
  if (/not logged in/i.test(message)) return { ok: false, code: 'STUDIO_NOT_SIGNED_IN', name: args.name, error: 'the Studio has no signed-in session for this environment', continuation: login };
  if (/no Studio window connected to the requested environment/i.test(message))
    return { ok: false, code: 'ENVIRONMENT_NOT_CONNECTED', name: args.name, environment: args.environment, error: 'no Studio window is connected to that environment', continuation: login };
  if (/did not become active/i.test(message))
    return { ok: false, code: 'OPEN_TIMEOUT', name: args.name, error: translateDialogHint(message.replace(/\s*\(check windows and ui_alive\)/, '')),
      continuation: STATUS('see the dialogs and whether the Studio UI answers') };
  return failure(error, call('open-module', args));
}

// ---- Module names (C41). Pure helpers first, then the resolution over the open modules and the inventory.
// Letters and digits only, lower case: "GameStore CS", "gamestore_cs" and "GameStore_CS" are one name.
export const squashName = name => String(name ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function distance(a, b) {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}
// Pure: the module a name means among the known names ({name} | {ambiguous: [...]} | {suggestions: [...]}), exact
// first (case-insensitive), then by letters and digits; otherwise up to 5 suggestions, closest first.
export function matchModuleName(wanted, names, limit = 5) {
  const known = [...new Set((names ?? []).filter(n => typeof n === 'string' && n.trim()))];
  const exact = known.filter(n => n.toLowerCase() === String(wanted).trim().toLowerCase());
  if (exact.length === 1) return { name: exact[0] };
  const key = squashName(wanted);
  const same = known.filter(n => squashName(n) === key);
  if (same.length === 1) return { name: same[0] };
  if (same.length > 1) return { ambiguous: same };
  const scored = known.map(n => { const k = squashName(n); return { n, score: k.includes(key) || key.includes(k) ? Math.abs(k.length - key.length) / 10 : distance(k, key) }; })
    .filter(s => s.score <= Math.max(3, Math.floor(key.length / 3))).sort((a, b) => a.score - b.score || a.n.localeCompare(b.n));
  return { suggestions: scored.slice(0, limit).map(s => s.n) };
}

// The newest inventory.json of o11_environment (inventory) for a host, from <lane .local>/environment/inventory/<time>/;
// null when there is none. Without a host it answers only when every inventory there is of one environment (otherwise
// the newest could be another environment's). Cached per file and modification time: a second resolution reads nothing.
const inventoryCache = new Map();
const field = (row, name) => row?.[name] ?? row?.[name[0].toLowerCase() + name.slice(1)];
function inventoryAt(file) {
  let stat; try { stat = fs.statSync(file); } catch { return null; }
  const cacheKey = file + '|' + stat.mtimeMs;
  let value = inventoryCache.get(cacheKey);
  if (!value) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      value = { host: String(field(data, 'Host') ?? '').toLowerCase() || null, at: field(data, 'CapturedAtUtc') ?? field(data, 'ExportedAt') ?? new Date(stat.mtimeMs).toISOString(),
        file, modules: (field(data, 'Modules') ?? []).map(m => ({ name: field(m, 'Name'), key: field(m, 'Key') ?? null, app: field(m, 'ApplicationName') ?? null })).filter(m => typeof m.name === 'string') };
    } catch { return null; }
    inventoryCache.set(cacheKey, value);
  }
  return value;
}
export function readInventory({ local, host } = {}) {
  const base = path.join(local, 'environment', 'inventory');
  let folders = [];
  try { folders = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse(); } catch { return null; }
  const all = folders.map(folder => inventoryAt(path.join(base, folder, 'inventory.json'))).filter(Boolean);
  if (host) return all.find(value => !value.host || value.host === String(host).toLowerCase()) ?? null;
  return new Set(all.map(value => value.host)).size === 1 ? all[0] : null;
}

// {ok:true, name} to open, or the MODULE_NOT_FOUND / MODULE_AMBIGUOUS refusal (nothing was asked of the Studio).
// Without an inventory of the environment nothing is read here: the bridge's open_module answers as before.
async function resolveModuleName(bridge, args, ctx) {
  if (args.moduleKey) return { ok: true, name: args.name };
  let inventory = null;  // reassigned by the one re-read after a creation (below)
  try { inventory = ctx?.inventory ? await ctx.inventory({ host: args.environment ?? null }) : null; } catch { inventory = null; }
  if (!inventory?.modules?.length) return { ok: true, name: args.name };
  const inInventory = matchModuleName(args.name, inventory.modules.map(m => m.name));
  if (inInventory.name) return { ok: true, name: inInventory.name };
  // A module open in the Studio but not in the inventory (created after it, never published) still opens.
  let listed = null;
  try { listed = await bridge.ok('list_open_modules', {}, { timeoutMs: 5000 }); } catch (error) { if (abortsWait(error)) throw error; listed = null; }
  const open = (listed?.modules ?? []).filter(m => m?.hasESpace !== false).map(m => m.name);
  let found = matchModuleName(args.name, [...open, ...inventory.modules.map(m => m.name)]);
  if (found.name) return { ok: true, name: found.name };
  // vel-entrega (lentidão 2026-10-12, MODULE_NOT_FOUND right after a create-app): a name missing from an inventory older
  // than the last creation that answered ok (create-app, add-modules, create-module) reads the inventory ONCE more.
  const last = !found.ambiguous && ctx?.lastCreation ? ctx.lastCreation() : null;
  if (last && ctx?.rereadInventory && Date.parse(last) > Date.parse(inventory.at)) {
    const host = inventory.host ?? args.environment ?? null;
    let fresh = null;
    try { if ((await ctx.rereadInventory({ host }))?.ok === true) fresh = await ctx.inventory({ host }); } catch (error) { if (abortsWait(error)) throw error; fresh = null; }
    if (fresh?.modules?.length) {
      found = matchModuleName(args.name, [...open, ...fresh.modules.map(m => m.name)]);
      if (found.name) return { ok: true, name: found.name, inventoryReread: true };
      inventory = fresh;
    }
  }
  const refresh = { tool: 'o11_environment', arguments: { action: 'inventory', ...(inventory.host ? { host: inventory.host } : {}) },
    why: 'if the module was created after the inventory of ' + inventory.at + ', read the inventory again' };
  if (found.ambiguous) return { ok: false, code: 'MODULE_AMBIGUOUS', name: args.name, candidates: found.ambiguous,
    error: 'Several modules of the environment match ' + args.name + '; nothing was opened.',
    continuation: { ...call('open-module', { name: found.ambiguous[0] }), why: 'open one of the candidates by its exact name' } };
  return { ok: false, code: 'MODULE_NOT_FOUND', name: args.name, suggestions: found.suggestions, inventoryAt: inventory.at, ...(inventory.host ? { host: inventory.host } : {}),
    error: 'No module named ' + args.name + ' in the environment inventory' + (inventory.host ? ' of ' + inventory.host : '') + '; nothing was opened.',
    continuation: found.suggestions.length ? { ...call('open-module', { name: found.suggestions[0] }), why: 'the closest name of the inventory; or ' + refresh.why } : refresh };
}

async function openModule(bridge, args, ctx) {
  // A29: a system module is never opened, by the name given or by the name the inventory resolves it to.
  if (systemModuleName(args.name)) return systemModuleRefusal(args.name);
  const resolved = await resolveModuleName(bridge, args, ctx);
  if (resolved.ok !== true) return resolved;
  if (systemModuleName(resolved.name)) return systemModuleRefusal(resolved.name);
  if (resolved.name !== args.name) args = { ...args, name: resolved.name };
  const params = { name: args.name, ...(args.app ? { app: args.app } : {}), ...(args.environment ? { environment: args.environment } : {}),
    ...(args.moduleKey ? { module_key: args.moduleKey } : {}), timeout: args.timeoutSeconds, silent: true };
  let data;
  try { data = await bridge.ok('open_module', params); } catch (error) { return openFailure(error, args); }
  // MB2: the dependencies dialog stopped the open: answered (Cancel), the module opens again in this call.
  let closed = null;
  if (Array.isArray(data?.blockedBy) && dependenciesCandidate(data.blockedBy) && (closed = await closeDependenciesDialog(bridge))) {
    try { data = await bridge.ok('open_module', params); } catch (error) { return openFailure(error, args); }
  }
  if (Array.isArray(data?.blockedBy) && data.blockedBy.length) {
    const dialogs = data.blockedBy.map(projectDialog);
    return { ok: false, code: 'DIALOG_BLOCKING', name: args.name, dialogs, ...(closed ? { dependenciesDialog: { answered: closed.answered } } : {}), continuation: dialogs[0].next };
  }
  const name = data?.name ?? args.name;
  // MB2: a module whose references the Studio could not check (its check stops behind the dialog) or found outdated may have
  // the dependencies dialog open after the load; it is answered here too, and the references of the module refreshed.
  if (!closed && data?.opened === true && (data.referencesCheck === 'skipped' || data.referencesOutdated === true)) closed = await closeDependenciesDialog(bridge);
  let refreshed = null;
  if (closed) {
    refreshed = await refreshAfterDialog(bridge, closed, { module: name, key: args.moduleKey ?? null, environment: args.environment ?? null, signal: ctx?.signal });
    if (refreshed.ok !== true) return refreshed;
  }
  return { ok: data?.opened === true, name, opened: data?.opened === true, alreadyOpen: data?.alreadyOpen === true,
    ...(data?.referencesOutdated === true && !refreshed ? { referencesOutdated: true } : {}),
    ...(refreshed ? { dependenciesDialog: refreshed.dependenciesDialog, referencesRefreshed: refreshed.referencesRefreshed } : {}), elapsedMs: data?.elapsedMs ?? null };
}

const stamp = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14); // UTC yyyyMMddHHmmss
async function snapshot(bridge, args, ctx) {
  if (args.module) {
    const opened = await openModule(bridge, { name: args.module, timeoutSeconds: 120 }, ctx); if (!opened.ok) return opened;
    args = { ...args, module: opened.name ?? args.module };
  }
  let active = await bridge.ok('get_active_module');
  if (args.module && String(active.name).toLowerCase() !== args.module.toLowerCase()) {
    // A tab of the Studio's second window is never the active module: captured by its key (merge_from_oml:module_key).
    const found = await moduleTab(bridge, args.module);
    if (found.ambiguous) return tabAmbiguous(args.module, found.ambiguous);
    if (!found.tab) return { ok: false, code: 'MODULE_NOT_ACTIVE', module: args.module, active: active.name, continuation: { ...call('open-module', { name: args.module }), why: 'select the module before the capture' } };
    active = { name: found.tab.name, key: found.tab.key, environment: found.tab.environment ?? null };
  }
  const file = args.path ?? path.join(o11LaneOf(ctx.lane, { root: ctx.root, env: ctx.env }).local, 'snapshots',
    String(active.name).replace(/[^\w.-]/g, '_') + '-' + stamp(ctx.now()) + '.oml');
  // module_key pins the capture to the module just read: the bridge refuses if another tab became active meanwhile.
  const data = await bridge.ok('snapshot_module', { path: file, module_key: active.key });
  // vel-entrega: a known capture of the module for the next delivery's build phase (o11-capture-store.mjs).
  if (typeof data?.path === 'string' && typeof data.key === 'string')
    rememberCapture(o11LaneOf(ctx.lane, { root: ctx.root, env: ctx.env }).local, { moduleKey: data.key, module: data.name ?? null, file: data.path, source: 'o11_studio' });
  return { ok: true, path: data.path, sha256: data.sha256, module: data.name, key: data.key, environment: data.environment ?? null, snapshotId: data.snapshot_id ?? null };
}

// ---- The last 1-Click Publish (bridge publish_log, kernel\src\Anvil.Bridge\PublishLogHandler.cs): what the Studio shows
// in its 1-Click Publish tab for the module, whoever published (the person or o11_publish): status, stage, every
// compilation/deployment message with type, text, element and stage. TrueChange (errors) does not see these.
const OLD_BRIDGE = /^(\w+Exception:\s*)?Unknown method: publish_log/;
const NOT_OPEN = /is not open in the Studio/;
const clip = (text, max) => { const s = String(text ?? '').trim(); return s.length > max ? s.slice(0, max) + '...' : s; };
const elementOf = e => (e ? { ...(e.name ? { name: e.name } : {}), ...(e.key ? { key: e.key } : {}), ...(e.kind ? { kind: e.kind } : {}),
  ...(e.path ? { path: e.path } : {}), ...(e.ambiguous ? { ambiguous: e.ambiguous } : {}) } : undefined);

// Pure: what to do after a failed publication, an MCP call that points at the element to fix (or the full log).
// An assertion in the server's module generator is not a diagnosis of an Entry,
// widget or reference. Keep it separate from element-level compiler errors.
export function publishCompilerDiagnosis(log) {
  const error = (log?.messages ?? []).find(m => m?.type === 'Error'
    && /\bESpace\.Dump\s*\(/.test([m.text, m.detail, m.extraInfo].filter(Boolean).join('\n')));
  return error ? { code: 'COMPILER_ESPACE_DUMP', phase: 'server-code-generation', causeKnown: false,
    localVerifyProvesCompilation: false,
    evidenceNeeded: ['failing-module-capture', 'server-compiler-error-detail', 'comparison-with-compiling-capture'] } : null;
}

export function publishFixContinuation(log, module) {
  if (publishCompilerDiagnosis(log)) return {
    tool: 'o11_service_center_read',
    arguments: { action: 'logs', kind: 'error', source: 'CompilerService', message: 'Invalid compiler output', limit: 20,
      ...(log?.environment ? { host: log.environment } : {}) },
    why: 'ESpace.Dump failed during server code generation; the cause is not identified. Preserve the failing module capture and publication receipt, read the server error detail, and compare against a compiling capture. CompilerService errors may have no module attribution. Local Verify is not a compilation proof; do not recreate the module or repeat unchanged publication as a guessed repair.'
  };
  const first = (log?.messages ?? []).find(m => m?.type === 'Error');
  const target = log?.module ?? module;
  const where = first?.element?.name ? ' in ' + first.element.name : '';
  const why = 'The publication of ' + (target ?? 'the module') + ' failed' + (log?.failedStage ? ' at stage ' + log.failedStage : '')
    + (first ? ': ' + clip(first.text, 200) + (first.detail ? ' (' + clip(first.detail, 200) + ')' : '') : '')
    + '. Fix it' + where + ' in the module and publish again (the person in the Studio, or o11_publish with the user\'s words).';
  if (first?.element?.name && target) return { tool: 'ssam_map', arguments: { lane: 'o11', target, name: first.element.name }, why };
  return { ...call('publish-log', target ? { module: target } : undefined), why };
}

// What publish-log can see, said in every answer (Astra item 3, 2026-10-05: after o11_environment refresh-refs answered
// published:true, publish-log kept showing the previous publication): only the 1-Click Publish tabs of this Service Studio,
// whoever started them (the person, o11_publish, o11_deliver publish:true). A publication made elsewhere (o11_environment
// refresh-refs, create-module or set-user-provider publish through the environment session; o11_extension; Service
// Center; another Studio) never reaches those tabs: its record is the module's versions in Service Center.
export const PUBLISH_LOG_SCOPE = 'the 1-Click Publish tabs of this Service Studio (the person, o11_publish, o11_deliver publish:true)';
export function otherPublications(data, module) {
  const moduleKey = data?.moduleKey ?? null;
  return { tool: 'o11_service_center_read', arguments: { action: 'versions', ...(moduleKey ? { moduleKey } : { module: data?.module ?? module ?? '<Module>' }), ...(data?.environment ? { host: data.environment } : {}) },
    why: 'publications made outside this Studio (o11_environment refresh-refs/create-module/set-user-provider, o11_extension, Service Center, another Studio) are module versions in Service Center, not tabs here' };
}

// Pure: the answer of publish-log from the bridge's publish_log data.
export function publishLogView(data, { module } = {}) {
  const scope = { observes: PUBLISH_LOG_SCOPE, elsewhere: otherPublications(data, module) };
  if (data?.found !== true) return { ok: true, found: false, module: data?.module ?? module ?? null, moduleKey: data?.moduleKey ?? null, environment: data?.environment ?? null,
    reason: data?.reason ?? 'no publication to read', ...scope };
  const value = { ok: true, found: true, module: data.module ?? module ?? null, moduleKey: data.moduleKey ?? null, environment: data.environment ?? null, ...scope, status: data.status,
    operation: data.operation ?? null, ...(data.failedStage ? { failedStage: data.failedStage } : {}), stage: data.stage ?? null,
    startedAt: data.startedAt ?? null, endedAt: data.endedAt ?? null, lastUploadDateTime: data.lastUploadDateTime ?? null,
    triggeredBy: data.triggeredBy ?? null, serverOperationId: data.serverOperationId ?? null, errors: data.errors ?? 0, warnings: data.warnings ?? 0,
    steps: (data.steps ?? []).map(s => ({ stage: s.stage, text: s.text, ...(s.shownAt ? { shownAt: s.shownAt } : {}) })),
    messages: (data.messages ?? []).map(m => ({ type: m.type, stage: m.stage, text: m.text, ...(m.detail ? { detail: m.detail } : {}),
      ...(m.element ? { element: elementOf(m.element) } : {}), ...(m.extraInfo ? { extraInfo: m.extraInfo } : {}), ...(m.id ? { id: m.id } : {}),
      ...(m.shownAt ? { shownAt: m.shownAt } : {}) })),
    ...(data.omitted ? { omitted: data.omitted } : {}) };
  if (data.status === 'failed') {
    value.continuation = publishFixContinuation(data, module);
    const diagnosis = publishCompilerDiagnosis(data);
    if (diagnosis) value.diagnosis = diagnosis;
  }
  return value;
}

// Pure: section 3.2 lastPublication of deliver/publish answers from the bridge's publish_log data; null when the source
// says found:false (the field is then omitted). by: triggeredBy "bridge" is SSAM, "studio" is the person.
export function lastPublicationOf(data) {
  if (data?.found !== true) return null;
  const status = ['succeeded', 'failed', 'running'].includes(data.status) ? data.status : 'unknown';
  const by = data.triggeredBy === 'bridge' ? 'ssam' : data.triggeredBy === 'studio' ? 'person' : 'unknown';
  return { at: data.endedAt ?? data.startedAt ?? data.lastUploadDateTime ?? null, status, version: data.version ?? null,
    author: data.author ?? data.user ?? null, by, source: 'publish-log' };
}

// Pure: the short form inside `errors`.
export function lastPublishSummary(data) {
  if (data?.found !== true) return { found: false, ...(data?.reason ? { reason: data.reason } : {}) };
  const firstErrors = (data.messages ?? []).filter(m => m?.type === 'Error').slice(0, 3)
    .map(m => ({ stage: m.stage, text: clip(m.text, 300), ...(m.detail ? { detail: clip(m.detail, 300) } : {}), ...(m.element ? { element: elementOf(m.element) } : {}) }));
  return { found: true, status: data.status, ...(data.failedStage ? { failedStage: data.failedStage } : {}), at: data.endedAt ?? data.startedAt ?? null,
    triggeredBy: data.triggeredBy ?? null, errors: data.errors ?? 0, warnings: data.warnings ?? 0, ...(firstErrors.length ? { firstErrors } : {}),
    next: { ...call('publish-log', data.module ? { module: data.module } : undefined), why: 'every message of the last publication, with stage and element' } };
}

async function publishLog(bridge, args) {
  let data;
  try { data = await bridge.ok('publish_log', { max: args.max, ...(args.module ? { module: args.module } : {}) }); }
  catch (error) {
    const message = error?.message ?? '';
    if (!TRANSPORT.has(error?.code) && OLD_BRIDGE.test(message))
      return { ok: false, code: 'BRIDGE_OUTDATED', error: 'this Service Studio bridge has no publish_log yet; the person still sees the publish messages in the Studio',
        continuation: { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'shows the version of the O11 bridge; the new bridge applies to the next Studio opened' } };
    if (!TRANSPORT.has(error?.code) && NOT_OPEN.test(message))
      return { ok: false, code: 'MODULE_NOT_OPEN', module: args.module, error: translateDialogHint(message.replace(/^\w+Exception:\s*/, '')),
        continuation: STATUS('see the open modules; the log is the one of the module tab in the Studio') };
    throw error;
  }
  return publishLogView(data, args);
}

// errors {module} (A24): the TrueChange of that open module, read by its key (get_errors module_key, bridge C41) without
// selecting its tab; a module no tab has is refused with the call that opens it (a system one with ssam_map). An older
// bridge reads only the selected tab: MODULE_NOT_ACTIVE with the call that selects it.
const NOT_TARGET = /no longer active|not open in any Studio tab/i;
async function errorsTarget(bridge, module) {
  const listed = await bridge.ok('list_open_modules', {}, { timeoutMs: 10000 });
  const tabs = (listed?.modules ?? []).filter(m => m && m.hasESpace !== false && typeof m.name === 'string' && m.name && typeof m.key === 'string' && m.key);
  const resolved = resolveOpenModule(module, { open: tabs, lane: 'o11' });
  if (resolved.ok !== true) return { refusal: { ...resolved, module,
    continuation: { ...call('errors', { module: resolved.candidates?.[0] ?? module }), why: 'repeat with the exact name of one of the open modules' } } };
  const named = tabs.filter(m => m.name === resolved.module || m.key === resolved.module);
  if (resolved.via !== 'unresolved' && named.length === 1) return { tab: named[0] };
  if (systemModuleName(module)) return { refusal: systemModuleRefusal(module) };
  return { refusal: { ok: false, code: 'MODULE_NOT_OPEN', module, openModules: tabs.map(m => m.name), outcome: 'not-sent',
    error: module + ' is not open in the Studio; its errors are read from its tab. Nothing was opened.',
    continuation: { ...call('open-module', { name: module }), why: 'opens the module in the Studio; then repeat errors {module}' } } };
}
async function errors(bridge, args) {
  let tab = null;
  if (args.module) {
    const found = await errorsTarget(bridge, args.module);
    if (found.refusal) return found.refusal;
    tab = found.tab;
  }
  let data, last;
  try {
    [data, last] = await Promise.all([bridge.ok('get_errors', { max: args.max, ...(args.since ? { since: args.since } : {}), ...(tab ? { module_key: tab.key } : {}) }),
      bridge.ok('publish_log', { max: 20, ...(tab ? { module: tab.name } : {}) }).then(value => ({ value }), error => ({ error }))]);
  } catch (error) {
    if (tab && !TRANSPORT.has(error?.code) && NOT_TARGET.test(error?.message ?? ''))
      return { ok: false, code: 'MODULE_NOT_ACTIVE', module: tab.name, outcome: 'not-sent', error: 'This Studio bridge reads the errors of the selected tab only; nothing was read.',
        continuation: { ...call('open-module', { name: tab.name }), why: 'selects the tab of the module; then repeat errors {module}' } };
    throw error;
  }
  const lastPublish = last.value ? lastPublishSummary(last.value)
    : { available: false, reason: OLD_BRIDGE.test(last.error?.message ?? '') ? 'this Studio bridge has no publish_log yet' : translateDialogHint(last.error?.message ?? String(last.error)) };
  return { ok: true, ...(tab ? { module: tab.name, key: tab.key } : {}), isValid: data.isValid, errors: data.errors, warnings: data.warnings,
    messages: (data.messages ?? []).slice(0, args.max), byType: data.byType ?? {},
    ...(args.since ? { since: args.since, newErrors: data.newErrors ?? null, new: (data.new ?? []).slice(0, args.max) } : {}), lastPublish };
}

async function windows(bridge, args) {
  const data = await bridge.ok('windows', args.maxTexts === undefined ? {} : { max_texts: args.maxTexts });
  return { ok: true, count: data.count, windows: (data.windows ?? []).map(({ title, type, isVisible, isActive, isModal, contentKind, owner, texts }) =>
    // CX14 R2: what the person typed in a dialog (a TextBox) is never returned (the rule of dialogsFromWindows).
    ({ title, type, isVisible, isActive, isModal, contentKind, ...(owner ? { owner } : {}), texts: Array.isArray(texts) ? withoutTypedText(texts) : texts })) };
}

// close_dialog {title, type?} closes every visible OWNED window with that exact title (WindowsHandler.CloseDialog);
// An ownerless error report is closable only when the bridge advertises its title-based dialog watcher.
async function dismissDialog(bridge, args) {
  const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  const listing = await bridge.ok('windows', { max_texts: 0 });
  const matches = (listing.windows ?? []).filter(w => w.isVisible !== false && same(w.title, args.title) && (!args.type || same(w.type, args.type)));
  if (!matches.length)
    return { ok: false, code: 'DIALOG_NOT_FOUND', title: args.title,
      open: (listing.windows ?? []).filter(w => w.isVisible && (w.isModal || String(w.type).includes('DialogWindow'))).map(w => ({ title: w.title, type: w.type })),
      continuation: STATUS('see the pending dialogs and their titles') };
  if (!matches.some(w => w.isModal === true)) {
    const web=matches.some(w=>w.contentKind==='web'||String(w.type).includes('DialogWindow'));
    if(web) {
      if(!(isErrorReportTitle(args.title)&&await bridgeOffers(bridge,'merge_from_oml:dialog_watch')))
        return {ok:false,code:'WEB_DIALOG',title:args.title,error:'a web dialog without owner cannot be closed by the bridge',continuation:WAIT_NO_DIALOGS};
    } else return {ok:false,code:'NOT_A_DIALOG',title:args.title,error:'that window has no owner (the main window); nothing was closed'};
  }
  const data = await bridge.ok('close_dialog', { title: args.title, ...(args.type ? { type: args.type } : {}) });
  const closed = data?.closed ?? [];
  if (closed.some(c => String(c).startsWith('FAILED'))) return { ok: false, code: 'DIALOG_CLOSE_FAILED', closed, continuation: WAIT_NO_DIALOGS };
  if (!closed.length) return { ok: false, code: 'DIALOG_NOT_FOUND', title: args.title, continuation: STATUS('the dialog is no longer open; see the state') };
  return { ok: true, closed };
}

// studio_login opens the Studio's own sign-in (ScApiHandler.Login); the person types the password or completes SSO
// there. Never the bridge `login` verb (it reads a credential file) and never a credential argument.
async function login(bridge, args, ctx) {
  const started = ctx.now(); const timeoutMs = args.timeoutSeconds * 1000;
  const opened = await bridge.ok('studio_login', { host: args.host, waitMs: Math.min(5000, timeoutMs) });
  if (opened?.signedIn === true) return { ok: true, host: args.host, signedIn: true, dialogOpened: opened.dialogOpened === true, waitedMs: ctx.now() - started };
  if (opened?.pending !== true && opened?.accepted === false)
    return { ok: false, code: 'LOGIN_NOT_COMPLETED', host: args.host, continuation: { ...call('login', { host: args.host }), why: 'the sign-in was cancelled in the Studio; repeat only if the person wants to' } };
  let idle = 0; // two reads in a row with no pending sign-in and no session: the person closed it
  const outcome = await poll(async remaining => {
    const state = await CHECKS['signed-in'](bridge, args, remaining);
    idle = !state.done && state.view.loginPending === false && !state.view.error ? idle + 1 : 0;
    return { ...state, stop: idle >= 2 };
  }, Math.max(0, timeoutMs - (ctx.now() - started)), ctx);
  if (outcome.done) return { ok: true, ...outcome.view, waitedMs: ctx.now() - started };
  if (outcome.stop) return { ok: false, code: 'LOGIN_NOT_COMPLETED', host: args.host, last: outcome.view,
    continuation: { ...call('login', { host: args.host }), why: 'the sign-in was closed in the Studio without signing in; repeat only if the person wants to' } };
  return { ok: false, code: 'WAIT_TIMEOUT', condition: 'signed-in', waitedMs: ctx.now() - started, last: outcome.view,
    continuation: { ...call('wait', { condition: 'signed-in', host: args.host }), why: 'the person still has to finish the sign-in in the Studio' } };
}

// ---- refresh-references (C26): the Studio's own Refresh References on the open consumer, through the bridge verb
// refresh_references (RefreshReferencesHandler.cs, capability refresh_references). module: the consumer (opened and
// selected first); producers: the references to refresh (all of the module when absent). The refresh is one Studio
// command (Ctrl+Z undoes it); nothing is published.
const OLD_REFRESH = /^(\w+Exception:\s*)?Unknown method: refresh_references/;
async function refreshReferences(bridge, args, ctx) {
  if (args.module) {
    const opened = await openModule(bridge, { name: args.module, environment: args.environment, timeoutSeconds: 120 }, ctx); if (!opened.ok) return opened;
    args = { ...args, module: opened.name ?? args.module };
  }
  let active = await bridge.ok('get_active_module');
  if (args.module && (!sameName(active.name, args.module) || args.environment && !sameName(active.environment, args.environment))) {
    // A tab of the Studio's second window is never the active module: refreshed by its key (merge_from_oml:module_key).
    const found = await moduleTab(bridge, args.module, { environment: args.environment });
    if (found.ambiguous) return tabAmbiguous(args.module, found.ambiguous);
    if (!found.tab) return { ok: false, code: 'MODULE_NOT_ACTIVE', module: args.module, active: active.name, continuation: { ...call('open-module', { name: args.module }), why: 'select the module before the refresh' } };
    active = { name: found.tab.name, key: found.tab.key, environment: found.tab.environment ?? null };
  }
  // fix-ext-refs: add/published are the Studio's own Manage Dependencies; a bridge without it would run the plain Refresh
  // References and add nothing, so the call is refused before anything is sent, with the exact continuation.
  const manage = Array.isArray(args.add) || args.published === true;
  if (manage && !(await bridgeOffers(bridge, MANAGE_DEPENDENCIES_CAPABILITY)))
    return hostedContext() ? manageDependenciesHostedPending(active.name) : { ok: false, code: 'BRIDGE_OUTDATED', module: active.name, executed: false, outcome: 'not-sent',
      error: 'The Service Studio runs a bridge without the Studio\'s own Manage Dependencies (capability ' + MANAGE_DEPENDENCIES_CAPABILITY + '); nothing was sent, added or refreshed.',
      continuation: { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'Shows the O11 bridge version; the current bridge loads with the next Service Studio opened (the "Service Studio (SSAM)" shortcut). Then repeat this call.' } };
  const producers = manage ? [...new Set([...(args.producers ?? []), ...(args.add ?? []).map(a => a.producer)])] : args.producers;
  let data, closed = null;
  const refresh = () => bridge.ok('refresh_references', { module_key: active.key, ...(active.environment ? { environment: active.environment } : {}),
    ...(producers?.length ? { producers } : {}), ...(manage && args.add ? { add: args.add.map(a => ({ producer: a.producer, elements: a.elements })) } : {}),
    ...(manage && args.published ? { published: true } : {}), timeout: args.timeoutSeconds }, { ...(ctx.signal ? { signal: ctx.signal } : {}) });
  try {
    try { data = await refresh(); }
    catch (error) {
      // MB2: the dependencies dialog asks for exactly this refresh; answered (Cancel), the refresh runs in this call.
      if (TRANSPORT.has(error?.code) || !/dialog or merge editor pending/i.test(error?.message ?? '') || !(closed = await closeDependenciesDialog(bridge))) throw error;
      data = await refresh();
    }
  } catch (error) {
    if (error?.code === 'CANCELLED') return cancelled({ module: active.name });
    const message = error?.message ?? '';
    if (!TRANSPORT.has(error?.code) && OLD_REFRESH.test(message))
      return { ok: false, code: 'BRIDGE_OUTDATED', module: active.name, error: 'this Service Studio bridge has no refresh_references yet; nothing was refreshed',
        continuation: { tool: 'ssam_doctor', arguments: { lane: 'o11' }, why: 'shows the version of the O11 bridge; the new bridge applies to the next Studio opened (until then, Refresh References in the Manage Dependencies of the Studio)' } };
    if (error?.reply && error?.code && error.code !== 'BRIDGE_ERROR' && error.code !== 'BRIDGE_REFUSED')
      return { ok: false, code: error.code, module: active.name, ...(error.executed === false ? { executed: false } : {}), error: translateDialogHint(message.replace(/^\w+Exception:\s*/, '')),
        continuation: STATUS('see the Studio; nothing was published') };
    throw error;
  }
  // a8 round 2 (review M1): a refresh or a Manage Dependencies the Studio holds with a dialog (blocked: a bridge that could not
  // close it) is still running in the Studio: never ok, never the shape of a command that ended.
  if (data?.blocked === true) {
    const command = data?.command ?? (manage ? 'Manage Dependencies' : 'Refresh References');
    const title = data?.blockedBy?.title ?? data?.blockedBy?.kind ?? 'a dialog';
    return { ok: false, code: 'STUDIO_DIALOG_PENDING', module: data?.module ?? active.name, outcome: 'running', command, blockedBy: data?.blockedBy ?? null,
      ...(Array.isArray(data?.dialogs) && data.dialogs.length ? { dialogs: data.dialogs } : {}),
      error: 'A Studio dialog is open: "' + title + '". It opened during the ' + command + ' of ' + (data?.module ?? active.name)
        + ' and the command waits for it in the Studio: it may still change the module when the person answers it (Ctrl+Z undoes it). Nothing else was sent.',
      ...(data?.next ? { next: data.next } : {}),
      continuation: { tool: 'o11_studio', arguments: { command: 'windows' }, why: 'shows the dialog; the person answers it in the Studio, then check the module (o11_studio status) before repeating this call' } };
  }
  // fix-ext-refs: a Manage Dependencies the Studio refused committed nothing: one refusal with every problem and its fix.
  // a8 round 2 (IP option D): the thin bridge answers each problem with its cause and facts; the texts are written here.
  if (manage && data?.committed === false) {
    const problems = Array.isArray(data?.problems) ? renderManageProblems(data.problems, data?.module ?? active.name) : null;
    return { ok: false, code: data?.code ?? 'REFERENCES_NOT_ADDED', module: data?.module ?? active.name, outcome: 'not-applied', command: data?.command ?? 'Manage Dependencies',
      error: 'The Studio\'s Manage Dependencies added nothing; the module is unchanged' + (problems?.length
        ? ': ' + problems.map(p => p?.message + (p?.fix ? ' Fix: ' + p.fix : '')).join(' ') : data?.error ? ': ' + data.error : '.'),
      ...(problems ? { problems } : {}), ...(data?.stage ? { stage: data.stage } : {}),
      ...(Array.isArray(data?.dialogs) && data.dialogs.length ? { dialogs: data.dialogs } : {}),
      continuation: STATUS('the Studio is unchanged; follow the fix of each problem, then repeat this call') };
  }
  // a8 round 3 (re-review N2): a command that ended keeps the windows the bridge closed (closed true) or left to the person
  // (closed false) during it, as the delivery does (refreshDialogs).
  const windows = Array.isArray(data?.dialogs) && data.dialogs.length ? { dialogs: data.dialogs } : {};
  if (manage) return { ok: true, module: data?.module ?? active.name, command: data?.command ?? 'Manage Dependencies', committed: data?.committed === true, changed: data?.changed === true,
    added: data?.added ?? [], ...(data?.alreadyReferenced?.length ? { alreadyReferenced: data.alreadyReferenced } : {}), references: data?.references ?? [],
    refreshed: data?.refreshed ?? [], ...(Number.isInteger(data?.newErrors) ? { newErrors: data.newErrors } : {}), ...(data?.undo ? { undo: data.undo } : {}),
    ...windows, ...(closed ? { dependenciesDialog: { answered: closed.answered } } : {}) };
  return { ok: true, module: data?.module ?? active.name, changed: data?.changed === true, refreshed: data?.refreshed ?? [], ...(data?.upToDate?.length ? { upToDate: data.upToDate } : {}),
    ...(data?.missing?.length ? { missing: data.missing } : {}), ...(Number.isInteger(data?.newErrors) ? { newErrors: data.newErrors } : {}),
    ...(data?.undo ? { undo: data.undo } : {}), ...windows, ...(closed ? { dependenciesDialog: { answered: closed.answered } } : {}) };
}

// ---- close-module (C22, a client session of 2026-10-07): closes the module's tab in whatever window holds it (bridge close_module,
// OpenHandler.Close). With about ten open tabs the Studio moves some into a second window; agents close the tabs they no
// longer need. The bridge's own guard keeps a tab with unsaved changes, still opening or with a pending operation:
// MODULE_TAB_NOT_CLOSABLE, nothing lost, and a 1-Click Publish (which saves) comes first. Two tabs with the name:
// MODULE_TAB_AMBIGUOUS, and moduleKey picks the tab. An already closed tab answers ok with alreadyClosed.
// UI freeze of 2026-10-08 (pattern 1): a bridge with close_module:idle_gate closes only an idle tab. A tab still finishing
// a publication (or with a server operation, a headless publication, a nested step) answers MODULE_BUSY, nothing closed,
// and the next call is wait idle, then close-module again. A UI thread that did not run the step answers UI_BUSY.
const CLOSE_GUARD = /unsaved changes|is opening|pending operation/i;
export const MODULE_BUSY = 'MODULE_BUSY';
export const UI_BUSY = 'UI_BUSY';
async function closeModule(bridge, args) {
  let data;
  try { data = await bridge.ok('close_module', { name: args.name, ...(args.moduleKey ? { module_key: args.moduleKey } : {}) }); }
  catch (error) {
    const message = String(error?.message ?? '');
    if (TRANSPORT.has(error?.code)) throw error;
    if (error?.code === MODULE_BUSY) {
      const busy = error.reply?.data?.busy ?? null;
      return { ok: false, code: MODULE_BUSY, module: args.name, busy, executed: false, outcome: 'not-sent', error: message.replace(/^close_module:\s*/, ''),
        continuation: { ...call('wait', { condition: 'idle', timeoutSeconds: 120 }), why: 'the tab is still finishing Studio work (publication, refresh); wait until it is idle and close it again with close-module' } };
    }
    if (error?.code === UI_BUSY) return uiBusy(error, args.name);
    if (CLOSE_GUARD.test(message))
      return { ok: false, code: 'MODULE_TAB_NOT_CLOSABLE', module: args.name, executed: false, outcome: 'not-sent',
        error: 'The tab of ' + args.name + ' has unsaved changes, is still opening or has a pending operation; nothing was closed.',
        continuation: { tool: 'o11_publish', arguments: { module: args.name }, why: 'the publish saves the module (with the user\'s words); then close the tab. A pending dialog: the person answers it in the Studio; or wait for the running operation' } };
    if (/multiple matching tabs/i.test(message))
      return { ok: false, code: 'MODULE_TAB_AMBIGUOUS', module: args.name, executed: false, outcome: 'not-sent', error: 'More than one tab is named ' + args.name + '; nothing was closed.',
        continuation: STATUS('shows the open tabs with the key of each; pass the moduleKey of the tab to close') };
    throw error;
  }
  return { ok: true, module: data?.name ?? args.name, closed: data?.closed !== false, ...(data?.alreadyClosed ? { alreadyClosed: true } : {}) };
}

// The open modules of the connected Service Studio, read only: ping and list_open_modules, never a dialog answered and never
// a write (ssam_app_url reads the environment of an open module with it; o11_studio status may answer the dependencies
// dialog, which a read must never do).
export async function o11OpenModules({ bridge, lane = o11Lane.lane, root = anvilRoot, env = process.env } = {}) {
  let target;
  try { target = typeof bridge === 'function' ? bridge() : bridge ?? o11Bridge(bridgeTarget({ lane, root, env })); } catch { return notConnected(); }
  let ping, list;
  try {
    ping = await target.ok('ping', {}, { timeoutMs: 3000 });
    if (ping?.bridge !== 'anvil') return notConnected();
    list = await target.ok('list_open_modules', {}, { timeoutMs: 5000 });
  } catch { return notConnected(); }
  return { ok: true, pid: ping.pid ?? null, openModules: (list?.modules ?? []).filter(m => m && m.hasESpace !== false).map(m => ({ name: m.name, environment: m.environment ?? null })),
    environments: list?.environments ?? [] };
}

const HANDLERS = { status, wait, 'open-module': openModule, 'close-module': closeModule, snapshot, errors, 'publish-log': publishLog, windows,
  'dismiss-dialog': dismissDialog, login, 'refresh-references': refreshReferences };

// The command runner behind the tool. deps: bridge (client of o11-bridge.mjs, or a function returning one; default
// the lane's target read per call, so a new ssam_connect is seen), assertSelected, lane/root/env, now/delay,
// inventory({host}) -> {host, at, modules:[{name}]} | null (default: the newest o11_environment inventory file),
// writeHolder() -> holder | null (default: the Studio write lock of this lane). run(input, {signal}).
export function o11Studio({ bridge, assertSelected = assertSelectedO11, lane = o11Lane.lane, root = anvilRoot, env = process.env,
  now = Date.now, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), inventory, writeHolder, exclusive, rereadInventory, lastCreation } = {}) {
  const local = () => o11LaneOf(lane, { root, env }).local;
  const ctx = { lane, root, env, now, delay,
    inventory: inventory ?? (({ host } = {}) => readInventory({ local: local(), host })),
    // vel-entrega: the one inventory re-read of open-module after a creation, and the time of the last creation
    rereadInventory: rereadInventory ?? (({ host } = {}) => refreshInventory({ host }, { root, lane, env, assertSelected })),
    lastCreation: lastCreation ?? (() => lastModuleCreation(local())),
    writeHolder: writeHolder ?? (() => studioWriteHolder({ tool: 'o11_studio', lane, deps: { o11Root: root, o11Lane: lane } })),
    // fn under the Studio write lock only when it is free now (queue 0); else the refusal, fn not called. Inside a write
    // that already holds the Studio (wait idle|no-dialogs), fn runs at once.
    exclusive: exclusive ?? (fn => withStudioWriteLock({ tool: 'o11_studio', args: { command: 'refresh-references' }, write: true,
      deps: { o11Root: root, o11Lane: lane, queueMs: 0 } }, fn)) };
  const client = () => (typeof bridge === 'function' ? bridge() : bridge ?? o11Bridge(bridgeTarget({ lane, root, env })));
  return async function run({ command, args } = {}, { signal } = {}) {
    if (!HANDLERS[command]) {
      const guess = matchModuleName(String(command ?? ''), COMMANDS);
      const next = guess.name ?? guess.suggestions?.[0] ?? 'status';
      return { ok: false, code: 'BAD_COMMAND', error: 'command must be one of ' + COMMANDS.join(', '), continuation: correctedCall(next, canonicalArgs(next, args)) };
    }
    args = canonicalArgs(command, args ?? {});
    const parsed = ARGS[command].safeParse(args);
    if (!parsed.success) return badArgs(command, parsed.error, args);
    // A29: a system module is refused before anything (selection check included) reaches the Studio.
    const system = systemOpen(command, parsed.data);
    if (system) return systemModuleRefusal(system);
    if (signal?.aborted) return cancelled({ command, outcome: 'not-sent' });
    if (mutates(command, parsed.data)) {
      try { await assertSelected(); } catch (error) { return notSelected(error); }
    }
    let target;
    try { target = client(); } catch { return notConnected(); }
    try { return await HANDLERS[command](target, parsed.data, signal ? { ...ctx, signal } : ctx); } catch (error) { return failure(error, call(command, parsed.data)); }
  };
}

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value?.ok === false ? { isError: true } : {}) });

export function registerO11Studio(server, deps = {}) {
  const run = o11Studio(deps);
  server.registerTool('o11_studio', {
    title: 'O11 Service Studio state, waits and dialogs',
    description: '[o11] The Service Studio of the O11 lane through its bridge, in one call: no script, credential file or sleep loop. '
      + 'Users, OutSystemsUI and System are never opened (SYSTEM_MODULE_NOT_OPENABLE): ssam_map {lane:"o11", target} reads their published OML. '
      + 'command + args (BAD_ARGS carries the corrected call). status {}: pid, version, uiResponsive/busy, active and open modules, environments, '
      + 'pending dialogs each with its next call. wait {condition: idle | no-dialogs | open | signed-in, module (open), host (signed-in; '
      + 'optional for open), timeoutSeconds 1..1800 = 600}: answers as soon as the condition holds, else WAIT_TIMEOUT with the last state; '
      + 'idle also waits for a running server operation and a running SSAM write. open-module {name (or module), app?, environment?, moduleKey?, '
      + 'timeoutSeconds 0..300 = 120}: native open that keeps the publish linkage. close-module {name (or module), moduleKey?}: closes the module\'s '
      + 'tab in any Studio window; a tab with unsaved changes is refused (MODULE_TAB_NOT_CLOSABLE: publish saves it), two tabs of that name need moduleKey. Close tabs you no longer need: about ten open tabs '
      + 'make the Studio move some into a second window (deliveries still work there, by module key). snapshot {module?, path?}: captures the active (or named) '
      + 'module to an absolute .oml with sha256, key, environment and snapshotId (for errors since). errors {max 1..500 = 60, since?, module?}: '
      + 'TrueChange of the active (or named open) module, plus lastPublish. publish-log {module?, max 1..500 = 60}: the last 1-Click Publish of the active '
      + '(or named, open) module as the Studio shows it, whoever published: status, stage and every compilation/deployment message with '
      + 'type, text, detail and element; the errors TrueChange never sees (SQL the database refuses, code generation, deploy); read only. '
      + 'It sees only this Studio\'s 1-Click Publish tabs: a publication through the environment session (o11_environment refresh-refs '
      + 'publish) is a module version in Service Center (answer elsewhere). '
      + 'windows {maxTexts?}: Studio windows and their visible texts. dismiss-dialog {title, type?}: closes an owned dialog window with that '
      + 'exact title like its X (Cancel), only when the person agreed; a web dialog without owner is refused (the person answers it in the '
      + 'Studio). login {host, timeoutSeconds = 300}: opens the Studio\'s own sign-in for host; the person types the password or completes '
      + 'SSO there. refresh-references {module?, producers?, timeoutSeconds 10..1800 = 600}: the Studio\'s own Refresh References on the '
      + 'module (the active one when absent), for the named references or all; Ctrl+Z undoes it, nothing is published. open-module and '
      + 'snapshot resolve the name by the environment inventory; an unknown name is refused with MODULE_NOT_FOUND and suggestions. '
      + 'A cancelled wait or refresh answers CANCELLED (outcome uncertain).',
    inputSchema: z.object({ command: z.enum(COMMANDS), args: z.record(z.string(), z.unknown()).optional().describe('Arguments of the command, see the description') }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => {
    let value;
    try { value = await run(input, { signal: extra?.signal }); } catch (error) { value = { ok: false, error: translateDialogHint(error?.message ?? String(error)) }; }
    return result(value);
  });
}
