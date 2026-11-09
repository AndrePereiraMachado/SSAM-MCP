import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {createAutoRuntime,releasesToVerify,spkiSha256} from './auto-runtime.mjs';
import {createRuntime} from './runtime.mjs';
import {NEVER_IN_REHEARSAL,fenceRuntime,forcedPair,rehearsalConfig,rehearseCurrent} from './rehearse.mjs';
import {rehearsalRefuses} from './safety.mjs';
import {parseArgs} from './vigia.mjs';
import {smokeImage} from './smoke.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const tmp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'rehearse-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const digest='a'.repeat(64),id='o11-11.55.94-odc-1.7.30';
const manifest={window:3,odc:['1.7.30','1.7.29','1.7.28'].map((version,i)=>({version,image:'private/image',tag:'prod-'+i,sha256:digest})),o11:['11.55.94','11.55.93','11.55.92'].map((version,i)=>({version,image:'private/image',tag:'prod-'+i,sha256:digest}))};
const release=(lane,v,full)=>({lane,version:v,fullVersion:full,studio:lane,tfm:'net10.0',url:'https://official.example/'+lane,provenance:{root:lane}});
const observed=[release('odc','1.7.30','1.7.30.10980'),release('o11','11.55.94','11.55.94.65328')];
// Every operation that changes something outside this machine, as a spy. The real Coolify and SSH doors stay in, over a fake server and a fake ssh.
async function fixture(t,{config:extra={},vault={}}={}){
 const dir=tmp(t),out=path.join(dir,'out'),http_=[],ssh=[],spied=[],ran=[];fs.mkdirSync(out);
 const server=http.createServer((req,res)=>{http_.push(req.method+' '+req.url);res.setHeader('content-type','application/json');res.end(JSON.stringify({docker_compose_raw:'services: {}'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const key=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'});
 const real={automatic:true,bridgeMode:'signed-offers',workspace:path.resolve(here,'../../..'),tempRoot:dir,outDir:out,pauseFile:path.join(dir,'PAUSE'),automaticDeployment:{testOnly:true,coolify:{url:`http://127.0.0.1:${server.address().port}`,resource:'fixture'},ssh:{host:'fixture',knownHosts:path.join(dir,'known')},remote:{directory:'/x'}},bridgeTrustKeySpkiSha256:spkiSha256(key),...extra};
 const config=rehearsalConfig(real,new Date('2026-10-31T12:00:00Z'));fs.mkdirSync(config.outDir,{recursive:true});
 const base={log:()=>{},notes:[],executionSource:async()=>{},
  async notify(title){this.notes.push(title);},
  async run(cmd,args,{input}={}){
   ran.push(path.basename(String(cmd)));
   if(args.some(x=>String(x).endsWith('read-secrets.ps1')))return {stdout:JSON.stringify({coolifyToken:'memory-only',sshPrivateKey:Buffer.from('PRIVATE KEY').toString('base64'),authenticodeThumbprint:'b'.repeat(40),manifestPrivateKey:key,journalKey:Buffer.alloc(32,1).toString('base64'),webhookUrl:real.automaticDeployment.coolify.url+'/webhook',...vault})};
   if(String(cmd).endsWith('icacls.exe'))return {stdout:''};
   ssh.push(JSON.parse(input).action);return {stdout:'{"ok":true,"availableMiB":9000}'};
  }};
 const runtime=Object.assign(base,createAutoRuntime(config,base));
 for(const name of NEVER_IN_REHEARSAL)runtime[name]=async()=>{spied.push(name);return {};};
 const order=[];
 Object.assign(runtime,{verifyRelease:async()=>order.push('verifyRelease'),verifyLocalImage:async()=>order.push('verifyLocalImage'),observe:async()=>{order.push('observe');return observed;},detect:async()=>{order.push('detect');return [];},head:async()=>'abc1234',
  preflight:async()=>{},targetFramework:async()=>'net10.0',dockerReady:async()=>{},
  bundle:async c=>{order.push('bundle '+c.lane);return {...c,file:'bundle',sha256:digest,features:'private'};},companion:async(lane,version)=>({lane,version,tfm:'net10.0'}),
  test:async(lane,kind)=>{order.push(`test ${lane} ${kind}`);return {passed:1,total:1,failures:[]};},
  async buildBridges(){
   order.push('buildBridges');const stage=path.join(config.rehearsal.dir,'bridges','u');const pair=generateKeyPairSync('ed25519'),offers=[];
   fs.mkdirSync(stage,{recursive:true});fs.writeFileSync(path.join(stage,'public-key.pem'),pair.publicKey.export({type:'spki',format:'pem'}));
   for(const [lane,v,p] of [['odc','1.7.30','v101'],['o11','11.55.94','d1']]){
    const target=path.join(stage,lane,v,p);fs.mkdirSync(path.join(target,'bridge'),{recursive:true});fs.writeFileSync(path.join(target,'bridge','a.json'),'x');
    const bytes=Buffer.from(JSON.stringify({schema:1,lane,studioVersion:v,runtime:'net10.0',protocol:p,sequence:1,createdAt:'x',authenticodeThumbprint:'b'.repeat(40),files:[{path:'bridge/a.json',sha256:createHash('sha256').update('x').digest('hex'),size:1}]}));
    fs.writeFileSync(path.join(target,'manifest.json'),bytes);fs.writeFileSync(path.join(target,'manifest.sig'),sign(null,bytes,pair.privateKey));
    offers.push({lane,studioVersion:v,protocol:p,sequence:1});
   }
   return {stage,offers,kernel:{odc:'1.7.30',o11:'11.55.94',odcBridge:'v101',odcBridgeAccepted:['v101','v98','v102'],o11BridgeAccepted:['d1']}};
  },
  build:async()=>{order.push('build');return {odc:'1.7.30',o11:'11.55.94',image:'private/image',tag:'rehearsal-test',sha256:digest};},
  smoke:async()=>{order.push('smoke');return {ok:true,tools:91,totalBytes:259684,coreBytes:33952,offersChecked:2};}});
 return {dir,out,config,runtime,http:http_,ssh,spied,order,ran};
}
test('the rehearsal runs the real round to the offer, and nothing that changes production is called',async t=>{
 const f=await fixture(t);
 const result=await rehearseCurrent(f.config,f.runtime,{manifest});
 assert.equal(result.status,'rehearsed',JSON.stringify(result));assert.equal(result.id,id);
 for(const step of ['detect','observe','bundle odc','bundle o11','test odc baseline','test odc candidate','buildBridges','build','smoke','verifyRelease','verifyLocalImage'])assert.ok(f.order.includes(step),step);
 assert.ok(f.order.indexOf('buildBridges')<f.order.indexOf('build')&&f.order.indexOf('build')<f.order.indexOf('smoke')&&f.order.indexOf('smoke')<f.order.indexOf('verifyRelease'));
 assert.deepEqual(result.offers.map(o=>[o.lane,o.protocol]),[['odc','v101'],['o11','d1']]);
 assert.deepEqual(f.spied,[],'an operation that changes something was called');
 assert.deepEqual([...new Set(f.ssh)],['capacity'],'SSH did more than read capacity');
 assert.ok(f.http.length>0&&f.http.every(line=>line.startsWith('GET ')),f.http.join());
 assert.ok(f.runtime.notes.every(n=>n.startsWith('SSAM rehearsal:')),f.runtime.notes.join());
 assert.ok(fs.existsSync(path.join(f.config.rehearsal.dir,'store','odc','1.7.30','v101','manifest.json')));
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.config.rehearsal.dir,'rehearsal.json'),'utf8')).status,'rehearsed');
 // A real round never sees it: its attempts live in the real outDir, and the rehearsal folder is not a pair.
 assert.deepEqual(fs.readdirSync(f.out),['rehearsals']);
});
test('a rehearsal whose image does not offer the bridges fails, and still changes nothing',async t=>{
 const f=await fixture(t);f.runtime.smoke=async()=>({ok:true,tools:91,totalBytes:1,coreBytes:1,offersChecked:0});
 const result=await rehearseCurrent(f.config,f.runtime,{manifest});
 assert.equal(result.status,'failed');assert.match(result.error,/did not offer/);assert.deepEqual(f.spied,[]);
});
// Server-only (the default bridge mode) on a five-pair window: the vault has no Authenticode thumbprint, no bridge is built or
// signed, and the built image is asked the hello of the published agent pack (config.example.json, release source of this checkout).
const agentFiles=()=>{const at=rel=>fs.readFileSync(path.resolve(here,'../../../agent',rel),'utf8');return {program:at('platforms/odc/studio/bridge/client/Program.cs'),kinds:at('agent/lib/kinds.mjs'),native:at('native/Ssam.Agent/StudioKinds.cs'),bridgeProject:at('platforms/odc/studio/bridge/Bridge.csproj')};};
const example=JSON.parse(fs.readFileSync(path.join(here,'config.example.json'),'utf8'));
const five={window:5,...Object.fromEntries(['odc','o11'].map(lane=>[lane,[['1.7.32','11.55.95'],['1.7.31','11.55.94'],['1.7.30','11.55.94'],['1.7.29','11.55.93'],['1.7.28','11.55.92']].map(([odc,o11],i)=>({version:lane==='odc'?odc:o11,image:'private/image',tag:'prod-five-'+i,sha256:digest}))]))};
// A published pack with a thin bridge built for Service Studio 11.55.95 (the example pack has .94/.93/.92 only).
const with95={...example.agentPack,o11Builds:[{version:'11.55.95',runtime:'net10.0'},...example.agentPack.o11Builds]};
const odcMatches=f=>{f.runtime.odcBinary=async a=>{f.order.push('odc references '+a.candidate.version);return {reference:'1.7.31',gaps:[],compared:[]};};};
test('server-only rehearsal of a five-pair window builds and signs no bridge and smokes the published pack hello',async t=>{
 const f=await fixture(t,{config:{bridgeMode:undefined,agentPack:with95,agentPackByRuntime:example.agentPackByRuntime,agentReleaseCommit:'c'.repeat(40)},vault:{authenticodeThumbprint:undefined}});
 f.runtime.agentReleaseFiles=async()=>agentFiles();odcMatches(f);
 f.runtime.observe=async()=>{f.order.push('observe');return [release('odc','1.7.32','1.7.32.11000'),release('o11','11.55.95','11.55.95.1')];};
 f.runtime.buildBridges=async()=>{f.order.push('buildBridges');throw Error('no bridge is built in server-only');};
 let presented=null,kernel=null;
 f.runtime.smoke=async()=>{f.order.push('smoke');presented=f.runtime.packHello;kernel=f.runtime.bridgeKernel;return {ok:true,tools:91,totalBytes:259684,coreBytes:33952,publishedPack:true};};
 const result=await rehearseCurrent(f.config,f.runtime,{manifest:five});
 assert.equal(result.status,'rehearsed',JSON.stringify(result));assert.equal(result.id,'o11-11.55.95-odc-1.7.32');assert.equal(result.bridgeMode,'server-only');
 assert.ok(!f.order.includes('buildBridges'));assert.deepEqual(result.offers,[]);
 assert.ok(!f.ran.some(cmd=>/dotnet|signtool/i.test(cmd)),f.ran.join());
 assert.equal(kernel.odc,'1.7.32');assert.equal(kernel.odcBridge,'v108');assert.ok(kernel.odcBridgeAccepted.includes('v107'),'the nearest served ODC pair accepts it');
 assert.equal(presented.pack.odcBridge,'v108');assert.equal(presented.pack.o11BuiltFor,'11.55.95');assert.ok(presented.agent.odcCommands.includes('reconcile-merge'));
 assert.deepEqual(result.hello,{odcBridge:'v108',o11BuiltFor:'11.55.95'});
 assert.ok(f.order.indexOf('odc references 1.7.32')>f.order.indexOf('bundle o11')&&f.order.indexOf('odc references 1.7.32')<f.order.indexOf('test odc baseline'),f.order.join());
 assert.equal(fs.existsSync(path.join(f.config.rehearsal.dir,'store')),false);
 assert.deepEqual(f.spied,[]);assert.deepEqual([...new Set(f.ssh)],['capacity']);
});
test('A1: the five-pair rehearsal with the example pack (no 11.55.95 build) waits for a client bridge update, before any bundle',async t=>{
 const f=await fixture(t,{config:{bridgeMode:undefined,agentPack:example.agentPack,agentPackByRuntime:example.agentPackByRuntime,agentReleaseCommit:'c'.repeat(40)},vault:{authenticodeThumbprint:undefined}});
 f.runtime.agentReleaseFiles=async()=>agentFiles();odcMatches(f);
 f.runtime.observe=async()=>{f.order.push('observe');return [release('odc','1.7.32','1.7.32.11000'),release('o11','11.55.95','11.55.95.1')];};
 const result=await rehearseCurrent(f.config,f.runtime,{manifest:five});
 assert.equal(result.status,'deferred');assert.match(result.error,/client bridge update required: o11 11\.55\.95 runtime net10\.0 \(the published pack has no thin bridge built for Service Studio 11\.55\.95 \(o11Builds: 11\.55\.94, 11\.55\.93, 11\.55\.92\)/);
 assert.ok(!f.order.some(s=>/^bundle|^test|^build|^smoke/.test(s)),f.order.join());assert.deepEqual(f.spied,[]);
});
test('B2: server-only rehearsal whose image refuses the published pack hello the gate accepted fails (a defect), never waits',async t=>{
 const f=await fixture(t,{config:{bridgeMode:undefined,agentPack:example.agentPack,agentPackByRuntime:example.agentPackByRuntime,agentReleaseCommit:'c'.repeat(40)},vault:{authenticodeThumbprint:undefined}});
 f.runtime.agentReleaseFiles=async()=>agentFiles();odcMatches(f);
 f.runtime.smoke=async()=>({ok:false,error:'SMOKE_CHECK:The published agent pack was not accepted for both lanes.',refused:[{lane:'odc',code:'AGENT_PACK_MISMATCH'}]});
 const result=await rehearseCurrent(f.config,f.runtime,{manifest});
 assert.equal(result.status,'failed');assert.match(result.error,/refuses the published agent pack's hello that the server-only gate accepted \(odc AGENT_PACK_MISMATCH\)/);assert.deepEqual(f.spied,[]);
 assert.ok(!f.runtime.notes.includes('SSAM rehearsal: client bridge update required'),f.runtime.notes.join());
});
test('PAUSE refuses the rehearsal before anything is detected or built',async t=>{
 const f=await fixture(t);fs.writeFileSync(f.config.pauseFile,'');
 await assert.rejects(rehearseCurrent(f.config,f.runtime,{manifest}),e=>e.code==='PAUSED');
 assert.deepEqual(f.order,[]);assert.deepEqual(f.ssh,[]);assert.deepEqual(f.http,[]);
});
test('a PAUSE that appears during the round stops it before the end, with nothing changed',async t=>{
 const f=await fixture(t),smoke=f.runtime.smoke;f.runtime.smoke=async()=>{fs.writeFileSync(f.config.pauseFile,'');return smoke();};
 const result=await rehearseCurrent(f.config,f.runtime,{manifest});
 assert.notEqual(result.status,'rehearsed');assert.deepEqual(f.spied,[]);
});
test('the fence replaces every changing operation: each one refuses and its original is not reached',async t=>{
 const f=await fixture(t);fenceRuntime(f.runtime);
 for(const name of NEVER_IN_REHEARSAL)assert.throws(()=>f.runtime[name](),e=>e.code==='REHEARSAL_REFUSED',name);
 assert.deepEqual(f.spied,[]);
 await f.runtime.event('live',{id:'x',message:'x'},{});assert.deepEqual(f.ssh,[]);
});
test('the Coolify and SSH doors refuse by themselves in a rehearsal, whoever calls them',async t=>{
 const f=await fixture(t),door=createAutoRuntime(f.config,{log:()=>{},executionSource:async()=>{},run:f.runtime.run.bind(f.runtime),archiveDeploy:async(_,file)=>fs.writeFileSync(file,'x'),fullHead:async()=>'h'}),s=await door.secrets();
 const refused=e=>e.code==='REHEARSAL_REFUSED';
 await assert.rejects(door.writeCompose(s,'x'),refused);
 await assert.rejects(door.deploy(s),refused);
 await assert.rejects(door.backup(s,'x'),refused);
 await assert.rejects(door.prepare(s,{id:'x',features:path.join(here,'config.example.json'),dir:f.dir,compose:'{}'}),refused);
 await assert.rejects(door.preflightRemote(s,manifest),refused);
 await assert.rejects(door.liveBaseline(s),refused);
 await assert.rejects(door.checks(s,{}),refused);
 await assert.rejects(door.acquireReleaseLock(s),refused);
 assert.deepEqual(f.ssh,[]);
 assert.ok(f.http.every(line=>line.startsWith('GET ')),f.http.join());
 assert.equal((await door.capacityPreflight(manifest)).ok,true);assert.deepEqual(f.ssh,['capacity']);
});
test('outside a rehearsal the doors are as they were: only the lease guards them',async t=>{
 const f=await fixture(t),{rehearsal,...real}=f.config,door=createAutoRuntime(real,{log:()=>{},executionSource:async()=>{},run:f.runtime.run.bind(f.runtime)}),s=await door.secrets();
 await assert.rejects(door.writeCompose(s,'x'),e=>e.code!=='REHEARSAL_REFUSED'&&/lease is required/.test(e.message));
 assert.equal(rehearsal.dir,f.config.rehearsal.dir);
});
test('the command runner refuses a push in a rehearsal',async t=>{
 const dir=tmp(t),out=path.join(dir,'o');fs.mkdirSync(out);
 const runtime=await createRuntime({automatic:false,workspace:dir,tempRoot:dir,outDir:out,bundleRoot:dir,rehearsal:{dir:out}});
 for(const [cmd,args] of [['bash',['C:/x/server/deploy/publish.sh','--tag','t']],['C:/Program Files/Docker/Docker/resources/bin/docker.exe',['--context','desktop-linux','push','a:b']],['docker',['buildx','build','--push','.']],['C:/Program Files/Git/cmd/git.exe',['-C','x','push','origin','main']],['scp.exe',['a','b:c']]])
  await assert.rejects(runtime.run(cmd,args),e=>e.code==='REHEARSAL_REFUSED',cmd);
 assert.equal(rehearsalRefuses('bash',['C:/x/server/deploy/build.sh','--tag','rehearsal-x','--','--progress','plain']),null);
 assert.equal(rehearsalRefuses('docker',['--context','desktop-linux','image','inspect','a']),null);
});
test('the forced pair is the served version, and a real rehearsal needs a verified installer',()=>{
 const pair=forcedPair(manifest,observed);assert.equal(pair.odc,'1.7.30');assert.equal(pair.o11,'11.55.94');assert.deepEqual(pair.lanes,['odc','o11']);
 assert.equal(forcedPair(manifest,[release('odc','1.7.31','1.7.31.1')]).odc,'1.7.31');
 const one=forcedPair(manifest,[observed[0]]);assert.deepEqual(one.lanes,['odc']);assert.equal(one.o11,'11.55.94');
 for(const none of [[],[release('odc','1.7.29','1.7.29.1')],[{...observed[0],requiresInstallation:true}],[{...observed[0],provenance:undefined}]])
  assert.throws(()=>forcedPair(manifest,none),e=>e.code==='REHEARSAL_NOTHING');
});
test('only a rehearsal verifies a release the window already serves',()=>{
 const list=[{lane:'odc',version:'1.7.30',url:'u'},{lane:'o11',version:'11.55.95',url:'u'},{lane:'o11',version:'11.55.94'}];
 assert.deepEqual(releasesToVerify(list,manifest).map(x=>x.version),['11.55.95']);
 assert.deepEqual(releasesToVerify(list,manifest,true).map(x=>x.version),['1.7.30','11.55.95']);
});
test('the smoke of a rehearsal asks the image for its offers, and a refusal fails it',async t=>{
 const dir=tmp(t),features=path.join(dir,'f.xml');fs.writeFileSync(features,'x');
 const run=async(asked,receipt={ok:true,offersChecked:2})=>{
  const inputs=[];
  const docker=async(args,{input}={})=>{
   if(args[0]==='logs')return {code:0,stdout:JSON.stringify({event:'warm',indexes:{ok:true},delivery:{builder:{ok:true},worker:{ok:true}}})+'\n',stderr:''};
   if(args.includes('server-token'))return {code:0,stdout:JSON.stringify({token:'t',agentCredential:'c'}),stderr:''};
   if(input){inputs.push(input);if(input.startsWith('OFFER'))return {code:asked,stdout:asked?'':'noise\n'+JSON.stringify(receipt)+'\n',stderr:''};return {code:0,stdout:'{"ok":true,"tools":91}',stderr:''};}
   return {code:0,stdout:'',stderr:''};
  };
  const result=await smokeImage({pair:{o11:'11.55.94',odc:'1.7.30',image:'i',tag:'t'},bundle:{features},dir:path.join(dir,'ev'),root:dir,docker,served:{odc:['1.7.30'],o11:['11.55.94']},budget:{tools:91,totalBytes:1},privateDir:path.join(dir,'p'),offers:[{},{}],offerCheck:'OFFER'});
  return {result,inputs};
 };
 const good=await run(0);assert.equal(good.result.offersChecked,2);assert.equal(good.inputs.at(-1),'OFFER');
 // B1 of the F1 review: offersChecked is the count check-backend.mjs reported inside the image, never the length of the list.
 assert.equal((await run(0,{ok:true,offersChecked:1})).result.offersChecked,1);
 for(const receipt of [null,{ok:true},{ok:false,offersChecked:2}])assert.match((await run(0,receipt)).result.error,/returned no receipt/);
 const bad=await run(1);assert.equal(bad.result.ok,false);assert.match(bad.result.error,/did not offer/);
});
test('-RehearseCurrent runs alone, and vigia.ps1 hands it over',()=>{
 assert.ok(parseArgs(['--config','c','--rehearse-current']).flags.has('rehearse-current'));
 for(const extra of [['--dry-run'],['--approve','x'],['--retry','x'],['--seed-features','x']])assert.throws(()=>parseArgs(['--config','c','--rehearse-current',...extra]),/runs alone/);
 const ps=fs.readFileSync(path.join(here,'vigia.ps1'),'utf8');
 assert.match(ps,/\[switch\]\$RehearseCurrent/);assert.match(ps,/if\(\$RehearseCurrent\)\{\$argsList\+='--rehearse-current'\}/);
 const placed=rehearsalConfig({outDir:'C:/ssam-priv/vigia/out'},new Date('2026-10-31T12:00:00Z'));
 assert.equal(path.dirname(path.dirname(placed.outDir)),path.resolve('C:/ssam-priv/vigia/out'));assert.equal(placed.rehearsal.dir,placed.outDir);
});
test('nothing of the rehearsal enters the image: deploy/vigia stays out but for one file',()=>{
 const lines=fs.readFileSync(path.resolve(here,'../../.dockerignore'),'utf8').split(/\r?\n/);
 assert.ok(lines.includes('deploy/vigia/*'));
 assert.deepEqual(lines.filter(l=>l.startsWith('!deploy/vigia/')&&l!=='!deploy/vigia/'),['!deploy/vigia/no-provenance.json']);
});
// F1 ed25519-offers rehearsal of the five-pair window with the example pack (no 11.55.95 thin bridge): the bridges are built
// before any test with an Ed25519 manifest only (no thumbprint, no Authenticode), the image must offer them to the published pack's
// hello and accept it with them installed, and the signed store lands in the rehearsal folder. Nothing changes production.
function ed25519Bridges(f,extra={}){
 return async()=>{
  f.order.push('buildBridges');const stage=path.join(f.config.rehearsal.dir,'bridges','e'),keys=generateKeyPairSync('ed25519'),offers=[];
  fs.mkdirSync(stage,{recursive:true});fs.writeFileSync(path.join(stage,'public-key.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
  for(const [lane,v,p,names] of [['odc','1.7.32','v109',[['bridge/ODC3.Bridge.v109.dll','owner'],['client/ODC3.Bridge.Client.dll','owner'],['client/Microsoft.Diagnostics.NETCore.Client.dll','microsoft']]],['o11','11.55.95','d1',[['bridge/Anvil.Bridge.dll','owner'],['hook/Anvil.RuntimeHook.Agent.dll','owner']]]]){
   const target=path.join(stage,lane,v,p),files=[];
   for(const [name,signer] of names){fs.mkdirSync(path.dirname(path.join(target,name)),{recursive:true});fs.writeFileSync(path.join(target,name),name);files.push({path:name,sha256:createHash('sha256').update(name).digest('hex'),size:name.length,signer});}
   const bytes=Buffer.from(JSON.stringify({schema:1,lane,studioVersion:v,runtime:'net10.0',protocol:p,sequence:1,createdAt:new Date().toISOString(),files,...extra}));
   fs.writeFileSync(path.join(target,'manifest.json'),bytes);fs.writeFileSync(path.join(target,'manifest.sig'),sign(null,bytes,keys.privateKey));
   offers.push({lane,studioVersion:v,protocol:p,sequence:1});
  }
  return {stage,mode:'ed25519-offers',offers,kernel:{}};
 };
}
test('ed25519-offers rehearsal of the five-pair window offers the signed d1 bridge for 11.55.95, never Authenticode-signs, changes nothing',async t=>{
 const f=await fixture(t,{config:{bridgeMode:'ed25519-offers',agentPack:example.agentPack,agentPackByRuntime:example.agentPackByRuntime,agentReleaseCommit:'c'.repeat(40)},vault:{authenticodeThumbprint:undefined}});
 f.runtime.agentReleaseFiles=async()=>agentFiles();odcMatches(f);
 f.runtime.observe=async()=>{f.order.push('observe');return [release('odc','1.7.32','1.7.32.11065'),release('o11','11.55.95','11.55.95.65352')];};
 f.runtime.buildBridges=ed25519Bridges(f);
 let seen=null;
 f.runtime.smoke=async()=>{f.order.push('smoke');seen={hello:f.runtime.packHello,expect:f.runtime.offerExpect,kernel:f.runtime.bridgeKernel};return {ok:true,tools:91,totalBytes:259684,coreBytes:33952,publishedPack:true,offersChecked:2};};
 const result=await rehearseCurrent(f.config,f.runtime,{manifest:five});
 assert.equal(result.status,'rehearsed',JSON.stringify(result));assert.equal(result.bridgeMode,'ed25519-offers');assert.equal(result.id,'o11-11.55.95-odc-1.7.32');
 assert.ok(f.order.indexOf('buildBridges')<f.order.indexOf('test o11 baseline'),f.order.join());
 assert.deepEqual(result.offers.map(o=>[o.lane,o.studioVersion,o.protocol,o.signers]),[['odc','1.7.32','v109',{owner:2,microsoft:1}],['o11','11.55.95','d1',{owner:2,microsoft:0}]]);
 assert.deepEqual(result.hello,{odcBridge:'v108',o11BuiltFor:'11.55.94',installed:['o11 d1#1']});assert.deepEqual(result.offerLanes,['o11']);
 // F1 review M2: 11.55.94 is still served in this window, yet a 0.2.7 agent on 11.55.95 is never served its 11.55.94 thin bridge:
 // it is told to install app 0.2.8 (the kernel names the pack builds it accepts for 11.55.95: only its own).
 assert.deepEqual(result.legacy,{odc:{ok:true},o11:{ok:false,code:'AGENT_PACK_MISMATCH',cause:'AGENT_UPDATE_REQUIRED'}});assert.deepEqual(seen.kernel.o11PackBuiltFor,['11.55.95']);
 assert.deepEqual(seen.kernel.o11BridgeAccepted,['d1']);assert.equal(seen.expect.offerHello.capabilities.bridgeOffer,true);
 assert.ok(fs.existsSync(path.join(f.config.rehearsal.dir,'store','o11','11.55.95','d1','manifest.sig')));
 assert.ok(!f.ran.some(cmd=>/dotnet|signtool/i.test(cmd)),f.ran.join());assert.deepEqual(f.spied,[]);assert.deepEqual([...new Set(f.ssh)],['capacity']);
});
test('ed25519-offers rehearsal refuses a store whose manifest still names an Authenticode thumbprint',async t=>{
 const f=await fixture(t,{config:{bridgeMode:'ed25519-offers',agentPack:example.agentPack,agentPackByRuntime:example.agentPackByRuntime,agentReleaseCommit:'c'.repeat(40)},vault:{authenticodeThumbprint:undefined}});
 f.runtime.agentReleaseFiles=async()=>agentFiles();odcMatches(f);
 f.runtime.observe=async()=>{f.order.push('observe');return [release('odc','1.7.32','1.7.32.11065'),release('o11','11.55.95','11.55.95.65352')];};
 f.runtime.buildBridges=ed25519Bridges(f,{authenticodeThumbprint:'b'.repeat(40)});
 f.runtime.smoke=async()=>({ok:true,tools:91,totalBytes:1,coreBytes:1,publishedPack:true,offersChecked:2});
 const result=await rehearseCurrent(f.config,f.runtime,{manifest:five});
 assert.equal(result.status,'failed');assert.match(result.error,/names an Authenticode thumbprint/);assert.deepEqual(f.spied,[]);
});
// F1 review M1: the vault's manifest key must be the key the published agent pins (bridgeTrustKeySpkiSha256 of the private
// configuration); another key, or no pin, refuses the round before anything is built or signed.
test('ed25519-offers rehearsal refuses a vault key that is not the pinned agent trust key, and a missing pin',async t=>{
 for(const [pin,code] of [['0'.repeat(64),'BRIDGE_TRUST_KEY_MISMATCH'],[null,'BRIDGE_TRUST_KEY_UNPINNED'],['2CE611D0','BRIDGE_TRUST_KEY_UNPINNED']]){
  const f=await fixture(t,{config:{bridgeMode:'ed25519-offers',agentPack:example.agentPack,agentPackByRuntime:example.agentPackByRuntime,agentReleaseCommit:'c'.repeat(40),bridgeTrustKeySpkiSha256:pin},vault:{authenticodeThumbprint:undefined}});
  f.runtime.agentReleaseFiles=async()=>agentFiles();odcMatches(f);
  f.runtime.observe=async()=>{f.order.push('observe');return [release('odc','1.7.32','1.7.32.11065'),release('o11','11.55.95','11.55.95.65352')];};
  f.runtime.buildBridges=ed25519Bridges(f);
  await assert.rejects(rehearseCurrent(f.config,f.runtime,{manifest:five}),e=>e.code===code&&!/PRIVATE KEY/.test(e.message),String(pin));
  assert.ok(!f.order.includes('buildBridges'),f.order.join());assert.deepEqual(f.spied,[]);
 }
});
