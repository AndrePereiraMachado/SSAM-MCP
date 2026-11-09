// The first backend window (S1 switch) is generated from the committed pair versions.json: ODC 1.7.28 enters a 7-day grace
// instead of being cut, every backend is pinned, and the result generates its compose (first-window.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {firstBackendWindow} from './first-window.mjs';
import {servedLists,isBackendManifest} from '../coolify/gen-compose.mjs';
import {dueRetirement,retireDue} from './window.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const pairsFile=path.join(here,'../coolify/versions.json'),pairs=JSON.parse(fs.readFileSync(pairsFile,'utf8'));
const NOW='2026-11-09T12:00:00.000Z',IN7='2026-11-16T12:00:00.000Z';
// The multi-O11 images the kit builds, one per ODC version that stays (kept + retiring).
const images=Object.fromEntries(['1.7.32','1.7.31','1.7.30','1.7.29','1.7.28'].map((v,i)=>[v,{image:'docker.io/andrepereiramachado/ssam-server',tag:'prod-20261109-abc1234-odc'+v.replaceAll('.','')+'-o11kdeadbeef',sha256:String(i+1).repeat(64)}]));

test('the committed pair window becomes five ODC backends with 1.7.28 retiring for 7 days',()=>{
 const r=firstBackendWindow(pairs,{images,now:NOW});
 assert.ok(isBackendManifest(r.manifest));
 assert.deepEqual(r.plan.backends,['odc-1.7.32','odc-1.7.31','odc-1.7.30','odc-1.7.29','odc-1.7.28']);
 assert.deepEqual(r.plan.o11,['11.55.92','11.55.93','11.55.94','11.55.95']);
 assert.deepEqual(r.manifest.retiring,{odc:{version:'1.7.28',retireAt:IN7}});
 assert.deepEqual(r.plan.retired,[]);
 assert.deepEqual(r.manifest.backends.map(b=>b.sha256),['1','2','3','4','5'].map(c=>c.repeat(64)));
 assert.equal(JSON.parse(servedLists(r.manifest)[0]).retiring.odc.version,'1.7.28');
 assert.equal(r.text,JSON.stringify(r.manifest,null,2)+'\n');
 // It is a real grace: due on day 7, and its retirement round only removes that backend.
 assert.equal(dueRetirement(r.manifest,Date.parse(IN7)-1),null);
 assert.deepEqual(retireDue(r.manifest,{now:Date.parse(IN7)}).manifest.backends.map(b=>b.odc),['1.7.32','1.7.31','1.7.30','1.7.29']);
});

test('the generator stops on a missing or unpinned image and on a missing switch time',()=>{
 const missing={...images};delete missing['1.7.28'];
 assert.throws(()=>firstBackendWindow(pairs,{images:missing,now:NOW}),/backend odc-1\.7\.28/);
 assert.throws(()=>firstBackendWindow(pairs,{images:{...images,'1.7.30':{...images['1.7.30'],sha256:undefined}},now:NOW}),/odc-1\.7\.30 has no pinned digest/);
 assert.throws(()=>firstBackendWindow(pairs,{images}),/switch time/);
});

test('the command line writes the versions.json and prints the plan',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'first-window-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const imagesFile=path.join(dir,'images.json'),out=path.join(dir,'versions.json');fs.writeFileSync(imagesFile,JSON.stringify(images));
 const r=spawnSync(process.execPath,[path.join(here,'first-window.mjs'),'--pairs',pairsFile,'--images',imagesFile,'--now',NOW,'--out',out],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 assert.deepEqual(JSON.parse(r.stderr).retiring,[{lane:'odc',version:'1.7.28',retireAt:IN7}]);
 assert.deepEqual(JSON.parse(fs.readFileSync(out,'utf8')).retiring,{odc:{version:'1.7.28',retireAt:IN7}});
 const bad=spawnSync(process.execPath,[path.join(here,'first-window.mjs'),'--pairs',pairsFile,'--images',imagesFile],{encoding:'utf8'});
 assert.equal(bad.status,1);assert.match(bad.stderr,/--now is required/);
});
