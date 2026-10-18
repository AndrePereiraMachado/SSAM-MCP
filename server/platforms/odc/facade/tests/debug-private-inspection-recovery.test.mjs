import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {recoverExpiredClientInspection} from '../debug-private-inspection-recovery.mjs';
const target={sessionId:'a'.repeat(48),lane:'o11',moduleKey:'B'.repeat(22),runtimeUrl:'https://example.test/App/'};
// stateRoot is the new writable store; legacyRoots are fake read-only copies. Forget removes only writable copies.
function fixture(t,{legacy=[]}={}){const top=fs.mkdtempSync(path.join(os.tmpdir(),'private-recovery-'));t.after(()=>fs.rmSync(top,{recursive:true,force:true}));
 const directory=path.join(top,'state','invoke');fs.mkdirSync(directory,{recursive:true});
 const legacyRoots=legacy.map(({origin,writable=false})=>{const dir=path.join(top,origin.replace(/[^A-Za-z0-9._-]/g,'_'),'SSAM','DebugInvoke');fs.mkdirSync(dir,{recursive:true});return {origin,path:dir,writable,anchor:top};});
 const records=new Map(),opened=[],forgotten=[];
 const vault=(op,ref,_value,options)=>{if(op==='Open'){opened.push({ref,sourceRoot:options?.sourceRoot});return structuredClone(records.get(ref));}
  forgotten.push(ref);for(const dir of [directory,...legacyRoots.filter(r=>r.writable).map(r=>r.path)]){const file=path.join(dir,ref+'.dpapi');if(fs.existsSync(file))fs.unlinkSync(file);}records.delete(ref);return {ok:true};};
 const add=(patch,dir=directory)=>{const ref=randomUUID(),record={schema:'ssam-private-inspection/1',context:{sessionId:target.sessionId,runtime:'client',platform:target.lane},binding:{...target},expiresAt:new Date(Date.now()-10000).toISOString(),value:'PRIVATE-VALUE',...patch};records.set(ref,record);fs.writeFileSync(path.join(dir,ref+'.dpapi'),'sealed');return ref;};
 return {top,directory,stateRoot:directory,legacyRoots,vault,add,records,opened,forgotten};}
const options=f=>({stateRoot:f.stateRoot,legacyRoots:f.legacyRoots,vault:f.vault});
test('recovery removes only expired values of the exact inspector and keeps execution unknown',t=>{
 const f=fixture(t),mine=f.add(),other=f.add({context:{sessionId:'c'.repeat(48)}});
 const preview=recoverExpiredClientInspection(target,options(f));assert.equal(preview.pending,1);assert.equal(f.records.has(mine),true);
 const result=recoverExpiredClientInspection(target,{...options(f),dryRun:false});assert.equal(result.completed,true);assert.equal(result.removed,1);
 assert.equal(f.records.has(other),true);assert.equal(result.executionComplete,false);assert.equal(result.mutexReleased,false);
 assert.equal(result.stateRoot,f.stateRoot);assert.deepEqual(result.legacyInventory,[]);assert.deepEqual(result.pendingStores,[]);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE-VALUE/);
});
test('unexpired or mismatched records are retained; unreadable records prevent a cleanup claim',t=>{
 const f=fixture(t);f.add({expiresAt:new Date(Date.now()+60000).toISOString()});f.add({binding:{...target,moduleKey:'D'.repeat(22)}});
 fs.writeFileSync(path.join(f.directory,'malformed.dpapi'),'sealed');
 const result=recoverExpiredClientInspection(target,{...options(f),dryRun:false});assert.equal(result.completed,false);
 assert.equal(result.removed,0);assert.equal(result.unexpired,1);assert.equal(result.failed,1);assert.equal(result.unreadable,1);
});
test('changed ciphertext and an invalid clock cannot authorize deletion',t=>{
 const f=fixture(t),ref=f.add();
 assert.throws(()=>recoverExpiredClientInspection(target,{...options(f),clock:()=>NaN,dryRun:false}),/clock_invalid/);
 const original=f.vault;const result=recoverExpiredClientInspection(target,{...options(f),dryRun:false,vault:(op,id,v,o)=>{
  const value=original(op,id,v,o);if(op==='Open')fs.writeFileSync(path.join(f.directory,id+'.dpapi'),'replaced');return value;
 }});
 assert.equal(result.changed,1);assert.equal(result.completed,false);assert.equal(f.records.has(ref),true);
});
test('a missing current root no longer proves cleanup: a matching record in another package store keeps it incomplete',t=>{
 const f=fixture(t,{legacy:[{origin:'current',writable:true},{origin:'package:OpenAI.Codex_2p2nqsd0c76g0'}]});
 fs.rmSync(f.directory,{recursive:true});fs.rmSync(f.legacyRoots[0].path,{recursive:true});
 const codex=f.legacyRoots[1].path,ref=f.add({},codex);f.add({context:{sessionId:'c'.repeat(48)}},codex);
 const result=recoverExpiredClientInspection(target,{...options(f),dryRun:false});
 assert.equal(result.completed,false);assert.deepEqual(result.pendingStores,['legacy-store:OpenAI.Codex_2p2nqsd0c76g0']);
 assert.equal(result.matched,1);assert.equal(result.removed,0);assert.equal(result.pending,1);
 assert.equal(fs.existsSync(path.join(codex,ref+'.dpapi')),true);assert.deepEqual(f.forgotten,[],'a read-only store is never forgotten');
 assert.ok(f.opened.every(o=>o.sourceRoot===codex),'legacy records open from their own store');
 assert.deepEqual(result.origins.map(o=>[o.origin,o.readable,o.writable,o.entries,o.matched,o.removed]),[
  ['state',true,true,0,0,0],['current',true,true,0,0,0],['package:OpenAI.Codex_2p2nqsd0c76g0',true,false,2,1,0]]);
 assert.deepEqual(result.legacyInventory,[{origin:'current',entries:0,readable:true},{origin:'package:OpenAI.Codex_2p2nqsd0c76g0',entries:2,readable:true}]);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE-VALUE/);
});
test('an expired record in the process view is removed; only non-matching records remain in package stores',t=>{
 const f=fixture(t,{legacy:[{origin:'current',writable:true},{origin:'package:Claude_pzs8sxrjxfjjc'}]});
 const mine=f.add({},f.legacyRoots[0].path);f.add({context:{sessionId:'c'.repeat(48)}},f.legacyRoots[1].path);
 const result=recoverExpiredClientInspection(target,{...options(f),dryRun:false});
 assert.equal(result.completed,true);assert.equal(result.removed,1);assert.equal(f.records.has(mine),false);
 assert.deepEqual(result.origins.find(o=>o.origin==='current').removed,1);
});
test('every enumerated store must be readable: an unreadable or reparse store fails closed',t=>{
 const f=fixture(t,{legacy:[{origin:'package:Evil.App_1'}]});
 const unreadable=[...f.legacyRoots,{origin:'packages',path:path.join(f.top,'Packages'),writable:false,unreadable:true,anchor:f.top}];
 const result=recoverExpiredClientInspection(target,{...options(f),legacyRoots:unreadable,dryRun:false});
 assert.equal(result.completed,false);assert.deepEqual(result.pendingStores,['legacy-store:packages']);
 assert.equal(result.origins.at(-1).readable,false);
});
