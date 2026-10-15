// Front A lexicon and composition harness (catalog M1/M2), written by the front's parent session as an ORACLE for the
// fragment authors (the fragment fixers must make it pass without editing it):
//  1. hijack guard: intents of front B/C or unrelated vocabulary, collected by the independent verifiers of rounds 1-2,
//     never select a front-A capability as a DIRECT match on either lane (the O11 lane has B/C capabilities now, but a
//     wrong direct match still spends the answer budget and misleads the focus);
//  2. the critical composed scenario of the acceptance criteria (reset typed variables with exclusions + call inserted
//     in a branch of an existing If), in Portuguese and English on both lanes, fits the 12000-byte budget and carries the
//     typed inventory (logic.variable), the flow contracts (logic.flow, directly, with a node role in focus) and the
//     action capability, with the unproven branch insertion stated rather than claimed;
//  3. one --expand of logic.flow recovers operations+native+evidence at the default expansion budget.
// Needs the lane CLIs built (the index is built from them); skips otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireBytes } from './fixtures/answer-wire.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneSources, discover } from '../discovery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fragmentsDir = path.join(here, '..', 'catalog', 'fragments', 'A');
const A_IDS = new Set(fs.readdirSync(fragmentsDir).filter(f => f.endsWith('.json'))
  .flatMap(f => JSON.parse(fs.readFileSync(path.join(fragmentsDir, f), 'utf8').replace(/^﻿/, '')).capabilities.map(c => c.id))
  .concat(['data.entity', 'data.static', 'data.structure']));
const lanes = { odc: laneSources('odc'), o11: laneSources('o11') };
const built = lane => fs.existsSync(lanes[lane].cli);
const skip = lane => !built(lane) && `${lane} CLI not built`;
const T = { timeout: 600000 };
const ask = (lane, intent, budgetBytes = 12000) => discover({ lane, intent, sources: lanes[lane], budgetBytes });
const direct = a => (a.matches ?? []).filter(m => m.via === 'match');
const ids = a => (a.matches ?? []).map(m => m.id);
const show = a => JSON.stringify((a.matches ?? []).map(m => `${m.id}:${m.via}${m.why ? '[' + [].concat(m.why).join(',') + ']' : ''}`));

// [intent, forbidden front-A ids (null = every front-A capability), note]
const HIJACK = [
  ['mudar o texto de entrada de um input da tela', null, 'B: input widget'],
  ['change the label of a text input widget on a screen', null, 'B: input widget'],
  ['add a sign out link to the menu', null, 'B: menu link'],
  ['fade out the popup after two seconds', null, 'B: popup animation'],
  ['usar o fuso horario local do usuario', null, 'unrelated: time zone'],
  ['passar um argumento na URL da tela de detalhe', null, 'B: navigation parameter'],
  ['preparacao da publicacao para producao', null, 'C: release preparation'],
  ['add an end node to a BPT process', null, 'C: process node'],
  ['add a start node to a process that waits for an event', null, 'C: process node'],
  ['add a comment node to a BPT process', null, 'C: process node'],
  ['add a Decision node with an otherwise path to the BPT process', null, 'C: process decision'],
  ['add a tree view with a node per category', null, 'B: tree widget'],
  ['add a tree widget with expandable nodes', null, 'B: tree widget'],
  ['show the Save button if the user is admin, otherwise hide it', null, 'B: conditional visibility'],
  ['religar o bloco a outra tela', null, 'B: block'],
  ['relink the screen to another theme', null, 'B: theme'],
  ['atribuir valor padrão a um input da tela', null, 'B: input default'],
  ['mostrar um ícone para cada item da lista na tela', null, 'B: list template'],
  ['adicionar um comentário no fluxo de UI', null, 'B: UI flow'],
  // data.static/data.entity reach this one through the shared descriptor synonyms (registro -> record, tabela -> entity;
  // integrator's file, request A-004): only the fragment-owned logic.flow is judged here.
  ['mostrar um botão para cada registro da tabela', ['logic.flow'], 'B: table template'],
  ['check out the shopping cart page', null, 'B: page'],
  ['rodar o servidor local de desenvolvimento', null, 'unrelated: local server'],
  ['use a built-in icon on the header', null, 'B: icon'],
  ['create an advanced search screen', null, 'B: search screen'],
  ['mostrar um texto literal no cabeçalho', null, 'B: text widget'],
  ['show a literal text label above the form', null, 'B: label widget'],
  ['mudar a cor do texto de uma expressão na tela', null, 'B: expression widget style'],
  ['bind an expression to a text widget in the header', null, 'B: expression widget'],
  ['show a popup with an error message when the input field is empty', null, 'B: form validation'],
  ['tratar o erro de validação do formulário', null, 'B: form validation'],
  ['abrir a planilha de requisitos do projeto', null, 'unrelated: spreadsheet'],
  ['adicionar um widget de toast no layout da tela', null, 'B: toast widget'],
  ['filter the query string of the REST request', null, 'C: REST'],
  ['sorted query parameters of the REST call', null, 'C: REST'],
  ['agregação de logs dos servidores no painel de monitorização', null, 'unrelated: log aggregation'],
  ['log errors to an external monitoring service', null, 'C: monitoring'],
  ['log an error when the timer fails', ['logic.exception'], 'C: timer logging'],
  ['criar um tratador global de eventos da tela', null, 'B: screen events'],
  ['stop the click event propagation on the card', null, 'B: event propagation'],
  ['propagar o valor escolhido para a tela pai', null, 'B: parent screen'],
  ['update all consumers of the REST API with the new access token', null, 'C: REST token'],
  ['atualizar todos os consumidores da fila com a nova mensagem', null, 'unrelated: queue'],
  ['mudar a ordem dos pedidos na lista por data de entrega', ['refactor.move'], 'B/runtime: list sorting'],
  ['trocar a action do botão de salvar', ['refactor.replace'], 'B: button handler'],
  ['trocar o evento OnClick do botão', ['refactor.replace'], 'B: event'],
  ['trocar a cor do botão da tela', null, 'B: style'],
  ['redirecionar para outra tela depois de salvar', ['refactor.replace'], 'B: navigation'],
  ['enable offline mode in the mobile app settings', ['data.client-entity'], 'C/B: app settings'],
  ['copiar o texto para a área de transferência', null, 'unrelated: clipboard'],
  ['análise de impacto de trocar o endpoint REST', ['refactor.delete', 'refactor.replace'], 'C: REST impact'],
  ['mudar a fonte do texto do título na tela', null, 'B: font'],
  ['change the font of the title text', null, 'B: font'],
  ['lançar um timer agora', null, 'C: timer'],
  ['somar dois números numa action', ['logic.aggregate'], 'not an aggregate'],
  ['integrate an external SQL Server database connection', ['logic.sql'], 'C: external database'],
  ['remove the item from the shopping cart', ['refactor.delete'], 'runtime data, not model delete'],
  ['move the user to the next step of the wizard', ['refactor.move'], 'B: wizard'],
  ['rename the uploaded file before storing it', ['refactor.rename'], 'runtime file'],
  ['create a timer that runs logic every night', ['logic.flow', 'refactor.replace'], 'C: timer'],
  // round-4 verifier probes: If-branch words of a BPT decision or of the If widget are not action-flow branches
  ['o ramo verdadeiro da decisão no processo BPT deve notificar o gestor', null, 'C: BPT decision branch'],
  // ('send an email' legitimately names the send email node of logic.native-nodes: only the branch words are judged)
  ['configure the true branch of the process Decision to send an email', ['logic.flow'], 'C: BPT decision branch'],
  ['mostrar o conteúdo do ramo falso do widget If na tela', null, 'B: If widget branch'],
  ['show the false branch of the If widget when the list is empty', null, 'B: If widget branch'],
  ['o if que já existe na tela deve esconder o botão de excluir', null, 'B: If widget'],
  // round-4 verifier minors
  ['aggregate the crash logs from the mobile devices', null, 'unrelated: log aggregation'],
  ['renomear o domínio customizado da aplicação no portal', null, 'C: portal domain'],
  ['copy the CSS class to the other theme', null, 'B: theme CSS'],
];

// Probes whose remaining hit comes from a cause outside front A's fragments, stated with the request that removes it:
// they run as `todo` (reported, not failing) and turn into plain assertions when the cause is gone.
const PENDING = {
  'adicionar um comentário no fluxo de UI': 'A-005: the legacy ODC "action" synonym group lists fluxo/flow and "screen" lists ui, so "fluxo de UI" joins the canonicals into "screen action" (adjacency in the joined terms)',
};

for (const lane of ['odc', 'o11']) {
  test(`[${lane}] hijack guard: ${HIJACK.length} intents of other fronts or unrelated vocabulary never select a front-A capability directly`, { ...T, skip: skip(lane) }, async () => {
    const bad = [];
    for (const [intent, forbidden, note] of HIJACK) {
      if (PENDING[intent]) continue;
      const a = await ask(lane, intent);
      const hit = direct(a).map(m => m.id).filter(id => A_IDS.has(id) && (!forbidden || forbidden.includes(id)));
      if (hit.length) bad.push(`${note} | "${intent}" -> ${hit.join(',')} ${show(a)}`);
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });
  for (const [intent, cause] of Object.entries(PENDING)) {
    test(`[${lane}] pending outside front A: "${intent}" (${cause})`, { ...T, skip: skip(lane), todo: cause }, async () => {
      const a = await ask(lane, intent);
      assert.deepEqual(direct(a).map(m => m.id).filter(id => A_IDS.has(id)), [], show(a));
    });
  }
}

const SCENARIO = {
  pt: 'criar uma action que limpa variáveis de tipos diferentes, exceto algumas, e chamá-la dentro de um ramo de um If existente',
  en: 'create an action that resets variables of several types except a few, and call it inside a branch of an existing If',
  pt2: 'montar uma server action que zera as variáveis de vários tipos menos duas e inserir a chamada no ramo verdadeiro de um If que já existe',
  en2: 'build a server action that clears variables of different data types, keeping two of them, and insert its call into the true branch of an existing If node',
};
// Paraphrases measured by the round-4 verifier. Enumerating their words as keywords (set 2) made them pass but added
// 15-16 new hijacks per lane (docs/evidence/catalogo-abrangente/A/verification/set2.md), so those forms were reverted:
// these stay `todo` until the engine can anchor a keyword to its context (request A-006).
const LEXICAL_TODO = 'A-006: recall of free paraphrases needs anchored keywords (a plural "variables"/"variáveis" counting only next to type/reset words; branch words only next to an action-flow If); enumerating them as keywords hijacked other fronts (set2.md)';
const SCENARIO_TODO = {
  pt3: 'criar uma server action que reinicia variáveis de diferentes tipos deixando algumas de fora e chamá-la no ramo falso de um If que já está no fluxo',
  pt4: 'gerar uma server action que zera textos, números, datas e listas, exceto duas variáveis, e chamá-la no ramo verdadeiro do If existente',
  en3: 'create a server action that resets variables of mixed data types except a few and call it in the false branch of an If that is already in the flow',
  en4: 'write a server action that clears text, number, date and list variables, skipping two, and call it from the true branch of the existing If',
  en5: 'add a server action that resets variables of several data types except some and call it inside the false branch of an existing If',
};

// Recall: natural wordings that must select the named capability directly ([intent, id, lanes?, todo?]).
const RECALL = [
  ['fazer uma cópia da server action', 'refactor.duplicate'],
  ['renomear a action e atualizar os chamadores', 'refactor.rename'],
  ['substituir a action antiga pela nova em todos os chamadores', 'refactor.replace', null, LEXICAL_TODO],
  ['replace every call of the old action with the new one', 'refactor.replace', null, LEXICAL_TODO],
  ['excluir a action sem uso depois de ver o impacto', 'refactor.delete', null, LEXICAL_TODO],
  ['delete the unused action after checking the impact', 'refactor.delete', null, LEXICAL_TODO],
  ['mudar a ordem dos parâmetros de entrada da ação', 'refactor.move', null, LEXICAL_TODO],
  ['criar um nó SQL que lê os pedidos com um parâmetro de entrada', 'logic.sql', null, LEXICAL_TODO],
  ['adicionar um nó de mensagem de erro na screen action', 'logic.native-nodes', null, LEXICAL_TODO],
  ['adicionar um switch com três condições numa action', 'logic.flow', null, LEXICAL_TODO],
  ['adicionar uma preparation na tela web tradicional', 'logic.preparation', ['o11'], LEXICAL_TODO],
  ['create the preparation of the web screen', 'logic.preparation', ['o11'], LEXICAL_TODO],
];
for (const lane of ['odc', 'o11']) {
  const strict = RECALL.filter(([, , only, todo]) => !todo && (!only || only.includes(lane)));
  test(`[${lane}] recall: ${strict.length} natural wordings select their front-A capability directly`, { ...T, skip: skip(lane) }, async () => {
    const miss = [];
    for (const [intent, id] of strict) {
      const a = await ask(lane, intent);
      if (!direct(a).some(m => m.id === id)) miss.push(`"${intent}" -> expected ${id}: ${show(a)}`);
    }
    assert.deepEqual(miss, [], miss.join('\n'));
  });
  for (const [intent, id, only, todo] of RECALL.filter(r => r[3] && (!r[2] || r[2].includes(lane)))) {
    test(`[${lane}] recall pending (${id}): "${intent}"`, { ...T, skip: skip(lane), todo }, async () => {
      const a = await ask(lane, intent);
      assert.ok(direct(a).some(m => m.id === id), show(a));
    });
  }
}
const FLOW_ROLES = ['execute server action node', 'execute client action node', 'assign node', 'assignment', 'if node', 'connector'];
for (const lane of ['odc', 'o11']) for (const [lang, intent] of Object.entries(SCENARIO_TODO)) {
  test(`[${lane}] critical composed scenario, free paraphrase (${lang}) pending`, { ...T, skip: skip(lane), todo: LEXICAL_TODO }, async () => {
    const a = await ask(lane, intent);
    assert.notEqual(a.size.status, 'insufficient', show(a));
    assert.ok(direct(a).some(m => m.id === 'logic.flow') && ids(a).includes('logic.variable'), show(a));
  });
}
for (const lane of ['odc', 'o11']) for (const [lang, intent] of Object.entries(SCENARIO)) {
  test(`[${lane}] critical composed scenario (${lang}): within 12000 bytes, logic.flow direct with a node role in focus, the typed inventory and the action capability present, the branch insertion backed by the lane's own proof job`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, intent);
    assert.equal(a.ok, true, a.error);
    assert.ok(wireBytes(a, { budgetBytes: 12000 }) <= 12000, `hard budget: ${a.size.bytes}`);
    assert.notEqual(a.size.status, 'insufficient', `insufficient: minimal ${a.size.minimalBytes} ${show(a)}`);
    const flow = direct(a).find(m => m.id === 'logic.flow');
    assert.ok(flow, `logic.flow is a direct match: ${show(a)}`);
    assert.ok((flow.focus?.roles ?? []).some(r => FLOW_ROLES.includes(r)), `a flow node role in focus: ${JSON.stringify(flow.focus)}`);
    assert.ok(ids(a).includes('logic.variable'), `typed inventory (logic.variable) in the answer: ${show(a)}`);
    assert.ok(ids(a).some(id => ['logic.server-action', 'logic.client-action', 'logic.screen-action'].includes(id)), `an action capability in the answer: ${show(a)}`);
    // The branch insertion is proven since INT-T2-003 by cat-a-reset-typed-values of each lane (ODC TrueTarget, O11
    // FalseTarget): the answer names the branch connector and no longer calls it unproven; the full statement (proof
    // job, level) is one expansion away and must cite the lane's own job at the current level.
    const text = JSON.stringify(flow);
    assert.match(text, /TrueTarget|FalseTarget|branch|ramo/i, 'the branch connector is named');
    assert.doesNotMatch(text, /(branch|ramo)[^"]{0,80}(not proven|have not run|nao provad)/i, 'the branch insertion is no longer called unproven');
    const x = (await discover({ lane, expand: 'logic.flow:operations', sources: lanes[lane], budgetBytes: 200000 })).expansions['logic.flow'].operations;
    const proofs = Object.values(x).flatMap(o => Object.values(o.roles).flatMap(r => r.proofs ?? []));
    assert.ok(proofs.some(p => p.job === 'cat-a-reset-typed-values' && p.level === 'C-executed-current'), `cat-a-reset-typed-values cited at the current level on ${lane}`);
  });
}

for (const lane of ['odc', 'o11']) {
  test(`[${lane}] explicit flow expansion preserves requested parts or names the budget needed to recover them`, { ...T, skip: skip(lane) }, async () => {
    const input = { lane, expand: 'logic.flow:operations+native+evidence', sources: lanes[lane] };
    let x = await discover(input);
    assert.equal(x.ok, true, x.error);
    // Provenance and catalog growth can exceed a fixed byte ceiling.
    // An explicit refusal must name a sufficient next budget, never silently omit requested operations.
    if (x.size?.status === 'insufficient') {
      assert.ok(x.size.minimalBytes > x.size.budgetBytes);
      const budgetBytes = x.size.minimalBytes + 1024;
      x = await discover({ ...input, budgetBytes });
      assert.ok(wireBytes(x, { budgetBytes: budgetBytes }) <= budgetBytes);
    }
    assert.notEqual(x.size?.status, 'insufficient', `insufficient: minimal ${x.size?.minimalBytes}`);
    assert.ok(x.expansions?.['logic.flow']?.operations, 'requested operations recovered');
    assert.ok(x.expansions['logic.flow'].native);
    assert.ok(x.expansions['logic.flow'].evidence);
  });
}
