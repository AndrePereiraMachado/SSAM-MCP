// Front A, fragment refactor (catalog M1): the transversal refactoring capabilities refactor.rename, refactor.replace,
// refactor.duplicate, refactor.move and refactor.delete, shared by both lanes and without element roles of their own
// (per-role statuses live in the data.* and logic.* families), through the PUBLIC discovery entry: Portuguese and
// English intents select them directly on each lane, an intent that names an element reaches the family role with its
// focus while the refactoring report stays reachable, the lane difference of a rename (<Node>.<Output>) and the refused
// cases answer with what each lane declared and proved (negative jobs of that lane, with their expectError), ordinary
// UI/integration intents that share a word with the theme (trocar, redirecionar, copiar, impacto, ordem, posição,
// consumidores) do not select a refactor capability, the outside-root sequence mechanics are accounted, and every answer
// fits the 12000-byte budget. Needs the lane CLIs built (the index is built from them); skips otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneSources, discover } from '../discovery.mjs';
import { checkCatalog } from '../catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const lanes = { odc: laneSources('odc'), o11: laneSources('o11') };
const built = lane => fs.existsSync(lanes[lane].cli);
const bytesOf = a => Buffer.byteLength(JSON.stringify(a), 'utf8');
const direct = a => (a.matches ?? []).filter(m => m.via === 'match');
const ask = (lane, intent) => discover({ lane, intent, sources: lanes[lane], budgetBytes: 12000 });
const expand = (lane, what) => discover({ lane, expand: what, sources: lanes[lane], budgetBytes: 400000 });
const jobName = n => (typeof n === 'string' ? n : n.job);
const REFACTOR = ['refactor.rename', 'refactor.replace', 'refactor.duplicate', 'refactor.move', 'refactor.delete'];
function withinBudget(a, label) {
  assert.equal(a.ok, true, label + ': ' + (a.error ?? ''));
  assert.ok(bytesOf(a) <= 12000 && a.size.bytes <= 12000, `${label}: hard budget, ${bytesOf(a)} bytes`);
  assert.notEqual(a.size.status, 'insufficient', `${label}: minimalBytes ${a.size.minimalBytes}`);
}
function selected(a, id, label) {
  const m = direct(a).find(x => x.id === id);
  assert.ok(m, `${label}: ${id} is a direct match; got ${JSON.stringify(a.matches.map(x => x.id + ':' + x.via))}`);
  return m;
}
const skip = lane => !built(lane) && `${lane} CLI not built`;
const T = { timeout: 240000 };
// The level of each cited proof is the engine's reading of that job's stamped result, never a text of the fragment:
// current/historical only with an executed result, C-suite only without one. The O11 stamp list grows between
// campaigns, so no test pins a job to a level.
function levelsFollowResults(proofs, lane) {
  for (const p of proofs) {
    assert.ok(['C-executed-current', 'C-executed-historical', 'C-suite'].includes(p.level), `${lane} ${p.job}: ${p.level}`);
    if (p.level === 'C-suite') assert.equal(p.executedAt ?? null, null, `${lane} ${p.job}: C-suite has no result`);
    else assert.ok(p.executedAt, `${lane} ${p.job}: ${p.level} has an executed result`);
  }
}
const RENAME = 'renomear sem perder a propagação: o que é reescrito e o que fica para trás';
const DELETE = 'análise do impacto antes de apagar um elemento que ainda tem consumidores';
const REPLACE = 'substituir a antiga por uma nova em todos os chamadores';
const MOVE = 'reordenar e mover um elemento para outra posição dentro do mesmo pai';
// English intents of the theme: each selects its capability directly and fits the budget on both lanes.
const ENGLISH = [
  ['replace an old action with a new one in every caller', 'refactor.replace'],
  ['duplicate a screen with its aggregates', 'refactor.duplicate'],
  ['rename a server action and update every caller', 'refactor.rename']
];
// Ordinary UI, integration or unrelated intents that share a word with the theme: no refactor capability is a direct
// match on either lane (on O11 no front-B/C capability exists yet, so a hijacked word would be the only answer).
const HIJACK = [
  'trocar o evento OnClick do botão',
  'trocar a cor do botão da tela',
  'redirecionar para outra tela depois de salvar',
  'redirect the user to the login screen',
  'copiar o texto para a área de transferência',
  'copy the text to the clipboard',
  'análise de impacto de trocar o endpoint REST',
  'who calls this REST API endpoint',
  'mostrar o primeiro registro da lista em ordem alfabética',
  'set the position of the popup',
  'replace the logo image on the header',
  'consumir uma API REST e atualizar os consumidores do token',
  // round-3 critic: refactor.move/duplicate were selected by generic element nouns of their summaries alone
  'criar uma tela com um widget de botão que chama uma ação',
  'show the parent screen after the action returns',
  'colocar a variável da tela no container da ação',
  'fim do fluxo de aprovação do processo BPT',
];

for (const lane of ['odc', 'o11']) {
  test(`[${lane}] a Portuguese rename intent selects refactor.rename directly, proven by current jobs of this lane, and states the <Node>.<Output> lane difference`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, RENAME);
    withinBudget(a, lane);
    const m = selected(a, 'refactor.rename', lane);
    assert.equal(m.shared, true); assert.deepEqual(m.lanes, ['odc', 'o11']);
    assert.equal(m.level, 'C-executed-current');
    for (const p of m.proofs) assert.ok(fs.existsSync(`${lanes[lane].jobsDir}/${p.job}.json`), `${p.job} is a job of the ${lane} suite`);
    assert.ok(m.proofs.some(p => p.job === 'rename-logic-propagation' && p.level === 'C-executed-current'), JSON.stringify(m.proofs));
    const neg = m.negative.map(jobName);
    for (const n of ['rename-name-clash', 'rename-structure-clash', 'rename-static-record']) assert.ok(neg.includes(n), `${n} is a negative job of this lane: ${JSON.stringify(neg)}`);
    for (const n of neg) assert.ok(fs.existsSync(`${lanes[lane].negativeDir}/${n}.json`), `${n} is a negative job of the ${lane} suite`);
    // The difference is stated from each lane's own job, with the other lane's statement beside it.
    assert.match(m.differences.o11.join(' '), /<Node>\.<Output>.*not rewritten/);
    assert.match(m.differences.odc.join(' '), /rewrites the consumers' `<Node>\.<Output>`/);
    if (lane === 'o11') assert.match(m.limits[0].text, /<Node>\.<Output>` keep the old name/, 'on O11 the first limit is the manual fix after an action rename');
    else assert.ok(!m.limits.some(l => /keep the old name \(the consumer node/.test(l.text)), 'ODC does not carry the O11 limit');
    const ev = (await expand(lane, 'refactor.rename:evidence')).expansions['refactor.rename'].evidence;
    // Levels follow the engine: a proof is current only with a stamped result, and a suite job without one stays C-suite.
    levelsFollowResults(ev.proofs, lane);
    const clash = ev.negative.find(n => n.job === 'rename-structure-clash');
    assert.ok(clash.expectError.some(t => /clashes with an existing name/.test(t)), JSON.stringify(clash));
  });

  test(`[${lane}] impact before delete: refactor.delete is direct, its refusals (entity included) name each consumer and repointing is the alternative`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, DELETE);
    withinBudget(a, lane);
    const m = selected(a, 'refactor.delete', lane);
    assert.equal(m.level, 'C-executed-current');
    assert.ok(m.why.includes('apagar') && m.why.includes('impacto ant apagar'), JSON.stringify(m.why));
    const negatives = m.negative.map(jobName);
    assert.ok(negatives.length >= 4 && negatives.includes('delete-entity-in-use') && negatives.includes('delete-structure-in-use'), JSON.stringify(negatives));
    if (lane === 'o11') assert.ok(negatives.includes('delete-widget-in-use'), JSON.stringify(negatives));
    for (const n of negatives) assert.ok(fs.existsSync(`${lanes[lane].negativeDir}/${n}.json`), `${n} is a negative job of the ${lane} suite`);
    assert.ok(a.matches.some(x => x.id === 'refactor.replace' && x.via === 'alternative' && /repoint/.test(x.reason)), 'repointing (replace) is the alternative of a delete');
    assert.ok((a.composition?.recommended ?? a.recommended ?? []).some(r => r.id === 'data.entity' && r.by === 'refactor.delete'), 'the family capability is recommended so an element reaches its role statuses');
    // The whole evidence (negative jobs with their expectError): every refusal names the consumers and offers force,
    // which is never the recommended path; the entity refusal names the outside consumer, never the '<X> Record' the
    // platform generates with the entity (the kernel spares that companion since coverage phase 2).
    const ev = (await expand(lane, 'refactor.delete:evidence')).expansions['refactor.delete'].evidence;
    for (const n of ev.negative) assert.ok((n.expectError ?? []).length, `${n.job}: a negative is a refusal job with expectError`);
    const refusals = ev.negative.filter(n => (n.expectError ?? []).some(t => t.startsWith('delete: refused')));
    assert.ok(refusals.length >= 4, JSON.stringify(ev.negative.map(n => n.job)));
    for (const n of refusals) { assert.ok(n.expectError.some(t => /is used by \d+ consumer\(s\)/.test(t)), n.job); assert.ok(n.expectError.some(t => t.includes('"force": true')), n.job); }
    const entity = ev.negative.find(n => n.job === 'delete-entity-in-use');
    assert.ok(entity.expectError.some(t => /^I\w+:[^/]+\/I\w+:/.test(t)) && !entity.expectError.some(t => / Record\b/.test(t)), 'the entity refusal names its outside consumer, not its generated record: ' + JSON.stringify(entity.expectError));
    assert.match(ev.guidance, /usages/); assert.match(ev.guidance, /observed/);
  });

  test(`[${lane}] refused cases answer with the declared status: replace between entities, duplicate of an index and move outside an ordered sequence are refusals proven by negative jobs of this lane`, { ...T, skip: skip(lane) }, async () => {
    const r = await ask(lane, REPLACE);
    withinBudget(r, lane + ' replace');
    const rep = selected(r, 'refactor.replace', lane + ' replace');
    assert.deepEqual(rep.negative.map(jobName), ['replace-entity']);
    assert.equal(rep.level, 'C-executed-current');
    // Each replace proof carries the level of its own result (a suite job without a stamped result is never current).
    levelsFollowResults((await expand(lane, 'refactor.replace:evidence')).expansions['refactor.replace'].evidence.proofs, lane);
    assert.match(rep.summary, /different kind needs force/);
    const mv = await ask(lane, MOVE);
    withinBudget(mv, lane + ' move');
    const move = selected(mv, 'refactor.move', lane + ' move');
    const neg = move.negative.map(jobName);
    assert.ok(neg.includes('move-foreign-sibling'), JSON.stringify(neg));
    if (lane === 'o11') {
      for (const n of ['move-not-a-sequence', 'move-index', 'move-static-record', 'move-index-attribute']) assert.ok(neg.includes(n), `${n}: ${JSON.stringify(neg)}`);
      assert.match(move.differences.o11.join(' '), /not an ordered sequence/);
      assert.ok(!mv.matches.some(x => x.id === 'deliver.feature'), 'deliver.feature does not exist on O11: the alternative is projected on ODC only');
    } else {
      assert.ok(neg.includes('move-index') && neg.includes('move-static-record'), JSON.stringify(neg));
      assert.match(move.differences.odc.join(' '), /ordered sequence: move is accepted/);
      assert.ok(move.proofs.some(p => p.job === 'structure-refactor'), 'structure attributes are reordered by a proof of this lane');
      assert.ok(mv.matches.some(x => x.id === 'deliver.feature' && x.via === 'alternative' && /C# feature/.test(x.reason)), 'reparenting is the ODC alternative (deliver.feature)');
    }
    const ev = (await expand(lane, 'refactor.move:evidence')).expansions['refactor.move'].evidence;
    const foreign = ev.negative.find(n => n.job === 'move-foreign-sibling');
    assert.ok(foreign.expectError.includes('move only REORDERS inside the same parent'), JSON.stringify(foreign));
    const dup = (await expand(lane, 'refactor.duplicate:evidence')).expansions['refactor.duplicate'].evidence;
    const index = dup.negative.find(n => n.job === 'duplicate-index');
    assert.ok(index.expectError.some(t => /cannot be duplicated/.test(t)), JSON.stringify(dup.negative));
  });

  test(`[${lane}] an intent that names the element reaches the family role with its focus, and the refactoring report stays reachable`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, 'renomear a server action e ver quem chama');
    withinBudget(a, lane);
    const s = selected(a, 'logic.server-action', lane);
    assert.deepEqual(s.focus.roles, ['server action']);
    assert.ok(s.focus.ops.includes('rename') && s.focus.ops.includes('usages'), JSON.stringify(s.focus));
    const rename = s.operations.rename.roles['server action'];
    assert.equal(rename.status, 'applicable'); assert.equal(rename.evidence, 'proven-current');
    assert.ok(a.matches.some(x => x.id === 'refactor.rename'), 'the transversal rename report is in the answer (direct or alternative)');
  });

  test(`[${lane}] English intents of the theme select their refactor capability directly within the budget`, { ...T, skip: skip(lane) }, async () => {
    for (const [intent, id] of ENGLISH) {
      const a = await ask(lane, intent);
      withinBudget(a, `${lane} "${intent}"`);
      selected(a, id, `${lane} "${intent}"`);
    }
  });

  test(`[${lane}] hijack guard: ordinary UI/integration intents that share a word with the theme select no refactor capability`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of HIJACK) {
      const a = await ask(lane, intent);
      assert.equal(a.ok, true, intent);
      const hit = direct(a).filter(m => REFACTOR.includes(m.id)).map(m => `${m.id}${JSON.stringify(m.why)}`);
      assert.deepEqual(hit, [], `${lane} "${intent}": no refactor capability is a direct match`);
    }
  });

  test(`[${lane}] the refactor capabilities declare no native type of their own (no runtime provenance to check): their expansions carry no native and no role operations`, { ...T, skip: skip(lane) }, async () => {
    const x = (await expand(lane, REFACTOR.map(id => id + ':operations+native').join(','))).expansions;
    for (const id of REFACTOR) {
      assert.ok(x[id], id);
      assert.deepEqual(x[id].native ?? [], [], `${id}: transversal, per-role natives live in the families`);
      assert.deepEqual(x[id].operations ?? {}, {}, id);
    }
  });
}

// refactor.* declare no roles, so three summary words select one of them on their own: the move and duplicate summaries
// carry none of the generic element nouns everyday UI/logic intents use.
test('the refactor.move and refactor.duplicate summaries name no generic element noun (screen, widget, action, variable, parent, container, flow, node, order)', () => {
  const frag = JSON.parse(fs.readFileSync(new URL('../catalog/fragments/A/refactor.json', import.meta.url), 'utf8').replace(/^﻿/, ''));
  for (const id of ['refactor.move', 'refactor.duplicate']) {
    const summary = frag.capabilities.find(c => c.id === id).summary.toLowerCase();
    for (const noun of ['screen', 'widget', 'action', 'variable', 'parent', 'container', 'flow', 'node', 'order']) assert.ok(!new RegExp(`\\b${noun}`).test(summary.replace(/reorders?/g, '')), `${id} summary names "${noun}"`);
  }
});

test('accounting: the outside-root model-object and ordered-sequence mechanics behind move/delete are classified by front A and the fragment composes without errors', () => {
  const r = checkCatalog({ root, front: 'A' });
  assert.deepEqual(r.errors.filter(e => /refactor/.test(e.text ?? e)), []);
  assert.deepEqual(r.warnings.filter(w => /refactor\.json/.test(w.text ?? w)), []);
  for (const key of ['odc:OutSystems.Model.IModelObject', 'odc:OutSystems.Model.ISequence', 'odc:OutSystems.Model.ISequence<T>', 'o11:ISequence<T>']) assert.equal(r.typeStates[key], 'classified', key);
  assert.ok(r.pendingRequires.some(p => p.capability === 'refactor.move' && p.id === 'deliver.feature' && p.missingOn.join() === 'o11'), 'deliver.feature is pending on O11 only');
});

// Recall (round 3): two more natural intents per capability of this theme (Portuguese and English, wording not used by
// the tests above) select the capability as a DIRECT match on every lane where it exists. Only the selection is
// asserted here; the budget and the evidence are asserted by the tests above.
const RECALL_R3 = [
  ["renomear a entidade e propagar para as expressões", "refactor.rename"],
  ["rename an attribute and see which expressions were rewritten", "refactor.rename"],
  ["reapontar os consumidores da action antiga para a nova", "refactor.replace"],
  ["replace a server action in all its callers", "refactor.replace"],
  ["duplicar a tela com as suas ações", "refactor.duplicate"],
  ["duplicate a server action with Ctrl+D", "refactor.duplicate"],
  ["reordenar os atributos da entidade", "refactor.move"],
  ["reorder the attributes of an entity", "refactor.move"],
  ["apagar uma entidade que ainda tem consumidores", "refactor.delete"],
  ["delete an element after checking its usages", "refactor.delete"],
];
for (const lane of ['odc', 'o11']) {
  test(`[${lane}] recall: new natural Portuguese and English intents select each capability of the theme directly`, { ...T, skip: skip(lane) }, async () => {
    const missed = [];
    for (const [intent, id, only] of RECALL_R3) {
      if (only && !only.includes(lane)) continue;
      const a = await ask(lane, intent);
      assert.equal(a.ok, true, `${lane}: ${intent}: ${a.error ?? ''}`);
      if (!direct(a).some(m => m.id === id)) missed.push(`${id} <- "${intent}": ${direct(a).map(m => m.id).join(', ')}`);
    }
    assert.deepEqual(missed, [], missed.join('\n'));
  });
}
