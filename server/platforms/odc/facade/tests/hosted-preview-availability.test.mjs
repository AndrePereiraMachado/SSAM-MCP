import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createSsamServer } from '../ssam.mjs';
import { prepareWorkspace, runWithExecutor } from '../executor.mjs';
import { wrapHostedTool } from '../hosted/policy.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const previews = /\b(?:ssam_preview|studio_preview)\b/;
function context() {
  const dirs = hostedDirs(os.tmpdir()); prepareWorkspace(dirs.workspace);
  const agent = fakeAgentLink({ agentRoot: dirs.agentRoot });
  const executor = { id: 'preview-test', hosted: true, workspace: dirs.workspace, relayPort: () => 41997,
    o11Connection: () => null, call: async () => ({ processes: [] }), close: async () => {}, quota: { full: () => false } };
  return { id: 'preview-test', tokenId: 'tok_preview', customer: 'Test', hosted: true, lanes: ['odc', 'o11'], workspace: dirs.workspace, agent, executor };
}

test('the hosted listing advertises no local preview tool, including full listings', async t => {
  for (const listing of [undefined, 'full']) {
    const ctx = context();
    const server = await runWithExecutor(ctx, () => createSsamServer({ listing, hosted: { context: ctx, session: { agent: ctx.agent, lanes: ctx.lanes } } }));
    const client = new Client({ name: 'preview-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    t.after(async () => { await client.close(); await server.close(); });
    assert.doesNotMatch(JSON.stringify((await client.listTools()).tools), previews);
  }
});

test('hosted discover and contracts do not advertise local previews', async () => {
  const ctx = context();
  for (const name of ['ssam_discover', 'ssam_reference']) {
    const value = { tools: [{ name: 'ssam_preview' }, { name: 'studio_preview' }, { name: 'ssam_map' }],
      description: 'Read with ssam_map.\nUse ssam_preview for a local view.', contract: { ssam_preview: { tool: 'ssam_preview' } } };
    const handler = wrapHostedTool(name, { inputSchema: {} }, async () => ({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] }),
      { context: ctx, run: (_ctx, fn) => fn() });
    const result = await handler({ lane: 'o11', intent: 'preview', kind: 'tool', query: 'ssam_preview' }, {});
    assert.doesNotMatch(JSON.stringify(result), previews);
    assert.match(JSON.stringify(result), /ssam_map/);
  }
});
