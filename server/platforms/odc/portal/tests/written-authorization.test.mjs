// R2-I (owner's rule, 28/10: "A aprovação deve ser expressa por escrito no chat. Qualquer registro técnico deve ser gerado
// internamente pelo MCP, sem exigir arquivo do usuário."): every ODC write that used to REQUIRE an authorizationContext file
// takes the user's written words naming its targets instead. No test here writes an approval file: SSAM builds the record
// itself (hashes only), finds the receipts a step binds in its own journal (find) and keeps the evidence a recovery needs.
// Words that do not name a target are refused (WORDS_MUST_NAME) and nothing is sent; every other check stays.
import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {a2aDiscoveryApproval} from '../runtime/a2a-discovery.mjs';
import {a2aConnectionPlan,a2aSaveInput} from '../runtime/a2a-connection-plan.mjs';
import {a2aConnectionApproval,A2A_TEST,A2A_SAVE} from '../runtime/a2a-connection-approval.mjs';
import {customSearchConnectionPlan,customSearchSaveInput} from '../runtime/custom-search-connection-plan.mjs';
import {customSearchConnectionApproval,CUSTOM_SEARCH_TEST,CUSTOM_SEARCH_SAVE} from '../runtime/custom-search-connection-approval.mjs';
import {ownedCleanupApproval,withValidatedReply} from '../runtime/owned-cleanup-approval.mjs';
import {dbDeleteApproval,dbEntityApproval} from '../runtime/db-connection-approval.mjs';
import {apiClientWriteApproval} from '../runtime/api-client-pending-cleanup.mjs';
import {API_CLIENT_CREATE,API_CLIENT_DELETE} from '../runtime/api-client-fixture.mjs';
import {AI_TRIAL_CREATE,AI_TRIAL_DELETE,aiModelTrialApproval} from '../runtime/ai-model-trial.mjs';
import {KB_CREATE,KB_DELETE,knowledgeBaseApproval} from '../runtime/knowledge-base.mjs';
import {GUARDRAILS_SAVE,guardrailsApproval,guardrailValues,guardrailReadInput} from '../runtime/guardrails.mjs';
import {guardrailPolicies,wordGuardrail} from './guardrail-fixture.mjs';
import {EVALUATION_CREATE,EVALUATION_RUN,EVALUATION_DELETE,evaluationOperationApproval} from '../runtime/evaluation-fixture.mjs';
import {datasetDeleteApproval} from '../runtime/dataset-delete-approval.mjs';
import {datasetReconciliationInput} from '../runtime/dataset-receipt.mjs';
import {mobileBinaryUploadApproval,mobileBinaryContent,MOBILE_FILE_UPLOAD} from '../runtime/mobile-binary-upload.mjs';
import {mobileBinarySaveApproval} from '../runtime/mobile-binary-save.mjs';
import {guardTenant} from '../runtime/access.mjs';
import {sha256,fingerprint} from '../runtime/write-journal.mjs';

const id=()=>crypto.randomUUID();
const host='example.outsystems.dev';
const words=text=>text;
const missing=code=>e=>e.code===code;
// A journal of receipts, as WriteJournal.find answers it.
const journal=(...receipts)=>({lookup:key=>receipts.find(r=>r.operationUuid===key)??null,find:predicate=>receipts.filter(r=>predicate(r))});
const written=approval=>{assert.deepEqual(approval.source,{kind:'human-words'});assert.equal(approval.file,null);assert.match(approval.wordsSha256,/^[a-f0-9]{64}$/);};

test('an agent card discovery and a new A2A connection test and save take the written words naming the connection; the save finds its own test receipt',async()=>{
 const stage={Key:id(),Name:'Development',Purpose:'Development'};
 const card={protocolVersion:'0.3.0',name:'Proof',description:'Constant response',version:'1',url:'https://example.test/rpc',capabilities:{streaming:false},
  defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[{id:'proof',name:'Proof',description:'Constant',tags:['test']}]};
 const plan=a2aConnectionPlan({name:'OwnedA2A',agentUrl:'https://example.test/agent/',portfolioKey:id(),stage,card});
 const read=async op=>op==='monitoring.stages'?{ok:true,rows:[{...stage,Key:plan.stageKey}]}:op==='connections.list'?{ok:true,truncated:false,rows:[]}
  :{ok:true,data:{Status:{Results:{List:[{StageKey:plan.stageKey,Status:'Success'}]}}}};
 const discovery=await a2aDiscoveryApproval({words:'Discover the agent card for OwnedA2A',host,scope:{connectionName:'OwnedA2A'},read,
  raw:{inputParameters:{AgentDiscovery:{url:'https://example.test/agent/',environmentId:plan.stageKey}}}});
 written(discovery.approval);assert.equal(discovery.expected.name,'OwnedA2A');
 await assert.rejects(a2aDiscoveryApproval({words:'Discover the agent card',host,scope:{connectionName:'OwnedA2A'},read,
  raw:{inputParameters:{AgentDiscovery:{url:'https://example.test/agent/',environmentId:plan.stageKey}}}}),missing('WORDS_MUST_NAME'));
 const say='Create and save the A2A connection OwnedA2A';
 const tested=await a2aConnectionApproval({words:say,host,operationId:A2A_TEST,raw:plan.testInput,read});
 written(tested.approval);assert.equal(tested.approval.proposalSha256,plan.planSha256);
 await assert.rejects(a2aConnectionApproval({words:'Create the A2A connection',host,operationId:A2A_TEST,raw:plan.testInput,read}),missing('WORDS_MUST_NAME'));
 const connectionId=id();
 const origin={operationUuid:id(),state:'accepted',createdAt:'2026-10-09T20:00:00Z',identity:{kind:'odc-portal',tenant:host,operationId:A2A_TEST},
  response:{Out_ConnectionId:connectionId},reconciliation:{a2aConnection:tested.expected},authorization:{wordsSha256:tested.approval.wordsSha256,proposalSha256:plan.planSha256,source:tested.approval.source}};
 const raw=a2aSaveInput(plan,connectionId,plan.planSha256),j=journal(origin);
 const saved=await a2aConnectionApproval({words:'Save the A2A connection OwnedA2A',host,operationId:A2A_SAVE,raw,read,...j});
 written(saved.approval);assert.equal(saved.expected.originOperationUuid,origin.operationUuid);
 await assert.rejects(a2aConnectionApproval({words:'Save the A2A connection OwnedA2A',host,operationId:A2A_SAVE,raw,read,...journal()}),missing('OPERATION_RECEIPT_MISMATCH'));
});

test('a custom search test and save take the written words; SSAM finds the own service and the test receipt in its journal',async()=>{
 const plan=customSearchConnectionPlan({name:'OwnedSearch',description:'Synthetic only',portfolioKey:id(),stage:{Key:id(),Name:'Development',Purpose:'Development'},
  endpointURL:'https://example-dev.outsystems.app/OwnService/rest/Search/CustomAISearch'});
 const serviceAssetKey=id();
 const service={operationUuid:id(),state:'confirmed',identity:{kind:'odc-public',tenant:host,operationId:'asset-repository-api-v1:post:/assets',target:{name:'OwnService'}},
  response:{assetKey:serviceAssetKey},authorization:{wordsSha256:sha256('other words')}};
 const read=async op=>op==='monitoring.stages'?{ok:true,truncated:false,rows:[{Key:plan.stageKey,Name:'Development',Purpose:'Development'}]}
  :op==='connections.list'?{ok:true,truncated:false,rows:[]}:{ok:true,data:{Status:{Results:{List:[{StageKey:plan.stageKey,Status:'Success'}]}}}};
 const readPublic=async op=>op.startsWith('asset-repository')?{ok:true,data:{assetKey:serviceAssetKey,name:'OwnService',assetType:'WebApplication',portfolioKey:plan.details.ConnectionDetails_Header.PortfolioKey}}
  :op.startsWith('portfolio')?{ok:true,data:{results:[{key:plan.stageKey,builtinDomain:'example-dev.outsystems.app'}]}}:{ok:true,data:{revisionDeployed:2}};
 const tested=await customSearchConnectionApproval({words:'Test the search connection OwnedSearch',host,operationId:CUSTOM_SEARCH_TEST,raw:plan.testInput,read,readPublic,...journal(service)});
 written(tested.approval);assert.equal(tested.expected.serviceOriginOperationUuid,service.operationUuid);
 await assert.rejects(customSearchConnectionApproval({words:'Test the search connection',host,operationId:CUSTOM_SEARCH_TEST,raw:plan.testInput,read,readPublic,...journal(service)}),missing('WORDS_MUST_NAME'));
 const connectionId=id();
 const origin={operationUuid:id(),state:'accepted',createdAt:'2026-10-10T12:00:00Z',identity:{kind:'odc-portal',tenant:host,operationId:CUSTOM_SEARCH_TEST},
  response:{Out_ConnectionId:connectionId},reconciliation:{customSearchConnection:tested.expected},authorization:{wordsSha256:tested.approval.wordsSha256,source:tested.approval.source}};
 const saved=await customSearchConnectionApproval({words:'Save the search connection OwnedSearch',host,operationId:CUSTOM_SEARCH_SAVE,
  raw:customSearchSaveInput(plan,connectionId,plan.planSha256),read,readPublic,...journal(service,origin)});
 written(saved.approval);assert.equal(saved.expected.originOperationUuid,origin.operationUuid);
});

test('the cleanup of an own fixture after its preview takes the validated reply as the approval, with the preview as its proposal, and no file',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'written-cleanup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const previewFile=path.join(dir,'preview.json');fs.writeFileSync(previewFile,JSON.stringify({items:[{key:'k1',name:'OwnedThing'}]}));
 const reply='sim, apaga os 1: OwnedThing',key=id();
 const scope={host,operation:'connections.delete',targets:['OwnedThing'],constraints:{connectionId:key}};
 const origin={identity:{tenant:host}};
 const inside=fn=>withValidatedReply({host,tool:'odc_portal_write',previewId:id(),operationId:id(),previewFile,wordsSha256:sha256(reply),keys:[key]},fn);
 const approval=inside(()=>ownedCleanupApproval({words:reply,...scope,origin,key}));
 written(approval);assert.equal(approval.proposalSha256,sha256(fs.readFileSync(previewFile).toString()));
 assert.throws(()=>inside(()=>ownedCleanupApproval({words:reply,...scope,targets:['OtherThing'],origin,key})),missing('WORDS_MUST_NAME'));
});

test('a temporary connection delete and its entity changes take the written words naming the own connection',()=>{
 const connection={connectionId:id(),name:'TempConn',providerId:'mssql',externalMetadata:{selectedObjectCount:0,selectedActionCount:0},
  stageConfigurations:[{stageKey:id(),host:'sql.example.test',port:'1433',database:'Disposable',hasAdditionalParameters:false,privateGatewayPort:null}]};
 const origin={state:'accepted',identity:{kind:'odc-portal',tenant:host,operationId:'connections.relationalTest',target:{connectionName:'TempConn'}},
  response:{Out_ConnectionId:connection.connectionId},authorization:{wordsSha256:sha256('creation words')}};
 const detail={NotFound:false,Connection:connection};
 written(dbDeleteApproval(undefined,'Delete the temporary connection TempConn',{host,detail,origin}));
 written(dbEntityApproval(undefined,'Import entities into TempConn',{host,detail:{...detail,Connection:{...connection,externalMetadata:{selectedObjectCount:2,selectedActionCount:0}}},origin}));
 assert.throws(()=>dbDeleteApproval(undefined,'Delete the temporary connection',{host,detail,origin}),missing('WORDS_MUST_NAME'));
});

test('an API Client fixture creation and its delete take the written words; an uncertain creation is cleaned up from the baseline its receipt kept',async()=>{
 const name='SSAMApiClientProof20261029',creation=id(),key=id();
 const raw={inputParameters:{OIDCClientCreate:{Name:name,Description:'Own fixture',SecretExpiresAt:new Date(Date.now()+86400000).toISOString(),IsActive:true,IsSendSecretExpiryEmail:false,Permissions:{List:[]}}},screenVariables:{},clientVariables:{}};
 const baseline={ok:true,tenant:host,complete:true,requestedPageConsistencyVerified:true,requestedOffset:0,scope:{NameContains:'',Status:''},totalResults:1,rows:[{Key:id(),Name:'Existing'}]};
 const created=await apiClientWriteApproval({words:'Create the API Client '+name,host,operationId:API_CLIENT_CREATE,operationUuid:creation,raw,
  readInventory:async()=>baseline,...journal()});
 written(created.approval);assert.equal(created.expected.creationOperationUuid,creation);assert.deepEqual(created.expected.baseline.rows,baseline.rows);
 await assert.rejects(apiClientWriteApproval({words:'Create the API Client',host,operationId:API_CLIENT_CREATE,operationUuid:creation,raw,...journal()}),missing('WORDS_MUST_NAME'));
 // The delete of a proven creation: the receipt whose private proof holds the key.
 const proven={operationUuid:creation,state:'accepted',identity:{tenant:host,operationId:API_CLIENT_CREATE,target:{apiClientFixtureName:name}},
  authorization:{wordsSha256:created.approval.wordsSha256,source:created.approval.source},reconciliation:{apiClientFixture:created.expected},
  response:{ApiClientProof:{key,name,operationUuid:creation,vaultRef:'urn:ssam:api-client:'+creation,vaultStored:true,rawValueExposed:false,responseProjected:true}}};
 const removal={inputParameters:{Key:key},screenVariables:{},clientVariables:{}},say='Create the API Client '+name;
 const deleted=await apiClientWriteApproval({words:say,host,operationId:API_CLIENT_DELETE,raw:removal,...journal(proven)});
 written(deleted.approval);assert.equal(deleted.expected.key,key);
 // An uncertain creation without its private proof: the pending-header cleanup, with the receipt's own baseline.
 const pending={...proven,state:'uncertain',schema:'ssam-odc-write/1',createdAt:'2026-10-29T10:00:00.000Z',updatedAt:'2026-10-29T10:05:00.000Z',response:{}};
 const detail={ok:true,tenant:host,data:{ApiClientDetails:{Key:key,Name:name,IsActive:true,Permissions:{List:[]},CreatedAt:'2026-10-29T10:01:00.000Z'}}};
 // Outside the guard (an internal cleanup of the same request) the creation's own words; through odc_portal_write the
 // guard's validated reply to the preview is the approval (the cleanup test above).
 const cleaned=await apiClientWriteApproval({words:say,host,operationId:API_CLIENT_DELETE,raw:removal,...journal(pending),
  readDetail:async()=>detail,readInventory:async()=>({...baseline,totalResults:2,rows:[...baseline.rows,{Key:key,Name:name}]})});
 written(cleaned.approval);assert.equal(cleaned.expected.cleanupMode,'pending-header');assert.equal(cleaned.expected.creationOperationUuid,creation);
});

test('a trial model creation (portfolio in scope) and its delete (own creation found in the journal) take the written words',async()=>{
 const portfolioKey=id(),model={Id:id(),Name:'OwnTrial',PortfolioKey:portfolioKey,IsTrial:true};
 let list=[];
 const read=async(op,input)=>op==='aiModels.list'?{ok:true,data:{AIModelList:{List:list},TotalCount:String(list.length)}}
  :op==='aiModels.trials'?{ok:true,data:{AIModelTrials:{List:[{Id:'trial-x',CurrentAIModelId:''}]}}}
  :{ok:true,data:{NotFound:false,AIModel:{Id:model.Id,AssetKey:model.Id,PortfolioKey:portfolioKey,Name:'OwnTrial',IsTrial:true}}};
 const raw={inputParameters:{TrialId:'trial-x'},screenVariables:{},clientVariables:{}};
 const created=await aiModelTrialApproval({words:'Create the trial trial-x in portfolio '+portfolioKey,host,operationId:AI_TRIAL_CREATE,raw,read,scope:{portfolioKey}});
 written(created);assert.equal(created.constraints.portfolioKey,portfolioKey);
 await assert.rejects(aiModelTrialApproval({words:'Create the trial',host,operationId:AI_TRIAL_CREATE,raw,read,scope:{portfolioKey}}),missing('WORDS_MUST_NAME'));
 list=[model];
 const origin={operationUuid:id(),state:'confirmed',identity:{tenant:host,operationId:AI_TRIAL_CREATE},response:{AIModelId:model.Id},
  reconciliation:{aiModelTrial:{portfolioKey,trialId:'trial-x'}},authorization:{wordsSha256:created.wordsSha256,source:created.source}};
 const removal={inputParameters:{AIModelId:model.Id},screenVariables:{},clientVariables:{}};
 const deleted=await aiModelTrialApproval({words:'Delete OwnTrial',host,operationId:AI_TRIAL_DELETE,raw:removal,read,...journal(origin)});
 written(deleted);assert.equal(deleted.constraints.originOperationUuid,origin.operationUuid);
});

test('a knowledge base creation and its delete take the written words naming the base; the delete finds its own creation',async()=>{
 const portfolio=id(),key=id();
 const p={KnowledgeBaseCreate:{Name:'OwnedKB',Description:'Empty proof',PortfolioKey:portfolio,DataSources:{List:[{Name:'OwnedSource',Description:'Empty source',Type:'upload_files',
  ChunkingConfig:{ChunkingMethod:'Smart',ChunkSize:1000,ChunkOverlap:200,Separators:'',KeepSeparator:false}}]}}};
 const inventory=rows=>({ok:true,data:{KBListItems:{List:rows},TotalCount:String(rows.length)}});
 const read=async op=>op==='knowledgeBases.chunkingMethods'?{ok:true,data:{ChunkingMethods:{List:[{Id:'Smart'}]}}}
  :op==='knowledgeBases.createStages'?{ok:true,data:{Stages:{List:[{PortfolioKey:portfolio}]}}}:inventory([]);
 written(await knowledgeBaseApproval({words:'Create OwnedKB with the source OwnedSource',host,operationId:KB_CREATE,raw:{inputParameters:p},read}));
 await assert.rejects(knowledgeBaseApproval({words:'Create OwnedKB',host,operationId:KB_CREATE,raw:{inputParameters:p},read}),missing('WORDS_MUST_NAME'));
 const found={KnowledgeBaseId:key,Name:'OwnedKB',Status:'Ready'};
 const origin={operationUuid:id(),state:'confirmed',identity:{tenant:host,operationId:KB_CREATE},response:{KnowledgeBaseId:key},authorization:{wordsSha256:sha256('creation'),source:{kind:'human-words'}}};
 const deleted=await knowledgeBaseApproval({words:'Delete OwnedKB',host,operationId:KB_DELETE,raw:{inputParameters:{KnowledgeBaseId:key}},...journal(origin),
  read:async op=>op==='knowledgeBases.list'?inventory([found]):{ok:true,data:{ApplicationConsumers:{List:[]}}}});
 written(deleted);assert.equal(deleted.constraints.originOperationUuid,origin.operationUuid);
});

test('guardrail saves take the written words naming the agent and its element: create, then update and reset from the own receipts',async()=>{
 const p={AppId:id(),AgentElementId:id(),EnvironmentId:id(),EnvironmentName:'Development',GuardrailId:'',Policies:wordGuardrail(guardrailPolicies()),PortfolioId:id()};
 let state={GuardrailId:'',Policies:guardrailPolicies(),RegionSupportStatus:'Supported'};
 const origin={operationUuid:id(),state:'accepted',status:201,identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:p.AppId},authorization:{wordsSha256:sha256('creation'),source:{kind:'human-words'}}};
 const receipts=[origin],j={lookup:key=>receipts.find(r=>r.operationUuid===key)??null,find:predicate=>receipts.filter(r=>predicate(r))};
 const args={host,raw:{inputParameters:p},...j,
  readAsset:async()=>({ok:true,data:{assetKey:p.AppId,name:'OwnAgentApp',assetType:'Agent',portfolioKey:p.PortfolioId,revision:2}}),
  read:async op=>op==='agents.revisionStages'?{ok:true,data:{EnvironmentsApplicationVersion:{List:[{Environment:{Key:p.EnvironmentId,Name:'Development',Purpose:'Development',Status:'Ready',PortfolioKey:p.PortfolioId}}]}}}
   :op==='agents.elements'?{ok:true,data:{AgentList:{List:[{ElementKey:p.AgentElementId,Name:'OwnAgent'}]}}}:{ok:true,data:state}};
 const say='Configure the guardrails of OwnAgentApp, agent OwnAgent';
 const created=await guardrailsApproval({...args,words:say});
 written(created.approval);assert.equal(created.expected.creation,true);assert.deepEqual(created.expected.approvedTargets,['OwnAgentApp','OwnAgent']);
 await assert.rejects(guardrailsApproval({...args,words:'Configure the guardrails of OwnAgentApp'}),missing('WORDS_MUST_NAME'));
 const guardrailId=id();
 receipts.push({operationUuid:id(),state:'confirmed',identity:{tenant:host,operationId:GUARDRAILS_SAVE},response:{SavedGuardrailId:guardrailId},
  authorization:{wordsSha256:created.approval.wordsSha256,source:created.approval.source},reconciliation:{guardrails:created.expected}});
 state={...state,GuardrailId:guardrailId,Policies:guardrailValues(p.Policies)};p.GuardrailId=guardrailId;
 p.Policies=wordGuardrail(guardrailPolicies(),'Detect');
 assert.equal((await guardrailsApproval({...args,words:say})).expected.creation,false);
 p.Policies=guardrailValues(guardrailPolicies());
 assert.equal((await guardrailsApproval({...args,words:say})).expected.originalRestoration,true);
});

test('the orphan guardrail reset of a deleted own agent takes the written words and the evidence the creation kept; no original file',async()=>{
 const p={AppId:id(),AgentElementId:id(),EnvironmentId:id(),EnvironmentName:'Development',PortfolioId:id(),GuardrailId:id(),Policies:guardrailValues(guardrailPolicies())};
 const initialPolicies=wordGuardrail(guardrailPolicies());
 const auth={wordsSha256:sha256('creation'),source:{kind:'human-words'}};
 const origin={operationUuid:id(),state:'confirmed',status:201,identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:p.AppId},authorization:auth};
 const initial={operationUuid:id(),state:'confirmed',identity:{tenant:host,operationId:GUARDRAILS_SAVE},response:{SavedGuardrailId:p.GuardrailId},authorization:auth,
  reconciliation:{guardrails:{creation:true,originOperationUuid:origin.operationUuid,readInput:guardrailReadInput(p),policies:initialPolicies,
   approvedTargets:['OwnApp','OwnAgent'],beforeGuardrailSha256:fingerprintGuardrail({GuardrailId:'',Policies:p.Policies})}}};
 const deleted={operationUuid:id(),state:'confirmed',status:204,identity:{tenant:host,operationId:'asset-repository-api-v1:delete:/assets/{assetKey}',target:{assetKey:p.AppId}},authorization:auth};
 const before={GuardrailId:p.GuardrailId,Policies:initialPolicies,RegionSupportStatus:'Supported'};
 const args={host,raw:{inputParameters:p},...journal(origin,initial,deleted),readAsset:async()=>({ok:false,status:404}),read:async()=>({ok:true,data:before})};
 const reset=await guardrailsApproval({...args,words:'Reset the guardrails left by OwnApp, agent OwnAgent'});
 written(reset.approval);assert.equal(reset.expected.reset,true);
 await assert.rejects(guardrailsApproval({...args,words:'Reset the guardrails left by OwnApp'}),missing('WORDS_MUST_NAME'));
});
// The same hash guardrails.mjs uses (guardrailHash), without importing more than the module exports.
function fingerprintGuardrail(value){
 const values=v=>Array.isArray(v)?v.map(values):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).filter(k=>k!=='EmptyListItem').sort().map(k=>[k,values(v[k])])):v;
 return crypto.createHash('sha256').update(JSON.stringify(values(value))).digest('hex');
}

test('an evaluation run and delete take the written words naming the evaluation; the own creation comes from the journal',async()=>{
 const evaluationId=id(),portfolioKey=id(),datasetId=id();
 const dataset={DatasetId:datasetId,Name:'OwnDataset'};
 const expected={name:'OwnEvaluation',description:'Fixture',datasetId,portfolioKey,judgeIds:[id()],datasetSha256:crypto.createHash('sha256').update(JSON.stringify(dataset)).digest('hex')};
 const origin={operationUuid:id(),state:'confirmed',identity:{tenant:host,operationId:EVALUATION_CREATE},response:{EvalId:evaluationId},reconciliation:{evaluation:expected},
  authorization:{wordsSha256:sha256('creation'),source:{kind:'human-words'}}};
 const evaluation={Id:evaluationId,EvalId:evaluationId,Name:'OwnEvaluation',Description:'Fixture',DatasetId:datasetId,PortfolioKey:portfolioKey,LastRunAt:'1900-01-01T00:00:00',Judges:{List:expected.judgeIds.map(Id=>({Id}))}};
 const read=async op=>op==='agents.evaluation'?{ok:true,data:{NotFound:false,Evaluation:evaluation,Dataset:{DatasetId:datasetId}}}:op==='agents.dataset'?{ok:true,data:{NotFound:false,Dataset:dataset}}
  :op==='agents.evaluationOngoingRun'?{ok:true,data:{OngoingRun:{IsRunning:false}}}
  :{ok:true,data:{StageKey:'s',Stages:{List:[{Stage:{Key:'s',PortfolioKey:portfolioKey,Purpose:'Development',Status:'Ready'},OptionsItems:{IsDisabled:false}}]}}};
 const raw={inputParameters:{EvaluationId:evaluationId},screenVariables:{},clientVariables:{}};
 for(const operationId of [EVALUATION_DELETE,EVALUATION_RUN]){
  const approved=await evaluationOperationApproval({words:'Run and then delete OwnEvaluation',host,operationId,raw,read,...journal(origin)});
  written(approved.approval);assert.equal(approved.evaluationId,evaluationId);
 }
 await assert.rejects(evaluationOperationApproval({words:'Delete the evaluation',host,operationId:EVALUATION_DELETE,raw,read,...journal(origin)}),missing('WORDS_MUST_NAME'));
 await assert.rejects(evaluationOperationApproval({words:'Delete it',host,operationId:EVALUATION_RUN,raw,read,...journal()}),missing('OPERATION_RECEIPT_MISMATCH'));
});

test('a dataset delete takes the written words naming the dataset; the own creation comes from the journal',async()=>{
 const datasetId=id(),dataset={DatasetId:datasetId,Name:'OwnDataset',Description:'original'};
 const origin={operationUuid:id(),state:'accepted',identity:{tenant:host,operationId:'agents.datasetCreate'},response:{DatasetId:datasetId},authorization:{wordsSha256:sha256('creation')}};
 const read=async op=>op==='agents.dataset'?{ok:true,data:{Dataset:dataset,NotFound:false}}:{ok:true,dependencyState:{verified:true,datasetId,hasConnectedEvaluations:false}};
 const raw={inputParameters:{DatasetId:datasetId},screenVariables:{},clientVariables:{}};
 const approved=await datasetDeleteApproval({words:'Delete OwnDataset',host,raw,read,...journal(origin)});
 written(approved);assert.equal(approved.constraints.originOperationUuid,origin.operationUuid);
 await assert.rejects(datasetDeleteApproval({words:'Delete the dataset',host,raw,read,...journal(origin)}),missing('WORDS_MUST_NAME'));
});

test('a dataset whose creation answer had no id is reconciled with the original words alone: the receipt binds the words and the exact input',()=>{
 const d={Name:'OwnDataset',Description:'',AgenticAppId:id(),ServiceActionId:'a',Content:JSON.stringify([{name:'c',inputs:{},expectations:{}}]),SetupAppId:'',SetupServiceActionId:'',
  TeardownAppId:'',TeardownServiceActionId:'',PortfolioKey:id(),AssetType:''};
 const creationInput={Dataset:d,AdditionalApps:{List:[]},OverrideBaseURL:''},say='Create the dataset OwnDataset';
 const receipt={identity:{operationId:'agents.datasetCreate',tenant:host,target:{inputSha256:crypto.createHash('sha256').update(JSON.stringify(creationInput)).digest('hex')}},
  authorization:{wordsSha256:sha256(say)},response:{}};
 const read={operationId:'agents.dataset',creationInput,input:{screenVariables:{id:id(),_idInDataFetchStatus:1}}};
 const scope=datasetReconciliationInput(receipt,{state:'confirmed',read,authorize:say});
 assert.equal(scope.datasetId,read.input.screenVariables.id);assert.equal(scope.cases.length,1);
 assert.throws(()=>datasetReconciliationInput(receipt,{state:'confirmed',read,authorize:'other words'}),missing('DATASET_RECONCILIATION_UNVERIFIED'));
 assert.throws(()=>datasetReconciliationInput(receipt,{state:'confirmed',read:{...read,creationInput:{...creationInput,OverrideBaseURL:'x'}},authorize:say}),missing('DATASET_RECONCILIATION_UNVERIFIED'));
});

test('a mobile binary upload (its setting in scope) and its save (the upload found in the journal) take the written words naming the app and the setting',async()=>{
 const applicationKey=id(),environmentKey=id(),settingKey=id(),portfolioKey=id();
 const raw={inputParameters:{FileContent:Buffer.from('fixture').toString('base64')},screenVariables:{},clientVariables:{}};
 const current={settings:[{key:settingKey,name:'File',dataType:'BinaryUrl',isSecret:false,value:null,defaultValue:null,valueOrigin:'Default'}],libraries:[]};
 const origin={operationUuid:id(),state:'confirmed',identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:applicationKey},authorization:{wordsSha256:sha256('creation')}};
 const read=async op=>({ok:true,data:op.startsWith('asset-')?{assetKey:applicationKey,name:'Fixture',assetType:'MobileApplication',portfolioKey}:current});
 const portalRead=async()=>({ok:true,data:{EnableNAOSBASE64Patch:false,EnvironmentsApplicationVersion:{List:[{Environment:{Key:environmentKey,PortfolioKey:portfolioKey,Status:'Ready'}}]}}});
 const scope={applicationKey,environmentKey,settingKey,portfolioKey};
 const uploaded=await mobileBinaryUploadApproval({words:'Upload the file to the setting File of Fixture',host,raw,read,portalRead,scope,...journal(origin)});
 written(uploaded.approval);assert.equal(uploaded.expected.originOperationUuid,origin.operationUuid);assert.equal(uploaded.expected.contentSha256,mobileBinaryContent(raw.inputParameters.FileContent).contentSha256);
 await assert.rejects(mobileBinaryUploadApproval({words:'Upload it to Fixture',host,raw,read,portalRead,scope,...journal(origin)}),missing('WORDS_MUST_NAME'));
 const uploadOperationUuid=id(),objectUri='https://plat-te3423068adb743c3b12fff7faf2a4b9e.s3.us-east-1.amazonaws.com/tenants/uploads/'+id();
 const upload={operationUuid:uploadOperationUuid,state:'confirmed',identity:{tenant:host,operationId:MOBILE_FILE_UPLOAD},authorization:{wordsSha256:sha256('upload')},
  reconciliation:{mobileBinaryUpload:uploaded.expected},response:{mobileUploadProof:{uploadOperationUuid,objectUri,contentSha256:uploaded.expected.contentSha256,byteLength:uploaded.expected.byteLength,contentVerified:true,signedUriExposed:false}}};
 const native={Setting:{Key:settingKey,Name:'File',DataType:'BinaryUrl',DataTypeLabel:'Binary data',DefaultValue:'',Value:'',ValueOrigin:'Default',IsSecret:'[REDACTED]',IsMandatory:false,Metadata:{Name:'',Filetype:''}},IsFromLibrary:false,LibraryInfo:{Key:'',Revision:0,Name:''}};
 const info=structuredClone(native);Object.assign(info.Setting,{ValueOrigin:'Override',IsSecret:false,Metadata:{Name:'proof',Filetype:'txt'}});
 const save={inputParameters:{ApplicationKey:applicationKey,EnvironmentKey:environmentKey,RequiresDecoding:false,ExtensibilitySettingInfo:info},screenVariables:{},clientVariables:{}};
 const saved=await mobileBinarySaveApproval({words:'Save the file in the setting File of Fixture',host,raw:save,read,portalRead:async()=>({ok:true,data:{NotFound:false,ExtensibilitySettingInfo:native}}),...journal(origin,upload)});
 written(saved.approval);assert.equal(saved.expected.uploadOperationUuid,uploadOperationUuid);
});

test('the corporate tenant guard still needs the words to name the tenant when the approval is the written words themselves',()=>{
 const info={host:'acme.outsystems.dev',class:'corporate',readOnly:false};
 const approval={host:info.host,source:{kind:'human-words'}};
 assert.throws(()=>guardTenant(info,'Delete OwnedThing',info.host,approval),missing('CORPORATE_TENANT_GUARD'));
 assert.doesNotThrow(()=>guardTenant(info,'Delete OwnedThing on acme',info.host,approval));
});

test('a mobile app configuration of an own fixture takes the written words naming the app; its creation receipt binds it',async()=>{
 const {mobileConfigurationApproval,MOBILE_CONFIGURATION_WRITES}=await import('../runtime/mobile-configuration-approval.mjs');
 const applicationKey=id(),environmentKey=id(),originOperationUuid=id();
 const origin={state:'confirmed',identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:applicationKey},authorization:{wordsSha256:sha256('creation')}};
 const current={appIdentifier:{isSecret:false,value:null}};
 const read=async op=>({ok:true,data:op.startsWith('asset-')?{assetKey:applicationKey,assetType:'MobileApplication',name:'Proof'}:current});
 for(const operationId of MOBILE_CONFIGURATION_WRITES){
  const args={host,operationId,input:{path:{applicationKey,environmentKey},body:{appIdentifier:{value:'com.ssam.proof'}}},originOperationUuid,lookup:()=>origin,read};
  written(await mobileConfigurationApproval({...args,words:'Set the app identifier of Proof'}));
  await assert.rejects(mobileConfigurationApproval({...args,words:'Set the app identifier'}),missing('WORDS_MUST_NAME'));
 }
});

test('a source revision upload of an own asset takes the written words naming the asset; no approval file',async t=>{
 const {prepareSourceRevision}=await import('../runtime/asset-source-revision.mjs');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'written-revision-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const directory=path.join(temp,'downloads','asset-sources');fs.mkdirSync(directory,{recursive:true});
 const file=path.join(directory,'source.bin'),bytes=Buffer.from('OML: synthetic fixture'),digest=crypto.createHash('sha256').update(bytes).digest('hex');
 const assetKey=id(),originOperationUuid=id();
 fs.writeFileSync(file,bytes);fs.writeFileSync(file+'.json',JSON.stringify({assetKey,revisionNumber:1,byteLength:bytes.length,sha256:digest}));
 const origin={state:'accepted',identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey},authorization:{wordsSha256:sha256('creation')}};
 const base={directory,host,lookup:()=>origin,read:async()=>({ok:true,data:{assetKey,revision:1,name:'Fixture'}}),
  input:{assetKey,expectedRevision:1,file,expectedSha256:digest,originOperationUuid,authorize:'Upload the new revision of Fixture'}};
 const prepared=await prepareSourceRevision(base);
 written(prepared.approval);assert.deepEqual(Buffer.from(prepared.body.$base64,'base64'),bytes);
 await assert.rejects(prepareSourceRevision({...base,input:{...base.input,authorize:'Upload the new revision'}}),missing('WORDS_MUST_NAME'));
});

test('an own-fixture contextual mode selected by its origin receipt takes the written words: SSAM builds the record, no file',async()=>{
 const {groupApproval,GROUP_PATCH}=await import('../runtime/group-approval.mjs');
 const marker=Symbol.for('ssam.written-authorization');
 const key=id(),environmentKey=id(),originOperationUuid=id();
 const current={key,name:'Fixture',description:'Original',environmentKey,groupIdpClaimMappings:[]};
 const origin={state:'accepted',identity:{tenant:host,operationId:'user-access-management-api-v1:post:/groups',target:{name:'Fixture',environmentKey}},response:{key},
  authorization:{wordsSha256:sha256('creation'),source:{kind:'human-words'}}};
 const empty={ok:true,data:{results:[],page:{totalResults:0}}};
 const args={file:marker,host,operationId:GROUP_PATCH,input:{path:{key},body:{description:'Changed'}},originOperationUuid,lookup:()=>origin,
  read:async op=>op.endsWith('/groups/{key}')?{ok:true,data:current}:empty};
 const approval=await groupApproval({...args,words:'Change the description of the group Fixture'});
 written(approval);assert.deepEqual(approval.targets,['Fixture']);
 await assert.rejects(groupApproval({...args,words:'Change the description of the group'}),missing('WORDS_MUST_NAME'));
});

test('the guardrail baseline configure and its restore take the written words naming the stage and the portfolio; the mode follows the journal',async()=>{
 const {BASELINE_SAVE,BASELINE_READ,baselineState,baselineWirePolicies,baselineApproval,baselineReadInput}=await import('../runtime/guardrail-baseline-write.mjs');
 const ids=['PromptAttack','PII','ContentFilter','PiiRegexConfig','DeniedTopic','WordFilter'];
 const state=()=>({GuardrailId:'',RegionSupportStatus:'Supported',Policies:{List:ids.map(Id=>({Id,IsEnabled:false,Actions:{List:[{Id:'Block',Order:1},{Id:'Detect',Order:3}]},
  SelectedAction:'Block',WordsConfig:{List:[]},TopicsConfig:{List:[]},RegexesConfig:{List:[]}}))}});
 const p={EnvironmentId:id(),EnvironmentName:'Development',GuardrailId:'',PortfolioKey:id(),Policies:baselineWirePolicies(state().Policies)};
 p.Policies.List[5].IsEnabled=true;p.Policies.List[5].Config.Action='Detect';p.Policies.List[5].Config.WordsConfig.List=[{Text:'SSAM_SYNTHETIC',Action:'Detect'}];
 let current=state();const receipts=[];
 const args={host,raw:{inputParameters:p},lookup:key=>receipts.find(r=>r.operationUuid===key)??null,find:predicate=>receipts.filter(r=>predicate(r)),
  read:async op=>op===BASELINE_READ?{ok:true,data:current}:{ok:true,data:{Stages:{List:[{Stage:{Key:p.EnvironmentId,Name:'Development',Purpose:'Development',Status:'Ready',PortfolioKey:p.PortfolioKey},OptionsItems:{IsDisabled:false}}]}}}};
 const say='Configure the guardrail baseline of Development in portfolio '+p.PortfolioKey;
 const configured=await baselineApproval({...args,words:say});
 written(configured.approval);assert.equal(configured.expected.mode,'configure');assert.equal(configured.expected.allowRetainedId,true);
 await assert.rejects(baselineApproval({...args,words:'Configure the guardrail baseline of Development'}),missing('WORDS_MUST_NAME'));
 // The configure confirmed: its restore (the policies it replaced) is found in the journal.
 const savedId=id();
 receipts.push({operationUuid:id(),state:'confirmed',identity:{tenant:host,operationId:BASELINE_SAVE},response:{Id:savedId},authorization:{wordsSha256:configured.approval.wordsSha256,source:configured.approval.source},
  reconciliation:{guardrailBaseline:configured.expected}});
 current={...current,GuardrailId:savedId,Policies:configured.expected.policies};
 const restore={...p,GuardrailId:savedId,Policies:baselineWirePolicies(configured.expected.beforeState.Policies)};
 const restored=await baselineApproval({...args,raw:{inputParameters:restore},words:'Restore the guardrail baseline of Development in portfolio '+p.PortfolioKey});
 written(restored.approval);assert.equal(restored.expected.mode,'restore');assert.equal(restored.expected.readInput.screenVariables.portfolioid,baselineReadInput(p).screenVariables.portfolioid);
});
