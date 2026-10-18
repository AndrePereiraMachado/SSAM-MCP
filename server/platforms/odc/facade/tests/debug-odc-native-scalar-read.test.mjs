import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifyScalarDataReadModel} from '../debug-odc-native-scalar-read.mjs';
import {qualifyStaticReadRuntime} from '../debug-odc-native-static-read.mjs';
const n=(kind,key,name,properties={},children=[],propertyReferences={})=>({kind,key,name,properties,children,propertyReferences});
function fixture(){
 const owner=n('MobileScreen','screen','Probe',{},[n('LocalVariable','seed','Seed',{DataType:'BasicType:Integer'})]);owner.path='MobileFlow:Tests/MobileScreen:Probe';
 const start=n('StartNode','start','Start'),assign=n('AssignNode','assign','Assign'),end=n('EndNode','end','End');
 for(const [a,b] of [[start,assign],[assign,end]]){a.propertyReferences.Target={key:b.key};a.children.push(n('ActionConnector',a.key+'-link','',{},[],{Target:{key:b.key}}));}
 const assignment=n('Assignment','set','Result = Seed + 2',{Variable:'Result',Value:'Seed + 2'},[
  n('TextBasedExpression','set.#Variable','Result'),n('TextBasedExpression','set.#Value','Seed + 2')]);assign.children.unshift(assignment);
 const entry=n('DataAction','entry','ReadValue',{},[n('OutputParameter','result','Result',{DataType:'BasicType:Integer'}),n('UILifeCycleEvent','after','After'),start,assign,end]);entry.path=owner.path+'/DataAction:ReadValue';
 const prepared={entry:{key:entry.key,kind:'DataAction'},action:{key:entry.key,inputs:[]},path:[{key:entry.key}],bindings:[],effectEvidence:[],effects:[],runtimeRequestKeys:[entry.key]};
 const endpoint='screenservices/Store/Tests/Probe/DataActionReadValue';
 const plan={member:{key:entry.key,call:{kind:'data-action',endpoint,apiVersion:'1'}},invocation:'data-action',view:{key:owner.key},screen:{key:owner.key},inputs:[],endpoints:{[endpoint]:'1'}};
 return {owner,entry,prepared,plan,assignment,assign,start,end};
}
test('a distinct original scalar Data Action qualifies with owner inputs, local-only writes and a single native endpoint',()=>{
 const f=fixture(),model=qualifyScalarDataReadModel(f);
 assert.equal(model.classification,'native-scalar-data-read');assert.equal(model.writesBusinessData,false);
 assert.deepEqual(model.ownerVariables,[{key:'seed',name:'Seed'}]);
 const proof=qualifyStaticReadRuntime(f.prepared,f.plan,model,{runtimeUrl:'https://dev.example.test/Store/'});
 assert.equal(proof.endpoint,'/Store/'+f.plan.member.call.endpoint);
 const other=fixture();other.plan.view.key='foreign';assert.throws(()=>qualifyStaticReadRuntime(other.prepared,other.plan,model,{runtimeUrl:'https://dev.example.test/Store/'}),/runtime_unsupported/);
});
test('scalar qualification refuses calls, foreign writes, hidden nodes, altered projections and incomplete owners',()=>{
 const setExpression=(f,value)=>{f.assignment.properties.Value=value;f.assignment.children[1].name=value;};
 for(const mutate of [
  f=>setExpression(f,'GetUserId()'),f=>setExpression(f,'Seed.value'),f=>setExpression(f,'Seed + 2; invoke()'),
  f=>setExpression(f,'Seed / 2'),f=>setExpression(f,'Unknown + 2'),
  f=>{f.assignment.properties.Variable='Seed';f.assignment.children[0].name='Seed';},
  f=>{f.assignment.children[1].name='Other';},f=>{f.owner.children[0].properties.DataType='BasicType:Text';},
  f=>{f.owner.childrenTotal=5;},f=>{f.entry.path='MobileFlow:Other/DataAction:ReadValue';},
  f=>{f.entry.children.push(n('ExecuteServerActionNode','effect','Effect'));},
  f=>{f.entry.children[1].children.push(n('ScreenAction','handler','Handler'));},
  f=>{f.prepared.effectEvidence.push({kind:'SQLNode'});},f=>{f.prepared.runtimeRequestKeys.push('foreign');},
  f=>{f.assign.children.at(-1).propertyReferences.Target.key='start';},
  f=>{f.end.propertyReferences.Target={key:'start'};},
  f=>{f.prepared.producerTarget={};},f=>{f.entry.children[0].propertiesMissing=['DataType'];}
 ]){const f=fixture();mutate(f);assert.throws(()=>qualifyScalarDataReadModel(f),/scalar_unqualified/);}
});

test('native Integer defaults require an exact literal expression projection',()=>{
 for(const value of ['40','0','-2147483648','2147483647']){
  const f=fixture(),seed=f.owner.children[0];seed.properties.DefaultValue=value;
  seed.children=[n('TextBasedExpression','seed.#DefaultValue',value)];
  assert.equal(qualifyScalarDataReadModel(f).writesBusinessData,false);
 }
 for(const value of ['GetUserId()','2147483648','1.5','Seed + 2']){
  const f=fixture(),seed=f.owner.children[0];seed.properties.DefaultValue=value;
  seed.children=[n('TextBasedExpression','seed.#DefaultValue',value)];
  assert.throws(()=>qualifyScalarDataReadModel(f),/scalar_unqualified/);
 }
 const f=fixture(),seed=f.owner.children[0];seed.properties.DefaultValue='40';
 seed.children=[n('TextBasedExpression','seed.#DefaultValue','41')];
 assert.throws(()=>qualifyScalarDataReadModel(f),/scalar_unqualified/);
});
