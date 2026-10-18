import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {OdcAccess} from '../runtime/access.mjs';
import {WriteJournal} from '../runtime/write-journal.mjs';

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'db-entities-'));
 t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true});});
 const host='corp.outsystems.dev', words='Approve this temporary metadata cycle';
 const proposal=path.join(dir,'proposal.md'),approval=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Own connection metadata only.');
 const hash=createHash('sha256').update(fs.readFileSync(proposal)).digest('hex');
 fs.writeFileSync(approval,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,
  source:{kind:'human-conversation',threadId:randomUUID(),messageId:randomUUID(),question:'Approve this cycle?'},proposal:{file:proposal,sha256:hash},
  scope:[{lane:'odc',host,operation:'connections.importEntities',targets:['Fixture'],environmentKey:'stage'}],
  constraints:{server:'db.test',port:1433,database:'Test',noDdl:true,noDataWrites:true,noBusinessDataReads:true,deleteTemporaryConnections:true,requiresTestedHeadlessTransport:true}}));
 const receipts=new WriteJournal(path.join(dir,'receipts')), origin=randomUUID();
 const original=receipts.reserve({operationUuid:origin,identity:{kind:'odc-portal',tenant:host,operationId:'connections.relationalTest',target:{connectionName:'Fixture'}},wordsSha256:'test',plan:{authorizationContext:{proposalSha256:hash}}});
 receipts.settle(original,{state:'accepted',response:{Out_ConnectionId:'connection'}});
 const access=new OdcAccess({receipts,tenants:{tenants:{[host]:{class:'corporate'}}}});
 const entity={EntityId:'entity',OriginalName:'dbo.Test',Name:'Test',IsSelected:true};
 const state={selected:[],attributes:null,requests:[],failSelected:false,missingSelected:false,timestamp:'2026-10-09T12:00:00',foreign:false,loseResponse:false};
 access.portalRead=async({operationId})=>{
  if(operationId==='connections.detail')return {ok:true,data:{NotFound:false,Connection:{connectionId:state.foreign?'foreign':'connection',name:'Fixture',providerId:'mssql',externalMetadata:{selectedObjectCount:state.selected.length,selectedActionCount:0},stageConfigurations:[{stageKey:'stage',host:'db.test',port:1433,database:'Test',hasAdditionalParameters:false,privateGatewayPort:null}]}}};
  if(operationId==='connections.connection')return {ok:true,data:{ConnectionUpdateTimestamp:state.timestamp}};
  if(operationId==='connections.entities')return {ok:true,data:{EntityList:{List:[entity]}}};
  if(operationId==='connections.entityAttributes')return {ok:true,data:{AttributesList:{List:state.attributes??[{AttributeId:'id',OriginalName:'Id',Name:'Id',DataType:'Integer',IsPrimaryKey:true,DefaultValue:'123',HasCustomDefaultValue:true},{AttributeId:'text',OriginalName:'Label',Name:'Label',DataType:'Text'}]}}};
  assert.equal(operationId,'connections.selectedEntities');
  return state.failSelected?{ok:false,error:{code:'READ_FAILED'}}:{ok:true,data:state.missingSelected?{}:{SelectedEntityList_Original:{List:state.selected}}};
 };
 access.resolvePortal=async()=>({ok:true,path:'vault',broker:{callScreenservice:async request=>{
  state.requests.push(request);const updated=request.input.inputParameters.DatabaseObjects.Entities.List[0];
  state.selected=updated.IsSelected?[{...entity,Name:updated.Name}]:[];
  state.attributes=structuredClone(updated.Attributes.List);
  if(state.corrupt)state.corrupt(state);
  if(state.loseResponse)throw Object.assign(new Error('lost'),{code:'NETWORK_ERROR',sent:true});
  return {data:{}};
 }}});
 const args={tenant:host,connectionId:'connection',objects:['dbo.Test'],authorize:words,confirmTenant:host,authorizationContext:approval,originOperationUuid:origin,operationUuid:randomUUID(),action:'import-entities'};
 return {access,state,args};
}

test('imports and removes only metadata, then replays receipts without another send',async t=>{
 const {access,state,args}=fixture(t);
 const imported=await access.externalDbConnection(args);assert.equal(imported.receipt?.state,'confirmed',JSON.stringify(imported));
 assert.equal(imported.readBack.allImported,true);
 const removing={...args,action:'remove-entities',operationUuid:randomUUID()};
 const removed=await access.externalDbConnection(removing);assert.equal(removed.receipt?.state,'confirmed',JSON.stringify(removed));assert.equal(removed.readBack.allRemoved,true);
 const sent=state.requests[1].input.inputParameters;
 assert.equal(sent.ConnectionOriginalUpdateTimestamp,state.timestamp);assert.deepEqual(sent.DatabaseObjects.Actions.List,[]);
 assert.equal(sent.DatabaseObjects.Entities.List[0].IsSelected,false);
 assert.equal(sent.DatabaseObjects.Entities.List[0].Attributes.List[0].DefaultValue,'');
 assert.equal(sent.DatabaseObjects.Entities.List[0].Attributes.List[1].IsSelected,false);
 await access.externalDbConnection(removing);assert.equal(state.requests.length,2);
});

test('uncertain import is reconciled by read without resending',async t=>{
 const {access,state,args}=fixture(t);state.loseResponse=true;
 const first=await access.externalDbConnection(args);assert.equal(first.receipt?.state,'uncertain',JSON.stringify(first));
 const again=await access.externalDbConnection(args);assert.equal(again.receipt.state,'confirmed');assert.equal(state.requests.length,1);
});

test('failed or malformed readback cannot confirm absence',async t=>{
 for(const mode of ['failSelected','missingSelected']){
  const {access,state,args}=fixture(t);await access.externalDbConnection(args);
  const removing={...args,action:'remove-entities',operationUuid:randomUUID()};
  const original=access.resolvePortal;
  access.resolvePortal=async()=>{const r=await original();const call=r.broker.callScreenservice;r.broker.callScreenservice=async x=>{const result=await call(x);state[mode]=true;return result;};return r;};
  const result=await access.externalDbConnection(removing);assert.equal(result.readBack.allRemoved,false);assert.equal(result.receipt.state,'accepted');
 }
});

test('foreign connection, missing timestamp and duplicate targets refuse before send',async t=>{
 for(const change of [(s,a)=>s.foreign=true,(s,a)=>s.timestamp=null,(s,a)=>a.objects.push('dbo.Test'),(s,a)=>{a.action='remove-entities';delete a.authorizationContext;}]){
  const {access,state,args}=fixture(t);change(state,args);const result=await access.externalDbConnection(args);assert.equal(result.ok,false);assert.equal(state.requests.length,0);
 }
});

test('custom contracts are planned without writes and require their reviewed hash',async t=>{
 const {access,state,args}=fixture(t);
 const contracts={'dbo.Test':{name:'Renamed',identifier:'Id',attributes:{Id:{name:'Key',selected:true},Label:{selected:false}}}};
 const plan=await access.externalDbConnection({tenant:args.tenant,action:'plan-entities',connectionId:args.connectionId,objects:args.objects,objectContracts:contracts});
 assert.equal(plan.ok,true,JSON.stringify(plan));assert.equal(plan.readOnly,true);assert.equal(plan.sent,false);assert.equal(plan.customContractWritesEnabled,true);assert.match(plan.planSha256,/^[a-f0-9]{64}$/);
 assert.equal(plan.plan.entities[0].Name,'Renamed');assert.equal(plan.plan.entities[0].Attributes.List[0].Name,'Key');assert.equal(state.requests.length,0);
 const refused=await access.externalDbConnection({...args,objectContracts:contracts});assert.equal(refused.ok,false);assert.equal(state.requests.length,0);
 const invalid=await access.externalDbConnection({tenant:args.tenant,action:'plan-entities',connectionId:args.connectionId,objects:args.objects,objectContracts:{Other:{name:'X'}}});assert.equal(invalid.ok,false);assert.equal(state.requests.length,0);
});

async function custom(t){
 const h=fixture(t);const objectContracts={'dbo.Test':{name:'Renamed',identifier:'Id',attributes:{Id:{name:'Key',selected:true},Label:{name:'Unused',selected:false}}}};
 const plan=await h.access.externalDbConnection({...h.args,action:'plan-entities',objectContracts});assert.equal(plan.ok,true);
 return {...h,args:{...h.args,objectContracts,expectedPlanSha256:plan.planSha256}};
}

test('custom save persists expectation and verifies complete metadata before confirmation',async t=>{
 const {access,state,args}=await custom(t);const result=await access.externalDbConnection(args);
 assert.equal(result.receipt?.state,'confirmed',JSON.stringify(result));assert.equal(result.readBack.metadataVerified,true);
 const receipt=access.receipts.lookup(args.operationUuid);assert.equal(receipt.reconciliation.entityImport.planSha256,args.expectedPlanSha256);assert.equal(receipt.reconciliations[0].observation.metadataChecks[0].attributesMatch,true);
 assert.equal(state.requests.length,1);await access.externalDbConnection(args);assert.equal(state.requests.length,1);
 const different=structuredClone(args);different.objectContracts['dbo.Test'].name='Different';const refused=await access.externalDbConnection(different);assert.equal(refused.ok,false);assert.equal(state.requests.length,1);
});

test('metadata or timestamp drift rejects a custom save without sending',async t=>{
 for(const change of [h=>h.state.timestamp='2026-10-09T13:00:00',h=>h.args.objectContracts['dbo.Test'].name='Changed']){
  const h=await custom(t);change(h);const result=await h.access.externalDbConnection(h.args);assert.equal(result.error.code,'ENTITY_PLAN_CHANGED');assert.equal(h.state.requests.length,0);
 }
});

test('wrong names, flags, types or missing attributes never confirm the custom import',async t=>{
 for(const change of [s=>s.selected[0].Name='Wrong',s=>s.attributes[0].Name='Wrong',s=>s.attributes[0].DataType='Text',s=>s.attributes[0].IsPrimaryKey=false,s=>s.attributes[1].IsSelected=true,s=>delete s.attributes[1].IsSelected,s=>s.attributes.pop()]){
  const {access,state,args}=await custom(t);state.corrupt=change;const result=await access.externalDbConnection(args);assert.equal(result.receipt.state,'accepted');assert.equal(result.readBack.metadataVerified,false);
 }
});

test('new access instance reconciles lost custom-save reply from durable expectation without resend',async t=>{
 const {access,state,args}=await custom(t);state.loseResponse=true;const first=await access.externalDbConnection(args);assert.equal(first.receipt.state,'uncertain');
 const resumed=new OdcAccess({receipts:new WriteJournal(access.receipts.dir),tenants:access.tenants});resumed.portalRead=access.portalRead;resumed.resolvePortal=async()=>assert.fail('No write transport during reconciliation');
 const result=await resumed.externalDbConnection(args);assert.equal(result.receipt.state,'confirmed');assert.equal(result.readBack.metadataVerified,true);assert.equal(state.requests.length,1);
});
