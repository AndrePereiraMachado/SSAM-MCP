import '../tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createStore} from '../../../../facade/friction-store.mjs';
test('shared friction uses separate mutable indexes and reads all versions',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'friction-versions-'));
 try{for(const name of ['v1','v2']){const store=createStore({directory,env:{SSAM_BACKEND_NAME:name}});store.begin({operation:'ssam_map',interface:'mcp'}).finish({ok:false,code:'BUILD_FAILED'});store.issues();assert.ok(fs.existsSync(path.join(directory,'index','versions',name,'.complete')));}
 const store=createStore({directory,env:{SSAM_BACKEND_NAME:'v1'}});assert.deepEqual(store.issues().issues,store.issues({source:'scan'}).issues);assert.equal(store.issues().issues[0].count,2);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
