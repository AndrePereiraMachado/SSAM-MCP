// The shared shell (docs/PROTOTIPO-NATIVO.md 2.5). SPA: the app root (the element whose content is rewritten per
// route) is emitted as the block root; its children that are equal in every canonical render (variations explained by
// dimension or view predicates) are regions; the mount point is the only child whose content differs between views (the
// element itself stays in the shell and the placeholder goes inside it). Siblings of the app root in <body> that are
// not modal containers are regions too. multi-page: the body children of every page aligned (keyed LCS); the common
// prefix and suffix are the regions, the differing stretch is the mount. Dynamic values of the shell become block
// inputs (View, the global dimensions it reads, the records and values it shows, Aviso/AvisoErro of the toast); shell
// triggers that change a global dimension or close the toast become block events.
import { attr, classes, isElement, isModalNode, walk } from './ir.mjs';
import { renderKey, alignTrees } from './align.mjs';
import { annotateRegion } from './infer-lists.mjs';
import { recordInputName, aggregateInputName, changedEvent, words, slug } from './names.mjs';

function regionName(node, index) {
  return slug(attr(node, 'id') ?? classes(node).find(token => token !== 'container') ?? node.t) || 'region-' + index;
}

function rekey(node, from, to) {
  walk(node, current => {
    if (typeof current.k === 'string' && (current.k === from || current.k.startsWith(from + '/'))) current.k = to + current.k.slice(from.length);
  });
}

// Sources of a shell context: the global dimension values, the record each dimension selects in its collection, and
// count/sum over the collections that reference that record (filtered by the dimension value).
function shellSources(context, { session, meta, state, lang }) {
  const out = {};
  for (const dim of session.dims.filter(entry => entry.scope === 'global')) {
    const value = context.dims[dim.key];
    out['dim:' + dim.key] = value;
    if (!dim.collection) continue;
    const collection = meta.byName.get(dim.collection);
    const row = (state[dim.collection] ?? collection.rows).find(item => String(item[collection.key]) === String(value));
    const record = recordInputName(dim.collection, lang);
    if (row) for (const field of collection.fields) if (field.name !== collection.key && (field.type === 'Text' || field.type === 'Integer' || field.type === 'Decimal')) out['input:' + record + '.' + field.name] = row[field.name];
    for (const other of meta.collections) {
      const reference = other.references.find(item => item.collection === dim.collection);
      if (!reference) continue;
      const rows = (state[other.name] ?? []).filter(item => String(item[reference.field]) === String(value));
      for (const field of other.fields.filter(item => (item.type === 'Integer' || item.type === 'Decimal') && item.name !== other.key && !other.references.some(ref => ref.field === item.name))) {
        out['input:' + aggregateInputName(other.name, field.name, 'sum')] = Math.round(rows.reduce((sum, item) => sum + Number(item[field.name] ?? 0), 0) * 100) / 100;
      }
    }
  }
  return out;
}

function collectVals(node, out = []) {
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if ('dim' in value || 'input' in value || 'view' in value) out.push(value);
    for (const item of Object.values(value)) visit(item);
  };
  walk(node, current => { visit(current.expr); visit(current.if); visit(current.attrExpr); visit(current.classExpr); visit(current.icon?.cases); });
  return out;
}

export function buildShell({ session, interactions, lang, locale, tz }) {
  const { discovery } = interactions;
  const kind = discovery.kind;
  const mount = discovery.mount;
  const spa = kind === 'spa-hash' || kind === 'spa-path' || kind === 'spa-state' || kind === 'spa-sections';
  if (spa && mount && mount.length >= 2) return spaShell({ session, interactions, lang, locale, tz });
  // The mount is a child of <body> (main#app between a header and a side menu): the body is the app root.
  if (spa && mount && mount.length === 1 && bodyRegions(interactions).length) return spaShell({ session, interactions, lang, locale, tz, bodyLevel: true });
  if (kind === 'multi-page' && discovery.views.length >= 2) return multiPageShell({ session, interactions, lang, locale, tz });
  return null;
}

const isDialog = isModalNode;

// Body children of a body-level shell: every element except the mount, dialogs, the hosts of a modal (a hidden
// container a dialog is written into) and the containers a toast was seen in (siblings).
function bodyChildren(interactions) {
  const { discovery, observations } = interactions;
  const body0 = (discovery.views.find(view => view.default) ?? discovery.views[0])?.render?.body ?? { c: [] };
  const hosts = new Set(), toasts = new Set();
  for (const item of observations ?? []) {
    for (const modal of [...(item.obs?.modalAfter ?? []), ...(item.obs?.modalBefore ?? [])]) if (modal.path?.length > 1) hosts.add(modal.path[0]);
    for (const toast of item.obs?.toasts ?? []) toasts.add(toast.region);
  }
  return { body0, hosts, toasts };
}
function bodyRegions(interactions) {
  const { body0, hosts, toasts } = bodyChildren(interactions);
  const mountIndex = interactions.discovery.mount[0];
  return (body0.c ?? []).map((node, index) => ({ node, index })).filter(({ node, index }) => isElement(node) && index !== mountIndex && !isDialog(node) && !hosts.has(index) && !toasts.has(index));
}

function spaShell({ session, interactions, lang, locale, tz, bodyLevel = false }) {
  const { discovery, meta, records, observations } = interactions;
  // Body level: the root is <body> with its shell regions and the mount (kept in body order); the toast containers
  // stay siblings and the modal hosts stay out.
  const kept = bodyLevel ? new Set(bodyRegions(interactions).map(item => item.index).concat(discovery.mount[0])) : null;
  const appIndex = bodyLevel ? null : discovery.mount[0];
  const keptOrder = bodyLevel ? [...kept].sort((a, b) => a - b) : null;
  const mountIndex = bodyLevel ? keptOrder.indexOf(discovery.mount[0]) : discovery.mount[1];
  const rootOf = body => bodyLevel ? { ...body, t: 'body', a: [], c: keptOrder.map(index => body.c?.[index]).filter(Boolean) } : body.c?.[appIndex];
  const views = discovery.views;
  const defaultView = views.find(view => view.default) ?? views[0];
  const globalDims = session.dims.filter(dim => dim.scope === 'global');
  const entries = [];
  const dimsOf = state => Object.fromEntries(globalDims.map(dim => [dim.key, state?.assign && dim.key in state.assign ? String(state.assign[dim.key]) : String(dim.initial ?? '')]));
  const push = (render, view, state, extra = {}) => { if (render?.body && rootOf(render.body)) entries.push({ render, view, dims: { ...dimsOf(state), ...extra } }); };
  push(defaultView.render, defaultView.key, defaultView.state);
  for (const view of views) if (view !== defaultView) push(view.render, view.key, view.state);
  for (const state of discovery.states ?? []) {
    if (state === defaultView.state || !Object.keys(state.assign ?? {}).length) continue;
    const render = discovery.renderOf?.(state, defaultView.route);
    if (render && !discovery.isFallback?.(state, defaultView.route)) push(render, defaultView.key, state);
  }
  // Text global dimensions (a search in the header): the probe render of the default view.
  for (const dim of globalDims.filter(entry => entry.kind === 'text')) {
    const probe = observations.find(item => item.info.type === 'control' && item.info.scope === 'shell' && item.info.view === defaultView && (item.info.control.info.id === dim.key || item.info.control.key === dim.controlKey));
    if (probe) push(probe.after, defaultView.key, defaultView.state, { [dim.key]: String(probe.info.value) });
  }
  // the mount may be deeper than a child of the app root (a React frame: stage > scale > phone > screen): the path inside
  // the region that holds it is kept and only the mount element itself is emptied (its placeholder goes there)
  const inner = bodyLevel ? [] : discovery.mount.slice(2);
  const emptyAt = (node, path) => (!path.length ? { ...node, c: [] } : { ...node, c: (node.c ?? []).map((child, index) => index === path[0] ? emptyAt(child, path.slice(1)) : child) });
  const trees = entries.map(entry => {
    const root = rootOf(entry.render.body);
    return { ...root, c: (root.c ?? []).map((child, index) => index === mountIndex ? emptyAt(child, inner) : child) };
  });
  const contexts = entries.map(entry => ({ view: entry.view, dims: entry.dims }));
  const sources = entries.map(entry => shellSources(entry, { session, meta, state: meta.state(entry.render), lang }));
  const vars = { dims: globalDims.map(dim => ({ key: dim.key, zero: dim.initial, free: dim.kind === 'text' })), view: true };
  const region = annotateRegion({ trees, contexts, sources, vars, meta: null, states: entries.map(entry => meta.state(entry.render)), locale, tz, keyPrefix: 's:app', allowSingletons: true });
  const root = region.root;
  const regions = [], regionInfo = [];
  const usedNames = new Set(['app']);
  (root.c ?? []).forEach((child, index) => {
    if (!isElement(child)) return;
    let name = regionName(child, index);
    if (usedNames.has(name)) name = name + '-' + index;
    usedNames.add(name);
    rekey(child, child.k, 's:' + name);
    regions.push(index);
    regionInfo.push({ index, k: child.k, name, selector: child.t + (attr(child, 'id') ? '#' + attr(child, 'id') : '') + classes(child).map(token => '.' + token).join(''), role: index === findMountIndex(root, trees[0], mountIndex) ? 'mount' : 'region', ...(bodyLevel && keptOrder[index] != null ? { top: keptOrder[index] } : {}) });
  });
  const mountAt = findMountIndex(root, trees[0], mountIndex);
  // Siblings of the app root (toast containers), with the toast template from the probes that showed one.
  const siblings = [];
  const body0 = defaultView.render.body;
  (body0.c ?? []).forEach((node, index) => {
    if (!isElement(node) || index === appIndex || isDialog(node)) return;
    if (bodyLevel && (kept.has(index) || bodyChildren(interactions).hosts.has(index))) return;
    const toastObservations = observations.filter(item => item.obs?.toasts?.some(toast => toast.region === index));
    const normal = toastObservations.find(item => item.obs.toasts.some(toast => !toast.classes.some(token => /error|danger/.test(token))));
    const error = toastObservations.find(item => item.obs.toasts.some(toast => toast.classes.some(token => /error|danger/.test(token))));
    const siblingEntries = [{ node, aviso: '', error: false }];
    for (const item of [normal, error].filter(Boolean)) {
      const toast = item.obs.toasts.find(entry => entry.region === index);
      siblingEntries.push({ node: { ...item.after.body.c[index], c: [toast.node] }, aviso: toast.text, error: toast.classes.some(token => /error|danger/.test(token)) });
    }
    const w = words(lang);
    const ctxs = siblingEntries.map(entry => ({ dims: { aviso: entry.aviso, avisoErro: String(entry.error) } }));
    const srcs = siblingEntries.map(entry => ({ ['input:' + w.notice]: entry.aviso }));
    const annotated = annotateRegion({ trees: siblingEntries.map(entry => entry.node), contexts: ctxs, sources: srcs, vars: { dims: [{ key: 'aviso', zero: '', hidden: true }, { key: 'avisoErro', zero: 'false' }] }, meta: null, states: siblingEntries.map(() => ({})), locale, tz, keyPrefix: 's:' + regionName(node, index), allowSingletons: true, constantSources: ['input:'] });
    const toastSeen = siblingEntries.length > 1;
    siblings.push({ index, root: annotated.root, toast: toastSeen ? { inputs: [w.notice].concat(error || normal ? [w.noticeError] : []) } : null });
    regionInfo.push({ index: null, sibling: index, k: annotated.root.k, name: regionName(node, index), selector: node.t + (attr(node, 'id') ? '#' + attr(node, 'id') : ''), role: 'sibling' });
  });
  // Inputs: the values the annotations read.
  const inputs = [];
  const seen = new Set();
  const addInput = (name, type, source) => { if (seen.has(name)) return; seen.add(name); inputs.push({ name, type, source }); };
  for (const val of collectVals(root)) {
    if (val.view) addInput('View', 'Text', { view: true });
    else if (val.dim) { const dim = session.dims.find(item => item.key === val.dim); if (dim) addInput(dim.name, dim.type ?? 'Text', { dimension: dim.key }); }
    else if (val.input) {
      const recordDim = globalDims.find(dim => dim.collection && recordInputName(dim.collection, lang) === val.input);
      addInput(val.input, val.field ? 'Record' : 'Decimal', recordDim ? { record: recordDim.collection, by: recordDim.key } : { aggregate: val.input });
    }
  }
  // Global dimensions whose controls live in the shell are inputs even when no annotation reads them (the control).
  for (const dim of globalDims) addInput(dim.name, dim.type ?? 'Text', { dimension: dim.key });
  for (const sibling of siblings) if (sibling.toast) { const w = words(lang); addInput(w.notice, 'Text', { toast: 'text' }); addInput(w.noticeError, 'Boolean', { toast: 'error' }); }
  // Aggregate inputs are integers when every observed value is.
  for (const input of inputs) {
    if (input.type !== 'Decimal') continue;
    const values = sources.map(source => source['input:' + input.name]).filter(value => value !== undefined);
    if (values.every(Number.isInteger)) input.type = 'Integer';
  }
  // Events: shell triggers that change a global dimension, and the toast close.
  const events = [];
  for (const event of records.events.values()) {
    if (event.scope !== 'shell') continue;
    const effects = event.observations.flatMap(item => item.effects);
    const dim = globalDims.find(entry => effects.some(effect => effect.kind === 'setDimension' && effect.dimension === entry.key));
    if (dim) { events.push({ name: changedEvent(dim.name, lang), event: event.key, dimension: dim.key }); continue; }
    if (effects.some(effect => effect.kind === 'setDimension' && effect.dimension === 'aviso')) events.push({ name: words(lang).close + words(lang).notice, event: event.key });
  }
  return {
    root, regions, mount: { region: mountAt, path: [mountAt, ...inner] }, siblings: siblings.map(sibling => sibling.root), regionInfo,
    inputs, events, unexplained: region.unexplained, map: region.map, appIndex, mountIndex, bodyLevel, top: keptOrder
  };
}

function findMountIndex(root, tree, mountIndex) {
  // The mount element of the canonical tree in the union root (index into root.c).
  const target = tree.c[mountIndex];
  let found = -1;
  (root.c ?? []).forEach((child, index) => { if (found < 0 && isElement(child) && child.t === target.t && attr(child, 'id') === attr(target, 'id') && renderKey({ t: 'x', a: child.a }) === renderKey({ t: 'x', a: target.a })) found = index; });
  return found >= 0 ? found : mountIndex;
}

function multiPageShell({ interactions, locale, tz }) {
  const { discovery } = interactions;
  const views = discovery.views;
  const bodies = views.map(view => view.render.body);
  const keyed = body => (body.c ?? []).filter(isElement);
  const base = keyed(bodies[0]);
  // Common prefix and suffix of the body children across all pages: the same structure and texts (the attributes may differ
  // per page, the active link of the menu: annotated per view below).
  let prefix = 0;
  while (prefix < base.length && bodies.every(body => keyed(body)[prefix] && sameStructure(keyed(body)[prefix], base[prefix]))) prefix++;
  let suffix = 0;
  while (suffix < base.length - prefix && bodies.every(body => { const list = keyed(body); return list.length - 1 - suffix >= prefix && sameStructure(list[list.length - 1 - suffix], base[base.length - 1 - suffix]); })) suffix++;
  if (!prefix && !suffix) return null;
  const regionsNodes = base.slice(0, prefix).concat(base.slice(base.length - suffix));
  const root = { k: 's:body', t: 'body', c: [] };
  const regions = [], regionInfo = [];
  const regionAt = (body, index) => { const list = keyed(body); return index < prefix ? list[index] : list[list.length - (regionsNodes.length - index)]; };
  regionsNodes.forEach((node, index) => {
    const annotated = annotateRegion({ trees: bodies.map(body => regionAt(body, index)), contexts: views.map(view => ({ view: view.key, dims: {} })), sources: views.map(() => ({})), vars: { dims: [], view: true }, meta: null, states: views.map(() => ({})), locale, tz, keyPrefix: 's:' + regionName(node, index), allowSingletons: true });
    if (index === prefix) root.c.push({ k: 's:mount', t: 'div', a: [['data-ssam-mount', '']] });
    root.c.push(annotated.root);
    regions.push(root.c.length - 1);
    regionInfo.push({ index: root.c.length - 1, k: annotated.root.k, name: regionName(node, index), role: 'region' });
  });
  if (prefix === regionsNodes.length) root.c.push({ k: 's:mount', t: 'div', a: [['data-ssam-mount', '']] });
  const mountAt = root.c.findIndex(child => child.k === 's:mount');
  for (const view of views) view.multiPage = { prefix, suffix };
  // the menu's active link per page reads the View input
  const inputs = collectVals(root).some(val => val.view) ? [{ name: 'View', type: 'Text', source: { view: true } }] : [];
  return { root, regions, mount: { region: mountAt, path: [mountAt], placeholderOnly: true }, siblings: [], regionInfo, inputs, events: [], unexplained: [], map: new Map(), multiPage: { prefix, suffix } };
}

// Two elements with the same structure and texts (attributes aside).
function sameStructure(a, b) {
  if (renderKey(a) === renderKey(b)) return true;
  const { pairs, onlyA, onlyB } = alignTrees(a, b);
  const meaningful = node => isElement(node) || String(node.x ?? '').trim();
  if (onlyA.some(meaningful) || onlyB.some(meaningful)) return false;
  for (const [x, y] of pairs) if (!isElement(x) && String(x.x).replace(/\s+/g, ' ').trim() !== String(y.x).replace(/\s+/g, ' ').trim()) return false;
  return true;
}
