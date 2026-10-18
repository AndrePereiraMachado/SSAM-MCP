import '../facade/tests/fixtures/isolated-profile.mjs';
// The exposure inventory (fix/no-internals): runs the SSAM MCP server in this process (profile all, no Studio, no
// network) and captures the answers of the read tools a licensee leans on (ssam_reference of every kind, ssam_discover
// over typical O11 and ODC intents, ssam_doctor, ssam_map) and the refusals of the job and delivery tools on synthetic
// jobs. Each answer is written whole to <out>/<exposure>/answers.json; exposure-classify.mjs classifies it.
//   node scripts/exposure-inventory.mjs --out <dir> [--exposure owner|licensee] [--only reference,discover,...]
// Read only for the lanes: a job runs headless in the checkout's own .local; nothing reaches a Studio.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', 'kernel');
const arg = (name, fallback = null) => { const at = process.argv.indexOf('--' + name); return at > 0 ? process.argv[at + 1] : fallback; };
const out = path.resolve(arg('out', path.join(kernel, '.local', 'exposure-inventory')));
const exposure = arg('exposure', 'owner');
const only = arg('only') ? new Set(arg('only').split(',')) : null;
if (exposure) process.env.SSAM_EXPOSURE = exposure;
// a caller of its own per run: the day's reference bytes of earlier runs never refuse this one
process.env.SSAM_EXPOSURE_CALLER ??= 'inventory-' + process.pid;

const o11Base = path.join(kernel, 'tests', 'fixtures', 'blank-service.oml');
const odcBase = path.join(kernel, 'tests', 'fixtures', 'odc', 'insurance-reactive-r8.oml');
const badO11 = { description: 'synthetic probe', base: o11Base, ops: [
  { op: 'spec', data: { entities: [{ name: 'Customer', attributes: [{ name: 'Name', type: 'Txt' }] }] } },
  { op: 'creat', type: 'ServerAction', name: 'Sum' }] };
const badOdc = { description: 'synthetic probe', base: odcBase, ops: [
  { op: 'spec', data: { entities: [{ name: 'Customer', attributes: [{ name: 'Name', type: 'Txt' }] }] } },
  { op: 'creat', type: 'ServerAction', name: 'Sum' }] };

export const CALLS = [
  // ---- ssam_reference: every kind, the common queries
  ...['o11', 'odc'].flatMap(lane => [
    ['reference', { lane, kind: 'api', query: 'IServerAction' }],
    ['reference', { lane, kind: 'api', query: { op: 'logic' } }],
    ['reference', { lane, kind: 'api', query: { op: 'html' } }],
    ['reference', { lane, kind: 'api', query: { op: 'create' } }],
    ['reference', { lane, kind: 'api', query: { op: 'logic', name: 'If' } }],
    ['reference', { lane, kind: 'api', query: { op: 'native', type: 'IServerAction' } }],
    ['reference', { lane, kind: 'api', query: { op: 'ddl' } }],
    ['reference', { lane, kind: 'recipe', query: 'timer' }],
    ['reference', { lane, kind: 'recipe', query: { find: 'rest', ops: true, max: 3 } }],
    ['reference', { lane, kind: 'verify-message', query: { find: 'unused' } }],
    ['reference', { lane, kind: 'example', query: { find: 'table' } }],
    ['reference', { lane, kind: 'example', query: 'matriz' }],
    ['reference', { lane, kind: 'example', query: lane === 'o11' ? 'timer-action' : 'rest-openapi-import' }],
    ['reference', { lane, kind: 'rules', query: 'all' }],
    ['reference', { lane, kind: 'rules', query: 'standards' }],
    ['reference', { lane, kind: 'rules', query: 'session' }],
    ['reference', { lane, kind: 'rules', query: '1' }],
    ['reference', { lane, kind: 'tool', query: lane === 'o11' ? 'o11_deliver' : 'studio_deliver' }],
    ['reference', { lane, kind: 'check-job', query: lane === 'o11' ? badO11 : badOdc }],
  ]),
  ['reference', { lane: 'o11', kind: 'functions', query: 'GetUserId CurrDateTime AddMinutes' }],
  ['reference', { lane: 'o11', kind: 'ui-block', query: 'Button' }],
  ['reference', { lane: 'o11', kind: 'ui-block', query: { find: 'table' } }],
  ['reference', { lane: 'o11', kind: 'types', query: { assembly: 'OutSystems.Model.V1', filter: 'ServerAction', max: 10 } }],
  ['reference', { lane: 'o11', kind: 'where-can', query: 'IServerAction' }],
  ['reference', { lane: 'o11', kind: 'check-delivery', query: { taskId: '0123456789abcdef' } }],
  // ---- ssam_discover: 20 typical intents, and the work packet of two of them
  ...[
    ['o11', 'create a server action that sums two integers'],
    ['o11', 'create an entity Customer with name and email and its CRUD actions'],
    ['o11', 'create list and detail screens for an entity'],
    ['o11', 'expose a REST API'],
    ['o11', 'consume a REST API'],
    ['o11', 'add a timer that runs every day'],
    ['o11', 'create a static entity with records'],
    ['o11', 'add a role and check it in a screen'],
    ['o11', 'create a structure and a public action in a library'],
    ['o11', 'send an email'],
    ['odc', 'create a reactive screen with a table of orders'],
    ['odc', 'create a client action with an if'],
    ['odc', 'create an entity with an index'],
    ['odc', 'add a server action that calls a REST API'],
    ['odc', 'create a block with an event'],
    ['odc', 'create a workflow'],
    ['odc', 'create a timer'],
    ['odc', 'port an approved prototype screen 1:1 with the html op and its style in the theme'],
    ['odc', 'add a data action to a screen'],
    ['odc', 'create a mobile app'],
  ].map(([lane, intent]) => ['discover', { lane, intent }]),
  ['discover', { lane: 'o11', intent: 'create an entity Customer with name and email and its CRUD actions', packet: true }],
  ['discover', { lane: 'odc', intent: 'create a reactive screen with a table of orders', packet: true }],
  // expansions and details: where the large discover answers of a session come from
  ['discover', { lane: 'o11', expand: 'logic.server-action:contract+example+evidence+operations+native+bindings' }],
  ['discover', { lane: 'odc', expand: 'logic.server-action:contract+example+evidence+operations+native+bindings' }],
  ['discover', { lane: 'o11', detail: 'timer.schedule' }],
  ['discover', { lane: 'odc', detail: 'data.entity' }],
  ['discover', { lane: 'o11', expand: 'integration.rest-expose:example+evidence' }],
  ['follow', { from: 'ssam_discover' }],
  // ---- state and reading
  ['doctor', {}],
  ['doctor', { lane: 'o11' }],
  ['doctor', { lane: 'odc' }],
  ['map', { lane: 'odc', target: odcBase, view: 'digest' }],
  ['map', { lane: 'odc', target: odcBase }],
  ['map', { lane: 'o11', target: o11Base }],
  // ---- refusals on synthetic jobs
  ['job', { lane: 'o11', job: badO11 }],
  ['job', { lane: 'odc', job: badOdc }],
  ['o11_job', { job: badO11 }],
  ['o11_deliver', { module: 'SsamProbe', job: badO11 }],
  ['studio_deliver', { feature: 'SsamProbe', module: 'SsamProbe', job: badOdc, owners: ['probe'], changes: ['probe'] }],
  ['follow', { from: 'ssam_job' }],
  ['follow', { from: 'ssam_reference' }],
];
const findCall = (value, tool) => {
  if (!value || typeof value !== 'object') return null;
  if (value.tool === tool && value.arguments) return value;
  for (const v of Object.values(value)) { const found = findCall(v, tool); if (found) return found; }
  return null;
};
const TOOL = { evidence: 'ssam_evidence', reference: 'ssam_reference', discover: 'ssam_discover', doctor: 'ssam_doctor', map: 'ssam_map', job: 'ssam_job' };

// --results snapshot: the stamped job results of the committed snapshot (tests/fixtures/discovery-results.json) are copied
// into this checkout's lane result folders first, so the discover answers carry what a server with run suites carries
// (proof levels, executed jobs), as the hosted server's do.
export async function useSnapshotResults() {
  const { resultsSnapshot } = await import('../facade/tests/fixtures/discovery-results.mjs');
  const { dirs } = resultsSnapshot();
  const target = { o11: path.join(kernel, '.local', 'test-work'), odc: path.join(kernel, '.local', 'lane-odc', 'test-work') };
  for (const lane of ['o11', 'odc']) fs.cpSync(dirs[lane], target[lane], { recursive: true, preserveTimestamps: true });
  return target;
}
// The lane indexes are built before the first call, so no discover answers with the deadline's task instead of its answer.
export async function warmLanes(log = () => {}) {
  const { buildIndex } = await import('../facade/discovery.mjs');
  for (const lane of ['o11', 'odc']) { const started = Date.now(); const built = await buildIndex(lane); log(`index ${lane} ${built.cache?.hit ? 'hit' : 'built'} ${Date.now() - started} ms`); }
}

export async function captureAnswers({ calls = CALLS, filter = only, log = () => {} } = {}) {
  const { createSsamServer } = await import('../facade/ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  // The module map's cold reader asks for a trusted-controller key: a synthetic one in this process's authority folder
  // (the isolated profile's), never the user's.
  const authority = process.env.ANVIL_AUTHORITY_DIR;
  if (authority && !fs.existsSync(path.join(authority, 'bridge.key'))) { fs.mkdirSync(authority, { recursive: true }); fs.writeFileSync(path.join(authority, 'bridge.key'), 'synthetic-' + process.pid); }
  const server = await createSsamServer({ profile: 'all' });
  const client = new Client({ name: 'exposure-inventory', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const answers = [];
  try {
    for (let [group, args] of calls) {
      if (filter && !filter.has(group) && !(group === 'follow' && filter.has('discover'))) continue;
      if (group === 'follow') {
        // The first continuation to ssam_evidence of an earlier answer of that tool: the rest of a reduced answer.
        const call = answers.filter(a => a.tool === args.from).map(a => findCall(a.structured, 'ssam_evidence')).find(Boolean);
        if (!call) continue;
        group = 'evidence'; args = call.arguments;
      }
      const tool = TOOL[group] ?? group;
      const started = Date.now();
      let result;
      try { result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600000 }); }
      catch (error) { result = { thrown: String(error?.message ?? error) }; }
      const text = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      answers.push({ group, tool, args, ms: Date.now() - started, bytes: Buffer.byteLength(text, 'utf8'), isError: result.isError === true,
        structured: result.structuredContent ?? null, text, ...(result.thrown ? { thrown: result.thrown } : {}) });
      log(`${tool} ${JSON.stringify(args).slice(0, 100)} ${Date.now() - started} ms ${answers.at(-1).bytes} B`);
    }
  } finally { await client.close(); await server.close(); }
  return answers;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const log = line => process.stderr.write(line + '\n');
  if (arg('results') === 'snapshot') log('results: ' + JSON.stringify(await useSnapshotResults()));
  if (!only || only.has('discover')) await warmLanes(log);
  const answers = await captureAnswers({ log });
  const dir = path.join(out, exposure);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify({ exposure, at: new Date().toISOString(), answers }, null, 1));
  process.stderr.write(`wrote ${answers.length} answers to ${dir}\n`);
  process.exit(0);
}
