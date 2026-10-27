// Destructive operations of SSAM (CX15, after the incident of 2026-10-14): a delete is NEVER one step.
//   1. A call without confirmationToken is a PREVIEW: the exact list (name, kind, application, what goes with each item,
//      consumers, data loss, backup plan), a confirmationToken bound to that list, host, operation and tool, and the
//      operationId the execution will have. Nothing is reserved or sent; the preview is a read.
//   2. The EXECUTION needs the token AND the owner's words given AFTER the preview: never the request sentence, never words
//      the server saw before the preview (on that host, within SEEN_WORDS_WINDOW_MS), never sooner than CONFIRM_MIN_AGE_MS
//      after it (no owner answers that fast), and (owner decision 2026-10-14, option C) the words state the EXACT number of
//      items of the preview as a number and naming the targets (no ready-made phrase: CX15 r2). Prefix, pattern, list and ids exist only in the preview: the
//      execution takes its targets from the token. A list read again that differs is PREVIEW_STALE with a new preview.
//   3. One durable record per operation (operations\<operationId>.json): each item not-started | backing-up | backed-up |
//      backup-failed | sending | deleted | absent | uncertain | refused, rewritten at every change, so ssam_task and the
//      next answer say item by item what happened after an interruption.
//   4. Backups before deleting land under backups\<operationId>\ (paths and sha256 in the record).
// Deterministic: no model, no network. Imports only node:*; nothing of the facade is imported here (no cycle: delete.mjs,
// odc-access.mjs, mcp.mjs, ssam.mjs and ssam-task.mjs import it). Nothing here stores the owner's words or a secret:
// words and the owner request are kept only as the sha256 of their normalized form.
// Root: SSAM_DESTRUCTIVE_ROOT, else %USERPROFILE%\.ssam-hybrid\destructive (outside the MSIX %LOCALAPPDATA%, like the
// Service Center journal): previews\, operations\, backups\<operationId>\, seen-words\<host>.jsonl.
import { appendJsonLine } from './correlation.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contextLost, hostedContext, servedWithoutContext } from './executor.mjs';

export const PREVIEW_SCHEMA = 'ssam-destructive-preview/1';
export const OPERATION_SCHEMA = 'ssam-destructive-operation/1';
// To confirm with the owner (CX15 report): how long a preview may be confirmed, the minimum age of a confirmation and how
// far back words seen on the host can never confirm.
export const PREVIEW_TTL_MS = 30 * 60 * 1000;
export const CONFIRM_MIN_AGE_MS = 5000;
export const SEEN_WORDS_WINDOW_MS = 24 * 3600 * 1000;
export const ITEM_STATES = Object.freeze(['not-started', 'backing-up', 'backed-up', 'backup-failed', 'sending', 'deleted', 'absent', 'uncertain', 'refused']);
export const OPERATION_STATES = Object.freeze(['running', 'completed', 'partial', 'cancelled', 'uncertain', 'refused']);
// The codes this module answers (the tools keep their own: WORDS_MUST_NAME, CONSUMERS_WOULD_BREAK, DELETE_REFUSED...).
export const CODES = Object.freeze({
  CONFIRMATION_REQUIRED: 'a destructive call without confirmationToken only previews; the execution is a second call',
  PREVIEW_UNKNOWN: 'the confirmationToken names no preview of this machine and client',
  PREVIEW_EXPIRED: `the preview is older than ${PREVIEW_TTL_MS / 60000} min`,
  PREVIEW_OTHER_TARGET: 'the token belongs to another tool, host, operation or target',
  PREVIEW_STALE: 'the list read again differs from the preview',
  SELECTION_ONLY_IN_PREVIEW: 'prefix, pattern, list and ids exist only in the preview',
  CONFIRMATION_TOO_SOON: `a confirmation comes at least ${CONFIRM_MIN_AGE_MS / 1000} s after its preview`,
  WORDS_BEFORE_PREVIEW: 'the words were seen before the preview',
  CONFIRMATION_COUNT_MISMATCH: 'the words state the exact number of items of the preview',
  OPERATION_CANCELLED: 'a cancelled operation never sends again',
  BACKUP_FAILED: 'the backup of an item failed; nothing was sent for it',
  DESTRUCTIVE_NEEDS_DEDICATED_TOOL: 'a passthrough never runs a destructive bridge command',
  CONFIRMATION_ALREADY_USED: 'these words already confirmed an execution of this token: a new reply of the owner is needed',
  OPERATION_INTERRUPTED: 'the process that ran the operation stopped before it ended: a new preview of what is left',
  OPERATION_RUNNING: 'another process is running this operation now',
});

// CX15 r2 (F1): no text the SERVER writes can confirm. Every template of the owner's words is this neutral marker (no
// number, no name), and the words are always the owner's own next message after the list.
export const OWNER_REPLY = "<the owner's next message after the list, verbatim>";
export const WORDS_RULE = "The words are the owner's next message after the list, copied whole: never write, complete, translate or reuse words yourself "
  + '(not the request, not a template, not a reply to another list); without such a message, ask the owner and stop.';
export const AFTER_INTERRUPTION = "Interrupted, CANCELLED, SC_LOCAL_FAILURE or another local failure, 'rejected' or no answer: read ssam_task {id:<operationId from the preview>} before telling the owner "
  + 'anything; never say nothing happened without it.';
// The common suffix of the description of every destructive tool.
export const DESTRUCTIVE_SUFFIX = 'Deletes take two calls: without confirmationToken the call only previews (the exact list with its count; nothing is sent); '
  + 'show the owner that EXACT list and ask; then call again with confirmationToken and the owner\'s reply, which states the number of items and names '
  + `the targets. ${WORDS_RULE} ${AFTER_INTERRUPTION}`;
// The ODC tools add to it: the execution's operationUuid is the one the preview answered (CX15 r2, F4.4/C11).
export const ODC_EXECUTION_UUID = "With confirmationToken, operationUuid is the preview's operationId (never a new one, never omitted).";
const ASK_AGAIN = ' Ask the owner again; never write, complete or reuse words yourself.';

const text = value => (value === null || value === undefined ? '' : String(value));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const iso = ms => new Date(ms).toISOString();
const ms = value => (typeof value === 'number' ? value : value instanceof Date ? value.getTime() : typeof value === 'function' ? ms(value()) : Date.now());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain = value => text(value).normalize('NFD').replace(/\p{M}/gu, '');
const problem = (code, message, fix, extra = {}) => ({ code, ...extra, message, fix });

export function destructiveRoot(env = process.env) {
  return env.SSAM_DESTRUCTIVE_ROOT || path.join(env.USERPROFILE || os.homedir(), '.ssam-hybrid', 'destructive');
}
// ---- the root and the client of a call (CX15 r2, T11): ONE resolution for every caller (the Service Center engine,
// ssam_task, the data gate, the odc_* guard pass no root of their own). A process that serves several clients (the hosted
// line) injects a resolver (setDestructiveRootResolver: () => {root, clientId} | root | null, read at every use) or runs
// each call inside withDestructiveScope({root, clientId}, fn); without either, the local default above. A clientId, when
// given, is part of the token and of every preview and record: another client never reads, lists or confirms them, even
// under the same root.
const scopes = new AsyncLocalStorage();
let rootResolver = null;
export function setDestructiveRootResolver(resolver) {
  const previous = rootResolver;
  rootResolver = typeof resolver === 'function' ? resolver : null;
  return previous;
}
export const withDestructiveScope = (scope, fn) => scopes.run(isObject(scope) ? { ...scope } : null, fn);
// servidor/fase4-26 (A2): a hosted call is always its customer's, whatever a resolver, a scope or a root argument says: the
// root is <ws>/state/destructive and the clientId the token of the call. A served process without its context is refused,
// never answered from the default root (every customer of the server would share it: previews, records, backups, words).
function hostedScope() {
  const context = hostedContext();
  if (context) return { root: path.join(context.workspace, 'state', 'destructive'), clientId: context.tokenId };
  if (servedWithoutContext()) throw contextLost('the destructive operations store');
  return null;
}
function currentScope() {
  const hosted = hostedScope();
  if (hosted) return hosted;
  const scoped = scopes.getStore();
  if (scoped) return scoped;
  const resolved = rootResolver ? rootResolver() : null;
  return typeof resolved === 'string' ? { root: resolved } : isObject(resolved) ? resolved : null;
}
export const currentClientId = () => text(currentScope()?.clientId).trim() || null;
const rootOf = root => hostedScope()?.root ?? root ?? (text(currentScope()?.root).trim() || destructiveRoot());
// A preview or record is seen only by the client that made it (none: only by a call without a client).
const ownedByCaller = (value, clientId = currentClientId()) => Boolean(value) && (text(value.clientId).trim() || null) === clientId;

// ---- the client's cancellation (CX15 r2, C2): the tool layer runs a call inside withSignal(ctx.mcpReq.signal, ...) and
// every execution reads it (currentSignal) right before its record, after each backup and before the send.
const signals = new AsyncLocalStorage();
export const withSignal = (signal, fn) => signals.run(signal ?? null, fn);
export const currentSignal = () => signals.getStore() ?? null;
// The record an execution of this token left while sending nothing (refused before the send, notSent): it never makes the
// token "used"; every rule runs again on the next call, which resumes the same record.
const reopenable = record => Boolean(record && record.state === 'refused' && record.notSent === true);
// The previewIds of the tokens a call carries (a tool's confirmationToken, o11_data's request and batch ops).
export function tokensOfCall(args) {
  const found = [];
  const add = token => { const parsed = parseToken(token); if (parsed && !found.includes(parsed.previewId)) found.push(parsed.previewId); };
  add(args?.confirmationToken);
  const request = isObject(args?.request) ? args.request : null;
  if (request) { add(request.confirmationToken); for (const op of Array.isArray(request.batch) ? request.batch : []) add(op?.confirmationToken); }
  return found;
}
// The step after a cancelled or lost destructive call: the record of its operation, read by the previewId of the token.
export function taskStepOfCall(args) {
  const ids = tokensOfCall(args);
  return ids.length ? { tool: 'ssam_task', arguments: { id: ids[0] }, why: 'a destructive execution may have run before the cancellation reached it: read its record (item by item) before telling the owner anything; never repeat it' } : null;
}
const hostFile = host => text(host).toLowerCase().replace(/[^a-z0-9.-]/g, '_') || 'unknown';

// Atomic writes: a temporary file renamed over the target; creation is exclusive (link fails when the file exists).
// Windows refuses a rename over a file another process holds open for a moment (a scanner, a reader): EPERM/EBUSY/EACCES
// are retried for about two seconds before the error is thrown.
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameRetrying(from, to) {
  for (let attempt = 1; ; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (error) { if (attempt >= 80 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) { fs.rmSync(from, { force: true }); throw error; } pause(25); }
  }
}
function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
  renameRetrying(temporary, file);
}
// Exclusive creation by open 'wx' (never a hard link: on Windows a file created by linking a temporary that is then removed
// refuses the later rename-over of its rewrites with EPERM). A reader that meets it half written reads nothing (readJson).
function createExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try { fs.writeSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return true;
}
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// ---- words: only the sha256 of the normalized form (NFD without marks, lower case, spaces collapsed, no punctuation at
// the ends) is ever written.
export function normalizeWords(value) {
  return plain(value).toLowerCase().replace(/\s+/g, ' ').trim().replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
}
export const wordsSha256 = value => sha256(normalizeWords(value));
// CX15 r4 (W-2, W-4): what a bridge or the kernel gets in place of the owner's words, and so what their request files,
// journals and receipts keep: 'sha256:<hex>' of the normalized words (they only require a nonempty value: DataCommands.cs,
// DataReceipt.cs, EnvironmentData.cs). Idempotent: a value that already is 'sha256:<64 hex>' is kept as it is.
export const HASHED_WORDS = /^sha256:[0-9a-f]{64}$/;
export const hashedWords = words => (HASHED_WORDS.test(text(words).trim()) ? text(words).trim() : text(words).trim() ? 'sha256:' + wordsSha256(words) : words);
// The answer of a bridge or the kernel repeats what it got as the words: never spread into an answer (CX15 r3, CT-6; r4 W-2).
export const WORD_KEYS = Object.freeze(new Set(['authorization', 'authorize', 'words', 'ownerRequest']));
// Review a9-followups-2 (N1, the family of B): THE one rule of where the arguments of a call {tool, arguments} hold the
// owner's authorization words. The detector (callWordsProblems: the hub's WORDS_REQUIRED before any handler), the mask of
// every echo (maskCallWords: a refusal's corrected and any step {tool, arguments}, through withoutWordEchoes, the hosted
// gate's refusal() and the input layer of tool-input.mjs) and the scan that decides whether an answer is masked
// (resultWithoutWordEchoes) all read it, so no echo keeps a field the detector reads as words (studio_authorize's text came
// back word for word in the gate's AGENT_RECONNECTING and PATH_OUTSIDE_WORKSPACE, and replayed as it came it recorded the
// authorization without the owner):
//   - a string under a WORD_KEYS key, at any depth;
//   - a first-level field TOOL_WORD_FIELDS names for its tool (studio_authorize's text, the bridge's authorize <manifest>
//     <kind> <text>);
//   - the words of the bridge line of a LINE_WORD_TOOLS tool (studio_command's command/args, read as the bridge reads them:
//     bridgeLineWords finds them, bridgeEchoWithoutWords masks them).
export const TOOL_WORD_FIELDS = Object.freeze({ studio_authorize: Object.freeze(['text']) });
export const LINE_WORD_TOOLS = Object.freeze(new Set(['studio_command']));
// The tools whose words sit outside WORD_KEYS: a step that names one is masked by that tool's own rule.
export const WORD_FIELD_TOOLS = Object.freeze([...Object.keys(TOOL_WORD_FIELDS), ...LINE_WORD_TOOLS]);
// keys: the place of a string in the arguments of tool, from the top (array indexes included).
export const isWordsField = (tool, keys) => keys.length > 0 && (WORD_KEYS.has(keys.at(-1))
  || (keys.length === 1 && typeof tool === 'string' && Object.hasOwn(TOOL_WORD_FIELDS, tool) && TOOL_WORD_FIELDS[tool].includes(keys[0])));
// The one walk of those places (the line apart): a copy of value with visit(text, path) at every string isWordsField names
// (path 'request/batch/0/authorization'); every other value as it is.
function mapWordFields(tool, value, visit, keys = []) {
  if (Array.isArray(value)) return value.map((v, i) => mapWordFields(tool, v, visit, [...keys, i]));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    const at = [...keys, k];
    return [k, typeof v === 'string' && isWordsField(tool, at) ? visit(v, at.join('/')) : mapWordFields(tool, v, visit, at)];
  }));
}
export const withoutWords = value => (Array.isArray(value) ? value.map(withoutWords)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([k]) => !WORD_KEYS.has(k)).map(([k, v]) => [k, withoutWords(v)])) : value);
// CX15 r5 (N-1): an echo of the input (a refusal's corrected, any {tool, arguments} step) never carries the owner's words:
// every string under a WORD_KEYS key, at any depth, becomes the marker the answers already use for them (tool-input.mjs
// WORDS_MARKER). A placeholder (an <angle-bracket> text such as OWNER_REPLY) and a sha256:<hex> are kept: they are no words.
// English since 16/10/2026 (owner rule of 15/10: every SSAM text in English): the one marker of tool-input.mjs,
// next-steps.mjs and continuations.mjs (no import: tool-input.mjs imports this module).
export const WORDS_ECHO = "<the user's own words>";
// Input alias: the marker the releases before 16/10 wrote ('<palavras do usuário>'). A continuation an older release (or
// an older hosted hub) masked and that is replayed as it is still holds it: it is never the owner's words, alone or
// inside a text. Recognized only; no answer writes it.
export const WORDS_ECHO_ALIASES = Object.freeze(['<palavras do usuário>']);
const placeholderOrHash = value => /^<[^<>]+>$/s.test(value.trim()) || HASHED_WORDS.test(value.trim());
// CX15 r6 (M-1): the words the owner typed. A nonempty normalized text that is no <placeholder> (WORDS_ECHO, OWNER_REPLY or
// any <...> template the server writes), holds no marker the server writes (WORDS_ECHO, its aliases, OWNER_REPLY) and is no
// sha256:<hex> (a server value). Every gate that takes authorization words refuses anything else (WORDS_REQUIRED, nothing
// sent): a continuation the hub masked and replayed as it is never runs.
export const isServerWordsText = value => {
  const t = text(value).trim();
  return /^<[^<>]*>$/s.test(t) || HASHED_WORDS.test(t) || t.includes(WORDS_ECHO) || WORDS_ECHO_ALIASES.some(m => t.includes(m))
    || t.includes(OWNER_REPLY);
};
export const wordsGiven = value => typeof value === 'string' && normalizeWords(value) !== '' && !isServerWordsText(value);
// CX15 r7 (L-8): every SSAM text in English (owner rule of 15/10).
export const ASK_OWNER = "the owner's own words in place of the marker";
export const ASK_OWNER_SAY = 'ask the owner for his own words, verbatim; the server never repeats them';
// One refusal for every field whose words are missing or a server text: [{path, value}] -> the WORDS_REQUIRED answer.
export function wordsRequired(fields, { tool } = {}) {
  const problems = fields.map(({ path: at, value }) => problem('WORDS_REQUIRED',
    `${at}: ${value === undefined || (typeof value === 'string' && !value.trim()) ? 'the owner\'s words are missing' : 'this is a text of the server (a marker, a <template> or a sha256), never the owner\'s words'}`,
    'the owner\'s own words, typed by the owner'));
  return { ok: false, code: 'WORDS_REQUIRED', outcome: 'not-sent', ...(tool ? { tool } : {}),
    error: `${tool ?? 'this write'} needs the owner's own words (${fields.map(f => f.path).join(', ')}): ask the owner and pass his literal words; a marker or template of the server is never words. Nothing was sent.`,
    problems, askOwner: { fields: fields.map(f => f.path), say: ASK_OWNER_SAY } };
}
// CX15 r7 (M-1, M-3, the family): the words fields of a call (the one rule above: WORD_KEYS at any depth, TOOL_WORD_FIELDS,
// the words of a LINE_WORD_TOOLS line) that are present, not blank and not the owner's words (wordsGiven). The hub refuses
// such a call before any handler runs (one WORDS_REQUIRED with every field); a blank or absent field is each tool's own rule
// (a standing grant, a preview). -> [{path, value}]
export function callWordsProblems(tool, args) {
  const fields = [];
  const bad = value => typeof value === 'string' && value.trim() !== '' && !wordsGiven(value);
  mapWordFields(tool, args, (value, at) => { if (bad(value)) fields.push({ path: at, value }); return value; });
  if (LINE_WORD_TOOLS.has(tool) && args && typeof args === 'object') {
    const tokens = [...String(args.command ?? '').split(' '), ...(Array.isArray(args.args) ? args.args : typeof args.args === 'string' ? [args.args] : [])];
    const found = bridgeLineWords(tokens).find(bad);
    if (found !== undefined) fields.push({ path: 'command/args', value: found });
  }
  return fields;
}
// N1 (review a9-followups-2): the arguments of a call of tool as an echo may show them, by the same rule as the detector:
// each words string (not a <placeholder>, not a sha256) becomes WORDS_ECHO and its path joins seen; the line of a
// LINE_WORD_TOOLS tool keeps its shape with one WORDS_ECHO per run of words. Replayed as it is, it is WORDS_REQUIRED.
export function maskCallWords(tool, args, seen = null) {
  const masked = mapWordFields(tool, args, (value, at) => { if (placeholderOrHash(value)) return value; seen?.push(at); return WORDS_ECHO; });
  return LINE_WORD_TOOLS.has(tool) ? bridgeEchoWithoutWords(masked, seen) : masked;
}
// maskWords(value, at, seen): a value of no particular tool (WORD_KEYS at any depth) masked; seen collects the paths
// (under the prefix at).
export const maskWords = (value, at = '', seen = null) => mapWordFields(null, value,
  (v, p) => { if (placeholderOrHash(v)) return v; seen?.push(p); return WORDS_ECHO; }, String(at).split('/').filter(Boolean));
// CX15 r6 (M-2): the arguments of studio_command ({command, args}) hold words where the bridge reads them: the text of
// "authorize <manifest> <kind> <text...>", the tokens after --authorize up to the next --option and --authorize=<words>
// (the rule of argsWithoutWords / bridgeArgsWithoutWords). In an echo each run of those tokens becomes one WORDS_ECHO; the
// shape (a command text, args as an array or as a text, a number among them) is kept.
export function bridgeEchoWithoutWords(args, seen = null) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  let position = 0, authorizeCommand = false, wordsRun = false, emitted = false, masked = false;
  const word = () => { masked = true; if (emitted) return null; emitted = true; return WORDS_ECHO; };
  // One token: the token, its masked form, or null (a later token of a run whose marker is already there).
  const step = token => {
    const t = String(token);
    if (t === '') return token;
    const at = position++;
    if (at === 0) authorizeCommand = t === 'authorize';
    if (authorizeCommand && at >= 3) return word();
    if (/^--authorize=/i.test(t)) { masked = true; wordsRun = true; emitted = true; return '--authorize=' + WORDS_ECHO; }
    if (t.startsWith('--')) { wordsRun = t.toLowerCase() === '--authorize'; emitted = false; return token; }
    return wordsRun ? word() : token;
  };
  const line = value => value.split(' ').map(step).filter(t => t !== null).join(' ');
  const out = { ...args };
  if (typeof args.command === 'string') out.command = line(args.command);
  if (typeof args.args === 'string') out.args = line(args.args);
  else if (Array.isArray(args.args)) out.args = args.args.map(a => (typeof a === 'string' && /^--authorize=/i.test(a) ? (step('--authorize='), '--authorize=' + WORDS_ECHO)
    : typeof a === 'string' && a.includes(' ') ? line(a) : step(a))).filter(a => a !== null);
  if (masked) seen?.push('command/args');
  return masked ? out : args;
}// The same over a whole answer: every `corrected`, and the arguments of every step {tool, arguments} (continuation,
// continuations, next steps), at any depth. The rest of the answer is unchanged. CX15 r6 (M-1): a step whose arguments
// were masked says so: its why ends with "; <fields>: the owner's own words in place of the marker" and it carries askOwner
// (the fields the owner must fill) — replaying it as it is gives WORDS_REQUIRED. tool: the tool whose answer this is (its
// corrected is masked by the rules of that tool: studio_command, M-2; studio_authorize's text, N1). Both by maskCallWords,
// the rule of the detector.
export function withoutWordEchoes(value, { tool } = {}) {
  if (Array.isArray(value)) return value.map(v => withoutWordEchoes(v, { tool }));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = k === 'corrected' ? maskCallWords(tool, v) : withoutWordEchoes(v, { tool });
  if (typeof out.tool === 'string' && out.arguments && typeof out.arguments === 'object') {
    const seen = [];
    out.arguments = maskCallWords(out.tool, out.arguments, seen);
    if (seen.length) {
      const fields = [...new Set(seen)];
      out.why = (typeof out.why === 'string' && out.why ? out.why.replace(/[\s.;]*$/, '') + '; ' : '') + fields.join(', ') + ': ' + ASK_OWNER;
      out.askOwner = { fields, say: ASK_OWNER_SAY };
    }
  }
  return out;
}
// The same over an MCP result ({content:[{type:'text', text: JSON}], structuredContent}): both views, only when they change.
// CX15 r6 (L-5 on the way): an answer with no key the mask touches (WORD_KEYS, corrected, a step of a WORD_FIELD_TOOLS tool:
// the one rule above, N1) is returned as it is, found by a scan of the text (no parse) and of the structured value (no
// copy); only answers that have one are parsed and masked.
const ECHO_KEY = new RegExp('"(' + [...WORD_KEYS, 'corrected'].join('|') + ')"\\s*:|"(' + WORD_FIELD_TOOLS.join('|') + ')"');
function hasEchoKeys(value) {
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') stack.push(x); continue; }
    if (!v || typeof v !== 'object') continue;
    if (WORD_FIELD_TOOLS.includes(v.tool)) return true;
    for (const k of Object.keys(v)) { if (k === 'corrected' || WORD_KEYS.has(k)) return true; const x = v[k]; if (x && typeof x === 'object') stack.push(x); }
  }
  return false;
}
export function resultWithoutWordEchoes(result, options) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return result;
  if (!LINE_WORD_TOOLS.has(options?.tool) && !result.content.some(c => typeof c?.text === 'string' && ECHO_KEY.test(c.text))
    && (result.structuredContent === undefined || !hasEchoKeys(result.structuredContent))) return result;
  let changed = false;
  const content = result.content.map(c => {
    if (c?.type !== 'text' || typeof c.text !== 'string' || !/^\s*[{[]/.test(c.text)) return c;
    let parsed; try { parsed = JSON.parse(c.text); } catch { return c; }
    const masked = withoutWordEchoes(parsed, options);
    if (JSON.stringify(masked) === JSON.stringify(parsed)) return c;
    changed = true; return { ...c, text: JSON.stringify(masked) };
  });
  const structured = result.structuredContent === undefined ? undefined : withoutWordEchoes(result.structuredContent, options);
  if (structured !== undefined && JSON.stringify(structured) !== JSON.stringify(result.structuredContent)) changed = true;
  return changed ? { ...result, content, ...(structured === undefined ? {} : { structuredContent: structured }) } : result;
}
// CX15 r4 (W-2) / r5 (N-2): the words of a bridge command line. --authorize <words> (every token up to the next --option, as
// DataCommands.cs reads them) and --authorize=<words> go as one 'sha256:<hex>' token; the authorize command (authorize
// <manifest> publish|create <text...>, StartupHook.cs Authorize: Split(' ', 3), only a nonempty text required) gets its
// text as one 'sha256:<hex>' token. Idempotent.
export function argsWithoutWords(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (/^--authorize=/i.test(a)) {
      // CX15 r6: the tokens after --authorize=<first word> up to the next --option are words too (bridgeLineWords).
      const run = [a.slice('--authorize='.length)];
      while (i + 1 < args.length && !String(args[i + 1]).startsWith('--')) run.push(String(args[++i]));
      out.push('--authorize=' + hashedWords(run.join(' '))); continue;
    }
    out.push(a);
    if (a.toLowerCase() !== '--authorize') continue;
    const words = [];
    while (i + 1 < args.length && !String(args[i + 1]).startsWith('--')) words.push(String(args[++i]));
    if (words.length) out.push(hashedWords(words.join(' ')));
  }
  return out;
}
// CX15 r6 (M-1): the words a bridge line carries, by the same rule ([] when it carries none): the text of the authorize
// command, the tokens after --authorize up to the next --option, the value of --authorize=.
export function bridgeLineWords(tokens = []) {
  const list = tokens.flatMap(t => String(t).split(' ')).filter(t => t !== '');
  if (list[0] === 'authorize') return list.length > 3 ? [list.slice(3).join(' ')] : [''];
  const words = [];
  for (let i = 0; i < list.length; i++) {
    if (/^--authorize=/i.test(list[i])) { const run = [list[i].slice('--authorize='.length)]; while (i + 1 < list.length && !list[i + 1].startsWith('--')) run.push(list[++i]); words.push(run.join(' ').trim()); continue; }
    if (list[i].toLowerCase() !== '--authorize') continue;
    const run = []; while (i + 1 < list.length && !list[i + 1].startsWith('--')) run.push(list[++i]);
    words.push(run.join(' '));
  }
  return words;
}
// CX15 r6 (the sweep of the review: L-1x on the way): the pipe joins the arguments with spaces, so an argument that holds
// several tokens ("<manifest> publish <words>", "M E --authorize <words>") is read token by token too: when the line
// carries words, they are found and hashed on the tokens the bridge will read.
export function bridgeArgsWithoutWords(args = []) {
  if (!Array.isArray(args) || !args.length) return args;
  const tokens = args.flatMap(a => String(a).split(' ')).filter(t => t !== '');
  if (tokens[0] === 'authorize') return tokens.length >= 4 ? [tokens[0], tokens[1], tokens[2], hashedWords(tokens.slice(3).join(' '))] : args;
  if (!tokens.some(t => /^--authorize(=|$)/i.test(t))) return args;
  return argsWithoutWords(args.some(a => String(a).includes(' ') && /(^|\s)--authorize(=|\s|$)/i.test(String(a))) ? tokens : args);
}
// The words seen on a host, one file per UTC day (seen-words\<host>\<YYYY-MM-DD>.jsonl, CX15 r2, provisional decision
// "24 h with pruning"): appends never rewrite a file, and noting words deletes the days older than the window (and the
// single file of before, seen-words\<host>.jsonl, once all of it is older), so the folder never grows past two days.
const seenDir = (host, root) => path.join(rootOf(root), 'seen-words', hostFile(host));
const legacySeenFile = (host, root) => path.join(rootOf(root), 'seen-words', hostFile(host) + '.jsonl');
const dayOf = t => new Date(t).toISOString().slice(0, 10);
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const readSeen = file => { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return []; } };
const rowsOf = lines => lines.filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => typeof r?.sha256 === 'string' && Number.isFinite(Date.parse(r?.at)));
function pruneSeen(host, root, at, windowMs = SEEN_WORDS_WINDOW_MS) {
  const oldest = dayOf(at - windowMs);
  try { for (const name of fs.readdirSync(seenDir(host, root)).filter(n => DAY_FILE.test(n) && n.slice(0, 10) < oldest)) fs.rmSync(path.join(seenDir(host, root), name), { force: true }); }
  catch { /* nothing to prune */ }
  const legacy = legacySeenFile(host, root);
  if (fs.existsSync(legacy) && rowsOf(readSeen(legacy)).every(r => Date.parse(r.at) < at - windowMs)) fs.rmSync(legacy, { force: true });
}

// Every destructive call that carries words notes them FIRST, before anything else it does.
export function noteWords({ host, tool, words, now, root } = {}) {
  if (!normalizeWords(words)) return null;
  const at = ms(now);
  const file = path.join(seenDir(host, root), dayOf(at) + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = { at: iso(at), tool: text(tool), sha256: wordsSha256(words) };
  appendJsonLine(file, line);
  try { pruneSeen(host, root, at); } catch { /* the next note prunes */ }
  return line.sha256;
}
export function seenWords({ host, now, root, windowMs = SEEN_WORDS_WINDOW_MS } = {}) {
  const at = ms(now); const out = new Set();
  const files = [legacySeenFile(host, root)];
  for (let day = at - windowMs; dayOf(day) <= dayOf(at); day += 24 * 3600 * 1000) files.push(path.join(seenDir(host, root), dayOf(day) + '.jsonl'));
  if (!files.includes(path.join(seenDir(host, root), dayOf(at) + '.jsonl'))) files.push(path.join(seenDir(host, root), dayOf(at) + '.jsonl'));
  for (const file of new Set(files))
    for (const row of rowsOf(readSeen(file))) { const t = Date.parse(row.at); if (t <= at && t >= at - windowMs) out.add(row.sha256); }
  return out;
}

// ---- the list and its identity
// A deterministic UUID (version 5 layout) of a parent operation and the parts that name one child of it (moved here from
// service-center/delete.mjs, which re-exports it: the same UUIDs as before).
export function derivedOperationId(parent, ...parts) {
  const hex = sha256(Buffer.from([text(parent).toLowerCase(), ...parts.map(text)].join('\n'), 'utf8')).slice(0, 32).split('');
  hex[12] = '5'; hex[16] = '89ab'[parseInt(hex[16], 16) & 3];
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const canonical = value => (Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : isObject(value) ? '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
    : JSON.stringify(value ?? null));
const itemId = item => `${text(item.kind)}|${text(item.key)}`;
const sortedItems = items => [...items].sort((a, b) => itemId(a).localeCompare(itemId(b)));
const identity = item => ({ kind: text(item.kind), key: text(item.key), name: text(item.name), application: item.application ?? null,
  cascade: [...(item.cascade ?? [])].map(text).sort(), consumers: [...(item.consumers ?? [])].map(text).sort() });
export const listSha256 = items => sha256(canonical(sortedItems(items).map(identity)));
// The token binds the WHOLE preview as written (CX15 r2, G): its items (listSha256 recomputed from them, never the stored
// field alone), host, operation, tool, times, the words seen before it, the texts of the server and the client (T11). The
// file is created once and never rewritten: any change to it makes its token unknown. The previewId (and the operationId
// derived from it) is the first part of the token; the list counts in any order, as listSha256 does.
const tokenHash = p => sha256(canonical({ ...p, previewId: undefined, operationId: undefined, items: sortedItems(p.items ?? []),
  listSha256: listSha256(p.items ?? []), host: text(p.host).toLowerCase() })).slice(0, 16);
const tokenOf = p => `${p.previewId}.${tokenHash(p)}`;
export function parseToken(token) {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{16})$/i.exec(text(token).trim());
  return m ? { previewId: m[1].toLowerCase(), check: m[2].toLowerCase() } : null;
}
export const previewFile = (previewId, { root } = {}) => path.join(rootOf(root), 'previews', text(previewId).toLowerCase() + '.json');
export const readPreview = (previewId, { root } = {}) => { const p = UUID.test(text(previewId)) ? readJson(previewFile(previewId, { root })) : null; return ownedByCaller(p) ? p : null; };

// The answer a tool gives the owner: the count first, the reply to copy, the list, the backup plan, the next call.
function previewBlock(p, file) {
  const plan = { possible: p.items.filter(i => i.backup?.possible).map(i => i.name), notPossible: p.items.filter(i => i.backup && !i.backup.possible).map(i => ({ name: i.name, why: i.backup.why ?? null })) };
  // The answer's items, compact (the preview file keeps them whole): no engine fields (via, moduleKind, withApplication,
  // applicationKey), no application equal to the name, the backup plan without its module list (the item's cascade).
  const ENGINE = new Set(['via', 'moduleKind', 'withApplication', 'applicationKey']);
  const compact = p.items.map(i => Object.fromEntries(Object.entries(i).filter(([k, v]) => !ENGINE.has(k) && !(k === 'application' && v === i.name))
    .map(([k, v]) => [k, k === 'backup' && v?.modules ? Object.fromEntries(Object.entries(v).filter(([b]) => b !== 'modules')) : v])));
  // The same backup plan for every item (a list of records): said once, as itemBackup.
  const shared = compact.length > 1 && compact.every(i => i.backup && JSON.stringify(i.backup) === JSON.stringify(compact[0].backup)) ? compact[0].backup : null;
  const items = shared ? compact.map(({ backup, ...rest }) => rest) : compact;
  return { state: 'previewed', previewId: p.previewId, confirmationToken: tokenOf(p), operationId: p.operationId, expiresAt: p.expiresAt, count: p.items.length,
    ...previewTexts(p), items, ...(shared ? { itemBackup: shared } : { backupPlan: plan }), mustName: p.mustName, file };
}
// The two texts of a preview: the RULE of the owner's reply (never a phrase to copy: a phrase the server wrote is
// indistinguishable from one the model wrote) and the next step. CX15 r3 (CT-7, the family): the notes of the preview
// (what goes WITHOUT a backup) end both, so the model tells the owner; a preview without notes has the texts of before.
function previewTexts(p) {
  const names = (p.mustName ?? []).length ? p.mustName.join(', ') : 'the items';
  const note = (p.notes ?? []).filter(Boolean).join(' ');
  return { confirmWith: `the owner's next message after the list states the number ${p.items.length} and names ${names}${note ? '; ' + note : ''}`,
    next: `Show the owner this exact list (${p.items.length} item${p.items.length === 1 ? '' : 's'}) and ask; then call ${p.tool} again with confirmationToken and `
      + `the owner's next message after the list, verbatim. ${WORDS_RULE}${note ? ' ' + note : ''}` };
}
// CX15 r3 (CT-7, the family, from the Service Center engine of the SC lane): what a preview deletes WITHOUT a backup: the
// items whose backup is not possible, with their reasons (the first clause of each why, or whyOf), and the extensions
// inside items that are backed up otherwise (backup.notBackedUp). null when every item has its backup. Every lane's
// preview carries it in next and confirmWith (createPreview notes; a lane with sharper reasons passes its own), and the
// lanes add it to the error of CONFIRMATION_REQUIRED (withPreviewNote).
const firstClause = backup => text(backup.why).split(/: |; |, so /)[0].trim() || 'no backup is possible';
export function noBackupNote(items = [], whyOf = firstClause) {
  const without = items.filter(i => i.backup && i.backup.possible === false);
  const inside = items.filter(i => i.backup?.possible && Array.isArray(i.backup.notBackedUp)).flatMap(i => i.backup.notBackedUp);
  if (!without.length && !inside.length) return null;
  const parts = [];
  if (without.length) parts.push(`${without.length} item${without.length === 1 ? '' : 's'} will be deleted WITHOUT a backup (${[...new Set(without.map(i => whyOf(i.backup)))].join('; ')})`);
  if (inside.length) parts.push(`${inside.length} extension${inside.length === 1 ? '' : 's'} inside backed-up items ${inside.length === 1 ? 'goes' : 'go'} without a backup (an extension (.xif) is not backed up yet)`);
  return `${parts.join('; ')}: tell the owner.`;
}
// The error of a preview call that brought words (CONFIRMATION_REQUIRED), with the note of its items.
export const withPreviewNote = (error, items) => { const note = noBackupNote(items); return note ? `${text(error)}. ${note}` : error; };
// What the server wrote for a preview, normalized: these texts never confirm it (WORDS_BEFORE_PREVIEW).
const serverPhrasesOf = (p, extra = []) => [...new Set([OWNER_REPLY, WORDS_RULE, AFTER_INTERRUPTION, DESTRUCTIVE_SUFFIX, ...Object.values(previewTexts(p)), ...extra]
  .map(normalizeWords).filter(t => t.length >= 12))];
const tokensOf = value => normalizeWords(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// True when the words are a template (<...>), or contain a text the server wrote for this preview (whole, or five words
// in a row of it). CX15 r3 (N1): the five-word runs of the server's texts are taken WITHOUT the names of the preview
// (mustName and the names of its items): a name the owner must say is never "a text SSAM wrote", so a reply that names
// the targets in the order of the list (three names of two words, five of one, one name of five words or more) confirms.
// A whole server text (confirmWith, next, the rule) copied into the words is still refused by containment.
const nameRuns = names => [...new Set((names ?? []).map(tokensOfName).filter(t => t.length && t.join('').length >= 2).map(t => t.join(' ')))].map(t => t.split(' '));
const tokensOfName = name => tokensOf(name);
function gramsWithoutNames(phrase, runs) {
  const t = tokensOf(phrase);
  const cut = new Array(t.length).fill(false);
  for (const run of runs)
    for (let i = 0; i + run.length <= t.length; i++)
      if (run.every((part, j) => t[i + j] === part)) for (let j = 0; j < run.length; j++) cut[i + j] = true;
  const grams = [];
  let segment = [];
  const flush = () => { for (let i = 0; i + 5 <= segment.length; i++) grams.push(segment.slice(i, i + 5).join(' ')); segment = []; };
  t.forEach((token, i) => { if (cut[i]) flush(); else segment.push(token); });
  flush();
  return grams;
}
export function serverWritten(words, phrases = [], names = []) {
  const raw = text(words).trim();
  if (/^<[^<>]*>$/s.test(raw)) return true;
  const w = normalizeWords(words);
  if (phrases.some(phrase => w === phrase || (phrase.length >= 12 && w.includes(phrase)))) return true;
  const own = tokensOf(words);
  if (own.length < 5) return false;
  const runs = nameRuns(names);
  const grams = new Set(phrases.flatMap(phrase => gramsWithoutNames(phrase, runs)));
  for (let i = 0; i + 5 <= own.length; i++) if (grams.has(own.slice(i, i + 5).join(' '))) return true;
  return false;
}
// The names a reply may say: what the preview says must be named and the names of its items (and their applications).
const previewNames = p => [...(p.mustName ?? []), ...(p.items ?? []).flatMap(i => [i.name, i.application])].filter(v => text(v).trim()).map(text);

// items: [{kind, key, name, application?, cascade?:[names], consumers?:[names], dataLoss?, backup:{possible, how|why}, ...}]
// selection: what the preview resolved (prefix, lists, ids), kept for the execution's name rule. words/ownerRequest: the
// words of THIS call and the owner's request, frozen (sha256) with every line seen on the host in the window before.
// notes (CX15 r3, CT-7): the sentences that end next and confirmWith; by default what goes WITHOUT a backup
// (noBackupNote of the items); a lane with sharper reasons passes its own ([] for none).
// alsoBefore (CX13 review 6): sha256 of words the caller KNOWS were said before this preview although they may be older
// than the window of the host (a file load's own words and its earlier confirmations, kept in its plan): frozen too.
export function createPreview({ tool, lane = null, host, operation, selection = {}, items = [], ownerRequest, words, mustName = [], now, root, uuid = crypto.randomUUID, extra = {}, serverTexts = [], notes, alsoBefore = [] } = {}) {
  const at = ms(now);
  const previewId = text(uuid()).toLowerCase();
  const clientId = currentClientId();
  const before = new Set(seenWords({ host, now: at, root }));
  for (const value of [words, ownerRequest]) if (normalizeWords(value)) before.add(wordsSha256(value));
  for (const hash of alsoBefore) if (/^[0-9a-f]{64}$/.test(text(hash))) before.add(text(hash));
  const said = (notes ?? [noBackupNote(items)]).filter(Boolean).map(text);
  const p = { schema: PREVIEW_SCHEMA, previewId, tool, lane, host, operation, selection, items: items.map(i => ({ ...i })), listSha256: listSha256(items),
    createdAt: iso(at), expiresAt: iso(at + PREVIEW_TTL_MS), operationId: derivedOperationId(previewId, 'execute'), wordsBefore: [...before].sort(), mustName, ...extra, ...(clientId ? { clientId } : {}),
    ...(said.length ? { notes: said } : {}) };
  p.serverPhrases = serverPhrasesOf(p, serverTexts);
  const file = previewFile(previewId, { root });
  if (!createExclusive(file, p)) throw new Error('preview id already used: ' + previewId);
  return previewBlock(p, file);
}
export const previewAnswer = (preview, { root } = {}) => previewBlock(preview, previewFile(preview.previewId, { root }));
// A tool of ONE target (o11_extension delete {extension}, o11_environment delete-app {app}) may name it again with the
// token: true when the token's preview lists it (by name or key), false when it does not, null for an unknown token.
export function tokenNames(token, target, { root } = {}) {
  const parsed = parseToken(token);
  const preview = parsed ? readPreview(parsed.previewId, { root }) : null;
  if (!preview) return null;
  return preview.items.some(i => [i.name, i.key].some(v => text(v) !== '' && text(v).toLowerCase() === text(target).toLowerCase()));
}

// ---- the count (owner decision, option C): the expected number as a standalone numeral; numbers inside the names of the
// list (an app "ZZ App 2024") are not counts. Missing or any other number: CONFIRMATION_COUNT_MISMATCH.
export function countProblem(words, expected, names = []) {
  let rest = ' ' + plain(words) + ' ';
  for (const name of [...names].map(plain).filter(n => n.trim()).sort((a, b) => b.length - a.length)) {
    const pattern = name.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    rest = rest.replace(new RegExp('(?<![\\p{L}\\p{N}_])' + pattern + '(?![\\p{L}\\p{N}_])', 'giu'), ' ');
  }
  // A standalone numeral: not part of a word, a decimal or a hyphen-joined code (a UUID's digit group is not a count).
  const found = [...new Set((rest.match(/(?<![\p{L}\p{N}_.,-])\d+(?![\p{L}\p{N}_-]|[.,]\d)/gu) ?? []).map(Number))];
  if (found.length === 1 && found[0] === expected) return null;
  return problem('CONFIRMATION_COUNT_MISMATCH', found.length
    ? `The words state ${found.join(' and ')}, but the preview lists ${expected} item${expected === 1 ? '' : 's'}`
    : `The words do not state the number of items; the preview lists ${expected}`,
  `the owner's next message after the list states the number of items (expected) and names the targets.${ASK_AGAIN}`, { expected, found });
}

// The difference between the frozen list and the list read now (by kind|key).
export function diffItems(before, after) {
  const index = list => new Map(list.map(i => [itemId(i), i]));
  const b = index(before); const a = index(after);
  const added = [...a.keys()].filter(k => !b.has(k)).map(k => a.get(k).name);
  const removed = [...b.keys()].filter(k => !a.has(k)).map(k => b.get(k).name);
  const renamed = [...a.keys()].filter(k => b.has(k) && text(b.get(k).name) !== text(a.get(k).name)).map(k => ({ key: a.get(k).key, from: b.get(k).name, to: a.get(k).name }));
  const consumersChanged = [...a.keys()].filter(k => b.has(k) && canonical([identity(b.get(k)).cascade, identity(b.get(k)).consumers]) !== canonical([identity(a.get(k)).cascade, identity(a.get(k)).consumers]))
    .map(k => a.get(k).name);
  return added.length || removed.length || renamed.length || consumersChanged.length ? { added, removed, renamed, consumersChanged } : null;
}
const selectionGiven = selection => Object.values(selection ?? {}).some(v => (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== false && text(v).trim() !== ''));

// The execution's checks, every problem at once. token: the confirmationToken; selection: what came WITH it (prefix,
// lists, ids: must be empty); target: a single target the call names, which must be one of the preview's; current: the
// list read again now (null skips the stale check); frozen: the items expected now (default the preview's; after an
// execution, those not yet deleted); nameRule(preview, words): the tool's own word problems; mustName: what the words
// must name for the list read now (the new preview's, when the list is stale); used: the caller knows the token already
// ran (a receipt of it exists).
// -> {preview, problems, fresh?, used?, operation?}. A token that already ran is NEVER a blank check (CX15 r2, A/B): every
// rule runs again and the owner's words must be new (CONFIRMATION_ALREADY_USED); a cancelled operation never sends again
// (OPERATION_CANCELLED); one whose process died needs a new preview (OPERATION_INTERRUPTED, with it); one another process
// is running now answers OPERATION_RUNNING.
export function checkExecute({ token, tool, host, operation, words = '', selection = {}, target = null, current = null, frozen = null, nameRule = null, now, root, uuid, count = true, mustName = null, used: usedHint = false, begun = null } = {}) {
  const at = ms(now);
  const parsed = parseToken(token);
  const preview = parsed ? readPreview(parsed.previewId, { root }) : null;
  if (!preview || tokenOf(preview) !== `${parsed.previewId}.${parsed.check}`)
    return { preview: null, problems: [problem('PREVIEW_UNKNOWN', 'The confirmationToken names no preview of this machine and client (or was altered); nothing was sent',
      `a new call without confirmationToken, which previews the exact list, then the owner's confirmation`)] };
  // begun: the record this same call opened before its read again (CX15 r2, T5): it is not a previous execution. A record
  // refused before any send (notSent) is not one either.
  const stored = begun ? null : readOperation(preview.operationId, { root });
  const operationRecord = reopenable(stored) ? null : stored;
  const freshOf = list => (list?.length ? createPreview({ tool: preview.tool, lane: preview.lane, host: preview.host, operation: preview.operation, selection: preview.selection,
    items: list, mustName: mustName ?? preview.mustName, now: at, root, ...(uuid ? { uuid } : {}) }) : null);
  if (operationRecord?.state === 'cancelled')
    return { preview, operation: operationRecord, problems: [problem('OPERATION_CANCELLED', `Operation ${preview.operationId} was cancelled at ${operationRecord.cancelledAt ?? operationRecord.updatedAt}; its token never sends again`,
      'a new preview (it lists only what is left) and a new confirmation of the owner', { operationId: preview.operationId })] };
  if (operationRecord?.orphaned) {
    const fresh = freshOf(current);
    // CX15 r3 (CT-5): the refusal says what THIS call did (nothing) and what the interrupted operation did, item by item.
    return { preview, operation: operationRecord, interrupted: true, ...(fresh ? { fresh } : {}), problems: [problem('OPERATION_INTERRUPTED',
      `This call sent nothing. The process that ran operation ${preview.operationId} stopped before it ended: ${itemsSentence(operationRecord)} Nothing is sent from its token`,
      'read ssam_task {id:"' + preview.operationId + '"}, show the owner the new preview of what is left and confirm it with its own token', { operationId: preview.operationId })] };
  }
  if (operationRecord?.state === 'running')
    return { preview, operation: operationRecord, running: true, problems: [problem('OPERATION_RUNNING', `Operation ${preview.operationId} is running now (process ${operationRecord.pid}); nothing was sent`,
      'read ssam_task {id:"' + preview.operationId + '"}: it says item by item what the running execution did', { operationId: preview.operationId })] };
  const used = Boolean(operationRecord) || Boolean(usedHint);
  const problems = [];
  const sameHost = text(preview.host).toLowerCase() === text(host).toLowerCase();
  if (preview.tool !== tool || !sameHost || preview.operation !== operation)
    problems.push(problem('PREVIEW_OTHER_TARGET', `The token is of ${preview.tool} ${preview.operation} on ${preview.host}, not of ${tool} ${operation} on ${host}`,
      `the token of a preview of this call, or a new preview`, { previewOf: { tool: preview.tool, operation: preview.operation, host: preview.host } }));
  else if (target !== null && target !== undefined && !preview.items.some(i => [i.name, i.key].some(v => text(v) !== '' && text(v).toLowerCase() === text(target).toLowerCase())))
    problems.push(problem('PREVIEW_OTHER_TARGET', `The token lists ${preview.items.map(i => i.name).join(', ')}, not ${target}`, `the token of a preview of ${target}, or a new preview`, { target: text(target) }));
  const expired = at > Date.parse(preview.expiresAt);
  if (expired) problems.push(problem('PREVIEW_EXPIRED', `The preview expired at ${preview.expiresAt}`, 'a new preview and the owner\'s confirmation of it'));
  if (selectionGiven(selection))
    problems.push(problem('SELECTION_ONLY_IN_PREVIEW', 'A prefix, a pattern, a list or ids came with the token: the execution takes its targets from the token only',
      'the same call with only confirmationToken and the owner\'s words (the targets come from the preview)'));
  const age = at - Date.parse(preview.createdAt);
  if (age < CONFIRM_MIN_AGE_MS)
    problems.push(problem('CONFIRMATION_TOO_SOON', `The confirmation came ${Math.max(0, Math.round(age))} ms after the preview; no owner answers that fast`,
      'show the owner the list, wait for the reply and call again with it'));
  if (normalizeWords(words) && (preview.wordsBefore ?? []).includes(wordsSha256(words)))
    problems.push(problem('WORDS_BEFORE_PREVIEW', `These words were seen before the preview (the request, the preview call or another call on this host); they cannot confirm a list they never saw. The same sentence is refused for ${SEEN_WORDS_WINDOW_MS / 3600000} h on this host: the reply must be a new one`,
      'the owner\'s next message AFTER being shown this preview, verbatim (a new sentence, not one said before)'));
  else if (serverWritten(words, preview.serverPhrases ?? serverPhrasesOf(preview), previewNames(preview)))
    problems.push(problem('WORDS_BEFORE_PREVIEW', 'These words are a text SSAM wrote (a template, the rule of the reply, a next step), not the owner\'s reply; a text of the server never confirms',
      'the owner\'s next message after the list, verbatim'));
  if (used && normalizeWords(words) && (operationRecord?.usedWords ?? []).includes(wordsSha256(words)))
    problems.push(problem('CONFIRMATION_ALREADY_USED', 'These words already confirmed an execution of this token; a repeated execution needs the owner\'s new reply',
      'read ssam_task {id:"' + preview.operationId + '"}, tell the owner what happened and ask', { operationId: preview.operationId }));
  if (count) {
    const names = [...new Set([...preview.items.flatMap(i => [i.name, i.application, ...(i.cascade ?? []), ...(i.consumers ?? [])]), text(preview.selection?.prefix)].filter(Boolean).map(text))];
    const counted = countProblem(words, preview.items.length, names);
    if (counted) problems.push({ ...counted, items: preview.items.map(i => i.name) });
  }
  if (nameRule) problems.push(...(nameRule(preview, words) ?? []));
  let fresh = null;
  if (current) {
    const diff = diffItems(frozen ?? preview.items, current);
    if (diff) problems.push(problem('PREVIEW_STALE', 'The list read now differs from the preview; nothing was sent', 'show the owner the new preview (fresh) and confirm it with its own token', { diff }));
    if (diff || expired) fresh = freshOf(current);
  }
  // Every refusal of the words says to ask the owner again (the model never writes, completes or reuses them).
  for (const p of problems) if (WORDS_CODES.has(p.code) && !/ask the owner again/i.test(p.fix ?? '')) p.fix = `${p.fix ?? ''}${ASK_AGAIN}`.trim();
  return { preview, problems, ...(fresh ? { fresh } : {}), ...(used ? { used: true, operation: operationRecord, expired } : {}) };
}
// What an operation did, item by item, in one sentence (names by state; the record as a reader sees it: an item caught
// while sending reads uncertain).
export function itemsSentence(record) {
  const by = {};
  for (const item of record?.items ?? []) (by[item.state] ??= []).push(item.name);
  const list = names => names.join(', ');
  const parts = [
    by.deleted && `it deleted ${list(by.deleted)}`,
    by.absent && `${list(by.absent)} ${by.absent.length === 1 ? 'was' : 'were'} already gone`,
    by.uncertain && `${list(by.uncertain)} ${by.uncertain.length === 1 ? 'is' : 'are'} uncertain (a delete was sent and its answer never came)`,
    by.refused && `${list(by.refused)} ${by.refused.length === 1 ? 'was' : 'were'} refused by the server`,
    by['backup-failed'] && `the backup of ${list(by['backup-failed'])} failed (not sent)`,
    (by['not-started'] || by['backing-up'] || by['backed-up']) && `${list([...(by['not-started'] ?? []), ...(by['backing-up'] ?? []), ...(by['backed-up'] ?? [])])} ${[...(by['not-started'] ?? []), ...(by['backing-up'] ?? []), ...(by['backed-up'] ?? [])].length === 1 ? 'was' : 'were'} not sent`,
    by.sending && `${list(by.sending)} ${by.sending.length === 1 ? 'was' : 'were'} being sent`,
  ].filter(Boolean);
  return parts.length ? parts.join('; ') + '.' : 'no item was recorded.';
}
const WORDS_CODES = new Set(['WORDS_MUST_NAME', 'CONSUMERS_WOULD_BREAK', 'PROTECTED_TARGET', 'WORDS_BEFORE_PREVIEW', 'CONFIRMATION_COUNT_MISMATCH', 'CONFIRMATION_ALREADY_USED', 'DESTRUCTIVE_TARGET_NOT_NAMED']);

// ---- the record of one operation
export const operationFile = (operationId, { root } = {}) => path.join(rootOf(root), 'operations', text(operationId).toLowerCase() + '.json');
const refOf = ref => (typeof ref === 'string' ? ref : `${text(ref?.kind)}:${text(ref?.key)}`);
// ---- the lease of one execution (CX15 r2, I): operations\<operationId>.lock, created exclusively ('wx') with the pid,
// held from beginOperation to endOperation, in every process. A second execution of the same token, in another process or
// in another call of this one, never runs at the same time: beginOperation throws OPERATION_RUNNING (nothing was sent) and
// the tool answers it. The lease of a process that is gone is taken over (renamed away, then the exclusive create again;
// of two takers one wins); one of this process whose record already ended is stale and taken over too.
export const leaseFile = (operationId, { root } = {}) => path.join(rootOf(root), 'operations', text(operationId).toLowerCase() + '.lock');
const leases = new Map(); // operationId -> lease file, the executions this process runs now
export class OperationRunning extends Error {
  constructor(operationId, pid) {
    super(`Operation ${operationId} is running now${pid ? ` (process ${pid})` : ''}; nothing was sent`);
    Object.assign(this, { name: 'OperationRunning', code: 'OPERATION_RUNNING', operationId, pid: pid ?? null });
  }
  get problem() {
    return problem('OPERATION_RUNNING', this.message, 'read ssam_task {id:"' + this.operationId + '"}: it says item by item what the running execution did', { operationId: this.operationId });
  }
}
function takeLease(operationId, { root, pid = process.pid } = {}) {
  const id = text(operationId).toLowerCase();
  const file = leaseFile(id, { root });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid, at: new Date().toISOString() })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      leases.set(id, file);
      return;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const owner = readJson(file);
    let stale;
    if (!Number.isInteger(owner?.pid)) {
      // Half written (its creator died between the create and the write) once it is older than a minute.
      try { stale = Date.now() - fs.statSync(file).mtimeMs > 60000; } catch { stale = false; }
    } else if (owner.pid === process.pid) stale = !leases.has(id) || readJson(operationFile(id, { root }))?.state !== 'running';
    else stale = !alive(owner.pid);
    if (!stale) throw new OperationRunning(id, owner?.pid);
    const away = `${file}.${process.pid}.${crypto.randomUUID()}.stale`;
    try { fs.renameSync(file, away); fs.rmSync(away, { force: true }); } catch { /* another taker moved it first */ }
    leases.delete(id);
  }
  throw new OperationRunning(id, null);
}
function dropLease(operationId, { root } = {}) {
  const id = text(operationId).toLowerCase();
  if (!leases.has(id)) return;
  const file = leases.get(id);
  leases.delete(id);
  try { if (readJson(file)?.pid === process.pid) fs.rmSync(file, { force: true }); } catch { /* the next taker finds it stale */ }
}
// The record as written: read the stored one and merge (an item another writer changed later than this copy keeps that
// change), then write. Under the lease there is one writer; the merge keeps a takeover from erasing what was there.
function writeRecord(record, { root } = {}) {
  const file = operationFile(record.operationId, { root });
  const stored = readJson(file);
  if (stored && stored.operationId === record.operationId && Array.isArray(stored.items))
    record.items = record.items.map(item => {
      const other = stored.items.find(i => i.kind === item.kind && text(i.key) === text(item.key));
      return other && Date.parse(other.at) > Date.parse(item.at) ? Object.assign(item, other) : item;
    });
  writeAtomic(file, record);
}
// words: the owner's words of this execution (only their sha256 is kept in usedWords: they never confirm it again).
export function beginOperation({ preview, now, root, pid = process.pid, words = '' } = {}) {
  takeLease(preview.operationId, { root, pid });
  try { return openOperation({ preview, now, root, pid, words }); }
  catch (error) { dropLease(preview.operationId, { root }); throw error; }
}
function openOperation({ preview, now, root, pid, words }) {
  const at = iso(ms(now));
  const used = normalizeWords(words) ? [wordsSha256(words)] : [];
  const record = { schema: OPERATION_SCHEMA, operationId: preview.operationId, previewId: preview.previewId, tool: preview.tool, lane: preview.lane ?? null,
    host: preview.host, operation: preview.operation, ...(preview.clientId ? { clientId: preview.clientId } : {}), pid, startedAt: at, updatedAt: at, state: 'running', usedWords: used,
    items: preview.items.map(i => ({ kind: i.kind, key: i.key, name: i.name, ...(i.application ? { application: i.application } : {}), state: 'not-started', at })) };
  const file = operationFile(preview.operationId, { root });
  if (createExclusive(file, record)) return record;
  // A repeated execution of the same token (by state): this process runs it now, with these words.
  const existing = readJson(file) ?? record;
  const { endedAt, ...open } = existing;
  const resumed = { ...open, pid, state: 'running', resumedAt: at, updatedAt: at, usedWords: [...new Set([...(existing.usedWords ?? []), ...used])] };
  writeAtomic(file, resumed);
  return resumed;
}
export function markItem(record, ref, patch = {}, { now, root } = {}) {
  const at = iso(ms(now));
  const item = record.items.find(i => `${i.kind}:${i.key}` === refOf(ref));
  if (!item) throw new Error('no item ' + refOf(ref) + ' in operation ' + record.operationId);
  Object.assign(item, patch, { at });
  record.updatedAt = at;
  writeRecord(record, { root });
  return record;
}
// The end of the execution: the record written, then the lease released (also when the write fails).
export function endOperation(record, state, { now, root, ...extra } = {}) {
  Object.assign(record, extra, { state, updatedAt: iso(ms(now)), endedAt: iso(ms(now)) });
  try { writeRecord(record, { root }); }
  finally { dropLease(record.operationId, { root }); }
  return record;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// What a reader sees: a running operation whose process is gone is orphaned (it never ended here); in an operation that is
// not running any more, an item caught while sending reads uncertain and one caught backing up reads not-started.
// CX15 r3 (F3: N2, CT-4): a running record of THIS process whose lease this process no longer holds (its execution ended
// on a failure that could not rewrite the record) reads orphaned too: no execution of it runs here any more.
function live(record) {
  if (!record) return null;
  const mineEnded = record.pid === process.pid && !leases.has(text(record.operationId).toLowerCase());
  const orphaned = record.state === 'running' && Number.isInteger(record.pid) && (record.pid !== process.pid ? !alive(record.pid) : mineEnded);
  if (!orphaned && record.state === 'running') return record;
  return { ...record, ...(orphaned ? { orphaned: true } : {}),
    items: record.items.map(i => (i.state === 'sending' ? { ...i, state: 'uncertain', caught: 'sending' } : i.state === 'backing-up' ? { ...i, state: 'not-started', caught: 'backing-up' } : i)) };
}
// By operationId, or by the previewId whose execution it is.
export function readOperation(id, { root } = {}) {
  if (!UUID.test(text(id))) return null;
  const direct = readJson(operationFile(id, { root }));
  if (direct) return ownedByCaller(direct) ? live(direct) : null;
  const preview = readPreview(id, { root });
  const record = preview ? readJson(operationFile(preview.operationId, { root })) : null;
  return ownedByCaller(record) ? live(record) : null;
}
// ---- an execution asked for, before its record (CX15 r3, CT-2): an engine that re-reads and simulates before it opens
// the record of the operation (the O11 Service Center engine) writes operations\<operationId>.requested ({pid, at}) at the
// START of the execution and removes it when the record opens or the call ends without one. ssam_task of the preview
// then says that a call with the token is running and has not opened its record yet, never a bare "executed:false".
export const requestedFile = (operationId, { root } = {}) => path.join(rootOf(root), 'operations', text(operationId).toLowerCase() + '.requested');
export function noteExecutionRequested(preview, { now, root, pid = process.pid } = {}) {
  const file = requestedFile(preview.operationId, { root });
  try { writeAtomic(file, { operationId: preview.operationId, previewId: preview.previewId, pid, at: iso(ms(now)), ...(preview.clientId ? { clientId: preview.clientId } : {}) }); }
  catch { return { file: null, done() {} }; }
  return { file, done() { try { if (readJson(file)?.pid === pid) fs.rmSync(file, { force: true }); } catch { /* a stale marker reads as a gone process */ } } };
}
const requestedOf = (operationId, root) => { const r = readJson(requestedFile(operationId, { root })); return r && ownedByCaller(r) ? r : null; };
// ssam_task of a preview that has no execution record yet (CX15 r2, T5): by its previewId or its operationId, never
// TASK_NOT_FOUND. CX15 r3 (CT-2): never a bare "executed:false": a call with the token may be starting (an execution
// re-reads the list before it opens its record), and a requested execution says which process asked and whether it is
// alive (a process that is gone sent nothing: no send happens before the record says 'sending').
export function readPreviewState(id, { root } = {}) {
  if (!UUID.test(text(id))) return null;
  let preview = readPreview(id, { root });
  if (!preview) {
    try {
      const dir = path.join(rootOf(root), 'previews');
      for (const name of fs.readdirSync(dir).filter(n => /\.json$/i.test(n))) { const p = readJson(path.join(dir, name)); if (ownedByCaller(p) && text(p.operationId).toLowerCase() === text(id).toLowerCase()) { preview = p; break; } }
    } catch { /* no previews */ }
  }
  if (!preview) return null;
  const base = { previewId: preview.previewId, operationId: preview.operationId, tool: preview.tool, host: preview.host, operation: preview.operation,
    createdAt: preview.createdAt, expiresAt: preview.expiresAt, count: preview.items.length, items: preview.items.map(i => ({ kind: i.kind, key: i.key, name: i.name, state: 'not-started' })) };
  const requested = requestedOf(preview.operationId, root);
  if (requested) {
    const running = requested.pid === process.pid || alive(requested.pid);
    return running
      ? { state: 'execution-requested', executed: 'unknown', requestedAt: requested.at, pid: requested.pid, ...base,
        note: `A call with this token started at ${requested.at} (process ${requested.pid}) and is reading the list again before it opens its record; nothing is recorded as sent yet. Read ssam_task again in a moment; never tell the owner nothing happened.` }
      : { state: 'previewed', executed: false, requestedAt: requested.at, pid: requested.pid, requestGone: true, ...base,
        note: `A call with this token started at ${requested.at} in process ${requested.pid}, which is gone; it never opened its record, so it sent nothing (no send happens before the record says 'sending').` };
  }
  return { state: 'previewed', executed: false, ...base,
    note: 'No execution of this token is recorded yet. A call with the token may be starting (an execution reads the list again before it opens its record): read ssam_task again before telling the owner nothing happened.' };
}
const BY_STATE = { deleted: 'deleted', absent: 'absent', uncertain: 'uncertain', 'not-started': 'notStarted', refused: 'refused', 'backup-failed': 'backupFailed' };
// Counts per state and, up to max items per state, the names (else the file says where).
export function summarizeOperation(record, { max = 20, root } = {}) {
  const counts = {}; const names = {};
  for (const item of record.items) {
    const key = BY_STATE[item.state] ?? item.state;
    counts[key] = (counts[key] ?? 0) + 1;
    (names[key] ??= []).push(item.name);
  }
  return { operationId: record.operationId, previewId: record.previewId, tool: record.tool, host: record.host, operation: record.operation,
    startedAt: record.startedAt, updatedAt: record.updatedAt, state: record.state, ...(record.cancelledAt ? { cancelled: true, cancelledAt: record.cancelledAt } : {}),
    // CX15 r3: a cancellation that came with a send in flight, and the local failure that ended the record, are said too.
    ...(record.cancelRequestedAt ? { cancelRequestedAt: record.cancelRequestedAt } : {}), ...(record.localFailure ? { localFailure: record.localFailure } : {}),
    ...(record.orphaned ? { orphaned: true } : {}), counts, ...Object.fromEntries(Object.entries(names).filter(([, list]) => list.length <= max)),
    ...(Object.values(names).some(list => list.length > max) ? { file: operationFile(record.operationId, { root }) } : {}) };
}
export function listOperations({ limit = 10, root } = {}) {
  let names = [];
  try { names = fs.readdirSync(path.join(rootOf(root), 'operations')); } catch { return []; }
  const records = names.filter(n => /\.json$/i.test(n) && UUID.test(n.slice(0, -5))).map(n => readJson(path.join(rootOf(root), 'operations', n))).filter(r => ownedByCaller(r)).map(live);
  // CX15 r3 (CT-2): an execution asked for whose process lives and that has no record yet is listed too (never an empty
  // list while a call with a token reads the list again before it opens its record).
  const requested = names.filter(n => /\.requested$/i.test(n) && UUID.test(n.slice(0, -10))).map(n => requestedOf(n.slice(0, -10), root))
    .filter(r => r && (r.pid === process.pid || alive(r.pid)) && !records.some(x => text(x.operationId).toLowerCase() === text(r.operationId).toLowerCase()))
    .map(r => { const p = readPreview(r.previewId, { root }); return p ? { operationId: r.operationId, previewId: r.previewId, tool: p.tool, host: p.host, operation: p.operation,
      startedAt: r.at, state: 'execution-requested', executed: 'unknown', pid: r.pid, count: p.items.length } : null; }).filter(Boolean);
  return [...records.map(r => summarizeOperation(r, { root })), ...requested]
    .sort((a, b) => text(b.startedAt).localeCompare(text(a.startedAt))).slice(0, limit);
}

// ---- backups before deleting: a file copied (source) or bytes written (data) under backups\<operationId>\.
export const backupDir = (operationId, { root } = {}) => path.join(rootOf(root), 'backups', text(operationId).toLowerCase());
export function storeBackup({ operationId, name, source, data, root } = {}) {
  const dir = backupDir(operationId, { root });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, text(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'backup');
  const bytes = source ? fs.readFileSync(source) : Buffer.isBuffer(data) ? data : Buffer.from(text(data), 'utf8');
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, bytes, { flag: 'wx' });
  renameRetrying(temporary, file);
  return { path: file, sha256: sha256(bytes), bytes: bytes.length };
}

// ---- passthroughs: the bridge commands that delete records or call the Portal directly never run through a generic
// passthrough (studio_command, .\odc studio): the dedicated tool previews and confirms them.
export const DESTRUCTIVE_BRIDGE_COMMANDS = Object.freeze(['data-delete', 'portal-call', 'portal-private-call', 'portal-api-client-fixture-cleanup']);
const DEDICATED = {
  'data-delete': { tool: 'studio_data_delete', arguments: { module: '<module>', entity: '<entity>', ids: ['<id>'] }, also: [] },
  'portal-call': { tool: 'odc_read', arguments: { operationId: '<operation>' }, also: ['odc_write'] },
  'portal-private-call': { tool: 'odc_portal_read', arguments: { operationId: '<route>' }, also: ['odc_portal_write'] },
  'portal-api-client-fixture-cleanup': { tool: 'odc_portal_write', arguments: { operationId: 'apiClients.delete', input: {} }, also: [] },
};
// The command the bridge would run for these arguments (CX15 r2, R-A1): the pipe sends args.join(' '), the bridge trims
// the line and takes the text up to the first space (StartupHook.cs). The refusal reads the same line, and is stricter: any
// whitespace ends the word and the case is ignored, so "", " " or a leading space before it, one argument with spaces, a tab
// or another case never pass.
// CX15 r3 (BYPASS-1): the ends are trimmed of EXACTLY what the bridge's String.Trim() removes (every .NET
// char.IsWhiteSpace: U+0009-000D, U+0020, U+0085, U+00A0, U+1680, U+2000-200A, U+2028, U+2029, U+202F, U+205F, U+3000),
// not of JavaScript's \s (which keeps U+0085: "\u0085data-delete" passed the refusal and the bridge ran data-delete);
// any of them, or any \s, ends the word.
const NET_WHITESPACE = '\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const NET_TRIM = new RegExp(`^[${NET_WHITESPACE}]+|[${NET_WHITESPACE}]+$`, 'gu');
const WORD_END = new RegExp(`[\\s${NET_WHITESPACE}]+`, 'u');
export const netTrim = value => text(value).replace(NET_TRIM, '');
const bridgeLineOf = (command, args = []) => [command, ...(Array.isArray(args) ? args : [])].map(text).join(' ');
export function bridgeCommandOf(command, args = []) {
  return netTrim(bridgeLineOf(command, args)).split(WORD_END)[0].toLowerCase();
}
// The start of the line before its first visible character, when it holds anything but ASCII spaces: a non-ASCII
// whitespace, a control or a format character (U+0085, U+00A0, a tab, U+200B, U+FEFF...). Such a line is refused whatever
// the command behind it (CX15 r3, BYPASS-1): the bridge's Trim() would remove part of it and run what follows.
const INVISIBLE_START = /^[\s\p{Cc}\p{Cf}\p{Z}]+/u;
export function bridgeLineUnsafeStart(command, args = []) {
  const start = INVISIBLE_START.exec(bridgeLineOf(command, args))?.[0] ?? '';
  const odd = [...start].filter(c => c !== ' ');
  return odd.length ? [...new Set(odd.map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')))] : null;
}
export function bridgeCommandRefusal(command, args = [], { surface = 'studio_command' } = {}) {
  const first = bridgeCommandOf(command, args);
  const dedicated = DESTRUCTIVE_BRIDGE_COMMANDS.includes(first) ? dedicatedToolRefusal(first, { surface }) : null;
  const unsafe = bridgeLineUnsafeStart(command, args);
  if (!unsafe) return dedicated;
  // One refusal with everything: the unsafe start, and the dedicated tool when the command behind it is destructive.
  const unsafeProblem = problem('BRIDGE_LINE_UNSAFE_START', `The bridge line starts with ${unsafe.join(', ')} before the command: the bridge trims part of such characters `
    + 'and runs what follows, so the line is never sent. Nothing was sent to the bridge.', 'the command name first, with no invisible or control character before it');
  if (dedicated) return { ...dedicated, problems: [problem('DESTRUCTIVE_NEEDS_DEDICATED_TOOL', dedicated.error, `the dedicated tool ${dedicated.continuation.tool}`), unsafeProblem] };
  return { ok: false, code: 'BRIDGE_LINE_UNSAFE_START', outcome: 'not-sent', error: `${surface} never sends a line that starts with ${unsafe.join(', ')}: ${unsafeProblem.message}`,
    problems: [unsafeProblem] };
}
export function dedicatedToolRefusal(command, { surface = 'studio_command' } = {}) {
  const dedicated = DEDICATED[text(command)];
  if (!dedicated) return null;
  return { ok: false, code: 'DESTRUCTIVE_NEEDS_DEDICATED_TOOL', outcome: 'not-sent', command: text(command),
    error: `${surface} never runs ${command}: it deletes records or calls the Portal directly, without the preview and the owner's confirmation `
      + `(rule of 2026-10-15, also for a read through it). Nothing was sent to the bridge.`,
    tools: [dedicated.tool, ...dedicated.also],
    continuation: { tool: dedicated.tool, arguments: dedicated.arguments, why: `the dedicated tool of ${command}: it previews the exact list and needs the owner's confirmation before anything is deleted` } };
}

// ---- the table of destructive verbs (CX15 inventory). For a classification of tools (CX12: what is not declared a read
// is a write): a destructive call WITHOUT confirmationToken is a preview, a read; WITH it, an execution, a write; a
// passthrough of a destructive bridge command is refused. destructive(args) answers for the routes whose effect only the
// catalog knows (odc_write, odc_portal_write).
const tokenIn = args => Boolean(text(args?.confirmationToken).trim());
const dataOps = request => (Array.isArray(request?.batch) ? request.batch : request ? [request] : []).filter(op => op?.operation === 'delete');
export const DESTRUCTIVE_TOOLS = Object.freeze([
  { tool: 'o11_service_center_write', field: 'action', verbs: ['delete', 'module-delete', 'extension-delete', 'application-delete', 'solution-delete', 'db-connection-delete'] },
  { tool: 'o11_environment', field: 'action', verbs: ['delete-app'] },
  { tool: 'o11_extension', field: 'action', verbs: ['delete'] },
  { tool: 'o11_data', field: 'request.operation', verbs: ['delete'] },
  { tool: 'studio_data_delete', field: null, verbs: null },
  { tool: 'studio_command', field: 'command', verbs: [...DESTRUCTIVE_BRIDGE_COMMANDS], refuse: true },
  { tool: 'odc_asset_delete', field: null, verbs: null },
  { tool: 'odc_a2a_connection_delete', field: null, verbs: null },
  { tool: 'odc_write', field: 'operationId', verbs: null, effect: 'destructive' },
  { tool: 'odc_deploy', field: 'operation', verbs: ['Undeploy'] },
  { tool: 'odc_portal_write', field: 'operationId', verbs: null, effect: 'destructive' },
  { tool: 'odc_external_db_connection', field: 'action', verbs: ['delete', 'remove-entities'] },
  { tool: 'odc_external_library', field: 'action', verbs: ['discard'] },
]);
export function destructivePhase(tool, args = {}, { destructive } = {}) {
  const entry = DESTRUCTIVE_TOOLS.find(e => e.tool === tool);
  if (!entry) return null;
  // CX15 r3 (BYPASS-1, CT-12): the passthrough is read as the bridge reads its line (bridgeCommandOf), arguments included;
  // a line the refusal stops (a destructive command, or an unsafe start) never reaches the bridge.
  if (entry.refuse) return bridgeCommandRefusal(args?.command, args?.args ?? []) ? 'refuse' : null;
  if (tool === 'o11_data') {
    const ops = dataOps(args?.request);
    return ops.length ? (ops.every(op => tokenIn(op)) ? 'execute' : 'preview') : null;
  }
  if (entry.effect) { if (typeof destructive !== 'function' || !destructive(args)) return null; }
  else if (entry.verbs && !entry.verbs.includes(text(args?.[entry.field]))) return null;
  return tokenIn(args) ? 'execute' : 'preview';
}
