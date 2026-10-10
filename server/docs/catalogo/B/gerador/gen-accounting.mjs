// Front B accounting generator (ssam-catalog-contribution/1, section 5).
//
// Writes platforms/odc/facade/catalog/fragments/B/accounting.json: one coverage entry for every inventory type owned by
// front B that no composed capability represents (a capability role naming the type as `native` already counts as
// represented). The entries come from the small ordered RULES table below; every rule states its reason and origin. The
// generator reads only committed sources: catalog/ownership.json, the pinned inventory
// (docs/evidence/descoberta-cobertura-fase1/inventory.json: implementedBy, factories, reader census) and the fragments.
// It starts no CLI, Studio, reader or worker. Deterministic: same inputs, same file.
//
//   node docs/catalogo/B/gerador/gen-accounting.mjs            (from the root of the checkout)
//   node docs/catalogo/B/gerador/gen-accounting.mjs --check    (exit 1 when the committed file differs)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const facade = path.join(root, 'platforms', 'odc', 'facade');
const { composeCatalog, OWNERSHIP_FILE, FRAGMENTS_DIR, typeKey } = await import(pathToFileURL(path.join(facade, 'catalog.mjs')).href);
const OUT = path.join(FRAGMENTS_DIR, 'B', 'accounting.json');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));

const ownership = readJson(OWNERSHIP_FILE);
const inventory = readJson(path.join(root, ownership.inventory.file));
const shared = readJson(path.join(facade, 'discovery-capabilities-shared.json'));
const { shared: composed } = composeCatalog({ shared });

// Represented = a composed capability role names the type as native on that lane (any front, same rule as catalog-check).
const represented = new Set();
for (const c of composed.capabilities ?? []) for (const l of c.lanes ?? composed.lanes ?? ['odc', 'o11']) for (const e of c.elements ?? []) {
  const native = e.platforms?.[l]?.native; if (native) represented.add(typeKey(l, native));
}
const invType = new Map();
for (const lane of ['odc', 'o11']) for (const t of inventory.types[lane] ?? []) invType.set(typeKey(lane, t.name), t);
// Interfaces outside the object roots (reconciled inventory, request C-007) are accounted too, as their own class.
for (const lane of ['odc', 'o11']) for (const t of inventory.typesOutsideRoot?.[lane] ?? []) invType.set(typeKey(lane, t.name), { ...t, kindClass: 'outside-object-root' });
const census = inventory.census ?? {};
const censusOf = t => { const k = t.shortName.replace(/^I/, '').replace(/<.*$/, ''); const v = census[k]; return v == null ? null : typeof v === 'number' ? v : v.count ?? null; };

const SIGNATURE_ORIGIN = 'inventory kindClassRule (referenced-signature); kernel/src/Anvil.Core/Kernel/ScreenContracts.cs (signatures read for screen compilation); platforms/odc/facade/discovery.mjs signatureOf (element:<Kind>:<Name> with --app)';
const NO_TRADITIONAL_ON_ODC = 'platforms/odc/docs/HANDOFF.md:490 (ODC app types: Reactive and Mobile); kernel/src/Anvil.Core/Kernel/ScreenModel.cs:300-305 (the web context is refused in a CrossDevice module; code, no negative job)';

// Ordered rules; the first that matches decides. `when(t, lane, info)`; `entry(t, lane, info)` returns the entry fields.
const RULES = [
  { id: 'referenced-signature',
    when: t => t.kindClass === 'referenced-signature',
    entry: t => ({ status: 'excluded', applicability: 'not-applicable',
      reason: `referenced signature of ${t.shortName.replace(/Signature$/, '')}: in a consumer it is read-only (the reader lists it and discover --app returns its kind, name and job reference, plus the inputs, events and placeholders it declares, if any); create/set/rename/move/duplicate/delete happen in its producer; importing or refreshing the reference is front C (reference.*). A writable property in the metadata does not authorize editing it in the consumer.`,
      origin: SIGNATURE_ORIGIN,
      operations: { read: { status: 'undetermined', note: 'readable through the capture reader; no suite job reads this signature with get' } } }) },
  { id: 'outside-root-ui-helper',
    when: t => t.kindClass === 'outside-object-root',
    entry: t => ({ status: 'excluded', applicability: 'not-applicable',
      reason: `${t.shortName} is outside the object roots (${t.kindBasis ?? 'no resolved base reaches IObject or IObjectSignature'}). No job creates, reads by path, edits or deletes it, and no contract pointer or capability names it. Accounted in the outside-root block, not among the UI elements.`,
      origin: 'reconciled inventory typesOutsideRoot (request C-007); catalog.mjs ownerOfOutsideRoot (UI helpers -> B); kernel/src and kernel/tests scan 2026-09-23 (no mention)' }) },
  { id: 'base-interface',
    when: t => t.kindClass === 'base-interface',
    entry: (t, lane, i) => ({ status: 'excluded', applicability: 'not-applicable',
      reason: `base interface implemented by ${t.implementedBy} inventoried type(s); it is never the created type: operations are stated on the concrete roles of the UI capabilities.`,
      origin: 'inventory kindClassRule (base-interface) and implementedBy' }) },
  { id: 'abstract-with-factory',
    when: t => t.kindClass === 'concrete-authorable' && t.implementedBy > 0 && /^(IScreen|IBlock|IEmail|IUIFlow|IWidget|IMobileWidget|IWebWidget)$/.test(t.shortName),
    entry: t => ({ status: 'excluded', applicability: 'not-applicable', classification: 'base',
      reason: `generic UI interface implemented by ${t.implementedBy} inventoried type(s) (its factory returns the generic type); a job names the concrete type (IMobileScreen, IMobileBlock, IWebScreen, NRWidgets.*...) and the kernel creates that one; operations are stated on the concrete roles.`,
      origin: 'inventory implementedBy/factories; kernel Verbs.FindCreateCore ranking (docs/COBERTURA-DESCOBERTA-FASE1.md section 2)' }) },
  { id: 'odc-web-implemented-by-crossdevice',
    when: (t, lane, i) => lane === 'odc' && t.appFamily === 'web' && (i.census ?? 0) > 0 && t.shortNameCandidatesInventoried === 1,
    entry: (t, lane, i) => ({ status: 'excluded', applicability: 'not-applicable', classification: 'base',
      reason: `on ODC this web interface is implemented by CrossDevice objects (reader census --kind ${t.shortName.replace(/^I/, '')} = ${i.census} in the ODC fixture; the short name is unique in the inventory): it is a base of the Reactive/Mobile objects, not an authoring context of its own; author through the Reactive/Mobile capabilities (ui.screen, ui.block, ui.block-instance, ui.event).`,
      origin: `docs/evidence/descoberta-cobertura-fase1/inventory.json census ${t.shortName.replace(/^I/, '')}=${i.census}; ${NO_TRADITIONAL_ON_ODC}` }) },
  { id: 'odc-web-ambiguous-census',
    when: (t, lane, i) => lane === 'odc' && t.appFamily === 'web' && (i.census ?? 0) > 0,
    entry: (t, lane, i) => ({ status: 'excluded', applicability: 'not-applicable',
      reason: `Traditional Web type whose short name ${t.shortName} is shared with a Reactive/Mobile type: the ODC census (${i.census}, inclusive by short name) does not say whether any object implements THIS interface. Traditional Web is not an ODC app type; the Reactive/Mobile homonym is the one authored (ui.widget, ui.block, ui.block-instance, ui.screen, logic.app-event). Stated from documentation and kernel code, not from a negative job.`,
      origin: `docs/evidence/descoberta-cobertura-fase1/inventory.json (shortNameCandidatesInventoried ${t.shortNameCandidatesInventoried}; census ${t.shortName.replace(/^I/, '')}=${i.census}); ${NO_TRADITIONAL_ON_ODC}` }) },
  { id: 'combo-special-list',
    when: (t, lane) => lane === 'odc' && t.shortName === 'ISpecialListEntry',
    entry: t => ({ status: 'excluded', applicability: 'not-applicable',
      reason: `entry of the special list of a Traditional Web combo box: its only factory is ${(t.factories ?? []).map(f => f.factory ?? f).join(', ')}; Traditional Web is not an ODC app type, so no ODC authoring context creates it. Stated from the inventory, documentation and kernel code, not from a negative job.`,
      origin: `inventory factories (reconciled, ODC 1.7.25.10778); ${NO_TRADITIONAL_ON_ODC}` }) },
  { id: 'odc-web-absent',
    when: (t, lane) => lane === 'odc' && (t.appFamily === 'web' || /^ServiceStudio\.Plugin\.Widgets\.IEditableTable/.test(t.name)),
    entry: (t, lane, i) => ({ status: 'excluded', applicability: 'not-applicable',
      reason: `Traditional Web type: ${i.census == null ? 'the ODC fixture census has no entry for it (kind added by the 1.7.25 reconciliation)' : `no object implements it in the ODC CrossDevice fixture (census ${i.census})`} and Traditional Web is not an ODC app type; on O11 it belongs to ui.traditional-screen / ui.traditional-widget. Stated from documentation and kernel code, not from a negative job.`,
      origin: `inventory census (reader, ODC fixture); ${NO_TRADITIONAL_ON_ODC}` }) },
  { id: 'born-with-parent',
    when: t => /^(IIfBranchWidget|IContent)$/.test(t.shortName) && /\.Mobile\.Widgets\./.test(t.name),
    entry: t => ({ status: 'excluded', applicability: 'not-applicable', classification: 'generated',
      reason: t.shortName === 'IIfBranchWidget'
        ? 'born with its IIfWidget (the True and False branches); widgets are created under <if path>/TrueBranch|FalseBranch, the branch itself is never created or deleted on its own.'
        : 'born with its widget: on ODC the caption of a button/link/label and the children of a list live inside an IContent; it is addressed (#ITextWidget, IContent:content) but not created on its own.',
      origin: t.shortName === 'IIfBranchWidget' ? 'job:table-if-reactive (O11); api --op html-visual div[if]/div[else]' : 'kernel/docs/NAO-DA.md "Legenda de botao/link/label (ITextWidget)" (line 785) and "Filhos de uma IList" (line 806)',
      ...(t.shortName === 'IContent' ? { operations: { read: { status: 'applicable', note: 'read through the dump of its owner (job:screen-block-edit ops 9 and 34, stamped current on ODC)' } } } : {}) }) },
  { id: 'module-binary-content',
    when: t => t.shortName === 'ILocalizedImage',
    entry: () => ({ status: 'gap', applicability: 'applicable',
      reason: 'a localized variant of a module image: it needs binary content, which the kernel does not expose (the same limit as module images); no public route writes it.',
      origin: 'kernel/docs/NAO-DA.md IImage (limite-do-kernel, both lanes); unavailable module-image',
      alternative: 'import the image and its localized variants in the Studio' }) },
  { id: 'extended-metadata',
    when: t => /Metadata$/.test(t.shortName),
    entry: (t, lane, i) => ({ status: 'undetermined', applicability: 'undetermined',
      reason: `extended metadata of a model object (managedBy); no suite job writes it and the ODC fixture census is ${i.census ?? 'not read'}: which elements accept it and through which verb is not measured (ITextMetadata is the only metadata proven, on ODC, in ui.email-popover).` }) },
  { id: 'sync-events',
    when: t => /^(IOnSync\w*Event|IOnSyncSystemEvent)$/.test(t.shortName),
    entry: (t, lane, i) => ({ status: 'undetermined', applicability: 'undetermined',
      reason: `offline synchronization event of a Mobile app (factory: ${(t.factories ?? []).map(f => f.method ?? f).join(', ') || 'none recorded'}); census ${i.census ?? 'not read'}; no suite job creates or binds it on either lane.` }) },
  { id: 'web-flow-nodes-and-events-o11',
    when: (t, lane) => lane === 'o11' && /\.UI\.Web\./.test(t.name),
    entry: t => ({ status: 'undetermined', applicability: 'undetermined',
      reason: `Traditional Web ${/Events\./.test(t.name) ? 'widget event' : 'flow element'} of O11 (${t.shortName}); the generic verbs can address it but no suite job creates, binds or reads it, and no stamped result names its interface.` }) },
  { id: 'o11-mobile-builtin-event',
    when: (t, lane) => lane === 'o11' && t.name === 'OutSystems.Model.UI.Mobile.Events.IBuiltinEvent',
    entry: () => ({ status: 'undetermined', applicability: 'undetermined',
      reason: 'on O11 the stamped results record a widget OnClick under OutSystems.Model.UI.Mobile.Events.IUILifeCycleEvent (ui.event, widget event role), not under this interface, which has no factory and no implementer in the O11 catalog.' }) },
  { id: 'previous-screen',
    when: t => t.shortName === 'IPreviousScreen',
    entry: (t, lane, i) => ({ status: 'undetermined', applicability: 'undetermined',
      reason: `built-in "previous screen" destination of a UI flow (census ${i.census ?? 'not read'}); whether a Destination can name it and how it is addressed is not measured by any job.` }) },
  { id: 'theme-values',
    when: t => t.shortName === 'IThemeValues',
    entry: (t, lane, i) => ({ status: 'undetermined', applicability: 'undetermined',
      reason: `theme values (Theme Editor tokens) of a theme (census ${i.census ?? 'not read'}); no job reads or writes them; the theme CSS halves are ui.theme-css.` }) },
  { id: 'plugin-widgets-odc',
    when: (t, lane) => lane === 'odc' && /^ServiceStudio\.Plugin\.Widgets\./.test(t.name),
    entry: t => ({ status: 'undetermined', applicability: 'undetermined',
      reason: `${t.name}: the ODC census by short name is ambiguous with NRWidgets.${t.shortName}, and the forms and labels created by ODC jobs are recorded by the ledger as ServiceStudio.Plugin.NRWidgets.* (ui.input); whether this plugin widget can be authored on ODC is not measured.` }) },
  { id: 'o11-expression-base',
    when: (t, lane) => lane === 'o11' && t.name === 'OutSystems.Model.IExpression',
    entry: () => ({ status: 'undetermined', applicability: 'undetermined',
      reason: 'O11 catalog type without factory or implementer; the Reactive expression widget is ServiceStudio.Plugin.NRWidgets.IExpression (ui.widget) and logic expressions belong to front A; which objects implement this interface on O11 is not measured.' }) },
  { id: 'o11-mobile-content',
    when: (t, lane) => lane === 'o11' && t.name === 'OutSystems.Model.UI.Mobile.IContent',
    entry: () => ({ status: 'undetermined', applicability: 'undetermined',
      reason: 'no factory and no implementer in the O11 catalog; on O11 captions sit beside the widget and list children directly under the list (NAO-DA), so no job addresses an IContent.' }) },
  { id: 'o11-flow-comment-node',
    when: (t, lane) => lane === 'o11' && t.name === 'OutSystems.Model.UI.Mobile.IComment',
    entry: () => ({ status: 'undetermined', applicability: 'undetermined',
      reason: 'a comment created in an O11 UI flow with this type answers as OutSystems.Model.Logic.Nodes.ICommentNode (GetInterface), so the flow-comment role of ui.flow-comment is stated on that type (owned by front A, coordinated); whether any O11 object answers as UI.Mobile.IComment is not measured.',
      origin: 'job:cat-b-flow-comment-popover (stamped current, INT-T2-004) ops 0-8: ledger OutSystems.Model.Logic.Nodes.ICommentNode' }) },
];

const entries = []; const unmatched = [];
for (const [key, o] of Object.entries(ownership.types)) {
  if (o.owner !== 'B' || represented.has(key)) continue;
  const lane = key.split(':')[0]; const t = invType.get(key);
  if (!t) { unmatched.push(key + ' (not in inventory)'); continue; }
  const info = { census: lane === 'odc' ? censusOf(t) : null };
  const rule = RULES.find(r => r.when(t, lane, info));
  if (!rule) { unmatched.push(key); continue; }
  entries.push({ type: key, ...rule.entry(t, lane, info), rule: rule.id });
}
entries.sort((a, b) => a.type.localeCompare(b.type));
if (unmatched.length) { console.error('types without a rule (add a rule, a capability role, or state them by hand):\n' + unmatched.join('\n')); process.exitCode = 2; }
const fragment = {
  schemaVersion: 'ssam-discovery-fragment/1', contract: 'ssam-catalog-contribution/1', front: 'B',
  title: 'Front B accounting of the inventory types no capability represents (generated by docs/catalogo/B/gerador/gen-accounting.mjs; do not edit by hand)',
  reviewedAt: '2026-09-23', synonyms: {}, capabilities: [], unavailable: [],
  coverage: entries.map(({ rule, ...e }) => ({ ...e, note: `rule ${rule}` })),
};
const text = JSON.stringify(fragment, null, 1) + '\n';
if (process.argv.includes('--check')) {
  // Line endings are the checkout's business (core.autocrlf): compare the content, not the terminators.
  const same = fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') === text;
  console.log(same ? 'accounting.json is current' : 'accounting.json differs from the generator output'); if (!same) process.exitCode = 1;
} else {
  fs.writeFileSync(OUT, text);
  const byRule = {}; for (const e of entries) byRule[e.rule] = (byRule[e.rule] ?? 0) + 1;
  console.log(`wrote ${path.relative(root, OUT)}: ${entries.length} entries`, JSON.stringify(byRule));
}
