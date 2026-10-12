import fs from 'node:fs';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fail} from './errors.mjs';
import {isUuid} from './write-journal.mjs';
import {guardrailHash,guardrailValues} from './guardrails.mjs';
export const BASELINE_SAVE='guardrails.baselineSave',BASELINE_READ='guardrails.baseline';
const ids=['PromptAttack','PII','ContentFilter','PiiRegexConfig','DeniedTopic','WordFilter'];
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const bad=()=>fail('GUARDRAIL_BASELINE_UNVERIFIED','Exact native administrative state, stage, policies and contextual approval are required. Nothing was sent.');
export const baselineReadInput=p=>({screenVariables:{portfolioid:p.PortfolioKey,stageid:p.EnvironmentId}});
export function baselineState(data){
 if(!exact(data,'GuardrailId,Policies,RegionSupportStatus')||data.RegionSupportStatus!=='Supported'
  ||typeof data.GuardrailId!=='string'||data.GuardrailId!==''&&!isUuid(data.GuardrailId))bad();
 const state=guardrailValues({GuardrailId:data.GuardrailId,Policies:data.Policies}),list=state.Policies?.List;
 if(!exact(state.Policies,'List')||!Array.isArray(list)||list.length!==6||new Set(list.map(x=>x?.Id)).size!==6
  ||list.some(x=>!ids.includes(x?.Id)||!exact(x,'Id,IsEnabled,Actions,SelectedAction,WordsConfig,TopicsConfig,RegexesConfig')
   ||typeof x.IsEnabled!=='boolean'||typeof x.SelectedAction!=='string'||!exact(x.Actions,'List')||!Array.isArray(x.Actions.List)
   ||!x.Actions.List.length||new Set(x.Actions.List.map(a=>a?.Id)).size!==x.Actions.List.length
   ||x.Actions.List.some(a=>!exact(a,'Id,Order')||!['Block','Mask','Detect'].includes(a.Id)||!Number.isInteger(a.Order)||a.Order<1)
   ||!x.Actions.List.some(a=>a.Id===x.SelectedAction)))bad();
 // Validate the native configs as strictly as a request before trusting readback.
 baselineRequestedPolicies(state,baselineWirePolicies(state.Policies));
 return state;
}
export const baselineWirePolicies=policies=>({List:guardrailValues(policies).List.map(x=>({Id:x.Id,IsEnabled:x.IsEnabled,
 Config:{Action:x.SelectedAction,WordsConfig:x.WordsConfig,TopicsConfig:x.TopicsConfig,RegexesConfig:x.RegexesConfig}}))});
export function baselineRequestedPolicies(before,wire){
 if(!exact(wire,'List')||!Array.isArray(wire.List)||wire.List.length!==6)bad();
 const requested=structuredClone(before.Policies);
 for(let i=0;i<6;i++){
  const old=before.Policies.List[i],p=wire.List[i],next=requested.List[i];
  if(!exact(p,'Id,IsEnabled,Config')||p.Id!==old.Id||typeof p.IsEnabled!=='boolean'
   ||!exact(p.Config,'Action,WordsConfig,TopicsConfig,RegexesConfig')||!old.Actions.List.some(x=>x.Id===p.Config.Action))bad();
  for(const [field,keys]of [['WordsConfig','Text,Action'],['TopicsConfig','Name,Definition,Type,Examples'],['RegexesConfig','Name,Description,Pattern,Action']]){
   const v=p.Config[field];if(!exact(v,'List')||!Array.isArray(v.List)||v.List.length>100)bad();
   for(const entry of v.List){if(!exact(entry,keys))bad();for(const key of keys.split(',').filter(x=>x!=='Examples'))if(typeof entry[key]!=='string'||entry[key].length>4096)bad();
    if(field==='TopicsConfig'){if(!exact(entry.Examples,'List')||!Array.isArray(entry.Examples.List)||entry.Examples.List.length>5||entry.Examples.List.some(x=>typeof x!=='string'||x.length>4096))bad();}
    else if(!old.Actions.List.some(x=>x.Id===entry.Action))bad();
   }
   next[field]=structuredClone(v);
  }
  next.IsEnabled=p.IsEnabled;next.SelectedAction=p.Config.Action;
  const field={WordFilter:'WordsConfig',DeniedTopic:'TopicsConfig',PiiRegexConfig:'RegexesConfig'}[p.Id];
  if(p.IsEnabled&&field&&!next[field].List.length)bad();
 }
 return guardrailValues(requested);
}
export async function baselineApproval({file,words,host,raw,lookup,read}){
 const p=raw.inputParameters;
 if(!file||!exact(p,'EnvironmentId,EnvironmentName,GuardrailId,PortfolioKey,Policies')||!isUuid(p.EnvironmentId)||!isUuid(p.PortfolioKey)
  ||p.EnvironmentName!=='Development'||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length)bad();
 let c;try{if(fs.statSync(file).size>32768)bad();c=JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{bad();}
 if(!['configure','restore'].includes(c?.mode)||typeof c.allowRetainedId!=='boolean')bad();
 const stages=await read('guardrails.stages',{screenVariables:{portfolioid:p.PortfolioKey,ActivePortfolioKey:p.PortfolioKey,_portfolioidInDataFetchStatus:1}});
 const matches=stages?.ok===true?stages.data?.Stages?.List?.filter(x=>x.Stage?.Key===p.EnvironmentId):[];
 if(matches?.length!==1||matches[0].OptionsItems?.IsDisabled!==false||matches[0].Stage.PortfolioKey!==p.PortfolioKey
  ||matches[0].Stage.Name!==p.EnvironmentName||matches[0].Stage.Purpose!=='Development'||matches[0].Stage.Status!=='Ready')bad();
 const readInput=baselineReadInput(p),seen=await read(BASELINE_READ,readInput);if(seen?.ok!==true)bad();
 const before=baselineState(seen.data);if(before.GuardrailId!==p.GuardrailId)bad();
 const policies=baselineRequestedPolicies(before,p.Policies),constraints={mode:c.mode,allowRetainedId:c.allowRetainedId,inputSha256:guardrailHash(p),expectedBaselineSha256:guardrailHash(before)};
 if(c.mode==='configure'&&before.GuardrailId===''&&!c.allowRetainedId)bad();
 let initial;
 if(c.mode==='restore'){
  if(!isUuid(c.originOperationUuid))bad();initial=lookup(c.originOperationUuid);const e=initial?.reconciliation?.guardrailBaseline;
  if(initial?.state!=='confirmed'||initial.identity?.tenant!==host||initial.identity.operationId!==BASELINE_SAVE||e?.mode!=='configure'
   ||guardrailHash(e.readInput)!==guardrailHash(readInput)||guardrailHash(before.Policies)!==guardrailHash(e.policies)
   ||initial.response?.Id!==before.GuardrailId||c.allowRetainedId!==e.allowRetainedId||guardrailHash(policies)!==guardrailHash(e.beforeState.Policies))bad();
  constraints.originOperationUuid=c.originOperationUuid;
 }
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:BASELINE_SAVE,environmentKey:p.EnvironmentId,
  targets:[p.EnvironmentName,'Guardrail baseline '+p.PortfolioKey],constraints});
 if(!approval)bad();
 if(initial&&(initial.authorization?.wordsSha256!==approval.wordsSha256||initial.authorization?.proposalSha256!==approval.proposalSha256
  ||initial.authorization?.source?.threadId!==approval.source.threadId||initial.authorization?.source?.messageId!==approval.source.messageId))bad();
 return {approval,expected:{readInput,policies,beforeState:before,originalGuardrailId:initial?.reconciliation.guardrailBaseline.beforeState.GuardrailId??before.GuardrailId,requestedGuardrailId:p.GuardrailId,mode:c.mode,allowRetainedId:c.allowRetainedId}};
}
export function baselineObservation(receipt,read){
 const scope={verificationScope:'saved-configuration',runtimeEnforcementVerified:false};
 const e=receipt.reconciliation?.guardrailBaseline;if(!e||read?.ok!==true)return {...scope,verified:false,reason:'baseline-read-unavailable'};
 let state;try{state=baselineState(read.data);}catch{return {...scope,verified:false,reason:'baseline-state-unverified'};}
 const id=state.GuardrailId,reported=receipt.response?.Id;
 const idValid=isUuid(id)||e.mode==='restore'&&e.allowRetainedId&&id==='';
 const same=e.requestedGuardrailId===''||id===e.requestedGuardrailId||e.mode==='restore'&&id==='';
 const verified=idValid&&same&&(reported===undefined||reported===''||reported===id)&&guardrailHash(state.Policies)===guardrailHash(e.policies);
 return {...scope,verified,guardrailId:verified?id:null,policiesVerified:verified,stateSha256:guardrailHash(state),retainedId:verified&&e.mode==='restore'&&e.originalGuardrailId===''&&id!==''};
}
