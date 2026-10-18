import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

async function connect(relative, env = {}) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL(relative, import.meta.url))],
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env }, stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'odc-local-test-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, get stderr() { return stderr; } };
}

test('real SDK stdio initialize/list/describe/read works without setup or tenant calls', async () => {
  const connection = await connect('../runtime/server.mjs');
  const { client } = connection;
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(t => t.name).sort(), ['odc_describe_capability', 'odc_describe_operation', 'odc_list_apis', 'odc_portal_capabilities', 'odc_read', 'odc_search_operations', 'odc_status']);
    const status = await client.callTool({ name: 'odc_status', arguments: {} });
    assert.equal(status.structuredContent.catalog.operationCount, 163);
    assert.equal(status.structuredContent.auth.configured, false);
    assert.equal(status.structuredContent.portalCapabilities.target, 'odc3');
    assert.equal(status.structuredContent.monitoring.buildAndDeliveryLogs.operationIds.length, 5);
    assert.equal(status.structuredContent.monitoring.runtimeApplicationLogs.backendConnected, false);
    const capabilities = await client.callTool({ name: 'odc_portal_capabilities', arguments: { search: 'logs', limit: 100 } });
    assert.ok(capabilities.structuredContent.total > 0);
    const internal = capabilities.structuredContent.capabilities.find(capability => capability.kind === 'internal');
    assert.ok(internal);
    const capability = await client.callTool({ name: 'odc_describe_capability', arguments: { capabilityId: internal.id } });
    assert.equal(capability.structuredContent.execution.route, 'unavailable');
    assert.equal(capability.structuredContent.execution.liveVerified, false);
    const invalidCapability = await client.callTool({ name: 'odc_describe_capability', arguments: { capabilityId: 'nonexistent' } });
    assert.equal(invalidCapability.isError, true);
    const apis = await client.callTool({ name: 'odc_list_apis', arguments: {} });
    assert.equal(apis.structuredContent.apis.length, 14);
    const search = await client.callTool({ name: 'odc_search_operations', arguments: { apiId: 'asset-repository-api-v1', readOnly: true, limit: 100 } });
    assert.ok(search.structuredContent.total > 0);
    const id = 'asset-repository-api-v1:get:/assets';
    const description = await client.callTool({ name: 'odc_describe_operation', arguments: { operationId: id } });
    assert.equal(description.structuredContent.id, id);
    assert.ok(Object.keys(description.structuredContent.referencedDefinitions).length > 0);
    const read = await client.callTool({ name: 'odc_read', arguments: { operationId: id } });
    assert.equal(read.isError, true);
    assert.equal(read.structuredContent.error.code, 'AUTH_NOT_CONFIGURED');
    assert.equal(connection.stderr, '');
  } finally { await client.close(); }
});

test('real MCP stdio call reaches mock OAuth and mock API; injection rejected at protocol input', async () => {
  const connection = await connect('./fixtures/mock-mcp-server.mjs');
  const { client } = connection;
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'host_ping'));
    assert.ok(tools.tools.some(tool => tool.name === 'odc_portal_capabilities'));
    assert.ok(tools.tools.some(tool => tool.name === 'odc_portal_read'));
    const host = await client.callTool({ name: 'host_ping', arguments: {} });
    assert.equal(host.structuredContent.host, 'existing-host-test');
    const stages = await client.callTool({ name: 'odc_portal_read', arguments: { operationId: 'monitoring.stages' } });
    assert.equal(stages.structuredContent.ok, true);
    assert.equal(stages.structuredContent.rows[0].Name, 'Mock Development');
    const invalidPrivate = await client.callTool({ name: 'odc_portal_read', arguments: {
      operationId: 'monitoring.stages', input: { authorization: 'not-a-real-token' },
    } });
    assert.equal(invalidPrivate.isError, true);
    assert.equal(invalidPrivate.structuredContent.error.code, 'INPUT_INVALID');
    const id = 'asset-repository-api-v1:get:/assets';
    const read = await client.callTool({ name: 'odc_read', arguments: { operationId: id, query: { limit: 1 } } });
    assert.equal(read.structuredContent.ok, true);
    assert.equal(read.structuredContent.data.testOnly, true);
    assert.ok(!JSON.stringify(read).includes('mock-access-token'));
    const invalid = await client.callTool({ name: 'odc_read', arguments: { operationId: id, url: 'https://evil.test' } });
    assert.equal(invalid.isError, true);
    const status = await client.callTool({ name: 'odc_status', arguments: {} });
    assert.equal(status.structuredContent.auth.accessVerified, true);
    assert.equal(status.structuredContent.portalRead.operations.length, 11);
    assert.equal(status.structuredContent.portalRead.liveVerified, false);
    const errorRead = status.structuredContent.portalRead.operations.find(operation => operation.id === 'monitoring.errors');
    assert.deepEqual(errorRead.inputSchema.required, ['environmentKey', 'applicationKey', 'since', 'until']);
    assert.equal(errorRead.inputSchema.additionalProperties, false);
    assert.equal(connection.stderr, '');
  } finally { await client.close(); }
});
