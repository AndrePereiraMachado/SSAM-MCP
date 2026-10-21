import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createAgentHub} from '../agent-hub.mjs';
import {createTokenStore} from '../server-tokens.mjs';
import {createRouter,selectBackend} from '../hosted/router.mjs';
import {studioIdentity,studioRefusal,studioWarningOf} from '../studio-identity.mjs';

const versions={odc:['1.7.28','1.7.29'],o11:['11.55.92','11.55.93']};
for(const [lane,local,other] of [['odc','1.7.28','1.7.29'],['o11','11.55.93','11.55.92']]) test(`${lane}: a version served elsewhere never authorizes the local Studio`,()=>{
 const identity=studioIdentity(lane,other,{[lane]:local,servedVersions:versions});
 assert.equal(identity.ok,false);assert.equal(identity.relation,'served-elsewhere');
 const refusal=studioRefusal(identity);assert.equal(refusal.cause,'STUDIO_VERSION_CHANGED');
 assert.match(refusal.userMessage,/version changed.*redirected/i);
 const warning=studioWarningOf(identity);assert.match(warning.userMessage,/version changed.*redirected/i);assert.doesNotMatch(JSON.stringify(warning),/kernel|container|review/);
});
test('routing prefers the full installed pair over an earlier priority-lane match',()=>{
 const backends=[{name:'new',odc:'1.7.29',o11:'11.55.93',default:true},{name:'mixed',odc:'1.7.29',o11:'11.55.92'}];
 assert.equal(selectBackend(backends,{studios:{odc:{installed:{version:'1.7.29.1'}},o11:{installed:{version:'11.55.92.1'}}}}).name,'mixed');
});
test('pong changes close the channel; reconnect reroutes once and leaves the old lane incompatible',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pong-'));
 const store=createTokenStore(dir),license=store.issue({customer:'Synthetic',lanes:['odc','o11']});
 const hubs=[],servers=[],backends=[];
 let router;
 try{
  for(const [name,odc,o11] of [['new','1.7.29','11.55.93'],['old','1.7.28','11.55.92']]){
   const hub=createAgentHub({dir:path.join(dir,name),store,kernel:{odc,o11,servedVersions:versions,odcBridge:'v97'},limits:{sweepMs:60000,deadAfterMs:600000}});hubs.push(hub);
   const server=http.createServer(async(req,res)=>{if(req.url.startsWith('/agent'))return hub.handle(req,res);req.resume();res.setHeader('mcp-session-id',name+'-synthetic');res.end(JSON.stringify({backend:name}));});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);backends.push({name,odc,o11,default:name==='new',url:'http://127.0.0.1:'+server.address().port});
  }
  router=await createRouter({backends,store,dir:path.join(dir,'router'),port:0});
  const post=async(url,key,body,sid)=>{const r=await fetch(router.url+url,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json',...(sid?{'mcp-session-id':sid}:{})},body:JSON.stringify(body)});const s=await r.text();return {status:r.status,body:s?JSON.parse(s):null,sid:r.headers.get('mcp-session-id')};};
  const hello={t:'hello',protocol:'ssam-agent/1',instance:randomUUID(),pack:{lanes:['odc','o11'],odcBridge:'v97',o11BuiltFor:'11.55.92',o11Hook:'dev'},studios:{odc:{installed:{version:'1.7.28.1'}},o11:{installed:{version:'11.55.92.1'}}}};
  const welcome=await post('/agent/v1/hello',license.agentCredential,hello);assert.equal(welcome.status,200);
  const initial=await post('/mcp',license.token,{});assert.equal(initial.body.backend,'old');
  hello.studios.odc.installed.version='1.7.29.1';
  await post('/agent/v1/messages?channel='+welcome.body.channel,license.agentCredential,{messages:[{t:'pong',versions:{studios:hello.studios}}]});
  assert.equal(hubs[1].link(license.id).connected(),false);
  assert.equal(hubs[1].link(license.id).info().compatible.odc.ok,false);
  const resumed=await post('/agent/v1/hello',license.agentCredential,hello);assert.equal(resumed.status,200);assert.equal(resumed.body.compatible.o11.ok,false);
  const changed=await post('/mcp',license.token,{},initial.sid);assert.equal(changed.body.error.data.code,'SESSION_REROUTED');
  assert.equal((await post('/mcp',license.token,{},initial.sid)).body.error.data.code,'SESSION_NOT_FOUND');
  assert.equal((await post('/mcp',license.token,{})).body.backend,'new');
 }finally{await router?.close();for(const h of hubs)await h.close();for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}fs.rmSync(dir,{recursive:true,force:true});}
});