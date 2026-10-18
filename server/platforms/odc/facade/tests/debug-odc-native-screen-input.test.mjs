import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {qualifyClientLocalModel,qualifyClientLocalRuntime} from '../debug-odc-native-client-local.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex'),key='A'.repeat(22);
const node=(kind,key,extra={})=>({kind,key,properties:{},children:[],...extra});
const tree=node('ScreenAction',key,{children:[node('InputParameter','input',{name:'IsValid',properties:{DataType:'BasicType:Boolean'}}),
 node('StartNode','start',{propertyReferences:{Target:{key:'assign'}}}),
 node('AssignNode','assign',{propertyReferences:{Target:{key:'end'}},children:[node('Assignment','value',{properties:{Variable:'IsButtonEnabled',Value:'IsValid'}})]}),node('EndNode','end')]});
const prepared={action:{key,kind:'ScreenAction',name:'Check'},entry:{key},path:[{key}],bindings:[{control:'direct',entryInput:'IsValid',targetInput:'IsValid'}]};
const source=`import {telemetry as spans,types} from './core.js';class C{
 _check$Action(input,context){var bag={},model=this.model,controller=this.controller,ids=this.idService;
 return spans.startActiveSpan("Check",function(span){try{
 controller.ensureControllerAlive("Check");context=controller.callContext(context);
 var vars=new types.VariableHolder(new(controller.constructor.getVariableGroupType("View.Check$vars")));
 vars.value.isValidInLocal=input;bag.model=model;bag.idService=ids;bag.callContext=context;bag.vars=vars;
 try{OutSystemsDebugger.push("action",context.id,bag);model.variables.isButtonEnabledVar=vars.value.isValidInLocal;
 OutSystemsDebugger.handleBreakpoint("end",context.id);}finally{OutSystemsDebugger.pop("action",context.id);}
 }finally{span&&span.end();}},1);}
 check$Action(input,context){var controller=this.controller;return spans.startActiveSpan("Check__proxy",function(span){
 try{return controller.safeExecuteClientAction(controller._check$Action,context,input);}finally{span&&span.end();}},0);}}
`;
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-screen-input-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const core='var telemetry=Object.freeze({startActiveSpan:start});function start(){};';
 const member={key,chunk:'app.js',type:'CLIENT_SCREEN_ACTION',classStart:source.indexOf('class C'),holder:{kind:'method',name:'check$Action'},varsGroup:'View.Check$vars'};
 const runtime={pins:{},index:{functions:{[key]:[member,{...member,holder:{kind:'method',name:'_check$Action'},nativeProxy:'check$Action'}]},views:{},screens:{},
 groups:{'View.Check$vars':[{chunk:'app.js',attributes:[{name:'IsValid',attrName:'isValidInLocal',dataType:'Boolean'}]}]},
 chunks:{'core.js':{keepNames:{start:'startActiveSpan',widget:'WidgetIdService'},exports:{telemetry:'telemetry'}}}}};
 const write=(name,text)=>{const file=path.join(dir,name);fs.writeFileSync(file,text);runtime.pins[name]={path:file,sha256:hash(text)};};
 write('core.js',core);write('app.js',source);
 return{runtime,qualify(code=source,model=tree,contract=prepared,owner){write('app.js',code);return qualifyClientLocalRuntime(contract,runtime,qualifyClientLocalModel(model,contract,owner));}};
}
test('native screen inputs are forwarded in SDK context-first order and assigned only to declared screen state',t=>{
 const f=fixture(t),qualified=f.qualify();assert.equal(qualified.classification,'native-input-state-assignments');
 assert.equal(qualified.originalEntry,true);assert.equal(qualified.invocationNetworkAllowed,false);
 for(const change of [s=>s.replace('context,input);','input,context);'),
  s=>s.replace('isValidInLocal=input','isValidInLocal=context'),
  s=>s.replace('isButtonEnabledVar=vars.value','isButtonEnabledVar=!vars.value'),
  s=>s.replace('model.variables.isButtonEnabledVar','globalThis.changed'),
  s=>s.replace('bag.vars=vars;','bag.vars=vars;fetch("https://invalid.test");')])
  assert.throws(()=>f.qualify(change(source)),/debug_odc_native_client_local_/);
 const different=structuredClone(tree);different.children[0].properties.DataType='BasicType:Integer';
 assert.throws(()=>f.qualify(source,different),/input_binding_unqualified/);
 f.runtime.index.groups['View.Check$vars'][0].attributes.push({name:'Hidden',attrName:'hiddenVar',dataType:'Boolean'});
 assert.throws(()=>f.qualify(),/runtime_input_unqualified/);
});
test('screen assignment uses its owner variable key and registered native getter, including screen inputs',t=>{
 const f=fixture(t),model=structuredClone(tree),variableKey='V'.repeat(22),ownerKey='O'.repeat(22);
 model.name='Check';model.path='MobileFlow:Flow/MobileScreen:View/ScreenAction:Check';
 const owner={kind:'MobileScreen',key:ownerKey,path:'MobileFlow:Flow/MobileScreen:View',childrenTotal:1,
  children:[{kind:'InputParameter',key:variableKey,name:'IsButtonEnabled'}]};
 const metadata=`var meta={"${variableKey}":{getter:keep(function(bag,id){return bag.model.variables.isButtonEnabledIn},"getter")}};OutSystemsDebugger.registerMetaInfo(meta);`;
 const code=source.replaceAll('isButtonEnabledVar','isButtonEnabledIn')+metadata;
 for(const member of f.runtime.index.functions[key])member.controllerFactory='cf';
 f.runtime.index.views[ownerKey]=[{key:ownerKey,displayName:'Flow.View',chunk:'app.js',controllerFactory:'cf'}];
 f.runtime.index.screens['Flow.View']='app.js';
 const result=f.qualify(code,model,prepared,owner);
 assert.equal(result.model.assignments[0].variableKey,variableKey);
 assert.equal(result.model.assignments[0].attribute,undefined);
 for(const bad of [code.replace(metadata,''),code+metadata,
  code.replace('bag.model.variables.isButtonEnabledIn','bag.model.variables.otherIn'),
  code.replace('return bag.model','fetch("https://invalid.test");return bag.model'),
  code.replace('"'+variableKey+'"','"'+'W'.repeat(22)+'"')])
  assert.throws(()=>f.qualify(bad,model,prepared,owner),/runtime_(metadata|assignment)_unqualified/);
 assert.throws(()=>f.qualify(code,model,prepared,{...owner,key:'Z'.repeat(22)}),/runtime_owner_unqualified/);
 assert.throws(()=>f.qualify(code,model,prepared,{...owner,children:[],childrenTotal:0}),/model_assignment_target_unqualified/);
 assert.throws(()=>f.qualify(code,model,prepared,{...owner,path:'MobileFlow:Other/MobileScreen:View'}),/model_owner_unqualified/);
});
test('entity identifiers require the exact model identity and original LongInteger ABI',t=>{
 const f=fixture(t),model=structuredClone(tree),contract=structuredClone(prepared),id='Z'.repeat(22)+'.#IdentifierType';
 model.children[0].properties.DataType='IdentifierType:Carrier Identifier';
 model.children[0].propertyReferences={DataType:{kind:'IdentifierType',key:id,path:'ServerEntity:Carrier/IdentifierType:Carrier Identifier'}};
 contract.action.inputs=[{key:'input',name:'IsValid',dataType:'Identifier',identifierKey:id}];
 f.runtime.index.groups['View.Check$vars'][0].attributes[0].dataType='LongInteger';
 const qualified=f.qualify(source,model,contract);
 assert.equal(qualified.model.inputs[0].identifierKey,id);
 assert.equal(qualified.model.inputs[0].runtimeDataType,'LongInteger');
 const foreign=structuredClone(model);foreign.children[0].propertyReferences.DataType.key='Y'.repeat(22)+'.#IdentifierType';
 assert.throws(()=>f.qualify(source,foreign,contract),/model_identifier_unqualified/);
 const textual=structuredClone(model);textual.children[0].propertyReferences.DataType.path='StaticEntity:Carrier/IdentifierType:Carrier Identifier';
 assert.throws(()=>f.qualify(source,textual,contract),/model_identifier_unqualified/);
 f.runtime.index.groups['View.Check$vars'][0].attributes[0].dataType='Text';
 assert.throws(()=>f.qualify(source,model,contract),/input_binding_unqualified/);
});
