// Keyed LCS alignment of trees (docs/PROTOTIPO-NATIVO.md 2.8): per parent, over the child sequences, with the key
// (tag, id, stable classes, key data-* attributes); ties go to document order. Used for state variants, the shell,
// multi-page pages, list items and the fidelity comparison.
import { attr, classes, isElement } from './ir.mjs';

export function keyOf(node) {
  if (!isElement(node)) return '#text';
  const data = (node.a ?? []).filter(([name]) => name.startsWith('data-') && !/^data-(id|delta)$/.test(name)).map(([name]) => name).sort();
  return [node.t, attr(node, 'id') ?? '', data.join(',')].join('|');
}

function jaccard(a, b) {
  if (!a.length && !b.length) return 1;
  const set = new Set(a);
  const common = b.filter(token => set.has(token)).length;
  return common / (new Set([...a, ...b]).size || 1);
}

// Similarity of two nodes (0 = cannot match). Elements match only with the same tag and compatible ids.
export function similarity(a, b, options = {}) {
  const textA = !isElement(a), textB = !isElement(b);
  if (textA || textB) {
    if (!(textA && textB)) return 0;
    const blankA = !String(a.x ?? '').trim(), blankB = !String(b.x ?? '').trim();
    if (blankA !== blankB) return 0;
    return a.x === b.x ? 1.5 : 1;
  }
  const tagA = options.tagOf ? options.tagOf(a) : a.t, tagB = options.tagOf ? options.tagOf(b) : b.t;
  if (tagA !== tagB) return 0;
  const idA = attr(a, 'id'), idB = attr(b, 'id');
  if (idA && idB && idA !== idB && !options.ignoreIds) return 0;
  let score = 1 + 2 * jaccard(options.classesOf ? options.classesOf(a) : classes(a), options.classesOf ? options.classesOf(b) : classes(b));
  if (idA && idA === idB) score += 3;
  const dataA = (a.a ?? []).filter(([name]) => name.startsWith('data-')), dataB = new Map((b.a ?? []).filter(([name]) => name.startsWith('data-')));
  for (const [name, value] of dataA) if (dataB.has(name)) score += dataB.get(name) === value ? 1 : 0.5;
  if (a.icon && b.icon) score += a.icon.name === b.icon.name ? 1 : 0;
  // Other attribute values (href, name, type, aria-*) and the direct text are evidence of the same node.
  const other = new Map((b.a ?? []).filter(([name]) => name !== 'class' && name !== 'id' && name !== 'style' && !name.startsWith('data-')));
  for (const [name, value] of a.a ?? []) if (name !== 'class' && name !== 'id' && name !== 'style' && !name.startsWith('data-') && other.get(name) === value) score += 0.5;
  const ownText = node => (node.c ?? []).filter(child => !isElement(child)).map(child => String(child.x ?? '').trim()).join(' ').trim();
  const textOfA = ownText(a);
  if (textOfA && textOfA === ownText(b)) score += 1;
  return score;
}

// Weighted LCS over two child sequences: returns [[i|null, j|null], ...] in merged document order.
export function alignSequences(listA, listB, options = {}) {
  const n = listA.length, m = listB.length;
  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const sim = Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => similarity(listA[i], listB[j], options)));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = sim[i][j];
      const take = s > 0 ? s + score[i + 1][j + 1] : -1;
      score[i][j] = Math.max(take, score[i + 1][j], score[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    const s = sim[i][j];
    if (s > 0 && Math.abs(score[i][j] - (s + score[i + 1][j + 1])) < 1e-9) { out.push([i, j]); i++; j++; }
    else if (score[i + 1][j] >= score[i][j + 1]) { out.push([i, null]); i++; }
    else { out.push([null, j]); j++; }
  }
  while (i < n) out.push([i++, null]);
  while (j < m) out.push([null, j++]);
  return out;
}

// Full alignment of two trees: Map(nodeA -> nodeB) plus the unmatched nodes of each side.
export function alignTrees(a, b, options = {}) {
  const pairs = new Map(), onlyA = [], onlyB = [];
  const visit = (x, y) => {
    pairs.set(x, y);
    const kidsA = options.childrenOf ? options.childrenOf(x) : x.c ?? [];
    const kidsB = options.childrenOf ? options.childrenOf(y) : y.c ?? [];
    for (const [i, j] of alignSequences(kidsA, kidsB, options)) {
      if (i != null && j != null) visit(kidsA[i], kidsB[j]);
      else if (i != null) collect(kidsA[i], onlyA, options);
      else collect(kidsB[j], onlyB, options);
    }
  };
  if (similarity(a, b, options) > 0) visit(a, b); else { collect(a, onlyA, options); collect(b, onlyB, options); }
  return { pairs, onlyA, onlyB };
}

function collect(node, out, options) {
  out.push(node);
  for (const child of (options.childrenOf ? options.childrenOf(node) : node.c ?? [])) collect(child, out, options);
}

// Text normalization used for "identical renders" (spaces collapsed).
export function normalizedText(node) {
  if (!node) return '';
  if (!isElement(node)) return String(node.x ?? '').replace(/\s+/g, ' ');
  return (node.c ?? []).map(normalizedText).join('');
}

// Structural signature of a subtree without texts, used for repeated groups and skeletons.
export function signature(node, depth = 3, stableClasses = null) {
  if (!isElement(node)) return '';
  const own = node.t + (stableClasses ? '.' + stableClasses(node).join('.') : '');
  if (depth <= 0) return own;
  const kids = (node.c ?? []).filter(isElement).map(child => signature(child, depth - 1, stableClasses));
  return own + '(' + kids.join(',') + ')';
}

// Serialized comparison key of a subtree (attributes and texts, whitespace collapsed).
const RENDER_KEYS = new WeakMap();
export function renderKey(node) {
  if (!node) return '';
  if (!isElement(node)) return String(node.x ?? '').replace(/\s+/g, ' ');
  const cached = RENDER_KEYS.get(node);
  if (cached !== undefined) return cached;
  const key = '<' + node.t + (node.a ?? []).map(([name, value]) => ' ' + name + '="' + value + '"').join('') + (node.icon ? ' icon=' + node.icon.name : '') + '>' + (node.c ?? []).map(renderKey).join('') + '</' + node.t + '>';
  RENDER_KEYS.set(node, key);
  return key;
}
