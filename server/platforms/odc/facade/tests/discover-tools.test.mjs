// ssam_discover as the single entry of every SSAM request (tool-routing.mjs): the tool router over realistic requests
// (top-1/top-3), silence on model changes, the regression of the model answers against the baseline captured before the
// router existed, the behaviour per intent class, the byte budget and the MCP strings. The index tests need the lane
// CLIs built (as every discover test); nothing here opens a Studio or calls a tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_BUDGETS } from '../answer-size.mjs';
import { wireBytes } from './fixtures/answer-wire.mjs';

test('answer budgets distinguish first discovery from explicit expansion in both lanes; cuts have executable calls', async () => {
  for (const lane of ['o11', 'odc']) for (const extra of [{}, { expand: 'data.entity:contract' }, { detail: 'data.entity' }, { type: 'IEntity' }, { budgetBytes: 12000 }]) {
    let request;
    const answer = await discoverAll({ lane, intent: 'unmatched vocabulary', ...extra }, { discover: async input => {
      request = input;
      return { ok: true, lane, intent: input.intent, size: { bytes: 0, budgetBytes: input.budgetBytes, truncated: [{ section: 'context', recover: 'x'.repeat(100) }] } };
    } });
    assert.equal(request.budgetBytes, extra.budgetBytes ?? (Object.keys(extra).length ? 40960 : ANSWER_BUDGETS.discoverFirst));
    const omitted = answer.size.truncated[0];
    assert.equal(omitted.call.tool, 'ssam_discover');
    assert.equal(omitted.call.arguments.lane, lane);
    assert.equal(omitted.call.arguments.intent, 'unmatched vocabulary');
    assert.ok(omitted.recover.length <= 80);
  }
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { discover } from '../discovery.mjs';
import * as discoveryModule from '../discovery.mjs'; // answerCeiling: at the base the baseline test fails on its rule, not at import
import { discoverAll, routeTools, loadToolRoutes, toolGroups, TOOLS_FILE, modelMatchesOf, withOperationalTitles, lex } from '../tool-routing.mjs';
import { snapshotSources, resultsSnapshot } from './fixtures/discovery-results.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// The lane indexes read the committed snapshot of stamped job results (fixtures/discovery-results.json), never
// kernel/.local/**/test-work: an answer under a byte budget depends on which results exist (proof levels, scoped examples),
// and that folder is empty in a fresh worktree and rewritten by the lane suites while these tests run.
const laneSourcesOf = {}; const laneSources = lane => (laneSourcesOf[lane] ??= snapshotSources(lane));
const fixture = name => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));
const data = loadToolRoutes().data;

test('integration logging inspection routes to the read even with an explicit no-change clause', () => {
  for (const intent of ['consultar o nível de log da integração sem alterar', 'read integration logging level without changing it']) {
    const first=routeTools({lane:'o11',intent}).tools[0];
    assert.equal(first.tool,'o11_service_center_read');assert.equal(first.verb,'integration-detail');
  }
  const write=routeTools({lane:'o11',intent:'mudar o nível de log da integração para Full'}).tools[0];
  assert.equal(write.tool,'o11_service_center_write');assert.equal(write.verb,'integration-log-level');
});
test('historical request and response route to the exact event reader',()=>{
 const first=routeTools({lane:'o11',intent:'ver request e response da chamada de integração'}).tools[0];
 assert.equal(first.tool,'o11_service_center_read');assert.equal(first.verb,'integration-log-detail');
});
test('an invisible Portal prompt has a discoverable foreground recovery',()=>{
 for(const intent of ['trazer a janela de credenciais do portal para frente','focus the Portal credential prompt']){
  const found=routeTools({lane:'odc',intent}).tools;
  assert.ok(found.some(x=>x.tool==='odc_portal_login'&&x.verb==='focus'),JSON.stringify(found));
 }
});
const norm = s => String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').trim();
const label = x => (x.tool ?? 'gap:' + x.gap) + (x.verb ? '.' + x.verb : '') + (x.otherLane ? '*' : '');
const verbOf = (tool, verb) => { const v = data.tools[tool]?.verbs?.[verb]; return v ? { field: v.field, value: v.value } : null; };
const hit = (item, exp) => { if (item.tool !== exp.tool) return false; if (!exp.verb) return true; const v = verbOf(item.tool, item.verb); return !!v && v.field === exp.verb.field && v.value === exp.verb.value; };
// discover() is not byte-stable between calls: elapsedMs changes its digit count, and size.bytes, size.minimalBytes and
// the byte counts quoted in the hint follow it by one byte. The recovery budget is
// also measured from that whole answer, so only its numeric budget is normalized;
// the recovery tool and every other argument still participate in the comparison.
const stable = answer => {
  const value = structuredClone(answer);
  for (const part of value.size?.truncated ?? []) if (part.call?.tool === 'ssam_discover') part.call.arguments.budgetBytes = 0;
  return JSON.parse(JSON.stringify(value, (k, v) => (['elapsedMs', 'bytes', 'minimalBytes'].includes(k) ? undefined : typeof v === 'string' ? v.replace(/\b\d+ bytes\b/g, 'N bytes') : v)));
};

function score(items) {
  let n = 0, top1 = 0, top3 = 0; const misses = []; const loud = []; let capabilities = 0;
  for (const it of items) {
    const tools = routeTools({ intent: it.intent, lane: it.lane }).tools;
    if (it.expect.kind === 'capability') { capabilities++; if (tools.length) loud.push(`${it.lane} "${it.intent}" -> ${tools.map(label).join(', ')}`); continue; }
    n++;
    const accept = [it.expect, ...(it.alsoAccept ?? [])];
    const ok1 = !!tools[0] && accept.some(a => hit(tools[0], a));
    const ok3 = tools.slice(0, 3).some(x => accept.some(a => hit(x, a)));
    if (ok1) top1++; if (ok3) top3++;
    if (!ok1) misses.push(`${ok3 ? 'top3' : 'miss'} ${it.lane} "${it.intent}" -> ${tools.map(label).join(', ') || '-'}`);
  }
  return { n, top1, top3, misses, loud, capabilities };
}

// (b) Realistic requests written from the live tool descriptions before tools.json existed (121 tool, 20 capability).
// Thresholds are what the router reaches (2026-10-03: top-1 121/121, top-3 121/121); the curation pass dropped every
// tools.json intent identical to one of these sentences, so 100% of them are unseen by the data.
test('the eval requests route to the expected tool and verb (top-1 and top-3), model changes stay without tools', t => {
  const { items } = fixture('discover-tool-eval.json');
  const seen = new Set();
  for (const entry of Object.values(data.tools)) for (const src of [entry, ...Object.values(entry.verbs ?? {})]) for (const s of [...(src.intents?.pt ?? []), ...(src.intents?.en ?? [])]) seen.add(norm(s));
  const unseen = items.filter(it => !seen.has(norm(it.intent))).length;
  const r = score(items);
  t.diagnostic(`eval: ${r.n} tool items, top-1 ${(100 * r.top1 / r.n).toFixed(1)}%, top-3 ${(100 * r.top3 / r.n).toFixed(1)}%; ${r.capabilities} capability items, ${r.loud.length} with tools; unseen by tools.json ${unseen}/${items.length}`);
  for (const m of r.misses) t.diagnostic(m);
  assert.ok(unseen / items.length >= 0.3, 'at least 30% of the eval sentences are absent from tools.json');
  assert.ok(r.top1 / r.n >= 0.97, `top-1 ${r.top1}/${r.n}`);
  assert.ok(r.top3 / r.n >= 0.99, `top-3 ${r.top3}/${r.n}`);
  assert.deepEqual(r.loud, [], 'a model change got a tools section');
});

// Two sets written after freezes of the data. Set 1: top-1 35/54 (64.8%) when first measured (Portuguese informal
// imperatives, participles). Set 2, after the general fixes: top-1 38/41 (92.7%), 4/5 model changes silent, measured
// once. Their misses were then fixed with general rules, so both now guard those rules; neither is blind any more.
test('the held-out requests keep routing after the generalization fixes', t => {
  const r = score(fixture('discover-tool-heldout.json').items);
  t.diagnostic(`held-out: ${r.n} tool items, top-1 ${(100 * r.top1 / r.n).toFixed(1)}%, top-3 ${(100 * r.top3 / r.n).toFixed(1)}%`);
  for (const m of r.misses) t.diagnostic(m);
  assert.ok(r.top1 / r.n >= 0.95, `top-1 ${r.top1}/${r.n}`);
  assert.deepEqual(r.loud, []);
});

// (c, pure) Silence guard: no tool route for the model-change intents of the existing discover tests (both lanes), nor
// for unrelated vocabulary that tempts a tool matcher.
test('model-change intents and unrelated vocabulary get no tool route', () => {
  const base = fixture('discover-baseline-before.json');
  const loud = [];
  for (const i of base.intents.filter(x => x.tools === 'none')) for (const lane of Object.keys(i.byLane)) {
    const tools = routeTools({ intent: i.intent, lane }).tools; if (tools.length) loud.push(`${lane} ${i.id}: ${tools.map(label).join(', ')}`);
  }
  for (const intent of ['rodar o servidor local de desenvolvimento', 'abrir a planilha de requisitos do projeto', 'copiar o texto para a área de transferência', 'usar o fuso horario local do usuario',
    'remove the item from the shopping cart', 'rename the uploaded file before storing it', 'check out the shopping cart page', 'renomear uma entidade e ver o que não acompanha', 'criar uma tela no app Vendas',
    // model changes of the catalog oracles (catalog-a-exception, the catalog-a-lexicon HIJACK list) that a log, Portal,
    // user, data, layout or delivery tool once answered
    'raise a user exception in a server action', 'add a sign out link to the menu', 'show the Save button if the user is admin, otherwise hide it', 'mostrar um botão para cada registro da tabela',
    'adicionar um widget de toast no layout da tela', 'log an error when the timer fails', 'mudar a ordem dos pedidos na lista por data de entrega', 'publish an event when the order is created and handle it in a block',
    'add a site property ApiTimeout to the module', 'create an action that resets variables of several types except a few, and call it inside a branch of an existing If',
    // own phrasings of the same shapes
    'lançar uma exceção de negócio dentro da server action', 'criar um tratador de exceção que grava o erro no log', 'add a logout button to the page header', 'exibir os usuários ativos na tela de administração',
    'adicionar um link de sair no menu lateral', 'criar uma service action no módulo de serviços'])
    for (const lane of ['odc', 'o11']) { const tools = routeTools({ intent, lane }).tools; if (tools.length) loud.push(`${lane} "${intent}": ${tools.map(label).join(', ')}`); }
  assert.deepEqual(loud, []);
});

// Requests written by the three verifiers of 2026-10-03 (never by the curator of tools.json): one phrase per tool and
// per verb on its lane, a second phrasing of every miss, an independent pt/en set with typos, short, mixed and
// wrong-lane requests, and model changes. Their misses were fixed with general rules, so the set now guards those rules.
// Thresholds: top-3 >= 97% overall, every probed route reaches the top-3 at least once, no model change gets tools.
test('the verifier requests reach every route (top-3 per route), model changes stay without tools', t => {
  const { items } = fixture('discover-tool-verifier.json');
  const seenIntents = new Set();
  for (const entry of Object.values(data.tools)) for (const src of [entry, ...Object.values(entry.verbs ?? {})]) for (const s of [...(src.intents?.pt ?? []), ...(src.intents?.en ?? [])]) seenIntents.add(norm(s));
  assert.deepEqual(items.filter(it => seenIntents.has(norm(it.intent))).map(it => it.intent), [], 'no verifier sentence is copied into tools.json');
  const r = score(items);
  const perRoute = new Map();
  for (const it of items.filter(x => x.expect.kind === 'tool')) {
    const key = it.expect.tool + (it.expect.verb ? '.' + it.expect.verb.value : '');
    const tools = routeTools({ intent: it.intent, lane: it.lane }).tools;
    const ok = tools.slice(0, 3).some(x => [it.expect, ...(it.alsoAccept ?? [])].some(a => hit(x, a)));
    perRoute.set(key, (perRoute.get(key) ?? false) || ok);
  }
  const unreachable = [...perRoute].filter(([, ok]) => !ok).map(([k]) => k);
  t.diagnostic(`verifiers: ${r.n} tool items, top-1 ${(100 * r.top1 / r.n).toFixed(1)}%, top-3 ${(100 * r.top3 / r.n).toFixed(1)}%; ${perRoute.size} routes probed, ${unreachable.length} unreachable; ${r.capabilities} model items, ${r.loud.length} with tools`);
  for (const m of r.misses) t.diagnostic(m);
  assert.ok(r.top3 / r.n >= 0.97, `top-3 ${r.top3}/${r.n}`);
  assert.deepEqual(unreachable, [], 'routes no verifier phrasing reaches in the top-3');
  assert.deepEqual(r.loud, [], 'a model change got a tools section');
});

// (c, index) The model answers are those captured before the router existed: matches (id:via, in order) identical for
// every intent of the existing discover tests, both lanes, budgets 12000 and 40960; for a model-only intent the whole
// answer is the discover() answer itself.
test('discoverAll keeps the model answers of the baseline (matches identical, model-only answers deep-equal)', async t => {
  const base = fixture('discover-baseline-before.json');
  const diffs = []; let probes = 0; let identical = 0;
  // Warm the lane index first: the first call of a process may report identity.cache 'rebuilt' and the next 'reused'.
  // The baseline was captured with the stamped results of both suites present: the index reads every snapshot result.
  for (const lane of ['odc', 'o11']) {
    const warm = await discover({ lane, intent: 'criar uma entidade', sources: laneSources(lane) });
    const snapshot = fs.readdirSync(resultsSnapshot().dirs[lane]).filter(f => fs.existsSync(path.join(laneSources(lane).jobsDir, f.replace(/\.result\.json$/, '.json'))));
    assert.ok(snapshot.length > 0 && warm.identity.jobs.results === snapshot.length, `${lane}: the index reads the ${snapshot.length} snapshot results (${warm.identity.jobs.results})`);
  }
  let floored = 0; let raisedProbes = 0;
  // The entry as MCP and the CLI call it: its answer ceiling raises a budget below the minimal answer to it (discovery.mjs
  // atEntry, 2026-10-11); the baseline answered 'insufficient' there, with the direct matches by id.
  const ceilingBytes = discoveryModule.answerCeiling?.() ?? null;
  for (const i of base.intents) for (const [lane, byBudget] of Object.entries(i.byLane)) for (const [budget, expected] of Object.entries(byBudget)) {
    probes++;
    const input = { lane, intent: i.intent, budgetBytes: Number(budget), sources: laneSources(lane) };
    const answer = await discoverAll(input);
    const matches = (answer.matches ?? []).map(m => `${m.id}:${m.via}`);
    const raised = answer.inputAdjusted?.find(a => a.path === '/budgetBytes');
    if (raised) {
      // Raised to the minimal answer: the direct matches the insufficient answer listed, in the same order (the dependencies
      // that answer drops come along). A model part that fit the budget but left a section of its request no room even for
      // its note (discovery.mjs atEntry, sections) is the one that budget gave: the matches of the baseline.
      raisedProbes++;
      const direct = matches.filter(m => m.endsWith(':match'));
      const got = expected.every(m => m.endsWith(':match')) ? direct : matches;
      if (raised.rule !== 'raise-to-minimal' || !isDeepStrictEqual(got, expected)) diffs.push(`${lane} ${budget} ${i.id}: raised (${JSON.stringify(raised)}) ${got.join(',')} != ${expected.join(',')}`);
    } else {
      // A screen intent whose model part would leave no room for the OutSystems UI counts is budgeted with that floor less
      // (2026-10-05, C07), and says so (size.reserved): its matches are the model answer at the budget minus the floor. At
      // the entry the same for the floor of every section of the request (size.reserved.sections, 2026-10-11).
      // The same for the text route of a screen, data or logic change (B2 of the plan "Texto do SSAM", text-routes.mjs):
      // its floor is what size.reserved.textRoute says, and the model answer is discover() at the budget minus it.
      const reservedUi = (answer.size?.reserved?.outsystemsUi ?? 0) + (answer.size?.reserved?.sections ?? 0);
      const reservedText = answer.size?.reserved?.textRoute ?? 0;
      const reserved = reservedUi + reservedText;
      const want = reserved ? ((await discover({ ...input, budgetBytes: Number(budget) - reserved, outsystemsUi: !reservedUi, textRoutes: false })).matches ?? []).map(m => `${m.id}:${m.via}`) : expected;
      if (reserved) floored++;
      if (!isDeepStrictEqual(matches, want)) diffs.push(`${lane} ${budget} ${i.id}: ${matches.join(',')} != ${want.join(',')}${reserved ? ` (floor ${reserved})` : ''}`);
    }
    if (i.tools === 'none' && budget === '12000') {
      // With a direct model match, operational capabilities are shown with their operationalTitles title (titles only).
      // discover() at the same entry (its answer ceiling) is the answer itself.
      const raw = await discover({ ...input, ceilingBytes }); const plain = modelMatchesOf(raw).length ? withOperationalTitles(raw) : raw;
      assert.equal('tools' in answer, false, `${lane} ${i.id}: no tools key on a model-only answer`);
      // A raised budget is a measured minimal, and the answer measured holds elapsedMs: its digits move it by a byte.
      const settled = a => stable(raised ? { ...a, inputAdjusted: a.inputAdjusted?.map(x => ({ ...x, to: 0 })), size: { ...a.size, budgetBytes: 0, budgetAdjusted: { ...a.size?.budgetAdjusted, to: 0 } } } : a);
      if (isDeepStrictEqual(settled(answer), settled(plain))) identical++; else diffs.push(`${lane} ${i.id}: answer differs from discover()`);
    }
  }
  t.diagnostic(`${probes} probes compared with the baseline at the entry; ${raisedProbes} raised to the minimal answer; ${identical} model-only answers deep-equal to discover(); ${floored} under the floor of their sections (OutSystems UI, C07)`);
  assert.deepEqual(diffs, []);
});

test('behaviour per intent class: tool only, mixed, other lane, named tool, gap, slots', async () => {
  const odc = { sources: laneSources('odc') }; const o11 = { sources: laneSources('o11') };
  const open = await discoverAll({ lane: 'odc', intent: 'abrir o módulo Pedidos', ...odc });
  assert.equal(open.ok, true);
  assert.deepEqual(Object.keys(open).slice(0, 5), ['ok', 'schemaVersion', 'lane', 'intent', 'tools'], 'tools comes right after intent');
  assert.equal(open.tools[0].tool, 'studio_open');
  assert.deepEqual(open.tools[0].args, { module: 'Pedidos' }); assert.deepEqual(open.tools[0].filled, ['module']);
  assert.deepEqual(open.tools[0].equivalent, { lane: 'o11', tool: 'o11_studio', verb: 'open-module' });
  assert.match(open.hint, /^SSAM operation( \(not a model change\))?: studio_open/);
  const openO11 = (await discoverAll({ lane: 'o11', intent: 'abrir o módulo Pedidos', ...o11 })).tools[0];
  assert.equal(openO11.tool, 'o11_studio'); assert.equal(openO11.verb, 'open-module'); assert.equal(openO11.args.args.name, 'Pedidos');
  const mixed = await discoverAll({ lane: 'o11', intent: 'criar uma entidade Pedido e publicar o módulo', budgetBytes: 12000, ...o11 });
  assert.ok(mixed.matches.some(m => m.id === 'data.entity' && m.via === 'match'), 'the model part is still answered');
  assert.equal(mixed.tools[0].tool, 'o11_publish');
  assert.match(mixed.hint, /^Model change: matches .*For the step that is an SSAM operation: o11_publish/);
  assert.doesNotMatch(mixed.hint, /not a model change|Two parts/);
  const timer = await discoverAll({ lane: 'o11', intent: 'rodar o timer agora no service center', budgetBytes: 12000, ...o11 });
  assert.equal(label(timer.tools[0]), 'o11_service_center_write.timer-run');
  assert.equal(timer.tools[0].args.execute, false, 'a Service Center write is prepared first');
  assert.match(timer.hint, /matches lists capabilities the same words touched/);
  const other = (await discoverAll({ lane: 'odc', intent: 'ler os logs de erro do service center', ...odc })).tools[0];
  assert.equal(other.tool, 'o11_service_center_read'); assert.equal(other.otherLane, true); assert.match(other.note, /lane o11.*lane odc/);
  const named = routeTools({ intent: 'como usar o11_environment create-app', lane: 'odc' }).tools[0];
  assert.equal(label(named), 'o11_environment.create-app*');
  const gap = routeTools({ intent: 'disparar o timer do app agora', lane: 'odc' }).tools[0];
  assert.equal(gap.gap, 'odc-timer-run');
  const both = routeTools({ intent: 'debugar a action CalcularPremio', lane: 'o11' }).tools[0];
  assert.equal(both.args.lane, 'o11', 'a tool of both lanes gets the asked lane in its template');
  const model = await discoverAll({ lane: 'odc', intent: 'criar uma entidade Order com atributo Data', budgetBytes: 12000, ...odc });
  assert.equal('tools' in model, false);
});

// General rules of the matcher, each on a request of its own (none of these sentences is in tools.json or a fixture).
test('general rules: clauses, names after nouns, typos, solo words, model guard, lane fallback', () => {
  const labels = (lane, intent) => routeTools({ intent, lane }).tools.map(label);
  // clauses: each step keeps its tool although another step's words veto it on the whole request
  const steps = labels('o11', 'criar a entidade Produto, publicar e popular 5 registros de teste');
  // o11_publish has its presence verbs since 2026-10-05 (publish, consumers): the plain publish is o11_publish.publish
  assert.ok(steps.includes('o11_publish.publish') && steps.includes('o11_data.insert'), steps.join(', '));
  // a name after a noun is not a word of the request: "app Status" neither vetoes a deploy nor asks a status
  assert.equal(labels('odc', 'enviar o app Status para QA')[0], 'odc_deploy.Deploy');
  // one typo per word against the routing vocabulary (swap, deletion)
  assert.equal(labels('odc', 'pubilcar o modulo')[0], 'studio_publish');
  assert.equal(labels('o11', 'abrir o mdulo Vendas')[0], 'o11_studio.open-module');
  // a request of one bare word
  assert.equal(labels('odc', 'status')[0], 'studio_status');
  assert.equal(labels('o11', 'dados')[0], 'o11_data.read');
  // model guard: a model element with a build verb, a UI widget or a condition is a model change
  for (const [lane, intent] of [['odc', 'adicionar um botão de logout no menu'], ['o11', 'lançar uma exceção quando o timer falhar'], ['odc', 'criar uma action que grava o erro no log do portal']])
    assert.deepEqual(labels(lane, intent), [], `${lane} ${intent}`);
  // lane fallback: never to the other lane's tool of a group the asked lane has; still for a group it lacks
  assert.ok(!labels('odc', 'fechar a janela do portal').some(x => x.endsWith('*')));
  assert.equal(labels('o11', 'listar os tenants')[0], 'hybrid_tenants*');
});

// Rules of the 2026-10-04 pass, each on a sentence of its own (in no fixture and no tools.json intent): vocabulary by
// concept, one-digit ids, named elements, the object of a verb, readers, events, destructive guard, the lane equivalent
// and argument values chosen by the request.
test('concept rules: vocabulary, ids, named elements, verb objects, readers, events, destructive guard', () => {
  const labels = (lane, intent) => routeTools({ intent, lane }).tools.map(label);
  assert.equal(labels('odc', 'mostrar os estágios disponíveis')[0], 'odc_read.portfolio-api-v2:get:/environments');
  assert.equal(labels('odc', 'carregue o módulo Financeiro')[0], 'studio_open');
  assert.equal(labels('odc', 'o studio está ocupado?')[0], 'studio_status');
  assert.equal(labels('o11', 'sair do service center')[0], 'o11_service_center_session.close');
  assert.equal(labels('odc', 'criar a conexão de banco Oracle chamada ERP')[0], 'odc_external_db_connection.create');
  assert.equal(labels('odc', 'remover o registro 5 da entidade Produto')[0], 'studio_data_delete', 'an id of one digit');
  assert.equal(labels('o11', 'ver o processo BPT Faturar')[0], 'o11_service_center_read.bpt-process', 'a named process is one process');
  assert.equal(labels('o11', 'criar a aplicação Estoque com um módulo Reactive')[0], 'o11_environment.create-app', 'the verb creates the app, not a module');
  // model changes: a destructive verb on a model element, an event, a reader with a change verb
  for (const [lane, intent] of [['o11', 'excluir o bloco Menu do módulo'], ['odc', 'excluir o bloco Menu do módulo'], ['odc', 'ao salvar o cliente, inserir um registro na entidade Historico'],
    ['odc', 'mudar o layout da página de cadastro'], ['o11', 'criar um timer que apaga os logs de ontem']])
    assert.deepEqual(labels(lane, intent), [], `${lane} ${intent}`);
  // a value of the arguments chosen by the request
  assert.equal(routeTools({ intent: 'logar no LifeTime', lane: 'o11' }).tools[0].args.surface, 'lifetime');
  // "pode criar" with an app or library noun keeps the tool that creates it (studio_authorize create records the words
  // for studio_create of a ready manifest, never a new app by itself); with an entity it routes to no tool
  for (const intent of ['pode criar o app Escala Viva', 'pode criar a biblioteca Utils', 'you may create the app Sales'])
    assert.ok(labels('odc', intent).includes('studio_create_app.create'), `${intent}: ${labels('odc', intent).join(', ')}`);
  assert.ok(!labels('odc', 'pode criar a entidade Produto').includes('studio_authorize.create'));
});

// The Service Center delete of the 2026-10-05 integrations package (contract lane scdelete): a bulk or prefix delete is
// the one-call delete, never a prepare first; one module or extension keeps its alias, the same call.
test('Service Center deletes route to the one-call delete, without execute in the template', () => {
  const top = (lane, intent) => routeTools({ intent, lane }).tools[0];
  const bulk = top('o11', 'apagar todas as apps que começam com ZZ');
  assert.equal(label(bulk), 'o11_service_center_write.delete');
  assert.deepEqual(Object.keys(bulk.args).sort(), ['action', 'applications', 'host', 'words']);
  assert.equal('execute' in bulk.args, false, 'a delete is never prepared first');
  assert.match(bulk.next, /one call/);
  assert.equal(label(top('o11', 'excluir a extensão UtilExt')), 'o11_service_center_write.extension-delete');
  assert.equal(label(top('o11', 'apagar o módulo Antigo do ambiente')), 'o11_service_center_write.module-delete');
  for (const verb of ['module-delete', 'extension-delete', 'application-delete', 'delete'])
    assert.equal('execute' in data.tools.o11_service_center_write.verbs[verb].args, false, verb);
  assert.doesNotMatch(data.tools.o11_environment.verbs['delete-app'].when, /ZZ/);
});

test('the hint leads with the model change only for a model change, and never hides discover() guidance', async () => {
  const odc = { sources: laneSources('odc') }; const o11 = { sources: laneSources('o11') };
  for (const [lane, intent, src] of [['odc', 'debugar a action CalcularFrete com um breakpoint', odc], ['o11', 'inserir dois registros na tabela Produto do O11', o11], ['odc', 'ver os logs de erro do app no portal', odc]]) {
    const a = await discoverAll({ lane, intent, budgetBytes: 12000, ...src });
    assert.ok(a.tools?.length, `${lane} ${intent}: tools`);
    assert.doesNotMatch(a.hint, /Model change: matches/, `${lane} ${intent}: an operation is not a model change`);
  }
  // mixed: the model part is discover()'s own at the same budget (never asked again nor cut), its hint is kept; only
  // metadata sections may be left out for the tools, each named in size.truncated
  for (const budgetBytes of [12000, 40960]) {
    const input = { lane: 'o11', intent: 'criar uma entidade Pedido e publicar o módulo', budgetBytes, ...o11 };
    const a = await discoverAll(input); const plain = await discover(input);
    const leftOut = new Set((a.size?.truncated ?? []).filter(x => /^left out for the tools/.test(x.recover)).map(x => x.section));
    for (const s of leftOut) assert.ok(['evidenceRule', 'lexical', 'coverage', 'identity', 'composition', 'terms'].includes(s), `${s} is metadata`);
    // The proven example, the step grammar and the values (2026-10-05, C07) come back after the tools in the room left,
    // like the OutSystems UI section: not part of the model part. The text route of the model step (B2 of the plan "Texto
    // do SSAM") too, first among them.
    const model = x => { const y = stable(x); delete y.tools; delete y.hint; delete y.size; for (const s of [...leftOut, 'provenExample', 'steps', 'values', 'textRoute']) delete y[s]; return y; };
    assert.deepEqual(model(a), model(plain), `${budgetBytes}: the model part is discover()'s`);
    assert.match(a.hint, plain.hint ? /\| Model change: matches/ : /^Model change: matches/);
    if (plain.hint) assert.ok(a.hint.startsWith(plain.hint));
  }
});

// The model rule (applyModelRule), as an invariant. Model changes: every request a verifier found answered by an
// operational tool (recheck/v4 verdicts of 2026-10-03: a write, a "not a model change" or a "Two parts" hint) plus own
// phrasings; for each, the answer offers no route whose effect is 'write' (only 'read' and 'delivery'), its hint never
// says it is not a model change nor "Two parts", and its model part is discover()'s own (never asked again nor cut).
// Operations: writes of every kind keep their tool in the top 3, and a step with no model match keeps its tool.
test('the model rule: a model step gets no write tool and no "not a model change" claim; operations keep their tools', async t => {
  const effectOf = x => { if (x.gap) return 'gap'; const e = data.tools[x.tool]; return (x.verb && e.verbs?.[x.verb]?.effect) || e.effect; };
  const MODEL = [
    ['odc', 'criar um endpoint REST que lista os usuários'], ['odc', 'in the Save action, update the customer record'], ['odc', 'na ação SalvarCliente, atualizar o registro do cliente'],
    ['odc', 'add logic to delete the record with id 3'], ['odc', 'create a REST method that returns the deployment status'], ['odc', 'create a REST API method that returns the publish status of an order'],
    ['odc', 'criar um método REST que retorna o status da publicação'], ['o11', 'criar uma ação que retorna os consumidores do módulo'], ['o11', 'apagar a tela antiga ListaClientes do módulo'],
    ['odc', 'mostrar os logs de auditoria numa tela do backoffice'], ['o11', 'mostrar os logs de auditoria numa tela do backoffice'], ['odc', 'chamar a action de deploy do módulo de integração dentro do fluxo de aprovação'],
    ['o11', 'chamar a action de deploy do módulo de integração dentro do fluxo de aprovação'], ['o11', 'adicionar uma referência à action FormatarCPF do produtor CoreLib'], ['odc', 'mostrar a lista de usuários numa tela de admin'],
    ['o11', 'mostrar o histórico de versões numa tela do backoffice'], ['odc', 'mostrar os traces lentos num gráfico da tela Dashboard'], ['o11', 'exibir as site properties numa tela de configuração do app'],
    ['o11', 'existe receita para criar uma tela de cadastro?'], ['odc', 'registrar no log quando a integração de pagamento falhar'], ['odc', 'take a snapshot of Sales then add an Export button to the Orders screen'],
    // own phrasings of the same shapes (in no fixture and no tools.json intent)
    ['odc', 'expor um endpoint que publica o pedido aprovado'], ['o11', 'na action GravarPedido, apagar o registro antigo do log'], ['odc', 'when the timer runs, insert a row in the Audit entity'],
    ['o11', 'criar uma tela que lista os módulos do ambiente'], ['odc', 'add a Deploy button to the Releases screen'],
    // answers whose matches carried the data.records catalog title "(not a model change)" (safety check of a456ada4)
    ['odc', 'na ação SalvarPedido, atualizar o registro do pedido com o novo status'], ['o11', 'If the user is not admin, hide the Delete button'],
    // a request placed inside the app is one change: its "and" does not make an operation step (safety check of f450269b)
    ['odc', 'na action ValidarPedido, conferir o total e atualizar o registro do pedido'], ['o11', 'in the Approve action, check the amount and insert a record in the Audit entity'],
    ['odc', 'dentro do fluxo de aprovação, validar o cliente e apagar o registro antigo'], ['o11', 'na ação GravarCliente, normalizar o CPF e inserir o registro na entidade Cliente'],
  ];
  // One verdict per step: an answer that leads with the model change and offers a tool that writes offers it as the tool
  // of another step (no model match), never as a reading of the model step.
  const contradicts = a => /Model change: matches/.test(a.hint ?? '') && !!a.tools?.length && !['read', 'delivery', 'gap'].includes(effectOf(a.tools[0])) && !/For the step that is an SSAM operation/.test(a.hint);
  const leaks = []; let withTools = 0;
  for (const [lane, intent] of MODEL) {
    const input = { lane, intent, budgetBytes: 12000, sources: laneSources(lane) };
    const a = await discoverAll(input);
    const writes = (a.tools ?? []).filter(x => !['read', 'delivery'].includes(effectOf(x)));
    if (writes.length) leaks.push(`${lane} "${intent}": ${writes.map(label).join(', ')}`);
    if (/not a model change|Two parts/i.test(a.hint ?? '')) leaks.push(`${lane} "${intent}": hint "${a.hint.slice(0, 90)}"`);
    else if (/not a model change/i.test(JSON.stringify(a))) leaks.push(`${lane} "${intent}": the answer says "not a model change"`);
    if (a.tools?.length) {
      withTools++;
      // A budget below the minimal answer is raised at the entry (raise-to-minimal, f53ba1f2) and the answer declares it
      // in inputAdjusted: the model part is discover()'s own at that declared budget, never the 'insufficient' answer of
      // the budget the caller gave (12000 drops the deliver.job dependency of "create a REST API method ...").
      const raised = (a.inputAdjusted ?? []).find(x => x.path === '/budgetBytes');
      if (raised) assert.ok(raised.from === input.budgetBytes && raised.rule === 'raise-to-minimal' && raised.to > input.budgetBytes, `${lane} "${intent}": ${JSON.stringify(raised)}`);
      const plain = await discover({ ...input, budgetBytes: raised?.to ?? input.budgetBytes });
      assert.deepEqual((a.matches ?? []).map(m => m.id + ':' + m.via), (plain.matches ?? []).map(m => m.id + ':' + m.via), `${lane} "${intent}": the model part is discover()'s`);
      assert.ok(!(a.size?.truncated ?? []).some(x => x.section === 'model'), `${lane} "${intent}": the model part is never cut`);
    }
  }
  t.diagnostic(`model changes: ${MODEL.length}, with read-only tools ${withTools}, leaks ${leaks.length}`);
  assert.deepEqual(leaks, [], 'a model step got a write tool or a "not a model change" claim');
  const OPS = [
    ['o11', 'publicar o módulo Vendas', 'o11_publish.publish'], ['odc', 'publicar o módulo Vendas', 'studio_publish'], ['o11', 'executar agora o timer LimparCache', 'o11_service_center_write.timer-run'],
    ['o11', 'rodar o timer agora no service center', 'o11_service_center_write.timer-run'], ['o11', 'inserir um registro na entidade Cliente do O11', 'o11_data.insert'],
    ['odc', 'inserir 3 clientes de teste na entidade Cliente', 'studio_data_insert'], ['odc', 'insert two rows into the Country table', 'studio_data_insert'], ['odc', 'apagar o registro 3 de Cliente', 'studio_data_delete'],
    ['odc', 'implantar o app Pedidos no estágio QA', 'odc_deploy.Deploy'], ['odc', 'fazer deploy do app para QA', 'odc_deploy.Deploy'], ['odc', 'undeploy the app Orders from QA', 'odc_deploy.Undeploy'],
    ['o11', 'apagar o módulo Antigo do ambiente', 'o11_service_center_write.module-delete'], ['o11', 'delete the module LegacyUtils', 'o11_service_center_write.module-delete'],
    ['o11', 'excluir os registros 3 e 4 de Log', 'o11_data.delete'], ['o11', 'set the site property Timeout to 30 in Service Center', 'o11_service_center_write.property-set'],
    ['odc', 'criar uma aplicação nova chamada Estoque', 'studio_create_app.create'], ['odc', 'criar uma biblioteca nova chamada Utils', 'studio_create_app.create'],
    ['odc', 'listar os templates de app do ODC', 'studio_create_app.templates'], ['odc', 'subir um candidato pronto como asset novo', 'studio_create'], ['o11', 'criar o app Viagem', 'o11_environment.create-app'], ['odc', 'excluir a conexão de banco ERP', 'odc_external_db_connection.delete'],
    // a step with no model match keeps its tool beside the model step
    ['o11', 'criar a entidade Cliente e depois publicar o módulo', 'o11_publish.publish'], ['o11', 'criar a entidade Produto, publicar e popular 5 registros de teste', 'o11_publish.publish'],
    ['o11', 'criar a entidade Produto, publicar e popular 5 registros de teste', 'o11_data.insert'], ['odc', 'open the module Sales and add a button Export to the screen Orders', 'studio_open'],
    // two readings of one step (insert and update of "via Edit Data") share one verdict (safety check of a456ada4)
    ['odc', 'insert three rows into the Product entity data via Edit Data', 'studio_data_insert'], ['o11', 'inserir registros na entidade Cliente via Edit Data', 'o11_data.insert'],
    ['o11', 'apagar os registros da entidade Log via Edit Data', 'o11_data.delete'], ['odc', 'acrescentar duas linhas na tabela Pedido pelo Edit Data', 'studio_data_insert'],
  ];
  const lost = [];
  for (const [lane, intent, want] of OPS) {
    const a = await discoverAll({ lane, intent, budgetBytes: 12000, sources: laneSources(lane) });
    const top = (a.tools ?? []).slice(0, 3).map(x => (x.tool ?? 'gap:' + x.gap) + (x.verb ? '.' + x.verb : ''));
    if (!top.includes(want)) lost.push(`${lane} "${intent}": want ${want}, got ${top.join(', ') || '-'}`);
    if (contradicts(a)) lost.push(`${lane} "${intent}": the hint leads with the model change and offers ${label(a.tools[0])} as a reading of it`);
  }
  assert.deepEqual(lost, [], 'an operation lost its tool or got a self-contradicting hint');
});

// Natural pt-BR debugger requests (fixtures/discover-tool-debug-ptbr.json): the ones the debugger check of 2026-10-04
// found unrouted or misrouted, other phrasings of every debugger verb, neighbours that keep their own tool and model
// changes that stay away from the debugger. Through discoverAll (the model rule included), top-1 for every tool item;
// none of these sentences is copied into tools.json.
test('natural pt-BR debugger requests reach their verb through discoverAll (model rule included)', async t => {
  const { items } = fixture('discover-tool-debug-ptbr.json');
  const seenIntents = new Set();
  for (const entry of Object.values(data.tools)) for (const src of [entry, ...Object.values(entry.verbs ?? {})]) for (const s of [...(src.intents?.pt ?? []), ...(src.intents?.en ?? [])]) seenIntents.add(norm(s));
  assert.deepEqual(items.filter(it => seenIntents.has(norm(it.intent))).map(it => it.intent), [], 'no debugger request of the fixture is copied into tools.json');
  const misses = [];
  for (const it of items) {
    const a = await discoverAll({ lane: it.lane, intent: it.intent, budgetBytes: 12000, sources: laneSources(it.lane) });
    const tools = a.tools ?? [];
    const ok = it.expect.kind === 'tool' ? !!tools[0] && hit(tools[0], it.expect)
      : it.expect.kind === 'none' ? tools.length === 0
        : !tools.some(x => String(x.tool ?? '').startsWith(it.expect.tool));
    if (!ok) misses.push(`${it.lane} "${it.intent}" (${it.set}): want ${it.expect.kind} ${it.expect.tool ?? ''}${it.expect.verb ? '.' + it.expect.verb.value : ''}, got ${tools.map(label).join(', ') || '-'}`);
  }
  t.diagnostic(`debugger pt-BR: ${items.length} requests, ${items.length - misses.length} as expected`);
  assert.deepEqual(misses, []);
});

test('debugger routes promise only what exists, and the flow node is read before its accent goes', () => {
  // Both lanes run through native-entry (the code resolves the nearest public entry; nothing published), with scenarios;
  // the O11 text says what runs and that the live run is still pending; neither offers the legacy wrapper fields.
  const o11 = routeTools({ intent: 'depurar a action ValidarPedido com os inputs escolhidos', lane: 'o11' }).tools[0];
  assert.equal(label(o11), 'ssam_debug_run.run');
  assert.equal(o11.args.lane, 'o11'); assert.equal(o11.args.execution, 'native-entry'); assert.ok(Array.isArray(o11.args.scenarios));
  assert.equal(o11.args.trace, 'none'); for (const legacy of ['keep', 'words', 'nativeEntry', 'idleMinutes']) assert.equal(legacy in o11.args, false);
  assert.match(o11.when, /original stub, data action or client action/); assert.match(o11.when, /live run pending/);
  const odc = routeTools({ intent: 'depurar a action ValidarPedido com os inputs escolhidos', lane: 'odc' }).tools[0];
  assert.equal(label(odc), 'ssam_debug_run.run'); assert.equal(odc.args.lane, 'odc'); assert.equal(odc.args.execution, 'native-entry');
  assert.ok(Array.isArray(odc.args.scenarios)); for (const legacy of ['keep', 'words', 'idleMinutes']) assert.equal(legacy in odc.args, false);
  assert.doesNotMatch(odc.when, /O11/); assert.match(odc.when, /original entry the code resolved/);
  // the entry is the code's decision: the route says so and its override is verified
  const how = routeTools({ intent: 'qual entrada pública chega na action CalcularFrete', lane: 'odc' }).tools[0];
  assert.equal(label(how), 'ssam_debug_run.native-entry'); assert.match(how.when, /never the model/); assert.match(how.when, /verified override/);
  // O11 native SSO goes through the connected Service Studio: the debugger never claims it needs no Studio
  assert.doesNotMatch(data.tools.ssam_debug.when, /no Studio is needed|or touched/);
  assert.match(data.tools.ssam_debug.when, /O11 native SSO: the connected Service Studio/);
  // every debugger text an answer shows is shown whole (the full level cuts when at 160 characters)
  for (const tool of ['ssam_debug', 'ssam_debug_run', 'ssam_debug_invoke']) for (const src of [data.tools[tool], ...Object.values(data.tools[tool].verbs ?? {})])
    for (const when of [src.when, ...Object.values(src.byLane ?? {}).map(o => o.when)].filter(Boolean)) assert.ok(when.length <= 160, `${tool}: "${when.slice(0, 40)}..." fits 160 characters`);
  // "nó" is the flow node, "no" (in the) and the pronoun "nós" are not
  const toks = s => lex(s).toks.map(x => x.t);
  assert.deepEqual(toks('ver as variáveis do nó'), ['ver', 'variavel', 'node']);
  assert.ok(toks('acompanhar os nós da action').includes('node'));
  assert.ok(!toks('nós precisamos publicar no módulo').includes('node'));
});

test('catalog:true lists every tool of the lane by group, with the model catalog and without the index identity', async () => {
  const answer = await discoverAll({ lane: 'o11', intent: '', catalog: true, sources: laneSources('o11') });
  assert.equal(answer.ok, true); assert.equal(answer.catalog, true);
  assert.ok(answer.categories?.length && answer.capabilities?.length, 'the model catalog is still listed');
  const listed = answer.toolGroups.flatMap(g => g.tools.map(x => x.tool));
  assert.ok(listed.includes('o11_studio') && listed.includes('ssam_discover') && !listed.includes('studio_open'));
  assert.ok(answer.toolGroups.find(g => g.tools.some(x => x.tool === 'o11_studio')).tools.find(x => x.tool === 'o11_studio').verbs.includes('open-module'));
  const { otherLaneTools } = toolGroups('o11');
  assert.equal(answer.otherLaneTools, otherLaneTools);
  assert.equal(answer.identity, undefined, 'the index identity is the expand answers\' business');
  assert.match(answer.next, /with an intent/);
});

// 2026-10-12 (production test): a call that only lacked its intent got the whole catalog, 11.6 KB, as an error. Now it
// answers with the exact shape of the call, under 1 KB, without reading the index; the app it named stays in the
// continuation, and the catalog is one named call away.
test('an empty intent answers the exact shape of the call in under 1 KB, without the index', async () => {
  let ran = 0;
  const counting = async () => { ran++; return { ok: true }; };
  for (const lane of ['o11', 'odc']) {
    const answer = await discoverAll({ lane, intent: '', app: 'Vendas_CS', packet: true }, { discover: counting });
    assert.equal(answer.ok, false); assert.equal(answer.code, 'INTENT_REQUIRED'); assert.equal(answer.lane, lane);
    assert.ok(Buffer.byteLength(JSON.stringify(answer), 'utf8') < 1024, String(Buffer.byteLength(JSON.stringify(answer), 'utf8')));
    assert.equal(answer.shape.intent, '<what to do, in words>');
    assert.deepEqual(answer.continuation.arguments, { lane, intent: '<what to do, in words>', app: 'Vendas_CS', packet: true });
    assert.deepEqual(answer.catalog.arguments, { lane, catalog: true });
  }
  const bare = await discoverAll({ lane: 'o11', intent: '   ' }, { discover: counting });
  assert.deepEqual(bare.continuation.arguments, { lane: 'o11', intent: '<what to do, in words>' });
  assert.equal(ran, 0, 'nothing was read for a call without intent');
  // expand without intent still answers its expansions (the discover runs).
  await discoverAll({ lane: 'o11', intent: '', expand: 'logic.flow:contract' }, { discover: counting });
  assert.equal(ran, 1);
});

test('the MCP answer of an empty intent stays under 1 KB on the wire text', async () => {
  const { createFacadeServer } = await import('../mcp.mjs');
  const server = await createFacadeServer();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'discover-tools-empty', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const reply = await client.callTool({ name: 'ssam_discover', arguments: { lane: 'o11', app: 'FolhaPonto_CS' } });
    assert.equal(reply.isError, true);
    const text = reply.content[0].text;
    assert.ok(Buffer.byteLength(text, 'utf8') < 1024, String(Buffer.byteLength(text, 'utf8')));
    assert.equal(JSON.parse(text).code, 'INTENT_REQUIRED');
    const tool = (await client.listTools()).tools.find(t => t.name === 'ssam_discover');
    assert.equal(tool.inputSchema.properties.catalog.type, 'boolean');
  } finally { await client.close(); await server.close(); }
});

test('the index or the tool data failing does not break the other half', async () => {
  const broken = async () => { throw new Error('lane CLI not built'); };
  const fallback = await discoverAll({ lane: 'odc', intent: 'abrir o módulo Pedidos' }, { discover: broken });
  assert.equal(fallback.ok, true); assert.equal(fallback.indexError, 'lane CLI not built'); assert.equal(fallback.tools[0].tool, 'studio_open');
  await assert.rejects(discoverAll({ lane: 'odc', intent: 'criar uma entidade Pedido' }, { discover: broken }), /lane CLI not built/);
  const plain = async () => ({ ok: true, schemaVersion: 'ssam-discovery/4', lane: 'odc', intent: 'x', matches: [] });
  const missing = await discoverAll({ lane: 'odc', intent: 'abrir o módulo Pedidos' }, { discover: plain, file: path.join(os.tmpdir(), 'no-such-tools.json') });
  assert.match(missing.toolsError, /tools\.json unavailable/); assert.equal('tools' in missing, false);
  assert.equal(TOOLS_FILE.endsWith(path.join('catalog', 'tools.json')), true);
});

test('tools fit the byte budget around the model part (4096, 12000, 40960)', async () => {
  for (const [lane, intent] of [['odc', 'abrir o módulo Pedidos'], ['o11', 'criar uma entidade Pedido e publicar o módulo'], ['odc', 'criar uma entidade Pedido e publicar o módulo'], ['o11', 'rodar o timer agora no service center'], ['odc', 'fazer deploy do app para QA']])
    for (const budgetBytes of [4096, 12000, 40960]) {
      const a = await discoverAll({ lane, intent, budgetBytes, sources: laneSources(lane) });
      assert.ok(a.tools?.length, `${lane} ${budgetBytes} ${intent}: tools present`);
      // A model part kept beside the tools (a mixed request) below its minimal answer is raised to it, with the room of
      // the tools, under the answer ceiling, and the answer says so (discovery.mjs atEntry, 2026-10-11).
      const raised = a.inputAdjusted?.find(x => x.path === '/budgetBytes');
      if (raised) assert.ok(raised.from === budgetBytes && raised.rule === 'raise-to-minimal' && raised.to > budgetBytes && raised.to <= 38912, JSON.stringify(raised));
      const B = raised?.to ?? budgetBytes;
      assert.equal(a.size.budgetBytes, B);
      assert.ok(wireBytes(a) <= B, `${lane} ${budgetBytes} ${intent}: within budget`);
      assert.equal(a.size.bytes, Buffer.byteLength(JSON.stringify(a), 'utf8'), 'size.bytes measures the returned answer');
    }
});

test('the MCP surface tells every session to start each request with ssam_discover (no tool call)', async () => {
  const { createSsamServer } = await import('../ssam.mjs');
  const { createFacadeServer } = await import('../mcp.mjs');
  for (const make of [() => createSsamServer(), () => createFacadeServer()]) {
    const server = await make();
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'discover-tools-test', version: '1.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      assert.match(client.getInstructions(), /Every SSAM request starts with ssam_discover \{intent, lane\}/);
      assert.match(client.getInstructions(), /To read an application, start with ssam_map \{lane, target, view:"digest"\}/);
      const tool = (await client.listTools()).tools.find(t => t.name === 'ssam_discover');
      assert.match(tool.description, /^Start EVERY SSAM request here, model change or not\./);
      assert.match(tool.description, /`tools`.*exact MCP tool, its verb/);
      assert.doesNotMatch(tool.description, /^\[odc\]/);
    } finally { await client.close(); await server.close(); }
  }
});

test('library release through the Portal is routed (live demo 2026-10-14: "SSAM has no such function")', () => {
  for (const intent of ['release library', 'liberar biblioteca', 'release da lib', 'versionar library', 'liberar a biblioteca LibX versão 1.0.0 no portal']) {
    const first = routeTools({ lane: 'odc', intent }).tools[0];
    assert.equal(first?.tool, 'odc_portal_write', intent);
    assert.equal(first.args.operationId, 'libraries.release', intent);
    assert.deepEqual(Object.keys(first.args.input.inputParameters), ['ApplicationKey', 'Revision', 'Version', 'ReleaseNotes']);
  }
});
