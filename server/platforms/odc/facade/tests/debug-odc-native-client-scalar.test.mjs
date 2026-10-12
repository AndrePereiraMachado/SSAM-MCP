import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifyScalarClientModel,qualifyScalarClientRuntime} from '../debug-odc-native-client-scalar.mjs';
import {nativeWireOutput} from '../debug-native-wire-output.mjs';
const node=(kind,key,extra={})=>({kind,key,children:[],properties:{},...extra});
const tree=node('ClientAction','action',{children:[
 node('InputParameter','input',{name:'Seed',properties:{DataType:'BasicType:Integer'}}),
 node('LocalVariable','local',{name:'Observed',properties:{DataType:'BasicType:Integer'}}),
 node('OutputParameter','output',{name:'Result',properties:{DataType:'BasicType:Integer'}}),
 node('StartNode','start',{propertyReferences:{Target:{key:'a'}}}),
 node('AssignNode','a',{propertyReferences:{Target:{key:'b'}},children:[node('Assignment','aa',{properties:{Variable:'Observed',Value:'Seed + 1'}})]}),
 node('AssignNode','b',{propertyReferences:{Target:{key:'end'}},children:[node('Assignment','bb',{properties:{Variable:'Result',Value:'Observed * 2'}})]}),
 node('EndNode','end')]});
const prepared={action:{key:'action',name:'Compute'},entry:{key:'action'},path:[{key:'action'}],bindings:[{control:'direct',entryInput:'Seed',targetInput:'Seed'}]};
const plan={member:{key:'action',chunk:'app.js',holder:{kind:'function',local:'compute'},moduleController:'controller',varsGroup:'vars',outVarsGroup:'outs'},endpoints:{},inputs:[{name:'Seed',position:0}],outputs:[{name:'Result'}]};
const runtime={index:{groups:{vars:[{chunk:'app.js',attributes:[{name:'Seed',attrName:'seedInLocal',dataType:'Integer'},{name:'Observed',attrName:'observedVar',dataType:'Integer'}]}],outs:[{chunk:'app.js',attributes:[{name:'Result',attrName:'resultOut',dataType:'Integer'}]}]},chunks:{'core.js':{keepNames:{holder:'VariableHolder'}}}},pins:{'app.js':{sha256:'a'.repeat(64)},'core.js':{sha256:'b'.repeat(64)}}};
const source=`import {core, telemetry} from './core.js';
function compute(seed,context){var bag={};return telemetry.startActiveSpan("Compute",function(span){
try{context=controller.callContext(context);
var locals=new core.VariableHolder(new(controller.constructor.getVariableGroupType("vars")));
locals.value.seedInLocal=seed;
var outputs=new core.VariableHolder(new(controller.constructor.getVariableGroupType("outs")));
bag.callContext=context;bag.vars=locals;bag.outVars=outputs;
try{OutSystemsDebugger.push("action",context.id,bag);
OutSystemsDebugger.handleBreakpoint("start",context.id);
locals.value.observedVar=locals.value.seedInLocal+1;
outputs.value.resultOut=locals.value.observedVar*2;
return outputs.value;}finally{OutSystemsDebugger.pop("action",context.id);}
}finally{span&&span.end();}},1);}`;
const qualify=(code=source,modelTree=tree)=>qualifyScalarClientRuntime(prepared,runtime,qualifyScalarClientModel(modelTree),plan,{'app.js':code});
test('already projected output preserves List and EmptyListItem business fields and full strings',()=>{
 const value={List:Array.from({length:1001},(_,i)=>i),EmptyListItem:'business',Text:'Ω'.repeat(9004)};
 assert.deepEqual(nativeWireOutput(value,[],{unwrapLists:false}),value);
 assert.deepEqual(nativeWireOutput({Password:'hidden','private-key':'hidden',Text:'value private-key'},['private-key'],{unwrapLists:false}),
  {Password:'[private]',Text:'value [private]'});
});
test('qualifies original numeric assignments structurally without executing code',()=>{
 const result=qualify();assert.equal(result.originalEntry,true);assert.equal(result.invocationNetworkAllowed,false);
 assert.equal(result.classification,'native-scalar-local-assignments');assert.equal(result.model.assignments.length,2);
});
test('refuses extra calls, foreign writes, mismatched expressions and debugger holder swaps',()=>{
 for(const change of [
  s=>s.replace('return outputs.value;','fetch("https://invalid.test");return outputs.value;'),
  s=>s.replace('return outputs.value;','globalThis.changed=1;return outputs.value;'),
  s=>s.replace('seedInLocal+1','seedInLocal+2'),
  s=>s.replace('bag.vars=locals','bag.vars=outputs'),
  s=>s.replace('return outputs.value;','new Foreign();return outputs.value;'),
  s=>s.replace('seedInLocal+1','Math.abs(locals.value.seedInLocal)'),
 ])assert.throws(()=>qualify(change(source)),/scalar_unqualified/);
});
test('refuses incomplete models, cycles, non-integer declarations and foreign expressions',()=>{
 for(const change of [
  t=>t.childrenOmitted=1,
  t=>t.children[4].propertyReferences.Target.key='a',
  t=>t.children[0].properties.DataType='BasicType:Text',
  t=>t.children[4].children[0].properties.Value='Foreign + 1',
  t=>t.children[4].children[0].properties.Value='Seed; fetch()'
 ]){const candidate=structuredClone(tree);change(candidate);assert.throws(()=>qualify(source,candidate),/scalar_unqualified/);}
});
