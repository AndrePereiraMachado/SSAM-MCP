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
import { compatibility } from '../agent-hub.mjs';

test.after(cleanupHostedDirs);
const SHA = 'a'.repeat(64);
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });

function harness({ connected = true, info = {}, record = { pid: 6001 }, lanes = ['odc', 'o11'], full = false } = {}) {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, connected, info });
  const pulls = [];
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => full }, o11Connection: () => record,
    async call(kind, params) { return kind === 'studio.processes' ? { processes: [{ pid: 4120, path: 'C:\\Customer\\' + params.image, version: '1.7.28.4021' }] } : {}; },
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
  // NEW-1 of review 2: every hosted apply is refused at the gate, before the agent (HOSTED_DESTRUCTIVE, fail closed for now).
  const apply = (await h.gate('o11_access')({ action: 'apply', manifestPath: 'access/m.json', words: 'pode' })).structuredContent;
  assert.deepEqual([apply?.code, apply?.cause], ['HOSTED_UNAVAILABLE', 'DESTRUCTIVE_HOSTED_OFF']);
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
    studios: { odc: { installed: { dir: 'C:\\x', version: '1.7.27.100' } } } } });
  const refused = (await h.gate('studio_snapshot')({ module: 'M' })).structuredContent;
  assert.equal(refused.code, 'STUDIO_VERSION_MISMATCH');
  assert.equal(refused.lane, 'odc');
  assert.match(refused.error, /ODC Studio 1\.7\.28/);
  assert.match(refused.error, /ODC Studio 1\.7\.27\.100/);
  assert.equal(refused.serverKernel, '1.7.28');
  assert.equal(refused.agentStudio, '1.7.27.100');
  const pack = (await h.gate('o11_studio')({ command: 'status' })).structuredContent;
  assert.equal(pack.code, 'AGENT_PACK_MISMATCH');
  assert.match(pack.continuation.why, /agent package/);
  assert.notEqual((await h.gate('ssam_discover')({ intent: 'x', lane: 'odc' })).isError, true, 'server tools keep working');
  const odcOnly = harness({ lanes: ['odc'] });
  assert.equal(codeOf(await odcOnly.gate('o11_studio')({ command: 'status' })), 'HOSTED_LANE_DISABLED');
  assert.equal(codeOf(await odcOnly.gate('ssam_job')({ job: { ops: [] } })), 'HOSTED_LANE_DISABLED', 'ssam_job defaults to o11');
  assert.notEqual((await odcOnly.gate('studio_status')({})).isError, true);
});

// A-M1 + E2 (C:\t\multiver\minimo\PROPOSTA.md; docs/FASE2-AGENTE.md 7): the gate reads the hub's identity of the user's
// Studio (agent-hub.mjs compatibility -> studio-identity.mjs). Synthetic builds: the server serves 1.7.28.5000 / 11.55.92.6000.
const BUILT = { o11: '11.55.92', odc: '1.7.28', odcBridge: 'v97', builds: { odc: '1.7.28.5000', o11: '11.55.92.6000' } };
const studioInfo = (odc, o11 = '11.55.92.6000', kernel = BUILT) => {
  const studios = { odc: { installed: odc ? { dir: 'C:\\Users\\someone\\ODC Studio', version: odc } : null }, o11: { installed: { dir: 'C:\\Users\\someone\\SS', version: o11 } } };
  const hello = { pack: { lanes: ['odc', 'o11'], odcBridge: 'v97', o11BuiltFor: '11.55.92.6000' }, studios };
  return { kernel, studios, compatible: compatibility(hello, kernel, ['odc', 'o11']) };
};
const textOf = result => JSON.parse(result.content.find(item => item.type === 'text').text);

test('A-M1 gate: one refusal per direction with both builds, pt-BR for the user and English for the model, what still works and nothing ran', async () => {
  const newer = harness({ info: studioInfo('1.7.29.10900') });
  const r = await newer.gate('studio_snapshot')({ module: 'M' });
  assert.equal(r.isError, true);
  const v = r.structuredContent;
  assert.deepEqual({ code: v.code, cause: v.cause, lane: v.lane, installed: v.installed, served: v.served, outcome: v.outcome, serverKernel: v.serverKernel, agentStudio: v.agentStudio },
    { code: 'STUDIO_VERSION_MISMATCH', cause: 'STUDIO_VERSION_NOT_SERVED_YET', lane: 'odc', installed: '1.7.29.10900', served: ['1.7.28.5000'], outcome: 'not-sent', serverKernel: '1.7.28', agentStudio: '1.7.29.10900' });
  assert.match(v.userMessage, /é mais novo que o ODC Studio que o servidor SSAM atende hoje \(1\.7\.28\.5000\)\. O servidor ainda não tem esta versão; o dono do SSAM já foi avisado/);
  assert.match(v.userMessage, /Não volte o ODC Studio/); assert.match(v.userMessage, /Nada rodou no seu Studio\./);
  assert.match(v.error, /does not serve this version yet; the owner was notified/); assert.match(v.error, /Nothing ran on the user's Studio\./);
  // what still works: the server-only tools of this lane in the hosted catalog, never a tool that touches the Studio
  for (const name of ['ssam_discover', 'ssam_reference', 'ssam_job', 'studio_build', 'odc_search_operations']) assert.ok(v.stillWorks.includes(name), name);
  for (const name of ['studio_snapshot', 'studio_deliver', 'o11_inspect', 'o11_job', 'ssam_debug']) assert.ok(!v.stillWorks.includes(name), name);
  assert.equal(v.continuation.tool, 'ssam_doctor');
  assert.doesNotMatch(JSON.stringify(r), /install ODC Studio|instal(e|ar) o ODC Studio|someone/i, 'never "install the server version"; no folder of the user');
  assert.deepEqual(textOf(r), v, 'the text is the same answer');
  assert.deepEqual(newer.calls, [], 'nothing ran');
  const older = (await harness({ info: studioInfo('1.7.27.10846') }).gate('studio_deliver')({ module: 'M', job: { ops: [] } })).structuredContent;
  assert.equal(older.cause, 'STUDIO_UPDATE_REQUIRED');
  assert.match(older.userMessage, /Atualize o ODC Studio para 1\.7\.28\.5000/);
  assert.match(older.continuation.why, /update/);
  // the O11 lane: its own builds and its own server-only tools
  const o11 = (await harness({ info: studioInfo('1.7.28.5000', '11.55.93.7000') }).gate('o11_studio')({ command: 'status' })).structuredContent;
  assert.deepEqual({ cause: o11.cause, lane: o11.lane, installed: o11.installed, served: o11.served }, { cause: 'STUDIO_VERSION_NOT_SERVED_YET', lane: 'o11', installed: '11.55.93.7000', served: ['11.55.92.6000'] });
  assert.ok(o11.stillWorks.includes('o11_job') && o11.stillWorks.includes('o11_inspect') && !o11.stillWorks.includes('studio_build'));
  // a hub answer without the identity (STUDIO_VERSION_MISMATCH alone): the gate judges the same way from the versions it has
  const bare = harness({ info: { kernel: BUILT, compatible: { odc: { ok: false, code: 'STUDIO_VERSION_MISMATCH', message: 'm' }, o11: { ok: true } },
    studios: { odc: { installed: { version: '1.7.29.10900' } } } } });
  assert.equal((await bare.gate('studio_status')({})).structuredContent.cause, 'STUDIO_VERSION_NOT_SERVED_YET');
  // kernel.json studioBuildPolicy "refuse": another build is refused, by direction
  const strict = harness({ info: studioInfo('1.7.28.5023', '11.55.92.6000', { ...BUILT, studioBuildPolicy: 'refuse' }) });
  const refusedBuild = (await strict.gate('studio_status')({})).structuredContent;
  assert.deepEqual({ code: refusedBuild.code, cause: refusedBuild.cause, relation: refusedBuild.relation, policy: refusedBuild.policy },
    { code: 'STUDIO_VERSION_MISMATCH', cause: 'STUDIO_VERSION_NOT_SERVED_YET', relation: 'build-differs', policy: 'refuse' });
  assert.match(refusedBuild.userMessage, /build 1\.7\.28\.5023; o servidor SSAM atende o build 1\.7\.28\.5000/);
  assert.deepEqual(strict.calls, []);
});

test('E2: a server-only tool answers with studioNotServed while the Studio is not served; a build served with a warning puts studioBuildDiffers in every answer; the same build adds nothing', async () => {
  const notServed = harness({ info: studioInfo('1.7.29.10900') });
  for (const [name, args] of [['ssam_discover', { intent: 'x', lane: 'odc' }], ['odc_search_operations', { query: 'x' }], ['ssam_map', { lane: 'odc', target: 'ws:odc/snapshots/M.oml' }],
    ['studio_build', { feature: 'f', base: 'ws:odc/snapshots/M.oml', output: 'x' }], ['studio_doctor', {}]]) {
    const r = await notServed.gate(name)(args);
    assert.notEqual(r.isError, true, name);
    const w = r.structuredContent.studioWarning;
    assert.deepEqual({ code: w?.code, lane: w?.lane, cause: w?.cause, installed: w?.installed, served: w?.served },
      { code: 'studioNotServed', lane: 'odc', cause: 'STUDIO_VERSION_NOT_SERVED_YET', installed: '1.7.29.10900', served: '1.7.28.5000' }, name);
    assert.match(w.userMessage, /^Aviso: esta ferramenta rodou só no servidor, com o kernel do ODC Studio 1\.7\.28\.5000/);
    assert.deepEqual(textOf(r).studioWarning, w, name + ': the text carries it too');
  }
  assert.deepEqual(notServed.calls.map(c => c.name), ['ssam_discover', 'odc_search_operations', 'ssam_map', 'studio_build', 'studio_doctor']);
  // the other lane and a tool without a lane say nothing about the ODC Studio
  for (const [name, args] of [['ssam_discover', { intent: 'x', lane: 'o11' }], ['o11_inspect', { oml: 'ws:o11/M.oml' }], ['ssam_doctor', {}], ['ssam_evidence', { file: 'ws:odc/x.json' }]])
    assert.equal((await notServed.gate(name)(args)).structuredContent.studioWarning, undefined, name);
  // another build served with the warning (default policy): every answer of the lane, the Studio tools included
  const differs = harness({ info: studioInfo('1.7.28.5023') });
  for (const [name, args] of [['studio_status', {}], ['studio_deliver', { module: 'M', job: { ops: [] } }], ['ssam_discover', { intent: 'x', lane: 'odc' }], ['odc_search_operations', { query: 'x' }]]) {
    const w = (await differs.gate(name)(args)).structuredContent.studioWarning;
    assert.deepEqual({ code: w?.code, installed: w?.installed, served: w?.served, policy: w?.policy }, { code: 'studioBuildDiffers', installed: '1.7.28.5023', served: '1.7.28.5000', policy: 'warn' }, name);
  }
  assert.deepEqual(differs.calls.map(c => c.name), ['studio_status', 'studio_deliver', 'ssam_discover', 'odc_search_operations'], 'served: everything ran');
  // an answer without structured content gets one more text item with the warning; an answer of another shape keeps its own fields
  const textOnly = await differs.gate('studio_status', async () => ({ content: [{ type: 'text', text: 'plain' }] }))({});
  assert.equal(textOnly.content[0].text, 'plain');
  assert.equal(JSON.parse(textOnly.content[1].text).studioWarning.code, 'studioBuildDiffers');
  const own = await differs.gate('studio_status', async () => reply({ ok: true, warnings: [{ code: 'X' }] }))({});
  assert.deepEqual(own.structuredContent.warnings, [{ code: 'X' }]);
  assert.equal(own.structuredContent.studioWarning.code, 'studioBuildDiffers');
  // the same build, and an agent that never said hello: nothing
  const same = harness({ info: studioInfo('1.7.28.5000') });
  for (const name of ['studio_status', 'ssam_discover']) assert.equal((await same.gate(name)({ lane: 'odc', intent: 'x' })).structuredContent.studioWarning, undefined, name);
  const never = harness({ connected: false, info: { studios: null, compatible: compatibility(null, BUILT, ['odc', 'o11']), kernel: BUILT } });
  assert.equal((await never.gate('ssam_discover')({ intent: 'x', lane: 'odc' })).structuredContent.studioWarning, undefined);
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

test('23rd release: a list of ssam_map targets and the check-job {basedOn, patch, job} files are confined; a module name in the list needs the agent', async () => {
  const h = harness();
  const ws = (...p) => path.join(h.workspace, ...p);
  await h.gate('ssam_map')({ lane: 'odc', view: 'uses', element: 'Orders.GetOrders', target: ['ws:odc/snapshots/A.oml', 'snapshots/B.oml', 'Orders'] });
  assert.deepEqual(h.calls.at(-1).args.target, [ws('odc', 'snapshots', 'A.oml'), ws('odc', 'snapshots', 'B.oml'), 'Orders'], 'captures resolved, a module name kept');
  await h.gate('ssam_map')({ lane: 'o11', view: 'search', text: 'Site.', target: 'snapshots/M.oml' });
  assert.equal(h.calls.at(-1).args.target, ws('o11', 'snapshots', 'M.oml'), 'a single target as before');
  const before = h.calls.length;
  for (const target of [['ws:odc/snapshots/A.oml', path.join(anvilRoot, 'tests', 'fixtures', 'odc', 'blank-crossdevice.oml')], ['C:\\Windows\\x.oml'], ['ws:state/x.oml'], ['../../x.oml']])
    assert.equal(codeOf(await h.gate('ssam_map')({ lane: 'odc', view: 'search', text: 'x', target })), 'PATH_OUTSIDE_WORKSPACE', JSON.stringify(target));
  assert.equal(h.calls.length, before, 'no server capture reaches the handler');
  const offline = harness({ connected: false });
  assert.notEqual((await offline.gate('ssam_map')({ lane: 'odc', view: 'uses', element: 'x', target: ['ws:odc/a.oml', 'lab/b.oml'] })).isError, true, 'captures only: no agent');
  assert.equal(codeOf(await offline.gate('ssam_map')({ lane: 'odc', view: 'uses', element: 'x', target: ['ws:odc/a.oml', 'Orders'] })), 'AGENT_NOT_CONNECTED');
  assert.equal(agentNeed({ when: 'module-target', arg: 'target' }, { target: ['C:\\x\\M.oml', 'ws:odc/N.oml'] }), 'never');
  assert.equal(agentNeed({ when: 'module-target', arg: 'target' }, { target: ['C:\\x\\M.oml', 'Orders'] }), 'always');

  await h.gate('ssam_reference')({ lane: 'odc', kind: 'check-job', query: { basedOn: { job: 'ws:odc/.local/jobs/inline/a.json', sha256: SHA }, patch: [] } });
  assert.equal(h.calls.at(-1).args.query.basedOn.job, ws('odc', '.local', 'jobs', 'inline', 'a.json'));
  await h.gate('ssam_reference')({ lane: 'o11', kind: 'check-job', query: { basedOn: { job: 'jobs/a.json', sha256: SHA }, job: 'jobs/partial.json' } });
  assert.deepEqual(h.calls.at(-1).args.query, { basedOn: { job: ws('o11', 'jobs', 'a.json'), sha256: SHA }, job: ws('o11', 'jobs', 'partial.json') });
  const text = '{"ops":[{"op":"logic","data":{"actions":[{"name":"A"}]}}]}';
  await h.gate('ssam_reference')({ lane: 'odc', kind: 'check-job', query: { basedOn: { job: 'ws:odc/a.json', sha256: SHA }, job: text } });
  // fase4-24 item 1: on a job pointer the JSON text is the job itself, parsed by the gate (its paths are then confined).
  assert.deepEqual(h.calls.at(-1).args.query.job, JSON.parse(text), 'a partial job as JSON text is not a path: the gate parsed it');
  const inline = { ops: [], job: 'not a path of this tool' };
  await h.gate('ssam_reference')({ lane: 'odc', kind: 'check-job', query: inline });
  assert.deepEqual(h.calls.at(-1).args.query, inline, 'an inline job is the job itself');
  await h.gate('ssam_reference')({ lane: 'odc', kind: 'api', query: { basedOn: { job: 'x.json' } } });
  assert.deepEqual(h.calls.at(-1).args.query, { basedOn: { job: 'x.json' } }, 'only the job checks read files');
  const count = h.calls.length;
  for (const query of [{ basedOn: { job: path.join(workspaceRoot, '.local', 'server', 'tokens.json'), sha256: SHA }, patch: [] },
    { basedOn: { job: 'ws:odc/a.json', sha256: SHA }, job: 'C:\\Users\\other\\partial.json' }, { basedOn: { job: '..\\..\\state\\x.json', sha256: SHA }, patch: [] }])
    assert.equal(codeOf(await h.gate('ssam_reference')({ lane: 'odc', kind: 'check-job', query })), 'PATH_OUTSIDE_WORKSPACE', JSON.stringify(query));
  assert.equal(h.calls.length, count);
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

test('Linux paths (server/Dockerfile): the workspace is ws:<rel> without a leading "/", and a short root like HOME=/tmp hides only real /tmp paths', () => {
  const linux = presenter({ workspace: '/data/server/customers/tok_x/ws', serverRoots: ['/app', '/tmp', '/data/server'], pathApi: path.posix });
  // Seen in the Docker Desktop rehearsal before the fix: "/ws:odc/snapshots/..." and "/<servidor>".
  assert.equal(linux.string('/data/server/customers/tok_x/ws/odc/snapshots/Orders-AB.oml'), 'ws:odc/snapshots/Orders-AB.oml');
  assert.equal(linux.string('/data/server/customers/tok_x/ws/o11/tmp/thin-bridge/1.oml'), 'ws:o11/tmp/thin-bridge/1.oml', 'the workspace tmp is not the server /tmp');
  assert.equal(linux.string('wrote /data/server/customers/tok_x/ws/inbox/b.json and /app/kernel/.local/cli/anvil.dll (done)'), 'wrote ws:inbox/b.json and <servidor> (done)');
  assert.equal(linux.string('Path outside the workspace of this account: "/tmp/thin-bridge/2.oml"'), 'Path outside the workspace of this account: "<servidor>"');
  assert.equal(linux.string('/tmp'), '<servidor>');
  assert.equal(linux.string('/data/server/tokens.json'), '<servidor>');
  assert.equal(linux.string('/data/server/customers/tok_x/ws-other/x'), '<servidor>', 'a sibling folder is not the workspace');
  // A path that only contains a root's name further in is not that root.
  assert.equal(linux.string('C:\\SSAM-Agent\\tmp\\x.json'), 'C:\\SSAM-Agent\\tmp\\x.json');
  assert.equal(linux.string('ws:o11/tmp/a.oml'), 'ws:o11/tmp/a.oml');
  assert.equal(linux.string('/home/user/apps/x'), '/home/user/apps/x', '/app is not /apps');
  assert.equal(linux.string(JSON.stringify({ a: '/data/server/customers/tok_x/ws/odc/lab/r.json', b: '/tmp/z' }).slice(1, -1)), '"a":"ws:odc/lab/r.json","b":"<servidor>"');
  assert.deepEqual(linux.value({ path: '/data/server/customers/tok_x/ws/o11/snapshots/H.oml', home: '/tmp/.dotnet' }), { path: 'ws:o11/snapshots/H.oml', home: '<servidor>' });
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

test('23rd release: the work packet of ssam_discover keeps the customer\'s own module (and the context of app); the owner\'s catalogs in it still lose client names', async () => {
  const h = harness();
  const capture = path.join(h.workspace, 'odc', 'snapshots', 'FloodQuotes-' + 'a'.repeat(64) + '.oml');
  const read = { tool: 'ssam_map', arguments: { lane: 'odc', target: capture, view: 'digest', expectedSourceSha256: SHA } };
  const packet = { ok: true, schemaVersion: 'ssam-packet/1', lane: 'odc', intent: 'mudar GetQuote', app: capture,
    module: { name: 'FloodQuotes', file: capture, sourceSha256: SHA, items: [{ group: 'actions', name: 'GetFloodQuotes', text: 'GetFloodQuotes(QuoteId) calls FloodServices.ExistingQuote' }] },
    capabilities: { items: [{ id: 'logic.action', why: ['GetFloodQuotes (action of the module)'], summary: 'proven on the WrightFlood capture' }] },
    example: { job: 'examples/x', note: 'medido no WrightFlood' }, rules: { items: [{ rule: 'FloodQuotes DEV only' }] },
    next: { deliver: { tool: 'studio_deliver', arguments: { feature: '<Feature>', module: 'FloodQuotes' }, why: 'one call' }, fix: { how: 'patch' } },
    cuts: [{ section: 'module', left: { actions: 3 }, recover: read }, { section: 'rules', left: { rules: 1 }, recover: { tool: 'ssam_reference', arguments: { kind: 'rules', query: 'FloodQuotes' } } }] };
  const shown = (await h.gate('ssam_discover', async () => reply(packet))({ intent: 'mudar GetQuote', lane: 'odc', app: 'ws:odc/snapshots/FloodQuotes-' + 'a'.repeat(64) + '.oml', packet: true }));
  const value = shown.structuredContent;
  const wsCapture = 'ws:odc/snapshots/FloodQuotes-' + 'a'.repeat(64) + '.oml';
  assert.equal(value.app, wsCapture);
  assert.deepEqual(value.module, { ...packet.module, file: wsCapture }, 'the customer\'s own module, presented');
  assert.equal(value.next.deliver.arguments.module, 'FloodQuotes', 'the next delivery names the customer\'s module');
  assert.equal(value.cuts[0].recover.arguments.target, wsCapture, 'the cut that reads the module again');
  assert.equal(value.capabilities.items[0].summary, 'proven on the <cliente omitido> capture', 'the owner\'s catalogs still lose client names');
  assert.equal(value.example.note, 'medido no <cliente omitido>');
  assert.equal(value.rules.items[0].rule, '<cliente omitido> DEV only');
  assert.equal(value.cuts[1].recover.arguments.query, '<cliente omitido>');
  assert.equal(shown.content[0].text, JSON.stringify(value), 'the JSON text is the shown value');
  const context = { ok: true, matches: [{ id: 'logic.action', title: 'WrightFlood action' }], context: { ok: true, target: capture, reads: [{ name: 'FloodQuotes.GetQuote' }] } };
  const withApp = (await h.gate('ssam_discover', async () => reply(context))({ intent: 'x', lane: 'odc', app: wsCapture })).structuredContent;
  assert.deepEqual(withApp.context, { ok: true, target: wsCapture, reads: [{ name: 'FloodQuotes.GetQuote' }] });
  assert.equal(withApp.matches[0].title, '<cliente omitido> action');
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
  assert.equal(doctor.lanes.odc.serverKernel, '1.7.28');
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
