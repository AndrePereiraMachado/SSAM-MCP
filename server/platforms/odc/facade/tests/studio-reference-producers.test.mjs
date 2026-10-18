import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import {registerStudioReferenceProducers} from '../studio-reference-producers.mjs';
import {isWrite} from '../studio-write-lock.mjs';
import {resolveModuleArgs} from '../lib.mjs';

function harness() {
  const calls=[];let tool;
  registerStudioReferenceProducers({registerTool:(name,definition,handler)=>{tool={name,definition,handler};}}, {
    studio:async(args,pid)=>{calls.push({args,pid});return {ok:true,scope:'consumer-session-visible-producers',producers:[]};},
    wrap:fn=>fn, readOnly:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    pidSchema:z.number().int().positive().optional(),
  });
  return {calls,tool,invoke:async input=>tool.handler(tool.definition.inputSchema.parse(input))};
}
test('native producer read retains the explicit consumer and Studio without requesting a write',async()=>{
  const h=harness(),r=await h.invoke({module:'SSAMConsumer',pid:19368});
  assert.deepEqual(h.calls,[{args:['reference-producers','SSAMConsumer'],pid:19368}]);
  assert.equal(h.tool.definition.annotations.readOnlyHint,true);
  assert.equal(isWrite(h.tool.name,{module:'SSAMConsumer'}),false);
  assert.equal(r.scope,'consumer-session-visible-producers');
  assert.deepEqual(r.producers,[]);
  assert.ok(!Object.hasOwn(r,'tenantEmpty'));
});
test('invalid scope and credential-like extra fields are refused before contacting the bridge',async()=>{
  for(const input of [{},{module:' '},{module:'App',pid:0},{module:'App',tenant:'another.test'},{module:'App',token:'synthetic'}]){
    const h=harness();await assert.rejects(h.invoke(input));assert.equal(h.calls.length,0);
  }
});
test('unknown consumers stop at native module resolution instead of using another session',async()=>{
  const calls=[];
  const result=await resolveModuleArgs(19368,['reference-producers','Missing'],{
    call:async(pid,args)=>{calls.push({pid,args});return {value:[{name:'OpenConsumer',key:'known'}]};},
    catalog:()=>({modules:[]}),
  });
  assert.equal(result.refusal.code,'MODULE_NOT_OPEN');
  assert.deepEqual(calls,[{pid:19368,args:['status','modules']}]);
});
