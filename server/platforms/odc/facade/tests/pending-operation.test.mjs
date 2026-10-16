import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {watchPendingOperation} from '../studio-pending-operation.mjs';
import {pendingOperationOf,studioWriteHolder,withStudioWriteLock} from '../studio-write-lock.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const setup=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx14-pending-')),record={pid:process.pid,port:1234};return{root,record,deps:{o11Root:root,o11Lane:'ss4',connection:()=>record,queueMs:100}}};
test('pending journal operation remains fenced until terminal, clears vanished window',async()=>{
 const {root,record,deps}=setup();let visible=true,state='unknown',journals=0;
 const bridge={ok:async method=>method==='merge_status'?(journals++,{state}):{windows:visible?[{title:'Unexpected Error',type:'DialogWindow',isVisible:true}]:[]}};
 const release=watchPendingOperation({lane:'ss4',root,record,method:'merge_from_oml',operationId:'op',moduleKey:'key',taskId:'facade',kernelTaskId:'kernel',blockedBy:{title:'Unexpected Error',kind:'UnexpectedError'},bridge,settleMs:20,capMs:500});
 try{
  const value=await withStudioWriteLock({tool:'o11_publish',deps},()=>assert.fail('fenced'));
  assert.equal(value.code,'STUDIO_WRITE_HOLDER_STALLED');assert.equal(pendingOperationOf({taskId:'facade',deps}).operation.operationId,'op');
  visible=false;await wait(60);assert.equal(studioWriteHolder({deps}).state,'pending-in-studio');assert.ok(journals>0);
  state='not-applied';await wait(60);assert.equal(studioWriteHolder({deps}),null);
 }finally{release()}
});
for(const mode of ['dead','cap','idle'])test(`pending operation releases by ${mode}`,async()=>{
 const {root,record,deps}=setup();let alive=true;
 const bridge={ok:async method=>method==='windows'?{windows:[]}:method==='ui_alive'?{alive:true}:method==='list_open_modules'?{modules:[]}:{state:'unknown'}};
 const release=watchPendingOperation({lane:'ss4',root,record,method:'open_module',...(mode==='idle'?{}:{operationId:'op'}),bridge,settleMs:15,capMs:mode==='cap'?45:500,alive:()=>alive});
 try{assert.ok(studioWriteHolder({deps}));if(mode==='dead')alive=false;await wait(100);assert.equal(studioWriteHolder({deps}),null)}finally{release()}
});

for(const bad of ['new-dialog','malformed-modules','malformed-operation','malformed-texts'])test('unjournaled pending operation requires positive idle evidence: '+bad,async()=>{
 const {root,record,deps}=setup();let healthy=false;
 const bridge={ok:async method=>method==='windows'?{windows:healthy?[]:bad==='new-dialog'?[{title:'A new question',type:'DialogWindow',isModal:true}]:bad==='malformed-texts'?[{title:'main',type:'MainWindow',texts:42}]:[]}
  :method==='ui_alive'?{alive:true}:method==='list_open_modules'?{modules:healthy?[]:bad==='malformed-modules'?['invalid']:bad==='malformed-operation'?[{serverOperation:{running:'false'}}]:[]}:{} };
 const release=watchPendingOperation({lane:'ss4',root,record,method:'refresh_references',bridge,settleMs:5,capMs:1000});
 try{await wait(35);assert.ok(studioWriteHolder({deps}),'unproven idle must retain the fence');healthy=true;await wait(35);assert.equal(studioWriteHolder({deps}),null)}finally{release()}
});
