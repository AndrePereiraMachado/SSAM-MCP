// Front A, fragment logic-exception (catalog M1): user exceptions, raise nodes, exception handler nodes and the On
// Exception (global handler) action of a UI flow, through the PUBLIC discovery entry on both lanes: Portuguese and
// English intents select logic.exception directly, the focus names the element role, the lane differences answer with
// the declared status (handlers and the exception lifecycle proven on ODC, undetermined on O11 with the unit-contract
// limit; a user exception has no settable property on ODC and no lane difference is claimed for it), the natives are
// the ones loaded in each lane runtime, words of other fronts (events, timers, REST, roles, client variables) do not
// select it, and every answer fits the 12000-byte budget. Needs the lane CLIs built (the index is built from them);
// skips otherwise.
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
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
function withinBudget(a, label) {
  assert.equal(a.ok, true, label + ': ' + (a.error ?? ''));
  assert.ok(bytesOf(a) <= 12000 && a.size.bytes <= 12000, `${label}: hard budget, ${bytesOf(a)} bytes`);
  assert.notEqual(a.size.status, 'insufficient', label);
}
const excOf = a => { const f = direct(a).find(m => m.id === 'logic.exception'); assert.ok(f, JSON.stringify((a.matches ?? []).map(m => m.id + ':' + m.via))); return f; };
const skip = lane => !built(lane) && `${lane} CLI not built`;
const T = { timeout: 240000 };
const full = async lane => (await expand(lane, 'logic.exception:operations+native+evidence')).expansions['logic.exception'];
const fragment = readJson(new URL('../catalog/fragments/A/logic-exception.json', import.meta.url));

for (const lane of ['odc', 'o11']) {
  test(`[${lane}] raising a user exception selects logic.exception directly: the raise role is in focus and its create/set are proven by a stamped job of this lane`, { ...T, skip: skip(lane) }, async () => {
    const a = await ask(lane, 'criar um nó raise para lançar uma exceção de usuário');
    withinBudget(a, lane);
    const f = excOf(a);
    assert.ok(f.focus.roles.includes('raise') && f.focus.roles.includes('user exception'), JSON.stringify(f.focus));
    assert.deepEqual(f.focus.ops, ['create']);
    for (const role of ['raise', 'user exception']) {
      assert.equal(f.operations.create.roles[role].status, 'applicable', role);
      assert.equal(f.operations.create.roles[role].evidence, 'proven-current', role);
    }
    const x = await full(lane);
    assert.equal(x.operations.set.roles.raise.status, 'applicable');
    assert.equal(x.operations.set.roles.raise.evidence, 'proven-current');
    assert.ok(x.operations.create.preconditions.some(p => /must exist first/.test(p) && /defaults to the quoted exception name/.test(p)), JSON.stringify(x.operations.create.preconditions));
    // Every cited proof is a job of THIS lane's suite (never borrowed from the other lane).
    for (const [op, o] of Object.entries(x.operations)) for (const [role, r] of Object.entries(o.roles)) for (const p of r.proofs ?? []) assert.ok(fs.existsSync(`${lanes[lane].jobsDir}/${p.job}.json`), `${op}/${role}: ${p.job} is a job of the ${lane} suite`);
    // The four natives are the qualified types loaded in THIS lane's runtime (not a copied name).
    assert.equal(x.native.length, 4);
    for (const n of x.native) {
      assert.equal(n.runtime?.provenance, 'A-runtime', `${n.role}: ${JSON.stringify(n.runtime)}`);
      assert.notEqual(n.runtime.found, false, `${n.role}: native found in the ${lane} runtime`);
      assert.ok(n.runtime.ideVersion, n.role);
    }
  });

  test(`[${lane}] English intents select logic.exception directly within budget: raise and exception handler roles are focused`, { ...T, skip: skip(lane) }, async () => {
    const r = await ask(lane, 'raise a user exception in a server action');
    withinBudget(r, `${lane} raise`);
    const fr = excOf(r);
    assert.ok(fr.focus.roles.includes('raise') && fr.focus.roles.includes('user exception'), JSON.stringify(fr.focus));
    const h = await ask(lane, 'create an exception handler for a user exception');
    withinBudget(h, `${lane} handler`);
    const fh = excOf(h);
    assert.ok(fh.focus.roles.includes('exception handler'), JSON.stringify(fh.focus));
    assert.equal(fh.operations.create.roles['exception handler'].status, lane === 'odc' ? 'applicable' : 'undetermined');
  });

  // Hijack guard: intents of fronts B and C (events, timers, roles) and of other A families that share words with this
  // theme ("lançar", "tratar", "handler", "global", "user", "action") never make logic.exception a direct match.
  test(`[${lane}] words of other fronts do not select logic.exception (events, timers, roles, client variables, server actions)`, { ...T, skip: skip(lane) }, async () => {
    for (const intent of [
      'tratar o evento de clique de um botão',
      'criar um tratador para o evento de clique',
      'add an on click handler to the button',
      'lançar um timer agora',
      'launch a timer now',
      'criar uma variável global de cliente',
      'create a user role',
      'criar uma server action que calcula o total',
    ]) {
      const a = await ask(lane, intent);
      assert.equal(a.ok, true, `${lane} ${intent}: ${a.error ?? ''}`);
      assert.ok(!direct(a).some(m => m.id === 'logic.exception'), `${lane} "${intent}": ${JSON.stringify(direct(a).map(m => m.id))}`);
    }
  });
}

// On O11 no front-B/C capability exists yet, so a hijacked word would make logic.exception the ONLY match there. On ODC
// the lane descriptor's own "exception" synonym group (erro, error, raise, ...) replaces this fragment's group and still
// maps these words to "exception": that is the legacy descriptor (reported to the integrator), not this fragment.
test('[o11] REST error words and "raise an event" do not select logic.exception (no bare erro/raise/lançar in the fragment)', { ...T, skip: skip('o11') }, async () => {
  for (const intent of ['tratar o erro de uma chamada REST', 'handle the error of a REST call', 'raise an event from a block']) {
    const a = await ask('o11', intent);
    assert.equal(a.ok, true, `${intent}: ${a.error ?? ''}`);
    assert.ok(!direct(a).some(m => m.id === 'logic.exception'), `o11 "${intent}": ${JSON.stringify(direct(a).map(m => m.id))}`);
  }
});

test('lane difference answers with the declared status: a global exception handler and its handler node are proven on ODC and undetermined on O11 (unit contract only, stated as a limit)', { ...T, skip: (skip('odc') || skip('o11')) }, async () => {
  const intent = 'criar um tratador global de exceção';
  const d = await ask('odc', intent); const o = await ask('o11', intent);
  withinBudget(d, 'odc'); withinBudget(o, 'o11');
  const fd = excOf(d); const fo = excOf(o);
  for (const f of [fd, fo]) {
    assert.ok(f.focus.roles.includes('global exception handler') && f.focus.roles.includes('exception handler'), JSON.stringify(f.focus));
    assert.deepEqual(f.focus.ops, ['create']);
  }
  for (const role of ['global exception handler', 'exception handler']) {
    assert.equal(fd.operations.create.roles[role].status, 'applicable', role);
    assert.equal(fd.operations.create.roles[role].evidence, 'proven-current', role);
    assert.equal(fo.operations.create.roles[role].status, 'undetermined', role);
  }
  const xo = await full('o11');
  assert.deepEqual(xo.operations.create.roles['exception handler'].proofs, [], 'undetermined carries no proofs');
  assert.equal(xo.operations.create.roles['exception handler'].otherLanes.odc.status, 'applicable');
  assert.ok(xo.evidence.limits.some(l => /compact handlers key/.test(l.text) && /NativeFlowPolicyTests\.cs/.test(l.origin)), JSON.stringify(xo.evidence.limits));
  const xd = await full('odc');
  assert.ok(xd.evidence.limits.some(l => /GlobalExceptionHandler/.test(l.text) && /switch-exception-handler/.test(l.origin)), JSON.stringify(xd.evidence.limits));
  assert.equal(xd.operations.move.roles['exception handler'].evidence, 'proven-current');
  // A find is not typed by the ledger: the read of a user exception stays declared-not-proven (its current job verifies
  // nothing on the role, so the engine never shows it as proven).
  const read = xd.operations.read.roles['user exception'];
  assert.equal(read.status, 'applicable'); assert.ok(read.proofs.every(p => !p.verified), JSON.stringify(read.proofs));
  assert.equal(read.evidence, 'declared-not-proven');
  // Every role statement of both lanes follows the level of the jobs it cites (no level pinned: the O11 stamp list
  // grows between campaigns).
  for (const [lane, x] of [['odc', xd], ['o11', xo]]) for (const [op, o] of Object.entries(x.operations)) for (const [role, r] of Object.entries(o.roles)) {
    for (const p of r.proofs) if (p.level === 'C-suite') assert.equal(p.verified, undefined, `${lane} ${op}/${role}: ${p.job}`);
    if (!['applicable', 'conditional'].includes(r.status)) continue;
    const current = r.proofs.some(p => p.level === 'C-executed-current' && p.verified);
    const historical = r.proofs.some(p => p.level === 'C-executed-historical' && p.verified);
    assert.equal(r.evidence, current ? 'proven-current' : historical ? 'proven-historical' : 'declared-not-proven', `${lane} ${op}/${role}`);
  }
  // ui.screen now exists on O11: the exception recommends it there too (composition answer).
  assert.ok(o.composition.recommended.some(r => r.id === 'ui.screen' && r.by === 'logic.exception'), JSON.stringify(o.composition.recommended));
});

test('the exception lifecycle is ODC-only: delete is conditional (0 consumers, proven), O11 undetermined; set on a user exception is refused-declared on ODC with rename as the alternative and undetermined on O11', { ...T, skip: (skip('odc') || skip('o11')) }, async () => {
  const intent = 'apagar uma exceção de usuário que ainda tem consumidores';
  const d = await ask('odc', intent); const o = await ask('o11', intent);
  withinBudget(d, 'odc'); withinBudget(o, 'o11');
  const fd = excOf(d); const fo = excOf(o);
  assert.deepEqual(fd.focus.roles, ['user exception']); assert.deepEqual(fo.focus.roles, ['user exception']);
  assert.ok(fd.focus.ops.includes('delete') && fo.focus.ops.includes('delete'));
  assert.equal(fd.operations.delete.roles['user exception'].status, 'conditional');
  assert.equal(fd.operations.delete.roles['user exception'].evidence, 'proven-current');
  assert.equal(fo.operations.delete.roles['user exception'].status, 'undetermined');
  const xd = await full('odc');
  assert.ok(xd.operations.delete.preconditions.some(p => /usages must be 0/.test(p)));
  assert.deepEqual(xd.operations.replace.roles['user exception'].proofs.map(p => p.job), ['exception-lifecycle']);
  const set = xd.operations.set.roles['user exception'];
  assert.equal(set.status, 'not-applicable'); assert.equal(set.evidence, 'refusal-declared'); assert.equal(set.alternative, 'rename');
  const xo = await full('o11');
  for (const op of ['usages', 'rename', 'replace', 'set']) assert.equal(xo.operations[op].roles['user exception'].status, 'undetermined', op);
  // No lane difference is claimed about Description: neither runtime lists it as writable on IUserException.
  for (const x of [xd, xo]) {
    const n = x.native.find(k => k.role === 'user exception');
    assert.ok(Array.isArray(n.runtime?.writable) && n.runtime.writable.includes('Name') && !n.runtime.writable.includes('Description'), JSON.stringify(n.runtime));
  }
  const cap = fragment.capabilities.find(c => c.id === 'logic.exception');
  assert.deepEqual(cap.platforms.odc.differences, []);
});

test('limit origins cite the ops that really do what the limit says (exception-lifecycle job of the ODC suite)', { skip: skip('odc') }, () => {
  const job = readJson(`${lanes.odc.jobsDir}/exception-lifecycle.json`);
  const limits = fragment.capabilities.find(c => c.id === 'logic.exception').platforms.odc.limits;
  const description = limits.find(l => /Description/.test(l.text));
  assert.match(description.origin, /exception-lifecycle op 41\b/);
  assert.equal(job.ops[41].op, 'create'); assert.equal(job.ops[41].type, 'IUserException'); assert.match(job.ops[41]._why, /Description/);
  const literals = limits.find(l => /never rewrite literals/.test(l.text));
  assert.match(literals.origin, /ops 4-7, 49, 52-53/);
  assert.equal(job.ops[4].op, 'rename'); assert.equal(job.ops[5].op, 'get'); assert.equal(job.ops[6].op, 'set');
  assert.equal(job.ops[49].op, 'replace'); assert.equal(job.ops[52].op, 'get'); assert.equal(job.ops[53].op, 'get');
});

test('ui.screen (front B) exists on both lanes now: it is recommended on both and no longer a pending requirement', () => {
  const cap = fragment.capabilities.find(c => c.id === 'logic.exception');
  const rec = cap.recommends.find(r => r.id === 'ui.screen');
  assert.ok(rec && rec.lanes === undefined, JSON.stringify(rec));
  assert.ok(!(cap.requires ?? []).some(r => r.id === 'ui.screen'), 'no pending requires for ui.screen');
  // Hijack guard on the fragment itself: no bare single-word variant that ordinary intents use.
  const bare = ['lancar', 'lançar', 'lanca', 'lança', 'lance', 'tratar', 'erro', 'handler', 'tratador', 'globais', 'raise'];
  for (const [key, variants] of Object.entries(fragment.synonyms)) for (const v of variants) assert.ok(!bare.includes(v), `synonym ${key}: bare "${v}"`);
  for (const k of cap.keywords) assert.ok(!bare.includes(k), `keyword: bare "${k}"`);
});

// Recall (round 3): two more natural intents per capability of this theme (Portuguese and English, wording not used by
// the tests above) select the capability as a DIRECT match on every lane where it exists. Only the selection is
// asserted here; the budget and the evidence are asserted by the tests above.
const RECALL_R3 = [
  ["criar uma exceção de usuário e lançá-la na ação", "logic.exception"],
  ["handle a user exception with an exception handler", "logic.exception"],
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
