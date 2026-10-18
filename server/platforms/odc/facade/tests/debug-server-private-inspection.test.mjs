import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,randomBytes} from 'node:crypto';
import {createServerPrivateInspection} from '../debug-server-private-inspection.mjs';
import {createPrivateCompareSession,compareHandles} from '../debug-private-compare.mjs';
const binding={kind:'native-debug-session',sessionId:'a'.repeat(32),lane:'o11',runtimeUrl:'https://fixture.outsystemscloud.com/Fixture/',moduleKey:'A'.repeat(22),module:'Fixture',contextMode:'native-background'};
const sources=[{moduleKey:binding.moduleKey,sourceSha256:'b'.repeat(64)}];
const context={runtime:'server',threadId:'1',eventId:'2',generation:1,frame:0,moduleKey:binding.moduleKey,functionKey:'C'.repeat(22),nodeKey:'D'.repeat(22)};
const variable={ref:'e'.repeat(32),...sources[0]};
const value={type:'Record',value:'native-text-Ω',children:[{type:'Scalar',value:'private-secret-🔒',path:'Secret'}]};
function fixture({real=false,forgetFails=false}={}){
 const records=new Map();let now=Date.now();
 const vault=(mode,ref,record)=>{if(mode==='Seal'){assert.equal(records.has(ref),false);records.set(ref,structuredClone(record));return{ok:true};}
  if(mode==='Open')return structuredClone(records.get(ref));if(forgetFails)throw new Error('private-secret');records.delete(ref);return{ok:true};};
 const channel=createServerPrivateInspection({binding,sources,expiresAt:new Date(now+60000).toISOString()},real?{}:{vault,clock:()=>now});
 function response(envelope={context,variable,value},secret=channel.bootstrapKey()){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(secret,'hex'),nonce);
  cipher.setAAD(Buffer.from('ssam-server-private-inspection/1|'+binding.sessionId));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(envelope)),cipher.final()]);
  return {ok:true,context,reference:variable.ref,evaluationRevision:1,changed:null,privatePayload:{format:'ssam-server-private-inspection/1',nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}};
 }
 return{channel,records,response,request:{reference:variable.ref,threadId:context.threadId,eventId:context.eventId},expire:()=>now+=60001};
}
test('server private native wire returns only an opaque reference; internal consumer gets complete native value',async()=>{
 const f=fixture();try{
  const result=f.channel.read(f.response(),f.request);
  assert.doesNotMatch(JSON.stringify(result),/private-secret|native-text|ciphertext|privatePayload/);
  let observed;const receipt=await f.channel.consume(result.privateInspection,context,v=>{observed=v;return value;});
  assert.deepEqual(observed,value);assert.equal(receipt.consumed,true);assert.equal(receipt.value,undefined);
  await assert.rejects(f.channel.consume(result.privateInspection,context,()=>{throw new Error('private-secret');}),/^Error: debug_server_private_inspection_unavailable$/);
  assert.deepEqual(f.channel.invalidate(),{completed:true,pending:0});
  await assert.rejects(f.channel.consume(result.privateInspection,context,()=>{}),/unavailable/);
 }finally{f.channel.close();}
});
test('server channel rejects wrong key, tampering, stop, reference, source and native context before publishing',()=>{
 const f=fixture();try{
  const bad=f.response();bad.privatePayload.tag=randomBytes(16).toString('base64');
  for(const result of [bad,f.response(undefined,'c'.repeat(64)),f.response({context:{...context,eventId:'3'},variable,value}),
   f.response({context,variable:{...variable,sourceSha256:'f'.repeat(64)},value})])assert.throws(()=>f.channel.read(result,f.request),/unavailable/);
  assert.throws(()=>f.channel.read(f.response(),{...f.request,threadId:'other'}),/unavailable/);
  assert.throws(()=>f.channel.read(f.response(),{...f.request,reference:'f'.repeat(32)}),/unavailable/);
  assert.equal(f.records.size,0);
 }finally{f.channel.close();}
});
test('server private capability is bounded by every stop/frame dimension and expiry, even when deletion fails',async()=>{
 const f=fixture({forgetFails:true});try{
  const result=f.channel.read(f.response(),f.request);
  for(const key of ['threadId','eventId','frame','generation'])await assert.rejects(f.channel.consume(result.privateInspection,
   {...context,[key]:typeof context[key]==='number'?context[key]+1:'other'},()=>{}),/unavailable/);
  f.expire();await assert.rejects(f.channel.consume(result.privateInspection,context,()=>{}),/unavailable/);
  assert.deepEqual(f.channel.invalidate(),{completed:false,pending:1});
 }finally{f.channel.close();}
});
const user={type:'Scalar',value:'private-user-7731',path:'CallerUserId',unavailable:false,undefined:false,trimmed:false,deferred:false,children:[]};
const correlated=requestId=>({...context,correlation:{nativeClientCallContextSha256:null,nativeRequestIdSha256:requestId,nativeRequestIdProvenance:true,requestOwnershipProved:false}});
function memory(){const records=new Map();return{records,vault:(mode,ref,record)=>{if(mode==='Seal'){records.set(ref,structuredClone(record));return{ok:true};}
 if(mode==='Open')return structuredClone(records.get(ref));records.delete(ref);return{ok:true};}};}
function wire(channel,sessionId,envelope){
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(channel.bootstrapKey(),'hex'),nonce);
 cipher.setAAD(Buffer.from('ssam-server-private-inspection/1|'+sessionId));
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(envelope)),cipher.final()]);
 return {ok:true,context:envelope.context,reference:envelope.variable.ref,evaluationRevision:1,changed:null,privatePayload:{format:'ssam-server-private-inspection/1',nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}};
}
const request={reference:variable.ref,threadId:context.threadId,eventId:context.eventId};
test('private-read mints an opaque compare handle under the public-session HMAC key; it survives steps and stop releases it',()=>{
 const keys=[],m=memory(),now=Date.now(),expiresAt=new Date(now+60000).toISOString();
 const session=createPrivateCompareSession({sessionId:'12345678-1234-4234-8234-123456789abc',lane:'o11',runtime:'server'},{random:n=>{const b=randomBytes(n);if(n===32)keys.push(b);return b;}});
 const channel=createServerPrivateInspection({binding,sources,expiresAt},{vault:m.vault,clock:()=>now,privateCompare:session});
 try{
  const first=channel.read(wire(channel,binding.sessionId,{context,variable,value:user}),request);
  const second=channel.read(wire(channel,binding.sessionId,{context,variable,value:{...user,path:'ObservedUser'}}),request);
  const other=channel.read(wire(channel,binding.sessionId,{context,variable,value:{...user,value:'private-user-8842'}}),request);
  for(const r of [first,second,other]){assert.match(r.privateCompareHandle,/^pc_[a-f0-9]{32}$/);assert.equal(Object.hasOwn(r.privateInspection,'compareHandle'),false);}
  assert.notEqual(first.privateCompareHandle,second.privateCompareHandle);
  assert.doesNotMatch(JSON.stringify([first,second,other]),/private-user|[a-f0-9]{64}/);
  assert.equal(JSON.stringify([...m.records.values()]).includes('pc_'),false,'the DPAPI record carries no compare handle or fingerprint');
  assert.deepEqual(channel.compare([first.privateCompareHandle,second.privateCompareHandle]),{equal:true,bothNonEmpty:true,sameNativeType:true,valueType:'Scalar',count:2});
  assert.equal(channel.compare([first.privateCompareHandle,other.privateCompareHandle]).equal,false);
  assert.deepEqual(channel.invalidate(),{completed:true,pending:0});
  assert.equal(channel.compare([first.privateCompareHandle,second.privateCompareHandle]).equal,true,'compare handles survive steps');
  assert.deepEqual(channel.close(),{completed:true,pending:0});
  assert.throws(()=>session.compare([first.privateCompareHandle,second.privateCompareHandle]),/^Error: debug_private_compare_handle_unavailable$/);
  assert.throws(()=>channel.compare([first.privateCompareHandle,second.privateCompareHandle]),/^Error: debug_private_compare_closed$/);
  assert.ok(keys[0].some(b=>b!==0));session.close();assert.ok(keys[0].every(b=>b===0),'public-session key zeroed on close');
 }finally{channel.close();session.close();}
});
test('O11 group: two native sessions share one public key; only handles bound to the same native request compare',()=>{
 const m=memory(),now=Date.now(),expiresAt=new Date(now+60000).toISOString(),producer={...binding,sessionId:'f'.repeat(32)};
 const session=createPrivateCompareSession({sessionId:'12345678-1234-4234-8234-123456789abc',lane:'o11',runtime:'server'});
 const consumer=createServerPrivateInspection({binding,sources,expiresAt},{vault:m.vault,clock:()=>now,privateCompare:session});
 const service=createServerPrivateInspection({binding:producer,sources,expiresAt},{vault:m.vault,clock:()=>now,privateCompare:session});
 try{
  assert.throws(()=>createServerPrivateInspection({binding,sources,expiresAt},{vault:m.vault,clock:()=>now,privateCompare:session}),/debug_private_compare_member_invalid/);
  const caller=consumer.read(wire(consumer,binding.sessionId,{context:correlated('1'.repeat(64)),variable,value:user}),request).privateCompareHandle;
  const observed=service.read(wire(service,producer.sessionId,{context:correlated('1'.repeat(64)),variable,value:{...user,path:'ObservedUser'}}),request).privateCompareHandle;
  const foreign=service.read(wire(service,producer.sessionId,{context:correlated('2'.repeat(64)),variable,value:user}),request).privateCompareHandle;
  assert.deepEqual(compareHandles(session,[caller,observed]),{equal:true,bothNonEmpty:true,sameNativeType:true,valueType:'Scalar',count:2});
  assert.throws(()=>compareHandles(session,[caller,foreign]),/^Error: debug_private_compare_request_mismatch$/);
  service.close();assert.throws(()=>compareHandles(session,[caller,observed]),/handle_unavailable/);
 }finally{consumer.close();service.close();session.close();}
});
test('without a coordinator session each native private channel owns and closes its key; incomplete native wire is not comparable',()=>{
 const f=fixture();
 try{
  const a=f.channel.read(f.response({context,variable,value:user}),f.request),b=f.channel.read(f.response({context,variable,value:user}),f.request);
  assert.equal(f.channel.compare([a.privateCompareHandle,b.privateCompareHandle]).equal,true);
  const malformed=f.channel.read(f.response(),f.request);assert.match(malformed.privateCompareHandle,/^pc_/);
  assert.throws(()=>f.channel.compare([a.privateCompareHandle,malformed.privateCompareHandle]),/^Error: debug_private_compare_value_incomplete$/);
  f.channel.close();assert.throws(()=>f.channel.compare([a.privateCompareHandle,b.privateCompareHandle]),/^Error: debug_private_compare_closed$/);
 }finally{f.channel.close();}
});
test('server encrypted worker response round trips through real Windows DPAPI and cleans up',{skip:process.platform!=='win32'},async()=>{
 const f=fixture({real:true});try{
  const result=f.channel.read(f.response(),f.request);let observed;
  await f.channel.consume(result.privateInspection,context,v=>{observed=v;});assert.deepEqual(observed,value);
  assert.deepEqual(f.channel.close(),{completed:true,pending:0});
 }finally{f.channel.close();}
});

// ODC Service identity: the app-user anchor registered at the original login, compared with a
// private-read of the Service GetUserId() variable. GUID text compares case-insensitively.
import {createAppUserAnchorRegistry,createProducerOutputParity} from '../debug-server-private-inspection.mjs';
import {odcAppUserAnchor} from '../debug-app-user-odc.mjs';
import {createNativeResponseObserver} from '../debug-odc-native-response-observer.mjs';
const USER='9F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9';
const odc={...binding,lane:'odc',contextMode:'app-user',appUser:{lane:'odc',runtimeUrl:'https://fixture.outsystemscloud.com/Fixture/',app:'Fixture',sessionId:'a'.repeat(32),module:'Fixture',moduleKey:binding.moduleKey}};
const odcContext={...context};
const anchorOf=userKey=>odcAppUserAnchor({credentialRef:'11111111-2222-4333-8444-555555555555',binding:{lane:'odc',runtimeUrl:odc.appUser.runtimeUrl,app:'Fixture',sessionId:'a'.repeat(32)},
  expiresAt:new Date(Date.now()+60000).toISOString(),state:'authenticated',authenticated:true,userKey},{authenticated:true,identityMatches:true});
function odcSession(){
 const m=memory(),now=Date.now(),registry=createAppUserAnchorRegistry();
 const session=createPrivateCompareSession({sessionId:'12345678-1234-4234-8234-123456789abc',lane:'odc',runtime:'server',anchorProvider:registry.provider});
 const channel=createServerPrivateInspection({binding:odc,sources,expiresAt:new Date(now+60000).toISOString()},{vault:m.vault,clock:()=>now,privateCompare:session});
 const handle=value=>channel.read(wire(channel,odc.sessionId,{context:odcContext,variable,value:{...user,path:'ServiceUserId',value}}),request).privateCompareHandle;
 return {registry,session,channel,handle,close:()=>{channel.close();session.close();registry.clear();}};
}
test('app-user anchor: equal across GUID case and Text quoting, different user false, missing anchor refused, nothing returned',()=>{
 const s=odcSession();
 try{
  const service=s.handle('"'+USER+'"'),lower=s.handle(USER.toLowerCase()),other=s.handle('"0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9"');
  assert.throws(()=>compareHandles(s.session,[service],{anchor:'app-user'}),/^Error: debug_private_compare_anchor_unavailable$/,'no authenticated anchor yet');
  assert.deepEqual(s.registry.register(anchorOf(USER.toLowerCase())),{registered:true});
  const equal=compareHandles(s.session,[service],{anchor:'app-user'});
  assert.throws(()=>compareHandles(s.session,[service],{anchor:'app-user',mode:'identity'}),/type_unsupported/,'server Scalar renderings use equality mode');
  assert.deepEqual(equal,{equal:true,bothNonEmpty:true,sameNativeType:true,valueType:'Scalar',count:2});
  assert.equal(compareHandles(s.session,[lower],{anchor:'app-user'}).equal,true);
  assert.equal(compareHandles(s.session,[other],{anchor:'app-user'}).equal,false);
  assert.equal(compareHandles(s.session,[service,lower]).equal,true,'GUID canonicalization also applies between two reads');
  assert.doesNotMatch(JSON.stringify([equal,s.registry.receipt(),s.session.receipt()]),/9f1e2d3c|0f1e2d3c|[a-f0-9]{64}/i);
  assert.throws(()=>s.registry.register(anchorOf('0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9')),/anchor_invalid/,'one login per public session');
  assert.throws(()=>s.registry.register({kind:'app-user',value:USER}),/anchor_invalid/);
  s.registry.clear();
  assert.throws(()=>compareHandles(s.session,[service],{anchor:'app-user'}),/anchor_unavailable/,'cleared with the public session');
 }finally{s.close();}
});
test('anonymous and native-background sessions never get an anchor: compare refuses',()=>{
 const registry=createAppUserAnchorRegistry();
 assert.throws(()=>registry.provider({anchor:'app-user',runtime:'server',seal:v=>v}),/anchor_unavailable/);
 assert.deepEqual(registry.receipt(),{registered:false,closed:false,valueReturned:false});
});

// Producer parity: at the target End stop the coordinator private-reads the output roots; only counts leave.
const END='E'.repeat(22);
const endContext={...context,nodeKey:END};
const out=(path,value)=>({...user,path,value});
test('End-stop private read feeds the comparator; counts only, bound to the scenario and the End stop',async()=>{
 const m=memory(),now=Date.now(),parity=createProducerOutputParity();
 const channel=createServerPrivateInspection({binding,sources,expiresAt:new Date(now+60000).toISOString()},{vault:m.vault,clock:()=>now});
 try{
  const read=(path,value,ctx=endContext)=>({root:path,privateInspection:channel.read(wire(channel,binding.sessionId,{context:ctx,variable,value:out(path,value)}),
   {...request,eventId:ctx.eventId}).privateInspection});
  const reads=[read('Amount','12.50'),read('Label','"PRIVATE-Ω"')];
  await assert.rejects(parity.captureEnd(channel,reads,endContext,{functionKey:context.functionKey,endNodeKey:END}),/scenario_unbound/);
  parity.begin('scenario-1');
  await assert.rejects(parity.captureEnd(channel,reads,context,{functionKey:context.functionKey,endNodeKey:END}),/end_stop_required/);
  const captured=await parity.captureEnd(channel,reads,endContext,{functionKey:context.functionKey,endNodeKey:END});
  assert.deepEqual(captured,{captured:true,roots:2,complete:true,valuesReturned:false});
  await assert.rejects(parity.captureEnd(channel,reads,endContext,{functionKey:context.functionKey,endNodeKey:END}),/end_already_captured/);
  const observer=createNativeResponseObserver({parityKey:parity.responseKey()});
  observer.observe(JSON.stringify({type:3,invocationId:'0',result:{ResponseStatusCode:200,ResponseBody:JSON.stringify({data:{Amount:12.5,Label:'PRIVATE-Ω',Extra:true}})}})+'\x1e','0');
  assert.throws(()=>parity.compare(observer.responsePrints('0'),'scenario-2'),/scenario_mismatch/);
  const counts=parity.compare(observer.responsePrints('0'),'scenario-1');
  assert.deepEqual(counts,{schema:'ssam-producer-output-parity/1',complete:true,compared:2,unequal:0,missing:0,extra:0,typeDifferences:0,parityEqual:true});
  assert.doesNotMatch(JSON.stringify([captured,counts]),/PRIVATE|Amount|Label|12\.5|[a-f0-9]{32}/);
  // The native End capture is consumed by the comparison; a scenario without an End stop is not compared.
  parity.begin('scenario-2');
  assert.deepEqual(parity.compare(observer.responsePrints('0'),'scenario-2'),{schema:'ssam-producer-output-parity/1',complete:false,reason:'producer-end-not-captured',
   compared:0,unequal:0,missing:0,extra:0,typeDifferences:0,parityEqual:false});
  // A stale private reference (after a step) is refused and captures nothing.
  channel.invalidate();
  await assert.rejects(parity.captureEnd(channel,reads,endContext,{functionKey:context.functionKey,endNodeKey:END}),/unavailable/);
  assert.equal(parity.compare(observer.responsePrints('0'),'scenario-2').reason,'producer-end-not-captured');
  parity.close();assert.throws(()=>parity.responseKey(),/closed/);
 }finally{channel.close();parity.close();}
});
