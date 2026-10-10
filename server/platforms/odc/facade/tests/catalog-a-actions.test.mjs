// Front A, fragment logic-actions (catalog M1): actions by context (server, service, client, screen, data action,
// preparation) and their typed variables (inputs, outputs, locals, call arguments), through the PUBLIC discovery
// entry on both lanes: Portuguese and English intents select the capability directly, the focus names the element
// role, the lane differences answer with the declared status (refusal proven on one lane, undetermined on the other;
// a Traditional Web preparation exists only on O11), intents of other fronts that share words with this theme (input
// widget, REST parameter, web service, client variable, local storage) do NOT select these capabilities, and every
// answer fits the 12000-byte budget. Needs the lane CLIs built (the index is built from them); skips otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { laneSources, discover } from '../discovery.mjs';

const lanes = { odc: laneSources('odc'), o11: laneSources('o11') };
const built = lane => fs.existsSync(lanes[lane].cli);
const bytesOf = a => Buffer.byteLength(JSON.stringify(a), 'utf8');
const direct = a => (a.matches ?? []).filter(m => m.via === 'match');
const ask = (lane, intent) => discover({ lane, intent, sources: lanes[lane], budgetBytes: 12000 });
const expand = (lane, what) => discover({ lane, expand: what, sources: lanes[lane], budgetBytes: 200000 });
const list = a => JSON.stringify((a.matches ?? []).map(m => m.id + ':' + m.via));
function withinBudget(a, label) {
  assert.equal(a.ok, true, label + ': ' + (a.error ?? ''));
  assert.ok(bytesOf(a) <= 12000 && a.size.bytes <= 12000, `${label}: hard budget, ${bytesOf(a)} bytes`);
  assert.notEqual(a.size.status, 'insufficient', `${label}: ${JSON.stringify({ minimalBytes: a.size.minimalBytes })}`);
}
const skip = lane => !built(lane) && `${lane} CLI not built`;
const T = { timeout: 240000 };
// A role statement's evidence follows the engine level of the jobs it cites, never a level pinned by the test (the O11
// stamp list grows between campaigns): proven-current iff a cited proof is C-executed-current with the verb verified on
// the role's type; a C-suite proof (no stamped result) never carries a verification.
function followsProofs(r, label) {
  for (const p of r.proofs) if (p.level === 'C-suite') assert.equal(p.verified, undefined, `${label}: ${p.job} has no result`);
  if (r.status === 'undetermined') { assert.equal(r.evidence, 'undetermined', label); assert.deepEqual(r.proofs, [], label); return; }
  if (r.status === 'not-applicable') { assert.equal(r.evidence, r.negative.length ? 'refusal-proven' : 'refusal-declared', label); return; }
  const current = r.proofs.some(p => p.level === 'C-executed-current' && p.verified);
  const historical = r.proofs.some(p => p.level === 'C-executed-historical' && p.verified);
  assert.equal(r.evidence, current ? 'proven-current' : historical ? 'proven-historical' : 'declared-not-proven', `${label}: ${JSON.stringify(r.proofs)}`);
}
const allFollow = (x, label) => { for (const [op, o] of Object.entries(x.operations)) for (const [role, r] of Object.entries(o.roles)) followsProofs(r, `${label} ${op} ${role}`); };
const fragment = JSON.parse(fs.readFileSync(new URL('../catalog/fragments/A/logic-actions.json', import.meta.url), 'utf8').replace(/^﻿/, ''));
const OURS = ['logic.server-action', 'logic.service-action', 'logic.client-action', 'logic.screen-action', 'logic.data-action', 'logic.preparation', 'logic.variable'];

for (const lane of ['odc', 'o11']) {
  test(`[${lane}] a Portuguese intent about an action's parameters selects logic.variable and logic.server-action directly, focused on the named roles`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, 'adicionar um parâmetro de entrada a uma ação de servidor e mudar o tipo da variável local');
    withinBudget(a, lane);
    const ids = direct(a).map(m => m.id);
    assert.ok(ids.includes('logic.variable') && ids.includes('logic.server-action'), list(a));
    const v = direct(a).find(m => m.id === 'logic.variable');
    assert.deepEqual(v.focus.roles, ['input parameter', 'local variable']);
    assert.ok(v.focus.ops.includes('create'), JSON.stringify(v.focus));
    assert.equal(v.operations.create.roles['input parameter'].status, 'applicable');
    assert.equal(v.operations.create.roles['input parameter'].evidence, 'proven-current', 'a stamped job of this lane creates an input parameter');
    assert.equal(v.operations.create.roles.argument.status, 'undetermined', 'an argument is created by the platform, never declared applicable');
    const s = direct(a).find(m => m.id === 'logic.server-action');
    assert.deepEqual(s.focus.roles, ['server action']);
    assert.equal(s.operations.create.roles['server action'].status, 'applicable');
    // The whole statement (reduced away from the 12000-byte answer) cites only jobs of this lane's suites.
    const ops = (await expand(lane, 'logic.server-action:operations')).expansions['logic.server-action'].operations;
    for (const [op, o] of Object.entries(ops)) for (const p of o.roles['server action'].proofs ?? []) assert.ok(fs.existsSync(`${lanes[lane].jobsDir}/${p.job}.json`), `${op}: ${p.job} is a job of the ${lane} suite`);
    assert.equal(ops.create.roles['server action'].evidence, 'proven-current');
  });

  test(`[${lane}] the focus names one variable role and the action context: renaming a local variable of a client action`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, 'renomear a variável local de uma ação de cliente');
    withinBudget(a, lane);
    const v = direct(a).find(m => m.id === 'logic.variable'); const c = direct(a).find(m => m.id === 'logic.client-action');
    assert.ok(v && c, list(a));
    assert.deepEqual(v.focus.roles, ['local variable']); assert.deepEqual(v.focus.ops, ['rename']);
    assert.deepEqual(c.focus.roles, ['client action']); assert.deepEqual(c.focus.ops, ['rename']);
    assert.equal(v.operations.rename.roles['local variable'].evidence, 'proven-current');
  });

  test(`[${lane}] deleting a server action that still has callers is conditional, with the refusal job of this lane (PT and EN)`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of ['apagar uma ação de servidor que ainda tem chamadores', 'delete a server action that still has callers']) {
      const a = await ask(lane, intent);
      withinBudget(a, `${lane} ${intent}`);
      const s = direct(a).find(m => m.id === 'logic.server-action'); assert.ok(s, list(a));
      assert.deepEqual(s.focus.ops, ['delete']);
      const d = s.operations.delete.roles['server action'];
      assert.equal(d.status, 'conditional');
      assert.equal(d.evidence, 'proven-current', 'a stamped job of this lane deletes a server action after its callers left');
      assert.deepEqual(d.negative.map(n => n.job), [lane === 'odc' ? 'delete-logic-in-use' : 'delete-action-in-use']);
      assert.ok(d.negative[0].refuses.includes('delete: refused'), JSON.stringify(d.negative));
    }
  });

  test(`[${lane}] English intents of the theme: a data action fetched on demand, and a local variable of a server action`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, 'create a data action that fetches on demand');
    withinBudget(a, `${lane} data action`);
    const da = direct(a).find(m => m.id === 'logic.data-action'); assert.ok(da, list(a));
    assert.deepEqual(da.focus.roles, ['data action']); assert.ok(da.focus.ops.includes('create'));
    assert.equal(da.operations.create.roles['data action'].status, 'applicable');
    followsProofs(da.operations.create.roles['data action'], `${lane} create data action`);
    if (lane === 'odc') assert.equal(da.operations.create.roles['data action'].evidence, 'proven-current');
    const b = await ask(lane, 'rename a local variable of a server action');
    withinBudget(b, `${lane} local variable`);
    const v = direct(b).find(m => m.id === 'logic.variable'); assert.ok(v && direct(b).some(m => m.id === 'logic.server-action'), list(b));
    assert.deepEqual(v.focus.roles, ['local variable']); assert.deepEqual(v.focus.ops, ['rename']);
    assert.equal(v.operations.rename.roles['local variable'].evidence, 'proven-current');
  });

  test(`[${lane}] a Data Action takes no input parameter: the declared absence answers beside the capabilities`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of ['adicionar um parâmetro de entrada a uma ação de dados', 'add an input parameter to a data action']) {
      const a = await ask(lane, intent);
      assert.equal(a.ok, true);
      assert.ok((a.unavailable ?? []).some(u => u.id === 'data-action-inputs'), `${intent}: ${JSON.stringify(a.unavailable)}`);
      assert.ok(direct(a).some(m => m.id === 'logic.data-action'), list(a));
    }
    // The limit is stated by the Model API contract of the native type, loaded from this lane's runtime.
    const x = (await expand(lane, 'logic.data-action:native+evidence')).expansions['logic.data-action'];
    const n = x.native.find(k => k.role === 'data action');
    assert.equal(n.native, 'OutSystems.Model.UI.Mobile.IDataAction'); assert.equal(n.runtime?.provenance, 'A-runtime');
  });

  // The typed inventory and its reset: cat-a-reset-typed-values of THIS lane (stamped) declares 16 outputs of 14 data
  // types and record/structure/list locals by compact logic, dumps them and reads one back, resets all but two in one
  // Assign, and calls the new action from an If branch of an inherited action (its only consumer). Each statement below
  // is proven-current with the verb verified on the role's own type; the reset values are stated as what the Verify
  // accepted headless, never as runtime behaviour.
  test(`[${lane}] typed variables and their reset: output parameters, locals and call arguments cite this lane's stamped cat-a-reset-typed-values; the reset values are a headless statement`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, lane === 'odc' ? 'criar variáveis de tipos diferentes numa server action' : 'declare variables of different data types in a server action');
    withinBudget(a, lane);
    assert.ok(direct(a).some(m => m.id === 'logic.variable'), list(a));
    const v = (await expand(lane, 'logic.variable:operations+evidence')).expansions['logic.variable'];
    allFollow(v, lane);
    const cites = (op, role) => { const r = v.operations[op].roles[role]; const p = r.proofs.find(q => q.job === 'cat-a-reset-typed-values'); assert.ok(p && p.level === 'C-executed-current' && p.verified, `${op}/${role}: ${JSON.stringify(r.proofs)}`); assert.equal(r.evidence, 'proven-current', `${op}/${role}`); return r; };
    assert.match(cites('create', 'output parameter').scope, /14 data types/);
    assert.match(cites('set', 'output parameter').scope, /DataType of 14 types/);
    assert.match(cites('create', 'local variable').scope, /record, a structure and lists/);
    cites('set', 'local variable'); cites('read', 'output parameter'); cites('create', 'input parameter'); cites('set', 'argument');
    const reset = (v.evidence?.limits ?? []).find(l => /Reset values/.test(l.text));
    assert.ok(reset && /headless, not runtime/.test(reset.text) && /NullDate\(\)/.test(reset.text) && /#00:00:00#/.test(reset.text) && /NullIdentifier\(\)/.test(reset.text) && /never-assigned local/.test(reset.text), JSON.stringify(v.evidence?.limits));
    assert.match(reset.origin, /cat-a-reset-typed-values/);
    const s = (await expand(lane, 'logic.server-action:operations')).expansions['logic.server-action'].operations;
    for (const op of ['create', 'usages']) { const r = s[op].roles['server action']; const p = r.proofs.find(q => q.job === 'cat-a-reset-typed-values'); assert.ok(p?.verified && p.level === 'C-executed-current', `${op}: ${JSON.stringify(r.proofs)}`); }
    assert.match(s.usages.roles['server action'].scope, /only consumer is the call inserted into an If branch/);
    // ListClear: a stamped ODC job; no O11 job (only the C# unit contract, stated by logic.flow).
    const listClear = s.create.roles['server action'].proofs.some(p => p.job === 'cat-a-list-clear');
    assert.equal(listClear, lane === 'odc');
  });

  // Hijack guard: intents of front B (widgets, screens), front C (REST, web services, settings) and client storage share
  // words with this theme (input, output, parameter, call, service, client, local, screen). None of them names an
  // action or an action variable, so none of these capabilities may be a direct match; on O11 (no front-B/C capability
  // yet) a hijacked word would make one of them the ONLY match.
  test(`[${lane}] intents of other fronts that share words with the theme do not select these capabilities`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of [
      'mudar o texto de entrada de um input da tela',
      'change the label of a text input widget on a screen',
      'call a REST method with a query parameter',
      'consumir uma API REST e mapear a saída para uma estrutura',
      'consume an external web service',
      'create a client variable to keep the language',
      'store data in local storage',
      'criar uma tela de lista de produtos',
      // round-3 critic: a bare "reset variables" form is not an action's typed inventory
      'resetar variáveis de ambiente do servidor de produção',
    ]) {
      const a = await ask(lane, intent);
      assert.equal(a.ok, true, intent);
      const hit = direct(a).filter(m => OURS.includes(m.id)).map(m => `${m.id} why=${(m.why ?? []).join('|')}`);
      assert.deepEqual(hit, [], `[${lane}] "${intent}" selected ${hit.join('; ')}`);
    }
  });
}

test('lane differences answer with the declared status: screen action reorder (O11 refusal proven, ODC undetermined), client action rename (ODC rewrites <Node>.<Output>, O11 does not), Traditional Web screen action and preparation (O11 only)', { ...T, skip: (skip('odc') || skip('o11')) }, async () => {
  const intent = 'reordenar as ações de tela de uma tela';
  const o = await ask('o11', intent); const d = await ask('odc', intent);
  withinBudget(o, 'o11'); withinBudget(d, 'odc');
  const so = direct(o).find(m => m.id === 'logic.screen-action'); const sd = direct(d).find(m => m.id === 'logic.screen-action');
  assert.ok(so && sd); assert.deepEqual(so.focus.ops, ['move']); assert.deepEqual(sd.focus.ops, ['move']);
  // The answer states status and evidence (front B's ui.screen is also direct on O11 now, so the answer is reduced);
  // the refusal job and the other lane's status are read from the full statement.
  const mo = so.operations.move.roles['screen action'];
  assert.equal(mo.status, 'not-applicable'); assert.equal(mo.evidence, 'refusal-proven');
  const mx = (await expand('o11', 'logic.screen-action:operations')).expansions['logic.screen-action'].operations.move.roles['screen action'];
  assert.deepEqual(mx.negative.map(n => n.job), ['move-not-a-sequence']);
  assert.equal(mx.otherLanes.odc.status, 'undetermined');
  assert.equal(sd.operations.move.roles['screen action'].status, 'undetermined'); assert.deepEqual(sd.focus.roles, ['screen action']);
  // Renaming a client action output: proven current on both lanes by that lane's own job; the lane difference is stated
  // for the client action (the only role on which it was measured), not for the server action.
  const vo = (await expand('o11', 'logic.variable:operations')).expansions['logic.variable'].operations.rename.roles['output parameter'];
  const vd = (await expand('odc', 'logic.variable:operations')).expansions['logic.variable'].operations.rename.roles['output parameter'];
  assert.equal(vo.evidence, 'proven-current'); assert.equal(vd.evidence, 'proven-current');
  assert.ok(vo.proofs.every(p => fs.existsSync(`${lanes.o11.jobsDir}/${p.job}.json`)) && vd.proofs.every(p => fs.existsSync(`${lanes.odc.jobsDir}/${p.job}.json`)));
  for (const lane of ['odc', 'o11']) {
    const sx = (await expand(lane, 'logic.server-action:operations')).expansions['logic.server-action'].operations.rename.roles['server action'];
    assert.equal(sx.evidence, 'proven-current');
    assert.doesNotMatch(sx.scope, /<Node>\.<Output> expressions (are|is) (NOT )?rewritten/, `${lane}: no <Node>.<Output> claim borrowed from the client action`);
    // The rename difference lives in its owning capability (logic.client-action; refactor.rename carries the report):
    // logic.variable states it only in its own role scope, never as a limit or a lane difference.
    const capOf = id => fragment.capabilities.find(c => c.id === id).platforms[lane];
    const vp = capOf('logic.variable');
    assert.ok(![...vp.limits.map(l => l.text), ...vp.differences].some(t => /<Node>\.<Output>/.test(t)), `${lane}: ${JSON.stringify(vp)}`);
    assert.ok(capOf('logic.client-action').differences.some(t => /<Node>\.<Output>/.test(t)), `${lane}: logic.client-action states the difference`);
    // Every role statement of the theme follows the level of the jobs it cites.
    for (const id of OURS) { const x = (await expand(lane, `${id}:operations`)).expansions?.[id]; if (x?.operations) allFollow(x, `${lane} ${id}`); }
  }
  // Web screen action: a native role on O11 only (loaded from the O11 runtime); ODC states every operation not
  // applicable with the alternative and has no native type for the role.
  const sx = (await expand('odc', 'logic.screen-action:operations+native')).expansions['logic.screen-action'];
  for (const [op, o] of Object.entries(sx.operations)) {
    const w = o.roles['web screen action']; assert.ok(w, `odc ${op}: web screen action stated`);
    assert.equal(w.status, 'not-applicable', op); assert.ok(w.alternative, op);
  }
  assert.equal(sx.native.find(n => n.role === 'web screen action').native, null);
  assert.equal(sx.native.find(n => n.role === 'screen action').runtime?.provenance, 'A-runtime');
  const wx = (await expand('o11', 'logic.screen-action:native')).expansions['logic.screen-action'].native.find(n => n.role === 'web screen action');
  assert.equal(wx.native, 'OutSystems.Model.UI.Web.IScreenAction'); assert.equal(wx.runtime?.provenance, 'A-runtime');
  // Preparation: a direct O11 capability whose evidence follows its job's level; on ODC a declared absence.
  const po = await ask('o11', 'criar a preparação de uma tela tradicional'); withinBudget(po, 'o11');
  const p = direct(po).find(m => m.id === 'logic.preparation'); assert.ok(p, list(po));
  assert.equal(p.operations.create.roles.preparation.status, 'applicable');
  followsProofs((await expand('o11', 'logic.preparation:operations')).expansions['logic.preparation'].operations.create.roles.preparation, 'o11 create preparation');
  assert.equal(p.operations.create.roles.preparation.evidence, (await expand('o11', 'logic.preparation:operations')).expansions['logic.preparation'].operations.create.roles.preparation.evidence);
  // ui.screen exists on O11 now: it reaches the answer (direct, or recommended by the preparation), never as pending.
  assert.ok(direct(po).some(m => m.id === 'ui.screen') || po.composition.recommended.some(r => r.id === 'ui.screen' && r.by === 'logic.preparation'), list(po));
  assert.ok(fragment.capabilities.find(c => c.id === 'logic.preparation').recommends.some(r => r.id === 'ui.screen'), 'the preparation recommends ui.screen');
  assert.equal((await expand('o11', 'logic.preparation:native')).expansions['logic.preparation'].native.find(n => n.role === 'preparation').runtime?.provenance, 'A-runtime');
  const pd = await ask('odc', 'criar a preparação de uma tela tradicional'); withinBudget(pd, 'odc');
  assert.ok(!(pd.matches ?? []).some(m => m.id === 'logic.preparation'));
  assert.ok((pd.unavailable ?? []).some(u => u.id === 'web-preparation'), JSON.stringify(pd.unavailable));
});

// Recall (round 3): two more natural intents per capability of this theme (Portuguese and English, wording not used by
// the tests above) select the capability as a DIRECT match on every lane where it exists. Only the selection is
// asserted here; the budget and the evidence are asserted by the tests above.
const RECALL_R3 = [
  ["criar uma ação de servidor que calcula o total do pedido", "logic.server-action"],
  ["create a server action that returns the order total", "logic.server-action"],
  ["expor uma ação de serviço para outra aplicação", "logic.service-action"],
  ["create a service action called by another app", "logic.service-action"],
  ["criar uma ação de cliente que valida os dados antes de enviar", "logic.client-action"],
  ["add a client action that toggles a flag", "logic.client-action"],
  ["criar uma ação de tela que chama a ação de servidor", "logic.screen-action"],
  ["add a screen action that calls a server action", "logic.screen-action"],
  ["criar uma ação de dados que busca os pedidos do cliente", "logic.data-action"],
  ["add a data action that fetches the orders on demand", "logic.data-action"],
  ["editar a preparação de uma tela tradicional", "logic.preparation", ["o11"]],
  ["add a preparation to a traditional web screen", "logic.preparation", ["o11"]],
  ["adicionar um parâmetro de saída à ação de cliente", "logic.variable"],
  ["add an output parameter to the client action", "logic.variable"],
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
