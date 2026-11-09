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
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {createBridgeStore,verifyBridge} from '../../platforms/odc/facade/bridge-store.mjs';
import {compatibility} from '../../platforms/odc/facade/agent-hub.mjs';
import {toolListingBytes} from '../../platforms/odc/facade/tool-listing.mjs';
import {parseAgentRelease,offersGate,offersKernel,agentHello,installedHello,laneGap,isEd25519Offers} from './server-only.mjs';
import {verifySignedAgentRelease} from './safety.mjs';
import {createAutoRuntime} from './auto-runtime.mjs';
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
 // What a 0.2.7 agent gets on the new pair: its default 11.55.94 thin bridge while 11.55.94 is served, refused once it is not.
 assert.equal(old.o11.ok,true);
 assert.equal(compatibility(hello027(),{...kernel,servedVersions:{...served,o11:['11.55.95']}},['odc','o11'],{bridges:s.store}).o11.code,'AGENT_PACK_MISMATCH');
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
 assert.equal(g.legacyHello.capabilities.bridgeOffer,false);assert.deepEqual(g.legacy,{odc:{ok:true},o11:{ok:true}});
 // Once 11.55.94 leaves the window, the 0.2.7 agents on 11.55.95 are refused (they need the manual 0.2.8 install); the pair still deploys.
 const later=gate(s,{served:{...served,o11:['11.55.95','11.55.93']}});assert.deepEqual(later.gaps,[]);assert.deepEqual(later.legacy.o11,{ok:false,code:'AGENT_PACK_MISMATCH'});
});
test('offersGate: no signed O11 offer (missing, another key, another sequence, another runtime) leaves the lane waiting; an ODC gap is never closed by an offer',t=>{
 const odcOnly=stage(t,[both[0]]);
 const a=gate(odcOnly);assert.equal(a.gaps.length,1);assert.equal(a.gaps[0].lane,'o11');assert.match(a.gaps[0].why,/no thin bridge built for Service Studio 11\.55\.95.*received no signed offer/);
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
 const make=()=>createAutoRuntime({workspace:fakeRoot,tempRoot:dir,outDir:dir,configFile:path.join(dir,'config.json'),bridgeMode:'ed25519-offers',bundlePins:{'odc-1.7.32':pin,'o11-11.55.95':pin},...settings},runtime);
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
async function runCheck(expected,{kernel,bridges,served:list}){
 const src=fs.readFileSync(path.join(here,'check-backend.mjs'),'utf8').split('\n').filter(l=>!/^import /.test(l)&&!/^const store=await openTokenStore/.test(l)).join('\n');
 const posted=[],out=[];
 const fetch=async(url,init={})=>{
  const route=new URL(url).pathname,body=init.body?JSON.parse(init.body):null;
  if(route==='/health')return new Response('{}');
  if(route==='/agent/v1/hello'){posted.push(body);return new Response(JSON.stringify({ok:true,compatible:compatibility(body,{...kernel,servedVersions:list},['odc','o11'],{bridges})}));}
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
