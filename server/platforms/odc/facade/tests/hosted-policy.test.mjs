// hosted/policy.mjs (docs/FASE2-AGENTE.md 5, 6.3, 6.4, 7, 8; docs/O11-BRIDGE-FINA.md 7.2): the order of the gate's
// refusals, the agent rules, the path names (ws:, agent:, relative, absolute), the neutral base of ssam_job
// {lane:"odc"}, the scrub of third-party evidence and the presentation of the answers; and the wiring in ssam.mjs
// (createSsamServer with hosted, registerServedTool for ssam_friction, the hosted doctor). A fake link, context, executor
// and run: no hub, no agent, no Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport, fromJsonSchema } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { wrapHostedTool, agentNeed, presenter, looksLikePath, NEUTRAL_ODC_BASE } from '../hosted/policy.mjs';
import { createSsamServer, registerServedTool, HOSTED_INSTRUCTIONS, HOSTED_RULES } from '../ssam.mjs';
import { anvilRoot, workspaceRoot } from '../workspace.mjs';
import { frictionTool } from '../../../../facade/friction-boundary.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const SHA = 'a'.repeat(64);
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });

function harness({ connected = true, info = {}, record = { pid: 6001 }, lanes = ['odc', 'o11'], full = false } = {}) {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, connected, info });
  const pulls = [];
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => full }, o11Connection: () => record,
    async call(kind, params) { return kind === 'studio.processes' ? { processes: [{ pid: 4120, path: 'C:\\Customer\\' + params.image, version: '1.7.27.4021' }] } : {}; },
    async pullFile(value, options) { pulls.push({ value, options }); return write(path.join(dirs.workspace, ...value.slice(6).split('/')), 'from the agent'); } };
  const context = { id: 'ctx-1', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes, workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const runs = [], calls = [];
  const run = (ctx, fn) => { runs.push(ctx); return fn(); };
  const gate = (name, handler = async args => { calls.push({ name, args }); return reply({ ok: true }); }) => {
    const wrapped = wrapHostedTool(name, { inputSchema: {} }, handler, { context, link, lanes, run });
    return (args = {}) => wrapped(args, { requestId: 1 });
  };
  return { ...dirs, link, executor, context, runs, calls, pulls, gate, run };
}
const codeOf = result => result.structuredContent?.code;

test('an unavailable tool never calls its handler: HOSTED_UNAVAILABLE with the reason and a discover continuation', async () => {
  const h = harness();
  for (const name of ['ssam_debug', 'ssam_debug_run', 'ssam_debug_invoke', 'context', 'propose', 'continue', 'status', 'not_classified_tool']) {
    const result = await h.gate(name)({ op: 'x' });
    assert.equal(result.isError, true);
    assert.equal(codeOf(result), 'HOSTED_UNAVAILABLE', name);
    assert.equal(result.structuredContent.continuation.tool, 'ssam_discover');
  }
  assert.match((await h.gate('ssam_debug')({})).structuredContent.error, /vault|hooks/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.runs, []);
});

test('without the agent: AGENT_NOT_CONNECTED with its continuation (and the agent-rotate why without a credential); server and report tools still run', async () => {
  const h = harness({ connected: false });
  const refused = await h.gate('studio_status')({});
  assert.equal(codeOf(refused), 'AGENT_NOT_CONNECTED');
  assert.equal(refused.structuredContent.continuation.tool, 'ssam_doctor');
  assert.match(refused.structuredContent.continuation.why, /ssam-agent\.ps1 start/);
  for (const name of ['ssam_reference', 'odc_search_operations', 'ssam_doctor', 'hybrid_tenants', 'odc_auth_status', 'studio_doctor', 'ssam_friction'])
    assert.notEqual((await h.gate(name)({ lane: 'odc', kind: 'api', query: 'x' })).isError, true, name);
  const noCredential = harness({ connected: false, info: { credential: false } });
  const why = (await noCredential.gate('o11_studio')({ command: 'status' })).structuredContent.continuation.why;
  assert.match(why, /agent-rotate/);
  assert.deepEqual(h.calls.map(c => c.name), ['ssam_reference', 'odc_search_operations', 'ssam_doctor', 'hybrid_tenants', 'odc_auth_status', 'studio_doctor', 'ssam_friction']);
});

test('mixed rules: ssam_map .oml vs module name, o11_access plan vs apply, ssam_job captureProducers', async () => {
  const h = harness({ connected: false });
  assert.notEqual((await h.gate('ssam_map')({ lane: 'odc', target: 'ws:odc/snapshots/Orders-1.oml' })).isError, true);
  assert.equal(codeOf(await h.gate('ssam_map')({ lane: 'odc', target: 'Orders' })), 'AGENT_NOT_CONNECTED');
  assert.notEqual((await h.gate('o11_access')({ action: 'plan', manifestPath: 'access/m.json' })).isError, true);
  assert.equal(codeOf(await h.gate('o11_access')({ action: 'apply', manifestPath: 'access/m.json', words: 'pode' })), 'AGENT_NOT_CONNECTED');
  assert.notEqual((await h.gate('ssam_job')({ lane: 'o11', job: { ops: [] }, captureProducers: [] })).isError, true);
  assert.equal(codeOf(await h.gate('ssam_job')({ lane: 'o11', job: { ops: [] }, captureProducers: ['System=(System)'] })), 'AGENT_NOT_CONNECTED');
  assert.equal(codeOf(await h.gate('ssam_app_url')({ app: 'Orders' })), 'AGENT_NOT_CONNECTED');
  assert.notEqual((await h.gate('ssam_app_url')({ app: 'Orders', tenant: 't.outsystems.dev' })).isError, true);
  assert.equal(agentNeed({ when: 'module-target', arg: 'target' }, { target: 'C:\\x\\M.oml' }), 'never');
  assert.equal(agentNeed({ when: 'unknown-rule', arg: 'x' }, {}), 'always', 'an unknown rule fails closed');
  assert.equal(looksLikePath('pode publicar...'), false);
  assert.equal(looksLikePath('lab/x.json'), true);
});

test('an o11-lane tool without the customer\'s O11 record is O11_NOT_CONNECTED; ssam_connect passes', async () => {
  const h = harness({ record: null });
  const refused = await h.gate('o11_studio')({ command: 'status' });
  assert.equal(codeOf(refused), 'O11_NOT_CONNECTED');
  assert.deepEqual(refused.structuredContent.continuation.arguments, { lane: 'o11' });
  assert.equal(codeOf(await h.gate('o11_data')({ host: 'h', module: 'M', oml: 'ws:o11/M.oml', request: {} })), 'O11_NOT_CONNECTED');
  assert.notEqual((await h.gate('ssam_connect')({ lane: 'o11' })).isError, true);
  assert.notEqual((await h.gate('studio_status')({})).isError, true, 'the ODC lane does not need the O11 record');
  assert.notEqual((await h.gate('o11_inspect')({ oml: 'ws:o11/M.oml' })).isError, true, 'a server-only O11 read does not either');
});

test('a version mismatch names both versions; a pack mismatch asks for the package; a lane outside the token is HOSTED_LANE_DISABLED', async () => {
  const h = harness({ info: { compatible: { odc: { ok: false, code: 'STUDIO_VERSION_MISMATCH', message: 'm' }, o11: { ok: false, code: 'AGENT_PACK_MISMATCH', message: 'old pack' } },
    studios: { odc: { installed: { dir: 'C:\\x', version: '1.7.28.100' } } } } });
  const refused = (await h.gate('studio_snapshot')({ module: 'M' })).structuredContent;
  assert.equal(refused.code, 'STUDIO_VERSION_MISMATCH');
  assert.equal(refused.lane, 'odc');
  assert.match(refused.error, /ODC Studio 1\.7\.27/);
  assert.match(refused.error, /ODC Studio 1\.7\.28\.100/);
  assert.equal(refused.serverKernel, '1.7.27');
  assert.equal(refused.agentStudio, '1.7.28.100');
  const pack = (await h.gate('o11_studio')({ command: 'status' })).structuredContent;
  assert.equal(pack.code, 'AGENT_PACK_MISMATCH');
  assert.match(pack.continuation.why, /agent package/);
  assert.notEqual((await h.gate('ssam_discover')({ intent: 'x', lane: 'odc' })).isError, true, 'server tools keep working');
  const odcOnly = harness({ lanes: ['odc'] });
  assert.equal(codeOf(await odcOnly.gate('o11_studio')({ command: 'status' })), 'HOSTED_LANE_DISABLED');
  assert.equal(codeOf(await odcOnly.gate('ssam_job')({ job: { ops: [] } })), 'HOSTED_LANE_DISABLED', 'ssam_job defaults to o11');
  assert.notEqual((await odcOnly.gate('studio_status')({})).isError, true);
});

test('ssam_job {lane:"odc"} without base runs on the neutral fixture; with base and on o11 nothing changes; over the quota a tool with an output is WORKSPACE_FULL', async () => {
  const h = harness();
  assert.equal(NEUTRAL_ODC_BASE, path.join(anvilRoot, 'tests', 'fixtures', 'odc', 'blank-crossdevice.oml'));
  assert.ok(path.isAbsolute(NEUTRAL_ODC_BASE) && fs.existsSync(NEUTRAL_ODC_BASE), 'the committed neutral fixture');
  for (const base of [undefined, null, '']) {
    const result = await h.gate('ssam_job')({ lane: 'odc', job: 'jobs/j.json', ...(base === undefined ? {} : { base }) });
    assert.notEqual(result.isError, true, String(base));
    assert.deepEqual(h.calls.at(-1).args, { lane: 'odc', job: path.join(h.workspace, 'odc', 'jobs', 'j.json'), base: NEUTRAL_ODC_BASE }, String(base));
  }
  await h.gate('ssam_job')({ lane: 'odc', job: { ops: [] }, base: 'ws:odc/snapshots/M.oml' });
  assert.equal(h.calls.at(-1).args.base, path.join(h.workspace, 'odc', 'snapshots', 'M.oml'), 'a given base is kept');
  for (const args of [{ lane: 'o11', job: { ops: [] } }, { job: { ops: [] } }]) {
    await h.gate('ssam_job')(args);
    assert.deepEqual(h.calls.at(-1).args, args, 'lane o11 is unchanged');
  }
  const echoed = await h.gate('ssam_job', async args => reply({ ok: true, base: args.base }))({ lane: 'odc', job: { ops: [] } });
  assert.equal(echoed.structuredContent.base, '<servidor>', 'the server path of the fixture is not shown');
  const full = harness({ full: true });
  assert.equal(codeOf(await full.gate('studio_build')({ feature: 'f', base: 'ws:odc/snapshots/M.oml', output: 'x' })), 'WORKSPACE_FULL');
  assert.equal(codeOf(await full.gate('studio_status')({})), 'WORKSPACE_FULL');
  assert.notEqual((await full.gate('ssam_doctor')({})).isError, true, 'the doctor still answers (it shows the usage)');
  assert.notEqual((await full.gate('ssam_reference')({ lane: 'odc', kind: 'api', query: 'x' })).isError, true);
});

test('ws: is resolved; ws:state/... and absolute paths outside the visible area are refused before the handler', async () => {
  const h = harness();
  await h.gate('o11_inspect')({ oml: 'ws:o11/snapshots/M.oml' });
  assert.equal(h.calls.at(-1).args.oml, path.join(h.workspace, 'o11', 'snapshots', 'M.oml'));
  const inside = path.join(h.workspace, 'odc', 'lab', 'x.json');
  await h.gate('ssam_evidence')({ file: inside });
  assert.equal(h.calls.at(-1).args.file, inside);
  const before = h.calls.length;
  for (const value of ['ws:state/relay-authority/bridge.key', 'ws:.local/friction/x.json', 'ws:odc/../state/x.json', 'C:\\Windows\\win.ini',
    path.join(h.workspace, 'state', 'relay-authority', 'bridge.key'), path.join(workspaceRoot, '.local', 'server', 'tokens.json'), '\\\\server\\share\\x.oml']) {
    const result = await h.gate('o11_inspect')({ oml: value });
    assert.equal(codeOf(result), 'PATH_OUTSIDE_WORKSPACE', value);
  }
  assert.equal(h.calls.length, before);
});

test('relative inputs land in ws:<lane>/, relative outputs in ws:odc/lab/ (ODC) and ws:o11/ (O11); /basedOn/job and /producers/* are confined', async () => {
  const h = harness();
  const ws = (...p) => path.join(h.workspace, ...p);
  await h.gate('o11_inspect')({ oml: 'snapshots/M.oml' });
  assert.equal(h.calls.at(-1).args.oml, ws('o11', 'snapshots', 'M.oml'));
  await h.gate('studio_build')({ feature: 'f', base: 'snapshots/B.oml', output: 'out-1' });
  assert.deepEqual([h.calls.at(-1).args.base, h.calls.at(-1).args.output], [ws('odc', 'snapshots', 'B.oml'), ws('odc', 'lab', 'out-1')]);
  await h.gate('ssam_job')({ lane: 'o11', job: 'jobs/j.json', out: 'proofs/p.oml', producers: { A: 'ws:odc/snapshots/A.oml', B: 'producers/B.avsig' }, basedOn: { job: 'jobs/j.json', sha256: SHA } });
  assert.deepEqual(h.calls.at(-1).args, { lane: 'o11', job: ws('o11', 'jobs', 'j.json'), out: ws('o11', 'proofs', 'p.oml'),
    producers: { A: ws('odc', 'snapshots', 'A.oml'), B: ws('o11', 'producers', 'B.avsig') }, basedOn: { job: ws('o11', 'jobs', 'j.json'), sha256: SHA } });
  await h.gate('ssam_job')({ lane: 'odc', job: { ops: [] }, base: 'snapshots/M.oml', out: 'proof.oml' });
  assert.equal(h.calls.at(-1).args.out, ws('odc', 'lab', 'proof.oml'));
  assert.deepEqual(h.calls.at(-1).args.job, { ops: [] }, 'an inline job is not a path');
  await h.gate('o11_studio')({ command: 'snapshot', args: { module: 'M', path: 'snapshots/M.oml' } });
  assert.deepEqual(h.calls.at(-1).args.args, { module: 'M', path: ws('o11', 'snapshots', 'M.oml') });
  await h.gate('studio_command')({ command: 'open', args: ['Orders', 'lab/x.oml', 'pode publicar...'] });
  assert.deepEqual(h.calls.at(-1).args.args, ['Orders', ws('odc', 'lab', 'x.oml'), 'pode publicar...'], 'only what looks like a path');
  await h.gate('ssam_reference')({ lane: 'odc', kind: 'api', query: 'Orders.json' });
  assert.equal(h.calls.at(-1).args.query, 'Orders.json', '/query is a file only for the job checks');
  await h.gate('ssam_reference')({ lane: 'o11', kind: 'check-job', query: 'jobs/j.json' });
  assert.equal(h.calls.at(-1).args.query, ws('o11', 'jobs', 'j.json'));
  for (const args of [{ basedOn: { job: '../../state/x.json', sha256: SHA }, patch: [] }, { job: '..\\..\\..\\..\\x.json' }, { producers: { A: '../state/a.oml' } }])
    assert.equal(codeOf(await h.gate('o11_deliver')({ module: 'M', ...args })), 'PATH_OUTSIDE_WORKSPACE', JSON.stringify(args));
});

test('agent:inbox/<file> is brought through the executor; agent:odc|o11 only when missing; a bad agent: from the LLM never blames the agent', async () => {
  const h = harness();
  await h.gate('studio_open')({ module: 'Mine', localOml: 'agent:inbox/Mine.oml' });
  assert.deepEqual(h.pulls, [{ value: 'agent:inbox/Mine.oml', options: { ifMissing: false } }]);
  assert.equal(h.calls.at(-1).args.localOml, path.join(h.workspace, 'inbox', 'Mine.oml'));
  await h.gate('o11_inspect')({ oml: 'agent:o11/snapshots/M.oml' });
  assert.deepEqual(h.pulls.at(-1), { value: 'agent:o11/snapshots/M.oml', options: { ifMissing: true } });
  const refused = await h.gate('studio_open')({ module: 'M', localOml: 'agent:..\\..\\..\\.local\\server\\tokens.json' });
  assert.equal(codeOf(refused), 'PATH_OUTSIDE_WORKSPACE');
  // agent: names only the agent's own folders; a server file of the visible area is refused here, never pulled.
  for (const value of ['agent:odc/tenants.json', 'agent:odc/tmp/x.oml'])
    assert.equal(codeOf(await h.gate('studio_open')({ module: 'M', localOml: value })), 'PATH_OUTSIDE_WORKSPACE', value);
  assert.equal(codeOf(await h.gate('studio_open')({ module: 'M', localOml: 'ws:odc/tenants.json' })), undefined, 'ws: still names the whole visible area');
  assert.deepEqual(h.link.protocolErrors, [], 'the LLM is not the agent: no protocol error, no channel closed');
  assert.equal(h.pulls.length, 2);
});

test('answers show ws: in the object and in the JSON text; other server paths become <servidor>', async () => {
  const h = harness();
  const file = path.join(h.workspace, 'odc', 'lab', '01-x', 'result.json');
  const inState = path.join(h.workspace, 'state', 'relay-authority', 'bridge.key');
  const server = path.join(workspaceRoot, 'kernel', '.local', 'cli', 'anvil.dll');
  const value = { ok: true, file, files: [path.join(h.workspace, 'o11', 'a.oml')], note: 'wrote ' + path.join(h.workspace, 'inbox', 'b.json') + ' and ' + server + ' (done)',
    authorityDir: inState, cli: server, home: path.join(os.homedir(), 'AppData', 'Local', 'x.json'), customer: 'C:\\Program Files\\OutSystems\\ODC Studio\\ODCStudio.exe' };
  const result = await h.gate('ssam_evidence', async () => reply(value))({ file: 'ws:odc/lab/01-x/result.json' });
  const shown = result.structuredContent;
  assert.deepEqual(shown, { ok: true, file: 'ws:odc/lab/01-x/result.json', files: ['ws:o11/a.oml'], note: 'wrote ws:inbox/b.json and <servidor> (done)',
    authorityDir: '<servidor>', cli: '<servidor>', home: '<servidor>', customer: 'C:\\Program Files\\OutSystems\\ODC Studio\\ODCStudio.exe' });
  assert.equal(result.content[0].text, JSON.stringify(shown));
  assert.ok(!result.content[0].text.includes(h.workspace.split(path.sep).join('\\\\')));
  // A text that is not the JSON of structuredContent: both forms (raw and JSON-escaped) are replaced.
  const plain = presenter({ workspace: h.workspace, serverRoots: [path.dirname(h.workspace)] });
  assert.equal(plain.string('see ' + file), 'see ws:odc/lab/01-x/result.json');
  assert.equal(plain.string(JSON.stringify({ a: file }).slice(1, -1)), '"a":"ws:odc/lab/01-x/result.json"');
  assert.equal(plain.string(h.workspace + '-other\\x'), '<servidor>', 'a sibling folder is not the workspace');
  const pretty = plain.result({ content: [{ type: 'text', text: JSON.stringify({ file }, null, 2) }] });
  assert.equal(pretty.content[0].text, JSON.stringify({ file: 'ws:odc/lab/01-x/result.json' }));
});

test('the module index store and the readers\' copy are server paths wherever their roots are (ssam_map index.file, the 22nd digest store.file)', () => {
  const h = harness();
  const saved = { index: process.env.SSAM_MODULE_INDEX_ROOT, readers: process.env.SSAM_READER_CACHE_ROOT };
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-index-root-'));
  try {
    process.env.SSAM_MODULE_INDEX_ROOT = path.join(outside, 'module-index');
    process.env.SSAM_READER_CACHE_ROOT = path.join(outside, 'readers');
    const shown = presenter({ workspace: h.workspace }).value({
      store: { file: path.join(outside, 'module-index', 'v1', 'odc', 'ab'.repeat(32) + '.kernel.digest.json') },
      reader: path.join(outside, 'readers', 'odc', 'gen', 'reader.log'), file: path.join(h.workspace, 'odc', 'snapshots', 'A.oml') });
    assert.deepEqual(shown, { store: { file: '<servidor>' }, reader: '<servidor>', file: 'ws:odc/snapshots/A.oml' });
  } finally {
    for (const [name, value] of [['SSAM_MODULE_INDEX_ROOT', saved.index], ['SSAM_READER_CACHE_ROOT', saved.readers]])
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('every hosted answer loses the evidence of a client capture (evidence.mjs) before it is presented; the lane jobs, on the anonymized fixture, stay', async () => {
  const h = harness();
  const capture = path.join(anvilRoot, 'tests', 'fixtures', 'odc', 'wrightflood-personal-r8.oml');
  const value = { ok: true, level: 'C-suite', proofs: [{ job: 'screen-list', level: 'C-suite' }, { job: 'workflow-nodes', level: 'C-suite' }],
    identity: { fixture: { path: capture, sha256: 'EB15' } }, note: 'base ' + capture, file: path.join(h.workspace, 'odc', 'lab', 'r.json') };
  for (const name of ['ssam_discover', 'ssam_evidence', 'ssam_job']) {
    const result = await h.gate(name, async () => reply(value))({ intent: 'x', lane: 'odc', file: 'ws:odc/lab/r.json', job: { ops: [] } });
    const shown = result.structuredContent;
    assert.deepEqual(shown.proofs, value.proofs, name + ': the lane runs on the anonymized fixture, its jobs are not third-party');
    assert.equal(shown.identity.fixture, null, name);
    assert.equal(shown.hostedEvidenceOmitted, 1, name);
    assert.equal(shown.level, 'C-suite', name);
    assert.equal(shown.file, 'ws:odc/lab/r.json', name + ': then presented');
    assert.equal(result.content[0].text, JSON.stringify(shown), name);
    assert.doesNotMatch(JSON.stringify(result), /wrightflood-personal-r8/i, name);
  }
});

test('only an ssam_discover answer (the owner\'s catalogs) loses client names; other answers keep the customer\'s own data', async () => {
  const h = harness();
  const value = { ok: true, limits: [{ text: 'A real FloodQuotes DEV login; medido no WrightFlood' }], module: 'FloodQuotes_CS' };
  const discovered = (await h.gate('ssam_discover', async () => reply(value))({ intent: 'x', lane: 'odc' })).structuredContent;
  assert.equal(discovered.limits[0].text, 'A real <cliente omitido> DEV login; medido no <cliente omitido>');
  assert.equal(discovered.module, '<cliente omitido>_CS');
  for (const name of ['ssam_map', 'ssam_evidence', 'ssam_job']) {
    const shown = (await h.gate(name, async () => reply(value))({ lane: 'odc', job: { ops: [] } })).structuredContent;
    assert.deepEqual(shown, value, name);
  }
});

test('createSsamServer({hosted}): every tool and ssam_friction go through the gate inside run(context); the doctor shows the agent', async t => {
  const h = harness();
  const runs = [];
  const run = (ctx, fn) => { runs.push(ctx.id); return fn(); };
  const session = { tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: h.workspace, agent: h.link };
  const server = await createSsamServer({ o11: false, odc: false, hosted: { context: h.context, session, run } });
  const answered = path.join(h.workspace, 'o11', 'tasks', 'friction.json');
  registerServedTool(server, frictionTool.name, { description: frictionTool.description, inputSchema: fromJsonSchema(frictionTool.inputSchema) },
    async () => reply({ ok: true, queue: answered }));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-policy-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  // servidor/fase4: the paragraph, the working rules (inbox, AGENT_RECONNECTING, prototype 1:1, ToolSearch) and the inbox.
  assert.ok(client.getInstructions().includes(HOSTED_INSTRUCTIONS + ' ' + HOSTED_RULES));
  assert.match(client.getInstructions(), /agent inbox folder/);
  const friction = await client.callTool({ name: 'ssam_friction', arguments: { view: 'issues' } });
  assert.equal(friction.structuredContent.queue, 'ws:o11/tasks/friction.json');
  assert.deepEqual(runs, ['ctx-1'], 'ssam_friction ran inside the hosted context');
  const debug = await client.callTool({ name: 'ssam_debug', arguments: { op: 'status', sessionId: 'b'.repeat(32) } });
  assert.equal(debug.structuredContent?.code, 'HOSTED_UNAVAILABLE', JSON.stringify(debug).slice(0, 600));
  assert.deepEqual(runs, ['ctx-1'], 'a refused tool never runs');
  const doctor = (await client.callTool({ name: 'ssam_doctor', arguments: {} })).structuredContent;
  assert.equal(doctor.hosted, true);
  assert.equal(doctor.agent.connected, true);
  assert.equal(doctor.agent.instance, 'fake-instance');
  assert.equal(doctor.lanes.odc.serverKernel, '1.7.27');
  assert.equal(doctor.lanes.odc.studio.open, true);
  assert.equal(doctor.lanes.o11.connection.pid, 6001);
  assert.equal(Object.hasOwn(doctor.lanes.o11.connection, 'authorityDir'), false, 'no server folder of the record');
  assert.ok(!JSON.stringify(doctor).includes(h.workspace), 'no raw workspace path');
  const evidence = await client.callTool({ name: 'ssam_evidence', arguments: { file: path.join(workspaceRoot, '.local', 'server', 'tokens.json') } });
  assert.equal(evidence.structuredContent.code, 'PATH_OUTSIDE_WORKSPACE');
  assert.deepEqual(runs, ['ctx-1', 'ctx-1']);
});

test('the hosted doctor without the agent answers and says so, with the agent continuation', async t => {
  const h = harness({ connected: false });
  const session = { tokenId: 'tok_test', lanes: ['odc', 'o11'], workspace: h.workspace, agent: h.link };
  const server = await createSsamServer({ o11: false, odc: false, hosted: { context: h.context, session, run: (ctx, fn) => fn() } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-doctor-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const doctor = (await client.callTool({ name: 'ssam_doctor', arguments: { lane: 'odc' } })).structuredContent;
  assert.equal(doctor.ok, false);
  assert.equal(doctor.agent.connected, false);
  assert.equal(doctor.continuation.tool, 'ssam_doctor');
  assert.equal(doctor.lanes.odc.studio.processes, null, 'nothing asked of a disconnected agent');
});
