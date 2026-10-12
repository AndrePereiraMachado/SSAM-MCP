// Model-side closure for native flow exception handlers. This does not execute
// expressions or authorize mounting; the published runtime must also qualify.
import {createHash} from 'node:crypto';
const fail=reason=>{throw new Error('debug_odc_exception_model_'+reason);};
const keyPattern=/^[A-Za-z0-9_+]{22}$/;
export function qualifyOdcExceptionModel(tree){
 if(tree?.kind!=='OnExceptionAction'||! /^[A-Za-z0-9_+]{22}\.\#FlowExceptionHandler$/.test(tree.key??''))fail('target');
 let count=0;
 function complete(n){
  if(++count>2500||!Array.isArray(n.children)||n.childrenTotal!==n.children.length||n.childrenOmitted||
   Object.keys(n.propertiesOmitted??{}).length||Object.keys(n.propertyErrors??{}).length||n.propertiesMissing?.length||
   Object.values(n.propertyReferenceCollections??{}).some(c=>c.omitted||!Array.isArray(c.items)||c.total!==c.items.length))fail('incomplete');
  n.children.forEach(complete);
 }
 complete(tree);
 const nodes=tree.children,byKey=new Map(nodes.map(n=>[n.key,n]));
 if(!nodes.length||byKey.size!==nodes.length||nodes.some(n=>!keyPattern.test(n.key)||n.properties?.IsDisabled==='True'))fail('nodes');
 const handlers=nodes.filter(n=>n.kind==='ExceptionHandlerNode');
 if(!handlers.length)fail('entry');
 const effects=[];
 for(const n of nodes){
  if(!['ExceptionHandlerNode','MessageNode','EndNode'].includes(n.kind))fail('effect_unqualified');
  const connectors=n.children.filter(c=>c.kind==='ActionConnector');
  const target=n.propertyReferences?.Target;
  if(n.kind==='EndNode'){
   if(target||n.children.length)fail('flow');
  }else{
   if(!target||!byKey.has(target.key)||target.kind!==byKey.get(target.key).kind||connectors.length!==1||
    connectors[0].propertyReferences?.Target?.key!==target.key)fail('flow');
  }
  if(n.kind==='ExceptionHandlerNode'){
   if(n.children.some(c=>c.kind!=='ActionConnector')||n.propertyReferences?.Exception?.kind!=='SystemException'||
    !['True','False'].includes(n.properties?.LogError)||!['True','False'].includes(n.properties?.AbortTransaction))fail('handler');
   effects.push({kind:'exception-handler',key:n.key,exceptionKey:n.propertyReferences.Exception.key,
    logError:n.properties.LogError==='True',abortTransaction:n.properties.AbortTransaction==='True'});
  }else if(n.kind==='MessageNode'){
   // OutSystems quoted literal syntax. Do not evaluate an arbitrary expression
   // while deciding whether a feedback node has additional call effects.
   if(typeof n.properties?.Message!=='string'||!/^"(?:[^"\r\n]|"")*"$/.test(n.properties.Message)||
    !['Error','Warning','Info','Success'].includes(n.properties.Type)||
    n.children.some(c=>!['ActionConnector','TextBasedExpression'].includes(c.kind)))fail('message_expression');
   effects.push({kind:'feedback',key:n.key,messageExpression:n.properties.Message,messageType:n.properties.Type});
  }
 }
 const reached=new Set(),active=new Set();
 function visit(n){
  if(active.has(n.key))fail('cycle');if(reached.has(n.key))return;
  active.add(n.key);if(n.kind!=='EndNode')visit(byKey.get(n.propertyReferences.Target.key));
  active.delete(n.key);reached.add(n.key);
 }
 handlers.forEach(visit);
 if(reached.size!==nodes.length)fail('orphan');
 return {schema:'ssam-odc-exception-model/1',actionKey:tree.key,nodeKeys:nodes.map(n=>n.key),
  handlerKeys:handlers.map(n=>n.key),effects,treeSha256:createHash('sha256').update(JSON.stringify(tree)).digest('hex'),
  modelQualified:true,runtimeQualified:false,executionAuthorized:false};
}
