// KPI cards of the owner console (SPEC painel v2 3.1): icon chip, label, optional status pill, big value with its unit,
// one context line, an optional visual (linear meter, radial gauges, segmented bar, card sparkline), one detail line
// and, on Visão geral, a footer with the stale chip and `Ver`. Views compute plain descriptors with a pure `kpis()`
// helper; this module turns them into elements and updates them in place on every poll (no rebuild, no focus loss).
//
// Descriptor: {id, label, icon, span: 'w2' | 'w3', level: 'ok' | 'warn' | 'bad' | 'info' | 'unknown',
//   pill: {level, word} | null (omitted: `atenção` / `crítico` for a warn / bad card, see levelPill),
//   value, unit, word (value is a word), muted (missing-data word), context, contextTitle, detail, detailTitle,
//   visual: {kind: 'meter' | 'gauges' | 'segbar' | 'spark' | 'text', ...}, layout: 'split' (value left, visual right),
//   foot: {label, ariaLabel, onClick}}

import { h, clear, status, dot } from './dom.js';
import { icon } from './icons.js';
import { gauge, meter, segbar } from './charts.js';
import { sparkline } from './sparkline.js';

const LEVELS = ['ok', 'warn', 'bad', 'info', 'unknown'];
const LEVEL_WORD = { warn: 'atenção', bad: 'crítico' };

/**
 * The status pill of a card: the descriptor's own ({level, word}; null for none), else, for a card in attention or
 * critical, the word of its level (SPEC 0.2: a status is always a word, the color only repeats it; the border and the
 * icon chip alone told nothing to a screen reader).
 */
export function levelPill(d) {
  if (d.pill !== undefined) return d.pill || null;
  const word = LEVEL_WORD[d.level];
  return word ? { level: d.level, word } : null;
}

function renderVisual(box, v, st) {
  if (!v) {
    if (st.kind) clear(box);
    st.kind = null;
    st.parts = null;
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (v.kind === 'meter') {
    if (st.kind === 'meter') st.parts.update(v);
    else {
      clear(box);
      st.parts = meter(v);
      box.append(st.parts.el);
    }
  } else if (v.kind === 'gauges') {
    const n = (v.items || []).length;
    const m = (v.meters || []).length;
    const same = st.kind === 'gauges' && st.parts.g.length === n && st.parts.m.length === m && st.parts.empty === !!v.empty;
    if (same) {
      v.items.forEach((g, i) => st.parts.g[i].update(g));
      (v.meters || []).forEach((x, i) => st.parts.m[i].update(x));
    } else {
      clear(box);
      const g = (v.items || []).map((x) => gauge(x));
      const ms = (v.meters || []).map((x) => meter(x));
      if (v.empty) box.append(h('p', { class: 'kpi-num word muted' }, v.empty));
      else {
        box.append(h('div', { class: ['gauges', `n${n}`] }, g.map((x) => x.el)));
        if (ms.length) box.append(h('div', { class: 'gauge-meters' }, ms.map((x) => x.el)));
      }
      st.parts = { g, m: ms, empty: !!v.empty };
    }
  } else if (v.kind === 'segbar') {
    clear(box);
    box.append(segbar(v.parts, { label: v.label, legend: v.legend }));
  } else if (v.kind === 'spark') {
    st.spark = v;
    if (st.kind !== 'spark') {
      clear(box);
      if (typeof ResizeObserver === 'function') {
        st.ro = new ResizeObserver(() => drawSpark(box, st));
        st.ro.observe(box);
      }
    }
    drawSpark(box, st, true);
  } else if (v.kind === 'text') {
    clear(box);
    box.append(h('p', { class: ['kpi-vtext', v.muted && 'muted'] }, v.text));
  }
  if (st.kind === 'spark' && v.kind !== 'spark' && st.ro) {
    st.ro.disconnect();
    st.ro = null;
  }
  st.kind = v.kind;
}

function drawSpark(box, st, force) {
  if (st.kind !== 'spark' && !force) return;
  const v = st.spark;
  if (!v) return;
  const w = Math.floor(box.clientWidth);
  if (!w) return;
  if (!force && w === st.sparkW) return;
  st.sparkW = w;
  clear(box);
  box.append(sparkline(v.values, v.label, { w, h: 36, area: true }));
}

/** One KPI card; update(desc) rewrites its texts and visual in place. */
export function kpiCard(viewId, desc) {
  const labelId = `k-${viewId}-${desc.id}`;
  const chip = h('span', { class: 'kpi-icon', 'aria-hidden': 'true' }, icon(desc.icon || 'info', 18));
  const labelEl = h('h3', { class: 'kpi-label', id: labelId }, desc.label);
  const pillBox = h('span', { class: 'kpi-pill' });
  // label and pill share a wrapping box: a long pill drops under the label instead of cutting it (app.css .kpi-titles)
  const titles = h('div', { class: 'kpi-titles' }, labelEl, pillBox);
  const num = h('span', { class: 'kpi-num' });
  const unit = h('span', { class: 'kpi-unit' });
  const valueEl = h('p', { class: 'kpi-value' }, num, unit);
  const context = h('p', { class: 'kpi-context' });
  const visual = h('div', { class: 'kpi-visual', hidden: true });
  const detail = h('p', { class: 'kpi-detail' });
  const stale = h('span', { class: 'kpi-stale', hidden: true });
  const footBtn = h('button', { type: 'button', class: 'tbtn kpi-ver', hidden: true });
  const foot = h('footer', { class: 'kpi-foot', hidden: true }, stale, footBtn);
  const body = h('div', { class: 'kpi-body' }, h('div', { class: 'kpi-main' }, valueEl, context), visual);
  const el = h('section', { class: 'kpi', 'aria-labelledby': labelId },
    h('header', { class: 'kpi-head' }, chip, titles), body, detail, foot);
  const st = { kind: null, parts: null };
  let onFoot = null;
  let staleOn = false;
  footBtn.addEventListener('click', () => {
    if (onFoot) onFoot();
  });

  function update(d) {
    const level = LEVELS.includes(d.level) ? d.level : 'ok';
    el.className = ['kpi', `lv-${level}`, d.span, d.layout, d.cls].filter(Boolean).join(' ');
    if (d.label && labelEl.textContent !== d.label) labelEl.textContent = d.label;
    clear(pillBox);
    const pill = levelPill(d);
    if (pill) pillBox.append(status(pill.level, pill.word));
    pillBox.hidden = !pill;
    const hasValue = d.value != null && d.value !== '';
    valueEl.hidden = !hasValue;
    num.textContent = hasValue ? String(d.value) : '';
    num.className = ['kpi-num', d.word && 'word', d.muted && 'muted'].filter(Boolean).join(' ');
    unit.textContent = d.unit || '';
    unit.hidden = !d.unit;
    clear(context);
    if (d.contextLevel) context.append(dot(d.contextLevel));
    context.append(d.context || '');
    context.hidden = !d.context;
    context.title = d.contextTitle || d.context || '';
    renderVisual(visual, d.visual || null, st);
    detail.textContent = d.detail || '';
    detail.title = d.detailTitle || d.detail || '';
    detail.hidden = !d.detail;
    if (d.foot) {
      onFoot = d.foot.onClick;
      clear(footBtn);
      footBtn.append(d.foot.label || 'Ver', icon('arrow-right', 16));
      footBtn.setAttribute('aria-label', d.foot.ariaLabel || d.foot.label || 'Ver');
    }
    footBtn.hidden = !d.foot;
    foot.hidden = !d.foot && !staleOn;
  }
  update(desc);
  return {
    el,
    update,
    setStale(text) {
      clear(stale);
      if (text) stale.append(icon('clock', 14), text);
      stale.hidden = !text;
      staleOn = !!text;
      foot.hidden = footBtn.hidden && !staleOn;
    },
  };
}

/**
 * The card grid of a view: `<section class="kgrid">` with an .sr-only h2 (`Indicadores`). defs: [{id, label, icon, span}]
 * build the loading cards; render(descs) creates, updates and orders the cards; error(msg) marks them.
 */
export function createCards(viewId, defs, { heading = 'Indicadores', cls } = {}) {
  const hid = `h-${viewId}-kpi`;
  const el = h('section', { class: ['kgrid', cls, (defs || []).length === 4 && 'n4'], 'aria-labelledby': hid }, h('h2', { class: 'sr-only', id: hid }, heading));
  const cards = new Map();
  let hasData = false;

  function loadingDesc(d, text, level) {
    return { ...d, value: '—', muted: true, context: text, contextLevel: level || null, level: 'unknown', visual: null, detail: null, pill: null };
  }

  for (const d of defs || []) {
    const c = kpiCard(viewId, loadingDesc(d, 'Carregando…'));
    cards.set(d.id, c);
    el.append(c.el);
  }

  return {
    el,
    cards,
    render(descs) {
      hasData = true;
      const ids = descs.map((d) => d.id);
      for (const [id, c] of cards) {
        if (!ids.includes(id)) {
          c.el.remove();
          cards.delete(id);
        }
      }
      for (const d of descs) {
        let c = cards.get(d.id);
        if (c) c.update(d);
        else {
          c = kpiCard(viewId, d);
          cards.set(d.id, c);
        }
      }
      const current = [...el.querySelectorAll(':scope > .kpi')];
      const want = descs.map((d) => cards.get(d.id).el);
      if (current.length !== want.length || current.some((x, i) => x !== want[i])) for (const x of want) el.append(x);
      for (const c of cards.values()) c.setStale('');
    },
    error(text, staleLine) {
      if (!hasData) {
        for (const d of defs || []) cards.get(d.id)?.update(loadingDesc(d, 'Não foi possível carregar.', 'bad'));
        return;
      }
      for (const c of cards.values()) c.setStale(staleLine || '');
    },
  };
}
