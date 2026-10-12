import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { Transport, StudioWebTransport } from '../service-center/http.mjs';
import { Client, Journal } from '../service-center/client.mjs';
import { Document, Page } from '../service-center/html.mjs';
import { temp, uuid } from './fixtures/sc-fake-bridge.mjs';
test('native captured schedule fields expand intervals and enforce the actual maxlength',async()=>{
 const {nativeScheduleControls,nativeScheduleRequest}=await import('../service-center/client.mjs');
 const p=new Page(url,new Document('<form method="post"><div class="sc-content-main"><input name="f$wtInputTimerTimes" maxlength="1900"><select name="f$wtSelectScheduleType"><option value="nativeDaily" selected>Daily</option><option value="nativeWeekly">Weekly</option></select></div></form>'));
 const target=nativeScheduleControls(p,p.doc.first('form'));
 for(const every of ['5','10','60']){
   const value=nativeScheduleRequest(target,{every});
   assert.equal(value.recurrence,'Daily');assert.equal(value.at.split(' ').length,1440/Number(every));assert.ok(value.at.length<=1900);
 }
 for(const every of ['1','2','3']) assert.throws(()=>nativeScheduleRequest(target,{every}),/length limit/);
 for(const every of ['0','7','61','every one minute']) assert.throws(()=>nativeScheduleRequest(target,{every}),/integer divisor/);
 assert.deepEqual(nativeScheduleRequest(target,{at:'17:40 17:45'}),{recurrence:'Daily',at:'17:40 17:45'});
 assert.deepEqual(nativeScheduleRequest(target,{at:''}),{recurrence:'Daily',at:''});
 assert.throws(()=>nativeScheduleRequest(target,{at:'24:00'}),/HH:mm/);
 assert.throws(()=>nativeScheduleRequest(target,{every:'5',at:'12:00'}),/not both/);
 assert.throws(()=>nativeScheduleRequest(target,{recurrence:'Weekly',at:'12:00'}),/Daily occurrence only/);
 assert.throws(()=>nativeScheduleRequest(target,{timeout:'1'}),/not mapped/);
});
const host='test.example.com';
const url='https://'+host+'/ServiceCenter/eSpace_Timer_Edit.aspx?id=7';
const script="OsAjax(arguments[0] || window.event,'run','form$run','','__OSVSTATE,',''); return false;";
function page(onclick=script) { return new Page(url,new Document('<form method="post"><input type="hidden" name="__OSVSTATE" value="state"><input type="submit" id="run" name="form$run" value="Run Now" onclick="'+onclick+'"></form>')); }
const body=JSON.stringify('<div class="Feedback_Message_Success">Timer scheduled</div>');
function client(http, p=page()){const c=new Client({host},http);c.detail=async()=>p;return c;}
test('live Run Now AJAX protocol is one journaled write, not a read, and UUID never replays',async()=>{
 const journal=new Journal(temp()),operationId=uuid(),calls=[];
 const http=new Transport(host,{send:async request=>{
   calls.push(request); assert.equal(JSON.parse(fs.readFileSync(journal.path(operationId))).state,'sending');
   const fields=new URLSearchParams(request.body);
   assert.equal(fields.get('__EVENTTARGET'),'form$run');assert.equal(fields.get('__OSVSTATE'),'state');
   return {status:200,body:Buffer.from(body),contentType:'text/javascript',setCookie:[]};
 }});
 const c=client(http),args={execute:true,words:'Run Worker once',operationId,journal};
 const result=await c.mutate('timer-run','7','Worker',args);
 assert.equal(result.state,'accepted'); assert.equal(result.executionCompleted,false);
 assert.equal(result.schedulerResponse.schedulingAcknowledged,true);
 assert.equal(result.schedulerResponse.sha256,createHash('sha256').update(body).digest('hex'));
 assert.equal((await c.mutate('timer-run','7','Worker',args)).existingReceipt,true);assert.equal(calls.length,1);
});

test('unrecognized scheduler reply keeps response evidence without retaining markup or inventing acceptance',async()=>{
 const reply=JSON.stringify('<div>private-response-marker</div>');
 const journal=new Journal(temp()),operationId=uuid();
 const c=client(new Transport(host,{send:async()=>({status:200,body:Buffer.from(reply),contentType:'text/javascript',setCookie:[]})}));
 const result=await c.mutate('timer-run','7','Worker',{execute:true,words:'Run Worker',operationId,journal});
 assert.equal(result.state,'accepted-unverified');assert.equal(result.schedulerResponse.received,true);
 assert.equal(result.schedulerResponse.schedulingAcknowledged,false);assert.equal(result.schedulerResponse.bytes,Buffer.byteLength(reply));
 assert.equal(result.schedulerResponse.sha256,createHash('sha256').update(reply).digest('hex'));
 const stored=fs.readFileSync(journal.path(operationId),'utf8');assert.ok(!stored.includes('private-response-marker'));
 assert.deepEqual(JSON.parse(stored).schedulerResponse,result.schedulerResponse);
});
test('unsupported Run Now script refuses before journal reservation or any network send',async()=>{
 const journal=new Journal(temp()),operationId=uuid();
 const c=client(new Transport(host,{send:()=>assert.fail('no send')}),page(script.replace("'form$run'","'other'")));
 await assert.rejects(c.mutate('timer-run','7','Worker',{execute:true,words:'Run Worker',operationId,journal}),e=>e.code==='SC_PROTOCOL_INVALID'&&/Unsupported AJAX/.test(e.message));
 assert.equal(fs.existsSync(journal.path(operationId)),false);
});
test('AJAX commit remains uncertain after transport loss and records actual send attempt',async()=>{
 const journal=new Journal(temp()),http=new Transport(host,{send:async()=>{throw new Error('lost');}});
 const c=client(http),result=await c.mutate('timer-run','7','Worker',{execute:true,words:'Run Worker',operationId:uuid(),journal});
 assert.equal(result.state,'uncertain');
 await assert.rejects(c.mutate('timer-run','7','Worker',{execute:true,words:'Run Worker',operationId:uuid(),journal}),/pending\/uncertain/);
});
test('Studio transport sends AJAX timer commit with write authorization',async()=>{
 const calls=[],http=new StudioWebTransport(host,{web:async(...args)=>{
 calls.push(args);return {ok:true,status:200,finalUrl:url,contentType:'text/javascript',html:body};
 }});
 const journal=new Journal(temp()),operationId=uuid();
 await client(http).mutate('timer-run','7','Worker',{execute:true,words:'Run Worker',operationId,journal});
 const request=calls[0][2];assert.equal(request.write,true);assert.equal(request.operationId,operationId);assert.ok(request.authorizeSha256);
});
