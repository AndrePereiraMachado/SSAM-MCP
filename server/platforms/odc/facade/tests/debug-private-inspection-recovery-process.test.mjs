import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {recoverExpiredClientInspectionAsync} from '../debug-private-inspection-recovery-process.mjs';
const target={sessionId:'a'.repeat(48),lane:'o11',runtimeUrl:'https://fixture.example/App/',moduleKey:'B'.repeat(22)};
// The child inherits this isolated profile: new root, process view and a fake Packages tree. No real store is read.
function isolated(t){
 const top=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-process-')),saved={...process.env},home=path.join(top,'home'),local=path.join(home,'AppData','Local');
 fs.mkdirSync(local,{recursive:true});
 Object.assign(process.env,{USERPROFILE:home,LOCALAPPDATA:local,SSAM_DEBUG_STATE_ROOT:path.join(top,'state')});
 t.after(()=>{for(const k of ['USERPROFILE','LOCALAPPDATA','SSAM_DEBUG_STATE_ROOT'])saved[k]===undefined?delete process.env[k]:process.env[k]=saved[k];fs.rmSync(top,{recursive:true,force:true});});
 return {top,home,local};
}
test('isolated recovery child leaves the parent event loop available and returns only cleanup evidence',async t=>{
 const f=isolated(t);
 let yielded=false;setImmediate(()=>{yielded=true;});
 const result=await recoverExpiredClientInspectionAsync(target,{dryRun:false});
 assert.equal(yielded,true);assert.equal(result.completed,true);assert.equal(result.removed,0);assert.equal(result.executionComplete,false);
 assert.equal(result.stateRoot,path.join(f.top,'state','invoke'));assert.deepEqual(result.legacyInventory,[{origin:'current',entries:0,readable:true}]);
 assert.equal(fs.existsSync(path.join(f.top,'state')),false);
});
test('a record that cannot be opened in another package store keeps recovery incomplete through the child',{skip:process.platform!=='win32'},async t=>{
 const f=isolated(t),store=path.join(f.local,'Packages','OpenAI.Codex_2p2nqsd0c76g0','LocalCache','Local','SSAM','DebugInvoke');
 fs.mkdirSync(store,{recursive:true});const file=path.join(store,randomUUID()+'.dpapi');fs.writeFileSync(file,'not a DPAPI record');
 const result=await recoverExpiredClientInspectionAsync(target,{dryRun:false});
 assert.equal(result.completed,false);assert.deepEqual(result.pendingStores,['legacy-store:OpenAI.Codex_2p2nqsd0c76g0']);
 assert.equal(result.unreadable,1);assert.equal(fs.readFileSync(file,'utf8'),'not a DPAPI record');
 assert.deepEqual(result.legacyInventory.map(r=>[r.origin,r.entries]),[['current',0],['package:OpenAI.Codex_2p2nqsd0c76g0',1]]);
});
