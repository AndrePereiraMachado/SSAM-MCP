import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateInspectionChannel,privateInspectionVault} from '../debug-private-inspection.mjs';
import {createPrivateCompareSession} from '../debug-private-compare.mjs';
const binding={lane:'odc',runtimeUrl:'https://fixture.outsystems.app/Fixture/',app:'Fixture',sessionId:'a'.repeat(32),module:'Fixture',moduleKey:'A'.repeat(22)};
const sources=[{moduleKey:binding.moduleKey,sourceSha256:'b'.repeat(64)}];
const context={sessionId:'c'.repeat(48),platform:'odc',runtime:'client',stop:1,generation:1,callContextId:9,frame:0};
const variable={ref:'d'.repeat(48),moduleKey:binding.moduleKey,sourceSha256:sources[0].sourceSha256,actionKey:'E'.repeat(22),name:'Client.UserName',category:'client'};
const value={type:'Record',value:{UserName:{type:'Text',value:'private-user-Ω'},Secret:{type:'Text',value:'private-password-🔒'},Data:{type:'Text',value:'x'.repeat(9000)}}};
function fixture(options={}){
 let now=Date.now();const records=new Map(),calls=[];
 const vault=(mode,ref,record)=>{calls.push({mode,ref});if(mode==='Seal'){assert.equal(records.has(ref),false);records.set(ref,structuredClone(record));return{ok:true};}
  if(mode==='Open'){if(!records.has(ref))throw new Error('private-user-Ω');return structuredClone(records.get(ref));}
  if(options.forgetFails)throw new Error('private-password-🔒');records.delete(ref);return{ok:true};};
 const expiresAt=new Date(now+60000).toISOString();
 return{records,calls,vault,expiresAt,advance:()=>{now+=60001;},channel:createPrivateInspectionChannel({binding,expiresAt,sources},{vault,clock:()=>now})};
}
test('private native wire round trip exposes only an opaque descriptor and consumes through its active native context',()=>{
 const f=fixture(),descriptor=f.channel.publish({context,variable,value});
 assert.equal(descriptor.roundTripVerified,true);assert.equal(descriptor.plaintextPersisted,false);
 assert.doesNotMatch(JSON.stringify(descriptor),/private-user|private-password|UserName|Secret|Data/);
 assert.deepEqual(f.channel.consume(descriptor,context),value);
 assert.deepEqual(f.channel.invalidate(),{completed:true,pending:0});assert.equal(f.records.size,0);
 assert.throws(()=>f.channel.consume(descriptor,context),/^Error: debug_private_inspection_stale_reference$/);
 assert.deepEqual(f.channel.close(),{completed:true,pending:0});
});
test('every native stop/frame/session dimension and expiry gates private consumption',()=>{
 const f=fixture(),descriptor=f.channel.publish({context,variable,value});
 for(const key of Object.keys(context))assert.throws(()=>f.channel.consume(descriptor,{...context,[key]:typeof context[key]==='number'?context[key]+1:'other'}),/debug_private_inspection_stale_reference/);
 f.advance();assert.throws(()=>f.channel.consume(descriptor,context),/debug_private_inspection_stale_reference/);
 assert.throws(()=>f.channel.publish({context,variable,value}),/debug_private_inspection_expired/);f.channel.close();
});
test('failed deletion invalidates the capability before cleanup and retains an honest cleanup failure',()=>{
 const f=fixture({forgetFails:true}),descriptor=f.channel.publish({context,variable,value});
 assert.deepEqual(f.channel.invalidate(),{completed:false,pending:1});
 assert.equal(f.records.size,1);assert.throws(()=>f.channel.consume(descriptor,context),/debug_private_inspection_stale_reference/);
 assert.deepEqual(f.channel.close(),{completed:false,pending:1});
});
test('wrong pinned source is refused without vault I/O; failed Seal is never repeated and errors contain no values',()=>{
 const f=fixture();assert.throws(()=>f.channel.publish({context,variable:{...variable,sourceSha256:'e'.repeat(64)},value}),/debug_private_inspection_scope_invalid/);assert.equal(f.calls.length,0);
 let seals=0;const broken=createPrivateInspectionChannel({binding,expiresAt:f.expiresAt,sources},{vault:(mode)=>{if(mode==='Seal'){seals++;throw new Error('private-password-🔒');}return{ok:true};}});
 assert.throws(()=>broken.publish({context,variable,value}),/^Error: debug_private_inspection_publish_failed$/);assert.equal(seals,1);broken.close();
});
test('real Windows CurrentUser DPAPI preserves private Unicode/native wire and cleanup removes its only sealed record',{skip:process.platform!=='win32'},()=>{
 const channel=createPrivateInspectionChannel({binding,expiresAt:new Date(Date.now()+60000).toISOString(),sources});let descriptor;
 try{
  descriptor=channel.publish({context,variable,value});assert.equal(descriptor.roundTripVerified,true);
  assert.deepEqual(channel.consume(descriptor,context),value);
 }finally{assert.deepEqual(channel.close(),{completed:true,pending:0});}
 if(descriptor)assert.throws(()=>privateInspectionVault('Open',descriptor.reference),/debug_private_inspection_vault_unavailable/);
});

test('compare handles follow a verified round trip, are never sealed, survive invalidate and are released by stop',()=>{
 const f=fixture(),session=createPrivateCompareSession({sessionId:'12345678-1234-4234-8234-123456789abc',lane:'odc',runtime:'client'});
 const channel=createPrivateInspectionChannel({binding,expiresAt:f.expiresAt,sources},{vault:f.vault,compare:session.member(context.sessionId)});
 const user={type:'Text',value:'private-user-Ω'};
 const a=channel.publish({context,variable,value:user}),b=channel.publish({context,variable,value:user}),c=channel.publish({context,variable,value});
 for(const d of [a,b,c]){assert.match(d.compareHandle,/^pc_[a-f0-9]{32}$/);assert.equal(d.roundTripVerified,true);assert.doesNotMatch(JSON.stringify(d),/private-user|[a-f0-9]{64}/);}
 for(const record of f.records.values()){
  assert.deepEqual(Object.keys(record).sort(),['binding','context','expiresAt','schema','value','variable']);
  assert.equal(JSON.stringify(record).includes('pc_'),false,'no persisted compare handle or fingerprint');
 }
 assert.deepEqual(session.compare([a.compareHandle,b.compareHandle]),{equal:true,bothNonEmpty:true,sameNativeType:true,valueType:'Text',count:2});
 assert.equal(session.compare([a.compareHandle,c.compareHandle]).equal,false);
 assert.deepEqual(channel.invalidate(),{completed:true,pending:0});
 assert.throws(()=>channel.consume(a,context),/stale_reference/);
 assert.equal(session.compare([a.compareHandle,b.compareHandle]).equal,true,'compare handles survive steps');
 assert.deepEqual(channel.close(),{completed:true,pending:0});
 assert.throws(()=>session.compare([a.compareHandle,b.compareHandle]),/^Error: debug_private_compare_handle_unavailable$/);
 const failed=createPrivateCompareSession({});
 const broken=createPrivateInspectionChannel({binding,expiresAt:f.expiresAt,sources},{vault:mode=>{if(mode==='Seal')throw new Error('private-user-Ω');return{ok:true};},compare:failed.member(context.sessionId)});
 assert.throws(()=>broken.publish({context,variable,value:user}),/^Error: debug_private_inspection_publish_failed$/);assert.equal(failed.receipt().handles,0);
 failed.close();
 const closed=createPrivateCompareSession({}),member=closed.member(context.sessionId);closed.close();
 const late=createPrivateInspectionChannel({binding,expiresAt:f.expiresAt,sources},{vault:f.vault,compare:member});
 const descriptor=late.publish({context,variable,value:user});assert.equal(descriptor.compareHandle,null);assert.deepEqual(late.consume(descriptor,context),user);
 assert.throws(()=>createPrivateInspectionChannel({binding,expiresAt:f.expiresAt,sources},{vault:f.vault,compare:{}}),/binding_invalid/);
 late.close();session.close();f.channel.close();
});

test('auxiliary O11 private channel pins distinct native and credential owners and refuses cross-session consumption',()=>{
 const f=fixture(),owner='a'.repeat(32),native='f'.repeat(32);
 const appUser={lane:'o11',runtimeUrl:'https://fixture.outsystemscloud.com/Fixture/',app:'Fixture',sessionId:owner,module:'Fixture',moduleKey:'A'.repeat(22)};
 const nativeBinding={kind:'native-debug-session',sessionId:native,lane:'o11',runtimeUrl:appUser.runtimeUrl,moduleKey:appUser.moduleKey,module:'Fixture',contextMode:'app-user',credentialOwnerSessionId:owner,appUser};
 const c={sessionId:native,platform:'o11',runtime:'server',threadId:'T1',eventId:'1',generation:1,frame:0,moduleKey:appUser.moduleKey,functionKey:'E'.repeat(22),nodeKey:'F'.repeat(22)};
 const v={ref:'d'.repeat(32),moduleKey:appUser.moduleKey,sourceSha256:sources[0].sourceSha256};
 const channel=createPrivateInspectionChannel({binding:nativeBinding,expiresAt:f.expiresAt,sources},{vault:f.vault});
 const descriptor=channel.publish({context:c,variable:v,value});
 assert.deepEqual(channel.consume(descriptor,c),value);
 const record=f.records.get(descriptor.reference);assert.equal(record.binding.sessionId,native);assert.equal(record.binding.appUser.sessionId,owner);
 assert.throws(()=>channel.consume(descriptor,{...c,sessionId:owner}),/stale_reference/);
 for(const patch of [{credentialOwnerSessionId:undefined},{credentialOwnerSessionId:native},{credentialOwnerSessionId:'0'.repeat(32)},
  {lane:'odc'},{moduleKey:'G'.repeat(22)},{contextMode:'anonymous'},
  {appUser:{...appUser,module:'Other',app:'Other'}},{appUser:{...appUser,runtimeUrl:'https://other.outsystemscloud.com/Fixture/'}}])
  assert.throws(()=>createPrivateInspectionChannel({binding:{...nativeBinding,...patch},expiresAt:f.expiresAt,sources},{vault:f.vault}),/binding_invalid/);
 assert.deepEqual(channel.close(),{completed:true,pending:0});assert.equal(f.records.size,0);f.channel.close();
});
