// Fake `ssam` entry for debug-surface-proof tests: `mcp` and `debug <runtime> --stdio --lane <lane>`
// over the deterministic fake coordinator. The CLI framing and EOF ownership are the real ones.
import { createFakeCoordinator, createFakeMcpServer } from './debug-surface-proof-coordinator.mjs';

const options = JSON.parse(process.env.SSAM_SURFACE_PROOF_FAKE ?? '{}');
const [verb, ...rest] = process.argv.slice(2);
const coordinator = runtime => createFakeCoordinator({ ...options, runtime, root: process.cwd() });
if (verb === 'mcp') {
  const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
  const server = await createFakeMcpServer({ coordinators: { server: coordinator('server'), client: coordinator('client') },
    tools: { odc_configurations: async () => ({ ok: true }), odc_read: async () => ({ ok: true }) } });
  await server.connect(new StdioServerTransport());
} else if (verb === 'debug' && rest.length === 4 && rest[1] === '--stdio' && rest[2] === '--lane') {
  const { runInspectionCli } = await import('../../debug-inspection-cli.mjs');
  await runInspectionCli({ runtime: rest[0], lane: rest[3], handler: coordinator(rest[0]).handler, cleanupMs: 3000 });
} else { process.stderr.write('fake ssam: unsupported arguments\n'); process.exitCode = 2; }
