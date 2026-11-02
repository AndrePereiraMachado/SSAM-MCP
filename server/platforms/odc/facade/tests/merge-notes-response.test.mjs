import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDelivery, shapeToolResult } from '../responses.mjs';
import { phasedDeliver } from '../odc-build-phase.mjs';

for (const outcome of ['strict', 'normalized', 'refused']) test(`merge notes survive the public delivery response: ${outcome}`, async () => {
  const mergeNotes = ['The person\'s Description was "person value"; the delivery value was selected.'];
  const value = outcome === 'refused'
    ? { ok:false, code:'PUBLISH_FAILED', merged:true, error:'Publication failed', mergeNotes }
    : { ok:true, merged:true, strictlyEqual:outcome==='strict', equivalence:outcome, result:'delivered', mergeNotes };
  assert.deepEqual(compactDelivery('studio_deliver', {until:'merge'}, value).mergeNotes, mergeNotes);
  const answer = shapeToolResult('studio_deliver', {until:'merge'}, {structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]});
  assert.deepEqual(answer.structuredContent.mergeNotes, mergeNotes);
  assert.deepEqual(JSON.parse(answer.content[0].text).mergeNotes, mergeNotes);
});

test('the native conflict receipt produces a person-value note through public compaction', async () => {
  const receipt={ok:true,merged:true,strictlyEqual:true,merge:{merged:true,resolvedConflicts:{count:1,conflicts:1,others:0,truncated:false,entries:[{element:'UserAction:PreferA',property:'Description',user:'R39B person concurrent Description',delivery:'R39B delivery Description wins',conflict:true}]}}};
  const value=await phasedDeliver({}, {}, {deliver:async()=>receipt});
  const answer=compactDelivery('studio_deliver', {until:'merge'}, value);
  assert.ok(answer.mergeNotes?.some(n=>n.includes('R39B person concurrent Description')));
});
