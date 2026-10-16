import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { doctor, createDoctorFacts, warmBackground, scheduleWarm } from '../ssam.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('doctor lanes run in parallel without contacting real studios', async () => {
  const began=performance.now(); const fake=async()=>{await sleep(1000);return {ok:true,studio:{open:true}};};
  const report=await doctor(undefined,{lanes:{o11:fake,odc:fake}});
  assert.equal(report.ok,true); assert.ok(performance.now()-began<=1300);
});
test('background facts join an inflight read, reuse for ten seconds, then refresh', async () => {
  let now=0,processes=0,odc=0;
  const facts=createDoctorFacts({now:()=>now,readProcesses:async()=>{processes++;await sleep(20);return {o11:[1],odc:[2]};},readOdc:async()=>{odc++;await sleep(20);return {ok:true};}});
  const warmed=facts.warm(); const joined=facts.processes('o11'); await warmed;
  assert.deepEqual(await joined,{value:[1],ageMs:0}); assert.equal(processes,1);assert.equal(odc,1);
  now=9000; assert.equal((await facts.processes('odc')).ageMs,9000); assert.equal((await facts.odc()).ageMs,9000);assert.equal(processes,1);
  now=10001;await Promise.all([facts.processes('o11'),facts.processes('odc'),facts.odc()]);assert.equal(processes,2);assert.equal(odc,2);
});
test('SSAM_NO_WARM disables all background work; worker flags prevent worker creation', async () => {
  let count=0; await warmBackground({env:{SSAM_NO_WARM:'1'},indexes:()=>{count++;},facts:{warm:()=>{count++;}},worker:()=>{count++;}});assert.equal(count,0);
  await warmBackground({env:{ANVIL_WORKER:'0',ANVIL_ODC_NO_WORKER:'1'},indexes:async()=>{count++;},facts:{warm:async()=>{count++;}},worker:()=>{count++;}});assert.equal(count,2);
});
