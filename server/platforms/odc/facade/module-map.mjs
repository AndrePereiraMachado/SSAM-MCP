// The module map: every element of a capture from its module index, read here without .NET.
// The index is written by the lane's resident reader (C#), one JSON per capture and reader adapter:
//   <SSAM_MODULE_INDEX_ROOT | <workspace>\.local\module-index>\v1\<lane>\<sha256>.<adapter>.json   (ssam-module-index/1)
// A file is served only when schema, extractor and sourceSha256 (the hash of the bytes read now) match; anything else
// is a miss, and the lane reader builds it again ({"index":"ensure"}). The store is a cache: its writer trims it.
//   ssam map [--lane o11|odc] <capture.oml|Module> [--kind K[,K...]] [--name N] [--prefix P] [--role R] [--parent @key]
//     [--key @key] [--offset N] [--max N] [--budget B] [--detail] [--expectedSourceSha256 H]
//   ssam map [--lane o11|odc] <capture.oml|Module> --digest [--page N] [--budget B] [--expectedSourceSha256 H]
//     the module digest of the same capture (view "digest", module-digest.mjs): the whole module as text, in pages
//   ssam map [--lane o11|odc] <capture|Module>... --search <text> [--regex] [--property P] [--kind K] [--role R] [--offset N] [--max N]
//   ssam map [--lane o11|odc] <capture|Module>... --uses <@key|Module.Element|Flow/Screen/Action|Kind:Name|Name> [--kind K]
//     views "search" and "uses" (module-rich.mjs): the rich index of each capture (one or several of an app), built only
//     on request ({"rich":"ensure"}) and read here; search finds text in expressions and values, uses finds who uses an
//     element inside and across the given modules
//   node module-map.mjs --prefetch <capture.oml> --lane o11|odc      (the detached warm-up, see prefetchIndex)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workspaceRoot, anvilRoot, o11Lane } from './workspace.mjs';
import { readSnapshot } from './reader-client.mjs';
import { root as odcRoot, paths, odcStudioDir, ensureBuilder, builderNeedsBuild, studio } from './lib.mjs';
import { LANES } from './lanes.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { resolveOpenModule, systemModuleName } from './studio-module.mjs';
import { withStudioWriteLock } from './studio-write-lock.mjs';
import { canonicalCapture } from './oml-content-sha.mjs';
import { DIGEST_ADAPTER, DIGEST_PAGE_SCHEMA, DIGEST_SCHEMA, DIGEST_NOTE, loadDigest, digestPages, digestBody } from './module-digest.mjs';
import { RICH_ADAPTER, RICH_SCHEMA, SEARCH_SCHEMA, USES_SCHEMA, SEARCH_NOTE, USES_NOTE, loadRich, searchRich, searchEntry, resolveElement, usesRich,
  usesEntry, describeRow } from './module-rich.mjs';

export const INDEX_SCHEMA = 'ssam-module-index/1';
export const EXTRACTOR = 1;
export const MAP_SCHEMA = 'ssam-map/1';
export const ROLES = ['module', 'flow', 'screen', 'block', 'action', 'actionRef', 'aggregate', 'entity', 'staticEntity', 'structure',
  'attribute', 'parameter', 'variable', 'widget', 'event', 'flowNode', 'expression', 'reference', 'other'];
export const MAP_USAGE = 'ssam map [--lane o11|odc] <capture.oml|Module> [--kind K[,K...]] [--name N] [--prefix P] [--role R] [--parent @key] [--key @key] [--offset N] [--max N] [--budget B] [--detail] [--expectedSourceSha256 H] | ssam map [--lane o11|odc] <capture.oml|Module> --digest [--page N] [--budget B] [--expectedSourceSha256 H] | ssam map [--lane o11|odc] <capture|Module>... --search <text> [--regex] [--property P] [--kind K] [--role R] [--offset N] [--max N] | ssam map [--lane o11|odc] <capture|Module>... --uses <element> [--kind K] [--role R]';
export const VIEWS = ['map', 'digest', 'search', 'uses'];
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
export const indexFile = (lane, sha256, env = process.env) => path.join(indexRoot(env), 'v1', lane, sha256.toLowerCase() + '.' + adapterOf(lane) + '.json');
// The module digest beside the index (ModuleIndexStore.DigestPathOf), written in both lanes by the kernel's own reader.
export const digestFile = (lane, sha256, env = process.env) => path.join(indexRoot(env), 'v1', lane, sha256.toLowerCase() + '.' + DIGEST_ADAPTER + '.digest.json');
// The rich index beside them (ModuleIndexStore.RichPathOf), written by the same kernel reader as the digest, only on request.
export const richFile = (lane, sha256, env = process.env) => path.join(indexRoot(env), 'v1', lane, sha256.toLowerCase() + '.' + RICH_ADAPTER + '.rich.json');
// C15: the registry of canonical captures by content (oml-content-sha.mjs canonicalCapture), beside the index store.
export const contentRegistry = (lane, env = process.env) => path.join(indexRoot(env), 'v1', lane, 'content');
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
// The default byte budget is the MCP answer ceiling of ssam.mjs (SSAM_MAX_ANSWER_BYTES, 40960) less the room its shaper
// keeps for next steps (2048 bytes, ssam.mjs budgetCeiling): a map never answers more than a client takes in one piece,
// and the ceiling never has to page it.
export const DEFAULT_MAP_BUDGET = (env = process.env) => {
  const n = Number(env.SSAM_MAX_ANSWER_BYTES); const ceiling = Number.isInteger(n) && n >= 4096 ? n : 40960;
  return Math.min(1048576, Math.max(4096, ceiling - 2048));
};
function mapRequest(input) {
  const lane = input.lane ?? 'odc';
  if (!['odc', 'o11'].includes(lane)) throw new Error('Unknown lane ' + lane + '; lanes: odc, o11');
  const view = input.view ?? 'map';
  if (!VIEWS.includes(view)) throw new Error('view must be one of: ' + VIEWS.join(', ') + ' (map: the elements with their @keys; digest: the whole module as text, in pages; search: text in expressions and values; uses: who uses an element)');
  const rich = RICH_VIEWS.includes(view);
  const targets = Array.isArray(input.target) ? input.target : [input.target];
  if (Array.isArray(input.target) && !rich) throw new Error('a list of targets belongs to views "search" and "uses"; view "' + view + '" reads one capture or module');
  if (!targets.length || targets.length > MAX_TARGETS || targets.some(t => typeof t !== 'string' || !t.trim()))
    throw new Error('target is required: a capture .oml or an open module name' + (rich ? ', or a list of 1 to ' + MAX_TARGETS + ' of them (the modules of one app)' : '') + '. ' + MAP_USAGE);
  for (const name of ['kind', 'name', 'prefix', 'role', 'parent', 'key', 'text', 'property', 'element'])
    if (input[name] != null && (typeof input[name] !== 'string' || !input[name])) throw new Error(name + ' must be a non-empty string');
  const hashes = input.expectedSourceSha256 == null ? [] : Array.isArray(input.expectedSourceSha256) ? input.expectedSourceSha256 : [input.expectedSourceSha256];
  if (hashes.some(h => typeof h !== 'string' || !/^[a-fA-F0-9]{64}$/.test(h))) throw new Error('expectedSourceSha256 must be 64 hexadecimal characters' + (rich ? ' (or a list of them, one per target)' : ''));
  if (Array.isArray(input.expectedSourceSha256) && (!Array.isArray(input.target) || hashes.length !== targets.length))
    throw new Error('expectedSourceSha256 as a list needs a list target with one hash per target (' + targets.length + ')');
  const offset = integer('offset', input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const richOnly = ['text', 'property', 'element'].filter(k => input[k] != null);
  if (input.regex === true) richOnly.push('regex');
  if (!rich && richOnly.length) throw new Error(richOnly.join(', ') + ' belong to views "search" (text, regex, property) and "uses" (element)');
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
  if (view === 'digest') {
    // The digest pages the whole module: the map's filters and paging would read as a filtered digest, which it is not.
    const mapOnly = ['kind', 'name', 'prefix', 'role', 'parent', 'key'].filter(k => input[k] != null);
    if (input.includeDetail === true) mapOnly.push('includeDetail');
    if (offset > 0) mapOnly.push('offset');
    if (mapOnly.length) throw new Error('view "digest" pages the whole module digest; ' + mapOnly.join(', ') + ' belong to view "map". Use page to move through the digest.');
  } else if (input.page != null) throw new Error('page belongs to view "digest" (the module digest in pages); the map pages with offset and max');
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
    '--page': 'page', '--view': 'view', '--text': 'text', '--property': 'property', '--element': 'element' };
  // --digest, --search <text> and --uses <element> name their view; a second view word disagrees.
  const views = { '--digest': ['digest'], '--search': ['search', 'text'], '--uses': ['uses', 'element'] };
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--detail') { input.includeDetail = true; continue; }
    if (arg === '--regex') { input.regex = true; continue; }
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
      if (values[arg] in input && !(values[arg] === 'view' && input.view === value)) throw new Error('Duplicate ' + arg);
      input[values[arg]] = value; continue;
    }
    if (arg.startsWith('--')) throw new Error('Unknown map argument ' + arg + '; ' + MAP_USAGE);
    targets.push(arg);
  }
  if (!targets.length) throw new Error(MAP_USAGE);
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
    if (q.view === 'digest') return await digestAnswer(q, { file, sha256, canonical, captured, snapshot, started, hashMs, read, reader, env });
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
    return { ok: false, ...(error.refusal ?? {}), lane: q?.lane ?? input.lane ?? 'odc', target: input.target, ...(file ? { file } : {}), error: error.message };
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
    extra = { note: SEARCH_NOTE };
  } else {
    const resolved = resolveElement(captures, q);
    if (!resolved.ok) {
      const candidates = resolved.candidates.slice(0, 20).map(x => describeRow(captures, x));
      const last = q.element.replace(/^.*[/.:]/, '');
      return { ok: false, code: resolved.ambiguous ? 'AMBIGUOUS_ELEMENT' : 'ELEMENT_NOT_FOUND', lane: q.lane, view: 'uses', target: q.target, element: q.element,
        error: resolved.ambiguous
          ? 'element "' + q.element + '" names ' + resolved.candidates.length + ' different elements in these captures; name one by its @key (or narrow with kind)'
          : 'element "' + q.element + '" names no element of these captures (' + captures.map(c => c.rich.module.name).join(', ') + ')',
        ...(candidates.length ? { candidates, candidatesOmitted: resolved.candidates.length - candidates.length } : {}),
        continuation: resolved.ambiguous
          ? { tool: 'ssam_map', arguments: { ...pin, element: '@<key>' }, why: 'the same question for one of the candidates' }
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
    extra = { note: USES_NOTE };
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

// ---- the digest view: one page of the module digest of the capture (module-digest.mjs). A miss asks the lane's kernel
// reader to write it ({"digest":"ensure"}) and reads the file it wrote; every continuation pins this capture's file and hash.
// The stored digest of a capture, or the one the lane's kernel reader writes on a miss: {loaded: {digest, stamp}, served,
// cache, ensureMs}.
async function ensureDigest(lane, { file, sha256, read, reader, env }) {
  const stored = digestFile(lane, sha256, env);
  let loaded = loadDigest(stored, lane, sha256), served = stored, cache = { digest: 'hit' }, ensureMs;
  if (!loaded) {
    const phase = performance.now();
    const config = digestReaderConfig(lane, { ...reader, env });
    if (read === readSnapshot && !fs.existsSync(config.dll))
      throw new Error('The ' + lane + ' kernel reader that writes the module digest is not built: ' + config.dll + ' (scripts/setup-dev.ps1 builds it)');
    const response = await read({ ...config, request: { file, digest: 'ensure', expectedSourceSha256: sha256 } });
    const built = response.digest ?? response.data?.digest;
    if (!built) throw new Error('The ' + lane + ' reader answered without a module digest: its binaries predate ' + DIGEST_SCHEMA + '; rebuild the reader');
    loaded = loadDigest(stored, lane, sha256);
    // A reader started under another store root (SSAM_MODULE_INDEX_ROOT at its start) reports where it wrote.
    const reported = typeof built.path === 'string' ? path.resolve(built.path) : null;
    if (!loaded && reported && reported !== stored) { loaded = loadDigest(reported, lane, sha256); served = reported; }
    if (!loaded) throw new Error('The module digest of this capture is missing or invalid after the reader built it: ' + stored);
    ensureMs = performance.now() - phase;
    cache = { digest: 'ensured', built: built.built === true, ...(response.cache ? { loads: response.cache.loads, generation: response.cache.generation } : {}) };
  }
  return { loaded, served, cache, ensureMs };
}

// The whole module digest of a target, unpaged (the work packet of ssam_discover, work-packet.mjs): the same target rules,
// capture and store as view "digest". {ok, lane, target, file, sourceSha256, contentSha256, module, digest, cache}; a
// failure answers {ok:false, error} (or the snapshot's own refusal) and never throws.
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
    const { loaded, cache } = await ensureDigest(lane, { file: target.file, sha256: target.sha256, read, reader, env });
    return { ok: true, lane, target: input.target, file: target.file, sourceSha256: target.sha256, contentSha256: target.canonical.contentSha256,
      module: loaded.digest.module, digest: loaded.digest, cache };
  } catch (error) {
    return { ok: false, lane, target: input.target, error: error.message };
  }
}

async function digestAnswer(q, { file, sha256, canonical, captured, snapshot, started, hashMs, read, reader, env }) {
  const { loaded, served, cache, ensureMs } = await ensureDigest(q.lane, { file, sha256, read, reader, env });
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
    note: DIGEST_NOTE };
  const round = n => Math.round(n * 10) / 10;
  answer.size = { bytes: 0, budgetBytes: q.budgetBytes };
  answer.timings = { hashMs: round(hashMs), ...(ensureMs != null ? { ensureMs: round(ensureMs) } : {}), totalMs: round(performance.now() - started) };
  // The bytes of the answer itself, size field included (its own digits change the count at most twice).
  for (let i = 0; i < 3; i++) answer.size.bytes = Buffer.byteLength(JSON.stringify(answer), 'utf8');
  return answer;
}

// A refusal of the map with its own code (G11: KEY_UNRESOLVED); the catch of moduleMap keeps its fields.
const refusal = (code, message) => Object.assign(new Error(message), { refusal: { code } });

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
      why: 'baixa o OML publicado sem abrir aba; depois ssam_map {lane:"o11", target:<arquivo devolvido>}' };
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
      continuation: refused.continuation ?? { tool: 'o11_studio', arguments: { command: 'status' }, why: 'as abas abertas do Studio não puderam ser lidas; veja o estado dele' } };
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
        error: 'The capture of ' + tab.name + ' got no answer in time.', continuation: { tool: 'o11_studio', arguments: { command: 'status' }, why: 'o Studio pode estar ocupado; leia o estado antes de repetir' } };
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
const prefetched = new Set();
export const prefetchCacheRoot = (lane, env = process.env) => readerConfig(lane, { env }).cacheRoot + '-prefetch';
export function prefetchIndex(file, lane, { env = process.env, spawnProcess = spawn } = {}) {
  try {
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
      fs.appendFileSync(path.join(log, 'prefetch.jsonl'), JSON.stringify({ at: new Date().toISOString(), lane, file, ...outcome }) + '\n');
    } catch { /* the warm-up leaves no trace when it cannot */ } };
    prefetchMain({ file, lane }).then(record, error => { record({ ok: false, error: error.message }); process.exitCode = 1; });
  } else {
    process.stderr.write(JSON.stringify({ ok: false, error: 'Use ssam map / odc map; this entry only runs --prefetch <capture.oml> --lane o11|odc' }) + '\n');
    process.exitCode = 1;
  }
}
