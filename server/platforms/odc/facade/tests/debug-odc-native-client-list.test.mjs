import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {qualifyClientListModel,qualifyClientListRuntime} from '../debug-odc-native-client-list.mjs';

// Local contract fixtures, not a claim of live execution.
const hash=s=>createHash('sha256').update(s).digest('hex');
const node=(kind,key,extra={})=>{const n={kind,key,properties:{},children:[],...extra};return {...n,childrenTotal:n.children.length};};
function modelTree(){
 const argument=(name,value)=>node('Argument',name,{name,properties:{Value:value}});
 const call=(name,key)=>node('ExecuteClientActionNode',key,{propertyReferences:{Action:{kind:'ClientActionSignature',name,key:name,path:'Reference:(System)/ClientActionSignature:'+name}},children:[argument('List','Result'),...(name==='ListAppend'?[argument('Element','Source.Current')]:[])]});
 return node('ClientAction','entry',{children:[
  node('InputParameter','input',{name:'Source',propertyReferences:{DataType:{kind:'ListType'}}}),
  node('OutputParameter','output',{name:'Result',propertyReferences:{DataType:{kind:'ListType'}}}),
  node('StartNode','start'),call('ListClear','clear'),
  node('ForEachNode','loop',{properties:{RecordList:'Source'}}),call('ListAppend','append'),node('EndNode','end')]});
}
const app=`import {types, spans, lists} from './core.js';
function original(input,context){var bag={};return spans.startActiveSpan('Copy',function(span){try{
 context=controller.callContext(context);
 var vars=new types.VariableHolder(new(controller.constructor.getVariableGroupType('Copy$vars')));
 vars.value.sourceInLocal=input.clone();
 var outputs=new types.VariableHolder(new(controller.constructor.getVariableGroupType('Copy$outVars')));
 bag.callContext=context;bag.vars=vars;bag.outVars=outputs;
 OutSystemsDebugger.push('entry',context.id,bag);
 OutSystemsDebugger.handleBreakpoint('module:start',context.id);
 OutSystemsDebugger.handleBreakpoint('module:clear',context.id);lists.listClear(outputs.value.resultOut,context);
 context.iterationContext.registerIterationStart(vars.value.sourceInLocal);
 try{for(var iterator=context.iterationContext.getIterator(vars.value.sourceInLocal),i=0;
 OutSystemsDebugger.handleBreakpoint('module:loop',context.id)&&i<vars.value.sourceInLocal.length;){
 iterator.currentRowNumber=i;OutSystemsDebugger.handleBreakpoint('module:append',context.id);
 lists.listAppend(outputs.value.resultOut,vars.value.sourceInLocal.getItem(i.valueOf()),context);i++;
 }}finally{context.iterationContext.registerIterationEnd(vars.value.sourceInLocal)}
 OutSystemsDebugger.handleBreakpoint('module:end',context.id);OutSystemsDebugger.pop('entry',context.id);return outputs.value;
 }finally{span&&span.end();}},1);}`;
const core=`function append(list,item,context){list.append(item)}
function clear(list,context){list.clear()}
var namespace=Object.freeze({listAppend:append,listClear:clear});`;
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'client-list-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const tree=modelTree(),prepared={action:{key:'entry',name:'Copy',kind:'ClientAction',inputs:[{name:'Source',key:'input'}]},entry:{key:'entry'},path:[{key:'entry'}],
  effects:['unknown-call'],effectEvidence:['ListClear','ListAppend'].map(actionKey=>({actionKey,kind:'ExecuteClientActionNode'})),
  runtimeRequestKeys:['entry','ListClear','ListAppend'],bindings:[{control:'direct',entryInput:'Source',targetInput:'Source'}]};
 const runtime={pins:{},index:{functions:{entry:[{key:'entry',type:'CLIENT_ACTION',chunk:'app.js',holder:{kind:'function',local:'original',name:'original'},moduleController:'controller',varsGroup:'Copy$vars',outVarsGroup:'Copy$outVars'}]},
  groups:{'Copy$vars':[{chunk:'app.js',attributes:[{name:'Source',attrName:'sourceInLocal',dataType:'RecordList'}]}],
   'Copy$outVars':[{chunk:'app.js',attributes:[{name:'Result',attrName:'resultOut',dataType:'RecordList'}]}]},
  chunks:{'core.js':{keepNames:{holder:'VariableHolder',append:'listAppend',clear:'listClear'},exports:{types:'types',spans:'spans',lists:'namespace'}}}}};
 const write=(name,source)=>{const file=path.join(directory,name);fs.writeFileSync(file,source);runtime.pins[name]={path:file,sha256:hash(source)};};
 write('app.js',app);write('core.js',core);
 return {tree,prepared,runtime,write,qualify:()=>qualifyClientListRuntime(prepared,runtime,qualifyClientListModel(tree,prepared))};
}
test('list flow pins the original bodies, clones input and confines mutations to output',t=>{
 const f=fixture(t),result=f.qualify();assert.equal(result.classification,'native-local-list-flow');
 assert.equal(result.invocationNetworkAllowed,false);assert.equal(result.serverDebugger,false);
 assert.deepEqual(Object.keys(result.nativeMethods).sort(),['listAppend','listClear']);
 assert.equal(result.chunkSha256,hash(app));assert.equal(result.coreChunkSha256,hash(core));
});
test('list flow refuses escaped writes, replacement inputs and unbounded iteration',t=>{
 for(const [before,after] of [
  ['var bag={};','var bag={};fetch("https://invalid.test");'],
  ['input.clone()','input'],['i<vars.value.sourceInLocal.length','i<99999'],['i++','i--'],
  ['lists.listClear(outputs.value.resultOut','lists.listClear(vars.value.sourceInLocal'],
  ['vars.value.sourceInLocal.getItem(i.valueOf()),context','window.foreign,context'],
  ['var bag={};','var bag={};window.changed=true;'],
  ['function original','controller.callContext=function(){return {}};function original']
 ]){const f=fixture(t);f.write('app.js',app.replace(before,after));assert.throws(f.qualify,/debug_odc_native_client_list_/);}
 const f=fixture(t);f.write('core.js',core.replace('list.append(item)','list.append(item);fetch("https://invalid.test")'));
 assert.throws(f.qualify,/native_list_method/);
});
test('list flow requires a complete model, original system signature and unchanged source',t=>{
 const incomplete=fixture(t);incomplete.tree.childrenOmitted=1;assert.throws(incomplete.qualify,/model_incomplete/);
 const foreign=fixture(t);foreign.tree.children.find(n=>n.kind==='ExecuteClientActionNode').propertyReferences.Action.path='Reference:Other/ClientActionSignature:ListClear';assert.throws(foreign.qualify,/model_call/);
 const effect=fixture(t);effect.prepared.effects.push('write-data');assert.throws(effect.qualify,/client_list_entry/);
 const changed=fixture(t);fs.appendFileSync(changed.runtime.pins['app.js'].path,' ');assert.throws(changed.qualify,/source_changed/);
});
