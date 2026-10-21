import '../tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runtimeDir,customerStateDir} from './storage.mjs';
import {prepareWorkspace} from '../executor.mjs';
test('version runtime files and customer relay keys never overlap',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'version-storage-'));
 const previous=process.env.SSAM_BACKEND_NAME;
 try{
  assert.equal(runtimeDir(root,''),root);
  assert.notEqual(runtimeDir(root,'v1'),runtimeDir(root,'v2'));
  assert.throws(()=>runtimeDir(root,'../escape'));
  process.env.SSAM_BACKEND_NAME='v1';const first=prepareWorkspace(root),key=fs.readFileSync(path.join(first,'bridge.key'),'utf8');
  process.env.SSAM_BACKEND_NAME='v2';const second=prepareWorkspace(root);
  assert.notEqual(first,second);assert.equal(fs.readFileSync(path.join(first,'bridge.key'),'utf8'),key);
  assert.equal(second,path.join(customerStateDir(root),'relay-authority'));
 }finally{if(previous===undefined)delete process.env.SSAM_BACKEND_NAME;else process.env.SSAM_BACKEND_NAME=previous;fs.rmSync(root,{recursive:true,force:true});}
});
import * as storage from './storage.mjs';
test('machine pin keeps the earliest identity across backend changes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'version-pins-'));
 try{
  for(const [version,id,at] of [['old','original','2026-01-01'],['new','later','2026-02-01']]){
   const dir=runtimeDir(root,version);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'machine-pins.json'),JSON.stringify({token:{id,at}}));
  }
  assert.equal(storage.readMachinePin(root,'token').id,'original');
  assert.equal(storage.readMachinePin(root,'missing'),null);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
