// Tool routing for ssam_discover, the single entry of every SSAM request. A model change is answered by discover()
// (discovery.mjs) exactly as before; any other request (open a module, connect, publish, deploy, create an app, data,
// Service Center, Portal, debugger, long tasks, evidence...) also gets a top-level `tools` section: the exact MCP tool,
// the verb (command/action/op/operation/kind/...), an arguments template, when to use it, preconditions and the next call.
//
// The matcher is separate from capability scoring on purpose. It reads ONE data file, catalog/tools.json
// (ssam-tool-routes/1), with its own vocabulary ('@'-keyed synonyms, never a form of the text), conjunction triggers per
// route and veto terms. It never reads the capability index, its synonyms, keywords, titles or scores, and discover()
// is called unchanged: an intent without a tool route returns the very object discover() returned. tools.json and this
// module are not part of the index identity, so editing them never rebuilds the capability index.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from './catalog.mjs';
import { ANSWER_BUDGETS } from './answer-size.mjs';
import { namedGenerators, describeGenerator } from './generators.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TOOLS_FILE = path.join(here, 'catalog', 'tools.json');
export const TOOL_ROUTES_SCHEMA = 'ssam-tool-routes/1';
export const MAX_TOOLS = 3;
// Effect of a route on the live system (tools.json `effect`, per tool with per-verb overrides; tool-routes.test.mjs keeps
// it in line with the live annotations readOnlyHint/destructiveHint): 'read' changes nothing; 'write' writes, publishes,
// deletes or changes live data, environment, session or Studio state; 'delivery' is the proof/delivery path of a model
// change (ssam_job, o11_job, studio_deliver, o11_deliver). A gap route offers no tool ('gap').
export const EFFECTS = ['read', 'write', 'delivery'];
export const MODEL_STEP_EFFECTS = new Set(['read', 'delivery']);

// Articles, prepositions and pronouns only. Verbs such as criar/create/add stay: "criar uma aplicação" must keep `criar`.
// 'no' (pt "in the") is here. The flow node "nó" loses its accent in normalize() and would meet it, so the lexer reads
// the accented raw word first (nodeToken): "nó" is the token `node`, and "nós" too after an article or a quantifier
// ("os nós da action"), never the pronoun ("nós precisamos publicar").
const STOP = new Set(('a o os as um uma uns umas de do da dos das e ou que com em no na nos nas num numa por para pelo pela pelos pelas ao aos '
  + 'me meu minha meus minhas se seu sua seus suas este esta estes estas isto esse essa esses essas isso lhe eu voce '
  + 'the an of to for and or with in on at by from into is are be been it its this that these those as my me do does did '
  + 'can could should would will you your we our').split(/\s+/));

// Plural strip WITHOUT the derivational cut of catalog.mjs stem(): "publicacao" never meets the adjective "publica".
export function singular(w) {
  if (w.length <= 3 || /\d/.test(w) || w.includes('_')) return w;
  if (w.endsWith('oes')) return w.slice(0, -3) + 'ao';
  if (w.endsWith('eis') && w.length > 5) return w.slice(0, -3) + 'el'; // variaveis, papeis, disponiveis
  if (w.endsWith('ores') && w.length > 6) return w.slice(0, -2); // consumidores, produtores, provedores, valores
  if (w.endsWith('gens')) return w.slice(0, -4) + 'gem'; // mensagens
  if (w.endsWith('zes') && w.length > 5) return w.slice(0, -2); // juizes
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (/(ss|us|is)$/.test(w)) return w;
  return w.endsWith('s') ? w.slice(0, -1) : w;
}

// Gender of a participle/adjective: "selecionado"/"selecionada", "monitorados"/"monitorada" meet on one form (after the
// plural strip). Forms and intents go through the same lexer, so both sides always agree.
export function canon(w) {
  const s = singular(w);
  return s.length > 5 && /(ad|id)o$/.test(s) ? s.slice(0, -1) + 'a' : s;
}

// Words that separate the clauses of a multi-step request ("criar a entidade, publicar e inserir registros"): vetoes
// and the model guard are judged per clause too, so one step's words never silence another step's tool.
const CLAUSE_WORDS = new Set(['e', 'and', 'then', 'depois', 'entao', 'also', 'tambem', 'plus', 'apos', 'after']);

// The flow node of a debugger request ("ver as variáveis do nó", "acompanhar os nós da action"): read from the raw word,
// before normalize() strips the accent that tells it from "no" (in the). The plural "nós" is a node only after an article,
// a contraction or a quantifier; elsewhere it is the pronoun.
const NODE_PLURAL_LEADS = new Set(['os', 'dos', 'nos', 'aos', 'pelos', 'esses', 'estes', 'desses', 'destes', 'nesses', 'nestes', 'todos', 'quais', 'alguns', 'varios', 'dois', 'tres', 'outros', 'proximos', 'demais', 'seus', 'meus']);
const bareWord = w => String(w ?? '').normalize('NFC').toLowerCase().replace(/^["'“‘(]+|["'”’).,;:!?]+$/g, '');
function nodeToken(rawWords, r) {
  const w = bareWord(rawWords[r]);
  if (w === 'nó') return 'node';
  if (w === 'nós' && r > 0 && NODE_PLURAL_LEADS.has(normalize(bareWord(rawWords[r - 1])))) return 'node';
  return null;
}

// Tokens with the index of the raw word that produced them (slots read the raw word that follows a slot noun) and the
// clause they belong to. `compounds` (tools.json) joins phrases whose second word is a stopword or would split a concept
// before the stopwords go: "sign in" -> signin, "step into" -> stepinto, "result.json" -> resultjson. Forms and intents
// use the same lexer.
export function makeLexer(compounds = []) {
  const rules = compounds.map(([phrase, joined]) => ({ words: normalize(phrase).split(/[^a-z0-9_]+/).filter(Boolean), joined })).filter(r => r.words.length).sort((a, b) => b.words.length - a.words.length);
  return function lex(text) {
    const rawWords = String(text ?? '').split(/\s+/).filter(Boolean);
    const subs = []; let clause = 0;
    rawWords.forEach((w, raw) => {
      const node = nodeToken(rawWords, raw);
      if (node) subs.push({ t: node, raw, clause });
      else for (const t of normalize(w).split(/[^a-z0-9_]+/)) if (t) { if (CLAUSE_WORDS.has(t)) clause++; subs.push({ t, raw, clause }); }
      if (/[,;]["'”’)]*$/.test(w)) clause++;
    });
    const joined = [];
    for (let i = 0; i < subs.length;) {
      const rule = rules.find(r => r.words.every((w, k) => subs[i + k]?.t === w));
      if (rule) { joined.push({ t: rule.joined, raw: subs[i].raw, clause: subs[i].clause }); i += rule.words.length; } else { joined.push(subs[i]); i++; }
    }
    const toks = joined.filter(x => (x.t.length > 1 || /^\d$/.test(x.t)) && !STOP.has(x.t)).map(x => ({ t: canon(x.t), raw: x.raw, clause: x.clause }));
    return { rawWords, toks };
  };
}

// Optimal string alignment distance capped at 2 (one typo = insertion, deletion, substitution or adjacent swap).
function typoDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > 1) return 2;
  }
  return Math.min(d[a.length][b.length], 2);
}
export const lex = makeLexer();

// ---- data loading and compilation (memoized per process and file)
const cache = new Map();
export function loadToolRoutes(file = TOOLS_FILE) {
  const stat = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.compiled;
  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const compiled = compileToolRoutes(data);
  cache.set(file, { mtimeMs: stat.mtimeMs, compiled });
  return compiled;
}

export function compileToolRoutes(data) {
  const problems = [];
  const lexer = makeLexer(data?.compounds ?? []);
  const tokensOf = text => lexer(text).toks.map(x => x.t);
  if (data?.schemaVersion !== TOOL_ROUTES_SCHEMA) problems.push(`schemaVersion must be ${TOOL_ROUTES_SCHEMA}`);
  const multi = []; const single = new Map();
  for (const [key, list] of Object.entries(data.synonyms ?? {})) {
    if (!key.startsWith('@')) problems.push(`synonym key ${key} must start with @`);
    for (const form of list) {
      const toks = tokensOf(form);
      if (!toks.length) { problems.push(`synonym ${key}: form "${form}" keeps no token after the stopwords`); continue; }
      if (toks.length > 1) { multi.push({ key, toks }); continue; }
      // A Portuguese infinitive also stands for its informal imperative, simple past and gerund ("dispara", "mostra",
      // "testa", "suspende", "abriu", "rodando"): requests are typed that way. Only one-word forms of 5+ letters ending in
      // -ar/-er/-ir.
      const variants = [toks[0]];
      const m = toks[0].match(/^([a-z]{3,})(ar|er|ir)$/);
      if (m) variants.push(...({ ar: ['a', 'e', 'ou', 'am', 'ando'], er: ['e', 'a', 'eu', 'endo'], ir: ['e', 'a', 'iu', 'indo'] })[m[2]].map(end => m[1] + end));
      for (const v of variants) { const s = single.get(v) ?? new Set(); s.add(key); single.set(v, s); }
    }
  }
  multi.sort((a, b) => b.toks.length - a.toks.length);
  const laneWords = Object.fromEntries(Object.entries(data.laneWords ?? {}).map(([lane, list]) => [lane, list.map(tokensOf).filter(t => t.length)]));
  const fillers = new Set((data.fillers ?? []).flatMap(tokensOf));
  const slotSkip = new Set((data.slotSkip ?? []).flatMap(tokensOf));
  const routes = []; let order = 0;
  const term = (t, at) => {
    // '@noun#nome': the noun followed by a Name ("o processo BPT AprovarPedido", "a aplicação Financeiro"): one named
    // element, not the list.
    if (t.startsWith('@') && t.endsWith('#nome')) { const base = t.slice(0, -5); if (!data.synonyms?.[base] || !(data.nameNouns ?? []).includes(base)) problems.push(`${at}: ${t} needs a name noun ${base}`); return t; }
    if (t.startsWith('@')) { if (!data.synonyms?.[t]) problems.push(`${at}: unknown synonym ${t}`); return t; }
    const toks = tokensOf(t);
    if (toks.length !== 1) { problems.push(`${at}: literal term "${t}" must keep exactly one token`); return toks[0] ?? t; }
    return toks[0];
  };
  // The model guard (tools.json modelGuard): a request that builds model elements ("criar uma action que grava o erro
  // no log", "add a logout button to the header") is a model change, not a Service Center, Portal or data operation.
  const mg = data.modelGuard ?? {};
  const keySet = list => new Set((list ?? []).map(x => term(x, 'modelGuard')));
  const guard = { groups: new Set(mg.groups ?? []), exemptTools: new Set(mg.exemptTools ?? []), elements: keySet(mg.elements), ui: keySet(mg.ui), verbs: keySet(mg.verbs), changeVerbs: keySet(mg.changeVerbs), conditions: keySet(mg.conditions),
    clicks: keySet(mg.clicks), modelOnly: keySet(mg.modelOnly), readerVetoVerbs: keySet(mg.readerVetoVerbs), modal: keySet(mg.modal), eventLead: new Set((mg.eventLead ?? []).flatMap(x => normalize(x).split(/\s+/))), eventVerbs: keySet(mg.eventVerbs) };
  // Nouns a build or change verb takes as its object ("criar uma setting ... no app": the setting, not the app).
  guard.objects = new Set([...(data.nameNouns ?? []).map(x => term(x, 'nameNouns')), ...guard.elements, ...keySet(mg.objects)]);
  const compileRoute = (tool, t, verbKey, v) => {
    const at = verbKey ? `${tool}.${verbKey}` : tool;
    const src = v ?? t;
    const triggers = (src.triggers ?? []).map(tr => tr.map(x => term(x, at)));
    const without = (src.without ?? []).map(x => term(x, at));
    const solo = (src.solo ?? []).map(x => term(x, at));
    const examples = [...(src.intents?.pt ?? []), ...(src.intents?.en ?? [])];
    const guarded = guard.groups.has(t.group) && !guard.exemptTools.has(tool) && src.modelGuard !== false;
    // A reader (Service Center or Portal read, data read) never answers a request that builds, changes or saves something
    // its own triggers do not name: "mudar o layout da tela", "gravar o erro numa entidade de log".
    const reader = !guard.exemptTools.has(tool) && (v?.reader ?? t.reader ?? false) === true;
    const argsIf = (src.argsIf ?? []).map(x => ({ if: term(x.if, at), set: x.set ?? {} }));
    // What the route does to the live system (EFFECTS): the verb's own effect, else its tool's. The model rule
    // (discoverAll) offers only 'read' and 'delivery' routes for a step that is a model change.
    const effect = v?.effect ?? t.effect ?? null;
    if (!EFFECTS.includes(effect)) problems.push(`${at}: effect must be one of ${EFFECTS.join(', ')}`);
    // `explains` (tool, plus its verb's): words the route takes as its own arguments or context: the action, node,
    // screen and variable a debugger session points at, the signed-in app user of an invoke, the "sem disparar nada" of a
    // watch. The model rule never reads them as a model change and the model guard never as an app-only concept; a model
    // element among them still vetoes the route beside a build verb.
    const explains = [...new Set([...(t.explains ?? []), ...(v?.explains ?? [])])].map(x => term(x, at));
    // `byLane` (verb, else tool): for a route of both lanes, the template and texts that differ on one lane (the O11 run
    // of the debugger is restricted to its native entry); the other lane keeps the route's own.
    const byLane = v?.byLane ?? t.byLane ?? null;
    for (const [l, o] of Object.entries(byLane ?? {})) {
      if (!['o11', 'odc'].includes(l)) problems.push(`${at}: byLane.${l} is not a lane`);
      for (const k of Object.keys(o ?? {})) if (!['args', 'when', 'preconditions', 'next'].includes(k)) problems.push(`${at}: byLane.${l}.${k} is not args, when, preconditions or next`);
    }
    return { id: at, tool, verb: verbKey ?? null, field: v?.field ?? null, value: v?.value ?? null, lane: v?.lane ?? t.lane, toolLane: t.lane, group: t.group, order: order++, triggers, without, solo, guarded, reader, argsIf, effect, explains, byLane,
      concepts: new Set([...triggers.flat(), ...solo]),
      when: v?.when ?? t.when, preconditions: v?.preconditions ?? t.preconditions ?? [], next: v?.next ?? t.next ?? null, args: v?.args ?? t.args ?? {}, slots: src.slots ?? {},
      equivalent: src.equivalent ?? null, legacy: t.legacy ?? null, supersedesUnavailable: src.supersedesUnavailable ?? t.supersedesUnavailable ?? [],
      verbTokens: verbKey ? tokensOf(String(v?.value ?? verbKey)) : [], examples, gap: null };
  };
  for (const [tool, t] of Object.entries(data.tools ?? {})) {
    const verbs = Object.entries(t.verbs ?? {});
    routes.push(compileRoute(tool, t, null, null)); // tool-level: its own triggers, or the tool named in the intent
    for (const [key, v] of verbs) routes.push(compileRoute(tool, t, key, v));
  }
  for (const g of data.gaps ?? []) {
    const triggers = (g.triggers ?? []).map(tr => tr.map(x => term(x, 'gap ' + g.id)));
    routes.push({ id: 'gap:' + g.id, tool: null, verb: null, lane: g.lane, toolLane: g.lane, group: g.group ?? null, order: order++, triggers, without: (g.without ?? []).map(x => term(x, 'gap ' + g.id)), solo: [], guarded: guard.groups.has(g.group), reader: false, argsIf: [], effect: 'gap', concepts: new Set(triggers.flat()), when: g.reason, preconditions: [], next: g.next ?? null, args: null, slots: {}, equivalent: null, legacy: null, supersedesUnavailable: [], verbTokens: [], examples: g.intents ? [...(g.intents.pt ?? []), ...(g.intents.en ?? [])] : [], gap: g.id });
  }
  // Groups each lane has its own tool for: the other lane's tool of such a group is never offered as a fallback.
  const groupsByLane = { o11: new Set(), odc: new Set() };
  for (const t of Object.values(data.tools ?? {})) for (const l of t.lane === 'both' ? ['o11', 'odc'] : [t.lane]) groupsByLane[l]?.add(t.group);
  // Typo vocabulary: every one-word form, literal trigger term, lane word, filler and compound of the routing data.
  const vocab = new Set([...single.keys(), ...multi.flatMap(f => f.toks), ...Object.values(laneWords).flat(2), ...fillers, ...(data.compounds ?? []).map(c => c[1])]);
  for (const r of routes) for (const t of r.concepts) if (!t.startsWith('@')) vocab.add(t);
  // Forms that stand for a key only at the start of a clause ("lista os timers" is a verb; "na lista" is a noun).
  const startOnly = new Map();
  for (const [key, forms] of Object.entries(data.clauseStartOnly ?? {})) for (const f of forms) for (const tok of tokensOf(f)) { const s = startOnly.get(tok) ?? new Set(); s.add(key); startOnly.set(tok, s); }
  const nameNouns = new Set((data.nameNouns ?? []).map(x => term(x, 'nameNouns')));
  const opNouns = new Set((data.opNouns ?? []).map(x => term(x, 'opNouns')));
  const operationalCapabilities = data.operationalCapabilities ?? [];
  const operationalTitles = Object.fromEntries(Object.entries(data.operationalTitles ?? {}).filter(([k]) => !k.startsWith('$')));
  for (const [id, title] of Object.entries(operationalTitles)) {
    if (!operationalCapabilities.some(o => (o.endsWith('.') ? id.startsWith(o) : id === o))) problems.push(`operationalTitles.${id}: not an operational capability`);
    if (typeof title !== 'string' || /not a model change/i.test(title)) problems.push(`operationalTitles.${id}: must be a title that does not say "not a model change"`);
  }
  const routeById = new Map(routes.map(r => [r.id, r]));
  const compiled = { data, lex: lexer, tokensOf, multi, single, laneWords, fillers, slotSkip, routes, routeById, problems, toolNames: new Set(Object.keys(data.tools ?? {})), guard, groupsByLane, vocab, startOnly, nameNouns, opNouns, operationalCapabilities, operationalTitles };
  // Similarity (ranking among routes whose trigger matched): IDF over the routes' example units.
  const df = new Map();
  for (const r of routes) { r.exampleUnits = r.examples.map(e => unitsOf(compiled, e).units); for (const u of new Set(r.exampleUnits.flatMap(s => [...s]))) df.set(u, (df.get(u) ?? 0) + 1); }
  compiled.idf = u => Math.log(1 + routes.length / (df.get(u) ?? 0.5));
  // Specificity of a trigger term (0..1): a term few routes use ("@configuracao") outranks a generic one ("@consultar")
  // between triggers of the same length.
  const tdf = new Map();
  for (const r of routes) for (const t of r.concepts) tdf.set(t, (tdf.get(t) ?? 0) + 1);
  const N = routes.length;
  compiled.termWeight = t => Math.log(N / (tdf.get(t) ?? 1)) / Math.log(N);
  return compiled;
}

// Identifier after a noun ("entidade Status", "módulo Vendas", "app Portal", "action CalcularPremio"): a Name, never
// a word of the request; it stops "Status" vetoing a deploy or "Portal" naming the Portal.
const IDENT = w => (/^[A-Z][A-Za-z0-9_]*$/.test(w) && /[a-z]/.test(w)) || /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/.test(w);
const OPNAME = w => /^[a-z]+(-[a-z]+)+$/.test(w);
const ARTICLES = new Set(['o', 'a', 'os', 'as', 'um', 'uma', 'the', 'an']);
const cleanWord = w => w.replace(/^["'“‘(]+|["'”’).,;:!?]+$/g, '');

// Concepts of an intent: multi-word forms as contiguous token runs (overlapping runs all count; a token inside a run
// does not count alone unless repeated outside every run), then one-word forms; keys are never forms.
export function unitsOf(compiled, text) {
  const lexed = compiled.lex(text);
  const { rawWords } = lexed;
  // 1. One typo per word (5+ letters; a swap of 4), against the routing vocabulary only, when the correction is unique.
  //    Identifiers (capitalized words after the first) and words with digits are never corrected.
  const corrected = [];
  for (const x of lexed.toks) {
    const raw = rawWords[x.raw] ?? '';
    if (x.t.length < 4 || !/^[a-z]+$/.test(x.t) || compiled.vocab.has(x.t) || compiled.single.has(x.t) || compiled.slotSkip.has(x.t) || (x.raw > 0 && /^[A-Z]/.test(raw))) { corrected.push(x); continue; }
    // An adjacent swap ("moduel" -> module) is preferred to the other edits ("moduel" -> model).
    const swaps = new Set(); const hits = new Set();
    const anagram = w => w.length === x.t.length && [...w].sort().join('') === [...x.t].sort().join('');
    for (const w of compiled.vocab) {
      if (w.length < 4 || Math.abs(w.length - x.t.length) > 1 || !/^[a-z]+$/.test(w)) continue;
      if (x.t.length === 4) { if (anagram(w) && typoDistance(x.t, w) === 1) swaps.add(w); continue; }
      if (w.length >= 5 && typoDistance(x.t, w) === 1) (anagram(w) ? swaps : hits).add(w);
    }
    const signature = w => [...(compiled.single.get(w) ?? [w])].sort().join('|');
    // Among the candidates, a form of a concept outranks a literal trigger word ("modlo" -> modulo, not modelo).
    const pick = all => { const forms = [...all].filter(w => compiled.single.has(w)); const set = forms.length ? forms : [...all]; const sigs = new Set(set.map(signature)); return sigs.size === 1 ? set[0] : null; };
    const fix = swaps.size ? pick(swaps) : pick(hits);
    corrected.push(fix ? { ...x, t: fix, typo: x.t } : x);
  }
  // 2. Identifiers after a noun are names, not words of the request (slots still read them from the raw words).
  const nounAt = r => compiled.tokensOf(cleanWord(rawWords[r] ?? '')).some(t => [...(compiled.single.get(t) ?? [])].some(k => compiled.nameNouns.has(k)));
  const laneTokens = new Set(Object.values(compiled.laneWords).flat(2));
  // A kernel op name after op/operação ("a op add-attribute", "operation set-property") is a name too: its words are
  // never verbs or elements of the request.
  const opNounAt = r => compiled.tokensOf(cleanWord(rawWords[r] ?? '')).some(t => [...(compiled.single.get(t) ?? [])].some(k => compiled.opNouns.has(k)));
  const names = new Set(); const namedNouns = new Set();
  rawWords.forEach((w, r) => {
    const clean = cleanWord(w);
    const opName = OPNAME(clean);
    if (r === 0 || !(IDENT(clean) || opName) || compiled.tokensOf(clean).some(t => laneTokens.has(t))) return;
    for (let b = r - 1; b >= 0; b--) {
      const prev = cleanWord(rawWords[b]);
      const prevToks = compiled.tokensOf(prev);
      if (ARTICLES.has(normalize(prev)) || (prevToks.length && prevToks.every(t => compiled.slotSkip.has(t)))) continue;
      if (opName ? opNounAt(b) : nounAt(b)) { names.add(r); namedNouns.add(b); }
      break;
    }
  });
  const toks = corrected.filter(x => !names.has(x.raw));
  const seq = toks.map(x => x.t);
  const concepts = new Map(); // key -> positions
  const consumed = new Set();
  const add = (key, positions) => { const p = concepts.get(key) ?? []; p.push(...positions); concepts.set(key, p); };
  for (const f of compiled.multi) for (let i = 0; i + f.toks.length <= seq.length; i++) {
    if (f.toks.every((t, k) => seq[i + k] === t)) { const pos = f.toks.map((_, k) => i + k); add(f.key, pos); pos.forEach(p => consumed.add(p)); }
  }
  const clauseStart = i => !toks.slice(0, i).some(x => x.clause === toks[i].clause && !compiled.fillers.has(x.t));
  seq.forEach((t, i) => {
    if (consumed.has(i)) return;
    for (const key of compiled.single.get(t) ?? []) if (!(compiled.startOnly.get(t)?.has(key) && !clauseStart(i))) add(key, [i]);
  });
  // A raw word shaped like a Model API interface (IServerAction, IAggregate) adds @interface when the data defines it;
  // a number or a hex/alphanumeric id (42, 4bf92f) adds @id.
  if (compiled.data.synonyms?.['@interface']) toks.forEach((x, i) => { if (/^I[A-Z][A-Za-z]+[?.,]?$/.test(rawWords[x.raw] ?? '')) add('@interface', [i]); });
  if (compiled.data.synonyms?.['@id']) toks.forEach((x, i) => { const w = cleanWord(rawWords[x.raw] ?? ''); if (/^\d+$/.test(w) || (/^[0-9a-f-]{5,}$/i.test(w) && /\d/.test(w))) add('@id', [i]); });
  // An element key of a capture ("@k3J9", "@Ab12") adds @elemref: the request names one element of a captured module.
  if (compiled.data.synonyms?.['@elemref']) toks.forEach((x, i) => { if (/^@[A-Za-z0-9_]{2,}[?.,;:]?$/.test(rawWords[x.raw] ?? '')) add('@elemref', [i]); });
  // A name noun followed by a Name ("processo BPT AprovarPedido") also adds '<noun>#nome': one named element.
  const named = [];
  for (const [key, ps] of concepts) if (compiled.nameNouns.has(key)) for (const p of ps) if (namedNouns.has(toks[p].raw)) named.push([key + '#nome', p]);
  for (const [key, p] of named) add(key, [p]);
  // An event lead ("ao clicar", "on save", "ao salvar", "on every login"): "ao"/"on"/"upon", optionally "cada"/"every",
  // then a verb of an event adds the condition key; the action that follows runs inside app logic.
  const quando = [...compiled.guard.conditions][0];
  if (quando) {
    const sub = []; rawWords.forEach((w, r) => { for (const t of normalize(w).split(/[^a-z0-9_]+/)) if (t) sub.push({ t, r }); });
    for (let k = 0; k + 1 < sub.length; k++) {
      if (!compiled.guard.eventLead.has(sub[k].t)) continue;
      let j = k + 1; if (['cada', 'every', 'each', 'todo', 'toda'].includes(sub[j].t) && j + 1 < sub.length) j++;
      const at = toks.findIndex(x => x.raw === sub[j].r);
      if (at >= 0 && [...(concepts.entries())].some(([key, ps]) => compiled.guard.eventVerbs.has(key) && ps.includes(at))) add(quando, [at]);
    }
  }
  const units = new Set(concepts.keys());
  seq.forEach((t, i) => { if (!consumed.has(i) && !compiled.single.has(t)) units.add(t); });
  return { toks, rawWords, seq, concepts, units, names };
}

function lanesNamed(compiled, seq) {
  const named = new Set(); const positions = new Set();
  for (const [lane, forms] of Object.entries(compiled.laneWords)) for (const f of forms) for (let i = 0; i + f.length <= seq.length; i++)
    if (f.every((t, k) => seq[i + k] === t)) { named.add(lane); f.forEach((_, k) => positions.add(i + k)); }
  return { named, positions };
}

const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const setPath = (obj, p, value) => { const keys = p.split('.'); let o = obj; for (const k of keys.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } o[keys.at(-1)] = value; };
const clone = v => JSON.parse(JSON.stringify(v));

// The raw word after a slot noun, skipping articles and "called/chamado": a Name (capitalized identifier) or a quoted
// text. Never a known concept word, a lane word, a UUID or anything for words/credentials.
function fillSlot(compiled, u, positions) {
  const rawAfter = Math.max(...positions.map(p => u.toks[p].raw));
  for (let r = rawAfter + 1; r < u.rawWords.length; r++) {
    const word = u.rawWords[r];
    const quoted = word.match(/^["'“‘]([^"'”’]+)["'”’][.,;:!?]?$/);
    if (quoted) return quoted[1];
    const clean = word.replace(/[.,;:!?)]+$/, '');
    const toks = compiled.tokensOf(clean);
    if (!toks.length || toks.every(t => compiled.slotSkip.has(t))) continue;
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(clean)) return null;
    if (toks.some(t => compiled.single.has(t)) || Object.values(compiled.laneWords).some(fs => fs.some(f => f.length === 1 && f[0] === toks[0]))) return null;
    return clean;
  }
  return null;
}

// ---- the matcher (pure; no index, no I/O after load)
export function routeTools({ intent = '', lane = 'odc', unavailable = [] } = {}, compiled = loadToolRoutes()) {
  const u = unitsOf(compiled, intent);
  if (!u.seq.length) return { tools: [], covers: null, lanesNamed: [], modelRest: false };
  const tokenSet = new Set(u.seq);
  const has = t => (t.startsWith('@') ? u.concepts.has(t) : tokenSet.has(t));
  const positionsOf = t => (t.startsWith('@') ? u.concepts.get(t) ?? [] : u.seq.flatMap((x, i) => (x === t ? [i] : [])));
  const posKeys = u.seq.map(() => new Set());
  for (const [k, ps] of u.concepts) for (const p of ps) posKeys[p].add(k);
  const { named: lanes, positions: lanePositions } = lanesNamed(compiled, u.seq);
  // A tool is named by its exact snake_case name; plain words that are also tool names (status, context, continue,
  // propose) never name a tool.
  const namedTools = new Set(u.seq.filter(t => t.includes('_') && compiled.toolNames.has(t)));
  const other = lane === 'odc' ? 'o11' : 'odc';
  // Scopes: the whole request, then each clause of a multi-step request. A route matches when one scope holds a whole
  // trigger and none of its vetoes, so "publicar e inserir registros" keeps o11_publish (vetoed by registro) for the
  // clause "publicar".
  const scopeOf = ps => { const keys = new Set(ps.flatMap(p => [...posKeys[p]])); const toks = new Set(ps.map(p => u.seq[p])); return { ps, has: t => (t.startsWith('@') ? keys.has(t) : toks.has(t)) }; };
  const scopes = [scopeOf(u.seq.map((_, i) => i))];
  const clauses = [...new Set(u.toks.map(x => x.clause))];
  if (clauses.length > 1) for (const c of clauses) scopes.push(scopeOf(u.toks.flatMap((x, i) => (x.clause === c ? [i] : []))));
  const g = compiled.guard;
  const anyIn = (keys, set) => [...keys].some(k => set.has(k));
  // Model guard: in this scope, a model element the route never mentions, with a build verb or a UI widget ("criar uma
  // action que grava o erro no log", "add a logout button"), or any model element under a condition ("log an error
  // when the timer fails"), makes the request a model change for this route. The build verb and the condition count
  // anywhere in the request: "create an action ... and call it inside an If" keeps its verb in the second clause.
  const anywhere = set => u.seq.some((_, i) => anyIn(posKeys[i], set));
  const verbAnywhere = anywhere(g.verbs);
  const elementAnywhere = anywhere(g.elements);
  const clickAnywhere = anywhere(g.clicks);
  // A condition ("quando", "when", "ao salvar", "a cada login") governs every clause of the request: "when the user
  // clicks Save, update the record" is app logic in both clauses. A click on a UI widget is a condition too ("on button
  // click"), but not for a route that clicks itself ("clicar em OK no diálogo").
  const condAnywhere = anywhere(g.conditions);
  const clickCond = clickAnywhere && anywhere(g.ui);
  // Object of each build or change verb: the first noun after it in its clause ("criar um timer que ... logs": the
  // timer; "apagar a tela X do módulo": the screen).
  const actVerbs = new Set([...g.verbs, ...g.changeVerbs]);
  // A run of nouns is one object ("a Library module", "o módulo biblioteca").
  const objectOf = new Map();
  const isObject = q => !anyIn(posKeys[q], actVerbs) && anyIn(posKeys[q], g.objects);
  u.seq.forEach((_, p) => {
    if (!anyIn(posKeys[p], actVerbs)) return;
    for (let q = p + 1; q < u.seq.length && u.toks[q].clause === u.toks[p].clause; q++) if (isObject(q)) {
      const adjacent = x => x + 1 < u.seq.length && u.toks[x + 1].raw - u.toks[x].raw <= 1 && isObject(x + 1);
      const run = [q]; while (adjacent(run.at(-1))) run.push(run.at(-1) + 1);
      objectOf.set(p, run); break;
    }
  });
  const mentions = (r, p) => anyIn(posKeys[p], r.concepts) || r.concepts.has(u.seq[p]);
  // An app-only concept the route takes as its context (the signed-in app user of an invoke) is not a model change; a
  // model element it explains still counts as foreign beside a build verb ("create an action ... and call it inside").
  const mentionsContext = (r, p) => mentions(r, p) || (r.explains ?? []).some(x => posKeys[p].has(x) || u.seq[p] === x);
  // The lead verb of each clause: its first word after fillers and modals ("gravar o erro ...", "quero mudar o layout");
  // "em qual banco a aplicação grava" has none (grava is the app's own verb).
  const leads = new Set();
  for (const c of new Set(u.toks.map(x => x.clause))) {
    const p = u.seq.findIndex((t, i) => u.toks[i].clause === c && !compiled.fillers.has(t) && !anyIn(posKeys[i], g.modal));
    if (p >= 0) leads.add(p);
  }
  const writeAnywhere = anywhere(g.readerVetoVerbs);
  const guardVetoes = (r, s) => {
    // A reader never answers a build, change or save it does not name itself (any group, guarded or not).
    if (r.reader && s.ps.some(p => leads.has(p) && anyIn(posKeys[p], g.readerVetoVerbs) && !mentions(r, p))) return true;
    if (!r.guarded) return false;
    // Concepts that only exist inside an app (the current user, paging, sorting) make the request a model change.
    if (u.seq.some((_, p) => anyIn(posKeys[p], g.modelOnly) && !mentionsContext(r, p))) return true;
    // A condition with a model element, a click or a write anywhere: "on save, insert a row in the Audit table".
    if (condAnywhere && (elementAnywhere || clickAnywhere || writeAnywhere)) return true;
    if (clickCond && !anyIn(g.clicks, r.concepts)) return true;
    let foreign = false, ui = false, change = false;
    for (const p of s.ps) {
      const ks = posKeys[p];
      if (anyIn(ks, g.changeVerbs)) change = true;
      if (!anyIn(ks, g.elements)) continue;
      if (!mentions(r, p)) { foreign = true; if (anyIn(ks, g.ui)) ui = true; }
    }
    // A model element the route never mentions, with a build verb, a change verb or a UI widget: "apagar a tela antiga
    // do módulo" is not a module delete, "add a logout button" is not a Service Center write.
    if (foreign && (verbAnywhere || ui || change)) return true;
    // A build or change verb whose object is a model element, the verb not being one of the route's own terms: "criar
    // um timer que limpa os logs" builds a timer, it never reads the logs.
    for (const [p, run] of objectOf) if (s.ps.includes(p) && run.some(q => anyIn(posKeys[q], g.elements)) &&!anyIn(posKeys[p], r.concepts)) return true;
    return false;
  };
  // A trigger with a build or change verb holds only when that verb acts on one of the trigger's own nouns: "create an
  // application ... with a Reactive module" creates the app, not a module; "criar uma setting ... no app" creates no app.
  const objectHolds = (tr, s) => {
    const verbs = tr.filter(t => actVerbs.has(t));
    if (!verbs.length || !tr.some(t => g.objects.has(t) || t.endsWith('#nome'))) return true; // no noun to act on
    const occurrences = s.ps.filter(p => verbs.some(v => posKeys[p].has(v)) && objectOf.has(p));
    if (!occurrences.length) return true;
    return occurrences.some(p => objectOf.get(p).some(q => tr.some(t => posKeys[q].has(t) || u.seq[q] === t)));
  };
  // Content positions for solo routes: everything but fillers, lane words and snake_case tool names.
  const notFiller = i => !compiled.fillers.has(u.seq[i]) && !(u.seq[i].includes('_') && compiled.toolNames.has(u.seq[i]));
  let content = u.seq.map((t, i) => i).filter(i => !lanePositions.has(i) && notFiller(i));
  if (!content.length) content = u.seq.map((t, i) => i).filter(notFiller); // "tenants": the one word is also a lane word
  const candidates = [];
  for (const r of compiled.routes) {
    const named = r.tool && namedTools.has(r.tool);
    let best = null; const matchedTerms = new Set(); const clauseHits = new Set();
    scopes.forEach((s, si) => {
      if (r.without.some(s.has) || guardVetoes(r, s)) return;
      for (const tr of r.triggers) if (tr.every(s.has) && objectHolds(tr, s)) { tr.forEach(t => matchedTerms.add(t)); if (si) clauseHits.add(si); if (!best || tr.length > best.length) best = tr; }
    });
    // A solo route answers a request made of that one concept alone ("status", "dados").
    if (!best) for (const key of r.solo) if (content.length && content.every(i => posKeys[i].has(key))) { best = [key]; matchedTerms.add(key); }
    if (!best && !named) continue;
    if (named && !best && r.without.some(has)) continue;
    const verbLiteral = named && r.verbTokens.length && u.seq.some((_, i) => r.verbTokens.every((t, k) => u.seq[i + k] === t));
    if (named && r.verb && !verbLiteral && !best) continue; // a named tool selects its verbs only by trigger or literal
    let sim = 0;
    const qUnits = [...u.units]; const qWeight = qUnits.reduce((n, x) => n + compiled.idf(x), 0) || 1;
    for (const e of r.exampleUnits) { let shared = 0, eWeight = 0; for (const x of e) { const w = compiled.idf(x); eWeight += w; if (u.units.has(x)) shared += w; } const s = (shared / qWeight + shared / (eWeight || 1)) / 2; if (s > sim) sim = s; }
    const routeLane = r.lane;
    let laneScore = 0;
    if (routeLane === 'o11' || routeLane === 'odc') { if (lanes.has(routeLane)) laneScore = 5; else if (lanes.size) laneScore = -5; }
    const specific = best ? best.reduce((n, t) => n + compiled.termWeight(t), 0) : 0;
    const score = (best ? 10 * best.length : 0) + 2 * specific + laneScore + 8 * sim + (named ? 100 : 0) + (verbLiteral ? 20 : 0) - (r.legacy && ['alias', 'restricted', 'step', 'detail'].includes(r.legacy.status) ? 3 : 0);
    const laneRank = routeLane === lane ? 0 : routeLane === 'both' ? 1 : 2;
    candidates.push({ r, best: best ?? [], matchedTerms, clauseHits, score, laneRank, named, verbLiteral: !!verbLiteral, otherLane: laneRank === 2, admitted: laneRank < 2 || named || lanes.has(routeLane) });
  }
  let pool = candidates.filter(c => c.admitted);
  // No route of the asked lane: the other lane's tool, flagged, only for a group the asked lane has no tool for and when
  // the request does not name the asked lane ("ver se a janela do portal está logada" on ODC never gets o11_studio).
  // An other-lane route with an equivalent on the asked lane answers with that equivalent ("ler os logs de erro" on ODC
  // is the Portal monitoring read, never the O11 Service Center): the concept decides, not the group.
  if (!pool.length && !lanes.has(lane)) {
    const fallback = []; const seenEq = new Set();
    for (const c of candidates.filter(x => x.otherLane)) {
      const eq = c.r.equivalent?.[lane];
      const er = eq?.tool ? compiled.routeById.get(eq.verb ? `${eq.tool}.${eq.verb}` : eq.tool) : null;
      if (er && (er.lane === lane || er.lane === 'both')) { if (!seenEq.has(er.id)) { seenEq.add(er.id); fallback.push({ ...c, r: er, laneRank: er.lane === lane ? 0 : 1, otherLane: false, viaEquivalent: c.r.id }); } }
      else if (!compiled.groupsByLane[lane]?.has(c.r.group)) fallback.push(c);
    }
    pool = fallback;
  }
  const verbTools = new Set(pool.filter(c => c.r.verb).map(c => c.r.tool));
  pool = pool.filter(c => c.r.verb || !verbTools.has(c.r.tool));
  pool.sort((a, b) => b.score - a.score || a.laneRank - b.laneRank || a.r.order - b.r.order);
  // The window of the routes kept beside the top one ignores the bonus of a tool named in the intent: "criar no tenant o
  // módulo que o studio_build gerou" keeps the named studio_build first and still offers studio_create (the upload of a ready candidate).
  const plain = c => c.score - (c.named ? 100 : 0) - (c.verbLiteral ? 20 : 0);
  const top = pool.length ? Math.max(...pool.map(plain)) : 0;
  const chosen = []; const seen = new Set();
  // A multi-step request keeps the best route of each clause ("publicar o módulo depois do merge": the merge and the
  // publish), then the routes within reach of the top one; the order stays by score.
  if (pool.length) { seen.add(pool[0].r.id); chosen.push(pool[0]); }
  for (let si = 1; si < scopes.length && chosen.length < MAX_TOOLS; si++) {
    const c = pool.find(x => x.clauseHits.has(si));
    if (c && !seen.has(c.r.id)) { seen.add(c.r.id); chosen.push(c); }
  }
  for (const c of pool) {
    if (chosen.length >= MAX_TOOLS) break;
    if (seen.has(c.r.id) || (!c.named && plain(c) < top - 11)) continue;
    seen.add(c.r.id); chosen.push(c);
  }
  chosen.sort((a, b) => b.score - a.score || a.laneRank - b.laneRank || a.r.order - b.r.order);
  // Coverage, for the hint only: every content token used by a matched trigger, a lane word, a filler or a filled slot.
  const used = new Set(lanePositions);
  u.seq.forEach((t, i) => { if (compiled.fillers.has(t) || compiled.toolNames.has(t)) used.add(i); });
  // Per route, for the model rule (discoverAll): its effect, its step (the clauses where its trigger held, else the whole
  // request) and the words of that step it does not explain itself (`residual`, raw words; names after nouns are names).
  const general = new Set(used);
  const checks = [];
  // A clause led by a function word or a condition ("In the Save action, ...", "na ação X, ...", "quando o usuário clicar
  // em Salvar, ...", "ao abrir a tela, ...") is not a step of its own: it is the context of the clause it introduces (or,
  // last, of the one before), and belongs to that clause's step.
  const clauseIds = [...new Set(u.toks.map(x => x.clause))].sort((a, b) => a - b);
  const firstTok = c => u.toks.findIndex(x => x.clause === c);
  const isContext = c => {
    const at = firstTok(c); const lastBefore = at > 0 ? u.toks[at - 1].raw : -1;
    for (let r = lastBefore + 1; r <= u.toks[at].raw; r++) {
      const words = normalize(u.rawWords[r] ?? '').split(/[^a-z0-9_]+/).filter(Boolean);
      if (!words.length || words.every(w => CLAUSE_WORDS.has(w))) continue;
      return r < u.toks[at].raw ? STOP.has(words[0]) : anyIn(posKeys[at], g.conditions);
    }
    return false;
  };
  const owner = new Map();
  clauseIds.forEach((c, k) => { let j = k; while (j < clauseIds.length - 1 && isContext(clauseIds[j])) j++; if (j === clauseIds.length - 1 && isContext(clauseIds[j])) { j = k; while (j > 0 && isContext(clauseIds[j])) j--; } owner.set(c, clauseIds[j]); });
  const stepClauses = hits => { const own = new Set([...hits].map(si => u.toks[scopes[si].ps[0]].clause)); return new Set(clauseIds.filter(c => own.has(owner.get(c)) || own.has(c))); };
  // `modelWords`: those words carry the router's own model vocabulary (an element, a widget, a build or change verb, a
  // condition, a click, an app-only concept).
  const modelKeys = [g.elements, g.ui, g.verbs, g.changeVerbs, g.conditions, g.clicks, g.modelOnly];
  const residualOf = (ps, explained) => {
    const raws = new Map();
    for (const p of ps) { const r = u.toks[p].raw; raws.set(r, (raws.get(r) ?? false) || explained.has(p)); }
    const left = ps.filter(p => !raws.get(u.toks[p].raw));
    return { text: [...raws].filter(([, e]) => !e).map(([r]) => r).sort((a, b) => a - b).map(r => cleanWord(u.rawWords[r])).filter(Boolean).join(' '),
      modelWords: left.some(p => modelKeys.some(set => anyIn(posKeys[p], set))) };
  };
  const tools = chosen.map(c => {
    const r = c.r;
    const inStep = c.clauseHits.size ? stepClauses(c.clauseHits) : null;
    const step = u.seq.map((_, i) => i).filter(i => !inStep || inStep.has(u.toks[i].clause));
    const stepSet = new Set(step);
    // `own`: the words of its step the route explains: its trigger terms, its verb, its filled slots and the nouns its
    // slots read (the entity of "inserir registros na entidade", the table of "insert rows into the Country table").
    const own = new Set(general);
    const use = p => { used.add(p); if (stepSet.has(p)) own.add(p); };
    if (c.best.length === 1 && r.solo.includes(c.best[0])) content.forEach(use);
    for (const t of c.matchedTerms) positionsOf(t).forEach(use);
    if (c.named) r.verbTokens.forEach(t => positionsOf(t).forEach(use));
    for (const nouns of Object.values(r.slots ?? {})) for (const noun of nouns) for (const p of positionsOf(noun)) if (stepSet.has(p)) own.add(p);
    // Its context may sit in a clause of its own ("..., sem disparar nada"): explained there too, unless that clause
    // carries model vocabulary the route does not explain ("..., e criar uma tela nova" stays a model step).
    const explained = q => (r.explains ?? []).some(x => posKeys[q].has(x) || u.seq[q] === x);
    const foreignModel = c => u.seq.some((_, q) => u.toks[q].clause === c && !stepSet.has(q) && !explained(q) && modelKeys.some(set => anyIn(posKeys[q], set)));
    for (const x of r.explains ?? []) for (const p of positionsOf(x)) {
      if (stepSet.has(p)) use(p);
      else if (!foreignModel(u.toks[p].clause)) { used.add(p); own.add(p); }
    }
    checks.push({ id: r.id, effect: r.effect, own, step, clauses: inStep });
    const why = [...new Set(c.best.map(t => { const p = positionsOf(t)[0]; return p == null ? t : u.seq[p]; }))];
    if (c.named) why.unshift(r.tool);
    if (r.gap) return { gap: r.gap, lane: r.lane, when: r.when, ...(r.next ? { next: r.next } : {}), why };
    // A route of both lanes answers with its byLane texts and template for the asked lane, when it has them.
    const forLane = (r.lane === 'both' ? r.byLane?.[lane] : null) ?? {};
    const rl = { args: forLane.args ?? r.args, when: forLane.when ?? r.when, preconditions: forLane.preconditions ?? r.preconditions, next: forLane.next ?? r.next };
    const args = clone(rl.args ?? {});
    if (typeof args.lane === 'string' && args.lane.startsWith('<') && r.toolLane === 'both') args.lane = r.lane === 'both' ? lane : r.lane;
    const filled = [];
    for (const [argPath, nouns] of Object.entries(r.slots ?? {})) {
      const current = getPath(args, argPath);
      if (typeof current !== 'string' || !current.startsWith('<')) continue;
      for (const noun of nouns) {
        const pos = positionsOf(noun); if (!pos.length) continue;
        const value = fillSlot(compiled, u, pos);
        if (value) { setPath(args, argPath, value); filled.push(argPath); pos.forEach(use); const raw = u.rawWords.findIndex((w, i) => i > Math.max(...pos.map(p => u.toks[p].raw)) && w.includes(value)); u.toks.forEach((x, i) => { if (x.raw === raw) use(i); }); break; }
      }
    }
    for (const x of r.argsIf ?? []) if (has(x.if)) for (const [p, v] of Object.entries(x.set)) setPath(args, p, v);
    const item = { tool: r.tool, ...(r.verb ? { verb: r.verb } : {}), lane: r.lane, args, when: rl.when,
      ...(rl.preconditions?.length ? { preconditions: rl.preconditions.slice(0, 2) } : {}), ...(rl.next ? { next: rl.next } : {}), why, ...(filled.length ? { filled } : {}) };
    if (r.legacy) item.legacy = `${r.legacy.status}: ${r.legacy.replacedBy}`;
    if (c.otherLane) {
      item.otherLane = true;
      item.note = `tool of lane ${r.lane}${lanes.has(r.lane) ? ' (the intent names it)' : ''}; this answer is for lane ${lane}`;
      const eq = r.equivalent?.[lane]; if (eq) item.equivalent = { lane, ...eq };
    } else if (r.lane !== 'both' && r.equivalent?.[other]) item.equivalent = { lane: other, ...r.equivalent[other] };
    const supersedes = (r.supersedesUnavailable ?? []).filter(id => unavailable.includes(id));
    if (supersedes.length) item.supersedes = supersedes;
    return item;
  });
  const covers = tools.length ? (u.seq.every((_, i) => used.has(i)) ? 'intent' : 'part') : null;
  // The words no tool explains carry a build verb ("... e criar a entidade"), or a change verb with a model element
  // ("... e apagar o atributo"): the request also changes the model (two parts). A model element alone is the target of
  // a reader ("inspecionar a action X"), not a change.
  // A verb after a modal ("quais módulos posso adicionar como dependência") is asked about, not requested; a verb after
  // op/operação ("a op de criar atributo") names the op.
  const asked = i => i > 0 && (anyIn(posKeys[i - 1], g.modal) || anyIn(posKeys[i - 1], compiled.opNouns));
  const rest = u.seq.map((_, i) => i).filter(i => !used.has(i) && !asked(i));
  const restHas = set => rest.some(i => anyIn(posKeys[i], set));
  const modelRest = !!tools.length && (restHas(g.verbs) || (restHas(g.changeVerbs) && restHas(g.elements)));
  // Model words (an element, a widget, a build or change verb, an app-only concept) no tool explains: the model part of
  // the answer is then never asked again with a smaller budget.
  const modelWordsLeft = !!tools.length && [g.elements, g.ui, g.verbs, g.changeVerbs, g.modelOnly].some(restHas);
  // Steps, not routes, get the model verdict: routes whose clauses meet (every route of a one-clause request; routes that
  // held only on the whole request of a multi-step one) are candidate readings of ONE step and share one residual: the
  // words of that step no route deciding it explains. The deciders are the routes the rule may leave out (effect not
  // 'read'/'delivery'); a step with none is judged on all its routes. So two readings of one step ("insert" and
  // "update" of "insert rows via Edit Data") can never get opposite verdicts.
  const parent = checks.map((_, i) => i);
  const root = i => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const meets = (a, b) => (a.clauses == null || b.clauses == null ? a.clauses == null && b.clauses == null : [...a.clauses].some(c => b.clauses.has(c)));
  for (let i = 0; i < checks.length; i++) for (let j = i + 1; j < checks.length; j++) if (meets(checks[i], checks[j])) parent[root(j)] = root(i);
  const stepResidual = new Map();
  for (const k of new Set(checks.map((_, i) => root(i)))) {
    const members = checks.filter((_, i) => root(i) === k);
    const deciders = members.filter(x => !MODEL_STEP_EFFECTS.has(x.effect));
    const ps = [...new Set(members.flatMap(x => x.step))].sort((a, b) => a - b);
    stepResidual.set(k, residualOf(ps, new Set((deciders.length ? deciders : members).flatMap(x => [...x.own]))));
  }
  const steps = checks.map((x, i) => ({ id: x.id, effect: x.effect, step: root(i), residual: stepResidual.get(root(i)) }));
  const residual = tools.length ? residualOf(u.seq.map((_, i) => i), new Set(checks.flatMap(x => [...x.own]))) : { text: '', modelWords: false };
  return { tools, covers, modelRest, modelWordsLeft, steps, residual, lanesNamed: [...lanes] };
}

// ---- every tool of a lane by group (empty intent)
export function toolGroups(lane = 'odc', compiled = loadToolRoutes()) {
  const groups = (compiled.data.groups ?? []).map(g => ({ id: g.id, title: g.title, tools: [] }));
  let otherLaneTools = 0;
  for (const [tool, t] of Object.entries(compiled.data.tools ?? {})) {
    if (t.lane !== lane && t.lane !== 'both') { otherLaneTools++; continue; }
    const g = groups.find(x => x.id === t.group) ?? (() => { const x = { id: t.group ?? 'other', title: t.group ?? 'other', tools: [] }; groups.push(x); return x; })();
    const verbs = Object.entries(t.verbs ?? {}).filter(([, v]) => !v.lane || v.lane === lane).map(([k]) => k);
    g.tools.push({ tool, ...(verbs.length ? { verbs } : {}), ...(t.legacy ? { legacy: t.legacy.status } : {}) });
  }
  return { toolGroups: groups.filter(g => g.tools.length), otherLaneTools };
}

// ---- answer composition and budget
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const brief = (text, max) => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 3) + '...' : t; };
const callText = item => (item.gap ? `no tool (${item.gap}): ${brief(item.when, 140)}` : `${item.tool} ${brief(JSON.stringify(item.args ?? {}), 160)}`);

function levelItems(tools, level) {
  if (level === 'full') return tools.map(t => ({ ...t, when: brief(t.when, 160), ...(t.preconditions ? { preconditions: t.preconditions.map(p => brief(p, 120)) } : {}), ...(t.next ? { next: brief(t.next, 160) } : {}) }));
  if (level === 'compact') return tools.map(t => (t.gap ? { gap: t.gap, lane: t.lane, when: brief(t.when, 120) } : { tool: t.tool, ...(t.verb ? { verb: t.verb } : {}), lane: t.lane, args: t.args, why: t.why, ...(t.otherLane ? { otherLane: true, note: t.note } : {}) }));
  return tools.map(t => (t.gap ? { gap: t.gap, lane: t.lane } : { tool: t.tool, ...(t.verb ? { verb: t.verb } : {}), lane: t.lane, ...(t.otherLane ? { otherLane: true, note: t.note } : {}) }));
}

// Direct matches that are model changes (job ops): the operational capabilities of the catalog (ops.*, read.*,
// deliver.*, diagnostic.*, data.records; tools.json operationalCapabilities) never make a request (or a step) a model change.
export function modelMatchesOf(answer, compiled = loadToolRoutes()) {
  const ops = compiled.operationalCapabilities ?? [];
  const operational = id => ops.some(o => (o.endsWith('.') ? id.startsWith(o) : id === o));
  return (answer?.matches ?? []).filter(m => m.via === 'match' && !operational(String(m.id)));
}

function toolHint(answer, routed, lane) {
  const first = routed.tools[0];
  const other = first.otherLane ? ` [${first.note}]` : '';
  // A model step (applyModelRule): the model change leads and the tools are offered as a possibility, never as the
  // answer that the request is not a model change.
  if (routed.modelStep) {
    const deliver = lane === 'o11' ? 'o11_deliver' : 'studio_deliver';
    const left = routed.leftOut?.length ? ' Tools that write, publish or delete are not offered for the model step.' : '';
    const lead = routed.firstIsOtherStep ? 'For the step that is an SSAM operation' : 'An SSAM operation may also be meant';
    return `Model change: matches (job ops; deliver with ${deliver}; ssam_job only when asked). ${lead}: ${first.gap ? `no tool (${first.gap})` : callText(first)}${other}.${left}`;
  }
  if (first.gap) return `SSAM operation with no tool on lane ${first.lane}: ${brief(first.when, 200)}`;
  const touched = (answer.matches ?? []).length ? ' matches lists capabilities the same words touched: not needed unless the request also changes the model.' : '';
  // With a direct model match in discover() (words the tools explain), the line stays neutral: it never says the request
  // is not a model change.
  const kind = routed.hasModel ? 'SSAM operation' : 'SSAM operation (not a model change)';
  return `${kind}: ${callText(first)}${other}. Read tools[0].preconditions first; fill every <placeholder>.${touched}`;
}

// Model guidance stays with a model step. A reduced non-model index is not useful
// guidance for an operation: its actionable tool sentence is the whole hint.
function composeHint(answer, routed, lane) {
  const sentence = toolHint(answer, routed, lane);
  const keep = answer.hint && (routed.modelStep || routed.mixed || (routed.hasModel && (['insufficient', 'reduced'].includes(answer.size?.status) || /insufficient/i.test(answer.hint))));
  return keep ? `${answer.hint} | ${sentence}` : sentence;
}

// Insert `tools` right after `intent` (the first thing the model reads) and set the hint.
function withTools(answer, routed, level, lane) {
  const out = {}; let placed = false;
  const tools = levelItems(routed.tools, level);
  for (const [k, v] of Object.entries(answer)) {
    out[k] = v;
    if (!placed && (k === 'intent' || (k === 'lane' && answer.intent == null))) { out.tools = tools; placed = true; }
  }
  if (!placed) out.tools = tools;
  out.hint = composeHint(answer, routed, lane);
  if (answer.size) out.size = { ...answer.size, truncated: [...(answer.size.truncated ?? [])] };
  return out;
}

// Sections of a discover() answer that describe the answer, not the model change: left out (and named) before the tools of
// a mixed request are.
const META_SECTIONS = ['evidenceRule', 'lexical', 'coverage', 'identity', 'composition', 'terms'];

function measureInto(out, budgetBytes, reducedLevel) {
  if (!out.size) out.size = { bytes: 0, budgetBytes, status: 'within', truncated: [] };
  out.size.budgetBytes = budgetBytes; // a rerun of the model part at a smaller budget still answers for the caller's budget
  if (reducedLevel) { out.size.truncated.push({ section: 'tools', recover: `tools reduced to ${reducedLevel}: call ssam_discover again with a narrower intent or a larger budgetBytes for when/preconditions/next` }); out.size.status = out.size.status === 'insufficient' ? 'insufficient' : 'reduced'; }
  out.size.bytes = 0;
  for (let i = 0, m = bytes(out); i < 6 && out.size.bytes !== m; i++) { out.size.bytes = m; m = bytes(out); }
  return out.size.bytes;
}

// Fits the tools around the model part: discover() already budgeted the model part.
// - Request with direct model-change matches and model words no tool explains (mixed: a build verb, or a change verb with
//   a model element; or any element, widget or verb left over): the model part is never asked again nor cut; the tools
//   shrink (full -> compact -> names) and, when
//   even the names do not fit, they are left out and size.truncated says so (or, without room for that note, the
//   answer is discover()'s own).
// - An operation whose words the tools explain: the tools are the answer; when the full tools do not fit, discover() is
//   asked again with a smaller budget (its matches are what the tools' own words touched), and as a last resort the
//   answer keeps only the envelope and the tools. A model change gets no tools at all (the router is silent), so its answer is
//   discover()'s own.
export async function attachTools(answer, routed, { budgetBytes, lane, rerun = null } = {}) {
  const B = budgetBytes ?? answer.size?.budgetBytes ?? 40960;
  // With model-change matches the tools' words do not explain (mixed, or model words left over) the model part is
  // discover()'s own at the caller's budget: never asked again with a smaller budget nor cut; only the tools shrink or are
  // left out.
  if (routed.mixed || routed.keepModel || routed.modelStep) {
    // Room for the tools comes first from the answer's metadata (evidenceRule, lexical, coverage, identity, composition,
    // terms), never from matches, contracts, examples, bindings, routes, validation or continuation; each section left
    // out is named in size.truncated.
    for (const level of ['full', 'compact', 'names']) {
      let slim = answer; const dropped = [];
      for (const k of [null, ...META_SECTIONS]) {
        if (k) { if (!(k in slim)) continue; slim = { ...slim }; delete slim[k]; dropped.push(k); }
        const c = withTools(slim, routed, level, lane);
        for (const s of dropped) c.size.truncated.push({ section: s, recover: `left out for the tools: call ssam_discover again with the model step alone, or a larger budgetBytes, for ${s}` });
        if (measureInto(c, B, level === 'full' ? null : level) <= B) return c;
      }
    }
    if (answer.size) {
      const c = { ...answer, size: { ...answer.size, truncated: [...(answer.size.truncated ?? []), { section: 'tools', recover: `the operation's tool (${routed.tools.map(t => t.tool ?? t.gap).join(', ')}) did not fit beside the model part: call ssam_discover again with that step alone or a larger budgetBytes` }] } };
      if (measureInto(c, B, null) <= B) return c;
    }
    return answer;
  }
  // An operation (its model matches, if any, are words the tools already explain): the tools are the answer and keep
  // their arguments, preconditions and next call; the model part gives room.
  for (const level of ['full']) { const c = withTools(answer, routed, level, lane); if (measureInto(c, B, null) <= B) return c; }
  for (const level of ['full', 'compact', 'names']) {
    const toolsBytes = bytes(levelItems(routed.tools, level)) + bytes(toolHint(answer, routed, lane)) + 400;
    const B2 = B - toolsBytes;
    if (rerun && B2 >= 4096) {
      const smaller = await rerun(B2);
      const c = withTools(smaller, routed, level, lane);
      if (measureInto(c, B, level === 'full' ? null : level) <= B) return c;
    }
  }
  for (const level of ['full', 'compact', 'names']) {
    const envelope = { ok: true, schemaVersion: answer.schemaVersion, lane: answer.lane ?? lane, ...(answer.intent != null ? { intent: answer.intent } : {}),
      matches: (answer.matches ?? []).filter(m => m.via === 'match').map(m => ({ id: m.id, via: 'match', expand: `${m.id}:contract+example+evidence+operations+native+bindings` })),
      ...(answer.unavailable?.length ? { unavailable: answer.unavailable.map(x => ({ id: x.id })) } : {}),
      size: { bytes: 0, budgetBytes: B, status: 'reduced', truncated: [{ section: 'model', recover: 'raise budgetBytes for the model part (contracts, examples, bindings) of this intent' }] } };
    const c = withTools(envelope, routed, level, lane);
    if (measureInto(c, B, level === 'full' ? null : level) <= B) return c;
  }
  const minimal = { ok: true, lane, tools: levelItems(routed.tools, 'names').slice(0, 1), size: { bytes: 0, budgetBytes: B, status: 'reduced', truncated: [] } };
  measureInto(minimal, B, 'names');
  return minimal;
}

// An answer with a direct model match never tells the request it is not a model change: an operational capability among
// its matches is shown with its tools.json operationalTitles title (the catalog title is indexed and stays unchanged).
// Only titles change; size.bytes is measured again.
export function withOperationalTitles(answer, compiled = loadToolRoutes()) {
  const titles = compiled.operationalTitles ?? {};
  if (!(answer.matches ?? []).some(m => titles[m.id] && m.title !== titles[m.id])) return answer;
  const out = { ...answer, matches: answer.matches.map(m => (titles[m.id] && m.title !== titles[m.id] ? { ...m, title: titles[m.id] } : m)) };
  if (out.size && typeof out.size.bytes === 'number') {
    out.size = { ...out.size, bytes: 0 };
    for (let i = 0, m = bytes(out); i < 6 && out.size.bytes !== m; i++) { out.size.bytes = m; m = bytes(out); }
  }
  return out;
}

// A call without intent, expand, detail or type: the exact shape of a call and the continuation that keeps its app, never
// the catalog (catalog:true asks for it). Under 1 KB.
const hasExpansion = input => ['expand', 'detail', 'type'].some(k => typeof input[k] === 'string' && input[k].trim() !== '');
export function intentRequired(lane, input = {}) {
  const app = typeof input.app === 'string' && input.app.trim() ? input.app.trim().slice(0, 260) : null;
  return { ok: false, code: 'INTENT_REQUIRED', lane, error: 'intent is required: what to do, in words (Portuguese or English); nothing was read',
    shape: { intent: '<what to do, in words>', lane: 'o11|odc', 'app?': '<Module or capture.oml>', 'packet?': true, 'expand?': '<id>:contract+example', 'catalog?': true },
    continuation: { tool: 'ssam_discover', arguments: { lane, intent: '<what to do, in words>', ...(app ? { app, packet: true } : {}) },
      why: 'the same call with the intent: the exact tool, verb and arguments, or the contracts, a proven example and the next step' },
    catalog: { tool: 'ssam_discover', arguments: { lane, catalog: true }, why: 'every capability and tool of the lane by group, only when that list is what you need' } };
}

// ---- the single entry: discover() unchanged, plus `tools` when the intent asks for an SSAM operation.
// A direct question about what the O11 environment offers for a need the platform lacks ("o que tenho no ambiente para gerar
// PDF", environment-components.mjs asksEnvironment): the answer carries `environment` (the installed extensions and Forge
// components, each with its actions and signatures, cached per environment) right after `intent`, the rest of the answer in
// the budget it leaves. input.components replaces the reader (tests).
export async function discoverAll(input = {}, options = {}) {
  input = { ...input, budgetBytes: input.budgetBytes ?? (hasExpansion(input) || input.packet === true || input.catalog === true ? 40960 : ANSWER_BUDGETS.discoverFirst) };
  // A generator asked about BY NAME ("entity-actions", "rest-consume", "gen-screen"; generators.mjs namedGenerators): the
  // answer describes it with its state (approved or blind-test-pending), reason, report, contract and explicit call, right
  // after `intent`, in the room it takes from the budget. Nothing else names a generator that is not approved.
  const named = String(input.intent ?? '').trim() ? namedGenerators(input.intent).map(id => describeGenerator(id, input.lane ?? 'odc')) : [];
  const room = named.length ? bytes({ generators: named }) + 64 : 0;
  let answer = await discoverWithEnvironment(room ? { ...input, budgetBytes: Math.max(4096, input.budgetBytes - room) } : input, options);
  if (room && answer && typeof answer === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(answer)) { out[k] = v; if (k === 'intent') out.generators = named; }
    if (!('generators' in out)) out.generators = named;
    if (out.size && typeof out.size.bytes === 'number') { out.size = { ...out.size, bytes: 0 }; for (let i = 0, m = bytes(out); i < 6 && out.size.bytes !== m; i++) { out.size.bytes = m; m = bytes(out); } }
    answer = out;
  }
  return (await import('./discovery.mjs')).exactDiscoveryCalls(answer, input);
}

async function discoverWithEnvironment(input, options) {
  const lane = input.lane ?? 'odc';
  if (input.packet === true || lane !== 'o11' || !String(input.intent ?? '').trim()) return discoverAllCore(input, options);
  const { asksEnvironment, componentNeeds, laneComponents, fitComponents } = await import('./environment-components.mjs');
  if (!asksEnvironment(input.intent)) return discoverAllCore(input, options);
  const { anvilRoot } = await import('./workspace.mjs');
  const read = input.components ?? (x => laneComponents(x, { root: anvilRoot }));
  const found = await read({ lane, intent: input.intent, needs: componentNeeds(input.intent) });
  const budget = input.budgetBytes ?? 40960;
  const environment = found?.ok === false ? found : fitComponents(found, Math.min(12288, Math.floor(budget / 2))) ?? { ok: true, schema: found.schema, needs: found.needs, note: 'reduced by budget' };
  const answer = await discoverAllCore({ ...input, budgetBytes: Math.max(4096, budget - bytes({ environment }) - 64) }, options);
  if (!answer || typeof answer !== 'object') return answer;
  const out = {};
  for (const [k, v] of Object.entries(answer)) { out[k] = v; if (k === 'intent') out.environment = environment; }
  if (!('environment' in out)) out.environment = environment;
  if (out.size && typeof out.size.bytes === 'number') { out.size = { ...out.size, bytes: 0 }; for (let i = 0, m = bytes(out); i < 6 && out.size.bytes !== m; i++) { out.size.bytes = m; m = bytes(out); } }
  return out;
}

async function discoverAllCore(input = {}, { discover = null, file = TOOLS_FILE } = {}) {
  const run = discover ?? (await import('./discovery.mjs')).discoverModel;
  const lane = input.lane ?? 'odc';
  const intent = String(input.intent ?? '');
  // The entry's answer ceiling (discovery.mjs atEntry): a budget below the minimal answer is raised to it, a minimal above
  // the ceiling answers in pages. Only the calls that answer the caller carry it; a classification or a rerun for the room
  // of the tools keeps the hard budget it is given.
  const ceilingBytes = input.ceilingBytes !== undefined ? input.ceilingBytes : (await import('./discovery.mjs')).answerCeiling();
  const entry = { ...input, ceilingBytes };
  let compiled = null; let toolsError = null;
  try { compiled = loadToolRoutes(file); if (compiled.problems.length) { toolsError = 'tools.json: ' + compiled.problems.slice(0, 5).join('; '); compiled = null; } }
  catch (e) { toolsError = 'tools.json unavailable: ' + e.message; }
  if (!intent.trim()) {
    // Without intent and without expand/detail/type: the exact shape of the call, under 1 KB (2026-10-12: the catalog of
    // every capability and tool came back as an 11.6 KB error to a call that only lacked its intent). The catalog is
    // catalog:true, asked for by name.
    if (input.catalog !== true && !hasExpansion(input)) return intentRequired(lane, input);
    const answer = await run(entry);
    if (!compiled) return toolsError ? { ...answer, toolsError } : answer;
    if (answer.ok !== false || answer.expansions) return answer; // expand/detail/type: no tools
    const { toolGroups: groups, otherLaneTools } = toolGroups(lane, compiled);
    // The catalog asked by name is an answer, not a refusal; the index identity stays out (the expand answers carry it).
    const { categories, capabilities, coverage } = answer;
    return { ok: true, schemaVersion: answer.schemaVersion, lane, catalog: true, categories, capabilities, coverage, toolGroups: groups, otherLaneTools,
      next: 'call ssam_discover with an intent for the exact call (tool, verb and arguments) or the contracts of a model change' };
  }
  const routed = compiled ? routeTools({ intent, lane }, compiled) : { tools: [] };
  // packet:true (W1): discover()'s work packet as it is, sized by itself; the tools the words route to ride in its next
  // section by name only (no fitting around it, so the same input keeps the same bytes).
  if (input.packet === true) return run({ ...input, operations: routed.tools.length ? levelItems(routed.tools, 'names') : null });
  let answer;
  try { answer = await run(entry); }
  catch (error) {
    if (!routed.tools.length) throw error;
    const fallback = { ok: true, schemaVersion: 'ssam-discovery/4', lane, intent, indexError: error.message };
    return attachTools(fallback, routed, { budgetBytes: input.budgetBytes ?? 40960, lane });
  }
  if (!compiled) return toolsError ? { ...answer, toolsError } : answer;
  if (answer.ok === false) return answer;
  routed.hasModel = modelMatchesOf(answer, compiled).length > 0;
  const { outsystemsUiRequest, stripOutsystemsUi, fitOutsystemsUi, stripC07, fitC07, sectionsFloor, silentlyLost, withAdjustment, stripTextRoute, fitTextRoute, TEXT_ROUTE_SECTION } = await import('./discovery.mjs');
  const budgetRaise = a => a.inputAdjusted?.find(x => x.path === '/budgetBytes');
  if (routed.hasModel) answer = withOperationalTitles(answer, compiled);
  // A budget raised to the minimal answer (discovery.mjs atEntry) was measured on the catalog titles: a longer operational
  // title restates it, never leaving the answer above the budget it declares ("delete the record" at 4,096: 7,126 bytes
  // under a declared 7,055).
  if (budgetRaise(answer) && answer.size?.bytes > answer.size.budgetBytes) answer = withAdjustment(answer, { ...budgetRaise(answer), to: answer.size.bytes });
  if (!routed.tools.length) return answer;
  // supersedes: a live tool that contradicts an `unavailable` entry of this answer says so on its item.
  if (answer.unavailable?.length) { const again = routeTools({ intent, lane, unavailable: answer.unavailable.map(x => x.id) }, compiled); routed.tools = again.tools; routed.steps = again.steps; routed.residual = again.residual; }
  if (routed.hasModel) {
    // The words of a step are classified at a budget that keeps every match's score (a reduced answer drops them); this
    // call only classifies, the answer's model part stays the one above (the parts asked by expand/detail/type stay
    // there too: the classification never builds them).
    await applyModelRule(routed, text => run({ ...input, intent: text, budgetBytes: CLASSIFY_BUDGET, ceilingBytes: null, expand: null, detail: null, type: null }), compiled, intent);
    if (!routed.tools.length) return answer;
  }
  routed.mixed = routed.modelRest && routed.hasModel;
  routed.keepModel = routed.modelStep || (routed.hasModel && routed.modelWordsLeft);
  // The OutSystems UI section of a screen-building intent never takes the tools' room: it leaves before they are
  // fitted and comes back in the room they leave (discovery.mjs fitOutsystemsUi); an operation with no model match
  // ("abrir a página do Portal") gets none.
  // The same for the proven example, the step grammar and the values (C07 of the 2026-10-05 package): they come back
  // last, in the room the tools and the section leave.
  let B = input.budgetBytes ?? answer.size?.budgetBytes ?? 40960;
  // A model part raised to its minimal (atEntry) keeps the tools beside it: the budget is the raised one plus the room of
  // the tools, under the ceiling, and the adjustment says so. An operation (the tools are the answer) keeps the caller's
  // budget: its model part is asked again below it (rerun, hard budget) as before.
  const raised = budgetRaise(answer);
  if (raised && (routed.mixed || routed.keepModel || routed.modelStep)) {
    B = Math.max(raised.to, Math.min(ceilingBytes ?? Infinity, raised.to + bytes(levelItems(routed.tools, 'full')) + bytes(toolHint(answer, routed, lane)) + 64));
    answer = { ...answer, inputAdjusted: answer.inputAdjusted.map(a => (a === raised ? { ...a, to: B } : a)), ...(answer.size?.budgetAdjusted ? { size: { ...answer.size, budgetAdjusted: { ...answer.size.budgetAdjusted, to: B } } } : {}) };
  }
  const osui = routed.hasModel ? await outsystemsUiRequest({ lane, intent, matches: answer.matches, context: answer.context ?? null, app: input.app ?? null, map: input.map ?? null }) : null;
  // The text route of the model step (B2 of the plan "Texto do SSAM", text-routes.mjs) comes back after the tools too, before the
  // OutSystems UI section and the C07 sections: the operation's tool, then the ready call of the text step.
  let extras = null; let textRoute = null;
  const strip = a => { const s = stripC07(stripOutsystemsUi(a)); extras ??= s.extras; const t = stripTextRoute(s.answer); textRoute ??= a?.[TEXT_ROUTE_SECTION] ?? t.section; return t.answer; };
  const out = await attachTools(strip(answer), routed, { budgetBytes: B, lane, rerun: async B2 => { const again = strip(await run({ ...input, budgetBytes: B2, ceilingBytes: null })); return routed.hasModel ? withOperationalTitles(again, compiled) : again; } });
  // `room` for the C07 extras, when given: the text route and the OutSystems UI section take the budget less it. The text
  // route never takes the floor of the C07 extras (discovery.mjs, the junction of 24.1) and keeps the answer's budget.
  const sectionsAt = (a, budget, room = 0) => {
    const withText = textRoute ? fitTextRoute(a, textRoute, budget - Math.max(room, extras ? sectionsFloor({ extras }, budget).c07 : 0), null, budget) : a;
    const withOsui = osui ? fitOutsystemsUi(withText, osui, budget - room) : withText;
    return extras ? fitC07(withOsui, extras, budget) : withOsui;
  };
  const final = sectionsAt(out, B);
  // At the entry no section goes without a word (review of 2026-10-11, round 3): when the tools left the OutSystems UI
  // section or the C07 extras no room even for their note, the budget rises by their floor (sectionsFloor) under the
  // ceiling, the model part and the tools as they are, and the answer says so (raise-to-minimal).
  if (ceilingBytes == null || !silentlyLost(final, { osui, extras }).length) return final;
  const floor = sectionsFloor({ osui, extras }, B);
  const to = B + floor.bytes;
  if (to > Math.max(ceilingBytes, B)) return final;
  const again = sectionsAt(withAdjustment(out, { path: '/budgetBytes', from: raised?.from ?? input.budgetBytes ?? B, to, rule: 'raise-to-minimal' }), to, floor.c07);
  return silentlyLost(again, { osui, extras }).length ? final : again;
}

// The model rule. A step of the request (the clauses where a route's trigger held, else the whole request) is a model
// change when its words that the route does not explain still match a model capability directly (discover() on those
// words; operational capabilities do not count). The words a route explains are the operation's own (the timer of
// "rodar o timer", the entity of "inserir registros na entidade"): a capability named only by them is the operation's
// object, not a change. A match counts with a keyword-strength score (MODEL_SCORE: a title or summary word alone scores
// 1-2), or with any score when those words also carry the router's model vocabulary (an element, a widget, a build or
// change verb, a condition): "3 clientes de teste" (a title word) stays the records of an insert, "add logic" does not.
// On a model step only routes whose effect is 'read' or 'delivery' stay; a step with no model match keeps its routes as
// before. `modelStep`: some step, or the words no route explains, match a model capability: the hint then never says
// the request is not a model change, and the model part is never asked again nor cut.
export const MODEL_SCORE = 3;
const CLASSIFY_BUDGET = 4 * 1024 * 1024;
// A request placed inside the app ("na action Salvar, ...", "in the Approve action ...", "quando o pedido ...") is ONE
// change: its "e" / "and" joins parts of the same logic ("validar o total e atualizar o registro"). When such a request is
// a model change and has no explicit sequence (a sequence word, a sentence break, a semicolon, a numbered item), every
// tool that writes is left out, whatever clause its trigger held in.
const SEQUENCE_WORDS = new Set(['then', 'depois', 'entao', 'apos', 'after', 'afterwards', 'next', 'seguida', 'finally', 'finalmente', 'later', 'logo']);
const PLACE_LEADS = new Set(['in', 'inside', 'within', 'na', 'no', 'nas', 'nos', 'dentro', 'em']);
const APP_PLACES = new Set(['action', 'actions', 'acao', 'acoes', 'screen', 'tela', 'flow', 'fluxo', 'timer', 'button', 'botao', 'event', 'evento', 'block', 'bloco', 'logic', 'logica', 'aggregate', 'agregado', 'form', 'formulario']);
const CONDITION_LEADS = new Set(['when', 'whenever', 'quando', 'sempre']);
export function isSequence(intent) {
  const text = String(intent ?? '');
  if (/;|[.!?]\s+\S|(^|\s)\d+[.)]\s/.test(text)) return true;
  return normalize(text).split(/[^a-z0-9_]+/).some(t => SEQUENCE_WORDS.has(t));
}
export function isInsideApp(intent) {
  const toks = normalize(String(intent ?? '')).split(/[^a-z0-9_]+/).filter(Boolean);
  return toks.some((t, i) => CONDITION_LEADS.has(t) || (PLACE_LEADS.has(t) && toks.slice(i + 1, i + 4).some(x => APP_PLACES.has(x))));
}
export async function applyModelRule(routed, matchModel, compiled = loadToolRoutes(), intent = null) {
  const memo = new Map();
  const bestScore = text => {
    if (!memo.has(text)) memo.set(text, Promise.resolve().then(() => matchModel(text)).then(a => Math.max(0, ...modelMatchesOf(a, compiled).map(m => (typeof m.score === 'number' ? m.score : MODEL_SCORE))), () => Infinity));
    return memo.get(text);
  };
  const isModel = async res => { const text = typeof res === 'string' ? res : res?.text ?? ''; if (!text.trim()) return false; const s = await bestScore(text); return s >= MODEL_SCORE || (s > 0 && !!res?.modelWords); };
  const steps = routed.steps ?? routed.tools.map(() => ({ effect: 'write', residual: { text: '', modelWords: false } }));
  const flags = await Promise.all(steps.map(s => isModel(s.residual)));
  const restModel = await isModel(routed.residual ?? '');
  const kept = []; const left = [];
  const oneChange = intent != null && (restModel || flags.some(Boolean)) && isInsideApp(intent) && !isSequence(intent);
  routed.tools.forEach((t, i) => (((flags[i] || oneChange) && !MODEL_STEP_EFFECTS.has(steps[i].effect)) ? left : kept).push(i));
  routed.leftOut = left.map(i => routed.tools[i].tool ?? 'gap:' + routed.tools[i].gap);
  routed.tools = kept.map(i => routed.tools[i]);
  routed.steps = kept.map(i => ({ ...steps[i], model: flags[i] }));
  routed.modelStep = restModel || flags.some(Boolean);
  // A kept tool that writes is, by construction, the tool of a step with no model match (the publish of "criar a
  // entidade X e depois publicar o módulo"): the hint names it as that step's tool, not as the model step's.
  routed.firstIsOtherStep = routed.modelStep && !!routed.steps[0] && !routed.steps[0].model && !MODEL_STEP_EFFECTS.has(routed.steps[0].effect);
  return routed;
}

// node tool-routing.mjs "<intent>" [--lane odc|o11]: the routes only (no index), for curation.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const at = args.indexOf('--lane'); const lane = at >= 0 ? args.splice(at, 2)[1] : 'odc';
  process.stdout.write(JSON.stringify(routeTools({ intent: args.join(' '), lane }), null, 1) + '\n');
}
