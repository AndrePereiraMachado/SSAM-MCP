// Server-only bridge mode (config bridgeMode, the default): the watcher deploys only the server pair. It builds, signs and
// offers no client bridge; the client bridges are those the CURRENTLY PUBLISHED agent packs already ship. So the kernel of a
// new pair accepts exactly those bridges (plus what the nearest served pair accepts), and a pair is deployed only when a hello
// of the published pack, with its real bridges and commands, is compatible on both lanes. A Studio whose runtime no published
// pack covers waits (client-bridge-update-required) and production is never touched for that lane.
// The packs are the owner-reviewed private configuration (agentPack, agentPackByRuntime), cross-checked against the reviewed
// agent release source (agentReleaseCommit): never the server, the environment or a customer's hello.
// "signed-offers" keeps the round that builds, Authenticode-signs and offers client bridges (auto-runtime.mjs buildBridges).
// "ed25519-offers" (F1 of C:/t/r5/PLANO-AGENTE-AUTO.md 3.A): the server-only gate on the published packs, plus client bridges the
// round compiles from its verified Studio bundles and offers with an Ed25519-signed manifest only. Nothing is Authenticode-signed:
// each executable's signer class comes from verification alone (classify-signers.ps1). Only an agent that accepts Ed25519-only
// offers takes them (app 0.2.8: agent 0.3.17 / native 0.4.14, hello capabilities.bridgeOffer true); a Service Studio the published
// packs have no thin bridge for is served by the offered d1 bridge (offersGate), never by an unverified fallback.
// Pure: no process, Git, network or file here.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {LANES,STUDIO_NAME,tfmMajor,compareVersion,version as threeOf} from './window.mjs';
import {compatibility} from '../../platforms/odc/facade/agent-hub.mjs';
import {bridgeReferences} from './odc-binary.mjs';
// The next patch version of a three-part version ("11.55.95" -> "11.55.96"): a Service Studio newer than a pair's.
export const nextPatch=v=>{const p=String(v).split(".").slice(0,3).map(Number);return p.length===3&&p.every(Number.isSafeInteger)?`${p[0]}.${p[1]}.${p[2]+1}`:null;};
export const BRIDGE_MODES=Object.freeze(['server-only','signed-offers','ed25519-offers']);
export const CLIENT_BRIDGE_CODE='client-bridge-update-required';
export function bridgeMode(config){
 const mode=config?.bridgeMode??'server-only';
 if(!BRIDGE_MODES.includes(mode))throw Object.assign(Error(`Unknown bridgeMode ${JSON.stringify(mode)}: use "server-only", "signed-offers" or "ed25519-offers".`),{code:'BRIDGE_MODE_INVALID'});
 return mode;
}
export const isServerOnly=config=>bridgeMode(config)==='server-only';
export const isEd25519Offers=config=>bridgeMode(config)==='ed25519-offers';
const odcProtocol=value=>/^v\d+$/.test(value??'');
const protocolNumber=value=>Number(String(value).slice(1));
const newest=list=>[...new Set(list.filter(odcProtocol))].sort((a,b)=>protocolNumber(b)-protocolNumber(a))[0]??null;
const unique=list=>[...new Set(list.filter(v=>typeof v==='string'&&v))];
// The ODC commands of a frozen string list in a source file (agent/agent/lib/kinds.mjs ODC_COMMANDS, the native
// StudioKinds.cs OdcCommandList), or null when the file does not declare it.
function commandList(text,pattern){const m=pattern.exec(text??'');return m?[...m[1].matchAll(/['"]([a-z][a-z0-9:-]*)['"]/g)].map(x=>x[1]):null;}
// What the reviewed agent release ships and runs, read from its source at agentReleaseCommit: the ODC bridge its client
// attaches to each Studio runtime (client/Program.cs: Version, and EarlierVersion for net8 Studios) and the ODC commands
// its agents declare in the hello (the Node and the native agent: a published pack may run either, so only what both run).
export function parseAgentRelease({commit=null,program,kinds,native,bridgeProject=null}){
 const current=/const string Version = "(v\d+)"/.exec(program??'')?.[1]??null,earlier=/const string EarlierVersion = "(v\d+)"/.exec(program??'')?.[1]??null;
 if(!current)throw Object.assign(Error('The reviewed agent release names no ODC bridge (client/Program.cs Version).'),{code:'AGENT_RELEASE_REQUIRED'});
 const lists=[commandList(kinds,/ODC_COMMANDS\s*=\s*Object\.freeze\(\[([^\]]*)\]/),commandList(native,/OdcCommandList\s*=\s*\[([^\]]*)\]/)].filter(Boolean);
 const commands=lists.length?lists.reduce((a,b)=>a.filter(c=>b.includes(c))):[];
 // From the ODC bridge v108 on both agents add merge:prefer-foreign (odcDeclared): informational, no compatibility rule reads it.
 const preferFrom=Number(/>=\s*(\d+)\s*\??\s*\[\.\.\.ODC_COMMANDS,\s*'merge:prefer-foreign'\]/.exec(kinds??'')?.[1]??NaN);
 // The ODC Studio assemblies its bridge is compiled against (Bridge.csproj), for the static reference check (odc-binary.mjs).
 return {commit,odc:{current,earlier,references:bridgeReferences(bridgeProject)},commands,preferFrom:Number.isFinite(preferFrom)?preferFrom:null};
}
// The ODC bridges the release's client attaches to a Studio of this runtime (Program.cs: a net8 Studio takes only
// EarlierVersion; any other takes Version or EarlierVersion).
export const loadableOdc=(release,tfm)=>tfmMajor(tfm)===8?[release.odc.earlier??release.odc.current]:unique([release.odc.current,release.odc.earlier]);
const O11_KEYS=['o11BuiltFor','o11Hook','o11Builds','o11Runtime'],ODC_KEYS=['odcBridge','odcBridges'];
// The ODC bridges a pack declares (odcBridge and odcBridges), and the newest of them the release attaches to that runtime.
const declaredOdc=pack=>unique([pack?.odcBridge,...(Array.isArray(pack?.odcBridges)?pack.odcBridges:[])]).filter(odcProtocol);
const newestLoadable=(release,pack,tfm)=>release?newest(declaredOdc(pack).filter(v=>loadableOdc(release,tfm).includes(v))):null;
// The pack an agent presents to a Studio of this lane and runtime: agentPack, with agentPackByRuntime["net<N>"] over the
// lane's fields (window.mjs packFor and missingPack, the same rule). null: no published pack covers that runtime.
export function packForStudio(config,lane,tfm){
 const major=tfmMajor(tfm);if(major===null)return null;
 const base=config.agentPack??{},over=config.agentPackByRuntime?.['net'+major];
 const need=lane==='odc'?'odcBridge':'o11BuiltFor';
 if(major!==tfmMajor(base.runtime??'net8.0')&&over?.[need]===undefined)return null;
 const pack={...base};for(const k of lane==='odc'?ODC_KEYS:O11_KEYS)if(over?.[k]!==undefined)pack[k]=over[k];
 if(pack[need]===undefined||pack[need]===null)return null;
 return pack;
}
// Every published pack: agentPack and each agentPackByRuntime entry over it.
export const publishedPacks=config=>[config.agentPack??{},...Object.values(config.agentPackByRuntime??{}).map(over=>({...config.agentPack,...over}))];
const builds=pack=>(Array.isArray(pack?.o11Builds)?pack.o11Builds:[]).map(b=>typeof b==='string'?{version:b}:{version:b?.version,runtime:b?.runtime??null}).filter(b=>/^\d+\.\d+\.\d+$/.test(b.version??''));
// A live proof that a thin bridge built for another Service Studio loads into this one (config o11BridgeProven, by Service
// Studio version a.b.c): {studioVersion (the key), build (the o11Builds entry proven), packCommit (the agent pack proven: the
// reviewed agentReleaseCommit), provenAt (ISO date-time, not in the future), evidence (the proof file, under the private
// proofs folder), sha256 (optional: when given, the file's)}. Free text, another pack, a missing or moved file is no proof.
export const O11_PROOFS_ROOT='C:/ssam-priv/vigia/proofs';
const PROOF_FIELDS=['build','evidence','packCommit','provenAt','sha256','studioVersion'];
const under=(root,file)=>{const r=path.win32.relative(path.win32.resolve(root),path.win32.resolve(file));return !!r&&!r.startsWith('..')&&!path.win32.isAbsolute(r);};
// Why an o11BridgeProven entry is no proof (null: its shape is one). Pure: the file is read by o11Proofs.
export function o11ProofProblem(version,p,{agentReleaseCommit,root=O11_PROOFS_ROOT,now=Date.now()}={}){
 if(!/^\d+\.\d+\.\d+$/.test(version))return 'its key is not a Service Studio version a.b.c';
 if(!p||typeof p!=='object'||Array.isArray(p))return 'it is not {studioVersion, build, packCommit, provenAt, evidence}';
 const unknown=Object.keys(p).filter(k=>!PROOF_FIELDS.includes(k));if(unknown.length)return `unknown field ${unknown.join(', ')}`;
 if(p.studioVersion!==version)return `studioVersion ${JSON.stringify(p.studioVersion??null)} is not its key ${version}`;
 if(typeof p.build!=='string'||!/^\d+\.\d+\.\d+$/.test(p.build)||p.build===version)return `build ${JSON.stringify(p.build??null)} is not another Service Studio version a.b.c`;
 if(!/^[a-f0-9]{40}$/.test(agentReleaseCommit??''))return 'agentReleaseCommit is not configured';
 if(p.packCommit!==agentReleaseCommit)return `packCommit ${JSON.stringify(p.packCommit??null)} is not the reviewed agentReleaseCommit ${agentReleaseCommit.slice(0,7)}`;
 const at=typeof p.provenAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(p.provenAt)?Date.parse(p.provenAt):NaN;
 if(!Number.isFinite(at))return 'provenAt is not an ISO date-time with its zone';
 if(at>now+5*60000)return 'provenAt is in the future';
 if(typeof p.evidence!=='string'||!/^[A-Za-z]:[\\/]/.test(p.evidence)||!under(root,p.evidence))return `evidence is not a file under ${root}`;
 if(p.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(p.sha256))return 'sha256 is not 64 lowercase hex';
 return null;
}
// The usable proofs of a config, each with the sha256 and size of its evidence file as read now (recorded in release.json),
// and the refused entries with why. The file must be a regular file (no link, no reparse point on the way) whose real path
// stays under the proofs folder.
export function o11Proofs(config,{root=O11_PROOFS_ROOT,now=Date.now()}={}){
 const proven={},refused=[];
 for(const [version,p] of Object.entries(config?.o11BridgeProven??{})){
  let why=o11ProofProblem(version,p,{agentReleaseCommit:config.agentReleaseCommit,root,now});
  if(!why)try{
   const s=fs.lstatSync(p.evidence);
   if(s.isSymbolicLink()||!s.isFile())why='evidence is not a regular file';
   else if(s.size<1||s.size>64*1024*1024)why='evidence is empty or larger than 64 MiB';
   else if(!under(fs.realpathSync.native(root),fs.realpathSync.native(p.evidence)))why=`evidence resolves outside ${root}`;
   else{const sha256=createHash('sha256').update(fs.readFileSync(p.evidence)).digest('hex');
    if(p.sha256&&p.sha256!==sha256)why='evidence changed since its sha256 was recorded';
    else proven[version]={studioVersion:p.studioVersion,build:p.build,packCommit:p.packCommit,provenAt:p.provenAt,evidence:p.evidence,sha256,size:s.size};}
  }catch(e){why=`evidence cannot be read (${e.code??e.message})`;}
  if(why)refused.push({version,why});
 }
 return {proven,refused};
}
// The thin bridge the gate accepts for this Service Studio: the pack's build of exactly that version (a thin bridge binds to
// the exact ServiceStudio.* assembly versions it was compiled against, agent o11-builds.mjs), else only the build of a proof
// o11Proofs verified (proven: its output, each entry with the evidence sha256 it read). The agent itself falls back to the
// pack's default build (o11PackFor); the gate never does. null: no build that version can load.
export function o11BuildFor(pack,studioVersion,proven={}){
 const v=threeOf(studioVersion),own=builds(pack).find(b=>b.version===v);
 if(own)return {...own,proven:false};
 const p=proven?.[v];
 if(p&&p.studioVersion===v&&/^[a-f0-9]{64}$/.test(p.sha256??'')&&typeof p.evidence==='string'){const b=builds(pack).find(x=>x.version===threeOf(p.build));if(b)return {...b,proven:true};}
 return null;
}
// Why the published packs have no bridge for this Studio (null: they have one). studio: {version, tfm} of the verified
// installer (its runtimeconfig.json) or of the served bundle.
export function laneGap(config,release,lane,studio){
 const name=STUDIO_NAME[lane],major=tfmMajor(studio.tfm);
 if(major===null)return `the ${name} runtime is unknown`;
 const pack=packForStudio(config,lane,studio.tfm);
 if(!pack)return `no published agent pack declares a bridge for ${name}s on net${major} (agentPackByRuntime.net${major} names no ${lane==='odc'?'odcBridge':'o11BuiltFor'})`;
 if(lane==='odc'){
  if(!odcProtocol(pack.odcBridge))return `the published pack declares no ODC bridge (${JSON.stringify(pack.odcBridge??null)})`;
  if(!release)return 'the reviewed agent release is unknown';
  // Every ODC bridge the config says the pack ships for this runtime (odcBridge and odcBridges) must be one the reviewed
  // release's client attaches to that runtime: the config value alone is never trusted.
  const loadable=loadableOdc(release,studio.tfm),declared=unique([pack.odcBridge,...(Array.isArray(pack.odcBridges)?pack.odcBridges:[])]);
  const foreign=declared.filter(v=>!loadable.includes(v));
  if(foreign.length)return `the reviewed agent release ${String(release.commit??'').slice(0,7)||'(unknown)'} attaches ${loadable.join(' or ')} to an ODC Studio on ${studio.tfm}, not the declared ${foreign.join(', ')}`;
  return null;
 }
 const build=o11BuildFor(pack,studio.version,config.o11BridgeProven);
 const refusal=(config.o11ProofRefusals??[]).find(r=>r.version===threeOf(studio.version));
 if(!build)return `the published pack has no thin bridge built for Service Studio ${threeOf(studio.version)} (o11Builds: ${builds(pack).map(b=>b.version).join(', ')||'none'}); a thin bridge binds to the exact Service Studio it was built for${refusal?`; its o11BridgeProven entry is refused: ${refusal.why}`:''}`;
 if(!build.runtime)return `the pack's thin bridge for Service Studio ${build.version} declares no runtime (o11Builds needs {version, runtime})`;
 if(tfmMajor(build.runtime)!==major)return `the pack's thin bridge for Service Studio ${build.version} is built for ${build.runtime}`;
 return null;
}
// The hello of the published pack for a pair, as the agent of that pack sends it (agent.mjs hello): its ODC bridge for the
// ODC Studio's runtime, the thin bridge it loads into that Service Studio, the release's ODC commands, and no bridge offer.
export function packHello(config,release,studios){
 const odc=packForStudio(config,'odc',studios.odc.tfm)??{},o11=packForStudio(config,'o11',studios.o11.tfm)??{};
 const odcBridge=newestLoadable(release,odc,studios.odc.tfm),commands=[...(release?.commands??[])];
 if(release?.preferFrom&&odcProtocol(odcBridge)&&protocolNumber(odcBridge)>=release.preferFrom&&!commands.includes('merge:prefer-foreign'))commands.push('merge:prefer-foreign');
 const o11Build=o11BuildFor(o11,studios.o11.version,config.o11BridgeProven);
 return {t:'hello',protocol:'ssam-agent/1',instance:'vigia-published-pack',agent:{version:'published',odcCommands:commands},capabilities:{bridgeOffer:false},
  pack:{id:'published',lanes:['odc','o11'],odcBridge,odcBridges:declaredOdc(odc).filter(v=>release&&loadableOdc(release,studios.odc.tfm).includes(v)),o11BuiltFor:o11Build?.version??null,o11Hook:o11.o11Hook??'dev',...(builds(o11).length?{o11Builds:builds(o11).map(b=>b.version)}:{})},
  studios:Object.fromEntries(LANES.map(lane=>[lane,{installed:{version:studios[lane].fullVersion??studios[lane].version,runtime:studios[lane].tfm??null,dir:'C:/Vigia'}}]))};
}
// The served kernel nearest to a version of a lane: the same version, else the newest below it, else the oldest above it.
// Every served kernel of that version counts (two pairs may share a Service Studio).
export function nearestKernels(kernels,lane,value){
 const list=(kernels??[]).filter(k=>/^\d+\.\d+\.\d+$/.test(k?.[lane]??''));
 const below=list.filter(k=>compareVersion(k[lane],value)<=0).sort((a,b)=>compareVersion(b[lane],a[lane]));
 const pick=below[0]??list.sort((a,b)=>compareVersion(a[lane],b[lane]))[0];
 return pick?list.filter(k=>k[lane]===pick[lane]):[];
}
// The kernel.json of a new pair: odcBridge the newest bridge the published pack ships for that ODC Studio's runtime and the
// reviewed release attaches to it; odcBridgeAccepted the ODC bridges the packs ship that the release builds at all (Version,
// EarlierVersion), plus what the nearest served ODC pair accepts; o11BridgeAccepted only what the nearest served Service
// Studio pair accepts (downloaded-bridge protocols dN: a pack's o11Hook is dev or h1, never dN, so packs add none).
export function serverOnlyKernel(config,pair,studios,servedKernels,release){
 const odc=packForStudio(config,'odc',studios.odc.tfm);
 const odcBridge=odc?newestLoadable(release,odc,studios.odc.tfm):null;
 if(!odcBridge)throw Object.assign(Error('No published agent pack has an ODC bridge the reviewed release attaches to this ODC Studio.'),{code:CLIENT_BRIDGE_CODE});
 const packs=publishedPacks(config),near={odc:nearestKernels(servedKernels,'odc',pair.odc),o11:nearestKernels(servedKernels,'o11',pair.o11)};
 const shipped=unique([release?.odc?.current,release?.odc?.earlier]);
 const odcAccepted=unique([...packs.flatMap(declaredOdc).filter(v=>shipped.includes(v)),...near.odc.flatMap(k=>[k.odcBridge,...(k.odcBridgeAccepted??[])])]).filter(v=>odcProtocol(v)&&v!==odcBridge);
 const o11Accepted=unique(near.o11.flatMap(k=>k.o11BridgeAccepted??[])).filter(v=>/^d\d+$/.test(v));
 return {o11:pair.o11,odc:pair.odc,odcBridge,odcBridgeAccepted:odcAccepted,o11BridgeAccepted:o11Accepted};
}
// The lanes whose hello of the published pack the kernel refuses (with the server's code), with the pair's served versions.
export function helloRefusals(hello,kernel,served){
 const answer=compatibility(hello,{...kernel,servedVersions:served},['odc','o11']);
 return LANES.filter(lane=>!answer[lane]?.ok).map(lane=>({lane,code:answer[lane]?.code??'UNKNOWN',message:answer[lane]?.message??''}));
}
// The whole gate for a pair: every lane of the pair has a published bridge for its Studio's runtime, and the published
// pack's hello is compatible with the new kernel on both lanes. gaps names the lanes to defer (empty: deployable).
export function serverOnlyGate({config,release,pair,studios,servedKernels,served}){
 const gaps=[];
 for(const lane of LANES){const why=laneGap(config,release,lane,studios[lane]);if(why)gaps.push({lane,version:studios[lane].version,tfm:studios[lane].tfm??null,why});}
 if(gaps.length)return {gaps};
 const kernel=serverOnlyKernel(config,pair,studios,servedKernels,release),hello=packHello(config,release,studios);
 for(const r of helloRefusals(hello,kernel,served))gaps.push({lane:r.lane,version:studios[r.lane].version,tfm:studios[r.lane].tfm??null,why:`the published pack's hello is refused (${r.code}: ${r.message})`});
 return {gaps,kernel,hello};
}
// The lanes a gap defers: its own when it is a lane of the pair; the pair's lanes when the gap is in the companion lane
// (the served Studio the pair keeps), since that pair cannot be served at all.
export const deferredLanes=(gaps,pair)=>{const own=gaps.map(g=>g.lane).filter(l=>pair.lanes.includes(l));return [...new Set(gaps.some(g=>!pair.lanes.includes(g.lane))?pair.lanes:own)];};
export const gapText=gaps=>gaps.map(g=>`client bridge update required: ${g.lane} ${g.version} runtime ${g.tfm??'unknown'} (${g.why})`).join('; ')
 +'. Production is not touched for this lane. Publish an agent pack whose bridge loads in that Studio, declare it in agentPack/agentPackByRuntime with its reviewed agentReleaseCommit, and the next round retries.';

// ed25519-offers. The hello of the published pack as its agent sends it: the pack's thin bridge for exactly this Service Studio,
// else the pack's default build (the agent's o11PackFor keeps the pack unchanged), and bridgeOffer as the agent's trust anchor
// says (true: app 0.2.8, which accepts Ed25519-only offers; false: 0.2.7, whose anchor is empty and which never takes an offer).
export function agentHello(config,release,studios,{bridgeOffer}){
 const hello=packHello(config,release,studios),o11=packForStudio(config,'o11',studios.o11.tfm)??config.agentPack??{};
 const exact=builds(o11).find(b=>b.version===threeOf(studios.o11.version))?.version??null,fallback=threeOf(o11.o11BuiltFor)??null;
 return {...hello,instance:bridgeOffer?'vigia-published-pack-offers':'vigia-published-pack-legacy',capabilities:{bridgeOffer:bridgeOffer===true},pack:{...hello.pack,o11BuiltFor:exact??fallback}};
}
// The same hello once the agent installed the offers it received (bridge-updates.mjs report: status installed).
export const installedHello=(hello,received)=>({...hello,bridges:received.map(({lane,studioVersion,protocol,sequence})=>({lane,studioVersion,protocol,sequence,status:'installed',reason:'INSTALLED'}))});
// The kernel.json of a new pair in ed25519-offers: the server-only kernel (the published packs keep working as they do), plus the
// offered protocols of this pair (the ODC one among odcBridgeAccepted, d1 among o11BridgeAccepted).
// o11PackBuiltFor (F1 review M2): the pack thin-bridge builds the new pair's hub accepts for its Service Studio when the agent has
// no signed bridge installed for it: the exact build, and the build of a verified o11BridgeProven proof for it. An agent that
// does not take the offer (app 0.2.7, the macOS agent, an install that failed) therefore keeps the server-only rule: a new
// Service Studio is served to it only by a build of its own or a proven one, never by its default build of another Studio;
// otherwise the hub refuses it with what to install (agent-hub.mjs packBuildRefusal), whatever the window still serves.
// o11ProvenBuilds (round 3, M-1): the same for every OTHER Service Studio the hub may answer (a newer one routed here by its ODC
// Studio, an older one of the window): the hub serves it only by its own build, a verified proof's build listed here, or a
// signed bridge installed for it.
export function offersKernel(config,pair,studios,servedKernels,release,offers){
 const kernel=serverOnlyKernel(config,pair,studios,servedKernels,release);
 const of=lane=>offers.filter(o=>o.lane===lane&&o.studioVersion===pair[lane]).map(o=>o.protocol);
 // A proof counts only verified: keyed by its own studioVersion, its evidence read and hashed this round (sha256).
 const provenFor=v=>{const p=config.o11BridgeProven?.[v];return p?.studioVersion===v&&/^[a-f0-9]{64}$/.test(p.sha256??'')?threeOf(p.build):null;};
 const provenBuilds=Object.fromEntries(Object.keys(config.o11BridgeProven??{}).filter(v=>threeOf(v)===v&&v!==pair.o11&&provenFor(v)).map(v=>[v,[provenFor(v)]]));
 return {...kernel,odcBridgeAccepted:unique([...kernel.odcBridgeAccepted,...of('odc').filter(odcProtocol)]).filter(v=>v!==kernel.odcBridge),o11BridgeAccepted:unique([...kernel.o11BridgeAccepted,...of('o11').filter(v=>/^d\d+$/.test(v))]),
  o11PackBuiltFor:unique([pair.o11,provenFor(pair.o11)]),o11ProvenBuilds:provenBuilds};
}
const answerOf=(hello,kernel,served,bridges)=>compatibility(hello,{...kernel,servedVersions:served},['odc','o11'],{bridges});
// The ed25519-offers gate for a pair, with the signed store the round built (bridges: bridge-store.mjs createBridgeStore over its
// stage). An ODC gap stays a gap (the hub offers an ODC bridge only to a refused pack, and the offered protocol is the client's own
// name, so no offer replaces a published pack that cannot load). An O11 gap (no thin bridge built for this Service Studio, or one
// of another runtime) is closed only by the offer: the 0.2.8 hello must receive the signed d1 offer of this Service Studio, and the
// same hello with every received offer installed must be accepted on both lanes. The 0.2.7 hello is evaluated, never offered:
// legacy says what those agents get on the new pair (deployment never waits for them).
export function offersGate({config,release,pair,studios,servedKernels,served,offers,bridges}){
 const gaps=[],o11Gap=laneGap(config,release,'o11',studios.o11);
 for(const lane of LANES){if(lane==='o11')continue;const why=laneGap(config,release,lane,studios[lane]);if(why)gaps.push({lane,version:studios[lane].version,tfm:studios[lane].tfm??null,why});}
 if(gaps.length)return {gaps};
 const kernel=offersKernel(config,pair,studios,servedKernels,release,offers),hello=agentHello(config,release,studios,{bridgeOffer:true});
 const first=answerOf(hello,kernel,served,bridges),received=[];
 const gap=(lane,why)=>gaps.push({lane,version:studios[lane].version,tfm:studios[lane].tfm??null,why});
 for(const lane of LANES){
  const a=first[lane],own=offers.find(o=>o.lane===lane&&o.studioVersion===pair[lane]);
  if(a?.bridgeOffer){
   const m=typeof a.bridgeOffer.manifest==='string'?JSON.parse(a.bridgeOffer.manifest):a.bridgeOffer.manifest;
   if(!own||a.bridgeOffer.protocol!==own.protocol||m?.sequence!==own.sequence)gap(lane,`the published pack's hello was offered ${a.bridgeOffer.protocol} sequence ${m?.sequence}, not the bridge this round signed`);
   else received.push(own);
  }
  else if(!a?.ok)gap(lane,`the published pack's hello is refused (${a?.code??'UNKNOWN'}: ${a?.message??''}) and no signed offer reaches it`);
  else if(lane==='o11'&&o11Gap)gap(lane,`${o11Gap}; and the hello of an agent that accepts Ed25519 offers received no signed offer for it`);
 }
 if(gaps.length)return {gaps};
 const installed=installedHello(hello,received),after=answerOf(installed,kernel,served,bridges);
 for(const lane of LANES)if(!after[lane]?.ok)gap(lane,`the published pack's hello with the offered bridges installed is refused (${after[lane]?.code??'UNKNOWN'}: ${after[lane]?.message??''})`);
 else if(after[lane].bridgeOffer)gap(lane,"the published pack's hello with the offered bridges installed is offered a bridge again");
 if(gaps.length)return {gaps};
 const legacyHello=agentHello(config,release,studios,{bridgeOffer:false}),old=answerOf(legacyHello,kernel,served,bridges);
 const legacy=Object.fromEntries(LANES.map(lane=>[lane,old[lane]?.ok?{ok:true}:{ok:false,code:old[lane]?.code??'UNKNOWN',...(old[lane]?.cause?{cause:old[lane].cause}:{})}]));
 // The 0.2.7 hello is never served on a thin bridge built for another Service Studio (o11PackBuiltFor): the hub refuses it with
 // AGENT_UPDATE_REQUIRED (install app 0.2.8), while 11.55.94 is still in the window as well as after it leaves.
 if(old.o11?.ok&&!kernel.o11PackBuiltFor.includes(threeOf(legacyHello.pack.o11BuiltFor)))gap('o11','a hello without bridgeOffer (agent 0.2.7) was served a thin bridge built for another Service Studio');
 for(const lane of LANES)if(old[lane]?.bridgeOffer)gap(lane,'a hello without bridgeOffer (agent 0.2.7) was offered a bridge');
 // Round 3 M-1, the same family rule for a Service Studio newer than the pair's (routed here by its ODC Studio before a pair of
 // its own exists; the window answers it "newer"): no agent, 0.2.7 or 0.2.8, is served there on a thin bridge built for another
 // Service Studio, unless a verified proof covers that build (o11ProvenBuilds).
 const next=nextPatch(pair.o11),newer={...studios,o11:{...studios.o11,version:next,fullVersion:next+'.0'}};
 for(const h of [agentHello(config,release,newer,{bridgeOffer:false}),agentHello(config,release,newer,{bridgeOffer:true})]){
  const a=answerOf(h,kernel,served,bridges).o11,built=threeOf(h.pack.o11BuiltFor);
  if(a?.ok&&built!==next&&!(kernel.o11ProvenBuilds?.[next]??[]).includes(built))gap('o11',`a Service Studio newer than the pair's (${next}) was served a thin bridge built for ${built} (bridgeOffer ${h.capabilities.bridgeOffer})`);
 }
 return {gaps,kernel,hello:installed,offerHello:hello,offerLanes:received.map(o=>o.lane),legacyHello,legacy};
}
