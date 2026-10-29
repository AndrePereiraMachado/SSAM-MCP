// The TEMP of every hosted process (fase4-28 R1, review item F1): one folder per lane and backend of the server, inside
// the area the agent mirror takes, checked when a hosted context starts. The kernel hands files of its TEMP to the
// customer's bridge (ThinBridge.Find: snapshot_module <TEMP>/thin-bridge/<guid>.oml for each delivery check after the
// merge; Publisher.DownloadBytes: environment_session download into <TEMP>/sshedless-dl; a kernel file there as a
// merge_from_oml input). Here each of those calls is relayed by the real AgentExecutor with the TEMP hostedSpawnEnv gives
// the kernel, with and without SSAM_BACKEND_NAME (the production servers set it). Fake AgentLink only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentExecutor } from '../hosted/agent-executor.mjs';
import { Mirror } from '../hosted/mirror.mjs';
import { hostedSpawnEnv, runWithExecutor, prepareWorkspace } from '../executor.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs, agentPaths } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const BACKENDS = [undefined, 'o11-11.55.93-odc-1.7.29', 'o11-11.55.92-odc-1.7.28'];
function withBackend(name, fn) {
  const saved = process.env.SSAM_BACKEND_NAME;
  if (name === undefined) delete process.env.SSAM_BACKEND_NAME; else process.env.SSAM_BACKEND_NAME = name;
  try { return fn(); } finally { if (saved === undefined) delete process.env.SSAM_BACKEND_NAME; else process.env.SSAM_BACKEND_NAME = saved; }
}
// The relay of a hosted context: the AgentExecutor of the customer, and the spawn environment of the kernel it serves.
function setup() {
  const dirs = hostedDirs(os.tmpdir());
  prepareWorkspace(dirs.workspace);
  const seen = [];
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, handlers: { 'o11.bridge': (params, l) => {
    seen.push(params);
    const p = params.params ?? {};
    let reply = { success: true, data: {} };
    if (params.method === 'snapshot_module') { l.writeAgent(p.path, 'snapshot'); reply = { success: true, data: { path: p.path, key: 'k1' } }; }
    if (params.method === 'environment_session') { const file = p.arguments.outputDirectory + '/Orders.oml'; l.writeAgent(file, 'downloaded');
      reply = { success: true, data: { value: { Name: 'Orders', FilePath: file } } }; }
    return { reply, paths: agentPaths(reply) };
  } } });
  const executor = new AgentExecutor({ link, workspace: dirs.workspace, o11: { studioDir: 'C:\\Kernel\\Service Studio', lane: 'ss4' } });
  const context = { id: randomUUID(), hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link,
    executor: { call: async () => ({}), o11Connection: () => null, relayPort: () => 47002 }, o11: { studioDir: 'C:\\Kernel\\Service Studio', lane: 'ss4' }, close: async () => {} };
  const tempOf = lane => runWithExecutor(context, () => hostedSpawnEnv(lane).env);
  const bridge = (method, params) => executor.call('o11.bridge', { method, params, port: 4516 });
  return { ...dirs, link, executor, seen, tempOf, bridge };
}

for (const backend of BACKENDS) {
  test('o11 TEMP' + (backend ? ' with SSAM_BACKEND_NAME=' + backend : ' without SSAM_BACKEND_NAME') + ': every kernel file of TEMP reaches the bridge through the mirror', async () => {
    const h = setup();
    const env = withBackend(backend, () => h.tempOf('o11'));
    assert.equal(env.TMP, env.TEMP); assert.equal(env.TMPDIR, env.TEMP, 'TMPDIR: the temp folder of .NET on Linux');
    const rel = path.relative(h.workspace, env.TEMP).split(path.sep).join('/');
    // ThinBridge.Find (each delivery check after the merge): snapshot_module into <TEMP>/thin-bridge/<guid>.oml. Before
    // fase4-28 the multi-version server put TEMP in state/versions/<backend>/<lane>/tmp: PATH_OUTSIDE_WORKSPACE here.
    const shot = path.join(env.TEMP, 'thin-bridge', randomUUID().replace(/-/g, '') + '.oml');
    const value = await h.bridge('snapshot_module', { path: shot, module_key: 'k1' });
    assert.equal(h.seen.at(-1).params.path, 'agent:' + rel + '/thin-bridge/' + path.basename(shot));
    assert.equal(value.reply.data.path, shot);
    assert.equal(fs.readFileSync(shot, 'utf8'), 'snapshot');
    // Publisher.DownloadBytes: environment_session download into <TEMP>/sshedless-dl.
    const downloads = path.join(env.TEMP, 'sshedless-dl');
    const downloaded = await h.bridge('environment_session', { operation: 'download', arguments: { module: 'Orders', outputDirectory: downloads } });
    assert.equal(h.seen.at(-1).params.arguments.outputDirectory, 'agent:' + rel + '/sshedless-dl');
    assert.equal(fs.readFileSync(downloaded.reply.data.value.FilePath, 'utf8'), 'downloaded');
    // Any kernel file of TEMP as a bridge input (merge_from_oml).
    const candidate = path.join(env.TEMP, 'candidate.oml');
    fs.writeFileSync(candidate, 'candidate');
    await h.bridge('merge_from_oml', { foreign_path: candidate, module_key: 'k1' });
    assert.equal(h.seen.at(-1).params.foreign_path, 'agent:' + rel + '/candidate.oml');
    assert.equal(h.link.readAgent('agent:' + rel + '/candidate.oml'), 'candidate');
    const expected = backend ? path.join(h.workspace, 'o11', 'tmp', 'versions', backend) : path.join(h.workspace, 'o11', 'tmp');
    assert.equal(env.TEMP, expected, 'one folder per lane and backend, inside ws:o11/');
  });
}

test('the ODC TEMP stays in the visible area and is never a folder the agent may name; an input from it is staged', async () => {
  for (const backend of BACKENDS) {
    const h = setup();
    const env = withBackend(backend, () => h.tempOf('odc'));
    assert.equal(env.TEMP, backend ? path.join(h.workspace, 'odc', 'tmp', 'versions', backend) : path.join(h.workspace, 'odc', 'tmp'));
    const mirror = new Mirror({ workspace: h.workspace, link: h.link });
    const where = mirror.classify(env.TEMP);
    assert.equal(where.visible, true); assert.equal(where.writable, false);
    const file = path.join(env.TEMP, 'anvil-odc-work', 'base.oml');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'odc base');
    const plan = await mirror.inputPlan(file, 'odc');
    assert.match(plan.target, /^agent:odc\/journal\/staging\/[0-9a-f]{64}\.oml$/);
  }
});

test('two backends of one customer never share a TEMP, in either lane', () => {
  const h = setup();
  for (const lane of ['o11', 'odc']) {
    const [a, b] = BACKENDS.slice(1).map(name => withBackend(name, () => h.tempOf(lane).TEMP));
    assert.notEqual(a, b);
    assert.ok(fs.existsSync(a) && fs.existsSync(b));
  }
});

test('a TEMP the mirror does not take fails closed with HOSTED_TEMP_OUTSIDE_MIRROR at the start of the context and before any spawn', () => {
  const h = setup();
  // ws:o11/tmp turned into a link that leads out of the workspace: the mirror refuses everything under it.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-temp-outside-'));
  try {
    fs.rmSync(path.join(h.workspace, 'o11', 'tmp'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(h.workspace, 'o11', 'tmp'), 'junction');
    const refused = error => { assert.equal(error.code, 'HOSTED_TEMP_OUTSIDE_MIRROR', error.message); assert.equal(error.executed, false); assert.equal(error.continuation?.tool, 'ssam_doctor'); return true; };
    assert.throws(() => prepareWorkspace(h.workspace), refused);
    assert.throws(() => h.tempOf('o11'), refused);
    assert.deepEqual(fs.readdirSync(outside), [], 'a rejected TEMP creates no folders outside the mirror');
  } finally {
    const link = path.join(h.workspace, 'o11', 'tmp');
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* removed */ } }
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
