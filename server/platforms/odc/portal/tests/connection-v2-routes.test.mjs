import test from 'node:test';
import assert from 'node:assert/strict';
import {PORTAL_READS,PORTAL_WRITES,routeOf} from '../runtime/portal-routes.mjs';
test('connection v2 reads use the observed data actions and cannot invoke deletion',()=>{
 for(const [id,action] of [['connections.revisionAndStages','GetLatestRevisionAndStages'],['connections.assetForStage','GetAssetDataForStage']]){
  assert.deepEqual(PORTAL_READS[id],['connections','Connections.connection_v2','connections/Connections/connection_v2/DataAction'+action]);
  assert.equal(PORTAL_WRITES[id],undefined);assert.throws(()=>routeOf(id,true));
 }
 assert.equal(Object.values(PORTAL_READS).some(route=>route[2].includes('ActionConnection_Delete')),false);
});
