// CX15: delete-app reaches the destructive module (previews, records, seen words under the profile): a temporary profile.
import './fixtures/isolated-profile.mjs';
// o11_extension against a fake bridge (the Studio side of sc_api), a fake kernel (anvil xif) and a fake Service Center engine
// (runServiceCenter, contract I1). No Studio, no dotnet, no environment; every folder is temporary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
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
    } else if (verb === 'read') {
      const directory = opt('--resources-out'), file = path.join(directory, '0000', 'Example.dll'), license = path.join(directory, '0001', 'LICENSE.txt');
      write(file, Buffer.from('dependency')); write(license, Buffer.from('license notice'));
      data = { ok: true, name: NAME, sha256: 'c'.repeat(64), hash: 'model-hash-1', signatureHash: 'd'.repeat(64), spec: SPEC, resources: [],
        exported: { directory, resources: [{ path: 'Source\\NET\\Bin\\Example.dll', file }, { path: 'Licenses\\LICENSE.txt', file: license }], references: [file] } };
    }
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
  // CX15: a delete without words is a preview (its words come after the list); the grant never adds words to it.
  await h.run({ action: 'delete', host: HOST, extension: NAME });
  assert.deepEqual(h.scCalls.at(-1), ['delete', '--host=' + HOST, '--target=extension:' + NAME]);
  assert.equal(h.scCalls.length, 2, 'the additive publication and one delete preview (nothing to send)');
});

test('delete goes to the delete engine of the Service Center once, with the target and the words', async t => {
  const h = harness(t, { publish: { ok: true, action: 'delete', state: 'confirmed', deleted: [{ kind: 'extension', name: NAME, key: 'ext-key-1' }] } });
  const value = await h.run({ action: 'delete', host: HOST, extension: NAME, words: 'pode apagar a extensão ZZHybridXifLab' });
  assert.equal(value.state, 'confirmed');
  assert.deepEqual(h.scCalls, [['delete', '--host=' + HOST, '--target=extension:' + NAME, '--words=pode apagar a extensão ZZHybridXifLab']]);
  assert.deepEqual(h.kernelCalls, []); assert.deepEqual(h.bridgeCalls, []);
});

test('proposal context preserves broad human words for a new standalone fixture and exact deletion', async t => {
  const h=harness(t),dir=sandbox(t),proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');
  const words='Autorizo criar e excluir qualquer fixture O11 para testes.';
  fs.writeFileSync(proposal,'One standalone '+NAME+' publication and deletion; no consumers.');
  const record={schema:'ssam-authorization-context/1',decision:'approved',words,
    source:{kind:'human-conversation',threadId:'11111111-2222-3333-4444-555555555555',messageId:'22222222-2222-3333-4444-555555555555',question:'Express fixture test authorization'},
    proposal:{file:proposal,sha256:createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},constraints:{createOnly:true},
    scope:['extension-publish','delete'].map(operation=>({lane:'o11',host:HOST,operation,targets:[NAME]}))};
  const save=()=>fs.writeFileSync(file,JSON.stringify(record));save();
  const input={action:'publish',host:HOST,spec:SPEC,words,authorizationContext:file};
  const value=await h.run(input);assert.equal(value.ok,true,JSON.stringify(value));
  assert.equal(value.authorization.source,'human-context');assert.equal(flag(h.publishes()[0],'words'),words);
  assert.equal(flag(h.publishes()[0],'authorization-context'),file);
  for(const extra of [{application:'Existing'},{applicationKey:'key'},{consumers:true}])
    assert.equal((await h.run({...input,...extra})).code,'AUTHORIZATION_CONTEXT_INVALID');
  record.scope[0].targets=['Other'];save();assert.equal((await h.run(input)).code,'AUTHORIZATION_CONTEXT_INVALID');
  record.scope[0].targets=[NAME];record.constraints.createOnly=false;save();assert.equal((await h.run(input)).code,'AUTHORIZATION_CONTEXT_INVALID');
  record.constraints.createOnly=true;save();
  assert.equal((await harness(t,{extensions:[CURRENT]}).run(input)).code,'AUTHORIZATION_CONTEXT_INVALID');
  // CX15: the approval goes with the execution (the token of a preview); the engine also binds it to that preview.
  const token='00000000-0000-4000-8000-000000000001.0123456789abcdef';
  const removed=await h.run({action:'delete',host:HOST,extension:NAME,confirmationToken:token,words,authorizationContext:file});
  assert.equal(removed.ok,true);assert.equal(flag(h.scCalls.at(-1),'authorization-context'),file);
  assert.equal(flag(h.scCalls.at(-1),'words'),words);
  record.scope[1].operation='extension-publish';save();
  assert.equal((await h.run({action:'delete',host:HOST,extension:NAME,confirmationToken:token,words,authorizationContext:file})).code,'AUTHORIZATION_CONTEXT_INVALID');
  assert.equal(h.scCalls.length,2,'one publication and one deletion; no invalid request sent');
});

test('read: the active version downloaded, read by the kernel, with its consumers', async t => {
  const h = harness(t, { extensions: [CURRENT], consumers: () => [{ Name: 'Orders_CS' }] });
  const value = await h.run({ action: 'read', host: HOST, extension: NAME });
  assert.equal(value.ok, true); assert.equal(value.versionId, 7); assert.equal(value.extensionKey, 'ext-key-1');
  assert.deepEqual(value.spec, SPEC); assert.deepEqual(value.consumers, ['Orders_CS']); assert.equal(value.signatureHash, 'd'.repeat(64));
  assert.deepEqual(h.bridgeCalls.find(c => c.operation === 'DownloadExtension').args.versionId, 7);
  assert.deepEqual(h.kernelCalls.map(a => a[1]), ['read']);
  const out = h.kernelCalls[0][h.kernelCalls[0].indexOf('--resources-out') + 1];
  assert.ok(path.isAbsolute(out));
  assert.equal(value.exported.directory, out);
  assert.deepEqual(value.exported.references, [path.join(out, '0000', 'Example.dll')]);
  assert.equal(h.scCalls.length, 0, 'export never publishes');
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

test('referencesFrom delivers end-to-end with pinned source DLLs and license notices, without editing the caller spec', async t => {
  const source = { Name: 'PdfLibrary', Key: 'pdf-lib-key', Version_Id: 42, Id: 12 };
  const h = harness(t, { extensions: [source] });
  const spec = structuredClone(SPEC);
  const value = await h.run({ action: 'publish', host: HOST, spec, words: WORDS, referencesFrom: ['PdfLibrary', 'PdfLibrary'] });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(spec, SPEC);
  assert.equal(h.publishes().length, 1);
  assert.equal(h.kernelCalls.filter(a => a[1] === 'read').length, 1);
  assert.equal(h.bridgeCalls.filter(c => c.operation === 'ListExtensions').length, 1);
  assert.deepEqual(value.referenceSources, [{ extension: 'PdfLibrary', versionId: 42, xifSha256: 'c'.repeat(64), references: 1 }]);
  const receipt = JSON.parse(fs.readFileSync(path.join(h.root, '.local', 'xif', 'receipts', value.operationId + '.json'), 'utf8'));
  assert.deepEqual(receipt.referenceSources, value.referenceSources);
  assert.equal(receipt.xif, value.xif);
  const check = h.kernelCalls.find(a => a[1] === 'check');
  const resolved = JSON.parse(fs.readFileSync(check[check.indexOf('--spec') + 1], 'utf8'));
  assert.equal(fs.readFileSync(resolved.references[0], 'utf8'), 'dependency');
  assert.equal(resolved.resources[0].path, 'Licenses\\PdfLibrary\\Licenses\\LICENSE.txt');
  assert.equal(fs.readFileSync(resolved.resources[0].file, 'utf8'), 'license notice');
  const reconciled = await h.run({ action: 'publish', host: HOST, spec, referencesFrom: ['PdfLibrary'], operationId: value.operationId, words: WORDS });
  assert.equal(reconciled.reconciled, true);
  assert.deepEqual(reconciled.referenceSources, value.referenceSources);
  assert.equal(h.publishes().length, 1, 'reconciliation never publishes a second time');
});

test('referencesFrom refuses a missing source and conflicting DLLs before build or publish', async t => {
  const missing = harness(t);
  const refused = await missing.run({ action: 'publish', host: HOST, spec: SPEC, words: WORDS, referencesFrom: ['MissingLib'] });
  assert.equal(refused.code, 'XIF_REFERENCE_SOURCE_FAILED');
  assert.equal(missing.publishes().length, 0); assert.equal(missing.kernelCalls.length, 0);
  const h = harness(t, { extensions: [{ Name: 'PdfLibrary', Key: 'pdf-lib-key', Version_Id: 42 }] });
  const file = path.join(h.root, 'Example.dll'); fs.writeFileSync(file, 'incompatible library');
  const conflict = await h.run({ action: 'publish', host: HOST, spec: { ...SPEC, references: [file] }, words: WORDS, referencesFrom: ['PdfLibrary'] });
  assert.equal(conflict.code, 'XIF_REFERENCE_CONFLICT');
  assert.equal(h.publishes().length, 0); assert.equal(h.kernelCalls.filter(a => a[1] === 'build').length, 0);
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
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['action', 'application', 'applicationKey', 'authorizationContext', 'commitMessage', 'confirmHost', 'confirmationToken', 'consumers',
    'expectedVersionId', 'extension', 'host', 'operationId', 'ownerRequest', 'referencesFrom', 'spec', 'specFile', 'words']);
  assert.deepEqual(tool.inputSchema.required.sort(), ['action', 'host']);
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['read', 'publish', 'delete']);
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.doesNotMatch(JSON.stringify(tool.inputSchema), /Alone:|Instead of job/);
  assert.doesNotMatch(tool.description, /python|\.ps1|dotnet /i);
  const refused = await client.callTool({ name: 'o11_extension', arguments: { action: 'publish', host: 'https://lab.example.com', spec: SPEC } }).catch(error => ({ isError: true, error }));
  assert.equal(refused.isError, true);
  assert.equal(extensionSchema.safeParse({ action: 'publish', host: HOST, password: 'x' }).success, false);
});
