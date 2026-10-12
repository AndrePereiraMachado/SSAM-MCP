import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {connectNativeBrowserInspection} from '../debug-native-browser-inspection-session.mjs';

function fixture(){
 const calls=[],context=vm.createContext({TextEncoder,crypto:webcrypto,OutSystemsDebugger:{
  evaluateVariable(){},getThreadStack:()=>[],startSession(){calls.push('start');},endSession(){calls.push('end');},
  allowBreakpointsFromModule:k=>calls.push('module:'+k),addBreakpoints:b=>calls.push('breakpoints:'+b.join(',')),pauseOnAllExceptions(){}}});
 const host={inspectionUrl:'ws://127.0.0.1/private',dispose:async()=>{calls.push('terminate');},page:{
  send:async(method,input)=>({result:{value:vm.runInContext(input.expression,context)}}),
  evaluate:async(fn,input)=>{context.input=input;return vm.runInContext('('+fn.toString()+')(input)',context);}}};
 const privateChannel={publish(){},consume(){},invalidate(){},close(){calls.push('channel-close');return {completed:true};}};
 const options={platform:'odc',modules:[{moduleKey:'Module',sourceSha256:'a'.repeat(64)}],variables:[],breakpoints:['Module:Node']};
 const connect=async cfg=>{calls.push('connect');assert.equal(cfg.privateChannel,privateChannel);assert.match(cfg.privateConsumerCapability,/^[a-f0-9]{48}$/);
  return {command:async input=>({op:input.op}),consumePrivate:()=>({consumed:true}),close:async()=>{calls.push('transport-close');return {closed:true};}};};
 return {calls,context,host,privateChannel,options,connect};
}
test('browser inspector connects before enabling native debugging and removes private helpers on close',async()=>{
 const f=fixture(),session=await connectNativeBrowserInspection(f,{connect:f.connect});
 assert.deepEqual(f.calls,['connect']);assert.equal((await session.command({op:'status'})).op,'status');
 await session.start();assert.deepEqual(f.calls.slice(0,4),['connect','start','module:Module','breakpoints:Module:Node']);
 await assert.rejects(session.start(),/start_invalid/);
 const closed=await session.close();assert.equal(closed.browserHelper.removed,true);assert.equal(closed.privateInspectionCleanup.completed,true);
 assert.equal(Object.keys(f.context).filter(k=>k.startsWith('__ssam')).length,0);
 assert.ok(f.calls.indexOf('transport-close')<f.calls.indexOf('end'));
 const count=f.calls.length;await session.close();assert.equal(f.calls.length,count);
 assert.ok(!JSON.stringify(session.receipt()).includes('private'));
});
test('connection failure removes helper without starting a native session',async()=>{
 const f=fixture();await assert.rejects(connectNativeBrowserInspection(f,{connect:async()=>{throw Error('sensitive');}}),/setup_failed/);
 assert.equal(Object.keys(f.context).filter(k=>k.startsWith('__ssam')).length,0);assert.ok(!f.calls.includes('start'));assert.ok(f.calls.includes('channel-close'));
});
test('failed native enable and failed transport close still clean the private channel',async()=>{
 const f=fixture();f.context.OutSystemsDebugger.addBreakpoints=()=>{throw Error('native failure');};
 const session=await connectNativeBrowserInspection(f,{connect:async cfg=>({...await f.connect(cfg),close:async()=>{throw Error('lost');}})});
 await assert.rejects(session.start(),/start_failed/);assert.ok(f.calls.includes('terminate'));assert.ok(f.calls.includes('channel-close'));assert.ok(f.calls.includes('end'));
 assert.equal(Object.keys(f.context).filter(k=>k.startsWith('__ssam')).length,0);
});
test('native end failure removes the browser helper and terminates the owned process',async()=>{
 const f=fixture(),session=await connectNativeBrowserInspection(f,{connect:f.connect});await session.start();
 f.context.OutSystemsDebugger.endSession=()=>{throw Error('native end failed');};
 const result=await session.close();assert.equal(result.browserHelper.removed,false);
 assert.equal(Object.keys(f.context).filter(k=>k.startsWith('__ssam')).length,0);
 assert.ok(f.calls.includes('terminate'));assert.equal(result.privateInspectionCleanup.completed,true);
});
