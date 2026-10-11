// The rich module index (ssam-rich-index/1) answering cross-cutting questions in one call, without .NET:
//   ssam_map {view:"search", target, text, regex?, kind?, role?, property?}  text in expressions, values and names;
//   ssam_map {view:"uses", target, element, kind?, role?}                    who uses an element, inside and across modules.
// target may be a list of captures/modules of one app. The file is written by the lane's kernel reader (C# ModuleRichIndex,
// request {"rich":"ensure"}) beside the module index, only on request (it is large):
//   <SSAM_MODULE_INDEX_ROOT | <workspace>\.local\module-index>\v1\<lane>\<sha256>.kernel.rich.json
// and read here: served only when schema, extractor, lane, adapter and the sha256 of the bytes read now match.
// module-map.mjs resolves the targets, ensures the files and pages the answer (richAnswer); this file holds the store
// checks and the queries, pure over parsed files (tests build them synthetically).
// Row: [key, typeIndex, name, parentRow (-1 root), roleIndex, props [[nameIndex, type, text]], refs [[targetRow, viaIndex|-1]],
// globalKey|null]; type e expression, t text, v value, r reference (Kind:Name), a argument (name: the parameter).
// Identity across modules: the GlobalKey (<module key>*<element key>); a row without one is <this module key>*<its key>.
import fs from 'node:fs';

export const RICH_SCHEMA = 'ssam-rich-index/1';
// ModuleRichIndex.Extractor and PropertyTypes (C#): a stored file of another version is a miss.
export const RICH_EXTRACTOR = 1;
export const PROPERTY_TYPES = 'etvra';
// Both lanes write it with the kernel's own reader (anvil read-serve, anvil-odc read-serve), as the digest.
export const RICH_ADAPTER = 'kernel';
export const SEARCH_SCHEMA = 'ssam-search/1';
export const USES_SCHEMA = 'ssam-uses/1';
export const TYPE_NAMES = { e: 'expression', t: 'text', v: 'value', r: 'reference', a: 'argument', n: 'name' };
const SNIPPET_BEFORE = 60, SNIPPET_AFTER = 100;

// The checks of ModuleRichIndex.Parse: identity, tables, and every row, property, reference and module reference in range.
export function wellFormedRich(r, lane, roles) {
  if (!r || r.schema !== RICH_SCHEMA || r.extractor !== RICH_EXTRACTOR || r.lane !== lane || r.adapter !== RICH_ADAPTER
    || typeof r.sourceSha256 !== 'string' || typeof r.module?.name !== 'string' || typeof r.module?.key !== 'string' || r.propertyTypes !== PROPERTY_TYPES
    || !Array.isArray(r.roles) || r.roles.length !== roles.length || r.roles.some((x, i) => x !== roles[i])
    || !Array.isArray(r.types) || !Array.isArray(r.names) || !Array.isArray(r.rows) || !Array.isArray(r.references)) return false;
  const n = r.rows.length, types = r.types.length, names = r.names.length;
  if (!r.types.every(t => t && typeof t.kind === 'string' && Array.isArray(t.answers)) || !r.names.every(x => typeof x === 'string')) return false;
  for (let i = 0; i < n; i++) {
    const row = r.rows[i];
    if (!Array.isArray(row) || row.length !== 8 || typeof row[0] !== 'string' || !Number.isInteger(row[1]) || row[1] < 0 || row[1] >= types
      || typeof row[2] !== 'string' || !Number.isInteger(row[3]) || row[3] < -1 || row[3] >= n || !Number.isInteger(row[4]) || row[4] < 0
      || row[4] >= roles.length || !Array.isArray(row[5]) || !Array.isArray(row[6]) || (row[7] !== null && typeof row[7] !== 'string')
      || (i > 0 && r.rows[i - 1][0] > row[0])) return false;
    for (const p of row[5]) if (!Array.isArray(p) || p.length !== 3 || !Number.isInteger(p[0]) || p[0] < 0 || p[0] >= names
      || typeof p[1] !== 'string' || p[1].length !== 1 || !PROPERTY_TYPES.includes(p[1]) || typeof p[2] !== 'string') return false;
    for (const x of row[6]) if (!Array.isArray(x) || x.length !== 2 || !Number.isInteger(x[0]) || x[0] < 0 || x[0] >= n
      || !Number.isInteger(x[1]) || x[1] < -1 || x[1] >= names) return false;
  }
  return r.references.every(x => Array.isArray(x) && x.length === 3 && Number.isInteger(x[0]) && x[0] >= 0 && x[0] < n
    && typeof x[1] === 'string' && (x[2] === null || typeof x[2] === 'string'));
}

// The last parsed files (an app is a few captures), at most KEEP of them and KEEP_BYTES of files (a 17 MB file is about
// 150 MB of heap); the one just read always stays. The file is content-addressed, the stamp only tells a rewritten file
// from the one already parsed. memory says whether the call found it parsed.
const parsed = new Map();
const KEEP = 6, KEEP_BYTES = 64 * 1024 * 1024;
export function loadRich(file, lane, sha256, roles) {
  let stat; try { stat = fs.statSync(file); } catch { return null; }
  const stamp = stat.size + ':' + stat.mtimeMs + ':' + stat.ino;
  const known = parsed.get(file);
  let rich = known?.stamp === stamp ? known.rich : null, memory = rich != null;
  if (!rich) {
    try { rich = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
    if (!wellFormedRich(rich, lane, roles)) return null;
  }
  parsed.delete(file); parsed.set(file, { stamp, rich, bytes: stat.size });
  let total = [...parsed.values()].reduce((n, x) => n + x.bytes, 0);
  for (const [name, entry] of parsed) {
    if (parsed.size <= 1 || (parsed.size <= KEEP && total <= KEEP_BYTES)) break;
    if (name === file) continue;
    parsed.delete(name); total -= entry.bytes;
  }
  return rich.sourceSha256.toLowerCase() === sha256.toLowerCase() ? { rich, stamp, memory, bytes: stat.size } : null;
}

// ---- derived tables, once per parsed file
const derived = new WeakMap();
const clip = text => text.length > 80 ? text.slice(0, 80) + '…' : text;
export function tables(rich) {
  let t = derived.get(rich);
  if (t) return t;
  const { rows } = rich;
  const n = rows.length;
  const keys = new Map(); rows.forEach((row, i) => { if (!keys.has(row[0])) keys.set(row[0], i); });
  // The Reference row each row sits under (-1: this module's own element), by climbing parents once.
  const referenceOf = new Int32Array(n).fill(-2);
  const referenceRows = new Map(rich.references.map((x, i) => [x[0], i]));
  for (let i = 0; i < n; i++) {
    if (referenceOf[i] !== -2) continue;
    const chain = []; let at = i, found = -1;
    while (at !== -1 && chain.length <= n) {
      // A Reference row above decides before any memo: the Reference itself is this module's own (-1).
      if (at !== i && referenceRows.has(at)) { found = referenceRows.get(at); break; }
      if (referenceOf[at] !== -2) { found = referenceOf[at]; break; }
      chain.push(at);
      at = rows[at][3];
    }
    for (const j of chain) referenceOf[j] = referenceRows.has(j) ? -1 : found;
  }
  const identity = i => rows[i][7] ?? rich.module.key + '*' + rows[i][0];
  let byIdentity = null, consumers = null;
  t = {
    keys, referenceOf, identity,
    // The producer of an element of another module (its Reference: name and module key), or null.
    producer: i => referenceOf[i] >= 0 ? { name: rich.references[referenceOf[i]][1], key: rich.references[referenceOf[i]][2] } : null,
    byIdentity: () => {
      if (!byIdentity) { byIdentity = new Map(); for (let i = 0; i < n; i++) { const id = identity(i); const list = byIdentity.get(id); if (list) list.push(i); else byIdentity.set(id, [i]); } }
      return byIdentity;
    },
    // Incoming references per row: [consumerRow, viaIndex].
    consumers: () => {
      if (!consumers) {
        consumers = new Map();
        for (let i = 0; i < n; i++) for (const [target, via] of rows[i][6]) { const list = consumers.get(target); if (list) list.push([i, via]); else consumers.set(target, [[i, via]]); }
      }
      return consumers;
    },
    kind: i => rich.types[rows[i][1]].kind,
    // ModelReader.PathOf over the walk parents: every element that has a parent, the module root left out.
    path: i => { const parts = []; for (let at = i; at !== -1 && rows[at][3] !== -1; at = rows[at][3]) parts.push(rich.types[rows[at][1]].kind + ':' + clip(rows[at][2])); return parts.reverse().join('/'); },
    // The names above (empty names skipped), for name paths such as MainFlow/Home/Search.
    names: i => { const parts = []; for (let at = i; at !== -1 && rows[at][3] !== -1; at = rows[at][3]) if (rows[at][2]) parts.push(rows[at][2]); return parts.reverse(); },
    inside: (i, ancestor) => { for (let at = i; at !== -1; at = rows[at][3]) if (at === ancestor) return true; return false; },
  };
  derived.set(rich, t);
  return t;
}

// HasKind of the readers: a name in the element's answers, with or without the leading I.
const answers = (type, kind) => type.kind === kind || (type.answers ?? []).some(a => a === kind || a === 'I' + kind);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = text => String(text).toLowerCase();

// ---- search: text in expressions, values, references, arguments and names; filters by kind, role and property.
// captures: [{rich, ...}] in the caller's order. Hits come in capture order, then row (key) order, then property order.
export function searchRich(captures, q) {
  let pattern;
  try { pattern = new RegExp(q.regex ? q.text : escape(q.text), 'i'); }
  catch (error) { throw new Error('text is not a valid regular expression (regex:true): ' + error.message); }
  const property = q.property != null ? fold(q.property) : null;
  const argument = property?.startsWith('arg:') ? property.slice(4) : property === 'arg' ? '*' : null;
  const wants = (name, type) => property == null || (type === 'a' ? argument === '*' || argument === fold(name) || argument === '' : argument == null && fold(name) === property);
  const hits = []; let fields = 0; const byModule = {}; const byProperty = {};
  captures.forEach((capture, c) => {
    const { rich } = capture; const t = tables(rich);
    const kinds = q.kind != null && q.kind !== '*' ? rich.types.map(type => answers(type, q.kind)) : null;
    const role = q.role != null ? rich.roles.indexOf(q.role) : null;
    for (let i = 0; i < rich.rows.length; i++) {
      const row = rich.rows[i];
      if (kinds && !kinds[row[1]]) continue;
      if (role != null && row[4] !== role) continue;
      const check = (name, type, text) => {
        fields++;
        if (!wants(name, type)) return;
        const m = pattern.exec(text);
        if (!m) return;
        const label = type === 'a' ? 'arg:' + name : name;
        hits.push({ c, i, property: label, type, text, at: m.index, length: m[0].length });
        byModule[rich.module.name] = (byModule[rich.module.name] ?? 0) + 1;
        byProperty[label] = (byProperty[label] ?? 0) + 1;
      };
      if (row[2]) check('Name', 'n', row[2]);
      for (const [name, type, text] of row[5]) check(rich.names[name], type, text);
    }
  });
  return { hits, fields, byModule, byProperty };
}

// The entry of one hit: where (module, @key, kind, path), which property and the passage around the match. A passage
// shorter than the text says so (textLength, clipped) and the inspect continuation of its capture reads the whole value.
export function searchEntry(captures, hit) {
  const { rich } = captures[hit.c]; const t = tables(rich); const row = rich.rows[hit.i];
  const start = Math.max(0, hit.at - SNIPPET_BEFORE), end = Math.min(hit.text.length, hit.at + hit.length + SNIPPET_AFTER);
  const clipped = start > 0 || end < hit.text.length;
  const snippet = (start > 0 ? '…' : '') + hit.text.slice(start, end).replace(/\s+/g, ' ') + (end < hit.text.length ? '…' : '');
  const producer = t.producer(hit.i);
  return { module: rich.module.name, ...(captures.length > 1 ? { capture: hit.c } : {}), key: row[0], kind: t.kind(hit.i), name: row[2],
    path: t.path(hit.i), property: hit.property, type: TYPE_NAMES[hit.type], snippet,
    ...(clipped ? { textLength: hit.text.length, clipped: true } : {}), ...(producer ? { producer: producer.name } : {}) };
}

// ---- uses: the element named by @key, Module.Element, a name path (Flow/Screen/Action), Kind:Name or a name, in any of the
// captures. Its identity (GlobalKey) and those of its descendants find it in every capture: as this module's own element
// in its producer, as a signature under the Reference of the producer in each consumer.
export function resolveElement(captures, q) {
  const text = q.element.trim();
  const candidates = [];
  const kindOk = (rich, i) => q.kind == null || q.kind === '*' || answers(rich.types[rich.rows[i][1]], q.kind);
  const roleOk = (rich, i) => q.role == null || rich.roles[rich.rows[i][4]] === q.role;
  const push = (c, i) => { if (kindOk(captures[c].rich, i) && roleOk(captures[c].rich, i)) candidates.push({ c, i }); };
  if (text.startsWith('@')) {
    const key = text.slice(1);
    captures.forEach(({ rich }, c) => { const i = tables(rich).keys.get(key); if (i != null) push(c, i); });
  } else {
    let kind = null, rest = text;
    const colon = /^([A-Za-z_]\w*):(.+)$/.exec(text);
    if (colon && !text.includes('/')) { kind = colon[1]; rest = colon[2]; }
    const dot = rest.indexOf('.');
    const segments = rest.split('/').map(s => fold(s.trim())).filter(Boolean);
    const named = (rich, i) => {
      const names = tables(rich).names(i).map(fold);
      return names.length >= segments.length && segments.every((s, k) => names[names.length - segments.length + k] === s);
    };
    const kindOf = (rich, i) => kind == null || answers(rich.types[rich.rows[i][1]], kind);
    let qualified = false;
    if (dot > 0 && !rest.includes('/')) {
      // Producer.Element: the producer's own element in its capture, or the signature under its Reference in a consumer.
      const module = fold(rest.slice(0, dot)), name = fold(rest.slice(dot + 1));
      captures.forEach(({ rich }, c) => {
        const t = tables(rich);
        if (fold(rich.module.name) === module) {
          qualified = true;
          rich.rows.forEach((row, i) => { if (t.referenceOf[i] === -1 && fold(row[2]) === name && kindOf(rich, i)) push(c, i); });
        }
        rich.references.forEach(([refRow, producer]) => {
          if (fold(producer) !== module) return;
          qualified = true;
          rich.rows.forEach((row, i) => { if (row[3] === refRow && fold(row[2]) === name && kindOf(rich, i)) push(c, i); });
        });
      });
    }
    if (!qualified)
      captures.forEach(({ rich }, c) => rich.rows.forEach((row, i) => { if (row[2] && fold(row[2]) === segments.at(-1) && kindOf(rich, i) && named(rich, i)) push(c, i); }));
  }
  if (!candidates.length) return { ok: false, candidates: [] };
  // A name means a top-level element first (a child of the module, or a signature right under a Reference): an attribute
  // or a parameter of the same name is left out, and counted (alsoMatched), when one exists.
  const topLevel = x => {
    const { rich } = captures[x.c]; const parent = rich.rows[x.i][3];
    return parent !== -1 && (rich.rows[parent][3] === -1 || rich.references.some(r => r[0] === parent));
  };
  let alsoMatched = 0;
  if (!text.startsWith('@') && candidates.some(topLevel) && !candidates.every(topLevel)) {
    const kept = candidates.filter(topLevel); alsoMatched = candidates.length - kept.length;
    candidates.length = 0; candidates.push(...kept);
  }
  // One element is one identity: the producer's own row and the consumers' signatures of it are the same element.
  // An element of this module comes first; among several identities the answer is ambiguous.
  const ids = new Map();
  for (const x of candidates) {
    const t = tables(captures[x.c].rich); const id = t.identity(x.i);
    const list = ids.get(id); if (list) list.push(x); else ids.set(id, [x]);
  }
  if (ids.size > 1) return { ok: false, ambiguous: true, candidates };
  const [[id, list]] = ids;
  const home = list.find(x => tables(captures[x.c].rich).referenceOf[x.i] === -1) ?? list[0];
  return { ok: true, identity: id, home, found: list, alsoMatched };
}

export function usesRich(captures, resolved) {
  const { home } = resolved;
  const homeRich = captures[home.c].rich; const homeT = tables(homeRich);
  // The target and its descendants (an entity's attributes, an action's parameters), by identity.
  const subtree = new Set();
  for (let i = 0; i < homeRich.rows.length; i++) if (homeT.inside(i, home.i)) subtree.add(homeT.identity(i));
  const main = homeT.identity(home.i);
  const homeModule = homeT.producer(home.i)?.name ?? homeRich.module.name;
  const edges = []; const seen = new Set();
  captures.forEach(({ rich }, c) => {
    const t = tables(rich); const byId = t.byIdentity(); const consumers = t.consumers();
    const targets = new Set();
    for (const id of subtree) for (const i of byId.get(id) ?? []) targets.add(i);
    for (const target of targets) for (const [from, via] of consumers.get(target) ?? []) {
      // Uses inside the target itself, and the signatures' own parts under a Reference, are not uses.
      if (targets.has(from) || t.referenceOf[from] >= 0) continue;
      let inside = false; for (let at = rich.rows[from][3]; at !== -1; at = rich.rows[at][3]) if (targets.has(at)) { inside = true; break; }
      if (inside) continue;
      const key = c + ':' + from + ':' + target;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ c, from, target, via, direct: t.identity(target) === main, cross: fold(rich.module.name) !== fold(homeModule) });
    }
  });
  edges.sort((a, b) => a.c - b.c || (captures[a.c].rich.rows[a.from][0] < captures[b.c].rich.rows[b.from][0] ? -1 : captures[a.c].rich.rows[a.from][0] > captures[b.c].rich.rows[b.from][0] ? 1 : 0)
    || (captures[a.c].rich.rows[a.target][0] < captures[b.c].rich.rows[b.target][0] ? -1 : captures[a.c].rich.rows[a.target][0] > captures[b.c].rich.rows[b.target][0] ? 1 : 0));
  return { edges, homeModule, main };
}

export function usesEntry(captures, edge) {
  const { rich } = captures[edge.c]; const t = tables(rich);
  const consumer = rich.rows[edge.from], target = rich.rows[edge.target];
  return { module: rich.module.name, ...(captures.length > 1 ? { capture: edge.c } : {}),
    consumer: { key: consumer[0], kind: t.kind(edge.from), name: consumer[2], path: t.path(edge.from) },
    ...(edge.direct ? {} : { target: { key: target[0], kind: t.kind(edge.target), name: target[2] } }),
    via: edge.via >= 0 ? rich.names[edge.via] : null, relation: edge.direct ? 'direct' : 'descendant', ...(edge.cross ? { crossModule: true } : {}) };
}

export const describeRow = (captures, x) => {
  const { rich } = captures[x.c]; const t = tables(rich); const row = rich.rows[x.i]; const producer = t.producer(x.i);
  return { module: rich.module.name, key: row[0], kind: t.kind(x.i), name: row[2], path: t.path(x.i), ...(producer ? { producer: producer.name } : {}) };
};

export const SEARCH_NOTE = 'Hits in capture order, then @key, then property. snippet is the passage around the match (whitespace collapsed); clipped:true means the value is longer: '
  + 'read it whole with the inspect continuation of its capture (path "@<key>", properties "<property>", full:true). Keys belong to these captures (sourceSha256).';
export const USES_NOTE = 'Native model references of the indexed captures only (literal strings, URLs and runtime lookups are not inferred); a module not given in target is not seen: '
  + 'add its capture to see its uses. A consumer module runs the producer version it was compiled against: after changing the producer, refresh references and republish each consumer module listed here.';
