// Lane E of the 2026-10-05 package (C07, C13 residues, C11 routing): the discover answer carries what the sessions had to
// find by trial. The grammar of each logic step the intent names with one whole proven job (steps); the O11 timer
// Schedule proven by a suite job (provenExample, values); the closed values of a property; the OutSystems UI list under a
// byte floor (present at 8 KB), with the catalog synonyms (deck -> StackedCards, slider -> RangeSlider) and in the ui.*
// expansions; a minimal answer that never passes its budget; no route or capability that sends a normal request to a proof
// before the delivery; the fragment form of a dropdown, a block instance and nested lists. Index checks need the lane CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover, laneSources, applyBudget, stepKindsOf, valuesFor, osuiFloor } from '../discovery.mjs';
import { namedPatterns, osuiExpansion, osuiSection, isScreenIntent, APP_TYPES } from '../osui-catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const facade = path.resolve(here, '..');
const bytes = v => Buffer.byteLength(JSON.stringify(v), 'utf8');
const cache = {};
const sourcesOf = lane => (cache[lane] ??= { ...laneSources(lane), cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), `laneE-discover-${lane}-`)) });
const cliSkip = lane => !fs.existsSync(laneSources(lane).cli) && `the ${lane} CLI is not built`;

test('step words of an action intent name the logic steps; values answer the closed property values per lane', () => {
  assert.deepEqual(stepKindsOf('criar uma action com aggregate e if'), ['get', 'if']);
  assert.deepEqual(stepKindsOf('server action que percorre os pedidos com for each e salva o registro'), ['foreach', 'save']);
  assert.deepEqual(stepKindsOf('criar uma tela com if'), [], 'no action word: not a logic intent');
  const o11 = valuesFor('o11', 'criar timer que roda a cada hora');
  assert.deepEqual(o11.find(v => v.property === 'Schedule').set, ['00:00 01:00 02:00 03:00 04:00 05:00 06:00 07:00 08:00 09:00 10:00 11:00 12:00 13:00 14:00 15:00 16:00 17:00 18:00 19:00 20:00 21:00 22:00 23:00', '00:00', '00:05 Mon']);
  assert.equal(valuesFor('odc', 'criar timer que roda a cada hora').find(v => v.property === 'CronSchedule').set[0], '0 * * * *');
  assert.equal(valuesFor('odc', 'criar timer que roda a cada hora').some(v => v.property === 'Schedule'), false, 'the O11 text is never offered on ODC');
  const input = valuesFor('odc', 'qual o tipo do input de senha');
  assert.deepEqual(input[0].set, ['Text', 'Password', 'Number', 'Time', 'Date', 'Datetime', 'Phone', 'Email', 'Search']);
  assert.equal(input[0].fragment.values['datetime-local'], 'Datetime');
  assert.equal(valuesFor('odc', 'renomear a entidade Pedido'), null);
});

test('OutSystems UI synonyms: deck and swipe lead to StackedCards, slider and range to RangeSlider, per library', () => {
  for (const lane of ['odc', 'o11']) {
    assert.deepEqual(namedPatterns(lane, 'criar uma tela com um deck de cartoes').map(n => n.pattern), ['StackedCards']);
    assert.equal(namedPatterns(lane, 'cards em swipe').find(n => n.pattern === 'StackedCards')?.via, 'swipe');
    assert.deepEqual(namedPatterns(lane, 'adicionar um slider de preco na tela').map(n => n.pattern), ['RangeSlider']);
    assert.equal(osuiExpansion(lane, 'deck').synonym.pattern, 'StackedCards');
    assert.ok(osuiExpansion(lane, 'deck').libraries.every(l => l.patterns.every(p => p.name === 'StackedCards')));
    assert.equal(osuiExpansion(lane, 'range').synonym.pattern, 'RangeSlider');
    assert.equal(isScreenIntent('adicionar um slider de preco', []), true);
  }
  // A library without the pattern is not offered it: Traditional (OutSystemsUIWeb) has no StackedCards.
  assert.deepEqual(namedPatterns('o11', 'um deck de cartoes', ['o11-traditional']), []);
  assert.ok(osuiExpansion('o11', 'o11-traditional/deck').error, 'no StackedCards in OutSystemsUIWeb');
  // The named patterns ride along at every level of the section, counts included.
  const request = { lane: 'odc', appTypes: APP_TYPES.odc, from: 'lane', named: namedPatterns('odc', 'um deck de cartoes') };
  assert.equal(osuiSection(request, 'counts').named[0].pattern, 'StackedCards');
  assert.ok(osuiFloor(request, 8192) > 0 && osuiFloor(request, 8192) <= 8192 / 4, 'a floor of at most a quarter of 8 KB');
  assert.equal(osuiFloor(request, 2000), 0, 'no floor when even the counts take more than a quarter');
});

test('the minimal answer never passes its budget, whatever the number of matches', () => {
  const matches = Array.from({ length: 30 }, (_, i) => ({ id: `capability.with-a-long-identifier-${i}`, via: 'match', level: 'C-suite', focus: { roles: ['role-' + i], ops: ['create', 'set'] }, notes: 'n'.repeat(400) }));
  const answer = { ok: true, schemaVersion: 'x', lane: 'odc', intent: 'i'.repeat(300), identity: { lane: 'odc', index: 'k', kernel: 'k', studio: { ideVersion: '1' } }, matches, contracts: {}, examples: {}, bindings: [],
    unavailable: Array.from({ length: 20 }, (_, i) => ({ id: 'unavailable-entry-' + i, reason: 'r'.repeat(200), alternative: 'a'.repeat(100) })), composition: { order: matches.map(m => m.id) }, continuation: { omitted: [] } };
  for (const budget of [4096, 1500, 900, 300]) {
    const a = applyBudget(structuredClone(answer), budget);
    assert.equal(a.size.status, 'insufficient', String(budget));
    assert.ok(bytes(a) <= budget, `${budget}: ${bytes(a)} bytes`);
    assert.equal(a.size.bytes, bytes(a), 'the size states the bytes returned');
  }
});

test('no route, capability or fragment sends a normal request to a proof before the delivery (C13)', () => {
  const files = ['catalog/tools.json', 'discovery-capabilities.json', 'discovery-capabilities-shared.json', 'discovery-capabilities-o11.json',
    ...fs.readdirSync(path.join(facade, 'catalog', 'fragments'), { recursive: true }).filter(f => String(f).endsWith('.json')).map(f => path.join('catalog', 'fragments', String(f)))];
  const BEFORE = /\bprov(e|ar|ing)\b[^"]{0,120}\b(before|antes)\b|\b(before|antes)\b[^"]{0,40}\bprov(e|ar)\b|prove (it )?(on the fixture )?first|antes de entregar|before deliver(ing|y)?\b(?! (the|a) (snapshot|refresh))|prove with ssam job|\bprove and deliver\b/i;
  const offenders = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(facade, f), 'utf8');
    JSON.stringify(JSON.parse(text.replace(/^﻿/, '')), (k, v) => { if (typeof v === 'string' && BEFORE.test(v) && !/base drifted before delivering|new snapshot before delivering/.test(v)) offenders.push(`${f}: ${v.slice(0, 160)}`); return v; });
  }
  assert.deepEqual(offenders, []);
});

test('the dropdown, block instance and list routes carry the fragment form the html op compiles (C11)', () => {
  const route = (file, id) => JSON.parse(fs.readFileSync(path.join(facade, 'catalog', 'fragments', 'B', file), 'utf8')).capabilities.find(c => c.id === id).route.operation;
  assert.match(route('widgets.json', 'ui.dropdown'), /"op":"html","parent":"<widget path>","html":"<select bind=\\"Var\\" options=\\"[^"\\]+\\" value=\\"[^"\\]+\\" label=\\"[^"\\]+\\"\/>"/);
  assert.match(route('blocks.json', 'ui.block-instance'), /<Block name=\\"B\\" :Input=\\"expr\\" @Event=\\"ScreenAction\\"><slot name=\\"Placeholder\\">/);
  assert.match(route('widgets.json', 'ui.list'), /<div list=\\"GetOrders.List\\" as=\\"Order\\">.*<div list=/);
  const event = JSON.parse(fs.readFileSync(path.join(facade, 'catalog', 'fragments', 'B', 'events.json'), 'utf8')).capabilities.find(c => c.id === 'ui.event').guidance;
  assert.match(event, /@Event="ScreenAction" on <Block name="B">/);
});

// UI-Mockup 2026-10-10 (FarmaVirtual, call 49 read the ui.dropdown route, call 99 refused 18 Verify errors): the Values and
// Labels of a Dropdown are evaluated per element of its List, so `<List>.Current.X` is unknown there (the kernel refuses it
// as DROPDOWN_ITEM_SCOPE). No catalog text may teach that form: every <select> fragment reads the element's attributes.
test('no catalog <select> reads the Current of its options in value or label; the dropdown route reads Item.Id', () => {
  const files = fs.readdirSync(path.join(facade, 'catalog', 'fragments'), { recursive: true }).filter(f => String(f).endsWith('.json')).map(f => path.join('catalog', 'fragments', String(f)));
  const offenders = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(facade, f), 'utf8');
    JSON.stringify(JSON.parse(text.replace(/^﻿/, '')), (k, v) => {
      if (typeof v !== 'string') return v;
      for (const [tag] of v.matchAll(/<select\b[^>]*>/g)) {
        const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)=\\?["']([^"'\\]*)\\?["']/g)].map(m => [m[1], m[2]]));
        const list = (attrs.options ?? '').trim();
        if (list && ['value', 'label'].some(a => (attrs[a] ?? '').replace(/\s+/g, '').includes(list.replace(/\s+/g, '') + '.Current'))) offenders.push(`${f}: ${tag}`);
      }
      return v;
    });
  }
  assert.deepEqual(offenders, []);
  const dropdown = JSON.parse(fs.readFileSync(path.join(facade, 'catalog', 'fragments', 'B', 'widgets.json'), 'utf8')).capabilities.find(c => c.id === 'ui.dropdown');
  assert.match(dropdown.route.operation, /options=\\"GetItems\.List\\" value=\\"Item\.Id\\" label=\\"Item\.Label\\"/);
  assert.doesNotMatch(dropdown.route.operation + dropdown.summary, /\.Current\./);
});

test('o11: a timer that runs every hour answers the O11 Schedule with the whole proven job (C07)', { skip: cliSkip('o11'), timeout: 900000 }, async () => {
  const a = await discover({ lane: 'o11', intent: 'criar timer que roda a cada hora', sources: sourcesOf('o11') });
  assert.equal(a.ok, true);
  assert.ok(a.matches.some(m => m.id === 'timer.schedule' && m.via === 'match'), JSON.stringify(a.matches.map(m => m.id)));
  assert.equal(a.provenExample.job, 'pacote-laneE-timer-schedule');
  assert.equal(a.provenExample.whole, true);
  const schedules = a.provenExample.ops.filter(op => op.op === 'set' && op.prop === 'Schedule').map(op => op.value);
  assert.deepEqual(schedules, ['00:00 01:00 02:00 03:00 04:00 05:00 06:00 07:00 08:00 09:00 10:00 11:00 12:00 13:00 14:00 15:00 16:00 17:00 18:00 19:00 20:00 21:00 22:00 23:00', '00:00', '00:05 Mon']);
  assert.deepEqual(a.provenExample.reference, { tool: 'ssam_reference', arguments: { lane: 'o11', kind: 'example', query: { id: 'pacote-laneE-timer-schedule' } } });
  assert.ok(a.values.some(v => v.property === 'Schedule' && v.set.includes('00:00 01:00 02:00 03:00 04:00 05:00 06:00 07:00 08:00 09:00 10:00 11:00 12:00 13:00 14:00 15:00 16:00 17:00 18:00 19:00 20:00 21:00 22:00 23:00')));
  const route = a.matches.find(m => m.id === 'timer.schedule').route?.operation ?? '';
  assert.match(route, /O11: set Schedule "00:00 01:00 02:00 03:00 04:00 05:00 06:00 07:00 08:00 09:00 10:00 11:00 12:00 13:00 14:00 15:00 16:00 17:00 18:00 19:00 20:00 21:00 22:00 23:00"/);
  assert.ok(a.size.bytes <= a.size.budgetBytes);
});

for (const lane of ['odc', 'o11']) {
  test(`${lane}: an action with an aggregate and an if answers the grammar of each step and one proven job (C07)`, { skip: cliSkip(lane), timeout: 900000 }, async () => {
    const a = await discover({ lane, intent: 'criar uma action com aggregate e if', sources: sourcesOf(lane) });
    assert.equal(a.ok, true);
    assert.deepEqual(a.steps.kinds, ['get', 'if']);
    assert.ok(a.steps.grammar.get.includes('where') && a.steps.grammar.get.includes('as'), JSON.stringify(a.steps.grammar.get));
    assert.ok(a.steps.grammar.if.includes('then') && a.steps.grammar.if.includes('else'), JSON.stringify(a.steps.grammar.if));
    const example = a.steps.example;
    assert.ok(example?.job, 'a proven job');
    const job = JSON.parse(fs.readFileSync(path.join(laneSources(lane).kernel, example.path), 'utf8').replace(/^﻿/, ''));
    assert.ok(job.ops.some(op => op.op === 'logic'), 'a suite job of the lane with a logic op');
    const text = JSON.stringify(example.ops);
    assert.ok(example.ops[0].op === 'logic' && text.includes('"get"') && text.includes('"if"'), text.slice(0, 300));
    assert.equal(example.reference.arguments.query.id, example.job);
    assert.ok(a.size.bytes <= a.size.budgetBytes);
  });

  test(`${lane}: the OutSystems UI list is present at 8 KB, named patterns ride along, and ui.* expansions carry it (C07)`, { skip: cliSkip(lane), timeout: 900000 }, async () => {
    const sources = sourcesOf(lane);
    const small = await discover({ lane, intent: 'criar um dashboard com cards e menu lateral', sources, budgetBytes: 8192 });
    assert.ok(small.outsystemsUi, JSON.stringify(small.size));
    assert.ok(small.size.bytes <= 8192, String(small.size.bytes));
    const deck = await discover({ lane, intent: 'criar uma tela com um deck de cartoes', sources });
    assert.ok(deck.outsystemsUi.named.some(n => n.pattern === 'StackedCards' && n.via === 'deck'), JSON.stringify(deck.outsystemsUi.named));
    const slider = await discover({ lane, intent: 'adicionar um slider de preco na tela', sources });
    assert.ok(slider.outsystemsUi.named.some(n => n.pattern === 'RangeSlider' && n.via === 'slider'), JSON.stringify(slider.outsystemsUi?.named));
    const expanded = await discover({ lane, expand: 'ui.list:example', sources, budgetBytes: 12000 });
    assert.equal(expanded.ok, true);
    assert.ok(expanded.outsystemsUi, 'a ui.* expansion carries the section');
    assert.ok(expanded.size.bytes <= 12000);
  });
}
