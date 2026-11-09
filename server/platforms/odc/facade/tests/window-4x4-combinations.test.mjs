// Window 4x4, phase S1 (design B: C:\t\r5\janela-4x4\DESENHO.md 1.4, 5.1 row S1): the 16 combinations of the window, ODC
// Studio 1.7.29..1.7.32 x Service Studio 11.55.92..11.55.95, end to end through the real router and four real hubs built
// from the compose gen-compose generates for a backend window. For every combination:
//   - routing: the router reaches the backend of the customer's ODC version (odc-<v>), never one chosen by its O11;
//   - identity: both lanes are `same` (no refusal, no warning) against the kernel the customer sees;
//   - welcome: welcome.kernel.o11 is the customer's own Service Studio and builds.o11 its build; servedVersions names the
//     four O11 versions and the four ODC versions of the window (the same on every backend);
//   - the agent's native checks pass with the kernel it receives (StudioKinds.cs CheckPid: the Studio's three numbers equal
//     kernel[lane] or are newer than the whole served window; CheckO11Build: the pack's build and the Studio inside
//     servedVersions.o11), mirrored below line by line;
//   - the hosted context of that customer resolves its own Studio folder and kernel CLI (o11-kernels.mjs hostedO11).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createAgentHub} from '../agent-hub.mjs';
import {createTokenStore} from '../server-tokens.mjs';
import {createRouter,selectBackend} from '../hosted/router.mjs';
import {studioIdentity,studioWarningOf} from '../studio-identity.mjs';
import {hostedO11} from '../o11-kernels.mjs';
import {generateCompose} from '../../../../deploy/coolify/gen-compose.mjs';

const ODC=['1.7.29','1.7.30','1.7.31','1.7.32'];
const O11={'11.55.92':'11.55.92.65269','11.55.93':'11.55.93.65289','11.55.94':'11.55.94.65328','11.55.95':'11.55.95.65352'};
const odcBuild=v=>v+'.11000';
const image='docker.io/andrepereiramachado/ssam-server';
export const manifest4x4={window:4,o11:{served:Object.keys(O11)},backends:ODC.map(odc=>({odc,image,tag:'test-4x4-odc'+odc.replaceAll('.','')}))};

// StudioKinds.cs, as the agent runs it against welcome.kernel (Three: the first three numbers).
const three=v=>{const m=/^(\d+)\.(\d+)\.(\d+)/.exec(String(v??''));return m?[1,2,3].map(i=>Number(m[i])):null;};
const cmp=(a,b)=>{for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;};
function checkPid(kernel,lane,studioVersion){
 const actual=three(studioVersion),expected=three(kernel?.[lane]);
 const window=(kernel?.servedVersions?.[lane]??[]).map(three);
 if(!expected||!actual||cmp(actual,expected)!==0&&!(window.length>0&&window.every(v=>v&&cmp(actual,v)>0)))throw new Error('STUDIO_VERSION_MISMATCH');
}
function checkO11Build(kernel,studioVersion,pack){
 const built=pack?.o11BuiltFor;
 if(!built||cmp(three(built),three(studioVersion))===0)return null;
 const versions=(kernel?.servedVersions?.o11??[]).map(three).filter(Boolean),current=three(studioVersion);
 const has=v=>versions.some(x=>cmp(x,v)===0);
 if(!has(three(built))||!current||!(has(current)||versions.length>0&&versions.every(v=>cmp(current,v)>0)))throw new Error('STUDIO_VERSION_MISMATCH');
 return 'O11_BRIDGE_BUILT_FOR_DIFFERS';
}

test('window 4x4: the generated backend window routes, identifies and welcomes all 16 ODC x O11 combinations', async()=>{
 const compose=generateCompose(manifest4x4);
 const routing=JSON.parse(compose.services['ssam-router'].environment.SSAM_ROUTER_BACKENDS);
 assert.deepEqual(routing.map(b=>b.name),['odc-1.7.32','odc-1.7.31','odc-1.7.30','odc-1.7.29']);
 assert.deepEqual(routing.map(b=>b.default),[true,false,false,false]);
 for(const b of routing)assert.deepEqual(b.o11,Object.keys(O11));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'window-4x4-'));
 const store=createTokenStore(path.join(dir,'tokens'));
 const hubs={},servers=[],backends=[];
 let router;
 try{
  for(const [i,entry] of routing.entries()){
   const env=compose.services[`ssam-server-v${i+1}`].environment;
   assert.equal(env.SSAM_BACKEND_NAME,entry.name);
   const served=JSON.parse(env.SSAM_SERVED_VERSIONS);
   assert.deepEqual(served,{odc:['1.7.32','1.7.31','1.7.30','1.7.29'],o11:Object.keys(O11)},'every backend serves the whole window');
   // The kernel ssam.mjs startupKernel builds on a multi-O11 image: the default O11 kernel (kernel.json) plus o11Builds.
   const kernel={odc:entry.odc,o11:'11.55.95',odcBridge:'v109',builds:{odc:odcBuild(entry.odc),o11:O11['11.55.95']},o11Builds:{...O11},servedVersions:served};
   const hub=createAgentHub({dir:path.join(dir,entry.name),store,kernel,limits:{sweepMs:60000,deadAfterMs:600000}});hubs[entry.name]=hub;
   const server=http.createServer(async(req,res)=>{if(req.url.startsWith('/agent'))return hub.handle(req,res);req.resume();res.setHeader('mcp-session-id',entry.name+'-'+randomUUID());res.end(JSON.stringify({backend:entry.name}));});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);
   backends.push({...entry,url:'http://127.0.0.1:'+server.address().port});
  }
  router=await createRouter({backends,store,dir:path.join(dir,'router'),port:0,window:4});
  const post=async(url,key,body)=>{const r=await fetch(router.url+url,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body)});const s=await r.text();return {status:r.status,body:s?JSON.parse(s):null};};
  const env={SSAM_O11_STUDIO_ROOT:'/studio/o11',SSAM_O11_CLI_ROOT:'/app/kernel/.local/o11',SSAM_IMAGE_O11:Object.keys(O11).join(',')};
  let combinations=0;
  for(const odc of ODC)for(const [o11,o11Build] of Object.entries(O11)){
   const name=`ODC ${odc} x O11 ${o11}`;
   const license=store.issue({customer:'Synthetic '+odc+' '+o11,lanes:['odc','o11']});
   const hello={t:'hello',protocol:'ssam-agent/1',instance:randomUUID(),agent:{odcCommands:['merge','reconcile-merge']},
    pack:{lanes:['odc','o11'],odcBridge:'v109',o11BuiltFor:o11,o11Hook:'dev'},
    studios:{odc:{installed:{version:odcBuild(odc)}},o11:{installed:{version:o11Build}}}};
   assert.equal(selectBackend(backends,hello).name,'odc-'+odc,name+': router selection');
   const welcome=await post('/agent/v1/hello',license.agentCredential,hello);
   assert.equal(welcome.status,200,name+': '+JSON.stringify(welcome.body));
   assert.equal(hubs['odc-'+odc].link(license.id).connected(),true,name+': the hub of its ODC version holds the channel');
   for(const other of Object.keys(hubs).filter(n=>n!=='odc-'+odc))assert.equal(hubs[other].link(license.id).connected(),false,name+': '+other);
   assert.equal((await post('/mcp',license.token,{})).body.backend,'odc-'+odc,name+': the MCP session follows the hello');
   const k=welcome.body.kernel;
   assert.equal(k.odc,odc,name);assert.equal(k.o11,o11,name+': welcome.kernel.o11 is the customer Service Studio');
   assert.equal(k.builds.o11,o11Build,name);assert.equal(k.builds.odc,odcBuild(odc),name);
   assert.deepEqual(k.servedVersions.o11,Object.keys(O11),name);
   assert.deepEqual([...k.servedVersions.odc].sort(),[...ODC],name);
   assert.equal(welcome.body.compatible.odc.ok,true,name+' odc '+JSON.stringify(welcome.body.compatible.odc));
   assert.equal(welcome.body.compatible.o11.ok,true,name+' o11 '+JSON.stringify(welcome.body.compatible.o11));
   assert.equal(welcome.body.compatible.o11.warning,undefined,name);
   for(const [lane,version] of [['odc',odcBuild(odc)],['o11',o11Build]]){
    const identity=studioIdentity(lane,version,k);
    assert.equal(identity.relation,'same',name+' '+lane);assert.equal(studioWarningOf(identity),null,name+' '+lane);
    assert.doesNotThrow(()=>checkPid(k,lane,version),name+': CheckPid '+lane);
   }
   assert.equal(checkO11Build(k,o11Build,hello.pack),null,name+': CheckO11Build with the pack of its own Studio');
   // A single-build pack built for the default kernel still binds inside the window (with the agent's own notice).
   assert.equal(checkO11Build(k,o11Build,{o11BuiltFor:'11.55.95'}),o11==='11.55.95'?null:'O11_BRIDGE_BUILT_FOR_DIFFERS',name);
   const ctx=hostedO11({agent:{kernel:()=>hubs['odc-'+odc].link(license.id).kernel()},fallback:{studioDir:'/studio/o11/11.55.95',lane:'o11'},env});
   assert.equal(ctx.version,o11,name);assert.equal(ctx.studioDir.split(path.sep).join('/'),'/studio/o11/'+o11,name);
   assert.equal(ctx.cli.split(path.sep).join('/'),`/app/kernel/.local/o11/${o11}/cli/anvil.dll`,name);
   combinations++;
  }
  assert.equal(combinations,16);
 }finally{await router?.close();for(const h of Object.values(hubs))await h.close();for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}fs.rmSync(dir,{recursive:true,force:true});}
});

test('window 4x4: Studios outside the window keep the rules of the pairs (default backend, older refused, newer warned)', async()=>{
 const compose=generateCompose(manifest4x4);
 const routing=JSON.parse(compose.services['ssam-router'].environment.SSAM_ROUTER_BACKENDS);
 const hello=(odc,o11)=>({studios:{...(odc?{odc:{installed:{version:odc}}}:{}),...(o11?{o11:{installed:{version:o11}}}:{})}});
 assert.equal(selectBackend(routing,hello('1.7.33.1','11.55.92.1')).name,'odc-1.7.32','an ODC newer than the window: the newest backend');
 assert.equal(selectBackend(routing,hello('1.7.28.1','11.55.95.1')).name,'odc-1.7.32','an ODC older than the window: the default');
 assert.equal(selectBackend(routing,hello(null,'11.55.93.1')).name,'odc-1.7.32','an O11-only customer: the default');
 const served=JSON.parse(compose.services['ssam-server-v1'].environment.SSAM_SERVED_VERSIONS);
 const hub=createAgentHub({dir:fs.mkdtempSync(path.join(os.tmpdir(),'window-4x4-out-')),store:createTokenStore(fs.mkdtempSync(path.join(os.tmpdir(),'window-4x4-tok-'))),
  kernel:{odc:'1.7.32',o11:'11.55.95',odcBridge:'v109',o11Builds:{...O11},servedVersions:served},limits:{sweepMs:60000,deadAfterMs:600000}});
 try{
  const {compatibility}=await import('../agent-hub.mjs');
  const kernel={odc:'1.7.32',o11:'11.55.95',odcBridge:'v109',o11Builds:{...O11},servedVersions:served};
  const pack=o11=>({lanes:['o11'],o11BuiltFor:o11,o11Hook:'dev'});
  // An older Service Studio: the default kernel judges it, STUDIO_UPDATE_REQUIRED (no kernel of its own).
  const older=compatibility({studios:{o11:{installed:{version:'11.55.91.1'}}},pack:pack('11.55.92')},kernel,['o11']).o11;
  assert.equal(older.ok,false);assert.equal(older.studio.relation,'older');
  // A newer one: served by the default kernel with the newer warning, as on the pairs.
  const newer=compatibility({studios:{o11:{installed:{version:'11.55.96.1'}}},pack:pack('11.55.95')},kernel,['o11']).o11;
  assert.equal(newer.ok,true);assert.equal(newer.warning.code,'studioNewerThanServed');
  // A served one with a pack built for another served Studio: accepted inside the window.
  assert.equal(compatibility({studios:{o11:{installed:{version:O11['11.55.93']}}},pack:pack('11.55.92')},kernel,['o11']).o11.ok,true);
 }finally{await hub.close();}
});

// The customer changes its Service Studio under a live session (pong.versions): the hub closes the channel as before, the
// agent says Hello again on the SAME backend (the router selects by ODC), and the kernel of its new Studio serves it; the
// hosted context of that customer (getters) follows without being rebuilt.
test('window 4x4: a Service Studio change mid-session stays on its backend and switches the customer kernel', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'window-4x4-pong-'));
 const store=createTokenStore(path.join(dir,'tokens')),license=store.issue({customer:'Synthetic',lanes:['odc','o11']});
 const served={odc:['1.7.32','1.7.31'],o11:Object.keys(O11)};
 const hubs={},servers=[],backends=[];let router;
 try{
  for(const [i,odc] of ['1.7.32','1.7.31'].entries()){
   const name='odc-'+odc;
   const hub=createAgentHub({dir:path.join(dir,name),store,kernel:{odc,o11:'11.55.95',odcBridge:'v109',builds:{odc:odcBuild(odc),o11:O11['11.55.95']},o11Builds:{...O11},servedVersions:served},limits:{sweepMs:60000,deadAfterMs:600000}});hubs[name]=hub;
   const server=http.createServer(async(req,res)=>{if(req.url.startsWith('/agent'))return hub.handle(req,res);req.resume();res.end(JSON.stringify({backend:name}));});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);
   backends.push({name,odc,o11:Object.keys(O11),default:i===0,url:'http://127.0.0.1:'+server.address().port});
  }
  router=await createRouter({backends,store,dir:path.join(dir,'router'),port:0,window:4});
  const post=async(url,key,body)=>{const r=await fetch(router.url+url,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body)});const s=await r.text();return {status:r.status,body:s?JSON.parse(s):null};};
  const hello={t:'hello',protocol:'ssam-agent/1',instance:randomUUID(),agent:{odcCommands:['merge','reconcile-merge']},
   pack:{lanes:['odc','o11'],odcBridge:'v109',o11BuiltFor:'11.55.92',o11Hook:'dev'},
   studios:{odc:{installed:{version:odcBuild('1.7.31')}},o11:{installed:{version:O11['11.55.92']}}}};
  const first=await post('/agent/v1/hello',license.agentCredential,hello);
  assert.equal(first.status,200);assert.equal(first.body.kernel.o11,'11.55.92');
  const link=hubs['odc-1.7.31'].link(license.id);
  const env={SSAM_O11_STUDIO_ROOT:'/studio/o11',SSAM_O11_CLI_ROOT:'/app/kernel/.local/o11',SSAM_IMAGE_O11:Object.keys(O11).join(',')};
  const ctx=hostedO11({agent:{kernel:()=>link.kernel()},fallback:{studioDir:'/studio/o11/11.55.95',lane:'ss4'},env});
  assert.equal(ctx.version,'11.55.92');
  hello.studios.o11.installed.version=O11['11.55.94'];hello.pack.o11BuiltFor='11.55.94';
  await post('/agent/v1/messages?channel='+first.body.channel,license.agentCredential,{messages:[{t:'pong',versions:{studios:hello.studios}}]});
  assert.equal(link.connected(),false,'a Studio change closes the channel, as on the pairs');
  const again=await post('/agent/v1/hello',license.agentCredential,hello);
  assert.equal(again.status,200);assert.equal(again.body.kernel.o11,'11.55.94');assert.equal(again.body.kernel.builds.o11,O11['11.55.94']);
  assert.equal(again.body.compatible.o11.ok,true);assert.equal(again.body.compatible.odc.ok,true);
  assert.equal(hubs['odc-1.7.31'].link(license.id).connected(),true,'the same backend: the router never moves it for an O11 change');
  assert.equal(hubs['odc-1.7.32'].link(license.id).connected(),false);
  assert.equal(ctx.version,'11.55.94','the live context follows the new kernel');
  assert.equal(ctx.studioDir.split(path.sep).join('/'),'/studio/o11/11.55.94');
 }finally{await router?.close();for(const h of Object.values(hubs))await h.close();for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}fs.rmSync(dir,{recursive:true,force:true});}
});
