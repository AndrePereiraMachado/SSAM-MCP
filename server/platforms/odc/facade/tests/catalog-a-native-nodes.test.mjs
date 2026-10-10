// Front A, fragment logic-native-nodes (catalog M1): native flow nodes with closed properties (message, destination,
// download, JSON, Excel, JavaScript, refresh data, ajax refresh, send email, email attachment), through the PUBLIC
// discovery entry on both lanes: Portuguese intents select logic.native-nodes directly, the focus names the node role,
// the lane differences answer with the declared status (send email is a different native type per lane, each lane's
// evidence following the level of its own jobs; message proven on ODC and undetermined on O11; ajax refresh refused on
// ODC), and every answer
// fits the 12000-byte budget. Also: every ODC role of the compact job, the runtime provenance of every native, English
// intents, and hijack probes (intents of other fronts that share words with the theme must not select it). Needs the
// lane CLIs built (the index is built from them); skips otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { laneSources, discover } from '../discovery.mjs';

const lanes = { odc: laneSources('odc'), o11: laneSources('o11') };
const built = lane => fs.existsSync(lanes[lane].cli);
const bytesOf = a => Buffer.byteLength(JSON.stringify(a), 'utf8');
const direct = a => (a.matches ?? []).filter(m => m.via === 'match');
const ask = (lane, intent) => discover({ lane, intent, sources: lanes[lane], budgetBytes: 12000 });
const expand = (lane, what) => discover({ lane, expand: what, sources: lanes[lane], budgetBytes: 400000 });
function withinBudget(a, label) {
  assert.equal(a.ok, true, label + ': ' + (a.error ?? ''));
  assert.ok(bytesOf(a) <= 12000 && a.size.bytes <= 12000, `${label}: hard budget, ${bytesOf(a)} bytes`);
  assert.notEqual(a.size.status, 'insufficient', label);
}
const nodesOf = a => { const f = direct(a).find(m => m.id === 'logic.native-nodes'); assert.ok(f, JSON.stringify((a.matches ?? []).map(m => m.id + ':' + m.via))); return f; };
const expansion = async lane => (await expand(lane, 'logic.native-nodes:operations+native+evidence')).expansions['logic.native-nodes'];
const skip = lane => !built(lane) && `${lane} CLI not built`;
const T = { timeout: 240000 };
// A role statement's evidence follows the engine level of the jobs it cites (never a level pinned by the test: the O11
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

// Cross-front cause, outside front A (reported, not failing, until it is gone): "client" in the intent makes front C's
// integration.rest-consume (its role "rest client") and security.settings-roles (it still carries the client variable
// role until the C-002 transfer, D-M2-6) direct matches, so the 12000-byte answer is insufficient on both lanes.
const JS_BUDGET_TODO = 'cross-front: C integration.rest-consume role "rest client" and security.settings-roles (client variable role until C-002, D-M2-6) match "client" and make the answer insufficient';
for (const lane of ['odc', 'o11']) {
  test(`[${lane}] a JavaScript node in a client action selects logic.native-nodes directly; create and set on the javascript role are proven by a stamped job of this lane`, { ...T, skip: skip(lane), todo: JS_BUDGET_TODO }, async () => {
    const a = await ask(lane, 'executar javascript numa client action');
    withinBudget(a, lane);
    const f = nodesOf(a);
    assert.deepEqual(f.focus.roles, ['javascript'], JSON.stringify(f.focus));
    const x = await expansion(lane);
    for (const op of ['create', 'set', 'read']) {
      const r = x.operations[op].roles.javascript;
      assert.equal(r.status, 'applicable', `${op}`); assert.equal(r.evidence, 'proven-current', `${op}`);
      assert.equal(r.native, 'OutSystems.Model.Logic.Nodes.IJavaScriptNode');
    }
    // Every job cited by any role of this lane belongs to this lane's suite (no proof borrowed from the other lane).
    for (const [op, o] of Object.entries(x.operations)) for (const [role, r] of Object.entries(o.roles)) for (const p of r.proofs ?? []) assert.ok(fs.existsSync(`${lanes[lane].jobsDir}/${p.job}.json`), `${op}/${role}: ${p.job} is a job of the ${lane} suite`);
    // Renaming the node itself is not claimed on either lane.
    assert.equal(x.operations.rename.roles.javascript.status, 'undetermined');
  });
}

test('lane difference: send email is a different native type per lane; proven by a stamped job on ODC, the O11 evidence follows the level of its own jobs, never read on O11', { ...T, skip: (skip('odc') || skip('o11')) }, async () => {
  const intent = 'enviar e-mail com o nó send email';
  const d = await ask('odc', intent); const o = await ask('o11', intent);
  withinBudget(d, 'odc'); withinBudget(o, 'o11');
  assert.deepEqual(nodesOf(d).focus.roles, ['send email']); assert.deepEqual(nodesOf(o).focus.roles, ['send email']);
  const xd = await expansion('odc'); const xo = await expansion('o11');
  const nd = xd.native.find(n => n.role === 'send email'); const no = xo.native.find(n => n.role === 'send email');
  assert.equal(nd.native, 'OutSystems.Model.Logic.Mobile.Nodes.ISendEmailNode'); assert.notEqual(nd.runtime?.found, false);
  assert.equal(no.native, 'OutSystems.Model.Logic.Nodes.ISendEmailNode'); assert.notEqual(no.runtime?.found, false);
  assert.equal(xd.operations.create.roles['send email'].evidence, 'proven-current');
  assert.deepEqual(xd.operations.create.roles['send email'].proofs.map(p => p.job), ['email-popover-metadata']);
  const oc = xo.operations.create.roles['send email'];
  assert.equal(oc.status, 'applicable'); followsProofs(oc, 'o11 create send email');
  assert.ok(oc.proofs.every(p => fs.existsSync(`${lanes.o11.jobsDir}/${p.job}.json`)), 'O11 cites only O11 jobs');
  assert.equal(xo.operations.read.roles['send email'].status, 'undetermined');
  assert.deepEqual(xo.operations.read.roles['send email'].proofs, [], 'undetermined carries no proofs');
});

test('lane difference: a message node is proven on ODC (screen action and On Exception flow) and undetermined on O11, where only C# contract tests exist (stated as a limit, not as a proof)', { ...T, skip: (skip('odc') || skip('o11')) }, async () => {
  const intent = 'mostrar mensagem de sucesso ao usuário com um message node';
  const d = await ask('odc', intent); const o = await ask('o11', intent);
  withinBudget(d, 'odc'); withinBudget(o, 'o11');
  assert.deepEqual(nodesOf(d).focus.roles, ['message']); assert.deepEqual(nodesOf(o).focus.roles, ['message']);
  const xd = await expansion('odc'); const xo = await expansion('o11');
  assert.equal(xd.operations.create.roles.message.evidence, 'proven-current');
  assert.equal(xd.operations.move.roles.message.evidence, 'proven-current');
  const oc = xo.operations.create.roles.message;
  assert.equal(oc.status, 'undetermined'); assert.deepEqual(oc.proofs, []);
  assert.equal(oc.otherLanes.odc.status, 'applicable');
  // The ODC placement census keeps its origin; the O11 C# coverage is a limit with its file origin.
  assert.ok((xd.evidence.limits ?? []).some(l => /never live in server actions/.test(l.text) && /logic-native-nodes/.test(l.origin)), JSON.stringify(xd.evidence.limits));
  assert.ok((xo.evidence.limits ?? []).some(l => /no O11 suite job/.test(l.text) && /action-coverage/.test(l.origin)), JSON.stringify(xo.evidence.limits));
});

test('ODC closed-property nodes: destination, download, JSON and Excel are created, set and read by the compact logic step of one stamped ODC job, and every native resolves in the ODC runtime', { ...T, skip: skip('odc') }, async () => {
  const x = await expansion('odc');
  for (const role of ['destination', 'download', 'json serialize', 'json deserialize', 'excel export', 'excel import']) {
    for (const op of ['create', 'set', 'read']) {
      const r = x.operations[op].roles[role];
      assert.equal(r.status, 'applicable', `${op}/${role}`); assert.equal(r.evidence, 'proven-current', `${op}/${role}`);
      assert.deepEqual(r.proofs.map(p => p.job), ['logic-native-nodes'], `${op}/${role}`);
    }
  }
  // Refresh data: created and set by a stamped ODC job, but only seen inside a dump of the owning screen (no read claim).
  assert.equal(x.operations.create.roles['data refresh'].evidence, 'proven-current');
  assert.equal(x.operations.read.roles['data refresh'].status, 'undetermined'); assert.deepEqual(x.operations.read.roles['data refresh'].proofs, []);
  assert.equal(x.operations.read.roles['email attachment'].status, 'undetermined');
});

test('runtime provenance: every declared native of both lanes is loaded from the lane runtime (A-runtime), and the roles without an ODC type carry no native', { ...T, skip: (skip('odc') || skip('o11')) }, async () => {
  for (const lane of ['odc', 'o11']) {
    const x = await expansion(lane);
    for (const n of x.native) {
      if (n.native == null) { assert.ok(lane === 'odc' && ['ajax refresh', 'email attachment'].includes(n.role), `${lane}/${n.role}`); continue; }
      assert.equal(n.runtime?.provenance, 'A-runtime', `${lane}/${n.role}: ${JSON.stringify(n.runtime)}`);
      assert.notEqual(n.runtime.found, false, `${lane}/${n.role}`); assert.ok(n.runtime.ideVersion, `${lane}/${n.role}`);
    }
    assert.equal(x.native.filter(n => n.native).length, lane === 'odc' ? 10 : 12, lane);
  }
});

test('O11 refresh data and send email: applicable, with the evidence the engine computes from the level of their suite jobs (never a pinned level); every role of both lanes follows its cited jobs', { ...T, skip: (skip('odc') || skip('o11')) }, async () => {
  const x = await expansion('o11');
  for (const [op, role] of [['create', 'data refresh'], ['set', 'data refresh'], ['read', 'data refresh'], ['create', 'send email'], ['set', 'send email']]) {
    const r = x.operations[op].roles[role];
    assert.equal(r.status, 'applicable', `${op}/${role}`); assert.ok(r.proofs.length > 0, `${op}/${role}`);
    followsProofs(r, `o11 ${op}/${role}`);
  }
  for (const lane of ['odc', 'o11']) { const e = await expansion(lane); for (const [op, o] of Object.entries(e.operations)) for (const [role, r] of Object.entries(o.roles)) followsProofs(r, `${lane} ${op}/${role}`); }
  // JSON, Excel, message, destination and download have no O11 suite job: undetermined with no proofs.
  for (const role of ['message', 'destination', 'download', 'json serialize', 'json deserialize', 'excel export', 'excel import']) {
    const r = x.operations.create.roles[role];
    assert.equal(r.status, 'undetermined', role); assert.deepEqual(r.proofs, [], role);
  }
});

for (const lane of ['odc', 'o11']) {
  test(`[${lane}] English and Portuguese intents of the theme select logic.native-nodes directly with the named role, within the budget`, { ...T, skip: skip(lane) }, async () => {
    const cases = [
      ['show a success message after saving', ['message']],
      ['export a list to excel and download the file', null],
      ['navegar para outra tela ao terminar a ação', ['destination']],
      ['enviar e-mail de boas-vindas', ['send email']],
    ];
    for (const [intent, roles] of cases) {
      const a = await ask(lane, intent);
      withinBudget(a, `${lane}: ${intent}`);
      const f = nodesOf(a);
      if (roles) assert.deepEqual(f.focus.roles, roles, `${lane}: ${intent}: ${JSON.stringify(f.focus)}`);
      else for (const r of ['excel export', 'download']) assert.ok(f.focus.roles.includes(r), `${lane}: ${intent}: ${JSON.stringify(f.focus)}`);
    }
  });

  test(`[${lane}] hijack guard: UI, integration, delivery and other logic intents that share words with the theme do not select logic.native-nodes`, { ...T, skip: skip(lane) }, async () => {
    const intents = [
      'validar o campo de e-mail no formulario',
      'configurar o servidor smtp para envio de e-mail',
      'anexar arquivo ao registro com upload',
      'baixar a versao publicada do modulo',
      'destino do botao',
      'navegar para outra tela ao clicar no botao',
      'adicionar javascript ao tema',
      'serializar o corpo da requisicao REST',
      'change the properties of the button',
      'build the native app for android',
      'use a built-in function in an expression',
      'consume a REST API that returns json',
      'set the destination of the button to another screen',
      'show a validation message on the input',
    ];
    for (const intent of intents) {
      const a = await ask(lane, intent);
      assert.equal(a.ok, true, `${lane}: ${intent}: ${a.error ?? ''}`);
      assert.ok(!direct(a).some(m => m.id === 'logic.native-nodes'), `${lane}: '${intent}' selected logic.native-nodes: ${JSON.stringify(direct(a).map(m => m.id + ':' + (m.why ?? []).join(',')))}`);
    }
  });
}

test('catalog-only declarations: the front-B references now exist on both lanes, so they are recommendations on both and no longer pending requires; the Excel attribute selection entry is accounted with its role', () => {
  const fragment = JSON.parse(fs.readFileSync(new URL('../catalog/fragments/A/logic-native-nodes.json', import.meta.url), 'utf8').replace(/^﻿/, ''));
  const c = fragment.capabilities.find(k => k.id === 'logic.native-nodes');
  for (const id of ['ui.email-popover', 'ui.screen']) {
    const rec = c.recommends.find(r => r.id === id); assert.ok(rec && rec.lanes === undefined, `${id}: ${JSON.stringify(rec)}`);
    assert.ok(!(c.requires ?? []).some(r => r.id === id), `${id} is no longer a pending requires`);
  }
  const cov = Object.fromEntries(fragment.coverage.map(e => [e.type, e]));
  const attr = cov['odc:OutSystems.Model.Logic.Nodes.IRecordListToExcelAttribute'];
  assert.equal(attr.status, 'excluded'); assert.ok(attr.reason && attr.origin);
  assert.match(attr.alternative, /excel export/); assert.ok(c.elements.some(e => e.role === 'excel export'));
  assert.equal(cov['odc:OutSystems.Model.Logic.Nodes.IAjaxRefreshNode'].status, 'excluded');
  for (const t of ['odc:OutSystems.Model.Logic.Nodes.ISendEmailNode', 'odc:OutSystems.Model.Logic.Nodes.IAttachFileNode']) { assert.equal(cov[t].status, 'undetermined', t); assert.ok(cov[t].reason, t); }
  // The ODC differences no longer claim that attach file is absent.
  assert.ok(c.platforms.odc.differences.every(d => !/no ajax refresh or attach file/.test(d)), JSON.stringify(c.platforms.odc.differences));
});

test('unsupported case: ajax refresh is refused on ODC (no Traditional Web) with the refresh data alternative, and exists on O11 as an undetermined role with its native type', { ...T, skip: (skip('odc') || skip('o11')) }, async () => {
  const d = await ask('odc', 'recarregar um painel com ajax refresh');
  withinBudget(d, 'odc');
  assert.deepEqual(nodesOf(d).focus.roles, ['ajax refresh']);
  const xd = await expansion('odc'); const xo = await expansion('o11');
  const r = xd.operations.create.roles['ajax refresh'];
  assert.equal(r.status, 'not-applicable'); assert.equal(r.evidence, 'refusal-declared');
  assert.match(r.alternative, /data refresh/);
  assert.equal(xd.native.find(n => n.role === 'ajax refresh').native, null, 'no ODC native for ajax refresh');
  assert.equal(xd.operations.create.roles['data refresh'].evidence, 'proven-current');
  assert.equal(xo.native.find(n => n.role === 'ajax refresh').native, 'OutSystems.Model.Logic.Nodes.IAjaxRefreshNode');
  assert.equal(xo.operations.create.roles['ajax refresh'].status, 'undetermined');
});

// Recall (round 3): two more natural intents per capability of this theme (Portuguese and English, wording not used by
// the tests above) select the capability as a DIRECT match on every lane where it exists. Only the selection is
// asserted here; the budget and the evidence are asserted by the tests above.
const RECALL_R3 = [
  ["serializar uma estrutura em JSON na lógica", "logic.native-nodes"],
  ["send an email with an attachment from a server action", "logic.native-nodes"],
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
