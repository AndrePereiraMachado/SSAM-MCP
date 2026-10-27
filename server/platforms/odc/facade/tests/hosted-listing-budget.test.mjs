// servidor/fase4-27 a11: the hosted listing the release rehearsal measures ("Hosted listing must not grow"), as this line's
// own test. The rehearsal reads tools/list of the hosted server and sums each tool as B2 does (context-budget-listing.test.mjs
// toolListingBytes), the friction tool included; the fixed core is the same fifteen tools. Measured this way, the a10 server
// line (5dc9ec51) gives 261109 / 33890 B, the numbers its rehearsal printed. Ceilings of the rehearsal for a11: 261330 B in
// all and 34097 B for the core. a11 (the product's release sentence again, shorter hosted network texts): 261127 / 34057 B.
// A fake context, executor and agent; no hub, kernel or Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { runWithExecutor, prepareWorkspace } from '../executor.mjs';
import { createSsamServer } from '../ssam.mjs';
import { serverRoots } from '../hosted/policy.mjs';
import { toolListingBytes } from '../tool-listing.mjs';
import { frictionTool } from '../../../../facade/friction-boundary.mjs';

const HOSTED_LISTING_CEILING = 261330;
const HOSTED_CORE_CEILING = 34097;
const CORE = ['ssam_doctor', 'ssam_connect', 'ssam_discover', 'ssam_map', 'ssam_code', 'ssam_reference', 'ssam_evidence', 'ssam_task', 'o11_inspect',
  'o11_deliver', 'o11_publish', 'o11_studio', 'studio_deliver', 'studio_inspect', 'studio_status'];

test('the hosted listing holds the release rehearsal\'s ceilings: all tools with the friction tool, and the fixed core', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-listing-budget-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const workspace = path.join(tmp, 'customers', 'tok_listing');
  prepareWorkspace(workspace);
  const executor = { id: 'fake-executor', hosted: true, workspace, relayPort: () => 41997, o11Connection: () => null, close: async () => {},
    call: async () => ({ processes: [] }), quota: { full: () => false } };
  const agent = { connected: () => true, protocolError() {}, info: () => ({ connected: true, credential: true, agentVersion: '0.3.1', agentRoot: path.join(tmp, 'agent'),
    kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' }, compatible: { odc: { ok: true }, o11: { ok: true } } }) };
  const context = { id: randomUUID(), hosted: true, tokenId: 'tok_listing', customer: 'Test', lanes: ['odc', 'o11'], workspace, agent, executor, close: async () => {} };
  const server = await runWithExecutor(context, () => createSsamServer({ hosted: { context, session: { agent, lanes: context.lanes },
    presentation: { workspace, serverRoots: serverRoots({ tmp: '' }) } } }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-listing-budget', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  const listed = tools.some(tool => tool.name === frictionTool.name) ? tools : [...tools, frictionTool];
  const total = listed.reduce((sum, tool) => sum + toolListingBytes(tool), 0);
  const core = CORE.reduce((sum, name) => { const tool = tools.find(x => x.name === name); assert.ok(tool, name + ' is listed'); return sum + toolListingBytes(tool); }, 0);
  assert.ok(total <= HOSTED_LISTING_CEILING, `hosted listing ${total} B > ${HOSTED_LISTING_CEILING} B`);
  assert.ok(core <= HOSTED_CORE_CEILING, `hosted core ${core} B > ${HOSTED_CORE_CEILING} B`);
  // The hosted network check stays in the listing: its parameter and its sentence (the line's own rule).
  const doctor = tools.find(x => x.name === 'ssam_doctor');
  assert.equal(doctor.inputSchema.properties.network?.type, 'boolean');
  assert.match(doctor.inputSchema.properties.network.description, /^Hosted only: /);
  assert.match(doctor.description, /Hosted: network:true tests agent uploads per internet exit \(about 5 s\)\./);
  assert.match(doctor.description, /release frees a reservation\./);
});
