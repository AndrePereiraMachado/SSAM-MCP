import './fixtures/isolated-profile.mjs';
// CX15 r3, CT-9 (review cx15-2): an ODC-only ssam server (createSsamServer {o11:false}) did not serve ssam_task (the
// O11 cycle registers it), yet the destructive tools it serves (o11_service_center_write, which registerO11Operations
// registers on every server, studio_data_delete, studio_command and the odc_* tools) send the model to ssam_task after an
// interruption, CANCELLED or a local failure: the one read of the record did not exist. Now every server serves it; without
// the O11 lane it reads (tasks and destructive records) and its close answers CLOSE_UNAVAILABLE. Through an MCP client,
// offline: the in-process ODC facade (no Studio, no tool call but ssam_task), synthetic records in the isolated profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { beginOperation, createPreview, endOperation, markItem, readPreview } from '../destructive-operations.mjs';

const HOST = 'personal-0000test.outsystemscloud.com';
const T0 = Date.parse('2026-10-15T12:00:00Z');
let ids = 0;
const uuid = () => `00000000-0000-4000-9000-${String(++ids).padStart(12, '0')}`;

async function connected(lanes) {
  const server = await createSsamServer({ ...lanes, deps: {} });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15-r3-ct9', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const tools = (await client.listTools()).tools;
  const call = async args => { const r = await client.callTool({ name: 'ssam_task', arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  return { tools, call, close: async () => { await client.close(); await server.close(); } };
}

// A finished ODC delete (A deleted, B uncertain) and a preview with no execution, in the default destructive root (the
// isolated profile's).
function records() {
  const block = createPreview({ tool: 'odc_asset_delete', lane: 'odc', host: HOST, operation: 'asset-delete', uuid,
    items: [{ kind: 'asset', key: 'k-a', name: 'ZZSynth App A' }, { kind: 'asset', key: 'k-b', name: 'ZZSynth App B' }], now: T0 });
  const record = beginOperation({ preview: readPreview(block.previewId), now: T0 + 6000 });
  markItem(record, record.items[0], { state: 'deleted' }, { now: T0 + 7000 });
  markItem(record, record.items[1], { state: 'uncertain' }, { now: T0 + 8000 });
  endOperation(record, 'uncertain', { now: T0 + 9000 });
  const pending = createPreview({ tool: 'studio_data_delete', lane: 'odc', host: HOST, operation: 'data-delete', uuid,
    items: [{ kind: 'record', key: '1', name: 'ZZSynthEnt 1' }], now: T0 + 10000 });
  return { block, pending };
}

test('CT-9: an ODC-only server serves ssam_task, and every tool that sends the model to it is served beside it', async () => {
  const s = await connected({ o11: false, odc: true });
  try {
    const names = new Set(s.tools.map(t => t.name));
    assert.ok(names.has('ssam_task'), 'ssam_task is served without the O11 lane');
    const pointing = s.tools.filter(t => /ssam_task/.test(`${t.description ?? ''} ${JSON.stringify(t.inputSchema ?? {})}`)).map(t => t.name).filter(n => n !== 'ssam_task');
    for (const name of ['o11_service_center_write', 'studio_data_delete', 'studio_command', 'odc_asset_delete', 'odc_write', 'odc_portal_write', 'odc_deploy'])
      assert.ok(pointing.includes(name), `${name} names ssam_task (${pointing.join(', ')})`);
    assert.equal(s.tools.filter(t => t.name === 'ssam_task').length, 1);
    assert.match(s.tools.find(t => t.name === 'ssam_task').description, /Destructive operations/);
  } finally { await s.close(); }
});

test('CT-9: on the ODC-only server ssam_task reads the destructive records (list, by operationId, by previewId, a preview not executed); close is unavailable', async () => {
  const { block, pending } = records();
  const s = await connected({ o11: false, odc: true });
  try {
    const list = await s.call({});
    assert.equal(list.ok, true, JSON.stringify(list).slice(0, 300));
    const listed = list.destructive.find(o => o.operationId === block.operationId);
    assert.ok(listed, JSON.stringify(list.destructive).slice(0, 300));
    assert.deepEqual([listed.state, listed.deleted, listed.uncertain], ['uncertain', ['ZZSynth App A'], ['ZZSynth App B']]);
    const byOperation = await s.call({ id: block.operationId });
    assert.deepEqual(byOperation.destructiveOperation.items.map(i => [i.name, i.state]), [['ZZSynth App A', 'deleted'], ['ZZSynth App B', 'uncertain']]);
    assert.deepEqual((await s.call({ id: block.previewId })).destructiveOperation.items, byOperation.destructiveOperation.items);
    const previewed = (await s.call({ id: pending.operationId })).destructiveOperation;
    assert.equal(previewed.state, 'previewed');
    assert.deepEqual(previewed.items.map(i => [i.name, i.state]), [['ZZSynthEnt 1', 'not-started']]);
    const close = await s.call({ id: 'a'.repeat(32), close: { reason: 'synthetic' } });
    assert.equal(close.code, 'CLOSE_UNAVAILABLE');
  } finally { await s.close(); }
});

test('CT-9: a server with neither lane serves ssam_task too; with the O11 lane it is registered once (the cycle\'s, with the close)', async () => {
  const none = await connected({ o11: false, odc: false });
  try { assert.ok(none.tools.some(t => t.name === 'ssam_task')); }
  finally { await none.close(); }
  const both = await connected({ o11: true, odc: true });
  try {
    assert.equal(both.tools.filter(t => t.name === 'ssam_task').length, 1);
  } finally { await both.close(); }
});
