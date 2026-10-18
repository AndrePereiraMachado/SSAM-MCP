import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {knowledgeBaseReadInput,knowledgeFilePage} from '../runtime/knowledge-file-read.mjs';
test('base reads select the same exact environment in native screen state',()=>{
  const input={knowledgeBaseId:randomUUID(),environmentKey:randomUUID(),portfolioKey:randomUUID()};
  const {screenVariables:v}=knowledgeBaseReadInput(input);
  assert.equal(v.SelectedEnvironmentId,input.environmentKey);assert.equal(v.stageid,input.environmentKey);
  assert.equal(v.ActivePortfolioKey,input.portfolioKey);assert.equal(v.KnowledgeBaseId,input.knowledgeBaseId);
  assert.throws(()=>knowledgeBaseReadInput({...input,environmentKey:''}),{code:'INPUT_INVALID'});
});
test('file pages distinguish full inventory, continuation and incomplete final page',()=>{
  const row={FileId:randomUUID(),Filename:'proof.txt'};
  assert.equal(knowledgeFilePage({Files:{List:[]},TotalResults:'0',MaxRecords:20}).complete,true);
  const first=knowledgeFilePage({Files:{List:[row]},TotalResults:'2',MaxRecords:1});
  assert.equal(first.complete,false);assert.equal(first.nextOffset,1);
  const last=knowledgeFilePage({Files:{List:[row]},TotalResults:'2',MaxRecords:1},{offset:1});
  assert.equal(last.nextPageAvailable,false);assert.equal(last.complete,false);
});
test('inconsistent file counts and identities never establish absence',()=>{
  const row={FileId:randomUUID(),Filename:'proof.txt'};
  for(const data of [{Files:{List:[]},TotalResults:'1',MaxRecords:20},
    {Files:{List:[]},TotalResults:null,MaxRecords:20},
    {Files:{List:[]},TotalResults:false,MaxRecords:20},
    {Files:{List:[]},TotalResults:' ',MaxRecords:20},
    {Files:{List:[row,row]},TotalResults:2,MaxRecords:20},
    {Files:{List:[{...row,FileId:'bad'}]},TotalResults:1,MaxRecords:20},
    {Files:{List:[row]},TotalResults:0,MaxRecords:20}])
    assert.throws(()=>knowledgeFilePage(data),{code:'PORTAL_CONTRACT_CHANGED'});
});
