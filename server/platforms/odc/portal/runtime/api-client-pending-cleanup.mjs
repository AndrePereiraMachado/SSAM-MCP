import fs from 'node:fs';
import path from 'node:path';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {apiClientFixtureApproval,API_CLIENT_CREATE,API_CLIENT_DELETE} from './api-client-fixture.mjs';
import {apiClientAbsent,apiClientInventoryComplete} from './api-client-inventory.mjs';
import {fingerprint,isUuid,sha256} from './write-journal.mjs';
import {fail} from './errors.mjs';
import {ownedCleanupApproval} from './owned-cleanup-approval.mjs';
const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Partial API Client cleanup requires its original uncertain creation, complete baseline and unchanged live inventory. Nothing was sent.');
function read(file,max=32768){
 try{if(!path.isAbsolute(file)||fs.statSync(file).size>max)bad();const bytes=fs.readFileSync(file);return {bytes,value:JSON.parse(bytes)};}catch{bad();}
}
// This is an explicit cleanup mode, never a substitute for a successful vault
// capture. List rows contain defaults: actual state must come from detail.
export async function apiClientWriteApproval(args){
 const {file,words,host,operationId,raw,lookup,readInventory,readDetail}=args;
 const constraints=file?read(file).value.constraints:null;
 if(constraints?.cleanupMode!=='pending-header')return apiClientFixtureApproval(args);
 if(operationId!==API_CLIENT_DELETE||!isUuid(constraints.creationOperationUuid)
  ||Object.keys(raw.inputParameters).join(',')!=='Key'||!isUuid(raw.inputParameters.Key)
  ||Object.keys(raw.screenVariables).length||Object.keys(raw.clientVariables).length)bad();
 const origin=lookup(constraints.creationOperationUuid),name=origin?.reconciliation?.apiClientFixture?.name,key=raw.inputParameters.Key;
 if(origin?.schema!=='ssam-odc-write/1'||origin.operationUuid!==constraints.creationOperationUuid
  ||origin.state!=='uncertain'||origin.identity?.tenant!==host||origin.identity.operationId!==API_CLIENT_CREATE
  ||origin.identity.target?.apiClientFixtureName!==name||!/^SSAMApiClientProof\d{8}[A-Za-z0-9]{0,16}$/.test(name??'')
  ||origin.response?.ApiClientProof||!origin.authorization?.source)bad();
 const baseline=read(constraints.baselineFile,1048576);
 if(sha256(baseline.bytes.toString('utf8'))!==constraints.baselineSha256||baseline.value.tenant!==host
  ||!apiClientAbsent({key,name},baseline.value))bad();
 const bound={creationOperationUuid:origin.operationUuid,inputSha256:sha256(JSON.stringify(raw.inputParameters)),
  cleanupMode:'pending-header',baselineFile:constraints.baselineFile,baselineSha256:constraints.baselineSha256};
 // CX15 r3 (N3): after the guard validated the owner's reply to the preview, a new approval of that reply (proposal = the
 // preview) bound to creationOperationUuid replaces the creation's words and message.
 const fresh=ownedCleanupApproval({file,words,host,operation:operationId,targets:[name],constraints:bound,origin,key,what:'The pending API Client cleanup'});
 const approval=fresh??authorizationContext(file,words,{lane:'odc',host,operation:operationId,targets:[name],constraints:bound});
 if(!approval||!fresh&&(approval.wordsSha256!==origin.authorization.wordsSha256
  ||approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId))bad();
 const current=await readInventory();
 if(current?.tenant!==host||!apiClientInventoryComplete(current)
  ||current.rows.length!==baseline.value.rows.length+1)bad();
 const added=current.rows.filter(r=>r.Key.toLowerCase()===key.toLowerCase()&&r.Name===name);
 if(added.length!==1)bad();
 const previous=current.rows.filter(r=>r.Key.toLowerCase()!==key.toLowerCase());
 if(previous.length!==baseline.value.rows.length||baseline.value.rows.some(row=>
  !previous.some(live=>live.Key.toLowerCase()===row.Key.toLowerCase()&&fingerprint(live)===fingerprint(row))))bad();
 const detail=typeof readDetail==='function'?await readDetail(key):null,client=detail?.data?.ApiClientDetails;
 const created=Date.parse(client?.CreatedAt),start=Date.parse(origin.createdAt),end=Date.parse(origin.updatedAt);
 if(detail?.ok!==true||detail.tenant!==host||client?.Key!==key||client.Name!==name||client.IsActive!==true
  ||!Array.isArray(client.Permissions?.List)||client.Permissions.List.length
  ||!Number.isFinite(created)||!Number.isFinite(start)||!Number.isFinite(end)||created<start||created>end)bad();
 return {approval,expected:{name,key,creationOperationUuid:origin.operationUuid,cleanupMode:'pending-header',
  baselineSha256:constraints.baselineSha256,headerSha256:fingerprint(added[0]),detailSha256:fingerprint(client),privateCaptureProven:false}};
}
