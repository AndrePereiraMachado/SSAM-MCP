import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { registerOdcTools } from '../../runtime/server.mjs';
import { OdcBridge } from '../../runtime/bridge.mjs';
import { PortalReadAdapter } from '../../runtime/portal-read.mjs';
import { mockFetch, testConfig } from '../helpers.mjs';

const mock = mockFetch();
const bridge = new OdcBridge({ config: testConfig(), fetchImpl: mock.fetchImpl });
const origin = 'https://tenant.example.test';
const portalRead = new PortalReadAdapter({ target: 'odc3', origin, broker: {
  target: 'odc3', origin,
  readScreenservice: async () => ({ target: 'odc3', origin, body: { data: {
    EnvironmentList: [{ Environment: { Key: 'mock-stage', Name: 'Mock Development' } }],
  } } }),
} });
const host = new McpServer({ name: 'existing-host-test', version: '1.0.0' });
host.registerTool('host_ping', { inputSchema: z.object({}).strict() }, async () => ({
  content: [{ type: 'text', text: 'existing host' }], structuredContent: { host: 'existing-host-test' },
}));
if (registerOdcTools(host, bridge, { portalRead }) !== host) throw new Error('Registry replaced the existing host');
await host.connect(new StdioServerTransport());
