// The owner's re-test of 2026-10-12 (Codex on FolhaPonto_CS): the packet answered with the JSON forms only, the session
// spent 3 minutes finding a PDF component (ten calls) and five ssam_evidence calls paging one listing. Three answers:
//   1. the work packet carries the text route (text-packet.mjs): the exact read or why none, the exact delivery call with
//      the text forms, per form its grammar, contract slice and one proven example (text-examples.json), the owner's rules
//      one line each; the JSON forms it replaces go by reference, within the packet budget;
//   2. what the environment offers for a need the platform lacks (environment-components.mjs), in the packet and as a
//      direct ssam_discover intent, cached per environment;
//   3. a paged answer carries its large arrays as tables and ONE call for what is missing (paged-answer.mjs, ssam_evidence
//      table:true).
// The classifier, the sections and the paging need nothing but this checkout; the packets over the real index need the
// lane CLI, and the owner's captures (C:\t\vel\fixtures) are used when present.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireBytes } from './fixtures/answer-wire.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTextRoute } from '../text-routes.mjs';
import { packetTextSection, textExamples, coveredBy, TEXT_PACKET_SCHEMA } from '../text-packet.mjs';
import { workPacket as workPacketAtBudget, PACKET_ORDER, PACKET_BUDGET } from '../work-packet.mjs';
import { environmentComponents, componentNeeds, asksEnvironment, signatureLine, fitComponents, cacheFile, COMPONENTS_SCHEMA } from '../environment-components.mjs';
import { pagedShape, missingCall, opaqueColumns } from '../paged-answer.mjs';
import { pageAnswer } from '../ssam.mjs';
import { ANSWER_CEILING_BYTES, EXPANSION_DEFAULT_BYTES } from '../context-budget.mjs';
import { createEvidenceReader } from '../ssam-evidence.mjs';
import { laneSources } from '../discovery.mjs';
import { snapshotSources } from './fixtures/discovery-results.mjs';
import { discoverAll } from '../tool-routing.mjs';
import { DIGEST_EXTRACTOR, DIGEST_SECTIONS } from '../module-digest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// These established cases inspect content at the maximum explicit budget.
// The default 8KB and executable section recovery are covered by context-budget-packet.
const workPacket = (input, options = {}) => workPacketAtBudget(input, { budgetBytes: PACKET_BUDGET, ...options });
const bytes = v => Buffer.byteLength(JSON.stringify(v), 'utf8');
const temp = (t, prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const OWNER_TABLES = 'crie as tabelas propostas no módulo _CS';
const OWNER_ACTIONS = 'crie as actions no mesmo módulo';

// A module digest (ModuleDigest.ToJson shape): entities and actions as the owner's FolhaPonto_CS after the tables, or empty.
function digestOf({ entities = true, actions = true } = {}) {
  const block = (key, kind, name, text) => ({ key, kind, name, text });
  const acts = actions ? [{ key: 'A1', kind: 'ServerAction', name: 'GetColaboradorAtual', section: 'actions', public: true, function: false, in: '', out: 'ColaboradorAtual: Colaborador', calls: [], calledBy: [] }] : [];
  const sections = {
    module: { title: 'module', count: 1, blocks: [block('M', 'ESpace', 'FolhaPonto_CS', 'ssam-digest/1 module=FolhaPonto_CS type=Service lane=o11 key=@M')] },
    entities: { title: 'entities', count: entities ? 1 : 0, blocks: entities ? [block('E1', 'ServerEntity', 'Colaborador', 'entity Colaborador @E1 public\n  Id: Long Integer req auto\n  Nome: Text(200) req')] : [] },
    structures: { title: 'structures', count: 0, blocks: [] },
    variables: { title: 'variables', count: 2, blocks: [block('V1', 'SiteProperty', 'TenantId', 'site property TenantId @V1'), block('V2', 'SiteProperty', 'TenantName', 'site property TenantName @V2')] },
    roles: { title: 'roles', count: 0, blocks: [] }, exceptions: { title: 'exceptions', count: 0, blocks: [] },
    actions: { title: 'actions', count: acts.length, blocks: acts.map(a => block(a.key, a.kind, a.name, 'server action ' + a.name + ' @' + a.key)) },
    timers: { title: 'timers', count: 0, blocks: [] }, integrations: { title: 'integrations', count: 0, blocks: [] }, ui: { title: 'ui', count: 0, blocks: [] },
    coverage: { title: 'coverage', count: 1, blocks: [block('M', 'ESpace', 'coverage', 'elements 1')] },
  };
  return { schema: 'ssam-digest/1', extractor: DIGEST_EXTRACTOR, lane: 'o11', adapter: 'kernel', sourceSha256: 'a'.repeat(64), sourceBytes: 1, createdAt: '2026-10-12T00:00:00Z',
    module: { name: 'FolhaPonto_CS', key: 'M', kind: 'Service' }, elements: 9, notRendered: 0, clipped: 0, readErrors: 0, sections: DIGEST_SECTIONS.map(id => ({ id, ...sections[id] })), actions: acts };
}
const found = options => ({ ok: true, lane: 'o11', target: 'C:\\captures\\FolhaPonto_CS.oml', file: 'C:\\captures\\FolhaPonto_CS.oml', sourceSha256: 'a'.repeat(64), digest: digestOf(options) });
const slice = pointer => ({ 'spec.ddl': '`ddl` (alone) is the module data text', 'logic.flow': 'data.flow: the text of one action', 'html.document': { form: 'data.html <screen>' } })[pointer];

// ---- 1. the text route in the packet
test('the owner\'s words reach their text route: tables are entities without a screen, actions carry their data', () => {
  assert.equal(classifyTextRoute(OWNER_TABLES)?.id, 'data.ddl');
  assert.equal(classifyTextRoute('agora crie as tabelas propostas no moduli _CS')?.id, 'data.ddl', 'the typo of the transcript');
  assert.equal(classifyTextRoute(OWNER_ACTIONS)?.id, 'logic.flow');
  const model = classifyTextRoute('Criar server actions com logic flow aggregate call assign if foreach exception estruturas DTO: ObterColaboradorAtual RegistrarBatida. Autenticacao GetUserId, registro idempotente com lock colaborador, PDF no servidor.');
  assert.equal(model?.id, 'logic.flow', 'rows of data in a request of actions are what the actions do');
  assert.deepEqual(model.also, ['data.ddl'], 'the structures the actions carry');
  // A table of a screen stays the screen's; test records stay no text.
  assert.equal(classifyTextRoute('criar a tela Pedidos com uma tabela dos pedidos do cliente')?.id, 'ui.screen-html');
  assert.equal(classifyTextRoute('remover a coluna Data da tabela da tela Pedidos')?.id, 'ui.screen-html-edit');
  assert.equal(classifyTextRoute('inserir 5 registros de teste na entidade Cliente'), null);
});

// Review odc-defaults-4 (R4-2): the screen grammar of the packet says what an <input> or a block <event> without mandatory is
// (optional, whatever the Studio gives a fresh one) and how a mandatory one is written.
test('packet text, screens: an input or a block event without mandatory is optional, mandatory="True" makes it mandatory', () => {
  for (const lane of ['odc', 'o11']) {
    const s = packetTextSection({ lane, intent: 'criar a tela Pedidos com uma tabela dos pedidos do cliente', found: null, slice });
    const grammar = s.value['ssam-html/1'].grammar;
    assert.ok(grammar.some(g => g.includes('<input name type default/>') && /without mandatory is optional/.test(g) && g.includes('mandatory="True"')), lane);
    assert.ok(grammar.some(g => g.includes('<event name/> in a block') && /without mandatory is optional/.test(g)), lane);
  }
});

test('packet text, the owner\'s tables on the empty module: no read (and why), the exact call, the grammar, the proven example, rules one line each', () => {
  const s = packetTextSection({ lane: 'o11', intent: OWNER_TABLES, found: found({ entities: false, actions: false }), slice });
  const v = s.value;
  assert.equal(v.schema, TEXT_PACKET_SCHEMA); assert.equal(v.id, 'data.ddl'); assert.deepEqual(v.forms, ['ssam-ddl/1']); assert.equal(v.creating, true);
  const ddl = v['ssam-ddl/1'];
  assert.equal(ddl.read, null);
  assert.match(ddl.readWhy, /^FolhaPonto_CS has no entities, static entities or structures: write the text from scratch/, 'the template site properties do not count');
  assert.deepEqual(v.call, { tool: 'o11_deliver', arguments: { module: 'FolhaPonto_CS', job: { ops: [{ op: 'spec', data: { ddl: '<the new statements, without -- @key>' } }] }, authorize: '<the user\'s own words, or none with a standing grant>' } });
  for (const construct of ['create entity', 'create [unique] index', 'create static entity', 'references <Entity> on delete', 'type <Structure>', 'site property'])
    assert.ok(ddl.grammar.some(g => g.includes(construct)), construct);
  assert.equal(ddl.example.text, textExamples().examples['ssam-ddl/1'].o11);
  assert.match(ddl.example.provenBy, /ThePacketExamplesApplyInOneJob/);
  assert.deepEqual(ddl.contract, { pointer: 'spec.ddl', card: '`ddl` (alone) is the module data text' });
  for (const rule of [...ddl.rules, ...v.rules]) { assert.doesNotMatch(rule, /\n/, rule); assert.ok(rule.length <= 200, rule); }
  assert.match(v.use, /ONE job of next\.deliver/);
  // The levels shrink, the call and the example stay.
  const sizes = s.levels.map(bytes);
  assert.ok(sizes.every((n, i) => i === 0 || n <= sizes[i - 1]), sizes.join(' > '));
  for (const level of s.levels) { assert.deepEqual(level.call, v.call); assert.ok(level['ssam-ddl/1'].example); }
});

test('packet text, the owner\'s actions: flow and data forms, exceptions before the texts, no read for new actions; an edit reads its action', () => {
  const s = packetTextSection({ lane: 'o11', intent: OWNER_ACTIONS, found: found(), slice }).value;
  assert.deepEqual(s.forms, ['ssam-ddl/1', 'ssam-flow/1']);
  assert.deepEqual(s.call.arguments.job.ops.map(o => o.op), ['spec', 'create', 'logic'], 'data statements, the user exceptions, the texts');
  assert.equal(s.call.arguments.job.ops[1].type, 'IUserException');
  const flow = s['ssam-flow/1'];
  assert.equal(flow.read, null); assert.match(flow.readWhy, /a creation needs no read/);
  assert.deepEqual(flow.readToChange, { tool: 'ssam_map', arguments: { lane: 'o11', target: 'C:\\captures\\FolhaPonto_CS.oml', view: 'flow', element: '<Action> or a list of them', expectedSourceSha256: 'a'.repeat(64) } });
  for (const construct of ['server action <Name>', 'aggregate FROM', 'if <condition>:', 'foreach <List>:', 'raise <Exception>', 'assign', '<Producer>.<Action>', 'mapTo'])
    assert.ok(flow.grammar.some(g => g.includes(construct)), construct);
  for (const construct of ['JOIN Inner <A>~<B> ON', 'START <s>', 'in <Param>: <Type>', '[abort] [log]', 'ListAppendAll(List=<Dest>, SourceList=<Source> mapTo'])
    assert.ok(flow.grammar.some(g => g.includes(construct)), construct);
  assert.ok(!flow.grammar.some(g => g.includes('JOIN <Other> ON')));
  assert.deepEqual(flow.example.exceptions, ['OrderNotFound']);
  assert.ok(flow.rules.some(r => /QUERY_IN_LOOP/.test(r)) && flow.rules.some(r => /T1\/T2/.test(r)) && flow.rules.some(r => /IUserException/.test(r)));
  // An edit of an action the intent names: the read of that action on the capture, the call with the textSha basedOn.
  const edit = packetTextSection({ lane: 'o11', intent: 'corrigir a action GetColaboradorAtual para devolver o colaborador ativo', found: found(), slice }).value;
  assert.deepEqual(edit.forms, ['ssam-flow/1']); assert.equal(edit.creating, false);
  assert.deepEqual(edit['ssam-flow/1'].read, { tool: 'ssam_map', arguments: { lane: 'o11', target: 'C:\\captures\\FolhaPonto_CS.oml', view: 'flow', element: 'GetColaboradorAtual', expectedSourceSha256: 'a'.repeat(64) } });
  assert.deepEqual(edit.call.arguments.job.ops, [{ op: 'logic', data: { flow: [{ text: '<the text read, edited, with its @ids>', basedOn: '<textSha of the read>' }] } }]);
  // ODC: studio_deliver, the setting of the lane, no public server action in the example.
  const odc = packetTextSection({ lane: 'odc', intent: OWNER_ACTIONS, found: null, slice }).value;
  assert.equal(odc.call.tool, 'studio_deliver');
  assert.match(odc['ssam-ddl/1'].example.text, /\nsetting OrderLimit/);
  assert.doesNotMatch(odc['ssam-flow/1'].example.text, /server action GetOrderSummary public/);
  // No route, no section.
  assert.equal(packetTextSection({ lane: 'o11', intent: 'publicar o módulo', found: found(), slice }), null);
});

// The discover parts a packet reads, synthetic: the JSON matches of the owner's actions (covered by the text) and a timer
// matched only by "action".
function packetInput(intent, { module = found(), text = true } = {}) {
  const match = (id, category, why) => ({ id, category, title: id, via: 'match', score: 8, why, level: 'C-suite', route: { kind: 'job', operation: '{"op":"logic","data":{"actions":[' + 'x'.repeat(600) + ']}}' },
    contract: ['logic.action', 'logic.steps.raise'], guidance: 'g'.repeat(300) });
  return { lane: 'o11', intent, app: module?.target ?? null, basis: { index: 'k'.repeat(24) },
    matches: [match('logic.server-action', 'logic', ['server action']), match('logic.exception', 'logic', ['exception']), match('timer.schedule', 'process', ['action'])],
    unavailable: [], categories: new Map(),
    slices: (pointers, form) => Object.fromEntries((pointers ?? []).map(p => [p, form === 'full' ? { text: 't'.repeat(900) } : ['k']])),
    steps: { kinds: ['raise'], shape: { op: 'logic' }, grammar: { raise: ['raise', 'message'] } },
    proven: { for: 'logic.server-action', job: 'single-job-actions', path: 'tests/jobs/single-job-actions.json', opsTotal: 30, ops: Array.from({ length: 30 }, (_, i) => ({ op: 'set', value: 'v'.repeat(120) + i })) },
    example: null, module, operations: null, text: text ? packetTextSection({ lane: 'o11', intent, found: module, slice }) : null };
}

test('the packet with a text section: in its declared place, the JSON forms it covers by reference, the budget held, the same bytes', () => {
  assert.deepEqual(PACKET_ORDER, ['module', 'text', 'environment', 'capabilities', 'example', 'rules', 'next']);
  for (const budgetBytes of [PACKET_BUDGET, 20000, 12000, 8192]) {
    const p = workPacket(packetInput(OWNER_ACTIONS), { budgetBytes });
    assert.equal(JSON.stringify(p), JSON.stringify(workPacket(packetInput(OWNER_ACTIONS), { budgetBytes })), 'deterministic at ' + budgetBytes);
    assert.ok(bytes(p) <= budgetBytes && p.size.bytes === bytes(p), `${bytes(p)} > ${budgetBytes}`);
    assert.deepEqual(Object.keys(p).filter(k => PACKET_ORDER.includes(k)), PACKET_ORDER);
    if (p.text) assert.deepEqual(p.text.call, packetInput(OWNER_ACTIONS).text.value.call, 'the call is never reduced');
    else assert.ok(p.cuts.some(c => c.section === 'text'), 'a text section left out is named');
  }
  const p = workPacket(packetInput(OWNER_ACTIONS));
  assert.equal(p.text.id, 'logic.flow'); assert.ok(p.text['ssam-flow/1'].contract.card, 'whole at the ceiling');
  // The capabilities the text covers keep one line; the JSON steps grammar goes; the timer named only by "action" goes last, reduced.
  assert.deepEqual(p.capabilities.items.map(i => [i.id, i.inText ?? null]), [['logic.server-action', 'ssam-flow/1'], ['logic.exception', 'ssam-flow/1'], ['timer.schedule', null]]);
  assert.ok(p.capabilities.items[2].expand && !p.capabilities.items[2].contract);
  assert.equal(p.capabilities.steps, undefined);
  assert.equal(p.capabilities.inText.expand.arguments.expand, 'logic.server-action:contract+example,logic.exception:contract+example');
  // The JSON example by reference (no ops), not a cut.
  assert.equal(p.example.ops, undefined); assert.equal(p.example.job, 'single-job-actions'); assert.ok(!p.cuts.some(c => c.section === 'example'));
  assert.deepEqual(p.next.deliver.arguments.job.ops, ['<the ops of text.call, in its order>', '<JSON ops only for what no text form covers>']);
  // Smaller than the same packet without the text route's reductions, by the JSON it no longer carries.
  const without = workPacket(packetInput(OWNER_ACTIONS, { text: false }));
  assert.equal(without.text, null);
  assert.ok(bytes(p.capabilities) + bytes(p.example) < bytes(without.capabilities) + bytes(without.example), 'the JSON forms leave');
  assert.ok(coveredBy(['ssam-flow/1'], 'logic.aggregate') && !coveredBy(['ssam-flow/1'], 'timer.schedule') && coveredBy(['ssam-ddl/1'], 'data.static') && coveredBy(['ssam-html/1'], 'ui.form'));
});

// The owner's captures (FolhaPonto_CS, C:\t\vel\fixtures) over the real o11 index.
const FIXTURES = 'C:\\t\\vel\\fixtures';
const EMPTY = path.join(FIXTURES, 'build-FolhaPonto_CS-20261012031410-a9cdf6ad.oml');
const WITH_TABLES = path.join(FIXTURES, 'build-FolhaPonto_CS-20261012032118-57821bd4.oml');
const ownerSkip = !fs.existsSync(laneSources('o11').cli) ? 'the o11 CLI is not built' : !fs.existsSync(EMPTY) || !fs.existsSync(WITH_TABLES) ? 'the owner\'s captures are not on this machine' : false;
test('the owner\'s two requests on FolhaPonto_CS: the first answer holds the read decision, the exact call, the grammar and the example, within the budget', { skip: ownerSkip, timeout: 900000 }, async () => {
  // Two answers compared byte for byte: the index reads the committed results snapshot, not the stamped results a kernel
  // suite rewrites in this checkout meanwhile (fixtures/discovery-results.mjs).
  const sources = snapshotSources('o11');
  const tables = await discoverAll({ lane: 'o11', intent: OWNER_TABLES, app: EMPTY, packet: true, budgetBytes: PACKET_BUDGET, sources });
  assert.equal(tables.text.id, 'data.ddl');
  assert.equal(tables.text['ssam-ddl/1'].read, null); assert.match(tables.text['ssam-ddl/1'].readWhy, /^FolhaPonto_CS has no entities/);
  assert.equal(tables.text.call.arguments.module, 'FolhaPonto_CS');
  assert.ok(tables.text['ssam-ddl/1'].grammar.length >= 6 && tables.text['ssam-ddl/1'].example.text.includes('create static entity'));
  assert.ok(tables.size.bytes <= PACKET_BUDGET && !tables.cuts.some(c => c.section === 'text'));
  const actions = await discoverAll({ lane: 'o11', intent: OWNER_ACTIONS, app: WITH_TABLES, packet: true, budgetBytes: PACKET_BUDGET, sources });
  assert.equal(actions.text.id, 'logic.flow'); assert.deepEqual(actions.text.forms, ['ssam-ddl/1', 'ssam-flow/1']);
  assert.equal(actions.text['ssam-flow/1'].read, null);
  assert.equal(actions.text['ssam-flow/1'].readToChange.arguments.expectedSourceSha256, actions.module.sourceSha256, 'the read is bound to the capture the packet read');
  assert.ok(actions.module.entities.some(e => e.startsWith('entity Colaborador')), 'the entities the texts reference');
  assert.ok(actions.size.bytes <= PACKET_BUDGET);
  assert.equal(actions.example.ops, undefined, 'no JSON job inline');
  assert.equal(JSON.stringify(actions), JSON.stringify(await discoverAll({ lane: 'o11', intent: OWNER_ACTIONS, app: WITH_TABLES, packet: true, budgetBytes: PACKET_BUDGET, sources })), 'the same bytes');
});

// ---- 2. what the environment offers
const environment = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'environment-components.json'), 'utf8'));
function fakeSources(root, calls = []) {
  return {
    root,
    listProducers: async () => { calls.push('producers'); return { ok: true, rows: environment.producers, host: environment.host }; },
    listElements: async name => { calls.push('list ' + name); return { ok: true, elements: environment.elements[name] ?? [] }; },
    readExtension: async name => { calls.push('xif ' + name); return environment.extensions[name] ? { ok: true, spec: environment.extensions[name] } : { ok: false }; },
    producerDigest: async name => { calls.push('digest ' + name); return environment.digests[name] ? { ok: true, digest: environment.digests[name] } : { ok: false }; },
  };
}

test('the needs an intent names, and a direct question about the environment', () => {
  assert.deepEqual(componentNeeds('gerar o espelho mensal em PDF no servidor'), ['pdf']);
  assert.deepEqual(componentNeeds('exportar a planilha Excel e enviar por e-mail'), ['excel', 'email']);
  assert.deepEqual(componentNeeds('criar as actions de cadastro'), []);
  assert.equal(asksEnvironment('o que tenho no ambiente para gerar PDF?'), true);
  assert.equal(asksEnvironment('which extensions can I use for Excel'), true);
  assert.equal(asksEnvironment('gerar o espelho em PDF'), false, 'a need alone is the packet\'s');
  assert.equal(signatureLine({ name: 'HtmlToPdf', inputs: [{ name: 'Html', type: 'Text' }, { name: 'PageSize', type: 'Text', mandatory: false }], outputs: [{ name: 'Pdf', type: 'Binary Data' }] }),
    'HtmlToPdf(Html: Text, PageSize?: Text) -> (Pdf: Binary Data)');
});

test('one answer: the components for the need with their actions and signatures, the reference op; the second call from the cache, same bytes', async t => {
  const root = temp(t, 'components-');
  const calls = [];
  const first = await environmentComponents({ lane: 'o11', intent: 'gerar o espelho mensal em PDF' }, fakeSources(root, calls));
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.schema, COMPONENTS_SCHEMA);
  assert.equal(first.host, 'fixture.outsystemscloud.com'); assert.equal(first.producers, 14);
  assert.deepEqual(first.components.map(c => [c.name, c.kind, c.matched]), [['HtmlToPdfExt', 'Extension', 'name'], ['PdfTools', 'eSpace', 'name']]);
  const ext = first.components[0];
  assert.deepEqual(ext.actions, ['HtmlToPdf(Html: Text, PageSize?: Text, Landscape?: Boolean) -> (Pdf: Binary Data)', 'UrlToPdf(Url: Text) -> (Pdf: Binary Data)']);
  assert.deepEqual(ext.reference, { op: 'reference', producer: 'HtmlToPdfExt', elements: ['IServerActionSignature:HtmlToPdf', 'IServerActionSignature:UrlToPdf'] });
  assert.deepEqual(first.components[1].actions, ['PdfMerge(Pdfs: BinaryData List) -> (Merged: Binary Data)', 'PrintToPdf(Url: Text; Landscape?: Boolean) -> (PdfFile: Binary Data)'], 'the public actions of the eSpace, from its digest');
  assert.match(first.use, /producers:"published"/); assert.match(first.use, /<Producer>\.<Action>/);
  assert.deepEqual(calls, ['producers', 'xif HtmlToPdfExt', 'digest PdfTools']);
  assert.ok(fs.existsSync(cacheFile(root, 'fixture.outsystemscloud.com')));
  // The same environment again: nothing live, the same bytes.
  const again = []; const cached = await environmentComponents({ lane: 'o11', intent: 'gerar o espelho mensal em PDF', host: 'fixture.outsystemscloud.com' }, { ...fakeSources(root, again), listProducers: null });
  assert.deepEqual(again, []); assert.equal(JSON.stringify(cached), JSON.stringify(first));
  // Without a Studio, from the cache of the last listing.
  assert.equal(JSON.stringify(await environmentComponents({ lane: 'o11', intent: 'gerar o espelho mensal em PDF' }, { root })), JSON.stringify(first));
  // Several needs, the platform's own note, an action match, the producers read live at most maxLive per call.
  const many = await environmentComponents({ lane: 'o11', intent: 'zip dos arquivos, imagem redimensionada e excel', maxLive: 2 }, fakeSources(root, []));
  assert.deepEqual(many.needs, ['excel', 'file', 'zip', 'image']);
  assert.ok(many.platform.some(p => p.need === 'excel' && /Record List To Excel/.test(p.note)));
  assert.ok(many.components.filter(c => c.actions === null).every(c => c.read.tool === 'ssam_discover'), 'the ones not read yet say how');
  // A need nobody covers; another lane; no listing and no cache.
  const none = await environmentComponents({ lane: 'o11', needs: ['sms'], host: 'fixture.outsystemscloud.com' }, { root });
  assert.deepEqual(none.components, []); assert.match(none.none, /no installed extension or Forge component/);
  assert.equal((await environmentComponents({ lane: 'odc', intent: 'pdf' }, { root })).code, 'LANE');
  const fresh = temp(t, 'components-none-');
  const missing = await environmentComponents({ lane: 'o11', intent: 'pdf' }, { root: fresh });
  assert.equal(missing.code, 'NO_LISTING'); assert.equal(missing.continuation.tool, 'ssam_connect');
  // Levels for a byte cap.
  assert.ok(bytes(fitComponents(first, 600)) <= 600 && fitComponents(first, 600).components.every(c => !c.actions));
});

const o11Skip = !fs.existsSync(laneSources('o11').cli) && 'the o11 CLI is not built';
test('ssam_discover: the packet carries the environment of the need; a direct question answers it after intent, within the budget', { skip: o11Skip, timeout: 900000 }, async t => {
  const root = temp(t, 'components-discover-');
  const components = input => environmentComponents(input, fakeSources(root, []));
  const packet = await discoverAll({ lane: 'o11', intent: 'criar a action GerarEspelhoPDF que gera o espelho mensal em PDF', packet: true, budgetBytes: PACKET_BUDGET, components });
  assert.equal(packet.environment.ok, true); assert.deepEqual(packet.environment.needs, ['pdf']);
  assert.equal(packet.environment.components[0].name, 'HtmlToPdfExt');
  assert.ok(packet.size.bytes <= PACKET_BUDGET && bytes(packet) === packet.size.bytes);
  assert.equal(packet.text.id, 'logic.flow');
  const direct = await discoverAll({ lane: 'o11', intent: 'o que tenho no ambiente para gerar PDF?', components });
  const keys = Object.keys(direct);
  assert.equal(keys[keys.indexOf('intent') + 1], 'environment');
  assert.equal(direct.environment.components[0].name, 'HtmlToPdfExt');
  assert.ok(wireBytes(direct, { budgetBytes: 40960 }) <= 40960, String(bytes(direct)));
  if (direct.size?.bytes != null) assert.equal(direct.size.bytes, bytes(direct));
  // Without a need: no environment; the ODC lane: none.
  assert.equal((await discoverAll({ lane: 'o11', intent: 'criar actions de cadastro', packet: true, budgetBytes: PACKET_BUDGET, components })).environment, null);
});

// ---- 3. the pages of a paged answer
// A producer listing as the O11 lane answers it (dependencies producers, 452 rows), synthetic.
function producerListing(n = 452) {
  const b64 = i => Buffer.from('k' + i + 'x'.repeat(14)).toString('base64').slice(0, 22);
  const guid = i => (i.toString(16).padStart(8, '0')) + '-0a2a-66f3-e0e2-a1e6e84a0be0';
  const data = Array.from({ length: n }, (_, i) => ({ Key: b64(i), Name: (i % 7 === 0 ? 'Pdf' : 'Module') + '_' + i, Kind: i % 3 ? 'eSpace' : 'Extension', SignatureHash: guid(i), IsSystem: i < 20, ApplicationKey: b64(i + 1000) }));
  return { ok: true, lane: 'o11', verb: 'dependencies', line: 'dotnet anvil.dll dependencies producers', exitCode: 0, result: { ok: true, command: 'dependencies', elapsedMs: 961, data }, stderr: ['connected through the Studio', n + ' referenceable producers'] };
}

test('a paged listing keeps every row inline and bounded evidence pages recover every omitted column exactly', t => {
  // Preserve the original 452-row fixture: the new global ceiling requires exact
  // evidence pagination for columns that previously fitted the 64KB response.
  const rowCount = 452;
  const full = producerListing(rowCount);
  assert.ok(bytes(full) > 80000);
  const root = temp(t, 'paged-');
  const paged = pageAnswer({ content: [{ type: 'text', text: JSON.stringify(full) }], structuredContent: full }, { root }).structuredContent;
  assert.ok(bytes(paged) <= ANSWER_CEILING_BYTES, String(bytes(paged)));
  assert.equal(paged.ok, true); assert.deepEqual(paged.stderr, full.stderr);
  assert.deepEqual(paged.result, { ok: true, command: 'dependencies', elapsedMs: 961 }, 'the object around the rows, without them');
  const [table] = paged.paged.tables;
  assert.equal(table.at, '/result/data'); assert.deepEqual(table.columns, ['Name', 'Kind', 'IsSystem']); assert.deepEqual(table.omitted, ['Key', 'SignatureHash', 'ApplicationKey']);
  assert.equal(table.rows.length, rowCount, 'every row inline'); assert.deepEqual(table.rows[0], ['Pdf_0', 'Extension', true]);
  assert.equal(paged.paged.complete, false);
  assert.deepEqual(paged.continuation.arguments, { file: paged.paged.file, pointer: '/result/data', table: true, fields: ['Name', 'Key', 'SignatureHash', 'ApplicationKey'], max: rowCount, budgetBytes: EXPANSION_DEFAULT_BYTES });
  // The exact call starts pagination; each next offset advances without loss or duplication.
  const reader = createEvidenceReader({ roots: [path.join(root, '.local')] });
  const recovered = [], offsets = new Set();
  let args = paged.continuation.arguments;
  while (true) {
    const offset = args.offset ?? 0;
    assert.ok(!offsets.has(offset), 'no continuation loop'); offsets.add(offset);
    const rest = reader.read(args);
    assert.equal(rest.ok, true, JSON.stringify(rest).slice(0, 300));
    assert.deepEqual(rest.columns, ['Name', 'Key', 'SignatureHash', 'ApplicationKey']);
    assert.ok(bytes(rest) <= EXPANSION_DEFAULT_BYTES); recovered.push(...rest.rows);
    if (rest.next === undefined) break;
    assert.ok(rest.next > offset && rest.next === recovered.length);
    args = { ...args, offset: rest.next };
  }
  assert.equal(recovered.length, rowCount);
  assert.deepEqual(recovered, full.result.data.map(row => [row.Name, row.Key, row.SignatureHash, row.ApplicationKey]));
  t.diagnostic(`all ${rowCount} rows and four columns recovered in ${offsets.size} bounded evidence pages`);
  // A filtered table names each row's index; a budget too small pages with next.
  const pdf = reader.read({ file: paged.paged.file, pointer: '/result/data', table: true, where: 'Name~Pdf', fields: ['Name', 'Kind'] });
  assert.deepEqual(pdf.columns, ['#', 'Name', 'Kind']); assert.equal(pdf.rows.length, 65); assert.deepEqual(pdf.rows[1], ['7', 'Pdf_7', 'eSpace']);
  const small = reader.read({ file: paged.paged.file, pointer: '/result/data', table: true, budgetBytes: 2000 });
  assert.ok(small.rows.length > 0 && small.next === small.rows.length && bytes(small) <= 2000);
});

test('paged parts: what fits is inline and the shortened note has an exact executable continuation', t => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: 'W' + i, detail: 'detail ' + i + ' ' + 'd'.repeat(60) }));
  const full = { ok: true, warnings: rows, prototype: { score: 0.97, states: Array.from({ length: 120 }, (_, i) => ({ state: "s" + i, score: 0.9 })) }, note: 'n'.repeat(3000) };
  const shape = pagedShape(full, { roomBytes: EXPANSION_DEFAULT_BYTES });
  assert.deepEqual(shape.tables.map(t => t.at), ['/prototype/states', '/warnings'], 'the largest first');
  assert.deepEqual(shape.top.prototype, { score: 0.97 }, 'the part around a table, inline');
  assert.equal(shape.top.note.length, 501);
  assert.deepEqual(shape.missing, [{ at: '/note' }], 'the shortened string remains explicitly recoverable');
  const root = temp(t, 'paged-parts-'), file = path.join(root, 'note.json');
  fs.writeFileSync(file, JSON.stringify(full));
  const recovery = missingCall(file, shape.missing);
  assert.equal(recovery.tool, 'ssam_evidence'); assert.equal(recovery.arguments.pointer, '/note');
  const rest = createEvidenceReader({ roots: [root] }).read(recovery.arguments);
  assert.equal(rest.value, full.note); assert.ok(bytes(rest) <= EXPANSION_DEFAULT_BYTES);
  assert.deepEqual(opaqueColumns([{ a: 'uXCIR2Atc0+es3zYuZSnNw', b: 'Name One' }], ['a', 'b']), ['a']);
});
