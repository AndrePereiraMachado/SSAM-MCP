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
