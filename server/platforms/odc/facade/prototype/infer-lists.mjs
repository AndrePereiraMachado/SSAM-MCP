// Inference over the canonical and explored renders (docs/PROTOTIPO-NATIVO.md 2.8), with closed tables: repeated
// groups, correlation with a collection (key slot first), slot -> field + format (or a join by foreign key), filter and
// order, variants per item and per state as if/classExpr/attrExpr/expr. What no rule explains stays literal from the
// canonical render and is listed; it is never lost.
import { attr, classes, isElement, textOf, walk, canonical } from './ir.mjs';
import { alignSequences, alignTrees, similarity, renderKey } from './align.mjs';
import { explainSlots, explainGroup, explainConcat, explainCount, formatValue } from './formats.mjs';
import { separate, decisionList, evaluate, variablesOf } from './predicates.mjs';
import { ascii } from './names.mjs';

const VOID_TEXT = node => !isElement(node) && !String(node.x ?? '').trim();

function elementKids(node) { return (node.c ?? []).map((child, index) => ({ child, index })).filter(({ child }) => isElement(child)); }

function structureRatio(a, b) {
  const { pairs, onlyA, onlyB } = alignTrees(a, b);
  const count = node => { let n = 0; walk(node, current => { if (isElement(current)) n++; }); return n; };
  const matched = [...pairs.keys()].filter(isElement).length;
  return matched / Math.max(count(a), count(b), 1) - 0 * (onlyA.length + onlyB.length);
}

// The inline style of a classless element is its class (a React prototype styles every element inline): two siblings are
// items of one list only when they set the same style properties (the values may vary: the last row without its border), and
// two icons or drawn svgs only when they are the same drawing. The two lines of a hero (a label and a big clock), the three
// lines of a button, the signal and the battery of a status bar are siblings, never a list (2.8, "Grupo repetido").
function styleKeys(node) {
  const style = attr(node, 'style');
  if (!style) return '';
  return [...new Set(String(style).split(';').map(part => part.split(':')[0].trim().toLowerCase()).filter(Boolean))].sort().join(',');
}
function textShape(node) {
  if (!isElement(node)) return String(node.x ?? '').trim() ? 'x' : '';
  return node.t + '(' + (node.c ?? []).map(textShape).filter(Boolean).join(',') + ')';
}
function sameKind(a, b) {
  if ((a.icon || b.icon) && a.icon?.name !== b.icon?.name) return false;
  if ((a.svg || b.svg) && a.svg !== b.svg) return false;
  if (!classes(a).length && !classes(b).length && styleKeys(a) !== styleKeys(b)) return false;
  return true;
}

// Repeated groups: consecutive sibling elements with the same tag, a common class (or none), similar structure, >= 2.
export function repeatedGroups(root, path = [], out = []) {
  if (!isElement(root)) return out;
  const kids = elementKids(root);
  let run = [];
  const flush = () => {
    // two classless siblings are a list only when they are written alike down to their text nodes (two cards "Trabalhadas
    // 176:00" and "Saldo +06:30" are two panels, not the rows of a collection)
    // (a pair styled differently, a small label over a big title, is two lines of one panel too: a pair is a list only when
    // its two elements carry the same inline style)
    if (run.length === 2 && !classes(run[0].child).length && !classes(run[1].child).length
      && (textShape(run[0].child) !== textShape(run[1].child) || String(attr(run[0].child, 'style') ?? '') !== String(attr(run[1].child, 'style') ?? ''))) run = [];
    if (run.length >= 2) {
      const common = run.map(item => new Set(classes(item.child))).reduce((acc, set) => new Set([...acc].filter(token => set.has(token))));
      out.push({ parent: root, path, items: run.map(item => ({ node: item.child, index: item.index })), mode: run.length === kids.length ? 'self' : 'wrap', stable: [...common] });
    }
    run = [];
  };
  for (const item of kids) {
    const last = run[run.length - 1];
    if (last) {
      const a = last.child, b = item.child;
      const ca = classes(a), cb = classes(b);
      const sameClass = (!ca.length && !cb.length) || ca.some(token => cb.includes(token));
      const between = (root.c ?? []).slice(last.index + 1, item.index).every(VOID_TEXT);
      if (a.t === b.t && sameClass && sameKind(run[0].child, b) && between && structureRatio(run[0].child, b) >= 0.6 && !attr(a, 'id') && !attr(b, 'id')) { run.push(item); continue; }
    }
    flush();
    run = [item];
  }
  flush();
  for (const { child, index } of kids) repeatedGroups(child, path.concat(index), out);
  return out;
}

// Slots of a group: every node of the first item aligned with its counterpart in each item.
function slotsOf(items) {
  const base = items[0];
  const maps = items.map(item => alignTrees(base, item).pairs);
  const slots = [];
  walk(base, node => {
    const values = maps.map(map => map.get(node) ?? null);
    slots.push({ node, values });
  });
  // Nodes present only in other items (optional nodes absent from the first item): the subtree of the first item that
  // has one, placed under the counterpart of its parent after the counterpart of its previous sibling; its presence and
  // its inner slots come from aligning that item with every other item.
  const alignments = new Map();
  const aligned = (i, j) => { const key = i + ',' + j; if (!alignments.has(key)) alignments.set(key, alignTrees(items[i], items[j]).pairs); return alignments.get(key); };
  for (let i = 1; i < items.length; i++) {
    const { pairs, onlyB } = alignTrees(base, items[i]);
    const only = new Set(onlyB);
    const inverse = new Map([...pairs].map(([a, b]) => [b, a]));
    const parentOf = new Map();
    walk(items[i], node => { for (const child of node.c ?? []) parentOf.set(child, node); });
    for (const node of onlyB) {
      if (!isElement(node) || only.has(parentOf.get(node))) continue;
      if (slots.some(slot => slot.extra && slot.values[i] === node)) continue;
      const parent = inverse.get(parentOf.get(node));
      if (!parent) continue;
      const siblings = parentOf.get(node).c ?? [];
      let after = null;
      for (let s = siblings.indexOf(node) - 1; s >= 0 && after === null; s--) if (inverse.has(siblings[s])) after = inverse.get(siblings[s]);
      const valuesOf = target => items.map((item, j) => j === i ? target : j === 0 ? null : aligned(i, j).get(target) ?? null);
      slots.push({ node: null, extra: node, from: i, parent, after, values: valuesOf(node) });
      walk(node, inner => { if (inner !== node) slots.push({ node: null, extra: inner, inner: true, from: i, values: valuesOf(inner) }); });
    }
  }
  return slots;
}

function rowIndex(rows, key, value) { return rows.findIndex(row => String(row[key]) === String(value)); }

function joinValue(meta, state, collection, row, via, field) {
  const target = meta.ref(collection, via);
  if (!target) return undefined;
  const key = meta.key(target);
  const other = (state[target] ?? []).find(item => String(item[key]) === String(row[via]));
  return other ? other[field] : undefined;
}

// Field candidates of a collection: own fields, then fields of collections it references (one join).
function fieldCandidates(meta, collection) {
  const record = meta.byName.get(collection);
  if (!record) return [];
  const out = record.fields.map(field => ({ name: field.name, type: field.type }));
  for (const reference of record.references) {
    const target = meta.byName.get(reference.collection);
    for (const field of target?.fields ?? []) if (field.name !== target.key) out.push({ name: field.name, via: reference.field, type: field.type, collection: reference.collection });
  }
  return out;
}

function valueOfField(meta, state, collection, row, field) {
  return field.via ? joinValue(meta, state, collection, row, field.via, field.name) : row[field.name];
}

// Correlation with a collection (2.8): the key slot (data-*, href) orders the rows; slots explained by fields.
function weight(how) {
  if (!how) return 0;
  if (how.lit !== undefined) return 0;
  // cases weigh only when a branch value (not a predicate) reads a field.
  if (how.fmt === 'cases') return [...(how.cases ?? []).map(item => item.value), how.else].some(value => value && typeof value === 'object' && JSON.stringify(value).includes('"field"')) ? 1 : 0;
  if (how.expr) return weight(how.expr);
  if (how.tokens) return how.tokens.length && !how.unexplained?.length ? 1 : 0;
  if (how.when !== undefined) return how.when ? 1 : 0;
  return how.fmt ? 2 : 0;
}

function lexGreater(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function correlate(group, meta, state, { locale, tz, context = {} } = {}) {
  const items = group.items.map(item => item.node);
  const slots = slotsOf(items);  let best = null;
  for (const collection of meta.collections) {
    const rows = state[collection.name] ?? [];
    if (!rows.length || collection.key === '#') continue;
    let assignment = null, keySlot = null;
    for (const slot of slots) {
      if (!slot.node || !isElement(slot.node)) continue;
      for (const [name] of slot.node.a ?? []) {
        if (!(name.startsWith('data-') || name === 'href' || name === 'value' || name === 'id')) continue;
        const values = slot.values.map(node => node ? attr(node, name) : null);
        if (values.some(value => value == null)) continue;
        for (const fmt of ['text', 'suffix']) {
          const keys = values.map(value => fmt === 'text' ? value : (String(value).match(/(\d+)$/) ?? [])[1]);
          const indexes = keys.map(value => value == null ? -1 : rowIndex(rows, collection.key, value));
          if (indexes.every(index => index >= 0) && new Set(indexes).size === indexes.length) { assignment = indexes; keySlot = { node: slot.node, attr: name, fmt }; break; }
        }
        if (assignment) break;
      }
      if (assignment) break;
    }
    if (!assignment) {
      // Without a key slot: the first text slot whose values equal one field of distinct rows.
      for (const slot of slots) {
        if (!slot.node || isElement(slot.node)) continue;
        const values = slot.values.map(node => node ? String(node.x).trim() : null);
        if (values.some(value => !value || value.length < 2 || /^[\d\s.,#-]+$/.test(value)) || new Set(values).size !== values.length) continue;
        for (const field of collection.fields.filter(item => item.type === 'Text')) {
          const indexes = values.map(value => rows.findIndex(row => String(row[field.name] ?? '').trim() === value));
          if (indexes.every(index => index >= 0) && new Set(indexes).size === indexes.length) { assignment = indexes; break; }
        }
        if (assignment) break;
      }
    }
    if (!assignment) {
      // The key slot names a record this row references (a proposal's row links to its property, #/imovel/101): the rows
      // of the collection by that foreign key, each item its own row in collection order.
      for (const slot of slots) {
        if (!slot.node || !isElement(slot.node)) continue;
        for (const [name] of slot.node.a ?? []) {
          if (!(name.startsWith('data-') || name === 'href' || name === 'value')) continue;
          const values = slot.values.map(node => node ? attr(node, name) : null);
          if (values.some(value => value == null)) continue;
          for (const reference of collection.references ?? []) {
            for (const fmt of ['text', 'suffix']) {
              const keys = values.map(value => fmt === 'text' ? value : (String(value).match(/(\d+)$/) ?? [])[1]);
              const used = new Set();
              const indexes = keys.map(value => { if (value == null) return -1; const index = rows.findIndex((row, i) => !used.has(i) && String(row[reference.field]) === String(value)); if (index >= 0) used.add(index); return index; });
              if (indexes.every(index => index >= 0)) { assignment = indexes; keySlot = { node: slot.node, attr: name, fmt, via: reference.field }; break; }
            }
            if (assignment) break;
          }
          if (assignment) break;
        }
        if (assignment) break;
      }
    }
    if (!assignment) {
      // A text slot showing a field of a record this row references (the property's title in a received proposal's row):
      // the rows by that foreign key, each item its own row in collection order.
      for (const slot of slots) {
        if (!slot.node || isElement(slot.node)) continue;
        const values = slot.values.map(node => node ? String(node.x).trim() : null);
        if (values.some(value => !value || value.length < 3 || /^[\d\s.,#-]+$/.test(value))) continue;
        for (const reference of collection.references ?? []) {
          const target = meta.byName.get(reference.collection);
          const targetRows = state[reference.collection] ?? target?.rows ?? [];
          if (!target || target.key === '#') continue;
          for (const field of target.fields.filter(item => item.type === 'Text')) {
            const used = new Set();
            const indexes = values.map(value => {
              const keys = targetRows.filter(row => String(row[field.name] ?? '').trim() === value).map(row => String(row[target.key]));
              const index = rows.findIndex((row, i) => !used.has(i) && keys.includes(String(row[reference.field])));
              if (index >= 0) used.add(index);
              return index;
            });
            if (indexes.every(index => index >= 0)) { assignment = indexes; break; }
          }
          if (assignment) break;
        }
        if (assignment) break;
      }
    }
    if (!assignment) continue;
    const assigned = assignment.map(index => rows[index]);
    // the candidates are weighed without the composite texts (several fields in one text): those are read once, for the
    // collection chosen
    const explained = explainGroupSlots(slots, assigned, collection.name, meta, state, { locale, tz, composite: false });
    // Every slot shown through a foreign key weighs half, unless the list shows the whole collection through it (the
    // members of a set: the favorites as their properties): a list of properties explains a title directly, a list of
    // proposals only through its property.
    const wholeSet = assigned.length === rows.length && (collection.references ?? []).length > 0 && collection.fields.every(field => field.name === collection.key || (collection.references ?? []).some(reference => reference.field === field.name) || field.name === 'ordem');
    const viaWeight = how => (!wholeSet && how && JSON.stringify(how).includes('"via"') ? 0.5 : 1);
    let score = keySlot ? 1 : 0;
    for (const item of explained) { score += weight(item.how) * viaWeight(item.how); for (const value of Object.values(item.attrs)) score += weight(value) * viaWeight(value); if (item.if) score += 1; if (item.icon?.fmt) score += 1; }
    const filter = listFilter(meta, state, collection.name, assigned, context);
    // The rows shown are exactly the members another collection holds (a Set of favorites): no field range that happens to
    // separate them is the rule; the list of that collection is.
    const presentKeys = new Set(assigned.map(row => String(row[collection.key])));
    const memberOf = rows.length > assigned.length && meta.collections.some(other => other.name !== collection.name && (other.rows ?? []).length === assigned.length
      && (other.references ?? []).some(reference => reference.collection === collection.name && (state[other.name] ?? other.rows).every(row => presentKeys.has(String(row[reference.field])))
        && new Set((state[other.name] ?? other.rows).map(row => String(row[reference.field]))).size === presentKeys.size));
    if ((!filter || !filter.unexplained) && !memberOf) score += 2;
    // the set's own list explains which rows show; this one would need a rule it does not have
    if (memberOf) score -= 2;
    let coverage = 0;
    for (const [i, node] of items.entries()) { const text = textOf(node); if (collection.fields.some(field => field.type === 'Text' && String(assigned[i][field.name] ?? '').length >= 3 && text.includes(String(assigned[i][field.name])))) coverage++; }
    const rank = [score, coverage, meta.extraNames.includes(collection.name) ? 0 : 1];    if (!best || lexGreater(rank, best.rank)) best = { collection: collection.name, rows: assigned, indexes: assignment, keySlot, slots: explained, score, rank, filter };
  }
  if (!best || best.score < 3) return null;
  best.slots = explainGroupSlots(slots, best.rows, best.collection, meta, state, { locale, tz });
  return best;
}

// Correlation of a group whose first (or last) item is a constant (e.g. "Todos" + the categories): the list covers the
// remaining items and the constant item stays literal next to it.
export function correlatePartial(group, meta, state, options) {
  const full = correlate(group, meta, state, options);
  if (full) return { ...full, start: 0, count: group.items.length };
  if (group.items.length < 3) return null;
  for (const [start, count] of [[1, group.items.length - 1], [0, group.items.length - 1]]) {
    const sub = { ...group, items: group.items.slice(start, start + count), mode: 'wrap' };
    const found = correlate(sub, meta, state, options);
    if (found) return { ...found, start, count, items: sub.items, mode: 'wrap', constant: start === 1 ? [group.items[0]] : [group.items[group.items.length - 1]] };
  }
  return null;
}

// A Text field is a variable only when it is categorical: code-like values (non-empty, no whitespace) repeated across
// rows, few distinct values (a role, a status code); names and descriptions never are.
function categoricalText(rows, name) {
  const values = rows.map(row => row[name]);
  if (!values.length || values.some(value => typeof value !== 'string' || !value || /\s/.test(value))) return false;
  const distinct = new Set(values).size;
  return distinct < values.length && distinct <= Math.max(2, Math.floor(rows.length / 2));
}

export function fieldVars(meta, collection, rows) {
  const record = meta.byName.get(collection);
  return fieldCandidates(meta, collection).filter(field => !field.via && field.name !== record?.key && field.type !== 'DateTime' && (field.type !== 'Text' || categoricalText(rows, field.name))).map(field => {
    const values = rows.map(row => row[field.name]);
    const distinct = new Set(values.map(String)).size;
    const isFk = meta.byName.get(collection)?.references.some(reference => reference.field === field.name);
    return { name: field.name, type: field.type, lowCardinality: field.type === 'Boolean' || isFk || distinct <= Math.max(2, Math.floor(rows.length / 2)) };
  });
}

// Explains each slot of a correlated group: field + format, cases by predicates, presence by predicate.
function explainGroupSlots(slots, rows, collection, meta, state, { locale, tz, composite = true }) {
  const allRows = state[collection] ?? rows;
  const vars = { fields: fieldVars(meta, collection, allRows) };
  const ctxOf = row => ({ row, join: (via, field) => joinValue(meta, state, collection, row, via, field) });
  const out = [];
  for (const slot of slots) {
    const present = slot.values.map(node => Boolean(node));
    const entry = { slot, how: null, attrs: {} };
    if (present.some(value => !value)) {
      const positives = rows.filter((row, i) => present[i]).map(ctxOf), negatives = rows.filter((row, i) => !present[i]).map(ctxOf);
      entry.if = separate(vars, positives, negatives);
      entry.ifUnexplained = !entry.if;
    }
    const nodes = slot.values.filter(Boolean);
    const rowsPresent = rows.filter((row, i) => present[i]);
    const ref = slot.node ?? slot.extra;
    if (!isElement(ref)) {
      const texts = slot.values.map(node => node ? String(node.x) : null).filter(value => value !== null);
      if (new Set(texts).size > 1) entry.how = explainText(texts, rowsPresent, collection, meta, state, vars, ctxOf, { locale, tz, composite });
      out.push(entry);
      continue;
    }
    for (const [name] of ref.a ?? []) {
      if (ref.icon && (name === 'data-lucide' || name === 'class')) continue;
      const values = nodes.map(node => attr(node, name));
      if (values.some(value => value === null) || new Set(values).size <= 1) continue;
      if (name === 'class') entry.attrs.class = explainClass(values, rowsPresent, collection, meta, state, vars, ctxOf, { locale, tz, composite });
      else entry.attrs[name] = explainText(values, rowsPresent, collection, meta, state, vars, ctxOf, { locale, tz, composite });
    }
    // Attributes present in some items only (disabled, title).
    const names = new Set(nodes.flatMap(node => (node.a ?? []).map(([name]) => name)));
    for (const name of names) {
      if (entry.attrs[name]) continue;
      const has = nodes.map(node => attr(node, name) !== null);
      if (has.every(Boolean)) continue;
      const positives = rowsPresent.filter((row, i) => has[i]).map(ctxOf), negatives = rowsPresent.filter((row, i) => !has[i]).map(ctxOf);
      const values = nodes.map(node => attr(node, name)).filter(value => value !== null);
      entry.attrs[name] = { when: separate(vars, positives, negatives), then: new Set(values).size === 1 ? values[0] : explainText(values, rowsPresent.filter((row, i) => has[i]), collection, meta, state, vars, ctxOf, { locale, tz, composite }), optional: true };
    }
    if (ref.icon) {
      const icons = nodes.map(node => node.icon?.name);
      if (new Set(icons).size > 1) entry.icon = casesBy(icons, rowsPresent.map(ctxOf), vars);
    }
    out.push(entry);
  }
  return out;
}

function varOf(pred) {
  if (!pred) return null;
  if (pred.op === 'and' || pred.op === 'or') { const names = pred.a.map(varOf); return names.every(name => name && name === names[0]) ? names[0] : null; }
  return JSON.stringify(pred.l ?? null);
}

// Strict decision lists: every branch is one variable (a lookup table or thresholds of one field), and the groups are
// not all singletons (that would only restate the observed rows).
export function strictCases(vars, groups) {
  if (groups.length < 2) return null;
  const decision = decisionList(vars, groups);
  if (!decision) return null;
  const names = decision.filter(item => item.when).map(item => varOf(item.when));
  if (names.some(name => !name) || new Set(names).size !== 1) return null;
  if (groups.every(group => group.contexts.length === 1)) {
    // Only a lookup by a categorical field (foreign key, boolean, few values) restates no row.
    const field = vars.fields?.find(item => JSON.stringify({ field: item.name }) === names[0]);
    if (!field?.lowCardinality || !decision.filter(item => item.when).every(item => item.when.op === 'eq' || item.when.op === 'truthy' || item.when.op === 'not')) return null;
  }
  return decision;
}

function casesBy(values, contexts, vars) {
  const groups = new Map();
  values.forEach((value, i) => { const key = JSON.stringify(value); if (!groups.has(key)) groups.set(key, { value, contexts: [] }); groups.get(key).contexts.push(contexts[i]); });
  if (groups.size === 1) return { lit: values[0] };
  const decision = strictCases(vars, [...groups.values()].map(group => ({ contexts: group.contexts, value: group.value })));
  if (!decision) return null;
  return { fmt: 'cases', cases: decision.filter(item => item.when).map(item => ({ when: item.when, value: item.group.value })), else: decision[decision.length - 1].group.value };
}

function explainTextDirect(texts, rows, collection, meta, state, { locale, tz }) {
  if (new Set(texts).size < 2) return null;
  for (const field of fieldCandidates(meta, collection)) {
    const values = rows.map(row => valueOfField(meta, state, collection, row, field));
    if (values.some(value => value === undefined || value === null)) continue;
    if (new Set(values.map(String)).size === 1) continue;
    const found = explainSlots(texts, values, { locale, tz });
    if (found) return { fmt: found.fmt, value: field.via ? { field: field.name, via: field.via } : { field: field.name }, prefix: found.prefix, suffix: found.suffix, locale };
  }
  return null;
}

// Several fields of the item in one text ("{Bairro}, {Cidade} · {Tipo}"): a concat of field formats, the literals the
// same in every item; a count with its noun ("1 vaga" / "2 vagas"): cases on the count being 1.
function explainTextComposite(texts, rows, collection, meta, state, { locale, tz }) {
  const fields = fieldCandidates(meta, collection);
  const columns = fields.map(field => ({ field, values: rows.map(row => valueOfField(meta, state, collection, row, field)) }));
  const valueOf = field => (field.via ? { field: field.name, via: field.via } : { field: field.name });
  const concat = explainConcat(texts, columns, { locale, tz });
  if (concat) return { fmt: 'concat', parts: concat.parts.map(part => ({ fmt: part.fmt, value: valueOf(columns[part.column].field), prefix: part.prefix, suffix: part.suffix, locale })), prefix: '', suffix: '', locale };
  const count = explainCount(texts, columns);
  if (count) {
    const value = valueOf(columns[count.column].field);
    return { fmt: 'cases', cases: [{ when: { op: 'eq', l: value, r: { lit: 1 } }, value: { fmt: 'integer', value, prefix: count.one.prefix, suffix: count.one.suffix, locale } }],
      else: { fmt: 'integer', value, prefix: count.other.prefix, suffix: count.other.suffix, locale }, plural: true };
  }
  return null;
}

// A text slot: one field + format with constant prefix/suffix, else several fields or a count with its noun, else cases
// (decision list over templates).
function explainText(texts, rows, collection, meta, state, vars, ctxOf, { locale, tz, composite: withComposite = true }) {
  const fields = fieldCandidates(meta, collection);
  const direct = explainTextDirect(texts, rows, collection, meta, state, { locale, tz });
  if (direct) return direct;
  const composite = withComposite ? explainTextComposite(texts, rows, collection, meta, state, { locale, tz }) : null;
  if (composite) return composite;
  // cases: group items by text template (a field value replaced by a placeholder when one explains part of it).
  const templates = texts.map((text, i) => {
    for (const field of fields) {
      const value = valueOfField(meta, state, collection, rows[i], field);
      if (value === undefined || value === null || String(value) === '' || typeof value === 'boolean') continue;
      const found = explainGroup([text], [value], { locale, tz });
      if (found && (found.fmt !== 'text' || String(value).length > 2)) {
        return { key: found.prefix + '\u0000' + found.suffix + '|' + field.name + '|' + found.fmt, expr: { fmt: found.fmt, value: field.via ? { field: field.name, via: field.via } : { field: field.name }, prefix: found.prefix, suffix: found.suffix, locale }, weak: weakTemplate(text, found) };
      }
    }
    return { key: 'lit|' + text, expr: { lit: text } };
  });
  demoteWeak(templates, texts);
  const groups = new Map();
  templates.forEach((template, i) => { if (!groups.has(template.key)) groups.set(template.key, { expr: template.expr, contexts: [] }); groups.get(template.key).contexts.push(ctxOf(rows[i])); });
  if (groups.size === 1) return [...groups.values()][0].expr.lit !== undefined ? null : [...groups.values()][0].expr;
  const decision = strictCases(vars, [...groups.values()].map(group => ({ contexts: group.contexts, expr: group.expr })));
  if (!decision) return null;
  return { fmt: 'cases', cases: decision.filter(item => item.when).map(item => ({ when: item.when, value: item.group.expr })), else: decision[decision.length - 1].group.expr };
}

// class: optional tokens by predicate; computed tokens by field + format over the whole attribute value.
function explainClass(values, rows, collection, meta, state, vars, ctxOf, options) {
  const whole0 = explainTextDirect(values, rows, collection, meta, state, options);
  if (whole0) return { expr: whole0 };
  const tokenLists = values.map(value => String(value).split(/\s+/).filter(Boolean));
  const all = [...new Set(tokenLists.flat())];
  const base = all.filter(token => tokenLists.every(list => list.includes(token)));
  const optional = all.filter(token => !base.includes(token));
  const tokens = [];
  let missing = false;
  for (const token of optional) {
    const has = tokenLists.map(list => list.includes(token));
    const when = separate(vars, rows.filter((row, i) => has[i]).map(ctxOf), rows.filter((row, i) => !has[i]).map(ctxOf), { maxTerms: 1 });
    if (when) tokens.push({ token, when });
    else missing = true;
  }
  if (!missing && tokens.length) return { base: base.join(' '), tokens };
  // Mutually exclusive tokens -> the whole value by a strict decision list (e.g. zero-stock / low-stock / muted-cell).
  const whole = explainText(values, rows, collection, meta, state, vars, ctxOf, options);
  if (whole) return { expr: whole };
  return { base: base.join(' '), tokens, unexplained: optional.filter(token => !tokens.some(item => item.token === token)), raw: values };
}

// Filter (2.8): the first predicate that separates exactly the rows present; order: seed order, one field asc/desc,
// boolean desc + seed order, two fields.
export function listFilter(meta, state, collection, presentRows, context = {}) {
  const rows = state[collection] ?? [];
  const absent = rows.filter(row => !presentRows.includes(row));
  if (!absent.length) return null;
  const fields = fieldVars(meta, collection, rows);
  const params = Object.keys(context.params ?? {});
  const dims = context.dims ?? [];
  const base = { params: context.params ?? {}, dims: Object.fromEntries(dims.map(dim => [dim.key, dim.value])) };
  const ctx = row => ({ ...base, row, join: (via, field) => joinValue(meta, state, collection, row, via, field) });
  // field = <parameter> / <dimension> (e.g. PedidoId = Id of the screen).
  const candidates = fields.map(field => field.name).concat((meta.byName.get(collection)?.references ?? []).map(reference => reference.field));
  const separates = pred => presentRows.every(row => evaluate(pred, ctx(row))) && absent.every(row => !evaluate(pred, ctx(row)));
  for (const name of [...new Set(candidates)]) {
    for (const param of params) { const pred = { op: 'eq', l: { field: name }, r: { param } }; if (separates(pred)) return pred; }
    for (const dim of dims) { const pred = { op: 'eq', l: { field: name }, r: { dim: dim.key } }; if (separates(pred)) return pred; }
  }
  // through a foreign key: the proposals received for the session owner's listings (Imovel.ProprietarioId = the session)
  for (const reference of meta.byName.get(collection)?.references ?? []) {
    const target = meta.byName.get(reference.collection);
    for (const field of (target?.fields ?? []).filter(item => item.name !== target.key)) {
      for (const dim of dims) { const pred = { op: 'eq', l: { field: field.name, via: reference.field }, r: { dim: dim.key } }; if (separates(pred)) return pred; }
      for (const param of params) { const pred = { op: 'eq', l: { field: field.name, via: reference.field }, r: { param } }; if (separates(pred)) return pred; }
    }
  }
  const own = separate({ fields }, presentRows.map(ctx), absent.map(ctx), { maxTerms: 1 });
  if (own) return own;
  const pair = separate({ fields }, presentRows.map(ctx), absent.map(ctx));
  if (pair && pair.op === 'and' && JSON.stringify(pair.a[0].l) === JSON.stringify(pair.a[1].l)) return pair;
  return { unexplained: true };
}

export function listSort(meta, state, collection, presentRows) {
  const rows = state[collection] ?? [];
  const seed = presentRows.map(row => rows.indexOf(row));
  if (seed.every((value, i) => i === 0 || value > seed[i - 1])) return [];
  const record = meta.byName.get(collection);
  const compare = (a, b, field, dir) => {
    const x = a[field], y = b[field];
    const result = typeof x === 'number' && typeof y === 'number' ? x - y : typeof x === 'boolean' ? Number(x) - Number(y) : String(x ?? '').localeCompare(String(y ?? ''), 'pt-BR');
    return dir === 'desc' ? -result : result;
  };
  const sortedBy = criteria => [...presentRows].sort((a, b) => { for (const { field, dir } of criteria) { const c = compare(a, b, field, dir); if (c) return c; } return rows.indexOf(a) - rows.indexOf(b); });
  const same = list => list.every((row, i) => row === presentRows[i]);
  for (const field of record?.fields ?? []) for (const dir of ['asc', 'desc']) if (same(sortedBy([{ field: field.name, dir }]))) return [{ field: field.name, dir }];
  for (const field of (record?.fields ?? []).filter(item => item.type === 'Boolean')) if (same(sortedBy([{ field: field.name, dir: 'desc' }]))) return [{ field: field.name, dir: 'desc' }];
  for (const first of record?.fields ?? []) for (const second of record?.fields ?? []) for (const d1 of ['asc', 'desc']) for (const d2 of ['asc', 'desc']) if (first !== second && same(sortedBy([{ field: first.name, dir: d1 }, { field: second.name, dir: d2 }]))) return [{ field: first.name, dir: d1 }, { field: second.name, dir: d2 }];
  return null;
}

// Lists of a render: correlated repeated groups (best collection per group); nested groups inside items included.
export function findLists(root, meta, state, options = {}) {
  const lists = [];
  for (const group of repeatedGroups(root)) {
    const found = correlatePartial(group, meta, state, options);
    if (found) lists.push({ ...group, ...found });
  }
  // One collection shown as several lists, each a part of its rows that no rule tells apart (VisitaCerta 2026-10-12: the
  // agenda groups its visits by day, one section per date): rows grouped by something a list filter cannot say. As lists of
  // the collection every section would show every row; they stay as rendered (2.8: what no rule explains stays literal).
  const split = new Map();
  for (const list of lists) if (list.filter?.unexplained) { if (!split.has(list.collection)) split.set(list.collection, []); split.get(list.collection).push(list); }
  const grouped = new Set([...split.values()].filter(parts => parts.length >= 2 && disjointRows(parts)).flat());
  return grouped.size ? lists.filter(list => !grouped.has(list)) : lists;
}
function disjointRows(parts) {
  const seen = new Set();
  for (const part of parts) for (const row of part.rows ?? []) { if (seen.has(row)) return false; seen.add(row); }
  return true;
}

// ---- union of variants -----------------------------------------------------------------------------------------------

// Merges trees of one region (each with a context) into a union tree; every union node records in which contexts it
// is present and its value in each one (attributes, text, icon).
export function unionTrees(trees) {
  const clone = node => isElement(node) ? { t: node.t, a: node.a, icon: node.icon, svg: node.svg, c: [], presence: [], variants: [], origin: node } : { x: node.x, presence: [], variants: [], origin: node };
  const build = (node, ctxIndex) => {
    const out = clone(node);
    out.presence[ctxIndex] = true;
    out.variants[ctxIndex] = node;
    if (isElement(node)) out.c = (node.c ?? []).map(child => build(child, ctxIndex));
    return out;
  };
  if (!trees.length) return null;
  const union = build(trees[0], 0);
  const merge = (target, node, ctxIndex) => {
    target.presence[ctxIndex] = true;
    target.variants[ctxIndex] = node;
    if (!isElement(node)) return;
    // a list run pairs only with the same list's run (the empty-state row of a render without items stays its own node)
    const pairs = alignSequences(target.c.map(child => child.variants.find(Boolean) ?? child.origin), node.c ?? [], { tagOf: item => (item?.listRun ? '#list:' + item.listRun.id : item.t) });
    const next = [];
    for (const [i, j] of pairs) {
      if (i != null && j != null) { merge(target.c[i], node.c[j], ctxIndex); next.push(target.c[i]); }
      else if (i != null) next.push(target.c[i]);
      else next.push(build(node.c[j], ctxIndex));
    }
    target.c = next;
  };
  for (let index = 1; index < trees.length; index++) merge(union, trees[index], index);
  return union;
}

// ---- annotated regions ----------------------------------------------------------------------------------------------

function sourceVal(name) {
  const [kind, rest] = [name.slice(0, name.indexOf(':')), name.slice(name.indexOf(':') + 1)];
  if (kind === 'dim') return { dim: rest };
  if (kind === 'param') return { param: rest };
  if (kind === 'field') return rest.includes('>') ? { field: rest.split('>')[1], via: rest.split('>')[0] } : { field: rest };
  if (kind === 'input') return rest.includes('.') ? { input: rest.split('.')[0], field: rest.split('.')[1] } : { input: rest };
  if (kind === 'record') {
    const [collection, field] = rest.split('.');
    return field.includes('>') ? { record: collection, field: field.split('>')[1], via: field.split('>')[0] } : { record: collection, field };
  }
  if (kind === 'count') return { count: '#' + rest };
  if (kind === 'sum') {
    const [id, expr] = [rest.slice(0, rest.indexOf(':')), rest.slice(rest.indexOf(':') + 1)];
    if (expr.includes('*')) { const [field, joined] = expr.split('*'); const [via, other] = joined.split('>'); return { sum: '#' + id, field, times: { field: other, via } }; }
    return { sum: '#' + id, field: expr };
  }
  return { lit: null };
}

// count / sum of a list of the same screen (2.8 "count / sum"): per tree, from the rows its items show.
function listSources(listData, trees, states, meta) {
  return trees.map((tree, index) => {
    const out = {};
    for (const data of listData) {
      const items = data.perTree[index];
      // A list that is not rendered in this tree (empty state instead of the table) shows no row.
      if (!items) { if (data.perTree[index] === null) out['count:' + data.id] = 0; continue; }
      out['count:' + data.id] = items.length;
      const list = data.list;
      if (!list.keySlot) continue;
      const collection = meta.byName.get(list.collection);
      const state = states[index] ?? {};
      const rows = items.map(item => { let value = null; walk(item, node => { if (value !== null) return false; if (isElement(node) && node.t === list.keySlot.node.t && attr(node, list.keySlot.attr) != null) value = attr(node, list.keySlot.attr); }); return (state[list.collection] ?? []).find(row => String(row[collection.key]) === String(list.keySlot.fmt === 'suffix' ? (String(value).match(/(\d+)$/) ?? [])[1] : value)); }).filter(Boolean);
      if (rows.length !== items.length) continue;
      const numeric = collection.fields.filter(field => (field.type === 'Integer' || field.type === 'Decimal') && field.name !== collection.key && !collection.references.some(reference => reference.field === field.name));
      for (const field of numeric) {
        out['sum:' + data.id + ':' + field.name] = Math.round(rows.reduce((sum, row) => sum + Number(row[field.name] ?? 0), 0) * 100) / 100;
        for (const reference of collection.references) {
          const target = meta.byName.get(reference.collection);
          for (const other of (target?.fields ?? []).filter(item => (item.type === 'Integer' || item.type === 'Decimal') && item.name !== target.key)) {
            const total = rows.reduce((sum, row) => { const linked = (state[reference.collection] ?? target.rows).find(item => String(item[target.key]) === String(row[reference.field])); return sum + Number(row[field.name] ?? 0) * Number(linked?.[other.name] ?? 0); }, 0);
            out['sum:' + data.id + ':' + field.name + '*' + reference.field + '>' + other.name] = Math.round(total * 100) / 100;
          }
        }
      }
    }
    return out;
  });
}

// List references inside a region ({count: '#0'}) become the key of the list parent once it is known.
export function rewriteListRefs(root, ids) {
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const key of ['count', 'sum']) if (typeof value[key] === 'string' && value[key].startsWith('#') && ids.has(value[key].slice(1))) value[key] = ids.get(value[key].slice(1));
    for (const item of Object.values(value)) visit(item);
  };
  walk(root, node => { visit(node.expr); visit(node.attrExpr); visit(node.if); visit(node.classExpr); });
}

// A varying slot explained by the sources of each context (dimension values, block inputs, the screen record), else a
// decision list over the variables (enumerable dimensions, the view): [{when, value}] + else.
function explainVarying(values, contexts, sources, vars, { locale, tz, allowSingletons }) {
  const names = [...new Set(sources.flatMap(source => Object.keys(source ?? {})))].sort();
  // Identity: the value is the source text itself in every context (an input showing its own dimension, even empty).
  for (const name of names) {
    const raw = sources.map(source => source?.[name]);
    if (raw.some(value => typeof value !== 'string') || new Set(raw).size < 2) continue;
    if (values.every((value, i) => value === raw[i])) return { fmt: 'text', value: sourceVal(name), prefix: '', suffix: '', locale };
  }
  for (const name of names) {
    const raw = sources.map(source => source?.[name]);
    if (raw.some(value => value === undefined || value === null)) continue;
    if (new Set(raw.map(String)).size === 1 && new Set(values).size > 1) continue;
    const found = explainSlots(values, raw, { locale, tz });
    if (found) return { fmt: found.fmt, value: sourceVal(name), prefix: found.prefix, suffix: found.suffix, locale };
  }
  // A source whose substr-after/substr-before (or a table format) explains a group of >= 2 contexts.
  const grouped = new Map();
  for (const name of names) {
    const raw = sources.map(source => source?.[name]);
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        if (raw[i] == null || raw[j] == null || typeof raw[i] === 'boolean' || String(raw[i]) === String(raw[j]) || values[i] === values[j]) continue;
        const found = explainSlots([values[i], values[j]], [raw[i], raw[j]], { locale, tz });
        if (!found) continue;
        const members = values.map((value, k) => raw[k] != null && typeof raw[k] !== 'boolean' && explainGroup([value], [raw[k]], { locale, tz, formats: [found.fmt] })?.prefix === found.prefix && value === found.prefix + formatTry(found.fmt, raw[k], tz) + found.suffix).map((ok, k) => ok ? k : -1).filter(k => k >= 0);
        const key = name + '|' + found.fmt + '|' + found.prefix + '\u0000' + found.suffix;
        if (members.length >= 2 && (!grouped.has(key) || grouped.get(key).members.length < members.length)) grouped.set(key, { members, name, expr: { fmt: found.fmt, value: sourceVal(name), prefix: found.prefix, suffix: found.suffix, locale } });
      }
    }
  }
  const bestGroup = [...grouped.values()].sort((a, b) => b.members.length - a.members.length)[0];
  // Templates: one source explains a group of contexts (>= 2 or the only varying part); the rest are literal groups.
  const templates = values.map((value, i) => {
    if (bestGroup?.members.includes(i)) return { key: bestGroup.name + '|' + bestGroup.expr.fmt + '|' + bestGroup.expr.prefix + '\u0000' + bestGroup.expr.suffix, expr: bestGroup.expr };
    for (const name of names) {
      const raw = sources[i]?.[name];
      if (raw === undefined || raw === null || raw === '' || typeof raw === 'boolean' || /^(true|false)$/.test(String(raw))) continue;
      const found = explainGroup([value], [raw], { locale, tz });
      if (found && (found.fmt !== 'text' || String(raw).length > 2)) return { key: name + '|' + found.fmt + '|' + found.prefix + '\u0000' + found.suffix, expr: { fmt: found.fmt, value: sourceVal(name), prefix: found.prefix, suffix: found.suffix, locale }, weak: weakTemplate(value, found) };
    }
    return { key: 'lit|' + value, expr: { lit: value } };
  });
  demoteWeak(templates, values);
  const groups = new Map();
  templates.forEach((template, i) => { if (!groups.has(template.key)) groups.set(template.key, { expr: template.expr, contexts: [] }); groups.get(template.key).contexts.push(contexts[i]); });
  if (groups.size === 1) { const only = [...groups.values()][0].expr; return only.lit !== undefined ? null : only; }
  const list = [...groups.values()].map(group => ({ contexts: group.contexts, expr: group.expr }));
  if (list.length === 2 && list.every(group => group.expr.value && group.expr.fmt && group.expr.lit === undefined) && JSON.stringify(list[0].expr.value) === JSON.stringify(list[1].expr.value) && list[0].expr.fmt === list[1].expr.fmt) {
    const name = [...groups.keys()][0].split('|')[0];
    const raw = values.map((_, i) => sources[i]?.[name]);
    const ones = [...groups.values()].findIndex(group => group.contexts.every(context => raw[contexts.indexOf(context)] === 1));
    if (ones >= 0) return { fmt: 'cases', cases: [{ when: { op: 'eq', l: list[ones].expr.value, r: { lit: 1 } }, value: list[ones].expr }], else: list[1 - ones].expr, plural: true };
  }
  const decision = allowSingletons ? decisionList(vars, list) : strictCases(vars, list);
  if (!decision) return null;
  return { fmt: 'cases', cases: decision.filter(item => item.when).map(item => ({ when: item.when, value: item.group.expr })), else: decision[decision.length - 1].group.expr };
}

// A template seen in one context is weak evidence when the value stands alone (no literal around it) and is shorter
// than 3 characters ("1" = Id 1 by coincidence); a weak template stands only when >= 2 contexts share it.
function weakTemplate(value, found) {
  if (found.prefix || found.suffix) return false;
  return String(value).length < 3;
}

function demoteWeak(templates, values) {
  const counts = new Map();
  for (const template of templates) counts.set(template.key, (counts.get(template.key) ?? 0) + 1);
  templates.forEach((template, i) => { if (template.weak && counts.get(template.key) < 2) templates[i] = { key: 'lit|' + values[i], expr: { lit: values[i] } }; });
}

// An expression that shows a source value (directly or in a branch), not only literals chosen by predicates.
function readsSource(expr) {
  if (!expr || typeof expr !== 'object') return false;
  if (expr.fmt === 'cases') return [...(expr.cases ?? []).map(item => item.value), expr.else].some(value => value && typeof value === 'object' && value.lit === undefined && value.value);
  return Boolean(expr.value);
}

function formatTry(fmt, value, tz) { return formatValue(fmt, value, { tz }) ?? ''; }

function separateContexts(vars, contexts, present) {
  const positives = contexts.filter((_, i) => present[i]), negatives = contexts.filter((_, i) => !present[i]);
  if (!negatives.length) return null;
  return separate(vars, positives, negatives) ?? { unexplained: true };
}

// Locates the counterpart of a canonical list parent in another tree and its items (same tag, a shared class).
function counterpartItems(canonicalRoot, canonicalList, otherRoot) {
  const { pairs } = alignTrees(canonicalRoot, otherRoot);
  const parent = pairs.get(canonicalList.parent);
  if (!parent) return null;
  const sample = canonicalList.items[0].node;
  const common = classes(sample);
  const keySlot = canonicalList.keySlot;
  const keyOf = node => { let value = null; walk(node, current => { if (value !== null) return false; if (isElement(current) && current.t === keySlot.node.t && attr(current, keySlot.attr) != null) value = attr(current, keySlot.attr); }); return value; };
  const keys = keySlot && canonicalList.keys ? new Set(canonicalList.keys.map(String)) : null;
  const items = (parent.c ?? []).map((node, index) => ({ node, index })).filter(({ node }) => isElement(node) && node.t === sample.t && (common.length === 0 ? classes(node).length === 0 : classes(node).some(token => common.includes(token))) && (!canonicalList.constant || !canonicalList.constant.some(constant => renderKey(constant.node) === renderKey(node))) && (!keys || keys.has(String(keySlot.fmt === 'suffix' ? (String(keyOf(node)).match(/(\d+)$/) ?? [])[1] : keyOf(node)))));
  return { parent, items };
}

function collapse(node, runs) {
  const run = runs.get(node);
  const kids = node.c ?? [];
  if (!isElement(node)) return node;
  const out = [];
  for (let i = 0; i < kids.length; i++) {
    if (run && i === run.start) {
      out.push({ t: kids[i]?.t ?? 'div', a: [['data-ssam-list', run.id]], c: [], listRun: run });
      i = run.end;
      continue;
    }
    out.push(collapse(kids[i], runs));
  }
  return { ...node, c: out };
}

// ---- snapshot lists (2.8 "grupo sem coleção correlacionada") ------------------------------------------------------------

// Static content only: a group whose items hold links, buttons, controls, actions or listeners stays literal (its items
// navigate or act one by one); items must share one structure (no optional node); at least one slot varies.
const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'form', 'option', 'label', 'details', 'summary']);
function interactive(node) {
  let found = false;
  walk(node, current => { if (found) return false; if (isElement(current) && (INTERACTIVE.has(current.t) || attr(current, 'data-action') != null || attr(current, 'onclick') != null || attr(current, 'role') === 'button' || (current.L ?? []).length)) found = true; });
  return found;
}

const slotName = node => (classes(node ?? {})[0] ?? node?.t ?? 'slot').split(/[^A-Za-z0-9]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join('') || 'Slot';

function snapshotOf(group) {
  if (group.parent.t === 'select') return null;
  const items = group.items.map(item => item.node);
  if (items.some(interactive)) return null;
  const slots = slotsOf(items);
  if (slots.some(slot => slot.extra || slot.values.some(value => !value))) return null;
  const parentOf = new Map();
  walk(items[0], node => { for (const child of node.c ?? []) parentOf.set(child, node); });
  const taken = new Set();
  const unique = base => { let name = base, n = 2; while (taken.has(name)) name = base + n++; taken.add(name); return name; };
  const attributes = [];
  // An icon whose name varies between items stays literal (no snapshot): icons are not entity values.
  if (slots.some(slot => isElement(slot.node) && slot.node.icon && new Set(slot.values.map(node => node.icon?.name)).size > 1)) return null;
  for (const slot of slots) {
    if (!isElement(slot.node)) {
      const texts = slot.values.map(node => String(node.x));
      if (new Set(texts.map(text => text.trim())).size > 1) attributes.push({ node: slot.node, kind: 'text', name: unique(slotName(parentOf.get(slot.node))), values: texts });
      continue;
    }
    const names = [...new Set(slot.values.flatMap(node => (node.a ?? []).map(([name]) => name)))];
    for (const name of names) {
      const values = slot.values.map(node => attr(node, name));
      if (values.some(value => value === null) || new Set(values).size < 2) { if (values.some(value => value === null) && values.some(value => value !== null)) return null; continue; }
      attributes.push({ node: slot.node, kind: 'attr', attr: name, name: unique(slotName(slot.node) + name.split(/[^A-Za-z0-9]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join('')), values });
    }
  }
  if (!attributes.length) return null;
  // a text keeps the spaces that differ between the items ("%" and " km/h": the space is the second one's own, VisitaCerta
  // 2026-10-12); only the whitespace every item has around it is the template's
  for (const item of attributes.filter(entry => entry.kind === 'text')) {
    const lead = item.values.map(text => text.match(/^\s*/)[0]).reduce((a, b) => a.length <= b.length ? a : b);
    const trail = item.values.map(text => text.match(/\s*$/)[0]).reduce((a, b) => a.length <= b.length ? a : b);
    Object.assign(item, { lead, trail });
  }
  const cut = (item, text) => text.slice(item.lead.length, text.length - item.trail.length);
  return { attributes, rows: items.map((_, i) => Object.fromEntries(attributes.map(item => [item.name, item.kind === 'text' ? cut(item, item.values[i]) : item.values[i]]))) };
}

function sameChildren(a, b) {
  const keys = node => (node.c ?? []).filter(isElement).map(renderKey).join('\u0000');
  return keys(a) === keys(b);
}

// The template of a snapshot list: the first item, each varying slot reading its attribute of the snapshot entity.
export function snapshotTemplate(list, keyPrefix) {
  const byNode = new Map();
  for (const item of list.snapshot.attributes) { if (!byNode.has(item.node)) byNode.set(item.node, []); byNode.get(item.node).push(item); }
  const field = item => ({ fmt: 'text', value: { field: item.name }, prefix: '', suffix: '', locale: null });
  const build = (node, path) => {
    const k = keyPrefix + (path.length ? '/' + path.join('/') : '');
    const own = byNode.get(node) ?? [];
    if (!isElement(node)) {
      const out = { k, x: node.x };
      const text = own.find(item => item.kind === 'text');
      if (text) { const raw = String(node.x); out.expr = { ...field(text), prefix: text.lead ?? raw.match(/^\s*/)[0], suffix: text.trail ?? raw.match(/\s*$/)[0] }; }
      return out;
    }
    const out = { k, t: node.t };
    if (node.a?.length) out.a = node.a.map(pair => [pair[0], pair[1]]);
    if (node.icon) out.icon = node.icon;
    if (node.svg) out.svg = node.svg;
    const attrExpr = Object.fromEntries(own.filter(item => item.kind === 'attr').map(item => [item.attr, field(item)]));
    if (Object.keys(attrExpr).length) out.attrExpr = attrExpr;
    const kids = (node.c ?? []).map((child, index) => build(child, path.concat(index)));
    if (kids.length) out.c = kids;
    return out;
  };
  return build(list.items[0].node, []);
}

// Annotates one region (a view's mount, the shell, a modal's content) over its contexts.
// trees[i] / contexts[i] / sources[i] / states[i]; the canonical context is index 0.
export function annotateRegion({ trees, contexts, sources = [], vars, meta, states, locale, tz, keyPrefix, listContext = {}, allowSingletons = true, constantSources = [] }) {
  const canonicalRoot = trees[0];
  const lists = meta ? findLists(canonicalRoot, meta, states[0], { locale, tz, context: listContext }) : [];
  for (const list of lists) list.anchor = 0;
  // A list the canonical render does not show (the table of the owner's listings before anyone logs in, an empty state):
  // found in the first other render that shows its rows, anchored there; its filter is inferred in that render's context
  // (the session's dimension values). Never rows kept as literals per session.
  if (meta) {
    const claimed = new Set(lists.map(list => list.parent));
    for (let i = 1; i < trees.length; i++) {
      const context = { params: contexts[i]?.params ?? listContext.params ?? {}, dims: (listContext.dims ?? []).map(dim => ({ ...dim, value: contexts[i]?.dims?.[dim.key] ?? dim.value })) };
      const found = findLists(trees[i], meta, states[i], { locale, tz, context });
      if (!found.length) continue;
      const back = new Map([...alignTrees(trees[i], canonicalRoot).pairs].map(([node, counterpart]) => [node, counterpart]));
      for (const list of found) {
        const home = back.get(list.parent) ?? null;
        if (home && claimed.has(home)) continue;
        if (!home && [...claimed].some(parent => parent === list.parent)) continue;
        claimed.add(home ?? list.parent);
        list.anchor = i;
        lists.push(list);
      }
    }
  }
  // Runs of items per tree, by list id.
  const runsPerTree = trees.map(() => new Map());
  const listData = lists.map((list, id) => ({ id: String(id), list, perTree: [] }));
  // the values the key slot shows: the record's key, or the foreign key it links by (a proposal's row by its property)
  for (const data of listData) data.list.keys = [...new Set(states.flatMap(state => (state?.[data.list.collection] ?? []).map(row => String(row[data.list.keySlot?.via ?? meta.key(data.list.collection)]))))];
  for (const data of listData) {
    const anchor = data.list.anchor ?? 0;
    const startIndex = data.list.items[0].index, endIndex = data.list.items[data.list.items.length - 1].index;
    runsPerTree[anchor].set(data.list.parent, { id: data.id, start: startIndex, end: endIndex });
    data.perTree[anchor] = data.list.items.map(item => item.node);
    for (let i = 0; i < trees.length; i++) {
      if (i === anchor) continue;
      const found = counterpartItems(trees[anchor], data.list, trees[i]);
      if (!found || !found.items.length) { data.perTree[i] = found ? [] : null; if (found) runsPerTree[i].set(found.parent, { id: data.id, start: -1, end: -1, empty: true }); continue; }
      runsPerTree[i].set(found.parent, { id: data.id, start: found.items[0].index, end: found.items[found.items.length - 1].index });
      data.perTree[i] = found.items.map(item => item.node);
    }
  }
  // Groups without a correlated collection (2.8): static content groups become snapshot lists.
  if (meta) {
    const covered = new Set();
    for (const list of lists) for (const item of list.items) walk(item.node, node => { covered.add(node); });
    const pairsOf = new Map();
    const counterpart = (i, node) => { if (!pairsOf.has(i)) pairsOf.set(i, alignTrees(canonicalRoot, trees[i]).pairs); return pairsOf.get(i).get(node) ?? null; };
    for (const group of repeatedGroups(canonicalRoot)) {
      if (runsPerTree[0].has(group.parent) || group.items.some(item => covered.has(item.node))) continue;
      const snapshot = snapshotOf(group);
      if (!snapshot) continue;
      const others = trees.map((_, i) => i === 0 ? group.parent : counterpart(i, group.parent));
      const same = others.every((parent, i) => !parent || i === 0 || (!runsPerTree[i].has(parent) && sameChildren(group.parent, parent)));
      if (!same) continue;
      for (const item of group.items) walk(item.node, node => { covered.add(node); });
      const data = { id: String(listData.length), list: { ...group, snapshot }, perTree: [] };
      const start = group.items[0].index, end = group.items[group.items.length - 1].index;
      others.forEach((parent, i) => {
        if (!parent) { data.perTree[i] = null; return; }
        runsPerTree[i].set(parent, { id: data.id, start, end });
        data.perTree[i] = (parent.c ?? []).slice(start, end + 1).filter(isElement);
      });
      listData.push(data);
    }
  }
  const aggregate = meta ? listSources(listData, trees, states, meta) : trees.map(() => ({}));
  sources = trees.map((_, i) => ({ ...(sources[i] ?? {}), ...aggregate[i] }));
  const collapsed = trees.map((tree, i) => collapse(tree, runsPerTree[i]));
  const union = unionTrees(collapsed);
  const map = new Map();
  const unexplained = [];
  const build = (u, path, governing = [], parentPresence = null) => {
    const presentIdx = contexts.map((_, i) => Boolean(u.presence[i]));
    // Presence first: its variables govern the attributes, texts and descendants of the node. A node present exactly
    // where its parent is inherits the parent's condition (no nested If).
    const inherited = parentPresence && presentIdx.every((value, i) => value === parentPresence[i]);
    const presence = !inherited && presentIdx.some(value => !value) ? separateContexts(governing.length ? { ...vars, prefer: governing } : vars, contexts, presentIdx) : null;
    const governed = presence && !presence.unexplained ? [...new Set([...governing, ...variablesOf(presence)])] : governing;
    const vars0 = vars;
    vars = governed.length ? { ...vars0, prefer: governed } : vars0;
    try {
    const firstIdx = presentIdx.indexOf(true);
    const ref = u.variants[0] ?? u.variants[firstIdx];
    const k = keyPrefix + (path.length ? '/' + path.join('/') : '');
    const present = contexts.filter((_, i) => presentIdx[i]);
    const presentSources = sources.filter((_, i) => presentIdx[i]);
    let out;
    if (!isElement(ref)) {
      out = { k, x: ref.x };
      const values = u.variants.filter((_, i) => presentIdx[i]).map(node => node.x);
      if (new Set(values.map(value => value.replace(/\s+/g, ' '))).size > 1) {
        const expr = explainVarying(values, present, presentSources, vars, { locale, tz, allowSingletons });
        if (expr) out.expr = expr; else unexplained.push({ k, kind: 'text', values: [...new Set(values)].slice(0, 5) });
      } else if (constantSources.length && values[0].trim()) {
        // A constant slot that shows a data source (block input, screen record) is bound to it.
        for (const name of [...new Set(presentSources.flatMap(source => Object.keys(source ?? {})))].sort()) {
          if (!constantSources.some(prefix => name.startsWith(prefix))) continue;
          const raw = presentSources.map(source => source?.[name]);
          if (raw.some(value => value === undefined || value === null || String(value).length < 3)) continue;
          const found = explainSlots(values, raw, { locale, tz });
          if (found) { out.expr = { fmt: found.fmt, value: sourceVal(name), prefix: found.prefix, suffix: found.suffix, locale }; break; }
        }
      }
    } else {
      out = { k, t: ref.t };
      const variants = u.variants.filter((_, i) => presentIdx[i]);
      const names = [];
      for (const node of variants) for (const [name] of node.a ?? []) if (!names.includes(name) && name !== 'data-ssam-list') names.push(name);
      const staticAttrs = [], attrExpr = {};
      let classExpr = null;
      for (const name of names) {
        const values = variants.map(node => attr(node, name));
        const has = values.map(value => value !== null);
        if (has.every(Boolean) && new Set(values).size === 1) { staticAttrs.push([name, values[0]]); continue; }
        if (ref.icon && (name === 'class' || name === 'data-lucide')) { if (attr(ref, name) !== null) staticAttrs.push([name, attr(ref, name)]); continue; }
        if (!has.every(Boolean)) {
          const when = separateContexts(vars, present, has);
          const kept = values.filter(value => value !== null);
          attrExpr[name] = { when, then: new Set(kept).size === 1 ? kept[0] : explainVarying(kept, present.filter((_, i) => has[i]), presentSources.filter((_, i) => has[i]), vars, { locale, tz, allowSingletons }) ?? kept[0] };
          if (when?.unexplained) unexplained.push({ k, kind: 'attribute', name });
          if (attr(ref, name) !== null) staticAttrs.push([name, attr(ref, name)]);
          continue;
        }
        if (name === 'class') {
          // A computed token (tile-{n}, status-{id}) is a source with a format, not one predicate per token.
          const computed = explainVarying(values, present, presentSources, vars, { locale, tz, allowSingletons });
          if (computed && readsSource(computed)) { attrExpr.class = computed; staticAttrs.push(['class', attr(ref, 'class')]); continue; }
          const tokenLists = values.map(value => String(value).split(/\s+/).filter(Boolean));
          const all = [...new Set(tokenLists.flat())];
          const base = all.filter(token => tokenLists.every(list => list.includes(token)));
          const tokens = [];
          let ok = true;
          for (const token of all.filter(item => !base.includes(item))) {
            const when = separateContexts(vars, present, tokenLists.map(list => list.includes(token)));
            if (!when || when.unexplained) { ok = false; break; }
            tokens.push({ token, when });
          }
          if (ok) classExpr = { base: base.join(' '), tokens };
          else {
            const expr = explainVarying(values, present, presentSources, vars, { locale, tz, allowSingletons });
            if (expr) attrExpr.class = expr; else unexplained.push({ k, kind: 'attribute', name: 'class' });
          }
          staticAttrs.push(['class', attr(ref, 'class')]);
          continue;
        }
        const expr = explainVarying(values, present, presentSources, vars, { locale, tz, allowSingletons });
        if (expr) attrExpr[name] = expr; else unexplained.push({ k, kind: 'attribute', name });
        staticAttrs.push([name, attr(ref, name) ?? values[0]]);
      }
      // Attribute order of the canonical (or first) variant.
      const order = (ref.a ?? []).map(([name]) => name);
      staticAttrs.sort((a, b) => (order.indexOf(a[0]) + 1 || 999) - (order.indexOf(b[0]) + 1 || 999));
      if (staticAttrs.length) out.a = staticAttrs;
      if (classExpr) out.classExpr = classExpr;
      if (Object.keys(attrExpr).length) out.attrExpr = attrExpr;
      if (ref.icon) {
        out.icon = ref.icon;
        const iconNames = variants.map(node => node.icon?.name);
        if (new Set(iconNames).size > 1) {
          const decision = (allowSingletons ? decisionList : strictCases)(vars, [...new Set(iconNames)].map(name => ({ contexts: present.filter((_, i) => iconNames[i] === name), name })));
          if (decision) out.icon = { ...ref.icon, cases: decision.filter(item => item.when).map(item => ({ when: item.when, name: item.group.name })), else: decision[decision.length - 1].group.name };
        }
      }
      if (ref.svg) out.svg = ref.svg;
      const children = [];
      let listPlaceholder = null;
      for (const child of u.c ?? []) {
        const childRef = child.variants.find(Boolean);
        if (isElement(childRef) && childRef.listRun) { listPlaceholder = { union: child, at: children.length, run: childRef.listRun }; continue; }
        children.push(build(child, path.concat(children.length), governed, presentIdx));
      }
      if (children.length) out.c = children;
      if (listPlaceholder) out.listRef = listPlaceholder;
    }
    if (presence && !presence.unexplained) out.if = presence;
    else if (presence?.unexplained) unexplained.push({ k, kind: 'presence', present: presentIdx.filter(Boolean).length, of: presentIdx.length });
    for (let i = 0; i < contexts.length; i++) if (u.variants[i] && u.variants[i].origin === undefined) map.set(u.variants[i], out);
    for (const variant of u.variants) if (variant) map.set(variant, out);
    return out;
    } finally { vars = vars0; }
  };
  const root = build(union, []);
  // Original (uncollapsed) nodes -> output nodes, through the collapsed copies (they share the leaves).
  const originals = new Map();
  const relink = (original, copy) => {
    if (map.has(copy)) originals.set(original, map.get(copy));
    if (!isElement(original)) return;
    const kids = original.c ?? [], copies = copy.c ?? [];
    let j = 0;
    for (let i = 0; i < kids.length && j < copies.length; i++) {
      if (copies[j]?.listRun && copies[j].listRun.start === i) { i = copies[j].listRun.end; j++; continue; }
      relink(kids[i], copies[j]);
      j++;
    }
  };
  trees.forEach((tree, i) => relink(tree, collapsed[i]));
  return { root, lists: listData, unexplained, map: originals, union };
}

// The items of a keyed list in every render that shows it, each with its row in that render's data (the owner's listings of
// every session, a proposal paused in one of them): the slots explained over all of them, so that a value one render never
// shows (pausado, recusada) is read from its field instead of standing as the constant of the render the list was found in.
// The first items are the list's own (the template is the first of them); an item already seen with the same row and the
// same rendering is not repeated. -> {items, rows, slots} | null (nothing more than the list's own items).
export function pooledList(list, perTree, states, meta, { locale, tz } = {}) {
  if (!list?.collection || !list.keySlot || !Array.isArray(perTree)) return null;
  const anchor = list.anchor ?? 0;
  const key = meta.key(list.collection);
  const linkField = list.keySlot.via ?? key;
  const keyOf = node => {
    let value = null;
    walk(node, current => { if (value !== null) return false; if (isElement(current) && current.t === list.keySlot.node.t && attr(current, list.keySlot.attr) != null) value = attr(current, list.keySlot.attr); });
    return list.keySlot.fmt === 'suffix' ? (String(value).match(/(\d+)$/) ?? [])[1] : value;
  };
  const items = list.items.map(item => item.node), rows = [...list.rows];
  const seen = new Set(items.map((node, i) => String(rows[i]?.[key]) + '\u0000' + canonical(node)));
  perTree.forEach((nodes, i) => {
    if (i === anchor || !nodes?.length) return;
    const all = states[i]?.[list.collection] ?? [];
    const used = new Set();
    for (const node of nodes) {
      const value = keyOf(node);
      if (value == null) continue;
      const index = all.findIndex((row, r) => !used.has(r) && String(row[linkField]) === String(value));
      if (index < 0) continue;
      used.add(index);
      const id = String(all[index][key]) + '\u0000' + canonical(node);
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(node); rows.push(all[index]);
    }
  });
  if (items.length === list.items.length) return null;
  const slots = explainGroupSlots(slotsOf(items), rows, list.collection, meta, states[anchor] ?? {}, { locale, tz });
  return { items: items.map(node => ({ node })), rows, slots };
}

// The template of a correlated list: the first item with the slot annotations of the correlation.
export function listTemplate(list, keyPrefix) {
  const slotMap = new Map(list.slots.filter(entry => entry.slot.node || entry.slot.extra).map(entry => [entry.slot.node ?? entry.slot.extra, entry]));
  // Optional nodes absent from the first item are inserted where slotsOf placed them.
  const insertions = new Map();
  for (const entry of list.slots) {
    if (!entry.slot.extra || entry.slot.inner || !entry.slot.parent) continue;
    if (!insertions.has(entry.slot.parent)) insertions.set(entry.slot.parent, []);
    insertions.get(entry.slot.parent).push({ after: entry.slot.after, node: entry.slot.extra });
  }
  const childrenOf = node => {
    const kids = node.c ?? [], added = insertions.get(node);
    if (!added) return kids;
    const out = added.filter(item => item.after === null).map(item => item.node);
    for (const kid of kids) { out.push(kid); for (const item of added) if (item.after === kid) out.push(item.node); }
    return out;
  };
  const outByNode = new Map(), parentOf = new Map();
  // A slot whose condition is its parent's inherits it (no nested If).
  const sameIf = (a, b) => Boolean(a && b) && JSON.stringify(a) === JSON.stringify(b);
  const build = (node, path, parentIf = null) => {
    const k = keyPrefix + (path.length ? '/' + path.join('/') : '');
    const entry = slotMap.get(node);
    if (!isElement(node)) {
      const out = { k, x: node.x };
      if (entry?.how) out.expr = entry.how;
      if (entry?.if && !sameIf(entry.if, parentIf)) out.if = entry.if;
      outByNode.set(node, out);
      return out;
    }
    const out = { k, t: node.t };
    if (node.a?.length) out.a = node.a.map(pair => [pair[0], pair[1]]);
    if (node.icon) out.icon = entry?.icon?.fmt ? { ...node.icon, cases: entry.icon.cases.map(item => ({ when: item.when, name: item.value })), else: entry.icon.else } : node.icon;
    if (node.svg) out.svg = node.svg;
    if (entry) {
      const attrExpr = {};
      for (const [name, how] of Object.entries(entry.attrs ?? {})) {
        if (!how) continue;
        if (name === 'class' && how.tokens && !how.expr) { out.classExpr = { base: how.base, tokens: how.tokens }; continue; }
        if (name === 'class' && how.expr) { attrExpr.class = how.expr; continue; }
        attrExpr[name] = how;
      }
      if (Object.keys(attrExpr).length) out.attrExpr = attrExpr;
      if (entry.if && !sameIf(entry.if, parentIf)) out.if = entry.if;
    }
    const children = childrenOf(node);
    for (const child of children) parentOf.set(child, node);
    const kids = children.map((child, index) => build(child, path.concat(index), out.if ?? parentIf));
    if (kids.length) out.c = kids;
    outByNode.set(node, out);
    return out;
  };
  const extraAttributes = [];
  const template = build(list.items[0].node, []);
  // Slots that vary between items without explanation: an extra attribute <Slot> of the collection (Text), with the
  // canonical value per key; the template reads it.
  const keyField = list.keyField ?? 'Id';
  const taken = new Set();
  // the name of an extra attribute: the title of its column (a cell of a table row), else the words every value starts with
  // ("Total R$ 2.410" -> Total), else the class or the tag of the element that shows it
  const nameFor = (node, parent, texts = []) => {
    const cell = parent?.t === 'td' ? (parentOf.get(parent)?.c ?? []).filter(isElement).indexOf(parent) : -1;
    const column = cell >= 0 ? ascii(list.headers?.[cell] ?? '').split(/[^A-Za-z0-9]+/).filter(word => word.length >= 2).slice(0, 3) : [];
    let common = texts[0] ?? '';
    for (const text of texts) while (common && !text.startsWith(common)) common = common.slice(0, -1);
    const lead = ascii(common).split(/[^A-Za-z]+/).slice(0, -1).filter(word => word.length >= 2).slice(0, 2);
    const fromClass = (classes(parent ?? {})[0] ?? (parent?.t ?? 'slot')).split(/[^A-Za-z0-9]+/).filter(Boolean);
    const base = (column.length ? column : lead.length ? lead : fromClass).map(word => word[0].toUpperCase() + word.slice(1)).join('') || 'Slot';
    let name = base, n = 2;
    while (taken.has(name)) name = base + n++;
    taken.add(name);
    return name;
  };
  for (const entry of list.slots) {
    if (!entry.slot.node || isElement(entry.slot.node) || entry.how) continue;
    const texts = entry.slot.values.map(node => node ? String(node.x) : null);
    if (texts.some(text => text === null) || new Set(texts).size < 2) continue;
    // white space that varies (the indentation around optional items) is layout, never data
    if (texts.every(text => !text.trim())) continue;
    const out = outByNode.get(entry.slot.node);
    if (!out) continue;
    const name = nameFor(entry.slot.node, parentOf.get(entry.slot.node), texts);
    out.expr = { fmt: 'text', value: { field: name }, prefix: '', suffix: '', locale: null, extra: true };
    extraAttributes.push({ collection: list.collection, name, type: 'Text', values: list.rows.map((row, i) => ({ key: row[keyField], value: texts[i] })) });
  }
  // The inline style of an element that varies between the items with no field to explain it (a React row drawn done or to
  // do from state outside the store): an extra attribute <Element>Style with the canonical style of each item, which the
  // template reads, so every row looks as it was rendered (fidelity by construction, never the first item's style for all).
  for (const entry of list.slots) {
    const node = entry.slot.node;
    if (!node || !isElement(node) || node.icon || node.svg) continue;
    const out = outByNode.get(node);
    if (!out || out.attrExpr?.style || entry.attrs?.style) continue;
    const values = entry.slot.values.map(item => (item && isElement(item) ? String(attr(item, 'style') ?? '') : null));
    if (values.some(value => value === null) || new Set(values).size < 2) continue;
    const name = nameFor(node, node, []) + 'Style';
    out.attrExpr = { ...(out.attrExpr ?? {}), style: { expr: { fmt: 'text', value: { field: name }, prefix: '', suffix: '', locale: null, extra: true } } };
    extraAttributes.push({ collection: list.collection, name, type: 'Text', values: list.rows.map((row, i) => ({ key: row[keyField], value: values[i] })) });
  }
  // A node present in some items only, with no predicate of the fields to say which (a "+02h" tag on the last row of a
  // sheet): an extra attribute <Element>Shown ("1" where the item had it, "" elsewhere) that its if reads, so no row shows a
  // node it never had and none loses one it had.
  const conditioned = node => { for (let current = node; current; current = parentOf.get(current)) if (outByNode.get(current)?.if) return true; return false; };
  for (const entry of list.slots) {
    const node = entry.slot.node ?? entry.slot.extra;
    if (!node || !isElement(node)) continue;
    const out = outByNode.get(node);
    if (!out || out.if || entry.if || conditioned(parentOf.get(node))) continue;
    const present = entry.slot.values.map(item => item != null);
    if (present.every(Boolean) || !present.some(Boolean)) continue;
    const name = nameFor(node, node, []) + 'Shown';
    out.if = { op: 'truthy', l: { field: name } };
    extraAttributes.push({ collection: list.collection, name, type: 'Text', values: list.rows.map((row, i) => ({ key: row[keyField], value: present[i] ? '1' : '' })) });
  }
  if (extraAttributes.length) template.extraAttributes = extraAttributes;
  return template;
}

export { evaluate, similarity, canonical, textOf, renderKey };
