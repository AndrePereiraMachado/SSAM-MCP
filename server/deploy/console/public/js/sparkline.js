// Inline sparkline (DESIGN.md 6.7): SVG 72x16 inside a table cell (or larger in a card, SPEC painel v2 3.5), polyline stroke --spark 1.25 px, no fill,
// round joins, the last point a 2 px dot; an all-zero series is a flat --line-strong line. role="img" + aria-label.
// The point math is pure (sparkPoints, sparkLabel) and unit-tested.

import { fmtInt, fmtNumMax1 } from './format.js';

export const SPARK_W = 72;
export const SPARK_H = 16;
const PAD = 1.5;
const NS = 'http://www.w3.org/2000/svg';

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Points of a series in a w x h box. Nulls are gaps (skipped). Returns {points: [[x, y]], flat}.
 * x spreads the series over the width (index based); y maps [min(0, min), max] to [h - pad, pad].
 */
export function sparkPoints(values, w = SPARK_W, h = SPARK_H) {
  const vals = Array.isArray(values) ? values : [];
  const n = vals.length;
  const nums = vals.filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  if (!n || !nums.length) return { points: [], flat: true };
  const max = Math.max(...nums);
  const min = Math.min(0, ...nums);
  const flat = max === min;
  const step = n > 1 ? (w - 2 * PAD) / (n - 1) : 0;
  const points = [];
  vals.forEach((v, i) => {
    if (v == null || !Number.isFinite(Number(v))) return;
    const x = n > 1 ? PAD + i * step : w / 2;
    const y = flat ? h / 2 : h - PAD - ((Number(v) - min) / (max - min)) * (h - 2 * PAD);
    points.push([round2(x), round2(y)]);
  });
  return { points, flat };
}

/**
 * Accessible label: `Chamadas por dia, 14 dias: mínimo 0, máximo 37, hoje 12`.
 * opts.unit formats each number (default integer), opts.lastLabel names the last point (default `hoje`).
 */
export function sparkLabel(prefix, values, { fmt = fmtInt, lastLabel = 'hoje', span } = {}) {
  const vals = (Array.isArray(values) ? values : []).filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  if (!vals.length) return `${prefix}: sem dados`;
  const n = Array.isArray(values) ? values.length : vals.length;
  const spanTxt = span ?? `${n} ${n === 1 ? 'dia' : 'dias'}`;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const last = vals[vals.length - 1];
  return `${prefix}, ${spanTxt}: mínimo ${fmt(min)}, máximo ${fmt(max)}, ${lastLabel} ${fmt(last)}`;
}

export const fmtSparkDecimal = (v) => fmtNumMax1(v);

/**
 * SVG element of a sparkline. Defaults: the 72 x 16 table cell (polyline --spark, 1 px end dot). opts {w, h, area}: a card
 * sparkline (SPEC painel v2 3.5) with the series-1 line, a 12 % area wash under it (no gaps) and a 3 px end dot.
 */
export function sparkline(values, label, { w = SPARK_W, h = SPARK_H, area = false } = {}) {
  const { points, flat } = sparkPoints(values, w, h);
  const svg = document.createElementNS(NS, 'svg');
  const cls = ['spark', area && 'lg', flat && 'flat'].filter(Boolean).join(' ');
  svg.setAttribute('class', cls);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('focusable', 'false');
  const title = document.createElementNS(NS, 'title');
  title.textContent = label;
  svg.append(title);
  if (points.length) {
    const pts = points.length === 1 ? [[PAD, points[0][1]], [w - PAD, points[0][1]]] : points;
    const n = Array.isArray(values) ? values.length : 0;
    if (area && pts.length > 1 && points.length === n) {
      const a = document.createElementNS(NS, 'path');
      a.setAttribute('class', 'sp-area');
      a.setAttribute('d', `M${pts.map((p) => p.join(' ')).join('L')}L${pts[pts.length - 1][0]} ${h}L${pts[0][0]} ${h}Z`);
      svg.append(a);
    }
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
    svg.append(line);
    if (!flat) {
      const [x, y] = points[points.length - 1];
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', String(x));
      c.setAttribute('cy', String(y));
      c.setAttribute('r', area ? '3' : '1');
      svg.append(c);
    }
  }
  return svg;
}
