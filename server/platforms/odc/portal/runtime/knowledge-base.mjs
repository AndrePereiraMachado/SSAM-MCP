import fs from 'node:fs';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fail} from './errors.mjs';
import {isUuid,sha256} from './write-journal.mjs';
export const KB_CREATE='knowledgeBases.create',KB_DELETE='knowledgeBases.delete';
const keys=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===names.split(',').sort().join(',');
const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Knowledge-base operation requires an exact own-fixture proposal, complete inventory and verified dependencies. Nothing was sent.');
export function knowledgeBaseInventory(result){
 const list=result?.data?.KBListItems?.List,rawTotal=result?.data?.TotalCount,total=Number(rawTotal);
 if(result?.ok!==true||!(typeof rawTotal==='number'||typeof rawTotal==='string'&&/^\d+$/.test(rawTotal))||!Array.isArray(list)||!Number.isSafeInteger(total)||total<0||total!==list.length
  ||list.some(x=>!isUuid(x.KnowledgeBaseId)||typeof x.Name!=='string'||!x.Name||typeof x.Status!=='string')
  ||new Set(list.map(x=>x.KnowledgeBaseId)).size!==list.length)fail('KNOWLEDGE_BASE_INVENTORY_INCOMPLETE','Complete knowledge-base inventory could not be verified.');
 return list;
}
export async function knowledgeBaseApproval({file,words,host,operationId,raw,lookup,read}){
 if(!file||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length)bad();
 const p=raw.inputParameters;
 if(operationId===KB_CREATE){
  const k=p?.KnowledgeBaseCreate,d=k?.DataSources?.List?.[0],c=d?.ChunkingConfig;
  if(!keys(p,'KnowledgeBaseCreate')||!keys(k,'Name,Description,PortfolioKey,DataSources')||typeof k.Name!=='string'||!/^[A-Za-z][A-Za-z0-9_]{1,79}$/.test(k.Name)
   ||typeof k.Description!=='string'||!isUuid(k.PortfolioKey)||!keys(k.DataSources,'List')||!Array.isArray(k.DataSources.List)||k.DataSources.List.length!==1
   ||!keys(d,'Name,Description,Type,ChunkingConfig')||typeof d.Name!=='string'||!d.Name.trim()||typeof d.Description!=='string'||d.Type!=='upload_files'
   ||!keys(c,'ChunkingMethod,ChunkSize,ChunkOverlap,Separators,KeepSeparator')||!Number.isSafeInteger(c.ChunkSize)||c.ChunkSize<=0
   ||!Number.isSafeInteger(c.ChunkOverlap)||c.ChunkOverlap<0||c.ChunkOverlap>=c.ChunkSize||typeof c.Separators!=='string'||typeof c.KeepSeparator!=='boolean')bad();
  const approved=authorizationContext(file,words,{lane:'odc',host,operation:KB_CREATE,targets:[k.Name,d.Name],constraints:{inputSha256:sha256(JSON.stringify(p)),portfolioKey:k.PortfolioKey}});
  const methods=await read('knowledgeBases.chunkingMethods',{}),stages=await read('knowledgeBases.createStages',{});
  if(!approved||methods?.ok!==true||!methods.data?.ChunkingMethods?.List?.some(x=>x.Id===c.ChunkingMethod)
   ||stages?.ok!==true||!stages.data?.Stages?.List?.some(x=>x.PortfolioKey===k.PortfolioKey))bad();
  const list=knowledgeBaseInventory(await read('knowledgeBases.list',{}));
  if(list.some(x=>x.Name.toLowerCase()===k.Name.toLowerCase()))fail('KNOWLEDGE_BASE_ALREADY_EXISTS','The knowledge-base name is already present. Nothing was sent.');
  return approved;
 }
 if(operationId!==KB_DELETE||!keys(p,'KnowledgeBaseId')||!isUuid(p.KnowledgeBaseId))bad();
 let c;try{if(fs.statSync(file).size>32768)bad();c=JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{bad();}
 if(!isUuid(c?.originOperationUuid))bad();
 const origin=lookup(c.originOperationUuid);
 if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host||origin.identity.operationId!==KB_CREATE
  ||origin.response?.KnowledgeBaseId!==p.KnowledgeBaseId||!origin.authorization?.source)bad();
 const list=knowledgeBaseInventory(await read('knowledgeBases.list',{})),found=list.find(x=>x.KnowledgeBaseId===p.KnowledgeBaseId);
 if(!found||!['Ready','Error'].includes(found.Status))bad();
 const approved=authorizationContext(file,words,{lane:'odc',host,operation:KB_DELETE,targets:[found.Name],constraints:{
  originOperationUuid:c.originOperationUuid,knowledgeBaseId:p.KnowledgeBaseId,expectedKnowledgeBaseSha256:sha256(JSON.stringify(found))}});
 if(!approved||approved.wordsSha256!==origin.authorization.wordsSha256||approved.proposalSha256!==origin.authorization.proposalSha256
  ||approved.source.threadId!==origin.authorization.source.threadId||approved.source.messageId!==origin.authorization.source.messageId)bad();
 const deps=await read('knowledgeBases.consumers',{KnowledgeBaseId:p.KnowledgeBaseId,_knowledgeBaseIdInDataFetchStatus:1});
 if(deps?.ok!==true||!Array.isArray(deps.data?.ApplicationConsumers?.List)||deps.data.ApplicationConsumers.List.length)
  fail('KNOWLEDGE_BASE_CONSUMERS_UNVERIFIED','Knowledge-base consumers must be verified empty. Nothing was sent.');
 return approved;
}
export function knowledgeBaseObservation(receipt,result){
 const list=knowledgeBaseInventory(result),id=receipt.reconciliation?.knowledgeBase?.key??receipt.response?.KnowledgeBaseId;
 if(!isUuid(id))return {verified:false,reason:'creation-identity-unavailable'};
 const found=list.find(x=>x.KnowledgeBaseId===id);
 if(receipt.identity.operationId===KB_DELETE)return {verified:!found,knowledgeBaseId:id,absent:!found};
 const verified=Boolean(found&&found.Name===receipt.reconciliation?.knowledgeBase?.name&&found.Status==='Ready');
 return {verified,knowledgeBaseId:id,status:found?.Status??null,exists:!!found};
}
