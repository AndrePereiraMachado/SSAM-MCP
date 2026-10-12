import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import { agentListPage } from '../runtime/agent-list-page.mjs';
const data = (page={}, rows=[]) => ({ Datasets:{List:rows}, Page:{Total:'0',Limit:'8',Offset:'0',NextPageOffset:'0',HasMore:false,...page} });
test('zero-limit live response is explicitly unverified, not certified empty inventory', () => {
  const result=agentListPage('agents.datasets',data({Limit:'0'}));
  assert.deepEqual(result,{complete:false,paginationVerified:false,paginationIssue:'zero-page-limit'});
});
test('valid empty, partial and final pages retain their bounded meaning', () => {
  assert.equal(agentListPage('agents.datasets',data()).complete,true);
  const first=agentListPage('agents.datasets',data({Total:'2',Limit:'1',HasMore:true,NextPageOffset:'1'},[{}]));
  assert.equal(first.complete,false);assert.equal(first.paginationVerified,true);
  const last=agentListPage('agents.datasets',data({Total:'2',Limit:'1',Offset:'1'},[{}]));
  assert.equal(last.complete,false);assert.equal(last.pagination.nextPageOffset,null);
});
test('missing, cyclic, inconsistent or ill-typed pagination never proves completeness', () => {
  for(const value of [null,{},data({Limit:null}),data({Limit:''}),data({HasMore:'false'}),data({Total:'2'}),data({Total:'2',HasMore:true,NextPageOffset:'0'},[{}])]) {
    assert.equal(agentListPage('agents.datasets',value).paginationVerified,false);
  }
  assert.deepEqual(agentListPage('other.route',{}),{});
});

test('a continuation must advance exactly past returned rows and leave records to read', () => {
  for (const value of [
    data({Total:'2',HasMore:true,NextPageOffset:'2'},[{}]),
    data({Total:'2',HasMore:true,NextPageOffset:'3'},[{}]),
    data({Total:'1',HasMore:true,NextPageOffset:'1'},[{}]),
    data({Total:'2',HasMore:true,NextPageOffset:'1'})
  ]) assert.equal(agentListPage('agents.datasets',value).paginationVerified,false);
});

test('an otherwise valid first page cannot satisfy a requested continuation', () => {
  for (const operation of ['agents.datasets','agents.evaluations','agents.evaluationRuns']) {
    const key = {'agents.datasets':'Datasets','agents.evaluations':'Evaluations','agents.evaluationRuns':'EvaluationRuns'}[operation];
    const response = data();response[key]=response.Datasets;
    const mismatch=agentListPage(operation,response,{screenVariables:{PaginationStartIndex:8}});
    assert.equal(mismatch.paginationVerified,false);assert.equal(mismatch.paginationIssue,'requested-offset-mismatch');
    assert.equal(agentListPage(operation,response,{screenVariables:{PaginationStartIndex:0}}).complete,true);
    const last={...response,Page:{Total:'9',Limit:'8',Offset:'8',NextPageOffset:'0',HasMore:false},[key]:{List:[{}]}};
    assert.equal(agentListPage(operation,last,{screenVariables:{PaginationStartIndex:'8'}}).paginationVerified,true);
    assert.equal(agentListPage(operation,last,{screenVariables:{PaginationStartIndex:'8'}}).complete,false);
  }
});


test('native widget contract validates two pages without rewriting lossy wire metadata',async()=>{
 const {agentClientListPage}=await import('../runtime/agent-list-page.mjs');
 const first={...data({Total:'9',Limit:'0'},Array.from({length:8},(_,n)=>({DatasetId:'dataset-'+n}))),MaxRecords:8};
 const last={...data({Total:'9',Limit:'0'},[{DatasetId:'dataset-8'}]),MaxRecords:8};
 const before=JSON.stringify(first),a=agentClientListPage('agents.datasets',first,{screenVariables:{PaginationStartIndex:0}}),b=agentClientListPage('agents.datasets',last,{screenVariables:{PaginationStartIndex:8}});
 assert.equal(a.paginationVerified,true);assert.equal(a.complete,false);assert.equal(a.pagination.nextPageOffset,8);assert.equal(a.wirePaginationVerified,false);
 assert.equal(b.paginationVerified,true);assert.equal(b.complete,false);assert.equal(b.pagination.hasMore,false);assert.equal(JSON.stringify(first),before);
 assert.equal(new Set([...a.listIdentities,...b.listIdentities]).size,9);
 assert.equal(agentClientListPage('agents.datasets',first,{screenVariables:{PaginationStartIndex:8}}).paginationVerified,false);
 assert.equal(agentClientListPage('agents.datasets',{...first,MaxRecords:0},{screenVariables:{PaginationStartIndex:0}}).paginationVerified,false);
 const duplicated=structuredClone(first);duplicated.Datasets.List[1].DatasetId='dataset-0';assert.equal(agentClientListPage('agents.datasets',duplicated,{screenVariables:{PaginationStartIndex:0}}).paginationVerified,false);
 const runs={EvaluationRuns:{List:[{EvalRunId:''}]},Page:{Total:'1',Limit:'0',Offset:'0',NextPageOffset:'0',HasMore:false},MaxRecords:8};
 assert.equal(agentClientListPage('agents.evaluationRuns',runs,{screenVariables:{PaginationStartIndex:0}}).paginationIssue,'missing-or-duplicate-list-identities');
});


test('native client page collection rejects repetition, changed totals and truncated continuations',async()=>{
 const {collectAgentClientPages}=await import('../runtime/agent-list-page.mjs');
 const first={...data({Total:'17',Limit:'0'},Array.from({length:8},(_,n)=>({DatasetId:'d'+n,Name:'Owned'+n}))),MaxRecords:8};
 const input={screenVariables:{PaginationStartIndex:0,DatasetOrAgentNameContains:'Owned',PortfolioKey:'portfolio'},clientVariables:{Filter:'keep'}};
 const next=offset=>({...first,Datasets:{List:Array.from({length:Math.min(8,17-offset)},(_,n)=>({DatasetId:'d'+(offset+n),Name:'Owned'+(offset+n)}))}});
 const read=async i=>{assert.equal(i.screenVariables.DatasetOrAgentNameContains,'Owned');assert.equal(i.clientVariables.Filter,'keep');return{ok:true,data:next(i.screenVariables.PaginationStartIndex)}};
 const all=await collectAgentClientPages({operationId:'agents.datasets',data:first,input,read});assert.equal(all.complete,true);assert.equal(all.count,17);assert.equal(all.pages,3);
 const bounded=await collectAgentClientPages({operationId:'agents.datasets',data:first,input,maxPages:1,read});assert.equal(bounded.complete,false);assert.equal(bounded.nextInput.screenVariables.PaginationStartIndex,8);
 const repeated=await collectAgentClientPages({operationId:'agents.datasets',data:first,input,read:async()=>({ok:true,data:first})});assert.equal(repeated.paginationIssue,'repeated-list-identities');assert.equal(repeated.count,8);
 const changed=await collectAgentClientPages({operationId:'agents.datasets',data:first,input,read:async()=>({ok:true,data:{...next(8),Page:{...first.Page,Total:'18'}}})});assert.equal(changed.paginationIssue,'inventory-changed-between-pages');assert.equal(changed.complete,false);
 const failed=await collectAgentClientPages({operationId:'agents.datasets',data:first,input,read:async()=>({ok:false})});assert.equal(failed.paginationIssue,'continuation-read-failed');
});


test('native client pages refuse rows outside the requested name filter',async()=>{
 const {agentClientListPage}=await import('../runtime/agent-list-page.mjs');
 const wire={...data({Total:'1',Limit:'0'},[{DatasetId:'owned-id',Name:'Other',AgenticAppName:'OtherApp'}]),MaxRecords:8};
 assert.equal(agentClientListPage('agents.datasets',wire,{screenVariables:{PaginationStartIndex:0,DatasetOrAgentNameContains:'Owned'}}).paginationIssue,'list-filter-scope-mismatch');
 wire.Datasets.List[0].Name='Owned Dataset';assert.equal(agentClientListPage('agents.datasets',wire,{screenVariables:{PaginationStartIndex:0,DatasetOrAgentNameContains:'owned'}}).complete,true);
});

test('run pages use explicit client row keys without inventing native run IDs',async()=>{
 const {agentClientListPage}=await import('../runtime/agent-list-page.mjs'),evalId=randomUUID();
 const row={EvalRunId:'',EvalId:evalId,StartedAt:'2026-10-10T06:29:29.05Z',EvalName:'OwnEval'};
 const wire={EvaluationRuns:{List:[row]},Page:{Total:'1',Limit:'0',Offset:'0',NextPageOffset:'0',HasMore:false},MaxRecords:8};
 const input={screenVariables:{PaginationStartIndex:0,EvalNameContains:'Own',FilteredEvalIds:{List:[{Id:evalId}]},DateTimeIsPreset:false,DateTimeStart:'2026-10-10T00:00:00Z',DateTimeEnd:'2026-10-11T00:00:00Z'}};
 const r=agentClientListPage('agents.evaluationRuns',wire,input);assert.equal(r.complete,true);assert.equal(r.nativeRunIdsVerified,false);assert.equal(r.listIdentityKind,'client-evaluation-and-start-time');assert.equal(wire.EvaluationRuns.List[0].EvalRunId,'');
 assert.equal(agentClientListPage('agents.evaluationRuns',wire,{screenVariables:{...input.screenVariables,FilteredEvalIds:{List:[{Id:randomUUID()}]}}}).paginationVerified,false);
 assert.equal(agentClientListPage('agents.evaluationRuns',wire,{screenVariables:{...input.screenVariables,DateTimeStart:'2026-10-11T00:00:00Z'}}).paginationVerified,false);
 const duplicate={...wire,EvaluationRuns:{List:[row,{...row,StartedAt:'2026-10-10T06:29:29.050Z'}]},Page:{...wire.Page,Total:'2'}};
 assert.equal(agentClientListPage('agents.evaluationRuns',duplicate,input).paginationIssue,'missing-or-duplicate-list-identities');
});

test('per-evaluation history requires actual native run UUIDs and exact echoed scope',async()=>{
 const {agentClientListPage,agentListInput}=await import('../runtime/agent-list-page.mjs'),id=randomUUID(),runId=randomUUID();
 const input=agentListInput('agents.evaluationHistory',{screenVariables:{EvaluationId:id}});
 const wire={EvaluationRuns:{List:[{EvalRunId:runId,EvalId:id}]},Page:{Total:'1',Limit:'0',Offset:'0',NextPageOffset:'0',HasMore:false},MaxRecords:8};
 const r=agentClientListPage('agents.evaluationHistory',wire,input);assert.equal(r.complete,true);assert.equal(r.nativeRunIdsVerified,true);assert.deepEqual(r.listIdentities,[runId]);assert.equal(r.requestedEvaluationId,id);
 wire.EvaluationRuns.List[0].EvalId=randomUUID();assert.equal(agentClientListPage('agents.evaluationHistory',wire,input).paginationVerified,false);
 wire.EvaluationRuns.List[0].EvalId='';assert.equal(agentClientListPage('agents.evaluationHistory',wire,input).paginationVerified,false);
 wire.EvaluationRuns.List[0]={EvalRunId:'',EvalId:id};assert.equal(agentClientListPage('agents.evaluationHistory',wire,input).paginationVerified,false);
 assert.throws(()=>agentListInput('agents.evaluationHistory',{screenVariables:{EvaluationId:'not-a-uuid'}}),e=>e.code==='INPUT_INVALID');
});
