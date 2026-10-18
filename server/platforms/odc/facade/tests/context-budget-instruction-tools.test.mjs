import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/client';
import {createSsamServer} from '../ssam.mjs';
import {createFacadeServer} from '../mcp.mjs';
import * as instructions from '../server-instructions.mjs';
import {SESSION_RULES} from '../server-instructions.mjs';
for(const profile of ['app','debug','all','odc-facade']) test('A4 named instruction tools are served by '+profile,async()=>{
 const server=profile==='odc-facade'?await createFacadeServer():await createSsamServer({profile});
 const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'a4-offline',version:'1'});
 await Promise.all([server.connect(a),client.connect(b)]);
 try{
  const text=client.getInstructions(),names=new Set((await client.listTools()).tools.map(t=>t.name));
  assert.ok(text.length<=2000);
  for(const name of new Set(text.replaceAll('mcp__ssam__', '').replace('error code studio_busy', '').match(/\b(?:ssam|studio|o11|odc|hybrid)_[a-z][a-z0-9_]*\b/g)??[])){
   if(profile==='debug'&&name==='ssam_reference'){assert.match(text,/Connect the server named ssam for all session rules: ssam_reference/);continue;}
   assert.ok(names.has(name),profile+' instruction names unserved '+name);
  }
  if(profile==='odc-facade'){
   assert.match(text,/Start studio_doctor/);assert.match(text,/authorize.*operationUuid/);assert.match(text,/confirmTenant/);
   assert.match(text,/CREDENTIAL_PROMPT_OPENED/);assert.match(text,/publish:false/);
   assert.match(text,/Studio session first.*Windows-vault credential next.*private Windows prompt only when none is stored/);
   // CX15 r3 serves ssam_task on the standalone server too (registerSsamTask): its instruction may name it.
   assert.doesNotMatch(text,/ssam_reference|o11_deliver|o11_inspect/);assert.match(text,/ssam_task {id} first/);
  }
 }finally{await client.close();await server.close();}
});
// The standalone ODC server (createFacadeServer) serves no ssam_reference: what a session gets is its instruction plus
// the descriptions of the tools it serves. Only getInstructions() counts here, never the static guide.
async function odcFacade(fn){
 const server=await createFacadeServer();const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'n1-odc',version:'1'});
 await Promise.all([server.connect(a),client.connect(b)]);
 try{return await fn(client.getInstructions(),(await client.listTools()).tools);}finally{await client.close();await server.close();}
}
test('N1 the standalone ODC instruction starts every request with ssam_discover and its authorization rule covers every served tool taking authorize',()=>odcFacade((text,tools)=>{
 assert.ok(text.length<=2000,String(text.length));
 assert.ok(tools.some(t=>t.name==='ssam_discover'));
 assert.match(text,/Every request starts ssam_discover \{intent,lane\}; agents\/subagents start \{intent,lane,app,packet:true\}/);
 const general=SESSION_RULES.find(r=>r.id==='authorize'),generalText=general.odc??general.text;
 const sentences=text.split(/(?<=[.;])\s+/);
 const takers=tools.filter(t=>Object.hasOwn(t.inputSchema?.properties??{},'authorize')).map(t=>t.name);
 assert.ok(takers.length>=10,takers.join(' '));
 const uncovered=takers.filter(name=>!text.includes(generalText)&&!sentences.some(s=>s.includes(name)&&/\bauthorize\b/.test(s)));
 assert.deepEqual(uncovered,[],'served tools taking authorize without the authorization rule');
 assert.ok(text.includes(generalText),'the general rule covers data, publish and Portal writes the ODC rules do not name');
}));
test('N1 the standalone ODC instruction is derived from SESSION_RULES; every odc-facade rule is in it or in a served tool',()=>odcFacade((text,tools)=>{
 const order=instructions.ODC_INSTRUCTION_RULES,inTools=instructions.ODC_RULES_IN_TOOLS??{};
 assert.ok(Array.isArray(order),'ODC_INSTRUCTION_RULES');
 const byId=new Map(SESSION_RULES.map(r=>[r.id,r]));
 const derived=order.map(id=>{const r=byId.get(id);assert.ok(r?.servers.includes('odc-facade'),id);return r.odc??r.text;}).join(' ');
 assert.equal(text,derived,'every listed rule, in order, in its SESSION_RULES form; nothing cut by the budget');
 for(const r of SESSION_RULES)if(r.odc){
  assert.ok(r.keeps?.length,r.id+' declares the clauses its ODC form keeps');
  for(const clause of r.keeps){assert.ok(r.text.includes(clause),r.id+' text: '+clause);assert.ok(r.odc.includes(clause),r.id+' odc: '+clause);}
 }
 const missing=[];
 for(const r of SESSION_RULES.filter(r=>r.servers.includes('odc-facade'))){
  if(order.includes(r.id))continue;
  const places=inTools[r.id]??[];
  if(!places.length||places.some(({tool,clause})=>!tools.find(t=>t.name===tool)?.description.includes(clause)))missing.push(r.id);
 }
 for(const id of Object.keys(inTools)){const r=byId.get(id);assert.ok(r?.servers.includes('odc-facade')&&!order.includes(id),'stale location '+id);}
 // A part of a rule that no served text carries is declared, never silent.
 assert.deepEqual(Object.entries(inTools).filter(([,p])=>p.notServed).map(([id,p])=>[id,p.notServed]),[['native-bridge','never changes installation, handles credentials or synthesizes input']]);
 assert.deepEqual(missing,[],'odc-facade rules neither in the instruction nor in a served tool description');
 for(const clause of ['studio_create only uploads a ready whole-module candidate','studio_authorize then studio_publish','A gate refusal means the tool is working','odc_auth_status identifies tenant authentication','never sleep or poll'])assert.ok(text.includes(clause),clause);
}));
