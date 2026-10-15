// Front A, fragment logic-flow (catalog M1/M2): flow bodies of actions (Start/End, Assign and its assignments, If,
// Switch and its conditions, ForEach, execute server/client action, comments, and the node connectors themselves) and
// the edit of an EXISTING flow (splice, relink, delete mid-flow), through the PUBLIC discovery entry on both lanes:
// natural Portuguese and English intents select logic.flow directly and the focus names the element role; the lane
// differences answer with the declared status (Switch proven on ODC, undetermined on O11; a call inserted into an If
// branch proven headless by each lane's own stamped job, ODC TrueTarget and O11 FalseTarget, with the unknown-connector
// refusal on the If node; ListClear by a job on ODC only); the connector role stays declared (the engine attributes
// link and dumps to the source node / root);
// the natives resolve in each lane runtime; intents of other fronts that share words (If widget, UI flow, REST call,
// security role, process flow, database connector) never select logic.flow; every answer fits the 12000-byte budget.
// Needs the lane CLIs built (the index is built from them); skips otherwise.
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
const flowOf = a => { const f = direct(a).find(m => m.id === 'logic.flow'); assert.ok(f, JSON.stringify((a.matches ?? []).map(m => m.id + ':' + m.via))); return f; };
const skip = lane => !built(lane) && `${lane} CLI not built`;
const T = { timeout: 240000 };
const jobOf = (lane, name) => fs.existsSync(`${lanes[lane].jobsDir}/${name}.json`);
// A role statement's evidence follows the engine level of the jobs it cites: proven-current iff a cited proof is
// C-executed-current with the verb verified on the role's type; a C-suite proof (no stamped result) is never verified.
function followsProofs(r, label) {
  for (const p of r.proofs) if (p.level === 'C-suite') assert.equal(p.verified, undefined, `${label}: ${p.job} has no result`);
  if (r.status === 'undetermined') { assert.equal(r.evidence, 'undetermined', label); assert.deepEqual(r.proofs, [], label); return; }
  if (r.status === 'not-applicable') { assert.equal(r.evidence, r.negative.length ? 'refusal-proven' : 'refusal-declared', label); return; }
  const current = r.proofs.some(p => p.level === 'C-executed-current' && p.verified);
  const historical = r.proofs.some(p => p.level === 'C-executed-historical' && p.verified);
  assert.equal(r.evidence, current ? 'proven-current' : historical ? 'proven-historical' : 'declared-not-proven', `${label}: ${JSON.stringify(r.proofs)}`);
}

for (const lane of ['odc', 'o11']) {
  test(`[${lane}] inserting a call into an existing flow (Portuguese) selects logic.flow directly with focus on the server call node: set is proven by a stamped job of this lane, the splice order is stated without overstating the O11 read-back, and every proof is a job of this lane`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, 'inserir uma chamada de ação no meio de um fluxo existente');
    withinBudget(a, lane);
    const f = flowOf(a);
    assert.deepEqual(f.focus.roles, ['execute server action node'], JSON.stringify(f.focus));
    assert.deepEqual(f.focus.ops, ['set'], JSON.stringify(f.focus));
    assert.match(f.summary, /new->successor first \(keeps it addressable\), then predecessor->new/);
    const call = f.operations.set.roles['execute server action node'];
    assert.equal(call.status, 'applicable'); assert.equal(call.evidence, 'proven-current');
    assert.equal(f.operations.set.roles['assign node'].evidence, 'proven-current');
    // The connector refusal belongs to the If node's set statement (role level), not to the capability as a whole.
    assert.deepEqual(f.negative, [], JSON.stringify(f.negative));
    // The branch insertion is proven headless by this lane's own job and stated as such in the first limit (never as a
    // runtime behaviour, never as unproven).
    const first = (f.limits ?? [])[0]?.text ?? '';
    assert.match(first, lane === 'odc' ? /TrueTarget branch/ : /FalseTarget branch/); assert.match(first, /not runtime/);
    assert.doesNotMatch(first, /have not run|not proven|[Pp]roposed/);
    const x = (await expand(lane, 'logic.flow:operations+evidence')).expansions['logic.flow'];
    const ops = x.operations;
    const splice = ops.set.preconditions.find(p => /link new -> successor first/.test(p));
    assert.ok(splice && /read both back \(both lanes, into an If branch\)/.test(splice) && /O11 \(delete-data-consumers\) linked predecessor -> new first, with no read-back/.test(splice), JSON.stringify(ops.set.preconditions));
    assert.ok(ops.set.preconditions.some(p => /TrueTarget\|FalseTarget/.test(p) && /into an existing ForEach CycleTarget: no job/.test(p)));
    for (const [op, o] of Object.entries(ops)) for (const [role, r] of Object.entries(o.roles)) {
      for (const p of r.proofs ?? []) assert.ok(jobOf(lane, p.job), `${op}/${role}: ${p.job} is a job of the ${lane} suite`);
      if (r.status === 'undetermined') assert.deepEqual(r.proofs, [], `${op}/${role}: undetermined carries no proofs`);
      followsProofs(r, `${lane} ${op} ${role}`);
    }
    // The stamped cat-a-reset-typed-values of THIS lane proves, per role: the If node's branch repointed (set) and read
    // before/after, the call node created inside an inherited action, its Action/Target set and read back, the Assign
    // node and its assignments (one per typed output); each statement is proven-current with the verb verified.
    const cites = (op, role, job = 'cat-a-reset-typed-values') => {
      const r = ops[op].roles[role]; const p = r.proofs.find(q => q.job === job);
      assert.ok(p, `${op}/${role} cites ${job}: ${JSON.stringify(r.proofs)}`);
      assert.equal(p.level, 'C-executed-current', `${op}/${role}: ${job} level`); assert.ok(p.verified, `${op}/${role}: ${job} ran the verb on ${r.native}`);
      assert.equal(r.evidence, 'proven-current', `${op}/${role}`);
      return r;
    };
    const ifSet = cites('set', 'if node');
    assert.match(ifSet.scope, lane === 'odc' ? /TrueTarget repointed/ : /FalseTarget repointed/);
    assert.deepEqual(ifSet.negative.map(n => n.job), ['cat-a-link-unknown-connector']);
    assert.deepEqual(ifSet.negative[0].refuses, ["has no connector 'Then'", 'TrueTarget', 'FalseTarget']);
    assert.match(cites('create', 'execute server action node').scope, /If branch of an inherited action/);
    cites('set', 'execute server action node');
    cites('create', 'assign node'); cites('set', 'assignment');
    // Reading the If and the inserted call back is the only O11 read of an If node (undetermined before): cited there.
    // On ODC other stamped jobs already prove those reads, and the logic.flow expansion is at its default budget.
    if (lane === 'o11') { cites('read', 'if node'); cites('read', 'execute server action node'); cites('create', 'assignment'); }
    // ListClear from the compact language: an executed ODC job; on O11 only the C# unit contract (stated, never cited).
    if (lane === 'odc') {
      assert.match(cites('create', 'execute server action node', 'cat-a-list-clear').scope, /ListClear system call/);
      assert.ok((x.evidence?.limits ?? []).some(l => /mid-sequence splice is proven with an Assign/.test(l.text)), JSON.stringify(x.evidence?.limits));
    } else {
      assert.ok(!JSON.stringify(ops).includes('"job":"cat-a-list-clear"'), 'no O11 job for ListClear');
      assert.match(first, /ListClear: compact call only in unit contracts; raw in tickets-06-sla/);
    }
    // The connector itself stays declared: the engine attributes a link to its source node.
    assert.equal(ops.set.roles.connector.evidence, 'declared-not-proven');
  });

  test(`[${lane}] the focus names the child role: an assignment inserted into an existing flow`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, 'inserir uma atribuição no meio de um fluxo existente');
    withinBudget(a, lane);
    const f = flowOf(a);
    assert.deepEqual(f.focus.roles, ['assignment']); assert.deepEqual(f.focus.ops, ['set']);
    assert.equal(f.operations.set.roles.assignment.status, 'applicable');
    assert.equal(f.operations.set.roles.assignment.evidence, 'proven-current');
  });

  test(`[${lane}] deleting a call in the middle of a flow (natural Portuguese) is conditional: relink the predecessor first (proven by a stamped job of this lane; the precondition is declared, no refusal job)`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, 'apagar uma chamada de ação no meio do fluxo religando o predecessor');
    withinBudget(a, lane);
    const f = flowOf(a);
    // "no meio do fluxo" is an edit of an existing flow (set: the relink) and "apagar" the delete, which comes first.
    assert.deepEqual(f.focus.roles, ['execute server action node']); assert.deepEqual(f.focus.ops, ['delete', 'set']);
    const d = f.operations.delete.roles['execute server action node'];
    assert.equal(d.status, 'conditional'); assert.equal(d.evidence, 'proven-current');
    assert.deepEqual(f.negative, []);
    const ops = (await expand(lane, 'logic.flow:operations')).expansions['logic.flow'].operations;
    assert.ok(ops.delete.preconditions.some(p => /relink the predecessor/.test(p) && /no refusal job proves it/.test(p)), JSON.stringify(ops.delete.preconditions));
    assert.deepEqual(ops.delete.roles['execute server action node'].proofs.map(p => p.job), ['delete-data-consumers']);
    assert.deepEqual(ops.delete.roles['execute server action node'].negative, []);
  });

  test(`[${lane}] the focus names each node role from natural Portuguese (for each, comment, if, switch)`, { ...T, skip: skip(lane) }, async () => {
    for (const [intent, role] of [
      ['percorrer uma lista com for each no fluxo', 'for each node'],
      ['adicionar um comentário no fluxo ligado a um passo', 'comment node'],
      ['adicionar um if no fluxo da ação', 'if node'],
      ['criar um switch com otherwise', 'switch node'],
    ]) {
      const a = await ask(lane, intent);
      withinBudget(a, `${lane} ${intent}`);
      assert.deepEqual(flowOf(a).focus.roles, [role], intent);
    }
  });

  test(`[${lane}] the node connector is its own role: focused by name, stated per operation with its own evidence (declared: the engine attributes link to the source node and a dump to its root), and its native resolves in this lane runtime`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, 'religar o conector do fluxo para outro passo');
    withinBudget(a, lane);
    assert.deepEqual(flowOf(a).focus.roles, ['connector']);
    const x = (await expand(lane, 'logic.flow:operations+native')).expansions['logic.flow'];
    for (const op of ['read', 'create', 'set']) {
      const c = x.operations[op].roles.connector;
      assert.equal(c.native, 'OutSystems.Model.Logic.IActionConnector');
      assert.equal(c.status, 'applicable', op);
      assert.equal(c.evidence, 'declared-not-proven', `${op}: not attributed to the connector by the engine`);
      assert.match(c.verifiedQualified, /^no \(/, op);
      assert.ok(c.proofs.length > 0 && c.proofs.every(p => jobOf(lane, p.job)), `${op}: proofs are jobs of the ${lane} suite`);
      assert.match(c.scope, /declared/i, `${op}: the scope says it stays declared`);
    }
    assert.deepEqual(x.operations.create.roles.connector.proofs.map(p => p.job).length > 0, true);
    const del = x.operations.delete.roles.connector;
    assert.equal(del.status, 'undetermined'); assert.deepEqual(del.proofs, []);
    // Natives are checked against the lane runtime (provenance A-runtime), every role, the connector included.
    for (const n of x.native) {
      assert.equal(n.runtime?.provenance, 'A-runtime', `${n.role}: runtime provenance`);
      assert.notEqual(n.runtime?.found, false, `${n.role}: ${n.native} resolves in the ${lane} runtime`);
    }
    assert.ok(x.native.some(n => n.role === 'connector' && n.native === 'OutSystems.Model.Logic.IActionConnector'));
  });

  test(`[${lane}] English intents of the theme select logic.flow with the role focus and fit the budget (not insufficient)`, { ...T, skip: skip(lane) }, async () => {
    for (const [intent, role, ops] of [
      // ('insert a call to a server action ...' also selects the legacy ODC ui.form through "existing" and exceeds the
      // budget on ODC: reported to the integrator, not asserted here.)
      ['insert an execute server action node in the middle of an existing flow', 'execute server action node', ['set']],
      ['add an if node to the action flow', 'if node', ['create']],
      // the relink of the predecessor is a set, named after the delete
      ['delete an assign node in the middle of a flow and relink the predecessor', 'assign node', ['delete', 'set']],
    ]) {
      const a = await ask(lane, intent);
      withinBudget(a, `${lane} ${intent}`);
      const f = flowOf(a);
      assert.deepEqual(f.focus.roles, [role], intent); assert.deepEqual(f.focus.ops, ops, intent);
    }
  });

  test(`[${lane}] intents of other fronts that share words with the flow theme never select logic.flow directly`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of [
      'adicionar um widget If na tela',
      'add an If widget to the screen',
      'show a switch toggle in the form',
      'create a UI flow with two screens',
      'criar um fluxo de UI com duas telas',
      'call a consumed REST API method',
      'chamar um método de API REST consumida',
      'atribuir uma role ao usuário',
      'assign a role to the end user',
      'criar um processo BPT com fluxo de aprovação',
      'configure the connector of an external database',
      'tratar o erro de uma chamada REST',
      // round-3 critic: generic forms anchored to the action flow
      'fim do fluxo de aprovação do processo BPT',
      'node in the middle of the tree widget should be expanded',
      'switch case on the device type to change the CSS layout',
    ]) {
      const a = await ask(lane, intent);
      assert.equal(a.ok, true, intent);
      assert.ok(!direct(a).some(m => m.id === 'logic.flow'), `${lane}: "${intent}" must not select logic.flow (${direct(a).map(m => m.id).join(', ')})`);
    }
  });
}

test('lane difference answers with the declared status: a Switch is proven on ODC and undetermined on O11 (no O11 job); the O11 ForEach evidence follows the level of its jobs', { ...T, skip: (skip('odc') || skip('o11')) }, async () => {
  const intent = 'criar um switch com otherwise';
  const d = await ask('odc', intent); const o = await ask('o11', intent);
  withinBudget(d, 'odc'); withinBudget(o, 'o11');
  const fd = flowOf(d); const fo = flowOf(o);
  assert.deepEqual(fd.focus.roles, ['switch node']); assert.deepEqual(fo.focus.roles, ['switch node']);
  assert.ok(fd.focus.ops.includes('create') && fo.focus.ops.includes('create'));
  assert.equal(fd.operations.create.roles['switch node'].status, 'applicable');
  assert.equal(fd.operations.create.roles['switch node'].evidence, 'proven-current');
  assert.equal(fo.operations.create.roles['switch node'].status, 'undetermined');
  const xo = (await expand('o11', 'logic.flow:operations')).expansions['logic.flow'].operations;
  assert.equal(xo.create.roles['switch node'].otherLanes.odc.status, 'applicable');
  assert.deepEqual(xo.create.roles['switch node'].proofs, [], 'undetermined carries no proofs');
  const fe = xo.set.roles['for each node'];
  assert.equal(fe.status, 'applicable'); followsProofs(fe, 'o11 set for each node');
  const xd = (await expand('odc', 'logic.flow:operations')).expansions['logic.flow'].operations;
  assert.equal(xd.set.roles['for each node'].evidence, 'proven-current');
  // Every role statement of both lanes follows the level of the jobs it cites (no level pinned by the test: the O11
  // stamp list grows between campaigns).
  for (const [lane, ops] of [['odc', xd], ['o11', xo]]) for (const [op, o] of Object.entries(ops)) for (const [role, r] of Object.entries(o.roles)) followsProofs(r, `${lane} ${op} ${role}`);
  // The comment connector is created by `link` (declared verb); the engine finds no ledger entry for it on ODC.
  assert.equal(xd.create.roles['comment connector'].status, 'applicable');
  assert.equal(xd.create.roles['comment connector'].evidence, 'declared-not-proven');
  assert.match(xd.read.roles['comment connector'].scope, /op 21/);
});

// Recall (round 3): two more natural intents per capability of this theme (Portuguese and English, wording not used by
// the tests above) select the capability as a DIRECT match on every lane where it exists. Only the selection is
// asserted here; the budget and the evidence are asserted by the tests above.
const RECALL_R3 = [
  ["religar o predecessor antes de apagar o if do meio do fluxo", "logic.flow"],
  ["add an assign node after the start node of the action", "logic.flow"],
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
