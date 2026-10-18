import '../../facade/tests/fixtures/isolated-profile.mjs';
import {ORGANIZATION_GET,ORGANIZATION_RENAME,organizationRenamePlan} from '../runtime/organization-rename.mjs';
import {API_CLIENT_CREATE,API_CLIENT_DELETE} from '../runtime/api-client-fixture.mjs';

test('native fixture vault cleanup follows confirmed absence and projects a durable result without repeating remote deletion',async t=>{
 for(const lost of [false,true]){
  const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const key=uuid(),creationOperationUuid=uuid(),operationUuid=uuid(),name='SSAMApiClientProof20261010';let nativeCalls=0,reads=0;
  const r=h.access.receipts.reserve({operationUuid,identity:{kind:'odc-portal',tenant:PERSONAL,operationId:API_CLIENT_DELETE,target:{apiClientKey:key}},wordsSha256:'a'.repeat(64),
    reconciliation:{apiClientFixture:{key,name,creationOperationUuid}},plan:{}});h.access.receipts.settle(r,{state:'accepted'});
  h.access.studioState=async()=>({running:true,capabilities:['portal-api-client-fixture-cleanup'],sessions:[{host:PERSONAL,loggedIn:true,user:'dev@example.test'}]});
  h.access.portalRead=async()=>{reads++;return {ok:true,complete:true,requestedPageConsistencyVerified:true,requestedOffset:0,scope:{NameContains:'',Status:''},rows:[],totalResults:0};};
  h.access.studio.call=async args=>{nativeCalls++;assert.equal(args[0],'portal-api-client-fixture-cleanup');assert.deepEqual(h.requests.get(args[1]),{schema:'ssam-api-client-fixture-cleanup/1',creationOperationUuid,deletionOperationUuid:operationUuid,authorizeSha256:'a'.repeat(64)});
    assert.equal(h.access.receipts.lookup(operationUuid).state,'confirmed');
    if(lost&&nativeCalls===1)return {ok:false,code:'UNCERTAIN'};
    return {ok:true,host:PERSONAL,user:'dev@example.test',key,name,creationOperationUuid,deletionOperationUuid:operationUuid,vaultRemoved:true,remoteDeletionVerified:true,rawValueExposed:false,UnexpectedEcho:'synthetic-private-value'};};
  const first=await h.access.reconcileApiClientDeletion(h.access.receipts.lookup(operationUuid),'auto');assert.equal(first.readBack.verified,true);assert.equal(first.readBack.vaultCleanupConfirmed,!lost);
  const second=await h.access.reconcileApiClientDeletion(h.access.receipts.lookup(operationUuid),'auto');assert.equal(second.readBack.vaultCleanupConfirmed,true);assert.equal(reads,1);assert.equal(nativeCalls,lost?2:1);
  assert.equal(JSON.stringify(h.access.receipts.lookup(operationUuid)).includes('synthetic-private-value'),false);
 }
});

test('API client detail binds one exact UUID before calling its data action',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const key=uuid();let reads=0;
 h.access.resolvePortal=async()=>({path:'vault',broker:{callScreenservice:async r=>{reads++;assert.deepEqual(r.input.screenVariables,{id:key,_idInDataFetchStatus:1});return {data:{ApiClientDetails:{Key:key}}};}}});
 for(const input of [{},{screenVariables:{id:'invalid',_idInDataFetchStatus:1}},{screenVariables:{id:key}},
  {screenVariables:{id:key,_idInDataFetchStatus:1,edit:true}},{inputParameters:{Key:key},screenVariables:{id:key,_idInDataFetchStatus:1}}]){
  const result=await h.access.portalRead({tenant:PERSONAL,operationId:'apiClients.detail',input});assert.equal(result.error.code,'INPUT_INVALID');
 }
 assert.equal(reads,0);assert.equal((await h.access.portalRead({tenant:PERSONAL,operationId:'apiClients.detail',input:{screenVariables:{id:key,_idInDataFetchStatus:1}}})).data.ApiClientDetails.Key,key);assert.equal(reads,1);
});

test('API client fixture creation reserves before send, preserves private proof for owned deletion and never replays',async t=>{
 for(const lost of [false,true]){
  const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const words='Synthetic own API client grant',operationUuid=uuid(),key=uuid(),name='SSAMApiClientProof20261010';let writes=0;
  const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own API client fixture'};
  const proposal=path.join(h.dir,'api-client.md'),file=path.join(h.dir,'approval.json');fs.writeFileSync(proposal,'Create and delete own zero permission API client');
  const record={schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
   scope:[API_CLIENT_CREATE,API_CLIENT_DELETE].map(operation=>({lane:'odc',host:CORPORATE,operation,targets:[name]}))};
  const input={inputParameters:{OIDCClientCreate:{Name:name,Description:'Own fixture',SecretExpiresAt:new Date(Date.now()+86400000).toISOString(),IsActive:true,IsSendSecretExpiryEmail:false,Permissions:{List:[]}}}};
  const save=(raw,creationOperationUuid=operationUuid)=>fs.writeFileSync(file,JSON.stringify({...record,constraints:{creationOperationUuid,inputSha256:crypto.createHash('sha256').update(JSON.stringify(raw.inputParameters)).digest('hex')}}));save(input);
  const resolved={path:'vault',host:CORPORATE,privateSender:Object.assign(()=>{}, {apiClientVault:false}),broker:{callScreenservice:async r=>{
   writes++;assert.equal(JSON.parse(fs.readFileSync(h.access.receipts.file(r.operationUuid))).state,'sending');
   if(lost)throw new OdcError('UNCERTAIN','Synthetic lost response',{sent:true});
   if(r.operationId===API_CLIENT_DELETE)throw new OdcError('PORTAL_REQUEST_FAILED','Synthetic native refusal',{sent:true,status:200,remoteCode:'OS-BERT-00000',remoteCauseCode:'OS-UAUC-60002',remoteType:'UserException',UnexpectedEcho:'synthetic-private-value'});
   return {data:r.operationId===API_CLIENT_CREATE?{ApiClientProof:{key,name,operationUuid,vaultRef:'urn:ssam:api-client:'+operationUuid,vaultStored:true,rawValueExposed:false,responseProjected:true}}:{}};
  }}};
  h.access.resolvePortal=async()=>resolved;
  const args={tenant:CORPORATE,confirmTenant:CORPORATE,operationId:API_CLIENT_CREATE,input,authorize:words,operationUuid,authorizationContext:file};
  const refused=await h.access.portalWrite(args);assert.equal(refused.error.code,'HEADLESS_AUTH_UNAVAILABLE');assert.equal(writes,0);assert.equal(h.access.receipts.lookup(operationUuid),null);
  resolved.privateSender.apiClientVault=true;const first=await h.access.portalWrite(args);assert.equal(first.receipt?.state,lost?'uncertain':'accepted',JSON.stringify(first));
  await h.access.portalWrite(args);assert.equal(writes,1);
  const another=uuid();save(input,another);const duplicate=await h.access.portalWrite({...args,operationUuid:another});assert.ok(['TARGET_PENDING','ONE_SHOT_ALREADY_RESERVED'].includes(duplicate.error?.code),JSON.stringify(duplicate));assert.equal(writes,1);
  if(!lost){
   const receipt=h.access.receipts.lookup(operationUuid);assert.equal(receipt.response.ApiClientProof.key,key);
   let inventoryAvailable=false;
   h.access.portalRead=async r=>{assert.equal(r.operationId,'apiClients.list');assert.equal(r.input.screenVariables.Filter.Status,'');return inventoryAvailable
    ?{ok:true,complete:true,requestedPageConsistencyVerified:true,requestedOffset:0,scope:{NameContains:'',Status:''},rows:[],totalResults:0}:{ok:false};};
   const removal={inputParameters:{Key:key}};save(removal);const deletionArgs={...args,operationId:API_CLIENT_DELETE,input:removal,operationUuid:uuid()};
   const deletion=await h.access.portalWrite(deletionArgs);assert.equal(deletion.receipt?.state,'uncertain',JSON.stringify(deletion));assert.equal(deletion.deletionConfirmed,false);assert.equal(writes,2);
   assert.equal(deletion.writeError.remoteCode,'OS-BERT-00000');
   assert.deepEqual(h.access.receipts.lookup(deletionArgs.operationUuid).requestFailure,{code:'PORTAL_REQUEST_FAILED',status:200,remoteCode:'OS-BERT-00000',remoteCauseCode:'OS-UAUC-60002',remoteType:'UserException',sent:true});
   assert.equal(JSON.stringify(h.access.receipts.lookup(deletionArgs.operationUuid)).includes('synthetic-private-value'),false);
   inventoryAvailable=true;const reconciled=await h.access.portalWrite(deletionArgs);assert.equal(reconciled.receipt.state,'confirmed');assert.equal(reconciled.deletionConfirmed,true);assert.equal(reconciled.readBack.vaultCleanupConfirmed,false);assert.equal(writes,2);
   assert.equal((await h.access.portalWrite({...deletionArgs,authorize:'Different words'})).error.code,'AUTHORIZATION_CONTEXT_INVALID');assert.equal(writes,2);
   const foreign={inputParameters:{Key:uuid()}};save(foreign);const denied=await h.access.portalWrite({...args,operationId:API_CLIENT_DELETE,input:foreign,operationUuid:uuid()});assert.equal(denied.error.code,'AUTHORIZATION_CONTEXT_INVALID');assert.equal(writes,2);
  }
 }
});
import {STAGE_RENAME,STAGE_BATCH_RENAME,STAGES,stageRenamePlan,stageBatchRenamePlan,stageOrderPlan} from '../runtime/stage-rename.mjs';
import {MOBILE_FILE_UPLOAD,MOBILE_FILE_CONVERT,MOBILE_FILE_SAVE,mobileBinaryContent} from '../runtime/mobile-binary-upload.mjs';
import {MOBILE_EXTENSIBILITY_GET} from '../runtime/mobile-binary-save.mjs';
import {ENV_DEFAULTS_GET,ENV_DEFAULTS_PATCH,environmentDefaultsPlan} from '../runtime/environment-defaults.mjs';
import {USER_CREATE,USER_PATCH,USER_DELETE,USER_BULK_CREATE} from '../runtime/inactive-user-approval.mjs';
import test from 'node:test';
import {connectionHeaderPlan} from '../runtime/connection-header-plan.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Catalog } from '../runtime/catalog.mjs';
import { MAX_ROUTE_ACTIONS, MAX_ROUTE_SCREENS, OdcAccess, guardPortalTarget, guardTenant, guardTarget } from '../runtime/access.mjs';
import { WriteJournal,fingerprint } from '../runtime/write-journal.mjs';
import { OdcError } from '../runtime/errors.mjs';
import { TIMER_CONFIGURATION, TIMER_APPLICATION_REVISION } from '../runtime/portal-timer.mjs';
import { OPERATION_STATUS, SEARCH_POSTS, TARGET_NAMES, effectOf, readable } from '../runtime/effects.mjs';
import { PORTAL_CAPTURE, PORTAL_GAPS, PORTAL_READS, PORTAL_WRITES, NEVER_EXPOSED, routeOf } from '../runtime/portal-routes.mjs';
import { sampleRequest } from './helpers.mjs';
import {IP_FILTER_CREATE,IP_FILTER_PATCH,IP_FILTER_DELETE,ipFilterHash,ipFilterApproval} from '../runtime/ip-filter-approval.mjs';
import {ORG_ROLE_CREATE,ORG_ROLE_PATCH,ORG_ROLE_DELETE} from '../runtime/organization-role-approval.mjs';
import {ASSET_DEPLOYMENT} from '../runtime/asset-deployment-approval.mjs';
import {MOBILE_CONFIGURATION_WRITES,mobileConfigurationHash,mobileConfigurationStateHash} from '../runtime/mobile-configuration-approval.mjs';
import {MOBILE_EXTENSIBILITY_PATCH,extensibilityStateHash} from '../runtime/mobile-extensibility.mjs';
import {DATASET_DELETE,datasetStateHash} from '../runtime/dataset-delete-approval.mjs';
import {DATASET_CREATE,datasetInputHash} from '../runtime/dataset-create-approval.mjs';
import {a2aConnectionPlan,a2aSaveInput} from '../runtime/a2a-connection-plan.mjs';
import {A2A_TEST,A2A_SAVE} from '../runtime/a2a-connection-approval.mjs';
import {CUSTOM_SEARCH_TEST,CUSTOM_SEARCH_SAVE} from '../runtime/custom-search-connection-approval.mjs';
import {customSearchConnectionPlan,customSearchSaveInput} from '../runtime/custom-search-connection-plan.mjs';
import {A2A_DISCOVER} from '../runtime/a2a-discovery.mjs';
import {a2aDeleteApproval} from '../runtime/a2a-delete-approval.mjs';
import {redact} from '../runtime/errors.mjs';
import {PORTFOLIO_RENAME,PORTFOLIOS,portfolioRenamePlan} from '../runtime/portfolio-rename.mjs';
import { AI_TRIAL_CREATE, AI_TRIAL_DELETE, aiModelInventoryInput } from '../runtime/ai-model-trial.mjs';
import {EVALUATION_CREATE,evaluationHash} from '../runtime/evaluation-fixture.mjs';
import {GUARDRAILS_SAVE,GUARDRAILS_READ,guardrailHash,guardrailState,guardrailReadInput} from '../runtime/guardrails.mjs';
import {guardrailPolicies,wordGuardrail} from './guardrail-fixture.mjs';
test('alternate inventory calls exactly its native read and never returns raw configuration',async t=>{
 const portfolioKey=crypto.randomUUID(),connectionId=crypto.randomUUID(),seen=[];
 const h=harness({brokerState:{available:true,authenticated:true,callScreenservice:async request=>{seen.push(request);return {data:{Connections:{List:[{ConnectionId:connectionId,Name:'Own fixture',Configuration:'private-marker'}]},TotalResults:1,MaxRecords:20}};}}});
 t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const r=await h.access.portalRead({tenant:PERSONAL,auth:'portal-credential',operationId:'connections.alternateInventory',input:{portfolioKey}});
 assert.equal(r.ok,true);assert.equal(r.data.rows[0].ConnectionId,connectionId);assert.equal(r.data.complete,true);assert.equal(JSON.stringify(r).includes('private-marker'),false);
 assert.equal(seen.length,1);assert.equal(seen[0].write,false);assert.equal(seen[0].input.screenVariables.portfolioid,portfolioKey);assert.equal(h.prompts.length,0);
});
import {BASELINE_SAVE,BASELINE_READ,baselineState,baselineWirePolicies,baselineRequestedPolicies,baselineReadInput} from '../runtime/guardrail-baseline-write.mjs';
test('guardrail reconciliation read exceptions keep configuration scope and never imply runtime enforcement',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 h.access.portalRead=async()=>{throw new Error('Read unavailable');};
 for(const [method,key]of [['reconcileGuardrails','guardrails'],['reconcileGuardrailBaseline','guardrailBaseline']]){
  const receipt={identity:{tenant:CORPORATE},reconciliation:{[key]:{readInput:{}}}};
  const result=await h.access[method](receipt,'portal-credential');
  assert.equal(result.receipt,receipt);assert.equal(result.readBack.verified,false);
  assert.equal(result.readBack.verificationScope,'saved-configuration');
  assert.equal(result.readBack.runtimeEnforcementVerified,false);
 }
});

test('mobile file receipts precede upload, bind the setting and never replay a lost answer',async t=>{
 for(const conversion of [false,true])for(const lost of [false,true]){
  const operation=conversion?MOBILE_FILE_CONVERT:MOBILE_FILE_UPLOAD,key=conversion?'BinaryData':'FileContent';
  const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const words='Synthetic own mobile upload',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own binary fixture'};
  const applicationKey=uuid(),environmentKey=uuid(),settingKey=uuid(),portfolioKey=uuid(),originOperationUuid=uuid(),operationUuid=uuid();let sends=0;
  const raw={inputParameters:{[key]:Buffer.from('synthetic').toString('base64')}};
  const current={settings:[{key:settingKey,name:'File',dataType:'BinaryUrl',isSecret:false,value:null,defaultValue:null,valueOrigin:'Default'}],libraries:[]};
  const lookup=h.access.receipts.lookup.bind(h.access.receipts);h.access.receipts.lookup=(id,...rest)=>id===originOperationUuid?{state:'confirmed',identity:{tenant:CORPORATE,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:applicationKey},authorization:{source}}:lookup(id,...rest);
  h.access.read=async r=>({ok:true,data:r.operationId.startsWith('asset-')?{assetKey:applicationKey,name:'Fixture',assetType:'MobileApplication',portfolioKey}:current});
  h.access.portalRead=async()=>({ok:true,data:{EnableNAOSBASE64Patch:conversion,EnvironmentsApplicationVersion:{List:[{Environment:{Key:environmentKey,PortfolioKey:portfolioKey,Status:'Ready'}}]}}});
  h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,privateSender:Object.assign(()=>{}, {mobileUpload:true,mobileBase64:true}),broker:{callScreenservice:async r=>{
   sends++;const reserved=JSON.parse(fs.readFileSync(h.access.receipts.file(r.operationUuid)));assert.equal(reserved.state,'sending');assert.equal(reserved.reconciliation.mobileBinaryUpload.settingKey,settingKey);
   assert.equal(r.operationId,operation);
   if(lost)throw new OdcError('NETWORK_ERROR','lost upload response',{sent:true});return {data:{UploadProof:{uploadOperationUuid:r.operationUuid,objectUri:conversion?'urn:ssam:mobile-base64:'+r.operationUuid:'https://plat-te3423068adb743c3b12fff7faf2a4b9e.s3.us-east-1.amazonaws.com/tenants/uploads/'+uuid(),...(conversion?{transportMode:'base64'}:{}),...mobileBinaryContent(raw.inputParameters[key]),contentVerified:true,signedUriExposed:false}}};
  }}});
  const proposal=path.join(h.dir,'proposal.md'),file=path.join(h.dir,'approval.json');fs.writeFileSync(proposal,'One public file in own fixture');
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},scope:[{lane:'odc',host:CORPORATE,operation,environmentKey,targets:['Fixture','File']}],constraints:{applicationKey,environmentKey,settingKey,portfolioKey,originOperationUuid,inputSha256:fingerprint(raw.inputParameters),expectedConfigurationSha256:extensibilityStateHash(current),...(conversion?{transportMode:'base64'}:{}),...mobileBinaryContent(raw.inputParameters[key])}}));
  const args={tenant:CORPORATE,confirmTenant:CORPORATE,operationId:operation,input:raw,authorizationContext:file,authorize:words,operationUuid};
  const first=await h.access.portalWrite(args);assert.equal(first.receipt?.state,lost?'uncertain':'confirmed',JSON.stringify(first));
  await h.access.portalWrite(args);assert.equal(sends,1);
  if(lost){const again=await h.access.portalWrite({...args,operationUuid:uuid(),target:{bypass:true}});assert.equal(again.error.code,'TARGET_PENDING');assert.equal(sends,1);}
 }
});
test('native opaque binary save reconciles a lost response by scoped reads without replay',async t=>{
 for(const conversion of [false,true])for(const lost of [false,true]){
  const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const words='Synthetic own native binary save',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own binary setting'};
  const e={applicationKey:uuid(),environmentKey:uuid(),settingKey:uuid(),portfolioKey:uuid(),originOperationUuid:uuid(),contentSha256:'b'.repeat(64),byteLength:10,...(conversion?{transportMode:'base64'}:{})},uploadId=uuid(),objectUri=conversion?'urn:ssam:mobile-base64:'+uploadId:'https://plat-te3423068adb743c3b12fff7faf2a4b9e.s3.us-east-1.amazonaws.com/tenants/uploads/'+uuid();let sends=0,visible=true;
  const lookup=h.access.receipts.lookup.bind(h.access.receipts);h.access.receipts.lookup=(id,...rest)=>id===uploadId?{state:'confirmed',identity:{tenant:CORPORATE,operationId:conversion?MOBILE_FILE_CONVERT:MOBILE_FILE_UPLOAD},authorization:{source},reconciliation:{mobileBinaryUpload:e},response:{mobileUploadProof:{uploadOperationUuid:uploadId,objectUri,...(conversion?{transportMode:'base64'}:{}),contentSha256:e.contentSha256,byteLength:e.byteLength,contentVerified:true,signedUriExposed:false}}}:lookup(id,...rest);
  let current={settings:[{key:e.settingKey,name:'File',dataType:'BinaryUrl',isSecret:false,value:null,defaultValue:null,valueOrigin:'Default'}],libraries:[]},native={Setting:{Key:e.settingKey,Name:'File',DataType:'BinaryUrl',Value:'',ValueOrigin:'Default',IsSecret:'[REDACTED]',Metadata:{Name:'',Filetype:''}},IsFromLibrary:false,LibraryInfo:{Key:'',Revision:0,Name:''}};
  const info=structuredClone(native);Object.assign(info.Setting,{Value:'',ValueOrigin:'Override',IsSecret:false,Metadata:{Name:'proof',Filetype:'txt'}});const raw={inputParameters:{ApplicationKey:e.applicationKey,EnvironmentKey:e.environmentKey,RequiresDecoding:false,ExtensibilitySettingInfo:info}};
  h.access.read=async r=>({ok:visible,data:r.operationId.startsWith('asset-')?{assetKey:e.applicationKey,name:'Fixture',assetType:'MobileApplication',portfolioKey:e.portfolioKey}:current});
  h.access.portalRead=async r=>r.operationId==='mobileExtensibility.stages'?{ok:true,data:{EnableNAOSBASE64Patch:conversion,EnvironmentsApplicationVersion:{List:[{Environment:{Key:e.environmentKey,PortfolioKey:e.portfolioKey,Status:'Ready'}}]}}}:{ok:visible,data:{NotFound:false,ExtensibilitySettingInfo:native}};
  h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,privateSender:Object.assign(()=>{}, {mobileUpload:true,mobileBase64:true}),broker:{callScreenservice:async r=>{
   sends++;assert.equal(r.mobileUploadOperationUuid,uploadId);assert.equal(r.mobileObjectUri,objectUri);assert.equal(JSON.parse(fs.readFileSync(h.access.receipts.file(r.operationUuid))).state,'sending');
   const value=(conversion?'https://plat-proof.s3.us-east-1.amazonaws.com':new URL(objectUri).origin)+'/nativeapporchestration/configurations/management/'+e.environmentKey+'/binaries/'+e.applicationKey+'/'+e.settingKey+'?X-Amz-Signature=%5BREDACTED%5D';current.settings[0]={...current.settings[0],value,valueOrigin:'Override',metadata:[{key:'name',value:'proof'},{key:'type',value:'txt'}]};native=structuredClone(info);native.Setting.Value=value;
   if(lost){visible=false;throw new OdcError('NETWORK_ERROR','lost native save',{sent:true});}return{data:{}};
  }}});
  const proposal=path.join(h.dir,'proposal.md'),file=path.join(h.dir,'approval.json');fs.writeFileSync(proposal,'Own opaque URI save and reset');fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},scope:[{lane:'odc',host:CORPORATE,operation:MOBILE_FILE_SAVE,environmentKey:e.environmentKey,targets:['Fixture','File']}],constraints:{uploadOperationUuid:uploadId,originOperationUuid:e.originOperationUuid,inputSha256:fingerprint(raw.inputParameters),expectedConfigurationSha256:extensibilityStateHash(current)}}));
  const operationUuid=uuid(),args={tenant:CORPORATE,confirmTenant:CORPORATE,operationId:MOBILE_FILE_SAVE,input:raw,authorizationContext:file,authorize:words,operationUuid};
  const result=await h.access.portalWrite(args);assert.equal(result.receipt?.state,lost?'uncertain':'confirmed',JSON.stringify(result));await h.access.portalWrite(args);assert.equal(sends,1);
  if(lost){visible=true;const resumed=await h.access.receipt({operationUuid,reconcile:{state:'confirmed',authorize:words,read:{operationId:MOBILE_EXTENSIBILITY_GET,path:{applicationKey:e.applicationKey,environmentKey:e.environmentKey}}}});assert.equal(resumed.receipt?.state,'confirmed',JSON.stringify(resumed));assert.equal(resumed.readBack.uploadedContentVerified,!conversion);if(conversion){assert.equal(resumed.readBack.convertedContentVerified,true);assert.equal(resumed.readBack.contentVerificationStage,'native-conversion');}assert.equal(sends,1);}
 }
});

test('administrative save journals before send and reconciles a lost response without repeating the mutation',async t=>{
 for(const uncertain of [false,true]){
  const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
  const words='Explicit administrative baseline cycle',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Administrative baseline'};
  let native={GuardrailId:'',RegionSupportStatus:'Supported',Policies:{List:['PromptAttack','PII','ContentFilter','PiiRegexConfig','DeniedTopic','WordFilter'].map(Id=>({Id,IsEnabled:false,Actions:{List:[{Id:'Block',Order:1},{Id:'Detect',Order:3}]},SelectedAction:'Block',WordsConfig:{List:[]},TopicsConfig:{List:[]},RegexesConfig:{List:[]}}))}},visible=true,sends=0;
  const p={EnvironmentId:uuid(),EnvironmentName:'Development',GuardrailId:'',PortfolioKey:uuid(),Policies:baselineWirePolicies(native.Policies)};
  p.Policies.List[5].IsEnabled=true;p.Policies.List[5].Config.Action='Detect';p.Policies.List[5].Config.WordsConfig.List=[{Text:'SSAM_SYNTHETIC',Action:'Detect'}];
  const proposal=path.join(h.dir,'baseline.md'),file=path.join(h.dir,'baseline.json');fs.writeFileSync(proposal,'Two writes with retained disabled ID exception');
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
   scope:[{lane:'odc',host:CORPORATE,operation:BASELINE_SAVE,environmentKey:p.EnvironmentId,targets:['Development','Guardrail baseline '+p.PortfolioKey]}],
   constraints:{mode:'configure',allowRetainedId:true,inputSha256:guardrailHash(p),expectedBaselineSha256:guardrailHash(baselineState(native))}}));
  h.access.portalRead=async r=>r.operationId===BASELINE_READ?{ok:visible,data:native}:{ok:true,data:{Stages:{List:[{Stage:{Key:p.EnvironmentId,Name:'Development',Purpose:'Development',Status:'Ready',PortfolioKey:p.PortfolioKey},OptionsItems:{IsDisabled:false}}]}}};
  const id=uuid();h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async r=>{
   sends++;const reserved=JSON.parse(fs.readFileSync(h.access.receipts.file(r.operationUuid),'utf8'));assert.equal(reserved.state,'sending');
   assert.deepEqual(reserved.identity.target,{environmentKey:p.EnvironmentId,portfolioKey:p.PortfolioKey});assert.equal(reserved.reconciliation.guardrailBaseline.beforeState.GuardrailId,'');
   native={...native,GuardrailId:id,Policies:baselineRequestedPolicies(baselineState(native),p.Policies)};
   if(uncertain){visible=false;throw Object.assign(new Error('unknown outcome'),{code:'PORTAL_TIMEOUT',sent:true});}return {data:{Id:id}};
  }}});
  const args={tenant:CORPORATE,confirmTenant:CORPORATE,auth:'portal-credential',operationId:BASELINE_SAVE,input:{inputParameters:p},authorize:words,operationUuid:uuid(),authorizationContext:file,target:{foreign:true}};
  const saved=await h.access.portalWrite(args);assert.equal(saved.receipt?.state,uncertain?'uncertain':'confirmed',JSON.stringify(saved));assert.equal(sends,1);
  assert.equal(saved.readBack.verificationScope,'saved-configuration');assert.equal(saved.readBack.runtimeEnforcementVerified,false);
  if(uncertain){assert.equal((await h.access.portalWrite(args)).receipt.state,'uncertain');assert.equal(sends,1);visible=true;
   const foreign=await h.access.receipt({operationUuid:args.operationUuid,reconcile:{state:'confirmed',authorize:words,read:{operationId:BASELINE_READ,input:{screenVariables:{}}}}});assert.equal(foreign.ok,false);
   const settled=await h.access.receipt({operationUuid:args.operationUuid,reconcile:{state:'confirmed',authorize:words,read:{operationId:BASELINE_READ,input:baselineReadInput(p)}}});assert.equal(settled.receipt.state,'confirmed');
  }
  assert.equal((await h.access.portalWrite(args)).existingReceipt,true);assert.equal(sends,1);
 }
});

test('administrative baseline reads bind native stage and fresh feature prerequisites, never caller data',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const portfolio=uuid(),stageKey=uuid(),calls=[];let disabled=false,foreign=false,featuresFail=false;
 const stage={Key:stageKey,Name:'Development',Purpose:'Development',Status:'Ready',PortfolioKey:portfolio,Region:'us-east-1'};
 h.access.resolvePortal=async()=>({path:'vault',host:PERSONAL,broker:{callScreenservice:async request=>{
  calls.push(request.operationId);assert.equal(request.write,false);
  if(request.operationId==='guardrails.stages')return {data:{Stages:{List:[{Stage:{...stage,PortfolioKey:foreign?uuid():portfolio},OptionsItems:{IsDisabled:disabled}}]}}};
  if(request.operationId==='guardrails.features')return {data:featuresFail?{}:{HasBetaProgramEnded:true,IsV2Enabled:true,IsV5Enabled:true}};
  assert.equal(request.operationId,'guardrails.baseline');assert.deepEqual(request.input.screenVariables.CurrentStage,stage);
  assert.equal(request.input.screenVariables.GetFeatureToggles.IsV5Enabled,true);assert.equal(request.input.screenVariables.GetStages.Stages.List[0].Stage.Key,stageKey);
  return {data:{GuardrailId:'',Policies:{List:[]},RegionSupportStatus:'Supported'}};
 }}});
 const args={tenant:PERSONAL,operationId:'guardrails.baseline',input:{screenVariables:{portfolioid:portfolio,stageid:stageKey,GetFeatureToggles:{IsV5Enabled:false},GetStages:{Stages:{List:[]}}}}};
 assert.equal((await h.access.portalRead(args)).ok,true);assert.deepEqual(calls,['guardrails.stages','guardrails.features','guardrails.baseline']);
 for(const mode of ['disabled','foreign','features']){calls.length=0;disabled=mode==='disabled';foreign=mode==='foreign';featuresFail=mode==='features';const r=await h.access.portalRead(args);assert.equal(r.error.code,'GUARDRAIL_BASELINE_UNVERIFIED');assert.equal(calls.includes('guardrails.baseline'),false);}
 calls.length=0;const r=await h.access.portalRead({...args,input:{screenVariables:{portfolioid:portfolio,stageid:stageKey,CurrentStage:{Key:uuid()}}}});assert.equal(r.error.code,'INPUT_INVALID');assert.equal(calls.length,0);
});

test('guardrail dispatcher persists expectation before send, confirms reads and reconciles without replay',async t=>{
 for(const uncertain of [false,true]){
  const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
  const words='Own agent guardrail cycle',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own fixture'},originId=uuid(),guardId=uuid();
  const p={AppId:uuid(),AgentElementId:uuid(),EnvironmentId:uuid(),EnvironmentName:'Development',GuardrailId:'',Policies:wordGuardrail(guardrailPolicies()),PortfolioId:uuid()};
  const proposal=path.join(h.dir,'guardrails.md'),file=path.join(h.dir,'guardrails.json');fs.writeFileSync(proposal,'Own guardrail create, change, restore');
  const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
  let native={GuardrailId:'',Policies:guardrailPolicies(),RegionSupportStatus:'Supported'},visible=true,sends=0;
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},scope:[{lane:'odc',host:CORPORATE,operation:GUARDRAILS_SAVE,environmentKey:p.EnvironmentId,targets:['GuardrailProof','ProofAgent']}],
   constraints:{originOperationUuid:originId,mode:'create',inputSha256:guardrailHash(p),expectedGuardrailSha256:guardrailHash(guardrailState(native))}}));
  const lookup=h.access.receipts.lookup.bind(h.access.receipts);
  h.access.receipts.lookup=(id,...args)=>id===originId?{state:'accepted',status:201,identity:{tenant:CORPORATE,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:p.AppId},authorization:{source,wordsSha256:hash(words),proposalSha256:hash(fs.readFileSync(proposal))}}:lookup(id,...args);
  h.access.read=async()=>({ok:true,data:{assetKey:p.AppId,name:'GuardrailProof',assetType:'Agent',portfolioKey:p.PortfolioId,revision:2}});
  h.access.portalRead=async r=>r.operationId===GUARDRAILS_READ?{ok:visible,data:native}:r.operationId==='agents.elements'
   ?{ok:true,data:{AgentList:{List:[{ElementKey:p.AgentElementId,Name:'ProofAgent'}]}}}
   :{ok:true,data:{EnvironmentsApplicationVersion:{List:[{Environment:{Key:p.EnvironmentId,Name:p.EnvironmentName,Purpose:'Development',Status:'Ready',PortfolioKey:p.PortfolioId}}]}}};
  h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async r=>{
   sends++;const reserved=JSON.parse(fs.readFileSync(h.access.receipts.file(r.operationUuid),'utf8'));assert.equal(reserved.state,'sending');
   assert.deepEqual(reserved.identity.target,{applicationKey:p.AppId,environmentKey:p.EnvironmentId,agentElementId:p.AgentElementId});
   assert(reserved.reconciliation.guardrails.creation);native={...native,GuardrailId:guardId,Policies:r.input.inputParameters.Policies};
   if(uncertain){visible=false;throw Object.assign(new Error('unknown remote outcome'),{code:'PORTAL_TIMEOUT',sent:true});}
   return {data:{SavedGuardrailId:guardId}};
  }}});
  const args={tenant:CORPORATE,confirmTenant:CORPORATE,auth:'portal-credential',operationId:GUARDRAILS_SAVE,input:{inputParameters:p},authorize:words,operationUuid:uuid(),authorizationContext:file,target:{irrelevant:true}};
  const saved=await h.access.portalWrite(args);assert.equal(saved.receipt.state,uncertain?'uncertain':'confirmed');assert.equal(sends,1);
  assert.equal(saved.readBack.verificationScope,'saved-configuration');assert.equal(saved.readBack.runtimeEnforcementVerified,false);
  if(uncertain){assert.equal(saved.ok,false);const pending=await h.access.portalWrite(args);assert.equal(pending.receipt.state,'uncertain');assert.equal(sends,1);visible=true;
   const foreign=await h.access.receipt({operationUuid:args.operationUuid,reconcile:{state:'confirmed',authorize:words,read:{operationId:GUARDRAILS_READ,input:{screenVariables:{}}}}});assert.equal(foreign.ok,false);
   const settled=await h.access.receipt({operationUuid:args.operationUuid,reconcile:{state:'confirmed',authorize:words,read:{auth:'portal-credential',operationId:GUARDRAILS_READ,input:guardrailReadInput(p)}}});assert.equal(settled.ok,true);assert.equal(settled.receipt.response.SavedGuardrailId,guardId);
  }
  const replay=await h.access.portalWrite({...args,target:{another:true}});assert.equal(replay.existingReceipt,true);assert.equal(replay.receipt.state,'confirmed');assert.equal(sends,1);
 }
});

test('owned evaluation create confirms persisted detail and retries only reads after an empty response',async t=>{
 for(const delayed of [false,true]){
  const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
  const originId=uuid(),datasetId=uuid(),portfolioKey=uuid(),evalId=uuid(),judgeId=uuid(),operationUuid=uuid(),words='Own synthetic evaluation grant';
  const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own evaluation cycle'};
  const dataset={DatasetId:datasetId,Name:'OwnDataset',PortfolioKey:portfolioKey,TestCaseCount:delayed?'2':'1',TestCases:{List:delayed?[{Name:'Control'},{Name:'Filtered'}]:[{Name:'Synthetic'}]},
   SetupAppId:'',SetupServiceActionId:'',TeardownAppId:'',TeardownServiceActionId:''};
  const evaluation={Name:'OwnEvaluation',Description:'Synthetic',DatasetId:datasetId,Judges:{List:[{Id:judgeId}]},PortfolioKey:portfolioKey},p={Evaluation:evaluation};
  const proposal=path.join(h.dir,'evaluation.md'),file=path.join(h.dir,'approval.json');fs.writeFileSync(proposal,'Own evaluation only');
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},scope:[{lane:'odc',host:CORPORATE,operation:EVALUATION_CREATE,targets:[evaluation.Name,dataset.Name]}],
   constraints:{originOperationUuid:originId,datasetId,portfolioKey,inputSha256:evaluationHash(p),expectedDatasetSha256:evaluationHash(dataset)}}));
  const lookup=h.access.receipts.lookup.bind(h.access.receipts);let writes=0,exists=false,visible=!delayed,connected=false,eligible=true,foreign=false;
  h.access.receipts.lookup=(id,...args)=>id===originId?{state:'confirmed',identity:{tenant:CORPORATE,operationId:DATASET_CREATE},response:{DatasetId:datasetId},
   authorization:{source,wordsSha256:crypto.createHash('sha256').update(words).digest('hex')}}:lookup(id,...args);
  h.access.portalRead=async request=>{
   switch(request.operationId){
    case 'agents.dataset':return {ok:true,data:{NotFound:false,Dataset:dataset}};
    case 'agents.datasetEvaluations':return {ok:true,data:{HasConnectedEvaluations:connected},dependencyState:{verified:true,datasetId,hasConnectedEvaluations:connected}};
    case 'agents.judges':return {ok:true,data:{Judges:{List:eligible?[{Id:judgeId,IsBuiltIn:true,MLflowJudgeName:'Correctness'}]:[]}}};
    case 'agents.evaluations':return {ok:true,complete:false,data:{Evaluations:{List:exists&&visible?[{EvalId:evalId,Name:evaluation.Name,DatasetId:''}]:[]}}};
    case 'agents.evaluation':return {ok:true,data:{NotFound:false,Evaluation:{...evaluation,EvalId:foreign?uuid():evalId},Dataset:{DatasetId:'',Name:dataset.Name}}};
    default:throw Error('Unexpected read');
   }
  };
  h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async request=>{
   assert.equal(request.operationId,EVALUATION_CREATE);writes++;assert.equal(JSON.parse(fs.readFileSync(h.access.receipts.file(operationUuid),'utf8')).state,'sending');exists=true;return {data:{}};
  }}});
  const args={tenant:CORPORATE,confirmTenant:CORPORATE,operationId:EVALUATION_CREATE,input:{inputParameters:p},authorize:words,operationUuid,authorizationContext:file};
  const originalCount=dataset.TestCaseCount;
  for(const count of ['0','3','1.0','invalid',originalCount==='1'?'2':'1']){
   dataset.TestCaseCount=count;assert.equal((await h.access.portalWrite(args)).error.code,'AUTHORIZATION_CONTEXT_INVALID');
  }
  dataset.TestCaseCount=originalCount;
  connected=true;assert.equal((await h.access.portalWrite(args)).error.code,'EVALUATION_BASELINE_UNVERIFIED');connected=false;
  eligible=false;assert.equal((await h.access.portalWrite(args)).error.code,'AUTHORIZATION_CONTEXT_INVALID');eligible=true;
  assert.equal(writes,0);assert.equal(lookup(operationUuid),null);
  const first=await h.access.portalWrite(args);assert.equal(first.receipt.state,delayed?'uncertain':'confirmed',JSON.stringify(first));
  if(delayed){
   visible=true;foreign=true;assert.equal((await h.access.portalWrite(args)).receipt.state,'uncertain');foreign=false;
   assert.equal((await h.access.portalWrite({...args,authorize:'Other human words'})).error.code,'AUTHORIZATION_CONTEXT_INVALID');
   const proved=await h.access.portalWrite(args);assert.equal(proved.receipt.state,'confirmed',JSON.stringify(proved));
  }
  assert.equal(lookup(operationUuid).response.EvalId,evalId);await h.access.portalWrite(args);assert.equal(writes,1);
 }
});

test('corporate trial lifecycle reserves before sending, proves cleanup and never replays a lost response', async t => {
  for (const lost of [false, true]) {
    const h = harness(); t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
    const portfolioKey = uuid(), key = uuid(), operationUuid = uuid(), words = 'Synthetic owned model grant';
    const proposal = path.join(h.dir, 'proposal.md'), file = path.join(h.dir, 'approval.json');
    fs.writeFileSync(proposal, 'Own trial lifecycle');
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const source = { kind: 'human-conversation', threadId: uuid(), messageId: uuid(), question: 'Create own fixture' };
    const p = { TrialId: 'Amazon-Nova-Pro' }, found = { Id: key, Name: 'TrialAmazonNovaPro', PortfolioKey: '', IsTrial: true };
    const context = { schema: 'ssam-authorization-context/1', decision: 'approved', words, source,
      proposal: { file: proposal, sha256: hash(fs.readFileSync(proposal)) },
      scope: [{ lane: 'odc', host: CORPORATE, operation: AI_TRIAL_CREATE, targets: [p.TrialId] }],
      constraints: { portfolioKey, inputSha256: hash(JSON.stringify(p)), expectedInventorySha256: hash('[]') } };
    fs.writeFileSync(file, JSON.stringify(context));
    let exists = false, sends = 0;
    h.access.portalRead = async ({ operationId }) => operationId === 'aiModels.detail'
      ? { ok: true, data: { NotFound: false, AIModel: { ...found, AssetKey: key, PortfolioKey: portfolioKey } } }
      : operationId === 'aiModels.list'
      ? { ok: true, data: { AIModelList: { List: exists ? [found] : [] }, TotalCount: exists ? '1' : '0' } }
      : { ok: true, data: { AIModelTrials: { List: [{ Id: p.TrialId, CurrentAIModelId: '' }] } } };
    let currentUuid = operationUuid;
    h.access.resolvePortal = async () => ({ path: 'vault', host: CORPORATE, broker: { callScreenservice: async request => {
      assert.equal(h.access.receipts.lookup(currentUuid).state, 'uncertain');
      assert.equal(request.write, true); sends++;
      exists = request.operationId === AI_TRIAL_CREATE;
      if (lost) throw new Error('Lost model response');
      return { data: exists ? { AIModelId: key } : {} };
    } } });
    const args = { tenant: CORPORATE, confirmTenant: CORPORATE, operationId: AI_TRIAL_CREATE, input: { inputParameters: p },
      authorize: words, operationUuid, authorizationContext: file };
    const created = await h.access.portalWrite(args);
    assert.equal(created.receipt.state, lost ? 'uncertain' : 'confirmed');
    await h.access.portalWrite(args); assert.equal(sends, 1);
    if (lost) continue;
    // Simulate an accepted create whose first detail read had incomplete state.
    const pending=h.access.receipts.lookup(operationUuid);h.access.receipts.settle(pending,{state:'accepted'});
    const wrong=await h.access.receipt({operationUuid,reconcile:{state:'confirmed',authorize:words,read:{operationId:'aiModels.list',input:aiModelInventoryInput(uuid())}}});
    assert.equal(wrong.error.code,'AI_MODEL_SCOPE_UNVERIFIED');assert.equal(h.access.receipts.lookup(operationUuid).state,'accepted');
    const reconciled=await h.access.receipt({operationUuid,reconcile:{state:'confirmed',authorize:words,read:{operationId:'aiModels.list',input:aiModelInventoryInput(portfolioKey)}}});
    assert.equal(reconciled.receipt.state,'confirmed');assert.equal(reconciled.readBack.verified,true);assert.equal(sends,1);
    currentUuid = uuid(); const del = { AIModelId: key };
    context.scope = [{ lane: 'odc', host: CORPORATE, operation: AI_TRIAL_DELETE, targets: [found.Name] }];
    context.constraints = { portfolioKey, originOperationUuid: operationUuid, aiModelId: key,
      expectedModelSha256: hash(JSON.stringify(found)), inputSha256: hash(JSON.stringify(del)) };
    fs.writeFileSync(file, JSON.stringify(context));
    const deleted = await h.access.portalWrite({ ...args, operationUuid: currentUuid, operationId: AI_TRIAL_DELETE, input: { inputParameters: del } });
    assert.equal(deleted.receipt.state, 'confirmed'); assert.equal(deleted.readBack.exists, false); assert.equal(sends, 2);
  }
});

test('knowledge reads select the native environment and reject incomplete empty file pages',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const input={knowledgeBaseId:uuid(),environmentKey:uuid(),portfolioKey:uuid()},sent=[];
 let total='0';
 h.access.resolvePortal=async()=>({path:'vault',host:PERSONAL,broker:{callScreenservice:async request=>{
  sent.push(request);
  return {data:request.operationId==='knowledgeBases.files'?{Files:{List:[]},TotalResults:total,MaxRecords:20}:{DataSources:{List:[]}}};
 }}});
 const sources=await h.access.portalRead({tenant:PERSONAL,operationId:'knowledgeBases.dataSources',input});
 assert.equal(sources.ok,true);assert.equal(sent[0].write,false);
 assert.equal(sent[0].input.screenVariables.SelectedEnvironmentId,input.environmentKey);
 const request={tenant:PERSONAL,operationId:'knowledgeBases.files',input:{screenVariables:{StartIndex:0}}};
 assert.equal((await h.access.portalRead(request)).pagination.complete,true);
 total='1';const incomplete=await h.access.portalRead(request);
 assert.equal(incomplete.ok,false);assert.equal(incomplete.error.code,'PORTAL_CONTRACT_CHANGED');
});

for(const batch of [false,true])test('stage order '+(batch?'batch swap':'single update')+' binds state, restores and reconciles a lost response without replay',async t=>{
 const h=harness({apiClient:true});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const portfolioKey=uuid(),words='Synthetic order update and restoration',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Move and restore intermediate stages'};
 let current=['Development','Test','Staging','Production'].map((name,i)=>({key:uuid(),portfolioKey,name,order:[0,100,200,1000][i],purpose:['Development','NonProduction','NonProduction','Production'][i],defaultDomain:name+'.example.test'})),sends=0;
 const original=structuredClone(current),inventory=()=>({ok:true,data:{results:structuredClone(current)}}),proposal=path.join(h.dir,'order.md');fs.writeFileSync(proposal,'Synthetic order move then restoration');
 h.access.send=async(host,resolved,op,input,mode)=>{if(op===STAGES)return inventory();assert.equal(op,batch?STAGE_BATCH_RENAME:STAGE_RENAME);assert.equal(mode.write,true);
  const receipt=h.access.receipts.lookup(mode.operationUuid);assert.equal(receipt.state,'uncertain');assert.deepEqual(receipt.reconciliation.stageRename.before,[...current].sort((a,b)=>a.key.localeCompare(b.key)));
  const changes=batch?input.body.environments:[{key:input.path.environmentKey,order:input.body.order}];current=current.map(r=>({...r,order:changes.find(v=>v.key===r.key)?.order??r.order}));sends++;throw Error('Response lost after mutation');};h.access.read=async()=>inventory();
 for(const restoring of [false,true]){
  const updates=batch?[{key:original[1].key,order:restoring?100:200},{key:original[2].key,order:restoring?200:100}]:[{key:original[1].key,order:restoring?100:101}];
  const plan=stageOrderPlan({inventory:inventory(),updates,batch}),file=path.join(h.dir,(restoring?'restore':'move')+'.json');
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},scope:[{lane:'odc',host:CORPORATE,operation:plan.operationId,...(!batch?{environmentKey:updates[0].key}:{}),targets:plan.targets}],constraints:{...(batch?{stageKeysSha256:fingerprint(updates.map(r=>r.key).sort())}:{environmentKey:updates[0].key}),expectedConfigurationSha256:plan.expectedConfigurationSha256,resultConfigurationSha256:plan.resultConfigurationSha256,bodySha256:fingerprint(plan.body)}}));
  const request={tenant:CORPORATE,auth:'api-client',confirmTenant:CORPORATE,operationId:plan.operationId,...(!batch?{path:plan.path}:{}),body:plan.body,authorize:words,operationUuid:uuid()};
  const denied=await h.access.write({...request,authorize:'Different approval',operationUuid:uuid()},{stageRenameContext:file});assert.equal(denied.error?.code,'AUTHORIZATION_CONTEXT_INVALID');
  const domain=current[3].defaultDomain;current[3].defaultDomain='concurrent.example.test';const drift=await h.access.write({...request,operationUuid:uuid()},{stageRenameContext:file});assert.equal(drift.error?.code,'AUTHORIZATION_CONTEXT_INVALID');current[3].defaultDomain=domain;
  const result=await h.access.write(request,{stageRenameContext:file});assert.equal(result.receipt?.state,'confirmed',JSON.stringify(result));assert.equal(result.ok,true);
  assert.equal((await h.access.write(request,{stageRenameContext:file})).existingReceipt,true);
  const altered=await h.access.write({...request,body:batch?{environments:[{key:original[1].key,order:900}]}:{order:900}},{stageRenameContext:file});assert.equal(altered.error?.code,'OPERATION_UUID_REUSED');
 }
 assert.equal(sends,2);assert.deepEqual(current,original);
});

for(const lost of [false,true])test(`organization rename and restore bind full state and reconcile without replay, lost=${lost}`,async t=>{
 const h=harness({apiClient:true});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 let current={id:uuid(),name:'Synthetic organization',ring:'GA',assetPortfolioCount:1,platformRegion:'us-east-1',dataPlatformRegion:'us-east-1'},sends=0;
 const original=structuredClone(current),inventory=()=>({ok:true,data:structuredClone(current)}),words='Synthetic organization rename and restoration';
 const proposal=path.join(h.dir,'organization.md');fs.writeFileSync(proposal,'Synthetic organization name cycle');
 h.access.send=async(host,resolved,op,input,mode)=>{if(op===ORGANIZATION_GET)return inventory();assert.equal(op,ORGANIZATION_RENAME);assert.equal(mode.write,true);
  const saved=new WriteJournal(h.access.receipts.dir).lookup(mode.operationUuid);assert.equal(saved.state,'uncertain');assert.deepEqual(saved.reconciliation.organizationRename.before,current);
  current={...current,name:input.body.name};sends++;if(lost)throw Error('Response lost after mutation');return {ok:true,status:204};};
 let observedOverride=null;h.access.read=async()=>observedOverride??inventory();
 for(const name of ['Synthetic proof',original.name]){
  const plan=organizationRenamePlan({result:inventory(),name}),file=path.join(h.dir,uuid()+'.json');
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source:{kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Rename and restore organization'},proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},scope:[{lane:'odc',host:CORPORATE,operation:ORGANIZATION_RENAME,targets:plan.targets}],constraints:{organizationId:current.id,expectedConfigurationSha256:plan.expectedConfigurationSha256,resultConfigurationSha256:plan.resultConfigurationSha256,bodySha256:fingerprint(plan.body)}}));
  const request={tenant:CORPORATE,auth:'api-client',confirmTenant:CORPORATE,operationId:ORGANIZATION_RENAME,body:plan.body,authorize:words,operationUuid:uuid()};
  const denied=await h.access.write({...request,authorize:'Different words',operationUuid:uuid()},{organizationRenameContext:file});assert.equal(denied.error?.code,'AUTHORIZATION_CONTEXT_INVALID');
  current.assetPortfolioCount=2;const drift=await h.access.write({...request,operationUuid:uuid()},{organizationRenameContext:file});assert.equal(drift.error?.code,'AUTHORIZATION_CONTEXT_INVALID');current.assetPortfolioCount=1;
  const wrongScope=await h.access.write({...request,path:{key:uuid()},operationUuid:uuid()},{organizationRenameContext:file});assert.equal(wrongScope.ok,false);
  if(lost)observedOverride={ok:true,data:plan.before};
  let done=await h.access.write(request,{organizationRenameContext:file});
  if(lost){
   assert.equal(done.receipt?.state,'uncertain');assert.equal(done.readBack?.verified,false);
   const saved=new WriteJournal(h.access.receipts.dir).lookup(request.operationUuid);assert.deepEqual(saved.identity.target,{organization:true});
   assert.equal(fs.existsSync(h.access.receipts.lockFile(saved.identity)),true);
   const changed=await h.access.write({...request,body:{name:'Different uncertain request'}},{organizationRenameContext:file});assert.equal(changed.error?.code,'OPERATION_UUID_REUSED');
   observedOverride=null;done=await h.access.write(request,{organizationRenameContext:file});assert.equal(done.existingReceipt,true);assert.equal(done.replayed,false);
  }
  assert.equal(done.ok,true,JSON.stringify(done));assert.equal(done.receipt?.state,'confirmed');assert.equal(done.readBack?.verified,true);
  assert.equal((await h.access.write(request,{organizationRenameContext:file})).existingReceipt,true);
  const changed=await h.access.write({...request,body:{name:'Another request'}},{organizationRenameContext:file});assert.equal(changed.error?.code,'OPERATION_UUID_REUSED');
 }
 assert.equal(sends,2);assert.deepEqual(current,original);
});

test('batch stage rename records whole state, handles response loss and rejects changed input with same UUID',async t=>{
 const h=harness({apiClient:true});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const portfolioKey=uuid(),words='Synthetic batch approval',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Rename and restore two stages'};
 let current=['Development','Test','Production'].map((name,order)=>({key:uuid(),portfolioKey,name,order,purpose:name})),sends=0;
 const original=structuredClone(current),inventory=()=>({ok:true,data:{results:structuredClone(current)}});
 const proposal=path.join(h.dir,'proposal.md');fs.writeFileSync(proposal,'Batch rename then restore');
 h.access.send=async(host,resolved,op,input,mode)=>{
  if(op===STAGES)return inventory();assert.equal(op,STAGE_BATCH_RENAME);assert.equal(mode.write,true);
  const receipt=h.access.receipts.lookup(mode.operationUuid);assert.deepEqual(receipt.reconciliation.stageRename.before,[...current].sort((a,b)=>a.key.localeCompare(b.key)));
  current=current.map(r=>({...r,name:input.body.environments.find(v=>v.key===r.key)?.name??r.name}));sends++;
  throw Error('Response lost');
 };h.access.read=async()=>inventory();
 for(const [index,names] of [['rename',['TempDev','TempTest']],['restore',['Development','Test']]]){
  const plan=stageBatchRenamePlan({inventory:inventory(),updates:current.slice(0,2).map((r,i)=>({key:r.key,name:names[i]}))});
  const file=path.join(h.dir,index+'.json');fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
   scope:[{lane:'odc',host:CORPORATE,operation:STAGE_BATCH_RENAME,targets:plan.targets}],constraints:{stageKeysSha256:fingerprint(plan.body.environments.map(r=>r.key).sort()),
    expectedConfigurationSha256:plan.expectedConfigurationSha256,resultConfigurationSha256:plan.resultConfigurationSha256,bodySha256:fingerprint(plan.body)}}));
  const request={tenant:CORPORATE,auth:'api-client',confirmTenant:CORPORATE,operationId:STAGE_BATCH_RENAME,body:plan.body,authorize:words,operationUuid:uuid()};
  for(const override of [{authorize:'Different consent'},{body:{environments:[{key:original[2].key,name:'Unauthorized'}]}},
    {body:{environments:plan.body.environments.map(r=>({...r,order:123}))}}]){
   const denied=await h.access.write({...request,...override,operationUuid:uuid()},{stageRenameContext:file});
   assert.equal(denied.error?.code,'AUTHORIZATION_CONTEXT_INVALID',JSON.stringify(denied));
  }
  const order=current[2].order;current[2].order=99;
  const drift=await h.access.write({...request,operationUuid:uuid()},{stageRenameContext:file});
  assert.equal(drift.error?.code,'AUTHORIZATION_CONTEXT_INVALID');current[2].order=order;
  const result=await h.access.write(request,{stageRenameContext:file});assert.equal(result.receipt?.state,'confirmed',JSON.stringify(result));assert.equal(result.ok,true);
  assert.equal((await h.access.write(request,{stageRenameContext:file})).existingReceipt,true);
  const altered=await h.access.write({...request,body:{environments:[{key:original[2].key,name:'Unauthorized'}]}},{stageRenameContext:file});
  assert.equal(altered.error.code,'OPERATION_UUID_REUSED');
 }
 assert.equal(sends,2);assert.deepEqual(current,original);
});

test('environment defaults bind state and body, reconcile lost responses and restore without replay',async t=>{
 const h=harness({apiClient:true});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const environmentKey=uuid(),words='Synthetic defaults change and restoration',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Change and restore defaults'};
 let rows=[{key:'Name',dataType:'Text',isSecret:false,value:'Original',defaultValue:'Default',valueOrigin:'EnvironmentLevelOverride'}],sends=0;
 const original=structuredClone(rows),read=()=>({ok:true,data:{systemConfigurations:structuredClone(rows)}});
 const proposal=path.join(h.dir,'defaults.md');fs.writeFileSync(proposal,'Synthetic defaults');
 h.access.send=async(host,resolved,op,input,mode)=>{
  if(op===ENV_DEFAULTS_GET)return read();assert.equal(op,ENV_DEFAULTS_PATCH);assert.equal(mode.write,true);
  assert.equal(JSON.parse(fs.readFileSync(h.access.receipts.file(mode.operationUuid),'utf8')).state,'sending');sends++;rows=environmentDefaultsPlan({result:read(),environmentKey,body:input.body}).after;
  throw Error('Response lost after mutation');
 };
 h.access.read=async()=>read();
 for(const value of ['Temporary','Original']){
  const p=environmentDefaultsPlan({result:read(),environmentKey,body:{systemConfigurations:[{key:'Name',value}]}}),file=path.join(h.dir,value+'.json');
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},scope:[{lane:'odc',host:CORPORATE,operation:ENV_DEFAULTS_PATCH,environmentKey,targets:[environmentKey]}],
   constraints:{expectedConfigurationSha256:p.expectedConfigurationSha256,resultConfigurationSha256:p.resultConfigurationSha256,bodySha256:fingerprint(p.body)}}));
  const request={tenant:CORPORATE,auth:'api-client',confirmTenant:CORPORATE,operationId:ENV_DEFAULTS_PATCH,path:p.path,body:p.body,authorize:words,operationUuid:uuid()};
  const drift={...request,body:{systemConfigurations:[{key:'Name',value:'Unauthorized'}]}};
  assert.equal((await h.access.write(drift,{environmentDefaultsContext:file})).error.code,'AUTHORIZATION_CONTEXT_INVALID');
  const answer=await h.access.write(request,{environmentDefaultsContext:file});assert.equal(answer.receipt.state,'confirmed',JSON.stringify(answer));
  assert.equal(answer.readBack.secretValuesVerified,false);
  assert.equal((await h.access.write(request,{environmentDefaultsContext:file})).existingReceipt,true);
  assert.equal((await h.access.write(drift,{environmentDefaultsContext:file})).ok,false);
 }
 assert.equal(sends,2);assert.deepEqual(rows,original);
});

test('stage rename persists baseline, reconciles response loss and restores without replay',async t=>{
 const h=harness({apiClient:true});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const key=uuid(),words='Synthetic stage rename approval',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Rename and restore'};
 let current={key,name:'Portfolio',purpose:'NonProduction',order:100,portfolioKey:uuid(),builtinDomain:'test.example',defaultDomain:'test.example'},sends=0;
 const original=structuredClone(current),inventory=()=>({ok:true,data:{page:{offset:0,totalResults:1},results:[structuredClone(current)]}});
 const proposal=path.join(h.dir,'portfolio.md');fs.writeFileSync(proposal,'Synthetic rename and restore');
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 h.access.send=async(host,resolved,op,input,mode)=>{
  if(op===STAGES)return inventory();assert.equal(op,STAGE_RENAME);assert.equal(mode.write,true);
  const receipt=JSON.parse(fs.readFileSync(h.access.receipts.file(mode.operationUuid),'utf8'));
  assert.equal(receipt.state,'sending');assert.deepEqual(receipt.reconciliation.stageRename.before,[current]);
  current={...current,name:input.body.name};sends++;throw new Error('Response lost after mutation');
 };
 h.access.read=async()=>inventory();
 for(const name of ['Temporary','Portfolio']){
  const plan=stageRenamePlan({inventory:inventory(),environmentKey:key,name}),file=path.join(h.dir,name+'.json'),operationUuid=uuid();
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},scope:[{lane:'odc',host:CORPORATE,operation:STAGE_RENAME,environmentKey:key,targets:[current.name]}],
   constraints:{environmentKey:key,expectedConfigurationSha256:plan.expectedConfigurationSha256,bodySha256:fingerprint(plan.body),resultConfigurationSha256:plan.resultConfigurationSha256}}));
  const request={tenant:CORPORATE,auth:'api-client',confirmTenant:CORPORATE,operationId:STAGE_RENAME,path:plan.path,body:plan.body,authorize:words,operationUuid};
  const result=await h.access.write(request,{stageRenameContext:file});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.receipt.state,'confirmed');
  assert.equal(result.error,undefined);assert.ok(result.writeError);assert.equal((await h.access.write(request,{stageRenameContext:file})).existingReceipt,true);
 }
 assert.equal(sends,2);assert.deepEqual(current,original);
});

test('portfolio rename persists baseline, reconciles response loss and restores without replay',async t=>{
 const h=harness({apiClient:true});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const key=uuid(),words='Synthetic portfolio rename approval',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Rename and restore'};
 let current={key,name:'Portfolio',type:'Cloud',isMainPortfolio:true,nonProductionEnvironmentCount:1},sends=0;
 const original=structuredClone(current),inventory=()=>({ok:true,data:{page:{offset:0,totalResults:1},results:[structuredClone(current)]}});
 const proposal=path.join(h.dir,'portfolio.md');fs.writeFileSync(proposal,'Synthetic rename and restore');
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 h.access.send=async(host,resolved,op,input,mode)=>{
  if(op===PORTFOLIOS)return inventory();assert.equal(op,PORTFOLIO_RENAME);assert.equal(mode.write,true);
  const receipt=JSON.parse(fs.readFileSync(h.access.receipts.file(mode.operationUuid),'utf8'));
  assert.equal(receipt.state,'sending');assert.deepEqual(receipt.reconciliation.portfolioRename.before,current);
  current={...current,name:input.body.name};sends++;throw new Error('Response lost after mutation');
 };
 h.access.read=async()=>inventory();
 for(const name of ['Temporary','Portfolio']){
  const plan=portfolioRenamePlan({inventory:inventory(),portfolioKey:key,name}),file=path.join(h.dir,name+'.json'),operationUuid=uuid();
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},scope:[{lane:'odc',host:CORPORATE,operation:PORTFOLIO_RENAME,targets:[current.name]}],
   constraints:{portfolioKey:key,expectedConfigurationSha256:plan.expectedConfigurationSha256,bodySha256:fingerprint(plan.body),resultConfigurationSha256:plan.resultConfigurationSha256}}));
  const request={tenant:CORPORATE,auth:'api-client',confirmTenant:CORPORATE,operationId:PORTFOLIO_RENAME,path:plan.path,body:plan.body,authorize:words,operationUuid};
  const result=await h.access.write(request,{portfolioRenameContext:file});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.receipt.state,'confirmed');
  assert.equal(result.error,undefined);assert.ok(result.writeError);assert.equal((await h.access.write(request,{portfolioRenameContext:file})).existingReceipt,true);
 }
 assert.equal(sends,2);assert.deepEqual(current,original);
});

test('credential-presence proof stays boolean; strings and nested secrets stay redacted',()=>{
 assert.deepEqual(redact({hasCredentialValues:false}),{hasCredentialValues:false});
 assert.deepEqual(redact({hasCredentialValues:true}),{hasCredentialValues:true});
 for(const value of ['false','private-value',{password:'private'},null])assert.equal(redact({hasCredentialValues:value}).hasCredentialValues,'[REDACTED]');
 assert.equal(redact({password:false}).password,'[REDACTED]');
});

test('A2A discovery dispatch journals before network and persists only the validated card projection',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const stage=uuid(),operationUuid=uuid(),words='Synthetic discovery fixture grant',url='https://example.test/agent/';
 const raw={inputParameters:{AgentDiscovery:{url,environmentId:stage}}};
 const file=path.join(h.dir,'approval.json'),proposal=path.join(h.dir,'proposal.md');fs.writeFileSync(proposal,'Owned discovery');
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,
  source:{kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Discover own fixture'},proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},
  scope:[{lane:'odc',host:CORPORATE,operation:A2A_DISCOVER,environmentKey:stage,targets:['Own']}],
  constraints:{connectionName:'Own',agentUrl:url,inputSha256:hash(JSON.stringify(raw.inputParameters))}}));
 h.access.portalRead=async()=>({ok:true,truncated:false,rows:[{Key:stage,Name:'Development',Purpose:'Development'}]});let sends=0;
 h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async()=>{
  const stored=JSON.parse(fs.readFileSync(h.access.receipts.file(operationUuid),'utf8'));assert.equal(stored.state,'sending');
  assert.equal(stored.reconciliation.a2aDiscovery.agentUrl,url);sends++;
  return {data:{AgentCard:JSON.stringify({protocolVersion:'0.3.0',name:'Own',description:'Fixture',version:'1',url:'https://example.test/rpc',capabilities:{streaming:false},
   defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[{id:'proof',name:'Proof',description:'Constant',tags:[]}],privateUnknown:'private-extra'})}};
 }}});
 const request={tenant:CORPORATE,confirmTenant:CORPORATE,operationId:A2A_DISCOVER,input:raw,authorize:words,operationUuid,authorizationContext:file};
 const found=await h.access.portalWrite(request);assert.equal(found.ok,true,JSON.stringify(found));assert.equal(found.receipt.state,'confirmed');
 assert.equal(found.data.card.name,'Own');assert.doesNotMatch(JSON.stringify(found),/private-extra|AgentCard/);
 assert.deepEqual(h.access.receipts.lookup(operationUuid).response,{cardSha256:found.data.cardSha256,card:found.data.card});
 assert.doesNotMatch(JSON.stringify(h.access.receipts.lookup(operationUuid)),/private-extra|privateUnknown/);
 assert.equal((await h.access.portalWrite(request)).existingReceipt,true);assert.equal(sends,1);
 const plan=a2aConnectionPlan({name:'Own',agentUrl:url,portfolioKey:uuid(),stage:{Key:stage,Name:'Development',Purpose:'Development'},card:found.data.card,configurationType:'url'});
 const record=JSON.parse(fs.readFileSync(file,'utf8'));record.scope[0].operation=A2A_TEST;
 record.constraints={planSha256:plan.planSha256,inputSha256:hash(JSON.stringify(plan.testInput.inputParameters)),discoveryOperationUuid:operationUuid};
 fs.writeFileSync(file,JSON.stringify(record));
 h.access.portalRead=async r=>r.operationId==='connections.list'?{ok:true,truncated:false,rows:[]}:{ok:true,truncated:false,rows:[{Key:stage,Name:'Development',Purpose:'Development'}]};
 const testUuid=uuid(),connectionId=uuid();
 h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async r=>{
  const stored=JSON.parse(fs.readFileSync(h.access.receipts.file(testUuid),'utf8'));
  assert.equal(stored.state,'sending');assert.deepEqual(stored.reconciliation.a2aConnection.card,found.data.card);
  assert.equal(stored.reconciliation.a2aConnection.discoveryOperationUuid,operationUuid);
  assert.equal(r.input.inputParameters.ValidStageConfigs.List[0].AgentCardJson,'');sends++;
  return {data:{Out_ConnectionId:connectionId}};
 }}});
 const testRequest={...request,operationId:A2A_TEST,input:plan.testInput,operationUuid:testUuid};
 const tested=await h.access.portalWrite(testRequest);assert.equal(tested.ok,true,JSON.stringify(tested));assert.equal(tested.receipt.state,'accepted');
 assert.equal((await h.access.portalWrite(testRequest)).existingReceipt,true);assert.equal(sends,2);
});

test('A2A dispatcher persists ownership before sending, gates save and never replays accepted or uncertain writes',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const words='Synthetic A2A fixture lifecycle grant',connectionId=uuid(),originOperationUuid=uuid();
 const plan=a2aConnectionPlan({name:'OwnedAgent',agentUrl:'https://example.test/agent/',portfolioKey:uuid(),stage:{Key:uuid(),Name:'Development',Purpose:'Development'},
  card:{protocolVersion:'0.3.0',name:'Proof',description:'Constant',version:'1',url:'https://example.test/rpc',capabilities:{},
   defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[{id:'proof',name:'Proof',description:'Constant',tags:['test']}]}});
 const proposal=path.join(h.dir,'proposal.md');fs.writeFileSync(proposal,'Own A2A test and save');
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own fixture lifecycle'};
 const request=(op,input,operationUuid)=>{
  const file=path.join(h.dir,operationUuid+'.json');fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},scope:[{lane:'odc',host:CORPORATE,operation:op,environmentKey:plan.stageKey,targets:['OwnedAgent']}],
   constraints:{planSha256:plan.planSha256,inputSha256:hash(JSON.stringify(input.inputParameters)),...(op===A2A_SAVE?{originOperationUuid,connectionId}:{})}}));
  return {tenant:CORPORATE,confirmTenant:CORPORATE,operationId:op,input,authorize:words,operationUuid,authorizationContext:file};
 };
 let status='Running',missingId=false;const sends=[];
 h.access.portalRead=async r=>r.operationId==='monitoring.stages'?{ok:true,truncated:false,rows:[{Key:plan.stageKey,Name:'Development',Purpose:'Development'}]}
  :r.operationId==='connections.list'?{ok:true,truncated:false,rows:[]}:{ok:true,data:{Status:{Results:{List:[{StageKey:plan.stageKey,Status:status}]}}}};
 h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async r=>{
  const persisted=JSON.parse(fs.readFileSync(h.access.receipts.file(r.operationUuid),'utf8'));
  assert.equal(persisted.state,'sending');assert.equal(persisted.reconciliation.a2aConnection.planSha256,plan.planSha256);
  assert.equal(persisted.authorization.source.messageId,source.messageId);sends.push(r.operationId);
  return {data:r.operationId===A2A_TEST&&!missingId?{Out_ConnectionId:connectionId}:{}};
 }}});
 const create=request(A2A_TEST,plan.testInput,originOperationUuid);
 const tested=await h.access.portalWrite(create);assert.equal(tested.ok,true,JSON.stringify(tested));assert.equal(tested.receipt.state,'accepted');
 assert.equal(h.access.receipts.lookup(originOperationUuid).response.Out_ConnectionId,connectionId);
 assert.equal((await h.access.portalWrite(create)).existingReceipt,true);
 assert.equal((await h.access.portalWrite({...create,authorize:'Different synthetic authorization'})).error.code,'AUTHORIZATION_CONTEXT_INVALID');
 const save=request(A2A_SAVE,a2aSaveInput(plan,connectionId,plan.planSha256),uuid());
 const refused=await h.access.portalWrite(save);assert.equal(refused.error.code,'CONNECTION_TEST_NOT_CONFIRMED');assert.equal(h.access.receipts.lookup(save.operationUuid),null);
 status='Success';const saved=await h.access.portalWrite(save);assert.equal(saved.ok,true,JSON.stringify(saved));assert.equal(saved.receipt.state,'accepted');
 assert.equal((await h.access.portalWrite(save)).existingReceipt,true);assert.deepEqual(sends,[A2A_TEST,A2A_SAVE]);
 const previousRead=h.access.portalRead;
 h.access.portalRead=async r=>r.operationId==='connections.detail'?{ok:true,data:{NotFound:false,Connection:{connectionId,providerId:'a2a',
  name:'OwnedAgent',description:'',portfolioKey:plan.details.ConnectionDetails_Header.PortfolioKey,
  externalMetadata:{selectedObjectCount:0,selectedActionCount:0},
  stageConfigurations:[{stageKey:plan.stageKey,a2a:{configurationType:'json',authType:'no_auth',hasCredentialValues:false,
   agentUrlSha256:fingerprint(plan.agentUrl),
   agentCardSha256:fingerprint(JSON.parse(plan.details.ConnectionDetail_StageConfig.List[0].AgentCardJson))}}]}}}:previousRead(r);
 const reconciled=await h.access.portalWrite(save);assert.equal(reconciled.receipt.state,'confirmed');assert.equal(reconciled.readBack.verified,true);
 assert.equal(sends.length,2);
 const lostSave=request(A2A_SAVE,a2aSaveInput(plan,connectionId,plan.planSha256),uuid());
 h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async()=>{sends.push(A2A_SAVE);throw new Error('Lost response');}}});
 const recovered=await h.access.portalWrite(lostSave);assert.equal(recovered.receipt.state,'confirmed',JSON.stringify(recovered));
 assert.equal(recovered.ok,true);assert.equal(recovered.error,undefined);assert.ok(recovered.writeError);
 assert.equal((await h.access.portalWrite(lostSave)).existingReceipt,true);assert.equal(sends.length,3);
 h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async()=>{sends.push(A2A_TEST);return {data:{}};}}});
 missingId=true;const unknown=request(A2A_TEST,plan.testInput,uuid());
 const uncertain=await h.access.portalWrite(unknown);assert.equal(uncertain.receipt.state,'uncertain');assert.equal(uncertain.error.code,'A2A_CONNECTION_IDENTITY_UNVERIFIED');
 assert.equal((await h.access.portalWrite(unknown)).existingReceipt,true);assert.equal(sends.length,4);
 const detailRead=h.access.portalRead,baseline=(await detailRead({operationId:'connections.detail'})).data.Connection;
 let gone=false,consumed=true;
 h.access.portalRead=async r=>r.operationId==='connections.detail'&&gone?{ok:true,data:{NotFound:true,Connection:null}}:detailRead(r);
 h.access.read=async r=>r.operationId===ASSET?{ok:true,data:{name:'OwnedAgent'}}
  :r.operationId==='portfolio-api-v2:get:/environments'?{ok:true,data:{results:[{key:plan.stageKey}]}}
  :{ok:true,data:{results:consumed?[{key:uuid(),name:'Consumer'}]:[]}};
 const deleteId=uuid(),file=path.join(h.dir,'delete-a2a.json');
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
  proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},scope:[{lane:'odc',host:CORPORATE,operation:'connections.delete',environmentKey:plan.stageKey,targets:['OwnedAgent']}],
  constraints:{originOperationUuid,connectionId,planSha256:plan.planSha256,expectedStateSha256:fingerprint(baseline)}}));
 const deletion={tenant:CORPORATE,auth:'auto',confirmTenant:CORPORATE,connectionId,originOperationUuid,operationUuid:deleteId,authorize:words,authorizationContext:file};
 const originalContext=fs.readFileSync(file,'utf8'),failedConnection=structuredClone(baseline);
 failedConnection.stageConfigurations[0].a2a.agentCardSha256=null;failedConnection.stageConfigurations[0].a2a.normalizedAgentCardSha256=null;
 const failedContext=JSON.parse(originalContext);failedContext.constraints.expectedStateSha256=fingerprint(failedConnection);fs.writeFileSync(file,JSON.stringify(failedContext));
 const failedArgs={file,words,host:CORPORATE,origin:h.access.receipts.lookup(originOperationUuid),originOperationUuid,connectionId,
  detail:{NotFound:false,Connection:failedConnection},dependencies:{ok:true,name:'OwnedAgent',includesPublishingDefault:true,checkedEnvironments:[plan.stageKey],consumers:[]},
  failedTest:{ok:true,data:{Status:{Results:{List:[{StageKey:plan.stageKey,Status:'Error'}]}}}}};
 assert.ok(a2aDeleteApproval(failedArgs));
 const provisionalArgs={...failedArgs,dependencies:{ok:false},provisional:{verified:true,connectionId,stateSha256:fingerprint(failedConnection),neverGenerated:true,assetAbsent:true}};
 assert.ok(a2aDeleteApproval(provisionalArgs));
 for(const change of [x=>x.provisional.verified=false,x=>x.provisional.neverGenerated=false,x=>x.provisional.assetAbsent=false,
  x=>x.provisional.stateSha256='other',x=>x.provisional.connectionId=uuid(),x=>x.failedTest.data.Status.Results.List[0].Status='Success']){
  const changed=structuredClone(provisionalArgs);change(changed);assert.throws(()=>a2aDeleteApproval(changed));
 }
 for(const mutate of [x=>x.failedTest.ok=false,x=>x.failedTest.truncated=true,x=>x.failedTest.data.Status.Results.List[0].Status='Success',
  x=>x.failedTest.data.Status.Results.List[0].StageKey=uuid(),x=>x.failedTest.data.Status.Results.List.push({StageKey:plan.stageKey,Status:'Error'}),
  x=>x.detail.Connection.stageConfigurations[0].a2a.hasCredentialValues=true,x=>x.detail.Connection.externalMetadata.selectedActionCount=1]){
  const changed=structuredClone(failedArgs);mutate(changed);assert.throws(()=>a2aDeleteApproval(changed));
 }
 fs.writeFileSync(file,originalContext);
 assert.equal((await h.access.a2aConnectionDelete(deletion)).error.code,'CONNECTION_DEPENDENCIES_UNVERIFIED');
 assert.equal(h.access.receipts.lookup(deleteId),null);assert.equal(sends.length,4);
 consumed=false;
 const beforeCleanupRead=h.access.portalRead;
 for(const mutate of [c=>c.providerId='mssql',c=>c.name='Foreign',c=>c.externalMetadata.selectedActionCount=1,
  c=>c.stageConfigurations[0].a2a.agentCardSha256=null,c=>c.stageConfigurations[0].a2a.hasCredentialValues=true]){
  h.access.portalRead=async r=>{const value=structuredClone(await beforeCleanupRead(r));if(r.operationId==='connections.detail')mutate(value.data.Connection);return value;};
  assert.equal((await h.access.a2aConnectionDelete(deletion)).error.code,'AUTHORIZATION_CONTEXT_INVALID');
  assert.equal(h.access.receipts.lookup(deleteId),null);
 }
 const withAction={...baseline,updatedOn:'2026-10-09T20:00:00Z',externalMetadata:{selectedObjectCount:0,selectedActionCount:1}};
 const cleanupContext=JSON.parse(fs.readFileSync(file,'utf8'));cleanupContext.constraints.expectedStateSha256=fingerprint(withAction);
 fs.writeFileSync(file,JSON.stringify(cleanupContext));
 h.access.portalRead=async r=>r.operationId==='connections.selectedActions'
  ?{ok:true,data:{ActionList:{List:[{Name:'SendMessage',OriginalName:'SendMessage',IsNotSupported:false}]}}}
  :r.operationId==='connections.detail'&&!gone?{ok:true,data:{NotFound:false,Connection:withAction}}:beforeCleanupRead(r);
 h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async r=>{
  assert.equal(r.operationId,'connections.delete');assert.equal(r.input.inputParameters.ProviderId,'a2a');
  assert.equal(JSON.parse(fs.readFileSync(h.access.receipts.file(deleteId),'utf8')).state,'sending');
  sends.push(r.operationId);gone=true;throw new Error('Lost delete response');
 }}});
 const realReadBack=h.access.dbDeleteReadBack;
 h.access.dbDeleteReadBack=async(host,auth,scope,written)=>({...written,continuation:{}});
 const pending=await h.access.a2aConnectionDelete(deletion);
 // CX15 r4 (W-1, converted): the read-only reconciliation goes on WITHOUT the owner's words (before: authorize === words).
 assert.equal(pending.continuation.arguments.authorize,undefined);assert.equal(JSON.stringify(pending).includes(words),false);
 assert.equal(pending.continuation.arguments.operationUuid,deleteId);
 assert.equal(sends.length,5);
 h.access.dbDeleteReadBack=realReadBack;
 const removed=await h.access.a2aConnectionDelete(pending.continuation.arguments);assert.equal(removed.receipt.state,'confirmed',JSON.stringify(removed));assert.equal(removed.ok,true);
 assert.equal(removed.error,undefined);assert.equal(sends.length,5);
 assert.equal((await h.access.a2aConnectionDelete(deletion)).existingReceipt,true);assert.equal(sends.length,5);
 assert.equal((await h.access.a2aConnectionDelete({...deletion,authorize:'Different approval'})).error.code,'AUTHORIZATION_CONTEXT_INVALID');
});

test('corporate dataset lifecycle uses the real persisted creation receipt for cleanup',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const app=uuid(),portfolio=uuid(),datasetId=uuid(),groupId=uuid(),createId=uuid(),words='Synthetic full fixture lifecycle grant';
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Create and remove own dataset'};
 const d={Name:'DatasetProof',Description:'Synthetic',AgenticAppId:app,ServiceActionId:uuid(),Content:'{"testCases":[{"name":"Synthetic","inputs":{},"expectations":{}}]}',
  SetupAppId:'',SetupServiceActionId:'',TeardownAppId:'',TeardownServiceActionId:'',PortfolioKey:portfolio,AssetType:''};
 const p={OverrideBaseURL:'',Dataset:d,AdditionalApps:{List:[]}},asset={assetKey:app,portfolioKey:portfolio,name:'EligibleApp',assetType:'WebApplication',modelDigest:'digest'};
 const dataset={DatasetId:datasetId,...d},proposal=path.join(h.dir,'lifecycle.md');fs.writeFileSync(proposal,'Own lifecycle, no evaluation execution');
 const approval=(label,operation,targets,constraints)=>{
  const file=path.join(h.dir,label+'.json');fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},scope:[{lane:'odc',host:CORPORATE,operation,targets}],constraints}));return file;
 };
 let exists=false,eligible=false;const sends=[];
 h.access.read=async()=>({ok:true,data:asset});
 h.access.portalRead=async request=>request.operationId==='agents.agenticApps'
  ?{ok:true,data:{AgenticApps:{List:eligible?[{Key:app,Name:asset.name,ModelDigest:asset.modelDigest,AssetType:asset.assetType}]:[]}}}
  :request.operationId==='agents.dataset'?{ok:true,data:{Dataset:dataset,NotFound:!exists}}:{ok:true,data:{HasConnectedEvaluations:false},dependencyState:{verified:true,datasetId,hasConnectedEvaluations:false}};
 h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async request=>{
  sends.push(request.operationId);if(request.operationId===DATASET_CREATE){exists=true;return {data:{DatasetId:datasetId,GroupId:groupId}};}
  assert.equal(request.operationId,DATASET_DELETE);exists=false;return {data:{}};
 }}});
 const create={tenant:CORPORATE,confirmTenant:CORPORATE,operationId:DATASET_CREATE,input:{inputParameters:p},authorize:words,operationUuid:createId,
  authorizationContext:approval('create',DATASET_CREATE,[d.Name,asset.name],{inputSha256:datasetInputHash(p),applicationKey:app,modelDigest:asset.modelDigest,portfolioKey:portfolio})};
 const refused=await h.access.portalWrite(create);assert.equal(refused.error.code,'DATASET_APPLICATION_UNVERIFIED');assert.equal(h.access.receipts.lookup(createId),null);
 eligible=true;const created=await h.access.portalWrite(create);assert.equal(created.ok,true,JSON.stringify(created));
 const saved=h.access.receipts.lookup(createId);assert.equal(saved.authorization.source.messageId,source.messageId);assert.equal(saved.response.DatasetId,datasetId);assert.equal(saved.state,'accepted');
 const del={tenant:CORPORATE,confirmTenant:CORPORATE,operationId:DATASET_DELETE,input:{inputParameters:{DatasetId:datasetId}},authorize:words,operationUuid:uuid(),
  authorizationContext:approval('delete',DATASET_DELETE,[d.Name],{originOperationUuid:createId,datasetId,expectedDatasetSha256:datasetStateHash(dataset)})};
 const removed=await h.access.portalWrite(del);assert.equal(removed.receipt.state,'confirmed',JSON.stringify(removed));assert.equal(exists,false);
 await h.access.portalWrite(create);await h.access.portalWrite(del);assert.deepEqual(sends,[DATASET_CREATE,DATASET_DELETE]);
});

test('corporate dataset cleanup checks dependencies, confirms absence and never replays',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const id=uuid(),originId=uuid(),words='Synthetic own dataset cleanup grant';
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own fixture cleanup'};
 const dataset={DatasetId:id,Name:'OwnDataset',Description:'baseline'};
 const lookup=h.access.receipts.lookup.bind(h.access.receipts);
 h.access.receipts.lookup=(key,...rest)=>key===originId?{state:'accepted',identity:{tenant:CORPORATE,operationId:'agents.datasetCreate'},response:{DatasetId:id},authorization:{source}}:lookup(key,...rest);
 let connected=true,gone=false,sends=0;
 h.access.portalRead=async request=>request.operationId==='agents.dataset'
  ?{ok:true,data:{Dataset:dataset,NotFound:gone}}:{ok:true,data:{HasConnectedEvaluations:connected},dependencyState:{verified:true,datasetId:id,hasConnectedEvaluations:connected}};
 h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async request=>{
  assert.equal(request.write,true);assert.equal(request.input.inputParameters.DatasetId,id);sends++;gone=true;return {data:{}};
 }}});
 const proposal=path.join(h.dir,'delete-dataset.md'),file=path.join(h.dir,'delete-dataset.json');fs.writeFileSync(proposal,'Own dataset deletion');
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
  proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
  scope:[{lane:'odc',host:CORPORATE,operation:DATASET_DELETE,targets:[dataset.Name]}],
  constraints:{originOperationUuid:originId,datasetId:id,expectedDatasetSha256:datasetStateHash(dataset)}}));
 const args={tenant:CORPORATE,confirmTenant:CORPORATE,operationId:DATASET_DELETE,input:{inputParameters:{DatasetId:id}},authorize:words,operationUuid:uuid(),authorizationContext:file};
 const denied=await h.access.portalWrite(args);assert.equal(denied.error.code,'DATASET_DEPENDENCIES_UNVERIFIED');assert.equal(sends,0);
 assert.equal(lookup(args.operationUuid),null);
 connected=false;const done=await h.access.portalWrite(args);assert.equal(done.ok,true,JSON.stringify(done));assert.equal(done.receipt.state,'confirmed');assert.equal(done.deletionConfirmed,true);
 const again=await h.access.portalWrite(args);assert.equal(again.existingReceipt,true);assert.equal(sends,1);
});

test('corporate mobile configuration uses verified standing grant once and rejects drift before sending',async t=>{
 const operationId=[...MOBILE_CONFIGURATION_WRITES][0],environmentKey=uuid(),originId=uuid();let sends=0,loseResponse=false,readUnavailable=false;
 let current={appIdentifier:{isSecret:false,value:null}};
 const h=harness({apiClient:true,vaultExecute:async(id,input,mode)=>{
  if(mode==='read'){if(readUnavailable)throw Error('Temporary read failure');return {ok:true,status:200,data:id.startsWith('asset-')?{assetKey:ASSET1,assetType:'MobileApplication',name:'Proof'}:current};}
  sends++;if(loseResponse){current={appIdentifier:{isSecret:false,value:input.body.appIdentifier.value}};readUnavailable=true;throw Error('Response lost');}return {ok:true,status:204,data:null};
 }});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own mobile fixture'},words='Synthetic standing fixture grant';
 const lookup=h.access.receipts.lookup.bind(h.access.receipts);
 h.access.receipts.lookup=(id,...rest)=>id===originId?{state:'confirmed',identity:{tenant:CORPORATE,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:ASSET1},authorization:{source}}:lookup(id,...rest);
 const proposal=path.join(h.dir,'mobile.md'),file=path.join(h.dir,'mobile.json'),body={appIdentifier:{value:'com.ssam.proof'}};
 fs.writeFileSync(proposal,'Own mobile config');
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
  proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
  scope:[{lane:'odc',host:CORPORATE,operation:operationId,targets:['Proof'],environmentKey}],
  constraints:{originOperationUuid:originId,bodySha256:mobileConfigurationHash(body),expectedConfigurationSha256:mobileConfigurationStateHash(current)}}));
 const input={tenant:CORPORATE,confirmTenant:CORPORATE,auth:'api-client',operationId,path:{applicationKey:ASSET1,environmentKey},body,authorize:words,operationUuid:uuid()},context={mobileConfigurationContext:file,originOperationUuid:originId};
 const first=await h.access.write(input,context);assert(first.ok,JSON.stringify(first));assert.equal(sends,1);
 assert.equal(first.receipt.state,'accepted');assert.equal(first.readBack.verified,false);
 await h.access.write(input,context);assert.equal(sends,1);
 current={appIdentifier:{isSecret:false,value:body.appIdentifier.value,lastUpdateDate:new Date().toISOString()}};
 const resumed=await h.access.write(input,context);assert.equal(resumed.receipt.state,'confirmed');assert.equal(resumed.readBack.verified,true);assert.equal(sends,1);
 const stored=lookup(input.operationUuid);assert.ok(stored.reconciliation.mobileConfiguration.valuesSha256);
 assert.equal(JSON.stringify(stored).includes(body.appIdentifier.value),false);
 const wrong=await h.access.receipt({operationUuid:input.operationUuid,reconcile:{state:'confirmed',authorize:words,read:{operationId:operationId.replace(':patch:',':get:'),path:{...input.path,environmentKey:uuid()}}}});
 assert.equal(wrong.error.code,'MOBILE_CONFIGURATION_UNVERIFIED');
 current={appIdentifier:{isSecret:false,value:'foreign'}};
 const drift=await h.access.write({...input,operationUuid:uuid()},context);assert.equal(drift.ok,false);assert.equal(sends,1);
 current={appIdentifier:{isSecret:false,value:null}};loseResponse=true;
 const lostInput={...input,operationUuid:uuid()};
 const lost=await h.access.write(lostInput,context);assert.equal(lost.receipt.state,'uncertain');assert.equal(lost.readBack.verified,false);assert.equal(sends,2);
 readUnavailable=false;
 const recovered=await h.access.receipt({operationUuid:lostInput.operationUuid,reconcile:{state:'confirmed',authorize:words,read:{auth:'api-client',operationId:operationId.replace(':patch:',':get:'),path:input.path}}});
 assert.equal(recovered.receipt.state,'confirmed',JSON.stringify(recovered));assert.equal(recovered.readBack.verified,true);assert.equal(sends,2);
 await h.access.write(lostInput,context);assert.equal(sends,2);
});

test('typed mobile secret scope sends only a vault reference, reconciles without replay and resets the origin',async t=>{
 const environmentKey=uuid(),originId=uuid(),settingKey=uuid(),words='Synthetic own mobile fixture grant';let sends=0,visible=true;
 const field={key:settingKey,name:'SSAMSecret',isSecret:true,dataType:'Text',value:'[REDACTED]',defaultValue:'[REDACTED]',valueOrigin:'Default',metadata:null};
 const current={settings:[field],libraries:[]},source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own mobile fixture and restore'};
 const h=harness({sessions:[{host:CORPORATE,loggedIn:true,user:'test@example.test'}],portalAccount:true,portalCall:request=>{
  if(request.method!=='PATCH')return visible?{ok:true,status:200,body:structuredClone(request.path.includes('/assets/')?{assetKey:ASSET1,assetType:'MobileApplication',name:'Proof'}:current)}:{ok:false,code:'READ_FAILED'};
  sends++;assert.equal(Object.hasOwn(request.body,'key'),false);
  field.valueOrigin=request.body.settings[0].value===null?'Default':'Override';
  if(sends===1){assert.deepEqual(request.secretRefs,[{pointer:'/settings/0/value',target:'SSAM/ODC3/'+CORPORATE+'/Setting/Synthetic',field:'password'}]);visible=false;throw new OdcError('UNCERTAIN','Lost response',{sent:true});}
  assert.deepEqual(request.secretRefs,[]);return {ok:true,status:204,body:null};
 }});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const lookup=h.access.receipts.lookup.bind(h.access.receipts);
 h.access.receipts.lookup=(id,...rest)=>id===originId?{state:'confirmed',identity:{tenant:CORPORATE,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:ASSET1},authorization:{source}}:lookup(id,...rest);
 const proposal=path.join(h.dir,'proof.md'),file=path.join(h.dir,'approval.json');fs.writeFileSync(proposal,'Own mobile synthetic secret and reset');
 const input=reset=>{
  const body={settings:[{key:settingKey,value:reset?null:''}]},refs=reset?[]:[{pointer:'/settings/0/value',target:'SSAM/ODC3/'+CORPORATE+'/Setting/Synthetic',field:'password'}];
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},scope:[{lane:'odc',host:CORPORATE,operation:MOBILE_EXTENSIBILITY_PATCH,targets:['Proof'],environmentKey}],constraints:{originOperationUuid:originId,bodySha256:mobileConfigurationHash(body),expectedConfigurationSha256:extensibilityStateHash(current),...(reset?{}:{secretRefsSha256:mobileConfigurationHash(refs)})}}));
  return {tenant:CORPORATE,scope:'mobile-extensibility',action:'set',assetKey:ASSET1,environmentKey,authorize:words,confirmTenant:CORPORATE,operationUuid:uuid(),originOperationUuid:originId,authorizationContext:file,...(reset?{patch:body}:{vaultSettings:{SSAMSecret:'Synthetic'}})};
 };
 const args=input(false),lost=await h.access.configurations(args);assert.equal(lost.receipt?.state,'uncertain',JSON.stringify(lost));assert.equal(sends,1);
 visible=true;const recovered=await h.access.configurations(args);assert.equal(recovered.receipt?.state,'confirmed',JSON.stringify(recovered));assert.equal(recovered.readBack.valueVerified,false);assert.equal(sends,1);
 const stored=JSON.stringify(lookup(args.operationUuid));assert.doesNotMatch(stored,/valueSha256|preservedValueSha256/);
 const restored=await h.access.configurations(input(true));assert.equal(restored.receipt?.state,'confirmed',JSON.stringify(restored));assert.equal(sends,2);assert.equal(field.valueOrigin,'Default');
 const missingContext=await h.access.configurations({...args,authorizationContext:undefined,operationUuid:uuid()});assert.equal(missingContext.sent,false);assert.equal(sends,2);
 const withoutStudio=await h.access.configurations({...args,auth:'api-client',operationUuid:uuid()});assert.equal(withoutStudio.code,'STUDIO_REQUIRED');assert.equal(sends,2);assert.equal(h.prompts.length,0);
});

test('library extensibility metadata reconciles a lost response without replay and restores its whole state',async t=>{
 const operationId=MOBILE_EXTENSIBILITY_PATCH,environmentKey=uuid(),originId=uuid(),libraryKey=uuid(),settingKey=uuid();let sends=0;
 const field={key:settingKey,isSecret:false,dataType:'Text',value:'Default',defaultValue:'Default',valueOrigin:'Default',metadata:null};
 const current={settings:[],libraries:[{key:libraryKey,revision:3,settings:[field]}]},baseline=extensibilityStateHash(current);
 const h=harness({apiClient:true,vaultExecute:async(id,input,mode)=>{
  if(mode==='read')return {ok:true,status:200,data:structuredClone(id.startsWith('asset-')?{assetKey:ASSET1,assetType:'MobileApplication',name:'Proof'}:current)};
  sends++;field.metadata=input.body.libraries[0].settings[0].metadata;
  if(sends===1)throw new OdcError('UNCERTAIN','Response lost',{sent:true});
  return {ok:true,status:204,data:null};
 }});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own fixture restoration'},words='Synthetic fixture grant';
 const lookup=h.access.receipts.lookup.bind(h.access.receipts);
 h.access.receipts.lookup=(id,...rest)=>id===originId?{state:'confirmed',identity:{tenant:CORPORATE,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:ASSET1},authorization:{source}}:lookup(id,...rest);
 const proposal=path.join(h.dir,'proof.md'),file=path.join(h.dir,'approval.json');fs.writeFileSync(proposal,'Synthetic library metadata proof');
 const request=metadata=>{
  const body={libraries:[{key:libraryKey,settings:[{key:settingKey,metadata}]}]};
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
   scope:[{lane:'odc',host:CORPORATE,operation:operationId,targets:['Proof'],environmentKey}],
   constraints:{originOperationUuid:originId,bodySha256:mobileConfigurationHash(body),expectedConfigurationSha256:extensibilityStateHash(current)}}));
  return {tenant:CORPORATE,auth:'api-client',confirmTenant:CORPORATE,operationId,path:{applicationKey:ASSET1,environmentKey},body,authorize:words,operationUuid:uuid()};
 };
 const context={mobileConfigurationContext:file,originOperationUuid:originId},input=request([{key:'proof',value:'synthetic-metadata'}]);
 const changed=await h.access.write(input,context);assert.equal(changed.receipt.state,'confirmed',JSON.stringify(changed));assert.equal(changed.readBack.verified,true);
 await h.access.write(input,context);assert.equal(sends,1);
 assert.equal(JSON.stringify(lookup(input.operationUuid)).includes('synthetic-metadata'),false);
 const restored=await h.access.write(request(null),context);assert.equal(restored.receipt.state,'confirmed');assert.equal(sends,2);
 assert.equal(extensibilityStateHash(current),baseline);
});

test('owned undeploy honors contextual approval once, refuses deployed drift, and never replays',async t=>{
 let deployed=2,sends=0;const stage=uuid(),job=uuid();
 const h=harness({apiClient:true,vaultExecute:async(id,input,mode)=>{
  if(mode==='read')return {ok:true,status:200,data:id.startsWith('asset-configurations')?{revisionBaseline:deployed,revisionDeployed:deployed}:{assetKey:ASSET1,revision:2,name:'Proof'}};
  assert.equal(id,ASSET_DEPLOYMENT);assert.equal(input.body.operation,'Undeploy');sends++;return {ok:true,status:201,data:{key:job,status:'Running',assetKey:ASSET1}};
 }});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own fixture deployment'},originId=uuid(),words='Synthetic standing grant';
 const lookup=h.access.receipts.lookup.bind(h.access.receipts);
 h.access.receipts.lookup=(id,...rest)=>id===originId?{state:'confirmed',identity:{tenant:PERSONAL,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:ASSET1},authorization:{source}}:lookup(id,...rest);
 const body={operation:'Undeploy',assetKey:ASSET1,revision:2,environmentKey:stage},proposal=path.join(h.dir,'deploy.md'),file=path.join(h.dir,'deploy.json');
 fs.writeFileSync(proposal,'Undeploy exact own fixture');const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},
  scope:[{lane:'odc',host:PERSONAL,operation:ASSET_DEPLOYMENT,targets:['Proof'],environmentKey:stage}],constraints:{originOperationUuid:originId,bodySha256:hash(JSON.stringify(body))}}));
 const input={tenant:PERSONAL,auth:'api-client',operationId:ASSET_DEPLOYMENT,body,authorize:words,operationUuid:uuid()},context={assetBuildContext:file,originOperationUuid:originId};
 const first=await h.access.write(input,context);assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.receipt.state,'accepted');assert.equal(sends,1);
 await h.access.write(input,context);assert.equal(sends,1);
 // A separate request must fail preflight if the deployed baseline has changed.
 deployed=3;const next=await h.access.write({...input,operationUuid:uuid()},context);assert.equal(next.error.code,'DEPLOYMENT_REVISION_CHANGED');assert.equal(sends,1);
});

test('native library release dispatches once, verifies metadata and preserves uncertain receipts',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Release own fixture'};
 const originId=uuid(),publicationKey=uuid(),words='Authorized synthetic library release';
 const lookup=h.access.receipts.lookup.bind(h.access.receipts);
 h.access.receipts.lookup=(id,...rest)=>id===originId?{state:'confirmed',identity:{tenant:PERSONAL,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:ASSET1},authorization:{source}}:lookup(id,...rest);
 const input={ApplicationKey:ASSET1,Revision:2,Version:'1.0.0',ReleaseNotes:'Proof'};
 const proposal=path.join(h.dir,'release.md'),file=path.join(h.dir,'release.json');fs.writeFileSync(proposal,'Release own fixture');
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
  proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},scope:[{lane:'odc',host:PERSONAL,operation:'libraries.release',targets:['Proof']}],
  constraints:{originOperationUuid:originId,publicationKey,expectedTag:null,inputSha256:hash(JSON.stringify(input))}}));
 let tag=null,sends=0,mode='success';
 h.access.read=async({operationId})=>({ok:true,data:operationId.includes('publish-operations')?{key:publicationKey,status:'Finished',assetKey:ASSET1,revision:2,operation:'Publish'}:
  operationId.endsWith('release-notes')?{tag,content:'Proof'}:{assetKey:ASSET1,revision:2,tag,name:'Proof',assetType:'LowCodeLibrary'}});
 h.access.resolvePortal=async()=>({ok:true,path:'vault',broker:{callScreenservice:async request=>{
  assert.equal(request.operationId,'libraries.release');assert.equal(request.write,true);sends++;
  if(mode==='lost')throw new OdcError('UNCERTAIN','Lost response',{sent:true});
  if(mode==='rejected')return {data:{IsValid:false,Version_ErrorMessage:'Rejected'}};
  tag='1.0.0';return {data:{IsValid:true,Version_ErrorMessage:''}};
 }}});
 const args={tenant:PERSONAL,operationId:'libraries.release',input:{inputParameters:input},authorize:words,operationUuid:uuid(),authorizationContext:file};
 const result=await h.access.portalWrite(args);
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.releaseConfirmed,true);assert.equal(result.receipt.state,'confirmed');
 await h.access.portalWrite(args);assert.equal(sends,1);
 tag=null;mode='rejected';const rejected=await h.access.portalWrite({...args,operationUuid:uuid()});assert.equal(rejected.ok,false);assert.equal(rejected.receipt.state,'rejected');
 mode='lost';const lostArgs={...args,operationUuid:uuid()};const lost=await h.access.portalWrite(lostArgs);assert.equal(lost.receipt.state,'uncertain');
 const count=sends;await h.access.portalWrite(lostArgs);assert.equal(sends,count);
});

test('bulk synthetic users send once and clean only inserted records of that receipt',async t=>{
 const records=['BulkA','BulkB'].map(name=>({name,email:name.toLowerCase()+'@ssam-proof.invalid',isActive:false,addToBuiltInIdentityProvider:false}));
 let users=[],status='Finished',itemStatus='Inserted',roles=[];
 const keys=[ASSET1,ROLE1],batchKey=uuid();
 const h=harness({apiClient:true,vaultExecute:async(id,input,mode)=>{
  if(mode==='read'){
   if(id.endsWith('/users/bulk/{key}'))return {ok:true,status:200,data:{key:batchKey,status,operations:records.map((r,i)=>({status:itemStatus,record:{key:keys[i],email:r.email}}))}};
   if(['/groups','/organization-roles','/application-roles'].some(s=>id.endsWith('/{key}'+s)))return {ok:true,status:200,data:{results:roles,page:{totalResults:roles.length}}};
   if(id.endsWith('/users/{key}'))return {ok:true,status:200,data:structuredClone(users.find(u=>u.key===input.path.key))};
   return {ok:true,status:200,data:{results:structuredClone(users),page:{totalResults:users.length}}};
  }
  if(id===USER_BULK_CREATE){users=records.map((r,i)=>({...r,key:keys[i],lastLoginAt:null}));return {ok:true,status:202,data:{key:batchKey,status:'Pending',operations:[]}};}
  assert.equal(id,USER_DELETE);users=users.filter(u=>u.key!==input.path.key);return {ok:true,status:204,data:null};
 }});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const proposal=path.join(h.dir,'bulk.md'),file=path.join(h.dir,'bulk-approval.json'),words='Create and clean synthetic inactive users';fs.writeFileSync(proposal,'Bulk fixture');
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own bulk fixtures'};let originOperationUuid;
 function request(operationId,body,key){
  const create=operationId===USER_BULK_CREATE,current=users.find(u=>u.key===key);
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
   scope:[{lane:'odc',host:CORPORATE,operation:operationId,targets:create?records.map(r=>r.name):[current?.name??'Other']}],
   constraints:{bodySha256:ipFilterHash(body??null),...(create?{}:{originOperationUuid,expectedConfigurationSha256:ipFilterHash(current??null)})}}));
  return {tenant:CORPORATE,confirmTenant:CORPORATE,auth:'api-client',operationId,path:create?{}:{key},...(body?{body}:{}),authorize:words,operationUuid:uuid()};
 }
 const send=r=>h.access.write(r,{inactiveUserContext:file,originOperationUuid});
 for(const invalid of [[],[records[0],records[0]],[{...records[0],isActive:true}],[{...records[0],addToBuiltInIdentityProvider:true}],[{...records[0],email:'actual@example.com'}]])
  assert.equal((await send(request(USER_BULK_CREATE,{records:invalid}))).sent,false);
 const create=request(USER_BULK_CREATE,{records}),created=await send(create);assert.equal(created.ok,true,JSON.stringify(created));originOperationUuid=create.operationUuid;
 await send(create);assert.equal(h.vaultCalls.filter(c=>c.mode==='write').length,1);
 assert.deepEqual(h.access.receipts.lookup(originOperationUuid).identity.target.records,records);
 const del=request(USER_DELETE,undefined,keys[0]);
 status='Processing';assert.equal((await send(del)).sent,false);status='Finished';
 itemStatus='Updated';assert.equal((await send(del)).sent,false);itemStatus='Inserted';
 roles=[{key:ROLE1}];assert.equal((await send(del)).sent,false);roles=[];
 users[0].name='Concurrent';assert.equal((await send(del)).sent,false);users[0].name=records[0].name;
 assert.equal((await send(del)).ok,true);
 assert.equal((await send(request(USER_DELETE,undefined,keys[1]))).ok,true);assert.deepEqual(users,[]);
 assert.equal(h.vaultCalls.filter(c=>c.mode==='write').length,3);
});

test('organization role context restores name and permissions, refuses users and drift, and preserves creation origin',async t=>{
 let current=null,users=[];
 const h=harness({apiClient:true,vaultExecute:async(id,input,mode)=>{
  if(mode==='read'){
   if(id.endsWith('/permissions/{key}'))return {ok:true,status:200,data:{key:ASSET1,allowedScopes:['Organization'],allowStages:false,allowPortfolios:false}};
   if(id.endsWith('/users'))return {ok:true,status:200,data:{results:users,page:{totalResults:users.length}}};
   if(id.endsWith('/{key}'))return {ok:true,status:200,data:structuredClone(current)};
   assert.equal(input.query.nameContains,undefined);
   const results=current?[current]:[];
   return {ok:true,status:200,data:{results,page:{totalResults:results.length}}};
  }
  if(id===ORG_ROLE_CREATE)current={key:ROLE1,...input.body,isReadOnly:false};
  if(id===ORG_ROLE_PATCH)current={...current,...input.body};
  if(id===ORG_ROLE_DELETE)current=null;
  return {ok:true,status:id===ORG_ROLE_CREATE?201:204,data:id===ORG_ROLE_CREATE?{orgRoleKey:ROLE1}:null};
 }});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const proposal=path.join(h.dir,'role.md'),file=path.join(h.dir,'role-approval.json'),words='Synthetic empty role lifecycle';fs.writeFileSync(proposal,'Empty role');
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Synthetic role'};let originOperationUuid;
 function request(operationId,body){const create=operationId===ORG_ROLE_CREATE;
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
   scope:[{lane:'odc',host:CORPORATE,operation:operationId,targets:['EmptyRole']}],
   constraints:{bodySha256:ipFilterHash(body??null),...(create?{}:{originOperationUuid,expectedConfigurationSha256:ipFilterHash(current)})}}));
  return {tenant:CORPORATE,confirmTenant:CORPORATE,auth:'api-client',operationId,path:create?{}:{key:ROLE1},...(body?{body}:{}),authorize:words,operationUuid:uuid()};
 }
 const send=r=>h.access.write(r,{organizationRoleContext:file,originOperationUuid});
 const create=request(ORG_ROLE_CREATE,{name:'EmptyRole',permissions:[]});assert.equal((await send(create)).ok,true);originOperationUuid=create.operationUuid;
 await send(create);assert.equal(h.vaultCalls.filter(x=>x.mode==='write').length,1);
 const baseline=structuredClone(current),change=request(ORG_ROLE_PATCH,{name:'ChangedRole'});
 users=[{key:ASSET1}];assert.equal((await send(change)).sent,false);users=[];
 current.permissions=[{key:ASSET1}];assert.equal((await send(change)).sent,false);current=structuredClone(baseline);
 current.name='Concurrent';assert.equal((await send(change)).sent,false);current=structuredClone(baseline);
 assert.equal((await send(change)).ok,true);assert.equal(current.name,'ChangedRole');
 assert.equal((await send(request(ORG_ROLE_PATCH,{name:'EmptyRole'}))).ok,true);assert.deepEqual(current,baseline);
 const permission={permissionKey:ASSET1};
 users=[{key:ASSET1}];assert.equal((await send(request(ORG_ROLE_PATCH,{name:'EmptyRole',permissions:[permission]}))).sent,false);users=[];
 assert.equal((await send(request(ORG_ROLE_PATCH,{name:'EmptyRole',permissions:[permission,permission]}))).sent,false);
 assert.equal((await send(request(ORG_ROLE_PATCH,{name:'EmptyRole',permissions:[{...permission,environmentKeys:[ASSET1]}]}))).sent,false);
 assert.equal((await send(request(ORG_ROLE_PATCH,{name:'EmptyRole',permissions:[{permissionKey:ROLE1}]}))).sent,false);
 assert.equal((await send(request(ORG_ROLE_PATCH,{name:'EmptyRole',permissions:[permission]}))).ok,true);assert.deepEqual(current.permissions,[permission]);
 assert.equal((await send(request(ORG_ROLE_DELETE))).sent,false);
 assert.equal((await send(request(ORG_ROLE_PATCH,{name:'EmptyRole',permissions:[]}))).ok,true);assert.deepEqual(current,baseline);
 assert.equal((await send(request(ORG_ROLE_DELETE))).ok,true);assert.equal(current,null);
 assert.equal(h.vaultCalls.filter(x=>x.mode==='write').length,6);
});
test('own user context restores name and activation, refuses assignments, drift and active deletion',async t=>{
 let current=null,users=[];
 const h=harness({apiClient:true,vaultExecute:async(id,input,mode)=>{
  if(mode==='read'){
   if(['/groups','/organization-roles','/application-roles'].some(suffix=>id.endsWith('/{key}'+suffix)))return {ok:true,status:200,data:{results:users,page:{totalResults:users.length}}};
   if(id.endsWith('/{key}'))return {ok:true,status:200,data:structuredClone(current)};
   assert.equal(input.query.nameContains,undefined);
   const results=current?[current]:[];
   return {ok:true,status:200,data:{results,page:{totalResults:results.length}}};
  }
  if(id===USER_CREATE)current={key:ASSET1,name:input.body.name,isActive:false,email:input.body.email,lastLoginAt:null};
  if(id===USER_PATCH)current={...current,...input.body};
  if(id===USER_DELETE)current=null;
  return {ok:true,status:id===USER_CREATE?201:204,data:id===USER_CREATE?{key:ASSET1}:null};
 }});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const proposal=path.join(h.dir,'role.md'),file=path.join(h.dir,'role-approval.json'),words='Synthetic inactive user lifecycle';fs.writeFileSync(proposal,'Empty role');
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Synthetic role'};let originOperationUuid;
 function request(operationId,body){const create=operationId===USER_CREATE;
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
   scope:[{lane:'odc',host:CORPORATE,operation:operationId,targets:['InactiveUser']}],
   constraints:{bodySha256:ipFilterHash(body??null),...(create?{}:{originOperationUuid,expectedConfigurationSha256:ipFilterHash(current)})}}));
  return {tenant:CORPORATE,confirmTenant:CORPORATE,auth:'api-client',operationId,path:create?{}:{key:ASSET1},...(body?{body}:{}),authorize:words,operationUuid:uuid()};
 }
 const send=r=>h.access.write(r,{inactiveUserContext:file,originOperationUuid});
 const create=request(USER_CREATE,{name:'InactiveUser',email:'fixture@ssam-proof.invalid',isActive:false,addToBuiltInIdentityProvider:false});assert.equal((await send(create)).ok,true);originOperationUuid=create.operationUuid;
 await send(create);assert.equal(h.vaultCalls.filter(x=>x.mode==='write').length,1);
 const baseline=structuredClone(current),change=request(USER_PATCH,{name:'ChangedUser'});
 users=[{key:ASSET1}];assert.equal((await send(change)).sent,false);users=[];
 current.isActive=true;assert.equal((await send(change)).sent,false);current=structuredClone(baseline);
 current.name='Concurrent';assert.equal((await send(change)).sent,false);current=structuredClone(baseline);
 assert.equal((await send(change)).ok,true);assert.equal(current.name,'ChangedUser');
 assert.equal((await send(request(USER_PATCH,{name:'InactiveUser'}))).ok,true);assert.deepEqual(current,baseline);
 const activate=request(USER_PATCH,{isActive:true});
 users=[{key:ASSET1}];assert.equal((await send(activate)).sent,false);users=[];
 current.lastLoginAt='2026-10-09T00:00:00Z';assert.equal((await send(activate)).sent,false);current.lastLoginAt=null;
 assert.equal((await send(request(USER_PATCH,{isActive:'true'}))).sent,false);
 assert.equal((await send(request(USER_PATCH,{isActive:true,name:'Other'}))).sent,false);
 assert.equal((await send(request(USER_PATCH,{isActive:true}))).ok,true);assert.equal(current.isActive,true);
 assert.equal((await send(request(USER_DELETE))).sent,false);
 assert.equal((await send(request(USER_PATCH,{isActive:true}))).sent,false);
 assert.equal((await send(request(USER_PATCH,{isActive:false}))).ok,true);assert.deepEqual(current,baseline);
 assert.equal((await send(request(USER_DELETE))).ok,true);assert.equal(current,null);
 assert.equal(h.vaultCalls.filter(x=>x.mode==='write').length,6);
});

test('IP group approval binds creation, baseline and restoration without replay or application bindings',async t=>{
 let current=null;
 const h=harness({apiClient:true,vaultExecute:async(id,input,mode)=>{
  if(mode==='read')return {ok:true,status:200,data:input.path.ipFilterGroupKey?structuredClone(current):{results:current?[current]:[]}};
  if(id===IP_FILTER_CREATE)current={...input.body,key:ASSET1};
  if(id===IP_FILTER_PATCH)current={...current,...input.body};
  if(id===IP_FILTER_DELETE)current=null;
  return {ok:true,status:id===IP_FILTER_CREATE?201:204,data:id===IP_FILTER_CREATE?{key:ASSET1}:null};
 }});
 t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const proposal=path.join(h.dir,'proposal.md'),file=path.join(h.dir,'approval.json'),words='Synthetic new fixture permission';
 fs.writeFileSync(proposal,'Unbound IP filter fixture');
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Synthetic fixture'};
 let originOperationUuid;
 function request(operationId,body){
  const create=operationId===IP_FILTER_CREATE;
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
   constraints:{bodySha256:ipFilterHash(body??null),...(create?{}:{originOperationUuid,expectedConfigurationSha256:ipFilterHash(current)})},
   scope:[{lane:'odc',host:CORPORATE,operation:operationId,environmentKey:ENV1,targets:['Proof']}]}));
  return {tenant:CORPORATE,confirmTenant:CORPORATE,auth:'api-client',operationId,path:{environmentKey:ENV1,...(create?{}:{ipFilterGroupKey:ASSET1})},...(body?{body}:{}),authorize:words,operationUuid:uuid()};
 }
 const create=request(IP_FILTER_CREATE,{name:'Proof',description:'baseline',accessType:'DENYLIST',ipRules:[],appKeys:[]});
 const send=r=>h.access.write(r,{ipFilterContext:file,originOperationUuid});
 assert.equal((await send(create)).ok,true);originOperationUuid=create.operationUuid;
 assert.equal((await send(create)).ok,true);assert.equal(h.vaultCalls.filter(c=>c.mode==='write').length,1);
 const delta={description:'changed',ipRules:[{name:'Documentation range',ranges:['192.0.2.0/30'],isActive:true}]};
 const baseline=structuredClone(current), change=request(IP_FILTER_PATCH,delta);
 current.description='concurrent';assert.equal((await send(change)).sent,false);current=structuredClone(baseline);
 assert.equal((await send(change)).ok,true);assert.deepEqual(current,{...baseline,...delta});
 const restore=request(IP_FILTER_PATCH,{description:'baseline',ipRules:baseline.ipRules});current.appKeys=[ASSET1];
 assert.equal((await send(restore)).sent,false);current.appKeys=[];
 assert.equal((await send(restore)).ok,true);assert.deepEqual(current,baseline);
 const remove=request(IP_FILTER_DELETE);assert.equal((await send(remove)).ok,true);assert.equal(current,null);
 assert.equal(h.vaultCalls.filter(c=>c.mode==='write').length,4);
});

// Offline: fakes of the ODC Studio bridge (auth-status, portal-call, portal-session), of the vault (status and an
// OdcBridge) and of the private prompt. Nothing here reaches a Studio, a vault, a tenant or a window.
const catalog = new Catalog();
const PERSONAL = 'personal-test.outsystems.dev', CORPORATE = 'corp.outsystems.dev', CLIENT = 'client.outsystems.dev', OTHER = 'other-test.outsystems.dev';
const tenants = { default: PERSONAL, tenants: {
  [PERSONAL]: { class: 'personal', portalOrigin: 'https://' + PERSONAL }, [OTHER]: { class: 'personal', portalOrigin: 'https://' + OTHER },
  [CORPORATE]: { class: 'corporate', portalOrigin: 'https://' + CORPORATE }, [CLIENT]: { class: 'client', readOnly: true, portalOrigin: 'https://' + CLIENT } } };
const WORDS = 'yes, do it on the personal tenant now';
const uuid = () => crypto.randomUUID();
const ASSETS = 'asset-repository-api-v1:get:/assets';
const ASSET = 'asset-repository-api-v1:get:/assets/{assetKey}';
const DELETE_ASSET = 'asset-repository-api-v1:delete:/assets/{assetKey}';
const PATCH_ROLE = 'user-access-management-api-v1:patch:/organization-roles/{key}';
const ROLE1 = '11111111-1111-4111-8111-111111111111', ROLE2 = '22222222-2222-4222-8222-222222222222';
const ASSET1 = '33333333-3333-4333-8333-333333333333', ENV1 = '44444444-4444-4444-8444-444444444444', DEP1 = '55555555-5555-4555-8555-555555555555';

function harness({ running = true, connected = true, sessions = [{ host: PERSONAL, loggedIn: true, user: 'dev@example.test' }], apiClient = false, portalAccount = false,
  portalCall, portalSession, vaultExecute, brokerState = {}, capabilities = ['portal-session:headless'], profiles, hosted = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-access-'));
  const calls = [], requests = new Map(), prompts = [], vaultCalls = [], journal = [], vaultAsked = [];
  const studio = {
    running: async () => running,
    call: async args => {
      calls.push(args);
      if (!connected) throw new Error('pipe not found');
      if (args[0] === 'auth-status') return { ok: true, bridge: 'v32', sessions, portalWindows: [], ...(capabilities ? { capabilities } : {}) };
      if (args[0] === 'portal-call') return portalCall ? portalCall(requests.get(args[1]), args) : { ok: true, status: 200, contentType: 'application/json', body: { items: [] }, source: 'studio', host: args[3] };
      if (args[0] === 'portal-session') return portalSession ? portalSession(args, args[1] === 'fetch' ? requests.get(args[2]) : null) : { ok: true, host: args.at(-1), signedIn: true };
      return { ok: false, error: 'Unknown command' };
    },
  };
  const vault = {
    apiClient: async host => { vaultAsked.push(['api-client', host]); return { available: typeof apiClient === 'function' ? apiClient(host) : apiClient }; },
    portal: async (host, database, setting) => { vaultAsked.push(['portal', host, database ?? null, setting ?? null]); return { available: typeof portalAccount === 'function' ? portalAccount(host, database, setting) : portalAccount }; },
    bridge: async host => ({ execute: async (operationId, input, mode) => { vaultCalls.push({ host, operationId, input, mode });
      return vaultExecute ? vaultExecute(operationId, input, mode) : { ok: true, operationId, status: 200, data: { from: 'vault' } }; } }),
  };
  const openWindows = new Set();
  const showPrompt = (key, args) => { const opened = !openWindows.has(key); if (opened) prompts.push(args); openWindows.add(key);
    return { state: 'visible', visible: true, foreground: true, pid: 1000, opened, alreadyOpen: !opened }; };
  const prompt = { apiClient: async host => showPrompt('api:' + host, ['api-client', host]),
    portal: async (host, database, setting) => showPrompt([host, database, setting].join(':'), ['portal', host, database ?? null, ...(setting ? [setting] : [])]) };
  const broker = { target: 'odc3', available: false, authenticated: false, initialize: async () => {}, status: () => ({ authenticated: broker.authenticated }), ...brokerState };
  let n = 0;
  const brokers = [];
  const access = new OdcAccess({ catalog, tenants, studio, vault, prompt, profiles, portalBroker: host => { brokers.push(host); return Object.assign(broker, { origin: 'https://' + host }); },
    journal: entry => journal.push(entry), receipts: new WriteJournal(path.join(dir, 'receipts')),
    requestFile: json => { const file = path.join(dir, 'req-' + (++n) + '.json'); requests.set(file, json); return file; }, sleep: async () => {}, hosted });
  return { access, calls, requests, prompts, vaultCalls, journal, dir, broker, vaultAsked, brokers };
}
const portalCalls = calls => calls.filter(c => c[0] === 'portal-call');

test('owned header edit persists expectations, restores metadata and reconciles a lost response without replay',async t=>{
 for(const lost of [false,true]){
  const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
  const originId=uuid(),editId=uuid(),words='Synthetic temporary connection lifecycle grant';
  const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own connection lifecycle'};
  const proposal=path.join(h.dir,'proposal.md');fs.writeFileSync(proposal,'Create, edit metadata, restore, delete own connection');
  const proposalSha256=crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex');
  const baseline={NotFound:false,Connection:{connectionId:'own-header',providerId:'mssql',variant:'vanilla',name:'Owned',description:'Original',portfolioKey:'',updatedOn:'2026-10-09T22:00:00Z',
   ExternalMetadata:{selectedObjectCount:0,selectedActionCount:0},
   NullValueHandling:Object.fromEntries(['NullWriteBehavior','Boolean','Date','Time','DateTime','Integer','LongInteger','Decimal','Text'].map(k=>[k,''])),
   StageConfigurations:{List:[{StageKey:'dev',configurationValues:{List:[{key:'host',value:'db.test'},{key:'port',value:'1433'},{key:'database',value:'Fixture'},{key:'password',value:'PRIVATE_CREDENTIAL'}]}}]}}};
  const origin=h.access.receipts.reserve({operationUuid:originId,identity:{kind:'odc-portal',tenant:PERSONAL,operationId:'connections.relationalTest',target:{connectionName:'Owned',step:'test'}},wordsSha256:'synthetic',plan:{authorizationContext:{sha256:'synthetic',proposalSha256,source}}});
  h.access.receipts.settle(origin,{state:'accepted',response:{Out_ConnectionId:'own-header'}});
  let current=structuredClone(baseline),writes=0,failRead=false;
  h.access.resolvePortal=async()=>({path:'vault',broker:{callScreenservice:async request=>{
   if(!request.write){
    if(request.operationId==='connections.relationalNameAvailability')return {data:{IsNameAvailable:true}};
    if(failRead){failRead=false;throw Error('Synthetic observation outage');}
    return {data:structuredClone(current)};
   }
   writes++;assert.equal(request.operationId,'connections.relationalSave');
   assert.deepEqual(request.input.inputParameters.ConnectionDetails.ConnectionDetail_StageConfig,{List:[]});
   assert.equal(request.input.inputParameters.ConnectionOriginalUpdateTimestamp,current.Connection.updatedOn);
   const header=request.input.inputParameters.ConnectionDetails.ConnectionDetails_Header;
   current.Connection.name=header.ConnectionName;current.Connection.description=header.ConnectionDescription;
   current.Connection.updatedOn=writes===1?'2026-10-09T22:01:00Z':'2026-10-09T22:02:00Z';
   if(lost&&writes===1){failRead=true;throw Error('Synthetic lost response');}
   return {data:{}};
  }}});
  function prepare(patch,id){
   const plan=connectionHeaderPlan(current,{connectionId:'own-header',providerId:'mssql'},patch,current.Connection.updatedOn);
   const context=path.join(h.dir,id+'.json');
   fs.writeFileSync(context,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:proposalSha256},
    scope:[{lane:'odc',host:PERSONAL,operation:'connections.relationalSave',environmentKey:'dev',targets:['Owned','Renamed']}],
    constraints:{originOperationUuid:originId,planSha256:plan.planSha256,noStageChanges:true,server:'db.test',port:1433,database:'Fixture',noDdl:true,noDataWrites:true,noBusinessDataReads:true}}));
   return {action:'edit-header',tenant:PERSONAL,connectionId:'own-header',providerId:'mssql',headerPatch:patch,expectedUpdatedOn:current.Connection.updatedOn,
    expectedPlanSha256:plan.planSha256,originOperationUuid:originId,operationUuid:id,authorize:words,authorizationContext:context};
  }
  const input=prepare({name:'Renamed',description:'Changed'},editId);
  const context=JSON.parse(fs.readFileSync(input.authorizationContext,'utf8'));
  const wrongContext=path.join(h.dir,'wrong-scope.json');
  fs.writeFileSync(wrongContext,JSON.stringify({...context,scope:context.scope.map(s=>({...s,targets:['Unrelated']}))}));
  const unapproved=await h.access.externalDbConnection({...input,authorizationContext:wrongContext});
  assert.equal(unapproved.error.code,'AUTHORIZATION_CONTEXT_INVALID');assert.equal(writes,0);
  const wrongOrigin=h.access.receipts.lookup(originId);
  h.access.receipts.settle(wrongOrigin,{response:{Out_ConnectionId:'foreign-id'}});
  const foreign=await h.access.externalDbConnection(input);
  assert.equal(foreign.error.code,'AUTHORIZATION_CONTEXT_INVALID');assert.equal(writes,0);
  h.access.receipts.settle(wrongOrigin,{response:{Out_ConnectionId:'own-header'}});
  const stale=await h.access.externalDbConnection({...input,expectedPlanSha256:'0'.repeat(64)});
  assert.equal(stale.error.code,'CONNECTION_CHANGED');assert.equal(writes,0);assert.equal(h.access.receipts.lookup(editId),null);
  const edited=await h.access.externalDbConnection(input);
  assert.equal(edited.receipt.state,lost?'uncertain':'confirmed',JSON.stringify(edited));
  const again=await h.access.externalDbConnection(input);
  assert.equal(again.receipt.state,'confirmed');assert.equal(writes,1);
  const restored=await h.access.externalDbConnection(prepare({name:'Owned',description:'Original'},uuid()));
  assert.equal(restored.receipt.state,'confirmed',JSON.stringify(restored));assert.equal(writes,2);
  assert.deepEqual({...current.Connection,updatedOn:baseline.Connection.updatedOn},baseline.Connection);
  assert.doesNotMatch(JSON.stringify(edited),/PRIVATE_CREDENTIAL/);assert.equal(h.prompts.length,0);
 }
});

test('connection header plan reads current detail and checks the name against the same ID without writes',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const stamp='2026-10-09T22:00:00Z', sends=[];
 const connection={connectionId:'owned-id',providerId:'mssql',variant:'vanilla',name:'Owned',description:'Before',portfolioKey:'',updatedOn:stamp,
  ExternalMetadata:{selectedObjectCount:0,selectedActionCount:0},
  NullValueHandling:Object.fromEntries(['NullWriteBehavior','Boolean','Date','Time','DateTime','Integer','LongInteger','Decimal','Text'].map(key=>[key,''])),
  StageConfigurations:{List:[{StageKey:'dev',configurationValues:{List:[{key:'password',value:'SYNTHETIC_PRIVATE'}]}}]}};
 let available=true;
 h.access.resolvePortal=async()=>({path:'vault',broker:{callScreenservice:async request=>{
  sends.push(request);assert.equal(request.write,false);
  if(request.operationId==='connections.detail')return {data:{NotFound:false,Connection:connection}};
  assert.equal(request.operationId,'connections.relationalNameAvailability');
  assert.deepEqual(request.input.inputParameters,{ConnectionName:'Renamed',ConnectionId:'owned-id'});
  return {data:{IsNameAvailable:available}};
 }}});
 const input={tenant:PERSONAL,action:'plan-header',connectionId:'owned-id',providerId:'mssql',headerPatch:{name:'Renamed'},expectedUpdatedOn:stamp};
 const result=await h.access.externalDbConnection(input);
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.ready,true);assert.equal(result.sent,false);
 assert.equal(result.nameAvailability.connectionId,'owned-id');assert.equal(result.plan.restores.description,'Before');
 assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE|configurationValues/);
 assert.equal(sends.length,2);assert.equal(h.vaultCalls.length,0);assert.equal(h.prompts.length,0);
 available=false;
 const collision=await h.access.externalDbConnection(input);
 assert.equal(collision.ok,true);assert.equal(collision.ready,false);assert.equal(collision.nameAvailability.available,false);
 const count=sends.length;
 const stale=await h.access.externalDbConnection({...input,expectedUpdatedOn:'old'});
 assert.equal(stale.ok,false);assert.equal(stale.code,'CONNECTION_CHANGED');assert.equal(sends.length,count+1);
});

test('organization role creation retains its native key in the durable receipt and never replays',async t=>{
 const h=harness({apiClient:true,vaultExecute:async()=>({ok:true,status:201,data:{orgRoleKey:ROLE1}})});
 t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const request={tenant:PERSONAL,auth:'api-client',operationId:'user-access-management-api-v1:post:/organization-roles',
  body:{name:'EmptyProof',permissions:[]},authorize:WORDS,operationUuid:uuid()};
 const result=await h.access.write(request);assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(result.receipt.response.orgRoleKey,ROLE1);
 const again=await h.access.write(request);assert.equal(again.receipt.response.orgRoleKey,ROLE1);
 assert.equal(h.vaultCalls.filter(x=>x.mode==='write').length,1);
 const stored=JSON.parse(fs.readFileSync(result.receipt.file,'utf8'));assert.equal(stored.response.orgRoleKey,ROLE1);
});

test('new asset contextual approval gates corporate writes and preserves single dispatch', async t => {
  let inventory = {results: [], page: {totalResults: 0}};
  const h = harness({apiClient: true, vaultExecute: async (operationId, input, mode) =>
    ({ok: true, status: mode === 'write' ? 201 : 200, data: mode === 'write' ? {key: ASSET1} : inventory})});
  t.after(() => fs.rmSync(h.dir, {recursive: true, force: true}));
  const body = {assetCreationDetails: {assetName: 'SSAMContextTest', assetType: 'LowCodeLibrary'}};
  const words = 'Synthetic permission to create new test fixtures';
  const operationId = 'asset-repository-api-v1:post:/assets';
  const proposal = path.join(h.dir, 'proposal.md'), file = path.join(h.dir, 'approval.json');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(proposal, 'Synthetic new asset proposal');
  fs.writeFileSync(file, JSON.stringify({schema: 'ssam-authorization-context/1', decision: 'approved', words,
    source: {kind: 'human-conversation', threadId: uuid(), messageId: uuid(), question: 'Synthetic test'},
    proposal: {file: proposal, sha256: hash(fs.readFileSync(proposal))}, constraints: {bodySha256: hash(JSON.stringify(body))},
    scope: [{lane: 'odc', host: CORPORATE, operation: operationId, targets: ['SSAMContextTest']}]}));
  const input = {tenant: CORPORATE, confirmTenant: CORPORATE, auth: 'api-client', operationId, body, authorize: words, operationUuid: uuid()};
  const result = await h.access.write(input, {assetCreationContext: file});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.access.receipts.lookup(input.operationUuid).identity.target.name,body.assetCreationDetails.assetName);
  await h.access.write(input, {assetCreationContext: file});
  assert.equal(h.vaultCalls.filter(c => c.mode === 'write').length, 1);
  inventory = {results: [], page: {totalResults: 1}};
  const blocked = {...input, operationUuid: uuid()};
  const refused = await h.access.write(blocked, {assetCreationContext: file});
  assert.equal(refused.error.code, 'ASSET_INVENTORY_UNAVAILABLE');
  assert.equal(h.access.receipts.lookup(blocked.operationUuid), null);
  const other = {...input, operationId: PATCH_ROLE, path: {key: ROLE1}, body: {name: 'Changed'}, operationUuid: uuid()};
  assert.equal((await h.access.write(other, {assetCreationContext: file})).error.code, 'AUTHORIZATION_CONTEXT_INVALID');
  assert.equal(h.access.receipts.lookup(other.operationUuid), null);
  assert.equal(h.vaultCalls.filter(c => c.mode === 'write').length, 1);
});

test('IP binding uses the actual receipt produced by contextual asset creation',async t=>{
 const assetName='ActualReceiptApp',groupName='ActualReceiptGroup',assetUuid=uuid(),groupUuid=uuid();
 const current={key:ROLE1,name:groupName,accessType:'DENYLIST',description:'baseline',ipRules:[],appKeys:[]};
 let assetCreated=false;
 const h=harness({apiClient:true,vaultExecute:async(id,input,mode)=>{
  if(mode==='read'){
   if(id===ASSETS)return {ok:true,data:{results:[],page:{totalResults:0}}};
   if(id===ASSET)return {ok:true,data:{assetKey:ASSET1,name:assetName,assetType:'WebApplication'}};
   return {ok:true,data:id.endsWith('/{ipFilterGroupKey}')?structuredClone(current):{results:[]}};
  }
  if(id==='asset-repository-api-v1:post:/assets'){assetCreated=true;return {ok:true,status:201,data:{assetKey:ASSET1}};}
  if(id===IP_FILTER_CREATE)return {ok:true,status:201,data:{key:ROLE1}};
  assert.equal(id,IP_FILTER_PATCH);assert(assetCreated);Object.assign(current,input.body);return {ok:true,status:204,data:null};
 }});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own fixtures only'},words='Synthetic own fixture grant';
 const proposal=path.join(h.dir,'proposal.md');fs.writeFileSync(proposal,'Create own app and associate own IP group');
 function context(label,operation,targets,constraints,stage=false){const file=path.join(h.dir,label+'.json');fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},scope:[{lane:'odc',host:CORPORATE,operation,targets,...(stage?{environmentKey:ENV1}:{})}],constraints}));return file;}
 const common={tenant:CORPORATE,auth:'api-client',confirmTenant:CORPORATE,authorize:words};
 const body={assetCreationDetails:{assetName,assetType:'WebApplication'}},create='asset-repository-api-v1:post:/assets';
 const assetContext=context('asset',create,[assetName],{bodySha256:ipFilterHash(body)});
 const assetRequest={...common,operationId:create,body,operationUuid:assetUuid};
 assert.equal((await h.access.write(assetRequest,{assetCreationContext:assetContext})).ok,true);
 assert.equal((await h.access.write(assetRequest,{assetCreationContext:assetContext})).existingReceipt,true);
 assert.equal(h.access.receipts.lookup(assetUuid).identity.target.name,assetName);
 const groupBody={name:groupName,description:'baseline',accessType:'DENYLIST',ipRules:[],appKeys:[]};
 const groupContext=context('group',IP_FILTER_CREATE,[groupName],{bodySha256:ipFilterHash(groupBody)},true);
 assert.equal((await h.access.write({...common,operationId:IP_FILTER_CREATE,path:{environmentKey:ENV1},body:groupBody,operationUuid:groupUuid},{ipFilterContext:groupContext})).ok,true);
 const binding={appKeys:[ASSET1]},bindingContext=context('binding',IP_FILTER_PATCH,[groupName],{bodySha256:ipFilterHash(binding),originOperationUuid:groupUuid,expectedConfigurationSha256:ipFilterHash(current),bindingOriginsJson:JSON.stringify([{assetKey:ASSET1,operationUuid:assetUuid}])},true);
 const request={...common,operationId:IP_FILTER_PATCH,path:{environmentKey:ENV1,ipFilterGroupKey:ROLE1},body:binding,operationUuid:uuid()};
 const result=await h.access.write(request,{ipFilterContext:bindingContext,originOperationUuid:groupUuid});assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual(current.appKeys,[ASSET1]);assert.equal(h.vaultCalls.filter(x=>x.mode==='write').length,3);
 current.appKeys=[];const origin=h.access.receipts.lookup(assetUuid);delete origin.identity.target.name;
 await assert.rejects(ipFilterApproval({file:bindingContext,words,host:CORPORATE,operationId:IP_FILTER_PATCH,input:request,originOperationUuid:groupUuid,lookup:id=>id===assetUuid?origin:h.access.receipts.lookup(id),read:async id=>({ok:true,data:id===ASSET?{assetKey:ASSET1,name:assetName,assetType:'WebApplication'}:current})}),{code:'AUTHORIZATION_CONTEXT_INVALID'});
});

test('template creation reads revision metadata and refuses missing metadata before reserving a write',async t=>{
 let templateType='ApplicationTemplate';
 const metadata='asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}/metadata';
 const operationId='asset-repository-api-v1:post:/assets';
 const h=harness({apiClient:true,vaultExecute:async(id,input,mode)=>{
  if(id===ASSET)return {ok:true,data:{assetKey:ASSET1,assetType:'WebApplication',revision:6}};
  if(id===metadata){assert.deepEqual(input.path,{assetKey:ASSET1,revisionNumber:6});return {ok:true,data:{templateType}};}
  if(id===ASSETS)return {ok:true,data:{results:[],page:{totalResults:0}}};
  assert.equal(id,operationId);assert.equal(mode,'write');return {ok:true,status:201,data:{assetKey:ROLE1}};
 }});
 t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const body={assetCreationDetails:{assetName:'SSAMTemplateTest',assetType:'WebApplication',templateKey:ASSET1}};
 const proposal=path.join(h.dir,'proposal.md'),file=path.join(h.dir,'approval.json');fs.writeFileSync(proposal,'Synthetic template');
 const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words:WORDS,
  source:{kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Synthetic template'},
  proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},constraints:{bodySha256:hash(JSON.stringify(body))},
  scope:[{lane:'odc',host:CORPORATE,operation:operationId,targets:['SSAMTemplateTest']}]}));
 const input={tenant:CORPORATE,confirmTenant:CORPORATE,auth:'api-client',operationId,body,authorize:WORDS,operationUuid:uuid()};
 assert.equal((await h.access.write(input,{assetCreationContext:file})).ok,true);
 templateType=null;const refusedId=uuid();
 const refused=await h.access.write({...input,operationUuid:refusedId},{assetCreationContext:file});
 assert.equal(refused.error.code,'ASSET_TEMPLATE_UNAVAILABLE');assert.equal(h.access.receipts.lookup(refusedId),null);
 assert.equal(h.vaultCalls.filter(c=>c.mode==='write').length,1);
});

test('configuration prerequisite authentication failure sends no mutation and reserves no receipt', async t => {
  const h = harness({ portalCall: request => {
    assert.equal(request.write, false);
    return { ok: false, code: 'STUDIO_NOT_SIGNED_IN', message: 'Bearer private-test-token' };
  } });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const operationUuid = uuid();
  const result = await h.access.configurations({ tenant: PERSONAL, auth: 'studio', action: 'set', scope: 'application',
    environmentKey: ENV1, assetKey: ASSET1, authorize: WORDS, operationUuid,
    authorizationContext: path.join(h.dir, 'unused-approval.json'),
    patch: { timers: [{ key: DEP1, configs: [{ key: 'IsActive', value: null }] }] } });
  assert.equal(result.ok, false); assert.equal(result.sent, false);
  assert.equal(result.error.code, 'CONFIGURATION_PREREQUISITE_UNAVAILABLE');
  assert.equal(result.error.causeCode, 'STUDIO_NOT_SIGNED_IN');
  assert.equal(result.error.stage, 'configuration');
  assert.equal(result.receipt, undefined); assert.equal(h.access.receipts.lookup(operationUuid), null);
  assert.equal(JSON.stringify(result).includes('private-test-token'), false);
  assert.equal(portalCalls(h.calls).length, 1); assert.deepEqual(h.prompts, []);
});

for (const scope of ['application', 'agent']) test(`${scope} configuration revision satisfies the string path contract`, async t => {
  const h = harness(); t.after(() => fs.rmSync(h.dir, {recursive: true, force: true}));
  const result = await h.access.configurations({tenant: PERSONAL, auth: 'studio', action: 'get', scope,
    environmentKey: ENV1, assetKey: ASSET1, revision: 3});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(portalCalls(h.calls).length, 1);
  const request = h.requests.get(portalCalls(h.calls)[0][1]);
  assert.equal(request.path, `/environments/${ENV1}/${scope}s/${ASSET1}/revisions/3/configurations`);
  assert.equal(request.method, 'GET');
});

test('simultaneous explicit Portal logins join the same headless session operation', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const h = harness({ portalSession: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const args = { tenant: PERSONAL, auth: 'studio', action: 'open' };
  const first = h.access.portalLogin(args), second = h.access.portalLogin({ ...args });
  await entered;
  assert.equal(h.calls.filter(c => c[0] === 'portal-session').length, 1);
  release({ ok: true, signedIn: true });
  const results = await Promise.all([first, second]);
  assert.equal(results[0].ok, true); assert.deepEqual(results[0], results[1]);
  assert.equal(h.prompts.length, 0);
});

test('public Studio calls wait for bridge-bound request creation and classify pre-send root failure', async t => {
  const h = harness(); t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const writeRequest = h.access.requestFile;
  h.access.requestFile = async json => { await Promise.resolve(); return writeRequest(json); };
  assert.equal((await h.access.read({ tenant: PERSONAL, operationId: ASSETS })).ok, true);
  assert.equal(typeof portalCalls(h.calls)[0][1], 'string');
  h.access.requestFile = async () => { throw new OdcError('BRIDGE_ROOT_UNAVAILABLE', 'No request file created'); };
  const result = await h.access.write({ tenant: PERSONAL, operationId: PATCH_ROLE, path: { key: ROLE1 },
    body: { name: 'A role' }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'BRIDGE_ROOT_UNAVAILABLE');
  assert.equal(result.receipt.state, 'not-sent');
  assert.equal(portalCalls(h.calls).length, 1);
});

test('deployed application configuration reads include a non-authorizing comparison without extra requests', async t => {
  const data = { revisionBaseline: 7, revisionDeployed: 7, settings: [], systemConfigurations: [], timers: [], integrations: [], libraries: [] };
  const h = harness({ portalCall: () => ({ ok: true, status: 200, contentType: 'application/json', body: data }) });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const result = await h.access.read({ tenant: PERSONAL, operationId: TIMER_CONFIGURATION,
    path: { environmentKey: ENV1, applicationKey: ASSET1 } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data, data);
  assert.equal(result.configurationComparison.state, 'equal-observed-values');
  assert.equal(result.configurationComparison.applySafetyProven, false);
  assert.equal(portalCalls(h.calls).length, 1);
  assert.equal(h.prompts.length, 0);
});

test('Wake contextual approval binds exact environment before reservation and audits consent', async t => {
  const h = wakeHarness(t);
  const proposal = path.join(h.dir, 'proposal.md'), context = path.join(h.dir, 'approval.json'), words = 'Pode sim, depois apague.';
  fs.writeFileSync(proposal, 'Run ProofTick once in ProofApp in the selected environment and delete the fixture.');
  const record = {schema:'ssam-authorization-context/1',decision:'approved',words,
    source:{kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'May I execute the attached fixture proposal?'},
    proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
    scope:[{lane:'odc',host:PERSONAL,operation:'timers.run',targets:['ProofApp','ProofTick'],environmentKey:ASSET1}]};
  fs.writeFileSync(context,JSON.stringify(record));
  const refused = await h.run({authorize:words,authorizationContext:context});
  assert.equal(refused.error.code,'AUTHORIZATION_CONTEXT_INVALID');
  assert.equal(refused.receipt,undefined); assert.equal(h.writes.length,0);
  record.scope[0].environmentKey=ENV1; fs.writeFileSync(context,JSON.stringify(record));
  const result = await h.run({authorize:words,authorizationContext:context});
  assert.equal(result.ok,true,JSON.stringify(result)); assert.equal(h.writes.length,1);
  const receipt=JSON.parse(fs.readFileSync(result.receipt.file));
  assert.equal(receipt.authorization.contextSha256,crypto.createHash('sha256').update(fs.readFileSync(context)).digest('hex'));
  assert.deepEqual(receipt.authorization.source,{threadId:record.source.threadId,messageId:record.source.messageId});
});

function wakeHarness(t, { uncertain = false, running = false, publicActive = 'True' } = {}) {
  const h = harness(); t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const timerKey = 'aaaaaaaa-6666-4666-8666-666666666666';
  const input = { inputParameters: { StageKey: ENV1, ApplicationKey: ASSET1, TimerKey: timerKey } };
  const reads = [], writes = [];
  h.access.read = async request => {
    reads.push(request);
    assert.equal(request.tenant, PERSONAL);
    if (request.operationId === TIMER_CONFIGURATION) return { ok: true, data: { key: null, name: null,
      revisionBaseline: 7, revisionDeployed: 7, timers: [{ key: timerKey, name: 'ProofTick',
        configs: [{ key: 'IsActive', dataType: 'Boolean', isSecret: false, value: publicActive, deployedValue: 'True' }] }] } };
    assert.equal(request.operationId, TIMER_APPLICATION_REVISION);
    return { ok: true, data: { assetKey: ASSET1, revision: 7, name: 'ProofApp' } };
  };
  h.access.resolvePortal = async host => ({ path: 'vault', host, user: 'dev@example.test', broker: {
    callScreenservice: async request => {
      if (request.write) {
        writes.push(request);
        const receipt = h.access.receipts.lookup(request.operationUuid);
        assert.equal(receipt.state, 'uncertain'); // persisted 'sending', before transport
        assert.equal(receipt.identity.target.timerKey, timerKey);
        if (uncertain) throw new OdcError('PORTAL_REQUEST_FAILED', 'Synthetic transport loss', { sent: true });
        return { data: {} };
      }
      reads.push(request);
      assert.equal(request.input.screenVariables.appid, ASSET1);
      assert.equal(request.input.screenVariables.stageid, ENV1);
      assert.equal(request.input.screenVariables.id, timerKey);
      if (request.operationId === 'timers.info') return { data: { NotFound: false, TimerInfo: { HasPendingConfigurations: false,
        Timer: { Key: timerKey, Name: 'ProofTick', Configs: { IsActive: { Current: true, Deployed: true } } } } } };
      assert.equal(request.operationId, 'timers.currentRun');
      return { data: { TimerRunInformation: { isRunning: running, isPendingRun: false, lastRunStartedOn: '1900-01-01T00:00:00' } } };
    },
  }});
  return { ...h, input, reads, writes, run: args => h.access.portalWrite({ tenant: PERSONAL, operationId: 'timers.run', input,
    authorize: 'Execute ProofTick in ProofApp once', operationUuid: uuid(), ...args }) };
}

test('Wake reserves before send, stays accepted without execution proof and never replays a UUID', async t => {
  const h = wakeHarness(t), operationUuid = uuid();
  const result = await h.run({ operationUuid });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.receipt.state, 'accepted');
  assert.equal(result.before.revision, 7); assert.equal(result.executionConfirmed, false); assert.equal(result.completionConfirmed, false);
  assert.equal(result.continuation.arguments.operationId, 'timers.currentRun');
  assert.equal(h.writes.length, 1); assert.equal(h.reads.length, 4);
  const repeat = await h.run({ operationUuid });
  assert.equal(repeat.existingReceipt, true); assert.equal(h.writes.length, 1); assert.equal(h.reads.length, 4);
});

test('Wake refuses missing named authorization and busy state before reservation', async t => {
  const h = wakeHarness(t);
  for (const authorize of ['', 'Execute ProofTick in ProofApp2', 'Execute ProofTick2 in ProofApp']) {
    const result = await h.run({ authorize });
    assert.equal(result.ok, false); assert.equal(result.receipt, undefined); assert.equal(result.sent, false);
  }
  assert.equal(h.writes.length, 0);
  const busy = wakeHarness(t, { running: true });
  const result = await busy.run(); assert.equal(result.error.code, 'TIMER_ALREADY_RUNNING'); assert.equal(busy.writes.length, 0);
});

test('uncertain Wake locks the real timer across UUID, casing and caller-target changes', async t => {
  const h = wakeHarness(t, { uncertain: true });
  const first = await h.run(); assert.equal(first.receipt.state, 'uncertain');
  const input = structuredClone(h.input); input.inputParameters.TimerKey = input.inputParameters.TimerKey.toUpperCase();
  const next = await h.run({ input, target: { arbitrary: 'different target' } });
  assert.equal(next.error.code, 'TARGET_PENDING'); assert.equal(h.writes.length, 1);
});

test('Wake refuses a public inactive flag despite a positive Portal flag without reserving or sending', async t => {
  const h = wakeHarness(t, { publicActive: 'False' });
  const result = await h.run();
  assert.equal(result.error.code, 'TIMER_NOT_ACTIVE'); assert.equal(result.sent, false);
  assert.equal(result.receipt, undefined); assert.equal(h.writes.length, 0);
});

test('a local receipt settlement failure after Wake cannot be reported as not sent', async t => {
  const h = wakeHarness(t), operationUuid = uuid();
  h.access.receipts.settle = () => { throw new Error('Synthetic disk failure'); };
  const result = await h.run({ operationUuid });
  assert.equal(result.ok, false); assert.equal(result.sent, undefined); assert.equal(result.receipt.state, 'uncertain');
  const repeat = await h.run({ operationUuid });
  assert.equal(repeat.existingReceipt, true); assert.equal(repeat.receipt.state, 'uncertain'); assert.equal(h.writes.length, 1);
});

test('a failing operation log after Wake preserves its durable accepted receipt', async t => {
  const h = wakeHarness(t);
  h.access.journal = () => { throw new Error('Synthetic log failure'); };
  const result = await h.run();
  assert.equal(result.ok, false); assert.equal(result.sent, undefined); assert.equal(result.receipt.state, 'accepted');
  assert.equal(h.writes.length, 1); assert.match(result.reconcile, /never resend/);
});

test('a compatible Portal profile authenticates in one intention and status/close use that same broker', async t => {
  const selected = { ok: true, target: 'synthetic-profile', principal: 'dev@example.test' };
  let logins = 0, cleared = 0, selections = 0;
  const h = harness({ profiles: { resolve: async context => { selections++; assert.equal(context.principal, selected.principal); return selected; } },
    portalSession: () => ({ ok: true, signedIn: false }), brokerState: { available: true,
      authenticate: async () => { logins++; h.broker.authenticated = true; return { ok: true }; },
      jar: { removeAllCookies: async () => { cleared++; } } } });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const result = await h.access.portalLogin({ tenant: PERSONAL });
  assert.equal(result.ok, true); assert.equal(result.auth.user, selected.principal); assert.equal(logins, 1);
  assert.equal((await h.access.portalLogin({ tenant: PERSONAL, action: 'status' })).session.authenticated, true);
  assert.equal((await h.access.portalLogin({ tenant: PERSONAL, action: 'close' })).closed, true);
  assert.equal(h.broker.authenticated, false); assert.equal(cleared, 1); assert.equal(selections, 1);
  assert.equal(h.prompts.length, 0);
});

test('an existing Studio Portal session avoids credential selection entirely', async t => {
  const h = harness({ profiles: { resolve: async () => assert.fail('SSO first') } });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  assert.equal((await h.access.resolvePortal(PERSONAL)).path, 'studio-http');
});

test('private native credential transport requires advertised capability and matching authenticated principals', async t => {
  for (const [capabilities, principal, expected] of [
    [['portal-private-call:headless:secretRefs'], 'dev@example.test', true],
    [[], 'dev@example.test', false],
    [['portal-private-call:headless:secretRefs'], 'other@example.test', false],
  ]) {
    const h = harness({ capabilities,
      profiles: { resolve: async (_scope, options) => { assert.equal(options.interactive, false); return { ok: true, principal, target: 'synthetic' }; } },
      brokerState: { available: true, authenticated: true } });
    t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
    const result = await h.access.resolvePortal(PERSONAL);
    assert.equal(typeof result.privateSender === 'function', expected);
    assert.equal(h.calls.some(args => args[0] === 'portal-session'), false);
    assert.equal(h.prompts.length, 0);
    assert.equal(typeof (await h.access.resolvePortal(PERSONAL, 'portal-credential')).privateSender, 'undefined');
  }
});

test('rejected Portal profile requires private selection without a second login or legacy bootstrap command', async t => {
  let logins = 0; const choices = [];
  const h = harness({ portalSession: () => ({ ok: true, signedIn: false }),
    profiles: { resolve: async (_context, options) => { choices.push(options); return { ok: true, target: 'synthetic', principal: 'dev@example.test' }; } },
    brokerState: { available: true, authenticate: async () => { logins++; return { ok: false, error: { code: 'PORTAL_LOGIN_REJECTED', operatorAction: 'legacy bootstrap' } }; } } });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const result = await h.access.resolvePortal(PERSONAL);
  assert.equal(result.code, 'PORTAL_LOGIN_REJECTED'); assert.equal(logins, 1); assert.equal(choices.at(-1).force, true);
  assert.equal(JSON.stringify(result).includes('legacy bootstrap'), false);
  assert.equal(result.continuation.tool, 'odc_portal_login');
});

test('headless Portal profile selection configures only metadata and preserves the Studio context',async t=>{
 const seen=[];const h=harness({profiles:{select:async(context,input)=>{seen.push({context,input});return {ok:true,windowCreated:false};}},
  brokerState:{authenticate:async()=>assert.fail('selection must not authenticate')},portalSession:()=>assert.fail('selection must not open a window')});
 t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const profile={target:'private-reference',principal:'dev@example.test'},authorize=`Use dev@example.test on ${PERSONAL}`;
 const r=await h.access.portalLogin({tenant:PERSONAL,auth:'portal-credential',action:'select-profile',profile,authorize});
 assert.equal(r.ok,true);assert.equal(r.configurationOnly,true);assert.equal(r.authenticationPerformed,false);
 assert.equal(seen.length,1);assert.equal(seen[0].context.host,PERSONAL);assert.deepEqual(seen[0].input,{...profile,authorize});
 assert.equal((await h.access.portalLogin({tenant:PERSONAL,auth:'studio',action:'select-profile',profile,authorize})).ok,false);
 assert.equal((await h.access.portalLogin({tenant:PERSONAL,auth:'portal-credential',action:'open',profile,authorize})).ok,false);
 assert.equal(seen.length,1);
});

test('a legacy Portal window is never rechecked, opened or used as authentication', async t => {
  const h = harness({ capabilities: ['portal-session:recheck'],
    profiles: { resolve: async (_scope, options) => { assert.equal(options.interactive, false); return { ok: false, code: 'CREDENTIAL_SELECTION_REQUIRED' }; } },
    portalSession: () => assert.fail('legacy UI must not be called') });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  assert.equal((await h.access.resolvePortal(PERSONAL)).code, 'CREDENTIAL_SELECTION_REQUIRED');
  assert.equal((await h.access.portalLogin({ tenant: PERSONAL, auth: 'studio' })).code, 'HEADLESS_AUTH_UNAVAILABLE');
  assert.equal(h.calls.some(c => c[0] === 'portal-session'), false);
});

test('missing private CSRF context settles not-sent and never claims a resolved database secret', async t => {
  const h = harness(); t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  h.access.resolvePortal = async () => ({ path: 'vault', host: PERSONAL, privateSender: () => assert.fail('native send must not start'),
    broker: { callScreenservice: async () => { throw new OdcError('HEADLESS_AUTH_UNAVAILABLE', 'Private CSRF context unavailable before native send.'); } } });
  const result = await h.access.portalWrite({ tenant: PERSONAL, operationId: 'connections.relationalTest', input: { inputParameters: { Password: '' } },
    authorize: WORDS, operationUuid: uuid() }, { secretRefs: [{ pointer: '/inputParameters/Password', target: `SSAM/ODC3/${PERSONAL}/DB/Fixture`, field: 'password' }] });
  assert.equal(result.receipt.state, 'not-sent'); assert.equal(result.secretRefs.resolutionConfirmed, false);
});

test('one log intention follows bounded server pagination while preserving application and time filters', async t => {
  const requests = [];
  const h = harness(); t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  const broker = { target: 'odc3', origin: 'https://' + PERSONAL, readScreenservice: async request => {
    requests.push(request); const offset = Number(request.screenVariables.Page.Offset);
    return { target: 'odc3', origin: 'https://' + PERSONAL, body: { data: {
      LogsList: { List: [{ LogId: 'log-' + offset, ApplicationKey: 'app-x', Severity: 'Error', Time: '2026-09-14T12:30:00Z', Message: 'synthetic' }] },
      LogSearch_Page: { Limit: '1', Offset: String(offset), NextPageOffset: String(offset + 1), TotalPages: '8', TotalResults: '8' }
    } } };
  } };
  h.access.resolvePortal = async () => ({ path: 'studio-http', host: PERSONAL, broker });
  const input = { environmentKey: 'stage-x', applicationKey: 'app-x', since: '2026-09-14T12:00:00Z', until: '2026-09-14T13:00:00Z', limit: 2 };
  const result = await h.access.portalRead({ tenant: PERSONAL, operationId: 'monitoring.errors', input, maxPages: 2 });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.pages, 2); assert.equal(result.count, 2); assert.equal(result.complete, false);
  assert.equal(result.continuation.arguments.input.offset, 2);
  assert.equal(requests.length, 2);
  for (const request of requests) { assert.equal(request.clientVariables.ApplicationId, 'app-x'); assert.equal(request.clientVariables.StageId, 'stage-x'); }
});

test('the six read-only POST searches are exact IDs; effect classes cover every operation', () => {
  assert.equal(SEARCH_POSTS.size, 6);
  for (const id of SEARCH_POSTS) { const op = catalog.operations.get(id); assert.equal(op.method, 'POST', id); assert.equal(op.readOnly, false); assert.equal(readable(op), true); }
  const counts = {};
  for (const op of catalog.operations.values()) counts[effectOf(op)] = (counts[effectOf(op)] ?? 0) + 1;
  assert.deepEqual(counts, { read: 98, 'search-post': 6, job: 5, 'mutation-job': 6, mutation: 36, destructive: 12 });
  assert.equal(effectOf(catalog.operations.get(USER_BULK_CREATE)), 'mutation-job');
  assert.equal(effectOf(catalog.operations.get('deployments-api-v1:post:/deployment-operations'), { operation: 'Undeploy' }), 'destructive');
});

test('resolver: the Studio session on the tenant answers first; the vault and the prompt are not touched', async () => {
  const h = harness({ apiClient: true });
  const out = await h.access.read({ operationId: ASSETS, query: { limit: 1 } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.auth, { path: 'studio', host: PERSONAL, user: 'dev@example.test' });
  const call = portalCalls(h.calls)[0];
  assert.deepEqual(call.slice(2), ['--tenant', PERSONAL]);
  const request = h.requests.get(call[1]);
  assert.equal(request.basePath, '/api/asset-repository/v1'); assert.equal(request.path, '/assets'); assert.equal(request.method, 'GET');
  assert.equal(request.query, 'limit=1'); assert.equal(request.write, false); assert.equal(request.operationUuid, undefined);
  assert.equal(h.vaultCalls.length, 0); assert.equal(h.prompts.length, 0);
  assert.match(h.journal[0].note, /\[personal-test\.outsystems\.dev\] auth=studio status=200/);
});

test('resolver: a Studio open without a session on the tenant refuses (no prompt) and says whether the vault can serve', async () => {
  const h = harness({ apiClient: true });
  const out = await h.access.read({ tenant: CORPORATE, operationId: ASSETS });
  assert.equal(out.ok, false); assert.equal(out.code, 'STUDIO_NOT_SIGNED_IN'); assert.equal(out.vaultAvailable, true);
  assert.doesNotMatch(out.error.message, /user signs in|sign in to|open it|then repeat/i);
  assert.match(out.continuation, /auth:"api-client"/);
  assert.equal(portalCalls(h.calls).length, 0); assert.equal(h.prompts.length, 0); assert.equal(h.vaultCalls.length, 0);
  const viaVault = await h.access.read({ tenant: CORPORATE, auth: 'api-client', operationId: ASSETS });
  assert.equal(viaVault.ok, true); assert.equal(viaVault.auth.path, 'vault'); assert.equal(h.vaultCalls[0].host, CORPORATE);
  const outdated = harness({ connected: false });
  assert.equal((await outdated.access.read({ tenant: PERSONAL, operationId: ASSETS })).code, 'STUDIO_NOT_CONNECTED');
  assert.equal(outdated.prompts.length, 0);
});

test('missing Studio authentication reports a headless limitation for public and Portal calls', async t => {
  for (const running of [true, false]) {
    const h = harness({ running, sessions: [], portalAccount: true, apiClient: true });
    t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
    for (const result of [
      await h.access.read({ tenant: CORPORATE, auth: 'studio', operationId: ASSETS }),
      await h.access.portalLogin({ tenant: CORPORATE, auth: 'studio', action: 'status' }),
    ]) {
      assert.equal(result.ok, false);
      assert.match(result.error.message, /headless/i);
      assert.doesNotMatch(result.error.message, /user signs in|sign in to|open it|then repeat/i);
    }
    assert.equal(portalCalls(h.calls).length, 0);
    assert.equal(h.calls.some(args => args[0] === 'portal-session'), false);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.vaultCalls.length, 0);
  }
});

test('resolver: without any Studio, the vault API Client; without it, one private prompt (never two at once)', async () => {
  const withVault = harness({ running: false, apiClient: true });
  const out = await withVault.access.read({ tenant: PERSONAL, operationId: ASSETS });
  assert.equal(out.auth.path, 'vault'); assert.equal(withVault.calls.length, 0);
  const none = harness({ running: false });
  const first = await none.access.read({ tenant: PERSONAL, operationId: ASSETS });
  assert.equal(first.code, 'CREDENTIAL_PROMPT_OPENED'); assert.deepEqual(first.auth, { path: 'prompt', host: PERSONAL });
  assert.deepEqual(none.prompts, [['api-client', PERSONAL]]);
  assert.equal((await none.access.read({ tenant: PERSONAL, operationId: ASSETS })).code, 'CREDENTIAL_PROMPT_PENDING');
  assert.equal(none.prompts.length, 1);
  // api-client forced while the Studio holds that tenant: no prompt, the Studio is the path.
  const forced = harness();
  assert.equal((await forced.access.read({ tenant: PERSONAL, auth: 'api-client', operationId: ASSETS })).code, 'AUTH_NOT_CONFIGURED');
  assert.equal(forced.prompts.length, 0);
});

test('tenant per call: several Studio sessions need the tenant; each call carries its own', async () => {
  const h = harness({ sessions: [{ host: PERSONAL, loggedIn: true, user: 'a' }, { host: OTHER, loggedIn: true, user: 'b' }] });
  assert.equal((await h.access.read({ operationId: ASSETS })).error.code, 'TENANT_REQUIRED');
  const out = await h.access.read({ tenant: 'https://' + OTHER.toUpperCase() + '/', operationId: ASSETS });
  assert.equal(out.tenant, OTHER); assert.equal(out.auth.user, 'b');
  assert.deepEqual(portalCalls(h.calls).at(-1).slice(2), ['--tenant', OTHER]);
  assert.equal((await h.access.read({ tenant: 'evil.example/../x', operationId: ASSETS })).error.code, 'INPUT_INVALID');
});

test('odc_read sends the read-only POST searches and refuses every mutation before contacting anything', async () => {
  const h = harness();
  for (const id of SEARCH_POSTS) {
    const op = catalog.operations.get(id);
    const search = await h.access.read({ operationId: id, ...sampleRequest(catalog.apis.get(op.apiId), op) });
    assert.equal(search.ok, true, id + ' ' + JSON.stringify(search.error));
    const sent = h.requests.get(portalCalls(h.calls).at(-1)[1]);
    assert.equal(sent.method, 'POST'); assert.equal(sent.write, false); assert.equal(sent.operationId, id);
  }
  const before = portalCalls(h.calls).length;
  for (const op of [...catalog.operations.values()].filter(o => !readable(o))) {
    const blocked = await h.access.read({ operationId: op.id, ...sampleRequest(catalog.apis.get(op.apiId), op) });
    assert.equal(blocked.error.code, 'WRITE_BLOCKED', op.id);
  }
  assert.equal(portalCalls(h.calls).length, before);
});

test('write guard: words, UUID, read-only and corporate tenants are checked before any send or reservation', async () => {
  const h = harness({ sessions: [{ host: PERSONAL, loggedIn: true }, { host: CORPORATE, loggedIn: true }, { host: CLIENT, loggedIn: true }] });
  const write = extra => h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, operationUuid: uuid(), ...extra });
  assert.equal((await write({ tenant: PERSONAL })).error.code, 'AUTHORIZATION_REQUIRED');
  assert.equal((await write({ tenant: PERSONAL, authorize: WORDS, operationUuid: 'not-a-uuid' })).error.code, 'INPUT_INVALID');
  assert.equal((await write({ tenant: CLIENT, authorize: 'client tenant: change it' })).error.code, 'TENANT_READ_ONLY');
  assert.equal((await write({ tenant: CORPORATE, authorize: 'change the role please' })).error.code, 'CORPORATE_TENANT_GUARD');
  assert.equal((await write({ tenant: CORPORATE, authorize: 'change the role please', confirmTenant: CORPORATE })).error.code, 'CORPORATE_TENANT_GUARD');
  assert.equal((await write({ tenant: 'unknown-host.outsystems.dev', authorize: 'change the role please' })).error.code, 'CORPORATE_TENANT_GUARD');
  assert.equal(portalCalls(h.calls).length, 0);
  assert.equal(fs.existsSync(path.join(h.dir, 'receipts')) ? fs.readdirSync(path.join(h.dir, 'receipts')).length : 0, 0);
  const allowed = await write({ tenant: CORPORATE, authorize: 'yes, on corp change that role', confirmTenant: CORPORATE });
  assert.equal(allowed.ok, true, JSON.stringify(allowed)); assert.equal(portalCalls(h.calls).length, 1);
  assert.throws(() => guardTenant({ host: CORPORATE, class: 'corporate' }, 'corp yes', undefined), { code: 'CORPORATE_TENANT_GUARD' });
  assert.throws(() => guardTarget('delete it', ['Quotes', 'k-1']), { code: 'DESTRUCTIVE_TARGET_NOT_NAMED' });
});

test('a destructive write needs words that name the target, read before the send', async () => {
  const h = harness({ portalCall: request => request.method === 'GET'
    ? { ok: true, status: 200, contentType: 'application/json', body: { assetKey: 'a-1', name: 'QuotesPortal' } }
    : { ok: true, status: 204 } });
  const refused = await h.access.write({ operationId: DELETE_ASSET, path: { assetKey: 'a-1' }, authorize: 'yes delete that app now', operationUuid: uuid() });
  assert.equal(refused.error.code, 'DESTRUCTIVE_TARGET_NOT_NAMED'); assert.deepEqual(refused.error.candidates, ['QuotesPortal', 'a-1']);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).method === 'DELETE').length, 0);
  const done = await h.access.write({ operationId: DELETE_ASSET, path: { assetKey: 'a-1' }, authorize: 'yes delete QuotesPortal now', operationUuid: uuid() });
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.effect, 'destructive');
});

test('journal and receipt keep only the sha256 of the words; the request names the receipt; one UUID is one send', async () => {
  const h = harness();
  const operationUuid = uuid();
  const first = await h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, authorize: WORDS, operationUuid });
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.receipt.state, 'accepted');
  const sent = h.requests.get(portalCalls(h.calls)[0][1]);
  const wordsSha256 = crypto.createHash('sha256').update(WORDS).digest('hex');
  assert.equal(sent.write, true); assert.equal(sent.operationUuid, operationUuid); assert.equal(sent.authorizeSha256, wordsSha256);
  const receipt = fs.readFileSync(first.receipt.file, 'utf8');
  assert.match(receipt, new RegExp(wordsSha256)); assert.doesNotMatch(receipt, /do it on the personal/);
  assert.doesNotMatch(JSON.stringify(h.journal), /do it on the personal/);
  assert.match(h.journal.at(-1).note, /words=sha256:[0-9a-f]{12} receipt=/);
  const again = await h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, authorize: WORDS, operationUuid });
  assert.equal(again.existingReceipt, true); assert.equal(again.replayed, false);
  assert.equal(portalCalls(h.calls).length, 1);
  const otherTarget = await h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE2 }, body: {}, authorize: WORDS, operationUuid });
  assert.equal(otherTarget.error.code, 'OPERATION_UUID_REUSED');
});

test('an uncertain write is never resent: it locks its target until a read reconciles it', async () => {
  let mode = 'uncertain';
  const h = harness({ portalCall: request => request.method === 'GET' ? { ok: true, status: 200, body: { key: ROLE1, name: 'Ops' } }
    : mode === 'uncertain' ? { ok: false, code: 'UNCERTAIN' } : { ok: true, status: 200, body: {} } });
  const operationUuid = uuid();
  const out = await h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, authorize: WORDS, operationUuid });
  assert.equal(out.ok, false); assert.equal(out.receipt.state, 'uncertain'); assert.match(out.reconcile, /Never resend/);
  mode = 'ok';
  const blocked = await h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, authorize: WORDS, operationUuid: uuid() });
  assert.equal(blocked.error.code, 'TARGET_PENDING'); assert.equal(blocked.error.pendingOperationUuid, operationUuid);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).write).length, 1);
  const noWords = await h.access.receipt({ operationUuid, reconcile: { state: 'confirmed', read: { operationId: 'user-access-management-api-v1:get:/organization-roles/{key}', path: { key: ROLE1 } } } });
  assert.equal(noWords.error.code, 'AUTHORIZATION_REQUIRED');
  const settled = await h.access.receipt({ operationUuid, reconcile: { state: 'confirmed', authorize: 'the role shows the change, confirmed',
    read: { operationId: 'user-access-management-api-v1:get:/organization-roles/{key}', path: { key: ROLE1 } } } });
  assert.equal(settled.ok, true, JSON.stringify(settled)); assert.equal(settled.receipt.state, 'confirmed');
  const next = await h.access.write({ operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, authorize: WORDS, operationUuid: uuid() });
  assert.equal(next.ok, true);
  // A 4xx means the server refused it: settled, target free, and nothing resent.
  const rejected = harness({ portalCall: () => ({ ok: true, status: 409, body: { title: 'conflict' } }) });
  const r = await rejected.access.write({ operationId: PATCH_ROLE, path: { key: ROLE2 }, body: {}, authorize: WORDS, operationUuid: uuid() });
  assert.equal(r.receipt.state, 'rejected'); assert.equal(portalCalls(rejected.calls).length, 1);
});

test('bridge v32 answers: UNCERTAIN wins over a status, a busy gate or a refusal was never sent, a 4xx write is rejected', async () => {
  const write = async answer => {
    const h = harness({ sessions: [{ host: OTHER, loggedIn: true }], portalCall: () => answer });
    const out = await h.access.write({ tenant: OTHER, operationId: PATCH_ROLE, path: { key: ROLE1 }, body: {}, authorize: WORDS, operationUuid: uuid() });
    const sent = h.requests.get(portalCalls(h.calls)[0][1]);
    return { out, sent };
  };
  const { out: uncertain, sent } = await write({ ok: false, code: 'UNCERTAIN', reason: 'HOST_MISMATCH', status: 200 });
  assert.equal(uncertain.ok, false); assert.equal(uncertain.receipt.state, 'uncertain'); assert.equal(uncertain.error.reason, 'HOST_MISMATCH');
  // Writes to a host other than the default carry the confirmation the bridge asks for, after the facade guard.
  assert.equal(sent.confirmTenant, OTHER); assert.equal(sent.write, true);
  assert.equal((await write({ ok: false, outcome: 'gate_refused', gate: 'studio_busy' })).out.receipt.state, 'not-sent');
  assert.equal((await write({ ok: false, code: 'NOT_ALLOWED', gate: 'retry_refused' })).out.receipt.state, 'not-sent');
  const rejected = (await write({ ok: false, code: 'REMOTE_ERROR', status: 409, body: { title: 'Conflict' } })).out;
  assert.equal(rejected.receipt.state, 'rejected'); assert.equal(rejected.status, 409);
  const big = harness({ portalCall: () => ({ ok: true, status: 200, contentType: 'application/json', bodyFile: 'C:\\x\\journal\\portal\\downloads\\b.json', bytes: 5000000, sha256: 'ab' }) });
  assert.equal((await big.access.read({ operationId: ASSETS })).data.file, 'C:\\x\\journal\\portal\\downloads\\b.json');
  // The first v32 window does not resolve secretRefs: nothing is sent, and the answer says to attach the current v32
  // (never a path that would read the secret in this process).
  const refusing = gate => harness({ portalAccount: true, portalSession: (args, request) => args[1] !== 'fetch' ? { ok: true, host: args.at(-1), signedIn: true }
    : request.secretRefs ? { ok: false, code: 'BAD_REQUEST', gate }
    : request.path.endsWith('DataActionGetFilter_Stages') ? { ok: true, status: 200, body: { data: { EnvironmentList: [{ Key: 'dev', Name: 'Development', Purpose: 'Development' }] } } } : { ok: true, status: 200, body: { data: {} } } });
  for (const [gate, hint] of [['secret_refs_unsupported', /native headless secretRefs/], ['secret_ref_missing', /Provision the entry separately/]]) {
    const noRefs = refusing(gate);
    noRefs.access.studioBroker(PERSONAL).metadata.resolve = async (module, view, action) => ({ moduleVersion: 'm', apiVersion: 'a', action });
    const tested = await noRefs.access.externalDbConnection({ action: 'test', name: 'SalesDb', providerId: 'mssql', server: 'db.test', port: 1433, database: 'sales', authorize: WORDS, operationUuid: uuid() });
    assert.equal(tested.error.code, 'BAD_REQUEST'); assert.equal(tested.receipt.state, 'not-sent'); assert.match(tested.hint, hint);
    assert.equal(tested.fallback, undefined); assert.doesNotMatch(tested.hint, /portal-credential/);
  }
});

test('answers are redacted: gateway tokens, passwords and bearer strings never come back', async () => {
  const h = harness({ portalCall: () => ({ ok: true, status: 200, contentType: 'application/json',
    body: { authToken: 'SECRET-GATEWAY', nested: { password: 'SECRET-PW', note: 'Bearer SECRET.JWT.VALUE' }, url: 'https://x.test/f?signature=SECRET-SIG' } }) });
  const out = await h.access.read({ operationId: ASSETS });
  assert.doesNotMatch(JSON.stringify(out), /SECRET-/);
  const binary = harness({ portalCall: () => ({ ok: true, status: 200, contentType: 'application/zip', bodyBase64: Buffer.from('PK-binary').toString('base64') }) });
  const zipped = await binary.access.read({ operationId: ASSETS });
  assert.equal(zipped.data.contentOmitted, true); assert.equal(zipped.data.byteLength, 9);
  const rejected = harness({ portalCall: () => ({ ok: true, status: 401 }) });
  assert.equal((await rejected.access.read({ operationId: ASSETS })).error.code, 'STUDIO_SESSION_REJECTED');
  const other = harness({ portalCall: () => ({ ok: true, status: 200, host: 'evil.outsystems.dev', body: {} }) });
  assert.equal((await other.access.read({ operationId: ASSETS })).error.code, 'HOST_MISMATCH');
});

test('operation status polls the read until terminal and never repeats the start; deploy follows its own key', async () => {
  const states = ['Running', 'Running', 'Finished'];
  const h = harness({ portalCall: request => request.method === 'POST' ? { ok: true, status: 202, body: { key: DEP1, status: 'Running' } }
    : request.path.endsWith('/messages') ? { ok: true, status: 200, body: [{ message: 'done' }] } : { ok: true, status: 200, body: { key: DEP1, status: states.shift() } } });
  const out = await h.access.deploy({ assetKey: ASSET1, environmentKey: ENV1, revision: 3, authorize: WORDS, operationUuid: uuid(), waitSeconds: 60 });
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.deployment.status, 'Finished', JSON.stringify(out.deployment)); assert.equal(out.deployment.terminal, true);
  assert.equal(out.deployment.reads, 3); assert.deepEqual(out.deployment.messages, [{ message: 'done' }]);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).method === 'POST').length, 1);
  const pending = harness({ portalCall: () => ({ ok: true, status: 200, body: { status: 'Running' } }) });
  const once = await pending.access.operationStatus({ kind: 'publish', operationKey: DEP1 });
  assert.equal(once.terminal, false); assert.equal(once.continuation.tool, 'odc_operation_status');
});

test('a deployment that ends FinishedWithError is refused with every message and the fix; the POST is not repeated', async () => {
  const messages = { page: { total: 2 }, results: [
    { timestamp: '2026-10-04T15:00:01Z', severity: 'Info', message: 'Deploying GameStore to QA', additionalInfo: { stepId: 'Deploy', assetKey: ASSET1 } },
    { timestamp: '2026-10-04T15:00:09Z', type: 'OS-DPL-1', severity: 'Error', message: "Setting 'ApiUrl' has no value in stage QA", additionalInfo: { stepId: 'ApplyConfigurations', assetKey: ASSET1 } }] };
  const h = harness({ portalCall: request => request.method === 'POST' ? { ok: true, status: 202, body: { key: DEP1, status: 'Running' } }
    : request.path.endsWith('/messages') ? { ok: true, status: 200, body: messages } : { ok: true, status: 200, body: { key: DEP1, status: 'FinishedWithError' } } });
  const out = await h.access.deploy({ assetKey: ASSET1, environmentKey: ENV1, revision: 3, authorize: WORDS, operationUuid: uuid(), waitSeconds: 60 });
  assert.equal(out.ok, false, JSON.stringify(out)); assert.equal(out.code, 'DEPLOYMENT_FAILED'); assert.equal(out.sent, true);
  assert.match(out.error, /FinishedWithError: 1 error\(s\), 0 warning\(s\); first error: Setting 'ApiUrl'/);
  assert.deepEqual(out.deployment.log.messages[1], { type: 'error', text: "Setting 'ApiUrl' has no value in stage QA", stage: 'deploy',
    element: { name: 'ApiUrl', key: null, kind: null, source: 'text' }, code: 'OS-DPL-1', at: '2026-10-04T15:00:09Z', stepId: 'ApplyConfigurations', assetKey: ASSET1 });
  assert.equal(out.continuation.tool, 'ssam_discover');
  assert.match(out.continuation.why, /deploy again/);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).method === 'POST').length, 1);
  // A publish or build read with messages answers the same log shape.
  const pub = harness({ portalCall: request => request.path.endsWith('/messages') ? { ok: true, status: 200, body: messages } : { ok: true, status: 200, body: { key: DEP1, status: 'Finished' } } });
  const read = await pub.access.operationStatus({ kind: 'publish', operationKey: DEP1, messages: true });
  assert.equal(read.failed, false); assert.deepEqual(read.log.counts, { errors: 1, warnings: 0, infos: 1 }); assert.equal(read.continuation, undefined);
});

test('configurations set by name resolves keys, refuses secret settings and reads the value back', async () => {
  let value = 'https://old.test';
  const h = harness({ portalCall: request => request.method === 'PATCH' ? (value = request.body.settings[0].value, { ok: true, status: 200, body: {} })
    : { ok: true, status: 200, body: { key: 'app-1', settings: [{ key: 's-1', name: 'ServiceUrl', value }, { key: 's-2', name: 'ApiPassword', isSecret: true, value: 'x' }] } } });
  const secret = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', settings: { ApiPassword: 'nope' }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(secret.error.code, 'SECRET_IN_ARGUMENTS');
  const out = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', settings: { ServiceUrl: 'https://new.test' }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.readBack.verified, true);
  const patch = [...h.requests.values()].find(r => r.method === 'PATCH');
  assert.deepEqual(patch.body.settings, [{ key: 's-1', value: 'https://new.test' }]);
  assert.equal(JSON.parse(fs.readFileSync(out.receipt.file, 'utf8')).state, 'confirmed');
  const got = await h.access.configurations({ environmentKey: 'e-1', assetKey: 'app-1' });
  assert.doesNotMatch(JSON.stringify(got), /"value":"x"/);
});

test('setting reset confirms inherited defaults, never a remaining override or missing origin', async () => {
  for (const origin of ['ApplicationLevelDefault','EnvironmentLevelDefault','LibraryLevelDefault','ApplicationLevelOverride',undefined,'UnknownDefault']) for (const observedValue of ['Inherited greeting', null]) {
    let changed = false;
    const h = harness({ portalCall: request => request.method === 'PATCH'
      ? (changed = true, { ok: true, status: 204 })
      : { ok: true, status: 200, body: { key: 'app-1', settings: [{ key: 's-1', name: 'Greeting', isSecret: false,
        value: changed ? observedValue : 'Custom greeting', valueOrigin: changed ? origin : 'ApplicationLevelOverride' }] } } });
    const out = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1',
      patch: { settings: [{ key: 's-1', value: null }] }, authorize: WORDS, operationUuid: uuid() });
    const restored = ['ApplicationLevelDefault','EnvironmentLevelDefault','LibraryLevelDefault'].includes(origin);
    assert.equal(out.readBack.verified, restored, String(origin));
    assert.equal(out.readBack.settings[0].origin, origin ?? null);
    assert.equal(out.receipt.state, restored ? 'confirmed' : 'accepted');
    assert.equal(JSON.parse(fs.readFileSync(out.receipt.file, 'utf8')).state, out.receipt.state);
    const patch = [...h.requests.values()].find(r => r.method === 'PATCH');
    assert.equal(patch.body.settings[0].value, null);
  }
});

test('secret reset verifies only default origin metadata, never secret content',async t=>{
 for(const origin of ['ApplicationLevelDefault','EnvironmentLevelDefault','LibraryLevelDefault','ApplicationLevelOverride',undefined,'UnknownDefault']){
  let changed=false;
  const h=harness({portalCall:request=>request.method==='PATCH'
   ?(changed=true,{ok:true,status:204})
   :{ok:true,status:200,body:{key:'app-1',settings:[{key:'s-2',name:'ApiPassword',isSecret:true,value:'synthetic-private-marker',valueOrigin:changed?origin:'ApplicationLevelOverride'}]}}});
  t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
  const out=await h.access.configurations({action:'set',environmentKey:'e-1',assetKey:'app-1',patch:{settings:[{key:'s-2',value:null}]},authorize:WORDS,operationUuid:uuid()});
  const restored=['ApplicationLevelDefault','EnvironmentLevelDefault','LibraryLevelDefault'].includes(origin);
  assert.equal(out.readBack.verified,restored);
  assert.equal(out.readBack.settings[0].valueVerified,false);
  assert.equal(out.readBack.settings[0].resetMetadataVerified,restored);
  assert.equal(out.receipt.state,restored?'confirmed':'accepted');
  assert.doesNotMatch(JSON.stringify(out),/synthetic-private-marker/);
  assert.doesNotMatch(fs.readFileSync(out.receipt.file,'utf8'),/synthetic-private-marker/);
 }
});

test('nested vault transport sends empty placeholder refs and reset verifies metadata only',async t=>{
 let origin='LibraryLevelDefault';
 const data=()=>({key:'app-1',libraries:[{key:'lib',revision:2,revisionBaseline:2,settings:[],systemConfigurations:[],integrations:[{key:'api',pluginType:'RESTConsume',configs:[{key:'Password',isSecret:true,value:'********',valueOrigin:origin}]}]}]});
 const h=harness({portalAccount:()=>true,portalCall:request=>request.method==='PATCH'?(origin=request.body.libraries[0].integrations[0].configs[0].value===null?'LibraryLevelDefault':'ApplicationLevelOverride',{ok:true,status:204}):{ok:true,status:200,body:data()}});
 t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const out=await h.access.configurations({action:'set',environmentKey:'e-1',assetKey:'app-1',vaultConfigurations:[{libraryKey:'lib',integrationKey:'api',settingKey:'Password',entry:'ProofSecret'}],authorize:WORDS,operationUuid:uuid()});
 assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.receipt.state,'accepted');assert.equal(out.readBack.verified,false);
 assert.equal(out.readBack.vaultConfigurations[0].valueVerified,false);assert.equal(out.readBack.vaultConfigurations[0].present,true);
 const patch=[...h.requests.values()].find(r=>r.method==='PATCH');
 assert.equal(patch.body.libraries[0].integrations[0].configs[0].value,'');
 assert.deepEqual(patch.secretRefs,[{pointer:'/libraries/0/integrations/0/configs/0/value',target:'SSAM/ODC3/'+PERSONAL+'/Setting/ProofSecret',field:'password'}]);
 const reset=await h.access.configurations({action:'set',environmentKey:'e-1',assetKey:'app-1',patch:{libraries:[{key:'lib',revision:2,integrations:[{key:'api',configs:[{key:'Password',value:null}]}]}]},authorize:WORDS,operationUuid:uuid()});
 assert.equal(reset.ok,true,JSON.stringify(reset));assert.equal(reset.readBack.verified,true);
 assert.equal(reset.readBack.configs[0].resetMetadataVerified,true);assert.equal(reset.readBack.configs[0].valueVerified,false);
});

test('raw nested secret patches are rejected before transport and receipt reservation',async t=>{
 const setting={key:'secret',isSecret:true,value:'[REDACTED]'};
 const cases=[
  [{systemConfigurations:[{key:'secret',value:'synthetic-private'}]},{systemConfigurations:[setting]}],
  [{libraries:[{key:'l1',settings:[{key:'secret',value:'synthetic-private'}]}]},{libraries:[{key:'l1',settings:[setting]}]}],
  [{libraries:[{key:'l1',integrations:[{key:'i1',configs:[{key:'secret',value:'synthetic-private'}]}]}]},{libraries:[{key:'l1',integrations:[{key:'i1',configs:[setting]}]}]}]
 ];
 for(const [patch,data] of cases){
  const h=harness({portalCall:request=>{assert.notEqual(request.method,'PATCH');return {ok:true,status:200,body:data};}});
  t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const id=uuid();
  const r=await h.access.configurations({action:'set',environmentKey:'e-1',assetKey:'app-1',patch,authorize:WORDS,operationUuid:id});
  assert.equal(r.sent,false);assert.equal(r.error.code,'SECRET_IN_ARGUMENTS');assert.equal(h.access.receipts.lookup(id),null);
  assert.equal(JSON.stringify(r).includes('synthetic-private'),false);
 }
});

test('system configuration readback confirms override and restored default',async()=>{
 let value='Information',origin='EnvironmentLevelDefault';
 const h=harness({portalCall:req=>req.method==='PATCH'
  ?(value=req.body.systemConfigurations[0].value??'Information',origin=req.body.systemConfigurations[0].value===null?'EnvironmentLevelDefault':'ApplicationLevelOverride',{ok:true,status:204})
  :{ok:true,status:200,body:{systemConfigurations:[{key:'LogLevel',isSecret:false,value,valueOrigin:origin}]}}});
 for(const next of ['Warning',null]){
  const r=await h.access.configurations({action:'set',environmentKey:'e-1',assetKey:'app-1',patch:{systemConfigurations:[{key:'LogLevel',value:next}]},authorize:WORDS,operationUuid:uuid()});
  assert.equal(r.readBack.verified,true);assert.equal(r.receipt.state,'confirmed');assert.equal(r.readBack.configs[0].value,next??'Information');
 }
});

test('configurations set reads timer values back, and a null value back to the default origin', async () => {
  // Live on wrightflood (Quotes, Development): Timeout 20 -> 21 is an ApplicationLevelOverride; null removes it.
  let timeout = { value: '20', valueOrigin: 'ApplicationLevelDefault' };
  const h = harness({ portalCall: request => request.method === 'PATCH'
    ? (timeout = request.body.timers[0].configs[0].value === null ? { value: '20', valueOrigin: 'ApplicationLevelDefault' }
      : { value: request.body.timers[0].configs[0].value, valueOrigin: 'ApplicationLevelOverride' }, { ok: true, status: 204 })
    : { ok: true, status: 200, body: { key: 'app-1', settings: [], timers: [{ key: 't-1', name: 'LoadData', configs: [{ key: 'Timeout', name: 'Timeout', ...timeout }] }] } } });
  const set = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1',
    patch: { timers: [{ key: 't-1', configs: [{ key: 'Timeout', value: '21' }] }] }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(set.readBack.verified, true, JSON.stringify(set));
  assert.deepEqual(set.readBack.configs, [{ group: 'timers', parent: 't-1', key: 'Timeout', name: 'Timeout', value: '21', origin: 'ApplicationLevelOverride' }]);
  assert.equal(JSON.parse(fs.readFileSync(set.receipt.file, 'utf8')).state, 'confirmed');
  assert.equal(set.receipt.state, 'confirmed', 'the answer says what the receipt file now holds');
  const reset = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1',
    patch: { timers: [{ key: 't-1', configs: [{ key: 'Timeout', value: null }] }] }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(reset.readBack.verified, true, JSON.stringify(reset));
  assert.equal(reset.readBack.configs[0].origin, 'ApplicationLevelDefault');
});

test('asset delete reads the name, needs it in the words and confirms the asset is gone', async () => {
  let deleted = false;
  const h = harness({ portalCall: request => request.method === 'DELETE' ? (deleted = true, { ok: true, status: 204 })
    : request.path.endsWith('/environments') ? {ok:true,status:200,body:{results:[{key:ASSET1}]}}
    : request.path.endsWith('/consumers') ? { ok: true, status: 200, body: { results: [] } }
    : deleted ? { ok: true, status: 404, body: { title: 'not found' } } : { ok: true, status: 200, body: { name: 'OldApp' } } });
  const out = await h.access.assetDelete({ assetKey: 'a-9', authorize: 'please delete OldApp for good', operationUuid: uuid() });
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.readBack.gone, true);
  assert.equal(JSON.parse(fs.readFileSync(out.receipt.file, 'utf8')).state, 'confirmed');
});

// Lane extlib: an app or library that consumes the asset breaks when it goes; the words name each one, read BEFORE
// anything is reserved, or nothing happens. Before this rule the delete went straight to the DELETE.
test('asset delete with consumers: CONSUMERS_WOULD_BREAK names them, nothing reserved, no DELETE; words naming them delete', async () => {
  let deleted = false;
  const h = harness({ portalCall: request => request.method === 'DELETE' ? (deleted = true, { ok: true, status: 204 })
    : request.path.endsWith('/environments') ? {ok:true,status:200,body:{results:[{key:ASSET1}]}}
    : request.path.endsWith('/consumers') ? { ok: true, status: 200, body: { results: [{ key: 'c-1', name: 'OrdersApp', type: 'WebApplication' }, { key: 'c-2', name: 'Billing', type: 'LowCodeLibrary' }] } }
    : deleted ? { ok: true, status: 404, body: { title: 'not found' } } : { ok: true, status: 200, body: { name: 'SSAMTextTools' } } });
  const refused = await h.access.assetDelete({ assetKey: 'lib-1', authorize: 'delete SSAMTextTools, the external library', operationUuid: uuid() });
  assert.equal(refused.ok, false); assert.equal(refused.code, 'CONSUMERS_WOULD_BREAK'); assert.equal(refused.sent, false);
  assert.deepEqual(refused.consumers, ['OrdersApp', 'Billing']);
  assert.deepEqual(refused.problems.map(p => [p.target, p.ssamRule]), [['OrdersApp', true], ['Billing', true]]);
  assert.match(refused.problems[0].fix, /also name OrdersApp/);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).method === 'DELETE').length, 0);
  assert.equal(fs.existsSync(path.join(h.dir, 'receipts')) ? fs.readdirSync(path.join(h.dir, 'receipts')).length : 0, 0, 'nothing reserved');
  // One consumer named is not enough; "OrdersApp2" does not name OrdersApp (whole words).
  const partial = await h.access.assetDelete({ assetKey: 'lib-1', authorize: 'delete SSAMTextTools, OrdersApp2 and Billing', operationUuid: uuid() });
  assert.deepEqual(partial.problems.map(p => p.target), ['OrdersApp']);
  const done = await h.access.assetDelete({ assetKey: 'lib-1', authorize: 'delete SSAMTextTools even though OrdersApp and billing use it', operationUuid: uuid() });
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.readBack.gone, true);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).method === 'DELETE').length, 1);
});

test('asset delete refuses a consumer that exists only in a non-default environment before reserving',async t=>{
 let deletes=0;const stage=uuid(),operationUuid=uuid();
 const h=harness({portalCall:request=>{
  if(request.method==='DELETE'){deletes++;return {ok:true,status:204};}
  if(request.path.endsWith('/environments'))return {ok:true,status:200,body:{results:[{key:stage}]}};
  if(request.path.endsWith('/consumers')){const query=new URLSearchParams(request.query);assert.equal(query.get('allowMultipleVersions'),'true');return {ok:true,status:200,body:{results:query.get('environmentKey')===stage?[{key:'consumer',name:'OtherStageApp'}]:[]}};}
  return {ok:true,status:200,body:{name:'Producer'}};
 }});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const result=await h.access.assetDelete({assetKey:'producer',authorize:'Delete Producer only',operationUuid});
 assert.equal(result.code,'CONSUMERS_WOULD_BREAK');assert.deepEqual(result.consumers,['OtherStageApp']);assert.equal(deletes,0);assert.equal(h.access.receipts.lookup(operationUuid),null);
});

test('asset delete refuses when the consumers cannot be read (DEPENDENCY_CHECK_UNAVAILABLE), never blind', async () => {
  const h = harness({ portalCall: request => request.path.endsWith('/consumers') ? { ok: true, status: 500, body: { title: 'boom' } } : { ok: true, status: 200, body: { name: 'OldApp' } } });
  const out = await h.access.assetDelete({ assetKey: 'a-9', authorize: 'please delete OldApp for good', operationUuid: uuid() });
  assert.equal(out.code, 'DEPENDENCY_CHECK_UNAVAILABLE'); assert.equal(out.sent, false);
  assert.equal(portalCalls(h.calls).filter(c => h.requests.get(c[1]).method === 'DELETE').length, 0);
});

test('External Library routes: the generation POST answers operationKey, its delete names the library, the publish route is a listed write', () => {
  assert.equal(OPERATION_STATUS.generation.key, 'operationKey');
  assert.deepEqual(TARGET_NAMES['external-library-generation-api-v1:delete:/generation-operations/{operationKey}'],
    { read: 'external-library-generation-api-v1:get:/generation-operations/{operationKey}', fields: ['libraryName', 'filename'] });
  assert.ok(catalog.operations.has('external-library-generation-api-v1:delete:/generation-operations/{operationKey}'));
  assert.deepEqual(routeOf('externalLibraries.publishJob', true), { module: 'logic', view: 'CreateExternalLibraryWizard.createnewrevision',
    action: 'logic/CreateExternalLibraryWizard/createnewrevision/ActionExternalLibraryPublishJob', discoveryView: 'CreateExternalLibraryWizard.createnewrevision' });
  assert.equal(PORTAL_WRITES['externalLibraries.publishJob'].effect, 'mutation');
  assert.throws(() => routeOf('externalLibraries.publishJob', false), { code: 'PORTAL_OPERATION_NOT_FOUND' });
});

test('a pending External Library job is deleted only with words naming its library, read before the DELETE', async () => {
  const h = harness({ portalCall: request => request.method === 'DELETE' ? { ok: true, status: 204 }
    : { ok: true, status: 200, body: { key: 'job-1', libraryName: 'SSAMTextTools', filename: 'SSAMTextTools-0123456789abcdef.zip', status: 'ReadyForReview' } } });
  const operationId = 'external-library-generation-api-v1:delete:/generation-operations/{operationKey}';
  const refused = await h.access.write({ operationId, path: { operationKey: 'job-1' }, authorize: 'yes, discard that job now', operationUuid: uuid() });
  assert.equal(refused.error.code, 'DESTRUCTIVE_TARGET_NOT_NAMED'); assert.ok(refused.error.candidates.includes('SSAMTextTools'));
  const done = await h.access.write({ operationId, path: { operationKey: 'job-1' }, authorize: 'yes, discard the SSAMTextTools job', operationUuid: uuid() });
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.effect, 'destructive');
});

test('internal Portal: Studio window first, sign-in asked once, vault broker without a Studio, prompt last', async () => {
  const notSigned = harness({ portalSession: args => ({ ok: true, host: args.at(-1), signedIn: false }) });
  const refused = await notSigned.access.portalRead({ operationId: 'monitoring.stages' });
  assert.equal(refused.code, 'PORTAL_AUTH_REQUIRED');
  const login = await notSigned.access.portalLogin({});
  assert.equal(login.ok, true); assert.equal(login.auth.path, 'studio-http');
  assert.deepEqual(notSigned.calls.at(-1), ['portal-session', 'open', '--tenant', PERSONAL]);

  const fetches = [];
  const h = harness({ portalSession: (args, request) => {
    if (args[1] !== 'fetch') return { ok: true, host: args.at(-1), signedIn: true, user: 'dev@example.test' };
    fetches.push(request);
    return { ok: true, status: 200, contentType: 'application/json', host: PERSONAL, body: { data: { EnvironmentList: { List: [{ Environment: { Key: 'dev', Name: 'Development', Purpose: 'Development' } }] } } } };
  } });
  h.access.studioBroker(PERSONAL).metadata.resolve = async (module, view, action) => ({ moduleVersion: 'm', apiVersion: 'a', action });
  const stages = await h.access.portalRead({ operationId: 'monitoring.stages' });
  assert.equal(stages.ok, true, JSON.stringify(stages)); assert.equal(stages.auth.path, 'studio-http'); assert.equal(stages.rows[0].Key, 'dev');
  assert.equal(fetches[0].method, 'POST'); assert.equal(fetches[0].path, '/monitoring/screenservices/monitoring/logs/logs/DataActionGetFilter_Stages');
  assert.equal(fetches[0].write, false); assert.equal(fetches[0].body.versionInfo.apiVersion, 'a');

  const vault = harness({ running: false, portalAccount: true, brokerState: { available: true, authenticated: true,
    readScreenservice: async request => ({ target: 'odc3', origin: request.origin, body: { data: { Connections: { List: [{ ConnectionId: 'c1', Name: 'Db' }] } } } }) } });
  const list = await vault.access.portalRead({ operationId: 'connections.list' });
  assert.equal(list.auth.path, 'vault'); assert.equal(list.rows[0].ConnectionId, 'c1');
  const none = harness({ running: false });
  assert.equal((await none.access.portalRead({ operationId: 'connections.list' })).code, 'CREDENTIAL_PROMPT_OPENED');
  assert.deepEqual(none.prompts, [['portal', PERSONAL, null]]);
});

test('internal Portal writes: listed routes only, no secret arguments, never the decrypted-secrets action', async () => {
  const h = harness();
  assert.equal((await h.access.portalWrite({ operationId: 'connections.delete', input: {}, authorize: WORDS, operationUuid: uuid() })).error.code,
    Object.hasOwn(PORTAL_GAPS, 'connections.delete') ? 'PORTAL_ROUTE_UNMAPPED' : 'DESTRUCTIVE_TARGET_NOT_NAMED');
  assert.equal((await h.access.portalRead({ operationId: 'connections.decryptedSecrets' })).error.code, 'PORTAL_OPERATION_NOT_FOUND');
  const secret = await h.access.portalWrite({ operationId: 'connections.relationalSave', authorize: WORDS, operationUuid: uuid(),
    input: { inputParameters: { ConnectionDetails: { ConnectionDetail_StageConfig: { List: [{ ConnectionDetails_Common: { ConnectionPassword: 'hunter2' } }] } } } } });
  assert.equal(secret.error.code, 'SECRET_IN_ARGUMENTS'); assert.doesNotMatch(JSON.stringify(secret), /hunter2/);
  for (const [, route] of [...Object.entries(PORTAL_READS), ...Object.entries(PORTAL_WRITES).map(([k, w]) => [k, w.route])]) assert.equal(NEVER_EXPOSED.has(route[2]), false);
  assert.equal(h.calls.filter(c => c[0] === 'portal-session' && c[1] === 'fetch').length, 0);
});

test('dataset blank-ID reconciliation binds original approval and persisted content without resending',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const app=uuid(),portfolio=uuid(),datasetId=uuid(),createId=uuid(),words='Own synthetic fixture lifecycle grant';
 const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Create and clean own fixture'};
 const d={Name:'DatasetProof',Description:'Synthetic',AgenticAppId:app,ServiceActionId:uuid(),Content:'{"testCases":[{"name":"Synthetic","inputs":{"Query":"Proof"},"expectations":{"expectedResponse":{"Reply":"Proof"}}}]}',
  SetupAppId:'',SetupServiceActionId:'',TeardownAppId:'',TeardownServiceActionId:'',PortfolioKey:portfolio,AssetType:''};
 const p={OverrideBaseURL:'',Dataset:d,AdditionalApps:{List:[]}},asset={assetKey:app,portfolioKey:portfolio,name:'OwnApp',assetType:'Agent',modelDigest:'digest'};
 const proposal=path.join(h.dir,'proof.md'),file=path.join(h.dir,'create.json');fs.writeFileSync(proposal,'Own synthetic fixture lifecycle');
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
  proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
  scope:[{lane:'odc',host:CORPORATE,operation:DATASET_CREATE,targets:[d.Name,asset.name]}],constraints:{inputSha256:datasetInputHash(p),applicationKey:app,modelDigest:asset.modelDigest,portfolioKey:portfolio}}));
 let writes=0,changed=false,gone=false;
 h.access.read=async()=>({ok:true,data:asset});
 h.access.portalRead=async request=>request.operationId==='agents.agenticApps'?{ok:true,data:{AgenticApps:{List:[{Key:app,Name:asset.name,ModelDigest:'digest',AssetType:''}]}}}
  :request.operationId==='agents.datasetEvaluations'?{ok:true,data:{HasConnectedEvaluations:false},dependencyState:{verified:true,datasetId,hasConnectedEvaluations:false}}
  :{ok:true,data:{NotFound:gone,Dataset:{...d,DatasetId:datasetId,TestCaseCount:'1',Name:changed?'Foreign':d.Name,TestCases:{List:[{Name:'Synthetic',Description:'',Inputs:'{"Query":"Proof"}',Expectations:{ExpectedResponse:'{"Reply":"Proof"}',Guidelines:{List:[]},ExpectedTools:{List:[]}}}]}}}};
 h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async request=>{writes++;if(request.operationId===DATASET_DELETE){gone=true;return {data:{}};}return {data:{DatasetId:'',GroupId:''}};}}});
 const create={tenant:CORPORATE,confirmTenant:CORPORATE,operationId:DATASET_CREATE,input:{inputParameters:p},authorize:words,operationUuid:createId,authorizationContext:file};
 const first=await h.access.portalWrite(create);assert.equal(first.receipt.state,'uncertain');
 const reconcile={state:'confirmed',authorize:words,read:{operationId:'agents.dataset',input:{screenVariables:{id:datasetId,_idInDataFetchStatus:1}},creationInput:p,authorizationContext:file}};
 for(const change of [{authorize:'Different consent words'},{state:'not-applied'}, {read:{...reconcile.read,operationId:'agents.datasets'}},
  {read:{...reconcile.read,creationInput:{...p,Dataset:{...d,Name:'Other'}}}}, {read:{...reconcile.read,authorizationContext:path.join(h.dir,'missing.json')}}]){
  const r=await h.access.receipt({operationUuid:createId,reconcile:{...reconcile,...change}});assert.equal(r.ok,false);assert.equal(h.access.receipts.lookup(createId).state,'uncertain');
 }
 changed=true;assert.equal((await h.access.receipt({operationUuid:createId,reconcile})).ok,false);changed=false;
 const proved=await h.access.receipt({operationUuid:createId,reconcile});assert.equal(proved.ok,true,JSON.stringify(proved));assert.equal(proved.receipt.state,'confirmed');
 assert.equal(h.access.receipts.lookup(createId).response.DatasetId,datasetId);
 assert.equal((await h.access.receipt({operationUuid:createId,reconcile})).ok,true);
 await h.access.portalWrite(create);assert.equal(writes,1);
 const detail=await h.access.portalRead({operationId:'agents.dataset'}),deleteFile=path.join(h.dir,'delete.json');
 fs.writeFileSync(deleteFile,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
  proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
  scope:[{lane:'odc',host:CORPORATE,operation:DATASET_DELETE,targets:[d.Name]}],constraints:{originOperationUuid:createId,datasetId,expectedDatasetSha256:datasetStateHash(detail.data.Dataset)}}));
 const cleanup={tenant:CORPORATE,confirmTenant:CORPORATE,operationId:DATASET_DELETE,input:{inputParameters:{DatasetId:datasetId}},authorize:words,operationUuid:uuid(),authorizationContext:deleteFile};
 assert.equal((await h.access.portalWrite(cleanup)).receipt.state,'confirmed');
 await h.access.portalWrite(cleanup);assert.equal(writes,2);assert.equal(gone,true);
});

test('dataset creation persists identities and never resends accepted or unidentified responses',async t=>{
 for(const data of [{DatasetId:'dataset-proof',GroupId:'group-proof'},{}]){
  const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));let sends=0;
  h.access.resolvePortal=async()=>({path:'vault',host:PERSONAL,broker:{callScreenservice:async request=>{
   assert.equal(request.write,true);sends++;return {data};
  }}});
  const args={tenant:PERSONAL,operationId:'agents.datasetCreate',authorize:WORDS,operationUuid:uuid(),
   input:{inputParameters:{OverrideBaseURL:'',Dataset:{Name:'Proof'},AdditionalApps:{List:[]}}}};
  const first=await h.access.portalWrite(args);const expected=data.DatasetId?'accepted':'uncertain';
  assert.equal(first.receipt.state,expected,JSON.stringify(first));
  const receipt=JSON.parse(fs.readFileSync(first.receipt.file,'utf8'));assert.deepEqual(receipt.response,data);
  const second=await h.access.portalWrite(args);assert.equal(second.existingReceipt,true);assert.equal(sends,1);
 }
});

test('external DB connection: the account stays in the vault, reaches the window as secretRefs, and create reads the list back', async () => {
  const missing = harness();
  const prompt = await missing.access.externalDbConnection({ action: 'test', name: 'SalesDb', providerId: 'mssql', server: 'db.test', port: 1433, database: 'sales', authorize: WORDS, operationUuid: uuid() });
  assert.equal(prompt.code, 'CREDENTIAL_PROMPT_OPENED'); assert.deepEqual(missing.prompts, [['portal', PERSONAL, 'SalesDb']]);
  assert.equal(prompt.credentialEntry, 'SSAM/ODC3/' + PERSONAL + '/DB/SalesDb');

  const posted = [], vaultBrokerCalls = [];
  const h = harness({ portalAccount: (host, database) => database === 'SalesDb',
    brokerState: { callScreenservice: async args => { vaultBrokerCalls.push(args); return { data: {} }; } }, portalSession: (args, request) => {
    if (args[1] !== 'fetch') return { ok: true, host: args.at(-1), signedIn: true };
    if (request.path.endsWith('DataActionGetFilter_Stages')) return { ok: true, status: 200, host: PERSONAL, body: { data: { EnvironmentList: [{ Key: 'dev', Name: 'Development', Purpose: 'Development' }] } } };
    if (request.path.endsWith('DataActionGetStatus')) return { ok: true, status: 200, host: PERSONAL, body: { data: { Status: { Results: { List: [{ StageKey: 'dev', Status: 'Success' }] } } } } };
    if (request.path.endsWith('DataActionGetConnections')) return { ok: true, status: 200, host: PERSONAL, body: { data: { Connections: [{ ConnectionId: 'c-77', Name: 'SalesDb' }] } } };
    posted.push(request);
    return { ok: true, status: 200, host: PERSONAL, body: { data: request.path.includes('Test_Wrapper') ? { Out_ConnectionId: 'c-77' } : { Saved: true } } };
  } });
  h.access.studioBroker(PERSONAL).metadata.resolve = async (module, view, action) => ({ moduleVersion: 'm', apiVersion: 'a', action });
  const operationUuid = uuid();
  const created = await h.access.externalDbConnection({ action: 'create', name: 'SalesDb', providerId: 'mssql', server: 'db.test', port: 1433, database: 'sales', authorize: WORDS, operationUuid });
  assert.equal(created.ok, true, JSON.stringify(created)); assert.equal(created.connectionId, 'c-77'); assert.equal(created.readBack.found, true); assert.equal(created.receipt.state, 'confirmed');
  assert.equal(posted.length, 2);
  const [testCall, saveCall] = posted;
  assert.equal(testCall.write, true); assert.equal(saveCall.operationUuid, operationUuid); assert.notEqual(testCall.operationUuid, operationUuid);
  assert.deepEqual(testCall.secretRefs.map(r => r.field).sort(), ['password', 'password', 'username', 'username']);
  assert.ok(testCall.secretRefs.every(r => r.target === 'SSAM/ODC3/' + PERSONAL + '/DB/SalesDb'));
  assert.equal(testCall.body.inputParameters.ValidStageConfigs.List[0].ConnectionDetails_Common.ConnectionPassword, '');
  assert.equal(saveCall.secretRefs[0].pointer, '/inputParameters/ConnectionDetails/ConnectionDetail_StageConfig/List/0/ConnectionDetails_Common/ConnectionUsername');
  assert.equal(JSON.parse(fs.readFileSync(created.receipt.file, 'utf8')).state, 'confirmed');
  // The secret never enters the facade on the Studio path: every pointer holds an empty placeholder in the request
  // file, the vault broker (which would read it here) is never used, and the answer says the bridge resolved it.
  for (const call of posted) for (const ref of call.secretRefs) {
    const value = ref.pointer.slice(1).split('/').reduce((node, part) => node?.[part], call.body);
    assert.equal(value, '', ref.pointer);
  }
  assert.equal(vaultBrokerCalls.length, 0);
  assert.deepEqual(created.secretRefs, { count: 2, entries: ['SSAM/ODC3/' + PERSONAL + '/DB/SalesDb'], resolvedBy: 'bridge, inside the ODC Studio', resolutionConfirmed: true });
  assert.match(JSON.parse(fs.readFileSync(created.receipt.file, 'utf8')).authorization.planSha256, /^[0-9a-f]{64}$/);
  assert.match(h.journal.find(j => j.command === 'portal-write connections.relationalSave').note, /secretRefs=2$/);
  // The same create again sends nothing: both receipts answer.
  const again = await h.access.externalDbConnection({ action: 'create', name: 'SalesDb', providerId: 'mssql', server: 'db.test', port: 1433, database: 'sales', authorize: WORDS, operationUuid });
  assert.equal(posted.length, 2); assert.equal(again.existingReceipt, true);
  assert.deepEqual(again.testStatus,{notRepeated:true,source:'existing-save-receipt'});
  assert.equal(again.receipt.state,'confirmed');
});

test('external DB connection without the Studio session: refused before any prompt, reservation or send (the secret never enters this process)', async () => {
  const calls = [];
  const brokerState = { available: true, authenticated: true, readScreenservice: async () => ({ target: 'odc3', body: { data: {} } }), callScreenservice: async args => { calls.push(args); return { data: {} }; } };
  for (const options of [{ running: false, portalAccount: true, brokerState }, { portalAccount: true, brokerState, auth: 'portal-credential' }, { portalAccount: true, brokerState, sessions: [] }]) {
    const h = harness(options);
    const created = await h.access.externalDbConnection({ action: 'create', name: 'SalesDb', providerId: 'mssql', server: 'db.test', port: 1433, database: 'sales',
      authorize: WORDS, operationUuid: uuid(), ...(options.auth ? { auth: options.auth } : {}) });
    assert.equal(created.code, 'STUDIO_REQUIRED', JSON.stringify(created)); assert.equal(created.sent, false);
    assert.deepEqual(h.prompts, []); assert.equal(h.calls.filter(c => c[0] !== 'auth-status').length, 0);
    assert.equal(fs.existsSync(path.join(h.dir, 'receipts')) ? fs.readdirSync(path.join(h.dir, 'receipts')).length : 0, 0);
    // The same refusal on the generic internal write, before its receipt.
    const direct = await h.access.portalWrite({ operationId: 'connections.relationalTest', authorize: WORDS, operationUuid: uuid(), auth: 'portal-credential',
      input: { inputParameters: { Common: { ConnectionPassword: '' } } } }, { secretRefs: [{ pointer: '/inputParameters/Common/ConnectionPassword', target: 'SSAM/ODC3/' + PERSONAL + '/DB/SalesDb', field: 'password' }] });
    assert.equal(direct.error.code, 'STUDIO_REQUIRED', JSON.stringify(direct)); assert.equal(direct.receipt, undefined);
  }
  assert.equal(calls.length, 0, 'the vault broker never sends a secretRefs write');
});

test('approved temporary SQL connection lifecycle deletes only its own unused connection and confirms absence without replay', async t => {
  let exists = false, imported = 0, deletes = 0, deletionPending = false;
  const h = harness({ portalAccount: true, portalSession: (args, request) => {
    if (args[1] !== 'fetch') return { ok: true, host: PERSONAL, signedIn: true };
    let data;
    if (request.path.endsWith('DataActionGetFilter_Stages')) data = { EnvironmentList: [{ Key: 'dev', Name: 'Development', Purpose: 'Development' }] };
    else if (request.path.endsWith('DataActionGetStatus')) data = { Status: { Results: { List: [{ StageKey: 'dev', Status: 'Success' }] } } };
    else if (request.path.endsWith('DataActionGetConnections')) data = { Connections: exists ? [{ ConnectionId: 'connection-1', Name: 'Fixture' }] : [] };
    else if (request.path.endsWith('DataActionGetConnection')) data = { NotFound: !exists, Connection: exists ? {
      connectionId: 'connection-1', name: 'Fixture', providerId: 'mssql', portfolioKey: 'portfolio',
      ExternalMetadata: { selectedObjectCount: String(imported), selectedActionCount: '0' },
      StageConfigurations: { List: [{ StageKey: 'dev', configurationValues: { List: [{ key: 'host', value: 'db.test' }, { key: 'port', value: '1433' }, { key: 'database', value: 'sales' }] } }] }
    } : null };
    else if (request.path.endsWith('ActionConnection_Delete_Wrapper')) { deletes++; deletionPending = true; data = {}; }
    else if (request.path.includes('Test_Wrapper')) { exists = true; data = { Out_ConnectionId: 'connection-1' }; }
    else data = {};
    return { ok: true, status: 200, host: PERSONAL, body: { data } };
  } });
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }));
  h.access.studioBroker(PERSONAL).metadata.resolve = async (module, view, action) => ({ moduleVersion: 'm', apiVersion: 'a', action });
  const words = 'Autorizo o escopo temporário e sua exclusão.', proposal = path.join(h.dir, 'proposal.md'), approval = path.join(h.dir, 'approval.json');
  fs.writeFileSync(proposal, 'Fixture: test, create and delete only on db.test:1433/sales, Development. No imports or business data.');
  fs.writeFileSync(approval, JSON.stringify({ schema: 'ssam-authorization-context/1', decision: 'approved', words,
    source: { kind: 'human-conversation', threadId: uuid(), messageId: uuid(), question: 'Authorize this exact temporary fixture?' },
    proposal: { file: proposal, sha256: crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex') },
    scope: ['connections.relationalTest', 'connections.relationalSave', 'connections.delete'].map(operation => ({ lane: 'odc', host: PERSONAL, operation, targets: ['Fixture'], environmentKey: 'dev' })),
    constraints: { server: 'db.test', port: 1433, database: 'sales', noDdl: true, noDataWrites: true, noBusinessDataReads: true,
      deleteTemporaryConnections: true, requiresTestedHeadlessTransport: true } }));
  const created = await h.access.externalDbConnection({ action: 'create', tenant: PERSONAL, name: 'Fixture', providerId: 'mssql',
    server: 'db.test', port: 1433, database: 'sales', stageKey: 'dev', authorize: words, authorizationContext: approval, operationUuid: uuid(), confirmTenant: PERSONAL });
  assert.equal(created.ok, true, JSON.stringify(created)); assert.equal(created.readBack.found, true);
  const deletion = { action: 'delete', tenant: PERSONAL, connectionId: 'connection-1', providerId: 'mssql',
    authorize: words, authorizationContext: approval, originOperationUuid: created.originOperationUuid, operationUuid: uuid(), confirmTenant: PERSONAL };
  imported = 1;
  const refused = await h.access.externalDbConnection(deletion);
  assert.equal(refused.error.code, 'AUTHORIZATION_CONTEXT_INVALID'); assert.equal(deletes, 0);
  imported = 0;
  const removed = await h.access.externalDbConnection(deletion);
  assert.equal(removed.ok, true, JSON.stringify(removed)); assert.equal(removed.readBack.absent, false); assert.equal(deletes, 1);
  assert.equal(deletionPending, true); assert.equal(removed.receipt.state, 'accepted');
  assert.equal(removed.continuation.arguments.operationUuid, deletion.operationUuid);
  assert.equal(removed.continuation.arguments.originOperationUuid, deletion.originOperationUuid);
  assert.equal(removed.continuation.arguments.action, 'delete');
  const stillPending = await h.access.externalDbConnection(deletion);
  assert.equal(stillPending.existingReceipt, true); assert.equal(stillPending.readBack.absent, false); assert.equal(deletes, 1);
  exists = false;
  const reconciled = await h.access.externalDbConnection(deletion);
  assert.equal(reconciled.readBack.absent, true); assert.equal(reconciled.receipt.state, 'confirmed'); assert.equal(deletes, 1);
  assert.equal(JSON.parse(fs.readFileSync(removed.receipt.file, 'utf8')).state, 'confirmed');
  const repeat = await h.access.externalDbConnection(deletion);
  assert.equal(repeat.existingReceipt, true); assert.equal(deletes, 1);
});

test('auth status says whether the attached v32 reads secretRefs inside the Studio (the first v32 lists no capabilities)', async () => {
  const current = await harness({ capabilities: ['portal-call', 'portal-session', 'auth-status', 'portal-call:secretRefs', 'portal-session:secretRefs'] }).access.authStatus({ tenant: PERSONAL });
  assert.equal(current.studio.secretRefs, true); assert.ok(current.studio.capabilities.includes('portal-session:secretRefs'));
  const first = await harness({ capabilities: [] }).access.authStatus({ tenant: PERSONAL });
  assert.equal(first.studio.secretRefs, false); assert.deepEqual(first.studio.capabilities, []);
  const privateHttp = await harness({ capabilities: ['portal-private-call:headless:secretRefs'] }).access.authStatus({ tenant: PERSONAL });
  assert.equal(privateHttp.studio.secretRefs, true);
  assert.equal(privateHttp.studio.privateHttpSecretRefs, true);
  assert.equal(privateHttp.studio.nativeHttpSecretRefs, false);
  assert.equal((await harness({ running: false }).access.authStatus({ tenant: PERSONAL })).studio.secretRefs, undefined);
});

test('secret settings: vaultSettings names a vault entry, the PATCH carries secretRefs only through the Studio session', async () => {
  const settings = [{ key: 's-1', name: 'ServiceUrl', value: 'https://old.test' }, { key: 's-2', name: 'ApiPassword', isSecret: true, value: '********' }];
  const h = harness({ portalAccount: (host, database, setting) => setting === 'ApiPassword-dev',
    portalCall: request => request.method === 'PATCH' ? { ok: true, status: 200, body: {} } : { ok: true, status: 200, body: { key: 'app-1', settings } } });
  const out = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', settings: { ServiceUrl: 'https://new.test' },
    vaultSettings: { ApiPassword: 'ApiPassword-dev' }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(out.ok, true, JSON.stringify(out));
  const patch = [...h.requests.values()].find(r => r.method === 'PATCH');
  assert.deepEqual(patch.body.settings, [{ key: 's-1', value: 'https://new.test' }, { key: 's-2', value: '' }]);
  assert.deepEqual(patch.secretRefs, [{ pointer: '/settings/1/value', target: 'SSAM/ODC3/' + PERSONAL + '/Setting/ApiPassword-dev', field: 'password' }]);
  assert.deepEqual(out.secretRefs, { count: 1, entries: ['SSAM/ODC3/' + PERSONAL + '/Setting/ApiPassword-dev'], resolvedBy: 'bridge, inside the ODC Studio' });
  assert.deepEqual(out.readBack.vaultSettings, [{ key: 's-2', present: true, valueVerified: false }]);
  assert.equal(out.readBack.verified, false, 'the plain value was not echoed back by this fake');
  const plan = JSON.parse(fs.readFileSync(out.receipt.file, 'utf8'));
  assert.doesNotMatch(JSON.stringify(plan), /hunter2/);
  // A missing entry opens the private prompt for it; nothing is sent.
  const before = portalCalls(h.calls).length;
  const missing = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', vaultSettings: { ApiPassword: 'Other' }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(missing.code, 'CREDENTIAL_PROMPT_OPENED'); assert.deepEqual(h.prompts, [['portal', PERSONAL, null, 'Other']]);
  assert.equal(missing.credentialEntry, 'SSAM/ODC3/' + PERSONAL + '/Setting/Other'); assert.equal(portalCalls(h.calls).length, before);
  // A vault value never goes to a setting the server shows in plain text, nor a secret value through the raw patch.
  assert.equal((await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', vaultSettings: { ServiceUrl: 'ApiPassword-dev' }, authorize: WORDS, operationUuid: uuid() })).error.code, 'INPUT_INVALID');
  const raw = await h.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', patch: { settings: [{ key: 's-2', value: 'hunter2' }] }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(raw.error.code, 'SECRET_IN_ARGUMENTS'); assert.doesNotMatch(JSON.stringify(raw), /hunter2/);
  // Without the Studio session (vault API Client path), refused before any prompt or reservation.
  const vault = harness({ running: false, apiClient: true, portalAccount: true });
  const refused = await vault.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', vaultSettings: { ApiPassword: 'ApiPassword-dev' }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(refused.code, 'STUDIO_REQUIRED'); assert.deepEqual(vault.prompts, []); assert.equal(vault.vaultCalls.length, 0);
  // The first v32 refuses secretRefs on portal-call too: nothing sent, the hint says which bridge to attach.
  const old = harness({ portalAccount: true, portalCall: request => request.method === 'PATCH' ? { ok: false, code: 'BAD_REQUEST', gate: 'secret_refs_unsupported' } : { ok: true, status: 200, body: { key: 'app-1', settings } } });
  const first = await old.access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', vaultSettings: { ApiPassword: 'ApiPassword-dev' }, authorize: WORDS, operationUuid: uuid() });
  assert.equal(first.receipt.state, 'not-sent'); assert.match(first.hint, /native headless secretRefs/);
});

test('secretRefs are checked before any reservation: this tenant\'s DB entries only, at empty placeholders', async () => {
  const h = harness({ portalAccount: true });
  const write = secretRefs => h.access.portalWrite({ operationId: 'connections.relationalTest', authorize: WORDS, operationUuid: uuid(),
    input: { inputParameters: { Common: { ConnectionPassword: '', ConnectionServer: 'db.test' } } } }, { secretRefs });
  const good = { pointer: '/inputParameters/Common/ConnectionPassword', target: 'SSAM/ODC3/' + PERSONAL + '/DB/Sales', field: 'password' };
  for (const bad of [{ ...good, target: 'SSAM/ODC3/' + OTHER + '/DB/Sales' }, { ...good, target: 'SSAM/ODC3/' + PERSONAL + '/APIClient' }, { ...good, field: 'secret' },
    { ...good, pointer: '/inputParameters/Common/ConnectionServer' }, { ...good, pointer: '/inputParameters/Common/Nope' }, { ...good, value: 'x' }]) {
    const out = await write([bad]);
    assert.equal(out.error.code, 'INPUT_INVALID', JSON.stringify(bad)); assert.equal(out.sent, false); assert.equal(out.receipt, undefined);
  }
  assert.equal(h.calls.filter(c => c[0] === 'portal-session').length, 0);
  assert.equal(fs.existsSync(path.join(h.dir, 'receipts')) ? fs.readdirSync(path.join(h.dir, 'receipts')).length : 0, 0);
});

// W17: the timer run/pause/resume and connection delete routes arrive from another session's capture. Until then each
// id is a gap refused with its capture step; once its captured route enters PORTAL_WRITES (and leaves PORTAL_GAPS and
// PORTAL_CAPTURE, portal-routes.mjs), the other branch checks its effect. Never both, never neither.
const W17 = { 'timers.run': 'mutation', 'timers.pause': 'mutation', 'timers.resume': 'mutation', 'connections.delete': 'destructive' };
const CLI = /`odc |odc portal|internal-routes|pwsh|powershell|\.ps1|python|--match|--tenant|--view/i;
test('W17 routes: a gap refused with its capture step (odc_portal_routes), or a write with its effect, never both', async () => {
  const h = harness();
  assert.deepEqual(Object.keys(PORTAL_CAPTURE).sort(), Object.keys(PORTAL_GAPS).sort());
  for (const [id, effect] of Object.entries(W17)) {
    const gap = Object.hasOwn(PORTAL_GAPS, id), write = Object.hasOwn(PORTAL_WRITES, id);
    assert.notEqual(gap, write, id + ' is exactly one of PORTAL_GAPS or PORTAL_WRITES');
    // Only refusals are exercised here: a captured mutation would reach the (fake) Portal window.
    const out = gap || effect === 'destructive' ? await h.access.portalWrite({ operationId: id, input: {}, authorize: WORDS, operationUuid: uuid() }) : null;
    if (gap) {
      assert.equal(out.error.code, 'PORTAL_ROUTE_UNMAPPED', id); assert.equal(out.sent, false); assert.equal(out.receipt, undefined);
      assert.match(out.error.message, /Live proof: odc_portal_login .*odc_portal_routes \{module:"/, id);
      assert.doesNotMatch(out.error.message, CLI, id);
      assert.deepEqual(out.error.continuation, { tool: 'odc_portal_routes', arguments: { ...PORTAL_CAPTURE[id] }, why: out.error.continuation.why }, id);
      assert.match(out.error.continuation.why, new RegExp(id.replace('.', '\\.')));
    } else {
      assert.equal(PORTAL_WRITES[id].effect, effect, id); assert.equal(PORTAL_WRITES[id].route.length, 3, id);
      assert.ok(PORTAL_WRITES[id].route.every(part => typeof part === 'string' && part), id);
      // A destructive route needs a target the words name; odc_portal_write has none, so it is refused before any send.
      if (effect === 'destructive') assert.equal(out.error.code, 'DESTRUCTIVE_TARGET_NOT_NAMED', id);
    }
  }
  // The typed helper refuses the delete with the same capture step while it is a gap (W17 then wires OdcAccess.dbDelete).
  if (Object.hasOwn(PORTAL_GAPS, 'connections.delete')) {
    const del = await h.access.externalDbConnection({ action: 'delete', connectionId: 'c-1' });
    assert.equal(del.error.code, 'PORTAL_ROUTE_UNMAPPED'); assert.equal(del.tenant, PERSONAL);
    assert.deepEqual(del.error.continuation.arguments, { module: 'connections', view: 'Connections.connection', match: 'Delete' });
  }
  assert.equal(h.calls.filter(c => c[0] === 'portal-session').length, 0);
  // A destructive internal route, once captured, needs words naming its target, like the public deletes.
  assert.throws(() => guardPortalTarget('destructive', 'yes delete it', { connectionName: 'SalesDb' }), { code: 'DESTRUCTIVE_TARGET_NOT_NAMED' });
  assert.doesNotThrow(() => guardPortalTarget('destructive', 'yes delete SalesDb now', { connectionName: 'SalesDb' }));
  assert.doesNotThrow(() => guardPortalTarget('mutation', 'yes save it', undefined));
});

test('Portal session failures do not request a window or expose local bootstrap commands', async () => {
  const old = harness({ capabilities: [] });
  assert.equal((await old.access.portalRead({ operationId: 'monitoring.stages' })).code, 'HEADLESS_AUTH_UNAVAILABLE');
  assert.equal(old.calls.some(c => c[0] === 'portal-session'), false);
  const notSigned = harness({ portalSession: () => ({ ok: true, signedIn: false }) });
  assert.equal((await notSigned.access.portalRoutes({ module: 'connections' })).code, 'PORTAL_AUTH_REQUIRED');
  const vault = harness({ running: false, brokerState: { status: () => ({ authenticated: false, available: false, operatorAction: 'private bootstrap' }) } });
  const status = await vault.access.portalLogin({ action: 'status' });
  assert.equal(status.ok, true); assert.equal(status.session.operatorAction, undefined);
  assert.deepEqual(vault.prompts, []);
});

test('route capture for the live proof lists a module\'s screenservice actions through the Studio Portal window, GETs only', async () => {
  const gets = [];
  const assets = {
    '/connections/moduleservices/moduleversioninfo': JSON.stringify({ versionToken: 'v-1' }),
    '/connections/': '<script src="scripts/connections._osbundle-1.index.js"></script>',
    '/connections/scripts/connections._osbundle-1.index.js': 'x={screenName:"Connections.connections"},{screenName:"Connections.connection",load:()=>import("./connections.Connections.connection.mvc.js")}',
    '/connections/scripts/connections.Connections.connection.mvc.js': '"screenservices/connections/Connections/connection/ActionConnection_Delete","av1";"screenservices/connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_Convert_RelationalDB","av2";import("./connections.helper.js");"screenservices/other/X/y/ActionZ","av3"',
    '/connections/scripts/connections.helper.js': '"screenservices/connections/ConnectionsCommon/Connection_GetTestStatus/DataActionGetStatus","av4"',
  };
  const h = harness({ portalSession: (args, request) => {
    if (args[1] !== 'fetch') return { ok: true, host: args.at(-1), signedIn: true };
    gets.push(request);
    return Object.hasOwn(assets, request.path) ? { ok: true, status: 200, host: PERSONAL, text: assets[request.path] } : { ok: false, code: 'REMOTE_ERROR' };
  } });
  const out = await h.access.portalRoutes({ module: 'connections', view: 'Connections.connection' });
  assert.equal(out.ok, true, JSON.stringify(out));
  // Short answer: no auth block, no asset count, no version token.
  assert.deepEqual(Object.keys(out).sort(), ['actions', 'module', 'next', 'ok', 'screens', 'tenant', 'truncated', 'view']);
  assert.deepEqual([out.tenant, out.module, out.view, out.truncated], [PERSONAL, 'connections', 'Connections.connection', false]);
  assert.deepEqual(out.screens, ['Connections.connection', 'Connections.connections']);
  assert.deepEqual(out.actions, [
    { action: 'connections/Connections/connection/ActionConnection_Delete', mapped: false },
    { action: 'connections/ConnectionsCommon/Connection_GetTestStatus/DataActionGetStatus', mapped: true },
    { action: 'connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_Convert_RelationalDB', mapped: true }]);
  assert.doesNotMatch(out.next, CLI);
  assert.ok(gets.every(g => g.method === 'GET' && g.write === false && g.body === undefined), 'GETs only, never a write');
  assert.equal((await h.access.portalRoutes({ module: 'connections', view: 'Connections.connection', match: 'delete' })).actions.length, 1);
  assert.match(h.journal.at(-1).note, /auth=studio-http actions=1$/);
  // Without view the entry bundle is the start; view is then absent from the answer.
  assert.equal('view' in (await h.access.portalRoutes({ module: 'connections' })), false);
  // Refused modules: checked before any tenant, Studio, session or prompt is touched.
  const before = h.calls.length;
  for (const module of ['authentication', 'identity', 'api', 'Authentication', ' api ', 'connections/../api', '', undefined]) {
    assert.equal((await h.access.portalRoutes({ module })).error.code, 'INPUT_INVALID', String(module));
  }
  assert.equal(h.calls.length, before); assert.deepEqual(h.prompts, []);
  const none = harness({ running: false });
  assert.equal((await none.access.portalRoutes({ module: 'identity' })).error.code, 'INPUT_INVALID'); assert.deepEqual(none.prompts, []);
});

test('route capture answers stay short: screens and actions capped, truncated and next say how to narrow', async () => {
  const h = harness();
  const broker = h.access.studioBroker(PERSONAL);
  let asked;
  broker.metadata.routes = async (module, options) => { asked = [module, options];
    return { module, view: null, screens: Array.from({ length: MAX_ROUTE_SCREENS + 5 }, (_, i) => 'S.s' + i), assetsInspected: 3, truncated: false,
      actions: [PORTAL_READS['connections.list'][2], ...Array.from({ length: MAX_ROUTE_ACTIONS + 10 }, (_, i) => 'apps/Fixture/f/ActionFixture' + String(i).padStart(3, '0'))].sort() }; };
  const out = await h.access.portalRoutes({ tenant: PERSONAL, module: 'apps', match: 'Fixture' });
  assert.deepEqual(asked, ['apps', { view: undefined, match: 'Fixture' }]);
  assert.equal(out.screens.length, MAX_ROUTE_SCREENS); assert.equal(out.actions.length, MAX_ROUTE_ACTIONS); assert.equal(out.truncated, true);
  assert.match(out.next, /narrow with view .* or match/); assert.equal(out.assetsInspected, undefined);
  broker.metadata.routes = async module => ({ module, view: null, screens: ['S.a'], actions: [PORTAL_READS['connections.list'][2]], assetsInspected: 48, truncated: true });
  const scan = await h.access.portalRoutes({ tenant: PERSONAL, module: 'connections' });
  assert.equal(scan.truncated, true); assert.deepEqual(scan.actions, [{ action: PORTAL_READS['connections.list'][2], mapped: true }]);
  assert.match(scan.next, /narrow/); assert.doesNotMatch(scan.next, /unmapped action/);
});

test('auth status reports the path per tenant without secrets, prompts or sends', async () => {
  const h = harness({ apiClient: host => host === CORPORATE });
  const status = await h.access.authStatus();
  const byHost = Object.fromEntries(status.tenants.map(t => [t.host, t]));
  assert.equal(byHost[PERSONAL].resolves.public, 'studio'); assert.equal(byHost[PERSONAL].studio.user, 'dev@example.test');
  assert.equal(byHost[CORPORATE].resolves.public, 'STUDIO_NOT_SIGNED_IN'); assert.equal(byHost[CORPORATE].apiClient.available, true);
  assert.equal(byHost[CLIENT].readOnly, true);
  assert.equal(h.prompts.length, 0); assert.equal(portalCalls(h.calls).length, 0);
  const noStudio = harness({ running: false, apiClient: host => host === CORPORATE });
  const offline = Object.fromEntries((await noStudio.access.authStatus()).tenants.map(t => [t.host, t.resolves.public]));
  assert.equal(offline[CORPORATE], 'vault'); assert.equal(offline[PERSONAL], 'AUTH_NOT_CONFIGURED');
});
test('asset deletion binds contextual approval and still refuses an unapproved consumer', async () => {
  for (const consumers of [[], [{name:'NewConsumer',key:'other'}]]) {
    let deleted=false;
    const h=harness({sessions:[{host:CORPORATE,loggedIn:true,user:'dev@example.test'}],portalCall:req=>{
      if(req.method==='DELETE'){deleted=true;return {ok:true,status:204,host:CORPORATE,body:{}};}
      if(req.path.endsWith('/environments'))return {ok:true,status:200,host:CORPORATE,body:{results:[{key:ASSET1}]}};
      if(req.path.includes('/consumers'))return {ok:true,status:200,host:CORPORATE,body:{results:consumers}};
      return deleted?{ok:false,status:404,host:CORPORATE,body:{}}:{ok:true,status:200,host:CORPORATE,body:{name:'Proof'}};
    }});
    const proposal=path.join(h.dir,'proposal.md'),context=path.join(h.dir,'approval.json'),words='Pode sim, depois apague.';
    fs.writeFileSync(proposal,'Create and delete the disposable Proof app in the specified corporate tenant.');
    fs.writeFileSync(context,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,
      source:{kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'May I execute the attached fixture proposal?'},
      proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
      scope:[{lane:'odc',host:CORPORATE,operation:DELETE_ASSET,targets:['Proof']}]}));
    const result=await h.access.assetDelete({tenant:CORPORATE,confirmTenant:CORPORATE,assetKey:'proof',authorize:words,operationUuid:uuid(),authorizationContext:context});
    if(consumers.length){assert.equal(result.code,'CONSUMERS_WOULD_BREAK');assert.equal(deleted,false);}
    else {assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.readBack.gone,true);assert.equal(deleted,true);assert.equal(result.receipt.state,'confirmed');
      const receipt=JSON.parse(fs.readFileSync(result.receipt.file));assert.equal(receipt.authorization.contextSha256,crypto.createHash('sha256').update(fs.readFileSync(context)).digest('hex'));}
  }
});

test('owned consumer deletion reaches DELETE once and a repeated UUID answers the receipt', async () => {
 const {consumerSetHash}=await import('../runtime/owned-consumer-deletion-approval.mjs');
 let deletes=0;
 const consumer={key:'consumer-key',name:'OwnedConsumer'},host=CORPORATE,words='Synthetic fixture grant';
 const h=harness({sessions:[{host,loggedIn:true,user:'dev@example.test'}],portalCall:req=>{
  if(req.method==='DELETE'){deletes++;return {ok:true,status:204,host,body:{}};}
  if(req.path.endsWith('/environments'))return {ok:true,status:200,host,body:{results:[{key:ASSET1}]}};
  if(req.path.includes('/consumers'))return {ok:true,status:200,host,body:{results:[consumer]}};
  return deletes?{ok:false,status:404,host,body:{}}:{ok:true,status:200,host,body:{name:'OwnedProducer'}};
 }});
 const proposal=path.join(h.dir,'owned-proposal.md'),context=path.join(h.dir,'owned-context.json');fs.writeFileSync(proposal,'Delete both owned fixtures including the connected producer first.');
 const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Synthetic fixture scope'};
 const origins={'producer-key':uuid(),'consumer-key':uuid()},proposalSha256=sha(fs.readFileSync(proposal));
 fs.writeFileSync(context,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
  proposal:{file:proposal,sha256:proposalSha256},scope:[{lane:'odc',host,operation:DELETE_ASSET,targets:['OwnedProducer','OwnedConsumer']}],
  constraints:{allowOwnedConsumerBreakage:true,producerAssetKey:'producer-key',consumerSetSha256:consumerSetHash([consumer]),ownedAssetOrigins:origins}}));
 const originalLookup=h.access.receipts.lookup.bind(h.access.receipts);
 h.access.receipts.lookup=id=>{
  const entry=Object.entries(origins).find(([,v])=>v===id);
  return entry?{state:'accepted',status:201,identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:entry[0]},authorization:{wordsSha256:sha(words),proposalSha256,source}}:originalLookup(id);
 };
 const args={tenant:host,confirmTenant:host,assetKey:'producer-key',authorize:words,operationUuid:uuid(),authorizationContext:context};
 const out=await h.access.assetDelete(args);
 assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.receipt.state,'confirmed');assert.equal(out.readBack.gone,true);
 assert.equal(out.dependencyCheck.ownedConsumerApproval.consumerSetSha256,consumerSetHash([consumer]));
 const repeated=await h.access.assetDelete(args);assert.equal(repeated.existingReceipt,true);assert.equal(deletes,1);
});

test('knowledge-base lifecycle reconciles delayed create/delete without repeating native writes',async()=>{
 const {KB_CREATE,KB_DELETE}=await import('../runtime/knowledge-base.mjs');
 const h=harness(),host=CORPORATE,words='Synthetic own fixture grant',key=uuid(),portfolio=uuid();
 let created=false,ready=false,gone=false,writes=0;
 const item=()=>({KnowledgeBaseId:key,Name:'OwnedKB',Status:ready?'Ready':'Creating'});
 h.access.portalRead=async({operationId})=>{
  if(operationId==='knowledgeBases.chunkingMethods')return {ok:true,data:{ChunkingMethods:{List:[{Id:'Smart'}]}}};
  if(operationId==='knowledgeBases.createStages')return {ok:true,data:{Stages:{List:[{PortfolioKey:portfolio}]}}};
  if(operationId==='knowledgeBases.consumers')return {ok:true,data:{ApplicationConsumers:{List:[]}}};
  const rows=created&&!gone?[item()]:[];return {ok:true,data:{KBListItems:{List:rows},TotalCount:String(rows.length)}};
 };
 h.access.resolvePortal=async()=>({path:'vault',host,broker:{callScreenservice:async({operationId})=>{
  writes++;if(operationId===KB_CREATE){created=true;return {data:{KnowledgeBaseId:key}};}return {data:{}};
 }}});
 const proposal=path.join(h.dir,'kb-proposal.md'),context=path.join(h.dir,'kb-context.json');fs.writeFileSync(proposal,'Synthetic owned KB lifecycle');
 const hash=v=>crypto.createHash('sha256').update(v).digest('hex'),source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Synthetic lifecycle'};
 const inputParameters={KnowledgeBaseCreate:{Name:'OwnedKB',Description:'Empty',PortfolioKey:portfolio,DataSources:{List:[{Name:'Source',Description:'Empty',Type:'upload_files',ChunkingConfig:{ChunkingMethod:'Smart',ChunkSize:1000,ChunkOverlap:200,Separators:'',KeepSeparator:false}}]}}};
 const record={schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},scope:[{lane:'odc',host,operation:KB_CREATE,targets:['OwnedKB','Source']}],constraints:{inputSha256:hash(JSON.stringify(inputParameters)),portfolioKey:portfolio}};
 fs.writeFileSync(context,JSON.stringify(record));
 const args={tenant:host,auth:'portal-credential',confirmTenant:host,operationId:KB_CREATE,input:{inputParameters},authorize:words,operationUuid:uuid(),authorizationContext:context};
 const first=await h.access.portalWrite(args);assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.receipt.state,'accepted');assert.equal(first.readBack.verified,false);
 ready=true;const recovered=await h.access.portalWrite(args);assert.equal(recovered.receipt.state,'confirmed');assert.equal(writes,1);
 record.scope[0].operation=KB_DELETE;record.constraints={originOperationUuid:args.operationUuid,knowledgeBaseId:key,expectedKnowledgeBaseSha256:hash(JSON.stringify(item()))};fs.writeFileSync(context,JSON.stringify(record));
 const deletion={...args,operationId:KB_DELETE,input:{inputParameters:{KnowledgeBaseId:key}},operationUuid:uuid()};
 const pending=await h.access.portalWrite(deletion);assert.equal(pending.ok,true,JSON.stringify(pending));assert.equal(pending.receipt.state,'accepted');assert.equal(pending.readBack.absent,false);
 gone=true;const finished=await h.access.portalWrite(deletion);assert.equal(finished.receipt.state,'confirmed');assert.equal(finished.readBack.absent,true);assert.equal(writes,2);
 await h.access.portalWrite(deletion);assert.equal(writes,2);
});

test('public pattern read normalizes native page-number offsets after validating a complete catalog', async t => {
  const patterns=Array.from({length:37},(_,i)=>({id:`pattern-${i}`}));
  const h=harness({portalCall:async request=>{
    const params=new URLSearchParams(request.query);
    assert.equal(params.get('Limit'),'1000');assert.equal(params.get('Offset'),'0');
    return {ok:true,status:200,contentType:'application/json',body:{page:{count:37,totalResults:37,offset:0,limit:1000,nextPageOffset:0},results:patterns}};
  }});
  t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
  const r=await h.access.read({tenant:PERSONAL,operationId:'code-quality-api-v1:get:/patterns',query:{Limit:20,Offset:20}});
  assert.equal(r.ok,true);assert.deepEqual(r.data.results,patterns.slice(20));assert.equal(r.data.page.offset,20);
  assert.equal(r.data.page.nextPageOffset,null);assert.equal(r.pagination.sourceCount,37);assert.equal(portalCalls(h.calls).length,1);
});

test('operation status confirms only its initiating analysis receipt without another POST',async t=>{
 const analysisKey='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';const id=uuid();
 const h=harness({portalCall:request=>request.method==='POST'
  ? {ok:true,status:200,body:{analysisKey}}
  : {ok:true,status:200,body:{analysisKey,status:'Completed',findings:[],qualityScore:100}}});
 t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const started=await h.access.write({tenant:PERSONAL,operationId:'code-quality-api-v1:post:/code-analyses',body:{assetKey:ASSET1,assetRevision:1},authorize:WORDS,operationUuid:id});
 assert.equal(started.receipt.state,'accepted');
 const result=await h.access.operationStatus({tenant:PERSONAL,kind:'code-analysis',operationKey:analysisKey,operationUuid:id});
 assert.equal(result.terminal,true);assert.equal(result.receipt.state,'confirmed');
 assert.equal([...h.requests.values()].filter(x=>x.method==='POST').length,1);
 await assert.rejects(h.access.operationStatus({tenant:PERSONAL,kind:'code-analysis',operationKey:'wrong',operationUuid:id}),e=>e.code==='OPERATION_RECEIPT_MISMATCH');
});

function activationHarness(t,{missingKey=false}={}){
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const timerKey='aaaaaaaa-6666-4666-8666-666666666666';let active=true,applied=false,status='Running';const writes=[];
 const field=(key,value,dataType)=>({key,value,deployedValue:value,dataType,isSecret:false,valueOrigin:key==='IsActive'&&applied?'ApplicationLevelOverride':'ApplicationLevelDefault',deployedValueOrigin:key==='IsActive'&&applied?'ApplicationLevelOverride':'ApplicationLevelDefault'});
 h.access.read=async req=>{
  if(req.operationId===TIMER_CONFIGURATION)return{ok:true,tenant:PERSONAL,data:{revisionBaseline:7,revisionDeployed:7,settings:[],systemConfigurations:[],integrations:[],libraries:[],timers:[{key:timerKey,name:'ProofTick',configs:[field('IsActive',active?'True':'False','Boolean'),field('Schedule','0 0 1 1 *','Text'),field('Timeout','1','Integer')]}]}};
  if(req.operationId===TIMER_APPLICATION_REVISION)return{ok:true,tenant:PERSONAL,data:{assetKey:ASSET1,revision:7,name:'ProofApp'}};
  const receipt=writes.length?h.access.receipts.lookup(writes[0].operationUuid):null;
  return{ok:true,tenant:PERSONAL,data:{key:DEP1,assetKey:ASSET1,environmentKey:ENV1,status,operation:'ApplyConfigs',revisions:[7],startedDateTime:receipt?.createdAt}};
 };
 h.access.resolvePortal=async()=>({path:'vault',host:PERSONAL,broker:{callScreenservice:async req=>{
  if(req.write){writes.push(req);const receipt=h.access.receipts.lookup(req.operationUuid);assert.equal(receipt.state,'uncertain');assert.equal(receipt.timerActivation.desiredActive,req.input.inputParameters.TimerInfo.Timer.Configs.IsActive.Current);
   active=req.input.inputParameters.TimerInfo.Timer.Configs.IsActive.Current;applied=true;return{data:missingKey?{}:{DeploymentKey:DEP1}};}
  if(req.operationId==='timers.info')return{data:{NotFound:false,TimerInfo:{HasPendingConfigurations:false,Timer:{Key:timerKey,Name:'ProofTick',Configs:{IsActive:{Current:active,Deployed:active,ValueOrigin:applied?'ApplicationLevelOverride':'ApplicationLevelDefault',DeployedValueOrigin:applied?'ApplicationLevelOverride':'ApplicationLevelDefault'},Schedule:{Value:'0 0 1 1 *',DeployedValue:'0 0 1 1 *',ValueOrigin:'ApplicationLevelDefault',DeployedValueOrigin:'ApplicationLevelDefault'},Timeout:{Value:'1',DeployedValue:'1',ValueOrigin:'ApplicationLevelDefault',DeployedValueOrigin:'ApplicationLevelDefault'}}}}}};
  if(req.operationId==='timers.pendingConfiguration')return{data:{PendingConfigurations:{List:[]}}};
  if(req.operationId==='timers.currentRun')return{data:{TimerRunInformation:{isRunning:false,isPendingRun:false}}};
  return{data:{HasOngoingDeployments:false,DeploymentKey:DEP1}};
 }}});
 const input={inputParameters:{StageKey:ENV1,ApplicationKey:ASSET1,TimerKey:timerKey}};
 return{...h,writes,input,finish:()=>status='Finished',run:(args={})=>h.access.portalWrite({tenant:PERSONAL,operationId:'timers.pause',input,authorize:'Pause ProofTick in ProofApp',operationUuid:uuid(),...args})};
}
test('native pause sends once, follows the same deployment receipt and verifies its deployed state',async t=>{
 const h=activationHarness(t),id=uuid();const start=await h.run({operationUuid:id});assert.equal(start.ok,true,JSON.stringify(start));assert.equal(start.receipt.state,'accepted');
 assert.equal(h.writes[0].input.inputParameters.TimerInfo.Timer.Configs.Timeout.Value,'0');
 assert.equal((await h.run({operationUuid:id})).existingReceipt,true);assert.equal(h.writes.length,1);
 const pending=await h.access.operationStatus({tenant:PERSONAL,kind:'deployment',operationKey:DEP1,operationUuid:id});assert.equal(pending.terminal,false);assert.equal(pending.continuation.arguments.operationUuid,id);
 h.finish();const done=await h.access.operationStatus({tenant:PERSONAL,kind:'deployment',operationKey:DEP1,operationUuid:id});assert.equal(done.receipt.state,'confirmed');assert.equal(done.timerVerification.active,false);assert.equal(h.writes.length,1);
});
test('native pause without a returned deployment key stays uncertain and never repeats',async t=>{
 const h=activationHarness(t,{missingKey:true}),id=uuid(),result=await h.run({operationUuid:id});assert.equal(result.ok,false);assert.equal(result.receipt.state,'uncertain');assert.equal(result.error.code,'TIMER_DEPLOYMENT_KEY_UNVERIFIED');
 assert.equal((await h.run({operationUuid:id})).existingReceipt,true);assert.equal(h.writes.length,1);
});

test('missing deployment key reconciles only after scoped native and public deployment proof',async t=>{
 const h=activationHarness(t,{missingKey:true}),id=uuid();await h.run({operationUuid:id});
 const reconcile={state:'confirmed',authorize:'Pause ProofTick in ProofApp',read:{operationId:'timers.info',input:{screenVariables:{appid:ASSET1,stageid:ENV1,id:h.input.inputParameters.TimerKey}}}};
 const pending=await h.access.receipt({operationUuid:id,reconcile});assert.equal(pending.code,'TIMER_DEPLOYMENT_PENDING');assert.equal(pending.receipt.state,'uncertain');
 const wrong=await h.access.receipt({operationUuid:id,reconcile:{...reconcile,read:{...reconcile.read,input:{screenVariables:{appid:ASSET1,stageid:ASSET1,id:h.input.inputParameters.TimerKey}}}}});assert.equal(wrong.error.code,'TIMER_STATE_UNVERIFIED');
 h.finish();const done=await h.access.receipt({operationUuid:id,reconcile});assert.equal(done.ok,true,JSON.stringify(done));assert.equal(done.receipt.state,'confirmed');assert.equal(done.timerVerification.deploymentKey,DEP1);assert.equal(h.writes.length,1);
});

test('operation status can prove a discovered key without replaying the original write',async t=>{
 const h=activationHarness(t,{missingKey:true}),id=uuid();const start=await h.run({operationUuid:id});assert.equal(start.continuation.arguments.operationId,'timers.deploymentStatus');
 h.finish();const done=await h.access.operationStatus({tenant:PERSONAL,kind:'deployment',operationKey:DEP1,operationUuid:id});
 assert.equal(done.receipt.state,'confirmed');assert.equal(done.timerVerification.deploymentKey,DEP1);assert.equal(h.writes.length,1);
});

test('latest timer deployment exposes verified public metadata without rewriting native placeholders',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const native={DeployedAppVersion:{List:[{Key:'',Deployments:{List:[{Revision:7,DeploymentKey:''}]}}]},AssetRevision:{Name:'ProofApp'}};
 h.access.resolvePortal=async()=>({path:'vault',host:PERSONAL,broker:{callScreenservice:async()=>({data:structuredClone(native)})}});
 h.access.read=async req=>{
  if(req.operationId==='portfolio-api-v2:get:/deployed-assets')return{ok:true,data:{page:{totalResults:1,count:1,offset:0,nextPageOffset:null},results:[{key:ASSET1,deployments:[{environmentKey:ENV1,portfolioKey:ASSET1,name:'ProofApp',revision:7,buildKey:ASSET1,deploymentKey:DEP1,deploymentDateTime:'2026-10-09T00:00:00Z'}]}]}};
  return{ok:true,data:{assetKey:ASSET1,portfolioKey:ASSET1,name:'ProofApp',revision:7}};
 };
 const r=await h.access.portalRead({tenant:PERSONAL,operationId:'timers.latestDeployment',input:{screenVariables:{appid:ASSET1,stageid:ENV1}}});
 assert.equal(r.ok,true);assert.equal(r.deploymentState.state,'verified');assert.equal(r.deploymentState.deployment.deploymentKey,DEP1);assert.deepEqual(r.data,native);
});

for(const operationId of ['connections.relationalNameAvailability','connections.azureSearchNameAvailability','connections.customSearchNameAvailability'])test(operationId+' validates before dispatch and rejects a malformed successful response',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 let calls=0,data={IsNameAvailable:false};
 h.access.resolvePortal=async()=>({path:'vault',host:PERSONAL,broker:{callScreenservice:async request=>{
  calls++;assert.equal(request.operationId,operationId);assert.equal(request.write,false);assert.equal(request.input.inputParameters.ConnectionName,'Proof');return {data};
 }}});
 const args={tenant:PERSONAL,operationId,input:{inputParameters:{ConnectionName:'Proof',ConnectionId:''}}};
 const bad=await h.access.portalRead({...args,input:{}});assert.equal(bad.error.code,'INPUT_INVALID');assert.equal(calls,0);
 const result=await h.access.portalRead(args);assert.equal(result.ok,true);assert.equal(result.nameAvailability.available,false);
 assert.equal(result.nameAvailability.reservationMade,false);assert.deepEqual(result.data,data);assert.equal(calls,1);
 data={IsNameAvailable:'false'};const malformed=await h.access.portalRead(args);
 assert.equal(malformed.ok,false);assert.equal(malformed.error.code,'PORTAL_RESPONSE_INVALID');assert.equal(calls,2);
});

test('agent list scope check receives the requested native offset',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 h.access.resolvePortal=async()=>({path:'vault',host:PERSONAL,broker:{callScreenservice:async request=>{
  assert.equal(request.input.screenVariables.PaginationStartIndex,8);
  return {data:{Datasets:{List:[]},Page:{Total:'0',Limit:'8',Offset:'0',NextPageOffset:'0',HasMore:false}}};
 }}});
 const r=await h.access.portalRead({tenant:PERSONAL,operationId:'agents.datasets',input:{screenVariables:{PaginationStartIndex:8}}});
 assert.equal(r.ok,true);assert.equal(r.complete,false);assert.equal(r.paginationVerified,false);
 assert.equal(r.paginationIssue,'requested-offset-mismatch');assert.equal(r.data.Page.Offset,'0');
});

test('timer currentRun preserves native sentinel but exposes an explicitly unverified finish',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 h.access.resolvePortal=async()=>({path:'vault',host:PERSONAL,broker:{callScreenservice:async()=>({data:{TimerRunInformation:{isRunning:false,isPendingRun:false,lastRunStartedOn:'2026-10-09T00:15:58Z',lastRunFinishedOn:'1900-01-01T00:00:00',lastRunDuration:1}}})}});
 const result=await h.access.portalRead({tenant:PERSONAL,operationId:'timers.currentRun',input:{}});
 assert.equal(result.ok,true);assert.equal(result.data.TimerRunInformation.lastRunFinishedOn,'1900-01-01T00:00:00');
 assert.equal(result.executionState.state,'idle');assert.equal(result.executionState.lastFinishedAt,null);assert.equal(result.executionState.completionVerified,false);
});

test('pending timer read compares saved/deployed state even when the native list is empty',async t=>{
 const h=activationHarness(t),read=h.access.read,resolve=h.access.resolvePortal;
 h.access.read=async req=>{const r=await read(req);if(req.operationId===TIMER_CONFIGURATION){const c=r.data.timers[0].configs[0];c.value='False';c.valueOrigin='ApplicationLevelOverride';}return r;};
 h.access.resolvePortal=async(...args)=>{const r=await resolve(...args),call=r.broker.callScreenservice;return{...r,broker:{...r.broker,callScreenservice:async req=>{const result=await call(req);if(req.operationId==='timers.info'){const c=result.data.TimerInfo.Timer.Configs.IsActive;c.Current=false;c.ValueOrigin='ApplicationLevelOverride';}return result;}}};};
 const result=await h.access.portalRead({tenant:PERSONAL,operationId:'timers.pendingConfiguration',input:{screenVariables:{appid:ASSET1,stageid:ENV1,id:h.input.inputParameters.TimerKey}}});
 assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.data.PendingConfigurations.List,[]);
 assert.equal(result.configurationState.state,'pending');assert.equal(result.configurationState.nativeFlag,false);assert.equal(result.configurationState.savedNotDeployed,true);assert.equal(result.configurationState.applicationWideAbsenceProven,false);assert.equal(h.writes.length,0);
});

test('native package refuses foreign tenant or non-public receipts before authentication',async t=>{
 const h=harness({apiClient:true});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const operationUuid=uuid(),operationKey=uuid();let auth=0;
 h.access.resolvePublic=async()=>{auth++;throw Error('must not authenticate');};
 const r=h.access.receipts.reserve({operationUuid,identity:{kind:'odc-public',tenant:PERSONAL,operationId:'native-application-orchestration-service-api-v1:post:/build-operations',target:{}},wordsSha256:'synthetic',plan:{}});
 h.access.receipts.settle(r,{state:'confirmed',response:{key:operationKey}});
 const result=await h.access.nativePackage({tenant:CORPORATE,operationUuid,operationKey});assert.equal(result.error.code,'OPERATION_RECEIPT_MISMATCH');assert.equal(auth,0);
 r.identity.kind='odc-portal';h.access.receipts.write(r);
 const wrongKind=await h.access.nativePackage({tenant:PERSONAL,operationUuid,operationKey});assert.equal(wrongKind.error.code,'OPERATION_RECEIPT_MISMATCH');assert.equal(auth,0);
});

test('native build status and logs use the application and environment from the same receipt',async t=>{
 const h=harness({apiClient:true});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
 const operationUuid=uuid(),operationKey=uuid(),target={environmentKey:uuid(),applicationKey:uuid(),buildKey:uuid(),revision:2,mobilePlatform:'Android',mobileVersionNumber:'0.1.0',mobileVersionCode:1};
 const r=h.access.receipts.reserve({operationUuid,identity:{kind:'odc-public',tenant:PERSONAL,operationId:'native-application-orchestration-service-api-v1:post:/build-operations',target},wordsSha256:'synthetic',plan:{}});h.access.receipts.settle(r,{state:'accepted',response:{key:operationKey}});
 const calls=[];h.access.read=async input=>{calls.push(input);assert.deepEqual(input.query,{environmentKey:target.environmentKey,applicationKey:target.applicationKey});return {ok:true,tenant:PERSONAL,data:input.operationId.endsWith('/log-messages')?{results:[]}:{key:operationKey,...target,status:'Finished'}};};
 const out=await h.access.operationStatus({tenant:PERSONAL,kind:'native-build',operationKey,operationUuid,messages:true});assert.equal(out.receipt.state,'confirmed');assert.equal(calls.length,2);
 await assert.rejects(h.access.operationStatus({tenant:PERSONAL,kind:'native-build',operationKey}),e=>e.code==='OPERATION_RECEIPT_MISMATCH');assert.equal(calls.length,2);
});


test('owned evaluation run is a durable single submission and deletion proves absence',async t=>{
 for(const lost of [false,true]){
  const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
  const originId=uuid(),id=uuid(),datasetId=uuid(),portfolioKey=uuid(),judgeId=uuid(),runId=uuid(),words='Own evaluation cycle';
  const source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own fixture grant'};
  const dataset={DatasetId:datasetId,TestCases:{List:[{Name:'Synthetic'}]}};
  const e={EvalId:id,Name:'OwnEval',Description:'Synthetic',DatasetId:datasetId,PortfolioKey:portfolioKey,Judges:{List:[{Id:judgeId}]},LastRunAt:'1900-01-01T00:00:00'};
  const expected={name:e.Name,description:e.Description,datasetId,portfolioKey,judgeIds:[judgeId],datasetSha256:evaluationHash(dataset)};
  const proposal=path.join(h.dir,'eval.md');fs.writeFileSync(proposal,'Single run and cleanup');
  const file=path.join(h.dir,'eval.json'),p={EvaluationId:id};let running=false,foreign=false,deleted=false,sends=0;
  const context=operation=>fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
   proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},scope:[{lane:'odc',host:CORPORATE,operation,targets:[e.Name]}],
   constraints:{originOperationUuid:originId,evaluationId:id,portfolioKey,inputSha256:evaluationHash(p),expectedEvaluationSha256:evaluationHash(e)}}));
  const lookup=h.access.receipts.lookup.bind(h.access.receipts);
  h.access.receipts.lookup=(key,...args)=>key===originId?{state:'confirmed',identity:{tenant:CORPORATE,operationId:EVALUATION_CREATE},response:{EvalId:id},reconciliation:{evaluation:expected},authorization:{source,wordsSha256:crypto.createHash('sha256').update(words).digest('hex')}}:lookup(key,...args);
  h.access.portalRead=async req=>{
   if(req.operationId==='agents.evaluation')return {ok:true,data:{NotFound:deleted,Evaluation:{...e,DatasetId:foreign?uuid():datasetId},Dataset:{DatasetId:''}}};
   if(req.operationId==='agents.dataset')return {ok:true,data:{NotFound:false,Dataset:dataset}};
   if(req.operationId==='agents.evaluationOngoingRun'){assert.equal(req.input.screenVariables.GetEvaluation.Evaluation.EvalId,id);assert.equal(req.input.screenVariables.GetEvaluation.DataFetchStatus,1);return{ok:true,data:{OngoingRun:{IsRunning:running}}};}
   if(req.operationId==='agents.evaluationDevStage')return{ok:true,data:{StageKey:ENV1,Stages:{List:[{Stage:{Key:ENV1,PortfolioKey:portfolioKey,Purpose:'Development',Status:'Ready'},OptionsItems:{IsDisabled:false}}]}}};
   throw Error('Unexpected read');
  };
  h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async req=>{
   sends++;assert.equal(JSON.parse(fs.readFileSync(h.access.receipts.file(req.operationUuid))).state,'sending');
   if(req.operationId==='agents.evaluationDelete'){deleted=true;return{data:{}};}
   if(lost)throw new OdcError('NETWORK_ERROR','Synthetic lost response',{sent:true});
   return{data:{EvaluationRunId:runId,BlockedByOngoingRun:false}};
  }}});
  context('agents.evaluationRunCreate');const args={tenant:CORPORATE,confirmTenant:CORPORATE,operationId:'agents.evaluationRunCreate',input:{inputParameters:p},authorize:words,operationUuid:uuid(),authorizationContext:file};
  running=true;assert.equal((await h.access.portalWrite(args)).sent,false);running=false;
  foreign=true;assert.equal((await h.access.portalWrite(args)).sent,false);foreign=false;assert.equal(sends,0);
  const result=await h.access.portalWrite(args);assert.equal(result.receipt.state,lost?'uncertain':'accepted',JSON.stringify(result));
  if(!lost)assert.equal(result.receipt.response.EvaluationRunId,runId);
  await h.access.portalWrite(args);assert.equal(sends,1);
  const second=await h.access.portalWrite({...args,operationUuid:uuid(),target:{bypass:true}});assert.equal(second.error.code,lost?'TARGET_PENDING':'ONE_SHOT_ALREADY_RESERVED');assert.equal(sends,1);
  if(!lost){context('agents.evaluationDelete');const removed=await h.access.portalWrite({...args,operationId:'agents.evaluationDelete',operationUuid:uuid()});assert.equal(removed.receipt.state,'confirmed',JSON.stringify(removed));assert.equal(removed.deletionConfirmed,true);assert.equal(sends,2);}
 }
});


test('ongoing evaluation reads replace caller dependencies with the exact live detail',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const id=uuid(),portfolioId=uuid(),calls=[];let foreign=false;
 h.access.resolvePortal=async()=>({path:'vault',host:PERSONAL,broker:{callScreenservice:async req=>{
  calls.push(req.operationId);
  if(req.operationId==='agents.evaluation')return{data:{NotFound:false,Evaluation:{EvalId:id,PortfolioKey:foreign?uuid():portfolioId},Dataset:{Name:'Owned'}}};
  assert.equal(req.input.screenVariables.GetEvaluation.Evaluation.EvalId,id);assert.equal(req.input.screenVariables.GetEvaluation.DataFetchStatus,1);
  return{data:{OngoingRun:{IsRunning:false}}};
 }}});
 const args={tenant:PERSONAL,operationId:'agents.evaluationOngoingRun',input:{screenVariables:{id,portfolioId,GetEvaluation:{Evaluation:{EvalId:'fabricated'}}}}};
 assert.equal((await h.access.portalRead(args)).ok,true);assert.deepEqual(calls,['agents.evaluation','agents.evaluationOngoingRun']);
 foreign=true;const denied=await h.access.portalRead(args);assert.equal(denied.error.code,'EVALUATION_BASELINE_UNVERIFIED');assert.equal(calls.length,3);
});

test('evaluation completion reconciliation binds original run and does not infer case success',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const operationUuid=uuid(),id=uuid(),runId=uuid(),words='Own single evaluation run';
 const r=h.access.receipts.reserve({operationUuid,identity:{kind:'odc-portal',tenant:PERSONAL,operationId:'agents.evaluationRunCreate',target:{evaluationId:id}},wordsSha256:crypto.createHash('sha256').update(words).digest('hex'),plan:{},once:true});
 h.access.receipts.settle(r,{state:'accepted',response:{EvaluationRunId:runId,BlockedByOngoingRun:false}});
 let finished=false,reads=0;h.access.portalRead=async()=>{reads++;return{ok:true,data:{HasFinished:finished,Status:finished?'FAIL':'EVALUATING'}}};
 const reconcile={state:'confirmed',authorize:words,read:{operationId:'agents.evaluationRunStatus',input:{inputParameters:{EvaluationId:id,EvaluationRunId:runId}}}};
 assert.equal((await h.access.receipt({operationUuid,reconcile:{...reconcile,read:{...reconcile.read,input:{inputParameters:{EvaluationId:id,EvaluationRunId:uuid()}}}}})).error.code,'EVALUATION_RUN_IDENTITY_UNVERIFIED');assert.equal(reads,0);
 assert.equal((await h.access.receipt({operationUuid,reconcile})).code,'EVALUATION_RUN_PENDING');finished=true;
 assert.equal((await h.access.receipt({operationUuid,reconcile})).receipt.state,'confirmed');
 assert.equal(h.access.receipts.lookup(operationUuid).reconciliations[0].observation.caseSuccessNotInferred,true);
});


test('native dataset pagination mirrors client filters and collects disjoint scoped pages',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const calls=[];
 h.access.resolvePortal=async()=>({path:'vault',host:PERSONAL,broker:{callScreenservice:async req=>{
  calls.push(req.input);assert.equal(req.input.clientVariables.Dataset_SearchKeyword,'Owned');const offset=Number(req.input.screenVariables.PaginationStartIndex);
  return{data:{Datasets:{List:Array.from({length:offset===0?8:1},(_,n)=>({DatasetId:'d'+(offset+n),Name:'Owned'+(offset+n)}))},Page:{Total:'9',Limit:'0',Offset:'0',NextPageOffset:'0',HasMore:false},MaxRecords:8}};
 }}});
 const args={tenant:PERSONAL,operationId:'agents.datasets',input:{screenVariables:{PortfolioKey:ASSET1,PaginationStartIndex:0,DatasetOrAgentNameContains:'Owned'}}};
 const r=await h.access.portalRead(args);assert.equal(r.complete,true);assert.equal(r.count,9);assert.equal(r.pages,2);assert.equal(r.rows[8].DatasetId,'d8');assert.equal(r.data.Datasets.List.length,8);assert.equal(r.wirePaginationVerified,false);assert.deepEqual(calls.map(x=>x.screenVariables.PaginationStartIndex),[0,8]);
 const one=await h.access.portalRead({...args,maxPages:1});assert.equal(one.complete,false);assert.equal(one.continuation.arguments.input.screenVariables.PaginationStartIndex,8);
 const mismatch=await h.access.portalRead({...args,input:{...args.input,clientVariables:{Dataset_SearchKeyword:'Other'}}});assert.equal(mismatch.error.code,'INPUT_INVALID');assert.equal(calls.length,3);
});


test('native evaluation pagination uses its own page size and refuses a repeated page',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));let repeat=false;
 h.access.resolvePortal=async()=>({path:'vault',host:PERSONAL,broker:{callScreenservice:async req=>{
  assert.equal(req.input.clientVariables.Evaluation_SearchKeyword,'OwnEval');const offset=repeat?0:Number(req.input.screenVariables.PaginationStartIndex);
  return{data:{Evaluations:{List:Array.from({length:Math.min(15,16-offset)},(_,n)=>({EvalId:'e'+(offset+n),Name:'OwnEval'+(offset+n)}))},Page:{Total:'16',Limit:'0',Offset:'0',NextPageOffset:'0',HasMore:false},MaxRecords:15}};
 }}});
 const args={tenant:PERSONAL,operationId:'agents.evaluations',input:{screenVariables:{PaginationStartIndex:0,EvaluationNameContains:'OwnEval'}}};
 const r=await h.access.portalRead(args);assert.equal(r.complete,true);assert.equal(r.count,16);assert.equal(r.pages,2);assert.equal(r.data.Evaluations.List.length,15);
 repeat=true;const bad=await h.access.portalRead(args);assert.equal(bad.complete,false);assert.equal(bad.paginationVerified,false);assert.equal(bad.count,15);
});


test('native false dependency response is preserved but independent current detail proves a link',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const datasetId=uuid(),portfolio=uuid(),evalId=uuid(),calls=[];let linked=true;
 h.access.resolvePortal=async()=>({path:'vault',host:PERSONAL,broker:{callScreenservice:async request=>{
  calls.push(request.operationId);
  if(request.operationId==='agents.datasetEvaluations')return {data:{HasConnectedEvaluations:false}};
  if(request.operationId==='agents.dataset')return {data:{NotFound:false,Dataset:{DatasetId:datasetId,PortfolioKey:portfolio}}};
  if(request.operationId==='agents.evaluations')return {data:{Evaluations:{List:linked?[{EvalId:evalId,Name:'OwnEvaluation',DatasetId:''}]:[]},Page:{Total:linked?'1':'0',Limit:'0',Offset:'0',NextPageOffset:'0',HasMore:false},MaxRecords:15}};
  assert.equal(request.operationId,'agents.evaluation');assert.equal(request.input.screenVariables.id,evalId);return {data:{NotFound:false,Evaluation:{EvalId:evalId,DatasetId:datasetId,PortfolioKey:portfolio}}};
 }}});
 const args={tenant:PERSONAL,operationId:'agents.datasetEvaluations',input:{screenVariables:{DatasetId:datasetId,_datasetIdInDataFetchStatus:1}}};
 const positive=await h.access.portalRead(args);assert.equal(positive.ok,true);assert.equal(positive.data.HasConnectedEvaluations,false);assert.equal(positive.dependencyState.hasConnectedEvaluations,true);assert.equal(positive.dependencyState.nativeContradiction,true);
 assert.deepEqual(calls,['agents.datasetEvaluations','agents.dataset','agents.evaluations','agents.evaluation']);
 linked=false;const absent=await h.access.portalRead(args);assert.equal(absent.dependencyState.verified,true);assert.equal(absent.dependencyState.hasConnectedEvaluations,false);assert.equal(absent.dependencyState.evaluationsChecked,0);
});


test('run inventory derives native filters and collects disjoint client row identities',async t=>{
 const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const portfolio=uuid(),ids=Array.from({length:9},uuid),offsets=[];
 h.access.resolvePortal=async()=>({path:'vault',host:PERSONAL,broker:{callScreenservice:async request=>{
  if(request.operationId==='agents.evaluations')return {data:{Evaluations:{List:ids.map((EvalId,n)=>({EvalId,Name:'OwnedRunEval'+n}))},Page:{Total:'9',Limit:'0',Offset:'0',NextPageOffset:'0',HasMore:false},MaxRecords:15}};
  assert.equal(request.operationId,'agents.evaluationRuns');assert.deepEqual(request.input.screenVariables.FilteredEvalIds.List,ids.map(Id=>({Id})));
  const offset=request.input.screenVariables.PaginationStartIndex;offsets.push(offset);
  return {data:{EvaluationRuns:{List:ids.slice(offset,offset+8).map((EvalId,n)=>({EvalRunId:'',EvalId,EvalName:'OwnedRunEval'+(offset+n),StartedAt:'2026-10-10T06:00:00Z'}))},Page:{Total:'9',Limit:'0',Offset:'0',NextPageOffset:'0',HasMore:false},MaxRecords:8}};
 }}});
 const r=await h.access.portalRead({tenant:PERSONAL,operationId:'agents.evaluationRuns',input:{screenVariables:{PortfolioKey:portfolio,EvalNameContains:'OwnedRun',DateTimeIsPreset:false,DateTimeStart:'2026-10-10T00:00:00Z',DateTimeEnd:'2026-10-11T00:00:00Z'}}});
 assert.equal(r.ok,true);assert.equal(r.complete,true);assert.equal(r.count,9);assert.equal(r.pages,2);assert.equal(r.nativeRunIdsVerified,false);assert.equal(r.listIdentityKind,'client-evaluation-and-start-time');assert.equal(r.data.EvaluationRuns.List.length,8);assert.equal(r.rows.every(x=>x.EvalRunId===''),true);assert.deepEqual(offsets,[0,8]);
});


test('custom search journal precedes dispatch, gates save and reconciles a lost response without replay',async t=>{
 for(const lost of [false,true]){
  const h=harness();t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
  const words='Synthetic own search grant',source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own fixture'};
  const serviceAssetKey=uuid(),serviceOriginOperationUuid=uuid(),originOperationUuid=uuid(),connectionId=uuid();
  const plan=customSearchConnectionPlan({name:'OwnSearch',portfolioKey:uuid(),stage:{Key:uuid(),Name:'Development',Purpose:'Development'},endpointURL:'https://example-dev.outsystems.app/OwnService/rest/Search/CustomAISearch'});
  const proposal=path.join(h.dir,'search.md');fs.writeFileSync(proposal,'Own search cycle');
  const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
  const lookup=h.access.receipts.lookup.bind(h.access.receipts);
  h.access.receipts.lookup=(key,...rest)=>key===serviceOriginOperationUuid?{state:'confirmed',identity:{kind:'odc-public',tenant:CORPORATE,operationId:'asset-repository-api-v1:post:/assets',target:{name:'OwnService'}},response:{assetKey:serviceAssetKey},authorization:{wordsSha256:hash(words),source}}:lookup(key,...rest);
  h.access.read=async r=>r.path?.assetKey===connectionId?{ok:true,data:r.operationId.startsWith('asset-repository')?{name:'OwnSearch'}:{results:[]}}:r.operationId.startsWith('asset-repository')?{ok:true,data:{assetKey:serviceAssetKey,name:'OwnService',assetType:'WebApplication',portfolioKey:plan.details.ConnectionDetails_Header.PortfolioKey}}
   :r.operationId.startsWith('portfolio')?{ok:true,data:{results:[{key:plan.stageKey,builtinDomain:'example-dev.outsystems.app'}]}}:{ok:true,data:{revisionDeployed:2}};
  let status='Running',saved=false,missingId=false,gone=false;const sends=[];
  h.access.portalRead=async r=>r.operationId==='monitoring.stages'?{ok:true,truncated:false,rows:[{Key:plan.stageKey,Name:'Development',Purpose:'Development'}]}
   :r.operationId==='connections.list'?{ok:true,truncated:false,rows:[]}
   :r.operationId==='connections.testStatus'?{ok:true,data:{Status:{Results:{List:[{StageKey:plan.stageKey,Status:status}]}}}}
   :{ok:true,data:saved&&!gone?{NotFound:false,Connection:{connectionId,providerId:'customAISearch',name:'OwnSearch',description:'',portfolioKey:plan.details.ConnectionDetails_Header.PortfolioKey,
     stageConfigurations:[{stageKey:plan.stageKey,customSearch:{endpointSha256:fingerprint(plan.details.ConnectionDetail_StageConfig.List[0].EndpointURL),headersEmpty:true,headerNamesEmpty:true}}]}}:{NotFound:true,Connection:null}};
  h.access.resolvePortal=async()=>({path:'vault',host:CORPORATE,broker:{callScreenservice:async r=>{
   const persisted=JSON.parse(fs.readFileSync(h.access.receipts.file(r.operationUuid),'utf8'));
   assert.equal(persisted.state,'sending');
   if(r.operationId==='connections.delete')assert.equal(persisted.reconciliation.customSearchDeletion.connectionId,connectionId);
   else {assert.equal(persisted.reconciliation.customSearchConnection.planSha256,plan.planSha256);assert.equal(persisted.reconciliation.customSearchConnection.serviceAssetKey,serviceAssetKey);}
   sends.push(r.operationId);
   if(r.operationId==='connections.delete'){gone=true;if(lost)throw new OdcError('NETWORK_ERROR','Lost deletion',{sent:true});return {data:{}};}
   if(r.operationId===CUSTOM_SEARCH_TEST)return {data:missingId?{}:{Out_ConnectionId:connectionId}};
   saved=true;if(lost)throw new OdcError('NETWORK_ERROR','Lost response',{sent:true});return {data:{}};
  }}});
  const request=(operationId,input,operationUuid)=>{
   const file=path.join(h.dir,operationUuid+'.json');fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,
    proposal:{file:proposal,sha256:hash(fs.readFileSync(proposal))},scope:[{lane:'odc',host:CORPORATE,operation:operationId,environmentKey:plan.stageKey,targets:['OwnSearch']}],
    constraints:{planSha256:plan.planSha256,inputSha256:hash(JSON.stringify(input.inputParameters)),serviceAssetKey,serviceOriginOperationUuid,...(operationId===CUSTOM_SEARCH_SAVE?{originOperationUuid,connectionId}:{})}}));
   return {tenant:CORPORATE,confirmTenant:CORPORATE,operationId,input,operationUuid,authorize:words,authorizationContext:file};
  };
  const testRequest=request(CUSTOM_SEARCH_TEST,plan.testInput,originOperationUuid);
  const tested=await h.access.portalWrite(testRequest);assert.equal(tested.receipt?.state,'accepted',JSON.stringify(tested));
  assert.equal((await h.access.portalWrite(testRequest)).existingReceipt,true);assert.equal(sends.length,1);
  const saveRequest=request(CUSTOM_SEARCH_SAVE,customSearchSaveInput(plan,connectionId,plan.planSha256),uuid());
  const blocked=await h.access.portalWrite(saveRequest);assert.equal(blocked.error.code,'CONNECTION_TEST_NOT_CONFIRMED');assert.equal(lookup(saveRequest.operationUuid),null);
  status='Success';const result=await h.access.portalWrite(saveRequest);assert.equal(result.receipt?.state,'confirmed',JSON.stringify(result));assert.equal(result.readBack.verified,true);assert.equal(result.ok,true);
  if(lost)assert.ok(result.writeError);assert.deepEqual(sends,[CUSTOM_SEARCH_TEST,CUSTOM_SEARCH_SAVE]);
  assert.equal((await h.access.portalWrite(saveRequest)).existingReceipt,true);assert.equal(sends.length,2);
  assert.equal((await h.access.portalWrite({...saveRequest,authorize:'Changed authorization'})).error.code,'AUTHORIZATION_CONTEXT_INVALID');
  const baseline=(await h.access.portalRead({operationId:'connections.detail'})).data.Connection;
  baseline.externalMetadata={selectedObjectCount:0,selectedActionCount:1};
  const beforeDeletionRead=h.access.portalRead;
  h.access.portalRead=async r=>{const result=await beforeDeletionRead(r);if(r.operationId==='connections.detail'&&result.data?.Connection)result.data.Connection.externalMetadata={selectedObjectCount:0,selectedActionCount:1};return result;};
  const deleteUuid=uuid(),deleteInput={inputParameters:{ConnectionId:connectionId,ProviderId:'customAISearch',ConsoleProviderId:''}};
  const deleteRequest=request('connections.delete',deleteInput,deleteUuid),deleteContext=JSON.parse(fs.readFileSync(deleteRequest.authorizationContext));
  deleteContext.constraints={originOperationUuid,connectionId,planSha256:plan.planSha256,expectedStateSha256:fingerprint(baseline)};
  fs.writeFileSync(deleteRequest.authorizationContext,JSON.stringify(deleteContext));
  const deleted=await h.access.portalWrite(deleteRequest);assert.equal(deleted.receipt?.state,'confirmed',JSON.stringify(deleted));assert.equal(deleted.readBack.absent,true);assert.equal(deleted.ok,true);
  assert.equal((await h.access.portalWrite(deleteRequest)).existingReceipt,true);assert.equal(sends.length,3);
  missingId=true;const uncertain=await h.access.portalWrite(request(CUSTOM_SEARCH_TEST,plan.testInput,uuid()));
  assert.equal(uncertain.receipt.state,'uncertain');assert.equal(uncertain.error.code,'CUSTOM_SEARCH_IDENTITY_UNVERIFIED');
  const pending=h.access.receipts.lookup(uncertain.receipt.operationUuid);assert.equal(pending.response.Out_ConnectionId,undefined);
 }
});

test('hosted: only the customer\'s Studio session; api-client, portal-credential, the vault and the prompt of the server are refused', async () => {
  const h = harness({ hosted: true, apiClient: true, portalAccount: true });
  const refused = await h.access.read({ tenant: PERSONAL, auth: 'api-client', operationId: ASSETS });
  assert.equal(refused.ok, false); assert.equal(refused.code, 'HOSTED_STUDIO_SESSION_ONLY');
  // auto is the Studio session, as it is locally when the Studio is signed in.
  assert.equal((await h.access.read({ tenant: PERSONAL, operationId: ASSETS })).ok, true);
  assert.equal(portalCalls(h.calls).length, 1);
  // No session on the tenant: the Studio refusal, never the vault, the API Client or the prompt.
  const other = await h.access.read({ tenant: OTHER, operationId: ASSETS });
  assert.equal(other.code, 'STUDIO_NOT_SIGNED_IN');
  assert.equal((await h.access.portalRead({ tenant: PERSONAL, auth: 'portal-credential', operationId: 'monitoring.stages' })).code, 'HOSTED_STUDIO_SESSION_ONLY');
  assert.equal((await h.access.portalLogin({ tenant: PERSONAL, auth: 'portal-credential' })).code, 'HOSTED_STUDIO_SESSION_ONLY');
  assert.equal((await h.access.portalLogin({ tenant: OTHER })).code, 'STUDIO_NOT_SIGNED_IN');
  assert.equal((await h.access.openPrompt('portal', PERSONAL)).code, 'HOSTED_PROMPT_UNAVAILABLE');
  const noStudio = harness({ hosted: true, running: false, apiClient: true, portalAccount: true });
  const closed = await noStudio.access.read({ tenant: PERSONAL, operationId: ASSETS });
  assert.equal(closed.code, 'STUDIO_NOT_CONNECTED'); assert.doesNotMatch(closed.error.message, /vault/);
  const status = await noStudio.access.authStatus();
  for (const tenant of status.tenants) {
    assert.equal(tenant.apiClient.available, null); assert.equal(tenant.portal.account.available, null);
    assert.ok(!['vault', 'prompt'].includes(tenant.resolves.public) && !['vault', 'prompt'].includes(tenant.resolves.portal));
  }
  assert.match(status.order, /Hosted/);
  for (const x of [h, noStudio]) { assert.deepEqual(x.vaultAsked, []); assert.deepEqual(x.prompts, []); assert.deepEqual(x.vaultCalls, []); assert.deepEqual(x.brokers, []); }
});

// servidor/fase4-24 (PLANO-24-PRODUCAO 2.2): odc_configurations with a mobile secret (scope mobile-extensibility,
// vaultSettings) is allowed hosted because the secret is an entry of the user's OWN vault, read by the user's bridge
// inside their ODC Studio (secretRefs): the server never asks its vault (the entry is absent there) and never prompts. A
// select-profile is refused hosted before any profile.
test('hosted: a mobile secret goes as a secretRef to the user\'s bridge; no vault, prompt or profile of the server', async t => {
  const environmentKey=uuid(),originId=uuid(),settingKey=uuid(),words='Synthetic own mobile fixture grant';const sentRefs=[];
  const field={key:settingKey,name:'SSAMSecret',isSecret:true,dataType:'Text',value:'[REDACTED]',defaultValue:'[REDACTED]',valueOrigin:'Default',metadata:null};
  const current={settings:[field],libraries:[]},source={kind:'human-conversation',threadId:uuid(),messageId:uuid(),question:'Own mobile fixture'};
  const selected=[];
  const h=harness({hosted:true,sessions:[{host:CORPORATE,loggedIn:true,user:'test@example.test'}],apiClient:true,portalAccount:false,
    profiles:{select:async(...a)=>{selected.push(a);return {ok:true};}},portalCall:request=>{
    if(request.method!=='PATCH')return {ok:true,status:200,body:structuredClone(request.path.includes('/assets/')?{assetKey:ASSET1,assetType:'MobileApplication',name:'Proof'}:current)};
    sentRefs.push(request.secretRefs);field.valueOrigin='Override';return {ok:true,status:204,body:null};
  }});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));
  const lookup=h.access.receipts.lookup.bind(h.access.receipts);
  h.access.receipts.lookup=(id,...rest)=>id===originId?{state:'confirmed',identity:{tenant:CORPORATE,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:ASSET1},authorization:{source}}:lookup(id,...rest);
  const proposal=path.join(h.dir,'proof.md'),file=path.join(h.dir,'approval.json');fs.writeFileSync(proposal,'Own mobile synthetic secret');
  const body={settings:[{key:settingKey,value:''}]},refs=[{pointer:'/settings/0/value',target:'SSAM/ODC3/'+CORPORATE+'/Setting/Synthetic',field:'password'}];
  fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
    scope:[{lane:'odc',host:CORPORATE,operation:MOBILE_EXTENSIBILITY_PATCH,targets:['Proof'],environmentKey}],
    constraints:{originOperationUuid:originId,bodySha256:mobileConfigurationHash(body),expectedConfigurationSha256:extensibilityStateHash(current),secretRefsSha256:mobileConfigurationHash(refs)}}));
  const args={tenant:CORPORATE,scope:'mobile-extensibility',action:'set',assetKey:ASSET1,environmentKey,authorize:words,confirmTenant:CORPORATE,operationUuid:uuid(),
    originOperationUuid:originId,authorizationContext:file,vaultSettings:{SSAMSecret:'Synthetic'}};
  const out=await h.access.configurations(args);
  assert.equal(out.receipt?.state,'confirmed',JSON.stringify(out));
  assert.deepEqual(sentRefs,[refs],'the PATCH names the entry of the user\'s vault; the bridge reads it');
  const without=await h.access.configurations({...args,auth:'api-client',operationUuid:uuid()});
  assert.equal(without.code,'STUDIO_REQUIRED');assert.equal(sentRefs.length,1);
  const select=await h.access.portalLogin({tenant:CORPORATE,auth:'auto',action:'select-profile',profile:{target:'SSAM/ODC3/'+CORPORATE+'/Portal',principal:'test@example.test'},authorize:'select '+CORPORATE});
  assert.equal(select.code,'HOSTED_STUDIO_SESSION_ONLY');assert.deepEqual(selected,[]);
  assert.deepEqual(h.vaultAsked,[]);assert.deepEqual(h.prompts,[]);assert.deepEqual(h.vaultCalls,[]);assert.deepEqual(h.brokers,[]);
});

// servidor/fase4-25 (marco-a5 merge, rule 17 of C:\t\vps-a5\PLANO.md): the product's private credential window (action
// prompt and focus of odc_portal_login, the verified window of openPrompt) never opens hosted: HOSTED_PROMPT_UNAVAILABLE
// before the Studio, the vault, the profiles or the prompt collaborator are asked.
test('hosted: odc_portal_login prompt and focus answer HOSTED_PROMPT_UNAVAILABLE before the Studio, the vault or a profile', async () => {
  const resolved = [];
  const h = harness({ hosted: true, apiClient: true, portalAccount: true, profiles: { resolve: async (...a) => { resolved.push(a); return { ok: true }; } } });
  for (const action of ['prompt', 'focus']) {
    const value = await h.access.portalLogin({ tenant: PERSONAL, action });
    assert.equal(value.ok, false, action);
    assert.equal(value.code, 'HOSTED_PROMPT_UNAVAILABLE', action + ': ' + JSON.stringify(value).slice(0, 300));
  }
  for (const action of ['ensure', 'focus', 'status']) assert.equal((await h.access.openPrompt('portal', PERSONAL, undefined, undefined, action)).code, 'HOSTED_PROMPT_UNAVAILABLE', action);
  assert.deepEqual(h.calls, [], 'the Studio was not read');
  assert.deepEqual(h.vaultAsked, []); assert.deepEqual(h.prompts, []); assert.deepEqual(resolved, []); assert.deepEqual(h.brokers, []);
});
