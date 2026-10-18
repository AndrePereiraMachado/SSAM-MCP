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
// The original 15-tool select remains a stable cohort if the live select shrinks.
const STABLE_CORE = ['ssam_doctor', 'ssam_connect', 'ssam_discover', 'ssam_map', 'ssam_code', 'ssam_reference', 'ssam_evidence', 'ssam_task',
  'o11_inspect', 'o11_deliver', 'o11_publish', 'o11_studio', 'studio_deliver', 'studio_inspect', 'studio_status'];
const argv = process.argv.slice(2);
const option = flag => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null;
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function comparison(before, after) {
  const metric = (label, a, b) => `| ${label} | ${a} | ${b} | ${typeof a === 'number' && typeof b === 'number' ? b - a : '—'} |`;
  return ['| Metric | Before | After | Change |', '| --- | ---: | ---: | ---: |',
    metric('ssam instruction chars', before.instructions.chars, after.instructions.chars),
    metric('ODC instruction chars', before.odcInstructions?.chars, after.odcInstructions?.chars),
    metric('tools', before.tools.count, after.tools.count), metric('listing bytes', before.tools.total, after.tools.total),
    metric('select bytes', before.core.total, after.core.total), metric('debug bytes', before.debug?.total, after.debug?.total),
    metric('original select bytes', before.stableCore?.total, after.stableCore?.total),
    metric('over limit', before.tools.over, after.tools.over),
    ...Object.keys({ ...before.perTool, ...after.perTool }).sort().map(name => metric(name, before.perTool[name]?.listing ?? before.perTool[name]?.total ?? '—', after.perTool[name]?.listing ?? after.perTool[name]?.total ?? '—'))].join('\n');
}
if (option('--compare')) {
  const at = argv.indexOf('--compare');
  process.stdout.write(comparison(readJson(argv[at + 1]), readJson(argv[at + 2])) + '\n');
  process.exit(0);
}
const profile = option('--profile') ?? 'app';
if (!['app', 'debug', 'all'].includes(profile)) throw new Error('--profile must be app, debug or all');

const files = {};
for (const rel of ['CLAUDE.md', 'AGENTS.md', 'COMECE-AQUI.md', 'docs/DESENVOLVIMENTO.md', 'kernel/AGENTS.md', 'kernel/CLAUDE.md',
  'platforms/odc/AGENTS.md', 'platforms/odc/CLAUDE.md']) {
  const file = path.join(root, rel);
  if (fs.existsSync(file)) files[rel] = fs.statSync(file).size;
}

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { createSsamServer } = await import('../facade/ssam.mjs');
const { createFacadeServer } = await import('../facade/mcp.mjs');
const { frictionTool } = await import('../../../facade/friction-boundary.mjs');
const server = await createSsamServer({ profile });
const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'contexto-fixo', version: '1' });
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
let instructions, tools;
try {
  instructions = client.getInstructions() ?? '';
  // ssam_friction is added by the stdio launch boundary, as the session sees it.
  tools = [...(await client.listTools()).tools, ...(profile === 'debug' ? [] : [frictionTool])];
} finally { await client.close(); await server.close(); }
const odcServer = await createFacadeServer();
const [odcSide, odcClientSide] = InMemoryTransport.createLinkedPair();
const odcClient = new Client({ name: 'contexto-fixo-odc', version: '1' });
let odcInstructions;
try {
  await Promise.all([odcServer.connect(odcSide), odcClient.connect(odcClientSide)]);
  odcInstructions = odcClient.getInstructions() ?? '';
} finally { await odcClient.close(); await odcServer.close(); }
// Read the actual advertised select: no stale hard-coded list when the instruction changes.
const CORE = [...new Set([...instructions.matchAll(/mcp__ssam__(\w+)/g)].map(m => m[1]))];
// Schema maps contain user-defined property names; an actual property named
// "description" is part of the contract. Defaults, enums and const are data too.
function withoutDescriptions(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const maps = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
  const single = new Set(['additionalProperties', 'unevaluatedProperties', 'items', 'contains', 'propertyNames', 'additionalItems', 'unevaluatedItems', 'not', 'if', 'then', 'else', 'contentSchema']);
  const lists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'description').map(([key, value]) => [key,
    maps.has(key) && value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, withoutDescriptions(child)]))
      : (lists.has(key) || key === 'items') && Array.isArray(value) ? value.map(withoutDescriptions)
        : single.has(key) ? withoutDescriptions(value) : value]));
}

// The shape Claude Code records for a loaded deferred tool: name, description, input schema.
const sized = tools.map(t => {
  const listing = bytes({ name: 'mcp__ssam__' + t.name, description: t.description ?? '', input_schema: t.inputSchema ?? {} });
  const structure = bytes({ name: 'mcp__ssam__' + t.name, description: '', input_schema: withoutDescriptions(t.inputSchema ?? {}) });
  const limit = Math.max(2560, structure + 1024);
  return { name: t.name, description: bytes(t.description ?? ''), schema: bytes(t.inputSchema ?? {}), total: listing, listing, structure, limit, over: Math.max(0, listing - limit) };
});
const sum = (list, key) => list.reduce((a, t) => a + t[key], 0);
const core = sized.filter(t => CORE.includes(t.name));
const stableCore = sized.filter(t => STABLE_CORE.includes(t.name));
const report = {
  profile,
  bytesPerToken: BYTES_PER_TOKEN,
  files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { bytes: v, tokens: tokens(v) }])),
  instructions: { chars: instructions.length, bytes: bytes(instructions), tokens: tokens(bytes(instructions)) },
  odcInstructions: { chars: odcInstructions.length, bytes: bytes(odcInstructions), tokens: tokens(bytes(odcInstructions)) },
  deferredNames: { count: tools.length, bytes: sum(tools.map(t => ({ n: bytes('mcp__ssam__' + t.name) + 1 })), 'n') },
  tools: { count: sized.length, description: sum(sized, 'description'), schema: sum(sized, 'schema'), total: sum(sized, 'total'), tokens: tokens(sum(sized, 'total')), over: sized.filter(t => t.over > 0).length },
  core: { names: CORE, count: core.length, description: sum(core, 'description'), schema: sum(core, 'schema'), total: sum(core, 'total'), tokens: tokens(sum(core, 'total')) },
  stableCore: { names: STABLE_CORE, count: stableCore.length, total: sum(stableCore, 'total'), tokens: tokens(sum(stableCore, 'total')) },
  debug: { count: sized.filter(t => t.name.startsWith('ssam_debug')).length, total: sum(sized.filter(t => t.name.startsWith('ssam_debug')), 'total') },
  perTool: Object.fromEntries(sized.sort((a, b) => b.total - a.total).map(({ name, ...sizes }) => [name, sizes])),
};
if (option('--out')) fs.writeFileSync(path.resolve(option('--out')), JSON.stringify(report, null, 2) + '\n', 'utf8');
if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify(report, null, 1) + '\n'); process.exit(0); }
const line = (label, b) => console.log(label.padEnd(34) + String(b).padStart(9) + ' B' + String(tokens(b)).padStart(8) + ' tok');
for (const [k, v] of Object.entries(files)) line(k, v);
line('ssam instructions', report.instructions.bytes);
line('ODC instructions', report.odcInstructions.bytes);
line('deferred names (' + report.deferredNames.count + ')', report.deferredNames.bytes);
line('core tools (' + core.length + ') desc+schema', report.core.total);
line('all tools (' + sized.length + ') desc+schema', report.tools.total);
console.log('descriptions ' + report.tools.description + ' B, input schemas ' + report.tools.schema + ' B');
process.exit(0);
