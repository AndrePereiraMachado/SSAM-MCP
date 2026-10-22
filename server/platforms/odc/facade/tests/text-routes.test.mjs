// B2 of the plan "Texto do SSAM" (docs/TEXTO-SSAM.md): the text routes of ssam_discover (text-routes.mjs). 20 requests per
// route, pt and en (fixtures/text-routes-phrases.json), reach their route with the ready read and delivery calls of the lane
// in the first answer, within 40 KB; the ready calls pass the live schemas of the ssam server; the operations of the tool
// fixtures get no text route unless they also carry a model change; the cut rule (a route not wired answers its read and no
// delivery). The classifier and the schemas need nothing but this checkout; the answers need the lane CLIs (skipped otherwise).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireBytes } from './fixtures/answer-wire.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import Ajv from 'ajv';
import { classifyTextRoute, textRouteSection, sectionOf, sectionLevels, WIRED, TEXT_ROUTE_IDS, TEXT_ROUTE_SCHEMA, textFormOf, textFormRefusal } from '../text-routes.mjs';
import { runJob } from '../job-runner.mjs';
import { laneSources } from '../discovery.mjs';
import { discoverAll } from '../tool-routing.mjs';
import { createSsamServer } from '../ssam.mjs';
import { snapshotSources } from './fixtures/discovery-results.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = name => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));
const phrases = fixture('text-routes-phrases.json');
const DELIVER = { o11: 'o11_deliver', odc: 'studio_deliver' };
const built = { o11: fs.existsSync(laneSources('o11').cli), odc: fs.existsSync(laneSources('odc').cli) };

test('20 requests per route (10 pt, 10 en) reach their text route; the operations and refactorings reach none', () => {
  assert.deepEqual(Object.keys(phrases.routes).sort(), [...TEXT_ROUTE_IDS].sort());
  const misses = [];
  for (const [id, list] of Object.entries(phrases.routes)) {
    assert.equal(list.length, 20, id); assert.equal(list.filter(p => p.lang === 'pt').length, 10, id + ' pt'); assert.equal(list.filter(p => p.lang === 'en').length, 10, id + ' en');
    for (const p of list) { const r = classifyTextRoute(p.intent); if (r?.id !== id) misses.push(`${id} <- "${p.intent}" -> ${r?.id ?? 'none'}`); }
  }
  for (const intent of phrases.none) { const r = classifyTextRoute(intent); if (r) misses.push(`none <- "${intent}" -> ${r.id} (${r.why.join(', ')})`); }
  assert.deepEqual(misses, []);
  // Deterministic: the same words, the same route.
  for (const p of phrases.routes['data.ddl']) assert.deepEqual(classifyTextRoute(p.intent), classifyTextRoute(p.intent));
});

test('a new screen, block or data action is a text of the logic route (its header names the owner: action Screen.Name)', () => {
  for (const intent of ['create a screen action', 'criar uma screen action na tela Pedidos', 'add a data action to the Orders screen that fetches on demand',
    'criar uma data action na tela Clientes'])
    assert.equal(classifyTextRoute(intent)?.id, 'logic.flow', intent);
  const section = sectionOf({ id: 'logic.flow', also: [], why: [] }, 'o11');
  assert.match(section.slots.text, /action <Screen>\.Name/);
  assert.ok(section.rules.some(r => /names its owner/.test(r)));
});

test('the operation requests of the tool fixtures get no text route, except the model part of a mixed request', () => {
  const loud = [];
  for (const f of ['discover-tool-eval.json', 'discover-tool-heldout.json', 'discover-tool-verifier.json'])
    for (const it of fixture(f).items.filter(i => i.expect.kind === 'tool')) { const r = classifyTextRoute(it.intent); if (r) loud.push(`${it.intent} -> ${r.id}`); }
  assert.deepEqual(loud.sort(), [
    'abrir o módulo Vendas e criar a entidade Pedido com atributos Numero e Data -> data.ddl',
    'add a static entity Status with records and deploy to QA -> data.ddl',
    'add an aggregate to the screen and then publish the module -> ui.screen-html-edit',
    'criar a tela de listagem de clientes e publicar -> ui.screen-html',
    'open module HR_CS and add a server action CalculateSalary -> logic.flow',
  ].sort());
});

// The conferência of 2026-10-12 (C:\t\tx\PROVA-AO-VIVO-TEXTO.md, section 6): requests written the owner's way, naming no kind
// of element ("campo" of an entity, an attribute named Acao, an action by its name, a length in characters), and similar ones.
test("the owner's way of writing: an attribute named like a word, a field of an entity, an action by its name, a length", () => {
  const cases = [
    ['data.ddl', 'adiciona o campo Observacao Text(500) na QuoteAudit e deixa Acao obrigatório'],
    ['data.ddl', 'adiciona o campo Observacao na QuoteAudit'],
    ['data.ddl', 'aumenta o Comentario da Avaliacao pra 1000 caracteres'],
    ['logic.flow', 'corrige a CalcularMediaAvaliacoes pra devolver 0 quando o jogo não tem avaliação'],
    ['logic.flow', 'corrige a CalcularMediaAvaliacoes: quando o jogo não tem avaliação ela tem que devolver 0 em vez de dar erro'],
    ['ui.screen-html-edit', 'na tela Cart o botão de checkout tá colado no aviso de saldo, coloca um espaço entre eles e muda o texto pra Finalizar compra'],
    ['data.ddl', 'adiciona o campo Observacao Text(500) na QuoteAudit'],
    ['data.ddl', 'deixa Acao obrigatório na QuoteAudit'],
    ['data.ddl', 'na QuoteAudit deixa o campo Acao obrigatório'],
    ['data.ddl', 'cria o campo Prioridade Integer na SsamProvaNota'],
    ['data.ddl', 'aumenta o Texto da Nota pra 1000 caracteres'],
    ['data.ddl', 'add the field Notes Text(500) to QuoteAudit and make Action mandatory'],
    ['logic.flow', 'corrige a ObterSaldo pra retornar 0 quando não houver lançamentos'],
    ['logic.flow', 'fix GetQuoteTotal to return 0 when the quote has no lines'],
    ['ui.screen-html-edit', 'na tela Cart coloca um espaço entre o aviso de saldo e o botão de checkout'],
    ['ui.screen-html-edit', 'na tela SsamProvaNotas deixa o título em negrito'],
    // a field of a screen stays the screen's
    ['ui.screen-html-edit', 'deixa o campo Nome obrigatório na tela Cadastro'],
    ['ui.screen-html-edit', 'adiciona o campo de busca na tela Home'],
    ['ui.screen-html', 'cria uma tela ObterDados com um campo de busca'],
  ];
  const misses = cases.map(([id, intent]) => [id, intent, classifyTextRoute(intent)?.id ?? 'none']).filter(([id, , got]) => got !== id)
    .map(([id, intent, got]) => `${id} <- "${intent}" -> ${got}`);
  assert.deepEqual(misses, []);
  // Still no route: a test record, a debugger session.
  for (const intent of ['insere um produto de teste na entidade Produto', 'set a breakpoint and debug GetCustomers', 'debugar a CalcularMediaAvaliacoes com o jogo 3'])
    assert.equal(classifyTextRoute(intent), null, intent);
});

test('WIRED is a switch: a route set to false loses its delivery, and its write form is refused before the kernel runs', async () => {
  const basedOn = { capture: 'a'.repeat(64), html: 'b'.repeat(64) };
  assert.equal(textFormOf({ op: 'logic', data: { flow: 'server action A\n  end\n' } }), 'logic.flow');
  assert.equal(textFormOf({ op: 'spec', data: { basedOn: 'c'.repeat(64), ddl: 'create entity A (\n  B Text(50)\n)' } }), 'data.ddl');
  assert.equal(textFormOf({ op: 'html', data: { html: '<screen name="A"></screen>' } }), 'ui.screen-html');
  assert.equal(textFormOf({ op: 'html', data: { screen: 'A', basedOn, edit: ['<div k="w1"/>'] } }), 'ui.screen-html-edit');
  assert.equal(textFormOf({ op: 'html', data: { screen: 'A', basedOn, html: '<screen name="A"></screen>' } }), 'ui.screen-html-edit');
  assert.equal(textFormOf({ op: 'logic', data: { actions: [] } }), null);
  assert.equal(textFormOf({ op: 'spec', data: { entities: [] } }), null);
  assert.equal(textFormOf({ op: 'html', parent: '$screen', data: { html: '<screen name="A"/>' } }), null);
  const job = { ops: [{ op: 'spec', data: { entities: [] } }, { op: 'logic', data: { flow: 'server action A\n  end\n' } }] };
  assert.equal(textFormRefusal(job), null, 'every route is wired today');
  const off = textFormRefusal(job, { ...WIRED, 'logic.flow': false });
  assert.equal(off.code, 'TEXT_FORM_NOT_WIRED');
  assert.deepEqual(off.problems.map(p => [p.op, p.pointer, p.code]), [[1, '/ops/1', 'TEXT_FORM_NOT_WIRED']]);
  assert.deepEqual(textFormRefusal(job.ops, { ...WIRED, 'logic.flow': false }).problems.map(p => p.pointer), ['/1']);
  // The headless job of this server with the switch off: refused before the kernel (no CLI runs).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-wired-'));
  const file = path.join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify(job));
  WIRED['logic.flow'] = false;
  try {
    const value = await runJob({ lane: 'o11', job: file }, { runAnvil: () => { throw new Error('the kernel ran'); }, worker: null });
    assert.equal(value.code, 'TEXT_FORM_NOT_WIRED', JSON.stringify(value));
    assert.equal(value.problems[0].pointer, '/ops/1');
  } finally { WIRED['logic.flow'] = true; fs.rmSync(dir, { recursive: true, force: true }); }
});

// The review of rounds 1 and 2 (w1-composite, w2-components-doc): a composite job and an html op with a components key passed a
// route set to false, and the kernel ran them. Now a components key beside a document or an edit is still that form (the
// kernel's order), and a composite job is judged in its parts (a part not read here is refused while a route is off).
test('WIRED holds a composite job and an html op that also carries components', async () => {
  const basedOn = { capture: 'a'.repeat(64), html: 'b'.repeat(64) };
  assert.equal(textFormOf({ op: 'html', data: { html: '<screen name="A"></screen>', components: 'ignored' } }), 'ui.screen-html');
  assert.equal(textFormOf({ op: 'html', data: { screen: 'A', basedOn, edit: ['<div k="w1"/>'], components: 'ignored' } }), 'ui.screen-html-edit');
  assert.equal(textFormOf({ op: 'html', data: { components: '<x/>' } }), null, 'the components form alone is no text form');
  const off = { ...WIRED, 'logic.flow': false, 'ui.screen-html': false };
  const doc = { ops: [{ op: 'html', data: { html: '<screen name="VerifWired"></screen>', components: 'ignored' } }] };
  assert.deepEqual(textFormRefusal(doc, off).problems.map(p => p.pointer), ['/ops/0']);
  const part = { ops: [{ op: 'logic', data: { flow: 'server action SomaWired\n  end\n' } }] };
  const composite = { jobs: ['part.json', 'job:other'] };
  const parts = { 'part.json': part, 'job:other': { ops: [{ op: 'spec', data: { entities: [] } }] } };
  const judged = textFormRefusal(composite, off, { readPart: spec => parts[spec] ?? null });
  assert.deepEqual(judged.problems.map(p => [p.pointer, p.part]), [['/jobs/0/ops/0', 'part.json']]);
  // A part the server cannot read: refused while a route is off; with every route on, nothing is read or refused.
  assert.equal(textFormRefusal({ jobs: ['missing.json'] }, off, { readPart: () => null }).problems[0].pointer, '/jobs/0');
  assert.equal(textFormRefusal({ jobs: ['missing.json'] }, off).problems[0].code, 'TEXT_FORM_NOT_WIRED');
  assert.equal(textFormRefusal(composite, WIRED, { readPart: () => { throw new Error('read with every route on'); } }), null);
  // Through the headless job of this server: the composite file and its part beside it, refused before the kernel.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-wired-composite-'));
  fs.writeFileSync(path.join(dir, 'part.json'), JSON.stringify(part));
  fs.writeFileSync(path.join(dir, 'composite.json'), JSON.stringify({ jobs: ['part.json'] }));
  fs.writeFileSync(path.join(dir, 'doc.json'), JSON.stringify(doc));
  WIRED['logic.flow'] = false; WIRED['ui.screen-html'] = false;
  try {
    for (const file of ['composite.json', 'doc.json']) {
      const value = await runJob({ lane: 'o11', job: path.join(dir, file) }, { runAnvil: () => { throw new Error('the kernel ran'); }, worker: null });
      assert.equal(value.code, 'TEXT_FORM_NOT_WIRED', file + ': ' + JSON.stringify(value));
    }
  } finally { WIRED['logic.flow'] = true; WIRED['ui.screen-html'] = true; fs.rmSync(dir, { recursive: true, force: true }); }
});

// The re-check of the 24.1 fixes (w1-nel-document): a document whose html starts with U+0085 was no text form here (JavaScript's
// \s has no U+0085) and a document in the kernel (.NET's \s has it), so a route set to false let it through and the kernel built
// it. The space is now the kernel's class, written out; the table below is the one ScreenHtmlEditTests.TheSpaceOfADocumentIsThe-
// ClassTheFacadeWritesOut pins the kernel to (\t \n \v \f \r, U+0085 and the separators; never U+FEFF).
test('the space before a document and after its tag is the kernel\'s, so WIRED holds what the kernel runs', () => {
  const space = c => '\t\n\v\f\r\u0085'.includes(c) || /^\p{Z}$/u.test(c);
  const wrong = [];
  for (let code = 0; code <= 0xFFFF; code++) {
    if (code >= 0xD800 && code <= 0xDFFF) continue;
    const c = String.fromCharCode(code);
    if ((textFormOf({ op: 'html', data: { html: c + '<screen name="A"></screen>' } }) === 'ui.screen-html') !== space(c)) wrong.push('before U+' + code.toString(16));
    if ((textFormOf({ op: 'html', data: { html: '<screen' + c + 'name="A"></screen>' } }) === 'ui.screen-html') !== (space(c) || c === '/' || c === '>')) wrong.push('after U+' + code.toString(16));
  }
  assert.deepEqual(wrong.slice(0, 20), []);
  const doc = '<screen name="VerifNel" roles="Registered">\n<Block name="LayoutBlank">\n <slot name="Content"><div>{{ "R1" }}</div></slot>\n</Block>\n</screen>';
  const off = { ...WIRED, 'ui.screen-html': false, 'ui.screen-html-edit': false };
  for (const lead of ['\u0085', ' ', ' ', '　']) {
    assert.equal(textFormOf({ op: 'html', data: { html: lead + doc } }), 'ui.screen-html', JSON.stringify(lead));
    assert.equal(textFormRefusal({ ops: [{ op: 'html', data: { html: lead + doc } }] }, off)?.code, 'TEXT_FORM_NOT_WIRED', JSON.stringify(lead));
  }
  // U+FEFF is no space for the kernel: no document there, none here.
  assert.equal(textFormOf({ op: 'html', data: { html: '﻿' + doc } }), null);
});

async function liveTools() {
  const server = await createSsamServer();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'text-routes-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try { return (await client.listTools()).tools; } finally { await client.close(); await server.close(); }
}

test('the ready read and delivery calls of every route and lane pass the live schemas of the ssam server', async () => {
  const tools = new Map((await liveTools()).map(t => [t.name, t]));
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validators = new Map();
  const validate = (name, args) => {
    if (!validators.has(name)) { const tool = tools.get(name); assert.ok(tool, name + ' is a live tool'); const { $schema: _s, ...schema } = tool.inputSchema; validators.set(name, ajv.compile(schema)); }
    const v = validators.get(name); return v(args) ? null : `${name}: ${JSON.stringify(v.errors)}`;
  };
  const problems = [];
  for (const lane of ['o11', 'odc']) for (const id of TEXT_ROUTE_IDS) {
    const section = sectionOf({ id, also: [], why: [] }, lane);
    assert.equal(section.schema, TEXT_ROUTE_SCHEMA);
    assert.equal(section.call.tool, DELIVER[lane], `${lane} ${id}`);
    for (const call of [section.read, section.call]) { const p = validate(call.tool, call.arguments); if (p) problems.push(`${lane} ${id} ${p}`); }
    const op = section.call.arguments.job.ops[0];
    assert.equal(op.op, { 'ui.screen-html': 'html', 'ui.screen-html-edit': 'html', 'data.ddl': 'spec', 'logic.flow': 'logic' }[id]);
    if (id === 'ui.screen-html') assert.match(op.data.html, /^<screen /);
    if (id === 'ui.screen-html-edit') assert.ok(op.data.screen && op.data.basedOn?.capture && op.data.basedOn?.html && Array.isArray(op.data.edit));
    if (id === 'data.ddl') assert.equal(typeof op.data.ddl, 'string');
    if (id === 'logic.flow') assert.ok(Array.isArray(op.data.flow) && op.data.flow[0].text && op.data.flow[0].basedOn);
    // The ODC delivery of the ssam server needs feature, module, owners and changes with a job.
    if (lane === 'odc') for (const key of ['feature', 'module', 'owners', 'changes']) assert.ok(section.call.arguments[key], `${id} ${key}`);
  }
  assert.deepEqual(problems, []);
});

test('the cut rule: every route is wired (its fixed point closed at 100%); a route not wired answers its read and no delivery', () => {
  assert.deepEqual(WIRED, { 'ui.screen-html': true, 'ui.screen-html-edit': true, 'data.ddl': true, 'logic.flow': true });
  const off = sectionOf({ id: 'data.ddl', also: [], why: [] }, 'o11', { wired: false });
  assert.equal(off.wired, false); assert.equal(off.call, null); assert.equal(off.read.tool, 'ssam_map'); assert.match(off.note, /only reading/);
  // The levels from the richest: whole (with the contract card), lean (pointer and expansion), the call alone.
  const whole = textRouteSection('criar a entidade Pedido com atributo Numero', 'odc', { slice: () => 'the contract text' });
  const [full, lean, minimal] = sectionLevels(whole);
  assert.equal(full.contract.card, 'the contract text'); assert.equal(lean.contract.card, undefined); assert.match(lean.contract.expand, /contract:spec\.ddl/);
  assert.deepEqual(Object.keys(minimal).sort(), ['call', 'id', 'note', 'read', 'schema', 'why', 'wired']);
});

for (const lane of ['o11', 'odc']) {
  test(`${lane}: every request reaches its route with the ready calls in the first ssam_discover answer, within 40 KB`, { skip: !built[lane] && `${lane} lane CLI not built`, timeout: 900000 }, async () => {
    const sources = snapshotSources(lane);
    const misses = []; let largest = 0; let withCard = 0; let withRules = 0; let n = 0;
    for (const [id, list] of Object.entries(phrases.routes)) for (const p of list) {
      n++;
      // This battery promises the full 40 KB route card; the default first reply
      // is now 5 KB and has separate coverage in answer-size/discover-tools.
      const args = { lane, intent: p.intent, budgetBytes: 40960 };
      const answer = await discoverAll({ ...args, sources });
      const size = wireBytes(answer, args); largest = Math.max(largest, size);
      const route = answer.textRoute;
      if (route?.contract?.card) withCard++;
      const why = [];
      if (answer.ok !== true) why.push('not ok');
      if (route?.id !== id) why.push('route ' + (route?.id ?? 'none'));
      if (route?.call?.tool !== DELIVER[lane]) why.push('call ' + (route?.call?.tool ?? 'none'));
      if (route?.read?.tool !== (id === 'ui.screen-html' ? 'ssam_discover' : 'ssam_map')) why.push('read ' + (route?.read?.tool ?? 'none'));
      // The slots and the owner's rules come when the model part keeps what its matches carry (fitTextRoute): counted below.
      if (route?.rules?.length) withRules++;
      if (size > 40960) why.push('bytes ' + size);
      // Read first: the section sits right after the intent (or after the tools of a mixed request).
      const keys = Object.keys(answer); if (keys.indexOf('textRoute') < 0 || keys.indexOf('textRoute') > keys.indexOf('intent') + 2) why.push('position ' + keys.indexOf('textRoute'));
      if (why.length) misses.push(`${id} "${p.intent}": ${why.join(', ')}`);
    }
    assert.deepEqual(misses, []);
    assert.ok(largest <= 40960, String(largest));
    assert.ok(withCard > 0, 'some answers carry the contract card whole');
    // Measured 2026-10-11 on the junction: O11 73/80, ODC 65/80 with the slots and rules (the others carry the call alone).
    assert.ok(withRules / n >= 0.75, `slots and rules in ${withRules}/${n}`);
    assert.equal(n, 80);
  });
}
