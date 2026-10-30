import fs from 'node:fs';
import {approvalOf,contextValues,originId,ownedBy,sameGrant,recorded} from './written-approval.mjs';
import {fail} from './errors.mjs';
import {isUuid,sha256} from './write-journal.mjs';
import {ownedCleanupApproval} from './owned-cleanup-approval.mjs';

export const API_CLIENT_CREATE='apiClients.create',API_CLIENT_DELETE='apiClients.delete';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','API Client writes require an exact short-lived own-fixture proposal. Nothing was sent.');
export function apiClientCreateInput(raw,now=Date.now()){
 const p=raw.inputParameters,c=p?.OIDCClientCreate;
 if(!exact(p,'OIDCClientCreate')||!exact(c,'Name,Description,SecretExpiresAt,IsActive,IsSendSecretExpiryEmail,Permissions')
  ||typeof c.Name!=='string'||!/^SSAMApiClientProof\d{8}[A-Za-z0-9]{0,16}$/.test(c.Name)
  ||typeof c.Description!=='string'||c.Description.length>200||c.IsActive!==true||c.IsSendSecretExpiryEmail!==false
  ||typeof c.SecretExpiresAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(c.SecretExpiresAt)
  ||!Number.isFinite(Date.parse(c.SecretExpiresAt))||Date.parse(c.SecretExpiresAt)<=now+600000||Date.parse(c.SecretExpiresAt)>now+172800000
  ||!exact(c.Permissions,'List')||!Array.isArray(c.Permissions.List)||c.Permissions.List.length
  ||!exact(raw.screenVariables,'')||!exact(raw.clientVariables,''))bad();
 return c;
}
// Copy only this projection. An unexpected native response can contain the
// one-time credential under an arbitrary extra field or header.
export function apiClientPrivateProof(value,{operationUuid,name}){
 if(!value||!isUuid(value.key)||value.name!==name||value.operationUuid!==operationUuid
  ||value.vaultRef!=='urn:ssam:api-client:'+operationUuid||value.vaultStored!==true
  ||value.rawValueExposed!==false||value.responseProjected!==true)
  fail('UNCERTAIN','Native API Client creation did not return its private vault proof. Inspect the original receipt; never resend.',{sent:true});
 return {key:value.key,name,operationUuid,vaultRef:value.vaultRef,vaultStored:true,rawValueExposed:false,responseProjected:true};
}
// R2-I (owner's rule, 28/10): the written words naming the fixture are the approval; a context file is still accepted. Without
// one, the creation binds its own operationUuid and the delete finds its creation in SSAM's own journal (the receipt
// whose private proof holds this key).
export function apiClientFixtureApproval({file,words,host,operationId,operationUuid,raw,lookup,find,now=Date.now()}){
 const written=!file;
 let constraints;
 try{constraints={...contextValues(file)};}catch{bad();}
 let name,origin;
 if(operationId===API_CLIENT_CREATE){
  name=apiClientCreateInput(raw,now).Name;
  if(written)constraints.creationOperationUuid=operationUuid;
  if(constraints?.creationOperationUuid!==operationUuid)bad();
 }else{
  if(operationId!==API_CLIENT_DELETE||!exact(raw.inputParameters,'Key')||!isUuid(raw.inputParameters.Key)
   ||!exact(raw.screenVariables,'')||!exact(raw.clientVariables,''))bad();
  constraints.creationOperationUuid=originId(constraints,'creationOperationUuid',{written,find,what:'The API Client cleanup',
   predicate:r=>ownedBy(host,API_CLIENT_CREATE)(r)&&String(r.response?.ApiClientProof?.key).toLowerCase()===raw.inputParameters.Key.toLowerCase()});
  if(!isUuid(constraints?.creationOperationUuid))bad();
  origin=lookup(constraints.creationOperationUuid);
  if(!origin||origin.identity?.tenant!==host||origin.identity.operationId!==API_CLIENT_CREATE
   ||!['accepted','confirmed'].includes(origin.state)||!recorded(origin))bad();
  const proof=apiClientPrivateProof(origin.response?.ApiClientProof,{operationUuid:origin.operationUuid,name:origin.reconciliation?.apiClientFixture?.name});
  if(proof.key!==raw.inputParameters.Key)bad();
  name=proof.name;
 }
 const scope={lane:'odc',host,operation:operationId,targets:[name],
  constraints:{creationOperationUuid:constraints.creationOperationUuid,inputSha256:sha256(JSON.stringify(raw.inputParameters))}};
 // CX15 r3 (N3): the delete after the guard validated the owner's reply to the preview: a new approval of that reply
 // (proposal = the preview) bound to creationOperationUuid replaces the creation's words and message.
 const fresh=origin?ownedCleanupApproval({file,words,...scope,origin,key:raw.inputParameters.Key,what:'The API Client cleanup'}):null;
 const approval=fresh??approvalOf(file,words,scope);
 if(!approval)bad();
 // Outside the guard (an internal cleanup of the same request): the creation's own words.
 if(origin&&!fresh&&(approval.wordsSha256!==origin.authorization.wordsSha256||!sameGrant(origin.authorization,approval)))bad();
 return {approval,expected:{name,creationOperationUuid:constraints.creationOperationUuid,...(origin?{key:raw.inputParameters.Key}:{})}};
}
