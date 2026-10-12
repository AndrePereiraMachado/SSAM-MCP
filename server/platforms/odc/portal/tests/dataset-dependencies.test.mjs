import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {datasetDependencies} from '../runtime/dataset-dependencies.mjs';
const datasetId=randomUUID(),portfolio=randomUUID(),evaluationId=randomUUID();
const dataset={DatasetId:datasetId,PortfolioKey:portfolio};
const inventory={ok:true,complete:true,rows:[{EvalId:evaluationId,DatasetId:''}]};
function reads({list=inventory,detail={ok:true,data:{NotFound:false,Evaluation:{EvalId:evaluationId,PortfolioKey:portfolio,DatasetId:datasetId}}}}={}){
 return async(op,input)=>{
  if(op==='agents.dataset'){assert.equal(input.screenVariables.id,datasetId);return {ok:true,data:{NotFound:false,Dataset:dataset}};}
  if(op==='agents.evaluations'){assert.equal(input.screenVariables.PortfolioKey,portfolio);return list;}
  assert.equal(op,'agents.evaluation');assert.equal(input.screenVariables.id,evaluationId);return detail;
 };
}
test('false native dependency boolean cannot hide an exact positive evaluation link',async()=>{
 const r=await datasetDependencies({datasetId,native:{HasConnectedEvaluations:false},read:reads()});
 assert.equal(r.verified,true);assert.equal(r.hasConnectedEvaluations,true);assert.equal(r.nativeContradiction,true);assert.deepEqual(r.evaluationIds,[evaluationId]);
});
test('absence requires complete inventory and exact details, never a lossy list DatasetId',async()=>{
 const empty=await datasetDependencies({datasetId,native:{HasConnectedEvaluations:false},read:reads({list:{ok:true,complete:true,rows:[]}})});
 assert.equal(empty.verified,true);assert.equal(empty.hasConnectedEvaluations,false);
 for(const list of [{ok:true,complete:false,rows:[]},{ok:true,complete:true,rows:Array.from({length:26},()=>({EvalId:randomUUID()}))},{ok:true,complete:true,rows:[{}]},{ok:true,complete:true,rows:[{EvalId:evaluationId},{EvalId:evaluationId}]},{ok:false}])
  assert.equal((await datasetDependencies({datasetId,native:{HasConnectedEvaluations:false},read:reads({list})})).verified,false);
 const foreign={ok:true,data:{NotFound:false,Evaluation:{EvalId:evaluationId,PortfolioKey:randomUUID(),DatasetId:datasetId}}};
 assert.equal((await datasetDependencies({datasetId,native:{HasConnectedEvaluations:false},read:reads({detail:foreign})})).verified,false);
 const other={ok:true,data:{NotFound:false,Evaluation:{EvalId:evaluationId,PortfolioKey:portfolio,DatasetId:randomUUID()}}};
 assert.equal((await datasetDependencies({datasetId,native:{HasConnectedEvaluations:false},read:reads({detail:other})})).hasConnectedEvaluations,false);
});

test('unconfirmed native positive never certifies an absent relationship',async()=>{
 const r=await datasetDependencies({datasetId,native:{HasConnectedEvaluations:true},read:reads({list:{ok:true,complete:true,rows:[]}})});
 assert.equal(r.verified,false);assert.equal(r.reason,'native-positive-not-confirmed');
});
