// Small DOM helpers. Every value reaches the page through textContent or setAttribute: customer names, MCP client
// names, user agents, machine names and Caddy paths are customer-controlled (DESIGN.md 2.3), so nothing here ever
// parses HTML.

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

/** 8 px status dot: level ok | warn | bad | muted. Decorative: the word next to it carries the status. */
export function dot(level) {
  return h('span', { class: ['dot', level || 'muted'], 'aria-hidden': 'true' });
}

/** Dot + word in one inline element. */
export function status(level, word) {
  return h('span', { class: 'st' }, dot(level), word);
}

/** Text button (row actions, links inside tables). */
export function textButton(label, onClick, attrs = {}) {
  const { class: cls, ...rest } = attrs;
  return h('button', { type: 'button', class: ['tbtn', cls], ...rest, on: { click: onClick } }, label);
}

/** Regular button: kind '' | 'primary' | 'danger' | 'danger-fill'. */
export function button(label, onClick, kind = '', attrs = {}) {
  const { class: cls, ...rest } = attrs;
  return h('button', { type: 'button', class: ['btn', kind && `btn-${kind}`, cls], ...rest, on: onClick ? { click: onClick } : null }, label);
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

/** Section heading line: `<h2>TITLE <span class="count">n</span></h2>` plus a controls container on the right. */
export function sectionHead(title, { id, controls = [] } = {}) {
  const count = h('span', { class: 'count' });
  const stale = h('span', { class: 'stale' });
  const h2 = h('h2', { id }, h('span', { class: 'title' }, title), ' ', count, stale);
  const ctl = h('div', { class: 'controls' }, controls);
  const el = h('div', { class: 'head' }, h2, ctl);
  return {
    el,
    h2,
    controls: ctl,
    setCount(text) {
      count.textContent = text == null ? '' : String(text);
    },
    setStale(text) {
      stale.textContent = text ? ` ${text}` : '';
    },
  };
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

/** Text filter field. */
export function filterInput(placeholder, onInput) {
  const inp = h('input', {
    type: 'search', class: 'ctl filter', placeholder, 'aria-label': placeholder,
    autocomplete: 'off', spellcheck: 'false',
  });
  inp.addEventListener('input', () => onInput(inp.value));
  return inp;
}

/** Fills a table cell with a relative time and its absolute local time in the title. */
export function timeCell(td, t, rel, title) {
  td.textContent = rel;
  if (title) td.title = title;
  return td;
}
