import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifyOdcExceptionModel} from '../debug-odc-native-exception-model.mjs';
const key=n=>String(n).padStart(22,'A');
function fixture(){
 const node=(kind,n,properties={},children=[])=>({kind,key:key(n),properties,children,childrenTotal:children.length,childrenOmitted:0});
 const end=node('EndNode',3);
 const link=target=>({...node('ActionConnector',4),propertyReferences:{Target:{key:target.key,kind:target.kind}}});
 const message=node('MessageNode',2,{Message:'"Diagnostic ""error"""',Type:'Error'},[link(end)]);
 message.propertyReferences={Target:{key:end.key,kind:end.kind}};
 const handler=node('ExceptionHandlerNode',1,{LogError:'False',AbortTransaction:'True'},[link(message)]);
 handler.propertyReferences={Target:{key:message.key,kind:message.kind},Exception:{kind:'SystemException',key:key(9)}};
 return {...node('OnExceptionAction',0,{},[handler,message,end]),key:key(0)+'.#FlowExceptionHandler'};
}
test('complete feedback exception flow retains effects without execution authority',()=>{
 const result=qualifyOdcExceptionModel(fixture());
 assert.equal(result.modelQualified,true);assert.equal(result.runtimeQualified,false);assert.equal(result.executionAuthorized,false);
 assert.deepEqual(result.effects.map(e=>e.kind),['exception-handler','feedback']);
 assert.equal(result.effects[0].abortTransaction,true);
});
test('truncated reads and reference collections refuse qualification',()=>{
 for(const mutate of [t=>t.childrenTotal++,t=>t.children[0].propertiesOmitted={Exception:1},
  t=>t.children[1].propertyReferenceCollections={Connectors:{items:[],total:1,omitted:1}}]){
  const t=fixture();mutate(t);assert.throws(()=>qualifyOdcExceptionModel(t),/incomplete/);
 }
});
test('unknown effects and expression calls cannot pass as literal feedback',()=>{
 for(const mutate of [t=>t.children[1].kind='ExecuteServerActionNode',
  t=>t.children[1].properties.Message='FetchMessage()',t=>t.children[1].properties.Message='"x" + FetchMessage()']){
  const t=fixture();mutate(t);assert.throws(()=>qualifyOdcExceptionModel(t),/flow|effect_unqualified|message_expression/);
 }
});
test('cycles, dangling edges, disconnected nodes and inconsistent connectors refuse',()=>{
 const mutations=[t=>{const n=t.children[1];n.propertyReferences.Target={key:n.key,kind:n.kind};n.children[0].propertyReferences.Target={key:n.key,kind:n.kind};},
  t=>t.children[1].propertyReferences.Target.key=key(99),
  t=>{t.children.push({...t.children[2],key:key(8)});t.childrenTotal++;},
  t=>t.children[1].children[0].propertyReferences.Target.key=key(99)];
 for(const mutate of mutations){const t=fixture();mutate(t);assert.throws(()=>qualifyOdcExceptionModel(t),/cycle|flow|orphan/);}
});
