// The first backend window (S1 switch) is generated from the committed pair versions.json: ODC 1.7.28 enters a 7-day grace
// instead of being cut, every backend is pinned, and the result generates its compose (first-window.mjs). S2 R4 (review M3):
// the kit plan lists the 5 backends to deploy and check, the window-retiring notice names the customers from the live usage
// data (affected-customers.mjs), and each image's real O11 kernels are recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {firstBackendWindow} from './first-window.mjs';
import {mergeTelemetry,retiringNotice,CAPTURE_SOURCE} from './affected-customers.mjs';
import {servedLists,isBackendManifest,versionBackends} from '../coolify/gen-compose.mjs';
import {dueRetirement,retireDue} from './window.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const pairsFile=path.join(here,'../coolify/versions.json'),pairs=JSON.parse(fs.readFileSync(pairsFile,'utf8'));
const NOW='2026-11-09T12:00:00.000Z',IN7='2026-11-16T12:00:00.000Z';
const K=['11.55.92','11.55.93','11.55.94','11.55.95'];
// The multi-O11 images the kit builds, one per ODC version that stays (kept + retiring), with their label's kernels.
const images=Object.fromEntries(['1.7.32','1.7.31','1.7.30','1.7.29','1.7.28'].map((v,i)=>[v,{image:'docker.io/andrepereiramachado/ssam-server',tag:'prod-20261109-abc1234-odc'+v.replaceAll('.','')+'-o11kdeadbeef',sha256:String(i+1).repeat(64),kernels:K}]));
// Two backends' captures (affected-customers.mjs source): the same token seen on both keeps the newest.
const captures=[{ok:true,backend:'o11-11.55.92-odc-1.7.28',telemetry:{tokens:{t1:{customer:'Acme',seen:'2026-11-08T10:00:00Z',odc:{installed:'1.7.28.100'}},v:{customer:'Version verification',verification:true,odc:{installed:'1.7.28.1'}}}}},
 {ok:true,backend:'o11-11.55.95-odc-1.7.32',telemetry:{tokens:{t1:{customer:'Acme',seen:'2026-11-01T10:00:00Z',odc:{installed:'1.7.32.1'}},t2:{customer:'Beta',seen:'2026-11-08T11:00:00Z',odc:{installed:'1.7.32.5'}}}}}];

test('the committed pair window becomes five ODC backends with 1.7.28 retiring for 7 days',async()=>{
 const r=await firstBackendWindow(pairs,{images,now:NOW});
 assert.ok(isBackendManifest(r.manifest));
 assert.deepEqual(r.plan.backends,['odc-1.7.32','odc-1.7.31','odc-1.7.30','odc-1.7.29','odc-1.7.28']);
 assert.deepEqual(r.plan.o11,K);
 assert.deepEqual(r.manifest.retiring,{odc:{version:'1.7.28',retireAt:IN7}});
 assert.deepEqual(r.plan.retired,[]);
 assert.deepEqual(r.manifest.backends.map(b=>b.sha256),['1','2','3','4','5'].map(c=>c.repeat(64)));
 assert.ok(r.manifest.backends.every(b=>b.o11Kernels.join()===K.join()));
 assert.equal(JSON.parse(servedLists(r.manifest)[0]).retiring.odc.version,'1.7.28');
 assert.equal(r.text,JSON.stringify(r.manifest,null,2)+'\n');
 // It is a real grace: due on day 7, and its retirement round only removes that backend.
 assert.equal(dueRetirement(r.manifest,Date.parse(IN7)-1),null);
 assert.deepEqual(retireDue(r.manifest,{now:Date.parse(IN7)}).manifest.backends.map(b=>b.odc),['1.7.32','1.7.31','1.7.30','1.7.29']);
});

test('the kit plan: 5 backends, router window 5, each with its pair to migrate from, its kernel.json and what the compose must show',async()=>{
 const {kit}=await firstBackendWindow(pairs,{images,now:NOW});
 assert.equal(kit.count,5);assert.equal(kit.routerWindow,5);assert.equal(kit.defaultO11,'11.55.95');
 assert.deepEqual(kit.servedVersions,{odc:['1.7.32','1.7.31','1.7.30','1.7.29','1.7.28'],o11:K,retiring:{odc:{version:'1.7.28',retireAt:IN7}}});
 const old=kit.backends.find(b=>b.odc==='1.7.28');
 assert.equal(old.retiring,true);assert.equal(old.name,'odc-1.7.28');
 const pair=pairs.o11.find(o=>o.tag===pairs.odc.find(e=>e.version==='1.7.28').tag).version;
 assert.equal(old.from.pair,`o11-${pair}-odc-1.7.28`);
 assert.equal(old.from.customerState,`state/versions/o11-${pair}-odc-1.7.28`);assert.equal(old.customerState,'state/versions/odc-1.7.28');
 assert.deepEqual(old.kernel,{from:`/data/server/versions/o11-${pair}-odc-1.7.28/kernel.json`,set:{o11:'11.55.95'},to:'/data/server/versions/odc-1.7.28/kernel.json'});
 assert.match(old.from.odcFeatures,/^odc-features-o11-.*odc-1-7-28$/);assert.equal(old.volumes.odcFeatures,'odc-features-odc-1-7-28');
 assert.deepEqual(old.o11Kernels,K);
 assert.equal(kit.backends.filter(b=>b.default).map(b=>b.odc).join(),'1.7.32');
 for(const b of kit.backends){assert.equal(JSON.parse(b.expect.SSAM_SERVED_VERSIONS).odc.length,5);assert.equal(b.expect.labels['ssam.o11'],K.join(','));}
 if(kit.hostBudget)assert.ok(kit.hostBudget.used<=kit.hostBudget.available);
});

test('the window-retiring notice of 1.7.28 names the customers seen on it, from the live usage data of every backend',async t=>{
 const tokens=mergeTelemetry(captures);
 assert.equal(tokens.t1.seen,'2026-11-08T10:00:00Z');
 const r=await firstBackendWindow(pairs,{images,now:NOW,tokens});
 assert.equal(r.plan.affected,1);assert.equal(r.kit.affected,1);
 const [n]=r.notice;assert.equal(n.name,'window-retiring');assert.equal(n.code,'WINDOW_RETIRING');
 assert.match(n.message,/ODC Studio 1\.7\.28 leaves SSAM on 2026-11-16/);assert.match(n.message,/Acme/);
 assert.ok(n.affected.every(a=>!('token' in a)&&/^[a-f0-9]{12}$/.test(a.client)));
 assert.doesNotMatch((await retiringNotice(tokens,{lane:'odc',version:'1.7.28',retireAt:IN7,notifyAffected:false})).message,/Acme/);
 assert.throws(()=>mergeTelemetry([{ok:false}]),/not readable/);
 // The capture each backend runs is read-only: it issues and revokes nothing.
 assert.doesNotMatch(CAPTURE_SOURCE,/issue|revoke|write/);
});

test('the generator stops on a missing or unpinned image, kernels without a served version, and a missing switch time',async()=>{
 const missing={...images};delete missing['1.7.28'];
 await assert.rejects(firstBackendWindow(pairs,{images:missing,now:NOW}),/backend odc-1\.7\.28/);
 await assert.rejects(firstBackendWindow(pairs,{images:{...images,'1.7.30':{...images['1.7.30'],sha256:undefined}},now:NOW}),/odc-1\.7\.30 has no pinned digest/);
 await assert.rejects(firstBackendWindow(pairs,{images:{...images,'1.7.30':{...images['1.7.30'],kernels:K.slice(1)}},now:NOW}),/lacks the O11 kernels 11\.55\.92/);
 await assert.rejects(firstBackendWindow(pairs,{images:{...images,'1.7.30':{...images['1.7.30'],kernels:['11.55']}},now:NOW}),/three-part/);
 await assert.rejects(firstBackendWindow(pairs,{images}),/switch time/);
});

test('the command lines write the versions.json, the kit plan and the notice; affected-customers prints the capture and the notice',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'first-window-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const imagesFile=path.join(dir,'images.json'),out=path.join(dir,'versions.json'),plan=path.join(dir,'kit.json'),notice=path.join(dir,'notice.json');fs.writeFileSync(imagesFile,JSON.stringify(images));
 const files=captures.map((c,i)=>{const f=path.join(dir,`t${i}.json`);fs.writeFileSync(f,JSON.stringify(c));return f;});
 const r=spawnSync(process.execPath,[path.join(here,'first-window.mjs'),'--pairs',pairsFile,'--images',imagesFile,'--now',NOW,'--telemetry',files.join(','),'--out',out,'--plan-out',plan,'--notice-out',notice],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 assert.deepEqual(JSON.parse(r.stderr).retiring,[{lane:'odc',version:'1.7.28',retireAt:IN7}]);
 assert.deepEqual(JSON.parse(fs.readFileSync(out,'utf8')).retiring,{odc:{version:'1.7.28',retireAt:IN7}});
 assert.equal(JSON.parse(fs.readFileSync(plan,'utf8')).count,5);
 // --notice-out and affected-customers.mjs notice write the same object (review B13).
 const written=JSON.parse(fs.readFileSync(notice,'utf8'));assert.match(written.message,/Acme/);
 versionBackends(JSON.parse(fs.readFileSync(out,'utf8')));
 const bad=spawnSync(process.execPath,[path.join(here,'first-window.mjs'),'--pairs',pairsFile,'--images',imagesFile],{encoding:'utf8'});
 assert.equal(bad.status,1);assert.match(bad.stderr,/--now is required/);
 const source=spawnSync(process.execPath,[path.join(here,'affected-customers.mjs'),'source'],{encoding:'utf8'});
 assert.equal(source.status,0);assert.equal(source.stdout,CAPTURE_SOURCE);
 const told=spawnSync(process.execPath,[path.join(here,'affected-customers.mjs'),'notice','--telemetry',files.join(','),'--lane','odc','--version','1.7.28','--retire-at',IN7],{encoding:'utf8'});
 assert.equal(told.status,0,told.stderr);assert.equal(JSON.parse(told.stdout).affected.length,1);
 assert.deepEqual(JSON.parse(told.stdout),written,'the same notice, in the same format');
});
