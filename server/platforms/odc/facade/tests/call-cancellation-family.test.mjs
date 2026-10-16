import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { createCallDeadline } from '../call-deadline.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const response = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const value = result => result?.structuredContent ?? JSON.parse(result.content[0].text);
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx12-n1-family-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function realServer(t, deps = {}) {
  const root = sandbox(t);
  const identity = { root, release: { head: 'synthetic', facadeSha256: 'synthetic', catalogSha256: 'synthetic' } };
  const server = await createSsamServer({ o11: true, odc: true, deps: {
    answersRoot: root, callDeadlineMs: 5000, identity: { read: () => identity }, ...deps,
  } });
  const client = new Client({ name: 'n1-cancellation-family', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { root, server, client, clientTransport };
}

// No live handler is called to inventory the surface; all execution below is synthetic.
test('N1 every registered tool has an exported explicit classification', async t => {
  const { client } = await realServer(t);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.length > 80, `Expected full two-lane surface, got ${tools.length}`);
  const classification = await import('../tool-classification.mjs');
  assert.equal(typeof classification.classifyTool, 'function');
  for (const tool of tools) {
    const declaration = classification.classifyTool(tool.name);
    assert.equal(declaration.declared, true, `Missing explicit classification: ${tool.name}`);
    assert.equal(typeof declaration.isWrite, 'boolean', `Missing operation result: ${tool.name}`);
    assert.equal(classification.TOOL_CLASSIFICATIONS.has(tool.name), true);
  }
});

test('N1 cancellation joins every potentially mutating served tool without a second execution', async t => {
  const { root, client } = await realServer(t);
  const tools = (await client.listTools()).tools.filter(tool => tool.annotations?.destructiveHint === true || tool.annotations?.readOnlyHint !== true);
  assert.ok(tools.some(tool => tool.name === 'ssam_job'));
  assert.ok(tools.some(tool => tool.name === 'odc_asset_delete'));
  const failures = [];
  for (const tool of tools) {
    const deadline = createCallDeadline({ root, timeoutMs: 5000 });
    let calls = 0, live = 0, maxLive = 0, finish;
    const gate = new Promise(resolve => { finish = resolve; });
    const run = deadline.wrap(tool.name, async () => {
      calls++; live++; maxLive = Math.max(maxLive, live);
      await gate; live--;
      return response({ ok: true, version: 7, source: tool.name });
    });
    const abort = new AbortController();
    const args = { lane: 'odc', synthetic: tool.name };
    const cancelled = run(args, { mcpReq: { signal: abort.signal } }).then(result => ({ result }), error => ({ error }));
    await sleep(20); abort.abort('synthetic user cancellation');
    await sleep(30);
    const joined = run(args);
    await sleep(10); finish();
    const original = await cancelled;
    const result = value(await joined);
    try {
      assert.equal(original.error?.code, 'CANCELLED');
      assert.equal(calls, 1, `${tool.name}: original and retry executions`);
      assert.equal(maxLive, 1, `${tool.name}: simultaneous executions`);
      assert.equal(result.ok, true, `${tool.name}: ${JSON.stringify(result)}`);
      assert.equal(result.version, 7);
      assert.equal(result.joined, true);
      assert.notEqual(result.code, 'TASK_ORPHANED');
      assert.notEqual(result.code, 'TASK_CANCELLED_UNCERTAIN');
    } catch (error) { failures.push(`${tool.name}: ${error.message}`); }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('N1 cancelled pure read retains active joiners, then permits a fresh read after completion', async t => {
  const root = sandbox(t);
  const deadline = createCallDeadline({ root, timeoutMs: 100 });
  let calls = 0, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const run = deadline.wrap('studio_status', async () => { calls++; await gate; return response({ ok: true, payload: 'actual read' }); });
  const abort = new AbortController();
  const cancelled = run({}, { mcpReq: { signal: abort.signal } }).catch(error => error);
  await sleep(20); abort.abort();
  const joined = await run({});
  assert.equal((await cancelled).code, 'CANCELLED');
  assert.equal(calls, 1);
  const stillRunning = await run(value(joined).continuation.arguments);
  assert.equal(value(stillRunning).state, 'running');
  assert.notEqual(value(stillRunning).code, 'TASK_ORPHANED');
  finish();
  const final = value(await run(value(joined).continuation.arguments));
  assert.equal(final.payload, 'actual read');
  await run({});
  assert.equal(calls, 2);
});

test('N1 real SDK notifications/cancelled only cancels its caller; identical ssam_job gets actual result', async t => {
  let calls = 0, live = 0, maxLive = 0, finish, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const { client, clientTransport } = await realServer(t, {
    writeLock: async (_, execute) => execute(),
    jobTool: async () => { markStarted(); calls++; live++; maxLive = Math.max(maxLive, live); await gate; live--; return { ok: true, version: 7, origin: 'original-job' }; },
  });
  const messages = [], send = clientTransport.send.bind(clientTransport);
  clientTransport.send = async message => { messages.push(message); return send(message); };
  const args = { lane: 'o11', job: { ops: [] }, base: 'C:/synthetic/base.oml' };
  const abort = new AbortController();
  const original = client.callTool({ name: 'ssam_job', arguments: args }, { signal: abort.signal }).catch(error => error);
  await started;
  await sleep(20); abort.abort('synthetic escape');
  await sleep(30);
  const joined = client.callTool({ name: 'ssam_job', arguments: args });
  await sleep(20); finish();
  const cancelled = await original;
  const result = value(await joined);
  assert.ok(cancelled instanceof Error);
  assert.ok(messages.some(message => message.method === 'notifications/cancelled'), 'SDK must actually send cancellation notification');
  assert.equal(calls, 1);
  assert.equal(maxLive, 1);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.version, 7);
  assert.equal(result.origin, 'original-job');
  assert.notEqual(result.code, 'TASK_ORPHANED');
});
