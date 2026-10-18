import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {readUserRoleUnion,USER_APPLICATION_ROLES as OP} from '../runtime/user-role-union.mjs';
import {OdcAccess} from '../runtime/access.mjs';import {Catalog} from '../runtime/catalog.mjs';
const uuid=()=>crypto.randomUUID(),assetKey=uuid(),environmentKey=uuid(),portfolioKey=uuid(),groupA=uuid(),groupB=uuid();
const base=(name,key=uuid())=>({key,name,assetKey,environmentKey,portfolioKey,externalKey:uuid(),claim:'Synthetic claim'});
const direct=role=>({...role,isDirectlyAssigned:true,assignedGroups:[]});
const inherited=(role,mapped=false)=>({...role,isDirectlyAssigned:false,assignedGroups:[{key:mapped?groupB:groupA,name:mapped?'Mapped group':'Assigned group',membershipType:mapped?'Mapped':'Assigned'}]});
const input=(query={})=>({path:{key:uuid()},query:{assignmentSources:['Direct','GroupAssigned','GroupMapped'],...query}});
function fixture(rows){const calls=[];return{calls,send:async request=>{calls.push(structuredClone(request));const q=request.query,all=rows[q.assignmentSources[0]],start=q.offset,end=start+q.limit,batch=all.slice(start,end);
 return{ok:true,operationId:OP,status:200,data:{results:structuredClone(batch),page:{limit:q.limit,offset:start,count:batch.length,totalResults:all.length,totalPages:Math.ceil(all.length/q.limit),nextPageOffset:end<all.length?end:null}}};}};}

test('merges direct and inherited evidence once per role without losing source groups',async()=>{
 const a=base('Alpha'),b=base('Beta'),c=base('Gamma'),h=fixture({Direct:[direct(a),direct(b)],GroupAssigned:[inherited(a),inherited(c)],GroupMapped:[inherited(a,true)]});
 const r=await readUserRoleUnion(OP,input(),h.send);assert.equal(r.ok,true);assert.equal(r.data.page.totalResults,3);assert.equal(r.data.results.length,3);
 const first=r.data.results[0];assert.equal(first.key,a.key);assert.equal(first.isDirectlyAssigned,true);assert.deepEqual(new Set(first.assignedGroups.map(g=>g.membershipType)),new Set(['Assigned','Mapped']));
 assert.deepEqual(r.assignmentResolution.sourceTotals,{Direct:2,GroupAssigned:2,GroupMapped:1});assert.equal(r.assignmentResolution.duplicatesMerged,2);assert.equal(r.assignmentResolution.atomicSnapshotVerified,false);
 assert.equal(h.calls.length,3);assert(h.calls.every(x=>x.query.assignmentSources.length===1&&x.query.offset===0&&x.query.limit===100));
});
test('global pages are sliced after de-duplication, including descending and empty pages',async()=>{
 const a=base('Alpha'),b=base('Beta'),c=base('Gamma'),rows={Direct:[direct(a),direct(c)],GroupAssigned:[inherited(a),inherited(b)],GroupMapped:[]};
 for(const [offset,expected,next]of [[0,a,1],[1,b,2],[2,c,null],[3,null,null]]){
  const h=fixture(rows),r=await readUserRoleUnion(OP,input({offset,limit:1}),h.send);assert.equal(r.data.page.totalResults,3);assert.equal(r.data.page.nextPageOffset,next);
  assert.deepEqual(r.data.results.map(x=>x.key),expected?[expected.key]:[]);assert(h.calls.every(x=>x.query.offset===0));
 }
 const r=await readUserRoleUnion(OP,input({sort:'-name',limit:2,offset:1}),fixture(rows).send);assert.deepEqual(r.data.results.map(x=>x.name),['Beta','Alpha']);
});
test('complete native paging has no duplicate/gap when a role overlaps source page boundaries',async()=>{
 const roles=Array.from({length:121},(_,i)=>base('Role'+String(i).padStart(3,'0'))),h=fixture({Direct:roles.map(direct),GroupAssigned:roles.slice(95,110).map(r=>inherited(r)),GroupMapped:[]});
 const r=await readUserRoleUnion(OP,input({offset:98,limit:7}),h.send);assert.deepEqual(r.data.results.map(x=>x.key),roles.slice(98,105).map(x=>x.key));
 assert.equal(r.data.page.totalResults,121);assert.equal(r.assignmentResolution.nativePages,4);assert.equal(r.assignmentResolution.duplicatesMerged,15);
 assert.deepEqual(h.calls.filter(x=>x.query.assignmentSources[0]==='Direct').map(x=>x.query.offset),[0,100]);
});
test('one native source and unrelated operations remain untouched; duplicate source selection normalizes',async()=>{
 const request=input({assignmentSources:['Direct'],limit:1,offset:5}),seen=[],send=async r=>{seen.push(r);return{ok:true,marker:'native'};};
 assert.deepEqual(await readUserRoleUnion(OP,request,send),{ok:true,marker:'native'});assert.equal(seen[0],request);
 await readUserRoleUnion('other',input(),send);assert.equal(seen.length,2);
 await readUserRoleUnion(OP,input({assignmentSources:['Direct','Direct']}),send);assert.deepEqual(seen.at(-1).query.assignmentSources,['Direct']);
});
for(const [name,change]of [
 ['wrong offset',r=>{r.data.page.offset=2;}],['wrong totalPages',r=>{r.data.page.totalPages=2;}],['wrong count',r=>{r.data.page.count=2;}],
 ['hidden continuation',r=>{r.data.page.nextPageOffset=100;}],['incomplete page',r=>{r.data.page.totalResults=2;}],['missing role identity',r=>{delete r.data.results[0].externalKey;}],
 ['wrong direct flag',r=>{r.data.results[0].isDirectlyAssigned=false;}],['hidden group on direct source',r=>{r.data.results[0].assignedGroups=[{key:groupA,name:'Group',membershipType:'Assigned'}];}],
 ['duplicate native key',r=>{r.data.results.push(structuredClone(r.data.results[0]));r.data.page.count=2;r.data.page.totalResults=2;}]
])test('union refuses '+name+' without returning a partial page',async()=>{
 const a=base('Alpha'),h=fixture({Direct:[direct(a)],GroupAssigned:[],GroupMapped:[]});
 await assert.rejects(readUserRoleUnion(OP,input(),async q=>{const r=await h.send(q);if(q.query.assignmentSources[0]==='Direct')change(r);return r;}),e=>e.code==='USER_ROLE_UNION_UNVERIFIED');
});
test('cross-source identity/name drift and mapped membership mismatch refuse',async()=>{
 const a=base('Alpha');let h=fixture({Direct:[direct(a)],GroupAssigned:[inherited({...a,name:'Changed'})],GroupMapped:[]});
 await assert.rejects(readUserRoleUnion(OP,input(),h.send),e=>e.code==='USER_ROLE_UNION_UNVERIFIED');
 h=fixture({Direct:[],GroupAssigned:[inherited(a,true)],GroupMapped:[]});await assert.rejects(readUserRoleUnion(OP,input(),h.send),e=>e.code==='USER_ROLE_UNION_UNVERIFIED');
});
test('foreign scope is refused instead of filtering away evidence of a broken native filter',async()=>{
 const a=base('Alpha');for(const query of [{assetKey:uuid()},{environmentKey:uuid()},{portfolioKeys:[uuid()]},{applicationRoleKeys:[uuid()]},{groupKeys:[uuid()]},{nameContains:'Missing'}]){
  const h=fixture({Direct:[direct(a)],GroupAssigned:[],GroupMapped:[]});await assert.rejects(readUserRoleUnion(OP,input(query),h.send),e=>e.code==='USER_ROLE_UNION_UNVERIFIED');
 }
});
test('filter arguments survive every source page',async()=>{
 const a=base('Alpha'),h=fixture({Direct:[direct(a)],GroupAssigned:[],GroupMapped:[]}),q={assetKey,environmentKey,portfolioKeys:[portfolioKey],applicationRoleKeys:[a.key],nameContains:'Al',limit:1,offset:0};
 const r=await readUserRoleUnion(OP,input(q),h.send);assert.equal(r.data.page.totalResults,1);
 for(const request of h.calls)for(const [key,value]of Object.entries(q))if(!['limit','offset'].includes(key))assert.deepEqual(request.query[key],value);
});
test('source failures remain failures with no partial source data',async()=>{
 const a=base('Alpha'),h=fixture({Direct:[direct(a)],GroupAssigned:[],GroupMapped:[]});
 const r=await readUserRoleUnion(OP,input(),q=>q.query.assignmentSources[0]==='GroupAssigned'?{ok:false,status:403,error:{code:'FORBIDDEN'},data:{results:[direct(a)]}}:h.send(q));
 assert.equal(r.ok,false);assert.equal(r.status,403);assert.equal(r.data,undefined);assert.equal(r.assignmentResolution.complete,false);
});
test('invalid limit/offset/sort fails before any transport and bounded scans never return partial success',async()=>{
 let calls=0;for(const query of [{limit:0},{limit:101},{offset:-1},{sort:'unsupported'},{sort:12}])await assert.rejects(readUserRoleUnion(OP,input(query),async()=>{calls++;}),e=>e.code==='INPUT_INVALID');assert.equal(calls,0);
 const roles=Array.from({length:3101},(_,i)=>base('Role'+i)),h=fixture({Direct:roles.map(direct),GroupAssigned:[],GroupMapped:[]});
 await assert.rejects(readUserRoleUnion(OP,input(),h.send),e=>e.code==='USER_ROLE_UNION_LIMIT');assert(h.calls.length<=30);
});
test('public access path executes the union under the requested tenant and auth, without writes',async()=>{
 const a=base('Alpha'),b=base('Beta'),h=fixture({Direct:[direct(a),direct(b)],GroupAssigned:[inherited(a)],GroupMapped:[]}),access=new OdcAccess({catalog:new Catalog()});
 access.resolvePublic=async(host,auth)=>{assert.equal(host,'example.outsystems.dev');assert.equal(auth,'api-client');return{path:'vault',host};};
 access.send=async(host,_resolved,op,request,mode)=>{assert.equal(host,'example.outsystems.dev');assert.equal(op,OP);assert.equal(mode.write,false);return h.send(request);};
 const r=await access.read({tenant:'example.outsystems.dev',auth:'api-client',operationId:OP,...input({limit:1,offset:1})});assert.equal(r.ok,true);assert.equal(r.data.results[0].key,b.key);assert.equal(r.data.page.totalResults,2);assert.equal(r.auth.path,'vault');
});
