// Triggers, controls and dimensions (docs/PROTOTIPO-NATIVO.md 2.4, 2.6). A dimension is UI state that changes the DOM
// without changing the store and without changing the skeleton: enumerable controls with change/input listeners, text
// fields with input listeners, groups of triggers with the same key and different parameters whose effect is only a
// re-render, and parameterless triggers that toggle the DOM between two forms.
import { attr, classes, elementsWithPath, isElement, matchIndex, textOf } from './ir.mjs';
import { pascal, slug } from './names.mjs';
import { controlInfo } from './perturb.mjs';

const PARAM_ALWAYS = new Set(['data-id', 'data-delta']);

export function paramName(attribute) { return pascal(String(attribute).replace(/^data-/, '')) || 'Value'; }

function isRouteHref(href, kind) {
  if (href == null) return false;
  if (kind === 'spa-path') return /^\//.test(href);
  if (kind === 'multi-page') return /\.html?(#.*)?$/i.test(href) && !/^https?:/i.test(href);
  if (kind === 'spa-sections') return href.startsWith('#') && href.length > 1;
  return href.startsWith('#') && href.length > 1;
}

function insideForm(path, body) {
  let node = body;
  for (const index of path) { node = node.c[index]; if (node?.t === 'form') return node; }
  return null;
}

// Listener types of each node's ancestors (delegation to an ancestor element, not only to document/window).
export function inheritedTypes(root, initial = new Set()) {
  const out = new Map();
  const visit = (node, types) => {
    out.set(node, types);
    const next = node.L?.length ? new Set([...types, ...node.L]) : types;
    for (const child of node.c ?? []) if (child && child.t) visit(child, next);
  };
  visit(root, initial);
  return out;
}

// Listener types on the ancestors of a path inside a body.
export function ancestorTypes(body, path) {
  const out = new Set();
  let node = body;
  for (const index of path ?? []) { for (const type of node?.L ?? []) out.add(type); node = node?.c?.[index]; }
  return out;
}

// Clickable elements that do not navigate (2.4 "Gatilhos"), grouped by event name, with parameters and variants.
export function triggers(root, { kind, scope, delegated = new Set(), base = root, basePath = [] } = {}) {
  const found = [];
  const skipUnder = new Set();
  const inherited = inheritedTypes(root, new Set([...delegated, ...ancestorTypes(base, basePath)]));
  for (const { node, path } of elementsWithPath(root)) {
    if (node.h) { skipUnder.add(path.join('.')); continue; }
    if ([...skipUnder].some(prefix => path.join('.').startsWith(prefix + '.'))) continue;
    if (['input', 'select', 'textarea', 'option', 'label', 'form', 'svg', 'html', 'body', 'dialog'].includes(node.t) || attr(node, 'role') === 'dialog' || attr(node, 'aria-modal') === 'true') continue;
    const href = node.t === 'a' ? attr(node, 'href') : null;
    const listeners = node.L ?? [];
    const type = String(attr(node, 'type') ?? '').toLowerCase();
    const form = insideForm(path, root);
    if (node.t === 'button' && (type === 'submit' || (!type && (form || attr(node, 'form'))))) continue;
    if (node.t === 'a' && isRouteHref(href, kind) && !attr(node, 'data-action') && !listeners.includes('click')) continue;
    const clickable = node.t === 'button' || (node.t === 'a' && !isRouteHref(href, kind)) || attr(node, 'data-action') != null || attr(node, 'onclick') != null || attr(node, 'role') === 'button' || attr(node, 'role') === 'switch' || (attr(node, 'tabindex') != null && Number(attr(node, 'tabindex')) >= 0) || listeners.includes('click');
    if (!clickable) continue;
    if (!listeners.includes('click') && !inherited.get(node)?.has('click') && attr(node, 'onclick') == null && node.t !== 'a') continue;
    const name = attr(node, 'data-action') ?? attr(node, 'id') ?? attr(node, 'aria-controls') ?? attr(node, 'data-view') ?? attr(node, 'data-page') ?? attr(node, 'data-screen') ?? (attr(node, 'aria-label') ? slug(attr(node, 'aria-label')) : null) ?? classes(node)[0] ?? node.t;
    found.push({ node, path: basePath.concat(path), name, key: scope + ':click:' + name, attrs: node.a ?? [], ownOnly: !(node.t === 'button' || node.t === 'a' || attr(node, 'data-action') != null || attr(node, 'onclick') != null || attr(node, 'role') === 'button' || attr(node, 'role') === 'switch' || attr(node, 'tabindex') != null) });
  }
  // A container whose only reason is its own listener (delegation root) is not a trigger when it holds triggers.
  const isAncestor = (a, b) => b.path.length > a.path.length && a.path.every((index, i) => b.path[i] === index);
  for (let i = found.length - 1; i >= 0; i--) if (found[i].ownOnly && found.some(other => other !== found[i] && isAncestor(found[i], other))) found.splice(i, 1);
  // Elements with the same name, no parameter and different texts are different triggers (e.g. two tabs).
  const sameName = new Map();
  for (const item of found) { if (!sameName.has(item.name)) sameName.set(item.name, []); sameName.get(item.name).push(item); }
  for (const items of sameName.values()) {
    if (items.length < 2 || items.some(item => item.attrs.some(([n]) => PARAM_ALWAYS.has(n)))) continue;
    const texts = items.map(item => slug(textOf(item.node).trim()));
    if (new Set(texts).size !== items.length || texts.some(text => !text)) continue;
    const dataNames = new Set(items.flatMap(item => item.attrs.filter(([n]) => n.startsWith('data-') && n !== 'data-action').map(([n]) => n)));
    if ([...dataNames].some(n => new Set(items.map(item => attr(item.node, n))).size > 1)) continue;
    items.forEach((item, index) => { item.name = item.name + '-' + texts[index]; item.key = scope + ':click:' + item.name; item.byText = true; });
  }
  // Parameters: data-id/data-delta always; other data-* whose value varies between elements of the same name.
  const byName = new Map();
  for (const item of found) { if (!byName.has(item.name)) byName.set(item.name, []); byName.get(item.name).push(item); }
  const groups = [];
  for (const [name, items] of byName) {
    const dataNames = new Set(items.flatMap(item => item.attrs.filter(([n]) => n.startsWith('data-') && n !== 'data-action').map(([n]) => n)));
    const params = [...dataNames].filter(n => PARAM_ALWAYS.has(n) || new Set(items.map(item => attr(item.node, n))).size > 1).sort();
    const variants = [];
    const seen = new Set();
    for (const item of items) {
      const values = Object.fromEntries(params.map(n => [paramName(n), attr(item.node, n)]));
      const signature = JSON.stringify(values);
      if (seen.has(signature)) continue;
      seen.add(signature);
      const m = attr(item.node, 'data-action') != null ? { t: item.node.t, a: [['data-action', attr(item.node, 'data-action')], ...params.filter(n => attr(item.node, n) != null).map(n => [n, attr(item.node, n)])] } : attr(item.node, 'id') ? null : { t: item.node.t, a: item.attrs.filter(([n]) => n.startsWith('data-') || n === 'aria-label' || n === 'class').map(pair => [pair[0], pair[1]]) };
      const target = attr(item.node, 'id') ? { id: attr(item.node, 'id') } : { m, i: Math.max(0, matchIndex(base, item.node, m)) };
      variants.push({ ...item, params: values, target });
    }
    // Every element of the group with its own target (identical attributes are told apart by their index).
    const elements = items.map(item => {
      const m = attr(item.node, 'data-action') != null ? { t: item.node.t, a: [['data-action', attr(item.node, 'data-action')]] } : attr(item.node, 'id') ? null : { t: item.node.t, a: item.attrs.filter(([n]) => n.startsWith('data-') || n === 'aria-label' || n === 'class').map(pair => [pair[0], pair[1]]) };
      return { ...item, target: attr(item.node, 'id') ? { id: attr(item.node, 'id') } : { m, i: Math.max(0, matchIndex(base, item.node, m)) } };
    });
    groups.push({ name, key: items[0].key, params: params.map(n => ({ name: paramName(n), from: n })), variants, elements, tag: items[0].node.t, attrs: items[0].attrs });
  }
  return groups;
}

// Controls of a subtree with a listener for their event (own or delegated to document/window).
export function controls(root, { delegated = new Set(), basePath = [], base = null } = {}) {
  const out = [];
  const inherited = inheritedTypes(root, new Set([...delegated, ...(base ? ancestorTypes(base, basePath) : [])]));
  for (const { node, path } of elementsWithPath(root)) {
    if (!['select', 'input', 'textarea'].includes(node.t) || node.h) continue;
    const info = controlInfo(node);
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(info.type)) continue;
    const own = node.L ?? [];
    const listens = ['change', 'input'].some(type => own.includes(type) || inherited.get(node)?.has(type)) || attr(node, 'onchange') != null || attr(node, 'oninput') != null;
    if (!listens) continue;
    const enumerable = info.type === 'select' || info.type === 'checkbox' || info.type === 'radio';
    const text = !enumerable && !['number', 'range', 'date', 'time', 'datetime-local', 'color'].includes(info.type);
    out.push({ node, path: basePath.concat(path), info, enumerable, text, number: info.type === 'number' || info.type === 'range', form: insideForm(path, root), key: info.id ? '#' + info.id : info.name ? '[name=' + info.name + ']' : Object.entries(Object.fromEntries((node.a ?? []).filter(([n]) => n.startsWith('data-')))).map(([n]) => '[' + n + ']').join('') || node.t + '@' + path.join('.') });
  }
  return out;
}

export function controlTarget(base, control) {
  if (control.info.id) return { id: control.info.id };
  const keyAttrs = (control.node.a ?? []).filter(([name]) => name === 'name' || name.startsWith('data-') || name === 'type' || name === 'aria-label');
  const m = { t: control.node.t, a: keyAttrs.map(pair => [pair[0], pair[1]]) };
  return { m, i: Math.max(0, matchIndex(base, control.node, m)) };
}

export function dimensionName(key, { branches, kind }) {
  if (kind === 'control') return pascal(String(key).replace(/^#/, ''));
  const assigned = branches?.get(key);
  if (assigned?.length) return pascal(assigned[0]);
  return pascal(key);
}

export function valueType(values) {
  const present = values.filter(value => value !== null && value !== undefined && value !== '');
  if (present.length && present.every(value => value === true || value === false || value === 'true' || value === 'false')) return 'Boolean';
  if (present.length && present.every(value => /^-?\d+$/.test(String(value)))) return 'Integer';
  return 'Text';
}

export function formControls(form, body) {
  const out = [];
  const id = attr(form, 'id');
  for (const { node } of elementsWithPath(form)) if (['input', 'select', 'textarea'].includes(node.t) && attr(node, 'name')) out.push(node);
  if (id) for (const { node } of elementsWithPath(body)) if (['input', 'select', 'textarea'].includes(node.t) && attr(node, 'form') === id && attr(node, 'name') && !out.includes(node)) out.push(node);
  return out;
}

export function formsOf(root, { delegated = new Set(), basePath = [] } = {}) {
  const out = [];
  for (const { node, path } of elementsWithPath(root)) {
    if (node.t !== 'form' || node.h) continue;
    const own = node.L ?? [];
    if (!own.includes('submit') && !delegated.has('submit') && attr(node, 'onsubmit') == null) continue;
    out.push({ node, path: basePath.concat(path), name: attr(node, 'id') ?? attr(node, 'name') ?? slug(attr(node, 'aria-label') ?? '') ?? 'form' });
  }
  return out;
}

export { textOf, isElement };
