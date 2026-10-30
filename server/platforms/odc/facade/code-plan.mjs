// Deterministic, capture-only planning. No Studio operations or generated code run here.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { newestCapture, codeRoots, baseProblem } from './code-check.mjs';
import { moduleDigest } from './module-map.mjs';
import { moduleItems, rulesSection } from './work-packet.mjs';
import { indexLine } from './module-digest.mjs';
import { grammarCard, headerOf } from './ssam-code.mjs';

export const PLAN_VERSION = 1;
export const PLAN_MIN_ITEMS = 6;
export const KIND_BYTES = Object.freeze({ action: 700, screen: 2500, block: 1800, data: 250 });
export const BATCH_TARGET_BYTES = 6000;
export const PACKET_TARGET_BYTES = 65536;
const bytes = text => Buffer.byteLength(String(text ?? ''), 'utf8');
const escape = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const estimate = item => (KIND_BYTES[item.kind] ?? 0) + bytes(item.intent) + bytes(item.signature);

/** Only interfaces, never bodies or styles, are carried into another worker. */
export function signatureOf(text) {
  const source = String(text ?? '').replace(/\r\n/g, '\n');
  if (/^\s*(?:<!--[\s\S]*?-->\s*)*<(?:screen|block)\b/.test(source)) {
    const clean = source.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
    return [clean.match(/<(?:screen|block)\b[^>]*>/i)?.[0],
      ...[...clean.matchAll(/<(?:input|event|var)\b[^>]*(?:\/>|>[\s\S]*?<\/(?:input|event|var)\s*>)/gi)]
        .map(m => m[0]).filter(tag => /^<(?:input|event|var)\b[^>]*\bname\s*=/i.test(tag))].filter(Boolean).join('\n');
  }
  const ls = source.split('\n'), start = ls.findIndex(line => headerOf(line));
  if (start < 0) return '';
  return [ls[start], ...ls.slice(start + 1).filter(line => /^\s+(?:in|out)\s+/.test(line))].join('\n');
}

export function itemCalls(item, items) {
  const text = `${item.intent ?? ''}\n${item.signature ?? ''}`;
  return items.filter(other => other !== item && (item.calls?.includes(other.name)
    || new RegExp(`(?<![\\w.])${escape(other.name)}(?![\\w.])`).test(text))).map(other => other.name);
}

// Interval closure preserves request order even when an owner's actions occur much later.
export function itemUnits(items) {
  const work = items.filter(item => item.kind !== 'data');
  const owners = new Map(work.flatMap((item, i) => ['screen', 'block'].includes(item.kind) ? [[item.name, i]] : []));
  const end = work.map((_, i) => i);
  work.forEach((item, i) => {
    if (item.kind !== 'action' || !item.name.includes('.')) return;
    const owner = owners.get(item.name.slice(0, item.name.lastIndexOf('.')));
    if (owner != null) end[Math.min(owner, i)] = Math.max(end[Math.min(owner, i)], owner, i);
  });
  const units = [];
  for (let i = 0; i < work.length;) {
    let last = end[i];
    for (let j = i; j <= last; j++) last = Math.max(last, end[j]);
    const own = work.slice(i, last + 1);
    units.push({ items: own, estimateBytes: own.reduce((n, item) => n + estimate(item), 0) });
    i = last + 1;
  }
  return units;
}

/** DP: feasible 1.25 cap, minimum crossing calls, squared imbalance, earliest cuts. */
export function batchItems(items, { workers } = {}) {
  const units = itemUnits(items), n = units.length;
  if (!n) return [];
  const total = units.reduce((s, u) => s + u.estimateBytes, 0);
  const count = Math.max(1, Math.min(n, 8, workers ?? Math.ceil(total / BATCH_TARGET_BYTES)));
  const prefix = [0]; units.forEach(u => prefix.push(prefix.at(-1) + u.estimateBytes));
  const index = new Map(units.flatMap((u, i) => u.items.map(x => [x.name, i])));
  const edges = units.flatMap((u, i) => u.items.flatMap(item => itemCalls(item, items).map(name => [i, index.get(name)]))).filter(([a, b]) => b != null && a !== b);
  const edgePrefix = Array.from({ length: n + 1 }, () => Array(n + 1).fill(0));
  for (const [a, b] of edges) edgePrefix[a + 1][b + 1]++;
  for (let a = 1; a <= n; a++) for (let b = 1; b <= n; b++) edgePrefix[a][b] += edgePrefix[a - 1][b] + edgePrefix[a][b - 1] - edgePrefix[a - 1][b - 1];
  const internal = Array.from({ length: n }, () => Array(n + 1).fill(0));
  for (let a = 0; a < n; a++) for (let b = a + 1; b <= n; b++) internal[a][b] = edgePrefix[b][b] - edgePrefix[a][b] - edgePrefix[b][a] + edgePrefix[a][a];
  const lex = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  function solve(cap) {
    const dp = Array.from({ length: count + 1 }, () => Array(n + 1).fill(null));
    dp[0][0] = { kept: 0, balance: 0, cuts: [] };
    for (let k = 1; k <= count; k++) for (let j = k; j <= n; j++) for (let i = k - 1; i < j; i++) {
      const previous = dp[k - 1][i], size = prefix[j] - prefix[i];
      if (!previous || size > cap + 1e-8) continue;
      // Total and count are fixed: sum(size²) has the same minimum as squared
      // deviations, without fractional rounding breaking the earliest-cut tie.
      const candidate = { kept: previous.kept + internal[i][j], balance: previous.balance + size ** 2, cuts: [...previous.cuts, j] };
      const old = dp[k][j];
      if (!old || candidate.kept > old.kept || candidate.kept === old.kept && (candidate.balance < old.balance || candidate.balance === old.balance && lex(candidate.cuts, old.cuts) < 0)) dp[k][j] = candidate;
    }
    return dp[count][n];
  }
  let best = solve(1.25 * total / count);
  if (!best) {
    // An indivisible owner can exceed the cap. Use the smallest possible maximum first.
    const sizes = [...new Set(prefix.flatMap((p, i) => prefix.slice(i + 1).map(q => q - p)))].sort((a, b) => a - b);
    let lo = 0, hi = sizes.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (solve(sizes[mid])) hi = mid; else lo = mid + 1; }
    best = solve(sizes[lo]);
  }
  let start = 0;
  return best.cuts.map((end, i) => { const chosen = units.slice(start, end); start = end;
    return { id: i + 1, items: chosen.flatMap(u => u.items), estimateBytes: chosen.reduce((s, u) => s + u.estimateBytes, 0) }; });
}

/** Explicit counts and distinct code identifiers absent from the capture. */
export function planSize(intent, digest) {
  const text = String(intent ?? '');
  let count = 0;
  for (const m of text.matchAll(/\b(\d+)\s+(?:(?:server|client|service|data)\s+)?(?:actions?|aç(?:ão|ões)|acoes|acao|screens?|telas?|pages?|páginas?|paginas?|blocks?|blocos?|entities|entity|entidades?|structures?|estruturas?)\b/gi)) count = Math.max(count, Number(m[1]));
  const existing = new Set([...(digest?.actions ?? []).map(x => x.name), ...(digest?.sections ?? []).flatMap(s => (s.blocks ?? []).map(x => x.name))].map(x => x.toLowerCase()));
  const names = new Set();
  const add = name => { if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name) && !existing.has(name.toLowerCase())) names.add(name.toLowerCase()); };
  for (const match of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_]\w*)*\b/g)) if (/[a-z][A-Z]|_|\./.test(match[0])) add(match[0]);
  // A simple identifier need not have CamelCase when the user explicitly lists or quotes it.
  for (const match of text.matchAll(/[`"']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[`"']/g)) add(match[1]);
  const labels = /\b(?:actions?|aç(?:ão|ões)|acoes|acao|screens?|telas?|pages?|páginas?|paginas?|blocks?|blocos?|entities|entity|entidades?|structures?|estruturas?)\s*:?\s+([^\n]+)/gi;
  for (const match of text.matchAll(labels)) {
    const list = match[1].split(/[.!?](?:\s|$)/)[0];
    if (!/[,;]|\s(?:and|e)\s/.test(list) && !/^\s*[`"']/.test(list)) continue;
    for (const item of list.split(/\s*(?:[,;]|\band\b|\be\b)\s*/i)) add(item.trim().replace(/^[`"']|[`"']$/g, ''));
  }
  return Math.max(count, names.size);
}

// An explicit division of work does not require six newly named elements.
export function dividedWork(intent, { workers, items, parallel } = {}) {
  const text = String(intent ?? '');
  return parallel === true || workers > 1 || (Array.isArray(items) && items.length > 1)
    || /\b(?:sub[ -]?agents?|subagentes?|parallel|paralel[oa]s?|delegate|delegar)\b/i.test(text)
    || /\b(?:multiple|several|many|varias|várias|varios|vários|diversas|diversos)\s+(?:(?:server|client|service|data)\s+)?(?:actions|screens|pages|blocks|aç[õo]es|acoes|telas|paginas|páginas|blocos)\b/i.test(text)
    || workItemCount(text) > 1;
}

export function workItemCount(intent) {
  const text = String(intent ?? '');
  const numbers = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,
    thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,hundred:100,
    um:1,uma:1,dois:2,duas:2,'três':3,tres:3,quatro:4,cinco:5,seis:6,sete:7,oito:8,nove:9,dez:10,onze:11,doze:12,
    treze:13,catorze:14,quatorze:14,quinze:15,dezesseis:16,dezasseis:16,dezessete:17,dezassete:17,dezoito:18,dezenove:19,dezanove:19,vinte:20,trinta:30,quarenta:40,cinquenta:50,sessenta:60,setenta:70,oitenta:80,noventa:90,cem:100,cento:100 };
  let count = 0;
  const word = '(?:\\d+|' + Object.keys(numbers).join('|') + ')';
  const target = /\s+(?:(?:server|client|service|data)\s+)?(?:actions?|screens?|pages?|blocks?|entities|structures|ações|acoes|ação|acao|telas?|blocos?|entidades?|estruturas?)\b/;
  const re = new RegExp('\\b(' + word + '(?:[ -]+(?:and|e|' + word + '))*)' + target.source, 'gi');
  for (const m of text.matchAll(re)) {
    let value = 0;
    for (const token of m[1].toLowerCase().split(/[ -]+/).filter(t => !['and', 'e'].includes(t))) {
      const n = numbers[token] ?? Number(token); value = n === 100 ? Math.max(1, value) * 100 : value + n;
    }
    count += value;
  }
  if (count) return count;
  if (/^\s*(?:rename|renomear)\b/i.test(text)) return 1;
  const named = /\b(?:create|build|add|criar|adicionar)\s+([\w ,]+?)\s+(?:actions|screens|blocks|entities|structures|telas|blocos|entidades|estruturas)\b/i.exec(text);
  if (named) {
    const names = named[1].split(/\s*(?:,|\band\b|\be\b)\s*/i).filter(Boolean);
    if (names.length > 1) return names.length;
  }
  const list = /\b(?:create|build|add|implement|criar|adicionar|update)\s+(?:[A-Za-z_]\w*\s*(?:,|\band\b|\be\b)\s*)+[A-Za-z_]\w*[.!?]?$/i.test(text);
  return list || /^\s*(?:actions?|screens?|blocks?|blocos?|telas?)\s*:/i.test(text) ? planSize(text) : 0;
}

const call = args => ({ tool: 'ssam_code', arguments: args });
const launchPrompt = file => `Read ${file} and do exactly what it says; answer only the path(s)`;
// feat/ssam-code-hosted: deps.place, where the session that runs a plan meets its files, for a server whose subagents run on
// another machine (a hosted one). Every hook is optional; without them every path is this machine's, as it is.
//   shown(file)    -> how a file of this server (the capture, a stub, a shared file, the plan folder) is named in the calls
//                     and in the answer, as the session passes it back
//   output(file)   -> the path a subagent writes a data or batch file at (and the calls name it by)
//   input(file)    -> the path a subagent reads a plan file at (its prompt, plan.json)
//   document(section, value) -> SSAM's documentation inside a prompt (section 'grammar': the cards; 'rules': the rules
//                     section) as that session may read it, before it is written as JSON
//   publish(files) -> async, once the plan file and the prompts are written: makes each one readable at input(file); what it
//                     throws is the plan's refusal ({code, error}: nothing to launch)
const SAME = Object.freeze({ shown: file => file, output: file => file, input: file => file, document: (section, value) => value, publish: async () => {} });
const placeOf = deps => ({ ...SAME, ...Object.fromEntries(Object.entries(deps.place ?? {}).filter(([k, v]) => k in SAME && typeof v === 'function')) });
const finish = '\nDo not call ssam_discover/ssam_map/ssam_code read; run the check until ok; answer only the path(s).\n';
function promptOf(sections, recovery) {
  const markers = sections.map(([name]) => `## ${name} (cut)\nRead ${recovery} for the complete ${name} section.\n\n`);
  let text = '', remaining = PACKET_TARGET_BYTES - bytes(finish), sectionBytes = {}, cuts = [];
  let reserved = markers.reduce((sum, marker) => sum + bytes(marker), 0);
  for (const [i, [name, value]] of sections.entries()) {
    const section = `## ${name}\n${value}\n\n`;
    const cut = markers[i]; reserved -= bytes(cut);
    if (bytes(section) <= remaining - reserved) { text += section; remaining -= bytes(section); sectionBytes[name] = bytes(section); }
    else {
      text += cut; remaining -= bytes(cut); sectionBytes[name] = bytes(cut);
      cuts.push(name); }
  }
  return { text: text + finish, sectionBytes, cuts };
}
const stubOf = item => {
  const signature = signatureOf(item.signature);
  if (item.kind === 'action') return signature + '\n  end\n';
  const tag = item.kind === 'block' ? 'block' : 'screen';
  return signature.replace(new RegExp(`<${tag}([^>]*?)/>`), `<${tag}$1>`) + `\n</${tag}>\n`;
};

// Use the same extracted kernel contract and catalog guidance as discovery.
export async function planBriefing(lane, parts, { briefingIndex, sources } = {}) {
  const { buildIndex, laneSources, contractSlice } = await import('./discovery.mjs');
  const source = sources ?? laneSources(lane);
  let index = briefingIndex;
  if (!index) {
    try { index = (await buildIndex(lane, { sources: source })).index; }
    catch { throw new Error('The kernel contracts for the plan are unavailable.'); }
  }
  const pointers = { ddl: 'spec.ddl', logic: 'logic.flow', html: 'html.document' };
  const chosen = new Set(parts.map(p => pointers[p]));
  const contract = contractSlice(index, [...chosen], { full: true, capBytes: Infinity });
  if ([...chosen].some(p => !(p in contract))) throw new Error('A required kernel contract is missing from the plan index.');
  const capabilities = (index.capabilities ?? []).filter(c => (c.contract ?? []).some(p => [...chosen].some(w => p.split('.')[0] === w.split('.')[0])));
  return {
    contract,
    pitfalls: capabilities.map(c => ({ id: c.id, limits: c.limits ?? [], guidance: c.guidance ?? null, alternatives: c.alternatives ?? [] })),
  };
}

export async function codePlan(input = {}, deps = {}) {
  const lane = input.lane ?? 'o11', module = input.module ?? input.target, items = input.items;
  const problems = [], problem = (at, message) => problems.push({ code: 'INPUT_INVALID', at, message });
  if (!['o11', 'odc'].includes(lane)) problem('lane', 'lane is o11 or odc');
  if (typeof module !== 'string' || !module.trim()) problem('module', 'module is required');
  if (!Array.isArray(items) || !items.length || items.length > 200) problem('items', 'items needs 1..200 elements');
  const valid = [], names = new Set();
  for (const [i, item] of (Array.isArray(items) ? items : []).entries()) {
    if (!item || typeof item !== 'object' || !Object.hasOwn(KIND_BYTES, item.kind) || typeof item.name !== 'string' || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(item.name) || typeof item.intent !== 'string') { problem(`items/${i}`, 'kind, name and intent are required'); continue; }
    if (names.has(item.name)) problem(`items/${i}/name`, 'item names must be unique'); names.add(item.name);
    if (item.signature != null && typeof item.signature !== 'string') problem(`items/${i}/signature`, 'signature is text');
    if (typeof item.signature === 'string' && item.signature.trim() && item.kind !== 'data') {
      const signature = signatureOf(item.signature);
      const target = item.kind === 'action' ? signature.match(/^(?:server action|service action|client action|data action|action|preparation)\s+(\S+)/)?.[1]
        : signature.match(new RegExp(`^<${item.kind}\\b[^>]*\\bname\\s*=\\s*["']([^"']+)["']`))?.[1];
      if (target !== item.name) problem(`items/${i}/signature`, `signature must declare ${item.kind} ${item.name}`);
    }
    if (item.calls != null && (!Array.isArray(item.calls) || item.calls.some(x => typeof x !== 'string'))) problem(`items/${i}/calls`, 'calls is an array of names');
    else valid.push(item);
  }
  if (input.workers != null && (!Number.isInteger(input.workers) || input.workers < 1 || input.workers > 8)) problem('workers', 'workers is an integer from 1 to 8');
  const shared = Array.isArray(input.shared) ? input.shared : [];
  if (input.shared != null && !Array.isArray(input.shared)) problem('shared', 'shared is an array of absolute .ddl/.json file paths');
  for (const [i, file] of shared.entries()) if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.(ddl|json)$/i.test(file) || !fs.existsSync(file)) problem(`shared/${i}`, 'shared needs an existing absolute .ddl/.json file');
  if (input.ops != null && !Array.isArray(input.ops)) problem('ops', 'ops is an array');
  const place = placeOf(deps);
  const based = baseProblem({ lane, base: input.base }, deps);
  const capture = based ? null : (deps.newestCapture ?? newestCapture)({ lane, module, base: input.base }, deps);
  if (based) problem('base', based);
  else if (!capture) problems.push({ code: 'CAPTURE_MISSING', at: 'base', message: `No capture of ${module ?? 'the module'} is available`, fix: 'the main agent reads the module once; that capture serves every check' });
  // The capture as the session names it (deps.place shown).
  const shownCapture = capture ? { ...capture, path: place.shown(capture.path) } : null;
  const batches = batchItems(valid, { workers: Number.isInteger(input.workers) ? input.workers : undefined });
  const byBatch = new Map(batches.flatMap(batch => batch.items.map(item => [item.name, batch.id])));
  const needed = new Set();
  for (const batch of batches) for (const item of batch.items) for (const name of itemCalls(item, valid)) if (byBatch.has(name) && byBatch.get(name) !== batch.id) needed.add(name);
  for (const name of [...needed]) if (name.includes('.')) needed.add(name.slice(0, name.lastIndexOf('.')));
  for (const item of valid) if (needed.has(item.name) && !signatureOf(item.signature)) problems.push({ code: 'SIGNATURE_NEEDED', at: `items/${items.indexOf(item)}/signature`, item: item.name,
    message: item.kind === 'action' ? 'Provide the ssam-flow header and in/out lines for this cross-batch call' : 'Provide the opening screen/block tag and input/event/var elements for this cross-batch use' });
  const continuation = !capture ? (based ? call({ ...input, lane, action: 'plan', base: '<a capture of the module, or no base>' })
    : { tool: 'ssam_map', arguments: { lane, target: module }, why: 'the main agent reads the module once; that capture serves every check' }) : call({ ...input, lane, action: 'plan' });
  if (problems.length) return { ok: false, code: problems.some(p => p.code === 'INPUT_INVALID') ? 'INPUT_INVALID' : !capture ? 'CAPTURE_MISSING' : 'SIGNATURE_NEEDED', lane, module, action: 'plan', problems, ...(shownCapture ? { capture: shownCapture } : {}), continuation };
  const found = await (deps.moduleDigest ?? moduleDigest)({ lane, target: capture.path }, deps);
  if (found.ok === false || !found.digest) return { ok: false, lane, module, action: 'plan', code: 'DIGEST_UNAVAILABLE', problems: [{ code: 'DIGEST_UNAVAILABLE', message: found.error ?? 'Capture digest is unavailable' }], continuation: { tool: 'ssam_map', arguments: { lane, target: shownCapture.path, view: 'digest' } } };
  const planId = createHash('sha256').update(JSON.stringify(canonical({ PLAN_VERSION, lane, module, items, shared, ops: input.ops ?? [], workers: input.workers ?? null, capture: { sha256: capture.sha256 } }))).digest('hex').slice(0, 16);
  // The plans folder of the lane (deps.roots, or this checkout's).
  const roots = codeRoots(deps);
  const dir = path.join(lane === 'o11' ? roots.o11 : roots.odcWork, 'plans', planId);
  fs.mkdirSync(dir, { recursive: true });
  const planFile = path.join(dir, 'plan.json'), dataItems = valid.filter(item => item.kind === 'data'), dataFile = dataItems.length ? path.join(dir, 'data.ddl') : null;
  const baseFiles = [...(dataFile ? [dataFile] : []), ...shared];
  // A file a subagent writes (the data and every batch file) is named where it writes it; any other file as the session
  // passes it back (deps.place).
  const outputs = new Set(dataFile ? [dataFile] : []);
  const nameOf = file => (outputs.has(file) ? place.output(file) : place.shown(file));
  const artifacts = [], fullSections = {}, prompts = [];
  let briefing;
  try { briefing = await planBriefing(lane, [...new Set(valid.map(i => i.kind === 'action' ? 'logic' : i.kind === 'data' ? 'ddl' : 'html'))], deps); }
  catch { return { ok: false, code: 'DIGEST_UNAVAILABLE', error: 'The kernel contracts for the plan are unavailable.', continuation: { tool: 'ssam_discover', arguments: { lane, intent: 'read the contracts for this plan', app: module, packet: true } } }; }
  const makePrompt = (id, own, files, stubs = []) => {
    const intent = own.map(item => `${item.name} ${item.intent} ${item.signature ?? ''} ${(item.calls ?? []).join(' ')}`).join('\n');
    const check = call({ lane, action: 'check', module, base: shownCapture.path, files: [...(id === 'data' ? shared : baseFiles), ...files].map(nameOf), ...(stubs.length ? { stubs: stubs.map(place.shown) } : {}), ...(input.ops ? { ops: input.ops } : {}) });
    const parts = [...new Set(own.map(item => item.kind === 'action' ? 'logic' : item.kind === 'data' ? 'ddl' : 'html'))];
    const actionIndex = new Map(found.digest.actions.map(action => [action.key, action]));
    const context = moduleItems(found.digest, intent).items.filter(item => item.score >= 10 && !['bodies', 'screens'].includes(item.group))
      .map(item => item.group === 'actions' && actionIndex.has(item.key) ? indexLine(actionIndex.get(item.key)) : item.text).join('\n');
    const cards = parts.map(part => grammarCard(part, lane).card);
    const sections = [['work', `Write UTF-8 files: ${files.map(nameOf).join(', ')}. Keep EXACTLY these signatures.\n${own.map(item => `${item.kind} ${item.name}: ${item.intent}${item.calls?.length ? `\nCalls: ${item.calls.join(', ')}` : ''}\n${item.signature ? signatureOf(item.signature) : ''}`).join('\n\n')}`],
      ['check', JSON.stringify(check)], ['stubs', stubs.map(file => fs.readFileSync(file, 'utf8')).join('\n') || 'None.'],
      ['grammar', place.document('grammar', cards).map(card => JSON.stringify(card)).join('\n')],
      ['contract', JSON.stringify(place.document('contract', briefing.contract))],
      ['pitfalls', JSON.stringify(place.document('pitfalls', briefing.pitfalls))],
      ['module', context || 'No named existing elements.'], ['rules', JSON.stringify(place.document('rules', rulesSection({ intent, matches: [], categories: new Map(), textForms: parts }, 2000, { lane }).value))]];
    fullSections[id] = Object.fromEntries(sections);
    const prompt = promptOf(sections, `${place.input(planFile)} (sections.${id})`), promptFile = path.join(dir, `${id === 'data' ? 'data' : `batch-${id}`}.prompt.md`);
    fs.writeFileSync(promptFile, prompt.text);
    prompts.push(promptFile);
    artifacts.push({ id, sectionBytes: prompt.sectionBytes, cuts: prompt.cuts });
    return { files: files.map(nameOf), promptFile: place.input(promptFile), promptBytes: bytes(prompt.text), launchPrompt: launchPrompt(place.input(promptFile)), check };
  };
  const outputBatches = batches.map(batch => {
    const files = [...new Set(batch.items.map(item => item.kind === 'action' ? 'flow' : 'html'))].map(ext => path.join(dir, `batch-${batch.id}.${ext}`));
    for (const file of files) outputs.add(file);
    const names = new Set(batch.items.flatMap(item => itemCalls(item, valid)));
    for (const name of [...names]) if (name.includes('.')) names.add(name.slice(0, name.lastIndexOf('.')));
    const others = valid.filter(item => names.has(item.name) && byBatch.get(item.name) !== batch.id && item.kind !== 'data');
    const stubs = [];
    for (const ext of ['flow', 'html']) { const own = others.filter(item => (item.kind === 'action' ? 'flow' : 'html') === ext); if (!own.length) continue;
      const file = path.join(dir, `stubs-${batch.id}.${ext}`); fs.writeFileSync(file, own.map(stubOf).join('\n')); stubs.push(file); }
    return { id: batch.id, items: batch.items.map(item => item.name), estimateBytes: batch.estimateBytes, ...makePrompt(batch.id, batch.items, files, stubs) };
  });
  const data = dataFile ? { file: nameOf(dataFile), ...makePrompt('data', dataItems, [dataFile]) } : undefined;
  const result = { ok: true, lane, module, action: 'plan', planId, dir: place.shown(dir), capture: shownCapture, ...(data ? { data } : {}), batches: outputBatches,
    final: call({ lane, action: 'write', module, files: [...baseFiles.map(nameOf), ...outputBatches.flatMap(batch => batch.files)], ...(input.ops ? { ops: input.ops } : {}) }),
    launch: `${data ? 'Write data first; then l' : 'L'}aunch these ${batches.length} subagents now, in parallel (Claude Code: Agent tool; Codex: spawn_agent), each with its launchPrompt; when all answer, send final.` };
  const { ageSeconds, ...stableCapture } = shownCapture;
  fs.writeFileSync(planFile, JSON.stringify({ ...result, capture: stableCapture, sections: fullSections, measurements: artifacts }, null, 2) + '\n');
  // The plan file and the prompts reach the session where its subagents read them; a failure there is the plan's refusal.
  try { await place.publish([planFile, ...prompts]); }
  catch (error) {
    return { ok: false, lane, module, action: 'plan', planId, code: typeof error?.code === 'string' ? error.code : 'PLAN_NOT_DELIVERED', dir: place.shown(dir),
      error: 'The plan was written but its prompts could not reach the session: ' + String(error?.message ?? error), continuation: call({ ...input, lane, action: 'plan' }) };
  }
  return result;
}
