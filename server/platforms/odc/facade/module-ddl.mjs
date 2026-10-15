// The data text (ssam-ddl/1) of a capture in pages under the MCP answer ceiling: ssam_map {view:"ddl", page?, element?}
// and ssam map --ddl [--page n] [--element E] (module-map.mjs resolves the target and the store and calls ddlAnswer). The
// text is written by the lane's kernel reader (C# DataDdl, request {"ddl":"ensure"}) beside the module index:
//   <SSAM_MODULE_INDEX_ROOT | <workspace>\.local\module-index>\v1\<lane>\<sha256>.kernel.ddl.json
// and read here without .NET: served only when schema, extractor, lane, adapter and the sha256 of the bytes read now match.
// It is the module's data as DDL (entities, static entities with their records, indexes), `type X = {…}` (structures)
// and declarations (site properties or settings, client and session variables, timers), every element with its @key and
// its whole description; DataDdlCheck proves it reads back to the same model (the fixed point).
// Paging (deterministic: the same text and budget always give the same pages): the header and then whole blocks (one per
// entity, structure, variable or timer); a block longer than a page is cut at a line and says so at both ends, as a
// comment the text's parser skips; element reads the block of one element by name or @key.
import fs from 'node:fs';

export const DDL_SCHEMA = 'ssam-ddl/1';
// DataDdl.Extractor and SectionIds (C#): a stored text of another version is a miss.
export const DDL_EXTRACTOR = 1;
export const DDL_SECTIONS = ['entities', 'structures', 'variables', 'timers'];
export const DDL_ADAPTER = 'kernel';
export const DDL_PAGE_SCHEMA = 'ssam-ddl-page/1';
const PATH_ROOM = 400;

const str = v => typeof v === 'string';
// The checks of DataDdl.Parse.
export function wellFormedDdl(d, lane) {
  if (!d || d.schema !== DDL_SCHEMA || d.extractor !== DDL_EXTRACTOR || d.lane !== lane || d.adapter !== DDL_ADAPTER
    || !str(d.sourceSha256) || !d.module || !str(d.module.name) || !str(d.module.key) || !Number.isInteger(d.elements) || !Array.isArray(d.blocks)) return false;
  return d.blocks.every(b => b && str(b.key) && str(b.kind) && str(b.name) && DDL_SECTIONS.includes(b.section) && str(b.text) && Number.isInteger(b.elements));
}

// The last two parsed texts; the file is content-addressed, the stamp only tells a rewritten file from the parsed one.
const parsed = new Map();
export function loadDdl(file, lane, sha256) {
  let stat; try { stat = fs.statSync(file); } catch { return null; }
  const stamp = stat.size + ':' + stat.mtimeMs + ':' + stat.ino;
  let ddl = parsed.get(file)?.stamp === stamp ? parsed.get(file).ddl : null;
  if (!ddl) {
    try { ddl = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
    if (!wellFormedDdl(ddl, lane)) return null;
    parsed.delete(file); parsed.set(file, { stamp, ddl });
    while (parsed.size > 2) parsed.delete(parsed.keys().next().value);
  }
  return ddl.sourceSha256.toLowerCase() === sha256.toLowerCase() ? { ddl, stamp } : null;
}

// DataDdl.Header and DataDdl.Text, byte for byte.
export const ddlHeader = d => '-- ' + DDL_SCHEMA + ' module=' + d.module.name + ' lane=' + d.lane + ' key=@' + d.module.key + ' sourceSha256=' + d.sourceSha256
  + ' elements=' + d.elements + '\n';
export const ddlText = d => ddlHeader(d) + d.blocks.map(b => '\n' + b.text + '\n').join('');

const jsonBytes = text => Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;

// The blocks an element names: its @key, or its name (case-insensitive); a name two elements share answers both.
export function selectBlocks(ddl, element) {
  if (element.startsWith('@')) return ddl.blocks.filter(b => b.key === element.slice(1));
  const name = element.toLowerCase();
  return ddl.blocks.filter(b => b.name.toLowerCase() === name);
}

// Lines into pages of at most cap JSON bytes: the header, then whole blocks while they fit; a block is cut at a line only
// when it does not fit a page alone, and a line longer than a page at characters, each cut said as a comment.
function layout(head, blocks, cap) {
  const pages = [{ lines: [], used: 0 }];
  const ranges = new Map();
  const RESERVE = 200;
  const add = (line, id) => {
    const page = pages.at(-1); page.lines.push(line); page.used += jsonBytes(line + '\n');
    if (id == null) return;
    const range = ranges.get(id); if (range) range[1] = pages.length; else ranges.set(id, [pages.length, pages.length]);
  };
  const room = () => cap - RESERVE - pages.at(-1).used;
  for (const line of head) add(line, null);
  for (const block of blocks) {
    const lines = ['', ...block.text.split('\n')];
    const whole = lines.reduce((n, l) => n + jsonBytes(l + '\n'), 0);
    // A whole block that does not fit what is left but fits a page starts the next page.
    if (pages.at(-1).used > 0 && whole > room() && whole <= cap - RESERVE) pages.push({ lines: [], used: 0 });
    lines.forEach((line, at) => {
      if (pages.at(-1).used > 0 && jsonBytes(line + '\n') > room()) {
        if (at > 1) add('-- …(' + block.name + ' continues on page ' + (pages.length + 1) + ')', block.section);
        pages.push({ lines: [], used: 0 });
        if (at > 1) add('-- …(' + block.name + ' continued from page ' + (pages.length - 1) + ')', block.section);
      }
      if (jsonBytes(line + '\n') <= room()) { add(line, block.section); return; }
      let rest = line;
      while (rest.length) {
        if (jsonBytes(rest + '\n') <= room()) { add(rest, block.section); break; }
        const fits = k => jsonBytes(rest.slice(0, k) + ' -- …(this line continues on page 99999)\n') <= room();
        let lo = 0, hi = rest.length;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(mid)) lo = mid; else hi = mid - 1; }
        let n = Math.max(1, lo);
        if (n < rest.length && /[\uD800-\uDBFF]/.test(rest[n - 1])) n = n > 1 ? n - 1 : n + 1;
        add(rest.slice(0, n) + ' -- …(this line continues on page ' + (pages.length + 1) + ')', block.section);
        rest = rest.slice(n);
        pages.push({ lines: [], used: 0 });
        add('-- …(line continued from page ' + (pages.length - 1) + ')', block.section);
      }
    });
  }
  return { pages: pages.map(p => p.lines.join('\n') + '\n'), ranges };
}

// The pages of a data text (or of the blocks one element names) at a budget, cached per stored file, stamp, element and
// budget.
const laidOut = new Map();
export function ddlPages(ddl, { budgetBytes, element = null, key = null }) {
  const cacheKey = key != null ? key + '|' + (element ?? '') + '|' + budgetBytes : null;
  if (cacheKey && laidOut.has(cacheKey)) return laidOut.get(cacheKey);
  const blocks = element == null ? ddl.blocks : selectBlocks(ddl, element);
  const head = ddlHeader(ddl).split('\n').slice(0, -1);
  const text = ddlHeader(ddl) + blocks.map(b => '\n' + b.text + '\n').join('');
  const totals = { bytes: Buffer.byteLength(text, 'utf8') }; totals.tokens = Math.ceil(totals.bytes / 4);
  const room = budgetBytes - envelopeBytes(ddl);
  if (room < 1000) throw new Error('budgetBytes ' + budgetBytes + ' leaves no room for a page of the data text; use at least ' + (budgetBytes - room + 4000));
  const laid = jsonBytes(text) <= room ? { pages: [text], ranges: new Map(DDL_SECTIONS.map(s => [s, [1, 1]])) } : layout(head, blocks, room);
  const contents = DDL_SECTIONS.map(section => {
    const of = blocks.filter(b => b.section === section);
    return of.length ? { section, blocks: of.length, elements: of.reduce((n, b) => n + b.elements, 0),
      bytes: of.reduce((n, b) => n + Buffer.byteLength('\n' + b.text + '\n', 'utf8'), 0), pages: laid.ranges.get(section) ?? null } : null;
  }).filter(Boolean);
  const result = { pages: laid.pages, contents, blocks, totals, single: laid.pages.length === 1 };
  if (cacheKey) { laidOut.set(cacheKey, result); while (laidOut.size > 4) laidOut.delete(laidOut.keys().next().value); }
  return result;
}

// The largest envelope a page can have (module-map.mjs adds lane, target, file, hashes, cache, timings, continuations).
function envelopeBytes(ddl) {
  const pathText = 'x'.repeat(PATH_ROOM), hash = 'f'.repeat(64);
  const continuation = { tool: 'ssam_map', arguments: { lane: 'odc', target: pathText, view: 'ddl', element: pathText, page: 99999, budgetBytes: 1048576, expectedSourceSha256: hash } };
  const sample = { ok: true, schema: DDL_PAGE_SCHEMA, lane: 'odc', target: pathText, file: pathText, sourceSha256: hash, contentSha256: hash, snapshotSha256: hash,
    capturedBy: 'published-oml', versionId: hash, module: ddl.module, answeredBy: 'data-ddl', element: pathText,
    store: { file: pathText, adapter: DDL_ADAPTER, extractor: DDL_EXTRACTOR, createdAt: '2026-10-10T00:00:00.0000000+00:00' },
    page: 99999, pages: 99999,
    ddl: { extractor: DDL_EXTRACTOR, createdAt: '2026-10-10T00:00:00.0000000+00:00', bytes: 999999999, tokens: 999999999, elements: 999999999, blocks: 999999999,
      layout: 'pages of whole blocks' },
    contents: DDL_SECTIONS.map(section => ({ section, blocks: 999999, elements: 999999, bytes: 999999999, pages: [99999, 99999] })),
    cache: { ddl: 'ensured', built: true, loads: 99999, generation: hash },
    capture: { file: pathText, reused: true, note: 'same content as the capture this answer reads (volatile header fields aside): its keys and index serve' },
    text: '',
    continuations: { next: continuation, page: continuation, element: continuation,
      inspect: { tool: 'studio_inspect', arguments: { target: pathText, path: '@<key>', expectedSourceSha256: hash } }, note: DDL_NOTE },
    note: DDL_NOTE, size: { bytes: 99999999, budgetBytes: 99999999 }, timings: { hashMs: 99999.9, ensureMs: 99999.9, totalMs: 99999.9 } };
  return Buffer.byteLength(JSON.stringify(sample), 'utf8') + 64;
}

// The answer of one page, without the call's own head (module-map.mjs adds lane, target, file, hashes, cache, timings).
export function ddlBody(ddl, laid, page) {
  return { page, pages: laid.pages.length,
    ddl: { extractor: ddl.extractor, createdAt: ddl.createdAt ?? null, bytes: laid.totals.bytes, tokens: laid.totals.tokens,
      elements: laid.blocks.reduce((n, b) => n + b.elements, 0), blocks: laid.blocks.length, layout: laid.single ? 'single page: the whole text' : 'pages of whole blocks' },
    ...(page === 1 ? { contents: laid.contents } : {}),
    text: laid.pages[page - 1] };
}

export const DDL_NOTE = 'The module\'s data as text: entities and static entities (records in values) as SQL DDL, structures as type X = {…}, '
  + 'site properties/settings, client and session variables and timers as one declaration line. Types, defaults and values are OutSystems\'. '
  + 'Every element ends its line with -- @<key>; /// lines before an element are its whole description; os:<Property>=<value> is any other property '
  + 'that differs from its default. element reads one entity, structure, variable or timer by name or @key. '
  + 'To change the data, deliver {"op":"spec","data":{"ddl":"<only the statements that change, each as read, with its -- @key>","basedOn":"<sourceSha256>"}} '
  + '(o11_deliver / studio_deliver): a statement without a key is new; the same key with another name is a rename (never a delete); '
  + 'an attribute, or a record of a values list, left out of a statement sent whole is deleted; drop <entity|static entity|index|type|site property|setting|client variable|timer> <Name>; -- @key deletes.';
