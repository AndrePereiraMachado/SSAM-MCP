import '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { selectRecordedSources } from './measure/recorded-sources.mjs';
const temporary=[];test.after(()=>{for(const directory of temporary)fs.rmSync(directory,{recursive:true,force:true});});
function setup(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'benchmark-m3-'));temporary.push(directory);return directory;}
test('new record timestamp detects append even when LastWriteTime is restored',()=>{
 const directory=setup(),file=path.join(directory,'synthetic-rollout.jsonl');fs.writeFileSync(file,JSON.stringify({timestamp:'2026-01-01T00:00:00Z',type:'session_meta'})+'\n');
 const original=new Date('2026-01-01T00:00:00Z'),reportMtimeMs=Date.parse('2026-01-01T00:01:00Z');fs.utimesSync(file,original,original);
 const unchanged=selectRecordedSources({sessions:[{file:path.basename(file)}]},[file],{reportMtimeMs});assert.deepEqual(unchanged.changed,[]);
 fs.appendFileSync(file,JSON.stringify({timestamp:'2026-01-01T00:02:00Z',type:'event_msg'})+'\n');fs.utimesSync(file,original,original);
 const result=selectRecordedSources({sessions:[{file:path.basename(file)}]},[file],{reportMtimeMs});assert.equal(result.files.length,0);assert.equal(result.changed.length,1);assert.match(result.changed[0],/fonte mudou: synthetic-rollout.jsonl/);assert.match(result.changed[0],/timestamp/);
});
test('append after saved report skips only changed source even without recorded stat fields',()=>{
 const directory=setup(),changed=path.join(directory,'changed.jsonl'),stable=path.join(directory,'stable.jsonl');fs.writeFileSync(changed,'{}\n');fs.writeFileSync(stable,'{}\n');fs.utimesSync(stable,1000,1000);fs.utimesSync(changed,1000,1000);fs.appendFileSync(changed,'{}\n');fs.utimesSync(changed,3000,3000);
 const result=selectRecordedSources({sessions:[{file:'changed.jsonl'},{file:'stable.jsonl'}]},[changed,stable],{reportMtimeMs:2000000});assert.deepEqual(result.files,[stable]);assert.equal(result.changed.length,1);assert.match(result.changed[0],/fonte mudou: changed.jsonl/);
});
test('W1 exact recorded files ignore a newer rollout in the same dated directory',()=>{
 const dir=setup(),file=path.join(dir,'rollout-2026-10-13T01-00-00-recorded.jsonl');fs.writeFileSync(file,'{"type":"session_meta"}\n');const stat=fs.statSync(file),record={file:path.basename(file),size:stat.size,mtimeMs:stat.mtimeMs};
 const before=selectRecordedSources({sessions:[record]},[file]);
 const extra=path.join(dir,'rollout-2026-10-13T01-01-00-new.jsonl');fs.writeFileSync(extra,'{"type":"new"}\n');const after=selectRecordedSources({sessions:[record]},[file,extra]);
 assert.deepEqual(before,after);assert.deepEqual(after.files,[file]);assert.deepEqual(after.changed,[]);
});
test('recorded source size, mtime and missing file report fonte mudou rather than measured failures',()=>{
 const dir=setup(),file=path.join(dir,'recorded.jsonl');fs.writeFileSync(file,'{}\n');const stat=fs.statSync(file);
 for(const record of [{file:'missing.jsonl',size:3,mtimeMs:stat.mtimeMs},{file:path.basename(file),size:stat.size+1,mtimeMs:stat.mtimeMs},{file:path.basename(file),size:stat.size,mtimeMs:stat.mtimeMs-1000}]){
  const result=selectRecordedSources({sessions:[record]},[file]);assert.equal(result.files.length,0);assert.equal(result.changed.length,1);assert.match(result.changed[0],/fonte mudou/);
 }
});
test('unrecorded source metadata stays explicit without inventing a historical baseline',()=>{
 const dir=setup(),file=path.join(dir,'recorded.jsonl');fs.writeFileSync(file,'{}\n');const stat=fs.statSync(file),record={file:path.basename(file)};
 const result=selectRecordedSources({sessions:[record]},[file]);assert.deepEqual(result.files,[file]);assert.deepEqual(result.changed,[]);assert.match(result.diagnostics[0],/mtime\/tamanho não registrados; integridade histórica não verificável/);
});
