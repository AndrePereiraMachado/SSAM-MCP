// Sort and filter helpers of the table builder (DESIGN.md 6.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pub } from './helpers.mjs';

const T = await import(pub('js/table.js'));

test('normalizeText drops case and accents', () => {
  assert.equal(T.normalizeText('Ação Única'), 'acao unica');
  assert.equal(T.normalizeText(null), '');
  assert.equal(T.normalizeText(42), '42');
});

test('filterRows matches any field, ignoring case and accents; empty text keeps every row', () => {
  const rows = [
    { customer: 'Cliente Ação', id: 'tok_0000000a1fa0' },
    { customer: 'Cliente Beta', id: 'tok_00000000be7a' },
  ];
  assert.deepEqual(T.filterRows(rows, 'acao', ['customer']).map((r) => r.id), ['tok_0000000a1fa0']);
  assert.deepEqual(T.filterRows(rows, 'BE7A', ['customer', 'id']).map((r) => r.id), ['tok_00000000be7a']);
  assert.deepEqual(T.filterRows(rows, 'tok_', [(r) => r.id]).length, 2);
  assert.deepEqual(T.filterRows(rows, 'gama', ['customer']), []);
  const all = T.filterRows(rows, '   ', ['customer']);
  assert.deepEqual(all, rows);
  assert.notEqual(all, rows);
});

test('compareValues: numbers, pt-BR numeric collation, arrays with nulls last', () => {
  assert.ok(T.compareValues(2, 10) < 0);
  assert.ok(T.compareValues('item 2', 'item 10') < 0);
  assert.ok(T.compareValues('abacaxi', 'Banana') < 0);
  assert.equal(T.compareValues('é', 'e'), 0);
  assert.ok(T.compareValues([1, 'b'], [1, 'a']) > 0);
  assert.ok(T.compareValues([null, 1], [1, 1]) > 0);
  assert.equal(T.compareValues([1, null], [1, null]), 0);
  assert.ok(T.compareValues(false, true) < 0);
});

test('sortRows: one key, nulls last in both directions, stable', () => {
  const rows = [{ k: 'a', v: 3 }, { k: 'b', v: null }, { k: 'c', v: 1 }, { k: 'd', v: 2 }, { k: 'e', v: 1 }];
  assert.deepEqual(T.sortRows(rows, (r) => r.v, 'asc').map((r) => r.k), ['c', 'e', 'd', 'a', 'b']);
  assert.deepEqual(T.sortRows(rows, (r) => r.v, 'desc').map((r) => r.k), ['a', 'd', 'c', 'e', 'b']);
  assert.deepEqual(T.sortRows(rows, () => 0, 'desc').map((r) => r.k), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(T.sortRows([{ v: NaN }, { v: 1 }], (r) => r.v).map((r) => r.v), [1, NaN]);
  assert.deepEqual(rows.map((r) => r.k), ['a', 'b', 'c', 'd', 'e'], 'the input is not mutated');
});

test('countText shows "n de m" only when filtered', () => {
  assert.equal(T.countText(3, 3), '3');
  assert.equal(T.countText(1, 3), '1 de 3');
  assert.equal(T.countText(0, 0), '0');
});
