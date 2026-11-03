import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCredentialSession} from '../lib/credential-session.mjs';
import {limitPortalSessionLifetime} from '../lib/credential-session-lifetime.mjs';
const jwt=exp=>'e30.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.fixture';

test('Portal access expiry wins over long cookies without changing credential values',()=>{
 const state={expiresAt:999999,cookies:[{name:'TenantAccess',value:jwt(100),expiresAt:999999},{name:'TenantAccessId',value:jwt(80)}]};
 const original=JSON.stringify(state.cookies);assert.equal(limitPortalSessionLifetime(state),true);
 assert.equal(state.expiresAt,80000);assert.equal(JSON.stringify(state.cookies),original);
 assert.equal(limitPortalSessionLifetime(state),false);
});
test('opaque, malformed and refresh cookies cannot extend or redefine local lifetime',()=>{
 for(const cookie of [{name:'RefreshTenantAccess',value:jwt(1)},{name:'TenantAccess',value:'opaque'},{name:'TenantAccess',value:jwt('1')},{name:'TenantAccess',value:jwt(1e100)},{name:'TenantAccess',value:jwt(10000)}]){
  const state={expiresAt:100,cookies:[cookie]};assert.equal(limitPortalSessionLifetime(state),false);assert.equal(state.expiresAt,100);
 }
});
for(const platform of ['win32','darwin']) test(`${platform}: expired access token triggers one fresh concurrent login despite an eight-hour session`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'credential-lifetime-'));let logins=0;
 if(platform==='darwin'){fs.mkdirSync(path.join(root,'native'));fs.writeFileSync(path.join(root,'native','ssam-agent'),'fixture');fs.writeFileSync(path.join(root,'pack.json'),JSON.stringify({nativeCore:{runtime:'native-aot',path:'native/ssam-agent'}}));}
 const agent=createCredentialSession({dataRoot:root,runtimeRoot:root,platform,lookup:async()=>[{address:'93.184.216.34'}],exec:async(_f,_a,input)=>{
  const raw=JSON.parse(input),p=platform==='darwin'?raw.request:raw;
  if(p.op==='status')return JSON.stringify({ok:true,available:true,authenticated:!!p.privateSession&&p.privateSession.expiresAt>Date.now()});
  logins++;await new Promise(r=>setTimeout(r,10));
  return JSON.stringify({ok:true,authenticated:true,privateSession:{expiresAt:Date.now()+28800000,cookies:[{name:'TenantAccess',value:jwt(Math.floor(Date.now()/1000)+(logins===1?-1:300)),expiresAt:Date.now()+43200000}]}});
 }});
 const p={op:'login',host:'tenant.example.test',service:'odc-portal',auth:'credential',profile:'a'.repeat(64)};
 await agent.execute(p);await Promise.all([agent.execute(p),agent.execute(p),agent.execute(p)]);assert.equal(logins,2);
 await agent.execute(p);assert.equal(logins,2);
});
