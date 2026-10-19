// A stdio MCP server for call-deadline-delivery-process.test.mjs: the ssam server (createSsamServer, with its real call
// deadline: no deps.callDeadlineMs, no SSAM_CALL_DEADLINE_MS) plus a synthetic o11_deliver that lasts SSAM_TEST_DELIVERY_MS
// and counts its runs per module. No Studio, no network, no lock: the delivery only waits. Its folders live under
// SSAM_TEST_ROOT (a temporary folder of the test).
import * as z from 'zod/v4';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createSsamServer } from '../../ssam.mjs';

const root = process.env.SSAM_TEST_ROOT;
const delay = Number(process.env.SSAM_TEST_DELIVERY_MS);
if (!root || !Number.isFinite(delay)) throw new Error('SSAM_TEST_ROOT and SSAM_TEST_DELIVERY_MS are required');
const runs = new Map();
const server = await createSsamServer({ o11: false, odc: false, deps: { answersRoot: root,
  identity: { read: () => ({ root, release: { head: 'synthetic', facadeSha256: 'synthetic', catalogSha256: 'synthetic' } }) },
  writeLock: async (_, execute) => execute() } });
server.registerTool('o11_deliver', { inputSchema: z.object({ module: z.string() }) }, async ({ module }) => {
  runs.set(module, (runs.get(module) ?? 0) + 1);
  await new Promise(resolve => setTimeout(resolve, delay));
  const answer = { ok: true, result: 'delivered', module, runs: runs.get(module) };
  return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer };
});
await server.connect(new StdioServerTransport());
