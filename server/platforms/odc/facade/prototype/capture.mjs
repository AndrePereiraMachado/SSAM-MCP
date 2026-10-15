#!/usr/bin/env node
// Prototype folder -> IR "ssam-prototype-capture/1" and its content-addressed bundle (docs/PROTOTIPO-NATIVO.md 2).
// export async function capturePrototype({source, entry, mapping, clock, tz, out, timeoutMs, pool})
//   -> {ok: true, capturePath, bundle, sha256, summary, problems: [], warnings}
//   -> {ok: false, problems: [{code, path, message, patch?, alternatives?}], warnings}
// CLI: node platforms/odc/facade/prototype/capture.mjs <source> --out <dir> [--entry x] [--mapping <json>] [--clock <iso>] [--tz <iana>] [--pool n]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { acquirePool, releasePool, defaultPoolSize, closeResidentPools } from './pool.mjs';
import { Session, crawlRoutes, viewsFromCrawl, crawlPages, sectionTargets, LIMITS, uniqueSelector } from './crawl.mjs';
import { staticKind } from './kinds.mjs';
import { analyzeScripts, planScripts, remoteScriptUrls } from './scripts.mjs';
import { resolveVendors, defaultVendorCache, suggestedVendorPath, downloadVendor } from './vendor.mjs';
import { localPath, ORIGIN } from './network.mjs';
import { annotateRegion, listTemplate, pooledList, snapshotTemplate, listSort, findLists, rewriteListRefs, fieldVars } from './infer-lists.mjs';
import { writeBundle } from './bundle.mjs';
import { irHash, validateIr, sha256, SCHEMA, attr, classes, countElements, isElement, isModalNode, stripObservation, treeHash, walk, textOf, canonical } from './ir.mjs';
import { analyzeInteractions, eventCases, sortEffects } from './effects.mjs';
import { buildShell } from './shell.mjs';
import { iconInstances, iconSet } from './icons.mjs';
import { inventory } from './css-inventory.mjs';
import { collectAssets } from './assets.mjs';
import { prefixFrom, pascal, slug } from './names.mjs';
import { separate } from './predicates.mjs';
import { isArchive, extractArchive, ARCHIVE_MARKER } from './archive.mjs';
import { compileBabelSources } from './babel.mjs';
import { rankEntries } from './entry.mjs';

const require = createRequire(import.meta.url);
const { version: JSDOM_VERSION } = require('jsdom/package.json');

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.vscode', '.idea']);

function listFiles(root) {
  const out = [];
  const visit = (dir, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) visit(path.join(dir, entry.name), prefix + entry.name + '/'); }
      else if (entry.isFile()) out.push(prefix + entry.name);
    }
  };
  visit(root, '');
  return out;
}

// A shallow copy without one key (payloads that stay out of the IR or the printed result).
function omit(object, key) { const copy = { ...object }; delete copy[key]; return copy; }

export function pointerEscape(text) { return String(text).replace(/~/g, '~0').replace(/\//g, '~1'); }

// Patches over /ops/<i>/data that, applied in order, create mapping parents only once (2.11: all patches together
// form one valid call).
export function mappingPatches(mapping, additions, pointer) {
  const state = JSON.parse(JSON.stringify(mapping ?? {}));
  // An empty mapping is the same as none: the first patch creates /mapping (an add over {} is harmless).
  let mappingExists = Boolean(mapping && typeof mapping === 'object' && Object.keys(mapping).length);
  const out = [];
  // Patch values are copies: later additions change the state, never a patch already emitted.
  const copy = value => JSON.parse(JSON.stringify(value));
  for (const { keys, value } of additions) {
    let cursor = state;
    if (!mappingExists) {
      const built = {}; let leaf = built;
      keys.slice(0, -1).forEach(key => { leaf[key] = {}; leaf = leaf[key]; });
      leaf[keys[keys.length - 1]] = value;
      out.push([{ op: 'add', path: pointer + '/mapping', value: copy(built) }]);
      Object.assign(state, built);
      mappingExists = true;
      continue;
    }
    let depth = 0;
    while (depth < keys.length - 1 && cursor[keys[depth]] && typeof cursor[keys[depth]] === 'object') { cursor = cursor[keys[depth]]; depth++; }
    const rest = keys.slice(depth);
    let built = value;
    for (let i = rest.length - 1; i >= 1; i--) built = { [rest[i]]: built };
    out.push([{ op: 'add', path: pointer + '/mapping/' + keys.slice(0, depth + 1).map(pointerEscape).join('/'), value: copy(built) }]);
    cursor[rest[0]] = built;
  }
  return out;
}

// The source: a folder, an .html in it, or the .zip it came in (extracted once into sourcesDir/<sha256>, archive.mjs), then
// the same entry rules as a folder. archive: {path, sha256} when the facade already extracted it (the IR records it).
function resolveSource(source, entry, { sourcesDir = null, archive = null } = {}) {
  const problems = [];
  if (!source || typeof source !== 'string') return { problems: [{ code: 'PROTOTYPE_SOURCE_INVALID', field: 'source', message: 'source must be an absolute path to the prototype folder, to an .html file inside it or to its .zip' }] };
  let root = path.resolve(source), file = entry ?? null;
  let stat;
  try { stat = fs.statSync(root); } catch { return { problems: [{ code: 'PROTOTYPE_SOURCE_INVALID', field: 'source', message: 'source ' + source + ' does not exist' }] }; }
  if (stat.isFile() && isArchive(root)) {
    const extracted = extractArchive(root, { sourcesDir: sourcesDir ?? path.join(os.tmpdir(), 'ssam-prototype-sources') });
    if (!extracted.ok) return { problems: [{ code: 'PROTOTYPE_SOURCE_INVALID', field: 'source', message: 'the archive ' + source + ' cannot be used (nothing was extracted): ' + extracted.problems.map(item => item.message).slice(0, 6).join('; ') }] };
    archive = { path: root, sha256: extracted.sha256 };
    root = extracted.root;
  } else if (stat.isFile()) {
    if (!/\.html?$/i.test(root)) return { problems: [{ code: 'PROTOTYPE_SOURCE_INVALID', field: 'source', message: 'source ' + source + ' is not a folder, an .html file nor a .zip' }] };
    file = file ?? path.basename(root);
    root = path.dirname(root);
  }
  const files = listFiles(root);
  const htmlFiles = files.filter(name => /\.html?$/i.test(name));
  if (!htmlFiles.length) return { problems: [{ code: 'PROTOTYPE_SOURCE_INVALID', field: 'source', message: 'source ' + source + ' has no .html file' }] };
  if (!file) {
    if (htmlFiles.includes('index.html')) file = 'index.html';
    else {
      const top = htmlFiles.filter(name => !name.includes('/'));
      if (top.length === 1) file = top[0];
      else {
        // the page that runs the app first (prototype/entry.mjs): the patch names it, the others are the alternatives
        const ranked = top.length ? rankEntries(root, top) : [];
        problems.push({ code: 'PROTOTYPE_SOURCE_INVALID', field: 'entry', message: 'entry is ambiguous: ' + (ranked.length ? ranked.map(item => item.why).join('; ') : 'no .html at the root'), candidates: ranked.length ? ranked.map(item => item.page) : htmlFiles });
      }
    }
  } else {
    file = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!files.includes(file)) problems.push({ code: 'PROTOTYPE_SOURCE_INVALID', field: 'entry', message: 'entry ' + file + ' does not exist in ' + root, candidates: htmlFiles.filter(name => !name.includes('/')) });
  }
  return { root, entry: file, files: files.filter(name => name !== ARCHIVE_MARKER), htmlFiles, problems, archive };
}

// Files the capture reads statically: the entry, its scripts and module graph, stylesheets and their url() files, README.
// aliases: mapping.version, the entry's app script -> the version the owner chose ({"v1-app.jsx": "v2-app.jsx"}).
function staticScan(root, entry, files, aliases = {}) {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.join(root, entry), 'utf8');
  const dom = new JSDOM(html, { url: ORIGIN + '/' + entry, includeNodeLocations: true });
  const document = dom.window.document;
  const plan = planScripts(document, { nodeLocation: element => { try { return dom.nodeLocation(element); } catch { return null; } } });
  const read = new Set([entry]);
  const scriptSources = [];
  const remote = new Set(remoteScriptUrls(plan));
  // text/babel and text/jsx scripts: source code the page's Babel compiles (compiled here after the vendors resolve)
  const babelSources = [];
  // local files the entry names that the folder does not have: a text/babel script (the page's Babel would fetch it and throw)
  // and a stylesheet (the page would render without it): each one refuses, named, never skipped in silence
  const missing = [];
  for (const item of plan.filter(entryItem => entryItem.kind === 'babel')) {
    const local = item.local != null ? aliases[item.local] ?? item.local : null;
    if (local != null && files.includes(local)) { read.add(local); babelSources.push({ file: item.local, read: local, text: fs.readFileSync(path.join(root, local), 'utf8') }); }
    else if (local != null) missing.push({ kind: 'script', file: item.local });
    else if (item.text != null) babelSources.push({ file: entry, text: item.text, line: item.line ?? 1 });
  }
  // the app script a version replaces: the last local script the entry loads (babel or classic)
  const appScript = [...plan].reverse().find(item => (item.kind === 'babel' || item.kind === 'classic') && item.local != null && files.includes(item.local))?.local ?? null;
  let importMap = null;
  for (const item of plan.filter(entryItem => entryItem.kind === 'importmap')) { try { importMap = JSON.parse(item.text); } catch { /* reported by the child */ } }
  const moduleQueue = [];
  for (const item of plan) {
    if (item.kind !== 'classic' && item.kind !== 'module') continue;
    if (item.local != null && files.includes(item.local)) { read.add(item.local); scriptSources.push({ file: item.local, text: fs.readFileSync(path.join(root, item.local), 'utf8') }); if (item.kind === 'module') moduleQueue.push(item.local); }
    else if (item.text != null) { scriptSources.push({ file: entry, text: item.text }); if (item.kind === 'module') moduleQueue.push({ inline: item.text }); }
  }
  // Static module graph: relative imports inside source, remote imports to the vendor list.
  const acorn = require('acorn');
  const seen = new Set();
  while (moduleQueue.length) {
    const current = moduleQueue.shift();
    const text = typeof current === 'string' ? fs.readFileSync(path.join(root, current), 'utf8') : current.inline;
    const base = ORIGIN + '/' + (typeof current === 'string' ? current : entry);
    let ast;
    try { ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module' }); } catch { continue; }
    const specifiers = [];
    for (const node of ast.body) if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) specifiers.push(node.source.value);
    for (const specifier of specifiers) {
      const mapped = importMap?.imports?.[specifier];
      const target = mapped ?? (/^(\.{0,2}\/|https?:)/.test(specifier) ? specifier : null);
      if (!target) continue;
      const url = new URL(target, base).href;
      const relative = localPath(url);
      if (relative != null) { if (files.includes(relative) && !seen.has(relative)) { seen.add(relative); read.add(relative); scriptSources.push({ file: relative, text: fs.readFileSync(path.join(root, relative), 'utf8') }); moduleQueue.push(relative); } }
      else if (/^https?:/.test(url)) remote.add(url);
    }
  }
  for (const link of document.querySelectorAll('link[rel~="stylesheet"][href]')) {
    let relative = null;
    try { relative = localPath(new URL(link.getAttribute('href'), document.URL).href); } catch { relative = null; }
    if (relative != null && files.includes(relative)) read.add(relative);
    else if (relative != null && !link.hasAttribute('disabled')) missing.push({ kind: 'stylesheet', file: relative });
  }
  const readme = files.find(name => /^readme[^/]*\.md$/i.test(name));
  if (readme) read.add(readme);
  dom.window.close();
  const classicFiles = plan.filter(item => item.kind === 'classic' && item.local != null && files.includes(item.local)).map(item => item.local);
  // the Babel the page loads (standalone build): the static scan compiles the text/babel scripts with the same one
  const babelUrl = babelSources.length ? remoteScriptUrls(plan).find(url => /babel(?:-standalone|\/standalone)?(?:@[^/]*)?\/(?:babel(?:\.min)?\.js)?$|@babel\/standalone/i.test(url)) ?? null : null;
  const babelLocal = babelSources.length ? plan.find(item => item.kind === 'classic' && item.local != null && /babel(\.min)?\.js$/i.test(item.local))?.local ?? null : null;
  // the integrity (SRI) each CDN script of the page pins: the vendor resolution never runs other bytes
  const integrity = Object.fromEntries(plan.filter(item => item.url && item.remote && item.element?.getAttribute?.('integrity')).map(item => [item.url, item.element.getAttribute('integrity')]));
  return { read, scriptSources, remote: [...remote], readme, title: document.title, classicFiles, babelSources, babelUrl, babelLocal, appScript, integrity, missing };
}

// The files of the folder whose names are close to a missing one (same extension; case, accents or a few letters apart):
// the refusal names them, the closest first.
const plainName = name => String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = keep; }
  }
  return row[b.length];
}
export function similarFiles(wanted, files) {
  const ext = path.posix.extname(wanted).toLowerCase();
  const target = plainName(wanted);
  const limit = Math.max(2, Math.floor(target.length / 4));
  return files.filter(name => path.posix.extname(name).toLowerCase() === ext && name !== wanted)
    .map(name => ({ name, distance: Math.min(editDistance(plainName(name), target), editDistance(plainName(path.posix.basename(name)), plainName(path.posix.basename(wanted))) + (path.posix.dirname(name) === path.posix.dirname(wanted) ? 0 : 1)) }))
    .filter(item => item.distance <= limit).sort((a, b) => a.distance - b.distance || (a.name < b.name ? -1 : 1)).map(item => item.name);
}

function missingProblems(missing, files, pointer) {
  return missing.map(item => {
    const near = similarFiles(item.file, files);
    return { code: 'PROTOTYPE_RENDER_FAILED', path: pointer,
      message: item.kind + ' ' + item.file + ' does not exist in source' + (near.length ? '; the folder has ' + near.slice(0, 3).join(', ') : '') + ' (the page refers to it and would render without it)',
      fix: 'The page refers to a file the prototype does not have' + (near.length ? ' (a similar name is there: ' + near[0] + ')' : '') + ': the owner adds the file or corrects the reference in the prototype; nothing in the call resolves it.',
      ...(near.length ? { alternatives: near.slice(0, 8) } : {}) };
  });
}

function clockFrom(root, names) {
  let newest = 0;
  for (const name of names) { try { newest = Math.max(newest, fs.statSync(path.join(root, name)).mtimeMs); } catch { /* gone */ } }
  return new Date(Math.floor(newest / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

// ---- IR assembly ----------------------------------------------------------------------------------------------------

function nodeAt(body, path) { let node = body; for (const index of path ?? []) { node = node?.c?.[index]; if (!node) return null; } return node; }

const INTERNAL_KEYS = new Set(['node', 'path', 'region', 'row', 'selectors', 'weak', 'self', 'title', 'classAttr', 'template', 'sourceState', 'rows', 'delta', 'to']);

// A value of an effect: the first alternative (mergeVariants already put the consistent one first), internal fields out.
function cleanValue(value) {
  if (Array.isArray(value)) return value.length ? cleanValue(value[0]) : null;
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (INTERNAL_KEYS.has(key)) continue;
    if (['a', 'add', 'mul', 'cases', 'fields', 'rules'].includes(key) && Array.isArray(item)) { out[key] = item.map(entry => entry && typeof entry === 'object' ? cleanValue(entry) : entry); continue; }
    out[key] = item && typeof item === 'object' ? cleanValue(item) : item;
  }
  return out;
}

function cleanEffect(effect) {
  const out = { kind: effect.kind };
  for (const [key, value] of Object.entries(effect)) {
    if (key === 'kind') continue;
    if (key === 'from' && !(effect.kind === 'insertFrom' || effect.kind === 'updateFrom')) continue;
    if (INTERNAL_KEYS.has(key)) continue;
    if (key === 'fields') { out.fields = Object.fromEntries(Object.entries(value).map(([name, val]) => [name, cleanValue(val)])); continue; }
    if (key === 'inputs' || key === 'params' || key === 'keys') { out[key] = Object.fromEntries(Object.entries(value ?? {}).map(([name, val]) => [name, cleanValue(val)])); continue; }
    if (key === 'value' || key === 'by' || key === 'key' || key === 'text') { out[key] = cleanValue(value); continue; }
    out[key] = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
  }
  return out;
}

// Values of every dimension (global and screen) in a state: the assigned ones, the initial value of the others.
function dimsFor(dims, state) {
  return Object.fromEntries(dims.map(dim => [dim.key, state?.assign && dim.key in state.assign ? String(state.assign[dim.key]) : String(dim.initial ?? '')]));
}

// The record a screen or popup parameter selects: the collection whose key has the value (the opener's list first).
function paramRecord(meta, state, value, preferred) {
  if (value == null) return null;
  const candidates = [preferred, ...meta.collections.map(collection => collection.name)].filter(Boolean);
  for (const name of [...new Set(candidates)]) {
    const collection = meta.byName.get(name);
    if (!collection || collection.key === '#') continue;
    const row = (state[name] ?? collection.rows).find(item => String(item[collection.key]) === String(value));
    if (row) return { collection: name, row };
  }
  return null;
}

function recordSources(record, meta, state, prefix = 'record:') {
  if (!record) return {};
  const usable = value => value !== null && value !== undefined && typeof value !== 'boolean';
  const out = Object.fromEntries(Object.entries(record.row).filter(([, value]) => usable(value)).map(([field, value]) => [prefix + record.collection + '.' + field, value]));
  for (const reference of meta?.byName.get(record.collection)?.references ?? []) {
    const target = meta.byName.get(reference.collection);
    if (!target || target.key === '#') continue;
    const other = (state?.[reference.collection] ?? target.rows).find(item => String(item[target.key]) === String(record.row[reference.field]));
    for (const [field, value] of Object.entries(other ?? {})) if (field !== target.key && usable(value)) out[prefix + record.collection + '.' + reference.field + '>' + field] = value;
  }
  return out;
}

function listKeysIn(items, list) {
  if (!items) return null;
  if (!list.keySlot) return null;
  const out = [];
  for (const item of items) {
    let value = null;
    walk(item, node => { if (value !== null) return false; if (isElement(node) && node.t === list.keySlot.node.t && attr(node, list.keySlot.attr) != null) value = attr(node, list.keySlot.attr); });
    if (value !== null) out.push(list.keySlot.fmt === 'suffix' ? (String(value).match(/(\d+)$/) ?? [])[1] : value);
  }
  return out;
}

// Per-dimension filter and order of a list from the renders of each dimension value (2.8).
function dimensionFilters(data, entries, meta, interactions) {
  const list = data.list;
  const key = meta.key(list.collection);
  const baseKeys = listKeysIn(data.perTree[0], list);
  if (!baseKeys) return { filters: [], sortBy: null, unexplained: [] };
  const filters = [], unexplained = [];
  let sortBy = null;
  const byDim = new Map();
  entries.forEach((entry, index) => { if (entry.dim) { if (!byDim.has(entry.dim)) byDim.set(entry.dim, []); byDim.get(entry.dim).push({ entry, index }); } });
  for (const [dimKey, items] of byDim) {
    const dim = interactions.dims.find(item => item.key === dimKey);
    if (!dim) continue;
    const state = meta.state(entries[0].render);
    const rows = state[list.collection] ?? [];
    const baseRows = baseKeys.map(value => rows.find(row => String(row[key]) === String(value))).filter(Boolean);
    const observed = items.map(({ entry, index }) => ({ value: entry.dims[dimKey], keys: (listKeysIn(data.perTree[index], list) ?? []).map(String) }));
    const sameSets = observed.every(item => item.keys.length === baseKeys.length && [...item.keys].sort().join() === baseKeys.map(String).sort().join());
    if (sameSets) {
      if (!observed.some(item => item.keys.join() !== baseKeys.map(String).join())) continue;
      const cases = observed.map(item => ({ value: item.value, sort: listSort(meta, state, list.collection, item.keys.map(value => rows.find(row => String(row[key]) === value)).filter(Boolean)) ?? null }));
      sortBy = { dimension: dimKey, initial: dim.initial, cases };
      continue;
    }
    if (dim.kind === 'text') {
      const search = interactions.searches?.get(dimKey);
      if (search?.fields?.length) { filters.push({ op: 'or', a: [{ op: 'eq', l: { dim: dimKey }, r: { lit: '' } }, { op: 'contains', fields: search.fields.map(field => ({ field })), r: { dim: dimKey } }] }); continue; }
      unexplained.push({ dimension: dimKey, kind: 'filter' });
      continue;
    }
    const record = meta.byName.get(list.collection);
    let found = null;
    for (const field of record.fields.filter(item => item.name !== key)) {
      const ok = observed.every(item => {
        const expected = String(item.value) === String(dim.initial) ? baseRows : baseRows.filter(row => String(row[field.name]) === String(item.value));
        return expected.length === item.keys.length && expected.every(row => item.keys.includes(String(row[key])));
      });
      if (ok) { found = { op: 'or', a: [{ op: 'eq', l: { dim: dimKey }, r: { lit: dim.initial } }, { op: 'eq', l: { field: field.name }, r: { dim: dimKey } }] }; break; }
    }
    if (!found && dim.type === 'Boolean') {
      const on = observed.find(item => String(item.value) !== String(dim.initial));
      if (on) {
        const present = baseRows.filter(row => on.keys.includes(String(row[key])));
        const absent = baseRows.filter(row => !present.includes(row));
        const pred = separate({ fields: record.fields.filter(item => item.name !== key && item.type !== 'Text' && item.type !== 'DateTime').map(item => ({ name: item.name, type: item.type })) }, present.map(row => ({ row })), absent.map(row => ({ row })), { maxTerms: 1 });
        if (pred) found = { op: 'or', a: [{ op: 'eq', l: { dim: dimKey }, r: { lit: dim.initial } }, pred] };
      }
    }
    if (!found) {
      // One field predicate per value of the dimension (e.g. all / active / inactive over a boolean field).
      const parts = [];
      let ok = true;
      for (const item of observed) {
        if (String(item.value) === String(dim.initial)) { if (item.keys.length !== baseRows.length) ok = false; continue; }
        const present = baseRows.filter(row => item.keys.includes(String(row[key])));
        const absent = baseRows.filter(row => !present.includes(row));
        const pred = separate({ fields: record.fields.filter(field => field.name !== key && field.type !== 'Text' && field.type !== 'DateTime').map(field => ({ name: field.name, type: field.type })) }, present.map(row => ({ row })), absent.map(row => ({ row })), { maxTerms: 1 });
        if (!pred) { ok = false; break; }
        parts.push({ op: 'and', a: [{ op: 'eq', l: { dim: dimKey }, r: { lit: item.value } }, pred] });
      }
      if (ok && parts.length) found = [{ op: 'eq', l: { dim: dimKey }, r: { lit: dim.initial } }, ...parts].reduceRight((rest, term) => rest ? { op: 'or', a: [term, rest] } : term, null);
    }
    if (found) filters.push(found); else unexplained.push({ dimension: dimKey, kind: 'filter' });
  }
  return { filters, sortBy, unexplained };
}

// The column titles of the table whose body a list of rows fills (the th cells of its head), or null.
function tableHeaders(root, listParent) {
  if (!root || !listParent || listParent.t !== 'tbody') return null;
  let table = null;
  walk(root, node => { if (table) return false; if (isElement(node) && node.t === 'table' && (node.c ?? []).includes(listParent)) table = node; });
  let head = null;
  if (table) walk(table, node => { if (head || node === listParent) return false; if (isElement(node) && node.t === 'tr' && (node.c ?? []).some(cell => isElement(cell) && cell.t === 'th')) head = node; });
  return head ? head.c.filter(isElement).map(cell => textOf(cell).replace(/\s+/g, ' ').trim()) : null;
}

function finalizeLists(root, region, entries, meta, interactions, warnings, extras = [], naming = null) {
  const ids = new Map();
  walk(root, node => {
    if (!node.listRef) return;
    const data = region.lists.find(item => item.id === node.listRef.run.id);
    const ref = node.listRef;
    delete node.listRef;
    if (!data) return;
    if (data.list.parent.t === 'select') return;
    const list = data.list;
    if (list.snapshot) {
      // Snapshot list (2.8): static entity <Prefix><Screen><List>, one row per rendered item, one attribute per slot.
      const base = (naming?.prefix ?? '') + (naming?.screen ?? '') + (pascal(classes(list.parent)[0] ?? list.parent.t) || 'Lista');
      let entity = base, n = 2;
      while (naming?.taken?.has(entity)) entity = base + n++;
      naming?.taken?.add(entity);
      const wrap = list.mode === 'wrap';
      node.list = {
        collection: null, mode: wrap ? 'wrap' : 'self', at: wrap ? ref.at : undefined, filter: null, sort: [], sortBy: null,
        template: snapshotTemplate(list, node.k + '/*'), items: list.items.length, key: null,
        snapshot: { entity, attributes: list.snapshot.attributes.map(item => ({ name: item.name, type: 'Text' })), rows: list.snapshot.rows }
      };
      ids.set(data.id, node.k);
      if (!wrap && !(node.c ?? []).some(isElement)) delete node.c;
      return;
    }
    list.keyField = meta.key(list.collection);
    const dims = dimensionFilters(data, entries, meta, interactions);
    // the slots read over the items of the renders that show other rows of the same list (the listings of every session: they
    // differ from where it was found only in dimensions its filter reads), each with its row there; a render that changes
    // another dimension (an account that may not buy) changes how the items look, not which rows show, and stays out
    const filterText = JSON.stringify([list.filter ?? null, ...dims.filters]);
    const anchorDims = entries[list.anchor ?? 0]?.dims ?? {};
    const otherRows = i => { const changed = Object.keys({ ...anchorDims, ...(entries[i]?.dims ?? {}) }).filter(key => String(anchorDims[key] ?? '') !== String(entries[i]?.dims?.[key] ?? '')); return changed.length > 0 && changed.every(key => filterText.includes('"dim":"' + key + '"')); };
    const perTree = data.perTree.map((nodes, i) => (i === (list.anchor ?? 0) || otherRows(i) ? nodes : null));
    const pooled = pooledList(list, perTree, entries.map(entry => meta.state(entry.render)), meta, { locale: naming?.locale, tz: naming?.tz });
    const headers = tableHeaders(entries[list.anchor ?? 0]?.render?.body, list.parent);
    const template = listTemplate({ ...list, ...(pooled ?? {}), headers }, node.k + '/*');
    if (template.extraAttributes) { extras.push(...template.extraAttributes); delete template.extraAttributes; }
    ids.set(data.id, node.k);
    const base = list.filter && !list.filter.unexplained ? list.filter : null;
    if (list.filter?.unexplained) warnings.push({ code: 'PrototypeListFilterUnexplained', k: node.k, collection: list.collection });
    for (const item of dims.unexplained) warnings.push({ code: 'PrototypeListDimensionUnexplained', k: node.k, ...item });
    const parts = [base, ...dims.filters].filter(Boolean);
    // the order of the rows the list showed where it was found (a list anchored in a session's render)
    const sort = listSort(meta, meta.state((entries[list.anchor ?? 0] ?? entries[0]).render), list.collection, list.rows);
    const wrap = (list.mode ?? data.list.mode) === 'wrap' || Boolean(list.start);
    node.list = {
      collection: list.collection, mode: wrap ? 'wrap' : 'self', at: wrap ? ref.at : undefined,
      filter: parts.length === 0 ? null : parts.length === 1 ? parts[0] : { op: 'and', a: parts },
      sort: sort ?? [], sortBy: dims.sortBy, template, items: list.items.length,
      key: list.keySlot ? { attr: list.keySlot.attr, field: list.keySlot.via ?? meta.key(list.collection) } : null, snapshot: null
    };
    if (!wrap && !(node.c ?? []).some(isElement)) delete node.c;
  });
  rewriteListRefs(root, ids);
}

function selectorMatcher(event) {
  const selector = String(event.selector ?? '');
  let match;
  if ((match = selector.match(/^\[data-action="([^"]+)"\]$/))) { const value = match[1]; return node => attr(node, 'data-action') === value; }
  if ((match = selector.match(/^#(.+)$/))) { const value = match[1]; return node => attr(node, 'id') === value; }
  if ((match = selector.match(/^\[name=(.+)\]$/))) { const value = match[1]; return node => attr(node, 'name') === value; }
  if ((match = selector.match(/^\[(data-[a-z0-9-]+)\]$/))) { const name = match[1]; return node => attr(node, name) != null; }
  if ((match = selector.match(/^([a-z0-9]+)\[aria-label="([^"]*)"\]$/))) { const [, tag, label] = match; return node => node.t === tag && attr(node, 'aria-label') === label; }
  return null;
}

function regionEvents(region, events, scopeKey) {
  for (const event of events.values()) {
    if (event.scope !== scopeKey) continue;
    const matcher = selectorMatcher(event);
    const tag = event.on === 'submit' ? 'form' : null;
    const mark = node => { if (!isElement(node)) return; if ((!tag || node.t === tag) && matcher?.(node)) node.events = [...new Set([...(node.events ?? []), event.key])]; };
    if (matcher) {
      walk(region.root, node => { mark(node); if (node.list?.template) walk(node.list.template, mark); });
      continue;
    }
    for (const item of event.observations) {
      const node = item.info.variant?.node ?? item.info.control?.node ?? item.info.form?.node;
      const out = node ? region.map.get(node) : null;
      if (out) out.events = [...new Set([...(out.events ?? []), event.key])];
    }
  }
}

function annotateNav(root, views, kind) {
  const routeOf = view => view.template;
  walk(root, node => {
    if (!isElement(node)) return;
    // A control of a section (tab, data-view) navigates to the screen of that section.
    const controls = attr(node, 'aria-controls') ?? attr(node, 'data-view') ?? attr(node, 'data-page') ?? attr(node, 'data-screen');
    if (kind === 'spa-sections' && controls) { const view = views.find(item => item.sectionId === controls || item.key === controls); if (view) node.nav = { view: view.key, params: {} }; return; }
    if (node.t !== 'a') return;
    const href = attr(node, 'href');
    if (kind === 'multi-page' && href && !/^(https?:|mailto:|tel:|#|javascript:)/i.test(href)) {
      const page = href.split('#')[0].split('?')[0].replace(/^\.\//, '');
      const view = views.find(item => item.page === page || item.template === page);
      if (view) node.nav = { view: view.key, params: {} };
      return;
    }
    if (kind === 'spa-sections' && href?.startsWith('#')) {
      const view = views.find(item => item.sectionId === decodeURIComponent(href.slice(1)));
      if (view) node.nav = { view: view.key, params: {} };
      return;
    }
    const expr = node.attrExpr?.href;
    const route = href && href.startsWith('#') ? decodeURIComponent(href.slice(1)) : kind === 'spa-path' ? href : null;
    for (const view of views) {
      const template = routeOf(view);
      if (!template) continue;
      if (expr?.prefix != null && template.includes('{id}') && '#' + template.replace('{id}', '') === expr.prefix) { node.nav = { view: view.key, params: { Id: expr.value } }; return; }
      if (route == null) continue;
      if (template === route || (template.includes('{id}') && new RegExp('^' + template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('\\{id\\}', '[^/]+') + '$').test(route))) {
        const params = {};
        if (template.includes('{id}')) { const value = route.split('/').pop(); params.Id = { lit: /^-?\d+$/.test(value) ? Number(value) : value }; }
        node.nav = { view: view.key, params };
        return;
      }
    }
  });
}

function annotateOptions(root, prefix, controlName) {
  walk(root, node => {
    if (!isElement(node) || node.t !== 'select') return;
    const options = (node.c ?? []).filter(child => isElement(child) && child.t === 'option');
    const conditional = options.filter(option => option.if);
    if (!conditional.length) return;
    const fields = new Set(conditional.map(option => option.if.op === 'eq' && option.if.l?.field ? option.if.l.field : option.if.op === 'or' && option.if.a.every(term => term.op === 'eq' && term.l?.field) ? option.if.a[0].l.field : null));
    if (fields.size !== 1 || fields.has(null)) return;
    const field = [...fields][0];
    const valuesOf = option => !option.if ? null : option.if.op === 'eq' ? [option.if.r.lit] : option.if.a.map(term => term.r.lit);
    const keys = [...new Set(conditional.flatMap(valuesOf))].sort((a, b) => Number(a) - Number(b));
    const rows = [];
    for (const key of keys) {
      let order = 0;
      for (const option of options) {
        const keysOfOption = valuesOf(option);
        if (keysOfOption && !keysOfOption.map(String).includes(String(key))) continue;
        order++;
        rows.push({ Chave: key, Value: attr(option, 'value') ?? textOf(option), Label: textOf(option), Ordem: order });
      }
    }
    const name = controlName(node);
    node.options = { entity: prefix + name + 'Opcao', by: { field }, rows };
  });
}

// Options of a select (2.8): all correlated with a collection -> the collection; constant + collection -> a snapshot
// options entity; options that vary with a field of the screen/popup record -> an options entity keyed by that field.
function annotateSelects(region, contexts, meta, prefix, nameFor) {
  const optionRows = nodes => nodes.filter(node => isElement(node) && node.t === 'option').map(node => ({ Value: attr(node, 'value') ?? textOf(node), Label: textOf(node) }));
  for (const data of region.lists) {
    const list = data.list;
    if (list.parent.t !== 'select') continue;
    const out = region.map.get(list.parent);
    if (!out) continue;
    const constants = (list.constant ?? []).map(item => item.node);
    // the options in the order the select shows them: the constant option before the correlated ones when it is the first
    // ("Todos" + the categories), after them when it is the last
    const constantFirst = (list.start ?? 0) === 1;
    const perContext = contexts.map((_, index) => data.perTree[index] ? optionRows(constantFirst ? [...constants, ...data.perTree[index]] : [...data.perTree[index], ...constants]) : null);
    const sets = perContext.map(rows => rows ? rows.map(row => row.Value).join('|') : null);
    const name = nameFor(list.parent);
    const collection = meta.byName.get(list.collection);
    const labelField = collection.fields.find(field => field.type === 'Text' && list.rows.every((row, i) => textOf(list.items[i].node).trim() === String(row[field.name] ?? '').trim()))?.name ?? null;
    if (sets.every(set => set === null || set === sets[0])) {
      const allRows = (meta.state ? null : null) ?? collection.rows;
      if (!constants.length && labelField && list.rows.length === allRows.length) out.options = { source: { collection: list.collection, value: collection.key, label: labelField } };
      else out.options = { entity: prefix + name + 'Opcao', rows: perContext[0].map((row, i) => ({ ...row, Ordem: i + 1 })), snapshot: true };
    } else {
      let field = null, best = Infinity;
      const recordCollection = meta.collections.find(entry => contexts[0].row && entry.rows.some(row => canonical(row) === canonical(contexts[0].row)));
      const rowFields = contexts[0].row ? Object.keys(contexts[0].row).filter(name => name !== recordCollection?.key) : [];
      for (const candidate of rowFields) {
        const map = new Map();
        let ok = true;
        contexts.forEach((context, index) => {
          if (!ok || !perContext[index] || !context.row) return;
          const key = String(context.row[candidate]);
          if (map.has(key) && map.get(key) !== sets[index]) ok = false;
          map.set(key, sets[index]);
        });
        if (ok && map.size > 1 && map.size < best) { field = candidate; best = map.size; }
      }
      if (field) {
        const rows = [];
        const seen = new Set();
        contexts.forEach((context, index) => {
          if (!perContext[index] || !context.row) return;
          const key = context.row[field];
          if (seen.has(String(key))) return;
          seen.add(String(key));
          perContext[index].forEach((row, i) => rows.push({ Chave: key, ...row, Ordem: i + 1 }));
        });
        rows.sort((a, b) => (Number(a.Chave) - Number(b.Chave)) || (a.Ordem - b.Ordem));
        out.options = { entity: prefix + name + 'Opcao', by: { field }, rows };
      } else out.options = { entity: prefix + name + 'Opcao', rows: perContext[0].map((row, i) => ({ ...row, Ordem: i + 1 })), snapshot: true };
    }
    delete out.list;
    delete out.listRef;
    delete out.c;
  }
}

// A control the capture named by its id, or (no id, name nor data-* to name it: VisitaCerta's selects of 2026-10-12) by its
// tag and its place under the region root (select@1.0.1 is v:<view>/1/0/1), which is how its dimension was keyed.
function annotateControls(region, dims, keyPrefix = null) {
  for (const dim of dims) {
    const at = !dim.target?.id && keyPrefix ? /^([a-z]+)@([\d.]*)$/.exec(String(dim.controlKey ?? dim.key ?? '')) : null;
    if (!dim.target?.id && !at) continue;
    const placeKey = at ? keyPrefix + (at[2] ? '/' + at[2].split('.').join('/') : '') : null;
    for (const [original, out] of region.map) {
      if (!isElement(original) || !['input', 'select', 'textarea'].includes(original.t)) continue;
      if (at ? original.t !== at[1] || out?.k !== placeKey : attr(original, 'id') !== dim.target.id) continue;
      out.control = { kind: original.t === 'select' ? 'select' : original.t === 'textarea' ? 'textarea' : String(attr(original, 'type') ?? 'text'), var: dim.name, dimension: dim.key, initial: dim.initial == null ? null : String(dim.initial), type: dim.type ?? 'Text' };
      break;
    }
  }
}

// The page of an explored state, keyed by region: s:app/... for the app root, v:<view>/... inside the mount,
// s:<sibling>, m:<modal>/... inside an open modal; closed modal containers are left out.
// The body children of a multi-page view between the shell's prefix and suffix regions (text nodes between them kept).
function pageStretch(body, { prefix, suffix }) {
  const elements = (body.c ?? []).filter(isElement).length;
  let seen = 0;
  const c = (body.c ?? []).filter(child => {
    if (!isElement(child)) return seen > prefix - 1 && seen < elements - suffix;
    const at = seen++;
    return at >= prefix && at < elements - suffix;
  });
  return { ...body, c };
}

function composeExplored(body, { appIndex, mountPath, viewKey, modalKey, modalPath, regionNames, dropHiddenUnder = null, bodyApp = null, multiPage = null }) {
  // a body-level shell has no app root element: its regions are grouped under s:app below
  if (bodyApp?.length) appIndex = null;
  const visit = (node, path, key) => {
    if (!isElement(node)) return { k: key, x: node.x };
    const out = { k: key, t: node.t };
    if (node.a?.length) out.a = node.a.map(pair => [pair[0], pair[1]]);
    if (node.icon) out.icon = node.icon;
    if (node.svg) out.svg = node.svg;
    const kids = [];
    (node.c ?? []).forEach((child, index) => {
      const childPath = path.concat(index);
      const isModal = isModalNode(child);
      if (isModal && (child.h || !modalPath || childPath.join('.') !== modalPath.join('.'))) return;
      if (dropHiddenUnder && path.join('.') === dropHiddenUnder.join('.') && isElement(child) && child.h) return;
      let childKey;
      if (mountPath && childPath.join('.') === mountPath.join('.')) childKey = 'v:' + viewKey;
      else if (modalPath && childPath.join('.') === modalPath.join('.')) childKey = 'm:' + modalKey;
      else if (path.length === 0 && index === appIndex) childKey = 's:app';
      else if (path.length === 0 && regionNames?.[index]) childKey = 's:' + regionNames[index];
      else childKey = key + '/' + index;
      kids.push(visit(child, childPath, childKey));
    });
    if (kids.length) out.c = kids;
    return out;
  };
  const tree = visit(body, [], 'b');
  // Multi-page shell: the shell block (s:body) holds the prefix regions, the page's own children (the native mount is a
  // placeholder the prototype has no element for) and the suffix regions.
  if (multiPage) {
    // the element ordinal of each body child (the prefix and suffix count elements of the page as captured)
    const ordinal = new Map();
    let count = 0;
    (body.c ?? []).forEach((child, index) => { if (isElement(child)) ordinal.set('b/' + index, count++); });
    const app = { k: 's:body', t: 'body', c: [] };
    for (const kid of tree.c ?? []) {
      const at = isElement(kid) ? ordinal.get(kid.k) : undefined;
      if (at !== undefined) {
        const region = at < multiPage.prefix ? multiPage.names[at] : at >= count - multiPage.suffix ? multiPage.names[multiPage.prefix + at - (count - multiPage.suffix)] : null;
        if (region) rekeyTree(kid, kid.k, 's:' + region);
        else if (viewKey) rekeyTree(kid, kid.k, 'v:' + viewKey + '/' + at);
      }
      app.c.push(kid);
    }
    tree.c = [app];
    return tree;
  }
  // Body-level shell: the body children the shell block holds (its regions and the mount) are grouped under s:app, the
  // block root the native page renders (a div.ssam-tag-body), so that the shell compares level by level.
  if (bodyApp?.length) {
    const inApp = new Set(bodyApp.map(index => 'b/' + index).concat(bodyApp.map(index => regionNames?.[index] ? 's:' + regionNames[index] : null)).concat(mountPath?.length === 1 ? ['v:' + viewKey] : []).filter(Boolean));
    const kids = tree.c ?? [];
    const first = kids.findIndex(kid => inApp.has(kid.k));
    if (first >= 0) {
      const app = { k: 's:app', t: 'body', c: kids.filter(kid => inApp.has(kid.k)) };
      tree.c = kids.filter((kid, index) => index < first && !inApp.has(kid.k)).concat([app], kids.filter((kid, index) => index > first && !inApp.has(kid.k)));
    }
  }
  return tree;
}

function rekeyTree(node, from, to) {
  walk(node, current => { if (typeof current.k === 'string' && (current.k === from || current.k.startsWith(from + '/'))) current.k = to + current.k.slice(from.length); });
}

function countContent(node, skipPath = null) {
  let count = 0;
  const visit = (current, path) => {
    for (const [index, child] of (current?.c ?? []).entries()) {
      if (!isElement(child)) continue;
      const childPath = path.concat(index);
      count++;
      if (skipPath && childPath.join('.') === skipPath.join('.')) continue;
      visit(child, childPath);
    }
  };
  visit(node, []);
  return count;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(item => { const key = canonical(item); if (seen.has(key)) return false; seen.add(key); return true; });
}

export function buildIr(session, interactions, { root, entry, clockIso, tz, scan, mapping, vendors, pool, archive = null, aliases = {}, files: allFiles = [] }) {
  const { discovery, meta, records, observations, forms, modals } = interactions;
  const kind = discovery.kind;
  const s0 = session.s0;
  const doc = s0.inspect.document ?? {};
  const lang = doc.lang || 'en';
  const locale = interactions.locale;
  const warnings = [...session.warnings];
  const prefix = mapping.prefix ?? prefixFrom(doc.title, path.basename(root));
  const views = discovery.views;
  const mountPath = discovery.mount ?? null;
  const appIndex = mountPath?.[0] ?? null;
  const globalDims = session.dims.filter(dim => dim.scope === 'global');
  const allDims = interactions.dims;
  const shell = buildShell({ session, interactions, lang, locale, tz });
  if (shell) annotateNav(shell.root, views, kind);
  if (shell) { regionEvents({ map: shell.map, root: shell.root }, records.events, 'shell'); for (const sibling of shell.siblings) regionEvents({ map: shell.map, root: sibling }, records.events, 'shell'); }
  const outViews = [];
  const explored = [];
  const trees = {};
  const unexplained = [...(shell?.unexplained ?? [])];
  const addTree = tree => { const hash = treeHash(tree); trees[hash] = tree; return hash; };
  const regionNames = {};
  const multiPageShape = shell?.multiPage ? { ...shell.multiPage, names: shell.regionInfo.filter(info => info.role === 'region').map(info => info.name) } : null;
  if (shell) for (const info of shell.regionInfo) { if (info.sibling != null) regionNames[info.sibling] = info.name; else if (info.top != null && info.role !== 'mount') regionNames[info.top] = info.name; }
  let elementsTotal = 0;
  const countedTrees = [];
  const extraAttributes = [];
  const snapshotEntities = new Set();
  const defaultView = views.find(view => view.default) ?? views[0];
  if (shell && appIndex != null && mountPath.length >= 2) {
    const appRoot = defaultView.render.body.c[appIndex];
    elementsTotal += countContent(appRoot, mountPath.slice(1));
    const emptyAt = (node, path) => (!path.length ? { ...node, c: [] } : { ...node, c: (node.c ?? []).map((child, index) => index === path[0] ? emptyAt(child, path.slice(1)) : child) });
    countedTrees.push(emptyAt(appRoot, mountPath.slice(1)));
    for (const index of Object.keys(regionNames)) { const sibling = defaultView.render.body.c[index]; elementsTotal += countContent(sibling); countedTrees.push(sibling); }
  } else if (shell?.multiPage) {
    // multi-page shell: its regions once (the pages count only their own stretch)
    const list = (defaultView.render.body.c ?? []).filter(isElement);
    for (const region of list.slice(0, shell.multiPage.prefix).concat(list.slice(list.length - shell.multiPage.suffix))) { elementsTotal += 1 + countContent(region); countedTrees.push(region); }
  } else if (shell?.bodyLevel) {
    // Body-level shell: every region and sibling is a body child (the mount element itself counts once here).
    for (const index of Object.keys(regionNames)) { const region = defaultView.render.body.c[index]; elementsTotal += 1 + countContent(region); countedTrees.push(region); }
    elementsTotal += 1;
  }
  for (const view of views) {
    const viewMount = view.mountPath ?? mountPath ?? [];
    // multi-page: the page without the shell's regions (the common prefix and suffix of the body children)
    const mountOf = body => view.multiPage ? pageStretch(body, view.multiPage) : nodeAt(body, viewMount) ?? body;
    const entries = [{ render: view.render, dims: dimsFor(allDims, view.state), label: 'canonical' }];
    for (const dim of allDims.filter(item => item.view === view.key && item.renders?.size && !item.modal)) {
      for (const [value, render] of dim.renders) entries.push({ render, dims: { ...dimsFor(allDims, view.state), [dim.key]: String(value) }, label: dim.key + '=' + value, dim: dim.key });
    }
    if (kind === 'spa-hash' || kind === 'spa-path') {
      for (const state of discovery.states ?? []) {
        if (state === view.state) continue;
        const render = discovery.renderOf(state, view.route);
        if (render && !discovery.isFallback(state, view.route)) entries.push({ render, dims: dimsFor(allDims, state), label: Object.entries(state.assign ?? {}).map(([key, value]) => key + '=' + value).join('&') || state.key });
      }
    }
    for (const dim of allDims.filter(item => item.kind === 'hidden' && item.view === view.key)) {
      const source = observations.find(item => item.probe.key === dim.setBy);
      const value = source?.effects.find(effect => effect.kind === 'navigate')?.to?.split('/').pop();
      if (source) entries.push({ render: source.after, dims: { ...dimsFor(allDims, view.state), [dim.key]: String(value ?? '1') }, label: dim.key + '=' + (value ?? '1'), hidden: dim.key });
    }
    const paramValue = render => view.params?.length ? String(render.hash ?? '').replace(/^#/, '').split('/').pop() : null;
    const contexts = entries.map(item => ({ view: view.key, dims: item.dims, params: view.params?.length ? { Id: paramValue(item.render) } : {} }));
    const sources = entries.map(item => {
      const state = meta.state(item.render);
      const record = view.params?.length ? paramRecord(meta, state, paramValue(item.render)) : null;
      return { ...recordSources(record, meta, state), ...Object.fromEntries(Object.entries(item.dims).map(([key, value]) => ['dim:' + key, value])) };
    });
    const viewDims = [...globalDims, ...allDims.filter(item => item.view === view.key && !item.modal)];
    const vars = { dims: viewDims.map(dim => ({ key: dim.key, zero: dim.initial, hidden: dim.kind === 'hidden', free: dim.kind === 'text' })), params: view.params?.map(param => param.name) ?? [] };
    const listContext = { params: view.params?.length ? { Id: paramValue(view.render) } : {}, dims: globalDims.map(dim => ({ key: dim.key, value: String(view.state.assign?.[dim.key] ?? dim.initial), collection: dim.collection })) };
    const region = annotateRegion({ trees: entries.map(item => mountOf(item.render.body)), contexts, sources, vars, meta, states: entries.map(item => meta.state(item.render)), locale, tz, keyPrefix: 'v:' + view.key, listContext, constantSources: ['record:'] });
    finalizeLists(region.root, region, entries, meta, interactions, warnings, extraAttributes, { prefix, screen: view.name, taken: snapshotEntities, locale, tz });
    regionEvents(region, records.events, view.key);
    annotateNav(region.root, views, kind);
    annotateControls(region, allDims.filter(dim => (dim.view === view.key && !dim.modal) || dim.scope === 'global'), 'v:' + view.key);
    annotateSelects(region, contexts, meta, prefix, node => pascal(attr(node, 'id') ?? attr(node, 'name') ?? 'Select'));
    annotateOptions(region.root, prefix, node => pascal(attr(node, 'id') ?? attr(node, 'name') ?? 'Select'));
    unexplained.push(...region.unexplained);
    const count = countContent(mountOf(view.render.body));
    elementsTotal += count;
    countedTrees.push(mountOf(view.render.body));
    outViews.push({
      key: view.key, route: kind === 'spa-hash' ? '#' + view.route : view.route, template: view.template, params: view.params ?? [], name: view.name,
      nameSource: view.nameSource, default: Boolean(view.default), state: { ...(view.state.assign ?? {}) }, root: region.root, elements: count,
      // a section of a spa-sections page is an element inside the shell's mount: the screen keeps it (its classes, its padding)
      ...(discovery.sectionParent && shell ? { keepRoot: true } : {})
    });
    for (const item of entries) {
      const tree = composeExplored(item.render.body, { appIndex, mountPath: viewMount.length ? viewMount : null, viewKey: view.key, regionNames, dropHiddenUnder: discovery.sectionParent ?? null, bodyApp: shell?.bodyLevel ? shell.top : null, multiPage: multiPageShape });
      const assign = item.label === 'canonical' ? {} : item.hidden ? { [item.hidden]: item.dims[item.hidden] } : item.dim ? { [item.dim]: item.dims[item.dim] } : Object.fromEntries(Object.entries(item.dims).filter(([key, value]) => globalDims.some(dim => dim.key === key && String(dim.initial ?? '') !== String(value))));
      explored.push({ id: 'v:' + view.key + '@' + (item.label === 'canonical' ? 'canonical' : item.label), view: view.key, assign, tree: addTree(tree) });
    }
  }
  const outModals = [];
  for (const kindInfo of modals) {
    const openings = observations.filter(item => item.effects.some(effect => effect.kind === 'openPopup' && effect.modal === kindInfo.key));
    const ordered = [kindInfo.first.item, ...openings.filter(item => item !== kindInfo.first.item)];
    const modalPath = kindInfo.first.modal.path;
    const containers = ordered.map(item => nodeAt(item.after.body, item.effects.find(effect => effect.kind === 'openPopup').path));
    const states = ordered.map(item => meta.state(item.after));
    const recordsOf = ordered.map((item, index) => {
      const value = Object.values(item.info.variant?.params ?? {})[0];
      const found = item.info.variant ? interactions.recordOf(item.info.view, item.info.variant) : null;
      return paramRecord(meta, states[index], value, found?.collection);
    });
    const contexts = ordered.map((item, index) => ({ view: item.info.view?.key, dims: { ...dimsFor(allDims, item.info.state) }, params: { ...(item.info.variant?.params ?? {}) }, row: recordsOf[index]?.row ?? null }));
    const sources = ordered.map((item, index) => ({ ...recordSources(recordsOf[index], meta, states[index]), ...Object.fromEntries(Object.entries(contexts[index].dims).map(([key, value]) => ['dim:' + key, value])) }));
    const collection = recordsOf.find(Boolean)?.collection;
    const fieldsVars = collection ? fieldVars(meta, collection, meta.byName.get(collection).rows) : [];
    const vars = { dims: [...globalDims, ...allDims.filter(dim => dim.modal === kindInfo.key)].map(dim => ({ key: dim.key, zero: dim.initial, free: dim.kind === 'text' })), fields: fieldsVars, params: kindInfo.params.map(param => param.name) };
    const region = annotateRegion({ trees: containers, contexts, sources, vars, meta, states, locale, tz, keyPrefix: 'm:' + kindInfo.key, listContext: {}, constantSources: [] });
    finalizeLists(region.root, region, ordered.map(item => ({ render: item.after, dims: {} })), meta, interactions, warnings, extraAttributes, { prefix, screen: kindInfo.name, taken: snapshotEntities, locale, tz });
    regionEvents(region, records.events, kindInfo.key);
    // its own dimensions, and a global one whose control lives in the modal (the account chosen in a login dialog)
    annotateControls(region, allDims.filter(dim => dim.modal === kindInfo.key || dim.scope === 'global'), 'm:' + kindInfo.key);
    annotateSelects(region, contexts, meta, prefix, node => pascal(attr(node, 'id') ?? attr(node, 'name') ?? 'Select'));
    annotateOptions(region.root, prefix, node => pascal(attr(node, 'id') ?? attr(node, 'name') ?? 'Select'));
    unexplained.push(...region.unexplained);
    const count = countContent(containers[0]);
    elementsTotal += count;
    countedTrees.push(containers[0]);
    outModals.push({
      // a container that is a child of the body (a React portal, a dialog at the end of the page): the popup sits beside the shell
      ...(Array.isArray(modalPath) && modalPath.length === 1 ? { portal: true } : {}),
      key: kindInfo.key, name: kindInfo.name, container: kindInfo.container, openedFrom: kindInfo.openedFrom.map(item => ({ view: item.view, event: item.event, modal: item.modal ?? undefined })),
      params: kindInfo.params, screens: kindInfo.screens, record: collection ?? null, root: region.root, elements: count
    });
    const first = kindInfo.first.item;
    const tree = composeExplored(first.after.body, { appIndex, mountPath: first.info.view?.mountPath ?? mountPath, viewKey: first.info.view?.key, modalKey: kindInfo.key, modalPath, regionNames, dropHiddenUnder: discovery.sectionParent ?? null, bodyApp: shell?.bodyLevel ? shell.top : null, multiPage: multiPageShape });
    // the state the modal was opened in (a login modal opens for the visitor): its assignment, as text like every other state's
    const openedIn = Object.fromEntries(Object.entries(first.info.state?.assign ?? {}).map(([key, value]) => [key, String(value)]));
    explored.push({ id: 'm:' + kindInfo.key + '@canonical', view: first.info.view?.key, modal: kindInfo.key, assign: openedIn, tree: addTree(tree) });
  }
  const outEvents = [];
  const formByKey = new Map(forms.map(form => [form.key, form]));
  const mutated = new Set();
  const notCompiledAll = [];
  for (const event of records.events.values()) {
    const items = event.observations.filter(item => item.context && !(item.info.type === 'submit' && item.info.phase === 'valid' && !item.effects.length && event.observations.some(other => other !== item && other.effects.length)));
    if (!items.length) continue;
    if (items.every(item => !item.effects.length)) {
      // The page changed and no effect of the closed class explains it (a list kept only in a script variable): the
      // event is kept, not compiled, so that the receipt names it instead of dropping it.
      const changed = items.filter(item => item.ui);
      if (changed.length) {
        const notCompiled = [{ why: 'a interface mudou sem efeito da classe fechada (estado só em variável do script)', handler: event.handler }];
        notCompiledAll.push(...notCompiled.map(item => ({ event: event.key, ...item })));
        outEvents.push({ key: event.key, view: event.scope, selector: event.selector, on: event.on, params: [], effects: [], when: null, handler: event.handler, compiled: false, notCompiled });
      }
      continue;
    }
    const params = (event.params ?? []).map(param => ({ name: param.name, from: param.from, type: items.every(item => /^-?\d+$/.test(String(item.context.params?.[param.name] ?? ''))) ? 'Integer' : 'Text' }));
    const rowItem = items.find(item => item.context.row);
    const rowCollection = rowItem ? meta.collections.find(entry => entry.rows.some(row => canonical(row) === canonical(rowItem.context.row))) : null;
    const vars = {
      dims: [...new Set(items.flatMap(item => Object.keys(item.context.dims ?? {})))].map(key => ({ key, zero: allDims.find(dim => dim.key === key)?.initial, free: allDims.find(dim => dim.key === key)?.kind === 'text' })),
      params: params.map(param => param.name),
      view: event.scope === 'shell',
      controls: [...new Set(items.flatMap(item => Object.keys(item.context.controls ?? {})))],
      fields: rowCollection ? fieldVars(meta, rowCollection.name, rowCollection.rows) : []
    };
    const withEffects = items.filter(item => item.effects.length);
    const assembled = eventCases(withEffects, vars);
    const residues = items.flatMap(item => item.residue ?? []);
    const form = formByKey.get(event.key);
    const validate = form?.rules?.length ? { kind: 'validate', rules: form.rules.map(rule => ({ control: rule.control, constraint: rule.constraint, when: rule.when, message: rule.message, target: rule.target ? { kind: rule.target.kind, id: rule.target.id ?? null } : null })) } : null;
    const kindParams = new Map(modals.map(modal => [modal.key, new Set(modal.params.map(param => param.name))]));
    const fixInputs = effect => effect.kind === 'openPopup' ? { ...effect, inputs: Object.fromEntries(Object.entries(effect.inputs ?? {}).filter(([name]) => kindParams.get(effect.modal)?.has(name))) } : effect;
    const assembledCases = assembled.cases.map(entry => ({ when: entry.when, effects: [...(validate ? [validate] : []), ...sortEffects(entry.effects.map(cleanEffect).map(fixInputs).filter(effect => !(effect.kind === 'navigate' && effect.view == null)))] }));
    // A click that adds the record when it is not there and removes it when it is (a favorite): one membership toggle,
    // whatever field happened to separate the items observed in each case.
    const toggled = membershipToggle(assembledCases, meta);
    const finalCases = toggled ? [{ when: null, effects: toggled }] : assembledCases;
    for (const entry of finalCases) for (const effect of entry.effects) if (effect.collection && ['insert', 'insertFrom', 'updateFrom', 'removeWhere', 'update', 'toggle', 'increment', 'upsert', 'remove'].includes(effect.kind)) mutated.add(effect.collection);
    const main = finalCases[finalCases.length - 1];
    const notCompiled = residues.map(residue => ({ ...JSON.parse(JSON.stringify(residue)), handler: event.handler }));
    if (!assembled.separated) notCompiled.push({ why: 'efeitos diferentes por estado sem predicado que os separe', signatures: assembled.groups, handler: event.handler });
    notCompiledAll.push(...notCompiled.map(item => ({ event: event.key, ...item })));
    const out = { key: event.key, view: event.scope, selector: event.selector, on: event.on, params, effects: main.effects, when: null, handler: event.handler, compiled: notCompiled.length === 0 };
    if (finalCases.length > 1) out.cases = finalCases.slice(0, -1);
    if (notCompiled.length) out.notCompiled = notCompiled;
    outEvents.push(out);
  }
  const outDims = allDims.map(dim => ({
    key: dim.key, name: dim.name, kind: dim.kind ?? 'control', control: dim.target?.id ? '#' + dim.target.id : dim.match ? dim.match.t + '[data-action="' + dim.key + '"]' : dim.controlKey ?? null,
    event: dim.kind === 'text' ? 'input' : dim.kind === 'trigger' || dim.kind === 'toggle' ? 'click' : dim.kind === 'hidden' ? null : 'change',
    type: dim.type ?? 'Text', values: (dim.values ?? []).map(String), initial: dim.initial == null ? null : String(dim.initial), scope: dim.scope ?? 'view',
    view: dim.view ?? null, modal: dim.modal ?? null, collection: dim.collection ?? null
  }));
  const storeInfo = s0.inspect.store ?? {};
  // a store taken from configuration lists says so, with each list's role and the alternative (2.7, never silent)
  if (Array.isArray(storeInfo.configuration) && storeInfo.configuration.length)
    warnings.push({ code: 'PrototypeStoreFromConfiguration', lists: storeInfo.configuration.map(item => ({ value: item.value, collection: item.collection, role: item.role })),
      alternatives: [{ value: 'none', role: 'mapping.data "none": no store; every list stays as rendered (snapshot entities) and the module\'s own actions bring the data' }] });
  const store = {
    source: storeInfo.source ?? null,
    ...(Array.isArray(storeInfo.configuration) && storeInfo.configuration.length ? { configuration: storeInfo.configuration.map(item => ({ value: item.value, collection: item.collection, rows: item.rows, role: item.role })) } : {}),
    collections: meta.collections.map(collection => ({
      name: collection.name, key: collection.key, mutated: mutated.has(collection.name), fields: collection.fields, references: collection.references, rows: collection.rows,
      origin: meta.extraNames.includes(collection.name) ? 'array:' + ((s0.inspect.arrays ?? []).find(array => array.name === collection.name)?.path ?? collection.name) : 'store'
    }))
  };
  const readText = relative => { try { return fs.readFileSync(path.join(root, relative), 'utf8'); } catch { return null; } };
  const readBytes = relative => { try { return fs.readFileSync(path.join(root, relative)); } catch { return null; } };
  const sheets = kind === 'multi-page' ? pageSheets(views, session, readText) : inventory({ sheets: s0.inspect.sheets ?? [], runtimeStyles: session.runtimeStyles, readText });
  const exploredTrees = Object.values(trees);
  const assets = collectAssets({ sheets, trees: exploredTrees, readBytes });
  const instances = iconInstances(countedTrees);
  const allInstances = iconInstances(exploredTrees);
  const icons = iconSet(session.iconSvg, instances, [...new Set(allInstances.map(icon => icon.name))]);
  const read = new Set([...scan.read, ...session.read, ...assets.map(asset => asset.path)]);
  const files = [...read].sort().map(relative => { const data = readBytes(relative); return data ? { path: relative, bytes: data.length, sha256: sha256(data) } : null; }).filter(Boolean);
  const unreferenced = allFiles.filter(name => /\.(jsx|tsx|js|mjs|ts|html?)$/i.test(name) && !read.has(name) && !Object.values(aliases).includes(name)).sort();
  const outOfScope = dedupe(records.outOfScope
    .concat(warnings.filter(item => item.code === 'PrototypeTimerSkipped' || item.code === 'PrototypeIntervalSkipped').map(item => ({ what: item.code === 'PrototypeTimerSkipped' ? 'timer de ' + item.delay + ' ms' : 'setInterval', where: item.where, why: 'sem timer de cliente nativo sem JS' })))
    .concat((s0.inspect.listeners ?? []).filter(item => ['keydown', 'keyup', 'keypress', 'error', 'focus', 'blur', 'scroll', 'resize'].includes(item.type) && item.handler).map(item => ({ what: 'listener de ' + item.type, where: item.handler.file + ':' + item.handler.line, why: item.type.startsWith('key') ? 'teclado programático que repete o clique' : 'comportamento de navegador sem equivalente nativo' }))));
  const ir = {
    schema: SCHEMA, clock: clockIso, tz,
    engine: { name: 'jsdom', version: JSDOM_VERSION, node: process.version },
    source: { root, entry, files, vendor: vendors.map(vendor => ({ url: vendor.url, sha256: vendor.sha256 })), ...(archive ? { archive: { path: archive.path, sha256: archive.sha256 } } : {}),
      // the scripts and pages of the folder the entry never loads (the other versions of a design canvas: v2.jsx, v3.jsx),
      // listed so the receipt says what was left out; mapping.version swaps the entry's app script for one of them
      ...(unreferenced.length ? { unreferenced } : {}), ...(Object.keys(aliases).length ? { version: Object.entries(aliases).map(([from, to]) => ({ from, to }))[0] } : {}) },
    kind,
    app: { prefix, title: doc.title ?? '', lang: doc.lang ?? '' },
    document: { html: doc.html ?? [], body: doc.body ?? [], meta: doc.meta ?? [] },
    css: { sheets: sheets.map(sheet => omit(sheet, 'text')) },
    assets: assets.map(asset => omit(asset, 'data')),
    icons,
    dimensions: outDims,
    store,
    shell: shell ? { root: shell.root, regions: shell.regions, mount: shell.mount, siblings: shell.siblings, regionInfo: shell.regionInfo, inputs: shell.inputs, events: shell.events } : null,
    views: outViews,
    modals: outModals,
    events: outEvents,
    targetGuarded: records.targetGuarded.map(item => ({ event: item.modal + ':click', modal: item.modal, handler: item.handler, why: item.why })),
    outOfScope,
    unexplained,
    extraAttributes,
    explored, trees,
    problems: [],
    warnings: dedupe(warnings),
    stats: { elements: elementsTotal, views: outViews.length, modals: outModals.length, icons: new Set(instances.map(icon => icon.name)).size, iconInstances: instances.length, events: outEvents.length, probes: pool.stats.probes, windows: pool.stats.windows }
  };
  return { ir, payloads: { sheets, assets }, notCompiled: notCompiledAll };
}

// multi-page (2.9): the sheets of every page in page order; a sheet used by one page only is marked page:<key> (it goes
// to that screen's StyleSheet), the others are the theme.
function pageSheets(views, session, readText) {
  const sheetKey = sheet => sheet.href ? 'file:' + sheet.href : sheet.external ? 'url:' + sheet.external : 'inline:' + sha256(Buffer.from(sheet.text ?? '', 'utf8'));
  const usage = new Map();
  for (const view of views) {
    for (const sheet of view.render?.inspect?.sheets ?? []) {
      const key = sheetKey(sheet);
      if (!usage.has(key)) usage.set(key, { sheet, pages: new Set() });
      usage.get(key).pages.add(view.key);
    }
  }
  const owner = new Map([...usage.values()].map(entry => [entry.sheet, entry.pages.size === 1 && views.length > 1 ? 'page:' + [...entry.pages][0] : null]));
  return inventory({ sheets: [...usage.values()].map(entry => entry.sheet), runtimeStyles: session.runtimeStyles, readText, page: sheet => owner.get(sheet) ?? null });
}

// One refusal with every problem, its patch and alternatives (2.11); all patches together form one valid call.
export function refusalProblems(session, interactions, { mapping, pointer }) {
  const problems = [];
  const discovery = interactions.discovery;
  for (const problem of discovery.problems ?? []) {
    if (problem.key === 'states') {
      const view = problem.view;
      const dims = session.dims.filter(dim => dim.scope === 'global');
      const value = problem.state ?? (dims.length ? { [dims[0].key]: String(dims[0].values.find(item => String(item) !== String(dims[0].initial)) ?? dims[0].initial) } : {});
      problems.push({ code: 'PROTOTYPE_AMBIGUOUS', path: pointer + '/mapping/states', message: problem.message + (problem.fallbackText ? " ('" + problem.fallbackText + "')" : ''), key: ['states', slug(view.replace(/\/\{id\}/g, '')) || view], value });
    } else if (problem.key === 'default') {
      problems.push({ code: 'PROTOTYPE_AMBIGUOUS', path: pointer + '/mapping/default', message: problem.message, key: ['default'], value: problem.value });
    } else if (problem.key === 'mappedClick') {
      problems.push({ code: 'PROTOTYPE_AMBIGUOUS', path: pointer + '/mapping/states/' + pointerEscape(problem.view), message: problem.message + '; name the trigger by its exact words or a CSS selector that matches it' });
    }
  }
  if (!discovery.mount && session.mountCandidates?.length && (discovery.kind === 'spa-hash' || discovery.kind === 'spa-path')) {
    const body = session.s0.body;
    // every candidate by a selector that matches it alone (section.view[data-view="buscar"], never section.view three times)
    const selectors = [...new Set(session.mountCandidates.map(candidate => uniqueSelector(body, candidate)).filter(Boolean))];
    problems.push({ code: 'PROTOTYPE_AMBIGUOUS', path: pointer + '/mapping/shell', message: 'mais de um ponto de montagem candidato: ' + selectors.join(', '), ...(selectors.length ? { key: ['shell'], value: { mount: selectors[0] }, alternatives: selectors.slice(1) } : {}) });
  }
  const storeInfo = session.s0.inspect.store ?? {};
  if (!storeInfo.source && !mapping.data) {
    const hasLists = discovery.views.some(view => {
      const mount = nodeAt(view.render.body, view.mountPath ?? discovery.mount ?? []) ?? view.render.body;
      let groups = 0;
      walk(mount, node => {
        if (!isElement(node)) return;
        const counts = new Map();
        for (const kid of (node.c ?? []).filter(isElement)) { const key = kid.t + '.' + (classes(kid)[0] ?? ''); counts.set(key, (counts.get(key) ?? 0) + 1); }
        if ([...counts.values()].some(count => count >= 2)) groups++;
      });
      return groups > 0;
    });
    const candidates = storeInfo.candidates ?? [];
    const roles = storeInfo.roles ?? {};
    const said = candidates.map(candidate => candidate + ': ' + (roles[candidate] ?? 'candidate')).concat(['"none": no store, every list stays as rendered']).join('; ');
    if (hasLists && candidates.length) problems.push({ code: 'PROTOTYPE_AMBIGUOUS', path: pointer + '/mapping/data', message: 'há listas no DOM que correlacionam com dados, mas nenhum store foi achado; candidatos e o papel de cada um: ' + said, key: ['data'], value: candidates[0], alternatives: candidates.slice(1) });
  }
  if (storeInfo.error) problems.push({ code: 'PROTOTYPE_AMBIGUOUS', path: pointer + '/mapping/data', message: storeInfo.error, key: ['data'], value: (storeInfo.candidates ?? [])[0] ?? mapping.data, alternatives: (storeInfo.candidates ?? []).slice(1) });
  // Modals with the same title and different structures: one problem per title, a name for every split kind.
  const ambiguousModals = (interactions.modals ?? []).filter(item => item.ambiguous);
  for (const slugKey of [...new Set(ambiguousModals.map(item => item.slug))]) {
    const group = ambiguousModals.filter(item => item.slug === slugKey);
    problems.push({ code: 'PROTOTYPE_AMBIGUOUS', path: pointer + '/mapping/modals', message: group.length + ' modais com o título "' + group[0].title + '" e estruturas diferentes (' + group.map(item => item.key).join(', ') + ')', additions: group.map(item => ({ keys: ['modals', item.key], value: mapping.modals?.[item.key] ?? item.name })) });
  }
  const additionsOf = problem => problem.additions ?? (problem.key ? [{ keys: problem.key, value: problem.value }] : []);
  const patches = mappingPatches(mapping, problems.flatMap(additionsOf), pointer);
  let index = 0;
  return problems.map(problem => {
    const out = { code: problem.code, path: problem.path, message: problem.message };
    const count = additionsOf(problem).length;
    if (count) { out.patch = patches.slice(index, index + count).flat(); index += count; out.mappingAdditions = additionsOf(problem); }
    if (problem.alternatives?.length) out.alternatives = problem.alternatives;
    return out;
  });
}

// Field names of the model in PascalCase (imovelId -> ImovelId, titulo -> Titulo), everywhere the IR names a field: the
// store (fields, key, references, rows), every {field, via} of expressions, filters, sorts and keys, the field maps of the
// effects (fields, keys, existing, on, source/join/sum values), the options sources and the extra attributes. Collection
// names, view, modal and dimension keys and the explored DOM trees are never touched. A name already PascalCase is kept.
const EFFECT_KINDS = new Set(['navigate', 'openPopup', 'closePopup', 'setDimension', 'toggle', 'increment', 'remove', 'update', 'insert', 'upsert', 'insertFrom', 'updateFrom', 'removeWhere', 'validate', 'toast']);
export function pascalFieldName(name) { return typeof name === 'string' && /^[a-z]/.test(name) ? name[0].toUpperCase() + name.slice(1) : name; }
export function pascalFields(ir) {
  const F = pascalFieldName;
  const SKIP = new Set(['trees', 'explored', 'document', 'css', 'assets', 'icons', 'source', 'engine', 'warnings', 'timings', 'outOfScope']);
  const visit = (node, top = false) => {
    if (Array.isArray(node)) return node.map(item => visit(item));
    if (!node || typeof node !== 'object') return node;
    const effect = typeof node.kind === 'string' && EFFECT_KINDS.has(node.kind);
    const optionsSource = typeof node.collection === 'string' && typeof node.value === 'string' && typeof node.label === 'string';
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (top && SKIP.has(key)) { out[key] = value; continue; }
      if (typeof value === 'string') {
        const field = ['field', 'via', 'existing', 'on'].includes(key) || (key === 'sum' && effect) || ((key === 'source' || key === 'join') && !effect) || (optionsSource && (key === 'value' || key === 'label'));
        out[key] = field ? F(value) : value;
        continue;
      }
      if (key === 'fields' && Array.isArray(value) && value.every(item => typeof item === 'string')) { out[key] = value.map(F); continue; }
      if ((key === 'fields' || key === 'keys') && effect && value && typeof value === 'object' && !Array.isArray(value)) { out[key] = Object.fromEntries(Object.entries(value).map(([name, item]) => [F(name), visit(item)])); continue; }
      out[key] = visit(value);
    }
    return out;
  };
  const out = visit(ir, true);
  // where the store came from (global:Name, file:path, mapping:expr) is a provenance, not a field
  if (out.store && typeof ir.store?.source === 'string') out.store.source = ir.store.source;
  for (const collection of out.store?.collections ?? []) {
    if (collection.key !== '#') collection.key = F(collection.key);
    collection.fields = (collection.fields ?? []).map(field => ({ ...field, name: F(field.name) }));
    collection.rows = (collection.rows ?? []).map(row => Object.fromEntries(Object.entries(row).map(([name, value]) => [F(name), value])));
  }
  out.extraAttributes = (out.extraAttributes ?? []).map(item => ({ ...item, name: F(item.name) }));
  return out;
}

const DATA_KINDS = new Set(['insert', 'insertFrom', 'updateFrom', 'removeWhere', 'update', 'toggle', 'increment', 'upsert', 'remove']);
// Two cases, one inserting into a collection that only holds a key (a Set of favorite properties) and one removing from it
// by the event's parameter: the membership toggle of that key (kind toggle with keys), plus the other effects both cases
// share (their notices differ, they are not kept).
export function membershipToggle(cases, meta) {
  if (!Array.isArray(cases) || cases.length !== 2) return null;
  const data = cases.map(entry => entry.effects.filter(effect => DATA_KINDS.has(effect.kind)));
  if (data.some(list => list.length !== 1)) return null;
  const remove = data.flat().find(effect => effect.kind === 'remove'), insert = data.flat().find(effect => effect.kind === 'insert');
  if (!remove || !insert || remove.collection !== insert.collection || !remove.key?.param) return null;
  const collection = meta?.byName?.get(remove.collection);
  if (!collection || collection.fields.length !== 1 || collection.key !== collection.fields[0].name) return null;
  const shared = cases[0].effects.filter(effect => !DATA_KINDS.has(effect.kind) && effect.kind !== 'toast' && cases[1].effects.some(other => canonical(other) === canonical(effect)));
  return [{ kind: 'toggle', collection: remove.collection, keys: { [collection.key]: { param: remove.key.param } } }, ...shared];
}

// The mapping with the additions of a refusal applied (keys path -> value), as the patch would leave it.
export function mappingWith(mapping, additions) {
  const out = JSON.parse(JSON.stringify(mapping ?? {}));
  for (const { keys, value } of additions ?? []) {
    let node = out;
    for (const key of keys.slice(0, -1)) { if (!node[key] || typeof node[key] !== 'object') node[key] = {}; node = node[key]; }
    node[keys[keys.length - 1]] = JSON.parse(JSON.stringify(value));
  }
  return out;
}

// INVARIANT of the refusal (2.11): a patch is proposed only after the discovery ran again with it applied and the problem
// it answers was gone. A problem whose patch did not resolve it comes back without a patch, saying so, so that the model
// never loops on a correction that cannot work.
export async function capturePrototype(args = {}) {
  const first = await captureOnce(args);
  const strip = result => (result.ok ? result : { ...result, problems: (result.problems ?? []).map(({ mappingAdditions, ...problem }) => problem) });
  const proposed = first.ok ? [] : (first.problems ?? []).filter(problem => problem.mappingAdditions?.length);
  if (first.ok || args.verify === false || !proposed.length) return strip(first);
  const candidate = mappingWith(args.mapping ?? {}, proposed.flatMap(problem => problem.mappingAdditions));
  const second = await captureOnce({ ...args, mapping: candidate, out: undefined });
  const left = new Set((second.ok ? [] : second.problems ?? []).map(problem => problem.code + ' ' + problem.path));
  const problems = first.problems.map(problem => {
    if (!problem.mappingAdditions?.length || !left.has(problem.code + ' ' + problem.path)) return problem;
    const { patch, alternatives, mappingAdditions, ...rest } = problem;
    const tried = JSON.stringify(mappingWith({}, mappingAdditions));
    return { ...rest, message: problem.message + ' — nenhum patch resolve: a descoberta refeita com mapping ' + tried + ' recusa do mesmo jeito',
      fix: 'No mapping resolves this problem (the importer applied the one it would propose and ran the discovery again); do not retry with a mapping: report it as an SSAM defect with this refusal.',
      ssamDefect: true, unresolved: true };
  });
  return strip({ ...first, problems, verified: { mapping: candidate, ok: Boolean(second.ok), left: [...left] } });
}

async function captureOnce({ source, entry, mapping = {}, clock, tz = 'UTC', out, timeoutMs = 20000, pool, pointer = '/ops/0/data', vendorCache, download, resident = true, archive = null, sourcesDir = null } = {}) {
  const started = performance.now();
  const timings = {};
  const warnings = [];
  mapping = mapping ?? {};
  const resolved = resolveSource(source, entry, { sourcesDir: sourcesDir ?? (out ? path.join(path.resolve(out), '..', 'sources') : null), archive });
  if (resolved.problems.length) {
    return { ok: false, problems: resolved.problems.map(problem => ({
      code: problem.code, path: pointer + '/' + problem.field, message: problem.message,
      patch: problem.field === 'entry' && problem.candidates?.length ? [{ op: problem.message.includes('does not exist') ? 'replace' : 'add', path: pointer + '/entry', value: problem.candidates[0] }] : undefined,
      alternatives: problem.candidates?.slice(1)
    })), warnings };
  }
  const { root, files, htmlFiles } = resolved;
  entry = resolved.entry;
  let scan = staticScan(root, entry, files);
  // mapping.version: another version of the app script the entry loads (a prototype with v1/v2/v3 files): that file is
  // served in place of the entry's own app script; the IR names both
  let aliases = {};
  if (mapping.version != null) {
    const wanted = String(mapping.version).replace(/\\/g, '/').replace(/^\.\//, '');
    const scripts = files.filter(name => /\.(jsx|tsx|js|mjs)$/i.test(name));
    if (!scan.appScript || !scripts.includes(wanted)) {
      return { ok: false, problems: [{ code: 'PROTOTYPE_SOURCE_INVALID', path: pointer + '/mapping/version',
        message: !scan.appScript ? 'mapping.version: the entry ' + entry + ' loads no local app script to replace' : 'mapping.version ' + JSON.stringify(mapping.version) + ' is not a script of the prototype folder',
        alternatives: scripts.filter(name => !scan.read.has(name)).slice(0, 8) }], warnings };
    }
    if (wanted !== scan.appScript) { aliases = { [scan.appScript]: wanted }; scan = staticScan(root, entry, files, aliases); }
  }
  const readmeText = scan.readme ? fs.readFileSync(path.join(root, scan.readme), 'utf8') : null;
  const clockIso = clock ?? clockFrom(root, [...scan.read]);
  const clockMs = Date.parse(clockIso);
  if (!Number.isFinite(clockMs)) return { ok: false, problems: [{ code: 'PROTOTYPE_SOURCE_INVALID', path: pointer + '/clock', message: 'clock ' + clock + ' is not an ISO-8601 instant' }], warnings };
  // Vendors (CDN scripts) are resolved before any window opens.
  const cacheDir = vendorCache ?? defaultVendorCache();
  const downloader = download === undefined ? (process.env.SSAM_PROTOTYPE_OFFLINE ? null : downloadVendor) : download;
  const vendorResult = await resolveVendors(scan.remote, { mapping, cacheDir, download: downloader, source: root, integrity: scan.integrity ?? {} });
  // where a copy of a script the capture cannot fetch is saved: beside the prototype folder or the .zip the model gave, never
  // inside the internal extraction folder of an archive
  const vendorBase = resolved.archive?.path ? path.dirname(path.resolve(resolved.archive.path)) : root;
  const missing = missingProblems(scan.missing ?? [], files, pointer);
  if (vendorResult.problems.length || missing.length) {
    const problems = [...missing];
    // a file mapping.vendor names that cannot be read: the call is wrong (a path), never an SSAM defect, and no patch repeats it
    for (const problem of vendorResult.problems.filter(item => item.reason === 'mapping-file'))
      problems.push({ code: 'PROTOTYPE_SOURCE_INVALID', path: pointer + '/mapping/vendor/' + pointerEscape(problem.url), message: problem.message + '; save there a copy of ' + problem.url + ' (the owner downloads it) or correct the path',
        fix: 'Save the script at the path mapping.vendor names (the bytes of the URL), or correct the path; then call again with the same job.' });
    const unfetched = vendorResult.problems.filter(item => item.reason !== 'mapping-file');
    problems.push(...vendorProblems(unfetched.map(problem => ({ url: problem.url, message: problem.message })), { mapping, pointer, vendorBase }));
    return { ok: false, problems, warnings };
  }
  const vendors = [...vendorResult.vendors.values()];
  // the text/babel scripts read statically, compiled with the page's own Babel in this process (never in the child)
  if (scan.babelSources.length) {
    // only a Babel the SSAM vouches for runs here (babel.mjs trustedBabel): a copy in the prototype folder is prototype content
    const babelVendor = scan.babelUrl ? vendors.find(vendor => vendor.url === scan.babelUrl) ?? null
      : scan.babelLocal ? { url: null, from: 'local', text: fs.readFileSync(path.join(root, scan.babelLocal), 'utf8') } : null;
    const compiled = compileBabelSources(babelVendor, scan.babelSources);
    scan.scriptSources.push(...compiled.sources);
    scan.warnings = compiled.warnings;
  }
  const size = pool ?? defaultPoolSize();
  const workers = await acquirePool({ size, tz, timeoutMs, resident, config: { root, clock: clockMs, seed: 1, mapping: { ignore: mapping.ignore ?? [], data: mapping.data }, vendors, aliases, prewarm: scan.classicFiles.map(file => ({ file })) } });
  try {
    const analysis = analyzeScripts(scan.scriptSources);
    const session = new Session({ root, entry, mapping, clock: clockMs, tz, pool: workers, analysis, readme: readmeText, htmlFiles, files, vendors, pointer, warmIdle: true });
    for (const warning of scan.warnings ?? []) session.warn(warning);
    const t0 = performance.now();
    const first = await session.run([{ key: 'load', steps: [{ do: 'inspect', tag: 'S0' }] }]);
    const s0 = first.get('load')?.snaps?.[0];
    timings.loadMs = Math.round(performance.now() - t0);
    const babelSyntax = (scan.warnings ?? []).filter(warning => warning?.code === 'PrototypeBabelSyntax');
    if (!s0) {
      const why = babelProblems(babelSyntax, pointer);
      return { ok: false, problems: why.length ? why : [{ code: 'PROTOTYPE_RENDER_FAILED', path: pointer, message: 'the entry page could not be loaded: ' + String(first.get('load')?.failure?.error ?? 'unknown').split('\n')[0] }], warnings: session.warnings };
    }
    const loadProblems = renderProblems(s0.inspect.problems, { root, mapping, pointer, vendorBase, babelSyntax });
    if (loadProblems.length) return { ok: false, problems: loadProblems, warnings: session.warnings };
    session.s0 = s0;
    const decided = staticKind({ s0, entry, htmlFiles, analysis });
    session.kind = decided?.kind ?? null;
    const t1 = performance.now();
    const interactions = await analyzeInteractions(session, { decided });
    timings.crawlMs = interactions.crawlMs ?? Math.round(performance.now() - t1);
    timings.probeMs = interactions.probeMs ?? 0;
    const problems = refusalProblems(session, interactions, { mapping, pointer });
    if (problems.length) return { ok: false, problems, warnings: session.warnings };
    const t2 = performance.now();
    const built = buildIr(session, interactions, { root, entry, clockIso, tz, scan, mapping, vendors, pool: workers, archive: resolved.archive, aliases, files });
    timings.inferMs = Math.round(performance.now() - t2);
    // the model's field names in PascalCase before anything hashes or reads the IR
    const ir = pascalFields(built.ir);
    timings.totalMs = Math.round(performance.now() - started);
    timings.rounds = session.rounds ?? [];
    ir.timings = timings;
    ir.engine.node = process.version;
    const invalid = validateIr(ir);
    if (invalid.length) return { ok: false, problems: [{ code: 'PROTOTYPE_IR_INVALID', path: pointer, message: 'IR out of schema: ' + invalid.slice(0, 5).join('; '), ssamDefect: true }], warnings: session.warnings };
    const hash = irHash(ir);
    const bundleDir = out ? path.resolve(out) : null;
    let capturePath = null;
    if (bundleDir) capturePath = writeBundle(bundleDir, ir, built.payloads);
    const summary = {
      kind: ir.kind, views: ir.views.length, modals: ir.modals.length, elements: ir.stats.elements, icons: ir.stats.icons,
      events: ir.events.length, compiled: ir.events.filter(event => event.compiled).length, probes: workers.stats.probes, windows: workers.stats.windows, pool: size,
      ...(ir.source.unreferenced?.length ? { unreferenced: ir.source.unreferenced } : {}), ...(ir.source.version ? { version: ir.source.version } : {}),
      ...(ir.source.archive ? { archive: ir.source.archive } : {}), ...(ir.store.configuration ? { configuration: ir.store.configuration } : {})
    };
    return { ok: true, capturePath, bundle: bundleDir, sha256: hash, summary, problems: [], warnings: ir.warnings, ir };
  } finally {
    releasePool(workers);
  }
}

// A script the capture cannot fetch (offline, the hosted SSAM, a host outside the allowlist): the patch maps its URL to a copy
// saved beside the source (mapping.vendor). The copy does not exist yet, so the patch is never applied for the model:
// needsFile names the file to save first, and the refusal offers no correctedJob for it (2.11: a patch is offered only when
// the call with it works).
function vendorProblems(items, { mapping, pointer, vendorBase }) {
  if (!items.length) return [];
  const files = items.map(item => suggestedVendorPath(vendorBase, item.url));
  const patches = mappingPatches(mapping, items.map((item, index) => ({ keys: ['vendor', item.url], value: files[index] })), pointer);
  return items.map((item, index) => ({ code: 'PROTOTYPE_RENDER_FAILED', path: pointer + '/mapping/vendor/' + pointerEscape(item.url),
    message: item.message + '; save a copy of ' + item.url + ' at ' + files[index] + ' (the owner downloads it), then apply the patch',
    fix: 'The script must exist before the patch can work: the owner saves a copy of ' + item.url + ' at ' + files[index] + '; then apply this patch (mapping.vendor) in ONE call. No correctedJob is offered for it.',
    patch: patches[index], needsFile: files[index] }));
}

export function renderProblems(list, { root, mapping, pointer, vendorBase = root, babelSyntax = [] }) {
  const problems = [];
  const vendorAdds = [];
  for (const problem of list ?? []) {
    if (problem.reason === 'bare-specifier') {
      vendorAdds.push({ url: problem.specifier, message: problem.message });
      continue;
    }
    if (problem.reason === 'vendor' && problem.url) { vendorAdds.push({ url: problem.url, message: problem.message }); continue; }
    // a script error of a page whose text/babel script does not compile: the cause is the compile error (file, line, column)
    if (babelSyntax.length && problem.reason === 'script') continue;
    problems.push({ code: 'PROTOTYPE_RENDER_FAILED', path: pointer, message: problem.message });
  }
  problems.push(...babelProblems(babelSyntax, pointer, (list ?? []).some(problem => problem.reason === 'script')));
  problems.push(...vendorProblems(vendorAdds, { mapping, pointer, vendorBase }));
  return problems;
}

// The text/babel scripts that do not compile (PrototypeBabelSyntax of the static scan, the same Babel the page loads), as the
// cause of a page that did not render: the file, the line and the column of the error.
function babelProblems(babelSyntax, pointer, failed = true) {
  if (!failed) return [];
  return babelSyntax.map(warning => ({ code: 'PROTOTYPE_RENDER_FAILED', path: pointer,
    message: 'the text/babel script ' + String(warning.where ?? '').replace(/^babel:/, '') + ' does not compile, so the page renders nothing from it: ' + warning.message,
    fix: 'The prototype has a JSX syntax error (file, line and column in the message): the owner corrects that file of the prototype; nothing in the call resolves it.' }));
}

// ---- CLI ------------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { source: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') args.out = argv[++i];
    else if (arg === '--entry') args.entry = argv[++i];
    else if (arg === '--mapping') { const value = argv[++i]; args.mapping = JSON.parse(fs.existsSync(value) ? fs.readFileSync(value, 'utf8') : value); }
    else if (arg === '--clock') args.clock = argv[++i];
    else if (arg === '--tz') args.tz = argv[++i];
    else if (arg === '--pool') args.pool = Number(argv[++i]);
    else if (arg === '--vendor-cache') args.vendorCache = argv[++i];
    else if (!args.source) args.source = arg;
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source) { process.stderr.write('usage: node capture.mjs <source> --out <dir> [--entry x] [--mapping <json>] [--clock <iso>] [--tz <iana>] [--pool n]\n'); process.exit(2); }
  const result = await capturePrototype({ ...args, resident: false });
  process.stdout.write(JSON.stringify(omit(result, 'ir'), null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

export { LIMITS, sectionTargets, crawlRoutes, viewsFromCrawl, crawlPages, sha256, closeResidentPools };
