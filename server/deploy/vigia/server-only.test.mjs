// Server-only bridge mode (server-only.mjs) and the five-pair window: pure rules, the image smoke of the published pack, the
// rotation that keeps the newest pairs and the compose of five backends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BRIDGE_MODES,CLIENT_BRIDGE_CODE,bridgeMode,parseAgentRelease,loadableOdc,packForStudio,laneGap,packHello,nearestKernels,serverOnlyKernel,serverOnlyGate,deferredLanes,gapText} from './server-only.mjs';
import {rotateWindow,windowLimit,replayApprovals} from './window.mjs';
import {automaticPlan,AUTOMATIC_PLAN} from './automatic.mjs';
import {smokeImage} from './smoke.mjs';
import {generateCompose} from '../coolify/gen-compose.mjs';
import {compatibility} from '../../platforms/odc/facade/agent-hub.mjs';
import {round,readConfig} from './vigia.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const tmp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'server-only-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const read=rel=>fs.readFileSync(path.resolve(here,'../../..',rel),'utf8');
// The agent release of this checkout (the same files runtime.agentReleaseFiles reads from agentReleaseCommit with git show).
const files={program:read('agent/platforms/odc/studio/bridge/client/Program.cs'),kinds:read('agent/agent/lib/kinds.mjs'),native:read('agent/native/Ssam.Agent/StudioKinds.cs')};
const release=parseAgentRelease({commit:'c20454cbc78f6165b7e3c58e8348adf81ad656a5',...files});
const example=JSON.parse(fs.readFileSync(path.join(here,'config.example.json'),'utf8'));
const config={agentPack:example.agentPack,agentPackByRuntime:example.agentPackByRuntime};
// The kernels and the window served at r43b (r1-kernels.json, versions.json), frozen here so that a later pair added to the
// checkout (r44: 1.7.32/11.55.95) does not change what these rules are asked.
const net10=['v98','v101','v102','v107','v106','v108'],net8=['v98','v96','v48','v45','v102','v107','v97'];
const kernels=[{o11:'11.55.94',odc:'1.7.30',odcBridge:'v109',odcBridgeAccepted:net10},{o11:'11.55.93',odc:'1.7.29',odcBridge:'v108',odcBridgeAccepted:net8},{o11:'11.55.92',odc:'1.7.28',odcBridge:'v108',odcBridgeAccepted:net8},{o11:'11.55.94',odc:'1.7.31',odcBridge:'v109',odcBridgeAccepted:net10}];
const studios=(odc='1.7.32',o11='11.55.95',tfm={})=>({odc:{version:odc,fullVersion:odc+'.1',tfm:tfm.odc??'net10.0'},o11:{version:o11,fullVersion:o11+'.1',tfm:tfm.o11??'net10.0'}});
const pair={odc:'1.7.32',o11:'11.55.95',lanes:['odc','o11']};
const served={odc:['1.7.32','1.7.31','1.7.30','1.7.29','1.7.28'],o11:['11.55.95','11.55.94','11.55.93','11.55.92']};

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
 assert.deepEqual(release.odc,{current:'v109',earlier:'v108'});
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
 const k=serverOnlyKernel(config,pair,studios(),kernels);
 assert.deepEqual({o11:k.o11,odc:k.odc,odcBridge:k.odcBridge},{o11:'11.55.95',odc:'1.7.32',odcBridge:'v108'});
 const nearest=nearestKernels(kernels,'odc','1.7.32');assert.ok(nearest.length>=1&&nearest.every(n=>n.odc==='1.7.31'),'the newest served ODC below 1.7.32');
 for(const v of nearest.flatMap(n=>[n.odcBridge,...(n.odcBridgeAccepted??[])]).filter(v=>v!=='v108'))assert.ok(k.odcBridgeAccepted.includes(v),v);
 assert.ok(!k.odcBridgeAccepted.includes('v108'),'odcBridge is not repeated in the accepted list');
 assert.ok(k.o11BridgeAccepted.every(v=>/^d\d+$/.test(v)));
 // A bridge only one pack ships is accepted too (every published pack, not only the one of this runtime).
 const two=serverOnlyKernel({...config,agentPack:{...config.agentPack,odcBridge:'v107'}},pair,studios(),[]);assert.equal(two.odcBridge,'v108');assert.deepEqual(two.odcBridgeAccepted,['v107']);
 // The newest of the bridges the pack ships for that runtime.
 assert.equal(serverOnlyKernel({...config,agentPackByRuntime:{net10:{...config.agentPackByRuntime.net10,odcBridges:['v109']}}},pair,studios(),[]).odcBridge,'v109');
 // A version below every served one takes the oldest served pair; a kernel never copies O11 hooks or foreign values.
 assert.ok(nearestKernels(kernels,'odc','1.7.1').every(n=>n.odc==='1.7.28'));
 assert.deepEqual(serverOnlyKernel(config,pair,studios(),[{odc:'1.7.31',o11:'11.55.94',odcBridge:'x',odcBridgeAccepted:['v1;rm']}]).odcBridgeAccepted,[]);
});
test('the gate passes the published pack of this release for 1.7.32/11.55.95, and the server accepts its hello on both lanes',()=>{
 const g=serverOnlyGate({config,release,pair,studios:studios(),servedKernels:kernels,served});
 assert.deepEqual(g.gaps,[]);assert.equal(g.hello.pack.odcBridge,'v108');assert.equal(g.hello.pack.o11BuiltFor,'11.55.94');assert.equal(g.hello.capabilities.bridgeOffer,false);
 assert.ok(g.hello.agent.odcCommands.includes('reconcile-merge')&&g.hello.agent.odcCommands.includes('merge:prefer-foreign'));
 const answer=compatibility(g.hello,{...g.kernel,servedVersions:served},['odc','o11']);assert.equal(answer.odc.ok,true);assert.equal(answer.o11.ok,true);
});
test('the gate defers on a runtime without a pack bridge, on a bridge the release does not attach and on a refused hello',()=>{
 const net11=serverOnlyGate({config,release,pair,studios:studios('1.7.32','11.55.95',{odc:'net11.0'}),servedKernels:kernels,served});
 assert.deepEqual(net11.gaps.map(g=>[g.lane,g.version,g.tfm]),[['odc','1.7.32','net11.0']]);assert.match(net11.gaps[0].why,/agentPackByRuntime\.net11/);
 assert.match(gapText(net11.gaps),/^client bridge update required: odc 1\.7\.32 runtime net11\.0 \(.*Production is not touched for this lane\./);
 const o11=serverOnlyGate({config,release,pair,studios:studios('1.7.32','11.55.95',{o11:'net11.0'}),servedKernels:kernels,served});assert.deepEqual(o11.gaps.map(g=>g.lane),['o11']);
 // The release attaches v109/v108 to a net10 ODC Studio and only v108 to a net8 one: a declared v109 for net8 is a gap.
 assert.match(laneGap({...config,agentPack:{...config.agentPack,odcBridge:'v109'}},release,'odc',{version:'1.7.28',tfm:'net8.0'}),/attaches v108 to an ODC Studio on net8\.0, not the declared v109/);
 assert.equal(laneGap(config,release,'odc',{version:'1.7.32',tfm:'net10.0'}),null);
 // A thin bridge built for another runtime than that Service Studio's.
 assert.match(laneGap({...config,agentPackByRuntime:{net10:{o11BuiltFor:'11.55.95',o11Builds:[{version:'11.55.95',runtime:'net8.0'}]}}},release,'o11',{version:'11.55.95',tfm:'net10.0'}),/built for net8\.0/);
 // An agent without reconcile-merge: the v108 bridge needs it (AGENT_PACK_MISMATCH), so the hello is refused.
 const old=serverOnlyGate({config,release:{...release,commands:release.commands.filter(c=>c!=='reconcile-merge')},pair,studios:studios(),servedKernels:kernels,served});
 assert.deepEqual(old.gaps.map(g=>g.lane),['odc']);assert.match(old.gaps[0].why,/AGENT_PACK_MISMATCH/);
 // A thin bridge no served Service Studio version runs (the window dropped 11.55.94): refused, not deployed.
 const dropped=serverOnlyGate({config,release,pair,studios:studios(),servedKernels:kernels,served:{...served,o11:['11.55.95']}});assert.deepEqual(dropped.gaps.map(g=>g.lane),['o11']);
});
test('a gap in the kept lane defers the whole pair; a gap in a new lane defers that lane',()=>{
 assert.deepEqual(deferredLanes([{lane:'odc'}],{lanes:['odc','o11']}),['odc']);
 assert.deepEqual(deferredLanes([{lane:'o11'}],{lanes:['odc']}),['odc']);
 assert.equal(CLIENT_BRIDGE_CODE,'client-bridge-update-required');
});
test('the image smoke presents the published pack hello with the release kernel, and reports each refused lane',async t=>{
 const dir=tmp(t),features=path.join(dir,'f.xml');fs.writeFileSync(features,'x');
 const g=serverOnlyGate({config,release,pair,studios:studios(),servedKernels:kernels,served});
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