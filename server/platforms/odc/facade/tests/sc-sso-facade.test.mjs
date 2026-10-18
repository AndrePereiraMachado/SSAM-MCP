import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CookieJar} from 'tough-cookie';
import {serviceCenterTool} from '../service-center/index.mjs';
import {AuthRequired} from '../service-center/errors.mjs';

test('public SC read uses private SSO after native status, shares only its scoped cookie, and disposes the session',async()=>{
  let logins=0,closes=0,requests=0,probes=0;
  const host='lab.example',principal='tester@example.test';
  const deps={present:async()=>true,locate:async()=>({supports:async()=>true,capabilities:async()=>new Set(['sc_http:studioSession']),
    session:async()=>({studio:{signedIn:true,user:principal}}),web:async(_host,action)=>{assert.equal(action,'status');probes++;return{signedIn:false};}}),
    profiles:{resolve:async(scope,options)=>{assert.equal(scope.principal,principal);assert.equal(options.interactive,false);return{ok:true,principal,target:'SSAM/O11/lab.example/ServiceCenter'};}},
    createSso:auth=>{assert.equal(auth.user,principal);const jar=new CookieJar();return{jar,
      authenticateSc:async()=>{logins++;jar.setCookieSync('SCSession=fake; Path=/ServiceCenter/; Secure','https://lab.example/ServiceCenter/');},
      close:async()=>{closes++;await jar.removeAllCookies();}};},
    send:async req=>{requests++;if(requests===1)return{status:302,location:'https://id.outsystems.com/community/login',setCookie:[],body:Buffer.alloc(0)};
      assert.equal(req.headers.Cookie,'SCSession=fake');return{status:200,contentType:'text/html',setCookie:[],body:fs.readFileSync(new URL('./fixtures/sc-pages/error-logs-1.html',import.meta.url))};}};
  const answer=await serviceCenterTool(['logs','--host',host,'--limit','1'],deps);
  assert.equal(answer.ok,true);assert.equal(answer.result.auth.path,'vault-sso');assert.equal(logins,1);assert.equal(closes,1);assert.equal(probes,1);assert.equal(requests,2);
  assert.doesNotMatch(JSON.stringify(answer),/SCSession|fake;|access_token/);
  deps.createSso=()=>({authenticateSc:async()=>{throw new AuthRequired('IDENTITY_CHALLENGE_REQUIRED','Challenge required.');},close:async()=>closes++});
  requests=0;
  const refused=await serviceCenterTool(['logs','--host',host,'--limit','1'],deps);
  assert.equal(refused.code,'IDENTITY_CHALLENGE_REQUIRED');assert.equal(requests,1);assert.equal(closes,2);
});
