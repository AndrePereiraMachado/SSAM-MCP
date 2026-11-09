import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {detectSources,latestStudio,downloadInstaller,downloadUrl,officialUrl,releaseFor,contentLink,parseOdcNotes,judgeOdc,cleanText,TRUSTED_HOSTS,DOWNLOAD_HOSTS,DOWNLOADS,ODC_NOTES_PAGE,ODC_RULE} from './sources.mjs';
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

test('A1: 1.7.28 is not locked on 10850 the release afternoon; the next-day 10873 is decided at the cutoff (settleHours 6 would have locked 10850)',async()=>{
 const f=fakeSites(),state={},o=t=>({fetcher:f.fetcher,...fast,...HIST,now:t,state});
 for(const t of ['2026-10-12T10:00Z','2026-10-12T16:00Z','2026-10-12T23:00Z','2026-10-13T06:00Z','2026-10-13T10:00Z','2026-10-13T15:00Z']){
  odcAt(f,'1.7.28',at(t));const r=await latestStudio('odc',undefined,o(at(t)));
  assert.equal(r.fullVersion,null,t);
 }
 odcAt(f,'1.7.28',at('2026-10-13T16:00Z'));
 const r=await latestStudio('odc',undefined,o(at('2026-10-13T16:00Z')));
 assert.equal(r.fullVersion,'1.7.28.10873');
 // The counterfactual the cutoff and settleHours are chosen against: 6 settled hours decide 10850 the same afternoon.
 const g=fakeSites();odcAt(g,'1.7.28',at('2026-10-12T16:00Z'));
 assert.equal((await latestStudio('odc',undefined,{fetcher:g.fetcher,...fast,...HIST,now:at('2026-10-12T16:00Z'),rule:{...ODC_RULE,settleHours:6}})).fullVersion,'1.7.28.10850');
});

test('A1 replay: rounds every 2 h from D-1 to D+3 over the real uploads of 1.7.27..1.7.32 only ever decide the shipped build, once',async()=>{
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
  assert.ok(decided,version);assert.ok(decided.at<=day+ODC_RULE.cutoffHours*H);
  table[version]=`${decided.v} ${decided.by} D+${(decided.at-day)/H}h`;
 }
 assert.deepEqual(table,{'1.7.27':'1.7.27.10846 cutoff D+40h','1.7.28':'1.7.28.10873 cutoff D+40h','1.7.29':'1.7.29.10940 cutoff D+40h','1.7.30':'1.7.30.10980 cutoff D+40h','1.7.31':'1.7.31.10988 settled D+38h','1.7.32':'1.7.32.11065 settled D+38h'});
});

test('A1: an announced version with only old release candidates never falls through to them (lower bound D-1)',async()=>{
 const f=fakeSites();
 const early={11035:'2026-11-02T23:39Z',11059:'2026-11-05T18:49Z'};
 odcAt(f,'1.7.32',at('2026-11-08T12:00Z'),{uploads:early});
 assert.equal((await latestStudio('odc',undefined,{fetcher:f.fetcher,...fast,...HIST,now:at('2026-11-08T12:00Z')})).pending.build,null);
 odcAt(f,'1.7.32',NOW,{uploads:early});
 await assert.rejects(latestStudio('odc',undefined,{fetcher:f.fetcher,...fast,...HIST}),e=>e.code==='STUDIO_BUILD_NOT_FOUND'&&/earlier: 11035, 11059/.test(e.message)&&/searched 10800\.\.11400/.test(e.message));
 assert.deepEqual(judgeOdc({releasedOn:'2026-11-08',uploads:{11059:{modified:'2026-11-07T00:00:00Z'}},now:NOW}).best.build,11059,'D-1 00:00Z itself is eligible');
});

test('A1/M1: a decided build is persisted and never changed; a later build of the same version is reported, never adopted',async t=>{
 const f=fakeSites(),file=path.join(tmp(t),'studio-sources.json');
 const store={read:()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null,write:s=>fs.writeFileSync(file,JSON.stringify(s))};
 const round=(now=NOW)=>detectSources([],{fetcher:f.fetcher,...fast,now,store,served:{odc:['1.7.31'],o11:['11.55.94']}});
 let seen=await round();
 assert.deepEqual(seen.sources.map(s=>[s.lane,s.status,s.version]),[['odc','public','1.7.32.11065'],['o11','public','11.55.95.65352']]);
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).odc.versions['1.7.32'].decided.build,11065);
 // Next round, same notes: no releaseshub or CloudFront request at all (both lanes), and nothing written.
 f.state.calls.length=0;const mtime=fs.statSync(file).mtimeMs;
 seen=await round(NOW+2*H);
 assert.equal(seen.sources[0].version,'1.7.32.11065');assert.ok(!f.state.calls.some(c=>c.includes('/releaseshub/')||c.includes('cloudfront')));
 assert.equal(fs.statSync(file).mtimeMs,mtime);
 // A hotfix 11090 is uploaded and the notes section changes: probed above the last find only, reported, the decision kept.
 f.state.hub['ODCStudio/1.7.32.11090/windows']={location:CF+'1.7.32.11090/ODCStudio-1.7.32.11090.exe',lastModified:'Wed, 11 Nov 2026 10:00:00 GMT',size:287900000};
 f.state.content.data.Html=f.state.content.data.Html.replace('<li>(trimmed)</li>','<li>(trimmed)</li><li>Fixed an issue.</li>');
 f.state.calls.length=0;seen=await round(NOW+2*DAY);
 assert.deepEqual([seen.sources[0].version,seen.sources[0].laterBuilds],['1.7.32.11065',[11090]]);
 assert.equal(Math.min(...probedBuilds(f)),11066);assert.equal(probes(f).length,101);
 const saved=JSON.parse(fs.readFileSync(file,'utf8')).odc.versions['1.7.32'];
 assert.equal(saved.decided.build,11065);assert.equal(saved.notesChanges.length,1);
 // A later round still reports it and still probes nothing.
 f.state.calls.length=0;seen=await round(NOW+3*DAY);
 assert.deepEqual(seen.sources[0].laterBuilds,[11090]);assert.equal(probes(f).length,0);
});

test('A1: decisions that cannot be read or written are never acted on (STUDIO_SOURCE_STATE)',async()=>{
 const {fetcher}=fakeSites();
 let seen=await detectSources([],{fetcher,...fast,store:{read:()=>{throw Error('Journal MAC is invalid.');},write:()=>{}}});
 assert.deepEqual(seen.sources.map(s=>[s.lane,s.status,s.code]),[['odc','unavailable','STUDIO_SOURCE_STATE'],['o11','unavailable','STUDIO_SOURCE_STATE']]);
 assert.deepEqual(seen.observed,[]);
 seen=await detectSources([],{fetcher,...fast,store:{read:()=>null,write:()=>{throw Error('disk full');}}});
 assert.ok(seen.sources.every(s=>s.status==='unavailable'&&s.code==='STUDIO_SOURCE_STATE'&&/disk full/.test(s.error)));assert.deepEqual(seen.observed,[]);
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

test('unreleased-build guard: an unannounced version on releaseshub is never asked about; a late upload of the noted version is held',async()=>{
 const {fetcher,state}=fakeSites();
 const cf='https://dxejw4oyledi.cloudfront.net/repository/';
 // 11.55.96.65382 really exists on releaseshub/CloudFront (2026-11-03) but is not released; 1.7.33 and 1.7.32.11090 are synthetic.
 state.hub['ServiceStudio/11.55.96.65382/windows']={location:cf+'servicestudio/11.55.96.65382/ServiceStudio-11.55.96.65382.exe',lastModified:'Tue, 03 Nov 2026 10:00:00 GMT',size:351700000};
 state.hub['ODCStudio/1.7.33.11080/windows']={location:cf+'odcstudio/1.7.33.11080/ODCStudio-1.7.33.11080.exe',lastModified:'Mon, 09 Nov 2026 10:00:00 GMT',size:287900000};
 state.hub['ODCStudio/1.7.32.11090/windows']={location:cf+'odcstudio/1.7.32.11090/ODCStudio-1.7.32.11090.exe',lastModified:'Mon, 09 Nov 2026 22:00:00 GMT',size:287900000};
 const seen=await detectSources([],{fetcher,...fast});
 assert.deepEqual(seen.observed.map(o=>o.fullVersion),['1.7.32.11065','11.55.95.65352']);
 assert.deepEqual(seen.sources.find(s=>s.lane==='odc').heldBuilds,[11090]);
 assert.ok(!state.calls.some(c=>c.includes('11.55.96')||c.includes('1.7.33')));
 // The held build alone (the GA missing) is "no released build", never adopted.
 delete state.hub['ODCStudio/1.7.32.11065/windows'];delete state.hub['ODCStudio/1.7.32.11059/windows'];delete state.hub['ODCStudio/1.7.32.11035/windows'];
 await assert.rejects(latestStudio('odc','1.7.31.10988',{fetcher,...fast}),e=>e.code==='STUDIO_BUILD_NOT_FOUND'&&/later: 11090/.test(e.message));
});

test('M2: the served window, not the Studio installed on the watcher, decides; a newer installed Studio (a preview) is flagged',async()=>{
 const {fetcher,state}=fakeSites();
 // A preview Service Studio 11.55.96 installed here no longer hides the released, unserved 11.55.95.
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
 // The window already serves something newer than the source names: older-than-served, nothing offered.
 seen=await detectSources([],{fetcher,...fast,served:{odc:['1.7.32'],o11:['11.55.96']}});
 assert.deepEqual(seen.sources.map(s=>[s.lane,s.status]),[['odc','public'],['o11','older-than-served']]);
 assert.ok(!seen.observed.some(x=>x.lane==='o11'));assert.ok(state.calls.length>0);
});

test('M2/A1: the round notifies the owner (once) of a newer watcher Studio and of a later build of a decided version',async t=>{
 const {createAutoRuntime}=await import('./auto-runtime.mjs');
 const dir=tmp(t),notes=[],logs=[],f=fakeSites();
 f.state.hub['ODCStudio/1.7.32.11090/windows']={location:CF+'1.7.32.11090/ODCStudio-1.7.32.11090.exe',lastModified:'Mon, 09 Nov 2026 22:00:00 GMT',size:287900000};
 const runtime={log:m=>logs.push(m),notify:async(title,message)=>{notes.push([title,message]);},sourceFetcher:f.fetcher};
 const auto=createAutoRuntime({workspace:dir,tempRoot:dir,outDir:dir,automatic:false,now:NOW},runtime);Object.assign(runtime,auto);
 const manifest={odc:[{version:'1.7.32'}],o11:[{version:'11.55.95'}]};
 const installed=[{lane:'o11',version:'11.55.96',fullVersion:'11.55.96.65382'}];
 const dry=await runtime.observe(installed,{dryRun:true,manifest});
 assert.deepEqual(dry.map(x=>x.fullVersion),['11.55.96.65382','1.7.32.11065','11.55.95.65352']);
 assert.equal(notes.length,0,'a dry run notifies nobody');assert.ok(!fs.existsSync(path.join(dir,'studio-sources.json')),'a dry run writes no decision');
 await runtime.observe(installed,{manifest});await runtime.observe(installed,{manifest});
 assert.deepEqual(notes.map(n=>n[0]).sort(),['SSAM: later Studio build not offered','SSAM: watcher Studio newer than the public release']);
 assert.match(notes.find(n=>/later/.test(n[0]))[1],/ODC Studio 1\.7\.32 is decided as 1\.7\.32\.11065.*1\.7\.32\.11090.*NOT offered/);
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
