import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {detectSources,latestStudio,pinOdc,redecideOdc,downloadInstaller,downloadUrl,officialUrl,releaseFor,contentLink,parseOdcNotes,judgeOdc,cleanText,TRUSTED_HOSTS,DOWNLOAD_HOSTS,DOWNLOADS,ODC_NOTES_PAGE,ODC_RULE} from './sources.mjs';
import {fakeSites} from './test-fixtures/sources/fake.mjs';
const H=3600000,DAY=24*H;
// The round clock is pinned: the ODC rule depends on it. 2026-11-10 00:00Z is past the cutoff of 1.7.32 (2026-11-09 16:00Z).
const NOW=Date.parse('2026-11-10T00:00:00Z');
const fast={retryDelayMs:0,now:NOW};
const HUB='https://api.outsystems.com/releaseshub/v1/component/';
const CF='https://dxejw4oyledi.cloudfront.net/repository/odcstudio/';
const odcInstalled=[{lane:'odc',version:'1.7.31',fullVersion:'1.7.31.10988'}];
const tmp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'vigia-sources-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
const probes=f=>f.state.calls.filter(c=>c.includes('/releaseshub/'));
const probedBuilds=f=>probes(f).map(c=>Number(c.match(/\/version\/\d+\.\d+\.\d+\.(\d+)\//)?.[1])).filter(Boolean);
// Every ODC Studio build 1.7.27..1.7.32 on releaseshub with its CloudFront Last-Modified (to the minute), read live and
// read-only on 2026-11-09 (C:\t\r5\sources-fix\evidence-output.txt); ga: the build each version shipped as.
const HISTORY={
 '1.7.27':{releasedOn:'2026-10-02',ga:10846,uploads:{10810:'2026-09-28T13:05Z',10846:'2026-10-02T14:16Z'}},
 '1.7.28':{releasedOn:'2026-10-12',ga:10873,uploads:{10850:'2026-10-12T09:06Z',10873:'2026-10-13T08:45Z'}},
 '1.7.29':{releasedOn:'2026-10-19',ga:10940,uploads:{10909:'2026-10-13T22:04Z',10940:'2026-10-19T11:35Z',10953:'2026-10-21T00:32Z'}},
 '1.7.30':{releasedOn:'2026-10-26',ga:10980,uploads:{10945:'2026-10-19T17:17Z',10954:'2026-10-26T15:17Z',10980:'2026-10-26T16:44Z'}},
 '1.7.31':{releasedOn:'2026-11-02',ga:10988,uploads:{10988:'2026-11-02T09:06Z'}},
 '1.7.32':{releasedOn:'2026-11-08',ga:11065,uploads:{11035:'2026-11-02T23:39Z',11059:'2026-11-05T18:49Z',11065:'2026-11-08T09:40Z'}}
};
const HIST={known:{version:'1.7.26',build:10800}};
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const notesFor=(version,releasedOn,extra='')=>{const d=new Date(releasedOn+'T00:00:00Z');return `<h2 id="odc_studio_${version}" >ODC Studio ${version}</h2>\r\n<div class="info"><p>Released on ${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2,'0')}, ${d.getUTCFullYear()}</p></div>\r\n<ul><li>(trimmed)</li>${extra}</ul>`;};
// The releaseshub of one ODC version as it stood at now: only builds already uploaded exist.
function odcAt(f,version,now,{uploads=HISTORY[version]?.uploads??{},releasedOn=HISTORY[version]?.releasedOn,extra=''}={}){
 for(const k of Object.keys(f.state.hub))if(k.startsWith('ODCStudio/'))delete f.state.hub[k];
 for(const [b,at] of Object.entries(uploads))if(Date.parse(at)<=now)f.state.hub[`ODCStudio/${version}.${b}/windows`]={location:`${CF}${version}.${b}/ODCStudio-${version}.${b}.exe`,lastModified:new Date(at).toUTCString(),size:287000000+Number(b)};
 f.state.content.data.Html=notesFor(version,releasedOn,extra);f.state.calls.length=0;
}
const at=s=>Date.parse(s);

test('O11: the Downloads page names Service Studio with build, sizes and Windows + Mac (Intel, ARM) links',async()=>{
 const {fetcher}=fakeSites();
 const r=await latestStudio('o11',undefined,{fetcher,...fast});
 assert.equal(r.fullVersion,'11.55.95.65352');assert.equal(r.version,'11.55.95');assert.equal(r.source,DOWNLOADS);
 assert.equal(r.url,HUB+'ServiceStudio/version/11.55.95.65352/platform/windows/content');assert.equal(r.size,351668800);
 assert.deepEqual(r.platforms.macosx,{fullVersion:'11.55.95.65352',url:HUB+'ServiceStudio/version/11.55.95.65352/platform/macosx/content',file:'ServiceStudio-11.55.95.65352.dmg',size:457849738});
 assert.deepEqual(r.platforms.macosx_arm64,{fullVersion:'11.55.95.65352',url:HUB+'ServiceStudio/version/11.55.95.65352/platform/macosx_arm64/content',file:'ServiceStudio-11.55.95.65352_arm64.dmg',size:443612066});
 assert.equal(r.platforms.windows.file,'ServiceStudio-11.55.95.65352.exe');
});

test('ODC: the release notes name 1.7.32; past its cutoff the decision is its highest eligible build (11065, not the early 11035/11059)',async()=>{
 const {fetcher,state}=fakeSites();
 const r=await latestStudio('odc','1.7.31.10988',{fetcher,...fast});
 assert.equal(r.fullVersion,'1.7.32.11065');assert.equal(r.releasedOn,'2026-11-08');assert.equal(r.source,ODC_NOTES_PAGE);
 assert.equal(r.url,HUB+'ODCStudio/version/1.7.32.11065/platform/windows/content');assert.equal(r.size,287852448);
 assert.equal(r.platforms.macosx.url,HUB+'ODCStudio/version/1.7.32.11065/platform/macosx/content');
 assert.equal(r.platforms.macosx_arm64.file,'ODCStudio-1.7.32.11065_arm64.dmg');
 assert.deepEqual(r.decided,{at:new Date(NOW).toISOString(),by:'cutoff'});
 // The first search starts at the last known GA (11065), never at the installed build, and asks only about the noted version.
 const p=state.calls.filter(c=>c.includes('/releaseshub/'));
 assert.equal(p.length,601);assert.ok(p.every(c=>c.includes('/ODCStudio/version/1.7.32.')));
 assert.ok(p.some(c=>c.includes('1.7.32.11065/'))&&p.some(c=>c.includes('1.7.32.11665/'))&&!p.some(c=>c.includes('1.7.32.11064/')));
 assert.deepEqual(parseOdcNotes(state.content.data.Html).map(n=>`${n.version} ${n.releasedOn}`),['1.7.32 2026-11-08','1.7.31 2026-11-02','1.7.30 2026-10-26','1.7.29 2026-10-19']);
});

test('A1: on 2026-10-26 16:00Z with 10945 and 10954 uploaded, 1.7.30 is NOT decided (never 10954); the GA 10980 is decided at the cutoff and kept',async()=>{
 const f=fakeSites(),state={},o=t=>({fetcher:f.fetcher,...fast,...HIST,now:t,state});
 odcAt(f,'1.7.30',at('2026-10-26T16:00Z'));
 assert.deepEqual(Object.keys(f.state.hub).filter(k=>k.startsWith('ODCStudio/')).sort(),['ODCStudio/1.7.30.10945/windows','ODCStudio/1.7.30.10954/windows']);
 let r=await latestStudio('odc',undefined,o(at('2026-10-26T16:00Z')));
 assert.equal(r.fullVersion,null);assert.deepEqual(r.pending,{build:10954,definitiveAt:'2026-10-27T16:00:00.000Z',seen:[10945,10954]});
 // Through the round: pending, nothing offered, nothing decided.
 odcAt(f,'1.7.30',at('2026-10-26T16:00Z'));
 const round=await detectSources([],{fetcher:f.fetcher,...fast,...HIST,now:at('2026-10-26T16:00Z'),state:{},served:{odc:['1.7.29']}});
 assert.equal(round.sources[0].status,'pending');assert.ok(!round.observed.some(x=>x.lane==='odc'));
 // 16:44Z the GA arrives; 18:00Z still not definitive (the cutoff is D+1 16:00Z, and the newest upload is not 28 h old).
 odcAt(f,'1.7.30',at('2026-10-26T18:00Z'));
 r=await latestStudio('odc',undefined,o(at('2026-10-26T18:00Z')));
 assert.equal(r.fullVersion,null);assert.equal(r.pending.build,10980);
 assert.ok(Math.min(...probedBuilds(f))===10955,'later rounds probe only above the last find');assert.equal(probes(f).length,101);
 odcAt(f,'1.7.30',at('2026-10-27T15:59Z'));
 assert.equal((await latestStudio('odc',undefined,o(at('2026-10-27T15:59Z')))).fullVersion,null);
 odcAt(f,'1.7.30',at('2026-10-27T16:00Z'));
 r=await latestStudio('odc',undefined,o(at('2026-10-27T16:00Z')));
 assert.equal(r.fullVersion,'1.7.30.10980');assert.equal(r.decided.by,'cutoff');
 const d=state.odc.versions['1.7.30'].decided;
 assert.equal(d.build,10980);assert.equal(d.hoursAfterRelease,16.73);assert.equal(d.marginToCutoffHours,23.27);assert.deepEqual(d.early,[10945]);
 assert.deepEqual(d.distances,{10945:-150.72,10954:15.28,10980:16.73});
 // Decided: zero probes from now on, even if CloudFront re-uploads the file (its Last-Modified moves past the cutoff).
 odcAt(f,'1.7.30',at('2026-11-01T00:00Z'),{uploads:{...HISTORY['1.7.30'].uploads,10980:'2026-10-30T10:00Z'}});
 r=await latestStudio('odc',undefined,o(at('2026-11-01T00:00Z')));
 assert.equal(r.fullVersion,'1.7.30.10980');assert.equal(probes(f).length,0);assert.ok(!f.state.calls.some(c=>c.includes('cloudfront')));
});

test('A1: 1.7.28 is not locked on 10850 the release afternoon; the next-day 10873 is decided at the cutoff, never earlier',async()=>{
 const f=fakeSites(),state={},o=t=>({fetcher:f.fetcher,...fast,...HIST,now:t,state});
 for(const t of ['2026-10-12T10:00Z','2026-10-12T16:00Z','2026-10-12T23:00Z','2026-10-13T06:00Z','2026-10-13T10:00Z','2026-10-13T15:59Z']){
  odcAt(f,'1.7.28',at(t));const r=await latestStudio('odc',undefined,o(at(t)));
  assert.equal(r.fullVersion,null,t);assert.equal(r.pending.definitiveAt,'2026-10-13T16:00:00.000Z');
 }
 odcAt(f,'1.7.28',at('2026-10-13T16:00Z'));
 const r=await latestStudio('odc',undefined,o(at('2026-10-13T16:00Z')));
 assert.equal(r.fullVersion,'1.7.28.10873');assert.equal(r.decided.by,'cutoff');
 assert.equal(ODC_RULE.settleHours,undefined,'no early "settled" decision exists any more');
});

test('A1 replay: rounds every 2 h from D-1 to D+3 over the real uploads of 1.7.27..1.7.32 only ever decide the shipped build, once, at the cutoff',async()=>{
 const table={};
 for(const [version,h] of Object.entries(HISTORY)){
  const f=fakeSites(),state={},day=at(h.releasedOn+'T00:00Z');let decided=null;
  for(let now=day-DAY;now<=day+3*DAY;now+=2*H){
   odcAt(f,version,now);
   const r=await latestStudio('odc',undefined,{fetcher:f.fetcher,...fast,...HIST,now,state});
   if(decided){assert.equal(r.fullVersion,decided.v,version);assert.equal(probes(f).length,0,'a decided version is never probed');continue;}
   if(r.fullVersion){assert.equal(r.fullVersion,`${version}.${h.ga}`,`${version} at ${new Date(now).toISOString()}`);decided={v:r.fullVersion,at:now,by:r.decided.by};}
   else assert.ok(r.pending,version);
  }
  table[version]=`${decided.v} ${decided.by} D+${(decided.at-day)/H}h`;
 }
 assert.deepEqual(table,{'1.7.27':'1.7.27.10846 cutoff D+40h','1.7.28':'1.7.28.10873 cutoff D+40h','1.7.29':'1.7.29.10940 cutoff D+40h','1.7.30':'1.7.30.10980 cutoff D+40h','1.7.31':'1.7.31.10988 cutoff D+40h','1.7.32':'1.7.32.11065 cutoff D+40h'});
});

test('A1: the review timelines (S1 1.7.28 shifted 6 h, S2 notes before the GA with only a D-1 RC, S6 notes dated behind UTC) decide the GA, at the cutoff',async()=>{
 const cases={
  S1:{version:'1.7.28',releasedOn:'2026-10-12',uploads:{10850:'2026-10-12T03:00Z',10873:'2026-10-13T08:45Z'},ga:10873},
  S2:{version:'1.7.33',releasedOn:'2026-11-15',uploads:{11100:'2026-11-14T20:00Z',11120:'2026-11-16T06:00Z'},ga:11120},
  S6:{version:'1.7.33',releasedOn:'2026-11-15',uploads:{11110:'2026-11-15T02:00Z',11120:'2026-11-16T07:00Z'},ga:11120}
 };
 for(const [name,c] of Object.entries(cases)){
  const f=fakeSites(),state={},day=at(c.releasedOn+'T00:00Z'),cutoff=day+40*H;let decided=null;
  for(let now=day;now<=day+3*DAY;now+=2*H){
   odcAt(f,c.version,now,{uploads:c.uploads,releasedOn:c.releasedOn});
   const r=await latestStudio('odc',undefined,{fetcher:f.fetcher,...fast,...HIST,now,state});
   if(now<cutoff){assert.equal(r.fullVersion,null,`${name} decided before the cutoff at ${new Date(now).toISOString()}`);continue;}
   decided??={v:r.fullVersion,at:now};assert.equal(r.fullVersion,decided.v);
  }
  assert.deepEqual(decided,{v:`${c.version}.${c.ga}`,at:cutoff},name);
 }
});

test('A1: an announced version with only old release candidates never falls through to them (lower bound D-1)',async()=>{
 const f=fakeSites();
 const early={11035:'2026-11-02T23:39Z',11059:'2026-11-05T18:49Z'};
 odcAt(f,'1.7.32',at('2026-11-08T12:00Z'),{uploads:early});
 assert.equal((await latestStudio('odc',undefined,{fetcher:f.fetcher,...fast,...HIST,now:at('2026-11-08T12:00Z')})).pending.build,null);
 odcAt(f,'1.7.32',NOW,{uploads:early});
 await assert.rejects(latestStudio('odc',undefined,{fetcher:f.fetcher,...fast,...HIST}),e=>e.code==='STUDIO_BUILD_NOT_FOUND'&&/earlier: 11035, 11059/.test(e.message)&&/searched 10800\.\.11400/.test(e.message)&&/\{\{-Pin 1\.7\.32\.<build>\}\}/.test(e.action));
 assert.deepEqual(judgeOdc({releasedOn:'2026-11-08',uploads:{11059:{modified:'2026-11-07T00:00:00Z'}},now:NOW}).best.build,11059,'D-1 00:00Z itself is eligible');
});

// A store over two files (as auto-runtime keeps them): read(lane), write(lane, value).
const fileStore=dir=>({read:lane=>{const f=path.join(dir,lane+'.json');return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;},write:(lane,v)=>fs.writeFileSync(path.join(dir,lane+'.json'),JSON.stringify(v))});
test('A1/M1: a decided build is persisted and never changed; a later build of the same version is reported, never adopted',async t=>{
 const f=fakeSites(),dir=tmp(t),store=fileStore(dir),file=path.join(dir,'odc.json');
 const round=(now=NOW)=>detectSources([],{fetcher:f.fetcher,...fast,now,store,served:{odc:['1.7.31'],o11:['11.55.94']}});
 let seen=await round();
 assert.deepEqual(seen.sources.map(s=>[s.lane,s.status,s.version]),[['odc','public','1.7.32.11065'],['o11','public','11.55.95.65352']]);
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).versions['1.7.32'].decided.build,11065);
 // Next round, same notes: no releaseshub or CloudFront request at all (both lanes), and nothing written.
 f.state.calls.length=0;const mtime=fs.statSync(file).mtimeMs;
 seen=await round(NOW+2*H);
 assert.equal(seen.sources[0].version,'1.7.32.11065');assert.ok(!f.state.calls.some(c=>c.includes('/releaseshub/')||c.includes('cloudfront')));
 assert.equal(fs.statSync(file).mtimeMs,mtime);assert.equal(seen.sources[0].probes,0);
 // A hotfix 11090 is uploaded and the notes section changes: probed above the last find only, reported, the decision kept.
 f.state.hub['ODCStudio/1.7.32.11090/windows']={location:CF+'1.7.32.11090/ODCStudio-1.7.32.11090.exe',lastModified:'Wed, 11 Nov 2026 10:00:00 GMT',size:287900000};
 f.state.content.data.Html=f.state.content.data.Html.replace('<li>(trimmed)</li>','<li>(trimmed)</li><li>Fixed an issue.</li>');
 f.state.calls.length=0;seen=await round(NOW+2*DAY);
 assert.deepEqual([seen.sources[0].version,seen.sources[0].laterBuilds],['1.7.32.11065',[11090]]);
 assert.equal(Math.min(...probedBuilds(f)),11066);assert.equal(probes(f).length,101);
 const saved=JSON.parse(fs.readFileSync(file,'utf8')).versions['1.7.32'];
 assert.equal(saved.decided.build,11065);assert.equal(saved.notesChanges.length,1);
 f.state.calls.length=0;seen=await round(NOW+3*DAY);
 assert.deepEqual(seen.sources[0].laterBuilds,[11090]);assert.equal(probes(f).length,0);
});

test('B3: the notes of a decided version count as changed until a search after the change completes',async()=>{
 const f=fakeSites(),state={};
 await latestStudio('odc',undefined,{fetcher:f.fetcher,...fast,state});
 f.state.hub['ODCStudio/1.7.32.11090/windows']={location:CF+'1.7.32.11090/ODCStudio-1.7.32.11090.exe',lastModified:'Wed, 11 Nov 2026 10:00:00 GMT',size:287900000};
 f.state.content.data.Html=f.state.content.data.Html.replace('<li>(trimmed)</li>','<li>(trimmed)</li><li>Fixed.</li>');
 f.state.fail=u=>u.pathname.includes('/releaseshub/')?new Response('',{status:500}):null;
 await assert.rejects(latestStudio('odc',undefined,{fetcher:f.fetcher,...fast,now:NOW+DAY,state}),e=>e.code==='STUDIO_SOURCE_UNREACHABLE');
 f.state.fail=null;f.state.calls.length=0;
 const r=await latestStudio('odc',undefined,{fetcher:f.fetcher,...fast,now:NOW+DAY+2*H,state});
 assert.deepEqual([r.fullVersion,r.laterBuilds],['1.7.32.11065',[11090]]);assert.ok(probes(f).length>0);
});

test('M3: a decisions file that cannot be read stops the ODC lane only; one that cannot be written is never acted on',async()=>{
 const {fetcher}=fakeSites();
 let seen=await detectSources([],{fetcher,...fast,store:{read:lane=>{if(lane==='odc')throw Error('Journal MAC is invalid.');return null;},write:()=>{}}});
 assert.deepEqual(seen.sources.map(s=>[s.lane,s.status,s.code??s.version]),[['odc','unavailable','STUDIO_SOURCE_STATE'],['o11','public','11.55.95.65352']]);
 assert.match(seen.sources[0].ownerAction,/rename or delete studio-sources\.json/);
 assert.deepEqual(seen.observed.map(x=>x.fullVersion),['11.55.95.65352']);
 seen=await detectSources([],{fetcher,...fast,store:{read:()=>null,write:lane=>{if(lane==='odc')throw Error('disk full');}}});
 assert.deepEqual(seen.sources.map(s=>[s.lane,s.status,s.code??s.version]),[['odc','unavailable','STUDIO_SOURCE_STATE'],['o11','public','11.55.95.65352']]);
 assert.deepEqual(seen.observed.map(x=>x.fullVersion),['11.55.95.65352']);
});

test('M1: Service Studio already checked on releaseshub is not probed again; a changed answer is',async()=>{
 const f=fakeSites(),state={};
 await latestStudio('o11',undefined,{fetcher:f.fetcher,...fast,state});
 f.state.calls.length=0;await latestStudio('o11',undefined,{fetcher:f.fetcher,...fast,state});
 assert.ok(!f.state.calls.some(c=>c.includes('/releaseshub/')||c.includes('cloudfront')));
 assert.equal(f.state.calls.filter(c=>c.startsWith('POST')).length,2);
 f.state.releases.win.data.ReleaseDownloadList.List[0].Filesize='351668801';f.state.calls.length=0;
 await assert.rejects(latestStudio('o11',undefined,{fetcher:f.fetcher,...fast,state}),e=>e.code==='STUDIO_SOURCE_CHANGED'&&/size/.test(e.message));
 assert.ok(f.state.calls.some(c=>c.includes('/releaseshub/')));
});

test('unreleased-build guard: an unannounced version on releaseshub is never asked about; a late upload of a watched version is held',async()=>{
 const {fetcher,state}=fakeSites(),saved={};
 const cf='https://dxejw4oyledi.cloudfront.net/repository/';
 // 11.55.96.65382 really exists on releaseshub/CloudFront (2026-11-03) but is not released; 1.7.33 and 1.7.32.11090 are synthetic.
 state.hub['ServiceStudio/11.55.96.65382/windows']={location:cf+'servicestudio/11.55.96.65382/ServiceStudio-11.55.96.65382.exe',lastModified:'Tue, 03 Nov 2026 10:00:00 GMT',size:351700000};
 state.hub['ODCStudio/1.7.33.11080/windows']={location:cf+'odcstudio/1.7.33.11080/ODCStudio-1.7.33.11080.exe',lastModified:'Mon, 09 Nov 2026 10:00:00 GMT',size:287900000};
 // Watched before its cutoff (2026-11-09 16:00Z), then 11090 comes after it.
 assert.equal((await detectSources([],{fetcher,...fast,now:at('2026-11-09T12:00Z'),state:saved})).sources[0].status,'pending');
 state.hub['ODCStudio/1.7.32.11090/windows']={location:cf+'odcstudio/1.7.32.11090/ODCStudio-1.7.32.11090.exe',lastModified:'Mon, 09 Nov 2026 22:00:00 GMT',size:287900000};
 const seen=await detectSources([],{fetcher,...fast,state:saved});
 assert.deepEqual(seen.observed.map(o=>o.fullVersion),['1.7.32.11065','11.55.95.65352']);
 assert.deepEqual(seen.sources.find(s=>s.lane==='odc').heldBuilds,[11090]);
 assert.ok(!state.calls.some(c=>c.includes('11.55.96')||c.includes('1.7.33')));
 // The held build alone (the GA missing) is "no released build", never adopted.
 delete state.hub['ODCStudio/1.7.32.11065/windows'];delete state.hub['ODCStudio/1.7.32.11059/windows'];delete state.hub['ODCStudio/1.7.32.11035/windows'];
 const w={};await latestStudio('odc',undefined,{fetcher,...fast,now:at('2026-11-09T12:00Z'),state:w}).catch(()=>{});
 await assert.rejects(latestStudio('odc','1.7.31.10988',{fetcher,...fast,state:w}),e=>e.code==='STUDIO_BUILD_NOT_FOUND'&&/later: 11090/.test(e.message));
});

test('M2: the served window, not the Studio installed on the watcher, decides; a newer installed Studio (a preview) is flagged',async()=>{
 const {fetcher,state}=fakeSites();
 let seen=await detectSources([{lane:'o11',version:'11.55.96',fullVersion:'11.55.96.65382'}],{fetcher,...fast,served:{odc:['1.7.31'],o11:['11.55.94']}});
 const o11=seen.sources.find(s=>s.lane==='o11');
 assert.deepEqual([o11.status,o11.version,o11.installedAhead],['public','11.55.95.65352','11.55.96.65382']);
 assert.ok(seen.observed.some(x=>x.fullVersion==='11.55.95.65352'&&x.url));
 // A preview ODC 1.7.33.11300 installed above the GA 11250 does not raise the floor: the search starts at the known 11065.
 const f=fakeSites();
 odcAt(f,'1.7.33',NOW+8*DAY,{releasedOn:'2026-11-15',uploads:{11250:'2026-11-15T10:00Z'}});
 seen=await detectSources([{lane:'odc',version:'1.7.33',fullVersion:'1.7.33.11300'}],{fetcher:f.fetcher,...fast,now:NOW+8*DAY,served:{odc:['1.7.32'],o11:['11.55.95']}});
 const odc=seen.sources.find(s=>s.lane==='odc');
 assert.deepEqual([odc.status,odc.version,odc.installedAhead],['public','1.7.33.11250','1.7.33.11300']);
 assert.equal(Math.min(...probedBuilds(f)),11065);assert.ok(seen.observed.some(x=>x.fullVersion==='1.7.33.11250'&&x.url));
 seen=await detectSources([],{fetcher,...fast,served:{odc:['1.7.32'],o11:['11.55.96']}});
 assert.deepEqual(seen.sources.map(s=>[s.lane,s.status]),[['odc','public'],['o11','older-than-served']]);
 assert.ok(!seen.observed.some(x=>x.lane==='o11'));assert.ok(state.calls.length>0);
});

test('M2/A1: the round notifies the owner (once) of a newer watcher Studio and of a later build of a decided version',async t=>{
 const {createAutoRuntime}=await import('./auto-runtime.mjs');
 const dir=tmp(t),notes=[],logs=[],f=fakeSites();let clock=NOW;
 const runtime={log:m=>logs.push(m),notify:async(title,message)=>{notes.push([title,message]);},sourceFetcher:f.fetcher};
 const auto=createAutoRuntime({workspace:dir,tempRoot:dir,outDir:dir,automatic:false,clock:()=>clock},runtime);Object.assign(runtime,auto);
 const manifest={odc:[{version:'1.7.32'}],o11:[{version:'11.55.95'}]};
 const installed=[{lane:'o11',version:'11.55.96',fullVersion:'11.55.96.65382'}];
 const dry=await runtime.observe(installed,{dryRun:true,manifest});
 assert.deepEqual(dry.map(x=>x.fullVersion),['11.55.96.65382','1.7.32.11065','11.55.95.65352']);
 assert.equal(notes.length,0,'a dry run notifies nobody');assert.ok(!fs.existsSync(path.join(dir,'studio-sources.json')),'a dry run writes no decision');
 // Watched before the cutoff, then 11090 is uploaded after it.
 clock=at('2026-11-09T12:00Z');await runtime.observe(installed,{manifest});
 f.state.hub['ODCStudio/1.7.32.11090/windows']={location:CF+'1.7.32.11090/ODCStudio-1.7.32.11090.exe',lastModified:'Mon, 09 Nov 2026 22:00:00 GMT',size:287900000};
 clock=NOW;await runtime.observe(installed,{manifest});await runtime.observe(installed,{manifest});
 assert.deepEqual(notes.map(n=>n[0]).sort(),['SSAM: later Studio build not offered','SSAM: watcher Studio newer than the public release']);
 assert.match(notes.find(n=>/later/.test(n[0]))[1],/ODC Studio 1\.7\.32 is decided as 1\.7\.32\.11065.*1\.7\.32\.11090.*NOT offered.*vigia\.ps1 -Config .* -Pin 1\.7\.32\.11090/);
 assert.match(notes.find(n=>/newer/.test(n[0]))[1],/11\.55\.96\.65382.*11\.55\.95\.65352/);
 assert.ok(fs.existsSync(path.join(dir,'studio-sources.json')));
});

test('token rotation: tokens are re-read from the published scripts every run, and once more when one rotates mid-run',async()=>{
 const {fetcher,state}=fakeSites();
 assert.equal((await latestStudio('o11',undefined,{fetcher,...fast})).fullVersion,'11.55.95.65352');
 state.tokens={releases:'NEWreleasesTokenAAAAAA',guid:'NEWguidTokenAAAAAAAAAA',content:'NEWcontentTokenAAAAAAA'};
 assert.equal((await latestStudio('o11',undefined,{fetcher,...fast})).fullVersion,'11.55.95.65352');
 assert.equal((await latestStudio('odc','1.7.32.11065',{fetcher,...fast,window:10})).fullVersion,'1.7.32.11065');
 let reads=0;const old={...state.tokens};state.accepted=old;
 state.fail=u=>{if(u.pathname.includes('HomeScreen.mvc__')){reads++;state.tokens=reads===1?{...old,releases:'STALEtokenAAAAAAAAAAAA'}:old;}};
 const r=await latestStudio('o11',undefined,{fetcher,...fast});assert.equal(r.fullVersion,'11.55.95.65352');assert.equal(reads,2);
});

test('page-shape changes are an environmental STUDIO_SOURCE_CHANGED: the lane keeps the installed Studio, flagged unavailable, never "no update"',async()=>{
 const shapes={
  'no release list':s=>{s.releases.win={versionInfo:{},data:{UserId:0}};},
  'action gone from the script':s=>{s.scripts.home='// republished without the action\n';},
  'screen script renamed':s=>{s.moduleinfo.dl={manifest:{urlVersions:{}}};},
  'apiVersion refused after re-reading':s=>{s.accepted={releases:'neverPublishedTokenAAA'};},
  'unrecognised file name':s=>{s.releases.win.data.ReleaseDownloadList.List[0].Filename='ServiceStudio.exe';},
  'two versions for Windows':s=>{s.releases.win.data.ReleaseDownloadList.List.push({...s.releases.win.data.ReleaseDownloadList.List[0],Filename:'ServiceStudio-11.55.96.65382.exe'});},
  'size differs from the file':s=>{s.releases.win.data.ReleaseDownloadList.List[0].Filesize='1';},
  'moduleinfo not JSON':s=>{s.moduleinfo.dl='<html>maintenance</html>';}
 };
 for(const [name,change] of Object.entries(shapes)){
  const {fetcher,state}=fakeSites();change(state);
  await assert.rejects(latestStudio('o11',undefined,{fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_CHANGED'&&e.environmental===true,name);
 }
 for(const [name,change] of Object.entries({'notes without headings':s=>{s.content.data.Html='<p>moved</p>';},'notes without a date':s=>{s.content.data.Html='<h2 id="x" >ODC Studio 1.7.33</h2><p>soon</p>';},'GUID not found':s=>{s.guid.data={ContentFound:false,GUID:''};}})){
  const {fetcher,state}=fakeSites();change(state);
  await assert.rejects(latestStudio('odc','1.7.31.10988',{fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_CHANGED',name);
 }
 const {fetcher,state}=fakeSites();state.content.data.Html='';state.releases.win.data={};
 const local=[{lane:'odc',version:'1.7.31',fullVersion:'1.7.31.10988'},{lane:'o11',version:'11.55.95',fullVersion:'11.55.95.65352'}];
 const seen=await detectSources(local,{fetcher,...fast});
 assert.deepEqual(seen.observed,local);
 assert.deepEqual(seen.sources.map(s=>[s.lane,s.status,s.code,s.fallback]),[['odc','unavailable','STUDIO_SOURCE_CHANGED','installed Studio'],['o11','unavailable','STUDIO_SOURCE_CHANGED','installed Studio']]);
});

test('timeouts and outages: bounded retries, then STUDIO_SOURCE_UNREACHABLE; a transient 503 recovers',async()=>{
 const {fetcher,state}=fakeSites();
 state.fail=()=>{throw Error('connect ETIMEDOUT');};
 await assert.rejects(latestStudio('o11',undefined,{fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_UNREACHABLE');
 assert.equal(state.calls.length,3);
 let n=0;state.calls.length=0;state.fail=()=>++n<=2?new Response('',{status:503}):null;
 assert.equal((await latestStudio('o11',undefined,{fetcher,...fast})).fullVersion,'11.55.95.65352');
 const f2=fakeSites();f2.state.fail=u=>u.pathname.includes('1.7.32.11100/')?new Response('',{status:500}):null;
 await assert.rejects(latestStudio('odc','1.7.31.10988',{fetcher:f2.fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_UNREACHABLE');
 const seen=await detectSources(odcInstalled,{fetcher:async()=>{throw Error('offline');},...fast});
 assert.deepEqual(seen.observed,odcInstalled);assert.ok(seen.sources.every(s=>s.status==='unavailable'&&s.code==='STUDIO_SOURCE_UNREACHABLE'));
});

test('B3: a 403 is STUDIO_SOURCE_BLOCKED and a lasting 429 STUDIO_SOURCE_RATE_LIMITED, never "the page changed shape"',async()=>{
 let f=fakeSites();f.state.fail=u=>u.pathname.includes('1.7.32.11070/')?new Response('',{status:403}):null;
 await assert.rejects(latestStudio('odc',undefined,{fetcher:f.fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_BLOCKED'&&/firewall/.test(e.message));
 f=fakeSites();f.state.fail=u=>u.pathname.endsWith('/DataActionGetReleases')?new Response('',{status:403}):null;
 await assert.rejects(latestStudio('o11',undefined,{fetcher:f.fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_BLOCKED');
 f=fakeSites();f.state.fail=u=>u.pathname.includes('/releaseshub/')?new Response('',{status:429}):null;
 await assert.rejects(latestStudio('o11',undefined,{fetcher:f.fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_RATE_LIMITED');
 assert.equal(f.state.calls.filter(c=>c.includes('/releaseshub/')).length,3);
 f=fakeSites();f.state.fail=u=>u.hostname==='dxejw4oyledi.cloudfront.net'?new Response('',{status:403}):null;
 await assert.rejects(latestStudio('o11',undefined,{fetcher:f.fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_BLOCKED');
});

test('B1: answers are capped while they stream (scripts, screen-service JSON), and a declared oversize is refused unread',async()=>{
 let f=fakeSites(),read=0;
 const big=()=>new Response(new ReadableStream({pull(c){read++;c.enqueue(new Uint8Array(4096).fill(32));if(read>100)c.close();}}),{status:200});
 f.state.fail=u=>u.pathname.endsWith('/DataActionGetReleases')?big():null;
 await assert.rejects(latestStudio('o11',undefined,{fetcher:f.fetcher,...fast,maxJson:64*1024}),e=>e.code==='STUDIO_SOURCE_CHANGED'&&/oversized answer from DataActionGetReleases/.test(e.message));
 assert.ok(read<=20,`the stream was cut at the cap (${read} chunks pulled)`);
 f=fakeSites();f.state.fail=u=>u.pathname.endsWith('/DataActionGetDocContent')?new Response('{}',{status:200,headers:{'content-length':String(10*1024**2)}}):null;
 await assert.rejects(latestStudio('odc',undefined,{fetcher:f.fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_CHANGED'&&/oversized answer from DataActionGetDocContent/.test(e.message));
 f=fakeSites();
 await assert.rejects(latestStudio('o11',undefined,{fetcher:f.fetcher,...fast,maxText:100}),e=>e.code==='STUDIO_SOURCE_CHANGED'&&/oversized/.test(e.message));
});

test('B2: server error text reaches the error and the owner notice only as [\\w .:-]',async t=>{
 const {createAutoRuntime,noticeText}=await import('./auto-runtime.mjs');
 const evil='<img src=x onerror=alert(1)>\r\nCall https://evil.example/?a=b now';
 const f=fakeSites();f.state.fail=u=>u.pathname.endsWith('/DataActionGetReleases')?new Response(JSON.stringify({exception:{message:evil}}),{status:200}):null;
 await assert.rejects(latestStudio('o11',undefined,{fetcher:f.fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_CHANGED'&&!/[<>\r\n=?/]/.test(e.message.split('refused (')[1]));
 assert.equal(cleanText(evil),'img srcx onerroralert1Call https:evil.exampleab now');
 assert.equal(noticeText('a<b>\n`c`'),'abc');
 const dir=tmp(t),notes=[];
 const runtime={log:()=>{},notify:async(title,message)=>{notes.push(message);},sourceFetcher:f.fetcher};
 Object.assign(runtime,createAutoRuntime({workspace:dir,tempRoot:dir,outDir:dir,automatic:false,now:NOW},runtime));
 await runtime.observe([],{manifest:{odc:[{version:'1.7.32'}],o11:[{version:'11.55.95'}]}});
 assert.equal(notes.length,1);assert.ok(!/[<>\r\n]/.test(notes[0]));assert.match(notes[0],/STUDIO_SOURCE_CHANGED/);
});

test('B4: the whole search of a lane has a deadline, whatever the timeouts and retries',async()=>{
 const f=fakeSites();
 // Every releaseshub probe hangs until aborted: without the deadline, 601 probes x 3 tries x timeoutMs.
 const hanging=async(url,init)=>{if(String(url).includes('/releaseshub/'))return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted'))));return f.fetcher(url,init);};
 const started=Date.now();
 await assert.rejects(latestStudio('odc',undefined,{fetcher:hanging,...fast,timeoutMs:30000,deadlineMs:400}),e=>e.code==='STUDIO_SOURCE_UNREACHABLE'&&/search deadline/.test(e.message));
 assert.ok(Date.now()-started<5000,`bounded (${Date.now()-started} ms)`);
 const seen=await detectSources([],{fetcher:hanging,...fast,deadlineMs:400});
 assert.deepEqual(seen.sources.map(s=>[s.lane,s.status,s.code]),[['odc','unavailable','STUDIO_SOURCE_UNREACHABLE'],['o11','unavailable','STUDIO_SOURCE_UNREACHABLE']]);
});

test('the same release as installed adds the download link and platforms to the installed entry; a newer one is a candidate',async()=>{
 const {fetcher}=fakeSites();
 const seen=await detectSources([{lane:'odc',version:'1.7.32',fullVersion:'1.7.32.11065'},{lane:'o11',version:'11.55.94',fullVersion:'11.55.94.65328'}],{fetcher,...fast});
 assert.equal(seen.observed.length,3);
 assert.equal(seen.observed[0].url,HUB+'ODCStudio/version/1.7.32.11065/platform/windows/content');assert.ok(seen.observed[0].platforms.macosx_arm64);
 assert.equal(seen.observed[2].fullVersion,'11.55.95.65352');assert.equal(seen.observed[2].requiresInstallation,true);
 assert.deepEqual(seen.sources.map(s=>[s.lane,s.status,s.version]),[['odc','public','1.7.32.11065'],['o11','public','11.55.95.65352']]);
});

test('allowlist: discovery reads exactly four hosts, https, no port or user; redirects to other hosts are refused',async()=>{
 assert.deepEqual([...TRUSTED_HOSTS].sort(),['api.outsystems.com','dxejw4oyledi.cloudfront.net','success.outsystems.com','www.outsystems.com']);
 for(const bad of ['https://evil.example/a.exe','http://www.outsystems.com/downloads/','https://www.outsystems.com:8443/x','https://u:p@success.outsystems.com/','https://rogue.outsystems.com/x'])assert.throws(()=>officialUrl(bad),bad);
 const {fetcher,state}=fakeSites();state.hub['ServiceStudio/11.55.95.65352/windows'].location='https://evil.example/ServiceStudio-11.55.95.65352.exe';
 await assert.rejects(latestStudio('o11',undefined,{fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_UNTRUSTED');
 const f2=fakeSites();f2.state.fail=u=>u.pathname.endsWith('/DataActionGetReleases')?new Response(null,{status:302,headers:{location:'https://evil.example/'}}):null;
 await assert.rejects(latestStudio('o11',undefined,{fetcher:f2.fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_CHANGED');
 assert.ok(!f2.state.calls.some(c=>c.includes('evil.example')));
});

test('M3: a download touches only releaseshub and CloudFront, at the exact file path of that release',async t=>{
 assert.deepEqual([...DOWNLOAD_HOSTS].sort(),['api.outsystems.com','dxejw4oyledi.cloudfront.net']);
 const release=releaseFor('odc','1.7.32.11065');
 assert.equal(downloadUrl(release,release.url),release.url);
 assert.equal(downloadUrl(release,CF+'1.7.32.11065/ODCStudio-1.7.32.11065.exe'),CF+'1.7.32.11065/ODCStudio-1.7.32.11065.exe');
 for(const bad of ['https://www.outsystems.com/forge/ODCStudio-1.7.32.11065.exe','https://success.outsystems.com/attachment/ODCStudio-1.7.32.11065.exe',
  CF+'1.7.32.11059/ODCStudio-1.7.32.11059.exe',CF+'1.7.32.11065/ODCStudio-1.7.32.11065.dmg',CF+'1.7.32.11065/ODCStudio-1.7.32.11065.exe?x=1',
  'https://dxejw4oyledi.cloudfront.net/uploads/ODCStudio-1.7.32.11065.exe',HUB+'ODCStudio/version/1.7.32.11066/platform/windows/content','http://dxejw4oyledi.cloudfront.net/repository/odcstudio/1.7.32.11065/ODCStudio-1.7.32.11065.exe'])
  assert.throws(()=>downloadUrl(release,bad),bad);
 const dir=tmp(t);
 for(const location of ['https://www.outsystems.com/downloads/ODCStudio-1.7.32.11065.exe',CF+'1.7.32.11059/ODCStudio-1.7.32.11059.exe']){
  const calls=[];const fetcher=async(url)=>{calls.push(url);return new Response(null,{status:301,headers:{location}});};
  await assert.rejects(downloadInstaller(release,dir,{fetcher}),/Studio download URL/);assert.equal(calls.length,1);
 }
});

test('download link builder and the download through the releaseshub redirect, size-checked',async t=>{
 assert.equal(contentLink('o11','11.55.95.65352','macosx_arm64'),HUB+'ServiceStudio/version/11.55.95.65352/platform/macosx_arm64/content');
 assert.throws(()=>contentLink('odc','1.7.32','windows'));assert.throws(()=>contentLink('odc','1.7.32.1','mac'));
 const {fetcher,state}=fakeSites(),dir=tmp(t);
 const release=releaseFor('odc','1.7.32.11065',{platforms:{windows:{size:state.installer.length}}});
 const d=await downloadInstaller(release,dir,{fetcher});
 assert.equal(fs.readFileSync(d.file+'.sha256','utf8').trim(),d.sha256);
 assert.ok(state.calls.some(c=>c.startsWith('GET https://dxejw4oyledi.cloudfront.net/repository/odcstudio/1.7.32.11065/')));
 await assert.rejects(downloadInstaller(releaseFor('o11','11.55.95.65352',{platforms:{windows:{size:1}}}),dir,{fetcher}),/size/);
});

test('the round says when a source cannot be read (once a day per lane and code) and never in a dry run',async t=>{
 const {createAutoRuntime}=await import('./auto-runtime.mjs');
 const dir=tmp(t),notes=[],logs=[];
 const runtime={log:m=>logs.push(m),notify:async(title,message)=>{notes.push([title,message]);},sourceFetcher:fakeSites().fetcher};
 const auto=createAutoRuntime({workspace:dir,tempRoot:dir,outDir:dir,automatic:false,now:NOW},runtime);Object.assign(runtime,auto);
 const manifest={odc:[{version:'1.7.32'}],o11:[{version:'11.55.95'}]};
 const installed=[{lane:'odc',version:'1.7.32',fullVersion:'1.7.32.11065'},{lane:'o11',version:'11.55.95',fullVersion:'11.55.95.65352'}];
 assert.deepEqual(await runtime.observe(installed,{manifest}),[]);assert.equal(notes.length,0);
 const f=fakeSites();f.state.releases.win.data={};runtime.sourceFetcher=f.fetcher;
 await runtime.observe(installed,{dryRun:true,manifest});assert.equal(notes.length,0,'a dry run notifies nobody');
 await runtime.observe(installed,{manifest});await runtime.observe(installed,{manifest});
 assert.equal(notes.length,1);assert.equal(notes[0][0],'SSAM: Studio release source unreadable');assert.match(notes[0][1],/Service Studio.*STUDIO_SOURCE_CHANGED/);
 assert.deepEqual(runtime.sourceStatus.map(s=>s.status),['public','unavailable']);
 assert.ok(logs.some(l=>/o11 source unavailable \(STUDIO_SOURCE_CHANGED\)/.test(l)));
});

test('the build search goes on to the next window (bounded) only while nothing was found or the find sits at its top',async()=>{
 const notes='<h2 id="odc_studio_1.7.33" >ODC Studio 1.7.33</h2>\r\n<div class="info"><p>Released on Nov 15, 2026</p></div>';
 const put=(s,b)=>{s.hub[`ODCStudio/1.7.33.${b}/windows`]={location:`${CF}1.7.33.${b}/ODCStudio-1.7.33.${b}.exe`,lastModified:'Sun, 15 Nov 2026 09:00:00 GMT',size:287900000};};
 const later={...fast,now:at('2026-11-17T00:00Z')};
 let f=fakeSites();f.state.content.data.Html=notes;put(f.state,11120);put(f.state,11150);
 assert.equal((await latestStudio('odc','1.7.32.11065',{fetcher:f.fetcher,...later,window:60})).fullVersion,'1.7.33.11150');
 assert.equal(probes(f).length,61*2);
 f=fakeSites();f.state.content.data.Html=notes;put(f.state,11200);
 assert.equal((await latestStudio('odc','1.7.32.11065',{fetcher:f.fetcher,...later,window:60})).fullVersion,'1.7.33.11200');
 await assert.rejects(latestStudio('odc','1.7.32.11065',{fetcher:f.fetcher,...later,window:60,maxWindows:2}),e=>e.code==='STUDIO_BUILD_NOT_FOUND'&&/searched 11065\.\.11186/.test(e.message));
});

// Several announced versions at once: notes with every heading, and releaseshub as it stood at now.
function worldAt(f,now,versions){
 for(const k of Object.keys(f.state.hub))if(k.startsWith('ODCStudio/'))delete f.state.hub[k];
 for(const {version,uploads} of versions)for(const [b,t] of Object.entries(uploads))if(at(t)<=now)f.state.hub[`ODCStudio/${version}.${b}/windows`]={location:`${CF}${version}.${b}/ODCStudio-${version}.${b}.exe`,lastModified:new Date(t).toUTCString(),size:287000000+Number(b)};
 f.state.content.data.Html=versions.filter(v=>!v.announcedAt||at(v.announcedAt)<=now).sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true})).map(v=>notesFor(v.version,v.releasedOn)).join('\r\n\r\n');
 f.state.calls.length=0;
}

test('M2: two versions close together: 1.7.33, still pending when 1.7.34 ships, is decided and offered first; 1.7.34 waits, then follows',async()=>{
 const f=fakeSites(),state={};
 const versions=[{version:'1.7.33',releasedOn:'2026-11-15',uploads:{11120:'2026-11-15T10:00Z'},announcedAt:'2026-11-15T11:00Z'},{version:'1.7.34',releasedOn:'2026-11-16',uploads:{11140:'2026-11-16T10:00Z'},announcedAt:'2026-11-16T12:00Z'}];
 const round=(t,served=['1.7.32'])=>{worldAt(f,at(t),versions);return detectSources([],{fetcher:f.fetcher,...fast,now:at(t),state,served:{odc:served,o11:['11.55.95']}});};
 const odc=r=>r.sources.filter(s=>s.lane==='odc').map(s=>[s.version,s.status]);
 assert.deepEqual(odc(await round('2026-11-15T12:00Z')),[['1.7.33','pending']]);
 assert.deepEqual(odc(await round('2026-11-16T12:00Z')),[['1.7.33','pending'],['1.7.34','pending']]);
 let r=await round('2026-11-16T18:00Z');
 assert.deepEqual(odc(r),[['1.7.33.11120','public'],['1.7.34','pending']]);assert.ok(r.observed.some(x=>x.fullVersion==='1.7.33.11120'));
 r=await round('2026-11-17T18:00Z');
 assert.deepEqual(odc(r),[['1.7.33.11120','public'],['1.7.34.11140','queued']]);
 assert.deepEqual(r.observed.map(x=>x.fullVersion),['1.7.33.11120','11.55.95.65352'],'one new ODC version per round, oldest first');
 r=await round('2026-11-17T20:00Z',['1.7.32','1.7.33']);
 assert.deepEqual(odc(r),[['1.7.34.11140','public']],'a served version is no longer read');
 assert.deepEqual(r.observed.map(x=>x.fullVersion),['1.7.34.11140','11.55.95.65352']);
 // Decided versions cost no probe; the served 1.7.33 is no longer searched once older than the newest served.
 assert.equal(probes(f).length,0);
});

test('M4: first searched after its cutoff with a later upload above the eligible build (a GA re-upload): ambiguous, never decided alone; the owner pins it',async()=>{
 const f=fakeSites(),state={},o=t=>({fetcher:f.fetcher,...fast,...HIST,now:t,state});
 const reuploaded={10945:'2026-10-19T17:17Z',10954:'2026-10-26T15:17Z',10980:'2026-10-29T10:00Z'};
 odcAt(f,'1.7.30',at('2026-10-30T00:00Z'),{uploads:reuploaded});
 await assert.rejects(latestStudio('odc',undefined,o(at('2026-10-30T00:00Z'))),e=>e.code==='STUDIO_BUILD_AMBIGUOUS'&&/eligible 10954/.test(e.message)&&/10980 above it/.test(e.message)&&/\{\{-Pin 1\.7\.30\.<build>\}\}/.test(e.action));
 assert.equal(state.odc.versions['1.7.30'].decided,undefined);
 // Rounds after it: no probe, the same answer, until a day has passed or the notes change.
 odcAt(f,'1.7.30',at('2026-10-30T02:00Z'),{uploads:reuploaded});
 await assert.rejects(latestStudio('odc',undefined,o(at('2026-10-30T02:00Z'))),e=>e.code==='STUDIO_BUILD_AMBIGUOUS'&&/Probed again at 2026-10-31T00:00Z/.test(e.message));
 assert.equal(probes(f).length,0);
 // The owner pins the GA (one GET, one HEAD); then the version is decided, with zero probes.
 await assert.rejects(pinOdc(state,'1.7.30.10999',{fetcher:f.fetcher,retryDelayMs:0}),/does not exist on releaseshub/);
 await assert.rejects(pinOdc(state,'1.7.31.10988',{fetcher:f.fetcher,retryDelayMs:0}),/not been read from the release notes/);
 await assert.rejects(pinOdc(state,'1.7.30',{fetcher:f.fetcher}),/X\.Y\.Z\.B/);
 const p=await pinOdc(state,'1.7.30.10980',{fetcher:f.fetcher,retryDelayMs:0,now:at('2026-10-30T03:00Z')});
 assert.deepEqual([p.version,p.build,p.previous],['1.7.30',10980,null]);
 odcAt(f,'1.7.30',at('2026-10-30T04:00Z'),{uploads:reuploaded});
 const r=await latestStudio('odc',undefined,o(at('2026-10-30T04:00Z')));
 assert.deepEqual([r.fullVersion,r.decided.by],['1.7.30.10980','owner']);assert.equal(probes(f).length,0);
 // The same first sighting when the version was watched up to its cutoff: the late upload is held, the eligible one decided.
 const g=fakeSites(),s2={};
 odcAt(g,'1.7.30',at('2026-10-27T12:00Z'),{uploads:reuploaded});await latestStudio('odc',undefined,{fetcher:g.fetcher,...fast,...HIST,now:at('2026-10-27T12:00Z'),state:s2});
 odcAt(g,'1.7.30',at('2026-10-30T00:00Z'),{uploads:reuploaded});
 const r2=await latestStudio('odc',undefined,{fetcher:g.fetcher,...fast,...HIST,now:at('2026-10-30T00:00Z'),state:s2});
 assert.deepEqual([r2.fullVersion,r2.heldBuilds],['1.7.30.10954',[10980]]);
 // -Redecide drops the record: the next round searches it as never seen.
 assert.deepEqual(redecideOdc(state,'1.7.30'),{version:'1.7.30',previous:10980});assert.equal(state.odc.versions['1.7.30'],undefined);
 assert.throws(()=>redecideOdc(state,'1.7.30'),/no record/);
});

test('M1: worst-case load is bounded: an announced version with no build probes 1803 once, 601 per round to its cutoff, then once a day',async()=>{
 const perRound=async(versions,from,to,known=HIST)=>{
  const f=fakeSites(),state={},rows=[];
  for(let now=at(from);now<=at(to);now+=2*H){
   worldAt(f,now,versions);let code='';
   try{const r=await latestStudio('odc',undefined,{fetcher:f.fetcher,...fast,...known,now,state});code=r.fullVersion??'pending';}catch(e){code=e.code;}
   rows.push({now,probes:probes(f).length,code});
  }
  return rows;
 };
 const day=at('2026-11-15T00:00Z'),cutoff=day+40*H;
 // S7: announced, nothing uploaded at all.
 let rows=await perRound([{version:'1.7.33',releasedOn:'2026-11-15',uploads:{}}],'2026-11-15T00:00Z','2026-11-19T00:00Z');
 assert.equal(rows[0].probes,1803);
 assert.ok(rows.filter(x=>x.now>day&&x.now<=cutoff).every(x=>x.probes===601),'one window per round up to the cutoff');
 const after=rows.filter(x=>x.now>cutoff);
 assert.ok(after.every(x=>x.code==='STUDIO_BUILD_NOT_FOUND'));
 assert.deepEqual(after.filter(x=>x.probes>0).map(x=>(x.now-cutoff)/H),[24,48],'after the cutoff: one search a day');
 const daily=(rows,d)=>rows.filter(x=>x.now>=d&&x.now<d+DAY).reduce((n,x)=>n+x.probes,0);
 assert.deepEqual([daily(rows,day),daily(rows,day+DAY),daily(rows,day+2*DAY),daily(rows,day+3*DAY)],[1803+11*601,8*601+601,601,601]);
 // S8: the only build is older than D-1 (the notes date lags): 601 once, 101 per round, then once a day.
 rows=await perRound([{version:'1.7.33',releasedOn:'2026-11-15',uploads:{11120:'2026-11-12T10:00Z'}}],'2026-11-15T00:00Z','2026-11-18T00:00Z');
 assert.equal(rows[0].probes,601);assert.ok(rows.filter(x=>x.now>day&&x.now<=cutoff).every(x=>x.probes===101));
 assert.deepEqual(rows.filter(x=>x.now>cutoff&&x.probes>0).map(x=>(x.now-cutoff)/H),[24]);
 // A pending version with nothing new: one follow window (101) per round.
 rows=await perRound([{version:'1.7.33',releasedOn:'2026-11-15',uploads:{11120:'2026-11-15T10:00Z'}}],'2026-11-15T12:00Z','2026-11-16T14:00Z');
 assert.ok(rows.slice(1).every(x=>x.probes===101));
 // A notes change brings the search back at once.
 const f=fakeSites(),state={};worldAt(f,cutoff+2*H,[{version:'1.7.33',releasedOn:'2026-11-15',uploads:{}}]);
 await assert.rejects(latestStudio('odc',undefined,{fetcher:f.fetcher,...fast,...HIST,now:cutoff+2*H,state}),e=>e.code==='STUDIO_BUILD_NOT_FOUND');
 worldAt(f,cutoff+4*H,[{version:'1.7.33',releasedOn:'2026-11-15',uploads:{}}]);
 await assert.rejects(latestStudio('odc',undefined,{fetcher:f.fetcher,...fast,...HIST,now:cutoff+4*H,state}));assert.equal(probes(f).length,0);
 worldAt(f,cutoff+6*H,[{version:'1.7.33',releasedOn:'2026-11-16',uploads:{11120:'2026-11-16T10:00Z'}}]);
 assert.equal((await latestStudio('odc',undefined,{fetcher:f.fetcher,...fast,...HIST,now:cutoff+6*H,state})).pending.build,11120);
});

test('M3/M4: the round with a signed journal: tampered or truncated decisions stop ODC only and tell the owner how to recover; -Pin and -Redecide write a valid journal',async t=>{
 const {configureJournals}=await import('./journal.mjs');
 const {createAutoRuntime,pinStudioBuild,redecideStudio,SOURCES_FILE}=await import('./auto-runtime.mjs');
 const {parseArgs}=await import('./vigia.mjs');
 const dir=tmp(t);configureJournals(dir,Buffer.alloc(32,7).toString('base64'));
 const notes=[],f=fakeSites();
 const runtime={log:()=>{},notify:async(title,message)=>{notes.push([title,message]);},sourceFetcher:f.fetcher};
 const config={workspace:dir,tempRoot:dir,outDir:dir,automatic:true,now:NOW,configFile:'C:/t/vigia/config.json'};
 Object.assign(runtime,createAutoRuntime(config,runtime));
 const manifest={odc:[{version:'1.7.32'}],o11:[{version:'11.55.95'}]},file=path.join(dir,SOURCES_FILE);
 const status=()=>runtime.sourceStatus.map(s=>[s.lane,s.status,s.code??s.version]);
 await runtime.observe([],{manifest});assert.deepEqual(status(),[['odc','public','1.7.32.11065'],['o11','public','11.55.95.65352']]);
 const j=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(Object.keys(j),['journal','value','mac']);
 j.value.versions['1.7.32'].decided.build=11059;fs.writeFileSync(file,JSON.stringify(j));
 await runtime.observe([],{manifest});assert.deepEqual(status(),[['odc','unavailable','STUDIO_SOURCE_STATE'],['o11','public','11.55.95.65352']]);
 fs.writeFileSync(file,'{"journal":1,"val');
 await runtime.observe([],{manifest});assert.deepEqual(status(),[['odc','unavailable','STUDIO_SOURCE_STATE'],['o11','public','11.55.95.65352']]);
 assert.equal(notes.length,1,'once a day');
 assert.equal(notes[0][0],'SSAM: Studio release needs the owner');
 assert.match(notes[0][1],/Journal MAC is invalid.*does not heal by itself: rename or delete studio-sources\.json/);assert.doesNotMatch(notes[0][1],/retries next round/);
 await assert.rejects(pinStudioBuild(config,'1.7.32.11065',{fetcher:f.fetcher}),/JSON|journal/i);
 fs.rmSync(file);
 await runtime.observe([],{manifest});assert.deepEqual(status(),[['odc','public','1.7.32.11065'],['o11','public','11.55.95.65352']]);
 // -Pin / -Redecide: the owner's choice is written back signed and read by the next round.
 const pinned=await pinStudioBuild(config,'1.7.32.11059',{fetcher:f.fetcher,now:NOW+H});
 assert.equal(pinned.status,'pinned');assert.match(pinned.note,/decided as build 11059 \(was 11065\) by the owner/);
 assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file,'utf8'))),['journal','value','mac']);
 await runtime.observe([],{manifest});assert.deepEqual(status()[0],['odc','public','1.7.32.11059']);
 assert.equal(redecideStudio(config,'1.7.32').previous,11059);
 await runtime.observe([],{manifest});assert.deepEqual(status()[0],['odc','public','1.7.32.11065']);
 assert.equal(parseArgs(['--config','c','--pin','1.7.32.11065']).pin,'1.7.32.11065');assert.equal(parseArgs(['--config','c','--redecide','1.7.32']).redecide,'1.7.32');
 assert.throws(()=>parseArgs(['--config','c','--rehearse-current','--pin','1.7.32.11065']),/runs alone/);
 assert.match(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)),'vigia.ps1'),'utf8'),/\[string\]\$Pin,[\s\S]*--pin/);
});

test('B2/B4: the decision reads Last-Modified from the CloudFront repository only, and a notice shows a foreign host, never its URL',async()=>{
 const f=fakeSites();
 f.state.hub['ODCStudio/1.7.32.11065/windows'].location='https://www.outsystems.com/repository/odcstudio/1.7.32.11065/ODCStudio-1.7.32.11065.exe';
 await assert.rejects(latestStudio('odc',undefined,{fetcher:f.fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_UNTRUSTED'&&/host www\.outsystems\.com/.test(e.message)&&!e.message.includes('/repository/odcstudio'));
 assert.ok(!f.state.calls.some(c=>c.startsWith('HEAD https://www.outsystems.com')));
 const g=fakeSites();g.state.hub['ServiceStudio/11.55.95.65352/windows'].location='https://evil.example/x/ServiceStudio.exe?token=abc';
 await assert.rejects(latestStudio('o11',undefined,{fetcher:g.fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_UNTRUSTED'&&/host evil\.example\)/.test(e.message)&&!/token|ServiceStudio\.exe/.test(e.message));
});
