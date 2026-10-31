import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {createAutoRuntime,releasesToVerify} from './auto-runtime.mjs';
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
async function fixture(t){
 const dir=tmp(t),out=path.join(dir,'out'),http_=[],ssh=[],spied=[],ran=[];fs.mkdirSync(out);
 const server=http.createServer((req,res)=>{http_.push(req.method+' '+req.url);res.setHeader('content-type','application/json');res.end(JSON.stringify({docker_compose_raw:'services: {}'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const key=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'});
 const real={automatic:true,workspace:path.resolve(here,'../../..'),tempRoot:dir,outDir:out,pauseFile:path.join(dir,'PAUSE'),automaticDeployment:{testOnly:true,coolify:{url:`http://127.0.0.1:${server.address().port}`,resource:'fixture'},ssh:{host:'fixture',knownHosts:path.join(dir,'known')},remote:{directory:'/x'}}};
 const config=rehearsalConfig(real,new Date('2026-10-31T12:00:00Z'));fs.mkdirSync(config.outDir,{recursive:true});
 const base={log:()=>{},notes:[],executionSource:async()=>{},
  async notify(title){this.notes.push(title);},
  async run(cmd,args,{input}={}){
   ran.push(path.basename(String(cmd)));
   if(args.some(x=>String(x).endsWith('read-secrets.ps1')))return {stdout:JSON.stringify({coolifyToken:'memory-only',sshPrivateKey:Buffer.from('PRIVATE KEY').toString('base64'),authenticodeThumbprint:'b'.repeat(40),manifestPrivateKey:key,journalKey:Buffer.alloc(32,1).toString('base64'),webhookUrl:real.automaticDeployment.coolify.url+'/webhook'})};
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
 const run=async asked=>{
  const inputs=[];
  const docker=async(args,{input}={})=>{
   if(args[0]==='logs')return {code:0,stdout:JSON.stringify({event:'warm',indexes:{ok:true},delivery:{builder:{ok:true},worker:{ok:true}}})+'\n',stderr:''};
   if(args.includes('server-token'))return {code:0,stdout:JSON.stringify({token:'t',agentCredential:'c'}),stderr:''};
   if(input){inputs.push(input);if(input.startsWith('OFFER'))return {code:asked,stdout:'',stderr:''};return {code:0,stdout:'{"ok":true,"tools":91}',stderr:''};}
   return {code:0,stdout:'',stderr:''};
  };
  const result=await smokeImage({pair:{o11:'11.55.94',odc:'1.7.30',image:'i',tag:'t'},bundle:{features},dir:path.join(dir,'ev'),root:dir,docker,served:{odc:['1.7.30'],o11:['11.55.94']},budget:{tools:91,totalBytes:1},privateDir:path.join(dir,'p'),offers:[{},{}],offerCheck:'OFFER'});
  return {result,inputs};
 };
 const good=await run(0);assert.equal(good.result.offersChecked,2);assert.equal(good.inputs.at(-1),'OFFER');
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
