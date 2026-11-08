// R0-R14 regressions. VIGIA_REVIEW_ROOT selects the unmodified review base.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';import {generateKeyPairSync,sign,createHash} from 'node:crypto';
const server=process.env.VIGIA_REVIEW_ROOT??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const mod=p=>import(pathToFileURL(path.join(server,p)).href);
const safety=await mod('deploy/vigia/safety.mjs').catch(()=>({}));
const {round}=await mod('deploy/vigia/vigia.mjs');
const {decide}=await mod('deploy/vigia/pipeline.mjs');
const {rotateWindow}=await mod('deploy/vigia/window.mjs');
const {generateCompose}=await mod('deploy/coolify/gen-compose.mjs');
const {releaseAutomatically,releaseEvent}=await mod('deploy/vigia/automatic.mjs');
const {compatibility,bridgeReports}=await mod('platforms/odc/facade/agent-hub.mjs');
const {createBridgeStore}=await mod('platforms/odc/facade/bridge-store.mjs');
const {officialUrl}=await mod('deploy/vigia/sources.mjs');
const file=p=>fs.readFileSync(path.join(server,p),'utf8').replace(/\r\n/g,'\n');
const tmp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'review-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
const SENT=Object.freeze({remote:true,webhook:false});
const sha='a'.repeat(64),entry=(version,tag)=>({version,tag,image:'registry/image',sha256:sha});
const baseline={window:3,odc:[entry('1.7.30','prod-live')],o11:[entry('11.55.94','prod-live')]};
const kernel={odc:'1.7.30',o11:'11.55.94',odcBridge:'v100'};
// The watcher's own next manifest (rotateWindow): the retained pair carries the served list it runs with.
const grown=()=>rotateWindow(baseline,{odc:'1.7.31',o11:'11.55.95',image:'registry/image',tag:'new',sha256:sha}).manifest;
const live=()=>({compose:JSON.stringify(generateCompose(baseline)),backends:[{...kernel,reference:'registry/image:prod-live',digest:'sha256:'+sha,image:'running-id',kernel,budget:{tools:90,totalBytes:500,core:[]}}]});
function transaction(t,failAt){
 const dir=tmp(t),calls=[],events=[];
 const r={id:'o11-11.55.95-odc-1.7.31',dir,attempt:'attempt-1',built:{image:'registry/image',tag:'prod-new',sha256:sha,odc:'1.7.31',o11:'11.55.95'},kernel:{odc:'1.7.31',o11:'11.55.95'},manifest:{window:3,odc:[entry('1.7.31','prod-new'),...baseline.odc],o11:[entry('11.55.95','prod-new'),...baseline.o11]},bridges:{offers:[]},features:'private'};
 let rereads=0;
 const ops={secrets:async()=>({}),pause:async()=>{},deploymentBudget:async()=>{},liveBaseline:async()=>({manifest:baseline,file:'protected',hash:'hash'}),verifyLocalImage:async()=>{},publish:async()=>({digest:'sha256:'+sha,rawSecret:'never-journal'}),pinExecution:async()=> 'pin',
  acquireReleaseLock:async()=>{calls.push('lock');return async()=>calls.push('unlock');},beginDeployment:()=>calls.push('protected'),endDeployment:()=>calls.push('unprotected'),
  preflightRemote:async()=>calls.push('memory'),assertLiveUnchanged:async()=>{calls.push('reread');rereads++;if(failAt===`reread${rereads}`)throw Object.assign(Error('changed'),{code:'LIVE_CHANGED',environmental:true});},
  backup:async()=>{calls.push('backup');return {ok:true};},composeFor:async()=> '{}',prepare:async()=>{calls.push('prepare');if(failAt==='prepare')throw Error('prepare');},
  writeCompose:async()=>{calls.push('PATCH');return {rawSecret:'never-journal'};},deploy:async()=>{calls.push('deploy');return {rawSecret:'never-journal'};},checks:async()=>({ok:true}),restoreCompose:async()=>calls.push('restore'),event:async(n,v)=>{events.push([n,v]);return SENT;}};
 return {dir,calls,events,ops,r};
}
test('R0 production baseline is the R1 window of three or more pairs, each with its kernel, and the newer O11 bridge policy',()=>{
 // The window grew from three pairs (R1) to four (r43b, ODC 1.7.31 appended) and may hold five: what stays true is that every
 // served pair is a pair of both lanes and has its kernel.json entry.
 const versions=JSON.parse(file('deploy/coolify/versions.json'));
 assert.ok(versions.odc.length>=3&&versions.odc.length===versions.o11.length&&versions.odc.length<=versions.window);
 if(fs.existsSync(path.join(server,'deploy/coolify/r1-kernels.json'))){
  const kernels=Object.values(JSON.parse(file('deploy/coolify/r1-kernels.json')));
  for(const odc of versions.odc){const o11=versions.o11.find(o=>o.tag===odc.tag)?.version;assert.ok(kernels.some(k=>k.odc===odc.version&&k.o11===o11),`no kernel for ${odc.version}/${o11}`);}
 }
 assert.match(file('platforms/odc/facade/agent-hub.mjs'),/newerLocalBridge/);
});
test('R1 live kernels, tags and digests define the baseline and inconsistency fails closed',()=>{
 const s=live(),b=safety.liveBaseline(s);assert.deepEqual(b.manifest.odc,baseline.odc.map(e=>({...e,served:{odc:['1.7.30'],o11:['11.55.94']}})));
 s.backends[0].reference='registry/image:older';assert.throws(()=>safety.liveBaseline(s));
});
test('R1 already live pair is idle even when the checkout lists an older pair',async t=>{
 const dir=tmp(t),old={window:3,odc:[entry('1.7.29','old')],o11:[entry('11.55.93','old')]};
 const result=await round({automatic:true,outDir:dir},{secrets:async()=>({}),executionSource:async()=>{},cleanupSsh:async()=>{},pause:async()=>{},liveBaseline:async()=>({manifest:baseline}),manifest:()=>old,detect:async()=>[{lane:'odc',version:'1.7.30',fullVersion:'1.7.30.1',tfm:'net10.0'}],observe:async x=>x,head:async()=> 'head'});
 assert.equal(result.status,'idle');
});
for(const at of ['reread1','reread2'])test(`R1 ${at}: changing live compose stops before PATCH without rollback`,async t=>{
 const f=transaction(t,at);const r=await releaseAutomatically({},f.ops,f.r);assert.equal(r.status,'deferred');assert.ok(!f.calls.includes('PATCH'));assert.ok(!f.calls.includes('restore'));
 if(at==='reread1')assert.ok(!f.calls.includes('backup'));
});
test('R1 retained digests are never downgraded and live custom settings survive',()=>{
 const b={manifest:baseline},bad=structuredClone(baseline);bad.odc[0].sha256='b'.repeat(64);assert.throws(()=>safety.assertRetained(b,bad));
 const s=live(),c=JSON.parse(s.compose);c.services['ssam-server-v1'].environment.CUSTOM='retain';s.compose=JSON.stringify(c);
 assert.equal(JSON.parse(safety.preserveCompose(s,baseline)).services['ssam-server-v1'].environment.CUSTOM,'retain');
});
test('R2 shared lease encloses backup through checks and is always released',async t=>{
 const f=transaction(t);await releaseAutomatically({},f.ops,f.r);assert.ok(f.calls.indexOf('lock')<f.calls.indexOf('backup'));assert.ok(f.calls.indexOf('unlock')>f.calls.indexOf('deploy'));
 assert.match(file('deploy/vigia/with-release-lock.sh'),/flock -x.*\/var\/lock\/ssam-release.lock/);
});
test('R2 PAUSE blocks before deployment',t=>{const d=tmp(t),p=path.join(d,'PAUSE');fs.writeFileSync(p,'');assert.throws(()=>safety.assertPause(p),e=>e.code==='PAUSED');});
test('R3 generated O11 policy keeps old dev agents and uses d1 only for downloaded bridges',()=>{
 const source=file('deploy/vigia/auto-runtime.mjs');assert.doesNotMatch(source,/o11Hook:'h1'/);assert.match(source,/o11BridgeAccepted:\['d1'\]/);
 const hello={pack:{lanes:['odc','o11'],odcBridge:'v100',o11BuiltFor:'11.55.94',o11Hook:'dev'},studios:{odc:{installed:{version:'1.7.30'}},o11:{installed:{version:'11.55.94'}}}};
 assert.equal(compatibility(hello,{...kernel,o11BridgeAccepted:['d1']},['odc','o11']).o11.ok,true);
});
test('R4 notifications are per attempt and rollback-failed is never deduplicated',async t=>{
 const d=tmp(t),events=[],ops={event:async n=>{events.push(n);return SENT;}};
 for(const at of ['one','one','two'])await releaseEvent(d,ops,'failed','pair','failed',{},at);
 for(let i=0;i<2;i++)await releaseEvent(d,ops,'rollback-failed','pair','failed',{},'two');
 assert.deepEqual(events,['failed','failed','rollback-failed','rollback-failed']);
});
test('R5 a rolled-back pair ignores a pin-only head change; only Retry or new Studio build unlocks it',()=>{
 const observed=[{lane:'odc',version:'1.7.31',fullVersion:'1.7.31.1',tfm:'net10.0'}],pair={odc:'1.7.31',o11:'11.55.94',lanes:['odc']},id='o11-11.55.94-odc-1.7.31';
 const attempt={id,pair,status:'failed',rollbackLatch:true,at:'2026-01-01',inputs:{head:'before-pin',studios:{odc:'1.7.31.1'}}};
 const options={manifest:baseline,observed,attempts:{[id]:attempt},inputs:()=>({head:'after-pin',studios:{odc:'1.7.31.1'}})};
 assert.equal(decide(options).action,'failed');attempt.retry=true;assert.equal(decide(options).action,'run');delete attempt.retry;options.inputs=()=>({head:'after-pin',studios:{odc:'1.7.31.2'}});assert.equal(decide(options).action,'run');
});
test('R6 preparation failure does not restart or restore live production',async t=>{
 const f=transaction(t,'prepare');await releaseAutomatically({},f.ops,f.r);assert.ok(!f.calls.includes('deploy'));assert.ok(!f.calls.includes('restore'));assert.ok(f.calls.includes('unlock'));
});
test('R7 memory floor scales with proposed backends (3072 MiB for three)',()=>{assert.equal(safety.memoryFloor(3),3072);assert.throws(()=>safety.assertMemory(3071,3));assert.throws(()=>safety.assertMemory(3072,4));});
test('R8 deployment needs the full deadline reserve and SSH cleanup is scoped',t=>{
 assert.throws(()=>safety.assertTime(1000,1,0));safety.assertTime(60000,1,0);
 const d=tmp(t),own=path.join(d,'ssh-12345678-1234-1234-1234-123456789abc');fs.mkdirSync(own);fs.writeFileSync(path.join(own,'identity'),'fake');fs.mkdirSync(path.join(d,'unrelated'));safety.cleanupSsh(d);assert.ok(!fs.existsSync(own));assert.ok(fs.existsSync(path.join(d,'unrelated')));
 assert.match(file('deploy/vigia/auto-runtime.mjs'),/evenWhenStopping:true/);assert.match(file('deploy/vigia/vigia.mjs'),/if\(runtime.deploymentActive\)/);
});
test('R9 rollback verifies snapshot budgets rather than the release budget',()=>{const s=file('deploy/vigia/auto-runtime.mjs');assert.match(s,/budget:b.budget/);assert.match(s,/kernel:b.kernel/);assert.match(file('deploy/vigia/check-backend.mjs'),/!expected.capture/);});
test('R10 a recent client retains the oldest pair and extends the window',()=>{
 const old={window:1,odc:[entry('1.7.30','prod-live')],o11:[entry('11.55.94','prod-live')]};
 const result=rotateWindow(old,{odc:'1.7.31',o11:'11.55.95',image:'registry/image',tag:'new'},{tokens:{customer:{seen:new Date().toISOString(),odc:{installed:'1.7.30'},o11:{installed:'11.55.94'}}}});
 assert.equal(result.manifest.odc.length,2);assert.equal(result.manifest.window,2);assert.ok(result.held.length);
});
test('R11 signing cannot run from a development checkout or a head ahead of main',()=>{assert.equal(typeof safety.executionSource,'function');assert.throws(()=>safety.executionSource({workspace:'C:/work/vigia-auto',branch:'server/vigia-auto',head:'a',main:'a'}));assert.throws(()=>safety.executionSource({workspace:'C:/work/vigia-run',branch:'server/vigia-run',head:'b',main:'a'}));});
test('R11 vault has entropy and refuses virtualized LOCALAPPDATA before prompting',()=>{assert.match(file('deploy/vigia/vault.ps1'),/Get-VigiaEntropy/);const s=file('deploy/vigia/set-secrets.ps1');assert.ok(s.indexOf('Assert-VigiaNormalProfile')<s.indexOf('Read-Host'));});
test('R12 installer host allowlist is exact and publisher requires a valid signature',()=>{assert.throws(()=>officialUrl('https://rogue.outsystems.com/x'));assert.match(file('deploy/vigia/authenticode-chain.ps1'),/Status -ne 'Valid'/);});
test('R13 dependencies are not re-signed and runtime selection is not overridden',()=>{assert.doesNotMatch(file('deploy/vigia/auto-runtime.mjs'),/-p:OdcBridgeRuntime=/);assert.match(file('scripts/odc-runtime-signing.ps1'),/if \(\$own\)/);assert.match(file('deploy/vigia/runtime.mjs'),/agentReleaseCommit/);});
test('R13 raw API responses are excluded from the deployment journal',async t=>{const f=transaction(t);await releaseAutomatically({},f.ops,f.r);assert.ok(!fs.readFileSync(path.join(f.dir,'deployment.json'),'utf8').includes('never-journal'));});
test('R13 remote features have unconditional cleanup and backups have five-item retention',()=>{const s=file('deploy/vigia/remote-release.py');assert.match(s,/finally:\n\s+features.unlink/);assert.match(s,/complete\[5:\]/);assert.match(s,/disk_usage/);});
test('R14 unsigned-sequence manifests are refused, and failed identity is suppressed until a higher sequence',t=>{
 const root=tmp(t),dir=path.join(root,'odc','1.7.30','v100');fs.mkdirSync(path.join(dir,'bridge'),{recursive:true});const bytes=Buffer.from('fake');fs.writeFileSync(path.join(dir,'bridge','x.dll'),bytes);const keys=generateKeyPairSync('ed25519');
 const m={schema:1,lane:'odc',studioVersion:'1.7.30',protocol:'v100',runtime:'net10.0',authenticodeThumbprint:'b'.repeat(40),files:[{path:'bridge/x.dll',signer:'owner',size:4,sha256:createHash('sha256').update(bytes).digest('hex')}]};
 const write=()=>{const b=Buffer.from(JSON.stringify(m));fs.writeFileSync(path.join(dir,'manifest.json'),b);fs.writeFileSync(path.join(dir,'manifest.sig'),sign(null,b,keys.privateKey));};
 write();const store=createBridgeStore({root,publicKey:keys.publicKey});assert.equal(store.offer('odc','1.7.30',['v100']),null);m.sequence=1;write();
 const report={lane:'odc',studioVersion:'1.7.30',protocol:'v100',sequence:1,status:'failed'};assert.equal(store.offer('odc','1.7.30',['v100'],[report]),null);m.sequence=2;write();assert.ok(store.offer('odc','1.7.30',['v100'],[report]));
});
test('R14 hello bridge report is retained without arbitrary reason text',()=>{const r=bridgeReports([{lane:'odc',studioVersion:'1.7.30',protocol:'v100',sequence:2,status:'failed',reason:'LOAD_FAILED'}]);assert.equal(r[0].sequence,2);assert.match(file('platforms/odc/facade/studio-version-state.mjs'),/bridges:state.hello/);});
test('R14 file route uses the signed storage identity, not the backend kernel version',()=>{const s=file('platforms/odc/facade/agent-hub.mjs').split("if (segments[2] === 'bridges')")[1].split("const state = stateOf")[0];assert.ok(!s.includes('serverKernel[lane] !== studioVersion'));});

// Round 3: these cases are also executed against the immutable bd9513b export.
test('R3-1 an execution worktree is refused even at the reviewed head',()=>{
 assert.throws(()=>safety.executionSource({workspace:'C:/private/vigia-run',branch:'server/vigia-run',head:'x',main:'x',gitDirectory:false}));
 assert.match(file('deploy/vigia/execution-trust.ps1'),/GetOwner/);
 assert.match(file('deploy/vigia/runtime.mjs'),/core.hooksPath=/);
});
test('R3-1 authenticated journals reject edits and cross-attempt replay',async t=>{
 const j=await mod('deploy/vigia/journal.mjs').catch(()=>({}));assert.equal(typeof j.configureJournals,'function');
 const dir=tmp(t),a=path.join(dir,'one','release.json'),b=path.join(dir,'two','release.json');j.configureJournals(dir,Buffer.alloc(32,3).toString('base64'));
 j.writeJournal(a,{id:'one'});assert.equal(j.readJournal(a).id,'one');fs.mkdirSync(path.dirname(b));fs.copyFileSync(a,b);assert.throws(()=>j.readJournal(b));
 const raw=JSON.parse(fs.readFileSync(a));raw.value.id='tampered';fs.writeFileSync(a,JSON.stringify(raw));assert.throws(()=>j.readJournal(a));
});
const window3=()=>({window:3,odc:['1.7.30','1.7.29','1.7.28'].map(v=>entry(v,'t'+v)),o11:['11.55.94','11.55.93','11.55.92'].map((v,i)=>entry(v,'t'+['1.7.30','1.7.29','1.7.28'][i]))});
test('R3-2 synthetic and revoked tokens cannot extend the three-pair window',()=>{
 const tokens={synthetic:{customer:'Version verification',seen:new Date().toISOString(),odc:{installed:'1.7.28'}},revoked:{revokedAt:'today',seen:new Date().toISOString(),o11:{installed:'11.55.92'}}};
 const r=rotateWindow(window3(),{odc:'1.7.31',o11:'11.55.95',image:'registry/image',tag:'new'},{tokens});assert.equal(r.manifest.window,3);
});
test('R3-2 maximum window defers rather than evicting active customers',()=>{
 const old=window3();const grown=rotateWindow(old,{odc:'1.7.31',o11:'11.55.95',image:'registry/image',tag:'new'},{tokens:{a:{seen:new Date().toISOString(),odc:{installed:'1.7.28'}}}}).manifest;
 const tokens=Object.fromEntries(grown.odc.map((e,i)=>['a'+i,{seen:new Date().toISOString(),odc:{installed:e.version}}]));
 assert.throws(()=>rotateWindow(grown,{odc:'1.7.32',o11:'11.55.96',image:'registry/image',tag:'new2'},{tokens}),e=>e.code==='WINDOW_LIMIT');
});
function signedStore(t){
 const root=tmp(t),dir=path.join(root,'o11','11.55.94','d1');fs.mkdirSync(path.join(dir,'bridge'),{recursive:true});const b=Buffer.from('synthetic');fs.writeFileSync(path.join(dir,'bridge/x.dll'),b);const keys=generateKeyPairSync('ed25519');
 const m={schema:1,lane:'o11',studioVersion:'11.55.94',protocol:'d1',sequence:1,runtime:'net10.0',authenticodeThumbprint:'a'.repeat(40),files:[{path:'bridge/x.dll',signer:'owner',size:b.length,sha256:createHash('sha256').update(b).digest('hex')}]};
 const write=()=>{const raw=Buffer.from(JSON.stringify(m));fs.writeFileSync(path.join(dir,'manifest.json'),raw);fs.writeFileSync(path.join(dir,'manifest.sig'),sign(null,raw,keys.privateKey));};write();return {root,dir,m,write,store:createBridgeStore({root,publicKey:keys.publicKey})};
}
test('R3-3 O11 stays usable while a bridge is offered or refused',t=>{
 const f=signedStore(t),hello={pack:{lanes:['odc','o11'],odcBridge:'v100',o11BuiltFor:'11.55.93',o11Hook:'dev'},studios:{odc:{installed:{version:'1.7.30'}},o11:{installed:{version:'11.55.94'}}},capabilities:{bridgeOffer:true}};
 const k={...kernel,odcBridgeAccepted:['v100'],o11BridgeAccepted:['d1'],servedVersions:{odc:['1.7.30'],o11:['11.55.94','11.55.93']}};
 let r=compatibility(hello,k,['odc','o11'],{bridges:f.store});assert.equal(r.o11.ok,true);assert.ok(r.o11.bridgeOffer);
 hello.bridges=bridgeReports([{lane:'o11',studioVersion:'11.55.94',protocol:'d1',sequence:1,status:'refused',reason:'AUTHENTICODE'}]);assert.equal(hello.bridges.length,1);
 r=compatibility(hello,k,['odc','o11'],{bridges:f.store});assert.equal(r.o11.ok,true);assert.equal(r.o11.bridgeOffer,undefined);
});
test('R3-3 unchanged bridge bytes are verified once while changes invalidate cache',t=>{
 const f=signedStore(t),original=fs.readFileSync;let reads=0;fs.readFileSync=function(p,...args){if(String(p).endsWith('x.dll'))reads++;return original.call(this,p,...args);};
 try{assert.ok(f.store.offer('o11','11.55.94',['d1']));assert.ok(f.store.offer('o11','11.55.94',['d1']));assert.equal(reads,1);fs.appendFileSync(path.join(f.dir,'bridge/x.dll'),'x');assert.equal(f.store.offer('o11','11.55.94',['d1']),null);}finally{fs.readFileSync=original;}
});
test('R3-4 PAUSE after publishing resumes published digest and pin without rebuilding',async t=>{
 const f=transaction(t);let pauses=0,published=0,pins=0;
 f.ops.pause=async()=>{if(++pauses===2)throw Object.assign(Error('paused'),{code:'PAUSED',environmental:true});};
 f.ops.publish=async()=>{published++;return {digest:'sha256:'+sha};};f.ops.pinExecution=async()=>{pins++;return 'pin';};
 assert.equal((await releaseAutomatically({},f.ops,f.r)).status,'deferred');assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'deployment.json'))).status,'deferred');
 assert.equal((await releaseAutomatically({},f.ops,f.r)).status,'live');assert.equal(published,1);assert.equal(pins,1);
 assert.match(file('deploy/vigia/runtime.mjs'),/randomUUID\(\).*slice\(0,12\)/);
});
test('R3-5 lost lease is reacquired before rollback and verification',async t=>{
 const f=transaction(t);let locked=true,reacquired=false;f.ops.deploy=async()=>{if(!reacquired){locked=false;throw Error('lease lost');}};
 f.ops.ensureReleaseLock=async()=>{locked=true;reacquired=true;f.calls.push('relock');return async()=>{};};
 f.ops.restoreCompose=async()=>{assert.ok(locked);assert.ok(reacquired);f.calls.push('restore');};
 assert.equal((await releaseAutomatically({},f.ops,f.r)).status,'rolled-back');assert.ok(f.calls.indexOf('relock')<f.calls.indexOf('restore'));
 assert.match(file('deploy/vigia/auto-runtime.mjs'),/ServerAliveInterval=15/);assert.match(file('deploy/vigia/remote-release.py'),/assert_fence/);
});
test('R3-6 Retry cannot bypass an unacknowledged rollback failure',async t=>{
 const {retry}=await mod('deploy/vigia/approve.mjs'),dir=tmp(t),id='o11-11.55.94-odc-1.7.30',folder=path.join(dir,id);fs.mkdirSync(folder);
 fs.writeFileSync(path.join(folder,'attempt.json'),JSON.stringify({id,status:'failed',pair:{lanes:['odc'],odc:'1.7.30'},at:'now'}));fs.writeFileSync(path.join(folder,'deployment.json'),JSON.stringify({status:'rollback-failed'}));
 assert.throws(()=>retry({outDir:dir},id),/AcknowledgeRollback/);assert.equal(retry({outDir:dir,acknowledgeRollback:id},id).status,'retry');
});
test('R3-7 a new backend inherits only allowed configuration and generated volumes',()=>{
 const s=live(),c=JSON.parse(s.compose),old=c.services['ssam-server-v1'];old.volumes.push({type:'bind',source:'/secret',target:'/secret'});old.privileged=true;old.environment.CUSTOM='keep';s.compose=JSON.stringify(c);
 const m=grown();const next=JSON.parse(safety.preserveCompose(s,m));
 const added=Object.values(next.services).find(v=>v.labels?.['ssam.odc']==='1.7.31');assert.equal(added.privileged,undefined);assert.ok(!added.volumes.some(v=>v.type==='bind'));assert.equal(added.environment.CUSTOM,'keep');
});
// Review round 2, A2 (probe C:\t\r5\rev-vigia-so\probe-plugins.mjs): every backend, new or retained, mounts the reviewed
// read-only ODC model plugins volume exactly once.
const PLUG='/tmp/.local/share/OutSystems/ODC Studio/Plugins';
const pluginMounts=s=>s.volumes.filter(v=>(typeof v==='string'?v.split(':')[1]:v.target)===PLUG);
const backendsOf=c=>Object.entries(c.services).filter(([,s])=>s.labels?.['ssam.backend']==='true');
test('R3-7b A2: the new backend gets the reviewed plugins mount; a retained one without it gets it; anything else there stops',()=>{
 const pins=JSON.parse(file('deploy/coolify/model-plugins.json'));assert.equal(pins.volume,'odc-model-plugins');assert.equal(pins.target,PLUG);
 assert.deepEqual(pins.files.map(f=>[f.name,f.sha256.slice(0,8)]),[['MobileUI-1.4.0.0.xif','b49d698a'],['MobileUI-1.5.0.0.xif','fca14051']]);
 const m=grown();
 // A live compose deployed before the mount (the probe's case without its bind): every backend ends with exactly one, read-only.
 const s=live(),c=JSON.parse(s.compose);for(const [,b] of backendsOf(c))b.volumes=b.volumes.filter(v=>v.target!==PLUG);delete c.volumes['odc-model-plugins'];s.compose=JSON.stringify(c);
 const next=JSON.parse(safety.preserveCompose(s,m));assert.equal(backendsOf(next).length,2);
 for(const [name,b] of backendsOf(next)){const at=pluginMounts(b);assert.equal(at.length,1,name);assert.deepEqual(at[0],{source:'odc-model-plugins',target:PLUG,read_only:true,type:'volume',volume:{}},name);}
 assert.deepEqual(next.volumes['odc-model-plugins'],{});
 // The probe's hand-added bind on the live backends: never inherited, never silently replaced.
 const b=live(),bc=JSON.parse(b.compose);for(const [,x] of backendsOf(bc)){x.volumes=x.volumes.filter(v=>v.target!==PLUG);x.volumes.push({type:'bind',source:'/srv/ssam/odc-plugins',target:PLUG,read_only:true});}b.compose=JSON.stringify(bc);
 assert.throws(()=>safety.preserveCompose(b,m),e=>e.code==='MODEL_PLUGINS_CONFLICT');
 // A writable mount of the volume, or the mount twice (a bad merge of r44's gen-compose push over this template), stops too.
 const rw=live(),rc=JSON.parse(rw.compose);pluginMounts(backendsOf(rc)[0][1])[0].read_only=false;rw.compose=JSON.stringify(rc);
 assert.throws(()=>safety.preserveCompose(rw,m),e=>e.code==='MODEL_PLUGINS_CONFLICT');
 const twice=generateCompose(m);for(const [,x] of backendsOf(twice))x.volumes.push(structuredClone(pluginMounts(x)[0]));
 assert.throws(()=>safety.assertModelPlugins(twice),e=>e.code==='MODEL_PLUGINS_MOUNT');
 assert.doesNotThrow(()=>safety.assertModelPlugins(generateCompose(m)));
});
// Review round 3, N1 (probe C:\t\r5\rev-vigia-so\probe-keepserved.mjs): the r44 window (keepServed 4) recomposed by the
// watcher for the next pair. Each retained backend keeps the served list it was deployed with; the new one serves the whole
// new window; nothing reads keepServed after the rotation.
const servedBy=c=>Object.fromEntries(backendsOf(c).map(([,s])=>[s.labels['ssam.odc']+'/'+s.labels['ssam.o11'],s.environment.SSAM_SERVED_VERSIONS]));
const snapshotOf=compose=>({compose:JSON.stringify(compose),backends:backendsOf(compose).map(([,s])=>({odc:s.labels['ssam.odc'],o11:s.labels['ssam.o11'],reference:s.image,digest:'sha256:'+(s.labels['ssam.image.digest']?.replace(/^sha256:/,'')??sha),image:'id',kernel:{odc:s.labels['ssam.odc'],o11:s.labels['ssam.o11']}}))});
const nextPair=v=>({odc:'1.7.33',o11:'11.55.96',image:v.odc[0].image,tag:'prod-next',sha256:'c'.repeat(64)});
test('N1 the next pair leaves every retained backend\'s served list as deployed, from versions.json or from the live baseline',()=>{
 const v=JSON.parse(file('deploy/coolify/versions.json').replace(/^\uFEFF/,''));assert.ok(v.keepServed>0,'the pinned window uses keepServed');
 const live=generateCompose(v),before=servedBy(live);
 // The r44 meaning, as deployed: the first keepServed backends share the list of the first keepServed pairs; the rest the window.
 const lists=Object.values(before);assert.equal(new Set(lists.slice(0,v.keepServed)).size,1);assert.notEqual(lists[0],lists.at(-1));
 for(const source of [v,safety.liveBaseline(snapshotOf(live)).manifest]){
  const r=rotateWindow(source,nextPair(v),{maxWindow:6});
  assert.equal(r.manifest.keepServed,undefined);
  const next=JSON.parse(safety.preserveCompose(snapshotOf(live),r.manifest)),after=servedBy(next);
  const retained=Object.keys(after).filter(k=>k in before);assert.ok(retained.length>=4,retained.join());
  for(const k of retained)assert.equal(after[k],before[k],k);
  const fresh=JSON.parse(after['1.7.33/11.55.96']),pairs=Object.keys(after).map(k=>k.split('/'));
  assert.deepEqual([...fresh.odc].sort(),[...new Set(pairs.map(p=>p[0]))].sort());assert.deepEqual([...fresh.o11].sort(),[...new Set(pairs.map(p=>p[1]))].sort());
  // The frozen lists ride the pinned versions.json: regenerating it gives the same lists, and a second rotation keeps them.
  assert.deepEqual(servedBy(generateCompose(JSON.parse(JSON.stringify(r.manifest)))),after);
  const again=rotateWindow(r.manifest,{...nextPair(v),odc:'1.7.34',o11:'11.55.97',tag:'prod-after'},{maxWindow:7});
  const third=servedBy(JSON.parse(safety.preserveCompose({compose:JSON.stringify(next)},again.manifest)));
  for(const k of Object.keys(third).filter(k=>k in after))assert.equal(third[k],after[k],k);
 }
});
test('N1 a manifest that would change a retained backend\'s served list stops before anything is written',()=>{
 const v=JSON.parse(file('deploy/coolify/versions.json').replace(/^\uFEFF/,'')),live=generateCompose(v);
 // keepServed dropped (what the watcher did before this fix): the retained backends would learn the newer O11.
 const naive={...structuredClone(v),window:6,odc:[{...v.odc[0],...nextPair(v),version:'1.7.33'},...v.odc],o11:[{...v.o11[0],...nextPair(v),version:'11.55.96'},...v.o11]};delete naive.keepServed;
 for(const lane of ['odc','o11'])naive[lane][0]={version:naive[lane][0].version,image:v.odc[0].image,tag:'prod-next',sha256:'c'.repeat(64)};
 assert.throws(()=>safety.preserveCompose(snapshotOf(live),naive),e=>e.code==='SERVED_LIST_CHANGED'&&/nothing is written/.test(e.message));
});
test('N1 the live baseline carries each backend\'s served list and refuses an unreadable one',()=>{
 const s=live(),b=safety.liveBaseline(s);assert.deepEqual(b.manifest.o11[0].served,{odc:['1.7.30'],o11:['11.55.94']});
 const c=JSON.parse(s.compose);c.services['ssam-server-v1'].environment.SSAM_SERVED_VERSIONS='{';s.compose=JSON.stringify(c);
 assert.throws(()=>safety.liveBaseline(s),e=>e.code==='LIVE_INVALID');
});
test('N1 frozen served lists are validated: one list per pair, three-part versions, the pair\'s own versions, keepServed in range',async()=>{
 const {servedLists}=await mod('deploy/coolify/gen-compose.mjs');
 const served={odc:['1.7.31','1.7.30'],o11:['11.55.95','11.55.94']};
 const m=()=>({window:3,odc:[entry('1.7.31','new'),{...entry('1.7.30','prod-live'),served:{odc:['1.7.30'],o11:['11.55.94']}}],o11:[entry('11.55.95','new'),{...entry('11.55.94','prod-live'),served:{odc:['1.7.30'],o11:['11.55.94']}}]});
 assert.deepEqual(servedLists(m()).map(t=>JSON.parse(t)),[served,{odc:['1.7.30'],o11:['11.55.94']}]);
 const bad=[x=>{x.o11[1].served={odc:['1.7.30'],o11:['11.55.94','11.55.95']};},x=>{delete x.o11[1].served;},x=>{for(const l of ['odc','o11'])x[l][1].served={odc:['1.7.31'],o11:['11.55.94']};},
  x=>{for(const l of ['odc','o11'])x[l][1].served={odc:['1.7'],o11:['11.55.94']};},x=>{for(const l of ['odc','o11'])x[l][1].served={odc:['1.7.30','1.7.30'],o11:['11.55.94']};},
  x=>{for(const l of ['odc','o11'])x[l][1].served={odc:['1.7.30'],o11:['11.55.94'],extra:[]};},x=>{for(const l of ['odc','o11'])x[l][1].served='{"odc":["1.7.30"]}';},x=>{x.keepServed=3;},x=>{x.keepServed=-1;}];
 for(const change of bad){const x=m();change(x);assert.throws(()=>servedLists(x),/served|keepServed/,change.toString());}
});
// Review round 3 lows. R3-B3: the served list of a retained backend is compared by JSON value, as the remote check does.
test('R3-B3 a retained backend\'s served list is compared by JSON value: spacing and key order are no change, another list is',()=>{
 const s=live(),c=JSON.parse(s.compose),env=c.services['ssam-server-v1'].environment,kept=next=>Object.values(next.services).find(v=>v.labels?.['ssam.odc']==='1.7.30');
 env.SSAM_SERVED_VERSIONS='{ "o11": ["11.55.94"], "odc": ["1.7.30"] }';s.compose=JSON.stringify(c);
 assert.equal(kept(JSON.parse(safety.preserveCompose(s,grown()))).environment.SSAM_SERVED_VERSIONS,'{ "o11": ["11.55.94"], "odc": ["1.7.30"] }','the live text is kept as it is');
 for(const other of ['{"odc":["1.7.30","1.7.29"],"o11":["11.55.94"]}','{"odc":["1.7.30"],"o11":["11.55.94"],"extra":[]}','{','[]']){
  env.SSAM_SERVED_VERSIONS=other;s.compose=JSON.stringify(c);assert.throws(()=>safety.preserveCompose(s,grown()),e=>e.code==='SERVED_LIST_CHANGED',other);
 }
});
// R3-B1: an event counts as sent only when the VPS journal or the webhook took it; a failed first notice is sent again.
test('R3-B1 a release event is recorded only after the remote logger or the webhook took it',async t=>{
 const d=tmp(t),sent=[];let receipt;const ops={event:async n=>{sent.push(n);if(receipt instanceof Error)throw receipt;return receipt;}};
 const send=()=>releaseEvent(d,ops,'waiting','pair','client bridge update required',{},'reason-1','CLIENT_BRIDGE_UPDATE_REQUIRED');
 for(receipt of [undefined,{remote:false,webhook:false},Error('ssh down'),1])await send();
 assert.equal(sent.length,4,'nothing recorded: every round sends it again');assert.ok(!fs.existsSync(path.join(d,'release-events.json')));
 receipt={remote:false,webhook:true};await send();receipt={remote:true,webhook:false};await send();await send();
 assert.equal(sent.length,5,'the webhook took it: recorded, not sent again');
 assert.ok(JSON.parse(fs.readFileSync(path.join(d,'release-events.json'),'utf8'))['pair:reason-1:waiting']);
 receipt={remote:true,webhook:false};await releaseEvent(d,ops,'waiting','pair','m',{},'reason-2');await releaseEvent(d,ops,'waiting','pair','m',{},'reason-2');assert.equal(sent.length,6);
});
// Review round 2, B1 (R14/R3-10 flakiness): a manifest rewritten with the same size inside one timestamp tick kept the cached
// verification. Here every metadata the cache sees is frozen; only the signed content changes ('owner' -> 'other', same size).
test('B1 a re-signed manifest of the same size and timestamps is verified again, not served from the cache',t=>{
 const f=signedStore(t),original=fs.lstatSync;
 fs.lstatSync=function(p,...args){const s=original.call(this,p,...args);if(!String(p).startsWith(f.root))return s;return Object.assign(Object.create(Object.getPrototypeOf(s)),s,{ino:1,mtimeMs:1,ctimeMs:1});};
 try{assert.ok(f.store.offer('o11','11.55.94',['d1']));f.m.files[0].signer='other';f.write();assert.equal(f.store.offer('o11','11.55.94',['d1']),null);
  f.m.files[0].signer='owner';f.write();assert.ok(f.store.offer('o11','11.55.94',['d1']));}finally{fs.lstatSync=original;}
});
test('R3-8 packaged-process detection uses Windows Package.Current',()=>{assert.match(file('deploy/vigia/vault.ps1'),/Windows.ApplicationModel.Package.*::Current/);assert.doesNotMatch(file('deploy/vigia/vault.ps1'),/APPX_PACKAGE_FAMILY_NAME/);});
test('R3-9 snapshot cleanup retains live attempts plus five newest snapshots',t=>{
 assert.equal(typeof safety.cleanupRollback,'function');const root=tmp(t),folder=path.join(root,'rollback'),out=path.join(root,'out'),id='o11-11.55.94-odc-1.7.30';fs.mkdirSync(folder);fs.mkdirSync(path.join(out,id),{recursive:true});
 const names=Array.from({length:8},(_,i)=>path.join(folder,`${String(i).padStart(8,'0')}-0000-0000-0000-000000000000.dpapi`));names.forEach((n,i)=>{fs.writeFileSync(n,'encrypted');fs.utimesSync(n,i+1,i+1);});
 fs.writeFileSync(path.join(out,id,'release.json'),JSON.stringify({baseline:{file:names[0]}}));fs.writeFileSync(path.join(out,id,'deployment.json'),JSON.stringify({status:'deferred'}));safety.cleanupRollback(root,out);assert.equal(fs.readdirSync(folder).length,6);assert.ok(fs.existsSync(names[0]));
});
test('R3-10 installer custody refuses edited, added and external bundle files',async t=>{
 const p=await mod('deploy/vigia/provenance.mjs').catch(()=>({}));assert.equal(typeof p.captureProvenance,'function');
 const d=tmp(t),root=path.join(d,'tree'),installer=path.join(d,'installer.exe');fs.mkdirSync(root);fs.writeFileSync(installer,'installer');fs.writeFileSync(path.join(root,'unsigned.dll'),'original');
 const chain=p.captureProvenance(root,installer,{status:'Valid',subject:'synthetic',ca:'ca'});p.verifyProvenance(chain);fs.writeFileSync(path.join(root,'unsigned.dll'),'changed');assert.throws(()=>p.verifyProvenance(chain));fs.writeFileSync(path.join(root,'unsigned.dll'),'original');fs.writeFileSync(path.join(root,'extra.dll'),'extra');assert.throws(()=>p.verifyProvenance(chain));
 assert.doesNotMatch(file('deploy/vigia/auto-runtime.mjs'),/if\(release.studio&&/);assert.match(file('deploy/vigia/runtime.mjs'),/verifyBundleCustody/);
});
test('R3-10 executable manifests require owner or microsoft signer',t=>{
 const f=signedStore(t);assert.ok(f.store.offer('o11','11.55.94',['d1']));delete f.m.files[0].signer;f.write();assert.equal(f.store.offer('o11','11.55.94',['d1']),null);f.m.files[0].signer='other';f.write();assert.equal(f.store.offer('o11','11.55.94',['d1']),null);
});
test('R3-10 ownership follows TargetPath and dependency matches restored bytes',async t=>{
 const a=await mod('deploy/vigia/artifact-evidence.mjs').catch(()=>({}));assert.equal(typeof a.artifactEvidence,'function');const d=tmp(t),target=path.join(d,'build'),pkg=path.join(d,'packages');fs.mkdirSync(target);fs.mkdirSync(path.join(pkg,'dep'),{recursive:true});
 const own=path.join(target,'SurprisingName.dll'),third=path.join(target,'ODC3.Bridge.dll');fs.writeFileSync(own,'compiled');fs.writeFileSync(third,'vendor');fs.writeFileSync(path.join(pkg,'dep/vendor.dll'),'vendor');const assets=path.join(d,'assets.json');fs.writeFileSync(assets,JSON.stringify({packageFolders:{[pkg]:{}},libraries:{dep:{type:'package',path:'dep'}}}));
 const result=a.artifactEvidence(target,[own],[assets]);assert.ok(result.owned['SurprisingName.dll']);assert.ok(result.dependencies['ODC3.Bridge.dll']);fs.writeFileSync(third,'tampered');assert.throws(()=>a.artifactEvidence(target,[own],[assets]));
});

// Round 4 regressions: the same cases run against the untouched 4fef710 export.
test('R4-1 installer schedules an owned clone with password logon only',()=>{
 const s=file('deploy/vigia/install-task.ps1');assert.doesNotMatch(s,/PathType Leaf|LogonType Interactive|C:\\Users\\andre/);
 assert.match(s,/execution-trust.ps1.*-Workspace/);assert.match(s,/LogonType Password/);assert.match(s,/Get-Credential/);assert.match(s,/Register-ScheduledTask.*-User.*-Password/);
});
test('R4-2 all automatic executables are validated without user-profile fallback',()=>{
 assert.match(file('deploy/vigia/execution-trust.ps1'),/function Assert-Executable/);
 assert.match(file('deploy/vigia/vigia.ps1'),/if\(\$automatic\)/);assert.match(file('deploy/vigia/runtime.mjs'),/Configure trusted executable/);
 assert.doesNotMatch(file('deploy/vigia/auto-runtime.mjs'),/config.python\?\?/);
});
test('R4-3 a foreign ancestor owner is refused even with no writable ACE',async t=>{
 const {spawnSync}=await import('node:child_process'),d=tmp(t),parent=path.dirname(d),quote=s=>"'"+s.replaceAll("'","''")+"'";
 const code=`. ${quote(path.join(server,'deploy/vigia/execution-trust.ps1'))}; function Get-Acl {param($LiteralPath) $a=[pscustomobject]@{Bad=($LiteralPath -eq ${quote(parent)})}; $a|Add-Member ScriptMethod GetOwner {param($type) if($this.Bad){return [Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-999')}return [Security.Principal.WindowsIdentity]::GetCurrent().User};$a|Add-Member ScriptMethod GetAccessRules {param($a,$b,$c) @()};return $a };try{Assert-OwnedPath ${quote(d)};exit 3}catch{if($_.Exception.Message -notmatch 'account'){throw};'ancestor rejected'}`;
 const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/ancestor rejected/);
});
test('R4-4 deferred stale baseline closes idle when the candidate is live',async t=>{
 const f=transaction(t,'reread1');f.r.baseline=await f.ops.liveBaseline();assert.equal((await releaseAutomatically({},f.ops,f.r)).status,'deferred');
 f.ops.liveBaseline=async()=>({manifest:f.r.manifest,hash:'fresh',file:'protected'});
 assert.equal((await releaseAutomatically({},f.ops,f.r)).status,'idle');assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'deployment.json'))).status,'idle');
});
test('R4-4 deferred journal has a bounded retry lifetime',async t=>{
 const f=transaction(t,'reread1');await releaseAutomatically({},f.ops,f.r);assert.equal((await releaseAutomatically({maxDeploymentDeferrals:1},f.ops,f.r)).status,'abandoned');
 const id='o11-11.55.94-odc-1.7.31',inputs={head:'old',studios:{odc:'1.7.31.1'}};
 const options={manifest:baseline,observed:[{lane:'odc',version:'1.7.31',fullVersion:'1.7.31.1'}],attempts:{[id]:{id,status:'closed',inputs}},inputs:()=>({...inputs,head:'new'})};
 assert.equal(decide(options).action,'run');options.inputs=()=>inputs;assert.equal(decide(options).action,'idle');
});
test('R4-4 refreshed retained digests are repinned and persisted for recovery',async t=>{
 const f=transaction(t,'reread1');f.r.baseline=await f.ops.liveBaseline();await releaseAutomatically({},f.ops,f.r);
 const changed=structuredClone(baseline);changed.odc[0].sha256='c'.repeat(64);changed.o11[0].sha256='c'.repeat(64);
 f.ops.liveBaseline=async()=>({manifest:changed,hash:'fresh',file:'protected',kernels:{}});
 let pinned;f.ops.pinExecution=async m=>{pinned=m;return 'new-pin';};f.ops.assertLiveUnchanged=async(s,b)=>assert.equal(b.hash,'fresh');
 assert.equal((await releaseAutomatically({},f.ops,f.r)).status,'live');assert.equal(pinned.odc[1].sha256,'c'.repeat(64));
 const state=JSON.parse(fs.readFileSync(path.join(f.dir,'deployment.json')));assert.equal(state.baseline.hash,'fresh');assert.equal(state.proposed.odc[1].sha256,'c'.repeat(64));
});
test('R4-5 unused artifact trees are bounded while live journal references survive',async t=>{
 const m=await mod('deploy/vigia/artifact-retention.mjs').catch(()=>({}));assert.equal(typeof m.cleanupArtifacts,'function');const root=tmp(t),priv=path.join(root,'priv'),out=path.join(root,'out'),id='o11-11.55.94-odc-1.7.30';fs.mkdirSync(path.join(out,id),{recursive:true});
 const dirs=Array.from({length:4},(_,i)=>path.join(priv,'extracted',String(i).repeat(64)));dirs.forEach((d,i)=>{fs.mkdirSync(d,{recursive:true});fs.utimesSync(d,i+1,i+1);});
 fs.writeFileSync(path.join(out,id,'release.json'),JSON.stringify({bundles:{odc:{provenance:{root:dirs[0]}}}}));fs.writeFileSync(path.join(out,id,'deployment.json'),JSON.stringify({status:'deferred'}));
 m.cleanupArtifacts({tempRoot:priv,outDir:out,bundleRoot:path.join(root,'bundles'),keepArtifacts:1});assert.ok(fs.existsSync(dirs[0]));assert.equal(fs.readdirSync(path.dirname(dirs[0])).length,2);
 assert.match(file('deploy/vigia/auto-runtime.mjs'),/extracted',downloaded.sha256/);assert.ok(file('deploy/vigia/auto-runtime.mjs').indexOf('runtime.diskPreflight()')<file('deploy/vigia/auto-runtime.mjs').indexOf('await downloadInstaller'));
});
test('R4-6 capacity/window rejection happens before any expensive operation',async t=>{
 const {runVigia}=await mod('deploy/vigia/pipeline.mjs');const d=tmp(t),b=window3();b.odc.push(entry('1.7.27','old'));b.o11.push(entry('11.55.91','old'));b.window=4;
 const state={tokens:Object.fromEntries(b.odc.map((e,i)=>['a'+i,{seen:new Date().toISOString(),odc:{installed:e.version}}]))};let expensive=0;
 const result=await runVigia({automatic:true,outDir:d,manifest:b,state,observed:[{lane:'odc',version:'1.7.31',fullVersion:'1.7.31.1',tfm:'net10.0'}],head:'abc'}, {secrets:async()=>({}),event:async()=>{},notify:async()=>{},preflight:async()=>{expensive++;throw Error('too late');}});
 assert.equal(result.status,'deferred');assert.equal(expensive,0);
});
test('R4-7 valid timestamped expired signer is verified at signing time',async()=>{
 const {spawnSync}=await import('node:child_process'),p=path.join(server,'deploy/vigia/authenticode-chain.ps1');assert.ok(fs.existsSync(p));
 const code=`. '${p.replaceAll("'","''")}'; function Get-AuthenticodeSigningTime {param($File,$Signature) [datetime]'2019-01-01Z'}; $c=[pscustomobject]@{ChainPolicy=[pscustomobject]@{VerificationTime=[datetime]::Now;RevocationMode=$null;RevocationFlag=$null;UrlRetrievalTimeout=$null};ChainStatus=@()};$c|Add-Member ScriptMethod Build {param($cert) $this.ChainPolicy.VerificationTime -lt [datetime]'2020-01-01Z'}; $s=[pscustomobject]@{Status='Valid';SignerCertificate='expired';TimeStamperCertificate='timestamp'}; $r=Get-VerifiedAuthenticodeChain 'synthetic' $s $c;if($r.ChainPolicy.RevocationMode -ne 'Online'){exit 3};'timestamp verified'`;
 const offline=`; $c.ChainStatus=@([pscustomobject]@{Status=[Security.Cryptography.X509Certificates.X509ChainStatusFlags]::OfflineRevocation});$c|Add-Member -Force ScriptMethod Build {param($cert) $false};try{Get-VerifiedAuthenticodeChain 'synthetic' $s $c;exit 4}catch{'offline deferred'}`;
 const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',code+offline],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/timestamp verified/);assert.match(r.stdout,/REVOCATION_UNAVAILABLE/);assert.match(r.stdout,/offline deferred/);
});
test('R4-8 stale token with a different lock holder is refused',async()=>{
 const {spawnSync}=await import('node:child_process');
 const code=`import importlib.util,sys,types\nfrom unittest.mock import patch,MagicMock\np=${JSON.stringify(path.join(server,'deploy/vigia/remote-release.py'))}\ns=importlib.util.spec_from_file_location('remote',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nm.fcntl=types.SimpleNamespace(LOCK_EX=2,LOCK_NB=4,flock=MagicMock(side_effect=BlockingIOError))\nwith patch.object(m.pathlib.Path,'read_text',return_value='stale-token'),patch('builtins.open',MagicMock()):\n try:m.assert_fence('stale-token')\n except Exception as e:\n  assert str(e)=='LOCK_LOST';sys.exit(0)\nsys.exit(3)`;
 const r=spawnSync('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',['-c',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 assert.match(file('deploy/vigia/with-release-lock.sh'),/ssam-release.owner/);
});
test('R4-9 failure before deploy restores compose without restart',async t=>{
 const f=transaction(t);f.ops.writeCompose=async()=>{throw Error('PATCH refused');};const result=await releaseAutomatically({},f.ops,f.r);assert.equal(result.status,'rolled-back');assert.ok(f.calls.includes('restore'));assert.ok(!f.calls.includes('deploy'));
});
test('R4-9 third-party compose after lock loss is never overwritten',async t=>{
 const f=transaction(t);f.ops.deploy=async()=>{throw Error('lost');};f.ops.ensureReleaseLock=async()=>async()=>{};f.ops.assertRollbackSafe=async()=>{throw Error('third-party compose');};assert.equal((await releaseAutomatically({},f.ops,f.r)).status,'rollback-failed');assert.ok(!f.calls.includes('restore'));
});
test('R4-9 canonical JSON tolerates formatting and key order only',()=>{
 assert.equal(typeof safety.canonicalComposeHash,'function');assert.equal(safety.canonicalComposeHash('{"a":1,"b":{"x":2}}'),safety.canonicalComposeHash('{ "b": {"x":2}, "a":1 }'));assert.notEqual(safety.canonicalComposeHash('{"a":1}'),safety.canonicalComposeHash('{"a":2}'));
});
test('R4-10 an agent cannot hide from retention using hello.verification',async t=>{
 const {recordStudioVersions,readStudioVersions}=await mod('platforms/odc/facade/studio-version-state.mjs'),d=tmp(t);recordStudioVersions(d,{tokenId:'real',customer:'Real customer',hello:{verification:true,studios:{odc:{installed:{version:'1.7.28'}}}}},{},new Date().toISOString());assert.ok(readStudioVersions(d,[]).tokens.real);
 assert.match(file('platforms/odc/facade/agent-hub.mjs'),/verification:record\(state.tokenId\)/);
 const {tokenRecords}=await mod('platforms/odc/facade/server-tokens.mjs'),ops=tokenRecords(),tokens=[];
 const issued=ops.issue(tokens,ops.checkIssue({customer:'Verification',verification:true}));assert.equal(issued.value.verification,true);assert.equal(ops.publicView(tokens[0]).verification,true);
});
test('R4-11 automatic reads refuse missing MAC key and installer roots outside custody',async t=>{
 const j=await mod('deploy/vigia/journal.mjs'),p=await mod('deploy/vigia/provenance.mjs'),d=tmp(t),f=path.join(d,'journal.json');fs.writeFileSync(f,'{}');assert.throws(()=>j.readJournal(f,{automatic:true}));
 assert.equal(typeof p.verifyInstallerCustody,'function');await assert.rejects(p.verifyInstallerCustody({root:d},{privateRoot:d,verifyPublisher:async()=>({})}),/private extracted/);assert.match(file('deploy/vigia/runtime.mjs'),/writeJournal\(found.file\+'\.provenance.json'/);
 const root=path.join(d,'extracted','hash'),installer=path.join(d,'installer'),signer={status:'Valid',subject:'owner',ca:'CA'};fs.mkdirSync(root,{recursive:true});fs.writeFileSync(installer,'installer');fs.writeFileSync(path.join(root,'input.dll'),'original');const chain=p.captureProvenance(root,installer,signer);let calls=0;
 await p.verifyInstallerCustody(chain,{privateRoot:d,verifyPublisher:async()=>{calls++;return signer;}});assert.equal(calls,1);
 await assert.rejects(p.verifyInstallerCustody(chain,{privateRoot:d,verifyPublisher:async()=>({...signer,ca:'other'})}),/publisher custody/);
});
test('R4-12 unsigned main needs explicit owner acceptance',()=>{
 assert.equal(typeof safety.signingPolicy,'function');assert.throws(()=>safety.signingPolicy({}));assert.equal(safety.signingPolicy({acceptUnsignedMain:true}),false);assert.equal(safety.signingPolicy({ownerSigningPublicKey:'owner'}),true);
});
test('R4-13 automatic build uses supplied revision without invoking git',async t=>{
 const {spawnSync}=await import('node:child_process'),d=tmp(t),marker=path.join(d,'git-called'),fake=path.join(d,'git'),docker=path.join(d,'fake-docker');
 const sh=s=>s.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,c)=>'/'+c.toLowerCase());
 fs.writeFileSync(fake,`#!/bin/sh\necho invoked >> '${sh(marker)}'\necho ${'a'.repeat(40)}\n`);fs.writeFileSync(docker,'#!/bin/sh\nexit 1\n');
 spawnSync('C:/Program Files/Git/bin/bash.exe',['-c',`chmod +x '${sh(fake)}' '${sh(docker)}'`]);
 const r=spawnSync('C:/Program Files/Git/bin/bash.exe',['--noprofile','--norc','-c',`export PATH='${sh(d)}:/usr/bin:/bin'; exec /usr/bin/bash '${sh(path.join(server,'deploy/build.sh'))}' --tag prod-test --image fake/image`],{encoding:'utf8',env:{...process.env,SSAM_AUTOMATIC:'1',VCS_REF:'a'.repeat(40),STUDIO_INSTALLERS_DIR:sh(d),DOCKER:sh(docker),SSAM_ENV_FILE:sh(path.join(d,'missing.env'))}});
 assert.match(file('deploy/build.sh'),/SSAM_AUTOMATIC/);
 assert.notEqual(r.status,0);assert.match(r.stderr,/client-name guard FAILED/);assert.ok(!fs.existsSync(marker),r.stderr);
});

// Round 5 regressions: the same cases run against the untouched fbe51d7 export. The "(real Windows)" cases only read this
// machine (ACLs of C:\ and of installed executables, Authenticode of installed files and of the user's NuGet cache) and are
// skipped off Windows or when the file is missing.
const R5=await import('node:child_process'),onWindows=process.platform==='win32';
const PS='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',psq=s=>"'"+String(s).replaceAll("'","''")+"'";
const psEnv={...process.env,PSModulePath:'C:/Windows/System32/WindowsPowerShell/v1.0/Modules;'+(process.env.PSModulePath??'')};
const powershell=code=>R5.spawnSync(PS,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',code],{encoding:'utf8',windowsHide:true,env:psEnv});
const lastJson=text=>JSON.parse(text.trim().split(/\r?\n/).pop());
const trustScript=()=>`. ${psq(path.join(server,'deploy/vigia/execution-trust.ps1'))};`;
const pins=()=>JSON.parse(file('deploy/vigia/publisher-pins.json'));
test('R5-1 the default C:\\ ACL passes as an ancestor while Authenticated Users:Modify is still refused (real Windows, read-only)',{skip:!onWindows||!fs.existsSync('C:/Program Files')},()=>{
 // The item is synthetic (in memory, owned by this account); C:\ is read for real. Nothing is written to any ACL.
 const r=powershell(trustScript()+`
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User;$users=New-Object Security.Principal.SecurityIdentifier('S-1-5-11')
function New-Owned([switch]$Modify,[switch]$InheritOnly){$s=New-Object Security.AccessControl.DirectorySecurity;$s.SetOwner($me);$s.SetAccessRuleProtection($true,$false);$s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));if($Modify){$s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users,'Modify','ContainerInherit,ObjectInherit',$(if($InheritOnly){'InheritOnly'}else{'None'}),'Allow')))};return $s}
$script:item='owned';$script:root='real'
function Get-Acl {param($LiteralPath) if($LiteralPath -eq 'C:\\'){$real=Microsoft.PowerShell.Security\\Get-Acl -LiteralPath 'C:\\';if($script:root -eq 'real'){return $real};$s=New-Object Security.AccessControl.DirectorySecurity;$s.SetSecurityDescriptorSddlForm($real.Sddl);$s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users,'Modify','None','None','Allow')));return $s};switch($script:item){'owned'{New-Owned}'modify'{New-Owned -Modify}'inherit'{New-Owned -Modify -InheritOnly}}}
function Check([string]$label){try{Assert-OwnedPath 'C:\\Program Files';"$label=pass"}catch{"$label=refused"}}
Check 'default-root';$script:root='modify';Check 'root-modify';$script:root='real';$script:item='modify';Check 'item-modify';$script:item='inherit';Check 'item-inherit-only'`);
 assert.equal(r.status,0,r.stderr);
 for(const line of ['default-root=pass','root-modify=refused','item-modify=refused','item-inherit-only=refused'])assert.match(r.stdout,new RegExp(line),r.stdout);
});
test('R5-2 the executable walk visits every ancestor of git.exe (real Windows, read-only)',{skip:!onWindows||!fs.existsSync('C:/Program Files/Git/cmd/git.exe')},()=>{
 const r=powershell(trustScript()+` $script:seen=New-Object Collections.Generic.List[string]; function Assert-AclItem {param($Item,$Owners,$Writers,[switch]$Ancestor) $script:seen.Add($Item.FullName.TrimEnd('\\'))}; Assert-Executable 'C:\\Program Files\\Git\\cmd\\git.exe'; $script:seen -join '|'`);
 assert.equal(r.status,0,r.stderr);const seen=r.stdout.trim().toLowerCase().split('|');
 for(const p of ['c:\\program files\\git\\cmd\\git.exe','c:\\program files\\git\\cmd','c:\\program files\\git','c:\\program files','c:'])assert.ok(seen.includes(p),'missing '+p+' in '+seen.join(', '));
});
const odcStudio=['C:/Program Files/OutSystems/ODC Studio/ODC Studio/ODCStudio.exe','C:/Program Files/OutSystems/ODC Studio/ODCStudio.exe'].find(f=>fs.existsSync(f));
test('R5-3 ODCStudio.exe verifies at its timestamp under the pinned OutSystems CA (real Windows, read-only)',{skip:!onWindows||!odcStudio},t=>{
 const r=R5.spawnSync(PS,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(server,'deploy/vigia/verify-publisher.ps1'),'-File',odcStudio],{encoding:'utf8',windowsHide:true,env:psEnv});
 if(/REVOCATION_UNAVAILABLE/.test(r.stdout))return t.skip('revocation service unavailable on this network');
 assert.equal(r.status,0,r.stderr);const signer=lastJson(r.stdout);
 assert.equal(signer.status,'Valid');assert.ok(pins().outsystems.some(p=>p.subject===signer.subject&&p.ca===signer.ca),JSON.stringify(signer));
});
const nugetRoot=process.env.NUGET_PACKAGES??path.join(os.homedir(),'.nuget','packages');
const expiredClient=['net6.0','netstandard2.0'].map(f=>path.join(nugetRoot,'microsoft.diagnostics.netcore.client','0.2.410101','lib',f,'Microsoft.Diagnostics.NETCore.Client.dll')).find(f=>fs.existsSync(f));
test('R5-3 an expired NuGet signer verifies at its 2023-02-01 timestamp under the pinned Microsoft root (real Windows, read-only)',{skip:!onWindows||!expiredClient},t=>{
 const r=powershell(`. ${psq(path.join(server,'deploy/vigia/authenticode-chain.ps1'))}; $f=${psq(expiredClient)}; $s=Get-AuthenticodeSignature -LiteralPath $f; $now=New-Object Security.Cryptography.X509Certificates.X509Chain; $now.ChainPolicy.RevocationMode='NoCheck'; $validNow=$now.Build($s.SignerCertificate); $c=Get-VerifiedAuthenticodeChain $f $s; [pscustomobject]@{status=[string]$s.Status;notAfter=$s.SignerCertificate.NotAfter.ToUniversalTime().ToString('o');time=$c.ChainPolicy.VerificationTime.ToUniversalTime().ToString('o');root=$c.ChainElements[$c.ChainElements.Count-1].Certificate.Thumbprint;validNow=$validNow} | ConvertTo-Json -Compress`);
 if(/REVOCATION_UNAVAILABLE/.test(r.stdout))return t.skip('revocation service unavailable on this network');
 assert.equal(r.status,0,r.stderr);const v=lastJson(r.stdout);
 assert.equal(v.status,'Valid');assert.ok(Date.parse(v.notAfter)<Date.now());assert.equal(v.validNow,false);
 assert.match(v.time??'',/^2023-02-01T/);assert.ok(pins().microsoftRoots.includes(v.root),JSON.stringify(v));
});
test('R5-4 retention keeps the served pair: bundle receipts, their extractions and installers, stored snapshots and live journals',async t=>{
 const m=await mod('deploy/vigia/artifact-retention.mjs'),base=tmp(t);
 const tempRoot=path.join(base,'tmp'),bundleRoot=path.join(base,'bundles'),outDir=path.join(base,'out'),installersDir=path.join(base,'installers');
 for(const d of [tempRoot,bundleRoot,outDir,installersDir])fs.mkdirSync(d,{recursive:true});
 const age=(p,minutes)=>{const at=new Date(Date.now()-minutes*60000);fs.utimesSync(p,at,at);return p;};
 const dir=(p,minutes)=>{fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,'ServiceStudio.Framework.dll'),'x');return age(p,minutes);};
 const installer=(name,minutes)=>{const f=path.join(installersDir,name);fs.writeFileSync(f,'MZ');fs.writeFileSync(f+'.sha256','a'.repeat(64)+'\n');return age(f,minutes);};
 // The r4-retention pattern: pair X is served, its journals are terminal, and its bundle receipts cite these roots.
 const xOdc=dir(path.join(tempRoot,'extracted','a'.repeat(64)),300),xO11=dir(path.join(tempRoot,'extracted','b'.repeat(64)),299);
 const iOdc=installer('odc-1.7.30.10980.exe',300),iO11=installer('o11-11.55.94.65328.exe',299);
 const store=(lane,v,full,root,inst)=>{const folder=path.join(bundleRoot,`${lane}-${v}`);fs.mkdirSync(folder,{recursive:true});const bundle=path.join(folder,`${lane}-studio-${full}.tar.gz`);fs.writeFileSync(bundle,lane);const digest=createHash('sha256').update(lane).digest('hex');fs.writeFileSync(bundle+'.sha256',digest+'  '+path.basename(bundle)+'\n');fs.writeFileSync(bundle+'.provenance.json',JSON.stringify({value:{root,installer:{file:inst}}}));return {folder,digest};};
 const odc=store('odc','1.7.30','1.7.30.10980',xOdc,iOdc);store('o11','11.55.94','11.55.94.65328',xO11,iO11);
 const stored=dir(path.join(odc.folder,'snapshot-'+odc.digest),400);fs.writeFileSync(stored+'.tree.json','{}');
 const orphans=[1,2,3].map(i=>dir(path.join(odc.folder,'snapshot-'+String(i).repeat(64)),300-i));
 // Pair Y (the candidate, no release.json yet): newer extractions whose receipts cite newer installers.
 const yInstallers=[];for(const [c,minutes] of [['c',10],['d',9]]){const root=dir(path.join(tempRoot,'extracted',c.repeat(64)),minutes);const inst=installer(`odc-1.7.31.${minutes}.exe`,minutes);yInstallers.push(inst);fs.writeFileSync(root+'.provenance.json',JSON.stringify({root,installer:{file:inst}}));}
 const oldInstaller=installer('odc-1.7.29.1.exe',500),newer=[installer('odc-1.7.31.1.exe',8),installer('odc-1.7.31.2.exe',7)];
 const partial=path.join(installersDir,'odc-1.7.31.3.exe.partial-999999');fs.writeFileSync(partial,'MZ');
 const stage=n=>dir(path.join(tempRoot,'bridges',`${n}0000000-0000-0000-0000-000000000000`),600-n);
 const servedStage=stage(1),leftStage=stage(2);stage(3);stage(4);
 const journal=(id,s)=>{fs.mkdirSync(path.join(outDir,id),{recursive:true});fs.writeFileSync(path.join(outDir,id,'release.json'),JSON.stringify({bridges:{stage:s}}));fs.writeFileSync(path.join(outDir,id,'deployment.json'),JSON.stringify({status:'live'}));};
 journal('o11-11.55.94-odc-1.7.30',servedStage);journal('o11-11.55.92-odc-1.7.28',leftStage);
 m.cleanupArtifacts({tempRoot,bundleRoot,outDir,installersDir,keepArtifacts:2,livePairs:['o11-11.55.94-odc-1.7.30']});
 for(const p of [xOdc,xO11,iOdc,iO11,...yInstallers,stored,stored+'.tree.json',orphans[1],orphans[2],servedStage,...newer])assert.ok(fs.existsSync(p),'kept '+p);
 for(const p of [orphans[0],leftStage,oldInstaller,oldInstaller+'.sha256',partial])assert.ok(!fs.existsSync(p),'removed '+p);
 const s=file('deploy/vigia/auto-runtime.mjs');assert.match(s,/livePairs:readLivePairs\(config.outDir\)/);assert.match(s,/recordLivePairs\(config.outDir,Object.keys\(baseline.kernels\)\)/);
});
test('R5-5 an abandoned attempt has its own event with the cause code and -Retry reopens it',async t=>{
 const f=transaction(t,'reread1');assert.equal((await releaseAutomatically({},f.ops,f.r)).status,'deferred');
 assert.equal((await releaseAutomatically({maxDeploymentDeferrals:1},f.ops,f.r)).status,'abandoned');
 const abandoned=f.events.find(([n])=>n==='abandoned');assert.ok(abandoned,JSON.stringify(f.events.map(([n])=>n)));assert.equal(abandoned[1].code,'LIVE_CHANGED');assert.match(abandoned[1].message,/LIVE_CHANGED/);
 const {retry}=await mod('deploy/vigia/approve.mjs'),dir=tmp(t),id='o11-11.55.95-odc-1.7.31',inputs={head:'h',studios:{odc:'1.7.31.1'}};
 const write=(code,status)=>{fs.mkdirSync(path.join(dir,id),{recursive:true});fs.writeFileSync(path.join(dir,id,'attempt.json'),JSON.stringify({id,status:'closed',code,cause:'LIVE_CHANGED',inputs,pair:{lanes:['odc'],odc:'1.7.31',o11:'11.55.95'},at:'then'}));fs.writeFileSync(path.join(dir,id,'deployment.json'),JSON.stringify({status}));};
 write('abandoned','abandoned');assert.equal(retry({outDir:dir},id).status,'retry');
 const reopened=JSON.parse(fs.readFileSync(path.join(dir,id,'attempt.json'),'utf8'));
 assert.equal(decide({manifest:baseline,observed:[{lane:'odc',version:'1.7.31',fullVersion:'1.7.31.1'}],attempts:{[id]:reopened},inputs:()=>inputs}).action,'run');
 write('idle','idle');assert.throws(()=>retry({outDir:dir},id),/abandoned/);
});
test('R5-6 accepted unsigned main is a notification every round (toast, webhook and VPS journal)',async t=>{
 const dir=tmp(t),events=[],secrets={synthetic:true};
 const runtime={secrets:async()=>secrets,executionSource:async()=>{},cleanupSsh:async()=>{},pause:async()=>{},event:async(n,v,s)=>{events.push([n,v,s]);return SENT;},liveBaseline:async()=>({manifest:baseline}),manifest:()=>baseline,detect:async()=>[],observe:async x=>x,head:async()=> 'head'};
 for(let i=0;i<2;i++)await round({automatic:true,acceptUnsignedMain:true,outDir:dir},runtime);
 assert.equal(events.filter(([n])=>n==='unsigned-main').length,2);assert.equal(events[0][2],secrets);
 events.length=0;await round({automatic:true,ownerSigningPublicKey:'ssh-ed25519 AAAA',outDir:dir},runtime);assert.equal(events.length,0);
 // The event channel itself reaches the toast, the VPS journal (logger over SSH) and the optional webhook.
 const {createAutoRuntime}=await mod('deploy/vigia/auto-runtime.mjs'),priv=path.join(dir,'priv'),reached=[],fetched=[];
 const auto=createAutoRuntime({workspace:dir,tempRoot:priv,outDir:dir,automaticDeployment:{ssh:{host:'vps.invalid',knownHosts:path.join(dir,'known_hosts'),executable:'ssh-fake'}}},{log:()=>{},notify:async(title)=>reached.push(['toast',title]),run:async(command,args,options)=>{if(command==='ssh-fake'){reached.push(['vps',JSON.parse(options.input)]);return {code:0,stdout:'{"ok":true}'};}return {code:0,stdout:''};}});
 const original=globalThis.fetch;globalThis.fetch=async(url,options)=>{fetched.push([String(url),JSON.parse(options.body)]);return {ok:true};};
 try{await auto.event('unsigned-main',{id:'main',message:'unsigned'},{sshPrivateKey:Buffer.from('PRIVATE KEY').toString('base64'),webhookUrl:'https://hook.invalid/vigia'});}finally{globalThis.fetch=original;}
 assert.ok(reached.some(([k,v])=>k==='toast'&&/unsigned-main/.test(v)));assert.ok(reached.some(([k,v])=>k==='vps'&&v.action==='event'&&v.event==='unsigned-main'));assert.equal(fetched[0]?.[1].event,'unsigned-main');
});
test('R5-7 the scheduled task may start and keep running on batteries (real Windows, in-memory settings only)',{skip:!onWindows},()=>{
 const r=powershell(`$ast=[Management.Automation.Language.Parser]::ParseFile(${psq(path.join(server,'deploy/vigia/install-task.ps1'))},[ref]$null,[ref]$null); $assign=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$settings'},$true))[0]; $settings=& ([scriptblock]::Create($assign.Right.Extent.Text)); [pscustomobject]@{disallow=$settings.DisallowStartIfOnBatteries;stop=$settings.StopIfGoingOnBatteries;instances=[string]$settings.MultipleInstances} | ConvertTo-Json -Compress`);
 assert.equal(r.status,0,r.stderr);const v=lastJson(r.stdout);assert.equal(v.disallow,false);assert.equal(v.stop,false);assert.equal(v.instances,'IgnoreNew');
});
