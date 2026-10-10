// Generator of the OutSystems UI catalog that ssam_discover shows for screen-creation intents (osui-catalog.mjs).
// Nothing here is written by hand: every pattern, category, description, input, event and placeholder is the library's
// own text, read from sources already in the repository and hashed into the output.
//   O11 Reactive/Mobile  kernel/catalog/ui/OutSystemsUI-2.28.1.json     (anvil ui-catalog over the OutSystemsUI producer)
//   O11 Traditional      kernel/catalog/ui/OutSystemsUIWeb-1.12.8.json  (anvil ui-catalog over the OutSystemsUIWeb producer)
//   current patterns     kernel/docs/mapa/screen-osui-inventory.json   (public, outside the Private flow, not deprecated)
//   ODC (one library)    odc-outsystemsui-signatures.json, extracted offline (`--extract-odc`) from the OutSystemsUI
//                        reference signatures of the ODC lane fixture kernel/tests/fixtures/odc/insurance-reactive-r8.oml
// Usage (repository root):
//   node platforms/odc/facade/outsystems-ui/generate.mjs                 writes catalog.json from the sources
//   node platforms/odc/facade/outsystems-ui/generate.mjs --check         exit 1 when catalog.json is not what the sources give
//   node platforms/odc/facade/outsystems-ui/generate.mjs --extract-odc   re-reads the ODC fixture with the built anvil-odc CLI
//                                                                        (offline, read-only) and rewrites the extract first
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..', '..', '..');
export const CATALOG_FILE = path.join(here, 'catalog.json');
export const ODC_EXTRACT_FILE = path.join(here, 'odc-outsystemsui-signatures.json');
export const CATALOG_SCHEMA = 'ssam-osui-catalog/1';
const EXTRACT_SCHEMA = 'ssam-osui-odc-signatures/1';
const SOURCES = {
  o11Ui: 'kernel/catalog/ui/OutSystemsUI-2.28.1.json',
  o11Web: 'kernel/catalog/ui/OutSystemsUIWeb-1.12.8.json',
  inventory: 'kernel/docs/mapa/screen-osui-inventory.json',
  odc: 'platforms/odc/facade/outsystems-ui/odc-outsystemsui-signatures.json',
};
const ODC_FIXTURE = 'kernel/tests/fixtures/odc/insurance-reactive-r8.oml';
const ODC_CLI = 'kernel/.local/lane-odc/cli/anvil-odc.dll';

const rel = p => path.relative(REPO, p).replaceAll('\\', '/');
const abs = p => path.join(REPO, ...p.split('/'));
// Hashes are of the LF-normalized text: core.autocrlf checkouts must not change a source's identity.
const sha256 = buffer => createHash('sha256').update(buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')).digest('hex');
const readText = file => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');

// Category order: layout first, then the families an author composes a screen with; any other flow follows by name.
export const CATEGORY_ORDER = ['Layouts', 'Structure', 'Adaptive', 'Responsive', 'Navigation', 'Content', 'Interaction', 'Controls', 'Numbers', 'Utilities', 'Advanced', 'Email', 'AppFeedback', 'Licenses'];
const categoryRank = c => { const i = CATEGORY_ORDER.indexOf(c); return i < 0 ? CATEGORY_ORDER.length : i; };
// The same rule as screen-osui-inventory.json's scope: public, outside the Private flow, not deprecated.
export const isCurrent = (name, flow, isPublic = true) => isPublic && flow !== 'Private' && !/^DEPRECATED_/i.test(name);

// Library text trimmed, never rewritten: whitespace collapsed, cut at a sentence or word end with an ellipsis.
const squash = s => String(s ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
function cut(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const sentence = head.lastIndexOf('. ');
  if (sentence >= max * 0.5) return head.slice(0, sentence + 1);
  const space = head.lastIndexOf(' ');
  return (space > max * 0.5 ? head.slice(0, space) : head).replace(/[\s,;:]+$/, '') + '…';
}
// One line: the first line of the description, up to 120 characters.
export function oneLine(description) {
  const first = squash(description).split('\n').map(s => s.trim()).find(Boolean) ?? '';
  return first ? cut(first, 120) : null;
}
const paragraph = (description, max) => { const p = squash(description).split(/\n\s*\n/).map(s => s.replace(/\s*\n\s*/g, ' ').trim()).find(Boolean) ?? ''; return p ? cut(p, max) : null; };
const fullText = (description, max) => { const t = squash(description).replace(/\n{3,}/g, '\n\n').trim(); return t ? cut(t, max) : null; };
const typeName = t => (t == null ? null : String(t).replace(/^[A-Za-z]+Type:|^[A-Za-z]+Signature:/, ''));
const compactObject = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)));

function pattern({ name, flow, description, truncated, inputs, events, placeholders, docs }) {
  const line = oneLine(description);
  return compactObject({
    name, category: flow, line,
    description: fullText(description, 700),
    ...(line ? {} : { descriptionMissing: true }),
    ...(truncated ? { descriptionTruncated: 'the source text was cut by its reader' } : {}),
    inputs: inputs.map(i => compactObject({ name: i.name, type: typeName(i.type), mandatory: !!i.mandatory, default: i.default ?? undefined, description: paragraph(i.description, 200) ?? undefined })),
    events: events.map(e => compactObject({ name: e.name, mandatory: !!e.mandatory, description: paragraph(e.description, 200) ?? undefined, params: (e.params ?? []).map(p => `${p.name}: ${typeName(p.type) ?? '?'}${p.mandatory ? '' : ' (optional)'}`) })),
    placeholders: placeholders.map(p => compactObject({ name: p.name, description: paragraph(p.description, 160) ?? undefined })),
    docs,
  });
}
const sortPatterns = list => list.sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

function o11Library(id, file, json, inventory, fixtureNames, extra) {
  const certified = new Map();
  for (const r of inventory.rows.filter(x => x.module === json.Name)) { if (!certified.has(r.block)) certified.set(r.block, new Set()); certified.get(r.block).add(r.fixture); }
  const docsDir = `kernel/docs/ui/${json.Name}/blocks`;
  const patterns = sortPatterns(json.Blocks.filter(b => isCurrent(b.Name, b.Flow, b.Public)).map(b => pattern({
    name: b.Name, flow: b.Flow, description: b.Description,
    inputs: (b.Inputs ?? []).map(i => ({ name: i.Name, type: i.Type, mandatory: i.Mandatory, default: i.Default, description: i.Description })),
    events: (b.Events ?? []).map(e => ({ name: e.Name, mandatory: e.Mandatory, description: e.Description, params: (e.Params ?? []).map(p => ({ name: p.Name, type: p.Type, mandatory: p.Mandatory })) })),
    placeholders: (b.Placeholders ?? []).map(p => ({ name: p.Name, description: p.Description })),
    docs: fs.existsSync(abs(`${docsDir}/${b.Name}.md`)) ? `${docsDir}/${b.Name}.md` : undefined,
  })));
  const notCertified = patterns.filter(p => !fixtureNames.every(f => certified.get(p.name)?.has(f))).map(p => p.name);
  return { id, name: json.Name, producer: json.Name, key: json.Key, version: json.Version, runtime: json.Blocks[0]?.Runtime ?? null, source: file,
    ...extra, certified: { by: SOURCES.inventory, fixtures: fixtureNames, notCertified }, patterns };
}

function odcLibrary(extract) {
  const patterns = sortPatterns(extract.blocks.filter(b => isCurrent(b.name, b.flow)).map(b => pattern({
    name: b.name, flow: b.flow, description: b.description, truncated: b.descriptionTruncated,
    inputs: b.inputs, events: b.events, placeholders: b.placeholders,
  })));
  return { id: 'odc-outsystemsui', name: extract.reference.name, producer: extract.reference.name, key: extract.reference.key, revision: extract.reference.revision, runtime: 'Reactive/Mobile (ODC library)', source: SOURCES.odc,
    capturedFrom: { fixture: extract.fixture, fixtureSha256: extract.fixtureSha256 },
    element: 'IMobileBlock:<Name>',
    instance: '{"op":"create","parent":"<placeholder or container>","type":"IMobileBlockInstanceWidget","name":"<Name>1","source":"IMobileBlock:<Name>","empty":true}; inputs `set $b/<Input> Value`, placeholders `$b/<Placeholder>`, events `set $b/<Event> Handler <screen action>`',
    reference: 'referenced by every app built from an OutSystems UI template (the fixture references the whole library); when a module lacks it: {"op":"reference","producer":"OutSystemsUI","elements":["IMobileBlock:<Name>"]} before the edits, captured by studio_deliver (platforms/odc/docs/AQUISICAO-DEPENDENCIAS.md)',
    patterns };
}

export function buildCatalog() {
  const files = Object.fromEntries(Object.entries(SOURCES).map(([k, p]) => [k, fs.readFileSync(abs(p))]));
  const json = Object.fromEntries(Object.entries(files).map(([k, b]) => [k, JSON.parse(b.toString('utf8').replace(/^﻿/, ''))]));
  if (json.odc.schemaVersion !== EXTRACT_SCHEMA) throw new Error(`${SOURCES.odc}: schemaVersion ${json.odc.schemaVersion}, expected ${EXTRACT_SCHEMA}`);
  const reactiveInstance = '{"op":"create","parent":"<placeholder or container>","type":"IMobileBlockInstanceWidget","name":"<Name>1","source":"IMobileBlock:<Name>","empty":true}; inputs `set $b/<Input> Value`, placeholders `$b/<Placeholder>`, events `set $b/<Event> Handler <screen action>` (kernel/AGENTS.md 3.3)';
  const libraries = [
    odcLibrary(json.odc),
    o11Library('o11-outsystemsui', SOURCES.o11Ui, json.o11Ui, json.inventory, ['reactive-ui', 'mobile-ui'], {
      element: 'IMobileBlock:<Name>', instance: reactiveInstance,
      reference: 'the Reactive and Mobile templates reference OutSystemsUI; a block the module lacks: {"op":"reference","producer":"OutSystemsUI","elements":["IMobileBlock:<Name>"]} with the producer bound (--producer OutSystemsUI=<snapshot.oml>; kernel/AGENTS.md 3.3)' }),
    o11Library('o11-outsystemsuiweb', SOURCES.o11Web, json.o11Web, json.inventory, ['traditional-ui'], {
      element: 'IWebBlock:<Name>',
      instance: '{"op":"create","parent":"<placeholder or container>","type":"IWebBlockInstanceWidget","name":"<Name>1","source":"IWebBlock:<Name>","empty":true}; inputs `set $b/<Input> Value`, placeholders `$b/<Placeholder>` (osui-web-patterns.json)',
      reference: 'the Traditional template references OutSystemsUIWeb; a block the module lacks: {"op":"reference","producer":"OutSystemsUIWeb","elements":["IWebBlock:<Name>"]} with the producer bound' }),
  ];
  for (const lib of libraries) {
    lib.categories = [...new Set(lib.patterns.map(p => p.category))];
    lib.counts = { patterns: lib.patterns.length, descriptionMissing: lib.patterns.filter(p => p.descriptionMissing).map(p => p.name) };
  }
  return {
    schemaVersion: CATALOG_SCHEMA,
    note: 'Generated by platforms/odc/facade/outsystems-ui/generate.mjs; do not edit. Every text is the library\'s own (trimmed); a pattern without one says descriptionMissing.',
    rule: 'current patterns only: public, outside the Private flow, not DEPRECATED_ (the scope of kernel/docs/mapa/screen-osui-inventory.json); categories are the library\'s own UI flows',
    sources: Object.entries(SOURCES).map(([id, p]) => ({ id, path: p, sha256: sha256(files[id]) })),
    appTypes: {
      'odc-reactive': { lane: 'odc', library: 'odc-outsystemsui', label: 'ODC Reactive Web app' },
      'odc-mobile': { lane: 'odc', library: 'odc-outsystemsui', label: 'ODC Mobile app', note: 'ODC has one OutSystemsUI library for Reactive and Mobile apps; the repository has no ODC Mobile capture that references it (blank-mobile.oml references only (System)), so this list is the revision referenced by the Reactive fixture' },
      'o11-reactive': { lane: 'o11', library: 'o11-outsystemsui', label: 'O11 Reactive Web app' },
      'o11-mobile': { lane: 'o11', library: 'o11-outsystemsui', label: 'O11 Mobile app', note: 'the same OutSystemsUI module as Reactive (Runtime Reactive/Mobile); every pattern is certified on the mobile-ui fixture too' },
      'o11-traditional': { lane: 'o11', library: 'o11-outsystemsuiweb', label: 'O11 Traditional Web app' },
    },
    // Words people use for a pattern whose library name they do not say (2026-10-05 package, C07): "a deck of cards",
    // "swipe cards" -> StackedCards; "a slider", "a range" -> RangeSlider. Each target is a pattern of every library that has
    // it; a word never names a pattern a library lacks (osui-catalog.mjs resolves per library).
    synonyms: { deck: 'StackedCards', decks: 'StackedCards', swipe: 'StackedCards', slider: 'RangeSlider', sliders: 'RangeSlider', range: 'RangeSlider' },
    absent: [
      { library: 'OutSystems UI Mobile (legacy O11 Mobile UI library)', note: 'no capture in the repository; the O11 mobile-ui fixture uses OutSystemsUI' },
      { library: 'Layout blocks of Reactive/Mobile/ODC apps (LayoutTopMenu, LayoutSideMenu...)', note: 'they live in the app template\'s own Common flow, not in OutSystemsUI; read them in the module (ssam_map kind MobileBlock)' },
      { library: 'RichWidgets (Traditional)', note: 'a separate library (kernel/catalog/ui/RichWidgets-unversioned.json), not part of OutSystems UI' },
    ],
    libraries,
  };
}

// ---- offline extraction of the ODC library from the lane fixture (read-only: the fixture is a capture file)
function runCli(args) {
  const r = spawnSync('dotnet', [abs(ODC_CLI), ...args], { cwd: abs('kernel'), encoding: 'utf8', maxBuffer: 1 << 30, windowsHide: true, env: { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' } });
  const text = (r.stdout ?? '').replace(/^﻿/, '');
  let json; try { json = JSON.parse(text); } catch { throw new Error(`anvil-odc ${args[0]}: no JSON (exit ${r.status}): ${(r.stderr ?? '').slice(0, 400)}`); }
  if (!json.ok) throw new Error(`anvil-odc ${args[0]}: ${json.error}`);
  return json.data;
}
export function extractOdc() {
  const fixture = path.relative(abs('kernel'), abs(ODC_FIXTURE));
  const refs = runCli(['references', '--oml', fixture]);
  const ref = refs.find(r => r.Name === 'OutSystemsUI');
  if (!ref) throw new Error(ODC_FIXTURE + ' does not reference OutSystemsUI');
  const sidecar = JSON.parse(readText(abs(ODC_FIXTURE + '.json')));
  const revision = sidecar.dependencies?.find(d => d.Name === 'OutSystemsUI')?.Revision ?? null;
  const properties = ['--max', '500', '--properties', 'Description,DataType,IsMandatory,DefaultValue'];
  const args = ['inspect', '--oml', fixture, '--path', 'Reference:OutSystemsUI', '--depth', '12', ...properties];
  const data = runCli(args);
  const walk = (n, f) => { f(n); for (const c of n.children ?? []) walk(c, f); };
  // The reader stops at depth 12 from the reference: a block whose widget tree goes deeper (placeholders inside ifs and
  // containers) is read again from its own path, so every placeholder is seen.
  const cutIn = n => { let cuts = 0; walk(n, x => { if ((x.childrenOmitted ?? 0) > 0) cuts++; }); return cuts; };
  let cutNodes = 0; const reread = [];
  const blocks = [];
  for (const flow of (data.tree.children ?? []).filter(c => c.kind === 'MobileFlowSignature')) {
    for (let b of (flow.children ?? []).filter(c => c.kind === 'MobileBlockSignature')) {
      if (cutIn(b)) { b = runCli(['inspect', '--oml', fixture, '--path', b.path, '--depth', '12', ...properties]).tree; reread.push(b.name); }
      cutNodes += cutIn(b);
      const p = b.properties ?? {};
      const kids = b.children ?? [];
      const placeholders = []; const seen = new Set();
      walk(b, n => { if (n.kind === 'PlaceholderWidgetSignature' && !seen.has(n.name)) { seen.add(n.name); placeholders.push({ name: n.name, description: n.properties?.Description ?? null }); } });
      blocks.push({
        name: b.name, flow: flow.name, key: b.key,
        description: p.Description ?? null,
        ...(b.propertiesOmitted?.['Description:text'] ? { descriptionTruncated: true } : {}),
        inputs: kids.filter(c => c.kind === 'InputParameterSignature').map(c => ({ name: c.name, type: c.properties?.DataType ?? null, mandatory: c.properties?.IsMandatory === 'True', default: c.properties?.DefaultValue ?? null, description: c.properties?.Description ?? null })),
        events: kids.filter(c => c.kind === 'BlockEventSignature').map(c => ({ name: c.name, mandatory: c.properties?.IsMandatory === 'True', description: c.properties?.Description ?? null,
          params: (c.children ?? []).filter(x => x.kind === 'InputParameterSignature').map(x => ({ name: x.name, type: x.properties?.DataType ?? null, mandatory: x.properties?.IsMandatory === 'True' })) })),
        placeholders,
      });
    }
  }
  blocks.sort((a, b) => a.flow.localeCompare(b.flow) || a.name.localeCompare(b.name));
  return { schemaVersion: EXTRACT_SCHEMA,
    note: 'Offline extract of the OutSystemsUI reference signatures of the ODC lane fixture (generate.mjs --extract-odc); descriptions longer than 400 characters are cut by the reader (descriptionTruncated). cutNodes counts nodes still cut by the depth limit after the per-block rereads.',
    fixture: ODC_FIXTURE, fixtureSha256: data.sourceSha256, reference: { name: ref.Name, key: ref.Key, revision, referenceHash: ref.ReferenceHash },
    command: 'anvil-odc ' + args.join(' ').replace(fixture, ODC_FIXTURE), rereadBlocks: reread.sort(), cutNodes, blocks };
}

const stable = value => JSON.stringify(value, null, 1) + '\n';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--extract-odc')) { const x = extractOdc(); fs.writeFileSync(ODC_EXTRACT_FILE, stable(x)); console.log(`${rel(ODC_EXTRACT_FILE)}: ${x.blocks.length} blocks, cut nodes ${x.cutNodes}`); }
  const text = stable(buildCatalog());
  if (argv.includes('--check')) {
    const current = fs.existsSync(CATALOG_FILE) ? readText(CATALOG_FILE).replace(/\r\n/g, '\n') : '';
    if (current !== text) { console.error(`${rel(CATALOG_FILE)} is stale: run node ${rel(fileURLToPath(import.meta.url))}`); process.exit(1); }
    console.log(`${rel(CATALOG_FILE)} is current`);
  } else { fs.writeFileSync(CATALOG_FILE, text); console.log(`${rel(CATALOG_FILE)}: ${Buffer.byteLength(text)} bytes`); }
}
