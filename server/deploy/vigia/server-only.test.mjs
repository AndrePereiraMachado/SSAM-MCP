// Server-only bridge mode (server-only.mjs) and the five-pair window: pure rules, the image smoke of the published pack, the
// rotation that keeps the newest pairs and the compose of five backends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {BRIDGE_MODES,CLIENT_BRIDGE_CODE,bridgeMode,parseAgentRelease,loadableOdc,packForStudio,laneGap,packHello,nearestKernels,serverOnlyKernel,serverOnlyGate,deferredLanes,gapText,o11Proofs,o11ProofProblem,O11_PROOFS_ROOT} from './server-only.mjs';
import {rotateWindow,windowLimit,replayApprovals,pairFor} from './window.mjs';
import {automaticPlan,AUTOMATIC_PLAN} from './automatic.mjs';
import {smokeImage} from './smoke.mjs';
import {generateCompose} from '../coolify/gen-compose.mjs';
import {compatibility} from '../../platforms/odc/facade/agent-hub.mjs';
import {round,readConfig} from './vigia.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const tmp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'server-only-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const read=rel=>fs.readFileSync(path.resolve(here,'../../..',rel),'utf8');
// The agent release of this checkout (the same files runtime.agentReleaseFiles reads from agentReleaseCommit with git show).
const files={program:read('agent/platforms/odc/studio/bridge/client/Program.cs'),kinds:read('agent/agent/lib/kinds.mjs'),native:read('agent/native/Ssam.Agent/StudioKinds.cs'),bridgeProject:read('agent/platforms/odc/studio/bridge/Bridge.csproj')};
const release=parseAgentRelease({commit:'c20454cbc78f6165b7e3c58e8348adf81ad656a5',...files});
const example=JSON.parse(fs.readFileSync(path.join(here,'config.example.json'),'utf8'));
const config={agentPack:example.agentPack,agentPackByRuntime:example.agentPackByRuntime};
// A published pack with a thin bridge built for Service Studio 11.55.95 (the example pack has .94/.93/.92 only).
const config95={...config,agentPack:{...example.agentPack,o11Builds:[{version:'11.55.95',runtime:'net10.0'},...example.agentPack.o11Builds]}};
// The kernels and the window served at r43b (r1-kernels.json, versions.json), frozen here so that a later pair added to the
// checkout (r44: 1.7.32/11.55.95) does not change what these rules are asked.
const net10=['v98','v101','v102','v107','v106','v108'],net8=['v98','v96','v48','v45','v102','v107','v97'];
const kernels=[{o11:'11.55.94',odc:'1.7.30',odcBridge:'v109',odcBridgeAccepted:net10},{o11:'11.55.93',odc:'1.7.29',odcBridge:'v108',odcBridgeAccepted:net8},{o11:'11.55.92',odc:'1.7.28',odcBridge:'v108',odcBridgeAccepted:net8},{o11:'11.55.94',odc:'1.7.31',odcBridge:'v109',odcBridgeAccepted:net10}];
const studios=(odc='1.7.32',o11='11.55.95',tfm={})=>({odc:{version:odc,fullVersion:odc+'.1',tfm:tfm.odc??'net10.0'},o11:{version:o11,fullVersion:o11+'.1',tfm:tfm.o11??'net10.0'}});
const pair={odc:'1.7.32',o11:'11.55.95',lanes:['odc','o11']};
const served={odc:['1.7.32','1.7.31','1.7.30','1.7.29','1.7.28'],o11:['11.55.95','11.55.94','11.55.93','11.55.92']};
// Review round 3, N4: an owner's O11 proof is structured and verified against its evidence file (o11Proofs); only its output
// reaches the gate. A proofs folder of the test stands for C:\ssam-priv\vigia\proofs.
function proofFolder(t){const root=tmp(t),file=path.join(root,'attach-agent-to-11.55.96.json');fs.writeFileSync(file,JSON.stringify({studio:'11.55.96',attached:true}));return {root,file};}
const proofOf=(file,studioVersion='11.55.96',extra={})=>({studioVersion,build:'11.55.94',packCommit:release.commit,provenAt:'2026-11-08T10:00:00Z',evidence:file,...extra});
const verified=(root,entries)=>o11Proofs({agentReleaseCommit:release.commit,o11BridgeProven:entries},{root,now:Date.parse('2026-11-08T12:00:00Z')});

test('bridgeMode defaults to server-only, keeps signed-offers, refuses anything else; the plan says no client bridge is built',()=>{
 assert.deepEqual(BRIDGE_MODES,['server-only','signed-offers']);
 assert.equal(bridgeMode({}),'server-only');assert.equal(bridgeMode({bridgeMode:'signed-offers'}),'signed-offers');
 assert.throws(()=>bridgeMode({bridgeMode:'unsigned'}),e=>e.code==='BRIDGE_MODE_INVALID');
 assert.equal(example.bridgeMode,'server-only');
 assert.deepEqual(automaticPlan('signed-offers'),AUTOMATIC_PLAN);
 const plan=automaticPlan('server-only');assert.equal(plan.length,AUTOMATIC_PLAN.length);
 assert.ok(!plan.some(s=>/Compile pinned client sources/.test(s)));assert.ok(plan.some(s=>/Build no client bridge/.test(s)&&/client-bridge-update-required/.test(s)));
});
test('the reviewed agent release names the ODC bridges its client attaches and the commands both agents run',()=>{
 assert.deepEqual([release.odc.current,release.odc.earlier],['v109','v108']);
 // The ODC Studio assemblies its bridge is compiled against (Bridge.csproj), for the static reference check (M3).
 assert.equal(release.odc.references.length,25);for(const n of ['OutSystems.Model','ServiceStudio.Framework','Avalonia.Base','Xilium.CefGlue.Common'])assert.ok(release.odc.references.includes(n),n);
 assert.ok(release.commands.includes('reconcile-merge')&&release.commands.includes('merge'));assert.equal(release.preferFrom,108);
 assert.deepEqual(loadableOdc(release,'net8.0'),['v108']);assert.deepEqual(loadableOdc(release,'net10.0'),['v109','v108']);
 // Only what both agents run: a command the native agent lacks is not declared.
 const nodeOnly=parseAgentRelease({...files,native:files.native.replace('"reconcile-merge", ','')});assert.ok(!nodeOnly.commands.includes('reconcile-merge'));
 assert.throws(()=>parseAgentRelease({kinds:files.kinds}),e=>e.code==='AGENT_RELEASE_REQUIRED');
});
test('the published pack for a Studio follows agentPackByRuntime by runtime, and a runtime no pack declares has none',()=>{
 assert.equal(packForStudio(config,'odc','net10.0').odcBridge,'v108');assert.equal(packForStudio(config,'odc','net8.0').odcBridge,'v108');
 assert.equal(packForStudio(config,'o11','net10.0').o11BuiltFor,'11.55.94');
 assert.equal(packForStudio(config,'odc','net11.0'),null);assert.equal(packForStudio(config,'o11','net11.0'),null);assert.equal(packForStudio(config,'odc','unknown'),null);
});
test('the kernel of a new pair accepts the bridges of the published packs plus what the nearest served pair accepts',()=>{
 const k=serverOnlyKernel(config,pair,studios(),kernels,release);
 assert.deepEqual({o11:k.o11,odc:k.odc,odcBridge:k.odcBridge},{o11:'11.55.95',odc:'1.7.32',odcBridge:'v108'});
 const nearest=nearestKernels(kernels,'odc','1.7.32');assert.ok(nearest.length>=1&&nearest.every(n=>n.odc==='1.7.31'),'the newest served ODC below 1.7.32');
 for(const v of nearest.flatMap(n=>[n.odcBridge,...(n.odcBridgeAccepted??[])]).filter(v=>v!=='v108'))assert.ok(k.odcBridgeAccepted.includes(v),v);
 assert.ok(!k.odcBridgeAccepted.includes('v108'),'odcBridge is not repeated in the accepted list');
 assert.ok(k.o11BridgeAccepted.every(v=>/^d\d+$/.test(v)));
 // A bridge another published pack ships is accepted when the reviewed release builds it (M4: never the config value alone).
 const two=serverOnlyKernel({...config,agentPackByRuntime:{net10:{...config.agentPackByRuntime.net10,odcBridges:['v109','v108']}}},pair,studios(),[],release);assert.equal(two.odcBridge,'v109');assert.deepEqual(two.odcBridgeAccepted,['v108']);
 const foreign=serverOnlyKernel({...config,agentPack:{...config.agentPack,odcBridge:'v107'}},pair,studios(),[],release);assert.equal(foreign.odcBridge,'v108');assert.deepEqual(foreign.odcBridgeAccepted,[],'v107 is not a bridge the release builds');
 // The newest of the bridges the pack ships for that runtime and the release attaches to it.
 assert.equal(serverOnlyKernel({...config,agentPackByRuntime:{net10:{...config.agentPackByRuntime.net10,odcBridges:['v109']}}},pair,studios(),[],release).odcBridge,'v109');
 // A version below every served one takes the oldest served pair; a kernel never copies O11 hooks or foreign values.
 assert.ok(nearestKernels(kernels,'odc','1.7.1').every(n=>n.odc==='1.7.28'));
 assert.deepEqual(serverOnlyKernel(config,pair,studios(),[{odc:'1.7.31',o11:'11.55.94',odcBridge:'x',odcBridgeAccepted:['v1;rm']}],release).odcBridgeAccepted,[]);
 // Without the reviewed release no ODC bridge is trusted.
 assert.throws(()=>serverOnlyKernel(config,pair,studios(),kernels,null),e=>e.code===CLIENT_BRIDGE_CODE);
});
test('the gate passes a published pack with a thin bridge built for 11.55.95, and the server accepts its hello on both lanes',()=>{
 const g=serverOnlyGate({config:config95,release,pair,studios:studios(),servedKernels:kernels,served});
 assert.deepEqual(g.gaps,[]);assert.equal(g.hello.pack.odcBridge,'v108');assert.equal(g.hello.pack.o11BuiltFor,'11.55.95');assert.equal(g.hello.capabilities.bridgeOffer,false);
 assert.ok(g.hello.agent.odcCommands.includes('reconcile-merge')&&g.hello.agent.odcCommands.includes('merge:prefer-foreign'));
 const answer=compatibility(g.hello,{...g.kernel,servedVersions:served},['odc','o11']);assert.equal(answer.odc.ok,true);assert.equal(answer.o11.ok,true);
});
test('the gate defers on a runtime without a pack bridge, on a bridge the release does not attach and on a refused hello',t=>{
 const net11=serverOnlyGate({config:config95,release,pair,studios:studios('1.7.32','11.55.95',{odc:'net11.0'}),servedKernels:kernels,served});
 assert.deepEqual(net11.gaps.map(g=>[g.lane,g.version,g.tfm]),[['odc','1.7.32','net11.0']]);assert.match(net11.gaps[0].why,/agentPackByRuntime\.net11/);
 assert.match(gapText(net11.gaps),/^client bridge update required: odc 1\.7\.32 runtime net11\.0 \(.*Production is not touched for this lane\./);
 const o11=serverOnlyGate({config,release,pair,studios:studios('1.7.32','11.55.95',{o11:'net11.0'}),servedKernels:kernels,served});assert.deepEqual(o11.gaps.map(g=>g.lane),['o11']);
 // The release attaches v109/v108 to a net10 ODC Studio and only v108 to a net8 one: a declared v109 for net8 is a gap.
 assert.match(laneGap({...config,agentPack:{...config.agentPack,odcBridge:'v109'}},release,'odc',{version:'1.7.28',tfm:'net8.0'}),/attaches v108 to an ODC Studio on net8\.0, not the declared v109/);
 assert.equal(laneGap(config,release,'odc',{version:'1.7.32',tfm:'net10.0'}),null);
 // A thin bridge built for another runtime than that Service Studio's.
 assert.match(laneGap({...config,agentPackByRuntime:{net10:{o11BuiltFor:'11.55.95',o11Builds:[{version:'11.55.95',runtime:'net8.0'}]}}},release,'o11',{version:'11.55.95',tfm:'net10.0'}),/built for net8\.0/);
 // An agent without reconcile-merge: the v108 bridge needs it (AGENT_PACK_MISMATCH), so the hello is refused.
 const old=serverOnlyGate({config:config95,release:{...release,commands:release.commands.filter(c=>c!=='reconcile-merge')},pair,studios:studios(),servedKernels:kernels,served});
 assert.deepEqual(old.gaps.map(g=>g.lane),['odc']);assert.match(old.gaps[0].why,/AGENT_PACK_MISMATCH/);
 // A proven thin bridge no served Service Studio version runs (the window dropped 11.55.94): refused, not deployed.
 const pf=proofFolder(t),proven={...config,o11BridgeProven:verified(pf.root,{'11.55.95':proofOf(pf.file,'11.55.95')}).proven};assert.ok(proven.o11BridgeProven['11.55.95']);
 const dropped=serverOnlyGate({config:proven,release,pair,studios:studios(),servedKernels:kernels,served:{...served,o11:['11.55.95']}});assert.deepEqual(dropped.gaps.map(g=>g.lane),['o11']);
});
// Review round 2, probes P1-P3 (C:\t\r5\rev-vigia-so\probe.mjs) as tests.
test('A1 (P1): a Service Studio the published pack has no build for EXACTLY is refused, never served by the default build',t=>{
 for(const o11 of ['11.55.95','11.55.96']){
  const p={odc:'1.7.32',o11,lanes:['o11']},g=serverOnlyGate({config,release,pair:p,studios:studios('1.7.32',o11),servedKernels:kernels,served:{odc:served.odc,o11:[o11,...served.o11]}});
  assert.deepEqual(g.gaps.map(x=>[x.lane,x.version]),[['o11',o11]]);assert.equal(g.kernel,undefined);
  assert.match(g.gaps[0].why,new RegExp(`no thin bridge built for Service Studio ${o11.replaceAll('.','\\.')} \\(o11Builds: 11\\.55\\.94, 11\\.55\\.93, 11\\.55\\.92\\)`));
 }
 // The exact build passes and the hello names it; the owner may record a live proof that another build loads (o11BridgeProven).
 assert.equal(laneGap(config,release,'o11',{version:'11.55.94',tfm:'net10.0'}),null);
 const pf=proofFolder(t),proven=entries=>{const v=verified(pf.root,entries);return {...config,o11BridgeProven:v.proven,o11ProofRefusals:v.refused};};
 const p={odc:'1.7.32',o11:'11.55.96',lanes:['o11']},sv={odc:served.odc,o11:['11.55.96',...served.o11]};
 const ok=serverOnlyGate({config:proven({'11.55.96':proofOf(pf.file)}),release,pair:p,studios:studios('1.7.32','11.55.96'),servedKernels:kernels,served:sv});
 assert.deepEqual(ok.gaps,[]);assert.equal(ok.hello.pack.o11BuiltFor,'11.55.94');
 // N4: the round-2 free-text form, an empty one and a raw entry that never went through o11Proofs are no proof.
 for(const entry of [{build:'11.55.94',evidence:'live attach of agent 0.2.7 to Service Studio 11.55.96, 2026-11-08'},{build:'11.55.94',evidence:''},{build:'11.55.94'}]){
  const g=serverOnlyGate({config:proven({'11.55.96':entry}),release,pair:p,studios:studios('1.7.32','11.55.96'),servedKernels:kernels,served:sv});
  assert.equal(g.gaps[0]?.lane,'o11',JSON.stringify(entry));assert.match(g.gaps[0].why,/its o11BridgeProven entry is refused: /);
  assert.equal(serverOnlyGate({config:{...config,o11BridgeProven:{'11.55.96':entry}},release,pair:p,studios:studios('1.7.32','11.55.96'),servedKernels:kernels,served:sv}).gaps[0]?.lane,'o11');
 }
 assert.equal(serverOnlyGate({config:{...config,o11BridgeProven:{'11.55.96':proofOf(pf.file)}},release,pair:p,studios:studios('1.7.32','11.55.96'),servedKernels:kernels,served:sv}).gaps[0]?.lane,'o11','an unverified entry (no sha256 read) is no proof');
 assert.match(laneGap(proven({'11.55.96':proofOf(pf.file,'11.55.96',{build:'11.55.90'})}),release,'o11',{version:'11.55.96',tfm:'net10.0'}),/no thin bridge built for Service Studio 11\.55\.96/);
 // The post-deploy check refuses a presented hello whose thin bridge is not that build.
 const source=fs.readFileSync(path.join(here,'check-backend.mjs'),'utf8');
 assert.match(source,/presented\.pack\?\.o11BuiltFor!==\(expected\.o11Proven\?\.\[kernel\.o11\]\?\?kernel\.o11\)/);
});
test('N4: an O11 proof needs its Studio, the reviewed pack commit, a past ISO time and an existing evidence file under the proofs folder; its sha256 is read',t=>{
 assert.equal(O11_PROOFS_ROOT,'C:/ssam-priv/vigia/proofs');
 const pf=proofFolder(t),now=Date.parse('2026-11-08T12:00:00Z'),bytes=fs.readFileSync(pf.file),sha=createHash('sha256').update(bytes).digest('hex');
 const ok=verified(pf.root,{'11.55.96':proofOf(pf.file)});assert.deepEqual(ok.refused,[]);
 assert.deepEqual(ok.proven['11.55.96'],{studioVersion:'11.55.96',build:'11.55.94',packCommit:release.commit,provenAt:'2026-11-08T10:00:00Z',evidence:pf.file,sha256:sha,size:bytes.length});
 assert.deepEqual(verified(pf.root,{'11.55.96':proofOf(pf.file,'11.55.96',{sha256:sha})}).refused,[]);
 const outside=path.join(path.dirname(pf.root),path.basename(pf.root)+'-outside.json');fs.writeFileSync(outside,'x');t.after(()=>fs.rmSync(outside,{force:true}));
 const cases=[
  [{build:'11.55.94',evidence:'live attach 2026-11-08'},/studioVersion|unknown field/],
  ['live attach of agent 0.2.7',/it is not/],
  [proofOf(pf.file,'11.55.95'),/studioVersion "11\.55\.95" is not its key 11\.55\.96/],
  [proofOf(pf.file,'11.55.96',{build:'11.55.96'}),/build "11\.55\.96" is not another/],
  [proofOf(pf.file,'11.55.96',{packCommit:'d'.repeat(40)}),/packCommit "d{40}" is not the reviewed agentReleaseCommit c20454c/],
  [proofOf(pf.file,'11.55.96',{provenAt:'yesterday'}),/provenAt is not an ISO date-time/],
  [proofOf(pf.file,'11.55.96',{provenAt:'2026-11-08'}),/provenAt is not an ISO date-time/],
  [proofOf(pf.file,'11.55.96',{provenAt:'2026-11-09T10:00:00Z'}),/provenAt is in the future/],
  [proofOf(outside),/evidence is not a file under/],
  [proofOf(path.join(pf.root,'..',path.basename(pf.root),'..','escape.json')),/evidence is not a file under/],
  [proofOf('proofs/attach.json'),/evidence is not a file under/],
  [proofOf(path.join(pf.root,'missing.json')),/evidence cannot be read \(ENOENT\)/],
  [proofOf(pf.root),/evidence is not a file under/],
  [proofOf((fs.mkdirSync(path.join(pf.root,'folder')),path.join(pf.root,'folder'))),/evidence is not a regular file/],
  [proofOf('\\\\?\\'+pf.file),/evidence is not a file under/],
  [proofOf(pf.file,'11.55.96',{sha256:'0'.repeat(64)}),/evidence changed since its sha256 was recorded/],
  [proofOf(pf.file,'11.55.96',{sha256:'ABC'}),/sha256 is not 64 lowercase hex/],
  [proofOf(pf.file,'11.55.96',{note:'free text'}),/unknown field note/]];
 for(const [entry,why] of cases){const r=verified(pf.root,{'11.55.96':entry});assert.deepEqual(Object.keys(r.proven),[],JSON.stringify(entry));assert.match(r.refused[0]?.why??'',why,JSON.stringify(entry));}
 assert.match(o11ProofProblem('11.55.96',proofOf(pf.file),{agentReleaseCommit:undefined,root:pf.root,now}),/agentReleaseCommit is not configured/);
 assert.match(verified(pf.root,{'11.55':proofOf(pf.file)}).refused[0].why,/its key is not a Service Studio version/);
 // A link under the folder to a file outside it is refused (when this account may create one).
 const link=path.join(pf.root,'link.json');let linked=true;try{fs.symlinkSync(outside,link,'file');}catch{linked=false;}
 if(linked)assert.match(verified(pf.root,{'11.55.96':proofOf(link)}).refused[0].why,/evidence is not a regular file/);
 // The example configuration declares the structured form, no free text.
 assert.deepEqual(example.o11BridgeProven,{});
});
test('M2 (P2): an O11 build that declares no runtime never passes the gate',()=>{
 const strings={agentPack:{...config.agentPack,o11Builds:['11.55.94','11.55.93']},agentPackByRuntime:{net10:{odcBridge:'v108',o11BuiltFor:'11.55.93'}}};
 assert.match(laneGap(strings,release,'o11',{version:'11.55.94',tfm:'net10.0'}),/thin bridge for Service Studio 11\.55\.94 declares no runtime/);
 assert.match(laneGap(strings,release,'o11',{version:'11.55.97',tfm:'net10.0'}),/no thin bridge built for Service Studio 11\.55\.97/);
});
test('M4 (P3): odcBridges the reviewed release does not attach to that runtime are a gap, never the kernel bridge',()=>{
 const c3={...config,agentPack:{...config.agentPack,odcBridges:['v109']}},p={odc:'1.7.33',o11:'11.55.94',lanes:['odc']};
 const g=serverOnlyGate({config:c3,release,pair:p,studios:studios('1.7.33','11.55.94',{odc:'net8.0'}),servedKernels:kernels,served:{odc:['1.7.33',...served.odc],o11:served.o11}});
 assert.deepEqual(g.gaps.map(x=>x.lane),['odc']);assert.match(g.gaps[0].why,/attaches v108 to an ODC Studio on net8\.0, not the declared v109/);assert.equal(g.kernel,undefined);
 // Even asked directly, the kernel of a net8 Studio never takes a bridge the release does not attach there.
 assert.equal(serverOnlyKernel(c3,p,studios('1.7.33','11.55.94',{odc:'net8.0'}),kernels,release).odcBridge,'v108');
 assert.ok(!packHello(c3,release,studios('1.7.33','11.55.94',{odc:'net8.0'})).pack.odcBridges.includes('v109'));
});
test('M1 (P4): an O11-only Studio pairs with the NEWEST served ODC, wherever it sits in the manifest (owner case: ODC 1.7.32 + new O11)',()=>{
 const r44=withPair(versions,'1.7.32','11.55.95',5);
 const p=pairFor(r44,[{lane:'o11',version:'11.55.96'}]);assert.deepEqual({odc:p.odc,o11:p.o11,lanes:p.lanes},{odc:'1.7.32',o11:'11.55.96',lanes:['o11']});
 assert.deepEqual(pairFor(r44,[{lane:'odc',version:'1.7.33'}]).o11,'11.55.95');
 const r=rotateWindow(r44,{odc:p.odc,o11:p.o11,image,tag:'prod-new'},{maxWindow:5});
 assert.deepEqual(pairsOf(r.manifest),['1.7.32/11.55.96','1.7.30/11.55.94','1.7.29/11.55.93','1.7.31/11.55.94','1.7.32/11.55.95']);assert.deepEqual(r.leaving,{odc:['1.7.28'],o11:['11.55.92']});
 // A rotation given one lane only completes it with the newest served version of the other.
 assert.deepEqual(pairsOf(rotateWindow(r44,{o11:'11.55.96',image,tag:'prod-new'},{maxWindow:5}).manifest)[0],'1.7.32/11.55.96');
 // The pipeline bundles the kept lane at the pair's version (the newest), not at position 0.
 assert.match(fs.readFileSync(path.join(here,'pipeline.mjs'),'utf8'),/await ops\.companion\(lane,pair\[lane\]\)/);
});
test('a gap in the kept lane defers the whole pair; a gap in a new lane defers that lane',()=>{
 assert.deepEqual(deferredLanes([{lane:'odc'}],{lanes:['odc','o11']}),['odc']);
 assert.deepEqual(deferredLanes([{lane:'o11'}],{lanes:['odc']}),['odc']);
 assert.equal(CLIENT_BRIDGE_CODE,'client-bridge-update-required');
});
test('the image smoke presents the published pack hello with the release kernel, and reports each refused lane',async t=>{
 const dir=tmp(t),features=path.join(dir,'f.xml');fs.writeFileSync(features,'x');
 const g=serverOnlyGate({config:config95,release,pair,studios:studios(),servedKernels:kernels,served});
 const run=async(code,stderr='')=>{
  const inputs=[];
  const docker=async(args,{input}={})=>{
   if(args[0]==='logs')return {code:0,stdout:JSON.stringify({event:'warm',indexes:{ok:true},delivery:{builder:{ok:true},worker:{ok:true}}})+'\n',stderr:''};
   if(args.includes('server-token'))return {code:0,stdout:JSON.stringify({token:'t',agentCredential:'c'}),stderr:''};
   if(input){inputs.push(input);return {code,stdout:code?'':'{"ok":true,"tools":91}',stderr};}
   return {code:0,stdout:'',stderr:''};
  };
  const ev=path.join(dir,'ev'+code);
  const result=await smokeImage({pair:{o11:'11.55.95',odc:'1.7.32',image:'i',tag:'t'},bundle:{features},dir:ev,root:dir,docker,served,budget:{tools:91,totalBytes:1},privateDir:path.join(dir,'p'),kernel:g.kernel,presented:g.hello});
  return {result,inputs,kernel:JSON.parse(fs.readFileSync(path.join(ev,'kernel.json'),'utf8'))};
 };
 const good=await run(0);assert.equal(good.result.publishedPack,true);assert.deepEqual(good.kernel,g.kernel);
 assert.ok(good.inputs[0].includes(JSON.stringify(g.hello)),'the presented hello is the published one');
 const bad=await run(1,'SMOKE_REFUSED:[{"lane":"odc","code":"AGENT_PACK_MISMATCH"},{"lane":"x","code":"y"}]\nSMOKE_CHECK:The published agent pack was not accepted for both lanes.');
 assert.equal(bad.result.ok,false);assert.deepEqual(bad.result.refused,[{lane:'odc',code:'AGENT_PACK_MISMATCH'}]);assert.equal(bad.result.publishedPack,undefined);
 await assert.rejects(smokeImage({pair:{o11:'11.55.94',odc:'1.7.30',image:'i',tag:'t'},bundle:{features},dir,root:dir,docker:async()=>({code:0,stdout:'',stderr:''}),served,budget:{tools:91,totalBytes:1},privateDir:path.join(dir,'p'),kernel:g.kernel,presented:g.hello}),/another pair/);
 await assert.rejects(smokeImage({pair:{o11:'11.55.95',odc:'1.7.32',image:'i',tag:'t'},bundle:{features},dir,root:dir,docker:async()=>({code:0,stdout:'',stderr:''}),served,budget:{tools:91,totalBytes:1},privateDir:path.join(dir,'p'),presented:g.hello}),/needs the release kernel/);
});
test('the post-deploy check posts the published pack hello to the new pair only',()=>{
 const source=fs.readFileSync(path.join(here,'check-backend.mjs'),'utf8');
 assert.match(source,/const presented=expected\.packHellos\?\.\[kernel\.o11\+'\|'\+kernel\.odc\]/);assert.match(source,/Published agent pack hello failed/);
});

// The five-pair window.
const image='docker.io/andrepereiramachado/ssam-server',sha='a'.repeat(64);
const r43b=(odc,o11)=>({tag:`prod-20261103-r43b-60e13ec-o${o11.replaceAll('.','')}-odc${odc.replaceAll('.','')}`,image,sha256:sha});
const versions={window:4,odc:[['1.7.30','11.55.94'],['1.7.29','11.55.93'],['1.7.28','11.55.92'],['1.7.31','11.55.94']].map(([odc,o11])=>({version:odc,...r43b(odc,o11)})),o11:[['1.7.30','11.55.94'],['1.7.29','11.55.93'],['1.7.28','11.55.92'],['1.7.31','11.55.94']].map(([odc,o11])=>({version:o11,...r43b(odc,o11)}))};
const withPair=(manifest,odc,o11,window=manifest.window)=>{const tag=`prod-x-o${o11.replaceAll('.','')}-odc${odc.replaceAll('.','')}`;return {window,odc:[...manifest.odc,{version:odc,tag,image,sha256:sha}],o11:[...manifest.o11,{version:o11,tag,image,sha256:sha}]};};
const pairsOf=m=>m.odc.map(o=>o.version+'/'+m.o11.find(x=>x.tag===o.tag).version);
test('maxWindow 5: a five-pair window rotates by version, keeping a pair appended by hand as the newest',()=>{
 // r43b appended ODC 1.7.31 at the end of the window; the next pair must never evict it for being last.
 const four=rotateWindow(versions,{odc:'1.7.32',o11:'11.55.95',image,tag:'prod-new'},{maxWindow:5});
 assert.deepEqual(pairsOf(four.manifest),['1.7.32/11.55.95','1.7.30/11.55.94','1.7.29/11.55.93','1.7.31/11.55.94']);assert.deepEqual(four.leaving.odc,['1.7.28']);
 // A window of five (the r44 fifth pair appended by hand): the sixth pair evicts the oldest, 1.7.28, and keeps five.
 const five=withPair(versions,'1.7.32','11.55.95',5);
 const next=rotateWindow(five,{odc:'1.7.33',o11:'11.55.96',image,tag:'prod-new'},{maxWindow:5});
 assert.equal(next.manifest.window,5);assert.deepEqual(pairsOf(next.manifest),['1.7.33/11.55.96','1.7.30/11.55.94','1.7.29/11.55.93','1.7.31/11.55.94','1.7.32/11.55.95']);
 assert.deepEqual(next.leaving,{odc:['1.7.28'],o11:['11.55.92']});
 // An approval main does not carry yet is replayed over a five-pair main without a configured limit (manual -Approve).
 const replayed=replayApprovals(five,[{id:'o11-11.55.96-odc-1.7.33',pair:{odc:'1.7.33',o11:'11.55.96'},built:{image,tag:'prod-new'},approved:{at:'2026-11-08T00:00:00Z',digest:'sha256:'+sha}}]);
 assert.deepEqual(replayed.replayed,['o11-11.55.96-odc-1.7.33']);assert.equal(replayed.manifest.odc.length,5);
 // The served pair rotated again (a rehearsal) keeps the five.
 assert.equal(rotateWindow(five,{odc:'1.7.32',o11:'11.55.95',image,tag:'prod-again'},{maxWindow:5}).manifest.odc.length,5);
});
test('maxWindow 5: retention holds an older pair for a recent client up to five, and beyond it waits for the owner',()=>{
 const now=Date.parse('2026-11-08T12:00:00Z'),seen=new Date(now-86400000).toISOString();
 const tokens={a:{customer:'Client',seen,odc:{installed:'1.7.28.1'},o11:{installed:'11.55.92.1'}}};
 const held=rotateWindow(versions,{odc:'1.7.32',o11:'11.55.95',image,tag:'prod-new'},{maxWindow:5,tokens,now});
 assert.equal(held.manifest.odc.length,5);assert.equal(held.manifest.window,5);assert.deepEqual(held.held.map(h=>h.pair),['o11-11.55.92-odc-1.7.28']);assert.deepEqual(held.leaving.odc,[]);
 assert.throws(()=>rotateWindow(withPair(versions,'1.7.32','11.55.95',5),{odc:'1.7.33',o11:'11.55.96',image,tag:'prod-new'},{maxWindow:5,tokens,now}),e=>e.code==='WINDOW_LIMIT'&&/above the configured limit/.test(e.message));
 // A limit below the window already served names the setting to raise.
 assert.throws(()=>rotateWindow(withPair(versions,'1.7.32','11.55.95',5),{odc:'1.7.33',o11:'11.55.96',image,tag:'prod-new'},{maxWindow:4}),e=>e.code==='WINDOW_LIMIT'&&/maxWindow \(4\) is below the window the manifest already serves \(5\)/.test(e.message));
});
test('maxWindow defaults to at least the served window, never below four; the example configures five',()=>{
 assert.equal(windowLimit({},{window:3}),4);assert.equal(windowLimit({},versions),Math.max(4,versions.window));assert.equal(windowLimit({},{window:5}),5);assert.equal(windowLimit({maxWindow:6},{window:5}),6);
 assert.equal(example.maxWindow,5);
});
test('maxWindow 5: the compose of five pairs has five backends, the router routes them all and the newest is not lost',()=>{
 const five=withPair(versions,'1.7.32','11.55.95',5),c=generateCompose(five);
 const backends=Object.keys(c.services).filter(n=>/^ssam-server-v\d+$/.test(n));assert.deepEqual(backends,['ssam-server-v1','ssam-server-v2','ssam-server-v3','ssam-server-v4','ssam-server-v5']);
 const router=c.services['ssam-router'].environment;assert.equal(router.SSAM_VERSION_WINDOW,'5');
 const routes=JSON.parse(router.SSAM_ROUTER_BACKENDS);assert.equal(routes.length,5);assert.deepEqual(routes.at(-1),{name:'o11-11.55.95-odc-1.7.32',url:'http://ssam-server-v5:7310',odc:'1.7.32',o11:'11.55.95',default:false});
 assert.deepEqual(JSON.parse(c.services['ssam-server-v5'].environment.SSAM_SERVED_VERSIONS),{odc:['1.7.30','1.7.29','1.7.28','1.7.31','1.7.32'],o11:['11.55.94','11.55.93','11.55.92','11.55.95']});
 assert.throws(()=>generateCompose(withPair(five,'1.7.33','11.55.96',5)),/fit the window/);
});
test('an automatic dry-run names the bridge mode and its plan, reads no vault and refuses an unknown mode at configuration',async t=>{
 const dir=tmp(t),manifest={window:3,odc:[{version:'1.7.30',tag:'prod-a',image,sha256:sha}],o11:[{version:'11.55.94',tag:'prod-a',image,sha256:sha}]};
 const runtime={manifest:()=>manifest,detect:async()=>[],observe:async()=>[],head:async()=>'h',log:()=>{},secrets:async()=>{throw Error('a dry-run read the vault');}};
 const result=await round({automatic:true,outDir:dir},runtime,{dryRun:true});
 assert.equal(result.status,'dry-run');assert.equal(result.bridgeMode,'server-only');assert.ok(result.automaticPlan.some(s=>/Build no client bridge/.test(s)));
 assert.equal((await round({automatic:true,outDir:dir,bridgeMode:'signed-offers'},runtime,{dryRun:true})).bridgeMode,'signed-offers');
 const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify({workspace:dir,tempRoot:dir,bundleRoot:dir,bridgeMode:'none'}));
 assert.throws(()=>readConfig(file),e=>e.code==='BRIDGE_MODE_INVALID');
});