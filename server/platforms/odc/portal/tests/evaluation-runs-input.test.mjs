import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {evaluationRunsInput} from '../runtime/evaluation-runs-input.mjs';
test('run search derives current native Id records and refuses an unproven filter',async()=>{
 const portfolio=randomUUID(),id=randomUUID(),raw={screenVariables:{PortfolioKey:portfolio,EvalNameContains:'Own'}};
 const read=async input=>{assert.equal(input.screenVariables.EvaluationNameContains,'Own');return {ok:true,complete:true,rows:[{EvalId:id,Name:'OwnEvaluation'}]};};
 await assert.rejects(evaluationRunsInput({screenVariables:{DateTimeIsPreset:false,DateTimeStart:'2026-10-10T00:00:00',DateTimeEnd:'2026-10-11T00:00:00Z'}},async()=>{throw Error('Unexpected read')}),e=>e.code==='INPUT_INVALID');
 const r=await evaluationRunsInput(raw,read);assert.deepEqual(r.screenVariables.FilteredEvalIds,{List:[{Id:id}]});assert.equal(r.screenVariables.EvaluationNameContains,'Own');assert.equal(r.screenVariables.PaginationStartIndex,0);
 await assert.rejects(evaluationRunsInput(raw,async()=>({ok:true,complete:false,rows:[]})),e=>e.code==='EVALUATION_RUN_FILTER_UNVERIFIED');
 await assert.rejects(evaluationRunsInput(raw,async()=>({ok:true,complete:true,rows:[]})),e=>e.code==='EVALUATION_RUN_FILTER_EMPTY');
 await assert.rejects(evaluationRunsInput({...raw,screenVariables:{...raw.screenVariables,FilteredEvalIds:{List:[{Id:randomUUID()}]}}},read),e=>e.code==='INPUT_INVALID');
 await assert.rejects(evaluationRunsInput({...raw,screenVariables:{...raw.screenVariables,EvaluationNameContains:'Other'}},read),e=>e.code==='INPUT_INVALID');
});
