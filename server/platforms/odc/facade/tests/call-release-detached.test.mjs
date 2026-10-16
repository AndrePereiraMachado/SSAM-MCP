import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { createSsamServer, RESTART_NEXT } from '../ssam.mjs';
import { createCallDeadline } from '../call-deadline.mjs';
import { workspaceRoot } from '../workspace.mjs';
const reply = structuredContent => ({content:[{type:'text',text:JSON.stringify(structuredContent)}],structuredContent});
const base = {name:'ssam',root:workspaceRoot,startedAt:'2026-10-14T00:00:00Z',release:{head:'a'.repeat(40),facadeSha256:'1'.repeat(64),catalogSha256:'2'.repeat(64),launcherSha256:null}};
async function setup(t, bootstrap) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx12-release-'));
  const registered=new Map(); let current=base;
  const bootDeadline=bootstrap ? createCallDeadline({root,timeoutMs:35}) : null;
  const server=await createSsamServer({o11:false,odc:false,deps:{server:new McpServer({name:'fake',version:'1'}),
    registerTool:(name,config,handler)=>registered.set(name,handler),answersRoot:root,callDeadlineMs:35,
    ...(bootstrap ? {activeDeadline:()=>bootDeadline} : {}),writeLock:(_options,fn)=>fn(),
    doctor:{lanes:{o11:async()=>({ok:true,lane:'o11'}),odc:async()=>({ok:true,lane:'odc'})}},
    identity:{started:base,read:()=>current,cacheMs:0,launchCwd:workspaceRoot}}});
  t.after(async()=>{await server.close();fs.rmSync(root,{recursive:true,force:true});});
  let finish;const work=new Promise(resolve=>{finish=resolve;});let calls=0;
  server.registerTool('o11_publish',{inputSchema:fromJsonSchema({type:'object',properties:{module:{type:'string'}}})},async()=>{calls++;await work;return reply({ok:true});});
  const invoke=(name,args={})=>registered.get(name)(args,{mcpReq:{signal:new AbortController().signal}});
  return {invoke,finish,calls:()=>calls,change:kind=>{current={...base,release:{...base.release,[kind+'Sha256']:'3'.repeat(64)}};},
    resume:args=>bootstrap ? bootDeadline.wrap('o11_publish',server.ssamHandlers.get('o11_publish'))(args) : invoke('o11_publish',args),
    start:()=>bootstrap ? bootDeadline.wrap('o11_publish',server.ssamHandlers.get('o11_publish'))({module:'M'}) : invoke('o11_publish',{module:'M'})};
}
for(const kind of ['facade','catalog']) for(const bootstrap of [false,true]) test(`R3 ${kind}: ${bootstrap?'cached':'core'} deadline protects detached write and doctor`,async t=>{
  const h=await setup(t,bootstrap),running=(await h.start()).structuredContent;
  assert.equal(running.state,'running');h.change(kind);
  const refusal=(await h.invoke('o11_publish',{module:'N'})).structuredContent;
  const doctor=(await h.invoke('ssam_doctor')).structuredContent;
  for(const value of [refusal,doctor]) {
    assert.ok(value.tasks?.some(task=>task.id===running.task.id && task.tool==='o11_publish' && task.isWrite===true),JSON.stringify(value));
    assert.equal(value.continuation.tool,running.continuation.tool);
    assert.deepEqual(value.continuation.arguments,running.continuation.arguments);
    assert.match(value.next,/launcher.*automatically.*all.*finish/i);
    assert.ok(!JSON.stringify(value).includes(RESTART_NEXT));
  }
  h.finish();assert.deepEqual((await h.resume(running.continuation.arguments)).structuredContent,{ok:true});
  const idle=(await h.invoke('ssam_doctor')).structuredContent;
  assert.equal(idle.next,RESTART_NEXT);assert.equal(h.calls(),1);
});
test('R3 idle release response keeps its restart and doctor continuation',async t=>{
 const h=await setup(t,false);h.change('facade');
 for(const name of ['o11_publish','ssam_doctor']) {
   const v=(await h.invoke(name,name==='o11_publish'?{module:'N'}:{})).structuredContent;
   assert.equal(v.next,RESTART_NEXT);assert.equal(v.continuation.tool,'ssam_doctor');assert.equal(v.tasks,undefined);
 }
 h.finish();
});
test('R3 doctor lists every detached write even before the identity changes',async t=>{
  const h=await setup(t,false),first=(await h.start()).structuredContent;
  const second=(await h.invoke('o11_publish',{module:'Second'})).structuredContent;
  const value=(await h.invoke('ssam_doctor')).structuredContent;
  assert.deepEqual(value.tasks.map(task=>task.id).sort(),[first.task.id,second.task.id].sort());
  assert.ok(value.tasks.every(task=>task.tool==='o11_publish' && task.isWrite===true && task.continuation.arguments.continueTask===task.id));
  assert.equal(value.continuation.arguments.continueTask,first.task.id);
  assert.match(value.next,/if.*release.*changed/i);assert.ok(!JSON.stringify(value).includes(RESTART_NEXT));
  h.finish();await h.resume(first.continuation.arguments);await h.resume(second.continuation.arguments);
  assert.equal(h.calls(),2);
});
