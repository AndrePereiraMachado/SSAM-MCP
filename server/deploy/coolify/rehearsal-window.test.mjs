import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MAX_PAIRS,rehearsalWindow,pairWords,extraLicenses} from './rehearsal-window.mjs';
const kernels=JSON.parse(fs.readFileSync(new URL('./r1-kernels.json',import.meta.url),'utf8'));
const pairs=n=>Array.from({length:n},(_,i)=>({name:'v'+(i+1),image:'x'}));
// r44: the rehearsal took two to four pairs; a fifth pair (Service Studio 11.55.95 / ODC Studio 1.7.32) is now one more entry.
test('r44: the rehearsal window takes two to six pairs, five included, and every pair from the third gets a license', () => {
  assert.equal(MAX_PAIRS,6);
  assert.equal(rehearsalWindow(null),null);
  for(const n of [2,3,4,5,6])assert.equal(rehearsalWindow(pairs(n)),n);
  for(const n of [0,1,7])assert.throws(()=>rehearsalWindow(pairs(n)),/two to 6 images/);
  assert.throws(()=>rehearsalWindow([{name:'v1'},{name:'v1'}]),/own name/);
  assert.equal(pairWords(4),'four pairs');assert.equal(pairWords(5),'five pairs');
  assert.deepEqual(extraLicenses(2),[]);
  assert.deepEqual(extraLicenses(5).map(x=>x.index),[2,3,4]);
  assert.equal(new Set(extraLicenses(6).map(x=>x.customer)).size,4);
});
test('r44: the release kernels name the five pairs the rehearsal starts, and rehearse.mjs has no fixed pair count', () => {
  assert.deepEqual(Object.keys(kernels),['v1','v2','v3','v4','v5']);
  const source=fs.readFileSync(new URL('./rehearse.mjs',import.meta.url),'utf8');
  assert.match(source,/rehearsalWindow\(images\)/);
  assert.doesNotMatch(source,/images\?\.length===4|images\.length>4|\['v1','v2','v3','v4'\]\)/);
});
test('r44 rodada 2: the rehearsal backends get the served list and plugin mount of gen-compose, and mixed machines expect what that list answers', async () => {
  const {backendPlan,expectedLane,MODEL_PLUGINS_TARGET}=await import('./rehearsal-window.mjs');
  const window=[['1.7.30','11.55.94'],['1.7.29','11.55.93'],['1.7.28','11.55.92'],['1.7.31','11.55.94'],['1.7.32','11.55.95']].map(([odc,o11],i)=>({name:'v'+(i+1),odc,o11}));
  const kept=backendPlan(window,4),shared=backendPlan(window,0);
  for(const b of kept.slice(0,4))assert.deepEqual(JSON.parse(b.served),{odc:['1.7.30','1.7.29','1.7.28','1.7.31'],o11:['11.55.94','11.55.93','11.55.92']});
  assert.deepEqual(JSON.parse(kept[4].served).o11,['11.55.94','11.55.93','11.55.92','11.55.95']);
  for(const b of [...kept,...shared])assert.deepEqual(b.modelPlugins,{target:MODEL_PLUGINS_TARGET,readOnly:true});
  // the production case of 120 h on v4: ODC 1.7.31 + O11 11.55.95
  assert.equal(expectedLane('11.55.94',JSON.parse(kept[3].served).o11,'11.55.95'),'newer','layout B keeps it served');
  assert.equal(expectedLane('11.55.94',JSON.parse(shared[3].served).o11,'11.55.95'),'refused','one shared list refuses it');
  assert.equal(expectedLane('11.55.95',JSON.parse(kept[4].served).o11,'11.55.94'),'refused','v5 tells an older O11 to update');
  assert.equal(expectedLane('11.55.95',JSON.parse(kept[4].served).o11,'11.55.95'),'served');
  assert.equal(expectedLane('11.55.94',['11.55.94'],'11.55.91'),'refused');
  const source=fs.readFileSync(new URL('./rehearse.mjs',import.meta.url),'utf8');
  assert.match(source,/backendPlan\(pairs,keepServed\)/);assert.match(source,/plan\[index\]\.served/);assert.doesNotMatch(source,/JSON\.stringify\(images\?served/);
});