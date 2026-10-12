import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {alternateConnectionsInput as input,alternateConnectionsResult as result} from '../runtime/alternate-connections.mjs';
const scope=()=>({portfolioKey:crypto.randomUUID(),offset:0,search:''});
test('alternate console uses native V3 fields and an exact portfolio without caller bootstrap',()=>{
 const s=scope(),r=input(s);assert.equal(r.screenVariables.portfolioid,s.portfolioKey);assert.equal(r.screenVariables.SortAtribute,'LastUpdated');assert.equal(r.screenVariables.SortDirection,'DESC');
 for(const x of [{...s,offset:-1},{...s,offset:10001},{...s,portfolioKey:'other'},{...s,search:'\n'},{...s,screenVariables:{}},{...s,inputParameters:{}}])assert.throws(()=>input(x));
});
test('alternate console preserves pagination and exposes only selected V3 identity fields',()=>{
 const s=scope(),id=crypto.randomUUID(),data={Connections:{List:[{ConnectionId:id,Name:'Own fixture',OldProviderId:'customAISearch',ConsoleProviderId:'custom_ai_search',HasElementSelection:false,Headers:{secret:'private-marker'},Configuration:'private-marker'}]},TotalResults:'2',MaxRecords:1};
 const r=result(s,data);assert.equal(r.rows[0].ConnectionId,id);assert.equal(r.rows[0].HasElementSelection,false);assert.equal(r.nextOffset,1);assert.equal(r.complete,false);assert.equal(r.provisionalVisibilityVerified,false);assert.equal(JSON.stringify(r).includes('private-marker'),false);
 assert.equal(result({...s,offset:1},data).complete,true);
});
test('empty alternate console is bounded absence and never proves provisional records visible',()=>{
 const r=result(scope(),{Connections:{List:[]},TotalResults:0,MaxRecords:20});assert.equal(r.totalResults,0);assert.equal(r.complete,true);assert.equal(r.provisionalVisibilityVerified,false);
});
test('malformed collections, totals and identities cannot prove absence',()=>{
 const row={ConnectionId:crypto.randomUUID(),Name:'Fixture'},s=scope();
 for(const d of [{TotalResults:0,MaxRecords:20},{Connections:{List:[]},TotalResults:1,MaxRecords:20},{Connections:{List:[]},TotalResults:'',MaxRecords:20},{Connections:{List:[row]},TotalResults:0,MaxRecords:20},{Connections:{List:[row,row]},TotalResults:2,MaxRecords:20},{Connections:{List:[{Name:'Fixture'}]},TotalResults:1,MaxRecords:20},{Connections:{List:[row]},TotalResults:1,MaxRecords:0}])assert.throws(()=>result(s,d));
});
