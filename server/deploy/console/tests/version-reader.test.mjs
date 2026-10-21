import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {versionReader} from '../version-reader.mjs';import {createAuditReader} from '../readers.mjs';
test('version readers include both writers and resume individual offsets',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'console-versions-'));const records=[];
 try{for(const name of ['v1','v2']){const folder=path.join(dir,'versions',name);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'audit-20261020.jsonl'),JSON.stringify({time:'2026-10-20T12:00:00Z',token:name})+'\n');}
 const reader=versionReader(createAuditReader,{dir,onRecord:r=>records.push(r)});await reader.tick();assert.equal(records.length,2);
 const next=versionReader(createAuditReader,{dir,onRecord:r=>records.push(r)});next.restore(reader.checkpoint());await next.tick();assert.equal(records.length,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
