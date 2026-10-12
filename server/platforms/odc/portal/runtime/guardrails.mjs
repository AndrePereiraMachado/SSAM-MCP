import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fail} from './errors.mjs';
import {isUuid} from './write-journal.mjs';
export const GUARDRAILS_SAVE='agents.guardrailsSave';
export const GUARDRAILS_READ='agents.guardrailsV5';
const policyIds=['PiiRegexConfig','DeniedTopic','WordFilter','PromptAttack','PII','ContentFilter'];
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
// EmptyListItem is a serializer default, never an actual policy/config entry.
export function guardrailValues(v){return Array.isArray(v)?v.map(guardrailValues):v&&typeof v==='object'
 ?Object.fromEntries(Object.keys(v).filter(k=>k!=='EmptyListItem').sort().map(k=>[k,guardrailValues(v[k])])):v;}
export const guardrailHash=v=>createHash('sha256').update(JSON.stringify(guardrailValues(v))).digest('hex');
export const guardrailReadInput=p=>({screenVariables:{AssetKey:p.AppId,_assetKeyInDataFetchStatus:1,AgentElementId:p.AgentElementId,_agentElementIdInDataFetchStatus:1,
 EnvironmentId:p.EnvironmentId,_environmentIdInDataFetchStatus:1,EnvironmentName:p.EnvironmentName,_environmentNameInDataFetchStatus:1,
 EnvironmentPurpose:'Development',_environmentPurposeInDataFetchStatus:1,EnvironmentStatus:'Ready',_environmentStatusInDataFetchStatus:1}});
export function guardrailState(data){
 if(!exact(data,'GuardrailId,Policies,RegionSupportStatus')||data.RegionSupportStatus!=='Supported'
  ||typeof data.GuardrailId!=='string'||data.GuardrailId!==''&&!isUuid(data.GuardrailId))fail('GUARDRAIL_STATE_UNVERIFIED','An exact supported native guardrail state is required.');
 const policies=guardrailValues(data.Policies);
 if(!exact(policies,'List')||!Array.isArray(policies.List)||policies.List.length!==policyIds.length
  ||new Set(policies.List.map(x=>x?.Id)).size!==policyIds.length||policies.List.some(x=>!policyIds.includes(x?.Id)))
  fail('GUARDRAIL_STATE_UNVERIFIED','The complete native policy inventory is required.');
 return {GuardrailId:data.GuardrailId,Policies:policies};
}
export function validateGuardrailPolicies(before,requested){
 const bad=()=>fail('GUARDRAIL_POLICIES_INVALID','Policies must preserve native identities, administrative controls and read-only fields.');
 const b=guardrailValues(before),p=guardrailValues(requested);
 if(!exact(p,'List')||!Array.isArray(p.List)||p.List.length!==b.List.length)bad();
 for(let i=0;i<b.List.length;i++){
  const old=b.List[i],next=p.List[i];
  if(!exact(next,'Id,IsActive,AllowPolicyChange,Actions,SelectedAction,HasActiveAdminPolicy,WordsConfig,TopicsConfig,RegexesConfig')
   ||next.Id!==old.Id||typeof next.IsActive!=='boolean'||typeof next.SelectedAction!=='string')bad();
  const mutable=['IsActive','SelectedAction','WordsConfig','TopicsConfig','RegexesConfig'];
  if(Object.keys(old).some(k=>!mutable.includes(k)&&guardrailHash(next[k])!==guardrailHash(old[k])))bad();
  if((old.AllowPolicyChange!==true||old.HasActiveAdminPolicy===true)&&guardrailHash(old)!==guardrailHash(next))bad();
  if(!old.Actions.List.some(a=>a.Id===next.SelectedAction&&(next.SelectedAction===old.SelectedAction||a.ReadOnly===false)))bad();
  for(const [field,keys]of [['WordsConfig','Text,Action,IsAdmin'],['TopicsConfig','Name,Definition,Examples,Type,IsAdmin'],['RegexesConfig','Name,Description,Pattern,Action,IsAdmin']]){
   const list=next[field]?.List,previous=old[field]?.List;
   if(!exact(next[field],'List')||!Array.isArray(list)||!Array.isArray(previous)||list.length>100)bad();
   if(guardrailHash(list.filter(x=>x?.IsAdmin===true))!==guardrailHash(previous.filter(x=>x?.IsAdmin===true)))bad();
   for(const item of list){
    if(!exact(item,keys)||typeof item.IsAdmin!=='boolean')bad();
    for(const key of keys.split(',').filter(k=>!['IsAdmin','Examples'].includes(k)))if(typeof item[key]!=='string'||item[key].length>4096)bad();
    if(item.IsAdmin===false&&field!=='TopicsConfig'&&!old.Actions.List.some(a=>a.Id===item.Action&&a.ReadOnly===false))bad();
    if(field==='TopicsConfig'&&(!exact(item.Examples,'List')||!Array.isArray(item.Examples.List)||item.Examples.List.length>100||item.Examples.List.some(x=>typeof x!=='string'||x.length>4096)))bad();
   }
  }
  for(const [id,field]of [['WordFilter','WordsConfig'],['DeniedTopic','TopicsConfig'],['PiiRegexConfig','RegexesConfig']])
   if(next.Id===id&&next.IsActive&&!next[field].List.some(x=>x.IsAdmin===false))bad();
 }
 return p;
}
export async function guardrailsApproval({file,words,host,raw,lookup,readAsset,read}){
 const bad=()=>fail('GUARDRAIL_BASELINE_UNVERIFIED','The own agent, exact stage/element, current configuration and original grant must be verified before saving. Nothing was sent.');
 const p=raw.inputParameters;
 if(!file||!exact(p,'AppId,AgentElementId,EnvironmentId,EnvironmentName,GuardrailId,Policies,PortfolioId')
  ||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length
  ||[p.AppId,p.AgentElementId,p.EnvironmentId,p.PortfolioId].some(x=>!isUuid(x))||p.EnvironmentName!=='Development')bad();
 let c;try{if(fs.statSync(file).size>32768)bad();c=JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{bad();}
 if(c?.mode==='orphan-reset')return orphanResetApproval({file,words,host,p,c,lookup,readAsset,read,bad});
 if(!isUuid(c?.originOperationUuid)||!['create','update','restore','reset'].includes(c.mode))bad();
 const origin=lookup(c.originOperationUuid);
 if(!['accepted','confirmed'].includes(origin?.state)||origin.status!==201||origin.identity?.tenant!==host
  ||origin.identity.operationId!=='asset-repository-api-v1:post:/assets'||origin.response?.assetKey!==p.AppId||!origin.authorization?.source)bad();
 const asset=await readAsset(p.AppId);
 if(!asset?.ok||asset.data?.assetKey!==p.AppId||asset.data.assetType!=='Agent'||asset.data.portfolioKey!==p.PortfolioId||!asset.data.name||!Number.isSafeInteger(asset.data.revision)||asset.data.revision<1)bad();
 const stages=await read('agents.revisionStages',{screenVariables:{id:p.AppId,_idInDataFetchStatus:1,stageid:p.EnvironmentId,_stageidInDataFetchStatus:1,ActivePortfolioKey:p.PortfolioId}});
 const stage=stages?.data?.EnvironmentsApplicationVersion?.List?.filter(x=>x.Environment?.Key===p.EnvironmentId);
 if(stages?.ok!==true||stage?.length!==1||stage[0].Environment.Name!==p.EnvironmentName||stage[0].Environment.Purpose!=='Development'
  ||stage[0].Environment.Status!=='Ready'||stage[0].Environment.PortfolioKey!==p.PortfolioId)bad();
 const elements=await read('agents.elements',{screenVariables:{AssetKey:p.AppId,_assetKeyInDataFetchStatus:1,RevisionNumber:String(asset.data.revision),_revisionNumberInDataFetchStatus:1,
  StageKey:p.EnvironmentId,_stageKeyInDataFetchStatus:1,StageName:p.EnvironmentName,_stageNameInDataFetchStatus:1,IsReadyToFetch:true,_isReadyToFetchInDataFetchStatus:1}});
 const matches=elements?.data?.AgentList?.List?.filter(x=>x.ElementKey===p.AgentElementId);
 if(elements?.ok!==true||matches?.length!==1||!matches[0].Name)bad();
 const readInput=guardrailReadInput(p),seen=await read(GUARDRAILS_READ,readInput);if(seen?.ok!==true)bad();
 const before=guardrailState(seen.data),policies=validateGuardrailPolicies(before.Policies,p.Policies);
 if(p.GuardrailId!==before.GuardrailId)bad();
 const constraints={originOperationUuid:c.originOperationUuid,mode:c.mode,inputSha256:guardrailHash(p),expectedGuardrailSha256:guardrailHash(before)};
 let approval=authorizationContext(file,words,{lane:'odc',host,operation:GUARDRAILS_SAVE,environmentKey:p.EnvironmentId,targets:[asset.data.name,matches[0].Name],constraints});
 if(!approval||approval.wordsSha256!==origin.authorization.wordsSha256||approval.proposalSha256!==origin.authorization.proposalSha256
  ||approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId)bad();
 let originalPolicies;
 if(c.mode==='create'){
  if(before.GuardrailId!==''||before.Policies.List.some(x=>x.IsActive||x.HasActiveAdminPolicy)||c.guardrailOriginOperationUuid!==undefined)bad();
  originalPolicies=guardrailValues(before.Policies);
 }else{
  if(!isUuid(c.guardrailOriginOperationUuid)||!isUuid(before.GuardrailId))bad();
  const initial=lookup(c.guardrailOriginOperationUuid),e=initial?.reconciliation?.guardrails;
  if(initial?.state!=='confirmed'||initial.identity?.tenant!==host||initial.identity.operationId!==GUARDRAILS_SAVE||!e?.creation
   ||initial.response?.SavedGuardrailId!==before.GuardrailId||e.originOperationUuid!==c.originOperationUuid
   ||guardrailHash(e.readInput)!==guardrailHash(readInput)||initial.authorization?.proposalSha256!==approval.proposalSha256
   ||initial.authorization?.wordsSha256!==approval.wordsSha256||initial.authorization?.source?.threadId!==approval.source.threadId
   ||initial.authorization?.source?.messageId!==approval.source.messageId)bad();
  constraints.guardrailOriginOperationUuid=c.guardrailOriginOperationUuid;
  // Bind this extra constraint too, rather than trusting an unvalidated field.
  approval=authorizationContext(file,words,{lane:'odc',host,operation:GUARDRAILS_SAVE,environmentKey:p.EnvironmentId,targets:[asset.data.name,matches[0].Name],constraints});
  if(c.mode==='restore'&&guardrailHash(policies)!==guardrailHash(e.policies))bad();
  if(c.mode==='reset'){
   if(!e.originalPolicies||guardrailHash(policies)!==guardrailHash(e.originalPolicies))bad();
   originalPolicies=guardrailValues(e.originalPolicies);
  }
 }
 return {approval,expected:{readInput,policies,creation:c.mode==='create',requestedGuardrailId:p.GuardrailId,originOperationUuid:c.originOperationUuid,
  ...(originalPolicies?{originalPolicies}:{}),...(c.mode==='reset'?{originalRestoration:true}:{})},target:{applicationKey:p.AppId,environmentKey:p.EnvironmentId,agentElementId:p.AgentElementId}};
}
export function guardrailObservation(receipt,read){
 const scope={verificationScope:'saved-configuration',runtimeEnforcementVerified:false};
 const e=receipt.reconciliation?.guardrails;
 if(!e||read?.ok!==true)return {...scope,verified:false,reason:'guardrail-read-unavailable'};
 let state;try{state=guardrailState(read.data);}catch{return {...scope,verified:false,reason:'guardrail-state-unverified'};}
 const id=state.GuardrailId,reported=receipt.response?.SavedGuardrailId;
 const verified=(isUuid(id)||e.reset&&id==='')&&(reported===undefined||reported===''||reported===id)&&(e.creation||e.reset||id===e.requestedGuardrailId)&&guardrailHash(state.Policies)===guardrailHash(e.policies);
 return {...scope,verified,guardrailId:verified?id:null,policiesVerified:verified,stateSha256:guardrailHash(state),
  ...(e.originalRestoration?{originalPoliciesRestored:verified&&guardrailHash(state.Policies)===guardrailHash(e.originalPolicies)}:{})};
}

// A deleted own fixture can leave a configuration behind. Permit only the exact
// original inactive policies, backed by immutable creation and deletion evidence.
async function orphanResetApproval({file,words,host,p,c,lookup,readAsset,read,bad}){
 const initial=lookup(c.guardrailOriginOperationUuid),origin=lookup(c.originOperationUuid),deleted=lookup(c.deleteOperationUuid),e=initial?.reconciliation?.guardrails;
 if(!e?.creation||initial.state!=='confirmed'||initial.identity?.tenant!==host||initial.identity.operationId!==GUARDRAILS_SAVE
  ||initial.response?.SavedGuardrailId!==p.GuardrailId||!isUuid(p.GuardrailId)||e.originOperationUuid!==c.originOperationUuid
  ||guardrailHash(e.readInput)!==guardrailHash(guardrailReadInput(p))
  ||!['accepted','confirmed'].includes(origin?.state)||origin.status!==201||origin.identity?.tenant!==host
  ||origin.identity.operationId!=='asset-repository-api-v1:post:/assets'||origin.response?.assetKey!==p.AppId
  ||deleted?.state!=='confirmed'||deleted.status!==204||deleted.identity?.tenant!==host
  ||deleted.identity.operationId!=='asset-repository-api-v1:delete:/assets/{assetKey}'||deleted.identity.target?.assetKey!==p.AppId)bad();
 const gone=await readAsset(p.AppId);if(gone?.ok!==false||gone.status!==404)bad();
 let originalBytes,original;
 try{if(fs.statSync(c.originalApprovalFile).size>32768)bad();originalBytes=fs.readFileSync(c.originalApprovalFile);original=JSON.parse(originalBytes);}catch{bad();}
 const originalSha=createHash('sha256').update(originalBytes).digest('hex');
 if(originalSha!==initial.authorization?.contextSha256||original.constraints?.mode!=='create')bad();
 const targets=original.scope?.filter(s=>s.lane==='odc'&&s.host===host&&s.operation===GUARDRAILS_SAVE&&s.environmentKey===p.EnvironmentId).flatMap(s=>s.targets??[]);
 if(targets?.length!==2)bad();
 const old=authorizationContext(c.originalApprovalFile,words,{lane:'odc',host,operation:GUARDRAILS_SAVE,environmentKey:p.EnvironmentId,targets,
  constraints:{originOperationUuid:c.originOperationUuid,mode:'create',inputSha256:guardrailHash({...p,GuardrailId:'',Policies:e.policies})}});
 if(old.proposalSha256!==initial.authorization.proposalSha256||old.proposalSha256!==origin.authorization?.proposalSha256)bad();
 const policies=guardrailValues(p.Policies);
 if(policies?.List?.some(x=>x.IsActive||x.HasActiveAdminPolicy||['WordsConfig','TopicsConfig','RegexesConfig'].some(k=>x[k]?.List?.length))
  ||guardrailHash({GuardrailId:'',Policies:policies})!==original.constraints.expectedGuardrailSha256)bad();
 const seen=await read(GUARDRAILS_READ,e.readInput);if(seen?.ok!==true)bad();const before=guardrailState(seen.data);
 if(before.GuardrailId!==p.GuardrailId)bad();validateGuardrailPolicies(before.Policies,policies);
 const constraints={mode:'orphan-reset',originOperationUuid:c.originOperationUuid,guardrailOriginOperationUuid:c.guardrailOriginOperationUuid,
  deleteOperationUuid:c.deleteOperationUuid,originalApprovalFile:c.originalApprovalFile,originalApprovalSha256:originalSha,
  inputSha256:guardrailHash(p),expectedGuardrailSha256:guardrailHash(before)};
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:GUARDRAILS_SAVE,environmentKey:p.EnvironmentId,targets,constraints});
 for(const r of [initial,origin,deleted])if(r.authorization?.wordsSha256!==approval.wordsSha256
  ||r.authorization?.source?.threadId!==approval.source.threadId||r.authorization?.source?.messageId!==approval.source.messageId)bad();
 return {approval,expected:{readInput:e.readInput,policies,reset:true,creation:false,requestedGuardrailId:p.GuardrailId,originOperationUuid:c.originOperationUuid},
  target:{applicationKey:p.AppId,environmentKey:p.EnvironmentId,agentElementId:p.AgentElementId}};
}
