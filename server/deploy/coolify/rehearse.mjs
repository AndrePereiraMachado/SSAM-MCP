import {createChannel} from '../../../agent/agent/lib/channel.mjs';
import {createOutbox} from '../../../agent/agent/lib/outbox.mjs';
import {toolListingBytes} from '../../platforms/odc/facade/tool-listing.mjs';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync,spawn} from 'node:child_process';import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=path.resolve(process.env.SSAM_REHEARSAL_DIR??'C:/t/multiver-impl/etapa2/rehearsal');
const docker=process.env.DOCKER_EXE??'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
const prefix='ssam-multiver-'+Date.now(),containers=[];const checks=[];
const releaseKernels=JSON.parse(fs.readFileSync(new URL('./r1-kernels.json',import.meta.url),'utf8'));
const memory=[];
const images=process.env.SSAM_REHEARSAL_IMAGES?JSON.parse(process.env.SSAM_REHEARSAL_IMAGES):null;
// SSAM_REHEARSAL_IMAGES: the window, the default first, two to four pairs (R4: ODC 1.7.31 is a fourth pair, appended): [{name?, image, features, odc?, o11?,
// odcBuild?, o11Build?, odcBridge?, odcBridgeAccepted?}]. odc/o11 (three numbers) and their builds (four) default to the two
// pairs of the initial window (1.7.29/11.55.93, 1.7.28/11.55.92); odcBridge (kernel.json) defaults to v97 with v96, v48, v45
// accepted. A pair whose odcBridge is not v97 (the .NET 10 Studios: v101, v106 from the R4 release) also proves that a pack of v97
// is refused there; an agent of this release reports v98 for it (accepted on every pair).
if(images&&(images.length<2||images.length>4))throw Error('The window takes two to four images.');
const INITIAL=[{odc:'1.7.29',o11:'11.55.93',odcBuild:'1.7.29.10940',o11Build:'11.55.93.65289'},{odc:'1.7.28',o11:'11.55.92',odcBuild:'1.7.28.10850',o11Build:'11.55.92.65269'}];
const image=images?.[0].image??process.env.SSAM_REHEARSAL_IMAGE??'ssam-server:prod-20261021-ac614ad';
fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.join(out,'segredo'),{recursive:true});
const run=(args,{input,allow=false}={})=>{const r=spawnSync(docker,['--context','desktop-linux',...args],{encoding:'utf8',input,windowsHide:true,maxBuffer:8*1024*1024});if(r.status!==0&&!allow)throw Error('Docker operation failed: '+args[0]+' '+r.stderr.slice(0,500));return r.stdout.trim();};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const mount=(a,b,ro=true)=>['-v',a.replaceAll('\\','/')+':'+b+(ro?':ro':'')];
const mounts=[...(images?[]:[...mount(path.join(root,'platforms/odc/facade'),'/app/platforms/odc/facade'),...mount(path.join(root,'facade'),'/app/facade')]),...mount(path.join(out,'segredo/runtime'),'/data/server',false),...mount(path.join(out,'friction'),'/data/friction',false)];
for(const folder of ['segredo/runtime','friction'])fs.mkdirSync(path.join(out,folder),{recursive:true});
const start=(name,args)=>{const full=prefix+'-'+name;run(['run','-d','--name',full,'--network',prefix,'--network-alias',name,...args]);containers.push(full);return full;};
const memoryOf=(name,phase)=>{const rssKiB=Number(run(['exec',prefix+'-'+name,'sh','-c',"awk '/^VmRSS:/ {n+=$2} END {print n+0}' /proc/[0-9]*/status 2>/dev/null"]));assert.ok(rssKiB>0,'RSS must be measurable');const stats=JSON.parse(run(['stats','--no-stream','--format','{{json .}}',prefix+'-'+name]));memory.push({backend:name,phase,rssKiB,stats});};
let result={ok:false,checks,memory};
try{
 run(['network','create',prefix]);
 start('db',['-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-alpine']);
 for(let i=0;i<60;i++){const r=run(['exec',prefix+'-db','pg_isready','-U','postgres'],{allow:true});if(r.includes('accepting connections'))break;await wait(500);}
 const db=['-e','SSAM_DATABASE_URL=postgres://postgres@db/postgres'];
 const admin=run(['run','--rm','--network',prefix,...db,...mounts,'--entrypoint','node',image,'facade/ssam.mjs','server-token','issue','--customer','Rehearsal A','--days','1','--lanes','odc,o11']);
 const a=JSON.parse(admin);assert.ok(a.token&&a.agentCredential);fs.writeFileSync(path.join(out,'segredo','a.json'),JSON.stringify(a));
 const b=JSON.parse(run(['run','--rm','--network',prefix,...db,...mounts,'--entrypoint','node',image,'facade/ssam.mjs','server-token','issue','--customer','Rehearsal B','--days','1','--lanes','odc,o11']));fs.writeFileSync(path.join(out,'segredo','b.json'),JSON.stringify(b));
 const c=images?.length>=3?JSON.parse(run(['run','--rm','--network',prefix,...db,...mounts,'--entrypoint','node',image,'facade/ssam.mjs','server-token','issue','--customer','Rehearsal C','--days','1','--lanes','odc,o11'])):null;if(c)fs.writeFileSync(path.join(out,'segredo','c.json'),JSON.stringify(c));
 const e=images?.length===4?JSON.parse(run(['run','--rm','--network',prefix,...db,...mounts,'--entrypoint','node',image,'facade/ssam.mjs','server-token','issue','--customer','Rehearsal E','--days','1','--lanes','odc,o11'])):null;if(e)fs.writeFileSync(path.join(out,'segredo','e.json'),JSON.stringify(e));
 const every=['','one','two','three','four'][images?.length??2]+' pairs';
 const d=images&&(images[0].odcBridge??'v97')!=='v97'?JSON.parse(run(['run','--rm','--network',prefix,...db,...mounts,'--entrypoint','node',image,'facade/ssam.mjs','server-token','issue','--customer','Rehearsal D','--days','1','--lanes','odc,o11'])):null;if(d)fs.writeFileSync(path.join(out,'segredo','d.json'),JSON.stringify(d));
 const pairs=(images??INITIAL).map((x,i)=>({name:x.name??'v'+(i+1),odc:x.odc??INITIAL[i]?.odc,o11:x.o11??INITIAL[i]?.o11,odcBuild:x.odcBuild??INITIAL[i]?.odcBuild,o11Build:x.o11Build??INITIAL[i]?.o11Build,odcBridge:x.odcBridge??'v97',odcBridgeAccepted:x.odcBridgeAccepted??(x.odcBridge&&x.odcBridge!=='v97'?[]:['v96','v48','v45'])}));
 assert.ok(pairs.every(p=>p.odc&&p.o11&&p.odcBuild&&p.o11Build),'Every pair of the window names its Studio versions');
 const backends=pairs.map((p,i)=>({name:p.name,url:'http://'+p.name+':7310',odc:p.odc,o11:p.o11,...(i===0?{default:true}:{})}));
 const served={odc:pairs.map(p=>p.odc),o11:pairs.map(p=>p.o11)};
 for(const [index,backend] of backends.entries()){
  const runtime=path.join(out,'segredo/runtime/versions',backend.name);fs.mkdirSync(runtime,{recursive:true});
  const kernel=releaseKernels[backend.name];
  assert.equal(kernel.odc,backend.odc);assert.equal(kernel.o11,backend.o11);
  const kernelFile=path.join(runtime,'kernel.json');fs.writeFileSync(kernelFile,JSON.stringify(kernel));
  const args=[...db,...mounts,'-e','SSAM_SERVER_DIR=/data/server','-e','SSAM_BACKEND_NAME='+backend.name,'-e','SSAM_RUNTIME_DIR=/data/server/versions/'+backend.name,'-e','SSAM_ACCESS_NOTIFY=0','-e','SSAM_SERVED_VERSIONS='+JSON.stringify(images?served:{odc:['1.7.29','1.7.28'],o11:['11.55.93','11.55.92']})];
  if(images){
   const features=path.join(out,'features',backend.name),cache=path.join(out,'cache',backend.name);fs.mkdirSync(features,{recursive:true});fs.mkdirSync(cache,{recursive:true});
   fs.copyFileSync(images[index].features,path.join(features,'Features.plain.xml'));
   const pair=JSON.parse(run(['run','--rm','--network','none',...mount(path.join(root,'deploy/kernel-pair-check.mjs'),'/check.mjs'),...mount(kernelFile,'/kernel.json'),'--entrypoint','node',images[index].image,'/check.mjs','check','/kernel.json']));
   checks.push({name:'pair '+backend.name,ok:true,result:pair});
   start(backend.name,[...args,...mount(features,'/data/odc-features',false),...mount(cache,'/data/cache',false),images[index].image]);
   memoryOf(backend.name,'startup');
   let warm=null;
   for(let i=0;i<180;i++){
    try{warm=run(['logs',prefix+'-'+backend.name],{allow:true}).split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(x=>x.event==='warm');}catch{}
    if(warm)break;await wait(1000);
   }
   checks.push({name:'warm '+backend.name,ok:!!warm?.indexes?.ok&&!!warm?.delivery?.builder?.ok&&!!warm?.delivery?.worker?.ok,result:warm});
   assert.ok(checks.at(-1).ok,'Warm-up must pass for '+backend.name);
   await wait(2000);memoryOf(backend.name,'warm-idle');
  }else start(backend.name,[...args,'-e','SSAM_NO_WARM=1','-e','ANVIL_WORKER=0','-e','ANVIL_ODC_NO_WORKER=1','--entrypoint','node',image,'facade/ssam.mjs','serve','--host','0.0.0.0','--allow-remote','--port','7310','--log-file','/data/server/versions/'+backend.name+'/server.log']);
 }
 start('router',[...db,...mounts,'-e','SSAM_SERVER_DIR=/data/server','-e','SSAM_ROUTER_BACKENDS='+JSON.stringify(backends),'--entrypoint','node',image,'facade/router.mjs']);
 fs.writeFileSync(path.join(out,'traefik.yml'),`http:\n  routers:\n    ssam:\n      rule: PathPrefix(\u0060/\u0060)\n      service: ssam\n  services:\n    ssam:\n      loadBalancer:\n        serversTransport: ssam\n        servers:\n          - url: http://router:7300\n  serversTransports:\n    ssam:\n      forwardingTimeouts:\n        dialTimeout: 3900s\n        responseHeaderTimeout: 3900s\n        idleConnTimeout: 3900s\n`);
 start('traefik',['-p','127.0.0.1::80',...mount(path.join(out,'traefik.yml'),'/etc/traefik/dynamic.yml'),'traefik:v3.7','--entrypoints.web.address=:80','--entrypoints.web.transport.respondingtimeouts.readtimeout=3900s','--entrypoints.web.transport.respondingtimeouts.writetimeout=3900s','--providers.file.filename=/etc/traefik/dynamic.yml']);
 await wait(1500);const bindings=JSON.parse(run(['inspect','--format','{{json .NetworkSettings.Ports}}',prefix+'-traefik']));const url='http://127.0.0.1:'+bindings['80/tcp'][0].HostPort;
 let health;for(let i=0;i<90;i++){try{health=await fetch(url+'/health').then(r=>r.json());if(health.ok&&health.versions.every(v=>v.ok))break;}catch{}await wait(1000);}assert.ok(health?.ok&&health.versions.every(v=>v.ok));checks.push({name:'health',ok:true,backends:backends.length});
 const post=async(endpoint,token,body,extra={})=>{const r=await fetch(url+endpoint,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream',...extra},body:JSON.stringify(body)});return {status:r.status,text:await r.text(),sid:r.headers.get('mcp-session-id')};};
 // A hello whose ODC Studio is the one of pair odcOf and Service Studio the one of o11Of, with the pack an agent of this release
 // reports for them (the bridge built for that ODC Studio's runtime, the thin bridge built for that Service Studio).
 const packBridge=p=>p.odcBridge==='v97'?'v97':'v98';
 const hello=(odcOf,o11Of,id,pack={})=>({t:'hello',protocol:'ssam-agent/1',instance:id,agent:{version:'0.1.3',machine:{id,name:'Rehearsal',user:'Test'}},pack:{id:'rehearsal',lanes:['odc','o11'],odcBridge:packBridge(odcOf),o11BuiltFor:o11Of.o11,o11Hook:'dev',...pack},studios:{odc:{installed:{version:odcOf.odcBuild,dir:'C:/Synthetic'}},o11:{installed:{version:o11Of.o11Build,dir:'C:/Synthetic'}}}});
 const ha=await post('/agent/v1/hello',a.agentCredential,hello(pairs[0],pairs[1],'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));assert.equal(ha.status,200);assert.equal(JSON.parse(ha.text).compatible.odc.ok,true);assert.equal(JSON.parse(ha.text).compatible.o11.ok,false);assert.match(JSON.stringify(JSON.parse(ha.text).compatible.o11),/Update Service Studio to 11\.55\.94/);checks.push({name:'mixed pair gives the O11 upgrade while ODC works',ok:true});
 const hb=await post('/agent/v1/hello',b.agentCredential,hello(pairs[1],pairs[1],'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));assert.equal(hb.status,200);assert.equal(JSON.parse(hb.text).compatible.odc.ok,true);assert.equal(JSON.parse(hb.text).compatible.o11.ok,true);
 const routing=JSON.parse(fs.readFileSync(path.join(out,'segredo/runtime/state/routing.json'),'utf8'));assert.equal(routing.routes[a.id].backend,'v1');assert.equal(routing.routes[b.id].backend,'v2');
 if(c){
  const hc=await post('/agent/v1/hello',c.agentCredential,hello(pairs[2],pairs[2],'dddddddddddddddddddddddddddddddd'));assert.equal(hc.status,200);assert.equal(JSON.parse(hc.text).compatible.odc.ok,true);assert.equal(JSON.parse(hc.text).compatible.o11.ok,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'segredo/runtime/state/routing.json'),'utf8')).routes[c.id].backend,'v3');
 }
 if(e){
  const he=await post('/agent/v1/hello',e.agentCredential,hello(pairs[3],pairs[3],'9999999999999999999999999999999a'));assert.equal(he.status,200);assert.equal(JSON.parse(he.text).compatible.odc.ok,true);assert.equal(JSON.parse(he.text).compatible.o11.ok,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'segredo/runtime/state/routing.json'),'utf8')).routes[e.id].backend,'v4');
 }
 checks.push({name:'agent routing',ok:true,backends:backends.length});
 if(d){
  // The newest pair runs Studios of another runtime: a pack whose ODC bridge is v97 (net8) is refused there, never attached.
  const old=await post('/agent/v1/hello',d.agentCredential,hello(pairs[0],pairs[0],'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',{odcBridge:'v97'}));assert.equal(old.status,200);
  const odc=JSON.parse(old.text).compatible.odc;assert.equal(odc.ok,false);assert.match(JSON.stringify(odc),/AGENT_PACK_MISMATCH/);
  const current=await post('/agent/v1/hello',d.agentCredential,hello(pairs[0],pairs[0],'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',{odcBridge:'v98'}));assert.equal(current.status,200);assert.equal(JSON.parse(current.text).compatible.odc.ok,true);checks.push({name:'v98 accepted and v97 refused on '+pairs[0].odc,ok:true,odc});
  for(const p of pairs){const v102=await post('/agent/v1/hello',d.agentCredential,hello(p,p,'f'.repeat(31)+String(pairs.indexOf(p)),{odcBridge:'v102'}));assert.equal(v102.status,200);assert.equal(JSON.parse(v102.text).compatible.odc.ok,true,'v102 must be accepted on '+p.odc);}checks.push({name:'v102 accepted on the '+every,ok:true});
  // R4 (U1): the net8 v107 of the agent pack is accepted on the three pairs, as v102 is; v101 stays accepted on the net10 pair.
  // The pack bridge v107 runs only in an agent that lists reconcile-merge (agent 0.3.6 / 0.4.3-native): accepted with it, refused without.
  for(const p of pairs){const h=hello(p,p,'f'.repeat(30)+'7'+String(pairs.indexOf(p)),{odcBridge:'v107'});h.agent.odcCommands=['merge','reconcile-merge'];const v107=await post('/agent/v1/hello',d.agentCredential,h);assert.equal(v107.status,200);assert.equal(JSON.parse(v107.text).compatible.odc.ok,true,'v107 must be accepted on '+p.odc);}checks.push({name:'v107 accepted on the '+every,ok:true});
  for(const p of pairs){const old=await post('/agent/v1/hello',d.agentCredential,hello(p,p,'f'.repeat(30)+'8'+String(pairs.indexOf(p)),{odcBridge:'v107'}));assert.equal(old.status,200);assert.match(JSON.stringify(JSON.parse(old.text).compatible.odc),/AGENT_PACK_MISMATCH.*reconcile-merge/,'v107 must be refused to an agent without reconcile-merge on '+p.odc);}checks.push({name:'v107 refused to an agent without reconcile-merge on the '+every,ok:true});
  const v101=await post('/agent/v1/hello',d.agentCredential,hello(pairs[0],pairs[0],'f'.repeat(29)+'101',{odcBridge:'v101'}));assert.equal(JSON.parse(v101.text).compatible.odc.ok,true,'v101 must stay accepted on '+pairs[0].odc);checks.push({name:'v101 still accepted on '+pairs[0].odc,ok:true});
 }
 const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'rehearsal',version:'1'}}};
 const sa=await post('/mcp',a.token,init),sb=await post('/mcp',b.token,init),sc=c?await post('/mcp',c.token,init):null,se=e?await post('/mcp',e.token,init):null;assert.equal(sa.status,200);assert.equal(sb.status,200);assert.ok(sa.sid&&sb.sid);if(sc){assert.equal(sc.status,200);assert.ok(sc.sid);}if(se){assert.equal(se.status,200);assert.ok(se.sid);}checks.push({name:'admin licenses accepted by every backend',ok:true,backends:backends.length});
 const sessions=[[a.token,sa.sid],[b.token,sb.sid],...(sc?[[c.token,sc.sid]]:[]),...(se?[[e.token,se.sid]]:[])];
 for(const [token,sid]of sessions)await post('/mcp',token,{jsonrpc:'2.0',method:'notifications/initialized'},{'mcp-session-id':sid});
 if(images)for(const [index,[token,sid]]of sessions.entries()){
  const listed=await post('/mcp',token,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{'mcp-session-id':sid});assert.equal(listed.status,200);
  const data=listed.text.split('\n').find(x=>x.startsWith('data:'));const payload=JSON.parse(data?data.slice(5):listed.text);
  const tools=payload.result.tools;
  const core=new Set(['ssam_doctor','ssam_connect','ssam_discover','ssam_map','ssam_code','ssam_reference','ssam_evidence','ssam_task','o11_inspect','o11_deliver','o11_publish','o11_studio','studio_deliver','studio_inspect','studio_status']);
  const totalBytes=tools.reduce((n,t)=>n+toolListingBytes(t),0),coreBytes=tools.filter(t=>core.has(t.name)).reduce((n,t)=>n+toolListingBytes(t),0);
  assert.equal(tools.length,91);assert.ok(tools.some(t=>t.name==='o11_users'));assert.ok(!tools.some(t=>/prototype.*preview|preview.*prototype/.test(t.name)));assert.ok(totalBytes<=261330&&coreBytes<=34097,'Hosted listing must not grow');
  checks.push({name:'tools/list v'+(index+1),ok:true,count:tools.length,responseBytes:Buffer.byteLength(listed.text),totalBytes,coreBytes});
 }
 await Promise.all(Array.from({length:20},(_,i)=>post('/mcp',i%2?a.token:b.token,{jsonrpc:'2.0',id:i+2,method:'tools/call',params:{name:'ssam_doctor',arguments:{}}},{'mcp-session-id':i%2?sa.sid:sb.sid})).map(async p=>assert.equal((await p).status,200)));checks.push({name:'concurrent MCP calls',ok:true,count:20});
 for(const [name,sid]of sessions.map(([,sid],i)=>[backends[i].name,sid]))assert.ok(fs.readFileSync(path.join(out,'segredo/runtime/versions',name,'server.log'),'utf8').includes(sid));checks.push({name:'MCP backend affinity',ok:true});
 const writer=`import {createStore} from './facade/friction-store.mjs';const store=createStore({directory:'/data/friction'});for(let i=0;i<50;i++){store.begin({operation:'ssam_doctor',interface:'mcp'}).finish({ok:false,code:'BUILD_FAILED'});await new Promise(r=>setTimeout(r,5));}store.issues();`;
 await Promise.all(['v1','v2'].map(name=>new Promise((resolve,reject)=>{const p=spawn(docker,['--context','desktop-linux','exec','-i',prefix+'-'+name,'node','--input-type=module'],{stdio:['pipe','ignore','pipe'],windowsHide:true});p.stdin.end(writer);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error('Concurrent writer failed')));})));const operations=fs.readdirSync(path.join(out,'friction/operations')).filter(n=>n.endsWith('.end.json'));assert.ok(operations.length>=100);for(const n of operations)JSON.parse(fs.readFileSync(path.join(out,'friction/operations',n),'utf8'));checks.push({name:'concurrent friction writes',ok:true,operations:operations.length});
 const controller=new AbortController();const started=performance.now();const stream=await fetch(url+'/agent/v1/stream?channel='+JSON.parse(ha.text).channel,{headers:{authorization:'Bearer '+a.agentCredential},signal:controller.signal});assert.equal(stream.status,200);assert.match(stream.headers.get('content-type'),/ndjson/);const chunk=await stream.body.getReader().read();const firstByteMs=performance.now()-started;controller.abort();assert.ok(chunk.value?.length&&firstByteMs<1000);checks.push({name:'first byte through Traefik',ok:true,firstByteMs});
 assert.equal((await post('/agent/v1/hello',b.agentCredential,hello(pairs[0],pairs[0],'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))).status,200);
 const rerouted=await post('/mcp',b.token,{jsonrpc:'2.0',id:30,method:'tools/list',params:{}},{'mcp-session-id':sb.sid});assert.equal(rerouted.status,409);assert.match(rerouted.text,/SESSION_REROUTED/);assert.equal((await post('/mcp',b.token,init)).status,200);checks.push({name:'reroute and new MCP session',ok:true});
 const changing = hello(pairs[1],pairs[1],'cccccccccccccccccccccccccccccccc');
 let connections=0;
 const agent=createChannel({server:url,credential:b.agentCredential,hello:()=>changing,pongVersions:()=>({studios:changing.studios}),outbox:createOutbox(),onCall:()=>{},onState:state=>{if(state==='connected')connections++;}});
 const running=agent.run();
 try {
  for(let i=0;i<100&&!agent.connected();i++)await wait(100);
  assert.ok(agent.connected());assert.equal(agent.welcome().kernel.odc,pairs[1].odc);
  const prior=await post('/mcp',b.token,init);assert.equal(prior.status,200);
  await post('/mcp',b.token,{jsonrpc:'2.0',method:'notifications/initialized'},{'mcp-session-id':prior.sid});
  changing.studios.odc.installed.version=pairs[0].odcBuild;changing.pack.odcBridge=packBridge(pairs[0]);
  for(let i=0;i<400&&!(connections>=2&&agent.connected()&&agent.welcome().kernel.odc===pairs[0].odc);i++)await wait(100);
  assert.ok(connections>=2&&agent.connected());assert.equal(agent.welcome().kernel.odc,pairs[0].odc);
  const stale=await post('/mcp',b.token,{jsonrpc:'2.0',id:40,method:'tools/list',params:{}},{'mcp-session-id':prior.sid});assert.equal(stale.status,409);assert.match(stale.text,/SESSION_REROUTED/);
  assert.equal((await post('/mcp',b.token,init,{'mcp-session-id':prior.sid})).status,404);
  const next=await post('/mcp',b.token,init);assert.equal(next.status,200);
  await post('/mcp',b.token,{jsonrpc:'2.0',method:'notifications/initialized'},{'mcp-session-id':next.sid});
  const answer=await post('/mcp',b.token,{jsonrpc:'2.0',id:41,method:'tools/call',params:{name:'ssam_reference',arguments:{kind:'tool',query:'ssam_doctor'}}},{'mcp-session-id':next.sid});assert.equal(answer.status,200);
  assert.ok(fs.readFileSync(path.join(out,'segredo/runtime/versions/v1/server.log'),'utf8').includes(next.sid));
  assert.ok(fs.readFileSync(path.join(out,'segredo/runtime/versions/v2/server.log'),'utf8').includes('agent-studio-version-changed'));
  checks.push({name:'live pong reconnects the real agent channel and reroutes the next call once',ok:true,connections});
 }finally{await agent.stop();await running;}
 for(const name of backends.map(b=>b.name)){const folder=path.join(out,'segredo/runtime/versions',name);const files=fs.readdirSync(folder).filter(n=>n.endsWith('.jsonl'));let lines=0;for(const file of files)for(const line of fs.readFileSync(path.join(folder,file),'utf8').split('\n').filter(Boolean)){JSON.parse(line);lines++;}assert.ok(lines>0);JSON.parse(fs.readFileSync(path.join(folder,'machine-pins.json'),'utf8'));JSON.parse(fs.readFileSync(path.join(folder,'state/studio-versions.json'),'utf8'));checks.push({name:'valid concurrent state '+name,ok:true,lines});}
 for(const backend of backends)memoryOf(backend.name,'after-checks-idle');
 result.ok=true;
}catch(e){result.error=e.message;process.exitCode=1;}
finally{for(const backend of ['v1','v2','v3','v4']){try{fs.copyFileSync(path.join(out,'segredo/runtime/versions',backend,'server.log'),path.join(out,backend+'-server.log'));}catch{}}for(const name of containers){if(!name.endsWith('-db')){const logs=run(['logs',name],{allow:true});fs.writeFileSync(path.join(out,name.slice(prefix.length+1)+'.log'),logs);}run(['rm','-f','-v',name],{allow:true});}run(['network','rm',prefix],{allow:true});fs.rmSync(path.join(out,'segredo'),{recursive:true,force:true});fs.writeFileSync(path.join(out,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
