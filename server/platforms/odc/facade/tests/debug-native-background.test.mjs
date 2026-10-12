import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { prepareNativeBackground, createNativeBackgroundAdapter, observeNativeBackground, nativeBackgroundServiceCenter } from '../debug-native-background.mjs';

const key = c => c.repeat(22), operationId = '11111111-2222-4333-8444-555555555555';
function fixture(kind = 'Timer', lane = 'o11') {
  const binding = { lane, runtimeUrl: 'https://dev.example.test/Store/', module: 'Store', moduleKey: key('a'), revision: 42, sourceSha256: 'e'.repeat(64) };
  const model = { schema: 'ssam-reading/1', model: 'Store', sourceSha256: binding.sourceSha256,
    tree: { key: key('b'), kind, name: 'Nightly', children: [], childrenOmitted: 0, childrenTotal: 0,
      propertyReferences: { Action: { key: key('c') } }, propertyErrors: {}, propertiesOmitted: {}, propertiesMissing: [] } };
  return prepareNativeBackground({ binding, model, entryKey: key('b'), moduleId: 7 });
}
const receipt = { operationId, ok: true, state: 'accepted', executionCompleted: false,
  identity: { host: 'dev.example.test', moduleId: '7', name: 'Nightly', action: 'timer-run' } };

test('native background transport unwraps the real lane envelope and preserves uncertain receipts',async()=>{
 const input={action:'timer-run',host:'dev.example.test',moduleId:'7',name:'Nightly'};
 const prepared={...input,execute:false};
 const runLane=async(lane,verb,args)=>{assert.equal(lane,'o11');assert.equal(verb,'service-center');assert.ok(!args.includes('--execute'));
  return {ok:true,lane,verb,result:prepared};};
 const adapter=createNativeBackgroundAdapter({serviceCenter:i=>nativeBackgroundServiceCenter(i,runLane)});
 assert.equal((await adapter.prepare(fixture())).nativeAuthenticationQualified,true);
 const uncertain={...receipt,ok:false,state:'uncertain'};
 assert.deepEqual(await nativeBackgroundServiceCenter(input,async()=>({ok:false,lane:'o11',verb:'service-center',result:uncertain})),uncertain);
});
test('native background auth refusal stays specific and does not expose native error text',async()=>{
 const reply=error=>({ok:false,lane:'o11',verb:'service-center',result:{ok:false,error}});
 await assert.rejects(nativeBackgroundServiceCenter({action:'timer-run'},async()=>reply('Service Center requires OutSystems ID SSO; details')),/native_service_center_sso_unqualified/);
 await assert.rejects(nativeBackgroundServiceCenter({action:'timer-run'},async()=>reply('private transport detail')),e=>e.message==='debug_native_background_native_service_center_failed');
 await assert.rejects(nativeBackgroundServiceCenter({action:'timer-run'},async()=>({ok:true,result:{}})),/response_invalid/);
});

test('O11 timer uses native background context; BPT and ODC workflow contracts stay distinct', () => {
  const plan = fixture(); assert.equal(plan.executable, true); assert.equal(plan.applicationUserContext, false);
  assert.equal(plan.actionKey, key('c')); assert.equal(plan.nativeAuthenticationQualified, false);
  assert.equal(fixture('Process').error, 'debug_native_background_bpt_requires_original_launch_or_existing_instance');
  assert.equal(fixture('Process', 'odc').error, 'debug_native_background_odc_bpt_not_in_product');
  assert.equal(fixture('ServerAction', 'odc').error, 'debug_native_background_odc_workflow_requires_original_event_or_instance');
  assert.equal(fixture('Timer', 'odc').error, 'debug_native_background_odc_timer_target_binding_required');
});

test('scheduler acceptance or an unrelated target frame is never completion', () => {
  const plan = fixture(), first = observeNativeBackground(plan, receipt);
  assert.equal(first.scheduled, true); assert.equal(first.executionCompleted, false); assert.equal(first.outcome, 'scheduled');
  const second = observeNativeBackground(plan, receipt, { events: [{ functionKey: key('c'), userName: 'developer' }, { kind: 'thread-end' }] });
  assert.equal(second.executionObserved, false); assert.equal(second.requestOwnershipProved, false);
});

test('accepted-unverified is a submitted uncertainty, never a safe failure or confirmed schedule',()=>{
 const observation=observeNativeBackground(fixture(),{...receipt,ok:false,state:'accepted-unverified'});
 assert.equal(observation.outcome,'uncertain');assert.equal(observation.accepted,false);
 assert.equal(observation.scheduled,false);assert.equal(observation.executionCompleted,false);
});

const FP = 'a'.repeat(64);
const threadOutcome = (ended = true, fingerprint = FP) => ({ captured: true, traceVerified: ended, requestFingerprintConsistent: true,
  fingerprints: [fingerprint], endedFingerprints: ended ? [fingerprint] : [], requestBound: ended, executionCompleted: false });
const instance = over => ({ state: 'correlated', instanceCorrelationProved: true, matchedFingerprint: FP, requestKeySha256: FP,
  outcome: 'completed', executionCompleted: true, newExactTimerRowObserved: true, errorBound: false, ...over });
const evidence = (plan, over = {}) => ({ entryKey: plan.entryKey, moduleKey: plan.binding.moduleKey, sourceSha256: plan.binding.sourceSha256,
  threadOutcome: threadOutcome(), instance: instance(), ...over });

test('timer completion contract is the request fingerprint plus Service Center RequestKey, never nativeExecutionId', () => {
  const plan = fixture();
  assert.equal(plan.completionEvidenceRequired, 'service-center-request-key-sha256-and-request-bound-thread-end');
  const completed = observeNativeBackground(plan, receipt, evidence(plan));
  assert.equal(completed.outcome, 'completed'); assert.equal(completed.executionCompleted, true); assert.equal(completed.instanceCorrelationProved, true);
  assert.equal(completed.executionObserved, true); assert.equal(completed.newExactTimerRowObserved, true);
  assert.equal(completed.requestKeySha256, FP); assert.equal(completed.requestOwnershipProved, false); assert.equal(completed.appUserIdentityProved, false);
  const failed = observeNativeBackground(plan, receipt, evidence(plan, { instance: instance({ outcome: 'failed', errorBound: true, retryScheduled: true }) }));
  assert.equal(failed.outcome, 'failed'); assert.equal(failed.executionCompleted, true); assert.equal(failed.retryScheduled, true);
  // The legacy never-produced execution id proves nothing.
  const legacy = { requestOwnershipProved: true, nativeExecutionId: 'native-123', entryKey: plan.entryKey, moduleKey: plan.binding.moduleKey,
    sourceSha256: plan.binding.sourceSha256, events: [{ functionKey: plan.actionKey, nativeExecutionId: 'native-123' }, { kind: 'thread-end', nativeExecutionId: 'native-123', success: true }] };
  assert.equal(observeNativeBackground(plan, { ...receipt, nativeExecutionId: 'native-123' }, legacy).executionCompleted, false);
  // A new exact cyclic-job row is not attributed to this request: executionObserved stays false without correlation.
  const unattributed = observeNativeBackground(plan, receipt, evidence(plan, { instance: instance({ instanceCorrelationProved: false }) }));
  assert.equal(unattributed.newExactTimerRowObserved, true); assert.equal(unattributed.executionObserved, false);
  const unaccepted = observeNativeBackground(plan, { ...receipt, ok: false, state: 'accepted-unverified' }, evidence(plan));
  assert.equal(unaccepted.executionObserved, false);
  for (const changed of [evidence(plan, { threadOutcome: threadOutcome(false) }), evidence(plan, { instance: instance({ matchedFingerprint: 'b'.repeat(64) }) }),
    evidence(plan, { instance: instance({ instanceCorrelationProved: false }) }), evidence(plan, { moduleKey: key('z') }),
    evidence(plan, { instance: instance({ outcome: 'failed', errorBound: false }) })]) {
    const result = observeNativeBackground(plan, receipt, changed);
    assert.equal(result.executionCompleted, false, JSON.stringify(changed)); assert.notEqual(result.outcome, 'completed');
  }
  // A correlated run never upgrades an uncertain submission.
  const uncertain = observeNativeBackground(plan, { ...receipt, ok: false, state: 'accepted-unverified' }, evidence(plan));
  assert.equal(uncertain.outcome, 'uncertain'); assert.equal(uncertain.executionCompleted, false);
});

test('reconcile reads only the receipt and applies the correlation evidence without triggering', async () => {
  const calls = [], plan = fixture(), adapter = createNativeBackgroundAdapter({ serviceCenter: async input => { calls.push(input); return receipt; } });
  const result = await adapter.reconcile({ ...plan, nativeAuthenticationQualified: true }, operationId, evidence(plan));
  assert.equal(result.ok, true); assert.equal(result.outcome, 'completed'); assert.equal(result.replayed, false);
  assert.deepEqual(calls.map(c => [c.action, c.execute]), [['receipt', undefined]]);
  assert.equal((await adapter.reconcile(plan, operationId, evidence(plan, { instance: instance({ instanceCorrelationProved: false }) }))).ok, false);
});

test('timer prepare is read-only, execute requires explicit background authorization, reconcile never triggers', async () => {
  const calls = [], adapter = createNativeBackgroundAdapter({ serviceCenter: async input => {
    calls.push(input);
    if (input.action === 'receipt' || input.execute) return receipt;
    return { host: input.host, action: input.action, moduleId: input.moduleId, name: input.name, execute: false,
      target: 'https://dev.example.test/ServiceCenter/eSpace_Timer.aspx', control: 'RunNow' };
  } });
  const prepared = await adapter.prepare(fixture()); assert.equal(calls[0].execute, undefined);
  await assert.rejects(adapter.run(prepared, { root: os.tmpdir(), operationId, context: 'app-user', authorizationWords: 'run timer' }), /explicit_background_authorization_required/);
  assert.equal(calls.length, 1);
  const result = await adapter.run(prepared, { root: os.tmpdir(), operationId, context: 'native-background', authorizationWords: 'run timer' });
  assert.equal(result.ok, false); assert.equal(result.scheduled, true); assert.equal(result.executionCompleted, false);
  assert.equal(calls[1].action, 'timer-run'); assert.equal(calls[1].execute, true);
  await adapter.reconcile(prepared, operationId); assert.equal(calls[2].action, 'receipt'); assert.equal(calls[2].execute, undefined);
});
