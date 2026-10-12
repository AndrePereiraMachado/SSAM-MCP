import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeResponseObserver } from '../debug-odc-native-response-observer.mjs';
const frame=(value,id='0')=>JSON.stringify({type:3,invocationId:id,result:{ResponseBody:JSON.stringify(value),ResponseStatusCode:200}})+'\x1e';
test('native completion is matched before SDK conversion; later mutations are detected without leaking values',()=>{
  const observer=createNativeResponseObserver(),data={data:{Result:42},private:'SECRET'};
  const text=frame(data);observer.observe('{}\x1e'+text.slice(0,20),'0');observer.observe(text.slice(20),'0');
  assert.equal(observer.compare({private:'SECRET',data:{Result:42}}).envelopeRepresentationEqual,true);
  data.data.Result=0;
  const result=observer.compare(data);assert.equal(result.complete,true);assert.equal(result.envelopeRepresentationEqual,false);
  assert.equal(JSON.stringify(result).includes('SECRET'),false);assert.equal(result.requestOwnershipProved,false);
});
test('unrelated, duplicate, malformed and oversized completions cannot claim observation',()=>{
  for(const texts of [[frame({data:42},'other')],[frame({data:42}),frame({data:42})],['{bad}\x1e'],['x'.repeat(1048577)]]){
    const observer=createNativeResponseObserver();for(const text of texts)observer.observe(text,'0');assert.equal(observer.compare({data:42}).complete,false);
  }
});

// Per-path typed fingerprints of the original response, bound to the native invocation.
import { nativeParityLeaves, parityPrints, compareParityPrints } from '../debug-native-output-comparison.mjs';
import { createOdcNativeTransport, odcNativeEndpoints } from '../debug-odc-native-transport.mjs';
const KEY='ab'.repeat(32);
const leaf=(path,value)=>({type:'Scalar',value,path,unavailable:false,undefined:false,trimmed:false,deferred:false,children:[]});
test('parity fingerprints are per path, typed, keyed and released only for the bound invocation',()=>{
  const observer=createNativeResponseObserver({parityKey:KEY}),body={data:{Amount:'12.50',Label:'PRIVATE-Ω',Rows:{List:[{N:1}],EmptyListItem:{N:0}}}};
  assert.equal(observer.responsePrints('7').reason,'native-response-not-observed');
  observer.observe(frame(body,'7'),'7');
  const prints=observer.responsePrints('7');
  assert.equal(prints.complete,true);assert.equal(prints.schema,'ssam-native-response-prints/1');assert.equal(prints.leaves.length,4);
  assert.doesNotMatch(JSON.stringify(prints),/PRIVATE|Amount|Label|Rows|12\.5/);
  const native=parityPrints(nativeParityLeaves([['Amount',leaf('Amount','12.5')],['Label',leaf('Label','"PRIVATE-Ω"')],
    ['Rows',{...leaf('Rows','RecordList'),type:'RecordList',children:[leaf('Rows.Length','1'),{...leaf('Rows.[0]','Record'),type:'Record',children:[leaf('Rows.[0].N','2')]}]}]]),Buffer.from(KEY,'hex'));
  assert.deepEqual(compareParityPrints(native,prints),{schema:'ssam-producer-output-parity/1',complete:true,compared:4,unequal:1,missing:0,extra:0,typeDifferences:0,parityEqual:false});
  assert.equal(observer.responsePrints('8').reason,'invocation-mismatch');assert.equal(observer.responsePrints(undefined).reason,'invocation-mismatch');
  assert.equal(observer.compare(body).envelopeRepresentationEqual,true,'the whole-body comparison is unchanged');
  observer.dispose();assert.equal(observer.responsePrints('7').complete,false);
});
test('duplicate, foreign-only, keyless and over-budget responses never release parity fingerprints',()=>{
  const duplicate=createNativeResponseObserver({parityKey:KEY});duplicate.observe(frame({data:{A:1}},'0')+frame({data:{A:1}},'0'),'0');
  assert.equal(duplicate.responsePrints('0').reason,'native-response-not-observed');
  const foreign=createNativeResponseObserver({parityKey:KEY});foreign.observe(frame({data:{A:1}},'9'),'0');
  assert.equal(foreign.responsePrints('9').complete,false);assert.equal(foreign.responsePrints('0').complete,false);
  const keyless=createNativeResponseObserver();keyless.observe(frame({data:{A:1}}),'0');
  assert.equal(keyless.responsePrints('0').reason,'parity-key-unavailable');assert.equal(keyless.compare({data:{A:1}}).complete,true);
  const wide=createNativeResponseObserver({parityKey:KEY});wide.observe(frame({data:{Items:Array.from({length:20001},(_,i)=>i)}}),'0');
  const prints=wide.responsePrints('0');assert.equal(prints.complete,false);assert.deepEqual(prints.leaves,[]);
  for(const parityKey of ['short','AB'.repeat(32),42])assert.throws(()=>createNativeResponseObserver({parityKey}),/parity_key_invalid/);
});
test('the transport accepts only a private 32-byte parity key and refuses parity outside an active probe',()=>{
  const endpoints=odcNativeEndpoints({runtimeUrl:'https://fixture.example.test/App/'}),fetchImpl=async()=>{throw new Error('offline');};
  const transport=createOdcNativeTransport({endpoints,fetchImpl,WebSocketImpl:function(){},responseParityKey:KEY});
  assert.deepEqual(transport.responseParity(),{complete:false,reason:'probe-not-active'});
  assert.throws(()=>createOdcNativeTransport({endpoints,fetchImpl,WebSocketImpl:function(){},responseParityKey:'x'}),/parity_key_invalid/);
});
