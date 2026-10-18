import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readQualityPatternPage } from '../runtime/quality-pattern-pagination.mjs';
const rows = Array.from({length:37},(_,i)=>({id:`pattern-${i}`,name:`Pattern ${i}`}));
const reply = () => ({ok:true,status:200,data:{results:rows,page:{count:37,totalResults:37,offset:0,limit:1000,nextPageOffset:0,totalPages:1}}});
test('record offsets page a verified complete bounded native catalog',async()=>{
 const pages=[];
 for(const offset of [0,20,37,100]) {
  let calls=0;
  const r=await readQualityPatternPage({query:{Limit:20,Offset:offset}},async input=>{calls++;assert.deepEqual(input.query,{Limit:1000,Offset:0});return reply();});
  assert.equal(calls,1);assert.deepEqual(r.data.results,rows.slice(offset,offset+20));
  assert.equal(r.data.page.offset,offset);assert.equal(r.data.page.totalPages,2);
  assert.equal(r.data.page.nextPageOffset,offset===0?20:null);pages.push(r);
 }
 assert.deepEqual(pages[0].data.results.concat(pages[1].data.results),rows);
});
test('refuses incomplete, duplicate, absent and contradictory catalog identities',async()=>{
 for(const change of [r=>r.data.page.totalResults=1001,r=>r.data.page.count=1,r=>r.data.page.offset=1,r=>r.data.page.totalResults=38,
  r=>r.data.results=[...rows.slice(0,36),rows[0]],r=>r.data.results=[...rows.slice(0,36),{}],r=>delete r.data.page]) {
  const r=structuredClone(reply());change(r);
  await assert.rejects(readQualityPatternPage({query:{Limit:20,Offset:20}},async()=>r),e=>e.code==='PUBLIC_PAGINATION_UNVERIFIED');
 }
});
test('native errors and unspecified limits retain their original response',async()=>{
 const failure={ok:false,status:403};assert.equal(await readQualityPatternPage({query:{Limit:20}},async()=>failure),failure);
 const input={query:{}};let passed;const original=reply();assert.equal(await readQualityPatternPage(input,async x=>{passed=x;return original}),original);assert.equal(passed,input);
});

test('domain endpoint ignoring pagination is sliced only after all IDs are verified',async()=>{
 const {readCatalogPage,ENVIRONMENT_DOMAINS}=await import('../runtime/quality-pattern-pagination.mjs');
 const domainRows=[{id:'d1'},{id:'d2'},{id:'d3'}];let calls=0;
 const result=await readCatalogPage(ENVIRONMENT_DOMAINS,{path:{environmentKey:'env'},query:{limit:1,offset:1}},async input=>{
  calls++;assert.deepEqual(input,{path:{environmentKey:'env'},query:{limit:1000,offset:0}});
  return {ok:true,data:{results:domainRows,page:{totalResults:3,count:3,limit:3,offset:0,totalPages:1}}};
 });
 assert.equal(calls,1);assert.deepEqual(result.data.results,[domainRows[1]]);assert.equal(result.data.page.nextPageOffset,2);
 assert.equal(result.pagination.nativeOffsetSemantics,'ignored');
 for(const query of [{limit:0,offset:0},{limit:1,offset:-1}])
  await assert.rejects(readCatalogPage(ENVIRONMENT_DOMAINS,{query},async()=>{throw Error('must not send')}),e=>e.code==='INPUT_INVALID');
});
