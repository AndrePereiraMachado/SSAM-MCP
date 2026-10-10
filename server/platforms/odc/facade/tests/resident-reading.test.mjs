import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, paths, ensureBuilder, odcStudioDir } from '../lib.mjs';
import { anvilRoot } from '../workspace.mjs';
import { readSnapshot, readerRpc } from '../reader-client.mjs';

const fixture=path.join(anvilRoot,'tests/fixtures/odc/insurance-reactive-r8.oml');
test('resident native reads survive restart, bad metadata and invalid input without stale results',
  {skip:!fs.existsSync(fixture),timeout:180000}, async t=>{
    assert.equal((await ensureBuilder()).ok,true);
    const cacheRoot=path.join(root,'.local','reader-tests',randomUUID());fs.mkdirSync(cacheRoot,{recursive:true});
    const file=path.join(cacheRoot,'input.oml');fs.copyFileSync(fixture,file);
    // an empty module index store of its own: with the shared store, a listing stored by an earlier run is answered
    // from the index without loading the model, and this test checks the resident model and its answer memo
    const config={dll:path.relative(process.cwd(),paths.builder),
      runtimeDir:path.relative(process.cwd(),odcStudioDir()),
      cacheRoot:path.relative(process.cwd(),cacheRoot),platform:'odc',indexRoot:path.join(cacheRoot,'module-index')};
    const authorization=fs.readFileSync(path.join(process.env.ANVIL_AUTHORITY_DIR??path.join(process.env.LOCALAPPDATA,'Anvil','authority'),'bridge.key'),'utf8').trim();
    const states=[];
    const remember=response=>{
      const stateFile=path.join(cacheRoot,'odc',response.cache.generation,'worker.json');
      const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));states.push(state);return {state,stateFile};
    };
    t.after(async()=>{for(const state of states) try{
      const ping=await readerRpc(state,['ping'],null,1000);
      if(ping.data?.instanceId===state.instanceId) await readerRpc(state,['shutdown'],authorization,2000);
    }catch{}});
    const request={file,path:'/',options:{kind:'MobileScreen',max:2,properties:'Name'}};
    const first=await readSnapshot({...config,request});const {state,stateFile}=remember(first);
    assert.equal(first.cache.modelHit,false);assert.ok(first.data.entries.length>0);
    const second=await readSnapshot({...config,request});assert.equal(second.cache.modelHit,true);assert.equal(second.cache.queryHit,true);
    assert.deepEqual(second.data,first.data);
    const selected=first.data.entries.map(e=>e.reference);
    const batch=await readSnapshot({...config,request:{file,path:'/',select:selected,options:{depth:2,full:true}}});
    assert.equal(batch.cache.modelHit,true);assert.equal(batch.data.complete,true);
    assert.deepEqual(batch.data.entries.map(e=>e.data.tree.reference),selected);
    const denied=await readerRpc(state,['read',JSON.stringify(request)],'invalid-test-key');assert.equal(denied.ok,false);
    const mutation=await readerRpc(state,['apply','anything'],authorization);assert.equal(mutation.ok,false);
    await assert.rejects(readSnapshot({...config,request:{...request,expectedSourceSha256:'0'.repeat(64)}}),/content changed/);
    await readerRpc(state,['shutdown'],authorization);
    const restart=await readSnapshot({...config,request});remember(restart);
    assert.notEqual(restart.cache.instanceId,first.cache.instanceId);assert.equal(restart.cache.modelHit,false);
    assert.deepEqual(restart.data,first.data);
    fs.writeFileSync(stateFile,'{"partial":');
    const lock=path.join(path.dirname(stateFile),'start.lock');fs.writeFileSync(lock,'');fs.utimesSync(lock,0,0);
    const repaired=await readSnapshot({...config,request});remember(repaired);
    assert.notEqual(repaired.cache.instanceId,restart.cache.instanceId);assert.equal(repaired.cache.modelHit,false);
    fs.writeFileSync(file,'not an OML');
    await assert.rejects(readSnapshot({...config,request}));
    fs.copyFileSync(fixture,file);
    const restored=await readSnapshot({...config,request});
    assert.equal(restored.cache.modelHit,false);assert.deepEqual(restored.data,first.data);
  });
