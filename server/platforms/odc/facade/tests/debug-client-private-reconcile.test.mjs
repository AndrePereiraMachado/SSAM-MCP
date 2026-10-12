import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{randomUUID}from'node:crypto';
import{reconcileClientPrivateValues as reconcileActual}from'../debug-client-private-reconcile.mjs';
const reconcileClientPrivateValues=(root,session,id,services)=>reconcileActual(root,session,id,{...services,
 observeOrphan:services?.observeOrphan??(async()=>({workerStopped:false,credentialsReleased:false}))});
// A recovery result under the store rule: it names its state root and the legacy stores it read.
const cleanup=(patch={})=>({completed:true,pending:0,stateRoot:'C:\\fixture\\.ssam-hybrid\\debugger\\invoke',legacyInventory:[],pendingStores:[],...patch});
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'client-reconcile-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const operationId=randomUUID(),sessionId=randomUUID(),host='fixture.example',moduleKey='A'.repeat(22),functionKey='B'.repeat(22),sourceSha256='c'.repeat(64);
 const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
 const scope=path.join(root,'.local/debugger/client-sessions',sessionId,'scope.json');write(scope,{data:{moduleKey,functionKey,sourceSha256}});
 const session={sessionId,lane:'o11',runtime:'client',state:'ending',metadataEvidence:[scope],pause:{sessionId:'d'.repeat(48),expiresAt:new Date(Date.now()-1000).toISOString(),frame:0,frames:[{elementKey:moduleKey+':'+functionKey+':'}]}};
 const sessionFile=path.join(root,'.local/debugger/client-sessions',sessionId+'.json');write(sessionFile,session);
 const receiptPath=path.join(root,'.local/debugger/native-runs/o11',host,operationId,'receipt.json');
 const run={schema:'ssam-o11-native-run/1',operationId,op:'run',receiptPath,target:{host,moduleKey,runtimeUrl:'https://fixture.example/App/'},published:{sourceSha256}};write(receiptPath,run);
 return {root,session,operationId,scope,run,write,receiptPath,sessionFile};
}
test('orphan cleanup has a durable public receipt without clearing execution uncertainty or a mutex',async t=>{
 const f=fixture(t);let calls=0;const r=await reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:(binding,options)=>{
  calls++;assert.equal(binding.sessionId,f.session.pause.sessionId);assert.equal(options.dryRun,false);return cleanup();
 }});assert.equal(calls,1);assert.equal(r.state,'requires-reconciliation');assert.equal(r.mutexReleased,false);assert.equal(r.executionComplete,false);
 assert.equal(r.replayed,false);assert.equal(JSON.parse(fs.readFileSync(r.receiptPath)).privateCleanup.completed,true);
 assert.equal(r.stateRoot,cleanup().stateRoot);assert.deepEqual(r.legacyInventory,[]);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.sessionFile)),f.session);
 const repeated=await reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>assert.fail('must reuse receipt')});
 assert.deepEqual(repeated,r);
});
test('lost cleanup response retains its intent and cannot be submitted a second time',async t=>{
 const f=fixture(t);await assert.rejects(()=>reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>{throw new Error('lost');}}),/lost/);
 await assert.rejects(()=>reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>assert.fail('no replay')}),/recovery_outcome_unconfirmed/);
});
test('different source, module, live lease or changed session cannot trigger vault cleanup',async t=>{
 for(const mutate of [f=>{f.run.published.sourceSha256='e'.repeat(64);f.write(f.receiptPath,f.run);},
  f=>{delete f.run.published;f.write(f.receiptPath,f.run);},
  f=>{f.run.target.moduleKey='F'.repeat(22);f.write(f.receiptPath,f.run);},
  f=>{f.session.pause.expiresAt=new Date(Date.now()+60000).toISOString();f.write(f.sessionFile,f.session);},
  f=>{f.write(f.sessionFile,{...f.session,state:'completed'});},
 ]){const f=fixture(t);mutate(f);await assert.rejects(()=>reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>assert.fail('must not touch vault')}),/debug_client_reconcile_/);}
});
test('records left in another package store are pending legacy-store:<PFN>, and orphan observation is not run',async t=>{
 const f=fixture(t);let observed=0;
 const r=await reconcileClientPrivateValues(f.root,f.session,f.operationId,{observeOrphan:async()=>{observed++;return {};},
  recover:()=>cleanup({completed:false,pending:1,pendingStores:['legacy-store:OpenAI.Codex_2p2nqsd0c76g0'],
   legacyInventory:[{origin:'package:OpenAI.Codex_2p2nqsd0c76g0',entries:1,readable:true}]})});
 assert.deepEqual(r.pending.slice(0,2),['private-inspection-cleanup','legacy-store:OpenAI.Codex_2p2nqsd0c76g0']);
 assert.deepEqual(r.legacyInventory,[{origin:'package:OpenAI.Codex_2p2nqsd0c76g0',entries:1,readable:true}]);assert.equal(observed,0);
});
test('a lease the orphan observation finds in another package store stays pending',async t=>{
 const f=fixture(t);
 const r=await reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>cleanup(),
  observeOrphan:async()=>({workerStopped:true,credentialsReleased:false,pending:['legacy-store:Claude_pzs8sxrjxfjjc']})});
 assert.equal(r.workerStopped,true);assert.equal(r.credentialsReleased,false);
 assert.ok(r.pending.includes('app-user-credential-release'));assert.ok(r.pending.includes('legacy-store:Claude_pzs8sxrjxfjjc'));
 assert.ok(!r.pending.includes('worker-termination-evidence'));
});
test('a receipt written before the store rule is re-checked additively, never rewritten or trusted',async t=>{
 const f=fixture(t);
 const old=await reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>({completed:true,pending:0})});
 const original=fs.readFileSync(old.receiptPath);let calls=0;
 const r=await reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:(binding,options)=>{calls++;assert.equal(options.dryRun,false);
  return cleanup({completed:false,pending:1,pendingStores:['legacy-store:OpenAI.Codex_2p2nqsd0c76g0']});}});
 assert.equal(calls,1);assert.deepEqual(fs.readFileSync(old.receiptPath),original,'historical receipt is never rewritten');
 assert.equal(r.supersedes,old.receiptPath);assert.notEqual(r.receiptPath,old.receiptPath);assert.ok(fs.existsSync(r.receiptPath));
 assert.equal(r.privateCleanup.completed,false);assert.deepEqual(r.previousPrivateCleanup,{completed:true,pending:0});
 assert.ok(r.pending.includes('legacy-store:OpenAI.Codex_2p2nqsd0c76g0'));
 const again=await reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>assert.fail('re-check outcome is reused')});
 assert.deepEqual(again,r);
});
// Public aborted reconcile (debug-o11-client-aborted-reconcile.mjs) for zero-submission client runs.
const released=async()=>({workerStopped:true,credentialsReleased:true,pending:[]});
const archived=(extra={})=>({ok:true,schema:'ssam-o11-client-aborted-reconciliation/1',state:'reconciled-client-aborted',executionOutcome:'aborted-unconfirmed',mutexArchived:true,...extra});
test('chains into the aborted reconcile only when pending is exactly execution-outcome',async t=>{
 const f=fixture(t),calls=[];
 const reconcileAborted=async(root,session,operationId,options)=>{calls.push({root,session,operationId,options});return archived();};
 const r=await reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>cleanup(),observeOrphan:released,reconcileAborted,abortedReceipt:()=>null});
 assert.equal(calls.length,1);assert.equal(calls[0].operationId,f.operationId);assert.deepEqual(calls[0].session,f.session);
 assert.deepEqual(calls[0].options.privateReceipt.pending,['execution-outcome']);assert.equal(calls[0].options.privateReceipt.privateCleanup.completed,true);
 assert.equal(r.clientAbortedReconciliation.state,'reconciled-client-aborted');assert.deepEqual(r.pending,[]);
 assert.equal(r.mutexReleased,true);assert.equal(r.executionOutcome,'aborted-unconfirmed');assert.equal(r.executionComplete,false);assert.equal(r.replayed,false);
 // Repeat after the archive: the lock is gone, so the orphan observation is not re-run and the outcome is the same.
 const again=await reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>assert.fail('reused'),
  observeOrphan:()=>assert.fail('archived run is not observed again'),reconcileAborted,abortedReceipt:()=>archived()});
 assert.deepEqual(again,r);assert.equal(calls.length,2);
 for(const observeOrphan of [async()=>({workerStopped:false,credentialsReleased:true,pending:[]}),async()=>({workerStopped:true,credentialsReleased:false,pending:[]}),
  async()=>({workerStopped:true,credentialsReleased:true,pending:['legacy-store:OpenAI.Codex_2p2nqsd0c76g0']})]){
  const g=fixture(t);const o=await reconcileClientPrivateValues(g.root,g.session,g.operationId,{recover:()=>cleanup(),observeOrphan,
   reconcileAborted:()=>assert.fail('must not chain'),abortedReceipt:()=>null});
  assert.ok(o.pending.length>1||o.pending[0]!=='execution-outcome');assert.equal(o.clientAbortedReconciliation,undefined);
 }
 const g=fixture(t);const o=await reconcileClientPrivateValues(g.root,g.session,g.operationId,{recover:()=>cleanup({completed:false,pending:1}),observeOrphan:released,
  reconcileAborted:()=>assert.fail('cleanup incomplete'),abortedReceipt:()=>null});
 assert.ok(o.pending.includes('private-inspection-cleanup'));
});
test('a refused aborted reconcile keeps execution-outcome pending',async t=>{
 const f=fixture(t);
 const r=await reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>cleanup(),observeOrphan:released,abortedReceipt:()=>null,
  reconcileAborted:async()=>{throw new Error('debug_o11_client_aborted_reconcile_submission_observed');}});
 assert.deepEqual(r.pending,['execution-outcome']);assert.equal(r.mutexReleased,false);
 assert.deepEqual(r.clientAbortedReconciliation,{ok:false,error:'debug_o11_client_aborted_reconcile_submission_observed'});
 await assert.rejects(()=>reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>cleanup(),observeOrphan:released,abortedReceipt:()=>null,
  reconcileAborted:async()=>{throw new Error('disk failure');}}),/disk failure/);
});
test('a terminal uncertain session carrying runResult goes straight to the aborted reconcile',async t=>{
 const f=fixture(t);const{pause,...rest}=f.session;const session={...rest,state:'uncertain',runResult:{...f.run}};f.write(f.sessionFile,session);let calls=0;
 const r=await reconcileClientPrivateValues(f.root,session,f.operationId,{recover:()=>assert.fail('no native pause to recover'),observeOrphan:()=>assert.fail('not observed here'),
  reconcileAborted:async(root,s,operationId,options)=>{calls++;assert.deepEqual(s,session);assert.equal(operationId,f.operationId);assert.equal(options.privateReceipt,undefined);return archived({sessionState:'uncertain'});}});
 assert.equal(calls,1);assert.equal(r.state,'reconciled-client-aborted');
 // Without runResult, or bound to another operation, the uncertain session stays not eligible.
 for(const s of [rest&&{...rest,state:'uncertain'},{...session,runResult:{...f.run,operationId:randomUUID()}}])
  await assert.rejects(()=>reconcileClientPrivateValues(f.root,s,f.operationId,{recover:()=>assert.fail(),reconcileAborted:()=>assert.fail()}),/not_eligible/);
});
test('a lost re-check response is not replayed',async t=>{
 const f=fixture(t);await reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>({completed:true,pending:0})});
 await assert.rejects(()=>reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>{throw new Error('lost');}}),/lost/);
 await assert.rejects(()=>reconcileClientPrivateValues(f.root,f.session,f.operationId,{recover:()=>assert.fail('no replay')}),/recovery_outcome_unconfirmed/);
});
