import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { registerO11Publish } from '../o11-publish.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { listTasks, tasksDir } from '../ssam-task.mjs';
import { canonicalArguments } from '../read-budget.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ok = data => ({ success: true, data, error: null });

// Real publication and consumer cascade, through the same registration boundary used by ssam.mjs.
// Only the bridge, release identity, write lock and environment inventory are fake.
// Owner decision (2026-10-18): a publication answers when it ends; past the deadline it is kept (its task detaches, its
// original call waits) and its final answer is the first answer.
for (const { label, deadlineMs, publishMs } of [
  { label: 'fast', deadlineMs: 200, publishMs: 0 },
  { label: 'kept past the deadline', deadlineMs: 50, publishMs: 100 },
]) test(`R2 ${label}: producer and consumer retain their own tracked summaries`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx12-publish-summary-'));
  const journal = [], publications = [];
  let active;
  const bridge = await fakeBridge(async request => {
    switch (request.method) {
      case 'open_module':
        active = request.params.name;
        return ok({ name: active, opened: true, alreadyOpen: true, selected: true });
      case 'get_active_module':
        return ok({ name: active, key: 'k-' + active, kind: 'Web', environment: 'fake.example.com', pendingDialogs: [] });
      case 'get_errors': return ok({ isValid: true, errors: 0, warnings: 0, messages: [] });
      case 'refresh_references': return ok({ module: active, changed: true, refreshed: request.params.producers });
      case 'publish':
        publications.push(request.params.module_key);
        await sleep(publishMs);
        return ok({ module: active, published: true, state: 'CompletedWithSuccessNotOpenedInBrowser' });
      default: return { success: false, data: null, error: 'Unknown fake method: ' + request.method };
    }
  });
  const identity = { root, release: { head: 'fake', facadeSha256: 'fake', catalogSha256: 'fake' } };
  const server = await createSsamServer({ o11: false, odc: false, deps: {
    answersRoot: root, callDeadlineMs: deadlineMs, identity: { read: () => identity },
    writeLock: async (_, fn) => fn(), lock: { o11Root: root, odcRoot: root, connection: () => null },
  } });
  registerO11Publish(server, {
    root, env: { ...process.env, ANVIL_AUTHORITY_DIR: path.join(root, 'authority') }, lane: 'ss4', registerGrant: false,
    bridge: o11Bridge({ port: bridge.port, authorization: 'fake' }), assertSelected: async () => {},
    journal: (_, entry) => journal.push(entry), inventory: () => ({ modules: [] }),
    consumersOf: async () => [{ name: 'Consumer' }],
  });
  const client = new Client({ name: 'publish-summary-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const args = { module: 'Producer', authorize: 'publish Producer and Consumer in the fake test', consumers: true };
  const run = arguments_ => client.callTool({ name: 'o11_publish', arguments: arguments_ });
  const first = await run(args);
  assert.notEqual(first.structuredContent.state, 'running');
  let final = first;
  while (final.structuredContent.state === 'running') final = await run(final.structuredContent.continuation.arguments);
  assert.equal(final.structuredContent.ok, true, JSON.stringify(final));
  assert.deepEqual(final.structuredContent.consumers, [{ module: 'Consumer', outcome: 'published' }]);
  assert.deepEqual(publications, ['k-Producer', 'k-Consumer']);
  const records = listTasks({ dir: tasksDir(root) });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.summary.module).sort(), ['Consumer', 'Producer']);
  const producer = records.find(record => record.summary.module === 'Producer');
  const consumer = records.find(record => record.summary.module === 'Consumer');
  assert.notEqual(producer.summary.operationId, consumer.summary.operationId);
  for (const record of records) {
    assert.match(record.summary.operationId, /^[0-9a-f-]{36}$/);
    const start = journal.find(entry => entry.event === 'start' && entry.module === record.summary.module);
    assert.equal(record.summary.operationId, start.operationId);
    assert.equal(record.id, start.task);
    assert.equal(record.summary.environment, 'fake.example.com');
    assert.equal(record.summary.argsSha256, undefined);
    assert.equal(record.summary.lane, undefined);
    assert.equal(record.call.lane, 'o11');
    assert.equal(record.call.argsSha256, createHash('sha256').update(canonicalArguments(args)).digest('hex'));
    assert.equal(record.state, 'ok');
  }
  assert.equal(producer.callTask, undefined);
  assert.equal(consumer.callTask, producer.id);
  // kept: the producer's record is the task of the call (its tracker inherits the call's id), detached past the deadline and
  // delivered once, to the original call
  if (label !== 'fast') { assert.equal(producer.deliveries, 1); assert.ok(producer.answer?.file); }
  assert.doesNotMatch(JSON.stringify(records), /publish Producer and Consumer/);
});
