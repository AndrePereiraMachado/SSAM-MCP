// Where the vigia learns the latest released Studios, and how it downloads them. Installers are downloaded, hashed and
// extracted as data only. No installer is ever executed.
//
// Discovery (C:\t\r5\FONTE-VERSOES.md, options A and B), both anonymous reads of public OutSystems pages:
//  - Service Studio (O11): the outsystems.com/downloads screen service DataActionGetReleases names the released full
//    version (with build), file name and size, for Windows and for Mac (Intel and ARM).
//  - ODC Studio: the ODC Studio release notes on success.outsystems.com name X.Y.Z and "Released on" (day D); the build is
//    decided once, at the version's cutoff (ODC_RULE below), and the decision is persisted: it is never decided again
//    unless the owner says so (vigia.ps1 -Pin / -Redecide).
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
//  - the decision is the highest eligible build, taken only at the cutoff (never earlier: a next-day GA can come up to it,
//    and a decision is permanent); until then the version is pending and nothing is offered;
//  - a build uploaded after the cutoff (or after the decision) is never offered: the owner is told. When the version was
//    not watched shortly before its cutoff (watchHours) and such a build sits above the best eligible one, nothing is
//    decided (STUDIO_BUILD_AMBIGUOUS: it may be a re-upload of the GA) and the owner pins the build (vigia.ps1 -Pin);
//  - past the cutoff without a decision, the version is probed again at most every retryHours, or when its notes change.
// Assumption: within a version the GA has the highest build number (true for every version 1.7.27..1.7.32). A release
// candidate uploaded on D-1 with a number above the GA would be chosen.
// Observed (live, 2026-11-09, C:\t\r5\sources-fix\evidence-output.txt), hours after D 00:00Z: accepted GA builds at
// 9.1-16.7 h and one next-day build (1.7.28.10873) at 32.75 h; the earliest late hotfix (1.7.29.10953) at 48.5 h; the
// latest excluded release candidate (1.7.32.11059) 53 h BEFORE D. The cutoff at 40 h is about the midpoint of 32.75 and
// 48.5 (7.25 h margin to the accepted build, 8.5 h to the held one). Every decision records its distances
// (studio-sources.json) so drift shows.
export const ODC_RULE=Object.freeze({earliestDays:1,cutoffHours:40,watchHours:6,retryHours:24,holdHours:48,pinFarHours:72});
const COMPONENT={odc:'ODCStudio',o11:'ServiceStudio'};
const EXT={windows:'.exe',macosx:'.dmg',macosx_arm64:'_arm64.dmg'};
const MAX_TEXT=8*1024**2,MAX_JSON=4*1024**2;
const H=3600000,DAY=24*H;
// A source problem: the round keeps the installed Studio for that lane and says so. Most heal (the next round reads
// again); those with an action (e.action, owner commands inside {{ }}) wait for the owner.
// STUDIO_SOURCE_UNREACHABLE (network, timeouts, 5xx after retries, the search deadline), STUDIO_SOURCE_BLOCKED (HTTP 403:
// a firewall or access rule), STUDIO_SOURCE_RATE_LIMITED (HTTP 429 after retries), STUDIO_SOURCE_CHANGED (a page or
// service changed shape), STUDIO_SOURCE_UNTRUSTED (a redirect to an unlisted host), STUDIO_BUILD_NOT_FOUND (an announced
// version with no eligible build at its cutoff), STUDIO_BUILD_AMBIGUOUS (first searched after its cutoff, with a later
// upload above the eligible build), STUDIO_SOURCE_STATE (the persisted decisions cannot be read or written).
export class SourceError extends Error{constructor(message,code){super(message);this.code=code;this.environmental=true;}}
const changed=what=>new SourceError(`Studio release source changed shape: ${what}.`,'STUDIO_SOURCE_CHANGED');
// Server text goes into logs and the owner's notice: only [\w .:-] survives, bounded; of a URL, only its host.
export const cleanText=(value,n=80)=>String(value??'').replace(/[^\w .:-]/g,'').slice(0,n);
const hostOf=value=>{try{return cleanText(new URL(value).hostname);}catch{return 'an invalid URL';}};
export function officialUrl(value) {
 const u=new URL(value);
 if(u.protocol!=='https:' || u.username || u.password || u.port || !TRUSTED_HOSTS.includes(u.hostname))throw Error('Untrusted Studio release URL.');
 return u.href;
}
const trusted=value=>{try{return officialUrl(value);}catch{throw new SourceError(`Studio release source pointed outside the allowlist (host ${hostOf(value)}).`,'STUDIO_SOURCE_UNTRUSTED');}};
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
 // The file's Last-Modified decides the build: it is read from the CloudFront repository only, at the release's own path.
 if(new URL(loc).hostname!=='dxejw4oyledi.cloudfront.net')throw new SourceError(`releaseshub redirected ${fullVersion} to host ${hostOf(loc)}, not the CloudFront repository.`,'STUDIO_SOURCE_UNTRUSTED');
 if(new URL(loc).pathname!==cloudFrontPath(lane,fullVersion,platform))throw changed(`releaseshub redirected ${fullVersion} to another path`);
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
// The pure ODC rule (ODC_RULE) over the uploads seen so far ({build: {modified, size}}), at the round's clock now. A
// version is definitive only at its cutoff: there is no earlier "settled" decision (a next-day GA can come at any time up
// to the cutoff, and an early decision is permanent).
export function judgeOdc({releasedOn,uploads,now,rule=ODC_RULE}){
 const day=Date.parse(releasedOn+'T00:00:00Z'),earliest=day-rule.earliestDays*DAY,cutoff=day+rule.cutoffHours*H;
 const all=Object.entries(uploads??{}).map(([b,u])=>({build:Number(b),modified:Date.parse(u.modified),size:u.size??null}));
 const eligible=all.filter(u=>u.modified>=earliest&&u.modified<=cutoff).sort((a,b)=>b.build-a.build);
 const held=all.filter(u=>u.modified>cutoff).map(u=>u.build).sort((a,b)=>a-b),early=all.filter(u=>u.modified<earliest).map(u=>u.build).sort((a,b)=>a-b);
 return {definitive:now>=cutoff,by:'cutoff',definitiveAt:cutoff,day,earliest,cutoff,best:eligible[0]??null,held,early};
}
// Builds lo..lo+width of one version, 16 at a time. extend: on to the next window (at most o.maxWindows) while nothing was
// found or the highest find sits in the last sixth of the window; otherwise only while a find sits at the top. A probe
// that keeps failing stops the whole search.
async function probe(o,version,lo,width,{extend=false}={}){
 const found=[];let hi=lo-1;
 for(let w=0;w<o.maxWindows;w++){
  const from=hi+1;hi=from+width;const queue=Array.from({length:hi-from+1},(_,i)=>from+i);
  await Promise.all(Array.from({length:o.parallel},async()=>{try{while(queue.length){const b=queue.shift(),loc=await exists(o,'odc',`${version}.${b}`);o.probes++;if(loc)found.push({build:b,loc});}}catch(e){queue.length=0;throw e;}}));
  const topFind=found.length?Math.max(...found.map(f=>f.build)):null;
  if(topFind===null?!extend:topFind<=hi-Math.ceil(width/6))break;
 }
 return {found,lo,hi};
}
async function readOdcNotes(o){
 const s=await site(o,DOCS,{'Documentation_UI.Documentation.Support':[GUID],'Documentation_UI.Documentation.ContentDoc':[CONTENT]});
 const titles=Object.fromEntries(Array.from({length:12},(_,i)=>['ContentTitle'+(i+1),['release_notes','outsystems_developer_cloud_releases','odc_studio'][i]??'']));
 const g=await screenService(o,s,GUID,{viewName:'Documentation.Support',screenData:{variables:titles}});
 if(!g.ContentFound||!/^[0-9a-f-]{36}$/i.test(g.GUID??''))throw changed('ODC Studio release notes not found');
 const doc=await screenService(o,s,CONTENT,{viewName:'Documentation.Support',screenData:{variables:{RepoSection:'Support',_repoSectionInDataFetchStatus:1,GUID:g.GUID,_gUIDInDataFetchStatus:1,LocaleId:'en-US',_localeIdInDataFetchStatus:1}}});
 const notes=parseOdcNotes(doc.Html);if(!notes.length)throw changed('ODC Studio release notes without a version heading');
 return notes;
}
// An owner command, inside {{ }}: the caller turns it into the full vigia.ps1 line of its configuration.
const pinAction=(version,extra='')=>`Choose the build with {{-Pin ${version}.<build>}}${extra}.`;
const answerFor=(version,v)=>({...releaseFor('odc',`${version}.${v.decided.build}`,{source:ODC_NOTES_PAGE,releasedOn:v.decided.releasedOn,platforms:{windows:{size:v.decided.size}}}),decided:{at:v.decided.at,by:v.decided.by},...(v.decided.held?.length?{heldBuilds:v.decided.held}:{}),...(v.laterBuilds?.length?{laterBuilds:v.laterBuilds}:{})});
const unresolvedError=(v,next)=>Object.assign(new SourceError(`${v.unresolved.message} Probed again ${next}.`,v.unresolved.code),{action:v.unresolved.action});
// One announced version, against its persisted record lane.versions[X.Y.Z]:
//  {releasedOn, notesHash, firstSeen, floor, uploads{build:{modified,size,seenAt}}, lastSearch, watchedAt, decided?,
//   laterBuilds?, unresolved?, notesChanges?}.
// Decided and the notes unchanged: no probe at all. Pending: probed above its last find (one window of followWindow), or,
// with nothing found yet, one window from the floor after the first full search. Past the cutoff without a decision
// (unresolved): probed at most once every rule.retryHours, or when its notes change.
async function decideOdc(o,lane,noted){
 if(!noted.releasedOn)throw changed(`ODC Studio ${noted.version} without a release date`);
 const version=noted.version;let v=lane.versions[version];
 const notesChanged=!!v&&(v.releasedOn!==noted.releasedOn||v.notesHash!==noted.hash);
 if(v?.decided&&!notesChanged)return answerFor(version,v);
 if(!v){
  // Builds grow across versions: the floor is the highest build decided for an older version, or the last known GA.
  const older=Object.entries(lane.versions).filter(([k,x])=>x.decided&&compareVersions(k,version)<0).map(([,x])=>x.decided.build);
  const floor=Math.max(compareVersions(version,o.known.version)>=0?o.known.build:0,...older);
  if(!floor)throw changed(`ODC Studio ${version} is older than the last known release ${o.known.version}`);
  v=lane.versions[version]={releasedOn:noted.releasedOn,notesHash:noted.hash,firstSeen:iso(o.now),floor,uploads:{}};
 }
 if(v.unresolved&&!notesChanged){
  const next=Date.parse(v.lastSearch?.at??0)+o.rule.retryHours*H;
  if(o.now<next)throw unresolvedError(v,`at ${iso(next).slice(0,16)}Z or when its notes change`);
 }
 const seen=Object.keys(v.uploads).map(Number),top=seen.length?Math.max(...seen):null;
 let search;
 try{
  search=top!==null?await probe(o,version,top+1,o.followWindow)
   :await probe(o,version,v.floor,o.window,{extend:!v.lastSearch});
  for(const f of search.found.sort((a,b)=>a.build-b.build)){
   const h=await head(o,f.loc);
   if(!h.modified)throw changed(`no Last-Modified for ODC Studio ${version}.${f.build}`);
   v.uploads[f.build]={modified:iso(h.modified),size:h.size,seenAt:iso(o.now)};
  }
 }catch(e){
  // A decided version keeps its build whatever the search for later uploads meets (a 503, a changed page): the notes stay
  // "changed", so the next round looks again, and the decision is offered as it is meanwhile.
  if(!(e instanceof SourceError)||!v.decided)throw e;
  return {...answerFor(version,v),laterSearchFailed:{code:e.code,at:iso(o.now)}};
 }
 // Only a search that completed moves the record: a failed one leaves the notes "changed", so the next round probes again.
 v.lastSearch={at:iso(o.now),from:search.lo,to:search.hi};
 if(notesChanged){
  (v.notesChanges??=[]).push({at:iso(o.now),releasedOn:noted.releasedOn,previous:v.releasedOn});v.notesChanges=v.notesChanges.slice(-10);
  v.releasedOn=noted.releasedOn;v.notesHash=noted.hash;
 }
 if(v.decided){
  // The notes of a decided version changed: what was uploaded above the decision is reported, never adopted.
  const later=Object.keys(v.uploads).map(Number).filter(b=>b>v.decided.build).sort((a,b)=>a-b);
  if(later.length)v.laterBuilds=later;
  return answerFor(version,v);
 }
 const j=judgeOdc({releasedOn:v.releasedOn,uploads:v.uploads,now:o.now,rule:o.rule});
 if(o.now<j.cutoff)v.watchedAt=iso(o.now);
 // Not definitive (a notes date that moved forward reopens an unresolved version): pending, nothing offered.
 if(!j.definitive){delete v.unresolved;return {lane:'odc',version,fullVersion:null,source:ODC_NOTES_PAGE,releasedOn:v.releasedOn,pending:{build:j.best?.build??null,definitiveAt:iso(j.definitiveAt),seen:Object.keys(v.uploads).map(Number)}};}
 const window=`${iso(j.earliest).slice(0,16)}Z..${iso(j.cutoff).slice(0,16)}Z`;
 const unresolved=(code,message,action)=>{v.unresolved={code,message,action,at:iso(o.now)};throw unresolvedError(v,`at ${iso(o.now+o.rule.retryHours*H).slice(0,16)}Z or when its notes change`);};
 // Builds uploaded after the cutoff above the best eligible one, and the watcher did not see this version shortly before
 // its cutoff: a later Last-Modified may be a re-upload of the GA (the only eligible one then being a release candidate).
 // Never decided alone: the owner chooses.
 const watched=v.watchedAt&&j.cutoff-Date.parse(v.watchedAt)<=o.rule.watchHours*H;
 const above=j.held.filter(b=>!j.best||b>j.best.build);
 if(above.length&&!watched)unresolved('STUDIO_BUILD_AMBIGUOUS',`ODC Studio ${version} (released ${v.releasedOn}) was first searched after its cutoff: eligible ${j.best?.build??'none'} (uploaded ${window}), but ${above.join(', ')} above it carry a later upload time, which may be a re-upload of the GA.`,pinAction(version,`; nothing is served for ${version} until then`));
 if(!j.best)unresolved('STUDIO_BUILD_NOT_FOUND',`ODC Studio ${version} (released ${v.releasedOn}) has no build on releaseshub uploaded ${window}${j.early.length?` (earlier: ${j.early.join(', ')})`:''}${j.held.length?` (later: ${j.held.join(', ')})`:''}; searched ${v.floor}..${search.hi}.`,pinAction(version,' if one of its builds is right'));
 delete v.unresolved;
 const distances=Object.fromEntries(Object.entries(v.uploads).map(([b,u])=>[b,hoursAfter(Date.parse(u.modified),j.day)]));
 v.decided={build:j.best.build,size:j.best.size,releasedOn:v.releasedOn,at:iso(o.now),by:'cutoff',cutoff:iso(j.cutoff),
  hoursAfterRelease:hoursAfter(j.best.modified,j.day),marginToCutoffHours:hoursAfter(j.cutoff,j.best.modified),distances,held:j.held,early:j.early};
 return answerFor(version,v);
}
// Every version of the notes the vigia must decide: the highest, and every one above the newest served, so a version still
// pending when the next one ships is decided and served too. At most o.maxVersions: the highest and the OLDEST above the
// newest served (served first, oldest first); those in between are listed in results.notRead and read once the older
// ones are served, so none is skipped for being beyond the limit.
// An older unserved version left without a decision holds the newer decided ones back (r.heldBehind), so it is never
// skipped unseen:
//  - a source failure for it (UNREACHABLE, BLOCKED, RATE_LIMITED, CHANGED, UNTRUSTED...) holds them with no time limit: it
//    says nothing about the version, and the queue moves by itself once the source reads again;
//  - an answer that needs the owner (HOLD_LIMITED: AMBIGUOUS, NOT_FOUND) holds them until o.rule.holdHours after the later
//    of the newer one's cutoff and the first round that saw that hold (lane.holds['N<E'].limitedSince, persisted), so a
//    watcher that was stopped, or a -Pin of the newer one, always gives the owner the whole hold. Past it, the newer one
//    is offered with r.skips and the older is recorded in lane.skipped.
// A skipped version (by a hold, or by the owner's -Skip) is no longer read, so the versions behind it are read in turn;
// -Pin or -Redecide of it undoes the skip. When the highest version of the notes is skipped and the highest one left is
// not above the newest served, the lane has nothing to read: that version is served already, and reading it would judge
// a served version (one without a record has no floor below ODC_KNOWN: "older than the last known release" every round),
// so the round reports only the skip.
// lane.served records the window this round judged against (for -Pin, -Skip); lane.noted the versions of the notes at the
// last read that changed them (-Skip refuses a version no round has read).
export const HOLD_LIMITED=Object.freeze(['STUDIO_BUILD_AMBIGUOUS','STUDIO_BUILD_NOT_FOUND']);
export async function latestOdcAll(o,{state={},served=[]}={}){
 const notes=await readOdcNotes(o);
 const lane=state.odc??={versions:{}};lane.versions??={};
 const window=[...new Set(served)].sort(compareVersions),newest=window.at(-1);
 if(window.length&&JSON.stringify(lane.served?.versions)!==JSON.stringify(window))lane.served={versions:window,at:iso(o.now)};
 const byVersion=new Map(notes.map(n=>[n.version,n]));
 const noted=[...byVersion.keys()].sort(compareVersions);
 if(JSON.stringify(lane.noted?.versions)!==JSON.stringify(noted))lane.noted={versions:noted,at:iso(o.now)};
 const skippedNow=[...byVersion.keys()].filter(v=>lane.skipped?.[v]&&!(newest&&compareVersions(v,newest)<=0)).sort(compareVersions);
 const ordered=[...byVersion.values()].filter(n=>!lane.skipped?.[n.version]).sort((a,b)=>compareVersions(b.version,a.version));
 const above=ordered.slice(1).filter(n=>newest&&compareVersions(n.version,newest)>0).reverse();
 const nothingToRead=!!newest&&!!lane.skipped?.[noted.at(-1)]&&ordered.length>0&&compareVersions(ordered[0].version,newest)<=0;
 const picked=ordered.length&&!nothingToRead?[ordered[0],...above.slice(0,o.maxVersions-1)]:[];
 const results=[];
 for(const noted of picked){
  try{results.push({version:noted.version,r:await decideOdc(o,lane,noted)});}
  catch(e){if(!(e instanceof SourceError))throw e;results.push({version:noted.version,error:e});}
 }
 const holds=lane.holds??{},seen=new Set(),holding=[];
 for(const x of [...results].sort((a,b)=>compareVersions(a.version,b.version))){
  if(served.includes(x.version)||(newest&&compareVersions(x.version,newest)<0))continue;
  if(x.error){holding.push({version:x.version,code:x.error.code??'STUDIO_SOURCE_UNREACHABLE'});continue;}
  if(x.r.pending||!holding.length)continue;
  const cutoff=Date.parse(x.r.releasedOn+'T00:00:00Z')+o.rule.cutoffHours*H;
  let until=-Infinity,open=false;
  for(const h of holding){
   const key=`${x.version}<${h.version}`,hold=holds[key]??={since:iso(o.now)};seen.add(key);
   if(!HOLD_LIMITED.includes(h.code)){open=true;continue;}
   hold.limitedSince??=iso(o.now);
   until=Math.max(until,Math.max(cutoff,Date.parse(hold.limitedSince))+o.rule.holdHours*H);
  }
  if(open||o.now<until){x.r={...x.r,heldBehind:{versions:holding.map(h=>h.version),codes:holding.map(h=>h.code),until:open?null:iso(until)}};continue;}
  x.r={...x.r,skips:holding.map(h=>({...h}))};
  for(const h of holding){(lane.skipped??={})[h.version]??={by:x.version,at:iso(o.now),code:h.code};seen.delete(`${x.version}<${h.version}`);}
  holding.length=0;
 }
 for(const key of Object.keys(holds))if(!seen.has(key))delete holds[key];
 if(Object.keys(holds).length)lane.holds=holds;else delete lane.holds;
 const notRead=above.slice(o.maxVersions-1).map(n=>n.version).sort(compareVersions);
 if(notRead.length)results.notRead=notRead;
 if(skippedNow.length)results.skipped=skippedNow.map(v=>({version:v,...lane.skipped[v]}));
 return results;
}
// The highest announced version only (the callers that read one ODC answer).
export async function latestOdc(o,{state={}}={}){
 const [first]=await latestOdcAll(o,{state});
 if(!first)throw changed('every ODC Studio version of the release notes is skipped');
 if(first.error)throw first.error;
 return first.r;
}
const options=({fetcher=fetch,tries=3,retryDelayMs=1000,timeoutMs=30000,parallel=16,window=ODC_BUILD_WINDOW,followWindow=ODC_FOLLOW_WINDOW,maxWindows=3,maxVersions=3,deadlineMs=15*60000,now=Date.now(),rule=ODC_RULE,known=ODC_KNOWN,maxText=MAX_TEXT,maxJson=MAX_JSON}={})=>({fetcher,tries,retryDelayMs,timeoutMs,parallel,window,followWindow,maxWindows,maxVersions,deadlineMs,deadline:Date.now()+deadlineMs,now,rule:{...ODC_RULE,...rule},known,maxText,maxJson,probes:0});
// One lane. installed is accepted for the callers' symmetry and never used: neither the floor nor the answer depends on the
// Studio installed on the vigia machine. opts.state is the persisted decisions object (changed in place).
export async function latestStudio(lane,installed,opts={}){
 const o=options(opts),state=opts.state??{};
 return lane==='odc'?latestOdc(o,{state}):latestO11(o,{state});
}
// The owner's choice of an ODC build (vigia.ps1 -Pin X.Y.Z.B), applied to the persisted record of an announced version:
// the build must exist on releaseshub (one read-only GET, one HEAD). It replaces any earlier decision of that version.
// opts.served (the window's ODC versions): a version older than the newest served is recorded but has no effect (noEffect:
// nothing serves an older version once a newer one is served). warnings: an upload far outside the version's window
// (more than rule.pinFarHours before D-1 00:00Z or after the cutoff), no Last-Modified, a build below the version's floor.
export async function pinOdc(state,fullVersion,opts={}){
 if(!/^\d+\.\d+\.\d+\.\d+$/.test(String(fullVersion)))throw Error('Pin takes a full ODC Studio version: X.Y.Z.B.');
 const o=options(opts),version=threeOf(fullVersion),build=Number(fullVersion.split('.')[3]);
 const v=state.odc?.versions?.[version];
 if(!v)throw Error(`ODC Studio ${version} has not been read from the release notes yet: nothing to pin (run a round first).`);
 const loc=await exists(o,'odc',fullVersion);if(!loc)throw Error(`ODC Studio ${fullVersion} does not exist on releaseshub.`);
 const h=await head(o,loc);
 const day=Date.parse(v.releasedOn+'T00:00:00Z'),previous=v.decided?.build??null;
 v.uploads[build]??={modified:h.modified?iso(h.modified):null,size:h.size,seenAt:iso(o.now)};
 v.decided={build,size:h.size,releasedOn:v.releasedOn,at:iso(o.now),by:'owner',...(previous&&previous!==build?{replaced:previous}:{}),
  ...(h.modified?{hoursAfterRelease:hoursAfter(h.modified,day)}:{})};
 delete v.unresolved;
 if(v.laterBuilds){v.laterBuilds=v.laterBuilds.filter(b=>b>build);if(!v.laterBuilds.length)delete v.laterBuilds;}
 const warnings=[],from=-o.rule.earliestDays*24,to=o.rule.cutoffHours,hours=v.decided.hoursAfterRelease;
 if(hours===undefined)warnings.push(`releaseshub gave no upload time for ${fullVersion}`);
 else if(hours<from-o.rule.pinFarHours||hours>to+o.rule.pinFarHours)warnings.push(`${fullVersion} was uploaded ${iso(h.modified).slice(0,16)}Z, ${hours} h from the ${v.releasedOn} release: far outside its window (${from} h..${to} h); check it is the build of ${version}`);
 if(v.floor&&build<v.floor)warnings.push(`build ${build} is below ${v.floor}, the highest build of an older version`);
 const lane=state.odc,servedList=opts.served??[],newest=[...servedList].sort(compareVersions).at(-1);
 const wasSkipped=lane.skipped?.[version]??null;
 const noEffect=newest&&compareVersions(version,newest)<0?{served:newest,...(wasSkipped?{skippedBy:wasSkipped.by}:{})}:null;
 if(!noEffect&&wasSkipped){
  // The pin undoes the skip: the version is read and offered again, before the newer ones.
  delete lane.skipped[version];if(!Object.keys(lane.skipped).length)delete lane.skipped;
  if(wasSkipped.by!=='owner'&&!servedList.includes(wasSkipped.by))warnings.push(`${version} had been skipped for ${wasSkipped.by}, which may already be proposed: approve ${version} before ${wasSkipped.by}, or approving ${wasSkipped.by} first skips ${version} for good`);
 }
 // Older versions still without a decision hold this one back; those that need the owner are skipped when the hold ends.
 if(!noEffect)for(const [k,x] of Object.entries(lane.versions).sort(([a],[b])=>compareVersions(a,b))){
  if(compareVersions(k,version)>=0||x.decided||!x.unresolved||lane.skipped?.[k]||(newest&&compareVersions(k,newest)<=0))continue;
  const since=lane.holds?.[`${version}<${k}`]?.limitedSince;
  const when=since?`at ${iso(Math.max(day+o.rule.cutoffHours*H,Date.parse(since))+o.rule.holdHours*H).slice(0,16)}Z`:`${o.rule.holdHours} h after the next round`;
  warnings.push(HOLD_LIMITED.includes(x.unresolved.code)
   ?`the older ${k} has no decided build (${x.unresolved.code}): ${version} waits behind it, and ${k} is skipped ${when} unless it is pinned (-Pin ${k}.<build>) or skipped now (-Skip ${k})`
   :`the older ${k} could not be read (${x.unresolved.code}): ${version} waits behind it until it is read, or until -Skip ${k}`);
 }
 return {version,build,previous,size:h.size,...(warnings.length?{warnings}:{}),...(noEffect?{noEffect}:{})};
}
// The owner's "decide this version again" (vigia.ps1 -Redecide X.Y.Z): its record is dropped, so the next round searches
// it as never seen (past its cutoff an ambiguous answer then waits for -Pin).
export function redecideOdc(state,version){
 if(!/^\d+\.\d+\.\d+$/.test(String(version)))throw Error('Redecide takes an ODC Studio version: X.Y.Z.');
 const v=state.odc?.versions?.[version],skip=state.odc?.skipped?.[version];
 if(!v&&!skip)throw Error(`ODC Studio ${version} has no record to decide again.`);
 delete state.odc.versions[version];
 if(skip){delete state.odc.skipped[version];if(!Object.keys(state.odc.skipped).length)delete state.odc.skipped;}
 return {version,previous:v?.decided?.build??null,...(skip?{unskipped:true}:{})};
}
// The owner's "go on without this version" (vigia.ps1 -Skip X.Y.Z): recorded in lane.skipped, so it is no longer read,
// holds nothing and is never offered; the queue moves to the next version at once. -Pin or -Redecide of it undoes it. A
// version not above the newest served is not recorded (noEffect): nothing would serve it anyway. A version no round has
// read (neither in lane.noted, the versions of the last notes read, nor with a record) is refused, so a typo is never
// recorded for good; force records it anyway (a version the notes do not announce yet) and the answer says unread:true.
export function skipOdc(state,version,{now=Date.now(),served=[],force=false}={}){
 if(!/^\d+\.\d+\.\d+$/.test(String(version)))throw Error('Skip takes an ODC Studio version: X.Y.Z.');
 const newest=[...served].sort(compareVersions).at(-1);
 if(newest&&compareVersions(version,newest)<=0)return {version,noEffect:{served:newest}};
 const lane=state.odc??={versions:{}};
 const previous=lane.skipped?.[version]??null,v=lane.versions?.[version];
 const read=!!v||!!lane.noted?.versions?.includes(version);
 if(!read&&!previous&&!force)throw Error(`ODC Studio ${version} is not in the release notes ${lane.noted?`the last read recorded (${lane.noted.versions.join(', ')}; ${lane.noted.at})`:'of any round yet (no round has recorded the versions of the notes)'}: check the version. Nothing is recorded. To skip a version the notes do not announce yet, add -Force.`);
 (lane.skipped??={})[version]={by:'owner',at:iso(now),code:'OWNER'};
 for(const key of Object.keys(lane.holds??{}))if(key.endsWith('<'+version))delete lane.holds[key];
 if(lane.holds&&!Object.keys(lane.holds).length)delete lane.holds;
 return {version,previous,decided:v?.decided?.build??null,known:!!v,...(read?{}:{unread:true})};
}
const highest=(installed,lane)=>installed.filter(x=>x.lane===lane&&/^\d+\.\d+\.\d+\.\d+$/.test(x.fullVersion??'')).map(x=>x.fullVersion).sort(compareVersions).at(-1);
const stateError=(lane,e)=>Object.assign(new SourceError(`${lane==='odc'?'ODC Studio decisions (studio-sources.json)':'Service Studio cache'} cannot be used: ${cleanText(e.message,120)}.`,'STUDIO_SOURCE_STATE'),
 {action:lane==='odc'?'This does not heal by itself: rename or delete studio-sources.json in the watcher outDir to let the watcher decide again from the public pages (a version past its cutoff may then wait for {{-Pin X.Y.Z.B}}).':undefined});
// Per lane (and, for ODC, per announced version): the public release (with its download link) or why there is none this
// round. Never throws.
//  - public: the release was read (and, for ODC, decided). Offered unless the window already serves it.
//  - pending: an ODC version is announced but not yet at its cutoff; nothing is offered.
//  - queued: a decided ODC version waits behind an older unserved one (pending or offered this round): versions are offered
//    oldest first, so none is skipped; nor behind an older one not read this round. Behind an older one without a
//    decision (heldBy, heldCodes): until heldUntil for AMBIGUOUS / NOT_FOUND (then it is public with skips, the older
//    versions passed over), with no limit (heldUntil null) while the source fails for the older one.
//  - not-read: ODC versions above the newest served beyond maxVersions (versions); they are not read this round.
//  - skipped: an ODC version passed over (by a hold that ended, or the owner's -Skip); no longer read.
//  - older-than-served: the source names a version older than the newest the window serves.
//  - unavailable: a code (and ownerAction when only the owner can end it); the lane keeps the installed Studio.
// Flags on public: installedAhead (the vigia machine has a newer Studio, maybe a preview: it changes nothing),
// heldBuilds / laterBuilds (uploads after the cutoff or the decision: never offered). The caller notifies on them.
// opts.served = {odc:[X.Y.Z...], o11:[...]} (the window). opts.store = {read(lane), write(lane, laneState)} persists each
// lane on its own: a lane whose state cannot be read or written is unavailable with STUDIO_SOURCE_STATE (a decision that
// was not written is not acted on); the other lane goes on. Without a store, opts.state is used in place.
export async function detectSources(installed,opts={}) {
 const served=opts.served??{},per=[];
 for(const lane of ['odc','o11']){
  const mine=highest(installed,lane),started=Date.now();
  let state;
  if(opts.store){try{state={[lane]:opts.store.read(lane)??undefined};if(state[lane]===undefined)delete state[lane];}catch(e){per.push({lane,mine,error:stateError(lane,e),ms:0});continue;}}
  else state=opts.state??{};
  const before=JSON.stringify(state[lane]??null),o=options({...opts});
  let results;
  try{results=lane==='odc'?await latestOdcAll(o,{state,served:served.odc??[]}):[{r:await latestO11(o,{state})}];}
  catch(e){results=[{error:e}];}
  if(opts.store&&JSON.stringify(state[lane]??null)!==before){
   try{opts.store.write(lane,state[lane]);}catch(e){const err=stateError(lane,e);results=results.map(x=>({version:x.version,error:err}));}
  }
  per.push({lane,mine,results,ms:Date.now()-started,probes:o.probes,notRead:results.notRead,skipped:results.skipped,max:o.maxVersions});
 }
 const releases=[],sources=[],local=installed.map(x=>({...x}));
 for(const {lane,mine,results,error,ms,probes,notRead,skipped,max} of per){
  const top=[...new Set(served[lane]??[])].sort(compareVersions).at(-1);
  const unavailable=(e,version)=>sources.push({lane,...(version?{version}:{}),status:'unavailable',code:e.code??'STUDIO_SOURCE_UNREACHABLE',error:String(e.message).slice(0,300),...(e.action?{ownerAction:e.action}:{}),fallback:'installed Studio',ms});
  if(error){unavailable(error);continue;}
  if(notRead)sources.push({lane,status:'not-read',versions:notRead,max,served:top});
  for(const k of skipped??[])sources.push({lane,status:'skipped',version:k.version,by:k.by,code:k.code,at:k.at});
  let blocker=null;
  for(const {version,r,error:e} of [...results].sort((a,b)=>compareVersions(a.version??'0',b.version??'0'))){
   if(e){unavailable(e,version);continue;}
   const extra={ms,...(lane==='odc'?{probes}:{})};
   if(r.pending){blocker??=r.version;sources.push({lane,status:'pending',version:r.version,releasedOn:r.releasedOn,build:r.pending.build,definitiveAt:r.pending.definitiveAt,source:r.source,...extra});continue;}
   const flags={...(r.heldBuilds?{heldBuilds:r.heldBuilds}:{}),...(r.laterBuilds?{laterBuilds:r.laterBuilds}:{}),...(r.decided?{decided:r.decided}:{}),...(r.skips?{skips:r.skips}:{}),...(r.laterSearchFailed?{laterSearchFailed:r.laterSearchFailed}:{}),...(mine&&compareVersions(mine,r.fullVersion)>0?{installedAhead:mine}:{})};
   if(top&&compareVersions(r.version,top)<0){sources.push({lane,status:'older-than-served',version:r.fullVersion,served:top,source:r.source,...extra,...flags});continue;}
   const isServed=(served[lane]??[]).includes(r.version);
   if(!isServed&&r.heldBehind){blocker??=r.heldBehind.versions[0];sources.push({lane,status:'queued',version:r.fullVersion,behind:r.heldBehind.versions[0],heldBy:r.heldBehind.versions,heldCodes:r.heldBehind.codes,heldUntil:r.heldBehind.until,source:r.source,...extra,...flags});continue;}
   // Never past an older version not read this round: it is read once the older ones are served or skipped.
   const unread=notRead?.find(v=>compareVersions(v,r.version)<0);
   if(!isServed&&(blocker||unread)){sources.push({lane,status:'queued',version:r.fullVersion,behind:blocker??unread,source:r.source,...extra,...flags});continue;}
   if(!isServed)blocker=r.version;
   sources.push({lane,status:'public',version:r.fullVersion,source:r.source,...extra,...flags});
   const same=local.find(x=>x.lane===lane&&x.fullVersion===r.fullVersion);
   if(same)Object.assign(same,{url:r.url,source:r.source,platforms:r.platforms,...(r.size?{size:r.size}:{})});else releases.push(r);
  }
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
