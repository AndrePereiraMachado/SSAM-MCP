// Lane C, C24 (facade part): o11_data goes through the O11 runner the other O11 tools use (the lane's resident worker
// first, cold with ANVIL_WORKER=0) instead of a cold process per call, and its request schema takes the batch of I12:
// {authorization?, batch:[op]} with a step per op and {"$ref": "<step>"} values. A fake runner: no worker, no Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as m_ssam from '../ssam.mjs';
const { createSsamServer, o11DataAnswer } = m_ssam; // a namespace: at the base each test fails on its own rule, not at import
import { wordsSha256 } from '../destructive-operations.mjs';

async function harness(t, reply) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-c-data-'));
  const calls = [];
  const runAnvil = async (args, options) => { const request=args.includes('--request')?JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8')):null;calls.push({args,options,request});if(args.includes('--schema'))return{ok:true,moduleKey:'module-orders',module:'Orders_CS',entities:[{name:'Order',key:'entity-order',identifier:'Id',attributes:[{name:'Id',type:'Order Identifier'},{name:'Number',type:'Text'}]},{name:'OrderLine',key:'entity-order-line',identifier:'Id',attributes:[{name:'Id',type:'OrderLine Identifier'},{name:'OrderId',type:'Order Identifier'},{name:'Qty',type:'Integer'}]}]};return reply(args); };
  const server = await createSsamServer({ odc: false, deps: { runAnvil, dataRoot: root, answersRoot: root, lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pacote-c-data', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { client, calls, root };
}
const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);
const target = { host: 'dev.example.test', module: 'Orders_CS', oml: 'C:\\captures\\Orders_CS.oml' };

test('a batch with steps and $ref values is accepted and runs through the O11 runner (worker first), one call', async t => {
  const envelope = { ok: true, command: 'data', elapsedMs: 5, data: { ok: true, results: [{ step: 'order', ids: ['11'] }, { step: 'line', ids: ['21', '22'] }] } };
  const { client, calls } = await harness(t, () => ({ ok: true, exitCode: 0, envelope, stderr: [], wallMs: 9, via: 'worker' }));
  const request = { authorization: 'pode gravar os pedidos de teste', batch: [
    { step: 'order', operation: 'insert', entity: 'Order', operationId: '7a1c4e1e-1111-4111-8111-111111111111', records: [{ Number: 'A-1' }] },
    { step: 'line', operation: 'insert', entity: 'OrderLine', operationId: '7a1c4e1e-2222-4222-8222-222222222222', records: [{ OrderId: { $ref: 'order' }, Qty: 1 }, { OrderId: { $ref: 'order#0' }, Qty: 2 }] },
    { step: 'read', operation: 'read', entity: 'OrderLine', ids: [{ $ref: 'line#1' }] }] };
  const reply = await client.callTool({ name: 'o11_data', arguments: { ...target, request } });
  assert.notEqual(reply.isError, true, reply.content[0].text);
  const writes=calls.filter(c=>c.request);assert.equal(writes.length,1,'the whole batch is one CLI write command');
  // CX13 review 6 (converted): with no file load open, the inline batch reads no target identity first (no --schema).
  assert.equal(calls.some(c=>c.args.includes('--schema')),false);
  const { args } = writes[0];
  assert.deepEqual(args.slice(0, 7), ['data', '--studio', '--host', 'dev.example.test', '--module', 'Orders_CS', '--oml']);
  assert.ok(args.includes('--request') && args.includes('--work'));
  // CX15 r4 (W-4, converted): steps and $ref intact; the authorization reaches the kernel as sha256:<hex> of the owner's
  // words, never the words (before: the request as sent, words included).
  assert.deepEqual(writes[0].request, { ...request, authorization: 'sha256:' + wordsSha256(request.authorization) }, 'the request reaches the kernel with steps and $ref intact, the words hashed');
  const value = valueOf(reply);
  assert.deepEqual([value.ok, value.lane, value.verb, value.via, value.wallMs], [true, 'o11', 'data', 'worker', 9]);
  assert.deepEqual(value.result, envelope);
  // One op, as before, is still the request.
  const single = await client.callTool({ name: 'o11_data', arguments: { ...target, request: { operation: 'read-all', entity: 'Order' } } });
  assert.notEqual(single.isError, true, single.content[0].text);
  assert.equal(calls.filter(c=>c.request).length, 2);
});

test('the schema refuses what the kernel would: an unknown key, an empty batch, a $ref that is not a step name', async t => {
  const { client, calls } = await harness(t, () => { throw new Error('never run'); });
  for (const request of [
    { batch: [{ operation: 'insert', entity: 'E', bogus: 1 }] },
    { batch: [{ operation: 'upsert', entity: 'E' }] },
    { batch: [] },
    { batch: [{ operation: 'update', entity: 'E', ids: [{ $ref: 3 }] }] },
    { operation: 'read', entity: 'E', step: 'only-in-a-batch' },
  ]) {
    const reply = await client.callTool({ name: 'o11_data', arguments: { ...target, request } });
    assert.equal(reply.isError, true, JSON.stringify(request));
  }
  assert.equal(calls.length, 0, 'nothing reached the runner');
});

test('the answer lifts the refusal of the kernel and never repeats a write whose outcome is unknown', () => {
  const refused = o11DataAnswer({ ok: false, exitCode: 1, via: 'worker', envelope: { ok: false, command: 'data', data: { ok: false, code: 'DATA_REF_UNRESOLVED', error: 'step "x" is unknown' } } },
    { batch: [{ operation: 'insert', entity: 'E' }] });
  assert.deepEqual([refused.ok, refused.code, refused.error], [false, 'DATA_REF_UNRESOLVED', 'step "x" is unknown']);
  const coded = o11DataAnswer({ ok: false, envelope: { ok: false, command: 'data', error: { code: 'BRIDGE_TIMEOUT', message: 'm' } } }, { operation: 'read', entity: 'E' });
  assert.deepEqual([coded.code, coded.error], ['BRIDGE_TIMEOUT', { code: 'BRIDGE_TIMEOUT', message: 'm' }]);
  const unknown = o11DataAnswer({ ok: false, timedOut: true, unknown: true, code: 'WORKER_OUTCOME_UNKNOWN', envelope: null, stderr: ['worker connection failed after submission'] },
    { batch: [{ operation: 'read', entity: 'E' }, { operation: 'delete', entity: 'E', ids: ['1'] }] });
  assert.deepEqual([unknown.ok, unknown.code, unknown.stage, unknown.outcome], [false, 'WORKER_OUTCOME_UNKNOWN', 'data', 'uncertain']);
  assert.match(unknown.next, /same operationId/);
  const read = o11DataAnswer({ ok: false, timedOut: true, envelope: null, stderr: [] }, { operation: 'read', entity: 'E' });
  assert.equal(read.outcome, undefined, 'a read is never uncertain');
});
