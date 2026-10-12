// Fidelity measure (docs/PROTOTIPO-NATIVO.md 4.4 step 3), without a browser and without an LLM.
// export function measureFidelity({capture, nativeDom, sheets?, bundle?}) -> report.prototype.fidelity
//   capture: the IR (object) or the path of capture.json (its bundle gives the prototype sheets);
//   nativeDom: prototype-dom.json of the compile/css lanes (object or path): {states: [{id, tree}]} | {trees: {id: tree}}
//     | {<id>: tree}, optionally {selectors: [{original, rewritten}]}, runtimeUnverified, references, unevaluable.
// (a) elements, classes, attributes and texts aligned by keyed LCS, without ssam-* classes and runtime attributes, with
//     the documented equivalences (substituted tag + ssam-tag-*, type=submit <-> ssam-submit, navigation href, implicit
//     role, runtime id, icon svg <-> span.ssam-icon, an option without value <-> value = its text, the selected option of a
//     select whose prototype marks none <-> runtime state), runtime wrappers (native nodes without k) transparent;
// (b) selector match sets: for every selector of every style rule of the prototype sheets (inside @media/@supports too),
//     without dynamic pseudo-classes and pseudo-elements, the set of k matched in the prototype tree with the original
//     selector equals the set matched in the native tree with the rewritten selector; a matched element without k
//     (runtime wrapper) is a gain.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { alignTrees } from './align.mjs';
import { attr, classes, isElement, textOf, walk } from './ir.mjs';

const require = createRequire(import.meta.url);

const RUNTIME_ATTRIBUTES = new Set(['data-container', 'data-advancedhtml', 'data-link', 'data-block', 'data-checkbox', 'data-expression', 'data-button', 'data-input', 'data-dropdown', 'data-textarea', 'data-popup', 'data-list', 'data-image', 'data-form', 'data-radio-button', 'data-radio-group', 'data-switch', 'data-label', 'data-placeholder', 'data-text', 'data-icon', 'data-ssam-k', 'novalidate', 'disable-virtualization']);
const DYNAMIC = /:(hover|focus|focus-visible|focus-within|active|visited|target|checked-dynamic)\b|::?(before|after|placeholder|backdrop|marker|selection|first-letter|first-line|file-selector-button|-webkit-[a-z-]+|-moz-[a-z-]+)/i;
const LIMIT = 50;
const ID_REFERENCES = new Set(['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'for', 'form', 'list']);

function loadJson(value) {
  if (typeof value === 'string') return JSON.parse(fs.readFileSync(value, 'utf8'));
  return value;
}

// A state of the kernel's read-back (ssam-prototype-dom/1, PrototypeRender) carries its rendered fragment as `root` (the
// runtime's top elements in order); it is compared as the body of the prototype state.
function stateTree(state) {
  if (state.tree) return state.tree;
  if (Array.isArray(state.root)) return { t: 'body', c: state.root };
  return state.root ?? null;
}

function nativeStates(nativeDom) {
  if (!nativeDom) return new Map();
  if (Array.isArray(nativeDom.states)) return new Map(nativeDom.states.map(state => [state.id, stateTree(state)]));
  if (nativeDom.trees && typeof nativeDom.trees === 'object') return new Map(Object.entries(nativeDom.trees));
  return new Map(Object.entries(nativeDom).filter(([key, value]) => value && typeof value === 'object' && (value.t || value.c) && !['selectors', 'runtimeUnverified', 'references', 'unevaluable'].includes(key)));
}

// The native tag after the documented substitution (div.ssam-tag-dialog is a dialog; span.ssam-icon is an icon).
function nativeTag(node) {
  if (!isElement(node)) return null;
  const tokens = classes(node);
  const substituted = tokens.find(token => token.startsWith('ssam-tag-'));
  if (substituted) return substituted.slice(9);
  if (tokens.includes('ssam-icon')) return 'svg';
  return node.t;
}

function visibleClasses(node) {
  const tokens = classes(node).filter(token => !token.startsWith('ssam-'));
  if (node.icon || classes(node).includes('ssam-icon')) return tokens.filter(token => token !== 'lucide' && !token.startsWith('lucide-'));
  return tokens;
}

function iconName(node) {
  if (node.icon) return node.icon.name ?? null;
  const token = classes(node).find(item => item.startsWith('lucide-'));
  return token ? token.slice(7) : null;
}

// A popup of the runtime renders where its widget is (inside the screen's content, fixed on top); the prototype's modal
// container is a child of <body>. Documented equivalence: the popup's outermost runtime element is compared at <body> level.
export function relocatePopups(tree) {
  if (!tree || tree.t !== 'body') return tree;
  let moved = [];
  const visit = node => {
    if (!isElement(node)) return node;
    const kids = [];
    for (const child of node.c ?? []) {
      if (isElement(child) && child.rt === 'IPopup') { moved.push(child); continue; }
      kids.push(visit(child));
    }
    return { ...node, c: kids };
  };
  // the top elements as the measure sees them (the runtime's wrappers at the top, a block instance, spliced away); each popup
  // goes right after the top element that holds it (the shell's root: a modal of the prototype follows #app)
  const flat = [];
  const expand = node => { if (isElement(node) && !node.k && !node.rt?.startsWith?.('IPopup')) (node.c ?? []).forEach(expand); else flat.push(node); };
  (tree.c ?? []).forEach(expand);
  const top = [];
  for (const child of flat) {
    moved = [];
    top.push(child.rt === 'IPopup' ? child : visit(child));
    top.push(...moved);
  }
  return { ...tree, c: top };
}

// Native tree for the alignment: wrappers (no k) spliced into their parents.
function splice(node) {
  if (!isElement(node)) return node;
  const kids = [];
  for (const child of node.c ?? []) {
    // a runtime wrapper (no k) and the multi-page mount placeholder (div[data-ssam-mount], an element the prototype never
    // had: the page's own children go there) are transparent
    if (isElement(child) && (!child.k || attr(child, 'data-ssam-mount') != null)) { const inner = splice(child); kids.push(...(inner.c ?? [])); }
    else kids.push(splice(child));
  }
  return { ...node, c: kids, original: node };
}

function comparableAttributes(node, native, protoNode) {
  const out = new Map();
  for (const [name, value] of node.a ?? []) {
    if (name === 'class' || name === 'id' || RUNTIME_ATTRIBUTES.has(name)) continue;
    if (native && name === 'role' && protoNode && attr(protoNode, 'role') == null && value === protoNode.t) continue;
    if (node.icon && ['xmlns', 'width', 'height', 'viewbox', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'data-lucide'].includes(name)) continue;
    out.set(name, value);
  }
  return out;
}

const norm = text => String(text ?? '').replace(/\s+/g, ' ').trim();

function compareTrees(proto, native, state) {
  const mismatches = [];
  const counts = { elements: 0, matchedElements: 0, classes: 0, matchedClasses: 0, attributes: 0, matchedAttributes: 0, texts: 0, matchedTexts: 0 };
  const spliced = splice(native);
  const { pairs } = alignTrees(proto, spliced, {
    tagOf: node => node.original ? nativeTag(node) : node.icon ? 'svg' : node.t,
    classesOf: node => visibleClasses(node, Boolean(node.original)),
    ignoreIds: true
  });
  const nativeOf = new Map();
  for (const [a, b] of pairs) nativeOf.set(a, b);
  // the options of a select whose prototype marks no option selected: the selection is state (the property), not markup
  const unmarked = new Set();
  walk(proto, node => { if (isElement(node) && node.t === 'select') { const options = []; walk(node, child => { if (isElement(child) && child.t === 'option') options.push(child); }); if (!options.some(option => attr(option, 'selected') != null)) options.forEach(option => unmarked.add(option)); } });
  // The runtime id of each prototype id (the widget's name): an attribute that names ids (aria-labelledby, for, form...) is
  // equal when it names the runtime ids of the same elements.
  const runtimeIds = new Map();
  for (const [a, b] of pairs) if (isElement(a) && isElement(b) && attr(a, 'id') != null) runtimeIds.set(attr(a, 'id'), attr(b.original ?? b, 'id'));
  walk(proto, node => {
    if (node === proto) return;
    if (!isElement(node)) {
      if (!norm(node.x)) return;
      counts.texts++;
      const other = nativeOf.get(node);
      if (other && !isElement(other) && norm(other.x) === norm(node.x)) counts.matchedTexts++;
      else mismatches.push({ k: node.k, state, kind: 'text', expected: node.x, got: other && !isElement(other) ? other.x : null });
      return;
    }
    counts.elements++;
    const other = nativeOf.get(node);
    const protoClasses = visibleClasses(node, false);
    counts.classes += protoClasses.length;
    const protoAttributes = comparableAttributes(node, false);
    counts.attributes += protoAttributes.size;
    if (!other || !isElement(other)) { mismatches.push({ k: node.k, state, kind: 'missing', expected: node.t }); return; }
    let ok = true;
    const tag = nativeTag(other.original ?? other);
    if (tag !== (node.icon ? 'svg' : node.t)) { ok = false; mismatches.push({ k: node.k, state, kind: 'tag', expected: node.t, got: tag }); }
    if (node.icon && iconName(other.original ?? other) !== node.icon.name) { ok = false; mismatches.push({ k: node.k, state, kind: 'icon', expected: node.icon.name, got: iconName(other.original ?? other) }); }
    const nativeClasses = new Set(visibleClasses(other.original ?? other, true));
    const matchedClasses = protoClasses.filter(token => nativeClasses.has(token));
    counts.matchedClasses += matchedClasses.length;
    if (matchedClasses.length !== protoClasses.length || nativeClasses.size !== protoClasses.length) {
      ok = false;
      mismatches.push({ k: node.k, state, kind: 'class', expected: protoClasses.join(' '), got: [...nativeClasses].join(' ') });
    }
    const nativeAttributes = comparableAttributes(other.original ?? other, true, node);
    for (const [name, value] of protoAttributes) {
      let got = nativeAttributes.get(name);
      // Equivalences: navigation href (the runtime URL), type=submit <-> ssam-submit.
      if (name === 'href' && /^#/.test(value) && got != null) got = value;
      if (name === 'type' && value === 'submit' && classes(other.original ?? other).includes('ssam-submit')) got = value;
      if (ID_REFERENCES.has(name) && got != null && got === String(value).split(/\s+/).map(id => runtimeIds.get(id) ?? id).join(' ')) got = value;
      if (got === value) counts.matchedAttributes++;
      else { ok = false; mismatches.push({ k: node.k, state, kind: 'attribute', name, expected: value, got: got ?? null }); }
      nativeAttributes.delete(name);
    }
    for (const [name, value] of nativeAttributes) {
      if (name === 'href' || name === 'type') continue;
      // HTML: an option without a value attribute has its text as value; the selected option of an unmarked select is state
      if (node.t === 'option' && name === 'value' && norm(value) === norm(textOf(node))) continue;
      if (node.t === 'option' && name === 'selected' && unmarked.has(node)) continue;
      ok = false;
      mismatches.push({ k: node.k, state, kind: 'attribute', name, expected: null, got: value });
    }
    if (ok) counts.matchedElements++;
  });
  // Native elements with k that align to nothing are extra.
  const aligned = new Set([...pairs.values()]);
  walk(spliced, node => { if (node !== spliced && isElement(node) && node.k && !aligned.has(node)) mismatches.push({ k: node.k, state, kind: 'extra', got: node.t }); });
  return { counts, mismatches, pairs };
}

// ---- selectors ----------------------------------------------------------------------------------------------------

function escapeHtml(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(text) { return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

function toHtml(node, ids, counter) {
  if (!isElement(node)) return escapeHtml(node.x ?? '');
  const id = counter.next++;
  ids.set(id, node);
  const tag = /^[a-z][a-z0-9-]*$/.test(node.t) ? node.t : 'div';
  const attributes = (node.a ?? []).filter(([name]) => /^[^\s"'>/=]+$/.test(name)).map(([name, value]) => ' ' + name + '="' + escapeAttr(value) + '"').join('');
  const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const open = '<' + tag + attributes + ' data-ssam-n="' + id + '">';
  if (voids.has(tag)) return open;
  return open + (node.c ?? []).map(child => toHtml(child, ids, counter)).join('') + '</' + tag + '>';
}

function documentOf(tree) {
  const { JSDOM } = require('jsdom');
  const ids = new Map();
  const counter = { next: 1 };
  const body = tree.t === 'body' ? (tree.c ?? []).map(child => toHtml(child, ids, counter)).join('') : toHtml(tree, ids, counter);
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + body + '</body></html>');
  return { dom, ids };
}

// Selectors of every style rule (inside @media/@supports too), split at top-level commas, dynamic ones left out.
export function sheetSelectors(texts) {
  const { JSDOM } = require('jsdom');
  const out = [];
  for (const text of texts) {
    const dom = new JSDOM('<!doctype html><style></style>');
    dom.window.document.querySelector('style').textContent = text;
    const visit = list => {
      for (const rule of list ?? []) {
        if (rule.type === 1) { out.push({ rule: out.length, selectors: splitSelectors(rule.selectorText) }); continue; }
        if (rule.cssRules) visit(rule.cssRules);
      }
    };
    visit(dom.window.document.styleSheets[0]?.cssRules);
    dom.window.close();
  }
  return out;
}

// A selector without insignificant spacing (around combinators and commas, runs of blanks), outside strings.
export function selectorKey(text) {
  let out = '', quote = null;
  for (const char of String(text ?? '').trim()) {
    if (quote) { out += char; if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; out += char; continue; }
    if (/\s/.test(char)) { if (out && !/[\s>+~,(]$/.test(out)) out += ' '; continue; }
    if ('>+~,)'.includes(char)) out = out.replace(/\s+$/, '');
    out += char;
  }
  return out.trim();
}

export function splitSelectors(text) {
  const out = [];
  let depth = 0, current = '';
  for (const char of String(text)) {
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (char === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function matchSet(document, ids, selector, mapNode) {
  let nodes;
  try { nodes = document.querySelectorAll(selector); } catch { return null; }
  const out = new Set();
  for (const element of nodes) {
    const id = Number(element.getAttribute('data-ssam-n'));
    const node = ids.get(id);
    if (!node) continue;
    out.add(mapNode(node));
  }
  return out;
}

function sheetTexts(capture, bundle, sheets) {
  if (sheets) return sheets;
  const dir = bundle ?? null;
  const out = [];
  for (const sheet of capture.css?.sheets ?? []) {
    if (sheet.text) { out.push(sheet.text); continue; }
    if (dir && sheet.bundle) { try { out.push(fs.readFileSync(path.join(dir, sheet.bundle), 'utf8')); } catch { /* missing sheet */ } }
  }
  return out;
}

export function measureFidelity({ capture, nativeDom, sheets = null, bundle = null }) {
  const bundleDir = bundle ?? (typeof capture === 'string' ? path.dirname(capture) : null);
  const ir = loadJson(capture);
  const native = loadJson(nativeDom) ?? {};
  const states = nativeStates(native);
  // The rewritten selector of each selector a rewrite changed, keyed by its spelling without the author's spacing (the
  // CSSOM serializes the selectors it reads: "a>b" is "a > b").
  const rewritten = new Map((native.selectors ?? []).map(item => [selectorKey(item.original), item.rewritten]));
  const rules = sheetSelectors(sheetTexts(ir, bundleDir, sheets));
  const totals = { elements: 0, matchedElements: 0, classes: 0, matchedClasses: 0, attributes: 0, matchedAttributes: 0, texts: 0, matchedTexts: 0 };
  const selectorTotals = { rules: rules.length, selectors: 0, equal: 0, gained: 0, lost: 0, skipped: 0 };
  const mismatches = [], selectorDiffs = [], perState = [];
  for (const state of ir.explored ?? []) {
    const proto = ir.trees?.[state.tree];
    if (!proto) continue;
    const nativeTree = relocatePopups(states.get(state.id));
    if (!nativeTree) {
      let count = 0; walk(proto, node => { if (node !== proto && isElement(node)) count++; });
      totals.elements += count;
      mismatches.push({ state: state.id, kind: 'state-missing' });
      perState.push({ state: state.id, score: 0, selectorsDiff: null, missing: true });
      continue;
    }
    const { counts, mismatches: list, pairs } = compareTrees(proto, nativeTree, state.id);
    for (const key of Object.keys(totals)) totals[key] += counts[key];
    mismatches.push(...list);
    // Selector match sets on both trees; native nodes are mapped to the prototype k through the alignment.
    const protoDoc = documentOf(proto), nativeDoc = documentOf(nativeTree);
    const protoK = node => node.k;
    const toProto = new Map();
    for (const [a, b] of pairs) if (isElement(b)) toProto.set(b.original ?? b, a.k);
    const nativeK = node => node.k ? (toProto.get(node) ?? '!' + node.k) : null;
    let diffs = 0;
    for (const rule of rules) {
      for (const selector of rule.selectors) {
        if (DYNAMIC.test(selector)) { selectorTotals.skipped++; continue; }
        const original = matchSet(protoDoc.dom.window.document, protoDoc.ids, selector, protoK);
        const target = rewritten.get(selectorKey(selector)) ?? selector;
        const got = matchSet(nativeDoc.dom.window.document, nativeDoc.ids, target, nativeK);
        if (!original || !got) { selectorTotals.skipped++; continue; }
        selectorTotals.selectors++;
        const gained = [...got].filter(k => k === null || !original.has(k));
        const lost = [...original].filter(k => !got.has(k));
        if (!gained.length && !lost.length) { selectorTotals.equal++; continue; }
        diffs++;
        if (gained.length) selectorTotals.gained++;
        if (lost.length) selectorTotals.lost++;
        if (selectorDiffs.length < LIMIT) selectorDiffs.push({ selector, state: state.id, gained: gained.map(k => k ?? '(runtime)'), lost });
      }
    }
    protoDoc.dom.window.close(); nativeDoc.dom.window.close();
    perState.push({ state: state.id, score: counts.elements ? Math.round((counts.matchedElements / counts.elements) * 10000) / 10000 : 1, selectorsDiff: diffs });
  }
  const score = totals.elements ? Math.round((totals.matchedElements / totals.elements) * 10000) / 10000 : 1;
  return {
    states: perState.length,
    elements: { prototype: totals.elements, matched: totals.matchedElements },
    score,
    classes: { prototype: totals.classes, matched: totals.matchedClasses },
    texts: { prototype: totals.texts, matched: totals.matchedTexts },
    attributes: { prototype: totals.attributes, matched: totals.matchedAttributes },
    selectors: { rules: selectorTotals.rules, selectors: selectorTotals.selectors, equal: selectorTotals.equal, gained: selectorTotals.gained, lost: selectorTotals.lost, skipped: selectorTotals.skipped, diffs: selectorDiffs },
    runtimeUnverified: native.runtimeUnverified ?? [],
    references: native.references ?? [],
    unevaluable: native.unevaluable ?? [],
    perState,
    mismatches: mismatches.slice(0, LIMIT),
    mismatchCount: mismatches.length
  };
}
