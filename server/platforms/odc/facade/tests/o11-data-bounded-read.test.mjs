// P3 (friction cc5deb6b, 2026-10-08): a read-all of AuditEntry from offset 100000 ran 330 s against the Studio and the
// Studio froze. The kernel now bounds every read (EnvironmentData.ReadPaged); the facade lets limit/deadlineMs through
// and answers an incomplete read with complete:false and the exact next call. A fake runner: no worker, no Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as m_ssam from '../ssam.mjs';
const { createSsamServer, o11DataAnswer } = m_ssam;

const target = { host: 'dev.example.test', module: 'DCIPS_Audit_CS', oml: 'C:\\captures\\DCIPS_Audit_CS.oml' };

async function harness(t, reply) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-data-bounded-'));
  const calls = [];
  const runAnvil = async args => { calls.push(JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8'))); return reply(args); };
  const server = await createSsamServer({ odc: false, deps: { runAnvil, dataRoot: root, answersRoot: root, lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'o11-data-bounded', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { client, calls };
}
const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);

test('a read-all stopped at its limit answers complete:false and the same read from the next offset', async t => {
  const envelope = { ok: true, command: 'data', data: { ok: true, results: [{ ok: true, count: 2000, nextOffset: 102000, complete: false, stoppedBy: 'limit',
    continuation: { offset: 102000 }, next: '2000 rows reached the limit of 2000 rows per call; continue with the same read-all and offset 102000', records: [] }] } };
  const { client, calls } = await harness(t, () => ({ ok: true, exitCode: 0, envelope, stderr: [], via: 'worker' }));
  const request = { operation: 'read-all', entity: 'AuditEntry', offset: 100000, limit: 2000, deadlineMs: 30000 };
  const reply = await client.callTool({ name: 'o11_data', arguments: { ...target, request } });
  assert.notEqual(reply.isError, true, reply.content[0].text);
  assert.deepEqual(calls[0], request, 'limit and deadlineMs reach the kernel');
  const value = valueOf(reply);
  assert.equal(value.complete, false);
  assert.deepEqual(value.continuation.tool, 'o11_data');
  assert.deepEqual(value.continuation.arguments, { ...target, request: { ...request, offset: 102000 } });
  assert.match(value.continuation.why, /offset 102000/);
});

test('limit and deadlineMs outside their range are refused before the runner', async t => {
  const { client, calls } = await harness(t, () => { throw new Error('never run'); });
  for (const request of [
    { operation: 'read-all', entity: 'E', limit: 0 },
    { operation: 'read-all', entity: 'E', limit: 100001 },
    { operation: 'read-all', entity: 'E', deadlineMs: 500 },
    { batch: [{ operation: 'read-all', entity: 'E', deadlineMs: 600000 }] },
  ]) {
    const reply = await client.callTool({ name: 'o11_data', arguments: { ...target, request } });
    assert.equal(reply.isError, true, JSON.stringify(request));
  }
  assert.equal(calls.length, 0);
});

test('a first page that timed out answers DATA_READ_TIMEOUT with the continuation of the same offset; a complete read has none', () => {
  const timedOut = o11DataAnswer({ ok: false, exitCode: 1, envelope: { ok: false, command: 'data', data: { ok: false, code: 'DATA_READ_TIMEOUT', results: [
    { ok: false, code: 'DATA_READ_TIMEOUT', error: 'the page of AuditEntry at offset 100000 did not answer within 30 s; nothing was read', continuation: { offset: 100000 } }] } } },
  { batch: [{ step: 'audit', operation: 'read-all', entity: 'AuditEntry', offset: 100000 }] }, target);
  assert.equal(timedOut.code, 'DATA_READ_TIMEOUT');
  assert.deepEqual(timedOut.continuation.arguments.request, { operation: 'read-all', entity: 'AuditEntry', offset: 100000 });
  const done = o11DataAnswer({ ok: true, envelope: { ok: true, command: 'data', data: { ok: true, results: [{ ok: true, count: 3, complete: true, records: [] }] } } },
    { operation: 'read-all', entity: 'E' }, target);
  assert.equal(done.continuation, undefined);
  assert.equal(done.complete, undefined);
});
