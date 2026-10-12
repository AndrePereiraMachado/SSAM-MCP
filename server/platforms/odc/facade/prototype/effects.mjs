// Effects (docs/PROTOTIPO-NATIVO.md 2.6): what an event does, observed by the difference before/after (DOM, URL,
// modal container, notifications and store), in a closed class: navigate, openPopup, closePopup, setDimension, toggle,
// increment, remove, update, insert, upsert, insertFrom, updateFrom, removeWhere, validate, toast. A store difference
// is explained by the fixed-order search for the combination of effects that explains every changed row; the residue
// goes to events.notCompiled with the exact difference.
import { attr, classes, elementsWithPath, isElement, textOf, walk, canonical } from './ir.mjs';
import { renderKey, alignTrees, alignSequences } from './align.mjs';
import { storeState, findStoreKey, typeCollections } from './store.mjs';
import { separate, decisionList, evaluate } from './predicates.mjs';

// ---- values ---------------------------------------------------------------------------------------------------------

export function same(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  const x = Number(a), y = Number(b);
  if (String(a).trim() !== '' && String(b).trim() !== '' && Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y) < 1e-9;
  return String(a) === String(b);
}

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// ---- store meta -----------------------------------------------------------------------------------------------------

export class StoreMeta {
  constructor(data, extras = []) {
    this.initial = data ?? {};
    const all = { ...this.initial };
    for (const extra of extras) if (!(extra.name in all)) all[extra.name] = extra.rows;
    this.extraNames = extras.map(extra => extra.name).filter(name => !(name in this.initial));
    this.collections = typeCollections(all);
    this.byName = new Map(this.collections.map(collection => [collection.name, collection]));
    this.storeKey = null;
  }
  key(name) { return this.byName.get(name)?.key ?? 'Id'; }
  ref(name, field) { return this.byName.get(name)?.references.find(reference => reference.field === field)?.collection ?? null; }
  keysOf(name, state) { const key = this.key(name); return new Set((state?.[name] ?? this.byName.get(name)?.rows ?? []).map(row => row[key])); }
  state(snap) {
    // An in-memory store travels in the snapshot itself (store.live); a persisted one in the storage key.
    if (!snap?.store && !this.storeKey) this.storeKey = findStoreKey(this.initial, [snap?.storage ?? {}]);
    const data = snap?.store ?? storeState(this.initial, snap?.storage, this.storeKey);
    const out = { ...data };
    for (const name of this.extraNames) out[name] = this.byName.get(name).rows;
    return out;
  }
  fieldType(name, field) { return this.byName.get(name)?.fields.find(item => item.name === field)?.type ?? null; }
}

// ---- store difference -----------------------------------------------------------------------------------------------

export function storeDiff(before, after, meta) {
  const out = [];
  for (const name of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort()) {
    const key = meta.key(name);
    const id = (row, index) => key === '#' ? index : row[key];
    const rowsB = before[name] ?? [], rowsA = after[name] ?? [];
    const mapB = new Map(rowsB.map((row, index) => [String(id(row, index)), row]));
    const mapA = new Map(rowsA.map((row, index) => [String(id(row, index)), row]));
    const inserted = rowsA.filter((row, index) => !mapB.has(String(id(row, index))));
    const removed = rowsB.filter((row, index) => !mapA.has(String(id(row, index))));
    const updated = [];
    for (const [rowKey, rowB] of mapB) {
      const rowA = mapA.get(rowKey);
      if (!rowA) continue;
      const fields = [...new Set([...Object.keys(rowB), ...Object.keys(rowA)])].filter(field => !same(rowB[field], rowA[field]) || (rowB[field] === undefined) !== (rowA[field] === undefined));
      if (fields.length) updated.push({ key: rowB[key] ?? rowKey, before: rowB, after: rowA, fields });
    }
    if (inserted.length || removed.length || updated.length) out.push({ collection: name, inserted, removed, updated });
  }
  return out;
}

// Candidate value sources for a field value, in preference order (typed matches first; literal before coincidences).
function sources(value, { collection, field, ctx, meta, allowLit = true }) {
  const out = [];
  const fk = meta.ref(collection, field);
  const fkKeys = fk ? meta.keysOf(fk, ctx.before) : null;
  for (const control of ctx.controls ?? []) if (control.name === field && same(control.value, value)) out.push({ control: control.name });
  if (ctx.self && same(ctx.self.value, value)) out.push({ control: ctx.self.name, self: true });
  for (const [name, param] of Object.entries(ctx.params ?? {})) if (same(param, value) && fk && fkKeys.has(Number(param)) || same(param, value) && fk && fkKeys.has(param)) out.push({ param: name });
  for (const dim of ctx.dims ?? []) if (same(dim.value, value) && fk && dim.collection === fk) out.push({ dim: dim.key });
  for (const [name, keys] of Object.entries(ctx.inserted ?? {})) if (keys.some(key => same(key, value)) && (!fk || fk === name)) out.push({ inserted: name });
  if (typeof value === 'string' && ctx.clockIso && (value === ctx.clockIso || Date.parse(value) === ctx.clock)) out.push({ clock: true });
  for (const control of ctx.controls ?? []) if (control.name !== field && same(control.value, value)) out.push({ control: control.name });
  for (const [name, param] of Object.entries(ctx.params ?? {})) if (same(param, value) && !fk && /Id$/.test(field) && field.replace(/Id$/, '') && !out.some(item => item.param === name)) out.push({ param: name, weak: true });
  if (typeof value === 'number' && !out.length && Math.abs(value) > 1) {
    const aggregate = findAggregate(value, ctx, meta);
    if (aggregate) out.push(aggregate);
  }
  if (allowLit) out.push({ lit: value });
  return out;
}

// count / sum(f) / sum(f*g) of a filtered collection (one join by foreign key), filter by a typed dimension/parameter.
function findAggregate(value, ctx, meta) {
  for (const collection of meta.collections) {
    const rows = ctx.before?.[collection.name] ?? [];
    for (const reference of collection.references) {
      const filters = [];
      for (const dim of ctx.dims ?? []) if (dim.collection === reference.collection) filters.push({ val: { dim: dim.key }, value: dim.value });
      for (const [name, param] of Object.entries(ctx.params ?? {})) if (meta.keysOf(reference.collection, ctx.before).has(Number(param))) filters.push({ val: { param: name }, value: param });
      for (const filter of filters) {
        const selected = rows.filter(row => same(row[reference.field], filter.value));
        if (selected.length < 2) continue;
        const where = { op: 'eq', l: { field: reference.field }, r: filter.val };
        const numeric = collection.fields.filter(item => item.type === 'Integer' || item.type === 'Decimal').map(item => item.name).filter(name => name !== collection.key && !collection.references.some(ref => ref.field === name));
        if (near(selected.length, value)) return { agg: { op: 'count', collection: collection.name, where } };
        for (const f of numeric) {
          if (near(selected.reduce((sum, row) => sum + Number(row[f] ?? 0), 0), value)) return { agg: { op: 'sum', collection: collection.name, field: f, where } };
          for (const join of collection.references) {
            const target = meta.byName.get(join.collection);
            const targetRows = ctx.before?.[join.collection] ?? target?.rows ?? [];
            const numericTarget = (target?.fields ?? []).filter(item => item.type === 'Integer' || item.type === 'Decimal').map(item => item.name).filter(name => name !== target.key);
            for (const g of numericTarget) {
              const total = selected.reduce((sum, row) => { const other = targetRows.find(item => same(item[target.key], row[join.field])); return sum + Number(row[f] ?? 0) * Number(other?.[g] ?? 0); }, 0);
              if (near(Math.round(total * 100) / 100, value)) return { agg: { op: 'sum', collection: collection.name, field: f, times: { field: g, via: join.field, collection: join.collection }, where } };
            }
          }
        }
      }
    }
  }
  return null;
}

// Predicates selecting exactly some rows of a collection: field = typed dimension / parameter / inserted key / literal.
function rowPredicates(collection, rows, target, ctx, meta) {
  const out = [];
  const meta0 = meta.byName.get(collection);
  if (!meta0) return out;
  const candidates = [];
  for (const reference of meta0.references) {
    for (const dim of ctx.dims ?? []) if (dim.collection === reference.collection) candidates.push({ field: reference.field, val: { dim: dim.key }, value: dim.value });
    for (const [name, param] of Object.entries(ctx.params ?? {})) if (meta.keysOf(reference.collection, ctx.before).has(Number(param)) || meta.keysOf(reference.collection, ctx.before).has(param)) candidates.push({ field: reference.field, val: { param: name }, value: param });
    for (const [name, keys] of Object.entries(ctx.inserted ?? {})) if (name === reference.collection) candidates.push({ field: reference.field, val: { inserted: name }, value: keys[0] });
  }
  for (const candidate of candidates) {
    const selected = rows.filter(row => same(row[candidate.field], candidate.value));
    const want = new Set(target);
    if (selected.length === want.size && selected.every(row => want.has(row))) out.push({ op: 'eq', l: { field: candidate.field }, r: candidate.val });
  }
  return out;
}

// Field candidates of a collection for a target field: the same name first, then the plain fields, keys and foreign keys last.
function fieldOrder(collection, field) {
  const names = collection.fields.map(item => item.name);
  const isKey = name => name === collection.key || collection.references.some(reference => reference.field === name);
  return [...names.filter(name => name === field), ...names.filter(name => name !== field && !isKey(name)), ...names.filter(name => name !== field && isKey(name))];
}

function explainInsertFrom(collection, rows, ctx, meta) {
  const key = meta.key(collection);
  const sorted = [...rows].sort((a, b) => Number(a[key]) - Number(b[key]));
  const maxBefore = Math.max(0, ...(ctx.before[collection] ?? []).map(row => Number(row[key]) || 0));
  for (const source of meta.collections) {
    if (source.name === collection) continue;
    for (const state of [ctx.before, ctx.after]) {
      const sourceRows = state[source.name] ?? [];
      for (const reference of source.references) {
        const groups = [];
        for (const dim of ctx.dims ?? []) if (dim.collection === reference.collection) groups.push({ val: { dim: dim.key }, value: dim.value });
        for (const [name, param] of Object.entries(ctx.params ?? {})) groups.push({ val: { param: name }, value: param });
        for (const [name, keys] of Object.entries(ctx.inserted ?? {})) if (name === reference.collection) groups.push({ val: { inserted: name }, value: keys[0] });
        for (const group of groups) {
          const selected = sourceRows.filter(row => same(row[reference.field], group.value));
          if (selected.length !== sorted.length) continue;
          const fields = {};
          let ok = true;
          for (const field of Object.keys(sorted[0])) {
            const values = sorted.map(row => row[field]);
            if (field === key && values.every((value, i) => same(value, maxBefore + 1 + i))) { fields[field] = { key: 'max+1' }; continue; }
            const preferred = fieldOrder(source, field);
            const fromSource = preferred.find(name => values.every((value, i) => same(value, selected[i][name])) && (name === field || !values.every(v => same(v, values[0]))));
            if (fromSource) { fields[field] = { field: fromSource }; continue; }
            let joined = null;
            for (const join of source.references) {
              const target = meta.byName.get(join.collection);
              const targetRows = ctx.before[join.collection] ?? target?.rows ?? [];
              const linked = selected.map(row => targetRows.find(item => same(item[target.key], row[join.field])));
              if (linked.some(item => !item)) continue;
              const name = target.fields.map(item => item.name).find(name => values.every((value, i) => same(value, linked[i][name])));
              if (name) { joined = { field: name, via: join.field, collection: join.collection }; break; }
              // f*g: a source field times a joined field.
              for (const f of fieldOrder(source, field).filter(name => ['Integer', 'Decimal'].includes(source.fields.find(item => item.name === name)?.type))) {
                const g = target.fields.filter(item => item.type === 'Integer' || item.type === 'Decimal').map(item => item.name).find(name2 => values.every((value, i) => near(Math.round(Number(selected[i][f]) * Number(linked[i][name2]) * 100) / 100, value)));
                if (g) { joined = { mul: [{ field: f }, { field: g, via: join.field, collection: join.collection }] }; break; }
              }
              if (joined) break;
            }
            if (joined) { fields[field] = joined; continue; }
            const inserted = Object.entries(ctx.inserted ?? {}).find(([, keys]) => values.every(value => same(value, keys[0])));
            if (inserted) { fields[field] = { inserted: inserted[0] }; continue; }
            if (values.every(value => typeof value === 'string' && (value === ctx.clockIso || Date.parse(value) === ctx.clock))) { fields[field] = { clock: true }; continue; }
            if (values.every(value => same(value, values[0]))) { fields[field] = { lit: values[0] }; continue; }
            ok = false;
            break;
          }
          if (ok) return { kind: 'insertFrom', collection, from: source.name, where: { op: 'eq', l: { field: reference.field }, r: group.val }, fields, rows: sorted.length, sourceState: state === ctx.before ? 'before' : 'after' };
        }
      }
    }
  }
  return null;
}

function explainUpdateFrom(collection, updates, field, ctx, meta) {
  for (const source of meta.collections) {
    const link = source.references.find(reference => reference.collection === collection);
    if (!link || source.name === collection) continue;
    for (const state of [ctx.before, ctx.after]) {
      const rows = state[source.name] ?? [];
      const groups = [];
      for (const reference of source.references) {
        if (reference === link) continue;
        for (const dim of ctx.dims ?? []) if (dim.collection === reference.collection) groups.push({ field: reference.field, val: { dim: dim.key }, value: dim.value });
        for (const [name, param] of Object.entries(ctx.params ?? {})) if (meta.keysOf(reference.collection, ctx.before).has(Number(param)) || meta.keysOf(reference.collection, ctx.before).has(param)) groups.push({ field: reference.field, val: { param: name }, value: param });
        for (const [name, keys] of Object.entries(ctx.inserted ?? {})) if (name === reference.collection) groups.push({ field: reference.field, val: { inserted: name }, value: keys[0] });
      }
      for (const group of groups) {
        const selected = rows.filter(row => same(row[group.field], group.value));
        if (!selected.length) continue;
        for (const value of fieldOrder(source, field).filter(name => name !== source.key && !source.references.some(reference => reference.field === name) && ['Integer', 'Decimal'].includes(source.fields.find(item => item.name === name)?.type))) {
          for (const sign of ['-', '+']) {
            const factor = sign === '-' ? -1 : 1;
            const changedKeys = new Set(updates.map(update => String(update.key)));
            const ok = updates.every(update => near(Number(update.after[field]) - Number(update.before[field]), factor * selected.filter(row => same(row[link.field], update.key)).reduce((sum, row) => sum + Number(row[value] ?? 0), 0)))
              && selected.every(row => changedKeys.has(String(row[link.field])));
            if (ok) return { kind: 'updateFrom', collection, field, from: source.name, via: link.field, value, where: { op: 'eq', l: { field: group.field }, r: group.val }, sign, sourceState: state === ctx.before ? 'before' : 'after' };
          }
        }
      }
    }
  }
  return null;
}

// Selectors of one row: key <- parameter, and the conjunction of fields equal to typed parameters/dimensions.
function rowSelectors(collection, row, ctx, meta) {
  const out = [];
  const key = meta.key(collection);
  for (const [name, param] of Object.entries(ctx.params ?? {})) if (same(row[key], param)) out.push({ key: { param: name } });
  if (ctx.self?.key != null && same(row[key], ctx.self.key)) out.push({ key: { param: ctx.self.keyParam ?? 'Id' } });
  const terms = [];
  const record = meta.byName.get(collection);
  for (const reference of record?.references ?? []) {
    for (const [name, param] of Object.entries(ctx.params ?? {})) if (same(row[reference.field], param) && (meta.keysOf(reference.collection, ctx.before).has(Number(param)) || meta.keysOf(reference.collection, ctx.before).has(param))) terms.push({ op: 'eq', l: { field: reference.field }, r: { param: name } });
    for (const dim of ctx.dims ?? []) if (dim.collection === reference.collection && same(row[reference.field], dim.value)) terms.push({ op: 'eq', l: { field: reference.field }, r: { dim: dim.key } });
  }
  if (terms.length) out.push({ where: terms.length === 1 ? terms[0] : { op: 'and', a: terms } });
  return out;
}

// One probe's store difference -> effect candidates (each effect may carry alternatives) and the residue.
export function explainStore(diff, ctx, meta) {
  const effects = [], residue = [];
  ctx.inserted = {};
  const inserts = diff.filter(item => item.inserted.length);
  // Inserts of collections referenced by other inserts first (the key of the header is used by the lines).
  inserts.sort((a, b) => {
    const aRefsB = (meta.byName.get(a.collection)?.references ?? []).some(reference => reference.collection === b.collection);
    const bRefsA = (meta.byName.get(b.collection)?.references ?? []).some(reference => reference.collection === a.collection);
    return aRefsB && !bRefsA ? 1 : bRefsA && !aRefsB ? -1 : a.collection < b.collection ? -1 : 1;
  });
  for (const item of inserts) {
    const key = meta.key(item.collection);
    const maxBefore = Math.max(0, ...(ctx.before[item.collection] ?? []).map(row => Number(row[key]) || 0));
    if (item.inserted.length === 1) {
      const row = item.inserted[0];
      const fields = {};
      for (const field of Object.keys(row)) {
        if (field === key && same(row[field], maxBefore + 1)) { fields[field] = { key: 'max+1' }; continue; }
        fields[field] = sources(row[field], { collection: item.collection, field, ctx, meta });
      }
      effects.push({ kind: 'insert', collection: item.collection, fields, row });
      ctx.inserted[item.collection] = [row[key]];
    } else {
      ctx.inserted[item.collection] = item.inserted.map(row => row[key]);
      const found = explainInsertFrom(item.collection, item.inserted, ctx, meta);
      if (found) effects.push(found);
      else residue.push({ collection: item.collection, inserted: item.inserted });
    }
  }
  for (const item of diff.filter(entry => entry.updated.length)) {
    const fields = [...new Set(item.updated.flatMap(update => update.fields))];
    const numericSingle = fields.length === 1 && item.updated.every(update => typeof update.before[fields[0]] === 'number' && typeof update.after[fields[0]] === 'number');
    if (item.updated.length > 1 || (numericSingle && !rowSelectors(item.collection, item.updated[0].before, ctx, meta).length)) {
      if (numericSingle) {
        const found = explainUpdateFrom(item.collection, item.updated, fields[0], ctx, meta);
        if (found) { effects.push(found); continue; }
      }
      if (item.updated.length > 1) { residue.push({ collection: item.collection, updated: item.updated }); continue; }
    }
    const update = item.updated[0];
    const selectors = rowSelectors(item.collection, update.before, ctx, meta);
    if (!selectors.length) { residue.push({ collection: item.collection, updated: [update] }); continue; }
    if (fields.length === 1 && typeof update.before[fields[0]] === 'boolean' && update.after[fields[0]] === !update.before[fields[0]] && !(ctx.controls ?? []).some(control => control.name === fields[0])) {
      effects.push({ kind: 'toggle', collection: item.collection, selectors, field: fields[0] });
      continue;
    }
    if (numericSingle) {
      const delta = Math.round((update.after[fields[0]] - update.before[fields[0]]) * 1e6) / 1e6;
      const by = [];
      for (const control of ctx.controls ?? []) if (same(control.value, delta)) by.push({ control: control.name });
      for (const [name, param] of Object.entries(ctx.params ?? {})) if (same(param, delta) && /delta|qty|quant|amount|step|by/i.test(name)) by.push({ param: name });
      const direct = sources(update.after[fields[0]], { collection: item.collection, field: fields[0], ctx, meta, allowLit: false }).filter(source => source.control);
      if (direct.length && !by.some(source => source.param)) { effects.push({ kind: 'update', collection: item.collection, selectors, fields: { [fields[0]]: direct } }); continue; }
      by.push({ lit: delta });
      effects.push({ kind: 'increment', collection: item.collection, selectors, field: fields[0], by, delta, from: update.before[fields[0]], to: update.after[fields[0]] });
      continue;
    }
    const assigned = {};
    let ok = true;
    for (const field of fields) {
      const options = sources(update.after[field], { collection: item.collection, field, ctx, meta, allowLit: true });
      if (!options.length) { ok = false; break; }
      assigned[field] = options;
    }
    if (ok) effects.push({ kind: 'update', collection: item.collection, selectors, fields: assigned });
    else residue.push({ collection: item.collection, updated: [update] });
  }
  for (const item of diff.filter(entry => entry.removed.length)) {
    const key = meta.key(item.collection);
    if (item.removed.length === 1) {
      const selectors = rowSelectors(item.collection, item.removed[0], ctx, meta).filter(selector => selector.key);
      if (selectors.length) { effects.push({ kind: 'remove', collection: item.collection, selectors }); continue; }
    }
    const where = rowPredicates(item.collection, ctx.before[item.collection] ?? [], item.removed, ctx, meta);
    if (where.length) effects.push({ kind: 'removeWhere', collection: item.collection, where: where[0], rows: item.removed.length });
    else residue.push({ collection: item.collection, removed: item.removed.map(row => row[key]) });
  }
  return { effects, residue };
}

// ---- observation ----------------------------------------------------------------------------------------------------

export function modalContainers(body) {
  return elementsWithPath(body).filter(({ node }) => node.t === 'dialog' || attr(node, 'role') === 'dialog' || attr(node, 'aria-modal') === 'true');
}

export function modalTitle(container, body) {
  const labelled = attr(container, 'aria-labelledby');
  let found = null;
  if (labelled) walk(container, node => { if (found) return false; if (isElement(node) && attr(node, 'id') === labelled) found = node; });
  if (!found && labelled && body) walk(body, node => { if (found) return false; if (isElement(node) && attr(node, 'id') === labelled) found = node; });
  if (!found) walk(container, node => { if (found) return false; if (isElement(node) && /^h[1-3]$/.test(node.t)) found = node; });
  return found ? textOf(found).replace(/\s+/g, ' ').trim() : '';
}

function openModals(body) {
  return modalContainers(body).filter(({ node }) => !node.h).map(({ node, path }) => ({ node, path, key: renderKey({ t: 'x', c: node.c ?? [] }), title: modalTitle(node, body), classAttr: attr(node, 'class') ?? '' }));
}

// Whether a region changed more than its attributes: an element or text added, removed or rewritten, or an element
// shown or hidden (a toast revealed by removing [hidden] keeps its structure).
function textChanged(a, b) {
  if (!a || !b) return Boolean(a) !== Boolean(b);
  if (renderKey(a) === renderKey(b)) return false;
  const { pairs, onlyA, onlyB } = alignTrees(a, b);
  const meaningful = node => isElement(node) || String(node.x ?? '').trim();
  if (onlyA.some(meaningful) || onlyB.some(meaningful)) return true;
  for (const [x, y] of pairs) {
    if (!isElement(x)) { if (String(x.x).replace(/\s+/g, ' ').trim() !== String(y.x).replace(/\s+/g, ' ').trim()) return true; }
    else if (Boolean(x.h) !== Boolean(y.h)) return true;
  }
  return false;
}

export function toastRegions(body, appIndex) {
  const out = [];
  (body.c ?? []).forEach((node, index) => {
    if (!isElement(node) || index === appIndex) return;
    if (node.t === 'dialog' || attr(node, 'role') === 'dialog' || attr(node, 'aria-modal') === 'true') return;
    out.push(index);
  });
  return out;
}

function modalSlugOf(title) { return String(title ?? '').replace(/[#0-9]/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

export function observe(before, after, { kind, meta, appIndex, mountPath, ignore = null }) {
  const route = snap => kind === 'spa-path' ? snap.path : decodeURIComponent(String(snap.hash ?? '').replace(/^#/, ''));
  const out = { navigated: route(before) !== route(after) || before.path !== after.path, from: route(before), to: route(after), page: after.path };
  const mb = openModals(before.body), ma = openModals(after.body);
  out.modalBefore = mb; out.modalAfter = ma;
  out.opened = ma.find(modal => !mb.some(other => other.path.join('.') === modal.path.join('.'))) ?? null;
  out.replaced = !out.opened ? ma.find(modal => mb.some(other => other.path.join('.') === modal.path.join('.') && other.title !== modal.title && modalSlugOf(other.title) !== modalSlugOf(modal.title))) ?? null : null;
  if (out.replaced) out.opened = out.replaced;
  out.closed = mb.length > 0 && !ma.some(modal => mb.some(other => other.path.join('.') === modal.path.join('.')));
  out.modalChanged = !out.opened && !out.closed && ma.some(modal => mb.some(other => other.path.join('.') === modal.path.join('.') && other.key !== modal.key));
  out.toasts = [];
  out.toastsRemoved = 0;
  // A body child that holds a dialog (before or after) is a modal host, and one that changed only attributes (the
  // active link of a side menu) shows no notice: neither is a toast region.
  const hosts = new Set([...mb, ...ma].filter(modal => modal.path.length > 1).map(modal => modal.path[0]));
  for (const index of toastRegions(after.body, appIndex)) {
    if (hosts.has(index) || !textChanged(before.body.c?.[index], after.body.c?.[index])) continue;
    const kidsB = (before.body.c?.[index]?.c ?? []).filter(isElement), kidsA = (after.body.c?.[index]?.c ?? []).filter(isElement);
    const keysB = kidsB.map(renderKey);
    // A region that announces (role status/alert, aria-live, a toast or notice class) shows every changed child as a notice;
    // in any other region (a top bar whose favorites counter changed) only an element that was not there is one.
    const region = after.body.c?.[index];
    const announces = ['status', 'alert'].includes(attr(region, 'role')) || attr(region, 'aria-live') != null || /toast|notice|notif|alert|snack|aviso|flash/i.test(String(attr(region, 'class') ?? '') + ' ' + String(attr(region, 'id') ?? ''));
    const paired = announces ? new Set() : new Set(alignSequences(kidsB, kidsA).filter(([i, j]) => i != null && j != null).map(([, j]) => j));
    kidsA.forEach((node, j) => { if (!keysB.includes(renderKey(node)) && !paired.has(j)) out.toasts.push({ region: index, node, text: textOf(node).replace(/\s+/g, ' ').trim(), classes: classes(node) }); });
    if (kidsA.length < kidsB.length) out.toastsRemoved += kidsB.length - kidsA.length;
  }
  const sb = meta.state(before), sa = meta.state(after);
  out.storeBefore = sb; out.storeAfter = sa;
  out.diff = storeDiff(sb, sa, meta);
  const appB = appIndex != null ? before.body.c?.[appIndex] : before.body, appA = appIndex != null ? after.body.c?.[appIndex] : after.body;
  out.appChanged = renderKey(appB) !== renderKey(appA);
  const own = ignore ? ignore.join('.') : null;
  out.liveChanged = JSON.stringify(liveValues(before.body).filter(([path]) => path !== own)) !== JSON.stringify(liveValues(after.body).filter(([path]) => path !== own));
  const mount = (body) => mountPath ? mountPath.reduce((node, index) => node?.c?.[index], body) : body;
  out.mountChanged = renderKey(mount(before.body)) !== renderKey(mount(after.body));
  out.errors = after.errors ?? [];
  return out;
}

export function liveValues(body) {
  const out = [];
  for (const { node, path } of elementsWithPath(body)) if (node.p) out.push([path.join('.'), node.p]);
  return out;
}

// ---- event assembly -------------------------------------------------------------------------------------------------

const ORDER = ['insert', 'insertFrom', 'updateFrom', 'removeWhere', 'update', 'toggle', 'increment', 'upsert', 'remove', 'validate', 'setDimension', 'closePopup', 'openPopup', 'toast', 'navigate'];

export function sortEffects(effects) {
  return [...effects].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

// The signature used to group contexts of one event by what they did (effect kinds and targets).
export function effectSignature(effects) {
  return effects.map(effect => effect.kind + ':' + (effect.collection ?? effect.modal ?? effect.view ?? effect.dimension ?? '') + (effect.kind === 'toast' ? ':' + (effect.variant ?? '') : '')).join('|');
}

function firstCommon(lists) {
  if (!lists.length) return null;
  const keyed = lists.map(list => list.map(item => canonical(item)));
  return lists[0].find((item, index) => keyed.every(list => list.includes(keyed[0][index]))) ?? null;
}

// Merges one event's per-probe effects (same signature) into one list: each value takes the first alternative that is
// consistent across every probe. Variants with increment on some parameters and insert on others become upsert.
export function mergeVariants(probes) {
  const insertOf = probe => probe.effects.find(effect => effect.kind === 'insert');
  const incrementOf = probe => probe.effects.find(effect => effect.kind === 'increment');
  const upsertCollection = (() => {
    const inc = probes.filter(probe => incrementOf(probe)), ins = probes.filter(probe => insertOf(probe));
    if (!inc.length || !ins.length) return null;
    const collection = incrementOf(inc[0]).collection;
    if (insertOf(ins[0]).collection !== collection) return null;
    return collection;
  })();
  if (upsertCollection) {
    const inc = probes.filter(probe => incrementOf(probe)), ins = probes.filter(probe => insertOf(probe));
    const insertFields = mergeFields(ins.map(probe => insertOf(probe).fields));
    const field = incrementOf(inc[0]).field;
    const by = firstCommon(inc.map(probe => incrementOf(probe).by)) ?? { lit: incrementOf(inc[0]).delta };
    const keys = {};
    for (const [name, value] of Object.entries(insertFields)) if (value.param || value.dim) keys[name] = value;
    const consistent = inc.every(probe => Object.entries(keys).every(([name, value]) => {
      const sel = incrementOf(probe).selectors.find(selector => selector.where);
      const terms = sel ? (sel.where.op === 'and' ? sel.where.a : [sel.where]) : [];
      return terms.some(term => term.l.field === name && canonical(term.r) === canonical(value));
    }));
    if (consistent && Object.keys(keys).length) {
      const rest = probes[0].effects.filter(effect => effect.kind !== 'insert' && effect.kind !== 'increment');
      return sortEffects([{ kind: 'upsert', collection: upsertCollection, keys, field, by, fields: insertFields }, ...mergeSimple(probes.map(probe => probe.effects.filter(effect => effect.kind !== 'insert' && effect.kind !== 'increment'))).filter(Boolean), ...[]].concat(rest.length && false ? rest : []));
    }
  }
  return sortEffects(mergeSimple(probes.map(probe => probe.effects)));
}

// Fields of one effect over its probes: each field takes the first source common to every probe that changed it
// (a probe whose value equals the current one does not change the field and says nothing about it).
function mergeFields(list) {
  const out = {};
  const names = [...new Set(list.flatMap(fields => Object.keys(fields ?? {})))];
  for (const field of names) {
    const options = list.filter(fields => fields?.[field] !== undefined).map(fields => Array.isArray(fields[field]) ? fields[field] : [fields[field]]);
    out[field] = firstCommon(options) ?? options[0][options[0].length - 1];
  }
  return out;
}

function mergeSimple(lists) {
  const base = lists[0] ?? [];
  return base.map((effect, index) => {
    const peers = lists.map(list => list[index]).filter(Boolean);
    const merged = { ...effect };
    if (effect.selectors) {
      const choice = firstCommon(peers.map(peer => peer.selectors ?? []));
      delete merged.selectors;
      if (choice?.key) merged.key = choice.key;
      else if (choice?.where) merged.where = choice.where;
      else if (effect.selectors[0]?.key) merged.key = effect.selectors[0].key;
      else if (effect.selectors[0]?.where) merged.where = effect.selectors[0].where;
    }
    if (effect.fields && effect.kind !== 'insertFrom') merged.fields = mergeFields(peers.map(peer => peer.fields));
    if (effect.by) { merged.by = firstCommon(peers.map(peer => peer.by)) ?? effect.by[effect.by.length - 1]; delete merged.delta; delete merged.from; delete merged.to; }
    delete merged.row;
    if (effect.inputs) merged.inputs = Object.fromEntries(Object.keys(effect.inputs).map(name => [name, firstCommon(peers.map(peer => peer.inputs?.[name] ?? [])) ?? effect.inputs[name][0]]));
    if (effect.params && effect.kind === 'navigate') merged.params = Object.fromEntries(Object.keys(effect.params).map(name => [name, firstCommon(peers.map(peer => peer.params?.[name] ?? [])) ?? effect.params[name][0]]));
    if (effect.value && Array.isArray(effect.value)) merged.value = firstCommon(peers.map(peer => peer.value)) ?? effect.value[0];
    if (effect.text && Array.isArray(effect.text)) merged.text = textCases(peers);
    return merged;
  });
}

function textCases(peers) {
  const texts = [...new Set(peers.map(peer => peer.text[0]?.lit))];
  if (texts.length === 1) return { lit: texts[0] };
  return { cases: peers.map(peer => ({ text: peer.text[0]?.lit, ctx: peer.ctx })) };
}

// Groups the contexts of one event by effect signature and separates them by predicates (state, record fields,
// control values): [{when, effects}] where the last entry has when = null.
export function eventCases(observations, vars) {
  const groups = new Map();
  const kinds = collection => new Set(observations.flatMap(item => item.effects.filter(effect => effect.collection === collection).map(effect => effect.kind)));
  const upserts = new Set(observations.flatMap(item => item.effects.filter(effect => effect.kind === 'increment' && kinds(effect.collection).has('insert')).map(effect => effect.collection)));
  for (const observation of observations) {
    const signature = effectSignature(observation.effects.map(effect => upserts.has(effect.collection) && (effect.kind === 'increment' || effect.kind === 'insert') ? { ...effect, kind: 'upsert' } : effect));
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(observation);
  }
  const list = [...groups.values()];
  if (list.length === 1) return { cases: [{ when: null, effects: toastTexts(mergeVariants(list[0]), list[0], vars) }], separated: true };
  const decision = decisionList(vars, list.map(items => ({ contexts: items.map(item => item.context), items })));
  if (!decision) {
    const largest = [...list].sort((a, b) => b.length - a.length)[0];
    return { cases: [{ when: null, effects: mergeVariants(largest) }], separated: false, groups: list.map(items => effectSignature(items[0].effects)) };
  }
  return { cases: decision.map(item => ({ when: item.when, effects: toastTexts(mergeVariants(item.group.items), item.group.items, vars) })), separated: true };
}

// A toast whose text differs between observations: a decision list over the state, the parameters and the record.
function toastTexts(effects, items, vars) {
  return effects.map(effect => {
    if (effect.kind !== 'toast' || !effect.text?.cases) return effect;
    const texts = items.map(item => item.effects.filter(entry => entry.kind === 'toast')[effects.filter(entry => entry.kind === 'toast').indexOf(effect)]?.text?.[0]?.lit ?? null);
    const groups = new Map();
    texts.forEach((text, i) => { if (!groups.has(text)) groups.set(text, []); groups.get(text).push(items[i].context); });
    const decision = decisionList(vars, [...groups.entries()].map(([text, contexts]) => ({ contexts, text })));
    if (!decision) return { ...effect, text: { lit: texts[0] } };
    return { ...effect, text: { fmt: 'cases', cases: decision.filter(entry => entry.when).map(entry => ({ when: entry.when, value: { lit: entry.group.text } })), else: { lit: decision[decision.length - 1].group.text } } };
  });
}

// ---- the probing of every view, state, trigger, control, modal and form ---------------------------------------------

function nodeAt(body, path) { let node = body; for (const index of path ?? []) { node = node?.c?.[index]; if (!node) return null; } return node; }

function snapPair(steps) { return [{ do: 'snap', tag: 'before' }, ...steps, { do: 'snap', tag: 'after' }]; }

function paramContext(params) { return Object.fromEntries(Object.entries(params ?? {}).map(([name, value]) => [name, value])); }

function dimValues(session, state) {
  const out = {};
  for (const dim of session.dims) out[dim.key] = state?.assign && dim.key in state.assign ? String(state.assign[dim.key]) : String(dim.initial ?? '');
  return out;
}

function dimList(session, state) {
  return session.dims.filter(dim => dim.scope === 'global' || dim.kind === 'control').map(dim => ({ key: dim.key, value: state?.assign && dim.key in state.assign ? String(state.assign[dim.key]) : String(dim.initial ?? ''), collection: dim.collection ?? null }));
}

// The collection a select dimension stands for: its option labels show a text field of the row whose key is the value.
export function correlateDimension(dim, meta, body) {
  if (!body || !dim.target) return null;
  let select = null;
  walk(body, node => { if (select) return false; if (isElement(node) && node.t === 'select' && (dim.target.id ? attr(node, 'id') === dim.target.id : false)) select = node; });
  if (!select) return null;
  const options = (select.c ?? []).filter(node => node.t === 'option').map(node => ({ value: attr(node, 'value') ?? textOf(node), label: textOf(node) }));
  for (const collection of meta.collections) {
    if (collection.key === '#') continue;
    const keyed = options.filter(option => collection.rows.some(row => same(row[collection.key], option.value)));
    if (keyed.length < 2) continue;
    const ok = keyed.every(option => { const row = collection.rows.find(item => same(item[collection.key], option.value)); return collection.fields.some(field => field.type === 'Text' && String(row[field.name] ?? '').length >= 2 && option.label.includes(String(row[field.name]))); });
    if (ok) return collection.name;
  }
  return null;
}

export async function analyzeInteractions(session, { decided }) {
  const { discoverViews, searchStates, skeleton } = await import('./crawl.mjs');
  const dims = await import('./dimensions.mjs');
  const modals = await import('./modals.mjs');
  const perturb = await import('./perturb.mjs');
  const lists = await import('./infer-lists.mjs');
  const t0 = performance.now();
  const discovery = await discoverViews(session, decided);
  const crawlMs = Math.round(performance.now() - t0);
  const modalRegistry = modals.modalRegistry(session.mapping?.modals ?? {});
  const t1 = performance.now();
  const kind = discovery.kind;
  const s0 = session.s0;
  // Problems of the prototype itself refuse before any interaction probe (2.11: one answer, every problem).
  if (discovery.crawl && discovery.problems?.some(problem => problem.key === 'states')) await searchStates(session, discovery.crawl, { problems: discovery.problems, templates: discovery.templates, mountOf: discovery.mountOf, fallback: discovery.fallback });
  const storeMissing = !s0.inspect.store?.source && (s0.inspect.store?.candidates ?? []).length > 0 && !session.mapping.data;
  if (discovery.problems?.length || storeMissing || s0.inspect.store?.error) {
    return { kind, discovery, early: true, meta: null, records: { events: new Map(), targetGuarded: [], outOfScope: [] }, observations: [], forms: [], searches: new Map(), viewLists: new Map(), crawlMs, probeMs: 0, modals: [], dims: [...session.dims] };
  }
  const storeInfo = s0.inspect.store ?? {};
  const storeRows = Object.values(storeInfo.data ?? {}).map(rows => canonical(rows));
  const extras = (s0.inspect.arrays ?? []).filter(array => !storeRows.includes(canonical(array.rows)));
  const meta = new StoreMeta(storeInfo.data ?? {}, storeInfo.data ? extras : []);
  session.meta = meta;
  const delegated = new Set((s0.inspect.listeners ?? []).map(item => item.type));
  const mountPath = discovery.mount ?? null;
  const appIndex = mountPath?.[0] ?? null;
  const locale = s0.inspect.document?.lang || 'en-US';
  const ctx = { kind, meta, appIndex, mountPath };
  for (const dim of session.dims) {
    const render = discovery.views.find(view => view.default)?.render ?? s0;
    dim.collection = correlateDimension(dim, meta, render.body);
    dim.type = dims.valueType(dim.values ?? []);
  }
  const records = { events: new Map(), observations: [], modals: new Map(), forms: [], toasts: [], targetGuarded: [], outOfScope: [], screenDims: new Map(), notes: [] };
  const views = discovery.views;
  const templateOf = route => { for (const view of views) { if (view.template === route) return view; if (view.template.includes('{id}')) { const re = new RegExp('^' + view.template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('\\{id\\}', '([^/]+)').replace('{id}', '([^/]+)') + '$'); if (re.test(route)) return view; } } return null; };
  // spa-state: the view is the skeleton of the page; spa-sections: the view is the visible section.
  const visibleSection = snap => { let found = null; walk(snap.body, node => { if (found) return false; if (isElement(node) && attr(node, 'id') && !node.h && views.some(view => view.sectionId === attr(node, 'id'))) found = attr(node, 'id'); }); return found; };
  const stateViewOf = kind === 'spa-state' ? snap => views.find(view => skeleton(view.render.body, 4) === skeleton(snap.body, 4)) ?? null
    : kind === 'spa-sections' ? snap => views.find(view => view.sectionId === visibleSection(snap)) ?? null : null;
  const reachFor = (view, state) => {
    if (kind === 'spa-hash' || kind === 'spa-path') return [...session.stateSteps(state), { do: 'nav', route: view.route }];
    return view.reach?.prefix ?? [];
  };
  const pageOf = view => view.reach?.page ?? session.entry;
  const statesOf = view => {
    const out = [view.state];
    if (!(kind === 'spa-hash' || kind === 'spa-path')) return out;
    for (const state of discovery.states) {
      if (state === view.state || !state.assign || !Object.keys(state.assign).length && view.state.key === 'S0') continue;
      if (out.includes(state)) continue;
      const render = discovery.renderOf(state, view.route);
      if (render && !discovery.isFallback(state, view.route)) out.push(state);
    }
    return out;
  };
  const renderOf = (view, state) => state === view.state ? view.render : discovery.renderOf?.(state, view.route) ?? null;
  const mountOf = (view, body) => {
    const path = view.mountPath ?? mountPath ?? [];
    return { node: nodeAt(body, path) ?? body, path };
  };
  // Lists of each canonical render (record of a trigger parameter, dependent list of a text dimension).
  const viewLists = new Map();
  for (const view of views) {
    const body = view.render?.body;
    if (!body) continue;
    const mount = mountOf(view, body);
    const state = meta.state(view.render);
    const params = view.params?.length ? { Id: String(view.route).split('/').pop() } : {};
    viewLists.set(view.key, lists.findLists(mount.node, meta, state, { locale, tz: session.tz, context: { params, dims: dimList(session, view.state) } }));
  }
  const recordOf = (view, variant) => {
    const value = Object.values(variant.params ?? {})[0];
    if (value == null) return null;
    const action = variant.node ? attr(variant.node, 'data-action') : null;
    const holds = (list, test) => list.items.some(item => { let found = false; walk(item.node, node => { if (found) return false; if (test(node)) found = true; }); return found; });
    for (const test of [node => node === variant.node, node => action && isElement(node) && attr(node, 'data-action') === action]) {
      for (const list of viewLists.get(view?.key) ?? []) {
        if (!holds(list, test)) continue;
        const hit = (meta.state(view.render)[list.collection] ?? list.rows).find(row => same(row[meta.key(list.collection)], value));
        if (hit) return { collection: list.collection, row: hit };
      }
    }
    const candidates = meta.collections.filter(collection => collection.key !== '#' && collection.rows.some(row => same(row[collection.key], value)));
    return candidates.length === 1 ? { collection: candidates[0].name, row: candidates[0].rows.find(row => same(row[candidates[0].key], value)) } : null;
  };
  const eventOf = (key, info) => {
    if (!records.events.has(key)) records.events.set(key, { key, observations: [], ...info });
    return records.events.get(key);
  };
  const handlerOf = (node, type, name) => {
    const own = (node?.LS ?? []).find(item => item.startsWith(type + '@'));
    if (own) return own.slice(type.length + 1);
    const branch = session.analysis.branchSites?.get(name);
    if (branch) return branch;
    const global = (s0.inspect.listeners ?? []).find(item => item.type === type && (item.target === 'document' || item.target === 'window'));
    return global?.handler ? global.handler.file + ':' + global.handler.line : null;
  };

  // ---- round A: triggers and controls of every view in every state, and the shell controls per view -----------------
  const probes = [];
  const plan = new Map();
  const add = (probe, info) => { probes.push(probe); plan.set(probe.key, { ...info, steps: probe.steps, page: probe.page, storage: probe.storage }); };
  const shellSeen = new Set();
  const deferred = [];
  const canonicalGroups = new Map();
  for (const view of views) {
    if (view.render) canonicalGroups.set(view.key, new Set(dims.triggers(mountOf(view, view.render.body).node, { kind, scope: view.key, delegated, base: view.render.body, basePath: mountOf(view, view.render.body).path }).map(group => group.name)));
  }
  for (const view of views) {
    for (const state of statesOf(view)) {
      const render = renderOf(view, state);
      if (!render) continue;
      const prefix = reachFor(view, state);
      const mount = mountOf(view, render.body);
      const canonicalState = state === view.state;
      const groups = dims.triggers(mount.node, { kind, scope: view.key, delegated, base: render.body, basePath: mount.path });
      // A trigger without parameter attributes inside the items of a correlated list: its parameter is the key of the
      // record of the item that contains it (2.4), one variant per item.
      for (const group of groups) {
        if (group.params.length || group.elements.length < 2) continue;
        const lists = canonicalState ? viewLists.get(view.key) ?? [] : [];
        for (const list of lists) {
          const keyOf = element => { const index = list.items.findIndex(item => { let found = false; walk(item.node, node => { if (found) return false; if (node === element.node) found = true; }); return found; }); return index >= 0 ? list.rows[index][meta.key(list.collection)] : undefined; };
          const keyed = group.elements.map(element => ({ element, key: keyOf(element) }));
          if (keyed.some(item => item.key === undefined)) continue;
          group.params = [{ name: 'Id', from: 'record' }];
          group.variants = keyed.map(({ element, key }) => ({ ...element, params: { Id: String(key) } }));
          group.recordList = list.collection;
          break;
        }
      }
      for (const group of groups) {
        const variants = canonicalState ? group.variants.slice(0, 8) : group.variants.slice(0, 1);
        for (const [index, variant] of variants.entries()) {
          const toggle = !group.params.length;
          const steps = toggle ? [{ do: 'snap', tag: 'before' }, { do: 'click', target: variant.target }, { do: 'snap', tag: 'after' }, { do: 'click', target: variant.target }, { do: 'snap', tag: 'again' }] : snapPair([{ do: 'click', target: variant.target }]);
          const probe = { key: 'A|' + view.key + '|' + state.key + '|' + group.name + '|' + String(index).padStart(2, '0'), page: pageOf(view), prefix, steps };
          const info = { type: 'trigger', view, state, group, variant, prefix, render, scope: view.key };
          if (!canonicalState && canonicalGroups.get(view.key)?.has(group.name)) deferred.push({ probe: { ...probe, key: probe.key.replace(/^A\|/, 'B|state|') }, info });
          else add(probe, info);
        }
      }
      if (canonicalState) {
        for (const control of dims.controls(mount.node, { delegated, basePath: mount.path, base: render.body })) {
          if (control.form && control.info.name && (control.text || control.number)) continue;
          const target = dims.controlTarget(render.body, control);
          const values = control.enumerable ? (control.info.options?.map(option => option.value) ?? (control.info.type === 'checkbox' ? [String(!control.info.current)] : [])).filter(value => String(value) !== String(control.info.current)).slice(0, 8) : [control.text ? 'zzzz-ssam' : String(perturb.sentinel(control.node, { clock: session.clock }))];
          for (const [index, value] of values.entries()) {
            const action = control.text ? { do: 'type', target, value } : { do: 'set', target, value: control.info.type === 'checkbox' ? String(value) === 'true' : value };
            add({ key: 'A|' + view.key + '|' + state.key + '|ctl|' + control.key + '|' + String(index).padStart(2, '0'), page: pageOf(view), prefix, steps: snapPair([action]) }, { type: 'control', view, state, control, value, prefix, render, target, scope: view.key });
          }
        }
        for (const form of dims.formsOf(mount.node, { delegated, basePath: mount.path })) records.forms.push({ form, view, state, prefix, render, scope: view.key });
        // Shell (outside the mount): controls, triggers and forms, probed in every view to see view-dependent effects.
        if (mountPath && appIndex != null) {
          const shellRoots = (render.body.c ?? []).map((node, index) => ({ node, index })).filter(({ node, index }) => isElement(node) && (index === appIndex || (node.t !== 'dialog' && attr(node, 'role') !== 'dialog')));
          for (const { node, index } of shellRoots) {
            const pruned = index === appIndex ? pruneAt(node, mountPath.slice(1)) : node;
            for (const control of dims.controls(pruned, { delegated, basePath: [index], base: render.body })) {
              const target = dims.controlTarget(render.body, control);
              const global = session.dims.find(dim => (dim.target?.id && dim.target.id === control.info.id));
              const values = control.enumerable ? (global?.values ?? control.info.options?.map(option => option.value) ?? []).filter(value => String(value) !== String(control.info.current)).slice(0, 8) : [control.text ? 'zzzz-ssam' : String(perturb.sentinel(control.node, { clock: session.clock }))];
              for (const [i, value] of values.entries()) {
                const action = control.text ? { do: 'type', target, value } : { do: 'set', target, value };
                add({ key: 'A|' + view.key + '|' + state.key + '|shell|' + control.key + '|' + String(i).padStart(2, '0'), page: pageOf(view), prefix, steps: snapPair([action]) }, { type: 'control', view, state, control, value, prefix, render, target, scope: 'shell' });
              }
            }
            for (const group of dims.triggers(pruned, { kind, scope: 'shell', delegated, base: render.body, basePath: [index] })) {
              for (const [i, variant] of group.variants.slice(0, view.default ? 8 : 1).entries()) add({ key: 'A|' + view.key + '|' + state.key + '|shelltrig|' + group.name + '|' + String(i).padStart(2, '0'), page: pageOf(view), prefix, steps: snapPair([{ do: 'click', target: variant.target }]) }, { type: 'trigger', view, state, group, variant, prefix, render, scope: 'shell' });
            }
            for (const form of dims.formsOf(pruned, { delegated, basePath: [index] })) {
              const id = 'shellform|' + form.name;
              add({ key: 'A|' + view.key + '|' + state.key + '|' + id, page: pageOf(view), prefix, steps: snapPair([{ do: 'submit', target: attr(form.node, 'id') ? { id: attr(form.node, 'id') } : { path: form.path } }]) }, { type: 'submit', view, state, form, prefix, render, scope: 'shell' });
              if (!shellSeen.has(id)) { shellSeen.add(id); records.notes.push({ shellForm: form.name }); }
            }
          }
        }
      }
    }
  }
  const resultsA = await session.run(probes);
  const observationsA = interpretAll(resultsA, plan, { ctx, meta, session, records, recordOf, templateOf, eventOf, handlerOf, dimsModule: dims, locale, stateViewOf });

  // ---- dimensions from round A ---------------------------------------------------------------------------------------
  classifyDimensions(observationsA, { session, records, discovery, dimsModule: dims });

  // ---- round B: modal internals, target-guarded listeners, toast close, reset triggers -------------------------------
  const probesB = [];
  const planB = new Map();
  const addB = (probe, info) => { probesB.push(probe); planB.set(probe.key, { ...info, steps: probe.steps, page: probe.page, storage: probe.storage }); };
  for (const { probe, info } of deferred) {
    const event = records.events.get(info.scope + ':click:' + info.group.name);
    const canonical = (event?.observations ?? []).filter(item => item.info.state === info.view.state);
    const uiOnly = canonical.length && canonical.every(item => item.effects.length && item.effects.every(effect => effect.kind === 'setDimension'));
    if (!uiOnly) addB(probe, info);
  }
  const explored = new Set();
  const modalProbes = (list, add, round) => {
  for (const opening of list) {
    if (explored.has(opening.id)) continue;
    explored.add(opening.id);
    const { view, state, prefix, variant, after, modal } = opening;
    const containerPath = modal.path;
    const container = nodeAt(after.body, containerPath);
    if (!container) continue;
    const openPrefix = prefix.concat([{ do: 'click', target: variant.target }]);
    const canonicalOpening = opening.canonical;
    for (const group of dims.triggers(container, { kind, scope: modal.key, delegated, base: after.body, basePath: containerPath })) {
      for (const [index, item] of group.variants.slice(0, canonicalOpening ? 8 : 2).entries()) {
        add({ key: round + '|' + modal.key + '|' + opening.id + '|' + group.name + '|' + String(index).padStart(2, '0'), page: pageOf(view), prefix: openPrefix, steps: snapPair([{ do: 'click', target: item.target }]) }, { type: 'trigger', view, state, group, variant: item, prefix: openPrefix, render: after, scope: modal.key, modal: modal.key, opener: opening });
      }
    }
    if (canonicalOpening) {
      for (const control of dims.controls(container, { delegated, basePath: containerPath, base: after.body })) {
        if (control.form && control.info.name && (control.text || control.number || control.info.type === 'checkbox')) continue;
        const target = dims.controlTarget(after.body, control);
        const values = control.enumerable ? (control.info.options?.map(option => option.value) ?? (control.info.type === 'checkbox' ? [String(!control.info.current)] : [])).filter(value => String(value) !== String(control.info.current)).slice(0, 8) : [control.text ? 'zzzz-ssam' : String(perturb.sentinel(control.node, { clock: session.clock }))];
        for (const [index, value] of values.entries()) {
          const action = control.text ? { do: 'type', target, value } : { do: 'set', target, value: control.info.type === 'checkbox' ? String(value) === 'true' : value };
          add({ key: round + '|' + modal.key + '|' + opening.id + '|ctl|' + control.key + '|' + String(index).padStart(2, '0'), page: pageOf(view), prefix: openPrefix, steps: snapPair([action]) }, { type: 'control', view, state, control, value, prefix: openPrefix, render: after, target, scope: modal.key, modal: modal.key, opener: opening });
        }
      }
      for (const form of dims.formsOf(container, { delegated, basePath: containerPath })) records.forms.push({ form, view, state, prefix: openPrefix, render: after, scope: modal.key, modal: modal.key, opener: opening });
      // A listener on the container itself whose effect needs the container as target (backdrop close, 2.4).
      if ((container.L ?? []).includes('click') && !records.targetGuarded.some(item => item.container === containerPath.join('.'))) {
        records.targetGuarded.push({ container: containerPath.join('.'), modal: modal.key, pending: true, handler: (container.LS ?? []).find(item => item.startsWith('click@'))?.slice(6) ?? null });
        const firstChild = (container.c ?? []).findIndex(isElement);
        add({ key: round + '|' + modal.key + '|guard|self', page: pageOf(view), prefix: openPrefix, steps: snapPair([{ do: 'click', target: { path: containerPath }, coords: [-1, -1] }]) }, { type: 'guard', which: 'self', modal: modal.key, containerPath, view, state, prefix: openPrefix });
        if (firstChild >= 0) add({ key: round + '|' + modal.key + '|guard|child', page: pageOf(view), prefix: openPrefix, steps: snapPair([{ do: 'click', target: { path: containerPath.concat(firstChild) }, coords: [1, 1] }]) }, { type: 'guard', which: 'child', modal: modal.key, containerPath, view, state, prefix: openPrefix });
      }
    }
  }
  };
  modalProbes(modals.openings(observationsA, modalRegistry), addB, 'B');
  // Toast close buttons (a toast exists only after an event that shows it).
  const toastSource = observationsA.find(item => item.obs?.toasts?.length && !item.obs.diff.length) ?? observationsA.find(item => item.obs?.toasts?.length);
  if (toastSource) {
    const toast = toastSource.obs.toasts[0];
    const toastIndex = (toastSource.after.body.c?.[toast.region]?.c ?? []).indexOf(toast.node);
    const toastPath = [toast.region, toastIndex];
    const buttons = elementsWithPath(toast.node).filter(({ node }) => (node.L ?? []).includes('click') || node.t === 'button');
    for (const [index, button] of buttons.slice(0, 2).entries()) {
      const steps = toastSource.probe.steps.filter(step => step.do !== 'snap');
      addB({ key: 'B|toast|close|' + index, page: toastSource.probe.page, prefix: toastSource.probe.prefix.concat(steps), steps: snapPair([{ do: 'click', target: { path: toastPath.concat(button.path) } }]) }, { type: 'toastClose', node: button.node, view: toastSource.info.view, state: toastSource.info.state, scope: 'shell', name: attr(button.node, 'aria-label') ? toastCloseName(button.node) : 'toast-close' });
    }
  }
  // Parameterless triggers without effect in the canonical state: reset probes with the view dimensions moved.
  for (const item of observationsA) {
    if (item.info.type !== 'trigger' || item.info.group.params.length || item.effects.length || item.ui || item.info.state !== item.info.view.state) continue;
    const view = item.info.view;
    const moves = [];
    for (const dim of records.screenDims.values()) {
      if (dim.view !== view.key) continue;
      const other = (dim.values ?? []).find(value => String(value) !== String(dim.initial));
      if (other === undefined) continue;
      moves.push(...dimensionMove(dim, other));
    }
    for (const dim of session.dims.filter(entry => entry.kind === 'text' || entry.scope === 'global' && entry.kind === 'text')) moves.push({ do: 'type', target: dim.target, value: 'ssam' });
    if (!moves.length) continue;
    addB({ key: 'B|reset|' + view.key + '|' + item.info.group.name, page: pageOf(view), prefix: item.info.prefix.concat(moves), steps: snapPair([{ do: 'click', target: item.info.variant.target }]) }, { ...item.info, type: 'reset', moves });
  }
  const resultsB = await session.run(probesB);
  const observationsB = interpretAll(resultsB, planB, { ctx, meta, session, records, recordOf, templateOf, eventOf, handlerOf, dimsModule: dims, locale, stateViewOf });
  classifyDimensions(observationsB, { session, records, discovery, dimsModule: dims });
  modals.targetGuards(observationsB, records);

  // ---- round C: forms (perturbation), text dimension search words, value controls of data events ---------------------
  const probesC = [];
  const planC = new Map();
  const addC = (probe, info) => { probesC.push(probe); planC.set(probe.key, { ...info, steps: probe.steps, page: probe.page, storage: probe.storage }); };
  modalProbes(modals.openings([...observationsA, ...observationsB], modalRegistry), addC, 'C');
  for (const entry of records.forms) {
    const body = entry.render.body;
    const formNode = entry.form.node;
    const controlsOf = dims.formControls(formNode, body);
    if (!controlsOf.length) continue;
    const formTarget = attr(formNode, 'id') ? { id: attr(formNode, 'id') } : { path: entry.form.path };
    const targetOf = node => attr(node, 'id') ? { id: attr(node, 'id') } : { m: { t: node.t, a: [['name', attr(node, 'name')]] }, i: 0 };
    const sentinels = new Map(controlsOf.map(node => [node, perturb.sentinel(node, { clock: session.clock })]));
    const setAll = (values) => controlsOf.map(node => ({ do: 'set', target: targetOf(node), value: values.get(node) }));
    const base = entry.prefix;
    const name = entry.scope + '|' + entry.form.name;
    addC({ key: 'C|form|' + name + '|valid', page: pageOf(entry.view), prefix: base, steps: snapPair([...setAll(sentinels), { do: 'submit', target: formTarget }]) }, { type: 'submit', phase: 'valid', ...entry, controls: controlsOf, sentinels, values: sentinels });
    for (const node of controlsOf) {
      // Leave one out: every sentinel but this control, which keeps its current value.
      const values = new Map(sentinels); values.set(node, perturb.controlInfo(node).type === 'checkbox' ? perturb.controlInfo(node).current : perturb.controlInfo(node).current);
      addC({ key: 'C|form|' + name + '|one|' + attr(node, 'name'), page: pageOf(entry.view), prefix: base, steps: snapPair([...setAll(values), { do: 'submit', target: formTarget }]) }, { type: 'submit', phase: 'one', control: node, ...entry, controls: controlsOf, sentinels, values });
    }
    entry.targetOf = targetOf; entry.formTarget = formTarget; entry.controlsList = controlsOf; entry.sentinels = sentinels;
  }
  // Value controls next to a data event outside forms (e.g. the quantity of a modal before "add").
  for (const item of [...observationsA, ...observationsB]) {
    if (item.info.type !== 'trigger' || !item.effects.some(effect => DATA.has(effect.kind)) || item.info.state !== (item.info.opener?.state ?? item.info.view.state)) continue;
    const scopeRoot = item.info.modal ? nodeAt(item.before.body, item.info.opener.modal.path) : null;
    if (!scopeRoot) continue;
    for (const control of dims.controls(scopeRoot, { delegated: new Set(['change', 'input']), basePath: item.info.opener.modal.path })) {
      if (control.form || !control.number) continue;
      const value = String(perturb.sentinel(control.node, { clock: session.clock }));
      const target = dims.controlTarget(item.before.body, control);
      addC({ key: 'C|value|' + item.probe.key + '|' + control.key, page: item.probe.page, prefix: item.probe.prefix, steps: [{ do: 'value', target, value }, ...item.probe.steps] }, { ...item.info, type: 'trigger', valueControl: { name: control.info.id ?? control.info.name ?? control.key, value } });
    }
  }
  const resultsC = await session.run(probesC);
  const observationsC = interpretAll(resultsC, planC, { ctx, meta, session, records, recordOf, templateOf, eventOf, handlerOf, dimsModule: dims, locale, stateViewOf });
  classifyDimensions(observationsC, { session, records, discovery, dimsModule: dims });
  modals.targetGuards(observationsC, records);

  // ---- round D: invalid values per constraint, select values, fallback sentinels, search words, hidden states -------
  const probesD = [];
  const planD = new Map();
  const addD = (probe, info) => { probesD.push(probe); planD.set(probe.key, { ...info, steps: probe.steps, page: probe.page, storage: probe.storage }); };
  for (const entry of records.forms) {
    if (!entry.controlsList) continue;
    const name = entry.scope + '|' + entry.form.name;
    const valid = observationsC.find(item => item.probe.key === 'C|form|' + name + '|valid');
    const accepted = new Map(entry.sentinels);
    const rejectedAll = valid && !valid.obs.diff.length && !valid.obs.navigated;
    if (rejectedAll) {
      // Leave one out: a sentinel whose removal makes the submission accepted is rejected by the script; it is replaced
      // by a value of the same-named field of another row of the store (data the model already accepts), else the
      // current value. The rule itself has no attribute constraint and stays out of scope (3.7).
      for (const node of entry.controlsList) {
        const one = observationsC.find(item => item.probe.key === 'C|form|' + name + '|one|' + attr(node, 'name'));
        if (one && (one.obs.diff.length || one.obs.navigated)) {
          const fallback = fallbackValue(meta, attr(node, 'name'), perturb.controlInfo(node).current);
          accepted.set(node, fallback ?? perturb.controlInfo(node).current);
          records.outOfScope.push({ what: 'validação de script sem restrição de atributo em ' + attr(node, 'name'), message: message(valid), where: entry.form.name, why: 'a perturbação não alcança a regra; a escrita acontece sem ela' });
        }
      }
    }
    entry.accepted = accepted;
    const setAll = values => entry.controlsList.map(node => ({ do: 'set', target: entry.targetOf(node), value: values.get(node) }));
    if (rejectedAll) addD({ key: 'D|form|' + name + '|valid2', page: pageOf(entry.view), prefix: entry.prefix, steps: snapPair([...setAll(accepted), { do: 'submit', target: entry.formTarget }]) }, { type: 'submit', phase: 'valid', ...entry, values: accepted });
    for (const node of entry.controlsList) {
      for (const invalid of perturb.invalidValues(node)) {
        const values = new Map(accepted); values.set(node, invalid.value);
        addD({ key: 'D|form|' + name + '|invalid|' + attr(node, 'name') + '|' + invalid.constraint, page: pageOf(entry.view), prefix: entry.prefix, steps: snapPair([...setAll(values), { do: 'submit', target: entry.formTarget }]) }, { type: 'submit', phase: 'invalid', ...entry, control: node, invalid, values });
      }
      if (node.t === 'select') {
        for (const option of (perturb.controlInfo(node).options ?? []).slice(0, 8)) {
          if (option.value === '' || String(option.value) === String(accepted.get(node))) continue;
          const values = new Map(accepted); values.set(node, option.value);
          addD({ key: 'D|form|' + name + '|option|' + attr(node, 'name') + '|' + option.value, page: pageOf(entry.view), prefix: entry.prefix, steps: snapPair([...setAll(values), { do: 'submit', target: entry.formTarget }]) }, { type: 'submit', phase: 'option', ...entry, control: node, values });
        }
      }
    }
  }
  // Search words of text dimensions over their dependent list.
  for (const dim of [...records.screenDims.values(), ...session.dims].filter(entry => entry.kind === 'text')) {
    const view = views.find(item => item.key === dim.view) ?? views.find(item => item.default);
    const empty = [...observationsA].find(item => item.info.type === 'control' && item.info.control?.key === dim.controlKey && item.info.view === view);
    const list = (viewLists.get(view.key) ?? []).find(candidate => empty && !lists.findLists(nodeAt(empty.after.body, view.mountPath ?? mountPath ?? []) ?? empty.after.body, meta, meta.state(empty.after), { locale }).some(other => other.collection === candidate.collection && other.items.length === candidate.items.length));
    if (!list) continue;
    dim.dependent = { collection: list.collection };
    const textFields = meta.byName.get(list.collection).fields.filter(field => field.type === 'Text').map(field => field.name);
    const state = meta.state(view.render);
    for (const { field, word } of perturb.searchWords(state[list.collection] ?? [], textFields)) {
      if (!field) continue;
      addD({ key: 'D|search|' + dim.key + '|' + field, page: pageOf(view), prefix: reachFor(view, view.state), steps: snapPair([{ do: 'type', target: dim.target, value: word }]) }, { type: 'search', dim, field, word, view, list });
    }
  }
  // Hidden state after a navigating data event: the same route rendered from the same store without the event.
  const hiddenSources = [...observationsA, ...observationsC].filter(item => item.obs?.navigated && item.obs.diff.length && item.info.type === 'submit' && item.info.phase === 'valid');
  for (const item of hiddenSources) {
    const target = templateOf(item.obs.to);
    if (!target) continue;
    addD({ key: 'D|plain|' + item.probe.key, page: item.probe.page, storage: { local: item.after.storage }, prefix: [...session.stateSteps(item.info.state ?? target.state)], steps: [{ do: 'nav', route: item.obs.to }, { do: 'snap', tag: 'plain' }] }, { type: 'plain', source: item, view: target });
  }
  const resultsD = await session.run(probesD);
  const observationsD = interpretAll(resultsD, planD, { ctx, meta, session, records, recordOf, templateOf, eventOf, handlerOf, dimsModule: dims, locale, stateViewOf });
  // Filter forms: a form of a view whose submissions write nothing, navigate nowhere and open nothing, but change what the
  // view shows (the search filters of a listing) applies the values of its controls. Each select of it is a view dimension
  // whose renders are submissions with only that control changed; every submission sets them all from their controls,
  // which refreshes the lists that read them, and a list filters by them as by any dimension.
  const probesF = [], planF = new Map(), filterDims = new Map();
  for (const entry of records.forms) {
    if (entry.modal || !entry.view || !entry.controlsList) continue;
    const submits = [...observationsC, ...observationsD].filter(item => item.info.type === 'submit' && item.info.form === entry.form && item.info.view === entry.view && item.obs);
    if (!submits.length) continue;
    const quiet = submits.every(item => !item.effects.some(effect => DATA.has(effect.kind) || effect.kind === 'navigate' || effect.kind === 'openPopup') && !item.obs.navigated && !item.obs.opened);
    if (!quiet || !submits.some(item => item.obs.mountChanged)) continue;
    // what changed is the rows a list of the store shows (a form that only builds something in a script variable is no filter)
    const baseLists = viewLists.get(entry.view.key) ?? [];
    const filtersRows = baseLists.length > 0 && submits.some(item => {
      const mount = nodeAt(item.after.body, entry.view.mountPath ?? mountPath ?? []) ?? item.after.body;
      const after = lists.findLists(mount, meta, meta.state(item.after), { locale });
      return baseLists.some(base => { const other = after.find(list => list.collection === base.collection); return other ? other.items.length !== base.items.length : base.items.length >= 2; });
    });
    if (!filtersRows) continue;
    const created = [];
    for (const node of entry.controlsList) {
      if (node.t !== 'select') continue;
      const id = attr(node, 'id') ?? attr(node, 'name');
      if (!id || records.screenDims.has(id)) continue;
      const info = perturb.controlInfo(node);
      const values = (info.options ?? []).map(option => String(option.value));
      if (values.length < 2) continue;
      const dim = { key: id, name: dims.dimensionName(id, { kind: 'control' }), kind: 'control', control: 'select', target: entry.targetOf(node), view: entry.view.key, modal: null, scope: 'view',
        values, initial: String(info.current ?? ''), type: dims.valueType(values), renders: new Map(), applied: 'submit' };
      records.screenDims.set(id, dim);
      created.push(dim);
      for (const value of values.slice(0, 8)) {
        if (value === dim.initial) continue;
        const key = 'F|' + entry.view.key + '|' + id + '|' + value;
        const steps = snapPair([{ do: 'set', target: entry.targetOf(node), value }, { do: 'submit', target: entry.formTarget }]);
        probesF.push({ key, page: pageOf(entry.view), prefix: entry.prefix, steps });
        planF.set(key, { type: 'submit', phase: 'filter', ...entry, control: node, value, dim, steps, page: pageOf(entry.view) });
      }
    }
    if (created.length) filterDims.set(entry.form, { created, submits });
  }
  const resultsF = probesF.length ? await session.run(probesF) : new Map();
  const observationsF = interpretAll(resultsF, planF, { ctx, meta, session, records, recordOf, templateOf, eventOf, handlerOf, dimsModule: dims, locale, stateViewOf });
  for (const item of observationsF) item.info.dim.renders.set(String(item.info.value), item.after);
  for (const [form, { created, submits }] of filterDims) {
    for (const item of [...submits, ...observationsF.filter(entry => entry.info.form === form)]) {
      for (const dim of [...created].reverse()) if (!item.effects.some(effect => effect.kind === 'setDimension' && effect.dimension === dim.key)) item.effects.unshift({ kind: 'setDimension', dimension: dim.key, value: { dim: dim.key } });
      item.ui = false;
      // the submission reads the controls the dimensions are bound to: no parameter of its own
      const event = item.event ? records.events.get(item.event) : null;
      if (event) event.params = [];
    }
  }

  // ---- round E: triggers of hidden states (e.g. dismiss of a success banner) ----------------------------------------
  const probesE = [];
  const planE = new Map();
  for (const item of observationsD.filter(entry => entry.info.type === 'plain')) {
    const plain = resultsD.get(item.probe.key)?.snaps?.[0];
    const source = item.info.source;
    if (!plain) continue;
    const viewMount = mountPath ?? [];
    const a = nodeAt(source.after.body, viewMount), b = nodeAt(plain.body, viewMount);
    const { onlyA } = alignTrees(a, b);
    const extra = onlyA.filter(isElement).filter(node => !onlyA.some(other => other !== node && (other.c ?? []).includes(node)));
    if (!extra.length) continue;
    const hiddenName = hiddenDimensionName(extra, session.analysis.branches);
    const hidden = { key: hiddenName.key, name: hiddenName.name, kind: 'hidden', view: item.info.view.key, scope: 'view', type: 'Integer', initial: '0', values: ['0'], nodes: extra.map(node => renderKey(node)), setBy: source.probe.key };
    records.screenDims.set('hidden|' + hidden.key, hidden);
    source.hiddenDim = hidden;
    for (const peer of records.events.get(source.event)?.observations ?? [source]) {
      const peerNav = peer.effects.find(effect => effect.kind === 'navigate');
      if (peerNav && !peer.effects.some(effect => effect.kind === 'setDimension' && effect.dimension === hidden.key)) peer.effects.push({ kind: 'setDimension', dimension: hidden.key, value: peerNav.params?.Id ?? [{ lit: peerNav.to }] });
    }
    const sourceSteps = source.probe.steps.filter(step => step.do !== 'snap');
    for (const node of extra) {
      const path = pathOf(source.after.body, node);
      for (const group of dims.triggers(node, { kind, scope: item.info.view.key, delegated, base: source.after.body, basePath: path })) {
        const variant = group.variants[0];
        const key = 'E|' + item.info.view.key + '|' + group.name;
        probesE.push({ key, page: source.probe.page, prefix: source.probe.prefix.concat(sourceSteps), steps: snapPair([{ do: 'click', target: variant.target }]) });
        planE.set(key, { type: 'trigger', view: item.info.view, state: item.info.view.state, group, variant, prefix: source.probe.prefix.concat(sourceSteps), render: source.after, scope: item.info.view.key, hidden, plain, steps: probesE[probesE.length - 1].steps, page: source.probe.page });
      }
    }
  }
  const resultsE = probesE.length ? await session.run(probesE) : new Map();
  const observationsE = interpretAll(resultsE, planE, { ctx, meta, session, records, recordOf, templateOf, eventOf, handlerOf, dimsModule: dims, locale, stateViewOf });
  for (const item of observationsE) {
    if (item.info.hidden && item.ui && !item.effects.some(effect => DATA.has(effect.kind))) {
      const plainMount = nodeAt(item.info.plain.body, mountPath ?? []), afterMount = nodeAt(item.after.body, mountPath ?? []);
      if (renderKey(plainMount) === renderKey(afterMount)) { item.effects.push({ kind: 'setDimension', dimension: item.info.hidden.key, value: { lit: 0 } }); item.ui = false; }
    }
  }

  // ---- assembly ------------------------------------------------------------------------------------------------------
  const all = [...observationsA, ...observationsB, ...observationsC, ...observationsD, ...observationsE];
  const forms = assembleForms(records, [...observationsC, ...observationsD]);
  const searches = assembleSearch(observationsD, { meta, views, mountPath, lists, locale });
  const probeMs = Math.round(performance.now() - t1);
  return {
    kind, discovery, meta, records, observations: all, forms, searches, viewLists, crawlMs, probeMs, locale, delegated, recordOf,
    modals: modals.kinds(all, records, { session, views, registry: modalRegistry }),
    dims: [...session.dims, ...records.screenDims.values()]
  };
}

const DATA = new Set(['insert', 'insertFrom', 'updateFrom', 'removeWhere', 'update', 'toggle', 'increment', 'upsert', 'remove']);

function toastCloseName(node) { return attr(node, 'aria-label') ? attr(node, 'aria-label').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'close'; }

function pruneAt(node, path) {
  if (!path.length) return { ...node, c: [] };
  const [head, ...rest] = path;
  return { ...node, c: (node.c ?? []).map((child, index) => index === head ? pruneAt(child, rest) : child) };
}

function pathOf(root, target) {
  let found = null;
  const visit = (node, path) => { if (found) return; if (node === target) { found = path; return; } (node.c ?? []).forEach((child, index) => visit(child, path.concat(index))); };
  visit(root, []);
  return found ?? [];
}

function dimensionMove(dim, value) {
  if (dim.kind === 'control') return [{ do: 'set', target: dim.target, value }];
  if (dim.kind === 'text') return [{ do: 'type', target: dim.target, value }];
  if (dim.kind === 'trigger') return [{ do: 'click', target: { m: { t: dim.match.t, a: dim.match.a.concat([[dim.param, String(value)]]) }, i: 0 } }];
  if (dim.kind === 'toggle') return [{ do: 'click', target: dim.target }];
  return [];
}

function hiddenDimensionName(nodes, branches) {
  const cls = classes(nodes[0])[0] ?? nodes[0].t;
  const words = cls.split(/[^A-Za-z0-9]+/).filter(Boolean);
  // The state property the prototype clears in the branch of the trigger inside the hidden subtree.
  let name = null;
  walk(nodes[0], node => { if (name) return false; const action = isElement(node) ? attr(node, 'data-action') : null; if (action && branches?.get(action)?.length) name = branches.get(action)[0]; });
  const pascalName = text => text.split(/[^A-Za-z0-9]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join('');
  return { key: name ?? words.join('-'), name: pascalName(name ?? cls) };
}

function message(observation) {
  const before = observation.before?.body, after = observation.after?.body;
  if (!before || !after) return null;
  const alerts = body => elementsWithPath(body).filter(({ node }) => attr(node, 'role') === 'alert' || /error|alert|invalid/.test(attr(node, 'class') ?? '')).map(({ node, path }) => ({ node, path, text: textOf(node).trim() }));
  const a = alerts(before), b = alerts(after);
  for (const item of b) {
    const old = a.find(other => other.path.join('.') === item.path.join('.'));
    if (item.text && (!old || old.text !== item.text)) return item.text;
  }
  const toast = observation.obs?.toasts?.find(entry => entry.classes.some(token => /error|danger|alert/.test(token)));
  return toast?.text ?? null;
}

function messageTarget(observation) {
  const before = observation.before?.body, after = observation.after?.body;
  const alerts = body => elementsWithPath(body).filter(({ node }) => attr(node, 'role') === 'alert' || /error|alert|invalid/.test(attr(node, 'class') ?? '')).map(({ node, path }) => ({ node, path, text: textOf(node).trim() }));
  const a = alerts(before ?? {}), b = alerts(after ?? {});
  for (const item of b) {
    const old = a.find(other => other.path.join('.') === item.path.join('.'));
    if (item.text && (!old || old.text !== item.text)) return { kind: 'alert', id: attr(item.node, 'id'), path: item.path };
  }
  return observation.obs?.toasts?.length ? { kind: 'toast' } : null;
}

function fallbackValue(meta, field, current) {
  for (const collection of meta.collections) {
    const values = collection.rows.map(row => row[field]).filter(value => value !== undefined && value !== null && value !== '' && String(value) !== String(current));
    if (values.length) return String(values[0]);
  }
  return null;
}

// Observation of every probe of a round: effects (navigation, modal, toast, data), UI-only changes, event registry.
function interpretAll(results, plan, options) {
  const { ctx, meta, session, records, recordOf, templateOf, eventOf, handlerOf } = options;
  const out = [];
  for (const [key, info] of plan) {
    const result = results.get(key);
    const snaps = result?.snaps ?? [];
    const probe = { key, page: info.page ?? session.entry, prefix: info.prefix ?? [], steps: info.steps ?? [], storage: info.storage ?? null };
    if (info.type === 'plain') { out.push({ probe, info, effects: [], obs: null }); continue; }
    const before = snaps.find(snap => snap.tag === 'before'), after = snaps.find(snap => snap.tag === 'after');
    if (!before || !after) { if (result?.failure) session.warn({ code: 'PrototypeProbeFailed', probe: key, error: String(result.failure.error ?? JSON.stringify(result.failure)).split('\n')[0] }); continue; }
    const obs = observe(before, after, { ...ctx, ignore: info.type === 'control' ? info.control.path : null });
    if (info.type === 'control' && obs.appChanged && !obs.liveChanged) {
      // The DOM changed only by the control's own value attribute? Compare with the control path masked.
      const mask = body => { const copy = JSON.parse(JSON.stringify(body)); let node = copy; for (const index of info.control.path) node = node?.c?.[index]; if (node) { delete node.p; node.a = (node.a ?? []).filter(([name]) => name !== 'value'); } return copy; };
      const appIndex = ctx.appIndex;
      const pick = body => appIndex != null ? body.c?.[appIndex] : body;
      if (renderKey(pick(mask(before.body))) === renderKey(pick(mask(after.body)))) obs.appChanged = false;
    }
    const effects = [];
    let residue = [];
    const item = { probe, info, before, after, obs, effects, residue, ui: false, again: snaps.find(snap => snap.tag === 'again') ?? null };
    if (obs.navigated) {
      const target = templateOf(obs.to);
      effects.push({ kind: 'navigate', to: obs.to, view: target?.key ?? null, template: target?.template ?? null, params: navParams(target, obs.to, info, obs) });
    } else if (options.stateViewOf) {
      const from = options.stateViewOf(before), to = options.stateViewOf(after);
      if (to && to !== from) effects.push({ kind: 'navigate', view: to.key, params: {} });
    }
    if (obs.closed) effects.push({ kind: 'closePopup' });
    if (obs.opened) effects.push({ kind: 'openPopup', title: obs.opened.title, path: obs.opened.path, classAttr: obs.opened.classAttr, inputs: Object.fromEntries(Object.entries(info.variant?.params ?? {}).map(([name]) => [name, [{ param: name }]])) });
    for (const toast of obs.toasts) effects.push({ kind: 'toast', text: [{ lit: toast.text }], variant: toast.classes.find(token => /error|danger|warn|success|info/.test(token)) ?? null, region: toast.region, node: toast.node });
    if (obs.toastsRemoved && !obs.toasts.length) effects.push({ kind: 'setDimension', dimension: 'aviso', value: { lit: '' } });
    if (obs.diff.length) {
      const dataCtx = {
        before: obs.storeBefore, after: obs.storeAfter, clock: session.clock, clockIso: new Date(session.clock).toISOString(),
        params: { ...paramContext(info.variant?.params), ...formParams(info) },
        dims: dimList(session, info.state).map(dim => ({ ...dim })),
        controls: formValues(info),
        self: info.type === 'control' ? { name: info.control.info.name ?? info.control.info.id ?? info.control.key, value: info.value, key: selfKey(info) } : null
      };
      if (info.valueControl) dataCtx.controls.push({ name: info.valueControl.name, value: info.valueControl.value });
      else if (info.modal && info.opener?.modal?.path && info.type === 'trigger') {
        // Value controls next to the trigger (outside forms) take part with their current value.
        const container = info.opener.modal.path.reduce((node, index) => node?.c?.[index], before.body);
        if (container) for (const { node } of elementsWithPath(container)) if (node.t === 'input' && node.p && !['checkbox', 'radio', 'hidden'].includes(String(attr(node, 'type') ?? 'text')) && !attr(node, 'name')) dataCtx.controls.push({ name: attr(node, 'id') ?? 'value', value: node.p.v });
      }
      const explained = explainStore(obs.diff, dataCtx, meta);
      effects.push(...explained.effects);
      residue = explained.residue;
      item.residue = residue;
    }
    if (!effects.length && (obs.appChanged || obs.liveChanged || obs.modalChanged)) item.ui = true;
    if (obs.appChanged && !effects.some(effect => DATA.has(effect.kind) || effect.kind === 'navigate')) item.appOnly = true;
    if (info.type === 'trigger' && info.group && !effects.length && obs.liveChanged && !obs.appChanged) item.ui = true;
    item.effects.push(...[]);
    out.push(item);
    // Event registry.
    if (info.type === 'guard' || info.type === 'plain' || info.type === 'search' || info.type === 'reset' && !effects.length) continue;
    if (info.type === 'submit' && (info.phase === 'invalid' || info.phase === 'one')) continue;
    const eventInfo = eventIdentity(info);
    if (!eventInfo) continue;
    const event = eventOf(eventInfo.key, { scope: info.scope, on: eventInfo.on, name: eventInfo.name, selector: eventInfo.selector, params: eventInfo.params, handler: handlerOf(eventInfo.node, eventInfo.on, eventInfo.name) });
    event.observations.push(item);
    item.event = event.key;
    item.context = { view: info.view?.key, dims: dimValues(session, info.state), params: { ...paramContext(info.variant?.params), ...formParams(info) }, row: info.variant ? recordOf(info.view, info.variant)?.row ?? null : null, controls: Object.fromEntries(formValues(info).map(control => [control.name, control.value])) };
    if (info.type === 'control' && info.value !== undefined) item.context.dims[info.control.info.id ?? info.control.key] = String(info.value);
  }
  return out;
}

function selfKey(info) {
  const node = info.control?.node;
  if (!node) return null;
  const data = (node.a ?? []).find(([name]) => name.startsWith('data-') && /^\d+$/.test(name === 'data-id' ? attr(node, name) : attr(node, name) ?? ''));
  return data ? data[1] : null;
}

function formParams(info) {
  const node = info.form?.node;
  if (!node) return {};
  const out = {};
  for (const [name, value] of node.a ?? []) if (name.startsWith('data-') && name !== 'data-action') out[name.replace(/^data-/, '').split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('')] = value;
  return out;
}

function formValues(info) {
  const list = info.controls ?? info.controlsList;
  if (!info.values || !list) return [];
  return list.map(node => ({ name: attr(node, 'name'), value: info.values.get(node) }));
}

function navParams(target, route, info, obs) {
  if (!target?.template?.includes('{id}')) return {};
  const value = String(route).split('/').pop();
  const options = [];
  for (const [name, param] of Object.entries(info.variant?.params ?? {})) if (same(param, value)) options.push({ param: name });
  for (const item of obs.diff) for (const row of item.inserted) if (same(Object.values(row)[0], value) || same(row.Id, value)) options.push({ inserted: item.collection });
  options.push({ lit: value });
  return { Id: options };
}

function eventIdentity(info) {
  if (info.type === 'trigger' || info.type === 'reset') {
    const group = info.group;
    const selector = group.attrs?.find(([name]) => name === 'data-action') ? '[data-action="' + group.name + '"]' : attr({ a: group.attrs }, 'id') ? '#' + group.name : group.tag + (group.attrs?.find(([name]) => name === 'class') ? '.' + group.attrs.find(([name]) => name === 'class')[1].split(/\s+/)[0] : '');
    return { key: info.scope + ':click:' + group.name, on: 'click', name: group.name, selector, params: group.params, node: info.variant?.node };
  }
  if (info.type === 'toastClose') return { key: 'shell:click:' + info.name, on: 'click', name: info.name, selector: 'button[aria-label="' + (attr(info.node, 'aria-label') ?? '') + '"]', params: [], node: info.node };
  if (info.type === 'control') {
    const control = info.control;
    const on = control.text ? 'input' : 'change';
    const name = control.info.id ?? control.info.name ?? control.key.replace(/[[\]]/g, '');
    const selector = control.info.id ? '#' + control.info.id : control.key;
    return { key: info.scope + ':' + on + ':' + name, on, name, selector, params: [], node: control.node };
  }
  if (info.type === 'submit') {
    const name = info.form.name;
    return { key: info.scope + ':submit:' + name, on: 'submit', name, selector: attr(info.form.node, 'id') ? '#' + attr(info.form.node, 'id') : 'form', params: Object.keys(formParams(info)).map(param => ({ name: param, from: 'data-' + param.toLowerCase() })), node: info.form.node };
  }
  return null;
}

// Dimensions after a round: controls whose events are UI-only, groups of parameterized triggers that only re-render,
// toggles (the second click restores the DOM) and controls whose value a trigger moves by data-delta.
// Probes of a dimension in rank order: the ones of its own view in that view's canonical state last, so their render is
// the one kept for each value (Map.set keeps the last).
function byCanonical(items, dim) {
  const rank = item => (item.info.view?.key === dim.view ? 2 : 0) + (item.info.state === item.info.view?.state ? 1 : 0);
  return [...items].sort((a, b) => rank(a) - rank(b));
}

function classifyDimensions(observations, { session, records, discovery, dimsModule }) {
  const byEvent = new Map();
  for (const item of observations) if (item.event) { if (!byEvent.has(item.event)) byEvent.set(item.event, []); byEvent.get(item.event).push(item); }
  for (const items of byEvent.values()) {
    const info = items[0].info;
    if (info.type === 'control') {
      const control = info.control;
      const id = control.info.id ?? control.info.name ?? control.key;
      const global = session.dims.find(dim => dim.key === id || dim.target?.id === control.info.id);
      if (global) {
        for (const item of items) { if (!item.effects.some(effect => effect.kind === 'setDimension' && effect.dimension === global.key)) item.effects.unshift({ kind: 'setDimension', dimension: global.key, value: [{ control: id, self: true }] }); item.ui = false; }
        if (control.text && !global.kind) global.kind = 'text';
        continue;
      }
      const uiOnly = items.every(item => !item.effects.some(effect => DATA.has(effect.kind) || effect.kind === 'openPopup')) && items.some(item => item.ui || item.effects.some(effect => effect.kind === 'navigate'));
      if (!uiOnly) continue;
      const scope = info.scope === 'shell' ? 'global' : info.modal ? 'modal' : 'view';
      const dim = records.screenDims.get(id) ?? {
        key: id, name: dimsModule.dimensionName(id, { kind: 'control' }), kind: control.text ? 'text' : 'control', control: control.info.type,
        target: info.target, view: info.view?.key, modal: info.modal ?? null, scope, controlKey: control.key,
        values: control.enumerable ? (control.info.options?.map(option => option.value) ?? ['true', 'false']) : [], initial: String(control.info.current ?? ''),
        type: control.text ? 'Text' : control.number ? 'Integer' : dimsModule.valueType(control.info.options?.map(option => option.value) ?? (control.info.type === 'checkbox' ? ['true', 'false'] : [])),
        renders: new Map()
      };
      if (control.info.type === 'checkbox') dim.type = 'Boolean';
      // The render of each value is the one probed in the dimension's own view in its canonical state (a shell control is
      // probed in every view and state; the last probe must not decide the explored state).
      for (const item of byCanonical(items, dim)) { dim.renders.set(String(item.info.value), item.after); if (!item.effects.some(effect => effect.kind === 'setDimension')) item.effects.unshift({ kind: 'setDimension', dimension: dim.key, value: [{ control: id, self: true }] }); item.ui = false; }
      if (scope === 'global' && !session.dims.some(other => other.key === dim.key)) { dim.scope = 'global'; session.dims.push(dim); } else records.screenDims.set(id, dim);
      continue;
    }
    if (info.type !== 'trigger') continue;
    const group = info.group;
    // A trigger moving the value of a number control by its data-delta, inside the bounds of the control.
    const deltaParam = group.params.find(param => param.from === 'data-delta');
    const live = items.filter(item => item.ui && !item.effects.length && item.obs.liveChanged && !item.obs.mountChanged || item.ui && deltaParam && item.obs.liveChanged);
    if (deltaParam && live.length) {
      for (const item of live) {
        const changed = changedControl(item.before.body, item.after.body);
        if (!changed) continue;
        const id = attr(changed.node, 'id') ?? attr(changed.node, 'name') ?? 'quantity';
        const dim = records.screenDims.get(id) ?? { key: id, name: dimsModule.dimensionName(id, { kind: 'control' }), kind: 'control', control: 'number', target: attr(changed.node, 'id') ? { id: attr(changed.node, 'id') } : null, view: item.info.view?.key, modal: item.info.modal ?? null, scope: item.info.modal ? 'modal' : 'view', type: 'Integer', values: [], initial: String(changed.from), renders: new Map() };
        records.screenDims.set(id, dim);
        const min = attr(changed.node, 'min'), max = attr(changed.node, 'max');
        item.effects.push({ kind: 'setDimension', dimension: dim.key, value: [{ add: [{ dim: dim.key }, { param: deltaParam.name }], min: min != null ? { lit: Number(min) } : null, max: max != null ? { attr: 'max', of: dim.key, lit: Number(max) } : null }] });
        item.ui = false;
      }
      continue;
    }
    const uiItems = items.filter(item => item.ui && !item.effects.length);
    const quiet = items.filter(item => !item.ui && !item.effects.length);
    if (group.params.length && uiItems.length >= 1 && uiItems.length + quiet.length === items.length && items.length >= 2 && new Set(items.map(item => JSON.stringify(item.info.variant?.params))).size >= 2 && items.every(item => !item.effects.some(effect => DATA.has(effect.kind) || effect.kind === 'openPopup' || effect.kind === 'navigate'))) {
      const param = group.params[0];
      const values = items.map(item => item.info.variant.params[param.name]);
      const unchanged = items.find(item => !item.ui && !item.effects.length);
      const name = dimsModule.dimensionName(group.name, { kind: 'trigger', branches: session.analysis.branches });
      const baseMatch = items[0].info.variant.target?.m ? { t: items[0].info.variant.target.m.t, a: items[0].info.variant.target.m.a.filter(([attribute]) => attribute !== param.from && attribute !== 'class') } : { t: group.tag, a: [['data-action', group.name]] };
      const dim = records.screenDims.get(group.name) ?? { key: group.name, name, kind: 'trigger', param: param.from, match: baseMatch, view: info.view?.key, modal: info.modal ?? null, scope: info.modal ? 'modal' : 'view', values: [...new Set(values)], initial: unchanged ? unchanged.info.variant.params[param.name] : values[0], type: dimsModule.valueType(values), renders: new Map() };
      for (const item of byCanonical(items, dim)) { dim.renders.set(String(item.info.variant.params[param.name]), item.after); item.effects.unshift({ kind: 'setDimension', dimension: dim.key, value: [{ param: param.name }] }); item.ui = false; }
      records.screenDims.set(group.name, dim);
      continue;
    }
    if (!group.params.length && uiItems.length) {
      const item = uiItems[0];
      if (item.again && renderKey(item.again.body) === renderKey(item.before.body)) {
        const toggled = toggledElement(item.before.body, item.after.body);
        const name = session.analysis.branches?.get(group.name)?.[0] ? dimsModule.dimensionName(group.name, { kind: 'trigger', branches: session.analysis.branches }) : toggled ? toggled.name : dimsModule.dimensionName(group.name, { kind: 'trigger' });
        const dim = records.screenDims.get(group.name) ?? { key: group.name, name, kind: 'toggle', target: info.variant.target, view: info.view?.key, modal: info.modal ?? null, scope: info.modal ? 'modal' : 'view', values: ['false', 'true'], initial: 'false', type: 'Boolean', renders: new Map(), toggled };
        records.screenDims.set(group.name, dim);
        for (const entry of uiItems) { entry.effects.unshift({ kind: 'setDimension', dimension: dim.key, value: [{ not: { dim: dim.key } }] }); entry.ui = false; }
      }
    }
  }
  // Global dimension set from another event (e.g. "login" sets the account): the app root equals the crawl render of
  // the state with that dimension at that value.
  for (const item of observations) {
    if (!(item.ui || item.appOnly) || !item.obs?.appChanged || item.effects.some(effect => effect.kind === 'setDimension' || DATA.has(effect.kind) || effect.kind === 'navigate') || !discovery?.renderOf) continue;
    for (const dim of session.dims.filter(entry => entry.kind === 'control' && entry.scope === 'global')) {
      const current = item.info.state?.assign && dim.key in item.info.state.assign ? String(item.info.state.assign[dim.key]) : String(dim.initial);
      for (const value of dim.values ?? []) {
        if (String(value) === current) continue;
        const state = discovery.states?.find(entry => entry.key === (String(value) === String(dim.initial) ? 'S0' : dim.key + '=' + value));
        const route = item.obs.to;
        const render = state ? discovery.renderOf(state, route) : null;
        if (!render) continue;
        const appIndex = discovery.mount?.[0];
        if (appIndex == null) continue;
        if (renderKey(render.body.c[appIndex]) === renderKey(item.after.body.c[appIndex])) {
          const options = [];
          for (const [name, param] of Object.entries(item.info.variant?.params ?? {})) if (same(param, value)) options.push({ param: name });
          options.push({ lit: value });
          item.effects.push({ kind: 'setDimension', dimension: dim.key, value: options });
          item.ui = false;
          break;
        }
      }
      if (!item.ui) break;
    }
  }
  // Reset probes: the dimensions that came back to their initial value.
  for (const item of observations.filter(entry => entry.info.type === 'reset')) {
    const view = item.info.view;
    for (const dim of [...records.screenDims.values()].filter(entry => entry.view === view.key)) {
      if (dimIndicator(dim, item.after.body) === dimIndicator(dim, item.info.render.body) && dimIndicator(dim, item.before.body) !== dimIndicator(dim, item.info.render.body)) item.effects.push({ kind: 'setDimension', dimension: dim.key, value: [{ lit: dim.initial }] });
    }
    for (const dim of session.dims.filter(entry => entry.kind === 'text')) {
      if (dimIndicator(dim, item.after.body) === dimIndicator(dim, item.info.render.body) && dimIndicator(dim, item.before.body) !== dimIndicator(dim, item.info.render.body)) item.effects.push({ kind: 'setDimension', dimension: dim.key, value: [{ lit: dim.initial ?? '' }] });
    }
    if (item.effects.length) {
      item.ui = false;
      item.event = item.info.scope + ':click:' + item.info.group.name;
      item.context = { view: item.info.view?.key, dims: dimValues(session, item.info.state), params: {}, row: null, controls: {} };
      const event = records.events.get(item.info.scope + ':click:' + item.info.group.name);
      if (event) { event.observations = event.observations.filter(entry => entry.info.state !== item.info.state || entry.info.type === 'reset'); if (!event.observations.includes(item)) event.observations.push(item); }
    }
  }
}

function dimIndicator(dim, body) {
  if (dim.target?.id) {
    let found = null;
    walk(body, node => { if (found) return false; if (isElement(node) && attr(node, 'id') === dim.target.id) found = node; });
    return found ? JSON.stringify(found.p ?? attr(found, 'value')) : null;
  }
  if (dim.kind === 'trigger') {
    const out = [];
    walk(body, node => { if (isElement(node) && attr(node, 'data-action') === dim.key) out.push((attr(node, 'class') ?? '') + '|' + (attr(node, 'aria-pressed') ?? '')); });
    return out.join(',');
  }
  if (dim.kind === 'toggle' && dim.toggled) {
    let found = null;
    walk(body, node => { if (found) return false; if (isElement(node) && classes(node).includes(dim.toggled.base)) found = node; });
    return found ? attr(found, 'class') : null;
  }
  return null;
}

function changedControl(before, after) {
  const a = elementsWithPath(before).filter(({ node }) => node.p && node.t === 'input');
  const b = elementsWithPath(after).filter(({ node }) => node.p && node.t === 'input');
  for (const item of b) {
    const old = a.find(other => other.path.join('.') === item.path.join('.'));
    if (old && old.node.p.v !== item.node.p.v) return { node: item.node, from: old.node.p.v, to: item.node.p.v };
  }
  return null;
}

function toggledElement(before, after) {
  const { pairs } = alignTrees(before, after);
  for (const [a, b] of pairs) {
    if (!isElement(a)) continue;
    const ca = classes(a), cb = classes(b);
    const added = cb.filter(token => !ca.includes(token)), removed = ca.filter(token => !cb.includes(token));
    if (added.length + removed.length === 1 && ca.length + cb.length) {
      const base = ca.filter(token => cb.includes(token))[0] ?? a.t;
      const token = added[0] ?? removed[0];
      const pascal = text => text.split(/[^A-Za-z0-9]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join('');
      return { base, token, name: pascal(base) + pascal(token) };
    }
  }
  return null;
}

// Forms: the validate rules (one invalid value per constraint) and the write effects of the accepted submission.
function assembleForms(records, observations) {
  const out = [];
  for (const entry of records.forms) {
    if (!entry.controlsList) continue;
    const name = entry.scope + '|' + entry.form.name;
    const prefix = (phase) => observations.filter(item => item.probe.key.startsWith('C|form|' + name + '|' + phase) || item.probe.key.startsWith('D|form|' + name + '|' + phase));
    const valid = prefix('valid2')[0] ?? prefix('valid')[0];
    const rules = [];
    for (const item of prefix('invalid')) {
      const text = message(item);
      const invalid = item.info.invalid;
      const control = attr(item.info.control, 'name');
      if (text && !item.obs.diff.length) rules.push({ control, constraint: invalid.constraint, when: invalid.pred, message: text, target: messageTarget(item) });
      else rules.push({ control, constraint: invalid.constraint, accepted: true });
    }
    // A required rule with the same message as the minlength rule is subsumed by it.
    const effective = rules.filter(rule => !rule.accepted).filter(rule => !(rule.constraint === 'required' && rules.some(other => other.control === rule.control && other.constraint === 'minlength' && other.message === rule.message)));
    out.push({ key: entry.scope + ':submit:' + entry.form.name, entry, valid, rules: effective, accepted: rules.filter(rule => rule.accepted), options: prefix('option') });
  }
  return out;
}

function assembleSearch(observations, { meta, views, mountPath, lists, locale }) {
  const out = new Map();
  for (const item of observations.filter(entry => entry.info.type === 'search')) {
    const { dim, field, word, list } = item.info;
    const view = item.info.view;
    const mount = mountPath ? mountPath.reduce((node, index) => node?.c?.[index], item.after.body) : item.after.body;
    const state = meta.state(item.after);
    let rows = [];
    if (list.keySlot) {
      // Rows shown after the probe: the key slot attribute of the list items (a single item is not a group).
      const key = meta.key(list.collection);
      const values = [];
      walk(mount, node => { if (isElement(node) && node.t === list.keySlot.node.t && attr(node, list.keySlot.attr) != null) values.push(attr(node, list.keySlot.attr)); });
      rows = values.map(value => (state[list.collection] ?? []).find(row => same(row[key], list.keySlot.fmt === 'suffix' ? (String(value).match(/(\d+)$/) ?? [])[1] : value))).filter(Boolean);
    } else {
      const found = lists.findLists(mount, meta, state, { locale }).find(entry => entry.collection === list.collection);
      rows = found ? found.rows : [];
    }
    const canonicalState = meta.state(view.render);
    const expected = (canonicalState[list.collection] ?? []).filter(row => String(row[field] ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(word));
    const reacts = rows.length > 0 && rows.every(row => expected.includes(row) || String(row[field] ?? '').toLowerCase().includes(word));
    if (!out.has(dim.key)) out.set(dim.key, { dimension: dim.key, collection: list.collection, fields: [], probes: [] });
    out.get(dim.key).probes.push({ field, word, shown: rows.length, reacts });
    if (reacts) out.get(dim.key).fields.push(field);
  }
  return out;
}

export { evaluate, separate, alignTrees };
