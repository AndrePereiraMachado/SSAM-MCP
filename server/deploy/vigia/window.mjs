// Pure planning of the Studio versions window: what is new, which pair one image carries, how the window rotates, what
// the owner reads. No process, Docker, Git or network here (runtime.mjs does that), so every rule is testable alone.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {versionPairs,generateCompose,servedLists,hostBudget,withUsage,versionBackends,isBackendManifest,backendsOf,retiringOf} from '../coolify/gen-compose.mjs';
export const LANES=['odc','o11'];
export const STUDIO_NAME={odc:'ODC Studio',o11:'Service Studio'};
export const version=value=>/^(\d+\.\d+\.\d+)/.exec(String(value??''))?.[1]??null;
export const compareVersion=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;};
// The major .NET of a target framework moniker: net8.0 -> 8, net10.0-windows -> 10, anything else -> null.
export const tfmMajor=value=>{const m=/^net(\d+)\.\d+/i.exec(String(value??''));return m?Number(m[1]):null;};
export function detectVersionFolders(folders){
 return Object.entries(folders).flatMap(([lane,studio])=>{try{const fullVersion=fs.readFileSync(path.join(studio,'Version.txt'),'utf8').trim().split(/\s/)[0];return version(fullVersion)?[{lane,studio,fullVersion,version:version(fullVersion)}]:[];}catch{return [];}});
}
// The versions a lane of the window serves, either window: a pair window's entries, or a backend window's (S2) backends
// (ODC) and o11.served (O11), the retiring one included (it is served until retireAt).
export function servedOf(manifest,lane){
 if(isBackendManifest(manifest))return lane==='odc'?manifest.backends.map(b=>b.odc):[...(manifest.o11?.served??[])];
 return [...new Set(manifest[lane].map(x=>x.version))];
}
export function planWindow(manifest,observed=[],state={}){
 backendsOf(manifest);
 const served=Object.fromEntries(LANES.map(l=>[l,servedOf(manifest,l)]));
 const candidates=observed.filter(o=>LANES.includes(o.lane)&&version(o.version)).map(o=>({...o,version:version(o.version)})).filter(o=>!served[o.lane].includes(o.version)&&served[o.lane].every(v=>compareVersion(o.version,v)>0));
 candidates.sort((a,b)=>LANES.indexOf(a.lane)-LANES.indexOf(b.lane)||compareVersion(b.version,a.version));
 const requested=[];
 for(const lane of LANES)for(const [v,data]of Object.entries(state.unserved?.[lane]??{}))if(version(v)&&served[lane].every(x=>compareVersion(version(v),x)>0))requested.push({lane,version:version(v),customers:data.tokens?.length??0});
 return {window:manifest.window??(isBackendManifest(manifest)?4:3),observed:observed.map(({lane,version,fullVersion,requiresInstallation,tfm,missing})=>({lane,version,fullVersion,tfm:tfm??null,requiresInstallation:!!requiresInstallation,...(missing?.length?{missing}:{})})),candidates,requested};
}
// The newest installed candidate of each lane. Both lanes new at once go into ONE image (one build, one approval).
export function readyCandidates(plan){
 const pick={};for(const c of plan.candidates)if(!c.requiresInstallation&&(!pick[c.lane]||compareVersion(c.version,pick[c.lane].version)>0))pick[c.lane]=c;
 return LANES.filter(l=>pick[l]).map(l=>pick[l]);
}
// The newest version a lane of the window serves, whatever its place in the manifest (a pair added by hand at the end, or
// the replay of an approval, may hold the newest; position 0 is only the default pair).
export const newestServed=(manifest,lane)=>[...servedOf(manifest,lane)].sort((a,b)=>compareVersion(b,a))[0];
// The pair one image carries: the new Studio of each lane, and for a lane with nothing new the NEWEST served version.
export function pairFor(base,ready){
 const pick=Object.fromEntries(ready.map(c=>[c.lane,c]));
 return {odc:pick.odc?.version??newestServed(base,'odc'),o11:pick.o11?.version??newestServed(base,'o11'),lanes:LANES.filter(l=>pick[l]),candidates:LANES.filter(l=>pick[l]).map(l=>pick[l])};
}
// The pair name of gen-compose.mjs (volumes and backends use it), so one id names the proposal, its branch and its folder.
export const pairId=p=>`o11-${p.o11}-odc-${p.odc}`;
export const pairTag=(p,commit,date)=>`prod-${date}-${commit}-o${p.o11.replaceAll('.','')}-odc${p.odc.replaceAll('.','')}`;
export const windowPairs=manifest=>versionPairs(manifest).map(p=>({odc:p.odc,o11:p.o11}));
export const hasPair=(manifest,pair)=>windowPairs(manifest).some(p=>p.odc===pair.odc&&p.o11===pair.o11);
export const isRealClient=data=>!data.revokedAt&&!data.revoked&&data.state!=='revoked'&&!data.verification&&data.customer!=='Version verification';
// The most pairs a rotation may keep (retained clients included): maxWindow, else at least the window the manifest already
// serves (a pair added by hand never makes every later round fail), and never below 4.
export const windowLimit=(config,manifest)=>config?.maxWindow??Math.max(4,manifest?.window??3);
// Newest first by ODC Studio, then Service Studio: the order in which pairs stay in the window.
const newerPair=(a,b)=>compareVersion(b.odc,a.odc)||compareVersion(b.o11,a.o11);
export function rotateWindow(manifest,pair,state={}){
 const old=versionPairs(manifest),window=manifest.window??3,lists=servedLists(manifest);
 pair={odc:newestServed(manifest,'odc'),o11:newestServed(manifest,'o11'),...pair};
 // Every pair the window keeps freezes the served list it runs with (its own, keepServed's, or the whole window it was
 // deployed with: servedLists), so it keeps serving a newer Service Studio "with the newer note" instead of refusing it as
 // served elsewhere (the router reaches the new pair only through its ODC version). The new pair serves the whole new
 // window. keepServed itself is not carried: once the order changes, only these per-pair lists keep its meaning.
 const {served:_drop,...fresh}=pair;
 let entries=[{...fresh},...old.map((p,i)=>({p,i})).filter(({p})=>p.odc!==pair.odc||p.o11!==pair.o11).map(({p,i})=>{
  const at=manifest.odc.find(x=>x.version===p.odc&&p.image.startsWith(x.image+':'+x.tag));const {served,...rest}=at;return {odc:p.odc,o11:p.o11,...rest,served:JSON.parse(lists[i])};
 })];
 const now=state.now??Date.now(),held=[];
 const recent=p=>Object.entries(state.tokens??{}).some(([token,data])=>{
  const active=isRealClient(data)&&now-Date.parse(data.seen)<14*86400000;
  const uses=LANES.some(l=>version(data[l]?.installed)===p[l]);
  if(active&&uses){held.push({pair:pairId(p),token,lastSeen:data.seen});return true;}return false;
 });
 // The new pair and the newest served pairs by version fill the window, whatever their place in the manifest (a pair added by
 // hand at the end is still the newest); an older pair stays only for a recent client. The order of the manifest is kept.
 const kept=new Set([entries[0],...entries.slice(1).sort(newerPair).slice(0,Math.max(0,window-1))]);
 entries=entries.filter(p=>kept.has(p)||recent(p));
 // Without a configured maxWindow (the replay of approvals), the same default as the round: never below the served window.
 const limit=state.maxWindow??windowLimit(null,manifest);
 if(!Number.isInteger(limit)||limit<3||entries.length>limit)throw Object.assign(Error(limit<window?`maxWindow (${limit}) is below the window the manifest already serves (${window}); raise maxWindow in the watcher configuration.`:'Active clients require a window above the configured limit; owner review is required.'),{code:'WINDOW_LIMIT',environmental:true});
 // The capacity sizing (gen-compose.mjs) rides along. The hot tier goes by real use (usage, refreshed from a live backend by
 // the automatic deploy: withUsage), so the counts of the pairs that stay are kept, a leaving pair's counts go to the new
 // window's default pair (where the router sends its clients) and the new pair starts with none of its own.
 // The owner's hotPair pin stays while its pair stays; a pin on a leaving pair is dropped (hotPinDropped, and the deploy
 // tells the owner when the hot pair changes).
 const sizing=manifest.sizing?structuredClone(manifest.sizing):null;
 const next={window:Math.max(window,entries.length),odc:[],o11:[],...(sizing?{sizing}:{})};
 for(const p of entries)for(const lane of LANES)next[lane].push({version:p[lane],tag:p.tag,image:p.image,...(p.sha256?{sha256:p.sha256}:{}),...(p.served?{served:structuredClone(p.served)}:{})});
 versionPairs(next);
 let hotPinDropped=null;
 if(sizing){
  const names=new Set(windowPairs(next).map(pairId));
  if(sizing.hotPair!=null&&!names.has(sizing.hotPair)){hotPinDropped=sizing.hotPair;delete sizing.hotPair;}
  if(sizing.usage)sizing.usage=withUsage(next,sizing.usage).sizing.usage;
  hostBudget(next);
 }
 const leaving={};for(const lane of LANES)leaving[lane]=[...new Set(manifest[lane].map(x=>x.version))].filter(v=>!next[lane].some(x=>x.version===v));
 const affected=[];for(const [token,data]of Object.entries(state.tokens??{}))for(const lane of LANES)if(leaving[lane].includes(version(data[lane]?.installed)))affected.push({token,customer:data.customer??null,lane,version:version(data[lane].installed),lastSeen:data.seen??null});
 return {manifest:next,leaving,affected,held,...(hotPinDropped?{hotPinDropped}:{})};
}
// Approved proposals that main does not carry yet are replayed on top of it, in approval order: the next proposal starts
// from the window the owner deployed, whether or not its branch was merged. A pair main already has is skipped.
export function replayApprovals(manifest,approvals=[]){
 let current=manifest;const replayed=[];
 for(const a of [...approvals].sort((x,y)=>String(x.approved?.at).localeCompare(String(y.approved?.at)))){
  const pair={odc:a.pair.odc,o11:a.pair.o11,image:a.built.image,tag:a.built.tag,sha256:String(a.approved.digest).replace(/^sha256:/,'')};
  if(hasPair(current,pair))continue;
  current=rotateWindow(current,pair).manifest;replayed.push(a.id);
 }
 return {manifest:current,replayed};
}
// The pin: the published digest of the proposal's tag, written into every entry of that tag.
export function pinDigest(manifest,tag,digest){
 if(!/^sha256:[a-f0-9]{64}$/.test(digest))throw Error('Invalid published digest.');
 const next=structuredClone(manifest);let found=0;
 for(const lane of LANES)for(const entry of next[lane])if(entry.tag===tag){entry.sha256=digest.slice(7);found++;}
 if(found!==2)throw Error('The proposed window does not carry the tag once per lane.');
 versionPairs(next);return next;
}
// ---- Window 4x4, phase S2: the per-lane window of a backend window (C:/t/r5/janela-4x4/DESENHO.md 2.2-2.3, owner decisions
// 7a-7d). A backend window ({window, o11: {served, kernels?}, backends: [...], retiring?, sizing?}, gen-compose.mjs) keeps,
// per lane, the newest keep[lane] versions plus at most ONE retiring version with its retireAt (now + graceDays):
//   - a new ODC Studio is ONE new backend (one image: that ODC with the window's O11 kernels); the oldest kept ODC backend
//     becomes retiring and keeps serving until retireAt;
//   - a new Service Studio rebuilds EVERY backend (each image carries every served O11 kernel, the retiring one included); the
//     oldest kept O11 version becomes retiring;
//   - at retireAt a compose-only round (no image) removes it: the ODC backend leaves; the O11 version leaves o11.served (its
//     kernel stays in the images, unserved, until the next O11 rebuild);
//   - a new version of a lane while that lane already has a retiring one retires the older one at once (never more than
//     keep + 1 versions per lane);
//   - an active customer never holds the window any more (the pair window's 14-day retention is gone): the customers on a
//     version that enters or leaves retirement are named to the owner (affected) and told on every answer (studioRetiring).
export const DEFAULT_KEEP=Object.freeze({odc:4,o11:4});
export const DEFAULT_GRACE_DAYS=7;
const DAY=86400000;
// config.window = {keep: {odc, o11}, graceDays, notifyAffected} (the old maxWindow belongs to the pair window).
export function windowPolicy(config){
 const w=config?.window??{};
 if(typeof w!=='object'||Array.isArray(w)||Object.keys(w).some(k=>!['keep','graceDays','notifyAffected'].includes(k)))throw Error('Invalid window configuration: {keep: {odc, o11}, graceDays, notifyAffected}.');
 const keep={...DEFAULT_KEEP,...(w.keep??{})};
 for(const lane of LANES)if(!Number.isInteger(keep[lane])||keep[lane]<1||keep[lane]>8)throw Error(`Invalid window.keep.${lane}: an integer from 1 to 8.`);
 if(Object.keys(keep).some(k=>!LANES.includes(k)))throw Error('Invalid window.keep: {odc, o11}.');
 const graceDays=w.graceDays??DEFAULT_GRACE_DAYS;
 if(typeof graceDays!=='number'||!Number.isFinite(graceDays)||graceDays<0||graceDays>60)throw Error('Invalid window.graceDays: 0 to 60.');
 return {keep,graceDays,notifyAffected:w.notifyAffected!==false};
}
export const isBackendWindow=manifest=>isBackendManifest(manifest);
// The backend of an ODC Studio version (gen-compose.mjs names it so: volumes, runtime folder, usage, hotPair).
export const backendId=odc=>`odc-${odc}`;
// A short hash of an O11 kernel set, for the image tag: the same set always gives the same 8 hex.
export const kernelSetHash=kernels=>createHash('sha256').update([...kernels].sort(compareVersion).join(',')).digest('hex').slice(0,8);
export const backendTag=({odc,kernels},commit,date)=>`prod-${date}-${commit}-odc${odc.replaceAll('.','')}-o11k${kernelSetHash(kernels)}`;
// The round of a lane (its new version) and the compose-only round of a retirement; the attempt folder has the same name.
export const laneRoundId=(lane,v)=>`${lane}-${v}`;
export const retireRoundId=(lane,v)=>`retire-${lane}-${v}`;
export const ROUND_ID=/^(?:o11-\d+\.\d+\.\d+-odc-\d+\.\d+\.\d+|(?:odc|o11)-\d+\.\d+\.\d+|retire-(?:odc|o11)-\d+\.\d+\.\d+)$/;
// The O11 kernels the images of a backend window carry (o11.kernels, default o11.served).
export const kernelsOf=manifest=>[...(manifest.o11?.kernels??manifest.o11?.served??[])].sort(compareVersion);
const kept=(manifest,lane)=>servedOf(manifest,lane).filter(v=>v!==manifest.retiring?.[lane]?.version).sort((a,b)=>compareVersion(b,a));
const isoAt=ms=>new Date(ms).toISOString();
// The customers whose Studio of a lane is one of versions (the studio-versions telemetry of the live backends: state.tokens),
// real clients only; token ids are kept for the private evidence, the owner's notice names the customer.
export function affectedBy(tokens,changes){
 const out=[];
 for(const [token,data]of Object.entries(tokens??{})){
  if(!isRealClient(data))continue;
  for(const c of changes)if(version(data[c.lane]?.installed)===c.version)out.push({token,customer:data.customer??null,lane:c.lane,version:c.version,lastSeen:data.seen??null,...(c.retireAt?{retireAt:c.retireAt}:{})});
 }
 return out;
}
// The sizing that rides along a backend rotation: the use of a leaving backend folds into the default (withUsage), an owner
// pin on a leaving backend is dropped (hotPinDropped), and keep + retiring must fit the host (hostBudget, CAPACITY_WINDOW).
function carrySizing(next){
 let hotPinDropped=null;
 if(next.sizing){
  const names=new Set(backendsOf(next).map(b=>b.name));
  if(next.sizing.hotPair!=null&&!names.has(next.sizing.hotPair)){hotPinDropped=next.sizing.hotPair;delete next.sizing.hotPair;}
  if(next.sizing.usage)next.sizing.usage=withUsage(next,next.sizing.usage).sizing.usage;
  hostBudget(next);
 }
 return hotPinDropped;
}
const finish=(next,keep)=>{
 next.backends.sort((a,b)=>compareVersion(b.odc,a.odc));
 if(next.retiring&&!Object.keys(next.retiring).length)delete next.retiring;
 next.window=Math.min(20,Math.max(keep.odc,next.backends.length));
 versionBackends(next);retiringOf(next,versionBackends(next));
 return next;
};
// A new version of one lane enters a backend window. images: {image, tag} of the new backend (ODC), or {"<odc>": {image,
// tag}} of EVERY backend of the next window (O11: each image is rebuilt with the new kernel set). -> {manifest, retiring:
// [the version that enters its grace], retired: [a retiring version that left at once], affected, hotPinDropped?}. The new
// images carry no digest yet (pinDigests after publication).
export function rotateLane(manifest,lane,v,{now=Date.now(),graceDays=DEFAULT_GRACE_DAYS,keep=DEFAULT_KEEP,images,tokens}={}){
 if(!isBackendManifest(manifest))throw Error('rotateLane needs a backend window.');
 if(!LANES.includes(lane)||!/^\d+\.\d+\.\d+$/.test(v??''))throw Error('rotateLane needs a lane and a three-part version.');
 versionBackends(manifest);
 const served=servedOf(manifest,lane);
 if(served.includes(v))throw Object.assign(Error(`${STUDIO_NAME[lane]} ${v} is already served.`),{code:'ALREADY_SERVED',environmental:true});
 if(served.some(x=>compareVersion(v,x)<0))throw Error(`${STUDIO_NAME[lane]} ${v} is older than a served version; a lane only moves forward.`);
 const next=structuredClone(manifest),retiring=[],retired=[];next.retiring={...(next.retiring??{})};
 if(lane==='odc'){
  if(!images?.image||!images?.tag)throw Error('A new ODC backend needs its image and tag.');
  // The new image is built with the served kernels; a kernel the older images still carry after an O11 retirement
  // (o11.kernels) is not in it.
  const kernels=kernelsOf(manifest),servedO11=[...manifest.o11.served].sort(compareVersion);
  next.backends.push({odc:v,image:images.image,tag:images.tag,...(kernels.join()!==servedO11.join()?{o11Kernels:servedO11}:{})});
 }else{
  next.o11={served:[...next.o11.served,v]};
 }
 // The lane's earlier retiring version leaves now: a second new version never keeps two of them.
 const before=manifest.retiring?.[lane];
 if(before){retired.push({lane,version:before.version,retireAt:before.retireAt,early:true});delete next.retiring[lane];}
 const active=kept({...next,retiring:{}},lane).filter(x=>x!==before?.version);
 const excess=active.slice(keep[lane]);
 if(excess.length){
  next.retiring[lane]={version:excess[0],retireAt:isoAt(now+graceDays*DAY)};retiring.push({lane,...next.retiring[lane]});
  // A keep the owner lowered by more than one: the older ones leave at once.
  for(const x of excess.slice(1))retired.push({lane,version:x,early:true});
 }
 const leave=new Set(retired.map(r=>r.version));
 if(lane==='odc')next.backends=next.backends.filter(b=>!leave.has(b.odc));
 else{
  next.o11.served=next.o11.served.filter(x=>!leave.has(x)).sort(compareVersion);
  // Every image is rebuilt with exactly the served kernels (the retiring one included); a missing image is a defect.
  for(const b of next.backends){
   const at=images?.[b.odc];if(!at?.image||!at?.tag)throw Error(`The O11 round needs the rebuilt image of backend ${backendId(b.odc)}.`);
   b.image=at.image;b.tag=at.tag;delete b.sha256;delete b.o11Kernels;
  }
 }
 finish(next,keep);
 const hotPinDropped=carrySizing(next);
 return {manifest:next,retiring,retired,affected:affectedBy(tokens,[...retiring,...retired]),...(hotPinDropped?{hotPinDropped}:{})};
}
// The retirement that is due (retireAt reached), ODC first, or null. One lane per round: the next round takes the other.
export function dueRetirement(manifest,now=Date.now()){
 if(!isBackendManifest(manifest))return null;
 const r=retiringOf(manifest,versionBackends(manifest));
 for(const lane of LANES)if(r?.[lane]&&Date.parse(r[lane].retireAt)<=now)return {lane,...r[lane]};
 return null;
}
// The compose-only round of a due retirement: the ODC backend leaves, or the O11 version leaves o11.served (o11.kernels keeps
// it: the images still carry its kernel until the next O11 rebuild). -> {manifest, retired, affected, hotPinDropped?} or null.
export function retireDue(manifest,{now=Date.now(),keep=DEFAULT_KEEP,tokens}={}){
 const due=dueRetirement(manifest,now);
 if(!due)return null;
 const next=structuredClone(manifest);delete next.retiring[due.lane];
 if(due.lane==='odc')next.backends=next.backends.filter(b=>b.odc!==due.version);
 else next.o11={served:next.o11.served.filter(v=>v!==due.version),kernels:kernelsOf(manifest)};
 finish(next,keep);
 const hotPinDropped=carrySizing(next);
 const retired=[{lane:due.lane,version:due.version,retireAt:due.retireAt}];
 return {manifest:next,retired,affected:affectedBy(tokens,retired),...(hotPinDropped?{hotPinDropped}:{})};
}
// A rehearsal (-RehearseCurrent) rebuilds what a lane's round would build for a version the window already serves: the
// newest ODC backend, or every backend (O11). Nothing rotates.
export function rebuildLane(manifest,lane,images){
 const next=structuredClone(manifest);
 for(const b of next.backends){const at=lane==='odc'?(b.odc===images.odc?images:null):images[b.odc];if(at){b.image=at.image;b.tag=at.tag;delete b.sha256;}}
 versionBackends(next);return next;
}
// The published digest of every image a round built ({tag: 'sha256:<64 hex>'}), written into the backends of that tag. Every
// backend ends pinned: a deploy never carries an image without its digest.
export function pinDigests(manifest,digests){
 const next=structuredClone(manifest),found=new Set();
 for(const [tag,digest]of Object.entries(digests))if(!/^sha256:[a-f0-9]{64}$/.test(digest))throw Error('Invalid published digest.');
 for(const b of next.backends)if(digests[b.tag]){b.sha256=digests[b.tag].slice(7);found.add(b.tag);}
 if(found.size!==Object.keys(digests).length)throw Error('The proposed window does not carry every built tag.');
 if(next.backends.some(b=>!/^[a-f0-9]{64}$/.test(String(b.sha256??'').replace(/^sha256:/,''))))throw Error('A backend of the proposed window has no pinned digest.');
 versionBackends(next);return next;
}
// The default O11 kernel of a backend window (kernel.json o11, the kernel of the server's own processes; o11-kernels.mjs): it is
// always served, so it must never be the retiring version, and an O11 round moves it to the newest version the LIVE window
// served, which both the live images and the rebuilt ones carry (a rollback restarts the old images with the new kernel.json).
// An ODC round keeps the live default.
export function defaultO11(base,{lane,liveDefault=null}={}){
 const keptO11=kept(base,'o11');
 if(lane==='o11')return keptO11[0];
 return liveDefault&&keptO11.includes(liveDefault)?liveDefault:keptO11[0];
}
// The first S1 deploy (S1-KIT-PLANO.md) as a rotation: the pair window becomes a backend window; the ODC (and O11) versions
// beyond keep enter "retiring" with graceDays instead of leaving at the switch (ODC 1.7.28 on 2026-11-09). images: {"<odc>":
// {image, tag, sha256?}} for every ODC backend kept or retiring. -> {manifest, retiring, retired, affected}.
export function fromPairs(pairs,{now=Date.now(),graceDays=DEFAULT_GRACE_DAYS,keep=DEFAULT_KEEP,images,tokens}={}){
 versionPairs(pairs);
 const next={window:keep.odc,o11:{served:[]},backends:[],retiring:{},...(pairs.sizing?{sizing:structuredClone(pairs.sizing)}:{})};
 const retiring=[],retired=[];
 for(const lane of LANES){
  const all=[...new Set(pairs[lane].map(x=>x.version))].sort((a,b)=>compareVersion(b,a));
  const stay=all.slice(0,keep[lane]+1);
  if(all.length>keep[lane]){next.retiring[lane]={version:all[keep[lane]],retireAt:isoAt(now+graceDays*DAY)};retiring.push({lane,...next.retiring[lane]});}
  for(const x of all.slice(keep[lane]+1))retired.push({lane,version:x});
  if(lane==='o11')next.o11.served=stay.sort(compareVersion);
  else for(const odc of stay){const at=images?.[odc];if(!at?.image||!at?.tag)throw Error(`The first backend window needs the image of backend ${backendId(odc)}.`);next.backends.push({odc,image:at.image,tag:at.tag,...(at.sha256?{sha256:at.sha256}:{})});}
 }
 finish(next,keep);
 const hotPinDropped=carrySizing(next);
 return {manifest:next,retiring,retired,affected:affectedBy(tokens,[...retiring,...retired]),...(hotPinDropped?{hotPinDropped}:{})};
}
// The rounds a backend window would run for the ready candidates (readyCandidates), ODC first: one lane per round.
export const laneRounds=ready=>LANES.flatMap(lane=>ready.filter(c=>c.lane===lane).map(c=>({lane,version:c.version,candidate:c,id:laneRoundId(lane,c.version)})));
// The owner's lines of a window change: who is affected, without token ids (the evidence file keeps them).
export function affectedText(affected,{notifyAffected=true}={}){
 if(!affected?.length)return 'no customer was seen on it';
 if(!notifyAffected)return `${affected.length} customer${affected.length>1?'s':''} seen on it`;
 return affected.map(a=>`${a.customer??'customer '+String(a.token).slice(0,6)} (${STUDIO_NAME[a.lane]} ${a.version}, last seen ${a.lastSeen??'unknown'})`).join('; ');
}
export function compareFailures(before,after){const a=new Set(before.failures),b=new Set(after.failures);return {before:before.failures,after:after.failures,newFailures:[...b].filter(n=>!a.has(n)),resolved:[...a].filter(n=>!b.has(n))};}
const xml=s=>s.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
export function readTrx(text){
 const results=[...text.matchAll(/<UnitTestResult\b([^>]*)\/?\s*>/g)].map(([,attrs])=>Object.fromEntries([...attrs.matchAll(/([\w:]+)="([^"]*)"/g)].map(([,k,v])=>[k,xml(v)])));
 if(!results.length)throw Error('No test results in TRX.');
 if(results.every(r=>r.outcome==='NotExecuted'))throw Error('No executed tests in TRX.');
 return {total:results.length,passed:results.filter(r=>r.outcome==='Passed').length,skipped:results.filter(r=>r.outcome==='NotExecuted').length,failures:results.filter(r=>!['Passed','NotExecuted'].includes(r.outcome)).map(r=>r.testName).sort()};
}
// The agent pack a pair's smoke test presents and its kernel.json accepts: agentPack, with agentPackByRuntime["net<N>"]
// over the ODC fields when the pair's ODC Studio runs on .NET N, and over the O11 fields when its Service Studio does
// (a Studio that moved runtime needs the bridge built for it).
export function packFor(config,bundles){
 const pack={...config.agentPack},by=config.agentPackByRuntime??{};
 const on=lane=>{const m=tfmMajor(bundles?.[lane]?.tfm);return m?by['net'+m]:null;};
 const odc=on('odc'),o11=on('o11');
 for(const k of ['odcBridge','odcBridgeAccepted'])if(odc?.[k]!==undefined)pack[k]=odc[k];
 for(const k of ['o11BuiltFor','o11Hook'])if(o11?.[k]!==undefined)pack[k]=o11[k];
 return pack;
}
// The lanes of a pair whose Studio runs on a .NET the base agent pack was not built for (agentPack.runtime, net8.0 for the
// v97 bridges) and that agentPackByRuntime does not cover: the agent could not connect, so the round waits for the pack.
export function missingPack(config,bundles){
 const base=tfmMajor(config.agentPack?.runtime??'net8.0'),by=config.agentPackByRuntime??{};
 const need={odc:['odcBridge'],o11:['o11BuiltFor']};
 return LANES.filter(lane=>{const m=tfmMajor(bundles?.[lane]?.tfm);return m&&m!==base&&!need[lane].every(k=>by['net'+m]?.[k]!==undefined);}).map(lane=>({lane,version:bundles[lane].version,tfm:bundles[lane].tfm}));
}
export const composeText=compose=>'# Generated by gen-compose.mjs. Edit versions.json and regenerate.\n'+JSON.stringify(compose,null,2)+'\n';
// What the owner pastes in Coolify: Coolify does not expand variables inside the Traefik rule labels, so the router rules
// carry the literal domains (the "literal" copies of the releases, e.g. C:/t/vps-a11/compose.coolify.literal.yml).
export function literalCompose(compose,domains){
 if(!domains?.ssam||!domains?.console)throw Error('Set domains.ssam and domains.console in the watcher configuration.');
 for(const d of [domains.ssam,domains.console])if(!/^[a-z0-9.-]+(?::\d+)?$/i.test(d))throw Error('Invalid domain in the watcher configuration.');
 const c=structuredClone(compose);
 for(const service of Object.values(c.services??{}))for(const key of Object.keys(service.labels??{}))if(/^traefik\.http\.routers\.[^.]+\.rule$/.test(key))
  service.labels[key]=service.labels[key].replaceAll('${SSAM_DOMAIN}',domains.ssam).replaceAll('${CONSOLE_DOMAIN}',domains.console);
 return c;
}
export const literalComposeText=(manifest,domains)=>composeText(literalCompose(generateCompose(manifest),domains));
// The owner command line, from the configuration (the watcher worktree and the configuration file it runs with).
const fwd=p=>String(p).replaceAll('\\','/');
export const ownerCommand=(config,args)=>`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${fwd(config?.workspace??'C:/Users/andre/SSAM-MCP-wt/vigia-run')}/server/deploy/vigia/vigia.ps1 -Config ${fwd(config?.configFile??'C:/t/vigia/config.json')} ${args}`;
const list=values=>values.length?values.map(v=>'- '+v).join('\n'):'- none';
// One line on where the ODC features of a pair came from (the provenance summary of features-carry.mjs, no values): an
// exact export, a carried copy of the nearest exact one (with what the new version's code defaults now decide), or the
// code defaults alone.
const RECORDED={seed:'seeded',export:'exported',legacy:'recorded','legacy-store':'recorded'};
const dayOf=at=>/^\d{4}-\d{2}-\d{2}/.exec(String(at??''))?.[0]??'date unknown';
export function featuresLine(p){
 if(!p)return 'ODC features: not recorded';
 if(p.mode==='exact')return `ODC features: exact ${p.fileVersion??p.version} (${RECORDED[p.source?.kind]??'recorded'} ${dayOf(p.recordedAt)})`;
 const d=p.drift??{},from=p.source?.from??{};
 const head=p.mode==='carried'
  ?`ODC features: carried from ${from.fullVersion??from.version??'an unknown version'} (exact, ${RECORDED[from.kind]??'recorded'} ${dayOf(from.recordedAt)})${(p.chain??1)>1?`, ${p.chain} versions without an exact export`:''}`
  :`ODC features: the Studio's code defaults only (no exact features existed to carry)`;
 if(d.unknown)return `${head}; drift not checked (${d.unknown})`;
 const parts=[head];
 if(p.mode==='carried')parts.push(`${d.newKeys?.length??0} new flags use the Studio's code defaults`);
 if(d.kindConflicts?.length)parts.push(`${d.kindConflicts.length} flags of another kind left out (${d.kindConflicts.map(c=>c.name).join(', ')})`);
 parts.push(`kernel flags missing: ${d.missingKernelRelevant?.length?d.missingKernelRelevant.join(', '):'none'}`);
 return parts.join('; ');
}
export function proposalText({id,pair,built,next,comparisons,branch,commit,dir,base,replayed,runtimes,features,featuresProvenance,config}){
 const lanes=pair.lanes.map(l=>`${STUDIO_NAME[l]} ${pair[l]}`).join(' and ');
 const tests=Object.entries(comparisons).map(([lane,c])=>`- ${lane}: baseline ${c.baseline.passed}/${c.baseline.total} passed, candidate ${c.current.passed}/${c.current.total} passed; new failures: ${c.newFailures.length}; resolved: ${c.resolved.length}`).join('\n');
 const runtime=Object.entries(runtimes??{}).map(([lane,r])=>`- ${lane}: Studio ${r.studio??'unknown'}, build ${r.build??'unknown'}${r.baseline&&r.studio&&r.baseline!==r.studio?` (runtime changed from ${r.baseline}; the build rule handles it)`:''}`).join('\n');
 return `# Studio versions proposal: owner approval required\n\nNew: ${lanes}. Pair ${id}.\n\nImage (local, not published): ${built.image}:${built.tag}\nBuild digest: sha256:${built.sha256}\nRevision: ${built.revision}\nBranch: ${branch} (commit ${commit}, not pushed)\n\nNo image was published. No deployment was performed. The agent package is unchanged; live bridge validation remains an owner action.\n\n## Approve with one command\n\n\`\`\`powershell\n${ownerCommand(config,'-Approve '+id)}\n\`\`\`\n\nIt checks the local image digest, publishes the tag to the private registry (never latest), pins the published digest in versions.json, regenerates and tests the compose in a commit on ${branch}, and prints the remaining owner steps in the order of COOLIFY.md sections 5 and 7 (maintenance notice, VPS backup, the new compose in Coolify with its containers prepared stopped, kernel and features of the new pair, Redeploy, checks) and the way back.\n\nTo drop this proposal instead: \`-Reject ${id} -Reason "<why>"\`.\n\n## Window\n\nBase: ${base}${replayed.length?` (approved, not yet in main: ${replayed.join(', ')})`:''}\n\nProposed pairs (newest first):\n${list(windowPairs(next.manifest).map(p=>pairId(p)))}\n\nLeaving the window: ${JSON.stringify(next.leaving)}\n\nCustomers last seen on a leaving version:\n${list(next.affected.map(a=>`${a.customer??a.token} (${a.lane} ${a.version}, last seen ${a.lastSeen??'unknown'})`))}\n\n## Tests compared by full failure name\n\n${tests}\n\nDetails: ${path.join(dir,'comparison.json')}\n\n## Runtime\n\n${runtime||'- not recorded'}\n\n## ODC features\n\n- ${featuresLine(featuresProvenance)}${featuresProvenance&&featuresProvenance.mode!=='exact'?`\n- Nothing waited for them: the candidate tests and the smoke ran with this file. An exact export replaces it at a later round (featuresSource), or seed one: \`${ownerCommand(config,'-SeedFeatures <Features.plain.xml>')}\``:''}\n\n## Files\n\n- proposed-window.json, compose.coolify.yml: review copies of the branch commit\n- kernel.json (here) and Features.plain.xml (private: ${features??'none'}): what the new pair container needs on the VPS (printed again by -Approve)\n- smoke.json, image.json, bundles.json, comparison.json: evidence\n\n## Not run by the watcher\n\nOf the manual release recipe (handoff of 2026-10-27, section 5), the watcher runs neither builder-image.test.mjs nor the 18-check rehearsal of the whole window (coolify/rehearse.mjs). Its smoke covers one container: pair check, health, warm with builder and worker, the agent pack, tools/list against the listing budget. Run them before approving when the server code changed too.\n`;
}
export function failureText({id,error,environmental,dir,retry,config}){
 return environmental
  ?`# Studio versions round deferred\n\nPair ${id}.\n\n${error}\n\nThis is an environment problem, not a test result. The next round retries it automatically. No image was published and nothing was deployed.\n`
  :`# Studio versions pipeline stopped\n\nPair ${id}.\n\n${error}\n\nNo image was published and nothing was deployed. The same inputs are not retried: a new commit in main or another Studio build retries it after ${retry} h, or run:\n\n\`\`\`powershell\n${ownerCommand(config,'-Retry '+id)}\n\`\`\`\n\nEvidence: ${dir}\n`;
}
