import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {stageRenamePlan,stageRenameObservation,stageBatchRenamePlan,stageOrderPlan} from '../runtime/stage-rename.mjs';
const portfolioKey=crypto.randomUUID();
const stages=['Development','Test','Production'].map((name,order)=>({key:crypto.randomUUID(),name,order,purpose:name==='Test'?'NonProduction':name,portfolioKey,builtinDomain:name+'.example',defaultDomain:name+'.example'}));
const inventory=()=>({ok:true,data:{results:structuredClone(stages)}});
test('order swaps intermediate stages and restores the full inventory; partial apply does not confirm',()=>{
 const rows=[...stages.map((r,i)=>({...r,order:[0,100,1000][i]})),{...stages[1],key:crypto.randomUUID(),name:'Staging',order:200}];
 const p=stageOrderPlan({inventory:{ok:true,data:{results:rows}},updates:[{key:rows[1].key,order:200},{key:rows[3].key,order:100}]});
 assert.equal(p.after.find(r=>r.key===rows[1].key).order,200);assert.equal(p.after.find(r=>r.key===rows[3].key).order,100);
 for(const row of p.after){const original=rows.find(r=>r.key===row.key);assert.deepEqual({...row,order:original.order},original);}
 const restored=stageOrderPlan({inventory:{ok:true,data:{results:p.after}},updates:p.restore.body.environments});assert.deepEqual(restored.after,p.before);
 const partial=structuredClone(rows);partial[1].order=200;assert.equal(stageRenameObservation(p.after,{ok:true,data:{results:partial}}).verified,false);
 const withAnchors=stageOrderPlan({inventory:{ok:true,data:{results:rows}},updates:rows.map(r=>({key:r.key,order:r.key===rows[1].key?101:r.order}))});assert.equal(withAnchors.after.find(r=>r.key===rows[0].key).order,0);
 const single=stageOrderPlan({inventory:{ok:true,data:{results:rows}},updates:[{key:rows[1].key,order:101}],batch:false});assert.deepEqual(single.body,{order:101});assert.deepEqual(single.restore.body,{order:100});
 for(const changes of [[],[{key:rows[0].key,order:1}],[{key:rows[2].key,order:999}],[{key:rows[1].key,order:100}],[{key:rows[1].key,order:200}],
  [{key:rows[1].key,order:0}],[{key:rows[1].key,order:1000}],[{key:rows[1].key,order:NaN}],[{key:rows[1].key,order:100.5}],[{key:crypto.randomUUID(),order:150}],
  [{key:rows[1].key,order:150,name:'Unapproved'}],[{key:rows[1].key,order:150},{key:rows[1].key,order:160}]])assert.throws(()=>stageOrderPlan({inventory:{ok:true,data:{results:rows}},updates:changes}));
 const noAnchor=rows.filter(r=>r.purpose!=='Production');assert.throws(()=>stageOrderPlan({inventory:{ok:true,data:{results:noAnchor}},updates:[{key:rows[1].key,order:150}]}));
});
test('batch rename binds every changed key and preserves remaining stages; partial application is not confirmation',()=>{
 const updates=stages.slice(0,2).map((r,i)=>({key:r.key,name:'Temporary'+i}));
 const p=stageBatchRenamePlan({inventory:inventory(),updates});
 assert.equal(p.targets.length,2);assert.equal(p.after.find(r=>r.key===stages[2].key).name,'Production');
 const restored=stageBatchRenamePlan({inventory:{ok:true,data:{results:p.after}},updates:p.restore.body.environments});
 assert.deepEqual(restored.after,p.before);
 const partial=inventory();partial.data.results[0].name=updates[0].name;
 assert.equal(stageRenameObservation(p.after,partial).verified,false);
 for(const changes of [[],[updates[0],updates[0]],[{...updates[0],order:100}], [{...updates[0],key:crypto.randomUUID()}],
  [{...updates[0],name:'Production'}],updates.map(r=>({...r,name:'Collision'}))])assert.throws(()=>stageBatchRenamePlan({inventory:inventory(),updates:changes}));
});
test('stage rename preserves every visible stage, order and domain; concurrent changes prevent restoration',()=>{
 const p=stageRenamePlan({inventory:inventory(),environmentKey:stages[1].key,name:'Temporary'});
 assert.deepEqual(p.body,{name:'Temporary'});assert.deepEqual(p.restore.body,{name:'Test'});
 const changed={ok:true,data:{results:structuredClone(p.after)}};
 assert.equal(stageRenameObservation(p.after,changed).verified,true);
 changed.data.results.reverse();assert.equal(stageRenameObservation(p.after,changed).verified,true);
 changed.data.results[0].defaultDomain='changed.example';assert.equal(stageRenameObservation(p.after,changed).verified,false);
 const restored=stageRenamePlan({inventory:{ok:true,data:{results:p.after}},environmentKey:stages[1].key,name:'Test'});
 assert.deepEqual(restored.after,p.before);
 for(const name of ['',' ',null,'Test','Development','x'.repeat(51)])assert.throws(()=>stageRenamePlan({inventory:inventory(),environmentKey:stages[1].key,name}));
 for(const mutate of [i=>i.ok=false,i=>i.data.results.push(stages[0]),i=>delete i.data.results[0].portfolioKey,i=>i.data.results[0].order='0']){
  const i=inventory();mutate(i);assert.throws(()=>stageRenamePlan({inventory:i,environmentKey:stages[1].key,name:'Temporary'}));
  assert.equal(stageRenameObservation(p.after,i).verified,false);
 }
 assert.equal(stageRenameObservation(p.after,{ok:true,data:{results:p.after.slice(1)}}).verified,false);
});
