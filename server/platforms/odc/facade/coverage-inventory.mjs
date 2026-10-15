// Phase-1 coverage inventory of the contextual discovery (corrected 2026-09-23): what the native models suggest, what
// SSAM implements as a route, what the suites prove and what stays undetermined, per element type × operation ×
// platform. Every type keeps its QUALIFIED identity (platform, metadata version, assembly, namespace, name); the short
// name is only used for presentation and for matching evidence that is keyed by short name (jobs, ledger, descriptor,
// reader census). A short name shared by several qualified types is recorded as an ambiguity, never resolved silently.
//
// Per cell (type × op) the output separates: `metadata` (what the native metadata suggests: own/inherited/generic/
// ambiguous/no basis/context-excluded), `preconditions`, `route` (what SSAM implements: reader, generic verb, public
// contract naming the type, C# builder primitive, code mention), `proven` (executed ledger, static suite jobs,
// negative jobs, reader census, known limits — each with its attribution: exact / module-context / kernel-rank /
// ambiguous) and `status` (tested-executed, tested-static, route-only, suggested-only, context-excluded,
// refused-proven, undetermined — with `missing` when undetermined). Curated pieces (family rules, application-family
// tag, kind-class rule, attribution rule, operation metadata rules) are printed in `inventory.json.sources`.
//
// Usage: node platforms/odc/facade/coverage-inventory.mjs [--out <dir>] [--census] [--census-from <inventory.json> [--census-fill]] [--no-cli]
//   --census              asks the ODC reader for the count of every element kind in the lane fixture (one read per kind)
//   --census-from <file>  reuses the census of a previous inventory.json (its identity is copied and declared as reused)
//   --census-fill         with --census-from: reads only the kinds missing from the reused census (same fixture sha256 required)
//   --no-cli              skips `api --op` (contracts) when the ODC CLI is not built
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { laneSources, buildIndex, loadLimits } from './discovery.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const wt = path.resolve(here, '..', '..', '..');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const exists = f => { try { return fs.existsSync(f); } catch { return false; } };
export const OPS = ['read', 'address', 'usages', 'create', 'set', 'rename', 'replace', 'move', 'duplicate', 'delete'];
export const STATUSES = ['tested-executed', 'tested-static', 'route-only', 'suggested-only', 'context-excluded', 'refused-proven', 'undetermined'];
export const KIND_CLASSES = ['concrete-authorable', 'base-interface', 'referenced-signature', 'undetermined'];
export const simple = name => String(name ?? '').replace(/<.*$/, '').split('.').pop();
const EXTENSION_NS = /^OutSystems\.Model\.(Extensions|ExternalLibraries)$/;
const unwrap = type => String(type ?? '').replace(/^(ISequence|IEnumerable|IList|IReadOnlyList|IReadOnlyCollection|ICollection)<(.+)>$/, '$2');

// ---------------------------------------------------------------- families (curated; the rule is printed)
const FAMILY_RULES = [
  ['abstract', /^(IObject|IObjectWith\w+|IShareable\w*|IShareableESpaceObject\w*|IShareableObjectSignature\w*|IAbstractionsManager|IModelObject|IVersionedObject|INamedObject)$/],
  ['module', /^(IESpace|IApplication|IModule|IReference|IExtension|IFolder|IExtendedProperty|IMobileConfigurations|INativeSplashScreenConfiguration|IThemeValues|ILocale|IRequiredModelPlugin)$/],
  ['data.type', /^I(BasicType|IdentifierType|ListType|RecordType|Type|GenericType|AnonymousStructure|Attribute|PairType|EntityReferenceType|\w+Type)$/],
  ['logic.query', /^I(AliasedSource|Join|Filter|Sort|GroupByAttribute|AggregatedAttribute|CalculatedAttribute|SQLParameter|OutputStructure|AggregateAttribute|QueryAttribute|DatabaseAggregate|FullAggregate|AddSourceOperation|CombineSourcesOperation|GroupByOperation|Operation|Aggregate\w+)$/],
  ['integration.timer', /^I(Timer|Schedule\w*|DayOfMonth|DayOfWeek|Hour|Minute|Month|TimeOfDay|WeekOfMonth)$/],
  ['integration.plugin', /^I(Client|Service|Integration|ConsumedAction|ExposedAction|PluginCallback|ExternalConnection|Sap\w+)$/],
  ['data.type', /^IRecordLiteralField$/],
  ['ai', /^I(Agent\w*|AI\w*|A2AConnection|MCPConnection|KnowledgeBase|Memory|SessionMemory|ToolReference|CallableAgent)$/],
  ['data.entity', /^I(ServerEntity|ClientEntity|StaticEntity|Entity|HiddenEntity|EntityAttribute|EntityIndex|EntityIndexAttribute|StaticEntityRecord|Record|RecordAttribute|ClientEntityAttribute|EntityDiagram|EntityDiagram\w*|IdentifierType|EntityVersion|EntityAction\w*|RecordAttributeValue|LifeCycle\w*Event)\b/],
  ['data.structure', /^I(Structure|StructureAttribute|StructureSignature|ListType|RecordType|BasicType|ObjectType|Type\w*|PairType)\b/],
  ['logic.action', /^I(ServerAction|ClientAction|ServiceAction|ScreenAction|DataAction|Action|UserAction|OnExceptionAction|Function|BuiltinAction|Aggregate|DataActionSignature|ActionSignature|ServerActionSignature|ClientActionSignature)\b/],
  ['logic.node', /^I\w*(Node|Connector|Handler|ActionFlow|Flow|Outcome|Path)$/],
  ['ui.metadata', /^I\w*Metadata$/],
  ['logic.parameter', /^I(InputParameter|OutputParameter|LocalVariable|Argument|Parameter|Variable|AIArgument|ImplicitParameter)\w*/],
  ['logic.query', /^I(AliasedSource|Join|Filter|Sort|GroupByAttribute|AggregatedAttribute|CalculatedAttribute|SQLParameter|OutputStructure|AggregateAttribute|QueryAttribute|Aggregate\w+)$/],
  ['logic.exception', /^I\w*(Exception|ExceptionHandler)\w*$/],
  ['integration.rest', /^I(Rest|REST|Http)\w*/],
  ['integration.soap', /^I(Soap|SOAP|Wsdl)\w*/],
  ['integration.event', /^I(Timer|SystemEvent|GlobalEvent|ExternalSite|Event|BlockEvent|BuiltinEvent|UILifeCycleEvent|ScreenEvent|CustomEvent|EventHandler)\b/],
  ['ui.screen', /^I(MobileScreen|WebScreen|Screen|MobileFlow|WebFlow|UIFlow|Flow|MobileEmail|Email|MobileTheme|WebTheme|Theme|Style\w*|Image|Script|Resource|Layout|Popover|ScreenTemplate)\b/],
  ['ui.block', /^I(MobileBlock|WebBlock|Block|Placeholder\w*|MobileBlockInstanceWidget|WebBlockInstance\w*|BlockInstance\w*|WidgetDefinition\w*)\b/],
  ['ui.widget', /^I\w*(Widget|Container|Content|Expression|Input|Button|Link|Label|List|ListItem|ListItemAction|Table|TableRecords|Form|Dropdown|Checkbox|Icon|Text|Html|Column|Row|Chart|Carousel|Switch|RadioButton|Upload|Search|If|Legend)\w*$/],
  ['security.config', /^I(Role|AppRole|SiteProperty|Setting|ClientVariable|SessionVariable|Permission|UserException|Tenant|Credential)\w*/],
  ['process', /^I(BusinessProcess|Process|HumanActivity|Activity|Wait|Conditional|AutomaticActivity|SendEmailActivity|ExecuteProcess|Agent)\w*/],
  ['ai', /^I(Agent|AI)\w*/],
];
export function familyOf(shortName, ns = '') {
  for (const [family, re] of FAMILY_RULES) if (re.test(shortName)) return family;
  if (/Signature$/.test(shortName)) return 'reference.signature';
  if (/\.Nodes$/.test(ns)) return 'logic.node';
  if (/\.Widgets$|NRWidgets/.test(ns)) return 'ui.widget';
  if (/\.Data$/.test(ns)) return 'data.entity';
  if (/\.Logic$/.test(ns)) return 'logic.action';
  if (/\.UI\b/.test(ns)) return 'ui.screen';
  return 'other';
}
// Application-family TAG of a type (curated from namespace/name). It is a tag, not an exclusion: the ODC census shows
// that CrossDevice screens implement IWebScreen too, so "web" types can be relevant as base interfaces on ODC.
export function appFamilyOf(shortName, ns = '') {
  if (/\.UI\.Web\b|WebScreen|WebBlock|WebFlow|WebTheme|WebWidget|IWeb[A-Z]/.test(ns + ' ' + shortName)) return 'web';
  if (/\.UI\.Mobile\b|NRWidgets|MobileScreen|MobileBlock|MobileFlow|MobileTheme|MobileWidget|IMobile[A-Z]/.test(ns + ' ' + shortName)) return 'reactive';
  return 'shared';
}
export const APP_FAMILY_RULE = 'tag from namespace/name: web = OutSystems.Model.UI.Web or Web*/IWeb* names; reactive = OutSystems.Model.UI.Mobile, NRWidgets plugin or Mobile*/IMobile* names; shared = the rest. A tag, not an exclusion: types tagged web stay in the inventory and in the per-kind denominators; the reader census tells whether ODC objects implement them';

// Kernel rule for resolving a short type name on `create` (kernel/src/Anvil.Core/Kernel/Verbs.cs, FindCreateCore):
// full name given > NRWidgets plugin > OutSystems.Model.* > Extensions/ExternalLibraries and Processes/BusinessProcesses > rest.
export function kernelCreateRank(ns, qualified, requested) {
  if (qualified === requested) return 0;
  if (String(ns).startsWith('ServiceStudio.Plugin.NRWidgets')) return 1;
  if (EXTENSION_NS.test(ns) || /^OutSystems\.Model\.(Processes|BusinessProcesses)/.test(ns)) return 3;
  if (String(ns).startsWith('OutSystems.Model')) return 2;
  return 4;
}
export const ATTRIBUTION_RULE = 'evidence keyed by a short name (jobs, ledger, descriptor, reader census) is attributed to a qualified type only when: exact = the short name has one qualified type in the platform inventory; kernel-rank (create only) = the kernel ranking of Verbs.cs FindCreateCore leaves one top candidate (NRWidgets > OutSystems.Model.* > Extensions/ExternalLibraries/Processes/BusinessProcesses); module-context = after removing the OutSystems.Model.Extensions and OutSystems.Model.ExternalLibraries candidates (extension-module types, "never what an eSpace creates", Verbs.cs:904-905) one candidate remains; otherwise ambiguous = recorded under the short name, attributed to no qualified type and not counted as proof';
export function attributor(types) {
  const byShort = new Map();
  for (const t of types) { if (!byShort.has(t.shortName)) byShort.set(t.shortName, []); byShort.get(t.shortName).push(t); }
  return (short, { op } = {}) => {
    const cands = byShort.get(short) ?? [];
    if (!cands.length) return { attribution: 'none', candidates: [] };
    if (cands.length === 1) return { attribution: 'exact', id: cands[0].id, candidates: [cands[0].id] };
    if (op === 'create') {
      const ranked = cands.map(c => [kernelCreateRank(c.namespace, c.name, short), c]).sort((a, b) => a[0] - b[0]);
      if (ranked[0][0] < ranked[1][0]) return { attribution: 'kernel-rank', id: ranked[0][1].id, candidates: cands.map(c => c.id), rule: 'Verbs.cs FindCreateCore rank' };
    }
    const module = cands.filter(c => !EXTENSION_NS.test(c.namespace));
    if (module.length === 1) return { attribution: 'module-context', id: module[0].id, candidates: cands.map(c => c.id), rule: 'Extensions/ExternalLibraries candidates describe extension modules (Verbs.cs:904-905)' };
    return { attribution: 'ambiguous', candidates: cands.map(c => c.id) };
  };
}

export const KIND_CLASS_RULE = 'referenced-signature = role signature (base closure reaches IObjectSignature but not IObject); concrete-authorable = role object with a factory that returns exactly this type (ODC: Create* method resolved without ambiguity; O11: catalog Creatables) or, when no other inventoried interface has it as a base, a widget/flow-node interface created through the generic CreateWidget<T>/CreateNode<T>; base-interface = role object without such a factory that appears in the resolved base closure of another inventoried interface (its properties and operations are kept; it is not counted as an extra concrete element); undetermined = role object with neither a factory nor an implementer (possibly created by the platform, not verified). A concrete type that is also a base of others keeps alsoBaseOf';
function classifyKind(t, implementedBy) {
  if (t.role === 'signature') return ['referenced-signature', 'base closure reaches IObjectSignature only'];
  if (t.role === 'undetermined') return ['undetermined', 'role undetermined: ' + t.roleBasis];
  if (t.factories.length) return ['concrete-authorable', 'factory returning exactly this type: ' + t.factories.slice(0, 2).map(f => f.factory).join(', ') + (implementedBy ? ` (also base of ${implementedBy})` : '')];
  if (implementedBy) return ['base-interface', `in the resolved base closure of ${implementedBy} inventoried interface(s); no factory returns exactly this type`];
  if (t.genericFactory) return ['concrete-authorable', `generic factory ${t.genericFactory} (the parent decides which ${t.isWidget ? 'widgets' : 'nodes'} it accepts)`];
  return ['undetermined', 'no factory returns this type and no inventoried interface has it as a base: possibly created by the platform or by an import (internal auxiliary), not verified'];
}

// ---------------------------------------------------------------- 1. native ODC (reflection index; short names in bases/signatures)
export function loadOdcNative({ raw, version, dir } = {}) {
  dir = dir ?? path.join(wt, 'platforms', 'odc', 'docs', 'model-api');
  let files = [];
  if (!raw) {
    const index = exists(path.join(dir, 'INDEX.md')) ? fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8') : '';
    version = version ?? (/ODC Studio ([0-9.]+)/.exec(index)?.[1] ?? null);
    files = ['OutSystems.Model.V1.json', 'OutSystems.Model.Plugin.NRWidgets.json', 'OutSystems.Model.Plugin.Widgets.json', 'OutSystems.Model.Plugin.REST.json', 'OutSystems.Model.Plugin.RESTService.json', 'OutSystems.Model.Plugin.SOAP.json', 'OutSystems.ModelAPILoader.json'].filter(f => exists(path.join(dir, f)));
    raw = []; for (const f of files) for (const t of readJson(path.join(dir, f))) raw.push({ ...t, file: f });
  }
  const all = raw.map(t => ({ ...t, file: t.file ?? 'synthetic', short: simple(t.name), qualified: t.namespace + '.' + t.name }));
  const interfaces = all.filter(t => t.kind === 'interface');
  const byShort = new Map(); for (const t of interfaces) { if (!byShort.has(t.short)) byShort.set(t.short, []); byShort.get(t.short).push(t); }
  const byQualified = new Map(interfaces.map(t => [t.qualified, t]));
  const idOf = t => `odc:${version}:${t.file.replace(/\.json$/, '')}:${t.qualified}`;
  // Resolution of a short name written in the metadata of `from` (see RESOLUTION_RULE): unique > same namespace >
  // enclosing namespace (C# name lookup) > module/extension context (kernel rule) > same assembly > ambiguous.
  const arityOf = s => { const m = /<(.*)>$/.exec(String(s).trim()); if (!m) return 0; let depth = 0; let n = 1; for (const ch of m[1]) { if (ch === '<') depth++; else if (ch === '>') depth--; else if (ch === ',' && depth === 0) n++; } return n; };
  const resolve = (short, from) => {
    const s = simple(short); let cands = byShort.get(s) ?? [];
    if (!cands.length) return { status: 'external', short: s };
    const sameArity = cands.filter(c => arityOf(c.name) === arityOf(short)); if (sameArity.length && sameArity.length < cands.length) cands = sameArity;
    if (cands.length === 1) return { status: 'resolved', type: cands[0], resolvedBy: 'unique' };
    const ns = cands.filter(c => c.namespace === from.namespace); if (ns.length === 1) return { status: 'resolved', type: ns[0], resolvedBy: 'same-namespace' };
    const enclosing = cands.filter(c => from.namespace.startsWith(c.namespace + '.')).sort((a, b) => b.namespace.length - a.namespace.length); if (enclosing.length) return { status: 'resolved', type: enclosing[0], resolvedBy: 'enclosing-namespace' };
    const fromExt = EXTENSION_NS.test(from.namespace); const ctx = cands.filter(c => EXTENSION_NS.test(c.namespace) === fromExt); if (ctx.length === 1) return { status: 'resolved', type: ctx[0], resolvedBy: fromExt ? 'extension-context' : 'module-context' };
    const asm = cands.filter(c => c.file === from.file); if (asm.length === 1) return { status: 'resolved', type: asm[0], resolvedBy: 'same-assembly' };
    return { status: 'ambiguous', short: s, candidates: cands.map(c => c.qualified) };
  };
  const closureCache = new Map();
  const closure = t => {
    if (closureCache.has(t.qualified)) return closureCache.get(t.qualified);
    const resolved = new Map(); const ambiguous = []; const external = new Set(); const stack = [t];
    while (stack.length) {
      const cur = stack.pop();
      for (const b of cur.bases ?? []) {
        const r = resolve(b, cur);
        if (r.status === 'resolved') { if (!resolved.has(r.type.qualified)) { resolved.set(r.type.qualified, { via: cur.qualified, resolvedBy: r.resolvedBy }); stack.push(r.type); } }
        else if (r.status === 'ambiguous') ambiguous.push({ short: r.short, in: cur.qualified, candidates: r.candidates });
        else external.add(r.short);
      }
    }
    const out = { resolved, ambiguous, external: [...external] }; closureCache.set(t.qualified, out); return out;
  };
  const parseProp = sig => { const m = /^(.+?)\s+([A-Za-z_]\w*)\s*\{\s*get;(\s*set;)?\s*\}$/.exec(sig); return m ? { type: m[1], name: m[2], writable: !!m[3] } : null; };
  const parseMethod = sig => { const m = /^(\S+)\s+([A-Za-z_]\w*)(<[^>]*>)?\((.*)\)$/.exec(sig); return m ? { returns: m[1], name: m[2], generic: !!m[3], params: m[4] } : null; };
  const rootOf = t => { const c = closure(t); const shorts = new Set([...c.resolved.keys()].map(simple)); return { object: shorts.has('IObject') || t.name === 'IObject', signature: shorts.has('IObjectSignature') || t.name === 'IObjectSignature', modelObject: shorts.has('IModelObject') || t.name === 'IModelObject', widget: shorts.has('IWidget') || shorts.has('IMobileWidget') || shorts.has('IWebWidget'), flowNode: shorts.has('IFlowNode'), descriptor: shorts.has('IObjectDescriptor') || shorts.has('IClassDescriptor'), closure: c }; };
  // Factories: Create* methods returning a short type, resolved relative to the declaring type; ambiguous returns are
  // recorded on every candidate as ambiguous (not as a factory). CreateSibling creates beside, never inside (kernel rule).
  const factories = new Map(); const factoriesAmbiguous = new Map(); const genericFactories = new Set(); const genericFactoryNames = new Set();
  for (const t of interfaces) for (const m of t.members ?? []) {
    if (m.kind !== 'method') continue; const p = parseMethod(m.signature); if (!p || !/^Create/.test(p.name) || /^CreateSibling|Translation|Metadata/.test(p.name)) continue;
    if (p.returns === 'T' || p.generic) { genericFactories.add(t.qualified + '.' + p.name); genericFactoryNames.add(p.name); continue; }
    const r = resolve(p.returns, t);
    if (r.status === 'resolved') { const k = r.type.qualified; if (!factories.has(k)) factories.set(k, []); factories.get(k).push({ factory: t.qualified + '.' + p.name, resolvedBy: r.resolvedBy }); }
    else if (r.status === 'ambiguous') for (const c of r.candidates) { if (!factoriesAmbiguous.has(c)) factoriesAmbiguous.set(c, []); factoriesAmbiguous.get(c).push({ factory: t.qualified + '.' + p.name, candidates: r.candidates }); }
  }
  // Referenceable: a type (or its *Signature) used as the type of a writable property of another interface.
  const referencedBy = new Map(); const referencedByAmbiguous = new Map();
  for (const t of interfaces) for (const m of t.members ?? []) {
    if (m.kind !== 'property') continue; const p = parseProp(m.signature); if (!p || !p.writable) continue;
    const inner = simple(unwrap(p.type)); if (!/^I[A-Z]/.test(inner)) continue;
    for (const [cand, how] of [[inner, 'direct'], [inner.replace(/Signature$/, ''), 'via-signature']]) {
      if (how === 'via-signature' && cand === inner) continue;
      const r = resolve(cand, t);
      if (r.status === 'resolved') { const k = r.type.qualified; if (!referencedBy.has(k)) referencedBy.set(k, []); referencedBy.get(k).push({ by: t.qualified + '.' + p.name, how, resolvedBy: r.resolvedBy }); }
      else if (r.status === 'ambiguous') for (const c of r.candidates) { if (!referencedByAmbiguous.has(c)) referencedByAmbiguous.set(c, []); referencedByAmbiguous.get(c).push({ by: t.qualified + '.' + p.name, how, candidates: r.candidates }); }
    }
  }
  const types = []; const excluded = { descriptor: 0, noRoot: 0 };
  // Interfaces outside the object roots are not model elements, but they are part of the Model API a task can meet
  // (applications and referenced modules, extensions, merge, expression nodes, metamodel): listed with their identity
  // so the catalog accounts them as their own class, never mixed with the model elements (catalog M1, request C-007).
  const outsideRoot = [];
  for (const t of interfaces) {
    const roots = rootOf(t);
    if (/Descriptor$/.test(t.name) || roots.descriptor) { excluded.descriptor++; continue; }
    let role = roots.object ? 'object' : roots.signature ? 'signature' : null; let roleBasis = role ? 'resolved base closure' : null;
    if (!role && roots.closure.ambiguous.length) {
      // every candidate of every ambiguous base agrees → the role is safe to state; otherwise undetermined.
      const verdicts = roots.closure.ambiguous.flatMap(a => a.candidates.map(q => { const r = rootOf(byQualified.get(q)); return r.object ? 'object' : r.signature ? 'signature' : 'none'; }));
      const set = new Set(verdicts);
      if (set.size === 1 && !set.has('none')) { role = [...set][0]; roleBasis = 'all candidates of ambiguous base(s) ' + roots.closure.ambiguous.map(a => a.short).join(',') + ' agree'; }
      else if (set.size) { role = 'undetermined'; roleBasis = 'ambiguous base(s) ' + roots.closure.ambiguous.map(a => a.short).join(',') + ' with candidates of different roles'; }
    }
    if (!role) { excluded.noRoot++; outsideRoot.push({ id: idOf(t), platform: 'odc', metadataVersion: version, assembly: t.file.replace(/\.json$/, ''), namespace: t.namespace, name: t.qualified, shortName: t.short, kindClass: 'outside-object-root', kindBasis: 'no resolved base reaches IObject or IObjectSignature: not a model element (API plumbing, applications/modules, extensions, merge, expression nodes)' }); continue; }
    const ownProps = (t.members ?? []).map(m => (m.kind === 'property' ? parseProp(m.signature) : null)).filter(Boolean);
    const inherited = []; const seen = new Set(ownProps.map(p => p.name));
    for (const [q] of roots.closure.resolved) for (const m of byQualified.get(q)?.members ?? []) { if (m.kind !== 'property') continue; const p = parseProp(m.signature); if (!p || seen.has(p.name)) continue; seen.add(p.name); inherited.push({ ...p, from: q }); }
    const own = t.members?.filter(m => m.kind === 'method').map(m => parseMethod(m.signature)?.name).filter(Boolean) ?? [];
    const nameOwn = ownProps.find(p => p.name === 'Name' && p.writable); const nameInh = inherited.find(p => p.name === 'Name' && p.writable);
    const identifier = ownProps.find(p => p.name === 'Identifier' && p.writable) ?? inherited.find(p => p.name === 'Identifier' && p.writable);
    const family = familyOf(t.name, t.namespace); const appFamily = appFamilyOf(t.name, t.namespace);
    types.push({ id: idOf(t), platform: 'odc', metadataVersion: version, assembly: t.file.replace(/\.json$/, ''), namespace: t.namespace, name: t.qualified, shortName: t.short,
      role, roleBasis, family, appFamily, kindClass: null, kindBasis: null, genericFactory: roots.widget && genericFactoryNames.has('CreateWidget') ? 'CreateWidget<T>' : roots.flowNode && genericFactoryNames.has('CreateNode') ? 'CreateNode<T>' : null,
      bases: [...roots.closure.resolved].map(([q, v]) => ({ type: q, resolvedBy: v.resolvedBy })), ambiguousBases: roots.closure.ambiguous, externalBases: roots.closure.external,
      writableOwn: ownProps.filter(p => p.writable).map(p => p.name), writableInherited: inherited.filter(p => p.writable).map(p => ({ name: p.name, from: p.from })), propertyCount: ownProps.length + inherited.length, ownMethods: own.slice(0, 40),
      factories: factories.get(t.qualified) ?? [], factoriesAmbiguous: factoriesAmbiguous.get(t.qualified) ?? [],
      nameWritable: nameOwn ? 'own' : nameInh ? 'inherited' : 'none', nameWritableFrom: nameInh?.from ?? null, identifierWritable: !!identifier,
      hasModelObject: roots.modelObject, isWidget: roots.widget, flowNode: roots.flowNode,
      referencedBy: (referencedBy.get(t.qualified) ?? []).slice(0, 8), referencedByAmbiguous: (referencedByAmbiguous.get(t.qualified) ?? []).slice(0, 8) });
  }
  // Implementers (inventoried interfaces whose resolved base closure contains the type) → kind class.
  const implementedBy = new Map();
  for (const t of types) for (const b of t.bases) implementedBy.set(b.type, (implementedBy.get(b.type) ?? 0) + 1);
  const inventoriedByShort = new Map(); for (const t of types) inventoriedByShort.set(t.shortName, (inventoriedByShort.get(t.shortName) ?? 0) + 1);
  for (const t of types) { const n = implementedBy.get(t.name) ?? 0; t.implementedBy = n; [t.kindClass, t.kindBasis] = classifyKind(t, n); t.shortNameCandidatesInIndex = byShort.get(t.shortName).length; t.shortNameCandidatesInventoried = inventoriedByShort.get(t.shortName); }
  const collisions = [...byShort].filter(([, v]) => v.length > 1).map(([short, v]) => ({ short, qualified: v.map(c => c.qualified), inventoried: types.filter(t => t.shortName === short).map(t => t.id) }));
  return { platform: 'odc', version, dir: path.relative(wt, dir).replaceAll('\\', '/'), files, totalTypes: all.length, interfaces: interfaces.length, kept: types.length, excluded, types, outsideRoot,
    collisions: { shortNamesWithSeveralQualifiedTypes: collisions.length, shortNamesWithSeveralInventoriedTypes: collisions.filter(c => c.inventoried.length > 1).length, list: collisions }, genericFactories: [...genericFactories].slice(0, 30), genericFactoryNames: [...genericFactoryNames],
    resolutionRule: RESOLUTION_RULE,
    rule: 'kept: every interface (no de-duplication by short name) whose resolved base closure reaches IObject (role object) or IObjectSignature only (role signature); a base written as a short name is resolved by RESOLUTION_RULE, otherwise recorded in ambiguousBases and not followed (its members are not merged); role stated through an ambiguous base only when all candidates agree, else undetermined (kept, flagged); excluded: *Descriptor / IObjectDescriptor / IClassDescriptor closures, classes, static classes, enums, interfaces without the object roots (Extensions/ExternalLibraries hierarchies reach IModelObject only). Identity = platform:metadataVersion:assembly:namespace.name' };
}
export const RESOLUTION_RULE = 'a short type name written in the ODC metadata (bases, Create* return types, property types) is resolved, relative to the declaring type, among the candidates of the same generic arity, as: unique in the index > same namespace > enclosing namespace (C# looks a simple name up through the enclosing namespaces: OutSystems.Model.Data → OutSystems.Model) > module/extension context (candidates in OutSystems.Model.Extensions/ExternalLibraries describe extension modules, Verbs.cs:904-905: a module type resolves to the non-extension candidate and vice versa, when exactly one remains) > same assembly > ambiguous (recorded, not followed). Each resolved base/factory/reference carries its resolvedBy';

// ---------------------------------------------------------------- 2. native O11 (catalog; qualified names everywhere)
export function loadO11Native({ cat, version, file } = {}) {
  if (!cat) {
    const dir = path.join(wt, 'kernel', 'catalog');
    file = fs.readdirSync(dir).filter(f => /^model-api-[0-9.]+\.json$/.test(f)).sort().at(-1);
    if (!file) return { available: false };
    cat = readJson(path.join(dir, file)); version = version ?? /model-api-([0-9.]+)\.json/.exec(file)[1]; file = 'kernel/catalog/' + file;
  }
  const interfaces = cat.Interfaces ?? [];
  const byQualified = new Map(interfaces.map(i => [i.Name, i]));
  const byShort = new Map(); for (const i of interfaces) { const s = simple(i.Name); if (!byShort.has(s)) byShort.set(s, []); byShort.get(s).push(i); }
  const idOf = i => `o11:${version}:${i.Name}`;
  const resolve = (typeName, from) => {
    const q = unwrap(typeName); if (byQualified.has(q)) return { status: 'resolved', type: byQualified.get(q), resolvedBy: 'qualified' };
    const s = simple(q); if (!/^I[A-Z]/.test(s)) return { status: 'external', short: s };
    const cands = byShort.get(s) ?? []; if (!cands.length) return { status: 'external', short: s };
    if (cands.length === 1) return { status: 'resolved', type: cands[0], resolvedBy: 'unique' };
    const ns = cands.filter(c => c.Namespace === from.Namespace); if (ns.length === 1) return { status: 'resolved', type: ns[0], resolvedBy: 'same-namespace' };
    return { status: 'ambiguous', short: s, candidates: cands.map(c => c.Name) };
  };
  const factories = new Map();
  for (const c of cat.Creatables ?? []) { if (!factories.has(c.Type)) factories.set(c.Type, []); factories.get(c.Type).push({ factory: c.Parent + '.' + c.Via, resolvedBy: 'qualified', generic: !!c.ViaGeneric }); }
  const referencedBy = new Map(); const referencedByAmbiguous = new Map();
  for (const i of interfaces) for (const p of i.Properties ?? []) {
    if (!p.CanWrite) continue; const inner = unwrap(p.Type); if (!/(^|\.)I[A-Z]/.test(inner)) continue;
    for (const [cand, how] of [[inner, 'direct'], [inner.replace(/Signature$/, ''), 'via-signature']]) {
      if (how === 'via-signature' && cand === inner) continue;
      const r = resolve(cand, i);
      if (r.status === 'resolved') { const k = r.type.Name; if (!referencedBy.has(k)) referencedBy.set(k, []); referencedBy.get(k).push({ by: i.Name + '.' + p.Name, how, resolvedBy: r.resolvedBy }); }
      else if (r.status === 'ambiguous') for (const c of r.candidates) { if (!referencedByAmbiguous.has(c)) referencedByAmbiguous.set(c, []); referencedByAmbiguous.get(c).push({ by: i.Name + '.' + p.Name, how, candidates: r.candidates }); }
    }
  }
  const types = []; const excluded = { descriptor: 0, noRoot: 0 }; const outsideRoot = [];
  for (const i of interfaces) {
    const short = simple(i.Name); const bases = (i.Bases ?? []).filter(b => byQualified.has(b)); const shorts = new Set(bases.map(simple));
    if (/Descriptor$/.test(short)) { excluded.descriptor++; continue; }
    const role = shorts.has('IObject') ? 'object' : shorts.has('IObjectSignature') ? 'signature' : null;
    if (!role) { excluded.noRoot++; outsideRoot.push({ id: idOf(i), platform: 'o11', metadataVersion: version, assembly: null, namespace: i.Namespace, name: i.Name, shortName: short, kindClass: 'outside-object-root', kindBasis: 'the catalog Bases include neither IObject nor IObjectSignature: not a model element' }); continue; }
    const props = i.Properties ?? []; const writable = props.filter(p => p.CanWrite).map(p => p.Name);
    const inherited = []; const seen = new Set(props.map(p => p.Name));
    for (const b of bases) for (const p of byQualified.get(b).Properties ?? []) { if (seen.has(p.Name)) continue; seen.add(p.Name); inherited.push({ name: p.Name, writable: !!p.CanWrite, from: b }); }
    const nameInh = inherited.find(p => p.name === 'Name' && p.writable);
    const family = familyOf(short, i.Namespace); const appFamily = appFamilyOf(short, i.Namespace);
    const isWidget = shorts.has('IWidget') || shorts.has('IWebWidget') || shorts.has('IMobileWidget');
    types.push({ id: idOf(i), platform: 'o11', metadataVersion: version, assembly: null, namespace: i.Namespace, name: i.Name, shortName: short,
      role, roleBasis: 'catalog Bases (already transitive)', family, appFamily, kindClass: null, kindBasis: null, genericFactory: isWidget ? 'CreateWidget<T> (catalog: widget creatables by parent)' : shorts.has('IFlowNode') ? 'CreateNode<T>' : null,
      bases: bases.map(b => ({ type: b, resolvedBy: 'qualified' })), ambiguousBases: [], externalBases: (i.Bases ?? []).filter(b => !byQualified.has(b)).map(simple),
      writableOwn: writable, writableInherited: inherited.filter(p => p.writable).map(p => ({ name: p.name, from: p.from })), propertyCount: props.length + inherited.length, propertyScopeNote: 'own = properties the catalog lists on the interface; inherited = properties listed on its catalog Bases',
      factories: (factories.get(i.Name) ?? []).filter(f => !f.generic), factoriesAmbiguous: [],
      nameWritable: writable.includes('Name') ? 'own' : nameInh ? 'inherited' : 'none', nameWritableFrom: nameInh?.from ?? null, identifierWritable: writable.includes('Identifier') || inherited.some(p => p.name === 'Identifier' && p.writable),
      hasModelObject: null, modelObjectNote: 'the catalog has no method list: Delete() is assumed from the IObject contract', isWidget, flowNode: shorts.has('IFlowNode'),
      referencedBy: (referencedBy.get(i.Name) ?? []).slice(0, 8), referencedByAmbiguous: (referencedByAmbiguous.get(i.Name) ?? []).slice(0, 8) });
  }
  const implementedBy = new Map();
  for (const t of types) for (const b of t.bases) implementedBy.set(b.type, (implementedBy.get(b.type) ?? 0) + 1);
  const inventoriedByShort = new Map(); for (const t of types) inventoriedByShort.set(t.shortName, (inventoriedByShort.get(t.shortName) ?? 0) + 1);
  for (const t of types) { const n = implementedBy.get(t.name) ?? 0; t.implementedBy = n; [t.kindClass, t.kindBasis] = classifyKind(t, n); t.shortNameCandidatesInIndex = byShort.get(t.shortName).length; t.shortNameCandidatesInventoried = inventoriedByShort.get(t.shortName); }
  const collisions = [...byShort].filter(([, v]) => v.length > 1).map(([short, v]) => ({ short, qualified: v.map(c => c.Name), inventoried: types.filter(t => t.shortName === short).map(t => t.id) }));
  return { available: true, platform: 'o11', version, file, studioDir: cat.StudioDir, generatedAt: cat.GeneratedAt, interfaces: interfaces.length, creatables: (cat.Creatables ?? []).length, summary: cat.Summary, kept: types.length, excluded, types, outsideRoot,
    collisions: { shortNamesWithSeveralQualifiedTypes: collisions.length, shortNamesWithSeveralInventoriedTypes: collisions.filter(c => c.inventoried.length > 1).length, list: collisions },
    rule: 'kept: every interface (no de-duplication) whose catalog Bases include OutSystems.Model.IObject (object) or IObjectSignature only (signature); excluded: *Descriptor and interfaces without those roots; names are qualified in the catalog (bases, creatables, property types), so no resolution ambiguity arises except for property types written as short names; the catalog has no method list (Delete/Duplicate assumed from IObject). Identity = platform:metadataVersion:namespace.name (assembly not recorded by the catalog)' };
}

// ---------------------------------------------------------------- 3. kernel: verbs, contracts, type mentions, builder
export function loadVerbTable() {
  const src = fs.readFileSync(path.join(wt, 'kernel', 'src', 'Anvil.Core', 'Kernel', 'VerbSurface.cs'), 'utf8');
  const verbs = {};
  for (const m of src.matchAll(/new\("([a-z]+)", "(write|read)", \[([^\]]*)\], \[([^\]]*)\]/g)) verbs[m[1]] = { kind: m[2], required: [...m[3].matchAll(/"([^"]+)"/g)].map(k => k[1]), optional: [...m[4].matchAll(/"([^"]+)"/g)].map(k => k[1]) };
  return verbs;
}
export async function loadContracts(sources, { noCli = false } = {}) {
  const out = {}; if (noCli || !exists(sources.cli)) return { available: false, reason: noCli ? '--no-cli' : 'ODC CLI not built: ' + sources.cli, namedTypes: {} };
  for (const op of ['agent', 'verbs', 'spec', 'logic', 'screen', 'html', 'html-visual', 'rest', 'rest-consume', 'rest-expose', 'soap', 'entity-actions']) {
    try { const { stdout } = await run('dotnet', [sources.cli, 'api', '--op', op], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, cwd: sources.kernel }); const env = JSON.parse(stdout); out[op] = env.ok ? env.data : { error: env.error }; }
    catch (e) { out[op] = { error: String(e.message).slice(0, 200) }; }
  }
  // Public contract naming a type: the short name appears in the JSON returned by `api --op <op>` (not in source code).
  const namedTypes = {};
  for (const [op, data] of Object.entries(out)) { const text = JSON.stringify(data); for (const m of text.matchAll(/\bI[A-Z][A-Za-z0-9]+\b/g)) (namedTypes[m[0]] = namedTypes[m[0]] ?? new Set()).add(op); }
  return { available: true, cli: path.relative(wt, sources.cli).replaceAll('\\', '/'), contracts: out, namedTypes: Object.fromEntries(Object.entries(namedTypes).map(([t, s]) => [t, [...s]])) };
}
const CONTRACT_FILES = { agent: ['AgentExpander.cs'], spec: ['SpecExpander.cs', 'DataRequirements.cs', 'DataPreflight.cs', 'DataAssertions.cs', 'ModuleSpecification.cs'], logic: ['LogicExpander.cs', 'LogicRequirements.cs', 'LogicNodes.cs', 'LogicOrder.cs'], screen: ['ScreenExpander.cs', 'ScreenModel.cs', 'ScreenContracts.cs', 'ScreenRequirements.cs', 'ScreenSpecification.cs'], html: ['HtmlExpander.cs', 'HtmlComponents.cs', 'HtmlDelta.cs', 'HtmlVisual.cs'], verbs: ['Verbs.cs'] };
export function loadTypeMentions() {
  const mentions = new Map(); const add = (type, source, file) => { if (!mentions.has(type)) mentions.set(type, { expanders: {}, kernelFiles: new Set(), adapters: new Set() }); const m = mentions.get(type); if (source === 'kernel') m.kernelFiles.add(file); else if (source === 'adapter') m.adapters.add(file); else { m.expanders[source] = m.expanders[source] ?? new Set(); m.expanders[source].add(file); } };
  const kernelDir = path.join(wt, 'kernel', 'src', 'Anvil.Core', 'Kernel');
  const scan = (file, cb) => { const text = fs.readFileSync(file, 'utf8'); for (const m of text.matchAll(/"(I[A-Z][A-Za-z0-9]+)"/g)) cb(m[1]); };
  const byFile = new Map(Object.entries(CONTRACT_FILES).flatMap(([c, files]) => files.map(f => [f, c])));
  for (const f of fs.readdirSync(kernelDir).filter(f => f.endsWith('.cs'))) scan(path.join(kernelDir, f), t => { const c = byFile.get(f); add(t, c ?? 'kernel', f); if (c) add(t, 'kernel', f); });
  for (const sub of ['Kernel/Adapter']) { const d = path.join(wt, 'kernel', 'src', 'Anvil.Core', sub); if (exists(d)) for (const f of fs.readdirSync(d).filter(f => f.endsWith('.cs'))) scan(path.join(d, f), t => add(t, 'kernel', sub + '/' + f)); }
  for (const [lane, d] of [['odc', path.join(wt, 'kernel', 'src', 'Anvil.Core.Odc', 'Adapters.ODC')], ['ss11', path.join(wt, 'kernel', 'src', 'Anvil.Core', 'Adapters.SS11')]]) if (exists(d)) for (const f of fs.readdirSync(d).filter(f => f.endsWith('.cs'))) scan(path.join(d, f), t => add(t, 'adapter', lane + ':' + f));
  return Object.fromEntries([...mentions].map(([t, m]) => [t, { expanders: Object.fromEntries(Object.entries(m.expanders).map(([k, v]) => [k, [...v]])), kernelFiles: [...m.kernelFiles], adapters: [...m.adapters] }]));
}
export function loadBuilderPrimitives() {
  const dir = path.join(wt, 'platforms', 'odc', 'studio', 'shared'); const out = {}; let count = 0;
  if (!exists(dir)) return { primitives: 0, byType: out, features: 0 };
  for (const f of fs.readdirSync(dir).filter(f => /^Authoring.*\.cs$/.test(f))) { const text = fs.readFileSync(path.join(dir, f), 'utf8'); for (const m of text.matchAll(/public static (I[A-Za-z]+|T|void|string|bool|int) ([A-Z][A-Za-z]*)(<[^>]*>)?\(/g)) { count++; const type = m[1]; if (!/^I/.test(type)) continue; (out[type] = out[type] ?? []).push(f.replace('.cs', '') + '.' + m[2]); } }
  const features = exists(path.join(wt, 'platforms', 'odc', 'studio', 'builder', 'features')) ? fs.readdirSync(path.join(wt, 'platforms', 'odc', 'studio', 'builder', 'features')).filter(f => f.endsWith('.cs')).length : 0;
  return { primitives: count, byType: out, features };
}

// ---------------------------------------------------------------- 4. descriptor exposure (short names; ODC lane only)
export function loadDescriptor(index) {
  const caps = index.capabilities; const exposure = new Map();
  const mark = (type, cap, how) => { if (!exposure.has(type)) exposure.set(type, { direct: new Set(), viaProofs: new Set() }); exposure.get(type)[how].add(cap); };
  const named = text => [...String(text ?? '').matchAll(/\bI[A-Z][A-Za-z0-9]+\b/g)].map(m => m[0]);
  for (const c of caps) {
    for (const k of c.context?.kinds ?? []) mark('I' + k, c.id, 'direct');
    for (const k of c.context?.signatures ?? []) mark('I' + k, c.id, 'direct');
    for (const t of named([c.summary, c.route?.operation, c.guidance, ...(c.limits ?? []).map(l => l.text)].join(' '))) mark(t, c.id, 'direct');
    for (const job of c.proofs?.[index.lane] ?? []) { const j = index.jobs.find(x => x.name === job); for (const t of Object.keys(j?.types ?? {})) mark(String(t).replace(/^(?!I)/, 'I'), c.id, 'viaProofs'); }
  }
  return { lane: index.lane, capabilities: caps.length, unavailable: (index.unavailable ?? []).length, ids: new Set(caps.map(c => c.id)), index: { shared: index.shared ?? null }, exposure: Object.fromEntries([...exposure].map(([t, e]) => [t, { direct: [...e.direct], viaProofs: [...e.viaProofs] }])),
    rule: 'a short type name is "named by the descriptor" when it appears in context.kinds/signatures or in the summary/route/guidance/limits text of a capability (direct), or when a proof job of the capability created it (viaProofs). The descriptor targets one lane (' + index.lane + '): it is not an exposure on the other platform' };
}

// ---------------------------------------------------------------- 5. evidence: static suites (short names as written in jobs) + executed ledger
export function staticSuiteScan() {
  const suites = { odc: ['tests/jobs-odc', 'tests/jobs-odc-negative'], o11: ['tests/jobs', 'tests/jobs-negative', 'tests/jobs-cold', 'tests/jobs-live'] };
  const out = {};
  for (const [platform, dirs] of Object.entries(suites)) {
    const perType = new Map(); const compact = { agent: 0, spec: 0, logic: 0, screen: 0, html: 0 }; let jobs = 0; let ops = 0;
    const walk = dir => { if (!exists(dir)) return []; return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.json') ? [path.join(dir, e.name)] : [])); };
    for (const dir of dirs) for (const file of walk(path.join(wt, 'kernel', dir))) {
      let job; try { job = readJson(file); } catch { continue; } const list = Array.isArray(job) ? job : job.ops; if (!Array.isArray(list)) continue;
      // The walk reaches the proven examples (tests/jobs-odc/examples, tests/jobs/examples); a blocked example
      // (expectError) proves a refusal, like the negative suites.
      jobs++; const negative = /negative/.test(dir) || job.expectError != null; const alias = new Map(); const name = path.relative(path.join(wt, 'kernel'), file).replaceAll('\\', '/');
      const typeOf = ref => { const s = String(ref ?? ''); if (/^\$[A-Za-z_]\w*$/.test(s)) return alias.get(s) ?? null; const m = /^(I[A-Z][A-Za-z0-9]+):/.exec(s); if (m) return m[1]; if (s === '@espace') return 'IESpace'; return null; };
      const bump = (type, verb, prop) => { if (!type) return; if (!perType.has(type)) perType.set(type, { verbs: {}, negativeVerbs: {}, props: new Set(), jobs: new Set(), negativeJobs: new Set() }); const t = perType.get(type); const bag = negative ? t.negativeVerbs : t.verbs; bag[verb] = (bag[verb] ?? 0) + 1; if (prop && !negative) t.props.add(prop); (negative ? t.negativeJobs : t.jobs).add(name); };
      for (const op of list) {
        if (!op || typeof op !== 'object' || !op.op) continue; ops++;
        if (op.op in compact) { compact[op.op]++; continue; }
        if (op.op === 'create') { const t = String(op.type ?? '').replace(/^(?!I)/, 'I'); if (typeof op.as === 'string') alias.set(op.as, t); bump(t, 'create'); continue; }
        if (op.op === 'set') { bump(typeOf(op.target), 'set', op.prop); continue; }
        if (op.op === 'replace') { bump(typeOf(op.from), 'replace'); continue; }
        if (op.op === 'link') { bump(typeOf(op.from), 'link'); continue; }
        bump(typeOf(op.target), op.op);
      }
    }
    out[platform] = { dirs, jobs, ops, compactOps: compact, perType: Object.fromEntries([...perType].map(([t, v]) => [t, { verbs: v.verbs, negativeVerbs: v.negativeVerbs, props: [...v.props].slice(0, 40), jobs: [...v.jobs].slice(0, 12), jobCount: v.jobs.size, negativeJobs: [...v.negativeJobs] }])),
      rule: 'type = the short name written in the job (create.type, or the Kind of Kind:Name targets, or the alias created earlier in the job); a job in a *negative* suite counts under negativeVerbs/negativeJobs, never as a positive proof; compact-language ops (spec/logic/screen/html) are counted but not attributed to types; the object a create produces may have a more specific kind than the requested name (the ledger records that one)' };
  }
  return out;
}
// The executed ledger of a lane, by short name (every stamped result) and by QUALIFIED interface (results written with
// anvil-coverage-ledger/2, 2026-09-23: the ledger names the interface the object declares, so a proof attributes
// itself without any short-name rule).
export function executedLedger(index) {
  const collect = (entries, key) => { const perType = new Map(); for (const [j, cov] of entries) for (const [type, v] of Object.entries(cov)) { if (!perType.has(type)) perType.set(type, { verbs: new Set(), props: new Set(), jobs: new Set(), current: 0, historical: 0 }); const t = perType.get(type); for (const verb of v.verbs ?? []) t.verbs.add(verb); for (const p of v.props ?? []) t.props.add(p); t.jobs.add(j.name); if (j.executed.current) t.current++; else t.historical++; } return Object.fromEntries([...perType].map(([t, v]) => [t, { verbs: [...v.verbs], props: [...v.props].slice(0, 40), jobs: [...v.jobs], current: v.current, historical: v.historical }])); };
  const jobs = (index?.jobs ?? []).filter(j => j.executed?.coverage);
  return { byShort: collect(jobs.map(j => [j, j.executed.coverage])), byQualified: collect(jobs.filter(j => j.executed.coverageQualified).map(j => [j, j.executed.coverageQualified])), results: jobs.length, qualifiedResults: jobs.filter(j => j.executed.coverageQualified).length, current: jobs.filter(j => j.executed.current).length };
}

// ---------------------------------------------------------------- 6. reader census (ODC fixture; --kind K lists implementers of any interface named IK)
export async function readerCensus(sources, kinds) {
  const { inspect } = await import('./lib.mjs');
  const out = {}; let n = 0;
  for (const kind of kinds) { n++; try { const r = await inspect({ target: sources.fixture, kind, max: 1, properties: 'Name', budget: 4000 }); out[kind] = r.ok ? { count: r.count ?? 0, observed: (r.count ?? 0) > 0 } : { error: String(r.error).slice(0, 120) }; } catch (e) { out[kind] = { error: String(e.message).slice(0, 120) }; } if (n % 50 === 0) process.stderr.write(`census ${n}/${kinds.length}\n`); }
  return out;
}
export function loadCensusFrom(file) {
  const prev = readJson(file);
  if (!prev.census) throw new Error('no census in ' + file);
  const id = prev.sources?.reader?.census ?? {};
  return { data: prev.census, identity: { reusedFrom: path.relative(wt, file).replaceAll('\\', '/'), generatedAt: prev.generatedAt, fixture: id.fixture ?? null, fixtureSha256: id.fixtureSha256 ?? null, kinds: Object.keys(prev.census).length, previousIdentity: id.reusedFrom ? id : undefined, note: 'census reused from a previous run (same fixture identity declared here); kinds absent from that run have no census' } };
}

// ---------------------------------------------------------------- 7. operational boundary
export function loadOperationalBoundary() {
  const facade = path.join(wt, 'platforms', 'odc', 'facade'); const tools = [];
  for (const f of ['mcp.mjs', 'ssam.mjs', 'debug.mjs']) { const text = exists(path.join(facade, f)) ? fs.readFileSync(path.join(facade, f), 'utf8') : ''; for (const m of text.matchAll(/registerTool\('([a-z_0-9]+)'/g)) tools.push({ tool: m[1], file: f }); }
  const classify = t => (/^(studio_inspect|ssam_map|ssam_discover|ssam_job|o11_job|studio_build)$/.test(t) ? 'model' : /^(studio_deliver|studio_check_base|studio_preview|studio_merge|studio_authorize|studio_publish|studio_manifest|studio_snapshot|studio_latest)$/.test(t) ? 'delivery' : /data/.test(t) ? 'data' : /portal|odc_/.test(t) ? 'portal' : 'operations');
  return { rule: 'model = reads or changes the module model headless (inspect, job, discover, feature build); delivery = snapshot/candidate/merge/publish of a module; data = development database records; portal = ODC Portal APIs; operations = Studio session, diagnostics, URLs, tenants', tools: tools.map(t => ({ ...t, class: classify(t.tool) })) };
}

// ---------------------------------------------------------------- cells: metadata, route, proven, status
export const METADATA_RULES = {
  read: 'any inventoried interface: the reader lists objects by interface name (--kind matches implementers, inclusive for base interfaces); signatures are readable as referenced definitions',
  address: 'same as read: Kind:Name addressing resolves any interface name (Verbs.Implements matches short or full name)',
  usages: 'suggests when a writable property of another inventoried interface has the type (or its *Signature) as value type; consumers through expressions/text are invisible in metadata (no-basis, not negative)',
  create: 'suggests when a Create* method (ODC) / catalog Creatable (O11) returns exactly this type; suggests-generic for widgets (CreateWidget<T>, the parent decides); ambiguous when the factory return type is a short name shared by several types; context-excluded for referenced signatures (created in the producer module); otherwise no-basis',
  set: 'suggests when the interface declares a writable property; suggests-inherited when only inherited writable properties exist; context-excluded for referenced signatures even when their metadata lists writable properties (the consumer module cannot edit a referenced definition); no-basis otherwise',
  rename: 'suggests when Name is writable on the interface itself; suggests-inherited when Name is inherited; no-basis when Name is not writable (a writable Identifier is recorded as a precondition, not as rename); context-excluded for signatures. Writable Name does not by itself prove rename: the verb also refuses name clashes',
  replace: 'as usages (replace swaps references to a referenceable type)',
  move: 'suggests-inherited for model objects (IObject: a position in the parent ISequence / flow node position); it does not mean every context allows moving; context-excluded for signatures',
  duplicate: 'suggests-inherited for model objects (IObject.Duplicate inherited); the platform may refuse for some kinds; context-excluded for signatures',
  delete: 'suggests-inherited when IModelObject.Delete() is in the resolved closure (ODC) or assumed from IObject (O11, no method list); inherited Delete does not mean deletion is allowed (consumers block it unless force); context-excluded for signatures',
};
export function metadataFor(t, op) {
  const sig = t.role === 'signature';
  const excluded = why => ({ status: 'context-excluded', basis: why, sources: ['role signature'] });
  switch (op) {
    case 'read': case 'address': return { status: 'suggests', basis: sig ? 'referenced definition: readable through Reference:* and as property value' : t.kindClass === 'base-interface' ? '--kind on a base interface lists its implementers (inclusive)' : 'model object: the reader lists any kind by interface name', sources: ['reader'] };
    case 'usages': case 'replace':
      if (t.referencedBy.length) return { status: 'suggests', basis: 'value type of writable property: ' + t.referencedBy.slice(0, 3).map(r => r.by + (r.how === 'via-signature' ? ' (as signature)' : '')).join(', '), sources: t.referencedBy.slice(0, 3).map(r => r.by) };
      if (t.referencedByAmbiguous.length) return { status: 'ambiguous', basis: 'property types name the short name shared by several types: ' + t.referencedByAmbiguous.slice(0, 2).map(r => r.by).join(', '), sources: t.referencedByAmbiguous.slice(0, 3).map(r => r.by), missing: 'qualified property type (metadata writes short names)' };
      return { status: 'no-basis', basis: 'no writable property of another inventoried interface names this type or its signature', missing: 'consumers through expressions/text are not visible in metadata; only the usages verb on a real module can tell', sources: [] };
    case 'create':
      if (sig) return excluded('a referenced definition is created in its producer module, not in the consumer');
      if (t.factories.length) return { status: 'suggests', basis: 'factory returning the type: ' + t.factories.slice(0, 3).map(f => f.factory).join(', '), sources: t.factories.slice(0, 3).map(f => f.factory) };
      if (t.factoriesAmbiguous.length) return { status: 'ambiguous', basis: 'factory return type is a short name shared by several types: ' + t.factoriesAmbiguous.slice(0, 2).map(f => f.factory).join(', '), sources: t.factoriesAmbiguous.slice(0, 2).map(f => f.factory), missing: 'qualified return type; the kernel resolves it by rank (Verbs.cs FindCreateCore) at execution time' };
      if (t.genericFactory && t.role === 'object' && t.kindClass !== 'base-interface') return { status: 'suggests-generic', basis: `generic factory ${t.genericFactory} (the parent decides which ${t.isWidget ? 'widgets' : 'nodes'} it accepts)`, sources: [t.genericFactory] };
      return { status: 'no-basis', basis: 'no factory returns this type' + (t.kindClass === 'base-interface' ? ' (base interface: its implementers have their own factories)' : ''), missing: 'a factory or a proof that the platform creates it', sources: [] };
    case 'set':
      if (sig) return excluded(`metadata lists ${t.writableOwn.length + t.writableInherited.length} writable propert(y/ies), but a consumer module cannot edit a referenced definition`);
      if (t.writableOwn.length) return { status: 'suggests', basis: `${t.writableOwn.length} writable propert(y/ies) declared on the interface` + (t.writableInherited.length ? ` + ${t.writableInherited.length} inherited` : ''), sources: t.writableOwn.slice(0, 6) };
      if (t.writableInherited.length) return { status: 'suggests-inherited', basis: `${t.writableInherited.length} writable propert(y/ies) inherited only (${[...new Set(t.writableInherited.map(w => simple(w.from)))].slice(0, 3).join(', ')})`, sources: t.writableInherited.slice(0, 6).map(w => w.name + '<' + simple(w.from)) };
      return { status: 'no-basis', basis: 'no writable property', missing: 'nothing to set through metadata', sources: [] };
    case 'rename':
      if (sig) return excluded('a referenced definition is renamed in its producer module');
      if (t.nameWritable === 'own') return { status: 'suggests', basis: 'Name writable on the interface (rename still refuses name clashes in scope)', sources: ['Name'] };
      if (t.nameWritable === 'inherited') return { status: 'suggests-inherited', basis: 'Name writable, inherited from ' + simple(t.nameWritableFrom), sources: ['Name<' + simple(t.nameWritableFrom)] };
      return { status: 'no-basis', basis: 'Name is not a writable property' + (t.identifierWritable ? '; Identifier is writable (a record is renamed by setting Identifier, see known limits)' : ''), missing: 'a rename path other than Name', sources: t.identifierWritable ? ['Identifier'] : [] };
    case 'move':
      if (sig) return excluded('a referenced definition has no position in the consumer module');
      return t.role === 'object' ? { status: 'suggests-inherited', basis: t.flowNode ? 'IObject (inherited): position in the parent sequence; flow node: x/y position' : 'IObject (inherited): position in the parent ISequence only', sources: ['IObject'], preconditions: ['parent must be an ISequence (or a flow for nodes)'] } : { status: 'no-basis', basis: 'role ' + t.role, missing: 'role', sources: [] };
    case 'duplicate':
      if (sig) return excluded('a referenced definition is not duplicated in the consumer module');
      return t.role === 'object' ? { status: 'suggests-inherited', basis: 'IObject.Duplicate (inherited); the platform may refuse for some kinds', sources: ['IObject'] } : { status: 'no-basis', basis: 'role ' + t.role, missing: 'role', sources: [] };
    case 'delete':
      if (sig) return excluded('a referenced definition is deleted in its producer module; the consumer removes the reference');
      if (t.platform === 'odc') return t.hasModelObject ? { status: 'suggests-inherited', basis: 'IModelObject.Delete() inherited; consumers block it unless force', sources: ['IModelObject'], preconditions: ['no consumers, or force'] } : { status: 'no-basis', basis: 'IModelObject not in the resolved closure', missing: 'Delete() in the closure', sources: [] };
      return t.role === 'object' ? { status: 'suggests-inherited', basis: 'assumed from the IObject contract (the O11 catalog has no method list)', sources: ['IObject (assumed)'], preconditions: ['no consumers, or force'] } : { status: 'no-basis', basis: 'role ' + t.role, missing: 'role', sources: [] };
    default: return { status: 'no-basis', basis: '', sources: [] };
  }
}
const OP_VERB = { read: ['get', 'dump', 'find'], address: ['get'], usages: ['usages'], create: ['create'], set: ['set', 'link'], rename: ['rename'], replace: ['replace'], move: ['move'], duplicate: ['duplicate'], delete: ['delete'] };
const OP_CAP = { rename: ['refactor.rename'], replace: ['refactor.replace'], move: ['refactor.move'], duplicate: ['refactor.duplicate'], delete: ['refactor.delete'], usages: ['refactor.delete', 'read.inspect'], read: ['read.inspect'], address: ['read.inspect'] };
export function routeFor(t, op, ctx) {
  const m = ctx.mentions[t.shortName] ?? { expanders: {}, kernelFiles: [], adapters: [] };
  const named = ctx.contracts?.namedTypes?.[t.shortName] ?? [];
  if (op === 'read' || op === 'address') return { kind: 'reader', verbs: OP_VERB[op].filter(v => ctx.verbs[v]), entries: t.platform === 'odc' ? ['studio_inspect {target, kind|name|select}'] : ['o11_inspect {oml, kind|name|select} (shares SnapshotReading; not run in this checkout)'], publicContractsNamingType: named, codeMentions: m.kernelFiles.slice(0, 4), builderPrimitives: [] };
  const verbs = OP_VERB[op].filter(v => ctx.verbs[v]);
  const builder = op === 'create' && t.platform === 'odc' ? (ctx.builder.byType[t.shortName] ?? []).slice(0, 3) : [];
  const kind = verbs.length ? (named.length ? 'generic-verb+contract' : 'generic-verb') : named.length ? 'contract' : 'none';
  return { kind, verbs, publicContractsNamingType: named, codeMentions: m.kernelFiles.slice(0, 4), builderPrimitives: builder };
}
export const ROUTE_RULE = 'reader = read/address through inspect (--kind/--name/--select); generic-verb = the verb table accepts the verb for any model object (a route for the kind, not a proof for the type); +contract = the JSON of api --op names the short name; contract = named without a generic verb; none = no verb covers the operation. codeMentions (expander source literals) and builderPrimitives (C# Authoring*.cs, ODC create) are hints, not public contracts';
export function provenFor(t, op, ctx) {
  const att = ctx.attribute[t.platform](t.shortName, { op }); let attributed = att.id === t.id;
  const out = { attribution: att.attribution, attributedToThisType: attributed, shortName: t.shortName, candidates: att.candidates.length > 1 ? att.candidates : undefined, attributedTo: att.id && !attributed ? att.id : undefined };
  const lane = ctx.ledger[t.platform];
  // A result written with the qualified ledger attributes itself to this exact type: no short-name rule involved.
  const ledQ = lane?.byQualified?.[t.name];
  if (ledQ) { const ev = OP_VERB[op].filter(v => ledQ.verbs.includes(v)); if (ev.length) { out.executed = { verbs: ev, jobs: ledQ.jobs, current: ledQ.current, historical: ledQ.historical, props: op === 'set' ? ledQ.props.slice(0, 20) : undefined, qualified: true }; out.attribution = 'ledger-qualified'; out.attributedToThisType = attributed = true; delete out.attributedTo; } }
  const led = !out.executed ? lane?.byShort?.[t.shortName] : null;
  if (led) { const ev = OP_VERB[op].filter(v => led.verbs.includes(v)); if (ev.length) out.executed = { verbs: ev, jobs: led.jobs, current: led.current, historical: led.historical, props: op === 'set' ? led.props.slice(0, 20) : undefined, qualified: false }; }
  const stat = ctx.statics[t.platform]?.perType?.[t.shortName];
  if (stat) {
    const ev = OP_VERB[op].filter(v => stat.verbs[v]); if (ev.length) out.static = { verbs: Object.fromEntries(ev.map(v => [v, stat.verbs[v]])), jobs: stat.jobs, jobCount: stat.jobCount, props: op === 'set' ? stat.props.slice(0, 20) : undefined };
    const neg = OP_VERB[op].filter(v => stat.negativeVerbs[v]); if (neg.length) out.negative = { verbs: Object.fromEntries(neg.map(v => [v, stat.negativeVerbs[v]])), jobs: stat.negativeJobs };
  }
  if ((op === 'read' || op === 'address') && t.platform === 'odc' && ctx.census) { const c = ctx.census[t.shortName.replace(/^I/, '')]; if (c) out.census = { ...c, inclusive: t.kindClass === 'base-interface' ? 'count includes implementers of the base interface' : undefined }; }
  const limits = ctx.limitFor(t.shortName); if (limits.length) out.knownLimits = limits.map(l => ({ title: l.title, type: l.type, verdict: l.verdict, source: l.source }));
  // A documented refusal counts only when its title names this exact short name and the verb of the operation.
  const refusal = limits.filter(l => l.type === 'recusa-da-plataforma' && new RegExp('\\b' + t.shortName + '\\b').test(l.title) && new RegExp('\\b(' + OP_VERB[op].join('|') + ')\\b', 'i').test(l.title));
  if (refusal.length) out.refusal = refusal.map(l => l.title);
  return out;
}
export function statusFor(metadata, route, proven) {
  const positive = proven.attributedToThisType && (proven.executed || proven.static || (proven.census && proven.census.count > 0));
  if (metadata.status === 'context-excluded') return { status: 'context-excluded', basis: metadata.basis };
  if (proven.attributedToThisType && proven.executed) return { status: 'tested-executed', basis: 'ODC ledger (current stamps): ' + proven.executed.verbs.join('/') + ' in ' + proven.executed.jobs.length + ' job(s)' + (proven.attribution !== 'exact' ? ' [attribution ' + proven.attribution + ']' : '') };
  if (proven.attributedToThisType && proven.census && proven.census.count > 0) return { status: 'tested-executed', basis: 'reader census: ' + proven.census.count + ' object(s) in the fixture' + (proven.attribution !== 'exact' ? ' [attribution ' + proven.attribution + ']' : '') };
  if (proven.attributedToThisType && proven.static) return { status: 'tested-static', basis: 'job(s) in a positive suite name the type for this verb (execution not stamped): ' + proven.static.jobs.slice(0, 3).join(', ') + (proven.attribution !== 'exact' ? ' [attribution ' + proven.attribution + ']' : '') };
  if (!positive && (proven.refusal || (proven.negative && proven.attributedToThisType))) return { status: 'refused-proven', basis: proven.refusal ? 'platform refusal documented: ' + proven.refusal.join(' | ') : 'negative job(s): ' + proven.negative.jobs.slice(0, 3).join(', ') };
  const evidenceUnattributed = (proven.executed || proven.static || (proven.census && proven.census.count > 0)) && !proven.attributedToThisType;
  if (evidenceUnattributed) return { status: 'undetermined', basis: 'evidence exists under the short name but is ' + (proven.attribution === 'ambiguous' ? 'ambiguous among ' + proven.candidates.length + ' qualified types' : 'attributed to ' + proven.attributedTo), missing: proven.attribution === 'ambiguous' ? 'the ledger/jobs record short names; the qualified type executed is not recorded' : 'evidence for this qualified type specifically' };
  if (['suggests', 'suggests-inherited', 'suggests-generic'].includes(metadata.status)) return route.kind === 'none' ? { status: 'suggested-only', basis: metadata.basis, missing: 'no route in SSAM' } : { status: 'route-only', basis: 'metadata ' + metadata.status + ' (' + metadata.basis + '); route ' + route.kind + '; no proof for this type', missing: 'a positive job or ledger entry for this qualified type' };
  if (metadata.status === 'ambiguous') return { status: 'undetermined', basis: metadata.basis, missing: metadata.missing };
  return { status: 'undetermined', basis: metadata.basis, missing: metadata.missing ?? 'no basis in metadata and no proof' };
}
export function buildMatrix({ native, verbs, mentions, builder, limits, descriptors, ledger, statics, census, contracts }) {
  const rows = [];
  const limitFor = name => limits.filter(l => new RegExp('\\b' + name + '\\b|\\b' + name.replace(/^I/, '') + '\\b').test(l.title + ' ' + (l.seenAt ?? '')));
  const attribute = { odc: attributor(native.odc?.types ?? []), o11: attributor(native.o11?.types ?? []) };
  const ctx = { verbs, mentions, builder, contracts, ledger, statics, census, limitFor, attribute };
  for (const platform of ['odc', 'o11']) {
    // Each lane has its own descriptor index (the O11 one exists since the phase-2 pilot: shared capabilities only).
    const descriptor = descriptors[platform] ?? null; const other = descriptors[platform === 'odc' ? 'o11' : 'odc'] ?? null;
    for (const t of native[platform]?.types ?? []) {
      const expAtt = attribute[platform](t.shortName); const exp = descriptor ? (descriptor.exposure[t.shortName] ?? null) : null;
      const exposure = exp ? { capabilities: [...new Set([...exp.direct, ...exp.viaProofs])], attribution: expAtt.attribution, attributedToThisType: expAtt.id === t.id, candidates: expAtt.candidates.length > 1 ? expAtt.candidates : undefined } : null;
      const reuse = other?.exposure?.[t.shortName] ? { sameShortNameInDescriptor: [...new Set([...other.exposure[t.shortName].direct, ...other.exposure[t.shortName].viaProofs])], lane: other.lane } : null;
      for (const op of OPS) {
        const metadata = metadataFor(t, op); const route = routeFor(t, op, ctx); const proven = provenFor(t, op, ctx); const st = statusFor(metadata, route, proven);
        const preconditions = [...(metadata.preconditions ?? [])];
        if (op === 'delete' && metadata.status !== 'context-excluded' && metadata.status !== 'no-basis') preconditions.push('no consumers (usages), or force');
        if (op === 'rename' && metadata.status !== 'context-excluded' && metadata.status !== 'no-basis') preconditions.push('no name clash in scope');
        if (t.appFamily === 'web' && platform === 'odc') preconditions.push('web-tagged type on ODC: relevant only as a base interface implemented by CrossDevice objects (see census)');
        rows.push({ platform, id: t.id, type: t.name, shortName: t.shortName, family: t.family, appFamily: t.appFamily, kindClass: t.kindClass, role: t.role, op,
          metadata: { status: metadata.status, basis: metadata.basis, sources: metadata.sources, missing: metadata.missing }, preconditions, route, proven,
          exposure: descriptor ? { ...(exposure ?? { capabilities: [], attribution: 'none' }), ...(reuse ? { reusePotential: reuse } : {}) } : { effective: false, reusePotential: reuse }, opCapabilities: descriptor ? (OP_CAP[op] ?? []).filter(id => descriptor.ids.has(id)) : [],
          status: st.status, statusBasis: st.basis, missing: st.missing });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------- correspondence ODC ↔ O11 (three levels, none verified)
export function correspondence(native) {
  const odc = native.odc?.types ?? []; const o11 = native.o11?.types ?? [];
  const o11ByShort = new Map(); for (const t of o11) { if (!o11ByShort.has(t.shortName)) o11ByShort.set(t.shortName, []); o11ByShort.get(t.shortName).push(t); }
  const o11ByQualified = new Map(o11.map(t => [t.name, t]));
  const sameShort = new Set(); let pairs = 0; let oneToOne = 0; const sameQualified = []; const sameQualifiedSameWritable = [];
  for (const t of odc) { const m = o11ByShort.get(t.shortName); if (!m) continue; sameShort.add(t.shortName); pairs += m.length; if (m.length === 1 && odc.filter(x => x.shortName === t.shortName).length === 1) oneToOne++;
    const q = o11ByQualified.get(t.name); if (q) { sameQualified.push([t.id, q.id]); const a = new Set([...t.writableOwn, ...t.writableInherited.map(w => w.name)]); const b = new Set(q.writableOwn); if (a.size === b.size && [...a].every(x => b.has(x))) sameQualifiedSameWritable.push([t.id, q.id]); } }
  return {
    levels: {
      sameShortName: { shortNames: sameShort.size, odcO11Pairs: pairs, oneToOnePairs: oneToOne, meaning: 'the same short name exists on both platforms (possibly in several namespaces each); a naming coincidence, not a contract' },
      sameQualifiedName: { pairs: sameQualified.length, meaning: 'same namespace.name on both platforms: a correspondence CANDIDATE; the contract (properties, factories, behaviour) is not verified by this level' },
      sameQualifiedNameAndSameWritableProperties: { pairs: sameQualifiedSameWritable.length, meaning: 'metadata-level agreement of the writable property names (ODC own+inherited vs O11 catalog list, whose inheritance scope is not recorded); still not a proof of behaviour' },
      verifiedContractEquivalence: { pairs: 0, meaning: 'requires a positive proof of the same operation with the same contract on both platforms; O11 has no executed ledger in this checkout, so nothing is verified' },
    },
    sameQualifiedPairs: sameQualified, sameQualifiedSameWritablePairs: sameQualifiedSameWritable,
  };
}

// ---------------------------------------------------------------- counts (separate denominators; metric names say what was measured)
export function counts(rows, native, { descriptors, censusIdentity, ledger } = {}) {
  const out = {};
  for (const platform of ['odc', 'o11']) {
    const all = rows.filter(r => r.platform === platform); if (!all.length) continue;
    const descriptor = descriptors?.[platform] ?? null; const lane = ledger?.[platform];
    const types = native[platform].types; const ids = t => new Set(t.map(x => x.id)).size;
    const byKind = Object.fromEntries(KIND_CLASSES.map(k => [k, ids(types.filter(t => t.kindClass === k))]));
    const byApp = Object.fromEntries(['shared', 'reactive', 'web'].map(k => [k, ids(types.filter(t => t.appFamily === k))]));
    const byKindApp = Object.fromEntries(KIND_CLASSES.map(k => [k, Object.fromEntries(['shared', 'reactive', 'web'].map(a => [a, ids(types.filter(t => t.kindClass === k && t.appFamily === a))]))]));
    const perType = pred => ids(all.filter(pred).map(r => ({ id: r.id })));
    const attributedCounts = pred => ({ ledgerQualified: perType(r => pred(r) && r.proven.attribution === 'ledger-qualified'), exact: perType(r => pred(r) && r.proven.attribution === 'exact'), moduleContext: perType(r => pred(r) && r.proven.attribution === 'module-context'), kernelRank: perType(r => pred(r) && r.proven.attribution === 'kernel-rank'), ambiguousShortName: perType(r => pred(r) && r.proven.attribution === 'ambiguous'), attributedToAnotherQualifiedType: perType(r => pred(r) && r.proven.attributedTo) });
    const hasExecuted = r => !!r.proven.executed; const hasStatic = r => !!r.proven.static; const hasCensus = r => r.op === 'read' && r.proven.census && r.proven.census.count > 0;
    const perOp = {};
    for (const op of OPS) {
      const orows = all.filter(r => r.op === op);
      perOp[op] = { types: orows.length, byStatus: Object.fromEntries(STATUSES.map(s => [s, orows.filter(r => r.status === s).length])), byStatusConcreteAuthorable: Object.fromEntries(STATUSES.map(s => [s, orows.filter(r => r.status === s && r.kindClass === 'concrete-authorable').length])), metadataSuggests: orows.filter(r => /^suggests/.test(r.metadata.status)).length, metadataSuggestsOwn: orows.filter(r => r.metadata.status === 'suggests').length, metadataInheritedOnly: orows.filter(r => r.metadata.status === 'suggests-inherited').length, metadataAmbiguous: orows.filter(r => r.metadata.status === 'ambiguous').length, metadataNoBasis: orows.filter(r => r.metadata.status === 'no-basis').length, contextExcluded: orows.filter(r => r.metadata.status === 'context-excluded').length, evidenceUnattributed: orows.filter(r => (r.proven.executed || r.proven.static) && !r.proven.attributedToThisType).length };
    }
    const byFamily = {};
    for (const fam of [...new Set(types.map(t => t.family))].sort()) { const ft = types.filter(t => t.family === fam); byFamily[fam] = { types: ft.length, byKindClass: Object.fromEntries(KIND_CLASSES.map(k => [k, ft.filter(t => t.kindClass === k).length])), typesWithAnyTestedExecuted: perType(r => r.family === fam && r.status === 'tested-executed' && r.op !== 'read' && r.op !== 'address'), typesWithAnyTestedStatic: perType(r => r.family === fam && r.status === 'tested-static'), typesNamedInDescriptor: descriptor ? perType(r => r.family === fam && r.exposure.capabilities?.length && r.exposure.attributedToThisType) : null, typesObservedInFixture: platform === 'odc' ? perType(r => r.family === fam && hasCensus(r) && r.proven.attributedToThisType) : null, evidenceOnlyByAmbiguousShortName: perType(r => r.family === fam && (r.proven.executed || r.proven.static) && r.proven.attribution === 'ambiguous') }; }
    out[platform] = {
      identity: { metadataVersion: native[platform].version, installedStudio: native[platform].installedStudio ?? null, note: platform === 'odc' ? `ODC metadata ${native[platform].version} (reflection index) against the installed Studio ${native[platform].installedStudio ?? '?'}: the inventory is not complete for the installed version` : 'O11 catalog ' + native[platform].version },
      denominators: { inventoried: types.length, byKindClass: byKind, byAppFamilyTag: byApp, byKindClassAndAppFamily: byKindApp, shortNameCollisionsInIndex: native[platform].collisions.shortNamesWithSeveralQualifiedTypes, shortNameCollisionsInventoried: native[platform].collisions.shortNamesWithSeveralInventoriedTypes, rule: native[platform].rule, kindClassRule: KIND_CLASS_RULE, appFamilyRule: APP_FAMILY_RULE, attributionRule: ATTRIBUTION_RULE },
      typesNamedInPublicContract: { count: perType(r => r.route.publicContractsNamingType?.length), note: 'short name appears in the JSON returned by api --op (spec/logic/screen/html/html-visual); a mention in expander source code is recorded separately as route.codeMentions and is not a public contract', shortNameNote: 'contract naming is by short name; attributed to every qualified type with that short name (the contracts do not qualify names)' },
      typesMentionedInExpanderCode: perType(r => r.route.codeMentions?.length),
      descriptor: descriptor ? { typesNamedByDescriptor: attributedCounts(r => r.exposure.capabilities?.length), typesNamedByDescriptorAttributed: perType(r => r.exposure.capabilities?.length && r.exposure.attributedToThisType), capabilities: descriptor.capabilities, shared: descriptor.shared ?? null, note: 'exposure counted only when the descriptor of lane ' + descriptor.lane + ' names the short name AND the attribution rule assigns it to this qualified type' + (descriptor.shared ? '; on this lane the descriptor holds the shared capabilities projected for it (' + descriptor.shared.join(', ') + ')' : ''), reusePotential: { typesWithSameShortNameInTheOtherLaneDescriptor: perType(r => r.exposure.reusePotential), note: 'same short name as a type named by the other lane\'s descriptor: reuse potential, not exposure' } } : { effectiveExposure: 0, basis: 'no descriptor index for this lane', reusePotential: { typesWithSameShortNameAsDescriptorTypes: perType(r => r.exposure.reusePotential), note: 'reuse potential (same short name as a type named by the other lane descriptor), NOT exposure and NOT proof on this platform' } },
      executedProof: lane?.results ? { typesWithLedgerEntryForAnyOp: attributedCounts(hasExecuted), results: lane.results, current: lane.current, qualifiedResults: lane.qualifiedResults, note: platform === 'odc' ? 'ODC ledger of the suite jobs; counted per attribution level (ledger-qualified = the result names the interface)' : 'O11 ledger of the jobs stamped by JobTests (tests/provenance-o11.json); counted per attribution level' } : { typesWithLedgerEntryForAnyOp: null, note: 'no stamped results for this lane in this checkout' },
      staticProof: { typesWithPositiveJobForAnyOp: attributedCounts(hasStatic), typesWithNegativeJobOnly: perType(r => r.proven.negative && !r.proven.static && !r.proven.executed), note: 'positive suites only; the type name as written in the job; negative suites counted separately' },
      census: platform === 'odc' ? { typesObservedInFixture: attributedCounts(hasCensus), baseInterfacesObservedThroughImplementers: perType(r => hasCensus(r) && r.kindClass === 'base-interface'), identity: censusIdentity ?? null, note: '--kind K counts objects implementing any interface named IK (inclusive); a kind absent from the fixture is not unreadable' } : { typesObservedInFixture: null, note: 'O11 reader not run (O11 CLI not built in this checkout)' },
      perOp, byFamily,
    };
  }
  return out;
}

// ---------------------------------------------------------------- README (human view)
function renderReadme({ inventory, summary, rows, boundary, corr, censusMode }) {
  const L = ['# Inventário de cobertura — fase 1 (gerado; correção de identidade e estatutos)', '', `Gerado em ${inventory.generatedAt} por \`node platforms/odc/facade/coverage-inventory.mjs${censusMode}\` em ${inventory.elapsedMs} ms. Fontes, regras e exclusões em \`inventory.json.sources\`; matriz completa em \`matrix.json\` / \`matrix.csv\` (${rows.length} linhas = tipo qualificado × operação × plataforma). Estatutos por célula: ${STATUSES.join(', ')}. Nenhum percentual global.`, ''];
  for (const platform of ['odc', 'o11']) {
    const s = summary[platform]; if (!s) continue; const d = s.denominators;
    L.push(`## ${platform.toUpperCase()} — ${s.identity.note}`, '', `Inventariados: ${d.inventoried} tipos qualificados (${d.shortNameCollisionsInIndex} nomes curtos partilhados por mais de um tipo qualificado no índice nativo; ${d.shortNameCollisionsInventoried} entre os inventariados). Denominadores separados por classe: ${KIND_CLASSES.map(k => `${k} ${d.byKindClass[k]}`).join(', ')}; por etiqueta de família de aplicação: ${Object.entries(d.byAppFamilyTag).map(([k, v]) => `${k} ${v}`).join(', ')} (etiqueta, não exclusão).`, '', `Regra de inventário: ${d.rule}`, '', `Regra de classe: ${d.kindClassRule}`, '', `Regra de atribuição de evidência por nome curto: ${d.attributionRule}`, '');
    const ac = c => c ? `ledger-qualificado ${c.ledgerQualified ?? 0}, exato ${c.exact}, contexto-módulo ${c.moduleContext}, rank-kernel ${c.kernelRank}, ambíguo ${c.ambiguousShortName}` : 'n/a';
    L.push('| Dimensão | Contagem (por atribuição) | Denominador | O que foi medido |', '|---|---|---:|---|',
      `| Nomeados num contrato público (api --op) | ${s.typesNamedInPublicContract.count} | ${d.inventoried} | ${s.typesNamedInPublicContract.note} |`,
      `| Mencionados no código dos expansores | ${s.typesMentionedInExpanderCode} | ${d.inventoried} | menção em código ≠ contrato público |`,
      s.descriptor.typesNamedByDescriptor ? `| Nomeados pelo descritor da faixa (${s.descriptor.capabilities} capacidades${s.descriptor.shared ? ', partilhadas: ' + s.descriptor.shared.join(', ') : ''}) | ${ac(s.descriptor.typesNamedByDescriptor)}; atribuídos a este tipo ${s.descriptor.typesNamedByDescriptorAttributed}; potencial de reutilização (nome curto no descritor da outra faixa) ${s.descriptor.reusePotential.typesWithSameShortNameInTheOtherLaneDescriptor} | ${d.inventoried} | ${s.descriptor.note} |` : `| Exposição efetiva na descoberta | ${s.descriptor.effectiveExposure} | ${d.inventoried} | ${s.descriptor.basis} |`,
      s.executedProof.typesWithLedgerEntryForAnyOp ? `| Prova executada (ledger, qualquer op; resultados ${s.executedProof.results}, atuais ${s.executedProof.current}, com ledger qualificado ${s.executedProof.qualifiedResults}) | ${ac(s.executedProof.typesWithLedgerEntryForAnyOp)} | ${d.inventoried} | ${s.executedProof.note} |` : `| Prova executada (ledger) | n/a | ${d.inventoried} | ${s.executedProof.note} |`,
      `| Prova estática (job positivo, qualquer op) | ${ac(s.staticProof.typesWithPositiveJobForAnyOp)}; só job negativo ${s.staticProof.typesWithNegativeJobOnly} | ${d.inventoried} | ${s.staticProof.note} |`,
      platform === 'odc' ? `| Observados na fixture (censo do leitor) | ${ac(s.census.typesObservedInFixture)}; interfaces base observadas via implementadores ${s.census.baseInterfacesObservedThroughImplementers} | ${d.inventoried} | ${s.census.note}${s.census.identity?.reusedFrom ? ' — censo reutilizado de ' + s.census.identity.reusedFrom + ' (' + s.census.identity.generatedAt + ', fixture ' + s.census.identity.fixture + ')' : ''} |` : `| Observados na fixture | n/a | ${d.inventoried} | ${s.census.note} |`, '');
    L.push('| Operação | Tipos | Metadados sugerem (próprio / só herdado / genérico) | Ambíguo | Sem base | Excluído por contexto | Testado (executado) | Testado (estático) | Só rota | Recusa provada | Indeterminado | Evidência não atribuída |', '|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const op of OPS) { const o = s.perOp[op]; const b = o.byStatus; L.push(`| ${op} | ${o.types} | ${o.metadataSuggestsOwn} / ${o.metadataInheritedOnly} / ${o.metadataSuggests - o.metadataSuggestsOwn - o.metadataInheritedOnly} | ${o.metadataAmbiguous} | ${o.metadataNoBasis} | ${o.contextExcluded} | ${b['tested-executed']} | ${b['tested-static']} | ${b['route-only']} | ${b['refused-proven']} | ${b.undetermined} | ${o.evidenceUnattributed} |`); }
    L.push('', 'Mesma tabela restrita aos tipos concrete-authorable (estatuto por célula):', '', '| Operação | Testado (executado) | Testado (estático) | Só rota | Recusa provada | Indeterminado |', '|---|---:|---:|---:|---:|---:|');
    for (const op of OPS) { const b = s.perOp[op].byStatusConcreteAuthorable; L.push(`| ${op} | ${b['tested-executed']} | ${b['tested-static']} | ${b['route-only']} | ${b['refused-proven']} | ${b.undetermined} |`); }
    L.push('', '| Família | Tipos | concrete / base / signature / undetermined | Com prova executada (op de escrita) | Com prova estática | Nomeados pelo descritor (atribuídos) | Na fixture (atribuídos) | Evidência só por nome curto ambíguo |', '|---|---:|---|---:|---:|---:|---:|---:|');
    for (const [fam, f] of Object.entries(s.byFamily)) L.push(`| ${fam} | ${f.types} | ${KIND_CLASSES.map(k => f.byKindClass[k]).join(' / ')} | ${f.typesWithAnyTestedExecuted} | ${f.typesWithAnyTestedStatic} | ${f.typesNamedInDescriptor ?? 'n/a'} | ${f.typesObservedInFixture ?? 'n/a'} | ${f.evidenceOnlyByAmbiguousShortName} |`);
    L.push('');
  }
  L.push('## Correspondência ODC ↔ O11 (três níveis; nenhum verificado)', '', '| Nível | Contagem | Significado |', '|---|---:|---|');
  for (const [k, v] of Object.entries(corr.levels)) L.push(`| ${k} | ${v.pairs ?? v.shortNames}${v.odcO11Pairs != null ? ` nomes curtos (${v.odcO11Pairs} pares, ${v.oneToOnePairs} um-para-um)` : ''} | ${v.meaning} |`);
  L.push('', '## Fronteira operacional (fora do modelo)', '', boundary.rule, '', '| Ferramenta | Classe | Arquivo |', '|---|---|---|', ...boundary.tools.map(t => `| ${t.tool} | ${t.class} | ${t.file} |`), '');
  return L.join('\n');
}

// ---------------------------------------------------------------- main
export async function main(argv = process.argv.slice(2)) {
  const started = Date.now();
  const outDir = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(wt, 'docs', 'evidence', 'descoberta-cobertura-fase1'));
  const census = argv.includes('--census'); const censusFrom = argv.includes('--census-from') ? path.resolve(argv[argv.indexOf('--census-from') + 1]) : null; const censusFill = argv.includes('--census-fill'); const noCli = argv.includes('--no-cli');
  const sources = laneSources('odc');
  // Native sources regenerated from the installed runtimes can be read from outside the directories the kernel and
  // discovery load at run time (catalog reconciliation, M1): --odc-model-api <dir with the reflection index and
  // INDEX.md>, --o11-catalog <model-api-<version>.json written by `anvil catalog --out`>.
  const opt = name => (argv.includes(name) ? path.resolve(argv[argv.indexOf(name) + 1]) : null);
  const odcModelApi = opt('--odc-model-api'); const o11Catalog = opt('--o11-catalog');
  const native = { odc: loadOdcNative(odcModelApi ? { dir: odcModelApi } : {}),
    o11: o11Catalog ? loadO11Native({ cat: readJson(o11Catalog), version: /model-api-([0-9.]+)\.json$/.exec(path.basename(o11Catalog))?.[1] ?? null, file: path.relative(wt, o11Catalog).replaceAll('\\', '/') }) : loadO11Native() };
  const verbs = loadVerbTable();
  const contracts = await loadContracts(sources, { noCli });
  const mentions = loadTypeMentions();
  const builder = loadBuilderPrimitives();
  const limits = loadLimits(sources);
  const built = await buildIndex('odc', { sources });
  const index = built.index;
  native.odc.installedStudio = index.identity.studio?.ideVersion ?? null;
  // The O11 lane index (phase-2 pilot): shared capabilities projected for O11, stamped results of tests/provenance-o11.json.
  let indexO11 = null; let o11Note = null;
  try { indexO11 = (await buildIndex('o11', { sources: laneSources('o11') })).index; native.o11.installedStudio = indexO11.identity.studio?.ideVersion ?? null; }
  catch (e) { o11Note = 'O11 index not built: ' + String(e.message).split(/\r?\n/)[0]; }
  const descriptors = { odc: loadDescriptor(index), o11: indexO11 ? loadDescriptor(indexO11) : null };
  for (const d of Object.values(descriptors)) if (d) d.shared = d.index?.shared?.capabilities ?? null;
  const descriptor = descriptors.odc;
  const ledger = { odc: executedLedger(index), o11: executedLedger(indexO11) };
  const statics = staticSuiteScan();
  let censusData = null; let censusIdentity = null;
  if (censusFrom) {
    const c = loadCensusFrom(censusFrom); censusData = c.data; censusIdentity = c.identity;
    const currentSha = index.identity.fixture?.sha256 ?? null; censusIdentity.currentFixtureSha256 = currentSha; censusIdentity.sameFixture = !!currentSha && currentSha === c.identity.fixtureSha256;
    if (censusFill) {
      const missing = [...new Set(native.odc.types.map(t => t.shortName.replace(/^I/, '')))].filter(k => !(k in censusData));
      if (!censusIdentity.sameFixture) throw new Error('--census-fill refused: the fixture of the reused census differs from the current lane fixture');
      const filled = missing.length ? await readerCensus(sources, missing) : {};
      censusData = { ...censusData, ...filled }; censusIdentity.filled = { kinds: missing.length, generatedAt: new Date().toISOString(), note: 'kinds absent from the reused census read now against the same fixture (same sha256)' };
    }
  }
  else if (census) { const kinds = [...new Set(native.odc.types.map(t => t.shortName.replace(/^I/, '')))]; censusData = await readerCensus(sources, kinds); censusIdentity = { fixture: path.relative(wt, sources.fixture).replaceAll('\\', '/'), fixtureSha256: index.identity.fixture?.sha256 ?? null, kinds: kinds.length, generatedAt: new Date().toISOString() }; }
  const boundary = loadOperationalBoundary();
  const rows = buildMatrix({ native, verbs, mentions, builder, limits, descriptors, ledger, statics, census: censusData, contracts });
  const corr = correspondence(native);
  const summary = counts(rows, native, { descriptors, censusIdentity, ledger });
  summary.correspondence = corr.levels;
  const strip = n => ({ ...n, types: undefined, outsideRoot: undefined, outsideRootCount: n.outsideRoot?.length ?? 0 });
  const inventory = {
    schema: 'ssam-discovery-coverage-inventory/2', generatedAt: new Date().toISOString(), checkout: wt, elapsedMs: Date.now() - started,
    identityRule: 'type id = platform:metadataVersion[:assembly]:namespace.name; shortName only for presentation and for matching evidence keyed by short name (see sources.attributionRule)',
    sources: {
      nativeOdc: { ...strip(native.odc), installedStudio: native.odc.installedStudio, versionNote: `metadata ODC ${native.odc.version} (reflection index) against installed Studio ${native.odc.installedStudio}: the inventory is not complete for the installed version` },
      nativeO11: strip(native.o11),
      kernel: { verbTable: verbs, contracts: contracts.available ? { cli: contracts.cli, ops: Object.keys(contracts.contracts), verbsInCli: contracts.contracts.verbs?.verbs ? Object.keys(contracts.contracts.verbs.verbs) : null, typesNamedByOp: Object.fromEntries(Object.keys(contracts.contracts).map(op => [op, Object.entries(contracts.namedTypes).filter(([, ops]) => ops.includes(op)).map(([t]) => t).sort()])) } : contracts, typeMentionRule: 'string literals "I<Type>" in kernel/src/Anvil.Core/Kernel/*.cs grouped by the expander files of each compact language (' + JSON.stringify(CONTRACT_FILES) + '); a mention is a hint of special handling in code, not a public contract and not proof of support', kernelDll: index.identity.cli.kernelSha256 },
      builder: { primitives: builder.primitives, typesWithPrimitive: Object.keys(builder.byType).length, features: builder.features, dir: 'platforms/odc/studio/shared/Authoring*.cs', byType: builder.byType },
      reader: { entries: ['studio_inspect {target: <capture.oml>, path?: Kind:Name|@key, kind?, name?, text?, select?, usages?, depth?, max?, offset?, properties?, budget?, expectedSourceSha256?}', 'o11_inspect {oml: <capture.oml>, ...the same arguments} (shares SnapshotReading; not run here)'], limits: 'select <= 32, depth <= 12, max <= 500, budget 2000..200000', kindSemantics: 'kind K lists objects implementing any interface named IK (Verbs.Implements: short or full name), inclusive for base interfaces', census: censusIdentity ?? 'not run (--census / --census-from)' },
      descriptor: { file: 'platforms/odc/facade/discovery-capabilities.json', sha256: index.identity.descriptor.sha256, lane: descriptor.lane, capabilities: descriptor.capabilities, unavailable: descriptor.unavailable, shortNamesNamed: Object.keys(descriptor.exposure).length, shared: index.identity.descriptor.shared ?? null, rule: descriptor.rule },
      descriptorO11: indexO11 ? { file: 'platforms/odc/facade/discovery-capabilities-o11.json', sha256: indexO11.identity.descriptor.sha256, lane: 'o11', capabilities: descriptors.o11.capabilities, shared: indexO11.identity.descriptor.shared ?? null, shortNamesNamed: Object.keys(descriptors.o11.exposure).length, studio: indexO11.identity.studio, jobs: indexO11.identity.jobs } : { note: o11Note },
      evidence: { odcLedger: { jobs: index.jobs.length, results: index.identity.jobs.results, current: index.identity.jobs.current, shortNames: Object.keys(ledger.odc.byShort).length, qualifiedInterfaces: Object.keys(ledger.odc.byQualified).length, qualifiedResults: ledger.odc.qualifiedResults, keyNote: 'porTipo keys are short kind names; results written with anvil-coverage-ledger/2 also carry porInterface (qualified), which attributes a proof to its exact type (attribution ledger-qualified); older results follow sources.attributionRule' },
        o11Ledger: indexO11 ? { jobs: indexO11.jobs.length, results: indexO11.identity.jobs.results, current: indexO11.identity.jobs.current, shortNames: Object.keys(ledger.o11.byShort).length, qualifiedInterfaces: Object.keys(ledger.o11.byQualified).length, qualifiedResults: ledger.o11.qualifiedResults, note: 'JobTests stamps only the jobs of tests/provenance-o11.json' } : { note: o11Note },
        staticSuites: Object.fromEntries(Object.entries(statics).map(([p, s]) => [p, { dirs: s.dirs, jobs: s.jobs, ops: s.ops, compactOps: s.compactOps, shortNames: Object.keys(s.perType).length, rule: s.rule }])), limitsFromNaoDa: limits.length },
      attributionRule: ATTRIBUTION_RULE, kindClassRule: KIND_CLASS_RULE, appFamilyRule: APP_FAMILY_RULE, metadataRules: METADATA_RULES, routeRule: ROUTE_RULE, exposureRule: 'exposure.capabilities (lane of the descriptor) = capabilities naming the short name, attributed by attributionRule; exposure.effective=false with reusePotential.sameShortNameInDescriptor on the other platform = reuse potential only, not exposure and not proof', statusRule: 'context-excluded (signature edits) > tested-executed (ledger or census attributed to this qualified type) > tested-static (positive job attributed) > refused-proven (documented refusal or negative job without positive) > undetermined when evidence exists only under an ambiguous/other short name > route-only (metadata suggests + route, no proof) > suggested-only (no route) > undetermined (no basis)',
      operationalBoundary: boundary,
    },
    families: { rule: 'curated regular expressions over the short name (then namespace) — see FAMILY_RULES in the script', list: [...new Set(rows.map(r => r.family))].sort() },
    operations: OPS, statuses: STATUSES, kindClasses: KIND_CLASSES,
    descriptorExposure: { odc: descriptor.exposure, o11: descriptors.o11?.exposure ?? null }, ledger, statics: Object.fromEntries(Object.entries(statics).map(([p, s]) => [p, s.perType])), census: censusData,
    correspondence: corr,
    types: { odc: native.odc.types, o11: native.o11.types },
    // Interfaces outside the object roots (not model elements; no matrix rows): the catalog accounts them as their own
    // class `outside-object-root`, beside and never inside the model-element denominators.
    typesOutsideRoot: { odc: native.odc.outsideRoot ?? [], o11: native.o11.outsideRoot ?? [] },
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'inventory.json'), JSON.stringify(inventory, null, 1));
  fs.writeFileSync(path.join(outDir, 'matrix.json'), JSON.stringify({ schema: 'ssam-discovery-coverage-matrix/2', generatedAt: inventory.generatedAt, rows }, null, 0));
  const csvEscape = v => '"' + String(v ?? '').replaceAll('"', '""') + '"';
  const csv = ['platform,id,shortName,family,kindClass,appFamily,op,status,metadataStatus,routeKind,attribution,attributedToThisType,executed,static,negative,census,exposure,missing'].concat(rows.map(r => [r.platform, r.id, r.shortName, r.family, r.kindClass, r.appFamily, r.op, r.status, r.metadata.status, r.route.kind, r.proven.attribution, r.proven.attributedToThisType, r.proven.executed ? r.proven.executed.verbs.join('|') + ' (' + r.proven.executed.jobs.length + ' jobs)' : '', r.proven.static ? Object.entries(r.proven.static.verbs).map(([v, n]) => v + ':' + n).join('|') : '', r.proven.negative ? r.proven.negative.jobs.length : '', r.proven.census ? r.proven.census.count ?? r.proven.census.error : '', r.exposure.capabilities ? r.exposure.capabilities.join('|') : (r.exposure.reusePotential ? 'reuse-potential' : ''), r.missing ?? ''].map(csvEscape).join(','))).join('\n');
  fs.writeFileSync(path.join(outDir, 'matrix.csv'), csv);
  fs.writeFileSync(path.join(outDir, 'counts.json'), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(outDir, 'README.md'), renderReadme({ inventory, summary, rows, boundary, corr, censusMode: censusFrom ? ' --census-from <inventory.json>' + (censusFill ? ' --census-fill' : '') : census ? ' --census' : '' }));
  const o = summary.odc; const s11 = summary.o11;
  console.log(JSON.stringify({ out: outDir, rows: rows.length, odc: { inventoried: o.denominators.inventoried, byKindClass: o.denominators.byKindClass, descriptorAttributed: o.descriptor.typesNamedByDescriptorAttributed, executed: o.executedProof.typesWithLedgerEntryForAnyOp, census: o.census.typesObservedInFixture }, o11: s11 ? { inventoried: s11.denominators.inventoried, byKindClass: s11.denominators.byKindClass, descriptor: s11.descriptor.typesNamedByDescriptorAttributed ?? s11.descriptor.effectiveExposure, executed: s11.executedProof.typesWithLedgerEntryForAnyOp, static: s11.staticProof.typesWithPositiveJobForAnyOp } : null, correspondence: corr.levels, elapsedMs: inventory.elapsedMs }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
