// Meters and charts of the owner console (SPEC painel v2, sections 3.2-3.6 and 5). SVG and plain elements only; every
// value reaches the page through textContent, SVG geometry attributes or CSSOM sizes (no style attribute, no HTML
// parsing). The rules (meter thresholds, gauge geometry, ticks, bar and line geometry) are pure and unit-tested.

import { h, clear } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';

// The only SVG attributes the charts write (geometry, class and accessibility). svgEl refuses anything else.
const SVG_ATTRS = new Set(['d', 'cx', 'cy', 'r', 'x', 'y', 'width', 'height', 'rx', 'viewBox', 'transform', 'stroke-dasharray',
  'class', 'role', 'aria-label', 'aria-hidden', 'points']);

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (!SVG_ATTRS.has(k)) throw new Error(`atributo SVG fora da lista: ${k}`);
    if (v != null) el.setAttribute(k, String(v));
  }
  return el;
}

const round2 = (n) => Math.round(n * 100) / 100;
export const clamp01 = (x) => (Number.isFinite(Number(x)) ? Math.min(1, Math.max(0, Number(x))) : 0);
const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));

// ---------------------------------------------------------------- rules (5.1)

/**
 * Thresholds of every meter. `warn` / `bad`: [operator, value] on the meter's value; `max` is the top of its range.
 * `accent` meters have no threshold (neutral fill). `validity` is special (days left; expired is atenção).
 */
export const METER_RULES = {
  cpu: { max: 100, warn: ['>=', 80], bad: ['>=', 95] },
  mem: { max: 100, warn: ['>=', 85], bad: ['>=', 93] },
  disk: { max: 100, warn: ['>=', 80], bad: ['>=', 90] },
  load: { max: 3, warn: ['>=', 2] },
  tls: { max: 90, warn: ['<', 21], bad: ['<', 7], inverted: true },
  backup: { max: 48, bad: ['>', 26] },
  collector: { max: 300, warn: ['>', 120] },
  workspace: { max: 100, warn: ['>=', 80], bad: ['>=', 95] },
  validity: { max: 1, inverted: true },
  seats: { max: 1, warn: ['>=', 1] },
  agents: { max: 1, accent: true },
  success: { max: 100, warn: ['<', 75], bad: ['<', 50], inverted: true },
  refusal: { max: 100, warn: ['>=', 15], bad: ['>=', 30] },
  share: { max: 1, accent: true },
  containerMem: { max: 100, warn: ['>=', 85], bad: ['>=', 95] },
};

function hit(rule, v) {
  if (!rule) return false;
  const [op, n] = rule;
  if (op === '>=') return v >= n;
  if (op === '>') return v > n;
  if (op === '<') return v < n;
  return v <= n;
}

/** Level of a meter value: 'ok' | 'warn' | 'bad' | 'accent', or null when the value is missing. */
export function meterLevel(id, value) {
  const rule = METER_RULES[id];
  if (!rule) throw new Error(`medidor desconhecido: ${id}`);
  if (!isNum(value)) return null;
  const v = Number(value);
  if (rule.accent) return 'accent';
  if (id === 'validity') {
    if (v <= 0) return 'warn';
    if (v <= 2) return 'bad';
    return v <= 7 ? 'warn' : 'ok';
  }
  if (hit(rule.bad, v)) return 'bad';
  if (hit(rule.warn, v)) return 'warn';
  return 'ok';
}

/** Threshold ticks of a meter as fractions of its range: [{at, level}]. */
export function meterTicks(id) {
  const rule = METER_RULES[id];
  if (!rule || rule.accent || id === 'validity') return [];
  const out = [];
  for (const level of ['warn', 'bad']) {
    if (rule[level]) out.push({ at: clamp01(rule[level][1] / rule.max), level });
  }
  return out;
}

/** The status word read after a meter value (`95%, crítico`). */
export function levelWord(level) {
  return { ok: 'ok', warn: 'atenção', bad: 'crítico' }[level] || '';
}

/** 3 to 5 round ticks from 0 that reach `max` (1, 2, 2,5 or 5 times a power of ten); integer steps when asked. */
export function niceTicks(max, { integer = false } = {}) {
  const m = Number(max);
  if (!Number.isFinite(m) || m <= 0) return [0, 1];
  const rough = m / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  if (integer) step = Math.max(1, Math.round(step));
  const n = Math.max(1, Math.ceil(m / step - 1e-9));
  return Array.from({ length: n + 1 }, (_, i) => round2(i * step));
}

// ---------------------------------------------------------------- radial gauge (3.2)

export const GAUGE = { r: 48, arc: 226.19, circ: 301.59 };

/** stroke-dasharray of the gauge fill for a fraction of its 270 degree sweep. */
export function gaugeDash(fraction) {
  return `${round2(clamp01(fraction) * GAUGE.arc)} ${GAUGE.circ}`;
}

/** A threshold tick just outside the arc (radius 54 to 60) at its angle. */
export function tickAngle(fraction) {
  const a = ((135 + 270 * clamp01(fraction)) * Math.PI) / 180;
  return {
    x1: round2(60 + 54 * Math.cos(a)), y1: round2(60 + 54 * Math.sin(a)),
    x2: round2(60 + 60 * Math.cos(a)), y2: round2(60 + 60 * Math.sin(a)),
  };
}

function setMeterAria(el, { label, value, max, valueText }) {
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', String(max));
  if (isNum(value)) el.setAttribute('aria-valuenow', String(round2(Number(value))));
  else el.removeAttribute('aria-valuenow');
  el.setAttribute('aria-valuetext', valueText);
}

/**
 * Radial gauge: {label, value (null = sem coleta), max = 100, level, display ('95%'), unit (under the value),
 * caption (one line under the label), ticks [{at, level}], missingText}. Returns {el, update(next)}.
 */
export function gauge(opts) {
  const wrap = h('div', { class: 'gauge', role: 'meter' });
  const svg = svgEl('svg', { viewBox: '0 0 120 120', class: 'g-svg', 'aria-hidden': 'true' });
  const track = svgEl('circle', { class: 'g-track', cx: 60, cy: 60, r: GAUGE.r, 'stroke-dasharray': gaugeDash(1), transform: 'rotate(135 60 60)' });
  const ticks = svgEl('g', { class: 'g-ticks' });
  const fill = svgEl('circle', { class: 'g-fill', cx: 60, cy: 60, r: GAUGE.r, 'stroke-dasharray': gaugeDash(0), transform: 'rotate(135 60 60)' });
  const val = svgEl('text', { class: 'g-val', x: 60, y: 64 });
  const unit = svgEl('text', { class: 'g-unit', x: 60, y: 82 });
  svg.append(track, ticks, fill, val, unit);
  const label = h('p', { class: 'g-label' });
  const cap = h('p', { class: 'g-cap' });
  wrap.append(svg, label, cap);

  function update(o) {
    const max = o.max ?? 100;
    const has = isNum(o.value);
    const f = has ? Number(o.value) / max : 0;
    const level = has ? (o.level || 'accent') : 'none';
    wrap.className = `gauge lv-${level}`;
    fill.setAttribute('stroke-dasharray', gaugeDash(f));
    fill.setAttribute('class', `g-fill c-${level}${has && f > 0 ? '' : ' is-zero'}`);
    clear(ticks);
    for (const t of o.ticks || []) {
      const p = tickAngle(t.at);
      ticks.append(svgEl('path', { class: `g-tick c-${has ? t.level : 'none'}`, d: `M${p.x1} ${p.y1}L${p.x2} ${p.y2}` }));
    }
    val.textContent = has ? o.display : (o.missingText || 'sem coleta');
    val.setAttribute('class', has ? 'g-val' : 'g-val g-none');
    unit.textContent = has ? (o.unit || '') : '';
    label.textContent = o.label;
    cap.textContent = o.caption || '';
    cap.hidden = !o.caption;
    if (o.capTitle) cap.title = o.capTitle;
    else cap.removeAttribute('title');
    const word = levelWord(level);
    setMeterAria(wrap, {
      label: o.label, value: has ? o.value : null, max,
      valueText: has ? `${o.display}${word ? `, ${word}` : ''}` : (o.missingText || 'sem coleta'),
    });
  }
  update(opts);
  return { el: wrap, update };
}

// ---------------------------------------------------------------- linear meter (3.3)

/**
 * Linear meter: {label, caption (left, defaults to label), valueText (right), fraction 0..1 (null = none), level, ticks,
 * mini, ariaText}. Returns {el, update(next)}.
 */
export function meter(opts) {
  const el = h('div', { class: 'meter', role: 'meter' });
  const capEl = h('span', { class: 'm-cap' });
  const valEl = h('span', { class: 'm-val' });
  const row = h('div', { class: 'm-row' }, capEl, valEl);
  const fill = h('span', { class: 'm-fill' });
  const tickBox = h('span', { class: 'm-ticks' });
  const track = h('span', { class: 'm-track' }, fill, tickBox);
  el.append(row, track);

  function update(o) {
    const has = isNum(o.fraction);
    const f = has ? clamp01(o.fraction) : 0;
    const level = has ? (o.level || 'accent') : 'none';
    el.className = ['meter', `lv-${level}`, o.mini && 'mini', o.cls].filter(Boolean).join(' ');
    row.hidden = !!o.mini;
    capEl.textContent = o.caption ?? o.label;
    valEl.textContent = o.valueText ?? '';
    fill.className = `m-fill c-${level}${f > 0 ? '' : ' is-zero'}`;
    fill.style.inlineSize = `${round2(f * 100)}%`;
    clear(tickBox);
    for (const t of o.ticks || []) {
      const tk = h('span', { class: `m-tick c-${t.level}` });
      tk.style.insetInlineStart = `${round2(clamp01(t.at) * 100)}%`;
      tickBox.append(tk);
    }
    const word = levelWord(level);
    setMeterAria(el, {
      label: o.label, value: has ? round2(f * 100) : null, max: 100,
      valueText: o.ariaText || (has ? `${o.valueText ?? `${round2(f * 100)}%`}${word ? `, ${word}` : ''}` : (o.missingText || 'sem coleta')),
    });
    if (o.title) el.title = o.title;
  }
  update(opts);
  return { el, update };
}

// ---------------------------------------------------------------- segmented bar (3.4)

/**
 * Part-to-whole bar: parts [{count, c ('ok'|'warn'|'bad'|'muted'|'info'|'s1'..'s7'|'other'), word}], label (accessible
 * prefix), legend (bool). A zero part takes no segment. Returns the element.
 */
export function segbar(parts, { label = '', legend = false } = {}) {
  const list = (parts || []).filter((p) => isNum(p.count) && Number(p.count) > 0);
  const bar = h('div', { class: 'segbar', role: 'img' });
  bar.setAttribute('aria-label', `${label ? `${label}: ` : ''}${(parts || []).map((p) => p.word).join(', ')}`);
  for (const p of list) {
    const s = h('span', { class: `sb-part c-${p.c}` });
    s.style.flexGrow = String(Number(p.count));
    bar.append(s);
  }
  if (!legend) return bar;
  const lg = h('p', { class: 'sb-legend', 'aria-hidden': 'true' });
  for (const p of parts || []) lg.append(h('span', { class: 'lg' }, h('span', { class: `sw c-${p.c}` }), p.word));
  return h('div', { class: 'segbar-wrap' }, bar, lg);
}

// ---------------------------------------------------------------- tooltip (3.6)

function tipEl() {
  return document.getElementById('tip');
}

/** Fills the shared tooltip: heading, then rows [{c, value, label}]. */
export function showTip({ heading, rows }, x, y) {
  const t = tipEl();
  if (!t) return;
  clear(t);
  t.append(h('p', { class: 'tip-h' }, heading));
  for (const r of rows || []) {
    t.append(h('p', { class: 'tip-row' }, h('span', { class: r.c ? `tip-key c-${r.c}` : 'tip-key none' }), h('span', { class: 'tip-v' }, r.value),
      r.label ? h('span', { class: 'tip-l' }, r.label) : null));
  }
  t.hidden = false;
  const w = t.offsetWidth;
  const ht = t.offsetHeight;
  let left = x + 14;
  let top = y + 14;
  if (left + w > window.innerWidth - 8) left = x - w - 14;
  if (top + ht > window.innerHeight - 8) top = y - ht - 14;
  t.style.left = `${Math.max(8, Math.round(left))}px`;
  t.style.top = `${Math.max(8, Math.round(top))}px`;
}

export function hideTip() {
  const t = tipEl();
  if (t) t.hidden = true;
}

// ---------------------------------------------------------------- shared figure (3.6)

let figSeq = 0;

/** <figure class="chart"> with its caption (title, subtitle, legend, Ver tabela) and a plot box. */
function figure({ title, subtitle, legend, twin, cls }) {
  const id = `fig-${++figSeq}`;
  const fig = h('figure', { class: ['chart', cls], tabindex: '0', 'aria-labelledby': id });
  const titleEl = h('span', { class: 'ch-title', id }, title);
  const subEl = h('span', { class: 'ch-sub' }, subtitle || '');
  subEl.hidden = !subtitle;
  const lg = h('span', { class: 'ch-legend', 'aria-hidden': 'true' });
  for (const s of legend || []) lg.append(h('span', { class: 'lg' }, h('span', { class: `sw c-${s.c}` }), s.label));
  lg.hidden = !(legend && legend.length);
  const twinBtn = twin ? h('button', { type: 'button', class: 'tbtn ch-twin' }, 'Ver tabela') : null;
  if (twinBtn) {
    twinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = twin();
      if (!t) return;
      t.tabIndex = -1;
      t.scrollIntoView({ block: 'start' });
      t.focus({ preventScroll: true });
    });
  }
  const cap = h('figcaption', { class: 'ch-cap' }, h('span', { class: 'ch-titles' }, titleEl, subEl), lg, twinBtn);
  const plot = h('div', { class: 'ch-plot' });
  fig.append(cap, plot);
  return {
    fig, plot, titleEl, subEl,
    setTitle(t) { titleEl.textContent = t; },
    setSub(t) { subEl.textContent = t || ''; subEl.hidden = !t; },
  };
}

/** Re-renders `draw()` whenever the plot changes width (and once it becomes visible). */
function onWidth(plot, draw) {
  let last = -1;
  const run = () => {
    const w = plot.clientWidth;
    if (w && w !== last) {
      last = w;
      draw(w);
    }
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(run).observe(plot);
  return {
    now() {
      last = -1;
      run();
    },
  };
}

function pathRoundTop(x, y, w, hgt, r) {
  const rr = Math.max(0, Math.min(r, w / 2, hgt));
  if (rr <= 0) return `M${x} ${y + hgt}V${y}H${x + w}V${y + hgt}Z`;
  return `M${x} ${y + hgt}V${y + rr}A${rr} ${rr} 0 0 1 ${x + rr} ${y}H${x + w - rr}A${rr} ${rr} 0 0 1 ${x + w} ${y + rr}V${y + hgt}Z`;
}

/**
 * Geometry of stacked columns (pure): stacks [[v1, v2, ...] per band], plot box {left, top, width, height}, the top of the
 * scale. Bars at most 24 px wide (60 % of the band), segments separated by a 2 px gap, the top segment rounded (4 px).
 * Returns [{x, w, band, segs: [{i, y, h, d}]}].
 */
export function columnGeometry(stacks, { left, top, width, height }, scaleTop) {
  const n = stacks.length;
  const band = n ? width / n : 0;
  const w = round2(Math.min(24, band * 0.6));
  return stacks.map((vals, k) => {
    const x = round2(left + k * band + (band - w) / 2);
    const segs = [];
    let base = top + height;
    const nonzero = vals.map((v, i) => ({ v: Number(v) || 0, i })).filter((s) => s.v > 0);
    nonzero.forEach((s, j) => {
      let hh = (s.v / scaleTop) * height;
      let y = base - hh;
      if (j > 0) hh -= 2;
      hh = Math.max(0, hh);
      const isTop = j === nonzero.length - 1;
      y = round2(y);
      hh = round2(hh);
      segs.push({ i: s.i, y, h: hh, d: isTop ? pathRoundTop(x, y, w, hh, 4) : `M${x} ${round2(y + hh)}V${y}H${round2(x + w)}V${round2(y + hh)}Z` });
      base = y;
    });
    return { x, w, band: round2(band), segs };
  });
}

/** SVG path of a line through points [[x, y] | null]; a null breaks the line. */
export function linePath(points) {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${round2(p[0])} ${round2(p[1])}`;
    pen = true;
  }
  return d;
}

function axisY(svg, ticks, { left, top, width, height }, scaleTop, fmt) {
  const g = svgEl('g', { class: 'ax' });
  for (const t of ticks) {
    const y = round2(top + height - (t / scaleTop) * height);
    g.append(svgEl('path', { class: t === 0 ? 'ax-base' : 'ax-grid', d: `M${left} ${y}H${round2(left + width)}` }));
    const tx = svgEl('text', { class: 'ax-y', x: left - 8, y: y + 4 });
    tx.textContent = fmt(t);
    g.append(tx);
  }
  svg.append(g);
}

/**
 * Keyboard and pointer crosshair shared by columns and lines: created once per figure; attach() binds it to each new
 * frame (svg) with that frame's geometry {count, xAt, bandAt, tipAt, front}.
 */
function crosshair(fig) {
  let idx = null;
  let cur = null;
  function paint(i, clientX, clientY) {
    idx = i;
    if (!cur) return;
    clear(cur.mark);
    if (i == null) {
      hideTip();
      return;
    }
    cur.mark.append(cur.bandAt(i));
    let x = clientX;
    let y = clientY;
    if (x == null) {
      const r = cur.svg.getBoundingClientRect();
      x = r.left + cur.xAt(i);
      y = r.top + 24;
    }
    showTip(cur.tipAt(i), x, y);
  }
  function nearest(px) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < cur.count(); i += 1) {
      const d = Math.abs(cur.xAt(i) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
  fig.addEventListener('keydown', (e) => {
    const n = cur ? cur.count() : 0;
    if (!n) return;
    let j = null;
    if (e.key === 'ArrowRight') j = idx == null ? 0 : Math.min(n - 1, idx + 1);
    else if (e.key === 'ArrowLeft') j = idx == null ? n - 1 : Math.max(0, idx - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    else if (e.key === 'Escape') {
      if (idx != null) {
        e.preventDefault();
        e.stopPropagation();
        paint(null);
      }
      return;
    }
    if (j != null) {
      e.preventDefault();
      paint(j);
    }
  });
  fig.addEventListener('blur', () => paint(null));
  return {
    attach(svg, geo) {
      const mark = svgEl('g', { class: 'ch-mark' });
      if (geo.front) svg.append(mark);
      else svg.prepend(mark);
      cur = { svg, mark, ...geo };
      idx = null;
      hideTipIfOwned();
      svg.addEventListener('pointermove', (e) => {
        if (!cur || cur.svg !== svg || !cur.count()) return;
        const r = svg.getBoundingClientRect();
        paint(nearest(e.clientX - r.left), e.clientX, e.clientY);
      });
      svg.addEventListener('pointerleave', () => paint(null));
    },
  };
  function hideTipIfOwned() {
    if (fig.contains(document.activeElement) || fig.matches(':hover')) hideTip();
  }
}

// ---------------------------------------------------------------- columns (3.6.1)

/**
 * Stacked columns per day. opts: {title, subtitle, series: [{key, label, c}], twin, fmt (axis numbers), aria(rows) -> string}.
 * update(rows: [{x (axis label), heading (tooltip), values: {key: n}, tip: [{c, value, label}]}]).
 */
export function columns(opts) {
  const f = figure({ title: opts.title, subtitle: opts.subtitle, legend: opts.series.length > 1 ? opts.series : null, twin: opts.twin, cls: opts.cls });
  let rows = [];
  const H = 180;
  const XB = 24;
  const PAD = 8;
  const GUT = 48;
  let svg = null;
  const fmt = opts.fmt || ((v) => String(v));
  const ch = crosshair(f.fig);

  function draw(width) {
    if (svg) svg.remove();
    svg = svgEl('svg', { class: 'ch-svg', width, height: PAD + H + XB, viewBox: `0 0 ${width} ${PAD + H + XB}`, role: 'img' });
    svg.setAttribute('aria-label', opts.aria ? opts.aria(rows) : opts.title);
    const box = { left: GUT, top: PAD, width: Math.max(10, width - GUT - 4), height: H };
    const totals = rows.map((r) => opts.series.reduce((s, x) => s + (Number(r.values[x.key]) || 0), 0));
    const ticks = niceTicks(Math.max(0, ...totals), { integer: true });
    const scaleTop = ticks[ticks.length - 1] || 1;
    axisY(svg, ticks, box, scaleTop, fmt);
    const geo = columnGeometry(rows.map((r) => opts.series.map((s) => r.values[s.key])), box, scaleTop);
    const bars = svgEl('g', { class: 'bars' });
    geo.forEach((g) => {
      for (const s of g.segs) bars.append(svgEl('path', { class: `bar c-${opts.series[s.i].c}`, d: s.d }));
    });
    svg.append(bars);
    const xl = svgEl('g', { class: 'ax' });
    const n = rows.length;
    rows.forEach((r, i) => {
      if (n > 10 && i % 5 !== 0 && i !== n - 1) return;
      const t = svgEl('text', { class: 'ax-x', x: round2(geo[i].x + geo[i].w / 2), y: PAD + H + 17 });
      t.textContent = r.x;
      xl.append(t);
    });
    svg.append(xl);
    ch.attach(svg, {
      count: () => rows.length,
      xAt: (i) => geo[i].x + geo[i].w / 2,
      bandAt: (i) => svgEl('rect', { class: 'ch-band', x: round2(box.left + i * geo[i].band), y: PAD, width: geo[i].band, height: H }),
      tipAt: (i) => ({ heading: rows[i].heading, rows: rows[i].tip }),
    });
    f.plot.append(svg);
  }
  const w = onWidth(f.plot, draw);
  return {
    el: f.fig,
    figure: f,
    update(next) {
      rows = Array.isArray(next) ? next : [];
      w.now();
    },
  };
}

// ---------------------------------------------------------------- lines (3.6.2)

/**
 * Lines over time. opts: {title, subtitle, series: [{key, label, c}], max (fixed top, e.g. 100), fmt (axis and tooltip),
 * aria(points) -> string, twin, cls}. update(points: [{t (ms), values: {key: n|null}}]).
 */
export function lines(opts) {
  const f = figure({ title: opts.title, subtitle: opts.subtitle, legend: opts.series.length > 1 ? opts.series : null, twin: opts.twin, cls: opts.cls });
  let pts = [];
  const H = opts.height || 120;
  const XB = 20;
  const PAD = 8;
  const GUT = 48;
  let svg = null;
  const fmt = opts.fmt || ((v) => String(v));
  const ch = crosshair(f.fig);

  function draw(width) {
    if (svg) svg.remove();
    svg = svgEl('svg', { class: 'ch-svg', width, height: PAD + H + XB, viewBox: `0 0 ${width} ${PAD + H + XB}`, role: 'img' });
    svg.setAttribute('aria-label', opts.aria ? opts.aria(pts) : opts.title);
    const box = { left: GUT, top: PAD, width: Math.max(10, width - GUT - 8), height: H };
    const all = [];
    for (const p of pts) for (const s of opts.series) if (isNum(p.values[s.key])) all.push(Number(p.values[s.key]));
    const top = Math.max(0, ...all);
    // byte series get round binary steps (95 MiB steps read badly): the ticks of max / 1024^k, times 1024^k
    const unit = opts.bytes && top > 0 ? 1024 ** Math.max(0, Math.floor(Math.log(top) / Math.log(1024))) : 1;
    const ticks = opts.max ? niceTicks(opts.max) : niceTicks(top / unit).map((t) => t * unit);
    const scaleTop = ticks[ticks.length - 1] || 1;
    axisY(svg, ticks, box, scaleTop, fmt);
    const n = pts.length;
    const t0 = n ? pts[0].t : 0;
    const t1 = n ? pts[n - 1].t : 1;
    const span = Math.max(1, t1 - t0);
    const xOf = (i) => box.left + ((pts[i].t - t0) / span) * box.width;
    const yOf = (v) => box.top + box.height - (Math.min(Number(v), scaleTop) / scaleTop) * box.height;
    for (const s of opts.series) {
      const line = pts.map((p, i) => (isNum(p.values[s.key]) ? [xOf(i), yOf(p.values[s.key])] : null));
      if (opts.series.length === 1 && line.every(Boolean) && line.length > 1) {
        const d = `${linePath(line)}L${round2(line[line.length - 1][0])} ${box.top + box.height}L${round2(line[0][0])} ${box.top + box.height}Z`;
        svg.append(svgEl('path', { class: `ln-area c-${s.c}`, d }));
      }
      svg.append(svgEl('path', { class: `ln c-${s.c}`, d: linePath(line) }));
    }
    // x ticks every 6 h of local time
    const xl = svgEl('g', { class: 'ax' });
    if (opts.xTicks) {
      for (const tk of opts.xTicks(t0, t1)) {
        const x = round2(box.left + ((tk.t - t0) / span) * box.width);
        const t = svgEl('text', { class: 'ax-x', x, y: PAD + H + 15 });
        t.textContent = tk.label;
        xl.append(t);
      }
    }
    svg.append(xl);
    ch.attach(svg, {
      front: true,
      count: () => pts.length,
      xAt: (i) => xOf(i),
      bandAt: (i) => {
        const g = svgEl('g');
        const x = round2(xOf(i));
        g.append(svgEl('path', { class: 'ch-cross', d: `M${x} ${PAD}V${PAD + H}` }));
        for (const s of opts.series) {
          const v = pts[i].values[s.key];
          if (isNum(v)) g.append(svgEl('circle', { class: `ch-dot c-${s.c}`, cx: x, cy: round2(yOf(v)), r: 4 }));
        }
        return g;
      },
      tipAt: (i) => ({
        heading: opts.heading ? opts.heading(pts[i]) : '',
        rows: opts.series.map((s) => ({ c: s.c, value: isNum(pts[i].values[s.key]) ? fmt(pts[i].values[s.key]) : '—', label: opts.series.length > 1 ? s.label : (opts.unitLabel || '') })),
      }),
    });
    f.plot.append(svg);
  }
  const w = onWidth(f.plot, draw);
  return {
    el: f.fig,
    figure: f,
    update(next) {
      pts = Array.isArray(next) ? next : [];
      w.now();
    },
  };
}

// ---------------------------------------------------------------- bar list (3.6.3)

/**
 * Top N labelled bars. opts: {title, subtitle, twin, mono (labels are codes), n, fmt, cls}.
 * update(items: [{label, value, title}]) sorted here by value desc; scale = the largest.
 */
export function barlist(opts) {
  const f = figure({ title: opts.title, subtitle: opts.subtitle, twin: opts.twin, cls: opts.cls });
  const list = h('ol', { class: ['barlist', opts.mono && 'mono-labels'] });
  f.plot.append(list);
  const fmt = opts.fmt || ((v) => String(v));
  return {
    el: f.fig,
    figure: f,
    update(items) {
      clear(list);
      const top = (items || []).filter((x) => isNum(x.value) && Number(x.value) > 0)
        .sort((a, b) => Number(b.value) - Number(a.value)).slice(0, opts.n || 6);
      const max = top.length ? Number(top[0].value) : 1;
      for (const it of top) {
        const bar = h('span', { class: 'bl-bar c-s1' });
        bar.style.inlineSize = `${round2((Number(it.value) / max) * 100)}%`;
        list.append(h('li', { class: 'bl-row' },
          h('span', { class: 'bl-label', title: it.title || it.label }, it.label),
          h('span', { class: 'bl-track' }, bar),
          h('span', { class: 'bl-val' }, fmt(it.value))));
      }
      list.setAttribute('aria-label', `${opts.title}: ${top.map((x) => `${x.label} ${fmt(x.value)}`).join(', ') || 'nada'}`);
      if (!top.length) list.append(h('li', { class: 'bl-empty' }, opts.empty || 'Nada neste período.'));
    },
  };
}

// ---------------------------------------------------------------- 100 % stacks (3.6.4)

/**
 * One 100 % bar per item. opts: {title, subtitle, twin, segments: [{key, label, c}], fmtPct}.
 * update(rows: [{label, parts: {key: pct}}]).
 */
export function stack100(opts) {
  const f = figure({ title: opts.title, subtitle: opts.subtitle, legend: opts.segments, twin: opts.twin, cls: opts.cls });
  const list = h('ol', { class: 'stack100' });
  f.plot.append(list);
  const segEls = [];
  let idx = null;
  const fmtPct = opts.fmtPct || ((v) => `${v}%`);
  function tipFor(s) {
    return { heading: s.row.label, rows: [{ c: s.seg.c, value: fmtPct(s.pct), label: s.seg.label }] };
  }
  function mark(i, x, y) {
    for (const s of segEls) s.el.classList.remove('on');
    idx = i;
    if (i == null) {
      hideTip();
      return;
    }
    const s = segEls[i];
    s.el.classList.add('on');
    let cx = x;
    let cy = y;
    if (cx == null) {
      const r = s.el.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top;
    }
    showTip(tipFor(s), cx, cy);
  }
  f.fig.addEventListener('keydown', (e) => {
    const n = segEls.length;
    if (!n) return;
    let j = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = idx == null ? 0 : Math.min(n - 1, idx + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = idx == null ? n - 1 : Math.max(0, idx - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    else if (e.key === 'Escape' && idx != null) {
      e.preventDefault();
      e.stopPropagation();
      mark(null);
      return;
    }
    if (j != null) {
      e.preventDefault();
      mark(j);
    }
  });
  f.fig.addEventListener('blur', () => mark(null));

  function fitLabels() {
    for (const s of segEls) {
      if (!s.lab) continue;
      s.lab.hidden = false;
      s.lab.hidden = s.el.clientWidth < s.lab.scrollWidth + 12;
    }
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(fitLabels).observe(list);

  return {
    el: f.fig,
    figure: f,
    update(rows) {
      clear(list);
      segEls.length = 0;
      idx = null;
      for (const r of rows || []) {
        const bar = h('span', { class: 'sk-bar' });
        const parts = [];
        for (const seg of opts.segments) {
          const pct = Number(r.parts[seg.key]) || 0;
          if (pct <= 0) continue;
          const lab = h('span', { class: 'sk-lab' }, fmtPct(pct));
          const el = h('span', { class: `sk-seg c-${seg.c}` }, lab);
          el.style.flexGrow = String(pct);
          const entry = { el, lab, seg, pct, row: r };
          const i = segEls.length;
          el.addEventListener('pointerenter', (e) => mark(i, e.clientX, e.clientY));
          el.addEventListener('pointermove', (e) => showTip(tipFor(entry), e.clientX, e.clientY));
          el.addEventListener('pointerleave', () => mark(null));
          segEls.push(entry);
          bar.append(el);
          parts.push(`${seg.label} ${fmtPct(pct)}`);
        }
        bar.setAttribute('role', 'img');
        bar.setAttribute('aria-label', `${r.label}: ${parts.join(', ') || 'sem tempo'}`);
        list.append(h('li', { class: 'sk-row' }, h('span', { class: 'sk-label', title: r.label }, r.label), bar));
      }
      if (!(rows || []).length) list.append(h('li', { class: 'bl-empty' }, opts.empty || 'Nada neste período.'));
      requestAnimationFrame(fitLabels);
    },
  };
}
