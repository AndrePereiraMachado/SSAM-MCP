import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import { foreignPendingReason } from '../debug-foreign-pending.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServerSessionManager, serverSessionSchema, registerServerSessionTool } from '../debug-server-session.mjs';
import { debugRunToolSchema } from '../debug-run.mjs';
import {createHash} from 'node:crypto';
const moduleKey = 'A'.repeat(22), functionKey = 'B'.repeat(22), nodeKey = 'C'.repeat(22), nativeId = 'a'.repeat(32);
const scopes = [{ functionKey, nodeKeys: [nodeKey] }], schema = serverSessionSchema(debugRunToolSchema);
const request = { op: 'start', run: { op: 'run', lane: 'odc', module: 'Fixture', action: '@' + functionKey }, scopes };
async function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-server-session-'));
  const calls = [], phases = [], modelReads = [], bindings = [], contexts = [];
  let nativeGeneration = 1, metadataBound = !options.lazyNode;
  let status = { ok: true, state: 'connected', pauses: [], events: [] }, resolveRun, trace;
  const completed = new Promise(resolve => { resolveRun = resolve; });
  const binding = { lane: options.lane ?? 'odc', moduleKey, functionKey, source: { path: path.join(root, 'source.oml'), sha256: 'a'.repeat(64) } };
  if(options.pinnedForeign){
    const source={path:path.join(root,'consumer.oml'),sha256:createHash('sha256').update('consumer').digest('hex')};
    fs.writeFileSync(source.path,'consumer');
    binding.models=[{moduleKey,source:binding.source},{moduleKey:options.foreignModule,source}];
    if(options.changedForeign)fs.writeFileSync(source.path,'changed');
  }
  const debug = async (input, context) => {
    calls.push(input);
    contexts.push(context);
    if (input.op === 'start') return { ok: true, state: 'connected', sessionId: options.group && input.moduleKey===options.foreignModule?'c'.repeat(32):nativeId, autoContinue: false, inspectionMode: 'interactive', expiresAt: new Date(Date.now() + 60000).toISOString() };
    if (input.op === 'status') return structuredClone(status);
    if(input.op==='pause'){if(options.pauseTimeout)throw new Error('debug_command_uncertain');return {ok:true,state:'connected',pauseRequest:{requested:true}};}
    if (input.op === 'stop') {
      status = { ok: true, state: 'stopped' }; resolveRun({ ok: false, uncertain: true });
      if (options.uncertainStop) throw new Error('debug_session_unreachable');
      return status;
    }
    if (input.op === 'frame') { nativeGeneration++; if (options.frameTimeout) throw new Error('debug_session_timeout'); }
    if (['continue', 'step-into', 'step-over', 'step-out'].includes(input.op)) {
      status.pauses = []; status.events = [{ kind: 'thread-end', threadId: 'T', eventId: '2' }];
      resolveRun({ ok: true, uncertain: false, credentialsReleased: true, cleanup: { completed: true } });
      return { ok: true };
    }
    return { ok: true, metadataBound, context: { threadId: 'T', eventId: '1', frame: 0, generation: nativeGeneration,
      ...(options.correlation ? {correlation:options.correlation} : {}),
      moduleKey: options.foreignModule ?? moduleKey, functionKey: options.lazyFunction ?? functionKey, nodeKey: options.lazyNode ?? nodeKey,
      ...(options.previousNode ? { previousNodeKey: options.previousNode, previousModuleKey: options.previousModule ?? moduleKey } : {}) },
      variables: metadataBound ? [{ reference: 'b'.repeat(32) }] : [] };
  };
  const run = async (_, { services }) => {
    try {
      await services.prepareServerInspection(binding); phases.push('metadata');
      await services.prepareUser({}, {}); phases.push('sign-in');
      const started = await services.debug({ op: options.background ? 'watch' : 'start', lane: binding.lane, tenant: 'fixture', module: 'Fixture', moduleKey,
        runtimeUrl: options.group?'https://example.invalid/Consumer/':'https://example.invalid/Fixture/', nodeKeys: [nodeKey], seconds: 600, autoContinue: true, trace: { mode: 'step' },
        ...(options.group?{o11Auth:{applicationKey:'J'.repeat(22),publishedVersionId:2,publishedProof:{path:path.join(root,'inventory.json'),sha256:'a'.repeat(64)},
          entry:{module:'Consumer',moduleKey:options.foreignModule,applicationKey:'K'.repeat(22),publishedVersionId:3}}}:{}) },
        options.group?{appUser:{binding:{moduleKey:options.foreignModule}},redactionOnly:true}:options.background ? {backgroundWatch:true,contextMode:'native-background'} : undefined);
      if (!started.ok) return { ok: false, uncertain: false };
      await services.beforeServerInvocation(); phases.push('invoke');
      status.pauses = options.startRunning?[]:[{ threadId: 'T', eventId: '1', stack: [{ frame: 0, module: 'Fixture', moduleKey:options.group?options.foreignModule:moduleKey, action: 'Action', functionKey, nodeKey }] }];
      const result = await completed;
      for (let i = 0; i < 30 && !services.traceRead().some(line => line.kind === 'thread-end'); i++) {
        if (!result.ok) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      trace = services.traceRead(); return result;
    } finally { if (calls.some(c => c.op === 'start')) await services.debug({ op: 'stop', sessionId: nativeId }); }
  };
  const manager = createServerSessionManager({ root, run, debug, pollMs: 5, o11Runner: () => () => {},
    bindScope: async input => {
      bindings.push(input); assert.equal(input.scopeUpdate.generation, nativeGeneration);
      nativeGeneration++; metadataBound = true;
      if (options.bindTimeout) throw new Error('debug_command_uncertain');
      return debug({ op: 'scope' });
    },
    prepareUser: async () => ({ ok: true }), readScopes: async input => {
      modelReads.push(input);
      assert.equal(input.runtime, 'server'); assert.deepEqual(input.source, binding.models?.find(m=>m.moduleKey===input.moduleKey)?.source ?? binding.source);
      if (options.modelError) throw new Error('debug_native_scope_source_changed');
      if (options.lazyReadFailure && modelReads.length > 1) throw new Error('debug_native_scope_source_changed');
      return { evidence: ['native-model'], coverage: [{ moduleKey:input.moduleKey, functionKey:input.scopes[0].functionKey,
        nodeKey:input.scopes[0].nodeKeys[0], previousNodeKey:input.scopes[0].previousNodeKey ?? null, sourceSha256:input.source.sha256,
        authority:'installed-model-scope-and-watchability', modelScopeEnumerated:true, variableCounts:{input:0,output:1} }], variables: [{ moduleKey:input.moduleKey, functionKey: input.scopes[0].functionKey,
        nodeKey: input.scopes[0].nodeKeys[0], variableKey: 'D'.repeat(22),
        name: 'Result', category: 'output', path: 'Result', sourceSha256: input.source.sha256 }] };
    }, ...options.services });
  const start = await manager(schema.parse({ ...request, scopes: options.scopes ?? scopes, run: { ...request.run, lane: binding.lane,
    ...(options.background ? {contextMode:'native-background',launch:{contextMode:'app-user',inputs:{}},words:'Run diagnostic Timer'} : {}) } }));
  const wait = async terminal => {
    let result;
    for (let i = 0; i < 30; i++) {
      result = await manager({ op: 'status', sessionId: start.sessionId });
      if (terminal ? ['failed', 'completed', 'uncertain'].includes(result.state) : result.state === 'paused' || result.state === 'failed') return result;
      result = await manager({ op: 'status', sessionId: start.sessionId, afterRevision: result.revision, waitMs: 100 });
    }
    assert.fail('session did not reach expected phase: ' + result.state);
  };
  t.after(async () => { await manager({ op: 'stop', sessionId: start.sessionId }).catch(() => {}); await wait(true);
    fs.rmSync(root, { recursive: true, force: true }); });
  return { manager, start, wait, calls, contexts, phases, modelReads, bindings, trace: () => trace, root,
    observePause: () => { status.pauses = [{ threadId: 'T', eventId: '1',
      stack: [{ frame: 0, module: 'Fixture', moduleKey, action: 'Action', functionKey, nodeKey }] }]; } };
}
for (const lane of ['o11','odc']) test(lane + ': runner trace preserves only proven native request fingerprints', async t => {
  for (const correlation of [
    {nativeRequestIdProvenance:true,nativeRequestIdSha256:'a'.repeat(64)},
    {nativeRequestIdProvenance:false,nativeRequestIdSha256:'a'.repeat(64)},
    {nativeRequestIdProvenance:true,nativeRequestIdSha256:'private raw request'},
  ]) {
    const h=await harness(t,{lane,correlation});const paused=await h.wait(false);
    const token={sessionId:h.start.sessionId,threadId:'T',eventId:'1',generation:paused.pauses[0].generation};
    await h.manager({...token,op:'scope'});
    await h.manager({...token,op:'continue'});await h.wait(true);
    const line=h.trace().find(x=>x.eventId==='1');
    const proved=correlation.nativeRequestIdProvenance&&correlation.nativeRequestIdSha256.length===64;
    assert.equal(line.nativeRequestIdSha256,proved?'a'.repeat(64):undefined);
    assert.equal(line.requestOwnershipProved,proved?false:undefined);
    assert.doesNotMatch(JSON.stringify(h.trace()),/private raw request/);
  }
});

for (const lane of ['o11', 'odc']) test(lane + ': public server coordinator binds runner model, pins stops and returns the original terminal receipt', async t => {
  const h = await harness(t, { lane }); const paused = await h.wait(false);
  assert.deepEqual(h.phases, ['metadata', 'sign-in', 'invoke']);
  const started = h.calls.find(c => c.op === 'start'); assert.equal(started.autoContinue, false); assert.equal(started.trace, undefined);
  assert.equal(started.seconds, 300); assert.equal(started.inspection.variables[0].path, 'Result');
  const command = { sessionId: h.start.sessionId, threadId: 'T', eventId: '1', generation: paused.pauses[0].generation };
  await h.manager({ ...command, op: 'frame', frame: 0 });
  await assert.rejects(h.manager({ ...command, op: 'scope' }), /stale_stop/);
  command.generation++;
  const scope = await h.manager({ ...command, op: 'scope' }); assert.equal(scope.generation, 2);
  assert.deepEqual(scope.metadataCoverage.variableCounts,{input:0,output:1});
  assert.equal(scope.metadataCoverage.runtimeFrameBound,true);
  assert.equal(scope.metadataCoverage.runtimeValuesComplete,false);
  await h.manager({ ...command, op: 'read', reference: scope.variables[0].reference, textOffset: 4096 });
  await h.manager({ ...command, op: 'continue' });
  await assert.rejects(h.manager({ ...command, op: 'continue' }), /stale_stop/);
  const final = await h.wait(true); assert.equal(final.state, 'completed'); assert.equal(final.runResult.cleanup.completed, true);
  assert.equal(h.trace().some(l => l.functionKey === functionKey), true); assert.equal(h.trace().some(l => l.kind === 'thread-end'), true);
  assert.equal(h.calls.filter(c => c.op === 'stop').length, 1);
  const restored = createServerSessionManager({ root: h.root });
  assert.equal((await restored({ op: 'status', sessionId: h.start.sessionId })).ownerAvailable, false);
  await assert.rejects(restored({ ...command, op: 'continue' }), /owner_unavailable/);
});
test('public cancellation and runner finally share one uncertain stop without retry', async t => {
  const h = await harness(t, { uncertainStop: true }); await h.wait(false);
  await assert.rejects(h.manager({ op: 'stop', sessionId: h.start.sessionId }), /unreachable/);
  const final = await h.wait(true); assert.equal(final.state, 'uncertain');
  assert.equal(h.calls.filter(c => c.op === 'stop').length, 1);
});

test('public stop makes the preparation checkpoint refuse further work before native startup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-server-preparation-stop-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('ssam-server-preparation-stop-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let ready, release, nativeCalls = 0, advanced = false;
  const prepared = new Promise(resolve => { ready = resolve; });
  const pendingRead = new Promise(resolve => { release = resolve; });
  const manager = createServerSessionManager({ root, o11Runner: () => () => {},
    debug: async () => { nativeCalls++; },
    run: async (_, { services }) => {
      services.checkActive(); ready(); await pendingRead;
      services.checkActive(); advanced = true;
      return { ok: true, uncertain: false };
    },
  });
  const start = await manager({ ...request, run: { ...request.run, lane: 'o11' } });
  await prepared;
  await manager({ op: 'stop', sessionId: start.sessionId });
  release();
  let final;
  for (let i = 0; i < 5; i++) {
    final = await manager({ op: 'status', sessionId: start.sessionId, afterRevision: final?.revision ?? 0, waitMs: 1000 });
    if (final.state === 'failed') break;
  }
  assert.equal(final.state, 'failed');
  assert.equal(final.error, 'debug_server_session_cancelled');
  assert.equal(advanced, false); assert.equal(nativeCalls, 0);
});
test('uncertain frame consumes the public generation and model failures cannot invoke', async t => {
  const h = await harness(t, { frameTimeout: true }); await h.wait(false);
  const token = { sessionId: h.start.sessionId, threadId: 'T', eventId: '1', generation: 1 };
  await assert.rejects(h.manager({ ...token, op: 'frame', frame: 0 }), /timeout/);
  await assert.rejects(h.manager({ ...token, op: 'continue' }), /stale_stop/);
  await h.manager({ op: 'stop', sessionId: h.start.sessionId }); await h.wait(true);
  const bad = await harness(t, { modelError: true }); const failed = await bad.wait(true);
  assert.equal(failed.error, 'debug_native_scope_source_changed'); assert.deepEqual(bad.calls, []); assert.deepEqual(bad.phases, []);
});
test('ODC original Timer watch becomes interactive with only its pinned background scope', { skip: foreignPendingReason('timer-background') }, async t => {
  const h = await harness(t, {lane:'odc',background:true});
  const paused = await h.wait(false), started = h.calls.find(c=>c.op==='start');
  assert.equal(started.autoContinue,false);assert.equal(started.trace,undefined);
  assert.deepEqual(h.contexts[h.calls.indexOf(started)], {backgroundWatch:true,contextMode:'native-background',
    backgroundInspection:{moduleKey,functionKey,functionKeys:[functionKey],sourceSha256:'a'.repeat(64)}});
  const token={sessionId:h.start.sessionId,threadId:'T',eventId:'1',generation:paused.pauses[0].generation};
  assert.equal((await h.manager({...token,op:'scope'})).ok,true);
  await h.manager({...token,op:'continue'});
  assert.equal((await h.wait(true)).state,'completed');
  const run={...request.run,contextMode:'native-background',launch:{contextMode:'app-user',inputs:{}},words:'Run diagnostic Timer'};
  assert.equal(schema.safeParse({...request,run}).success,true);
  for(const extra of [{workflow:{module:'Foreign'}},{launch:{contextMode:'anonymous',inputs:{}}},{launch:{contextMode:'app-user',inputs:{Seed:1}}}])
    assert.equal(schema.safeParse({...request,run:{...run,...extra}}).success,false);
});
test('public server schema refuses replacement adapters, caller metadata and unrelated operations', () => {
  assert.equal(schema.safeParse(request).success, true);
  for (const patch of [{ run: { ...request.run, execution: 'rest-wrapper' } }, { run: { ...request.run, trace: 'none' } },
    { inspection: { variables: [] } }, { scopes: [scopes[0], scopes[0]] }])
    assert.equal(schema.safeParse({ ...request, ...patch }).success, false);
  for (const lane of ['o11','odc']) assert.equal(schema.safeParse({ ...request,
    run: { ...request.run, lane, contextMode:'anonymous' } }).success, true);
  let name;
  registerServerSessionTool({ registerTool(value) { name = value; } }, debugRunToolSchema, x => x);
  assert.equal(name, 'ssam_debug_server');
});
for (const lane of ['o11', 'odc']) test(lane + ': newly observed action/node gets its native scope from the same pinned model', async t => {
  const nextNode = 'E'.repeat(22), nextFunction = 'F'.repeat(22);
  const h = await harness(t, { lane, lazyNode: nextNode, lazyFunction: nextFunction }); await h.wait(false);
  const command = { sessionId: h.start.sessionId, threadId: 'T', eventId: '1', generation: 1 };
  const scope = await h.manager({ ...command, op: 'scope' });
  assert.equal(scope.metadataBound, true); assert.equal(scope.generation, 2);
  assert.deepEqual(h.modelReads[1].scopes, [{ functionKey: nextFunction, nodeKeys: [nextNode] }]);
  assert.equal(h.bindings[0].scopeUpdate.variables[0].functionKey, nextFunction);
  assert.equal(h.bindings[0].scopeUpdate.nodeKey, nextNode);
  await assert.rejects(h.manager({ ...command, op: 'read', reference: scope.variables[0].reference }), /stale_stop/);
  await h.manager({ ...command, generation: 2, op: 'scope' });
  assert.equal(h.modelReads.length, 2); assert.equal(h.bindings.length, 1);
  const frame = await h.manager({ ...command, generation: 2, op: 'frame', frame: 0 });
  assert.equal(frame.generation, 3); assert.equal(h.bindings.length, 1);
  await h.manager({ ...command, generation: 3, op: 'continue' }); await h.wait(true);
});
test('lazy binding refuses foreign module or changed capture before sending addresses', async t => {
  for (const options of [{ foreignModule: 'G'.repeat(22) }, { lazyReadFailure: true }]) {
    const h = await harness(t, { lazyNode: 'E'.repeat(22), ...options }); await h.wait(false);
    await assert.rejects(h.manager({ op: 'scope', sessionId: h.start.sessionId, threadId: 'T', eventId: '1', generation: 1 }),
      options.foreignModule ? /producer_model_required/ : /source_changed/);
    assert.equal(h.bindings.length, 0);
  }
});
test('uncertain lazy binding consumes generation and is reconciled by scope without replay', async t => {
  const h = await harness(t, { lazyNode: 'E'.repeat(22), bindTimeout: true }); await h.wait(false);
  const command = { sessionId: h.start.sessionId, threadId: 'T', eventId: '1', generation: 1 };
  await assert.rejects(h.manager({ ...command, op: 'scope' }), /command_uncertain/);
  await assert.rejects(h.manager({ ...command, op: 'continue' }), /stale_stop/);
  const scope = await h.manager({ ...command, generation: 2, op: 'scope' });
  assert.equal(scope.metadataBound, true); assert.equal(h.bindings.length, 1);
  await h.manager({ ...command, generation: 2, op: 'continue' }); await h.wait(true);
});
test('a runner-pinned foreign frame uses its own capture and changed bytes refuse before login',async t=>{
 const foreignModule='G'.repeat(22);
 const h=await harness(t,{lazyNode:'E'.repeat(22),foreignModule,pinnedForeign:true});await h.wait(false);
 const scope=await h.manager({op:'scope',sessionId:h.start.sessionId,threadId:'T',eventId:'1',generation:1});
 assert.equal(scope.metadataBound,true);assert.equal(h.bindings[0].scopeUpdate.moduleKey,foreignModule);
 assert.equal(h.bindings[0].scopeUpdate.sourceSha256,createHash('sha256').update('consumer').digest('hex'));
 assert.equal(h.calls.find(c=>c.op==='start').inspection.sources.length,2);
 await h.manager({op:'continue',sessionId:h.start.sessionId,threadId:'T',eventId:'1',generation:scope.generation});await h.wait(true);
 const bad=await harness(t,{foreignModule,pinnedForeign:true,changedForeign:true});
 assert.equal((await bad.wait(true)).error,'debug_server_session_model_source_changed');assert.deepEqual(bad.phases,[]);assert.deepEqual(bad.calls,[]);
});
test('manual pause uses current running revision, consumes it once and never claims an observed stop',async t=>{
 for(const pauseTimeout of [false,true]){
  const h=await harness(t,{startRunning:true,pauseTimeout});let running;
  for(let i=0;i<30;i++){running=await h.manager({op:'status',sessionId:h.start.sessionId,waitMs:100,afterRevision:running?.revision});if(running.state==='running')break;}
  assert.equal(running.state,'running');
  const command=schema.parse({op:'pause',sessionId:h.start.sessionId,afterRevision:running.revision});
  if(pauseTimeout)await assert.rejects(h.manager(command),/uncertain/);
  else{const result=await h.manager(command);assert.equal(result.pauseObserved,false);assert.equal(result.pauseRequest.requested,true);}
  await assert.rejects(h.manager(command),/pause_requires_current_running_revision/);
  assert.equal(h.calls.filter(c=>c.op==='pause').length,1);
  const state=await h.manager({op:'status',sessionId:h.start.sessionId});assert.equal(state.pauseRequest.requested,true);
 }
 assert.equal(schema.safeParse({op:'pause',sessionId:'11111111-1111-4111-8111-111111111111'}).success,false);
});
test('native stop observation settles a requested pause and exposes fresh inspection tokens', async t => {
  const h = await harness(t, { startRunning: true });
  let state = h.start;
  for (let i = 0; i < 30 && state.state !== 'running'; i++)
    state = await h.manager({ op: 'status', sessionId: h.start.sessionId, afterRevision: state.revision, waitMs: 100 });
  const requested = await h.manager({ op: 'pause', sessionId: h.start.sessionId, afterRevision: state.revision });
  assert.equal(requested.pauseObserved, false);
  h.observePause();
  const paused = await h.wait(false);
  assert.equal(paused.pauseRequest.requested, false);
  assert.ok(paused.revision > requested.revision);
  const token = { sessionId: h.start.sessionId, threadId: 'T', eventId: '1', generation: paused.pauses[0].generation };
  assert.equal((await h.manager({ op: 'scope', ...token })).ok, true);
  await assert.rejects(h.manager({ op: 'pause', sessionId: h.start.sessionId, afterRevision: paused.revision }), /pause_requires_current_running_revision/);
  await h.manager({ op: 'continue', ...token });
  assert.equal((await h.wait(true)).state, 'completed');
  assert.equal(h.calls.filter(c => c.op === 'pause').length, 1);
});
test('previous watches use only the native previous breakpoint and are pinned in scope binding', async t => {
  const previousNode = 'H'.repeat(22);
  const h = await harness(t, { lazyNode: 'E'.repeat(22), previousNode }); await h.wait(false);
  const token = { sessionId: h.start.sessionId, threadId: 'T', eventId: '1', generation: 1 };
  const scope = await h.manager({ op: 'scope', ...token });
  assert.equal(h.modelReads[1].scopes[0].previousNodeKey, previousNode);
  assert.equal(h.bindings[0].scopeUpdate.previousNodeKey, previousNode);
  await h.manager({ op: 'continue', ...token, generation: scope.generation }); await h.wait(true);
  const bad = await harness(t, { lazyNode: 'E'.repeat(22), previousNode, previousModule: 'J'.repeat(22) }); await bad.wait(false);
  await assert.rejects(bad.manager({ op: 'scope', ...token, sessionId: bad.start.sessionId }), /native_previous_scope_context_unavailable/);
  assert.equal(bad.bindings.length, 0); assert.equal(bad.modelReads.length, 1);
});

test('O11 initial scopes preserve each runner-pinned module and source in native metadata', async t => {
 const foreignModule='E'.repeat(22), foreignFunction='F'.repeat(22), foreignNode='G'.repeat(22);
 const h=await harness(t,{lane:'o11',pinnedForeign:true,foreignModule,
  scopes:[...scopes,{moduleKey:foreignModule,functionKey:foreignFunction,nodeKeys:[foreignNode]}]});
 await h.wait(false);
 assert.deepEqual(h.modelReads.map(r=>r.moduleKey),[moduleKey,foreignModule]);
 assert.notEqual(h.modelReads[0].directory,h.modelReads[1].directory);
 const started=h.calls.find(c=>c.op==='start');
 assert.deepEqual(started.nodeKeys,[nodeKey,foreignNode]);
 assert.deepEqual(started.inspection.scopes.map(s=>[s.moduleKey,s.functionKey,s.nodeKey]),
  [[moduleKey,functionKey,nodeKey],[foreignModule,foreignFunction,foreignNode]]);
 assert.equal(started.inspection.scopes[1].sourceSha256,createHash('sha256').update('consumer').digest('hex'));
 assert.deepEqual(started.inspection.variables.map(v=>v.moduleKey),[moduleKey,foreignModule]);
});
test('O11 refuses an initial breakpoint in an unpinned module before sign-in or native start',async t=>{
 const h=await harness(t,{lane:'o11',scopes:[...scopes,{moduleKey:'E'.repeat(22),functionKey:'F'.repeat(22),nodeKeys:['G'.repeat(22)]}]});
 const result=await h.wait(true);assert.equal(result.state,'failed');assert.match(result.error,/producer_model_required/);
 assert.deepEqual(h.phases,[]);assert.equal(h.calls.some(c=>c.op==='start'),false);
});
test('ODC explicit initial owners: one consumer owner only, refused at binding without the runner owner map',async t=>{
 const consumer='E'.repeat(22),consumerScope={moduleKey:consumer,functionKey:'F'.repeat(22),nodeKeys:['G'.repeat(22)]};
 assert.equal(schema.safeParse({...request,scopes:[...scopes,consumerScope]}).success,true);
 assert.equal(schema.safeParse({...request,scopes:[...scopes,consumerScope,{...consumerScope,moduleKey:'H'.repeat(22),nodeKeys:['I'.repeat(22)]}]}).success,false);
 assert.equal(schema.safeParse({...request,scopes:[{...scopes[0],functionKey:functionKey+'.#Preparation'}]}).success,false);
 // The runner did not declare the node with that consumer (no library-reference pair): refused before any native start.
 const h=await harness(t,{pinnedForeign:true,foreignModule:consumer,scopes:[...scopes,consumerScope]});
 const done=await h.wait(true);
 assert.equal(done.state,'failed');assert.equal(done.error,'debug_server_session_breakpoint_owner_unqualified');
 assert.equal(h.calls.some(c=>c.op==='start'),false);
});

test('paired O11 coordinator uses the owning native ID for scope binding, private reads and steps',async t=>{
 const foreignModule='E'.repeat(22),foreignFunction='F'.repeat(22),foreignNode='G'.repeat(22);
 const h=await harness(t,{lane:'o11',group:true,pinnedForeign:true,foreignModule,lazyNode:'H'.repeat(22),
  scopes:[...scopes,{moduleKey:foreignModule,functionKey:foreignFunction,nodeKeys:[foreignNode]}]});
 let paused=await h.wait(false);assert.equal(paused.pauses.length,1);assert.equal(paused.pauses[0].nativeSessionId,'c'.repeat(32));
 assert.equal(paused.nativeGroup.members.length,2);
 const token={sessionId:h.start.sessionId,threadId:'T',eventId:'1',generation:paused.pauses[0].generation};
 const scope=await h.manager({...token,op:'scope'});assert.equal(scope.nativeSessionId,'c'.repeat(32));assert.equal(h.bindings[0].sessionId,'c'.repeat(32));
 token.generation=scope.generation;
 await h.manager({...token,op:'private-read',reference:'b'.repeat(32)});
 assert.equal(h.calls.find(c=>c.op==='private-read').sessionId,'c'.repeat(32));
 await h.manager({...token,op:'step-into'});assert.equal(h.calls.find(c=>c.op==='step-into').sessionId,'c'.repeat(32));
 await assert.rejects(h.manager({...token,op:'step-into'}),/stale_stop/);
 const ended=await h.wait(true);assert.equal(ended.state,'completed');assert.equal(ended.nativeGroup.members.every(m=>m.stop.state==='stopped'),true);
 assert.equal(h.calls.filter(c=>c.op==='stop').length,2);
});
