import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createOdc3Server } from '../../runtime/odc3-host.mjs';
import { PortalReadAdapter } from '../../runtime/portal-read.mjs';

const origin = 'https://tenant.example.test';
let authenticationCalls = 0;
const portalRead = new PortalReadAdapter({ target: 'odc3', origin, broker: {
  target: 'odc3', origin,
  readScreenservice: async () => ({ target: 'odc3', origin, body: { data: { EnvironmentList: [] } } }),
} });
const server = await createOdc3Server({ env: {}, contextFactory: async () => ({
  target: 'odc3', origin, portalRead,
  status: () => ({ target: 'odc3', origin, authenticationCalls, authenticated: authenticationCalls > 0 }),
  authenticate: async () => { authenticationCalls++; return { ok: true, target: 'odc3', authenticated: true }; },
}), apiClientCredentialProvider: async () => ({ available: false, target: 'odc3-api-client' }) });
await server.connect(new StdioServerTransport());
