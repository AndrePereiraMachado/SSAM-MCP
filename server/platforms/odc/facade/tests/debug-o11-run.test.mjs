import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createO11Runner, o11RunSchema, o11Scenarios, o11CompactMap, o11WrapperResponse } from '../debug-o11-run.mjs';
import { createO11Lifecycle, matchPublishedModule, o11PublicTarget, o11Hash, o11Read, o11Write, o11SignatureKeyOf, o11CliArguments, o11WrapperContract, o11LoginSignature } from '../debug-o11-lifecycle.mjs';
import { appUserBinding } from '../debug-app-user.mjs';
import { invokePrivateWrapper } from '../debug-app-user-worker.mjs';
import * as W from '../debug-wrapper.mjs';

const target = { lane: 'o11', host: 'personal.example.test', module: 'Headless_UI', moduleKey: 'A'.repeat(22), applicationKey: 'B'.repeat(22), runtimeUrl: 'https://personal.example.test/Headless_UI/' };
const action = { kind: 'ServerAction', name: 'GetInfo', key: 'C'.repeat(22), start: 'D'.repeat(22), inputs: [], outputs: [], locals: [],
  nodes: [{ key: 'D'.repeat(22), kind: 'StartNode', targets: ['E'.repeat(22)] }, { key: 'E'.repeat(22), kind: 'EndNode', targets: [] }] };
const wrapper = { key: 'F'.repeat(22), callNode: 'G'.repeat(22), authenticationVerified: true, nativeIdentityGuardVerified: true, originalActionKey: action.key };
const fresh = () => ({ host: target.host, capturedAtUtc: new Date().toISOString(), modules: [{ Name: target.module,
  Key: target.moduleKey, ApplicationKey: target.applicationKey, VersionId: 4870, IsActive: true }] });

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-run-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = []; let versionId = 4870, submitted = 0, count = 0;
  const lifecycle = {
    snapshot: async (_target, directory) => { events.push('snapshot'); fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'base.oml'); fs.writeFileSync(file, 'fixture');
      return { file, sha256: o11Hash(fs.readFileSync(file)), versionId, described: {} }; },
    original: async () => action, loginReference: async () => '@' + 'H'.repeat(22),
    exists: async (_base, selector) => selector.includes('SSAMDebug') && submitted > 0,
    apply: async (_base, job, directory) => { events.push('apply'); fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'candidate.oml'); fs.writeFileSync(file, JSON.stringify(job));
      return { file, sha256: o11Hash(fs.readFileSync(file)) }; },
    wrapper: async () => wrapper,
    publication: (_target, _base, candidate, _auth, directory, message) => { events.push('publication:' + message);
      return { operationId: randomUUID(), receiptPath: path.join(directory, 'receipt.json'), candidate, message }; },
    publish: async operation => { events.push('publish:' + operation.message); submitted++; versionId++;
      return { ok: true, state: 'published', versionId }; },
    inventory: async (_target, directory) => { events.push('fresh'); fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'inventory.json'); o11Write(file, { ...fresh(), modules: [{ ...fresh().modules[0], VersionId: versionId }] });
      return { versionId, proof: { path: file, sha256: o11Hash(fs.readFileSync(file)) } }; },
    ...overrides.lifecycle,
  };
  const binding = appUserBinding(target), descriptor = { credentialRef: randomUUID(), binding, expiresAt: new Date(Date.now() + 600000).toISOString(), state: 'credentials-entered', authenticated: false };
  const runner = createO11Runner({ root, lifecycle, selected: async () => {}, prepareUser: async () => { events.push('prompt'); return { ok: true, descriptor }; },
    releaseUser: async () => { events.push('forget'); return { ok: true }; },
    invoke: async input => { events.push('invoke'); count++; assert.equal(input.descriptor, descriptor); assert.deepEqual(input.body, {});
      return { ok: true, state: 'completed', status: 200, body: { SSAMDebugCompleted: true } }; },
    debug: async input => { events.push(input.op); if (input.op === 'start') {
      assert.equal(input.o11Auth.publishedVersionId, versionId); assert.equal(input.moduleKey, target.moduleKey);
      assert.equal(input.trace.requireFunctionKey, wrapper.key); assert.equal(input.trace.focusFunctionKey, action.key);
      assert.ok(!('host' in input)); assert.ok(!('applicationKey' in input));
      return { ok: true, state: 'connected', sessionId: 'a'.repeat(32) }; }
      return { ok: true, state: 'stopped' }; }, settle: async () => {}, traceRead: () => [], ...overrides.services });
  return { root, runner, events, descriptor, count: () => count };
}

test('schema allows no-input scenarios and rejects public credentials or simulated identity', () => {
  const parsed = o11RunSchema.parse({ ...target, op: 'run', action: 'GetInfo' }); assert.deepEqual(parsed.inputs, {});
  for (const fields of [{ password: 'synthetic' }, { username: 'synthetic' }, { scenarios: [{ as: { user: 'other' } }] }])
    assert.throws(() => o11RunSchema.parse({ ...target, op: 'run', action: 'GetInfo', ...fields }));
  assert.equal(o11Scenarios(parsed, action).length, 1);
  assert.throws(() => o11Scenarios({ ...parsed, inputs: { Unknown: 1 } }, action), /invalid_or_private_input/);
  assert.throws(() => o11Scenarios({ ...parsed, inputs: { Password: 'synthetic' } }, { ...action, inputs: [{ name: 'Password', type: { kind: 'BasicType', label: 'Text' } }] }), /invalid_or_private_input/);
});
test('published target checks exact host, active module, app and fresh version proof', () => {
  assert.equal(o11PublicTarget(target).runtimeUrl, target.runtimeUrl); assert.equal(matchPublishedModule(fresh(), target).VersionId, 4870);
  for (const change of [{ host: 'other.example.test' }, { capturedAtUtc: new Date(0).toISOString() },
    { modules: [{ ...fresh().modules[0], ApplicationKey: 'Z'.repeat(22) }] }, { modules: [{ ...fresh().modules[0], IsActive: false }] }])
    assert.throws(() => matchPublishedModule({ ...fresh(), ...change }, target));
  assert.throws(() => o11PublicTarget({ ...target, runtimeUrl: 'https://personal.example.test/Other/' }));
});
test('trace map preserves native visits and separates variable deltas by action frame', () => {
  const value = (path, value) => ({ path, value });
  const entry = { action: 'OriginalAction', threadId: 1, functionKey: 'action-key', frameId: 'frame-one', nodeKey: 'start', values: [value('Count', 1), value('Context', '[private]')] };
  const result = o11CompactMap([entry, { ...entry, nodeKey: 'next', values: [value('Count', 2), value('Context', '[private]')] },
    { ...entry, frameId: 'nested-frame', nodeKey: 'nested' }]);
  assert.deepEqual(result[0].values, entry.values); assert.deepEqual(result[1].changed, [value('Count', 2)]);
  assert.deepEqual(result[2].values, entry.values); assert.equal(result[2].nodeKey, 'nested'); assert.ok(!('threadId' in result[0]));
});
test('prepare creates only offline candidate and validates inputs before any prompt/publication', async t => {
  const f = fixture(t); const result = await f.runner({ ...target, op: 'prepare', action: action.name });
  assert.equal(result.ok, true); assert.equal(result.state, 'prepared'); assert.ok(fs.existsSync(result.candidate.path));
  assert.ok(!f.events.includes('prompt')); assert.ok(!f.events.some(e => e.startsWith('publish'))); assert.equal(f.count(), 0);
});
test('one no-input run uses exact private descriptor, fresh SSO proof, stop and removal receipt', async t => {
  const f = fixture(t); await f.runner({ ...target, op: 'authorize', words: 'Publish and remove the debug wrapper.' });
  const result = await f.runner({ ...target, op: 'run', action: action.name });
  assert.equal(result.ok, true); assert.equal(f.count(), 1); assert.equal(result.wrapper.state, 'removed');
  assert.deepEqual(result.cleanup, { debuggerStopped: true, credentialsReleased: true });
  assert.ok(f.events.indexOf('stop') < f.events.indexOf('publish:' + W.COMMIT.remove));
  const receipt = o11Read(result.wrapper.receiptPath); assert.equal(receipt.calls[0].state, 'answered');
  const text = JSON.stringify(receipt); for (const word of ['credentialRef', 'token', 'password', 'Username']) assert.ok(!text.includes(word));
});
test('uncertain first call stops batch, releases credentials, retains lock and never retries/removes', async t => {
  let calls = 0; const f = fixture(t, { services: { invoke: async () => { calls++; return { ok: false, state: 'uncertain', status: null }; } } });
  await f.runner({ ...target, op: 'authorize', words: 'Publish and remove the debug wrapper.' });
  const input = { ...target, op: 'run', action: action.name, scenarios: [{ name: 'one' }, { name: 'two' }] };
  const result = await f.runner(input); assert.equal(result.ok, false); assert.equal(calls, 1); assert.equal(result.wrapper.state, 'uncertain');
  assert.ok(f.events.includes('stop')); assert.ok(f.events.includes('forget')); assert.ok(!f.events.includes('publish:' + W.COMMIT.remove));
  const again = await f.runner(input); assert.equal(again.error, 'debug_o11_run_target_has_operation'); assert.equal(calls, 1);
});
test('HTTP invalid response keeps execution uncertain and never resubmits or removes the wrapper', async t => {
  let calls = 0; const f = fixture(t, { services: { invoke: async () => { calls++; return { ok: false, state: 'invalid-response', status: 200 }; } } });
  await f.runner({ ...target, op: 'authorize', words: 'Publish and remove the debug wrapper.' });
  const input = { ...target, op: 'run', action: action.name, scenarios: [{ name: 'one' }, { name: 'two' }] };
  const result = await f.runner(input); assert.equal(result.error, 'debug_o11_run_call_outcome_uncertain'); assert.equal(result.wrapper.state, 'uncertain');
  assert.equal(calls, 1); assert.ok(f.events.includes('stop')); assert.ok(f.events.includes('forget'));
  assert.ok(!f.events.includes('publish:' + W.COMMIT.remove));
  assert.equal((await f.runner(input)).error, 'debug_o11_run_target_has_operation'); assert.equal(calls, 1);
  assert.equal(o11Read(result.wrapper.receiptPath).calls[0].state, 'uncertain');
});
test('uncertain publication never starts debugger or action', async t => {
  const f = fixture(t, { lifecycle: { publish: async () => ({ ok: false, state: 'uncertain' }) } });
  await f.runner({ ...target, op: 'authorize', words: 'Publish and remove the debug wrapper.' });
  const result = await f.runner({ ...target, op: 'run', action: action.name });
  assert.equal(result.wrapper.state, 'uncertain'); assert.equal(f.count(), 0); assert.ok(!f.events.includes('start')); assert.ok(f.events.includes('forget'));
});
test('native provider reference requires exact imported signature and never guesses a key', async () => {
  const base = { described: { UserProviderName: 'Users', UserProviderKey: 'I'.repeat(22), References: [{ Name: 'Users', Key: 'I'.repeat(22) }] } };
  const signature = { kind: 'ServerActionSignature', key: 'H'.repeat(22), children: [['Username', 'Text'], ['Password', 'Text'], ['RememberLogin', 'Boolean']].map(([name, label],i) => ({
    key: String.fromCharCode(74+i).repeat(22), kind: 'InputParameterSignature', name, propertyReferences: { DataType: { kind: 'BasicType', label } } })) };
  const life = createO11Lifecycle({ readTree: async (_base, selector) => { assert.equal(selector, 'Reference:Users/ServerActionSignature:User_Login'); return signature; } });
  assert.equal(await life.loginReference(base), '@' + 'H'.repeat(22));
  await assert.rejects(life.loginReference({ described: {} }), /user_provider_unresolved/);
  signature.children[2].propertyReferences.DataType.label = 'Text'; await assert.rejects(life.loginReference(base), /signature_unresolved/);
});
test('native O11 captured provider Guid must represent the exact model ObjectKey before import', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-o11-provider-key-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const providerKey='WWAQZTkE5UuwES8B+6Svpg', nativeKey='65106059-0439-4be5-b011-2f01fba4afa6';
  assert.equal(o11SignatureKeyOf(providerKey),nativeKey);
  let capturedKey=nativeKey, imports=0;
  const base={file:path.join(root,'base.oml'),sha256:o11Hash(Buffer.from('fixture')),
    described:{UserProviderName:'Users',UserProviderKey:providerKey,References:[]}};fs.writeFileSync(base.file,'fixture');
  const life=createO11Lifecycle({root,cli:async(verb,args)=>{
    if(verb==='signature') { o11Write(args[args.indexOf('--out')+1],{FormatVersion:2,ModuleKey:capturedKey,Name:'Users',Environment:target.host,
      Attestation:{Source:'server-signature',IsActive:true,VersionId:5407}});return {}; }
    assert.equal(verb,'apply');imports++;throw new Error('synthetic-apply-reached');
  }});
  await assert.rejects(life.loginContext(base,path.join(root,'valid'),target),/synthetic-apply-reached/);assert.equal(imports,1);
  for(capturedKey of ['65106059-0439-4be5-b011-2f01fba4afa7',providerKey]) {
    await assert.rejects(life.loginContext(base,path.join(root,randomUUID()),target),/user_provider_signature_mismatch/);assert.equal(imports,1);
  }
});
test('only the selected cold publisher uses the LatestMajor host invocation already qualified offline',()=>{
  const dll='C:\\proof folder\\cli\\anvil.dll',studio='C:\\Program Files\\OutSystems\\Service Studio';
  assert.deepEqual(o11CliArguments('publish-oml',['--request','request.json'],dll,studio),
    ['--roll-forward','LatestMajor',dll,'publish-oml','--request','request.json','--ss-dir',studio]);
  assert.deepEqual(o11CliArguments('inspect',['--oml','candidate.oml'],dll,studio),
    [dll,'inspect','--oml','candidate.oml','--ss-dir',studio]);
});
test('wrapper absence must be confirmed by a complete native search, never a failed read', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-exists-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'base.oml'); fs.writeFileSync(file, 'fixture'); const base = { file, sha256: o11Hash(fs.readFileSync(file)) };
  let response = { sourceSha256: base.sha256, searchComplete: true, propertyReadErrors: 0, count: 0 };
  const life = createO11Lifecycle({ cli: async (verb, args) => { assert.equal(verb, 'inspect'); assert.ok(args.includes('RestService')); return response; } });
  assert.equal(await life.exists(base, 'RestService:SSAMDebug'), false);
  response = { ...response, count: 1 }; assert.equal(await life.exists(base, 'RestService:SSAMDebug'), true);
  for (const delta of [{ count: 2 }, { searchComplete: false }, { propertyReadErrors: 1 }, { sourceSha256: '0'.repeat(64) }]) {
    response = { sourceSha256: base.sha256, searchComplete: true, propertyReadErrors: 0, count: 0, ...delta };
    await assert.rejects(life.exists(base, 'RestService:SSAMDebug'), /model_read_incomplete/);
  }
  await assert.rejects(createO11Lifecycle({ cli: async () => { throw new Error('transport failed'); } }).exists(base, 'RestService:SSAMDebug'), /transport failed/);
});
test('Unicode, quotes, backslashes and significant spaces survive private O11 UTF8 body without public echo', async () => {
  const credentials = { username: '  synthetic-ç-🔒"\\user  ', password: '  synthetic-\"\\-密碼-🔒\t  ' };
  const binding = appUserBinding(target), descriptor = { credentialRef: randomUUID(), binding, expiresAt: new Date(Date.now() + 60000).toISOString() };
  let sent = 0;
  const result = await invokePrivateWrapper({ descriptor, module: target.module, action: action.name, token: 'b'.repeat(48), body: {}, timeoutSeconds: 90 }, {
    vault: async () => ({ ok: true, kind: 'credentials', binding, expiresAt: descriptor.expiresAt, ...credentials }),
    fetchImpl: async (_url, options) => { sent++; const body = JSON.parse(options.body);
      assert.equal(body.SSAMDebugUsername, credentials.username); assert.equal(body.SSAMDebugPassword, credentials.password);
      assert.equal(new TextDecoder().decode(new TextEncoder().encode(options.body)), options.body);
      assert.equal(options.headers['Content-Type'], 'text/plain; charset=utf-8'); assert.equal(options.redirect, 'error');
      assert.ok(!Object.values(options.headers).includes(credentials.password));
      return new Response(JSON.stringify({ Alias: credentials.password, UserAlias: credentials.username, SSAMDebugCompleted: true }), { status: 200 }); },
  });
  assert.equal(sent, 1); assert.equal(result.ok, true);
  const serialized = JSON.stringify(result); assert.ok(!serialized.includes(credentials.password)); assert.ok(!serialized.includes(credentials.username));
  assert.equal(result.body.Alias, '[private]'); assert.equal(result.body.UserAlias, '[private]');
});

test('REST completion requires exact post-call output schema, including a true empty-output marker',()=>{
  const accepted=body=>o11WrapperResponse(action,{ok:true,state:'completed',status:200,body});
  assert.equal(accepted({SSAMDebugCompleted:true}).ok,true);
  for(const body of [{},{SSAMDebugCompleted:false},{SSAMDebugCompleted:true,privateUnexpected:'synthetic'}])assert.equal(accepted(body).answered,false);
  assert.deepEqual(accepted({error:'debug_app_user_authentication_required'}),{ok:false,answered:true,error:'debug_o11_run_target_or_login_rejected'});
  const withOutputs={...action,outputs:[{name:'Success'}]};assert.equal(o11WrapperResponse(withOutputs,{ok:true,state:'completed',status:200,body:{Success:false}}).ok,true);
});

test('native wrapper graph binds the configured provider and authenticates before the unchanged original call',()=>{
  const loginContract={key:'H'.repeat(22),inputs:['Username','Password','RememberLogin'].map((name,i)=>({key:String.fromCharCode(74+i).repeat(22),name}))};
  const token='a'.repeat(48),n=W.names(action.name),key=i=>Buffer.alloc(16,i+64).toString('base64').slice(0,-2).replace(/\//g,'_'),ref=(key)=>({key}),rows=[
    {key:key(0),kind:'StartNode',propertyReferences:{Target:ref(key(1))}},
    {key:key(1),kind:'IfNode',name:n.auth,properties:{Condition:`${n.token} = "${token}"`},propertyReferences:{TrueTarget:ref(key(2)),FalseTarget:ref(key(6))}},
    {key:key(2),kind:'JSONDeserializeNode',name:n.deserialize,propertyReferences:{Target:ref(key(3))}},
    {key:key(3),kind:'ExecuteServerActionNode',name:'SSAMDebugLogin',propertyReferences:{Action:ref(loginContract.key),Target:ref(key(4))},
      children:loginContract.inputs.map(p=>({kind:'Argument',propertyReferences:{Parameter:ref(p.key)},properties:{Value:p.name==='RememberLogin'?'False':`${n.deserialize}.Data.${W.APP_USER_FIELDS[p.name.toLowerCase()]}`}}))},
    {key:key(4),kind:'IfNode',name:'SSAMDebugIdentityValid',properties:{Condition:'GetUserId() <> NullIdentifier()'},propertyReferences:{TrueTarget:ref(key(5)),FalseTarget:ref(key(6))}},
    {key:key(5),kind:'ExecuteServerActionNode',name:n.call,propertyReferences:{Action:ref(action.key),Target:ref(key(7))}},
    {key:key(6),kind:'AssignNode',name:'SSAMDebugAuthenticationRequired',propertyReferences:{Target:ref(key(7))}},
    {key:key(7),kind:'EndNode'},
  ];
  const tree={kind:'RestServiceAction',key:'Z'.repeat(22),children:rows},context={loginRef:'@'+loginContract.key,loginContract,token};
  const checked=o11WrapperContract(tree,action,context);assert.equal(checked.authenticationVerified,true);assert.equal(checked.originalActionKey,action.key);assert.equal(checked.serviceBoundaryProved,false);
  const unnamed=structuredClone(tree);
  for(const row of unnamed.children.filter(row=>row.kind==='IfNode')){row.name='';row.modelName='';row.label=null;}
  assert.equal(o11WrapperContract(unnamed,action,context).authenticationVerified,true);
  for(const mutate of [v=>{v.children[2].propertyReferences.Target.key=key(5);},v=>{v.children[3].propertyReferences.Action.key='X'.repeat(22);},
    v=>{v.children[3].children[2].properties.Value='True';},v=>{v.children[4].properties.Condition='True';},v=>{v.children[5].propertyReferences.Action.key='X'.repeat(22);}]) {
    const changed=structuredClone(tree);mutate(changed);assert.throws(()=>o11WrapperContract(changed,action,context),/wrapper_authentication_unproved/);
  }
});

test('foreign provider, duplicate signature keys or incomplete candidate authentication refuse before the window',async t=>{
  const f=fixture(t,{lifecycle:{wrapper:async()=>({...wrapper,authenticationVerified:false})}});
  const result=await f.runner({...target,op:'prepare',action:action.name});assert.equal(result.error,'debug_o11_run_wrapper_authentication_unproved');assert.ok(!f.events.includes('prompt'));assert.ok(!f.events.some(v=>v.startsWith('publish')));
  const base={described:{UserProviderName:'Users',UserProviderKey:'I'.repeat(22),References:[{Name:'Foreign',Key:'I'.repeat(22)}]}};
  let reads=0;await assert.rejects(createO11Lifecycle({readTree:async()=>{reads++;}}).loginReference(base),/user_provider_unresolved/);assert.equal(reads,0);
  const duplicate={kind:'ServerActionSignature',key:'H'.repeat(22),children:['Username','Password','RememberLogin'].map((name,i)=>({
    key:i<2?'J'.repeat(22):'L'.repeat(22),kind:'InputParameterSignature',name,propertyReferences:{DataType:{kind:'BasicType',label:i===2?'Boolean':'Text'}}}))};
  assert.throws(()=>o11LoginSignature(duplicate),/native_login_signature_unresolved/);
});

test('HTTP200 defaults or a debugger uncertain start never authorize a second scenario or wrapper removal',async t=>{
  for(const kind of ['schema','debugger']) {
    const f=fixture(t,{services:kind==='schema'?{invoke:async()=>({ok:true,state:'completed',status:200,body:{}})}:
      {debug:async input=>input.op==='start'?{ok:false,state:'token-uncertain',sessionId:'a'.repeat(32)}:{ok:false,state:'token-uncertain'}}});
    await f.runner({...target,op:'authorize',words:'Publish and remove the debug wrapper.'});
    const result=await f.runner({...target,op:'run',action:action.name,scenarios:[{name:'one'},{name:'two'}]});
    assert.equal(result.ok,false);assert.equal(result.wrapper.state,'uncertain');assert.ok(f.events.includes('forget'));
    assert.ok(!f.events.includes('publish:'+W.COMMIT.remove));
  }
});

test('publisher selection refusal is not a submitted write, while transport failures remain uncertain',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-o11-publisher-preflight-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const request={operationId:randomUUID(),...target,candidateSha256:'a'.repeat(64)},requestPath=path.join(root,'request.json'),receiptPath=path.join(root,'receipt.json');
  o11Write(requestPath,request);
  const operation={requestPath,receiptPath,request,operationId:request.operationId};
  for(const proven of [true,false]) {
    const life=createO11Lifecycle({root,cli:async()=>{const e=new Error('private diagnostic');e.code='debug_o11_publisher_source_changed';if(proven)e.publicationStage='publisher-selection';throw e;}});
    const result=await life.publish(operation);
    assert.equal(result.state,proven?'refused':'uncertain');
    if(proven){assert.equal(result.nativeSubmission,false);assert.equal(result.error,'debug_o11_publisher_source_changed');}
    assert.ok(!JSON.stringify(result).includes('private diagnostic'));
  }
  o11Write(receiptPath,{...request,host:target.host,state:'uncertain',versionId:2});
  const life=createO11Lifecycle({root,cli:async()=>{assert.fail('existing uncertain operation must never be resent');}});
  assert.equal((await life.publish(operation)).state,'uncertain');
});

test('reconciliation preserves write request bytes and never resends an uncertain publication',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-o11-publication-read-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const request={operationId:randomUUID(),...target,baseVersionId:1,candidateSha256:'a'.repeat(64),receiptDirectory:root},
    requestPath=path.join(root,'publish-request.json'),receiptPath=path.join(root,'receipt.json');o11Write(requestPath,request);
  const prior={operationId:request.operationId,host:target.host,moduleKey:target.moduleKey,candidateSha256:request.candidateSha256,state:'uncertain',versionId:2};o11Write(receiptPath,prior);
  const before=fs.readFileSync(requestPath),calls=[],life=createO11Lifecycle({root,cli:async(verb,args)=>{
    calls.push(verb);assert.equal(verb,'publish-oml');const read=o11Read(args[1]);assert.equal(read.mode,'reconcile');assert.notEqual(args[1],requestPath);
    return{...prior,state:'published',versionId:2};}}),operation={requestPath,receiptPath,operationId:request.operationId,request};
  assert.equal((await life.publish(operation)).state,'uncertain');assert.deepEqual(calls,[]);
  assert.equal((await life.publish(operation,'reconcile')).ok,true);assert.deepEqual(calls,['publish-oml']);assert.deepEqual(fs.readFileSync(requestPath),before);
  o11Write(requestPath,{...request,moduleKey:'Z'.repeat(22)});
  await assert.rejects(life.publish(operation,'reconcile'),/publication_request_changed/);assert.deepEqual(calls,['publish-oml']);
});

test('version-zero reconciliation adopts only byte-exact current published source using a separate read request',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-o11-reconcile-zero-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const expected=Buffer.from('synthetic-exact-native-published-candidate'),request={operationId:randomUUID(),...target,baseVersionId:1,
    candidateSha256:o11Hash(expected),receiptDirectory:root},requestPath=path.join(root,'publish-request.json'),receiptPath=path.join(root,'receipt.json');
  o11Write(requestPath,request);const prior={operationId:request.operationId,host:target.host,moduleKey:target.moduleKey,
    candidateSha256:request.candidateSha256,state:'uncertain',versionId:0};o11Write(receiptPath,prior);
  const before=fs.readFileSync(requestPath),operation={requestPath,receiptPath,operationId:request.operationId,request},calls=[];let bytes=Buffer.from('different-current-source');
  const life=createO11Lifecycle({root,cli:async(verb,args)=>{
    calls.push(verb);
    if(verb==='inventory')return{...fresh(),modules:[{...fresh().modules[0],VersionId:3}]};
    if(verb==='download'){const directory=args[args.indexOf('--out')+1],file=path.join(directory,'published.oml');fs.writeFileSync(file,bytes);
      return{Status:'ok',IsPublishedVersion:true,Key:target.moduleKey,Name:target.module,VersionId:3,FilePath:file};}
    if(verb==='inspect')return{Key:target.moduleKey,Name:target.module};
    assert.equal(verb,'publish-oml');const read=o11Read(args[1]);assert.equal(read.mode,'reconcile');assert.equal(read.reconcilePublishedVersionId,3);
    assert.notEqual(args[1],requestPath);return{...prior,state:'published',versionId:3};
  }});
  assert.equal((await life.publish(operation,'reconcile')).error,'publish_oml_reconciliation_source_mismatch');assert.ok(!calls.includes('publish-oml'));
  bytes=expected;assert.equal((await life.publish(operation,'reconcile')).ok,true);assert.equal(calls.filter(v=>v==='publish-oml').length,1);
  assert.deepEqual(fs.readFileSync(requestPath),before);assert.deepEqual(o11Read(receiptPath),prior);
});

test('real Windows TextBox, JSON UTF8 and CurrentUser DPAPI preserve synthetic values exactly without opening a window or vault', { skip: process.platform !== 'win32' }, () => {
  const fixture = { username: '  synthetic-user-ç-🔒"\\  ', password: '  synthetic-password-密碼-🔒"\\\t  ' };
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Security
$testInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
$phase = 'capture'
try {
$userField = New-Object Windows.Forms.TextBox
$passField = New-Object Windows.Forms.TextBox
$userField.MaxLength = 512
$passField.MaxLength = 4096
$passField.UseSystemPasswordChar = $true
$userField.Text = $testInput.username
$passField.Text = $testInput.password
$record = [ordered]@{username=$userField.Text;password=$passField.Text}
$utf8 = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 8 -Compress))
$entropy = [Text.Encoding]::UTF8.GetBytes('synthetic-private-roundtrip-only')
$phase = 'protect'
$encrypted = [Security.Cryptography.ProtectedData]::Protect($utf8,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
$decrypted = [Security.Cryptography.ProtectedData]::Unprotect($encrypted,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
$phase = 'compare'
$opened = [Text.Encoding]::UTF8.GetString($decrypted) | ConvertFrom-Json
$safe = @{captured=($userField.Text -ceq $testInput.username -and $passField.Text -ceq $testInput.password);roundtrip=($opened.username -ceq $testInput.username -and $opened.password -ceq $testInput.password)}
$userField.Clear();$passField.Clear();$userField.Dispose();$passField.Dispose()
[Array]::Clear($utf8,0,$utf8.Length);[Array]::Clear($decrypted,0,$decrypted.Length)
[Console]::Out.Write(($safe | ConvertTo-Json -Compress))
} catch { [Console]::Out.Write((@{ok=$false;phase=$phase;type=$_.Exception.GetType().Name} | ConvertTo-Json -Compress));exit 1 }
`;
  const child = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], {
    input: JSON.stringify(fixture), encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(child.status, 0, 'synthetic Windows credential roundtrip: ' + child.stdout.trim());
  assert.deepEqual(JSON.parse(child.stdout), { captured: true, roundtrip: true });
  for (const value of Object.values(fixture)) assert.ok(!child.stdout.includes(value) && !child.stderr.includes(value));
});
