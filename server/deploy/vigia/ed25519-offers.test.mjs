// F1 of C:\t\r5\PLANO-AGENTE-AUTO.md (3.A): bridgeMode ed25519-offers. When a new Studio needs client bridges, the vigia builds
// them from its verified bundles, never Authenticode-signs them, classifies every executable's signer by verification only, writes
// the Ed25519-signed manifest without a thumbprint, and the server offers them to the agents that accept Ed25519-only offers (app
// 0.2.8: hello capabilities.bridgeOffer true). The 0.2.7 agents (empty anchor: bridgeOffer false) are never offered anything.
// Everything here runs on fakes and fixtures: no Studio bundle, no dotnet, no vault, no network but the one revocation check of
// the real Microsoft DLL in the classification test (skipped when the service is unreachable).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {generateKeyPairSync,createHash,createPublicKey,sign} from 'node:crypto';
import {createBridgeStore,verifyBridge} from '../../platforms/odc/facade/bridge-store.mjs';
import {compatibility} from '../../platforms/odc/facade/agent-hub.mjs';
import {toolListingBytes} from '../../platforms/odc/facade/tool-listing.mjs';
import {parseAgentRelease,offersGate,offersKernel,agentHello,installedHello,laneGap,isEd25519Offers} from './server-only.mjs';
import {verifySignedAgentRelease} from './safety.mjs';
import {createAutoRuntime,spkiSha256,assertTrustKey,reuseSigned} from './auto-runtime.mjs';
import {automaticPlan,ED25519_OFFERS_STEP,AUTOMATIC_PLAN} from './automatic.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const tmp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'ed25519-offers-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=rel=>fs.readFileSync(path.resolve(here,'../../..',rel),'utf8');
const release=parseAgentRelease({commit:'c'.repeat(40),program:read('agent/platforms/odc/studio/bridge/client/Program.cs'),kinds:read('agent/agent/lib/kinds.mjs'),native:read('agent/native/Ssam.Agent/StudioKinds.cs'),bridgeProject:read('agent/platforms/odc/studio/bridge/Bridge.csproj')});
const example=JSON.parse(fs.readFileSync(path.join(here,'config.example.json'),'utf8'));
// The published packs of the example: thin bridges for Service Studio 11.55.94/.93/.92, none for 11.55.95 (the F1 case).
const config={bridgeMode:'ed25519-offers',agentPack:example.agentPack,agentPackByRuntime:example.agentPackByRuntime};
const net10=['v98','v101','v102','v107','v106','v108'],net8=['v98','v96','v48','v45','v102','v107','v97'];
const kernels=[{o11:'11.55.94',odc:'1.7.30',odcBridge:'v109',odcBridgeAccepted:net10},{o11:'11.55.93',odc:'1.7.29',odcBridge:'v108',odcBridgeAccepted:net8},{o11:'11.55.92',odc:'1.7.28',odcBridge:'v108',odcBridgeAccepted:net8}];
const pair={odc:'1.7.32',o11:'11.55.95',lanes:['odc','o11']};
const studios=(tfm={})=>({odc:{version:'1.7.32',fullVersion:'1.7.32.11065',tfm:tfm.odc??'net10.0'},o11:{version:'11.55.95',fullVersion:'11.55.95.65352',tfm:tfm.o11??'net10.0'}});
const served={odc:['1.7.32','1.7.30','1.7.29','1.7.28'],o11:['11.55.95','11.55.94','11.55.93','11.55.92']};

// A signed store laid out as the vigia stage (auto-runtime.mjs buildBridges): <lane>/<studioVersion>/<protocol>/ with the files,
// manifest.json and manifest.sig, and public-key.pem at the root. extra: manifest fields (a thumbprint, ...), sign: another key.
const LAYOUT={odc:p=>[['bridge/ODC3.Bridge.'+p+'.dll','owner'],['client/ODC3.Bridge.Client.dll','owner'],['client/Microsoft.Diagnostics.NETCore.Client.dll','microsoft'],['client/ODC3.Bridge.Client.runtimeconfig.json',null]],
 o11:()=>[['bridge/Anvil.Bridge.dll','owner'],['hook/Anvil.RuntimeHook.Agent.dll','owner']]};
function stage(t,entries,{keys=generateKeyPairSync('ed25519'),signWith}={}){
 const root=tmp(t);fs.writeFileSync(path.join(root,'public-key.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
 const offers=[];
 for(const {lane,studioVersion,protocol,runtime='net10.0',sequence=1,extra={},files}of entries){
  const dir=path.join(root,lane,studioVersion,protocol),list=[];
  for(const [rel,signer]of files??LAYOUT[lane](protocol)){
   const bytes=Buffer.from('fixture '+lane+' '+rel+' '+sequence);fs.mkdirSync(path.dirname(path.join(dir,rel)),{recursive:true});fs.writeFileSync(path.join(dir,rel),bytes);
   list.push({path:rel,sha256:sha(bytes),size:bytes.length,...(signer?{signer}:{})});
  }
  const m={schema:1,lane,studioVersion,runtime,protocol,sequence,createdAt:new Date().toISOString(),files:list,...extra};
  const raw=Buffer.from(JSON.stringify(m));fs.writeFileSync(path.join(dir,'manifest.json'),raw);fs.writeFileSync(path.join(dir,'manifest.sig'),sign(null,raw,(signWith??keys).privateKey));
  offers.push({lane,studioVersion,protocol,sequence});
 }
 return {root,offers,keys,store:createBridgeStore({root,publicKey:keys.publicKey}),dir:(lane,v,p)=>path.join(root,lane,v,p)};
}
const both=[{lane:'odc',studioVersion:'1.7.32',protocol:'v109'},{lane:'o11',studioVersion:'11.55.95',protocol:'d1'}];

test('bridge-store: a manifest without the Authenticode thumbprint is accepted when Ed25519 verifies and every executable has its signer class',t=>{
 const s=stage(t,[...both,{lane:'o11',studioVersion:'11.55.96',protocol:'d1',extra:{authenticodeThumbprint:null}},{lane:'o11',studioVersion:'11.55.97',protocol:'d1',extra:{authenticodeThumbprint:'b'.repeat(40)}}]);
 const key=s.keys.publicKey;
 assert.equal(verifyBridge(s.dir('o11','11.55.95','d1'),key).manifest.authenticodeThumbprint,undefined,'absent');
 assert.equal(verifyBridge(s.dir('odc','1.7.32','v109'),key).manifest.files.find(f=>f.path.startsWith('client/Microsoft.')).signer,'microsoft');
 assert.equal(verifyBridge(s.dir('o11','11.55.96','d1'),key).manifest.authenticodeThumbprint,null,'null');
 assert.equal(verifyBridge(s.dir('o11','11.55.97','d1'),key).manifest.authenticodeThumbprint,'b'.repeat(40),'the signed-offers manifests stay valid');
 assert.equal(s.store.offer('o11','11.55.95',['d1']).protocol,'d1');
 assert.equal(s.store.offer('odc','1.7.32',['v109']).protocol,'v109');
});
test('bridge-store: malformed thumbprints, unclassified or wrongly classed executables and another key are still refused',t=>{
 for(const extra of [{authenticodeThumbprint:''},{authenticodeThumbprint:'abc'},{authenticodeThumbprint:'b'.repeat(41)},{authenticodeThumbprint:42}]){
  const s=stage(t,[{lane:'o11',studioVersion:'11.55.95',protocol:'d1',extra}]);
  assert.throws(()=>verifyBridge(s.dir('o11','11.55.95','d1'),s.keys.publicKey),/identity is invalid/,JSON.stringify(extra));
  assert.equal(s.store.offer('o11','11.55.95',['d1']),null);
 }
 for(const files of [[['bridge/Anvil.Bridge.dll',null],['hook/Anvil.RuntimeHook.Agent.dll','owner']],[['bridge/Anvil.Bridge.dll','self'],['hook/Anvil.RuntimeHook.Agent.dll','owner']]]){
  const s=stage(t,[{lane:'o11',studioVersion:'11.55.95',protocol:'d1',files}]);
  assert.throws(()=>verifyBridge(s.dir('o11','11.55.95','d1'),s.keys.publicKey),/signer is invalid/);assert.equal(s.store.offer('o11','11.55.95',['d1']),null);
 }
 const forged=stage(t,[{lane:'o11',studioVersion:'11.55.95',protocol:'d1'}],{signWith:generateKeyPairSync('ed25519')});
 assert.throws(()=>verifyBridge(forged.dir('o11','11.55.95','d1'),forged.keys.publicKey),/signature is invalid/);assert.equal(forged.store.offer('o11','11.55.95',['d1']),null);
});

// The hellos the two agents send for this pair (agent.mjs helloCapabilities; native AgentChannel.cs): 0.2.8 with its pinned key,
// 0.2.7 with its empty anchor (bridgeOffer false, with its reason).
const hello028=()=>agentHello(config,release,studios(),{bridgeOffer:true});
const hello027=()=>({...agentHello(config,release,studios(),{bridgeOffer:false}),capabilities:{bridgeOffer:false,bridgeOfferReason:'This agent package was built without the bridge trust anchors (a test build); it uses only its bundled bridges.'}});
test('agent-hub: on the new pair a 0.2.8 hello is offered the Ed25519-only d1 bridge and is served once it is installed; a 0.2.7 hello is never offered',t=>{
 const s=stage(t,both),kernel={...offersKernel(config,pair,studios(),kernels,release,s.offers),servedVersions:served};
 assert.deepEqual(kernel.o11BridgeAccepted,['d1']);assert.ok(kernel.odcBridgeAccepted.includes('v109')||kernel.odcBridge==='v109');
 const h=hello028();assert.equal(h.capabilities.bridgeOffer,true);assert.equal(h.pack.o11BuiltFor,'11.55.94','the agent keeps its default thin bridge for a Service Studio it has no build for');
 const first=compatibility(h,kernel,['odc','o11'],{bridges:s.store});
 assert.equal(first.o11.bridgeOffer?.protocol,'d1');assert.equal(JSON.parse(first.o11.bridgeOffer.manifest).authenticodeThumbprint,undefined);
 assert.equal(first.odc.ok,true);assert.equal(first.odc.bridgeOffer,undefined,'its pack bridge serves the ODC lane: no ODC offer');
 const after=compatibility(installedHello(h,[s.offers[1]]),kernel,['odc','o11'],{bridges:s.store});
 assert.equal(after.o11.ok,true);assert.equal(after.o11.bridgeOffer,undefined);assert.equal(after.odc.ok,true);
 const old=compatibility(hello027(),kernel,['odc','o11'],{bridges:s.store});
 assert.equal(old.o11.bridgeOffer,undefined);assert.equal(old.odc.bridgeOffer,undefined);
 // F1 review M2: a 0.2.7 agent on the new pair is never served its default 11.55.94 thin bridge (built for another Service Studio),
 // while 11.55.94 is served as well as after it leaves the window: it is told to install app 0.2.8, never a dead end.
 assert.deepEqual(kernel.o11PackBuiltFor,['11.55.95']);
 for(const window of [served,{...served,o11:['11.55.95']}]){
  const r=compatibility(hello027(),{...kernel,servedVersions:window},['odc','o11'],{bridges:s.store}).o11;
  assert.equal(r.ok,false);assert.equal(r.code,'AGENT_PACK_MISMATCH');assert.equal(r.cause,'AGENT_UPDATE_REQUIRED');assert.match(r.message,/Install the current SSAM Agent \(app 0\.2\.8 or later\)/);assert.equal(r.bridgeOffer,undefined);
 }
 // An offer of another runtime is never made, and a hello refusing the sequence (failed report) is not offered it again.
 const net8=stage(t,[{lane:'o11',studioVersion:'11.55.95',protocol:'d1',runtime:'net8.0'}]);
 assert.equal(compatibility(h,kernel,['odc','o11'],{bridges:net8.store}).o11.bridgeOffer,undefined);
 assert.equal(compatibility({...h,bridges:[{lane:'o11',studioVersion:'11.55.95',protocol:'d1',sequence:1,status:'failed'}]},kernel,['odc','o11'],{bridges:s.store}).o11.bridgeOffer,undefined);
});

const gate=(s,extra={})=>offersGate({config,release,pair,studios:extra.studios??studios(),servedKernels:kernels,served:extra.served??served,offers:s.offers,bridges:s.store,...extra});
test('offersGate: a Service Studio the published packs have no thin bridge for is served by the signed d1 offer, checked offered then installed',t=>{
 assert.match(laneGap(config,release,'o11',studios().o11),/no thin bridge built for Service Studio 11\.55\.95/,'the server-only gate would wait here');
 const s=stage(t,both),g=gate(s);
 assert.deepEqual(g.gaps,[]);assert.deepEqual(g.offerLanes,['o11']);
 assert.deepEqual(g.kernel.o11BridgeAccepted,['d1']);assert.equal(g.kernel.o11,'11.55.95');assert.equal(g.kernel.odc,'1.7.32');
 assert.equal(g.offerHello.capabilities.bridgeOffer,true);assert.deepEqual(g.hello.bridges,[{lane:'o11',studioVersion:'11.55.95',protocol:'d1',sequence:1,status:'installed',reason:'INSTALLED'}]);
 assert.equal(g.legacyHello.capabilities.bridgeOffer,false);assert.deepEqual(g.legacy,{odc:{ok:true},o11:{ok:false,code:'AGENT_PACK_MISMATCH',cause:'AGENT_UPDATE_REQUIRED'}});
 // Once 11.55.94 leaves the window the 0.2.7 agents on 11.55.95 get the same answer (install 0.2.8); the pair still deploys.
 const later=gate(s,{served:{...served,o11:['11.55.95','11.55.93']}});assert.deepEqual(later.gaps,[]);assert.deepEqual(later.legacy.o11,{ok:false,code:'AGENT_PACK_MISMATCH',cause:'AGENT_UPDATE_REQUIRED'});
});
test('offersGate: no signed O11 offer (missing, another key, another sequence, another runtime) leaves the lane waiting; an ODC gap is never closed by an offer',t=>{
 const odcOnly=stage(t,[both[0]]);
 const a=gate(odcOnly);assert.equal(a.gaps.length,1);assert.equal(a.gaps[0].lane,'o11');assert.match(a.gaps[0].why,/refused \(AGENT_PACK_MISMATCH: The agent package's Service Studio bridge was built for 11\.55\.94, not for Service Studio 11\.55\.95.*no signed offer reaches it/);
 const forged=stage(t,both,{signWith:generateKeyPairSync('ed25519')});
 assert.equal(gate(forged).gaps[0]?.lane,'o11');
 const s=stage(t,[both[0],{...both[1],sequence:3}]);
 assert.match(gate({...s,offers:s.offers.map(o=>o.lane==='o11'?{...o,sequence:2}:o)}).gaps[0].why,/offered d1 sequence 3, not the bridge this round signed/);
 assert.equal(gate(stage(t,[both[0],{...both[1],runtime:'net8.0'}])).gaps[0]?.lane,'o11');
 // A new ODC runtime no published pack covers: the offer cannot reach a pack whose own bridge is accepted under the same name.
 const net12=gate(stage(t,[{...both[0],runtime:'net12.0'},both[1]]),{studios:studios({odc:'net12.0'})});
 assert.equal(net12.gaps[0].lane,'odc');assert.match(net12.gaps[0].why,/no published agent pack declares a bridge for ODC Studios on net12/);assert.equal(net12.kernel,undefined);
});
test('offersGate: a Service Studio the pack has its own build for needs no offer; the d1 offer stays accepted for agents that lack it',t=>{
 const own={...pair,o11:'11.55.94'},st={...studios(),o11:{version:'11.55.94',fullVersion:'11.55.94.65328',tfm:'net10.0'}};
 const s=stage(t,[both[0],{lane:'o11',studioVersion:'11.55.94',protocol:'d1'}]);
 const g=offersGate({config,release,pair:own,studios:st,servedKernels:kernels,served,offers:s.offers,bridges:s.store});
 assert.deepEqual(g.gaps,[]);assert.deepEqual(g.offerLanes,[]);assert.deepEqual(g.hello.bridges,[]);assert.deepEqual(g.kernel.o11BridgeAccepted,['d1']);
});

test('buildBridges in ed25519-offers: no Authenticode signing, signer classes by verification only, no thumbprint in the manifest, evidence outside the stage',async t=>{
 const dir=tmp(t),agent=path.join(dir,'agent-source'),runs=[];
 const bundle=path.join(dir,'bundle');fs.writeFileSync(bundle,'fixture');const pin=sha('fixture');
 const privateKey=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});
 const CLIENT=/const string Version = "(v\d+)"/.exec(read('server/platforms/odc/studio/bridge/client/Program.cs'))[1];
 let classify=target=>{const out=[];for(const sub of fs.readdirSync(target))for(const name of fs.readdirSync(path.join(target,sub)))if(/\.(dll|exe)$/.test(name))out.push({path:sub+'/'+name,signer:name.startsWith('Microsoft.')?'microsoft':'owner'});return {code:0,stdout:'WARNING: noise\n'+JSON.stringify(out)};};
 const builds=[];
 const runtime={executionSource:async()=>{},agentSource:async()=>agent,waitForDotnet:async()=>{},async run(cmd,args,options){
  runs.push({cmd:String(cmd),args:args.map(String),options});
  if(args.some(x=>String(x).endsWith('read-secrets.ps1')))return {stdout:JSON.stringify({coolifyToken:'memory',sshPrivateKey:Buffer.from('PRIVATE KEY').toString('base64'),manifestPrivateKey:privateKey,journalKey:Buffer.alloc(32,1).toString('base64')})};
  if(args.includes('-getProperty:TargetFramework'))return {stdout:args[1].includes('Anvil.RuntimeHook')?'net8.0':args[1].includes('Anvil.Bridge.Thin')?(args.includes('-p:TargetFramework=net10.0')?'net10.0':'net8.0'):'net10.0'};
  if(args.includes('-getProperty:TargetPath'))return {stdout:builds.at(-1).output};
  if(args[0]==='build'){
   const out=args[args.indexOf('-o')+1];fs.mkdirSync(out,{recursive:true});
   const name=args[1].endsWith('Client.csproj')?'ODC3.Bridge.Client.dll':args[1].includes('Anvil.RuntimeHook')?'Anvil.RuntimeHook.Agent.dll':args[1].includes('Anvil.Bridge.Thin')?'Anvil.Bridge.dll':`ODC3.Bridge.${CLIENT}.dll`;
   fs.writeFileSync(path.join(out,name),'unsigned owner build '+name);builds.push({output:path.join(out,name)});
   const assets=path.join(path.dirname(args[1]),'obj/project.assets.json');fs.mkdirSync(path.dirname(assets),{recursive:true});
   if(name==='ODC3.Bridge.Client.dll'){
    // A restored NuGet package: its dll lands beside the client byte for byte.
    const pkg=path.join(dir,'nuget','microsoft.diagnostics.netcore.client','0.2.731102','lib');fs.mkdirSync(pkg,{recursive:true});fs.writeFileSync(path.join(pkg,'Microsoft.Diagnostics.NETCore.Client.dll'),'microsoft signed bytes');
    fs.copyFileSync(path.join(pkg,'Microsoft.Diagnostics.NETCore.Client.dll'),path.join(out,'Microsoft.Diagnostics.NETCore.Client.dll'));
    fs.writeFileSync(assets,JSON.stringify({packageFolders:{[path.join(dir,'nuget')]:{}},libraries:{'Microsoft.Diagnostics.NETCore.Client/0.2.731102':{type:'package',path:'microsoft.diagnostics.netcore.client/0.2.731102'}}}));
    fs.writeFileSync(path.join(out,'ODC3.Bridge.Client.runtimeconfig.json'),JSON.stringify({runtimeOptions:{tfm:'net10.0'}}));fs.writeFileSync(path.join(out,'ODC3.Bridge.Client.pdb'),'symbols');
   }else fs.writeFileSync(assets,JSON.stringify({packageFolders:{},libraries:{}}));
   return {stdout:''};
  }
  if(args.some(a=>String(a).endsWith('classify-signers.ps1')))return classify(args[args.indexOf('-ArtifactDirectory')+1]);
  throw Error('unexpected command '+cmd+' '+args.join(' '));
 }};
 const fakeRoot=path.join(dir,'source');for(const rel of ['server/platforms/odc/studio/bridge/client/Program.cs','server/deploy/coolify/r1-kernels.json']){const dest=path.join(fakeRoot,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.resolve(here,'../../..',rel),dest);}
 const settings={automaticDeployment:{testOnly:true,coolify:{url:'http://127.0.0.1:1',resource:'fixture'},ssh:{host:'fixture',knownHosts:'fixture'},remote:{}}};
 const make=()=>createAutoRuntime({workspace:fakeRoot,tempRoot:dir,outDir:dir,configFile:path.join(dir,'config.json'),bridgeMode:'ed25519-offers',bridgeTrustKeySpkiSha256:spkiSha256(privateKey),bundlePins:{'odc-1.7.32':pin,'o11-11.55.95':pin},...settings},runtime);
 const bundles={odc:{lane:'odc',file:bundle,sha256:pin,version:'1.7.32',tfm:'net10.0',snapshot:'odc'},o11:{lane:'o11',file:bundle,sha256:pin,version:'11.55.95',tfm:'net10.0',snapshot:'o11'}};
 const attempt=path.join(dir,'attempt');fs.mkdirSync(attempt);
 const result=await make().buildBridges(pair,bundles,attempt);
 assert.equal(result.mode,'ed25519-offers');
 assert.deepEqual(runs.filter(r=>r.args.some(a=>/odc-runtime-signing|Set-AuthenticodeSignature|signtool/i.test(a))||/signtool/i.test(r.cmd)),[],'nothing is Authenticode-signed');
 const classified=runs.filter(r=>r.args.some(a=>a.endsWith('classify-signers.ps1')));assert.equal(classified.length,2);
 for(const r of classified){assert.ok(!r.args.some(a=>/^-(Vault|ConfigPath|TimestampServer|CertificateThumbprint)$/.test(a)),'verification reads no vault or certificate');assert.ok(!r.options?.secret);}
 const key=fs.readFileSync(path.join(result.stage,'public-key.pem'));
 for(const offer of result.offers){
  const target=path.join(result.stage,offer.lane,offer.studioVersion,offer.protocol),m=verifyBridge(target,key).manifest;
  assert.equal('authenticodeThumbprint' in m,false);assert.equal(m.runtime,'net10.0');
  assert.ok(m.files.filter(f=>/\.(dll|exe)$/.test(f.path)).every(f=>f.signer===(path.basename(f.path).startsWith('Microsoft.')?'microsoft':'owner')));
  assert.deepEqual(fs.readdirSync(target).filter(n=>n.endsWith('.json')).sort(),['manifest.json'],'no build evidence or authenticode.json in the served stage');
  assert.ok(!m.files.some(f=>f.path.endsWith('.pdb')));
 }
 assert.deepEqual(result.offers.map(o=>[o.lane,o.studioVersion,o.protocol]),[['odc','1.7.32',CLIENT],['o11','11.55.95','d1']]);
 assert.deepEqual(fs.readdirSync(path.join(attempt,'bridge-evidence')).sort(),[`o11-11.55.95-d1.json`,`odc-1.7.32-${CLIENT}.json`]);
 const evidence=JSON.parse(fs.readFileSync(path.join(attempt,'bridge-evidence',`odc-1.7.32-${CLIENT}.json`),'utf8'));
 assert.deepEqual(Object.keys(evidence.dependencies),['client/Microsoft.Diagnostics.NETCore.Client.dll']);
 // The offered store answers the 0.2.8 hello of the new Service Studio with the d1 offer.
 const store=createBridgeStore({root:result.stage,publicKey:key}),g=offersGate({config,release,pair,studios:studios(),servedKernels:kernels,served,offers:result.offers,bridges:store});
 assert.deepEqual(g.gaps,[]);assert.deepEqual(g.offerLanes,['o11']);
 // A classification that names no signer for an executable, refuses, or answers nothing stops the build; a revocation outage waits.
 classify=target=>({code:0,stdout:JSON.stringify([{path:'bridge/'+fs.readdirSync(path.join(target,'bridge'))[0],signer:'owner'}])});
 await assert.rejects(make().buildBridges(pair,bundles,attempt),/was not classified/);
 classify=()=>({code:1,stdout:'',stderr:'Unsupported dependency signer; report it to the integrator: client/X.dll\n'});
 await assert.rejects(make().buildBridges(pair,bundles,attempt),/classification failed: Unsupported dependency signer/);
 classify=()=>({code:0,stdout:'[{"path":"bridge/a.dll","signer":"self"}]'});
 await assert.rejects(make().buildBridges(pair,bundles,attempt),/classification is invalid/);
 classify=()=>({code:1,stdout:'{"ok":false,"code":"REVOCATION_UNAVAILABLE","environmental":true}'});
 await assert.rejects(make().buildBridges(pair,bundles,attempt),e=>e.code==='REVOCATION_UNAVAILABLE'&&e.environmental===true);
 // The vault needs no thumbprint in this mode (secrets above have none); server-only refuses to build at all.
 await assert.rejects(createAutoRuntime({workspace:fakeRoot,tempRoot:dir,outDir:dir,...settings},runtime).buildBridges(pair,bundles,attempt),/only in the signed-offers and ed25519-offers bridge modes/);
});

test('classify-signers.ps1 verifies only: owner outputs as recorded, Microsoft dependencies by NuGet bytes and a pinned Microsoft root',{skip:process.platform!=='win32'&&'PowerShell'},t=>{
 const script=fs.readFileSync(path.join(here,'classify-signers.ps1'),'utf8');
 for(const word of [/Set-AuthenticodeSignature/i,/Read-VigiaVault|vault\.ps1|secrets/i,/Cert:\\/i,/signtool/i,/Remove-Item|Set-Content|Out-File|WriteAllText/i])assert.doesNotMatch(script,word);
 const dir=tmp(t),target=path.join(dir,'t'),nuget=path.join(dir,'n');fs.mkdirSync(path.join(target,'client'),{recursive:true});fs.mkdirSync(path.join(target,'bridge'));fs.mkdirSync(nuget);
 const write=(rel,bytes)=>{fs.writeFileSync(path.join(target,rel),bytes);return sha(Buffer.from(bytes));};
 const owned={'bridge/ODC3.Bridge.v109.dll':write('bridge/ODC3.Bridge.v109.dll','owner bridge'),'client/ODC3.Bridge.Client.dll':write('client/ODC3.Bridge.Client.dll','owner client')};
 const run=evidence=>{const file=path.join(dir,'evidence-'+Math.random().toString(16).slice(2)+'.json');fs.writeFileSync(file,JSON.stringify(evidence));
  const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'classify-signers.ps1'),'-ArtifactDirectory',target,'-BuildEvidence',file],{encoding:'utf8',windowsHide:true,timeout:180000});
  return {code:r.status,out:(r.stdout??'')+(r.stderr??''),stdout:r.stdout??''};};
 const ok=run({owned,dependencies:{}});assert.equal(ok.code,0,ok.out);
 assert.deepEqual(JSON.parse(ok.stdout.trim().split(/\r?\n/).pop()),[{path:'bridge/ODC3.Bridge.v109.dll',signer:'owner'},{path:'client/ODC3.Bridge.Client.dll',signer:'owner'}]);
 assert.match(run({owned:{...owned,'client/ODC3.Bridge.Client.dll':'0'.repeat(64)},dependencies:{}}).out,/Build output changed after it was recorded/);
 // An unsigned dependency that matches its restored package, and one whose bytes match no package.
 const dep=write('client/Fake.Dependency.dll','unsigned dependency');fs.writeFileSync(path.join(nuget,'Fake.Dependency.dll'),'unsigned dependency');
 assert.match(run({owned,dependencies:{'client/Fake.Dependency.dll':{sha256:dep,source:path.join(nuget,'Fake.Dependency.dll')}}}).out,/Dependency is not signed: client\/Fake\.Dependency\.dll/);
 assert.match(run({owned,dependencies:{}}).out,/Dependency differs from restored NuGet bytes: client\/Fake\.Dependency\.dll/);
 fs.rmSync(path.join(target,'client/Fake.Dependency.dll'));
 // An owner entry point that is not a recorded build output is never classified microsoft.
 write('client/ODC3.Bridge.Extra.dll','stray');assert.match(run({owned,dependencies:{}}).out,/An owner entry point is not a recorded build output: client\/ODC3\.Bridge\.Extra\.dll/);fs.rmSync(path.join(target,'client/ODC3.Bridge.Extra.dll'));
 // A real Microsoft-signed dependency (the .NET runtime's), verified to the pinned Microsoft root (online revocation).
 const shared='C:/Program Files/dotnet/shared/Microsoft.NETCore.App';const versions=fs.existsSync(shared)?fs.readdirSync(shared):[];
 const real=versions.map(v=>path.join(shared,v,'Microsoft.Win32.Primitives.dll')).find(f=>fs.existsSync(f));
 if(!real)return t.diagnostic('no signed .NET runtime DLL on this machine: the Microsoft case was not run');
 fs.copyFileSync(real,path.join(nuget,'Microsoft.Win32.Primitives.dll'));fs.copyFileSync(real,path.join(target,'client','Microsoft.Win32.Primitives.dll'));
 const digest=sha(fs.readFileSync(real)),r=run({owned,dependencies:{'client/Microsoft.Win32.Primitives.dll':{sha256:digest,source:path.join(nuget,'Microsoft.Win32.Primitives.dll')}}});
 if(r.out.includes('REVOCATION_UNAVAILABLE'))return t.diagnostic('revocation service unreachable: the Microsoft case was not run');
 assert.equal(r.code,0,r.out);
 assert.deepEqual(JSON.parse(r.stdout.trim().split(/\r?\n/).pop()).find(x=>x.path==='client/Microsoft.Win32.Primitives.dll'),{path:'client/Microsoft.Win32.Primitives.dll',signer:'microsoft'});
});
test('the Microsoft root pins of the vigia are the agent\'s (BRIDGE_MICROSOFT_ROOTS)',async t=>{
 const pins=JSON.parse(fs.readFileSync(path.join(here,'publisher-pins.json'),'utf8'));
 assert.deepEqual(pins.microsoftRoots,['8F43288AD272F3103B6FB1428485EA3014C0BCFE']);
 const trust=path.resolve(here,'../../../agent/agent/lib/bridge-trust.mjs');
 if(!fs.existsSync(trust))return t.skip('agent/ is not in this checkout');
 assert.deepEqual(pins.microsoftRootsSha256,(await import(pathToFileURL(trust).href)).BRIDGE_MICROSOFT_ROOTS);
});

test('R7: agent code is built or read in ed25519-offers only from an owner-signed agentReleaseCommit on an owner-signed agentReleaseRef',async()=>{
 const commit='a'.repeat(40),tip='b'.repeat(40),key='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOwner owner';
 const fake=({ancestor=0,head=tip,signed=[commit,tip]}={})=>({calls:[],git(args){this.calls.push(args);if(args[0]==='merge-base')return {code:ancestor,stdout:''};if(args[0]==='rev-parse')return {code:head?0:1,stdout:head?head+'\n':''};throw Error(args.join(' '));},ownerSigned:async c=>signed.includes(c)});
 const call=(config,f)=>verifySignedAgentRelease({agentReleaseCommit:commit,agentReleaseRef:'agent/release-0.2.8',ownerSigningPublicKey:key,...config},{git:(a,o)=>f.git(a,o),ownerSigned:f.ownerSigned});
 assert.deepEqual(await call({},fake()),{commit,tip});
 await assert.rejects(call({ownerSigningPublicKey:undefined,acceptUnsignedMain:true},fake()),e=>e.code==='AGENT_RELEASE_UNSIGNED'&&!e.environmental&&/acceptUnsignedMain does not cover agent code/.test(e.message));
 await assert.rejects(call({},fake({signed:[tip]})),e=>e.code==='AGENT_RELEASE_UNSIGNED'&&/agentReleaseCommit aaaaaaa has no valid owner signature/.test(e.message));
 await assert.rejects(call({},fake({signed:[commit]})),e=>e.code==='AGENT_RELEASE_UNSIGNED'&&/The tip of agent\/release-0\.2\.8 \(bbbbbbb\) has no valid owner signature/.test(e.message));
 await assert.rejects(call({},fake({ancestor:1})),/outside the approved release line/);
 await assert.rejects(call({},fake({head:null})),/cannot be read/);
 await assert.rejects(call({agentReleaseRef:'main'},fake()),e=>e.code==='AGENT_RELEASE_REQUIRED');
 assert.deepEqual(await call({},fake({head:commit,signed:[commit]})),{commit,tip:commit},'a release line whose tip is the pinned commit');
 // The real runtime calls it before every agent build and, in ed25519-offers, before reading the release; server-only reads as before.
 const source=fs.readFileSync(path.join(here,'runtime.mjs'),'utf8');
 assert.match(source,/runtime\.agentSource=async\(\)=>\{\n\s*await runtime\.executionSource\(\);const commit=config\.agentReleaseCommit;\n\s*await verifySignedAgentRelease\(config,\{git,ownerSigned\}\);/);
 assert.match(source,/if\(isEd25519Offers\(config\)\)await verifySignedAgentRelease\(config,\{git,ownerSigned\}\);/);
 assert.match(source,/async function ownerSigned\(commit\)\{[^]*?'verify-commit',commit\],\{allowFailure:true\}\)\)\.code===0;/);
 assert.equal(isEd25519Offers({bridgeMode:'ed25519-offers'}),true);assert.equal(isEd25519Offers({}),false);
});

test('the automatic plan of ed25519-offers compiles and offers, never Authenticode-signs',()=>{
 const plan=automaticPlan('ed25519-offers');assert.equal(plan.length,AUTOMATIC_PLAN.length);assert.ok(plan.includes(ED25519_OFFERS_STEP));
 assert.match(ED25519_OFFERS_STEP,/never Authenticode-sign/);assert.ok(!plan.some(s=>/Compile pinned client sources, verify signatures/.test(s)));
});

// The post-deployment check (check-backend.mjs) run as the backend runs it, with its imports and the backend's HTTP answered by
// this checkout's agent-hub.mjs compatibility over a signed store (fetch, the token store and the kernel file are fakes).
async function runCheck(expected,{kernel,bridges,served:list,answer=compatibility}){
 const src=fs.readFileSync(path.join(here,'check-backend.mjs'),'utf8').split('\n').filter(l=>!/^import /.test(l)&&!/^const store=await openTokenStore/.test(l)).join('\n');
 const posted=[],out=[];
 const fetch=async(url,init={})=>{
  const route=new URL(url).pathname,body=init.body?JSON.parse(init.body):null;
  if(route==='/health')return new Response('{}');
  if(route==='/agent/v1/hello'){posted.push(body);return new Response(JSON.stringify({ok:true,compatible:answer(body,{...kernel,servedVersions:list},['odc','o11'],{bridges})}));}
  if(route.startsWith('/agent/bridges/')){const [,,,lane,v,p,digest]=route.split('/');const file=bridges.file(lane,v,p,digest);return file?new Response(fs.readFileSync(file)):new Response('',{status:404});}
  if(route==='/mcp'){if(body.method==='initialize')return new Response(JSON.stringify({result:{}}),{headers:{'mcp-session-id':'s'}});if(body.method==='tools/list')return new Response(JSON.stringify({result:{tools:[{name:'a',description:'b',inputSchema:{}}]}}));return new Response('');}
  return new Response('',{status:404});
 };
 const store={issue:async()=>({id:'x',agentCredential:'ssam_agent_x',token:'t'}),revoke:async()=>{},list:async()=>[]};
 const fakeFs={readFileSync:file=>{if(String(file).endsWith('/kernel.json'))return JSON.stringify(kernel);throw Error('unexpected read '+file);}};
 const AsyncFunction=(async()=>{}).constructor;
 await new AsyncFunction('expected','fs','path','createHash','store','toolListingBytes','readStudioVersions','fetch','console','process',src)(
  {budget:{tools:1,totalBytes:10**6,core:[]},...expected},fakeFs,path,createHash,store,toolListingBytes,()=>null,fetch,{log:x=>out.push(x)},{env:{}});
 return {posted,receipt:JSON.parse(out.at(-1))};
}
test('check-backend (post-deployment): the 0.2.8 hello of the published pack must receive the d1 offer and be served with it installed; 0.2.7 gets no offer',async t=>{
 const s=stage(t,both),g=gate(s),kernel=g.kernel,key='11.55.95|1.7.32';
 const expected={offers:s.offers,packHellos:{[key]:g.hello},offerHellos:{[key]:g.offerHello},offerLanes:{[key]:g.offerLanes},legacyHellos:{[key]:g.legacyHello}};
 const ok=await runCheck(expected,{kernel,bridges:s.store,served});
 assert.equal(ok.receipt.ok,true);assert.equal(ok.receipt.presented,true);
 assert.deepEqual(ok.posted.map(h=>h.instance).slice(0,4),['vigia-verification','vigia-published-pack-offers','vigia-published-pack-legacy','vigia-published-pack-offers']);
 // The same check against a pair whose store has no d1 (the offer was lost) or a kernel without d1 fails.
 await assert.rejects(runCheck(expected,{kernel,bridges:stage(t,[both[0]]).store,served}),/received no signed bridge offer/);
 await assert.rejects(runCheck(expected,{kernel:{...kernel,o11BridgeAccepted:[]},bridges:s.store,served}),/received no signed bridge offer/);
 // A store that would offer to a hello without bridgeOffer is caught (the hub never does; a changed hub would).
 const leaky={offer:(...a)=>s.store.offer(...a),file:(...a)=>s.store.file(...a)};
 await assert.rejects(runCheck({...expected,legacyHellos:{[key]:{...g.legacyHello,capabilities:{bridgeOffer:true}}}},{kernel,bridges:leaky,served}),/offered to an agent without bridgeOffer/);
 // server-only receipts keep their rule: without the offer hellos, a pack hello without its own 11.55.95 build fails as before.
 await assert.rejects(runCheck({packHellos:{[key]:g.hello}},{kernel,bridges:s.store,served}),/no thin bridge built for this Service Studio/);
});

// ---- F1 review round 2 (C:\t\r5\f1-offers\REVISAO-F1.md): M1, M2, M3, B1-B6.

// A compiled-bridge fixture for buildBridges: fake dotnet builds (owner outputs, one restored Microsoft NuGet dll beside the ODC
// client), a fake classification (owner for the recorded outputs, microsoft for the NuGet dll), a fake vault with one Ed25519 key,
// a fake signed main HEAD (the ODC source) and a reviewed agentReleaseCommit (the O11 source).
function bridgeFixture(t,{agentReleaseCommit='a'.repeat(40),head='f'.repeat(40)}={}){
 const dir=tmp(t),agent=path.join(dir,'agent-source'),runs=[],builds=[];
 const bundle=path.join(dir,'bundle');fs.writeFileSync(bundle,'fixture');
 const privateKey=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});
 const CLIENT=/const string Version = "(v\d+)"/.exec(read('server/platforms/odc/studio/bridge/client/Program.cs'))[1];
 const f={dir,runs,privateKey,CLIENT,head,afterBuild:null,afterClassify:null,
  classify:target=>{const out=[];for(const sub of fs.readdirSync(target))for(const name of fs.readdirSync(path.join(target,sub)))if(/\.(dll|exe)$/.test(name))out.push({path:sub+'/'+name,signer:name.startsWith('Microsoft.')?'microsoft':'owner'});return {code:0,stdout:JSON.stringify(out)};}};
 f.runtime={executionSource:async()=>{},agentSource:async()=>agent,waitForDotnet:async()=>{},fullHead:async()=>f.head,log:()=>{},async run(cmd,args,options){
  runs.push({cmd:String(cmd),args:args.map(String),options});
  if(args.some(x=>String(x).endsWith('read-secrets.ps1')))return {stdout:JSON.stringify({coolifyToken:'memory',sshPrivateKey:Buffer.from('PRIVATE KEY').toString('base64'),manifestPrivateKey:privateKey,journalKey:Buffer.alloc(32,1).toString('base64')})};
  if(args.includes('-getProperty:TargetFramework'))return {stdout:args[1].includes('Anvil.RuntimeHook')?'net8.0':'net10.0'};
  if(args.includes('-getProperty:TargetPath'))return {stdout:builds.at(-1).output};
  if(args[0]==='build'){
   const out=args[args.indexOf('-o')+1];fs.mkdirSync(out,{recursive:true});
   const name=args[1].endsWith('Client.csproj')?'ODC3.Bridge.Client.dll':args[1].includes('Anvil.RuntimeHook')?'Anvil.RuntimeHook.Agent.dll':args[1].includes('Anvil.Bridge.Thin')?'Anvil.Bridge.dll':`ODC3.Bridge.${CLIENT}.dll`;
   // Every build gives other bytes (as the real non-reproducible builds do).
   fs.writeFileSync(path.join(out,name),'unsigned owner build '+name+' '+runs.length);builds.push({output:path.join(out,name)});
   const assets=path.join(path.dirname(args[1]),'obj/project.assets.json');fs.mkdirSync(path.dirname(assets),{recursive:true});
   if(name==='ODC3.Bridge.Client.dll'){
    const pkg=path.join(dir,'nuget','microsoft.diagnostics.netcore.client','0.2.731102','lib');fs.mkdirSync(pkg,{recursive:true});fs.writeFileSync(path.join(pkg,'Microsoft.Diagnostics.NETCore.Client.dll'),'microsoft signed bytes');
    fs.copyFileSync(path.join(pkg,'Microsoft.Diagnostics.NETCore.Client.dll'),path.join(out,'Microsoft.Diagnostics.NETCore.Client.dll'));
    fs.writeFileSync(assets,JSON.stringify({packageFolders:{[path.join(dir,'nuget')]:{}},libraries:{'Microsoft.Diagnostics.NETCore.Client/0.2.731102':{type:'package',path:'microsoft.diagnostics.netcore.client/0.2.731102'}}}));
    fs.writeFileSync(path.join(out,'ODC3.Bridge.Client.runtimeconfig.json'),JSON.stringify({runtimeOptions:{tfm:'net10.0'}}));
   }else fs.writeFileSync(assets,JSON.stringify({packageFolders:{},libraries:{}}));
   f.afterBuild?.(out,name);
   return {stdout:''};
  }
  if(args.some(a=>String(a).endsWith('classify-signers.ps1'))){const target=args[args.indexOf('-ArtifactDirectory')+1],r=f.classify(target);f.afterClassify?.(target);return r;}
  throw Error('unexpected command '+cmd+' '+args.join(' '));
 }};
 const fakeRoot=path.join(dir,'source');for(const rel of ['server/platforms/odc/studio/bridge/client/Program.cs','server/deploy/coolify/r1-kernels.json']){const dest=path.join(fakeRoot,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.resolve(here,'../../..',rel),dest);}
 f.root=fakeRoot;f.settings={automaticDeployment:{testOnly:true,coolify:{url:'http://127.0.0.1:1',resource:'fixture'},ssh:{host:'fixture',knownHosts:'fixture'},remote:{}}};
 f.bundles=(odcContent='fixture')=>{const odcFile=path.join(dir,'bundle-odc-'+sha(odcContent).slice(0,8));fs.writeFileSync(odcFile,odcContent);
  return {odc:{lane:'odc',file:odcFile,sha256:sha(odcContent),version:'1.7.32',tfm:'net10.0',snapshot:'odc'},o11:{lane:'o11',file:bundle,sha256:sha('fixture'),version:'11.55.95',tfm:'net10.0',snapshot:'o11'}};};
 f.make=(bundles,extra={})=>createAutoRuntime({workspace:fakeRoot,tempRoot:dir,outDir:dir,configFile:path.join(dir,'config.json'),bridgeMode:'ed25519-offers',bridgeTrustKeySpkiSha256:spkiSha256(privateKey),agentReleaseCommit,
  bundlePins:Object.fromEntries(Object.values(bundles).map(b=>[`${b.lane}-${b.version}`,b.sha256])),...f.settings,...extra},f.runtime);
 f.attempt=()=>{const a=path.join(dir,'attempt-'+Math.random().toString(16).slice(2));fs.mkdirSync(a);return a;};
 f.builds=()=>runs.filter(r=>r.args[0]==='build').length;
 return f;
}

test('M1: the vault manifest key must be the key app 0.2.8 pins (bridgeTrustKeySpkiSha256); another key or no pin signs nothing',async t=>{
 assert.equal(example.bridgeTrustKeySpkiSha256,'2ce611d0de3b195c60a680df1e6c3af432b3c6aaa2a54f04b06f438366ead7f0','the pin of the key 0.2.8 was built with');
 const k=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});
 assert.equal(spkiSha256(k),sha(createPublicKey(k).export({type:'spki',format:'der'})),'the SHA-256 of the public SPKI DER');
 assert.equal(assertTrustKey({bridgeTrustKeySpkiSha256:spkiSha256(k)},k),spkiSha256(k));
 assert.throws(()=>assertTrustKey({bridgeTrustKeySpkiSha256:example.bridgeTrustKeySpkiSha256},k),e=>e.code==='BRIDGE_TRUST_KEY_MISMATCH'&&!e.message.includes('PRIVATE KEY')&&!e.message.includes(spkiSha256(k)));
 for(const pin of [undefined,null,'',spkiSha256(k).toUpperCase(),spkiSha256(k).slice(1),42])assert.throws(()=>assertTrustKey({bridgeTrustKeySpkiSha256:pin},k),e=>e.code==='BRIDGE_TRUST_KEY_UNPINNED',String(pin));
 // buildBridges with a vault key that is not the pinned one: refused before any compiler, classification or signature.
 const f=bridgeFixture(t),bundles=f.bundles();
 await assert.rejects(f.make(bundles,{bridgeTrustKeySpkiSha256:example.bridgeTrustKeySpkiSha256}).buildBridges(pair,bundles,f.attempt()),e=>e.code==='BRIDGE_TRUST_KEY_MISMATCH');
 await assert.rejects(f.make(bundles,{bridgeTrustKeySpkiSha256:undefined}).buildBridges(pair,bundles,f.attempt()),e=>e.code==='BRIDGE_TRUST_KEY_UNPINNED');
 assert.equal(f.builds(),0);assert.ok(!f.runs.some(r=>r.args.some(a=>a.endsWith('classify-signers.ps1'))));
 // server-only signs nothing: no pin needed to read the vault.
 const so=createAutoRuntime({workspace:f.root,tempRoot:f.dir,outDir:f.dir,...f.settings},f.runtime);
 assert.ok((await so.secrets()).manifestPrivateKey);
});

test('M2: an agent that takes no offer is served on 11.55.95 only by its own or a proven build; 0.2.8 gets the offer, never ok on a foreign thin bridge',t=>{
 const s=stage(t,both),kernel={...offersKernel(config,pair,studios(),kernels,release,s.offers),servedVersions:served};
 const ask=(h,k=kernel,bridges=s.store)=>compatibility(h,k,['odc','o11'],{bridges}).o11;
 // 0.2.8 whose pack has no 11.55.95 build: BRIDGE_UPDATE_REQUIRED with the offer (it installs it and reconnects), never ok:true.
 const first=ask(hello028());assert.equal(first.ok,false);assert.equal(first.code,'BRIDGE_UPDATE_REQUIRED');assert.equal(first.bridgeOffer.protocol,'d1');
 // 0.2.8 whose install failed or was refused (the store no longer offers that sequence): refused with what happened, no offer.
 for(const status of ['failed','refused']){
  const r=ask({...hello028(),bridges:[{lane:'o11',studioVersion:'11.55.95',protocol:'d1',sequence:1,status,reason:'LOAD_FAILED'}]});
  assert.equal(r.ok,false,status);assert.equal(r.cause,'BRIDGE_NOT_INSTALLED',status);assert.equal(r.bridgeOffer,undefined,status);assert.match(r.message,/Restart Service Studio to retry/);
 }
 // 0.2.8 with no store offer at all (none published for this Studio): the same refusal.
 assert.equal(ask(hello028(),kernel,stage(t,[both[0]]).store).cause,'BRIDGE_NOT_INSTALLED');
 // A macOS agent (bridgeOffer false): refused with the pack it needs; 0.2.7: install app 0.2.8.
 const h27=hello027(),mac={...h27,agent:{...h27.agent,platform:'darwin'}};
 const m=ask(mac);assert.equal(m.ok,false);assert.equal(m.cause,'BRIDGE_PACK_REQUIRED');assert.match(m.message,/macOS/);assert.equal(m.bridgeOffer,undefined);
 assert.equal(ask(hello027()).cause,'AGENT_UPDATE_REQUIRED');
 // A pack with its own 11.55.95 build (any agent) is served; so is a build the owner proved for 11.55.95 (o11BridgeProven).
 assert.equal(ask({...h27,pack:{...h27.pack,o11BuiltFor:'11.55.95'}}).ok,true);
 const proof={studioVersion:'11.55.95',build:'11.55.94',packCommit:'c'.repeat(40),provenAt:'2026-11-01T10:00:00Z',evidence:'C:/ssam-priv/vigia/proofs/p.json',sha256:'e'.repeat(64),size:10};
 const provenKernel={...offersKernel({...config,o11BridgeProven:{'11.55.95':proof}},pair,studios(),kernels,release,s.offers),servedVersions:served};
 assert.deepEqual(provenKernel.o11PackBuiltFor,['11.55.95','11.55.94']);
 assert.equal(ask(hello027(),provenKernel).ok,true,'the proven 11.55.94 build serves 11.55.95 to the agents that take no offer');
 assert.equal(ask(mac,provenKernel).ok,true,'and to macOS');
 // A proof without verified evidence (no sha256) or for another Studio is no proof.
 assert.deepEqual(offersKernel({...config,o11BridgeProven:{'11.55.95':{...proof,sha256:undefined}}},pair,studios(),kernels,release,s.offers).o11PackBuiltFor,['11.55.95']);
 assert.deepEqual(offersKernel({...config,o11BridgeProven:{'11.55.95':{...proof,studioVersion:'11.55.96'}}},pair,studios(),kernels,release,s.offers).o11PackBuiltFor,['11.55.95']);
 // A kernel without o11PackBuiltFor (server-only, the live r44 pairs) answers as before.
 const {o11PackBuiltFor,...plain}=kernel;assert.ok(o11PackBuiltFor);assert.equal(ask(hello027(),plain).ok,true);
 // Another Service Studio of the window is not judged by this kernel's list.
 const other={...h27,studios:{...h27.studios,o11:{...h27.studios.o11,installed:{...h27.studios.o11.installed,version:'11.55.94.65328'}}}};
 assert.notEqual(ask(other).cause,'AGENT_UPDATE_REQUIRED');
});

test('M2 check-backend: after the deployment, a hello without bridgeOffer served on a foreign thin bridge fails the check',async t=>{
 const s=stage(t,both),g=gate(s),key='11.55.95|1.7.32';
 const expected={offers:{[key]:s.offers},packHellos:{[key]:g.hello},offerHellos:{[key]:g.offerHello},offerLanes:{[key]:g.offerLanes},legacyHellos:{[key]:g.legacyHello}};
 assert.equal((await runCheck(expected,{kernel:g.kernel,bridges:s.store,served})).receipt.ok,true);
 // An image whose hub ignores o11PackBuiltFor (the F1 hub) answers ok to 0.2.7 on 11.55.94's thin bridge: the check fails.
 const lax=(body,k,lanes,o)=>compatibility(body,{...k,o11PackBuiltFor:undefined},lanes,o);
 await assert.rejects(runCheck(expected,{kernel:g.kernel,bridges:s.store,served,answer:lax}),/An agent without bridgeOffer was served a thin bridge not built for this Service Studio/);
});

test('M3 hub: an agent holding a later sequence is not re-offered an older pair\'s; an older installed one is upgraded; a fallback still serves',t=>{
 const s=stage(t,both),kernel={...offersKernel(config,pair,studios(),kernels,release,s.offers),servedVersions:served};
 const ask=(reports,store=s.store)=>compatibility({...hello028(),bridges:reports},kernel,['odc','o11'],{bridges:store}).o11;
 const report=(sequence,status='active')=>({lane:'o11',studioVersion:'11.55.95',protocol:'d1',sequence,status,reason:status.toUpperCase()});
 // The store (an older pair) offers d1#1; the agent installed d1#2 from a newer pair: served, nothing offered (no replay loop).
 for(const status of ['active','installed']){const r=ask([report(2,status)]);assert.equal(r.ok,true,status);assert.equal(r.bridgeOffer,undefined,status);}
 assert.equal(ask([report(1)]).ok,true);assert.equal(ask([report(1)]).bridgeOffer,undefined);
 // A newer pair's store offers d1#3 to an agent holding d1#2: it keeps working (ok) and is offered the newer sequence.
 const newer=stage(t,[both[0],{...both[1],sequence:3}]);
 const up=ask([report(2)],newer.store);assert.equal(up.ok,true);assert.equal(JSON.parse(up.bridgeOffer.manifest).sequence,3);
 // d1#3 failed to load and the agent fell back to d1#2 (installed): #3 is not offered again and the lane is still served.
 const fell=ask([report(3,'failed'),report(2,'installed')],newer.store);assert.equal(fell.ok,true);assert.equal(fell.bridgeOffer,undefined);
 // A report of another Studio, or from an agent that takes no offer, counts for nothing.
 assert.equal(ask([{...report(2),studioVersion:'11.55.94'}]).code,'BRIDGE_UPDATE_REQUIRED');
 assert.equal(compatibility({...hello027(),bridges:[report(2)]},kernel,['odc','o11'],{bridges:s.store}).o11.cause,'AGENT_UPDATE_REQUIRED');
});

test('M3 vigia: a lane whose inputs did not change is staged with the same signed manifest and sequence, never re-signed n+1',async t=>{
 const f=bridgeFixture(t),bundles=f.bundles();
 const manifests=r=>Object.fromEntries(r.offers.map(o=>[o.lane,fs.readFileSync(path.join(r.stage,o.lane,o.studioVersion,o.protocol,'manifest.json'),'utf8')]));
 const first=await f.make(bundles).buildBridges(pair,bundles,f.attempt());
 assert.deepEqual(first.reused,[]);assert.deepEqual(first.offers.map(o=>o.sequence),[1,1]);const built=f.builds();assert.equal(built,4);
 // The next round (a new process, the same private folder): nothing compiled, the same manifests and sequences staged.
 const second=await f.make(bundles).buildBridges(pair,bundles,f.attempt());
 assert.deepEqual(second.reused,['odc','o11']);assert.equal(f.builds(),built,'no dotnet build');assert.deepEqual(second.offers,first.offers);assert.deepEqual(manifests(second),manifests(first));
 const key=fs.readFileSync(path.join(second.stage,'public-key.pem'));for(const o of second.offers)verifyBridge(path.join(second.stage,o.lane,o.studioVersion,o.protocol),key);
 // A pair that keeps 11.55.95 with another ODC bundle: the O11 lane is reused (the same d1#1 as the older pair), ODC is signed #2.
 const odc2=f.bundles('other odc');
 const third=await f.make(odc2).buildBridges(pair,odc2,f.attempt());
 assert.deepEqual(third.reused,['o11']);assert.deepEqual(third.offers.map(o=>[o.lane,o.sequence]),[['odc',2],['o11',1]]);
 // Another reviewed agent release (the O11 source): a new O11 sequence (the hub treats it as later than the older pair's).
 const fourth=await f.make(odc2,{agentReleaseCommit:'b'.repeat(40)}).buildBridges(pair,odc2,f.attempt());
 assert.deepEqual(fourth.reused,['odc']);assert.deepEqual(fourth.offers.map(o=>[o.lane,o.sequence]),[['odc',2],['o11',2]]);
 // Another signed main (the ODC source): ODC built and signed again.
 f.head='e'.repeat(40);
 const fifth=await f.make(odc2,{agentReleaseCommit:'b'.repeat(40)}).buildBridges(pair,odc2,f.attempt());
 assert.deepEqual(fifth.reused,['o11']);assert.deepEqual(fifth.offers.map(o=>[o.lane,o.sequence]),[['odc',3],['o11',2]]);
 // A kept copy that was changed is never served: built and signed again.
 const kept=path.join(f.dir,'bridges-signed','o11','11.55.95','d1');
 fs.appendFileSync(path.join(kept,'signed','bridge','Anvil.Bridge.dll'),'x');
 const sixth=await f.make(odc2,{agentReleaseCommit:'b'.repeat(40)}).buildBridges(pair,odc2,f.attempt());
 assert.deepEqual(sixth.reused,['odc']);assert.equal(sixth.offers.find(o=>o.lane==='o11').sequence,3);
 // reuseSigned itself: an unlisted file, a sequence that is no longer the newest, other inputs, another key.
 const inputs=JSON.parse(fs.readFileSync(path.join(kept,'inputs.json'),'utf8'));
 assert.ok(reuseSigned(kept,inputs,key,3));
 fs.writeFileSync(path.join(kept,'signed','bridge','extra.json'),'{}');assert.equal(reuseSigned(kept,inputs,key,3),null,'an unlisted file');fs.rmSync(path.join(kept,'signed','bridge','extra.json'));
 assert.equal(reuseSigned(kept,inputs,key,4),null,'not the newest sequence');
 assert.equal(reuseSigned(kept,{...inputs,key:'0'.repeat(64)},key,3),null,'other inputs');
 assert.equal(reuseSigned(kept,inputs,generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}),3),null,'another key');
 // Without a reviewed source (no agentReleaseCommit, no readable main) nothing is reused: every round signs n+1, as before.
 const g=bridgeFixture(t,{agentReleaseCommit:null}),gb=g.bundles();g.runtime.fullHead=undefined;
 await g.make(gb).buildBridges(pair,gb,g.attempt());const again=await g.make(gb).buildBridges(pair,gb,g.attempt());
 assert.deepEqual(again.reused,[]);assert.deepEqual(again.offers.map(o=>o.sequence),[2,2]);
});

test('B4 and B6: bytes changed after the classification, or a subfolder in the build output, stop the build with their cause',async t=>{
 const f=bridgeFixture(t),bundles=f.bundles();
 f.afterClassify=target=>{const folder=path.join(target,'bridge'),dll=fs.readdirSync(folder).find(n=>n.endsWith('.dll'));fs.writeFileSync(path.join(folder,dll),'swapped after classification');};
 await assert.rejects(f.make(bundles).buildBridges(pair,bundles,f.attempt()),/A bridge executable changed after its signer was classified: bridge\/ODC3\.Bridge\./);
 f.afterClassify=target=>{if(fs.existsSync(path.join(target,'client')))fs.writeFileSync(path.join(target,'client','Microsoft.Diagnostics.NETCore.Client.dll'),'other microsoft bytes');};
 await assert.rejects(f.make(bundles).buildBridges(pair,bundles,f.attempt()),/changed after its signer was classified: client\/Microsoft\.Diagnostics\.NETCore\.Client\.dll/);
 f.afterClassify=null;f.afterBuild=(out,name)=>{if(name==='ODC3.Bridge.Client.dll'){fs.mkdirSync(path.join(out,'runtimes'),{recursive:true});fs.writeFileSync(path.join(out,'runtimes','x.txt'),'x');}};
 await assert.rejects(f.make(bundles).buildBridges(pair,bundles,f.attempt()),/has a subfolder client\/runtimes; only flat bridge folders are offered/);
});

test('B1 and B6: check-backend counts what it received (offersChecked) and compares every delivered file by sha256, not only its size',async t=>{
 const s=stage(t,both),g=gate(s),key='11.55.95|1.7.32';
 const expected={offers:{[key]:s.offers},packHellos:{[key]:g.hello},offerHellos:{[key]:g.offerHello},offerLanes:{[key]:g.offerLanes},legacyHellos:{[key]:g.legacyHello}};
 assert.equal((await runCheck(expected,{kernel:g.kernel,bridges:s.store,served})).receipt.offersChecked,2);
 // Another pair's offers in the same request are not this backend's: not asked, not counted.
 const elsewhere=Object.fromEntries(Object.entries(expected).map(([name,v])=>[name,{'11.55.96|1.7.33':v[key]}]));
 const r0=(await runCheck(elsewhere,{kernel:g.kernel,bridges:s.store,served})).receipt;assert.equal(r0.offersChecked,0);assert.equal(r0.presented,false);
 // A delivery of the right size with other bytes.
 const forged=path.join(tmp(t),'forged');
 const swapped={offer:(...a)=>s.store.offer(...a),file:(...a)=>{const real=s.store.file(...a);if(!real)return null;fs.writeFileSync(forged,Buffer.alloc(fs.statSync(real).size,120));return forged;}};
 await assert.rejects(runCheck(expected,{kernel:g.kernel,bridges:swapped,served}),/Authenticated bridge delivery failed/);
});

test('B3: the store refuses a Microsoft label on an owner-only path (ODC3.*, Anvil.*, hook/), as the agents do',t=>{
 for(const files of [
  [['bridge/ODC3.Bridge.v109.dll','microsoft'],['client/ODC3.Bridge.Client.dll','owner']],
  [['bridge/ODC3.Bridge.v109.dll','owner'],['client/ODC3.Bridge.Client.dll','owner'],['client/Anvil.Extra.dll','microsoft']],
  [['bridge/ODC3.Bridge.v109.dll','owner'],['client/ODC3.Bridge.Client.dll','owner'],['client/odc3.lowercase.dll','microsoft']]]){
  const s=stage(t,[{lane:'odc',studioVersion:'1.7.32',protocol:'v109',files}]);
  assert.throws(()=>verifyBridge(s.dir('odc','1.7.32','v109'),s.keys.publicKey),/signer is invalid/,JSON.stringify(files));assert.equal(s.store.offer('odc','1.7.32',['v109']),null);
 }
 const hook=stage(t,[{lane:'o11',studioVersion:'11.55.95',protocol:'d1',files:[['bridge/Anvil.Bridge.dll','owner'],['hook/Helper.dll','microsoft']]}]);
 assert.throws(()=>verifyBridge(hook.dir('o11','11.55.95','d1'),hook.keys.publicKey),/signer is invalid/);
 // A Microsoft dependency elsewhere stays accepted.
 const ok=stage(t,[both[0]]);assert.equal(verifyBridge(ok.dir('odc','1.7.32','v109'),ok.keys.publicKey).manifest.files.find(x=>x.signer==='microsoft').path,'client/Microsoft.Diagnostics.NETCore.Client.dll');
});

test('B2: classify-signers takes the signer organization as the agent does: exactly one O=, exactly Microsoft Corporation',{skip:process.platform!=='win32'&&'PowerShell'},()=>{
 assert.match(fs.readFileSync(path.join(here,'classify-signers.ps1'),'utf8'),/\[string\]::Equals\(\(Get-SingleOrganization \$signature\.SignerCertificate\), 'Microsoft Corporation', \[StringComparison\]::Ordinal\)/);
 const subjects=['CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, C=US','CN=x, O=Microsoft Corporation, O=Other Org','CN=x, O=Microsoft Corporation Evil','CN=x, OU=Microsoft Corporation','CN=x, O=microsoft corporation'];
 const script=". '"+path.join(here,'authenticode-chain.ps1').replaceAll("'","''")+"'\n"
  +"$out=@()\n"
  +"foreach($subject in @("+subjects.map(x=>"'"+x+"'").join(',')+")){\n"
  +" $rsa=[Security.Cryptography.RSA]::Create(2048)\n"
  +" $request=New-Object Security.Cryptography.X509Certificates.CertificateRequest($subject,$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)\n"
  +" $cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddDays(1))\n"
  +" $value=Get-SingleOrganization $cert\n"
  +" $out+=[string]::Equals($value,'Microsoft Corporation',[StringComparison]::Ordinal)\n"
  +"}\n"
  +"ConvertTo-Json -InputObject @($out) -Compress";
 const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{encoding:'utf8',windowsHide:true,timeout:120000});
 assert.equal(r.status,0,r.stderr);
 assert.deepEqual(JSON.parse(r.stdout.trim().split(/\r?\n/).pop()),[true,false,false,false,false]);
});

test('B5: R7 reads the release line as the branch refs/heads/<agentReleaseRef>, never a tag of the same name',async()=>{
 const commit='a'.repeat(40),tip='b'.repeat(40),calls=[];
 const git=async args=>{calls.push(args);if(args[0]==='merge-base')return {code:0,stdout:''};if(args[0]==='rev-parse')return {code:0,stdout:tip+'\n'};throw Error(args.join(' '));};
 await verifySignedAgentRelease({agentReleaseCommit:commit,agentReleaseRef:'agent/release-0.2.8',ownerSigningPublicKey:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOwner owner'},{git,ownerSigned:async()=>true});
 assert.ok(calls.length>=2);
 for(const args of calls)assert.ok(args.includes('refs/heads/agent/release-0.2.8')||args.some(a=>a.startsWith('refs/heads/agent/release-0.2.8^')),JSON.stringify(args));
 assert.ok(calls.some(a=>a[0]==='merge-base'&&a.includes(commit)));
});
