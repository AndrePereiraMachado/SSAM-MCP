import '../tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRouter, selectBackend, validateBackends, TIMEOUT_MS} from './router.mjs';
const specs=[{name:'v1',url:'http://127.0.0.1:1',odc:'1.7.29',o11:'11.55.93',default:true},{name:'v2',url:'http://127.0.0.1:2',odc:'1.7.28',o11:'11.55.92'}];
const hello=(odc,o11)=>({t:'hello',protocol:'ssam-agent/1',instance:'sample',studios:{odc:{installed:odc?{version:odc}:null},o11:{installed:o11?{version:o11}:null}}});
const store={verify:t=>({status:t==='mcp-a'||t==='mcp-b'?'ok':'unknown',id:t==='mcp-a'?'tok_a':'tok_b'}),verifyAgent:t=>({status:t==='agent-a'?'ok':'unknown',id:'tok_a'})};
async function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'router-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const seen=[];let healthy=true;let refuse=false;
 const backends=[];
 for(const spec of specs){
  const server=http.createServer((req,res)=>{
   seen.push({backend:spec.name,url:req.url});
   if(req.url==='/mcp'&&req.headers['x-hold']==='1'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': ready\n\n');return;}
   if(req.url==='/health'){res.writeHead(spec.default&&!healthy?503:200);res.end('{}');return;}
   if(req.url==='/agent/v1/hello'&&refuse){res.writeHead(400);res.end('{}');return;}
   if(req.url==='/agent/v1/stream') {res.writeHead(200,{'content-type':'application/x-ndjson'});res.write('first\n');const timer=setTimeout(()=>res.end('last\n'),1500);res.on('close',()=>clearTimeout(timer));return;}
   req.resume();req.on('end',()=>{if(req.url==='/mcp')res.setHeader('mcp-session-id',spec.name+'-session');res.end(JSON.stringify({backend:spec.name}));});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  backends.push({...spec,url:'http://127.0.0.1:'+server.address().port});
 }
 const router=await createRouter({backends,store,dir,port:0,...options});t.after(()=>router.close());
 const call=async(p,token,body,headers={})=>{const r=await fetch(router.url+p,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json(),sid:r.headers.get('mcp-session-id')};};
 return {dir,backends,router,call,seen,setHealthy:v=>healthy=v,setRefuse:v=>refuse=v};
}
test('selection prefers installed ODC, then O11, then the default',()=>{
 assert.equal(selectBackend(specs,hello('1.7.28.123','11.55.93')).name,'v2');
 assert.equal(selectBackend(specs,hello(null,'11.55.92.1')).name,'v2');
 for(const h of [hello(null,null),hello('1.7.30',null),hello('1.7.12',null)]) assert.equal(selectBackend(specs,h).name,'v1');
 assert.throws(()=>validateBackends([...specs,...specs]));
 assert.equal(TIMEOUT_MS,65*60*1000);
});
test('agent and MCP share token affinity; an update invalidates the old MCP session once',async t=>{
 const f=await fixture(t);
 assert.equal((await f.call('/agent/v1/hello','agent-a',hello('1.7.28'))).body.backend,'v2');
 const old=await f.call('/mcp','mcp-a',{});assert.equal(old.body.backend,'v2');
 assert.equal((await f.call('/mcp','mcp-b',{}, {'mcp-session-id':old.sid})).status,404);
 await f.call('/agent/v1/hello','agent-a',hello('1.7.29'));
 const rerouted=await f.call('/mcp','mcp-a',{}, {'mcp-session-id':old.sid});
 assert.equal(rerouted.body.error.data.code,'SESSION_REROUTED');assert.equal(rerouted.status,409);
 assert.equal((await f.call('/mcp','mcp-a',{}, {'mcp-session-id':old.sid})).status,404);
 assert.equal((await f.call('/mcp','mcp-a',{})).body.backend,'v1');
 assert.equal((await f.call('/mcp','invalid',{})).status,401);
});
test('routing survives restart and contains no bearer credentials; a failed hello does not change it',async t=>{
 const f=await fixture(t);await f.call('/agent/v1/hello','agent-a',hello('1.7.28'));
 f.setRefuse(true);await f.call('/agent/v1/hello','agent-a',hello('1.7.29'));
 assert.equal((await f.call('/mcp','mcp-a',{})).body.backend,'v2');
 await f.router.close();const again=await createRouter({backends:f.backends,store,dir:f.dir,port:0});t.after(()=>again.close());
 const r=await fetch(again.url+'/mcp',{headers:{authorization:'Bearer mcp-a'}});assert.equal((await r.json()).backend,'v2');
 const raw=fs.readFileSync(path.join(f.dir,'state','routing.json'),'utf8');
 assert.doesNotMatch(raw,/mcp-a|agent-a/);
});
test('first backend byte reaches the client within one second while the stream remains open',async t=>{
 const f=await fixture(t);const started=performance.now();
 const response=await fetch(f.router.url+'/agent/v1/stream',{headers:{authorization:'Bearer agent-a'}});
 const reader=response.body.getReader();const first=await reader.read();
 assert.ok(performance.now()-started<1000);assert.match(new TextDecoder().decode(first.value),/first/);await reader.cancel();
 assert.equal(f.router.server.requestTimeout,TIMEOUT_MS);
});
test('health aggregates all versions and uses the default readiness',async t=>{
 const f=await fixture(t);let r=await fetch(f.router.url+'/health');assert.equal(r.status,200);assert.equal((await r.json()).versions.length,2);
 f.setHealthy(false);r=await fetch(f.router.url+'/health');assert.equal(r.status,503);
});
test('absolute request targets cannot forward credentials to a different destination',async t=>{
 const f=await fixture(t);
 for(const target of [f.backends[1].url+'/mcp','//'+new URL(f.backends[1].url).host+'/mcp', '/'+String.fromCharCode(92)+new URL(f.backends[1].url).host+'/mcp']){
  const status=await new Promise((resolve,reject)=>{const r=http.request(f.router.url,{path:target,headers:{authorization:'Bearer mcp-a'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});
  assert.equal(status,400);
 }
});

test('container healthcheck works with a configured public host',async t=>{
 const f=await fixture(t,{publicHosts:['mcp.example.invalid']});
 assert.equal((await fetch(f.router.url+'/health')).status,200);
 const wrong=await new Promise((resolve,reject)=>{const req=http.get(f.router.url+'/health',{headers:{host:'wrong.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(wrong,400);
 assert.equal((await fetch(f.router.url+'/mcp',{headers:{authorization:'Bearer mcp-a'}})).status,400);
});

test('an active MCP session is notified only once when multiple streams are open',async t=>{
 const f=await fixture(t);await f.call('/agent/v1/hello','agent-a',hello('1.7.28'));const old=await f.call('/mcp','mcp-a',{});
 const responses=await Promise.all([1,2].map(()=>fetch(f.router.url+'/mcp',{headers:{authorization:'Bearer mcp-a','mcp-session-id':old.sid,'x-hold':'1'}})));
 const reads=responses.map(async r=>{let text='';const reader=r.body.getReader();try{while(true){const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value);}}catch{}return text;});
 await f.call('/agent/v1/hello','agent-a',hello('1.7.29'));
 assert.equal((await Promise.all(reads)).join('').split('SESSION_REROUTED').length-1,1);
});
