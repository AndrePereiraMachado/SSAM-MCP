// R2 (docs/PLANO-PRIMEIRA-CERTA-E-VELOCIDADE-2026-10-24.md "R2"): incremental writing for ssam_code. The model opens a draft,
// sends each part (an action, a screen or block, a data text, raw ops) as soon as it is written and hears that part's
// problems at once, while the context is fresh; a final write {draft} only delivers. No engine of its own:
//   - a part is checked by the same composition a write makes (ssam-code.mjs writeCall: parse of the call, split of actions
//     and documents, the forms) with the draft's module, and, when check is served and the lane has a local capture, by
//     ssam_code check of that part together with the parts already accepted, so a reference to another part of the draft
//     resolves; its problems are the ones a refused write would answer, each with its fix;
//   - 3 s after the last part, the whole set of accepted parts is checked in the background and the answer kept by the
//     sha256 of the job it composes (checks.json); the write reuses it and never checks the same job twice;
//   - write {draft} composes every part in ONE writeCall (orderParts: ops, data, documents, actions, edits) and calls the
//     registered deliver exactly once: the same journal, gates, authorization words and single refusal as a write.
// A draft belongs to the client that opened it (ctx.customer, else SSAM_CUSTOMER, else the workspace root, kept as a
// sha256), its lane and its module; it lives in <lane work>/drafts/<id>/ so a reconnected server reads it back; it expires
// 30 min after its last part. A delivered draft is closed; a refused delivery leaves it open for parts or a normal patch.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CODE_TOOL, writeCall, readCodeFiles, splitActions, splitDocuments, headerOf, namesOf, canonicalPart, partOfText, codeAnswer } from './ssam-code.mjs';
import { mergeNormalizations } from './normalizations.mjs';
import { resultIs } from './result-values.mjs';
import { DRAFT_ID } from './code-draft-schema.mjs';

export const DRAFT_SCHEMA = 'ssam-code-draft/1';
export const DRAFT_TTL_MS = 30 * 60 * 1000;
export const DRAFT_IDLE_MS = 3000;
// The checked sets a draft keeps (the newest ones): a write needs only the set of its parts.
const KEPT_CHECKS = 8;
// What a write {draft} takes from the call: the delivery options of a write. The code is in the parts.
const CODE_FIELDS = ['part', 'text', 'files', 'ops', 'also', 'edits', 'patch', 'basedOn', 'element', 'removes'];

const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = text => createHash('sha256').update(text).digest('hex');
const iso = ms => new Date(ms).toISOString();
const nowOf = deps => Number(typeof deps.now === 'function' ? deps.now() : deps.now ?? Date.now());
const textList = text => (Array.isArray(text) ? text : [text]).map(t => String(t ?? ''));
const hasText = text => text != null && textList(text).some(t => t.trim());
const DOCUMENT = /^\s*(?:<!--[\s\S]*?-->\s*)*<(screen|block)[\s/>]/;

// ---- where a draft lives and whose it is
async function draftsDir(lane, deps) {
  if (typeof deps.dir === 'function') return deps.dir(lane);
  if (typeof deps.dir === 'string') return deps.dir;
  // Hosted (servidor line): a draft is the customer's data, in its own workspace (<ws>/o11/drafts, <ws>/odc/drafts), never
  // the server's lane folders that every customer shares.
  const { hostedContext, workspacePath } = await import('./executor.mjs');
  if (hostedContext()) return workspacePath(lane === 'o11' ? 'o11' : 'odc', 'drafts');
  const { anvilRoot, o11Lane } = await import('./workspace.mjs');
  if (lane === 'o11') { const { o11LaneOf } = await import('./o11-lane.mjs'); return path.join(o11LaneOf(o11Lane.lane, { root: anvilRoot }).work, 'drafts'); }
  return path.join(anvilRoot, '.local', 'lane-odc', 'work', 'drafts');
}
// The client of the session, as the build pool names it (o11-build-phase.mjs): never kept in clear.
// Hosted: the customer's token (the one the hosted context names), whatever the session context says.
async function ownerOf(ctx, deps) {
  const hosted = (await import('./executor.mjs')).hostedContext();
  if (hosted?.tokenId) return sha('ssam-draft-owner\nhosted:' + hosted.tokenId);
  const who = ctx?.customer ?? (deps.env ?? process.env).SSAM_CUSTOMER ?? deps.root ?? (await import('./workspace.mjs')).workspaceRoot;
  return sha('ssam-draft-owner\n' + String(who));
}
const draftFile = (dir, id) => path.join(dir, id, 'draft.json');
const checksFile = (dir, id) => path.join(dir, id, 'checks.json');
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}
const save = (dir, draft) => writeJson(draftFile(dir, draft.id), draft);
// The checked sets live beside the draft, so a background check never races the parts written meanwhile.
const readChecks = (dir, id) => readJson(checksFile(dir, id)) ?? {};
function keepCheck(dir, id, key, result) {
  const checks = { ...readChecks(dir, id), [key]: result };
  const newest = Object.entries(checks).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, KEPT_CHECKS);
  writeJson(checksFile(dir, id), Object.fromEntries(newest));
}

// One change of a draft at a time in this process (parts, writes); a background check takes no turn.
const turns = new Map();
function inTurn(id, fn) {
  const run = (turns.get(id) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  turns.set(id, tail);
  tail.then(() => { if (turns.get(id) === tail) turns.delete(id); });
  return run;
}
const timers = new Map();   // draft id -> the idle timer of its background check
const building = new Map(); // draft id + set sha -> the background check of that set

// ---- answers
const refusal = (code, error, extra = {}) => ({ ok: false, code, tool: CODE_TOOL, error, ...extra });
const openCall = (lane, module) => ({ tool: CODE_TOOL, arguments: { lane, action: 'draft', module: module ?? '<Module>' }, why: 'opens a new draft of the module' });
const statusCall = (lane, id) => ({ tool: CODE_TOOL, arguments: { lane, action: 'draft', draft: id }, why: 'the parts of the draft, their problems and the ready write' });
const partCall = (lane, id) => ({ tool: CODE_TOOL, arguments: { lane, action: 'part', draft: id, part: '<ddl|logic|html>', text: '<one action, screen, block or data text>' }, why: 'each part as soon as it is written: its problems come back at once' });
const writeOf = (lane, id) => ({ tool: CODE_TOOL, arguments: { lane, action: 'write', draft: id }, why: 'every part in one delivery (add authorize and publish:true only with the user\'s words)' });
const summaryOf = draft => ({ parts: draft.parts.length, accepted: draft.parts.filter(p => p.status === 'accepted').length,
  pending: draft.parts.filter(p => p.status !== 'accepted').map(p => p.id) });
const rowOf = p => ({ id: p.id, part: p.part, names: p.names, status: p.status, ...(p.problems?.length ? { problems: p.problems } : {}) });
const draftRef = draft => ({ id: draft.id, lane: draft.lane, module: draft.module, state: draft.state, expiresAt: draft.expiresAt });

// The draft of a call, after its checks: {draft, dir} or {refusal}.
async function loadDraft(input, ctx, deps, { forWrite = false } = {}) {
  const id = String(input.draft ?? '');
  const lane = input.lane === 'o11' ? 'o11' : 'odc';
  if (!new RegExp(DRAFT_ID).test(id)) return { refusal: refusal('INPUT_INVALID', 'draft is the id an action draft {module} returned', { continuation: openCall(lane, input.module) }) };
  const dir = await draftsDir(lane, deps);
  let draft = readJson(draftFile(dir, id));
  if (!draft) {
    const other = lane === 'o11' ? 'odc' : 'o11';
    const elsewhere = readJson(draftFile(await draftsDir(other, deps), id));
    return { refusal: elsewhere ? refusal('DRAFT_OTHER_LANE', `draft ${id} is a draft of lane ${other}`, { continuation: statusCall(other, id) })
      : refusal('DRAFT_NOT_FOUND', `no draft ${id} on lane ${lane}`, { continuation: openCall(lane, input.module) }) };
  }
  // Another client's draft is refused as if it did not exist for it: nothing of it is read back.
  if (draft.owner !== await ownerOf(ctx, deps)) return { refusal: refusal('DRAFT_NOT_OWNED', `draft ${id} belongs to another client of this server: open a draft of your own`, { continuation: openCall(lane, input.module ?? draft.module) }) };
  if (input.module != null && String(input.module).toLowerCase() !== String(draft.module).toLowerCase())
    return { refusal: refusal('INPUT_INVALID', `draft ${id} is a draft of module ${draft.module}, not ${input.module}`, { continuation: statusCall(lane, id) }) };
  if (draft.state === 'delivered') return { refusal: refusal('DRAFT_CLOSED', `draft ${id} was delivered (${draft.delivery?.at ?? ''}); a new change is a new draft`, { delivery: draft.delivery ?? null, continuation: openCall(lane, draft.module) }) };
  if (draft.state === 'writing' || draft.state === 'uncertain') return { refusal: refusal(draft.state === 'writing' ? 'DRAFT_WRITE_RUNNING' : 'DRAFT_UNCERTAIN',
    `the write of draft ${id} ${draft.state === 'writing' ? 'is running' : 'ended with an unknown outcome'}: it is never written again; read the delivery task first`,
    { delivery: draft.delivery ?? null, continuation: { tool: 'ssam_task', arguments: {}, why: 'the recent deliveries and their outcome' } }) };
  if (nowOf(deps) > Date.parse(draft.expiresAt)) return { refusal: refusal('DRAFT_EXPIRED', `draft ${id} expired at ${draft.expiresAt} (30 min after its last part)`, { continuation: openCall(lane, draft.module) }) };
  if (forWrite && !draft.parts.length) return { refusal: refusal('DRAFT_EMPTY', `draft ${id} has no part`, { continuation: partCall(lane, id) }) };
  return { draft, dir };
}

// ---- the parts of a call: one per action, per <screen>/<block> document, per data text, per list of raw ops
function entriesOf(input) {
  const entries = [], problems = [], notes = [];
  const split = p => {
    if (p.part === 'logic' && p.edits == null) {
      const texts = textList(p.text);
      const bases = Array.isArray(p.basedOn) ? p.basedOn : p.basedOn != null ? [p.basedOn] : [];
      if (bases.length && bases.length !== texts.length) problems.push({ code: 'INPUT_INVALID', at: p.from + '/basedOn', error: 'basedOn of logic is one textSha per text, in the same order (null for a new action)' });
      texts.forEach((text, i) => {
        const actions = splitActions(text);
        if (actions && bases[i] != null) problems.push({ code: 'INPUT_INVALID', at: p.from, error: `text ${i + 1} holds ${actions.length} actions and one basedOn: send one text per action, each with its textSha` });
        if (actions) notes.push({ rule: 'draft-split', at: '/' + p.from, note: `text ${i + 1} holds ${actions.length} actions: ${actions.length} parts` });
        for (const action of actions ?? [text]) entries.push({ part: 'logic', text: action, ...(bases[i] != null && !actions ? { basedOn: bases[i] } : {}), ...(p.removes != null ? { removes: p.removes } : {}), from: p.from });
      });
      return;
    }
    if (p.part === 'html' && p.basedOn == null && p.edits == null) {
      const list = textList(p.text);
      const docs = list.every(t => DOCUMENT.test(t)) ? list.flatMap(t => splitDocuments(t) ?? [t]) : null;
      if (docs) {
        if (docs.length > 1) notes.push({ rule: 'draft-split', at: '/' + p.from, note: `${docs.length} <screen>/<block> documents: ${docs.length} parts` });
        for (const doc of docs) entries.push({ part: 'html', text: doc, from: p.from });
        return;
      }
    }
    const { from, ...rest } = p;
    entries.push(Object.fromEntries(Object.entries({ ...rest, from }).filter(([, v]) => v !== undefined)));
  };
  if (input.files != null) {
    const files = readCodeFiles(input.files);
    problems.push(...files.problems.map(p => ({ code: 'INPUT_INVALID', ...p })));
    notes.push(...files.notes);
    for (const f of files.parts) f.part === 'ops' ? entries.push({ part: 'ops', ops: f.ops, from: f.at }) : split({ part: f.part, text: f.text, from: f.at });
  }
  if (input.ops != null) {
    if (!Array.isArray(input.ops) || !input.ops.length || !input.ops.every(op => plain(op) && typeof op.op === 'string' && op.op.trim())) problems.push({ code: 'INPUT_INVALID', at: 'ops', error: 'ops is a list of job ops, each with an op name' });
    else entries.push({ part: 'ops', ops: input.ops, from: 'ops' });
  }
  if (hasText(input.text) || input.edits != null) {
    const part = canonicalPart(input.part) ?? (hasText(input.text) ? partOfText(input.text) : null);
    if (!part) problems.push({ code: 'INPUT_INVALID', at: 'part', error: 'part: ddl, logic or html (the text is none of them by its form)' });
    else {
      if (input.part == null) notes.push({ rule: 'part-from-text', at: '/part', note: `the text is part ${part} by its form` });
      split({ part, text: input.text, basedOn: input.basedOn, element: input.element, removes: input.removes, edits: input.edits, from: input.edits != null ? 'edits' : 'text' });
    }
  }
  return { entries, problems, notes };
}

// The names a part creates or changes and the key that replaces it: the action (with its screen), the document, the screen
// an edit changes, the data elements, the elements raw ops create.
function namesOfEntry(e) {
  if (e.part === 'ops') {
    const names = e.ops.flatMap(op => [...(op.op === 'create' && typeof op.name === 'string' ? [op.name] : []),
      ...(Array.isArray(op.data?.actions) ? op.data.actions.map(a => a?.name).filter(n => typeof n === 'string') : [])]);
    return names.length ? names : ['ops#' + sha(JSON.stringify(e.ops)).slice(0, 12)];
  }
  if (e.part === 'logic') {
    if (e.edits != null && e.element) return [String(e.element)];
    const h = headerOf(e.text);
    return h ? [(h.owner ? h.owner + '.' : '') + h.name] : ['logic#' + sha(String(e.text)).slice(0, 12)];
  }
  if (e.part === 'html') {
    if (e.element && (e.edits != null || e.basedOn != null || !DOCUMENT.test(textList(e.text).join('\n')))) return [String(e.element).split(/[/:]/).pop()];
    const names = namesOf('html', e.text);
    return names.length ? names : ['html#' + sha(textList(e.text).join('\n')).slice(0, 12)];
  }
  // The SQL Server form a refused data text was written in (CREATE TABLE X) names the same element its correction does.
  const sqlNames = [...String(e.text).matchAll(/^\s*create\s+(?:static\s+)?(?:table|entity)\s+\[?([A-Za-z_]\w*)/gim)].map(m => m[1]);
  const names = [...namesOf('ddl', e.text), ...sqlNames].filter((n, i, all) => all.findIndex(m => m.toLowerCase() === n.toLowerCase()) === i);
  return names.length ? names : ['ddl#' + sha(String(e.text)).slice(0, 12)];
}
const low = names => names.map(n => n.toLowerCase());
// The parts a new one replaces: the same action, document or screen (or ops naming the same elements); a data text replaces the
// data texts whose names it all holds. A data text that holds some of another's names but not all is one problem (the rest
// would be lost): {replaced, overlap}.
function replacedBy(entry, parts) {
  const mine = new Set(low(entry.names));
  const same = parts.filter(p => p.part === entry.part && p.names.length && low(p.names).some(n => mine.has(n)));
  if (entry.part !== 'ddl') return { replaced: same };
  const overlap = same.find(p => !low(p.names).every(n => mine.has(n)));
  return overlap ? { replaced: [], overlap } : { replaced: same };
}

// ---- composition: the parts of a set as ONE write input and its delivery call
const writePart = e => Object.fromEntries(Object.entries({ part: e.part, text: e.text, basedOn: e.basedOn, element: e.element, removes: e.removes, edits: e.edits }).filter(([, v]) => v !== undefined));
function composeSet(draft, set, options = {}) {
  const opsParts = set.filter(e => e.part === 'ops');
  const code = set.filter(e => e.part !== 'ops');
  const ops = opsParts.flatMap(e => e.ops);
  const input = { ...options, lane: draft.lane, module: draft.module, ...(ops.length ? { ops } : {}), also: code.map(writePart) };
  return { input, call: writeCall(input, { origins: true }), code, opsParts };
}
const setKeyOf = (draft, call) => sha(JSON.stringify({ lane: draft.lane, module: draft.module, ops: call.arguments?.job?.ops ?? null }));

// The part a problem of a composed check belongs to: also/<i> (the origin a check gives), /ops/<i> of the raw ops, the
// action it names; null when none says.
function partOfProblem(problem, { code, opsParts, call }) {
  const at = String(problem?.origin?.at ?? problem?.at ?? '');
  const also = /^\/?also\/(\d+)/.exec(at);
  if (also) return code[Number(also[1])]?.id ?? null;
  const pointer = /^\/ops\/(\d+)/.exec(String(problem?.pointer ?? ''));
  const opsCount = opsParts.reduce((n, e) => n + e.ops.length, 0);
  if (pointer && Number(pointer[1]) < opsCount) {
    let i = Number(pointer[1]);
    for (const e of opsParts) { if (i < e.ops.length) return e.id; i -= e.ops.length; }
  }
  if (pointer && call?.origins?.[Number(pointer[1])]) return partOfProblem({ origin: call.origins[Number(pointer[1])] }, { code, opsParts });
  const action = problem?.origin?.action ?? problem?.action;
  if (typeof action === 'string') {
    const name = action.toLowerCase();
    const hit = code.find(e => e.part === 'logic' && low(e.names).some(n => n === name || n.endsWith('.' + name)));
    if (hit) return hit.id;
  }
  return null;
}
const fixOf = (problem, refused) => problem.fix
  ?? (Array.isArray(problem.hints) && problem.hints.length ? problem.hints.map(h => `line ${h.line}: ${h.fix}`).join('; ') : null)
  ?? (refused?.continuation ? `correct the text and send the part again (the same name replaces it); ${refused.continuation.tool} ${JSON.stringify(refused.continuation.arguments)} has the syntax` : 'correct the part and send it again: the same name replaces it');

// ssam_code check of a set of parts: {ran, ok, key, result, problems?, skipped?}. A module without a local capture (or a
// producer without one) is not a problem of the parts: the check is skipped and the delivery validates them.
async function checkSet(draft, set, deps) {
  const composed = composeSet(draft, set);
  if (composed.call.refusal) {
    const r = composed.call.refusal;
    return { ran: true, ok: false, composed, problems: (r.problems?.length ? r.problems : [{ at: null, error: r.error }]).map(p => ({ code: 'INPUT_INVALID', ...p, fix: fixOf(p, r) })) };
  }
  const key = setKeyOf(draft, composed.call);
  if (!deps.check) return { ran: false, key, composed, skipped: { why: 'check is not served here: the delivery validates the parts' } };
  const start = nowOf(deps);
  let result;
  try { result = await deps.check({ ...composed.input, action: 'check' }); }
  catch (error) { return { ran: false, key, composed, skipped: { why: 'the check failed: ' + String(error?.message ?? error) } }; }
  const wallMs = nowOf(deps) - start;
  const problems = Array.isArray(result?.problems) ? result.problems : [];
  if (result?.ok === true) return { ran: true, ok: true, key, composed, wallMs, result };
  if (result?.code === 'CAPTURE_MISSING' || (problems.length && problems.every(p => p?.code === 'PRODUCER_NOT_CAPTURED')))
    return { ran: false, key, composed, skipped: { code: result.code, why: result.code === 'CAPTURE_MISSING' ? 'no local capture of the module: the delivery validates the parts' : 'a producer has no local capture: the delivery validates the parts', ...(result.continuation ? { continuation: result.continuation } : {}) } };
  return { ran: true, ok: false, key, composed, wallMs, result,
    problems: (problems.length ? problems : [{ code: result?.code ?? 'CHECK_REFUSED', message: result?.error ?? 'the check refused the parts' }]).map(p => ({ ...p, fix: fixOf(p) })) };
}
// What a draft keeps of a check (checks.json): enough to reuse it and to tell what it was. S9: the candidate the check built
// (code-check.mjs CHECK_CANDIDATE, a symbol key no answer carries), which the O11 write offers to the build of its delivery.
const CHECK_CANDIDATE = Symbol.for('ssam.check.candidate');
const keptOf = (check, at) => ({ at, ok: check.ok, wallMs: check.wallMs ?? null, jobSha256: check.result?.jobSha256 ?? null, job: check.result?.job ?? null,
  capture: check.result?.capture ? { path: check.result.capture.path, sha256: check.result.capture.sha256, model: check.result.capture.model ?? null } : null,
  ...(check.ok && plain(check.result?.[CHECK_CANDIDATE]) ? { candidate: check.result[CHECK_CANDIDATE] } : {}),
  ...(check.ok ? {} : { problems: check.problems }) });

// ---- the background check: 3 s after the last part, the set of the accepted parts
function scheduleBuild(draft, dir, deps) {
  if (!deps.check) return;
  clearTimeout(timers.get(draft.id));
  const timer = setTimeout(() => { timers.delete(draft.id); prebuild(draft.id, dir, deps).catch(() => {}); }, deps.idleMs ?? DRAFT_IDLE_MS);
  timer.unref?.();
  timers.set(draft.id, timer);
}
/** The background check of a draft's accepted parts, kept by the sha256 of its job; the same set is never checked twice. */
export async function prebuild(id, dir, deps = {}) {
  const draft = readJson(draftFile(dir, id));
  if (!draft || draft.state !== 'open') return null;
  const set = draft.parts.filter(p => p.status === 'accepted');
  if (!set.length) return null;
  const composed = composeSet(draft, set);
  if (composed.call.refusal) return null;
  const key = setKeyOf(draft, composed.call);
  const kept = readChecks(dir, id)[key];
  if (kept) return kept;
  const slot = id + ':' + key;
  if (!building.has(slot)) building.set(slot, (async () => {
    const check = await checkSet(draft, set, deps);
    if (!check.ran) return null;
    const value = keptOf(check, iso(nowOf(deps)));
    keepCheck(dir, id, key, { ...value, by: 'background' });
    return value;
  })().finally(() => building.delete(slot)));
  return building.get(slot);
}

// ---- the actions
async function openDraft(input, ctx, deps) {
  const lane = input.lane === 'o11' ? 'o11' : 'odc';
  const module = input.module ?? input.target;
  if (!module || typeof module !== 'string') return refusal('INPUT_INVALID', 'draft needs module (the module the parts change), or draft (the id) for its status', { continuation: openCall(lane) });
  const stray = CODE_FIELDS.filter(k => input[k] != null);
  if (stray.length) return refusal('INPUT_INVALID', `draft opens an empty draft: send ${stray.join(', ')} with action part`, { continuation: openCall(lane, module) });
  const now = nowOf(deps);
  const draft = { schema: DRAFT_SCHEMA, id: randomUUID(), owner: await ownerOf(ctx, deps), lane, module, state: 'open',
    createdAt: iso(now), touchedAt: iso(now), expiresAt: iso(now + DRAFT_TTL_MS), seq: 0, parts: [] };
  save(await draftsDir(lane, deps), draft);
  return { ok: true, tool: CODE_TOOL, action: 'draft', draft: { id: draft.id, expiresAt: draft.expiresAt }, lane, module,
    note: 'send each part as soon as it is written (one action, screen, block or data text): its problems come back at once; write {draft} delivers them all in one delivery',
    next: { part: partCall(lane, draft.id), status: statusCall(lane, draft.id), write: writeOf(lane, draft.id) } };
}

async function draftStatus(input, ctx, deps) {
  const loaded = await loadDraft(input, ctx, deps);
  if (loaded.refusal) return loaded.refusal;
  const { draft, dir } = loaded;
  const summary = summaryOf(draft);
  const set = draft.parts.filter(p => p.status === 'accepted');
  let prebuilt = null;
  if (set.length) {
    const composed = composeSet(draft, set);
    const key = composed.call.refusal ? null : setKeyOf(draft, composed.call);
    const kept = key ? readChecks(dir, draft.id)[key] : null;
    prebuilt = kept ? { at: kept.at, ok: kept.ok, jobSha256: kept.jobSha256 } : { pending: building.has(draft.id + ':' + key) || timers.has(draft.id) };
  }
  return { ok: true, tool: CODE_TOOL, action: 'draft', draft: draftRef(draft), parts: draft.parts.map(rowOf), summary,
    problems: draft.parts.flatMap(p => (p.problems ?? []).map(q => ({ part: p.id, ...q }))), prebuilt,
    ...(draft.delivery ? { delivery: draft.delivery } : {}),
    ...(summary.pending.length ? { continuation: { ...partCall(draft.lane, draft.id), why: 'correct the parts pending (the same name replaces a part; element alone drops it), then write' } }
      : { write: writeOf(draft.lane, draft.id) }) };
}

async function addPart(input, ctx, deps) {
  const loaded = await loadDraft(input, ctx, deps);
  if (loaded.refusal) return loaded.refusal;
  return inTurn(loaded.draft.id, async () => {
    const again = await loadDraft(input, ctx, deps);
    if (again.refusal) return again.refusal;
    const { draft, dir } = again;
    const lane = draft.lane;
    const now = nowOf(deps);
    const touch = () => { draft.touchedAt = iso(now); draft.expiresAt = iso(now + DRAFT_TTL_MS); };
    const { entries, problems: inputProblems, notes } = entriesOf(input);
    // element alone drops the part it names (by id or name).
    if (!entries.length && !inputProblems.length && input.element != null && input.part == null) {
      const name = String(input.element).toLowerCase();
      const dropped = draft.parts.filter(p => p.id === input.element || low(p.names).includes(name));
      if (!dropped.length) return refusal('DRAFT_PART_NOT_FOUND', `no part of draft ${draft.id} is ${input.element}`, { parts: draft.parts.map(rowOf), continuation: statusCall(lane, draft.id) });
      draft.parts = draft.parts.filter(p => !dropped.includes(p));
      touch(); save(dir, draft); scheduleBuild(draft, dir, deps);
      return { ok: true, tool: CODE_TOOL, action: 'part', draft: { id: draft.id, expiresAt: draft.expiresAt }, dropped: dropped.map(p => p.id), summary: summaryOf(draft),
        ...(summaryOf(draft).pending.length ? {} : { next: writeOf(lane, draft.id) }) };
    }
    if (!entries.length) return refusal('INPUT_INVALID', inputProblems.length ? inputProblems.map(p => p.at + ': ' + p.error).join(' | ') : 'part needs text, files, ops or edits (element alone drops a part)',
      { ...(inputProblems.length ? { problems: inputProblems } : {}), continuation: partCall(lane, draft.id) });
    // The parts of this call, each in place of the one it replaces (its position kept), else at the end.
    let parts = draft.parts.slice();
    const fresh = [];
    const replaced = [];
    for (const e of entries) {
      const { from, ...content } = e;
      const entry = { id: 'p' + (++draft.seq), ...content, names: [], status: 'pending', receivedAt: iso(now), from };
      entry.names = namesOfEntry(entry);
      const r = replacedBy(entry, parts);
      if (r.overlap) entry.problems = [{ code: 'DRAFT_PART_OVERLAP', at: from, error: `this data text holds ${low(r.overlap.names).filter(n => low(entry.names).includes(n)).join(', ')} of part ${r.overlap.id} but not ${low(r.overlap.names).filter(n => !low(entry.names).includes(n)).join(', ')}`,
        fix: `send the whole data text of part ${r.overlap.id} with the change (it replaces ${r.overlap.id}), or drop ${r.overlap.id} first (action part, element "${r.overlap.id}")` }];
      const at = r.replaced.length ? parts.indexOf(r.replaced[0]) : parts.length;
      parts = parts.filter(p => !r.replaced.includes(p));
      parts.splice(Math.min(at, parts.length), 0, entry);
      replaced.push(...r.replaced.map(p => p.id));
      fresh.push(entry);
    }
    // Each part alone, as a write of it would compose it.
    const normalizations = [...notes];
    for (const e of fresh) {
      if (e.problems) continue;
      const alone = writeCall(e.part === 'ops' ? { lane, module: draft.module, ops: e.ops } : { lane, module: draft.module, ...writePart(e) });
      if (alone.refusal) e.problems = (alone.refusal.problems?.length ? alone.refusal.problems : [{ at: e.from, error: alone.refusal.error }])
        .map(p => ({ code: 'INPUT_INVALID', ...p, at: p.at === 'text' ? e.from : p.at, fix: fixOf(p, alone.refusal) }));
      else if (alone.normalizations?.length) normalizations.push(...alone.normalizations.map(n => ({ ...n, part: e.id })));
    }
    // Then with the parts already accepted: one check of the set, so a part may use what another one creates.
    const candidates = fresh.filter(e => !e.problems);
    let checked = null;
    if (candidates.length) {
      const set = parts.filter(p => p.status === 'accepted' || candidates.includes(p));
      const check = await checkSet(draft, set, deps);
      checked = check.ran ? { ran: true, ok: check.ok, ...(check.wallMs != null ? { wallMs: check.wallMs } : {}) } : { ran: false, ...check.skipped };
      if (check.ran && check.ok) keepCheck(dir, draft.id, check.key, { ...keptOf(check, iso(nowOf(deps))), by: 'part' });
      if (check.ran && !check.ok) {
        const ids = new Set(candidates.map(e => e.id));
        for (const problem of check.problems) {
          const owner = partOfProblem(problem, { ...check.composed, call: check.composed.call });
          // A problem of a part accepted before shows only now: this call's parts brought it (each of them carries it).
          const targets = owner && ids.has(owner) ? candidates.filter(e => e.id === owner) : candidates;
          for (const e of targets) (e.problems ??= []).push({ ...problem, ...(owner && !ids.has(owner) ? { inPart: owner } : {}) });
        }
      }
    }
    for (const e of fresh) { e.status = e.problems?.length ? 'refused' : 'accepted'; e.problems ??= []; if (e.status === 'accepted' && checked?.ran) e.checkedAt = iso(nowOf(deps)); }
    draft.parts = parts;
    touch(); save(dir, draft);
    if (draft.parts.some(p => p.status === 'accepted')) scheduleBuild(draft, dir, deps);
    const accepted = fresh.every(e => e.status === 'accepted') && !inputProblems.length;
    const summary = summaryOf(draft);
    const problems = [...inputProblems, ...fresh.flatMap(e => e.problems.map(p => ({ part: e.id, ...p })))];
    return { ok: accepted, ...(accepted ? {} : { code: 'DRAFT_PART_REFUSED' }), tool: CODE_TOOL, action: 'part', accepted,
      // The problems once, each with its part (the rows name the parts only).
      draft: { id: draft.id, expiresAt: draft.expiresAt }, parts: fresh.map(p => ({ id: p.id, part: p.part, names: p.names, status: p.status })), ...(replaced.length ? { replaced } : {}),
      problems, ...(normalizations.length ? { normalizations } : {}), ...(checked ? { checked } : {}), summary,
      ...(accepted && !summary.pending.length ? { next: writeOf(lane, draft.id) }
        : { continuation: { ...partCall(lane, draft.id), why: 'correct the refused part and send it again: the same name replaces it; the other parts stay' } }) };
  });
}

async function writeDraft(input, ctx, deps) {
  const lane = input.lane === 'o11' ? 'o11' : 'odc';
  const stray = CODE_FIELDS.filter(k => input[k] != null);
  if (stray.length) return refusal('INPUT_INVALID', `write {draft} delivers the parts of the draft: send ${stray.join(', ')} with action part (a patch correction is a write without draft)`, { continuation: statusCall(lane, input.draft) });
  const loaded = await loadDraft(input, ctx, deps, { forWrite: true });
  if (loaded.refusal) return loaded.refusal;
  return inTurn(loaded.draft.id, async () => {
    const again = await loadDraft(input, ctx, deps, { forWrite: true });
    if (again.refusal) return again.refusal;
    const { draft, dir } = again;
    const pending = draft.parts.filter(p => p.status !== 'accepted');
    if (pending.length) return refusal('DRAFT_PARTS_PENDING', `${pending.length} part(s) of draft ${draft.id} are not accepted: ${pending.map(p => p.id + ' ' + p.names.join(', ')).join('; ')}`,
      { pending: pending.map(rowOf), continuation: { ...partCall(lane, draft.id), why: 'correct each pending part (the same name replaces it) or drop it (element alone), then write again' } });
    const { action: _a, draft: _d, lane: _l, module: _m, target: _t, ...options } = input;
    const composed = composeSet(draft, draft.parts, options);
    if (composed.call.refusal) return { ...composed.call.refusal, draft: draftRef(draft) };
    // The check of this very set: kept (by a part or the background), still running, or made now, once.
    const key = setKeyOf(draft, composed.call);
    let kept = readChecks(dir, draft.id)[key] ?? null;
    const reused = kept != null || building.has(draft.id + ':' + key);
    if (!kept && building.has(draft.id + ':' + key)) kept = await building.get(draft.id + ':' + key);
    if (!kept && deps.check) {
      const check = await checkSet(draft, draft.parts, deps);
      if (check.ran) { kept = { ...keptOf(check, iso(nowOf(deps))), by: 'write' }; keepCheck(dir, draft.id, key, kept); }
    }
    if (kept && kept.ok === false) {
      const problems = (kept.problems ?? []).map(p => ({ part: partOfProblem(p, { ...composed, call: composed.call }), ...p }));
      return refusal('DRAFT_CHECK_REFUSED', 'the parts of the draft do not pass the check together: nothing was delivered', { draft: draftRef(draft), problems,
        continuation: { ...partCall(lane, draft.id), why: 'correct the parts the problems name (the same name replaces a part), then write again' } });
    }
    clearTimeout(timers.get(draft.id)); timers.delete(draft.id);
    const startedAt = iso(nowOf(deps));
    draft.state = 'writing'; draft.delivery = { at: startedAt, tool: composed.call.tool }; save(dir, draft);
    // S9: on O11 the candidate of that check is offered to the build phase of the delivery (o11-build-phase.mjs), which uses
    // it instead of a new headless apply only when the delivery's capture has the model the check ran on.
    const offer = draft.lane === 'o11' && kept?.ok === true && plain(kept.candidate) ? { module: draft.module, candidate: kept.candidate, jobSha256: kept.jobSha256 ?? null } : null;
    const deliver = () => deps.deliver(composed.call.tool, composed.call.arguments, ctx);
    let result;
    try { result = offer ? await (deps.withCheckedCandidate ?? (await import('./o11-build-phase.mjs')).withCheckedCandidate)(offer, deliver) : await deliver(); }
    catch (error) {
      draft.state = 'uncertain'; draft.delivery = { ...draft.delivery, error: String(error?.message ?? error) }; save(dir, draft);
      return refusal('DRAFT_UNCERTAIN', 'the delivery of the draft failed with an unknown outcome: it is never written again; read the delivery task first', { draft: draftRef(draft), error: draft.delivery.error,
        continuation: { tool: 'ssam_task', arguments: {}, why: 'the recent deliveries and their outcome' } });
    }
    let value = result?.structuredContent;
    if (value == null && typeof result?.content?.[0]?.text === 'string') { try { value = JSON.parse(result.content[0].text); } catch { value = null; } }
    let answered = plain(value) ? codeAnswer(value, { lane }) : { ok: result?.isError ? false : true, result: value ?? null };
    if (composed.call.normalizations?.length) answered = { ...answered, normalizations: mergeNormalizations(answered.normalizations, composed.call.normalizations) };
    // delivered (also when its publication failed): closed; an unknown outcome: never written again; a refusal: open.
    const delivered = resultIs(value?.result, 'delivered', 'deliveredAndPublished');
    draft.state = delivered ? 'delivered' : value?.outcome === 'uncertain' ? 'uncertain' : 'open';
    draft.delivery = { at: startedAt, endedAt: iso(nowOf(deps)), tool: composed.call.tool, ok: value?.ok ?? null, ...(value?.result ? { result: value.result } : {}),
      ...(value?.code ? { code: value.code } : {}), ...(value?.taskId ? { taskId: value.taskId } : {}), ...(value?.nextBasedOn ? { nextBasedOn: value.nextBasedOn } : {}) };
    if (draft.state === 'open') { const now = nowOf(deps); draft.touchedAt = iso(now); draft.expiresAt = iso(now + DRAFT_TTL_MS); }
    save(dir, draft);
    return { ...answered, draft: { id: draft.id, state: draft.state, parts: draft.parts.length, checkedAt: kept?.at ?? null,
      prebuilt: kept ? { reused, by: kept.by ?? null, jobSha256: kept.jobSha256 ?? null,
        // whether the delivery's build used the checked candidate (no apply of its own), else why not
        ...(offer ? { candidate: offer.outcome ? { reused: offer.outcome.reused === true, ...(offer.outcome.reason ? { reason: offer.outcome.reason } : {}) }
          : { reused: false, reason: 'no-build-phase' } } : {}) } : null,
      ...(draft.state === 'open' ? { expiresAt: draft.expiresAt, note: 'the draft stays open: correct by parts (the same name replaces one) and write {draft} again, or correct with patch + basedOn {job, sha256} in a write without draft' } : {}) } };
  });
}

/**
 * The draft actions of ssam_code: draft {module} opens one, draft {draft} is its status, part {draft, ...} adds a part, write
 * {draft} delivers it. deps: {deliver(tool, args, ctx), check(input)?, dir?, now?, idleMs?, env?, root?}. Returns the answer value.
 */
export async function draftAction(input = {}, ctx = {}, deps = {}) {
  try {
    if (input.action === 'draft') return input.draft != null ? await draftStatus(input, ctx, deps) : await openDraft(input, ctx, deps);
    if (input.action === 'part') return await addPart(input, ctx, deps);
    if (input.action === 'write') return await writeDraft(input, ctx, deps);
    return refusal('INPUT_INVALID', 'a draft action is draft, part or write {draft}');
  } catch (error) { return refusal('DRAFT_FAILED', String(error?.message ?? error)); }
}
