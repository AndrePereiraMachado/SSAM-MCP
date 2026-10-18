import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createCallDeadline} from '../call-deadline.mjs';
import {registerO11Cycle} from '../o11-cycle.mjs';
import {fakeAnvil} from './fixtures/fake-anvil.mjs';
const kernelId='3c4d5e6f708192a3b4c5d6e7f8091a2b';
const value=r=>r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
function setup(t,outcome) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'cx12-r3-resume-')),root=path.join(base,'anvil'),auth=path.join(base,'authority'),home=path.join(base,'home');
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  for(const dir of [root,auth,home])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(auth,'bridge.key'),'SYNTHETIC');
  const env={USERPROFILE:home,HOME:home,APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),ANVIL_AUTHORITY_DIR:auth,ANVIL_WORKER:'0',ANVIL_ODC_NO_WORKER:'1',ANVIL_LANE:'ss4'};
  fs.mkdirSync(path.join(root,'.local','connections'),{recursive:true});
  fs.writeFileSync(path.join(root,'.local','connections','ss4.json'),JSON.stringify({ok:true,lane:'o11',anvilLane:'ss4',pid:4242,port:45998,studioDir:path.join(base,'Studio'),authorityDir:auth}));
  const work=path.join(root,'.local','work'),job=path.join(base,'synthetic-job.json');
  fs.writeFileSync(job,JSON.stringify({ops:[{op:'get',target:'ServerAction:Synthetic'}]}));
  function kernel(state,id=kernelId) {
    const dir=path.join(work,'deliver',id);fs.mkdirSync(dir,{recursive:true});
    const payload=JSON.stringify({taskId:id,module:'SyntheticOrders',updatedAt:new Date().toISOString(),request:{JobPath:job},...state});
    fs.writeFileSync(path.join(dir,'task.json'),JSON.stringify({format:1,sha256:createHash('sha256').update(payload).digest('hex'),payload}));
  }
  const counts={fresh:0,resumes:0};
  const runAnvil=fakeAnvil({deliver:args=>{
    if(args[1]==='--resume') {
      counts.resumes++;
      const state=outcome==='delivered'?{writeState:'applied',delivered:true,validation:{newErrors:0}}:
        {writeState:'not-applied',delivered:false,closed:true,stage:'reconcile',code:'MERGE_ROLLED_BACK',error:'Synthetic merge rollback proof'};
      kernel(state);return {ok:outcome==='delivered',command:'deliver',data:{taskId:kernelId,module:'SyntheticOrders',...state}};
    }
    counts.fresh++;
    if(counts.fresh>1) {
      const id='4d5e6f708192a3b4c5d6e7f8091a2b3c';
      const state={writeState:'applied',delivered:true,validation:{newErrors:0}};kernel(state,id);
      return {ok:true,command:'deliver',data:{taskId:id,module:'SyntheticOrders',...state}};
    }
    const state={writeState:'unknown',delivered:false,stage:'merge',error:'Synthetic merge outcome unknown'};
    kernel(state);return {ok:false,command:'deliver',data:{taskId:kernelId,module:'SyntheticOrders',...state}};
  }});
  function server() {
    const deadline=createCallDeadline({root,timeoutMs:3000,env:{}}),tools=new Map();
    registerO11Cycle({registerTool(name,config,handler){tools.set(name,{config,run:deadline.wrap(name,handler,config)});}},
      {root,env,lane:'ss4',runAnvil,assertSelected:async()=>{},grantsFile:path.join(base,'synthetic-grants.json'),lastPublication:async()=>null,
        bridge:{ok:async()=>{throw Error('No bridge is used by this synthetic runner');}}});
    return async(name,args)=>{
      const {config,run}=tools.get(name),checked=await config.inputSchema['~standard'].validate(args);
      assert.equal(checked.issues,undefined,'synthetic inputs satisfy the registered schema');
      return value(await run(checked.value,{mcpReq:{signal:new AbortController().signal,notify:async()=>{}}}));
    };
  }
  return {counts,server,args:{module:'SyntheticOrders',job,authorize:'synthetic-confirmation'}};
}
for(const mode of ['live','reloaded'])for(const outcome of ['rolledback','delivered']) {
  test(`R3-3 real resume ${outcome} reconciles facade guard ${mode}`,async t=>{
    const box=setup(t,outcome);let call=box.server();
    const initial=await call('o11_deliver',box.args);assert.equal(initial.outcome,'uncertain');assert.equal(box.counts.fresh,1);
    const before=await call('o11_deliver',box.args);assert.equal(before.outcome,'uncertain');assert.equal(box.counts.fresh,1);
    assert.equal(before.continuation.tool,'o11_deliver');assert.equal(before.continuation.arguments.resume,kernelId,'refusal names the reconciler');
    const resumed=await call('o11_deliver',{resume:kernelId,authorize:'synthetic-confirmation'});
    assert.equal(box.counts.resumes,1);
    if(outcome==='delivered')assert.equal(resumed.ok,true);else assert.equal(resumed.code,'MERGE_ROLLED_BACK');
    if(mode==='reloaded')call=box.server();
    const after=await call('o11_deliver',box.args);
    if(outcome==='rolledback') {
      assert.equal(box.counts.fresh,2,'reconciled rollback releases the corresponding facade guard');assert.equal(after.ok,true);
    } else {
      assert.equal(box.counts.fresh,1,'confirmed delivery must never run a second merge');
      assert.equal(after.ok,true);assert.equal(after.result,'delivered');
      assert.equal(after.code,'TASK_DELIVERED');assert.match(after.message??'',/entregue|delivered/i);
      assert.doesNotMatch(after.code??'',/UNCERTAIN/);
      assert.doesNotMatch(after.error??after.message??'',/no definitive outcome/i);
      assert.equal((await call('o11_deliver',box.args)).ok,true);
      assert.equal(box.counts.fresh,2,'confirmed saved delivery is consumed once; next invocation is fresh');
    }
  });
}
