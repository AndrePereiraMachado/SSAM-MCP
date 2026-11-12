// X1d (revisão G, G-revisa-X1-familia.test.mjs "achado X1d"): o limite de leituras não observadas era do processo
// (pending.size >= 128). As leituras de A que estouram o prazo ficam retidas até 300 s; com 128 delas, toda leitura limitada
// de QUALQUER outro cliente recebia READ_PENDING_LIMIT. Agora o limite de 128 é de cada chamador (token + contexto
// hospedado) e o processo tem um teto próprio, maior (1024). Local, sem contexto hospedado, é um chamador só: igual a antes.
// A ordem importa: `pending` é do processo e as leituras estouradas ficam retidas 300 s; o teste do teto vem por último.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedRead } from '../read-budget.mjs';
import { runWithExecutor } from '../executor.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ctx = tokenId => ({ hosted: true, tokenId, executor: { hosted: true, call: async () => { throw new Error('não usado'); } } });
const slow = () => sleep(2500).then(() => ({ ok: true }));
// n leituras do chamador que estouram o prazo e ficam retidas (não observadas).
const fill = (caller, n, tag) => {
  const run = () => Promise.all(Array.from({ length: n }, (_, i) => boundedRead({ scope: 'mcp:odc_read', args: { x1d: tag, i } }, slow, { timeoutMs: 20 })));
  return caller ? runWithExecutor(ctx(caller), run) : run();
};
const one = (caller, tag) => {
  const run = () => boundedRead({ scope: 'mcp:odc_read', args: { x1d: tag } }, async () => ({ ok: true, value: caller ?? 'local' }), { timeoutMs: 5000 });
  return caller ? runWithExecutor(ctx(caller), run) : run();
};

test('X1d (G): 128 leituras retidas de A não recusam a leitura de B', { timeout: 30000 }, async t => {
  const filled = await fill('tok_A', 128, 'g');
  assert.ok(filled.every(r => r.code === 'READ_DEADLINE_EXCEEDED'));
  const rb = await one('tok_B', 'g-b');
  t.diagnostic('B recebeu: ' + (rb.code ?? rb.value));
  assert.equal(rb.value, 'tok_B');
});

test('controle X1d: o próprio A continua limitado às suas 128 leituras não observadas', { timeout: 30000 }, async () => {
  const filled = await fill('tok_C', 128, 'c');
  assert.ok(filled.every(r => r.code === 'READ_DEADLINE_EXCEEDED'));
  const again = await one('tok_C', 'c-129');
  assert.equal(again.code, 'READ_PENDING_LIMIT');
});

test('controle X1d: local, sem contexto hospedado, o limite de 128 fica como era', { timeout: 30000 }, async () => {
  const filled = await fill(null, 128, 'local');
  assert.ok(filled.every(r => r.code === 'READ_DEADLINE_EXCEEDED'));
  assert.equal((await one(null, 'local-129')).code, 'READ_PENDING_LIMIT');
  assert.equal((await one('tok_D', 'local-other')).value, 'tok_D', 'o local cheio não recusa um chamador hospedado');
});

test('X1d: o processo tem um teto próprio (1024) — um chamador novo, sem nenhuma leitura sua, é recusado quando o processo enche', { timeout: 60000 }, async () => {
  let admitted = 0, refusedFresh = null;
  for (let caller = 0; caller < 16 && !refusedFresh; caller++) {
    const token = 'tok_P' + caller;
    const first = await one(token, 'p-first-' + caller);
    if (first.code === 'READ_PENDING_LIMIT') { refusedFresh = token; break; }
    const filled = await fill(token, 120, 'p' + caller);
    admitted += filled.filter(r => r.code === 'READ_DEADLINE_EXCEEDED').length;
  }
  assert.ok(refusedFresh, 'um chamador novo foi recusado pelo teto do processo');
  assert.ok(admitted <= 1024, String(admitted));
});
