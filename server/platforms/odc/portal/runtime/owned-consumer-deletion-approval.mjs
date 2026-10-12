import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {ASSET_CREATE} from './asset-creation-approval.mjs';
import {fail} from './errors.mjs';
const DELETE='asset-repository-api-v1:delete:/assets/{assetKey}';
const hash=x=>createHash('sha256').update(x).digest('hex');
export function consumerSetHash(consumers){
 return hash(JSON.stringify(consumers.map(c=>[c.key,c.name]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))));
}
// Optional, explicit ownership-bound approval. Ordinary contextual approvals do
// not imply permission to break consumers. Every affected asset must originate
// in this same approved proposal, tenant and human grant.
export function ownedConsumerDeletionApproval({file,words,host,assetKey,dependents,lookup}){
 if(!file)return null;
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Consumer deletion requires exact identities and successful creation receipts from the same proposal and human grant. Nothing was sent.');
 let record;try{if(fs.statSync(file).size>32768)bad();record=JSON.parse(fs.readFileSync(file,'utf8'));}catch{bad();}
 if(record.constraints?.allowOwnedConsumerBreakage!==true)return null;
 const origins=record.constraints.ownedAssetOrigins;
 const keys=[...new Set([assetKey,...dependents.consumers.map(c=>c.key)])];
 if(!origins||Array.isArray(origins)||typeof origins!=='object'||Object.keys(origins).length!==keys.length
  ||keys.some(k=>!Object.hasOwn(origins,k)||typeof origins[k]!=='string')
  ||new Set(Object.values(origins)).size!==keys.length)bad();
 const approved=authorizationContext(file,words,{lane:'odc',host,operation:DELETE,
  targets:[dependents.name,...dependents.consumers.map(c=>c.name)],constraints:{
   allowOwnedConsumerBreakage:true,producerAssetKey:assetKey,consumerSetSha256:consumerSetHash(dependents.consumers)}});
 if(!approved)bad();
 for(const key of keys){
  const origin=lookup(origins[key]);
  if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.status!==201
   ||origin.identity?.tenant!==host||origin.identity.operationId!==ASSET_CREATE||origin.response?.assetKey!==key
   ||origin.authorization?.wordsSha256!==approved.wordsSha256
   ||origin.authorization.proposalSha256!==approved.proposalSha256
   ||origin.authorization.source?.threadId!==approved.source.threadId
   ||origin.authorization.source?.messageId!==approved.source.messageId)bad();
 }
 return approved;
}
