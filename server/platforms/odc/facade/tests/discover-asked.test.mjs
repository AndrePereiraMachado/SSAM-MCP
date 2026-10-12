// ssam_discover answers what it was asked (2026-10-11), measured on the calls of the FarmaVirtual session of 10/10/2026
// (Codex, module Haiku_UI, 22nd release): 11 of its 22 discovers sent expand/detail beside an intent and got none of it,
// without a word (discovery.mjs honoured the expansion only without an intent).
// The arguments below are the calls as sent (calls.json of the session), on the O11 lane; the index needs the lane CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as discovery from '../discovery.mjs'; // a namespace: before a rule exists its test fails on the rule, not at import
import { discoverAll } from '../tool-routing.mjs';

const { discover, laneSources, parseExpand } = discovery;
const o11 = laneSources('o11');
const skip = !fs.existsSync(o11.cli) && 'the o11 CLI is not built';
const bytes = v => Buffer.byteLength(JSON.stringify(v), 'utf8');
const CALLS = {
  15: { intent: 'Ler conteudo arquivo local HTML prototipo sem alterar modulo', detail: 'ui.html-page', expand: 'ui.html-page:contract', budgetBytes: 15000 },
  20: { intent: 'importar documento HTML inteiro pagina prototipo arquivo CSS SVG scripts leitura de arquivo local', expand: 'ui.html-page:contract+example', budgetBytes: 18000 },
  34: { intent: 'Client Variable', detail: 'data.client-variable', expand: 'data.client-variable:example+contract', budgetBytes: 18000 },
  47: { intent: 'html-page input checkbox dropdown binding variavel local estatico sem source entidade evento OnInitialize', expand: 'ui.html-page:contract', budgetBytes: 16000 },
  49: { intent: 'Dropdown static options SpecialList', detail: 'ui.dropdown', budgetBytes: 18000 },
  59: { intent: 'importar imagem arquivo PNG binary IImage create', detail: 'ui.script-resource', budgetBytes: 12000 },
  67: { intent: 'html id widget name referencia resolver busca recursiva IInput', expand: 'ui.html-page:evidence', budgetBytes: 18000 },
  84: { intent: 'alterar CSS theme StyleSheet', detail: 'ui.theme-css', budgetBytes: 12000 },
  106: { intent: 'IDropdown Labels Values lista structure direto estrutura local field scope', detail: 'ui.dropdown', expand: 'ui.dropdown:evidence+operations', budgetBytes: 18000 },
  142: { intent: 'substituir client action logic replace true atualizar existente', detail: 'logic.client-action', budgetBytes: 16000 },
  149: { intent: 'Reactive CSS WebStyleSheet StyleSheet IMobileTheme IMobileScreen flow theme', detail: 'ui.theme-css', budgetBytes: 12000 },
};
// Every part a call asked, as `<id>:<part>` (detail = contract+example+evidence+bindings, as discover() expands it).
const asked = args => parseExpand([args.expand, args.detail ? `${args.detail}:contract+example+evidence+bindings` : null].filter(Boolean).join(','))
  .requests.flatMap(r => r.parts.map(part => ({ id: r.id, part, spec: `${r.id}:${part}` })));
// A part whole: what the expand-only call of that part alone returns at a budget that holds it.
const wholes = new Map();
const wholeOf = async u => { if (!wholes.has(u.spec)) wholes.set(u.spec, (await discover({ lane: 'o11', expand: u.spec, budgetBytes: 400000, sources: o11 })).expansions[u.id][u.part]); return wholes.get(u.spec); };
// The parts a continuation asks, as `<id>:<part>`; it never names what an expand refuses.
const continued = a => { const p = parseExpand(a.continuations?.next?.arguments?.expand ?? ''); assert.deepEqual(p.problems, [], 'the continuation is an expand that parses'); return p.requests.flatMap(r => r.parts.map(x => `${r.id}:${x}`)); };
// The parts continuations.pages asks, one call per page (sorted).
const pagesParts = a => (a.continuations?.pages ?? []).flatMap(c => continued({ continuations: { next: c } })).sort();
// Every part asked is whole in expansions, or reduced and named in expansionsReduced, or named in expansionsOmitted; a part
// reduced or omitted by the budget is in the exact call that returns it whole (continuations.next).
async function answeredOrNamed(a, args, label) {
  const left = new Set((a.expansionsOmitted ?? []).map(o => o.expand));
  const next = continued(a);
  for (const u of asked(args)) {
    const reduced = (a.expansionsReduced ?? []).find(r => r.expand === u.spec);
    if (a.expansions?.[u.id] && u.part in a.expansions[u.id]) {
      if (reduced) { assert.ok(reduced.kept && /budget/.test(reduced.why) && next.includes(u.spec), `${label}: ${u.spec} reduced: ${JSON.stringify(reduced)}`); continue; }
      assert.deepEqual(a.expansions[u.id][u.part], await wholeOf(u), `${label}: ${u.spec} is whole, or named in expansionsReduced`);
      continue;
    }
    assert.ok(left.has(u.spec), `${label}: ${u.spec} is neither answered nor named as omitted (${JSON.stringify(Object.keys(a.expansions ?? {}))})`);
    assert.match(a.expansionsOmitted.find(o => o.expand === u.spec).why, /budget/, label);
    assert.ok(next.includes(u.spec), `${label}: continuations.next asks ${u.spec}`);
    assert.deepEqual({ tool: a.continuations.next.tool, lane: a.continuations.next.arguments.lane }, { tool: 'ssam_discover', lane: 'o11' }, label);
  }
}

test('expand and detail beside an intent are answered: every part asked is whole in expansions, or reduced and named in expansionsReduced, or named in expansionsOmitted, with the exact call that returns it whole (calls 15, 20, 34, 47, 49, 59, 67, 84, 106, 142, 149)', { skip, timeout: 600000 }, async () => {
  let reducedSeen = 0;
  for (const [i, args] of Object.entries(CALLS)) {
    const a = await discover({ lane: 'o11', ...args, sources: o11 });
    const label = `call ${i}`;
    assert.equal(a.ok, true, label);
    assert.ok(Array.isArray(a.matches) && a.intent === args.intent, `${label}: the intent is still answered`);
    assert.ok(bytes(a) <= args.budgetBytes && a.size.bytes === bytes(a), `${label}: ${bytes(a)} bytes within ${args.budgetBytes}`);
    await answeredOrNamed(a, args, label);
    reducedSeen += a.expansionsReduced?.length ?? 0;
    // Stage F never cuts a part asked in silence (review of 2026-10-11: calls 49, 59, 106 and 142 lost ops, bindings and
    // proofs that counted as answered).
    assert.ok(!(a.size.truncated ?? []).some(t => t.section === 'expansions'), `${label}: stage F`);
  }
  assert.ok(reducedSeen > 0, 'some part was reduced at these budgets, and named');
  // An answer too small even for the model part names each part asked with an expand that parses (review of 2026-10-11:
  // stage F's bindingsOmitted marker became a "part" and the continuation was refused).
  for (const budgetBytes of [3000, 4096, 6000, 8000]) {
    const small = await discover({ lane: 'o11', ...CALLS[49], budgetBytes, sources: o11 });
    assert.ok(bytes(small) <= budgetBytes, `${budgetBytes}`);
    if (small.expansionsOmitted) assert.deepEqual(small.expansionsOmitted.map(o => o.expand), asked(CALLS[49]).map(u => u.spec), `${budgetBytes}`);
    if (small.continuations) assert.deepEqual(continued(small), asked(CALLS[49]).map(u => u.spec), `${budgetBytes}`);
  }
  // The parts asked are the last thing the budget cuts: the contract asked twice by call 15 (expand and detail) comes whole
  // beside the composite answer of its intent; its proven example (a whole html page) is the exact next call.
  const c15 = await discover({ lane: 'o11', ...CALLS[15], sources: o11 });
  assert.ok(c15.expansions['ui.html-page']?.contract?.['html.tags'], 'call 15: the html page contract');
  assert.ok(c15.expansionsOmitted.some(o => o.expand === 'ui.html-page:example'), 'call 15: the example is named');
  // With room, everything asked comes whole and nothing is named as omitted.
  const roomy = await discover({ lane: 'o11', ...CALLS[34], budgetBytes: 200000, sources: o11 });
  assert.deepEqual(Object.keys(roomy.expansions['data.client-variable']).filter(k => !['title', 'route'].includes(k)).sort(), ['bindings', 'contract', 'evidence', 'example']);
  assert.equal(roomy.expansionsOmitted, undefined); assert.equal(roomy.continuations, undefined);
  // A request the index does not know is named with its reason, never dropped in silence.
  const unknown = await discover({ lane: 'o11', intent: 'alterar CSS theme StyleSheet', expand: 'ui.no-such-thing:contract,ui.theme-css:examples', budgetBytes: 40000, sources: o11 });
  assert.equal(unknown.ok, true);
  assert.deepEqual(unknown.expansionsOmitted.map(o => o.expand).sort(), ['ui.no-such-thing', 'ui.theme-css:examples']);
  // The work packet answers its own sections: the parts asked by name are its next call.
  const packet = await discover({ lane: 'o11', ...CALLS[84], packet: true, sources: o11 });
  assert.deepEqual(packet.next.expand, { tool: 'ssam_discover', arguments: { lane: 'o11', expand: 'ui.theme-css:contract+example+evidence+bindings' }, why: packet.next.expand?.why });
});

// The seven 'insufficient' answers of the session: budgets of 6,000 to 24,000 bytes under the minimal answer.
const INSUFFICIENT = {
  11: { intent: 'Ler arquivo HTML local de prototipo e importar pagina completa via file html', budgetBytes: 8000 },
  31: { intent: 'Client Variables Reactive modulo estado mockado persistente carrinho local session variables client action logic atribuir variavel cliente', budgetBytes: 14000 },
  37: { intent: 'html page native mock client action navigate modal select data-show on click bindings', budgetBytes: 14000 },
  40: { detail: 'ui.html-page', budgetBytes: 24000 },
  47: CALLS[47],
  67: CALLS[67],
  147: { intent: 'Corrigir CSS não aplicado na tela FarmaVirtual do Haiku_UI. Ler tema MobileTheme StyleSheet/WebStyleSheet e tema do MainFlow e Screen StyleSheet. Vincular CSS à tela sem publicar.', budgetBytes: 6000 },
};

test('a budget below the minimal answer is raised to it when the minimal fits under the answer ceiling, and the answer says so in inputAdjusted and size.budgetAdjusted (calls 11, 31, 37, 40, 47, 67, 147; 49, 106, 142)', { skip, timeout: 600000 }, async () => {
  const ceiling = discovery.answerCeiling?.() ?? 38912;
  // The minimal a budget rises to has every part asked whole (stage F never cuts them): calls 49, 106 and 142 rose to the
  // form stage F had cut (an example of 4 ops, 8 bindings) while the whole parts fit under the ceiling (review of 2026-10-11).
  const raisedCalls = { ...INSUFFICIENT, 49: CALLS[49], 106: CALLS[106], 142: CALLS[142] };
  for (const [i, args] of Object.entries(raisedCalls)) {
    const a = await discoverAll({ lane: 'o11', ...args, sources: o11 });
    const label = `call ${i}`;
    assert.equal(a.ok, true, label);
    assert.notEqual(a.size.status, 'insufficient', `${label}: ${JSON.stringify(a.size)}`);
    const adjusted = a.inputAdjusted?.find(x => x.path === '/budgetBytes');
    assert.ok(adjusted, `${label}: inputAdjusted names the budget`);
    // With the lane's stamped job results the evidence grows: the whole answer of call 40 (detail ui.html-page) is about
    // 52.8 KB without them and 63.5 KB with the 95 current results, and its minimal then outgrows the ceiling. It pages
    // (the next test), and only when the whole answer does not fit under the ceiling in this checkout.
    if (adjusted.rule === 'raise-to-page') {
      const whole = await discover({ lane: 'o11', ...args, budgetBytes: 400000, sources: o11 });
      assert.ok(bytes(whole) > ceiling, `${label}: pages only when the whole answer (${bytes(whole)} bytes) outgrows the ceiling`);
      assert.ok(adjusted.to > args.budgetBytes && adjusted.to <= ceiling && a.continuations?.next, `${label}: ${args.budgetBytes} -> ${adjusted.to}, with the next page`);
      continue;
    }
    assert.deepEqual({ ...adjusted, to: 0 }, { path: '/budgetBytes', from: args.budgetBytes, to: 0, rule: 'raise-to-minimal' }, label);
    assert.ok(adjusted.to > args.budgetBytes && adjusted.to <= ceiling, `${label}: ${args.budgetBytes} -> ${adjusted.to}`);
    assert.equal(a.size.budgetBytes, adjusted.to, label);
    // The answer's own field keeps the adjustment when an input layer writes its own inputAdjusted over the answer's.
    assert.deepEqual(a.size.budgetAdjusted, { from: adjusted.from, to: adjusted.to, rule: adjusted.rule }, label);
    assert.ok(bytes(a) <= adjusted.to && a.size.bytes === bytes(a), `${label}: ${bytes(a)} bytes within ${adjusted.to}`);
    // Every part asked comes whole: nothing reduced, nothing left to another call.
    for (const u of asked(args)) assert.deepEqual(a.expansions?.[u.id]?.[u.part], await wholeOf(u), `${label}: ${u.spec} whole`);
    assert.equal(a.expansionsReduced, undefined, label); assert.equal(a.expansionsOmitted, undefined, label); assert.equal(a.continuations, undefined, label);
  }
  // The ceiling of discovery.mjs is the one the MCP layer holds a budget under (ssam.mjs budgetCeiling(maxAnswerBytes())).
  const { budgetCeiling, maxAnswerBytes } = await import('../ssam.mjs');
  for (const env of [{}, { SSAM_MAX_ANSWER_BYTES: '65536' }, { SSAM_MAX_ANSWER_BYTES: '8192' }, { SSAM_MAX_ANSWER_BYTES: '100' }]) assert.equal(discovery.answerCeiling(env), budgetCeiling(maxAnswerBytes(env)), JSON.stringify(env));
  // A budget the minimal answer fits is never touched.
  const roomy = await discoverAll({ lane: 'o11', ...INSUFFICIENT[31], budgetBytes: 30000, sources: o11 });
  assert.equal(roomy.inputAdjusted, undefined); assert.equal(roomy.size.budgetBytes, 30000);
  // The engine itself keeps its hard budget (no ceiling: the tests and the reruns for the room of the tools).
  const engine = await discover({ lane: 'o11', ...INSUFFICIENT[31], sources: o11 });
  assert.equal(engine.size.status, 'insufficient'); assert.ok(bytes(engine) <= 14000);
});

// The sections after the model part (review of 2026-10-11, round 3): a budget raised to the minimal of the model part left
// the OutSystems UI section and the C07 extras no room even for the note that names them, and they were lost without a
// word (C07: the OutSystems UI list is never the first thing lost). A screen intent at 9,000 rose to 17,321 without
// outsystemsUi nor provenExample; an action intent at 4,096 rose to 9,852 without steps nor provenExample; calls 11, 15 and
// 37 lost outsystemsUi and provenExample the same way.
const SECTIONS = {
  list: { intent: 'criar tela de listagem de pedidos com tabela e filtro', budgetBytes: 9000 },
  action: { intent: 'criar server action com if, foreach e assign que soma o total do pedido', budgetBytes: 4096 },
  11: INSUFFICIENT[11], 15: CALLS[15], 37: INSUFFICIENT[37],
};
// The sections a request carries (those of its intent with room for all), and those an answer neither holds nor names in
// size.truncated.
const sectionsOf = async intent => { const roomy = await discover({ lane: 'o11', intent, budgetBytes: 400000, sources: o11 }); return ['outsystemsUi', 'provenExample', 'steps', 'values'].filter(k => roomy[k] != null); };
const unnamed = (a, wants) => wants.filter(k => a[k] == null && !(a.size?.truncated ?? []).some(t => (k === 'outsystemsUi' ? t.section === 'outsystemsUi' : t.section === 'c07' && t.recover.includes(k))));

test('a budget raised at the entry holds the floor of the sections after the model part (the OutSystems UI counts, the steps, the proven example by reference), and no budget leaves a section without a word in size.truncated (a screen and an action intent; calls 11, 15 and 37)', { skip, timeout: 600000 }, async () => {
  for (const [i, args] of Object.entries(SECTIONS)) {
    const label = `${i}`;
    const wants = await sectionsOf(args.intent);
    assert.ok(wants.length >= 2, `${label}: ${wants}`);
    const a = await discoverAll({ lane: 'o11', ...args, sources: o11 });
    const adjusted = a.inputAdjusted?.find(x => x.path === '/budgetBytes');
    assert.ok(adjusted?.from === args.budgetBytes && adjusted.to > args.budgetBytes && a.size.budgetBytes === adjusted.to && a.size.status !== 'insufficient', `${label}: ${JSON.stringify(a.inputAdjusted)} ${a.size.status}`);
    assert.ok(bytes(a) <= adjusted.to && a.size.bytes === bytes(a), `${label}: ${bytes(a)} bytes within ${adjusted.to}`);
    // Every section at its floor at least: the room above the minimal of the model part is theirs, and no more than that.
    for (const k of wants) assert.ok(a[k] != null, `${label}: ${k} (truncated: ${(a.size.truncated ?? []).map(t => t.section).join(',')})`);
    assert.ok(adjusted.to - bytes(a) < 1024, `${label}: ${bytes(a)} bytes of ${adjusted.to}`);
    if (a.outsystemsUi) assert.ok(a.outsystemsUi.appTypes?.length && a.size.truncated.some(t => t.section === 'outsystemsUi' && /ssam_discover/.test(t.recover)), `${label}: the OutSystems UI section, reduced and named`);
    assert.ok(a.provenExample.reference?.tool === 'ssam_reference', `${label}: the proven example, at least by its id`);
  }
  const action = await discoverAll({ lane: 'o11', ...SECTIONS.action, sources: o11 });
  assert.deepEqual(Object.keys(action.steps.grammar), ['if', 'foreach', 'assign'], 'the grammar of the three steps the intent names');
  // No budget leaves a section without a word: below the minimal of the model part, at it and just above it (the model part
  // fits and leaves no room for the notes), and at the ceiling.
  for (const i of ['list', 'action']) {
    const { intent } = SECTIONS[i];
    const wants = await sectionsOf(intent);
    const minimal = (await discover({ lane: 'o11', intent, budgetBytes: 4096, sources: o11 })).size.minimalBytes;
    for (const budgetBytes of [minimal - 1, minimal, minimal + 64, minimal + 256, minimal + 600, discovery.answerCeiling()]) {
      const a = await discoverAll({ lane: 'o11', intent, budgetBytes, sources: o11 });
      const label = `${i} at ${budgetBytes} (minimal ${minimal})`;
      assert.deepEqual(unnamed(a, wants), [], label);
      assert.ok(a.size.status !== 'insufficient' && bytes(a) <= a.size.budgetBytes && a.size.bytes === bytes(a), `${label}: ${JSON.stringify(a.size)}`);
      assert.equal(a.size.budgetBytes, a.inputAdjusted?.[0]?.to ?? budgetBytes, label);
    }
  }
});

test('a minimal answer above the ceiling is answered in pages: each page within the ceiling, never insufficient, and the pages together return every part asked (22nd release, call 40: detail ui.html-page needed 47,274 bytes under a 38,912 ceiling)', { skip, timeout: 600000 }, async () => {
  // The worktree's ui.html-page needs about 30 KB: a ceiling of 16 KB stands for the 38,912 of that call.
  const ceilingBytes = 16384;
  const want = asked(INSUFFICIENT[40]).map(u => u.spec);
  let a = await discoverAll({ lane: 'o11', ...INSUFFICIENT[40], ceilingBytes, sources: o11 });
  assert.deepEqual(a.inputAdjusted, undefined, 'the budget given (24000) is above this ceiling: it holds the first page');
  const seen = new Set(); let pages = 0;
  for (;;) {
    pages++;
    assert.equal(a.ok, true); assert.notEqual(a.size.status, 'insufficient', JSON.stringify(a.size));
    assert.ok(bytes(a) <= Math.max(ceilingBytes, a.size.budgetBytes) && a.size.bytes === bytes(a), `page ${pages}: ${bytes(a)} bytes`);
    for (const [key, v] of Object.entries(a.expansions ?? {})) for (const part of Object.keys(v)) if (!['title', 'route'].includes(part)) seen.add(`${key}:${part}`);
    const next = a.continuations?.next;
    if (!next) break;
    assert.equal(next.tool, 'ssam_discover'); assert.equal(next.arguments.budgetBytes, ceilingBytes);
    assert.deepEqual(pagesParts(a), continued(a).sort(), `page ${pages}: continuations.pages, one call per page, are the parts next asks`);
    assert.ok(pages < 8, 'the pages end');
    a = await discoverAll({ ...next.arguments, ceilingBytes, sources: o11 });
  }
  assert.ok(pages >= 2, 'more than one page');
  assert.deepEqual([...seen].sort(), [...want].sort(), 'every part asked, across the pages');
  // A budget below the first page rises to that page's own minimal, never to the ceiling; a budget that holds the first
  // page is never touched.
  const below = await discoverAll({ lane: 'o11', ...INSUFFICIENT[40], budgetBytes: 4096, ceilingBytes: 20000, sources: o11 });
  const adj = below.inputAdjusted?.[0];
  assert.ok(adj?.rule === 'raise-to-page' && adj.from === 4096 && adj.to > 4096 && adj.to < 20000 && below.size.budgetAdjusted?.to === adj.to, JSON.stringify(below.inputAdjusted));
  assert.ok(below.continuations?.next && bytes(below) <= adj.to);
  const held = await discoverAll({ lane: 'o11', ...INSUFFICIENT[40], budgetBytes: adj.to, ceilingBytes: 20000, sources: o11 });
  assert.equal(held.inputAdjusted, undefined); assert.deepEqual(Object.keys(held.expansions['ui.html-page']), Object.keys(below.expansions['ui.html-page']));
  // Every page names the pages after it, to the last: following next alone returns every part asked (review of 2026-10-11:
  // with four capabilities at a 12 KB ceiling, page 2 pointed nowhere and page 3 was reachable only by pages[1] of page 1).
  const FOUR = 'ui.dropdown:contract+bindings,data.client-variable:contract+example,logic.client-action:contract+bindings,ui.theme-css:contract+example';
  const four = parseExpand(FOUR).requests.flatMap(r => r.parts.map(p => `${r.id}:${p}`));
  let page = await discoverAll({ lane: 'o11', expand: FOUR, budgetBytes: 8000, ceilingBytes: 12000, sources: o11 });
  const got = new Set(); let count = 0;
  for (;;) {
    count++;
    assert.ok(count < 8 && page.ok && page.size.status !== 'insufficient' && bytes(page) <= page.size.budgetBytes && page.size.bytes === bytes(page), `page ${count}: ${JSON.stringify(page.size)}`);
    if (Object.keys(page.expansions).some(k => k.startsWith('ui.'))) assert.ok(page.outsystemsUi || page.size.truncated?.some(t => t.section === 'outsystemsUi'), `page ${count}: the OutSystems UI section of a ui.* part is there or named`);
    for (const [key, v] of Object.entries(page.expansions)) for (const part of Object.keys(v)) if (!['title', 'route'].includes(part)) got.add(`${key}:${part}`);
    if (!page.continuations) break;
    assert.deepEqual(pagesParts(page), continued(page).sort(), `page ${count}: continuations.pages are the parts next asks`);
    page = await discoverAll({ ...page.continuations.next.arguments, ceilingBytes: 12000, sources: o11 });
  }
  assert.ok(count >= 3, `${count} pages`);
  assert.deepEqual([...got].sort(), [...four].sort(), 'next alone returns every part asked');
  // A budget at the ceiling is the first page's own: answered at that budget and never restated (review of 2026-10-11:
  // 38,912 answered with size.budgetBytes 38,748 and no adjustment); just below it, a page that holds more parts than the
  // page at the ceiling less the note of an adjustment is the caller's too.
  for (const budgetBytes of [12000, 11950]) {
    const atCeiling = await discoverAll({ lane: 'o11', expand: FOUR, budgetBytes, ceilingBytes: 12000, sources: o11 });
    assert.ok(atCeiling.inputAdjusted === undefined && atCeiling.size.budgetBytes === budgetBytes && bytes(atCeiling) <= budgetBytes, `${budgetBytes}: ${JSON.stringify(atCeiling.inputAdjusted)} ${atCeiling.size.budgetBytes}`);
  }
});

// Calls 15 and 20 at the real ceiling: the html page example (25 KB) does not fit beside the model part, so it is page 2.
// Page 1 rose to the ceiling and the 20 KB of room went to the model part (matches, contracts, outsystemsUi), never to a part
// asked (review of 2026-10-11). It rises only to the minimal of the model part plus the parts it holds.
test('the first page of an answer in pages rises only to its own minimal: the model part at its minimal and the parts asked that fit (calls 15 and 20)', { skip, timeout: 600000 }, async () => {
  for (const i of [15, 20]) {
    const args = CALLS[i]; const label = `call ${i}`;
    const a = await discoverAll({ lane: 'o11', ...args, sources: o11 });
    assert.notEqual(a.size.status, 'insufficient', label);
    assert.deepEqual(continued(a), ['ui.html-page:example'], `${label}: the example is the next page`);
    assert.equal(a.continuations.next.arguments.budgetBytes, discovery.answerCeiling(), label);
    await answeredOrNamed(a, args, label);
    // The parts this page holds, asked alone beside the same intent: that answer's minimal bounds this page (plus the
    // bytes that name the example and its call).
    const held = Object.entries(a.expansions).flatMap(([id, v]) => Object.keys(v).filter(p => p !== 'title' && p !== 'route').map(p => `${id}:${p}`));
    const alone = await discoverAll({ lane: 'o11', intent: args.intent, expand: held.join(','), budgetBytes: 4096, sources: o11 });
    const minimal = alone.inputAdjusted?.[0]?.to;
    assert.ok(minimal && alone.inputAdjusted[0].rule === 'raise-to-minimal', `${label}: ${JSON.stringify(alone.inputAdjusted)}`);
    assert.ok(a.size.budgetBytes <= Math.max(args.budgetBytes, minimal + 1024), `${label}: page 1 at ${a.size.budgetBytes}, its parts alone need ${minimal}`);
    if (a.size.budgetBytes > args.budgetBytes) assert.deepEqual(a.inputAdjusted, [{ path: '/budgetBytes', from: args.budgetBytes, to: a.size.budgetBytes, rule: 'raise-to-page' }], label);
  }
});

// Call 1 of the session: a path in the intent (".../index.html") made data.entity a direct match focused on the role
// "index", and "tema CSS" left ui.theme-css among the alternatives ("named through a generic element word only").
const FIRST = 'Implementar protótipo HTML pixel perfect de arquivo local C:\\Users\\andre\\GitSSAM\\prototypes\\farmavirtual\\index.html no módulo Haiku_UI com dados mockados usando html página tema CSS ler arquivo local';
const SEVENTEENTH = 'Ler arquivo local HTML index.html prototipo completo importar pagina scripts SVG assets arquivo file';

test('paths, URLs and file names of an intent stay out of the words the matcher reads; the intent is answered as written', () => {
  const words = discovery.withoutPaths?.bind(discovery) ?? (text => text);
  const cleaned = words(FIRST);
  for (const gone of ['Users', 'andre', 'GitSSAM', 'prototypes', 'farmavirtual', 'index', '.html']) assert.ok(!cleaned.includes(gone), `${gone}: ${cleaned}`);
  for (const kept of ['protótipo', 'HTML', 'Haiku_UI', 'html página tema CSS', 'ler arquivo local']) assert.ok(cleaned.includes(kept), `${kept}: ${cleaned}`);
  assert.ok(!words(SEVENTEENTH).includes('index'), words(SEVENTEENTH));
  // A quoted Windows path with spaces, POSIX, relative, UNC and URL paths, and a glob of a file type: what each says of its
  // kind stays (the extension of a file, the scheme of a URL and the extension it ends in), never its folders, host or stem.
  const wordsOf = text => text.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  assert.deepEqual(wordsOf(words('ler "C:\\Program Files\\Proto\\app.js" e /home/ana/proto/index.html, ./src/styles.css, \\\\srv\\share\\x.png e https://ex.com/a/index.html ou *.html')),
    ['ler', 'js', 'e', 'html', 'css', 'png', 'e', 'https', 'html', 'ou', 'html']);
  // The extension and the scheme are domain words (review of 2026-10-11): a file is its extension, a URL its scheme, a
  // folder nothing.
  assert.deepEqual(wordsOf(words('importar o arquivo prototipo.html como tela')), ['importar', 'o', 'arquivo', 'html', 'como', 'tela']);
  assert.deepEqual(wordsOf(words('usar Chart.js para um grafico')), ['usar', 'js', 'para', 'um', 'grafico']);
  assert.deepEqual(wordsOf(words('consumir a API https://api.exemplo.com/v1/pedidos e listar')), ['consumir', 'a', 'API', 'https', 'e', 'listar']);
  assert.deepEqual(wordsOf(words('ler C:\\Users\\ana\\prototipo\\ e /home/ana/assets/')), ['ler', 'e']);
  // Not paths: element names with a slash or a dot, capability ids, expressions.
  const plain = 'Ler tema MobileTheme StyleSheet/WebStyleSheet, ui.html-page, data.entity, ui.list, Client.FvModal = "editar" e um índice único';
  assert.equal(words(plain), plain);
});

test('the words of the intent decide the matches: no capability from a path, and the domain word of a family keeps it (calls 1 and 17)', { skip, timeout: 600000 }, async () => {
  const roles = a => (a.matches ?? []).flatMap(m => (m.focus?.roles ?? []).map(r => `${m.id}/${r}`));
  const first = await discover({ lane: 'o11', intent: FIRST, budgetBytes: 200000, sources: o11 });
  assert.equal(first.intent, FIRST, 'the intent is echoed as written');
  assert.ok(!first.matches.some(m => m.id === 'data.entity'), `call 1: ${first.matches.map(m => m.id + ':' + m.via).join(', ')}`);
  assert.ok(!roles(first).includes('data.entity/index'));
  assert.ok(first.matches.some(m => m.id === 'ui.theme-css' && m.via === 'match'), `call 1: "tema CSS" keeps ui.theme-css (${first.matches.map(m => m.id + ':' + m.via).join(', ')})`);
  assert.ok(!['user', 'andre', 'gitssam', 'farmavirtual'].some(w => first.lexical.unmatched.includes(w)), first.lexical.unmatched.join(' '));
  const seventeenth = await discover({ lane: 'o11', intent: SEVENTEENTH, budgetBytes: 200000, sources: o11 });
  assert.ok(!seventeenth.matches.some(m => m.id === 'data.entity'), `call 17: ${seventeenth.matches.map(m => m.id + ':' + m.via).join(', ')}`);
  // The word itself still names its element: an index of an entity, and the theme of a theme intent.
  const index = await discover({ lane: 'o11', intent: 'criar um índice único na entidade Pedido', budgetBytes: 200000, sources: o11 });
  assert.ok(roles(index).includes('data.entity/index'), roles(index).join(', '));
  for (const intent of ['alterar o tema do módulo', 'alterar o CSS do tema', 'change the theme stylesheet']) {
    const a = await discover({ lane: 'o11', intent, budgetBytes: 200000, sources: o11 });
    assert.ok(a.matches.some(m => m.id === 'ui.theme-css' && m.via === 'match'), `${intent}: ${a.matches.map(m => m.id + ':' + m.via).join(', ')}`);
  }
});

// The review of 2026-10-11: what a file or URL says of its kind is a domain word (dropping it took ui.html-page and
// ui.widget out of "importar o arquivo prototipo.html como tela", ui.html-visual and ui.script-resource out of
// "usar Chart.js", the http of a URL out of integration.rest-consume); and the generic words of the css synonym group
// (classe, estilo) promoted ui.theme-css to a direct match in intents that only name an entity.
test('a file keeps its extension and a URL its scheme in the words the matcher reads; classe and estilo never name the theme family', { skip, timeout: 600000 }, async () => {
  const ids = (a, via) => (a.matches ?? []).filter(m => !via || m.via === via).map(m => m.id);
  const list = a => (a.matches ?? []).map(m => m.id + ':' + m.via).join(', ');
  const ask = intent => discover({ lane: 'o11', intent, budgetBytes: 200000, sources: o11 });
  const page = await ask('importar o arquivo prototipo.html como tela no modulo Vendas');
  for (const id of ['ui.html-page', 'ui.html-visual', 'ui.widget']) assert.ok(ids(page, 'match').includes(id), `prototipo.html: ${id} (${list(page)})`);
  const chart = await ask('usar Chart.js para um grafico de barras na tela Vendas');
  assert.ok(ids(chart, 'match').includes('ui.html-visual') && ids(chart).includes('ui.script-resource'), `Chart.js: ${list(chart)}`);
  // The URL says http (a keyword of integration.rest-consume), never its host or path (the host "api." of this URL once
  // made the run "http api", a variant of rest).
  const url = await ask('consumir a API https://api.exemplo.com/v1/pedidos e listar na tela');
  assert.ok(ids(url).includes('integration.rest-consume') && url.terms.includes('http') && !['exemplo', 'v1', 'pedido'].some(w => url.terms.includes(w)), `URL: ${list(url)}; terms ${url.terms}`);
  const rest = await ask('consumir a API REST https://servicos.exemplo.com/v1/pedidos e listar na tela');
  assert.ok(ids(rest, 'match').includes('integration.rest-consume'), `REST URL: ${list(rest)}`);
  for (const intent of ['criar entidade Aluno com atributo Classe e Turma', 'criar entidade Estilo com atributos Nome e Cor']) {
    const a = await ask(intent);
    assert.ok(ids(a, 'match').includes('data.entity') && !ids(a, 'match').includes('ui.theme-css'), `${intent}: ${list(a)}`);
  }
});
