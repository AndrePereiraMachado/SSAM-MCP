// Comprehensive catalog (2026-09-23): the shared descriptor (discovery-capabilities-shared.json, schema shared/2) is
// composed with FRAGMENTS written by three fronts (A data/logic, B interface, C references/integrations/operations).
// A fragment is not another catalog: it holds shared/2 capabilities, lane-restricted ones (`lanes`), unavailable
// entries and the accounting of the inventory types its front owns. Composition happens once, here, and feeds the
// same index build (discovery.mjs), which then checks every pointer, proof and native type against the lane CLI,
// suites and runtime. The pure check below (catalog-check.mjs) runs without CLI, Studio or reader.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generatorApproval, offered, approvalIdentity } from './generators.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG_DIR = path.join(here, 'catalog');
export const FRAGMENTS_DIR = path.join(CATALOG_DIR, 'fragments');
export const OWNERSHIP_FILE = path.join(CATALOG_DIR, 'ownership.json');
export const FRAGMENT_SCHEMA = 'ssam-discovery-fragment/1';
export const CONTRACT_VERSION = 'ssam-catalog-contribution/1';
export const OWNERSHIP_SCHEMA = 'ssam-catalog-ownership/1';
export const FRONTS = ['A', 'B', 'C'];
export const LANES = ['odc', 'o11'];
export const OPERATIONS = ['read', 'usages', 'create', 'set', 'rename', 'replace', 'move', 'duplicate', 'delete'];
export const ROLE_STATUSES = ['applicable', 'conditional', 'not-applicable', 'undetermined'];
export const COVERAGE_STATUSES = ['represented', 'excluded', 'gap', 'undetermined'];
export const APPLICABILITY = ['applicable', 'conditional', 'not-applicable', 'undetermined'];
export const CLASSIFICATIONS = { 'concrete-authorable': 'concrete', 'base-interface': 'base', 'referenced-signature': 'signature', undetermined: 'undetermined', 'outside-object-root': 'outside-root' };
export const CLASSIFICATION_VALUES = ['concrete', 'base', 'signature', 'generated', 'undetermined', 'outside-root'];
const API_OPS = ['agent', 'verbs', 'spec', 'logic', 'screen', 'html', 'html-visual', 'rest', 'rest-consume', 'rest-expose', 'soap', 'entity-actions', 'css'];
// Fields a fragment capability may carry for the catalog only; they never reach the index or an answer.
const CATALOG_ONLY = ['requires', 'supersedes', 'generator', 'withoutGenerator'];
// A fragment entry (capability or unavailable) that offers a generator says so with "generator": "<id of
// generators.mjs GENERATOR_APPROVAL>". While that generator is not approved (offered(id) false), the composition answers as
// before the generator existed: the entry with its "withoutGenerator" fields (the text it had then) in place of the
// current ones, or, without them, no entry at all (a capability the generator brought). The states are part of the
// composition's identity, so an index built under other states is never reused.
function gatedEntry(entry, where, problems) {
  if (entry?.generator == null) return entry;
  if (!generatorApproval(entry.generator)) { problems.push(`${where}: ${entry.id} names an unknown generator '${entry.generator}' (generators.mjs GENERATOR_APPROVAL)`); return null; }
  if (entry.withoutGenerator != null && (typeof entry.withoutGenerator !== 'object' || Array.isArray(entry.withoutGenerator) || 'id' in entry.withoutGenerator)) {
    problems.push(`${where}: ${entry.id} withoutGenerator must be an object of fields (never the id)`); return null;
  }
  if (offered(entry.generator)) return entry;
  return entry.withoutGenerator ? { ...entry, ...entry.withoutGenerator } : null;
}

// ---- text: accent-insensitive tokens, tiny stemming, PT/EN stopwords. The matcher (discovery.mjs) reads intents and
// keywords with these; the contract check below uses the same functions, so the pure check (T0) refuses what the index
// build refuses.
export const STOP = new Set(('a o os as um uma uns umas de do da dos das e ou que com em no na nos nas por para pelo pela ao aos '
  + 'the a an of to for and or with in on at by from into is are be it this that as when then also '
  + 'criar crie criando create make add adicionar novo nova new quero preciso want need should must precisa deve '
  + 'ter tem have has usar use using uso').split(/\s+/));
export function normalize(text) { return String(text ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase(); }
const DERIVATIONAL = ['coes', 'cao', 'ções', 'ção', 'mente', 'ing', 'ed'];
// True when stem() cuts a derivational suffix (not a plural): "publicacao" -> "publica" is derived, "publica" is not.
export function derived(word) { return DERIVATIONAL.some(suffix => word.length > suffix.length + 3 && word.endsWith(suffix)); }
export function stem(word) {
  let w = word;
  for (const suffix of DERIVATIONAL) if (w.length > suffix.length + 3 && w.endsWith(suffix)) { w = w.slice(0, -suffix.length); break; }
  if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2); else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
  return w;
}
// The words of a text that survive tokenization (accents off, lower case, no stopword, no one-letter word), unstemmed.
export const words = text => normalize(text).split(/[^a-z0-9_]+/).filter(t => t.length > 1 && !STOP.has(t));
export function tokens(text) { return words(text).map(stem); }
// `fold` joins the spellings of one word the stemmer leaves apart ("references" -> "referenc" but "reference").
export const fold = w => { let f = w; for (const s of ['ing', 'ed']) if (f.length > s.length + 3 && f.endsWith(s)) { f = f.slice(0, -s.length); break; } return f.length > 3 && f.endsWith('e') ? f.slice(0, -1) : f; };
export const folded = phrase => phrase.split(' ').map(fold).join(' ');

// A keyword of a capability or of an unavailable entry (request A-006): a string, or an ANCHORED form
// `{form, with?, without?}` that counts only when the intent also says one of the `with` terms and none of the
// `without` terms (catalog/README.md §3.1). The same check runs in the pure check (checkCatalog) and in the index
// build (discovery.mjs validateDescriptor): shape, a form or term that keeps no word after tokenization, and entries
// that can never count (a `without` term the form itself says, a term in both lists).
export const ANCHOR_FIELDS = ['form', 'with', 'without'];
export function keywordProblems(k) {
  if (typeof k === 'string') return k.trim() ? [] : ['empty keyword'];
  if (!k || typeof k !== 'object' || Array.isArray(k)) return [`keyword ${JSON.stringify(k)} is neither a string nor an anchored form {form, with?, without?}`];
  const name = JSON.stringify(k.form ?? null); const problems = [];
  const extra = Object.keys(k).filter(x => !ANCHOR_FIELDS.includes(x));
  if (extra.length) problems.push(`anchored keyword ${name}: unknown field(s) ${extra.join(', ')} (fields: ${ANCHOR_FIELDS.join(', ')})`);
  const form = typeof k.form === 'string' ? tokens(k.form) : [];
  if (typeof k.form !== 'string' || !k.form.trim()) problems.push(`anchored keyword without a form: ${JSON.stringify(k)}`);
  else if (!form.length) problems.push(`anchored keyword ${name}: the form keeps no word after tokenization (stopwords or one-letter words only)`);
  // An absent side is left out; `null` is not a list (§3.1: both are non-empty lists when present).
  if (k.with === undefined && k.without === undefined) problems.push(`anchored keyword ${name} has neither with nor without (write it as a plain string)`);
  const said = { with: new Map(), without: new Map() };
  for (const side of ['with', 'without']) {
    if (k[side] === undefined) continue;
    if (!Array.isArray(k[side]) || !k[side].length) { problems.push(`anchored keyword ${name}: ${side} must be a non-empty list of terms`); continue; }
    for (const term of k[side]) {
      if (typeof term !== 'string' || !term.trim()) { problems.push(`anchored keyword ${name}: empty or non-string ${side} term ${JSON.stringify(term)}`); continue; }
      const t = tokens(term);
      if (!t.length) { problems.push(`anchored keyword ${name}: ${side} term ${JSON.stringify(term)} keeps no word after tokenization`); continue; }
      said[side].set(folded(t.join(' ')), term);
    }
  }
  // Entries that can never count: the form always says a `without` term made of its own words in order, and a term in
  // both lists cancels itself.
  const formPhrase = ` ${folded(form.join(' '))} `;
  for (const [phrase, term] of said.without) {
    if (form.length && formPhrase.includes(` ${phrase} `)) problems.push(`anchored keyword ${name}: without term ${JSON.stringify(term)} is said by the form itself, so the keyword never counts`);
    if (said.with.has(phrase)) problems.push(`anchored keyword ${name}: term ${JSON.stringify(term)} is in both with and without`);
  }
  return problems;
}
// Synonym variants are non-empty strings: a canonical stands for every capability and for the focus, so context of one
// capability goes in its own keywords (§3.1), never in a group.
export function synonymProblems(synonyms, at = 'synonyms') {
  const problems = [];
  for (const [canonical, variants] of Object.entries(synonyms ?? {})) {
    if (!Array.isArray(variants)) { problems.push(`${at}.${canonical} is not a list`); continue; }
    for (const v of variants) if (typeof v !== 'string' || !v.trim()) problems.push(`${at}.${canonical}: variant ${JSON.stringify(v)} is not a non-empty string (a form in context goes in a capability's keywords as an anchored keyword, catalog/README.md §3.1)`);
  }
  return problems;
}

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
// Text files reach each checkout with the line endings of its git configuration (autocrlf): the inventory identity
// is the hash of its text with LF line endings, so every checkout of the same commit agrees.
export const textSha256 = file => sha256(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const depId = d => (typeof d === 'string' ? d : d?.id);

// ---- fragments on disk: fragments/<front>/<name>.json, sorted, so the composition is deterministic.
export function listFragments(dir = FRAGMENTS_DIR) {
  const out = [];
  for (const front of FRONTS) {
    const frontDir = path.join(dir, front);
    let names = [];
    try { names = fs.readdirSync(frontDir).filter(n => n.toLowerCase().endsWith('.json')).sort(); } catch { continue; }
    for (const name of names) out.push({ front, name, file: path.join(frontDir, name) });
  }
  return out;
}
export function readFragments(dir = FRAGMENTS_DIR) {
  return listFragments(dir).map(f => {
    const bytes = fs.readFileSync(f.file);
    try { return { ...f, bytes, fragment: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) }; }
    catch (error) { return { ...f, bytes, fragment: null, parseError: error.message }; }
  });
}

// ---- composition: the shared descriptor plus every fragment, as ONE shared/2 document for the index build.
// Structural problems (unparseable file, wrong schema, duplicate id, a superseded id claimed twice) make the build
// refuse, exactly as a pointer that does not resolve does. `supersedes` removes a lane-own capability (or unavailable
// entry) of the lanes the fragment capability covers; a new id that supersedes an old one also answers for the old id
// in depends/alternatives/recommends (alias), so the other descriptors keep resolving.
export function composeCatalog({ shared, sharedBytes = Buffer.alloc(0), fragmentsDir = FRAGMENTS_DIR } = {}) {
  const fragments = readFragments(fragmentsDir);
  const problems = [];
  const composed = shared ? { ...shared, capabilities: [...(shared.capabilities ?? [])], synonyms: { ...(shared.synonyms ?? {}) }, unavailable: [...(shared.unavailable ?? [])] } : null;
  const ids = new Set((composed?.capabilities ?? []).map(c => c.id));
  const supersedes = new Map(); // old id -> { by, lanes, front }
  const hash = createHash('sha256').update(sharedBytes).update('\ngenerators ' + approvalIdentity());
  const manifest = [];
  for (const f of fragments) {
    hash.update('\n' + f.front + '/' + f.name + '\n').update(f.bytes);
    if (f.parseError) { problems.push(`fragment ${f.front}/${f.name}: not JSON (${f.parseError})`); continue; }
    const fr = f.fragment;
    if (fr.schemaVersion !== FRAGMENT_SCHEMA) { problems.push(`fragment ${f.front}/${f.name}: schemaVersion ${fr.schemaVersion}; expected ${FRAGMENT_SCHEMA}`); continue; }
    if (fr.front !== f.front) problems.push(`fragment ${f.front}/${f.name}: front '${fr.front}' differs from its directory '${f.front}'`);
    if (!composed) { problems.push(`fragment ${f.front}/${f.name}: no shared descriptor to compose with`); continue; }
    const lanesOf = c => c.lanes ?? composed.lanes ?? LANES;
    const composedIds = { capabilities: [], unavailable: [] };
    for (const entry of fr.capabilities ?? []) {
      if (!entry?.id) { problems.push(`fragment ${f.front}/${f.name}: capability without id`); continue; }
      const c = gatedEntry(entry, `fragment ${f.front}/${f.name}`, problems);
      if (!c) continue;
      // A capability of the shared descriptor itself (data.static, data.structure, data.entity) is taken over by the
      // fragment that supersedes it: the base entry leaves the composition, the fragment's version replaces it.
      for (const old of c.supersedes ?? []) {
        const at = composed.capabilities.findIndex(x => x.id === old && !x.origin);
        if (at >= 0) { composed.capabilities.splice(at, 1); ids.delete(old); }
      }
      if (ids.has(c.id)) { problems.push(`fragment ${f.front}/${f.name}: duplicate capability id ${c.id}`); continue; }
      ids.add(c.id);
      composedIds.capabilities.push(c.id);
      for (const old of c.supersedes ?? []) {
        if (supersedes.has(old)) problems.push(`fragment ${f.front}/${f.name}: ${c.id} supersedes ${old}, already superseded by ${supersedes.get(old).by}`);
        else supersedes.set(old, { by: c.id, lanes: lanesOf(c), front: f.front });
      }
      const clean = Object.fromEntries(Object.entries(c).filter(([k]) => !CATALOG_ONLY.includes(k)));
      composed.capabilities.push({ ...clean, origin: { front: f.front, fragment: f.name } });
    }
    for (const entry of fr.unavailable ?? []) {
      if (!entry?.id) { problems.push(`fragment ${f.front}/${f.name}: unavailable entry without id`); continue; }
      const u = gatedEntry(entry, `fragment ${f.front}/${f.name}`, problems);
      if (!u) continue;
      if (ids.has(u.id)) { problems.push(`fragment ${f.front}/${f.name}: duplicate id ${u.id} (unavailable)`); continue; }
      ids.add(u.id);
      composedIds.unavailable.push(u.id);
      for (const old of u.supersedes ?? []) {
        if (supersedes.has(old)) problems.push(`fragment ${f.front}/${f.name}: ${u.id} supersedes ${old}, already superseded by ${supersedes.get(old).by}`);
        else supersedes.set(old, { by: u.id, lanes: u.lanes ?? LANES, front: f.front });
      }
      const { supersedes: _s, generator: _g, withoutGenerator: _w, ...rest } = u;
      composed.unavailable.push({ ...rest, origin: { front: f.front, fragment: f.name } });
    }
    for (const p of synonymProblems(fr.synonyms, `fragment ${f.front}/${f.name}: synonyms`)) problems.push(p);
    for (const [canonical, variants] of Object.entries(fr.synonyms ?? {})) {
      const known = composed.synonyms[canonical];
      if (!Array.isArray(variants)) continue;
      composed.synonyms[canonical] = [...new Set([...(known ?? []), ...variants.filter(v => typeof v === 'string' && v.trim())])];
    }
    manifest.push({ front: f.front, file: f.name, sha256: sha256(f.bytes).slice(0, 16), capabilities: composedIds.capabilities, unavailable: composedIds.unavailable, coverage: (fr.coverage ?? []).length });
  }
  return { shared: composed, supersedes, fragments: manifest, problems, bytes: Buffer.from(hash.digest('hex')), raw: fragments };
}

// The lane descriptor after composition: superseded lane-own capabilities and unavailable entries leave the lanes the
// superseding entry covers; references to a superseded id are rewritten to the id that replaced it.
export function applySupersedes(descriptor, supersedes, lane) {
  const gone = new Map([...supersedes].filter(([, s]) => s.lanes.includes(lane)));
  if (!gone.size) return { descriptor, removed: [] };
  const removed = [];
  const keep = x => { if (gone.has(x.id)) { removed.push(x.id); return false; } return true; };
  const capabilities = rewriteAliases((descriptor.capabilities ?? []).filter(keep), supersedes, lane);
  const unavailable = (descriptor.unavailable ?? []).filter(keep);
  return { descriptor: { ...descriptor, capabilities, unavailable }, removed };
}
export function rewriteAliases(capabilities, supersedes, lane) {
  const gone = new Map([...supersedes].filter(([, s]) => s.lanes.includes(lane)));
  if (!gone.size) return capabilities;
  const alias = id => gone.get(id)?.by ?? id;
  return capabilities.map(c => ({ ...c,
    ...(c.depends ? { depends: c.depends.map(d => (typeof d === 'string' ? alias(d) : { ...d, id: alias(d.id) })) } : {}),
    ...(c.recommends ? { recommends: c.recommends.map(r => (typeof r === 'string' ? alias(r) : { ...r, id: alias(r.id) })) } : {}),
    ...(c.alternatives ? { alternatives: c.alternatives.map(a => ({ ...a, id: alias(a.id) })) } : {}) }));
}

// ---- ownership: every inventory type (per lane, by qualified name), every legacy capability/unavailable entry and
// every operational tool has exactly one owning front. Generated from the pinned inventory by the rules below and
// committed (catalog/ownership.json); a front accounts for its own types only.
const FAMILY_OWNER = {
  'data.entity': 'A', 'data.structure': 'A', 'data.type': 'A', 'logic.action': 'A', 'logic.exception': 'A', 'logic.node': 'A', 'logic.parameter': 'A', 'logic.query': 'A',
  'ui.block': 'B', 'ui.metadata': 'B', 'ui.screen': 'B', 'ui.widget': 'B',
  abstract: 'C', ai: 'C', 'integration.event': 'C', 'integration.plugin': 'C', 'integration.rest': 'C', 'integration.soap': 'C', 'integration.timer': 'C', module: 'C', other: 'C', process: 'C', 'reference.signature': 'C', 'security.config': 'C',
};
// Ordered overrides over the family label (the family is a regular expression over the short name, see
// coverage-inventory.mjs FAMILY_RULES); first match wins. Each states why.
export const OWNERSHIP_RULES = [
  { owner: 'C', test: t => /^OutSystems\.Model\.(BusinessProcesses|Processes)(\.|$)/.test(t.namespace), why: 'processes/BPT/workflows and their nodes (C); activity bodies reference A' },
  { owner: 'A', test: t => /^OutSystems\.Model\.Expressions(\.|$)/.test(t.namespace), why: 'expressions and literals belong to logic/data bodies (A)' },
  { owner: 'C', test: t => ['IGlobalEvent', 'ITriggerGlobalNode', 'IGlobalEventHandler'].includes(t.shortName), why: 'global (cross-app) events (C)' },
  { owner: 'C', test: t => ['ICallAgentCoreNode', 'ICallAgentNode', 'ICallAgentManifestNode', 'ISemanticSearchNode', 'ISearchServiceConnection', 'ISearchableAttribute', 'ISearchableAttributeSignature', 'IAIModelSetting', 'ISkillReference', 'IKnowledgeBaseReference', 'IToolReferenceAction'].includes(t.shortName) || /ToolReference$/.test(t.shortName), why: 'AI/agents, search, knowledge bases and tool references (C), classified by evidence' },
  { owner: 'C', test: t => ['IRestCallbackActionFlow', 'IRestServiceAuthenticationFlow', 'IRestServiceCallbackActionFlow', 'ISOAPCallbackActionFlow', 'ISapCallbackActionFlow'].includes(t.shortName), why: 'integration callback flows (C)' },
  { owner: 'C', test: t => ['ISystemRole', 'IIntegrationReferenceAction', 'ICallback'].includes(t.shortName), why: 'roles, integration references and callbacks (C)' },
  { owner: 'B', test: t => ['IUIFlow', 'IUIFlowConnector', 'IUIFlowNode', 'IMobileFlow', 'IMobileFlowConnector', 'IMobileFlowNode', 'IWebFlow', 'IWebFlowConnector', 'IWebFlowNode'].includes(t.shortName), why: 'UI flows (B)' },
  { owner: 'B', test: t => ['ITriggerNode', 'IEventHandler', 'IBlockEvent', 'IUILifeCycleEvent', 'IEvent', 'IBuiltinEvent', 'IExternalSite', 'ISystemEvent', 'IOnSyncSystemEvent'].includes(t.shortName), why: 'UI/app events, lifecycle, block events and their triggers/handlers (B)' },
  { owner: 'A', test: t => ['IScreenAggregate', 'IPreparation', 'ISQLInputParameter', 'ISwitchCondition', 'IListTypeSignature', 'IOutputFormat', 'IOutputFormatAttribute', 'IClientVariable', 'ISessionVariable'].includes(t.shortName), why: 'queries, preparations, SQL/switch parts, list types and variables (A); B binds them' },
  { owner: 'B', test: t => ['IThemeValues', 'IThemeValuesSignature'].includes(t.shortName), why: 'theme values (B)' },
];
function ownerOfConcrete(t) {
  for (const rule of OWNERSHIP_RULES) if (rule.test(t)) return { owner: rule.owner, rule: rule.why };
  const owner = FAMILY_OWNER[t.family];
  return owner ? { owner, rule: `family ${t.family}` } : { owner: 'C', rule: `unmapped family ${t.family}: remnants (C)` };
}
// Signatures whose signed element has no inventoried interface of the same short name, assigned by their domain.
const SIGNATURE_DOMAIN = { IStaticRecordAttributeValueSignature: { owner: 'A', why: 'value of a static entity record (data, A)' } };
export function ownerOfType(t, laneTypes) {
  if (SIGNATURE_DOMAIN[t.shortName]) return { owner: SIGNATURE_DOMAIN[t.shortName].owner, rule: `referenced signature: ${SIGNATURE_DOMAIN[t.shortName].why}` };
  if (t.family === 'reference.signature') {
    // A referenced signature follows the domain of the element it signs (IServerEntitySignature -> IServerEntity);
    // import/refresh mechanics stay with C. No unique domain -> C.
    const base = t.shortName.replace(/Signature$/, '');
    const owners = new Set(laneTypes.filter(o => o.shortName === base && o.family !== 'reference.signature').map(o => ownerOfConcrete(o).owner));
    if (owners.size === 1) { const [owner] = owners; return { owner, rule: `referenced signature of ${base} (domain owner); import/refresh mechanics are C` }; }
    return { owner: 'C', rule: owners.size ? `referenced signature of ${base}: owners disagree (${[...owners].join('/')}), C` : `referenced signature without an inventoried element ${base}: C` };
  }
  return ownerOfConcrete(t);
}
// Interfaces outside the object roots (inventory typesOutsideRoot, request C-007): expression nodes, bindings and the
// generic sequence/model-object mechanics go with the logic/refactor domain (A), UI helpers with B, and applications,
// referenced modules, extensions, external libraries, merge, model plugins, metamodel and the rest with C.
export function ownerOfOutsideRoot(t) {
  const ns = t.namespace ?? ''; const short = t.shortName ?? '';
  const ai = OWNERSHIP_RULES.find(r => r.why.startsWith('AI/agents'));
  if (/^OutSystems\.Model\.Expressions(\.|$)/.test(ns)) return { owner: 'A', rule: 'outside the object roots: expression nodes, bindings and literals (A)' };
  if (['IModelObject', 'ISequence'].includes(short.replace(/<.*$/, ''))) return { owner: 'A', rule: 'outside the object roots: generic model-object and sequence mechanics behind delete/move (A, refactor verbs)' };
  if (/^OutSystems\.Model\.Logic(\.|$)/.test(ns) && !ai.test(t)) return { owner: 'A', rule: 'outside the object roots: logic helpers (A)' };
  if (/^OutSystems\.Model\.UI(\.|$)/.test(ns)) return { owner: 'B', rule: 'outside the object roots: UI helpers (B)' };
  return { owner: 'C', rule: 'outside the object roots: applications/modules, extensions, external libraries, merge, model plugins, metamodel and remnants (C)' };
}
export const LEGACY_OWNER = {
  capabilities: { 'data.client-entity': 'A', 'data.records': 'C', 'data.setting': 'C', 'logic.rest-consume': 'C', 'logic.rest-expose': 'C', 'logic.timer': 'C', 'logic.app-event': 'B', 'read.inspect': 'C', 'data.static': 'A', 'data.structure': 'A', 'data.entity': 'A' },
  byPrefix: [['data.', 'A'], ['logic.', 'A'], ['refactor.', 'A'], ['ui.', 'B'], ['deliver.', 'C'], ['read.', 'C']],
  unavailable: { 'session-variable': 'A', 'data-action-inputs': 'A', 'module-image': 'B', 'button-group-native': 'B', 'bpt-process': 'C', 'rest-credentials-in-model': 'C', 'reference-import-headless': 'C', agents: 'C' },
};
export const ID_PREFIXES = { A: ['data.', 'logic.', 'refactor.'], B: ['ui.'], C: ['integration.', 'reference.', 'module.', 'process.', 'security.', 'event.', 'timer.', 'ai.', 'deliver.', 'read.', 'ops.', 'diagnostic.'] };
export function legacyOwner(id) {
  if (LEGACY_OWNER.capabilities[id]) return LEGACY_OWNER.capabilities[id];
  if (LEGACY_OWNER.unavailable[id]) return LEGACY_OWNER.unavailable[id];
  return LEGACY_OWNER.byPrefix.find(([p]) => id.startsWith(p))?.[1] ?? null;
}
export const typeKey = (lane, qualified) => `${lane}:${qualified}`;

export function buildOwnership({ inventoryFile, inventory, descriptors, shared, note = null, reconciliation = null }) {
  const types = {}; const counts = {};
  for (const lane of LANES) {
    const laneTypes = inventory.types?.[lane] ?? [];
    for (const t of laneTypes) {
      const { owner, rule } = ownerOfType(t, laneTypes);
      types[typeKey(lane, t.name)] = { owner, family: t.family, kindClass: t.kindClass, appFamily: t.appFamily, rule };
      const k = `${lane}:${owner}`; counts[k] ??= { types: 0, 'concrete-authorable': 0, 'base-interface': 0, 'referenced-signature': 0, undetermined: 0 };
      counts[k].types++; counts[k][t.kindClass] = (counts[k][t.kindClass] ?? 0) + 1;
    }
    for (const t of inventory.typesOutsideRoot?.[lane] ?? []) {
      const { owner, rule } = ownerOfOutsideRoot(t);
      types[typeKey(lane, t.name)] = { owner, family: null, kindClass: 'outside-object-root', appFamily: null, rule };
      const k = `${lane}:${owner}`; counts[k] ??= { types: 0 };
      counts[k]['outside-object-root'] = (counts[k]['outside-object-root'] ?? 0) + 1;
    }
  }
  const tools = Object.fromEntries((inventory.sources?.operationalBoundary?.tools ?? inventory.sources?.operationalBoundary ?? []).filter(x => x && (x.tool || x.name)).map(x => [`tool:${x.tool ?? x.name}`, { owner: 'C', class: x.class ?? null, file: x.file ?? null }]));
  const legacy = { capabilities: {}, unavailable: {} };
  for (const [lane, d] of Object.entries(descriptors)) {
    for (const c of d.capabilities ?? []) legacy.capabilities[c.id] = { owner: legacyOwner(c.id), lane, category: c.category };
    for (const u of d.unavailable ?? []) legacy.unavailable[u.id] = { owner: legacyOwner(u.id), lane };
  }
  for (const c of shared?.capabilities ?? []) legacy.capabilities[c.id] = { owner: legacyOwner(c.id), lane: 'shared', category: c.category };
  return {
    schemaVersion: OWNERSHIP_SCHEMA, contract: CONTRACT_VERSION,
    inventory: { file: inventoryFile, sha256: textSha256(inventoryFile), sha256Rule: 'sha256 of the text with LF line endings', generatedAt: inventory.generatedAt ?? null, identityRule: inventory.identityRule ?? null,
      versions: { odc: inventory.sources?.nativeOdc?.version ?? null, o11: inventory.sources?.nativeO11?.version ?? null },
      note: note ?? 'Pinned inventory; keys are version-free (lane:namespace.name) so accounting survives a runtime update.', ...(reconciliation ? { reconciliation } : {}) },
    keyRule: 'type key = <lane>:<namespace>.<Name> (unique per lane in the inventory); tools = tool:<name>',
    rules: { families: FAMILY_OWNER, overrides: OWNERSHIP_RULES.map(r => ({ owner: r.owner, why: r.why })), signatures: 'reference.signature types follow the owner of the element they sign (same short name without Signature); otherwise C', signatureDomain: SIGNATURE_DOMAIN, legacy: LEGACY_OWNER },
    idPrefixes: ID_PREFIXES, counts, types, tools, legacy,
  };
}

// ---- pure check (T0): the composed catalog as a whole, without CLI, Studio or reader. Contract pointers, proof jobs
// and native types are checked against the latest index this checkout built (when there is one) and the job files;
// the authoritative check against the real contracts is the index build (ssam discover --rebuild), which refuses.
export function checkCatalog({ root, facadeDir = here, fragmentsDir = FRAGMENTS_DIR, ownershipFile = OWNERSHIP_FILE, front = null } = {}) {
  const errors = []; const warnings = []; const info = [];
  const err = (who, text) => errors.push({ front: who, text }); const warn = (who, text) => warnings.push({ front: who, text });
  const sharedFile = path.join(facadeDir, 'discovery-capabilities-shared.json');
  const sharedBytes = fs.readFileSync(sharedFile); const shared = JSON.parse(sharedBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const descriptors = { odc: readJson(path.join(facadeDir, 'discovery-capabilities.json')), o11: readJson(path.join(facadeDir, 'discovery-capabilities-o11.json')) };
  let ownership = null;
  try { ownership = readJson(ownershipFile); } catch (e) { err('integrator', `ownership file unreadable: ${ownershipFile} (${e.message})`); }
  const inventoryFile = ownership?.inventory?.file ? path.resolve(root, ownership.inventory.file) : null;
  if (ownership && inventoryFile && fs.existsSync(inventoryFile) && textSha256(inventoryFile) !== ownership.inventory.sha256) err('integrator', `pinned inventory changed: ${ownership.inventory.file} no longer has sha256 ${ownership.inventory.sha256.slice(0, 16)}; regenerate ownership (integrator)`);
  const { shared: composed, supersedes, fragments, problems, raw } = composeCatalog({ shared, sharedBytes, fragmentsDir });
  for (const p of problems) err(/^fragment (\w)\//.exec(p)?.[1] ?? 'integrator', p);
  // Latest built index per lane, for pointers, jobs and native runtime; absent -> said, not guessed.
  const kernel = path.join(root, 'kernel');
  const jobDirs = { odc: { proofs: path.join(kernel, 'tests', 'jobs-odc'), negative: path.join(kernel, 'tests', 'jobs-odc-negative') }, o11: { proofs: path.join(kernel, 'tests', 'jobs'), negative: path.join(kernel, 'tests', 'jobs-negative') } };
  // A negative is a REFUSAL job: the index (discovery loadNegatives) reads only jobs of the lane's negative directory
  // that declare expectError, because only they carry the refusal text. O11 also keeps there jobs whose negative
  // expectation lives in a C# test (expectValid false, or asserted by CurrentHintTests/MessageExpectationTests):
  // those are cited as a limit with origin, never as `negative`.
  const refusalJobs = new Map();
  // A proven example is cited as examples/<job> (proof or, when it declares expectError, negative): it lives in the
  // examples folder of the lane suite, the name discovery loadJobs/loadNegatives gives it.
  const jobExists = (lane, kind, name) => {
    const file = path.join(String(name).startsWith('examples/') ? jobDirs[lane].proofs : jobDirs[lane][kind], name + '.json');
    if (!fs.existsSync(file)) return false;
    if (kind !== 'negative') return true;
    const key = lane + '/' + name;
    if (!refusalJobs.has(key)) { try { refusalJobs.set(key, readJson(file).expectError != null); } catch { refusalJobs.set(key, false); } }
    return refusalJobs.get(key);
  };
  const indexes = {};
  for (const lane of LANES) {
    const dir = path.join(facadeDir, '..', '.local', 'discovery', lane);
    try { const latest = fs.readdirSync(dir).filter(n => /^index-.*\.json$/.test(n)).map(n => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t)[0]; if (latest) { const ix = readJson(path.join(dir, latest.n)); indexes[lane] = { file: path.join(dir, latest.n), builtAt: ix.builtAt, contracts: ix.contracts, native: ix.nativeRuntime ?? {} }; } } catch { /* no index yet */ }
  }
  const pointerResolves = (contracts, pointer) => { const [op, ...rest] = pointer.split('.'); let node = contracts?.[op]; if (!node || node.error) return false; for (const key of rest) { if (node == null || typeof node !== 'object') return false; node = Array.isArray(node) ? node.find(x => x === key) : node[key]; } return node !== undefined; };
  // All ids that exist for each lane after composition (lane-own minus superseded, plus composed shared for the lane).
  const idsFor = lane => {
    const own = (descriptors[lane].capabilities ?? []).map(c => c.id).filter(id => !(supersedes.get(id)?.lanes ?? []).includes(lane));
    const sh = (composed.capabilities ?? []).filter(c => (c.lanes ?? composed.lanes ?? LANES).includes(lane)).map(c => c.id);
    return new Set([...own, ...sh]);
  };
  // References resolve per lane, as the index build does (validateDescriptor runs once per lane, after superseded ids
  // were rewritten to the id that replaced them): an id present only on ODC cannot be a dependency of a capability
  // that also covers O11 (request C-006).
  const laneIds = Object.fromEntries(LANES.map(l => [l, idsFor(l)]));
  const allIds = new Set([...laneIds.odc, ...laneIds.o11]);
  const aliasOn = (id, lane) => { const s = supersedes.get(id); return s && s.lanes.includes(lane) ? s.by : id; };
  const missingOn = (id, lanes) => lanes.filter(l => !laneIds[l]?.has(aliasOn(id, l)));
  const legacyIds = new Map();
  for (const lane of LANES) { for (const c of descriptors[lane].capabilities ?? []) legacyIds.set(c.id, lane); for (const u of descriptors[lane].unavailable ?? []) legacyIds.set(u.id, lane); }
  for (const c of shared.capabilities ?? []) legacyIds.set(c.id, 'shared');
  // The synonym groups of each lane as the build merges them (the lane's own and the composed ones, same key = union),
  // by the tokens of the canonical: an anchor term that is a canonical is said by every variant of its group on that
  // lane (§3.1), so the check lists them for the front (info).
  const laneGroups = Object.fromEntries(LANES.map(l => {
    const own = descriptors[l].synonyms ?? {}; const sh = composed?.synonyms ?? {}; const groups = new Map();
    for (const key of new Set([...Object.keys(sh), ...Object.keys(own)])) { const t = folded(tokens(key).join(' ')); if (!t) continue; groups.set(t, new Set([...(groups.get(t) ?? []), ...(own[key] ?? []), ...(sh[key] ?? [])].filter(v => typeof v === 'string'))); }
    return [l, groups];
  }));
  // One note per capability (or unavailable entry), side and term, naming the anchored forms that use it.
  const anchorNotes = new Map();
  const anchorInfo = (who, where, k, lanes) => {
    if (!k || typeof k !== 'object' || Array.isArray(k)) return;
    for (const side of ['with', 'without']) for (const term of Array.isArray(k[side]) ? k[side] : []) {
      if (typeof term !== 'string') continue;
      const t = folded(tokens(term).join(' '));
      const per = lanes.filter(l => laneGroups[l]?.has(t)).map(l => { const v = [...laneGroups[l].get(t)]; return `${l}: ${v.slice(0, 8).join(', ')}${v.length > 8 ? `, ... (${v.length})` : ''}`; });
      if (!per.length) continue;
      const key = [who, where, side, t].join('|');
      if (!anchorNotes.has(key)) anchorNotes.set(key, { who, where, side, term, forms: new Set(), per });
      anchorNotes.get(key).forms.add(JSON.stringify(k.form));
    }
  };
  const types = ownership?.types ?? {}; const tools = ownership?.tools ?? {};
  const represented = new Map(); // typeKey -> [{capability, role, front}]
  const classified = new Map(); // typeKey -> {status, front}
  const pending = [];
  for (const f of raw) {
    if (f.parseError || !f.fragment || f.fragment.schemaVersion !== FRAGMENT_SCHEMA) continue;
    const fr = f.fragment; const who = f.front; const at = `${who}/${f.name}`;
    for (const field of ['title', 'reviewedAt']) if (!fr[field]) warn(who, `${at}: missing ${field}`);
    if (fr.contract && fr.contract !== CONTRACT_VERSION) err(who, `${at}: contract ${fr.contract}; expected ${CONTRACT_VERSION}`);
    for (const c of fr.capabilities ?? []) {
      const where = `${at} ${c.id}`;
      const prefixes = ownership?.idPrefixes?.[who] ?? ID_PREFIXES[who] ?? [];
      const reusesOwnLegacy = (c.supersedes ?? []).includes(c.id) && legacyOwner(c.id) === who;
      if (!reusesOwnLegacy && !prefixes.some(p => c.id.startsWith(p))) err(who, `${where}: id must start with ${prefixes.join('|')} (or be a legacy id of this front listed in its own supersedes)`);
      for (const field of ['category', 'title', 'keywords', 'summary', 'route']) if (c[field] == null) err(who, `${where}: missing ${field}`);
      if (c.keywords && (!Array.isArray(c.keywords) || !c.keywords.length)) err(who, `${where}: keywords must be a non-empty list`);
      for (const k of Array.isArray(c.keywords) ? c.keywords : []) for (const p of keywordProblems(k)) err(who, `${where}: ${p}`);
      if (c.route && !c.route.kind) err(who, `${where}: route.kind is required`);
      const lanes = c.lanes ?? composed.lanes ?? LANES;
      for (const l of lanes) if (!LANES.includes(l)) err(who, `${where}: unknown lane ${l}`);
      for (const k of Array.isArray(c.keywords) ? c.keywords : []) anchorInfo(who, where, k, lanes);
      for (const pointer of c.contract ?? []) {
        const op = pointer.split('.')[0];
        if (!API_OPS.includes(op)) { err(who, `${where}: contract pointer ${pointer} does not start with an api --op (${API_OPS.join('|')})`); continue; }
        for (const l of lanes) if (indexes[l] && !pointerResolves(indexes[l].contracts, pointer)) err(who, `${where}: contract pointer ${pointer} does not resolve in the ${l} index built ${indexes[l].builtAt}`);
      }
      for (const old of c.supersedes ?? []) {
        if (!legacyIds.has(old)) err(who, `${where}: supersedes ${old}, which is not a lane-own capability or unavailable entry`);
        else { const owner = legacyOwner(old); const was = legacyIds.get(old); if (owner !== who) err(who, `${where}: supersedes ${old}, owned by front ${owner}`);
          if (was === 'shared') { const base = (shared.capabilities ?? []).find(x => x.id === old); for (const l of base.lanes ?? shared.lanes ?? LANES) if (!lanes.includes(l)) err(who, `${where}: supersedes the shared ${old} but drops lane ${l}`); }
          else if (!lanes.includes(was)) err(who, `${where}: supersedes ${old} of lane ${was} but does not cover that lane`); }
      }
      const roles = new Set();
      for (const e of c.elements ?? []) {
        if (!e.role) { err(who, `${where}: element without role`); continue; }
        if (roles.has(e.role)) err(who, `${where}: duplicate role ${e.role}`); roles.add(e.role);
        for (const l of lanes) {
          const p = e.platforms?.[l];
          if (!p) { warn(who, `${where}: role '${e.role}' has no platforms.${l} (its operations on ${l} are undetermined)`); continue; }
          if (!p.native) { if (e.runtime !== 'kernel') warn(who, `${where}: role '${e.role}' on ${l} without native type`); continue; }
          const key = typeKey(l, p.native);
          if (!types[key]) { if (e.runtime !== 'kernel') warn(who, `${where}: native ${p.native} (${l}) is not in the pinned inventory (new in the runtime, synthesized, or misspelt): the index build checks it against the runtime`); }
          else if (types[key].owner !== who) warn(who, `${where}: role '${e.role}' uses ${key}, owned by front ${types[key].owner}: coordinate (its accounting stays with the owner)`);
          if (indexes[l]?.native?.[p.native]?.found === false) err(who, `${where}: native ${p.native} not found in the ${l} runtime (index ${indexes[l].builtAt})`);
          for (const k of ['jobType', 'address']) if (!p[k]) warn(who, `${where}: role '${e.role}' on ${l} without ${k}`);
        }
      }
      if (c.operations && !c.elements?.length) err(who, `${where}: operations without elements (operations are stated per element role)`);
      for (const [op, def] of Object.entries(c.operations ?? {})) {
        if (!OPERATIONS.includes(op)) { const verbsEverywhere = Object.values(def.roles ?? {}).every(byLane => Object.values(byLane ?? {}).every(r => Array.isArray(r?.verbs) && r.verbs.length)); if (!verbsEverywhere) err(who, `${where}: operation ${op} is not one of ${OPERATIONS.join('|')} and some role statement lacks verbs`); }
        if (!def.route) warn(who, `${where}: operation ${op} without route`);
        if (!def.roles || typeof def.roles !== 'object') { err(who, `${where}: operation ${op} has no roles`); continue; }
        for (const [role, byLane] of Object.entries(def.roles)) {
          if (!roles.has(role)) err(who, `${where}: operation ${op} role '${role}' is not a declared element role`);
          for (const [l, r] of Object.entries(byLane ?? {})) {
            const s = `${where}: ${op}/${role}/${l}`;
            if (!lanes.includes(l)) { err(who, `${s}: lane not covered by the capability`); continue; }
            if (!ROLE_STATUSES.includes(r.status)) err(who, `${s}: unknown status ${r.status}`);
            for (const j of r.proofs ?? []) if (!jobExists(l, 'proofs', j)) err(who, `${s}: proof job not found: ${j} (${path.relative(root, jobDirs[l].proofs)})`);
            for (const j of r.negative ?? []) if (!jobExists(l, 'negative', j)) err(who, `${s}: negative job not found or not a refusal job (a negative needs expectError; cite other negative jobs as a limit with origin): ${j} (${path.relative(root, jobDirs[l].negative)})`);
            if (r.status === 'applicable' && !(r.proofs ?? []).length) err(who, `${s}: applicable without a proof job (use undetermined, or observed with integrity not-verified)`);
            if (r.status === 'conditional' && !(r.proofs ?? []).length && !(r.negative ?? []).length) err(who, `${s}: conditional without a proof or negative job`);
            if (r.status === 'not-applicable' && !(r.negative ?? []).length && !r.note) err(who, `${s}: not-applicable without a negative job or a note`);
            if (r.status === 'undetermined' && (r.proofs ?? []).length) err(who, `${s}: undetermined but lists proofs`);
            if (r.observed != null) { const o = r.observed; if (!o?.behaviour) err(who, `${s}: observed without behaviour`); if (o?.integrity !== 'not-verified') err(who, `${s}: observed must carry integrity: not-verified`); if (!Array.isArray(o?.missing) || !o.missing.length) err(who, `${s}: observed without missing`); if (!(o?.proofs ?? []).length) err(who, `${s}: observed without the job that ran it`); for (const j of o?.proofs ?? []) if (!jobExists(l, 'proofs', j)) err(who, `${s}: observed job not found: ${j}`); }
          }
        }
      }
      for (const l of lanes) {
        for (const j of c.platforms?.[l]?.proofs ?? []) if (!jobExists(l, 'proofs', j)) err(who, `${where}: platforms.${l}.proofs job not found: ${j}`);
        for (const j of c.platforms?.[l]?.negative ?? []) if (!jobExists(l, 'negative', j)) err(who, `${where}: platforms.${l}.negative job not found or not a refusal job (a negative needs expectError; cite other negative jobs as a limit with origin): ${j}`);
        for (const lim of c.platforms?.[l]?.limits ?? []) if (typeof lim !== 'object' || !lim.text || !lim.origin) err(who, `${where}: platforms.${l}.limits entries need text and origin`);
      }
      // An entry may carry `lanes` (request B-001): it is checked, and projected, only on those lanes of the capability.
      const onLanes = (entry, id, kind) => {
        const own = entry && typeof entry === 'object' && Array.isArray(entry.lanes) ? entry.lanes : null;
        if (own) for (const l of own) if (!lanes.includes(l)) err(who, `${where}: ${kind} ${id} names lane ${l}, which the capability does not cover`);
        const missing = missingOn(id, own ? lanes.filter(l => own.includes(l)) : lanes);
        if (missing.length) err(who, `${where}: unknown ${kind} ${id} on ${missing.join('/')}` + (kind === 'dependency' ? ' (a pending cross-front need goes in requires, not depends; a need of one lane only takes lanes: [...] on the entry)' : ''));
      };
      for (const d of c.depends ?? []) { onLanes(d, depId(d), 'dependency'); if (typeof d === 'object' && d.unless != null && typeof d.unless !== 'string') err(who, `${where}: malformed dependency ${JSON.stringify(d)}`); }
      for (const r of c.recommends ?? []) onLanes(r, depId(r), 'recommendation');
      for (const a of c.alternatives ?? []) onLanes(a, a.id, 'alternative');
      for (const r of c.requires ?? []) {
        if (!r?.id || !r?.provider || !r?.why) { err(who, `${where}: requires entries need id, provider and why`); continue; }
        if (![...FRONTS, 'integrator'].includes(r.provider)) err(who, `${where}: requires provider ${r.provider} is not A|B|C|integrator`);
        const missing = missingOn(r.id, lanes);
        if (!missing.length) info.push({ front: who, text: `${where}: required ${r.id} (from ${r.provider}) now exists on ${lanes.join('/')}: move it into depends/recommends` });
        else pending.push({ front: who, capability: c.id, id: r.id, provider: r.provider, why: r.why, missingOn: missing });
      }
    }
    for (const u of fr.unavailable ?? []) {
      const where = `${at} unavailable ${u.id}`;
      if (!u.keywords?.length || !u.reason) err(who, `${where}: needs keywords and reason`);
      for (const k of Array.isArray(u.keywords) ? u.keywords : []) { for (const p of keywordProblems(k)) err(who, `${where}: ${p}`); anchorInfo(who, where, k, (u.lanes ?? LANES).filter(l => LANES.includes(l))); }
      if (!u.evidence && !(Object.values(u.negative ?? {}).flat().length)) warn(who, `${where}: no evidence or negative job (state the origin of the refusal)`);
      for (const [l, list] of Object.entries(u.negative ?? {})) for (const j of list) if (!LANES.includes(l) || !jobExists(l, 'negative', j)) err(who, `${where}: negative job not found or not a refusal job (a negative needs expectError; cite other negative jobs as a limit with origin): ${l}/${j}`);
      for (const old of u.supersedes ?? []) { if (!legacyIds.has(old)) err(who, `${where}: supersedes unknown ${old}`); else if (legacyOwner(old) !== who) err(who, `${where}: supersedes ${old}, owned by front ${legacyOwner(old)}`); }
    }
    const seen = new Set();
    for (const e of fr.coverage ?? []) {
      const key = e?.type; const where = `${at} coverage ${key}`;
      if (!key) { err(who, `${at}: coverage entry without type`); continue; }
      if (seen.has(key)) err(who, `${where}: duplicate entry`); seen.add(key);
      const owned = types[key] ?? tools[key];
      if (!owned) { err(who, `${where}: not in the pinned inventory/tools (key = <lane>:<namespace>.<Name> or tool:<name>)`); continue; }
      if (owned.owner !== who) err(who, `${where}: owned by front ${owned.owner}`);
      if (!COVERAGE_STATUSES.includes(e.status)) err(who, `${where}: status must be ${COVERAGE_STATUSES.join('|')}`);
      if (!APPLICABILITY.includes(e.applicability)) err(who, `${where}: applicability must be ${APPLICABILITY.join('|')}`);
      if (e.classification && !CLASSIFICATION_VALUES.includes(e.classification)) err(who, `${where}: classification must be ${CLASSIFICATION_VALUES.join('|')}`);
      if (e.classification && types[key] && CLASSIFICATIONS[types[key].kindClass] !== e.classification && !e.origin) err(who, `${where}: classification differs from the inventory (${types[key].kindClass}) without origin`);
      if (['excluded', 'gap', 'undetermined'].includes(e.status) && !e.reason) err(who, `${where}: ${e.status} needs reason`);
      if (['excluded', 'gap'].includes(e.status) && !e.origin) err(who, `${where}: ${e.status} needs origin (job, file:line, api --op pointer, doc or inventory rule)`);
      // A model type is represented by a role of a capability; an operational tool (tool:<name>) has no model role and is
      // represented by the capability that carries its contract (request C-005).
      if (e.status === 'represented') {
        if (key.startsWith('tool:')) { if (!e.capability) err(who, `${where}: represented needs the capability that carries the tool contract`); else if (!allIds.has(e.capability)) err(who, `${where}: capability ${e.capability} does not exist`); }
        else if (!e.capability || !e.role) err(who, `${where}: represented needs capability and role`);
        else if (!(composed.capabilities ?? []).some(c => c.id === e.capability && (c.elements ?? []).some(x => x.role === e.role))) err(who, `${where}: capability ${e.capability} has no role '${e.role}'`);
      }
      for (const [op, s] of Object.entries(e.operations ?? {})) { if (!OPERATIONS.includes(op)) err(who, `${where}: unknown operation ${op}`); if (!ROLE_STATUSES.includes(s?.status)) err(who, `${where}: operations.${op}.status must be ${ROLE_STATUSES.join('|')}`); }
      classified.set(key, { status: e.status, front: who });
    }
  }
  for (const n of anchorNotes.values()) info.push({ front: n.who, text: `${n.where}: anchored keyword${n.forms.size > 1 ? 's' : ''} ${[...n.forms].join(', ')}: ${n.side} term ${JSON.stringify(n.term)} is a synonym canonical, said by every variant of its group (${n.per.join('; ')})` });
  // Dependency cycles, per lane, over the composed graph (lane-own after supersedes, plus the composed shared ones).
  for (const lane of LANES) {
    const own = applySupersedes(descriptors[lane], supersedes, lane).descriptor.capabilities ?? [];
    const sh = rewriteAliases((composed?.capabilities ?? []).filter(c => (c.lanes ?? composed.lanes ?? LANES).includes(lane)), supersedes, lane);
    const graph = new Map([...own, ...sh].map(c => [c.id, (c.depends ?? []).filter(d => !(d && typeof d === 'object' && Array.isArray(d.lanes)) || d.lanes.includes(lane)).map(depId)]));
    const state = new Map(); const cycles = [];
    const visit = (id, trail) => { state.set(id, 1); for (const d of graph.get(id) ?? []) { if (state.get(d) === 1) cycles.push([...trail.slice(trail.indexOf(d)), d].join(' > ')); else if (!state.has(d) && graph.has(d)) visit(d, [...trail, d]); } state.set(id, 2); };
    for (const id of [...graph.keys()].sort()) if (!state.has(id)) visit(id, [id]);
    for (const cycle of cycles) { const owners = new Set(cycle.split(' > ').map(id => (composed?.capabilities ?? []).find(c => c.id === id)?.origin?.front).filter(Boolean)); for (const who of owners.size ? owners : ['integrator']) err(who, `dependency cycle on ${lane}: ${cycle}`); }
  }
  // Every composed capability (the shared descriptor's and the fragments') represents the native type of each of its
  // roles on each lane it covers.
  for (const c of composed?.capabilities ?? []) for (const l of c.lanes ?? composed.lanes ?? LANES) for (const e of c.elements ?? []) {
    const native = e.platforms?.[l]?.native; if (!native) continue;
    const key = typeKey(l, native); if (!types[key]) continue;
    if (!represented.has(key)) represented.set(key, []);
    represented.get(key).push({ capability: c.id, role: e.role, front: c.origin?.front ?? legacyOwner(c.id) });
  }
  // Accounting per lane and owner: represented (a capability role names the type on that lane), classified (a
  // coverage entry of its owner), unaccounted. Counts are separate by inventory class; no global percentage.
  // Interfaces outside the object roots are counted in their own block (outsideRoot), never inside the model-element
  // totals.
  const accounting = {}; const typeStates = {};
  for (const [key, t] of Object.entries(types)) {
    if (!front || t.owner === front) typeStates[key] = represented.has(key) ? 'represented' : classified.has(key) ? 'classified' : 'unaccounted';
    const lane = key.split(':')[0]; const k = `${lane}:${t.owner}`;
    accounting[k] ??= { lane, owner: t.owner, types: 0, represented: 0, classified: { excluded: 0, gap: 0, undetermined: 0, represented: 0 }, unaccounted: 0, byClass: {} };
    const c = classified.get(key);
    if (t.kindClass === 'outside-object-root') {
      const o = (accounting[k].outsideRoot ??= { types: 0, represented: 0, classified: 0, unaccounted: 0 }); o.types++;
      if (represented.has(key)) o.represented++; else if (c) o.classified++; else o.unaccounted++;
      continue;
    }
    const a = accounting[k]; a.types++;
    const cls = (a.byClass[t.kindClass] ??= { types: 0, represented: 0, classified: 0, unaccounted: 0 }); cls.types++;
    if (represented.has(key)) { a.represented++; cls.represented++; }
    else if (c) { a.classified[c.status]++; cls.classified++; }
    else { a.unaccounted++; cls.unaccounted++; }
  }
  const toolAccounting = { owner: 'C', tools: Object.keys(tools).length, classified: Object.keys(tools).filter(k => classified.has(k)).length, represented: Object.keys(tools).filter(k => classified.get(k)?.status === 'represented').length };
  const legacy = { capabilities: Object.entries(ownership?.legacy?.capabilities ?? {}).map(([id, v]) => ({ id, owner: v.owner, lane: v.lane, superseded: supersedes.has(id) ? supersedes.get(id).by : null })), unavailable: Object.entries(ownership?.legacy?.unavailable ?? {}).map(([id, v]) => ({ id, owner: v.owner, superseded: supersedes.has(id) ? supersedes.get(id).by : null })) };
  const pick = list => (front ? list.filter(x => x.front === front) : list);
  return {
    ok: errors.length === 0, schemaVersion: 'ssam-catalog-check/1', contract: CONTRACT_VERSION, front: front ?? 'all',
    inventory: ownership ? { file: ownership.inventory.file, sha256: ownership.inventory.sha256.slice(0, 16), versions: ownership.inventory.versions } : null,
    indexes: Object.fromEntries(LANES.map(l => [l, indexes[l] ? { builtAt: indexes[l].builtAt, file: path.relative(root, indexes[l].file).replaceAll('\\', '/') } : 'absent: pointers and native types are checked only by ssam_discover {lane, rebuild:true}'])),
    fragments: front ? fragments.filter(f => f.front === front) : fragments,
    errors: pick(errors), warnings: pick(warnings), info: pick(info), pendingRequires: pick(pending),
    accounting: Object.values(accounting).filter(a => !front || a.owner === front).sort((a, b) => a.lane.localeCompare(b.lane) || a.owner.localeCompare(b.owner)),
    tools: !front || front === 'C' ? toolAccounting : undefined,
    legacy: { capabilities: legacy.capabilities.filter(x => !front || x.owner === front), unavailable: legacy.unavailable.filter(x => !front || x.owner === front) },
    counts: { errors: errors.length, warnings: warnings.length, errorsShown: pick(errors).length, warningsShown: pick(warnings).length },
    typeStates,
  };
}
