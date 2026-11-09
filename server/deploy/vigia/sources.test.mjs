import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {detectSources,latestStudio,downloadInstaller,officialUrl,releaseFor,contentLink,parseOdcNotes,TRUSTED_HOSTS,DOWNLOADS,ODC_NOTES_PAGE} from './sources.mjs';
import {fakeSites} from './test-fixtures/sources/fake.mjs';
const fast={retryDelayMs:0};
const HUB='https://api.outsystems.com/releaseshub/v1/component/';
const odcInstalled=[{lane:'odc',version:'1.7.31',fullVersion:'1.7.31.10988'}];
const tmp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'vigia-sources-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};

test('O11: the Downloads page names Service Studio with build, sizes and Windows + Mac (Intel, ARM) links',async()=>{
 const {fetcher}=fakeSites();
 const r=await latestStudio('o11',undefined,{fetcher,...fast});
 assert.equal(r.fullVersion,'11.55.95.65352');assert.equal(r.version,'11.55.95');assert.equal(r.source,DOWNLOADS);
 assert.equal(r.url,HUB+'ServiceStudio/version/11.55.95.65352/platform/windows/content');assert.equal(r.size,351668800);
 assert.deepEqual(r.platforms.macosx,{fullVersion:'11.55.95.65352',url:HUB+'ServiceStudio/version/11.55.95.65352/platform/macosx/content',file:'ServiceStudio-11.55.95.65352.dmg',size:457849738});
 assert.deepEqual(r.platforms.macosx_arm64,{fullVersion:'11.55.95.65352',url:HUB+'ServiceStudio/version/11.55.95.65352/platform/macosx_arm64/content',file:'ServiceStudio-11.55.95.65352_arm64.dmg',size:443612066});
 assert.equal(r.platforms.windows.file,'ServiceStudio-11.55.95.65352.exe');
});

test('ODC: the release notes name 1.7.32 and the GA is its highest build uploaded by the day after (11065, not 11035/11059)',async()=>{
 const {fetcher,state}=fakeSites();
 const r=await latestStudio('odc','1.7.31.10988',{fetcher,...fast});
 assert.equal(r.fullVersion,'1.7.32.11065');assert.equal(r.releasedOn,'2026-11-08');assert.equal(r.source,ODC_NOTES_PAGE);
 assert.equal(r.url,HUB+'ODCStudio/version/1.7.32.11065/platform/windows/content');assert.equal(r.size,287852448);
 assert.equal(r.platforms.macosx.url,HUB+'ODCStudio/version/1.7.32.11065/platform/macosx/content');
 assert.equal(r.platforms.macosx_arm64.file,'ODCStudio-1.7.32.11065_arm64.dmg');
 // The window starts at the higher of the installed build and the last known GA (11065) and only asks about the noted version.
 const probes=state.calls.filter(c=>c.includes('/releaseshub/'));
 assert.equal(probes.length,601);assert.ok(probes.every(c=>c.includes('/ODCStudio/version/1.7.32.')));
 assert.ok(probes.some(c=>c.includes('1.7.32.11065/'))&&probes.some(c=>c.includes('1.7.32.11665/'))&&!probes.some(c=>c.includes('1.7.32.11064/')));
 assert.deepEqual(parseOdcNotes(state.content.data.Html).map(n=>`${n.version} ${n.releasedOn}`),['1.7.32 2026-11-08','1.7.31 2026-11-02','1.7.30 2026-10-26','1.7.29 2026-10-19']);
 // Nothing installed: the floor is the last known GA, so it is found again.
 assert.equal((await latestStudio('odc',undefined,{fetcher,...fast})).fullVersion,'1.7.32.11065');
});

test('unreleased-build guard: an unannounced version on releaseshub is never asked about; a later upload of the noted version waits',async()=>{
 const {fetcher,state}=fakeSites();
 const cf='https://dxejw4oyledi.cloudfront.net/repository/';
 // 11.55.96.65382 really exists on releaseshub/CloudFront (2026-11-03) but is not released; 1.7.33 and 1.7.32.11090 are synthetic.
 state.hub['ServiceStudio/11.55.96.65382/windows']={location:cf+'servicestudio/11.55.96.65382/ServiceStudio-11.55.96.65382.exe',lastModified:'Tue, 03 Nov 2026 10:00:00 GMT',size:351700000};
 state.hub['ODCStudio/1.7.33.11080/windows']={location:cf+'odcstudio/1.7.33.11080/ODCStudio-1.7.33.11080.exe',lastModified:'Mon, 09 Nov 2026 10:00:00 GMT',size:287900000};
 state.hub['ODCStudio/1.7.32.11090/windows']={location:cf+'odcstudio/1.7.32.11090/ODCStudio-1.7.32.11090.exe',lastModified:'Thu, 12 Nov 2026 10:00:00 GMT',size:287900000};
 const seen=await detectSources([],{fetcher,...fast});
 assert.deepEqual(seen.observed.map(o=>o.fullVersion),['1.7.32.11065','11.55.95.65352']);
 assert.deepEqual(seen.sources.find(s=>s.lane==='odc').heldBuilds,[11090]);
 assert.ok(!state.calls.some(c=>c.includes('11.55.96')||c.includes('1.7.33')));
 // The held build alone (the GA missing) is "no released build yet", never adopted.
 delete state.hub['ODCStudio/1.7.32.11065/windows'];delete state.hub['ODCStudio/1.7.32.11059/windows'];delete state.hub['ODCStudio/1.7.32.11035/windows'];
 await assert.rejects(latestStudio('odc','1.7.31.10988',{fetcher,...fast}),e=>e.code==='STUDIO_BUILD_NOT_FOUND'&&/held: 11090/.test(e.message));
});

test('token rotation: tokens are re-read from the published scripts every run, and once more when one rotates mid-run',async()=>{
 const {fetcher,state}=fakeSites();
 assert.equal((await latestStudio('o11',undefined,{fetcher,...fast})).fullVersion,'11.55.95.65352');
 // The site is republished: new tokens in the scripts, the old ones refused.
 state.tokens={releases:'NEWreleasesTokenAAAAAA',guid:'NEWguidTokenAAAAAAAAAA',content:'NEWcontentTokenAAAAAAA'};
 assert.equal((await latestStudio('o11',undefined,{fetcher,...fast})).fullVersion,'11.55.95.65352');
 assert.equal((await latestStudio('odc','1.7.32.11065',{fetcher,...fast,window:10})).fullVersion,'1.7.32.11065');
 // Rotation between the script read and the call: the first POST is refused, the site is re-read once, the call succeeds.
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
 // A probe that keeps failing stops the whole build search (a gap could hide the GA): no partial answer.
 const f2=fakeSites();f2.state.fail=u=>u.pathname.includes('1.7.32.11100/')?new Response('',{status:500}):null;
 await assert.rejects(latestStudio('odc','1.7.31.10988',{fetcher:f2.fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_UNREACHABLE');
 const seen=await detectSources(odcInstalled,{fetcher:async()=>{throw Error('offline');},...fast});
 assert.deepEqual(seen.observed,odcInstalled);assert.ok(seen.sources.every(s=>s.status==='unavailable'&&s.code==='STUDIO_SOURCE_UNREACHABLE'));
});

test('older than installed: logged as such and the installed Studio kept',async()=>{
 const {fetcher,state}=fakeSites();
 const local=[{lane:'odc',version:'1.7.33',fullVersion:'1.7.33.11200'},{lane:'o11',version:'11.55.96',fullVersion:'11.55.96.65382'}];
 const seen=await detectSources(local,{fetcher,...fast});
 assert.deepEqual(seen.observed,local);
 assert.deepEqual(seen.sources.map(s=>[s.lane,s.status,s.version,s.installed]),[['odc','older-than-installed','1.7.32','1.7.33.11200'],['o11','older-than-installed','11.55.95.65352','11.55.96.65382']]);
 assert.ok(!state.calls.some(c=>c.includes('/ODCStudio/')),'nothing probed for an older noted version');
 // A preview build of the noted version installed here (above every released build) is kept too.
 const pre=await detectSources([{lane:'odc',version:'1.7.32',fullVersion:'1.7.32.11070'}],{fetcher,...fast,window:5});
 assert.equal(pre.sources[0].status,'older-than-installed');
});

test('the same release as installed adds the download link and platforms to the installed entry; a newer one is a candidate',async()=>{
 const {fetcher}=fakeSites();
 const seen=await detectSources([{lane:'odc',version:'1.7.32',fullVersion:'1.7.32.11065'},{lane:'o11',version:'11.55.94',fullVersion:'11.55.94.65328'}],{fetcher,...fast});
 assert.equal(seen.observed.length,3);
 assert.equal(seen.observed[0].url,HUB+'ODCStudio/version/1.7.32.11065/platform/windows/content');assert.ok(seen.observed[0].platforms.macosx_arm64);
 assert.equal(seen.observed[2].fullVersion,'11.55.95.65352');assert.equal(seen.observed[2].requiresInstallation,true);
 assert.deepEqual(seen.sources.map(s=>[s.lane,s.status,s.version]),[['odc','public','1.7.32.11065'],['o11','public','11.55.95.65352']]);
});

test('allowlist: exactly the four hosts, https, no port or user; redirects to other hosts are refused',async()=>{
 assert.deepEqual([...TRUSTED_HOSTS].sort(),['api.outsystems.com','dxejw4oyledi.cloudfront.net','success.outsystems.com','www.outsystems.com']);
 for(const bad of ['https://evil.example/a.exe','http://www.outsystems.com/downloads/','https://www.outsystems.com:8443/x','https://u:p@success.outsystems.com/','https://rogue.outsystems.com/x'])assert.throws(()=>officialUrl(bad),bad);
 const {fetcher,state}=fakeSites();state.hub['ServiceStudio/11.55.95.65352/windows'].location='https://evil.example/ServiceStudio-11.55.95.65352.exe';
 await assert.rejects(latestStudio('o11',undefined,{fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_UNTRUSTED');
 const f2=fakeSites();f2.state.fail=u=>u.pathname.endsWith('/DataActionGetReleases')?new Response(null,{status:302,headers:{location:'https://evil.example/'}}):null;
 await assert.rejects(latestStudio('o11',undefined,{fetcher:f2.fetcher,...fast}),e=>e.code==='STUDIO_SOURCE_CHANGED');
 assert.ok(!f2.state.calls.some(c=>c.includes('evil.example')));
});

test('download link builder (the old releaseFor role) and the download through the releaseshub redirect, size-checked',async t=>{
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
 const auto=createAutoRuntime({workspace:dir,tempRoot:dir,outDir:dir,automatic:false},runtime);Object.assign(runtime,auto);
 const manifest={odc:[{version:'1.7.32'}],o11:[{version:'11.55.95'}]};
 const installed=[{lane:'odc',version:'1.7.32',fullVersion:'1.7.32.11065'},{lane:'o11',version:'11.55.95',fullVersion:'11.55.95.65352'}];
 assert.deepEqual(await runtime.observe(installed,{manifest}),[]);assert.equal(notes.length,0);
 // The Downloads page changes shape: the O11 lane is unavailable, the owner is told, the ODC lane goes on.
 const f=fakeSites();f.state.releases.win.data={};runtime.sourceFetcher=f.fetcher;
 await runtime.observe(installed,{dryRun:true,manifest});assert.equal(notes.length,0,'a dry run notifies nobody');
 await runtime.observe(installed,{manifest});await runtime.observe(installed,{manifest});
 assert.equal(notes.length,1);assert.equal(notes[0][0],'SSAM: Studio release source unreadable');assert.match(notes[0][1],/Service Studio.*STUDIO_SOURCE_CHANGED/);
 assert.deepEqual(runtime.sourceStatus.map(s=>s.status),['public','unavailable']);
 assert.ok(logs.some(l=>/o11 source unavailable \(STUDIO_SOURCE_CHANGED\)/.test(l)));
});

test('the build search goes on to the next window (bounded) only while nothing was found or the find sits at its top',async()=>{
 const notes='<h2 id="odc_studio_1.7.33" >ODC Studio 1.7.33</h2>\r\n<div class="info"><p>Released on Nov 15, 2026</p></div>';
 const at=(s,b)=>{s.hub[`ODCStudio/1.7.33.${b}/windows`]={location:`https://dxejw4oyledi.cloudfront.net/repository/odcstudio/1.7.33.${b}/ODCStudio-1.7.33.${b}.exe`,lastModified:'Sun, 15 Nov 2026 09:00:00 GMT',size:287900000};};
 let f=fakeSites();f.state.content.data.Html=notes;at(f.state,11120);at(f.state,11150);
 assert.equal((await latestStudio('odc','1.7.32.11065',{fetcher:f.fetcher,...fast,window:60})).fullVersion,'1.7.33.11150');
 assert.equal(f.state.calls.filter(c=>c.includes('/releaseshub/')).length,61*2);
 f=fakeSites();f.state.content.data.Html=notes;at(f.state,11200);
 assert.equal((await latestStudio('odc','1.7.32.11065',{fetcher:f.fetcher,...fast,window:60})).fullVersion,'1.7.33.11200');
 await assert.rejects(latestStudio('odc','1.7.32.11065',{fetcher:f.fetcher,...fast,window:60,maxWindows:2}),e=>e.code==='STUDIO_BUILD_NOT_FOUND'&&/11065\.\.11186/.test(e.message));
});
