// F4 review (M2, A1, A2, M3, B4): o11_extension through the REAL hosted path: createSsamServer with a hosted context, so the
// call passes the gate (kind, lane, agent, O11 connection), the path resolution of tools.json and the presenter; the agent
// is a fake AgentLink behind the real AgentExecutor, relay and xif stage; the kernel is a fake that sends its engine stages
// through the relay as XifEngineClient.RunRelay does. Covered: create, edit of an existing extension (its base downloaded in
// base64 and given to the model stage), referencesFrom, consumers:true; the shapes of a spec file outside the workspace;
// no server path in any answer; the Linux path of a merged source; the hosted inline limit and the sha256 of a download.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { AgentExecutor } from '../hosted/agent-executor.mjs';
import { XIF_METHOD } from '../hosted/o11-relay.mjs';
import { XIF_KIND, fileName, stageXif } from '../hosted/xif-stage.mjs';
import { runWithExecutor } from '../executor.mjs';
import { createSsamServer } from '../ssam.mjs';
import { serverRoots } from '../hosted/policy.mjs';
import { CAPABILITY, binaryRead, HOSTED_FILE_TOO_LARGE } from '../service-center/integration-studio.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HOST = 'lab.example.com';
const NAME = 'ZZHybridXifLab';
const WORDS = 'sim, pode publicar a extensão ZZHybridXifLab e o Orders_CS no lab';
const SPEC = { name: NAME, actions: [{ name: 'Add', inputs: [{ name: 'Left', type: 'Integer' }], outputs: [{ name: 'Result', type: 'Integer' }], body: 'Result = Left;' }] };
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
const relayStage = (port, authorization, params) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: '127.0.0.1', port }, () => socket.write(JSON.stringify({ method: XIF_METHOD, params, authorization }) + '\n'));
  let text = '';
  socket.on('data', chunk => { text += chunk.toString('utf8'); });
  socket.on('end', () => { try { resolve(JSON.parse(text.trim())); } catch (error) { reject(error); } });
  socket.on('error', reject);
});

// The environment as the thin bridge answers it without outFile (base64 + sha256).
function environment(state) {
  const binary = bytes => ({ bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64'), meta: { messages: [], errors: 0 } });
  return {
    supports: async () => true,
    session: async host => ({ studio: { signedIn: true, host, user: 'lab-user' }, web: {} }),
    capabilities: async () => new Set(['sc_api:soap', 'sc_api:server-api', 'sc_api:sc-rest', CAPABILITY]),
    api: async (host, surface, operation, args) => {
      state.reads.push({ surface, operation, args });
      switch (surface + ':' + operation) {
        case 'soap:ListExtensions': return { ok: true, result: state.extensions };
        case 'soap:ListEspaces': return { ok: true, result: [] };
        case 'soap:DownloadExtension': return { ok: true, result: binary(Buffer.from('XIF of ' + args.extensionKey)) };
        case 'soap:GetConsumers': return { ok: true, result: [] };
        case 'integration-studio:Handshake': return { ok: true, result: { ok: true, platform: '11.38.0' } };
        case 'integration-studio:GenerateSourceCodeStubs': return { ok: true, result: binary(Buffer.from('PK-stubs')) };
        case 'integration-studio:GetSourceCodeDependencies': return { ok: true, result: binary(Buffer.from('PK-deps')) };
        case 'integration-studio:UploadNeeded': return { ok: true, result: { needs: true, extensionId: 0, equalVersionId: 0, runningVersionId: 0 } };
        default: throw new Error('unexpected ' + surface + ':' + operation);
      }
    },
  };
}

async function served(t, { extensions = [], kinds = true } = {}) {
  const dirs = hostedDirs(os.tmpdir());
  const key = randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(dirs.workspace, 'state', 'relay-authority', 'bridge.key'), key);
  const seen = [];
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, sync: true, handlers: { [XIF_KIND]: (params, l) => {
    seen.push(structuredClone(params));
    const bytes = Buffer.from('XIF ' + params.command + ' ' + (params.spec?.name ?? params.name));
    l.writeAgent(params.output, bytes);
    return { ok: true, xif: params.output, sha256: sha(bytes), studio: { version: '11.14.25.134', lastUpgradeVersion: '11.0.0.200' }, reports: [] };
  } } });
  const base = link.supports;
  link.supports = kind => (kind === XIF_KIND ? kinds : base(kind));
  link.setInfo({ o11Connection: { pid: 4242, startedUtc: '2026-11-02T00:00:00.000Z', studioVersion: '11.55.91.65012' } });
  const executor = new AgentExecutor({ link, workspace: dirs.workspace, o11: { studioDir: 'C:\\Kernel', lane: 'ss4' } });
  await executor.start();
  t.after(() => executor.close());
  const state = { reads: [], kernel: [], published: [], cascades: [], extensions };
  const port = executor.relayPort();
  const runAnvil = async args => {
    state.kernel.push(args);
    const opt = name => args[args.indexOf(name) + 1];
    const spec = args.includes('--spec') ? JSON.parse(fs.readFileSync(opt('--spec'), 'utf8')) : SPEC;
    let data;
    if (args[1] === 'check') data = { ok: true, spec, create: !args.includes('--base') };
    else if (args[1] === 'read') {
      const dir = opt('--resources-out'), dll = write(path.join(dir, '0000', 'Example.dll'), 'library');
      data = { ok: true, name: 'ZZLib', sha256: 'c'.repeat(64), hash: 'h', signatureHash: 'd'.repeat(64), spec, resources: [], exported: { directory: dir, resources: [{ path: 'Source\\NET\\Bin\\Example.dll', file: dll }], references: [dll] } };
    } else if (opt('--stage') === 'model') {
      const work = opt('--work');
      const answer = await relayStage(port, key, { command: 'model', work, spec: { ...spec, references: undefined }, output: path.join(work, 'model', NAME + '.xif'),
        references: spec.references ?? [], ...(args.includes('--base') ? { base: opt('--base') } : {}) });
      data = answer.ok ? { ok: true, stage: 'model', xif: answer.xif, name: NAME, key: 'ext-key-1', hash: 'h1', engine: answer.studio } : answer;
    } else {
      const work = opt('--work');
      const dll = write(path.join(work, 'out', 'OutSystems.Nss' + NAME + '.dll'), 'compiled');
      const source = write(path.join(work, 'out', 'source', 'Source', 'NET', NAME + '.cs'), 'merged');
      const answer = await relayStage(port, key, { command: 'final', work, model: opt('--model'), dll, name: NAME, output: path.join(work, 'final', NAME + '.xif'),
        sources: [{ path: 'Source\\NET\\' + NAME + '.cs', file: source }] });
      data = answer.ok ? { ok: true, stage: 'final', xif: answer.xif, xifSha256: answer.sha256, dllSha256: sha('compiled'), hash: 'h2', key: 'ext-key-1', name: NAME } : answer;
    }
    return { ok: data.ok !== false, exitCode: 0, envelope: { ok: true, command: 'xif', data } };
  };
  const extension = { runAnvil, locate: async () => environment(state), hostClass: () => 'personal',
    serviceCenter: async argv => { state.published.push(argv); return { ok: true, state: 'confirmed', extensionId: 41, extensionVersionId: 8 }; },
    publishConsumersOf: async request => { state.cascades.push(request); return { ok: true, consumers: [{ module: 'Orders_CS', outcome: 'published' }] }; } };
  const context = { hosted: true, id: 'ctx-xif-served', tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const server = await runWithExecutor(context, () => createSsamServer({ deps: { extension }, hosted: { context, session: { agent: link, lanes: context.lanes },
    presentation: { workspace: dirs.workspace, serverRoots: serverRoots({ tmp: '' }) } } }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'xif-served', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async args => {
    const result = await client.callTool({ name: 'o11_extension', arguments: args });
    const text = JSON.stringify(result);
    return { value: result.structuredContent ?? JSON.parse(result.content[0].text), text };
  };
  return { ...dirs, link, executor, state, seen, call };
}
const noServerPath = (c, text, label) => {
  for (const p of [c.workspace, c.root, c.workspace.split(path.sep).join('\\\\')]) assert.ok(!text.includes(p), label + ' carries a server path');
};

test('served: create through the gate, the path resolution and the presenter; no server path in the answer', async t => {
  const c = await served(t);
  const { value, text } = await c.call({ action: 'publish', host: HOST, spec: SPEC, words: WORDS });
  assert.equal(value.ok, true, text);
  assert.equal(value.state, 'created');
  assert.deepEqual(c.seen.map(s => s.command), ['model', 'final']);
  noServerPath(c, text, 'the answer');
  assert.match(value.xif, /^ws:o11\//, 'the XIF is shown as a workspace path');
  assert.match(value.continuation.arguments.job, /^ws:o11\//);
  assert.equal(c.state.published.length, 1);
});

test('served: an old agent (no o11.xif) keeps the answer of before, and nothing reaches the agent or the kernel', async t => {
  const c = await served(t, { kinds: false });
  const { value } = await c.call({ action: 'publish', host: HOST, spec: SPEC, words: WORDS });
  assert.equal(value.code, 'HOSTED_UNAVAILABLE'); assert.equal(value.cause, 'XIF_ENGINE_WINDOWS_ONLY');
  assert.equal(c.state.kernel.length, 0); assert.equal(c.seen.length, 0);
});

test('served A1: every shape of a spec file outside the workspace is refused before the kernel', async t => {
  const c = await served(t);
  const other = write(path.join(c.root, 'server', 'customers', 'tok_other', 'o11', 'libs', 'Lib.dll'), 'x');
  const text = write(path.join(c.root, 'server', 'customers', 'tok_other', 'o11', 'notes.txt'), 'secret');
  for (const extra of [{ references: [{ file: other }] }, { references: { file: other } }, { references: other }, { references: [other] },
    { sources: { path: 'A.cs', file: text } }, { sources: [{ path: 'A.cs', file: text }] }, { resources: { path: 'a.txt', file: text, deploy: 'Ignore' } },
    { references: [{ file: 42 }] }, { references: [['nested']] }]) {
    const { value, text: answer } = await c.call({ action: 'publish', host: HOST, spec: { ...SPEC, ...extra }, words: WORDS });
    assert.equal(value.code, 'PATH_OUTSIDE_WORKSPACE', JSON.stringify(extra) + ' -> ' + answer);
    noServerPath(c, answer, JSON.stringify(extra));
  }
  assert.equal(c.state.kernel.length, 0, 'the kernel never read them');
  assert.equal(c.seen.length, 0);
});

test('served A1: the kernel confines the files of the spec too (--confine with the account\'s folders)', async t => {
  const c = await served(t);
  const { value } = await c.call({ action: 'publish', host: HOST, spec: SPEC, words: WORDS });
  assert.equal(value.ok, true);
  for (const args of c.state.kernel.filter(a => ['check', 'build'].includes(a[1]))) {
    const roots = args.flatMap((a, i) => (a === '--confine' ? [args[i + 1]] : []));
    assert.deepEqual(roots, ['o11', 'inbox', 'odc'].map(f => path.join(c.workspace, f)), args.join(' '));
  }
});

test('served: edit of an existing extension, its base downloaded in base64 and given to the model stage', async t => {
  const c = await served(t, { extensions: [{ Name: NAME, Key: 'ext-key-1', Version_Id: 7, Id: 41 }] });
  const { value, text } = await c.call({ action: 'publish', host: HOST, spec: SPEC, expectedVersionId: '7', words: WORDS });
  assert.equal(value.ok, true, text);
  assert.equal(value.state, 'updated');
  const download = c.state.reads.find(r => r.operation === 'DownloadExtension');
  assert.equal(download.args.outFile, undefined, 'no outFile on a hosted server');
  const model = c.seen.find(s => s.command === 'model');
  assert.match(model.base, /^agent:o11\/xif\/[0-9a-f]+\/in\/\d+\/ZZHybridXifLab\.xif$/);
  assert.ok(c.state.kernel.some(a => a[1] === 'check' && a.includes('--base')));
});

test('served: referencesFrom brings the library of another extension to the model stage, with its source recorded', async t => {
  const c = await served(t, { extensions: [{ Name: 'ZZLib', Key: 'lib-key', Version_Id: 3, Id: 9 }] });
  const { value, text } = await c.call({ action: 'publish', host: HOST, spec: SPEC, referencesFrom: ['ZZLib'], words: WORDS });
  assert.equal(value.ok, true, text);
  assert.deepEqual(value.referenceSources.map(s => s.extension), ['ZZLib']);
  const model = c.seen.find(s => s.command === 'model');
  assert.match(model.references[0], /\/Example\.dll$/);
  noServerPath(c, text, 'the answer');
});

test('served: consumers:true runs the consumer cascade with the same words after the publication', async t => {
  const c = await served(t);
  const { value, text } = await c.call({ action: 'publish', host: HOST, spec: SPEC, consumers: true, words: WORDS });
  assert.equal(value.ok, true, text);
  assert.deepEqual(value.consumerPublications, [{ module: 'Orders_CS', outcome: 'published' }]);
  assert.equal(c.state.cascades.length, 1);
  assert.equal(c.state.cascades[0].producer.name, NAME);
});

test('A2: the file name of a merged source on Linux is its last segment, whatever separator the kernel wrote', () => {
  // The kernel of before wrote "<out>/source/Source\NET\X.cs" on Linux (one name with backslashes); path.posix.basename keeps them.
  assert.equal(path.posix.basename('/data/ws/o11/w/out/source/Source\\NET\\ZZHybridXifLab.cs'), 'Source\\NET\\ZZHybridXifLab.cs');
  assert.equal(fileName('/data/ws/o11/w/out/source/Source\\NET\\ZZHybridXifLab.cs', 'sources[0].file'), 'ZZHybridXifLab.cs');
  assert.equal(fileName('/data/ws/o11/w/out/source/Source/NET/ZZHybridXifLab.cs', 'sources[0].file'), 'ZZHybridXifLab.cs');
  assert.equal(fileName('C:\\ws\\o11\\w\\out\\source\\Source\\NET\\X.cs', 'f'), 'X.cs');
});

test('B4: the output the kernel asks for is a file of the account\'s workspace', async () => {
  const mirror = { classify: () => ({ visible: false }), inputPlan: async () => ({ puts: [] }) };
  await assert.rejects(stageXif({ command: 'model', output: path.resolve('elsewhere', 'X.xif'), spec: { name: 'X' } }, mirror), { code: 'PATH_OUTSIDE_WORKSPACE' });
});

test('M3: the hosted inline limit is honest, and a download is checked against the sha256 the bridge computed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xif-binary-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const big = async () => { throw Object.assign(new Error('the result has 17000000 bytes, above 16777216: pass args.outFile (absolute path)'), { code: 'BAD_REQUEST' }); };
  await assert.rejects(binaryRead(big, 'soap', 'DownloadExtension', {}, path.join(dir, 'a.xif'), { hosted: true }),
    error => error.code === HOSTED_FILE_TOO_LARGE && /about 12 MiB/.test(error.message) && !/outFile/.test(error.message));
  const value = async () => { throw Object.assign(new Error('The result of o11.bridge has 17000000 bytes'), { code: 'VALUE_TOO_LARGE' }); };
  await assert.rejects(binaryRead(value, 'soap', 'DownloadExtension', {}, path.join(dir, 'b.xif'), { hosted: true }), { code: HOSTED_FILE_TOO_LARGE });
  const lying = async () => ({ bytes: 3, sha256: 'f'.repeat(64), base64: Buffer.from('abc').toString('base64') });
  await assert.rejects(binaryRead(lying, 'soap', 'DownloadExtension', {}, path.join(dir, 'c.xif'), { hosted: true }), { code: 'HOSTED_FILE_CHANGED' });
  assert.equal(fs.existsSync(path.join(dir, 'c.xif')), false, 'nothing written');
  const good = async () => ({ bytes: 3, sha256: sha(Buffer.from('abc')), base64: Buffer.from('abc').toString('base64') });
  const ok = await binaryRead(good, 'soap', 'DownloadExtension', {}, path.join(dir, 'd.xif'), { hosted: true });
  assert.equal(fs.readFileSync(ok.file, 'utf8'), 'abc');
  const local = []; await binaryRead(async (s, o, a) => { local.push(a); return {}; }, 'soap', 'DownloadExtension', { k: 1 }, 'C:\\x.xif', { hosted: false });
  assert.deepEqual(local, [{ k: 1, outFile: 'C:\\x.xif' }], 'local mode unchanged');
});
