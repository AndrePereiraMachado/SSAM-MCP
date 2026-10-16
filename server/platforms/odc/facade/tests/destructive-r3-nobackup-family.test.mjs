import './fixtures/isolated-profile.mjs';
// CX15 r3 (CT-7, the family): every lane's preview says what goes WITHOUT a backup, in next and confirmWith (from the
// preview itself, createPreview notes) and in the error of CONFIRMATION_REQUIRED, as the Service Center engine does
// (destructive-r3-sc-nobackup). Here: the odc_* guard (an asset whose source cannot be downloaded: no API Client) and the
// data gate (a record a batch insert creates); a preview whose items all have their backup says nothing of it. The note is
// a text of the server: copied as the owner's words it is refused. Fakes only, synthetic names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { cliDataDelete, studioDataDelete } from '../data-delete-gate.mjs';
import { registerAccessTools } from '../odc-access.mjs';
import { wrap } from '../mcp.mjs';
import { guardedAccess } from '../../portal/runtime/destructive-preview.mjs';
import { CONFIRM_MIN_AGE_MS } from '../destructive-operations.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const T0 = Date.parse('2026-10-15T12:00:00Z');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const WITHOUT = /1 item will be deleted WITHOUT a backup \([^)]+\): tell the owner\./;
const codes = answer => [answer?.code, ...(answer?.problems ?? []).map(p => p.code)].filter(Boolean);

test('CT-7 family (odc_asset_delete): an asset without its backup is said in next, confirmWith and the error; the note copied never confirms', async () => {
  const ASSET = '7d1c4f2a-0b6e-4c55-9a51-2f6b8d9e1a11';
  const ASSET_GET = 'asset-repository-api-v1:get:/assets/{assetKey}';
  const PERSONAL = 'personal-r3nobackup.outsystems.dev';
  const root = path.join(tmp('cx15r3-nobackup-odc-'), 'destructive');
  let now = T0; const sends = [];
  const access = {
    pickTenant: async tenant => tenant ?? PERSONAL,
    tenantInfo: host => ({ host, known: true, class: 'personal', readOnly: false, label: null }),
    resolvePublic: async (host, auth) => ({ path: auth === 'api-client' ? 'vault' : 'studio', host }),
    apiClientAvailable: async () => false, // no API Client: the source cannot be downloaded (backup possible:false)
    dependentsOf: async () => ({ ok: true, name: 'ScratchLib', consumers: [], checkedEnvironments: ['dev'], includesPublishingDefault: true }),
    read: async ({ operationId, path: p = {} }) => (operationId === ASSET_GET && p.assetKey === ASSET ? { ok: true, status: 200, data: { assetKey: ASSET, name: 'ScratchLib', revision: 2, assetType: 'Library' } } : { ok: false, status: 404 }),
    receipts: { lookup: () => null },
    assetDelete: async input => { sends.push(input.assetKey); return { ok: true, receipt: { operationUuid: input.operationUuid, state: 'confirmed' }, readBack: { gone: true } }; },
  };
  const server = new McpServer({ name: 'cx15r3-nobackup', version: '1.0.0' });
  registerAccessTools(server, guardedAccess(access, { now: () => now, root }), wrap);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async args => { const r = await client.callTool({ name: 'odc_asset_delete', arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  try {
    const preview = await call({ tenant: PERSONAL, assetKey: ASSET, authorize: 'apaga a ScratchLib' }); // the incident shape: words in the preview call
    assert.equal(preview.code, 'CONFIRMATION_REQUIRED');
    for (const field of ['next', 'confirmWith', 'error']) assert.match(preview[field], WITHOUT, field + ': ' + preview[field]);
    now += CONFIRM_MIN_AGE_MS + 1000;
    const note = WITHOUT.exec(preview.next)[0];
    const copied = await call({ tenant: PERSONAL, assetKey: ASSET, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize: note });
    assert.ok(codes(copied).includes('WORDS_BEFORE_PREVIEW'), JSON.stringify(codes(copied)));
    assert.deepEqual(sends, []);
  } finally { await client.close(); await server.close(); }
});

test('CT-7 family (o11_data): a record a batch insert creates is said WITHOUT a backup in next, confirmWith and the error', async () => {
  const root = tmp('cx15r3-nobackup-data-'); const cwd = tmp('cx15r3-nobackup-data-cwd-');
  const table = new Map([['1', { Id: '1', Name: 'Customer 1' }]]);
  const send = async argv => {
    const request = JSON.parse(fs.readFileSync(argv[argv.indexOf('--request') + 1], 'utf8'));
    const ops = Array.isArray(request.batch) ? request.batch : [request];
    const results = ops.map(op => (op.operation === 'read' ? { ok: true, operation: 'read', entity: op.entity, records: op.ids.map(String).filter(id => table.has(id)).map(id => table.get(id)) } : { ok: true, operation: op.operation }));
    return { ok: true, lane: 'o11', verb: 'data', exitCode: 0, result: { ok: true, command: 'data', data: { ok: true, host: 'dev.example.test', submitted: results.length, total: results.length, results } } };
  };
  const file = path.join(cwd, 'request.json');
  fs.writeFileSync(file, JSON.stringify({ authorization: 'apaga o cliente novo e o 1', batch: [
    { operation: 'insert', entity: 'Customer', records: [{ Name: 'ZZSynth new' }] },
    { operation: 'delete', entity: 'Customer', ids: ['1', { $ref: '0' }] }] }));
  const preview = await cliDataDelete(['--host', 'dev.example.test', '--module', 'Orders_CS', '--oml', 'C:\\captures\\Orders_CS.oml', '--request', file], { send, cwd, now: T0, root });
  assert.equal(preview.code, 'CONFIRMATION_REQUIRED', JSON.stringify(preview).slice(0, 300));
  for (const field of ['next', 'confirmWith', 'error']) {
    const value = field === 'error' ? preview.error : preview[field] ?? preview.previews?.[0]?.[field];
    assert.match(value, WITHOUT, field + ': ' + value);
  }
});

test('CT-7 family (studio_data_delete): a preview whose records all have their backup says nothing of it', async () => {
  const root = tmp('cx15r3-nobackup-guard-');
  const studioData = async () => ({ ok: true, tenant: 'odc-dev.example.test', module: 'Orders', entity: 'Customer', records: [{ Id: '1', Name: 'A' }, { Id: '2', Name: 'B' }], more: false });
  const preview = await studioDataDelete({ module: 'Orders', entity: 'Customer', ids: ['1', '2'], authorize: 'apaga os dois' }, { studioData, now: T0, root });
  assert.equal(preview.code, 'CONFIRMATION_REQUIRED');
  for (const field of ['next', 'confirmWith', 'error']) assert.doesNotMatch(preview[field], /WITHOUT a backup/, field);
});
