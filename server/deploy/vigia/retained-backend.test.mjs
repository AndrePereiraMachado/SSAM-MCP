// F1 review A1 (C:\t\r5\f1-offers\REVISAO-F1.md): the post-deployment check runs one source in EVERY running backend. A retained
// backend that shares a Studio version with the new pair (r1-kernels v5: 1.7.32 / 11.55.95, deployed server-only, no bridges) must
// never be asked the new pair's signed offers, and exactly one backend (the new pair's) must offer and deliver all of them.
// Started from the reviewer's repro (review\retained-backend.test.mjs): the real hub compatibility, the real bridge store and the
// real check-backend.mjs; only the backend's HTTP, its token store and its kernel file are fakes. Several backends, never one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {compatibility} from '../../platforms/odc/facade/agent-hub.mjs';
import {createBridgeStore} from '../../platforms/odc/facade/bridge-store.mjs';
import {toolListingBytes} from '../../platforms/odc/facade/tool-listing.mjs';
import {parseAgentRelease,offersGate} from './server-only.mjs';
import {createAutoRuntime} from './auto-runtime.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const read=rel=>fs.readFileSync(path.resolve(here,'../../..',rel),'utf8');
const tmp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'retained-backend-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const sha=b=>createHash('sha256').update(b).digest('hex');
const KERNELS=JSON.parse(read('server/deploy/coolify/r1-kernels.json'));
const release=parseAgentRelease({commit:'c'.repeat(40),program:read('agent/platforms/odc/studio/bridge/client/Program.cs'),kinds:read('agent/agent/lib/kinds.mjs'),native:read('agent/native/Ssam.Agent/StudioKinds.cs'),bridgeProject:read('agent/platforms/odc/studio/bridge/Bridge.csproj')});
const example=JSON.parse(fs.readFileSync(path.join(here,'config.example.json'),'utf8'));
const config={bridgeMode:'ed25519-offers',agentPack:example.agentPack,agentPackByRuntime:example.agentPackByRuntime};
// The next pair of the review's scenario: a new ODC Studio 1.7.33 with the kept Service Studio 11.55.95 of the retained v5.
const pair={odc:'1.7.33',o11:'11.55.95',lanes:['odc']};
const studios={odc:{version:'1.7.33',fullVersion:'1.7.33.11100',tfm:'net10.0'},o11:{version:'11.55.95',fullVersion:'11.55.95.65352',tfm:'net10.0'}};
const served={odc:['1.7.33','1.7.32','1.7.31','1.7.30','1.7.29'],o11:['11.55.95','11.55.94','11.55.93']};

// A signed stage as buildBridges lays it out: both lanes of the new pair (buildBridges always builds both).
function stage(t,{keys=generateKeyPairSync('ed25519')}={}){
 const root=tmp(t);fs.writeFileSync(path.join(root,'public-key.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
 const offers=[];
 for(const [lane,studioVersion,protocol,files] of [['odc','1.7.33','v109',[['bridge/ODC3.Bridge.v109.dll','owner'],['client/ODC3.Bridge.Client.dll','owner'],['client/ODC3.Bridge.Client.runtimeconfig.json',null]]],['o11','11.55.95','d1',[['bridge/Anvil.Bridge.dll','owner'],['hook/Anvil.RuntimeHook.Agent.dll','owner']]]]){
  const dir=path.join(root,lane,studioVersion,protocol),list=[];
  for(const [rel,signer] of files){const bytes=Buffer.from('fixture '+lane+' '+rel);fs.mkdirSync(path.dirname(path.join(dir,rel)),{recursive:true});fs.writeFileSync(path.join(dir,rel),bytes);list.push({path:rel,sha256:sha(bytes),size:bytes.length,...(signer?{signer}:{})});}
  const raw=Buffer.from(JSON.stringify({schema:1,lane,studioVersion,runtime:'net10.0',protocol,sequence:1,createdAt:new Date().toISOString(),files:list}));
  fs.writeFileSync(path.join(dir,'manifest.json'),raw);fs.writeFileSync(path.join(dir,'manifest.sig'),sign(null,raw,keys.privateKey));
  offers.push({lane,studioVersion,protocol,sequence:1});
 }
 return {root,offers,store:createBridgeStore({root,publicKey:keys.publicKey})};
}
const emptyStore=t=>createBridgeStore({root:tmp(t),publicKey:generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'})});

// A backend: its kernel.json, its signed store and the window it was deployed with; source is the whole check source as the remote
// verifier pipes it (const expected=...; + check-backend.mjs). The model plugins mount is the other test's (vigia/remote): skipped.
async function backend(source,{kernel,bridges}){
 const src=source.split('\n').filter(l=>!/^import /.test(l)&&!/^const store=await openTokenStore/.test(l)).join('\n').replace(/^(const expected=.*;)$/m,'$1delete expected.modelPlugins;');
 const out=[],posted=[];
 const fetch=async(url,init={})=>{const route=new URL(url).pathname,body=init.body?JSON.parse(init.body):null;
  if(route==='/health')return new Response('{}');
  if(route==='/agent/v1/hello'){posted.push(body);return new Response(JSON.stringify({ok:true,compatible:compatibility(body,{...kernel,servedVersions:served},['odc','o11'],{bridges})}));}
  if(route.startsWith('/agent/bridges/')){const [,,,lane,v,p,digest]=route.split('/');const file=bridges.file(lane,v,p,digest);return file?new Response(fs.readFileSync(file)):new Response('',{status:404});}
  if(route==='/mcp'){if(body.method==='initialize')return new Response(JSON.stringify({result:{}}),{headers:{'mcp-session-id':'s'}});if(body.method==='tools/list')return new Response(JSON.stringify({result:{tools:[{name:'a',description:'b',inputSchema:{}}]}}));return new Response('');}
  return new Response('',{status:404});};
 const store={issue:async()=>({id:'x',agentCredential:'ssam_agent_x',token:'t'}),revoke:async()=>{},list:async()=>[]};
 const fakeFs={readFileSync:f=>{if(String(f).endsWith('/kernel.json'))return JSON.stringify(kernel);throw Error('unexpected read '+f);}};
 const AF=(async()=>{}).constructor;
 await new AF('fs','path','createHash','store','toolListingBytes','readStudioVersions','fetch','console','process',src)(fakeFs,path,createHash,store,toolListingBytes,()=>null,fetch,{log:x=>out.push(x)},{env:{}});
 return {receipt:JSON.parse(out.at(-1)),posted};
}
const withExpected=(expected,budget={tools:1,totalBytes:1e6,core:[]})=>'const expected='+JSON.stringify({budget,...expected})+';\n'+fs.readFileSync(path.join(here,'check-backend.mjs'),'utf8');

test('the reviewer\'s repro: one list of offers sent to every backend fails the retained one; keyed by pair it passes and asks none',async t=>{
 const v5=KERNELS.v5,offers=[{lane:'odc',studioVersion:'1.7.33',protocol:'v109',sequence:1},{lane:'o11',studioVersion:'11.55.95',protocol:'d1',sequence:1}];
 const keyed={packHellos:{'11.55.95|1.7.33':{}},offerHellos:{'11.55.95|1.7.33':{}}};
 // What F1 sent (the review's A1): the new pair's offers as one list. The retained v5 shares 11.55.95 and has no d1.
 await assert.rejects(backend(withExpected({...keyed,offers}),{kernel:v5,bridges:emptyStore(t)}),/Signed bridge was not offered/);
 // What a deployment sends now: offers keyed by the new pair. The retained backend is asked none.
 const r=await backend(withExpected({...keyed,offers:{'11.55.95|1.7.33':offers}}),{kernel:v5,bridges:emptyStore(t)});
 assert.equal(r.receipt.ok,true);assert.equal(r.receipt.offersChecked,0);assert.equal(r.receipt.presented,false);
});

test('auto-runtime checks: the deployment check asks the new pair, and only it, for every signed offer; the retained 11.55.95 pair passes',async t=>{
 const s=stage(t),servedKernels=Object.values(KERNELS);
 const g=offersGate({config,release,pair,studios,servedKernels,served,offers:s.offers,bridges:s.store});
 assert.deepEqual(g.gaps,[]);
 // The real checks() of auto-runtime.mjs, with the SSH transport captured (no process runs, nothing leaves the machine).
 const dir=tmp(t),root=path.join(dir,'source');fs.mkdirSync(path.join(root,'server/deploy/coolify'),{recursive:true});
 fs.writeFileSync(path.join(root,'server/deploy/coolify/listing-budget.json'),JSON.stringify({tools:1,totalBytes:1e6,core:[]}));
 const requests=[];
 const runtime={executionSource:async()=>{},openLease:async()=>Object.assign(async()=>{},{assertHeld(){}}),async run(cmd,args,options){
  if(String(cmd).endsWith('icacls.exe'))return {code:0,stdout:''};
  if(String(cmd).endsWith('ssh.exe')){const request=JSON.parse(options.input);requests.push(request);return {code:0,stdout:JSON.stringify({ok:true})};}
  throw Error('unexpected command '+cmd);
 }};
 const settings={automaticDeployment:{testOnly:true,coolify:{url:'http://127.0.0.1:1',resource:'fixture'},ssh:{host:'fixture',knownHosts:'fixture',executable:'C:/fixture/ssh.exe'},remote:{}}};
 const auto=createAutoRuntime({workspace:root,tempRoot:dir,outDir:dir,...settings},runtime);
 const secrets={sshPrivateKey:Buffer.from('PRIVATE KEY').toString('base64')};
 await auto.acquireReleaseLock(secrets);
 await auto.checks(secrets,{kernel:g.kernel,bridges:{mode:'ed25519-offers',offers:s.offers,hello:g.hello,offerHello:g.offerHello,offerLanes:g.offerLanes,legacyHello:g.legacyHello,legacy:g.legacy}});
 const request=requests.find(r=>r.action==='check');
 assert.equal(request.requireOffers,2,'the remote verifier requires the two offers of the new pair');assert.equal(request.requirePresented,true);
 // Every running backend gets this one source: the new pair, the retained v5 (same Service Studio) and an older pair.
 const fresh=await backend(request.checkSource,{kernel:g.kernel,bridges:s.store});
 const retained=await backend(request.checkSource,{kernel:KERNELS.v5,bridges:emptyStore(t)});
 const older=await backend(request.checkSource,{kernel:KERNELS.v2,bridges:emptyStore(t)});
 assert.deepEqual([fresh,retained,older].map(b=>[b.receipt.ok,b.receipt.offersChecked,b.receipt.presented]),[[true,2,true],[true,0,false],[true,0,false]]);
 // The remote rule (remote-release.py check, OFFERS_NOT_CHECKED): exactly one backend offered all of them.
 const counts=[fresh,retained,older].map(b=>b.receipt.offersChecked).filter(Boolean);assert.deepEqual(counts,[request.requireOffers]);
 // The retained backend posted only the synthetic hello: no offer hello, no legacy hello, no generic offer hello.
 assert.deepEqual(retained.posted.map(h=>h.instance),['vigia-verification']);
 // A new pair's image whose store lost an offer fails its own check (it is still the one backend asked).
 await assert.rejects(backend(request.checkSource,{kernel:g.kernel,bridges:emptyStore(t)}),/received no signed bridge offer|Signed bridge was not offered/);
});
