// o11_extension against a fake bridge (the Studio side of sc_api), a fake kernel (anvil xif) and a fake Service Center engine
// (runServiceCenter, contract I1). No Studio, no dotnet, no environment; every folder is temporary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createO11Extension, registerO11Extension, extensionSchema } from '../o11-extension.mjs';
import { OPERATIONS, CAPABILITY } from '../service-center/integration-studio.mjs';
import { BridgeError } from '../service-center/errors.mjs';
import * as standingGrants from '../standing-grants.mjs';
import { anvilRoot } from '../workspace.mjs';

const HOST = 'lab.example.com';
const NAME = 'ZZHybridXifLab';
const WORDS = 'sim, pode publicar a extensão ZZHybridXifLab';
const SPEC = { name: NAME, actions: [{ name: 'Add', inputs: [{ name: 'Left', type: 'Integer' }, { name: 'Right', type: 'Integer' }], outputs: [{ name: 'Result', type: 'Integer' }], body: 'Result = checked(Left + Right);' }] };
const CURRENT = { Name: NAME, Key: 'ext-key-1', Version_Id: 7, Id: 41 };
const BREAKING = { breaking: true, changes: [{ change: 'removed', element: 'input', name: 'Add.Right', key: 'p-right', breaking: true }],
  breakingElements: [{ kind: 'action', name: 'Add', key: 'act-add' }] };
const ADDITIVE = { breaking: false, changes: [{ change: 'added', element: 'action', name: 'Multiply', breaking: false }], breakingElements: [] };
const ALL_CAPABILITIES = new Set(['sc_api:soap', 'sc_api:server-api', 'sc_api:sc-rest', CAPABILITY]);

// The integration-studio operations of the bridge and the argument names each Prepare reads (ScOperations.cs).
const BRIDGE_SOURCE = path.join(anvilRoot, 'src', 'Anvil.Bridge', 'ScOperations.cs');
function bridgeIntegrationStudio() {
  const text = fs.readFileSync(BRIDGE_SOURCE, 'utf8');
  const start = text.indexOf('IReadOnlyDictionary<string, ScOp<ScIntegrationStudioSend>> IntegrationStudioOperations =');
  assert.ok(start > 0, 'ScOperations.cs has the IntegrationStudioOperations table');
  const block = text.slice(start, text.indexOf('\n    };', start));
  const ops = {};
  for (const m of block.matchAll(/^\s*\["(\w+)"\] = (Read|Write)<ScIntegrationStudioSend>\((.*?)(?=^\s*\["\w+"\] =|$(?![\s\S]))/gms))
    ops[m[1]] = { kind: m[2], args: new Set([...m[3].matchAll(/\ba\.(?:Key|Text|Int|Bool|Raw|Bytes|OneOf|OptionalObjectKey|Date|Path)\("(\w+)"/g)].map(x => x[1])) };
  return ops;
}

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-extension-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

// A scripted environment. state: extensions, modules, consumers(elementKey), handshake, stubs, deps, uploadNeeded, final,
// publish (the Service Center answer), capabilities.
function harness(t, state = {}) {
  const root = sandbox(t);
  const s = { extensions: [], modules: [], capabilities: ALL_CAPABILITIES, handshake: { ok: true, platform: '11.38.0', database: 'SqlServer' },
    stubs: 'ok', deps: 'ok', uploadNeeded: { needs: true, extensionId: 0, equalVersionId: 0, runningVersionId: 0 }, contractDiff: null,
    consumers: () => [], publish: { ok: true, state: 'confirmed', extensionId: 41, extensionVersionId: 8 }, ...state };
  const bridgeCalls = []; const kernelCalls = []; const scCalls = [];
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return { bytes: bytes.length, file }; };
  const bridge = {
    supports: async () => true,
    session: async host => ({ studio: { signedIn: true, host, user: 'lab-user' }, web: {} }),
    capabilities: async () => s.capabilities,
    api: async (host, surface, operation, args) => {
      bridgeCalls.push({ host, surface, operation, args });
      const key = surface + ':' + operation;
      switch (key) {
        case 'soap:ListExtensions': return { ok: true, result: s.extensions };
        case 'soap:ListEspaces': return { ok: true, result: s.modules };
        case 'soap:DownloadExtension': return { ok: true, result: { ...write(args.outFile, Buffer.from('synthetic-xif')), meta: { versionId: args.versionId } } };
        case 'soap:GetConsumers': {
          const rows = s.consumers(args.referenceableElementKey);
          if (rows instanceof Error) throw rows;
          return { ok: true, result: rows };
        }
        case 'integration-studio:Handshake': return { ok: true, result: s.handshake };
        case 'integration-studio:GenerateSourceCodeStubs':
          if (s.stubs instanceof Error) throw s.stubs;
          if (s.stubs === 'ok') return { ok: true, result: { ...write(args.outFile, Buffer.from('PK-stubs')), meta: { messages: [], errors: 0 } } };
          return { ok: true, result: { bytes: 0, meta: s.stubs } };
        case 'integration-studio:GetSourceCodeDependencies': return { ok: true, result: { ...write(args.outFile, Buffer.from('PK-deps')), meta: { messages: [], errors: 0 } } };
        case 'integration-studio:UploadNeeded': return { ok: true, result: typeof s.uploadNeeded === 'function' ? s.uploadNeeded() : s.uploadNeeded };
        default: throw new BridgeError('NOT_ALLOWED', 'unexpected ' + key);
      }
    },
  };
  const runAnvil = async args => {
    kernelCalls.push(args);
    const opt = name => args[args.indexOf(name) + 1];
    const [, verb] = args;
    let data;
    if (verb === 'check') data = { ok: true, spec: SPEC, create: !args.includes('--base') };
    else if (verb === 'build' && opt('--stage') === 'model') data = { ok: true, stage: 'model', ...write(path.join(opt('--work'), 'model', NAME + '.xif'), Buffer.from('model')), xif: path.join(opt('--work'), 'model', NAME + '.xif'), engine: { version: '11.14.25.134', lastUpgradeVersion: '11.0.0.200' } };
    else if (verb === 'build') {
      const xif = path.join(opt('--work'), 'final', NAME + '.xif');
      write(xif, Buffer.from('final'));
      data = { ok: true, stage: 'final', xif, xifSha256: 'a'.repeat(64), dllSha256: 'b'.repeat(64), hash: 'model-hash-1', key: 'ext-key-1', name: NAME,
        ...(args.includes('--base') && s.contractDiff ? { contractDiff: s.contractDiff } : {}) };
    } else if (verb === 'read') data = { ok: true, name: NAME, sha256: 'c'.repeat(64), hash: 'model-hash-1', signatureHash: 'd'.repeat(64), spec: SPEC, resources: [] };
    return { ok: data.ok, exitCode: data.ok ? 0 : 1, envelope: { ok: data.ok, command: 'xif', data } };
  };
  const serviceCenter = async argv => { scCalls.push(argv); return typeof s.publish === 'function' ? s.publish(argv) : s.publish; };
  const grantsFile = path.join(root, 'grants.json');
  const cascades = [];
  const run = createO11Extension({ root, now: () => new Date('2026-10-05T23:00:00Z'), runAnvil, serviceCenter, locate: async () => bridge, grantsFile,
    hostClass: () => 'personal', publishConsumersOf: async request => { cascades.push(request); return { ok: true, consumers: [{ module: 'Orders_CS', outcome: 'published' }] }; } });
  return { root, s, run, bridgeCalls, kernelCalls, scCalls, grantsFile, cascades,
    ops: () => bridgeCalls.map(c => c.surface + ':' + c.operation), publishes: () => scCalls.filter(a => a[0] === 'extension-publish') };
}

const flag = (argv, name) => argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);

test('create in one call: model, stubs, compile, exactly one extension-publish with --expected-version-id=none', async t => {
  const h = harness(t);
  const value = await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.state, 'created');
  assert.equal(value.extensionKey, 'ext-key-1'); assert.equal(value.versionId, 8); assert.equal(value.extensionId, 41);
  assert.equal(value.xifSha256, 'a'.repeat(64)); assert.equal(value.dllSha256, 'b'.repeat(64));
  assert.deepEqual(h.kernelCalls.map(a => a[1] === 'build' ? 'build:' + a[a.indexOf('--stage') + 1] : a[1]), ['check', 'build:model', 'build:final']);
  assert.deepEqual(h.ops(), ['soap:ListExtensions', 'soap:ListEspaces', 'integration-studio:Handshake', 'integration-studio:GenerateSourceCodeStubs',
    'integration-studio:GetSourceCodeDependencies', 'integration-studio:UploadNeeded']);
  // As the real Integration Studio: product version, then Config.LastUpgradeVersion (the product version twice was refused
  // live on 2026-10-07: "not compatible with the selected Platform Server (11.42.1.47790)").
  assert.deepEqual(h.bridgeCalls.find(c => c.operation === 'Handshake').args, { version: '11.14.25.134', lastUpgradeVersion: '11.0.0.200' });
  assert.deepEqual(h.bridgeCalls.find(c => c.operation === 'UploadNeeded').args, { extensionKey: 'ext-key-1', extensionHash: 'model-hash-1' });
  const [publish, ...more] = h.publishes();
  assert.equal(more.length, 0); assert.equal(h.scCalls.length, 1);
  assert.equal(flag(publish, 'expected-version-id'), 'none'); assert.equal(flag(publish, 'extension'), NAME); assert.equal(flag(publish, 'host'), HOST);
  assert.ok(publish.includes('--execute')); assert.match(flag(publish, 'operation-id'), /^[0-9a-f-]{36}$/); assert.equal(flag(publish, 'words'), WORDS);
  assert.ok(path.isAbsolute(flag(publish, 'xif-file')));
  // The platform DLLs are kept in the cache by platform and content; the next build reads them from there.
  const cache = path.join(h.root, '.local', 'xif-deps', HOST, '11.38.0');
  assert.equal(fs.readdirSync(cache).length, 1);
  // The continuation is the existing reference job with the producer captured read-only.
  assert.equal(value.continuation.tool, 'ssam_job');
  assert.deepEqual(value.continuation.arguments.captureProducers, [NAME]);
  assert.deepEqual(value.referenceJob.ops, [{ op: 'reference', producer: NAME, elements: ['IServerActionSignature:Add'] }]);
  assert.ok(!JSON.stringify(value).includes(WORDS), 'the words never come back');
});

test('the dependencies come from the cache on the next build', async t => {
  const h = harness(t);
  assert.equal((await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS })).state, 'created');
  h.s.uploadNeeded = { needs: true, extensionId: 41, equalVersionId: 0, runningVersionId: 8 };
  h.s.extensions = [{ ...CURRENT, Version_Id: 8 }];
  h.bridgeCalls.length = 0;
  assert.equal((await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS })).state, 'updated');
  assert.ok(!h.ops().includes('integration-studio:GetSourceCodeDependencies'));
});

test('without words: WORDS_REQUIRED with xifSha256 and zero sends', async t => {
  const h = harness(t);
  for (const words of [undefined, '', '   ', '<the user words>']) {
    const value = await h.run({ action: 'publish', host: HOST, spec: SPEC, ...(words === undefined ? {} : { words }) });
    assert.equal(value.code, 'WORDS_REQUIRED', JSON.stringify(value));
    assert.equal(value.xifSha256, 'a'.repeat(64));
    assert.ok(Array.isArray(value.problems) && value.problems[0].fix);
    assert.ok('contractDiff' in value && 'consumers' in value);
  }
  const named = await h.run({ action: 'publish', host: HOST, spec: SPEC, words: 'pode publicar a ZZHybridXifLabV2' });
  assert.equal(named.code, 'WORDS_MUST_NAME_TARGET');
  assert.equal(h.scCalls.length, 0);
});

test('a bridge without sc_api:integration-studio: BRIDGE_TOO_OLD before any kernel call', async t => {
  const h = harness(t, { capabilities: new Set(['sc_api:soap', 'sc_api:server-api', 'sc_api:sc-rest']) });
  const value = await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS });
  assert.equal(value.code, 'BRIDGE_TOO_OLD');
  assert.match(value.problems[0].fix, /Service Studio \(SSAM\)/);
  assert.equal(value.continuation.tool, 'ssam_connect');
  assert.deepEqual(h.kernelCalls, []); assert.deepEqual(h.bridgeCalls, []); assert.deepEqual(h.scCalls, []);
});

test('two rows that differ only in case: EXTENSION_AMBIGUOUS; a module of that name: EXTENSION_NAME_TAKEN', async t => {
  const h = harness(t, { extensions: [{ Name: NAME, Key: 'a', Version_Id: 1 }, { Name: 'zzhybridxiflab', Key: 'b', Version_Id: 2 }] });
  const value = await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS });
  assert.equal(value.code, 'EXTENSION_AMBIGUOUS');
  assert.deepEqual(value.candidates.map(c => c.name), [NAME, 'zzhybridxiflab']);
  const variant = harness(t, { extensions: [{ Name: 'ZZHYBRIDXIFLAB', Key: 'b', Version_Id: 2 }] });
  assert.equal((await variant.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS })).code, 'EXTENSION_AMBIGUOUS');
  const taken = harness(t, { modules: [{ Name: 'ZZHybridXifLab', Key: 'm' }] });
  assert.equal((await taken.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS })).code, 'EXTENSION_NAME_TAKEN');
  for (const x of [h, variant, taken]) { assert.deepEqual(x.kernelCalls, []); assert.deepEqual(x.scCalls, []); }
});

test('a stub error of the server: XIF_STUBS_REFUSED, zero writes', async t => {
  const h = harness(t, { stubs: { errors: 1, messages: [{ type: 'Error', id: 'IS-9', message: 'Invalid extension: action Add has no implementation' }] } });
  const value = await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS });
  assert.equal(value.code, 'XIF_STUBS_REFUSED');
  assert.match(value.error, /Invalid extension/);
  assert.equal(value.messages[0].id, 'IS-9');
  assert.deepEqual(h.scCalls, []);
  assert.ok(!h.kernelCalls.some(a => a.includes('final')));
  const thrown = harness(t, { stubs: new BridgeError('REMOTE_ERROR', 'integration-studio GenerateSourceCodeStubs: HTTP 500: server error') });
  const failed = await thrown.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS });
  assert.equal(failed.code, 'XIF_STUBS_REFUSED'); assert.match(failed.error, /HTTP 500/);
  assert.deepEqual(thrown.scCalls, []);
});

test('the same version already running: already-running, zero writes', async t => {
  const h = harness(t, { extensions: [CURRENT], uploadNeeded: { needs: false, extensionId: 41, equalVersionId: 7, runningVersionId: 7 } });
  const value = await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS });
  assert.equal(value.ok, true); assert.equal(value.state, 'already-running'); assert.equal(value.versionId, 7);
  assert.deepEqual(h.scCalls, []);
});

test('a lost answer is uncertain; the same operationId again never sends', async t => {
  const h = harness(t, { publish: { ok: false, state: 'uncertain', code: 'UNCERTAIN', error: 'the bridge connection broke after the write was sent' } });
  const operationId = '0f8c2d4e-1a2b-4c3d-8e9f-001122334455';
  const value = await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS, operationId });
  assert.equal(value.ok, false); assert.equal(value.state, 'uncertain'); assert.equal(value.code, 'EXTENSION_PUBLISH_UNCERTAIN');
  assert.equal(value.operationId, operationId);
  assert.equal(value.continuation.arguments.operationId, operationId);
  assert.equal(h.publishes().length, 1);
  const kernelBefore = h.kernelCalls.length;
  const repeated = await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS, operationId });
  assert.equal(repeated.state, 'uncertain'); assert.equal(repeated.sent, false);
  assert.equal(h.publishes().length, 1, 'never sent again');
  assert.equal(h.kernelCalls.length, kernelBefore, 'nothing rebuilt');
  // Once the environment runs the recorded hash, the same call closes it.
  h.s.uploadNeeded = { needs: false, extensionId: 41, equalVersionId: 8, runningVersionId: 8 };
  const closed = await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS, operationId });
  assert.equal(closed.ok, true); assert.equal(closed.state, 'created'); assert.equal(closed.reconciled, true);
  assert.equal(h.publishes().length, 1);
});

test('EXTENSION_VERSION_CHANGED from the Service Center comes back as it is', async t => {
  const h = harness(t, { extensions: [CURRENT], publish: { ok: false, code: 'EXTENSION_VERSION_CHANGED', error: 'the extension changed', observed: { versionId: 9 } } });
  const value = await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS });
  assert.equal(value.code, 'EXTENSION_VERSION_CHANGED'); assert.deepEqual(value.observed, { versionId: 9 });
  assert.equal(flag(h.publishes()[0], 'expected-version-id'), '7');
  assert.equal(value.continuation.arguments.action, 'read');
  // expectedVersionId of the caller is checked before anything is built.
  const stale = harness(t, { extensions: [CURRENT] });
  const refused = await stale.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS, expectedVersionId: '6' });
  assert.equal(refused.code, 'EXTENSION_VERSION_CHANGED'); assert.deepEqual(refused.observed, { versionId: 7 });
  assert.deepEqual(stale.kernelCalls, []); assert.deepEqual(stale.scCalls, []);
});

test('a breaking edit needs the consumers named; then it goes; a failed read refuses', async t => {
  const consumers = key => (key === 'act-add' ? [{ Name: 'Orders_CS' }, { Name: NAME }] : []);
  const h = harness(t, { extensions: [CURRENT], contractDiff: BREAKING, consumers });
  const refused = await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS });
  assert.equal(refused.code, 'EXTENSION_BREAKS_CONSUMERS');
  assert.deepEqual(refused.consumers, { Add: ['Orders_CS'] });
  assert.equal(refused.problems[0].ssamRule, true);
  assert.match(refused.problems[0].fix, /Orders_CS/);
  assert.deepEqual(refused.contractDiff, BREAKING);
  assert.deepEqual(h.bridgeCalls.find(c => c.operation === 'GetConsumers').args, { producerESpaceKey: 'ext-key-1', referenceableElementKey: 'act-add' });
  assert.equal(h.scCalls.length, 0);
  const named = await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS + ' e republicar o Orders_CS' });
  assert.equal(named.ok, true, JSON.stringify(named)); assert.equal(named.state, 'updated');
  assert.equal(h.publishes().length, 1); assert.equal(flag(h.publishes()[0], 'expected-version-id'), '7');
  const unknown = harness(t, { extensions: [CURRENT], contractDiff: BREAKING, consumers: () => new BridgeError('REMOTE_ERROR', 'GetConsumers failed') });
  const failed = await unknown.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS + ' e Orders_CS' });
  assert.equal(failed.code, 'EXTENSION_CONSUMERS_UNKNOWN'); assert.equal(unknown.scCalls.length, 0);
});

test('a standing grant covers an additive edit without words, never a breaking one nor a delete', async t => {
  const h = harness(t, { extensions: [CURRENT], contractDiff: ADDITIVE });
  const granted = standingGrants.addGrant({ lane: 'o11', app: 'Lab', modules: [NAME], verbs: ['publish'], words: 'pode publicar o Lab sempre' }, { file: h.grantsFile });
  assert.equal(granted.ok, true);
  const value = await h.run({ action: 'publish', host: HOST, spec: SPEC });
  assert.equal(value.ok, true, JSON.stringify(value)); assert.equal(value.state, 'updated');
  assert.deepEqual(value.authorization, { source: 'standing-grant', grantId: granted.grant.grantId });
  assert.equal(h.publishes().length, 1);
  h.s.contractDiff = BREAKING; h.s.consumers = () => [];
  const breaking = await h.run({ action: 'publish', host: HOST, spec: SPEC });
  assert.equal(breaking.code, 'WORDS_REQUIRED'); assert.match(breaking.error, /never covers/);
  const deleted = await h.run({ action: 'delete', host: HOST, extension: NAME });
  assert.equal(deleted.code, 'WORDS_REQUIRED');
  assert.equal(h.scCalls.length, 1, 'only the additive publication was sent');
});

test('delete goes to the delete engine of the Service Center once, with the target and the words', async t => {
  const h = harness(t, { publish: { ok: true, action: 'delete', state: 'confirmed', deleted: [{ kind: 'extension', name: NAME, key: 'ext-key-1' }] } });
  const value = await h.run({ action: 'delete', host: HOST, extension: NAME, words: 'pode apagar a extensão ZZHybridXifLab' });
  assert.equal(value.state, 'confirmed');
  assert.deepEqual(h.scCalls, [['delete', '--host=' + HOST, '--target=extension:' + NAME, '--words=pode apagar a extensão ZZHybridXifLab']]);
  assert.deepEqual(h.kernelCalls, []); assert.deepEqual(h.bridgeCalls, []);
});

test('read: the active version downloaded, read by the kernel, with its consumers', async t => {
  const h = harness(t, { extensions: [CURRENT], consumers: () => [{ Name: 'Orders_CS' }] });
  const value = await h.run({ action: 'read', host: HOST, extension: NAME });
  assert.equal(value.ok, true); assert.equal(value.versionId, 7); assert.equal(value.extensionKey, 'ext-key-1');
  assert.deepEqual(value.spec, SPEC); assert.deepEqual(value.consumers, ['Orders_CS']); assert.equal(value.signatureHash, 'd'.repeat(64));
  assert.deepEqual(h.bridgeCalls.find(c => c.operation === 'DownloadExtension').args.versionId, 7);
  assert.deepEqual(h.kernelCalls.map(a => a[1]), ['read']);
  const missing = await harness(t, { extensions: [{ Name: 'ZZHybridXifLib', Key: 'x', Version_Id: 1 }] }).run({ action: 'read', host: HOST, extension: NAME });
  assert.equal(missing.code, 'EXTENSION_NOT_FOUND'); assert.match(missing.problems[0].fix, /ZZHybridXifLib/);
});

test('consumers:true runs the o11_publish cascade of a producer that is not a Studio tab', async t => {
  const h = harness(t);
  const value = await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS, consumers: true, commitMessage: 'v2' });
  assert.equal(value.ok, true);
  assert.deepEqual(h.cascades.map(c => c.producer), [{ name: NAME, key: 'ext-key-1', environment: HOST }]);
  assert.equal(h.cascades[0].message, 'v2');
  assert.deepEqual(value.consumerPublications, [{ module: 'Orders_CS', outcome: 'published' }]);
});

test('agreement with the bridge: every integration-studio operation sent is in IntegrationStudioOperations, read-only, with the arguments it reads', async t => {
  const table = bridgeIntegrationStudio();
  assert.deepEqual(Object.keys(table).sort(), [...OPERATIONS].sort());
  assert.ok(Object.values(table).every(op => op.kind === 'Read'), 'the surface is read-only');
  const h = harness(t, { extensions: [CURRENT], contractDiff: ADDITIVE });
  await h.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS });
  const sent = h.bridgeCalls.filter(c => c.surface === 'integration-studio');
  assert.equal(new Set(sent.map(c => c.operation)).size, 4);
  for (const call of sent) {
    assert.ok(table[call.operation], call.operation);
    for (const name of Object.keys(call.args)) assert.ok(table[call.operation].args.has(name) || name === 'outFile', call.operation + '.' + name);
  }
});

test('the tool is listed with the schema of the contract and destructive annotations', async t => {
  const server = new McpServer({ name: 'o11-extension-test', version: '1.0.0' });
  registerO11Extension(server, { root: sandbox(t), runAnvil: async () => ({}), serviceCenter: async () => ({}), locate: async () => null });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'o11-extension-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const tool = (await client.listTools()).tools.find(x => x.name === 'o11_extension');
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['action', 'application', 'applicationKey', 'commitMessage', 'confirmHost', 'consumers',
    'expectedVersionId', 'extension', 'host', 'operationId', 'spec', 'specFile', 'words']);
  assert.deepEqual(tool.inputSchema.required.sort(), ['action', 'host']);
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['read', 'publish', 'delete']);
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.doesNotMatch(JSON.stringify(tool.inputSchema), /Alone:|Instead of job/);
  assert.doesNotMatch(tool.description, /python|\.ps1|dotnet /i);
  const refused = await client.callTool({ name: 'o11_extension', arguments: { action: 'publish', host: 'https://lab.example.com', spec: SPEC } }).catch(error => ({ isError: true, error }));
  assert.equal(refused.isError, true);
  assert.equal(extensionSchema.safeParse({ action: 'publish', host: HOST, password: 'x' }).success, false);
});
