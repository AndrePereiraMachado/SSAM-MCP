// vigia.ps1 -RehearseCurrent: the real round on the Studio versions already served, stopped before anything changes outside this
// machine. The real custody, installer verification, tests, image build and image smoke run. In signed-offers mode the bridges
// are built and signed, the offer is asked of the built image and the signed store lands in this rehearsal's own folder; in
// server-only mode (the default) no bridge is built and the image must accept the published agent pack's hello; in ed25519-offers
// mode the bridges are built with an Ed25519 manifest only (no Authenticode), the image must offer them to the published pack's
// hello and accept it with them installed, and the signed store lands in this rehearsal's folder. It never takes the VPS lock, publishes,
// pins, backs up, patches or deploys, and it never runs the live snapshot, which issues and revokes a token on the live server.
// Three fences: these operations are replaced here, the Coolify and SSH doors refuse by themselves (auto-runtime.mjs), and the
// command runner refuses a push (runtime.mjs). Everything is kept under <outDir>/rehearsals/<stamp>, so no real round reads it.
import fs from 'node:fs';
import path from 'node:path';
import {LANES,compareVersion,pairFor,pairId,version,servedOf,isBackendWindow,laneRoundId,dueRetirement} from './window.mjs';
import {runAttempt} from './pipeline.mjs';
import {runWindowAttempt} from './window-round.mjs';
import {verifyBridge} from '../../platforms/odc/facade/bridge-store.mjs';
import {refuseInRehearsal} from './safety.mjs';
export const NEVER_IN_REHEARSAL=['publish','pin','pinExecution','propose','archiveDeploy','openLease','acquireReleaseLock','ensureReleaseLock','preflightRemote','liveBaseline','assertLiveUnchanged','composeFor','backup','prepare','writeCompose','deploy','restoreCompose','checks','assertRollbackSafe','beginDeployment','cleanupSsh'];
export function rehearsalConfig(config,now=new Date()){
 const dir=path.join(config.outDir,'rehearsals',now.toISOString().replace(/[:.]/g,'-'));
 return {...config,outDir:dir,rehearsal:{dir}};
}
// In place: the runtime's own methods call each other through it.
export function fenceRuntime(runtime){
 for(const name of NEVER_IN_REHEARSAL)runtime[name]=()=>refuseInRehearsal(name);
 const notify=runtime.notify;
 runtime.notify=(title,message,options)=>notify.call(runtime,'SSAM rehearsal: '+String(title).replace(/^SSAM:\s*/,''),message,options);
 // A rehearsal is not a release: no line in the VPS journal and no webhook.
 runtime.event=async(name,value)=>{runtime.log?.(`rehearsal event ${name}: ${value.id}`);};
 return runtime;
}
// The newest verified release of each lane, at or above what the window serves. The window's own version is what makes this a rehearsal.
export function forcedPair(manifest,observed){
 const ready=LANES.flatMap(lane=>{
  const newest=servedOf(manifest,lane).sort(compareVersion).at(-1);
  const found=observed.filter(o=>o.lane===lane&&!o.requiresInstallation&&o.provenance&&version(o.version)&&compareVersion(version(o.version),newest)>=0).sort((a,b)=>compareVersion(version(b.version),version(a.version)))[0];
  return found?[{...found,version:version(found.version)}]:[];
 });
 if(!ready.length)throw Object.assign(Error('Nothing to rehearse: no verified official installer at or above the versions the window serves.'),{code:'REHEARSAL_NOTHING'});
 return isBackendWindow(manifest)?{lanes:ready.map(c=>c.lane),candidates:ready}:pairFor(manifest,ready);
}
async function finish(config,ops,{release,smoke}){
 ops.pause();
 await ops.verifyRelease(release);
 for(const b of release.window?.builts??[release.built])await ops.verifyLocalImage(b);
 // A backend window round (S2): what it built, the retirement it plans and the reference-app gate's state.
 const window=release.window?{window:{lane:release.window.lane,version:release.window.version,images:release.window.builts.map(b=>({backend:'odc-'+b.odc,tag:b.tag,sha256:b.sha256,kernels:b.kernels})),defaultO11:release.window.defaultO11,prepare:release.window.prepare,retiring:release.window.retiring,retired:release.window.retired,retiringNow:release.manifest.retiring??null,dueRetirement:dueRetirement(release.manifest),referenceGate:release.window.referenceGate}}:{};
 // Server-only: no bridge was built or signed, so there is no offer to ask; the image must have accepted the published pack.
 if(release.bridges?.mode==='server-only'){
  if(smoke?.publishedPack!==true)throw Error('The built image was not asked the published agent pack hello.');
  return {status:'rehearsed',id:release.id,bridgeMode:'server-only',...window,tag:release.built.tag,sha256:release.built.sha256,offers:[],kernel:release.kernel,hello:{odcBridge:release.bridges.hello?.pack?.odcBridge??null,o11BuiltFor:release.bridges.hello?.pack?.o11BuiltFor??null},listing:{tools:smoke.tools,totalBytes:smoke.totalBytes,coreBytes:smoke.coreBytes},notRun:NEVER_IN_REHEARSAL};
 }
 const offers=release.bridges?.offers??[],ed25519=release.bridges?.mode==='ed25519-offers';
 if(!offers.length||smoke?.offersChecked!==offers.length)throw Error('The built image did not offer every signed bridge.');
 // ed25519-offers: the image also accepted the published pack's hello with the offers installed (and offered them to it first).
 if(ed25519&&smoke?.publishedPack!==true)throw Error('The built image was not asked the published agent pack hello.');
 const store=path.join(config.rehearsal.dir,'store');
 fs.cpSync(release.bridges.stage,store,{recursive:true});fs.rmSync(release.bridges.stage,{recursive:true,force:true});
 const key=fs.readFileSync(path.join(store,'public-key.pem'));
 const published=offers.map(o=>{const m=verifyBridge(path.join(store,o.lane,o.studioVersion,o.protocol),key).manifest;
  if(ed25519&&m.authenticodeThumbprint!=null)throw Error('An ed25519-offers manifest names an Authenticode thumbprint.');
  return {lane:m.lane,studioVersion:m.studioVersion,protocol:m.protocol,runtime:m.runtime,sequence:m.sequence,files:m.files.length,...(ed25519?{signers:Object.fromEntries(['owner','microsoft'].map(c=>[c,m.files.filter(f=>f.signer===c).length]))}:{})};});
 return {status:'rehearsed',id:release.id,...(ed25519?{bridgeMode:'ed25519-offers'}:{}),store,tag:release.built.tag,sha256:release.built.sha256,offers:published,kernel:release.kernel,
  ...(ed25519?{hello:{odcBridge:release.bridges.hello?.pack?.odcBridge??null,o11BuiltFor:release.bridges.hello?.pack?.o11BuiltFor??null,installed:(release.bridges.hello?.bridges??[]).map(b=>b.lane+' '+b.protocol+'#'+b.sequence)},offerLanes:release.bridges.offerLanes??[],legacy:release.bridges.legacy??null}:{}),
  listing:{tools:smoke.tools,totalBytes:smoke.totalBytes,coreBytes:smoke.coreBytes},notRun:NEVER_IN_REHEARSAL};
}
export async function rehearseCurrent(config,runtime,{manifest,now=Date.now()}){
 if(!config.rehearsal?.dir)throw Error('A rehearsal runs only with its own folder.');
 if(!config.automatic)throw Error('A rehearsal exercises the automatic round: this configuration is not automatic.');
 fenceRuntime(runtime);
 await runtime.executionSource();
 runtime.pause();
 const secrets=await runtime.secrets();
 try{
  await runtime.assertCoolifyReadable(secrets);
  const observed=await runtime.observe(await runtime.detect(),{manifest});
  const pair=forcedPair(manifest,observed),head=await runtime.head();
  // A backend window (S2) rehearses ONE lane round, ODC first (config.rehearsal.lane picks the other): a version the window
  // serves is rebuilt as its round would build it, a newer verified one is rotated in as its round would (nothing deploys).
  if(isBackendWindow(manifest)){
   const c=pair.candidates.find(x=>x.lane===(config.rehearsal.lane??pair.lanes[0]))??pair.candidates[0],id=laneRoundId(c.lane,c.version);
   runtime.log?.(`rehearsal of ${id} (backend window); nothing leaves this machine`);
   const result=await runWindowAttempt({...config,manifest,state:{},observed,head,liveBaseline:null,replayed:[],rehearsal:{...config.rehearsal,finish}},runtime,{id,kind:'add',lane:c.lane,version:c.version,candidate:c,rehearse:servedOf(manifest,c.lane).includes(c.version),inputs:{head,studios:{[c.lane]:c.fullVersion??c.version}},previous:null,skipped:[]},now);
   fs.mkdirSync(config.rehearsal.dir,{recursive:true});
   fs.writeFileSync(path.join(config.rehearsal.dir,'rehearsal.json'),JSON.stringify(result,null,2)+'\n');
   return result;
  }
  const id=pairId(pair);
  const inputs={head,studios:Object.fromEntries(pair.candidates.map(c=>[c.lane,c.fullVersion??c.version]))};
  runtime.log?.(`rehearsal of ${id}; forced lanes ${pair.lanes.join(', ')}; nothing leaves this machine`);
  const result=await runAttempt({...config,manifest,state:{},observed,head,liveBaseline:null,replayed:[],rehearsal:{...config.rehearsal,finish}},runtime,{pair,id,inputs,previous:null,skipped:[]},now);
  fs.mkdirSync(config.rehearsal.dir,{recursive:true});
  fs.writeFileSync(path.join(config.rehearsal.dir,'rehearsal.json'),JSON.stringify(result,null,2)+'\n');
  return result;
 }finally{
  // The rehearsal's bundles and image hold OutSystems binaries and several GB; its receipts and signed store stay.
  fs.rmSync(path.join(config.rehearsal.dir,'bundles'),{recursive:true,force:true});
  if(runtime.docker&&config.image!==null){
   const listed=await runtime.docker(['image','ls','--format','{{.Repository}}:{{.Tag}}','--filter',`reference=${config.image??'docker.io/andrepereiramachado/ssam-server'}:rehearsal-*`],{allowFailure:true});
   for(const image of listed.stdout.split('\n').map(x=>x.trim()).filter(Boolean))await runtime.docker(['image','rm','-f',image],{allowFailure:true});
  }
 }
}
