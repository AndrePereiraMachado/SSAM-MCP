import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {isUuid} from './write-journal.mjs';
import {fail} from './errors.mjs';
export const EVALUATION_CREATE='agents.evaluationCreate';
export const EVALUATION_RUN='agents.evaluationRunCreate';
export const EVALUATION_DELETE='agents.evaluationDelete';
export const evaluationHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact=(obj,keys)=>!!obj&&Object.keys(obj).sort().join(',')===keys.split(',').sort().join(',');
export function evaluationListInput(portfolioKey,name){return {screenVariables:{PortfolioKey:portfolioKey,_portfolioKeyInDataFetchStatus:1,
 PaginationStartIndex:0,Sort:'name',EvaluationNameContains:name,SelectedAgenticAppIds:{List:[]}}};}
export async function evaluationCreateApproval({file,words,host,raw,lookup,read}){
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Evaluation creation needs an owned confirmed dataset, exact approved content and an observed eligible judge. Nothing was sent.');
 const p=raw.inputParameters,e=p?.Evaluation;
 if(!exact(p,'Evaluation')||!exact(e,'Name,Description,DatasetId,Judges,PortfolioKey')
   ||typeof e.Name!=='string'||!e.Name.trim()||typeof e.Description!=='string'||!isUuid(e.DatasetId)||!isUuid(e.PortfolioKey)
   ||!exact(e.Judges,'List')||!Array.isArray(e.Judges.List)||e.Judges.List.length!==1
   ||!exact(e.Judges.List[0],'Id')||!isUuid(e.Judges.List[0].Id)
   ||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length)bad();
 let c;try{if(fs.statSync(file).size>32768)bad();c=JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{bad();}
 if(!isUuid(c?.originOperationUuid))bad();
 const origin=lookup(c.originOperationUuid);
 if(origin?.state!=='confirmed'||origin.identity?.tenant!==host||origin.identity.operationId!=='agents.datasetCreate'
   ||origin.response?.DatasetId!==e.DatasetId||!origin.authorization?.source)bad();
 const detail=await read('agents.dataset',{screenVariables:{id:e.DatasetId,_idInDataFetchStatus:1}}),d=detail?.data?.Dataset;
 if(detail?.ok!==true||detail.data.NotFound!==false||d?.DatasetId!==e.DatasetId||d.PortfolioKey!==e.PortfolioKey||!d.Name
   ||!['1','2'].includes(String(d.TestCaseCount))||!Array.isArray(d.TestCases?.List)||d.TestCases.List.length!==Number(d.TestCaseCount)
   ||['SetupAppId','SetupServiceActionId','TeardownAppId','TeardownServiceActionId'].some(k=>d[k]!==''))bad();
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:EVALUATION_CREATE,targets:[e.Name,d.Name],
  constraints:{originOperationUuid:c.originOperationUuid,datasetId:e.DatasetId,portfolioKey:e.PortfolioKey,inputSha256:evaluationHash(p),expectedDatasetSha256:evaluationHash(d)}});
 if(!approval||approval.wordsSha256!==origin.authorization.wordsSha256||approval.source.threadId!==origin.authorization.source.threadId
   ||approval.source.messageId!==origin.authorization.source.messageId)bad();
 const dependencies=await read('agents.datasetEvaluations',{screenVariables:{DatasetId:e.DatasetId,_datasetIdInDataFetchStatus:1}});
 if(dependencies?.ok!==true||dependencies.dependencyState?.verified!==true||dependencies.dependencyState.datasetId!==e.DatasetId||dependencies.dependencyState.hasConnectedEvaluations!==false)
  fail('EVALUATION_BASELINE_UNVERIFIED','The owned dataset must have no connected evaluations before this fixture creation. Nothing was sent.');
 const judges=await read('agents.judges',{screenVariables:{PortfolioKey:e.PortfolioKey,_portfolioKeyInDataFetchStatus:1}});
 const eligible=judges?.ok===true?judges.data?.Judges?.List?.filter(x=>x.Id===e.Judges.List[0].Id):null;
 if(!eligible||eligible.length!==1||eligible[0].IsBuiltIn!==true||eligible[0].MLflowJudgeName!=='Correctness')bad();
 return {approval,expected:{name:e.Name,description:e.Description,datasetId:e.DatasetId,portfolioKey:e.PortfolioKey,
  judgeIds:e.Judges.List.map(x=>x.Id),datasetSha256:evaluationHash(d),originOperationUuid:c.originOperationUuid}};
}
export function evaluationDetailMatches(expected,id,result){
 const e=result?.data?.Evaluation,d=result?.data?.Dataset;
 return result?.ok===true&&result.data.NotFound===false&&e?.EvalId===id&&e.Name===expected.name&&e.Description===expected.description
  &&e.DatasetId===expected.datasetId&&e.PortfolioKey===expected.portfolioKey&&Array.isArray(e.Judges?.List)
  &&evaluationHash(e.Judges.List.map(x=>x.Id).sort())===evaluationHash([...expected.judgeIds].sort())
  // Dataset is a lossy UI summary here; Evaluation.DatasetId above is the
  // binding. observeEvaluationCreation separately reads the full exact dataset.
  &&typeof d?.DatasetId==='string'&&(d.DatasetId===''||d.DatasetId===expected.datasetId);
}
export async function observeEvaluationCreation(receipt,read){
 const expected=receipt.reconciliation?.evaluation;
 if(!expected)return {verified:false,reason:'missing-bound-evaluation'};
 const list=await read('agents.evaluations',evaluationListInput(expected.portfolioKey,expected.name));
 const candidates=list?.ok===true&&Array.isArray(list.data?.Evaluations?.List)
  // The current list projection leaves DatasetId empty. It identifies only
  // a candidate; the exact detail below must still prove the dataset binding.
  ?list.data.Evaluations.List.filter(x=>x.Name===expected.name&&(x.DatasetId===''||x.DatasetId===expected.datasetId)&&isUuid(x.EvalId)):[];
 if(candidates.length!==1)return {verified:false,reason:'evaluation-identity-unavailable-or-ambiguous'};
 const id=candidates[0].EvalId,detail=await read('agents.evaluation',{screenVariables:{id,_idInDataFetchStatus:1,portfolioId:expected.portfolioKey,_portfolioIdInDataFetchStatus:1}});
 const dataset=await read('agents.dataset',{screenVariables:{id:expected.datasetId,_idInDataFetchStatus:1}});
 return {verified:evaluationDetailMatches(expected,id,detail)&&dataset?.ok===true&&dataset.data.NotFound===false&&evaluationHash(dataset.data.Dataset)===expected.datasetSha256,evaluationId:id,datasetId:expected.datasetId,
  detailSha256:evaluationHash(detail?.data??null),inventoryComplete:list.complete===true};
}
export async function evaluationOperationApproval({file,words,host,raw,operationId,lookup,read}){
 const bad=()=>fail('EVALUATION_BASELINE_UNVERIFIED','The owned evaluation, original authorization, exact dataset and idle state must be proven before this operation. Nothing was sent.');
 const p=raw.inputParameters;
 if(!exact(p,'EvaluationId')||!isUuid(p.EvaluationId)||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length)bad();
 let c;try{if(fs.statSync(file).size>32768)bad();c=JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{bad();}
 if(!isUuid(c?.originOperationUuid))bad();
 const origin=lookup(c.originOperationUuid),expected=origin?.reconciliation?.evaluation;
 if(origin?.state!=='confirmed'||origin.identity?.tenant!==host||origin.identity.operationId!==EVALUATION_CREATE
   ||origin.response?.EvalId!==p.EvaluationId||!expected||!origin.authorization?.source)bad();
 const screenVariables={id:p.EvaluationId,_idInDataFetchStatus:1,portfolioId:expected.portfolioKey,_portfolioIdInDataFetchStatus:1};
 const detail=await read('agents.evaluation',{screenVariables});
 if(!evaluationDetailMatches(expected,p.EvaluationId,detail))bad();
 const dataset=await read('agents.dataset',{screenVariables:{id:expected.datasetId,_idInDataFetchStatus:1}});
 if(dataset?.ok!==true||dataset.data.NotFound!==false||evaluationHash(dataset.data.Dataset)!==expected.datasetSha256)bad();
 const ongoing=await read('agents.evaluationOngoingRun',{screenVariables:{...screenVariables,GetEvaluation:{...detail.data,DataFetchStatus:1}}});
 if(ongoing?.ok!==true||ongoing.data?.OngoingRun?.IsRunning!==false)bad();
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,targets:[expected.name],
  constraints:{originOperationUuid:c.originOperationUuid,evaluationId:p.EvaluationId,portfolioKey:expected.portfolioKey,inputSha256:evaluationHash(p),expectedEvaluationSha256:evaluationHash(detail.data.Evaluation)}});
 if(!approval||approval.wordsSha256!==origin.authorization.wordsSha256||approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId)bad();
 if(operationId===EVALUATION_RUN){
  if(!/^1900-01-01T00:00:00(?:Z)?$/.test(detail.data.Evaluation.LastRunAt))bad();
  const stage=await read('agents.evaluationDevStage',{screenVariables});
  const rows=stage?.data?.Stages?.List;
  if(stage?.ok!==true||!Array.isArray(rows)||rows.length!==1||rows[0].Stage?.Key!==stage.data.StageKey||rows[0].Stage?.PortfolioKey!==expected.portfolioKey||rows[0].Stage?.Purpose!=='Development'||rows[0].Stage?.Status!=='Ready'||rows[0].OptionsItems?.IsDisabled!==false)bad();
 }
 return {approval,evaluationId:p.EvaluationId,portfolioKey:expected.portfolioKey};
}
