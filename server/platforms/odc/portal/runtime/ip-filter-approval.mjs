import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fail} from './errors.mjs';
const root='environment-configurations-api-v1:', collection='/environments/{environmentKey}/ip-filter-groups';
export const IP_FILTER_CREATE=root+'post:'+collection;
export const IP_FILTER_PATCH=root+'patch:'+collection+'/{ipFilterGroupKey}';
export const IP_FILTER_DELETE=root+'delete:'+collection+'/{ipFilterGroupKey}';
export const IP_FILTER_WRITES=new Set([IP_FILTER_CREATE,IP_FILTER_PATCH,IP_FILTER_DELETE]);
export const ipFilterHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function ipFilterApproval({file,words,host,operationId,input,originOperationUuid,lookup,read}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','IP filter approval must bind the own group, own application receipts, stage, current configuration and exact change. Nothing was sent.');
 const create=operationId===IP_FILTER_CREATE, p=input.path??{},b=input.body;
 if(!IP_FILTER_WRITES.has(operationId)||input.query||typeof p.environmentKey!=='string'
   ||Object.keys(p).some(k=>!['environmentKey',...(create?[]:['ipFilterGroupKey'])].includes(k)))bad();
 let name,origin,current,bindingOriginsJson;
 if(create){
  if(!b||typeof b.name!=='string'||!b.name.trim()||!['DENYLIST','ALLOWLIST'].includes(b.accessType)
    ||!Array.isArray(b.appKeys)||b.appKeys.length||!Array.isArray(b.ipRules)||b.ipRules.length)bad();
  name=b.name;
  const list=await read(root+'get:'+collection,p);
  if(!list.ok||!Array.isArray(list.data?.results))fail('IP_FILTER_PREREQUISITE_UNAVAILABLE','IP filter inventory could not be read; nothing was sent.');
  if(list.data.results.some(r=>typeof r.name!=='string'||r.name.toLowerCase()===name.toLowerCase()))bad();
 }else{
  if(typeof p.ipFilterGroupKey!=='string'||p.ipFilterGroupKey==='default')bad();
  origin=lookup(originOperationUuid);
  if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
    ||origin.identity.operationId!==IP_FILTER_CREATE||origin.identity.target?.environmentKey!==p.environmentKey
    ||origin.response?.key!==p.ipFilterGroupKey||!origin.authorization?.source)bad();
  const seen=await read(root+'get:'+collection+'/{ipFilterGroupKey}',p);
  if(!seen.ok||seen.data?.key!==p.ipFilterGroupKey)fail('IP_FILTER_PREREQUISITE_UNAVAILABLE','Exact IP filter group could not be read; nothing was sent.');
  current=seen.data;name=current.name;
  if(!Array.isArray(current.appKeys)||name!==origin.identity.target.name)bad();
  if(operationId===IP_FILTER_PATCH){
   if(!b||!Object.keys(b).length||Object.keys(b).some(k=>!['description','ipRules','appKeys'].includes(k)))bad();
   if('appKeys' in b&&(!Array.isArray(b.appKeys)||b.appKeys.some(k=>typeof k!=='string')||new Set(b.appKeys).size!==b.appKeys.length))bad();
   if('description' in b&&typeof b.description!=='string')bad();
   if('ipRules' in b&&(!Array.isArray(b.ipRules)||b.ipRules.some(rule=>!rule||typeof rule.name!=='string'
     ||typeof rule.isActive!=='boolean'||!Array.isArray(rule.ranges)||!rule.ranges.length
     ||rule.ranges.some(range=>typeof range!=='string'||!range.trim())
     ||Object.keys(rule).some(k=>!['name','isActive','ranges'].includes(k)))))bad();
  }
  if(operationId===IP_FILTER_DELETE&&(b!==undefined||current.appKeys.length))bad();
  const keys=[...new Set([...current.appKeys,...(b?.appKeys??[])])].sort();
  if(keys.length){
   let bindings;
   try{
    if(!file||fs.statSync(file).size>32768)bad();
    bindingOriginsJson=JSON.parse(fs.readFileSync(file,'utf8')).constraints?.bindingOriginsJson;
    bindings=JSON.parse(bindingOriginsJson);
   }catch{bad();}
   if(!Array.isArray(bindings)||bindings.length!==keys.length)bad();
   for(let i=0;i<keys.length;i++){
    const entry=bindings[i];
    if(!entry||Object.keys(entry).sort().join(',')!=='assetKey,operationUuid'||entry.assetKey!==keys[i])bad();
    const assetOrigin=lookup(entry.operationUuid);
    if(!assetOrigin||!['accepted','confirmed'].includes(assetOrigin.state)||assetOrigin.identity?.tenant!==host
     ||assetOrigin.identity.operationId!=='asset-repository-api-v1:post:/assets'||assetOrigin.response?.assetKey!==entry.assetKey
     ||assetOrigin.authorization?.source?.threadId!==origin.authorization.source.threadId
     ||assetOrigin.authorization?.source?.messageId!==origin.authorization.source.messageId)bad();
    const asset=await read('asset-repository-api-v1:get:/assets/{assetKey}',{assetKey:entry.assetKey});
    if(!asset.ok||asset.data?.assetKey!==entry.assetKey||!['WebApplication','MobileApplication'].includes(asset.data.assetType)
     ||asset.data.name!==assetOrigin.identity.target?.name)bad();
   }
  }
 }
 const constraints={bodySha256:ipFilterHash(b??null),...(create?{}:{originOperationUuid,expectedConfigurationSha256:ipFilterHash(current)}),...(bindingOriginsJson===undefined?{}:{bindingOriginsJson})};
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,environmentKey:p.environmentKey,targets:[name],constraints});
 if(!approval||origin&&(approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId))bad();
 return approval;
}
