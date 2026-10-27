import './fixtures/isolated-profile.mjs';
// Family F4 (2026-10-22): discovery respects the app kind and answers the question. The audit of an O11 Traditional
// migration: a Traditional request went to the prototype importer (Reactive/Mobile only), the Reactive ui.dropdown recipe
// came for a Traditional ComboBox, a question about operation history got forms, dropdowns and module delivery, and the
// first packet came with null sections. The rules (app-kinds.mjs, discovery.mjs, tool-routing.mjs, work-packet.mjs): the
// app kind is a hard filter derived from where each capability was proven, applied after the whole lane is ranked; a
// question about SSAM's own records gets the read tools; a packet section is filled or omitted, never null. The second
// part (F4 review of f1495713) has one test per finding. The index tests need the lane CLIs built (as every discover test);
// nothing here opens a Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, laneMap, laneDigest, laneInspect, requestKinds } from '../discovery.mjs';
import { discoverAll, questionOf, loadToolRoutes, routeTools } from '../tool-routing.mjs';
import * as kinds from '../app-kinds.mjs';
import { APP_KINDS, KIND_LAYER, kindsFromIntent, kindReading, kindsFromFlows, kindOfModuleType, typeLayer, kindDeclarations, indexForKinds, textRouteOffered, fixtureKind, FIXTURE_KINDS, nativeTypesNamed } from '../app-kinds.mjs';
import { snapshotSources } from './fixtures/discovery-results.mjs';
import { scoreCorpus, inputOf } from './fixtures/discover-kind-score.mjs';
import { anvilRoot } from '../workspace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const S = {}; const sourcesOf = lane => (S[lane] ??= snapshotSources(lane));
const cliBuilt = ['o11', 'odc'].every(lane => fs.existsSync(sourcesOf(lane).cli));
const skip = cliBuilt ? false : 'the lane CLIs are not built';
const I = {}; const indexOf = async lane => (I[lane] ??= (await buildIndex(lane, { sources: sourcesOf(lane) })).index);
const fixture = name => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));
const ask = input => discoverAll({ ...input, sources: sourcesOf(input.lane) }).then(a => JSON.parse(JSON.stringify(a)));
const direct = a => (a.matches ?? []).filter(m => m.via === 'match').map(m => m.id);
const ids = a => (a.matches ?? []).map(m => m.id);
const FIXTURES = path.join(anvilRoot, 'tests', 'fixtures');
// The real module map reads a capture only with the trusted controller's key: a synthetic one in this process's own
// isolated profile (never a real authority directory).
const authority = process.env.ANVIL_AUTHORITY_DIR ?? '';
const isolated = !!authority && path.resolve(authority).toLowerCase().startsWith(path.resolve(fs.realpathSync(os.tmpdir())).toLowerCase());
if (isolated) { fs.mkdirSync(authority, { recursive: true }); if (!fs.existsSync(path.join(authority, 'bridge.key'))) fs.writeFileSync(path.join(authority, 'bridge.key'), 'SYNTHETIC-TEST-KEY'); }
const realSkip = skip || (isolated ? false : 'no isolated profile for a synthetic controller key');

// ---- pure: how the kind of a request is known
test('the kind words of an intent: a kind that qualifies what is built, the target of a migration, the kinds of the lane', () => {
  assert.deepEqual(kindsFromIntent('o11', 'Traditional ComboBox with a filtered list'), ['o11-traditional']);
  assert.deepEqual(kindsFromIntent('o11', 'criar uma tela tradicional'), ['o11-traditional']);
  assert.deepEqual(kindReading('o11', 'Exact Reactive to Traditional migration'), { kinds: ['o11-traditional'], source: ['o11-reactive'], migration: true });
  assert.deepEqual(kindReading('o11', 'Migrar o portal Traditional para Reactive'), { kinds: ['o11-reactive'], source: ['o11-traditional'], migration: true });
  assert.deepEqual(kindsFromIntent('o11', 'add a screen to the mobile app'), ['o11-mobile']);
  for (const intent of ['consume a web service', 'native dropdown bound to a list', 'add a phone number input', 'responsive layout']) assert.deepEqual(kindsFromIntent('o11', intent), [], intent);
  assert.deepEqual(kindsFromIntent('odc', 'Traditional ComboBox in the Reactive app'), ['odc-reactive']);
  assert.deepEqual(kindsFromIntent('odc', 'Traditional ComboBox'), []);
});
test('the kind of a module type and of the flows of a capture', () => {
  assert.equal(kindOfModuleType('o11', 'WebResponsive'), 'o11-traditional');
  assert.equal(kindOfModuleType('o11', 'CrossDevice'), 'o11-reactive');
  assert.equal(kindOfModuleType('o11', 'Mobile'), 'o11-mobile');
  assert.equal(kindOfModuleType('o11', 'Service'), 'o11-library');
  assert.equal(kindOfModuleType('odc', 'CrossDevice'), 'odc-reactive');
  assert.equal(kindOfModuleType('odc', 'WebResponsive'), null, 'no Traditional kind on ODC');
  assert.deepEqual(kindsFromFlows('o11', { web: 2, mobile: 0 }), ['o11-traditional']);
  assert.deepEqual(kindsFromFlows('o11', { web: 0, mobile: 0 }), ['o11-library']);
  assert.equal(typeLayer('OutSystems.Model.UI.Web.Widgets.IComboBoxWidget'), 'web');
  assert.equal(typeLayer('ServiceStudio.Plugin.NRWidgets.IDropdown'), 'client');
  assert.equal(typeLayer('OutSystems.Model.Logic.IClientAction'), 'client');
  assert.equal(typeLayer('OutSystems.Model.Data.IServerEntity'), null);
  for (const [file, kind] of Object.entries(FIXTURE_KINDS)) {
    assert.ok(fs.existsSync(path.join(FIXTURES, file)), file);
    assert.equal(fixtureKind('tests/fixtures/' + file), kind);
  }
});
test('the text routes declare their layer: ssam-html/1 is the client layer only, data and logic texts every kind', () => {
  for (const kind of ['o11-traditional', 'o11-library']) { assert.equal(textRouteOffered('ui.screen-html', [kind]), false, kind); assert.equal(textRouteOffered('ui.screen-html-edit', [kind]), false, kind); }
  for (const kind of [...APP_KINDS.o11, ...APP_KINDS.odc]) { assert.equal(textRouteOffered('data.ddl', [kind]), true); assert.equal(textRouteOffered('logic.flow', [kind]), true); }
  for (const kind of ['o11-reactive', 'o11-mobile', 'odc-reactive', 'odc-mobile']) assert.equal(textRouteOffered('ui.screen-html', [kind]), true, kind);
});

// ---- index: every capability declares its kinds, derived from its proofs and element types (a generated sweep)
test('every capability of both lanes declares the kinds it supports, and a UI one only where its layer was proven', { skip }, async () => {
  for (const lane of ['o11', 'odc']) {
    const index = await indexOf(lane);
    const { byId } = kindDeclarations(index);
    assert.equal(byId.size, index.capabilities.length, lane + ': a declaration for every capability');
    for (const c of index.capabilities) {
      const d = byId.get(c.id);
      const natives = [...(c.elements ?? []).map(e => e.native), ...(c.native ?? [])].filter(Boolean);
      const layers = new Set(natives.map(typeLayer).filter(Boolean));
      // Derived from the native metadata: a capability whose types have no UI layer is layer-neutral (every kind of its
      // lane); a UI capability is offered only for a kind of a layer its types hold, with a proof on that layer.
      if (natives.length && !layers.size) assert.deepEqual(d.offered, APP_KINDS[lane], `${c.id}: layer-neutral types, every kind`);
      for (const kind of d.offered) {
        assert.ok(APP_KINDS[lane].includes(kind), `${c.id}: ${kind} is a kind of ${lane}`);
        if (d.scope !== 'ui') continue;
        assert.ok(KIND_LAYER[kind], `${c.id}: a UI capability is never offered for a library`);
        if (layers.size) assert.ok(layers.has(KIND_LAYER[kind]), `${c.id}: offered for ${kind} without a ${KIND_LAYER[kind]} type`);
        assert.ok(d.provenOn.some(p => KIND_LAYER[p] === KIND_LAYER[kind]), `${c.id}: offered for ${kind} with no proof on its layer`);
      }
    }
    for (const kind of APP_KINDS[lane]) {
      const view = indexForKinds(index, [kind]);
      for (const c of view.capabilities) assert.ok(byId.get(c.id).offered.includes(kind), `${kind}: ${c.id}`);
      for (const c of view.capabilities) for (const d of c.depends ?? []) assert.ok(view.capabilities.some(k => k.id === (d.id ?? d)), `${kind}: ${c.id} depends on ${d.id ?? d}, left out`);
      for (const j of view.jobs) assert.ok(kinds.jobAdmissible(index, j, [kind]), `${kind}: job ${j.name}`);
    }
  }
  const o11 = kindDeclarations(await indexOf('o11')).byId;
  assert.deepEqual(o11.get('ui.dropdown').offered, ['o11-reactive', 'o11-mobile']);
  assert.deepEqual(o11.get('ui.traditional-widget').offered, ['o11-traditional']);
  assert.ok(o11.get('data.entity').offered.includes('o11-traditional') && o11.get('data.entity').scope === 'module');
});

// ---- the audit's cases
test('a Traditional ComboBox gets the Traditional web widgets, never the Reactive dropdown recipes', { skip }, async () => {
  const intent = 'Traditional ComboBox with a filtered list, identifier, label and OnChange event';
  for (const extra of [{}, { budgetBytes: 12000 }, { packet: true }]) {
    const a = await ask({ lane: 'o11', intent, ...extra });
    const got = extra.packet ? a.capabilities.items.map(x => x.id) : direct(a);
    assert.equal(got[0], 'ui.traditional-widget', JSON.stringify(got));
    for (const id of ['ui.dropdown', 'ui.dropdown-search', 'ui.screen', 'ui.form']) assert.ok(!JSON.stringify(extra.packet ? a.capabilities : a.matches).includes(`"${id}"`), id);
    assert.deepEqual(a.kind.for, ['o11-traditional']); assert.equal(a.kind.from, 'intent');
    assert.ok(!a.textRoute && !a.text, 'no ssam-html/1 route for a Traditional screen');
  }
});
test('a question about history, status, receipts, friction or tasks of SSAM routes to the read tools, never to authoring', { skip }, async () => {
  for (const [lane, intent, first] of [['o11', 'what changed in the operation history of the last deliveries', 'ssam_task'], ['o11', 'histórico das operações', 'ssam_task'],
    ['odc', 'show the history of operations of this session', 'ssam_friction'], ['o11', 'status of my last delivery', 'ssam_task'], ['o11', 'show the receipt of the last publish', 'ssam_evidence'],
    ['odc', 'ver as fricções registradas', 'ssam_friction']]) {
    const a = await ask({ lane, intent });
    assert.equal(a.tools?.[0]?.tool, first, `${intent}: ${JSON.stringify(a.tools)}`);
    for (const k of ['matches', 'contracts', 'examples', 'provenExample', 'textRoute', 'outsystemsUi', 'bindings']) assert.ok(!(k in a), `${intent}: ${k}`);
    assert.ok(a.tools.every(t => t.tool && !/write|delete|close/.test(t.verb ?? '')), 'a question is never offered a writer');
  }
});

// ---- F4 review of f1495713: one test per finding (each fails on f1495713)
test('review 1: real Traditional, Reactive, Mobile and Service captures through the real module map get their own kind', { skip: realSkip, timeout: 900000 }, async () => {
  const want = { 'traditional-ui.oml': ['o11-traditional'], 'reactive-ui.oml': ['o11-reactive', 'o11-mobile'], 'mobile-ui.oml': ['o11-reactive', 'o11-mobile'], 'blank-service.oml': ['o11-library'] };
  const map = laneMap('o11');
  for (const [file, expected] of Object.entries(want)) {
    const app = path.join(FIXTURES, file);
    const scope = await requestKinds({ lane: 'o11', intent: 'add a dropdown bound to the list of Departments on the screen', app, map });
    assert.deepEqual(scope?.kinds, expected, `${file}: ${JSON.stringify(scope)}`);
    const a = await ask({ lane: 'o11', intent: 'add a dropdown bound to the list of Departments on the screen', app, map, inspect: laneInspect('o11', null) });
    assert.deepEqual(a.kind?.for, expected, file);
    if (expected.includes('o11-reactive')) assert.ok(direct(a).includes('ui.dropdown') && !ids(a).some(id => id.startsWith('ui.traditional')), `${file}: ${direct(a)}`);
    if (a.outsystemsUi) assert.ok(a.outsystemsUi.appTypes.every(t => expected.includes(t)), `${file}: osui ${a.outsystemsUi.appTypes}`);
    // The packet reads the module type itself (the digest) and agrees.
    const p = await ask({ lane: 'o11', intent: 'create an entity Invoice with attributes Number and Total', app, packet: true, budgetBytes: 12000 });
    assert.equal(p.kind?.for?.[0], expected[0] === 'o11-reactive' ? { 'reactive-ui.oml': 'o11-reactive', 'mobile-ui.oml': 'o11-mobile' }[file] : expected[0], file);
  }
});
test('review 2: a build worded with status, task, history or receipt is a build request; only SSAM records make a question', { skip }, async () => {
  const compiled = loadToolRoutes();
  for (const [lane, intent] of [['o11', 'list the orders by status'], ['o11', 'mostrar o status do pedido na lista'], ['o11', 'get the task list from the REST API'],
    ['o11', 'read the receipt PDF and store it in the database'], ['odc', 'consultar o histórico de compras do cliente via REST'], ['o11', 'on the phone app, show the tasks in a list'],
    ['o11', 'show the order history'], ['o11', 'listar o histórico de pedidos do cliente'], ['o11', 'create a history entity for orders'], ['o11', 'publish the module'],
    ['o11', 'close the refused delivery task'], ['o11', 'what errors can the CreateOrder action raise?'], ['o11', 'status']]) {
    assert.equal(questionOf(intent, compiled, routeTools({ intent, lane }, compiled)), null, intent);
    const a = await ask({ lane, intent });
    assert.ok(!a.question, `${intent}: answered as a question`);
  }
  for (const intent of ['which SSAM errors happened today', 'list recent tasks', 'read the journal of the last delivery', 'did the publish finish?', 'a minha entrega já terminou?'])
    assert.ok(questionOf(intent, compiled), intent);
});
test('review 3: a ui capability whose types have no UI layer serves every kind; a removed main need keeps its note', { skip }, async () => {
  const o11 = kindDeclarations(await indexOf('o11')).byId;
  for (const id of ['ui.flow-comment', 'ui.script-resource']) for (const kind of ['o11-traditional', 'o11-library']) assert.ok(o11.get(id).offered.includes(kind), `${id} for ${kind}`);
  assert.equal(direct(await ask(inputOf({ lane: 'o11', intent: 'add an image resource logo.png to the module', from: 'capture', moduleType: 'Service' })))[0], 'ui.script-resource');
  assert.ok(direct(await ask(inputOf({ lane: 'o11', intent: 'add a comment to the flow of the server action CalculateTotal', from: 'capture', moduleType: 'Service' }))).includes('ui.flow-comment'));
  assert.ok(direct(await ask(inputOf({ lane: 'o11', intent: 'add a JavaScript script to the module and include it in the screen', from: 'capture', moduleType: 'WebResponsive' }))).includes('ui.script-resource'));
  for (const [moduleType, intent] of [['WebResponsive', 'change the CSS of the theme'], ['WebResponsive', 'add a client variable and a data action to the screen'], ['Service', 'create a screen with a list of invoices']]) {
    const a = await ask(inputOf({ lane: 'o11', intent, from: 'capture', moduleType }));
    assert.match(a.kind?.noRecipe ?? '', /^no proven recipe for /, `${intent}: ${JSON.stringify(a.kind)}`); assert.ok(a.kind.native.call.tool === 'ssam_discover');
  }
});
test('review 4: the whole lane is ranked first: no weak match promoted, the tools unchanged by the kind, the note kept when insufficient', { skip }, async () => {
  for (const [intent, noise] of [['add an input and a save button to the Edit screen', 'integration.rest-consume'], ['criar uma tela de listagem de pedidos', 'data.structure'], ['change the CSS of the theme', 'data.records']]) {
    const a = await ask(inputOf({ lane: 'o11', intent, from: 'capture', moduleType: 'WebResponsive' }));
    assert.ok(!direct(a).includes(noise), `${intent}: ${direct(a)}`);
  }
  // The tools of a request never change because the kind is known, unless the kind makes a tool wrong.
  for (const intent of ['add a JavaScript script to the module and include it in the screen', 'add a resource file template.xlsx to the module, deployed to the target directory', 'add an image resource logo.png to the module',
    'add a module reference to the Orders producer and refresh it', 'create a timer that sends the daily report email', 'rename the screen Orders to OrderList and fix every reference']) {
    const tools = a => (a.tools ?? []).map(t => t.tool + (t.verb ? '.' + t.verb : '')).join(',');
    const plain = await ask({ lane: 'o11', intent });
    for (const moduleType of ['WebResponsive', 'Service', 'CrossDevice']) assert.equal(tools(await ask(inputOf({ lane: 'o11', intent, from: 'capture', moduleType }))), tools(plain), `${intent} on ${moduleType}`);
  }
  // Insufficient at a tiny budget: the kind and its note survive.
  const small = await discoverAll({ ...inputOf({ lane: 'o11', intent: 'add a client variable and a data action to the screen', from: 'capture', moduleType: 'WebResponsive' }, sourcesOf('o11')), budgetBytes: 4096, ceilingBytes: null });
  assert.ok(small.kind?.noRecipe, JSON.stringify(small).slice(0, 400));
});
test('review 5: the labelled corpora (precision gate): judged by hand labels only, an adversarial set without the kind words', { skip, timeout: 900000 }, async t => {
  const main = fixture('discover-kind-corpus.json'); const adversarial = fixture('discover-kind-adversarial.json');
  for (const kind of [...APP_KINDS.o11, ...APP_KINDS.odc]) assert.ok(main.items.filter(i => i.kind === kind && !i.class).length >= 10, kind + ': at least 10 intents');
  const hard = adversarial.items.filter(i => ['o11-traditional', 'o11-library', 'o11-mobile'].includes(i.kind));
  assert.ok(hard.length >= 40, 'at least 40 Traditional, Service and Mobile rewordings');
  for (const i of hard) assert.doesNotMatch(i.intent, /traditional|tradicional|combo box/i, i.id);
  for (const i of [...main.items, ...adversarial.items]) assert.ok(Array.isArray(i.forbid) && i.expect, `${i.id}: hand labels`);
  const results = {};
  for (const [name, corpus] of [['main', main], ['adversarial', adversarial]]) {
    const r = await scoreCorpus({ items: corpus.items, sets: corpus.sets, discoverAll: x => discoverAll(x), sourcesOf });
    results[name] = r;
    t.diagnostic(`${name}: ${r.precise}/${r.total} precise, relevant ${r.relevant}, top-1 ${r.top1}, answers with a forbidden label ${r.forbidden}; ${JSON.stringify(r.byKind)}`);
    for (const row of r.rows.filter(x => !x.precise)) t.diagnostic(`  ${row.id} ${row.kind}: ${row.got} ${row.forbidden.join('; ')}`);
    assert.equal(r.forbidden, 0, `${name}: no answer carries a forbidden capability`);
  }
  assert.equal(results.main.precise, results.main.total, 'main corpus: every intent relevant for its kind');
  assert.ok(results.adversarial.precise / results.adversarial.total >= 0.95, `adversarial ${results.adversarial.precise}/${results.adversarial.total}`);
});
test('review 6: a migration is answered for its target and names its source; the kind words count only as the object', { skip }, async () => {
  const a = await ask(inputOf({ lane: 'o11', intent: 'migrate this Traditional screen to Reactive with a dropdown and a form', from: 'capture', moduleType: 'WebResponsive' }));
  assert.deepEqual(a.kind.for, ['o11-reactive']); assert.deepEqual(a.kind.source.for, ['o11-traditional']);
  assert.ok(direct(a).some(id => ['ui.dropdown', 'ui.form', 'ui.screen'].includes(id)) && !ids(a).some(id => id.startsWith('ui.traditional')), JSON.stringify(direct(a)));
  assert.deepEqual(kindsFromIntent('o11', 'port the Traditional screens to the new Reactive app'), ['o11-reactive']);
  assert.deepEqual(kindsFromIntent('o11', 'Traditional as well as Reactive screens').sort(), ['o11-reactive', 'o11-traditional']);
  for (const intent of ['the screen should look good on mobile', 'the old way, the traditional approach: create a server action that loops the orders', 'use the traditional OnChange pattern in the dropdown'])
    assert.deepEqual(kindsFromIntent('o11', intent), [], intent);
  assert.deepEqual(kindsFromIntent('o11', 'add a mobile phone input to the Traditional registration form'), ['o11-traditional']);
});
test('review 7: packets of real captures at 6000, 8192 and 12000 bytes: no null, the next step there or said, every cut recovers, a compact kind', { skip: realSkip, timeout: 900000 }, async () => {
  for (const file of ['traditional-ui.oml', 'blank-service.oml']) for (const intent of ['add a dropdown bound to the list of Departments on the screen', 'create an entity Invoice with attributes Number and Total'])
    for (const budgetBytes of [6000, 8192, 12000]) {
      const app = path.join(FIXTURES, file);
      const p = await ask({ lane: 'o11', intent, app, packet: true, budgetBytes });
      assert.equal(p.ok, true, `${file} ${budgetBytes}: ${JSON.stringify(p).slice(0, 200)}`);
      const sections = ['module', 'text', 'environment', 'capabilities', 'example', 'rules', 'next'];
      for (const id of sections) assert.notEqual(p[id], null, `${file} ${budgetBytes}: ${id} null`);
      assert.ok('capabilities' in p || p.text || p.packet.note, `${file} ${budgetBytes}: neither capabilities nor text, and no note`);
      assert.ok(Buffer.byteLength(JSON.stringify(p.kind ?? {})) <= 400, `kind ${Buffer.byteLength(JSON.stringify(p.kind ?? {}))} bytes`);
      if (budgetBytes === 8192) for (const cut of p.cuts) {
        const part = await ask({ lane: 'o11', ...cut.recover.arguments });
        assert.equal(part.ok, true, `${cut.section}: ${JSON.stringify(part).slice(0, 200)}`); assert.equal(part.section, cut.section); assert.ok(part.missing?.length);
      }
    }
});
test('review 8: the native path is kind-specific: a Traditional form is never the Reactive IForm, a rename never IReference', { skip }, async () => {
  const view = indexForKinds(await indexOf('o11'), ['o11-traditional']);
  for (const intent of ['criar uma tela de cadastro de clientes com formulário e botão salvar no app tradicional', 'add a form to the screen', 'rename the screen Orders to OrderList and fix every reference'])
    for (const type of nativeTypesNamed(view, ['o11-traditional'], intent)) assert.equal(typeLayer(type), 'web', `${intent}: ${type}`);
  const rename = await ask(inputOf({ lane: 'o11', intent: 'rename the screen Orders to OrderList and fix every reference', from: 'capture', moduleType: 'WebResponsive' }));
  assert.doesNotMatch(JSON.stringify(rename.kind?.native ?? {}), /IReference/);
  const form = await ask(inputOf({ lane: 'o11', intent: 'add a form with an input and a button to the screen', from: 'capture', moduleType: 'WebResponsive' }));
  assert.doesNotMatch(JSON.stringify(form.kind?.native ?? {}), /NRWidgets/);
  const short = await ask({ lane: 'o11', type: 'IForm' }); const exact = await ask({ lane: 'o11', type: 'ServiceStudio.Plugin.Widgets.IForm' });
  const [s, e] = [Object.values(short.expansions)[0], Object.values(exact.expansions)[0]];
  assert.ok(s.ambiguous?.also?.includes('ServiceStudio.Plugin.Widgets.IForm') || s.type === 'ServiceStudio.Plugin.Widgets.IForm', JSON.stringify(s).slice(0, 300));
  assert.equal(e.type, 'ServiceStudio.Plugin.Widgets.IForm');
});
test('review 9: the same answer with or without a kind word; English why; the vocabulary exemption is the tables only', { skip }, async () => {
  for (const [lane, unproven, words] of [['o11', 'ui.dropdown-search', ['create a searchable dropdown in the screen', 'create a searchable dropdown in the Reactive screen']], ['odc', 'ui.html-page', ['create an HTML page for the orders', 'create an HTML page for the orders in the Reactive app']]]) {
    for (const intent of words) { const a = await ask({ lane, intent }); assert.ok(!ids(a).includes(unproven), `${lane} ${intent}: ${ids(a)}`); }
    const plain = await ask({ lane, intent: words[0] });
    assert.ok(!plain.kind, 'an answer of unknown kind carries no kind section');
  }
  const q = questionOf('histórico das operações desta sessão');
  assert.ok(q.why.every(w => /^SSAM [a-z]+ record$/.test(w)), JSON.stringify(q.why));
  const english = fs.readFileSync(path.join(here, 'english-only-answers.test.mjs'), 'utf8');
  assert.match(english, /'platforms\/odc\/facade\/request-vocabulary\.mjs'/); assert.doesNotMatch(english, /'platforms\/odc\/facade\/app-kinds\.mjs'/);
  const vocabulary = await import('../request-vocabulary.mjs');
  assert.ok(Object.values(vocabulary).every(v => typeof v === 'string' || (v && typeof v === 'object' && Object.values(v).every(x => typeof x === 'string'))), 'the vocabulary module holds word tables only');
});

// ---- the packet: filled within budget or omitted, never null
test('a packet never ships a null section: present sections are filled, absent ones are left out with their call', { skip }, async () => {
  const found = kind => ({ ok: true, file: 'Fixture.oml', sourceSha256: 'a'.repeat(64), digest: { module: { name: 'Fixture', key: 'M', kind }, elements: {}, sections: [], actions: [] } });
  const cases = [
    { lane: 'o11', intent: 'Traditional ComboBox with a filtered list, identifier, label and OnChange event' },
    { lane: 'o11', intent: 'criar actions de cadastro com aggregate e exception' },
    { lane: 'odc', intent: 'create a screen with a list of orders and a search input' },
    { lane: 'o11', intent: 'create a screen with a list of orders', app: 'Fixture.oml', digest: async () => found('WebResponsive') },
    { lane: 'o11', intent: 'create an entity Invoice', app: 'Fixture.oml', digest: async () => found('Service') },
    { lane: 'o11', intent: 'create an entity Invoice', app: 'Missing.oml', digest: async () => ({ ok: false, target: 'Missing.oml', error: 'not found' }) },
  ];
  for (const c of cases) for (const budgetBytes of [undefined, 12000]) {
    const p = await ask({ ...c, packet: true, ...(budgetBytes ? { budgetBytes } : {}) });
    assert.equal(p.ok, true, JSON.stringify(p).slice(0, 300));
    // R4: the scope is a section of a packet with a module read, by the same fill-or-omit rule.
    const sections = ['module', 'scope', 'text', 'environment', 'capabilities', 'example', 'rules', 'next'];
    for (const id of sections) assert.notEqual(p[id], null, `${c.intent} @${budgetBytes}: ${id} is null`);
    const present = Object.keys(p).filter(k => sections.includes(k));
    assert.deepEqual(present, p.packet.order.filter(k => present.includes(k)), 'present sections in the declared order');
    assert.ok(present.includes('next') && (present.includes('capabilities') || present.includes('text') || p.packet.note), `${c.intent} @${budgetBytes}: ${present.join(',')}`);
    // With the scope (R4) the cuts are one stream (section 'all', its sections named in sections): a left-out section is named there.
    for (const id of p.packet.order.filter(k => k !== 'next' && !present.includes(k))) assert.ok(p.cuts.some(x => x.section === id || (x.section === 'all' && x.sections?.[id])), `${id} left out without its call`);
    if (!c.app) assert.ok(p.module.none === true && !p.cuts.some(x => x.section === 'module'), 'no app: the module section is its note, whole, with no call to fetch it');
    if (c.app === 'Missing.oml') assert.equal(p.module.ok, false, 'a module that could not be read says so in its section');
  }
});
