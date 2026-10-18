import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {timerRunState} from '../runtime/timer-run-state.mjs';
const sample={isRunning:false,isPendingRun:false,lastRunStartedOn:'2026-10-09T00:15:58.085849Z',lastRunFinishedOn:'1900-01-01T00:00:00',lastRunDuration:1,nextRunStartsOn:'2027-01-01T00:00:00Z'};
test('idle with sentinel retains no inferred finish or success',()=>{
 const data={TimerRunInformation:{...sample}},copy=structuredClone(data),r=timerRunState(data);
 assert.deepEqual(data,copy);assert.equal(r.state,'idle');assert.equal(r.lastFinishedAt,null);assert.equal(r.lastStartedAt,sample.lastRunStartedOn);
 assert.equal(r.completionVerified,false);assert.equal(r.successVerified,false);assert.deepEqual(r.duration,{value:1,unit:null,source:'native'});
});
test('pending and running remain independent from dates',()=>{
 assert.equal(timerRunState({TimerRunInformation:{...sample,isPendingRun:true}}).state,'pending');
 assert.equal(timerRunState({TimerRunInformation:{...sample,isRunning:true,isPendingRun:true}}).state,'running');
 assert.equal(timerRunState({}).state,'unknown');assert.equal(timerRunState({TimerRunInformation:{isRunning:'false',isPendingRun:false}}).state,'unknown');
});
test('only timezone-qualified ordered timestamps are reported; a finish is not a success status',()=>{
 for(const date of ['garbage','2026-10-09T00:15:57Z','2026-10-09T00:16:00','0001-01-01T00:00:00','2027-02-29T00:00:00Z'])assert.equal(timerRunState({TimerRunInformation:{...sample,lastRunFinishedOn:date}}).lastFinishedAt,null);
 const r=timerRunState({TimerRunInformation:{...sample,lastRunFinishedOn:'2026-10-09T00:16:00Z'}});assert.equal(r.lastFinishedAt,'2026-10-09T00:16:00Z');assert.equal(r.successVerified,false);
});
