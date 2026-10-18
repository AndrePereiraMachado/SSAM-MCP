import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {OdcAccess} from '../runtime/access.mjs';
import {sha256} from '../runtime/write-journal.mjs';
import {IP_FILTER_DELETE} from '../runtime/ip-filter-approval.mjs';
import {IP_FILTER_INVENTORY,ipFilterDeleteScope,ipFilterDeleteObservation} from '../runtime/ip-filter-delete-observation.mjs';
const environmentKey=crypto.randomUUID(),ipFilterGroupKey=crypto.randomUUID(),operationUuid=crypto.randomUUID(),words='Synthetic original fixture authorization';
function fixture(){
 const receipt={operationUuid,state:'accepted',identity:{kind:'odc-public',tenant:'example.outsystems.dev',operationId:IP_FILTER_DELETE,target:{environmentKey,ipFilterGroupKey}},authorization:{wordsSha256:sha256(words)}};
 const reconcile={state:'confirmed',authorize:words,read:{operationId:IP_FILTER_INVENTORY,auth:'api-client',path:{environmentKey}}};
 return{receipt,reconcile};
}
const inventory=results=>({ok:true,status:200,data:{results}}),row=(key=crypto.randomUUID())=>({key,name:'Synthetic group'});
test('only a complete exact inventory proves deletion, without claiming restoration',()=>{
 const {receipt,reconcile}=fixture(),scope=ipFilterDeleteScope(receipt,reconcile);
 const r=ipFilterDeleteObservation(scope,inventory([row('default'),row()]));
 assert.equal(r.verified,true);assert.equal(r.inventoryComplete,true);assert.equal(r.configurationRestorationVerified,false);
 assert.equal(ipFilterDeleteObservation(scope,inventory([row(ipFilterGroupKey)])).verified,false);
});
for(const [label,patch]of [
 ['wrong grant',r=>{r.authorize='Another synthetic authorization';}],['wrong stage',r=>{r.read.path.environmentKey=crypto.randomUUID();}],
 ['extra scope',r=>{r.read.path.ipFilterGroupKey=ipFilterGroupKey;}],['wrong tenant',r=>{r.read.tenant='other.outsystems.dev';}],
 ['detail read',r=>{r.read.operationId=IP_FILTER_INVENTORY+'/{ipFilterGroupKey}';}],['filtered inventory',r=>{r.read.query={name:'Other'};}],
 ['body',r=>{r.read.body={};}],['not-applied',r=>{r.state='not-applied';}],
])test(label+' never reconciles and sends no read',async()=>{
 const {receipt,reconcile}=fixture();patch(reconcile);let sends=0,settles=0;
 const access=new OdcAccess({receipts:{lookup:()=>receipt,reconcile:()=>{settles++;}}});access.read=async()=>{sends++;return inventory([]);};
 const result=await access.receipt({operationUuid,reconcile});assert.equal(result.ok,false);assert.equal(result.error.code,'IP_FILTER_DELETE_UNVERIFIED');
 assert.equal(receipt.state,'accepted');assert.equal(sends,0);assert.equal(settles,0);
});
test('failed, paginated, malformed and duplicate inventories never count as absence',()=>{
 const {receipt,reconcile}=fixture(),scope=ipFilterDeleteScope(receipt,reconcile),a=row();
 for(const result of [{ok:false,status:404},inventory(null),{...inventory([]),status:206},{...inventory([]),data:{results:[],page:{totalResults:2}}},inventory([a,a]),inventory([{}]),inventory([row('foreign')])])
  assert.throws(()=>ipFilterDeleteObservation(scope,result),e=>e.code==='IP_FILTER_DELETE_UNVERIFIED');
});
test('accepted and uncertain deletions reconcile with one read, a present group remains pending',async()=>{
 for(const state of ['accepted','uncertain'])for(const present of [true,false]){
  const {receipt,reconcile}=fixture();receipt.state=state;let sends=0,settles=0;
  const access=new OdcAccess({receipts:{lookup:()=>receipt,reconcile:(r,{state,observation})=>{settles++;r.state=state;r.proof=observation;return r;}}});
  access.read=async args=>{sends++;assert.deepEqual(args,{tenant:'example.outsystems.dev',...reconcile.read});return inventory(present?[row(ipFilterGroupKey)]:[row('default')]);};
  const result=await access.receipt({operationUuid,reconcile});assert.equal(result.ok,!present);assert.equal(sends,1);assert.equal(settles,present?0:1);
  assert.equal(receipt.state,present?state:'confirmed');
  if(!present){await access.receipt({operationUuid,reconcile});assert.equal(sends,1);}
 }
});
