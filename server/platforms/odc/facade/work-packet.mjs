// The work packet: ssam_discover {intent, lane, app, packet:true} (W1, 2026-10-10). SSAM does not control how a client
// (Claude, Codex, a customer's model) opens and briefs its agents, and an agent without a good brief reads the docs and the
// module again (measured: 1,428 repeated doc reads, 29-82 reads per agent before its first write). The points SSAM does
// control are the server instructions, the tool descriptions, the answers and the refusals; so the brief comes from SSAM,
// in one call any agent makes: this packet. It is deterministic (the same intent, lane, capture and sources give the same
// bytes: no timings, cache states or dates), fits budgetBytes (default the answer ceiling less the shaper's room, 38912)
// and has a declared order with declared cuts:
//   module        the elements of the capture the intent names, from its module digest (ssam-digest/1, ModuleDigest.cs and
//                 module-digest.mjs): entities, static entities, structures and the signature of each action; the body of
//                 an action, and a screen, named exactly; nothing named: the overview, in digest order
//   capabilities  the matched capabilities of the discover: operation, contract slices (a slice an earlier item wrote is
//                 named in contractAbove, never written twice; with logic steps a raw verb keeps only its arguments),
//                 dependencies, what the lane lacks, the grammar of the logic steps the intent names, the capability a
//                 named step needs (raise: logic.exception) and the signatures of the built-ins the intent names
//                 (functions, builtin-functions.mjs); a ui.* match named only by words logic shares, in an intent with no
//                 screen noun, goes last in its reduced form
//   example       one proven example (the discover's provenExample, else the example of the first match)
//   rules         the team rules (docs/CONHECIMENTO-DO-TIME.md) and the OutSystems padrões rules (ssam_reference
//                 {kind:"rules"}) that apply to the intent, chosen by its words and the categories of its capabilities
//   next          deliver (o11_deliver / studio_deliver) with the batch rule (every change of the request for a module in
//                 ONE job: BATCH_RULE) and fix (patch + basedOn), and how to work from the packet
//   environment   the installed extensions and Forge components for a need the intent names (environment-components.mjs)
//                 and, F6, `producers`: the producer signatures this workspace already captured that the intent needs (named,
//                 or of the module's app), each with the reference op ready; o11_deliver reuses them while the version stays
//   text          (right after module) for an intent that creates or changes data, logic or screens: the text route
//                 (text-packet.mjs): the exact read (or why none is needed), the exact delivery call with the ops of the
//                 text forms, per form its grammar, contract slice and one proven example, and the owner's rules, one line
//                 each. Sized before the shares (like next), at the richest level within TEXT_SHARE of the budget. Where it
//                 applies, the capabilities its forms cover keep one line (their JSON contract and steps go) and the JSON
//                 example of a covered capability goes by reference (the owner's re-test of 2026-10-12: the packet carried
//                 only the JSON forms and the session wrote 30 KB of JSON and a job builder in JavaScript)
// Sizing: next and the envelope first; each other section gets its share of the room left (SHARES), and the room a section
// does not use passes to the next one in that order; what the last sections leave unused goes back, once, to the first
// section with a cut. Inside its room a section keeps its items by relevance and leaves out the rest; every section that
// left something out says so once in `cuts`, with the call that returns it.
import { tokens, normalize } from './catalog.mjs';
import { indexLine, FOLD_RECORDS } from './module-digest.mjs';
import { guideText, guideSections } from './runtime-guides.mjs';
import { generatorFor, generatorCall, generatorCard } from './generators.mjs';
import { isScreenIntent, screenWords } from './osui-catalog.mjs';
import { functionNames } from './builtin-functions.mjs';
import { coveredBy } from './text-packet.mjs';
import { fitComponents } from './environment-components.mjs';
import { planSize, PLAN_MIN_ITEMS } from './code-plan.mjs';

export const PACKET_SCHEMA = 'ssam-packet/1';
export const PACKET_ORDER = ['module', 'text', 'environment', 'capabilities', 'example', 'rules', 'next'];
// The most of the budget the text section takes (its richest level that fits), and the environment section.
export const TEXT_SHARE = 0.4;
export const ENVIRONMENT_SHARE = 0.16;
// The answer ceiling of ssam.mjs (MAX_ANSWER_BYTES 40960) less the room its shaper keeps (budgetCeiling, 2048 bytes).
export const PACKET_BUDGET = 38912;
// The share of the room each section starts with; without a module its share goes to the others in proportion.
export const SHARES = { module: 0.44, capabilities: 0.26, example: 0.17, rules: 0.13 };
// Room kept for the cuts and the size field, whatever the sections hold.
const CUTS_ROOM = 1600;
const ORDER_RULE = 'sections in this order; each takes its share of the room and passes what it leaves to the next; inside a section the most relevant items come first and the rest is named in cuts with the call that returns it';
const WORK_RULE = 'Work from this packet: it holds what this task needs from the module, the contracts, a proven example and the team rules. Do not read docs, guides or the whole module again; for a part named in cuts, make the call it gives.';
// 2026-10-12 (production test): the packet described the mechanics of one delivery and its example was one step of a chain
// of jobs, so the session delivered one action per call (three deliveries and a rewrite of the batch: about 2 minutes).
export const BATCH_RULE = 'ALL the changes of this request for this module go in ONE job and ONE call (user exceptions, site properties or settings, structures, entities and every action together, in any order: the actions may call each other); separate jobs only for different modules, never one job per action or per step; a refusal brings every problem of the whole job at once';
export const PARALLEL_RULE = 'With 6 or more elements: ssam_code plan gives each subagent its prompt file and check; launch its batches in parallel, then send its final write. Each subagent writes its UTF-8 .flow/.html file, runs the given check until ok (shared data and stubs included; no Studio), and answers only the paths. Write shared data first. The main agent sends ONE ssam_code write with all files, never copying text; refusals name problems by file (files/<i>).';

const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const clip = (text, max) => { const s = String(text ?? ''); return s.length <= max ? s : s.slice(0, max) + '…(+' + (s.length - max) + ')'; };

// ---- words
// The words of a name: CamelCase, digits, slashes and underscores split ("PedidoItem" -> pedido item, "Order_Create" ->
// order), each through tokens() (accents folded, stemmed, stop words out).
export function nameWords(name) {
  const spaced = String(name ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[_\-./\\]+/g, ' ');
  return tokens(spaced);
}
// Words that say what to do or which kind of element, never which element of this module.
const GENERIC = new Set(tokens([
  'criar criacao alterar alteracao mudar mudanca change update atualizar corrigir correcao fix ajustar ajuste implementar implement',
  'fazer make construir build gerar generate remover remove excluir delete apagar renomear rename mover move adicionar incluir colocar',
  'action actions acao acoes server service client screen screens tela telas pagina paginas page pages block blocks bloco blocos widget widgets',
  'fluxo fluxos flow flows logica logic entidade entidades entity entities estrutura estruturas structure structures estatica estaticas static',
  'atributo atributos attribute attributes campo campos field fields registro registros record records modulo modulos module modules app',
  'aplicacao application crud lista listas list lists dado dados data tratamento handling usar using novo nova novos novas',
].join(' ')));
// A word of the intent stands for a word of a name when they are equal, or when the shorter (4+ letters) begins the
// other ("busca"/"buscar", "quot"/"quote", "exce"/"exception").
const hit = (w, n) => w === n || (Math.min(w.length, n.length) >= 4 && (n.startsWith(w) || w.startsWith(n)));
export function intentWords(intent) {
  const all = nameWords(intent);
  return [...new Set(all.filter(w => w.length >= 3 && !GENERIC.has(w)))];
}
// Names written whole in the intent ("Order_Create", "GetCustomer"): normalized words of 3+ characters.
const exactNames = intent => new Set(normalize(String(intent ?? '')).split(/[^a-z0-9_]+/).filter(w => w.length >= 3));

// ---- (a) module
const LEGEND = '@key: inspect path "@<key>" with this sourceSha256; "name: Type"; "?" optional input; req mandatory; auto autonumber; "->Entity delete=Rule" foreign key; "calls" and "called by" name actions';
const BODY_CHARS = 4000, SCREEN_CHARS = 2500, LINE_CHARS = 600;
// The items of the module section, scored against the intent: exact name 100, each intent word in the name 10, in the text
// (attributes, signature) 1 each up to 3; then the neighbours (below). Nothing named: every entity, structure and action
// signature with score 0 (the overview).
export function moduleItems(digest, intent, { screens = false } = {}) {
  const words = intentWords(intent); const exact = exactNames(intent);
  const S = Object.fromEntries(digest.sections.map(s => [s.id, s]));
  const items = []; let order = 0;
  const textWords = text => new Set(tokens(String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-./\\]+/g, ' ')));
  const score = (name, text) => {
    if (exact.has(normalize(name))) return 100;
    const own = nameWords(name);
    const named = words.filter(w => own.some(n => hit(w, n))).length;
    const inText = text ? (() => { const t = [...textWords(text)]; return Math.min(3, words.filter(w => !own.some(n => hit(w, n)) && t.some(n => hit(w, n))).length); })() : 0;
    return named * 10 + inText;
  };
  const folded = b => {
    const lines = b.text.split('\n');
    if (!((b.records ?? 0) > FOLD_RECORDS)) return b.text;
    const keep = lines.length - b.records + FOLD_RECORDS;
    return [...lines.slice(0, keep), '  … ' + (b.records - FOLD_RECORDS) + ' more records (the digest page of part "static entity records")'].join('\n');
  };
  for (const b of S.entities?.blocks ?? []) {
    const group = b.kind === 'StaticEntity' ? 'staticEntities' : 'entities';
    items.push({ group, kind: b.kind, key: b.key, name: b.name, order: order++, score: score(b.name, b.text.split('\n').slice(1).join(' ')), text: folded(b), refs: [...b.text.matchAll(/->([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]) });
  }
  for (const b of S.structures?.blocks ?? []) items.push({ group: 'structures', kind: b.kind, key: b.key, name: b.name, order: order++, score: score(b.name, b.text.split('\n').slice(1).join(' ')), text: b.text });
  const bodies = new Map((S.actions?.blocks ?? []).map(b => [b.key, b]));
  for (const a of digest.actions ?? []) {
    items.push({ group: 'actions', kind: a.kind, key: a.key, name: a.name, order: order++, score: score(a.name, a.in + ' ' + a.out), text: clip(indexLine(a), LINE_CHARS), calls: a.calls, calledBy: a.calledBy,
      refs: [...(a.in + ' ' + a.out).matchAll(/:\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]) });
  }
  const uiItems = (S.ui?.blocks ?? []).map(b => {
    const head = b.text.split('\n')[0]; const at = /^\S+(?: \S+)? ([^\s@]+) @/.exec(head)?.[1] ?? b.name;
    return { group: 'screens', kind: b.kind, key: b.key, name: b.name, order: order++, score: exact.has(normalize(b.name)) ? 100 : nameWords(at).filter((n, i, all) => all.indexOf(n) === i).filter(n => words.some(w => hit(w, n))).length * 10, text: clip(b.text, SCREEN_CHARS) };
  });
  // Neighbours, once each, from the most relevant element down: what an element named exactly references (the types of
  // its signature, the entities its foreign keys name) and the actions it calls or that call it, +50 (right after it);
  // what an element named by a word references, +3.
  const byName = new Map(items.filter(x => x.group !== 'actions').map(x => [x.name, x]));
  const actionsByName = new Map(items.filter(x => x.group === 'actions').map(x => [x.name, x]));
  const boosted = new Set();
  const boost = (y, x, bonus) => { if (y && y !== x && y.score < x.score && !boosted.has(y)) { y.score += bonus; boosted.add(y); } };
  for (const x of items.filter(x => x.score >= 10).sort((a, b) => b.score - a.score || a.order - b.order)) {
    const bonus = x.score >= 100 ? 50 : 3;
    for (const r of x.refs ?? []) boost(byName.get(r), x, bonus);
    if (x.score >= 100) for (const n of [...(x.calls ?? []), ...(x.calledBy ?? [])]) boost(actionsByName.get(n), x, bonus);
  }
  // The body of an action named exactly comes right after its signature.
  const extra = [];
  for (const x of items.filter(x => x.group === 'actions' && x.score >= 100)) { const b = bodies.get(x.key); if (b) extra.push({ group: 'bodies', key: x.key, name: x.name, order: x.order + 0.5, score: x.score, text: clip(b.text, BODY_CHARS) }); }
  const ui = uiItems.filter(x => x.score >= 100 || (screens && x.score >= 10));
  const all = [...items, ...extra, ...ui];
  const named = all.filter(x => x.score > 0);
  const chosen = named.length ? named : all.filter(x => x.group !== 'screens' && x.group !== 'bodies');
  return { words, selection: named.length ? 'named' : 'overview', items: chosen.sort((a, b) => b.score - a.score || a.order - b.order) };
}
// The capabilities of the kind of an action, screen or block the intent names exactly: "corrigir a action Order_Create"
// changes an existing server action whatever words the matcher read, so the packet carries that contract first. An entity
// named exactly is most often a domain noun ("pedido" for Pedido): it brings its elements, not a data capability.
export const KIND_CAPABILITIES = {
  ServerAction: ['logic.server-action', 'logic.flow'], ServiceAction: ['logic.service-action', 'logic.flow'], ClientAction: ['logic.client-action', 'logic.flow'],
  ScreenAction: ['logic.screen-action', 'logic.flow'], DataAction: ['logic.data-action', 'logic.flow'], Preparation: ['logic.preparation', 'logic.flow'],
};
const uiCapabilities = kind => (/Block/.test(kind ?? '') ? ['ui.block'] : /Screen/.test(kind ?? '') ? ['ui.screen'] : []);
export function namedCapabilities(digest, intent) {
  const out = [];
  for (const x of moduleItems(digest, intent, { screens: true }).items.filter(x => x.score >= 100 && x.group !== 'bodies'))
    for (const id of (x.group === 'screens' ? uiCapabilities(x.kind) : x.group === 'actions' ? KIND_CAPABILITIES[x.kind] : null) ?? [])
      if (!out.some(o => o.id === id)) out.push({ id, element: x.name, kind: x.kind });
  return out;
}
const GROUPS = ['entities', 'staticEntities', 'structures', 'actions', 'bodies', 'screens'];
export function moduleSection(found, intent, cap, { lane, screens = false } = {}) {
  if (!found) return { value: { none: true, note: 'no app given: pass app (a capture .oml or an open module name) for the elements of the module' }, cut: null };
  if (found.ok === false) return { value: { ok: false, target: found.target ?? null, error: clip(found.error ?? found.code ?? 'the module could not be read', 400),
    read: { tool: 'ssam_map', arguments: { lane, target: found.target ?? '<capture.oml or Module>', view: 'digest' } } }, cut: null };
  const d = found.digest;
  const { words, selection, items } = moduleItems(d, intent, { screens });
  const read = { tool: 'ssam_map', arguments: { lane, target: found.file, view: 'digest', expectedSourceSha256: found.sourceSha256 } };
  const value = { name: d.module.name, kind: d.module.kind ?? null, key: d.module.key, file: found.file, sourceSha256: found.sourceSha256,
    elements: d.elements ?? null, actionsTotal: (d.actions ?? []).length,
    selection: selection === 'named' ? 'the elements the intent names, most relevant first' : 'nothing named by the intent: the overview, in digest order',
    words, legend: LEGEND };
  for (const g of GROUPS) value[g] = [];
  const left = Object.fromEntries(GROUPS.map(g => [g, 0]));
  // Room for shown (a count per group) and read, added after the items.
  let used = bytes(value) + bytes(read) + 120;
  for (const x of items) {
    const add = bytes(x.text) + 1;
    if (used + add > cap) { left[x.group]++; continue; }
    value[x.group].push(x.text); used += add;
  }
  for (const g of GROUPS) if (!value[g].length) delete value[g];
  const leftTotal = Object.values(left).reduce((n, v) => n + v, 0);
  const shown = Object.fromEntries(GROUPS.filter(g => value[g]).map(g => [g, value[g].length]));
  value.shown = shown;
  value.read = read;
  return { value, cut: leftTotal ? { section: 'module', left: Object.fromEntries(Object.entries(left).filter(([, v]) => v)), recover: read } : null };
}

// ---- (b) capabilities
// Words a ui.* capability shares with logic ("list", "filter", "input"...): a ui match named only by them, in an intent
// without a screen noun (screenWords), is not what the intent builds.
const LOGIC_WORDS = new Set(['list', 'lists', 'lista', 'listas', 'sort', 'filter', 'filtro', 'search', 'busca', 'input', 'inputs', 'output', 'outputs', 'parameter', 'parameters',
  'action', 'actions', 'acao', 'acoes', 'assign', 'call', 'current', 'value', 'values', 'data', 'date', 'time', 'text', 'field', 'record', 'records', 'if', 'each', 'node',
  'server', 'client', 'variable', 'aggregate', 'max', 'append', 'user']);
// A direct match the text section does not cover whose every word is a word that named the text route (input.textWhy).
export function offTextMatch(input, m) {
  const forms = input.textForms ?? [];
  if (!forms.length || m.from === 'module' || coveredBy(forms, m.id)) return false;
  const named = new Set((input.textWhy ?? []).flatMap(w => tokens(String(w))));
  const why = (m.why ?? []).flatMap(w => tokens(String(w)));
  return why.length > 0 && why.every(w => named.has(w));
}
// forms(match) -> richest first; the first form that fits the room left is kept.
export function capabilitiesSection(input, cap, { lane, screens = true } = {}) {
  const { matches = [], unavailable = [] } = input;
  // The forms of the text section (text-packet.mjs): a capability one of them writes keeps one line (its JSON contract,
  // operation and the grammar of the JSON logic steps are the JSON form of what the text writes).
  const textForms = input.textForms ?? [];
  const covered = m => (textForms.length ? coveredBy(textForms, m.id) : null);
  const steps = input.steps && !(textForms.includes('ssam-flow/1')) ? input.steps : null;
  // A capability the text does not cover, matched only by the words that named the text route ("action" for
  // timer.schedule in "crie as actions no mesmo módulo"), goes last in its reduced form.
  const offText = m => offTextMatch(input, m);
  // When the intent names logic steps (the compact logic op builds the actions), a raw verb of a contract keeps its
  // arguments and leaves its prose to one ssam_reference call (2026-10-12: the six raw verbs took 2.6 KB of the 5 KB of
  // logic.flow, and the batch was written with the logic op).
  let verbsReduced = false;
  const slices = (pointers, form) => {
    const out = input.slices(pointers, form);
    if (!steps) return out;
    for (const [p, v] of Object.entries(out)) if (/^verbs\.verbs\./.test(p) && v && typeof v === 'object' && !Array.isArray(v) && (v.required || v.optional)) {
      out[p] = [v.kind, 'required: ' + (v.required ?? []).join(', '), 'optional: ' + (v.optional ?? []).join(', ')].filter(Boolean).join('; ');
      verbsReduced = true;
    }
    return out;
  };
  // An intent that builds no screen keeps its ui.* matches (named by generic words: list, input, filter, search) after the
  // others and in their reduced form (operation and the expand that returns them): 2026-10-12, an intent of server actions
  // got ui.dropdown-search, ui.list and ui.form before logic.server-action, which the room then left out.
  const offTopic = m => !screens && m.from !== 'module' && /^ui\./.test(String(m.id)) && (m.why ?? []).every(w => normalize(String(w)).split(/[^a-z0-9]+/).filter(Boolean).every(t => LOGIC_WORDS.has(t)));
  const aside = m => offTopic(m) || offText(m);
  const direct = [...matches.filter(m => m.via === 'match' && !aside(m)), ...matches.filter(m => m.via === 'match' && aside(m))];
  const value = { matched: direct.length, items: [] };
  const requires = matches.filter(m => m.via === 'dependency').map(m => m.id);
  if (requires.length) value.requires = requires;
  if (unavailable.length) value.unavailable = unavailable.slice(0, 4).map(u => ({ id: u.id, reason: clip(u.reason, 240), ...(u.alternative ? { alternative: clip(typeof u.alternative === 'string' ? u.alternative : JSON.stringify(u.alternative), 200) } : {}) }));
  if (steps) value.steps = { kinds: steps.kinds, shape: steps.shape, grammar: steps.grammar };
  if (bytes(value) > cap && value.steps) delete value.steps.shape;
  if (bytes(value) > cap && value.steps) value.steps = { kinds: steps.kinds, grammar: Object.fromEntries(Object.entries(steps.grammar ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v) : v])) };
  // The built-ins the intent names (builtin-functions.mjs): their signatures within a third of the room, else their names,
  // else left out and named in the cut.
  let functionsCut = null;
  if (input.functions) {
    const kept = [input.functions, functionNames(input.functions)].find(f => bytes(f) + 16 <= cap / 3);
    if (kept) value.functions = kept;
    if (kept !== input.functions) functionsCut = kept ? 'names only' : input.functions.signatures.length;
  }
  const expand = id => ({ tool: 'ssam_discover', arguments: { lane, expand: id + ':contract+example' } });
  const said = m => (m.from === 'module' ? { named: m.why?.[0] ?? null } : { why: m.why ?? [] });
  // A contract slice an earlier item already wrote (the raw verbs and the reference grammar under every logic capability:
  // about 3.5 KB repeated per item, 2026-10-12) is not written again: the item names it in contractAbove. The form an
  // earlier item wrote is kept (a full slice is never cut to compact below it, a compact one is not repeated in full).
  const written = new Set();
  const fresh = m => [...new Set(m.contract ?? [])].filter(p => !written.has(p));
  const above = m => [...new Set(m.contract ?? [])].filter(p => written.has(p));
  const forms = m => [
    { id: m.id, title: m.title, ...said(m), level: m.level, operation: m.route?.operation ?? null, contract: slices(fresh(m), 'full'), ...(above(m).length ? { contractAbove: above(m) } : {}), ...(m.depends?.length ? { depends: m.depends.map(d => d.id) } : {}),
      ...(m.guidance ? { guidance: clip(m.guidance, 600) } : {}), ...(m.limits?.length ? { limits: m.limits.map(l => clip(typeof l === 'string' ? l : l.title ?? JSON.stringify(l), 200)) } : {}) },
    { id: m.id, title: m.title, ...said(m), level: m.level, operation: clip(m.route?.operation ?? '', 900) || null, contract: slices(fresh(m), 'compact'), ...(above(m).length ? { contractAbove: above(m) } : {}), ...(m.guidance ? { guidance: clip(m.guidance, 240) } : {}) },
    { id: m.id, title: m.title, operation: clip(m.route?.operation ?? '', 300) || null, expand: expand(m.id).arguments.expand },
  ];
  const left = [];
  const inText = [];
  // Room for the verbs note, written after the items when a raw verb was reduced.
  let used = bytes(value) + (steps ? 240 : 0);
  for (const m of direct) {
    const form = covered(m) ? [{ id: m.id, title: m.title, ...said(m), inText: covered(m) }].find(f => used + bytes(f) + 1 <= cap)
      : forms(m).slice(aside(m) ? 2 : 0).find(f => used + bytes(f) + 1 <= cap);
    if (!form) { left.push(m.id); continue; }
    if (form.inText) inText.push(m.id);
    value.items.push(form); used += bytes(form) + 1;
    for (const p of Object.keys(form.contract ?? {})) written.add(p);
  }
  if (inText.length) value.inText = { note: 'written by the text section (text): its forms, grammar and proven example; the JSON form of one of them by expand', expand: { tool: 'ssam_discover', arguments: { lane, expand: inText.slice(0, 6).map(id => id + ':contract+example').join(',') } } };
  if (verbsReduced && value.items.some(i => Object.keys(i.contract ?? {}).some(p => /^verbs\.verbs\./.test(p))))
    value.verbs = { note: 'raw verbs reduced to their arguments: the logic op builds the actions; one verb whole (its effect and references)', read: { tool: 'ssam_reference', arguments: { lane, kind: 'api', query: { op: '<verb>' } } } };
  const reduced = value.items.filter(f => f.expand).map(f => f.id);
  const functions = functionsCut === null ? {} : { functions: functionsCut };
  if (!left.length && !reduced.length && functionsCut !== null)
    return { value, cut: { section: 'capabilities', left: functions, recover: input.functions.more } };
  return { value, cut: left.length || reduced.length ? { section: 'capabilities', left: { capabilities: left, reducedToOperation: reduced, ...functions },
    recover: { tool: 'ssam_discover', arguments: { lane, expand: [...reduced, ...left].slice(0, 6).map(id => id + ':contract+example').join(',') } } } : null };
}

// ---- (c) example
export function exampleSection(input, cap, { lane }) {
  const { proven = null, example = null } = input;
  const source = proven ?? (example ? { for: input.exampleFor ?? null, job: example.job, path: example.path, base: example.base ?? null, whole: !example.fragment, opsTotal: example.opsTotal, ops: example.ops,
    ...(example.undefinedAliases?.length ? { undefinedAliases: example.undefinedAliases } : {}), note: example.note } : null);
  if (!source) return { value: { none: true, note: 'no proven job of this lane matches the words of the intent' }, cut: null };
  const reference = { tool: 'ssam_reference', arguments: { lane, kind: 'example', query: { id: source.job } } };
  // The JSON job of a capability the text section writes: by reference (the text section carries the proven example of its
  // form). Not a cut: nothing the request needs is left out.
  const textForms = input.textForms ?? [];
  const forCapability = source.for ?? input.exampleFor ?? null;
  const matchOf = id => (input.matches ?? []).find(m => m.id === id && m.via === 'match');
  const own = !forCapability || coveredBy(textForms, forCapability);
  if (textForms.length && (own || (matchOf(forCapability) && offTextMatch(input, matchOf(forCapability)))))
    return { value: { for: forCapability, job: source.job, path: source.path, opsTotal: source.opsTotal ?? (source.ops ?? []).length,
      note: own ? 'the JSON form of this change, by reference: write it in the text form (text: its grammar and proven example)'
        : 'a JSON job of a capability matched only by the words of the text route, by reference', reference }, cut: null };
  const head = { for: source.for ?? null, job: source.job, path: source.path, ...(source.description ? { description: source.description } : {}), base: source.base ?? null,
    ...(source.level ? { level: source.level } : {}), ...(source.expectedMessages?.length ? { expectedMessages: source.expectedMessages } : {}) };
  const ops = source.ops ?? [];
  const total = source.opsTotal ?? ops.length;
  const forms = [
    { ...head, whole: ops.length === total, opsShown: ops.length, opsTotal: total, ...(source.undefinedAliases ? { undefinedAliases: source.undefinedAliases } : {}), ops, reference },
    ...(ops.length > 6 ? [{ ...head, whole: false, opsShown: 6, opsTotal: total, note: 'FRAGMENT: the first 6 ops; the whole job by reference', ops: ops.slice(0, 6), reference }] : []),
    ...(ops.length > 2 ? [{ ...head, whole: false, opsShown: 2, opsTotal: total, note: 'FRAGMENT: the first 2 ops; the whole job by reference', ops: ops.slice(0, 2), reference }] : []),
    { job: source.job, path: source.path, opsTotal: total, note: 'by reference only: the room of the packet', reference },
  ];
  const form = forms.find(f => bytes(f) <= cap) ?? forms.at(-1);
  return { value: form, cut: form.opsShown === total ? null : { section: 'example', left: { ops: total - (form.opsShown ?? 0) }, recover: reference } };
}

// ---- (d) rules
// Topics: the categories of the matched capabilities and the words of the intent; every model change also has the topics
// naming and job (how a job is written). A rule of the 35 OutSystems padrões has its topics by id (PADROES_TOPICS), a
// lesson of the team rules by its heading (LESSON_TOPICS; a heading not listed: the topics of its own words), and an item
// of the "Como trabalhar" list none (the server instructions carry them): it comes only when the intent says its words.
const TOPIC_WORDS = {
  logic: 'action actions acao acoes logica logic fluxo flow crud aggregate agregado sql loop laco foreach assign',
  exception: 'excecao excecoes exception exceptions tratamento handler handlers raise',
  ui: 'tela telas screen screens pagina page widget widgets block bloco formulario form botao button css layout menu html prototipo prototype',
  data: 'entidade entidades entity entities registro registros record records tabela table sql aggregate banco database atributo atributos dados consulta query join crud',
  list: 'lista listas list lists ordenar sort filtrar filter listfilter listsort listindexof',
  integration: 'rest soap api apis integracao integration endpoint',
  timer: 'timer timers agenda schedule agendamento batch',
  publish: 'publicar publish publicacao consumidor consumidores consumer consumers produtor producer',
  security: 'role roles permissao permissoes autorizacao seguranca security anonimo anonymous',
  agent: 'agente agentes subagente subagentes agent agents subagent subagents paralelo parallel',
  merge: 'merge oml omls ponte bridge',
};
const TOPIC_OF_WORD = new Map();
for (const [t, list] of Object.entries(TOPIC_WORDS)) for (const w of list.split(' ')) TOPIC_OF_WORD.set(w, [...(TOPIC_OF_WORD.get(w) ?? []), t]);
// Words of the intent that name a technique a rule speaks of (a topic word already counts through its topic): each one
// the rule's text holds adds 3. Domain nouns of the intent ("pedido", "quote") never count: they are no rule's subject.
const TECH = new Set(('json jsonserialize jsondeserialize javascript script visible hidden style expand inline timeout cascade guid generateguid count mod '
  + 'changed attributes site property properties variavel variable variaveis variables local client session lambda listany listall mapping '
  + 'listappend comentario comentarios comment comments descricao description roles anonymous expectedmessages patch utf write').split(' '));
// A category of a matched capability gives its topic when the match is strong (score 7+) or comes from an element the
// module holds; a weaker match (a word such as "action" or "crud" that many capabilities share) does not.
const STRONG_MATCH = 7;
const CATEGORY_TOPICS = { logic: ['logic'], ui: ['ui'], data: ['data'], integration: ['integration'], security: ['security'], process: ['timer'], refactor: ['logic'], delivery: ['publish'] };
// The lessons of docs/CONHECIMENTO-DO-TIME.md by the start of their heading (normalized).
export const LESSON_TOPICS = [
  ['acesso a dados', ['data', 'logic', 'list']], ['prototipo aprovado', ['ui']], ['css', ['ui']], ['lista: refresh parcial', ['ui', 'list']],
  ['o11: republicar os consumidores', ['publish']], ['odc: o que o studio recusa', ['logic', 'data']], ['o11: agenda de timer', ['timer']],
  ['odc (client) e o11 (server): lambda', ['list', 'logic']], ['o11: entidade com', ['data']], ['o11: nunca redeclare', ['logic', 'publish']],
  ['merge direto de oml', ['merge']], ['jobs em arquivo', ['job']], ['subagentes', ['agent']], ['mudanca de fachada', []], ['varios agentes', ['agent']],
  ['expectedmessages', ['job']], ['regra de escopo', ['job']], ['todo codigo gerado segue', []],
];
const RULES_MAX = 16;
export const PADROES_TOPICS = {
  L1: ['logic'], L2: ['logic'], L3: ['logic'], L4: ['logic'], L5: ['logic', 'ui'], L6: ['logic', 'integration'], L7: ['logic', 'data'],
  T1: ['logic', 'list'], T2: ['logic', 'list'], T3: ['logic', 'list', 'data'], T4: ['list', 'ui'],
  D1: ['ui', 'data'], D2: ['data', 'list'], D3: ['data'], D4: ['ui', 'integration'], D5: ['logic', 'data'],
  S1: ['ui'], S2: ['ui', 'logic'], S3: ['integration', 'exception'], S4: ['integration'],
  U1: ['ui'], U2: ['ui'], U3: ['ui'], U4: ['ui'], U5: ['ui'],
  N1: ['naming'], N2: ['naming'], N3: ['logic'], N4: ['logic', 'ui'],
  E1: ['logic'], E2: ['ui'], E3: ['data'], AR1: ['data', 'security'], AR2: ['security', 'logic'], AR3: ['timer'], P7: ['timer'],
};
const plain = text => normalize(String(text ?? '')).split(/[^a-z0-9_]+/).filter(Boolean);
const topicsOfText = text => [...new Set(plain(text).flatMap(w => TOPIC_OF_WORD.get(w) ?? []))].sort();
export function intentTopics(intent, matches = [], categories = new Map()) {
  const out = new Set(topicsOfText(intent));
  const direct = matches.filter(m => m.via === 'match');
  for (const m of direct.filter(m => m.from === 'module' || (m.score ?? 0) >= STRONG_MATCH)) for (const t of CATEGORY_TOPICS[categories.get(m.id) ?? m.category] ?? []) out.add(t);
  if (direct.length) { out.add('naming'); out.add('job'); }
  return [...out].sort();
}
const lessonTopics = title => { const t = normalize(title); const row = LESSON_TOPICS.find(([start]) => t.startsWith(start)); return row ? row[1] : topicsOfText(title); };
// The rule units of the two documents, in document order: each item of a section's list ("- **Title.** text" or "- text")
// and each "### " lesson of the team rules, each row of the padroes table. Lane: a lesson titled "O11: ..." is O11 only,
// "ODC: ..." ODC only; AR1 O11 only.
export function ruleUnits(read = guideText) {
  const units = [];
  const team = read('rules');
  for (const s of guideSections(team)) {
    const head = s.text.split(/\r?\n### /)[0];
    for (const m of head.matchAll(/^- ([\s\S]*?)(?=\r?\n- |\s*$(?![\s\S]))/gm)) {
      const text = m[1].replace(/\s*\r?\n\s*/g, ' ').trim();
      const title = (/^\*\*(.+?)\*\*/.exec(text)?.[1] ?? text.split(/[:.]/)[0]).replace(/[.:]$/, '').trim();
      units.push({ from: 'time', id: s.id, title, text: text.replace(/\*\*/g, ''), topics: LESSON_TOPICS.find(([start]) => normalize(title).startsWith(start))?.[1] ?? [] });
    }
    for (const l of guideSections(s.text, 3)) {
      const lane = /^O11\b/.test(l.title) && !/ODC/.test(l.title) ? 'o11' : /^ODC\b/.test(l.title) && !/O11/.test(l.title) ? 'odc' : null;
      units.push({ from: 'time', id: s.id, title: l.title, ...(lane ? { lane } : {}), text: l.text.replace(/^### .*\r?\n/, '').trim(), topics: lessonTopics(l.title) });
    }
  }
  for (const m of read('padroes').matchAll(/^\| ([A-Z]{1,2}\d+) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|\s*$/gm)) {
    if (!PADROES_TOPICS[m[1]]) continue;
    units.push({ from: 'padroes', id: m[1], text: m[2].trim(), ...(/só O11/.test(m[5]) ? { lane: 'o11' } : /só ODC/.test(m[5]) ? { lane: 'odc' } : {}), topics: PADROES_TOPICS[m[1]] });
  }
  return units;
}
const RULE_CHARS = 1400, RULE_TEXT_CHARS = 360;
export function rulesSection(input, cap, { lane, read = guideText } = {}) {
  const { intent = '', matches = [], categories = new Map() } = input;
  const topics = intentTopics(intent, matches, categories);
  const tech = [...new Set(plain(intent).filter(w => TECH.has(w)))];
  const all = { tool: 'ssam_reference', arguments: { lane, kind: 'rules', query: 'all' } };
  const padroes = { tool: 'ssam_reference', arguments: { lane, kind: 'rules', query: 'padroes' } };
  let units; try { units = ruleUnits(read); } catch (error) { return { value: { error: clip(error.message, 300), all, padroes }, cut: null }; }
  // A shared topic weighs more the fewer rules have it (1 + ln(rules / rules with the topic)): "exception" or "naming"
  // says more about a rule than "logic", which most rules share. A technique word the rule holds adds 3.
  const lanes = units.filter(u => !u.lane || u.lane === lane);
  const df = new Map(); for (const u of lanes) for (const t of u.topics ?? []) df.set(t, (df.get(t) ?? 0) + 1);
  const weight = t => 1 + Math.log(lanes.length / (df.get(t) ?? lanes.length));
  const scored = lanes.map((u, order) => {
    const shared = (u.topics ?? []).filter(t => topics.includes(t));
    const text = plain(u.text);
    const said = tech.filter(w => text.some(n => hit(w, n))).length;
    const score = Math.round((shared.reduce((s, t) => s + weight(t), 0) + said * 3) * 1000);
    return score > 0 ? { u, order, score } : null;
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.order - b.order);
  const value = { chosen: 'by the words of the intent and the categories of its capabilities, at most ' + RULES_MAX, topics, ...(tech.length ? { words: tech } : {}), items: [] };
  let used = bytes(value) + bytes(all) + bytes(padroes) + 24; let left = 0;
  for (const { u } of scored) {
    // With a text section a lesson keeps its first lines (its JSON examples are the JSON form the text replaces).
    const item = u.from === 'padroes' ? { from: 'padroes', id: u.id, rule: u.text, ...(u.lane ? { lane: u.lane } : {}) } : { from: 'time', section: u.id, title: u.title, rule: clip(u.text, input.textForms?.length ? RULE_TEXT_CHARS : RULE_CHARS) };
    const add = bytes(item) + 1;
    if (value.items.length >= RULES_MAX || used + add > cap) { left++; continue; }
    value.items.push(item); used += add;
  }
  value.all = all; value.padroes = padroes;
  return { value, cut: left ? { section: 'rules', left: { rules: left }, recover: all } : null };
}

// ---- (e) next
// The text route of the intent (text-routes.mjs sectionOf: data as ssam-ddl/1, an action as ssam-flow/1, a screen as
// ssam-html/1), when it has one: its ssam_code calls with the module's name.
const CODE_PART = { 'data.ddl': 'ddl', 'logic.flow': 'logic', 'ui.screen-html': 'html', 'ui.screen-html-edit': 'html' };
function codeOfRoute(route, lane, name) {
  if (!route?.code?.write || !CODE_PART[route.id]) return null;
  const named = call => (call?.arguments && typeof call.arguments === 'object'
    ? { ...call, arguments: Object.fromEntries(Object.entries(call.arguments).map(([k, v]) => [k, (k === 'module' || k === 'target') && typeof v === 'string' && v.startsWith('<') && name !== '<Module>' ? name : v])) } : call);
  return { id: route.id, form: route.form, part: CODE_PART[route.id],
    grammar: { tool: 'ssam_code', arguments: { lane, action: 'grammar', part: CODE_PART[route.id] }, why: 'the syntax and a from-scratch example (an empty module starts here)' },
    read: named(route.code.read), write: named(route.code.write) };
}

// `expand`: the expand, detail or type of the same call (2026-10-11): the packet carries its own contract slices, so the
// parts asked by name are its next call, never dropped in silence.
export function nextSection({ lane, intent = '', module = null, operations = null, expand = null, textForms = [], textRoute = null }) {
  const name = module?.ok !== false && module?.digest?.module?.name ? module.digest.module.name : '<Module>';
  // With a text section the ops are those of text.call (the text forms) and the JSON ops of what no text covers.
  const ops = textForms.length ? ['<the ops of text.call, in its order>', '<JSON ops only for what no text form covers>'] : ['<ops written from this packet>'];
  const json = lane === 'o11'
    ? { tool: 'o11_deliver', arguments: { module: name, job: { ops }, authorize: '<the user\'s own words, or none with a standing grant>' } }
    : { tool: 'studio_deliver', arguments: { feature: '<Feature>', module: name, job: { ops }, owners: ['<Owner>'], changes: ['<Change>'] } };
  // A data, action or screen intent is written as code (ssam_code, the same delivery underneath); the JSON ops stay the way
  // for what the code forms do not write.
  const code = codeOfRoute(textRoute, lane, name);
  // A generator writes the whole family the intent asks for (a REST API from its URLs, the standard actions of the entities;
  // 2026-10-13): its one op is the job and its card next.generator, the same way for each (generators.mjs generatorFor).
  const generator = generatorFor(intent);
  const deliver = generator ? generatorCall(generator, lane, name) : code ? code.write : json;
  const summary = 'without errors it answers "entregue" with a summary of what it created (each action with its inputs and outputs): no map of the module after it';
  // Six or more elements written by hand are split by ssam_code plan; a generator writes its whole family in one op, so a
  // generated intent never asks for a plan.
  const planned = generator ? 0 : planSize(intent, module?.digest);
  return { work: WORK_RULE,
    ...(generator ? { generator: { ...generatorCard(generator, lane, name), why: generator.why } } : {}),
    ...(planned >= PLAN_MIN_ITEMS ? { plan: { tool: 'ssam_code', arguments: { lane, action: 'plan', module: name, items: '<one per element: kind, name, intent, signature>' }, why: `${planned} elements: ssam_code splits them into parallel batches with prompts, context and checks; launch what it returns, then send its final write` } } : {}),
    deliver: { ...deliver, batch: BATCH_RULE, parallel: PARALLEL_RULE, why: generator ? `one call: the ${generator.op} op is the job (put the other changes of this module in the same job); ${summary}` : code ? `one call: ssam_code writes the ${code.form} text through ${json.tool} (it captures the live module, validates and merges; ${summary})` : `one call: it captures the live module, validates and merges; ${summary}` },
    ...(code ? { code: { id: code.id, form: code.form, part: code.part, grammar: code.grammar, read: code.read, json: { tool: json.tool, why: 'the JSON ops, for what the code forms do not write' } } } : {}),
    fix: { how: 'a refusal comes once with every problem of every phase (problems[]: phase, pointer, fix, patch when certain, also by name in patchByName) and names its job in nextBasedOn {job, sha256}: correct all of them in one call with patch (paths by name: actions/<Action>/steps/<as>/...) + basedOn, or with only the changed actions as a partial job + basedOn; never resend the whole job' + (lane === 'o11' ? '; on O11 also closePrevious with the refused taskId' : ''),
      arguments: { patch: ['<the patches returned (patchByName) plus your fixes>'], basedOn: { job: '<nextBasedOn.job>', sha256: '<nextBasedOn.sha256>' } } },
    ...(operations?.length ? { operations } : {}),
    ...(expand ? { expand: { tool: 'ssam_discover', arguments: { lane, expand }, why: 'the parts this call asked by expand, detail or type: the packet answers its own sections, they come in this call' } } : {}),
    after: 'after app or screen work, the links of ssam_app_url' };
}

// ---- the packet
// input: {lane, intent, app, basis, matches, unavailable, categories (id -> category), slices (pointers, 'full'|'compact')
// -> contract slices, steps, proven, example, exampleFor, module (moduleDigest's answer, or null without app), operations}.
export function workPacket(input, { budgetBytes = PACKET_BUDGET, read = guideText } = {}) {
  const { lane, intent } = input;
  // The text section (text-packet.mjs packetTextSection: {value, levels, covers}), at its richest level within TEXT_SHARE
  // of the budget; a section with no level that fits is left out and named in cuts (its call is ssam_discover expand).
  const textLevels = input.text?.levels ?? [];
  const text = textLevels.find(l => bytes(l) <= budgetBytes * TEXT_SHARE) ?? null;
  const textCut = input.text && text !== textLevels[0]
    ? { section: 'text', left: text ? { level: textLevels.indexOf(text) } : { text: input.text.value.id }, recover: { tool: 'ssam_discover', arguments: { lane, intent, packet: true, budgetBytes: PACKET_BUDGET } } } : null;
  const textForms = text ? input.text.covers : [];
  input = { ...input, textForms, textWhy: text ? input.text.value.why ?? [] : [] };
  // The environment section (environment-components.mjs): the installed extensions and Forge components for the needs the
  // intent names, at its richest level within ENVIRONMENT_SHARE of the budget; a refusal (no listing) as it is.
  const components = !input.environment ? null : input.environment.ok === false ? input.environment
    : fitComponents(input.environment, budgetBytes * ENVIRONMENT_SHARE) ?? { ok: true, schema: input.environment.schema, needs: input.environment.needs, components: input.environment.components.length,
      note: 'reduced by budget', recover: { tool: 'ssam_discover', arguments: { lane, intent: input.environment.needs.join(' ') + ' no ambiente' } } };
  // F6 (producer-signatures.mjs packetProducers): the producer signatures the workspace already captured that the intent
  // needs, each with its reference op, in the environment section (what the environment gives this request).
  const producers = input.producers?.producers?.length ? input.producers : null;
  const environment = producers ? { ...(components ?? { ok: true }), producers } : components;
  const next = nextSection(input);
  const screens = isScreenIntent(intent, input.matches ?? []);
  const envelope = { ok: true, schemaVersion: PACKET_SCHEMA, lane, intent, ...(input.app ? { app: input.app } : {}), basis: input.basis ?? null,
    packet: { order: PACKET_ORDER, rule: ORDER_RULE }, module: null, text, environment, capabilities: null, example: null, rules: null, next, cuts: [],
    size: { bytes: 99999999, budgetBytes, status: 'reduced' } };
  const room = budgetBytes - bytes(envelope) - CUTS_ROOM;
  const withModule = !!input.module && input.module.ok !== false;
  const shares = withModule ? SHARES : Object.fromEntries(Object.entries(SHARES).filter(([k]) => k !== 'module').map(([k, v]) => [k, v / (1 - SHARES.module)]));
  const build = {
    module: cap => moduleSection(input.module ?? null, intent, cap, { lane, screens }),
    capabilities: cap => capabilitiesSection(input, cap, { lane, screens: screenWords(intent).length > 0 }),
    example: cap => exampleSection(input, cap, { lane }),
    rules: cap => rulesSection(input, cap, { lane, read }),
  };
  // `shrink` takes bytes off the last sections when the whole is still above the budget (never expected; kept so the
  // budget holds whatever the measures).
  const assemble = shrink => {
    const out = structuredClone(envelope); const cuts = [];
    let carry = 0;
    for (const id of ['module', 'capabilities', 'example', 'rules']) {
      const cap = Math.max(256, Math.floor(Math.max(0, room) * (shares[id] ?? 0)) + carry - (shrink[id] ?? 0));
      const { value, cut } = build[id](cap);
      out[id] = value; if (cut) cuts.push(cut);
      carry = Math.max(0, cap - bytes(value));
    }
    if (textCut) cuts.push(textCut);
    out.cuts = cuts.sort((a, b) => PACKET_ORDER.indexOf(a.section) - PACKET_ORDER.indexOf(b.section));
    out.size = { bytes: 0, budgetBytes, status: cuts.length ? 'reduced' : 'within' };
    for (let i = 0, m = bytes(out); i < 6 && out.size.bytes !== m; i++) { out.size.bytes = m; m = bytes(out); }
    return out;
  };
  const shrink = {};
  let packet = assemble(shrink);
  for (let round = 0; packet.size.bytes > budgetBytes && round < 12; round++) {
    const over = packet.size.bytes - budgetBytes + 64;
    const id = ['rules', 'example', 'capabilities', 'module'][round % 4];
    shrink[id] = (shrink[id] ?? 0) + over;
    packet = assemble(shrink);
  }
  // The room a later section left (a whole example smaller than its share, rules held at RULES_MAX) goes back to the first
  // section with a cut, in the declared order, once per section (2026-10-12: logic.server-action was cut while 3 KB of
  // the budget stayed unused). A pass that would pass the budget is not kept.
  for (const id of ['module', 'capabilities', 'example', 'rules']) {
    const left = budgetBytes - packet.size.bytes - 64;
    if (left < 256 || !packet.cuts.some(c => c.section === id)) continue;
    const tried = { ...shrink, [id]: (shrink[id] ?? 0) - left };
    const again = assemble(tried);
    if (again.size.bytes <= budgetBytes) { Object.assign(shrink, tried); packet = again; }
  }
  return packet;
}
