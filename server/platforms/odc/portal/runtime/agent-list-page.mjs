import {fail} from './errors.mjs';
import {isUuid} from './write-journal.mjs';
const lists = { 'agents.datasets': 'Datasets', 'agents.evaluations': 'Evaluations', 'agents.evaluationRuns': 'EvaluationRuns', 'agents.evaluationHistory':'EvaluationRuns' };
const identities={'agents.datasets':'DatasetId','agents.evaluations':'EvalId','agents.evaluationRuns':'EvalRunId','agents.evaluationHistory':'EvalRunId'};
export function agentListInput(operationId,input){
 if(operationId==='agents.evaluationHistory'){
  const s=input.screenVariables??{};if(!isUuid(s.EvaluationId))fail('INPUT_INVALID','An exact evaluation UUID is required for its native run history.');
  return {...input,screenVariables:{...s,PaginationStartIndex:s.PaginationStartIndex??0}};
 }
 const names={'agents.datasets':['DatasetOrAgentNameContains','Dataset_SearchKeyword'],'agents.evaluations':['EvaluationNameContains','Evaluation_SearchKeyword']};
 if(!names[operationId])return input;
 const [screenKey,clientKey]=names[operationId],s=input.screenVariables??{},c=input.clientVariables??{};
 const value=s[screenKey]??c[clientKey]??'';
 if(typeof value!=='string'||value.length>512||c[clientKey]!==undefined&&c[clientKey]!==value)
  fail('INPUT_INVALID','The native client search keyword must match the requested list filter.');
 return {...input,screenVariables:{...s,PaginationStartIndex:s.PaginationStartIndex??0,[screenKey]:value},clientVariables:{...c,[clientKey]:value}};
}
// Current Portal pagination widget binds StartIndex from its local variable,
// MaxRecords from the data action and TotalCount from Page.Total. The other
// Page fields are lossy defaults. This independent validator is activated only
// after a positive multi-page live proof; it never rewrites the wire response.
export function agentClientListPage(operationId,data,input={}){
 const unknown=reason=>({complete:false,paginationVerified:false,paginationIssue:reason});
 const key=lists[operationId];if(!key)return {};
 const page=data?.Page,rows=data?.[key]?.List;
 const integer=v=>(typeof v==='number'||typeof v==='string')&&/^\d+$/.test(String(v))&&Number.isSafeInteger(Number(v));
 if(!page||!Array.isArray(rows)||![page.Total,page.Limit,page.Offset,page.NextPageOffset,data.MaxRecords,input.screenVariables?.PaginationStartIndex].every(integer)
  ||Number(page.Limit)!==0||Number(page.Offset)!==0||Number(page.NextPageOffset)!==0||page.HasMore!==false)return unknown('native-client-contract-unrecognized');
 const total=Number(page.Total),limit=Number(data.MaxRecords),offset=Number(input.screenVariables.PaginationStartIndex);
 if(limit<1||limit>1000||offset>total||rows.length!==Math.min(limit,total-offset))return unknown('inconsistent-native-client-page');
 const runs=operationId==='agents.evaluationRuns';
 // The native global run table navigates by evaluation ID and does not fill
 // EvalRunId. This is only a stable client row key, never a server run UUID.
 const ids=rows.map(x=>runs?(isUuid(x?.EvalId)&&typeof x.StartedAt==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(x.StartedAt)
  &&Number.isFinite(Date.parse(x.StartedAt))&&Date.parse(x.StartedAt)>=Date.UTC(2000,0,1)
  ?JSON.stringify([x.EvalId,new Date(x.StartedAt).toISOString()]):null):x?.[identities[operationId]]);
 if(ids.some(x=>typeof x!=='string'||!x)||new Set(ids).size!==ids.length)return unknown('missing-or-duplicate-list-identities');
 if(operationId==='agents.evaluationHistory'&&(!isUuid(input.screenVariables.EvaluationId)||ids.some(id=>!isUuid(id))
  ||rows.some(row=>row.EvalId!==input.screenVariables.EvaluationId)))return unknown('history-run-identity-unverified');
 const filter=operationId==='agents.datasets'?input.screenVariables.DatasetOrAgentNameContains
  :operationId==='agents.evaluations'?input.screenVariables.EvaluationNameContains:input.screenVariables.EvalNameContains||input.screenVariables.EvaluationNameContains;
 if(filter&&rows.some(row=>!(operationId==='agents.datasets'?[row.Name,row.AgenticAppName]:operationId==='agents.evaluations'?[row.Name]:[row.EvalName])
  .some(value=>typeof value==='string'&&value.toLocaleLowerCase().includes(String(filter).toLocaleLowerCase()))))return unknown('list-filter-scope-mismatch');
 if(runs){
  const selected=input.screenVariables.FilteredEvalIds?.List?.map(x=>x.Id)??[];
  if(selected.length&&rows.some(row=>!selected.includes(row.EvalId)))return unknown('list-filter-scope-mismatch');
  if(input.screenVariables.DateTimeIsPreset===false){
   const start=Date.parse(input.screenVariables.DateTimeStart),end=Date.parse(input.screenVariables.DateTimeEnd);
   if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||rows.some(row=>Date.parse(row.StartedAt)<start||Date.parse(row.StartedAt)>end))return unknown('list-date-scope-mismatch');
  }
 }
 const hasMore=offset+rows.length<total;
 return {complete:offset===0&&!hasMore,paginationVerified:true,paginationSource:'native-client-widget',wirePaginationVerified:false,
  pagination:{total,limit,offset,nextPageOffset:hasMore?offset+rows.length:null,hasMore},listIdentities:ids,
  ...(runs?{listIdentityKind:'client-evaluation-and-start-time',nativeRunIdsVerified:false}:operationId==='agents.evaluationHistory'
   ?{listIdentityKind:'native-run-uuid',nativeRunIdsVerified:true,requestedEvaluationId:input.screenVariables.EvaluationId}:{})};
}
export async function collectAgentClientPages({operationId,data,input,maxPages=3,read}){
 const key=lists[operationId],first=agentClientListPage(operationId,data,input);
 if(!first.paginationVerified)return first;
 const rows=[...data[key].List],seen=new Set(first.listIdentities),initialOffset=first.pagination.offset;
 let page=first,pages=1;
 while(page.pagination.hasMore&&pages<maxPages){
  const nextInput={...input,screenVariables:{...input.screenVariables,PaginationStartIndex:page.pagination.nextPageOffset}};
  const next=await read(nextInput);
  if(next?.ok!==true)return {...first,rows,count:rows.length,pages,complete:false,paginationVerified:false,paginationIssue:'continuation-read-failed'};
  const checked=agentClientListPage(operationId,next.data,nextInput);
  if(!checked.paginationVerified||checked.pagination.total!==first.pagination.total||checked.pagination.limit!==first.pagination.limit
   ||checked.listIdentities?.some(id=>seen.has(id)))
   return {...first,rows,count:rows.length,pages,complete:false,paginationVerified:false,paginationIssue:!checked.paginationVerified?checked.paginationIssue:checked.listIdentities.some(id=>seen.has(id))?'repeated-list-identities':'inventory-changed-between-pages'};
  rows.push(...next.data[key].List);checked.listIdentities.forEach(id=>seen.add(id));page=checked;pages++;
 }
 return {...page,listIdentities:[...seen],rows,count:rows.length,pages,complete:initialOffset===0&&!page.pagination.hasMore,
  ...(page.pagination.hasMore?{nextInput:{...input,screenVariables:{...input.screenVariables,PaginationStartIndex:page.pagination.nextPageOffset}}}:{})};
}
export function agentListPage(operationId, data, input = {}) {
  if (!Object.hasOwn(lists, operationId)) return {};
  const unknown = reason => ({ complete: false, paginationVerified: false, paginationIssue: reason });
  const page = data?.Page, rows = data?.[lists[operationId]]?.List;
  if (!page || !Array.isArray(rows)) return unknown('missing-page-or-list');
  const integer = value => (typeof value === 'number' || typeof value === 'string') && /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value));
  if (![page.Total, page.Limit, page.Offset, page.NextPageOffset].every(integer) || typeof page.HasMore !== 'boolean') return unknown('invalid-page-metadata');
  const total = Number(page.Total), limit = Number(page.Limit), offset = Number(page.Offset), next = Number(page.NextPageOffset);
  const requested = input.screenVariables?.PaginationStartIndex;
  if (requested !== undefined && (!integer(requested) || Number(requested) !== offset))
    return unknown('requested-offset-mismatch');
  if (!limit) return unknown('zero-page-limit');
  if (rows.length > limit || offset + rows.length > total
    || (page.HasMore && (!rows.length || offset + rows.length >= total || next !== offset + rows.length))
    || (!page.HasMore && offset + rows.length !== total)) return unknown('inconsistent-page-metadata');
  return { complete: offset === 0 && !page.HasMore, paginationVerified: true,
    pagination: { total, limit, offset, nextPageOffset: page.HasMore ? next : null, hasMore: page.HasMore } };
}
