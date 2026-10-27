// ssam_code (ssam-code.mjs): the module as code, one word to read and write. Pure rules (grammar, the op of each part, the
// continuations, the aliases), the live ssam server (listed for both lanes; a write reaches the registered studio_deliver
// relay, the same path a client call takes; a fake ODC lane server, never a Studio) and, when the lane CLIs are given
// (SSAM_CODE_CLI_O11 / SSAM_CODE_CLI_ODC: a folder with anvil.dll / anvil-odc.dll), the grammar examples applied on a kernel
// fixture and read back through the CLIs and moduleMap on both lanes.
import { originalLocalAppData } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import Ajv from 'ajv';
import { CODE_DESCRIPTION, CODE_FORMS_EXACT, CODE_PARTS, EXAMPLE_DDL, EXAMPLE_DDL_UI, EXAMPLE_HTML, EXAMPLE_LOGIC, EXAMPLE_SETUP_OPS, codeAnswer, codeCall, codeRead, exampleCall, grammarCard, headerOf, missingIdsOf, namesOf,
  normalizeCodeOps, normalizeEvents, ownersOf, removedOf, serviceExampleCall, exampleLogicTexts, sqlHintsOf, writeCall } from '../ssam-code.mjs';
import { resolvePatchedJob } from '../job-patch.mjs';
import { codePartOf } from '../ssam-reference.mjs';
import { moduleMap, VIEWS } from '../module-map.mjs';
import { classifyTextRoute, sectionOf, textRouteSection, TEXT_ROUTE_IDS } from '../text-routes.mjs';
import { nextSection, workPacket } from '../work-packet.mjs';
import { deliveryFields } from '../o11-cycle.mjs';
import { compactDelivery, DELIVERY_FIELDS } from '../responses.mjs';
import { createSsamServer } from '../ssam.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '..', '..', '..', '..', 'kernel', 'tests', 'fixtures');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-code-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const valueOf = r => r.structuredContent ?? JSON.parse(r.content[0].text);

test('grammar: a card per part with the syntax and a from-scratch example; no module needed', () => {
  for (const lane of ['o11', 'odc']) for (const part of CODE_PARTS) {
    const g = grammarCard(part, lane);
    assert.equal(g.ok, true); assert.equal(g.card.part, part); assert.ok(g.card.rules.length >= 3, part);
    assert.equal(g.card.read.tool, 'ssam_code'); assert.equal(g.card.write.arguments.action, 'write');
  }
  assert.match(EXAMPLE_DDL, /create entity Visit label VisitTitle \(/);
  assert.match(EXAMPLE_DDL, /references Customer on delete Protect/); assert.match(EXAMPLE_DDL, /create unique index UQ_Visit_VisitTitle on Visit \(VisitTitle\);/);
  assert.match(EXAMPLE_DDL, /create static entity VisitStatus[\s\S]*values[\s\S]*Planned \(Id = 1/); assert.match(EXAMPLE_DDL, /type VisitTotals = \{/);
  assert.match(EXAMPLE_DDL, /Decimal\(18,2\)/); assert.match(EXAMPLE_DDL, /Boolean required default False/); assert.match(EXAMPLE_DDL, /Date Time default CurrDateTime\(\)/);
  assert.match(EXAMPLE_LOGIC[0], /^server action CompleteVisit$/m); for (const w of ['aggregate FROM', 'if ', 'assign', 'raise ', 'out CompletedCount']) assert.ok(EXAMPLE_LOGIC[0].includes(w), w);
  assert.match(EXAMPLE_HTML, /<var name="Filter"/); assert.match(EXAMPLE_HTML, /list="GetVisits.List"/); assert.match(EXAMPLE_HTML, /onclick="Complete\(/);
  const all = grammarCard(null, 'odc');
  assert.deepEqual(all.parts.map(c => c.part), CODE_PARTS);
  // The first example is the one an empty or service (_CS) module takes: data and a server action, no screen, no role.
  assert.deepEqual(all.example.call.arguments.ops, [EXAMPLE_SETUP_OPS[0]]);
  assert.deepEqual(all.example.call.arguments.also, [{ part: 'logic', text: exampleLogicTexts('odc').filter(text => /^server action /m.test(text)) }]);
  for (const form of ['pagination', 'join', 'sql parameter', 'sql typed parameter', 'sql result', 'exception handler', 'exception handler without flags', 'list append mapping', 'list assignment mapping'])
    assert.ok(EXAMPLE_LOGIC.join('\n').includes(CODE_FORMS_EXACT.logic[form]), form);
  assert.deepEqual(all.exampleWithUi.call.arguments.ops, EXAMPLE_SETUP_OPS);
  assert.match(all.note, /UI flow/);
  assert.match(grammarCard('html', 'o11').card.needs, /empty or service \(_CS\) module has none/);
  assert.equal(grammarCard('ddl', 'o11').example.call.arguments.also.length, 1);
  assert.ok(grammarCard('logic', 'odc').card.rules.some(r => /LEFT OUT IS DELETED/.test(r) && /removes:true/.test(r)));
  assert.ok(grammarCard('html', 'odc').card.rules.some(r => /BEFORE the change of an existing screen/.test(r)));
  assert.ok(grammarCard('html', 'odc').card.rules.some(r => /no argument on<event>="Destination"/.test(r)));
  assert.ok(grammarCard('html', 'odc').card.rules.some(r => /owners default to the screen/.test(r)));
  // An <input> (and a block <event>) written without mandatory is optional, whatever the Studio gives a fresh one: the card says
  // how a mandatory one is written (review odc-defaults-4, R4-2).
  for (const lane of ['odc', 'o11'])
    assert.ok(grammarCard('html', lane).card.rules.some(r => /<input name type>/.test(r) && /without mandatory is optional/.test(r) && /mandatory="True"/.test(r)), lane);
});

test('write logic: a changed action is sent whole; a gap in its ids is refused unless removes says so', () => {
  const read = '/// Computes the expected date of a visit.\nserver action CalcularPrevisao @cfFoFGSrc0SAUdxt1u0pKA\n  in VisitaId: Visita Identifier @p1\n  out Previsao: Date Time @p2\n'
    + '  GetVisita = aggregate FROM Visita WHERE (Visita.Id = VisitaId) MAX 1 @n1\n  if GetVisita.List.Empty: @n2\n    raise X("x") @n3\n  assign Previsao = CurrDateTime() @n4\n  end @n5\n';
  // The owner's flow (2026-10-12): header, parameters, the changed line and the end; @n1..@n4 would be deleted.
  const partial = '/// Computes the expected date of a visit.\nserver action CalcularPrevisao @cfFoFGSrc0SAUdxt1u0pKA\n  in VisitaId: Visita Identifier @p1\n  out Previsao: Date Time @p2\n'
    + '  assign Previsao = AddHours(CurrDateTime(), -3) @n4\n  end @n5\n';
  assert.deepEqual(missingIdsOf(partial), ['@n1', '@n2', '@n3']);
  assert.deepEqual(missingIdsOf(read), []);
  assert.deepEqual(missingIdsOf('server action New\n  end\n'), [], 'a new action has no ids');
  assert.deepEqual(headerOf('action Espelho.Exportar\n  end\n'), { kind: 'action', owner: 'Espelho', name: 'Exportar', key: null });
  assert.equal(headerOf('server action X public function @k1Abcdef\n').key, 'k1Abcdef');
  for (const lane of ['o11', 'odc']) {
    const r = writeCall({ lane, part: 'logic', module: 'M', text: partial, basedOn: 'sha' });
    assert.equal(r.refusal?.code, 'INPUT_INVALID', lane);
    assert.match(r.refusal.error, /WHOLE/); assert.match(r.refusal.error, /CalcularPrevisao leaves out @n1, @n2, @n3/); assert.match(r.refusal.error, /removes: true/);
    assert.deepEqual(r.refusal.problems[0].gaps, [{ action: 'CalcularPrevisao', missing: ['@n1', '@n2', '@n3'] }]);
    assert.equal(r.refusal.continuation.arguments.part, 'logic');
    // Meant: removes:true, or exactly the ids left out.
    assert.equal(writeCall({ lane, part: 'logic', module: 'M', text: partial, basedOn: 'sha', removes: true }).tool, lane === 'o11' ? 'o11_deliver' : 'studio_deliver');
    assert.ok(writeCall({ lane, part: 'logic', module: 'M', text: partial, basedOn: 'sha', removes: ['@n1', 'n2', '@n3'] }).arguments);
    assert.match(writeCall({ lane, part: 'logic', module: 'M', text: partial, basedOn: 'sha', removes: ['@n1'] }).refusal.error, /leaves out @n2, @n3/);
    // The whole text (with the change) goes as it is.
    const whole = read.replace('assign Previsao = CurrDateTime() @n4', 'assign Previsao = AddHours(CurrDateTime(), -3) @n4');
    assert.deepEqual(writeCall({ lane, part: 'logic', module: 'M', text: whole, basedOn: 'sha' }).arguments.job.ops, [{ op: 'logic', data: { flow: [{ text: whole, basedOn: 'sha' }] } }]);
    // A gap in an also part is named by its place.
    const also = writeCall({ lane, part: 'ddl', module: 'M', text: 'create entity A (\n  Id Long Integer identifier auto required\n);', also: [{ part: 'logic', text: partial, basedOn: 'sha' }] });
    assert.equal(also.refusal.problems[0].at, 'also/0');
  }
  assert.match(CODE_DESCRIPTION, /WHOLE as read/); assert.match(CODE_DESCRIPTION, /a line left out is DELETED/); assert.doesNotMatch(CODE_DESCRIPTION, /a removed one is removed/);
});

test('Traditional Preparation keeps its owner and native key in mixed HTML and flow writes', () => {
  const preparation = 'preparation MainFlow/Home.Preparation @screenKey.#Preparation\n  assign Message = "Initial" @n1\n  end @n2\n';
  assert.deepEqual(headerOf(preparation), { kind: 'preparation', owner: 'Home', name: 'Preparation', key: 'screenKey.#Preparation' });
  assert.deepEqual(missingIdsOf(preparation), []);
  const created = preparation.replace(' @screenKey.#Preparation', '').replace(/ @n\d+/g, '');
  const call = writeCall({ lane: 'o11', part: 'html', module: 'M', text: '<screen name="Home"><var name="Message" type="Text"/><div>{{ Message }}</div></screen>',
    also: [{ part: 'logic', text: created }] });
  assert.deepEqual(call.arguments.job.ops.map(o => o.op), ['html', 'logic']);
  assert.deepEqual(call.arguments.job.ops[1].data.flow, [created]);
  assert.deepEqual(writeCall({ lane: 'o11', part: 'logic', module: 'M', text: preparation, basedOn: 'sha' }).arguments.job.ops,
    [{ op: 'logic', data: { flow: [{ text: preparation, basedOn: 'sha' }] } }]);
});

test('write html: a new screen action goes before the change of its screen, after a new screen document; X() becomes X', () => {
  const basedOn = { capture: 'c', html: 'h' };
  const button = ' <div k="w7" class="espelho-acoes">\n  <button k="w8" class="btn" onclick="Atualizar()">Atualizar</button>\n  <button class="btn btn-primary" onclick="Exportar()">Exportar</button>\n </div>';
  const action = 'action Espelho.Exportar\n  message Info: "Exportando"\n  end\n';
  for (const lane of ['o11', 'odc']) {
    // The documented order (html main, logic in also): the action is written first.
    const htmlFirst = writeCall({ lane, part: 'html', module: 'Headless_UI', element: 'Espelho', text: [button], basedOn, also: [{ part: 'logic', text: action }] });
    assert.deepEqual(htmlFirst.arguments.job.ops.map(o => o.op), ['logic', 'html'], lane);
    assert.deepEqual(htmlFirst.arguments.job.ops[0].data.flow, [action]);
    assert.equal(htmlFirst.arguments.job.ops[1].data.edit[0], button.replace('onclick="Atualizar()"', 'onclick="Atualizar"').replace('onclick="Exportar()"', 'onclick="Exportar"'));
    // An existing action edited in the same logic text keeps its place after the edit; only the new screen action moves.
    const mixed = writeCall({ lane, part: 'html', module: 'M', element: 'MainFlow/Espelho', text: [button], basedOn,
      also: [{ part: 'logic', text: ['server action Y @kYyyyyyy\n  end @n1\n', action], basedOn: ['shaY', null] }] });
    assert.deepEqual(mixed.arguments.job.ops.map(o => o.op), ['logic', 'html', 'logic']);
    assert.deepEqual(mixed.arguments.job.ops[0].data.flow, [action]);
    assert.deepEqual(mixed.arguments.job.ops[2].data.flow, [{ text: 'server action Y @kYyyyyyy\n  end @n1\n', basedOn: 'shaY' }]);
    // Logic first already: the same order.
    const logicFirst = writeCall({ lane, part: 'logic', module: 'M', text: action, also: [{ part: 'html', element: 'Espelho', text: [button], basedOn }] });
    assert.deepEqual(logicFirst.arguments.job.ops.map(o => o.op), ['logic', 'html']);
    // A new screen document keeps its place before its actions; a document keeps X() too (the kernel takes both), written as X.
    const doc = writeCall({ lane, part: 'html', module: 'M', text: '<screen name="Espelho" actions="Exportar">\n<button onclick="Exportar()">E</button>\n</screen>', also: [{ part: 'logic', text: action }] });
    assert.deepEqual(doc.arguments.job.ops.map(o => o.op), ['html', 'logic']);
    assert.match(doc.arguments.job.ops[0].data.html, /onclick="Exportar"/);
    // A new action of another screen is not moved.
    const other = writeCall({ lane, part: 'html', module: 'M', element: 'Espelho', text: [button], basedOn, also: [{ part: 'logic', text: 'action Visitas.Cancelar\n  end\n' }] });
    assert.deepEqual(other.arguments.job.ops.map(o => o.op), ['html', 'logic']);
  }
  assert.equal(normalizeEvents('<x onclick="Go( )" @Changed="Handle()" onchange="Save(Id = 1)"/>'), '<x onclick="Go" @Changed="Handle" onchange="Save(Id = 1)"/>');
});

test('write odc: owners are the edited screen, the screens of the screen actions and the names the code writes', () => {
  const basedOn = { capture: 'c', html: 'h' };
  const edit = writeCall({ lane: 'odc', part: 'html', module: 'VisitaCerta', element: 'Visitas', text: '<button k="w7" class="btn">Ok</button>', basedOn });
  assert.deepEqual(edit.arguments.owners, ['Visitas']);
  const action = writeCall({ lane: 'odc', part: 'logic', module: 'VisitaCerta', text: 'action Visitas.Cancelar\n  end\n' });
  assert.deepEqual(action.arguments.owners, ['Visitas', 'Cancelar']);
  const data = writeCall({ lane: 'odc', part: 'logic', module: 'VisitaCerta', text: 'data action MainFlow/Visitas.GetTotais\n  out Total: Integer\n  end\n' });
  assert.deepEqual(data.arguments.owners, ['Visitas', 'GetTotais']);
  const both = writeCall({ lane: 'odc', part: 'html', module: 'VisitaCerta', element: 'Visitas', text: ['<button onclick="Cancelar">Cancelar</button>'], basedOn, also: [{ part: 'logic', text: 'action Visitas.Cancelar\n  end\n' }] });
  assert.deepEqual(both.arguments.owners, ['Visitas', 'Cancelar']);
  assert.deepEqual(ownersOf('ddl', EXAMPLE_DDL), ['Customer', 'Visit', 'VisitStatus', 'VisitTotals', 'VisitRow']);
  assert.deepEqual(ownersOf('html', ['<div/>'], 'MainFlow/Visitas'), ['Visitas']); assert.deepEqual(ownersOf('html', ['<div/>'], 'MobileScreen:Visitas'), ['Visitas']);
  // Given owners are kept.
  assert.deepEqual(writeCall({ lane: 'odc', part: 'html', module: 'M', element: 'S', text: ['<div/>'], basedOn, owners: ['S', 'Other'] }).arguments.owners, ['S', 'Other']);
});

test('write odc: a correction (patch + basedOn) carries owners and changes from the refused job, or is refused with what to give', t => {
  const dir = tmp(t);
  const job = path.join(dir, 'refused.json');
  fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'spec', data: { ddl: EXAMPLE_DDL } }, { op: 'html', data: { screen: 'Visitas', basedOn: { capture: 'c', html: 'h' }, edit: ['<div k="w1"/>'] } },
    { op: 'logic', data: { flow: ['action Visitas.Cancelar\n  end\n'] } }] }));
  const basedOn = { job, sha256: 'a'.repeat(64) };
  const fix = writeCall({ lane: 'odc', part: 'ddl', module: 'VisitaCerta', patch: [{ op: 'replace', path: '/ops/0/data/ddl', value: 'x' }], basedOn });
  assert.equal(fix.tool, 'studio_deliver');
  assert.deepEqual(fix.arguments.owners, ['Customer', 'Visit', 'VisitStatus', 'VisitTotals', 'VisitRow', 'Visitas', 'Cancelar']);
  assert.equal(fix.arguments.changes.length, 3); assert.match(fix.arguments.feature, /correction/);
  assert.deepEqual(fix.arguments.patch, [{ op: 'replace', path: '/ops/0/data/ddl', value: 'x' }]); assert.deepEqual(fix.arguments.basedOn, basedOn);
  const given = writeCall({ lane: 'odc', part: 'ddl', module: 'M', patch: [], basedOn, owners: ['A'], changes: ['c'] });
  assert.deepEqual([given.arguments.owners, given.arguments.changes], [['A'], ['c']]);
  const unreadable = writeCall({ lane: 'odc', part: 'ddl', module: 'M', patch: [], basedOn: { job: path.join(dir, 'missing.json'), sha256: 'b'.repeat(64) } });
  assert.match(unreadable.refusal.error, /needs owners and changes/);
  // O11 takes no owners.
  assert.equal(writeCall({ lane: 'o11', part: 'ddl', module: 'M', patch: [], basedOn }).arguments.owners, undefined);
});

test('write ddl: SQL Server DDL is refused before the delivery with the form ssam-ddl/1 takes', () => {
  for (const [text, fix] of [['CREATE TABLE Visita (\n  Id INT PRIMARY KEY\n);', /create table: an entity is "create entity/], ['create table Visita (\n  Id Long Integer identifier auto required\n);', /create table/],
    ['CREATE ENTITY Visita (\n  Id Long Integer identifier auto required\n);', /upper-case keyword/], ['create entity Visita (\n  Id INT PRIMARY KEY\n);', /SQL type|PRIMARY KEY/],
    ['create entity Visita (\n  Id Long Integer identifier auto required,\n  Nome varchar(50) not null\n);', /SQL type|NOT NULL/]]) {
    const r = writeCall({ lane: 'odc', part: 'ddl', module: 'M', text });
    assert.equal(r.refusal?.code, 'INPUT_INVALID', text); assert.match(r.refusal.error, /not SQL Server DDL/); assert.match(r.refusal.error, fix, text);
    assert.equal(r.refusal.continuation.arguments.action, 'grammar');
  }
  // The examples, descriptions with SQL words and attributes named like SQL types pass.
  assert.deepEqual(sqlHintsOf(EXAMPLE_DDL), []);
  assert.deepEqual(sqlHintsOf('/// INT PRIMARY KEY in a description\ncreate entity Money (\n  Id Long Integer identifier auto required,\n  Int Integer,\n  Valor Money,\n  Nota Text(50) default "NOT NULL"\n);'), []);
});

test('refusals of a write speak ssam_code: grammar continuation, ssam_code read, the hint the kernel words lack', () => {
  const kernel = { ok: false, code: 'DDL_SYNTAX', error: 'ssam-ddl/1 line 1: create what? (entity, static entity, index)', problems: [
    { code: 'DDL_SYNTAX', message: "line 3: unknown attribute clause ''", fix: 'write it as ssam_map view:"ddl" reads it' },
    { code: 'FLOW_SYNTAX', message: 'line 4: unexpected end of text', fix: 'see docs/TEXTO-LOGICA.md' }], nextBasedOn: { job: 'C:\\x\\ssam_map view ddl.json', sha256: 'f' } };
  const out = codeAnswer(kernel, { lane: 'o11', part: 'ddl' });
  assert.deepEqual(out.continuations.grammar, { tool: 'ssam_code', arguments: { lane: 'o11', action: 'grammar', part: 'ddl' }, why: 'the syntax and a from-scratch example of ssam-ddl/1' });
  assert.match(out.error, /create what\? \(a table is an entity: create entity/);
  assert.match(out.problems[0].message, /Id Long Integer identifier auto required/);
  assert.equal(out.problems[0].fix, 'write it as ssam_code read (part ddl) reads it');
  assert.equal(out.problems[1].fix, 'see ssam_code grammar (part logic)');
  assert.deepEqual(out.nextBasedOn, kernel.nextBasedOn, 'paths and hashes stay');
  // Not a text refusal, a success: as they came.
  const other = { ok: false, code: 'STUDIO_NOT_CONNECTED', error: 'no Studio' };
  assert.equal(codeAnswer(other, { lane: 'odc', part: 'ddl' }), other);
  const done = { ok: true, result: 'delivered' };
  assert.equal(codeAnswer(done, { lane: 'odc', part: 'ddl' }), done);
});

test('removed: what an action text or a screen edit deleted, from the apply results; a delivery field', () => {
  const results = [{ op: 'logic', result: { flow: [{ action: 'CalcularPrevisao', owner: null, deleted: ['@n2', '@n4', '@n1', '@n3'] }, { action: 'Exportar', owner: 'Espelho', deleted: null }] } },
    { op: 'html', result: { screen: 'Espelho', ops: [{ op: 'create', kind: 'Button' }, { op: 'delete', k: 'w9', kind: 'Button' }, { op: 'delete', kind: 'TextWidget', why: 'created with the new element' }] } }];
  assert.deepEqual(removedOf(results), [{ part: 'logic', action: 'CalcularPrevisao', deleted: ['@n2', '@n4', '@n1', '@n3'] }, { part: 'html', screen: 'Espelho', deleted: ['w9 (Button)'] }]);
  assert.deepEqual(removedOf(null), []);
  assert.deepEqual(deliveryFields({ apply: { results } }).removed, removedOf(results));
  assert.equal(deliveryFields({ apply: { results: [] } }).removed, undefined);
  assert.ok(DELIVERY_FIELDS.includes('removed'));
  assert.deepEqual(compactDelivery('studio_deliver', {}, { ok: true, merge: { merged: true, strictlyEqual: true }, removed: removedOf(results) }).removed, removedOf(results));
});

test('discover: tables in code are the data (data.ddl); a packet with a text route delivers with ssam_code', () => {
  for (const intent of ['crie as tabelas Visita, Local e TipoVisita em código no VisitaCerta_CS vazio', 'crie as tabelas em SQL no módulo', 'create the tables Visit and Place as code',
    'crie a tabela Visita e a entidade Local']) assert.equal(classifyTextRoute(intent)?.id, 'data.ddl', intent);
  // A table of a screen stays the screen.
  assert.equal(classifyTextRoute('criar a tela Pedidos com uma tabela dos pedidos do cliente')?.id, 'ui.screen-html');
  assert.equal(classifyTextRoute('remover a coluna Data da tabela da tela Pedidos')?.id, 'ui.screen-html-edit');
  for (const lane of ['o11', 'odc']) {
    const route = textRouteSection('crie as tabelas Visita e Local em código no VisitaCerta_CS', lane);
    const next = nextSection({ lane, module: { ok: true, digest: { module: { name: 'VisitaCerta_CS' } } }, textRoute: route });
    assert.equal(next.deliver.tool, 'ssam_code'); assert.equal(next.deliver.arguments.action, 'write'); assert.equal(next.deliver.arguments.part, 'ddl');
    assert.equal(next.deliver.arguments.module, 'VisitaCerta_CS');
    assert.deepEqual(next.code.grammar.arguments, { lane, action: 'grammar', part: 'ddl' }); assert.equal(next.code.read.tool, 'ssam_code');
    assert.equal(next.code.json.tool, lane === 'o11' ? 'o11_deliver' : 'studio_deliver');
    // Without a text route the JSON delivery stays.
    assert.equal(nextSection({ lane }).deliver.tool, lane === 'o11' ? 'o11_deliver' : 'studio_deliver');
    const packet = workPacket({ lane, intent: 'crie as tabelas em código', matches: [], textRoute: route }, { read: () => '' });
    assert.equal(packet.next.deliver.tool, 'ssam_code');
  }
  for (const intent of ['adicione um botão Cancelar na tela Visitas', 'altere a action ConcluirVisita para gravar a data']) {
    const next = nextSection({ lane: 'o11', textRoute: textRouteSection(intent, 'o11') });
    assert.equal(next.deliver.tool, 'ssam_code', intent);
  }
});

test('write: the op the kernel takes for each part, the lane delivery and its options; refusals name the grammar', () => {
  const ddl = writeCall({ lane: 'o11', action: 'write', part: 'ddl', module: 'Shop', text: 'create entity A (\n  Id Long Integer identifier auto required\n);', basedOn: 'abc', publish: true, authorize: 'pode publicar o Shop' });
  assert.equal(ddl.tool, 'o11_deliver');
  assert.deepEqual(ddl.arguments.job, { ops: [{ op: 'spec', data: { basedOn: 'abc', ddl: 'create entity A (\n  Id Long Integer identifier auto required\n);' } }] });
  assert.equal(ddl.arguments.until, 'merge'); assert.equal(ddl.arguments.publish, true); assert.equal(ddl.arguments.authorize, 'pode publicar o Shop');
  const logic = writeCall({ lane: 'odc', part: 'logic', module: 'Shop', text: ['server action X @k\n  end @n1\n', 'server action Y\n  end\n'], basedOn: ['sha1', null] });
  assert.equal(logic.tool, 'studio_deliver');
  assert.deepEqual(logic.arguments.job.ops[0].data.flow, [{ text: 'server action X @k\n  end @n1\n', basedOn: 'sha1' }, 'server action Y\n  end\n']);
  assert.deepEqual(logic.arguments.owners, ['X', 'Y']); assert.match(logic.arguments.feature, /^ssam_code logic: X, Y$/);
  const doc = writeCall({ lane: 'odc', part: 'html', module: 'Shop', text: EXAMPLE_HTML });
  assert.deepEqual(doc.arguments.job.ops[0], { op: 'html', data: { html: EXAMPLE_HTML } }); assert.deepEqual(doc.arguments.owners, ['Visits']);
  const edit = writeCall({ lane: 'o11', part: 'html', module: 'Shop', element: 'Home', text: '<div k="w3" class="x"/>', basedOn: { capture: 'c', html: 'h' } });
  assert.deepEqual(edit.arguments.job.ops[0], { op: 'html', data: { screen: 'Home', basedOn: { capture: 'c', html: 'h' }, edit: ['<div k="w3" class="x"/>'] } });
  // The whole example in one write: setup ops first, then ddl, html, logic.
  const ex = writeCall(exampleCall('odc').arguments);
  assert.deepEqual(ex.arguments.job.ops.map(o => o.op), ['create', 'create', 'spec', 'html', 'logic']);
  assert.ok(ex.arguments.owners.includes('Visit') && ex.arguments.owners.includes('CompleteVisit') && ex.arguments.owners.includes('Visits'));
  // A correction: patch + basedOn {job, sha256} go to the delivery as they are.
  const fix = writeCall({ lane: 'o11', part: 'ddl', module: 'Shop', patch: [{ op: 'replace', path: '/ops/0/data/ddl', value: 'x' }], basedOn: { job: 'C:\\j.json', sha256: 'a'.repeat(64) } });
  assert.deepEqual(fix.arguments.basedOn, { job: 'C:\\j.json', sha256: 'a'.repeat(64) }); assert.equal(fix.arguments.job, undefined);
  for (const bad of [{ part: 'ddl', text: 'x' }, { part: 'ddl', module: 'M' }, { part: 'html', module: 'M', text: '<div k="w1"/>' }, { part: 'logic', module: 'M', text: ['a', 'b'], basedOn: ['x'] },
    { part: 'ddl', module: 'M', patch: [] }, { lane: 'o11', part: 'ddl', module: 'M', text: 'x', until: 'preview' }]) {
    const r = writeCall({ lane: 'odc', ...bad });
    assert.equal(r.refusal?.code, 'INPUT_INVALID', JSON.stringify(bad)); assert.equal(r.refusal.continuation.arguments.action, 'grammar');
  }
  assert.deepEqual(namesOf('ddl', EXAMPLE_DDL), ['Customer', 'Visit', 'VisitStatus', 'VisitTotals', 'VisitRow']);
});

test('aliases: job op "ddl" and logic data.text in their kernel form; ssam_map view "logic"; ssam_reference parts', t => {
  const { job, changed } = normalizeCodeOps({ ops: [{ op: 'ddl', data: { text: 'create entity A ();', basedOn: 's' } }, { op: 'logic', data: { text: 'server action X\n  end\n' } }, { op: 'html', data: { html: '<screen name="S"/>' } }] });
  assert.equal(changed, true);
  assert.deepEqual(job.ops, [{ op: 'spec', data: { basedOn: 's', ddl: 'create entity A ();' } }, { op: 'logic', data: { flow: ['server action X\n  end\n'] } }, { op: 'html', data: { html: '<screen name="S"/>' } }]);
  assert.equal(normalizeCodeOps({ ops: [{ op: 'spec', data: { ddl: 'x' } }] }).changed, false);
  assert.deepEqual(normalizeCodeOps([{ op: 'ddl', data: { ddl: 'x' } }]).job, [{ op: 'spec', data: { ddl: 'x' } }]);
  // job-patch: an inline job and a job file with the aliases run as the kernel form (o11_deliver, studio_deliver patch, ssam_job).
  const dir = tmp(t);
  const inline = resolvePatchedJob({ job: { ops: [{ op: 'ddl', data: { ddl: 'create entity A ();' } }] } }, { inlineDir: dir });
  assert.equal(JSON.parse(fs.readFileSync(inline.path, 'utf8')).ops[0].op, 'spec');
  const file = path.join(dir, 'aliased.json'); fs.writeFileSync(file, JSON.stringify({ ops: [{ op: 'logic', data: { text: 'server action X\n  end\n' } }] }));
  const fromFile = resolvePatchedJob({ job: file }, { inlineDir: dir });
  assert.notEqual(fromFile.path, file); assert.deepEqual(JSON.parse(fs.readFileSync(fromFile.path, 'utf8')).ops[0].data.flow, ['server action X\n  end\n']);
  assert.ok(VIEWS.includes('logic'));
  for (const [kind, query, part] of [['api', { op: 'ddl' }, 'ddl'], ['api', { op: 'flow' }, 'logic'], ['api', { op: 'ssam-html' }, 'html'], ['example', 'ssam-text ddl syntax', 'ddl'],
    ['recipe', { find: 'ssam_code' }, 'all'], ['api', { op: 'logic' }, null], ['example', 'html/visual/block-event.html', null], ['api', 'IForEachNode', null],
    ['example', 'sintaxe do ddl', 'ddl'], ['api', 'ddl', 'ddl'],
    // A check, the rules, a recipe search, a path or an example id are never answered with the card (finding 2026-10-12).
    ['check-job', 'C:\\jobs\\add-ddl-entities.json', null], ['check-job', { name: 'ddl de clientes', ops: [] }, null], ['check-delivery', 'C:\\x\\ddl-run\\result.json', null],
    ['recipe', { find: 'ddl' }, null], ['rules', 'ddl', null], ['example', 'spec-ddl-roundtrip', null], ['verify-message', 'ssam_code ddl', null]])
    assert.equal(codePartOf(kind, query), part, kind + ' ' + JSON.stringify(query));
});

test('read: ssam_map continuations become ssam_code calls; an empty module reads as an empty document with the grammar', async () => {
  const pin = { lane: 'odc', target: 'C:\\c.oml', budgetBytes: 1000, expectedSourceSha256: 'f'.repeat(64) };
  const calls = [];
  const map = async input => {
    calls.push(input);
    if (input.view === 'flow') return { ok: true, count: 0, entries: [], continuations: { next: null, action: { tool: 'ssam_map', arguments: { ...pin, view: 'flow', element: '<name or @key>' } } } };
    if (input.view === 'ddl') return { ok: true, page: 1, pages: 1, text: '-- ssam-ddl/1 module=M\n\nclient variable LastURL: Text -- @k\n', continuations: { page: { tool: 'ssam_map', arguments: { ...pin, view: 'ddl', page: '<n>' } } } };
    return { ok: true, html: '<screen name="Home"/>', continuations: { edit: { tool: 'studio_deliver', arguments: { feature: 'Home (change)', module: 'M', owners: ['Home'], changes: ['x'],
      job: { ops: [{ op: 'html', data: { screen: 'Home', basedOn: { capture: 'c', html: 'h' }, edit: ['<the changed element>'] } }] } } } } };
  };
  const logic = await codeRead({ lane: 'odc', part: 'logic', target: 'C:\\c.oml' }, { map });
  assert.equal(calls[0].view, 'flow'); assert.equal(logic.empty, true); assert.equal(logic.continuations.grammar.arguments.part, 'logic');
  assert.deepEqual(logic.continuations.action, { tool: 'ssam_code', arguments: { ...pin, action: 'read', part: 'logic', element: '<name or @key>' } });
  const ddl = await codeRead({ lane: 'odc', part: 'ddl', target: 'C:\\c.oml' }, { map });
  assert.equal(ddl.empty, true); assert.equal(ddl.form, 'ssam-ddl/1'); assert.equal(ddl.continuations.page.tool, 'ssam_code');
  const html = await codeRead({ lane: 'odc', part: 'html', target: 'C:\\c.oml', element: 'Home' }, { map });
  assert.equal(calls.at(-1).screen, 'Home'); assert.equal(html.empty, undefined);
  assert.deepEqual(html.continuations.edit.arguments, { lane: 'odc', feature: 'Home (change)', module: 'M', owners: ['Home'], changes: ['x'], action: 'write', part: 'html', element: 'Home', text: ['<the changed element>'], basedOn: { capture: 'c', html: 'h' } });
  const missing = await codeRead({ lane: 'o11', part: 'logic', target: 'M', element: 'Nope' }, { map: async () => ({ ok: false, error: 'element Nope names no action of this capture' }) });
  assert.equal(missing.continuations.write.arguments.action, 'write'); assert.equal(missing.continuations.grammar.arguments.action, 'grammar');
  // The ssam_map continuation of a delivery with a logic text, as ssam_code write.
  assert.deepEqual(codeCall({ tool: 'o11_deliver', arguments: { module: 'M', job: { ops: [{ op: 'logic', data: { flow: [{ text: 't', basedOn: 's' }] } }] } } }).arguments,
    { lane: 'o11', module: 'M', action: 'write', part: 'logic', text: 't', basedOn: 's' });
});

// A fake ODC lane server: studio_deliver records what reached it (the relay of ssam.mjs writes inline jobs to files).
async function liveServer(t, { answer = () => ({ ok: true, result: 'delivered' }), codeMap = async input => ({ ok: true, count: 0, entries: [], echo: input }) } = {}) {
  const root = tmp(t); const seen = [];
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('studio_deliver', { description: 'Deliver.', inputSchema: z.object({ feature: z.string().min(1), module: z.string().optional(), job: z.string().optional(),
      owners: z.array(z.string()).optional(), changes: z.array(z.string()).optional(), until: z.string().optional(), publish: z.boolean().optional(), authorize: z.string().optional() }).strict() },
    async args => { seen.push(args); const value = answer(args); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) }; });
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot: root, answersRoot: root, codeMap, lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ssam-code-test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, seen, root };
}

test('live: ssam_code is listed for both lanes; write goes through the studio_deliver relay of the server; aliases reach it in kernel form', async t => {
  const { client, seen } = await liveServer(t);
  const tools = (await client.listTools()).tools;
  const tool = tools.find(x => x.name === 'ssam_code');
  assert.ok(tool, 'ssam_code is listed');
  assert.deepEqual(tool.inputSchema.properties.lane.enum.sort(), ['o11', 'odc']);
  assert.match(tool.description, /SQL DDL/); assert.match(tool.description, /pseudocode/); assert.match(tool.description, /HTML/); assert.match(tool.description, /grammar/);
  const g = valueOf(await client.callTool({ name: 'ssam_code', arguments: { lane: 'odc', action: 'grammar', part: 'ddl' } }));
  // The requested grammar can exceed the generic answer budget; its exact continuation
  // keeps the whole grammar card, including the proven example.
  const grammar = g.card ? g : JSON.parse(fs.readFileSync(g.omitted.arguments.file, 'utf8'));
  assert.equal(grammar.card.example, EXAMPLE_DDL);
  const w = valueOf(await client.callTool({ name: 'ssam_code', arguments: { lane: 'odc', action: 'write', part: 'ddl', module: 'VisitaCerta_CS', text: EXAMPLE_DDL } }));
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(seen.length, 1); assert.equal(seen[0].module, 'VisitaCerta_CS'); assert.deepEqual(seen[0].owners, ['Customer', 'Visit', 'VisitStatus', 'VisitTotals', 'VisitRow']);
  assert.deepEqual(JSON.parse(fs.readFileSync(seen[0].job, 'utf8')), { ops: [{ op: 'spec', data: { ddl: EXAMPLE_DDL } }] });
  // studio_deliver itself with the job op alias "ddl": the relay writes the kernel form.
  await client.callTool({ name: 'studio_deliver', arguments: { feature: 'f', module: 'M', owners: ['A'], changes: ['c'], job: { ops: [{ op: 'ddl', data: { text: 'create entity A ();' } }] } } });
  assert.deepEqual(JSON.parse(fs.readFileSync(seen[1].job, 'utf8')).ops[0], { op: 'spec', data: { ddl: 'create entity A ();' } });
  // A lane this server does not serve answers so, without a second path.
  const o11 = valueOf(await client.callTool({ name: 'ssam_code', arguments: { lane: 'o11', action: 'write', part: 'ddl', module: 'M', text: 'x' } }));
  assert.equal(o11.code, 'LANE_NOT_SERVED');
  const r = valueOf(await client.callTool({ name: 'ssam_code', arguments: { lane: 'odc', action: 'read', part: 'logic', target: 'C:\\x.oml' } }));
  assert.equal(r.echo.view, 'flow'); assert.equal(r.empty, true);
  // Every text route of ssam_discover carries the same calls as ssam_code, valid against the live schema.
  const validate = new Ajv({ strict: false, allErrors: true }).compile((({ $schema: _s, ...s }) => s)(tool.inputSchema));
  for (const lane of ['o11', 'odc']) for (const id of TEXT_ROUTE_IDS) {
    const section = sectionOf({ id, also: [], why: [] }, lane);
    for (const call of [section.code.read, section.code.write]) {
      assert.equal(call.tool, 'ssam_code', `${lane} ${id}`);
      assert.ok(validate(call.arguments), `${lane} ${id} ${JSON.stringify(validate.errors)}`);
    }
  }
  assert.ok(validate(exampleCall('o11').arguments), JSON.stringify(validate.errors));
  assert.ok(validate(serviceExampleCall('odc').arguments), JSON.stringify(validate.errors));
});

test('live odc: owners reach studio_deliver (the screen of an edit and of a screen action); a correction carries them from the refused job', async t => {
  const { client, seen } = await liveServer(t);
  const call = args => client.callTool({ name: 'ssam_code', arguments: { lane: 'odc', action: 'write', module: 'VisitaCerta', ...args } }).then(valueOf);
  const basedOn = { capture: 'c'.repeat(64), html: 'd'.repeat(64) };
  assert.equal((await call({ part: 'html', element: 'Visitas', text: '<button k="w7" class="btn">Ok</button>', basedOn })).ok, true);
  assert.deepEqual(seen.at(-1).owners, ['Visitas']);
  assert.equal((await call({ part: 'logic', text: 'action Visitas.Cancelar\n  end\n' })).ok, true);
  assert.deepEqual(seen.at(-1).owners, ['Visitas', 'Cancelar']);
  // The documented order with a new action: logic first in the job the relay wrote.
  await call({ part: 'html', element: 'Visitas', text: ['<div k="w7"><button onclick="Cancelar()">Cancelar</button></div>'], basedOn, also: [{ part: 'logic', text: 'action Visitas.Cancelar\n  end\n' }] });
  const written = JSON.parse(fs.readFileSync(seen.at(-1).job, 'utf8'));
  assert.deepEqual(written.ops.map(o => o.op), ['logic', 'html']); assert.match(written.ops[1].data.edit[0], /onclick="Cancelar"/);
  assert.deepEqual(seen.at(-1).owners, ['Visitas', 'Cancelar']);
  // A correction (patch + basedOn {job, sha256} of the refused write): owners and changes from its job; the relay patches it.
  const base = seen.at(-1).job; const sha = createHash('sha256').update(fs.readFileSync(base)).digest('hex');
  const fixed = await call({ part: 'html', patch: [{ op: 'replace', path: '/ops/1/data/edit/0', value: '<div k="w7"/>' }], basedOn: { job: base, sha256: sha } });
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  assert.deepEqual(seen.at(-1).owners, ['Visitas', 'Cancelar']); assert.ok(seen.at(-1).changes.length >= 2);
  assert.equal(JSON.parse(fs.readFileSync(seen.at(-1).job, 'utf8')).ops[1].data.edit[0], '<div k="w7"/>');
  // A partial action text never reaches the delivery.
  const before = seen.length;
  const gap = await call({ part: 'logic', text: 'server action X @kXxxxxxx\n  assign A = 1 @n3\n  end @n4\n', basedOn: 'sha' });
  assert.equal(gap.code, 'INPUT_INVALID'); assert.match(gap.error, /leaves out @n1, @n2/); assert.equal(seen.length, before);
});

test('live: a text refusal of the delivery comes back in ssam_code words with the grammar continuation', async t => {
  const { client } = await liveServer(t, { answer: () => ({ ok: false, code: 'DDL_SYNTAX', error: "line 2: unknown attribute clause ''",
    problems: [{ code: 'DDL_SYNTAX', message: "line 2: unknown attribute clause ''", fix: 'write the data as ssam_map view:"ddl" reads it' }] }) });
  const r = valueOf(await client.callTool({ name: 'ssam_code', arguments: { lane: 'odc', action: 'write', part: 'ddl', module: 'M', text: 'create entity A (\n  Id Long Integer identifier auto required,\n  B Text(10) required unique\n);' } }));
  assert.equal(r.ok, false); assert.equal(r.continuations.grammar.arguments.part, 'ddl');
  assert.match(r.problems[0].fix, /ssam_code read \(part ddl\)/);
  assert.match(r.error, /^1 problems: DDL_SYNTAX x1$/);
  assert.match(r.problems[0].message, /Id Long Integer identifier auto required/);
});

test('live: every continuation of a read (the list of the actions pages by offset and max) is valid in the ssam_code schema', async t => {
  const pin = { lane: 'odc', target: 'C:\\c.oml', view: 'flow', budgetBytes: 4000, expectedSourceSha256: 'f'.repeat(64) };
  const asked = [];
  const codeMap = async input => {
    asked.push(input);
    return { ok: true, count: 181, offset: input.offset ?? 0, returned: 100, nextOffset: 100, entries: [{ name: 'A' }],
      continuations: { next: { tool: 'ssam_map', arguments: { ...pin, offset: 100, max: 100 } }, action: { tool: 'ssam_map', arguments: { ...pin, element: '<name or @key>' } } } };
  };
  const { client } = await liveServer(t, { codeMap });
  const tool = (await client.listTools()).tools.find(x => x.name === 'ssam_code');
  const validate = new Ajv({ strict: false, allErrors: true }).compile((({ $schema: _s, ...s }) => s)(tool.inputSchema));
  const first = valueOf(await client.callTool({ name: 'ssam_code', arguments: { lane: 'odc', action: 'read', part: 'logic', target: 'C:\\c.oml' } }));
  for (const [name, call] of Object.entries(first.continuations)) if (call?.tool === 'ssam_code') assert.ok(validate(call.arguments), name + ' ' + JSON.stringify(validate.errors));
  const next = first.continuations.next;
  assert.deepEqual([next.arguments.offset, next.arguments.max], [100, 100]);
  const second = valueOf(await client.callTool({ name: 'ssam_code', arguments: next.arguments }));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual([asked.at(-1).offset, asked.at(-1).max, asked.at(-1).view], [100, 100, 'flow']);
  assert.ok(validate({ lane: 'o11', action: 'read', part: 'logic', target: 'M', includeDetail: true }));
});

// ---- the grammar examples through the kernel CLIs (both lanes), and read back
const CLI = { o11: process.env.SSAM_CODE_CLI_O11 ? path.join(process.env.SSAM_CODE_CLI_O11, 'anvil.dll') : null,
  odc: process.env.SSAM_CODE_CLI_ODC ? path.join(process.env.SSAM_CODE_CLI_ODC, 'anvil-odc.dll') : null };
const BASE = { o11: path.join(fixtures, 'reactive-ui.oml'), odc: path.join(fixtures, 'odc', 'insurance-reactive-r8.oml') };
const EMPTY = { o11: path.join(fixtures, 'blank-service.oml'), odc: path.join(fixtures, 'odc', 'blank-mobile.oml') };
function cli(lane, args, env) {
  const r = spawnSync('dotnet', [CLI[lane], ...args], { env, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 600000 });
  const at = r.stdout.search(/^\{/m);
  try { return JSON.parse(r.stdout.slice(at)); } catch { return { ok: false, error: (r.stdout + r.stderr).slice(-2000) }; }
}
// A read the CLI must accept: its error, when it refuses, is in the assertion (an intermittent ODC ddl read failure of
// 2026-10-13 under a parallel run showed only false !== true).
function cliOk(lane, args, env) { const r = cli(lane, args, env); assert.equal(r.ok, true, args[0] + ': ' + JSON.stringify(r.error ?? r.problems ?? r).slice(0, 2000)); return r; }
// The code as the reader prints it, without the keys and ids the platform gave (-- @key, @n1, k="w1").
const bare = text => text.split('\n').map(l => l.trimStart().startsWith('|') ? l
  : l.replace(/\s+-- @\S+$/, '').replace(/ @[A-Za-z0-9+/_=-]+$/, '').replace(/ k="w\d+"/g, '')).join('\n');

for (const lane of ['o11', 'odc']) {
  const skip = !(CLI[lane] && fs.existsSync(CLI[lane])) && `${lane} CLI not given (SSAM_CODE_CLI_${lane.toUpperCase()})`;
  test(`${lane}: the grammar examples apply from scratch on a fixture and read back as written (CLI and ssam_code read)`, { skip, timeout: 900000 }, async t => {
    const examples = exampleLogicTexts(lane);
    const dir = tmp(t);
    const env = { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_NO_WARM: '1', SSAM_MODULE_INDEX_ROOT: path.join(dir, 'index') };
    // The isolated profile intentionally has no Studio cache. Copy the current user's offline cache into this test's
    // private work area; never initialize or write the live Studio profile.
    if (lane === 'odc' && !env.ANVIL_ODC_FEATURES_DIR && originalLocalAppData) {
      const source = path.join(originalLocalAppData, 'OutSystems', 'ODC Studio');
      const dest = path.join(dir, 'features'); fs.mkdirSync(dest, { recursive: true });
      for (const name of ['Features.xml', 'FeaturesOverride.xml']) {
        const file = path.join(source, name); if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dest, name));
      }
      env.ANVIL_ODC_FEATURES_DIR = dest;
    }
    const job = path.join(dir, 'job.json');
    fs.writeFileSync(job, JSON.stringify(writeCall(exampleCall(lane).arguments).arguments.job));
    const out = path.join(dir, 'out.oml');
    const applied = cli(lane, ['apply', '--job', job, '--base', BASE[lane], '--out', out, '--work', path.join(dir, 'work')], env);
    assert.equal(applied.ok, true, JSON.stringify({ error: applied.error, problems: applied.problems ?? applied.data?.problems }).slice(0, 3000));
    assert.equal(applied.data.accepted, true); assert.equal(applied.data.isValid, true);
    // Read back by the CLIs (these also fill the store moduleMap reads).
    const ddlFile = path.join(dir, 'm.ddl'); const flowFile = path.join(dir, 'a.flow'); const htmlFile = path.join(dir, 's.html');
    cliOk(lane, ['ddl', '--oml', out, '--out', ddlFile], env);
    cliOk(lane, ['flow', '--oml', out, '--out', flowFile], env);
    cliOk(lane, ['html-read', '--oml', out, '--path', 'Visits', '--out', htmlFile], env);
    const ddlRead = bare(fs.readFileSync(ddlFile, 'utf8').replace(/\r\n/g, '\n'));
    // The UI example: the service data plus a client variable with its default (one line, no ';').
    for (const block of EXAMPLE_DDL_UI.split('\n\n')) assert.ok(ddlRead.includes(block.trim()), 'ddl block read back as written:\n' + block);
    const htmlRead = bare(fs.readFileSync(htmlFile, 'utf8').replace(/\r\n/g, '\n'));
    for (const line of ['<var name="Filter" type="Text"/>', '<div list="GetVisits.List">', '{{ GetVisits.List.Current.Visit.VisitTitle }}', 'onclick="Complete(VisitId = GetVisits.List.Current.Visit.Id)"',
      // The popup from scratch: its variable, its open and close buttons, the Transition of an event inside it.
      '<popup show="ShowSummary">', '</popup>'])
      assert.ok(htmlRead.includes(line), 'html: ' + line);
    // Every exact form a card names is read back as the card writes it (ddl, html; logic below).
    for (const [name, form] of Object.entries(CODE_FORMS_EXACT.ddl)) assert.ok(ddlRead.includes(form), `ddl form "${name}" read back: ${form}`);
    for (const [name, form] of Object.entries(CODE_FORMS_EXACT.html)) assert.ok(htmlRead.includes(form), `html form "${name}" read back: ${form}`);
    const flowRead = bare(fs.readFileSync(flowFile, 'utf8').replace(/\r\n/g, '\n'));
    for (const [name, form] of Object.entries(CODE_FORMS_EXACT.logic)) assert.ok(flowRead.includes(form), `logic form "${name}" read back: ${form}`);
    for (const text of examples.slice(2)) assert.ok(flowRead.includes(text.trim()), 'the action reads back as written:\n' + text);
    // ssam_code read over the result (the real moduleMap, from the store the CLIs wrote; no reader process).
    const noReader = async () => { throw new Error('no reader: the store must serve'); };
    const map = input => moduleMap(input, { env, read: noReader });
    const action = await codeRead({ lane, part: 'logic', target: out, element: 'CompleteVisit' }, { map });
    assert.equal(action.ok, true, JSON.stringify(action).slice(0, 1500));
    assert.equal(bare(action.text.replace(/\r\n/g, '\n')).trim(), EXAMPLE_LOGIC[0].trim(), 'the server action reads back as written');
    assert.equal(action.continuations.list.tool, 'ssam_code');
    const viaAlias = await moduleMap({ lane, target: out, view: 'logic', element: 'CompleteVisit' }, { env, read: noReader });
    assert.equal(viaAlias.text, action.text, 'ssam_map view logic = view flow');
    const data = await codeRead({ lane, part: 'ddl', target: out, element: 'Visit' }, { map });
    assert.equal(data.ok, true); assert.match(data.text, /create entity Visit label VisitTitle/); assert.equal(data.empty, undefined);
    // An empty module: its data reads as an empty document with the grammar, never an error.
    const emptyDdl = path.join(dir, 'e.ddl');
    cliOk(lane, ['ddl', '--oml', EMPTY[lane], '--out', emptyDdl], env);
    const empty = await codeRead({ lane, part: 'ddl', target: EMPTY[lane] }, { map });
    assert.equal(empty.ok, true, JSON.stringify(empty).slice(0, 800)); assert.equal(empty.empty, true); assert.equal(empty.continuations.grammar.arguments.action, 'grammar');
    // The first example of the grammar (an empty or service module: data and a server action) applies on the empty module.
    const serviceJob = path.join(dir, 'service.json');
    fs.writeFileSync(serviceJob, JSON.stringify(writeCall(grammarCard(null, lane).example.call.arguments).arguments.job));
    const service = cli(lane, ['apply', '--job', serviceJob, '--base', EMPTY[lane], '--out', path.join(dir, 'service.oml'), '--work', path.join(dir, 'work-s')], env);
    assert.equal(service.ok, true, JSON.stringify({ error: service.error, problems: service.problems ?? service.data?.problems }).slice(0, 3000));
    assert.equal(service.data.accepted, true); assert.equal(service.data.isValid, true);
    const serviceFlow = path.join(dir, 'service.flow');
    cliOk(lane, ['flow', '--oml', path.join(dir, 'service.oml'), '--out', serviceFlow], env);
    const serviceRead = bare(fs.readFileSync(serviceFlow, 'utf8').replace(/\r\n/g, '\n'));
    for (const [name, form] of Object.entries(CODE_FORMS_EXACT.logic).filter(([name]) => name !== 'screen action'))
      assert.ok(serviceRead.includes(form), `service logic form "${name}" read back: ${form}`);
    for (const text of examples.filter(text => /^server action /m.test(text)))
      assert.ok(serviceRead.includes(text.trim()), 'the whole server action reads back identically:\n' + text);
  });
}
