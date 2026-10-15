// The canonical IR "ssam-prototype-capture/1" (docs/PROTOTIPO-NATIVO.md 2.10): canonical JSON, hash and validator.
import crypto from 'node:crypto';

export const SCHEMA = 'ssam-prototype-capture/1';

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Canonical JSON: object keys sorted, arrays in order, undefined dropped, no whitespace.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(item => item === undefined ? 'null' : canonical(item)).join(',') + ']';
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

// The IR hash excludes timings, engine.node, source.root and source.archive.path (2.1, 2.10): where the prototype was is
// never part of what it is (a .zip keeps its sha256 in the hash).
export function hashable(ir) {
  const copy = { ...ir };
  delete copy.timings;
  if (copy.engine) { copy.engine = { ...copy.engine }; delete copy.engine.node; }
  if (copy.source) { copy.source = { ...copy.source }; delete copy.source.root; if (copy.source.archive && typeof copy.source.archive === 'object') { copy.source.archive = { ...copy.source.archive }; delete copy.source.archive.path; } }
  return copy;
}

export function irHash(ir) { return sha256(canonical(hashable(ir))); }

export function treeHash(node) { return sha256(canonical(node)); }

export function isElement(node) { return node && typeof node === 'object' && typeof node.t === 'string'; }

// A modal container of a serialized page: <dialog>, [role=dialog|alertdialog], [aria-modal=true], or an overlay the runtime
// marked (ov: a backdrop that covers the screen and holds a sheet, mounted by a click: a React bottom sheet).
export function isModalNode(node) {
  if (!isElement(node)) return false;
  if (node.t === 'dialog' || node.ov) return true;
  const role = (node.a ?? []).find(pair => pair[0] === 'role')?.[1];
  return role === 'dialog' || role === 'alertdialog' || (node.a ?? []).some(pair => pair[0] === 'aria-modal' && pair[1] === 'true');
}

export function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (visit(node, parent) === false) return;
  for (const child of node.c ?? []) walk(child, visit, node);
}

// Elements of a tree: an icon counts 1 (its paths are never kept), option counts 1, text never counts.
export function countElements(node, { self = true } = {}) {
  let count = 0;
  walk(node, current => { if (isElement(current) && (self || current !== node)) count++; });
  return count;
}

export function attr(node, name) {
  const pair = (node?.a ?? []).find(([key]) => key === name);
  return pair ? pair[1] : null;
}

export function classes(node) {
  return String(attr(node, 'class') ?? '').split(/\s+/).filter(Boolean);
}

// Every element with its path (indices into c arrays from the given root).
export function elementsWithPath(root, path = [], out = []) {
  if (isElement(root)) out.push({ node: root, path });
  (root?.c ?? []).forEach((child, index) => { if (isElement(child)) elementsWithPath(child, path.concat(index), out); });
  return out;
}

export function nodeAt(root, path) {
  let node = root;
  for (const index of path) { node = node?.c?.[index]; if (!node) return null; }
  return node;
}

export function textOf(node) {
  if (!node) return '';
  if (!isElement(node)) return String(node.x ?? '');
  return (node.c ?? []).map(textOf).join('');
}

// Exact-attribute match target used by probes: the child resolves {m: {t, a}, i} the same way.
export function matches(node, m) {
  if (!isElement(node) || node.t !== m.t) return false;
  return (m.a ?? []).every(([name, value]) => attr(node, name) === value);
}

export function matchIndex(root, node, m) {
  let index = -1, found = -1;
  walk(root, current => { if (found >= 0) return false; if (matches(current, m)) { index++; if (current === node) found = index; } });
  return found;
}

// Strips the observation-only fields (listeners, live values, visibility) from a serialized tree.
export function stripObservation(node) {
  if (!node || typeof node !== 'object') return node;
  if (!isElement(node)) return { x: node.x };
  const out = { t: node.t };
  if (node.a?.length) out.a = node.a.map(pair => [pair[0], pair[1]]);
  if (node.icon) out.icon = node.icon;
  if (node.svg) out.svg = node.svg;
  if (node.c?.length) out.c = node.c.map(stripObservation);
  return out;
}

const NODE_KEYS = new Set(['k', 't', 'a', 'c', 'x', 'icon', 'svg', 'list', 'if', 'else', 'classExpr', 'attrExpr', 'expr', 'events', 'control', 'nav', 'viewExpr', 'options']);

function validateNode(node, where, problems, seen) {
  if (!node || typeof node !== 'object') { problems.push(where + ': node must be an object'); return; }
  for (const key of Object.keys(node)) if (!NODE_KEYS.has(key)) problems.push(where + ': unknown node key ' + key);
  if (typeof node.k !== 'string' || !node.k) problems.push(where + ': k is required');
  else if (seen.has(node.k)) problems.push(where + ': duplicate k ' + node.k);
  else seen.add(node.k);
  if ('x' in node) {
    if (typeof node.x !== 'string') problems.push(where + ': x must be text');
    if ('t' in node || 'c' in node) problems.push(where + ': a text node has no t or c');
    return;
  }
  if (typeof node.t !== 'string' || node.t !== node.t.toLowerCase()) problems.push(where + ': t must be a lower-case tag');
  if (node.a !== undefined && (!Array.isArray(node.a) || node.a.some(pair => !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string')))
    problems.push(where + ': a must be [name, value] text pairs');
  if (node.c !== undefined && !Array.isArray(node.c)) problems.push(where + ': c must be an array');
  for (const [index, child] of (node.c ?? []).entries()) validateNode(child, where + '/c/' + index, problems, seen);
  if (node.list) {
    // A list reads exactly one source: a collection of the store or a snapshot entity (2.8).
    if (Boolean(node.list.collection) === Boolean(node.list.snapshot)) problems.push(where + ': a list reads a collection or a snapshot entity');
    const snapshot = node.list.snapshot;
    if (snapshot) {
      const names = (snapshot.attributes ?? []).map(item => item.name);
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(snapshot.entity ?? '')) problems.push(where + ': snapshot entity must be ASCII PascalCase');
      if (!names.length || names.some(name => !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) || new Set(names).size !== names.length) problems.push(where + ': snapshot attributes must be unique ASCII names');
      if (!Array.isArray(snapshot.rows) || snapshot.rows.some(row => Object.keys(row).some(key => !names.includes(key)))) problems.push(where + ': snapshot rows hold only its attributes');
    }
  }
  if (node.list?.template) validateNode(node.list.template, where + '/list/template', problems, new Set());
  for (const [index, child] of (node.else ?? []).entries()) validateNode(child, where + '/else/' + index, problems, seen);
}

// Structural validator: the compile lane rejects an IR that fails it (PROTOTYPE_IR_INVALID, ssamDefect).
export function validateIr(ir) {
  const problems = [];
  if (!ir || typeof ir !== 'object') return ['IR must be an object'];
  if (ir.schema !== SCHEMA) problems.push('schema must be ' + SCHEMA);
  for (const key of ['clock', 'tz', 'kind']) if (typeof ir[key] !== 'string' || !ir[key]) problems.push(key + ' is required');
  if (!['multi-page', 'spa-hash', 'spa-path', 'spa-sections', 'spa-state', 'static'].includes(ir.kind)) problems.push('kind is not in the closed list');
  if (!ir.source || !Array.isArray(ir.source.files)) problems.push('source.files is required');
  if (!ir.app || !/^[A-Za-z][A-Za-z0-9]*$/.test(ir.app.prefix ?? '')) problems.push('app.prefix must be ASCII PascalCase');
  if (!Array.isArray(ir.views) || !ir.views.length) problems.push('views must have at least one view');
  const viewKeys = new Set();
  for (const [index, view] of (ir.views ?? []).entries()) {
    if (!view.key || viewKeys.has(view.key)) problems.push('views/' + index + ': key missing or duplicate');
    viewKeys.add(view.key);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(view.name ?? '')) problems.push('views/' + index + ': name must be ASCII PascalCase');
    validateNode(view.root, 'views/' + index + '/root', problems, new Set());
  }
  if ((ir.views ?? []).filter(view => view.default).length !== 1) problems.push('exactly one view is the default');
  for (const [index, modal] of (ir.modals ?? []).entries()) validateNode(modal.root, 'modals/' + index + '/root', problems, new Set());
  if (ir.shell) validateNode(ir.shell.root, 'shell/root', problems, new Set());
  for (const [index, state] of (ir.explored ?? []).entries())
    if (!ir.trees?.[state.tree]) problems.push('explored/' + index + ': tree ' + state.tree + ' is not in trees');
  for (const [hash, tree] of Object.entries(ir.trees ?? {}))
    if (treeHash(tree) !== hash) problems.push('trees/' + hash + ': hash does not match the tree');
  return problems;
}
