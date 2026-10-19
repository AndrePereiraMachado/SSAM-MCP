import './fixtures/isolated-profile.mjs';
// The family rule of deliveries and creations reaches every served call through ssam.mjs (the served handler marks the live
// call): through the MCP SDK a delivery answers its final result in ONE call past the server's deadline, an ODC delivery
// relayed to the lane server and a nested ssam_code write too, while a read still answers running with continueTask. The
// real SDK client timeout (notifications/cancelled) leaves the work running and the identical repeat joins it. A second
// deadline around the served handler (the boot proxy of a warm start) holds the delivery to its end as well.
// Times are scaled: the server's deadline (200 ms) stands for the 25 s of CALL_DEADLINE_MS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { createCallDeadline } from '../call-deadline.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const value = result => result?.structuredContent ?? JSON.parse(result.content[0].text);
const DEADLINE = 200;
const studioDeliverSchema = z.object({ feature: z.string().optional(), module: z.string().optional(), job: z.string().optional(), owners: z.array(z.string()).optional(),
  changes: z.array(z.string()).optional(), until: z.string().optional(), publish: z.boolean().optional(), authorize: z.string().optional() }).strict();

async function harness(t, { delay = DEADLINE * 7.2 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-to-end-server-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const counts = new Map();
  const record = async (name, key) => {
    const id = name + ':' + key;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    await sleep(delay);
    return text({ ok: true, result: 'delivered', tool: name, runs: counts.get(id) });
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { answersRoot: root, callDeadlineMs: DEADLINE,
    identity: { read: () => ({ root, release: { head: 'a', facadeSha256: 'a', catalogSha256: 'a' } }) },
    writeLock: async (_, fn) => fn(), lock: { o11Root: root, odcRoot: root, connection: () => null }, odcRoot: root,
    odcFacade: async () => {
      const facade = new McpServer({ name: 'fake-odc', version: '1' });
      facade.registerTool('studio_deliver', { inputSchema: studioDeliverSchema }, args => record('studio_deliver', (args.module ?? args.feature ?? '') + ':' + (args.until ?? 'merge')));
      return facade;
    } } });
  server.registerTool('o11_deliver', { inputSchema: z.object({ module: z.string() }) }, args => record('o11_deliver', args.module));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'runs-to-end-server', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { root, server, client, counts, clientSide, delay };
}
const timed = async call => { const began = performance.now(); const result = await call(); return { result, ms: performance.now() - began }; };

test('O11 and ODC deliveries and a nested ssam_code write answer their final result in one call past the deadline', async t => {
  const { client, counts, delay } = await harness(t);
  const calls = [
    ['o11_deliver', { module: 'Orders' }, 'o11_deliver:Orders'],
    ['studio_deliver', { module: 'Orders', feature: 'Orders' }, 'studio_deliver:Orders:merge'],
    ['ssam_code', { lane: 'odc', action: 'write', part: 'ddl', module: 'Codes', text: 'create entity A (Id Long Integer identifier auto required);' }, 'studio_deliver:Codes:merge'],
  ];
  for (const [name, args, counter] of calls) {
    const { result, ms } = await timed(() => client.callTool({ name, arguments: args }));
    const answer = value(result);
    assert.notEqual(answer.state, 'running', name + ' answered running: ' + JSON.stringify(answer).slice(0, 300));
    assert.equal(answer.ok, true, name + ': ' + JSON.stringify(answer).slice(0, 300));
    assert.ok(ms >= delay - 5, name + ' answered before its work ended');
    assert.equal(counts.get(counter), 1, name + ' ran once');
  }
});

test('a read of the same tool keeps the deadline: running with continueTask, then its final answer', async t => {
  const { client, counts } = await harness(t);
  const first = value(await client.callTool({ name: 'studio_deliver', arguments: { module: 'Orders', feature: 'Orders', until: 'build' } }));
  assert.equal(first.state, 'running');
  assert.equal(first.continuation.tool, 'studio_deliver');
  let final = first;
  while (final.state === 'running') final = value(await client.callTool({ name: 'studio_deliver', arguments: final.continuation.arguments }));
  assert.equal(final.ok, true);
  assert.equal(counts.get('studio_deliver:Orders:build'), 1);
});

test('the real SDK client timeout sends notifications/cancelled; the work goes on and the identical repeat joins it', async t => {
  const { client, counts, clientSide } = await harness(t);
  const sent = [], send = clientSide.send.bind(clientSide);
  clientSide.send = async (message, options) => { sent.push(message); return send(message, options); };
  const args = { module: 'GiveUp' };
  const gaveUp = await client.callTool({ name: 'o11_deliver', arguments: args }, { timeout: DEADLINE * 2.5 }).then(() => null, error => error);
  assert.match(String(gaveUp?.message), /timed out/i);
  assert.ok(sent.some(message => message.method === 'notifications/cancelled'), 'the SDK cancels the request at its own timeout');
  const repeat = value(await client.callTool({ name: 'o11_deliver', arguments: args }));
  assert.equal(repeat.ok, true, JSON.stringify(repeat));
  assert.equal(repeat.joined, true);
  assert.equal(repeat.runs, 1);
  assert.equal(counts.get('o11_deliver:GiveUp'), 1);
});

test('a second deadline around the served handler (the boot proxy of a warm start) holds a delivery to its end', async t => {
  const { root, server, counts, delay } = await harness(t);
  const boot = createCallDeadline({ root: path.join(root, 'boot'), timeoutMs: DEADLINE });
  const proxied = boot.wrap('o11_deliver', (args, ctx) => server.ssamHandlers.get('o11_deliver')(args, ctx));
  const { result, ms } = await timed(() => proxied({ module: 'Warm' }, { mcpReq: { signal: new AbortController().signal } }));
  assert.equal(value(result).state, undefined, JSON.stringify(value(result)).slice(0, 300));
  assert.equal(value(result).ok, true);
  assert.ok(ms >= delay - 5);
  assert.equal(counts.get('o11_deliver:Warm'), 1);
});
