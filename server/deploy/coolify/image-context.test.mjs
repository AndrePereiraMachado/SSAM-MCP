import test from 'node:test';import assert from 'node:assert/strict';
import {readIgnore,excluded} from '../../platforms/odc/facade/tests/hosted-image-denylist.test.mjs';
test('the hosted image excludes tests placed beside the router',()=>{
 const rules=readIgnore();assert.equal(excluded('platforms/odc/facade/hosted/router.test.mjs',rules),true);assert.equal(excluded('platforms/odc/facade/hosted/router.mjs',rules),false);
});
