import test from 'node:test';import assert from 'node:assert/strict';
import {readIgnore,excluded} from '../../platforms/odc/facade/tests/hosted-image-denylist.test.mjs';
test('the hosted image excludes tests placed beside the router',()=>{
 const rules=readIgnore();assert.equal(excluded('platforms/odc/facade/hosted/router.test.mjs',rules),true);assert.equal(excluded('platforms/odc/facade/hosted/router.mjs',rules),false);
});
test('the build context keeps the one file of the provenance stage and nothing else of the vigia',()=>{
 const rules=readIgnore();assert.equal(excluded('deploy/vigia/no-provenance.json',rules),false);assert.equal(excluded('deploy/vigia/runtime.mjs',rules),true);assert.equal(excluded('deploy/vigia/publisher-pins.json',rules),true);
});
