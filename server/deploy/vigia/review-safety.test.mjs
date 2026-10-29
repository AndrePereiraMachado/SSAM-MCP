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
const sha='a'.repeat(64),entry=(version,tag)=>({version,tag,image:'registry/image',sha256:sha});
const baseline={window:3,odc:[entry('1.7.30','prod-live')],o11:[entry('11.55.94','prod-live')]};
const kernel={odc:'1.7.30',o11:'11.55.94',odcBridge:'v100'};
const live=()=>({compose:JSON.stringify(generateCompose(baseline)),backends:[{...kernel,reference:'registry/image:prod-live',digest:'sha256:'+sha,image:'running-id',kernel,budget:{tools:90,totalBytes:500,core:[]}}]});
function transaction(t,failAt){
 const dir=tmp(t),calls=[],events=[];
 const r={id:'o11-11.55.95-odc-1.7.31',dir,attempt:'attempt-1',built:{image:'registry/image',tag:'prod-new',sha256:sha,odc:'1.7.31',o11:'11.55.95'},kernel:{odc:'1.7.31',o11:'11.55.95'},manifest:{window:3,odc:[entry('1.7.31','prod-new'),...baseline.odc],o11:[entry('11.55.95','prod-new'),...baseline.o11]},bridges:{offers:[]},features:'private'};
 let rereads=0;
 const ops={secrets:async()=>({}),pause:async()=>{},deploymentBudget:async()=>{},liveBaseline:async()=>({manifest:baseline,file:'protected',hash:'hash'}),verifyLocalImage:async()=>{},publish:async()=>({digest:'sha256:'+sha,rawSecret:'never-journal'}),pinExecution:async()=> 'pin',
  acquireReleaseLock:async()=>{calls.push('lock');return async()=>calls.push('unlock');},beginDeployment:()=>calls.push('protected'),endDeployment:()=>calls.push('unprotected'),
  preflightRemote:async()=>calls.push('memory'),assertLiveUnchanged:async()=>{calls.push('reread');rereads++;if(failAt===`reread${rereads}`)throw Object.assign(Error('changed'),{code:'LIVE_CHANGED',environmental:true});},
  backup:async()=>{calls.push('backup');return {ok:true};},composeFor:async()=> '{}',prepare:async()=>{calls.push('prepare');if(failAt==='prepare')throw Error('prepare');},
  writeCompose:async()=>{calls.push('PATCH');return {rawSecret:'never-journal'};},deploy:async()=>{calls.push('deploy');return {rawSecret:'never-journal'};},checks:async()=>({ok:true}),restoreCompose:async()=>calls.push('restore'),event:async(n,v)=>events.push([n,v])};
 return {dir,calls,events,ops,r};
}
test('R0 production baseline is the three-pair R1 with its matching newer O11 bridge policy',()=>{
 assert.equal(JSON.parse(file('deploy/coolify/versions.json')).odc.length,3);
 assert.match(file('platforms/odc/facade/agent-hub.mjs'),/newerLocalBridge/);
});
test('R1 live kernels, tags and digests define the baseline and inconsistency fails closed',()=>{
 const s=live(),b=safety.liveBaseline(s);assert.deepEqual(b.manifest.odc,baseline.odc);
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
 const d=tmp(t),events=[],ops={event:async n=>events.push(n)};
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
test('R12 installer host allowlist is exact and publisher requires a valid signature',()=>{assert.throws(()=>officialUrl('https://rogue.outsystems.com/x'));assert.match(file('deploy/vigia/verify-publisher.ps1'),/Status -ne 'Valid'/);});
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
 const m={window:3,odc:[entry('1.7.31','new'),...baseline.odc],o11:[entry('11.55.95','new'),...baseline.o11]};const next=JSON.parse(safety.preserveCompose(s,m));
 const added=Object.values(next.services).find(v=>v.labels?.['ssam.odc']==='1.7.31');assert.equal(added.privileged,undefined);assert.ok(!added.volumes.some(v=>v.type==='bind'));assert.equal(added.environment.CUSTOM,'keep');
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
