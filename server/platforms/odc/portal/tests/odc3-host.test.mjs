import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createOdc3Server } from '../runtime/odc3-host.mjs';

test('ODC3 entry uses one stdio server and does not authenticate at initialization', async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/mock-odc3-host.mjs', import.meta.url))],
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' }, stderr: 'pipe',
  });
  const client = new Client({ name: 'odc3-entry-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'odc_portal_read'));
    assert.ok(tools.tools.some(tool => tool.name === 'odc3_authenticate'));
    assert.ok(!tools.tools.some(tool => tool.name === 'odc_write'));
    const before = await client.callTool({ name: 'odc3_session_status', arguments: {} });
    assert.equal(before.structuredContent.authenticationCalls, 0);
    assert.equal(before.structuredContent.authenticated, false);
    const injection = await client.callTool({ name: 'odc3_authenticate', arguments: { password: 'not-real' } });
    assert.equal(injection.isError, true);
    const authorized = await client.callTool({ name: 'odc3_authenticate', arguments: {} });
    assert.equal(authorized.structuredContent.ok, true);
    const after = await client.callTool({ name: 'odc3_session_status', arguments: {} });
    assert.equal(after.structuredContent.authenticationCalls, 1);
    const portal = await client.callTool({ name: 'odc_portal_read', arguments: { operationId: 'monitoring.stages' } });
    assert.equal(portal.structuredContent.ok, true);
    const publicStatus = await client.callTool({ name: 'odc_status', arguments: {} });
    assert.equal(publicStatus.structuredContent.auth.configured, false);
    assert.deepEqual(publicStatus.structuredContent.policy.allowedWriteOperations, []);
  } finally { await client.close(); }
});

test('ODC3 entry rejects an unscoped host or insecure tenant without starting a transport', async () => {
  await assert.rejects(createOdc3Server({ env: {}, contextFactory: async () => ({ target: 'ss4' }) }));
  await assert.rejects(createOdc3Server({ env: {}, contextFactory: async () => ({
    target: 'odc3', origin: 'http://tenant.example.test', status() {}, authenticate() {},
  }) }), { code: 'CONFIGURATION_INVALID' });
});
