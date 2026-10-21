import {createChannel} from '../../../agent/agent/lib/channel.mjs';
import {createOutbox} from '../../../agent/agent/lib/outbox.mjs';
import {toolListingBytes} from '../../platforms/odc/facade/tool-listing.mjs';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync,spawn} from 'node:child_process';import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=path.resolve(process.env.SSAM_REHEARSAL_DIR??'C:/t/multiver-impl/etapa2/rehearsal');
const docker=process.env.DOCKER_EXE??'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
const prefix='ssam-multiver-'+Date.now(),containers=[];const checks=[];
const images=process.env.SSAM_REHEARSAL_IMAGES?JSON.parse(process.env.SSAM_REHEARSAL_IMAGES):null;
if(images&&images.length!==2)throw Error('The initial window requires two images.');
const image=images?.[0].image??process.env.SSAM_REHEARSAL_IMAGE??'ssam-server:prod-20261021-ac614ad';
fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.join(out,'segredo'),{recursive:true});
const run=(args,{input,allow=false}={})=>{const r=spawnSync(docker,['--context','desktop-linux',...args],{encoding:'utf8',input,windowsHide:true,maxBuffer:8*1024*1024});if(r.status!==0&&!allow)throw Error('Docker operation failed: '+args[0]+' '+r.stderr.slice(0,500));return r.stdout.trim();};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const mount=(a,b,ro=true)=>['-v',a.replaceAll('\\','/')+':'+b+(ro?':ro':'')];
const mounts=[...(images?[]:[...mount(path.join(root,'platforms/odc/facade'),'/app/platforms/odc/facade'),...mount(path.join(root,'facade'),'/app/facade')]),...mount(path.join(out,'segredo/runtime'),'/data/server',false),...mount(path.join(out,'friction'),'/data/friction',false)];
for(const folder of ['segredo/runtime','friction'])fs.mkdirSync(path.join(out,folder),{recursive:true});
const start=(name,args)=>{const full=prefix+'-'+name;run(['run','-d','--name',full,'--network',prefix,'--network-alias',name,...args]);containers.push(full);return full;};
let result={ok:false,checks};
try{
 run(['network','create',prefix]);
 start('db',['-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-alpine']);
 for(let i=0;i<60;i++){const r=run(['exec',prefix+'-db','pg_isready','-U','postgres'],{allow:true});if(r.includes('accepting connections'))break;await wait(500);}
 const db=['-e','SSAM_DATABASE_URL=postgres://postgres@db/postgres'];
 const admin=run(['run','--rm','--network',prefix,...db,...mounts,'--entrypoint','node',image,'facade/ssam.mjs','server-token','issue','--customer','Rehearsal A','--days','1','--lanes','odc,o11']);
 const a=JSON.parse(admin);assert.ok(a.token&&a.agentCredential);fs.writeFileSync(path.join(out,'segredo','a.json'),JSON.stringify(a));
 const b=JSON.parse(run(['run','--rm','--network',prefix,...db,...mounts,'--entrypoint','node',image,'facade/ssam.mjs','server-token','issue','--customer','Rehearsal B','--days','1','--lanes','odc,o11']));fs.writeFileSync(path.join(out,'segredo','b.json'),JSON.stringify(b));
 const backends=[{name:'v1',url:'http://v1:7310',odc:'1.7.29',o11:'11.55.93',default:true},{name:'v2',url:'http://v2:7310',odc:'1.7.28',o11:'11.55.92'}];
 for(const [index,backend] of backends.entries()){
  const runtime=path.join(out,'segredo/runtime/versions',backend.name);fs.mkdirSync(runtime,{recursive:true});
  const kernel={o11:images?backend.o11:'11.55.92',odc:images?backend.odc:'1.7.28',odcBridge:'v97',odcBridgeAccepted:['v96','v48','v45']};
  const kernelFile=path.join(runtime,'kernel.json');fs.writeFileSync(kernelFile,JSON.stringify(kernel));
  const args=[...db,...mounts,'-e','SSAM_SERVER_DIR=/data/server','-e','SSAM_BACKEND_NAME='+backend.name,'-e','SSAM_RUNTIME_DIR=/data/server/versions/'+backend.name,'-e','SSAM_ACCESS_NOTIFY=0','-e','SSAM_SERVED_VERSIONS='+JSON.stringify({odc:['1.7.29','1.7.28'],o11:['11.55.93','11.55.92']})];
  if(images){
   const features=path.join(out,'features',backend.name),cache=path.join(out,'cache',backend.name);fs.mkdirSync(features,{recursive:true});fs.mkdirSync(cache,{recursive:true});
   fs.copyFileSync(images[index].features,path.join(features,'Features.plain.xml'));
   const pair=JSON.parse(run(['run','--rm','--network','none',...mount(path.join(root,'deploy/kernel-pair-check.mjs'),'/check.mjs'),...mount(kernelFile,'/kernel.json'),'--entrypoint','node',images[index].image,'/check.mjs','check','/kernel.json']));
   checks.push({name:'pair '+backend.name,ok:true,result:pair});
   start(backend.name,[...args,...mount(features,'/data/odc-features',false),...mount(cache,'/data/cache',false),images[index].image]);
   let warm=null;
   for(let i=0;i<180;i++){
    try{warm=run(['logs',prefix+'-'+backend.name],{allow:true}).split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(x=>x.event==='warm');}catch{}
    if(warm)break;await wait(1000);
   }
   checks.push({name:'warm '+backend.name,ok:!!warm?.indexes?.ok&&!!warm?.delivery?.builder?.ok&&!!warm?.delivery?.worker?.ok,result:warm});
   assert.ok(checks.at(-1).ok,'Warm-up must pass for '+backend.name);
  }else start(backend.name,[...args,'-e','SSAM_NO_WARM=1','-e','ANVIL_WORKER=0','-e','ANVIL_ODC_NO_WORKER=1','--entrypoint','node',image,'facade/ssam.mjs','serve','--host','0.0.0.0','--allow-remote','--port','7310','--log-file','/data/server/versions/'+backend.name+'/server.log']);
 }
 start('router',[...db,...mounts,'-e','SSAM_SERVER_DIR=/data/server','-e','SSAM_ROUTER_BACKENDS='+JSON.stringify(backends),'--entrypoint','node',image,'facade/router.mjs']);
 fs.writeFileSync(path.join(out,'traefik.yml'),`http:\n  routers:\n    ssam:\n      rule: PathPrefix(\u0060/\u0060)\n      service: ssam\n  services:\n    ssam:\n      loadBalancer:\n        serversTransport: ssam\n        servers:\n          - url: http://router:7300\n  serversTransports:\n    ssam:\n      forwardingTimeouts:\n        dialTimeout: 3900s\n        responseHeaderTimeout: 3900s\n        idleConnTimeout: 3900s\n`);
 start('traefik',['-p','127.0.0.1::80',...mount(path.join(out,'traefik.yml'),'/etc/traefik/dynamic.yml'),'traefik:v3.7','--entrypoints.web.address=:80','--entrypoints.web.transport.respondingtimeouts.readtimeout=3900s','--entrypoints.web.transport.respondingtimeouts.writetimeout=3900s','--providers.file.filename=/etc/traefik/dynamic.yml']);
 await wait(1500);const bindings=JSON.parse(run(['inspect','--format','{{json .NetworkSettings.Ports}}',prefix+'-traefik']));const url='http://127.0.0.1:'+bindings['80/tcp'][0].HostPort;
 let health;for(let i=0;i<90;i++){try{health=await fetch(url+'/health').then(r=>r.json());if(health.ok&&health.versions.every(v=>v.ok))break;}catch{}await wait(1000);}assert.ok(health?.ok&&health.versions.every(v=>v.ok));checks.push({name:'health',ok:true,backends:2});
 const post=async(endpoint,token,body,extra={})=>{const r=await fetch(url+endpoint,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream',...extra},body:JSON.stringify(body)});return {status:r.status,text:await r.text(),sid:r.headers.get('mcp-session-id')};};
 const hello=(version,id)=>({t:'hello',protocol:'ssam-agent/1',instance:id,agent:{version:'0.3.1',machine:{id,name:'Rehearsal',user:'Test'}},pack:{id:'rehearsal',lanes:['odc','o11'],odcBridge:'v97',o11BuiltFor:'11.55.92',o11Hook:'dev'},studios:{odc:{installed:{version,dir:'C:/Synthetic'}},o11:{installed:{version:'11.55.92.65269',dir:'C:/Synthetic'}}}});
 const ha=await post('/agent/v1/hello',a.agentCredential,hello('1.7.29.10940','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));assert.equal(ha.status,200);assert.equal(JSON.parse(ha.text).compatible.odc.ok,true);assert.equal(JSON.parse(ha.text).compatible.o11.ok,false);checks.push({name:'mixed pair refuses nonlocal O11',ok:true});
 const hb=await post('/agent/v1/hello',b.agentCredential,hello('1.7.28.10850','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));assert.equal(hb.status,200);assert.equal(JSON.parse(hb.text).compatible.odc.ok,true);assert.equal(JSON.parse(hb.text).compatible.o11.ok,true);
 const routing=JSON.parse(fs.readFileSync(path.join(out,'segredo/runtime/state/routing.json'),'utf8'));assert.equal(routing.routes[a.id].backend,'v1');assert.equal(routing.routes[b.id].backend,'v2');checks.push({name:'agent routing',ok:true});
 const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'rehearsal',version:'1'}}};
 const sa=await post('/mcp',a.token,init),sb=await post('/mcp',b.token,init);assert.equal(sa.status,200);assert.equal(sb.status,200);assert.ok(sa.sid&&sb.sid);checks.push({name:'admin licenses accepted by both backends',ok:true});
 for(const [token,sid]of [[a.token,sa.sid],[b.token,sb.sid]])await post('/mcp',token,{jsonrpc:'2.0',method:'notifications/initialized'},{'mcp-session-id':sid});
 if(images)for(const [index,token,sid]of [[0,a.token,sa.sid],[1,b.token,sb.sid]]){
  const listed=await post('/mcp',token,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{'mcp-session-id':sid});assert.equal(listed.status,200);
  const data=listed.text.split('\n').find(x=>x.startsWith('data:'));const payload=JSON.parse(data?data.slice(5):listed.text);
  const tools=payload.result.tools;
  const core=new Set(['ssam_doctor','ssam_connect','ssam_discover','ssam_map','ssam_code','ssam_reference','ssam_evidence','ssam_task','o11_inspect','o11_deliver','o11_publish','o11_studio','studio_deliver','studio_inspect','studio_status']);
  const totalBytes=tools.reduce((n,t)=>n+toolListingBytes(t),0),coreBytes=tools.filter(t=>core.has(t.name)).reduce((n,t)=>n+toolListingBytes(t),0);
  assert.equal(tools.length,92);assert.ok(totalBytes<=261330&&coreBytes<=34097,'Hosted listing must not grow');
  checks.push({name:'tools/list v'+(index+1),ok:true,count:tools.length,responseBytes:Buffer.byteLength(listed.text),totalBytes,coreBytes});
 }
 await Promise.all(Array.from({length:20},(_,i)=>post('/mcp',i%2?a.token:b.token,{jsonrpc:'2.0',id:i+2,method:'tools/call',params:{name:'ssam_doctor',arguments:{}}},{'mcp-session-id':i%2?sa.sid:sb.sid})).map(async p=>assert.equal((await p).status,200)));checks.push({name:'concurrent MCP calls',ok:true,count:20});
 for(const [name,sid]of [['v1',sa.sid],['v2',sb.sid]])assert.ok(fs.readFileSync(path.join(out,'segredo/runtime/versions',name,'server.log'),'utf8').includes(sid));checks.push({name:'MCP backend affinity',ok:true});
 const writer=`import {createStore} from './facade/friction-store.mjs';const store=createStore({directory:'/data/friction'});for(let i=0;i<50;i++){store.begin({operation:'ssam_doctor',interface:'mcp'}).finish({ok:false,code:'BUILD_FAILED'});await new Promise(r=>setTimeout(r,5));}store.issues();`;
 await Promise.all(['v1','v2'].map(name=>new Promise((resolve,reject)=>{const p=spawn(docker,['--context','desktop-linux','exec','-i',prefix+'-'+name,'node','--input-type=module'],{stdio:['pipe','ignore','pipe'],windowsHide:true});p.stdin.end(writer);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error('Concurrent writer failed')));})));const operations=fs.readdirSync(path.join(out,'friction/operations')).filter(n=>n.endsWith('.end.json'));assert.ok(operations.length>=100);for(const n of operations)JSON.parse(fs.readFileSync(path.join(out,'friction/operations',n),'utf8'));checks.push({name:'concurrent friction writes',ok:true,operations:operations.length});
 const controller=new AbortController();const started=performance.now();const stream=await fetch(url+'/agent/v1/stream?channel='+JSON.parse(ha.text).channel,{headers:{authorization:'Bearer '+a.agentCredential},signal:controller.signal});assert.equal(stream.status,200);assert.match(stream.headers.get('content-type'),/ndjson/);const chunk=await stream.body.getReader().read();const firstByteMs=performance.now()-started;controller.abort();assert.ok(chunk.value?.length&&firstByteMs<1000);checks.push({name:'first byte through Traefik',ok:true,firstByteMs});
 assert.equal((await post('/agent/v1/hello',b.agentCredential,hello('1.7.29.10940','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))).status,200);
 const rerouted=await post('/mcp',b.token,{jsonrpc:'2.0',id:30,method:'tools/list',params:{}},{'mcp-session-id':sb.sid});assert.equal(rerouted.status,409);assert.match(rerouted.text,/SESSION_REROUTED/);assert.equal((await post('/mcp',b.token,init)).status,200);checks.push({name:'reroute and new MCP session',ok:true});
 const changing = hello('1.7.28.10850','cccccccccccccccccccccccccccccccc');
 let connections=0;
 const agent=createChannel({server:url,credential:b.agentCredential,hello:()=>changing,pongVersions:()=>({studios:changing.studios}),outbox:createOutbox(),onCall:()=>{},onState:state=>{if(state==='connected')connections++;}});
 const running=agent.run();
 try {
  for(let i=0;i<100&&!agent.connected();i++)await wait(100);
  assert.ok(agent.connected());assert.equal(agent.welcome().kernel.odc,'1.7.28');
  const prior=await post('/mcp',b.token,init);assert.equal(prior.status,200);
  await post('/mcp',b.token,{jsonrpc:'2.0',method:'notifications/initialized'},{'mcp-session-id':prior.sid});
  changing.studios.odc.installed.version='1.7.29.10940';
  for(let i=0;i<400&&!(connections>=2&&agent.connected()&&agent.welcome().kernel.odc==='1.7.29');i++)await wait(100);
  assert.ok(connections>=2&&agent.connected());assert.equal(agent.welcome().kernel.odc,'1.7.29');
  const stale=await post('/mcp',b.token,{jsonrpc:'2.0',id:40,method:'tools/list',params:{}},{'mcp-session-id':prior.sid});assert.equal(stale.status,409);assert.match(stale.text,/SESSION_REROUTED/);
  assert.equal((await post('/mcp',b.token,init,{'mcp-session-id':prior.sid})).status,404);
  const next=await post('/mcp',b.token,init);assert.equal(next.status,200);
  await post('/mcp',b.token,{jsonrpc:'2.0',method:'notifications/initialized'},{'mcp-session-id':next.sid});
  const answer=await post('/mcp',b.token,{jsonrpc:'2.0',id:41,method:'tools/call',params:{name:'ssam_reference',arguments:{kind:'tool',query:'ssam_doctor'}}},{'mcp-session-id':next.sid});assert.equal(answer.status,200);
  assert.ok(fs.readFileSync(path.join(out,'segredo/runtime/versions/v1/server.log'),'utf8').includes(next.sid));
  assert.ok(fs.readFileSync(path.join(out,'segredo/runtime/versions/v2/server.log'),'utf8').includes('agent-studio-version-changed'));
  checks.push({name:'live pong reconnects the real agent channel and reroutes the next call once',ok:true,connections});
 }finally{await agent.stop();await running;}
 for(const name of ['v1','v2']){const folder=path.join(out,'segredo/runtime/versions',name);const files=fs.readdirSync(folder).filter(n=>n.endsWith('.jsonl'));let lines=0;for(const file of files)for(const line of fs.readFileSync(path.join(folder,file),'utf8').split('\n').filter(Boolean)){JSON.parse(line);lines++;}assert.ok(lines>0);JSON.parse(fs.readFileSync(path.join(folder,'machine-pins.json'),'utf8'));JSON.parse(fs.readFileSync(path.join(folder,'state/studio-versions.json'),'utf8'));checks.push({name:'valid concurrent state '+name,ok:true,lines});}
 result.ok=true;
}catch(e){result.error=e.message;process.exitCode=1;}
finally{for(const backend of ['v1','v2']){try{fs.copyFileSync(path.join(out,'segredo/runtime/versions',backend,'server.log'),path.join(out,backend+'-server.log'));}catch{}}for(const name of containers){if(!name.endsWith('-db')){const logs=run(['logs',name],{allow:true});fs.writeFileSync(path.join(out,name.slice(prefix.length+1)+'.log'),logs);}run(['rm','-f','-v',name],{allow:true});}run(['network','rm',prefix],{allow:true});fs.rmSync(path.join(out,'segredo'),{recursive:true,force:true});fs.writeFileSync(path.join(out,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
