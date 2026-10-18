import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTools, discoverAll } from '../tool-routing.mjs';

for (const intent of ['criar app agentico no ODC', 'criar uma aplicacao agentica para atendimento', 'create an agentic app in ODC']) {
  test(intent + ' selects the agentic template kind', () => {
    const route = routeTools({lane: 'odc', intent}).tools[0];
    assert.equal(route.tool, 'studio_create_app');
    assert.equal(route.args.kind, 'agentic');
  });
}
test('agent model authoring stays on the model route', () => {
  assert.deepEqual(routeTools({lane: 'odc', intent: 'criar um agente com ferramentas e memoria'}).tools, []);
});

test('the model rule keeps agentic app creation when agentic denotes the app kind', async () => {
  const answer = await discoverAll({lane:'odc', intent:'criar app agentico no ODC', budgetBytes:12000}, {
    discover: async input => ({ok:true, lane:'odc', intent:input.intent,
      matches: /agent/.test(input.intent) ? [{id:'ai.agents',via:'match',score:6,route:{kind:'job'}}] : []})
  });
  assert.equal(answer.tools?.[0]?.tool, 'studio_create_app');
  assert.equal(answer.tools[0].args.kind, 'agentic');
});
test('listing agentic templates requests the agentic kind', () => {
  const route = routeTools({lane: 'odc', intent: 'listar templates de app agentico'}).tools[0];
  assert.equal(route.tool, 'studio_create_app');
  assert.equal(route.args.action, 'templates');
  assert.equal(route.args.kind, 'agentic');
});

import { jobGuidance } from '../job-guidance.mjs';
test('agent refusal returns the agent grammar and discovery continuation', async () => {
  const index = { key:'test', lane:'odc', jobs:[], negatives:[], limits:[], synonyms:{}, contracts:{agent:{shapes:{data:['name','model']}}},
    capabilities:[{id:'ai.agents',title:'Agents',contract:['agent.shapes'],route:{kind:'job'}}] };
  const result=await jobGuidance({lane:'odc',job:{ops:[{op:'agent',data:{name:'Support'}}]},
    run:{ok:false,error:'op #0 (agent ): InvalidOperationException: agent: model must be a non-empty string'},index});
  assert.equal(result.contract.pointer,'agent.shapes');
  assert.equal(result.capabilities[0].id,'ai.agents');
  assert.equal(result.continuation.tool,'ssam_discover');
});
