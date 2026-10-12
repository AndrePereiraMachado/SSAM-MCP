import {isUuid} from './write-journal.mjs';

// The native boolean was observed false for a positively linked evaluation.
// Keep it as wire evidence; absence requires an independent complete inventory.
export async function datasetDependencies({datasetId,native,read}){
 const unknown=reason=>({verified:false,datasetId,reason});
 if(!isUuid(datasetId))return unknown('dataset-identity-invalid');
 const current=await read('agents.dataset',{screenVariables:{id:datasetId,_idInDataFetchStatus:1}});
 const dataset=current?.data?.Dataset;
 if(current?.ok!==true||current.data.NotFound!==false||dataset?.DatasetId!==datasetId||!isUuid(dataset.PortfolioKey))
  return unknown('dataset-scope-unverified');
 if(typeof native?.HasConnectedEvaluations!=='boolean')return unknown('native-dependency-state-invalid');
 const portfolio=dataset.PortfolioKey;
 const inventory=await read('agents.evaluations',{screenVariables:{PortfolioKey:portfolio,_portfolioKeyInDataFetchStatus:1,
  PaginationStartIndex:0,Sort:'name',EvaluationNameContains:'',SelectedAgenticAppIds:{List:[]}}},10);
 if(inventory?.ok!==true||inventory.complete!==true||!Array.isArray(inventory.rows)||inventory.rows.length>25)
  return unknown('evaluation-inventory-incomplete-or-too-large');
 const ids=inventory.rows.map(x=>x.EvalId);
 if(ids.some(id=>!isUuid(id))||new Set(ids).size!==ids.length)return unknown('evaluation-identities-unverified');
 for(const id of ids){
  const detail=await read('agents.evaluation',{screenVariables:{id,_idInDataFetchStatus:1,portfolioId:portfolio,_portfolioIdInDataFetchStatus:1}});
  const e=detail?.data?.Evaluation;
  if(detail?.ok!==true||detail.data.NotFound!==false||e?.EvalId!==id||e.PortfolioKey!==portfolio||!isUuid(e.DatasetId))
   return unknown('evaluation-detail-scope-unverified');
  if(e.DatasetId===datasetId)return {verified:true,datasetId,hasConnectedEvaluations:true,source:'evaluation-detail',evaluationIds:[id],nativeContradiction:native.HasConnectedEvaluations===false};
 }
 if(native.HasConnectedEvaluations===true)return unknown('native-positive-not-confirmed');
 return {verified:true,datasetId,hasConnectedEvaluations:false,source:'complete-evaluation-inventory',evaluationsChecked:ids.length};
}
