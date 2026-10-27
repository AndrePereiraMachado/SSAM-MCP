// The module map: every element of a capture from its module index, read here without .NET.
// The index is written by the lane's resident reader (C#), one JSON per capture and reader adapter:
//   <SSAM_MODULE_INDEX_ROOT | <workspace>\.local\module-index>\v1\<lane>\<sha256>.<adapter>.json   (ssam-module-index/1)
// A file is served only when schema, extractor and sourceSha256 (the hash of the bytes read now) match; anything else
// is a miss, and the lane reader builds it again ({"index":"ensure"}). The store is a cache: its writer trims it.
//   ssam map [--lane o11|odc] <capture.oml|Module> [--kind K[,K...]] [--name N] [--prefix P] [--role R] [--parent @key]
//     [--key @key] [--offset N] [--max N] [--budget B] [--detail] [--expectedSourceSha256 H]
//   ssam map [--lane o11|odc] <capture.oml|Module> --digest [--page N] [--budget B] [--expectedSourceSha256 H]
//     the module digest of the same capture (view "digest", module-digest.mjs): the whole module as text, in pages
//   ssam map [--lane o11|odc] <capture.oml|Module> --ddl [--element E] [--page N] [--budget B] [--expectedSourceSha256 H]
//     the data text of the same capture (view "ddl", module-ddl.mjs): entities, structures, variables and timers as DDL,
//     every element with its @key, in pages; element reads one of them by name or @key
//   ssam map [--lane o11|odc] <capture.oml|Module> --flow [--element <@key|Flow/Screen/Action|Action>] [--page N] [--detail]
//     the flow reading of the same capture (view "flow", module-flow.mjs): one action as ssam-flow/1 text, whole, with
//     its fixed point; without --element the list of the actions
//   ssam map [--lane o11|odc] <capture|Module>... --search <text> [--regex] [--property P] [--kind K] [--role R] [--offset N] [--max N]
//   ssam map [--lane o11|odc] <capture|Module>... --uses <@key|Module.Element|Flow/Screen/Action|Kind:Name|Name> [--kind K]
//     views "search" and "uses" (module-rich.mjs): the rich index of each capture (one or several of an app), built only
//     on request ({"rich":"ensure"}) and read here; search finds text in expressions and values, uses finds who uses an
//     element inside and across the given modules
//   ssam map [--lane o11|odc] <capture.oml|Module> --html [--screen <Screen|Kind:Name|@key>] [--page N] [--keys] [--budget B]
//     view "html": one screen or block as ssam-html/1 (the kernel's ScreenHtml, written by the same reader as the digest):
//     its source as HTML, every element with k, expressions as text; its key table is stored beside the capture's index.
//     Without screen, the list of screens and blocks.
//   node module-map.mjs --prefetch <capture.oml> --lane o11|odc      (the detached warm-up, see prefetchIndex)
import { appendJsonLine } from './correlation.mjs';
import { withNormalizationsOf } from './normalizations.mjs';
import fs from 'node:fs';
import { budgetCeiling, maxAnswerBytes } from './context-budget.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workspaceRoot, anvilRoot, o11Lane } from './workspace.mjs';
import { readSnapshot } from './reader-client.mjs';
import { hotModuleRead } from './anvil-worker.mjs';
import { root as odcRoot, paths, odcStudioDir, ensureBuilder, builderNeedsBuild, studio } from './lib.mjs';
import { hostedContext, servedWithoutContext } from './executor.mjs';
import { LANES } from './lanes.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { resolveOpenModule, systemModuleName } from './studio-module.mjs';
import { withStudioWriteLock } from './studio-write-lock.mjs';
import { canonicalCapture } from './oml-content-sha.mjs';
import { DIGEST_ADAPTER, DIGEST_EXTRACTOR, DIGEST_PAGE_SCHEMA, DIGEST_SCHEMA, DIGEST_NOTE, loadDigest, digestPages, digestBody } from './module-digest.mjs';
import { DDL_ADAPTER, DDL_PAGE_SCHEMA, DDL_SCHEMA, DDL_NOTE, loadDdl, ddlPages, ddlBody, selectBlocks } from './module-ddl.mjs';
import { FLOW_ADAPTER, FLOW_SCHEMA, FLOW_PAGE_SCHEMA, FLOW_INDEX_SCHEMA, FLOW_NOTE, MAX_FLOW_ELEMENTS, loadFlow, findActions, similarActions, flowPages, FLOW_PAGE_MIN, textSha, flowReadingOf,
  FLOW_SELECTION_SCHEMA, validFlowSelection, selectionFlow } from './module-flow.mjs';
import { RICH_ADAPTER, RICH_SCHEMA, SEARCH_SCHEMA, USES_SCHEMA, SEARCH_NOTE, USES_NOTE, loadRich, searchRich, searchEntry, resolveElement, usesRich,
  usesEntry, describeRow } from './module-rich.mjs';
import { WIRED } from './text-routes.mjs';
import { INDEX_EXTRACTOR, STORE_GENERATION } from './store-generation.mjs';

export const INDEX_SCHEMA = 'ssam-module-index/1';
// ModuleIndex.Extractor of the kernel and the ODC builder (2: the event roles of the Traditional widgets); a stored index of
// another extractor is a miss, and its files are in another folder of the store (store-generation.mjs).
export const EXTRACTOR = INDEX_EXTRACTOR;
export { STORE_GENERATION };
export const MAP_SCHEMA = 'ssam-map/1';
export const ROLES = ['module', 'flow', 'screen', 'block', 'action', 'actionRef', 'aggregate', 'entity', 'staticEntity', 'structure',
  'attribute', 'parameter', 'variable', 'widget', 'event', 'flowNode', 'expression', 'reference', 'other'];
export const MAP_USAGE = 'ssam map [--lane o11|odc] <capture.oml|Module> [--kind K[,K...]] [--name N] [--prefix P] [--role R] [--parent @key] [--key @key] [--offset N] [--max N] [--budget B] [--detail] [--expectedSourceSha256 H] | ssam map [--lane o11|odc] <capture.oml|Module> --digest [--page N] [--budget B] [--expectedSourceSha256 H] | ssam map [--lane o11|odc] <capture.oml|Module> --ddl [--element E] [--page N] [--budget B] [--expectedSourceSha256 H] | ssam map [--lane o11|odc] <capture.oml|Module> --flow [--element <@key|Flow/Screen/Action|Action>]... [--page N] [--offset N] [--max N] [--detail] | ssam map [--lane o11|odc] <capture|Module>... --search <text> [--regex] [--property P] [--kind K] [--role R] [--offset N] [--max N] | ssam map [--lane o11|odc] <capture|Module>... --uses <element> [--kind K] [--role R] | ssam map [--lane o11|odc] <capture.oml|Module> --html [--screen <Screen>] [--page N] [--keys] [--budget B]';
export const VIEWS = ['map', 'digest', 'ddl', 'flow', 'search', 'uses', 'html', 'logic'];
// view "logic" is "flow" under the word of ssam_code (part logic): the same answer.
export const VIEW_ALIASES = { logic: 'flow' };
export const HTML_SCHEMA = 'ssam-html/1';
export const HTML_NOTE = 'ssam-html/1 (reading): the source of the screen or block, never its rendered state. k is the short key of each element in this '
  + 'reading (keysFile maps it to the ObjectKey, with this capture sha256 and htmlSha256); expressions are text: {{ expression }} lines and '
  + 'the values of if, list, bind, value and :Input; class is a plain string literal or {{ expression }}. <div else> right after a <div if> '
  + 'is its False branch. on<event>="Destination(Param = expression)" is a native event, @<Event> a block event handler, :<Input> a block '
  + 'argument; os-<Property> is any property outside the table, with the Model API name. os-opaque (tables, Traditional widgets) is '
  + 'untouchable. Screen actions are named in actions; their bodies are in the logic digest. To change the screen (C2): edits '
  + '[{set:k,attributes},{replace|delete|after|before|into|move:k},{find,with}] in html op {screen, basedOn, edits} '
  + '(continuations.edit); or edit: only the elements you changed, each whole with its k, new ones without k, removed ones left out. '
  + 'Everything else keeps its key; the answer brings the next basedOn.';
const RICH_VIEWS = ['search', 'uses'];
// The most captures one search or uses call reads (the modules of one app).
export const MAX_TARGETS = 16;
const DETAIL_ROLES = new Set(['expression', 'reference', 'other']);
const ANONYMOUS_KINDS = ['AnonymousStructure', 'ListType'];
// The reader's own refusal text (SnapshotReading.Read), which discovery and callers already recognize.
const CHANGED = 'Snapshot content changed: expectedSourceSha256 does not match the source bytes';
const NOT_OBSERVED = 'No instance of the requested kind was observed in this scope. Check the kind spelling and scope; this does not prove that the type is unsupported.';
const self = fileURLToPath(import.meta.url);

const adapterOf = lane => lane === 'odc' ? 'builder' : 'kernel';
export const sha256Of = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// The C# store takes only an absolute SSAM_MODULE_INDEX_ROOT and otherwise looks for the workspace above the reader's
// own folder (ModuleIndexStore.Default); readerConfig hands every reader this resolved root, so both sides use one folder.
export const indexRoot = (env = process.env) => env.SSAM_MODULE_INDEX_ROOT ? path.resolve(env.SSAM_MODULE_INDEX_ROOT) : path.join(workspaceRoot, '.local', 'module-index');
export const indexFile = (lane, sha256, env = process.env) => path.join(indexRoot(env), STORE_GENERATION, lane, sha256.toLowerCase() + '.' + adapterOf(lane) + '.json');
// The module digest beside the index (ModuleIndexStore.DigestPathOf), written in both lanes by the kernel's own reader.
// T12: the extractor is in the name (ModuleIndexStore.DigestSuffix), so two releases never overwrite each other's digest.
export const digestFile = (lane, sha256, env = process.env) => path.join(indexRoot(env), STORE_GENERATION, lane, sha256.toLowerCase() + '.' + DIGEST_ADAPTER + '.digest.e' + DIGEST_EXTRACTOR + '.json');
// The data text beside them (ModuleIndexStore.DdlPathOf), written in both lanes by the same kernel reader as the digest.
export const ddlFile = (lane, sha256, env = process.env) => path.join(indexRoot(env), STORE_GENERATION, lane, sha256.toLowerCase() + '.' + DDL_ADAPTER + '.ddl.json');
// The rich index beside them (ModuleIndexStore.RichPathOf), written by the same kernel reader as the digest, only on request.
// The flow reading beside them (ModuleIndexStore.FlowPathOf), written by the same kernel reader as the digest.
export const flowFile = (lane, sha256, env = process.env) => path.join(indexRoot(env), STORE_GENERATION, lane, sha256.toLowerCase() + '.' + FLOW_ADAPTER + '.flow.json');
// The read of one action an answer served, beside the flow reading (ModuleIndexStore.FlowReadingPathOf): the base of the
// three-way merge of an edit written on it (kernel FlowMerge).
export const flowReadingFile = (lane, sha256, sha, env = process.env) => path.join(indexRoot(env), STORE_GENERATION, lane, sha256.toLowerCase() + '.' + FLOW_ADAPTER + '.flow-' + sha + '.json');
// Every served action that is a fixed point keeps its read (written once: the file is named by its content); a store that
// cannot be written only loses the merge (the edit is then refused with the current text, as before).
function keepReadings(lane, sha256, served, actions) {
  const folder = path.dirname(served);
  for (const action of actions) {
    if (!action?.fixedPoint) continue;
    const reading = flowReadingOf(action, lane, sha256);
    const file = path.join(folder, sha256.toLowerCase() + '.' + FLOW_ADAPTER + '.flow-' + reading.textSha + '.json');
    try {
      if (fs.existsSync(file)) continue;
      // A selective reading (S10) writes no flow file: the folder may not exist yet.
      fs.mkdirSync(folder, { recursive: true });
      const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(reading));
      fs.renameSync(temporary, file);
    } catch { /* the merge is lost for this read, nothing else */ }
  }
}
export const richFile = (lane, sha256, env = process.env) => path.join(indexRoot(env), STORE_GENERATION, lane, sha256.toLowerCase() + '.' + RICH_ADAPTER + '.rich.json');
// C15: the registry of canonical captures by content (oml-content-sha.mjs canonicalCapture), beside the index store.
// servidor/fase4-26 a8: hosted, the registry is the customer's (<ws>/state/content-registry/<lane>): the module index is
// shared by every customer and addressed by hashes, but this registry names FILES, so a shared one answered a customer's
// read with another customer's capture of the same content (its path in the answer, and whether someone else holds that
// module). Each customer's first capture of a content is its own canonical one.
export const contentRegistry = (lane, env = process.env) => {
  const context = hostedContext();
  return context ? path.join(context.workspace, 'state', 'content-registry', lane) : path.join(indexRoot(env), STORE_GENERATION, lane, 'content');
};
// The capture that answers a read of `file`: the first intact capture of the same content (its index and its sha), or the
// file itself. A registry that cannot be read or written only loses the reuse.
export function readCapture(file, lane, { module = null, env = process.env } = {}) {
  try { return canonicalCapture({ file, module, dir: contentRegistry(lane, env) }); }
  catch { const raw = sha256Of(file); return { file: path.resolve(file), rawSha256: raw, contentSha256: raw, reused: false, rule: 'raw' }; }
}

// The resident reader of each lane (reader-client.mjs): the ODC builder, or the O11 kernel CLI of the selected lane.
export function readerConfig(lane, { entry = LANES.o11, ssDir, env = process.env } = {}) {
  if (lane === 'odc') return { dll: paths.builder, platform: 'odc', runtimeDir: odcStudioDir(env),
    cacheRoot: env.SSAM_READER_CACHE_ROOT ?? path.join(odcRoot, '.local', 'readers'), indexRoot: indexRoot(env) };
  if (lane === 'o11') return { dll: entry.cli, platform: entry.lane,
    runtimeDir: ssDir ?? env.ANVIL_STUDIO_DIR ?? path.join(env.USERPROFILE, 'OutSystems',
      entry.lane === 'ss5' ? 'Service Studio 11 - Anvil 4536' : 'Service Studio 11 - Anvil 4516', 'Service Studio'),
    cacheRoot: env.SSAM_READER_CACHE_ROOT ?? path.join(entry.root, '.local', 'readers'), indexRoot: indexRoot(env) };
  throw new Error('Unknown lane ' + lane + '; lanes: odc, o11');
}
// The reader that writes the module digest: on O11 the lane reader itself; on ODC the kernel's reader (anvil-odc
// read-serve), never the builder, whose public Model API shows widgets as Content trees the digest does not render.
export const odcKernelCli = () => path.join(anvilRoot, '.local', 'lane-odc', 'cli', 'anvil-odc.dll');
export function digestReaderConfig(lane, { entry, ssDir, env = process.env } = {}) {
  if (lane === 'odc') return { dll: odcKernelCli(), platform: 'odc', runtimeDir: odcStudioDir(env),
    cacheRoot: env.SSAM_READER_CACHE_ROOT ?? path.join(odcRoot, '.local', 'readers'), indexRoot: indexRoot(env) };
  return readerConfig(lane, { ...(entry ? { entry } : {}), ssDir, env });
}

// ---- the store
// The checks of ModuleIndex.Parse: identity, roles, and every row and ancestor in range and in ordinal key order.
// A parent reference is a row (>= 0), no parent (-1) or ancestors[-2 - ref] (<= -2): an element Parent() reaches that
// no Children list holds (O11 an aggregate's DataTable, ODC CustomProperty); it names paths and is never listed.
function wellFormed(index, lane) {
  if (!index || index.schema !== INDEX_SCHEMA || index.extractor !== EXTRACTOR || index.lane !== lane || index.adapter !== adapterOf(lane)
    || typeof index.sourceSha256 !== 'string' || typeof index.complete !== 'boolean' || typeof index.module?.name !== 'string'
    || !Array.isArray(index.rows) || !Array.isArray(index.types) || !Array.isArray(index.ancestors)
    || !Array.isArray(index.roles) || index.roles.length !== ROLES.length || index.roles.some((r, i) => r !== ROLES[i])) return false;
  const rows = index.rows.length, types = index.types.length;
  const reference = p => Number.isInteger(p) && p >= -1 - index.ancestors.length && p < rows;
  const type = t => Number.isInteger(t) && t >= 0 && t < types;
  return index.types.every(t => t && typeof t.kind === 'string' && Array.isArray(t.answers))
    && index.ancestors.every(a => Array.isArray(a) && a.length === 4 && typeof a[0] === 'string' && type(a[1]) && typeof a[2] === 'string' && reference(a[3]))
    && index.rows.every((r, i) => Array.isArray(r) && r.length === 9 && typeof r[0] === 'string' && type(r[1]) && typeof r[2] === 'string'
      && reference(r[5]) && Number.isInteger(r[6]) && r[6] >= 0 && r[6] < ROLES.length && Number.isInteger(r[8]) && r[8] >= 0
      && (i === 0 || index.rows[i - 1][0] <= r[0]));
}
// A parent reference's own parent reference, type and name (rows and ancestors alike).
const parentOf = (index, ref) => ref >= 0 ? index.rows[ref][5] : index.ancestors[-2 - ref][3];
const typeOf = (index, ref) => ref >= 0 ? index.rows[ref][1] : index.ancestors[-2 - ref][1];
const nameOf = (index, ref) => ref >= 0 ? index.rows[ref][2] : index.ancestors[-2 - ref][2];
// The last two parsed indexes (a large module is 20-40 MB of heap); the file is content-addressed, the stamp only
// tells a rewritten file from the one already parsed.
const parsed = new Map();
export function loadIndex(file, lane, sha256) {
  let stat; try { stat = fs.statSync(file); } catch { return null; }
  const stamp = stat.size + ':' + stat.mtimeMs + ':' + stat.ino;
  let index = parsed.get(file)?.stamp === stamp ? parsed.get(file).index : null;
  if (!index) {
    try { index = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
    if (!wellFormed(index, lane)) return null;
    parsed.delete(file); parsed.set(file, { stamp, index });
    while (parsed.size > 2) parsed.delete(parsed.keys().next().value);
  }
  return index.sourceSha256.toLowerCase() === sha256.toLowerCase() ? index : null;
}
// Derived tables, once per parsed index: keys of rows, keys of ancestors (as parent references) and, per reference,
// whether it lies inside an anonymous structure or a list type (the types the model creates on its own), itself included.
const derived = new WeakMap();
function tables(index) {
  let t = derived.get(index);
  if (!t) {
    const keys = new Map(index.rows.map((r, i) => [r[0], i]));
    const ancestorKeys = new Map(index.ancestors.map((a, i) => [a[0], -2 - i]));
    const anonymousType = index.types.map(type => ANONYMOUS_KINDS.some(k => answers(type, k)));
    const rowsInside = new Uint8Array(index.rows.length), ancestorsInside = new Uint8Array(index.ancestors.length); // 0 unknown, 1 inside, 2 outside
    const memo = ref => ref >= 0 ? rowsInside : ancestorsInside, slot = ref => ref >= 0 ? ref : -2 - ref;
    const limit = index.rows.length + index.ancestors.length;
    const inside = ref => {
      if (ref === -1) return 2;
      if (memo(ref)[slot(ref)]) return memo(ref)[slot(ref)];
      const chain = []; let at = ref, state = 2;
      while (at !== -1 && chain.length <= limit) {
        if (memo(at)[slot(at)]) { state = memo(at)[slot(at)]; break; }
        chain.push(at);
        if (anonymousType[typeOf(index, at)]) { state = 1; break; }
        at = parentOf(index, at);
      }
      for (const j of chain) memo(j)[slot(j)] = state;
      return state;
    };
    for (let i = 0; i < index.rows.length; i++) inside(i);
    // G11: the row each ancestor hangs from (the nearest row up its parent references, -1 for none). An entry's parentKey is
    // that row, the one ModelReader's Children list shows the entry under, never the ancestor between.
    const owners = new Int32Array(index.ancestors.length);
    for (let i = 0; i < owners.length; i++) {
      let at = index.ancestors[i][3];
      for (let hops = 0; at <= -2 && hops <= owners.length; hops++) at = index.ancestors[-2 - at][3];
      owners[i] = at <= -2 ? -1 : at;
    }
    const ownerOf = ref => ref <= -2 ? owners[-2 - ref] : ref;
    derived.set(index, t = { keys, ancestorKeys, inside, ownerOf });
  }
  return t;
}
// HasKind of the readers (ModuleIndex.Query): a name in the node's answers, with or without the leading I.
const answers = (type, kind) => (type.answers ?? []).some(a => a === kind || a === 'I' + kind);
// U6 (FarmaVirtual 10/10/2026, call 148): the map's kind is one kind or a list, "A|B" or "A,B".
const kindList = kind => String(kind).split(/[|,]/).map(k => k.trim()).filter(Boolean);
// OrdinalIgnoreCase of the readers, per UTF-16 unit.
const folded = text => { let out = ''; for (const ch of String(text)) { const up = ch.toUpperCase(); out += up.length === ch.length ? up : ch; } return out; };
const clip = text => text.length > 80 ? text.slice(0, 80) + '…' : text;

// ---- the request
const integer = (name, value, min, max, fallback) => {
  if (value == null) return fallback;
  const n = typeof value === 'number' ? value : /^-?\d+$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(name + ' must be an integer between ' + min + ' and ' + max);
  return n;
};
// The default byte budget is the MCP answer ceiling of ssam.mjs (SSAM_MAX_ANSWER_BYTES from context-budget.mjs) less the room its shaper
// keeps for next steps (2048 bytes, ssam.mjs budgetCeiling): a map never answers more than a client takes in one piece,
// and the ceiling never has to page it.
export const DEFAULT_MAP_BUDGET = (env = process.env) => Math.min(1048576, budgetCeiling(maxAnswerBytes(env)));
function mapRequest(input) {
  const lane = input.lane ?? 'odc';
  if (!['odc', 'o11'].includes(lane)) throw new Error('Unknown lane ' + lane + '; lanes: odc, o11');
  const view = VIEW_ALIASES[input.view] ?? input.view ?? 'map';
  if (!VIEWS.includes(view)) throw new Error('view must be one of: ' + VIEWS.join(', ') + ' (map: the elements with their @keys; digest: the whole module as text, in pages; ddl: the module data as DDL with @keys, in pages; flow: one action as text, whole; search: text in expressions and values; uses: who uses an element; html: one screen or block as ssam-html/1)');
  const rich = RICH_VIEWS.includes(view);
  const targets = Array.isArray(input.target) ? input.target : [input.target];
  if (Array.isArray(input.target) && !rich) throw new Error('a list of targets belongs to views "search" and "uses"; view "' + view + '" reads one capture or module');
  if (!targets.length || targets.length > MAX_TARGETS || targets.some(t => typeof t !== 'string' || !t.trim()))
    throw new Error('target is required: a capture .oml or an open module name' + (rich ? ', or a list of 1 to ' + MAX_TARGETS + ' of them (the modules of one app)' : '') + '. ' + MAP_USAGE);
  for (const name of ['kind', 'name', 'prefix', 'role', 'parent', 'key', 'text', 'property', 'element'])
    if (input[name] != null && (typeof input[name] !== 'string' || !input[name]) && !(name === 'element' && view === 'flow' && Array.isArray(input[name])))
      throw new Error(name + ' must be a non-empty string');
  const hashes = input.expectedSourceSha256 == null ? [] : Array.isArray(input.expectedSourceSha256) ? input.expectedSourceSha256 : [input.expectedSourceSha256];
  if (hashes.some(h => typeof h !== 'string' || !/^[a-fA-F0-9]{64}$/.test(h))) throw new Error('expectedSourceSha256 must be 64 hexadecimal characters' + (rich ? ' (or a list of them, one per target)' : ''));
  if (Array.isArray(input.expectedSourceSha256) && (!Array.isArray(input.target) || hashes.length !== targets.length))
    throw new Error('expectedSourceSha256 as a list needs a list target with one hash per target (' + targets.length + ')');
  const offset = integer('offset', input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const richOnly = ['text', 'property', ...(view === 'ddl' || view === 'flow' ? [] : ['element'])].filter(k => input[k] != null);
  // A list of elements is one answer of whole actions (view flow); every other view reads one element.
  if (Array.isArray(input.element) && view !== 'flow') throw new Error('element as a list belongs to view "flow" (several actions read whole in one answer); view "' + view + '" takes one element');
  if (input.regex === true) richOnly.push('regex');
  if (!rich && richOnly.length) throw new Error(richOnly.join(', ') + ' belong to views "search" (text, regex, property) and "uses" (element)');
  if (view === 'flow') {
    // One action by element (its text, in pages when it is larger than the budget), else the list of the actions.
    const mapOnly = ['kind', 'name', 'prefix', 'role', 'parent', 'key'].filter(k => input[k] != null);
    if (mapOnly.length) throw new Error('view "flow" reads one action by element (@key, Flow/Screen/Action or the action name) or lists the actions; '
      + mapOnly.join(', ') + ' belong to view "map"');
    if (input.page != null && input.element == null) throw new Error('page belongs to an action of view "flow" (element); the list pages with offset and max');
    // A list of elements reads several actions whole in one answer (the ones a job will edit together).
    if (Array.isArray(input.element)) {
      if (input.element.length === 0 || input.element.length > MAX_FLOW_ELEMENTS || !input.element.every(e => typeof e === 'string' && e.trim().length))
        throw new Error('element is one action, or a list of 1 to ' + MAX_FLOW_ELEMENTS + ' actions (@key, Flow/Screen/Action or the action name)');
      if (input.page != null) throw new Error('page belongs to one element; a list of elements answers whole actions (the ones that do not fit come in continuations.next)');
    }
    return { lane, target: input.target, view, element: input.element, page: integer('page', input.page, 1, 100000, 1), offset, max: integer('max', input.max, 1, 500, 100),
      budgetBytes: integer('budgetBytes', input.budgetBytes, 2000, 1048576, DEFAULT_MAP_BUDGET()), includeDetail: input.includeDetail === true,
      expectedSourceSha256: input.expectedSourceSha256?.toLowerCase(), pid: input.pid };
  }
  if (rich) {
    // The rich views filter by kind and role and page with offset and max; the map's own filters would read as a scope
    // they do not have.
    const mapOnly = ['name', 'prefix', 'parent', 'key'].filter(k => input[k] != null);
    if (input.includeDetail === true) mapOnly.push('includeDetail');
    if (input.page != null) mapOnly.push('page');
    if (view === 'search' && input.element != null) mapOnly.push('element');
    if (view === 'uses') { for (const k of ['text', 'property']) if (input[k] != null) mapOnly.push(k); if (input.regex === true) mapOnly.push('regex'); }
    if (mapOnly.length) throw new Error('view "' + view + '" takes ' + (view === 'search' ? 'text (regex, property)' : 'element') + ', kind, role, offset and max; '
      + mapOnly.join(', ') + ' belong to ' + (mapOnly.some(k => ['text', 'property', 'regex'].includes(k)) ? 'view "search"' : mapOnly.includes('element') ? 'view "uses"' : mapOnly.includes('page') ? 'view "digest"' : 'view "map"'));
    // module-rich.mjs matches one kind: a list there would answer nothing, so it is refused with the view that takes it;
    // one kind with a stray separator ("MobileScreen|") is that kind, and no kind at all ("|") is refused.
    const kinds = input.kind != null ? kindList(input.kind) : null;
    if (kinds && !kinds.length) throw new Error('kind must name a kind');
    if (kinds?.length > 1) throw new Error('view "' + view + '" matches one kind; a list of kinds (A|B or A,B) belongs to view "map"');
    if (view === 'search' && input.text == null) throw new Error('view "search" needs text: the text to find in expressions, values, arguments and names (substring, case-insensitive; regex:true for a regular expression)');
    if (view === 'search' && input.text.length > 500) throw new Error('text must have at most 500 characters');
    if (view === 'uses' && input.element == null) throw new Error('view "uses" needs element: @key, Module.Element (producer.element), a name path such as MainFlow/Home/Search, Kind:Name or a name');
    if (input.role != null && !ROLES.includes(input.role)) throw new Error('Unknown role ' + input.role + '; roles: ' + ROLES.join(', '));
    return { lane, target: Array.isArray(input.target) ? targets : targets[0], view, kind: kinds?.[0], role: input.role, text: input.text, regex: input.regex === true,
      property: input.property, element: input.element, offset, max: integer('max', input.max, 1, 500, 100),
      budgetBytes: integer('budgetBytes', input.budgetBytes, 2000, 1048576, DEFAULT_MAP_BUDGET()),
      expectedSourceSha256: Array.isArray(input.expectedSourceSha256) ? hashes.map(h => h.toLowerCase()) : hashes[0]?.toLowerCase(), pid: input.pid };
  }
  if (view !== 'html' && (input.screen != null || input.keys === true)) throw new Error('screen and keys belong to view "html" (one screen or block as ssam-html/1)');
  if (view === 'html') {
    // One screen or block: the map's filters and paging would read as a filtered page, which it is not.
    const mapOnly = ['kind', 'name', 'prefix', 'role', 'parent', 'key'].filter(k => input[k] != null);
    if (input.includeDetail === true) mapOnly.push('includeDetail');
    if (offset > 0) mapOnly.push('offset');
    if (mapOnly.length) throw new Error('view "html" reads one screen or block (screen) in pages (page); ' + mapOnly.join(', ') + ' belong to view "map"');
    if (input.screen != null && (typeof input.screen !== 'string' || !input.screen.trim())) throw new Error('screen must be a non-empty string: a screen or block name, Kind:Name or @key');
    if (input.page != null && input.screen == null) throw new Error('page needs screen: the pages are those of one screen or block');
    return { lane, target: input.target, view, screen: input.screen?.trim() ?? null, page: integer('page', input.page, 1, 100000, 1),
      includeKeys: input.keys === true, budgetBytes: integer('budgetBytes', input.budgetBytes, 2000, 1048576, DEFAULT_MAP_BUDGET()),
      expectedSourceSha256: input.expectedSourceSha256?.toLowerCase(), pid: input.pid };
  }
  if (view === 'ddl') {
    // The data text pages whole blocks; element reads one of them. The map's filters would read as a filter it does not have.
    const mapOnly = ['kind', 'name', 'prefix', 'role', 'parent', 'key'].filter(k => input[k] != null);
    if (input.includeDetail === true) mapOnly.push('includeDetail');
    if (offset > 0) mapOnly.push('offset');
    if (mapOnly.length) throw new Error('view "ddl" pages the data text by whole blocks; ' + mapOnly.join(', ') + ' belong to view "map". Use element (a name or @key) for one entity, structure, variable or timer, and page to move through the text.');
    return { lane, target: input.target, view, page: integer('page', input.page, 1, 100000, 1), element: input.element,
      budgetBytes: integer('budgetBytes', input.budgetBytes, 2000, 1048576, DEFAULT_MAP_BUDGET()),
      expectedSourceSha256: input.expectedSourceSha256?.toLowerCase(), pid: input.pid };
  }
  if (view === 'digest') {
    // The digest pages the whole module: the map's filters and paging would read as a filtered digest, which it is not.
    const mapOnly = ['kind', 'name', 'prefix', 'role', 'parent', 'key'].filter(k => input[k] != null);
    if (input.includeDetail === true) mapOnly.push('includeDetail');
    if (offset > 0) mapOnly.push('offset');
    if (mapOnly.length) throw new Error('view "digest" pages the whole module digest; ' + mapOnly.join(', ') + ' belong to view "map". Use page to move through the digest.');
  } else if (input.page != null) throw new Error('page belongs to view "digest" (the module digest in pages) or view "ddl" (the data text in pages); the map pages with offset and max');
  if (view === 'map' && input.kind != null && !kindList(input.kind).length) throw new Error('kind must name a kind, or a list of them (A|B or A,B)');
  return { lane, target: input.target, view, page: view === 'digest' ? integer('page', input.page, 1, 100000, 1) : undefined,
    kind: input.kind, name: input.name, prefix: input.prefix, role: input.role, parent: input.parent, key: input.key,
    offset, max: integer('max', input.max, 1, 500, 100),
    budgetBytes: integer('budgetBytes', input.budgetBytes, 2000, 1048576, DEFAULT_MAP_BUDGET()), includeDetail: input.includeDetail === true,
    expectedSourceSha256: input.expectedSourceSha256?.toLowerCase(), pid: input.pid };
}
export function parseMapArguments(args) {
  const input = {};
  const values = { '--lane': 'lane', '--kind': 'kind', '--name': 'name', '--prefix': 'prefix', '--role': 'role', '--parent': 'parent', '--key': 'key',
    '--offset': 'offset', '--max': 'max', '--budget': 'budgetBytes', '--expectedSourceSha256': 'expectedSourceSha256', '--oml': 'target', '--pid': 'pid',
    '--page': 'page', '--view': 'view', '--text': 'text', '--property': 'property', '--element': 'element', '--screen': 'screen' };
  // --digest, --ddl, --flow, --html, --search <text> and --uses <element> name their view; a second view word disagrees.
  const views = { '--digest': ['digest'], '--ddl': ['ddl'], '--flow': ['flow'], '--search': ['search', 'text'], '--uses': ['uses', 'element'], '--html': ['html'] };
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--detail') { input.includeDetail = true; continue; }
    if (arg === '--regex') { input.regex = true; continue; }
    if (arg === '--keys') { input.keys = true; continue; }
    if (views[arg]) {
      const [view, field] = views[arg];
      if (input.view != null && input.view !== view) throw new Error(arg + ' and --view ' + input.view + ' disagree');
      input.view = view;
      if (field) {
        const value = args[++i];
        if (value == null || value.startsWith('--')) throw new Error('Missing value for ' + arg);
        input[field] = value;
      }
      continue;
    }
    if (values[arg] === 'view' && args[i + 1] != null && input.view != null && input.view !== args[i + 1]) throw new Error('--' + input.view + ' and --view ' + args[i + 1] + ' disagree');
    if (values[arg]) {
      const value = args[++i];
      if (value == null || value.startsWith('--')) throw new Error('Missing value for ' + arg);
      if (values[arg] === 'target') { targets.push(value); continue; }
      // --flow reads several actions with --element repeated (checked once the view is known, below).
      if (values[arg] === 'element' && 'element' in input) { input.element = [].concat(input.element, value); continue; }
      if (values[arg] in input && !(values[arg] === 'view' && input.view === value)) throw new Error('Duplicate ' + arg);
      input[values[arg]] = value; continue;
    }
    if (arg.startsWith('--')) throw new Error('Unknown map argument ' + arg + '; ' + MAP_USAGE);
    targets.push(arg);
  }
  if (!targets.length) throw new Error(MAP_USAGE);
  if (Array.isArray(input.element) && input.view !== 'flow') throw new Error('Duplicate --element (a list of elements belongs to --flow)');
  // Several targets only for search and uses (one app's modules); the other views refuse a list with their own words.
  if (targets.length > 1 && !RICH_VIEWS.includes(input.view)) throw new Error('map takes one target; ' + MAP_USAGE);
  input.target = targets.length > 1 ? targets : targets[0];
  if (input.pid != null) input.pid = integer('--pid', input.pid, 1, Number.MAX_SAFE_INTEGER);
  return input;
}

// ---- the answer
// One call answers from the store; a miss asks the lane reader to build the index ({"index":"ensure"}) and reads the
// file it wrote. deps replace the reader transport, the builder check and the Studio snapshot (tests).
// The capture of q.target (captureTarget below): {file, sha256, canonical, captured, snapshot}, or {refused} with the
// snapshot's own refusal.
async function captureOf(q, deps) {
  const { capture = studio, env = process.env } = deps;
  const target = await captureTarget(q.target, q, { deps, capture, env });
  return target.ok ? target : { refused: target.refusal };
}
// expectedSourceSha256: the raw sha256 of the capture served, of the capture just taken, or their content sha256.
const expectedHolds = (q, { sha256, canonical, captured }) =>
  !q.expectedSourceSha256 || [sha256, canonical.contentSha256, ...(canonical.reused ? [sha256Of(captured)] : [])].includes(q.expectedSourceSha256);

// A budget below the smallest page of the data text or of the module digest has one meaning (owner session 2026-10-12: a
// read refused "use at least 13353" and was sent again): the page is read at that smallest budget, listed in normalizations.
const MINIMUM_PAGE = /budgetBytes (\d+) leaves no room for a page of the [\w ]+?; use at least (\d+)/;
async function atLeastAPage(answer, q) {
  try { return await answer(q); } catch (error) {
    const m = MINIMUM_PAGE.exec(String(error?.message ?? ''));
    const need = m ? Number(m[2]) : NaN;
    if (!m || !(need > q.budgetBytes) || need > 1048576) throw error;
    const value = await answer({ ...q, budgetBytes: need });
    return withNormalizationsOf(value, [{ rule: 'budget-minimum', at: '/budgetBytes', note: `budgetBytes ${q.budgetBytes} leaves no room for a page; read at ${need}, the smallest page` }]);
  }
}

// The code of an error the map caught (goal list of 2026-10-20, item 2: 184 SSAM_MAP_FAILED, the generic <tool>_FAILED of
// refusal-codes.mjs toolCode, for errors the map already knew). A refusal the error carries (error.refusal) wins; the
// kernel's "No screen or block named 'X'. Kind:Name @key; ..." (ScreenHtmlModule) is ELEMENT_NOT_FOUND with the candidates
// it lists and the call that lists every screen; an argument the request refused (mapRequest threw, q is undefined) is
// INPUT_INVALID; a reader that is not built or predates a schema is READER_UNAVAILABLE. Anything else keeps no code.
const NOT_NAMED = /^No screen or block named '([^']*)'\. ?(.*)$/s;
const AMBIGUOUS_NAMED = /^Ambiguous screen or block '([^']*)'\. ?(.*)$/s;
const candidatesOf = text => text.split(';').map(s => s.trim()).filter(Boolean).map(s => {
  const m = /^(\w+):(\S+) @(\S+)$/.exec(s);
  return m ? { kind: m[1], name: m[2], key: '@' + m[3] } : { text: s };
});
// R4 (2026-10-24: 61 ELEMENT_NOT_FOUND and 16 BUDGET_TOO_SMALL of ssam_map after 20/10, each a round of the agent): a
// miss answers its nearest names, at most NEAR_MAX, by kind (the same kind first), prefix, containment and edit distance,
// and the corrected call when one of them dominates (the same name but for case or separators, the only one that contains
// or begins it, or an edit distance clearly below the next).
export const NEAR_MAX = 5;
const squash = s => String(s ?? '').toLowerCase().replace(/^@/, '').replace(/^.*[/.:]/, '').replace(/[^a-z0-9]/g, '');
// The optimal string alignment distance: insertions, deletions, substitutions and adjacent transpositions ("Ordres").
export function editDistance(a, b) {
  if (a === b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
// items: [{name, kind?, ...}]; returns {candidates: the nearest at most max, dominant: the one item that dominates or null}.
export function nearest(wanted, items, { kind = null, max = NEAR_MAX } = {}) {
  const w = squash(wanted);
  if (!w) return { candidates: [], dominant: null };
  const scored = items.map((item, order) => {
    const n = squash(item.name);
    const distance = editDistance(w, n);
    const rank = n === w ? 0 : n.startsWith(w) || w.startsWith(n) ? 1 : n.includes(w) || w.includes(n) ? 2 : 3;
    return { item, order, rank, distance, same: kind != null && item.kind === kind ? 0 : 1 };
  }).filter(x => x.rank < 3 || x.distance <= Math.max(2, Math.floor(w.length / 2)));
  scored.sort((a, b) => a.rank - b.rank || a.same - b.same || a.distance - b.distance || a.order - b.order);
  const top = scored.slice(0, max);
  const [first, second] = top;
  const dominant = !first ? null : first.rank === 0 && (!second || second.rank > 0) ? first.item
    : first.rank <= 2 && (!second || second.rank > first.rank) ? first.item
      : first.rank === 3 && first.distance <= Math.max(1, Math.floor(w.length / 4)) && (!second || second.distance >= first.distance + 2) ? first.item : null;
  return { candidates: top.map(x => x.item), dominant };
}

export function mapRefusal(error, q, input = {}) {
  const message = (typeof error?.message === 'string' && error.message) || String(error ?? 'unknown error');
  if (error?.refusal) return { ...error.refusal, error: message };
  const lane = q?.lane ?? input.lane ?? 'odc';
  const pin = q?.view === 'html' && q.target ? { tool: 'ssam_map', arguments: { lane, target: q.target, view: 'html', ...(q.expectedSourceSha256 ? { expectedSourceSha256: q.expectedSourceSha256 } : {}) } } : null;
  let m;
  if ((m = NOT_NAMED.exec(message))) {
    const listed = candidatesOf(m[2]);
    const { candidates: near, dominant } = nearest(m[1], listed.filter(c => c.name));
    const candidates = [...near, ...listed.filter(c => !near.includes(c))].slice(0, NEAR_MAX);
    return { code: 'ELEMENT_NOT_FOUND', view: 'html', screen: m[1], candidates, ...(listed.length > candidates.length ? { candidatesOmitted: listed.length - candidates.length } : {}),
      ...(pin ? { continuation: { ...pin, why: 'the list of every screen and block of this capture; screen takes a name, Kind:Name or @key from it' } } : {}),
      ...(pin && dominant ? { corrected: { ...pin, arguments: { ...pin.arguments, screen: dominant.name }, why: dominant.name + ' is the one screen or block near "' + m[1] + '"' } } : {}), error: message };
  }
  if ((m = AMBIGUOUS_NAMED.exec(message))) return { code: 'AMBIGUOUS_ELEMENT', view: 'html', screen: m[1], candidates: candidatesOf(m[2]),
    ...(pin ? { continuation: { ...pin, arguments: { ...pin.arguments, screen: '<Kind:Name or @key of one candidate>' }, why: 'the same read for one of the candidates' } } : {}), error: message };
  if (message.startsWith(CHANGED)) return { code: 'CAPTURE_CHANGED', error: message };
  // A page past the end names the last page and the same read at it.
  if ((m = /^page \d+ does not exist\b.* has (\d+) page\(s\)/.exec(message))) {
    const pages = Number(m[1]);
    const { lane: _lane, ...asked } = input;
    return { code: 'PAGE_NOT_FOUND', pages, ...(pages > 0 ? { corrected: { tool: 'ssam_map', arguments: { lane, ...asked, page: pages }, why: 'the last page (' + pages + ') of the same read' } } : {}), error: message };
  }
  if (/^page \d+ does not exist\b/.test(message)) return { code: 'PAGE_NOT_FOUND', error: message };
  if (!q) return { code: 'INPUT_INVALID', error: message };
  if (/\bkernel reader that writes .* is not built\b|\bits binaries predate\b|\bmissing or invalid after the reader built it\b/.test(message)) return { code: 'READER_UNAVAILABLE', error: message };
  return { error: message };
}

// The module kind (the module type of its digest: WebResponsive, Reactive...) of a module of this lane by name, from the
// digests the store already holds (the newest first, at most ten read), never a capture or a reader: null when none is
// stored. ssam_app_url reads it to write the .aspx of an O11 Traditional Web screen without digesting the module.
export function storedModuleKind(lane, name, env = process.env) {
  if (typeof name !== 'string' || !name) return null;
  const dir = path.join(indexRoot(env), STORE_GENERATION, lane);
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.' + DIGEST_ADAPTER + '.digest.e' + DIGEST_EXTRACTOR + '.json')).map(f => { const file = path.join(dir, f); return { file, time: fs.statSync(file).mtimeMs }; }); }
  catch { return null; }
  for (const { file } of files.sort((a, b) => b.time - a.time).slice(0, 10)) {
    try {
      const module = JSON.parse(fs.readFileSync(file, 'utf8')).module;
      if (String(module?.name ?? '').toLowerCase() === name.toLowerCase() && typeof module.kind === 'string') return module.kind;
    } catch { /* another file of the store */ }
  }
  return null;
}

export async function moduleMap(input = {}, deps = {}) {
  const { read = readSnapshot, prepare = ensureBuilder, reader = {}, env = process.env } = deps;
  const started = performance.now();
  let q, file;
  try {
    q = mapRequest(input);
    if (RICH_VIEWS.includes(q.view)) return await richAnswer(q, { deps, read, capture: deps.capture ?? studio, reader, env, started });
    const target = await captureOf(q, deps);
    if (target.refused) return target.refused;
    file = target.file;
    const { sha256, canonical, captured, snapshot } = target;
    const hashMs = performance.now() - started;
    if (!expectedHolds(q, target)) throw new Error(CHANGED);
    if (q.view === 'digest') return await atLeastAPage(r => digestAnswer(r, { file, sha256, canonical, captured, snapshot, started, hashMs, read, reader, env, hot: hotOf(deps) }), q);
    if (q.view === 'html') return await htmlAnswer(q, { file, sha256, canonical, captured, snapshot, started, hashMs, read, reader, env });
    if (q.view === 'ddl') return await atLeastAPage(r => ddlAnswer(r, { file, sha256, canonical, captured, snapshot, started, hashMs, read, reader, env }), q);
    if (q.view === 'flow') return await flowAnswer(q, { file, sha256, canonical, captured, snapshot, started, hashMs, read, reader, env, hot: hotOf(deps) });
    const stored = indexFile(q.lane, sha256, env);
    let index = loadIndex(stored, q.lane, sha256), served = stored, cache = { index: 'hit' }, ensureMs;
    if (!index) {
      const phase = performance.now();
      if (q.lane === 'odc') { const ready = await prepare(); if (!ready.ok) throw new Error(ready.error); }
      const response = await read({ ...readerConfig(q.lane, { ...reader, env }), request: { file, index: 'ensure', expectedSourceSha256: sha256 } });
      const built = response.index ?? response.data?.index;
      if (!built) throw new Error('The ' + q.lane + ' reader answered without a module index: its binaries predate ' + INDEX_SCHEMA + '; rebuild the reader');
      index = loadIndex(stored, q.lane, sha256);
      // A reader started under another store root (SSAM_MODULE_INDEX_ROOT at its start) reports where it wrote.
      const reported = typeof built.path === 'string' ? path.resolve(built.path) : null;
      if (!index && reported && reported !== stored) { index = loadIndex(reported, q.lane, sha256); served = reported; }
      if (!index) throw new Error('The module index of this capture is missing or invalid after the reader built it: ' + stored);
      ensureMs = performance.now() - phase;
      cache = { index: 'ensured', built: built.built === true, ...(response.cache ? { loads: response.cache.loads, generation: response.cache.generation } : {}) };
    }
    const answer = present(index, q, { file, sha256, stored: served, cache, snapshot });
    if (answer.ok) {
      answer.contentSha256 = canonical.contentSha256;
      if (canonical.reused) answer.capture = { file: captured, reused: true, note: 'same content as the capture this answer reads (volatile header fields aside): its keys and index serve' };
      answer.timings = { hashMs, ...(ensureMs != null ? { ensureMs } : {}), totalMs: performance.now() - started };
    }
    return answer;
  } catch (error) {
    return { ok: false, ...mapRefusal(error, q, input), lane: q?.lane ?? input.lane ?? 'odc', target: input.target, ...(file ? { file } : {}) };
  }
}

// The capture a target names: a .oml as it is, a module name captured first (the live module, as inspect does; nothing
// else is warmed). O11 captures through the selected Service Studio (captureO11Module: an open tab by its key, without
// the write lock; a closed or system module from its published OML, never a tab), ODC through the ODC Studio bridge.
// deps.o11: options of captureO11Module (bridge, assertSelected, download, lockDeps, ...). C15: a capture of an unchanged
// module differs from the previous one only in volatile header fields; the first intact capture of the same content
// answers the read, so its index (keyed by its raw sha256) and its keys serve again.
async function captureTarget(target, q, { deps, capture, env }) {
  let snapshot = null, file;
  if (/\.oml$/i.test(target)) file = path.resolve(target);
  else {
    snapshot = q.lane === 'o11'
      ? await (deps.captureO11 ?? (module => captureO11Module(module, { env, ...(deps.o11 ?? {}) })))(target)
      : await capture(['snapshot', target], q.pid, { prefetch: false });
    if (!snapshot?.ok) return { ok: false, refusal: { ...snapshot, ok: false, lane: q.lane, target } };
    file = path.resolve(snapshot.path);
  }
  const captured = file;
  const canonical = readCapture(file, q.lane, { module: snapshot?.module ?? null, env });
  return { ok: true, file: canonical.file, captured, canonical, sha256: canonical.rawSha256, snapshot };
}

// ---- the rich views (module-rich.mjs): search and uses over the rich index of each target, built on request. A miss
// asks the lane's kernel reader to write it ({"rich":"ensure"}, the same reader as the digest) and reads the file it
// wrote; the answer says which captures were built and how long it took. Every continuation pins the same captures by
// file and hash; the page is cut to budgetBytes and says what it left for the next call.
async function richAnswer(q, { deps, read, capture, reader, env, started }) {
  const targets = Array.isArray(q.target) ? q.target : [q.target];
  const pins = q.expectedSourceSha256 == null ? [] : Array.isArray(q.expectedSourceSha256) ? q.expectedSourceSha256 : [q.expectedSourceSha256];
  const captures = [];
  const round = n => Math.round(n * 10) / 10;
  let ensureMs = 0;
  for (let k = 0; k < targets.length; k++) {
    const t = await captureTarget(targets[k], q, { deps, capture, env });
    if (!t.ok) return { ...t.refusal, view: q.view, ...(targets.length > 1 ? { target: q.target, failedTarget: targets[k] } : {}) };
    if (pins[k] && ![t.sha256, t.canonical.contentSha256, ...(t.canonical.reused ? [sha256Of(t.captured)] : [])].includes(pins[k]))
      throw new Error(CHANGED + (targets.length > 1 ? ' (target ' + targets[k] + ')' : ''));
    if (captures.some(c => c.sha256 === t.sha256)) throw new Error('target names the same capture twice: ' + targets[k] + ' (' + t.sha256 + ')');
    const stored = richFile(q.lane, t.sha256, env);
    let loaded = loadRich(stored, q.lane, t.sha256, ROLES), served = stored, cache;
    if (loaded) cache = { rich: loaded.memory ? 'memory' : 'hit' };
    else {
      const phase = performance.now();
      const config = digestReaderConfig(q.lane, { ...reader, env });
      if (read === readSnapshot && !fs.existsSync(config.dll))
        throw new Error('The ' + q.lane + ' kernel reader that writes the rich index is not built: ' + config.dll + ' (scripts/setup-dev.ps1 builds it)');
      const response = await read({ ...config, request: { file: t.file, rich: 'ensure', expectedSourceSha256: t.sha256 } });
      const built = response.rich ?? response.data?.rich;
      if (!built) throw new Error('The ' + q.lane + ' reader answered without a rich index: its binaries predate ' + RICH_SCHEMA + '; rebuild the reader');
      loaded = loadRich(stored, q.lane, t.sha256, ROLES);
      // A reader started under another store root (SSAM_MODULE_INDEX_ROOT at its start) reports where it wrote.
      const reported = typeof built.path === 'string' ? path.resolve(built.path) : null;
      if (!loaded && reported && reported !== stored) { loaded = loadRich(reported, q.lane, t.sha256, ROLES); served = reported; }
      if (!loaded) throw new Error('The rich index of this capture is missing or invalid after the reader built it: ' + stored);
      const ms = performance.now() - phase; ensureMs += ms;
      cache = { rich: 'ensured', built: built.built === true, ensureMs: round(ms),
        ...(response.timings?.loadMs != null ? { loadMs: round(response.timings.loadMs) } : {}), ...(response.timings?.richMs != null ? { buildMs: round(response.timings.richMs) } : {}),
        ...(response.cache ? { loads: response.cache.loads, generation: response.cache.generation } : {}) };
    }
    captures.push({ rich: loaded.rich, file: t.file, captured: t.captured, sha256: t.sha256, canonical: t.canonical, snapshot: t.snapshot, store: served, bytes: loaded.bytes, cache });
  }
  const queryStarted = performance.now();
  const single = !Array.isArray(q.target);
  const query = Object.fromEntries(Object.entries({ text: q.text, regex: q.regex || undefined, property: q.property, element: q.element, kind: q.kind, role: q.role })
    .filter(([, v]) => v != null));
  const pin = { lane: q.lane, target: single ? captures[0].file : captures.map(c => c.file), view: q.view, ...query, max: q.max, budgetBytes: q.budgetBytes,
    expectedSourceSha256: single ? captures[0].sha256 : captures.map(c => c.sha256) };
  const inspectOf = c => q.lane === 'odc'
    ? { tool: 'studio_inspect', arguments: { target: c.file, path: '@<key>', expectedSourceSha256: c.sha256 } }
    : { tool: 'o11_inspect', arguments: { oml: c.file, path: '@<key>', expectedSourceSha256: c.sha256 } };
  const capturesOut = captures.map(c => ({ module: c.rich.module.name, file: c.file, sourceSha256: c.sha256, contentSha256: c.canonical.contentSha256,
    ...(c.snapshot ? { snapshotSha256: c.snapshot.sha256 } : {}), ...(c.snapshot?.capturedBy === PUBLISHED_CAPTURE ? { capturedBy: PUBLISHED_CAPTURE, versionId: c.snapshot.versionId ?? null } : {}),
    ...(c.canonical.reused ? { capturedFile: c.captured, reused: true } : {}),
    rich: { file: c.store, bytes: c.bytes, extractor: c.rich.extractor, elements: c.rich.rows.length, complete: c.rich.complete === true, readErrors: c.rich.readErrors ?? 0 },
    cache: c.cache, inspect: inspectOf(c) }));
  const built = captures.filter(c => c.cache.rich === 'ensured').map(c => ({ module: c.rich.module.name, built: c.cache.built, ensureMs: c.cache.ensureMs }));
  let all, head, entryOf, extra = {};
  if (q.view === 'search') {
    const found = searchRich(captures, q);
    all = found.hits; entryOf = hit => searchEntry(captures, hit);
    // The hits per property, the most frequent first (at most 25; the rest counted together).
    const properties = Object.entries(found.byProperty).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    head = { schema: SEARCH_SCHEMA, fieldsSearched: found.fields, byModule: found.byModule, byProperty: Object.fromEntries(properties.slice(0, 25)),
      ...(properties.length > 25 ? { otherProperties: { properties: properties.length - 25, hits: properties.slice(25).reduce((s, [, v]) => s + v, 0) } } : {}) };
    extra = { ...((q.page ?? 1) === 1 && (q.offset ?? 0) === 0 ? { note: SEARCH_NOTE } : {}) };
  } else {
    const resolved = resolveElement(captures, q);
    if (!resolved.ok) {
      // No element of that name: the nearest names of the captures (same kind first), at most NEAR_MAX, and the question
      // for the dominant one by its @key.
      const near = resolved.ambiguous ? null : nearest(q.element, captures.flatMap(({ rich }, c) => rich.rows.map((row, i) => row[2] ? { name: row[2], kind: rich.types[row[1]]?.kind, c, i } : null).filter(Boolean)), { kind: q.kind ?? null });
      const candidates = (resolved.ambiguous ? resolved.candidates.slice(0, 20) : near.candidates).map(x => describeRow(captures, x));
      const dominant = near?.dominant ? describeRow(captures, near.dominant) : null;
      const last = q.element.replace(/^.*[/.:]/, '');
      return { ok: false, code: resolved.ambiguous ? 'AMBIGUOUS_ELEMENT' : 'ELEMENT_NOT_FOUND', lane: q.lane, view: 'uses', target: q.target, element: q.element,
        error: resolved.ambiguous
          ? 'element "' + q.element + '" names ' + resolved.candidates.length + ' different elements in these captures; name one by its @key (or narrow with kind)'
          : 'element "' + q.element + '" names no element of these captures (' + captures.map(c => c.rich.module.name).join(', ') + ')',
        ...(candidates.length ? { candidates, ...(resolved.ambiguous ? { candidatesOmitted: resolved.candidates.length - candidates.length } : {}) } : {}),
        ...(dominant ? { corrected: { tool: 'ssam_map', arguments: { ...pin, element: '@' + dominant.key }, why: dominant.name + ' (' + dominant.kind + ') is the one element near "' + q.element + '"' } } : {}),
        continuation: resolved.ambiguous
          ? { tool: 'ssam_map', arguments: { ...pin, element: '@<key>' }, why: 'the same question for one of the candidates' }
          : dominant ? { tool: 'ssam_map', arguments: { ...pin, element: '@' + dominant.key }, why: dominant.name + ' (' + dominant.kind + ') is the one element near "' + q.element + '"' }
            : { tool: 'ssam_map', arguments: (({ element, kind, role, ...rest }) => ({ ...rest, view: 'search', text: last, property: 'Name' }))(pin), why: 'find the element by name in the same captures' },
        captures: capturesOut };
    }
    const { edges, homeModule } = usesRich(captures, resolved);
    all = edges; entryOf = edge => usesEntry(captures, edge);
    const count = (list, key) => list.reduce((o, e) => { const k = key(e); o[k] = (o[k] ?? 0) + 1; return o; }, {});
    head = { schema: USES_SCHEMA, resolved: { ...describeRow(captures, resolved.home), identity: resolved.identity, homeModule,
      foundIn: resolved.found.map(x => ({ module: captures[x.c].rich.module.name, key: captures[x.c].rich.rows[x.i][0] })),
      ...(resolved.alsoMatched ? { alsoMatched: resolved.alsoMatched, alsoMatchedNote: 'nested elements of the same name were left out for the top-level one: name them by @key or by a name path' } : {}) },
      consumers: new Set(edges.map(e => e.c + ':' + e.from)).size, direct: edges.filter(e => e.direct).length, descendant: edges.filter(e => !e.direct).length,
      crossModule: edges.filter(e => e.cross).length, byModule: count(edges, e => captures[e.c].rich.module.name),
      byConsumerKind: count(edges, e => captures[e.c].rich.types[captures[e.c].rich.rows[e.from][1]].kind) };
    extra = { ...((q.page ?? 1) === 1 && (q.offset ?? 0) === 0 ? { note: USES_NOTE } : {}) };
  }
  const queryMs = performance.now() - queryStarted;
  const total = all.length;
  const page = all.slice(q.offset, q.offset + q.max).map(entryOf);
  const answer = n => {
    const nextOffset = q.offset + n < total ? q.offset + n : null;
    return { ok: true, ...head, lane: q.lane, view: q.view, target: q.target, query, captures: capturesOut, ...(built.length ? { built } : {}),
      count: total, returned: n, offset: q.offset, omitted: total - n, truncated: total !== n, nextOffset, entries: page.slice(0, n),
      continuations: { next: nextOffset != null ? { tool: 'ssam_map', arguments: { ...pin, offset: nextOffset } } : null,
        inspect: single ? capturesOut[0].inspect : 'captures[<capture>].inspect with the @key of an entry',
        note: 'next is the following page of the same query over the same captures (pinned by file and hash)' }, ...extra };
  };
  const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8') + 200;
  const minimal = bytes(answer(0));
  if (minimal > q.budgetBytes) {
    const raise = Math.min(1048576, minimal + 2000);
    const short = { ok: true, schema: head.schema, lane: q.lane, view: q.view, target: q.target, query, count: total, returned: 0, offset: q.offset, omitted: total,
      truncated: total > 0, nextOffset: total > q.offset ? q.offset : null, entries: [],
      continuation: { tool: 'ssam_map', arguments: { ...pin, offset: q.offset, budgetBytes: raise }, why: 'the smallest page of this query needs ' + minimal + ' bytes' } };
    short.size = { status: 'insufficient', bytes: 0, budgetBytes: q.budgetBytes, minimalBytes: minimal, limitedBy: 'budget' };
    short.size.bytes = Buffer.byteLength(JSON.stringify(short), 'utf8');
    return short;
  }
  let n = 0, used = minimal;
  while (n < page.length && used + Buffer.byteLength(JSON.stringify(page[n]), 'utf8') + 1 <= q.budgetBytes) used += Buffer.byteLength(JSON.stringify(page[n++]), 'utf8') + 1;
  let result = answer(n);
  while (n > 0 && bytes(result) > q.budgetBytes) result = answer(--n);
  result.size = { bytes: 0, budgetBytes: q.budgetBytes, limitedBy: n < page.length ? 'budget' : total > q.offset + n ? 'max' : null };
  result.timings = { ...(ensureMs ? { ensureMs: round(ensureMs) } : {}), queryMs: round(queryMs), totalMs: round(performance.now() - started) };
  for (let i = 0; i < 3; i++) result.size.bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  return result;
}

// The bytes of an answer in its size field (its own digits change the count at most twice).
const measure = answer => { if (answer?.size) for (let i = 0; i < 3; i++) answer.size.bytes = Buffer.byteLength(JSON.stringify(answer), 'utf8'); return answer; };

// S14 (leitura quente): a read of the flow or of the digest goes first to the lane's write worker when it is up, free and
// keeps the spare of this capture's model (anvil-worker.mjs hotModuleRead: the same kernel reader over the model it already
// loaded, writing the same files in the same store); anything else (no worker, busy, another model, ANVIL_WORKER=0, a
// failure) reads cold through the resident reader, as before. An injected reader (deps.read, tests) is used as is unless
// the test injects the hot reader too (deps.hot; null: never hot). The answer's cache says via:'worker' when the worker
// answered.
const hotOf = deps => deps.hot !== undefined ? deps.hot : deps.read ? null : hotModuleRead;
async function readFirstHot(read, lane, args, env, hot) {
  if (hot) {
    try {
      const served = await hot(lane, { request: args.request, indexRoot: args.indexRoot }, { env });
      if (served?.used) return served.response;
    } catch { /* a hot read that failed reads cold */ }
  }
  return read(args);
}
const viaOf = response => (response?.cache?.via ? { via: response.cache.via } : {});

// ---- the flow view: one action of the capture as ssam-flow/1 (module-flow.mjs), or the list of its actions. A miss asks
// the lane's kernel reader to write the flow file ({"flow":"ensure"}) and reads the file it wrote; every continuation pins
// this capture's file and hash.
// elements (S10): the actions the answer serves. Without a stored flow they are read alone ({"flowElements"}, the rest of
// the module not built: a partial flow, never stored) when each names one action among all of the capture's; else, and
// without elements (the list), the whole flow is built and stored as before. A reader that predates flowElements reads
// {"flow":"ensure"} of the same request.
async function ensureFlow(lane, { file, sha256, read, reader, env, elements = null, hot }) {
  const stored = flowFile(lane, sha256, env);
  let loaded = loadFlow(stored, lane, sha256), served = stored, cache = { flow: 'hit' }, ensureMs;
  if (!loaded) {
    const phase = performance.now();
    const config = digestReaderConfig(lane, { ...reader, env });
    if (read === readSnapshot && !fs.existsSync(config.dll))
      throw new Error('The ' + lane + ' kernel reader that writes the flow reading is not built: ' + config.dll + ' (scripts/setup-dev.ps1 builds it)');
    let response = null;
    if (elements?.length) {
      response = await readFirstHot(read, lane, { ...config, request: { file, flow: 'ensure', flowElements: elements, expectedSourceSha256: sha256 } }, env, hot);
      const selection = response.flowSelection ?? response.data?.flowSelection;
      if (selection) {
        if (!validFlowSelection(selection, lane, sha256, elements)) throw new Error('The ' + lane + ' reader answered a selected flow reading that does not match this capture and request');
        if (selectionFlow(selection, elements))
          return { loaded: { flow: selection }, served: stored, ensureMs: performance.now() - phase,
            cache: { flow: 'selected', built: false, queryHit: response.cache?.queryHit === true, ...(response.cache ? { loads: response.cache.loads, generation: response.cache.generation } : {}), ...viaOf(response) } };
        response = null;
      }
    }
    response ??= await readFirstHot(read, lane, { ...config, request: { file, flow: 'ensure', expectedSourceSha256: sha256 } }, env, hot);
    const built = response.flow ?? response.data?.flow;
    if (!built) throw new Error('The ' + lane + ' reader answered without a flow reading: its binaries predate ' + FLOW_SCHEMA + '; rebuild the reader');
    loaded = loadFlow(stored, lane, sha256);
    // A reader started under another store root (SSAM_MODULE_INDEX_ROOT at its start) reports where it wrote.
    const reported = typeof built.path === 'string' ? path.resolve(built.path) : null;
    if (!loaded && reported && reported !== stored) { loaded = loadFlow(reported, lane, sha256); served = reported; }
    if (!loaded) throw new Error('The flow reading of this capture is missing or invalid after the reader built it: ' + stored);
    ensureMs = performance.now() - phase;
    cache = { flow: 'ensured', built: built.built === true, ...(response.cache ? { loads: response.cache.loads, generation: response.cache.generation } : {}), ...viaOf(response) };
  }
  return { loaded, served, cache, ensureMs };
}

async function flowAnswer(q, context) {
  const { file, sha256, canonical, captured, snapshot, started, hashMs, read, reader, env, hot } = context;
  const elements = q.element == null ? null : Array.isArray(q.element) ? q.element : [q.element];
  const { loaded, served, cache, ensureMs } = await ensureFlow(q.lane, { file, sha256, read, reader, env, elements, hot });
  const { flow } = loaded;
  const pin = { lane: q.lane, target: file, view: 'flow', budgetBytes: q.budgetBytes, expectedSourceSha256: sha256,
    ...(q.includeDetail ? { includeDetail: true } : {}) };
  const inspect = q.lane === 'odc'
    ? { tool: 'studio_inspect', arguments: { target: file, path: '@<key>', expectedSourceSha256: sha256 } }
    : { tool: 'o11_inspect', arguments: { oml: file, path: '@<key>', expectedSourceSha256: sha256 } };
  const fixedPoint = flow.actions.filter(a => a.fixedPoint).length;
  // S10: a selected reading counts the module's actions from its catalog and says what it did not build; the fixed points
  // and nodes of the module are not known from it (null), only those of the actions built.
  const partial = flow.schema === FLOW_SELECTION_SCHEMA;
  const head = { ok: true, lane: q.lane, target: q.target, file, sourceSha256: sha256, contentSha256: canonical.contentSha256,
    ...(snapshot ? { snapshotSha256: snapshot.sha256 } : {}),
    ...(snapshot?.capturedBy === PUBLISHED_CAPTURE ? { capturedBy: PUBLISHED_CAPTURE, versionId: snapshot.versionId ?? null } : {}),
    module: flow.module, answeredBy: 'module-flow', store: { file: partial ? null : served, adapter: flow.adapter, extractor: flow.extractor, createdAt: flow.createdAt ?? null },
    flow: partial ? { actions: flow.scope.availableActions, fixedPoint: null, nodes: null }
      : { actions: flow.actions.length, fixedPoint, nodes: flow.actions.reduce((n, a) => n + a.nodes, 0) },
    ...(partial ? { partial: true, built: { actions: flow.actions.length, fixedPoint, nodes: flow.actions.reduce((n, a) => n + a.nodes, 0) },
      notBuilt: { actions: flow.scope.availableActions - flow.actions.length, note: 'only the actions asked for were read (their text, ids and textSha are those of the whole reading); '
        + 'the others were not built, so the module\'s fixed points and nodes are not counted here; the list of the actions (continuations.list) reads them all' } } : {}),
    ...(canonical.reused ? { capture: { file: captured, reused: true, note: 'same content as the capture this answer reads (volatile header fields aside): its keys and index serve' } } : {}) };
  const round = n => Math.round(n * 10) / 10;
  const finish = answer => {
    answer.cache = cache;
    answer.size = { bytes: 0, budgetBytes: q.budgetBytes };
    answer.timings = { hashMs: round(hashMs), ...(ensureMs != null ? { ensureMs: round(ensureMs) } : {}), totalMs: round(performance.now() - started) };
    for (let i = 0; i < 3; i++) answer.size.bytes = Buffer.byteLength(JSON.stringify(answer), 'utf8');
    return answer;
  };
  const entryOf = a => ({ name: a.name, kind: a.kind, key: a.key, bytes: Buffer.byteLength(a.text, 'utf8'), fixedPoint: a.fixedPoint });
  if (q.element == null) {
    // The list of the actions, in name order, paged by offset and max within the budget.
    const all = flow.actions;
    const page = all.slice(q.offset, q.offset + q.max).map(entryOf);
    const answer = n => {
      const nextOffset = q.offset + n < all.length ? q.offset + n : null;
      return { ...head, schema: FLOW_INDEX_SCHEMA, count: all.length, offset: q.offset, returned: n, nextOffset, entries: page.slice(0, n),
        continuations: { next: nextOffset != null ? { tool: 'ssam_map', arguments: { ...pin, offset: nextOffset, max: q.max } } : null,
          action: { tool: 'ssam_map', arguments: { ...pin, element: '<name or @key>' } },
          note: 'action reads one action as text (its name, Flow/Screen/Action or @key); next is the following page of this list' },
        ...((q.page ?? 1) === 1 && (q.offset ?? 0) === 0 ? { note: FLOW_NOTE } : {}) };
    };
    const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8') + 400;
    let n = page.length;
    while (n > 0 && bytes(answer(n)) > q.budgetBytes) n--;
    return finish(answer(n));
  }
  if (Array.isArray(q.element)) {
    const listed = flowList(q, flow, head, pin, inspect, finish, found => keepReadings(q.lane, sha256, served, found));
    // R4: one action of the list larger than the budget alone is served in pages (its first page), the rest of the list next.
    if (listed.oversize) {
      const first = await flowAnswer({ ...q, element: listed.oversize, page: 1 }, context);
      if (first.ok === false) return first;
      first.truncated = true;
      first.continuations = { ...first.continuations, rest: listed.rest.length ? { tool: 'ssam_map', arguments: { ...pin, element: listed.rest } } : null,
        note: first.continuations.note + '; rest reads the other actions of the list' };
      return measure(withNormalizationsOf(first, [{ rule: 'list-to-pages', at: '/element', note: listed.oversize + ' alone is larger than budgetBytes ' + q.budgetBytes + ': its page 1 here, its next page and the rest of the list in continuations' }]));
    }
    return finish(listed);
  }
  const { matches, by } = findActions(flow, q.element);
  if (matches.length !== 1) {
    const near = matches.length ? null : nearActions(flow, q.element);
    const candidates = (matches.length ? matches.slice(0, 20) : near.candidates).map(entryOf);
    const corrected = near?.dominant ? { tool: 'ssam_map', arguments: { ...pin, element: near.dominant.name, ...(q.page > 1 ? { page: q.page } : {}) }, why: near.dominant.name + ' is the one action near "' + q.element + '"' } : null;
    return finish({ ok: false, code: matches.length ? 'AMBIGUOUS_ELEMENT' : 'ELEMENT_NOT_FOUND', lane: q.lane, view: 'flow', target: q.target, file,
      sourceSha256: sha256, element: q.element,
      error: matches.length ? 'element "' + q.element + '" names ' + matches.length + ' actions of this capture (by ' + by + '); name one by its full name or @key'
        : 'element "' + q.element + '" names no action of this capture (' + flow.module.name + ', ' + flow.actions.length + ' actions)',
      ...(candidates.length ? { candidates } : {}), ...(corrected ? { corrected } : {}),
      continuation: corrected ?? (matches.length ? { tool: 'ssam_map', arguments: { ...pin, element: candidates[0].name }, why: 'the first candidate, by its full name' }
        : { tool: 'ssam_map', arguments: pin, why: 'the list of the actions of this capture (no single action is near "' + q.element + '")' }) });
  }
  const action = matches[0];
  keepReadings(q.lane, sha256, served, [action]);
  const body = (text, pages, page = q.page) => ({ ...head, schema: FLOW_PAGE_SCHEMA,
    action: { key: action.key, kind: action.kind, name: action.name, fixedPoint: action.fixedPoint, nodes: action.nodes, bytes: Buffer.byteLength(action.text, 'utf8'),
      textSha: textSha(action.text), ...(action.fixedPoint ? {} : { problems: action.problems.slice(0, 20) }),
      ...(Array.isArray(action.opaque) && action.opaque.length ? { opaque: action.opaque.slice(0, 20) } : {}) },
    page, pages, text, ...(q.includeDetail ? { ids: action.ids } : {}),
    continuations: { next: q.page < pages ? { tool: 'ssam_map', arguments: { ...pin, element: action.name, page: q.page + 1 } } : null,
      list: { tool: 'ssam_map', arguments: pin }, inspect,
      note: 'next is the following page of this action; ids (includeDetail) maps the @n/@p/@l ids to model keys for inspect' },
    ...((q.page ?? 1) === 1 && (q.offset ?? 0) === 0 ? { note: FLOW_NOTE } : {}) });
  // Page boundaries must not depend on cache misses, elapsed time, the requested
  // module alias or capture provenance: those change between continuation calls.
  // The envelope is the largest a page carries: the next continuation and the cache, size and timings at their widest.
  const PROVENANCE = ['capture', 'snapshotSha256', 'capturedBy', 'versionId'];
  const envelope = { ...body('', 99999, 99999), target: file, note: FLOW_NOTE,
    cache: { flow: 'ensured', built: false, loads: 99999999, generation: 99999999 }, size: { bytes: 99999999, budgetBytes: q.budgetBytes },
    timings: { hashMs: 99999999.9, ensureMs: 99999999.9, totalMs: 99999999.9 } };
  for (const key of PROVENANCE) delete envelope[key];
  envelope.continuations.next = { tool: 'ssam_map', arguments: { ...pin, element: action.name, page: 99999 } };
  // An action whose whole text fits the budget in one page is that page, as before (the envelope above is the largest one a
  // page can carry, so it only decides where a longer text is cut).
  if ((q.page ?? 1) === 1) {
    const whole = finish(body(action.text, 1));
    if (whole.size.bytes <= q.budgetBytes) return whole;
  }
  const room = q.budgetBytes - Buffer.byteLength(JSON.stringify(envelope), 'utf8') - 64;
  // R4 (16 BUDGET_TOO_SMALL after 20/10): a budget that leaves no room for a page of text reads at the smallest budget that
  // does (as the digest and the data text do, atLeastAPage), said in normalizations; truncated when the text has more pages.
  const raised = async (need, why) => {
    if (q.raisedFrom != null || need > 1048576) return { ok: false, code: 'BUDGET_TOO_SMALL', error: 'The flow metadata leaves no room for a page of text even at budgetBytes ' + q.budgetBytes,
      continuation: { tool: 'ssam_map', arguments: { ...pin, element: action.name, page: 1, budgetBytes: Math.min(1048576, need) } } };
    const value = await flowAnswer({ ...q, budgetBytes: need, raisedFrom: q.budgetBytes }, context);
    if (value.ok === false) return value;
    value.truncated = (value.pages ?? 1) > 1;
    const served = measure(withNormalizationsOf(value, [{ rule: 'budget-minimum', at: '/budgetBytes', note: 'budgetBytes ' + q.budgetBytes + ' ' + why + '; read at ' + need + ', the smallest page' }]));
    // The page is cut at `need` (the continuations read the next pages at it, so the boundaries never move) with the tight
    // page envelope of M2 (room = budget - envelope - 64): the note and truncated come beside that page, so the answer
    // declares the bytes it holds when they pass `need`, as a raised discover answer does (tool-routing.mjs budgetRaise).
    for (let i = 0; i < 3 && served.size && served.size.bytes > served.size.budgetBytes; i++) { served.size.budgetBytes = served.size.bytes; measure(served); }
    return served;
  };
  if (room < FLOW_PAGE_MIN) return raised(q.budgetBytes - room + 1024, 'leaves no room for a page of the action text');
  const pages = flowPages(action.text, room);
  if (q.page > pages.length) throw new Error('page ' + q.page + ' does not exist: the text of ' + action.name + ' has ' + pages.length + ' page(s) at budgetBytes ' + q.budgetBytes);
  let answer = finish(body(pages[q.page - 1], pages.length));
  // The provenance of this call (the capture it made, a published version) is said when it fits beside the page; the page
  // boundaries never depend on it (the continuations pin the same capture file and hash).
  if (answer.size.bytes > q.budgetBytes) { for (const key of PROVENANCE) delete answer[key]; answer = finish(answer); }
  if (answer.size.bytes > q.budgetBytes) return raised(Math.max(q.budgetBytes * 2, answer.size.bytes + 1024), 'is below the envelope of this page');
  return answer;
}

// The actions near a name no action has: those that contain it (similarActions), else the nearest by edit distance of the
// last segment, at most NEAR_MAX, with the dominant one (nearest).
function nearActions(flow, element) {
  const contain = similarActions(flow, element, NEAR_MAX + 1);
  const items = (contain.length ? contain : flow.actions).map(a => ({ ...a, name: a.name }));
  const { candidates, dominant } = nearest(element, items, { max: NEAR_MAX });
  const byName = new Map(flow.actions.map(a => [a.name, a]));
  return { candidates: (contain.length ? [...candidates, ...contain.filter(a => !candidates.some(c => c.name === a.name))].slice(0, NEAR_MAX) : candidates).map(c => byName.get(c.name) ?? c),
    dominant: dominant ? byName.get(dominant.name) ?? dominant : contain.length === 1 ? contain[0] : null };
}

// Several actions by a list of elements, each whole with its textSha, in the order asked, as many as fit the budget; the
// rest come as continuations.next. Every element that names no action or several is answered at once, with candidates.
function flowList(q, flow, head, pin, inspect, finish, keep = () => {}) {
  const misses = [], found = [];
  for (const element of q.element) {
    const { matches, by } = findActions(flow, element);
    if (matches.length === 1) { if (!found.some(a => a.key === matches[0].key)) found.push(matches[0]); continue; }
    const near = matches.length ? null : nearActions(flow, element);
    misses.push({ element, code: matches.length ? 'AMBIGUOUS_ELEMENT' : 'ELEMENT_NOT_FOUND', ...(by ? { by } : {}),
      candidates: (matches.length ? matches.slice(0, 10) : near.candidates).map(a => a.name), ...(near?.dominant ? { dominant: near.dominant.name } : {}) });
  }
  if (misses.length)
    return { ok: false, code: misses.length === 1 ? misses[0].code : 'ELEMENTS_NOT_FOUND', lane: q.lane, view: 'flow', target: q.target, file: head.file, sourceSha256: head.sourceSha256,
      error: misses.length + ' of ' + q.element.length + ' elements name no single action of this capture (' + flow.module.name + '): '
        + misses.map(m => m.element + (m.code === 'AMBIGUOUS_ELEMENT' ? ' (several)' : ' (none)')).join(', '),
      misses, continuation: { tool: 'ssam_map', arguments: { ...pin, element: q.element.map(e => misses.find(m => m.element === e)?.candidates[0] ?? e) },
        why: 'the same list with the first candidate of each miss (check that it is the action meant)' } };
  const entry = a => ({ key: a.key, kind: a.kind, name: a.name, fixedPoint: a.fixedPoint, nodes: a.nodes, textSha: textSha(a.text),
    ...(a.fixedPoint ? {} : { problems: a.problems.slice(0, 20) }), ...(q.includeDetail ? { ids: a.ids } : {}), text: a.text });
  const answer = (n, rest) => ({ ...head, schema: FLOW_PAGE_SCHEMA, count: found.length, returned: n, actions: found.slice(0, n).map(entry),
    continuations: { next: rest.length ? { tool: 'ssam_map', arguments: { ...pin, element: rest.map(a => a.name) } } : null, list: { tool: 'ssam_map', arguments: pin }, inspect,
      note: 'next reads the actions of the list that did not fit this budget (one alone larger than the budget: read it by its element, in pages)' },
    ...((q.page ?? 1) === 1 && (q.offset ?? 0) === 0 ? { note: FLOW_NOTE } : {}) });
  let n = found.length;
  while (n > 1 && Buffer.byteLength(JSON.stringify(finish(answer(n, found.slice(n)))), 'utf8') > q.budgetBytes) n--;
  if (Buffer.byteLength(JSON.stringify(finish(answer(n, found.slice(n)))), 'utf8') > q.budgetBytes)
    return { oversize: found[0].name, rest: found.slice(1).map(a => a.name) };
  keep(found.slice(0, n));
  return answer(n, found.slice(n));
}

// ---- the digest view: one page of the module digest of the capture (module-digest.mjs). A miss asks the lane's kernel
// reader to write it ({"digest":"ensure"}) and reads the file it wrote; every continuation pins this capture's file and hash.
// The stored digest of a capture, or the one the lane's kernel reader writes on a miss: {loaded: {digest, stamp}, served,
// cache, ensureMs}.
async function ensureDigest(lane, { file, sha256, read, reader, env, hot }) {
  const stored = digestFile(lane, sha256, env);
  let loaded = loadDigest(stored, lane, sha256), served = stored, cache = { digest: 'hit' }, ensureMs;
  if (!loaded) {
    const phase = performance.now();
    const config = digestReaderConfig(lane, { ...reader, env });
    if (read === readSnapshot && !fs.existsSync(config.dll))
      throw new Error('The ' + lane + ' kernel reader that writes the module digest is not built: ' + config.dll + ' (scripts/setup-dev.ps1 builds it)');
    const response = await readFirstHot(read, lane, { ...config, request: { file, digest: 'ensure', expectedSourceSha256: sha256 } }, env, hot);
    const built = response.digest ?? response.data?.digest;
    if (!built) throw new Error('The ' + lane + ' reader answered without a module digest: its binaries predate ' + DIGEST_SCHEMA + '; rebuild the reader');
    loaded = loadDigest(stored, lane, sha256);
    // A reader started under another store root (SSAM_MODULE_INDEX_ROOT at its start) reports where it wrote.
    const reported = typeof built.path === 'string' ? path.resolve(built.path) : null;
    if (!loaded && reported && reported !== stored) { loaded = loadDigest(reported, lane, sha256); served = reported; }
    if (!loaded) throw new Error('The module digest of this capture is missing or invalid after the reader built it: ' + stored);
    ensureMs = performance.now() - phase;
    cache = { digest: 'ensured', built: built.built === true, ...(response.cache ? { loads: response.cache.loads, generation: response.cache.generation } : {}), ...viaOf(response) };
  }
  return { loaded, served, cache, ensureMs };
}

// ---- the ddl view: one page of the data text of the capture (module-ddl.mjs), or of one element's block. A miss asks the
// lane's kernel reader to write it ({"ddl":"ensure"}) and reads the file it wrote; every continuation pins this capture.
async function ensureDdl(lane, { file, sha256, read, reader, env }) {
  const stored = ddlFile(lane, sha256, env);
  let loaded = loadDdl(stored, lane, sha256), served = stored, cache = { ddl: 'hit' }, ensureMs;
  if (!loaded) {
    const phase = performance.now();
    const config = digestReaderConfig(lane, { ...reader, env });
    if (read === readSnapshot && !fs.existsSync(config.dll))
      throw new Error('The ' + lane + ' kernel reader that writes the data text is not built: ' + config.dll + ' (scripts/setup-dev.ps1 builds it)');
    const response = await read({ ...config, request: { file, ddl: 'ensure', expectedSourceSha256: sha256 } });
    const built = response.ddl ?? response.data?.ddl;
    if (!built) throw new Error('The ' + lane + ' reader answered without a data text: its binaries predate ' + DDL_SCHEMA + '; rebuild the reader');
    loaded = loadDdl(stored, lane, sha256);
    // A reader started under another store root (SSAM_MODULE_INDEX_ROOT at its start) reports where it wrote.
    const reported = typeof built.path === 'string' ? path.resolve(built.path) : null;
    if (!loaded && reported && reported !== stored) { loaded = loadDdl(reported, lane, sha256); served = reported; }
    if (!loaded) throw new Error('The data text of this capture is missing or invalid after the reader built it: ' + stored);
    ensureMs = performance.now() - phase;
    cache = { ddl: 'ensured', built: built.built === true, ...(response.cache ? { loads: response.cache.loads, generation: response.cache.generation } : {}) };
  }
  return { loaded, served, cache, ensureMs };
}

async function ddlAnswer(q, { file, sha256, canonical, captured, snapshot, started, hashMs, read, reader, env }) {
  const { loaded, served, cache, ensureMs } = await ensureDdl(q.lane, { file, sha256, read, reader, env });
  const { ddl, stamp } = loaded;
  const pin = { lane: q.lane, target: file, view: 'ddl', budgetBytes: q.budgetBytes, expectedSourceSha256: sha256 };
  if (q.element != null) {
    const found = selectBlocks(ddl, q.element);
    if (!found.length) {
      // Those whose name contains it, else the nearest by edit distance (at most NEAR_MAX); one dominant: the read of it.
      const contain = ddl.blocks.filter(b => b.name.toLowerCase().includes(q.element.replace(/^@/, '').toLowerCase()));
      const ranked = nearest(q.element, contain.length ? contain : ddl.blocks);
      const near = (contain.length ? [...ranked.candidates, ...contain.filter(b => !ranked.candidates.includes(b))].slice(0, NEAR_MAX) : ranked.candidates)
        .map(b => ({ section: b.section, kind: b.kind, name: b.name, key: b.key }));
      const dominant = ranked.dominant ?? (contain.length === 1 ? contain[0] : null);
      const corrected = dominant ? { tool: 'ssam_map', arguments: { ...pin, element: dominant.name }, why: dominant.name + ' is the one element near "' + q.element + '"' } : null;
      return { ok: false, code: 'ELEMENT_NOT_FOUND', lane: q.lane, view: 'ddl', target: q.target, file, sourceSha256: sha256, element: q.element,
        error: 'element "' + q.element + '" names no entity, structure, variable or timer of this capture (' + ddl.module.name + ')',
        ...(near.length ? { candidates: near } : {}), ...(corrected ? { corrected } : {}), continuation: corrected ?? { tool: 'ssam_map', arguments: pin, why: 'the whole data text, page 1' } };
    }
  }
  const laid = ddlPages(ddl, { budgetBytes: q.budgetBytes, element: q.element ?? null, key: served + '|' + stamp });
  if (q.page > laid.pages.length)
    throw new Error('page ' + q.page + ' does not exist: the data text' + (q.element != null ? ' of ' + q.element : '') + ' has ' + laid.pages.length + ' page(s) at budgetBytes ' + q.budgetBytes);
  const inspect = q.lane === 'odc'
    ? { tool: 'studio_inspect', arguments: { target: file, path: '@<key>', expectedSourceSha256: sha256 } }
    : { tool: 'o11_inspect', arguments: { oml: file, path: '@<key>', expectedSourceSha256: sha256 } };
  const elementPin = q.element != null ? { ...pin, element: q.element } : pin;
  const answer = { ok: true, schema: DDL_PAGE_SCHEMA, lane: q.lane, target: q.target, file, sourceSha256: sha256, contentSha256: canonical.contentSha256,
    ...(snapshot ? { snapshotSha256: snapshot.sha256 } : {}),
    ...(snapshot?.capturedBy === PUBLISHED_CAPTURE ? { capturedBy: PUBLISHED_CAPTURE, versionId: snapshot.versionId ?? null } : {}),
    module: ddl.module, answeredBy: 'data-ddl', ...(q.element != null ? { element: q.element } : {}),
    store: { file: served, adapter: ddl.adapter, extractor: ddl.extractor, createdAt: ddl.createdAt ?? null },
    ...ddlBody(ddl, laid, q.page), cache,
    ...(canonical.reused ? { capture: { file: captured, reused: true, note: 'same content as the capture this answer reads (volatile header fields aside): its keys and index serve' } } : {}),
    continuations: { next: q.page < laid.pages.length ? { tool: 'ssam_map', arguments: { ...elementPin, page: q.page + 1 } } : null,
      page: { tool: 'ssam_map', arguments: { ...elementPin, page: '<n>' } }, element: { tool: 'ssam_map', arguments: { ...pin, element: '<name or @key>' } }, inspect,
      note: 'next is the following page; page reads any page (same capture, same budget); element reads one entity, structure, variable or timer; inspect reads an @key with this hash' },
    ...((q.page ?? 1) === 1 && (q.offset ?? 0) === 0 ? { note: DDL_NOTE } : {}) };
  const round = n => Math.round(n * 10) / 10;
  answer.size = { bytes: 0, budgetBytes: q.budgetBytes };
  answer.timings = { hashMs: round(hashMs), ...(ensureMs != null ? { ensureMs: round(ensureMs) } : {}), totalMs: round(performance.now() - started) };
  for (let i = 0; i < 3; i++) answer.size.bytes = Buffer.byteLength(JSON.stringify(answer), 'utf8');
  return answer;
}

// The whole module digest of a target, unpaged (the work packet of ssam_discover, work-packet.mjs): the same target rules,
// capture and store as view "digest". {ok, lane, target, file, sourceSha256, contentSha256, module, digest, cache,
// capturedBy?, versionId?}; a failure answers {ok:false, error} (or the snapshot's own refusal) and never throws.
// fix/unpublished-library round 2 (A3): it says how a module name was captured, as the paged digest does (digestAnswer):
// capturedBy "open-tab" (a Service Studio tab) or "published-oml" (a closed module: its published OML, with versionId).
export async function moduleDigest(input = {}, deps = {}) {
  const { read = readSnapshot, reader = {}, env = process.env } = deps;
  const lane = input.lane ?? 'odc';
  try {
    if (!['odc', 'o11'].includes(lane)) throw new Error('Unknown lane ' + lane + '; lanes: odc, o11');
    if (typeof input.target !== 'string' || !input.target.trim()) throw new Error('target is required: a capture .oml or an open module name');
    const q = { lane, target: input.target, pid: input.pid, expectedSourceSha256: input.expectedSourceSha256?.toLowerCase() };
    const target = await captureOf(q, deps);
    if (target.refused) return target.refused;
    if (!expectedHolds(q, target)) throw new Error(CHANGED);
    const { loaded, cache } = await ensureDigest(lane, { file: target.file, sha256: target.sha256, read, reader, env, hot: hotOf(deps) });
    const snapshot = target.snapshot;
    return { ok: true, lane, target: input.target, file: target.file, sourceSha256: target.sha256, contentSha256: target.canonical.contentSha256,
      module: loaded.digest.module, digest: loaded.digest, cache,
      ...(typeof snapshot?.capturedBy === 'string' ? { capturedBy: snapshot.capturedBy } : {}),
      ...(snapshot?.capturedBy === PUBLISHED_CAPTURE ? { versionId: snapshot.versionId ?? null } : {}) };
  } catch (error) {
    return { ok: false, ...mapRefusal(error, { lane, target: input.target, view: 'digest' }, input), lane, target: input.target };
  }
}

// The readings of the elements a change edits, for the work packet (R4, work-packet.mjs scope): the same readings as views
// "flow" and "html" of the same capture (the flow from its store, kept as the base of a three-way merge as a flow answer
// keeps it; a screen or block by the digest's reader), so the packet carries the text, its @ids or k and the exact basedOn.
// targets: [{kind:'flow'|'html', name, key}]. Never throws: {ok, readings: [...], errors: [...]}.
export async function ownerReadings(input = {}, deps = {}) {
  const { read = readSnapshot, reader = {}, env = process.env } = deps;
  const lane = input.lane ?? 'odc';
  const readings = [], errors = [];
  try {
    if (!['odc', 'o11'].includes(lane)) throw new Error('Unknown lane ' + lane + '; lanes: odc, o11');
    const file = path.resolve(String(input.file ?? ''));
    const sha256 = String(input.sourceSha256 ?? '').toLowerCase();
    if (!/\.oml$/i.test(file) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('ownerReadings needs the capture file and its sourceSha256 (the packet\'s module)');
    if (sha256Of(file) !== sha256 && readCapture(file, lane, { env }).rawSha256 !== sha256) throw new Error(CHANGED);
    const flows = (input.targets ?? []).filter(t => t.kind === 'flow');
    const elementOf = t => t.key ? '@' + String(t.key).replace(/^@/, '') : String(t.name ?? '');
    if (flows.length) {
      // S10: without a stored flow, only these actions are built (their text and textSha are those of the whole reading).
      const { loaded, served } = await ensureFlow(lane, { file, sha256, read, reader, env, elements: [...new Set(flows.map(elementOf))], hot: hotOf(deps) });
      const found = [];
      for (const t of flows) {
        const { matches } = findActions(loaded.flow, elementOf(t));
        if (matches.length !== 1) { errors.push({ kind: 'flow', name: t.name, error: matches.length ? 'several actions' : 'no action' }); continue; }
        const a = matches[0];
        found.push(a);
        readings.push({ kind: 'flow', name: a.name, key: a.key, textSha: textSha(a.text), fixedPoint: a.fixedPoint, text: a.text });
      }
      keepReadings(lane, sha256, served, found);
    }
    // {kind:'signature'}: an action whose contract is all the packet needs (inputs and outputs, no body; S10): the reader's
    // contracts ({"signatureElements"}, ModuleFlow.BuildSignatures), never stored, never a flow reading.
    const signatures = (input.targets ?? []).filter(t => t.kind === 'signature');
    if (signatures.length) {
      const elements = [...new Set(signatures.map(elementOf))];
      try {
        const config = digestReaderConfig(lane, { ...reader, env });
        if (read === readSnapshot && !fs.existsSync(config.dll)) throw new Error('the ' + lane + ' kernel reader that reads action contracts is not built');
        const response = await read({ ...config, request: { file, signatureElements: elements, expectedSourceSha256: sha256 } });
        const contracts = response.flowSignatures ?? response.data?.flowSignatures;
        if (contracts?.schema !== 'ssam-action-signatures/1' || String(contracts.sourceSha256).toLowerCase() !== sha256 || !Array.isArray(contracts.actions))
          throw new Error('the ' + lane + ' reader answered without ssam-action-signatures/1 (rebuild the reader)');
        for (const t of signatures) {
          const { matches } = findActions({ actions: contracts.actions }, elementOf(t));
          if (matches.length !== 1) { errors.push({ kind: 'signature', name: t.name, error: matches.length ? 'several actions' : 'no action' }); continue; }
          const a = matches[0];
          readings.push({ kind: 'signature', name: a.name, key: a.key, actionKind: a.kind, contractSha256: a.contractSha256 ?? null,
            inputs: a.inputs, outputs: a.outputs, ...(a.problems?.length ? { problems: a.problems } : {}) });
        }
      } catch (error) { for (const t of signatures) errors.push({ kind: 'signature', name: t.name, error: String(error?.message ?? error) }); }
    }
    for (const t of (input.targets ?? []).filter(t => t.kind === 'html')) {
      try {
        const config = digestReaderConfig(lane, { ...reader, env });
        if (read === readSnapshot && !fs.existsSync(config.dll)) throw new Error('the ' + lane + ' kernel reader that writes ssam-html/1 is not built');
        const response = await read({ ...config, request: { file, html: t.key ? '@' + String(t.key).replace(/^@/, '') : t.name, keys: false, expectedSourceSha256: sha256 } });
        const html = response.html ?? response.data?.html;
        if (!html?.html) throw new Error('the reader answered without ' + HTML_SCHEMA);
        readings.push({ kind: 'html', screen: html.root ?? t.name, key: html.rootKey ?? t.key ?? null, basedOn: { capture: sha256, html: html.htmlSha256 }, html: html.html });
      } catch (error) { errors.push({ kind: 'html', name: t.name, error: String(error?.message ?? error) }); }
    }
    return { ok: true, readings, errors };
  } catch (error) {
    return { ok: false, readings, errors: [...errors, { error: String(error?.message ?? error) }] };
  }
}

async function digestAnswer(q, { file, sha256, canonical, captured, snapshot, started, hashMs, read, reader, env, hot }) {
  const { loaded, served, cache, ensureMs } = await ensureDigest(q.lane, { file, sha256, read, reader, env, hot });
  const { digest, stamp } = loaded;
  const laid = digestPages(digest, { budgetBytes: q.budgetBytes, key: served + '|' + stamp });
  if (q.page > laid.pages.length)
    throw new Error('page ' + q.page + ' does not exist: the module digest of this capture has ' + laid.pages.length + ' page(s) at budgetBytes ' + q.budgetBytes);
  const pin = { lane: q.lane, target: file, view: 'digest', budgetBytes: q.budgetBytes, expectedSourceSha256: sha256 };
  const inspect = q.lane === 'odc'
    ? { tool: 'studio_inspect', arguments: { target: file, path: '@<key>', expectedSourceSha256: sha256 } }
    : { tool: 'o11_inspect', arguments: { oml: file, path: '@<key>', expectedSourceSha256: sha256 } };
  const answer = { ok: true, schema: DIGEST_PAGE_SCHEMA, lane: q.lane, target: q.target, file, sourceSha256: sha256, contentSha256: canonical.contentSha256,
    ...(snapshot ? { snapshotSha256: snapshot.sha256 } : {}),
    ...(snapshot?.capturedBy === PUBLISHED_CAPTURE ? { capturedBy: PUBLISHED_CAPTURE, versionId: snapshot.versionId ?? null } : {}),
    module: digest.module, answeredBy: 'module-digest',
    store: { file: served, adapter: digest.adapter, extractor: digest.extractor, createdAt: digest.createdAt ?? null },
    ...digestBody(digest, laid, q.page), cache,
    ...(canonical.reused ? { capture: { file: captured, reused: true, note: 'same content as the capture this answer reads (volatile header fields aside): its keys and index serve' } } : {}),
    continuations: { next: q.page < laid.pages.length ? { tool: 'ssam_map', arguments: { ...pin, page: q.page + 1 } } : null,
      page: { tool: 'ssam_map', arguments: { ...pin, page: '<n>' } }, inspect,
      note: 'next is the following page; page reads any page of contents (same capture, same budget); inspect reads an @key with this hash' },
    ...((q.page ?? 1) === 1 && (q.offset ?? 0) === 0 ? { note: DIGEST_NOTE } : {}) };
  const round = n => Math.round(n * 10) / 10;
  answer.size = { bytes: 0, budgetBytes: q.budgetBytes };
  answer.timings = { hashMs: round(hashMs), ...(ensureMs != null ? { ensureMs: round(ensureMs) } : {}), totalMs: round(performance.now() - started) };
  // The bytes of the answer itself, size field included (its own digits change the count at most twice).
  for (let i = 0; i < 3; i++) answer.size.bytes = Buffer.byteLength(JSON.stringify(answer), 'utf8');
  return answer;
}

// A refusal of the map with its own code (G11: KEY_UNRESOLVED); the catch of moduleMap keeps its fields.
const refusal = (code, message) => Object.assign(new Error(message), { refusal: { code } });

// ---- the html view: one screen or block as ssam-html/1, read by the lane's kernel reader (the digest's reader: on ODC the
// kernel's anvil-odc read-serve, whose Model API shows widgets as the digest does). The reader keeps the capture and its
// module reading loaded, so the next screen of the same capture reads in milliseconds; it stores the key table of each
// reading beside the capture's index (keysFile). Pages are whole lines within budgetBytes.
export function htmlPages(text, budget) {
  const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
  const pages = []; let from = 0, bytes = 0;
  lines.forEach((line, i) => {
    // As the line travels in the answer: JSON-escaped (a quote is two bytes), with its newline (\n, two bytes).
    const size = Buffer.byteLength(JSON.stringify(line), 'utf8');
    if (i > from && bytes + size > budget) { pages.push([from, i]); from = i; bytes = 0; }
    bytes += size;
  });
  pages.push([from, lines.length]);
  return { lines, pages };
}

// The delivery of an edit of this reading (C2): the html op in its edit form, in the lane's deliver tool. On ODC the
// studio_deliver of the ssam server needs feature, module, owners and changes with a job: the call carries them, the screen
// as its owner.
export function editCall(lane, html, sha256) {
  const op = { op: 'html', data: { screen: html.root, basedOn: { capture: sha256, html: html.htmlSha256 }, edits: [{ set: '<k>', attributes: { '<attribute>': '<value>' } }, { find: '<exact text>', with: '<new text>' }] } };
  return lane === 'o11'
    ? { tool: 'o11_deliver', arguments: { module: html.model ?? '<module>', job: { ops: [op] } } }
    : { tool: 'studio_deliver', arguments: { feature: html.root + ' (change)', module: html.model ?? '<module>', job: { ops: [op] }, owners: [html.root], changes: ['<what changes in the screen>'] } };
}

async function htmlAnswer(q, { file, sha256, canonical, captured, snapshot, started, hashMs, read, reader, env }) {
  const config = digestReaderConfig(q.lane, { ...reader, env });
  if (read === readSnapshot && !fs.existsSync(config.dll))
    throw new Error('The ' + q.lane + ' kernel reader that writes ssam-html/1 is not built: ' + config.dll + ' (scripts/setup-dev.ps1 builds it)');
  const phase = performance.now();
  const response = await read({ ...config, request: { file, html: q.screen ?? '', keys: q.includeKeys, expectedSourceSha256: sha256 } });
  const html = response.html ?? response.data?.html;
  if (!html) throw new Error('The ' + q.lane + ' reader answered without ' + HTML_SCHEMA + ': its binaries predate it; rebuild the reader');
  const readMs = performance.now() - phase;
  const round = n => Math.round(n * 10) / 10;
  const pin = { lane: q.lane, target: file, view: 'html', expectedSourceSha256: sha256 };
  const head = { ok: true, schema: HTML_SCHEMA, lane: q.lane, target: q.target, file, sourceSha256: sha256, contentSha256: canonical.contentSha256,
    ...(snapshot ? { snapshotSha256: snapshot.sha256 } : {}),
    ...(canonical.reused ? { capture: { file: captured, reused: true, note: 'same content as the capture this answer reads (volatile header fields aside): its keys serve' } } : {}),
    module: html.model ?? null };
  const timings = () => ({ hashMs: round(hashMs), readMs: round(readMs), ...(response.timings?.readMs != null ? { kernelReadMs: round(response.timings.readMs) } : {}),
    totalMs: round(performance.now() - started) });
  if (!q.screen) {
    const roots = html.roots ?? [];
    return { ...head, roots, count: roots.length,
      continuations: { screen: { tool: 'ssam_map', arguments: { ...pin, screen: '<name>' } }, note: 'screen reads one of them as ssam-html/1' },
      timings: timings() };
  }
  const inspect = q.lane === 'odc'
    ? { tool: 'studio_inspect', arguments: { target: file, path: '@<key>', expectedSourceSha256: sha256 } }
    : { tool: 'o11_inspect', arguments: { oml: file, path: '@<key>', expectedSourceSha256: sha256 } };
  const shape = (page, pages, from, to, total, text) => ({ ...head, screen: html.root, kind: html.rootKind, key: html.rootKey, htmlSha256: html.htmlSha256,
    basedOn: { capture: sha256, html: html.htmlSha256 }, bytes: html.bytes, elements: html.elements, widgets: html.widgets,
    opaqueWidgets: html.opaqueWidgets, ...(html.keysFile ? { keysFile: html.keysFile } : {}), ...(html.problems ? { problems: html.problems } : {}),
    page, pages, lines: { from: from + 1, to, total }, html: text, ...(q.includeKeys && html.keys ? { keys: html.keys } : {}),
    continuations: { next: page < pages ? { tool: 'ssam_map', arguments: { ...pin, screen: q.screen, page: page + 1 } } : null,
      keys: q.includeKeys ? null : { tool: 'ssam_map', arguments: { ...pin, screen: q.screen, keys: true } }, inspect,
      // WIRED (text-routes.mjs): the edit form of the html op is offered only while its way back is wired.
      edit: WIRED['ui.screen-html-edit'] === true ? editCall(q.lane, html, sha256) : null,
      note: 'next is the following page of the same screen; keys returns the k -> ObjectKey table inline; inspect reads an @key with this hash; '
        + (WIRED['ui.screen-html-edit'] === true ? 'edit is the delivery of a change of this reading (only the changed elements, with their k)'
          : 'edit is null: the way back of ssam-html/1 is not wired in this server (a change goes by the JSON form of the op, the matches of ssam_discover)') },
    ...((q.page ?? 1) === 1 && (q.offset ?? 0) === 0 ? { note: HTML_NOTE } : {}), size: { bytes: 0, budgetBytes: q.budgetBytes }, timings: timings() });
  // The text of a page gets what the budget leaves after the rest of the answer, measured on the answer itself (a middle
  // page, with every field and continuation) plus room for the digits that change. A line longer than that is a page alone.
  // Keep page boundaries independent of whether this request reused the capture and of
  // its timings. Later pages omit the fixed note but use the same layout as page one.
  const { capture: _capture, timings: _timings, ...pageEnvelope } = shape(99999, 100000, 99999, 99999, 99999, '');
  const overhead = Buffer.byteLength(JSON.stringify({ ...pageEnvelope, note: HTML_NOTE,
    capture: { file: captured, reused: true, note: 'same content as the capture this answer reads (volatile header fields aside): its keys serve' },
    timings: { hashMs: 999999, readMs: 999999, kernelReadMs: 999999, totalMs: 999999 } }), 'utf8') + 64;
  const laid = htmlPages(html.html, Math.max(1000, q.budgetBytes - overhead));
  if (q.page > laid.pages.length) throw new Error('page ' + q.page + ' does not exist: this screen has ' + laid.pages.length + ' page(s) at budgetBytes ' + q.budgetBytes);
  const [from, to] = laid.pages[q.page - 1];
  const answer = shape(q.page, laid.pages.length, from, to, laid.lines.length, laid.lines.slice(from, to).join('\n') + '\n');
  for (let i = 0; i < 3; i++) answer.size.bytes = Buffer.byteLength(JSON.stringify(answer), 'utf8');
  return answer;
}

function present(index, q, { file, sha256, stored, cache, snapshot }) {
  const { rows, types, roles } = index;
  const { keys, ancestorKeys, inside, ownerOf } = tables(index);
  // A key is a row, or an ancestor: an element Parent() reaches and no Children list holds, the parent of rows and never
  // listed itself (O11 a widget's MobileWidget "content" placeholder and MobileWidgetSignature; O11 and ODC a widget's
  // CustomProperty/ReferenceCustomProperty, an aggregate's DataTable). As key, an ancestor answers the row that owns it,
  // with a notice that says its kind and name (G11, FarmaVirtual 10/10/2026: the 22nd handed them out as parentKey and then
  // refused them as key). A key the capture does not have is KEY_UNRESOLVED; it never sends the model to map again a
  // capture whose hash it gave.
  const resolve = reference => {
    const key = reference.startsWith('@') ? reference.slice(1) : reference;
    const at = keys.get(key) ?? ancestorKeys.get(key);
    if (at == null) throw refusal('KEY_UNRESOLVED', 'Unresolved key in this capture: @' + key + '. No element of it has this key, as a row or as an element above one ('
      + (q.expectedSourceSha256 ? 'the hash given is this capture\'s: none of its answers has this key' : 'sourceSha256 ' + sha256)
      + '): the element was removed, or the key is from another module or mistyped. Find the element by name (name, prefix) or with view "search"');
    return { key, at };
  };
  const roleIndex = q.role == null ? null : roles.indexOf(q.role);
  if (q.role != null && roleIndex < 0) throw new Error('Unknown role ' + q.role + '; roles: ' + roles.join(', '));
  const parentRow = q.parent != null ? resolve(q.parent).at : null;
  let keyRow = null, keyOwner = null;
  if (q.key != null) {
    const { key, at } = resolve(q.key);
    keyRow = ownerOf(at);
    if (at <= -2) {
      const kind = types[typeOf(index, at)].kind, name = nameOf(index, at) ?? '';
      if (keyRow < 0) throw refusal('KEY_UNRESOLVED', 'Unresolved key in this capture: @' + key + ' is a ' + kind + ' no element row holds');
      keyOwner = { key, kind, name, ownerKey: rows[keyRow][0] };
    }
  }
  const keyNotice = keyOwner && '@' + keyOwner.key + ' is the ' + keyOwner.kind + (keyOwner.name ? ' ' + keyOwner.name : '') + ' of @' + keyOwner.ownerKey
    + ', an element Parent() reaches and no Children list holds, not a row of its own: this answer lists @' + keyOwner.ownerKey + '; parent "@' + keyOwner.key + '" lists what sits under it';
  // A list of kinds lists the elements that answer any of them ('*' among them: every kind), and names the kinds of the
  // list no element of the scope answers (kindsNotObserved).
  const kindNames = q.kind != null ? kindList(q.kind) : null;
  const kinds = kindNames && !kindNames.includes('*') ? types.map(t => kindNames.some(k => answers(t, k))) : null;
  const seenTypes = kinds && kindNames.length > 1 ? new Uint8Array(types.length) : null;
  // Detail rows and the anonymous types stay out of a plain map; a kind, a role, a key or --detail asks for them.
  const explicit = q.includeDetail || q.kind != null || q.role != null || q.key != null;
  const parentInside = parentRow != null && inside(parentRow) === 1;
  const name = q.name != null ? folded(q.name) : null, prefix = q.prefix != null ? folded(q.prefix) : null;
  const matched = []; const hidden = { detail: 0, anonymous: 0 };
  let kindObserved = kinds == null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (keyRow != null && i !== keyRow) continue;
    // A row as parent lists what hangs from it directly or through its ancestors (the reader's Children); an ancestor
    // as parent lists only what sits in it.
    if (parentRow != null && (parentRow >= 0 ? ownerOf(row[5]) !== parentRow : row[5] !== parentRow)) continue;
    if (kinds && !kinds[row[1]]) continue;
    kindObserved = true;
    if (seenTypes) seenTypes[row[1]] = 1;
    if (roleIndex != null && row[6] !== roleIndex) continue;
    if (name != null && folded(row[2] ?? '') !== name) continue;
    if (prefix != null && !folded(row[2] ?? '').startsWith(prefix)) continue;
    if (!explicit && DETAIL_ROLES.has(roles[row[6]])) { hidden.detail++; continue; }
    if (!explicit && !parentInside && inside(i) === 1) { hidden.anonymous++; continue; }
    matched.push(i);
  }
  // ModelReader.PathOf (ModuleIndex.PathOf): every element up the parent references, ancestors included, that has a
  // parent itself; the module root is left out.
  const pathOf = i => {
    const parts = []; const seen = new Set();
    for (let at = i; at !== -1 && parentOf(index, at) !== -1 && !seen.has(at); at = parentOf(index, at)) {
      seen.add(at); parts.push(types[typeOf(index, at)].kind + ':' + clip(nameOf(index, at) ?? ''));
    }
    return parts.reverse().join('/');
  };
  // parentKey is always a row (a key the map and the reader resolve); the ancestors between, by name (kind when it has
  // none), outermost first, are parentSlot: "content" for an O11 widget, the property ("Style") for its expressions.
  const slotOf = ref => {
    const names = [];
    for (let at = ref, hops = 0; at <= -2 && hops <= index.ancestors.length; at = parentOf(index, at), hops++) names.unshift(nameOf(index, at) || types[typeOf(index, at)].kind);
    return names.join('/');
  };
  const entryOf = i => { const r = rows[i]; const owner = ownerOf(r[5]); return { key: r[0], kind: types[r[1]].kind, name: r[2] ?? '', role: roles[r[6]],
    parentKey: owner >= 0 ? rows[owner][0] : null, ...(r[5] <= -2 ? { parentSlot: slotOf(r[5]) } : {}), path: pathOf(i), childrenTotal: r[8],
    ...(r[7] != null ? { dataType: r[7] } : {}) }; };
  const page = matched.slice(q.offset, q.offset + q.max).map(entryOf);
  const count = matched.length;
  const query = Object.fromEntries(Object.entries({ kind: q.kind, name: q.name, prefix: q.prefix, role: q.role, parent: q.parent, key: q.key,
    includeDetail: q.includeDetail || undefined }).filter(([, v]) => v != null));
  const kindsNotObserved = seenTypes ? kindNames.filter(k => !types.some((t, i) => seenTypes[i] && answers(t, k))) : [];
  // U6: counts by kind only on the first page of the unfiltered listing (they were 51.6% of the bytes of the session's
  // searches by name); a search by name, kind, prefix, role, parent or key keeps the totals and the roles.
  const filtered = ['kind', 'name', 'prefix', 'role', 'parent', 'key'].some(k => q[k] != null);
  const counts = { elements: index.counts?.elements ?? rows.length, byRole: index.counts?.byRole ?? null,
    ...(q.offset === 0 && !filtered ? { byKind: index.counts?.byKind ?? null } : {}) };
  // A module read from its published OML (A29) says so: it is the published version, not a Studio tab.
  const head = { ok: true, schema: MAP_SCHEMA, lane: q.lane, target: q.target, file, sourceSha256: sha256, ...(snapshot ? { snapshotSha256: snapshot.sha256 } : {}),
    ...(snapshot?.capturedBy === PUBLISHED_CAPTURE ? { capturedBy: PUBLISHED_CAPTURE, versionId: snapshot.versionId ?? null } : {}),
    module: index.module ?? null, answeredBy: 'module-index',
    index: { file: stored, adapter: index.adapter, extractor: index.extractor, createdAt: index.createdAt ?? null, complete: index.complete === true,
      readErrors: index.readErrors ?? 0, ...(index.readErrors ? { errorSamples: index.errorSamples ?? [] } : {}) },
    counts, query, ...(keyOwner ? { keyOwner } : {}), cache };
  const answer = (n, dropKinds = false) => {
    const nextOffset = q.offset + n < count ? q.offset + n : null;
    return { ...head, ...(dropKinds ? { counts: { ...counts, byKind: undefined, byKindOmitted: 'budget' } } : {}),
      count, returned: n, offset: q.offset, omitted: count - n, truncated: count !== n, nextOffset,
      kindObserved, ...(kindsNotObserved.length ? { kindsNotObserved } : {}), searchComplete: index.complete === true && !index.readErrors, notices: [...(kindObserved ? [] : [NOT_OBSERVED]), ...(keyNotice ? [keyNotice] : [])],
      ...(hidden.detail || hidden.anonymous ? { hidden: { ...hidden, note: 'detail rows (expression, reference, other) and anonymous structures/list types are left out of a plain map: pass includeDetail, a kind or a role to list them' } } : {}),
      entries: page.slice(0, n), continuations: continuations(q, file, sha256, nextOffset),
      note: 'Keys belong to this capture (sourceSha256). Read a subtree, its properties or its usages with continuations.inspect; after a Studio change take a new capture and map it again.' };
  };
  // The budget is on compact UTF-8 bytes of the whole answer, with room for size and timings.
  const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8') + 200;
  // The counts by kind go first when even an empty page does not fit.
  const dropKinds = counts.byKind != null && bytes(answer(0)) > q.budgetBytes;
  const minimal = bytes(answer(0, dropKinds));
  // Below the smallest page (head, counts, continuations): the minimal answer, inside the budget, with the same query at a
  // budget that holds a page as the next call; never an exception.
  if (minimal > q.budgetBytes) {
    const raise = Math.min(1048576, minimal + 2000);
    const filters = Object.fromEntries(['kind', 'name', 'prefix', 'role', 'parent', 'key'].filter(k => q[k] != null).map(k => [k, q[k]]));
    const short = { ok: true, schema: MAP_SCHEMA, lane: q.lane, target: q.target, file, sourceSha256: sha256, module: index.module ?? null, answeredBy: 'module-index',
      count, returned: 0, offset: q.offset, omitted: count, truncated: count > 0, nextOffset: count > q.offset ? q.offset : null, entries: [],
      continuation: { tool: 'ssam_map', arguments: { lane: q.lane, target: file, ...filters, ...(q.includeDetail ? { includeDetail: true } : {}), offset: q.offset, max: q.max,
        budgetBytes: raise, expectedSourceSha256: sha256 }, why: 'the smallest page of this query needs ' + minimal + ' bytes' } };
    short.size = { status: 'insufficient', bytes: 0, budgetBytes: q.budgetBytes, minimalBytes: minimal, limitedBy: 'budget' };
    short.size.bytes = Buffer.byteLength(JSON.stringify(short), 'utf8');
    return short;
  }
  let n = 0, total = minimal;
  while (n < page.length && total + Buffer.byteLength(JSON.stringify(page[n]), 'utf8') + 1 <= q.budgetBytes) total += Buffer.byteLength(JSON.stringify(page[n++]), 'utf8') + 1;
  let result = answer(n, dropKinds);
  while (n > 0 && bytes(result) > q.budgetBytes) result = answer(--n, dropKinds);
  result.size = { bytes: bytes(result) - 200, budgetBytes: q.budgetBytes, limitedBy: n < page.length ? 'budget' : count > q.offset + n ? 'max' : null };
  return result;
}

// Ready-to-use next calls, MCP only (no CLI line: it sent the model to a shell): a subtree by @key through the lane's
// reader tool, guarded by the hash, and the next page of this map.
function continuations(q, file, sha256, nextOffset) {
  const inspect = q.lane === 'odc'
    ? { tool: 'studio_inspect', arguments: { target: file, path: '@<key>', expectedSourceSha256: sha256 } }
    : { tool: 'o11_inspect', arguments: { oml: file, path: '@<key>', expectedSourceSha256: sha256 } };
  let next = null;
  if (nextOffset != null) {
    const filters = Object.fromEntries(['kind', 'name', 'prefix', 'role', 'parent', 'key'].filter(k => q[k] != null).map(k => [k, q[k]]));
    next = { tool: 'ssam_map', arguments: { lane: q.lane, target: file, ...filters, ...(q.includeDetail ? { includeDetail: true } : {}), offset: nextOffset, max: q.max,
      budgetBytes: q.budgetBytes, expectedSourceSha256: sha256 } };
  }
  return { inspect, next, note: 'replace <key> with the key of an entry; the hash guard refuses a capture that changed' };
}

// ---- O11: the live module a name means (ssam_map, ssam_discover app, o11_inspect module).
// A read never opens a module tab (A29, 2026-10-06). The open tabs of the selected Service Studio (list_open_modules, the
// name resolved as studio-module.mjs does) decide among three ways:
// 1. A system module (Users, OutSystemsUI, System: studio-module.mjs systemModuleName) or a module no tab has: its
//    PUBLISHED OML, downloaded by o11-environment.mjs downloadModule (contract I7; deps.download), without a tab and
//    without the write lock. A build without that function refuses MODULE_NOT_OPEN with the o11_environment download
//    continuation; nothing is opened.
// 2. A module open in a tab: captured by its key without selecting it (snapshot_module module_key, bridge C41; the
//    bridge's snapshot registry only adds, so a delivery's registered base stays). No lock: parallel reads and a running
//    write (a delivery pinned to its own module key) never meet.
// 3. A module open but not capturable by its key (still opening, a name two tabs match, an older bridge that captures only
//    the selected tab, no answer to the capture): the o11_studio snapshot {module} (open_module selects its tab) under the
//    write lock, waiting its turn in the Studio's write queue (studio-write-lock.mjs) behind any running write.
// A selected Studio that changed, or a Studio that does not answer the listing, is refused as o11_studio refuses it: no
// tab is opened and nothing is downloaded.
// deps: tool (named in the lock), env, lane, root, bridge (a client of o11-bridge.mjs or a function returning one),
// assertSelected, openCapture(module) (way 3), download({module}, {root, lane, env, assertSelected}) (way 1; null = absent),
// lockDeps (studio-write-lock deps), signal, now.
const OPENING = m => m?.serverSilentMode === true || m?.hasOpenedActiveESpace === false; // o11-studio.mjs openingOf
const stampOf = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);     // UTC yyyyMMddHHmmss
export const OPEN_TAB_CAPTURE = 'open-tab';
export const PUBLISHED_CAPTURE = 'published-oml';
export async function captureO11Module(module, { tool = 'ssam_map', env = process.env, lane = o11Lane.lane, root = anvilRoot, bridge, assertSelected,
  openCapture, download, lockDeps, signal, now = Date.now } = {}) {
  const client = async () => {
    if (typeof bridge === 'function') return bridge();
    if (bridge) return bridge;
    const { o11Bridge, bridgeTarget } = await import('./o11-bridge.mjs');
    return o11Bridge(bridgeTarget({ lane, root, env }));
  };
  const studioTool = () => import('./o11-studio.mjs');
  const selected = assertSelected ?? (async () => (await import('./studio-connect.mjs')).assertSelectedO11());
  const open = openCapture ?? (async name => (await studioTool()).o11Studio({ lane, root, env,
    ...(bridge ? { bridge } : {}), ...(assertSelected ? { assertSelected } : {}) })({ command: 'snapshot', args: { module: name } }, { signal }));
  // Way 1: the published OML (contract I7), never a tab.
  const published = async (name, reason) => {
    const fetchIt = { tool: 'o11_environment', arguments: { action: 'download', module: name },
      why: 'downloads the published OML without opening a tab; then ssam_map {lane:"o11", target:<returned file>}' };
    let fn = download;
    if (fn === undefined) { try { fn = (await import('./o11-environment.mjs')).downloadModule ?? null; } catch { fn = null; } }
    if (typeof fn !== 'function') return { ok: false, code: 'MODULE_NOT_OPEN', module: name, outcome: 'not-sent',
      error: (reason === 'system' ? name + ' is a system module and is never opened in the Studio' : name + ' is not open in the Studio')
        + '; this SSAM cannot read its published OML by itself yet, and nothing was opened.', continuation: fetchIt };
    let got;
    try { got = await fn({ module: name }, { root, lane, env, ...(assertSelected ? { assertSelected } : {}) }); }
    catch (error) { return { ok: false, code: 'DOWNLOAD_FAILED', module: name, error: String(error?.message ?? error), continuation: fetchIt }; }
    if (got?.ok !== true || typeof got.file !== 'string')
      return { ...(got && typeof got === 'object' ? got : {}), ok: false, code: got?.code ?? 'DOWNLOAD_FAILED', module: got?.module ?? name,
        ...(got?.continuation ? {} : { continuation: fetchIt }) };
    let sha256;
    try { sha256 = sha256Of(got.file); }
    catch (error) { return { ok: false, code: 'DOWNLOAD_FAILED', module: name, file: got.file, error: 'The downloaded OML cannot be read: ' + error.message, continuation: fetchIt }; }
    return { ok: true, path: got.file, sha256, module: got.module ?? name, key: got.key ?? null, versionId: got.versionId ?? null,
      folder: got.folder ?? path.dirname(got.file), capturedBy: PUBLISHED_CAPTURE, reason };
  };
  const system = systemModuleName(module);
  if (system) return published(system, 'system');
  try { await selected(); } catch (error) { return (await studioTool()).notSelectedRefusal(error); }
  let target, listed;
  try { target = await client(); listed = await target.ok('list_open_modules', {}, { timeoutMs: 10000, ...(signal ? { signal } : {}) }); }
  catch (error) {
    const refused = (await studioTool()).studioFailure(error);
    return { ...refused, code: refused.code ?? 'STUDIO_READ_FAILED', module, outcome: refused.outcome ?? 'not-sent',
      continuation: refused.continuation ?? { tool: 'o11_studio', arguments: { command: 'status' }, why: 'the open tabs of the Studio could not be read; see its state' } };
  }
  const all = (Array.isArray(listed?.modules) ? listed.modules : []).filter(m => m && m.hasESpace !== false && typeof m.name === 'string' && m.name);
  const resolved = resolveOpenModule(module, { open: all, lane: 'o11' });
  if (resolved.ok === true && resolved.via === 'unresolved') return published(module, 'not-open');
  // Way 2: the open tab by its key; null sends the capture to way 3.
  const byKey = async tab => {
    const file = path.join(o11LaneOf(lane, { root, env }).local, 'snapshots', tab.name.replace(/[^\w.-]/g, '_') + '-' + stampOf(now()) + '-' + randomUUID().slice(0, 8) + '.oml');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const data = await target.ok('snapshot_module', { path: file, module_key: tab.key }, signal ? { signal } : undefined);
      if (data?.key && data.key !== tab.key) return null;
      return { ok: true, path: data?.path ?? file, sha256: data?.sha256 ?? sha256Of(data?.path ?? file), module: data?.name ?? tab.name, key: tab.key,
        environment: data?.environment ?? tab.environment ?? null, snapshotId: data?.snapshot_id ?? null, capturedBy: OPEN_TAB_CAPTURE };
    } catch (error) {
      // A capture that may still be running in the Studio is never started a second time.
      if (error?.code === 'CANCELLED' || signal?.aborted) return { ok: false, code: 'CANCELLED', method: 'snapshot_module', outcome: 'unknown',
        error: 'The capture was cancelled; it stopped waiting.', continuation: { tool: 'o11_studio', arguments: { command: 'status' }, why: 'read the Studio state before repeating it' } };
      if (error?.code === 'BRIDGE_TIMEOUT') return { ok: false, code: 'BRIDGE_TIMEOUT', method: 'snapshot_module', outcome: error.executed === false ? 'not-sent' : 'unknown',
        error: 'The capture of ' + tab.name + ' got no answer in time.', continuation: { tool: 'o11_studio', arguments: { command: 'status' }, why: 'the Studio may be busy; read the state before repeating' } };
      return null;
    }
  };
  const named = resolved.ok === true ? all.filter(m => m.name === resolved.module || m.key === resolved.module) : [];
  const tab = named.length === 1 && !OPENING(named[0]) && typeof named[0].key === 'string' && named[0].key ? named[0] : null;
  const shot = tab ? await byKey(tab) : null;
  if (shot) return shot;
  // Way 3: the module is open in the Studio but must be selected first; the write waits its turn in the queue.
  return withStudioWriteLock({ tool, args: { lane: 'o11', module }, lane, write: true, deps: lockDeps ?? { o11Root: root, o11Lane: lane }, signal },
    () => open(module));
}

// ---- warm-up: a new capture gets its index in the background. Never blocks and never changes the caller's answer:
// the caller only spawns a detached `node module-map.mjs --prefetch`, which reads through its OWN reader cache root
// (<readers>-prefetch), so the capture an agent is reading in the lane reader is never evicted.
// Hosted (a customer's call, or the served process outside any customer context) it never starts: the helper is a detached
// process of the server, outside the customer's context, so it would read and log a customer's capture through the server's
// shared reader cache (<readers>-prefetch/prefetch.jsonl names the workspace file), keep a resident reader that outlives the
// request, the customer and the server, and start one more process per new capture with no bound per customer. Hosted, the
// first map builds the index through the lane reader instead, as when a prefetch is skipped.
const prefetched = new Set();
export const prefetchCacheRoot = (lane, env = process.env) => readerConfig(lane, { env }).cacheRoot + '-prefetch';
export const prefetchOffHosted = () => !!hostedContext() || servedWithoutContext();
export function prefetchIndex(file, lane, { env = process.env, spawnProcess = spawn } = {}) {
  try {
    if (prefetchOffHosted()) return { started: false, reason: 'hosted' };
    if (typeof file !== 'string' || !/\.oml$/i.test(file) || !['odc', 'o11'].includes(lane)) return { started: false, reason: 'not a capture' };
    file = path.resolve(file);
    if (!fs.existsSync(file)) return { started: false, reason: 'missing' };
    const sha256 = sha256Of(file);
    if (fs.existsSync(indexFile(lane, sha256, env))) return { started: false, reason: 'stored', sha256 };
    // C15: a capture with the content of an indexed one is read through that one; nothing to warm.
    const canonical = readCapture(file, lane, { env });
    if (canonical.reused && fs.existsSync(indexFile(lane, canonical.rawSha256, env))) return { started: false, reason: 'content', sha256, contentSha256: canonical.contentSha256 };
    if (prefetched.has(lane + ':' + sha256)) return { started: false, reason: 'started', sha256 };
    prefetched.add(lane + ':' + sha256);
    const cacheRoot = prefetchCacheRoot(lane, env);
    const child = spawnProcess(process.execPath, [self, '--prefetch', file, '--lane', lane],
      { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, SSAM_READER_CACHE_ROOT: cacheRoot } });
    child.on?.('error', () => {}); child.unref?.();
    return { started: true, sha256, cacheRoot };
  } catch (error) { return { started: false, error: error.message }; }
}
// The helper itself. It never builds the ODC reader (a background build would race a foreground one): a stale
// builder skips, and the next map builds the index through the lane reader instead.
export async function prefetchMain({ file, lane }, { env = process.env, read = readSnapshot, fresh = () => lane !== 'odc' || !builderNeedsBuild() } = {}) {
  const sha256 = sha256Of(file);
  if (loadIndex(indexFile(lane, sha256, env), lane, sha256)) return { ok: true, skipped: 'stored', sha256 };
  if (!fresh()) return { ok: false, skipped: 'the ODC reader needs a rebuild; prefetch never builds', sha256 };
  const response = await read({ ...readerConfig(lane, { env }), request: { file, index: 'ensure', expectedSourceSha256: sha256 } });
  return { ok: true, sha256, index: response.index ?? response.data?.index ?? null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  if (args[0] === '--prefetch') {
    const lane = value('--lane'); const file = path.resolve(value('--prefetch') ?? '');
    const record = outcome => { try {
      const log = readerConfig(lane).cacheRoot; fs.mkdirSync(log, { recursive: true });
      appendJsonLine(path.join(log, 'prefetch.jsonl'), { at: new Date().toISOString(), lane, file, ...outcome });
    } catch { /* the warm-up leaves no trace when it cannot */ } };
    prefetchMain({ file, lane }).then(record, error => { record({ ok: false, error: error.message }); process.exitCode = 1; });
  } else {
    process.stderr.write(JSON.stringify({ ok: false, error: 'Use ssam map / odc map; this entry only runs --prefetch <capture.oml> --lane o11|odc' }) + '\n');
    process.exitCode = 1;
  }
}
