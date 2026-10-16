import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { createCallDeadline } from '../call-deadline.mjs';
import { createSsamServer } from '../ssam.mjs';
import { readTask, listTasks, tasksDir } from '../ssam-task.mjs';

const reply = v => ({content:[{type:'text',text:JSON.stringify(v)}],structuredContent:v,...(v.ok===false?{isError:true}:{})});
const value = r => r.structuredContent;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const tools = ['studio_publish','odc_asset_delete','ssam_job'];
// Junction CX12 x CX15 (M6-1): odc_asset_delete is a write only in its execution form (with its confirmationToken).
const argsOf = tool => ({target:'Synthetic-'+tool, ...(tool==='odc_asset_delete' ? {confirmationToken:'00000000-0000-4000-8000-00000000c12a.00000000000000c1'} : {})});
const finals = {ok:{ok:true,version:'v7'},failed:{ok:false,code:'SYNTHETIC_REFUSED',error:'synthetic definitive refusal'}};
const fresh = {ok:true,version:'v8'};
function rootFor(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx12-r3-reload-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
async function seedCancelled(run, args, release, started, dir) {
  const c=new AbortController(), pending=run(args,{mcpReq:{signal:c.signal}});
  await started;c.abort('synthetic cancellation');await assert.rejects(pending);
  release();
  for(let i=0;i<100;i++) {
    const task=listTasks({dir,limit:20})[0];
    if(task?.endedAt) {
      assert.equal(task.cancelled,true);assert.equal(task.deliveries,0);
      assert.ok(['ok','failed'].includes(task.state));return task;
    }
    await sleep(5);
  }
  assert.fail('synthetic handler did not finish');
}
const deadlineUrl=pathToFileURL(path.resolve('platforms/odc/facade/call-deadline.mjs')).href;
for(const tool of tools)for(const [outcome,final] of Object.entries(finals))for(const mode of ['new-deadline','new-process']) {
  test(`R3-2 ${tool} ${outcome}: cancelled definitive answer survives ${mode} and is delivered once`,async t=>{
    const root=rootFor(t),dir=tasksDir(root),args=argsOf(tool);let runs=0,start,release;
    const started=new Promise(r=>start=r),gate=new Promise(r=>release=r);
    const d1=createCallDeadline({root,timeoutMs:2000});
    const run1=d1.wrap(tool,async()=>{runs++;start();await gate;return reply(final);});
    const task=await seedCancelled(run1,args,release,started,dir);
    if(mode==='new-deadline') {
      const run2=createCallDeadline({root,timeoutMs:2000}).wrap(tool,async()=>{runs++;return reply(fresh);});
      const answer=await run2(args);
      assert.equal(runs,1,'identical retry must use the undelivered saved answer');
      assert.deepEqual(value(answer),final);
      assert.equal(readTask(task.id,{dir}).deliveries,1);
      assert.deepEqual(value(await run2(args)),fresh);assert.equal(runs,2,'next invocation is a new operation');
    } else {
      const source=`import {createCallDeadline} from ${JSON.stringify(deadlineUrl)};
        const reply=v=>({content:[{type:'text',text:JSON.stringify(v)}],structuredContent:v});
        let runs=0;const run=createCallDeadline({root:${JSON.stringify(root)},timeoutMs:2000}).wrap(${JSON.stringify(tool)},async()=>{runs++;return reply(${JSON.stringify(fresh)});});
        const first=await run(${JSON.stringify(args)}),runsAfterFirst=runs;
        const second=await run(${JSON.stringify(args)});
        console.log(JSON.stringify({first:first.structuredContent,second:second.structuredContent,runsAfterFirst,runs}));`;
      const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',env:process.env,timeout:15000});
      assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout.trim());
      assert.equal(runs+result.runsAfterFirst,1,'restart must not rerun the cancelled definitive operation');
      assert.deepEqual(result.first,final);assert.deepEqual(result.second,fresh);assert.equal(result.runs,1);
      assert.equal(readTask(task.id,{dir}).deliveries,1);
    }
  });
}
async function serverWith(root,tool,handler,lockMode) {
  const handlers=new Map(),identity={root,release:{head:'synthetic',facadeSha256:'synthetic',catalogSha256:'synthetic'}};
  const server=await createSsamServer({o11:false,odc:false,deps:{
    server:new McpServer({name:'synthetic-reload',version:'1'}),registerTool:(n,_c,h)=>handlers.set(n,h),
    answersRoot:root,callDeadlineMs:2000,identity:{read:()=>identity},
    ...(lockMode==='real'?{lock:{o11Root:root,odcRoot:root,connection:()=>null}}:{writeLock:async(_,fn)=>fn()})
  }});
  server.registerTool(tool,{inputSchema:fromJsonSchema({type:'object',properties:{target:{type:'string'}}}),annotations:{readOnlyHint:false}},handler);
  return {server,run:handlers.get(tool)};
}
for(const tool of tools)for(const [outcome,final] of Object.entries(finals))for(const lockMode of ['real','passthrough']) {
  test(`R3-2 server ${tool} ${outcome}: ${lockMode} lock preserves cancelled answer through reload`,async t=>{
    const root=rootFor(t),args=argsOf(tool);let runs=0,start,release;
    const started=new Promise(r=>start=r),gate=new Promise(r=>release=r);
    const first=await serverWith(root,tool,async()=>{runs++;start();await gate;return reply(final);},lockMode);
    t.after(()=>first.server.close());await seedCancelled(first.run,args,release,started,tasksDir(root));
    const second=await serverWith(root,tool,async()=>{runs++;return reply(fresh);},lockMode);t.after(()=>second.server.close());
    const answer=await second.run(args,{mcpReq:{signal:new AbortController().signal}});
    assert.equal(runs,1,'server reload must deliver the saved answer without invoking the lock or handler again');
    assert.deepEqual(value(answer),final);
    assert.deepEqual(value(await second.run(args,{mcpReq:{signal:new AbortController().signal}})),fresh);assert.equal(runs,2);
  });
}
