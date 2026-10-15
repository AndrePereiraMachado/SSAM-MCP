import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createPreviewManager } from '../preview/manager.mjs';
import { atomicJson, digest, loadProfile } from '../preview/profile.mjs';
import { registerPreviewTools } from '../preview/mcp.mjs';
import { startManagedWatcher } from '../preview/engines/watcher/run.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const pin=file=>({file,sha256:digest(fs.readFileSync(file))});
function fixture(t){
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-preview-'));
 const provider=path.join(workspace,'provider.mjs');
 fs.writeFileSync(provider,`import http from 'node:http';export async function startLiveHost(c){if(c.fail)throw Object.assign(Error('test startup failure'),{code:'TEST_STARTUP'});const s=http.createServer((q,r)=>r.end('fixture'));await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r)});return{url:'http://127.0.0.1:'+s.address().port+'/',manager:{state:{promoted:{buildId:'fixture'},rendered:null}},poll(){},close:()=>new Promise(r=>s.close(r))}}`);
 const cfg=path.join(workspace,'host.json');atomicJson(cfg,{startAllowed:true,bindHost:'127.0.0.1',port:12345,target:{moduleKey:'test-module',screenKey:'test-screen'}});
 const p={schema:'ssam-preview-profile/1',id:'fixture',lane:'o11',target:{app:'Fixture',tenant:'local',moduleKey:'test-module'},screens:[{name:'Home',key:'test-screen'}],limitations:['Test provider only'],implementation:'o11-native',syntheticData:true,realBackend:false,realAccessValidated:false,automaticWatching:false,host:{module:pin(provider),config:pin(cfg)}};
 const file=path.join(workspace,'profile.json'),catalog=path.join(workspace,'.local/preview/catalog.json');
 function save(){atomicJson(file,p);atomicJson(catalog,{schema:'ssam-preview-catalog/1',profiles:[pin(file)]});}
 save();let launches=0;const children=[];
 const manager=createPreviewManager({workspace,spawnProcess(...args){launches++;const c=spawn(...args);children.push(c);return c;}});
 t.after(async()=>{await manager({action:'stop',sessionId:'fixture'});for(const c of children){const end=Date.now()+SETTLE_MS;while(c.exitCode===null&&Date.now()<end)await delay(50);assert.notEqual(c.exitCode,null,'owned worker must exit gracefully');}fs.rmSync(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 return {workspace,p,cfg,file,catalog,save,manager,get launches(){return launches;}};
}
// The worker is a child process: on a loaded machine its start or stop can take longer than the 8 s an open waits for it
// and the 4 s these tests used to wait. An answer that is not terminal ('starting', 'stopping') is followed with status, as its
// continuation says, until the session settles or SETTLE_MS passes; the assertions are on the settled state.
const SETTLE_MS=60000;
async function until(manager,done,sessionId='fixture'){const end=Date.now()+SETTLE_MS;let s;while(Date.now()<end){s=await manager({action:'status',sessionId});if(done(s))return s;await delay(50);}assert.fail(`the preview session did not settle in ${SETTLE_MS} ms: ${JSON.stringify(s)}`);}
const settledStart=s=>!['starting','unreachable'].includes(s.status);
// open; when the worker is still starting, the same open once the session settled (it reuses that instance: one launch).
async function open(manager,args={}){const first=await manager({action:'open',...args});if(first.status!=='starting')return first;const s=await until(manager,settledStart);return ['stopped','failed'].includes(s.status)?s:manager({action:'open',...args});}
async function stopped(manager){const s=await until(manager,x=>['stopped','failed'].includes(x.status));assert.equal(s.status,'stopped',JSON.stringify(s));return s;}

test('managed worker opens once, exposes visible URL, reports static refresh and exits',async t=>{
 const f=fixture(t),m=f.manager;
 assert.equal((await m({action:'list',lane:'odc'})).profiles.length,0);
 assert.equal((await m({action:'open',app:'Other'})).code,'PREVIEW_PROFILE_NOT_PREPARED');
 assert.equal((await m({action:'open',screen:'Other'})).code,'PREVIEW_SCREEN_NOT_PREPARED');
 const opened=await open(m,{screen:'Home'});assert.equal(opened.status,'running',JSON.stringify(opened));
 assert.equal(opened.browser.action,'open-visible');assert.match(opened.url,/\?entry=test-screen$/);assert.equal(opened.render,null);
 assert.equal(await (await fetch(opened.url)).text(),'fixture');
 const reused=await m({action:'open'});assert.equal(reused.instanceId,opened.instanceId);assert.equal(reused.reused,true);assert.equal(f.launches,1);
 const refreshed=await m({action:'refresh'});assert.equal(refreshed.refresh.captureRequested,false);assert.equal(refreshed.refresh.code,'PREVIEW_STATIC_CAPTURE');
 const endpoint=JSON.parse(fs.readFileSync(path.join(f.workspace,'.local/preview/sessions/fixture/control.json')));
 assert.equal((await fetch(`http://127.0.0.1:${endpoint.port}/stop`,{method:'POST'})).status,403);
 f.p.limitations.push('changed');f.save();assert.equal((await m({action:'open'})).code,'PREVIEW_PROFILE_IN_USE');
 assert.equal((await m({action:'stop',sessionId:'fixture'})).status,'stopping');await stopped(m);
 const next=await open(m);assert.equal(next.status,'running',JSON.stringify(next));assert.notEqual(next.instanceId,opened.instanceId);assert.equal(f.launches,2);
 await m({action:'stop',sessionId:'fixture'});await stopped(m);
});
test('simultaneous opens never spawn twice',async t=>{
 const f=fixture(t);const results=await Promise.all([f.manager({action:'open'}),f.manager({action:'open'})]);
 assert.equal(f.launches,1);assert.ok(results.some(x=>x.code==='PREVIEW_OPEN_BUSY'));
 const winner=results.find(x=>x.code!=='PREVIEW_OPEN_BUSY');assert.equal((winner.status==='starting'?await until(f.manager,settledStart):winner).status,'running',JSON.stringify(results));
});
test('changed pins, nonlocal host and false scope are refused before launch',async t=>{
 const f=fixture(t);fs.appendFileSync(f.cfg,' ');assert.equal((await f.manager({action:'open'})).code,'PREVIEW_PIN_CHANGED');
 const config=JSON.parse(fs.readFileSync(f.cfg));config.bindHost='0.0.0.0';atomicJson(f.cfg,config);f.p.host.config=pin(f.cfg);f.save();
 assert.equal((await f.manager({action:'open'})).code,'PREVIEW_LOOPBACK_REQUIRED');
 f.p.realBackend=true;f.save();assert.equal((await f.manager({action:'open'})).code,'PREVIEW_LOCAL_SCENARIO_REQUIRED');assert.equal(f.launches,0);
});
test('startup failure has a terminal receipt',async t=>{
 const f=fixture(t);const cfg=JSON.parse(fs.readFileSync(f.cfg));cfg.fail=true;atomicJson(f.cfg,cfg);f.p.host.config=pin(f.cfg);f.save();
 const s=await open(f.manager);assert.equal(s.status,'failed');assert.equal(s.code,'TEST_STARTUP');assert.equal(f.launches,1);
});
test('uncertain or mismatched control endpoint cannot authorize duplicate start or stop',async t=>{
 const f=fixture(t),m=f.manager;await open(m);
 const file=path.join(f.workspace,'.local/preview/sessions/fixture/control.json'),endpoint=JSON.parse(fs.readFileSync(file));
 atomicJson(file,{...endpoint,instanceId:'another-instance'});
 try {const s=await m({action:'open'});assert.equal(s.status,'unreachable');assert.equal(s.outcome,'uncertain');assert.equal(f.launches,1);assert.equal((await m({action:'stop'})).status,'unreachable');}
 finally{atomicJson(file,endpoint);}
});
test('a session file replaced while another process reads it is never lost (the manager polls the receipt the worker writes)',async t=>{
 // Windows refuses to replace a file another process has open (EPERM): before the bounded retry, most replaces of this loop
 // failed, and a lost receipt left the worker 'starting' after a startup failure or 'stopping' after a stop.
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-preview-receipt-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 const file=path.join(dir,'receipt.json');atomicJson(file,{n:0});
 const reader=spawn(process.execPath,['-e',"const fs=require('fs');const f=process.argv[1];for(;;){try{fs.readFileSync(f)}catch{}}",file],{stdio:'ignore',windowsHide:true});
 try{
  await delay(300);
  const lost=[];for(let n=1;n<=150;n++){try{atomicJson(file,{n,status:n%2?'running':'stopping'});}catch(e){lost.push(e.code);}}
  assert.deepEqual(lost,[],'replaces lost under a reader');assert.equal(JSON.parse(fs.readFileSync(file)).n,150);
 }finally{reader.kill();}
});
test('MCP tool is structured and preserves failures',async()=>{
 let registered;registerPreviewTools({registerTool(...args){registered=args;}},{preview:async()=>({ok:false,code:'EXPECTED'})});
 assert.equal(registered[0],'ssam_preview');const result=await registered[2]({action:'list'});assert.equal(result.isError,true);assert.equal(result.structuredContent.code,'EXPECTED');
 assert.equal(registered[1].inputSchema.safeParse({action:'open',url:'https://example.com'}).success,false);
});
test('ODC single-entry URL does not receive an unsupported entry query',async t=>{
 const f=fixture(t);f.p.lane='odc';f.p.implementation='odc-adapted-o11';f.save();const s=await open(f.manager,{screen:'Home'});assert.equal(s.status,'running');assert.ok(!s.url.includes('?'));
});
test('managed watcher has an exclusive owner and releases it on stop',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-watcher-'));t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
 const config={startAllowed:true,outputRoot:root,sessionId:'test',statusFile:path.join(root,'status.json'),target:{pid:123,module:'Test',moduleKey:'key',host:'local',screenKey:'screen'}};
 const createAdapters=async()=>({readSignal:async()=>{throw Error('unavailable fixture');}});
 const w=await startManagedWatcher(config,{createAdapters});
 try{await assert.rejects(()=>startManagedWatcher(config,{createAdapters}),{code:'PREVIEW_WATCHER_BUSY'});assert.equal(w.pipeline.running,true);}finally{await w.stop();}
 assert.equal(fs.existsSync(path.join(root,'watcher.lock.json')),false);assert.equal(w.pipeline.running,false);
});

test('watcher stop failure still closes the owned host and preserves a failed receipt',async t=>{
 const f=fixture(t);f.p.lane='odc';f.p.implementation='odc-adapted-o11';f.p.automaticWatching=true;
 const module=path.join(f.workspace,'watcher.mjs'),config=path.join(f.workspace,'watcher.json');
 fs.writeFileSync(module,"export async function startManagedWatcher(){return{stop:async()=>{throw Error('fixture stop failure')}}}");
 atomicJson(config,{target:{moduleKey:f.p.target.moduleKey,host:f.p.target.tenant},hostConfig:f.p.host.config});
 f.p.watcher={module:pin(module),config:pin(config)};f.save();
 const s=await open(f.manager);assert.equal(s.status,'running');
 await f.manager({action:'stop'});
 const ended=await until(f.manager,x=>['failed','stopped'].includes(x.status));
 assert.equal(ended.status,'failed');assert.equal(ended.code,'PREVIEW_STOP_FAILED');await assert.rejects(fetch(s.url));
});

test('the consolidated MCP server lists and calls ssam_preview',async()=>{
 const {createSsamServer}=await import('../ssam.mjs');
 const {InMemoryTransport}=await import('@modelcontextprotocol/server');const {Client}=await import('@modelcontextprotocol/client');
 const server=await createSsamServer({deps:{previewOptions:{preview:async args=>({ok:true,action:args.action,profiles:[]})}}});
 const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'preview-test',version:'1'});
 try{await Promise.all([server.connect(a),client.connect(b)]);assert.ok((await client.listTools()).tools.some(x=>x.name==='ssam_preview'));const reply=await client.callTool({name:'ssam_preview',arguments:{action:'list'}});assert.equal(reply.structuredContent.action,'list');}
 finally{await client.close();await server.close();}
});
