import '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../facade/friction-store.mjs';
import { readQueue, frictionTool, observeMcp } from '../facade/friction-boundary.mjs';
import { main } from '../facade/friction-cli.mjs';

test('all 60 reports are reachable through MCP continuations and CLI, without duplicates', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-report-pages-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createStore({ directory, clock: () => 1000 }); // equal timestamps exercise tie breaking
  const expected = [];
  for (let i = 0; i < 60; i++) expected.push(store.report({ kind: 'gap', tool: 'test', intent: 'pagination', attempted: String(i), taskId: 'audit' }).reportId);
  const initial = readQueue(store, { view: 'issues' });
  assert.equal(initial.reportsTotal, 60);
  const found = initial.reports.map(r => r.reportId);
  let continuation = initial.reportsContinuation;
  while (continuation) {
    const page = readQueue(store, continuation.arguments);
    assert.equal(page.total, 60);
    assert.equal(page.limit, 20);
    found.push(...page.reports.map(r => r.reportId));
    continuation = page.continuation;
  }
  assert.deepEqual(found, expected.sort());
  const cli = await main(['reports', '--offset', '20', '--limit', '40'], { store });
  assert.deepEqual(cli.reports.map(r => r.reportId), found.slice(20));
  assert.equal(cli.next, null);
  assert.equal(readQueue(store, { view: 'reports', taskId: 'unrelated' }).total, 0);
  const task = readQueue(store, { view: 'task', taskId: 'audit' });
  assert.equal(task.reportsContinuation.arguments.taskId, 'audit');
  assert.equal(readQueue(store, { view: 'reports', offset: 100 }).reports.length, 0);
  assert.ok(frictionTool.inputSchema.properties.view.enum.includes('reports'));
  let response;
  const observer = observeMcp({ store, meta: {}, toServer: () => assert.fail('local reports must not reach the Studio server'),
    toClient: text => { response = JSON.parse(text).result.structuredContent; } });
  t.after(() => observer.close());
  const transported = [];
  let args = { view: 'reports', limit: 7 };
  do {
    observer.request.write(JSON.stringify({ jsonrpc: '2.0', id: transported.length, method: 'tools/call',
      params: { name: 'ssam_friction', arguments: args } }) + '\n');
    assert.equal(response.ok, true);
    transported.push(...response.reports.map(r => r.reportId));
    args = response.continuation?.arguments;
  } while (args);
  assert.deepEqual(transported, found);
  for (const args of [{ limit: 101 }, { offset: -1 }, { max: 0 }]) assert.throws(() => readQueue(store, { view: 'reports', ...args }), /pagination/);
});
