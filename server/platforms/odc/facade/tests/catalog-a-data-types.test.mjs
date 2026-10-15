// Front A, fragment data-types-expressions (catalog M1): client entities (local storage), client variables and
// expressions/literals, through the PUBLIC discovery entry on both lanes. Portuguese (including synonym-only phrasings)
// and English intents select data.client-entity, data.client-variable and logic.expression directly with the element
// role in focus; each role/operation/lane answers with the evidence the engine computes from THAT lane's jobs (a proof
// counts as proven only when it is an executed, current job that ran the verb on the role's native; unstamped suite
// jobs stay declared-not-proven); natives are the ones loaded in each lane runtime; list literal items exist on ODC
// only; the Expression widget on a screen is stated as front B's; the ODC session-variable refusal is answered as an
// unavailable element with its negative job; intents of other fronts that share words with the theme (expression
// widget, client action, local variable, form field, settings, REST) do not select these capabilities; every answer of
// the theme fits the 12000-byte budget. Needs the lane CLIs built (the index is built from them); skips otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireBytes } from './fixtures/answer-wire.mjs';
import fs from 'node:fs';
import { laneSources, discover } from '../discovery.mjs';

const lanes = { odc: laneSources('odc'), o11: laneSources('o11') };
const built = lane => fs.existsSync(lanes[lane].cli);
const bytesOf = a => Buffer.byteLength(JSON.stringify(a), 'utf8');
const direct = a => (a.matches ?? []).filter(m => m.via === 'match');
const ask = (lane, intent) => discover({ lane, intent, sources: lanes[lane], budgetBytes: 12000 });
const expand = (lane, what) => discover({ lane, expand: what, sources: lanes[lane], budgetBytes: 200000 });
function withinBudget(a, label) {
  assert.equal(a.ok, true, label + ': ' + (a.error ?? ''));
  assert.ok(wireBytes(a, { budgetBytes: 12000 }) <= 12000, `${label}: hard budget, ${bytesOf(a)} bytes`);
  assert.notEqual(a.size.status, 'insufficient', label);
}
const pick = (a, id) => { const f = direct(a).find(m => m.id === id); assert.ok(f, `${id} not a direct match: ` + JSON.stringify((a.matches ?? []).map(m => m.id + ':' + m.via))); return f; };
const skip = lane => !built(lane) && `${lane} CLI not built`;
const T = { timeout: 240000 };
const full = async (lane, id) => (await expand(lane, `${id}:operations+native+evidence`)).expansions[id];
const suiteJob = (lane, name) => fs.existsSync(`${lanes[lane].jobsDir}/${name}.json`);
const OURS = ['data.client-entity', 'data.client-variable', 'logic.expression'];
// The evidence label follows the proofs, never the declaration: proven-current only with an executed, current proof
// that ran the operation's verb on the role's native; an unstamped suite job (C-suite) is declared-not-proven.
function evidenceFollowsProofs(s, label) {
  const current = s.proofs.filter(p => p.level === 'C-executed-current' && p.verified);
  if (current.length) assert.equal(s.evidence, 'proven-current', label);
  else assert.ok(['declared-not-proven', 'proven-historical'].includes(s.evidence), `${label}: ${s.evidence} without a current executed proof`);
  for (const p of s.proofs.filter(p => p.level === 'C-suite')) assert.ok(!p.verified, `${label}: unstamped ${p.job} carries no verified execution`);
}
function proofsOfThisLane(lane, x) {
  for (const [op, o] of Object.entries(x.operations)) for (const [role, r] of Object.entries(o.roles)) {
    for (const p of r.proofs ?? []) assert.ok(suiteJob(lane, p.job), `${op}/${role}: ${p.job} is a job of the ${lane} suite`);
    if (r.status === 'undetermined') assert.deepEqual(r.proofs, [], `${op}/${role}: undetermined carries no proofs`);
  }
}
function nativeFromRuntime(x, role, native) {
  const n = x.native.find(k => k.role === role);
  assert.ok(n, `${role} has a native entry`);
  assert.equal(n.native, native);
  assert.equal(n.runtime?.provenance, 'A-runtime', `${role}: the native type is the one loaded in the lane runtime`);
}

for (const lane of ['odc', 'o11']) {
  test(`[${lane}] a client entity for local storage selects data.client-entity directly with the role in focus; the evidence follows this lane's own jobs`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, 'criar uma entidade do lado do cliente para armazenamento local offline');
    withinBudget(a, lane);
    const f = pick(a, 'data.client-entity');
    assert.deepEqual(f.focus.roles, ['client entity']);
    assert.deepEqual(f.focus.ops, ['create']);
    const create = f.operations.create.roles['client entity'];
    assert.equal(create.status, 'applicable');
    evidenceFollowsProofs(create, `${lane} create`);
    if (lane === 'odc') { assert.equal(create.evidence, 'proven-current'); assert.deepEqual(create.proofs.map(p => p.job), ['client-storage']); }
    else {
      assert.deepEqual(create.proofs.map(p => p.job).sort(), ['local-storage-mobile', 'local-storage-notes-mobile']);
      assert.ok(create.proofs.every(p => ['C-suite', 'C-executed-current', 'C-executed-historical'].includes(p.level)), JSON.stringify(create.proofs));
    }
    const x = await full(lane, 'data.client-entity');
    const read = x.operations.read.roles['client entity'];
    if (lane === 'odc') { assert.equal(read.status, 'applicable'); assert.equal(read.evidence, 'proven-current'); }
    else { assert.equal(read.status, 'undetermined'); assert.deepEqual(read.proofs, []); }
    assert.ok(x.evidence.limits.some(l => /[Pp]ublic client entit/.test(l.text) && /ModuleSpecification\.cs/.test(l.origin)), JSON.stringify(x.evidence.limits));
    nativeFromRuntime(x, 'client entity', 'OutSystems.Model.Data.IClientEntity');
    proofsOfThisLane(lane, x);
  });

  // The legacy ODC descriptor's `client` synonym group replaces a fragment group with the same key, so Portuguese
  // phrasings that only a synonym carries must still reach the client entity (keywords + a distinct group key).
  test(`[${lane}] synonym-only and English phrasings of a client entity still select data.client-entity with the role in focus`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of ['criar uma entidade do lado do cliente', 'dados em entidades locais', 'create a client entity for offline local storage']) {
      const a = await ask(lane, intent);
      withinBudget(a, `${lane} ${intent}`);
      const f = pick(a, 'data.client-entity');
      assert.deepEqual(f.focus.roles, ['client entity'], intent);
    }
  });

  // Round-3 critic: a Customer ("Cliente") entity or table is a server entity, never the client (device) entity: the
  // bare "entidade de/do/no cliente" forms are gone and "client entity" is matched on the raw intent words only.
  test(`[${lane}] a Customer entity or table named "Cliente/clientes" does not select data.client-entity`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of ['criar a entidade Cliente com os atributos Nome e Email', 'criar a tabela de clientes', 'importar uma planilha excel para a tabela de clientes', 'renomear o atributo Nome da entidade Cliente sem quebrar as telas']) {
      const a = await ask(lane, intent);
      assert.equal(a.ok, true, intent);
      assert.ok(!direct(a).some(m => m.id === 'data.client-entity'), `${lane}: "${intent}" -> ${direct(a).map(m => m.id).join(', ')}`);
    }
  });

  test(`[${lane}] a client variable selects data.client-variable directly (PT and EN); create/set follow this lane's jobs, usages and rename are proven on ODC only`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of ['criar uma variável de cliente do tipo texto', 'create a client variable to keep the selected language']) {
      const a = await ask(lane, intent);
      withinBudget(a, `${lane} ${intent}`);
      const f = pick(a, 'data.client-variable');
      assert.deepEqual(f.focus.roles, ['client variable'], intent);
      assert.deepEqual(f.focus.ops, ['create'], intent);
    }
    const x = await full(lane, 'data.client-variable');
    nativeFromRuntime(x, 'client variable', 'OutSystems.Model.Data.IClientVariable');
    proofsOfThisLane(lane, x);
    const role = op => x.operations[op].roles['client variable'];
    for (const op of ['create', 'set']) { assert.equal(role(op).status, 'applicable'); evidenceFollowsProofs(role(op), `${lane} ${op}`); }
    assert.equal(role('read').status, 'undetermined');
    assert.equal(role('delete').status, 'undetermined');
    if (lane === 'odc') {
      assert.deepEqual(role('create').proofs.map(p => p.job).sort(), ['external-site-and-events', 'platform-events-lifecycle', 'security-settings']);
      for (const op of ['create', 'set', 'usages', 'rename']) assert.equal(role(op).evidence, 'proven-current', op);
      assert.deepEqual(role('rename').proofs.map(p => p.job), ['platform-events-lifecycle']);
    } else {
      assert.deepEqual(role('create').proofs.map(p => p.job), ['security-config-reactive']);
      assert.equal(role('usages').status, 'undetermined');
      assert.equal(role('rename').status, 'undetermined');
      assert.ok(x.evidence.limits.some(l => /session variables/.test(l.text)), 'O11 session variables are stated as not represented');
    }
  });

  test(`[${lane}] an item of a list literal selects logic.expression directly with the list literal item role in focus (PT and EN); applicable on ODC, not-applicable on O11`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of ['criar um item num literal de lista de uma expressão', 'create a list literal with three items as an action argument']) {
      const a = await ask(lane, intent);
      withinBudget(a, `${lane} ${intent}`);
      const f = pick(a, 'logic.expression');
      assert.deepEqual(f.focus.roles, ['list literal item'], intent);
      assert.deepEqual(f.focus.ops, ['create'], intent);
      // The answer states status and evidence (front B's ui.list also matches these words now, so the answer is
      // reduced); proofs, note and the other lane's status are read from the full statement below.
      const item = f.operations.create.roles['list literal item'];
      if (lane === 'odc') { assert.equal(item.status, 'applicable'); assert.equal(item.evidence, 'proven-current'); }
      else { assert.equal(item.status, 'not-applicable'); assert.equal(item.evidence, 'refusal-declared'); assert.match(item.alternative, /ListAppend/); }
    }
    const item = (await full(lane, 'logic.expression')).operations.create.roles['list literal item'];
    if (lane === 'odc') assert.deepEqual(item.proofs.map(p => p.job), ['expression-literals']);
    else { assert.match(item.note, /O11 Model API/); assert.match(item.alternative, /ListAppend/); assert.equal(item.otherLanes.odc.status, 'applicable'); }
  });

  // Hijack guard: intents of front B (Expression widget, form field, list on a screen), front C (settings, REST) and
  // neighbouring A families (client action, local variable, input parameter) share words with this theme (expression,
  // client, variable, local, literal, field, item, formula). None of them names a client entity, a client variable or
  // an expression literal, so none of these capabilities may be a direct match; on O11 (no front-B/C capability yet)
  // a hijacked word would make one of them the ONLY match.
  test(`[${lane}] intents of other fronts that share words with the theme do not select these capabilities`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of [
      'adicionar uma expressão na tela mostrando o nome do usuário',
      'add an expression widget on the screen showing the user name',
      'mudar a expressão de um widget de texto na tela',
      'create a client action that validates the form',
      'criar uma variável local do tipo texto',
      'create a local variable in the action',
      'formula para calcular o total',
      'adicionar um campo de texto no formulário',
      'show a list of items on the screen',
      'criar um setting para a URL da API',
      'consume a REST API and map the output to a structure',
      'change the value of an input parameter',
      'criar um cliente na base de dados',
    ]) {
      const a = await ask(lane, intent);
      assert.equal(a.ok, true, intent);
      const hit = direct(a).filter(m => OURS.includes(m.id)).map(m => `${m.id} why=${(m.why ?? []).join('|')}`);
      assert.deepEqual(hit, [], `[${lane}] "${intent}" selected ${hit.join('; ')}`);
    }
  });
}

test('lane differences of expressions are stated with their origin: 128 built-in functions on ODC, 121 and the UnknownFunction/Current hints (C# asserted) on O11; the Expression widget is front B; literal reads and a record literal field born from text are declared, not proven', { ...T, skip: (skip('odc') || skip('o11')) }, async () => {
  const xd = await full('odc', 'logic.expression'); const xo = await full('o11', 'logic.expression');
  assert.ok(xd.evidence.limits.some(l => /128 on ODC/.test(l.text) && /AGENTS\.md/.test(l.origin)), JSON.stringify(xd.evidence.limits));
  assert.ok(xd.evidence.limits.some(l => /virgin argument/.test(l.text) && /expression-literals/.test(l.origin)));
  assert.ok(xo.evidence.limits.some(l => /121 on O11/.test(l.text) && /functions-11\.55\.87\.json/.test(l.origin)), JSON.stringify(xo.evidence.limits));
  // C#-asserted Verify refusals cite their job as job:<name> (<TestClass>) (D-M2-3); the 'Hint Current' fact lives
  // here only (its owning capability), for every list shape the C# test covers.
  assert.ok(xo.evidence.limits.some(l => /UnknownFunction/.test(l.text) && /job:unknown-function \(FunctionCatalogTests\)/.test(l.origin)), JSON.stringify(xo.evidence.limits));
  const hint = xo.evidence.limits.find(l => /Hint Current/.test(l.text));
  assert.ok(hint, JSON.stringify(xo.evidence.limits));
  for (const job of ['structure-list-scope', 'aggregate-list-scope', 'aggregate-group-list-scope', 'dataaction-list-scope']) assert.ok(hint.origin.includes(`job:${job} (CurrentHintTests)`), `${job}: ${hint.origin}`);
  for (const x of [xd, xo]) assert.ok(x.evidence.limits.some(l => /Expression widget/.test(l.text) && /front B/.test(l.text) && /ownership\.json/.test(l.origin)), 'the Expression widget is stated as front B');
  // ui.screen exists on both lanes now: the Expression widget alternative is projected on both.
  for (const x of [xd, xo]) assert.ok((x.evidence.alternatives ?? []).some(r => r.id === 'ui.screen'), JSON.stringify(x.evidence.alternatives));
  // O11 has IRecordLiteralField without factory: the difference must not say the O11 API has no record literal at all.
  assert.ok(xo.evidence.limits.some(l => /IRecordLiteralField exists without factory/.test(l.text) && /inventario-reconciliado/.test(l.origin)));
  // Verify-message jobs without expectError are limits, never `negative` (D-M2-3).
  assert.deepEqual(xo.evidence.negative, []);
  nativeFromRuntime(xd, 'list literal item', 'OutSystems.Model.Expressions.IListLiteralItem');
  nativeFromRuntime(xd, 'record literal field', 'OutSystems.Model.Expressions.IRecordLiteralField');
  proofsOfThisLane('odc', xd); proofsOfThisLane('o11', xo);
  const field = xd.operations.create.roles['record literal field'];
  assert.equal(field.status, 'applicable');
  // No executed verb targets IRecordLiteralField, and the items are read only through a dump of the owning argument:
  // the cited job is current but verifies nothing on those roles, so the engine must not call them proven.
  for (const s of [field, xd.operations.read.roles['list literal item']]) {
    assert.ok(s.proofs.every(p => !p.verified), JSON.stringify(s.proofs));
    evidenceFollowsProofs(s, 'odc literal');
    assert.equal(s.evidence, 'declared-not-proven');
  }
  for (const x of [xd, xo]) for (const [op, o] of Object.entries(x.operations)) for (const [role, r] of Object.entries(o.roles)) if (['applicable', 'conditional'].includes(r.status)) evidenceFollowsProofs(r, `${op} ${role}`);
  assert.equal(xo.operations.create.roles['record literal field'].status, 'undetermined');
});

test('a record literal with fields (EN) selects logic.expression with the record literal field role in focus on both lanes', { ...T, skip: (skip('odc') || skip('o11')) }, async () => {
  for (const lane of ['odc', 'o11']) {
    const a = await ask(lane, 'record literal with two fields');
    withinBudget(a, lane);
    assert.deepEqual(pick(a, 'logic.expression').focus.roles, ['record literal field'], lane);
  }
});

test('a session variable is refused on ODC with its negative job (expectError) and data.client-variable as the alternative; O11 does not answer the ODC refusal', { ...T, skip: (skip('odc') || skip('o11')) }, async () => {
  const intent = 'criar uma variável de sessão';
  const d = await ask('odc', intent); const o = await ask('o11', intent);
  withinBudget(d, 'odc'); withinBudget(o, 'o11');
  const u = (d.unavailable ?? []).find(x => x.id === 'session-variable');
  assert.ok(u, JSON.stringify(d.unavailable));
  assert.deepEqual(u.negative, ['session-variable-not-in-odc']);
  assert.match(u.reason, /can't be children of App objects/);
  assert.match(u.alternative, /data\.client-variable/);
  const job = JSON.parse(fs.readFileSync(`${lanes.odc.negativeDir}/session-variable-not-in-odc.json`, 'utf8').replace(/^﻿/, ''));
  assert.ok(job.expectError?.some(e => /can't be children of App objects/.test(e)), 'the negative job declares the refusal it expects');
  assert.ok(!(o.unavailable ?? []).some(x => x.id === 'session-variable'), JSON.stringify(o.unavailable));
});

// Recall (round 3): two more natural intents per capability of this theme (Portuguese and English, wording not used by
// the tests above) select the capability as a DIRECT match on every lane where it exists. Only the selection is
// asserted here; the budget and the evidence are asserted by the tests above.
const RECALL_R3 = [
  ["criar uma entidade local para dados offline", "data.client-entity"],
  ["create a client entity for offline data", "data.client-entity"],
  ["criar uma variável de cliente para guardar o idioma", "data.client-variable"],
  ["add a client variable to keep the selected language", "data.client-variable"],
  ["criar um literal de lista com três itens", "logic.expression"],
  ["write a list literal with three items", "logic.expression"],
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
