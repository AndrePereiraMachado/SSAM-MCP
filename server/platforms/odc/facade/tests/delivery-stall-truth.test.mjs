import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {McpServer,InMemoryTransport} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/client';
import {deliverOutcome,registerO11Cycle} from '../o11-cycle.mjs';
import {fakeAnvil} from './fixtures/fake-anvil.mjs';
import envelopes from './fixtures/o11-cycle-envelopes.json' with {type:'json'};

// CX14 R1: a pre-probe refusal (STUDIO_ERROR_DIALOG_OPEN) never rewrites what the kernel knows about the write. The
// answer says refused/not-sent only for a task whose write was never sent; an unknown merge stays DELIVERY_UNCERTAIN and
// an applied or validation-refused task keeps its own refusal (merged, failures, Ctrl+Z, contract, error). Synthetic only.
const ID='5ae443f548aa465e896c67b8827bfe9a';
const report={title:'Unexpected Error',type:'DialogWindow',kind:'UnexpectedError'};
const before=method=>({verdict:'dialog-before',method,blockedBy:{...report,seenMs:0},afterMs:0,studio:{pid:4242,startedUtc:'2026-10-15T00:00:00Z'}});
// The task states the round-1 kernel wrote (the code stamped by any pre-probe refusal) and the ones the kernel writes now.
const states={
  unknownResume:stamp=>({taskId:ID,module:'Probe',delivered:false,writeState:'unknown',stage:'open',operationId:'op-1',...(stamp?{code:'STUDIO_ERROR_DIALOG_OPEN'}:{}),
    error:'BridgeCallException: open_module: Studio call stopped (dialog-before): Unexpected Error; nothing was repeated',
    stalled:before('open_module'),pendingBridgeOperation:{method:'merge_from_oml',moduleKey:'K',operationId:'op-1'}}),
  appliedVerifyError:stamp=>({...structuredClone(envelopes.refusedAfterMerge.data),...(stamp?{code:'STUDIO_ERROR_DIALOG_OPEN',stalled:before('close_module')}:{}),
    open:{opened:true,alreadyOpen:false},closedTab:{closed:false,reason:'BridgeCallException: close_module: Studio call stopped (dialog-before): Unexpected Error; nothing was repeated'}}),
  validationRefused:stamp=>({...structuredClone(envelopes.refusedBeforeMerge.data),...(stamp?{code:'STUDIO_ERROR_DIALOG_OPEN',stalled:before('close_module')}:{}),
    open:{opened:true,alreadyOpen:false},closedTab:{closed:false,reason:'BridgeCallException: close_module: Studio call stopped (dialog-before): Unexpected Error; nothing was repeated'}}),
  mergePreProbe:()=>({taskId:ID,module:'Probe',delivered:false,writeState:'not-sent',stage:'merge',code:'STUDIO_ERROR_DIALOG_OPEN',
    error:'BridgeCallException: merge_from_oml: Studio call stopped (dialog-before): Unexpected Error; nothing was repeated',stalled:before('merge_from_oml')}),
};
function expectTruth(name,value) {
  if(name==='unknownResume') {
    assert.equal(value.outcome,'uncertain');assert.equal(value.code,'DELIVERY_UNCERTAIN');assert.equal(value.writeState,'unknown');
    assert.match(value.error,/nothing was repeated/i);assert.equal(value.pendingBridgeOperation.operationId,'op-1');
    assert.deepEqual(value.recovery.map(r=>r.tool),['o11_studio','o11_deliver']);assert.equal(value.recovery[0].arguments.args.title,'Unexpected Error');assert.equal(value.recovery[1].arguments.resume,ID);
  } else if(name==='appliedVerifyError') {
    assert.equal(value.outcome,'refused');assert.equal(value.code,'VALIDATION_REFUSED');assert.equal(value.merged,true);
    assert.ok(value.failures?.length);assert.match(value.error,/Ctrl\+Z/);assert.notEqual(value.writeState,'not-sent');
  } else if(name==='validationRefused') {
    assert.equal(value.outcome,'refused');assert.equal(value.code,'VALIDATION_REFUSED');assert.ok(value.contract,'the contract that refused stays');
    assert.ok(value.problems?.length||value.messages?.length);assert.match(value.error,/validation contract/);
  } else {
    assert.equal(value.outcome,'refused');assert.equal(value.code,'STUDIO_ERROR_DIALOG_OPEN');assert.equal(value.writeState,'not-sent');
    assert.match(value.error,/merge_from_oml/);assert.equal(value.recovery[0].arguments.command,'dismiss-dialog');assert.equal(value.recovery[1].arguments.resume,ID);
  }
}
for(const stamp of [true,false])for(const name of Object.keys(states))if(stamp||name!=='mergePreProbe')
  test(`deliverOutcome keeps the kernel's write truth: ${name}${stamp?' (round-1 stamped receipt)':''}`,()=>{
    const value=deliverOutcome({envelope:{ok:false,data:states[name](stamp)}},{trackId:'facade-task',work:fs.mkdtempSync(path.join(os.tmpdir(),'cx14-r1-')),input:{module:'Probe'}});
    expectTruth(name,value);
  });

// The complete o11_deliver handler (registerO11Cycle over MCP) with the kernel results of the scenarios above.
for(const name of Object.keys(states))test(`o11_deliver handler answers the kernel's write truth: ${name}`,async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'cx14-r1-handler-'));
  const root=path.join(base,'anvil'),home=path.join(base,'home'),auth=path.join(base,'authority');
  for(const d of [root,home,auth])fs.mkdirSync(d,{recursive:true});
  fs.mkdirSync(path.join(root,'.local','connections'),{recursive:true});
  fs.writeFileSync(path.join(root,'.local','connections','ss4.json'),JSON.stringify({ok:true,lane:'o11',anvilLane:'ss4',pid:4242,startedUtc:'2026-10-15T00:00:00Z',studioDir:path.join(base,'Studio'),authorityDir:auth,port:45998}));
  const job=path.join(base,'job.json');fs.writeFileSync(job,JSON.stringify({ops:[]}));
  const state=states[name](false);
  const work=path.join(root,'.local','work');fs.mkdirSync(path.join(work,'deliver',state.taskId),{recursive:true});
  fs.writeFileSync(path.join(work,'deliver',state.taskId,'task.json'),JSON.stringify({...state,request:{JobPath:job},updatedAt:new Date().toISOString()}));
  const runAnvil=fakeAnvil({deliver:()=>({ok:state.delivered===true,command:'deliver',data:state})});
  const server=new McpServer({name:'cx14-r1',version:'1'});
  registerO11Cycle(server,{root,env:{...process.env,ANVIL_AUTHORITY_DIR:auth,ANVIL_WORKER:'0'},lane:'ss4',runAnvil,assertSelected:async()=>{},bridge:{ok:async()=>({})}});
  const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'cx14-r1-client',version:'1'});
  await Promise.all([server.connect(a),client.connect(b)]);
  try{
    const args=name==='unknownResume'?{resume:state.taskId,authorize:'sim, pode entregar'}:{module:'Probe',job,authorize:'sim, pode entregar'};
    const response=await client.callTool({name:'o11_deliver',arguments:args});
    const value=response.structuredContent??JSON.parse(response.content[0].text);
    expectTruth(name,value);
    assert.equal(runAnvil.calls.filter(c=>c.args[0]==='deliver').length,1,'one kernel call, nothing repeated');
  }finally{await client.close();await server.close()}
});
