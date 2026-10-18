import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{createHash,randomUUID}from'node:crypto';
import{observeO11OrphanedClient,freshProcessAbsence}from'../debug-o11-client-orphan-observation.mjs';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'orphan-observation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const operationId=randomUUID(),sessionId=randomUUID(),moduleKey='A'.repeat(22),dir=path.join(root,'.local/debugger/native-runs/o11/example.test',operationId);
 fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.join(root,'.local/debugger/client-reconciliations'),{recursive:true});
 const file=path.join(dir,'receipt.json'),lock=path.join(path.dirname(dir),moduleKey+'.lock');
 fs.writeFileSync(file,JSON.stringify({target:{moduleKey}}));fs.writeFileSync(lock,JSON.stringify({operationId,pid:123}));
 const vaultRoot=path.join(root,'vault');fs.mkdirSync(vaultRoot);fs.mkdirSync(path.join(vaultRoot,'profiles'));
 const codex=path.join(root,'legacy','codex','SSAM','DebugAppUser');fs.mkdirSync(codex,{recursive:true});
 const legacyRoots=[{origin:'package:OpenAI.Codex_2p2nqsd0c76g0',path:codex,writable:false,anchor:root}];
 const receipt={schema:'ssam-client-private-reconciliation/1',operationId,sessionId,privateCleanup:{completed:true},pins:[{path:file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}]};
 const observeProcesses=async ownerPid=>({ownerPid,ownerPresent:false,workerCount:0,unreadableNodeCount:0,observedAt:new Date().toISOString(),workerStopped:true,nativeDisposalConfirmed:false});
 return {root,receipt,lock,vaultRoot,legacyRoots,codex,observeProcesses};
}
test('fresh process absence and empty lease root prove cleanup without fabricating the action response',async t=>{
 const f=fixture(t),result=await observeO11OrphanedClient(f.root,f.receipt,f);
 assert.equal(result.workerStopped,true);assert.equal(result.credentialsReleased,true);
 assert.equal(result.executionComplete,false);assert.equal(result.mutexReleased,false);assert.ok(fs.existsSync(f.lock));
 assert.equal(result.credentialEvidence.savedProfilesRead,false);assert.ok(fs.existsSync(result.receiptPath));
 assert.equal(result.stateRoot,f.vaultRoot);assert.deepEqual(result.legacyInventory,[{origin:'package:OpenAI.Codex_2p2nqsd0c76g0',entries:0,readable:true}]);
 assert.deepEqual(result.pending,[]);
});
test('remaining leases and unavailable process inventory keep the respective proofs incomplete',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.vaultRoot,'unknown.dpapi'),'opaque');
 const result=await observeO11OrphanedClient(f.root,f.receipt,{...f,observeProcesses:async()=>{throw new Error('unavailable');}});
 assert.equal(result.workerStopped,false);assert.equal(result.credentialsReleased,false);assert.equal(result.credentialEvidence.leaseEntries,1);
 assert.ok(fs.existsSync(f.lock));
});
test('a lease in another package store keeps credentialsReleased:false with pending legacy-store:<PFN>',async t=>{
 const f=fixture(t),lease=path.join(f.codex,randomUUID()+'.dpapi');fs.writeFileSync(lease,'opaque');
 const result=await observeO11OrphanedClient(f.root,f.receipt,f);
 assert.equal(result.credentialsReleased,false);assert.deepEqual(result.pending,['legacy-store:OpenAI.Codex_2p2nqsd0c76g0']);
 assert.equal(result.credentialEvidence.leaseEntries,1);assert.equal(fs.readFileSync(lease,'utf8'),'opaque');
 assert.deepEqual(result.legacyInventory,[{origin:'package:OpenAI.Codex_2p2nqsd0c76g0',entries:1,readable:true}]);
});
test('a missing new root is an empty store; an unreadable legacy store is not',async t=>{
 const f=fixture(t);fs.rmSync(f.vaultRoot,{recursive:true});
 assert.equal((await observeO11OrphanedClient(f.root,f.receipt,f)).credentialsReleased,true);
 const blocked=await observeO11OrphanedClient(f.root,f.receipt,{...f,legacyRoots:[{origin:'packages',path:path.join(f.root,'Packages'),writable:false,unreadable:true,anchor:f.root}]});
 assert.equal(blocked.credentialsReleased,false);assert.equal(blocked.credentialEvidence.leaseEntries,null);assert.deepEqual(blocked.pending,['legacy-store:packages']);
});
test('fresh process absence is one shared rule: owner pid, no owner, no worker, readable nodes, under 60 s',()=>{
 const now=Date.parse('2026-10-11T10:00:00Z'),ok={ownerPid:7,ownerPresent:false,workerCount:0,unreadableNodeCount:0,workerStopped:true,observedAt:'2026-10-11T09:59:30Z'};
 assert.equal(freshProcessAbsence(ok,7,now),true);
 for(const patch of [{ownerPid:8},{ownerPresent:true},{workerCount:1},{unreadableNodeCount:1},{workerStopped:false},{observedAt:'2026-10-11T09:58:59Z'},{observedAt:'2026-10-11T10:01:01Z'},{observedAt:'x'}])
  assert.equal(freshProcessAbsence({...ok,...patch},7,now),false,JSON.stringify(patch));
 assert.equal(freshProcessAbsence(null,7,now),false);
});
test('an inconsistent claim of stopped processes is rejected',async t=>{
 const f=fixture(t);await assert.rejects(()=>observeO11OrphanedClient(f.root,f.receipt,{...f,observeProcesses:async pid=>({...await f.observeProcesses(pid),workerCount:1})}),/process_observation_invalid/);
 await assert.rejects(()=>observeO11OrphanedClient(f.root,f.receipt,{...f,observeProcesses:async pid=>({...await f.observeProcesses(pid),observedAt:'2000-01-01T00:00:00Z'})}),/process_observation_invalid/);
});
