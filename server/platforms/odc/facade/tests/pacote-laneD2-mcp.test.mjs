// Pacote D2: the live names of the ODC delivery (section 5 of docs/PACOTE-SESSOES-NOVO.md) as the facade serves them.
// studio_deliver takes publish and authorize (presence modes, "Alone:" in their schema text, routed by lane E); its text
// says it publishes on request and no longer "Never publishes"; studio_status says it answers from the evidence while the
// bridge is busy; studio_publish says it uses the standing grant. Real stdio server, offline: no Studio, vault or tenant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { wrap, progressNotifier } from '../mcp.mjs';

// I7 (D2 side): a long studio_* call honours the client's cancellation and answers at once; the bridge command it started
// keeps running. A delivery reports its stages as progress notifications when the request carries a progressToken.
test('a cancelled call answers CANCELLED with outcome uncertain at once; a delivery sends its stages as progress', async () => {
  const controller = new AbortController();
  let release; const slow = new Promise(resolve => { release = resolve; });
  const pending = wrap(async () => { await slow; return { ok: true }; })({}, { mcpReq: { signal: controller.signal } });
  controller.abort();
  const answer = await pending;
  assert.equal(answer.isError, true);
  assert.equal(answer.structuredContent.code, 'CANCELLED'); assert.equal(answer.structuredContent.outcome, 'uncertain');
  release();
  let ran = false; const before = new AbortController(); before.abort();
  await wrap(async () => { ran = true; return { ok: true }; })({}, { mcpReq: { signal: before.signal } });
  assert.equal(ran, false, 'a call cancelled before it starts sends nothing');
  assert.equal((await wrap(async () => ({ ok: true, x: 1 }))({})).structuredContent.x, 1);
  assert.equal((await wrap(async () => ({ ok: true, y: 2 }))({}, { mcpReq: { signal: new AbortController().signal } })).structuredContent.y, 2);
  const sent = [];
  const notify = progressNotifier({ mcpReq: { _meta: { progressToken: 't1' }, notify: async n => { sent.push(n); } } });
  notify('merge'); notify('publish');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.map(n => [n.method, n.params.progressToken, n.params.progress, n.params.message]),
    [['notifications/progress', 't1', 1, 'studio_deliver: merge'], ['notifications/progress', 't1', 2, 'studio_deliver: publish']]);
  assert.equal(progressNotifier({ mcpReq: { notify: async () => {} } }), undefined);
});

test('studio_deliver serves publish and authorize; status and publish describe the new behavior', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../mcp.mjs', import.meta.url))],
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', SSAM_ODC_OFFLINE: '1' }, stderr: 'pipe' });
  const client = new Client({ name: 'pacote-laneD2-mcp', version: '1.0.0' });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools;
    const deliver = tools.find(t => t.name === 'studio_deliver');
    assert.equal(deliver.inputSchema.properties.publish.type, 'boolean');
    assert.equal(deliver.inputSchema.properties.authorize.type, 'string');
    for (const field of ['publish', 'authorize']) {
      assert.match(deliver.inputSchema.properties[field].description, /\bAlone:/, field + ' is marked as a presence mode');
      assert.match(deliver.description, new RegExp('\\b' + field + '\\b'), field + ' is described');
    }
    assert.ok(!(deliver.inputSchema.required ?? []).includes('publish'));
    assert.doesNotMatch(deliver.description, /Never publishes/);
    assert.match(deliver.description, /publish:true publishes in the same call after a clean merge/);
    assert.match(deliver.description, /PUBLISH_FAILED/);
    assert.match(tools.find(t => t.name === 'studio_status').description, /fromEvidence:true/);
    assert.match(tools.find(t => t.name === 'studio_publish').description, /standing grant/);
    assert.match(client.getInstructions(), /publish:true/);
  } finally { await client.close(); }
});
