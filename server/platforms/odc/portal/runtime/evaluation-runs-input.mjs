import {fail} from './errors.mjs';
import {isUuid} from './write-journal.mjs';

// The current UI first searches evaluations and maps EvalId to {Id} before
// fetching runs. Screen name fields alone do not establish the run filter.
export async function evaluationRunsInput(raw,read){
 const s=raw.screenVariables??{},name=s.EvalNameContains||s.EvaluationNameContains||'';
 const bad=()=>fail('INPUT_INVALID','Run search requires matching name fields, an exact portfolio and verified evaluation IDs.');
 if(['EvalNameContains','EvaluationNameContains'].some(k=>s[k]!==undefined&&typeof s[k]!=='string')||typeof name!=='string'||name.length>512||s.EvalNameContains&&s.EvaluationNameContains&&s.EvalNameContains!==s.EvaluationNameContains)bad();
 if(s.DateTimeIsPreset!==undefined&&typeof s.DateTimeIsPreset!=='boolean')bad();
 if(s.DateTimeIsPreset===false&&([s.DateTimeStart,s.DateTimeEnd].some(v=>typeof v!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))||Date.parse(s.DateTimeStart)>Date.parse(s.DateTimeEnd)))bad();
 const selected=s.FilteredEvalIds?.List??[];
 if(!Array.isArray(selected)||selected.some(x=>!x||Object.keys(x).join(',')!=='Id'||!isUuid(x.Id))||new Set(selected.map(x=>x.Id)).size!==selected.length)bad();
 let ids=selected;
 if(name){
  if(!isUuid(s.PortfolioKey))bad();
  const r=await read({screenVariables:{PortfolioKey:s.PortfolioKey,_portfolioKeyInDataFetchStatus:1,PaginationStartIndex:0,Sort:'name',EvaluationNameContains:name,SelectedAgenticAppIds:{List:[]}}});
  if(r?.ok!==true||r.complete!==true||!Array.isArray(r.rows)||r.rows.some(x=>!isUuid(x.EvalId)||typeof x.Name!=='string'||!x.Name.toLocaleLowerCase().includes(name.toLocaleLowerCase())))
   fail('EVALUATION_RUN_FILTER_UNVERIFIED','The exact current evaluation filter inventory is incomplete.');
  ids=r.rows.map(x=>({Id:x.EvalId}));
  // An empty native ID filter means every evaluation, not zero matches.
  if(!ids.length)fail('EVALUATION_RUN_FILTER_EMPTY','No current evaluations match the requested run search; no run request was sent.');
  if(new Set(ids.map(x=>x.Id)).size!==ids.length)bad();
  if(selected.length&&JSON.stringify(selected.map(x=>x.Id).sort())!==JSON.stringify(ids.map(x=>x.Id).sort()))bad();
 }
 return {...raw,screenVariables:{...s,PaginationStartIndex:s.PaginationStartIndex??0,EvalNameContains:name,EvaluationNameContains:name,FilteredEvalIds:{List:ids}}};
}
