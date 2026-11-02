import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portugueseIn } from './fixtures/portuguese.mjs';

test('the English guard treats complete hexadecimal colors as data', () => {
  assert.deepEqual(portugueseIn("'#da2' '#da23' '#da2337' '#da2337ff' '#DA2337'"), []);
});
test('hexadecimal colors do not hide nearby Portuguese or incomplete colors', () => {
  assert.deepEqual(portugueseIn("'da' '#da2337' 'para' '#da'").map(item => item.token), ['da', 'para', 'da']);
});
