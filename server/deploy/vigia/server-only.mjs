// Server-only bridge mode (config bridgeMode, the default): the watcher deploys only the server pair. It builds, signs and
// offers no client bridge; the client bridges are those the CURRENTLY PUBLISHED agent packs already ship. So the kernel of a
// new pair accepts exactly those bridges (plus what the nearest served pair accepts), and a pair is deployed only when a hello
// of the published pack, with its real bridges and commands, is compatible on both lanes. A Studio whose runtime no published
// pack covers waits (client-bridge-update-required) and production is never touched for that lane.
// The packs are the owner-reviewed private configuration (agentPack, agentPackByRuntime), cross-checked against the reviewed
// agent release source (agentReleaseCommit): never the server, the environment or a customer's hello.
// "signed-offers" keeps the round that builds, Authenticode-signs and offers client bridges (auto-runtime.mjs buildBridges).
// Pure: no process, Git, network or file here.
import {LANES,STUDIO_NAME,tfmMajor,compareVersion,version as threeOf} from './window.mjs';
import {compatibility} from '../../platforms/odc/facade/agent-hub.mjs';
import {bridgeReferences} from './odc-binary.mjs';
export const BRIDGE_MODES=Object.freeze(['server-only','signed-offers']);
export const CLIENT_BRIDGE_CODE='client-bridge-update-required';
export function bridgeMode(config){
 const mode=config?.bridgeMode??'server-only';
 if(!BRIDGE_MODES.includes(mode))throw Object.assign(Error(`Unknown bridgeMode ${JSON.stringify(mode)}: use "server-only" or "signed-offers".`),{code:'BRIDGE_MODE_INVALID'});
 return mode;
}
export const isServerOnly=config=>bridgeMode(config)==='server-only';
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
// The thin bridge the gate accepts for this Service Studio: the pack's build of exactly that version (a thin bridge binds to
// the exact ServiceStudio.* assembly versions it was compiled against, agent o11-builds.mjs), else only a build the owner
// declared proven for it in o11BridgeProven {"<a.b.c>": {build, evidence}} (a live proof recorded in evidence). The agent
// itself falls back to the pack's default build (o11PackFor); the gate never does. null: no build that version can load.
export function o11BuildFor(pack,studioVersion,proven={}){
 const v=threeOf(studioVersion),own=builds(pack).find(b=>b.version===v);
 if(own)return {...own,proven:false};
 const p=proven?.[v];
 if(p&&typeof p.evidence==='string'&&p.evidence.trim()){const b=builds(pack).find(x=>x.version===threeOf(p.build));if(b)return {...b,proven:true};}
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
 if(!build)return `the published pack has no thin bridge built for Service Studio ${threeOf(studio.version)} (o11Builds: ${builds(pack).map(b=>b.version).join(', ')||'none'}); a thin bridge binds to the exact Service Studio it was built for`;
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
