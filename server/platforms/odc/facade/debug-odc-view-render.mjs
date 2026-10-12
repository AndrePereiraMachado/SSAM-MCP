import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {createOdcViewComponentInspector} from './debug-odc-view-component.mjs';
import {createOdcEmbeddedWidgetsInspector} from './debug-odc-embedded-widgets.mjs';
import {createOdcRecordInitializationInspector} from './debug-odc-record-initialization.mjs';
import {inspectOdcRenderExpressions} from './debug-odc-render-expressions.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
// DOM targets of a mounted screen, from the published render inspection only.
// Ids follow the SDK WidgetIdService: a block instance with alias A nests its
// widgets under "<parent namespace>b<A>-"; the screen namespace is empty.
export function odcMountRenderTargets(views,{moduleKey}={}){
 const list=Array.isArray(views)?views:[],byKey=new Map(list.map(v=>[v.key,v])),instances=[];
 let complete=list.length>0&&/^[A-Za-z0-9_+]{22}$/.test(moduleKey??'');
 const visit=(view,namespace,depth)=>{
  const render=view?.renderExpressions;
  if(!view||render?.renderExpressionsQualified!==true||!Array.isArray(render.elements)||depth>16){complete=false;return;}
  instances.push({key:view.key,namespace,ids:[...new Set(render.elements.filter(e=>e.kind!=='block'&&typeof e.id==='string').map(e=>namespace+e.id))],
   functions:[...new Set([...(view.handlers??[]).map(h=>h.actionKey),...(view.dataActionKeys??[])])].map(k=>moduleKey+':'+k),
   texts:(render.textBindings??[]).map(t=>({id:namespace+t.id,variable:t.variable,form:t.form})),
   interactions:(render.interactionTargets??[]).filter(t=>typeof t?.id==='string').map(t=>({id:namespace+t.id,name:t.id,method:t.method})),ambiguous:false});
  for(const element of render.elements.filter(e=>e.kind==='block')){
   const components=view.blockComponents??[],index=components.indexOf(element.binding);
   if(index<0||components.lastIndexOf(element.binding)!==index||components.length!==view.blockKeys?.length||typeof element.alias!=='string'){complete=false;continue;}
   visit(byKey.get(view.blockKeys[index]),namespace+'b'+element.alias+'-',depth+1);
  }
 };
 if(complete)visit(list[0],'',0);
 // A view reached through several instances cannot attribute native reads to one.
 const counts=new Map();for(const i of instances)counts.set(i.key,(counts.get(i.key)??0)+1);
 for(const i of instances)i.ambiguous=counts.get(i.key)>1;
 return {schema:'ssam-odc-render-targets/1',moduleKey,complete,instances};
}
export function createOdcViewRenderInspector(files){
 const components=createOdcViewComponentInspector(files),widgets=createOdcEmbeddedWidgetsInspector(files),records=createOdcRecordInitializationInspector(files);
 return view=>{
  const component=components(view),region=widgets(view),record=records(view),source=files[view.chunk];
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),imports=new Map(),bindings={};
  const core='1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d',ui='c9565f2d4c2afd26a125afc65f1174e43703d235d4e76035da3fff6185299bca';
  for(const row of ast.body)if(row.type==='ImportDeclaration'&&typeof files[row.source.value.slice(2)]==='string'){
   const digest=hash(files[row.source.value.slice(2)]);
   for(const spec of row.specifiers)if(spec.type==='ImportSpecifier'){
    const exp=spec.imported.name;imports.set(spec.local.name,{digest,exp});
    const kind=digest===core?{a:'naming',y:'conversions',M:'modelSdk',w:'types'}[exp]:digest===ui?{n:'spanHook'}[exp]:undefined;
    if(kind)bindings[spec.local.name]=kind;
   }
  }
  const imported=(n,digest,exp)=>n?.type==='Identifier'&&imports.get(n.name)?.digest===digest&&imports.get(n.name)?.exp===exp;
  for(const row of ast.body)for(const d of row.type==='VariableDeclaration'?row.declarations:[]){
   if(d.id.type!=='Identifier')continue;const call=d.init;
   if(call?.type!=='CallExpression')continue;
   if(imported(call.callee,core,'c')&&call.arguments.length===1&&call.arguments[0].type==='CallExpression'&&
    imported(call.arguments[0].callee,ui,'a')&&call.arguments[0].arguments.length===0)bindings[d.id.name]='react';
   if(d.start>=region.start&&d.end<=region.end&&imported(call.callee,ui,'m'))bindings[d.id.name]='widget';
  }
  const render=source.slice(component.renderRange.start,component.renderRange.end);
  const result=inspectOdcRenderExpressions(render,{bindings,fields:record.record.fields,blocks:view.blockComponents});
  return {...result,viewKey:view.key,viewSourceSha256:hash(source),sdkHashes:[core,ui],
   requiresViewImportQualification:true,pending:['complete-view-import','deferred-interaction-model-effects','native-render-and-lifecycle-observation'],
   viewInitializationQualified:false,executionAuthorized:false};
 };
}
