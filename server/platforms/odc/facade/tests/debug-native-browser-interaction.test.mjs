import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {createNativeBrowserInteraction,isNativeInteractionAuthorization,nativeInteractionRequests} from '../debug-native-browser-interaction.mjs';
const url='https://fixture.example/App/',DOC=1,BUTTON=7,LABEL=8;
// A fake CDP page: one document, nodes by id selector, box models and hit testing.
function page({ids={Save:[BUTTON]},attributes={[BUTTON]:['id','Save','class','btn']},box={[BUTTON]:[10,20,110,20,110,60,10,60]},
 hit=LABEL,descendants={[BUTTON]:[LABEL]},documentURL=url,viewport={clientWidth:800,clientHeight:600},lose}={}){
 const calls=[];
 const p={calls,send:async(method,params)=>{
  calls.push([method,params]);
  if(lose?.(method,params))throw new Error('cdp timeout');
  if(method==='DOM.getDocument')return {root:{nodeId:DOC,documentURL}};
  if(method==='DOM.querySelectorAll'){
   if(params.nodeId===DOC){const m=/^\[id="([^"]+)"\]$/.exec(params.selector);return {nodeIds:m?ids[m[1]]??[]:[]};}
   return {nodeIds:params.selector==='*'?descendants[params.nodeId]??[]:[]};
  }
  if(method==='DOM.getAttributes')return {attributes:attributes[params.nodeId]??[]};
  if(method==='DOM.getBoxModel'){const q=box[params.nodeId];if(!q)throw new Error('Could not compute box model.');
   return {model:{border:q,content:q,width:q[2]-q[0],height:q[5]-q[1]}};}
  if(method==='Page.getLayoutMetrics')return {cssLayoutViewport:{pageX:0,pageY:0,...viewport}};
  if(method==='DOM.getNodeForLocation')return {backendNodeId:900+hit};
  if(method==='DOM.pushNodesByBackendIdsToFrontend')return {nodeIds:params.backendNodeIds.map(id=>id-900)};
  if(method==='Input.dispatchMouseEvent')return {};
  throw new Error('unexpected '+method);
 }};
 return p;
}
function interaction(p,{record=true,outcome=true}={}){
 const journal=[];
 const i=createNativeBrowserInteraction({page:p,beforeInteraction:async m=>{journal.push(['before',m]);return {recorded:record};},
  recordOutcome:async m=>{journal.push(['outcome',m]);return {recorded:outcome};}});
 return {i,journal};
}
const clicks=p=>p.calls.filter(([m])=>m==='Input.dispatchMouseEvent').map(([,x])=>x);
const writes=p=>p.calls.filter(([m])=>!/^(DOM\.(getDocument|querySelectorAll|getAttributes|getBoxModel|getNodeForLocation|pushNodesByBackendIdsToFrontend)|Page\.getLayoutMetrics)$/.test(m));
test('exactly one trusted click at the DOM.getBoxModel center of the single resolved element',async()=>{
 const p=page(),{i,journal}=interaction(p);
 const r=await i.click({sequence:0,id:'Save',documentUrl:url,metadata:{target:'Save',actionKey:'ALQheqsdZEGBVNun+Anl5w'}});
 assert.deepEqual(clicks(p),[{type:'mousePressed',x:60,y:40,button:'left',buttons:1,clickCount:1},{type:'mouseReleased',x:60,y:40,button:'left',buttons:0,clickCount:1}]);
 assert.deepEqual(writes(p).map(([m])=>m),['Input.dispatchMouseEvent','Input.dispatchMouseEvent']);
 // Journal before any input, outcome after the transport confirmed both events.
 assert.equal(journal[0][0],'before');assert.deepEqual(journal[0][1],{sequence:0,event:'click',id:'Save',target:'Save',actionKey:'ALQheqsdZEGBVNun+Anl5w'});
 assert.ok(p.calls.findIndex(([m])=>m==='Input.dispatchMouseEvent')>p.calls.findIndex(([m])=>m==='DOM.getNodeForLocation'));
 assert.deepEqual(journal[1],['outcome',{sequence:0,event:'click',id:'Save',handlerInvoked:null,dispatched:true,trusted:true,transportUnconfirmed:false}]);
 assert.deepEqual(r,{sequence:0,event:'click',dispatched:true,trusted:true,point:{x:60,y:40},evaluated:false});
 assert.equal(p.calls.some(([m])=>/Runtime\.|evaluate/i.test(m)),false);
 // The same sequence is never sent twice.
 await assert.rejects(i.click({sequence:0,id:'Save',documentUrl:url}),/already_attempted/);
 assert.equal(clicks(p).length,2);assert.deepEqual(i.receipt(),{attempted:1,uncertain:false});
});
test('zero, multiple, hidden, disabled, obscured or off-viewport elements are refused before any journal or input',async()=>{
 for(const [options,code] of [[{ids:{}},'element_missing'],[{ids:{Save:[BUTTON,9]}},'element_ambiguous'],
  [{box:{}},'element_hidden'],[{box:{[BUTTON]:[10,20,10,20,10,20,10,20]}},'element_hidden'],
  [{attributes:{[BUTTON]:['id','Save','hidden','']}},'element_hidden'],[{attributes:{[BUTTON]:['id','Save','aria-hidden','true']}},'element_hidden'],
  [{attributes:{[BUTTON]:['id','Save','disabled','']}},'element_disabled'],[{attributes:{[BUTTON]:['id','Save','aria-disabled','true']}},'element_disabled'],
  [{hit:42},'element_obscured'],[{viewport:{clientWidth:50,clientHeight:600}},'element_outside_viewport'],
  [{documentURL:'https://fixture.example/App/Other'},'document_mismatch']]){
  const p=page(options),{i,journal}=interaction(p);
  await assert.rejects(i.click({sequence:0,id:'Save',documentUrl:url}),new RegExp('debug_native_browser_interaction_'+code));
  assert.deepEqual(journal,[],code);assert.deepEqual(writes(p),[],code);
 }
 const p=page(),{i}=interaction(p);
 for(const id of ['','a"b','x'.repeat(201),'a b'])await assert.rejects(i.click({sequence:0,id,documentUrl:url}),/target_invalid/);
 assert.deepEqual(p.calls,[]);
});
test('an unrecorded submission sends nothing; a lost reply is uncertain and never retried',async()=>{
 const unrecorded=page(),u=interaction(unrecorded,{record:false});
 await assert.rejects(u.i.click({sequence:0,id:'Save',documentUrl:url}),/journal_unavailable/);assert.deepEqual(clicks(unrecorded),[]);
 for(const lost of ['mousePressed','mouseReleased']){
  const p=page({lose:(m,x)=>m==='Input.dispatchMouseEvent'&&x.type===lost}),{i,journal}=interaction(p);
  await assert.rejects(i.click({sequence:0,id:'Save',documentUrl:url}),/transport_unconfirmed/);
  assert.equal(clicks(p).length,lost==='mousePressed'?1:2);
  assert.deepEqual(journal.at(-1),['outcome',{sequence:0,event:'click',id:'Save',handlerInvoked:null,dispatched:false,trusted:true,transportUnconfirmed:true}]);
  assert.deepEqual(i.receipt(),{attempted:1,uncertain:true});
  const before=p.calls.length;
  await assert.rejects(i.click({sequence:1,id:'Save',documentUrl:url}),/uncertain/);
  await assert.rejects(i.click({sequence:0,id:'Save',documentUrl:url}),/uncertain/);
  assert.equal(p.calls.length,before);
 }
 // A click whose result could not be journaled is not a known outcome either.
 const p=page(),{i}=interaction(p,{outcome:false});
 await assert.rejects(i.click({sequence:0,id:'Save',documentUrl:url}),/outcome_unrecorded/);assert.equal(i.receipt().uncertain,true);
});
test('authorization lists and public requests are bounded and strict',()=>{
 const ok={target:'@W4JQW+OX20iILeFJFpMkqA',event:'click',name:'SaveButton',viewKey:'W4JQW+OX20iILeFJFpMkqA',actionKey:'ALQheqsdZEGBVNun+Anl5w'};
 assert.equal(isNativeInteractionAuthorization([ok,{...ok,target:'SaveButton'}]),true);
 for(const bad of [[],Array(11).fill(ok),[{...ok,event:'dblclick'}],[{...ok,extra:1}],[{...ok,name:'a-b'}],[{...ok,actionKey:'x'}],[{...ok,target:'@short'}],undefined,{}])
  assert.equal(isNativeInteractionAuthorization(bad),false);
 assert.deepEqual(nativeInteractionRequests([{target:'SaveButton',event:'click'},{target:'@W4JQW+OX20iILeFJFpMkqA',event:'click'}]),
  [{target:'SaveButton',event:'click'},{target:'@W4JQW+OX20iILeFJFpMkqA',event:'click'}]);
 for(const bad of [[],Array(11).fill({target:'A',event:'click'}),[{target:'A'}],[{target:'A',event:'click',x:1}],[{target:'1A',event:'click'}],'x'])
  assert.throws(()=>nativeInteractionRequests(bad),/debug_native_browser_interaction_requests_invalid/);
});
