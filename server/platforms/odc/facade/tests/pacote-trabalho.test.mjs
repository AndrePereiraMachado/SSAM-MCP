// The work packet of ssam_discover {intent, lane, app, packet:true} (W1, work-packet.mjs): the brief an agent or subagent
// starts from. Deterministic (the same input gives the same bytes), within the answer ceiling (38912) and any smaller
// budget, in the declared order with every cut named; with a module (the elements the intent names, from a synthetic module
// digest) and without one; the team rules chosen by the intent; a proven example. The checks over the real index need the
// lane CLI; the rest runs on synthetic digests and the repository's own rule documents.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workPacket, moduleItems, namedCapabilities, ruleUnits, rulesSection, intentTopics, PACKET_ORDER, PACKET_BUDGET, PACKET_SCHEMA } from '../work-packet.mjs';
import { moduleDigest, digestFile } from '../module-map.mjs';
import { DIGEST_EXTRACTOR, DIGEST_SECTIONS } from '../module-digest.mjs';
import { discover, laneSources, parseDiscoverArguments } from '../discovery.mjs';
import { discoverAll } from '../tool-routing.mjs';
import { writeCapture } from './fixtures/module-index.mjs';

const bytes = v => Buffer.byteLength(JSON.stringify(v), 'utf8');
const block = (key, kind, name, text, extra = {}) => ({ key, kind, name, text, ...extra });

// A synthetic module digest (ModuleDigest.ToJson shape): orders, their items and a status, a few actions, one screen.
function digestOf(sourceSha256, lane = 'o11') {
  const action = (key, kind, name, inp, out, calls = [], calledBy = [], extra = {}) => ({ key, kind, name, section: 'actions', public: true, function: false, in: inp, out, calls, calledBy, ...extra });
  const actions = [
    action('A1', 'ServerAction', 'Pedido_Create', 'Pedido: PedidoDados', 'PedidoId: Pedido Identifier', ['Pedido_Validate'], []),
    action('A2', 'ServerAction', 'Pedido_Validate', 'Pedido: PedidoDados', 'IsValid: Boolean', [], ['Pedido_Create']),
    action('A3', 'ServerAction', 'Pedido_Delete', 'PedidoId: Pedido Identifier', '', [], []),
    action('A4', 'ServerAction', 'Cliente_Get', 'ClienteId: Cliente Identifier', 'Cliente: Cliente', [], []),
    ...Array.from({ length: 40 }, (_, i) => action('B' + i, 'ServerAction', 'Relatorio_' + i, 'Filtro: Text', 'Total: Integer', [], [])),
  ];
  const body = a => [a.kind === 'ServerAction' ? 'server action ' + a.name + ' @' + a.key : a.name, '  in ' + a.in, '  out ' + a.out, '  GetPedido = aggregate FROM Pedido MAX 1', '  ' + 'x'.repeat(200)].join('\n');
  const sections = {
    module: { title: 'module and references', count: 1, blocks: [block('R0', 'ESpace', 'Vendas_CS', 'ssam-digest/1 module=Vendas_CS type=Service lane=' + lane + ' key=@R0')] },
    entities: { title: 'entities', count: 4, blocks: [
      block('E1', 'ServerEntity', 'Pedido', 'entity Pedido @E1 public\n  Id: Long Integer req auto\n  ClienteId: Cliente Identifier req ->Cliente delete=Protect\n  StatusPedidoId: StatusPedido Identifier req ->StatusPedido delete=Protect\n  Total: Decimal(18,2) req'),
      block('E2', 'ServerEntity', 'PedidoItem', 'entity PedidoItem @E2 public\n  Id: Long Integer req auto\n  PedidoId: Pedido Identifier req ->Pedido delete=Protect\n  Quantidade: Integer req'),
      block('E3', 'ServerEntity', 'Cliente', 'entity Cliente @E3 public\n  Id: Long Integer req auto\n  Nome: Text(200) req'),
      block('E4', 'StaticEntity', 'StatusPedido', ['static entity StatusPedido @E4 public', '  Label: Text(50) req', ...Array.from({ length: 14 }, (_, i) => '  record S' + i + ': Label="S' + i + '"')].join('\n'), { records: 14 }),
    ] },
    structures: { title: 'structures', count: 2, blocks: [block('T1', 'Structure', 'PedidoDados', 'structure PedidoDados @T1 public\n  ClienteId: Cliente Identifier; Total: Decimal(18,2)'),
      block('T2', 'Structure', 'Paginacao', 'structure Paginacao @T2\n  Pagina: Integer; Tamanho: Integer')] },
    variables: { title: 'site properties and client/session variables', count: 0, blocks: [] },
    roles: { title: 'roles', count: 0, blocks: [] },
    exceptions: { title: 'user exceptions', count: 0, blocks: [] },
    actions: { title: 'actions', count: actions.length, blocks: actions.map(a => block(a.key, a.kind, a.name, body(a))) },
    timers: { title: 'timers', count: 0, blocks: [] },
    integrations: { title: 'REST and SOAP, consumed and exposed', count: 0, blocks: [] },
    ui: { title: 'screens, blocks and emails', count: 1, blocks: [block('S1', 'WebScreen', 'PedidoBusca', 'screen MainFlow/PedidoBusca @S1 roles=Registered\n  widget Search @W1\n  widget Table @W2')] },
    coverage: { title: 'coverage', count: 99, blocks: [block('R0', 'ESpace', 'coverage', 'elements 99: rendered 99')] },
  };
  return { schema: 'ssam-digest/1', extractor: DIGEST_EXTRACTOR, lane, adapter: 'kernel', sourceSha256, sourceBytes: 42, createdAt: '2026-10-10T00:00:00Z',
    module: { name: 'Vendas_CS', key: 'R0', kind: 'Service' }, elements: 99, notRendered: 0, clipped: 0, readErrors: 0,
    sections: DIGEST_SECTIONS.map(id => ({ id, ...sections[id] })), actions };
}
const found = (lane = 'o11') => ({ ok: true, lane, target: 'C:\\captures\\Vendas_CS.oml', file: 'C:\\captures\\Vendas_CS.oml', sourceSha256: 'a'.repeat(64), module: { name: 'Vendas_CS' }, digest: digestOf('a'.repeat(64), lane) });
// The discover parts a packet reads, synthetic: two direct matches, one dependency, a proven example of 30 ops.
function inputOf({ lane = 'o11', intent = 'criar actions de CRUD de pedido com tratamento de exceção', module = found(lane), budget } = {}) {
  const match = (id, category, score) => ({ id, category, title: id + ' title', via: 'match', score, why: ['action'], level: 'C-suite', route: { kind: 'job', operation: '{"op":"logic","data":{"actions":[...]}}' }, contract: ['logic.action', 'logic.steps.raise'], depends: [{ id: 'logic.flow' }], guidance: 'g'.repeat(300) });
  const ops = Array.from({ length: 30 }, (_, i) => ({ op: 'set', target: '$a', prop: 'Description', value: 'op ' + i + ' ' + 'v'.repeat(80) }));
  return { lane, intent, app: module ? module.target : null, basis: { index: 'k'.repeat(24) },
    matches: [match('logic.exception', 'logic', 7), match('logic.server-action', 'logic', 6), { id: 'logic.flow', via: 'dependency' }], unavailable: [],
    categories: new Map([['logic.exception', 'logic'], ['logic.server-action', 'logic']]),
    slices: (pointers, form) => Object.fromEntries((pointers ?? []).map(p => [p, form === 'full' ? { keys: ['name', 'kind', 'inputs', 'steps'], text: 't'.repeat(400) } : ['name', 'kind']])),
    steps: { kinds: ['raise'], shape: { op: 'logic' }, grammar: { raise: ['raise', 'message'] } },
    proven: { for: 'logic.exception', job: 'switch-exception-handler', path: 'tests/jobs/switch-exception-handler.json', description: 'switch and handler', base: 'tests/fixtures/blank-service.oml', level: 'C-suite', opsTotal: 30, ops, reference: null },
    example: null, module, operations: null, ...(budget ? { budget } : {}) };
}

test('the same input gives the same bytes, inside the ceiling and inside every smaller budget, sections in the declared order', () => {
  for (const budgetBytes of [PACKET_BUDGET, 20000, 12000, 8192]) {
    const a = workPacket(inputOf(), { budgetBytes });
    const b = workPacket(inputOf(), { budgetBytes });
    assert.equal(JSON.stringify(a), JSON.stringify(b), 'deterministic at ' + budgetBytes);
    assert.equal(a.ok, true); assert.equal(a.schemaVersion, PACKET_SCHEMA);
    assert.ok(bytes(a) <= budgetBytes, `${bytes(a)} > ${budgetBytes}`);
    assert.equal(a.size.bytes, bytes(a), 'size.bytes is the size returned');
    assert.equal(a.size.budgetBytes, budgetBytes);
    assert.deepEqual(a.packet.order, PACKET_ORDER);
    const keys = Object.keys(a).filter(k => PACKET_ORDER.includes(k));
    assert.deepEqual(keys, PACKET_ORDER, 'sections in the declared order');
    for (const cut of a.cuts) assert.ok(cut.section && cut.recover?.tool, JSON.stringify(cut));
    assert.equal(a.size.status, a.cuts.length ? 'reduced' : 'within');
  }
  // Nothing in the packet depends on the time: no elapsed, timings, builtAt or cache state.
  assert.doesNotMatch(JSON.stringify(workPacket(inputOf())), /elapsedMs|timings|builtAt|"cache"/);
});

test('with a module: the elements the intent names, most relevant first, the neighbours, and the overview when nothing is named', () => {
  const p = workPacket(inputOf());
  const m = p.module;
  assert.equal(m.name, 'Vendas_CS'); assert.equal(m.sourceSha256, 'a'.repeat(64));
  assert.deepEqual(m.read, { tool: 'ssam_map', arguments: { lane: 'o11', target: 'C:\\captures\\Vendas_CS.oml', view: 'digest', expectedSourceSha256: 'a'.repeat(64) } });
  assert.ok(m.words.includes('pedido') && !m.words.includes('action') && !m.words.includes('criar'), JSON.stringify(m.words));
  assert.match(m.entities[0], /^entity Pedido @E1/);
  assert.ok(m.entities.some(e => e.startsWith('entity PedidoItem')));
  assert.ok(m.entities.some(e => e.startsWith('entity Cliente')), 'the entity Pedido references');
  assert.ok(m.staticEntities[0].includes('… 4 more records'), 'records folded after ' + 10);
  assert.ok(m.actions.some(a => a.startsWith('server action Pedido_Create @A1')) && !m.actions.some(a => a.includes('Relatorio_')), 'only the actions named');
  assert.ok(m.structures.some(s => s.startsWith('structure PedidoDados')) && !(m.structures ?? []).some(s => s.includes('Paginacao')));
  assert.equal(m.bodies, undefined, 'no body unless an action is named exactly');
  // An action named exactly: its body right after it, its callees and callers next, its signature types.
  const fix = moduleItems(digestOf('b'.repeat(64)), 'corrigir a action Pedido_Create');
  assert.deepEqual(fix.items.slice(0, 2).map(x => [x.group, x.name]), [['actions', 'Pedido_Create'], ['bodies', 'Pedido_Create']]);
  assert.ok(fix.items.findIndex(x => x.name === 'Pedido_Validate') < fix.items.findIndex(x => x.name === 'Pedido_Delete'), 'the callee before another named action');
  assert.ok(fix.items.find(x => x.name === 'PedidoDados').score >= 50, 'the structure of its signature');
  assert.deepEqual(namedCapabilities(digestOf('b'.repeat(64)), 'corrigir a action Pedido_Create').map(n => n.id), ['logic.server-action', 'logic.flow']);
  assert.deepEqual(namedCapabilities(digestOf('b'.repeat(64)), 'alterar a tela PedidoBusca').map(n => n.id), ['ui.screen']);
  assert.deepEqual(namedCapabilities(digestOf('b'.repeat(64)), 'criar actions de CRUD de pedido'), [], 'a domain noun that is also an entity name brings no capability');
  // A screen intent brings the screen the words name; nothing named: the overview, without bodies or screens.
  assert.ok(moduleItems(digestOf('b'.repeat(64)), 'alterar a tela de busca de pedidos', { screens: true }).items.some(x => x.group === 'screens' && x.name === 'PedidoBusca'));
  const overview = moduleItems(digestOf('b'.repeat(64)), 'criar uma action nova');
  assert.equal(overview.selection, 'overview');
  assert.ok(overview.items.every(x => x.score === 0 && !['bodies', 'screens'].includes(x.group)));
  // A small budget cuts the module and says what was left out and how to read it.
  const small = workPacket(inputOf({ intent: 'alterar as actions de relatorio' }), { budgetBytes: 8192 });
  const cut = small.cuts.find(c => c.section === 'module');
  assert.ok(cut?.left.actions > 0 && small.module.actions.length > 0, JSON.stringify(small.cuts)); assert.deepEqual(cut.recover, small.module.read);
  assert.equal(small.module.actions.length + cut.left.actions, 40, 'every named action is shown or counted');
});

test('without a module: a note in the module section, the room goes to the other sections; a module that cannot be read says so', () => {
  const p = workPacket(inputOf({ module: null }));
  assert.equal(p.module.none, true);
  assert.ok(p.capabilities.items.length && p.example.job && p.rules.items.length && p.next.deliver);
  assert.equal(p.app, undefined);
  const failed = workPacket({ ...inputOf(), module: { ok: false, target: 'Vendas_CS', error: 'the O11 lane has no Studio attached' } });
  assert.equal(failed.module.ok, false); assert.match(failed.module.error, /no Studio attached/);
  assert.equal(failed.module.read.tool, 'ssam_map');
  assert.ok(bytes(failed) <= PACKET_BUDGET);
});

test('the capabilities carry operation and contract; the proven example is present, whole when it fits, by reference when it does not', () => {
  const p = workPacket(inputOf());
  assert.deepEqual(p.capabilities.items.map(i => i.id), ['logic.exception', 'logic.server-action']);
  assert.ok(p.capabilities.items[0].operation && p.capabilities.items[0].contract['logic.action']);
  assert.deepEqual(p.capabilities.requires, ['logic.flow']);
  assert.deepEqual(p.capabilities.steps.kinds, ['raise']);
  assert.equal(p.example.job, 'switch-exception-handler'); assert.equal(p.example.whole, true); assert.equal(p.example.ops.length, 30);
  assert.deepEqual(p.example.reference, { tool: 'ssam_reference', arguments: { lane: 'o11', kind: 'example', query: { id: 'switch-exception-handler' } } });
  const tight = workPacket(inputOf(), { budgetBytes: 8192 });
  assert.equal(tight.example.job, 'switch-exception-handler');
  assert.ok(tight.example.opsShown == null || tight.example.opsShown < 30);
  assert.deepEqual(tight.cuts.find(c => c.section === 'example').recover, tight.example.reference);
  // The first match's own example when no proven job fits the words.
  const fallback = workPacket({ ...inputOf(), proven: null, example: { job: 'logic-steps', path: 'tests/jobs/logic-steps.json', base: 'x', fragment: true, opsTotal: 9, ops: [{ op: 'logic' }] }, exampleFor: 'logic.exception' });
  assert.equal(fallback.example.job, 'logic-steps'); assert.equal(fallback.example.for, 'logic.exception');
  assert.equal(workPacket({ ...inputOf(), proven: null }).example.none, true);
});

test('the team rules come by the intent: exception handling, screens, the O11 timer lesson only on O11, AR1 only on O11', () => {
  const units = ruleUnits();
  assert.ok(units.some(u => u.from === 'padroes' && u.id === 'N1') && units.some(u => u.from === 'time' && /^Acesso a dados/.test(u.title)));
  assert.ok(units.filter(u => u.from === 'padroes').length >= 35, 'the 35 rules and P7');
  const ids = (lane, intent, matches = []) => rulesSection({ intent, matches, categories: new Map() }, 12000, { lane }).value.items.map(i => i.id ?? i.title);
  const crud = ids('o11', 'criar actions de CRUD de pedido com tratamento de exceção', [{ id: 'logic.exception', category: 'logic', via: 'match', score: 7 }]);
  assert.ok(crud.includes('S3'), 'exception handling: S3 ' + crud);
  assert.ok(crud.some(t => /^Acesso a dados/.test(t)) && crud.includes('N1'), crud.join(', '));
  assert.ok(!crud.includes('U1'), 'no screen rule for actions');
  const screen = ids('odc', 'alterar a tela de busca de produtos', [{ id: 'ui.screen', category: 'ui', via: 'match', score: 18 }]);
  assert.ok(screen.includes('U1') && screen.includes('S1') && !screen.includes('S3'), screen.join(', '));
  assert.ok(ids('o11', 'criar um timer que roda a cada hora').some(t => /^O11: agenda de timer/.test(t)));
  assert.ok(!ids('odc', 'criar um timer que roda a cada hora').some(t => /^O11:/.test(t)), 'O11 lessons never on ODC');
  const data = 'criar entidade de pedido com atributos';
  assert.equal(ids('odc', data, [{ id: 'data.entity', category: 'data', via: 'match', score: 9 }]).includes('AR1'), false, 'AR1 is O11 only');
  // A weak match ("crud" in a form capability) gives no topic; its words do.
  assert.deepEqual(intentTopics('crud de pedido', [{ id: 'ui.form', category: 'ui', via: 'match', score: 4 }]), ['data', 'job', 'logic', 'naming']);
  // A technique the intent names finds its rule by its words (JSONSerialize -> L6).
  assert.ok(ids('o11', 'usar json para passar dados na action').includes('L6'));
  // Never the whole text: at most 16 rules, each cut declared.
  const all = rulesSection({ intent: 'criar actions de CRUD de pedido com tratamento de exceção', matches: [{ id: 'logic.exception', category: 'logic', via: 'match', score: 7 }] }, 30000, { lane: 'o11' });
  assert.ok(all.value.items.length <= 16); assert.ok(all.cut?.left.rules > 0); assert.deepEqual(all.cut.recover, { tool: 'ssam_reference', arguments: { lane: 'o11', kind: 'rules', query: 'all' } });
});

test('next: deliver in one call and fix with patch + basedOn, per lane; the routed operations by name', () => {
  const o11 = workPacket(inputOf()).next;
  assert.equal(o11.deliver.tool, 'o11_deliver'); assert.equal(o11.deliver.arguments.module, 'Vendas_CS');
  assert.deepEqual(Object.keys(o11.fix.arguments), ['patch', 'basedOn']); assert.match(o11.fix.how, /closePrevious/);
  assert.match(o11.work, /Do not read docs/);
  const odc = workPacket(inputOf({ lane: 'odc', module: null, intent: 'criar uma tela' })).next;
  assert.equal(odc.deliver.tool, 'studio_deliver'); assert.equal(odc.deliver.arguments.module, '<Module>'); assert.doesNotMatch(odc.fix.how, /closePrevious/);
  assert.deepEqual(workPacket({ ...inputOf(), operations: [{ tool: 'o11_publish', lane: 'o11' }] }).next.operations, [{ tool: 'o11_publish', lane: 'o11' }]);
});

// Junction of round 2 (patch by name + work packet): the packet's fix speaks the correction every delivery answers with,
// nextBasedOn and patchByName, the paths by name and the partial job, in both lanes.
test('next: the fix names nextBasedOn, patchByName, paths by name and the partial job', () => {
  for (const next of [workPacket(inputOf()).next, workPacket(inputOf({ lane: 'odc', module: null, intent: 'criar uma tela' })).next]) {
    assert.match(next.fix.how, /nextBasedOn \{job, sha256\}/); assert.match(next.fix.how, /patchByName/);
    assert.match(next.fix.how, /actions\/<Action>\/steps\/<as>/); assert.match(next.fix.how, /partial job \+ basedOn/);
    assert.deepEqual(next.fix.arguments.basedOn, { job: '<nextBasedOn.job>', sha256: '<nextBasedOn.sha256>' });
  }
});

test('moduleDigest: the whole digest of a capture from the store, a miss through the lane kernel reader, a failure as ok:false', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-trabalho-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: path.join(dir, 'store'), SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  const c = writeCapture(dir);
  const file = digestFile('o11', c.sha256, env);
  const read = async () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(digestOf(c.sha256))); return { ok: true, digest: { path: file, built: true } }; };
  const reader = { entry: { cli: 'C:\\lane\\anvil.dll', root: 'C:\\kernel', lane: 'ss4' }, ssDir: 'C:\\studio' };
  const first = await moduleDigest({ lane: 'o11', target: c.file }, { env, read, reader });
  assert.equal(first.ok, true, first.error); assert.equal(first.cache.digest, 'ensured'); assert.equal(first.digest.module.name, 'Vendas_CS'); assert.equal(first.sourceSha256, c.sha256);
  const again = await moduleDigest({ lane: 'o11', target: c.file }, { env, read: async () => { throw new Error('no reader on a hit'); }, reader });
  assert.equal(again.cache.digest, 'hit');
  assert.equal((await moduleDigest({ lane: 'o11', target: '' }, { env })).ok, false);
  assert.match((await moduleDigest({ lane: 'o11', target: c.file, expectedSourceSha256: 'f'.repeat(64) }, { env, read, reader })).error, /Snapshot content changed/);
});

test('ssam_discover takes packet:true (MCP schema, CLI --packet) and the instructions send every agent to it', async () => {
  assert.equal(parseDiscoverArguments(['x', '--packet']).packet, true);
  assert.equal('packet' in parseDiscoverArguments(['x']), false);
  const { Client } = await import('@modelcontextprotocol/client');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { createFacadeServer } = await import('../mcp.mjs');
  const { createSsamServer } = await import('../ssam.mjs');
  for (const make of [() => createFacadeServer(), () => createSsamServer({ o11: false, odc: false })]) {
    const server = await make();
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pacote-trabalho', version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      assert.match(client.getInstructions(), /An agent or subagent starts its task with ssam_discover \{intent, lane, app, packet:true\}/);
      const tool = (await client.listTools()).tools.find(t => t.name === 'ssam_discover');
      if (tool) { assert.equal(tool.inputSchema.properties.packet.type, 'boolean'); assert.match(tool.description, /packet:true is the work packet/); }
    } finally { await client.close(); await server.close(); }
  }
  const agents = fs.readFileSync(fileURLToPath(new URL('../../../../AGENTS.md', import.meta.url)), 'utf8');
  assert.match(agents, /packet:true/);
});

// ---- over the real index of each lane (needs the lane CLI)
const cliSkip = lane => !fs.existsSync(laneSources(lane).cli) && `the ${lane} CLI is not built`;
const cache = {};
const sourcesOf = lane => (cache[lane] ??= { ...laneSources(lane), cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), `pacote-trabalho-${lane}-`)) });
for (const lane of ['o11', 'odc']) {
  test(`${lane}: the discover packet over the real index, with and without a module: deterministic and inside the ceiling`, { skip: cliSkip(lane), timeout: 900000 }, async () => {
    const sources = sourcesOf(lane);
    const digest = async target => ({ ...found(lane), target, file: target });
    for (const input of [{ intent: 'criar actions de CRUD de pedido com tratamento de exceção', app: 'C:\\captures\\Vendas_CS.oml' },
      { intent: 'corrigir a action Pedido_Create', app: 'C:\\captures\\Vendas_CS.oml' }, { intent: 'alterar a tela de busca de produtos' }]) {
      const a = await discoverAll({ lane, ...input, packet: true, sources, digest });
      const b = await discoverAll({ lane, ...input, packet: true, sources, digest });
      assert.equal(JSON.stringify(a), JSON.stringify(b), 'same input, same bytes: ' + input.intent);
      assert.equal(a.schemaVersion, PACKET_SCHEMA); assert.ok(a.size.bytes <= PACKET_BUDGET && bytes(a) === a.size.bytes, String(a.size.bytes));
      assert.ok(a.capabilities.items.length, 'capabilities: ' + input.intent);
      assert.ok(a.example.job, 'a proven example: ' + input.intent);
      assert.ok(a.rules.items.length, 'rules: ' + input.intent);
      if (input.app) assert.equal(a.module.name, 'Vendas_CS'); else assert.equal(a.module.none, true);
    }
    const fix = await discoverAll({ lane, intent: 'corrigir a action Pedido_Create', app: 'C:\\captures\\Vendas_CS.oml', packet: true, sources, digest });
    assert.equal(fix.capabilities.items[0].id, 'logic.server-action', 'the kind of the action named comes first');
    assert.match(fix.module.bodies[0], /^server action Pedido_Create @A1/);
    // A budget above the ceiling is held at the ceiling; a smaller one is kept.
    assert.equal((await discover({ lane, intent: 'criar actions de CRUD de pedido', packet: true, sources, budgetBytes: 1048576 })).size.budgetBytes, PACKET_BUDGET);
    const small = await discover({ lane, intent: 'criar actions de CRUD de pedido', packet: true, sources, budgetBytes: 12000 });
    assert.ok(small.size.bytes <= 12000, String(small.size.bytes));
  });
}
