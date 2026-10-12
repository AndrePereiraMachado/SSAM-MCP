import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createPrivateCompareSession,compareHandles,privateCompareCommand,privateCompareHandlePattern} from '../debug-private-compare.mjs';
const S1='a'.repeat(32),S2='b'.repeat(32),C='c'.repeat(48),REQ='d'.repeat(64),OTHER='e'.repeat(64);
const server=(sessionId,value,requestId=REQ)=>({context:{sessionId,platform:'o11',runtime:'server',threadId:'T',eventId:'1',generation:1,frame:0,
 correlation:{nativeRequestIdSha256:requestId,nativeRequestIdProvenance:requestId!==null,requestOwnershipProved:false}},
 variable:{ref:'f'.repeat(32)},value});
const client=(value,stop=1)=>({context:{sessionId:C,platform:'odc',runtime:'client',stop,generation:stop,callContextId:3,frame:0},variable:{ref:'f'.repeat(48)},value});
const scalar=(value,path='CallerUserId')=>({type:'Scalar',value,path,unavailable:false,undefined:false,trimmed:false,deferred:false,children:[]});
const SECRET=/private-user|9007199254740995|"7"|[a-f0-9]{64}/;
function capture(){const keys=[];return {keys,random:n=>{const b=randomBytes(n);if(n===32)keys.push(b);return b;}};}
const expectRefusal=(fn,code)=>assert.throws(fn,error=>{assert.equal(error.message,'debug_private_compare_'+code);assert.doesNotMatch(error.message,SECRET);return true;});

test('equal, different and empty native values return booleans only, under exact typed equality',()=>{
 const session=createPrivateCompareSession({sessionId:C,lane:'odc',runtime:'client'}),m=session.member(C);
 const a=m.fingerprint(client({type:'Text',value:'private-user-Ω'})),b=m.fingerprint(client({type:'Text',value:'private-user-Ω'},2));
 const c=m.fingerprint(client({type:'Text',value:'private-user-other'})),empty=m.fingerprint(client({type:'Text',value:''}));
 const long=m.fingerprint(client({type:'LongInteger',value:'9007199254740995'})),text=m.fingerprint(client({type:'Text',value:'9007199254740995'}));
 const int=m.fingerprint(client({type:'Integer',value:7})),intText=m.fingerprint(client({type:'Integer',value:'7'}));
 for(const h of [a,b,c,empty,long,text])assert.match(h,/^pc_[a-f0-9]{32}$/);
 const results=[compareHandles(session,[a,b]),compareHandles(session,[a,c]),compareHandles(session,[a,empty]),
  compareHandles(session,[long,text]),compareHandles(session,[int,intText]),compareHandles(session,[a,b,c],{mode:'identity'})];
 assert.deepEqual(results[0],{equal:true,bothNonEmpty:true,sameNativeType:true,valueType:'Text',count:2});
 assert.deepEqual(results[1],{equal:false,bothNonEmpty:true,sameNativeType:true,valueType:'Text',count:2});
 assert.deepEqual(results[2],{equal:false,bothNonEmpty:false,sameNativeType:true,valueType:'Text',count:2});
 assert.deepEqual(results[3],{equal:false,bothNonEmpty:true,sameNativeType:false,valueType:null,count:2},'no coercion across native types');
 assert.equal(results[4].equal,false,'native Integer 7 and the string "7" are different wire values');
 assert.deepEqual(results[5],{equal:false,bothNonEmpty:true,sameNativeType:true,valueType:'Text',count:3});
 assert.doesNotMatch(JSON.stringify(results),SECRET);
 for(const empties of [{type:'Integer',value:0},{type:'LongInteger',value:'0'},{type:'Boolean',value:false},{type:'Text',value:null}]){
  const h=m.fingerprint(client(empties)),again=m.fingerprint(client(empties));
  assert.deepEqual(compareHandles(session,[h,again]),{equal:true,bothNonEmpty:false,sameNativeType:true,valueType:empties.type,count:2});
 }
 session.close();
});

test('compound native values compare by named children, never by display path; incomplete evaluations are refused',()=>{
 const session=createPrivateCompareSession({sessionId:S1,lane:'o11',runtime:'server'}),m=session.member(S1);
 const record=(root,id)=>({type:'Record',value:'{...}',path:root,children:[scalar(id,root+'.Id'),scalar('"private-user-Ω"',root+'.Name')]});
 const a=m.fingerprint(server(S1,record('Consumer.User','7'))),b=m.fingerprint(server(S1,record('Producer.Out','7'))),c=m.fingerprint(server(S1,record('X','8')));
 assert.deepEqual(compareHandles(session,[a,b]),{equal:true,bothNonEmpty:true,sameNativeType:true,valueType:'Record',count:2});
 assert.equal(compareHandles(session,[a,c]).equal,false);
 const list=(root,n,items=n)=>({type:'RecordList',value:'',path:root,children:[scalar(String(n),root+'.Length'),
  ...Array.from({length:items},(_,i)=>scalar(String(i),root+'.['+i+']'))]});
 const l0=m.fingerprint(server(S1,list('A',0))),l0b=m.fingerprint(server(S1,list('B',0))),l2=m.fingerprint(server(S1,list('A',2)));
 assert.deepEqual(compareHandles(session,[l0,l0b]),{equal:true,bothNonEmpty:false,sameNativeType:true,valueType:'RecordList',count:2});
 assert.equal(compareHandles(session,[l0,l2]).bothNonEmpty,false);
 const clientRecord=v=>({type:'Record',value:{UserName:{type:'Text',value:v},Id:{type:'LongInteger',value:'9007199254740995'}}});
 const r1=m.fingerprint(server(S1,scalar('"x"'))),incomplete=[{...scalar('7'),trimmed:true},{...scalar('7'),deferred:true},{...scalar('-undefined-'),undefined:true},
  {...scalar('-unavailable-'),unavailable:true},scalar('BinaryData (3 bytes)'),list('C',2,1),{type:'Record',value:null},{type:'BinaryData',value:3},{type:'Text'}];
 for(const value of incomplete){const h=m.fingerprint(server(S1,value));assert.match(h,/^pc_/);expectRefusal(()=>compareHandles(session,[r1,h]),'value_incomplete');}
 const cs=createPrivateCompareSession({sessionId:C,lane:'odc',runtime:'client'}),cm=cs.member(C);
 const x=cm.fingerprint(client(clientRecord('private-user-Ω'))),y=cm.fingerprint(client({type:'Record',value:{Id:{type:'LongInteger',value:'9007199254740995'},UserName:{type:'Text',value:'private-user-Ω'}}}));
 assert.equal(compareHandles(cs,[x,y]).equal,true,'record field order is not identity');
 const bin=cm.fingerprint(client({type:'BinaryData',value:'AAEC',encoding:'base64',byteLength:3})),bin2=cm.fingerprint(client({type:'BinaryData',value:'AAEC',encoding:'base64',byteLength:3}));
 assert.equal(compareHandles(cs,[bin,bin2]).equal,true);
 session.close();cs.close();
});

test('O11 group members are comparable only when bound to the same native request fingerprint',()=>{
 const session=createPrivateCompareSession({sessionId:'12345678-1234-4234-8234-123456789abc',lane:'o11',runtime:'server'});
 const consumer=session.member(S1),producer=session.member(S2);
 assert.throws(()=>session.member(S1),/debug_private_compare_member_invalid/);
 const caller=consumer.fingerprint(server(S1,scalar('7'))),observed=producer.fingerprint(server(S2,scalar('7','ObservedUser')));
 assert.deepEqual(compareHandles(session,[caller,observed],{mode:'equality'}),{equal:true,bothNonEmpty:true,sameNativeType:true,valueType:'Scalar',count:2});
 const otherRequest=producer.fingerprint(server(S2,scalar('7'),OTHER)),noProvenance=producer.fingerprint(server(S2,scalar('7'),null));
 expectRefusal(()=>compareHandles(session,[caller,otherRequest]),'request_mismatch');
 expectRefusal(()=>compareHandles(session,[caller,noProvenance]),'request_mismatch');
 const sameSession=consumer.fingerprint(server(S1,scalar('7'),OTHER));
 assert.equal(compareHandles(session,[caller,sameSession]).equal,true,'one native session may compare across its own requests');
 expectRefusal(()=>consumer.fingerprint(server(S2,scalar('7'))),'binding_invalid');
 expectRefusal(()=>consumer.fingerprint({...server(S1,scalar('7')),context:{...server(S1,scalar('7')).context,runtime:'client'}}),'binding_invalid');
 session.close();
});

test('foreign sessions, stop, budgets, unsupported identity types and caller-supplied values are refused',()=>{
 const k=capture(),session=createPrivateCompareSession({sessionId:C,lane:'odc',runtime:'client'},{random:k.random}),m=session.member(C);
 const other=createPrivateCompareSession({sessionId:C,lane:'odc',runtime:'client'}),om=other.member(C);
 const h=Array.from({length:9},()=>m.fingerprint(client({type:'Text',value:'private-user-Ω'})));
 const foreign=om.fingerprint(client({type:'Text',value:'private-user-Ω'}));
 expectRefusal(()=>compareHandles(session,[h[0],foreign]),'handle_unavailable');
 expectRefusal(()=>compareHandles(session,h),'budget');
 assert.equal(compareHandles(session,h.slice(0,8)).count,8);
 expectRefusal(()=>compareHandles(session,[h[0]]),'operands_invalid');
 expectRefusal(()=>compareHandles(session,[h[0],h[0]]),'operands_invalid');
 expectRefusal(()=>compareHandles(session,[h[0],'pc_'+'0'.repeat(31)]),'handle_invalid');
 for(const forged of [{type:'Text',value:'private-user-Ω'},'private-user-Ω'.length,null])
  expectRefusal(()=>compareHandles(session,[h[0],forged]),'caller_value_refused');
 for(const options of [{value:'private-user-Ω'},{expected:{type:'Text',value:'x'}},{mode:'equality',values:['x']}])
  expectRefusal(()=>compareHandles(session,[h[0],h[1]],options),'caller_value_refused');
 expectRefusal(()=>compareHandles(session,[h[0],h[1]],{mode:'evaluate'}),'mode_invalid');
 const types={Identifier:'7',LongInteger:'9007199254740995',Text:'private-user-Ω',Integer:7,Decimal:'1.5',Boolean:true,Record:{A:{type:'Text',value:'x'}}};
 for(const [type,value] of Object.entries(types)){
  const x=m.fingerprint(client({type,value})),y=m.fingerprint(client({type,value}));
  if(['Identifier','LongInteger','Text'].includes(type))assert.equal(compareHandles(session,[x,y],{mode:'identity'}).equal,true);
  else expectRefusal(()=>compareHandles(session,[x,y],{mode:'identity'}),'type_unsupported');
 }
 const ss=createPrivateCompareSession({sessionId:S1,lane:'o11',runtime:'server'}),sm=ss.member(S1);
 expectRefusal(()=>compareHandles(ss,[sm.fingerprint(server(S1,scalar('7'))),sm.fingerprint(server(S1,scalar('7')))],{mode:'identity'}),'type_unsupported');
 const released=other.member('f'.repeat(48));released.release();expectRefusal(()=>released.fingerprint(client({type:'Text',value:'x'})),'closed');
 const second=om.fingerprint(client({type:'Text',value:'private-user-Ω'}));assert.equal(compareHandles(other,[foreign,second]).equal,true);
 om.release();expectRefusal(()=>compareHandles(other,[foreign,second]),'handle_unavailable');
 assert.equal(k.keys.length,1);assert.ok(k.keys[0].some(b=>b!==0));
 assert.deepEqual(session.close(),{closed:true,handles:0});
 assert.ok(k.keys[0].every(b=>b===0),'per-session HMAC key is zeroed on close');
 expectRefusal(()=>compareHandles(session,[h[0],h[1]]),'closed');
 expectRefusal(()=>m.fingerprint(client({type:'Text',value:'x'})),'closed');
 expectRefusal(()=>session.member('0'.repeat(48)),'closed');
 ss.close();other.close();
});

test('stop releases one member; handles of that native session are refused afterwards',()=>{
 const session=createPrivateCompareSession({sessionId:'p',lane:'o11',runtime:'server'}),a=session.member(S1),b=session.member(S2);
 const ha=a.fingerprint(server(S1,scalar('7'))),hb=b.fingerprint(server(S2,scalar('7')));
 assert.equal(compareHandles(session,[ha,hb]).equal,true);
 assert.deepEqual(a.release(),{released:true});
 expectRefusal(()=>compareHandles(session,[ha,hb]),'handle_unavailable');
 expectRefusal(()=>a.fingerprint(server(S1,scalar('7'))),'closed');
 assert.equal(session.receipt().handles,1);assert.equal(session.receipt().persisted,false);
 session.close();
});

test('app-user anchor is a second operand only through the injected private provider',()=>{
 const none=createPrivateCompareSession({sessionId:C,lane:'odc',runtime:'client'}),nm=none.member(C);
 const own=nm.fingerprint(client({type:'Text',value:'private-user-Ω'}));
 expectRefusal(()=>compareHandles(none,[own],{anchor:'app-user'}),'anchor_unavailable');
 let calls=0,observed;
 const anchorProvider=({anchor,seal})=>{calls++;observed=anchor;return seal({type:'Text',value:'private-user-Ω'});};
 const session=createPrivateCompareSession({sessionId:C,lane:'odc',runtime:'client',anchorProvider}),m=session.member(C);
 const h=m.fingerprint(client({type:'Text',value:'private-user-Ω'})),o=m.fingerprint(client({type:'Text',value:'private-user-other'}));
 assert.deepEqual(compareHandles(session,[h],{anchor:'app-user',mode:'identity'}),{equal:true,bothNonEmpty:true,sameNativeType:true,valueType:'Text',count:2});
 assert.equal(compareHandles(session,[o],{anchor:'app-user'}).equal,false);
 assert.equal(observed,'app-user');assert.equal(calls,2);
 expectRefusal(()=>compareHandles(session,[h],{anchor:'other-user'}),'anchor_invalid');
 expectRefusal(()=>compareHandles(session,Array.from({length:8},()=>m.fingerprint(client({type:'Text',value:'x'}))),{anchor:'app-user'}),'budget');
 for(const provider of [()=>({mac:'0'.repeat(64),type:'Text'}),()=>Promise.resolve(),()=>Promise.reject(new Error('private-user-Ω')),()=>{throw new Error('private-user-Ω');}]){
  const s=createPrivateCompareSession({sessionId:C,lane:'odc',runtime:'client',anchorProvider:provider}),sm=s.member(C);
  expectRefusal(()=>compareHandles(s,[sm.fingerprint(client({type:'Text',value:'x'}))],{anchor:'app-user'}),'anchor_unavailable');s.close();
 }
 assert.throws(()=>createPrivateCompareSession({anchorProvider:'app-user'}),/debug_private_compare_anchor_provider_invalid/);
 none.close();session.close();
});

test('public command {op:"private-compare",handles,mode?,anchor?} returns the booleans only, under the caller prefix',()=>{
 assert.equal(privateCompareHandlePattern.source,'^pc_[a-f0-9]{32}$');
 const session=createPrivateCompareSession({sessionId:S1,lane:'o11',runtime:'server'}),m=session.member(S1);
 const a=m.fingerprint(server(S1,scalar('7'))),b=m.fingerprint(server(S1,scalar('7','ObservedUser')));
 assert.deepEqual(privateCompareCommand(session,{op:'private-compare',handles:[a,b]},'debug_server_session_private_compare_'),
  {op:'private-compare',equal:true,bothNonEmpty:true,sameNativeType:true,valueType:'Scalar',count:2});
 assert.equal(privateCompareCommand(session,{op:'private-compare',handles:[a,b],mode:'equality'}).equal,true);
 const refused=(input,code,prefix)=>assert.throws(()=>privateCompareCommand(session,input,prefix),error=>{
  assert.equal(error.message,(prefix??'debug_private_compare_')+code);assert.doesNotMatch(error.message,SECRET);return true;});
 refused({op:'private-compare',handles:[a,b],value:'private-user-7'},'caller_value_refused','debug_server_session_private_compare_');
 refused({op:'private-compare',handles:[a],values:['7'],anchor:'app-user'},'caller_value_refused');
 refused({op:'read',handles:[a,b]},'operation_invalid');
 refused({op:'private-compare',handles:[a],anchor:'app-user'},'anchor_unavailable','debug_client_session_private_compare_');
 refused({op:'private-compare',handles:[a,b],mode:'identity'},'type_unsupported');
 refused(null,'operation_invalid');
 assert.throws(()=>privateCompareCommand({},{op:'private-compare',handles:[a,b]}),/^Error: debug_private_compare_session_unavailable$/);
 assert.throws(()=>privateCompareCommand(session,{op:'private-compare',handles:[a,b]},'bad prefix'),/^Error: debug_private_compare_prefix_invalid$/);
 session.close();refused({op:'private-compare',handles:[a,b]},'closed','debug_server_session_private_compare_');
});
