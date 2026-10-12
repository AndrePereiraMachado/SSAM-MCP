import test from 'node:test';import assert from 'node:assert/strict';
import {connectionDeleteObservation} from '../runtime/connection-delete-observation.mjs';
const target={connectionId:'owned-id',connectionName:'Own',providerId:'a2a'};
const header={ok:true,data:{NotFound:false,Connection:{connectionId:'owned-id',name:'Own',providerId:'a2a',stageConfigurations:[]}}};
const empty={ok:true,truncated:false,rows:[]},gone={ok:true,data:{NotFound:true,Connection:null}};
test('retained native header and missing catalog entry do not prove complete deletion',()=>{
 assert.deepEqual(connectionDeleteObservation(header,empty,target),{absent:false,detailNotFound:false,listComplete:true,listAbsent:true,headerRetained:true,remainingStageCount:0});
 assert.equal(connectionDeleteObservation(gone,empty,target).absent,true);
 for(const listing of [{...empty,truncated:true},{...empty,ok:false},{ok:true,truncated:false},
  {...empty,rows:[{Name:'Own',ConnectionId:'other'}]},{...empty,rows:[{Name:'Other',Id:'owned-id'}]}])
  assert.equal(connectionDeleteObservation(gone,listing,target).absent,false);
 const unknown=connectionDeleteObservation({ok:false,error:{code:'PORTAL_TIMEOUT'}},empty,target);
 assert.equal(unknown.absent,false);assert.equal(unknown.headerRetained,false);assert.equal(unknown.detailError.code,'PORTAL_TIMEOUT');
 const foreign=structuredClone(header);foreign.data.Connection.connectionId='foreign';
 assert.equal(connectionDeleteObservation(foreign,empty,target).headerRetained,false);
});
