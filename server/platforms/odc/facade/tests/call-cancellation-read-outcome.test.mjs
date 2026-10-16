import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCallDeadline} from '../call-deadline.mjs';
const reply=v=>({content:[{type:'text',text:JSON.stringify(v)}],structuredContent:v});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const cancelled of [false,true])test(`N1 completed pure read with an uncertain observation allows a fresh read (${cancelled?'cancelled':'delivered'})`,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx12-read-outcome-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const deadline=createCallDeadline({root,timeoutMs:1000});let calls=0,release;const gate=new Promise(r=>release=r);
 const run=deadline.wrap('synthetic_pure_read',async()=>{calls++;if(calls===1){await gate;return reply({ok:false,outcome:'uncertain',observation:'Synthetic reading incomplete'});}return reply({ok:true,version:7});},{annotations:{readOnlyHint:true}});
 const c=new AbortController(),original=run({target:'Synthetic'},{mcpReq:{signal:c.signal}});
 if(cancelled){await sleep(20);c.abort();await assert.rejects(original,e=>e.code==='CANCELLED');release();await sleep(5);}else{release();assert.equal((await original).structuredContent.outcome,'uncertain');}
 const fresh=await run({target:'Synthetic'});assert.equal(calls,2);assert.equal(fresh.structuredContent.version,7);assert.equal(fresh.structuredContent.close,undefined);
});
