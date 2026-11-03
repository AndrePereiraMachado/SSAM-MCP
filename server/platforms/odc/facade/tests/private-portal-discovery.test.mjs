import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {projectShared} from '../discovery.mjs';
import {HOSTED_INSTRUCTIONS,HOSTED_INSTRUCTIONS_CODE_OFF} from '../ssam.mjs';

const fragment=JSON.parse(fs.readFileSync(new URL('../catalog/fragments/C/operations.json',import.meta.url),'utf8'));
test('private login remains discoverable with hosted code enabled and disabled',()=>{
 for(const text of [HOSTED_INSTRUCTIONS,HOSTED_INSTRUCTIONS_CODE_OFF]){
  assert.doesNotMatch(text,/No credential window opens here|prompt and focus answer HOSTED_PROMPT_UNAVAILABLE/);
  assert.match(text,/odc_portal_login prompt/);assert.match(text,/o11_service_center_session sign-in/);
 }
});
test('Portal and Service Center guides expose their own read and login paths in the correct lane',()=>{
 const portal=fragment.capabilities.find(c=>c.id==='ops.portal-monitoring');
 const sc=fragment.capabilities.find(c=>c.id==='ops.service-center');
 assert.deepEqual(portal.lanes,['odc']);assert.deepEqual(sc.lanes,['o11']);
 assert.match(portal.guidance,/environmentKey,applicationKey,since,until/);
 assert.match(portal.guidance,/summaries, not spans/);
 assert.match(portal.guidance,/not evidence of expired credentials/);
 assert.match(sc.guidance,/action:capabilities/);assert.match(sc.guidance,/session:vault/);
 assert.match(sc.guidance,/do not justify repeated sign-in/);
 for(const lane of ['odc','o11']){
  const projected=JSON.stringify(projectShared({schemaVersion:'ssam-discovery-capabilities-shared/2',lanes:['odc','o11'],capabilities:[portal,sc],synonyms:{}},lane));
  assert.match(projected,new RegExp(lane==='odc'?'ops.portal-monitoring':'ops.service-center'));
  assert.doesNotMatch(projected,new RegExp(lane==='odc'?'ops.service-center':'ops.portal-monitoring'));
 }
 assert.doesNotMatch(JSON.stringify(fragment),/Runtime logs and traces are not served by the facade/);
});
