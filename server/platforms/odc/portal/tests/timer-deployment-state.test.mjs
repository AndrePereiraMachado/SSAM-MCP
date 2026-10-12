import test from 'node:test';
import assert from 'node:assert/strict';
import {readTimerDeployment} from '../runtime/timer-deployment-state.mjs';
const app='aaaaaaaa-1111-4111-8111-111111111111',env='bbbbbbbb-2222-4222-8222-222222222222',portfolio='cccccccc-3333-4333-8333-333333333333';
function fixture(){
 const d={environmentKey:env,portfolioKey:portfolio,name:'ProofApp',revision:7,buildKey:app,deploymentKey:portfolio,deploymentDateTime:'2026-10-09T00:00:00Z',deploymentUserId:env,url:'https://example.test/ProofApp'};
 const data={page:{totalResults:1,totalPages:1,count:1,offset:0,nextPageOffset:null},results:[{key:app,deployments:[d]}]};
 const native={DeployedAppVersion:{List:[{Key:'',Deployments:{List:[{Revision:7,DeploymentKey:'',DeploymentDateTime:'1900-01-01T00:00:00'}]}}]},AssetRevision:{Name:'ProofApp',AssetKey:''}};
 const calls=[],deps={asset:async p=>{calls.push(['asset',p]);return{ok:true,data:{assetKey:app,portfolioKey:portfolio}}},deployments:async q=>{calls.push(['deployments',q]);return{ok:true,data}},revision:async p=>{calls.push(['revision',p]);return{ok:true,data:{assetKey:app,name:'ProofApp',revision:7}}}};
 const input={screenVariables:{appid:app,stageid:env,ActivePortfolioKey:env,SelectedStage:{Key:env}}};
 return{d,data,native,calls,deps,input};
}
test('native placeholders remain intact while exact public deployed revision supplies metadata',async()=>{
 const f=fixture(),before=structuredClone(f.native),r=await readTimerDeployment(f.input,f.native,f.deps);
 assert.equal(r.state,'verified');assert.equal(r.atomicityProven,false);assert.equal(r.deployment.deployedAt,'2026-10-09T00:00:00Z');assert.deepEqual(f.native,before);
 assert.deepEqual(f.calls.map(x=>x[0]),['asset','deployments','revision']);assert.equal(f.calls[1][1].portfolioKey,portfolio);assert.equal(f.calls[1][1].key,app);assert.equal(f.calls[1][1].environmentKey,env);
});
for(const [name,change] of [
 ['page total',f=>f.data.page.totalResults=2],['offset',f=>f.data.page.offset=1],['next page',f=>f.data.page.nextPageOffset=1],
 ['duplicate asset',f=>f.data.results.push(f.data.results[0])],['wrong asset',f=>f.data.results[0].key=env],['wrong environment',f=>f.d.environmentKey=app],
 ['wrong portfolio',f=>f.d.portfolioKey=env],['duplicate deployment',f=>f.data.results[0].deployments.push(f.d)],['zero revision',f=>f.d.revision=0],
 ['missing build',f=>f.d.buildKey=''],['missing deployment',f=>f.d.deploymentKey=''],['sentinel date',f=>f.d.deploymentDateTime='1900-01-01T00:00:00Z'],
 ['unqualified date',f=>f.d.deploymentDateTime='2026-10-09T00:00:00'],['invalid date',f=>f.d.deploymentDateTime='invalid'],
 ['impossible calendar',f=>f.d.deploymentDateTime='2026-02-30T00:00:00Z'],['invalid clock',f=>f.d.deploymentDateTime='2026-10-09T24:00:00Z'],
 ['native revision',f=>f.native.DeployedAppVersion.List[0].Deployments.List[0].Revision=6],['native name',f=>f.native.AssetRevision.Name='Other'],
 ['native duplicate',f=>f.native.DeployedAppVersion.List.push(f.native.DeployedAppVersion.List[0])],
 ['exact revision',f=>f.deps.revision=async()=>({ok:true,data:{assetKey:app,name:'ProofApp',revision:6}})],
 ['exact identity',f=>f.deps.revision=async()=>({ok:true,data:{assetKey:env,name:'ProofApp',revision:7}})],
 ['no portfolio',f=>f.deps.asset=async()=>({ok:true,data:{assetKey:app,portfolioKey:null}})]
])test('unproven '+name+' cannot become verified metadata',async()=>{const f=fixture();change(f);assert.equal((await readTimerDeployment(f.input,f.native,f.deps)).state,'unknown');});
test('missing or contradictory scope does no network work; failures stay unknown',async()=>{
 const f=fixture();f.input.screenVariables.SelectedStage.Key=app;assert.equal((await readTimerDeployment(f.input,f.native,f.deps)).reason,'selected_stage_mismatch');assert.equal(f.calls.length,0);
 assert.equal((await readTimerDeployment({},f.native,f.deps)).reason,'exact_application_and_stage_required');
 delete f.input.screenVariables.SelectedStage;f.deps.asset=async()=>{throw Object.assign(new Error('private transport detail'),{code:'READ_DEADLINE_EXCEEDED'})};const r=await readTimerDeployment(f.input,f.native,f.deps);assert.equal(r.state,'unknown');assert.equal(r.causeCode,'READ_DEADLINE_EXCEEDED');assert.equal(JSON.stringify(r).includes('private transport'),false);
});
