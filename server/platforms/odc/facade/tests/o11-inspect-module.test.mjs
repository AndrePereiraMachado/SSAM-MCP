import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Cycle } from '../o11-cycle.mjs';

async function harness(deps) {
  const server = new McpServer({ name: 'o11-inspect-module-test', version: '1' });
  registerO11Cycle(server, deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('o11_inspect {module} captures the open module and reads it in the same call, naming the capture for the next reads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-inspect-module-'));
  const oml = path.join(root, 'Quotes-1.oml'); fs.writeFileSync(oml, 'capture');
  const captured = []; const reads = [];
  const { client, close } = await harness({ root, env: { USERPROFILE: root }, tasksDir: path.join(root, 'tasks'), readerCheck: null,
    capture: async module => { captured.push(module); return { ok: true, path: oml, sha256: 'A'.repeat(64) }; },
    read: async (entry, args) => { reads.push(args); return { ok: true, data: { schema: 'ssam-reading/1', path: 'ServerEntity:Quote', tree: { kind: 'ServerEntity', name: 'Quote' } } }; } });
  try {
    const reply = await client.callTool({ name: 'o11_inspect', arguments: { module: 'Quotes', path: 'ServerEntity:Quote' } });
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    const value = JSON.parse(reply.content[0].text);
    assert.deepEqual(captured, ['Quotes']);
    assert.deepEqual(value.capture, { oml, sha256: 'A'.repeat(64), module: 'Quotes' });
    assert.equal(value.tree.name, 'Quote');
    // The read is bound to the capture just taken.
    assert.equal(reads[0][reads[0].indexOf('--oml') + 1], oml);
    assert.equal(reads[0][reads[0].indexOf('--expectedSourceSha256') + 1], 'A'.repeat(64));
  } finally { await close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('o11_inspect takes exactly one of oml or module, and a failed capture comes back as it is', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-inspect-module-'));
  const { client, close } = await harness({ root, env: { USERPROFILE: root }, tasksDir: path.join(root, 'tasks'), readerCheck: null, read: async () => ({ ok: true, data: {} }),
    capture: async () => ({ ok: false, code: 'O11_NOT_CONNECTED', error: 'No O11 bridge answers', continuation: { tool: 'ssam_connect', arguments: { lane: 'o11' } } }) });
  try {
    const none = JSON.parse((await client.callTool({ name: 'o11_inspect', arguments: {} })).content[0].text);
    assert.equal(none.code, 'BAD_ARGS');
    const both = JSON.parse((await client.callTool({ name: 'o11_inspect', arguments: { module: 'Q', oml: path.join(root, 'x.oml') } })).content[0].text);
    assert.equal(both.code, 'BAD_ARGS');
    const refused = await client.callTool({ name: 'o11_inspect', arguments: { module: 'Q' } });
    assert.equal(refused.isError, true); assert.equal(JSON.parse(refused.content[0].text).continuation.tool, 'ssam_connect');
  } finally { await close(); fs.rmSync(root, { recursive: true, force: true }); }
});
