import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CookieJar} from 'tough-cookie';
import {SsoSessionCache} from '../service-center/sso-session-cache.mjs';
import {serviceCenterTool} from '../service-center/index.mjs';
const auth={host:'lab.example',user:'tester@example.test',credentialTarget:'SSAM/O11/lab.example/ServiceCenter',bridge:{pid:123,port:4519}};
function cache(options={}){return new SsoSessionCache({schedule:()=>null,cancel:()=>{},...options});}
function cookies(){const jar=new CookieJar();jar.setCookieSync('SCSession=own-private-cookie; Path=/ServiceCenter/; Secure','https://lab.example/ServiceCenter/');jar.setCookieSync('IdToken=identity-secret; Path=/; Secure','https://id.outsystems.com/');return jar;}

test('concurrent pages share a cold login and own independent jars; a failure is not replayed',async()=>{
 const c=cache();let release,logins=0,closes=0;
 const create=()=>{const jar=cookies();return{jar,authenticateSc:async()=>{logins++;await new Promise(r=>{release=r;});},close:async()=>{closes++;jar.removeAllCookiesSync();}};};
 const a=c.authenticate(auth,create),b=c.authenticate(auth,create);
 await new Promise(r=>setImmediate(r));assert.equal(logins,1);release();
 const [first,second]=await Promise.all([a,b]);assert.equal(closes,1);
 first.jar.removeAllCookiesSync();assert.ok(second.jar.getCookieStringSync('https://lab.example/ServiceCenter/'));assert.ok(c.get(auth));
 let failures=0;const fail=()=>({authenticateSc:async()=>{failures++;throw Error('refused');},close:async()=>{}});
 const results=await Promise.allSettled([c.authenticate(auth,fail),c.authenticate(auth,fail)]);
 assert.equal(failures,1);assert.ok(results.every(r=>r.status==='rejected'));assert.equal(c.authenticating.size,0);c.clear();
});

test('cookie updates preserve cache expiry, never cross identity and retain removal',()=>{
 let time=0;const c=cache({now:()=>time,ttlMs:10}),source=cookies();c.put(auth,source);
 time=5;source.setCookieSync('SCSession=rotated-private-cookie; Path=/ServiceCenter/; Secure','https://lab.example/ServiceCenter/');
 assert.equal(c.update({...auth,user:'other@example.test'},source),false);
 assert.equal(c.update(auth,source),true);
 assert.equal(c.get(auth).jar.getCookieStringSync('https://lab.example/ServiceCenter/'),'SCSession=rotated-private-cookie');
 source.removeAllCookiesSync();assert.ok(c.get(auth));
 time=10;assert.equal(c.get(auth),null);
 time=0;const removed=cookies();c.put(auth,removed);removed.removeAllCookiesSync();assert.equal(c.update(auth,removed),false);assert.equal(c.get(auth),null);
});
test('SC session cache clones only SC host cookies and expires without extending on use',()=>{
 let time=0;const c=cache({now:()=>time,ttlMs:10}),source=cookies(),key=c.put(auth,source);assert.ok(key);
 source.removeAllCookiesSync();const a=c.get(auth);assert.equal(a.jar.getCookieStringSync('https://lab.example/ServiceCenter/'),'SCSession=own-private-cookie');assert.equal(a.jar.getCookieStringSync('https://id.outsystems.com/'),'');
 a.jar.removeAllCookiesSync();assert.ok(c.get(auth));time=10;assert.equal(c.get(auth),null);assert.equal(c.entries.size,0);
});
for(const [name,change]of[['host',{host:'other.example'}],['principal',{user:'other@example.test'}],['profile',{credentialTarget:auth.credentialTarget+'/Profiles/'+ 'a'.repeat(64)+'/11111111-2222-3333-4444-555555555555'}],['Studio',{bridge:{...auth.bridge,pid:124}}],['bridge',{bridge:{...auth.bridge,port:4520}}]])test('cache never crosses '+name,()=>{const c=cache();c.put(auth,cookies());assert.equal(c.get({...auth,...change}),null);c.clear();});
test('missing bridge binding and other host/path cookies cannot be cached',()=>{
 const c=cache(),jar=new CookieJar();jar.setCookieSync('unrelated=x; Path=/other/','https://lab.example/');jar.setCookieSync('other=x; Secure; Path=/ServiceCenter/','https://other.example/');
 assert.equal(c.put({...auth,bridge:{}},cookies()),null);assert.equal(c.put(auth,jar),null);
});
test('SC cookies without Secure remain usable only through an exact-host HTTPS cache lookup',()=>{
 const c=cache(),jar=new CookieJar();jar.setCookieSync('SCSession=private; Path=/ServiceCenter/','https://lab.example/ServiceCenter/');assert.ok(c.put(auth,jar));assert.ok(c.get(auth));assert.equal(c.get({...auth,host:'other.example'}),null);c.clear();
});
test('bound and scheduled expiry clears memory; bounded size drops old session',()=>{
 let expire;const c=cache({maxEntries:1,schedule:fn=>{expire=fn;return null;}});c.put(auth,cookies());c.put({...auth,user:'second@example.test'},cookies());assert.equal(c.get(auth),null);assert.equal(c.entries.size,1);expire();assert.equal(c.entries.size,0);
});
test('public reads reuse a scoped SC cookie, still resolve identity, allow only one same-identity GET recovery and evict on terminal expiry',async()=>{
 let logins=0,closes=0,reads=0,profiles=0,expired=false;
 const c=cache(),deps={ssoCache:c,present:async()=>true,locate:async()=>({...auth.bridge,supports:async()=>true,capabilities:async()=>new Set(['sc_http:studioSession']),session:async()=>({studio:{signedIn:true,user:auth.user}}),web:async()=>({signedIn:false})}),
  profiles:{resolve:async()=>{profiles++;return{ok:true,principal:auth.user,target:auth.credentialTarget};}},
  createSso:()=>{const jar=cookies();return{jar,authenticateSc:async()=>{logins++;},close:async()=>{closes++;jar.removeAllCookiesSync();}};},
  send:async req=>{reads++;if(!req.headers.Cookie)return{status:302,location:'https://id.outsystems.com/community/login',setCookie:[],body:Buffer.alloc(0)};
   return{status:200,contentType:'text/html',setCookie:[],body:expired?Buffer.from('<form method="post" action="Login.aspx"></form>'):fs.readFileSync(new URL('./fixtures/sc-pages/error-logs-1.html',import.meta.url))};}};
 const call=()=>serviceCenterTool(['logs','--host',auth.host,'--limit','1'],deps);
 const first=await call();assert.equal(first.ok,true);assert.equal(logins,1);assert.equal(closes,1);
 const second=await call();assert.equal(second.ok,true);assert.equal(second.result.auth.path,'vault-sso-cache');assert.equal(logins,1);assert.equal(profiles,2);
 assert.doesNotMatch(JSON.stringify(second),/own-private-cookie|identity-secret|SCSession/);
 expired=true;const before=reads,failed=await call();assert.equal(failed.ok,false);assert.equal(failed.code,'SC_AUTH_EXPIRED');assert.equal(reads,before+2);assert.equal(logins,2);assert.equal(closes,2);assert.equal(profiles,3);assert.equal(c.entries.size,0);
 expired=false;assert.equal((await call()).ok,true);assert.equal(logins,3);assert.equal(closes,3);c.clear();
});

test('a layout refusal retains the valid authenticated session for the next call',async()=>{
 let logins=0,unknown=false;
 const c=cache(),deps={ssoCache:c,present:async()=>true,
  locate:async()=>({...auth.bridge,supports:async()=>true,capabilities:async()=>new Set(['sc_http:studioSession']),session:async()=>({studio:{signedIn:true,user:auth.user}}),web:async()=>({signedIn:false})}),
  profiles:{resolve:async()=>({ok:true,principal:auth.user,target:auth.credentialTarget})},
  createSso:()=>{const jar=cookies();return{jar,authenticateSc:async()=>{logins++;},close:async()=>jar.removeAllCookiesSync()};},
  send:async req=>!req.headers.Cookie?{status:302,location:'https://id.outsystems.com/community/login',setCookie:[],body:Buffer.alloc(0)}
   :{status:200,contentType:'text/html',setCookie:[],body:unknown?Buffer.from('<main>Unexpected layout</main>'):fs.readFileSync(new URL('./fixtures/sc-pages/error-logs-1.html',import.meta.url))}};
 const call=()=>serviceCenterTool(['logs','--host',auth.host,'--limit','1'],deps);
 assert.equal((await call()).ok,true);unknown=true;assert.equal((await call()).ok,false);
 assert.ok(c.get(auth));unknown=false;assert.equal((await call()).ok,true);assert.equal(logins,1);c.clear();
});
