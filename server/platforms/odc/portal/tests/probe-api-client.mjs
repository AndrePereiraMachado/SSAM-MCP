import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Explicit operator smoke test. It performs one low-impact public read and
// deliberately prints no tenant response data, credentials or token material.
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../runtime/odc3-host.mjs', import.meta.url))],
  env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '',
    ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}),
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
  }, stderr: 'pipe',
});
const client = new Client({ name: 'odc3-api-client-operator-probe', version: '1.0.0' });
try {
  await client.connect(transport);
  const before = await client.callTool({ name: 'odc_status', arguments: {} });
  const configured = before.structuredContent?.auth?.configured === true;
  if (!configured) throw new Error('API client is not configured.');
  const read = await client.callTool({ name: 'odc_read', arguments: {
    operationId: 'portfolio-api-v2:get:/environments', query: {},
  } });
  const output = read.structuredContent ?? {};
  const after = await client.callTool({ name: 'odc_status', arguments: {} });
  const summary = { ok: output.ok === true, authConfigured: configured,
    operationId: 'portfolio-api-v2:get:/environments', httpStatus: output.status ?? null,
    accessVerified: after.structuredContent?.auth?.accessVerified === true,
    ...(output.ok === false ? { errorCode: output.error?.code ?? 'API_READ_FAILED' } : {}),
    credentialValuesExposed: false, tenantResponseDataExposed: false };
  console.log(JSON.stringify(summary));
  if (!summary.ok) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ ok: false, errorCode: 'ODC3_API_CLIENT_PROBE_FAILED',
    credentialValuesExposed: false, tenantResponseDataExposed: false }));
  process.exitCode = 1;
} finally { await client.close(); }
