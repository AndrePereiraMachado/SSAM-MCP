import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID as uuid,createHash} from 'node:crypto';
import {BASELINE_SAVE,BASELINE_READ,baselineState,baselineWirePolicies,baselineRequestedPolicies,baselineApproval,baselineObservation,baselineReadInput} from '../runtime/guardrail-baseline-write.mjs';
import {guardrailHash} from '../runtime/guardrails.mjs';
const ids=['PromptAttack','PII','ContentFilter','PiiRegexConfig','DeniedTopic','WordFilter'];
export const administrativeState=()=>({GuardrailId:'',RegionSupportStatus:'Supported',Policies:{List:ids.map(Id=>({Id,IsEnabled:false,Actions:{List:[{Id:'Block',Order:1},{Id:'Detect',Order:3}]},SelectedAction:'Block',WordsConfig:{List:[]},TopicsConfig:{List:[]},RegexesConfig:{List:[]}}))}});
const invalid=f=>assert.throws(f,e=>e.code==='GUARDRAIL_BASELINE_UNVERIFIED');
test('administrative policies preserve native wire contract and reject incomplete or foreign state',()=>{
 const state=baselineState(administrativeState()),wire=baselineWirePolicies(state.Policies);
 assert.deepEqual(baselineRequestedPolicies(state,wire),state.Policies);
 assert.deepEqual(Object.keys(wire.List[0]).sort(),['Config','Id','IsEnabled']);
 for(const mutate of [s=>s.Policies.List.pop(),s=>s.Policies.List[0].IsActive=false,s=>s.Policies.List[0].Actions.List[0].Id='Unknown',s=>s.Policies.List[0].SelectedAction='Mask',s=>s.Policies.List[0].WordsConfig={List:[{Text:'x',Action:'Unknown'}]},s=>s.Policies.List[5].IsEnabled=true]){
  const s=administrativeState();mutate(s);invalid(()=>baselineState(s));
 }
 for(const mutate of [w=>w.List.reverse(),w=>w.List[0].Config.Action='Unknown',w=>w.List[5].Config.WordsConfig.List.push({Text:'x',Action:'Mask'}),w=>w.List[0].Config.TopicsConfig.List.push({Name:'x',Definition:'x',Type:'x',Examples:{List:[1]}})]){
  const w=structuredClone(wire);mutate(w);invalid(()=>baselineRequestedPolicies(state,w));
 }
 const w=structuredClone(wire);w.List[5].IsEnabled=true;w.List[5].Config.Action='Detect';w.List[5].Config.WordsConfig.List=[{Text:'SSAM_SYNTHETIC',Action:'Detect'}];
 const next=baselineRequestedPolicies(state,w);assert.equal(next.List[5].IsEnabled,true);assert.equal(state.Policies.List[5].IsEnabled,false);
});
test('administrative approval binds fresh stage, original policies, human proposal and restoration',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'baseline-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const host='wrightflood.outsystems.dev',words='Synthetic test authorization',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Administrative test'};
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Two writes and explicit retained ID exception');
 const p={EnvironmentId:uuid(),EnvironmentName:'Development',GuardrailId:'',PortfolioKey:uuid(),Policies:baselineWirePolicies(administrativeState().Policies)};
 p.Policies.List[5].IsEnabled=true;p.Policies.List[5].Config.Action='Detect';p.Policies.List[5].Config.WordsConfig.List=[{Text:'SSAM_SYNTHETIC',Action:'Detect'}];
 let current=administrativeState(),initial,foreign=false;const origin=uuid();
 const approve=(mode,allowRetainedId=true)=>fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
  scope:[{lane:'odc',host,operation:BASELINE_SAVE,environmentKey:p.EnvironmentId,targets:['Development','Guardrail baseline '+p.PortfolioKey]}],
  constraints:{mode,allowRetainedId,inputSha256:guardrailHash(p),expectedBaselineSha256:guardrailHash(baselineState(current)),...(mode==='restore'?{originOperationUuid:origin}:{})}}));
 const args={file,words,host,raw:{inputParameters:p},lookup:()=>initial,read:async op=>op===BASELINE_READ?{ok:true,data:current}:{ok:true,data:{Stages:{List:[{Stage:{Key:p.EnvironmentId,Name:'Development',Purpose:'Development',Status:'Ready',PortfolioKey:foreign?uuid():p.PortfolioKey},OptionsItems:{IsDisabled:false}}]}}}};
 approve('configure',false);await assert.rejects(baselineApproval(args),e=>e.code==='GUARDRAIL_BASELINE_UNVERIFIED');
 approve('configure');foreign=true;await assert.rejects(baselineApproval(args));foreign=false;
 const configured=await baselineApproval(args);assert.equal(configured.expected.originalGuardrailId,'');
 current={...current,GuardrailId:uuid(),Policies:structuredClone(configured.expected.policies)};
 initial={state:'confirmed',identity:{tenant:host,operationId:BASELINE_SAVE},response:{Id:current.GuardrailId},authorization:configured.approval,reconciliation:{guardrailBaseline:configured.expected}};
 p.GuardrailId=current.GuardrailId;p.Policies=baselineWirePolicies(configured.expected.beforeState.Policies);approve('restore');
 const restored=await baselineApproval(args);assert.equal(restored.expected.originalGuardrailId,'');assert.deepEqual(restored.expected.policies,configured.expected.beforeState.Policies);
 current.Policies.List[0].SelectedAction='Detect';approve('restore');await assert.rejects(baselineApproval(args),e=>e.code==='GUARDRAIL_BASELINE_UNVERIFIED');
 current.Policies.List[0].SelectedAction='Block';approve('restore');initial.authorization.source.messageId=uuid();await assert.rejects(baselineApproval(args));
 assert.deepEqual(baselineReadInput(p),configured.expected.readInput);
});
test('baseline observation verifies full state and accurately distinguishes a retained created ID',()=>{
 const native=administrativeState(),id=uuid(),expected={mode:'restore',allowRetainedId:true,originalGuardrailId:'',requestedGuardrailId:id,policies:baselineState(native).Policies};
 const receipt={response:{Id:id},reconciliation:{guardrailBaseline:expected}},read={ok:true,data:{...native,GuardrailId:id}};
 assert.equal(baselineObservation(receipt,read).retainedId,true);
 assert.equal(baselineObservation(receipt,read).verificationScope,'saved-configuration');
 assert.equal(baselineObservation(receipt,read).runtimeEnforcementVerified,false);
 expected.originalGuardrailId=id;assert.equal(baselineObservation(receipt,read).retainedId,false);
 read.data.Policies.List[0].SelectedAction='Detect';assert.equal(baselineObservation(receipt,read).verified,false);
 read.data.Policies.List[0].SelectedAction='Block';read.data.GuardrailId=uuid();assert.equal(baselineObservation(receipt,read).verified,false);
 assert.equal(baselineObservation(receipt,{ok:false}).verified,false);
 assert.equal(baselineObservation(receipt,{ok:false}).runtimeEnforcementVerified,false);
});
