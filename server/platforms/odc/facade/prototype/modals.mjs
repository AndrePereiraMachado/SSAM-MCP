// Modals (docs/PROTOTIPO-NATIVO.md 2.4): containers (<dialog>, [role=dialog], [aria-modal=true] or an element whose
// visibility toggles), kinds typed by the slug of the title without digits and '#', the class put on the container
// when it opens, parameters (trigger attributes that vary between openings and change the content), screens (every view
// where some trigger opened the kind, in any state), modals opened from inside a modal, and listeners guarded by the
// target (they never become element events: a native handler does not test the target).
import { attr, classes, isElement, walk } from './ir.mjs';
import { alignTrees, renderKey } from './align.mjs';
import { modalSlug, modalName } from './names.mjs';

function nodeAt(body, path) { let node = body; for (const index of path ?? []) { node = node?.c?.[index]; if (!node) return null; } return node; }

// Structural likeness of two containers with the same title: the share of elements aligned with compatible classes.
function elementCount(node) { let count = 0; walk(node, item => { if (isElement(item)) count++; }); return count; }
function likeness(a, b) {
  const rootA = { t: 'x', c: a.c ?? [] }, rootB = { t: 'x', c: b.c ?? [] };
  const { pairs } = alignTrees(rootA, rootB);
  let matched = 0;
  for (const [x, y] of pairs) {
    if (x === rootA || !isElement(x)) continue;
    const ca = classes(x), cb = classes(y);
    const common = ca.filter(token => cb.includes(token)).length;
    if ((!ca.length && !cb.length) || common / new Set([...ca, ...cb]).size >= 0.5) matched++;
  }
  return matched / Math.max(1, elementCount(rootA) - 1, elementCount(rootB) - 1);
}

// Kinds by title slug, split by structure (2.4): containers of one slug whose structures do not align (likeness < 0.5)
// are different kinds (<slug>, <slug>-2, ...). mapping.modals names them (key -> popup name); without a name for every
// split kind the capture refuses (PROTOTYPE_AMBIGUOUS with the patch modals).
export function modalRegistry(names = {}) {
  const clusters = new Map();
  return {
    names, clusters,
    keyOf(slug, container) {
      if (!container) return slug;
      if (!clusters.has(slug)) clusters.set(slug, []);
      const list = clusters.get(slug);
      let index = list.findIndex(other => other === container || likeness(other, container) >= 0.5);
      if (index < 0) { list.push(container); index = list.length - 1; }
      return index === 0 ? slug : slug + '-' + (index + 1);
    },
    keysOf(slug) { return (clusters.get(slug) ?? [null]).map((_, index) => index === 0 ? slug : slug + '-' + (index + 1)); }
  };
}

export function modalOf(effect, body, registry = null) {
  const container = nodeAt(body, effect.path);
  const slug = modalSlug(effect.title) || 'modal';
  const key = registry ? registry.keyOf(slug, container) : slug;
  const suffix = key === slug ? '' : key.slice(slug.length + 1);
  const name = registry?.names?.[key] ?? ((modalName(effect.title) || 'Modal') + suffix);
  return { key, slug, name, title: effect.title, path: effect.path, classAttr: effect.classAttr ?? '', container };
}

// The openings used to explore each kind: the first trigger in the canonical state (views in order), plus one per other
// (view, state) where the kind opened.
export function openings(observations, registry = null) {
  const out = [];
  const seen = new Set();
  const ordered = [...observations].filter(item => item.effects.some(effect => effect.kind === 'openPopup'));
  ordered.sort((a, b) => Number(b.info.state === b.info.view?.state) - Number(a.info.state === a.info.view?.state));
  for (const item of ordered) {
    const effect = item.effects.find(entry => entry.kind === 'openPopup');
    const modal = modalOf(effect, item.after.body, registry);
    const canonical = item.info.state === item.info.view?.state;
    const id = modal.key + '@' + item.info.view?.key + '@' + item.info.state?.key;
    if (seen.has(id)) continue;
    if (!canonical && out.some(entry => entry.modal.key === modal.key && entry.state === item.info.state)) continue;
    seen.add(id);
    out.push({ id: out.length.toString().padStart(2, '0') + '-' + item.info.state?.key, view: item.info.view, state: item.info.state, prefix: item.info.prefix, variant: item.info.variant, after: item.after, modal, canonical: canonical && !out.some(entry => entry.modal.key === modal.key && entry.canonical), observation: item });
  }
  return out;
}

export function targetGuards(observations, records) {
  for (const entry of records.targetGuarded.filter(item => item.pending)) {
    const self = observations.find(item => item.info.type === 'guard' && item.info.modal === entry.modal && item.info.which === 'self');
    const child = observations.find(item => item.info.type === 'guard' && item.info.modal === entry.modal && item.info.which === 'child');
    entry.pending = false;
    const closesOnSelf = Boolean(self?.obs?.closed);
    const closesOnChild = Boolean(child?.obs?.closed);
    entry.confirmed = closesOnSelf && !closesOnChild;
    if (entry.confirmed) {
      entry.event = 'modal:click';
      entry.why = 'closes by the click on the backdrop; the native IPopup has no such event';
      records.outOfScope.push({ what: 'closing the modal by the click on the backdrop', where: entry.handler, why: 'a listener with a target guard on the container; the native IPopup has no such event' });
    }
  }
  records.targetGuarded = records.targetGuarded.filter(item => item.confirmed);
}

// Modal kinds with their inputs, screens and the content of the first canonical opening.
export function kinds(observations, records, { views, registry = modalRegistry() }) {
  const map = new Map();
  for (const item of observations) {
    const effect = item.effects.find(entry => entry.kind === 'openPopup');
    if (!effect) continue;
    const modal = modalOf(effect, item.after.body, registry);
    effect.modal = modal.key;
    if (!map.has(modal.key)) map.set(modal.key, { key: modal.key, slug: modal.slug, name: modal.name, titles: new Set(), openings: [] });
    const kind = map.get(modal.key);
    kind.titles.add(modal.title);
    kind.openings.push({ item, modal });
  }
  const out = [];
  for (const kind of map.values()) {
    const sorted = [...kind.openings].sort((a, b) => Number(b.item.info.state === b.item.info.view?.state) - Number(a.item.info.state === a.item.info.view?.state));
    const first = sorted.find(entry => !entry.item.info.modal) ?? sorted[0];
    const container = first.modal.container;
    const containerAttrs = (container?.a ?? []).filter(([name]) => name !== 'class' && name !== 'open');
    // Parameters: attributes of the opener that vary between openings and change the content.
    const params = [];
    const byParam = new Map();
    for (const { item, modal } of kind.openings) for (const [name, value] of Object.entries(item.info.variant?.params ?? {})) {
      if (!byParam.has(name)) byParam.set(name, new Map());
      byParam.get(name).set(String(value), renderKey({ t: 'x', c: modal.container?.c ?? [] }));
    }
    for (const [name, values] of byParam) if (values.size >= 1 && new Set(values.values()).size > 1 || values.size === 1 && [...values.keys()][0] !== undefined && kind.openings.some(entry => entry.item.info.variant?.params?.[name] != null) && new Set(kind.openings.map(entry => entry.item.info.variant?.params?.[name])).size > 1) {
      const all = [...values.keys()];
      params.push({ name, from: 'data-' + name.replace(/[A-Z]/g, (char, index) => (index ? '-' : '') + char.toLowerCase()), type: all.every(value => /^-?\d+$/.test(value)) ? 'Integer' : 'Text' });
    }
    const screens = [...new Set(kind.openings.map(entry => entry.item.info.view?.key).filter(Boolean))];
    const openedFrom = [];
    for (const { item } of kind.openings) {
      const entry = { view: item.info.view?.key, event: item.event ?? null, modal: item.info.modal ?? null, state: item.info.state?.key };
      if (!openedFrom.some(other => other.view === entry.view && other.event === entry.event && other.modal === entry.modal)) openedFrom.push(entry);
    }
    out.push({
      key: kind.key, name: kind.name,
      container: { tag: container?.t ?? 'div', attrs: containerAttrs, class: first.modal.classAttr || null },
      openedFrom, params, screens: views.filter(view => screens.includes(view.key)).map(view => view.key),
      first, slug: kind.slug, title: first.modal.title,
      ambiguous: registry.keysOf(kind.slug).length > 1 && !registry.keysOf(kind.slug).every(key => registry.names[key])
    });
  }
  return out;
}

export function containerAttributes(node) {
  return (node?.a ?? []).filter(([name]) => name !== 'class' && name !== 'open');
}

export { walk, isElement, attr };
