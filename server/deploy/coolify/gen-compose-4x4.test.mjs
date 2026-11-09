// Window 4x4, phase S1 (design B: C:/t/r5/janela-4x4/DESENHO.md 1.4 item 8): the compose of a backend window. One backend per
// ODC version named odc-<version> (newest first: ssam-server-v1 is the router's default), each serving every O11 version of
// the window, the same served list on every backend, the shared read-only bridge store, and the r45 capacity rules (hot 10g /
// 5 vCPU / 4 builds, others 4240m / 1 build, chosen by use) keyed by backend name. A pair window is generated as before
// (gen-compose.test.mjs pins the committed compose).
import '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateCompose,versionBackends,backendsOf,servedLists,withUsage,hotPairName,hostBudget,sizedExpectations,isBackendManifest,BRIDGES_VOLUME,BRIDGES_TARGET,CAPACITY_WINDOW} from './gen-compose.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const live=JSON.parse(fs.readFileSync(path.join(here,'versions.json'),'utf8').replace(/^\uFEFF/,''));
const image='docker.io/andrepereiramachado/ssam-server';
const O11=['11.55.92','11.55.93','11.55.94','11.55.95'];
const sha=c=>c.repeat(64);
// The r45 sizing as committed (versions.json), with the use re-keyed by backend name (the S1 deploy kit does this, withUsage).
const sizing={...structuredClone(live.sizing),usage:{'odc-1.7.31':{heavy:1044,active:1},'odc-1.7.30':{heavy:6,active:3},'odc-1.7.29':{heavy:0,active:1},'odc-1.7.32':{heavy:0,active:1}}};
const manifest={window:4,o11:{served:O11},sizing,backends:[
 {odc:'1.7.29',image,tag:'prod-4x4-odc1729',sha256:sha('a')},{odc:'1.7.32',image,tag:'prod-4x4-odc1732',sha256:sha('b')},
 {odc:'1.7.30',image,tag:'prod-4x4-odc1730',sha256:sha('c')},{odc:'1.7.31',image,tag:'prod-4x4-odc1731',sha256:sha('d')}]};

test('4x4: one backend per ODC version, newest first and default, each serving the whole window',()=>{
 assert.equal(isBackendManifest(manifest),true);assert.equal(isBackendManifest(live),false);
 const backends=versionBackends(manifest);
 assert.deepEqual(backends.map(b=>b.name),['odc-1.7.32','odc-1.7.31','odc-1.7.30','odc-1.7.29']);
 assert.deepEqual(backends.map(b=>b.o11),[O11,O11,O11,O11]);
 assert.deepEqual(backendsOf(manifest).map(b=>b.name),backends.map(b=>b.name));
 const served=servedLists(manifest);
 assert.equal(new Set(served).size,1,'one served list for every backend');
 assert.deepEqual(JSON.parse(served[0]),{odc:['1.7.32','1.7.31','1.7.30','1.7.29'],o11:O11});
 const c=generateCompose(manifest);
 assert.equal(c.services['ssam-server-v5'],undefined);
 for(const [i,b] of backends.entries()){
  const s=c.services[`ssam-server-v${i+1}`],dash=b.name.replaceAll('.','-');
  assert.equal(s.image,`${image}:prod-4x4-odc${b.odc.replaceAll('.','')}`,'Coolify gets the tag; the digest rides on a label');
  assert.deepEqual(s.labels['ssam.image.digest'],'sha256:'+sha('abcd'['1.7.29,1.7.32,1.7.30,1.7.31'.split(',').indexOf(b.odc)]));
  assert.equal(s.labels['ssam.odc'],b.odc);assert.equal(s.labels['ssam.o11'],O11.join(','));assert.equal(s.labels['ssam.default'],String(i===0));
  assert.equal(s.environment.SSAM_BACKEND_NAME,b.name);assert.equal(s.environment.SSAM_RUNTIME_DIR,'/data/server/versions/'+b.name);
  assert.equal(s.environment.SSAM_SERVED_VERSIONS,served[0]);
  const source=target=>s.volumes.find(v=>v.target===target)?.source;
  assert.equal(source('/data/cache'),'cache-'+dash);assert.equal(source('/data/odc-features'),'odc-features-'+dash);
  assert.ok(c.volumes['cache-'+dash]&&c.volumes['odc-features-'+dash]);
  const bridges=s.volumes.filter(v=>v.target===BRIDGES_TARGET);
  assert.deepEqual(bridges,[{type:'volume',source:BRIDGES_VOLUME,target:BRIDGES_TARGET,read_only:true}]);
  assert.equal(s.environment.SSAM_BRIDGES_DIR,BRIDGES_TARGET);assert.equal(s.environment.SSAM_BRIDGES_PUBLIC_KEY,undefined,'the trust anchor stays in the image');
 }
 assert.ok(BRIDGES_VOLUME in c.volumes);
 for(const name of ['ssam-router','ssam-console','ssam-admin'])for(const v of c.services[name]?.volumes??[])assert.notEqual(v.source,BRIDGES_VOLUME,name);
 for(const name of ['ssam-admin','ssam-console'])for(const v of c.services[name]?.volumes??[])if(v.target==='/data/cache')assert.equal(v.source,'cache-odc-1-7-32');
 const router=c.services['ssam-router'];
 assert.equal(router.environment.SSAM_VERSION_WINDOW,'4');
 const routing=JSON.parse(router.environment.SSAM_ROUTER_BACKENDS);
 assert.deepEqual(routing.map(r=>[r.name,r.url,r.odc,r.default]),backends.map((b,i)=>[b.name,`http://ssam-server-v${i+1}:7310`,b.odc,i===0]));
 for(const r of routing)assert.deepEqual(r.o11,O11);
 assert.equal(router.image,c.services['ssam-server-v1'].image);
});

test('4x4: the r45 capacity rules hold, keyed by backend name: hot by use or pin, others 4240m / 1 build, the host budget',()=>{
 const c=generateCompose(manifest);
 const tierOf=odc=>Object.values(c.services).find(s=>s.labels?.['ssam.odc']===odc).labels['ssam.sizing'];
 assert.deepEqual(['1.7.32','1.7.31','1.7.30','1.7.29'].map(tierOf),['other','hot','other','other'],'the most heavy calls: odc-1.7.31');
 const hot=Object.values(c.services).find(s=>s.labels?.['ssam.sizing']==='hot');
 assert.equal(hot.deploy.resources.limits.memory,'10g');assert.equal(hot.deploy.resources.limits.cpus,'5');assert.equal(hot.cpu_shares,5776);
 assert.equal(hot.environment.SSAM_BUILD_WORKERS,'4');
 for(const s of Object.values(c.services).filter(s=>s.labels?.['ssam.sizing']==='other')){
  assert.equal(s.deploy.resources.limits.memory,'4240m');assert.equal(s.cpu_shares,1024);assert.equal(s.environment.SSAM_BUILD_WORKERS,'1');
 }
 assert.equal(hotPairName(manifest),'odc-1.7.31');
 assert.equal(hotPairName({...manifest,sizing:{...sizing,hotPair:'odc-1.7.29'}}),'odc-1.7.29','the owner pin, by backend name');
 assert.throws(()=>generateCompose({...manifest,sizing:{...sizing,hotPair:'o11-11.55.94-odc-1.7.31'}}),/names no pair/,'a pair name pins nothing in a backend window');
 assert.equal(hotPairName({...manifest,sizing:{...sizing,usage:undefined}}),'odc-1.7.32','no counts: the default');
 const budget=hostBudget(manifest);
 assert.equal(budget.pairs,4);assert.ok(budget.used<=budget.available,JSON.stringify(budget));
 assert.throws(()=>hostBudget({...manifest,sizing:{...sizing,other:{...sizing.other,memory:'8g'}}}),e=>e.code===CAPACITY_WINDOW);
 const expected=sizedExpectations(manifest);
 assert.equal(expected['ssam-server-v2'].pair,'odc-1.7.31');assert.equal(expected['ssam-server-v2'].tier,'hot');
 assert.equal(JSON.parse(c.services['ssam-router'].labels['ssam.sizing']).usage['odc-1.7.31'].heavy,1044);
});

test('4x4: the first deploy carries the pair counts into the backend of their ODC version; a version that left folds into the default',()=>{
 const counted={'o11-11.55.94-odc-1.7.31':{heavy:1044,active:1},'o11-11.55.94-odc-1.7.30':{heavy:6,active:3},'o11-11.55.93-odc-1.7.29':{heavy:0,active:1},
  'o11-11.55.95-odc-1.7.32':{heavy:0,active:1},'o11-11.55.92-odc-1.7.28':{heavy:5,active:2},'odc-1.7.30':{heavy:1,active:0},junk:{heavy:1}};
 const next=withUsage({...manifest,sizing:{...sizing,usage:{}}},counted);
 assert.deepEqual(next.sizing.usage,{'odc-1.7.29':{heavy:0,active:1},'odc-1.7.30':{heavy:7,active:3},'odc-1.7.31':{heavy:1044,active:1},'odc-1.7.32':{heavy:5,active:3}});
 assert.equal(hotPairName(next),'odc-1.7.31');
 // The pair window keeps folding into its first pair, as before (the counts replace the recorded ones).
 const first=`o11-${live.o11.find(o=>o.tag===live.odc[0].tag).version}-odc-${live.odc[0].version}`;
 assert.deepEqual(withUsage(live,{'o11-11.55.91-odc-1.7.27':{heavy:3,active:1}}).sizing.usage,{[first]:{heavy:3,active:1}});
});

test('4x4: a backend window that does not hold together is refused',()=>{
 const bad=patch=>()=>generateCompose({...manifest,...patch});
 assert.throws(bad({keepServed:4}),/keepServed belongs to a pair window/);
 assert.throws(bad({odc:[]}),/no "odc" list/);
 assert.throws(bad({o11:undefined}),/o11 \{served/);
 assert.throws(bad({o11:{served:['11.55.92','11.55.92']}}),/Invalid o11.served/);
 assert.throws(bad({o11:{served:O11,kernels:['11.55.92','11.55.93']}}),/every served O11 version needs its kernel/);
 assert.throws(bad({o11:{served:O11,extra:1}}),/o11 \{served/);
 assert.throws(bad({backends:[...manifest.backends,{odc:'1.7.28',image,tag:'x'}]}),/fit the window/);
 assert.throws(bad({backends:[{...manifest.backends[0],tag:'latest'}]}),/pinned image/);
 assert.throws(bad({backends:[{...manifest.backends[0],sha256:'abc'}]}),/digest/);
 assert.throws(bad({backends:[manifest.backends[0],{...manifest.backends[1],odc:'1.7.29'}]}),/Duplicate backend/);
 assert.throws(bad({backends:[{...manifest.backends[0],o11Kernels:['11.55.92','11.55.93','11.55.94']}]}),/lacks the O11 kernels 11\.55\.95/);
 assert.throws(bad({backends:[{...manifest.backends[0],served:{}}]}),/Invalid backend entry/);
 // A narrower served list than the kernels: the extra kernel stays in the image, unserved (retired from the window).
 const narrow=generateCompose({...manifest,o11:{served:O11.slice(1),kernels:O11}});
 assert.deepEqual(JSON.parse(narrow.services['ssam-server-v1'].environment.SSAM_SERVED_VERSIONS).o11,O11.slice(1));
 assert.equal(narrow.services['ssam-server-v1'].labels['ssam.o11'],O11.slice(1).join(','));
 // Window defaults: a backend window is 4, a pair window 3.
 const {window:_,...noWindow}=manifest;
 assert.equal(generateCompose(noWindow).services['ssam-router'].environment.SSAM_VERSION_WINDOW,'4');
});

// Review S1 M2, R3 (B-R2-2): the ceiling of resident O11 readers of each backend (reader-residency.mjs SSAM_O11_READERS_MAX)
// comes from the tier, else every O11 version of the window (the gate decides how many fit).
test('4x4: each backend names its O11 reader ceiling by tier (every O11 version by default, or the tier value); a pair window does not',()=>{
 const c=generateCompose(manifest);
 for(const [name,s] of Object.entries(c.services).filter(([n])=>n.startsWith('ssam-server-v')))
  assert.equal(s.environment.SSAM_O11_READERS_MAX,String(O11.length),name);
 const expected=sizedExpectations(manifest);
 for(const e of Object.values(expected).filter(e=>e.tier))assert.equal(e.env.SSAM_O11_READERS_MAX,String(O11.length));
 const tuned=generateCompose({...manifest,sizing:{...sizing,hot:{...sizing.hot,o11Readers:3}}});
 assert.equal(Object.values(tuned.services).find(s=>s.labels?.['ssam.sizing']==='hot').environment.SSAM_O11_READERS_MAX,'3');
 assert.throws(()=>generateCompose({...manifest,sizing:{...sizing,other:{...sizing.other,o11Readers:0}}}),/o11Readers/);
 const measured=generateCompose({...manifest,sizing:{...sizing,other:{...sizing.other,o11ReaderMb:650}}});
 for(const [name,sv] of Object.entries(measured.services).filter(([n])=>n.startsWith('ssam-server-v')))
  assert.equal(sv.environment.SSAM_MEMORY_RESERVE_READER_MB,sv.labels['ssam.sizing']==='other'?'650':undefined,name);
 assert.throws(()=>generateCompose({...manifest,sizing:{...sizing,hot:{...sizing.hot,o11ReaderMb:10}}}),/o11ReaderMb/);
 const pairs=generateCompose(live);
 for(const s of Object.values(pairs.services))assert.equal(s.environment?.SSAM_O11_READERS_MAX,undefined,'a pair window is unchanged');
});

// S1 R3 (option 2): idle resident workers leave memory sooner: ANVIL_WORKER_IDLE_MINUTES per tier (hot 120, other 30), the
// tier's workerIdleMinutes when it names one (0 never exits); a pair window keeps the kernel's default (unset, 240).
test('4x4: each backend sets the idle exit of its resident workers by tier (hot 120, other 30, or the tier value); a pair window does not',()=>{
 const c=generateCompose(manifest);
 const servers=Object.entries(c.services).filter(([n])=>n.startsWith('ssam-server-v'));
 assert.ok(servers.some(([,s])=>s.labels['ssam.sizing']==='hot')&&servers.some(([,s])=>s.labels['ssam.sizing']==='other'));
 for(const [name,s] of servers)assert.equal(s.environment.ANVIL_WORKER_IDLE_MINUTES,s.labels['ssam.sizing']==='hot'?'120':'30',name);
 for(const e of Object.values(sizedExpectations(manifest)).filter(e=>e.tier))assert.equal(e.env.ANVIL_WORKER_IDLE_MINUTES,e.tier==='hot'?'120':'30');
 const tuned=generateCompose({...manifest,sizing:{...sizing,other:{...sizing.other,workerIdleMinutes:0}}});
 for(const [name,s] of Object.entries(tuned.services).filter(([n])=>n.startsWith('ssam-server-v')))
  assert.equal(s.environment.ANVIL_WORKER_IDLE_MINUTES,s.labels['ssam.sizing']==='hot'?'120':'0',name);
 assert.throws(()=>generateCompose({...manifest,sizing:{...sizing,hot:{...sizing.hot,workerIdleMinutes:-1}}}),/workerIdleMinutes/);
 assert.throws(()=>generateCompose({...manifest,sizing:{...sizing,hot:{...sizing.hot,workerIdleMinutes:1.5}}}),/workerIdleMinutes/);
 for(const s of Object.values(generateCompose(live).services))assert.equal(s.environment?.ANVIL_WORKER_IDLE_MINUTES,undefined,'a pair window is unchanged');
});
