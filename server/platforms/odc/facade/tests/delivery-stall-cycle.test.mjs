import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deliverOutcome,settledUiOf} from '../o11-cycle.mjs';
import envelopes from './fixtures/o11-cycle-envelopes.json' with {type:'json'};
import receipts from './fixtures/cx14-n7-receipts.json' with {type:'json'};

// CX14 R3: once the kernel proved that the UI call a task left pending ended (two idle reads), the answers never point at
// each other. A task whose write never reached the module answers the close it accepts; an applied one keeps its refusal
// with merged and Ctrl+Z. The receipts below are the kernel's shape after the settlement. Synthetic values only.
const ID='7b2f1eb839fb48c095442cf12168304d';
const work=()=>fs.mkdtempSync(path.join(os.tmpdir(),'cx14-r3-'));
const settled=method=>[{method,moduleKey:'K',stall:{verdict:'dialog',method,blockedBy:{title:'Unexpected Error',type:'DialogWindow',kind:'UnexpectedError'}},
  idleProof:{idle:true},settledAt:'2026-10-15T00:30:00Z'}];

// CX14 N2 (declared): the R3 test above said "nothing of this task reached the module" and gave the close. A settled Refresh
// References may have changed the module: every answer names it with Ctrl+Z (settledUiOperations) and the settlement never
// adds a close of its own (the kernel goes on in the same resume).
// CX14 N6: the kernel finishes the note at the end of the call (DeliveryTask.RefreshNoteFor). This one is a not-sent end of
// a call that sent nothing again after its proof (r4 guard: the counts of that call, sentAgain).
const FACT="The Studio's Refresh References of this task stopped and then ended (two idle reads proved it): it may have changed the module's references, and Ctrl+Z in the Studio undoes it.";
const NONE=' After that proof the call that settled it sent none of refresh_references, open_module or close_module again.';
const NOTE=FACT+NONE+' The merge of this task was never sent.';
const ENDED_NONE={ended:true,refresh_references:0,open_module:0,close_module:0};
// The note a round-3 kernel wrote at the settlement, before the same call merged and delivered: false at that end.
const ROUND3_NOTE="The Studio's Refresh References of this task stopped and then ended (two idle reads proved it): it may have changed the module's references, and Ctrl+Z in the Studio undoes it; nothing was repeated. The merge of this task was never sent.";
const settledRefresh=(note=NOTE,extra={sentAgain:ENDED_NONE})=>settled('refresh_references').map(e=>({...e,note,...extra}));
test('a not-sent task refused after a settled Refresh References names it with Ctrl+Z, never "nothing reached the module"',()=>{
  const value=deliverOutcome({envelope:{ok:false,data:{...structuredClone(envelopes.refusedBeforeMerge.data),taskId:ID,settledBridgeOperations:settledRefresh()}}},
    {trackId:'facade-task',work:work(),input:{module:'Probe'}});
  assert.equal(value.code,'VALIDATION_REFUSED');assert.ok(value.settledUiOperations[0].note.includes('Ctrl+Z'));
  assert.ok(!/Nada desta tarefa chegou ao módulo|Nothing of this task reached the module/.test(JSON.stringify(value)));
  assert.ok(!(value.continuation?.tool==='ssam_task'&&value.continuation?.arguments?.close),'the settlement adds no close');
});
test('a delivery that went on after a settled Refresh References is delivered and names it, never as a merge never sent',()=>{
  // CX14 N6: this test enshrined a delivered answer saying "The merge of this task was never sent" (round 3). The projection
  // keeps only what is true at the answer's end, whatever kernel wrote the note.
  const value=deliverOutcome({envelope:{ok:true,data:{...structuredClone(envelopes.delivered.data),settledBridgeOperations:settledRefresh(ROUND3_NOTE,{})}}},{trackId:'facade-task',work:work(),input:{module:'Probe'}});
  assert.equal(value.ok,true);assert.equal(value.result,'entregue');assert.ok(value.settledUiOperations[0].note.includes('Ctrl+Z'));
  assert.ok(!/never sent|nothing was repeated/.test(value.settledUiOperations[0].note),value.settledUiOperations[0].note);
  const plain=deliverOutcome({envelope:{ok:true,data:{...structuredClone(envelopes.delivered.data),settledBridgeOperations:settled('close_module')}}},{trackId:'facade-task',work:work(),input:{module:'Probe'}});
  assert.equal(plain.settledUiOperations,undefined,'a settled tab close changes nothing in the module');
});

test('an applied task re-verified after its tab close ended keeps merged, failures and Ctrl+Z',()=>{
  const value=deliverOutcome({envelope:{ok:false,data:{...structuredClone(envelopes.refusedAfterMerge.data),settledBridgeOperations:settled('close_module')}}},
    {trackId:'facade-task',work:work(),input:{module:'Probe'}});
  assert.equal(value.code,'VALIDATION_REFUSED');assert.equal(value.merged,true);assert.match(value.error,/Ctrl\+Z/);
  assert.ok(!(value.continuation?.tool==='ssam_task'&&value.continuation?.arguments?.close),'a settled UI call never turns an applied refusal into a close');
});

// CX14 N6 (r4 guard): the projection never says "nothing was repeated" nor "not sent again" when the call that settled the
// refresh sent refresh_references, open_module or close_module again after its proof, and it declares that the delivery's
// normal steps may send them again (never the merge twice) whenever those counts are not known. Only the counts the kernel
// recorded at the end of that call (sentAgain, ended) are trusted; the note's text never is.
const MAY=" After that proof the delivery's normal steps may send refresh_references, open_module and close_module again; merge_from_oml is sent at most once per task.";
const FALSE_CLAIM=/nothing was repeated|not sent again|sent none/i;
test('N6 guard: a refresh note without the counts of an ended call declares what may be sent again, never that nothing was',()=>{
  const r4open=FACT+' It was not sent again. The merge of this task was never sent.';
  for (const [name,note,extra,writeState] of [['round 3, delivered',ROUND3_NOTE,{},'applied'],['round 3, not-sent',ROUND3_NOTE,{},'not-sent'],
    ['the settling call never ended',r4open,{noteOpen:true},'not-sent'],['an open note with stale counts',NOTE,{noteOpen:true,sentAgain:ENDED_NONE},'applied'],
    ['counts of a call that did not end',NOTE,{sentAgain:{ended:false}},'unknown']]) {
    const [entry]=settledUiOf({writeState,settledBridgeOperations:settledRefresh(note,extra)}).settledUiOperations;
    assert.ok(!FALSE_CLAIM.test(entry.note),name+': '+entry.note);
    assert.equal(entry.note,FACT+MAY+(writeState==='not-sent'?' The merge of this task was never sent.':''),name);
  }
});
test('N6 guard: the counts of the call that settled the refresh name each UI call it sent again, whatever the text says',()=>{
  const sent={ended:true,refresh_references:2,open_module:1,close_module:1};
  const kernelNote=FACT+" After that proof the call that settled it sent again, as the delivery's normal steps do: refresh_references 2x, open_module 1x, close_module 1x; merge_from_oml is sent at most once per task.";
  // The kernel's own finished note is kept as it is (the same sentences as DeliveryTask.RefreshNoteFor).
  assert.equal(settledUiOf({writeState:'applied',settledBridgeOperations:settledRefresh(kernelNote,{sentAgain:sent})}).settledUiOperations[0].note,kernelNote);
  // A note that claims nothing was sent again while its counts say otherwise follows the counts.
  const [entry]=settledUiOf({writeState:'applied',settledBridgeOperations:settledRefresh(FACT+' It was not sent again.',{sentAgain:sent})}).settledUiOperations;
  assert.equal(entry.note,kernelNote);
  const [none]=settledUiOf({writeState:'not-sent',settledBridgeOperations:settledRefresh(NOTE)}).settledUiOperations;
  assert.equal(none.note,NOTE,'an ended call that sent nothing again says so, with the merge never sent');
});
// CX14 N7: this test let the review's N7 pass: its regex was case-sensitive and its fixture's error ("Bridge merge_from_oml
// timed out after 900000 ms") had no sentence of the kernel's. It now runs with the kernel's real error of that answer
// (e77fd91b: "...; nothing was repeated. Resume reconciles it through merge_status.") and checks in any case.
const NOTHING=/nothing was repeated|nada (?:é|foi) repetido/i;
const KERNEL_STOPPED_MERGE='The Studio stopped answering the merge: dialog (Unexpected Error) after 0.212 s; nothing was repeated. Resume reconciles it through merge_status.';
test('N6 guard: an uncertain answer says "Nothing was repeated" only when this call sent no UI call again after its proof',()=>{
  const answer=(sentAgainAfterIdle,error=KERNEL_STOPPED_MERGE)=>deliverOutcome({envelope:{ok:false,data:{...structuredClone(envelopes.uncertain.data),error,settledBridgeOperations:settledRefresh(NOTE),
    ...(sentAgainAfterIdle?{sentAgainAfterIdle}:{})}}},{trackId:'facade-task',work:work(),input:{module:'Probe'}});
  const resent=answer({ended:true,refresh_references:1,open_module:1,close_module:0});
  assert.equal(resent.code,'DELIVERY_UNCERTAIN');
  assert.ok(!NOTHING.test(resent.error),resent.error);
  assert.match(resent.error,/the merge was not repeated\. Resume reconciles it through merge_status\. After the proven idle this call sent again, as the delivery's normal steps do: refresh_references 1x, open_module 1x\.$/);
  const unended=answer({ended:false});
  assert.ok(!NOTHING.test(unended.error),unended.error);
  assert.match(unended.error,/may have sent refresh_references, open_module or close_module again/);
  // The fixture of N6 (no sentence of the kernel's) keeps the whole sentence of the facade.
  assert.match(answer({ended:true,refresh_references:1,open_module:1,close_module:0},'Bridge merge_from_oml timed out after 900000 ms').error,
    /The merge was not repeated; after the proven idle this call sent again, as the delivery's normal steps do: refresh_references 1x, open_module 1x\.$/);
  // Controls: an ended call that sent none of them again, and a call that settled nothing, say it once.
  for (const [name,value] of [['none sent again',answer({ended:true,refresh_references:0,open_module:0,close_module:0})],['settled nothing',answer(null)]])
    assert.equal(value.error.match(/nothing was repeated/gi)?.length,1,name+': '+value.error);
  assert.equal(answer(null,'Bridge merge_from_oml timed out after 900000 ms').error,'Bridge merge_from_oml timed out after 900000 ms Nothing was repeated.');
});

// CX14 N7: the guard of N6 covered the notes and the facade's own suffix, never the kernel's texts of the same answer. The
// receipts below are REAL kernel receipts of the review's scenarios (verify-3\N7), from the kernel reviewed in cx14-4
// (e77fd91b, the receipts on disk) and from this round's kernel (r5). With counts of a call that sent refresh_references,
// open_module or close_module again after its proof (sentAgainAfterIdle), no answer says "nothing was repeated" (nor
// "nada é repetido") in any case, and every answer of such a task names the settled refresh with Ctrl+Z.
const resentNames=sent=>['refresh_references','open_module','close_module'].filter(m=>(sent?.[m]??0)>0).map(m=>m+' '+sent[m]+'x');
const answerOf=data=>deliverOutcome({envelope:{ok:data.delivered===true,data:structuredClone(data)}},{trackId:'facade-task',work:work(),input:{module:'Probe'}});
const ctrlZ=value=>Array.isArray(value.settledUiOperations)&&value.settledUiOperations.length>0&&value.settledUiOperations.every(e=>e.method==='refresh_references'&&e.note.includes('Ctrl+Z'));
for (const kernel of ['e77fd91b','r5']) {
  const receipt=name=>receipts[kernel][name];
  test(`N7 (${kernel} kernel) A1, A2: the merge stops after the settled refresh; the uncertain answer names only what this call sent again`,()=>{
    for (const [name,names] of [['A1',['open_module 1x']],['A2',['refresh_references 1x','open_module 1x']]]) {
      assert.deepEqual(resentNames(receipt(name).sentAgainAfterIdle),names,name+': the receipt the review saw');
      const value=answerOf(receipt(name));
      assert.equal(value.code,'DELIVERY_UNCERTAIN',name);
      assert.ok(!NOTHING.test(JSON.stringify(value)),name+': '+value.error);
      assert.match(value.error,new RegExp("after the proven idle this call sent again, as the delivery's normal steps do: "+names.join(', ')+'\\.$','i'),name);
      assert.equal(value.error.match(/the merge was not repeated/gi)?.length,1,name+': '+value.error);
      assert.ok(ctrlZ(value),name);
    }
  });
  test(`N7 (${kernel} kernel) B: the refresh sent again stops again; the refusal never says nothing was repeated`,()=>{
    const value=answerOf(receipt('B'));
    assert.equal(value.outcome,'refused');assert.equal(value.code,'DELIVERY_FAILED');
    assert.ok(!NOTHING.test(JSON.stringify(value)),value.error);
    assert.match(value.error,/^BridgeCallException: refresh_references: Studio call stopped \(dialog\): Unexpected Error; /);
    assert.ok(ctrlZ(value));
    assert.match(value.settledUiOperations[0].note,/refresh_references 1x, open_module 1x/);
  });
  test(`N7 (${kernel} kernel) C: the merge waits for the person; STUDIO_DIALOG_PENDING carries the settled refresh and never says nothing was repeated`,()=>{
    const value=answerOf(receipt('C'));
    assert.equal(value.code,'STUDIO_DIALOG_PENDING');
    assert.ok(!NOTHING.test(JSON.stringify(value)),JSON.stringify(value));
    assert.match(value.error,/Synthetic choice\? The merge was not repeated; after the answer, resume this task/);
    assert.ok(ctrlZ(value),'the Ctrl+Z of the settled refresh is not lost');
    assert.match(value.settledUiOperations[0].note,/open_module 1x/);
  });
  test(`N7 (${kernel} kernel) control: the next resume delivers; nothing claims nothing was repeated`,()=>{
    const value=answerOf(receipt('B_delivered'));
    assert.equal(value.ok,true);assert.equal(value.result,'entregue');
    assert.ok(!NOTHING.test(JSON.stringify(value)));
    assert.equal(value.settledUiOperations.length,2);assert.ok(ctrlZ(value));
  });
}
test('N7 family: every answer of a task whose call sent a UI call again after its proof carries the settled refresh and never says nothing was repeated',()=>{
  // The B receipt of the reviewed kernel (refresh_references 1x, open_module 1x after the proof), answered through every
  // branch of deliverOutcome, each with the reviewed kernel's sentence in its error.
  const B=receipts.e77fd91b.B;
  const old='; nothing was repeated';
  const branches={
    STUDIO_ERROR_DIALOG_OPEN:{...B,code:'STUDIO_ERROR_DIALOG_OPEN',pendingBridgeOperation:undefined,
      stalled:{verdict:'dialog-before',method:'refresh_references',blockedBy:{title:'Unexpected Error',kind:'UnexpectedError'}},
      error:'BridgeCallException: refresh_references: Studio call stopped (dialog-before): Unexpected Error'+old},
    PREFLIGHT_REFUSED:{...B,code:'PREFLIGHT_REFUSED',pendingBridgeOperation:undefined,stalled:undefined,problems:[{code:'SYNTHETIC',message:'synthetic problem'}],
      error:'Job refused by the preflight; nothing was merged'+old+'.'},
    BRIDGE_OUTDATED:{...B,code:'BRIDGE_OUTDATED',pendingBridgeOperation:undefined,stalled:undefined,error:'The bridge is older than this delivery needs'+old+'.'},
    MERGE_ROLLED_BACK:{...B,code:'MERGE_ROLLED_BACK',writeState:'not-applied',closed:true,pendingBridgeOperation:undefined,stalled:undefined,
      error:'The Studio rolled the merge back'+old+'.'},
    STUDIO_DIALOG_PENDING:{...receipts.e77fd91b.C},
    DELIVERY_UNCERTAIN:{...receipts.e77fd91b.A2},
    DELIVERY_FAILED:{...B,failures:[{stage:'verify',error:'synthetic failure'+old}]},
  };
  for (const [code,data] of Object.entries(branches)) {
    const value=answerOf(data);
    assert.equal(value.code,code,code);
    assert.ok(!NOTHING.test(JSON.stringify(value)),code+': '+JSON.stringify(value));
    assert.ok(ctrlZ(value),code+': the settled refresh with Ctrl+Z');
  }
  // Control: the same answers without the counts of a call that sent again keep the kernel's sentence.
  const {sentAgainAfterIdle,...counted}=branches.BRIDGE_OUTDATED;
  assert.match(answerOf(counted).error,/nothing was repeated/);
});
