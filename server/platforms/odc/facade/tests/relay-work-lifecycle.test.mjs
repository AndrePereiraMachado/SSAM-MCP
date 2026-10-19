import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { McpServer, InMemoryTransport, fromJsonSchema } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { wrap } from '../mcp.mjs';
import { configureRelayFacade, relayWork } from '../relay-lifecycle.mjs';
import { listTasks, readTask } from '../ssam-task.mjs';
import { createMcpRelay } from '../../../../facade/launch.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const value = r => r.structuredContent ?? JSON.parse(r.content[0].text);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const mutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };

async function assertLauncherKeepsWork(notes) {
  const children = []; let identity = { facadeSha256: 'a', catalogSha256: 'b' };
  const relay = createMcpRelay({ identity: () => identity, toObserver: () => {}, spawnChild: () => {
    const stdout = new PassThrough();
    const child = { stdout, stderr: null, killed: false, on: () => child, kill: () => { child.killed = true; },
      stdin: { destroyed: false, on: () => {}, end: () => {}, write: line => {
        const message = JSON.parse(String(line));
        if (message.method === 'initialize') queueMicrotask(() => stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'synthetic', version: '1' } } }) + '\n'));
        return true;
      } } };
    children.push(child); return child;
  } });
  relay.start(); const child = children[0];
  relay.toServer(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n'); await sleep(10);
  relay.toServer(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'studio_publish', arguments: {} } }) + '\n');
  for (const running of notes) child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/ssam/detached_tasks', params: { running } }) + '\n');
  relay.toServer(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }) + '\n');
  identity = { facadeSha256: 'c', catalogSha256: 'b' };
  relay.toServer(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'studio_status', arguments: {} } }) + '\n'); await sleep(20);
  assert.equal(children.length, 1); assert.equal(child.killed, false);
}

async function fixture(fn, { wrapped = true, deadline = 1000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx12-relay-work-'));
  const dir = path.join(root, 'tasks');
  const identity = { root, release: { head: 'synthetic', facadeSha256: 'synthetic', catalogSha256: 'synthetic' } };
  const server = await createSsamServer({ o11: false, odc: true, deps: { answersRoot: root, tasksDir: dir,
    callDeadlineMs: deadline, identity: { started: identity, read: () => identity },
    writeLock: async (_, run) => run(), lock: { o11Root: root, odcRoot: root, connection: () => null },
    odcFacade: async () => {
      const facade = new McpServer({ name: 'synthetic-facade', version: '1' });
      facade.registerTool('studio_publish', { inputSchema: fromJsonSchema({ type: 'object', properties: { module: { type: 'string' } } }), annotations: mutation }, wrapped ? wrap(fn) : fn);
      return facade;
    } } });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'synthetic-client', version: '1' });
  const notes = [];
  await Promise.all([server.connect(a), client.connect(b)]);
  const original = b.onmessage;
  b.onmessage = (message, extra) => { if (message.method === 'notifications/ssam/detached_tasks') notes.push(message.params.running); return original?.(message, extra); };
  return { client, notes, dir, close: async () => { await client.close(); await server.close(); },
    call: (args, signal) => client.callTool({ name: 'studio_publish', arguments: args }, { timeout: 3000, ...(signal ? { signal } : {}) }) };
}

test('R3-1: cancelled real ODC relay remains running, refuses close and delivers its actual version once', async () => {
  const gate = deferred(); const started = deferred(); let runs = 0;
  const prior = process.env.SSAM_RELAY_CHILD; process.env.SSAM_RELAY_CHILD = '1';
  const f = await fixture(async () => { runs++; started.resolve(); await gate.promise; return { ok: true, version: 7, run: runs }; });
  try {
    const abort = new AbortController(); const first = f.call({ module: 'SyntheticModule' }, abort.signal).catch(error => error);
    await started.promise; abort.abort('synthetic cancellation'); await first; await sleep(30);
    const task = listTasks({ dir: f.dir, tool: 'studio_publish' })[0];
    assert.equal(task.state, 'running', 'relay cancellation is not work completion');
    assert.equal(f.notes.at(-1), 1, 'launcher sees the still-live detached work');
    await assertLauncherKeepsWork(f.notes);
    const closed = value(await f.client.callTool({ name: 'ssam_doctor', arguments: { lane: 'odc', task: { id: task.id, close: { reason: 'synthetic reconciliation' } } } }));
    assert.equal(closed.code, 'CLOSE_TASK_RUNNING');
    const again = f.call({ module: 'SyntheticModule' }); await sleep(30); assert.equal(runs, 1);
    gate.resolve(); assert.equal(value(await again).version, 7);
    const finished = readTask(task.id, { dir: f.dir });
    assert.equal(finished.callResult.ok, true);
    assert.equal(value(JSON.parse(fs.readFileSync(finished.answer.file, 'utf8'))).version, 7);
    assert.equal(f.notes.at(-1), 0);
  } finally { gate.resolve(); await f.close(); if (prior == null) delete process.env.SSAM_RELAY_CHILD; else process.env.SSAM_RELAY_CHILD = prior; }
});

for (const wrapped of [true, false]) test(`R3-8: explicit doctor stop reaches the ${wrapped ? 'real wrapped' : 'unwrapped'} ODC facade before the next item`, async () => {
  let sent = 0; let stopped = false;
  const f = await fixture(async (_, ctx) => {
    for (let i = 0; i < 8; i++) { await sleep(40); if (ctx.mcpReq.signal.aborted) { stopped = true; break; } sent++; }
    const outcome = { ok: true, sent, stopped };
    return wrapped ? outcome : { content: [{ type: 'text', text: JSON.stringify(outcome) }], structuredContent: outcome };
  }, { deadline: 60, wrapped });
  try {
    // Owner decision (2026-10-18): a publication answers when its work ends; past the deadline its call is kept (its task
    // detaches, the original call waits) and the explicit stop still reaches the facade before the next item.
    const original = f.call({ module: 'SyntheticStop' });
    await sleep(100);
    const running = listTasks({ dir: f.dir, tool: 'studio_publish' })[0]; assert.equal(running?.state, 'running');
    const before = sent;
    const stop = value(await f.client.callTool({ name: 'ssam_doctor', arguments: { lane: 'odc', task: { id: running.id, stop: true } } }));
    assert.equal(stop.ok, true);
    await sleep(70); assert.equal(stopped, true); assert.equal(sent, before);
    assert.equal(value(await original).stopped, true);
    assert.equal(value(await f.call({ continueTask: running.id })).stopped, true);
  } finally { await f.close(); }
});

test('R3-1: an internal SDK timeout after dispatch still awaits the actual facade outcome', async () => {
  const facade = new McpServer({ name: 'synthetic-timeout', version: '1' });
  const abort = new AbortController(); let finished = false;
  facade.registerTool('studio_publish', { inputSchema: fromJsonSchema({ type: 'object' }), annotations: mutation }, wrap(async (_, ctx) => {
    await sleep(60); finished = true; return { ok: true, version: 7, stopped: ctx.mcpReq.signal.aborted };
  }));
  configureRelayFacade(facade);
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'synthetic-timeout-client', version: '1' });
  await Promise.all([facade.connect(a), client.connect(b)]);
  try {
    const promise = relayWork(client, { name: 'studio_publish', arguments: {} }, { mcpReq: { signal: abort.signal } }, { signal: abort.signal, timeout: 10 }, { write: true });
    await sleep(20); assert.equal(finished, false); abort.abort('synthetic stop');
    const actual = value(await promise); assert.equal(finished, true); assert.equal(actual.version, 7); assert.equal(actual.stopped, true);
  } finally { await client.close(); await facade.close(); }
});
