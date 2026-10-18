// Gera kernel/tests/jobs-odc/examples/matriz.json: a matriz de cobertura dos exemplos provados da faixa ODC.
// Linhas: cada widget nativo do Reactive/Mobile, cada padrao do OutSystems UI do catalogo ODC, cada padrao de uso e cada
// capacidade (e ausencia declarada) do catalogo do discover na faixa odc, nos niveis minimal/typical (e rich nos cenarios
// principais). Para cada linha: o job de exemplo (new = desta pasta), o que ja havia (existing = suite tests/jobs-odc ou
// prova do catalogo) e o status. Uso: node scripts/examples-odc-matrix.mjs [--check]
// --check nao escreve: falha (codigo 1) se o arquivo no disco difere do que seria gerado.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kernel = path.join(root, 'kernel');
const facade = path.join(root, 'platforms', 'odc', 'facade');
const suiteDir = path.join(kernel, 'tests', 'jobs-odc');
const examplesDir = path.join(suiteDir, 'examples');
const outFile = path.join(examplesDir, 'matriz.json');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();

// ---- o que existe: suite (nivel de cima de tests/jobs-odc) e exemplos (esta pasta)
const suite = new Map();
for (const f of fs.readdirSync(suiteDir).filter(f => f.endsWith('.json')).sort()) {
  try { const j = readJson(path.join(suiteDir, f)); if (j.ops || j.jobs) suite.set(f.slice(0, -5), j); } catch { /* not a job */ }
}
const examples = new Map();
for (const f of fs.readdirSync(examplesDir).filter(f => f.endsWith('.json')).sort()) {
  const j = readJson(path.join(examplesDir, f)); if (j.ops || j.jobs) examples.set(f.slice(0, -5), j);
}
const opsOf = j => j.ops ?? [];
const createdTypes = j => new Set(opsOf(j).filter(o => o.op === 'create').map(o => o.type));
const blockSources = j => new Set(opsOf(j).flatMap(o => [o.source, o.op === 'set' && o.prop === 'SourceBlock' ? o.value : null]).filter(v => typeof v === 'string' && v.startsWith('IMobileBlock:')).map(v => v.slice('IMobileBlock:'.length)));
// Blocos instanciados pela autoria visual: <Block name="X"> nos fragmentos html que os jobs da suite citam.
const visualBlocks = new Map();
for (const [name, j] of suite) for (const o of opsOf(j)) if (o.op === 'html' && typeof o.file === 'string') {
  const file = path.join(kernel, o.file); if (!fs.existsSync(file)) continue;
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/<Block[^>]*\bname="([A-Za-z0-9_]+)"/g)) (visualBlocks.get(m[1]) ?? visualBlocks.set(m[1], new Set()).get(m[1])).add(name);
}

// ---- catalogo do discover (faixa odc): capacidades compostas, provas por capacidade e por papel, ausencias
const { composeCatalog, applySupersedes } = await import(pathToFileURL(path.join(facade, 'catalog.mjs')).href);
const sharedFile = path.join(facade, 'discovery-capabilities-shared.json');
const composed = composeCatalog({ shared: readJson(sharedFile), sharedBytes: fs.readFileSync(sharedFile) });
const { descriptor } = applySupersedes(readJson(path.join(facade, 'discovery-capabilities.json')), composed.supersedes, 'odc');
const capabilities = [
  ...descriptor.capabilities.map(c => ({ id: c.id, title: c.title, route: c.route?.kind, proofs: c.proofs?.odc ?? [], roles: [] })),
  ...composed.shared.capabilities.filter(c => (c.lanes ?? composed.shared.lanes ?? ['odc']).includes('odc')).map(c => ({ id: c.id, title: c.title, route: c.route?.kind, proofs: c.platforms?.odc?.proofs ?? [],
    roles: (c.elements ?? []).map(e => ({ role: e.role, native: e.platforms?.odc?.jobType ?? null, create: c.operations?.create?.roles?.[e.role]?.odc?.proofs ?? [], set: c.operations?.set?.roles?.[e.role]?.odc?.proofs ?? [] })) })),
];
const unavailable = [...(descriptor.unavailable ?? []), ...(composed.shared.unavailable ?? []).filter(u => !u.lanes || u.lanes.includes('odc'))];
const roleProofs = (type, op) => [...new Set(capabilities.flatMap(c => c.roles.filter(r => r.native === type).flatMap(r => r[op])))].filter(j => suite.has(j));
const bySize = names => [...new Set(names)].filter(n => suite.has(n)).sort((a, b) => opsOf(suite.get(a)).length - opsOf(suite.get(b)).length || a.localeCompare(b));

// ---- linhas
const entries = [];
const add = (id, kind, level, { job = null, existing = [], status = null, notes = '' } = {}) => {
  const jobs = job ? job.split(',') : [];
  const fresh = jobs.filter(j => examples.has(j));
  // Um job da suite citado explicitamente tambem e prova que ja existia.
  existing = [...new Set([...existing, ...jobs.filter(j => suite.has(j))])];
  const st = status ?? (fresh.length ? 'new' : existing.length ? 'proven-existing' : 'pending');
  entries.push({ id, kind, level, status: st, job: job ?? (st === 'proven-existing' ? existing[0] : ''), notes, existing });
};
const ex = name => (examples.has(name) ? name : null);

// 1. Widgets nativos (plugin NRWidgets e widgets de modelo do Reactive/Mobile ODC)
const WIDGETS = [
  ['container', 'IContainer'], ['text', 'ITextWidget'], ['expression', 'IExpression', { typical: 'usage-gallery-data-action-typical' }],
  ['html-element', 'IAdvancedHtml'], ['icon', 'IIcon', { typical: 'usage-link-icon-text-typical' }], ['if', 'IIfWidget'],
  ['button', 'IButton'], ['link', 'ILink', { minimal: 'usage-link-icon-text-minimal', typical: 'usage-link-icon-text-typical' }],
  ['image', 'IImage', { minimal: 'usage-external-image-minimal', typical: 'usage-external-image-typical' }],
  ['form', 'IForm'], ['input', 'IInput'], ['checkbox', 'ICheckbox'], ['switch', 'ISwitch'], ['text-area', 'ITextArea'],
  ['radio-group', 'IRadioGroup'], ['radio-button', 'IRadioButton', { minimal: 'widget-radio-group-minimal', typical: 'widget-radio-group-typical' }],
  ['upload', 'IUpload'], ['button-group', 'IButtonGroup'], ['button-group-item', 'IButtonGroupItem', { minimal: 'widget-button-group-minimal', typical: 'widget-button-group-typical' }],
  ['label', 'ILabel', { typical: 'widget-form-typical' }], ['list', 'IList', { typical: 'usage-gallery-data-action-typical' }],
  ['list-item', 'IListItem', { typical: 'usage-navigation-input-typical' }], ['list-item-action', 'IListItemAction'],
  ['table', 'ITableRecords', { rich: 'ecommerce-02-cart' }], ['header-cell', 'IHeaderCell', { minimal: 'widget-table-minimal', typical: 'widget-table-typical' }],
  ['row-cell', 'IRowCell', { minimal: 'widget-table-minimal', typical: 'widget-table-typical' }],
  ['dropdown', 'IDropdown', { typical: 'usage-category-filter-typical' }], ['popup', 'IPopup'], ['popover', 'IPopover', { typical: null }],
  ['block-instance', 'IMobileBlockInstanceWidget', { minimal: 'osui-card-minimal', typical: 'osui-pagination-typical' }],
  ['placeholder', 'IPlaceholderWidget', { typical: 'block-reuse' }],
  ['extended-event', 'IEvent', { minimal: 'usage-clickable-card-minimal', typical: 'usage-clickable-card-typical' }],
];
for (const [slug, type, map = {}] of WIDGETS) {
  const created = bySize([...[...suite].filter(([, j]) => createdTypes(j).has(type)).map(([n]) => n), ...roleProofs(type, 'create')]);
  const bound = bySize(roleProofs(type, 'set').filter(n => created.includes(n) || createdTypes(suite.get(n)).has(type)));
  for (const level of ['minimal', 'typical']) {
    const job = level in map ? map[level] : ex(`widget-${slug}-${level}`);
    add('widget.' + slug, 'widget', level, { job, existing: level === 'minimal' ? created : bound,
      notes: `${type}${job && !job.startsWith('widget-') ? '; example shared with ' + job : ''}` });
  }
  if (map.rich) add('widget.' + slug, 'widget', 'rich', { job: map.rich, notes: `${type} na loja (cenario rico)` });
}
add('widget.editable-table', 'widget', 'minimal', { status: 'blocked', job: 'blocked-editable-table',
  notes: 'IEditableTable e widget Traditional Web (IWebWidget); recusa do kernel: "IPlaceholderContentWidget \'MainContent\' cannot create IEditableTable (no Create method in the API)". Use ITableRecords.' });

// 2. Padroes do OutSystems UI (biblioteca referenciada pelo fixture, catalogo ODC do discover)
const osui = readJson(path.join(facade, 'outsystems-ui', 'catalog.json')).libraries.find(l => l.id === 'odc-outsystemsui');
const PATTERN_MAP = {
  DropdownSearch: { minimal: 'cap-dropdown-search-minimal', typical: 'cap-dropdown-search-typical' },
  Gallery: { typical: 'usage-gallery-data-action-typical', rich: 'ecommerce-04-catalog' },
  BreadcrumbsItem: { typical: 'osui-breadcrumbs-typical' }, TabsHeaderItem: { typical: 'osui-tabs-typical' }, TabsContentItem: { typical: 'osui-tabs-typical' },
  SectionIndexItem: { typical: 'osui-section-index-typical' }, DropdownServerSideItem: { typical: 'osui-dropdown-server-side-typical' },
};
for (const p of osui.patterns) {
  const map = PATTERN_MAP[p.name] ?? {};
  const existing = bySize([...[...suite].filter(([, j]) => blockSources(j).has(p.name)).map(([n]) => n), ...(visualBlocks.get(p.name) ?? [])]);
  for (const level of ['minimal', 'typical']) {
    const job = level in map ? map[level] : ex(`osui-${kebab(p.name)}-${level}`);
    add('osui.' + p.name, 'pattern', level, { job, existing, notes: `${p.category}; ${p.line ?? ''}`.trim() });
  }
  if (map.rich) add('osui.' + p.name, 'pattern', 'rich', { job: map.rich, notes: 'Gallery de cards da loja (cenario rico)' });
}
// Bibliotecas de padroes tambem referenciadas pelo fixture (OutSystemsCharts e OutSystemsMaps), fora do catalogo OSUI do discover.
const LIBS = {
  charts: { lib: 'OutSystemsCharts', patterns: ['LineChart', 'ColumnChart', 'BarChart', 'AreaChart', 'PieChart', 'DonutChart', 'RadarChart', 'ChartXAxis', 'ChartYAxis', 'ChartLegend', 'ChartSeriesStyling', 'ChartExport'],
    map: Object.fromEntries(['ChartXAxis', 'ChartYAxis', 'ChartLegend', 'ChartSeriesStyling', 'ChartExport'].map(n => [n, { typical: 'charts-chart-addons-typical' }])) },
  maps: { lib: 'OutSystemsMaps', patterns: ['LeafletMap', 'Map', 'Marker', 'MarkerPopup', 'StaticMap', 'SearchPlaces', 'Circle', 'Polygon', 'Polyline', 'Rectangle', 'FileLayer', 'DrawMarker'],
    map: { Marker: { typical: 'maps-leaflet-map-typical' }, MarkerPopup: { typical: 'maps-map-typical' }, Circle: { typical: 'maps-shapes-typical' }, Polygon: { typical: 'maps-shapes-typical' }, Rectangle: { typical: 'maps-shapes-typical' } } },
};
for (const [prefix, { lib, patterns, map = {} }] of Object.entries(LIBS))
  for (const n of patterns) for (const level of ['minimal', 'typical']) {
    const job = map[n]?.[level] ?? ex(`${prefix}-${kebab(n)}-${level}`);
    add(`${prefix}.${n}`, 'pattern', level, { job, notes: job ? `${lib} referenced by the fixture` : `${lib} referenced by the fixture; no example in this round (an add-on, a shape or a drawing tool)` });
  }

// 3. Padroes de uso que um usuario real precisou (loja, 2026-10-06) e o cenario rico
const USAGE = [
  ['gallery-data-action', [null, 'usage-gallery-data-action-typical'], 'Gallery OSUI + List ligada a data action'],
  ['clickable-card', ['usage-clickable-card-minimal', 'usage-clickable-card-typical'], 'a Container with onclick (IEvent) and an argument'],
  ['link-icon-text', ['usage-link-icon-text-minimal', 'usage-link-icon-text-typical'], 'a Link with an Icon and a visible text'],
  ['external-image', ['usage-external-image-minimal', 'usage-external-image-typical'], 'an external Image by URL'],
  ['cart-line-quantity', [null, 'usage-cart-line-quantity-typical'], 'a line with - and +: Assign List[index] + the summary returned by the server action, without Refresh Data'],
  ['category-filter', [null, 'usage-category-filter-typical'], 'a category Dropdown with OnChange + Refresh Data'],
  ['navigation-input', ['usage-navigation-input-minimal', 'usage-navigation-input-typical'], 'navigation with an input parameter of the screen'],
];
for (const [slug, [minimal, typical], note] of USAGE) {
  if (minimal) add('usage.' + slug, 'pattern', 'minimal', { job: minimal, notes: note });
  else add('usage.' + slug, 'pattern', 'minimal', { job: typical, notes: note + '; the typical example is already the smallest that makes sense' });
  add('usage.' + slug, 'pattern', 'typical', { job: typical, notes: note });
}
const ECOMMERCE = 'ecommerce-01-data,ecommerce-02-cart,ecommerce-03-detail,ecommerce-04-catalog,ecommerce-all';
add('usage.ecommerce-flow', 'pattern', 'rich', { job: ECOMMERCE, notes: 'store: data + cart as a table + detail + catalog with a filter and a Gallery; ecommerce-all delivers everything in one transaction' });

// 4. Capacidades do catalogo do discover (faixa odc) e ausencias declaradas
const CAP_NEW = {
  'ui.screen-spec': ['cap-screen-spec-minimal', 'cap-screen-spec-typical'], 'ui.html-page': ['cap-html-page-minimal', 'cap-html-page-typical'],
  'ui.dropdown-search': ['cap-dropdown-search-minimal', 'cap-dropdown-search-typical'], 'read.inspect': ['cap-read-inspect-minimal', 'cap-read-inspect-typical'],
};
const CAP_RICH = { 'ui.screen': ECOMMERCE, 'ui.list': 'ecommerce-04-catalog', 'ui.widget': ECOMMERCE, 'ui.input': 'ecommerce-03-detail', 'ui.dropdown': 'ecommerce-04-catalog',
  'ui.block-instance': 'ecommerce-04-catalog', 'ui.event': 'ecommerce-04-catalog', 'logic.screen-action': 'ecommerce-02-cart,ecommerce-03-detail,ecommerce-04-catalog',
  'logic.server-action': 'ecommerce-01-data', 'logic.data-action': 'ecommerce-02-cart,ecommerce-04-catalog', 'logic.aggregate': 'ecommerce-02-cart,ecommerce-03-detail',
  'data.entity': 'ecommerce-01-data', 'data.static': 'ecommerce-01-data', 'data.structure': 'ecommerce-01-data', 'logic.native-nodes': 'ecommerce-03-detail' };
const CAP_BLOCKED = {
  'integration.external-library-odc': 'operations route (odc_external_library): a build with NuGet and a deploy through the Portal; not a kernel job op',
  'reference.external-library-odc': 'the job needs the signature captured in the live session (studio_deliver + bridge reference-snapshot); headless the kernel refuses it: "producer SSAMTextTools not bound: o11_deliver binds a producer by its name ..."',
  'read.discover': 'reader route (ssam_discover): a read of the index, not a job',
  'deliver.job': 'delivery route (studio_deliver): a merge in the open Studio; every example of this folder is a deliverable job, but the delivery is proven only live',
  'deliver.feature': 'feature route (C# of the builder, odc build --smoke): not a kernel job',
  'deliver.publish': 'delivery route (publication with the user\'s words): live only',
  'data.records': 'data route (studio_data*): records of the development database, not the model; live only',
  'ops.references-refresh': 'operations route (studio_refresh_references): live only',
  'ops.studio-session': 'operations route (studio_status, attach, snapshot...): live only',
  'ops.portal': 'rota portal (APIs publicas do Portal): rede',
  'ops.debugger': 'operations route (headless debugger against the published app): live only',
  'ops.environment': 'operations route (doctor, URLs, tenants): not a job',
  'diagnostic.troubleshoot': 'diagnostic route (failure taxonomy): not a job',
};
const BLOCKED_JOB = { 'reference.external-library-odc': 'blocked-reference-external-library' };
for (const c of capabilities) {
  const proofs = bySize(c.proofs);
  if (CAP_BLOCKED[c.id]) {
    for (const level of ['minimal', 'typical']) add(c.id, 'capability', level, { status: 'blocked', job: BLOCKED_JOB[c.id] ?? '', notes: CAP_BLOCKED[c.id] });
    continue;
  }
  const fresh = CAP_NEW[c.id];
  const existing = c.id === 'ui.html-page' ? ['html-if-links'] : proofs; // html-if-links (suite) ja usa a op html de pagina inteira
  add(c.id, 'capability', 'minimal', { job: fresh?.[0] ?? existing[0] ?? '', existing, notes: c.title });
  add(c.id, 'capability', 'typical', { job: fresh?.[1] ?? existing[1] ?? existing[0] ?? '', existing, notes: c.title });
  if (CAP_RICH[c.id]) add(c.id, 'capability', 'rich', { job: CAP_RICH[c.id], notes: c.title + ' (loja)' });
}
add('ui.screen-spec.cards', 'capability', 'typical', { status: 'blocked', job: 'blocked-screen-spec-cards',
  notes: 'the cards kind of the screen op fails on ODC: "screen op #N (create ): InvalidOperationException: Sequence contains no elements" (List.GetContent without an IContent); table/detail/form/dashboard pass' });
// Ausencias declaradas: o catalogo diz que nao da; um job da suite ou um exemplo que prova o contrario vira divergencia.
const CONTRADICTED = { 'button-group-native': ['widget-button-group-minimal', 'widget-button-group-typical'], 'ai.agents': ['agent-calls', 'agent-definition-tools'],
  'ai.semantic-search': ['logic-semantic-search', 'semantic-search-attributes'], 'event.global-events': ['global-event-unused'], 'process.odc-workflow': ['workflow-nodes'], 'module-image': ['image-create'] };
for (const u of unavailable) {
  const contra = (CONTRADICTED[u.id] ?? []).filter(n => suite.has(n) || examples.has(n));
  const negatives = u.negative?.odc ?? [];
  if (contra.length) add('absent.' + u.id, 'capability', 'minimal', { job: contra.join(','), existing: contra.filter(n => suite.has(n)),
    notes: `o catalogo declara ausencia ("${String(u.reason).slice(0, 140)}..."), mas ${contra.join(', ')} passa(m) no kernel e no Verify: catalogo desatualizado` });
  else add('absent.' + u.id, 'capability', 'minimal', { status: 'blocked', notes: `ausencia declarada no catalogo: ${u.reason}${negatives.length ? ' (negativo: ' + negatives.join(', ') + ')' : ''}` });
}

// ---- resumo e escrita
const count = (pred) => entries.filter(pred).length;
const keyed = (e) => `${e.id}/${e.level}`;
const summary = {
  entries: entries.length,
  byStatus: Object.fromEntries(['new', 'proven-existing', 'blocked', 'pending'].map(s => [s, count(e => e.status === s)])),
  byKind: Object.fromEntries(['widget', 'pattern', 'capability'].map(k => [k, { total: count(e => e.kind === k), coveredBefore: count(e => e.kind === k && e.existing.length > 0), coveredAfter: count(e => e.kind === k && (e.status === 'new' || e.status === 'proven-existing')) }])),
  newJobs: examples.size,
};
const matrix = {
  schema: 'ssam-examples-odc-matrix/1',
  note: 'Generated by scripts/examples-odc-matrix.mjs. status: new = an example of this folder; proven-existing = only the suite tests/jobs-odc covers it; blocked = a proven refusal or a route outside a job (notes says which); pending = no example yet. existing = jobs of the suite that already covered the line before these examples.',
  fixture: 'kernel/tests/fixtures/odc/insurance-reactive-r8.oml',
  summary,
  entries: entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id) || ['minimal', 'typical', 'rich'].indexOf(a.level) - ['minimal', 'typical', 'rich'].indexOf(b.level)),
};
// Uma linha por entrada: o diff de uma rodada para a outra mostra exatamente as linhas que mudaram.
const compact = v => Array.isArray(v) ? '[' + v.map(compact).join(', ') + ']'
  : v && typeof v === 'object' ? '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + compact(x)).join(', ') + '}' : JSON.stringify(v);
const text = ['{', ` "schema": ${JSON.stringify(matrix.schema)},`, ` "note": ${JSON.stringify(matrix.note)},`, ` "fixture": ${JSON.stringify(matrix.fixture)},`,
  ` "summary": ${compact(matrix.summary)},`, ' "entries": [', matrix.entries.map(e => '  ' + compact(e)).join(',\n'), ' ]', '}'].join('\n') + '\n';
const unknown = entries.flatMap(e => (e.job ? e.job.split(',') : []).filter(j => !examples.has(j) && !suite.has(j)).map(j => keyed(e) + ' -> ' + j));
if (unknown.length) { console.error('jobs that do not exist:\n' + unknown.join('\n')); process.exit(1); }
const orphans = [...examples.keys()].filter(n => !entries.some(e => e.job.split(',').includes(n)));
if (orphans.length) console.error('examples outside the matrix: ' + orphans.join(', '));
if (process.argv.includes('--check')) {
  // O git pode trocar LF por CRLF no checkout (autocrlf): compara o texto, nao os finais de linha.
  const same = fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n') === text;
  console.log(JSON.stringify({ upToDate: same, summary }, null, 1)); process.exit(same && !orphans.length ? 0 : 1);
}
fs.writeFileSync(outFile, text);
console.log(JSON.stringify(summary, null, 1));
if (orphans.length) process.exit(1);
