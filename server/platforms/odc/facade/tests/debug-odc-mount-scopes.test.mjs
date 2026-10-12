import test from 'node:test';import assert from 'node:assert/strict';
import {expandMountLifecycleScopes,mountLifecycleScopesIssues,mountLifecycleLimits} from '../debug-odc-mount-scopes.mjs';
const M='7WNw7ud8AEKh1ftGQYhllg',sha='a'.repeat(64);
const key=(p,i)=>(p+String(i).padStart(4,'0')).padEnd(22,'x').slice(0,22);
// The r3 fixture shape: a screen with four declared handlers and a block with five.
const screenHandlers=['onInitializeEventHandler','onReadyEventHandler','onRenderEventHandler','onDestroyEventHandler'];
const blockHandlers=[...screenHandlers,'onParametersChangedEventHandler'];
function prepared(counts=[4,5]){
 const views=counts.map((count,v)=>({key:key('View',v),handlers:Array.from({length:count},(_,i)=>({handler:(v?blockHandlers:screenHandlers)[i%5]??'onRenderEventHandler',actionKey:key('Act'+v+'_',i)})),
  absentHandlers:['onSyncStartEventHandler']}));
 return {entry:{key:views[0].handlers[0].actionKey},sourceContract:{path:'C:/published/model.oml',sha256:sha},mount:{screenKey:views[0].key,views}};
}
function tree(actionKey,{ends=1,disabledEnd=false,starts=1}={}){
 return {key:actionKey,kind:'ScreenAction',children:[
  ...Array.from({length:starts},(_,i)=>({key:key('S'+actionKey.slice(3,9),i),kind:'StartNode',properties:{IsDisabled:'False'}})),
  {key:key('A'+actionKey.slice(3,9),0),kind:'AssignNode',properties:{IsDisabled:'False'}},
  ...Array.from({length:ends},(_,i)=>({key:key('E'+actionKey.slice(3,9),i),kind:'EndNode',properties:{IsDisabled:disabledEnd&&i===0?'True':'False'}})),
  {key:key('L'+actionKey.slice(3,9),0),kind:'LocalVariable'}]};
}
function readers(options={}){
 const reads=[],trees=[];
 return {reads,trees,readTree:async path=>{trees.push(path);return options.tree?.(path.slice(1))??tree(path.slice(1),options);},
  readScopes:async input=>{reads.push(input);
   return {modules:[{moduleKey:input.moduleKey,sourceSha256:sha}],variables:[],evidence:['scope-0.json'],
    functionHashes:(options.hashes??input.scopes).map(s=>({moduleKey:input.moduleKey,functionKey:s.functionKey,debuggerHash:'h'.repeat(22),sourceSha256:sha})),
    breakpoints:input.scopes.flatMap(s=>s.nodeKeys.map(n=>input.moduleKey+':'+n))};}};
}
test('mount-lifecycle expands every declared screen and block handler to its Start and End nodes, read through the scope reader',async()=>{
 const p=prepared(),r=readers();
 const result=await expandMountLifecycleScopes(p,r.readScopes,{readTree:r.readTree,moduleKey:M,directory:'C:/session'});
 assert.equal(result.scopesFrom,'mount-lifecycle');assert.equal(result.scopes.length,9);
 assert.deepEqual(result.roots.map(x=>x.handler),[...screenHandlers,...blockHandlers]);
 assert.deepEqual(result.scopes.map(s=>s.functionKey),p.mount.views.flatMap(v=>v.handlers.map(h=>h.actionKey)));
 for(const scope of result.scopes)assert.deepEqual(scope.nodeKeys,[key('S'+scope.functionKey.slice(3,9),0),key('E'+scope.functionKey.slice(3,9),0)]);
 assert.equal(r.reads.length,1);assert.deepEqual(r.reads[0].scopes,result.scopes);
 assert.equal(r.reads[0].lane,'odc');assert.equal(r.reads[0].runtime,'client');assert.equal(r.reads[0].moduleKey,M);
 assert.deepEqual(r.reads[0].source,p.sourceContract);assert.equal(r.reads[0].directory,'C:/session');
 // The session reuses this exact read instead of reading the same scopes twice.
 assert.deepEqual(result.metadata.breakpoints,result.scopes.flatMap(s=>s.nodeKeys.map(n=>M+':'+n)));
 assert.deepEqual(r.trees,result.scopes.map(s=>'@'+s.functionKey));
});
test('every reachable End node is a breakpoint; disabled ones are not',async()=>{
 const r=readers({ends:3,disabledEnd:true}),result=await expandMountLifecycleScopes(prepared([1]),r.readScopes,{readTree:r.readTree,moduleKey:M,directory:'C:/s'});
 assert.equal(result.scopes[0].nodeKeys.length,3);
});
test('refused for isolated runs, malformed flows and a scope reader that does not confirm every node',async()=>{
 const r=readers();
 for(const p of [{...prepared(),mount:undefined},{...prepared(),mount:{views:[]}},{...prepared(),sourceContract:undefined}])
  await assert.rejects(expandMountLifecycleScopes(p,r.readScopes,{readTree:r.readTree,moduleKey:M,directory:'C:/s'}),/debug_odc_mount_scopes_/);
 assert.equal(r.trees.length,0);assert.equal(r.reads.length,0);
 for(const options of [{starts:2},{ends:0},{tree:k=>({...tree(k),key:'Other'.padEnd(22,'x')})}]){
  const bad=readers(options);
  await assert.rejects(expandMountLifecycleScopes(prepared([1]),bad.readScopes,{readTree:bad.readTree,moduleKey:M,directory:'C:/s'}),/debug_odc_mount_scopes_flow_unresolved/);
  assert.equal(bad.reads.length,0);
 }
 const partial=readers({hashes:[]});
 await assert.rejects(expandMountLifecycleScopes(prepared([1]),partial.readScopes,{readTree:partial.readTree,moduleKey:M,directory:'C:/s'}),/debug_odc_mount_scopes_scope_unconfirmed/);
});
test('explicit cap of 40 functions applies before any model read',async()=>{
 assert.equal(mountLifecycleLimits.functions,40);
 const r=readers();
 await assert.rejects(expandMountLifecycleScopes(prepared([21,20]),r.readScopes,{readTree:r.readTree,moduleKey:M,directory:'C:/s'}),/debug_odc_mount_scopes_cap_exceeded/);
 assert.equal(r.trees.length,0);
 const ok=readers();assert.equal((await expandMountLifecycleScopes(prepared([20,20]),ok.readScopes,{readTree:ok.readTree,moduleKey:M,directory:'C:/s'})).scopes.length,40);
 const wide=readers({ends:mountLifecycleLimits.nodesPerFunction});
 await assert.rejects(expandMountLifecycleScopes(prepared([1]),wide.readScopes,{readTree:wide.readTree,moduleKey:M,directory:'C:/s'}),/debug_odc_mount_scopes_cap_exceeded/);
});
test('session schema rule: scopesFrom only for mounted runs and never together with explicit scopes',()=>{
 assert.deepEqual(mountLifecycleScopesIssues({run:{lifecycle:'mounted'},scopesFrom:'mount-lifecycle'}),[]);
 assert.deepEqual(mountLifecycleScopesIssues({run:{lifecycle:'mounted'},scopes:[{functionKey:M,nodeKeys:[M]}]}),[]);
 assert.ok(mountLifecycleScopesIssues({run:{},scopesFrom:'mount-lifecycle'}).length);
 assert.ok(mountLifecycleScopesIssues({run:{lifecycle:'isolated'},scopesFrom:'mount-lifecycle'}).length);
 assert.ok(mountLifecycleScopesIssues({run:{lifecycle:'mounted'},scopesFrom:'mount-lifecycle',scopes:[{functionKey:M,nodeKeys:[M]}]}).length);
 assert.ok(mountLifecycleScopesIssues({run:{lifecycle:'mounted'},scopesFrom:'everything'}).length);
});
