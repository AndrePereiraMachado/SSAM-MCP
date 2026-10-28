import '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {compatibility} from '../../platforms/odc/facade/agent-hub.mjs';
import {studioRefusal} from '../../platforms/odc/facade/studio-identity.mjs';
const kernels=JSON.parse(fs.readFileSync(new URL('../coolify/r1-kernels.json',import.meta.url),'utf8'));
const kernel={...kernels.v1,servedVersions:{odc:['1.7.30','1.7.29','1.7.28'],o11:['11.55.94','11.55.93','11.55.92']}};
function hello(bridge,o11='11.55.94') {return {agent:{version:'0.1.3'},studios:{odc:{installed:{version:'1.7.30.10980'}},o11:{installed:{version:o11+'.65328'}}},pack:{lanes:['odc','o11'],odcBridge:bridge,o11BuiltFor:o11,o11Hook:'dev'}};}
test('the new pair accepts the current v98 agent and refuses v97',()=>{
  assert.equal(compatibility(hello('v98'),kernel,['odc','o11']).odc.ok,true);
  assert.equal(compatibility(hello('v97'),kernel,['odc','o11']).odc.code,'AGENT_PACK_MISMATCH');
});
for(const o11 of ['11.55.93','11.55.92'])test(`the mixed ${o11} machine retains ODC and receives the exact O11 update step`,()=>{
  const result=compatibility(hello('v98',o11),kernel,['odc','o11']);
  assert.equal(result.odc.ok,true);assert.equal(result.o11.cause,'STUDIO_VERSION_CHANGED');
  assert.match(result.o11.message,/Update Service Studio to 11\.55\.94/);
  assert.equal(studioRefusal(result.o11.studio).continuation.tool,'ssam_doctor');
});
