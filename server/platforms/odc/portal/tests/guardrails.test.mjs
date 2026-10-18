import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID as uuid,createHash} from 'node:crypto';
import {GUARDRAILS_SAVE,guardrailsApproval,guardrailHash,guardrailValues,guardrailReadInput,guardrailState,validateGuardrailPolicies,guardrailObservation} from '../runtime/guardrails.mjs';
import {guardrailPolicies,wordGuardrail} from './guardrail-fixture.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
test('guardrail policy values exclude serializer defaults and preserve every actual value',()=>{
 const p=guardrailPolicies(),clean=guardrailValues(p);assert.equal(clean.List[0].WordsConfig.EmptyListItem,undefined);
 const clone=structuredClone(p);clone.List[0].WordsConfig.EmptyListItem.Text='unused';assert.equal(guardrailHash(p),guardrailHash(clone));
 assert.notEqual(guardrailHash(p),guardrailHash(wordGuardrail(p)));assert.equal(guardrailState({GuardrailId:'',Policies:p,RegionSupportStatus:'Supported'}).GuardrailId,'');
 for(const change of [s=>s.RegionSupportStatus='Unsupported',s=>s.GuardrailId='foreign',s=>s.Policies.List.pop(),s=>s.Policies.List[0].Id=s.Policies.List[1].Id]){
  const s={GuardrailId:'',Policies:guardrailPolicies(),RegionSupportStatus:'Supported'};change(s);assert.throws(()=>guardrailState(s),e=>e.code==='GUARDRAIL_STATE_UNVERIFIED');
 }
});
test('policy validation rejects administrative and read-only changes, fake IDs and malformed active lists',()=>{
 const b=guardrailPolicies();assert.deepEqual(validateGuardrailPolicies(b,wordGuardrail(b)),guardrailValues(wordGuardrail(b)));
 for(const change of [p=>p.List[0].Id='Invented',p=>p.List[0].IsActive='true',p=>p.List[0].AllowPolicyChange=false,
  p=>p.List[0].Actions.List[0].ReadOnly=true,p=>p.List[0].SelectedAction='Missing',p=>p.List.find(x=>x.Id==='WordFilter').IsActive=true,
  p=>p.List[0].WordsConfig.List.push({Text:'Injected',Action:'Block',IsAdmin:true}),p=>p.List[0].RegexesConfig.List.push({Name:'r',Description:'',Pattern:'.*',Action:'Unknown',IsAdmin:false})]){
  const p=structuredClone(b);change(p);assert.throws(()=>validateGuardrailPolicies(b,p),e=>e.code==='GUARDRAIL_POLICIES_INVALID');
 }
 for(const key of ['AllowPolicyChange','HasActiveAdminPolicy']){const p=guardrailPolicies();p.List[0][key]=key==='HasActiveAdminPolicy';const next=structuredClone(p);next.List[0].IsActive=true;assert.throws(()=>validateGuardrailPolicies(p,next));}
});
test('guardrail observations require exact saved policy values and actual matching IDs',()=>{
 const id=uuid(),policies=wordGuardrail(guardrailPolicies()),receipt={reconciliation:{guardrails:{creation:true,policies}},response:{SavedGuardrailId:''}};
 const r={ok:true,data:{GuardrailId:id,Policies:policies,RegionSupportStatus:'Supported'}};assert.equal(guardrailObservation(receipt,r).verified,true);
 assert.equal(guardrailObservation(receipt,r).verificationScope,'saved-configuration');
 assert.equal(guardrailObservation(receipt,r).runtimeEnforcementVerified,false);
 receipt.response.SavedGuardrailId=uuid();assert.equal(guardrailObservation(receipt,r).verified,false);
 receipt.response.SavedGuardrailId='';receipt.reconciliation.guardrails.creation=false;receipt.reconciliation.guardrails.requestedGuardrailId=uuid();assert.equal(guardrailObservation(receipt,r).verified,false);
 receipt.reconciliation.guardrails.requestedGuardrailId=id;r.data.Policies=wordGuardrail(guardrailPolicies(),'Detect');assert.equal(guardrailObservation(receipt,r).verified,false);
 receipt.reconciliation.guardrails.reset=true;receipt.reconciliation.guardrails.policies=guardrailPolicies();r.data.Policies=guardrailPolicies();r.data.GuardrailId='';assert.equal(guardrailObservation(receipt,r).verified,true);
 assert.equal(guardrailObservation(receipt,{ok:false}).verified,false);
 assert.equal(guardrailObservation(receipt,{ok:false}).runtimeEnforcementVerified,false);
});

test('orphan reset requires immutable original inactive baseline, confirmed own deletion and fresh 404',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guard-reset-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const host='wrightflood.outsystems.dev',words='Own fixtures grant',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Restore own configuration'};
 const proposal=path.join(dir,'original.md'),nextProposal=path.join(dir,'cleanup.md'),originalFile=path.join(dir,'original.json'),file=path.join(dir,'cleanup.json');
 fs.writeFileSync(proposal,'Create own guardrail');fs.writeFileSync(nextProposal,'Reset deleted own fixture only');
 const originId=uuid(),initialId=uuid(),deleteId=uuid(),p={AppId:uuid(),AgentElementId:uuid(),EnvironmentId:uuid(),EnvironmentName:'Development',PortfolioId:uuid(),GuardrailId:uuid(),Policies:guardrailValues(guardrailPolicies())};
 const initialPolicies=wordGuardrail(guardrailPolicies()),before={GuardrailId:p.GuardrailId,Policies:initialPolicies,RegionSupportStatus:'Supported'};
 const scope=[{lane:'odc',host,operation:GUARDRAILS_SAVE,environmentKey:p.EnvironmentId,targets:['OwnApp','OwnAgent']}];
 fs.writeFileSync(originalFile,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:sha(fs.readFileSync(proposal))},scope,
  constraints:{mode:'create',originOperationUuid:originId,inputSha256:guardrailHash({...p,GuardrailId:'',Policies:initialPolicies}),expectedGuardrailSha256:guardrailHash({GuardrailId:'',Policies:p.Policies})}}));
 const auth={wordsSha256:sha(words),source,proposalSha256:sha(fs.readFileSync(proposal)),contextSha256:sha(fs.readFileSync(originalFile))};
 const origin={state:'confirmed',status:201,identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:p.AppId},authorization:auth};
 const initial={state:'confirmed',identity:{tenant:host,operationId:GUARDRAILS_SAVE},response:{SavedGuardrailId:p.GuardrailId},authorization:auth,
  reconciliation:{guardrails:{creation:true,originOperationUuid:originId,readInput:guardrailReadInput(p),policies:initialPolicies}}};
 const deleted={state:'confirmed',status:204,identity:{tenant:host,operationId:'asset-repository-api-v1:delete:/assets/{assetKey}',target:{assetKey:p.AppId}},authorization:auth};
 const approve=()=>fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:nextProposal,sha256:sha(fs.readFileSync(nextProposal))},scope,
  constraints:{mode:'orphan-reset',originOperationUuid:originId,guardrailOriginOperationUuid:initialId,deleteOperationUuid:deleteId,originalApprovalFile:originalFile,originalApprovalSha256:sha(fs.readFileSync(originalFile)),inputSha256:guardrailHash(p),expectedGuardrailSha256:guardrailHash(guardrailState(before))}}));
 let gone={ok:false,status:404};const args={file,words,host,raw:{inputParameters:p},lookup:id=>id===originId?origin:id===initialId?initial:id===deleteId?deleted:null,
  readAsset:async()=>gone,read:async()=>({ok:true,data:before})};approve();assert.equal((await guardrailsApproval(args)).expected.reset,true);
 for(const state of ['uncertain','accepted']){deleted.state=state;await assert.rejects(guardrailsApproval(args));}deleted.state='confirmed';
 gone={ok:false,status:403};await assert.rejects(guardrailsApproval(args));gone={ok:false,status:404};
 p.Policies=wordGuardrail(guardrailPolicies(),'Detect');approve();await assert.rejects(guardrailsApproval(args));p.Policies=guardrailValues(guardrailPolicies());approve();
 fs.appendFileSync(originalFile,' ');await assert.rejects(guardrailsApproval(args));
});
test('guardrail approval binds own asset, live element/stage, current hash, initial receipt and exact restoration',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guard-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const host='wrightflood.outsystems.dev',words='Own guardrail fixture grant',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own test'},originId=uuid(),initialId=uuid();
 const p={AppId:uuid(),AgentElementId:uuid(),EnvironmentId:uuid(),EnvironmentName:'Development',GuardrailId:'',Policies:wordGuardrail(guardrailPolicies()),PortfolioId:uuid()};
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Own guardrail create, update, restore');
 const origin={state:'accepted',status:201,identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:p.AppId},authorization:{source,wordsSha256:sha(words),proposalSha256:sha(fs.readFileSync(proposal))}};
 let state={GuardrailId:'',Policies:guardrailPolicies(),RegionSupportStatus:'Supported'},foreign=false,unsupported=false,initial;
 const approve=mode=>fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:sha(fs.readFileSync(proposal))},
  scope:[{lane:'odc',host,operation:GUARDRAILS_SAVE,environmentKey:p.EnvironmentId,targets:['OwnAgentApp','OwnAgent']}],
  constraints:{originOperationUuid:originId,mode,inputSha256:guardrailHash(p),expectedGuardrailSha256:guardrailHash(guardrailState(state)),...(mode==='create'?{}:{guardrailOriginOperationUuid:initialId})}}));
 const args={file,words,host,raw:{inputParameters:p},lookup:id=>id===originId?origin:id===initialId?initial:null,
  readAsset:async()=>({ok:true,data:{assetKey:p.AppId,name:'OwnAgentApp',assetType:'Agent',portfolioKey:p.PortfolioId,revision:2}}),
  read:async id=>id==='agents.revisionStages'?{ok:true,data:{EnvironmentsApplicationVersion:{List:[{Environment:{Key:p.EnvironmentId,Name:'Development',Purpose:unsupported?'Production':'Development',Status:'Ready',PortfolioKey:p.PortfolioId}}]}}}
   :id==='agents.elements'?{ok:true,data:{AgentList:{List:[{ElementKey:foreign?uuid():p.AgentElementId,Name:'OwnAgent'}]}}}:{ok:true,data:state}};
 approve('create');const created=await guardrailsApproval(args);assert.equal(created.expected.creation,true);
 foreign=true;await assert.rejects(guardrailsApproval(args),e=>e.code==='GUARDRAIL_BASELINE_UNVERIFIED');foreign=false;
 unsupported=true;await assert.rejects(guardrailsApproval(args),e=>e.code==='GUARDRAIL_BASELINE_UNVERIFIED');unsupported=false;
 const id=uuid();state={...state,GuardrailId:id,Policies:guardrailValues(p.Policies)};p.GuardrailId=id;
 initial={state:'confirmed',identity:{tenant:host,operationId:GUARDRAILS_SAVE},response:{SavedGuardrailId:id},authorization:created.approval,reconciliation:{guardrails:created.expected}};
 p.Policies=wordGuardrail(guardrailPolicies(),'Detect');approve('update');assert.equal((await guardrailsApproval(args)).expected.creation,false);
 approve('restore');await assert.rejects(guardrailsApproval(args),e=>e.code==='GUARDRAIL_BASELINE_UNVERIFIED');
 p.Policies=created.expected.policies;approve('restore');assert.deepEqual((await guardrailsApproval(args)).expected.policies,created.expected.policies);
 approve('reset');await assert.rejects(guardrailsApproval(args),e=>e.code==='GUARDRAIL_BASELINE_UNVERIFIED');
 p.Policies=guardrailValues(guardrailPolicies());approve('reset');
 const reset=await guardrailsApproval(args);assert.equal(reset.expected.originalRestoration,true);
 assert.deepEqual(created.expected.originalPolicies,guardrailValues(guardrailPolicies()));
 const observed={ok:true,data:{GuardrailId:id,Policies:p.Policies,RegionSupportStatus:'Supported'}};
 assert.equal(guardrailObservation({reconciliation:{guardrails:reset.expected}},observed).originalPoliciesRestored,true);
 observed.data.Policies=created.expected.policies;
 assert.equal(guardrailObservation({reconciliation:{guardrails:reset.expected}},observed).originalPoliciesRestored,false);
 delete initial.reconciliation.guardrails.originalPolicies;
 await assert.rejects(guardrailsApproval(args),e=>e.code==='GUARDRAIL_BASELINE_UNVERIFIED');
 p.Policies=created.expected.policies;approve('restore');
 state.Policies=wordGuardrail(guardrailPolicies(),'Detect');await assert.rejects(guardrailsApproval(args),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
 assert.deepEqual(guardrailReadInput(p),created.expected.readInput);
});
