import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {qualifyClientFunctionsModel,prepareClientFunctionsModel,clientFunctionNames,qualifyClientFunctionsRuntime} from '../debug-odc-native-client-functions.mjs';
const key=i=>String(i).padStart(22,'a');
let serial=10;
const node=(kind,extra={})=>({kind,key:key(serial++),properties:{},children:[],...extra});
function action(name,number,isFunction,type,value){
 const end=node('EndNode'),assign=node('AssignNode',{propertyReferences:{Target:{key:end.key}},children:[node('Assignment',{properties:{Variable:'Result',Value:value}})]});
 return node('ClientAction',{key:key(number),name,path:'ClientAction:'+name,properties:{Function:String(isFunction?'True':'False')},children:[
  node('InputParameter',{name:'Value',properties:{DataType:'BasicType:'+type}}),
  node('OutputParameter',{name:'Result',properties:{DataType:'BasicType:'+type}}),
  node('StartNode',{propertyReferences:{Target:{key:assign.key}}}),assign,end]});
}
function fixture(){const trees=[action('Entry',1,false,'Integer','Increment(Value)'),action('Increment',2,true,'Integer','Value + 1')];
 return{trees,prepared:{action:{key:key(1)},entry:{key:key(1)}}};}
test('closes original function graph and checks declared input and output types',()=>{
 const f=fixture(),model=qualifyClientFunctionsModel(f.trees,f.prepared);
 assert.equal(model.actions[0].assignments[0].expression.call,key(2));
 assert.equal(model.actions[1].assignments[0].expression.dataType,'Integer');
 f.trees=[action('Entry',1,false,'Text','Echo(Value)'),action('Echo',2,true,'Text','Value')];
 assert.equal(qualifyClientFunctionsModel(f.trees,f.prepared).actions[0].assignments[0].expression.dataType,'Text');
});
test('refuses effects, type mismatches, recursion, incomplete bodies and caller input writes',()=>{
 for(const mutate of [
  f=>f.trees[1].children.push(node('JavaScriptNode')),
  f=>f.trees[1].children[0].properties.DataType='BasicType:Text',
  f=>f.trees[1].children[3].children[0].properties.Value='Increment(Value)',
  f=>f.trees[1].childrenOmitted=1,
  f=>f.trees[0].children[3].children[0].properties.Variable='Value',
  f=>f.trees[0].children[3].children[0].properties.Value='Foreign(Value)',
  f=>f.trees[0].children[3].children[0].properties.Value='Increment(Value); fetch()'
 ]){const f=fixture();mutate(f);assert.throws(()=>qualifyClientFunctionsModel(f.trees,f.prepared),/client_functions_/);}
});
test('resolves helpers only from unique same-module model names',async()=>{
 const f=fixture(),seen=[],readers={list:async()=>f.trees,tree:async ref=>{seen.push(ref);return f.trees.find(t=>'@'+t.key===ref);}};
 assert.deepEqual(clientFunctionNames(f.trees[0]),['Increment']);
 assert.equal((await prepareClientFunctionsModel(f.trees[0],readers,f.prepared)).actions.length,2);
 assert.deepEqual(seen,['@'+key(2)]);
 readers.list=async()=>[...f.trees,f.trees[1]];
 await assert.rejects(()=>prepareClientFunctionsModel(f.trees[0],readers,f.prepared),/call_resolution/);
});

function runtimeFixture(t,compound=false){
 const f=fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-function-graph-'));
 if(compound){
  for(const tree of f.trees)for(const v of tree.children.filter(n=>['InputParameter','OutputParameter'].includes(n.kind))){
   v.properties.DataType='ListType:Rows List';v.propertyReferences={DataType:{kind:'ListType',key:key(900)}};
  }
  f.trees[1].children[3].children[0].properties.Value='Value';
 }
 const type=compound?'RecordList':'Integer';
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const runtime={index:{functions:{},groups:{},chunks:{'core.js':{keepNames:{h:'VariableHolder'}},'app.js':{imports:[],keepNames:{}}}},pins:{}};
 Object.assign(f.prepared,{path:[{key:key(1)}],bindings:[{control:'direct',entryInput:'Value',targetInput:'Value'}],runtimeRequestKeys:[key(1)]});
 const body=(name,expression)=>`function ${name}(input,ctx){var bag={};return core.startActiveSpan("${name}",function(span){
  ctx=controller.callContext(ctx);var vars=new core.VariableHolder(new(controller.constructor.getVariableGroupType("${name}$vars")));
  var outs=new core.VariableHolder(new(controller.constructor.getVariableGroupType("${name}$outs")));
  vars.value.valueInLocal=input${compound?'.clone()':''};bag.callContext=ctx;bag.vars=vars;bag.outVars=outs;
  OutSystemsDebugger.push("action",ctx.id,bag);outs.value.resultOut=${expression};OutSystemsDebugger.pop("action",ctx.id);return outs.value;});}`;
 const source=`import {core} from './core.js';`+body('Entry',`OutSystemsDebugger.handleFunctionCall(function(){return Increment(vars.value.valueInLocal,ctx).resultOut},core.DataTypes.${type},ctx==null?void 0:ctx.id)`)+body('Increment','vars.value.valueInLocal'+(compound?'':'+1'));
 for(const [i,name] of ['Entry','Increment'].entries()){
  runtime.index.functions[key(i+1)]=[{key:key(i+1),type:'CLIENT_ACTION',chunk:'app.js',holder:{kind:'function',local:name,name},moduleController:'controller',varsGroup:name+'$vars',outVarsGroup:name+'$outs'}];
  runtime.index.groups[name+'$vars']=[{chunk:'app.js',attributes:[{name:'Value',attrName:'valueInLocal',dataType:type}]}];
  runtime.index.groups[name+'$outs']=[{chunk:'app.js',attributes:[{name:'Result',attrName:'resultOut',dataType:type}]}];
 }
 const write=(name,value)=>{const file=path.join(dir,name);fs.writeFileSync(file,value);runtime.pins[name]={path:file,sha256:createHash('sha256').update(value).digest('hex')};};
 write('core.js','// synthetic framework metadata fixture');
 return{source,qualify(code=source){write('app.js',code);return qualifyClientFunctionsRuntime(f.prepared,runtime,qualifyClientFunctionsModel(f.trees,f.prepared));}};
}
test('qualifies native handleFunctionCall with the declared helper, output, type and original context',t=>{
 const proof=runtimeFixture(t).qualify();assert.equal(proof.actions[0].nativeFunctionReturnWrappers,1);assert.equal(proof.invocationNetworkAllowed,false);
});

test('compound functions preserve type identity and require original input cloning',t=>{
 const f=runtimeFixture(t,true),proof=f.qualify();
 assert.equal(proof.actions[0].nativeFunctionReturnWrappers,1);
 assert.equal(proof.model.actions[0].variables[0].modelTypeKey,key(900));
 for(const alter of [s=>s.replaceAll('input.clone()','input'),s=>s.replace('input.clone()','input.clone(1)'),
  s=>s.replace('core.DataTypes.RecordList','core.DataTypes.Record'),s=>s.replace('input.clone()','other.clone()')])
  assert.throws(()=>f.qualify(alter(f.source)),/debug_odc_native_client_/);
});

test('same compound category cannot substitute a different native model type',()=>{
 const f=fixture();
 for(const tree of f.trees)for(const v of tree.children.filter(n=>['InputParameter','OutputParameter'].includes(n.kind))){
  v.properties.DataType='ListType:Rows List';v.propertyReferences={DataType:{kind:'ListType',key:key(900)}};
 }
 f.trees[1].children[3].children[0].properties.Value='Value';
 assert.equal(qualifyClientFunctionsModel(f.trees,f.prepared).actions.length,2);
 f.trees[1].children[0].propertyReferences.DataType.key=key(901);
 assert.throws(()=>qualifyClientFunctionsModel(f.trees,f.prepared),/call_signature|assignment_type/);
 delete f.trees[1].children[0].propertyReferences.DataType;
 assert.throws(()=>qualifyClientFunctionsModel(f.trees,f.prepared),/declarations/);
});
test('refuses forged return wrappers and effects hidden inside a helper',t=>{
 const f=runtimeFixture(t);
 for(const change of [
  s=>s.replace('Increment(vars.value.valueInLocal,ctx)','Foreign(vars.value.valueInLocal,ctx)'),
  s=>s.replace('core.DataTypes.Integer','core.DataTypes.Text'),
  s=>s.replace('Increment(vars.value.valueInLocal,ctx)','Increment(vars.value.valueInLocal,otherCtx)'),
  s=>s.replace('ctx==null?void 0:ctx.id','otherCtx==null?void 0:otherCtx.id'),
  s=>s.replace('return Increment','fetch("/side-effect");return Increment'),
  s=>s.replace('vars.value.valueInLocal+1','vars.value.valueInLocal+2'),
  s=>s.replace('function Increment(input,ctx){','function Increment(input,ctx){fetch("/side-effect");'),
  s=>s.replace(').resultOut},core',').otherOutput},core')
 ])assert.throws(()=>f.qualify(change(f.source)),/debug_odc_native_client_/);
});
