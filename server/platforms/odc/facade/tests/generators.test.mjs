// Generators (generators.mjs): the rest-consume card a model finds in ssam_code grammar and in the work packet of
// ssam_discover (next.generator and next.deliver) when the intent consumes a REST API; never for exposing one or for SOAP.
// The entity-actions generator (CRUD) comes the same way in the work packet.
// The gate (owner rule 2026-10-13, "a generator only enters if it passes an independent BLIND TEST"): each generator has its
// state in GENERATOR_APPROVAL; only an approved one is offered (packet, text section, grammar, catalog). The offers below
// run under withGeneratorStates (all approved); the pending tests read the declared table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATORS, PACKET_GENERATORS, ENTITY_ACTIONS_GENERATOR, ENTITY_ACTIONS_OP, ENTITY_ACTIONS_CARD, REST_CONSUME_EXAMPLE, generatorFor, generatorCall, generatorCard,
  GENERATOR_APPROVAL, GENERATOR_STATES, GENERATE_SCREENS_OP, GENERATE_SCREENS_RULE, generatorApproval, offered, approvalIdentity, withGeneratorStates, namedGenerators, describeGenerator, generatorOfJob, jobOffered, generatorShown } from '../generators.mjs';
import { grammarCard, writeCall, ENTITY_ACTIONS_OP as SSAM_CODE_ENTITY_ACTIONS_OP, GENERATE_SCREENS_OP as SSAM_CODE_SCREENS_OP } from '../ssam-code.mjs';
import { nextSection } from '../work-packet.mjs';
import { packetTextSection } from '../text-packet.mjs';
import { composeCatalog } from '../catalog.mjs';
import { discoverAll } from '../tool-routing.mjs';
import { GUIDE_FILES } from '../runtime-guides.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GATE = 'Terceiro pedido: no VisitaCertaPortao_IS integre estes REST públicos e exponha service actions para cada um: feriados nacionais (BrasilAPI https://brasilapi.com.br/api/feriados/v1/{ano}), câmbio (Frankfurter https://api.frankfurter.app/latest?from=BRL)';
const ALL_APPROVED = Object.fromEntries(Object.keys(GENERATOR_APPROVAL).map(id => [id, { state: 'approved' }]));
const approved = fn => withGeneratorStates(ALL_APPROVED, fn);
const CRUD = ['criar actions de CRUD de pedido', 'criar server actions de listar, salvar e excluir para as entidades do modulo',
  'create CRUD server actions for the Customer and Order entities', 'criar as actions padrão das entidades'];

// ---- the gate

test('gate: one table, every generator declared with a state, a one-line reason and a report; all three pending today', () => {
  assert.deepEqual(GENERATOR_STATES, ['approved', 'blind-test-pending']);
  assert.deepEqual(Object.keys(GENERATOR_APPROVAL).sort(), ['entity-actions', 'gen-screen', 'rest-consume']);
  for (const [id, a] of Object.entries(GENERATOR_APPROVAL)) {
    assert.ok(GENERATOR_STATES.includes(a.state), id);
    assert.ok(typeof a.reason === 'string' && a.reason.length > 10 && !a.reason.includes('\n'), id + ': one-line reason');
    assert.ok(typeof a.report === 'string' && a.report.length > 4, id + ': report path');
    assert.ok(a.names.length >= 1 && typeof a.op === 'string', id);
    assert.equal(a.state, 'blind-test-pending', id + ' (2026-10-13: none approved)');
    assert.equal(offered(id), false, id);
  }
  // Every packet generator and the grammar's generators have their state in the table.
  for (const g of [...PACKET_GENERATORS, ...GENERATORS]) assert.ok(generatorApproval(g.op), g.op);
  assert.equal(generatorApproval('nope'), null);
  assert.equal(offered('nope'), false);
  assert.equal(SSAM_CODE_SCREENS_OP, GENERATE_SCREENS_OP, 'ssam-code.mjs re-exports the gen-screen op');
});

test('gate: withGeneratorStates changes the states for its call only, also on a throw, and the identity follows the states', async () => {
  const before = approvalIdentity();
  assert.equal(before, 'entity-actions=blind-test-pending;gen-screen=blind-test-pending;rest-consume=blind-test-pending');
  await approved(() => { assert.equal(offered('entity-actions'), true); assert.notEqual(approvalIdentity(), before); });
  await assert.rejects(withGeneratorStates(ALL_APPROVED, () => { throw new Error('x'); }), /x/);
  assert.equal(approvalIdentity(), before);
  assert.equal(offered('rest-consume'), false);
});

test('gate, pending: no intent of a family finds its generator; the packet and the text section answer as before them', () => {
  const module = { ok: true, digest: { module: { name: 'Vendas_CS' } } };
  for (const intent of [...CRUD, GATE, 'integrar a API de CEP', 'https://viacep.com.br/ws/01001000/json/']) {
    assert.equal(generatorFor(intent), null, intent);
    for (const lane of ['o11', 'odc']) {
      const next = nextSection({ lane, intent, module });
      assert.equal(next.generator, undefined, intent);
      const text = JSON.stringify(next);
      assert.doesNotMatch(text, /entity-actions|"op":"rest-consume"/, intent);
    }
  }
  for (const lane of ['o11', 'odc']) {
    const actions = packetTextSection({ lane, intent: 'criar actions', route: { id: 'logic.flow', verb: 'create', why: 'test' } });
    assert.equal(actions.value.generate, undefined);
    assert.doesNotMatch(JSON.stringify(actions.levels), /entity-actions/);
    const screen = packetTextSection({ lane, intent: 'criar tela nova de cadastro de clientes', route: { id: 'ui.screen-html', why: [] } });
    assert.equal(screen.value.standard, undefined);
    assert.doesNotMatch(JSON.stringify(screen.levels), /"generate"|generated, never written/);
  }
});

test('gate, pending: the ssam_code grammar is the one before the generators (no generate, generators, standardScreens or their rules)', () => {
  for (const lane of ['o11', 'odc']) {
    const all = grammarCard(null, lane);
    for (const key of ['generate', 'generators']) assert.equal(all[key], undefined, key);
    assert.doesNotMatch(all.note, /generator/);
    const logic = grammarCard('logic', lane).card;
    assert.equal(logic.generate, undefined); assert.equal(logic.generators, undefined);
    assert.ok(!logic.rules.some(r => /GENERATED|entity-actions/.test(r)));
    const html = grammarCard('html', lane).card;
    assert.equal(html.standardScreens, undefined);
    assert.ok(!html.rules.includes(GENERATE_SCREENS_RULE));
    assert.doesNotMatch(JSON.stringify(all), /entity-actions|rest-consume|"generate":\{"entities"/);
  }
});

// The fixed context of an app session (AGENTS.md) and the guides the server serves (ssam://guide/*, ssam_reference rules)
// are text, not code: they name a generator only while it is approved (on approval its AGENTS.md line comes back, c8ca0579).
test('gate, pending: AGENTS.md and the served guides never name a pending generator', () => {
  const repo = path.join(here, '..', '..', '..', '..');
  const files = ['AGENTS.md', ...Object.values(GUIDE_FILES)];
  for (const [id, a] of Object.entries(GENERATOR_APPROVAL)) {
    if (offered(id)) continue;
    const words = new RegExp([...a.names.map(n => n.replace(/[.]/g, '\\.')), ...(id === 'gen-screen' ? ['"generate"\\s*:\\s*\\{\\s*"entities"'] : [])].join('|'));
    for (const file of files) assert.doesNotMatch(fs.readFileSync(path.join(repo, file), 'utf8'), words, `${file} names ${id} (${a.state})`);
  }
});

test('gate, pending: the op stays callable explicitly (ssam_code write with the op builds the job)', () => {
  for (const lane of ['o11', 'odc']) {
    for (const op of [ENTITY_ACTIONS_OP, REST_CONSUME_EXAMPLE, GENERATE_SCREENS_OP]) {
      const call = writeCall({ lane, action: 'write', module: 'Vendas_CS', ops: [op] });
      assert.equal(call.refusal, undefined, JSON.stringify(call.refusal ?? null));
      assert.equal(call.tool, lane === 'o11' ? 'o11_deliver' : 'studio_deliver');
      assert.deepEqual(call.arguments.job.ops[0], op);
    }
  }
  // The delivery a generator's card names is the same op as a job, whatever the state.
  assert.deepEqual(generatorCall(ENTITY_ACTIONS_GENERATOR, 'o11', 'Vendas_CS').arguments.job.ops, [ENTITY_ACTIONS_OP]);
});

test('gate: a generator asked about BY NAME is described with its state, reason, report, contract and explicit call', () => {
  assert.deepEqual(namedGenerators('usar o entity-actions no Vendas_CS'), ['entity-actions']);
  assert.deepEqual(namedGenerators('o que faz o op rest-consume?'), ['rest-consume']);
  assert.deepEqual(namedGenerators('gen-screen para Cliente'), ['gen-screen']);
  assert.deepEqual(namedGenerators('screen com data.generate'), ['gen-screen']);
  for (const intent of [...CRUD, GATE, 'criar as telas padrão de lista das entidades', 'entity actions', 'consumir REST', ''])
    assert.deepEqual(namedGenerators(intent), [], intent);
  const d = describeGenerator('entity-actions', 'o11');
  assert.deepEqual([d.op, d.state, d.report], ['entity-actions', 'blind-test-pending', GENERATOR_APPROVAL['entity-actions'].report]);
  assert.match(d.use, /not offered by ssam_discover/);
  assert.deepEqual(d.contract, { tool: 'ssam_reference', arguments: { lane: 'o11', kind: 'api', query: { op: 'entity-actions' } } });
  assert.equal(writeCall(d.call.arguments).arguments.job.ops[0].op, 'entity-actions');
  const s = describeGenerator('gen-screen', 'odc');
  assert.deepEqual([s.op, s.with], ['screen', 'data.generate']);
  assert.deepEqual(s.call.arguments.ops, [GENERATE_SCREENS_OP]);
  assert.equal(describeGenerator('nope'), null);
});

test('gate: ssam_discover (discoverAll) puts the described generators after the intent, in the room they take from the budget', async () => {
  let asked = null;
  const fake = async input => { asked = input; const a = { ok: true, schemaVersion: 'ssam-discovery/4', lane: input.lane, intent: input.intent, matches: [], size: { bytes: 0, budgetBytes: input.budgetBytes, status: 'within' } }; a.size.bytes = Buffer.byteLength(JSON.stringify(a)); return a; };
  const answer = await discoverAll({ lane: 'odc', intent: 'o que faz o op rest-consume?', budgetBytes: 8192 }, { discover: fake });
  assert.deepEqual(Object.keys(answer).slice(0, 5), ['ok', 'schemaVersion', 'lane', 'intent', 'generators']);
  assert.deepEqual(answer.generators.map(g => [g.op, g.state]), [['rest-consume', 'blind-test-pending']]);
  assert.equal(answer.size.bytes, Buffer.byteLength(JSON.stringify(answer)));
  assert.ok(asked.budgetBytes < 8192 && answer.size.bytes <= 8192, `${asked.budgetBytes} ${answer.size.bytes}`);
  const packet = await discoverAll({ lane: 'o11', intent: 'criar o CRUD com entity-actions', packet: true }, { discover: fake });
  assert.equal(packet.generators[0].op, 'entity-actions');
  // Not named: nothing added, the budget as given.
  const plain = await discoverAll({ lane: 'odc', intent: 'criar actions de CRUD de pedido', budgetBytes: 8192 }, { discover: fake });
  assert.equal(plain.generators, undefined);
  assert.equal(asked.budgetBytes, 8192);
});

test('gate: the catalog composition leaves out a pending generator\'s capability and answers with its text from before it', async () => {
  const facade = path.join(here, '..');
  const sharedFile = path.join(facade, 'discovery-capabilities-shared.json');
  const sharedBytes = fs.readFileSync(sharedFile);
  const shared = JSON.parse(sharedBytes.toString('utf8').replace(/^﻿/, ''));
  const compose = () => composeCatalog({ shared, sharedBytes });
  const pending = compose();
  assert.deepEqual(pending.problems, []);
  const cap = (c, id) => c.shared.capabilities.find(x => x.id === id);
  assert.equal(cap(pending, 'logic.entity-actions'), undefined);
  assert.ok(!pending.fragments.some(f => f.capabilities.includes('logic.entity-actions')));
  const rest = cap(pending, 'integration.rest-consume');
  assert.doesNotMatch(JSON.stringify(rest), /GENERATOR FIRST|"op":"rest-consume"|rest-consume-generate|rest-consume-auth|the generator/);
  assert.deepEqual(rest.example.ops, ['rest']);
  assert.equal(rest.generator, undefined); assert.equal(rest.withoutGenerator, undefined);
  const unavailable = pending.shared.unavailable.find(u => u.id === 'integration.rest-credentials-in-model');
  assert.doesNotMatch(unavailable.alternative, /generator/);
  const on = await approved(() => compose());
  assert.deepEqual(on.problems, []);
  assert.equal(cap(on, 'logic.entity-actions').title, 'CRUD generator');
  assert.match(cap(on, 'integration.rest-consume').summary, /^GENERATOR FIRST/);
  assert.ok(cap(on, 'integration.rest-consume').platforms.o11.proofs.includes('rest-consume-generate'));
  assert.match(on.shared.unavailable.find(u => u.id === 'integration.rest-credentials-in-model').alternative, /generator/);
  // Another state is another composition identity (the discovery index is keyed by it).
  assert.notEqual(on.bytes.toString(), pending.bytes.toString());
  // A fragment that names an unknown generator does not compose.
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMPDIR ?? facade, 'gate-fragments-'));
  try {
    fs.mkdirSync(path.join(dir, 'A'));
    fs.writeFileSync(path.join(dir, 'A', 'x.json'), JSON.stringify({ schemaVersion: 'ssam-discovery-fragment/1', front: 'A', capabilities: [{ id: 'logic.x-gen', generator: 'nope', title: 'x', keywords: ['x'] }] }));
    assert.match(composeCatalog({ shared, sharedBytes, fragmentsDir: dir }).problems.join('\n'), /unknown generator 'nope'/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the offers of an approved generator (all approved here)

test('gate, pending: a suite job of a pending generator is its proof, never listed unasked (related jobs, example and recipe search, guessed op)', () => {
  // The four ways the second independent check reached a pending generator without naming it (C:\t\rel-a2\check2\CHECK.md H1-H3)
  // all list suite jobs or ops: they read the job's generator from its ops and follow the same gate.
  assert.equal(generatorOfJob({ ops: [{ op: 'set' }, { op: 'entity-actions', data: { entities: 'all' } }] }), 'entity-actions');
  assert.equal(generatorOfJob({ ops: [{ op: 'rest-consume', data: { name: 'Api' } }] }), 'rest-consume');
  assert.equal(generatorOfJob({ ops: [{ op: 'screen', data: { generate: { entities: ['Order'] } } }] }), 'gen-screen');
  assert.equal(generatorOfJob({ ops: [{ op: 'screen', data: { kind: 'table', source: 'Order' } }] }), null, 'a screen op without data.generate is no generator');
  assert.equal(generatorOfJob({ jobs: [{ ops: [{ op: 'logic' }] }, { ops: [{ op: 'rest-consume' }] }] }), 'rest-consume', 'a composite job: its sub-jobs');
  assert.equal(generatorOfJob({ ops: [{ op: 'logic' }] }), null);
  for (const job of [{ ops: [{ op: 'entity-actions' }] }, { ops: [{ op: 'rest-consume' }] }, { ops: [{ op: 'screen', data: { generate: {} } }] }])
    for (const request of ['standard actions of the entities: list, read, save and delete', 'integrar com a API da ViaCEP', 'telas padrão de todas as entidades', ''])
      assert.equal(jobOffered(job, request), false, JSON.stringify(job) + ' / ' + request);
  assert.equal(jobOffered({ ops: [{ op: 'rest-consume' }] }, 'exemplo do rest-consume'), true, 'named, it is listed');
  assert.equal(jobOffered({ ops: [{ op: 'logic' }] }, 'integrar com a API'), true, 'a job of no generator is always listed');
  assert.equal(generatorShown(null, 'x'), true);
  assert.equal(generatorShown('entity-actions', 'CRUD de pedido'), false);
  assert.equal(generatorShown('entity-actions', 'o op entity-actions'), true);
  return withGeneratorStates({ 'rest-consume': { state: 'approved' } }, () => {
    assert.equal(jobOffered({ ops: [{ op: 'rest-consume' }] }, 'integrar com a API da ViaCEP'), true, 'approved: listed');
    assert.equal(jobOffered({ ops: [{ op: 'entity-actions' }] }, 'CRUD'), false, 'the others still pending');
  });
});

test('approved: the intents of the family find the generator; exposing an API or SOAP does not', () => approved(() => {
  for (const intent of [GATE, 'consumir REST API GET com parâmetro na URL e expor service action wrapper', 'integrar a API de CEP',
    'call the weather API and return the forecast', 'https://viacep.com.br/ws/01001000/json/', 'chamar endpoint JSON de cotações'])
    assert.equal(generatorFor(intent)?.op, 'rest-consume', intent);
  for (const intent of ['expor um endpoint REST com a action GetCep', 'expose a REST API for orders', 'consumir o WSDL SOAP da calculadora', 'criar entidade Cliente', ''])
    assert.equal(generatorFor(intent), null, intent);
}));

test('approved: one generator approved, the others still pending', () => withGeneratorStates({ 'rest-consume': { state: 'approved' } }, () => {
  assert.equal(generatorFor(GATE)?.op, 'rest-consume');
  for (const intent of CRUD) assert.equal(generatorFor(intent), null, intent);
  const all = grammarCard(null, 'odc');
  assert.deepEqual(all.generators.map(g => g.op), ['rest-consume']);
  assert.equal(all.generate, undefined);
  assert.match(all.note, /generators: a REST API from its URLs/);
  assert.doesNotMatch(all.note, /entity actions/);
}));

test('the card: three lines a model copies, the rules, the contract and the delivery of each lane', () => {
  const g = GENERATORS[0];
  assert.equal(g.example.split('\n').length, 3);
  assert.deepEqual(JSON.parse(g.example), REST_CONSUME_EXAMPLE);
  const o11 = generatorCall(g, 'o11', 'Vc_IS');
  assert.equal(o11.tool, 'o11_deliver');
  assert.deepEqual(o11.arguments.job.ops, [REST_CONSUME_EXAMPLE]);
  const odc = generatorCall(g, 'odc', 'VcApp');
  assert.equal(odc.tool, 'studio_deliver');
  assert.deepEqual([odc.arguments.owners, odc.arguments.module], [['BrasilApi'], 'VcApp']);
  const card = generatorCard(g, 'o11');
  assert.deepEqual(card.contract.arguments, { lane: 'o11', kind: 'api', query: { op: 'rest-consume' } });
  assert.ok(card.rules.length >= 3 && card.when.includes('service action'));
});

test('approved: ssam_code grammar shows the generator (every part, and the logic part with its ssam_code write)', () => approved(() => {
  const all = grammarCard(null, 'o11');
  assert.equal(all.generators[0].op, 'rest-consume');
  assert.match(all.note, /generator/);
  const logic = grammarCard('logic', 'odc').card;
  assert.equal(logic.generators[0].op, 'rest-consume');
  assert.deepEqual(logic.generators[0].write, { tool: 'ssam_code', arguments: { lane: 'odc', action: 'write', module: '<Module>', ops: [REST_CONSUME_EXAMPLE] } });
}));

test('approved: the work packet delivers the generator op for a REST intent and keeps the code route otherwise', () => approved(() => {
  const module = { ok: true, digest: { module: { name: 'VisitaCertaPortao_IS' } } };
  const rest = nextSection({ lane: 'o11', intent: GATE, module });
  assert.equal(rest.generator.op, 'rest-consume');
  assert.equal(rest.deliver.tool, 'o11_deliver');
  assert.deepEqual(rest.deliver.arguments.job.ops, [REST_CONSUME_EXAMPLE]);
  assert.equal(rest.deliver.arguments.module, 'VisitaCertaPortao_IS');
  assert.match(rest.deliver.why, /rest-consume op is the job/);
  const other = nextSection({ lane: 'o11', intent: 'criar entidade Cliente com nome e email', module });
  assert.equal(other.generator, undefined);
  assert.notDeepEqual(other.deliver.arguments.job?.ops, [REST_CONSUME_EXAMPLE]);
}));

// One mechanism (integration marco-a2, 2026-10-13): the standard actions of entities are a generator of the work packet
// like rest-consume: generatorFor finds it, next.generator carries its card and its why, next.deliver its op as the job.
test('approved, one mechanism: a CRUD intent gets entity-actions in next.generator and next.deliver, like a REST intent gets rest-consume', () => approved(() => {
  const module = { ok: true, digest: { module: { name: 'Vendas_CS' } } };
  for (const intent of CRUD) {
    assert.equal(generatorFor(intent)?.op, 'entity-actions', intent);
    for (const lane of ['o11', 'odc']) {
      const next = nextSection({ lane, intent, module });
      assert.equal(next.generator.op, 'entity-actions', intent);
      assert.equal(next.generator.why, ENTITY_ACTIONS_GENERATOR.why);
      assert.deepEqual(next.generator.contract.arguments, { lane, kind: 'api', query: { op: 'entity-actions' } });
      assert.equal(next.deliver.tool, lane === 'o11' ? 'o11_deliver' : 'studio_deliver');
      assert.deepEqual(next.deliver.arguments.job.ops, [ENTITY_ACTIONS_OP]);
      assert.equal(next.deliver.arguments.module, 'Vendas_CS');
      assert.match(next.deliver.why, /the entity-actions op is the job/);
      assert.equal(next.plan, undefined, 'a generated family never asks for a plan');
    }
  }
  for (const intent of ['criar uma server action CalcularTotalPedido que soma os itens do pedido', 'corrigir a action Pedido_Create',
    'criar action que lista e remove pedidos cancelados', 'criar a entidade Produto com os atributos Nome e Preco'])
    assert.equal(generatorFor(intent), null, intent);
  // REST first: an intent that consumes an API and names CRUD words is the REST generator.
  assert.equal(generatorFor('consumir a API https://viacep.com.br/ws/{cep}/json e criar actions de CRUD do endereço')?.op, 'rest-consume');
  // Every generator of the packet: the same card fields and a why of its own; the text section's generate is the same op and card.
  assert.deepEqual(PACKET_GENERATORS.map(g => g.op), ['rest-consume', 'entity-actions']);
  for (const g of PACKET_GENERATORS) {
    assert.deepEqual(Object.keys(generatorCard(g, 'odc', 'M')), ['op', 'when', 'example', 'rules', 'contract', 'deliver']);
    assert.ok(typeof g.why === 'string' && g.why.length > 40, g.op);
  }
  assert.deepEqual(JSON.parse(ENTITY_ACTIONS_GENERATOR.example), ENTITY_ACTIONS_OP);
  assert.deepEqual(ENTITY_ACTIONS_GENERATOR.rules, ENTITY_ACTIONS_CARD.slice(1));
  assert.equal(SSAM_CODE_ENTITY_ACTIONS_OP, ENTITY_ACTIONS_OP, 'ssam-code.mjs re-exports the same op');
}));
