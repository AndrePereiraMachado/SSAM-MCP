import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
import {nativeBrowserInspectionBundle} from '../debug-native-browser-inspection.mjs';
const bundle=nativeBrowserInspectionBundle();
for(const platform of ['o11','odc'])test(platform+': portable shared core retains native reads, hashes, redaction and reference expiry',()=>{
 let current='áΩ😀'.repeat(800),evaluations=0,steps=0;
 const frame={};
 const dbg={getThreadState:()=>({getCallOnStack:()=>frame}),getThreadStack:()=>[{elementKey:'Module:Action'}],
   evaluateVariable(){evaluations++;return {type:'Text',value:current};},stepInto(){steps++;}};
 const sandbox={TextEncoder,crypto:webcrypto,OutSystemsDebugger:dbg};
 const factory=vm.runInNewContext(bundle.source,sandbox);
 const session=factory.create({platform,modules:[{moduleKey:'Module',sourceSha256:'a'.repeat(64)}],
   variables:[{moduleKey:'Module',actionKey:'Action',variableKey:'Value',name:'Value',category:'local'}],privateValues:['hidden-secret']});
 const request=args=>sandbox[session.helperName](args);
 assert.equal(request({op:'pause',callContextId:3}).ok,true);
 const ref=request({op:'scope'}).result.variables[0].ref;
 const page=request({op:'slice',ref,offset:0,limit:100}).result;
 assert.equal(page.valueSha256,createHash('sha256').update(JSON.stringify({type:'Text',value:current})).digest('hex'));
 assert.equal(page.value.value,current.slice(0,100));assert.equal(evaluations,1);
 current='changed';assert.equal(request({op:'refresh',ref}).result.changed,true);
 current='hidden-secret';const privateValue=request({op:'read',ref}).result;
 assert.equal(privateValue.value.value,'[private]');assert.equal(privateValue.valueComplete,false);
 assert.equal(request({op:'private-read',ref}).error,'debug_native_client_private_channel_unavailable');
 assert.equal(request({op:'stepInto'}).ok,true);assert.equal(steps,1);
 assert.equal(request({op:'read',ref}).error,'debug_native_client_stale_reference');
 session.dispose();assert.equal(sandbox[session.helperName],undefined);
 assert.equal(bundle.privateChannelSupported,false);assert.equal(bundle.hashDependency.license,'Apache-2.0');
});

test('browser private capture requires its internal capability and retains the native envelope for host sealing',()=>{
 const frame={};const original={type:'Text',value:'protected-native-value'};
 const dbg={getThreadState:()=>({getCallOnStack:()=>frame}),getThreadStack:()=>[{elementKey:'Module:Action'}],evaluateVariable:()=>original};
 const sandbox={TextEncoder,crypto:webcrypto,OutSystemsDebugger:dbg};
 const factory=vm.runInNewContext(bundle.source,sandbox);
 const session=factory.create({platform:'odc',modules:[{moduleKey:'Module',sourceSha256:'a'.repeat(64)}],privateCapture:true,
  variables:[{moduleKey:'Module',actionKey:'Action',variableKey:'Value',name:'Value',category:'local'}],privateValues:[original.value]});
 const request=args=>sandbox[session.helperName](args);
 request({op:'pause',callContextId:3});const ref=request({op:'scope'}).result.variables[0].ref;
 assert.equal(request({op:'read',ref}).result.value.value,'[private]');
 assert.equal(request({op:'private-capture',ref}).error,'debug_native_client_private_consumer_unauthorized');
 const result=request({op:'private-capture',ref,consumerCapability:session.privateConsumerCapability}).result;
 assert.equal(result.privateEnvelope.value,original);
 assert.equal(result.privateEnvelope.variable.sourceSha256,'a'.repeat(64));
 assert.equal(result.privateEnvelope.context.callContextId,3);
 assert.equal(bundle.privateCaptureSupported,true);
 session.finish();assert.equal(request({op:'private-capture',ref,consumerCapability:session.privateConsumerCapability}).error,'debug_native_client_stale_reference');
 session.dispose();
});
