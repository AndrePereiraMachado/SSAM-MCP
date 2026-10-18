// Front A, fragment logic-query (catalog M1): aggregates (aggregate node, screen aggregate, source, filter, sort, join,
// group by, aggregated and calculated columns) and SQL (SQL node, SQL input parameter, SQL output), through the PUBLIC
// discovery entry on both lanes: Portuguese and English intents select logic.aggregate / logic.sql directly, the focus
// names the role, the lane differences answer with the declared status (the aggregated column is a different native
// type per lane; every role's evidence follows the engine level of the jobs it cites; the compact aggregated columns
// are proven on ODC by the regression job of kernel commit 41fdaaa and stated per lane in the limits), every native is
// checked in the lane runtime (A-runtime),
// ordinary UI / integration / diagnostic intents that share a word with the theme do NOT select these capabilities, and
// every answer fits the 12000-byte budget. Needs the lane CLIs built (the index is built from them); skips otherwise.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireBytes } from './fixtures/answer-wire.mjs';
import fs from 'node:fs';
import { laneSources, discover } from '../discovery.mjs';

const lanes = { odc: laneSources('odc'), o11: laneSources('o11') };
const built = lane => fs.existsSync(lanes[lane].cli);
const bytesOf = a => Buffer.byteLength(JSON.stringify(a), 'utf8');
const direct = a => (a.matches ?? []).filter(m => m.via === 'match');
const asked = new Map();
const ask = (lane, intent) => { const k = lane + '\u0000' + intent; if (!asked.has(k)) asked.set(k, discover({ lane, intent, sources: lanes[lane], budgetBytes: 12000 })); return asked.get(k); };
const expanded = new Map();
const expansion = (lane, id) => { const k = lane + '\u0000' + id; if (!expanded.has(k)) expanded.set(k, discover({ lane, expand: `${id}:operations+native+evidence`, sources: lanes[lane], budgetBytes: 400000 }).then(r => r.expansions[id])); return expanded.get(k); };
function withinBudget(a, label) {
  assert.equal(a.ok, true, label + ': ' + (a.error ?? ''));
  assert.ok(wireBytes(a, { budgetBytes: 12000 }) <= 12000, `${label}: hard budget, ${bytesOf(a)} bytes`);
  assert.notEqual(a.size.status, 'insufficient', `${label}: ${JSON.stringify(a.size)}`);
}
const ids = a => JSON.stringify((a.matches ?? []).map(m => m.id + ':' + m.via));
const matchOf = (a, id) => { const f = direct(a).find(m => m.id === id); assert.ok(f, `${id} not a direct match: ` + ids(a)); return f; };
// The capability is the FIRST direct match (not only present somewhere in the list).
const firstMatch = (a, id) => { assert.equal(direct(a)[0]?.id, id, `${id} is not the first direct match: ` + ids(a)); return direct(a)[0]; };
const skip = lane => !built(lane) && `${lane} CLI not built`;
const both = () => skip('odc') || skip('o11');
// A role statement's evidence follows the engine level of the jobs it cites (never a level pinned by the test: the O11
// stamp list grows between campaigns): proven-current iff a cited proof is C-executed-current with the verb verified on
// the role's type; a C-suite proof never carries a verification.
function followsProofs(r, label) {
  for (const p of r.proofs) if (p.level === 'C-suite') assert.equal(p.verified, undefined, `${label}: ${p.job} has no result`);
  if (r.status === 'undetermined') { assert.equal(r.evidence, 'undetermined', label); assert.deepEqual(r.proofs, [], label); return; }
  if (r.status === 'not-applicable') { assert.equal(r.evidence, r.negative.length ? 'refusal-proven' : 'refusal-declared', label); return; }
  const current = r.proofs.some(p => p.level === 'C-executed-current' && p.verified);
  const historical = r.proofs.some(p => p.level === 'C-executed-historical' && p.verified);
  assert.equal(r.evidence, current ? 'proven-current' : historical ? 'proven-historical' : 'declared-not-proven', `${label}: ${JSON.stringify(r.proofs)}`);
}
const T = { timeout: 480000 };
// Every job cited by any role of this lane belongs to this lane's suite (no proof borrowed from the other lane).
function ownSuite(x, lane) {
  for (const [op, o] of Object.entries(x.operations)) for (const [role, r] of Object.entries(o.roles)) for (const p of r.proofs ?? []) assert.ok(fs.existsSync(`${lanes[lane].jobsDir}/${p.job}.json`), `${op}/${role}: ${p.job} is a job of the ${lane} suite`);
}
// Every native of the capability was checked in the lane runtime (Model API of the installed Studio) and found there.
function runtimeChecked(x, lane) {
  for (const n of x.native) {
    assert.equal(n.runtime?.provenance, 'A-runtime', `${lane} ${n.role}: ${JSON.stringify(n.runtime)}`);
    assert.notEqual(n.runtime.found, false, `${lane} ${n.role}: ${n.native} not found in the runtime`);
    assert.equal(typeof n.runtime.ideVersion, 'string', `${lane} ${n.role}: runtime IDE version`);
  }
}

for (const lane of ['odc', 'o11']) {
  test(`[${lane}] an aggregate with a join and a group by (PT and EN) selects logic.aggregate first; the focus names the join and group by roles`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of ['agregado com junção e agrupamento por cliente', 'aggregate with a left join and a group by']) {
      const a = await ask(lane, intent);
      withinBudget(a, `${lane} ${intent}`);
      assert.deepEqual(firstMatch(a, 'logic.aggregate').focus.roles, ['join', 'group by'], intent);
    }
    const x = await expansion(lane, 'logic.aggregate');
    ownSuite(x, lane); runtimeChecked(x, lane);
    // The aggregate node and its filter are created by stamped jobs on both lanes.
    for (const role of ['aggregate', 'filter', 'source']) assert.equal(x.operations.create.roles[role].evidence, 'proven-current', `${lane} create ${role}`);
    // The join is stamped on ODC; on O11 its evidence is whatever the engine reads from the cited suite jobs (a job
    // without a stamped result is declared, never shown as current).
    const join = x.operations.create.roles.join;
    assert.equal(join.status, 'applicable');
    if (lane === 'odc') assert.equal(join.evidence, 'proven-current');
    followsProofs(join, `${lane} create join`);
    for (const [op, o] of Object.entries(x.operations)) for (const [role, r] of Object.entries(o.roles)) followsProofs(r, `${lane} ${op} ${role}`);
    // A group by is never read by a get on either lane: undetermined, with no proofs.
    assert.equal(x.operations.read.roles['group by'].status, 'undetermined');
    assert.deepEqual(x.operations.read.roles['group by'].proofs, []);
  });
}

test('lane difference: the aggregated column is IAggregatedAttribute on ODC and IAggregateAttribute on O11 (both found in their runtime); stamped on ODC by the raw route, compact columns stated as an ODC limit', { ...T, skip: both() }, async () => {
  const intent = 'coluna agregada com a soma do total por cliente';
  const d = await ask('odc', intent); const o = await ask('o11', intent);
  withinBudget(d, 'odc'); withinBudget(o, 'o11');
  assert.deepEqual(firstMatch(d, 'logic.aggregate').focus.roles, ['aggregated column']);
  assert.deepEqual(firstMatch(o, 'logic.aggregate').focus.roles, ['aggregated column']);
  const xd = await expansion('odc', 'logic.aggregate'); const xo = await expansion('o11', 'logic.aggregate');
  const nd = xd.native.find(n => n.role === 'aggregated column'); const no = xo.native.find(n => n.role === 'aggregated column');
  assert.equal(nd.native, 'OutSystems.Model.Logic.Aggregates.IAggregatedAttribute'); assert.equal(nd.runtime?.provenance, 'A-runtime'); assert.notEqual(nd.runtime.found, false);
  assert.equal(no.native, 'OutSystems.Model.Logic.Aggregates.IAggregateAttribute'); assert.equal(no.runtime?.provenance, 'A-runtime'); assert.notEqual(no.runtime.found, false);
  assert.notEqual(nd.runtime.ideVersion, no.runtime.ideVersion, 'each lane is checked in its own runtime');
  const dc = xd.operations.create.roles['aggregated column'];
  assert.equal(dc.evidence, 'proven-current');
  assert.deepEqual(dc.proofs.map(p => p.job), ['aggregate-full', 'structure-list-type', 'logic-aggregate-columns']);
  assert.ok(dc.proofs.every(p => p.verified?.verbs?.includes('create')), JSON.stringify(dc.proofs));
  // The compact route (kernel commit 41fdaaa) is proven on ODC by its regression job, on the group by role too.
  assert.ok(xd.operations.create.roles['group by'].proofs.some(p => p.job === 'logic-aggregate-columns' && p.level === 'C-executed-current' && p.verified?.verbs?.includes('create')), JSON.stringify(xd.operations.create.roles['group by'].proofs));
  const oc = xo.operations.create.roles['aggregated column'];
  assert.equal(oc.status, 'applicable'); followsProofs(oc, 'o11 create aggregated column');
  assert.ok(!oc.proofs.some(p => p.job === 'logic-aggregate-columns'), 'the ODC regression job is never borrowed by O11');
  // The compact columns route is stated per lane with the kernel commit as origin: the ODC regression job on ODC, the
  // unit contracts only on O11; no lane keeps the old "suspected defect" wording.
  const dl = (xd.evidence.limits ?? []).find(l => /Compact get `columns`/.test(l.text));
  assert.ok(dl && /IAggregatedAttribute/.test(dl.text) && /41fdaaa/.test(dl.origin) && /job:logic-aggregate-columns/.test(dl.origin), JSON.stringify(xd.evidence.limits));
  const ol = (xo.evidence.limits ?? []).find(l => /Compact get `columns`/.test(l.text));
  assert.ok(ol && /IAggregateAttribute/.test(ol.text) && /41fdaaa/.test(ol.origin) && /contract tests only/.test(ol.text) && !/logic-aggregate-columns/.test(ol.origin), JSON.stringify(xo.evidence.limits));
  for (const l of [...xd.evidence.limits, ...xo.evidence.limits]) assert.ok(!/suspect|hypothes|not reproduced/i.test(l.text), l.text);
});

for (const lane of ['odc', 'o11']) {
  test(`[${lane}] an SQL query with an input parameter (PT and EN) selects logic.sql first; create is proven by a stamped job of this lane and sql:true refusals are stated limits`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of ['consulta SQL com parâmetro de entrada', 'sql query with an input parameter']) {
      const a = await ask(lane, intent);
      withinBudget(a, `${lane} ${intent}`);
      assert.deepEqual(firstMatch(a, 'logic.sql').focus.roles, ['sql input parameter'], intent);
    }
    const en = await ask(lane, 'advanced sql with a sql parameter and a sql output');
    withinBudget(en, lane);
    assert.deepEqual(firstMatch(en, 'logic.sql').focus.roles, ['sql input parameter', 'sql output']);
    const x = await expansion(lane, 'logic.sql');
    ownSuite(x, lane); runtimeChecked(x, lane);
    for (const role of ['sql', 'sql input parameter', 'sql output']) assert.equal(x.operations.create.roles[role].evidence, 'proven-current', `${lane} create ${role}`);
    assert.equal(x.native.find(n => n.role === 'sql output').native, 'OutSystems.Model.Logic.ISQLOutput');
    assert.equal(x.operations.rename.roles.sql.status, 'undetermined');
    assert.ok((x.evidence.limits ?? []).some(l => /sql:true/.test(l.text) && /LogicExpander\.cs:448-450/.test(l.origin)), JSON.stringify(x.evidence.limits));
    // No SQL refusal job declares expectError: logic.sql has no negative on either lane (D-M2-3).
    assert.deepEqual(x.evidence.negative, []);
    if (lane === 'o11') {
      // The O11 refusals asserted only by C# tests / expectValid:false are limits with their origin, not negatives.
      assert.ok(x.evidence.limits.some(l => /job:sql-unknown-param \(SqlContractTests\)/.test(l.origin)), JSON.stringify(x.evidence.limits));
      assert.ok(x.evidence.limits.some(l => /Current has: List/.test(l.text) && /PerformanceContractTests\.cs/.test(l.origin)), JSON.stringify(x.evidence.limits));
    }
    // Every role statement follows the level of the jobs it cites.
    for (const [op, o] of Object.entries(x.operations)) for (const [role, r] of Object.entries(o.roles)) followsProofs(r, `${lane} ${op} ${role}`);
  });
}

test('unsupported case: a calculated column is created on both lanes but never read by a get (undetermined); on ODC being outside the grouped row is a declared limit', { ...T, skip: both() }, async () => {
  const intent = 'coluna calculada no agregado';
  const d = await ask('odc', intent); const o = await ask('o11', intent);
  withinBudget(d, 'odc'); withinBudget(o, 'o11');
  assert.deepEqual(firstMatch(d, 'logic.aggregate').focus.roles, ['calculated column']);
  assert.deepEqual(firstMatch(o, 'logic.aggregate').focus.roles, ['calculated column']);
  const xd = await expansion('odc', 'logic.aggregate'); const xo = await expansion('o11', 'logic.aggregate');
  for (const x of [xd, xo]) { const r = x.operations.read.roles['calculated column']; assert.equal(r.status, 'undetermined'); assert.deepEqual(r.proofs, []); }
  assert.equal(xd.operations.create.roles['calculated column'].evidence, 'proven-current');
  followsProofs(xo.operations.create.roles['calculated column'], 'o11 create calculated column');
  assert.equal(xo.operations.create.roles['calculated column'].otherLanes.odc.status, 'applicable');
  assert.ok((xd.evidence.limits ?? []).some(l => /^Declared, not read/.test(l.text) && /grouped row/.test(l.text) && /structure-list-type/.test(l.origin)), JSON.stringify(xd.evidence.limits));
  // The Verify 'Hint Current' (asserted by C# tests, origin job:<name> (<TestClass>)) lives once, in logic.expression;
  // the only aggregate negative is a refusal job with expectError.
  assert.ok(!xo.evidence.limits.some(l => /Hint Current/.test(l.text)), JSON.stringify(xo.evidence.limits));
  const xe = (await discover({ lane: 'o11', expand: 'logic.expression:evidence', sources: lanes.o11, budgetBytes: 400000 })).expansions['logic.expression'];
  assert.ok(xe.evidence.limits.some(l => /Hint Current/.test(l.text) && /job:aggregate-list-scope \(CurrentHintTests\)/.test(l.origin)), JSON.stringify(xe.evidence.limits));
  assert.deepEqual(xo.evidence.negative.map(n => n.job), ['delete-attribute-in-use']);
  assert.ok(xo.evidence.negative.every(n => n.expectError?.length), 'every negative declares expectError');
});

test('a filtered query selects logic.aggregate on both lanes with the filter role in focus; the aggregate recommends ui.screen on both lanes', { ...T, skip: both() }, async () => {
  for (const lane of ['odc', 'o11']) {
    const a = await ask(lane, 'carregar dados com uma consulta filtrada por status');
    withinBudget(a, lane);
    assert.deepEqual(matchOf(a, 'logic.aggregate').focus.roles, ['filter'], lane);
  }
  const intent = 'aggregate with a filter and a sort by name';
  const d = await ask('odc', intent); const o = await ask('o11', intent);
  // On ODC the legacy UI capabilities (search/list/form vocabulary) also match and the answer does not fit 12000
  // bytes (integrator request); O11 fits.
  assert.equal(d.ok, true); withinBudget(o, 'o11');
  assert.deepEqual(firstMatch(d, 'logic.aggregate').focus.roles, ['filter', 'sort']);
  assert.deepEqual(firstMatch(o, 'logic.aggregate').focus.roles, ['filter', 'sort']);
  const agregado = await ask('odc', 'agregado com filtro e ordenação'); const agregadoO11 = await ask('o11', 'agregado com filtro e ordenação');
  withinBudget(agregado, 'odc'); withinBudget(agregadoO11, 'o11');
  assert.ok(!direct(agregado).some(m => m.id === 'ui.screen'), ids(agregado));
  assert.ok(agregado.composition.recommended.some(r => r.id === 'ui.screen' && r.by === 'logic.aggregate'), JSON.stringify(agregado.composition.recommended));
  assert.ok(!direct(agregadoO11).some(m => m.id === 'ui.screen'), ids(agregadoO11));
  assert.ok(agregadoO11.composition.recommended.some(r => r.id === 'ui.screen' && r.by === 'logic.aggregate'), 'ui.screen now exists on O11: the aggregate recommends it on both lanes');
});

// Hijack guard: intents of other fronts (typography, UI grouping, diagnostics, deployment, references, UI tables,
// arithmetic in an action) share a word with the theme (fonte/font, agrupar/group, filtrar/filter, source/origem,
// coluna/column, soma/sum, statement). None may select these capabilities directly; O11 has no front-B/C capability,
// so a hijacked word there would make a front-A capability the only match.
const hijacks = [
  'mudar a fonte do texto do título na tela', 'change the font of the title text',
  'agrupar os botões num container', 'group the buttons in a container',
  'filtrar os logs do servidor por data', 'filter the server logs by date',
  'deploy from the source environment', 'módulo de origem da referência',
  'adicionar uma coluna na tabela da tela', 'add a column to the table widget',
  'somar dois números numa action', 'sum two numbers in an action',
  'ordenar os atributos da entidade', 'count of orders per customer',
];
for (const lane of ['odc', 'o11']) {
  test(`[${lane}] hijack guard: unrelated intents that share a word with aggregates/SQL do not select logic.aggregate or logic.sql`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of hijacks) {
      const a = await ask(lane, intent);
      assert.equal(a.ok, true, intent);
      for (const id of ['logic.aggregate', 'logic.sql']) assert.ok(!direct(a).some(m => m.id === id), `[${lane}] "${intent}" selected ${id}: ${ids(a)}`);
    }
    // "statement" alone never selects logic.sql through this fragment (on ODC the legacy lane synonym sql:[statement]
    // still maps it: integrator request); O11 has only the fragment vocabulary.
    const ifStatement = await ask(lane, 'add an if statement in the flow');
    assert.ok(!direct(ifStatement).some(m => m.id === 'logic.aggregate'), ids(ifStatement));
    if (lane === 'o11') assert.ok(!direct(ifStatement).some(m => m.id === 'logic.sql'), ids(ifStatement));
  });
}

// Recall (round 3): two more natural intents per capability of this theme (Portuguese and English, wording not used by
// the tests above) select the capability as a DIRECT match on every lane where it exists. Only the selection is
// asserted here; the budget and the evidence are asserted by the tests above.
const RECALL_R3 = [
  ["criar um agregado com filtro e ordenação", "logic.aggregate"],
  ["add a screen aggregate with a join between two entities", "logic.aggregate"],
  ["usar uma consulta SQL avançada com parâmetro", "logic.sql"],
  ["write an advanced SQL query that returns a list", "logic.sql"],
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
