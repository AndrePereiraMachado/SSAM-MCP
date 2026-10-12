import test from 'node:test';
import assert from 'node:assert/strict';
import {routeOf} from '../runtime/portal-routes.mjs';

test('library release reads and write resolve to their exact native routes without crossing read/write boundaries',()=>{
 for(const [id,action] of [['libraries.releaseSettings','DataActionGetSettings'],['libraries.releaseRevision','DataActionGetRevision']]){
  const route=routeOf(id,false);
  assert.equal(route.module,'apps');
  assert.equal(route.view,'library.libraryrelease');
  assert.equal(route.action,`apps/library/libraryrelease/${action}`);
  assert.throws(()=>routeOf(id,true));
 }
 assert.equal(routeOf('libraries.release',true).action,'apps/library/libraryrelease/ActionReleaseLibrary_ValidateAndSave');
 assert.throws(()=>routeOf('libraries.release',false));
});
