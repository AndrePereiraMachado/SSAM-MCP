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
// R4 (U1): the net10 pair serves v106 and still accepts v101, so a Studio that loaded it keeps service (a loaded DLL is never
// replaced); the net8 v107 of the agent pack is accepted on the three pairs, as v102 is, but only by an agent that runs
// reconcile-merge (agent 0.3.6 / 0.4.3-native): an old agent keeps its v102 pack, and an old core in a v107 pack is refused.
const withCommands = h => ({ ...h, agent: { ...h.agent, odcCommands: ['merge', 'reconcile-merge'] } });
test('R4: v106 on the net10 pair with v101 kept; v102 and v107 accepted on the three pairs, v107 only with reconcile-merge', () => {
  assert.equal(kernels.v1.odcBridge, 'v106');
  for (const pack of ['v101', 'v102', 'v98']) assert.equal(compatibility(hello(pack), kernel, ['odc', 'o11']).odc.ok, true, pack);
  for (const pack of ['v106', 'v107']) {
    assert.equal(compatibility(withCommands(hello(pack)), kernel, ['odc', 'o11']).odc.ok, true, pack);
    assert.equal(compatibility(hello(pack), kernel, ['odc', 'o11']).odc.code, 'AGENT_PACK_MISMATCH', pack + ' without reconcile-merge');
  }
  for (const name of ['v2', 'v3']) {
    const pair = { ...kernels[name], servedVersions: kernel.servedVersions };
    const h = { ...hello('v107', kernels[name].o11), studios: { odc: { installed: { version: kernels[name].odc + '.1' } }, o11: { installed: { version: kernels[name].o11 + '.1' } } } };
    const as = pack => ({ ...h, pack: { ...h.pack, odcBridge: pack } });
    assert.equal(compatibility(as('v102'), pair, ['odc', 'o11']).odc.ok, true, name + ' v102');
    assert.equal(compatibility(withCommands(as('v107')), pair, ['odc', 'o11']).odc.ok, true, name + ' v107');
    assert.equal(compatibility(as('v107'), pair, ['odc', 'o11']).odc.code, 'AGENT_PACK_MISMATCH', name + ' v107 without reconcile-merge');
  }
});
