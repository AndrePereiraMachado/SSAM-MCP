import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nativeO11Timer } from '../debug-o11-timer.mjs';
import { graphFromReadings, buildO11CallGraph, resolveO11Entry } from '../debug-o11-entry-graph.mjs';
import { prepareO11BptObservation } from '../debug-o11-bpt-run.mjs';

// Native local candidate04, an authorized technical fixture; no DEV execution.
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/debug-o11-timer-wake-native-reading.json',import.meta.url),'utf8'));
const timerKey='rb3sLlRkGka3ljKEMMzqtw',actionKey='uWaXOn_nZk606RgznzjCew';
const readings=()=>structuredClone(fixture.readings);
const graph=r=>buildO11CallGraph([graphFromReadings(r,fixture)]);

test('native Wake signature resolves SOAP→Wake→Timer→body as asynchronous execution',()=>{
  const r=readings(),g=graph(r),timer=r.find(n=>n.kind==='Timer');
  assert.equal(nativeO11Timer(timer).wakeActionKey,timerKey+'.#WakeTimer');
  for(const target of ['ProbeTimer','ProbeTimerAction']){
    const resolved=resolveO11Entry(g,target);
    assert.equal(resolved.state,'background-trigger-resolved');
    assert.equal(resolved.background.kind,'timer-original-wake');
    assert.equal(resolved.background.timerKey,timerKey);
    assert.equal(resolved.originalLaunch.entry.name,'WakeTimer');
    assert.equal(resolved.originalLaunch.target.key,timerKey+'.#WakeTimer');
    assert.equal(resolved.background.executionCompleted,false);
    assert.deepEqual(resolved.path.map(n=>n.kind),target==='ProbeTimer'
      ? ['WebServiceMethod','TimerWakeAction','Timer'] : ['WebServiceMethod','TimerWakeAction','Timer','ServerAction']);
  }
});

test('missing native Wake proof cannot be replaced by suffix or an arbitrary action signature',()=>{
  for(const change of [timer=>{delete timer.propertyReferences.WakeTimerAction;},
    timer=>{timer.childrenOmitted=1;},timer=>{timer.children[0].propertyReferenceCollections.InputParameters.total=1;},
    timer=>{timer.propertyReferences.WakeTimerAction.key='Z'.repeat(22)+'.#WakeTimer';}]){
    const r=readings(),timer=r.find(n=>n.kind==='Timer');change(timer);
    assert.throws(()=>nativeO11Timer(timer),/debug_native_background_timer_/);
    assert.equal(resolveO11Entry(graph(r),'ProbeTimerAction').state,'no-invocable-entry');
  }
});

test('a direct synchronous caller takes precedence and never masquerades as a timer wake',()=>{
  const r=readings(),action=r.find(n=>n.kind==='ServerAction');
  r.push({kind:'RestServiceAction',key:'R'.repeat(22),name:'Direct',properties:{},children:[{kind:'ExecuteServerActionNode',key:'C'.repeat(22),
    propertyReferences:{Action:{key:action.key,kind:action.kind,name:action.name}},children:[]}]});
  const resolution=resolveO11Entry(graph(r),'ProbeTimerAction');
  assert.equal(resolution.state,'resolved');assert.equal(resolution.entry.name,'Direct');assert.equal(resolution.background,undefined);
});

test('Timer selector scopes the scheduled body while preserving explicit background and original-entry inputs',t=>{
  const r=readings(),g=graph(r),root=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-timer-wake-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'source.oml');fs.writeFileSync(file,JSON.stringify(fixture));
  const digest=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const target={module:fixture.module,moduleKey:fixture.moduleKey,applicationKey:'A'.repeat(22),host:'dev.example',runtimeUrl:'https://dev.example/SSAMDebuggerProbe/'};
  const owner={target,versionId:2,snapshot:{path:file,sha256:digest},readings:r};
  for(const action of ['ProbeTimer','ProbeTimerAction']){
    const args={input:{contextMode:'native-background',launch:{contextMode:'anonymous',inputs:{}}},target,
      resolution:resolveO11Entry(g,action),graph:g,captures:[owner]};
    const {plan}=prepareO11BptObservation(args);
    assert.equal(plan.kind,'timer-original-wake');assert.equal(plan.targetKey,actionKey);
    assert.equal(plan.schedulerActionKey,actionKey);assert.deepEqual(plan.scopes,{[actionKey]:['Tick']});
    assert.equal(plan.appUserIdentityProved,false);assert.equal(plan.executionCompleted,false);assert.equal(plan.requestOwnershipProved,false);
    assert.throws(()=>prepareO11BptObservation({...args,input:{...args.input,inputs:{Tick:1}}}),/ambiguous_activity_inputs/);
    assert.throws(()=>prepareO11BptObservation({...args,input:{...args.input,contextMode:'anonymous'}}),/explicit_background_context_required/);
  }
  const edge=g.edges.find(e=>e.via.kind==='timer-wake');edge.via.asynchronous=false;
  assert.throws(()=>prepareO11BptObservation({input:{contextMode:'native-background',launch:{contextMode:'anonymous',inputs:{}}},target,
    resolution:{...resolveO11Entry(graph(r),'ProbeTimer'),},graph:g,captures:[owner]}),/native_timer_path_unproved/);
});
