// The app kind of a request is a hard filter of ssam_discover (family F4, 2026-10-22): a Traditional request was sent to the
// prototype importer (Reactive/Mobile only) and got Reactive recipes (ui.dropdown for a Traditional ComboBox). Every
// capability and text route declares the kinds it supports, derived here from where it was proven, and an answer for a
// known kind offers nothing of another kind; when nothing is left it says so and gives the native path.
//
// Kinds: o11-traditional, o11-reactive, o11-mobile, o11-library (a module without a UI runtime: an O11 Service module),
// odc-reactive, odc-mobile. Each kind has a UI layer: web (Traditional), client (Reactive and Mobile share the client
// runtime and its native types: IMobileScreen, NRWidgets), or none (library).
//
// The declaration of a capability (capabilityKinds):
//  - its layers: the UI layers of its element types (OutSystems.Model.UI.Web.*, ServiceStudio.Plugin.Widgets.* are web;
//    OutSystems.Model.UI.Mobile.*, ServiceStudio.Plugin.NRWidgets.*, client actions, entities and variables are client);
//    a type of no UI layer (an entity, a server action, a flow comment node, a script or resource) is layer-neutral;
//  - its scope: 'ui' when it declares a type of a UI layer and either is a ui.* capability or declares nothing else (a
//    client action, a data action, a Preparation), or when it is a ui.* capability that declares no type at all (its
//    layers are then those of the kinds it was proven on); 'module' otherwise: entities, server logic, integrations,
//    timers, refactors, operations, and the ui.* capabilities whose every type is layer-neutral (a flow comment, a
//    script or resource) are the same native type under the module root whatever the module kind;
//  - provenOn: the kinds of the bases of its proof jobs on the lane (a job:<name> base resolves to that job's base).
// A 'ui' capability is offered for a kind only when its layers hold the kind's layer AND it was proven on a kind of that
// layer; a library (no UI layer) gets no ui capability. A 'module' capability is offered for every kind of its lane.
// Unknown (no proof of the layer) is unproven, never offered as a recipe for that kind.
//
// Pure: no I/O; the index and the jobs come from discovery.mjs.
import { normalize } from './catalog.mjs';
import { KIND_WORDS, DIRECTION_WORDS, OBJECT_NOUNS, MIGRATION_WORDS, CLAUSE_WORDS, COORDINATION_WORDS } from './request-vocabulary.mjs';

export const APP_KINDS = { o11: ['o11-traditional', 'o11-reactive', 'o11-mobile', 'o11-library'], odc: ['odc-reactive', 'odc-mobile'] };
export const KIND_LAYER = { 'o11-traditional': 'web', 'o11-reactive': 'client', 'o11-mobile': 'client', 'o11-library': null, 'odc-reactive': 'client', 'odc-mobile': 'client' };
const KIND_LABEL = { 'o11-traditional': 'O11 Traditional Web', 'o11-reactive': 'O11 Reactive Web', 'o11-mobile': 'O11 Mobile', 'o11-library': 'O11 library (Service module, no screens)',
  'odc-reactive': 'ODC Reactive Web', 'odc-mobile': 'ODC Mobile' };
export const kindLabel = kind => KIND_LABEL[kind] ?? kind;

// The module type the Studio stores (ESpaceType, the module digest's module.kind) as an app kind.
const MODULE_TYPES = { WebResponsive: 'traditional', WebResponsiveLibrary: 'traditional', CrossDevice: 'reactive', Reactive: 'reactive', ReactiveLibrary: 'reactive',
  Mobile: 'mobile', MobileLibrary: 'mobile', Service: 'library' };
export function kindOfModuleType(lane, type) {
  const family = MODULE_TYPES[String(type ?? '')];
  if (!family) return null;
  const kind = `${lane}-${family}`;
  return APP_KINDS[lane]?.includes(kind) ? kind : null;
}

// The lane fixtures the proof jobs declare as base, with their module type (kernel/tests/fixtures; CommandSurface.cs names
// the four O11 ones: Service blank-service, Reactive reactive-ui, Mobile mobile-ui, Traditional traditional-ui). A base
// not listed has no kind: its proofs count for no kind.
export const FIXTURE_KINDS = {
  'blank-service.oml': 'o11-library', 'reactive-ui.oml': 'o11-reactive', 'mobile-ui.oml': 'o11-mobile', 'traditional-ui.oml': 'o11-traditional',
  'odc/insurance-reactive-r8.oml': 'odc-reactive', 'odc/blank-mobile.oml': 'odc-mobile', 'odc/blank-mobile-producer.oml': 'odc-mobile',
};
export function fixtureKind(base) {
  const file = String(base ?? '').replaceAll('\\', '/').replace(/^.*tests\/fixtures\//, '');
  return FIXTURE_KINDS[file] ?? null;
}
// The kind of a job's base, through job:<name> chains (a cycle or a missing job is no kind).
export function jobKind(job, byName) {
  const seen = new Set(); let base = job?.base ?? null;
  while (typeof base === 'string' && base.startsWith('job:')) {
    const name = base.slice(4); if (seen.has(name)) return null; seen.add(name);
    base = byName.get(name)?.base ?? byName.get('examples/' + name)?.base ?? null;
  }
  return typeof base === 'string' ? fixtureKind(base) : null;
}

// The UI layer of a native type: 'web', 'client', or null (the module layer).
export function typeLayer(native) {
  const n = String(native ?? '');
  if (/^OutSystems\.Model\.UI\.Web\./.test(n) || /^ServiceStudio\.Plugin\.Widgets\./.test(n)) return 'web';
  if (/^OutSystems\.Model\.UI\.Mobile\./.test(n) || /^ServiceStudio\.Plugin\.NRWidgets\./.test(n) || /^OutSystems\.Model\.Logic\.Mobile\./.test(n)
    || /^OutSystems\.Model\.(Logic\.IClientAction|Data\.IClientEntity|Data\.IClientVariable)$/.test(n)) return 'client';
  return null;
}

const DECLARED = new WeakMap();
// The kinds every capability of the index supports, by id (memoized per index).
export function kindDeclarations(index) {
  if (DECLARED.has(index)) return DECLARED.get(index);
  const byName = new Map((index.jobs ?? []).map(j => [j.name, j]));
  const lane = index.lane;
  // The short job type names (jobs list types as IMobileScreen, IButtonWidget) with their layer, from every element of the
  // index; a short name of two layers (ITextWidget, IIfWidget) is no evidence of one.
  const shortLayer = new Map();
  for (const c of index.capabilities ?? []) for (const e of c.elements ?? []) {
    const layer = typeLayer(e.native); const short = String(e.native ?? '').split('.').at(-1);
    for (const name of new Set([short, e.jobType].filter(t => /^I[A-Z]\w*$/.test(t ?? '')))) shortLayer.set(name, shortLayer.has(name) && shortLayer.get(name) !== layer ? 'both' : layer);
  }
  const jobLayers = job => new Set(Object.keys(job?.types ?? {}).map(t => shortLayer.get(t) ?? (/^IWeb/.test(t) ? 'web' : /^IMobile/.test(t) ? 'client' : null)).filter(l => l === 'web' || l === 'client'));
  const declarations = new Map();
  for (const c of index.capabilities ?? []) {
    const proofs = new Set([...(Array.isArray(c.proofs) ? c.proofs : c.proofs?.[lane] ?? [])]);
    for (const op of Object.values(c.operations ?? {})) for (const role of Object.values(op?.roles ?? {})) for (const p of role?.proofs ?? []) proofs.add(p);
    const provenOn = [...new Set([...proofs].map(p => byName.get(p) ?? byName.get('examples/' + p)).filter(Boolean).map(j => jobKind(j, byName)).filter(Boolean))].sort();
    const natives = [...(c.elements ?? []).map(e => e.native), ...(c.native ?? [])].filter(Boolean);
    const layered = new Set(natives.map(typeLayer).filter(Boolean));
    const moduleElements = natives.some(n => typeLayer(n) === null);
    const ui = layered.size > 0 ? (c.category === 'ui' || !moduleElements) : (c.category === 'ui' && natives.length === 0);
    const layers = ui ? [...(layered.size ? layered : new Set(provenOn.map(k => KIND_LAYER[k]).filter(Boolean)))].sort() : [];
    const offered = (APP_KINDS[lane] ?? []).filter(k => !ui || (KIND_LAYER[k] && layers.includes(KIND_LAYER[k]) && provenOn.some(p => KIND_LAYER[p] === KIND_LAYER[k])));
    declarations.set(c.id, { scope: ui ? 'ui' : 'module', layers, provenOn, offered });
  }
  const value = { byId: declarations, jobLayers, byName };
  DECLARED.set(index, value);
  return value;
}
export function capabilityKinds(index, id) { return kindDeclarations(index).byId.get(id) ?? null; }

// A job is evidence for a kind when its base is of that kind's layer, or when it touches no UI layer (a data or server
// logic job on any fixture of the lane).
export function jobAdmissible(index, job, kinds) {
  const { jobLayers, byName } = kindDeclarations(index);
  const layers = jobLayers(job);
  if (!layers.size) return true;
  const own = KIND_LAYER[jobKind(job, byName)] ?? null;
  return kinds.some(k => KIND_LAYER[k] && own === KIND_LAYER[k] && [...layers].every(l => l === KIND_LAYER[k]));
}

// The index as one kind (or a set of kinds) sees it: the capabilities offered for it, their proofs and the jobs admissible
// for it; dependencies on a capability left out are left out too. Memoized per index and kind set.
const VIEWS = new WeakMap();
export function indexForKinds(index, kinds) {
  if (!kinds?.length) return index;
  const key = [...kinds].sort().join(',');
  let views = VIEWS.get(index); if (!views) VIEWS.set(index, views = new Map());
  if (views.has(key)) return views.get(key);
  const { byId } = kindDeclarations(index);
  const offered = c => kinds.some(k => byId.get(c.id)?.offered.includes(k));
  const jobs = (index.jobs ?? []).filter(j => jobAdmissible(index, j, kinds));
  const admitted = new Set(jobs.map(j => j.name));
  const keep = p => admitted.has(p) || admitted.has('examples/' + p);
  const kept = new Set((index.capabilities ?? []).filter(offered).map(c => c.id));
  const refs = list => (Array.isArray(list) ? list.filter(d => kept.has(typeof d === 'string' ? d : d?.id)) : list);
  const capabilities = (index.capabilities ?? []).filter(c => kept.has(c.id)).map(c => ({
    ...c,
    proofs: Array.isArray(c.proofs) ? c.proofs.filter(keep) : Object.fromEntries(Object.entries(c.proofs ?? {}).map(([l, ps]) => [l, (ps ?? []).filter(keep)])),
    ...(c.operations ? { operations: Object.fromEntries(Object.entries(c.operations).map(([op, def]) => [op, { ...def, roles: Object.fromEntries(Object.entries(def?.roles ?? {})
      .map(([role, r]) => [role, { ...r, proofs: (r?.proofs ?? []).filter(keep) }])) }])) } : {}),
    depends: refs(c.depends), alternatives: refs(c.alternatives), recommends: refs(c.recommends),
  }));
  const view = { ...index, capabilities, jobs, kinds };
  views.set(key, view);
  return view;
}

// The index as a request of unknown kind sees it: a UI capability shared by the lanes and proven on no kind of this one (the
// other lane's recipe: ui.dropdown-search on O11, ui.html-page on ODC) is not offered, with or without a kind word; every other
// capability, its jobs and proofs unchanged (a capability no lane proved stays as the catalog declares it until a kind is known).
const LANE_VIEWS = new WeakMap();
export function indexForLane(index) {
  if (LANE_VIEWS.has(index)) return LANE_VIEWS.get(index);
  const { byId } = kindDeclarations(index);
  const otherLanes = c => c.shared === true && (c.lanes ?? []).length > 1;
  const kept = new Set((index.capabilities ?? []).filter(c => byId.get(c.id)?.offered.length || byId.get(c.id)?.scope !== 'ui' || !otherLanes(c)).map(c => c.id));
  const refs = list => (Array.isArray(list) ? list.filter(d => kept.has(typeof d === 'string' ? d : d?.id)) : list);
  const view = kept.size === (index.capabilities ?? []).length ? index
    : { ...index, capabilities: index.capabilities.filter(c => kept.has(c.id)).map(c => ({ ...c, depends: refs(c.depends), alternatives: refs(c.alternatives), recommends: refs(c.recommends) })) };
  LANE_VIEWS.set(index, view);
  return view;
}

// ---- the kind a request names. A kind word narrows the answer only when it qualifies what the request builds or changes:
// next to an app, module, screen or widget noun ("Traditional screen", "tela tradicional", "the mobile app", "Traditional
// ComboBox"), or as the target of a migration ("migrate ... to Reactive", "converter a tela Reactive em Traditional").
// "web" or "native" alone name no kind; "the traditional approach", "look good on mobile", "a mobile phone input" or "para
// iOS e Android" do not narrow. In a migration the kind after a direction word of the same clause is the target and the
// other kinds named are the source; two kinds without a direction ("Traditional as well as Reactive screens") are both kept.
// The words are tables of request-vocabulary.mjs (input vocabulary, never emitted).
const set = text => new Set(text.split(' '));
const KIND_SETS = Object.fromEntries(Object.entries(KIND_WORDS).map(([k, v]) => [k, set(v)]));
const COORDINATION = set(COORDINATION_WORDS); const DIRECTION = set(DIRECTION_WORDS); const OBJECTS = set(OBJECT_NOUNS); const MIGRATION = set(MIGRATION_WORDS); const CLAUSES = set(CLAUSE_WORDS);
const words = text => normalize(String(text ?? '')).split(/[^a-z0-9]+/).filter(Boolean);
// Each kind word of the intent: its kind, whether it qualifies an object noun, and whether it is a migration's target.
export function kindMentions(lane, intent) {
  const all = words(intent); const migration = all.some(w => MIGRATION.has(w));
  const out = [];
  const familyOf = t => Object.keys(KIND_SETS).find(k => KIND_SETS[k].has(t)) ?? null;
  for (const clause of normalize(String(intent ?? '')).split(/[,;.:!?]/)) {
    const w = words(clause); let start = 0; const here = [];
    w.forEach((t, i) => {
      if (CLAUSES.has(t)) start = i + 1;
      const family = familyOf(t); if (!family) return;
      const kind = `${lane}-${family}`; if (!APP_KINDS[lane]?.includes(kind)) return;
      // An object noun within two words either side ("Traditional registration form", "tela tradicional", "app movel"),
      // never "mobile phone ..." nor "phone number".
      const near = [w[i - 1], w[i - 2], w[i + 1], w[i + 2]].filter(Boolean);
      const object = near.some(x => OBJECTS.has(x)) && !(family === 'mobile' && w[i + 1] === 'phone') && !(t === 'phone' && !OBJECTS.has(w[i + 1] ?? ''));
      const target = migration && w.slice(start, i).some(x => DIRECTION.has(x));
      here.push({ kind, object, target, i });
    });
    // Coordinated kinds share their noun: "Traditional as well as Reactive screens", "a Reactive and a Traditional screen".
    for (const m of here) if (!m.object) {
      const next = here.find(x => x.i > m.i && x.object && w.slice(m.i + 1, x.i).every(t => COORDINATION.has(t)));
      if (next) m.object = true;
    }
    out.push(...here.map(({ i: _i, ...m }) => m));
  }
  return { mentions: out, migration };
}
// The kinds the words name: { kinds, source, migration }. In a migration with a target, kinds is the target and source the other
// kinds named; otherwise every kind that qualifies an object.
export function kindReading(lane, intent) {
  const { mentions, migration } = kindMentions(lane, intent);
  const counted = mentions.filter(m => m.object || m.target);
  const targets = [...new Set(counted.filter(m => m.target).map(m => m.kind))];
  if (migration && targets.length) return { kinds: targets, source: [...new Set(mentions.map(m => m.kind).filter(k => !targets.includes(k)))], migration: true };
  return { kinds: [...new Set(counted.map(m => m.kind))], source: [], migration: false };
}
export function kindsFromIntent(lane, intent) { return kindReading(lane, intent).kinds; }
// The kinds an O11 or ODC capture says from the flows it holds (counts of WebFlow and MobileFlow). The module map filters by
// kind as the Studio does: an element counts for every interface it carries, so a Reactive or Mobile module's MobileFlow
// rows come back under WebFlow too (reactive-ui.oml: 3 and 3). The Mobile flows decide first: any is Reactive or Mobile
// (one native layer, the flows do not tell the two apart); Web flows and no Mobile flow are Traditional; none a library.
export function kindsFromFlows(lane, { web = 0, mobile = 0 } = {}) {
  if (mobile > 0) return lane === 'o11' ? ['o11-reactive', 'o11-mobile'] : ['odc-reactive', 'odc-mobile'];
  if (lane === 'o11' && web > 0) return ['o11-traditional'];
  if (lane === 'o11' && web === 0 && mobile === 0) return ['o11-library'];
  return [];
}

// The layer a text route writes (text-routes.mjs ROUTES): ssam-html/1 is the client layer only (the html op and the
// ssam-html edit refuse a Traditional screen: HtmlExpander, HTML_TRADITIONAL); the data and logic texts are of the module.
export const TEXT_ROUTE_LAYERS = { 'ui.screen-html': 'client', 'ui.screen-html-edit': 'client', 'data.ddl': null, 'logic.flow': null };
export function textRouteOffered(id, kinds) {
  if (!kinds?.length || !(id in TEXT_ROUTE_LAYERS)) return true;
  const layer = TEXT_ROUTE_LAYERS[id];
  return layer === null || kinds.some(k => KIND_LAYER[k] === layer);
}
// The OutSystems UI app types (osui-catalog.mjs) of a kind set: a library has none.
export function osuiAppTypes(kinds) { return [...new Set((kinds ?? []).filter(k => KIND_LAYER[k]))]; }

// ---- the native path when no proven recipe is left for the kind: the native contract of a type of the kind's own UI layer
// the intent names by a whole word ("ComboBox" -> IComboBoxWidget; "form" on Traditional -> ServiceStudio.Plugin.Widgets.IForm,
// never the Reactive NRWidgets.IForm), by its full name (a short name can be two types), else the raw verbs. A
// layer-neutral type (IReference, IServerEntity) is never the native path of a UI need.
export function nativeTypesNamed(index, kinds, intent) {
  const w = words(intent); const pairs = w.slice(1).map((t, i) => w[i] + t);
  const said = new Set([...w, ...pairs, ...w.map(t => t.replace(/s$/, ''))]);
  const layers = new Set(kinds.map(k => KIND_LAYER[k]).filter(Boolean));
  const out = [];
  for (const c of index.capabilities ?? []) for (const e of c.elements ?? []) {
    const layer = typeLayer(e.native); if (layer === null || !layers.has(layer)) continue;
    const short = String(e.native ?? '').split('.').at(-1); if (!/^I[A-Z]\w+$/.test(short)) continue;
    const stem = normalize(short.slice(1).replace(/Widget$/, '').replace(/^(Web|Mobile)(?=[A-Z])/, ''));
    if (stem.length >= 4 && said.has(stem) && !out.includes(e.native)) out.push(e.native);
  }
  return out.slice(0, 3);
}
// The UI capability of a kind's own layer that holds a native type (the owner of IWebTheme on Traditional is
// ui.traditional-screen), and the layer's broadest one (the UI capability offered for the kind with the most element types:
// ui.traditional-widget on Traditional, ui.widget on Reactive and Mobile), derived from the declarations.
export function kindOwnCapabilities(index, kinds) {
  const { byId } = kindDeclarations(index);
  const own = (index.capabilities ?? []).filter(c => byId.get(c.id)?.scope === 'ui' && kinds.some(k => byId.get(c.id)?.offered.includes(k) && KIND_LAYER[k]));
  const ownerOf = native => own.find(c => (c.elements ?? []).some(e => e.native === native))?.id ?? null;
  const broadest = [...own].sort((a, b) => (b.elements?.length ?? 0) - (a.elements?.length ?? 0) || a.id.localeCompare(b.id))[0]?.id ?? null;
  return { ownerOf, broadest };
}
// The one native call when no proven recipe is left: the kind's own UI capability the words reached, else the one holding
// the native type the words name, else the layer's broadest one (its contract, a proven example and its native types:
// the raw verbs); a module without a UI layer gets the catalog with the reason.
export function nativePath(lane, kinds, types = [], reached = [], index = null) {
  const deliver = lane === 'o11' ? 'o11_deliver {module, job:{ops:[create/set...]}}' : 'studio_deliver {feature, module, job:{ops:[create/set...]}}';
  const label = kinds.map(kindLabel).join(' / ');
  if (!kinds.some(k => KIND_LAYER[k])) return { call: { tool: 'ssam_discover', arguments: { lane, catalog: true } },
    why: `${label} has no UI layer: screens, widgets and client logic go in a UI module of the app (Reactive, Mobile or Traditional) that references this one; this lists every capability by group` };
  const own = index ? kindOwnCapabilities(index, kinds) : { ownerOf: () => null, broadest: null };
  const type = types[0] ?? null;
  const id = reached[0] ?? (type ? own.ownerOf(type) : null) ?? own.broadest;
  if (!id) return { call: type ? { tool: 'ssam_discover', arguments: { lane, type } } : { tool: 'ssam_discover', arguments: { lane, catalog: true } },
    why: (type ? `the native contract of ${type} as the installed Studio loads it` : 'every capability and tool of the lane by group') + `; then write the native verbs (create, set) for ${label} in one ${deliver} call` };
  return { call: { tool: 'ssam_discover', arguments: { lane, expand: `${id}:contract+example+native` } },
    why: `${id}, the ${label} capability ${reached[0] === id ? 'the words reached' : type ? 'that holds ' + type : 'of its UI layer'}: its contract, a proven example and the native types (raw verbs, the native contract of each type by ssam_discover {lane, type:"<full type name>"}); then write the native verbs (create, set) in one ${deliver} call`,
    ...(type ? { type } : {}) };
}
