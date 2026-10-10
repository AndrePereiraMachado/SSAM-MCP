// The module digest (ssam-digest/1) in pages under the MCP answer ceiling: ssam_map {view:"digest", page} and
// ssam map --digest [--page n] (module-map.mjs resolves the target and the store and calls digestAnswer). The digest is
// written by the lane's kernel reader (C# ModuleDigest, request {"digest":"ensure"}) beside the module index:
//   <SSAM_MODULE_INDEX_ROOT | <workspace>\.local\module-index>\v1\<lane>\<sha256>.kernel.digest.json
// and read here without .NET: served only when schema, extractor, lane, adapter and the sha256 of the bytes read now match.
// Paging (deterministic: the same digest and budget always give the same pages, whatever the call that asks):
// - the whole digest fits one page: one page, the digest as written;
// - else page 1 (and the next ones while it lasts) is the overview: the header, entities and structures (a static entity
//   with more than FOLD_RECORDS records shows the first ones and the page of the rest), the index of every action with its
//   signature, calls and callers, and the coverage; then the bodies by section (actions by folder) and the folded records;
// - a block cut by a page says so at the cut and again where it continues; a line longer than a page is cut the same way;
// - contents (page 1) gives the pages of every part, so any page is one call away.
import fs from 'node:fs';

export const DIGEST_SCHEMA = 'ssam-digest/1';
// ModuleDigest.Extractor and SectionIds (C#): a stored digest of another version is a miss.
export const DIGEST_EXTRACTOR = 2;
export const DIGEST_SECTIONS = ['module', 'entities', 'structures', 'variables', 'roles', 'exceptions', 'actions', 'timers', 'integrations', 'ui', 'coverage'];
// Both lanes write the digest with the kernel's own reader (anvil read-serve, anvil-odc read-serve).
export const DIGEST_ADAPTER = 'kernel';
export const DIGEST_PAGE_SCHEMA = 'ssam-digest-page/1';
export const FOLD_RECORDS = 10;
// Room the envelope of a page may take besides its text and contents: paths up to PATH_ROOM characters, hashes, counts,
// cache, timings and continuations. A fixed room keeps the pages the same for every call of the same capture and budget.
const PATH_ROOM = 400;

const str = v => typeof v === 'string';
// The checks of ModuleDigest.Parse, and the record count the overview folds.
export function wellFormedDigest(d, lane) {
  if (!d || d.schema !== DIGEST_SCHEMA || d.extractor !== DIGEST_EXTRACTOR || d.lane !== lane || d.adapter !== DIGEST_ADAPTER
    || !str(d.sourceSha256) || !d.module || !str(d.module.name) || !str(d.module.key) || !Array.isArray(d.sections)
    || d.sections.length !== DIGEST_SECTIONS.length || !Array.isArray(d.actions)) return false;
  return d.sections.every((s, i) => s && s.id === DIGEST_SECTIONS[i] && str(s.title) && Number.isInteger(s.count) && Array.isArray(s.blocks)
      && s.blocks.every(b => b && str(b.key) && str(b.kind) && str(b.name) && str(b.text) && (b.folder == null || str(b.folder))
        && (b.records == null || (Number.isInteger(b.records) && b.records >= 0 && b.records < b.text.split('\n').length))))
    && d.actions.every(a => a && str(a.key) && str(a.kind) && str(a.name) && str(a.section) && str(a.in) && str(a.out)
      && typeof a.public === 'boolean' && typeof a.function === 'boolean' && (a.folder == null || str(a.folder))
      && Array.isArray(a.calls) && a.calls.every(str) && Array.isArray(a.calledBy) && a.calledBy.every(str));
}

// The last two parsed digests; the file is content-addressed, the stamp only tells a rewritten file from the parsed one.
const parsed = new Map();
export function loadDigest(file, lane, sha256) {
  let stat; try { stat = fs.statSync(file); } catch { return null; }
  const stamp = stat.size + ':' + stat.mtimeMs + ':' + stat.ino;
  let digest = parsed.get(file)?.stamp === stamp ? parsed.get(file).digest : null;
  if (!digest) {
    try { digest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
    if (!wellFormedDigest(digest, lane)) return null;
    parsed.delete(file); parsed.set(file, { stamp, digest });
    while (parsed.size > 2) parsed.delete(parsed.keys().next().value);
  }
  return digest.sourceSha256.toLowerCase() === sha256.toLowerCase() ? { digest, stamp } : null;
}

// DigestSection.Text and ModuleDigest.Text, byte for byte.
export const sectionText = s => '## ' + s.title + ' (' + s.count + ')\n' + s.blocks.map(b => b.text + '\n').join('');
export const digestText = d => d.sections.map(sectionText).join('');

// The bytes a text adds inside a JSON answer (escapes included).
const jsonBytes = text => Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
const LABEL = { ServerAction: 'server action', ServiceAction: 'service action', ClientAction: 'client action', ScreenAction: 'action',
  DataAction: 'data action', Preparation: 'preparation', OnExceptionAction: 'on exception' };
const SECTION_ORDER = ['actions', 'integrations', 'ui'];
// No folder first, then folders by name (ordinal).
const folderKey = x => x.folder == null ? '' : '\u0001' + x.folder;
const byFolder = (a, b) => { const x = folderKey(a), y = folderKey(b); return x < y ? -1 : x > y ? 1 : 0; };
const stable = (items, compare) => items.map((item, i) => [item, i]).sort((x, y) => compare(x[0], y[0]) || x[1] - y[1]).map(([item]) => item);

// One line of the action index: kind, name, @key, flags, inputs, outputs, what it calls and who calls it.
export const indexLine = a => (LABEL[a.kind] ?? a.kind) + ' ' + a.name + ' @' + a.key + (a.public ? ' public' : '') + (a.function ? ' function' : '')
  + ' (' + a.in + ')' + (a.out ? ' -> (' + a.out + ')' : '') + (a.calls.length ? ' calls: ' + a.calls.join(', ') : '')
  + (a.calledBy.length ? ' | called by: ' + a.calledBy.join(', ') : '');

// The parts of a multi-page digest in page order. recordsPage: the page the folded records start on (null: not known yet).
function partsOf(d, recordsPage) {
  const S = Object.fromEntries(d.sections.map(s => [s.id, s]));
  const lines = text => text.split('\n');
  const folded = [];
  const entities = S.entities.blocks.map(b => {
    const all = lines(b.text);
    if (!((b.records ?? 0) > FOLD_RECORDS)) return { lines: all };
    const keep = all.length - b.records + FOLD_RECORDS;
    folded.push({ block: b, rest: all.slice(keep) });
    return { lines: [...all.slice(0, keep), '  … ' + (b.records - FOLD_RECORDS) + ' more records (' + (FOLD_RECORDS + 1) + '-' + b.records + ' of ' + b.records
      + ') on page ' + (recordsPage ?? 999) + ', part "static entity records"'] };
  });
  // Actions grouped by section, then folder (none first), each group headed once.
  const groups = [];
  for (const action of stable(d.actions, (a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || byFolder(a, b))) {
    const head = '### ' + action.section + (action.folder != null ? ' / folder ' + action.folder : '');
    if (groups.at(-1)?.head !== head) groups.push({ head, lines: [head] });
    groups.at(-1).lines.push(indexLine(action));
  }
  const actionBodies = []; let folder;
  for (const block of stable(S.actions.blocks, byFolder)) {
    const head = block.folder != null && block.folder !== folder ? ['### folder ' + block.folder] : [];
    folder = block.folder;
    actionBodies.push({ lines: [...head, ...lines(block.text)] });
  }
  const section = (id, part = id) => ({ id: part, title: S[id].title, count: S[id].count, blocks: S[id].blocks.map(b => ({ lines: lines(b.text) })) });
  return [
    { id: 'header', overview: true, title: null, blocks: [{ lines: lines(S.module.blocks[0].text) }] },
    { id: 'entities', overview: true, title: S.entities.title, count: S.entities.count, blocks: entities },
    { ...section('structures'), overview: true },
    { id: 'actionIndex', overview: true, title: 'action index: every action, signature only, with calls and callers (bodies on later pages)', count: d.actions.length, blocks: groups },
    { ...section('coverage'), overview: true },
    { id: 'references', title: S.module.title, count: S.module.count, blocks: S.module.blocks.slice(1).map(b => ({ lines: lines(b.text) })) },
    section('variables'), section('roles'), section('exceptions'),
    { id: 'actions', title: S.actions.title, count: S.actions.count, blocks: actionBodies },
    section('timers'), section('integrations'), section('ui'),
    { id: 'records', title: 'static entity records (the overview shows the first ' + FOLD_RECORDS + ' of each)', count: folded.length,
      blocks: folded.map(f => ({ lines: ['static entity ' + f.block.name + ' @' + f.block.key + ': records ' + (FOLD_RECORDS + 1) + '-' + f.block.records + ' of ' + f.block.records, ...f.rest] })) },
  ];
}

// Lines into pages of at most cap(page) JSON bytes each. A page cut inside a block closes with where it continues, and the
// next page opens with the part title and the block's first line; a line above a whole page is cut at characters, each
// piece saying so. Nothing is dropped.
function layout(parts, cap) {
  const pages = [{ lines: [], used: 0 }];
  const ranges = new Map();
  const RESERVE = 200;
  const add = (line, id) => {
    const page = pages.at(-1); page.lines.push(line); page.used += jsonBytes(line + '\n');
    const range = ranges.get(id); if (range) range[1] = pages.length; else ranges.set(id, [pages.length, pages.length]);
  };
  const room = () => cap(pages.length) - RESERVE - pages.at(-1).used;
  for (const part of parts) {
    if (!part.blocks.length) continue;
    const title = part.title == null ? null : '## ' + part.title + ' (' + part.count + ')';
    let titled = false;
    for (const block of part.blocks) {
      block.lines.forEach((line, at) => {
        const needs = jsonBytes(line + '\n') + (title && !titled ? jsonBytes(title + '\n') : 0);
        if (pages.at(-1).used > 0 && needs > room()) {
          if (at > 0) add('…(this block continues on page ' + (pages.length + 1) + ')', part.id);
          pages.push({ lines: [], used: 0 });
          if (titled) add('## ' + part.title + ' (continued from page ' + (pages.length - 1) + ')', part.id);
          if (at > 0) add('…(continued from page ' + (pages.length - 1) + ') ' + (block.lines[0].length > 200 ? block.lines[0].slice(0, 200) + '…' : block.lines[0]), part.id);
        }
        if (title && !titled) { add(title, part.id); titled = true; }
        if (jsonBytes(line + '\n') <= room()) { add(line, part.id); return; }
        // A line longer than the room left: pieces that fit, each but the last closed with where it goes on.
        let rest = line;
        while (rest.length) {
          if (jsonBytes(rest + '\n') <= room()) { add(rest, part.id); break; }
          const fits = k => jsonBytes(rest.slice(0, k) + ' …(this line continues on page 99999)\n') <= room();
          let lo = 0, hi = rest.length;
          while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(mid)) lo = mid; else hi = mid - 1; }
          let n = Math.max(1, lo);
          // Never between the two halves of a surrogate pair.
          if (n < rest.length && /[\uD800-\uDBFF]/.test(rest[n - 1])) n = n > 1 ? n - 1 : n + 1;
          add(rest.slice(0, n) + ' …(this line continues on page ' + (pages.length + 1) + ')', part.id);
          rest = rest.slice(n);
          pages.push({ lines: [], used: 0 });
          add('…(line continued from page ' + (pages.length - 1) + ')', part.id);
        }
      });
    }
  }
  return { pages: pages.map(p => p.lines.join('\n') + '\n'), ranges };
}

// The pages of a digest at a budget, cached per stored file, stamp and budget. envelope(text, contents) answers the page
// object with that text and contents; its size with an empty text sets the room of each page.
const laidOut = new Map();
export function digestPages(digest, { budgetBytes, key = null }) {
  const cacheKey = key != null ? key + '|' + budgetBytes : null;
  if (cacheKey && laidOut.has(cacheKey)) return laidOut.get(cacheKey);
  const full = digestText(digest);
  const totals = { bytes: Buffer.byteLength(full, 'utf8') }; totals.tokens = Math.ceil(totals.bytes / 4);
  const draft = partsOf(digest, null);
  const contentsOf = (parts, ranges) => parts.filter(p => p.blocks.length).map(p => {
    const bytes = p.blocks.reduce((n, b) => n + b.lines.reduce((m, l) => m + Buffer.byteLength(l + '\n', 'utf8'), 0), 0)
      + (p.title ? Buffer.byteLength('## ' + p.title + ' (' + p.count + ')\n', 'utf8') : 0);
    return { part: p.id, ...(p.title ? { title: p.title } : {}), ...(p.count != null ? { count: p.count } : {}), bytes,
      pages: ranges ? ranges.get(p.id) ?? null : [99999, 99999] };
  });
  const room = withContents => budgetBytes - envelopeBytes(digest, withContents ? contentsOf(draft, null) : null);
  let result;
  if (jsonBytes(full) <= room(false)) {
    result = { pages: [full], contents: digest.sections.filter(s => s.blocks.length).map(s => ({ part: s.id, title: s.title, count: s.count,
      bytes: Buffer.byteLength(sectionText(s), 'utf8'), pages: [1, 1] })), single: true, totals };
  } else {
    const first = room(true), other = room(false);
    if (first < 1000 || other < 1000) throw new Error('budgetBytes ' + budgetBytes + ' leaves no room for a page of the module digest; use at least ' + (budgetBytes - Math.min(first, other) + 4000));
    let recordsPage = null, parts, pages;
    for (let pass = 0; pass < 6; pass++) {
      parts = partsOf(digest, recordsPage);
      pages = layout(parts, page => page === 1 ? first : other);
      const at = pages.ranges.get('records')?.[0] ?? null;
      if (at === recordsPage) break;
      recordsPage = at;
    }
    result = { pages: pages.pages, contents: contentsOf(parts, pages.ranges), single: false, totals };
  }
  if (cacheKey) { laidOut.set(cacheKey, result); while (laidOut.size > 4) laidOut.delete(laidOut.keys().next().value); }
  return result;
}

// The answer of one page, without the call's own head (module-map.mjs adds lane, target, file, hashes, cache, timings).
export function digestBody(digest, laid, page) {
  return { page, pages: laid.pages.length,
    digest: { extractor: digest.extractor, createdAt: digest.createdAt ?? null, bytes: laid.totals.bytes, tokens: laid.totals.tokens,
      elements: digest.elements ?? null, actions: digest.actions.length, notRendered: digest.notRendered ?? null, clipped: digest.clipped ?? null,
      readErrors: digest.readErrors ?? null, layout: laid.single ? 'single page: the whole digest' : 'overview first (page 1 on), then bodies by section' },
    ...(page === 1 ? { contents: laid.contents } : {}),
    text: laid.pages[page - 1] };
}

// The largest envelope a page can have: the head fields module-map.mjs adds, with paths of PATH_ROOM characters and the
// longest values of every field, the continuations and, on page 1, the contents.
function envelopeBytes(digest, contents) {
  const pathText = 'x'.repeat(PATH_ROOM), hash = 'f'.repeat(64);
  const continuation = { tool: 'ssam_map', arguments: { lane: 'odc', target: pathText, view: 'digest', page: 99999, budgetBytes: 1048576, expectedSourceSha256: hash } };
  const sample = { ok: true, schema: DIGEST_PAGE_SCHEMA, lane: 'odc', target: pathText, file: pathText, sourceSha256: hash, contentSha256: hash, snapshotSha256: hash,
    capturedBy: 'published-oml', versionId: hash, module: digest.module, answeredBy: 'module-digest',
    store: { file: pathText, adapter: DIGEST_ADAPTER, extractor: DIGEST_EXTRACTOR, createdAt: '2026-10-10T00:00:00.0000000+00:00' },
    page: 99999, pages: 99999,
    digest: { extractor: DIGEST_EXTRACTOR, createdAt: '2026-10-10T00:00:00.0000000+00:00', bytes: 999999999, tokens: 999999999, elements: 999999999,
      actions: 999999999, notRendered: 999999999, clipped: 999999999, readErrors: 999999999, layout: 'overview first (page 1 on), then bodies by section' },
    ...(contents ? { contents } : {}),
    cache: { digest: 'ensured', built: true, loads: 99999, generation: hash },
    capture: { file: pathText, reused: true, note: 'same content as the capture this answer reads (volatile header fields aside): its keys and index serve' },
    text: '',
    continuations: { next: continuation, page: { ...continuation, arguments: { ...continuation.arguments, page: '<n>' } },
      inspect: { tool: 'studio_inspect', arguments: { target: pathText, path: '@<key>', expectedSourceSha256: hash } }, note: DIGEST_NOTE },
    note: DIGEST_NOTE, size: { bytes: 99999999, budgetBytes: 99999999 }, timings: { hashMs: 99999.9, ensureMs: 99999.9, totalMs: 99999.9 } };
  return Buffer.byteLength(JSON.stringify(sample), 'utf8') + 64;
}

export const DIGEST_NOTE = 'The whole module, nothing cut: read the overview (page 1 on) once and the pages of the parts the task needs (contents), then work in context. '
  + 'Every page comes from this capture (expectedSourceSha256). Inspect a @key only to go deeper; a text marked …(+N @key) is whole there with full:true.';
