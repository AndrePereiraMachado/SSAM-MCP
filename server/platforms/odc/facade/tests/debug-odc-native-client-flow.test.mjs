import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {nativeLifecycleBinding} from '../debug-odc-native-lifecycle.mjs';
import {qualifyClientFlowModel,qualifyClientFlowRuntime,prepareClientFlowModel} from '../debug-odc-native-client-flow.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex'),K=c=>c.repeat(22),entry=K('A'),callee=K('B'),ownerKey=K('O'),stateKey=K('V'),clientKey=K('X');
const n=(kind,key,extra={})=>({kind,key,children:[],properties:{},...extra});
const next=key=>({Target:{key}});
function models(){
 const screen=n('ScreenAction',entry,{name:'Choose',path:'MobileFlow:Flow/MobileScreen:View/ScreenAction:Choose',children:[
  n('InputParameter',K('I'),{name:'Flag',properties:{DataType:'BasicType:Boolean'}}),
  n('StartNode','start',{propertyReferences:next('if')}),n('IfNode','if',{propertyReferences:{TrueTarget:{key:'call'},FalseTarget:{key:'assign'}},properties:{Condition:'Flag'}}),
  n('ExecuteClientActionNode','call',{propertyReferences:{...next('assign'),Action:{kind:'ClientAction',key:callee,path:'ClientAction:Reset'}}}),
  n('AssignNode','assign',{propertyReferences:next('end'),children:[n('Assignment','write',{properties:{Variable:'Enabled',Value:'Flag'}})]}),n('EndNode','end')]});
 const reset=n('ClientAction',callee,{name:'Reset',path:'ClientAction:Reset',children:[n('StartNode','reset-start',{propertyReferences:next('reset-assign')}),
  n('AssignNode','reset-assign',{propertyReferences:next('reset-end'),children:[n('Assignment','client-write',{properties:{Variable:'Client.Cleared',Value:'True'}})]}),n('EndNode','reset-end')]});
 const owner=n('MobileScreen',ownerKey,{path:'MobileFlow:Flow/MobileScreen:View',childrenTotal:1,children:[n('LocalVariable',stateKey,{name:'Enabled'})]});
 return{trees:[screen,reset],owner,clientVariables:[{kind:'ClientVariable',key:clientKey,name:'Cleared'}]};
}
const app=`import { spans, types } from './core.js'; import { reset as resetOriginal, store } from './module.js';
class C {
 _choose$Action(flag,context){var bag={},model=this.model,controller=this.controller,ids=this.idService;
 return spans.startActiveSpan('Choose',function(span){try{
 controller.ensureControllerAlive('Choose');context=controller.callContext(context);
 var vars=new types.VariableHolder(new(controller.constructor.getVariableGroupType('View.Choose$vars')));
 vars.value.flagInLocal=flag;bag.model=model;bag.idService=ids;bag.callContext=context;bag.vars=vars;
 OutSystemsDebugger.push('entry',context.id,bag);
 if(vars.value.flagInLocal)resetOriginal(context);
 model.variables.enabledVar=vars.value.flagInLocal;
 OutSystemsDebugger.handleBreakpoint('end',context.id);OutSystemsDebugger.pop('entry',context.id);
 }finally{span&&span.end();}},1);}
 choose$Action(flag,context){var controller=this.controller;return spans.startActiveSpan('Choose__proxy',function(span){try{
 return controller.safeExecuteClientAction(controller._choose$Action,context,flag);
 }finally{span&&span.end();}},0);}}
var meta={'${stateKey}':{getter:function(bag,id){return bag.model.variables.enabledVar}}};OutSystemsDebugger.registerMetaInfo(meta);`;
const moduleSource=`import {spans,container,services,types,controllers} from './core.js';
var storage;class Variables {constructor(){storage=container.resolve(services.ClientVariablesService)}
 setCleared(value){return storage.setVariable('Cleared','Test',types.DataTypes.Boolean,value)}}
var store=new Variables();class Controller extends controllers.BaseModuleController{}var controller=new Controller();
function reset(context){var bag={};return spans.startActiveSpan('Reset',function(span){try{
 context=controller.callContext(context);bag.callContext=context;OutSystemsDebugger.push('callee',context.id,bag);
 store.setCleared(true);OutSystemsDebugger.handleBreakpoint('reset-end',context.id);OutSystemsDebugger.pop('callee',context.id);
 }finally{span&&span.end();}},1);}
export {reset,store};`;
// Resolve the same variable-declarator class aliases used by published ODC bundles.
const publishedModule=moduleSource.replace('class Variables {','var Variables=class Variables {').replace('}}\nvar store','}};\nvar store')
 .replace('class Controller extends controllers.BaseModuleController{}','var Controller=class Controller extends controllers.BaseModuleController{};');
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'client-flow-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const prepared={module:'Test',action:{key:entry,kind:'ScreenAction',name:'Choose'},entry:{key:entry},path:[{key:entry}],
  runtimeRequestKeys:[entry,callee],effects:[],effectEvidence:[{kind:'ExecuteClientActionNode',actionKey:callee,external:false,bodyRead:true}]};
 const member={key:entry,type:'CLIENT_SCREEN_ACTION',chunk:'app.js',holder:{kind:'method',name:'choose$Action'},classStart:app.indexOf('class C'),controllerFactory:'factory',ownerName:'Test',varsGroup:'View.Choose$vars'};
 const runtime={pins:{},index:{functions:{[entry]:[member,{...member,holder:{kind:'method',name:'_choose$Action'},nativeProxy:'choose$Action'}],
  [callee]:[{key:callee,type:'CLIENT_ACTION',chunk:'module.js',holder:{kind:'function',local:'reset',name:'reset',params:1}}]},
  views:{[ownerKey]:[{key:ownerKey,chunk:'app.js',controllerFactory:'factory',displayName:'Flow.View'}]},screens:{'Flow.View':'app.js'},
  groups:{'View.Choose$vars':[{chunk:'app.js',attributes:[{name:'Flag',attrName:'flagInLocal',dataType:'Boolean'}]}]},
  chunks:{'core.js':{keepNames:{widget:'WidgetIdService'},imports:[],exports:{}},
   'app.js':{keepNames:{},exports:{},imports:[{specifier:'./core.js',names:['spans','types'].map(local=>({local,imported:local}))},{specifier:'./module.js',names:[{local:'resetOriginal',imported:'reset'},{local:'store',imported:'store'}]}]},
   'module.js':{keepNames:{},exports:{reset:'reset',store:'store'},imports:[{specifier:'./core.js',names:['spans','container','services','types','controllers'].map(local=>({local,imported:local}))}]}}}};
 const write=(name,source)=>{const file=path.join(directory,name);fs.writeFileSync(file,source);runtime.pins[name]={path:file,sha256:hash(source)};};
 write('core.js','// Native SDK fixture');write('app.js',app);write('module.js',publishedModule);
 const source=models();
 return{prepared,runtime,source,write,qualify(){return qualifyClientFlowRuntime(prepared,runtime,qualifyClientFlowModel(source.trees,source.owner,source.clientVariables,prepared));}};
}
test('closed client call graph preserves native call context and binds client setters to the original service',async t=>{
 const f=fixture(t),result=f.qualify();assert.equal(result.classification,'native-closed-client-flow');
 assert.deepEqual(result.actions.map(a=>a.calls),[[callee],[]]);assert.equal(result.invocationNetworkAllowed,false);
 const seen=[];const model=await prepareClientFlowModel(f.source.trees[0],f.source.owner,{tree:async key=>{seen.push(key);return f.source.trees[1]},list:async kind=>{assert.equal(kind,'ClientVariable');return f.source.clientVariables}},f.prepared);
 assert.deepEqual(seen,['@'+callee]);assert.equal(model.actions.length,2);
});

test('read-modify-write binds the getter to the same native client variable and service',t=>{
 const source=publishedModule.replace('setCleared(value)',"getCleared(){return storage.getVariable('Cleared','Test',types.DataTypes.Boolean)}\n setCleared(value)")
  .replace('store.setCleared(true)','store.setCleared(!store.getCleared())');
 const f=fixture(t);f.write('module.js',source);
 assert.equal(f.qualify().actions[1].writes,1);
 const changes=[
  source.replace('return storage.getVariable',"fetch('https://invalid.test');return storage.getVariable"),
  source.replace("getVariable('Cleared','Test'","getVariable('Cleared','Other'"),
  source.replace("getVariable('Cleared'","getVariable('UserEmail'"),
  source.replace('storage.getVariable','storage.setVariable'),
  source.replace('getCleared(){','getCleared(extra){'),
  source.replace('store.getCleared()','store.getCleared(true)'),
  source.replace('services.ClientVariablesService','services.AuthenticationService'),
 ];
 for(const changed of changes){const altered=fixture(t);altered.write('module.js',changed);assert.throws(()=>altered.qualify(),/debug_odc_native_client_flow_/);}
});

test('one lifecycle action qualifies scalar locals and the original event binding for screens and blocks', t=>{
 for(const kind of ['MobileScreen','MobileBlock']){
  const f=fixture(t),tree=f.source.trees[0];
  f.source.trees=[tree]; f.source.owner.kind=kind;
  f.source.owner.path='MobileFlow:Flow/'+kind+':View';tree.path=f.source.owner.path+'/ScreenAction:Choose';
  tree.children=tree.children.filter(n=>!['InputParameter','ExecuteClientActionNode'].includes(n.kind));
  tree.children.unshift(n('LocalVariable',K('L'),{name:'Previous',properties:{DataType:'BasicType:Boolean'}}));
  tree.children.find(n=>n.kind==='IfNode').propertyReferences.TrueTarget.key='assign';
  tree.children.find(n=>n.kind==='AssignNode').children.unshift(n('Assignment','local-write',{properties:{Variable:'Previous',Value:'Enabled'}}));
  f.prepared.runtimeRequestKeys=[entry];f.prepared.effectEvidence=[];
  const source=app.replace('class C {','class C { get onInitializeEventHandler(){return function(cc){return this.choose$Action(cc);};}')
   .replaceAll('flag,context','context').replace('vars.value.flagInLocal=flag;','')
   .replace('if(vars.value.flagInLocal)resetOriginal(context);','vars.value.previousVar=model.variables.enabledVar;')
   .replace('model.variables.enabledVar=vars.value.flagInLocal;','model.variables.enabledVar=!vars.value.previousVar;')
   .replace('controller._choose$Action,context,flag','controller._choose$Action,context');
  f.write('app.js',source);
  f.runtime.index.groups['View.Choose$vars'][0].attributes=[{name:'Previous',attrName:'previousVar',dataType:'Boolean'}];
  const member=f.runtime.index.functions[entry][0];
  member.lifecycleHandler=['onInitializeEventHandler'];
  const getter=parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.find(n=>n.type==='ClassDeclaration').body.body.find(m=>m.kind==='get');
  member.lifecycleBindings=[{handler:'onInitializeEventHandler',binding:nativeLifecycleBinding(getter,'choose$Action')}];
  const result=f.qualify();assert.equal(result.actions.length,1);assert.equal(result.actions[0].writes,2);
  assert.equal(result.model.actions[0].locals[0].name,'Previous');assert.equal(result.invocationNetworkAllowed,false);
  f.write('app.js',source.replace('vars.value.previousVar=model.variables.enabledVar','vars.value.previousVar=fetch("https://invalid.test")'));
  assert.throws(()=>f.qualify(),/sidecall/);f.write('app.js',source);
  f.runtime.index.groups['View.Choose$vars'][0].attributes[0].dataType='Text';assert.throws(()=>f.qualify(),/input_abi/);
  f.runtime.index.groups['View.Choose$vars'][0].attributes[0].dataType='Boolean';
  member.lifecycleBindings[0].binding.contextPreserved=false;assert.throws(()=>f.qualify(),/lifecycle_binding/);
  member.lifecycleBindings=[];assert.throws(()=>f.qualify(),/lifecycle_binding/);
  member.lifecycleBindings=[{handler:'onInitializeEventHandler',binding:{kind:'native-cached-event'}}];
  assert.throws(()=>f.qualify(),/lifecycle_helper_unqualified|lifecycle_binding/);
 }
});
test('unqualified side effects, identity writes, incorrect call context and service substitutions are refused',t=>{
 const changes=[
  ['app.js',app.replace('resetOriginal(context)','resetOriginal({})')],
  ['app.js',app.replace('resetOriginal(context)','fetch("https://invalid.test")')],
  ['app.js',app.replace('model.variables.enabledVar=','globalThis.enabled=')],
  ['module.js',publishedModule.replace('store.setCleared(true)','store.setCleared(true);fetch("https://invalid.test")')],
  ['module.js',publishedModule.replace("'Cleared','Test'","'Cleared','Other'")],
  ['module.js',publishedModule.replace('services.ClientVariablesService','services.AuthenticationService')],
  ['module.js',publishedModule.replace('extends controllers.BaseModuleController{}','extends controllers.BaseModuleController{callContext(c){fetch("https://invalid.test");return c}}')],
  ['module.js',publishedModule.replace("return storage.setVariable","fetch('https://invalid.test');return storage.setVariable")],
 ];
 for(const [file,source]of changes){const f=fixture(t);f.write(file,source);assert.throws(()=>f.qualify(),/debug_odc_native_client_flow_/);}
 const f=fixture(t);f.source.trees[1].children[1].children[0].properties.Variable='Client.UserEmail';
 f.source.clientVariables.push({kind:'ClientVariable',key:K('Y'),name:'UserEmail'});
 assert.throws(()=>f.qualify(),/model_identity_write/);
 const sql=fixture(t);sql.source.trees[1].children[1].kind='SQLNode';assert.throws(()=>sql.qualify(),/model_effect/);
 const cycle=fixture(t);cycle.source.trees[0].children[2].propertyReferences.TrueTarget.key='if';assert.throws(()=>cycle.qualify(),/model_flow/);
 const missing=fixture(t);missing.prepared.runtimeRequestKeys=[entry];assert.throws(()=>missing.qualify(),/entry_effect/);
 const owner=fixture(t);owner.source.owner.propertyErrors={Inputs:'unavailable'};assert.throws(()=>owner.qualify(),/model_target/);
 const mutated=fixture(t);fs.appendFileSync(mutated.runtime.pins['module.js'].path,' ');assert.throws(()=>mutated.qualify(),/source_changed/);
});
