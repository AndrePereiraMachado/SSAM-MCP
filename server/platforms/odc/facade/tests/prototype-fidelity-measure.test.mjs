// Fidelity measure (docs/PROTOTIPO-NATIVO.md 4.4 step 3, 7.1 test 13): structural diff and selector match sets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureFidelity, splitSelectors } from '../prototype/fidelity.mjs';

const css = '.field>span{color:red}.field input{border:1px solid}.card .title{font-weight:700}dialog[open]{display:block}a:hover{color:blue}';

function prototypeTree() {
  return {
    k: 'b', t: 'body', c: [
      { k: 's:app', t: 'div', a: [['id', 'app']], c: [
        { k: 'v:home', t: 'main', a: [['class', 'page']], c: [
          { k: 'v:home/0', t: 'div', a: [['class', 'card'], ['data-id', '1']], c: [
            { k: 'v:home/0/0', t: 'h2', a: [['class', 'title']], c: [{ k: 'v:home/0/0/0', x: 'Hello' }] },
            { k: 'v:home/0/1', t: 'label', a: [['class', 'field']], c: [
              { k: 'v:home/0/1/0', t: 'span', c: [{ k: 'v:home/0/1/0/0', x: 'Name' }] },
              { k: 'v:home/0/1/1', t: 'input', a: [['name', 'nome'], ['maxlength', '20']] }
            ] },
            { k: 'v:home/0/2', t: 'a', a: [['href', '#detail/1'], ['class', 'link']], c: [{ k: 'v:home/0/2/0', x: 'Open' }] }
          ] }
        ] }
      ] }
    ]
  };
}

const capture = tree => ({ explored: [{ id: 'v:home@canonical', view: 'home', assign: {}, tree: 'h1' }], trees: { h1: tree }, css: { sheets: [] } });
const clone = value => JSON.parse(JSON.stringify(value));

test('13a. an identical native tree scores 1.0 with no selector difference', () => {
  const report = measureFidelity({ capture: capture(prototypeTree()), nativeDom: { states: [{ id: 'v:home@canonical', tree: prototypeTree() }] }, sheets: [css] });
  assert.equal(report.score, 1);
  assert.equal(report.mismatchCount, 0);
  assert.deepEqual([report.selectors.gained, report.selectors.lost], [0, 0]);
  assert.ok(report.selectors.selectors >= 4);
  assert.ok(report.selectors.skipped >= 1, ':hover is a dynamic pseudo-class and stays out');
  assert.deepEqual(report.perState, [{ state: 'v:home@canonical', score: 1, selectorsDiff: 0 }]);
});

test('13b. one attribute, one class and one text changed give exactly 3 mismatches with their k', () => {
  const native = clone(prototypeTree());
  const card = native.c[0].c[0].c[0];
  card.c[1].c[1].a = [['name', 'nome'], ['maxlength', '30']];
  card.c[0].a = [['class', 'heading']];
  card.c[2].c[0].x = 'Abrir';
  const report = measureFidelity({ capture: capture(prototypeTree()), nativeDom: { states: [{ id: 'v:home@canonical', tree: native }] }, sheets: [css] });
  assert.equal(report.mismatchCount, 3, JSON.stringify(report.mismatches));
  assert.deepEqual(report.mismatches.map(item => [item.kind, item.k]).sort(), [['attribute', 'v:home/0/1/1'], ['class', 'v:home/0/0'], ['text', 'v:home/0/2/0']].sort());
  assert.ok(report.score < 1);
  assert.equal(report.mismatches.find(item => item.kind === 'attribute').expected, '20');
});

test('13c. a runtime span (no k) under .field without the wrapper rewrite is one gained selector', () => {
  const native = clone(prototypeTree());
  const field = native.c[0].c[0].c[0].c[1];
  field.c[1] = { t: 'span', c: [field.c[1]] };
  const report = measureFidelity({ capture: capture(prototypeTree()), nativeDom: { states: [{ id: 'v:home@canonical', tree: native }] }, sheets: [css] });
  assert.equal(report.score, 1, 'the wrapper is transparent for the structural diff');
  assert.equal(report.selectors.gained, 1, JSON.stringify(report.selectors.diffs));
  assert.equal(report.selectors.lost, 0);
  assert.deepEqual(report.selectors.diffs[0].gained, ['(runtime)']);
  assert.equal(report.selectors.diffs[0].selector, '.field>span');
});

test('13d. documented equivalences: substituted tag, navigation href, runtime id and ssam-* classes', () => {
  const proto = { k: 'b', t: 'body', c: [{ k: 'm:x', t: 'dialog', a: [['id', 'modal'], ['open', '']], c: [{ k: 'm:x/0', t: 'a', a: [['href', '#detail/1']], c: [{ k: 'm:x/0/0', x: 'Go' }] }] }] };
  const native = { k: 'b', t: 'body', c: [{ k: 'm:x', t: 'div', a: [['class', 'ssam-tag-dialog ssam-id-modal'], ['id', 'Popup1'], ['open', '']], c: [{ k: 'm:x/0', t: 'a', a: [['href', '/Module/Detail?Id=1'], ['data-link', '']], c: [{ k: 'm:x/0/0', x: 'Go' }] }] }] };
  const report = measureFidelity({ capture: { explored: [{ id: 's', tree: 'h' }], trees: { h: proto }, css: { sheets: [] } }, nativeDom: { s: native }, sheets: [] });
  assert.equal(report.score, 1, JSON.stringify(report.mismatches));
});

test('13e. HTML equivalences of options: no value attribute is its text; the selection of an unmarked select is state', () => {
  const select = (options, extra = []) => ({ k: 'v:s', t: 'select', a: [['name', 'tipo'], ...extra], c: options });
  const option = (i, text, a = []) => ({ k: 'v:s/' + i, t: 'option', ...(a.length ? { a } : {}), c: [{ k: 'v:s/' + i + '/0', x: text }] });
  const body = node => ({ k: 'b', t: 'body', c: [node] });
  const proto = body(select([option(0, 'Casa'), option(1, 'Studio')]));
  const native = body(select([option(0, 'Casa', [['value', 'Casa'], ['selected', '']]), option(1, 'Studio', [['value', 'Studio']])]));
  const report = measureFidelity({ capture: { explored: [{ id: 's', tree: 'h' }], trees: { h: proto }, css: { sheets: [] } }, nativeDom: { s: native }, sheets: [] });
  assert.equal(report.score, 1, JSON.stringify(report.mismatches));
  // a value that is not the text, and a selection the prototype marks on another option, still differ
  const marked = body(select([option(0, 'Casa'), option(1, 'Studio', [['selected', '']])]));
  const wrong = body(select([option(0, 'Casa', [['value', 'house'], ['selected', '']]), option(1, 'Studio', [['selected', '']])]));
  const strict = measureFidelity({ capture: { explored: [{ id: 's', tree: 'h' }], trees: { h: marked }, css: { sheets: [] } }, nativeDom: { s: wrong }, sheets: [] });
  assert.deepEqual(strict.mismatches.map(item => [item.k, item.name]).sort(), [['v:s/0', 'selected'], ['v:s/0', 'value']]);
});

test('selector lists are split at top-level commas only', () => {
  assert.deepEqual(splitSelectors('a, b:is(.x, .y) > c, [data-a="1,2"]'), ['a', 'b:is(.x, .y) > c', '[data-a="1,2"]']);
});
