import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';

test('MCP read budget starts before the Studio queue and aborts its wait without entering the handler', async () => {
  let queues = 0, queueSignal, release;
  const server = await createSsamServer({ odc: false, deps: { readTimeoutMs: 10,
    writeLock: ({ signal }) => { queues++; queueSignal = signal; return new Promise(resolve => { release = resolve; }); }
  } });
  const client = new Client({ name: 'sc-queue-offline', version: '1' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const request = { name: 'o11_service_center_session', arguments: { action: 'web-sign-in', host: 'queue.example.test' } };
    const result = (await client.callTool(request)).structuredContent;
    assert.equal(result.code, 'READ_DEADLINE_EXCEEDED', JSON.stringify(result));
    assert.equal(result.stage, 'queue'); assert.equal(queueSignal.aborted, true);
    assert.equal(result.continuation.tool, request.name);
    await client.callTool(request); assert.equal(queues, 1);
    release({ content: [{ type: 'text', text: '{"ok":false,"code":"QUEUE_CANCELLED"}' }], isError: true });
  } finally { await client.close(); await server.close(); }
});
