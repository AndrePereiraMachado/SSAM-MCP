// Lane C, C10: the relay of the ssam server to the ODC lane server waits up to 30 min, every progress notification of
// the lane restarts that wait and reaches the outer client, the outer cancellation reaches the lane, and a relay that ends
// without an answer says TIMEOUT | CANCELLED for reads. R3-1 writes stay alive until real facade completion;
// the outer deadline supplies a same-tool continuation and explicit stop reaches the owned work signal.
// A fake ODC server in process (no Studio, no bridge, no pipe); the relay wait is shortened through deps.relayTimeoutMs.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as m_ssam from '../ssam.mjs';
const { createSsamServer, relayOptions, relayFailure, RELAY_TIMEOUT_MS } = m_ssam; // a namespace: at the base each test fails on its own rule, not at import

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

async function harness(t, { relayTimeoutMs = 400, callDeadlineMs, writeLock, detachedNotifications = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-c-relay-'));
  const seen = { waitProgress: 0, aborted: [], detached: [] };
  const relayChild = process.env.SSAM_RELAY_CHILD;
  if (detachedNotifications) process.env.SSAM_RELAY_CHILD = '1';
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    // A long read that reports progress every 100 ms for 800 ms: twice the relay wait, answered because each
    // notification restarts it.
    fake.registerTool('studio_wait', { description: 'Fake wait with progress.', inputSchema: z.object({ condition: z.string() }).strict() }, async (args, ctx) => {
      const token = ctx.mcpReq._meta?.progressToken;
      for (let i = 1; i <= 8; i++) {
        await sleep(100);
        if (token !== undefined) { seen.waitProgress++; await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: i, total: 8 } }); }
      }
      return text({ ok: true, condition: args.condition });
    });
    // The read ends on relay cancellation; the write ends only on its owned work signal (explicit stop).
    const hang = name => async (args, ctx) => {
      await new Promise(resolve => { if (ctx.mcpReq.signal.aborted) resolve(); else ctx.mcpReq.signal.addEventListener('abort', resolve, { once: true }); });
      seen.aborted.push(name);
      return text({ ok: true });
    };
    fake.registerTool('studio_deliver', { description: 'Fake delivery.', inputSchema: z.object({ feature: z.string(), pid: z.number().int().optional() }).strict() }, hang('studio_deliver'));
    fake.registerTool('studio_status', { description: 'Fake status.', inputSchema: z.object({ pid: z.number().int().optional() }).strict() }, hang('studio_status'));
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot: root, relayTimeoutMs, ...(callDeadlineMs != null ? { callDeadlineMs } : {}), ...(writeLock ? { writeLock } : {}),
    lock: { o11Root: root, odcRoot: root, connection: () => null }, answersRoot: root } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pacote-c-relay', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const original = clientSide.onmessage;
  clientSide.onmessage = (message, extra) => { if (message.method === 'notifications/ssam/detached_tasks') seen.detached.push(message.params.running); return original?.(message, extra); };
  t.after(async () => {
    if (seen.liveTask) {
      await client.callTool({ name: 'ssam_doctor', arguments: { task: { id: seen.liveTask, stop: true } } }).catch(() => {});
      await client.callTool({ name: 'studio_deliver', arguments: { continueTask: seen.liveTask } }).catch(() => {});
    }
    await client.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true });
    if (detachedNotifications) { if (relayChild == null) delete process.env.SSAM_RELAY_CHILD; else process.env.SSAM_RELAY_CHILD = relayChild; }
  });
  return { client, seen };
}
const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);

test('the relay asks the lane with a 30 min wait that progress restarts, and forwards progress to the outer client', async t => {
  const outer = { mcpReq: { _meta: { progressToken: 'p1' }, signal: new AbortController().signal, notify: async n => sent.push(n) } };
  const sent = [];
  const options = relayOptions(outer);
  assert.equal(options.timeout, 1_800_000); assert.equal(RELAY_TIMEOUT_MS, 1_800_000);
  assert.equal(options.resetTimeoutOnProgress, true);
  assert.equal(options.signal, outer.mcpReq.signal, 'the outer cancellation reaches the lane');
  options.onprogress({ progress: 3, total: 8 });
  await sleep(0);
  assert.deepEqual(sent, [{ method: 'notifications/progress', params: { progress: 3, total: 8, progressToken: 'p1' } }]);
  // An outer request without a progressToken gets nothing forwarded (the client did not ask for progress).
  const quiet = relayOptions({ mcpReq: { notify: async () => { throw new Error('never'); } } });
  quiet.onprogress({ progress: 1 });

  // End to end: the lane answers after 800 ms with progress, the relay waits 400 ms between notifications.
  const { client, seen } = await harness(t);
  const progress = [];
  const reply = await client.callTool({ name: 'studio_wait', arguments: { condition: 'idle' } }, { onprogress: p => progress.push(p.progress) });
  assert.notEqual(reply.isError, true, JSON.stringify(valueOf(reply)));
  assert.equal(valueOf(reply).condition, 'idle');
  assert.equal(seen.waitProgress, 8);
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7, 8], 'every notification of the lane reached the outer client');
});

test('a write remains running past relay timeout until explicit stop; a pure read still answers TIMEOUT', async t => {
  const { client, seen } = await harness(t, { callDeadlineMs: 700, detachedNotifications: true });
  const reply = await client.callTool({ name: 'studio_deliver', arguments: { feature: 'F', pid: 77 } });
  const value = valueOf(reply);
  seen.liveTask = value.task?.id;
  assert.notEqual(reply.isError, true);
  assert.equal(value.state, 'running');
  assert.equal(value.continuation.tool, 'studio_deliver');
  assert.equal(value.continuation.arguments.continueTask, value.task.id);
  assert.equal(seen.detached.at(-1), 1, 'launcher still counts the actual live facade write');
  assert.deepEqual(seen.aborted, [], 'relay timeout cannot stop the real write or finish its record');
  const stopped = valueOf(await client.callTool({ name: 'ssam_doctor', arguments: { lane: 'odc', task: { id: value.task.id, stop: true } } }));
  assert.equal(stopped.ok, true);
  assert.equal(valueOf(await client.callTool({ name: 'studio_deliver', arguments: value.continuation.arguments })).ok, true);
  assert.equal(seen.detached.at(-1), 0, 'the counter ends only after actual facade completion');
  const helper = relayFailure(Object.assign(new Error('Request timed out'), { code: 'REQUEST_TIMEOUT' }), { tool: 'studio_deliver', args: { feature: 'F' }, timeoutMs: RELAY_TIMEOUT_MS });
  assert.deepEqual([helper.code, helper.stage, helper.outcome, helper.tool], ['TIMEOUT', 'relay', 'uncertain', 'studio_deliver']);
  assert.match(helper.error, /within 30 min.*never repeated/);
  await sleep(50);
  assert.deepEqual(seen.aborted, ['studio_deliver'], 'explicit stop reached the actual facade work signal');
  // A read that times out is not "uncertain": nothing was written.
  const read = valueOf(await client.callTool({ name: 'studio_status', arguments: {} }));
  assert.equal(read.code, 'TIMEOUT'); assert.equal(read.outcome, undefined);
});

test('the outer cancellation reaches the lane; the failure helper says CANCELLED with the status continuation', async t => {
  const { client, seen } = await harness(t, { relayTimeoutMs: 60000 });
  const controller = new AbortController();
  const call = client.callTool({ name: 'studio_status', arguments: {} }, { signal: controller.signal });
  await sleep(150);
  controller.abort();
  await assert.rejects(call);
  for (let i = 0; i < 40 && !seen.aborted.length; i++) await sleep(25);
  assert.deepEqual(seen.aborted, ['studio_status'], 'the lane saw the cancellation');
  const aborted = new AbortController(); aborted.abort();
  const cancelled = relayFailure(new Error('AbortError'), { tool: 'studio_publish', args: {}, signal: aborted.signal });
  assert.deepEqual([cancelled.code, cancelled.outcome, cancelled.continuation.tool], ['CANCELLED', 'uncertain', 'studio_status']);
  const lost = relayFailure(new Error('Connection closed'), { tool: 'studio_inspect', args: {}, statusTool: 'ssam_doctor' });
  assert.deepEqual([lost.code, lost.outcome, lost.continuation.tool, lost.continuation.arguments], ['RELAY_FAILED', undefined, 'ssam_doctor', { lane: 'odc' }]);
});

test('the server wrapper hands the request signal to the Studio write lock (I7)', async t => {
  const calls = [];
  const writeLock = async (request, fn) => { calls.push(request); return fn(); };
  const { client } = await harness(t, { writeLock });
  await client.callTool({ name: 'studio_wait', arguments: { condition: 'idle' } });
  const call = calls.find(c => c.tool === 'studio_wait');
  assert.ok(call, 'the lock saw the call');
  assert.ok(call.signal instanceof AbortSignal, 'signal: the AbortSignal of the MCP request');
  assert.equal(call.lane, 'odc');
});
