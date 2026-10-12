import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifyContextReadModel,qualifyContextReadRuntime} from '../debug-odc-native-context-read.mjs';
function fixture(){
 let sequence=0;const key=()=>String(++sequence).padStart(22,'A');
 const n=(kind,name,children=[],properties={},propertyReferences={})=>({key:key(),kind,name,children,properties,propertyReferences});
 const variable=(kind,name)=>n(kind,name,[],{DataType:'BasicType:Integer'});
 // Identity witnesses hold the native User Identifier type (ODC reference form).
 const userVariable=(kind,name)=>n(kind,name,[],{},{DataType:{kind:'IdentifierType',path:'Reference:(System)/ServerEntitySignature:User/IdentifierType:User Identifier'}});
 const seed=variable('LocalVariable','Seed'),screen=n('ScreenAction','Run'),client=n('ClientAction','Read'),server=n('ServerAction','Observe');
 const owner=n('MobileScreen','Probe',[seed,screen]);owner.path='MobileFlow:Probes/MobileScreen:Probe';screen.path=owner.path+'/ScreenAction:Run';
 const input=variable('InputParameter','Value'),local=userVariable('LocalVariable','User'),serverInput=variable('InputParameter','Expected'),output=userVariable('OutputParameter','User');
 const native=new Map([screen,client,server].map(a=>[a.key,[]]));
 const root=(used=[],extra={})=>({kind:'Identifier',functionCall:false,builtin:null,originalBuiltin:false,usedObjects:used.map(v=>({key:v.key,kind:v.kind})),children:[],...extra});
 const builtin=()=>root([],{kind:'FunctionCall',functionCall:true,builtin:'GetUserId',originalBuiltin:true});
 function expr(action,parent,field,name,value){const e=n('TextBasedExpression',name);e.key=parent.key+'.#'+field;parent.children.push(e);native.get(action.key).push({key:e.key,root:value});}
 function assign(action,to,value){const a=n('Assignment','',[],{Variable:to.name,Value:'GetUserId()'});expr(action,a,'Variable',to.name,root([to]));expr(action,a,'Value','GetUserId()',value);return n('AssignNode','',[a]);}
 function call(action,target,param,value,kind){const node=n(kind,target.name,[],{},{Action:{key:target.key}}),arg=n('Argument',param.name,[],{Value:value.name},{Parameter:{key:param.key}});expr(action,arg,'Value',value.name,root([value]));node.children.push(arg);return node;}
 function flow(action,vars,nodes){const start=n('StartNode','Start'),end=n('EndNode','End');const all=[start,...nodes,end];for(let i=0;i<all.length-1;i++){all[i].propertyReferences.Target={key:all[i+1].key};all[i].children.push(n('ActionConnector','',[],{},{Target:{key:all[i+1].key}}));}action.children=[...vars,...all];}
 flow(screen,[],[call(screen,client,input,seed,'ExecuteClientActionNode')]);
 flow(client,[input,local],[assign(client,local,builtin()),call(client,server,serverInput,local,'ExecuteServerActionNode')]);
 flow(server,[serverInput,output],[assign(server,output,builtin())]);
 const trees=[screen,client,server],moduleKey=key(),sourceSha256='a'.repeat(64);
 const nativeBindings=trees.map(a=>({available:true,authority:'installed-model-expression-tree',runtimeValuesEvaluated:false,
  identity:{moduleKey,sourceSha256,functionKey:a.key},expressions:native.get(a.key)}));
 const prepared={entry:{key:screen.key,kind:screen.kind},action:{key:server.key,kind:server.kind},path:trees.map(a=>({key:a.key})),effects:[],
  effectEvidence:[{kind:'ExecuteClientActionNode',actionKey:client.key,external:false},{kind:'ExecuteServerActionNode',actionKey:server.key,external:false}],runtimeRequestKeys:trees.map(a=>a.key)};
 return{prepared,trees,owner,nativeBindings,moduleKey,sourceSha256};
}
test('native context read requires a complete original screen/client/server graph and native builtin identity',()=>{
 const f=fixture(),proof=qualifyContextReadModel(f);assert.equal(proof.writesBusinessData,false);assert.equal(proof.rolesProved,false);
 assert.equal(proof.functionCalls.length,2);assert.equal(proof.functionKeys.length,3);
 // identity is delegated to the generic native witness qualifier (one user-id witness per client/server action)
 assert.deepEqual(proof.identityWitnesses.map(w=>[w.kind,w.functionKey,w.qualified]),[['user-id',f.trees[1].key,true],['user-id',f.trees[2].key,true]]);
});
test('context qualification rejects spoofed functions, expression gaps, extra effects and foreign writes',()=>{
 const mutations=[
  f=>{f.nativeBindings[1].expressions.find(e=>e.root.functionCall).root.originalBuiltin=false;},
  f=>{f.nativeBindings[1].expressions.find(e=>e.root.functionCall).root.builtin='DeleteUser';},
  f=>{f.nativeBindings[1].identity.sourceSha256='b'.repeat(64);},
  f=>{f.nativeBindings[1].expressions.pop();},
  f=>{f.nativeBindings[1].expressions.push({...f.nativeBindings[1].expressions[0],key:'foreign'});},
  f=>{f.trees[2].children.push({key:'hidden',kind:'ExecuteJavaScriptNode',children:[]});},
  f=>{f.nativeBindings[2].expressions.find(e=>e.key.endsWith('.#Variable')).root.usedObjects=[{key:f.trees[2].children[0].key}];},
  f=>{f.prepared.effectEvidence.push({kind:'ExecuteServerActionNode',actionKey:'foreign'});},
  f=>{f.nativeBindings[0].expressions[0].root.usedObjects=[{key:'foreign'}];},
  f=>{f.trees[0].childrenOmitted=1;},
  f=>{f.nativeBindings[0].runtimeValuesEvaluated=true;},
  // generic qualifier refusals: foreign/role bindings, non-identifier witness, reassigned witness
  f=>{f.nativeBindings[1].expressions.find(e=>e.root.functionCall).root.functionObject={key:'U'.repeat(22),kind:'Action'};},
  f=>{f.nativeBindings[2].expressions.find(e=>e.root.functionCall).root.role={roleKey:'R'.repeat(22),ownerModuleKey:f.moduleKey,check:'server'};},
  f=>{const v=f.trees[2].children.find(c=>c.kind==='OutputParameter');v.propertyReferences={};v.properties={DataType:'BasicType:Integer'};},
  f=>{const assign=f.trees[1].children.find(c=>c.kind==='AssignNode'),again=structuredClone(assign.children.find(c=>c.kind==='Assignment'));
   again.key='Z'.repeat(22);again.children.forEach(e=>{e.key=again.key+e.key.slice(22);});assign.children.push(again);
   const native=f.nativeBindings[1].expressions;native.push(...native.filter(e=>e.key.startsWith(assign.children[0].key)).map(e=>({key:again.key+e.key.slice(22),root:e.root})));},
 ];
 for(const mutate of mutations){const f=fixture();mutate(f);assert.throws(()=>qualifyContextReadModel(f),/context_read_unqualified/);}
});

test('context read runtime admits exactly the published target endpoint and original screen owner',()=>{
 const f=fixture(),model=qualifyContextReadModel(f),endpoint='screenservices/App/ReadContext';
 const runtime={index:{functions:{[f.prepared.action.key]:[{key:f.prepared.action.key,holder:{},call:{kind:'server-action',inputs:[],endpoint,apiVersion:'one'}}]},views:{},screens:{},groups:{}}};
 const plan={member:{key:model.entryKey},invocation:'screen-action',inputs:[],view:{key:f.owner.key},screen:{key:f.owner.key},endpoints:{[endpoint]:'one'}};
 const binding={runtimeUrl:'https://example.invalid/App/'};
 assert.equal(qualifyContextReadRuntime(f.prepared,plan,model,binding,runtime).endpoint,'/App/'+endpoint);
 for(const mutate of [p=>{p.endpoints.other='one';},p=>{p.view.key='foreign';},p=>{p.inputs=[{name:'UserId'}];},p=>{p.invocation='client-action';}]){
  const changed=structuredClone(plan);mutate(changed);assert.throws(()=>qualifyContextReadRuntime(f.prepared,changed,model,binding,runtime),/context_read_unqualified/);
 }
});
