import './fixtures/isolated-profile.mjs';
// CX15 r3 (N1, F4.1): the five-word runs of the server's texts are taken without the names of the preview. The owner's
// reply that names the targets in the order of the list ("sim, apaga as 3: ZZSynth Core, ZZSynth Portal, ZZSynth Api")
// was refused as "a text SSAM wrote" (the names in confirmWith form five words in a row), and one item whose name has five
// words or more could never be confirmed. Now: three names of two words, five names of one word and one name of five
// words or more confirm in the O11 (Service Center engine), data (studio_data_delete) and ODC (odc_asset_delete) lanes;
// next, confirmWith and the neutral template copied as the words are still refused. Fakes only, synthetic names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { serviceCenterTool } from '../service-center/index.mjs';
import { studioDataDelete } from '../data-delete-gate.mjs';
import { registerAccessTools } from '../odc-access.mjs';
import { wrap } from '../mcp.mjs';
import { guardedAccess } from '../../portal/runtime/destructive-preview.mjs';
import { CONFIRM_MIN_AGE_MS, OWNER_REPLY } from '../destructive-operations.mjs';
import { HOST, deps as worldDeps, initServer, serverLeft } from './fixtures/destructive-r2-world.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const T0 = Date.parse('2026-10-15T12:00:00Z');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const LISTS = {
  'three names of two words': ['ZZSynth Core', 'ZZSynth Portal', 'ZZSynth Api'],
  'five names of one word': ['ZZAlpha', 'ZZBravo', 'ZZCharlie', 'ZZDelta', 'ZZEcho'],
  'one name of six words': ['ZZSynth Big Shared Widgets Reporting Library'],
};
const replyFor = names => `sim, pode apagar ${names.length === 1 ? 'o' : 'os'} ${names.length}: ${names.join(', ')}`;
// The Service Center engine answers {result:{code, problems}}; the other lanes {code, problems}.
const codes = answer => { const v = answer?.result ?? answer; return [v?.code, ...(v?.problems ?? []).map(p => (typeof p === 'string' ? p : p.code))].filter(Boolean); };

test('N1 (O11, Service Center engine): the owner\'s reply naming the apps in the order of the list confirms; next, confirmWith and the template copied do not', async () => {
  for (const [shape, names] of Object.entries(LISTS)) {
    const dir = tmp('cx15r3-n1-o11-'); const serverFile = path.join(dir, 'server.json');
    initServer(serverFile, names);
    let t = T0; const clock = () => t;
    const D = worldDeps({ dir, serverFile, who: 'A', clock });
    // The applications by name (the reviewer's S8): the words must name each of them (mustName = the names).
    const preview = (await serviceCenterTool(['delete', ...names.map(n => '--target=application:' + n), '--host=' + HOST], D)).result;
    assert.deepEqual(preview.mustName, names, shape);
    assert.equal(preview.count, names.length, shape + ' ' + JSON.stringify(preview).slice(0, 200));
    t += CONFIRM_MIN_AGE_MS + 1000;
    for (const copied of [preview.next, preview.confirmWith, OWNER_REPLY]) {
      const refused = await serviceCenterTool(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=' + copied, '--host=' + HOST], D);
      assert.equal(refused.ok, false, shape + ': a copied server text never confirms');
      assert.ok(codes(refused).includes('WORDS_BEFORE_PREVIEW'), shape + ' ' + JSON.stringify(codes(refused)));
      t += 1000;
    }
    assert.deepEqual(serverLeft(serverFile), names, shape + ': nothing deleted by a copied text');
    const done = await serviceCenterTool(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=' + replyFor(names), '--host=' + HOST], D);
    assert.equal(done.ok, true, shape + ' ' + JSON.stringify({ code: done.code, problems: codes(done) }));
    assert.deepEqual(serverLeft(serverFile), [], shape);
  }
});

test('N1 (data, studio_data_delete): the owner\'s reply naming the records in the order of the list confirms; next and confirmWith copied do not', async () => {
  for (const count of [3, 5]) {
    const root = tmp('cx15r3-n1-data-'); let now = T0;
    const table = new Map(Array.from({ length: count }, (_, i) => [String(i + 1), { Id: String(i + 1), Name: 'Customer ' + (i + 1) }]));
    const deletes = [];
    const studioData = async ({ op, ids }) => (op === 'read' ? { ok: true, tenant: 'odc-dev.example.test', module: 'Orders', entity: 'Customer', records: [...table.values()], more: false }
      : (deletes.push(ids), ids.forEach(id => table.delete(String(id))), { ok: true, reports: ids.map(id => ({ recordId: String(id), status: 'Success', error: null })) }));
    const deps = { studioData, now: () => now, root };
    const ids = [...table.keys()];
    const preview = await studioDataDelete({ module: 'Orders', entity: 'Customer', ids }, deps);
    now += CONFIRM_MIN_AGE_MS + 1000;
    for (const copied of [preview.continuation.why, preview.confirmWith]) {
      const refused = await studioDataDelete({ module: 'Orders', entity: 'Customer', confirmationToken: preview.confirmationToken, authorize: copied }, deps);
      assert.equal(refused.ok, false); now += 1000;
    }
    const names = ids.map(id => 'Customer ' + id);
    const done = await studioDataDelete({ module: 'Orders', entity: 'Customer', confirmationToken: preview.confirmationToken, authorize: replyFor(names) }, deps);
    assert.equal(done.ok, true, count + ' ' + JSON.stringify({ code: done.code, problems: codes(done) }));
    assert.deepEqual(deletes, [ids]);
  }
});

test('N1 (ODC, odc_asset_delete): the owner\'s reply naming an asset of six words confirms; confirmWith copied does not', async () => {
  const name = LISTS['one name of six words'][0];
  const ASSET = '7d1c4f2a-0b6e-4c55-9a51-2f6b8d9e1a11';
  const ASSET_GET = 'asset-repository-api-v1:get:/assets/{assetKey}';
  const dir = tmp('cx15r3-n1-odc-'); const root = path.join(dir, 'destructive');
  const PERSONAL = 'personal-r3words.outsystems.dev';
  let now = T0; const sends = [];
  const access = {
    pickTenant: async tenant => tenant ?? PERSONAL,
    tenantInfo: host => ({ host, known: true, class: 'personal', readOnly: false, label: null }),
    resolvePublic: async (host, auth) => ({ path: auth === 'api-client' ? 'vault' : 'studio', host }),
    apiClientAvailable: async () => false,
    dependentsOf: async () => ({ ok: true, name, consumers: [], checkedEnvironments: ['dev'], includesPublishingDefault: true }),
    read: async ({ operationId, path: p = {} }) => (operationId === ASSET_GET && p.assetKey === ASSET ? { ok: true, status: 200, data: { assetKey: ASSET, name, revision: 2, assetType: 'Library' } } : { ok: false, status: 404 }),
    receipts: { lookup: () => null },
    assetDelete: async input => { sends.push(input.assetKey); return { ok: true, receipt: { operationUuid: input.operationUuid, state: 'confirmed' }, readBack: { gone: true } }; },
  };
  const server = new McpServer({ name: 'cx15r3-n1-odc', version: '1.0.0' });
  registerAccessTools(server, guardedAccess(access, { now: () => now, root }), wrap);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const callTool = async args => { const reply = await client.callTool({ name: 'odc_asset_delete', arguments: args }); return reply.structuredContent ?? JSON.parse(reply.content[0].text); };
  try {
    const preview = await callTool({ tenant: PERSONAL, assetKey: ASSET });
    assert.equal(preview.count, 1, JSON.stringify(preview).slice(0, 300));
    now += CONFIRM_MIN_AGE_MS + 1000;
    const confirm = words => callTool({ tenant: PERSONAL, assetKey: ASSET, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize: words });
    const copied = await confirm(preview.confirmWith);
    assert.ok(codes(copied).includes('WORDS_BEFORE_PREVIEW'), JSON.stringify(codes(copied)));
    now += 1000;
    const done = await confirm(replyFor([name]));
    assert.notEqual(done.ok, false, JSON.stringify({ code: done.code, problems: codes(done) }));
    assert.deepEqual(sends, [ASSET]);
  } finally { await client.close(); await server.close(); }
});
