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
test('R12 installer host allowlist is exact and publisher checks include the framework',()=>{assert.throws(()=>officialUrl('https://rogue.outsystems.com/x'));assert.match(file('deploy/vigia/runtime.mjs'),/ServiceStudio.Framework.dll.*lane==='odc'/);assert.match(file('deploy/vigia/verify-publisher.ps1'),/Status -ne 'Valid'/);});
test('R13 dependencies are not re-signed and runtime selection is not overridden',()=>{assert.doesNotMatch(file('deploy/vigia/auto-runtime.mjs'),/-p:OdcBridgeRuntime=/);assert.match(file('scripts/odc-runtime-signing.ps1'),/if \(\$own\)/);assert.match(file('deploy/vigia/runtime.mjs'),/agentReleaseCommit/);});
test('R13 raw API responses are excluded from the deployment journal',async t=>{const f=transaction(t);await releaseAutomatically({},f.ops,f.r);assert.ok(!fs.readFileSync(path.join(f.dir,'deployment.json'),'utf8').includes('never-journal'));});
test('R13 remote features have unconditional cleanup and backups have five-item retention',()=>{const s=file('deploy/vigia/remote-release.py');assert.match(s,/finally:\n\s+features.unlink/);assert.match(s,/complete\[5:\]/);assert.match(s,/disk_usage/);});
test('R14 unsigned-sequence manifests are refused, and failed identity is suppressed until a higher sequence',t=>{
 const root=tmp(t),dir=path.join(root,'odc','1.7.30','v100');fs.mkdirSync(path.join(dir,'bridge'),{recursive:true});const bytes=Buffer.from('fake');fs.writeFileSync(path.join(dir,'bridge','x.dll'),bytes);const keys=generateKeyPairSync('ed25519');
 const m={schema:1,lane:'odc',studioVersion:'1.7.30',protocol:'v100',runtime:'net10.0',authenticodeThumbprint:'b'.repeat(40),files:[{path:'bridge/x.dll',size:4,sha256:createHash('sha256').update(bytes).digest('hex')}]};
 const write=()=>{const b=Buffer.from(JSON.stringify(m));fs.writeFileSync(path.join(dir,'manifest.json'),b);fs.writeFileSync(path.join(dir,'manifest.sig'),sign(null,b,keys.privateKey));};
 write();const store=createBridgeStore({root,publicKey:keys.publicKey});assert.equal(store.offer('odc','1.7.30',['v100']),null);m.sequence=1;write();
 const report={lane:'odc',studioVersion:'1.7.30',protocol:'v100',sequence:1,status:'failed'};assert.equal(store.offer('odc','1.7.30',['v100'],[report]),null);m.sequence=2;write();assert.ok(store.offer('odc','1.7.30',['v100'],[report]));
});
test('R14 hello bridge report is retained without arbitrary reason text',()=>{const r=bridgeReports([{lane:'odc',studioVersion:'1.7.30',protocol:'v100',sequence:2,status:'failed',reason:'LOAD_FAILED'}]);assert.equal(r[0].sequence,2);assert.match(file('platforms/odc/facade/studio-version-state.mjs'),/bridges:state.hello/);});
test('R14 file route uses the signed storage identity, not the backend kernel version',()=>{const s=file('platforms/odc/facade/agent-hub.mjs').split("if (segments[2] === 'bridges')")[1].split("const state = stateOf")[0];assert.ok(!s.includes('serverKernel[lane] !== studioVersion'));});
