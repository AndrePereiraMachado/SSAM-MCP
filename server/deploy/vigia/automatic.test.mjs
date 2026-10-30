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
  event:async(name)=>notices.push(name)
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
 const config={...f.config,automatic:true,outDir:f.dir,head:'source-head',manifest:{window:3,odc:[{version:'1.7.29',image:'private/image',tag:'prod-old',sha256:digest}],o11:[{version:'11.55.93',image:'private/image',tag:'prod-old',sha256:digest}]},observed:[{lane:'odc',version:'1.7.30',fullVersion:'1.7.30.10980',studio:'odc',tfm:'net10.0'},{lane:'o11',version:'11.55.94',fullVersion:'11.55.94.65328',studio:'o11',tfm:'net10.0'}]};
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
  if(args.includes('-getProperty:TargetFramework'))return {stdout:'net10.0'};
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
 const adapter=createAutoRuntime({...f.config,workspace:fakeRoot},runtime);
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
