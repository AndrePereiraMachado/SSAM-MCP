// Inline sparkline (DESIGN.md 6.7): point math, accessible label, and the SVG it builds (with a minimal fake DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pub } from './helpers.mjs';

const SP = await import(pub('js/sparkline.js'));

test('points spread over 72 x 16 with a 1.5 px pad; the minimum is never above zero', () => {
  const { points, flat } = SP.sparkPoints([0, 5, 10]);
  assert.equal(flat, false);
  assert.deepEqual(points, [[1.5, 14.5], [36, 8], [70.5, 1.5]]);
  const neg = SP.sparkPoints([-2, 2]);
  assert.deepEqual(neg.points, [[1.5, 14.5], [70.5, 1.5]]);
  const pos = SP.sparkPoints([4, 8]);
  assert.deepEqual(pos.points, [[1.5, 8], [70.5, 1.5]], 'scale starts at 0, so 4 of 8 sits in the middle');
});

test('flat, empty, single and gapped series', () => {
  assert.deepEqual(SP.sparkPoints([0, 0, 0]), { points: [[1.5, 8], [36, 8], [70.5, 8]], flat: true });
  assert.deepEqual(SP.sparkPoints([]), { points: [], flat: true });
  assert.deepEqual(SP.sparkPoints(null), { points: [], flat: true });
  assert.deepEqual(SP.sparkPoints([null, null]), { points: [], flat: true });
  assert.deepEqual(SP.sparkPoints([7]), { points: [[36, 1.5]], flat: false });
  assert.deepEqual(SP.sparkPoints([null, 4, null, 8]).points, [[24.5, 8], [70.5, 1.5]]);
});

test('aria-label: prefix, span, minimum, maximum and the last value', () => {
  const v = [0, 3, 37, 5, 0, 0, 8, 9, 1, 2, 0, 4, 6, 12];
  assert.equal(SP.sparkLabel('Chamadas por dia', v), 'Chamadas por dia, 14 dias: mínimo 0, máximo 37, hoje 12');
  assert.equal(SP.sparkLabel('Chamadas por dia', [5]), 'Chamadas por dia, 1 dia: mínimo 5, máximo 5, hoje 5');
  assert.equal(SP.sparkLabel('X', []), 'X: sem dados');
  assert.equal(SP.sparkLabel('CPU em %', [1.25, 2.5, null], { span: '24 h', lastLabel: 'agora', fmt: SP.fmtSparkDecimal }),
    'CPU em %, 24 h: mínimo 1,3, máximo 2,5, agora 2,5');
  assert.equal(SP.sparkLabel('Calls', [1000, 2000], { lastLabel: 'último dia' }), 'Calls, 2 dias: mínimo 1.000, máximo 2.000, último dia 2.000');
});

// ---- the SVG element, with just enough DOM
class FakeEl {
  constructor(ns, tag) {
    this.ns = ns;
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.textContent = '';
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  append(...c) {
    this.children.push(...c);
  }
}

test('sparkline() builds role=img SVG with a title, a polyline and the last-point dot', () => {
  const prev = globalThis.document;
  globalThis.document = { createElementNS: (ns, tag) => new FakeEl(ns, tag) };
  try {
    const svg = SP.sparkline([0, 5, 10], 'Chamadas por dia, 3 dias: mínimo 0, máximo 10, hoje 10');
    assert.equal(svg.tag, 'svg');
    assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
    assert.equal(svg.attrs.class, 'spark');
    assert.equal(svg.attrs.role, 'img');
    assert.equal(svg.attrs.width, '72');
    assert.equal(svg.attrs.height, '16');
    assert.equal(svg.attrs['aria-label'], 'Chamadas por dia, 3 dias: mínimo 0, máximo 10, hoje 10');
    const [title, line, dot] = svg.children;
    assert.equal(title.tag, 'title');
    assert.equal(title.textContent, svg.attrs['aria-label']);
    assert.equal(line.tag, 'polyline');
    assert.equal(line.attrs.points, '1.5,14.5 36,8 70.5,1.5');
    assert.equal(dot.tag, 'circle');
    assert.deepEqual([dot.attrs.cx, dot.attrs.cy, dot.attrs.r], ['70.5', '1.5', '1']);
    const flat = SP.sparkline([0, 0], 'zero');
    assert.equal(flat.attrs.class, 'spark flat');
    assert.equal(flat.children.length, 2, 'a flat series has no dot');
    const empty = SP.sparkline([], 'nada');
    assert.equal(empty.children.length, 1, 'only the title');
  } finally {
    globalThis.document = prev;
  }
});
