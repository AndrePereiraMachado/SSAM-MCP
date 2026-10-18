import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {DEBUG_STATE_AREAS,debugStateBase,debugStateRoot,legacyDebugStateRoots,debugStoreInventory,localAppDataViews} from '../debug-state-root.mjs';
import {privateInspectionVault} from '../debug-private-inspection.mjs';
import {isPreviewProfile} from '../debug-invoke-browser.mjs';
const isWindows=process.platform==='win32';
function tree(t){
 const top=fs.mkdtempSync(path.join(os.tmpdir(),'debug-state-root-'));t.after(()=>fs.rmSync(top,{recursive:true,force:true}));
 const home=path.join(top,'home'),local=path.join(home,'AppData','Local'),view=path.join(top,'view'),packages=path.join(local,'Packages');
 const store=(base,legacy='DebugInvoke')=>{const dir=path.join(base,'SSAM',legacy);fs.mkdirSync(dir,{recursive:true});return dir;};
 const pkg=(pfn,legacy)=>store(path.join(packages,pfn,'LocalCache','Local'),legacy);
 fs.mkdirSync(local,{recursive:true});fs.mkdirSync(view,{recursive:true});
 return {top,home,local,view,packages,store,pkg,env:{USERPROFILE:home,LOCALAPPDATA:view}};
}
// Every path under the fake tree with its size and mtime: proves that listing never creates, writes or deletes.
const snapshot=dir=>{const out=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name),s=fs.lstatSync(p);out.push(p+'|'+s.size+'|'+s.mtimeMs);if(e.isDirectory())walk(p);}};walk(dir);return out.sort();};

test('debugger vault areas live under %USERPROFILE%\\.ssam-hybrid\\debugger with an absolute SSAM_DEBUG_STATE_ROOT override',()=>{
 const env={USERPROFILE:'C:\\Users\\fixture'};
 assert.deepEqual(Object.keys(DEBUG_STATE_AREAS).slice(0,3),['app-user','app-user-profiles','invoke']);
 for(const area of ['app-user','app-user-profiles','invoke'])assert.equal(debugStateRoot(area,env),path.join('C:\\Users\\fixture','.ssam-hybrid','debugger',area));
 assert.equal(debugStateBase(env),path.join('C:\\Users\\fixture','.ssam-hybrid','debugger'));
 assert.doesNotMatch(debugStateBase(env),/\\\.ssam\\/);
 const override=path.join(os.tmpdir(),'debug-state-override');
 assert.equal(debugStateRoot('invoke',{...env,SSAM_DEBUG_STATE_ROOT:override}),path.join(override,'invoke'));
 for(const bad of ['relative\\state','C:\\x\\..\\y','C:\\Users\\fixture\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Local\\state'])
  assert.throws(()=>debugStateBase({...env,SSAM_DEBUG_STATE_ROOT:bad}),/debug_state_root_override_invalid/);
 assert.throws(()=>debugStateRoot('Accounts',env),/debug_state_root_area_invalid/);
});

test('legacy stores are listed read only and tagged current|real|package:<PFN>',t=>{
 const f=tree(t);f.store(f.view);f.store(f.local);f.pkg('Claude_pzs8sxrjxfjjc');const codex=f.pkg('OpenAI.Codex_2p2nqsd0c76g0');
 fs.mkdirSync(path.join(f.packages,'Other.App_123','LocalCache','Local'),{recursive:true});f.pkg('Profiles.Only_1','DebugAppUserProfiles');
 for(let i=0;i<3;i++)fs.writeFileSync(path.join(codex,randomUUID()+'.dpapi'),'sealed');
 const before=snapshot(f.top);
 const roots=legacyDebugStateRoots('invoke',{env:f.env});
 assert.deepEqual(roots.map(r=>r.origin),['current','real','package:Claude_pzs8sxrjxfjjc','package:OpenAI.Codex_2p2nqsd0c76g0']);
 assert.deepEqual(roots.map(r=>r.writable),[true,false,false,false]);
 assert.equal(roots[3].path,codex);
 const inventory=debugStoreInventory('invoke',{env:f.env,stateRoot:path.join(f.top,'state','invoke')});
 assert.equal(inventory.stateRoot,path.join(f.top,'state','invoke'));
 assert.deepEqual(inventory.legacyInventory,[{origin:'current',entries:0,readable:true},{origin:'real',entries:0,readable:true},
  {origin:'package:Claude_pzs8sxrjxfjjc',entries:0,readable:true},{origin:'package:OpenAI.Codex_2p2nqsd0c76g0',entries:3,readable:true}]);
 assert.equal(inventory.empty,false);assert.deepEqual(inventory.pending,['legacy-store:OpenAI.Codex_2p2nqsd0c76g0']);
 assert.equal(fs.existsSync(path.join(f.top,'state')),false,'a missing state root is reported, never created');
 assert.deepEqual(snapshot(f.top),before,'listing and inventory write nothing');
 assert.deepEqual(legacyDebugStateRoots('app-user-profiles',{env:f.env}).map(r=>r.origin),['current','real','package:Profiles.Only_1']);
});

test('the process view and the real folder collapse to one current store when they are the same folder',t=>{
 const f=tree(t),env={USERPROFILE:f.home,LOCALAPPDATA:f.local};
 assert.deepEqual(legacyDebugStateRoots('app-user',{env}).map(r=>r.origin),['current']);
 assert.deepEqual(localAppDataViews(env).map(v=>v.origin),['current']);
 assert.deepEqual(localAppDataViews(f.env).map(v=>v.origin),['current','real']);
});

test('symlinked or junctioned stores are refused, never followed, and keep the inventory incomplete',{skip:!isWindows},t=>{
 const f=tree(t),outside=path.join(f.top,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'lease.dpapi'),'x');
 fs.mkdirSync(path.join(f.packages,'Evil.App_1','LocalCache','Local'),{recursive:true});
 fs.symlinkSync(outside,path.join(f.packages,'Evil.App_1','LocalCache','Local','SSAM'),'junction');
 const roots=legacyDebugStateRoots('app-user',{env:f.env}),evil=roots.find(r=>r.origin==='package:Evil.App_1');
 assert.ok(evil,'a reparse store is listed, not silently skipped');
 const inventory=debugStoreInventory('app-user',{env:f.env,stateRoot:path.join(f.top,'state','app-user')});
 const row=inventory.stores.find(s=>s.origin==='package:Evil.App_1');
 assert.equal(row.readable,false);assert.equal(row.error,'reparse');assert.equal(row.entries,0);
 assert.equal(inventory.empty,false);assert.ok(inventory.pending.includes('legacy-store:Evil.App_1'));
 const stateLink=path.join(f.top,'linked');fs.mkdirSync(stateLink);fs.symlinkSync(outside,path.join(stateLink,'app-user'),'junction');
 const linked=debugStoreInventory('app-user',{env:f.env,stateRoot:path.join(stateLink,'app-user'),legacyRoots:[]});
 assert.equal(linked.stores[0].readable,false);assert.equal(linked.stores[0].error,'reparse');assert.deepEqual(linked.pending,['store:state']);
});

test('an unreadable Packages folder is reported as an unreadable legacy store',t=>{
 const f=tree(t);fs.writeFileSync(f.packages,'not a directory');
 const roots=legacyDebugStateRoots('invoke',{env:f.env});
 const row=debugStoreInventory('invoke',{env:f.env,stateRoot:path.join(f.top,'state','invoke'),legacyRoots:roots}).stores.find(s=>s.origin==='packages');
 assert.ok(row);assert.equal(row.readable,false);
});

test('the Codex preview profile is recognised from the process view and from the real folder',t=>{
 const f=tree(t);
 assert.equal(isPreviewProfile(path.join(f.local,'Packages','OpenAI.Codex_abc123','LocalCache','Local','CodexBrowserPreview'),localAppDataViews(f.env).map(v=>v.path)),true);
 assert.equal(isPreviewProfile(path.join(f.view,'CodexBrowserPreview'),localAppDataViews(f.env).map(v=>v.path)),true);
 assert.equal(isPreviewProfile(path.join(f.top,'elsewhere','CodexBrowserPreview'),localAppDataViews(f.env).map(v=>v.path)),false);
});

test('the invoke vault seals only under the new root, opens a legacy copy read only and forgets only writable stores',{skip:!isWindows},t=>{
 const f=tree(t),saved={...process.env};t.after(()=>{for(const k of ['SSAM_DEBUG_STATE_ROOT','LOCALAPPDATA','USERPROFILE'])saved[k]===undefined?delete process.env[k]:process.env[k]=saved[k];});
 const state=path.join(f.top,'state'),viewStore=f.store(f.view),codex=f.pkg('OpenAI.Codex_2p2nqsd0c76g0');
 Object.assign(process.env,{SSAM_DEBUG_STATE_ROOT:state,LOCALAPPDATA:f.view,USERPROFILE:f.home});
 const ref=randomUUID(),value={schema:'synthetic',value:'synthetic-not-a-secret-Ω'};
 assert.equal(privateInspectionVault('Seal',ref,value).ok,true);
 const sealed=path.join(state,'invoke',ref+'.dpapi');assert.equal(fs.existsSync(sealed),true);
 assert.deepEqual(fs.readdirSync(viewStore),[]);assert.deepEqual(fs.readdirSync(codex),[]);
 assert.deepEqual(privateInspectionVault('Open',ref),value);
 // A record in another package store (same Windows user, same entropy) opens read only from that store.
 fs.copyFileSync(sealed,path.join(codex,ref+'.dpapi'));fs.copyFileSync(sealed,path.join(viewStore,ref+'.dpapi'));
 assert.equal(privateInspectionVault('Forget',ref).ok,true);
 assert.equal(fs.existsSync(sealed),false);assert.equal(fs.existsSync(path.join(viewStore,ref+'.dpapi')),false,'own legacy view is forgotten');
 assert.equal(fs.existsSync(path.join(codex,ref+'.dpapi')),true,'another package store is never written');
 assert.deepEqual(privateInspectionVault('Open',ref,undefined,{sourceRoot:codex}),value);
 assert.throws(()=>privateInspectionVault('Open',ref),/vault_unavailable/);
 const wrong=path.join(f.top,'NotAStore');fs.mkdirSync(wrong);fs.copyFileSync(path.join(codex,ref+'.dpapi'),path.join(wrong,ref+'.dpapi'));
 assert.throws(()=>privateInspectionVault('Open',ref,undefined,{sourceRoot:wrong}),/vault_unavailable/);
});

test('the foreign invoke transport (debug-invoke-http) also lands in the new root without any argument change',{skip:!isWindows},async t=>{
 const f=tree(t),saved={...process.env};t.after(()=>{for(const k of ['SSAM_DEBUG_STATE_ROOT','LOCALAPPDATA','USERPROFILE'])saved[k]===undefined?delete process.env[k]:process.env[k]=saved[k];});
 const state=path.join(f.top,'state'),viewStore=f.store(f.view);
 Object.assign(process.env,{SSAM_DEBUG_STATE_ROOT:state,LOCALAPPDATA:f.view,USERPROFILE:f.home});
 const {privateRequest}=await import('../debug-invoke-http.mjs'),plan=randomUUID();
 assert.deepEqual(await privateRequest('Seal',plan,{synthetic:true}),{ok:true});
 assert.equal(fs.existsSync(path.join(state,'invoke',plan+'.dpapi')),true);assert.deepEqual(fs.readdirSync(viewStore),[]);
 assert.deepEqual(await privateRequest('Open',plan),{synthetic:true});
 assert.deepEqual(await privateRequest('Forget',plan),{ok:true});assert.equal(fs.existsSync(path.join(state,'invoke',plan+'.dpapi')),false);
});
