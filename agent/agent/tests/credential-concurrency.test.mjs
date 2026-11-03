import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCredentialSession} from '../lib/credential-session.mjs';
const request={op:'login',host:'tenant.example.test',service:'odc-portal',auth:'credential',profile:'a'.repeat(64)};
function harness(platform='win32'){
 let logins=0,valid=true,fail=false,release;
 const paused=new Promise(r=>release=r);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'credential-concurrency-'));
 if(platform==='darwin'){
  fs.mkdirSync(path.join(root,'native'));fs.writeFileSync(path.join(root,'native','ssam-agent'),'synthetic-helper');
  fs.writeFileSync(path.join(root,'pack.json'),JSON.stringify({nativeCore:{runtime:'native-aot',path:'native/ssam-agent'}}));
 }
 const agent=createCredentialSession({dataRoot:root,runtimeRoot:root,platform,lookup:async()=>[{address:'93.184.216.34'}],
  exec:async(_file,_args,input)=>{
   const raw=JSON.parse(input),p=platform==='darwin'?raw.request:raw;
   if(p.op==='status')return JSON.stringify({ok:true,available:true,authenticated:!!p.privateSession&&valid,profile:p.profile,principal:'test@example.test'});
   if(p.op==='sign-out')return JSON.stringify({ok:true});
   assert.equal(p.op,'login');logins++;await paused;
   return JSON.stringify(fail?{ok:false,code:'CREDENTIAL_AUTH_CONTRACT_CHANGED'}:{ok:true,authenticated:true,privateSession:{profile:p.profile,token:'synthetic-private-token'}});
  }});
 return {agent,release,get logins(){return logins},set valid(v){valid=v},set fail(v){fail=v}};
}
for(const platform of ['win32','darwin']) test(`${platform}: concurrent logins share one attempt and a stale late request reuses the verified session`,async()=>{
 const h=harness(platform);const calls=[1,2,3].map(()=>h.agent.execute(request));h.release();
 const results=await Promise.all(calls);assert.ok(results.every(r=>r.authenticated));assert.equal(h.logins,1);
 const late=await h.agent.execute(request);assert.equal(late.authenticated,true);assert.equal(h.logins,1);assert.match(late.notes.join(' '),/reused/);
 h.valid=false;await h.agent.execute(request);assert.equal(h.logins,2);
});
for(const platform of ['win32','darwin']) test(`${platform}: a shared failure is not retried by waiters and a later explicit attempt can recover`,async()=>{
 const h=harness(platform);h.fail=true;const calls=[1,2,3].map(()=>h.agent.execute(request));h.release();
 const results=await Promise.allSettled(calls);assert.ok(results.every(r=>r.status==='rejected'&&r.reason.code==='CREDENTIAL_AUTH_CONTRACT_CHANGED'));assert.equal(h.logins,1);
 h.fail=false;assert.equal((await h.agent.execute(request)).authenticated,true);assert.equal(h.logins,2);
});
test('profiles and credential runtime instances do not share authentication',async()=>{
 const a=harness(),b=harness();a.release();b.release();
 await Promise.all([a.agent.execute(request),a.agent.execute({...request,profile:'b'.repeat(64)}),b.agent.execute(request)]);
 assert.equal(a.logins,2);assert.equal(b.logins,1);
});
