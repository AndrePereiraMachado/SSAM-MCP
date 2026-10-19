// The replay of an unconfirmed final answer (Integradora, 2026-10-18, review rounds 2 and 3).
// No MCP answer is acknowledged by the client: a client may stop waiting without a word (a timeout that sends no
// cancellation, a closed connection, an abandoned stdio request). So the final answer of a run-to-end call that was kept
// past the call deadline (call-deadline.mjs) counts as not delivered, and when it applied work an identical call within
// REPLAY_WINDOW_MS (the CX12 10 minutes) gets it (resumedFrom), never a second run.
// "Identical" is decided by the served handler (createReplay below: ssam.mjs, and the hosted served handler after its gate),
// after the arguments are resolved, on:
//  - the slot: the tool and its normalized arguments, the defaults of its input schema filled (a default written or not is
//    one call);
//  - the print: the slot and the sha256 of the content of every file the call reads (an absolute path to a file; a JSON file
//    also for the absolute paths it names, two levels deep). A path this server cannot read for sure (relative, also a bare
//    file name, agent:, ws:, file:, a Windows path on a POSIX server) gives no print: no replay for that call, only the live
//    join of call-deadline.mjs.
// The store is the task folder of the call (the customer's, shared by its sessions): <tasks>/.replays/<slot>.json names the
// task, the print, the kept answer (.local/answers, by its sha256), its window and its subjects. It survives a restart. Any
// write ends the replays of its subject (all of them when it names none); a replay of a call whose outcome depends on other
// modules (a publication, a deployment, a refresh) ends with any write. Expired entries are swept by every write.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalArguments } from './read-budget.mjs';
import { resultIs } from './result-values.mjs';
import { callScope, annotateAnswer } from './call-deadline.mjs';
import { mergeTask } from './ssam-task.mjs';
import { isMutation, runsToEnd, nestsDelivery, keepsReplay, subjectsOf, dependsOnOthers } from './tool-classification.mjs';

export const REPLAY_WINDOW_MS = 600000;
const sha = text => createHash('sha256').update(text).digest('hex');
const replaysDir = dir => path.join(dir, '.replays');

// The arguments as the tool runs them: the top-level defaults of its input schema filled where they were left out.
export function normalizedArguments(args, schema) {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  for (const [name, property] of Object.entries(schema?.properties ?? {}))
    if (value[name] === undefined && property && typeof property === 'object' && Object.hasOwn(property, 'default')) value[name] = property.default;
  return value;
}
export function replaySlot(name, args, schema) {
  return { tool: name, key: sha(name + '\0' + canonicalArguments(normalizedArguments(args, schema))), args };
}

// A string that names a file: on Windows a drive or UNC path, elsewhere a POSIX one. A path the server cannot read for sure:
// a scheme (agent:, ws:, file:: the gate resolves it), a relative path (with a folder, or a bare file name of an input kind:
// relative to a root this server does not resolve here), and on a POSIX server a path of a Windows machine (the agent's).
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const SCHEME = /^(?:agent|ws|file):/i;
const RELATIVE = /^(?:\.{1,2}[\\/]|[^\s:*?"<>|\\/][^\s:*?"<>|]*[\\/][^\s:*?"<>|]*\.[A-Za-z0-9]{1,8}$)/;
const BARE_FILE = /^[^\s:*?"<>|\\/]+\.(?:json|jsonl|oml|osp|oap|xif|avsig|zip|nupkg|dll|xml|ya?ml|csv|txt|sql|html?|css|m?js|cs)$/i;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
// The print of a slot: null when a file the call reads cannot be read for sure. platform: the system this server reads on.
export function replayPrint(slot, options) { return replayPrintOf(slot, options).print; }
// The print and, when it is null, why (round 3d, the cause of re-review B1): "path" (a path this server cannot read for
// sure: relative, agent:, ws:, file:, another machine's, or a file it cannot open) or "size" (too large to look at whole).
export function replayPrintOf(slot, { platform = process.platform } = {}) {
  if (!slot) return { print: null, unreadable: 'path' };
  const posix = platform !== 'win32';
  const ABSOLUTE = posix ? /^\// : WINDOWS_ABSOLUTE;
  // a bare file name only as an argument (or an item of a list argument): inside a job it names an element (a resource "app.js")
  const unsure = (value, depth, nested) => SCHEME.test(value) || posix && WINDOWS_ABSOLUTE.test(value)
    || !ABSOLUTE.test(value) && (RELATIVE.test(value) || nested === 0 && depth <= 2 && BARE_FILE.test(value));
  const files = {};
  let unreadable = false, strings = 0, reason = 'path';
  // Whatever cannot be looked at whole (too deep, too many strings) is no proof either.
  const visit = (value, depth, nested) => {
    if (unreadable || value == null) return;
    if (depth > 64 || strings > 20000) { unreadable = true; reason = 'size'; return; }
    if (typeof value === 'string') {
      strings++;
      if (value.length > 1024) return;
      if (unsure(value, depth, nested)) { unreadable = true; return; }
      if (!ABSOLUTE.test(value)) return;
      const file = path.resolve(value);
      if (Object.hasOwn(files, file)) return;
      let stat;
      try { stat = fs.statSync(file); } catch { return; } // an output, or a missing input the call refuses
      if (!stat.isFile()) return;
      if (stat.size > MAX_FILE_BYTES) { unreadable = true; reason = 'size'; return; }
      let body;
      try { body = fs.readFileSync(file); } catch { unreadable = true; return; }
      files[file] = sha(body);
      if (nested < 2 && /\.json$/i.test(file)) { try { visit(JSON.parse(body.toString('utf8')), 0, nested + 1); } catch { /* not JSON: its bytes are hashed */ } }
      return;
    }
    if (typeof value === 'object') for (const child of Object.values(value)) visit(child, depth + 1, nested);
  };
  visit(slot.args, 0, 0);
  return unreadable ? { print: null, unreadable: reason } : { print: sha(slot.key + '\0' + canonicalArguments(files)), unreadable: null };
}

// A final answer that applied work: an explicit ok, or a delivery whose later step failed (result delivered, publish
// failed). No explicit ok is no proof; an uncertain outcome keeps the CX12 rule (reconciled first, never repeated).
const valueOf = answer => { if (answer?.structuredContent !== undefined) return answer.structuredContent; try { return JSON.parse(answer?.content?.find(c => c.type === 'text')?.text); } catch { return null; } };
export function appliedAnswer(answer) {
  const value = valueOf(answer);
  if (!value || typeof value !== 'object' || value.outcome === 'uncertain') return false;
  return value.ok === true || value.ok === false && (value.delivered === true || value.writeState === 'applied' || resultIs(value.result, 'delivered', 'deliveredAndPublished', 'published'));
}

const readEntry = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeEntry = (file, entry) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(entry)); fs.renameSync(temporary, file);
};
export const hasReplay = (dir, slot) => !!slot && fs.existsSync(path.join(replaysDir(dir), slot.key + '.json'));
// The kept answer of the same call, or null (another print, past its window, an answer whose bytes changed).
export function findReplay(dir, slot, print, { now = Date.now() } = {}) {
  if (!slot || !print) return null;
  const entry = readEntry(path.join(replaysDir(dir), slot.key + '.json'));
  if (!entry || entry.tool !== slot.tool || entry.print !== print || !(entry.until > now)) return null;
  try {
    const body = fs.readFileSync(entry.answer.file, 'utf8');
    if (sha(body) !== entry.answer.sha256) return null;
    return { id: entry.id, until: entry.until, answer: JSON.parse(body) };
  } catch { return null; }
}
export function keepReplay(dir, slot, print, { id, answer, subjects = [], dependsOnOthers = false, windowMs = REPLAY_WINDOW_MS, now = Date.now() }) {
  const until = now + windowMs;
  writeEntry(path.join(replaysDir(dir), slot.key + '.json'), { tool: slot.tool, key: slot.key, print, id, answer: { file: answer.file, sha256: answer.sha256 },
    subjects, dependsOnOthers, at: now, until });
  return until;
}
// A write ends the replays of its subject (every one when it names none, and every one that depends on other modules);
// expired entries go too. Answers the task ids whose replay ended, for their records.
export function endReplays(dir, { subjects = [], now = Date.now() } = {}) {
  const folder = replaysDir(dir);
  let names = [];
  try { names = fs.readdirSync(folder).filter(name => name.endsWith('.json')); } catch { return []; }
  const wanted = new Set(subjects);
  const ended = [];
  for (const name of names) {
    const file = path.join(folder, name), entry = readEntry(file);
    const expired = !entry || !(entry.until > now);
    const hit = expired || !wanted.size || entry.dependsOnOthers === true || !entry.subjects?.length || entry.subjects.some(subject => wanted.has(subject));
    if (!hit) continue;
    try { fs.rmSync(file, { force: true }); } catch { continue; }
    if (entry?.id && !expired) ended.push(entry.id);
  }
  return ended;
}

// The paths of the listed fields ("job", "basedOn.job") that are relative, resolved under root as a tool that declares that
// root resolves them (round 3c, M1: studio_deliver's job is relative to the ODC lane root). Absolute paths, schemes (agent:,
// ws:, file:) and other fields stay as they came.
export function resolveRelativePaths(args, root, fields) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !root) return args;
  const out = { ...args };
  for (const field of fields) {
    const keys = field.split('.');
    let holder = out;
    for (const key of keys.slice(0, -1)) {
      if (!holder[key] || typeof holder[key] !== 'object' || Array.isArray(holder[key])) { holder = null; break; }
      holder = holder[key] = { ...holder[key] };
    }
    const last = keys.at(-1), value = holder?.[last];
    if (typeof value !== 'string' || !value.trim() || SCHEME.test(value) || path.isAbsolute(value) || WINDOWS_ABSOLUTE.test(value)) continue;
    holder[last] = path.resolve(root, value);
  }
  return out;
}

// The replay of one server, for its served handler (ssam.mjs; the hosted served handler, after its gate). folder: the task
// folder of a call its deadline entry does not name; schemaOf(tool): the listed input schema, for the defaults; resolve(tool,
// args): the arguments as the tool or the gate resolves the paths they name (ssam.mjs: studio_deliver's relative job; a
// hosted line: ws: to the workspace), so the deadline and the served handler read the same files the tool reads.
//  - inputsOf(tool, args): for createCallDeadline (its live join and its CX12 replay): {key, print, replay} of a run-to-end
//    call on the arguments the deadline sees (also of a call a delivery runs inside: ssam_code write, round 3d), undefined
//    outside the family; replay false: a publication, refresh, deployment
//    or package (tool-classification.mjs keepsReplay), whose final answer is never given to a later identical call;
//  - outerPrints(tool, args): a run-to-end call starts, perhaps nested in another (ssam_code write): the outer calls take
//    their print now, and keep no replay when the nested one keeps none (a publication, refresh, deployment or package);
//  - start(tool, args), first in the served handler, on the arguments the tool runs (resolved): null outside a write served
//    by its own deadline entry; {hit} the kept answer of the same call; else the state of the call, whose print is the
//    deadline's only when the deadline saw these same arguments (else it is taken here, after the gate: A1), and any write
//    has ended the replays of its subject (A2);
//  - keep(state, final, save): the final answer of a kept, applied run-to-end call is kept for the identical call, its window
//    in the task record (A4); save(final) keeps the answer and gives {file, sha256}. Also of a call cancelled before the
//    deadline whose work still applied (round 3c, M1): the CX12 rule "a cancelled definitive answer is delivered once", on
//    the content after the gate when the deadline could not read it.
export function createReplay({ folder, windowMs = REPLAY_WINDOW_MS, schemaOf = () => undefined, platform = process.platform, resolve = null } = {}) {
  const resolved = (name, args) => { try { return resolve?.(name, args) ?? args; } catch { return args; } };
  const slotOf = (name, args) => replaySlot(name, resolved(name, args), schemaOf(name));
  const inputsOf = (name, args) => {
    if (!runsToEnd(name, args) && !nestsDelivery(name, args)) return undefined;
    const slot = slotOf(name, args), { print, unreadable } = replayPrintOf(slot, { platform });
    return { key: slot.key, print, replay: keepsReplay(name, args), ...(unreadable ? { unreadable } : {}) };
  };
  const outerPrints = (name, args) => {
    const none = name !== undefined && !keepsReplay(name, args);
    for (let scope = callScope.getStore(), depth = 0; scope && depth < 64; scope = scope.parent, depth++) { if (none) scope.noReplay = true; scope.replay?.printOf(); }
  };
  const start = (name, args) => {
    const scope = callScope.getStore();
    if (!scope || scope.tool !== name || scope.replay !== undefined) return null;
    scope.replay = null;
    if (!isMutation(name, args)) return null;
    const dir = scope.dir ?? folder;
    const slot = slotOf(name, args);
    // the deadline's print, taken as the call came in, only for these same arguments; after a gate it is taken here
    let print = scope.inputs && scope.inputs.key === slot.key ? scope.inputs.print : undefined;
    const state = { scope, dir, slot, name, args, printOf: () => (print === undefined ? (print = replayPrint(slot, { platform })) : print) };
    if (keepsReplay(name, args) && hasReplay(dir, slot)) {
      const found = findReplay(dir, slot, state.printOf());
      if (found) return { ...state, hit: annotateAnswer(found.answer, { resumedFrom: found.id }) };
    }
    for (const id of endReplays(dir, { subjects: subjectsOf(name, args) })) { try { mergeTask(dir, { id, replayUntil: null }); } catch { /* the index entry is gone */ } }
    scope.replay = state;
    if (runsToEnd(name, args)) state.printOf(); // the inputs as the call starts
    return state;
  };
  const keep = (state, final, save) => {
    if (!state?.scope?.runsToEnd || !(state.scope.kept || state.scope.cancelled) || state.scope.noReplay || !keepsReplay(state.name, state.args) || !appliedAnswer(final)) return;
    const print = state.printOf();
    if (!print) return;
    try {
      const until = keepReplay(state.dir, state.slot, print, { id: state.scope.id, answer: save(final), subjects: subjectsOf(state.name, state.args),
        dependsOnOthers: dependsOnOthers(state.name, state.args), windowMs });
      mergeTask(state.dir, { id: state.scope.id, replayUntil: new Date(until).toISOString() });
    } catch { /* no replay: the call ran and answered */ }
  };
  return { inputsOf, outerPrints, start, keep };
}
