import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {datasetCreationOutcome,datasetCreationObservation} from '../runtime/dataset-receipt.mjs';
test('dataset receipt retains both native identities but does not claim read-back',()=>{
 assert.deepEqual(datasetCreationOutcome({DatasetId:'dataset-id',GroupId:'group-id',Unrelated:'omit'}),
  {state:'accepted',response:{DatasetId:'dataset-id',GroupId:'group-id'}});
 assert.deepEqual(datasetCreationOutcome({DatasetId:'dataset-id'}),{state:'accepted',response:{DatasetId:'dataset-id'}});
});
test('successful response without a concrete dataset identity stays uncertain',()=>{
 for(const data of [null,{}, {DatasetId:''},{DatasetId:' '},{DatasetId:1},{GroupId:'group-only'}]){
  const result=datasetCreationOutcome(data);assert.equal(result.state,'uncertain');
  assert.equal(result.error.code,'DATASET_ID_UNVERIFIED');assert.deepEqual(result.response,{});
 }
});

test('persisted dataset proof compares all approved headers and complete case content',()=>{
 const expected={Name:'OwnDataset',Description:'Synthetic',AgenticAppId:'app',ServiceActionId:'action',PortfolioKey:'portfolio',AssetType:'',
  SetupAppId:'',SetupServiceActionId:'',TeardownAppId:'',TeardownServiceActionId:''};
 const cases=[{name:'case',inputs:{Messages:[{Role:2}]},expectations:{expectedResponse:{Response:'OK'},guidelines:['Exact'],expectedTools:[]}}];
 const dataset={...expected,DatasetId:'id',TestCaseCount:'1',TestCases:{List:[{Name:'case',Description:'',Inputs:'{"Messages":[{"Role":2}]}',
  Expectations:{ExpectedResponse:'{"Response":"OK"}',Guidelines:{List:['Exact']},ExpectedTools:{List:[]}}}]}};
 const scope={datasetId:'id',expected,cases},result={ok:true,data:{NotFound:false,Dataset:dataset}};
 assert.equal(datasetCreationObservation(scope,result).verified,true);
 for(const key of Object.keys(expected))assert.equal(datasetCreationObservation(scope,{...result,data:{...result.data,Dataset:{...dataset,[key]:'other'}}}).verified,false,key);
 for(const patch of [{DatasetId:'foreign'},{TestCaseCount:'2'},{TestCases:{List:[]}},{TestCases:{List:[{...dataset.TestCases.List[0],Inputs:'broken'}]}},
  {TestCases:{List:[{...dataset.TestCases.List[0],Expectations:{...dataset.TestCases.List[0].Expectations,ExpectedResponse:'{"Response":"changed"}'}}]}}])
  assert.equal(datasetCreationObservation(scope,{...result,data:{...result.data,Dataset:{...dataset,...patch}}}).verified,false);
 assert.equal(datasetCreationObservation(scope,{ok:false}).verified,false);
 assert.equal(datasetCreationObservation(scope,{...result,data:{...result.data,NotFound:true}}).verified,false);
});
