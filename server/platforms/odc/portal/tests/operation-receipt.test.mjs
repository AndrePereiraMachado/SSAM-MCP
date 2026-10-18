import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {operationReceipt,confirmOperationReceipt,packagingReceipt,confirmPackagingReceipt} from '../runtime/operation-receipt.mjs';
import {OPERATION_STATUS} from '../runtime/effects.mjs';
const spec={start:'start-analysis',read:'read-analysis',key:'analysisKey',param:'analysisKey',field:'status'};
const uuid='11111111-1111-4111-8111-111111111111';
test('native build confirmation binds application, server build, platform and package version',()=>{
 const spec=OPERATION_STATUS['native-build'];
 const target={applicationKey:'app',buildKey:'server-build',revision:1,mobilePlatform:'Android',mobileVersionNumber:'0.1.0',mobileVersionCode:1};
 const receipt={state:'accepted',identity:{target}},journal={reconcile:r=>({...r,state:'confirmed'})};
 const args={spec,operationKey:'native-build',data:{key:'native-build',status:'Finished',...target},terminal:true,failed:false};
 assert.equal(confirmOperationReceipt(journal,receipt,args).state,'confirmed');
 for(const field of Object.keys(target))for(const value of [undefined,'different'])assert.throws(()=>confirmOperationReceipt(journal,receipt,{...args,data:{...args.data,[field]:value}}),e=>e.code==='OPERATION_IDENTITY_UNVERIFIED');
 assert.equal(confirmOperationReceipt(journal,receipt,{...args,failed:true}).state,'accepted');
});
test('packaging confirms only after exact build download, preserving pending and foreign receipts',()=>{
 const receipt={state:'accepted',identity:{kind:'odc-public',tenant:'tenant',operationId:'build-operations-api-v1:post:/build-operations/{operationKey}/generated-code',target:{operationKey:'build'}}};
 let count=0;const journal={lookup:()=>receipt,reconcile:(r,x)=>{count++;return {...r,...x};}};
 const args={operationUuid:uuid,tenant:'tenant',buildKey:'build'};assert.equal(packagingReceipt(journal,args),receipt);
 for(const patch of [{tenant:'foreign'},{buildKey:'other'},{operationUuid:'invalid'}])assert.throws(()=>packagingReceipt(journal,{...args,...patch}));
 const result={ok:true,buildKey:'build',sha256:'a'.repeat(64),byteLength:100};
 for(const patch of [{ok:false},{buildKey:'other'},{sha256:'bad'},{byteLength:0}])assert.throws(()=>confirmPackagingReceipt(journal,receipt,{...result,...patch}));
 assert.equal(count,0);const done=confirmPackagingReceipt(journal,receipt,result);assert.equal(done.state,'confirmed');assert.equal(count,1);
 assert.equal(confirmPackagingReceipt(journal,done,result),done);assert.equal(count,1);
});
test('deployment confirmation checks operation, sole revision and exact build',()=>{
 const spec=OPERATION_STATUS.deployment,receipt={state:'accepted',identity:{kind:'odc-public',target:{assetKey:'asset',operation:'Deploy',revision:2,buildKey:'build'}}};
 const journal={reconcile:r=>({...r,state:'confirmed'})},data={key:'job',assetKey:'asset',operation:'Deploy',revisions:[2],buildKey:'build',status:'Finished'};
 const args={spec,operationKey:'job',data,terminal:true,failed:false};assert.equal(confirmOperationReceipt(journal,receipt,args).state,'confirmed');
 for(const patch of [{operation:'Undeploy'},{revisions:[1]},{revisions:[2,3]},{revisions:undefined},{buildKey:'other'}])
  assert.throws(()=>confirmOperationReceipt(journal,receipt,{...args,data:{...data,...patch}}),e=>e.code==='OPERATION_IDENTITY_UNVERIFIED');
 const removal={state:'accepted',identity:{kind:'odc-public',target:{assetKey:'asset',operation:'Undeploy',revision:2}}};
 assert.equal(confirmOperationReceipt(journal,removal,{...args,data:{...data,operation:'Undeploy',buildKey:null}}).state,'confirmed');
});
test('publication confirmation checks the revision and operation recorded at dispatch',()=>{
 const spec=OPERATION_STATUS.publish,receipt={state:'accepted',identity:{target:{assetKey:'asset',revision:2,operation:'Publish'}}};
 const journal={reconcile:r=>({...r,state:'confirmed'})};
 const args={spec,operationKey:'publish',data:{key:'publish',assetKey:'asset',revision:2,operation:'Publish',status:'Finished'},terminal:true,failed:false};
 assert.equal(confirmOperationReceipt(journal,receipt,args).state,'confirmed');
 for(const patch of [{revision:1},{revision:undefined},{operation:'Deploy'}])assert.throws(()=>confirmOperationReceipt(journal,receipt,{...args,data:{...args.data,...patch}}));
});
const make=()=>({state:'accepted',identity:{kind:'odc-public',tenant:'tenant',operationId:spec.start,target:{assetKey:'asset',environmentKey:'env'}},response:{analysisKey:'analysis'}});

test('bulk success confirms all distinct inserted identities, never partial or updated records',()=>{
 const spec=OPERATION_STATUS['bulk-users'], records=[{email:'a@ssam-proof.invalid'},{email:'b@ssam-proof.invalid'}];
 const receipt={state:'accepted',identity:{target:{records}}};let confirmed=0;
 const journal={reconcile:r=>{confirmed++;return {...r,state:'confirmed'};}};
 const rows=records.map((r,i)=>({status:'Inserted',record:{...r,key:i?'22222222-2222-4222-8222-222222222222':uuid}}));
 const args={spec,operationKey:'batch',data:{key:'batch',status:'Finished',operations:rows},terminal:true,failed:false};
 for(const operations of [[],rows.slice(0,1),[rows[0],rows[0]],[rows[0],{...rows[1],status:'Updated'}],
  [rows[0],{...rows[1],record:{...rows[1].record,email:'foreign@ssam-proof.invalid'}}],
  [rows[0],{...rows[1],record:{...rows[1].record,key:'invalid'}}]])
  assert.throws(()=>confirmOperationReceipt(journal,receipt,{...args,data:{...args.data,operations}}),e=>e.code==='OPERATION_IDENTITY_UNVERIFIED');
 assert.equal(confirmOperationReceipt(journal,receipt,{...args,failed:true}).state,'accepted');
 assert.equal(confirmOperationReceipt(journal,receipt,{...args,terminal:false}).state,'accepted');assert.equal(confirmed,0);
 assert.equal(confirmOperationReceipt(journal,receipt,args).state,'confirmed');assert.equal(confirmed,1);
});

test('build confirmation requires finished status and exact revision/type',()=>{
 const build={start:'build-operations-api-v1:post:/build-operations',read:'build-read',key:'buildKey',param:'operationKey',field:'status'};
 const target={assetKey:'asset',assetRevision:2,buildType:'Release'};
 const receipt={state:'accepted',identity:{target}},journal={reconcile:r=>({...r,state:'confirmed'})};
 const args={spec:build,operationKey:'build',data:{...target,buildKey:'build',status:'Finished'},terminal:true,failed:false};
 assert.equal(confirmOperationReceipt(journal,receipt,args).state,'confirmed');
 for(const changed of [{assetRevision:1},{buildType:'Debug'},{assetKey:undefined}])
  assert.throws(()=>confirmOperationReceipt(journal,receipt,{...args,data:{...args.data,...changed}}),e=>e.code==='OPERATION_IDENTITY_UNVERIFIED');
 assert.equal(confirmOperationReceipt(journal,receipt,{...args,data:{...args.data,status:'Deleted'}}).state,'accepted');
});
test('only the exact tenant, operation and returned job key can select a receipt',()=>{
 const receipt=make(),journal={lookup:()=>receipt};
 assert.equal(operationReceipt(journal,{operationUuid:uuid,tenant:'tenant',spec,operationKey:'analysis'}),receipt);
 for(const change of [{tenant:'other'},{operationKey:'other'},{spec:{...spec,start:'different'}}])
  assert.throws(()=>operationReceipt(journal,{operationUuid:uuid,tenant:'tenant',spec,operationKey:'analysis',...change}),e=>e.code==='OPERATION_RECEIPT_MISMATCH');
 assert.throws(()=>operationReceipt({lookup:()=>null},{operationUuid:uuid,tenant:'tenant',spec,operationKey:'analysis'}),e=>e.code==='OPERATION_RECEIPT_MISMATCH');
 assert.equal(operationReceipt(journal,{}),null);
});
test('successful exact terminal identity confirms once, pending and failed do not',()=>{
 let calls=0;const receipt=make(),journal={reconcile:(r,update)=>{calls++;assert.equal(update.state,'confirmed');assert.equal(update.observation.status,'Completed');r.state='confirmed';return r;}};
 const args={spec,operationKey:'analysis',data:{analysisKey:'analysis',assetKey:'asset',environmentKey:'env',status:'Completed'},terminal:true,failed:false};
 assert.equal(confirmOperationReceipt(journal,receipt,{...args,terminal:false}),receipt);assert.equal(calls,0);
 assert.equal(confirmOperationReceipt(journal,receipt,{...args,failed:true}),receipt);assert.equal(calls,0);
 for(const data of [{...args.data,analysisKey:'other'},{...args.data,assetKey:'other'},{...args.data,environmentKey:'other'},{}])
  assert.throws(()=>confirmOperationReceipt(journal,receipt,{...args,data}),e=>e.code==='OPERATION_IDENTITY_UNVERIFIED');
 assert.equal(calls,0);assert.equal(confirmOperationReceipt(journal,receipt,args).state,'confirmed');
 confirmOperationReceipt(journal,receipt,args);assert.equal(calls,1);
});

test('native timer receipt requires its deployment key and verified target',()=>{
 const deployment={start:'deployments-api-v1:post:/deployment-operations',read:'deployment-read',key:'key',param:'deploymentKey',field:'status'};
 const target={environmentKey:'env',applicationKey:'asset',timerKey:'timer'};
 const receipt={state:'accepted',identity:{kind:'odc-portal',tenant:'tenant',operationId:'timers.pause',target},response:{DeploymentKey:'deployment'},timerActivation:{target}};
 let count=0;const journal={lookup:()=>receipt,reconcile:(r,u)=>{count++;return {...r,...u};}};
 assert.equal(operationReceipt(journal,{operationUuid:uuid,tenant:'tenant',spec:deployment,operationKey:'deployment'}),receipt);
 for(const args of [{operationKey:'other'},{tenant:'other'},{spec}])assert.throws(()=>operationReceipt(journal,{operationUuid:uuid,tenant:'tenant',spec:deployment,operationKey:'deployment',...args}),e=>e.code==='OPERATION_RECEIPT_MISMATCH');
 const args={spec:deployment,operationKey:'deployment',data:{key:'deployment',status:'Finished',assetKey:'asset',environmentKey:'env'},terminal:true,failed:false};
 for(const timerVerification of [undefined,{confirmed:true,target:{...target,timerKey:'other'}}])assert.throws(()=>confirmOperationReceipt(journal,receipt,{...args,timerVerification}),e=>e.code==='TIMER_STATE_UNVERIFIED');
 assert.equal(count,0);assert.equal(confirmOperationReceipt(journal,receipt,{...args,timerVerification:{confirmed:true,target}}).state,'confirmed');assert.equal(count,1);
});
