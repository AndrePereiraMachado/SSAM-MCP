import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createSources} from '../sources.mjs';
test('console combines machine pins from all version directories',()=>{
 const serverDir=fs.mkdtempSync(path.join(os.tmpdir(),'pins-'));
 try{for(const [name,id]of [['v1','tok_111111111111'],['v2','tok_222222222222']]){const dir=path.join(serverDir,'versions',name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'machine-pins.json'),JSON.stringify({[id]:{id:name,name,user:'Test',at:'2026-10-20T00:00:00Z'}}));}
 assert.equal(Object.keys(createSources({serverDir}).pins()).length,2);
 }finally{fs.rmSync(serverDir,{recursive:true,force:true});}
});
