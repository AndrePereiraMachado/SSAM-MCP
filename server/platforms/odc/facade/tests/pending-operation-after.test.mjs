import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {studioWriteHolder} from '../studio-write-lock.mjs';
import {watchPendingOperation} from '../studio-pending-operation.mjs';

// CX14 N3: the kernel records a UI call (open/refresh/close) that its resume sent and that then stopped beside a pending
// merge (pendingBridgeOperation.after). The fence of that merge is released by a terminal journal only once that call is
// proven idle too (two positive reads: no dialog, UI thread alive, nothing opening). Synthetic values; a fake bridge object.
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('a journaled fence also waits for a UI call stopped beside it: a terminal journal releases it only after idle',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx14-n3-')),auth=path.join(root,'authority');fs.mkdirSync(auth);
  const record={pid:process.pid,startedUtc:'2026-10-15T00:31:00.000Z',port:12345,authorityDir:auth};
  const file=path.join(root,'.local','connections','ss4.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({ok:true,lane:'o11',anvilLane:'ss4',...record,studioDir:root}));
  const deps={o11Root:root,o11Lane:'ss4'};
  let alive=false,journal='unknown';
  const bridge={ok:async verb=>verb==='merge_status'?{state:journal}:verb==='windows'?{windows:[]}:verb==='ui_alive'?{alive}:verb==='list_open_modules'?{modules:[]}:{}};
  const release=watchPendingOperation({lane:'ss4',root,record,method:'merge_from_oml',operationId:'0123456789abcdef0123456789abcdef',moduleKey:'KEY-A',
    taskId:'facade',kernelTaskId:'fedcba9876543210fedcba9876543210',after:[{method:'open_module',moduleKey:'KEY-A'}],bridge,settleMs:15,capMs:5000});
  try{
    journal='not-applied';await wait(120);
    assert.equal(studioWriteHolder({lane:'o11',deps})?.tool,'bridge:merge_from_oml','the stopped open still runs: the fence stays');
    alive=true;await wait(120);
    assert.equal(studioWriteHolder({lane:'o11',deps}),null,'idle proven and journal terminal: released');
  }finally{release()}
});
test('without a stopped call beside it, a terminal journal releases the fence at once, as before',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx14-n3-')),auth=path.join(root,'authority');fs.mkdirSync(auth);
  const record={pid:process.pid,startedUtc:'2026-10-15T00:31:00.000Z',port:12345,authorityDir:auth};
  const file=path.join(root,'.local','connections','ss4.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({ok:true,lane:'o11',anvilLane:'ss4',...record,studioDir:root}));
  let reads=0;
  const bridge={ok:async verb=>{if(verb==='ui_alive'||verb==='list_open_modules')reads++;return verb==='merge_status'?{state:'not-applied'}:verb==='windows'?{windows:[]}:{}}};
  const release=watchPendingOperation({lane:'ss4',root,record,method:'merge_from_oml',operationId:'0123456789abcdef0123456789abcdef',moduleKey:'KEY-A',bridge,settleMs:15,capMs:5000});
  try{await wait(80);assert.equal(studioWriteHolder({lane:'o11',deps:{o11Root:root,o11Lane:'ss4'}}),null);assert.equal(reads,0)}finally{release()}
});
