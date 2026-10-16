import './fixtures/isolated-profile.mjs';
// CX15 r3 (CT-9, the family): the ODC facade server alone (`odc mcp`, createFacadeServer) serves ssam_task too: its
// destructive tools (studio_data_delete, studio_command) send the model there after an interruption, CANCELLED or a local
// failure. Read-only there (no delivery close). The ssam server, which relays the facade, keeps ONE ssam_task (its own).
// Offline: a fake Studio data service, synthetic records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createFacadeServer } from '../mcp.mjs';
import { createSsamServer } from '../ssam.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const T0 = Date.parse('2026-10-15T12:00:00Z');
const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);
async function connect(server) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r3-facade-task', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('CT-9 (odc mcp): the ODC facade serves ssam_task, which reads the preview its studio_data_delete made', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r3-facade-task-'));
  const studioData = async ({ op }) => (op === 'read' ? { ok: true, tenant: 'odc-dev.example.test', module: 'Orders', entity: 'Customer', records: [{ Id: '1', Name: 'A' }], more: false } : { ok: true });
  const { client, close } = await connect(await createFacadeServer({ deps: { studioData, destructive: { now: () => T0, root } } }));
  try {
    const tools = (await client.listTools()).tools.map(t => t.name);
    assert.ok(tools.includes('ssam_task'), 'the facade lists ssam_task');
    const preview = valueOf(await client.callTool({ name: 'studio_data_delete', arguments: { module: 'Orders', entity: 'Customer', ids: ['1'] } }));
    assert.equal(preview.state, 'previewed');
    const read = valueOf(await client.callTool({ name: 'ssam_task', arguments: { id: preview.operationId } }));
    assert.deepEqual([read.ok, read.destructiveOperation?.state, read.destructiveOperation?.operationId], [true, 'previewed', preview.operationId]);
    const listed = valueOf(await client.callTool({ name: 'ssam_task', arguments: {} }));
    assert.equal(listed.ok, true);
    const closed = valueOf(await client.callTool({ name: 'ssam_task', arguments: { id: preview.operationId, close: { reason: 'synthetic' } } }));
    assert.equal(closed.ok, false, 'no delivery close on the facade');
  } finally { await close(); }
});

test('CT-9: the ssam server that relays the ODC facade keeps one ssam_task, its own', async () => {
  for (const lanes of [{ o11: false, odc: true }, { o11: true, odc: true }]) {
    const { client, close } = await connect(await createSsamServer({ ...lanes, deps: {} }));
    try {
      const names = (await client.listTools()).tools.map(t => t.name).filter(n => n === 'ssam_task');
      assert.deepEqual(names, ['ssam_task'], JSON.stringify(lanes));
    } finally { await close(); }
  }
});
