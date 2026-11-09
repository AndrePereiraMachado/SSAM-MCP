// Where the vigia learns the latest released Studios, and how it downloads them. Installers are downloaded, hashed and
// extracted as data only. No installer is ever executed.
//
// Discovery (C:\t\r5\FONTE-VERSOES.md, options A and B), both anonymous reads of public OutSystems pages:
//  - Service Studio (O11): the outsystems.com/downloads screen service DataActionGetReleases names the released full
//    version (with build), file name and size, for Windows and for Mac (Intel and ARM).
//  - ODC Studio: the ODC Studio release notes on success.outsystems.com name X.Y.Z and "Released on"; the build is the
//    highest build of THAT version that exists on releaseshub, uploaded no later than a day after the release day.
// The screen services' apiVersion tokens (and the anonymous CSRF token) are re-read from the sites' published scripts on
// every run, so a republish of either site heals itself. Only versions those pages name are ever asked about: a version
// that exists on releaseshub but is not announced (11.55.96.65382 on 2026-11-09) is never probed or offered.
// releaseshub/v1/latest is no longer used: it echoes the version it is asked about.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const RELEASES_HUB='https://api.outsystems.com/releaseshub/v1/component/';
export const DOWNLOADS='https://www.outsystems.com/downloads/';
export const DOCS='https://success.outsystems.com/';
export const ODC_NOTES_PAGE=DOCS+'support/release_notes/outsystems_developer_cloud_releases/odc_studio/';
export const PLATFORMS=Object.freeze(['windows','macosx','macosx_arm64']);
// The hosts the vigia reads, exactly. Every redirect is checked against the same list.
export const TRUSTED_HOSTS=Object.freeze(['api.outsystems.com','dxejw4oyledi.cloudfront.net','www.outsystems.com','success.outsystems.com']);
// OutSystems' reactive runtime anonymous-session token, used only when the published runtime script no longer carries it.
const ANON_CSRF='T6C+9iB49TLra4jEsMeSckDMNhQ=';
// The last ODC Studio GA known when this was written: the floor of the build search when nothing newer is installed.
export const ODC_KNOWN={version:'1.7.32',build:11065};
export const ODC_BUILD_WINDOW=600;
const COMPONENT={odc:'ODCStudio',o11:'ServiceStudio'};
const EXT={windows:'.exe',macosx:'.dmg',macosx_arm64:'_arm64.dmg'};
const MAX_TEXT=8*1024**2;
// An environmental source problem: the round keeps the installed Studio for that lane, says so and retries next round.
// STUDIO_SOURCE_UNREACHABLE (network, timeouts, 5xx after retries), STUDIO_SOURCE_CHANGED (a page or service changed
// shape), STUDIO_SOURCE_UNTRUSTED (a redirect to an unlisted host), STUDIO_BUILD_NOT_FOUND (an announced version without
// a released build yet).
export class SourceError extends Error{constructor(message,code){super(message);this.code=code;this.environmental=true;}}
const changed=what=>new SourceError(`Studio release source changed shape: ${what}.`,'STUDIO_SOURCE_CHANGED');
export function officialUrl(value) {
 const u=new URL(value);
 if(u.protocol!=='https:' || u.username || u.password || u.port || !TRUSTED_HOSTS.includes(u.hostname))throw Error('Untrusted Studio release URL.');
 return u.href;
}
const trusted=value=>{try{return officialUrl(value);}catch{throw new SourceError(`Studio release source pointed outside the allowlist (${String(value).slice(0,120)}).`,'STUDIO_SOURCE_UNTRUSTED');}};
export const compareVersions=(a,b)=>{const x=String(a).split('.').map(Number),y=String(b).split('.').map(Number);for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]??0)-(y[i]??0);if(d)return Math.sign(d);}return 0;};
const threeOf=v=>String(v).split('.').slice(0,3).join('.');
// The releaseshub download link of one full version and platform (it 301s to the CloudFront file): the old releaseFor's
// download role, kept; discovery no longer goes through it.
export const contentLink=(lane,fullVersion,platform='windows')=>{
 if(!COMPONENT[lane]||!PLATFORMS.includes(platform)||!/^\d+\.\d+\.\d+\.\d+$/.test(fullVersion))throw Error('Invalid Studio download link request.');
 return `${RELEASES_HUB}${COMPONENT[lane]}/version/${fullVersion}/platform/${platform}/content`;
};
export const fileName=(lane,fullVersion,platform)=>`${COMPONENT[lane]}-${fullVersion}${EXT[platform]}`;
const cloudFrontPath=(lane,fullVersion,platform)=>`/repository/${COMPONENT[lane].toLowerCase()}/${fullVersion}/${fileName(lane,fullVersion,platform)}`;
// A release record for a full version that a discovery page named. Mac links are carried for later phases; the Windows
// flow uses url (= platforms.windows.url) only.
export function releaseFor(lane,fullVersion,{source=null,platforms={},releasedOn}={}) {
 if(!/^\d+\.\d+\.\d+\.\d+$/.test(fullVersion))throw changed('invalid version '+String(fullVersion).slice(0,40));
 const all=Object.fromEntries(PLATFORMS.map(p=>{const v=platforms[p]?.fullVersion??fullVersion;return [p,{fullVersion:v,url:contentLink(lane,v,p),file:fileName(lane,v,p),...(platforms[p]?.size?{size:platforms[p].size}:{})}];}));
 return {lane,version:threeOf(fullVersion),fullVersion,url:all.windows.url,...(all.windows.size?{size:all.windows.size}:{}),platforms:all,source,...(releasedOn?{releasedOn}:{}),requiresInstallation:true,tfm:null};
}
const pause=ms=>ms>0?new Promise(r=>setTimeout(r,ms)):null;
// Probe and HEAD answers are read for their status and headers only: their bodies are released at once (hundreds per round).
const drop=r=>{try{r.body?.cancel?.().catch?.(()=>{});}catch{}};
// One request with a timeout and bounded retries (network errors, timeouts, 429 and 5xx); redirects are never followed.
async function call(o,url,init={}){
 let last;
 for(let n=0;n<o.tries;n++){
  if(n)await pause(o.retryDelayMs*n);
  try{
   const r=await o.fetcher(trusted(url),{redirect:'manual',...init,signal:AbortSignal.timeout(o.timeoutMs)});
   if(r.status===429||r.status>=500){drop(r);last=`HTTP ${r.status}`;continue;}
   return r;
  }catch(e){if(e instanceof SourceError)throw e;last=e.message;}
 }
 throw new SourceError(`Studio release source unreachable: ${new URL(url).hostname} (${last}).`,'STUDIO_SOURCE_UNREACHABLE');
}
async function text(o,url,init){
 const r=await call(o,url,init);
 if(r.status!==200)throw changed(`HTTP ${r.status} from ${new URL(url).pathname}`);
 const t=await r.text();if(t.length>MAX_TEXT)throw changed('oversized answer from '+new URL(url).pathname);
 return t;
}
// The site's published scripts: moduleinfo lists them (versioned); the screen script carries each action's apiVersion.
async function readSite(o,base,screens){
 const origin=new URL(base).origin,mi=await text(o,base+'moduleservices/moduleinfo',{headers:{accept:'application/json'}});
 let files;try{files=JSON.parse(mi.slice(mi.indexOf('{'))).manifest.urlVersions;}catch{throw changed('moduleinfo is not the module manifest');}
 if(!files||typeof files!=='object')throw changed('moduleinfo without urlVersions');
 const script=async test=>{
  const key=Object.keys(files).find(k=>k.endsWith('.js')&&test(k.split('/').pop()));if(!key)return null;
  const u=new URL(key+String(files[key]),origin);if(u.origin!==origin)throw changed('script outside its site');
  return text(o,u.href);
 };
 const runtime=await script(n=>n.startsWith('OutSystems__'));
 const csrf=runtime?.match(/AnonymousCSRFToken="([^"]+)"/)?.[1]??ANON_CSRF;
 const tokens={};
 for(const [screen,actions] of Object.entries(screens)){
  const js=await script(n=>n.startsWith(screen+'.mvc__'));if(!js)throw changed(`screen script ${screen} not listed`);
  for(const action of actions){
   const m=js.match(new RegExp('"'+action.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'",\\s*"([^"]+)"'));
   if(!m)throw changed(`no apiVersion for ${action.split('/').pop()}`);tokens[action]=m[1];
  }
 }
 return {csrf,tokens};
}
// A screen service call. A token that rotated between the script read and the call (hasApiVersionChanged) re-reads the
// site once; a second refusal is a changed page.
async function screenService(o,site,action,body){
 for(let n=0;;n++){
  const r=await call(o,site.base+action,{method:'POST',headers:{'X-CSRFToken':site.ctx.csrf,'Content-Type':'application/json; charset=UTF-8',accept:'application/json'},
   body:JSON.stringify({versionInfo:{moduleVersion:'',apiVersion:site.ctx.tokens[action]},...body})});
  if(r.status!==200)throw changed(`HTTP ${r.status} from ${action.split('/').pop()}`);
  let j;try{j=JSON.parse(await r.text());}catch{throw changed(`${action.split('/').pop()} did not answer JSON`);}
  if(j.exception)throw changed(`${action.split('/').pop()} refused (${String(j.exception.message??'').slice(0,80)})`);
  if(j.versionInfo?.hasApiVersionChanged){if(n)throw changed(`${action.split('/').pop()} apiVersion still rejected after re-reading the site`);site.ctx=await readSite(o,site.base,site.screens);continue;}
  if(!j.data||typeof j.data!=='object')throw changed(`${action.split('/').pop()} without data`);
  return j.data;
 }
}
async function site(o,base,screens){return {base,screens,ctx:await readSite(o,base,screens)};}
// What exists on releaseshub for one full version: the CloudFront location of its Windows file, or null on 404.
async function exists(o,lane,fullVersion,platform='windows'){
 const r=await call(o,contentLink(lane,fullVersion,platform));drop(r);
 if(r.status===404)return null;
 if(r.status!==301&&r.status!==302)throw changed(`releaseshub answered HTTP ${r.status} for ${fullVersion}`);
 const loc=trusted(new URL(r.headers.get('location')??'',contentLink(lane,fullVersion,platform)).href);
 if(new URL(loc).pathname!==cloudFrontPath(lane,fullVersion,platform))throw changed(`releaseshub redirected ${fullVersion} to ${new URL(loc).pathname}`);
 return loc;
}
async function head(o,url){
 const r=await call(o,url,{method:'HEAD'});drop(r);
 if(r.status!==200)throw changed(`HTTP ${r.status} for ${new URL(url).pathname.split('/').pop()}`);
 const modified=Date.parse(r.headers.get('last-modified')??''),size=Number(r.headers.get('content-length'));
 return {modified:Number.isFinite(modified)?modified:null,size:size>0?size:null};
}
const RELEASES='screenservices/Downloads/MainFlow/HomeScreen/DataActionGetReleases';
export async function latestO11(o){
 const s=await site(o,DOWNLOADS,{'Downloads.MainFlow.HomeScreen':[RELEASES]});
 const files=[];
 for(const IsMacUser of [false,true]){
  const list=(await screenService(o,s,RELEASES,{viewName:'MainFlow.HomeScreen',screenData:{variables:{}},clientVariables:{IsMacUser}})).ReleaseDownloadList?.List;
  if(!Array.isArray(list))throw changed('GetReleases without ReleaseDownloadList');
  files.push(...list);
 }
 const platforms={};
 for(const f of files){
  const m=String(f.Filename??'').match(/^ServiceStudio-(\d+\.\d+\.\d+\.\d+)(_arm64\.dmg|\.dmg|\.exe)$/);if(!m)continue;
  const p={'.exe':'windows','.dmg':'macosx','_arm64.dmg':'macosx_arm64'}[m[2]];
  if(platforms[p]&&platforms[p].fullVersion!==m[1])throw changed('GetReleases names two Service Studio versions for '+p);
  platforms[p]={fullVersion:m[1],size:Number(f.Filesize)||undefined};
 }
 if(!platforms.windows)throw changed('GetReleases without a Windows Service Studio');
 const full=platforms.windows.fullVersion;
 // The announced build must be downloadable where the vigia downloads it, with the announced size.
 const loc=await exists(o,'o11',full);if(!loc)throw new SourceError(`Service Studio ${full} is on the Downloads page but not on releaseshub yet.`,'STUDIO_BUILD_NOT_FOUND');
 const h=await head(o,loc);if(platforms.windows.size&&h.size&&h.size!==platforms.windows.size)throw changed(`Service Studio ${full} size ${h.size} differs from the Downloads page (${platforms.windows.size})`);
 return releaseFor('o11',full,{source:DOWNLOADS,platforms});
}
const GUID='screenservices/Documentation_UI/Documentation/Support/DataActionGetContentGUID';
const CONTENT='screenservices/Documentation_UI/Documentation/ContentDoc/DataActionGetDocContent';
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
// Every "ODC Studio X.Y.Z" heading of the release notes with its "Released on Mon DD, YYYY" (UTC day).
export function parseOdcNotes(html){
 const out=[];
 for(const m of String(html).matchAll(/<h2[^>]*>\s*ODC Studio (\d+\.\d+\.\d+)\s*<\/h2>\s*(?:<div[^>]*>\s*<p>\s*Released on ([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4})\s*<\/p>)?/g)){
  const month=MONTHS.indexOf(String(m[2]).toLowerCase());
  out.push({version:m[1],releasedOn:month<0?null:new Date(Date.UTC(+m[4],month,+m[3])).toISOString().slice(0,10)});
 }
 return out;
}
export async function latestOdc(o,{installed}={}){
 const s=await site(o,DOCS,{'Documentation_UI.Documentation.Support':[GUID],'Documentation_UI.Documentation.ContentDoc':[CONTENT]});
 const titles=Object.fromEntries(Array.from({length:12},(_,i)=>['ContentTitle'+(i+1),['release_notes','outsystems_developer_cloud_releases','odc_studio'][i]??'']));
 const g=await screenService(o,s,GUID,{viewName:'Documentation.Support',screenData:{variables:titles}});
 if(!g.ContentFound||!/^[0-9a-f-]{36}$/i.test(g.GUID??''))throw changed('ODC Studio release notes not found');
 const doc=await screenService(o,s,CONTENT,{viewName:'Documentation.Support',screenData:{variables:{RepoSection:'Support',_repoSectionInDataFetchStatus:1,GUID:g.GUID,_gUIDInDataFetchStatus:1,LocaleId:'en-US',_localeIdInDataFetchStatus:1}}});
 const notes=parseOdcNotes(doc.Html);if(!notes.length)throw changed('ODC Studio release notes without a version heading');
 const noted=notes.reduce((a,b)=>compareVersions(b.version,a.version)>0?b:a);
 if(!noted.releasedOn)throw changed(`ODC Studio ${noted.version} without a release date`);
 if(installed&&compareVersions(noted.version,threeOf(installed))<0)return {lane:'odc',version:noted.version,fullVersion:null,olderThanInstalled:installed,source:ODC_NOTES_PAGE};
 // Builds grow across versions: start at the installed build (or the last known GA) and search windows of o.window builds,
 // going on to the next window (at most o.maxWindows) only while nothing was found or the highest find sits in the last
 // sixth of the window. Only the version the notes name is probed, never the next one.
 const floor=Math.max(installed?Number(installed.split('.')[3])||0:0,compareVersions(noted.version,ODC_KNOWN.version)>=0?ODC_KNOWN.build:0);
 if(!floor)throw changed(`ODC Studio ${noted.version} is older than the last known release and nothing is installed`);
 const found=[];let lo=floor,hi=floor;
 for(let w=0;w<o.maxWindows;w++,lo=hi+1){
  hi=lo+o.window;const queue=Array.from({length:hi-lo+1},(_,i)=>lo+i);
  await Promise.all(Array.from({length:o.parallel},async()=>{try{while(queue.length){const b=queue.shift(),loc=await exists(o,'odc',`${noted.version}.${b}`);if(loc)found.push({build:b,loc});}}catch(e){queue.length=0;throw e;}}));
  if(found.length&&Math.max(...found.map(f=>f.build))<=hi-Math.ceil(o.window/6))break;
 }
 // The GA is the highest build of the noted version uploaded by the end of the day after the release day; a build uploaded
 // later is a hotfix not announced by these notes and waits. Checked against every version 1.7.27..1.7.32 (RESULTADO.md):
 // it picks 10846, 10873, 10940, 10980, 10988, 11065; plain "highest" would have taken 1.7.29.10953 (2 days late).
 const limit=Date.parse(noted.releasedOn)+2*86400000,held=[];
 for(const f of found.sort((a,b)=>b.build-a.build)){
  const h=await head(o,f.loc);
  if(!h.modified)throw changed(`no Last-Modified for ODC Studio ${noted.version}.${f.build}`);
  if(h.modified>limit){held.push(f.build);continue;}
  return {...releaseFor('odc',`${noted.version}.${f.build}`,{source:ODC_NOTES_PAGE,releasedOn:noted.releasedOn,platforms:{windows:{size:h.size}}}),...(held.length?{heldBuilds:held}:{})};
 }
 // The installed build is this version and nothing released is at or above it (a preview installed here): keep it.
 if(installed&&threeOf(installed)===noted.version)return {lane:'odc',version:noted.version,fullVersion:null,olderThanInstalled:installed,source:ODC_NOTES_PAGE,...(held.length?{heldBuilds:held}:{})};
 throw new SourceError(`ODC Studio ${noted.version} (released ${noted.releasedOn}) has no build ${floor}..${hi} on releaseshub${held.length?` uploaded by the day after (held: ${held.join(', ')})`:''}.`,'STUDIO_BUILD_NOT_FOUND');
}
const options=({fetcher=fetch,tries=3,retryDelayMs=1000,timeoutMs=30000,parallel=16,window=ODC_BUILD_WINDOW,maxWindows=3}={})=>({fetcher,tries,retryDelayMs,timeoutMs,parallel,window,maxWindows});
export async function latestStudio(lane,installed,opts={}){
 const o=options(opts);
 return lane==='odc'?latestOdc(o,{installed}):latestO11(o);
}
const highest=(installed,lane)=>installed.filter(x=>x.lane===lane&&/^\d+\.\d+\.\d+\.\d+$/.test(x.fullVersion??'')).map(x=>x.fullVersion).sort(compareVersions).at(-1);
// Per lane: the public release (with its download link) or why there is none this round. Never throws: a source that
// cannot be read is 'unavailable' with its code (the round keeps the installed Studio, notifies and retries), never "no
// update"; a release older than the installed Studio is logged and the installed one kept.
export async function detectSources(installed,opts={}) {
 const releases=[],sources=[],local=installed.map(x=>({...x}));
 for(const lane of ['odc','o11']){
  const mine=highest(installed,lane),started=Date.now();
  try {
   const r=await latestStudio(lane,mine,opts);
   const ms=Date.now()-started;
   if(!r.fullVersion||(mine&&compareVersions(r.fullVersion,mine)<0)){sources.push({lane,status:'older-than-installed',version:r.fullVersion??r.version,installed:mine,source:r.source,fallback:'installed Studio',ms});continue;}
   sources.push({lane,status:'public',version:r.fullVersion,source:r.source,ms,...(r.heldBuilds?{heldBuilds:r.heldBuilds}:{})});
   const same=local.find(x=>x.lane===lane&&x.fullVersion===r.fullVersion);
   if(same)Object.assign(same,{url:r.url,source:r.source,platforms:r.platforms,...(r.size?{size:r.size}:{})});else releases.push(r);
  } catch(e){sources.push({lane,status:'unavailable',code:e.code??'STUDIO_SOURCE_UNREACHABLE',error:String(e.message).slice(0,300),fallback:'installed Studio',ms:Date.now()-started});}
 }
 return {observed:[...local,...releases],sources};
}
export async function downloadInstaller(release,directory,{fetcher=fetch,allowTestHttp=false}={}) {
 const name=`${release.lane}-${release.fullVersion}.exe`,target=path.join(directory,name);
 if(!/^\d+\.\d+\.\d+\.\d+$/.test(release.fullVersion))throw Error('Invalid installer version.');
 const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 if(fs.existsSync(target)){
  if(fs.readFileSync(target+'.sha256','utf8').trim()!==digest(target))throw Error('Stored installer checksum mismatch.');
  return {file:target,sha256:digest(target)};
 }
 let url=allowTestHttp?release.url:officialUrl(release.url),response;
 for(let n=0;n<6;n++){
  response=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(120000)});
  if([301,302,303,307,308].includes(response.status)){url=new URL(response.headers.get('location'),url).href;if(!allowTestHttp)officialUrl(url);continue;}
  break;
 }
 if(!response?.ok)throw Error('Studio installer download failed.');
 fs.mkdirSync(directory,{recursive:true});
 const partial=target+`.partial-${process.pid}`;const fd=fs.openSync(partial,'wx',0o600);let total=0;
 try{
  for await(const chunk of response.body){total+=chunk.length;if(total>2*1024**3)throw Error('Studio installer is too large.');fs.writeSync(fd,chunk);}
  fs.closeSync(fd);
  if(release.size&&total!==release.size)throw Error(`Studio installer size ${total} differs from the release source (${release.size}).`);
  const header=fs.readFileSync(partial).subarray(0,2);if(header.toString()!=='MZ')throw Error('Studio source did not return a Windows installer.');
  const hash=digest(partial);fs.writeFileSync(partial+'.sha256',hash+'\n');fs.renameSync(partial,target);fs.renameSync(partial+'.sha256',target+'.sha256');
  return {file:target,sha256:hash};
 }catch(e){try{fs.closeSync(fd);}catch{}fs.rmSync(partial,{force:true});fs.rmSync(partial+'.sha256',{force:true});throw e;}
}
