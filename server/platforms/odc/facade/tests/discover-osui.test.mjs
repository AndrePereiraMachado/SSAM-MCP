// The OutSystems UI section of ssam_discover (osui-catalog.mjs, outsystems-ui/): the generated catalog against its
// sources (completeness, shape, hashes, the library's own texts), which intents get the section, the levels and the
// expansions (pure), and through the public discover() on both lanes: screen intents carry the section, other intents
// do not, and the section never changes the model part at any budget. Index checks need the lane CLI and skip otherwise.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireBytes } from './fixtures/answer-wire.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildCatalog, CATALOG_FILE, isCurrent } from '../outsystems-ui/generate.mjs';
import { loadOsuiCatalog, isScreenIntent, appTypesFromIntent, appTypesFromKinds, osuiSection, osuiExpansion, APP_TYPES } from '../osui-catalog.mjs';
import { discover, laneSources, fitOutsystemsUi, stripOutsystemsUi } from '../discovery.mjs';
import { discoverAll } from '../tool-routing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8').replace(/^﻿/, ''));
const bytes = v => Buffer.byteLength(JSON.stringify(v), 'utf8');
const catalog = loadOsuiCatalog();
const lib = id => catalog.libraries.find(l => l.id === id);
const odc = laneSources('odc'); const o11 = laneSources('o11');
const odcCli = fs.existsSync(odc.cli); const o11Cli = fs.existsSync(o11.cli);
const sourcesOf = lane => (lane === 'odc' ? odc : o11);
const cliSkip = lane => (lane === 'odc' ? !odcCli && 'anvil-odc.dll not built' : !o11Cli && 'anvil.dll not built');

test('Traditional exposes RichWidgets blocks and action contracts without leaking into Reactive or ODC',()=>{
 // Above counts each library with public actions names them and the call for one contract; counts (the smallest form,
 // the one a tight page keeps) has their number only.
 const section=osuiSection({lane:'o11',appTypes:['o11-traditional']},'lines');
 const withActions=section.libraries.filter(l=>l.actions);
 assert.deepEqual(withActions.map(l=>l.library),['OutSystemsUIWeb 1.12.8','RichWidgets (version not recorded)']);
 for(const library of withActions)
  assert.deepEqual(library.actionLookup,{tool:'ssam_discover',arguments:{lane:'o11',expand:'osui:o11-traditional/actions:<Action>'}});
 const counts=osuiSection({lane:'o11',appTypes:['o11-traditional']},'counts').libraries;
 assert.deepEqual(counts.filter(l=>l.actions!==undefined).map(l=>typeof l.actions),['number','number']);
 assert.ok(counts.every(l=>l.actionLookup===undefined));
 const traditional=osuiExpansion('o11','o11-traditional');
 assert.deepEqual(traditional.libraries.map(l=>l.producer),['OutSystemsUIWeb','RichWidgets']);
 const rich=traditional.libraries.find(l=>l.producer==='RichWidgets');
 assert.ok(rich.patterns.some(p=>p.name==='List_Navigation'));
 assert.equal(rich.evidence.native,'not recorded');
 assert.equal(rich.evidence.browser,'not recorded by this catalog');
 const action=osuiExpansion('o11','o11-traditional/actions:Feedback_Message');
 assert.ok(action.libraries[0].actions[0].inputs.some(i=>i.Name==='MessageText'));
 for(const [lane,type] of [['o11','o11-reactive'],['o11','o11-mobile'],['odc','odc-reactive'],['odc','odc-mobile']])
  assert.ok(osuiExpansion(lane,type).libraries.every(l=>!['RichWidgets','OutSystemsUIWeb'].includes(l.producer)));
});

test('the catalog is what the generator gives from the hashed sources (no hand edits, no stale source)', () => {
  const fresh = buildCatalog();
  assert.deepEqual(catalog, JSON.parse(JSON.stringify(fresh)), 'catalog.json is stale: node platforms/odc/facade/outsystems-ui/generate.mjs');
  for (const s of catalog.sources) {
    const text = fs.readFileSync(path.join(root, ...s.path.split('/')), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(text).digest('hex'), s.sha256, s.path);
  }
  assert.equal(path.relative(root, CATALOG_FILE).replaceAll('\\', '/'), 'platforms/odc/facade/outsystems-ui/catalog.json');
});

test('every app type of both lanes has its library, and the lists are complete against their sources', () => {
  assert.deepEqual(Object.keys(catalog.appTypes).sort(), [...APP_TYPES.odc, ...APP_TYPES.o11].sort());
  for (const [type, t] of Object.entries(catalog.appTypes)) { assert.ok(lib(t.library), type); assert.ok(APP_TYPES[t.lane].includes(type), type); }
  const inventory = readJson('kernel/docs/mapa/screen-osui-inventory.json').rows;
  const names = (module, fixture) => inventory.filter(r => r.module === module && r.fixture === fixture).map(r => r.block).sort();
  const listed = id => lib(id).patterns.map(p => p.name).sort();
  // O11: exactly the current patterns the screen-coverage inventory certifies (Reactive and Mobile share OutSystemsUI).
  assert.deepEqual(listed('o11-outsystemsui'), names('OutSystemsUI', 'reactive-ui'));
  assert.deepEqual(listed('o11-outsystemsui'), names('OutSystemsUI', 'mobile-ui'));
  assert.deepEqual(listed('o11-outsystemsuiweb'), names('OutSystemsUIWeb', 'traditional-ui'));
  assert.equal(listed('o11-outsystemsui').length, 85); assert.equal(listed('o11-outsystemsuiweb').length, 90);
  // ODC: every current block of the OutSystemsUI reference of the lane fixture, by the same rule.
  const extract = readJson('platforms/odc/facade/outsystems-ui/odc-outsystemsui-signatures.json');
  assert.equal(extract.fixture, 'kernel/tests/fixtures/odc/insurance-reactive-r8.oml');
  assert.equal(extract.fixtureSha256, readJson('kernel/tests/fixtures/odc/insurance-reactive-r8.oml.json').sha256);
  assert.deepEqual(listed('odc-outsystemsui'), extract.blocks.filter(b => isCurrent(b.name, b.flow)).map(b => b.name).sort());
  for (const name of ['Tabs', 'Card', 'Columns2', 'DropdownSearch', 'DatePicker', 'Pagination', 'Search', 'Sidebar', 'Accordion'])
    for (const id of ['odc-outsystemsui', 'o11-outsystemsui']) assert.ok(listed(id).includes(name), `${id} ${name}`);
  for (const name of ['LayoutMenuSide', 'Panel', 'Modal', 'Dropdown', 'Tabs']) assert.ok(listed('o11-outsystemsuiweb').includes(name), name);
});

test('every pattern has the library\'s own one line (or says it has none), a library category, typed inputs and the reference it needs', () => {
  const o11Sources = { 'o11-outsystemsui': readJson('kernel/catalog/ui/OutSystemsUI-2.28.1.json'), 'o11-outsystemsuiweb': readJson('kernel/catalog/ui/OutSystemsUIWeb-1.12.8.json'), 'o11-richwidgets': readJson('kernel/catalog/ui/RichWidgets-unversioned.json') };
  const extract = readJson('platforms/odc/facade/outsystems-ui/odc-outsystemsui-signatures.json');
  const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  for (const l of catalog.libraries) {
    assert.match(l.element, /^I(Mobile|Web)Block:<Name>$/); assert.match(l.instance, /BlockInstanceWidget/); assert.match(l.reference, /"op":"reference"/);
    assert.equal(l.key, o11Sources[l.id]?.Key ?? extract.reference.key, 'the producer key of the source');
    for (const p of l.patterns) {
      assert.ok(l.categories.includes(p.category), `${l.id} ${p.name}`);
      assert.ok(!/^DEPRECATED_/.test(p.name) && p.category !== 'Private', `${l.id} ${p.name}`);
      if (p.descriptionMissing) { assert.equal(p.line, undefined); continue; }
      assert.ok(p.line.length <= 120, `${l.id} ${p.name}`);
      // Never invented: the line is the start of the source description (an ellipsis marks a cut).
      const source = l.id === 'odc-outsystemsui' ? extract.blocks.find(b => b.name === p.name).description : o11Sources[l.id].Blocks.find(b => b.Name === p.name).Description;
      assert.ok(squash(source).startsWith(p.line.replace(/…$/, '')), `${l.id} ${p.name}: "${p.line}"`);
      for (const i of p.inputs ?? []) { assert.ok(i.name && i.type, `${l.id} ${p.name} input`); assert.equal(typeof i.mandatory, 'boolean'); }
    }
  }
  // The ones the library leaves without a description are named, not filled in.
  assert.deepEqual(lib('o11-outsystemsuiweb').counts.descriptionMissing.sort(), ['LayoutEmail', 'Website_Section']);
  assert.deepEqual(catalog.libraries.filter(l=>l.id!=='o11-richwidgets').flatMap(l => l.patterns.filter(p => p.descriptionMissing).map(p => l.id + ':' + p.name)).sort(), ['o11-outsystemsuiweb:LayoutEmail', 'o11-outsystemsuiweb:Website_Section']);
  const tabs = lib('odc-outsystemsui').patterns.find(p => p.name === 'Tabs');
  assert.deepEqual(tabs.placeholders.map(x => x.name), ['Header', 'Content']);
  assert.deepEqual(tabs.events.find(e => e.name === 'OnTabChange').params, ['TabsId: Text', 'ActiveTab: Integer (optional)']);
});

test('screen-building intents get the section; refactors, logic and data do not', () => {
  for (const intent of ['criar uma tela de cadastro de clientes com formulário', 'criar um dashboard com cards e menu lateral', 'montar uma página de login', 'build a page with tabs and a card list',
    'adicionar um menu lateral ao layout', 'create a mobile screen with a bottom sheet'])
    assert.equal(isScreenIntent(intent, []), true, intent);
  assert.equal(isScreenIntent('lista de apólices com navegação para detalhe', [{ id: 'ui.list', via: 'match', why: ['list'] }]), true, 'a direct screen-building match');
  assert.equal(isScreenIntent('quero ver os pedidos', [{ id: 'ui.list', via: 'alternative', why: ['list'] }]), false, 'an alternative is not enough');
  assert.equal(isScreenIntent('criar uma entidade Order com atributo Data', [{ id: 'ui.html-page', via: 'match', why: ['data', 'date'] }]), false, 'a match by generic words only');
  for (const intent of ['renomear a tela Home', 'apagar a tela Antiga e o formulário', 'criar uma screen action que valida o total', 'criar uma ação de tela para salvar', 'criar uma entidade Order com atributo Data',
    'renomear o atributo Email da entidade Contact', 'publicar o módulo', 'consumir uma API REST com POST'])
    assert.equal(isScreenIntent(intent, intent.startsWith('renomear a tela') ? [{ id: 'ui.screen', via: 'match' }] : []), false, intent);
  assert.deepEqual(appTypesFromIntent('o11', 'criar uma tela Traditional Web de pedidos'), ['o11-traditional']);
  assert.deepEqual(appTypesFromIntent('o11', 'tela reactive e mobile'), ['o11-reactive', 'o11-mobile']);
  assert.deepEqual(appTypesFromIntent('odc', 'criar uma tela no app mobile'), ['odc-mobile']);
  assert.deepEqual(appTypesFromIntent('odc', 'criar uma tela'), []);
  assert.deepEqual(appTypesFromKinds('o11', [{ kind: 'WebScreen', count: 3 }]), ['o11-traditional']);
  assert.deepEqual(appTypesFromKinds('o11', [{ kind: 'MobileScreen', count: 2 }, { kind: 'WebScreen', count: 0 }]), ['o11-reactive', 'o11-mobile']);
  assert.deepEqual(appTypesFromKinds('odc', [{ kind: 'MobileScreen', count: 1 }]), ['odc-reactive', 'odc-mobile']);
});

test('the section groups app types by library, each level smaller than the one before; expansions answer category, pattern and app type', () => {
  const all = { lane: 'o11', appTypes: APP_TYPES.o11, from: 'lane' };
  const s = osuiSection(all, 'lines');
  // Every type of the lane (kind unknown): one library per type, as before the Traditional port; RichWidgets and the public
  // actions come only for a Traditional-only request (the first test of this file).
  assert.deepEqual(s.libraries.map(l => [l.library, l.appTypes]), [['OutSystemsUI 2.28.1', ['o11-reactive', 'o11-mobile']], ['OutSystemsUIWeb 1.12.8', ['o11-traditional']]]);
  assert.ok(s.libraries.every(l => l.actions === undefined));
  assert.ok(s.libraries[0].categories.Navigation.some(x => x.startsWith('Tabs: ')));
  const sizes = ['lines', 'names', 'counts'].map(level => bytes(osuiSection(all, level)));
  assert.ok(sizes[0] > sizes[1] && sizes[1] > sizes[2], sizes.join(' > '));
  assert.equal(typeof osuiSection(all, 'names').libraries[1].categories.Layouts, 'string');
  assert.equal(osuiSection(all, 'counts').libraries[1].categories.Layouts, 9);
  const odcSection = osuiSection({ lane: 'odc', appTypes: APP_TYPES.odc, from: 'lane' }, 'lines');
  assert.deepEqual(odcSection.libraries.map(l => [l.library, l.appTypes]), [['OutSystemsUI revision 100', ['odc-reactive', 'odc-mobile']]]);
  assert.ok(!JSON.stringify(odcSection).includes('IWebBlock'), 'no Traditional library on ODC');

  const tabs = osuiExpansion('o11', 'Tabs');
  assert.deepEqual(tabs.libraries.map(l => l.producer), ['OutSystemsUI', 'OutSystemsUIWeb'], 'one pattern name, every library of the lane that has it');
  assert.equal(tabs.level, 'full'); assert.ok(tabs.libraries[0].patterns[0].inputs.length > 0);
  assert.deepEqual(osuiExpansion('o11', 'o11-traditional/tabs').libraries.map(l => l.producer), ['OutSystemsUIWeb']);
  const nav = osuiExpansion('odc', 'navigation');
  assert.ok(nav.libraries[0].patterns.every(p => p.category === 'Navigation'));
  assert.equal(osuiExpansion('odc', 'odc-mobile').libraries[0].patterns.length, lib('odc-outsystemsui').patterns.length);
  const small = osuiExpansion('o11', 'Interaction', { capBytes: 6000 });
  assert.notEqual(small.level, 'full'); assert.match(small.note, /reduced/);
  assert.match(osuiExpansion('odc', 'Layouts').error, /no OutSystems UI category or pattern/);
  assert.match(osuiExpansion('odc', 'o11-traditional/Tabs').error, /unknown app type/);
});

test('fitOutsystemsUi never changes the model part: richest level that fits, metadata yields only for the compact list, else a note', () => {
  const model = { ok: true, lane: 'odc', intent: 'x', identity: { lane: 'odc', index: 'k', cli: 'c', kernel: 'k', studio: null, keyStrategy: 'x'.repeat(3000) }, matches: [{ id: 'ui.screen', via: 'match', notes: 'n'.repeat(500) }],
    contracts: { a: { b: 1 } }, examples: { 'ui.screen': { ops: [1, 2, 3] } }, relatedJobs: ['j'.repeat(1000)], validation: { prove: 'p' }, continuation: { omitted: [] }, size: { bytes: 0, budgetBytes: 0, status: 'within', truncated: [] } };
  const request = { lane: 'odc', appTypes: APP_TYPES.odc, from: 'lane' };
  const keep = a => ({ matches: a.matches.map(m => m.id + ':' + m.via), contracts: a.contracts, examples: a.examples });
  const base = bytes(model);
  const runs = []; const fit = (m, B) => { const a = fitOutsystemsUi(structuredClone(m), request, B); runs.push([a, B]); return a; };
  const lines = fit(model, base + 20000);
  assert.equal(lines.outsystemsUi.level, 'lines'); assert.equal(lines.size.status, 'within');
  assert.deepEqual(Object.keys(lines).indexOf('outsystemsUi') < Object.keys(lines).indexOf('validation'), true);
  const names = fit(model, base + bytes(osuiSection(request, 'names')) + 300);
  assert.equal(names.outsystemsUi.level, 'names'); assert.equal(names.size.status, 'reduced'); assert.deepEqual(names.size.truncated.map(t => t.section), ['outsystemsUi']);
  const yielded = fit(model, base + bytes(osuiSection(request, 'names')) - 2500);
  assert.equal(yielded.outsystemsUi.level, 'names'); assert.ok(yielded.size.truncated.some(t => ['relatedJobs', 'identity'].includes(t.section)), JSON.stringify(yielded.size.truncated));
  assert.equal(yielded.matches[0].notes, model.matches[0].notes, 'the matches never yield');
  // Nothing outside the matches to yield: the counts, else only the note.
  const lean = { ...structuredClone(model), identity: null, relatedJobs: [] };
  const counts = fit(lean, bytes(lean) + bytes(osuiSection(request, 'counts')) + 300);
  assert.equal(counts.outsystemsUi.level, 'counts');
  const none = fit(lean, bytes(lean) + 400);
  assert.equal('outsystemsUi' in none, false); assert.deepEqual(none.size.truncated.map(t => t.section), ['outsystemsUi']);
  assert.match(none.size.truncated[0].recover, /osui:<Category>/);
  assert.equal(runs.length, 5);
  for (const [a, B] of runs) { assert.deepEqual(keep(a), keep(model)); assert.ok(a.size.bytes <= B, `${a.size.bytes} > ${B}`); }
  assert.deepEqual(stripOutsystemsUi(names).size.truncated, []);
  // An insufficient model answer keeps only the counts (and the named patterns), and only when they fit (2026-10-05, C07:
  // the OutSystems UI list is never the first thing lost).
  const insufficient = { ok: true, lane: 'odc', matches: [{ id: 'ui.screen', via: 'match' }], size: { bytes: 0, budgetBytes: 4096, status: 'insufficient', minimalBytes: 9000 } };
  assert.equal(fitOutsystemsUi(structuredClone(insufficient), request, 99999).outsystemsUi.level, 'counts', 'an insufficient model answer keeps the counts');
  assert.equal(fitOutsystemsUi(structuredClone(insufficient), request, 200).outsystemsUi, undefined, 'nothing when even the counts do not fit');
  assert.equal(fitOutsystemsUi(model, null, 99999), model, 'no request, no change');
});

test('o11: with a capture the app type comes from the module (Traditional -> OutSystemsUIWeb, Reactive -> OutSystemsUI)', { skip: cliSkip('o11'), timeout: 600000 }, async () => {
  const { laneInspect, laneMap } = await import('../discovery.mjs');
  for (const [fixture, types, library] of [['traditional-ui', ['o11-traditional'], 'OutSystemsUIWeb 1.12.8'], ['reactive-ui', ['o11-reactive', 'o11-mobile'], 'OutSystemsUI 2.28.1']]) {
    const a = await discover({ lane: 'o11', intent: 'criar uma tela de pedidos com tabs', app: path.join(root, 'kernel', 'tests', 'fixtures', fixture + '.oml'), sources: o11, inspect: laneInspect('o11'), map: laneMap('o11'), budgetBytes: 120000 });
    assert.equal(a.context?.ok, true, fixture);
    assert.deepEqual(a.outsystemsUi.appTypes, types, fixture); assert.equal(a.outsystemsUi.appTypeFrom, 'capture');
    assert.deepEqual(a.outsystemsUi.libraries.map(l => l.library), fixture==='traditional-ui' ? [library,'RichWidgets (version not recorded)'] : [library]);
  }
});

// ---- the public entry on both lanes
const SCREEN = { odc: 'criar um dashboard com cards e menu lateral', o11: 'criar um dashboard com cards e menu lateral' };
const NON_SCREEN = ['renomear o atributo Email da entidade Contact', 'criar uma entidade Order com atributo Data'];
for (const lane of ['odc', 'o11']) {
  test(`${lane}: a screen intent carries the lane's OutSystems UI section; other intents do not`, { skip: cliSkip(lane), timeout: 600000 }, async () => {
    const sources = sourcesOf(lane);
    // This assertion asks for the full library lines; the first-answer default is
    // deliberately compact and its counts form is covered by the budget tests.
    const a = await discoverAll({ lane, intent: SCREEN[lane], sources, budgetBytes: 120000 });
    assert.ok(a.outsystemsUi, JSON.stringify(a.size));
    assert.equal(a.outsystemsUi.lane, lane); assert.deepEqual(a.outsystemsUi.appTypes, APP_TYPES[lane]); assert.equal(a.outsystemsUi.level, 'lines');
    assert.ok(a.outsystemsUi.libraries.every(l => l.patterns > 0 && Object.keys(l.categories).length > 0));
    assert.ok(wireBytes(a) <= a.size.budgetBytes);
    if (lane === 'o11') {
      const t = await discover({ lane, intent: 'criar uma tela Traditional de pedidos com tabs', sources, budgetBytes: 120000 });
      assert.deepEqual(t.outsystemsUi.appTypes, ['o11-traditional']); assert.equal(t.outsystemsUi.appTypeFrom, 'intent');
      assert.deepEqual(t.outsystemsUi.libraries.map(l => l.library), ['OutSystemsUIWeb 1.12.8','RichWidgets (version not recorded)']);
    }
    for (const intent of NON_SCREEN) {
      const n = await discoverAll({ lane, intent, sources });
      assert.equal('outsystemsUi' in n, false, intent);
      assert.ok(!(n.size?.truncated ?? []).some(t => t.section === 'outsystemsUi'), intent);
    }
    const x = await discover({ lane, expand: 'osui:Tabs,osui:Navigation', sources, budgetBytes: 4096 });
    assert.equal(x.ok, true); assert.ok(wireBytes(x, { budgetBytes: 4096 }) <= 4096, JSON.stringify(x.size)); assert.equal(x.size.status === 'insufficient', false);
    assert.deepEqual(Object.keys(x.expansions).sort(), ['osui:Navigation', 'osui:Tabs']);
  });

  test(`${lane}: the section never changes matches, contracts, examples, bindings or context beyond its declared byte floor`, { skip: cliSkip(lane), timeout: 900000 }, async () => {
    const sources = sourcesOf(lane);
    const model = a => ({ matches: a.matches, contracts: a.contracts, examples: a.examples, bindings: a.bindings, context: a.context, composition: a.composition, unavailable: a.unavailable });
    for (const intent of [SCREEN[lane], 'criar uma tela de cadastro de clientes com formulário']) for (const budgetBytes of [4096, 8000, 12000, 24576, 40960, 131072]) {
      // The text route of a screen intent (B2 of the plan "Texto do SSAM") is fitted after this section with a floor of its
      // own (size.reserved.textRoute): left out here, so the comparison is about this section alone.
      const withSection = await discover({ lane, intent, sources, budgetBytes, textRoutes: false });
      // The model part is budgeted under the floor the answer declares (size.reserved.outsystemsUi, C07): it is exactly
      // the answer without the section at the budget minus that floor.
      const reserved = withSection.size.reserved?.outsystemsUi ?? 0;
      const without = await discover({ lane, intent, sources, budgetBytes: budgetBytes - reserved, outsystemsUi: false, textRoutes: false });
      assert.equal('outsystemsUi' in without, false);
      if (withSection.size.status !== 'insufficient') assert.ok(withSection.outsystemsUi || withSection.size.truncated.some(t => t.section === 'outsystemsUi'), `${lane} ${budgetBytes}: the section or its note`);
      // identity, relatedJobs and notes may yield to the compact list; the model part may not.
      assert.deepEqual(model(withSection), model(without), `${lane} ${budgetBytes} ${intent}`);
      assert.ok(wireBytes(withSection, { budgetBytes }) <= budgetBytes, `${lane} ${budgetBytes}: ${withSection.size.bytes}`);
      const sections = a => (a.size.truncated ?? []).map(t => t.section);
      const left = sections(withSection).filter(s => !sections(without).includes(s));
      // c07: the proven example, step grammar and values fitted after the model part (2026-10-05), never a model reduction.
      assert.ok(left.every(s => ['outsystemsUi', 'relatedJobs', 'identity', 'notes', 'coverage.shared', 'c07'].includes(s)), left.join(','));
      if (budgetBytes === 131072) assert.equal(withSection.outsystemsUi?.level, 'lines', `${lane} ${intent}: room for the whole list`);
    }
  });
}
