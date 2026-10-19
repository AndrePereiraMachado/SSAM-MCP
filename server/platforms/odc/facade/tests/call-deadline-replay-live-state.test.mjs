import './fixtures/isolated-profile.mjs';
// Round 3b (Integradora, 2026-10-18): where the content cannot be checked, no replay and no blind join.
// (1) A publication, a refresh or a deployment (a package too) works on what the Studio or the tenant holds at that moment:
//     the module open in the Studio, the revision or the settings of an app. No print covers it (the person edits in the
//     Studio; the tenant changes), so its final answer is never kept for a replay, neither the round 2 replay nor the CX12
//     answer of a cancelled call: an identical call joins it only while it runs, and after its end it runs again. A delivery
//     (its job is its content) and a creation keep their replay.
// Times are scaled: the server's deadline (200 ms) stands for the 25 s of CALL_DEADLINE_MS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import * as classification from '../tool-classification.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const value = result => result?.structuredContent ?? JSON.parse(result.content[0].text);
const DEADLINE = 200, KEPT = 600;
const sandbox = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-live-state-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

// The ssam server with synthetic tools; `state` stands for what the Studio and the tenant hold, changed outside the MCP.
async function server(t, state) {
  const srv = await createSsamServer({ o11: false, odc: false, deps: { answersRoot: sandbox(t), callDeadlineMs: DEADLINE,
    identity: { read: () => ({ root: os.tmpdir(), release: { head: 'a', facadeSha256: 'a', catalogSha256: 'a' } }) }, writeLock: async (_, fn) => fn() } });
  const runs = [];
  const work = (name, read) => async args => { const seen = read(args); await sleep(KEPT); runs.push([name, seen]); return reply({ ok: true, result: name === 'o11_deliver' ? 'delivered' : 'published', seen }); };
  srv.registerTool('o11_publish', { inputSchema: z.object({ module: z.string() }).strict() }, work('o11_publish', args => state.studio[args.module]));
  srv.registerTool('odc_deploy', { inputSchema: z.object({ assetKey: z.string(), environmentKey: z.string(), operation: z.string().optional() }).strict() }, work('odc_deploy', args => state.tenant[args.assetKey]));
  srv.registerTool('o11_deliver', { inputSchema: z.object({ module: z.string() }).strict() }, work('o11_deliver', args => state.studio[args.module]));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'replay-live-state', version: '1' });
  await Promise.all([srv.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await srv.close(); });
  return { client, runs, call: (name, args, options) => client.callTool({ name, arguments: args }, options).then(value) };
}

test('(1) the family that reads the live Studio or tenant: publications, refreshes, deployments and packages keep no replay', () => {
  assert.equal(typeof classification.keepsReplay, 'function');
  const none = [['o11_publish', { module: 'Orders' }], ['studio_publish', { module: 'Orders' }], ['studio_refresh_references', { module: 'Orders' }],
    ['o11_studio', { command: 'refresh-references', args: { module: 'Orders' } }], ['o11_environment', { action: 'refresh-refs' }],
    ['o11_environment', { action: 'set-user-provider' }], ['odc_deploy', { assetKey: 'a', environmentKey: 'e', operation: 'ApplyConfigs' }],
    ['odc_write', { operationId: 'build-operations-api-v1:post:/build-operations' }], ['o11_service_center_write', { action: 'apply-settings', execute: true }],
    ['ssam_debug_run', { op: 'run' }], ['odc_external_library', { action: 'deploy' }]];
  const kept = [['o11_deliver', { module: 'Orders', job: 'C:/synthetic/job.json' }], ['o11_deliver', { module: 'Orders', publish: true }],
    ['studio_deliver', { module: 'Orders' }], ['studio_merge', { manifest: 'C:/synthetic/manifest.json' }], ['studio_create_app', { action: 'create', kind: 'Reactive', name: 'Synthetic' }],
    ['o11_environment', { action: 'create-app' }], ['o11_access', { action: 'apply' }], ['continue', {}]];
  for (const [name, args] of none) { assert.equal(classification.runsToEnd(name, args), true, name); assert.equal(classification.keepsReplay(name, args), false, 'none: ' + name + ' ' + JSON.stringify(args)); }
  for (const [name, args] of kept) assert.equal(classification.keepsReplay(name, args), true, 'kept: ' + name + ' ' + JSON.stringify(args));
});

test('(1) edit in the Studio, then "publish again" within 10 minutes: it publishes, with the edit; a deployment after a tenant change runs again', async t => {
  const state = { studio: { Orders: 'v1' }, tenant: { app: 'revision 1' } };
  const h = await server(t, state);
  assert.equal((await h.call('o11_publish', { module: 'Orders' })).seen, 'v1');
  state.studio.Orders = 'v2'; // the person edits the open module in the Studio, outside the MCP
  const again = await h.call('o11_publish', { module: 'Orders' });
  assert.equal(again.seen, 'v2', JSON.stringify(again)); assert.equal(again.resumedFrom, undefined);
  const apply = { assetKey: 'app', environmentKey: 'stage', operation: 'ApplyConfigs' };
  await h.call('odc_deploy', apply);
  state.tenant.app = 'revision 2'; // the tenant changed (a publication in the Portal)
  const redeployed = await h.call('odc_deploy', apply);
  assert.equal(redeployed.seen, 'revision 2'); assert.equal(redeployed.resumedFrom, undefined);
  assert.deepEqual(h.runs.map(([name]) => name), ['o11_publish', 'o11_publish', 'odc_deploy', 'odc_deploy']);
});

test('(1) a publication is joined while it runs; after its end, also after a cancellation past the deadline, the repeat runs again', async t => {
  const state = { studio: { Live: 'v1', Cancelled: 'v1' } };
  const h = await server(t, state);
  const first = h.call('o11_publish', { module: 'Live' });
  await sleep(DEADLINE * 1.5);
  const joined = await h.call('o11_publish', { module: 'Live' });
  await first;
  assert.equal(joined.joined, true, JSON.stringify(joined)); assert.equal(h.runs.length, 1, 'one publication for the live join');
  // Esc past the deadline: the publication goes on; its answer is not kept for the identical call after its end
  const controller = new AbortController();
  const cancelled = h.call('o11_publish', { module: 'Cancelled' }, { signal: controller.signal }).then(() => null, error => error);
  await sleep(DEADLINE * 1.5); controller.abort(); await cancelled;
  await sleep(KEPT); // the publication ends in the server
  state.studio.Cancelled = 'v2';
  const repeat = await h.call('o11_publish', { module: 'Cancelled' });
  assert.equal(repeat.seen, 'v2', JSON.stringify(repeat)); assert.equal(h.runs.filter(([name, seen]) => name === 'o11_publish').length, 3);
  // a delivery keeps its replay (its job is its content): the identical call after its end gets the kept answer
  await h.call('o11_deliver', { module: 'Live' });
  assert.ok((await h.call('o11_deliver', { module: 'Live' })).resumedFrom);
});
