import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Explicit operator smoke test. It performs initialize/list/status only: no
// authentication, tenant read, browser action, publication or config mutation.
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../runtime/odc3-host.mjs', import.meta.url))],
  env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '',
    ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}),
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
  }, stderr: 'pipe',
});
const client = new Client({ name: 'odc3-entry-operator-probe', version: '1.0.0' });
try {
  await client.connect(transport);
  const list = await client.listTools();
  const result = await client.callTool({ name: 'odc3_session_status', arguments: {} });
  const status = result.structuredContent ?? {};
  const coverage = await client.callTool({ name: 'odc_status', arguments: {} });
  const operations = coverage.structuredContent?.portalRead?.operations?.map(operation => operation.id) ?? [];
  const ok = !result.isError && list.tools.some(tool => tool.name === 'odc_portal_read')
    && list.tools.some(tool => tool.name === 'odc3_authenticate') && !list.tools.some(tool => tool.name === 'odc_write')
    && ['monitoring.logs', 'monitoring.traces', 'monitoring.trace', 'monitoring.traceLogs', 'monitoring.traceSummary'].every(id => operations.includes(id));
  console.log(JSON.stringify({ ok, transport: 'stdio', tools: list.tools.map(tool => tool.name),
    target: status.target === 'odc3' ? 'odc3' : 'not_confirmed',
    origin: typeof status.origin === 'string' && /^https:\/\/[a-z0-9.-]+\/?$/i.test(status.origin) ? status.origin : 'not_reported',
    authenticated: status.authenticated === true, authenticationRequested: false, tenantReadRequested: false,
    implementationRevision: status.implementationRevision, internalOperations: operations,
  }));
  if (!ok) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ ok: false, code: 'ODC3_STDIO_PROBE_FAILED', authenticationRequested: false, tenantReadRequested: false }));
  process.exitCode = 1;
} finally { await client.close(); }
