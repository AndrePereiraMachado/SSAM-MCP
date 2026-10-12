import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {asyncStatusArguments,parseAsyncStatus} from '../service-center/async-status.mjs';
import {Client} from '../service-center/client.mjs';
import {StudioWebTransport,Transport} from '../service-center/http.mjs';
import {ProtocolError,AuthRequired} from '../service-center/errors.mjs';
import {main} from '../service-center/index.mjs';
import {serviceCenterArguments} from '../o11-operations.mjs';
import {FakeBridge,fakeVault} from './fixtures/sc-fake-bridge.mjs';

const xml=({state='done',count='0',cursor='27',messages='',extra=''}={})=>Buffer.from(`<servermessage><state>${state}</state><errorcount>${count}</errorcount><lastmessageid>${cursor}</lastmessageid><messagelist>${messages}</messagelist>${extra}</servermessage>`);
const message='<message><type>info</type><text><![CDATA[Done & packaged]]></text><detail><![CDATA[throw new Error("never evaluate")]]></detail></message>';

test('async status distinguishes finished preparation, failures and unfinished message loading',()=>{
 const done=parseAsyncStatus(xml({messages:message}));
 assert.equal(done.completedSuccessfully,true); assert.equal(done.terminal,true);
 assert.deepEqual(done.messages,[{type:'info',text:'Done & packaged'}]);
 assert.ok(!JSON.stringify(done).includes('never evaluate'));
 for(const state of ['running','loading','future-state']){
  const result=parseAsyncStatus(xml({state}));assert.equal(result.terminal,false);assert.equal(result.completedSuccessfully,false);
 }
 for(const input of [{state:'error'},{state:'done',count:'1'}]){
  const result=parseAsyncStatus(xml(input));assert.equal(result.terminal,true);assert.equal(result.completedSuccessfully,false);
 }
});

test('invalid XML, duplicate states, DTDs and cursor regression cannot report completion',()=>{
 for(const body of [Buffer.from('<html>done</html>'),Buffer.from('<servermessage><state>done</wrong></servermessage>'),
  Buffer.from('<!DOCTYPE servermessage>'+xml().toString()),xml({extra:'<state>done</state>'}),xml({count:'-1'}),xml({cursor:'abc'}),xml({state:''}),Buffer.alloc(1024*1024+1)])
  assert.throws(()=>parseAsyncStatus(body),ProtocolError);
 assert.throws(()=>parseAsyncStatus(xml({cursor:'26'}),27),ProtocolError);
});

test('async status bounds output and validates IDs before any transport',async()=>{
 const result=parseAsyncStatus(xml({messages:message.repeat(201)}));
 assert.equal(result.messages.length,200); assert.equal(result.messageCount,201); assert.equal(result.truncated,true);
 for(const id of ['',0,-1,'1&other=2','2147483648'])assert.throws(()=>asyncStatusArguments(id),ProtocolError);
 for(const cursor of [-2,'1.5','2147483648'])assert.throws(()=>asyncStatusArguments(1,cursor),ProtocolError);
 const transport={login:()=>assert.fail('No login'),download:()=>assert.fail('No network')};
 await assert.rejects(new Client({host:'test.example'},transport).asyncOperationStatus('bad'),ProtocolError);
});

test('public argument mapping and Service Center entry read one existing async ID without any POST',async()=>{
 const host='sc.example.test',bridge=new FakeBridge(),baseWeb=bridge.web.bind(bridge),requests=[];
 bridge.web=async(h,action,args)=>{
  if(action==='fetch'){
   requests.push(args);assert.equal(h,host);assert.equal(args.method,'GET');assert.equal(args.write,false);assert.equal(args.accept,'binary');
   const url=new URL(args.path,'https://'+host);
   assert.equal(url.pathname,'/ServiceCenter/AjaxStepsGetInfo.aspx');assert.equal(url.searchParams.get('AsyncOperationId'),'123');assert.equal(url.searchParams.get('LastSeenId'),'26');
   return{ok:true,status:200,finalUrl:url.href,contentType:'application/octet-stream',bodyBase64:xml({messages:message}).toString('base64')};
  }
  return baseWeb(h,action,args);
 };
 const argv=serviceCenterArguments({action:'async-operation-status',host,asyncOperationId:'123',lastMessageId:'26'},'read');
 const result=await main(argv,{locate:()=>bridge,present:async()=>false,running:async()=>true,opener:()=>assert.fail('No prompt')});
 assert.equal(result.asyncOperationId,'123');assert.equal(result.completedSuccessfully,true);assert.equal(requests.length,1);
});

test('an HTML async response is unavailable, never a completed or expired operation, on both transports',async()=>{
 const host='sc.example.test';
 for(const native of [false,true]){
  let requests=0;
  const response={status:200,contentType:'text/html',body:Buffer.from('<html>Unknown operation</html>')};
  const http=native ? new StudioWebTransport(host,{
   capabilities:async()=>new Set(),
   web:async(h,action,args)=>{requests++;assert.equal(args.method,'GET');return{ok:true,...response,body:undefined,bodyBase64:response.body.toString('base64'),finalUrl:'https://'+host+'/ServiceCenter/AjaxStepsGetInfo.aspx'};},
  }) : new Transport(host,{send:async({method})=>{requests++;assert.equal(method,'GET');return response;}});
  const client=new Client({host},http);
  client.login=async()=>{};
  await assert.rejects(client.asyncOperationStatus('6821','31773'),error=>{
   assert.equal(error.code,'SC_ASYNC_STATUS_UNAVAILABLE');
   assert.ok(!error.message.includes('Unknown operation'));
   return true;
  });
  assert.equal(requests,1);
 }
});

test('async status preserves authentication failures without reclassifying or retrying',async()=>{
 const expired=new AuthRequired('SC_AUTH_EXPIRED','Session expired');let calls=0;
 const client=new Client({host:'sc.example.test'},{download:async()=>{calls++;throw expired;}});
 client.login=async()=>{};
 await assert.rejects(client.asyncOperationStatus('6821'),error=>error===expired);
 assert.equal(calls,1);
});
