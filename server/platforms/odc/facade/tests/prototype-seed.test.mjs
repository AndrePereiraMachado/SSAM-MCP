// The seed phase of the prototype importer (docs/PROTOTIPO-NATIVO.md 3.4, 7.6 test 6): the store rows go only into the
// regular entities the import created and marked, only when they are empty, with the prototype keys, parents first, and
// never without publish:true (a clean publication) and the words of the call. The writer is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedPlan, seedPrototypeData, captureOf, o11DataWriter, odcDataWriter, MARK } from '../prototype-seed.mjs';
import { farmaIr, kernelReport, FARMA } from './fixtures/prototype-surface/fakes.mjs';

const WORDS = 'sim, pode importar, publicar e carregar os dados de demonstração';
function writer({ counts = {}, refuse = {} } = {}) {
  const requests = [];
  const write = async request => {
    requests.push(structuredClone(request));
    return { ok: true, results: request.batch.map(op => (refuse[op.entity] ? { ok: false, error: 'refused ' + op.entity }
      : op.operation === 'insert' ? { ok: true, inserted: op.records.length } : { ok: true, count: counts[op.entity] ?? 0 })) };
  };
  write.requests = requests;
  return write;
}
const receipt = () => ({ flow: 'FarmaVirtual', data: kernelReport().data });

test('the plan: only the marked regular entities with rows, parents before children, the rows with the prototype keys', () => {
  const reversed = receipt(); reversed.data.entities = [...reversed.data.entities].reverse();
  const plan = seedPlan({ receipt: reversed, capture: farmaIr(FARMA) });
  assert.deepEqual(plan.map(e => e.entity), ['FarmaVirtualPedido', 'FarmaVirtualProduto', 'FarmaVirtualPedidoItem', 'FarmaVirtualCarrinhoItem'],
    'Pedido and Produto before PedidoItem (which references both) whatever the order of the receipt; the unmarked Carrinho never');
  const produto = plan.find(e => e.entity === 'FarmaVirtualProduto');
  assert.deepEqual(produto.rows.map(r => r.Id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(produto.rows[0].ImagemUrl, 'assets/products.png#tile=0');
  // A static collection (Categoria) is never seeded: its records are static entity records built by the import.
  assert.ok(!plan.some(e => e.collection === 'Categoria'));
  // An entity whose description lacks the mark of the prefix is not the import's.
  const foreign = receipt(); foreign.data.entities[0] = { ...foreign.data.entities[0], description: 'Produtos do concorrente' };
  assert.ok(!seedPlan({ receipt: foreign, capture: farmaIr(FARMA) }).some(e => e.entity === 'FarmaVirtualProduto'));
  const own = receipt(); own.data.entities[0] = { ...own.data.entities[0], description: 'Produto do protótipo. ' + MARK('FarmaVirtual') };
  assert.ok(seedPlan({ receipt: own, capture: farmaIr(FARMA) }).some(e => e.entity === 'FarmaVirtualProduto'));
});

test('the seed writes only the empty entities, in one read batch and one insert batch, with the words of the call', async () => {
  const write = writer({ counts: { FarmaVirtualPedido: 5 } });
  const seed = await seedPrototypeData({ lane: 'o11', module: 'Haiku_UI', receipt: receipt(), bundle: farmaIr(FARMA), authorize: WORDS, write, published: true });
  assert.equal(seed.ran, true);
  assert.deepEqual(seed.skippedNotEmpty, ['FarmaVirtualPedido']);
  assert.deepEqual(seed.seeded.map(s => [s.entity, s.rows]), [['FarmaVirtualProduto', 8], ['FarmaVirtualCarrinhoItem', 2], ['FarmaVirtualPedidoItem', 2]]);
  assert.equal(seed.entities, 3); assert.equal(seed.rows, 12);
  assert.equal(write.requests.length, 2);
  assert.ok(write.requests[0].batch.every(op => op.operation === 'read-all' && op.limit === 1));
  assert.ok(write.requests[1].batch.every(op => op.operation === 'insert' && /^[0-9a-f-]{36}$/.test(op.operationId)));
  assert.equal(write.requests[1].authorization, WORDS);
  assert.deepEqual(write.requests[1].batch[0].records.map(r => r.Id), [1, 2, 3, 4, 5, 6, 7, 8], 'the keys of the prototype (no AutoNumber)');
  assert.deepEqual(seed.seeded[0].keys, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(typeof seed.seedMs, 'number');
  // A refused insert is reported per entity, the others stand.
  const partial = await seedPrototypeData({ lane: 'odc', module: 'Haiku', receipt: receipt(), bundle: farmaIr(FARMA), authorize: WORDS, write: writer({ refuse: { FarmaVirtualPedidoItem: true } }), published: true });
  assert.deepEqual(partial.failed.map(f => f.entity), ['FarmaVirtualPedidoItem']); assert.equal(partial.entities, 3);
});

test('never without publish:true and a clean publication, with seed:false, or without the words of the call', async () => {
  for (const [args, why] of [[{ published: false }, /publish:true/], [{ published: true, seed: false }, /seed is false/], [{ published: true, authorize: '' }, /authorization words/],
    [{ published: true, authorize: '<palavras do usuário>' }, /authorization words/]]) {
    const write = writer();
    const seed = await seedPrototypeData({ lane: 'o11', module: 'Haiku_UI', receipt: receipt(), bundle: farmaIr(FARMA), authorize: WORDS, write, ...args });
    assert.equal(seed.ran, false); assert.match(seed.reason, why); assert.equal(write.requests.length, 0, 'nothing is written');
  }
});

test('the default writers: O11 one data --studio batch; ODC the bridge data service per entity', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-seed-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const runAnvil = async args => { calls.push(args); const request = JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8'));
    return { envelope: { ok: true, data: { results: request.batch.map(op => (op.operation === 'insert' ? { ok: true, inserted: op.records.length } : { ok: true, rows: [] })) } } }; };
  const o11 = o11DataWriter({ runAnvil, host: 'env.test', oml: path.join(dir, 'published.oml'), work: dir });
  const answer = await o11({ module: 'Haiku_UI', authorization: WORDS, batch: [{ operation: 'read-all', entity: 'E', limit: 1, step: 'r0' }] });
  assert.equal(answer.ok, true); assert.deepEqual(calls[0].slice(0, 6), ['data', '--studio', '--host', 'env.test', '--module', 'Haiku_UI']);
  const studioCalls = [];
  const odc = odcDataWriter({ studio: async (args, pid) => { studioCalls.push(args); return args[0] === 'data' ? { ok: true, records: [{ Id: 1 }] } : { ok: true, records: [{ recordId: 1 }, { recordId: 2 }] }; }, pid: 7, dir });
  const r = await odc({ module: 'Haiku', authorization: WORDS, batch: [{ operation: 'read-all', entity: 'E', limit: 1 }, { operation: 'insert', entity: 'E', records: [{ Id: 1 }, { Id: 2 }] }] });
  assert.deepEqual(studioCalls[0], ['data', 'Haiku', 'E', '--limit', '1']);
  assert.equal(studioCalls[1][0], 'data-insert'); assert.ok(studioCalls[1].includes('--authorize')); assert.equal(r.results[1].inserted, 2); assert.equal(r.results[0].records.length, 1);
  assert.equal(captureOf(path.join(dir, 'nope')), null);
});
