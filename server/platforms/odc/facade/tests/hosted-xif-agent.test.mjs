// F4 of PLANO-11H (criterion C4): o11_extension on a hosted server, its two Integration Studio stages (model, final) run on
// the user's machine through the SSAM agent (kind o11.xif). What is tested here, with a fake AgentLink and loopback ports
// only (no hub, no kernel process, no Studio, no Integration Studio):
//   - the gate: an agent whose Hello lists o11.xif reaches the tool; any other keeps the answer of before (HOSTED_UNAVAILABLE,
//     cause XIF_ENGINE_WINDOWS_ONLY), saying which agent version it needs;
//   - the hop (hosted/xif-stage.mjs through the AgentExecutor and the relay method xif_engine): the files the engine reads
//     go to the agent by sha256 under agent:o11/xif/<id>/, no server path reaches the agent, the XIF comes back checked;
//   - end to end: create -> model -> final -> publish -> reference, the kernel's relay client standing in for XifEngineClient;
//   - negatives: an agent without the kind, no Integration Studio on the user's machine, a build failure, a path escape, a
//     XIF that is not the one the agent reported.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AgentExecutor } from '../hosted/agent-executor.mjs';
import { XIF_METHOD } from '../hosted/o11-relay.mjs';
import { stageXif, XIF_KIND } from '../hosted/xif-stage.mjs';
import { refusalBeforeAgent, wrapHostedTool, hostedTools } from '../hosted/policy.mjs';
import { CALL_KINDS, HELLO_ONLY_KINDS } from '../call-kinds.mjs';
import { runWithExecutor } from '../executor.mjs';
import { createO11Extension } from '../o11-extension.mjs';
import { CAPABILITY } from '../service-center/integration-studio.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HOST = 'lab.example.com';
const NAME = 'ZZHybridXifLab';
const WORDS = 'sim, pode publicar a extensão ZZHybridXifLab no lab';
const SPEC = { name: NAME, actions: [{ name: 'Add', inputs: [{ name: 'Left', type: 'Integer' }], outputs: [{ name: 'Result', type: 'Integer' }], body: 'Result = Left;' }] };

// The user's agent: o11.xif writes the XIF the stage asked for (from what it received), or answers what fail says.
function xifAgent({ fail = null, wrongSha = false } = {}) {
  const seen = [];
  return {
    seen,
    handler: (params, link) => {
      seen.push(structuredClone(params));
      if (fail) return fail;
      for (const file of [params.base, params.model, params.dll, ...(params.references ?? []), ...(params.sources ?? []).map(s => s.file)].filter(Boolean))
        assert.ok(fs.existsSync(link.agentFile(file)), 'the agent has ' + file + ' before the stage runs');
      const bytes = Buffer.from('XIF ' + params.command + ' ' + (params.spec?.name ?? params.name));
      link.writeAgent(params.output, bytes);
      return { ok: true, xif: params.output, sha256: wrongSha ? 'f'.repeat(64) : sha(bytes), studio: { version: '11.14.25.134', lastUpgradeVersion: '11.0.0.200', dir: 'C:\\Program Files\\OutSystems\\Integration Studio' }, reports: [] };
    },
  };
}

async function customer(t, { kinds = true, agent = xifAgent(), bridge } = {}) {
  const dirs = hostedDirs(os.tmpdir());
  const key = randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(dirs.workspace, 'state', 'relay-authority', 'bridge.key'), key);
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, sync: true, handlers: { [XIF_KIND]: agent.handler, ...(bridge ? { 'o11.bridge': bridge } : {}) } });
  const base = link.supports;
  link.supports = kind => (kind === XIF_KIND ? kinds : base(kind));
  const executor = new AgentExecutor({ link, workspace: dirs.workspace, o11: { studioDir: 'C:\\Kernel', lane: 'ss4' } });
  await executor.start();
  t.after(() => executor.close());
  return { ...dirs, key, link, executor, agent, port: executor.relayPort() };
}

// The kernel's side of the relay (XifEngineClient.RunRelay): one line out, one line back.
const relayStage = (port, authorization, params) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: '127.0.0.1', port }, () => socket.write(JSON.stringify({ method: XIF_METHOD, params, authorization }) + '\n'));
  let text = '';
  socket.on('data', chunk => { text += chunk.toString('utf8'); });
  socket.on('end', () => { try { resolve(JSON.parse(text.trim())); } catch (error) { reject(error); } });
  socket.on('error', reject);
});
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };

test('the kind is the last of the closed list and is sent only to an agent whose Hello lists it', () => {
  assert.equal(CALL_KINDS.at(-1), XIF_KIND);
  assert.ok(HELLO_ONLY_KINDS.has(XIF_KIND));
});

test('the gate: an agent that runs o11.xif reaches o11_extension; any other keeps the answer of before, which names the agent it needs', async () => {
  const entry = hostedTools().o11_extension;
  assert.equal(entry.class, 'agent'); assert.equal(entry.kind, XIF_KIND); assert.equal(entry.lane, 'o11');
  const args = { action: 'publish', host: HOST, spec: SPEC };
  const served = refusalBeforeAgent('o11_extension', args, { entry, lanes: ['o11'], supports: kind => kind === XIF_KIND });
  assert.equal(served.refusal, undefined); assert.equal(served.need, 'always');
  for (const supports of [null, () => false, kind => kind === 'o11.users', () => { throw new Error('no hello'); }]) {
    let ran = false;
    const gated = wrapHostedTool('o11_extension', { inputSchema: {} }, async () => { ran = true; return { content: [] }; },
      { context: { workspace: '/data/server/ws/acme', lanes: ['odc', 'o11'], agent: { info: () => ({ agentVersion: '0.4.0-native' }), connected: () => true, ...(supports ? { supports } : {}) } } });
    const answer = await gated(args, {});
    assert.equal(ran, false);
    const value = answer.structuredContent;
    assert.equal(value.code, 'HOSTED_UNAVAILABLE'); assert.equal(value.cause, 'XIF_ENGINE_WINDOWS_ONLY');
    assert.match(value.error, /does not build extensions yet/); assert.match(value.error, /Install the current SSAM Agent app/);
    assert.equal(value.continuation.tool, 'ssam_discover');
  }
});

test('the hop of a model stage: the files go to the agent under agent:o11/xif/<id>/, no server path reaches it, the XIF comes back checked', async t => {
  const c = await customer(t);
  const work = path.join(c.workspace, 'o11', '.local', 'xif', 'work', HOST, NAME, 'w1');
  const dll = write(path.join(c.workspace, 'o11', 'libs', 'Vendor.Lib.dll'), 'vendor');
  const notes = write(path.join(c.workspace, 'o11', 'libs', 'notes.txt'), 'notes');
  const output = path.join(work, 'model', NAME + '.xif');
  const request = { command: 'model', work, output, references: [dll],
    spec: { ...SPEC, references: [dll], sources: [{ path: 'Helpers.cs', file: notes }], resources: [{ path: 'Data\\notes.txt', file: notes, deploy: 'Ignore' }] } };
  const answer = await relayStage(c.port, c.key, request);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.xif, output); assert.equal(answer.sha256, sha(fs.readFileSync(output)));
  assert.deepEqual(answer.studio, { version: '11.14.25.134', lastUpgradeVersion: '11.0.0.200' }, 'no folder of the user\'s machine');
  const [sent] = c.agent.seen;
  assert.match(sent.output, /^agent:o11\/xif\/[0-9a-f]{8,16}\/out\/ZZHybridXifLab\.xif$/);
  assert.match(sent.references[0], /^agent:o11\/xif\/[0-9a-f]+\/in\/\d+\/Vendor\.Lib\.dll$/, 'the file name the engine names the resource by');
  assert.equal(sent.spec.references, undefined); assert.equal(sent.spec.sources, undefined);
  assert.match(sent.spec.resources[0].file, /^agent:o11\/xif\//);
  assert.ok(!JSON.stringify(sent).includes(c.workspace) && !JSON.stringify(sent).includes(c.root), 'no path of this server reaches the agent');
  assert.equal(sent.work, undefined, 'the work folder is the agent\'s own');
});

test('the hop of a final stage maps the model, the DLL and the merged sources; a source path inside the XIF stays relative', async t => {
  const c = await customer(t);
  const work = path.join(c.workspace, 'o11', '.local', 'xif', 'work', 'w2');
  const model = write(path.join(work, 'model', NAME + '.xif'), 'model');
  const dll = write(path.join(work, 'out', 'OutSystems.NssZZHybridXifLab.dll'), 'dll');
  const source = write(path.join(work, 'out', 'source', 'Source', 'NET', NAME + '.cs'), 'class X {}');
  const answer = await relayStage(c.port, c.key, { command: 'final', work, model, dll, name: NAME, output: path.join(work, 'final', NAME + '.xif'),
    sources: [{ path: 'Source\\NET\\' + NAME + '.cs', file: source }] });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const [sent] = c.agent.seen;
  assert.equal(sent.sources[0].path, 'Source\\NET\\' + NAME + '.cs');
  assert.match(sent.dll, /\/OutSystems\.NssZZHybridXifLab\.dll$/);
  assert.equal(fs.readFileSync(path.join(work, 'final', NAME + '.xif'), 'utf8'), 'XIF final ' + NAME);
  const bad = await relayStage(c.port, c.key, { command: 'final', work, model, dll, name: NAME, output: path.join(work, 'final2', NAME + '.xif'),
    sources: [{ path: '..\\..\\escape.cs', file: source }] });
  assert.equal(bad.ok, false); assert.equal(bad.code, 'PARAMS_INVALID');
});

test('negatives of the hop: no kind, no Integration Studio, a build failure, a path escape, a XIF that is not the reported one', async t => {
  const stage = c => ({ command: 'model', work: path.join(c.workspace, 'o11', 'w'), output: path.join(c.workspace, 'o11', 'w', 'model', NAME + '.xif'), references: [], spec: SPEC });
  // An agent without the kind: nothing is sent to it.
  const old = await customer(t, { kinds: false });
  const refused = await relayStage(old.port, old.key, stage(old));
  assert.equal(refused.code, 'XIF_AGENT_UPDATE_REQUIRED'); assert.match(refused.error, /Install the current SSAM Agent app/);
  assert.equal(old.link.calls.filter(call => call.kind === XIF_KIND).length, 0);
  // No Integration Studio on the user's machine: the agent's code and fix pass.
  const none = await customer(t, { agent: xifAgent({ fail: { ok: false, code: 'XIF_ENGINE_UNAVAILABLE', error: 'Integration Studio 11 is not installed on the machine of the SSAM agent; nothing was generated or sent.',
    problems: [{ code: 'XIF_ENGINE_UNAVAILABLE', message: 'Integration Studio 11 is not installed.', fix: 'Install Integration Studio 11 (Development Environment installer), then call again.' }], nativeWork: 'C:\\Users\\someone\\AppData' } }) });
  const missing = await relayStage(none.port, none.key, stage(none));
  assert.equal(missing.code, 'XIF_ENGINE_UNAVAILABLE'); assert.match(missing.problems[0].fix, /Install Integration Studio 11/);
  assert.equal(missing.nativeWork, undefined, 'nothing else of the agent\'s answer');
  // A build failure (ProjectVerify).
  const failing = await customer(t, { agent: xifAgent({ fail: { ok: false, code: 'XIF_VERIFY_FAILED', error: 'ProjectVerify reported 1 error.', problems: [{ code: 'XIF_VERIFY_FAILED', path: 'Add', message: 'Invalid name.' }] } }) });
  const verify = await relayStage(failing.port, failing.key, stage(failing));
  assert.equal(verify.code, 'XIF_VERIFY_FAILED'); assert.equal(verify.problems[0].path, 'Add');
  // A file outside this account's workspace: refused before anything reaches the agent.
  const escape = await customer(t);
  const outside = write(path.join(escape.root, 'elsewhere', 'Secret.dll'), 'secret');
  const escaped = await relayStage(escape.port, escape.key, { ...stage(escape), references: [outside] });
  assert.equal(escaped.code, 'PATH_OUTSIDE_WORKSPACE');
  assert.equal(escape.link.calls.length, 0, 'no call at all, not even a file.put');
  // The agent reports a sha256 the XIF does not have.
  const lying = await customer(t, { agent: xifAgent({ wrongSha: true }) });
  const mismatch = await relayStage(lying.port, lying.key, stage(lying));
  assert.equal(mismatch.code, 'AGENT_PROTOCOL_VIOLATION');
  assert.ok(!fs.existsSync(stage(lying).output), 'nothing is handed to the kernel');
});

test('stageXif refuses a command other than model or final and an invalid extension name', async () => {
  await assert.rejects(stageXif({ command: 'probe', output: '/x/y.xif' }, {}), { code: 'PARAMS_INVALID' });
  await assert.rejects(stageXif({ command: 'model', output: path.resolve('y.xif'), spec: { name: '../x' } }, { classify: () => ({ visible: true }), inputPlan: async () => ({ puts: [] }) }), { code: 'PARAMS_INVALID' });
});

// ---- end to end: create -> model -> final -> publish -> reference, hosted.
function environment(reads) {
  const bridge = {
    supports: async () => true,
    session: async host => ({ studio: { signedIn: true, host, user: 'lab-user' }, web: {} }),
    capabilities: async () => new Set(['sc_api:soap', 'sc_api:server-api', 'sc_api:sc-rest', CAPABILITY]),
    api: async (host, surface, operation, args) => {
      reads.push({ surface, operation, args });
      const bytes = text => ({ bytes: text.length, sha256: sha(Buffer.from(text)), base64: Buffer.from(text).toString('base64'), meta: { messages: [], errors: 0 } });
      switch (surface + ':' + operation) {
        case 'soap:ListExtensions': return { ok: true, result: [] };
        case 'soap:ListEspaces': return { ok: true, result: [] };
        case 'integration-studio:Handshake': return { ok: true, result: { ok: true, platform: '11.38.0' } };
        case 'integration-studio:GenerateSourceCodeStubs': return { ok: true, result: bytes('PK-stubs') };
        case 'integration-studio:GetSourceCodeDependencies': return { ok: true, result: bytes('PK-deps') };
        case 'integration-studio:UploadNeeded': return { ok: true, result: { needs: true, extensionId: 0, equalVersionId: 0, runningVersionId: 0 } };
        default: throw new Error('unexpected ' + surface + ':' + operation);
      }
    },
  };
  return bridge;
}

test('end to end hosted: create, model and final on the agent, publish through the Service Center, then the reference job', async t => {
  const c = await customer(t);
  const reads = [], kernel = [], published = [];
  // The kernel: check answers ok; each build stage goes through the relay as XifEngineClient.RunRelay sends it.
  const runAnvil = async args => {
    kernel.push(args);
    const opt = name => args[args.indexOf(name) + 1];
    let data;
    if (args[1] === 'check') data = { ok: true, spec: SPEC, create: true };
    else if (opt('--stage') === 'model') {
      const work = opt('--work');
      const answer = await relayStage(c.port, c.key, { command: 'model', work, spec: SPEC, output: path.join(work, 'model', NAME + '.xif'), references: [] });
      data = answer.ok ? { ok: true, stage: 'model', xif: answer.xif, name: NAME, key: 'ext-key-1', hash: 'h1', engine: answer.studio } : answer;
    } else {
      const work = opt('--work');
      assert.ok(fs.existsSync(opt('--stubs')) && fs.existsSync(opt('--deps')), 'the stubs and the platform DLLs came back in the reply and were written in the workspace');
      const dll = write(path.join(work, 'out', 'OutSystems.Nss' + NAME + '.dll'), 'compiled');
      const source = write(path.join(work, 'out', 'source', 'Source', 'NET', NAME + '.cs'), 'merged');
      const answer = await relayStage(c.port, c.key, { command: 'final', work, model: opt('--model'), dll, name: NAME, output: path.join(work, 'final', NAME + '.xif'),
        sources: [{ path: 'Source\\NET\\' + NAME + '.cs', file: source }] });
      data = answer.ok ? { ok: true, stage: 'final', xif: answer.xif, xifSha256: answer.sha256, dllSha256: sha('compiled'), hash: 'h2', key: 'ext-key-1', name: NAME } : answer;
    }
    return { ok: data.ok !== false, exitCode: 0, envelope: { ok: true, command: 'xif', data } };
  };
  const serviceCenter = async argv => { published.push(argv); return { ok: true, state: 'confirmed', extensionId: 41, extensionVersionId: 1 }; };
  const run = createO11Extension({ runAnvil, serviceCenter, locate: async () => environment(reads), hostClass: () => 'personal', now: () => new Date('2026-11-02T05:00:00Z') });
  const context = { hosted: true, id: 'ctx-xif', tokenId: 'tok_test', lanes: ['o11'], workspace: c.workspace, agent: c.link, executor: c.executor, close: async () => {} };
  const value = await runWithExecutor(context, () => run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS }));
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.state, 'created');
  // model then final on the user's machine, nothing else of the engine.
  assert.deepEqual(c.agent.seen.map(s => s.command), ['model', 'final']);
  // The environment reads: no outFile ever leaves this server; the files came back in the reply.
  assert.ok(reads.every(r => r.args?.outFile === undefined), 'no outFile in hosted reads');
  // The publication: one extension-publish with the final XIF of this account's workspace.
  assert.equal(published.length, 1);
  const xifFile = published[0].find(a => a.startsWith('--xif-file=')).slice('--xif-file='.length);
  assert.ok(xifFile.startsWith(path.join(c.workspace, 'o11', '.local', 'xif')), 'the final XIF is in this account\'s workspace: ' + xifFile);
  assert.equal(fs.readFileSync(xifFile, 'utf8'), 'XIF final ' + NAME);
  // The receipt, the platform DLLs and the producer ledger are this account's.
  assert.ok(fs.existsSync(path.join(c.workspace, 'o11', '.local', 'xif', 'receipts', value.operationId + '.json')));
  assert.equal(fs.readdirSync(path.join(c.workspace, 'o11', '.local', 'xif-deps', HOST, '11.38.0')).length, 1);
  // Then the reference: the continuation is the existing reference job, its file in the workspace.
  assert.equal(value.continuation.tool, 'ssam_job');
  assert.deepEqual(value.continuation.arguments.captureProducers, [NAME]);
  assert.deepEqual(value.referenceJob.ops, [{ op: 'reference', producer: NAME, elements: ['IServerActionSignature:Add'] }]);
  assert.ok(value.continuation.arguments.job.startsWith(c.workspace));
});

test('hosted: a spec that names a file outside the workspace (in any shape, specFile included) is refused before the kernel', async t => {
  const c = await customer(t);
  const kernel = [];
  const run = createO11Extension({ runAnvil: async args => { kernel.push(args); return { ok: true, envelope: { ok: true, data: { ok: true } } }; }, locate: async () => environment([]), hostClass: () => 'personal' });
  const context = { hosted: true, id: 'ctx-xif2', tokenId: 'tok_test', lanes: ['o11'], workspace: c.workspace, agent: c.link, executor: c.executor, close: async () => {} };
  const outside = write(path.join(c.root, 'other', 'Lib.dll'), 'x');
  for (const spec of [{ ...SPEC, references: outside }, { ...SPEC, references: [outside] }, { ...SPEC, resources: { path: 'a.txt', file: outside } }, { ...SPEC, sources: [{ path: 'A.cs', file: 'C:\\Windows\\win.ini' }] }]) {
    const value = await runWithExecutor(context, () => run({ action: 'publish', host: HOST, spec, words: WORDS }));
    assert.equal(value.code, 'PATH_OUTSIDE_WORKSPACE', JSON.stringify(value));
  }
  const specFile = write(path.join(c.workspace, 'o11', 'spec.json'), JSON.stringify({ ...SPEC, references: [outside] }));
  const fromFile = await runWithExecutor(context, () => run({ action: 'publish', host: HOST, specFile, words: WORDS }));
  assert.equal(fromFile.code, 'PATH_OUTSIDE_WORKSPACE');
  assert.equal(kernel.length, 0, 'the kernel never read them');
  const inside = write(path.join(c.workspace, 'o11', 'libs', 'Ok.dll'), 'ok');
  const passes = await runWithExecutor(context, () => run({ action: 'publish', host: HOST, spec: { ...SPEC, references: ['ws:o11/libs/Ok.dll'] }, words: WORDS }));
  assert.notEqual(passes.code, 'PATH_OUTSIDE_WORKSPACE');
  const checked = JSON.parse(fs.readFileSync(kernel[0][kernel[0].indexOf('--spec') + 1], 'utf8'));
  assert.deepEqual(checked.references, [inside], 'ws: resolved inside the workspace');
});
