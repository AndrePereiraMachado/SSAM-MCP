import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
const CLIENT_BRIDGE=/const string Version = "(v\d+)"/.exec(fs.readFileSync(fileURLToPath(new URL('../../platforms/odc/studio/bridge/client/Program.cs',import.meta.url)),'utf8'))[1];
import {generateKeyPairSync,createHash,sign,verify} from 'node:crypto';
import {configureJournals,readJournal,writeJournal} from './journal.mjs';
import {releaseAutomatically,AUTOMATIC_PLAN} from './automatic.mjs';
import {createAutoRuntime} from './auto-runtime.mjs';
import {detectSources,downloadInstaller,officialUrl} from './sources.mjs';
import {createBridgeStore,verifyBridge} from '../../platforms/odc/facade/bridge-store.mjs';
import {compatibility,createAgentHub} from '../../platforms/odc/facade/agent-hub.mjs';
import {runVigia} from './pipeline.mjs';
import {baseWindow} from './vigia.mjs';
import {generateCompose} from '../coolify/gen-compose.mjs';
import {composeHash} from './safety.mjs';
const tmp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'auto-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
async function server(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>s.close(r)));return `http://127.0.0.1:${s.address().port}`;}
const digest='a'.repeat(64);
// The receipt of an event the VPS journal took (auto-runtime event): releaseEvent records it as sent only then.
const SENT=Object.freeze({remote:true,webhook:false});
function release(dir){return {id:'o11-11.55.94-odc-1.7.30',dir,built:{image:'private/image',tag:'prod-test',sha256:digest},manifest:{window:3,odc:[{version:'1.7.30',tag:'prod-test',image:'private/image'}],o11:[{version:'11.55.94',tag:'prod-test',image:'private/image'}]},kernel:{odc:'1.7.30',o11:'11.55.94'},bridges:{offers:[]},features:'private'};}
async function fixture(t,fail){
 const dir=tmp(t),calls=[],notices=[];const old={window:3,odc:[{version:'1.7.29',image:'private/image',tag:'prod-old',sha256:digest}],o11:[{version:'11.55.93',image:'private/image',tag:'prod-old',sha256:digest}]};const liveCompose=JSON.stringify(generateCompose(old));let compose=liveCompose,restarts=0;const file=path.join(dir,'snapshot.dpapi');fs.writeFileSync(file,Buffer.from(JSON.stringify({compose:liveCompose,backends:[{odc:'1.7.29',o11:'11.55.93',image:'old',budget:{tools:90,totalBytes:999999,core:[]}}]})).toString('base64'));const baseline={file,hash:composeHash(liveCompose),manifest:old,kernels:{}};
 const endpoint=await server(t,async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer memory-only-token');
  let data='';for await(const b of req)data+=b;
  if(req.url.endsWith('/restart')){assert.equal(req.method,'POST');calls.push('deploy');restarts++;if(fail==='deploy'&&restarts===1){res.writeHead(503);res.end('{}');return;}}
  else if(req.method==='PATCH'){assert.equal(JSON.parse(data).instant_deploy,false);compose=Buffer.from(JSON.parse(data).docker_compose_raw,'base64').toString();calls.push(compose===liveCompose?'restore':'compose');}
  else calls.push('snapshot');
  res.setHeader('content-type','application/json');res.end(JSON.stringify({docker_compose_raw:compose}));
 });
 const key=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'});
 const config={workspace:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),tempRoot:dir,outDir:dir,configFile:path.join(dir,'config.json'),domains:{ssam:'mcp.example.test',console:'panel.example.test'},automaticDeployment:{testOnly:true,coolify:{url:endpoint,resource:'fixture'},ssh:{host:'fixture',knownHosts:'fixture'},remote:{}}};
 const base={
  executionSource:async()=>{},
  openLease:async()=>{calls.push('lock');const close=async()=>calls.push('unlock');close.assertHeld=()=>{};return close;},
  async run(cmd,args,{input}={}){
   if(args.some(x=>String(x).endsWith('read-secrets.ps1')))return {stdout:JSON.stringify({coolifyToken:'memory-only-token',sshPrivateKey:Buffer.from('PRIVATE KEY').toString('base64'),authenticodeThumbprint:'b'.repeat(40),manifestPrivateKey:key,journalKey:Buffer.alloc(32,1).toString('base64')})};
   if(args.includes('Protect'))return {stdout:Buffer.from(input).toString('base64')};
   if(args.includes('Unprotect'))return {stdout:Buffer.from(input,'base64').toString()};
   if(cmd.endsWith('icacls.exe'))return {stdout:''};
   const request=JSON.parse(input);calls.push(request.action);
   if(request.action==='check'&&fail==='warm'&&!request.rollback)throw Error('fake warm failure');
   return {stdout:JSON.stringify(request.action==='snapshot'?{ok:true,backends:[{odc:'1.7.29',o11:'11.55.93',reference:'private/image:prod-old',digest:'sha256:'+digest,image:'old',kernel:{odc:'1.7.29',o11:'11.55.93'},budget:{tools:90,totalBytes:999999,core:[]}}]}:{ok:true})};
  },log:()=>{},notify:async()=>{}
 };
 const adapter=createAutoRuntime(config,base);
 const ops={...adapter, verifyRelease:async()=>{},notify:async()=>{},pause:()=>{},deploymentBudget:()=>{},liveBaseline:async()=>baseline,preflightRemote:async()=>calls.push('preflight'),
  secrets:adapter.secrets,
  verifyLocalImage:async()=>calls.push('verify'),
  publish:async()=>{calls.push('publish');if(fail==='partial')throw Error('partial registry publication');return {digest:'sha256:'+digest};},
  pinExecution:async()=>{calls.push('pin');return 'local-commit';},
  prepare:async()=>calls.push('prepare'),
  event:async(name)=>{notices.push(name);return SENT;}
 };
 return {dir,calls,notices,config,ops,base,baseline,liveCompose,compose:()=>compose};
}
test('complete release uses fake Coolify HTTP and SSH, pins locally and never deploys twice',async t=>{
 const f=await fixture(t);const r=await releaseAutomatically(f.config,f.ops,release(f.dir));assert.equal(r.status,'live');
 assert.deepEqual(f.calls.filter(x=>x!=='fence'),['verify','publish','pin','lock','preflight','snapshot','backup','prepare','snapshot','compose','snapshot','deploy','check','unlock']);
 assert.deepEqual(f.notices,['detected','live']);
 await releaseAutomatically(f.config,f.ops,release(f.dir));assert.equal(f.calls.filter(x=>x==='publish').length,1);
 assert.ok(!fs.readFileSync(path.join(f.dir,'deployment.json'),'utf8').includes('memory-only-token'));
});
for(const fail of ['warm','deploy'])test(`${fail} failure restores the exact live compose through HTTP, redeploys and checks`,async t=>{
 const f=await fixture(t,fail);const r=await releaseAutomatically(f.config,f.ops,release(f.dir));assert.equal(r.status,'rolled-back');
 assert.equal(f.compose(),f.liveCompose);assert.equal(f.calls.filter(x=>x==='deploy').length,2);
 assert.deepEqual(f.notices,['detected','failed']);assert.ok(f.calls.indexOf('restore')<f.calls.lastIndexOf('check'));
});
test('partial publication never pins, backs up or deploys',async t=>{
 const f=await fixture(t,'partial');const r=await releaseAutomatically(f.config,f.ops,release(f.dir));assert.equal(r.status,'failed');
 assert.deepEqual(f.calls,['verify','publish']);assert.deepEqual(f.notices,['detected','failed']);
});
test('a mismatched registry digest stops before pin or deployment',async t=>{
 const f=await fixture(t);f.ops.publish=async()=>({digest:'sha256:'+'b'.repeat(64)});
 assert.equal((await releaseAutomatically(f.config,f.ops,release(f.dir))).status,'failed');
 assert.deepEqual(f.calls,['verify']);assert.deepEqual(f.notices,['detected','failed']);
});
test('a failed rollback is never reported as restored',async t=>{
 const f=await fixture(t,'warm');f.ops.restoreCompose=async()=>{throw Error('offline');};
 assert.equal((await releaseAutomatically(f.config,f.ops,release(f.dir))).status,'rollback-failed');
 assert.equal(readJournal(path.join(f.dir,'deployment.json')).status,'rollback-failed');
});
test('an interrupted rollback resumes restoration without deploying the candidate again',async t=>{
 const f=await fixture(t);const r=release(f.dir);await releaseAutomatically(f.config,f.ops,r);
 const file=path.join(f.dir,'deployment.json'),journal=readJournal(file);
 journal.status='rolling-back';delete journal.steps['notice-live'];delete journal.steps['notice-failed'];writeJournal(file,journal);
 const before=f.calls.length;
 assert.equal((await releaseAutomatically(f.config,f.ops,r)).status,'rolled-back');
 assert.deepEqual(f.calls.slice(before).filter(x=>x!=='fence'),['lock','snapshot','restore','snapshot','deploy','check','unlock']);
});
test('missing secrets stops before any journal or external write',async t=>{
 const dir=tmp(t);await assert.rejects(releaseAutomatically({}, {secrets:async()=>{throw Error('missing');}},release(dir)),/missing/);
 assert.deepEqual(fs.readdirSync(dir),[]);
});
test('source detection, local fallback and installer hash never execute an installer',async t=>{
 const dir=tmp(t);const endpoint=await server(t,(req,res)=>{
  const url=new URL(req.url,'http://x');res.setHeader('content-type','application/json');
  if(url.pathname==='/installer'){res.end(Buffer.from('MZ-synthetic-installer'));return;}
  const lane=url.searchParams.get('component');res.end(JSON.stringify({version:lane==='ODCStudio'?'1.7.30.10980':'11.55.94.65328',link:base+'/installer'}));
 });const base=endpoint;
 const seen=await detectSources([],{endpoint,allowTestHttp:true});assert.equal(seen.observed.length,2);
 const downloaded=await downloadInstaller(seen.observed[0],dir,{allowTestHttp:true});assert.equal(fs.readFileSync(downloaded.file+'.sha256','utf8').trim(),downloaded.sha256);
 const local=[{lane:'odc',version:'1.7.29',fullVersion:'1.7.29.1'}];
 assert.deepEqual((await detectSources(local,{fetcher:async()=>{throw Error('login');}})).observed,local);
 assert.throws(()=>officialUrl('https://evil.example/a.exe'));
 assert.ok(AUTOMATIC_PLAN.some(x=>x.includes('MSBuild')));
});
function bridge(t){const dir=tmp(t),keys=generateKeyPairSync('ed25519'),sub=path.join(dir,'odc','1.7.30','v101');fs.mkdirSync(path.join(sub,'bridge'),{recursive:true});const bytes=Buffer.from('synthetic signed DLL');const sha=createHash('sha256').update(bytes).digest('hex');fs.writeFileSync(path.join(sub,'bridge','test.dll'),bytes);const m={schema:1,lane:'odc',studioVersion:'1.7.30',runtime:'net10.0',protocol:'v101',sequence:1,createdAt:new Date().toISOString(),authenticodeThumbprint:'b'.repeat(40),files:[{path:'bridge/test.dll',sha256:sha,size:bytes.length,signer:'owner'}]};const raw=Buffer.from(JSON.stringify(m));fs.writeFileSync(path.join(sub,'manifest.json'),raw);fs.writeFileSync(path.join(sub,'manifest.sig'),sign(null,raw,keys.privateKey));return {dir,sub,sha,store:createBridgeStore({root:dir,publicKey:keys.publicKey}),keys};}
const hello={pack:{lanes:['odc','o11'],odcBridge:'v0',o11BuiltFor:'11.55.94'},studios:{odc:{installed:{version:'1.7.30'}},o11:{installed:{version:'11.55.94'}}}};
const kernel={odc:'1.7.30',o11:'11.55.94',odcBridge:'v101'};
test('new agent gets signed offer; old agent retains its package refusal; invalid signatures never get offered',t=>{
 const b=bridge(t);
 assert.equal(compatibility(hello,kernel,['odc'],{bridges:b.store}).odc.code,'AGENT_PACK_MISMATCH');
 const modern={...hello,capabilities:{bridgeOffer:true}};
 assert.equal(compatibility(modern,kernel,['odc'],{bridges:b.store}).odc.bridgeOffer.protocol,'v101');
 const offer=b.store.offer('odc','1.7.30',['v101']);
 assert.equal(typeof offer.manifest,'string');assert.ok(verify(null,Buffer.from(offer.manifest),b.keys.publicKey,Buffer.from(offer.signature,'base64')));
 fs.writeFileSync(path.join(b.sub,'manifest.sig'),Buffer.alloc(64));
 assert.equal(compatibility(modern,kernel,['odc'],{bridges:b.store}).odc.code,'AGENT_PACK_MISMATCH');
 assert.equal(b.store.file('odc','1.7.30','v101',b.sha),null);
});
test('bridge download needs a valid agent token and the served pair, rejects path traversal and tampering',async t=>{
 const b=bridge(t);const dir=tmp(t);
 const hub=createAgentHub({dir,kernel,bridges:b.store,store:{verifyAgent:token=>token==='ssam_agent_fixture'?{status:'ok',id:'fixture',lanes:['odc']}:{status:'unknown'},lookup:()=>({state:'active'})}});t.after(()=>hub.close());
 const base=await server(t,(req,res)=>hub.handle(req,res));const url=base+'/agent/bridges/odc/1.7.30/v101/'+b.sha;
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{authorization:'Bearer ssam_agent_fixture'}})).status,200);
 fs.writeFileSync(path.join(b.sub,'bridge/test.dll'),'tampered');
 assert.equal((await fetch(url,{headers:{authorization:'Bearer ssam_agent_fixture'}})).status,404);
 assert.equal(b.store.file('odc','../../bad','v101',b.sha),null);
});
test('automatic pipeline compiles bridges before the image and never creates an approval proposal',async t=>{
 const f=await fixture(t),events=f.calls;
 const config={...f.config,automatic:true,bridgeMode:'signed-offers',outDir:f.dir,head:'source-head',manifest:{window:3,odc:[{version:'1.7.29',image:'private/image',tag:'prod-old',sha256:digest}],o11:[{version:'11.55.93',image:'private/image',tag:'prod-old',sha256:digest}]},observed:[{lane:'odc',version:'1.7.30',fullVersion:'1.7.30.10980',studio:'odc',tfm:'net10.0'},{lane:'o11',version:'11.55.94',fullVersion:'11.55.94.65328',studio:'o11',tfm:'net10.0'}]};
 const ops={...f.ops,preflight:async()=>{},targetFramework:async()=> 'net10.0',dockerReady:async()=>{},
  bundle:async c=>({...c,file:'bundle',sha256:digest,features:'private'}),companion:async(lane,version)=>({lane,version}),
  test:async()=>({passed:1,total:1,failures:[]}),buildBridges:async()=>{events.push('bridges');return {offers:[],kernel:kernel};},
  build:async()=>{events.push('image');return {...release(f.dir).built,odc:'1.7.30',o11:'11.55.94'};},smoke:async()=>({ok:true}),
  propose:async()=>{throw Error('Approval must not be requested.');}};
 const result=await runVigia(config,ops);assert.equal(result.status,'live');assert.ok(events.indexOf('bridges')<events.indexOf('image'));
 assert.ok(events.indexOf('image')<events.indexOf('publish'));
});
test('bridge builder targets the Studio runtime, signs through the vault entry point and packages verifiable manifests',async t=>{
 const f=await fixture(t),builds=[];const agent=path.join(f.dir,'agent-source');
 const bundle=path.join(f.dir,'bundle');fs.writeFileSync(bundle,'fixture');const sha=createHash('sha256').update('fixture').digest('hex');f.config.bundlePins={'odc-1.7.30':sha,'o11-11.55.94':sha};
 const privateKey=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});
 const runtime={executionSource:async()=>{},agentSource:async()=>agent,waitForDotnet:async()=>{},async run(cmd,args){
  if(args.some(x=>String(x).endsWith('read-secrets.ps1')))return {stdout:JSON.stringify({coolifyToken:'memory',sshPrivateKey:Buffer.from('PRIVATE KEY').toString('base64'),authenticodeThumbprint:'b'.repeat(40),manifestPrivateKey:privateKey,journalKey:Buffer.alloc(32,1).toString('base64')})};
  if(args.includes('-getProperty:TargetFramework'))return {stdout:args[1].includes('Anvil.RuntimeHook')?'net8.0':args[1].includes('Anvil.Bridge.Thin')?(args.includes('-p:TargetFramework=net10.0')?'net10.0':'net8.0'):'net10.0'};
  if(args.includes('-getProperty:TargetPath'))return {stdout:builds.at(-1).output};
  if(args[0]==='build'){
   builds.push(args);const out=args[args.indexOf('-o')+1];fs.mkdirSync(out,{recursive:true});
   const name=args[1].endsWith('Client.csproj')?'ODC3.Bridge.Client.dll':args[1].includes('Anvil.RuntimeHook')?'Anvil.RuntimeHook.Agent.dll':args[1].includes('Anvil.Bridge.Thin')?'Anvil.Bridge.dll':`ODC3.Bridge.${CLIENT_BRIDGE}.dll`;
   fs.writeFileSync(path.join(out,name),'fake signed binary');args.output=path.join(out,name);
   const assets=path.join(path.dirname(args[1]),'obj/project.assets.json');fs.mkdirSync(path.dirname(assets),{recursive:true});fs.writeFileSync(assets,JSON.stringify({packageFolders:{},libraries:{}}));
   if(name==='ODC3.Bridge.Client.dll')fs.writeFileSync(path.join(out,'ODC3.Bridge.Client.runtimeconfig.json'),JSON.stringify({runtimeOptions:{tfm:'net10.0'}}));
   return {stdout:''};
  }
  assert.ok(args.includes('Artifacts'));assert.ok(!args.includes('b'.repeat(40)));const target=args[args.indexOf('-ArtifactDirectory')+1],records=[];for(const sub of fs.readdirSync(target)){if(!fs.statSync(path.join(target,sub)).isDirectory())continue;for(const name of fs.readdirSync(path.join(target,sub)))if(name.endsWith('.dll'))records.push({path:sub+'/'+name,signer:'owner'});}fs.writeFileSync(path.join(target,'authenticode.json'),JSON.stringify(records));return {stdout:'Bridge signatures verified.'};
 }};
 const fakeRoot=path.join(f.dir,'source');for(const rel of ['server/platforms/odc/studio/bridge/client/Program.cs','server/deploy/coolify/r1-kernels.json']){const dest=path.join(fakeRoot,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(f.config.workspace,rel),dest);}
 const adapter=createAutoRuntime({...f.config,workspace:fakeRoot,bridgeMode:'signed-offers'},runtime);
 const result=await adapter.buildBridges({odc:'1.7.30',o11:'11.55.94'},{odc:{lane:'odc',file:bundle,sha256:sha,version:'1.7.30',tfm:'net10.0',snapshot:'odc'},o11:{lane:'o11',file:bundle,sha256:sha,version:'11.55.94',tfm:'net10.0',snapshot:'o11'}},f.dir);
 assert.equal(result.kernel.o11Hook,undefined);assert.deepEqual(result.kernel.o11BridgeAccepted,['d1']);
 const oldHello={pack:{lanes:['odc','o11'],odcBridge:result.kernel.odcBridge,o11BuiltFor:'11.55.94',o11Hook:'dev'},studios:{odc:{installed:{version:'1.7.30'}},o11:{installed:{version:'11.55.94'}}}};
 assert.equal(compatibility(oldHello,result.kernel,['odc','o11']).o11.ok,true);
 const offered=createBridgeStore({root:result.stage,publicKey:fs.readFileSync(path.join(result.stage,'public-key.pem'))});
 const newer={...oldHello,pack:{...oldHello.pack,o11BuiltFor:'11.55.93'},capabilities:{bridgeOffer:true}};
 assert.equal(compatibility(newer,result.kernel,['odc','o11'],{bridges:offered}).o11.bridgeOffer.protocol,'d1');
 assert.equal(builds.length,4);assert.ok(builds.every(a=>!a.some(v=>v.startsWith('-p:OdcBridgeRuntime'))));
 assert.ok(builds.some(a=>a.includes('-p:AssemblyName=Anvil.RuntimeHook.Agent')));
 assert.ok(builds.some(a=>a[1].includes(path.join('agent','kernel','src','Anvil.Bridge.Thin'))));
 const key=fs.readFileSync(path.join(result.stage,'public-key.pem'));
 for(const offer of result.offers)assert.equal(verifyBridge(path.join(result.stage,offer.lane,offer.studioVersion,offer.protocol),key).manifest.runtime,'net10.0');
 assert.ok(result.kernel.odcBridgeAccepted.includes(result.kernel.odcBridge));
 // The real builds of 31/10 (C:/t/r3/img/final/e2e): the thin bridge follows the Studio, and the net8 hook never sees a net10 Studio's framework copies.
 const thin=builds.find(a=>String(a[1]).includes('Anvil.Bridge.Thin')),hook=builds.find(a=>String(a[1]).includes('Anvil.RuntimeHook'));
 assert.ok(thin.includes('-p:TargetFramework=net10.0')&&thin.includes('-restore'));
 assert.ok(!hook.some(x=>/^-p:(SSDir|OdcInstall|TargetFramework)=/.test(String(x))));
});
test('a local pin whose deployment rolled back never becomes the served baseline',t=>{
 const dir=tmp(t),r=release(dir),old={window:3,odc:[{version:'1.7.29',image:'private/image',tag:'prod-old',sha256:digest}],o11:[{version:'11.55.93',image:'private/image',tag:'prod-old',sha256:digest}]};
 const folder=path.join(dir,r.id);fs.mkdirSync(folder);
 fs.writeFileSync(path.join(folder,'attempt.json'),JSON.stringify({id:r.id,status:'failed',baseManifest:old,built:r.built,at:new Date().toISOString()}));
 assert.deepEqual(baseWindow(r.manifest,dir).manifest,old);
});
test('the real prepare adapter accepts the generated compose comment and transfers only over fake SSH',async t=>{
 const f=await fixture(t),r=release(f.dir),feature=path.join(f.dir,'features.xml');fs.writeFileSync(feature,'<Features/>');
 f.base.fullHead=async()=> 'commit';f.base.archiveDeploy=async(_commit,file)=>fs.writeFileSync(file,'fake deploy archive');
 const adapter=createAutoRuntime(f.config,f.base);
 const s=await adapter.secrets(),unlock=await adapter.acquireReleaseLock(s);
 await adapter.prepare(s,{...r,features:feature,compose:'# Generated by gen-compose.mjs.\n{"services":{},"volumes":{}}'});await unlock();
 assert.deepEqual(f.calls,['lock','prepare','unlock']);
});
test('live adapter captures production identities and uses the captured 90-tool budget during rollback',async t=>{
 const f=await fixture(t),adapter=createAutoRuntime(f.config,f.base),s=await adapter.secrets();
 const live=await adapter.liveBaseline(s);assert.equal(live.manifest.odc[0].version,'1.7.29');assert.equal(live.manifest.odc[0].sha256,digest);assert.equal(live.compose,undefined);
 const original=f.base.run;f.base.run=async(cmd,args,options)=>{
  if(options?.input){try{const r=JSON.parse(options.input);if(r.action==='check')assert.match(r.checkSources['11.55.93|1.7.29'],/"tools":90/);}catch(e){if(e.code==='ERR_ASSERTION')throw e;}}
  return original(cmd,args,options);
 };
 const unlock=await adapter.acquireReleaseLock(s);assert.equal((await adapter.checks(s,{rollback:true,live})).ok,true);await unlock();
});
test('failed lease acquisition removes the temporary SSH key on every error path',async t=>{
 const f=await fixture(t);f.base.openLease=async()=>{throw Error('lock busy');};
 const adapter=createAutoRuntime(f.config,f.base);await assert.rejects(adapter.acquireReleaseLock(await adapter.secrets()),/lock busy/);
 assert.equal(fs.readdirSync(f.dir).filter(x=>x.startsWith('ssh-')).length,0);
});
test('insufficient deployment time starts no publication or remote operation',async t=>{
 const f=await fixture(t);f.ops.deploymentBudget=()=>{throw Error('insufficient time');};
 await assert.rejects(releaseAutomatically(f.config,f.ops,release(f.dir)),/insufficient time/);assert.deepEqual(f.calls,[]);
});
test('HTTP hello records amended bridge telemetry and suppresses a failed identity',async t=>{
 const b=bridge(t),dir=tmp(t),events=[];
 const hub=createAgentHub({dir,kernel,bridges:b.store,log:e=>events.push(e),store:{verifyAgent:()=>({status:'ok',id:'fixture',customer:'Fixture',lanes:['odc']}),lookup:()=>({state:'active'})}});t.after(()=>hub.close());
 const base=await server(t,(req,res)=>hub.handle(req,res));
 const report={lane:'odc',studioVersion:'1.7.30',protocol:'v101',sequence:1,status:'failed',reason:'LOAD_FAILED'};
 const response=await fetch(base+'/agent/v1/hello',{method:'POST',headers:{authorization:'Bearer ssam_agent_fixture','content-type':'application/json'},body:JSON.stringify({...hello,t:'hello',protocol:'ssam-agent/1',instance:'review',agent:{version:'1.0.0'},capabilities:{bridgeOffer:true},bridges:[report]})});
 assert.equal(response.status,200);const data=await response.json();assert.equal(data.compatible.odc.bridgeOffer,undefined);
 assert.ok(events.some(e=>e.event==='bridge-report'&&e.sequence===1));
 const telemetry=JSON.parse(fs.readFileSync(path.join(dir,'state','studio-versions.json'),'utf8'));assert.equal(telemetry.tokens.fixture.bridges[0].reason,'LOAD_FAILED');
});

// Server-only bridge mode (the default): the round deploys the server pair only, against the published agent pack.
const example=JSON.parse(fs.readFileSync(fileURLToPath(new URL('./config.example.json',import.meta.url)),'utf8'));
const agentFiles=(edit=x=>x)=>{const at=rel=>edit(fs.readFileSync(fileURLToPath(new URL('../../../agent/'+rel,import.meta.url)),'utf8'));return {program:at('platforms/odc/studio/bridge/client/Program.cs'),kinds:at('agent/lib/kinds.mjs'),native:at('native/Ssam.Agent/StudioKinds.cs'),bridgeProject:at('platforms/odc/studio/bridge/Bridge.csproj')};};
function serverOnlyRound(f,{tfm='net10.0',pack={},edit}={}){
 const events=f.calls,notes=[],runs=[];f.base.agentReleaseFiles=async()=>agentFiles(edit);f.config.agentReleaseCommit='c'.repeat(40);
 const original=f.base.run;f.base.run=async(cmd,args,options)=>{runs.push({cmd:String(cmd),args:args.map(String),input:options?.input});return original(cmd,args,options);};
 const config={...f.config,automatic:true,agentPack:example.agentPack,agentPackByRuntime:{...example.agentPackByRuntime,net10:{...example.agentPackByRuntime.net10,...pack}},agentReleaseCommit:'c'.repeat(40),outDir:f.dir,head:'source-head',manifest:{window:3,odc:[{version:'1.7.29',image:'private/image',tag:'prod-old',sha256:digest}],o11:[{version:'11.55.93',image:'private/image',tag:'prod-old',sha256:digest}]},observed:[{lane:'odc',version:'1.7.30',fullVersion:'1.7.30.10980',studio:'odc',tfm},{lane:'o11',version:'11.55.94',fullVersion:'11.55.94.65328',studio:'o11',tfm:'net10.0'}]};
 const ops={...f.ops,notify:async title=>notes.push(title),preflight:async()=>{},targetFramework:async c=>c.tfm,dockerReady:async()=>{},
  bundle:async c=>{events.push('bundle '+c.lane);return {...c,file:'bundle',sha256:digest,features:'private'};},companion:async(lane,version)=>({lane,version,tfm:'net10.0'}),
  test:async()=>{events.push('test');return {passed:1,total:1,failures:[]};},buildBridges:async()=>{events.push('bridges');throw Error('no bridge is built in server-only');},
  build:async()=>{events.push('image');return {...release(f.dir).built,odc:'1.7.30',o11:'11.55.94'};},
  smoke:async()=>{events.push('smoke');ops.smoked=ops.packHello;return {ok:true,publishedPack:!!ops.packHello};},
  odcBinary:async a=>{events.push('odc references');ops.odcReferences=a;return {reference:'1.7.29',gaps:[],compared:[]};},
  propose:async()=>{throw Error('Approval must not be requested.');}};
 return {config,ops,notes,runs};
}
// A real round reads the vault (and so the journal key) before the pair round: vigia.mjs round.
const roundOf=async s=>{await s.ops.secrets();return runVigia(s.config,s.ops);};
const signingCalls=runs=>runs.filter(r=>/dotnet|signtool/i.test(r.cmd)||r.args.some(a=>/odc-runtime-signing|Authenticode/i.test(a)));
test('server-only round deploys the server pair only: no client bridge build, no signing, the published pack hello is smoked and checked',async t=>{
 const f=await fixture(t),s=serverOnlyRound(f);
 const result=await roundOf(s);assert.equal(result.status,'live',JSON.stringify(result));
 assert.ok(!f.calls.includes('bridges'));assert.deepEqual(signingCalls(s.runs),[]);
 assert.equal(s.ops.bridgeKernel.odcBridge,'v108');assert.equal(s.ops.smoked.pack.odcBridge,'v108');assert.ok(s.ops.smoked.agent.odcCommands.includes('reconcile-merge'));
 const check=s.runs.map(r=>{try{return JSON.parse(r.input);}catch{return null;}}).find(r=>r?.action==='check'&&!r.rollback);
 assert.match(check.checkSource,/"packHellos":\{"11\.55\.94\|1\.7\.30":\{"t":"hello"/);
 assert.ok(f.calls.indexOf('smoke')<f.calls.indexOf('publish'));
 // M3: the published bridge's Studio references (Bridge.csproj of the release) are compared before any test, against the served ODC.
 assert.ok(s.ops.odcReferences.references.includes('OutSystems.Model')&&s.ops.odcReferences.references.includes('Xilium.CefGlue.Common'),JSON.stringify(s.ops.odcReferences.references));
 assert.deepEqual(s.ops.odcReferences.served,['1.7.29']);assert.equal(s.ops.odcReferences.candidate.version,'1.7.30');
 assert.ok(f.calls.indexOf('odc references')<f.calls.indexOf('test'));
 // B4 and A2: exactly one backend must present the published hello, and every backend must hold the pinned model plugins.
 assert.equal(check.requirePresented,true);assert.deepEqual(check.modelPlugins.files.map(x=>x.name),['MobileUI-1.4.0.0.xif','MobileUI-1.5.0.0.xif']);
 assert.match(check.checkSource,/"modelPlugins":\{"volume":"odc-model-plugins","target":"\/tmp\/\.local\/share\/OutSystems\/ODC Studio\/Plugins"/);
 // The prepare request carries the same pins (the remote refuses a prepare whose plugins volume is missing or differs).
 assert.match(fs.readFileSync(fileURLToPath(new URL('./auto-runtime.mjs',import.meta.url)),'utf8'),/action:'prepare'[^\n]*\n[^\n]*modelPlugins:modelPlugins\(\)\}\);/);
});
test('M3: a new ODC Studio whose assemblies no longer match the published bridge references waits, before tests, build and deploy',async t=>{
 const f=await fixture(t),s=serverOnlyRound(f);
 s.ops.odcBinary=async a=>{f.calls.push('odc references');return {reference:'1.7.29',gaps:['OutSystems.Model changed major version (13.0.0.0 -> 14.0.0.0)'],compared:[]};};
 const result=await roundOf(s);assert.equal(result.status,'deferred');
 assert.match(result.error,/client bridge update required: odc 1\.7\.30 runtime net10\.0 \(the published ODC bridge's Studio references do not resolve as in the served ODC Studio 1\.7\.29: OutSystems\.Model changed major version/);
 for(const step of ['test','image','smoke','publish','compose','deploy'])assert.ok(!f.calls.includes(step),step);
 assert.ok(fs.existsSync(path.join(f.dir,result.id,'odc-references.json')));
});
test('B3: an agent release the round cannot read waits with what to configure, never a failure',async t=>{
 for(const files of [async()=>{throw Error('Agent commit is outside the approved release line.');},async()=>({...agentFiles(),program:null})]){
  const f=await fixture(t),s=serverOnlyRound(f);f.base.agentReleaseFiles=files;
  const result=await roundOf(s);assert.equal(result.status,'deferred',JSON.stringify(result));
  assert.match(result.error,/The reviewed agent release cannot be read \(.*\)\. Server-only needs agentReleaseCommit/);
  const attempt=readJournal(path.join(f.dir,result.id,'attempt.json'));assert.equal(attempt.code,'agent-release-required');
  for(const step of ['bundle odc','test','image','publish'])assert.ok(!f.calls.includes(step),step);
 }
});
test('server-only round waits for a client bridge update when no published pack covers the new Studio runtime, and touches nothing',async t=>{
 const f=await fixture(t),s=serverOnlyRound(f,{tfm:'net11.0'});
 const result=await roundOf(s);assert.equal(result.status,'deferred');
 assert.match(result.error,/client bridge update required: odc 1\.7\.30 runtime net11\.0 \(no published agent pack declares a bridge for ODC Studios on net11/);
 assert.ok(s.notes.includes('SSAM: client bridge update required'),s.notes.join());
 for(const step of ['bundle odc','test','image','publish','lock','compose','deploy'])assert.ok(!f.calls.includes(step),step);
 const attempt=readJournal(path.join(f.dir,result.id,'attempt.json'));assert.deepEqual(attempt.deferredLanes,['odc']);assert.equal(attempt.code,'client-bridge-update-required');
});
// Review round 3, N2: the waits only the owner ends reach him as release events (webhook, VPS journal line, local notice),
// once for each new reason; a new reason the same day is a new notice, the same reason again is not a new event.
test('N2: client-bridge and agent-release waits send one release event per new reason, and a new reason is not silenced that day',async t=>{
 const f=await fixture(t),s=serverOnlyRound(f,{tfm:'net11.0'}),waits=[];s.ops.event=async(name,value)=>{waits.push({name,...value});return SENT;};
 const day=Date.parse('2026-11-08T12:00:00Z');s.config.clock=()=>day;
 assert.equal((await roundOf(s)).status,'deferred');
 assert.deepEqual(waits.filter(w=>w.name==='waiting').map(w=>w.code),['CLIENT_BRIDGE_UPDATE_REQUIRED']);
 const first=waits.find(w=>w.name==='waiting');assert.match(first.message,/client bridge update required: odc 1\.7\.30 runtime net11\.0/);assert.match(first.attempt,/^reason-[a-f0-9]{12}$/);
 // The same reason again: no second event, and the day's notice was given.
 const id='o11-11.55.94-odc-1.7.30';
 const notes=s.notes.filter(n=>n==='SSAM: client bridge update required').length;assert.equal(notes,1);
 s.config.observed=s.config.observed.map(o=>o.lane==='odc'?{...o,fullVersion:'1.7.30.10981'}:o);
 assert.equal((await roundOf(s)).status,'deferred');
 assert.equal(waits.filter(w=>w.name==='waiting').length,1,'the same reason is sent once');
 // Another reason of the same code the same day (the ODC Studio now on net12): a new event and a new notice.
 s.config.observed=s.config.observed.map(o=>o.lane==='odc'?{...o,fullVersion:'1.7.30.10982',tfm:'net12.0'}:o);
 assert.equal((await roundOf(s)).status,'deferred');
 const sent=waits.filter(w=>w.name==='waiting');assert.deepEqual(sent.map(w=>w.code),['CLIENT_BRIDGE_UPDATE_REQUIRED','CLIENT_BRIDGE_UPDATE_REQUIRED']);
 assert.match(sent[1].message,/runtime net12\.0/);assert.notEqual(sent[1].attempt,sent[0].attempt);
 assert.equal(s.notes.filter(n=>n==='SSAM: client bridge update required').length,2,s.notes.join());
 assert.equal(readJournal(path.join(f.dir,id,'attempt.json')).status,'deferred');
 // The reviewed agent release that cannot be read waits with its own code.
 const g=await fixture(t),r=serverOnlyRound(g),other=[];r.ops.event=async(name,value)=>{other.push({name,...value});return SENT;};g.base.agentReleaseFiles=async()=>({...agentFiles(),program:null});
 assert.equal((await roundOf(r)).status,'deferred');
 assert.deepEqual(other.filter(w=>w.name==='waiting').map(w=>w.code),['AGENT_RELEASE_REQUIRED']);assert.match(other.find(w=>w.name==='waiting').message,/reviewed agent release cannot be read/);
});
test('N2: the waiting event goes to the webhook, the VPS journal (bounded code) and the local notice',async t=>{
 const f=await fixture(t),posts=[],notes=[];
 const hook=await server(t,async(req,res)=>{let d='';for await(const b of req)d+=b;posts.push(JSON.parse(d));res.end('{}');});
 const runs=[],adapter=createAutoRuntime(f.config,{...f.base,notify:async(title,message)=>notes.push([title,message]),async run(cmd,args,o){if(!args.some(x=>String(x).endsWith('read-secrets.ps1'))&&o?.input)runs.push(JSON.parse(o.input));return f.base.run(cmd,args,o);}});
 const secrets={...(await adapter.secrets()),webhookUrl:hook};
 await adapter.event('waiting',{id:'o11-11.55.94-odc-1.7.30',attempt:'reason-0123456789ab',message:'o11-11.55.94-odc-1.7.30: client bridge update required: odc 1.7.30',code:'CLIENT_BRIDGE_UPDATE_REQUIRED'},secrets);
 assert.deepEqual(notes,[['SSAM: waiting','o11-11.55.94-odc-1.7.30: client bridge update required: odc 1.7.30']]);
 const line=runs.find(r=>r.action==='event');assert.deepEqual([line.event,line.id,line.code],['waiting','o11-11.55.94-odc-1.7.30','CLIENT_BRIDGE_UPDATE_REQUIRED']);
 assert.equal(posts.length,1);assert.equal(posts[0].event,'waiting');assert.equal(posts[0].code,'CLIENT_BRIDGE_UPDATE_REQUIRED');
 const {OWNER_WAITS}=await import('./pipeline.mjs');for(const code of Object.values(OWNER_WAITS))assert.match(code,/^[A-Z_]{1,40}$/);
});
// Review round 3, R3-B1: the adapter's receipt says which remote channel took the event (a local notice alone is none).
test('R3-B1: the event receipt is the VPS journal answer and a 2xx webhook; a failed notify, ssh or webhook is false, never a throw',async t=>{
 const f=await fixture(t);let status=200,remote='ok';
 const hook=await server(t,async(req,res)=>{for await(const _ of req);res.writeHead(status);res.end('{}');});
 const adapter=createAutoRuntime(f.config,{...f.base,notify:async()=>{throw Error('no toast');},async run(cmd,args,o){let r=null;try{r=JSON.parse(o?.input);}catch{}
  if(r?.action==='event'){if(remote==='throw')throw Error('ssh down');return {stdout:JSON.stringify(remote==='ok'?{ok:true}:{ok:false,code:'REMOTE_FAILED'})};}return f.base.run(cmd,args,o);}});
 const base=await adapter.secrets(),value={id:'pair',attempt:'reason-1',message:'m',code:'AGENT_RELEASE_REQUIRED'};
 const receipt=async(s)=>adapter.event('waiting',value,s);
 assert.deepEqual(await receipt({...base,webhookUrl:hook}),{remote:true,webhook:true});
 status=500;remote='failed';assert.deepEqual(await receipt({...base,webhookUrl:hook}),{remote:false,webhook:false});
 remote='throw';assert.deepEqual(await receipt(base),{remote:false,webhook:false});
 status=204;assert.deepEqual(await receipt({...base,webhookUrl:hook}),{remote:false,webhook:true});
});
// Review round 3, N4: the round verifies the owner's O11 proof against its file, records it in release.json and checks it.
test('N4: a verified O11 proof serves a Service Studio without its own build, is recorded in release.json and checked; free text waits',async t=>{
 const {o11Proofs}=await import('./server-only.mjs');
 // The proven build must be one a served Service Studio runs (here 11.55.93 of the live pair), built for the Studio's runtime.
 const pack={o11Builds:[{version:'11.55.94',runtime:'net10.0'},{version:'11.55.93',runtime:'net10.0'}]};
 const f=await fixture(t),s=serverOnlyRound(f,{pack}),root=path.join(f.dir,'proofs'),file=path.join(root,'attach-11.55.96.txt');fs.mkdirSync(root);fs.writeFileSync(file,'agent attached to Service Studio 11.55.96');
 s.config.observed=s.config.observed.map(o=>o.lane==='o11'?{...o,version:'11.55.96',fullVersion:'11.55.96.1'}:o);
 s.config.o11BridgeProven={'11.55.96':{studioVersion:'11.55.96',build:'11.55.93',packCommit:'c'.repeat(40),provenAt:'2026-11-08T10:00:00Z',evidence:file}};
 s.ops.o11Proofs=c=>o11Proofs(c,{root});s.ops.build=async()=>({...release(f.dir).built,odc:'1.7.30',o11:'11.55.96'});
 const result=await roundOf(s);assert.equal(result.status,'live',JSON.stringify(result));
 const id='o11-11.55.96-odc-1.7.30',recorded=readJournal(path.join(f.dir,id,'release.json')).bridges.o11Proofs['11.55.96'];
 assert.deepEqual({...recorded,sha256:recorded.sha256.length},{studioVersion:'11.55.96',build:'11.55.93',packCommit:'c'.repeat(40),provenAt:'2026-11-08T10:00:00Z',evidence:file,sha256:64,size:41});
 const check=s.runs.map(r=>{try{return JSON.parse(r.input);}catch{return null;}}).find(r=>r?.action==='check'&&!r.rollback);
 assert.match(check.checkSource,/"o11Proven":\{"11\.55\.96":"11\.55\.93"\}/);
 // The round-2 free-text form: no proof, the lane waits for the owner and says why.
 const g=await fixture(t),w=serverOnlyRound(g,{pack});w.config.observed=s.config.observed;w.ops.o11Proofs=c=>o11Proofs(c,{root});
 w.config.o11BridgeProven={'11.55.96':{build:'11.55.93',evidence:'live attach of agent 0.2.7 to Service Studio 11.55.96, 2026-11-08'}};
 const waited=await roundOf(w);assert.equal(waited.status,'deferred');
 assert.match(waited.error,/no thin bridge built for Service Studio 11\.55\.96 .*its o11BridgeProven entry is refused: /);
 for(const step of ['image','publish','deploy'])assert.ok(!g.calls.includes(step),step);
});
// Review round 3, N3: the remote's own codes reach the attempt, the events and the notice instead of REMOTE_FAILED.
const requestOf=o=>{try{return JSON.parse(o?.input);}catch{return null;}};
test('N3: plugins, receipt, hello and served-list codes of the remote keep their code; a post-deployment one rolls back with it',async t=>{
 const {REMOTE_WAITS,REMOTE_DEFECTS}=await import('./auto-runtime.mjs');
 const source=fs.readFileSync(fileURLToPath(new URL('./remote-release.py',import.meta.url)),'utf8');
 const raised=[...new Set([...source.matchAll(/RemoteError\('([A-Z_]+)'\)/g)].map(m=>m[1]))];
 for(const code of raised)assert.ok(REMOTE_WAITS.includes(code)||REMOTE_DEFECTS.includes(code),`${code} is not surfaced`);
 const f=await fixture(t),original=f.base.run;let answer=null;
 f.base.run=async(cmd,args,o)=>{if(answer&&requestOf(o)?.action==='check')return {stdout:JSON.stringify({ok:false,code:answer})};return original(cmd,args,o);};
 const s=await f.ops.secrets(),unlock=await f.ops.acquireReleaseLock(s);
 for(const code of [...REMOTE_DEFECTS.filter(c=>c!=='REMOTE_FAILED'),'NOT_WARM','something else']){
  answer=code;const e=await f.ops.checks(s,{id:'x',pinned:release(f.dir).manifest,kernel:{odc:'1.7.30',o11:'11.55.94'},bridges:{offers:[]}}).then(()=>null,x=>x);
  assert.equal(e?.code,code==='something else'?'REMOTE_FAILED':code,code);assert.equal(e.environmental,code==='NOT_WARM',code);
 }
 await unlock();
 // A deployment whose check finds a changed served list is rolled back; the event and the deployment journal carry the code.
 const g=await fixture(t),events=[],real=g.base.run;g.base.run=async(cmd,args,o)=>{if(requestOf(o)?.action==='check'&&!requestOf(o).rollback)return {stdout:JSON.stringify({ok:false,code:'SERVED_LIST_CHANGED'})};return real(cmd,args,o);};
 const ops={...g.ops,event:async(n,v)=>{events.push([n,v.code]);return SENT;}};
 const r=await releaseAutomatically(g.config,ops,release(g.dir));assert.equal(r.status,'rolled-back',JSON.stringify(r));assert.equal(r.cause,'SERVED_LIST_CHANGED');
 assert.deepEqual(events.find(([n])=>n==='failed'),['failed','SERVED_LIST_CHANGED']);
 assert.equal(readJournal(path.join(g.dir,'deployment.json')).failure.code,'SERVED_LIST_CHANGED');
});
test('server-only round defers a published pack the reviewed release does not attach, before any bundle',async t=>{
 const f=await fixture(t),s=serverOnlyRound(f,{pack:{odcBridge:'v110'}});
 const result=await roundOf(s);assert.equal(result.status,'deferred');
 assert.match(result.error,/client bridge update required: odc 1\.7\.30 runtime net10\.0 \(the reviewed agent release c{7} attaches v109 or v108 to an ODC Studio on net10\.0, not the declared v110\)/);
 assert.ok(!f.calls.includes('bundle odc')&&!f.calls.includes('publish'));
});
test('server-only round defers when the new pair refuses the published pack hello (agent without reconcile-merge), before tests and build',async t=>{
 const f=await fixture(t),s=serverOnlyRound(f,{edit:text=>text.replace(/['"]reconcile-merge['"],\s*/g,'')});
 const result=await roundOf(s);assert.equal(result.status,'deferred');
 assert.match(result.error,/client bridge update required: odc 1\.7\.30 runtime net10\.0 \(the published pack's hello is refused \(AGENT_PACK_MISMATCH/);
 for(const step of ['test','image','smoke','publish','compose','deploy'])assert.ok(!f.calls.includes(step),step);
});
test('a vault without an Authenticode thumbprint is accepted only in server-only; a malformed one never',async t=>{
 const f=await fixture(t),vault=extra=>({async run(cmd,args,o){if(args.some(x=>String(x).endsWith('read-secrets.ps1'))){const s=JSON.parse((await f.base.run(cmd,args,o)).stdout);delete s.authenticodeThumbprint;return {stdout:JSON.stringify({...s,...extra})};}return f.base.run(cmd,args,o);},executionSource:async()=>{},log:()=>{}});
 assert.ok((await createAutoRuntime(f.config,vault({})).secrets()).journalKey);
 await assert.rejects(createAutoRuntime({...f.config,bridgeMode:'signed-offers'},vault({})).secrets(),e=>e.code==='secrets-missing');
 await assert.rejects(createAutoRuntime(f.config,vault({authenticodeThumbprint:'not-a-thumbprint'})).secrets(),e=>e.code==='secrets-missing');
 for(const missing of ['manifestPrivateKey','journalKey'])await assert.rejects(createAutoRuntime(f.config,vault({[missing]:''})).secrets(),e=>e.code==='secrets-missing',missing);
 await assert.rejects(createAutoRuntime({...f.config,bridgeMode:'unsigned'},vault({})).secrets(),e=>e.code==='secrets-missing');
 // set-secrets.ps1: Enter leaves the thumbprint out; a value must be 40 hex; the Ed25519 and journal keys are always generated.
 const ps=fs.readFileSync(fileURLToPath(new URL('./set-secrets.ps1',import.meta.url)),'utf8');
 assert.match(ps,/-notin @\('webhookUrl','authenticodeThumbprint'\)/);assert.match(ps,/\^\[a-fA-F0-9\]\{40\}\$/);assert.match(ps,/\$values\.journalKey = /);assert.match(ps,/\$values\.manifestPrivateKey = /);
});
test('server-only never builds or signs a client bridge, even when asked',async t=>{
 const f=await fixture(t),runs=[];const adapter=createAutoRuntime(f.config,{...f.base,run:async(...a)=>{runs.push(a);return f.base.run(...a);}});
 await assert.rejects(adapter.buildBridges({odc:'1.7.30',o11:'11.55.94'},{},f.dir),/only in the signed-offers and ed25519-offers bridge modes/);assert.deepEqual(runs,[]);
});
// F1 (C:\t\r5\PLANO-AGENTE-AUTO.md 3.A): bridgeMode ed25519-offers. The round compiles the client bridges (here: a fake that
// writes a signed store like the real stage), gates the pair on the published pack's hello offered then installed, and checks
// after the deployment that the 0.2.8 hello receives the offer and the 0.2.7 one does not. Nothing is Authenticode-signed.
function offeredStore(lanes){
 return async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ed25519-stage-')),keys=generateKeyPairSync('ed25519'),offers=[];
  fs.writeFileSync(path.join(dir,'public-key.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
  for(const [lane,v,p,names] of [['odc','1.7.32','v109',['bridge/ODC3.Bridge.v109.dll','client/ODC3.Bridge.Client.dll']],['o11','11.55.95','d1',['bridge/Anvil.Bridge.dll','hook/Anvil.RuntimeHook.Agent.dll']]].filter(x=>lanes.includes(x[0]))){
   const sub=path.join(dir,lane,v,p),files=[];
   for(const name of names){const bytes=Buffer.from('fixture '+name);fs.mkdirSync(path.dirname(path.join(sub,name)),{recursive:true});fs.writeFileSync(path.join(sub,name),bytes);files.push({path:name,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,signer:'owner'});}
   const raw=Buffer.from(JSON.stringify({schema:1,lane,studioVersion:v,runtime:'net10.0',protocol:p,sequence:1,createdAt:new Date().toISOString(),files}));
   fs.writeFileSync(path.join(sub,'manifest.json'),raw);fs.writeFileSync(path.join(sub,'manifest.sig'),sign(null,raw,keys.privateKey));offers.push({lane,studioVersion:v,protocol:p,sequence:1});
  }
  return {stage:dir,mode:'ed25519-offers',offers,kernel:{ignored:true}};
 };
}
function offersRound(f,{lanes=['odc','o11']}={}){
 const s=serverOnlyRound(f);let offered=0;
 s.config={...s.config,bridgeMode:'ed25519-offers',observed:[{lane:'odc',version:'1.7.32',fullVersion:'1.7.32.11065',studio:'odc',tfm:'net10.0'},{lane:'o11',version:'11.55.95',fullVersion:'11.55.95.65352',studio:'o11',tfm:'net10.0'}]};
 const build=offeredStore(lanes);
 Object.assign(s.ops,{buildBridges:async(...a)=>{f.calls.push('bridges');const r=await build(...a);offered=r.offers.length;s.ops.stage=r.stage;return r;},
  build:async()=>{f.calls.push('image');return {...release(f.dir).built,odc:'1.7.32',o11:'11.55.95'};},
  smoke:async()=>{f.calls.push('smoke');s.ops.smoked={hello:s.ops.packHello,expect:s.ops.offerExpect};return {ok:true,publishedPack:!!s.ops.packHello,offersChecked:offered};}});
 return s;
}
const cleanStage=s=>{if(s.ops.stage)fs.rmSync(s.ops.stage,{recursive:true,force:true});};
test('ed25519-offers round: a Service Studio without a published thin bridge is offered the signed d1 bridge, gated before any test, checked after the deployment',async t=>{
 const f=await fixture(t),s=offersRound(f);t.after(()=>cleanStage(s));
 const result=await roundOf(s);assert.equal(result.status,'live',JSON.stringify(result));
 assert.ok(f.calls.indexOf('bridges')<f.calls.indexOf('test'),'the offers gate runs before any test');assert.ok(f.calls.indexOf('smoke')<f.calls.indexOf('publish'));
 assert.deepEqual(signingCalls(s.runs),[],'no Authenticode signing anywhere');
 assert.deepEqual(s.ops.bridgeKernel.o11BridgeAccepted,['d1']);assert.equal(s.ops.bridgeKernel.o11,'11.55.95');assert.ok(s.ops.bridgeKernel.odcBridgeAccepted.includes('v109')||s.ops.bridgeKernel.odcBridge==='v109');
 assert.deepEqual(s.ops.smoked.hello.bridges.map(b=>[b.lane,b.protocol,b.status]),[['o11','d1','installed']]);
 assert.equal(s.ops.smoked.expect.offerHello.capabilities.bridgeOffer,true);assert.equal(s.ops.smoked.expect.legacyHello.capabilities.bridgeOffer,false);assert.deepEqual(s.ops.smoked.expect.offerLanes,['o11']);
 const check=s.runs.map(r=>{try{return JSON.parse(r.input);}catch{return null;}}).find(r=>r?.action==='check'&&!r.rollback);
 assert.equal(check.requirePresented,true);
 const expected=JSON.parse(/^const expected=(.*);\n/.exec(check.checkSource)[1]),key='11.55.95|1.7.32';
 assert.deepEqual(expected.offerLanes,{[key]:['o11']});assert.equal(expected.offerHellos[key].capabilities.bridgeOffer,true);assert.equal(expected.legacyHellos[key].capabilities.bridgeOffer,false);
 assert.deepEqual(expected.packHellos[key].bridges.map(b=>b.protocol),['d1']);assert.deepEqual(expected.offers.map(o=>o.protocol),['v109','d1']);
 const saved=readJournal(path.join(f.dir,result.id,'release.json'));
 assert.equal(saved.bridgeMode,'ed25519-offers');assert.equal(saved.bridges.mode,'ed25519-offers');
 // This window serves 11.55.93 and 11.55.95 only: a 0.2.7 agent on 11.55.95 (its default 11.55.94 thin bridge) is refused there.
 assert.deepEqual(saved.bridges.legacy,{odc:{ok:true},o11:{ok:false,code:'AGENT_PACK_MISMATCH'}});assert.equal(saved.bridges.agentRelease,'c'.repeat(40));
});
test('ed25519-offers round: without a signed O11 offer the lane waits (client-bridge-update-required) and nothing is tested or deployed',async t=>{
 const f=await fixture(t),s=offersRound(f,{lanes:['odc']});t.after(()=>cleanStage(s));
 const result=await roundOf(s);assert.equal(result.status,'deferred',JSON.stringify(result));
 assert.match(result.error,/client bridge update required: o11 11\.55\.95 runtime net10\.0 \(the published pack's hello is refused \(AGENT_PACK_MISMATCH: The O11 bridge of the agent package was built for Service Studio 11\.55\.94.*\) and no signed offer reaches it\)/);
 assert.ok(s.notes.includes('SSAM: client bridge update required'),s.notes.join());
 for(const step of ['test','image','smoke','publish','compose','deploy'])assert.ok(!f.calls.includes(step),step);
 assert.equal(readJournal(path.join(f.dir,result.id,'attempt.json')).code,'client-bridge-update-required');
});
test('ed25519-offers round (R7): an agent release without the owner signature waits before any bridge is built',async t=>{
 const f=await fixture(t),s=offersRound(f);
 f.base.agentReleaseFiles=async()=>{throw Object.assign(Error('agentReleaseCommit ccccccc has no valid owner signature; sign the reviewed agent release commit.'),{code:'AGENT_RELEASE_UNSIGNED'});};
 const result=await roundOf(s);assert.equal(result.status,'deferred',JSON.stringify(result));
 assert.match(result.error,/The reviewed agent release cannot be read \(agentReleaseCommit ccccccc has no valid owner signature/);
 assert.equal(readJournal(path.join(f.dir,result.id,'attempt.json')).code,'agent-release-required');
 for(const step of ['bridges','bundle odc','test','image','publish'])assert.ok(!f.calls.includes(step),step);
});
test('ed25519-offers round: an image smoke that did not offer every signed bridge deploys nothing',async t=>{
 const f=await fixture(t),s=offersRound(f),smoke=s.ops.smoke;t.after(()=>cleanStage(s));s.ops.smoke=async(...a)=>({...(await smoke(...a)),offersChecked:1});
 const result=await roundOf(s);assert.equal(result.status,'failed',JSON.stringify(result));assert.match(result.error,/did not offer and deliver every signed bridge/);
 for(const step of ['publish','compose','deploy'])assert.ok(!f.calls.includes(step),step);
});
