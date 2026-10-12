import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID, randomBytes, createCipheriv } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { debugSchema, parseDebugCli } from '../debug.mjs';
import { headlessDebug, consumeServerPrivateInspection, o11DebugRequest, o11TokenFailureIsUncertain, selectedO11Studio, O11_CROSS_MODULE_REDACTION } from '../debug-runtime.mjs';
import { createO11Runner, o11RunSchema } from '../debug-o11-run.mjs';
import { appUserBinding } from '../debug-app-user.mjs';

// Broker-only fixtures: no native SDK, public GET, GUI or private store is called.
function nativeEntryFixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-native-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = { lane: 'o11', host: 'native.example.test', module: 'Fixture', moduleKey: 'A'.repeat(22),
    applicationKey: 'B'.repeat(22), runtimeUrl: 'https://native.example.test/Fixture/' },
    input = { ...target, op: 'run', action: 'OriginalRefresh', execution: 'native-entry', trace: 'none',
      nativeEntry: { sourceContract: { path: path.join(root, 'public-source.json'), sha256: 'f'.repeat(64) } } },
    entry = { selector: input.action, actionKey: 'D'.repeat(22), endpoint: '/Fixture/screenservices/Fixture/Common/UserInfo/DataActionOriginal',
      apiVersion: 'E'.repeat(22), viewName: 'MainFlow.Home', inputsCount: 0,
      outputs: [{ name: 'Ready', type: 'Boolean' }, { name: 'Confirmed', type: 'Boolean' }] },
    events = [], counters = { loginSubmittedCount: 0, loginAnsweredCount: 0, loginUncertain: false,
      requestSubmittedCount: 0, requestAnsweredCount: 0, requestUncertain: false };
  let request, descriptor, receipt;
  const handle = {
    receipt: () => structuredClone(receipt),
    authenticate: async value => {
      events.push('login'); descriptor = value;
      Object.assign(receipt, { loginSubmittedCount: 1, loginAnsweredCount: 1 });
      if (overrides.authenticate) return overrides.authenticate({ value, receipt, events });
      return { ok: true, authenticated: true, nativeCheckRegisteredPassed: true, rolesLoadedFromServer: true };
    },
    invoke: async ({ beforeRequest }) => {
      events.push('invoke');
      const callback = { binding: descriptor.binding, sessionId: descriptor.binding.sessionId,
        sourceContractSha256: input.nativeEntry.sourceContract.sha256, actionKey: entry.actionKey, endpoint: entry.endpoint,
        apiVersion: entry.apiVersion, viewName: entry.viewName, inputsCount: 0, requestEnvelopeVerified: true, ccidSha256: 'c'.repeat(64) };
      const context = { beforeRequest, callback, receipt, events, root, request };
      if (overrides.invoke) return overrides.invoke(context);
      await beforeRequest(callback);
      const saved = JSON.parse(fs.readFileSync(path.join(request.directory, 'receipt.json'), 'utf8'));
      assert.equal(saved.requestReserved, true); assert.equal(saved.requestSubmittedCount, 0);
      events.push('private-fetch'); Object.assign(receipt, { requestSubmittedCount: 1, requestAnsweredCount: 1 });
      return { ok: true, outputs: { Ready: true, Confirmed: true }, password: 'synthetic-private-extra', cookies: 'synthetic-private-cookie' };
    },
    dispose: async () => {
      events.push('dispose');
      if (overrides.dispose) return overrides.dispose({ receipt, events });
      Object.assign(receipt, { memoryCleared: true, nativeContextReferencesReleased: true });
    },
  };
  const runner = createO11Runner({ root, lifecycle: {}, selected: async () => { throw new Error('native path must not select Studio'); },
    debug: async () => { throw new Error('native path must not start SDK trace'); },
    nativeBroker: { prepare: async value => {
      request = value; events.push('prepare');
      receipt = { schema: 'ssam-o11-native-entry-receipt/1', prepared: true, originalLoginController: true, publishedAbiValidated: true,
        sourceAssetsVerified: 18, sessionId: value.sessionId, sourceContract: value.sourceContract,
        target: { ...target, publishedVersionId: 5811, sourceSha256: 'a'.repeat(64) }, entry: structuredClone(entry),
        ...counters, memoryCleared: false, nativeContextReferencesReleased: false };
      if (overrides.prepare) return overrides.prepare({ value, receipt, handle, events });
      return handle;
    } },
    prepareUser: async (value, { sessionId }) => {
      events.push('prompt'); assert.equal(value.runtimeUrl, target.runtimeUrl); assert.equal(value.seconds, 600);
      if (overrides.prompt) return overrides.prompt({ value, sessionId, events, receipt });
      return { ok: true, descriptor: { credentialRef: randomUUID(), binding: appUserBinding(target, sessionId), state: 'credentials-entered',
        authenticated: false, expiresAt: new Date(Date.now() + 600000).toISOString() } };
    },
    releaseUser: async value => { events.push('forget'); assert.equal(value.credentialRef, descriptor?.credentialRef ?? value.credentialRef);
      return overrides.release ? overrides.release({ value, events }) : { ok: true }; },
  });
  return { root, target, input, entry, events, runner, handle,
    receipt: () => receipt, lock: () => path.join(root, '.local', 'debugger', 'native-entries', 'o11', target.host, target.moduleKey + '.lock') };
}

const host = 'fixture.outsystemscloud.com', moduleKey = 'A'.repeat(22), applicationKey = 'B'.repeat(22);
const selected = { pid: 12345, startedUtc: '2026-10-02T12:00:00Z', studioDir: path.resolve('fixture-studio') };
const id = 'c'.repeat(32), operationId = '12345678-1234-4234-8234-123456789abc';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-runtime-'));
  const proof = { host, capturedAtUtc: new Date().toISOString(), modules: [{ Name: 'Fixture', Key: moduleKey, ApplicationKey: applicationKey, VersionId: 7, IsActive: true }] };
  const proofPath = path.join(dir, 'inventory.json');
  const saveProof = value => {
    const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(proofPath, bytes);
    return { path: proofPath, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const input = { op: 'start', lane: 'o11', module: 'Fixture', moduleKey, runtimeUrl: 'https://' + host + '/Fixture/', nodeKeys: ['D'.repeat(22)],
    o11Auth: { applicationKey, publishedVersionId: 7, publishedProof: saveProof(proof) } };
  return { dir, proof, input, saveProof, close() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
function appUser(input, sessionId) {
  return { credentialRef: '12345678-1234-4234-8234-123456789abc', state: 'credentials-entered', expiresAt: new Date(Date.now() + 60000).toISOString(),
    binding: { lane: 'o11', runtimeUrl: input.runtimeUrl, app: input.module, sessionId, module: input.module, moduleKey: input.moduleKey } };
}
function privateReply(request, token = 'synthetic-private-bearer') {
  const { binding } = o11DebugRequest({ lane: 'o11', module: request.module, moduleKey: request.moduleKey, runtimeUrl: 'https://' + request.host + '/' + request.module + '/',
    o11Auth: { applicationKey: request.applicationKey, publishedVersionId: request.publishedVersionId, publishedProof: request.publishedProof } }, request.sessionId, selected, request.operationId);
  return { ok: true, operationId: request.operationId, binding, newAuthentication: true, path: 'oauth', token,
    soapUser: 'synthetic-sso-user', soapSecret: 'synthetic-private-id-token',
    preflight: { pingSucceeded: true, inDebug: true, debuggerVersion: 1 } };
}
function fakeWorker(onBootstrap, onSpawn = () => {}) {
  return (exe, args, options) => {
    onSpawn(exe, args, options);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.destroy = () => {};
    child.stdin = new EventEmitter(); child.stdin.destroy = () => {}; child.unref = () => {};
    child.stdin.end = text => { onBootstrap(text); queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, state: 'connected' }) + '\n'))); };
    return child;
  };
}
function services(f, extra = {}) {
  return { sessionRoot: path.join(f.dir, 'sessions'), selectedO11Studio: async () => selected, worker: async () => path.join(f.dir, 'SSAM.Debugger.dll'),
    prepareAppUser: async (input, { sessionId }) => ({ ok: true, descriptor: appUser(input, sessionId) }), releaseAppUser: async () => ({ ok: true }),
    privateAppUserVault: async (mode, descriptor) => {
      assert.equal(mode, 'read');
      return { ok: true, kind: 'credentials', binding: descriptor.binding, expiresAt: descriptor.expiresAt,
        username: 'synthetic-app-user', password: 'synthetic-app-password' };
    },
    journal: () => {}, ...extra };
}

test('private server bootstrap and public read retain plaintext only in the internal consumer and invalidate before uncertain control', async () => {
  const f=fixture();let bootstrap,sessionId;
  const variable={moduleKey:f.input.moduleKey,functionKey:'E'.repeat(22),variableKey:'F'.repeat(22),sourceSha256:'a'.repeat(64),name:'Secret',category:'local',path:'Secret'};
  const context={runtime:'server',threadId:'T',eventId:'1',generation:1,frame:0,moduleKey:variable.moduleKey,functionKey:variable.functionKey,nodeKey:f.input.nodeKeys[0]};
  const reference='b'.repeat(32),value={type:'Scalar',value:'private-server-value-Ω'};
  const svc=services(f,{getO11DebugToken:async r=>privateReply(r),spawn:fakeWorker(text=>bootstrap=JSON.parse(text)),
    pipeRequest:async(id,r)=>{
      assert.equal(id,sessionId);
      if(r.op==='scope')return{ok:true,context};
      if(r.op==='frame')throw new Error('debug_command_uncertain');
      if(r.op==='stop')return{ok:true,state:'stopped'};
      assert.equal(r.op,'private-read');
      const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(bootstrap.privateInspectionKey,'hex'),nonce);
      cipher.setAAD(Buffer.from('ssam-server-private-inspection/1|'+sessionId));
      const ciphertext=Buffer.concat([cipher.update(JSON.stringify({context,variable:{ref:reference,moduleKey:variable.moduleKey,sourceSha256:variable.sourceSha256},value})),cipher.final()]);
      return{ok:true,context,reference,evaluationRevision:1,changed:null,privatePayload:{format:'ssam-server-private-inspection/1',nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}};
    }});
  try{
    const started=await headlessDebug({...f.input,autoContinue:false,inspection:{variables:[variable]}},{services:svc});sessionId=started.sessionId;
    assert.match(bootstrap.privateInspectionKey,/^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(started).includes(bootstrap.privateInspectionKey),false);
    assert.equal(fs.readFileSync(path.join(svc.sessionRoot,sessionId,'manifest.json'),'utf8').includes(bootstrap.privateInspectionKey),false);
    const result=await headlessDebug({op:'private-read',sessionId,threadId:'T',eventId:'1',reference},{services:svc});
    assert.equal(result.privateInspection.roundTripVerified,true);assert.doesNotMatch(JSON.stringify(result),/private-server-value|ciphertext|privatePayload/);
    let observed;await consumeServerPrivateInspection({sessionId,threadId:'T',eventId:'1',descriptor:result.privateInspection},v=>{observed=v;},svc);
    assert.deepEqual(observed,value);
    await assert.rejects(headlessDebug({op:'frame',sessionId,threadId:'T',eventId:'1',frame:0},{services:svc}),/debug_command_uncertain/);
    await assert.rejects(consumeServerPrivateInspection({sessionId,threadId:'T',eventId:'1',descriptor:result.privateInspection},()=>{},svc),/unavailable/);
    const stopped=await headlessDebug({op:'stop',sessionId},{services:svc});assert.deepEqual(stopped.privateInspectionCleanup,{completed:true,pending:0});
  }finally{if(sessionId)await headlessDebug({op:'stop',sessionId},{services:svc}).catch(()=>{});f.close();}
});

test('a stopped native debugger cannot claim private cleanup after losing its owning controller', async () => {
  const f=fixture(),sessionId='d'.repeat(32),directory=path.join(f.dir,'sessions',sessionId);
  fs.mkdirSync(directory,{recursive:true});
  const manifest={sessionId,lane:'o11',module:'Fixture',moduleKey:f.input.moduleKey,runtimeUrl:f.input.runtimeUrl,
    privateInspectionEnabled:true,receiptPath:path.join(directory,'receipt.json'),lock:path.join(directory,'absent.lock')};
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  try{
    const result=await headlessDebug({op:'status',sessionId},{services:services(f,{pipeRequest:async()=>({ok:true,state:'stopped'})})});
    assert.equal(result.state,'stopped');assert.equal(result.ok,false);assert.equal(result.error,'debug_private_inspection_cleanup_failed');
    assert.deepEqual(result.privateInspectionCleanup,{completed:false,pending:null,ownerAvailable:false});
  }finally{f.close();}
});

test('local pre-start failure preserves safe diagnostic and certainty without token or worker', async () => {
  for (const message of ['debug_o11_selected_studio_unavailable', 'private username and password']) {
    const f = fixture(); let touched = false;
    try {
      const svc = services(f, { selectedO11Studio: async () => { throw new Error(message); },
        getO11DebugToken: async () => { touched = true; }, spawn: () => { touched = true; } });
      const result = await headlessDebug(f.input, { services: svc });
      assert.equal(result.ok, false); assert.equal(result.state, 'not-started');
      assert.equal(result.workerStarted, false); assert.equal(result.uncertain, false);
      assert.equal(result.error, message.startsWith('debug_') ? message : 'debug_local_start_failed');
      assert.equal(touched, false);
      assert.deepEqual(fs.readdirSync(svc.sessionRoot).filter(file => file.endsWith('.lock')), []);
      assert.deepEqual(JSON.parse(fs.readFileSync(result.receiptPath)), result);
      assert.doesNotMatch(JSON.stringify(result), /private username|password/);
    } finally { f.close(); }
  }
});

test('public server model scope is prepared before authentication and reaches native bootstrap without caller variable paths', async () => {
  const f = fixture(); let bootstrap, readCalled = false;
  try {
    const modelScope = { source: { path: path.join(f.dir, 'published.oml'), sha256: 'a'.repeat(64) },
      scopes: [{ functionKey: 'E'.repeat(22), nodeKeys: f.input.nodeKeys }] };
    const variable = { moduleKey, functionKey: modelScope.scopes[0].functionKey, nodeKey: f.input.nodeKeys[0],
      variableKey: 'F'.repeat(22), sourceSha256: modelScope.source.sha256, name: 'Result', category: 'local', path: 'Result' };
    const input = { ...f.input, modelScope, autoContinue: false };
    const file = path.join(f.dir, 'scope.json'); fs.writeFileSync(file, JSON.stringify(modelScope));
    assert.deepEqual(parseDebugCli(['start', '--lane', 'o11', '--module', 'Fixture', '--module-key', moduleKey,
      '--runtime-url', input.runtimeUrl, '--node-keys', input.nodeKeys[0], '--manual', '--model-scope', file]).modelScope, modelScope);
    for (const patch of [{ inspection: { variables: [] } }, { autoContinue: true }, { op: 'watch' },
      { modelScope: { ...modelScope, scopes: [{ ...modelScope.scopes[0], nodeKeys: ['G'.repeat(22)] }] } }])
      assert.equal(debugSchema.safeParse({ ...input, ...patch }).success, false);
    const svc = services(f, {
      readScopes: async request => { readCalled = true; assert.equal(request.runtime, 'server'); assert.deepEqual(request.source, modelScope.source);
        assert.equal(fs.existsSync(path.join(f.dir, 'sessions')), false);
        return { variables: [variable], evidence: [file], coverage: [{ scopeComplete: false }] }; },
      getO11DebugToken: async request => { assert.equal(readCalled, true); return privateReply(request); },
      spawn: fakeWorker(text => { bootstrap = JSON.parse(text); }),
    });
    const result = await headlessDebug(input, { services: svc });
    assert.deepEqual(bootstrap.inspection.variables, [variable]);
    assert.equal(bootstrap.autoContinue, false);
    assert.equal(result.modelScopeEvidence.publishedBindingVerified, false);
    assert.equal(result.modelScopeEvidence.runtimeValuesEvaluated, false);
    const status = await headlessDebug({ op: 'status', sessionId: result.sessionId },
      { services: { ...svc, pipeRequest: async () => ({ ok: true, state: 'connected' }) } });
    assert.deepEqual(status.modelScopeEvidence, result.modelScopeEvidence);
  } finally { f.close(); }
});

for (const lane of ['o11', 'odc']) test(lane + ': model refusal creates no target lock, login or debugger start', async () => {
  const f = fixture(); let touched = false;
  try {
    const input = { ...f.input, lane, ...(lane === 'odc' ? { tenant: 'fixture', o11Auth: undefined } : {}), autoContinue: false,
      modelScope: { source: { path: path.join(f.dir, 'source.oml'), sha256: 'a'.repeat(64) },
        scopes: [{ functionKey: 'E'.repeat(22), nodeKeys: f.input.nodeKeys }] } };
    const touch = () => { touched = true; throw new Error('unexpected authentication'); };
    const svc = services(f, { readScopes: async () => { throw new Error('debug_native_scope_source_changed'); },
      getOdcDebugToken: touch, getO11DebugToken: touch, prepareAppUser: touch, spawn: touch });
    await assert.rejects(headlessDebug(input, { services: svc }), /source_changed/);
    assert.equal(touched, false); assert.equal(fs.existsSync(svc.sessionRoot), false);
    svc.readScopes = async () => ({ variables: Array.from({ length: 501 }, () => ({})) });
    await assert.rejects(headlessDebug(input, { services: svc }), /server_metadata_invalid/);
    assert.equal(touched, false); assert.equal(fs.existsSync(svc.sessionRoot), false);
  } finally { f.close(); }
});

test('SSO start metadata is strict, requires a declared entry, and CLI reads no public bearer or PID', () => {
  const f = fixture();
  try {
    assert.equal(debugSchema.parse(f.input).o11Auth.publishedVersionId, 7);
    for (const changed of [
      { ...f.input, lane: 'odc' }, { ...f.input, op: 'status', sessionId: id }, { ...f.input, credentials: 'developer.json' },
      { ...f.input, runtimeUrl: 'https://' + host + '/Other/' }, { ...f.input, runtimeUrl: 'https://' + host + ':8443/Fixture/' },
      { ...f.input, o11Auth: { ...f.input.o11Auth, token: 'private-value' } }, { ...f.input, o11Auth: { ...f.input.o11Auth, pid: 999 } },
      { ...f.input, o11Auth: { ...f.input.o11Auth, publishedProof: { path: 'relative.json', sha256: 'e'.repeat(64) } } },
    ]) assert.equal(debugSchema.safeParse(changed).success, false);
    const file = path.join(f.dir, 'auth.json'); fs.writeFileSync(file, JSON.stringify(f.input.o11Auth));
    const args = ['start', '--lane', 'o11', '--module', 'Fixture', '--module-key', moduleKey, '--runtime-url', f.input.runtimeUrl, '--node-keys', f.input.nodeKeys[0], '--o11-auth', file];
    assert.deepEqual(parseDebugCli(args).o11Auth, f.input.o11Auth);
    fs.writeFileSync(file, JSON.stringify({ ...f.input.o11Auth, token: 'do-not-echo-me' }));
    assert.throws(() => parseDebugCli(args), /^Error: debug_o11_auth_file_invalid$/);
  } finally { f.close(); }
});

test('separate O11 entry requires published evidence for consumer and producer', () => {
  const f = fixture();
  try {
    const entry = { module: 'Consumer', moduleKey: 'C'.repeat(22), applicationKey: 'E'.repeat(22), publishedVersionId: 9 };
    const input = { ...f.input, runtimeUrl: 'https://' + host + '/Consumer/', o11Auth: { ...f.input.o11Auth, entry } };
    assert.equal(debugSchema.safeParse(input).success, true);
    assert.throws(() => o11DebugRequest(input, id, selected), /module_scope_mismatch/);
    f.proof.modules.push({ Name: entry.module, Key: entry.moduleKey, ApplicationKey: entry.applicationKey, VersionId: 9, IsActive: true });
    input.o11Auth.publishedProof = f.saveProof(f.proof);
    assert.deepEqual(o11DebugRequest(input, id, selected).request.entry, entry);
    assert.equal(debugSchema.safeParse({ ...input, runtimeUrl: 'https://' + host + '/Different/' }).success, false);
  } finally { f.close(); }
});

test('published proof rejects host, module, app, version, freshness and exact-byte mismatches before SSO', () => {
  const f = fixture();
  try {
    assert.equal(o11DebugRequest(f.input, id, selected, operationId).binding.publishedVersionId, 7);
    const original = structuredClone(f.proof);
    for (const patch of [{ host: 'other.outsystemscloud.com' }, { capturedAtUtc: new Date(Date.now() - 901000).toISOString() },
      ...['Name', 'Key', 'ApplicationKey', 'VersionId', 'IsActive'].map(field => ({ field }))]) {
      const proof = structuredClone(original);
      if (patch.field) proof.modules[0][patch.field] = ({ Name: 'Other', Key: 'E'.repeat(22), ApplicationKey: 'F'.repeat(22), VersionId: 8, IsActive: false })[patch.field];
      else Object.assign(proof, patch);
      f.input.o11Auth.publishedProof = f.saveProof(proof);
      assert.throws(() => o11DebugRequest(f.input, id, selected, operationId), /debug_o11_/);
    }
    f.input.o11Auth.publishedProof = f.saveProof(original);
    fs.appendFileSync(f.input.o11Auth.publishedProof.path, ' ');
    assert.throws(() => o11DebugRequest(f.input, id, selected, operationId), /proof_changed/);
  } finally { f.close(); }
});

test('SSO authority comes from the selected connected lane and refuses disconnected/replaced processes and installations', async () => {
  const lane = { root: path.resolve('fixture-root'), lane: 'ss4' }, record = { ...selected, port: 4516 };
  const base = { lane, readConnection: () => record, assertSelectedO11: async () => {}, probeO11: async () => ({ connected: true, pid: record.pid }),
    anvilLaneFacts: async () => ({ studioDir: record.studioDir }) };
  assert.deepEqual(await selectedO11Studio(base), selected);
  for (const changed of [{ readConnection: () => null }, { probeO11: async () => ({ connected: false }) },
    { probeO11: async () => ({ connected: true, pid: 999 }) }, { anvilLaneFacts: async () => ({ studioDir: path.resolve('other-studio') }) }])
    await assert.rejects(selectedO11Studio({ ...base, ...changed }), /^Error: debug_o11_selected_studio_unavailable$/);
  let reads = 0;
  await assert.rejects(selectedO11Studio({ ...base, readConnection: () => ++reads === 1 ? record : { ...record, startedUtc: '2026-10-02T13:00:00Z' } }), /selected_studio_unavailable/);
});

test('production start prompts first, then passes the private native token only to worker stdin and keeps app identity unverified', async () => {
  const f = fixture(), events = [], journals = []; let bootstrap, args;
  try {
    const svc = services(f, {
      prepareAppUser: async (input, { sessionId }) => { events.push('prompt'); return { ok: true, descriptor: appUser(input, sessionId) }; },
      getO11DebugToken: async request => { events.push('token'); assert.equal(request.pid, selected.pid); assert.equal(request.startedUtc, selected.startedUtc); return privateReply(request); },
      spawn: fakeWorker(text => { bootstrap = JSON.parse(text); events.push('stdin'); }, (exe, argv, options) => { args = { exe, argv, options }; events.push('spawn'); }),
      journal: entry => journals.push(entry),
    });
    const result = await headlessDebug(f.input, { services: svc });
    assert.deepEqual(events, ['prompt', 'token', 'spawn', 'stdin']);
    assert.equal(bootstrap.token, 'synthetic-private-bearer'); assert.equal(bootstrap.credentials, undefined);
    assert.equal(bootstrap.soapUser, 'synthetic-sso-user'); assert.equal(bootstrap.soapSecret, 'synthetic-private-id-token');
    assert.deepEqual(bootstrap.privateValues, ['synthetic-app-user', 'synthetic-app-password']);
    assert.equal(bootstrap.newAuthentication, undefined); assert.equal(result.appUser.authenticated, false);
    assert.equal(result.appUser.state, 'credentials-entered');
    const manifest = JSON.parse(fs.readFileSync(path.join(svc.sessionRoot, result.sessionId, 'manifest.json')));
    assert.equal(manifest.o11Auth.binding.sessionId, result.sessionId); assert.equal(manifest.o11Auth.binding.pid, selected.pid);
    assert.equal(manifest.o11Auth.binding.applicationKey, applicationKey);
    for (const value of [args, result, journals, manifest, JSON.parse(fs.readFileSync(result.receiptPath))])
      assert.doesNotMatch(JSON.stringify(value), /synthetic-private-bearer|synthetic-private-id-token|synthetic-sso-user|synthetic-app-user|synthetic-app-password|privateValues/);
  } finally { f.close(); }
});

test('cancel, changed proof and wrong token scope stop before any worker or action; auth uncertainty retains its lock', async () => {
  for (const kind of ['cancel', 'proof', 'reply', 'uncertain']) {
    const f = fixture(); let tokenCalls = 0, spawned = 0, released = 0;
    try {
      const svc = services(f, {
        prepareAppUser: async (input, { sessionId }) => {
          if (kind === 'cancel') return { ok: false, state: 'cancelled' };
          if (kind === 'proof') fs.appendFileSync(input.o11Auth.publishedProof.path, ' ');
          return { ok: true, descriptor: appUser(input, sessionId) };
        },
        getO11DebugToken: async request => { tokenCalls++; if (kind === 'uncertain') throw new Error('debug_o11_token_exchange_uncertain');
          return { ...privateReply(request), binding: { ...privateReply(request).binding, host: 'wrong.outsystemscloud.com' } }; },
        authOperationPhase: () => kind === 'proof' ? 'failed' : 'uncertain',
        spawn: () => { spawned++; throw new Error('must not spawn'); }, releaseAppUser: async () => { released++; return { ok: true }; },
      });
      if (kind === 'proof') {
        const result = await headlessDebug(f.input, { services: svc });
        assert.equal(result.state, 'not-started'); assert.equal(result.error, 'debug_o11_publication_proof_changed');
        assert.equal(tokenCalls, 0); assert.equal(released, 1);
      } else {
        const result = await headlessDebug(f.input, { services: svc });
        if (kind === 'cancel') { assert.equal(result.state, 'cancelled'); assert.equal(tokenCalls, 0); }
        else {
          assert.equal(result.state, 'token-uncertain'); assert.equal(tokenCalls, 1); assert.equal(released, 0);
          const manifest = JSON.parse(fs.readFileSync(path.join(svc.sessionRoot, result.sessionId, 'manifest.json')));
          assert.ok(fs.existsSync(manifest.lock));
          assert.doesNotMatch(fs.readFileSync(result.receiptPath, 'utf8'), /synthetic-private-bearer/);
          const commandServices = { ...svc, pipeRequest: async () => { throw new Error('debug_session_unreachable'); } };
          for (const op of ['status', 'stop']) {
            const command = await headlessDebug({ op, sessionId: result.sessionId }, { services: commandServices });
            assert.equal(command.state, 'token-uncertain'); assert.equal(command.ok, false); assert.ok(fs.existsSync(manifest.lock));
          }
          await assert.rejects(headlessDebug(f.input, { services: svc }), /debug_target_has_session/); assert.equal(tokenCalls, 1);
        }
      }
      assert.equal(spawned, 0);
    } finally { f.close(); }
  }
});

test('failed token mint cleans up, allowed large token fits the native 1 MiB bootstrap, legacy mode remains separate', async () => {
  for (const kind of ['failed', 'large', 'legacy']) {
    const f = fixture(); let calls = 0, releases = 0, body;
    try {
      const svc = services(f, { installation: async () => selected.studioDir, selectedO11Studio: async () => { calls++; return selected; },
        getO11DebugToken: async request => { calls++; if (kind === 'failed') throw new Error('debug_o11_token_exchange_unavailable'); return privateReply(request, 's'.repeat(65536)); },
        authOperationPhase: () => 'failed', releaseAppUser: async () => { releases++; return { ok: true }; },
        spawn: fakeWorker(text => { body = JSON.parse(text); }),
      });
      const input = kind === 'legacy' ? { ...f.input, o11Auth: undefined, credentials: path.join(f.dir, 'developer-private.json') } : f.input;
      if (kind === 'legacy') {
        const result = await headlessDebug(input, { services: svc });
        assert.equal(result.state, 'connected'); assert.equal(calls, 0); assert.equal(body.token, undefined); assert.equal(body.credentials, input.credentials);
      } else if (kind === 'large') {
        const result = await headlessDebug(input, { services: svc });
        assert.equal(result.state, 'connected'); assert.equal(body.token.length, 65536);
        assert.ok(JSON.stringify(body).length < 1024 * 1024);
      } else {
        const result = await headlessDebug(input, { services: svc });
        assert.equal(result.state, 'not-started'); assert.equal(result.error, 'debug_o11_token_exchange_unavailable');
        assert.equal(releases, 1); assert.equal(body, undefined);
        assert.deepEqual(fs.readdirSync(svc.sessionRoot).filter(file => file.endsWith('.lock')), []);
      }
    } finally { f.close(); }
  }
});

test('only proven pre-attach failures release a token operation; unknown post-attach errors stay uncertain', () => {
  assert.equal(o11TokenFailureIsUncertain(new Error('debug_o11_token_exchange_uncertain'), 'uncertain'), true);
  assert.equal(o11TokenFailureIsUncertain(new Error('debug_o11_token_exchange_unavailable'), 'failed'), false);
  assert.equal(o11TokenFailureIsUncertain(new Error('debug_o11_publication_proof_stale'), null), false);
  assert.equal(o11TokenFailureIsUncertain(new Error('debug_o11_auth_hook_build_failed'), null), false);
  assert.equal(o11TokenFailureIsUncertain(new Error('untrusted SDK message with secret'), null), true);
});

test('incomplete or malformed native SOAP context never spawns a worker or leaks a private value', async () => {
  for (const patch of [{ soapUser: undefined }, { soapSecret: undefined }, { soapUser: '' },
    { soapSecret: 'synthetic-private-id-token\n' }, { soapUser: 'x'.repeat(513) }, { soapSecret: 'é'.repeat(32769) },
    { preflight: undefined }, { preflight: { pingSucceeded: true, inDebug: false, debuggerVersion: 1 } },
    { preflight: { pingSucceeded: true, inDebug: true, debuggerVersion: 2 } },
    { preflight: { pingSucceeded: true, inDebug: true, debuggerVersion: 1, rawNativeMessage: 'private-value' } }]) {
    const f = fixture(); let spawned = false;
    try {
      const svc = services(f, { getO11DebugToken: async request => ({ ...privateReply(request), ...patch }),
        authOperationPhase: () => 'consumed', spawn: () => { spawned = true; throw new Error('must not spawn'); } });
      const result = await headlessDebug(f.input, { services: svc });
      assert.equal(spawned, false); assert.equal(result.state, 'token-uncertain');
      assert.equal(result.error, 'debug_o11_token_response_invalid');
      assert.doesNotMatch(JSON.stringify(result), /synthetic-private|synthetic-sso-user/);
    } finally { f.close(); }
  }
});

test('private credential binding fails before SSO or worker and leaves only safe local receipts', async () => {
  for (const kind of ['binding', 'expired', 'thrown']) {
    const f = fixture(); let tokens = 0, spawned = 0, released = 0;
    try {
      const svc = services(f, {
        privateAppUserVault: async (mode, descriptor) => {
          if (kind === 'thrown') throw new Error('private-app-user private-password private-server-body');
          return { ok: true, kind: 'credentials', binding: kind === 'binding' ? { ...descriptor.binding, moduleKey: 'Z'.repeat(22) } : descriptor.binding,
            expiresAt: kind === 'expired' ? new Date(0).toISOString() : descriptor.expiresAt, username: 'private-app-user', password: 'private-password' };
        },
        getO11DebugToken: async () => { tokens++; throw new Error('must not mint'); },
        spawn: () => { spawned++; throw new Error('must not spawn'); }, releaseAppUser: async () => { released++; return { ok: true }; },
      });
      const result = await headlessDebug(f.input, { services: svc });
      assert.equal(result.state, 'not-started'); assert.equal(result.error, 'debug_app_user_credentials_unavailable');
      assert.equal(tokens, 0); assert.equal(spawned, 0); assert.equal(released, 1);
      for (const entry of fs.readdirSync(svc.sessionRoot)) {
        assert.equal(entry.endsWith('.lock'), false);
        for (const name of ['manifest.json', 'receipt.json']) assert.doesNotMatch(fs.readFileSync(path.join(svc.sessionRoot, entry, name), 'utf8'), /private-app-user|private-password|private-server-body|privateValues/);
      }
    } finally { f.close(); }
  }
});

// D1 (consolidation 99d8982e, rewritten for this runtime's signature): a producer-module session filters private values
// with the consumer's app user. The runner passes that descriptor with redactionOnly (debugRedactionBinding); it is
// redaction evidence only, never authorization, and the native SSO stays on the producer module.
test('producer-module trace: the consumer app user is redaction evidence only, with the same private values as the same module', async () => {
  const consumer = { module: 'Consumer', moduleKey: 'E'.repeat(22) };
  const consumerUser = (input, sessionId) => ({ ...appUser(input, sessionId),
    binding: { lane: 'o11', runtimeUrl: 'https://' + host + '/' + consumer.module + '/', app: consumer.module, sessionId, ...consumer } });
  assert.equal(O11_CROSS_MODULE_REDACTION, true);
  const run = async (f, descriptor, redactionOnly = false) => {
    const events = [], reads = []; let bootstrap;
    const svc = services(f, {
      prepareAppUser: async () => { events.push('prompt'); throw new Error('a producer trace never prompts'); },
      privateAppUserVault: async (mode, request) => { reads.push(request.binding);
        return { ok: true, kind: 'credentials', binding: request.binding, expiresAt: request.expiresAt, username: 'synthetic-app-user', password: 'synthetic-app-password' }; },
      releaseAppUser: async () => { events.push('release'); return { ok: true }; },
      getO11DebugToken: async request => { events.push('token:' + request.module); return privateReply(request); },
      spawn: fakeWorker(text => { bootstrap = JSON.parse(text); events.push('stdin'); }),
    });
    const result = await headlessDebug(f.input, { appUser: descriptor, ...(redactionOnly ? { redactionOnly: true } : {}), services: svc });
    return { result, events, reads, bootstrap, svc };
  };
  const f = fixture(), same = fixture();
  try {
    const sessionId = 'd'.repeat(32), descriptor = consumerUser(f.input, sessionId);
    const cross = await run(f, descriptor, true);
    assert.equal(cross.result.state, 'connected'); assert.equal(cross.result.sessionId, sessionId);
    assert.deepEqual(cross.events, ['token:Fixture', 'stdin']);
    assert.deepEqual(cross.reads, [descriptor.binding]); // the vault is opened only for the consumer binding it was sealed for
    assert.equal(cross.bootstrap.module, 'Fixture'); assert.equal(cross.bootstrap.moduleKey, moduleKey); assert.equal(cross.bootstrap.runtimeUrl, f.input.runtimeUrl);
    const parity = await run(same, appUser(same.input, sessionId));
    assert.deepEqual(cross.bootstrap.privateValues, parity.bootstrap.privateValues);
    assert.deepEqual(cross.bootstrap.privateValues, ['synthetic-app-user', 'synthetic-app-password']);
    const manifest = JSON.parse(fs.readFileSync(path.join(cross.svc.sessionRoot, sessionId, 'manifest.json')));
    // The borrowed descriptor stays the consumer's and proves no app request identity (the old appUserScope).
    assert.equal(manifest.appUserBorrowed, true); assert.equal(manifest.appRequestIdentityProved, false);
    assert.deepEqual([manifest.appUser.binding.module, manifest.appUser.binding.moduleKey], [consumer.module, consumer.moduleKey]);
    assert.equal(manifest.module, 'Fixture');
    assert.equal(manifest.o11Auth.binding.moduleKey, moduleKey); // SSO authority stays on the producer module
    for (const value of [cross.result, manifest, JSON.parse(fs.readFileSync(cross.result.receiptPath))])
      assert.doesNotMatch(JSON.stringify(value), /synthetic-private-bearer|synthetic-private-id-token|synthetic-sso-user|synthetic-app-user|synthetic-app-password|privateValues/);
  } finally { f.close(); same.close(); }
});

test('producer-module trace refuses a foreign, expired or non-borrowed consumer descriptor before vault, SSO or worker', async () => {
  const consumer = { module: 'Consumer', moduleKey: 'E'.repeat(22) }, sessionId = 'd'.repeat(32);
  const user = (patch = {}) => ({ ...appUser({ runtimeUrl: 'https://' + host + '/Consumer/', module: 'Consumer', moduleKey: consumer.moduleKey }, sessionId),
    ...(patch.expiresAt ? { expiresAt: patch.expiresAt } : {}),
    ...(patch.binding ? { binding: { ...appUser({ runtimeUrl: 'https://' + host + '/Consumer/', module: 'Consumer', moduleKey: consumer.moduleKey }, sessionId).binding, ...patch.binding } } : {}) });
  const cases = [
    ['consumer descriptor without redactionOnly', user(), false, {}],
    ['expired consumer descriptor', user({ expiresAt: new Date(Date.now() - 1000).toISOString() }), true, {}],
    ['descriptor of another origin', user({ binding: { runtimeUrl: 'https://other.outsystemscloud.com/Consumer/' } }), true, {}],
    ['descriptor of another lane', user({ binding: { lane: 'odc' } }), true, {}],
    ['legacy developer credentials (no native SSO)', user(), true, { o11Auth: undefined, credentials: 'C:\\fixture\\developer.json' }],
    ['ODC lane without a producer trace', user({ binding: { lane: 'odc' } }), true, { lane: 'odc', tenant: 'fixture-tenant', o11Auth: undefined }],
  ];
  for (const [name, descriptor, redactionOnly, patch] of cases) {
    const f = fixture(); const touched = [];
    try {
      const svc = services(f, { prepareAppUser: async () => { touched.push('prompt'); return { ok: false }; },
        privateAppUserVault: async () => { touched.push('vault'); throw new Error('must not read'); },
        getO11DebugToken: async () => { touched.push('token'); throw new Error('must not mint'); }, getOdcDebugToken: async () => { touched.push('odc-token'); return 'x'; },
        spawn: () => { touched.push('spawn'); throw new Error('must not spawn'); } });
      await assert.rejects(headlessDebug({ ...f.input, ...patch }, { appUser: descriptor, redactionOnly, services: svc }), /^Error: debug_app_user_(scope_mismatch|invalid_target)$/, name);
      assert.deepEqual(touched, [], name);
      assert.equal(fs.existsSync(svc.sessionRoot) ? fs.readdirSync(svc.sessionRoot).length : 0, 0, name); // no lock, no manifest
    } finally { f.close(); }
  }
});

test('ODC bootstrap uses sealed app tokens privately without retaining the discarded password or public identity strings', async () => {
  const f = fixture(); let bootstrap, argv, opened;
  try {
    const input = { ...f.input, lane: 'odc', tenant: 'fixture-tenant', o11Auth: undefined };
    const userKey = '22345678-1234-4234-8234-123456789abc';
    const svc = services(f, {
      getOdcDebugToken: async () => 'synthetic-odc-debug-bearer', installation: async () => selected.studioDir,
      prepareAppUser: async (input, { sessionId }) => ({ ok: true, descriptor: { ...appUser(input, sessionId),
        binding: { ...appUser(input, sessionId).binding, lane: 'odc' }, state: 'authenticated', authenticated: true, userKey } }),
      privateAppUserVault: async (mode, descriptor) => {
        opened = { ok: true, kind: 'session', binding: descriptor.binding, expiresAt: descriptor.expiresAt,
          password: 'already-discarded-odc-password', session: { binding: descriptor.binding, expiresAt: descriptor.expiresAt,
            userKey, accessToken: 'synthetic-odc-app-access', idToken: 'synthetic-odc-app-id', refreshToken: 'synthetic-odc-app-refresh', email: 'synthetic-odc-email@example.invalid' } };
        return opened;
      },
      spawn: fakeWorker(text => { bootstrap = JSON.parse(text); }, (exe, args, options) => { argv = { exe, args, options }; }),
    });
    const result = await headlessDebug(input, { services: svc });
    assert.equal(result.state, 'connected'); assert.equal(bootstrap.token, 'synthetic-odc-debug-bearer');
    assert.deepEqual(bootstrap.privateValues, ['synthetic-odc-app-access', 'synthetic-odc-app-id', 'synthetic-odc-app-refresh', 'synthetic-odc-email@example.invalid']);
    assert.equal(opened.password, ''); assert.equal(opened.session.accessToken, '');
    assert.doesNotMatch(JSON.stringify(bootstrap), /already-discarded-odc-password/);
    const manifest = JSON.parse(fs.readFileSync(path.join(svc.sessionRoot, result.sessionId, 'manifest.json')));
    for (const value of [argv, result, manifest, JSON.parse(fs.readFileSync(result.receiptPath))])
      assert.doesNotMatch(JSON.stringify(value), /synthetic-odc-(debug|app|email)|already-discarded|privateValues/);
  } finally { f.close(); }
});

test('native-entry runner requires its explicit source ABI and refuses inputs, tracing and REST fallback', t => {
  const f = nativeEntryFixture(t);
  assert.equal(o11RunSchema.parse(f.input).execution, 'native-entry');
  assert.equal(o11RunSchema.parse({ ...f.target, op: 'prepare', action: 'OriginalAction' }).execution, 'rest-wrapper');
  // Without nativeEntry the request is the graph native-entry (deterministic entry resolution), never the REST fallback.
  const graph = o11RunSchema.parse({ ...f.input, nativeEntry: undefined, trace: undefined });
  assert.equal(graph.execution, 'native-entry'); assert.equal(graph.nativeEntry, undefined); assert.equal(graph.trace, undefined);
  for (const patch of [{ keep: true }, { words: 'x' }, { around: 'K'.repeat(22) }, { op: 'release' }, { scenarios: [{ name: 'one', trace: true }] }])
    assert.equal(o11RunSchema.safeParse({ ...f.input, nativeEntry: undefined, ...patch }).success, false);
  for (const patch of [{ entry: 'x' }, { trace: 'nodes' }, { window: { before: 1 } }])
    assert.equal(o11RunSchema.safeParse({ ...f.input, ...patch }).success, false);
  for (const patch of [{ trace: 'all' }, { keep: true }, { inputs: { Count: 1 } },
    { scenarios: [{ name: 'one' }, { name: 'two' }] }, { op: 'release' }, { password: 'synthetic-private' },
    { nativeEntry: { sourceContract: { path: 'relative.json', sha256: 'f'.repeat(64) } } }])
    assert.equal(o11RunSchema.safeParse({ ...f.input, ...patch }).success, false);
  assert.equal(o11RunSchema.safeParse({ ...f.target, op: 'run', action: 'OriginalAction', nativeEntry: f.input.nativeEntry }).success, false);
  assert.deepEqual(f.events, []);
});

test('native-entry runner prepares before prompting, accounts before one POST and returns only typed profile outputs', async t => {
  const f = nativeEntryFixture(t), result = await f.runner(f.input);
  assert.equal(result.ok, true); assert.equal(result.state, 'answered');
  assert.deepEqual(f.events, ['prepare', 'prompt', 'login', 'invoke', 'private-fetch', 'dispose', 'forget']);
  assert.equal(result.loginSubmittedCount, 1); assert.equal(result.loginAnsweredCount, 1);
  assert.equal(result.requestSubmittedCount, 1); assert.equal(result.requestAnsweredCount, 1); assert.equal(result.requestEnvelopeVerified, true);
  assert.deepEqual(result.outputs, { Ready: true, Confirmed: true });
  for (const field of ['nativeClientRequestBound', 'nativeCallContextObjectVerified', 'userRequestIsolationProved', 'serverTraceProved', 'serviceFramesProved', 'debuggerStarted'])
    assert.equal(result[field], false);
  assert.equal(result.credentialsReleased, true); assert.equal(result.memoryCleared, true); assert.equal(result.nativeContextReferencesReleased, true);
  assert.equal(fs.existsSync(f.lock()), false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|credentialRef|cookies/);
  assert.doesNotMatch(fs.readFileSync(result.receiptPath, 'utf8'), /synthetic-private|credentialRef|cookies/);
});

test('native-entry runner preparation and cancellation dispose privately with zero login or action submission', async t => {
  const prepared = nativeEntryFixture(t), result = await prepared.runner({ ...prepared.input, op: 'prepare' });
  assert.equal(result.ok, true); assert.equal(result.state, 'prepared'); assert.deepEqual(prepared.events, ['prepare', 'dispose']);
  assert.equal(result.requestSubmittedCount, 0); assert.equal(result.loginSubmittedCount, 0); assert.equal(fs.existsSync(prepared.lock()), false);
  const cancelled = nativeEntryFixture(t, { prompt: async () => ({ ok: false, state: 'cancelled', error: 'debug_app_user_cancelled' }) }),
    stopped = await cancelled.runner(cancelled.input);
  assert.equal(stopped.ok, false); assert.equal(stopped.state, 'cancelled');
  assert.deepEqual(cancelled.events, ['prepare', 'prompt', 'dispose']); assert.equal(stopped.credentialsReleased, true);
  assert.equal(stopped.loginSubmittedCount, 0); assert.equal(stopped.requestSubmittedCount, 0); assert.equal(fs.existsSync(cancelled.lock()), false);
});

test('native-entry runner rejects foreign ABI before the window and changed preparation before the action', async t => {
  const invalid = nativeEntryFixture(t, { prepare: async ({ receipt, handle }) => { receipt.target.moduleKey = 'Z'.repeat(22); return handle; } }),
    first = await invalid.runner(invalid.input);
  assert.equal(first.error, 'debug_o11_run_native_entry_preparation_unproved'); assert.deepEqual(invalid.events, ['prepare', 'dispose']);
  assert.equal(first.memoryCleared, true); assert.equal(fs.existsSync(invalid.lock()), false);
  const changed = nativeEntryFixture(t, { authenticate: async ({ receipt }) => {
    receipt.entry.apiVersion = 'Z'.repeat(22); return { ok: true, authenticated: true, nativeCheckRegisteredPassed: true, rolesLoadedFromServer: true };
  } }), second = await changed.runner(changed.input);
  assert.equal(second.error, 'debug_o11_run_native_entry_preparation_changed'); assert.equal(second.requestSubmittedCount, 0);
  assert.deepEqual(changed.events, ['prepare', 'prompt', 'login', 'dispose', 'forget']); assert.equal(fs.existsSync(changed.lock()), false);
});

test('native-entry runner refuses a forged request binding before accounting or private fetch', async t => {
  const f = nativeEntryFixture(t, { invoke: async ({ beforeRequest, callback }) => {
    await beforeRequest({ ...callback, binding: { ...callback.binding, sessionId: '0'.repeat(32) } });
    throw new Error('must never reach a fetch');
  } }), result = await f.runner(f.input);
  assert.equal(result.error, 'debug_o11_run_native_entry_request_scope_mismatch'); assert.equal(result.requestReserved, false);
  assert.equal(result.requestSubmittedCount, 0); assert.equal(result.requestUncertain, false); assert.ok(!f.events.includes('private-fetch'));
  assert.equal(result.credentialsReleased, true); assert.equal(result.memoryCleared, true); assert.equal(fs.existsSync(f.lock()), false);
});

test('native-entry runner never repeats an unanswered request and retains its exclusive operation lock', async t => {
  const f = nativeEntryFixture(t, { invoke: async ({ beforeRequest, callback, receipt, events }) => {
    await beforeRequest(callback); events.push('private-fetch'); receipt.requestSubmittedCount = 1;
    throw new Error('synthetic-private-network-detail');
  } }), result = await f.runner(f.input), before = fs.readFileSync(f.lock());
  assert.equal(result.ok, false); assert.equal(result.requestUncertain, true); assert.equal(result.lockRetained, true);
  assert.equal(result.requestSubmittedCount, 1); assert.equal(result.requestAnsweredCount, 0); assert.equal(result.memoryCleared, true);
  const second = await f.runner(f.input); assert.equal(second.error, 'debug_o11_run_native_entry_reconciliation_required');
  assert.deepEqual(fs.readFileSync(f.lock()), before); assert.equal(f.events.filter(event => event === 'private-fetch').length, 1);
  assert.equal(f.events.filter(event => event === 'prompt').length, 1); assert.doesNotMatch(JSON.stringify(result), /synthetic-private-network-detail/);
});

test('native-entry runner callback admits at most one request and refuses extra action attempts', async t => {
  const f = nativeEntryFixture(t, { invoke: async ({ beforeRequest, callback, receipt, events }) => {
    await beforeRequest(callback); events.push('private-fetch'); receipt.requestSubmittedCount = 1;
    await beforeRequest(callback); throw new Error('second fetch must not be admitted');
  } }), result = await f.runner(f.input);
  assert.equal(result.error, 'debug_o11_run_native_entry_request_scope_mismatch'); assert.equal(result.requestSubmittedCount, 1);
  assert.equal(result.requestUncertain, true); assert.equal(result.lockRetained, true);
  assert.equal(f.events.filter(event => event === 'private-fetch').length, 1); assert.equal(result.credentialsReleased, true);
});

test('native-entry runner treats false Boolean results as an answer and keeps malformed schemas uncertain', async t => {
  for (const malformed of [false, true]) {
    const f = nativeEntryFixture(t, { invoke: async ({ beforeRequest, callback, receipt }) => {
      await beforeRequest(callback); Object.assign(receipt, { requestSubmittedCount: 1, requestAnsweredCount: 1 });
      return { ok: true, outputs: malformed ? { Ready: false, Confirmed: 123 } : { Ready: false, Confirmed: false } };
    } }), result = await f.runner(f.input);
    assert.equal(result.ok, !malformed); assert.equal(result.requestAnsweredCount, 1); assert.equal(result.requestUncertain, malformed);
    assert.equal(fs.existsSync(f.lock()), malformed); assert.equal(result.nativeRegisteredCheckPassed, true);
    assert.equal(result.serviceFramesProved, false); assert.equal(result.userRequestIsolationProved, false);
    if (malformed) assert.equal(result.outputs, undefined);
    else assert.deepEqual(result.outputs, { Ready: false, Confirmed: false });
  }
});

test('native-entry runner rejects an Integer output profile before the window and refuses unknown native error codes', async t => {
  const integer = nativeEntryFixture(t, { prepare: async ({ receipt, handle }) => { receipt.entry.outputs[1].type = 'Integer'; return handle; } }),
    refused = await integer.runner(integer.input);
  assert.equal(refused.error, 'debug_o11_run_native_entry_preparation_unproved'); assert.equal(refused.requestSubmittedCount, 0);
  assert.deepEqual(integer.events, ['prepare', 'dispose']); assert.equal(fs.existsSync(integer.lock()), false);
  const unknown = nativeEntryFixture(t, { prepare: async () => { throw new Error('debug_o11_native_private_session_secret'); } }),
    hidden = await unknown.runner(unknown.input);
  assert.equal(hidden.error, 'debug_o11_native_worker_failed'); assert.doesNotMatch(JSON.stringify(hidden), /private_session_secret/);
  assert.deepEqual(unknown.events, ['prepare']); assert.equal(hidden.lockRetained, true);
});

test('native-entry runner cleanup is independent and preserves lock on unknown child or failed private cleanup', async t => {
  const unknown = nativeEntryFixture(t, { prepare: async () => { throw new Error('synthetic-private-child'); } }),
    first = await unknown.runner(unknown.input);
  assert.equal(first.memoryCleared, false); assert.equal(first.lockRetained, true); assert.equal(first.credentialsReleased, true);
  assert.deepEqual(unknown.events, ['prepare']); assert.doesNotMatch(JSON.stringify(first), /synthetic-private-child/);
  const failing = nativeEntryFixture(t, { dispose: async () => { throw new Error('synthetic-private-cleanup'); } }), second = await failing.runner(failing.input);
  assert.equal(second.memoryCleanupUnproved, true); assert.equal(second.memoryCleared, false); assert.equal(second.credentialsReleased, true);
  assert.equal(second.lockRetained, true); assert.equal(second.ok, false); assert.equal(failing.events.at(-1), 'forget');
  const conflicting = nativeEntryFixture(t, { dispose: async ({ receipt }) => {
    Object.assign(receipt, { memoryCleared: true, nativeContextReferencesReleased: true }); throw new Error('synthetic-private-receipt-error');
  } }), third = await conflicting.runner(conflicting.input);
  assert.equal(third.memoryCleared, true); assert.equal(third.memoryCleanupUnproved, true); assert.equal(third.ok, false);
  assert.equal(third.lockRetained, true); assert.equal(third.error, 'debug_o11_run_native_entry_cleanup_unproved');
  assert.equal(conflicting.events.at(-1), 'forget');
});

test('native-entry runner adopts only same-operation cleanup capability for a preparation failure', async t => {
  for (const invalid of [false, 'session', 'source', 'submitted', 'memory']) {
    const f = nativeEntryFixture(t, { prepare: async ({ receipt, handle }) => {
      Object.assign(receipt, { prepared: false, memoryCleared: true, nativeContextReferencesReleased: true });
      if (invalid === 'session') receipt.sessionId = '0'.repeat(32);
      if (invalid === 'source') receipt.sourceContract = { ...receipt.sourceContract, sha256: '0'.repeat(64) };
      if (invalid === 'submitted') receipt.requestSubmittedCount = 1;
      if (invalid === 'memory') receipt.memoryCleared = false;
      const error = new Error('debug_o11_native_abi_invalid'); error.nativeEntryCleanupHandle = handle;
      // This file does not exist: the runner must use the private capability, never an exception path.
      error.receiptPath = 'C:\\untrusted-private\\do-not-read.json'; throw error;
    } }), result = await f.runner(f.input);
    assert.equal(result.error, 'debug_o11_native_abi_invalid'); assert.equal(result.ok, false);
    assert.equal(result.preparationFailureCleanupProved === true, !invalid); assert.equal(result.lockRetained, !!invalid);
    assert.equal(result.memoryCleared, !invalid); assert.equal(result.requestSubmittedCount, 0);
    assert.deepEqual(f.events, invalid ? ['prepare'] : ['prepare', 'dispose']); assert.equal(fs.existsSync(f.lock()), !!invalid);
    assert.doesNotMatch(JSON.stringify(result), /untrusted-private|do-not-read/);
  }
});

test('native-entry runner retains foreign lock ownership and refuses regression in the private worker ledger', async t => {
  const altered = nativeEntryFixture(t, { dispose: async ({ receipt }) => {
    Object.assign(receipt, { memoryCleared: true, nativeContextReferencesReleased: true });
    fs.writeFileSync(altered.lock(), JSON.stringify({ operationId: randomUUID(), sessionId: '9'.repeat(32), pid: process.pid }));
  } }), result = await altered.runner(altered.input);
  assert.equal(result.ok, false); assert.equal(result.lockRetained, true); assert.equal(fs.existsSync(altered.lock()), true);
  const regressed = nativeEntryFixture(t, { dispose: async ({ receipt }) => {
    Object.assign(receipt, { loginSubmittedCount: 0, loginAnsweredCount: 0, memoryCleared: true, nativeContextReferencesReleased: true });
  } });
  // A final worker report must not erase recorded submissions when clearing private memory.
  const returned = await regressed.runner(regressed.input);
  assert.equal(returned.ok, false); assert.equal(returned.workerLedgerUnproved, true); assert.equal(returned.lockRetained, true);
});

test('auxiliary O11 native session borrows the original entry lease without rebinding or releasing it',async()=>{
 const f=fixture(),descriptor=appUser(f.input,id),original=structuredClone(descriptor);let bootstrap,reads=0,releases=0;
 const input={...f.input,autoContinue:false,inspection:{variables:[],scopes:[{moduleKey,functionKey:'E'.repeat(22),nodeKey:'D'.repeat(22),sourceSha256:'a'.repeat(64)}]}};
 const svc=services(f,{getO11DebugToken:async r=>privateReply(r),spawn:fakeWorker(text=>bootstrap=JSON.parse(text)),
  prepareAppUser:async()=>{throw Error('must reuse runner credential lease');},
  privateAppUserVault:async(mode,request)=>{reads++;assert.equal(mode,'read');assert.deepEqual(request.binding,original.binding);return{ok:true,kind:'credentials',binding:original.binding,expiresAt:original.expiresAt,username:'synthetic-user',password:'synthetic-password'};},
  releaseAppUser:async()=>{releases++;return{ok:true};},pipeRequest:async()=>({ok:true,state:'stopped'})});
 try{
  const result=await headlessDebug(input,{services:svc,appUser:descriptor,redactionOnly:true,additionalO11Session:true});
  assert.equal(result.ok,true,JSON.stringify({state:result.state,error:result.error,reads,boot:!!bootstrap}));assert.notEqual(result.sessionId,id);assert.equal(bootstrap.sessionId,result.sessionId);
  assert.deepEqual(descriptor,original);assert.equal(reads,1);
  const manifest=JSON.parse(fs.readFileSync(path.join(svc.sessionRoot,result.sessionId,'manifest.json')));
  assert.equal(manifest.additionalO11Session,true);assert.equal(manifest.appUserBorrowed,true);assert.equal(manifest.credentialOwnerSessionId,id);assert.deepEqual(manifest.appUser.binding,original.binding);
  const stopped=await headlessDebug({op:'stop',sessionId:result.sessionId},{services:svc});
  assert.equal(stopped.state,'stopped');assert.equal(stopped.credentialCleanup.state,'runner-owned');assert.equal(releases,0);assert.equal(fs.existsSync(manifest.lock),false);
 }finally{f.close();}
});
test('auxiliary native sessions reject changed user target, lane, mode and public capability arguments before any side effects',async()=>{
 const f=fixture(),descriptor=appUser(f.input,id),input={...f.input,autoContinue:false,inspection:{variables:[]}};let effects=0;
 const svc=services(f,{selectedO11Studio:async()=>{effects++;throw Error('not allowed');},journal:()=>{effects++;}});
 try{
  for(const patch of [{redactionOnly:false},{appUser:undefined},{appUser:{...descriptor,binding:{...descriptor.binding,moduleKey:'F'.repeat(22)}}},{additionalO11Session:'yes'},{anonymousWatch:true},{contextMode:'app-user'}])
   await assert.rejects(headlessDebug(input,{services:svc,appUser:descriptor,redactionOnly:true,additionalO11Session:true,...patch}),/additional_session_binding_invalid/);
  await assert.rejects(headlessDebug({...input,lane:'odc',tenant:'fixture',o11Auth:undefined},{services:svc,appUser:descriptor,redactionOnly:true,additionalO11Session:true}),/additional_session_binding_invalid/);
  assert.equal(debugSchema.safeParse({...input,additionalO11Session:true}).success,false);
  assert.equal(effects,0);assert.equal(fs.existsSync(svc.sessionRoot),false);
 }finally{f.close();}
});
