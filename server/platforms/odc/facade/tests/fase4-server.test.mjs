// The hosted server line, servidor/fase4 (clusters of docs/SERVIDOR-FASE4.md): C03 (the gate waits for a reconnecting agent
// and answers AGENT_RECONNECTING, never "start the agent", while it was seen recently), C26 (a path of the agent folder is
// its agent: path; any other path names the exact inbox file), C32 (the doctor judges only the enabled lanes), C04 (the
// Development origin of <name>.outsystems.dev, the customer's tenants.json filled from the connected tenant, the fragment
// preview of a delivery), C14 (one file.sync per command, a skipped put releases its transfer, the heavy evidence of a
// successful merge stays on the agent) and the warm-up. Fakes only: no hub, no agent process, no Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { wrapHostedTool, agentNotConnected } from '../hosted/policy.mjs';
import { hostedDoctor, warmServer, HOSTED_RULES } from '../ssam.mjs';
import { AgentExecutor } from '../hosted/agent-executor.mjs';
import { applicationUrls, derivedStageOrigin } from '../app-urls.mjs';
import { recordConnectedTenants, withFragmentPreview, warmSoon } from '../lib.mjs';
import { renderFragmentPreview } from '../preview/fragment.mjs';
import { runWithExecutor } from '../executor.mjs';
import { INLINE_JOB_MARKER } from '../agent-paths.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs, agentPaths } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });
const ago = ms => new Date(Date.now() - ms).toISOString();

function harness({ connected = true, info = {}, lanes = ['odc'], sync = false } = {}) {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, connected, info, sync });
  const pulls = [];
  const executor = { id: 'fake', hosted: true, quota: { full: () => false }, o11Connection: () => null,
    async call(kind, params) { return kind === 'studio.processes' ? { processes: [{ pid: 4120, path: 'C:\\Customer\\' + params.image, version: '1.7.28.4021' }] } : {}; },
    async pullFile(value) { pulls.push(value); return write(path.join(dirs.workspace, ...value.slice(6).split('/')), 'from the agent'); } };
  const context = { id: 'ctx', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes, workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const calls = [];
  const gate = (name, options = {}) => {
    const wrapped = wrapHostedTool(name, { inputSchema: {} }, async args => { calls.push({ name, args }); return reply({ ok: true }); }, { context, link, lanes, run: (ctx, fn) => fn(), ...options });
    return (args = {}) => wrapped(args, { requestId: 1 });
  };
  return { ...dirs, link, executor, context, calls, pulls, gate };
}

// ---- C03
test('C03: an agent seen a moment ago is AGENT_RECONNECTING with retryAfterSeconds and the same call to repeat; after 2.5 min the user is asked to look; after 5 min it is AGENT_NOT_CONNECTED', async () => {
  const recent = agentNotConnected({ instance: 'i', lastSeenAt: ago(10000) }, { tool: 'studio_status', args: { pid: 4120 } });
  assert.equal(recent.code, 'AGENT_RECONNECTING');
  assert.equal(recent.retryAfterSeconds, 15);
  assert.deepEqual(recent.continuation, { tool: 'studio_status', arguments: { pid: 4120 }, why: recent.continuation.why });
  assert.doesNotMatch(recent.continuation.why, /ssam-agent\.ps1/, 'nobody is asked to restart a live agent');
  const quiet = agentNotConnected({ instance: 'i', lastSeenAt: ago(200000) }, { tool: 'studio_status' });
  assert.equal(quiet.code, 'AGENT_RECONNECTING');
  assert.match(quiet.continuation.why, /ssam-agent\.ps1 status/);
  assert.equal(agentNotConnected({ instance: 'i', lastSeenAt: ago(6 * 60000) }).code, 'AGENT_NOT_CONNECTED');
  assert.equal(agentNotConnected({ instance: null, lastSeenAt: ago(1000) }).code, 'AGENT_NOT_CONNECTED', 'a clean stop has no instance');
  assert.equal(agentNotConnected({ instance: 'i', lastSeenAt: ago(1000), credential: false }).code, 'AGENT_NOT_CONNECTED');

  const h = harness({ connected: false, info: { lastSeenAt: ago(5000) } });
  const refused = (await h.gate('studio_status', { waitMs: 100 })({})).structuredContent;
  assert.equal(refused.code, 'AGENT_RECONNECTING');
  assert.equal(refused.continuation.tool, 'studio_status');
  assert.deepEqual(h.calls, []);
  // The agent comes back while the gate waits: the tool runs.
  const back = harness({ connected: false, info: { lastSeenAt: ago(5000) } });
  back.link.reconnectIn = 30;
  assert.notEqual((await back.gate('studio_status', { waitMs: 2000 })({})).isError, true);
  assert.deepEqual(back.calls.map(c => c.name), ['studio_status']);
});

// ---- C26
test('C26: an absolute path under the agent folder is its agent: path; any other path names the exact inbox file and the same call', async () => {
  const h = harness({ info: { agentRoot: 'C:\\SSAM-Agent' } });
  const deliver = h.gate('studio_deliver');
  await deliver({ job: 'C:\\SSAM-Agent\\inbox\\cart.json', module: 'Shop', feature: 'cart', owners: ['a'], changes: ['b'] });
  assert.deepEqual(h.pulls, ['agent:inbox/cart.json']);
  assert.equal(h.calls[0].args.job, path.join(h.workspace, 'inbox', 'cart.json'));
  const outside = (await deliver({ job: 'C:\\Users\\cliente\\AppData\\Local\\Temp\\claude\\job.json', module: 'Shop' })).structuredContent;
  assert.equal(outside.code, 'PATH_OUTSIDE_WORKSPACE');
  // fase4-24: a job goes inline; the fix says so first and still names the inbox file for a job that already is a file.
  assert.match(outside.fix, /^mande o próprio job inline em job/);
  assert.match(outside.fix, /C:\\SSAM-Agent\\inbox\\job\.json/);
  assert.equal(outside.inbox, 'C:\\SSAM-Agent\\inbox');
  assert.deepEqual(outside.continuation.arguments, { job: INLINE_JOB_MARKER, module: 'Shop' });
  assert.equal(outside.continuation.tool, 'studio_deliver');
  assert.equal(h.calls.length, 1, 'the refused call never ran');
  // servidor/fase4-24: one job per module, inline, compact; the kernel's normalizations come listed.
  assert.match(HOSTED_RULES, /^Jobs: ONE job per module, with every change of the request for that module/);
  assert.match(HOSTED_RULES, /sent inline in the job argument as compact JSON/);
  assert.match(HOSTED_RULES, /normalizations {total, byRule, items}/);
  assert.match(HOSTED_RULES, /agent:inbox\/<file> is only for the user's own files/);
  assert.match(HOSTED_RULES, /ported 1:1/);
  assert.match(HOSTED_RULES, /ToolSearch/);
});

// ---- C32
test('C32: the hosted doctor judges only the enabled lanes; a closed Studio leads to ssam_connect; the agent folder and inbox are shown', async () => {
  const open = harness({ info: { agentRoot: 'C:\\SSAM-Agent' } });
  const report = await hostedDoctor(null, { context: open.context, session: { agent: open.link } });
  assert.equal(report.ok, true, JSON.stringify(report.lanes));
  assert.equal(report.lanes.o11.ok, null, 'a lane this account does not have is information');
  assert.equal(report.lanes.odc.ok, true);
  assert.equal(report.agent.inbox, 'C:\\SSAM-Agent\\inbox');
  assert.equal(report.code, undefined);
  const closed = harness();
  closed.executor.call = async () => ({ processes: [] });
  const down = await hostedDoctor(null, { context: closed.context, session: { agent: closed.link } });
  assert.equal(down.ok, false);
  assert.equal(down.code, 'DOCTOR_LANE_UNUSABLE');
  assert.deepEqual(down.continuation.arguments, { lane: 'odc' });
  assert.equal(down.continuation.tool, 'ssam_connect');
  const gone = harness({ connected: false, info: { lastSeenAt: ago(3000) } });
  const reconnecting = await hostedDoctor(null, { context: gone.context, session: { agent: gone.link } });
  assert.equal(reconnecting.code, 'AGENT_RECONNECTING');
});

// ---- C04
test('C04: <name>.outsystems.dev has its Development origin derived (source derived-stage); anything else still needs the stage', () => {
  assert.equal(derivedStageOrigin('personal-ydhah6jj.outsystems.dev'), 'https://personal-ydhah6jj-dev.outsystems.app');
  assert.equal(derivedStageOrigin('acme.outsystems.dev', 'Production'), null);
  assert.equal(derivedStageOrigin('acme.example.com'), null);
  const links = applicationUrls({ app: 'Loja', screen: 'Home', host: 'personal-ydhah6jj.outsystems.dev' }, { tenants: {} });
  assert.equal(links.url, 'https://personal-ydhah6jj-dev.outsystems.app/Loja/Home');
  assert.equal(links.source, 'derived-stage');
  const configured = applicationUrls({ app: 'Loja', host: 'acme.outsystems.dev' }, { tenants: { 'acme.outsystems.dev': { stages: { Development: { domain: 'dev.acme.com' } } } } });
  assert.equal(configured.environment, 'https://dev.acme.com');
  assert.equal(configured.source, 'configured-stage');
  assert.throws(() => applicationUrls({ app: 'Loja', host: 'acme.example.com' }, { tenants: {} }), /No runtime origin/);
});

test('C04: the connected tenant goes to the customer\'s tenants.json with its derived Development stage; the owner\'s file is never written', async () => {
  const h = harness();
  const tenantsFile = path.join(h.workspace, 'odc', 'tenants.json');
  write(tenantsFile, JSON.stringify({ default: null, tenants: { 'kept.outsystems.dev': { stages: { Development: { domain: 'own.example.com' } } } } }));
  const recorded = runWithExecutor(h.context, () => recordConnectedTenants(['Personal-Abc.outsystems.dev', 'kept.outsystems.dev', 'corp.example.com']));
  assert.deepEqual(recorded, { written: ['personal-abc.outsystems.dev'], kept: ['kept.outsystems.dev', 'corp.example.com'] });
  const config = JSON.parse(fs.readFileSync(tenantsFile, 'utf8'));
  assert.deepEqual(config.tenants['personal-abc.outsystems.dev'].stages.Development, { domain: 'personal-abc-dev.outsystems.app', source: 'derived' });
  assert.equal(config.tenants['kept.outsystems.dev'].stages.Development.domain, 'own.example.com');
  assert.equal(config.default, null);
  assert.deepEqual(recordConnectedTenants(['x.outsystems.dev']), { written: [], kept: [] }, 'outside a hosted call nothing is written');
});

test('C04: the fragment preview renders the html of a job with its own CSS; expressions, blocks, lists, icons and images are marked; no script runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fase4-preview-'));
  try {
    write(path.join(dir, 'card.html'), '<div class="card"><h2>{{ Product.Name }}</h2><img src="Logo"><i icon="cart" weight="regular"></i></div>');
    const job = write(path.join(dir, 'job.json'), JSON.stringify({ ops: [
      { op: 'html', parent: '$home', html: '<style>.loja{color:red}</style><div class="loja {{ Css }}" onclick="Buy(1)"><Block name="Header" :Title="T" @Click="Go"><slot name="Title">t</slot></Block><div list="GetProducts.List" as="Row">{{ Row.Name }}</div><script>alert(1)</script><a href="Detail">d</a></div>' },
      { op: 'html', parent: '$detail', file: 'card.html' },
      { op: 'set', path: 'Theme:Loja', property: 'StyleSheet', value: '.card{border:1px solid}' }] }));
    const rendered = await renderFragmentPreview({ job, root: dir });
    assert.equal(rendered.ok, true);
    assert.deepEqual(rendered.fragments.map(f => [f.index, f.parent]), [[0, '$home'], [1, '$detail']]);
    const html = rendered.html;
    assert.match(html, /\.loja\{color:red\}/);
    assert.match(html, /\.card\{border:1px solid\}/);
    assert.match(html, /<span class="ssam-expr"[^>]*>Product\.Name<\/span>/);
    assert.match(html, /class="ssam-block"/);
    assert.match(html, /Block Header/);
    assert.match(html, /list GetProducts\.List as Row/);
    assert.match(html, /image Logo/);
    assert.match(html, /icon cart/);
    assert.doesNotMatch(html, /<script|onclick|alert\(1\)/);
    assert.match(html, /class="loja"/, 'the static part of a dynamic class stays');
    assert.match(html, /href="#"/);
    assert.equal((await renderFragmentPreview({ job: { ops: [{ op: 'set' }] } })).code, 'PREVIEW_NO_FRAGMENT');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('C04: a hosted delivery with html gets preview.html in its evidence and on the user\'s machine; a delivery without html is unchanged', async () => {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, info: { agentRoot: 'C:\\SSAM-Agent' } });
  const executor = new AgentExecutor({ link, workspace: dirs.workspace, o11: {} });
  const context = { hosted: true, tokenId: 'tok_test', workspace: dirs.workspace, agent: link, executor };
  const evidence = path.join(dirs.workspace, 'odc', 'lab', '07-loja');
  fs.mkdirSync(evidence, { recursive: true });
  const job = write(path.join(dirs.workspace, 'inbox', 'loja.json'), JSON.stringify({ ops: [{ op: 'html', parent: '$home', html: '<div>{{ X }}</div>' }] }));
  const report = await runWithExecutor(context, () => withFragmentPreview({ ok: true, job, evidence }));
  assert.equal(report.preview.file, path.join(evidence, 'preview.html'));
  assert.equal(report.preview.onUserMachine, 'C:\\SSAM-Agent\\odc\\lab\\07-loja\\preview.html');
  assert.match(link.readAgent('agent:odc/lab/07-loja/preview.html'), /ssam-expr/);
  const plain = { ok: true, job: write(path.join(dirs.workspace, 'inbox', 'plain.json'), JSON.stringify({ ops: [{ op: 'set' }] })), evidence };
  assert.equal((await runWithExecutor(context, () => withFragmentPreview(plain))).preview, undefined);
});

// ---- C14
function stage(sync) {
  const dirs = hostedDirs(os.tmpdir());
  const seen = [];
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, sync, handlers: { 'odc.pipe': (params, l) => { seen.push(params.args); return pipe(params.args, l); } } });
  let pipe = () => ({ line: '{}', paths: [] });
  const executor = new AgentExecutor({ link, workspace: dirs.workspace, o11: {} });
  const lab = path.join(dirs.workspace, 'odc', 'lab', '01-feature');
  const base = write(path.join(dirs.workspace, 'odc', 'snapshots', 'Orders-BASE.oml'), 'base');
  write(base + '.json', '{"module":"Orders"}');
  const candidate = write(path.join(lab, 'candidate.oml'), 'candidate');
  const receipt = write(path.join(lab, 'builder-receipt.json'), '{}');
  write(path.join(lab, 'kernel-result.json'), '{}');
  const manifestFile = write(path.join(lab, 'manifest.json'), JSON.stringify({ schema: 'odc3-manifest/1', module: 'Orders', basePath: base, candidatePath: candidate,
    builderReceipt: receipt, evidenceDir: path.join(lab, 'evidence') }, null, 2));
  return { ...dirs, link, executor, lab, manifestFile, seen, setPipe: fn => { pipe = fn; },
    merge: () => executor.call('odc.pipe', { pid: 4120, version: 'v35', args: ['merge', manifestFile] }) };
}
const mergeReply = (link, ok) => {
  for (const [name, text] of [['after-merge.oml', 'x'.repeat(4096)], ['match-tree.txt', 'tree'], ['second-pass-match-tree.txt', 'tree2'], ['merge-receipt.json', '{"merged":true}']])
    link.writeAgent('agent:odc/lab/01-feature/evidence/' + name, text);
  const value = { ok, outcome: ok ? 'merged' : 'uncertain', evidence: 'agent:odc/lab/01-feature/evidence', afterSnapshot: 'agent:odc/lab/01-feature/evidence/after-merge.oml' };
  return { line: JSON.stringify(value), paths: agentPaths(value) };
};

test('C14: with an agent 0.2.0 the inputs, the manifest and the rest of its folder go in ONE file.sync call; a successful merge leaves its heavy evidence on the agent', async () => {
  const h = stage(true);
  h.setPipe((args, link) => mergeReply(link, true));
  await h.merge();
  const syncs = h.link.calls.filter(c => c.kind === 'file.sync');
  assert.equal(syncs.length, 1, 'one call for the whole staging');
  assert.equal(h.link.calls.filter(c => c.kind === 'file.put').length, 0);
  assert.deepEqual(syncs[0].params.files.map(f => f.path).sort(), ['agent:odc/lab/01-feature/builder-receipt.json', 'agent:odc/lab/01-feature/candidate.oml',
    'agent:odc/lab/01-feature/kernel-result.json', 'agent:odc/lab/01-feature/manifest.json', 'agent:odc/snapshots/Orders-BASE.oml', 'agent:odc/snapshots/Orders-BASE.oml.json']);
  assert.equal(syncs[0].params.files.find(f => f.path.endsWith('kernel-result.json')).ifMissing, true, 'the rest of the folder never replaces what the agent has');
  const got = h.link.gets.map(g => path.basename(g.path));
  assert.ok(got.includes('merge-receipt.json'));
  for (const heavy of ['after-merge.oml', 'match-tree.txt', 'second-pass-match-tree.txt']) assert.ok(!got.includes(heavy), heavy + ' stays on the agent');
  assert.deepEqual(h.link.released, [], 'every file was new to the agent');
  await h.merge();
  assert.equal(h.link.calls.filter(c => c.kind === 'file.sync').length, 2);
  assert.ok(h.link.released.length >= 5, 'the transfers the agent skipped are released at once: ' + h.link.released.length);

  const failed = stage(true);
  failed.setPipe((args, link) => mergeReply(link, false));
  await failed.merge();
  const all = failed.link.gets.map(g => path.basename(g.path));
  for (const heavy of ['after-merge.oml', 'match-tree.txt', 'second-pass-match-tree.txt']) assert.ok(all.includes(heavy), heavy + ' comes back after a failed merge');
});

test('C14: an agent before 0.2.0 keeps the old staging (file.put each, the folder listed); a skipped put releases its transfer', async () => {
  const h = stage(false);
  h.setPipe((args, link) => mergeReply(link, true));
  await h.merge();
  assert.equal(h.link.calls.filter(c => c.kind === 'file.sync').length, 0);
  assert.ok(h.link.calls.filter(c => c.kind === 'file.put').length >= 4);
  await h.merge().catch(() => {});
  assert.ok(h.link.released.length >= 1);
});

// ---- warm
test('warm: the server warm-up builds the indexes of its lanes, then warms the ODC delivery processes; after a hosted delivery at most once a minute', async () => {
  const events = [];
  const result = await warmServer({ lanes: ['odc', 'o11'], log: e => events.push(e), indexes: async ({ lanes }) => ({ ok: true, lanes }), processes: async () => ({ builder: { ok: true }, worker: { ok: true } }) });
  assert.deepEqual(result.indexes, { ok: true, lanes: ['odc', 'o11'] });
  assert.deepEqual(result.delivery, { builder: { ok: true }, worker: { ok: true } });
  assert.equal(events[0].event, 'warm');
  assert.equal((await warmServer({ lanes: ['o11'], indexes: async () => ({ ok: true }) })).delivery, undefined, 'no ODC lane: no ODC processes');
  let warmed = 0, t = 1000000;
  const options = { now: () => t, warm: async () => { warmed++; }, env: {} };
  assert.equal(warmSoon(options), false, 'outside a hosted call the owner\'s own warm-up applies');
  const h = harness();
  assert.equal(runWithExecutor(h.context, () => warmSoon(options)), true);
  assert.equal(runWithExecutor(h.context, () => warmSoon(options)), false, 'at most once a minute');
  t += 61000;
  assert.equal(runWithExecutor(h.context, () => warmSoon({ ...options, env: { SSAM_NO_WARM: '1' } })), false);
  assert.equal(runWithExecutor(h.context, () => warmSoon(options)), true);
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(warmed, 2);
});

// ---- C03 logs and C33 audit: the flush of a tool answer is logged with its time; an answer with ok:false is a failure.
test('C03: the server logs when the answer of a tool call left it (mcp-response-flushed), and the audit counts ok:false as a failure', async () => {
  const { startHttpServer, outcomeOf } = await import('../http-server.mjs');
  const { createTokenStore } = await import('../server-tokens.mjs');
  const { McpServer } = await import('@modelcontextprotocol/server');
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  assert.deepEqual(outcomeOf({ result: { structuredContent: { ok: false, code: 'AGENT_RECONNECTING' } } }), { ok: false, error: 'AGENT_RECONNECTING' });
  assert.deepEqual(outcomeOf({ result: { structuredContent: { ok: true } } }), { ok: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fase4-http-'));
  const events = [];
  const handle = await startHttpServer({ dir, port: 0, log: e => events.push(e), createServer: async () => {
    const server = new McpServer({ name: 'flush', version: '1.0.0' });
    server.registerTool('echo', { description: 'echo' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    return server;
  } });
  try {
    const { token } = createTokenStore(dir).issue({ customer: 'Flush' });
    const client = new Client({ name: 'fase4-http', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    await client.callTool({ name: 'echo', arguments: {} });
    await client.close();
    const flushed = events.find(e => e.event === 'mcp-response-flushed');
    assert.ok(flushed, JSON.stringify(events.map(e => e.event)));
    assert.deepEqual(flushed.tools, ['echo']);
    assert.ok(Number.isFinite(flushed.ms) && flushed.bytes > 0);
  } finally { await handle.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});