// Where the vigia learns the latest released Studios, and how it downloads them. Installers are downloaded, hashed and
// extracted as data only. No installer is ever executed.
//
// Discovery (C:\t\r5\FONTE-VERSOES.md, options A and B), both anonymous reads of public OutSystems pages:
//  - Service Studio (O11): the outsystems.com/downloads screen service DataActionGetReleases names the released full
//    version (with build), file name and size, for Windows and for Mac (Intel and ARM).
//  - ODC Studio: the ODC Studio release notes on success.outsystems.com name X.Y.Z and "Released on" (day D); the build is
//    decided once, when it is definitive (ODC_RULE below), and the decision is persisted: it is never decided again.
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
// The hosts discovery reads, exactly. Every discovery redirect is checked against the same list (and never followed).
export const TRUSTED_HOSTS=Object.freeze(['api.outsystems.com','dxejw4oyledi.cloudfront.net','www.outsystems.com','success.outsystems.com']);
// The hosts an installer download may touch, exactly: the releaseshub content link and the CloudFront file it redirects
// to, each at the one path of that release's file. www/success.outsystems.com also host user uploads: never downloads.
export const DOWNLOAD_HOSTS=Object.freeze(['api.outsystems.com','dxejw4oyledi.cloudfront.net']);
// OutSystems' reactive runtime anonymous-session token, used only when the published runtime script no longer carries it.
const ANON_CSRF='T6C+9iB49TLra4jEsMeSckDMNhQ=';
// The last ODC Studio GA known when this was written: the floor of the build search until the vigia decides a newer one.
// A build installed on the vigia machine never raises the floor (it may be a preview above the GA).
export const ODC_KNOWN=Object.freeze({version:'1.7.32',build:11065});
// The first search of a version covers this many builds above the floor; later rounds search above the last find only.
export const ODC_BUILD_WINDOW=600;
export const ODC_FOLLOW_WINDOW=100;
// The ODC build rule, against the "Released on" day D (read as a UTC day; the notes give no zone, and the bounds below
// leave more than half a day either side of it):
//  - eligible: uploaded (CloudFront Last-Modified) on or after D-1 00:00Z and no later than the cutoff, D+1 16:00Z;
//  - the decision is the highest eligible build, taken only once it is definitive: at the cutoff, or earlier when the newest
//    upload of the version (or D 00:00Z, whichever is later) is settleHours old;
//  - a build uploaded after the cutoff (or after the decision) is never offered: the owner is told.
// Observed (live, 2026-11-09, C:\t\r5\sources-fix\evidence-output.txt), hours after D 00:00Z: accepted GA builds at
// 9.1-16.7 h and one next-day build (1.7.28.10873) at 32.75 h; the earliest late hotfix (1.7.29.10953) at 48.5 h; the
// latest excluded release candidate (1.7.32.11059) 53 h BEFORE D. The cutoff at 40 h is about the midpoint of 32.75 and
// 48.5 (7.25 h margin to the accepted build, 8.5 h to the held one). Same-version uploads came up to 23.65 h apart
// (1.7.28: 10850 at 9.1 h, 10873 at 32.75 h): settleHours 6 would have locked 10850 that afternoon, so it is 28 h (the
// longest gap plus about 4 h). Every decision records its distances (studio-sources.json) so drift shows.
export const ODC_RULE=Object.freeze({earliestDays:1,cutoffHours:40,settleHours:28});
const COMPONENT={odc:'ODCStudio',o11:'ServiceStudio'};
const EXT={windows:'.exe',macosx:'.dmg',macosx_arm64:'_arm64.dmg'};
const MAX_TEXT=8*1024**2,MAX_JSON=4*1024**2;
const H=3600000,DAY=24*H;
// An environmental source problem: the round keeps the installed Studio for that lane, says so and retries next round.
// STUDIO_SOURCE_UNREACHABLE (network, timeouts, 5xx after retries, the search deadline), STUDIO_SOURCE_BLOCKED (HTTP 403:
// a firewall or access rule), STUDIO_SOURCE_RATE_LIMITED (HTTP 429 after retries), STUDIO_SOURCE_CHANGED (a page or
// service changed shape), STUDIO_SOURCE_UNTRUSTED (a redirect to an unlisted host), STUDIO_BUILD_NOT_FOUND (an announced
// version with no eligible build once definitive), STUDIO_SOURCE_STATE (the persisted decisions cannot be read or written).
export class SourceError extends Error{constructor(message,code){super(message);this.code=code;this.environmental=true;}}
const changed=what=>new SourceError(`Studio release source changed shape: ${what}.`,'STUDIO_SOURCE_CHANGED');
// Server text goes into logs and the owner's notice: only [\w .:-] (and / in a URL) survives, bounded.
export const cleanText=(value,n=80)=>String(value??'').replace(/[^\w .:-]/g,'').slice(0,n);
const cleanUrl=(value,n=120)=>String(value??'').replace(/[^\w .:/-]/g,'').slice(0,n);
export function officialUrl(value) {
 const u=new URL(value);
 if(u.protocol!=='https:' || u.username || u.password || u.port || !TRUSTED_HOSTS.includes(u.hostname))throw Error('Untrusted Studio release URL.');
 return u.href;
}
const trusted=value=>{try{return officialUrl(value);}catch{throw new SourceError(`Studio release source pointed outside the allowlist (${cleanUrl(value)}).`,'STUDIO_SOURCE_UNTRUSTED');}};
export const compareVersions=(a,b)=>{const x=String(a).split('.').map(Number),y=String(b).split('.').map(Number);for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]??0)-(y[i]??0);if(d)return Math.sign(d);}return 0;};
const threeOf=v=>String(v).split('.').slice(0,3).join('.');
const iso=ms=>new Date(ms).toISOString();
const hoursAfter=(ms,from)=>Math.round((ms-from)/H*100)/100;
// The releaseshub download link of one full version and platform (it 301s to the CloudFront file).
export const contentLink=(lane,fullVersion,platform='windows')=>{
 if(!COMPONENT[lane]||!PLATFORMS.includes(platform)||!/^\d+\.\d+\.\d+\.\d+$/.test(fullVersion))throw Error('Invalid Studio download link request.');
 return `${RELEASES_HUB}${COMPONENT[lane]}/version/${fullVersion}/platform/${platform}/content`;
};
export const fileName=(lane,fullVersion,platform)=>`${COMPONENT[lane]}-${fullVersion}${EXT[platform]}`;
const cloudFrontPath=(lane,fullVersion,platform)=>`/repository/${COMPONENT[lane].toLowerCase()}/${fullVersion}/${fileName(lane,fullVersion,platform)}`;
// A release record for a full version that a discovery page named. Mac links are carried for later phases; the Windows
// flow uses url (= platforms.windows.url) only.
export function releaseFor(lane,fullVersion,{source=null,platforms={},releasedOn}={}) {
 if(!/^\d+\.\d+\.\d+\.\d+$/.test(fullVersion))throw changed('invalid version '+cleanText(fullVersion,40));
 const all=Object.fromEntries(PLATFORMS.map(p=>{const v=platforms[p]?.fullVersion??fullVersion;return [p,{fullVersion:v,url:contentLink(lane,v,p),file:fileName(lane,v,p),...(platforms[p]?.size?{size:platforms[p].size}:{})}];}));
 return {lane,version:threeOf(fullVersion),fullVersion,url:all.windows.url,...(all.windows.size?{size:all.windows.size}:{}),platforms:all,source,...(releasedOn?{releasedOn}:{}),requiresInstallation:true,tfm:null};
}
const pause=ms=>ms>0?new Promise(r=>setTimeout(r,ms)):null;
// Probe and HEAD answers are read for their status and headers only: their bodies are released at once.
const drop=r=>{try{r.body?.cancel?.().catch?.(()=>{});}catch{}};
const left=o=>o.deadline-Date.now();
const deadline=o=>new SourceError(`Studio release source unreachable: the search deadline (${Math.round(o.deadlineMs/1000)} s) was reached.`,'STUDIO_SOURCE_UNREACHABLE');
// A status that is not the expected one: 403 is a block, 429 a rate limit, anything else a changed page.
function refused(r,what){
 drop(r);
 if(r.status===403)return new SourceError(`Studio release source blocked: HTTP 403 from ${what} (a firewall or access rule refused the read).`,'STUDIO_SOURCE_BLOCKED');
 if(r.status===429)return new SourceError(`Studio release source rate-limited: HTTP 429 from ${what}.`,'STUDIO_SOURCE_RATE_LIMITED');
 return changed(`HTTP ${r.status} from ${what}`);
}
// One request with a timeout and bounded retries (network errors, timeouts, 429 and 5xx), all inside the lane's search
// deadline; redirects are never followed.
async function call(o,url,init={}){
 let last,status;
 for(let n=0;n<o.tries;n++){
  if(n)await pause(Math.min(o.retryDelayMs*n,left(o)));
  const ms=left(o);if(ms<=0)throw deadline(o);
  try{
   const r=await o.fetcher(trusted(url),{redirect:'manual',...init,signal:AbortSignal.timeout(Math.min(o.timeoutMs,ms))});
   if(r.status===429||r.status>=500){drop(r);status=r.status;last=`HTTP ${r.status}`;continue;}
   return r;
  }catch(e){if(e instanceof SourceError)throw e;status=null;last=cleanText(e.message);}
 }
 if(left(o)<=0)throw deadline(o);
 const host=new URL(url).hostname;
 if(status===429)throw new SourceError(`Studio release source rate-limited: ${host} answered HTTP 429 ${o.tries} times.`,'STUDIO_SOURCE_RATE_LIMITED');
 throw new SourceError(`Studio release source unreachable: ${host} (${last}).`,'STUDIO_SOURCE_UNREACHABLE');
}
// A body read with a byte cap: a declared length above it is refused before reading, and the stream is cut at the cap.
async function capped(r,max,what){
 const declared=Number(r.headers.get('content-length'));
 if(declared>max){drop(r);throw changed('oversized answer from '+what);}
 if(!r.body)return '';
 const parts=[];let total=0;
 for await(const chunk of r.body){total+=chunk.byteLength;if(total>max)throw changed('oversized answer from '+what);parts.push(Buffer.from(chunk));}
 return Buffer.concat(parts).toString('utf8');
}
async function text(o,url,init){
 const r=await call(o,url,init),what=new URL(url).pathname.split('/').pop();
 if(r.status!==200)throw refused(r,what);
 return capped(r,o.maxText,what);
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
// site once; a second refusal is a changed page. The answer is capped (MAX_JSON) while it streams.
async function screenService(o,site,action,body){
 const what=action.split('/').pop();
 for(let n=0;;n++){
  const r=await call(o,site.base+action,{method:'POST',headers:{'X-CSRFToken':site.ctx.csrf,'Content-Type':'application/json; charset=UTF-8',accept:'application/json'},
   body:JSON.stringify({versionInfo:{moduleVersion:'',apiVersion:site.ctx.tokens[action]},...body})});
  if(r.status!==200)throw refused(r,what);
  const raw=await capped(r,o.maxJson,what);
  let j;try{j=JSON.parse(raw);}catch{throw changed(`${what} did not answer JSON`);}
  if(j.exception)throw changed(`${what} refused (${cleanText(j.exception.message)})`);
  if(j.versionInfo?.hasApiVersionChanged){if(n)throw changed(`${what} apiVersion still rejected after re-reading the site`);site.ctx=await readSite(o,site.base,site.screens);continue;}
  if(!j.data||typeof j.data!=='object')throw changed(`${what} without data`);
  return j.data;
 }
}
async function site(o,base,screens){return {base,screens,ctx:await readSite(o,base,screens)};}
// What exists on releaseshub for one full version: the CloudFront location of its Windows file, or null on 404.
async function exists(o,lane,fullVersion,platform='windows'){
 const r=await call(o,contentLink(lane,fullVersion,platform));
 if(r.status===404){drop(r);return null;}
 if(r.status!==301&&r.status!==302)throw refused(r,'releaseshub for '+fullVersion);
 drop(r);
 const loc=trusted(new URL(r.headers.get('location')??'',contentLink(lane,fullVersion,platform)).href);
 if(new URL(loc).pathname!==cloudFrontPath(lane,fullVersion,platform))throw changed(`releaseshub redirected ${fullVersion} to ${cleanUrl(new URL(loc).pathname)}`);
 return loc;
}
async function head(o,url){
 const r=await call(o,url,{method:'HEAD'});
 if(r.status!==200)throw refused(r,new URL(url).pathname.split('/').pop());
 drop(r);
 const modified=Date.parse(r.headers.get('last-modified')??''),size=Number(r.headers.get('content-length'));
 return {modified:Number.isFinite(modified)?modified:null,size:size>0?size:null};
}
const RELEASES='screenservices/Downloads/MainFlow/HomeScreen/DataActionGetReleases';
// state.o11.verified: the full version and size last checked on releaseshub; the same answer again needs no probe.
export async function latestO11(o,{state={}}={}){
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
 const full=platforms.windows.fullVersion,lane=state.o11??={};
 // The announced build must be downloadable where the vigia downloads it, with the announced size (checked once per answer).
 if(lane.verified?.fullVersion!==full||lane.verified?.size!==(platforms.windows.size??null)){
  const loc=await exists(o,'o11',full);if(!loc)throw new SourceError(`Service Studio ${full} is on the Downloads page but not on releaseshub yet.`,'STUDIO_BUILD_NOT_FOUND');
  const h=await head(o,loc);if(platforms.windows.size&&h.size&&h.size!==platforms.windows.size)throw changed(`Service Studio ${full} size ${h.size} differs from the Downloads page (${platforms.windows.size})`);
  lane.verified={fullVersion:full,size:platforms.windows.size??null,at:iso(o.now)};
 }
 return releaseFor('o11',full,{source:DOWNLOADS,platforms});
}
const GUID='screenservices/Documentation_UI/Documentation/Support/DataActionGetContentGUID';
const CONTENT='screenservices/Documentation_UI/Documentation/ContentDoc/DataActionGetDocContent';
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
// Every "ODC Studio X.Y.Z" heading of the release notes with its "Released on Mon DD, YYYY" (UTC day) and a hash of its
// section (heading to the next heading): a change of either is "the notes changed" for that version.
export function parseOdcNotes(html){
 const out=[],all=String(html);
 const heads=[...all.matchAll(/<h2[^>]*>\s*ODC Studio (\d+\.\d+\.\d+)\s*<\/h2>\s*(?:<div[^>]*>\s*<p>\s*Released on ([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4})\s*<\/p>)?/g)];
 for(const m of heads){
  const month=MONTHS.indexOf(String(m[2]).toLowerCase()),next=all.indexOf('<h2',m.index+m[0].length);
  const section=all.slice(m.index,next<0?undefined:next).replace(/\s+/g,' ').trim();
  out.push({version:m[1],releasedOn:month<0?null:new Date(Date.UTC(+m[4],month,+m[3])).toISOString().slice(0,10),hash:createHash('sha256').update(section).digest('hex').slice(0,16)});
 }
 return out;
}
// The pure ODC rule (ODC_RULE) over the uploads seen so far ({build: {modified, size}}), at the round's clock now.
export function judgeOdc({releasedOn,uploads,now,rule=ODC_RULE}){
 const day=Date.parse(releasedOn+'T00:00:00Z'),earliest=day-rule.earliestDays*DAY,cutoff=day+rule.cutoffHours*H;
 const all=Object.entries(uploads??{}).map(([b,u])=>({build:Number(b),modified:Date.parse(u.modified),size:u.size??null}));
 const eligible=all.filter(u=>u.modified>=earliest&&u.modified<=cutoff).sort((a,b)=>b.build-a.build);
 const held=all.filter(u=>u.modified>cutoff).map(u=>u.build).sort((a,b)=>a-b),early=all.filter(u=>u.modified<earliest).map(u=>u.build).sort((a,b)=>a-b);
 const best=eligible[0]??null;
 // Settling needs an eligible build: with none, only the cutoff ends the wait (then STUDIO_BUILD_NOT_FOUND).
 const settledAt=best?Math.max(day,...all.filter(u=>u.modified<=cutoff).map(u=>u.modified))+rule.settleHours*H:Infinity;
 const definitiveAt=Math.min(cutoff,settledAt);
 return {definitive:now>=definitiveAt,by:now>=cutoff?'cutoff':'settled',definitiveAt,day,earliest,cutoff,best,held,early};
}
// Builds lo..lo+width of one version, 16 at a time; on to the next window (at most o.maxWindows) only while nothing was
// found or the highest find sits in the last sixth of the window. A probe that keeps failing stops the whole search.
async function probe(o,version,lo,width){
 const found=[];let hi=lo-1;
 for(let w=0;w<o.maxWindows;w++){
  const from=hi+1;hi=from+width;const queue=Array.from({length:hi-from+1},(_,i)=>from+i);
  await Promise.all(Array.from({length:o.parallel},async()=>{try{while(queue.length){const b=queue.shift(),loc=await exists(o,'odc',`${version}.${b}`);if(loc)found.push({build:b,loc});}}catch(e){queue.length=0;throw e;}}));
  if(found.length&&Math.max(...found.map(f=>f.build))<=hi-Math.ceil(width/6))break;
 }
 return {found,lo,hi};
}
// state.odc.versions[X.Y.Z]: {releasedOn, notesHash, firstSeen, uploads, decided?, laterBuilds?}. A decided version whose
// notes did not change needs no probe at all; a version not yet definitive is probed above its last find only.
export async function latestOdc(o,{state={}}={}){
 const s=await site(o,DOCS,{'Documentation_UI.Documentation.Support':[GUID],'Documentation_UI.Documentation.ContentDoc':[CONTENT]});
 const titles=Object.fromEntries(Array.from({length:12},(_,i)=>['ContentTitle'+(i+1),['release_notes','outsystems_developer_cloud_releases','odc_studio'][i]??'']));
 const g=await screenService(o,s,GUID,{viewName:'Documentation.Support',screenData:{variables:titles}});
 if(!g.ContentFound||!/^[0-9a-f-]{36}$/i.test(g.GUID??''))throw changed('ODC Studio release notes not found');
 const doc=await screenService(o,s,CONTENT,{viewName:'Documentation.Support',screenData:{variables:{RepoSection:'Support',_repoSectionInDataFetchStatus:1,GUID:g.GUID,_gUIDInDataFetchStatus:1,LocaleId:'en-US',_localeIdInDataFetchStatus:1}}});
 const notes=parseOdcNotes(doc.Html);if(!notes.length)throw changed('ODC Studio release notes without a version heading');
 const noted=notes.reduce((a,b)=>compareVersions(b.version,a.version)>0?b:a);
 if(!noted.releasedOn)throw changed(`ODC Studio ${noted.version} without a release date`);
 const lane=state.odc??={versions:{}};lane.versions??={};
 let v=lane.versions[noted.version];
 const notesChanged=!!v&&(v.releasedOn!==noted.releasedOn||v.notesHash!==noted.hash);
 const answer=(rec,extra={})=>({...releaseFor('odc',`${noted.version}.${rec.build}`,{source:ODC_NOTES_PAGE,releasedOn:rec.releasedOn,platforms:{windows:{size:rec.size}}}),decided:{at:rec.at,by:rec.by},...(rec.held?.length?{heldBuilds:rec.held}:{}),...(v.laterBuilds?.length?{laterBuilds:v.laterBuilds}:{}),...extra});
 if(v?.decided&&!notesChanged)return answer(v.decided);
 if(!v){
  // Builds grow across versions: the floor is the highest build decided for an older version, or the last known GA.
  const older=Object.entries(lane.versions).filter(([k,x])=>x.decided&&compareVersions(k,noted.version)<0).map(([,x])=>x.decided.build);
  const floor=Math.max(compareVersions(noted.version,o.known.version)>=0?o.known.build:0,...older);
  if(!floor)throw changed(`ODC Studio ${noted.version} is older than the last known release ${o.known.version}`);
  v=lane.versions[noted.version]={releasedOn:noted.releasedOn,notesHash:noted.hash,firstSeen:iso(o.now),floor,uploads:{}};
 }
 if(notesChanged){
  (v.notesChanges??=[]).push({at:iso(o.now),releasedOn:noted.releasedOn,previous:v.releasedOn});v.notesChanges=v.notesChanges.slice(-10);
  v.releasedOn=noted.releasedOn;v.notesHash=noted.hash;
 }
 const seen=Object.keys(v.uploads).map(Number),top=seen.length?Math.max(...seen):null;
 const search=top===null?await probe(o,noted.version,v.floor,o.window):await probe(o,noted.version,top+1,o.followWindow);
 for(const f of search.found.sort((a,b)=>a.build-b.build)){
  const h=await head(o,f.loc);
  if(!h.modified)throw changed(`no Last-Modified for ODC Studio ${noted.version}.${f.build}`);
  v.uploads[f.build]={modified:iso(h.modified),size:h.size};
 }
 v.lastSearch={at:iso(o.now),from:search.lo,to:search.hi};
 if(v.decided){
  // The notes of a decided version changed: what was uploaded above the decision is reported, never adopted.
  const later=Object.keys(v.uploads).map(Number).filter(b=>b>v.decided.build).sort((a,b)=>a-b);
  if(later.length)v.laterBuilds=later;
  return answer(v.decided);
 }
 const j=judgeOdc({releasedOn:v.releasedOn,uploads:v.uploads,now:o.now,rule:o.rule});
 if(!j.definitive)return {lane:'odc',version:noted.version,fullVersion:null,source:ODC_NOTES_PAGE,releasedOn:v.releasedOn,pending:{build:j.best?.build??null,definitiveAt:iso(j.definitiveAt),seen:Object.keys(v.uploads).map(Number)}};
 if(!j.best)throw new SourceError(`ODC Studio ${noted.version} (released ${v.releasedOn}) has no build on releaseshub uploaded between ${iso(j.earliest).slice(0,16)}Z and ${iso(j.cutoff).slice(0,16)}Z${j.early.length?` (earlier: ${j.early.join(', ')})`:''}${j.held.length?` (later: ${j.held.join(', ')})`:''}; searched ${v.floor}..${search.hi}.`,'STUDIO_BUILD_NOT_FOUND');
 const distances=Object.fromEntries(Object.entries(v.uploads).map(([b,u])=>[b,hoursAfter(Date.parse(u.modified),j.day)]));
 v.decided={build:j.best.build,size:j.best.size,releasedOn:v.releasedOn,at:iso(o.now),by:j.by,cutoff:iso(j.cutoff),
  hoursAfterRelease:hoursAfter(j.best.modified,j.day),marginToCutoffHours:hoursAfter(j.cutoff,j.best.modified),distances,held:j.held,early:j.early};
 return answer(v.decided);
}
const options=({fetcher=fetch,tries=3,retryDelayMs=1000,timeoutMs=30000,parallel=16,window=ODC_BUILD_WINDOW,followWindow=ODC_FOLLOW_WINDOW,maxWindows=3,deadlineMs=15*60000,now=Date.now(),rule=ODC_RULE,known=ODC_KNOWN,maxText=MAX_TEXT,maxJson=MAX_JSON}={})=>({fetcher,tries,retryDelayMs,timeoutMs,parallel,window,followWindow,maxWindows,deadlineMs,deadline:Date.now()+deadlineMs,now,rule,known,maxText,maxJson});
// One lane. installed is accepted for the callers' symmetry and never used: neither the floor nor the answer depends on the
// Studio installed on the vigia machine. opts.state is the persisted decisions object (changed in place).
export async function latestStudio(lane,installed,opts={}){
 const o=options(opts),state=opts.state??{};
 return lane==='odc'?latestOdc(o,{state}):latestO11(o,{state});
}
const highest=(installed,lane)=>installed.filter(x=>x.lane===lane&&/^\d+\.\d+\.\d+\.\d+$/.test(x.fullVersion??'')).map(x=>x.fullVersion).sort(compareVersions).at(-1);
const stateError=e=>new SourceError(`Studio release decisions (studio-sources.json) cannot be used: ${cleanText(e.message,120)}`,'STUDIO_SOURCE_STATE');
// Per lane: the public release (with its download link) or why there is none this round. Never throws.
//  - public: the release was read (and, for ODC, decided). It is a candidate unless the window already serves it.
//  - pending: an ODC version is announced but its build is not definitive yet; nothing is offered.
//  - older-than-served: the source names a version older than the newest the window serves.
//  - unavailable: a code; the lane keeps the installed Studio for the round.
// Flags on public: installedAhead (the vigia machine has a newer Studio, maybe a preview: it changes nothing),
// heldBuilds / laterBuilds (uploads after the cutoff or the decision: never offered). The caller notifies on them.
// opts.served = {odc:[X.Y.Z...], o11:[...]} (the window); opts.store = {read(), write(state)} persists the decisions: a
// decision that cannot be written is not acted on (the lane is unavailable with STUDIO_SOURCE_STATE).
export async function detectSources(installed,opts={}) {
 const served=opts.served??{},per=[];let state;
 try{state=opts.store?(opts.store.read()??{}):(opts.state??{});}catch(e){
  const err=stateError(e);return {observed:installed.map(x=>({...x})),sources:['odc','o11'].map(lane=>({lane,status:'unavailable',code:err.code,error:err.message,fallback:'installed Studio',ms:0}))};
 }
 for(const lane of ['odc','o11']){
  const mine=highest(installed,lane),started=Date.now(),before=JSON.stringify(state[lane]??null);
  try{per.push({lane,mine,r:await latestStudio(lane,mine,{...opts,state}),ms:Date.now()-started,dirty:JSON.stringify(state[lane]??null)!==before});}
  catch(e){per.push({lane,mine,error:e,ms:Date.now()-started,dirty:JSON.stringify(state[lane]??null)!==before});}
 }
 if(opts.store&&per.some(p=>p.dirty)){
  try{opts.store.write(state);}catch(e){const err=stateError(e);for(const p of per)if(p.dirty){p.error=err;delete p.r;}}
 }
 const releases=[],sources=[],local=installed.map(x=>({...x}));
 for(const {lane,mine,r,error,ms} of per){
  if(error){sources.push({lane,status:'unavailable',code:error.code??'STUDIO_SOURCE_UNREACHABLE',error:String(error.message).slice(0,300),fallback:'installed Studio',ms});continue;}
  if(r.pending){sources.push({lane,status:'pending',version:r.version,releasedOn:r.releasedOn,build:r.pending.build,definitiveAt:r.pending.definitiveAt,source:r.source,ms});continue;}
  const top=[...new Set(served[lane]??[])].sort(compareVersions).at(-1);
  const flags={...(r.heldBuilds?{heldBuilds:r.heldBuilds}:{}),...(r.laterBuilds?{laterBuilds:r.laterBuilds}:{}),...(r.decided?{decided:r.decided}:{}),...(mine&&compareVersions(mine,r.fullVersion)>0?{installedAhead:mine}:{})};
  if(top&&compareVersions(r.version,top)<0){sources.push({lane,status:'older-than-served',version:r.fullVersion,served:top,source:r.source,ms,...flags});continue;}
  sources.push({lane,status:'public',version:r.fullVersion,source:r.source,ms,...flags});
  const same=local.find(x=>x.lane===lane&&x.fullVersion===r.fullVersion);
  if(same)Object.assign(same,{url:r.url,source:r.source,platforms:r.platforms,...(r.size?{size:r.size}:{})});else releases.push(r);
 }
 return {observed:[...local,...releases],sources};
}
// Every URL of a download, the first one and each redirect: https, DOWNLOAD_HOSTS only, no port, user, query or fragment,
// and exactly the path of this release's Windows file (the releaseshub content link or its CloudFront file).
export function downloadUrl(release,value){
 const u=new URL(value);
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!DOWNLOAD_HOSTS.includes(u.hostname))throw Error('Untrusted Studio download URL.');
 const want=u.hostname==='api.outsystems.com'?new URL(contentLink(release.lane,release.fullVersion,'windows')).pathname:cloudFrontPath(release.lane,release.fullVersion,'windows');
 if(u.pathname!==want)throw Error('Studio download URL is not the file of this release.');
 return u.href;
}
export async function downloadInstaller(release,directory,{fetcher=fetch,allowTestHttp=false}={}) {
 const name=`${release.lane}-${release.fullVersion}.exe`,target=path.join(directory,name);
 if(!/^\d+\.\d+\.\d+\.\d+$/.test(release.fullVersion)||!COMPONENT[release.lane])throw Error('Invalid installer version.');
 const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 if(fs.existsSync(target)){
  if(fs.readFileSync(target+'.sha256','utf8').trim()!==digest(target))throw Error('Stored installer checksum mismatch.');
  return {file:target,sha256:digest(target)};
 }
 let url=allowTestHttp?release.url:downloadUrl(release,release.url),response;
 for(let n=0;n<6;n++){
  response=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(120000)});
  if([301,302,303,307,308].includes(response.status)){url=new URL(response.headers.get('location'),url).href;if(!allowTestHttp)downloadUrl(release,url);continue;}
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
