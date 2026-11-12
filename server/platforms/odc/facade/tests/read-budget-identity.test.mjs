// X1: boundedRead junta e retém leituras só para quem as começou. Os três primeiros casos são os da revisão G
// (G-revisa-E-segunda-leitura.test.mjs: "achado X1", "achado X1b", "resiste (controle de X1)"), agora sem `todo`.
// O boundedRead e o contexto hospedado reais (runWithExecutor); o "handler" devolve de quem é o contexto em que rodou.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedRead } from '../read-budget.mjs';
import { runWithExecutor, hostedContext } from '../executor.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hosted = (tokenId, id) => ({ hosted: true, tokenId, ...(id ? { id } : {}), executor: { call: async () => { throw new Error('não usado'); } } });
const whoRead = delayMs => async () => { await sleep(delayMs); return { ok: true, value: 'dados do cliente ' + hostedContext()?.tokenId }; };
const sameArgs = { scope: 'mcp:odc_read', args: { api: 'apps', operation: 'list' } };

test('X1 (G): duas sessões hospedadas, mesmos argumentos ao mesmo tempo — cada uma recebe a leitura do próprio contexto', { timeout: 10000 }, async t => {
  const a = runWithExecutor(hosted('tok_A'), () => boundedRead({ ...sameArgs, r: 1 }, whoRead(150), { timeoutMs: 5000 }));
  await sleep(20);
  const b = runWithExecutor(hosted('tok_B'), () => boundedRead({ ...sameArgs, r: 1 }, whoRead(150), { timeoutMs: 5000 }));
  const [ra, rb] = await Promise.all([a, b]);
  t.diagnostic('A recebeu: ' + ra.value + ' | B recebeu: ' + rb.value);
  assert.equal(ra.value, 'dados do cliente tok_A');
  assert.equal(rb.value, 'dados do cliente tok_B', 'B recebeu a resposta lida no contexto de outro cliente');
});

test('X1b (G): A estoura o prazo; B pede o mesmo dentro dos 300 s e recebe a sua própria leitura', { timeout: 10000 }, async t => {
  const ra = await runWithExecutor(hosted('tok_A'), () => boundedRead({ ...sameArgs, r: 2 }, whoRead(300), { timeoutMs: 100 }));
  assert.equal(ra.code, 'READ_DEADLINE_EXCEEDED');
  await sleep(400);                                     // o trabalho de A terminou depois do prazo; fica retido para "a mesma chamada"
  const rb = await runWithExecutor(hosted('tok_B'), () => boundedRead({ ...sameArgs, r: 2 }, whoRead(10), { timeoutMs: 5000 }));
  t.diagnostic('B recebeu: ' + JSON.stringify(rb).slice(0, 120));
  assert.equal(rb.value, 'dados do cliente tok_B');
});

test('controle de X1 (G): o mesmo cliente repetindo a chamada junta-se a ela', { timeout: 10000 }, async () => {
  const a = runWithExecutor(hosted('tok_A'), () => boundedRead({ ...sameArgs, r: 3 }, whoRead(100), { timeoutMs: 5000 }));
  await sleep(10);
  const again = runWithExecutor(hosted('tok_A'), () => boundedRead({ ...sameArgs, r: 3 }, async () => { throw new Error('não deveria rodar de novo'); }, { timeoutMs: 5000 }));
  const [ra, rb] = await Promise.all([a, again]);
  assert.deepEqual(rb, ra);
});

test('X1b, a continuação: depois do prazo, o MESMO cliente acha a leitura pendente dele (sem reenviar) e o resultado tardio', { timeout: 10000 }, async () => {
  let runs = 0;
  const work = async () => { runs++; await sleep(250); return { ok: true, value: 'dados do cliente ' + hostedContext()?.tokenId }; };
  const first = await runWithExecutor(hosted('tok_A', 'ctx-1'), () => boundedRead({ ...sameArgs, r: 4 }, work, { timeoutMs: 50 }));
  assert.equal(first.code, 'READ_DEADLINE_EXCEEDED');
  const pending = await runWithExecutor(hosted('tok_A', 'ctx-1'), () => boundedRead({ ...sameArgs, r: 4 }, work, { timeoutMs: 5000 }));
  assert.equal(pending.code, 'READ_DEADLINE_EXCEEDED'); assert.equal(pending.operationId, first.operationId);
  const other = await runWithExecutor(hosted('tok_B', 'ctx-2'), () => boundedRead({ ...sameArgs, r: 4 }, whoRead(5), { timeoutMs: 5000 }));
  assert.equal(other.value, 'dados do cliente tok_B', 'o timeoutAnswer de A não serve B');
  await sleep(300);
  const late = await runWithExecutor(hosted('tok_A', 'ctx-1'), () => boundedRead({ ...sameArgs, r: 4 }, work, { timeoutMs: 5000 }));
  assert.equal(late.value, 'dados do cliente tok_A'); assert.equal(runs, 1);
});

test('X1: o mesmo token em outro contexto hospedado (o link do Agent fechou e voltou) não herda a leitura do contexto anterior', { timeout: 10000 }, async () => {
  const a = runWithExecutor(hosted('tok_A', 'ctx-old'), () => boundedRead({ ...sameArgs, r: 5 }, async () => { await sleep(120); return { ok: true, value: 'antigo' }; }, { timeoutMs: 5000 }));
  await sleep(10);
  const b = runWithExecutor(hosted('tok_A', 'ctx-new'), () => boundedRead({ ...sameArgs, r: 5 }, async () => ({ ok: true, value: 'novo' }), { timeoutMs: 5000 }));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.value, 'antigo'); assert.equal(rb.value, 'novo');
});

test('local, sem contexto hospedado: a junção por argumentos fica como era', { timeout: 10000 }, async () => {
  let runs = 0;
  const work = async () => { runs++; await sleep(80); return { ok: true, runs }; };
  const key = { ...sameArgs, r: 6 };
  const [a, b] = await Promise.all([boundedRead(key, work), sleep(10).then(() => boundedRead(key, work))]);
  assert.deepEqual(a, b); assert.equal(runs, 1);
});
