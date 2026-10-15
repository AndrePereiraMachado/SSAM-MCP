// Small DOM helpers. Every value reaches the page through textContent or setAttribute: customer names, MCP client
// names, user agents, machine names and Caddy paths are customer-controlled (DESIGN.md 2.3), so nothing here ever
// parses HTML. Presentation pieces of the v2 layout (SPEC painel v2, 2.4, 2.6, 3.7, 3.9, 3.10): pills, chips, the
// page header, panels, icon buttons and inline notices.

import { icon } from './icons.js';

/**
 * h('td', {class: 'num', title: 'x', on: {click: fn}}, 'text', childNode, ...)
 * Strings and numbers become text nodes; null/undefined/false children are skipped; arrays are flattened.
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) setAttrs(el, attrs);
  append(el, children);
  return el;
}

export function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'on') {
      for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    } else if (k === 'class') {
      el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
    } else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) if (dv != null) el.dataset[dk] = String(dv);
    } else if (k === 'text') {
      el.textContent = String(v);
    } else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'value' || k === 'selected') {
      el[k] = v;
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** 8 px status dot: level ok | warn | bad | info | muted. Decorative: the word next to it carries the status. */
export function dot(level) {
  return h('span', { class: ['dot', level || 'muted'], 'aria-hidden': 'true' });
}

/** Status pill: dot + word on the level's soft background (the word is always there; color only repeats it). */
export function status(level, word) {
  const lv = level || 'muted';
  return h('span', { class: ['pill', `pill-${lv}`] }, dot(lv), word);
}

/** Dot + word in one inline element (top bar, key-value values). */
export function statusInline(level, word) {
  return h('span', { class: 'st' }, dot(level), word);
}

/** Neutral metadata chip (lanes, area words, origins); mono for codes and tags. */
export function chip(text, { mono = false, title } = {}) {
  return h('span', { class: ['chip', mono && 'mono'], title }, text);
}

/** Text button (row actions, links inside tables); an optional trailing icon. */
export function textButton(label, onClick, attrs = {}) {
  const { class: cls, icon: ic, ...rest } = attrs;
  return h('button', { type: 'button', class: ['tbtn', cls], ...rest, on: { click: onClick } }, label, ic ? icon(ic, 16) : null);
}

/** Regular button: kind '' | 'primary' | 'ghost' | 'danger' | 'danger-fill'; attrs.icon puts a 16 px icon first. */
export function button(label, onClick, kind = '', attrs = {}) {
  const { class: cls, icon: ic, ...rest } = attrs;
  return h('button', { type: 'button', class: ['btn', kind && `btn-${kind}`, cls], ...rest, on: onClick ? { click: onClick } : null },
    ic ? icon(ic, 16) : null, label);
}

/** Icon-only button: the label is its accessible name and tooltip. */
export function iconButton(iconName, label, onClick, attrs = {}) {
  const { class: cls, size = 16, ...rest } = attrs;
  return h('button', { type: 'button', class: ['btn-icon', cls], 'aria-label': label, title: label, ...rest, on: onClick ? { click: onClick } : null },
    icon(iconName, size));
}

/** Joins nodes/strings with the ` · ` separator. */
export function joinDots(items) {
  const out = [];
  for (const it of items) {
    if (it == null || it === false || it === '') continue;
    if (out.length) out.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, ' · '));
    out.push(it);
  }
  return out;
}

/** Page header of a view: h1 title, one subtitle line (ellipsis, full text in title) and the view-level actions. */
export function pageHead(id, title) {
  const sub = h('p', { class: 'page-sub' });
  const actions = h('div', { class: 'page-actions' });
  const el = h('header', { class: 'page-head' },
    h('div', { class: 'page-titles' }, h('h1', { class: 'page-title', id }, title), sub), actions);
  return {
    el,
    actions,
    sub,
    setSub(text) {
      sub.textContent = text || '';
      sub.title = text || '';
    },
  };
}

/**
 * Panel (a titled section around a table or a key-value list): `<section class="panel">` with a head (icon, title,
 * count pill, stale chip, controls). opts: {icon, controls, note, toolbar, cls}. Append the body to `el`.
 */
export function panel(id, title, { icon: ic, controls = [], note, toolbar = false, cls } = {}) {
  const count = h('span', { class: 'count', hidden: true });
  const stale = h('span', { class: 'stale', hidden: true });
  const extra = h('span', { class: 'ph-extra' });
  // Toolbar variant (Licenças, Eventos, Histórico): the filters lead, the count sits at the right; the title stays for
  // screen readers (the page title above already names the list).
  const h2 = h('h2', { class: 'panel-title', id }, ic && !toolbar ? h('span', { class: 'ph-icon', 'aria-hidden': 'true' }, icon(ic, 16)) : null,
    h('span', { class: ['title', toolbar && 'sr-only'] }, title), count, extra, stale);
  const ctl = h('div', { class: 'controls' }, controls);
  const head = h('div', { class: ['panel-head', toolbar && 'toolbar'] }, toolbar ? [ctl, h2] : [h2, ctl]);
  const noteEl = note ? h('p', { class: 'panel-note' }, note) : null;
  const el = h('section', { class: ['panel', cls], 'aria-labelledby': id }, head, noteEl);
  return {
    el,
    h2,
    head,
    extra,
    controls: ctl,
    note: noteEl,
    setCount(text) {
      count.textContent = text == null ? '' : String(text);
      count.hidden = text == null || text === '';
    },
    setStale(text) {
      clear(stale);
      if (text) stale.append(icon('clock', 14), text.replace(/^\(|\)$/g, ''));
      stale.hidden = !text;
    },
    setNote(text) {
      if (noteEl) noteEl.textContent = text || '';
    },
  };
}

/** Kept for code that still builds the old heading line: a panel head without the panel box. */
export function sectionHead(title, { id, controls = [] } = {}) {
  const p = panel(id, title, { controls });
  return { el: p.head, h2: p.h2, controls: p.controls, setCount: p.setCount, setStale: p.setStale };
}

const NOTICE_ICON = { info: 'info', warn: 'alert-triangle', bad: 'alert-octagon', ok: 'check-circle', plain: 'shield' };

/** Persistent inline notice strip (2.6): level info | warn | bad | plain; returns {el, set(text), text}. */
export function inlineNotice(level, text, { icon: ic } = {}) {
  const textEl = h('span', { class: 'in-text' }, text || '');
  const extra = h('span', { class: 'in-extra' });
  const el = h('div', { class: ['inotice', `in-${level}`] },
    h('span', { class: 'in-icon', 'aria-hidden': 'true' }, icon(ic || NOTICE_ICON[level] || 'info', 20)), h('span', { class: 'in-body' }, textEl, extra));
  return {
    el,
    extra,
    set(t) {
      textEl.textContent = t || '';
    },
  };
}

/** 28/32/40 px icon chip of a level (ok, warn, bad, info, muted, accent). */
export function iconChip(iconName, level = 'muted', size = 16, cls) {
  return h('span', { class: ['ichip', `ichip-${level}`, cls], 'aria-hidden': 'true' }, icon(iconName, size));
}

/** Labelled select with pt-BR options [{value, label}]. */
export function select(label, options, { value, onChange, cls } = {}) {
  const sel = h('select', { class: ['ctl', cls], 'aria-label': label });
  for (const o of options) sel.append(h('option', { value: o.value }, o.label));
  if (value != null) sel.value = value;
  if (onChange) sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

export function setOptions(sel, options) {
  const keep = sel.value;
  clear(sel);
  for (const o of options) sel.append(h('option', { value: o.value }, o.label));
  if (options.some((o) => o.value === keep)) sel.value = keep;
  return sel;
}

/** Text filter field (with the search icon inside). Returns the <input>; its wrapper is `input.wrapEl`. */
export function filterInput(placeholder, onInput) {
  const inp = h('input', {
    type: 'search', class: 'ctl filter', placeholder, 'aria-label': placeholder,
    autocomplete: 'off', spellcheck: 'false',
  });
  inp.addEventListener('input', () => onInput(inp.value));
  inp.wrapEl = h('span', { class: 'field-search' }, h('span', { class: 'fs-icon', 'aria-hidden': 'true' }, icon('search', 16)), inp);
  return inp;
}

/** Fills a table cell with a relative time and its absolute local time in the title. */
export function timeCell(td, t, rel, title) {
  td.textContent = rel;
  if (title) td.title = title;
  return td;
}
