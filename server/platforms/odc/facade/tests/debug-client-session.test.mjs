import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createClientSessionManager, clientSessionSchema, registerClientSessionTool } from '../debug-client-session.mjs';
import { debugRunToolSchema } from '../debug-run.mjs';
const key = 'A'.repeat(22), sha = 'a'.repeat(64);
const scopes = [{ functionKey: key, nodeKeys: ['B'.repeat(22)] }];
const schema = clientSessionSchema(debugRunToolSchema);
const request = { op: 'start', run: { op: 'run', lane: 'o11', module: 'Example', action: '@' + key }, scopes, seconds: 60 };
test('public reconciliation requires the original operation and rejects execution inputs',()=>{
 const input={op:'reconcile',sessionId:'12345678-1234-4234-8234-123456789abc',operationId:'12345678-1234-4234-8234-123456789abd'};
 assert.equal(schema.safeParse(input).success,true);
 assert.equal(schema.safeParse({...input,operationId:undefined}).success,false);
 for(const patch of [{run:request.run},{stop:1,generation:1},{waitMs:1000}])assert.equal(schema.safeParse({...input,...patch}).success,false);
});
test('public private-read accepts only a native reference, never private consume authority or raw payloads',()=>{
 const read={op:'private-read',sessionId:'12345678-1234-4234-8234-123456789abc',stop:1,generation:1,ref:'a'.repeat(48),detail:2};
 assert.equal(schema.safeParse(read).success,true);
 assert.equal(schema.safeParse({...read,binary:true}).success,true);
 assert.equal(schema.safeParse({...read,op:'read',binary:true}).success,false);
 for(const patch of [{op:'private-consume'},{consumerCapability:'b'.repeat(48)},{value:'private-value'},{descriptor:{reference:'opaque'}}])
  assert.equal(schema.safeParse({...read,...patch}).success,false);
});
async function harness(lane = 'o11', options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-client-session-'));
  const source = { path: path.join(root, 'source.oml'), sha256: sha };
  const producerKey='P'.repeat(22),producerSource={path:path.join(root,'producer.oml'),sha256:createHash('sha256').update('producer').digest('hex')};
  fs.writeFileSync(producerSource.path,'producer');
  const contract = path.join(root, 'contract.json');
  fs.writeFileSync(contract, JSON.stringify({ snapshot: source, target: { moduleKey: key },
    ...(options.producer ? {modelSources:[{moduleKey:producerKey,source:{...producerSource,...(options.producerBadHash?{sha256:'f'.repeat(64)}:{})}}]} : {}) }));
  const sourceContract = { path: contract, sha256: createHash('sha256').update(fs.readFileSync(contract)).digest('hex') };
  let configured, resolveRun, disposed = false, calls = [], readCalled = false, scopeReads = [];
  const frames = [{elementKey:key+':'+key+'::'+'H'.repeat(22),breakpoint:key+':'+scopes[0].nodeKeys[0]},
    {elementKey:key+':'+('C'.repeat(22))+'::'+'H'.repeat(22),breakpoint:key+':'+('D'.repeat(22))}];
  const completed = new Promise(resolve => { resolveRun = resolve; });
  const handle = Object.freeze({
    prepare: async () => ({}), prepareBrowser: async () => { calls.push({op:'prepare-browser'}); return { prepared: true }; }, authenticate: async () => ({ authenticated: true }),
    configureInspection: async config => { configured = config; },
    consumePrivateInspection: async (descriptor,consumer) => {
      calls.push({op:'private-consumer'});
      if (options.privateTransportFailure) throw new Error('private transport diagnostic must not escape');
      await consumer({type:'Text',value:'private-client-value-Ω'});
      return{consumed:true,frame:0};
    },
    invoke: async () => { configured.onEvent({ kind: 'paused', stop: 1, generation: 1, sessionId: 'native', frame: 0, frames }); return completed; },
    inspection: async input => {
      calls.push(input);
      if (input.op === 'read' && options.readFailure) throw new Error(options.readFailure);
      if (input.op === 'frame') return { stop: 1, generation: 2, frame: input.frame };
      if (input.op === 'bind-scope') return {metadataBound:true};
      if (input.op === 'request-pause') {
        if (options.pauseFailure) throw new Error('debug_native_client_transport_timeout');
        if (options.pauseRace) configured.onEvent({kind:'paused',stop:2,generation:3,callContextId:9,frames});
        return {requested:true,mode:'native-next-node',callContextIds:[9]};
      }
      if (input.op === 'continue') { configured.onEvent({ kind: 'resumed' }); if (!options.keepRunning) resolveRun({ ok: true, uncertain: false }); }
      if (input.op === 'stop') {
        if (options.deferStopCompletion) setImmediate(() => resolveRun({ ok: false, uncertain: true }));
        else resolveRun({ ok: false, uncertain: true });
        if (options.stopReply) return options.stopReply;
      }
      if (input.op === 'read-many' && options.readManyReply) return options.readManyReply(input);
      if (input.op === 'scope' && options.scopeContext) return { sessionId: 'native', runtime: 'client', stop: 1, generation: 1, metadataBound: true,
        variables: [{ ref: 'r'.repeat(48), name: 'Count', category: 'local' }], context: { moduleKey: key, functionKey: key, nodeKey: scopes[0].nodeKeys[0], previousNodeKey: null } };
      return { sessionId: 'native', stop: 1, generation: 1, variables: [] };
    }, dispose: async () => { disposed = true; },
  });
  const run = async (input, { services }) => {
    let broker;
    try {
      if (lane === 'o11') broker = await services.nativeBroker.prepare({ sourceContract });
      else { broker = services.broker({}); await broker[options.browserMount ? 'prepareBrowser' : 'prepare']({ prepared: { sourceContract: source }, binding: { moduleKey: key }, modelSources: JSON.parse(fs.readFileSync(contract)).modelSources }); }
      await broker.authenticate({ expiresAt: new Date(Date.now() + 25000).toISOString() });
      return await broker.invoke({});
    } finally { await broker?.dispose(); }
  };
  const manager = createClientSessionManager({ root, run, o11Broker: { prepare: async () => handle }, odcBroker: () => handle,
    readScopes: async input => { readCalled = true; scopeReads.push(input); const producer=input.moduleKey===producerKey;
      assert.deepEqual(input.source,producer?producerSource:source);return { modules: [{ moduleKey: input.moduleKey, sourceSha256: input.source.sha256 }], variables: [], functionHashes:input.scopes.map(s=>({moduleKey:input.moduleKey,functionKey:s.functionKey,sourceSha256:input.source.sha256,debuggerHash:(producer?'Q':'H').repeat(22)})), breakpoints: [key + ':' + scopes[0].nodeKeys[0]], evidence: ['native-model-scope'],
      ...(options.scopeContext ? { coverage: input.scopes.map(s => ({ moduleKey: input.moduleKey, functionKey: s.functionKey, nodeKey: s.nodeKeys[0], previousNodeKey: null,
        sourceSha256: input.source.sha256, authority: 'installed-model-scope-and-watchability', modelScopeEnumerated: true, variableCounts: { input: 0, local: 1, output: 0, client: 0 } })) } : {}) }; }, ...options });
  const start = await manager(schema.parse({ ...request, run: { ...request.run, lane }, ...(options.startPatch ?? {}) }));
  const status = async () => {
    let result = await manager({ op: 'status', sessionId: start.sessionId });
    for (let i = 0; i < 8 && ['preparing', 'running', 'authenticating'].includes(result.state); i++)
      result = await manager({ op: 'status', sessionId: start.sessionId, afterRevision: result.revision, waitMs: 1000 });
    return result;
  };
  return { root, manager, start, status, calls, scopeReads, frames, producerKey,producerSource, configured: () => configured, disposed: () => disposed, readCalled: () => readCalled };
}
for(const lane of ['o11','odc']) for(const race of [false,true]) test(lane+': cooperative pause separates acknowledgement and observed stop, race='+race,async()=>{
 const h=await harness(lane,{keepRunning:true,pauseRace:race});await h.status();
 await h.manager({op:'continue',sessionId:h.start.sessionId,stop:1,generation:1});
 const running=await h.manager({op:'status',sessionId:h.start.sessionId});
 const input={op:'pause',sessionId:h.start.sessionId,afterRevision:running.revision};
 assert.equal(schema.safeParse(input).success,true);
 const result=await h.manager(input);assert.equal(result.pauseRequest.outcome,race?'observed':'acknowledged');
 assert.equal(result.state,race?'paused':'running');
 await assert.rejects(h.manager(input),/pause_stale_revision/);
 if(!race){const fresh=await h.manager({op:'status',sessionId:h.start.sessionId});await assert.rejects(h.manager({...input,afterRevision:fresh.revision}),/pause_request_pending/);
  h.configured().onEvent({kind:'paused',stop:2,generation:3,callContextId:9,frames:h.frames});}
 const observed=await h.manager({op:'status',sessionId:h.start.sessionId});assert.equal(observed.pauseRequest.outcome,'observed');
 assert.equal(h.calls.filter(c=>c.op==='request-pause').length,1);
 await h.manager({op:'stop',sessionId:h.start.sessionId});await h.status();
});
test('cooperative pause transport loss remains uncertain and cannot be resent',async()=>{
 const h=await harness('odc',{keepRunning:true,pauseFailure:true});await h.status();
 await h.manager({op:'continue',sessionId:h.start.sessionId,stop:1,generation:1});
 let status=await h.manager({op:'status',sessionId:h.start.sessionId});
 await assert.rejects(h.manager({op:'pause',sessionId:h.start.sessionId,afterRevision:status.revision}),/transport_timeout/);
 status=await h.manager({op:'status',sessionId:h.start.sessionId});assert.equal(status.pauseRequest.outcome,'uncertain');
 await assert.rejects(h.manager({op:'pause',sessionId:h.start.sessionId,afterRevision:status.revision}),/pause_request_pending/);
 assert.equal(h.calls.filter(c=>c.op==='request-pause').length,1);
 await h.manager({op:'stop',sessionId:h.start.sessionId});await h.status();
});
for (const lane of ['o11','odc']) test(lane+' failed reads persist sanitized diagnostics without resuming the paused action',async()=>{
 for(const readFailure of ['debug_native_client_evaluation_failed','private value: confidential']){
  const h=await harness(lane,{readFailure});await h.status();
  const token={sessionId:h.start.sessionId,stop:1,generation:1};
  await assert.rejects(h.manager({...token,op:'read',ref:'a'.repeat(48)}));
  const state=await h.status();assert.equal(state.state,'paused');
  assert.equal(state.lastCommandFailure.op,'read');assert.equal(state.lastCommandFailure.stop,1);
  assert.equal(state.lastCommandFailure.error,readFailure.startsWith('debug_')?readFailure:'debug_client_session_failed');
  const persisted=JSON.parse(fs.readFileSync(state.receiptPath,'utf8'));
  assert.deepEqual(persisted.lastCommandFailure,state.lastCommandFailure);
  assert.doesNotMatch(JSON.stringify(persisted),/confidential|private value/);
  assert.equal(h.calls.some(c=>c.op==='continue'),false);
  await h.manager({op:'stop',sessionId:h.start.sessionId});await h.status();
 }
});
for (const lane of ['o11','odc']) test(lane+' native exception scope binds through the public coordinator with the original hash',async()=>{
 const action='LXQ1dKTtRUeai5qBhffq7g.#FlowExceptionHandler';
 assert.equal(schema.safeParse({...request,scopes:[{functionKey:action,nodeKeys:scopes[0].nodeKeys}]}).success,true);
 assert.equal(schema.safeParse({...request,scopes:[{functionKey:action+'.invalid',nodeKeys:scopes[0].nodeKeys}]}).success,false);
 const h=await harness(lane);await h.status();
 h.frames[0].elementKey=key+':'+action+'::'+'H'.repeat(22);
 const token={sessionId:h.start.sessionId,stop:1,generation:1};
 await h.manager({...token,op:'scope'});
 assert.equal(h.scopeReads.at(-1).scopes[0].functionKey,action);
 assert.equal(h.calls.find(c=>c.op==='bind-scope').functionKey,action);
 h.frames[0].elementKey=key+':'+action+'::'+'X'.repeat(22);
 await assert.rejects(h.manager({...token,op:'scope'}),/function_hash_mismatch/);
 await h.manager({op:'stop',sessionId:h.start.sessionId});await h.status();
});
for (const lane of ['o11', 'odc']) test(lane+' producer scope uses its own capture and hash even when function and node keys equal the consumer',async()=>{
 const h=await harness(lane,{producer:true});await h.status();
 const token={sessionId:h.start.sessionId,stop:1,generation:1};
 await h.manager({...token,op:'scope'});
 assert.equal(h.configured().modules.length,2);
 h.frames[0].elementKey=h.producerKey+':'+key+'::'+'Q'.repeat(22);
 h.frames[0].breakpoint=h.producerKey+':'+scopes[0].nodeKeys[0];
 await h.manager({...token,op:'scope'});
 const bound=h.calls.find(c=>c.op==='bind-scope');
 assert.equal(bound.moduleKey,h.producerKey);assert.equal(bound.sourceSha256,h.producerSource.sha256);
 assert.equal(h.scopeReads.length,2);
 await h.manager({...token,op:'scope'});assert.equal(h.scopeReads.length,2);
 h.frames[0].elementKey=h.producerKey+':'+key+'::'+'H'.repeat(22);
 await assert.rejects(h.manager({...token,op:'scope'}),/function_hash_mismatch/);
 await h.manager({op:'stop',sessionId:h.start.sessionId});await h.status();
});
for (const lane of ['o11', 'odc']) test(lane+' altered producer bytes are refused before configuring native inspection',async()=>{
 const h=await harness(lane,{producer:true,producerBadHash:true});
 const state=await h.status();assert.equal(state.state,'failed');
 assert.equal(state.error,'debug_client_session_producer_source_unavailable');
 assert.equal(h.configured(),undefined);
});
test('embedded private consumer shares the command queue, ignores callback returns and refuses stale public tokens',async()=>{
 const h=await harness('odc');await h.status();
 const input={sessionId:h.start.sessionId,stop:1,generation:1,descriptor:{reference:'12345678-1234-4234-8234-123456789abc',
  expiresAt:new Date(Date.now()+60000).toISOString(),sealed:true,roundTripVerified:true,storage:'windows-current-user-dpapi',plaintextPersisted:false}};
 await assert.rejects(h.manager.consumePrivate(input,()=>{throw new Error('private-client-value-Ω');}),/^Error: debug_client_session_private_consumer_callback_failed$/);
 let release,entered;const wait=new Promise(r=>release=r),started=new Promise(r=>entered=r);let observed;
 const consume=h.manager.consumePrivate(input,async value=>{observed=value;entered();await wait;return value;});
 await started;const step=h.manager({op:'continue',sessionId:input.sessionId,stop:1,generation:1});
 await new Promise(r=>setImmediate(r));assert.equal(h.calls.some(c=>c.op==='continue'),false);
 release();const result=await consume;assert.deepEqual(observed,{type:'Text',value:'private-client-value-Ω'});
 assert.doesNotMatch(JSON.stringify(result),/private-client-value|value/);await step;await h.status();
 await assert.rejects(h.manager.consumePrivate(input,()=>assert.fail('stale callback ran')),/stale_stop/);
 await assert.rejects(h.manager.consumePrivate({...input,consumerCapability:'invented'},()=>{}),/private_consumer_invalid/);
});

test('private channel failure remains distinct from callback failure without leaking transport details',async()=>{
 const h=await harness('o11',{privateTransportFailure:true});await h.status();
 const input={sessionId:h.start.sessionId,stop:1,generation:1,descriptor:{reference:'12345678-1234-4234-8234-123456789abc',
  expiresAt:new Date(Date.now()+60000).toISOString(),sealed:true,roundTripVerified:true,storage:'windows-current-user-dpapi',plaintextPersisted:false}};
 let entered=false;
 await assert.rejects(h.manager.consumePrivate(input,()=>{entered=true;}),/^Error: debug_client_session_private_consumer_failed$/);
 assert.equal(entered,false);
 await h.manager({op:'stop',sessionId:h.start.sessionId});await h.status();
});

test('new native frame loads its exact published scope on demand and caches only successful binds', async()=>{
 const h=await harness('odc');await h.status();
 const token={sessionId:h.start.sessionId,stop:1,generation:1};
 await h.manager({...token,op:'frame',frame:1});token.generation=2;
 await h.manager({...token,op:'scope'});
 assert.equal(h.scopeReads.length,2);
 assert.deepEqual(h.scopeReads[1].scopes,[{functionKey:'C'.repeat(22),nodeKeys:['D'.repeat(22)]}]);
 const bind=h.calls.find(c=>c.op==='bind-scope');assert.equal(bind.sourceSha256,sha);assert.equal(bind.stop,1);assert.equal(bind.generation,2);
 await h.manager({...token,op:'scope'});assert.equal(h.scopeReads.length,2);
 h.frames[1].elementKey='E'.repeat(22)+':'+('C'.repeat(22));
 h.frames[1].breakpoint='E'.repeat(22)+':'+('D'.repeat(22));
 await assert.rejects(h.manager({...token,op:'scope'}),/producer_source_unavailable/);
 assert.equal(h.scopeReads.length,2);await h.manager({...token,op:'continue'});await h.status();
});

for (const lane of ['o11','odc']) for (const frame of [0,1]) test(`${lane}: frame ${frame} rejects missing or changed native function hashes before exposing scope`, async () => {
 const h=await harness(lane); await h.status();
 const token={sessionId:h.start.sessionId,stop:1,generation:1};
 if(frame){await h.manager({...token,op:'frame',frame});token.generation=2;}
 const original=h.frames[frame].elementKey;
 h.frames[frame].elementKey=original.split(':').slice(0,2).join(':');
 await assert.rejects(h.manager({...token,op:'scope'}),/function_hash_unavailable/);
 h.frames[frame].elementKey=original.slice(0,-22)+'J'.repeat(22);
 await assert.rejects(h.manager({...token,op:'scope'}),/function_hash_mismatch/);
 assert.equal(h.calls.some(c=>c.op==='scope'||c.op==='bind-scope'),false);
 h.frames[frame].elementKey=original;
 assert.equal((await h.manager({...token,op:'scope'})).ok,true);
 await h.manager({op:'stop',sessionId:h.start.sessionId}); await h.status();
});

for (const lane of ['o11','odc']) test(lane + ': a breakpoint from another module cannot bind even when its node key is cached', async () => {
 const h=await harness(lane); await h.status();
 h.frames[0].breakpoint='Z'.repeat(22)+':'+scopes[0].nodeKeys[0];
 await assert.rejects(h.manager({op:'scope',sessionId:h.start.sessionId,stop:1,generation:1}),/scope_frame_unavailable/);
 assert.equal(h.scopeReads.length,1);
 assert.equal(h.calls.some(c=>c.op==='bind-scope'),false);
 await h.manager({op:'stop',sessionId:h.start.sessionId}); await h.status();
});

test('same node reached from different native predecessors binds the matching previous-node visitor',async()=>{
 const h=await harness('odc');await h.status();const token={sessionId:h.start.sessionId,stop:1,generation:1};
 h.frames[0].previousBreakpoint=key+':'+('E'.repeat(22));
 await h.manager({...token,op:'scope'});
 assert.deepEqual(h.scopeReads[1].scopes,[{functionKey:key,nodeKeys:scopes[0].nodeKeys,previousNodeKey:'E'.repeat(22)}]);
 assert.equal(h.calls.find(c=>c.op==='bind-scope').previousNodeKey,'E'.repeat(22));
 h.frames[0].previousBreakpoint=key+':'+('F'.repeat(22));await h.manager({...token,op:'scope'});
 assert.equal(h.scopeReads.length,3);
 h.frames[0].previousBreakpoint='Z'.repeat(22)+':'+('E'.repeat(22));
 await assert.rejects(h.manager({...token,op:'scope'}),/previous_scope_unavailable/);
 assert.equal(h.scopeReads.length,3);await h.manager({...token,op:'continue'});await h.status();
});
test('lease expiry during a lazy model read prevents metadata binding to the expired pause', async()=>{
 let h,reads=0;
 h=await harness('odc',{readScopes:async()=>{
  if(++reads===2)h.configured().onEvent({kind:'expired',error:'debug_native_client_expired'});
  return{modules:[{moduleKey:key,sourceSha256:sha}],variables:[],breakpoints:[],evidence:[],functionHashes:[{moduleKey:key,functionKey:key,sourceSha256:sha,debuggerHash:'H'.repeat(22)}]};
 }});
 await h.status();const token={sessionId:h.start.sessionId,stop:1,generation:1};
 await h.manager({...token,op:'frame',frame:1});
 await assert.rejects(h.manager({...token,generation:2,op:'scope'}),/stale_stop/);
 assert.equal(h.calls.some(c=>c.op==='bind-scope'),false);
 await h.manager({op:'stop',sessionId:h.start.sessionId});await h.status();
});
for (const lane of ['o11', 'odc']) test(lane + ': public session retains native invocation, pins stops and preserves cleanup outcome', async () => {
  const h = await harness(lane);
  assert.equal(h.start.state, 'preparing');
  const paused = await h.status(); assert.equal(paused.state, 'paused'); assert.equal(h.readCalled(), true);
  assert.deepEqual(paused.capabilities.manualPause, { supported: true, mode: 'native-next-node', immediateSuspension: false, liveQualified: true });
  assert.equal(schema.safeParse({ op: 'pause', sessionId: h.start.sessionId }).success, false);
  assert.ok(h.configured().leaseMs <= 25000);
  const command = { sessionId: h.start.sessionId, stop: 1, generation: 1 };
  await assert.rejects(h.manager({ ...command, op: 'continue', stop: 2 }), /stale_stop/); assert.equal(h.calls.length, 0);
  const scope = await h.manager({ ...command, op: 'scope' }); assert.equal(scope.sessionId, h.start.sessionId); assert.equal(scope.nativeSessionId, 'native');
  await h.manager({ ...command, op: 'frame', frame: 1 });
  await assert.rejects(h.manager({ ...command, op: 'read', ref: 'a'.repeat(48) }), /stale_stop/);
  await h.manager({ ...command, generation: 2, op: 'continue' });
  await assert.rejects(h.manager({ ...command, generation: 2, op: 'continue' }), /stale_stop/);
  const end = await h.status(); assert.equal(end.state, 'completed'); assert.equal(end.runResult.uncertain, false); assert.equal(h.disposed(), true);
  const restarted = createClientSessionManager({ root: h.root });
  assert.equal((await restarted({ op: 'status', sessionId: h.start.sessionId })).ownerAvailable, false);
});
test('stop retains uncertain execution and completed disposal rather than declaring success', async () => {
  const h = await harness(); await h.status();
  await h.manager({ op: 'stop', sessionId: h.start.sessionId });
  await new Promise(resolve => setImmediate(resolve));
  const result = await h.status(); assert.equal(result.state, 'uncertain'); assert.equal(h.disposed(), true);
});
for (const lane of ['o11', 'odc']) test(lane + ': status wait without cursor yields to process completion after stop', async () => {
  const h = await harness(lane, { deferStopCompletion: true }); await h.status();
  await h.manager({op:'stop',sessionId:h.start.sessionId});
  const result = await h.manager({op:'status',sessionId:h.start.sessionId,waitMs:1000});
  assert.equal(result.state,'uncertain');
  assert.equal(h.disposed(),true);
  const terminal = await h.manager({op:'status',sessionId:h.start.sessionId,afterRevision:result.revision,waitMs:1000});
  assert.equal(terminal.revision,result.revision);
});
for (const lane of ['o11', 'odc']) test(lane + ': stop cleanup evidence survives owner loss without claiming execution or credential completion', async () => {
  const h = await harness(lane, { stopReply: { workerTerminated: true,
    privateInspectionCleanup: { completed: true, pending: 0, secret: 'NEVER_PERSIST' },
    value: 'NEVER_PERSIST', credentialsReleased: true, memoryCleared: true } });
  await h.status();
  await h.manager({ op: 'stop', sessionId: h.start.sessionId });
  await new Promise(resolve => setImmediate(resolve));
  const recovered = await createClientSessionManager({ root: h.root })({ op: 'status', sessionId: h.start.sessionId });
  assert.equal(recovered.ownerAvailable, false);
  assert.equal(recovered.state, 'uncertain');
  assert.deepEqual(recovered.stopEvidence.privateInspectionCleanup, { completed: true, pending: 0 });
  assert.equal(recovered.stopEvidence.workerTerminationRequested, true);
  assert.equal(recovered.stopEvidence.executionOutcome, 'requires-reconciliation');
  assert.equal(recovered.stopEvidence.credentialsReleased, undefined);
  assert.equal(recovered.stopEvidence.memoryCleared, undefined);
  assert.doesNotMatch(JSON.stringify(recovered), /NEVER_PERSIST/);
});

test('contradictory private cleanup acknowledgement cannot be persisted as completion', async () => {
  const h = await harness('o11', { stopReply: { privateInspectionCleanup: { completed: true, pending: 1 } } });
  await h.status(); await h.manager({ op: 'stop', sessionId: h.start.sessionId });
  assert.equal((await h.status()).stopEvidence.privateInspectionCleanup, undefined);
});

test('model scope failure remains visible and never configures or invokes the runtime', async () => {
  const h = await harness('o11', { readScopes: async () => { throw new Error('debug_native_scope_source_changed'); } });
  const result = await h.status();
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'debug_native_scope_source_changed');
  assert.equal(h.configured(), undefined); assert.equal(h.calls.length, 0);
});
test('public schema refuses stale capabilities, mixed operations, duplicate nodes and wrapper runs', () => {
  assert.equal(schema.safeParse(request).success, true);
  for (const change of [{ run: { ...request.run, execution: 'rest-wrapper' } }, { run: { ...request.run, trace: 'full' } },
    { scopes: [scopes[0], scopes[0]] }, { refs: ['a'.repeat(48)] }]) assert.equal(schema.safeParse({ ...request, ...change }).success, false);
  assert.equal(schema.safeParse({ op: 'continue', sessionId: '12345678-1234-4234-9234-123456789abc' }).success, false);
  const pins = { operationId: '12345678-1234-4234-9234-123456789abc', receiptSha256: sha, debugReceiptSha256: sha, manifestSha256: sha };
  assert.equal(schema.safeParse({ ...request, independentClientLocal: pins }).success, false);
  assert.equal(schema.safeParse({ ...request, run: { ...request.run, lane: 'odc' }, independentClientLocal: pins }).success, true);
  let registered;
  registerClientSessionTool({ registerTool(name, config) { registered = { name, config }; } }, debugRunToolSchema, x => x);
  assert.equal(registered.name, 'ssam_debug_client'); assert.equal(registered.config.inputSchema.safeParse(request).success, true);
});

test('public return tree and text pages require current stop and pass bounded offsets to native inspection', async()=>{
 const h=await harness('odc');await h.status();
 const token={sessionId:h.start.sessionId,stop:1,generation:1,ref:'a'.repeat(48)};
 for(const op of ['children','slice']){
  const command={...token,op,offset:150,limit:150};
  await h.manager(schema.parse(command));
  assert.deepEqual(h.calls.at(-1),{op,ref:token.ref,offset:150,limit:150});
  assert.equal(schema.safeParse({...command,generation:undefined}).success,false);
  assert.equal(schema.safeParse({...command,detail:2}).success,false);
  await assert.rejects(h.manager({...command,stop:2}),/stale_stop/);
 }
 assert.equal(schema.safeParse({...token,op:'children',limit:151}).success,false);
 assert.equal(schema.safeParse({...token,op:'slice',limit:65537}).success,false);
 await h.manager({op:'stop',sessionId:h.start.sessionId});await h.status();
});

test('odc authorized mount binds published scopes on browser preparation and configures inspection after sign-in',async()=>{
 const h=await harness('odc',{browserMount:true});const state=await h.status();
 assert.equal(state.state,'paused');assert.equal(h.readCalled(),true);
 assert.equal(h.calls[0].op,'prepare-browser');assert.deepEqual(h.configured().breakpoints,[key+':'+scopes[0].nodeKeys[0]]);
 await h.manager({op:'stop',sessionId:h.start.sessionId});await h.status();
});
// Wave 2 (P14): pauseOnExceptions is a start-only boolean forwarded to the original switch; scope results are frame-bound and categorized.
for (const lane of ['o11', 'odc']) test(lane + ': start.pauseOnExceptions reaches configureInspection; scope gets frame-bound coverage and categories', async () => {
  const sessionId = '12345678-1234-4234-8234-123456789abc';
  assert.equal(schema.safeParse({ ...request, pauseOnExceptions: true }).success, true);
  assert.equal(schema.safeParse({ ...request, pauseOnExceptions: 'yes' }).success, false);
  assert.equal(schema.safeParse({ op: 'status', sessionId, pauseOnExceptions: true }).success, false);
  assert.equal(schema.safeParse({ op: 'scope', sessionId, stop: 1, generation: 1, pauseOnExceptions: true }).success, false);
  const h = await harness(lane, { startPatch: { pauseOnExceptions: true }, scopeContext: true, keepRunning: true });
  const paused = await h.status();
  assert.equal(paused.state, 'paused'); assert.equal(paused.pauseOnExceptions, true);
  assert.equal(h.configured().pauseOnExceptions, true);
  const scope = await h.manager({ op: 'scope', sessionId: h.start.sessionId, stop: 1, generation: 1 });
  assert.equal(scope.metadataCoverage.runtimeFrameBound, true); assert.equal(scope.metadataCoverage.runtimeValuesComplete, false);
  for (const category of ['session', 'site', 'setting', 'timer']) assert.ok(scope.notApplicableToRuntime.includes(category), category);
  assert.ok(scope.emptyInModel.includes('client')); assert.deepEqual(scope.unavailableCategories, scope.notEnumerated);
  if (lane === 'odc') assert.equal(scope.notApplicableReasons.session.reason, 'odc-model-refuses-session-variables');
  await h.manager({ op: 'stop', sessionId: h.start.sessionId });
  const plain = await harness(lane, { keepRunning: true }); await plain.status();
  assert.equal(plain.configured().pauseOnExceptions, false);
  await plain.manager({ op: 'stop', sessionId: plain.start.sessionId });
});
// Wave 3 (P28): read-scope is one queue entry: frame-bound scope, then read-many of every root; stale tokens are refused.
for (const lane of ['o11', 'odc']) test(lane + ': read-scope reads the frame roots through the coordinator and returns completeness', async () => {
  const h = await harness(lane, { scopeContext: true, keepRunning: true,
    readManyReply: input => ({ stop: 1, generation: 1, values: input.refs.map(r => ({ stop: 1, generation: 1, ref: r, evaluation: 1, value: { type: 'Integer', value: 1 }, redacted: false, expandable: false, valueComplete: true })) }) });
  const paused = await h.status(); assert.equal(paused.state, 'paused');
  const input = { op: 'read-scope', sessionId: h.start.sessionId, stop: 1, generation: 1, maxNodes: 50 };
  assert.equal(schema.safeParse(input).success, true);
  const result = await h.manager(input);
  assert.equal(result.sessionId, h.start.sessionId); assert.ok(result.scopeCompleteness, 'completeness computed');
  assert.deepEqual(h.calls.filter(c => ['scope', 'read-many'].includes(c.op)).map(c => c.op), ['scope', 'read-many']);
  assert.deepEqual(h.calls.find(c => c.op === 'read-many').refs, ['r'.repeat(48)]);
  await assert.rejects(h.manager({ ...input, generation: 2 }), /debug_client_session_stale_stop/);
  await h.manager({ op: 'stop', sessionId: h.start.sessionId });
});
