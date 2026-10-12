import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {cookieUpdate,withPrivateCookieExchange} from '../service-center/private-cookie-pipe.mjs';
import {CookieJar} from '../service-center/http.mjs';
const scope={host:'lab.example',principal:'fixture@example.test',requestSha256:'a'.repeat(64),url:'https://lab.example/ServiceCenter/Extension_Edit.aspx',cookie:'session=original-synthetic'};
function payload(patch={}){const now=new Date();return Buffer.from(JSON.stringify({schema:'ssam-o11-cookie-update/1',host:scope.host,principal:scope.principal,requestSha256:scope.requestSha256,url:scope.url,issuedAt:now.toISOString(),expiresAt:new Date(now.getTime()+30000).toISOString(),cookies:['session=rotated-synthetic; Path=/ServiceCenter/; Secure','obsolete=; Max-Age=0; Path=/ServiceCenter/'],...patch}));}
test('response validates request, host, principal, URL, lifetime and bounded headers with static errors',()=>{
 assert.equal(cookieUpdate(payload(),scope).length,2);
 for(const patch of [{host:'other.example'},{principal:'other@example.test'},{url:'https://lab.example/Other/'},{requestSha256:'b'.repeat(64)},
  {cookies:['private\r\ninjected']},{cookies:Array(65).fill('secret')},{cookies:['x'.repeat(48001)]},{extra:'secret'},
  {expiresAt:new Date(Date.now()-1000).toISOString()},{issuedAt:new Date(Date.now()+6000).toISOString()},
  {expiresAt:new Date(Date.now()+60000).toISOString()}]){
  assert.throws(()=>cookieUpdate(payload(patch),scope),e=>e.code==='PRIVATE_COOKIE_EXCHANGE_UNAVAILABLE'&&!e.message.includes('secret'));
 }
});
test('real duplex pipe rotates and removes cookies before ACK with exactly one invocation', {skip:process.platform!=='win32'},async()=>{
 const jar=new CookieJar();jar.store(scope.url,['session=original-synthetic; Path=/ServiceCenter/','obsolete=old-synthetic; Path=/ServiceCenter/']);
 let calls=0,applies=0;
 const result=await withPrivateCookieExchange({...scope,applyCookies:(url,headers)=>{applies++;assert.equal(url,scope.url);jar.store(url,headers);}},async id=>{
  calls++;const server=net.createServer();let socket;
  try{
   const done=new Promise((resolve,reject)=>{
    server.once('error',reject);server.once('connection',s=>{socket=s;let buffer=Buffer.alloc(0),contextRead=false;
     s.on('error',reject);s.on('data',part=>{
      buffer=Buffer.concat([buffer,part]);
      if(!contextRead){
       if(buffer.length<4||buffer.length<buffer.readInt32LE()+4)return;
       assert.equal(JSON.parse(buffer.subarray(4)).cookie,scope.cookie);contextRead=true;buffer.fill(0);buffer=Buffer.alloc(0);
       const body=payload(),prefix=Buffer.alloc(4);prefix.writeInt32LE(body.length);s.write(prefix);s.write(body);
      }else{
       assert.equal(buffer[0],1);assert.equal(jar.header(scope.url),'session=rotated-synthetic');resolve({ok:true});
      }
     });
    });
   });server.listen('\\\\.\\pipe\\SSAM-O11-CookieExchange-'+id);return await done;
  }finally{socket?.destroy();await new Promise(resolve=>server.close(resolve));}
 },{timeoutMs:3000});
 assert.equal(result.ok,true);assert.equal(calls,1);assert.equal(applies,1);
});
test('missing exchange cannot turn an authoritative success into proof or replay HTTP',async()=>{
 let calls=0;
 await assert.rejects(withPrivateCookieExchange({...scope,applyCookies:()=>assert.fail('No response')},async()=>{calls++;return{ok:true};},
  {platform:'win32',timeoutMs:40,connect:()=>net.createConnection({host:'127.0.0.1',port:1})}),e=>e.code==='PRIVATE_CONTEXT_OUTCOME_UNCERTAIN'&&e.sent===true);
 assert.equal(calls,1);
});
