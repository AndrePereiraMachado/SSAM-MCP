import test from 'node:test';import assert from 'node:assert/strict';
import {observeNativeBrowserRender,compareNativeRenderEvidence} from '../debug-native-browser-render-observation.mjs';
const url='https://fixture.example/App/';
// Flattened DOMSnapshot document: <html><body><div><span id=ResultValue>11</span><div><span id=b1-BlockValue>ok</span></div></div></body></html>
function snapshot({ids=['ResultValue','b1-BlockValue'],texts=['11','ok'],documentUrl=url,duplicate=false}={}){
 const strings=[documentUrl,'HTML','BODY','DIV','SPAN','id',ids[0],'#text',texts[0],ids[1],texts[1]];
 const nodes={parentIndex:[-1,0,1,2,3,2,5,6],nodeType:[1,1,1,1,3,1,1,3],nodeName:[1,2,3,4,7,3,4,7],nodeValue:[-1,-1,-1,-1,8,-1,-1,10],
  attributes:[[],[],[],[5,6],[],[],[5,9],[]]};
 if(duplicate)nodes.attributes[6]=[5,6];
 return {documents:[{documentURL:0,nodes}],strings};
}
function page(reply=snapshot()){
 const sent=[];return {sent,send:async(method,params,timeout)=>{sent.push({method,params,timeout});return typeof reply==='function'?reply():reply;},
  evaluate:async()=>{throw Error('render observation must not evaluate');}};
}
const M='7WNw7ud8AEKh1ftGQYhllg';
const targets={complete:true,instances:[
 {key:'W4JQW+OX20iILeFJFpMkqA',namespace:'',ids:['ResultValue'],functions:[M+':ALQheqsdZEGBVNun+Anl5w'],texts:[{id:'ResultValue',variable:'LifecycleCount',form:'integerToText'}],ambiguous:false},
 {key:'RDyePs1DwUyB5poRbGhwVA',namespace:'b1-',ids:['b1-BlockValue'],functions:[M+':RlJ5nWDBJUGdVNVnSt55DQ'],texts:[{id:'b1-BlockValue',variable:'Status',form:'variable'}],ambiguous:false}]};
const reads={[M+':ALQheqsdZEGBVNun+Anl5w\nLifecycleCount']:{type:'Integer',text:'11'},[M+':RlJ5nWDBJUGdVNVnSt55DQ\nStatus']:{type:'Text',text:'ok'}};
const lastRead=(functions,variable)=>functions.map(f=>reads[f+'\n'+variable]).find(Boolean);

test('uses only a read-only DOM snapshot command and reports roots and bound texts',async()=>{
 const p=page(),o=await observeNativeBrowserRender({page:p,documentUrl:url,targets});
 assert.deepEqual(p.sent.map(s=>s.method),['DOMSnapshot.captureSnapshot']);
 assert.ok(p.sent.every(s=>['DOM.getDocument','DOMSnapshot.captureSnapshot'].includes(s.method)));
 assert.equal(o.observed,true);assert.equal(o.documentMatched,true);assert.equal(o.evaluated,false);
 assert.deepEqual(o.roots.map(r=>[r.key,r.present]),[['W4JQW+OX20iILeFJFpMkqA',true],['RDyePs1DwUyB5poRbGhwVA',true]]);
 assert.deepEqual(o.texts.map(t=>[t.id,t.present,t.unique,t.text]),[['ResultValue',true,true,'11'],['b1-BlockValue',true,true,'ok']]);
 const v=compareNativeRenderEvidence({observation:o,targets,lastRead});
 assert.equal(v.renderVerified,true);assert.deepEqual(v.reasons,[]);assert.equal(v.compared,2);
 // The verdict carries booleans only: no DOM text and no native value.
 assert.doesNotMatch(JSON.stringify(v),/"11"|"ok"/);
});

test('missing roots, a changed document or a failed snapshot are never verified',async()=>{
 const missing=await observeNativeBrowserRender({page:page(snapshot({ids:['Other','b1-Other']})),documentUrl:url,targets});
 assert.deepEqual(missing.roots.map(r=>r.present),[false,false]);
 const a=compareNativeRenderEvidence({observation:missing,targets,lastRead});
 assert.equal(a.renderVerified,false);assert.ok(a.reasons.includes('root-missing'));assert.ok(a.reasons.includes('text-missing'));
 const moved=await observeNativeBrowserRender({page:page(snapshot({documentUrl:'https://other.example/App/'})),documentUrl:url,targets});
 assert.equal(moved.documentMatched,false);assert.equal(compareNativeRenderEvidence({observation:moved,targets,lastRead}).renderVerified,false);
 await assert.rejects(observeNativeBrowserRender({page:page(()=>{throw Error('private');}),documentUrl:url,targets}),/debug_native_browser_render_unavailable/);
 await assert.rejects(observeNativeBrowserRender({page:page({documents:[]}),documentUrl:url,targets}),/debug_native_browser_render_unavailable/);
 assert.equal(compareNativeRenderEvidence({observation:undefined,targets,lastRead}).renderVerified,false);
});

test('equality needs a unique element and the last native read of that variable, compared as strings',async()=>{
 const o=await observeNativeBrowserRender({page:page(snapshot({texts:['12','ok']})),documentUrl:url,targets});
 const mismatch=compareNativeRenderEvidence({observation:o,targets,lastRead});
 assert.equal(mismatch.renderVerified,false);assert.ok(mismatch.reasons.includes('text-mismatch'));
 assert.deepEqual(mismatch.bindings.map(b=>b.matches),[false,true]);
 const good=await observeNativeBrowserRender({page:page(),documentUrl:url,targets});
 const unread=compareNativeRenderEvidence({observation:good,targets,lastRead:()=>undefined});
 assert.equal(unread.renderVerified,false);assert.ok(unread.reasons.includes('native-read-missing'));
 const decimal=compareNativeRenderEvidence({observation:good,targets,lastRead:(f,v)=>v==='Status'?{type:'Decimal',text:'ok'}:lastRead(f,v)});
 assert.equal(decimal.renderVerified,false);assert.ok(decimal.reasons.includes('native-type-unsupported'));
 const twice=await observeNativeBrowserRender({page:page(snapshot({duplicate:true})),documentUrl:url,targets});
 assert.equal(twice.texts[0].unique,false);assert.equal(compareNativeRenderEvidence({observation:twice,targets,lastRead}).renderVerified,false);
 const ambiguous={...targets,instances:targets.instances.map((i,n)=>n?{...i,ambiguous:true}:i)};
 const shared=compareNativeRenderEvidence({observation:good,targets:ambiguous,lastRead});
 assert.equal(shared.renderVerified,false);assert.ok(shared.reasons.includes('instance-ambiguous'));
 // Roots alone, without one compared single-variable text, prove nothing about values.
 const noTexts={...targets,instances:targets.instances.map(i=>({...i,texts:[]}))};
 const empty=compareNativeRenderEvidence({observation:await observeNativeBrowserRender({page:page(),documentUrl:url,targets:noTexts}),targets:noTexts,lastRead});
 assert.equal(empty.renderVerified,false);assert.ok(empty.reasons.includes('no-single-variable-bindings'));
 assert.equal(compareNativeRenderEvidence({observation:good,targets:{...targets,complete:false},lastRead}).renderVerified,false);
});

test('rejects invalid targets before any browser command',async()=>{
 const p=page();
 for(const bad of [{instances:[{key:'k',ids:['bad id'],texts:[]}]},{instances:Array.from({length:501},(_,i)=>({key:'k'+i,ids:['a'],texts:[]}))},null])
  await assert.rejects(observeNativeBrowserRender({page:p,documentUrl:url,targets:bad}),/debug_native_browser_render_contract_invalid/);
 await assert.rejects(observeNativeBrowserRender({page:{},documentUrl:url,targets}),/contract_invalid/);
 assert.equal(p.sent.length,0);
});
