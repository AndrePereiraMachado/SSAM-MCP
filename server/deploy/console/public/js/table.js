// Table builder (DESIGN.md 6.4): column specs, one sort key with aria-sort, client-side filter, loading / empty /
// error rows with the exact sentences, sticky first column, focus kept across the re-renders of polling.
// normalizeText, filterRows, compareValues and sortRows are pure and unit-tested.

import { h, clear, dot } from './dom.js';

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

/** Lowercase without accents, for instant filters. */
export function normalizeText(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Rows whose fields contain the text (case and accent insensitive). fields: keys or (row) => string. */
export function filterRows(rows, text, fields) {
  const q = normalizeText(text).trim();
  if (!q) return rows.slice();
  return rows.filter((r) => fields.some((f) => normalizeText(typeof f === 'function' ? f(r) : r[f]).includes(q)));
}

function isNull(v) {
  return v == null || (typeof v === 'number' && Number.isNaN(v));
}

/** Numbers numerically, strings with the pt-BR collator (numeric aware), arrays element by element. */
export function compareValues(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const x = a[i];
      const y = b[i];
      if (isNull(x) && isNull(y)) continue;
      if (isNull(x)) return 1;
      if (isNull(y)) return -1;
      const c = compareValues(x, y);
      if (c) return c;
    }
    return 0;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/** Stable sort by keyFn; nulls always last (both directions). */
export function sortRows(rows, keyFn, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  return rows
    .map((r, i) => ({ r, i, v: keyFn(r) }))
    .sort((x, y) => {
      const xn = isNull(x.v);
      const yn = isNull(y.v);
      if (xn && yn) return x.i - y.i;
      if (xn) return 1;
      if (yn) return -1;
      const c = compareValues(x.v, y.v) * sign;
      return c || x.i - y.i;
    })
    .map((x) => x.r);
}

/** `n de m` when filtered, `m` otherwise. */
export function countText(shown, total) {
  return shown === total ? String(total) : `${shown} de ${total}`;
}

/**
 * createTable(opts)
 *  columns: [{key, label, num, mono, cls, ell: 'name'|'client'|'machine'|'path'|'code', wrap,
 *             sort: false | (row) => value, firstDir, text: (row) => string, title: (row) => string,
 *             cell: (row, td) => void, level: (row) => '' | 'warn' | 'bad' | 'ok'}]
 *  rowKey(row) -> string; defaultSort {key, dir, compare?}; empty, filteredEmpty: sentences;
 *  label: accessible table name; detail: {isOpen(row), render(row, td)}; after(tbody, ncols): extra rows;
 *  footer(tfoot, ncols); rowClass(row)
 */
export function createTable(opts) {
  const cols = opts.columns;
  const table = h('table', { class: ['grid', opts.cls] });
  if (opts.label) table.setAttribute('aria-label', opts.label);
  const thead = h('thead');
  const tbody = h('tbody');
  const tfoot = h('tfoot');
  table.append(thead, tbody, tfoot);
  const wrap = h('div', { class: 'table-wrap' }, table);
  // When the table is wider than its wrap (it scrolls sideways), the row actions column sticks to the right edge,
  // as the first column sticks to the left, so the actions stay reachable without scrolling.
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      wrap.classList.toggle('overflows', table.scrollWidth > wrap.clientWidth + 1);
    });
    ro.observe(wrap);
    ro.observe(table);
  }

  const defaultSort = opts.defaultSort || { key: cols[0].key, dir: 'asc' };
  let sort = { key: defaultSort.key, dir: defaultSort.dir, isDefault: true };
  let rows = null;
  let predicate = null;
  let error = null;
  let shown = 0;

  const headRow = h('tr');
  const ths = new Map();
  for (const c of cols) {
    const th = h('th', { scope: 'col', class: [c.num && 'num', c.thCls, c.key === 'actions' && 'actions'] });
    const sortable = c.sort !== false && (typeof c.sort === 'function' || typeof c.text === 'function');
    if (sortable) {
      const arrow = h('span', { class: 'arrow', 'aria-hidden': 'true' });
      const btn = h('button', { type: 'button', class: 'sortbtn' }, c.label, arrow);
      btn.addEventListener('click', () => toggleSort(c));
      th.append(btn);
      ths.set(c.key, { th, arrow, sortable: true });
    } else {
      th.textContent = c.label;
      ths.set(c.key, { th, arrow: null, sortable: false });
    }
    headRow.append(th);
  }
  thead.append(headRow);

  function sortKeyFn(c) {
    if (typeof c.sort === 'function') return c.sort;
    if (c.text) return (r) => c.text(r);
    return () => null;
  }

  function toggleSort(c) {
    if (sort.key === c.key) sort = { key: c.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
    else sort = { key: c.key, dir: c.firstDir || (c.num ? 'desc' : 'asc') };
    render();
    const btn = ths.get(c.key)?.th.querySelector('button');
    if (btn) btn.focus();
    if (opts.onSort) opts.onSort(sort);
  }

  function paintHeaders() {
    for (const [key, { th, arrow, sortable }] of ths) {
      if (!sortable) continue;
      if (key === sort.key) {
        th.setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending');
        arrow.textContent = sort.dir === 'asc' ? ' ▲' : ' ▼';
      } else {
        th.removeAttribute('aria-sort');
        arrow.textContent = '';
      }
    }
  }

  function sorted(list) {
    if (sort.isDefault && defaultSort.compare) {
      return list.map((r, i) => ({ r, i })).sort((a, b) => defaultSort.compare(a.r, b.r) || a.i - b.i).map((x) => x.r);
    }
    const c = cols.find((x) => x.key === sort.key);
    if (!c) return list.slice();
    return sortRows(list, sortKeyFn(c), sort.dir);
  }

  function stateRow(text, cls, level) {
    const td = h('td', { colspan: cols.length });
    if (level) td.append(dot(level));
    td.append(text);
    return h('tr', { class: ['state', cls] }, td);
  }

  function fillCell(c, r, td) {
    if (c.cell) c.cell(r, td);
    else {
      const t = c.text ? c.text(r) : '';
      td.textContent = t == null ? '' : String(t);
      if (c.ell && t) td.title = String(t);
    }
    if (c.title) {
      const t = c.title(r);
      if (t) td.title = t;
    }
    if (c.level) {
      const l = c.level(r);
      if (l) td.classList.add(`lv-${l}`);
    }
  }

  function render() {
    paintHeaders();
    const active = document.activeElement;
    let focusKey = null;
    if (active && tbody.contains(active)) {
      const tr = active.closest('tr[data-key]');
      focusKey = tr ? `${tr.dataset.key}\u0000${active.dataset.fk || ''}` : null;
    }
    clear(tbody);
    clear(tfoot);
    if (error) tbody.append(stateRow(`Não foi possível carregar: ${error}.`, 'error', 'bad'));
    if (rows == null) {
      if (!error) tbody.append(stateRow('Carregando…', 'loading'));
      shown = 0;
      return;
    }
    const list = predicate ? rows.filter(predicate) : rows.slice();
    shown = list.length;
    if (!list.length) {
      const sentence = rows.length && predicate ? (opts.filteredEmpty || opts.empty) : opts.empty;
      if (sentence) tbody.append(typeof sentence === 'function' ? sentence(stateRow) : stateRow(sentence, 'empty'));
    }
    for (const r of sorted(list)) {
      const key = opts.rowKey ? String(opts.rowKey(r)) : '';
      const tr = h('tr', { class: opts.rowClass ? opts.rowClass(r) : null });
      if (key) tr.dataset.key = key;
      for (const c of cols) {
        const td = h(c === cols[0] ? 'th' : 'td', {
          class: [c.num && 'num', c.mono && 'mono', c.ell && `ell ell-${c.ell}`, c.wrap && 'wrap', c.cls],
        });
        if (c === cols[0]) td.setAttribute('scope', 'row');
        fillCell(c, r, td);
        tr.append(td);
      }
      tbody.append(tr);
      if (opts.detail && opts.detail.isOpen(r)) {
        const td = h('td', { colspan: cols.length });
        opts.detail.render(r, td);
        const dtr = h('tr', { class: 'detail' }, td);
        if (key) dtr.dataset.key = `${key}:detail`;
        tbody.append(dtr);
      }
    }
    if (opts.after) opts.after(tbody, cols.length, list);
    if (opts.footer) opts.footer(tfoot, cols.length, list);
    if (focusKey) {
      for (const el of tbody.querySelectorAll('button, a, input, select')) {
        const tr = el.closest('tr[data-key]');
        if (tr && `${tr.dataset.key}\u0000${el.dataset.fk || ''}` === focusKey) {
          el.focus({ preventScroll: true });
          break;
        }
      }
    }
  }

  render();

  return {
    el: wrap,
    table,
    tbody,
    setRows(next) {
      rows = Array.isArray(next) ? next : [];
      error = null;
      render();
    },
    setError(message) {
      error = message || 'erro desconhecido';
      render();
    },
    clearError() {
      error = null;
      render();
    },
    hasRows() {
      return rows != null;
    },
    setFilter(fn) {
      predicate = fn || null;
      render();
    },
    rerender: render,
    counts() {
      return { shown, total: rows ? rows.length : 0 };
    },
    countText() {
      return countText(shown, rows ? rows.length : 0);
    },
    resetSort() {
      sort = { key: defaultSort.key, dir: defaultSort.dir, isDefault: true };
      render();
    },
    rowElement(key) {
      for (const tr of tbody.querySelectorAll('tr[data-key]')) if (tr.dataset.key === key) return tr;
      return null;
    },
  };
}

/**
 * Key-value table (`Item | Valor | Últimas 24 h`), collapsing to label above value at phone width.
 * rows: [{label, value: string | Node | (td) => void, level, title, spark: Node}]
 */
export function kvTable(rows, { label, spark = false, cls } = {}) {
  const table = h('table', { class: ['kv', spark && 'has-spark', cls] });
  if (label) table.setAttribute('aria-label', label);
  const tbody = h('tbody');
  table.append(tbody);
  fillKv(tbody, rows, spark);
  return table;
}

export function fillKv(tbody, rows, spark) {
  clear(tbody);
  for (const r of rows) {
    if (!r) continue;
    const th = h('th', { scope: 'row' }, r.label);
    const td = h('td', { class: [r.level && `lv-${r.level}`, r.mono && 'mono'] });
    if (typeof r.value === 'function') r.value(td);
    else if (r.value instanceof Node) td.append(r.value);
    else td.textContent = r.value == null ? '—' : String(r.value);
    if (r.title) td.title = r.title;
    const tr = h('tr', null, th, td);
    if (spark) tr.append(h('td', { class: 'sparkcell' }, r.spark || ''));
    tbody.append(tr);
  }
}
