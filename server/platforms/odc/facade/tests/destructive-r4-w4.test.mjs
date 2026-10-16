import './fixtures/isolated-profile.mjs';
// CX15 r4 (W-4): an o11_data insert, update or batch WITHOUT a delete does not pass through the delete gate, and ssam.mjs
// wrote the request as it came, authorization in clear, to <dataRoot>\.local\data\requests\<uuid>.json (never cleaned),
// and gave it to the kernel, which copies it into its receipt (DataReceipt.cs:34). Now the request file and the kernel get
// sha256:<hex> of the words (the kernel only requires a nonempty value: DataReceipt.cs:13, EnvironmentData.cs:611), for
// the request and for each op; the read continuation of the answer is built from the same hashed request. A fake runner
// reads the --request file at the call and writes the receipt the kernel would write. Synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { MARK, ownerWords, count, inValue, filesWithMark } from './fixtures/destructive-r4-marker.mjs';

const HASHED = /^sha256:[0-9a-f]{64}$/;
const WORDS = ownerWords('ZZCliente', 'gravar');
const uuid = n => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n.repeat(12)}`;
const CASES = {
  insert: { operation: 'insert', entity: 'ZZCliente', operationId: uuid('1'), records: [{ Nome: 'ZZR4a' }], authorization: WORDS },
  update: { operation: 'update', entity: 'ZZCliente', operationId: uuid('2'), ids: ['7'], records: [{ Nome: 'ZZR4b' }], authorization: WORDS },
  batch: { authorization: WORDS, batch: [
    { step: 'a', operation: 'insert', entity: 'ZZCliente', operationId: uuid('3'), records: [{ Nome: 'ZZR4c' }] },
    { step: 'b', operation: 'update', entity: 'ZZCliente', operationId: uuid('4'), ids: [{ $ref: 'a' }], records: [{ Nome: 'ZZR4d' }], authorization: WORDS }] },
  // A read that stopped early: its continuation repeats the op (before: with the words the op carried).
  read: { operation: 'read', entity: 'ZZCliente', limit: 1, authorization: WORDS },
};

for (const [name, request] of Object.entries(CASES)) {
  test(`W-4 (o11_data ${name}, no delete): the --request file, the kernel's receipt and the answer carry no owner words`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r4-w4-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dataRoot = path.join(root, 'data'), answersRoot = path.join(root, 'answers'), lockRoot = path.join(root, 'lock');
    for (const d of [dataRoot, answersRoot, lockRoot]) fs.mkdirSync(d, { recursive: true });
    const seen = [];
    const runAnvil = async argv => {
      const file = argv[argv.indexOf('--request') + 1], work = argv[argv.indexOf('--work') + 1];
      const body = JSON.parse(fs.readFileSync(file, 'utf8'));
      seen.push({ argv: argv.join(' '), body });
      // DataReceipt.cs:34: the receipt keeps the request's authorization (of the op, else of the batch).
      const ops = Array.isArray(body.batch) ? body.batch : [body];
      const receipts = ops.map(op => ({ operationId: op.operationId ?? null, authorization: op.authorization ?? body.authorization ?? null }));
      fs.mkdirSync(path.join(work, 'receipts'), { recursive: true });
      fs.writeFileSync(path.join(work, 'receipts', 'receipt-' + seen.length + '.json'), JSON.stringify(receipts));
      const results = ops.map(op => (op.operation === 'read' ? { ok: true, rows: [{ Nome: 'x' }], continuation: { offset: 1 }, next: 'more rows' } : { ok: true, inserted: 1 }));
      return { ok: true, exitCode: 0, envelope: { ok: true, data: { ok: true, results, receipts } } };
    };
    const server = await createSsamServer({ o11: true, odc: false, deps: { runAnvil, dataRoot, answersRoot, lock: { o11Root: lockRoot, odcRoot: lockRoot } } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cx15r4-w4', version: '1.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    t.after(async () => { await client.close(); await server.close(); });
    const reply = await client.callTool({ name: 'o11_data', arguments: { host: 'zz-synthetic-o11.example.test', module: 'ZZShop', oml: 'C:/zz-synthetic/ZZShop.oml', request } });
    const text = reply.content?.[0]?.text ?? '';
    const value = reply.structuredContent ?? JSON.parse(text);
    assert.equal(seen.length, 1, 'the kernel ran once: ' + text.slice(0, 300));
    assert.equal(count(seen[0].argv), 0, 'the kernel argv has no owner words');
    for (const op of [seen[0].body, ...(seen[0].body.batch ?? [])]) if (op.authorization !== undefined) assert.match(op.authorization, HASHED, 'the kernel gets sha256:<hex>');
    assert.equal(count(text), 0, 'the answer text has no owner words');
    assert.equal(inValue(value), 0, 'the structured answer has no owner words');
    if (name === 'read') assert.match(value.continuation?.arguments?.request?.authorization ?? '', HASHED, 'the read continuation repeats the hashed op');
    assert.deepEqual(filesWithMark([root, process.env.USERPROFILE]), [], 'neither the --request file nor the receipt keeps the owner words');
  });
}
