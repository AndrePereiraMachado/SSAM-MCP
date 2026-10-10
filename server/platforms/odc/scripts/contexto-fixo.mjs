// Fixed context an app session of this checkout pays on every turn (docs/CONTEXTO-FIXO.md): the entry files Claude Code
// loads or the session is told to read, the ssam server instructions and the description + input schema of every served
// tool, in bytes and estimated tokens. In-process server and listTools only: no Studio, no worker, no tool call.
//   node platforms/odc/scripts/contexto-fixo.mjs [--json]
// Tokens are estimated at 2.2 bytes per token, the ratio measured on the sessions of the active folder (a Read or a
// ToolSearch result against the context growth of the next turn).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ANVIL_WORKER ??= '0';
process.env.ANVIL_ODC_NO_WORKER ??= '1';
process.env.SSAM_NO_WARM ??= '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BYTES_PER_TOKEN = 2.2;
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''), 'utf8');
const tokens = n => Math.round(n / BYTES_PER_TOKEN);
// The core tools the instructions load in one ToolSearch select (C39).
const CORE = ['ssam_doctor', 'ssam_connect', 'ssam_discover', 'ssam_map', 'ssam_reference', 'ssam_evidence', 'ssam_task',
  'o11_inspect', 'o11_deliver', 'o11_publish', 'o11_studio', 'studio_deliver', 'studio_inspect', 'studio_status'];

const files = {};
for (const rel of ['CLAUDE.md', 'AGENTS.md', 'COMECE-AQUI.md', 'docs/DESENVOLVIMENTO.md', 'kernel/AGENTS.md', 'kernel/CLAUDE.md',
  'platforms/odc/AGENTS.md', 'platforms/odc/CLAUDE.md']) {
  const file = path.join(root, rel);
  if (fs.existsSync(file)) files[rel] = fs.statSync(file).size;
}

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { createSsamServer } = await import('../facade/ssam.mjs');
const { frictionTool } = await import('../../../facade/friction-boundary.mjs');
const server = await createSsamServer();
const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'contexto-fixo', version: '1' });
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
let instructions, tools;
try {
  instructions = client.getInstructions() ?? '';
  // ssam_friction is added by the stdio launch boundary, as the session sees it.
  tools = [...(await client.listTools()).tools, frictionTool];
} finally { await client.close(); await server.close(); }

// The shape Claude Code records for a loaded deferred tool: name, description, input schema.
const sized = tools.map(t => ({ name: t.name, description: bytes(t.description ?? ''), schema: bytes(t.inputSchema ?? {}),
  total: bytes({ name: 'mcp__ssam__' + t.name, description: t.description ?? '', input_schema: t.inputSchema ?? {} }) }));
const sum = (list, key) => list.reduce((a, t) => a + t[key], 0);
const core = sized.filter(t => CORE.includes(t.name));
const report = {
  bytesPerToken: BYTES_PER_TOKEN,
  files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { bytes: v, tokens: tokens(v) }])),
  instructions: { bytes: bytes(instructions), tokens: tokens(bytes(instructions)) },
  deferredNames: { count: tools.length, bytes: sum(tools.map(t => ({ n: bytes('mcp__ssam__' + t.name) + 1 })), 'n') },
  tools: { count: sized.length, description: sum(sized, 'description'), schema: sum(sized, 'schema'), total: sum(sized, 'total'), tokens: tokens(sum(sized, 'total')) },
  core: { count: core.length, description: sum(core, 'description'), schema: sum(core, 'schema'), total: sum(core, 'total'), tokens: tokens(sum(core, 'total')) },
  perTool: Object.fromEntries(sized.sort((a, b) => b.total - a.total).map(t => [t.name, { description: t.description, schema: t.schema, total: t.total }])),
};
if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify(report, null, 1) + '\n'); process.exit(0); }
const line = (label, b) => console.log(label.padEnd(34) + String(b).padStart(9) + ' B' + String(tokens(b)).padStart(8) + ' tok');
for (const [k, v] of Object.entries(files)) line(k, v);
line('ssam instructions', report.instructions.bytes);
line('deferred names (' + report.deferredNames.count + ')', report.deferredNames.bytes);
line('core tools (' + core.length + ') desc+schema', report.core.total);
line('all tools (' + sized.length + ') desc+schema', report.tools.total);
console.log('descriptions ' + report.tools.description + ' B, input schemas ' + report.tools.schema + ' B');
process.exit(0);
