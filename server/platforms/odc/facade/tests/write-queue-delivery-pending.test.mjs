import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {McpServer,InMemoryTransport} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/client';
import {registerO11Cycle} from '../o11-cycle.mjs';
import {studioWriteHolder} from '../studio-write-lock.mjs';
import {fakeAnvil} from './fixtures/fake-anvil.mjs';
import envelopes from './fixtures/o11-cycle-envelopes.json' with {type:'json'};
for(const receipt of [false,true])for(const idle of [false,true])test((receipt?'persisted receipt, missing envelope: ':'')+(idle?'a confirmed delivery with recorded idle proof stays successful and never offers task close':'a confirmed delivery still fences an uncertain tab close before the MCP response'),async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx14-confirmed-pending-')),auth=path.join(root,'authority');fs.mkdirSync(auth);
 const record={ok:true,lane:'o11',anvilLane:'ss4',startedUtc:'2026-10-14T00:00:00Z',pid:process.pid,port:12345,studioDir:root,authorityDir:auth};
 fs.mkdirSync(path.join(root,'.local','connections'),{recursive:true});fs.writeFileSync(path.join(root,'.local','connections','ss4.json'),JSON.stringify(record));
 const job=path.join(root,'job.json');fs.writeFileSync(job,JSON.stringify({ops:[{op:'get',target:'ServerAction:SaveOrder'}]}));
 const envelope=structuredClone(envelopes.delivered);Object.assign(envelope.data,{pendingBridgeOperation:{method:'close_module',moduleKey:'key'},stalled:{verdict:'dialog',method:'close_module',blockedBy:{title:'Unexpected Error',kind:'UnexpectedError'},studio:{pid:process.pid}}});
 if(idle){delete envelope.data.stalled.blockedBy;envelope.data.pendingOperationRecovery={idleProven:true,action:'inspect-confirmed-delivery'};envelope.data.pendingUiProof={idle:true};}
 const server=new McpServer({name:'confirmed-pending',version:'1'});
 registerO11Cycle(server,{root,lane:'ss4',env:{...process.env,ANVIL_AUTHORITY_DIR:auth},assertSelected:async()=>{},runAnvil:fakeAnvil({deliver:()=>{if(!receipt)return envelope;const folder=path.join(root,'.local','work','deliver',envelope.data.taskId);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'task.json'),JSON.stringify({...envelope.data,request:{JobPath:job},updatedAt:new Date().toISOString()}));return{envelope:null,exitCode:1,stderr:['fake reply lost after receipt']}}}),bridge:{ok:async()=>({})}});
 const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'confirmed-pending',version:'1'});await Promise.all([server.connect(a),client.connect(b)]);
 try{
  const response=await client.callTool({name:'o11_deliver',arguments:{module:'Orders',job,authorize:'fake delivery only'}});
  const value=response.structuredContent??JSON.parse(response.content[0].text);
  assert.equal(value.ok,true);assert.equal(value.result,'entregue');assert.equal(value.pendingBridgeOperation.method,'close_module');if(idle){assert.equal(value.continuation.tool,'ssam_task');assert.equal(value.continuation.arguments.close,undefined);assert.equal(value.pendingUiProof.idle,true)}else assert.equal(value.recovery[0].arguments.command,'dismiss-dialog');
  const holder=studioWriteHolder({deps:{o11Root:root,o11Lane:'ss4'}});if(idle)assert.equal(holder,null);else{assert.equal(holder.tool,'bridge:close_module');assert.equal(holder.state,'stalled');}
  const tasks=path.join(root,'.local','tasks');for(const name of fs.readdirSync(tasks)){const text=fs.readFileSync(path.join(tasks,name),'utf8');assert.ok(!text.includes('fake delivery only'));assert.ok(!text.includes('pendingBridgeState'))}
 }finally{await client.close();await server.close()}
});
